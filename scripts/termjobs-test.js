'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-termjobs-'));
process.env.SATR_DEVSERVER_FILE = path.join(temp, 'devservers.json');

const term = require('../electron/term');
const termjobs = require('../electron/termjobs');
const devservers = require('../electron/devservers');
const notices = [];
termjobs.setNotifier((event) => notices.push(event));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
// تنظيف المجلد المؤقت: موت عمليات pty على ويندوز يتأخر عن تحرير مقابض الملفات،
// فيرمي rmSync الفوري EPERM (فشل بيئي مثبت 2026-07-26). إعادة المحاولة تكفي عادةً،
// وفشلها النهائي تحذير لا فشل اختبار — نظافة المؤقت ليست عقد termjobs.
function cleanupTemp() {
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  } catch (error) {
    console.warn('termjobs: تعذّر تنظيف المجلد المؤقت (غير مُفشل): ' + (error && error.message));
  }
}
async function waitFor(fn, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error('انتهت مهلة: ' + label);
}

(async () => {
  const label = 'خادم\x00 تجريبي ' + 'س'.repeat(60);
  const started = termjobs.startJob(temp,
    'node -e "console.log(\'READY http://localhost:4317\'); setInterval(()=>console.log(\'tick\'), 150)"', label);
  assert(started.ok, started.message || started.error);
  assert(Array.from(started.label).length <= 48 && !/[\x00-\x1F]/.test(started.label), 'لم تُنقّ label');
  await waitFor(() => {
    const read = term.readBuffer(started.id, 64 * 1024);
    return read.ok && /READY/.test(read.data) && read;
  }, 'خرج المهمة');
  assert(termjobs.info(started.id), 'ماتت المهمة عند محاكاة نهاية الدور');
  const saved = devservers.info(temp);
  assert(saved && saved.command.includes('READY') && saved.last_url === 'http://localhost:4317', 'لم يُحفظ أمر الخادم/last_url');
  assert(term.listTerms().some((item) => item.id === started.id && item.isJob && item.cwd === path.resolve(temp)), 'termList لا يعيد وصف المهمة');
  assert(term.readBuffer(started.id, 32).data.length > 0, 'readBuffer tail فارغ');
  assert(termjobs.stop(started.id).ok, 'فشل إيقاف المهمة');
  await waitFor(() => !termjobs.info(started.id), 'حذف المهمة بعد الإيقاف');

  const previewRoot = path.join(temp, 'preview-worktree');
  fs.mkdirSync(previewRoot);
  const previewJob = termjobs.startJob(previewRoot,
    'node -e "console.log(\'READY http://localhost:4318\'); setInterval(()=>{}, 150)"', 'معاينة تكاملية', {
      recordDevServer: false, publicCwd: '',
    });
  assert(previewJob.ok, previewJob.message || previewJob.error);
  await waitFor(() => term.readBuffer(previewJob.id, 64 * 1024).data.includes('READY'), 'خرج المعاينة');
  assert.strictEqual(devservers.info(previewRoot), null, 'لوّثت المعاينة التكاملية سجل devservers');
  const previewNotice = notices.find((event) => event.type === 'bg_term' && event.id === previewJob.id);
  assert(previewNotice && previewNotice.cwd === '', 'تسرّب مسار worktree المؤقت في حدث البث');
  assert(termjobs.stop(previewJob.id).ok, 'فشل إيقاف معاينة التكامل');
  await waitFor(() => !termjobs.info(previewJob.id), 'حذف معاينة التكامل بعد الإيقاف');

  const jobs = [];
  for (let index = 0; index < termjobs.MAX_JOBS; index++) {
    const job = termjobs.startJob(temp, 'node -e "setTimeout(()=>{}, 1200)"', 'مهمة ' + index);
    assert(job.ok, 'فشل بدء مهمة السقف ' + index);
    jobs.push(job);
  }
  const overflow = termjobs.startJob(temp, 'node -e "setInterval(()=>{}, 1000)"', 'زائدة');
  assert(!overflow.ok && overflow.error === 'too_many', 'لم يُفرض MAX_JOBS');
  await waitFor(() => termjobs.list().length === 0, 'خروج مهام السقف طبيعياً', 8000);

  const model = term.ensureModelTerm(temp);
  assert(model.ok, model.message || model.error);
  const order = [];
  const first = term.runCapture(model.id, 'Start-Sleep -Milliseconds 250; Write-Output FIRST', { timeoutMs: 5000 }).then((result) => { order.push('first'); return result; });
  const second = term.runCapture(model.id, 'Write-Output SECOND', { timeoutMs: 5000 }).then((result) => { order.push('second'); return result; });
  const [one, two] = await Promise.all([first, second]);
  assert.deepStrictEqual(order, ['first', 'second'], 'runCapture لم يعد FIFO');
  assert(one.ok && /FIRST/.test(one.output) && !/SECOND/.test(one.output), 'خرج النداء الأول متشابك');
  assert(two.ok && /SECOND/.test(two.output) && !/FIRST/.test(two.output), 'خرج النداء الثاني متشابك');

  term.writeTerm(model.id, 'exit\r');
  await waitFor(() => !term.listTerms().some((item) => item.id === model.id), 'خروج طرفية الالتقاط طبيعياً');
  term.killAll();
  cleanupTemp();
  console.log('termjobs: نجح — pty حي، buffer، termList، السقوف، label، وقفل FIFO.');
  process.exit(0);
})().catch((error) => {
  term.killAll();
  cleanupTemp();
  console.error('termjobs:', error && error.stack ? error.stack : error);
  process.exit(1);
});
