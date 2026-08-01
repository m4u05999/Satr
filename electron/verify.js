/**
 * أوامر تحقق المشروع الصريحة (.satr/verify.json).
 *
 * لا تخمين ولا تشغيل تلقائي: هذه الوحدة تقرأ إعداداً داخل cwd وتنفّذ فقط IDs
 * موجودة فيه بعد أن تمر أداة verify_project بطبقة إذن exec لدى المحرك.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const term = require('./term');

const CONFIG_VERSION = 1;
const CONFIG_REL = path.join('.satr', 'verify.json');
const SAFE_CHECK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CHECKS = 6;
const MAX_COMMAND = 1000;
const MAX_LABEL = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_PREVIEW_URL = 2048;
const MAX_OUTPUT = 6000;
const MAX_EXEC_OUTPUT = 64 * 1024;
const MAX_MODEL_RESULT = 32 * 1024;
// مهارة المراجعة النوعية (الجولة السابعة): حقل اختياري كلياً — غيابه يعني السلوك
// القائم حرفياً. رمز الخطأ موحّد للقراءة والكتابة، والحقل خارج عدّ MAX_CHECKS.
const SAFE_REVIEW_SKILL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_REVIEW_LABEL = 120;
const DEFAULT_REVIEW_TIMEOUT_SECONDS = 300;
// تنقية وسم المهارة بمُسنِد نقاط Unicode لا بتعبير نمطي فيه محارف تحكم حرفية
// (درس loopfailure.js: التعبير الحرفي يُتلف الملف عند تحريره ويصعب اختباره عدداً).
function isUnsafeLabelPoint(code) {
  if (code <= 0x1f) return true; // C0 (تشمل السطر الجديد والإرجاع والصفر)
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true; // ALM/LRM/RLM
  if (code >= 0x202a && code <= 0x202e) return true; // LRE/RLE/PDF/LRO/RLO
  if (code >= 0x2066 && code <= 0x2069) return true; // LRI/RLI/FSI/PDI
  return false;
}

/** إزالة التحكّم وBidi ثم طيّ الفراغات ثم القصّ بنقاط Unicode (لا بوحدات UTF-16). */
function cleanReviewLabel(value) {
  let out = '';
  for (const char of String(value == null ? '' : value)) {
    if (!isUnsafeLabelPoint(char.codePointAt(0))) out += char;
  }
  const folded = out.replace(/\s+/g, ' ').trim();
  const points = [...folded];
  return points.length <= MAX_REVIEW_LABEL ? folded : points.slice(0, MAX_REVIEW_LABEL).join('');
}

function realInside(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    const relative = path.relative(realRoot, realTarget);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? realTarget : null;
  } catch {
    return null;
  }
}

function normalizePreview(value) {
  if (value == null) return { ok: true, preview: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'bad_preview' };
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  const timeout = value.timeout_seconds == null ? 60 : value.timeout_seconds;
  if (!command || command.length > MAX_COMMAND || /[\r\n\0]/.test(command)) {
    return { ok: false, error: 'bad_preview_command' };
  }
  if (!url || url.length > MAX_PREVIEW_URL || /[\u0000-\u001F\u007F]/.test(url)) {
    return { ok: false, error: 'bad_preview_url' };
  }
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'bad_preview_url' }; }
  const host = parsed.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || !['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    return { ok: false, error: 'bad_preview_url' };
  }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    return { ok: false, error: 'bad_preview_timeout' };
  }
  return { ok: true, preview: { command, url: parsed.href, timeout_seconds: timeout } };
}

/**
 * تطبيع حقل review_skill الاختياري — مصدر واحد للقراءة (parseConfig) وللكتابة
 * (buildConfig) فلا يتباعد العقدان. غياب الحقل ⇒ {ok:true, reviewSkill:null} أي
 * السلوك القائم حرفياً، وأي فساد ⇒ 'bad_review_skill' الموحّد (fail-closed).
 */
function normalizeReviewSkill(value) {
  if (value == null) return { ok: true, reviewSkill: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'bad_review_skill' };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!SAFE_REVIEW_SKILL_NAME.test(name)) return { ok: false, error: 'bad_review_skill' };
  if (value.label != null && typeof value.label !== 'string') return { ok: false, error: 'bad_review_skill' };
  const label = value.label == null ? '' : cleanReviewLabel(value.label);
  const timeout = value.timeout_seconds == null ? DEFAULT_REVIEW_TIMEOUT_SECONDS : value.timeout_seconds;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    return { ok: false, error: 'bad_review_skill' };
  }
  return {
    ok: true,
    reviewSkill: { name, ...(label ? { label } : {}), timeout_seconds: timeout },
  };
}

