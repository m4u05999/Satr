/** مهام معمّرة فوق طرفيات «سطر» نفسها — لا spawn مكرراً ولا ارتباط بدورة حياة الدور. */

const path = require('path');
const term = require('./term');
const devservers = require('./devservers');
const { scrubSecrets } = require('./secretscrub');

const MAX_JOBS = 4;
const MAX_DONE_TAIL = 8000; // سقف ذيل المهمة المنتهية في حدث bg_term_done (K4)
const jobs = new Map();
let notify = () => {};

function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }
function sanitizeLabel(label) {
  const clean = String(label || 'مهمة خلفية').replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
  return Array.from(clean || 'مهمة خلفية').slice(0, 48).join('');
}

// تنقية ذيل مهمة منتهية (K4): إزالة ANSI ومحارف التحكم محلياً، ثم حجب الأسرار
// عبر البوابة المشتركة secretscrub (K5-أ)، ثم قص ≤8000 محرف بعلامة مقصوص.
function scrubDoneTail(raw) {
  const text = String(raw || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/\r/g, '')
    .trim();
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > MAX_DONE_TAIL ? scrubbed.slice(0, MAX_DONE_TAIL) + '…' : scrubbed;
}

function publicJob(job) {
  return {
    id: job.id, label: job.label, command: job.command, cwd: job.cwd,
    shell: job.shell, startedAt: job.startedAt,
  };
}

function startJob(cwd, command, label, options) {
  const settings = options && typeof options === 'object' ? options : {};
  if (jobs.size >= MAX_JOBS) return { ok: false, error: 'too_many', message: 'بلغت مهام الخلفية الحد الأقصى (' + MAX_JOBS + ').' };
  const cleanCommand = term.sanitizeCommand(command);
  if (!cleanCommand.trim()) return { ok: false, error: 'empty', message: 'أمر فارغ.' };
  const cleanLabel = sanitizeLabel(label);
  const started = term.startTerm(cwd, 120, 30, { label: cleanLabel, isJob: true });
  if (!started.ok) return started;
  const job = {
    id: started.id, label: cleanLabel, command: cleanCommand, cwd: path.resolve(cwd),
    shell: started.shell, startedAt: Date.now(),
    recordDevServer: settings.recordDevServer !== false,
    publicCwd: settings.publicCwd == null ? path.resolve(cwd) : String(settings.publicCwd),
    onExit: typeof settings.onExit === 'function' ? settings.onExit : null,
  };
  jobs.set(job.id, job);
  if (job.recordDevServer) devservers.recordStart(job.cwd, job.command, job.label);
  const shell = String(job.shell || '').toLowerCase();
  const line = shell.includes('cmd') ? cleanCommand + ' & exit' : cleanCommand + '; exit';
  const written = term.writeTerm(job.id, line + '\r');
  if (!written.ok) {
    jobs.delete(job.id);
    term.killTerm(job.id);
    return written;
  }
  notify({ type: 'bg_term', id: job.id, label: job.label, shell: job.shell, cwd: job.publicCwd });
  return { ok: true, ...publicJob(job) };
}

function list() { return Array.from(jobs.values()).map(publicJob); }
function info(id) { const job = jobs.get(id); return job ? publicJob(job) : null; }
function stop(id) {
  if (!jobs.has(id)) return { ok: false, error: 'no_job' };
  return term.killTerm(id);
}

term.subscribe((event) => {
  const job = jobs.get(event.id);
  if (!job) return;
  if (event.type === 'data' && job.recordDevServer) devservers.observeOutput(job.id, job.cwd, event.data);
  if (event.type === 'exit') {
    jobs.delete(job.id);
    if (job.recordDevServer) devservers.forgetOutput(job.id);
    // K4 «أكمل بالوكيل»: مهمة محدودة انتهت — ابثّ ذيلها منقّى فتعرض الواجهة إشعار
    // فعل. الخوادم الطويلة لا exit لها فلا يصلها هذا الحدث أصلاً.
    notify({
      type: 'bg_term_done', id: job.id, label: job.label,
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
      tail: scrubDoneTail(event.tail),
    });
    if (job.onExit) Promise.resolve(job.onExit({ id: job.id, exitCode: event.exitCode })).catch(() => {});
  }
});

module.exports = { MAX_JOBS, MAX_DONE_TAIL, setNotifier, sanitizeLabel, scrubDoneTail, startJob, list, info, stop };