function buildConfig(commands, preview, reviewSkill) {
  if (!Array.isArray(commands) || !commands.length) return { ok: false, error: 'empty' };
  if (commands.length > MAX_CHECKS) return { ok: false, error: 'too_many_commands' };
  const normalized = [];
  const seen = new Set();
  for (const value of commands) {
    if (!value || typeof value !== 'object') return { ok: false, error: 'bad_command' };
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const label = typeof value.label === 'string' ? value.label.trim() : '';
    const command = typeof value.command === 'string' ? value.command.trim() : '';
    const timeout = value.timeout_seconds == null ? 120 : value.timeout_seconds;
    if (!SAFE_CHECK_ID.test(id) || seen.has(id)) return { ok: false, error: 'bad_command' };
    if (!label || label.length > MAX_LABEL || /[\u0000-\u001F\u007F]/.test(label)) {
      return { ok: false, error: 'bad_label' };
    }
    if (!command || command.length > MAX_COMMAND || /[\r\n\0]/.test(command)) {
      return { ok: false, error: 'bad_command' };
    }
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
      return { ok: false, error: 'bad_timeout' };
    }
    seen.add(id);
    normalized.push({ id, label, command, timeout_seconds: timeout });
  }
  const normalizedPreview = normalizePreview(preview);
  if (!normalizedPreview.ok) return normalizedPreview;
  const normalizedReview = normalizeReviewSkill(reviewSkill);
  if (!normalizedReview.ok) return normalizedReview;
  const config = {
    version: CONFIG_VERSION,
    commands: normalized,
    ...(normalizedPreview.preview ? { preview: normalizedPreview.preview } : {}),
    ...(normalizedReview.reviewSkill ? { review_skill: normalizedReview.reviewSkill } : {}),
  };
  const source = JSON.stringify(config, null, 2) + '\n';
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) return { ok: false, error: 'bad_config' };
  const parsed = parseConfig(source);
  return parsed.ok
    ? { ok: true, config, source, checks: parsed.checks, review_skill: parsed.review_skill }
    : parsed;
}

function inspectConfigTarget(root, target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { ok: false, error: 'symlink' };
    if (!stat.isFile()) return { ok: false, error: 'unsafe_target' };
    if (!realInside(root, target)) return { ok: false, error: 'outside' };
    return { ok: true, exists: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, exists: false };
    return { ok: false, error: 'write_failed' };
  }
}

function createConfig(cwd, commands, options) {
  const settings = options || {};
  if (settings.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  // إغلاق الوصلة مع معالج satr:verifyConfigCreate: الخيار المجمَّد `reviewSkill`
  // ({name} أو null) يصل من main.js ويُكتب فعلاً داخل الملف بدل أن يسقط صامتاً.
  const built = buildConfig(commands, settings.preview, settings.reviewSkill);
  if (!built.ok) return built;
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) return { ok: false, error: 'bad_cwd' };
  const root = path.resolve(cwd.trim());
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, error: 'bad_cwd' };
  } catch { return { ok: false, error: 'bad_cwd' }; }

  const satrPath = path.join(root, '.satr');
  try { fs.mkdirSync(satrPath, { mode: 0o700 }); }
  catch (error) { if (!error || error.code !== 'EEXIST') return { ok: false, error: 'write_failed' }; }
  let satrDir;
  try {
    const satrStat = fs.lstatSync(satrPath);
    if (!satrStat.isDirectory() || satrStat.isSymbolicLink()) return { ok: false, error: 'symlink' };
    satrDir = realInside(root, satrPath);
    if (!satrDir) return { ok: false, error: 'outside' };
  } catch { return { ok: false, error: 'write_failed' }; }

  const target = path.join(satrDir, 'verify.json');
  const before = inspectConfigTarget(root, target);
  if (!before.ok) return before;
  if (before.exists && settings.overwrite !== true) return { ok: false, error: 'exists' };

  const nonce = process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const temporary = path.join(satrDir, '.verify-' + nonce + '.tmp');
  const backup = path.join(satrDir, '.verify-' + nonce + '.bak');
  let movedExisting = false;
  try {
    fs.writeFileSync(temporary, built.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const current = inspectConfigTarget(root, target);
    if (!current.ok) throw Object.assign(new Error(current.error), { satrCode: current.error });
    if (current.exists && settings.overwrite !== true) {
      throw Object.assign(new Error('exists'), { satrCode: 'exists' });
    }
    if (current.exists) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, target);
    if (movedExisting) { try { fs.rmSync(backup, { force: true }); } catch {} }
    return {
      ok: true, path: CONFIG_REL.replace(/\\/g, '/'), created: !current.exists,
      overwritten: current.exists, config: built.config, checks: built.checks,
    };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (movedExisting) {
      try {
        if (!fs.existsSync(target)) fs.renameSync(backup, target);
      } catch {}
    }
    return { ok: false, error: error && error.satrCode || 'write_failed' };
  }
}

function parseConfig(source) {
  try {
    if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
      return { ok: false, error: 'bad_config' };
    }
    const parsed = JSON.parse(source);
    if (!parsed || parsed.version !== CONFIG_VERSION || !Array.isArray(parsed.commands)) {
      return { ok: false, error: 'bad_schema' };
    }
    if (parsed.commands.length > MAX_CHECKS) return { ok: false, error: 'too_many_commands' };
    const checks = [];
    const seen = new Set();
    for (const value of parsed.commands) {
      const id = value && typeof value.id === 'string' ? value.id.trim() : '';
      const command = value && typeof value.command === 'string' ? value.command.trim() : '';
      const label = value && typeof value.label === 'string'
        ? value.label.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, MAX_LABEL) : id;
      if (!SAFE_CHECK_ID.test(id) || seen.has(id) || !command || command.length > MAX_COMMAND || /[\r\n\0]/.test(command)) {
        return { ok: false, error: 'bad_command' };
      }
      const timeout = Number.isFinite(value.timeout_seconds)
        ? Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(value.timeout_seconds))) : 120;
      seen.add(id);
      checks.push({ id, label: label || id, command, timeout_seconds: timeout });
    }
    if (!checks.length) return { ok: false, error: 'empty' };
    const preview = normalizePreview(parsed.preview);
    if (!preview.ok) return preview;
    // review_skill خارج عدّ MAX_CHECKS؛ غيابه يعيد null فيبقى المستهلك القديم كما هو.
    const reviewSkill = normalizeReviewSkill(parsed.review_skill);
    if (!reviewSkill.ok) return reviewSkill;
    return {
      ok: true,
      version: CONFIG_VERSION,
      checks,
      preview: preview.preview,
      review_skill: reviewSkill.reviewSkill,
    };
  } catch {
    return { ok: false, error: 'bad_config' };
  }
}

function loadConfig(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_cwd' };
  const root = path.resolve(cwd.trim());
  const candidate = path.join(root, CONFIG_REL);
  try {
    const lstat = fs.lstatSync(candidate);
    if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size > MAX_CONFIG_BYTES) {
      return { ok: false, error: 'bad_config' };
    }
    const file = realInside(root, candidate);
    if (!file) return { ok: false, error: 'outside' };
    return parseConfig(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, error: 'notfound' };
    return { ok: false, error: 'read_failed' };
  }
}

function selectChecks(config, requestedIds) {
  if (!config || !config.ok) return { ok: false, error: config && config.error || 'bad_config' };
  const ids = Array.isArray(requestedIds) ? requestedIds.filter((id) => typeof id === 'string') : [];
  if (!ids.length) return { ok: true, checks: config.checks.slice() };
  const wanted = [...new Set(ids)].slice(0, MAX_CHECKS);
  if (wanted.some((id) => !SAFE_CHECK_ID.test(id))) return { ok: false, error: 'bad_check_id' };
  const map = new Map(config.checks.map((check) => [check.id, check]));
  if (wanted.some((id) => !map.has(id))) return { ok: false, error: 'unknown_check' };
  return { ok: true, checks: wanted.map((id) => map.get(id)) };
}

async function visibleExecutor(cwd, check, ctx) {
  const ensured = term.ensureModelTerm(cwd);
  if (!ensured.ok) return { ok: false, exitCode: null, timedOut: false, output: 'تعذّر فتح طرفية النموذج' };
  if (ensured.created && ctx && typeof ctx.emit === 'function') {
    ctx.emit({ type: 'model_term', id: ensured.id, shell: ensured.shell, cwd });
  }
  const result = await term.runCapture(ensured.id, check.command, { timeoutMs: check.timeout_seconds * 1000 });
  return {
    ok: !!result.ok,
    exitCode: result.exitCode,
    timedOut: !!result.timedOut,
    output: result.output || '',
    error: result.message || result.error || '',
  };
}

function stopChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true, stdio: 'ignore', shell: false,
      });
      killer.unref();
    } catch { try { child.kill(); } catch { /* أفضل جهد */ } }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* أفضل جهد */ } }
}

function boundedExecutor(cwd, check, ctx, options) {
  const settings = options || {};
  const timeoutMs = Math.max(1000, Math.min(600000, Number(check.timeout_seconds) * 1000 || 120000));
  const maxOutput = Math.max(1024, Math.min(MAX_EXEC_OUTPUT, Number(settings.maxOutput) || MAX_EXEC_OUTPUT));
  const signal = ctx && ctx.signal;
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve({ ok: false, exitCode: null, timedOut: false, output: '', aborted: true });
    const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', check.command] : ['-c', check.command];
    let child;
    try {
      child = spawn(executable, args, {
        cwd, env: process.env, windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, timedOut: false, output: '', error: String(error && error.message || error) });
      return;
    }
    let output = '';
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (chunk) => {
      if (outputBytes >= maxOutput) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = maxOutput - outputBytes;
      output += buffer.subarray(0, remaining).toString('utf8');
      outputBytes += Math.min(buffer.length, remaining);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => { aborted = true; stopChild(child); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stopChild(child); }, timeoutMs);
    child.on('error', (error) => finish({ ok: false, exitCode: null, timedOut, output, error: String(error && error.message || error), aborted }));
    child.on('close', (code) => finish({ ok: !timedOut && !aborted && code === 0, exitCode: Number.isInteger(code) ? code : null, timedOut, output, aborted }));
  });
}

async function runChecks(cwd, checks, ctx, options) {
  if (!Array.isArray(checks) || !checks.length) return { ok: false, error: 'empty', passed: false, checks: [] };
  const execute = options && typeof options.execute === 'function' ? options.execute : visibleExecutor;
  const results = [];
  for (const check of checks.slice(0, MAX_CHECKS)) {
    if (ctx && ctx.signal && ctx.signal.aborted) break;
    const started = Date.now();
    let outcome;
    try { outcome = await execute(cwd, check, ctx); }
    catch (error) { outcome = { ok: false, exitCode: null, output: '', error: String((error && error.message) || error) }; }
    let output = String(outcome.output || outcome.error || '').trim();
    if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n…(قُصّ الخرج)';
    const passed = !!outcome.ok && outcome.exitCode === 0 && !outcome.timedOut;
    results.push({
      id: check.id,
      label: check.label,
      command: check.command,
      passed,
      exit_code: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
      timed_out: !!outcome.timedOut,
      duration_ms: Date.now() - started,
      output,
    });
  }
  const passed = results.length > 0 && results.every((result) => result.passed);
  return {
    ok: true,
    schema_version: 1,
    passed,
    summary: passed ? 'نجحت كل أوامر التحقق.' : 'فشل أمر تحقق واحد أو أكثر.',
    checks: results,
  };
}

async function run(cwd, requestedIds, ctx, options) {
  const config = loadConfig(cwd);
  const selected = selectChecks(config, requestedIds);
  if (!selected.ok) return { ok: false, error: selected.error, passed: false, checks: [] };
  return runChecks(cwd, selected.checks, ctx, options);
}

function formatConfig(config) {
  if (!config || !config.ok) {
    if (config && config.error === 'notfound') return 'لا يوجد ملف .satr/verify.json في المشروع.';
    return 'ملف .satr/verify.json غير صالح (' + ((config && config.error) || 'unknown') + ').';
  }
  return config.checks.map((check) => '- ' + check.id + ': ' + check.label + '\n  ' + check.command).join('\n');
}

function formatResult(result) {
  if (!result || !result.ok) return 'تعذّر تشغيل التحقق (' + ((result && result.error) || 'unknown') + ').';
  const lines = [result.passed ? '✓ نجح التحقق' : '✗ فشل التحقق'];
  for (const check of result.checks) {
    lines.push('', (check.passed ? '✓ ' : '✗ ') + check.label + ' [' + check.id + ']');
    lines.push('exit code: ' + (check.exit_code == null ? 'غير معروف' : check.exit_code));
    if (check.output) lines.push(check.output);
    if (lines.join('\n').length >= MAX_MODEL_RESULT) break;
  }
  const text = lines.join('\n');
  return text.length > MAX_MODEL_RESULT ? text.slice(0, MAX_MODEL_RESULT) + '\n…(قُصّت نتيجة التحقق)' : text;
}

module.exports = {
  CONFIG_VERSION,
  CONFIG_REL,
  MAX_CONFIG_BYTES,
  MAX_CHECKS,
  MAX_COMMAND,
  MAX_LABEL,
  MAX_TIMEOUT_SECONDS,
  MAX_PREVIEW_URL,
  MAX_REVIEW_LABEL,
  DEFAULT_REVIEW_TIMEOUT_SECONDS,
  SAFE_REVIEW_SKILL_NAME,
  normalizeReviewSkill,
  loadConfig,
  parseConfig,
  buildConfig,
  createConfig,
  selectChecks,
  run,
  runChecks,
  boundedExecutor,
  formatConfig,
  formatResult,
  normalizePreview,
  SAFE_CHECK_ID,
};
