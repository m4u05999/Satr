/**
 * سطح ويندوز (desktop) — إدارة عملية المعين، واللقطات بالمراجع، والبصمات، ورسائل الخطأ.
 * المرجع الملزم: docs/COMPUTER-USE-DESKTOP.md §٥–§٩ (الخطوة ٤). النظير القائم: preview.js للمتصفح.
 *
 * ممنوع بالتصميم — ولا يُفتح له باب هنا:
 *  - لا desktop_evaluate: لا تقييم كود داخل نافذة أخرى بأي صيغة.
 *  - لا نقر بالإحداثيات: الفعل يقع على عنصر من آخر لقطة بمرجعه وحده.
 *  - لا نموذج رؤية: desktop_screenshot آخر الملاذ، ولا شيء هنا يقرّر أين ينقر من صورة.
 *  - لا تعداد بلا اختيار المستخدم: الوكيل لا يرى إلا النافذة التي اختارها المستخدم لهذه الجلسة.
 * إن لم يظهر العنصر في الشجرة فالجواب «لا أستطيع».
 *
 * الطبقات بالترتيب لكل فعل: surface.locatorError (مرجع الجيل النشط) ⇒ desktopguard.checkAction
 * (الحرّاس والشق الأول من الاحتواء) ⇒ المعين native/satr-uia (الشق الثاني من الاحتواء والبصمة حياً).
 *
 * **مرجعان لا مرجع واحد** (قرار الخطوة ٤): النموذج يرى `w<جيل اللقطة>:e<n>` — نمط `s<جيل>:e<n>` في
 * المتصفح حرفياً، فلقطة جديدة تُبطل ما قبلها حتمياً (stale_ref) — والمعين يعرف `w<رقم النافذة>:e<m>`.
 * هذه الوحدة تترجم بينهما في خريطة الجيل النشط؛ ولو عُرض مرجع المعين نفسه لصار مرجع لقطة سابقة
 * يُحلّ صامتاً على عنصر آخر يحمل الرقم نفسه في اللقطة الجديدة.
 *
 * بلا Electron: المسار من البيئة أو process.resourcesPath أو شجرة التطوير، والأحداث عبر بالوعة يضبطها
 * main.js — فتعمل الوحدة تحت node في الاختبار بمعين مزيّف.
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { createSurface, FINGERPRINT_SEP } = require('./surface');
const guard = require('./desktopguard');

const MAX_NODES = 400;
const MAX_DEPTH = 12;
const DEFAULT_BOOT_TIMEOUT_MS = 800; // قبول الخطوة ١: إقلاع < 800 م.ث
const REQUEST_TIMEOUT_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 8000;
const KEY_TIMEOUT_MS = 4000;
const CAPTURE_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 1500;
const MAX_TEXT_UNITS = 65536; // سقف المعين نفسه (وحدات UTF-16)
const MAX_SCROLL_STEPS = 50;
const WAIT_DEFAULT_MS = 8000;
const WAIT_MIN_MS = 500;
const WAIT_MAX_MS = 30000;
const WAIT_POLL_MS = 300;
const MAX_WAIT_TEXT = 200;
// «لقطة تفاضلية إن رخُصت»: تُعاد مشية الشجرة بعد الفعل فقط إن كانت اللقطة السابقة صغيرة وسريعة
const DELTA_MAX_NODES = 250;
const DELTA_MAX_MS = 600;
const DELTA_MAX_LINES = 15;

const TARGET_ID_RE = /^w[1-9][0-9]{0,8}$/;
// مرجع سطح آخر (مثل s3:e5 من المتصفح): شكل مرجع لا مُحدِّد — فهو stale_ref لا bad_selector
const OTHER_SURFACE_REF_RE = /^[a-z][1-9][0-9]*:e[1-9][0-9]*$/;
const TOOL_PREFIX_RE = /^mcp__satr-desktop__/;

// رسائل سطح المكتب: الصياغة نفسها لرسائل whyClosed في المتصفح مع اسم أداة هذا السطح — فرسالة
// المتصفح الحرفية («استخدم open_preview أولاً» / «خذ browser_snapshot») كانت ستوجّه النموذج إلى الأداة
// الخطأ. و not_allowed وحده مدخل جديد في whyClosed نفسها (codexmcp.js) ويُستهلك منها.
const MESSAGES = Object.freeze({
  closed: 'انتهت جلسة النافذة المختارة (أُغلقت النافذة أو سُحب اختيارها) — لا فعل. اطلب من المستخدم اختيار النافذة من جديد.',
  stale_ref: 'المرجع من لقطة قديمة — خذ desktop_snapshot جديدة واستعمل ref منها.',
  not_found: 'لم يُعثر على العنصر — أعد أخذ لقطة بـ desktop_snapshot.',
  bad_selector: 'مُعرّف غير صالح — الأفعال على سطح المكتب بمرجع من desktop_snapshot وحده (مثل w3:e5)، لا مُحدِّدات ولا إحداثيات.',
  handoff: 'التسليم البشري جارٍ — القيادة بيد المستخدم الآن؛ أدوات سطح المكتب معلّقة حتى تعود القيادة.',
  bad_key: 'مفتاح غير مدعوم (استعمل الأسماء المذكورة في وصف الأداة).',
  helper_failed: 'توقّف معين سطح المكتب أو لم يستجب — لا يُعرف إن وقع الفعل. أعد المحاولة: يُعاد تشغيله مرة واحدة في الجلسة ويُعاد ربط النافذة.',
  helper_gone: 'توقّف معين سطح المكتب مرة ثانية في هذه الجلسة — انتهت الجلسة. اطلب من المستخدم اختيار النافذة من جديد.',
  rebind_failed: 'أُعيد تشغيل معين سطح المكتب لكن النافذة المختارة لم تُعرف بهويتها نفسها — انتهت الجلسة. اطلب من المستخدم اختيار النافذة من جديد.',
});
const UNAVAILABLE_MESSAGE = 'تحكّم سطح المكتب غير متاح في هذه النسخة: معين satr-uia غير موجود، فلم تُسجَّل أدوات desktop_*.';

// whyClosed من codexmcp — تحميل كسول: الوحدة تُستورد في مسارات لا تحتاج الرسائل
function whyClosed(err, extra, details) {
  return require('./codexmcp').whyClosed(err, extra, details);
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * مسار المعين: SATR_UIA_EXE ⇐ resources/satr-uia/satr-uia.exe (مُحزَّم) ⇐ شجرة التطوير
 * (out-aot ناتج النشر ثم out ناتج dotnet build). غيابه كلياً ⇒ null ⇒ لا خادم ولا أدوات.
 */
function resolveHelperPath(env = process.env, devRoot = path.resolve(__dirname, '..')) {
  const root = devRoot;
  const candidates = [];
  if (typeof env.SATR_UIA_EXE === 'string' && env.SATR_UIA_EXE) candidates.push(env.SATR_UIA_EXE);
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'satr-uia', 'satr-uia.exe'));
  }
  candidates.push(path.join(root, 'native', 'satr-uia', 'out-aot', 'satr-uia.exe'));
  candidates.push(path.join(root, 'native', 'satr-uia', 'out', 'satr-uia.exe'));
  return candidates.find(isFile) || null;
}

// قاعدة §٦: الخادم يُسجَّل عند بدء الجلسة فقط، بعلم صريح ووجود المعين معاً — ولا يُبدَّل أثناءها
function shouldRegister(desktopControl, available) {
  return desktopControl === true && available === true;
}

/**
 * شكل ردّ المعين الملزم: `{id, result|error, ms}` — واحد بالضبط من result/error، وms عدد،
 * والخطأ `{code, message}` نصّين (نسخة validateResponse في scripts/uia-helper-test.js).
 */
function validateResponse(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'ليس كائناً';
  if (!Number.isInteger(msg.id)) return 'id ليس عدداً صحيحاً';
  if (typeof msg.ms !== 'number' || !(msg.ms >= 0)) return 'ms مفقود أو ليس عدداً';
  const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');
  if (hasResult === hasError) return 'يلزم result أو error وحده';
  if (hasError && (!msg.error || typeof msg.error.code !== 'string' || typeof msg.error.message !== 'string')) {
    return 'error بلا code/message نصّيين';
  }
  return null;
}

class DesktopError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details || null;
  }
}

// عميل أسطر JSON على stdio بانضباط codex.js: مهلة لكل طلب، ورفض ما لا يطابق الشكل، وإغلاق
// stdin ثم إنهاء. المهلة أو الردّ المشوّه يقتلان العملية: لا ثقة بمعين بعد ردّ لا يطابق.
function startHelper(command, args, spawnImpl) {
  const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let alive = true;
  let spawnFailed = false;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => { spawnFailed = true; resolve({ code: null, signal: null }); });
  });
  const failAll = (why) => {
    alive = false;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new DesktopError('helper_failed', why)); }
    pending.clear();
  };
  exited.then(() => failAll('exited'));
  if (child.stdin) child.stdin.on('error', () => { /* EPIPE بعد موت المعين — يعالجه exited */ });
  if (child.stderr) child.stderr.on('data', () => { /* لا يُعرض خرج المعين الخطأ: قد يحمل مسارات */ });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 64 * 1024 * 1024) { kill(); return; } // سقف حماية: سطر بلا نهاية
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { kill(); return; }
      const entry = msg && pending.get(msg.id);
      if (!entry) continue; // ردّ متأخر لطلب انتهت مهلته — لا يُسلَّم لغيره
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      const problem = validateResponse(msg);
      if (problem) { entry.reject(new DesktopError('helper_failed', 'bad_response: ' + problem)); kill(); return; }
      entry.resolve(msg);
    }
  });

  function kill() {
    if (!alive && child.exitCode !== null) return;
    alive = false;
    try { child.kill(); } catch { /* ماتت */ }
  }

  function request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!alive) { reject(new DesktopError('helper_failed', 'not_running')); return; }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) { reject(new DesktopError('helper_failed', 'timeout:' + method)); kill(); }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n'); }
      catch { pending.delete(id); clearTimeout(timer); reject(new DesktopError('helper_failed', 'write_failed')); kill(); }
    });
  }

  async function close() {
    alive = false;
    try { child.stdin.end(); } catch { /* مغلق أصلاً */ }
    const done = await Promise.race([exited, new Promise((r) => { const t = setTimeout(() => r(null), SHUTDOWN_TIMEOUT_MS); if (t.unref) t.unref(); })]);
    if (!done) { try { child.kill(); } catch { /* */ } await exited; }
  }

  return {
    request,
    close,
    kill,
    exited,
    get pid() { return child.pid; },
    get alive() { return alive && !spawnFailed && child.exitCode === null; },
  };
}

// سطر اللقطة بصيغة المتصفح الحرفية (preview.js): `[ref] role "name"`، والاسم الفارغ بلا علامتين
function formatLine(ref, node) {
  const name = String((node && node.name) || '');
  return '[' + ref + '] ' + node.role + (name ? ' "' + name.replace(/"/g, "'") + '"' : '');
}

function rectKey(rect) {
  return rect ? [rect.x, rect.y, rect.w, rect.h].join(',') : '';
}

// بصمة المرجع role+name+rect (داخلية — لا تعبر للنموذج)
function fingerprintOf(node) {
  return [node.role, node.name, rectKey(node.rect)].join(FINGERPRINT_SEP);
}

function sameRect(a, b) {
  if (!a || !b) return !a && !b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function elementIndex(helperRef) {
  const at = helperRef.indexOf(':e');
  return at > 0 ? Number(helperRef.slice(at + 2)) : 0;
}

function processKey(name) {
  return String(name || '').toLowerCase().replace(/\.exe$/, '');
}

function clipUnits(value, max) {
  const chars = Array.from(String(value || ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…';
}

function normalizeEol(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function fail(code, message) {
  return { ok: false, error: code, message: message || MESSAGES[code] || whyClosed(code, 'تعذّر الفعل على سطح المكتب') };
}

function notAllowed(why) {
  return { ok: false, error: 'not_allowed', message: whyClosed('not_allowed', null, { why: guard.clipText(String(why || ''), 160) }) };
}

// نتيجة الحارس (desktopguard.checkAction) ⇒ خطأ الأداة: رموزه كلها من §٧
function fromGuard(denied) {
  if (denied.error === 'not_allowed') return notAllowed(denied.message);
  return fail(denied.error);
}

/**
 * رموز المعين ⇒ رموز §٧ (قرار الخطوة ٤ المعلن):
 *   stale_ref ⇒ stale_ref · target_changed ⇒ stale_ref برسالة whyClosed('target_changed') (كان/صار)
 *   closed ⇒ closed · not_found ⇒ not_found · not_allowed/focus_failed/read_only/disabled ⇒ not_allowed
 *   unsupported_pattern ⇒ not_found (نمط الفعل غير موجود على العنصر) · bad_key ⇒ bad_key (نظير المتصفح)
 *   uia_unavailable ⇒ closed · internal/bad_request/unknown_method ⇒ not_found برسالة الاحتياط
 */
function fromHelperError(error) {
  const code = error && error.code;
  const message = guard.clipText(String((error && error.message) || ''), 160);
  switch (code) {
    case 'stale_ref': return fail('stale_ref');
    case 'target_changed':
      return { ok: false, error: 'stale_ref', message: whyClosed('target_changed', null, {
        was: guard.clipText(String(error.was || ''), 80), now: guard.clipText(String(error.now || ''), 80),
      }) };
    case 'closed': return fail('closed');
    case 'not_found': return fail('not_found');
    case 'not_allowed':
    case 'focus_failed': return notAllowed(message);
    case 'read_only': return notAllowed('العنصر للقراءة فقط');
    case 'disabled': return notAllowed('العنصر معطَّل الآن — انتظره بـ desktop_wait_for ثم أعد المحاولة');
    case 'unsupported_pattern':
      return fail('not_found', 'العنصر لا يدعم هذا الفعل عبر UI Automation — اختر عنصراً آخر من اللقطة (زرّاً للنقر، حقلاً للكتابة).');
    case 'bad_key': return fail('bad_key');
    case 'uia_unavailable': return fail('closed', 'UI Automation غير متاح على هذا الجهاز — لا سطح مكتب يُقاد.');
    default: return fail('not_found', whyClosed(String(code || 'internal'), 'تعذّر الفعل على سطح المكتب'));
  }
}

/**
 * مصنع سطح ويندوز. الخيارات للاختبار وحده: command/args لمعين مزيّف، وemit، وselfPid، ومهلة الإقلاع.
 * الإنتاج يستعمل النسخة الافتراضية المصدَّرة أدناه.
 */
function createDesktop(options = {}) {
  const spawnImpl = options.spawn || cp.spawn;
  const envBoot = Number(process.env.SATR_UIA_BOOT_TIMEOUT_MS);
  const bootTimeoutMs = Number.isInteger(options.bootTimeoutMs) ? options.bootTimeoutMs
    : Number.isInteger(envBoot) && envBoot >= 200 && envBoot <= 15000 ? envBoot : DEFAULT_BOOT_TIMEOUT_MS;
  const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) ? options.requestTimeoutMs : REQUEST_TIMEOUT_MS;
  const pollMs = Number.isInteger(options.pollMs) ? options.pollMs : WAIT_POLL_MS;
  const selfPid = Number.isInteger(options.selfPid) ? options.selfPid : process.pid;
  const surface = createSurface({ prefix: 'w', maxTrackedFingerprints: MAX_NODES });

  let sink = typeof options.emit === 'function' ? options.emit : null;
  let helper = null;
  let session = null;       // جلسة desktopguard المجمَّدة (تبقى بعد إغلاقها كي يعيد الحارس closed)
  let sessionSerial = 0;    // مالك سطح w — كل اختيار مالك جديد فتسقط مراجع ما قبله
  let restartUsed = false;  // إعادة إقلاع واحدة لكل جلسة
  let current = null;       // خريطة الجيل النشط: { gen, refs: Map(مرجع النموذج ⇒ {helperRef,node,fp}), … }
  let handoffActive = false;
  let lastStats = { boots: 0, restarts: 0, activity: 0 };
  let chain = Promise.resolve();

  // الأفعال متسلسلة: فعل وتفاضله أو لقطة وخريطتها لا يتداخلان مع نداء آخر يستبدل خريطة المعين
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function commandLine() {
    if (options.command) return { command: options.command, args: Array.isArray(options.args) ? options.args : [] };
    const exe = resolveHelperPath();
    return exe ? { command: exe, args: [] } : null;
  }

  function isAvailable() {
    if (options.command) return true;
    return process.platform === 'win32' && !!resolveHelperPath();
  }

  function emitActivity(action, node) {
    const text = guard.describeAction(action, node, session);
    lastStats.activity += 1;
    const event = { type: 'desktop_activity', text };
    try { if (sink) sink(event); } catch { /* السجل عرضٌ لا يوقف الفعل */ }
  }

  async function boot() {
    const line = commandLine();
    if (!line) throw new DesktopError('closed', UNAVAILABLE_MESSAGE);
    const started = startHelper(line.command, line.args, spawnImpl);
    let init;
    try { init = await started.request('initialize', {}, bootTimeoutMs); }
    catch (e) { started.kill(); throw new DesktopError('helper_failed', 'تعذّر إقلاع معين سطح المكتب خلال ' + bootTimeoutMs + ' م.ث.'); }
    if (init.error || !init.result || init.result.uiaAvailable !== true) {
      started.kill();
      throw new DesktopError('closed', 'UI Automation غير متاح على هذا الجهاز — لا سطح مكتب يُقاد.');
    }
    lastStats.boots += 1;
    return started;
  }

  async function call(method, params, timeoutMs) {
    const h = helper;
    if (!h || !h.alive) throw new DesktopError('helper_failed', 'not_running');
    const msg = await h.request(method, params, timeoutMs || requestTimeoutMs);
    if (msg.error) throw new DesktopError('helper_error', msg.error.message, msg.error);
    return msg.result;
  }

  function endSession() {
    if (session) guard.closeSession(session);
    surface.invalidate();
    current = null;
  }

  async function closeHelper() {
    const h = helper;
    helper = null;
    if (h) await h.close();
  }

  // الجلسة قائمة والمعين مات: إعادة إقلاع واحدة ثم إعادة ربط بالهوية نفسها — عملية واسم عملية
  // ومستطيل مطابقة حرفياً ونافذة واحدة فقط؛ وإلا تنتهي الجلسة ويختار المستخدم من جديد
  async function ensureHelper() {
    if (helper && helper.alive) return false;
    helper = null;
    if (!sessionLive()) { helper = await boot(); return false; }
    if (restartUsed) { endSession(); throw new DesktopError('closed', MESSAGES.helper_gone); }
    restartUsed = true;
    lastStats.restarts += 1;
    helper = await boot();
    const list = await call('targets/list');
    const matches = (Array.isArray(list) ? list : []).filter((t) => t && t.pid === session.pid
      && processKey(t.processName) === processKey(session.processName) && sameRect(t.rect, session.rect));
    if (matches.length !== 1) { endSession(); throw new DesktopError('closed', MESSAGES.rebind_failed); }
    let fresh;
    try { fresh = guard.createSession(matches[0]); } catch { endSession(); throw new DesktopError('closed', MESSAGES.rebind_failed); }
    try { await call('session/select', { targetId: fresh.targetId, pid: fresh.pid, rect: fresh.rect }); }
    catch { guard.closeSession(fresh); endSession(); throw new DesktopError('closed', MESSAGES.rebind_failed); }
    guard.closeSession(session);
    session = fresh;
    sessionSerial += 1;
    surface.invalidate();
    current = null;
    return true;
  }

  // الجلسة حيّة = اختيرت نافذة ولم تُغلق جلستها (الحارس وحده يعرف ذلك — لا حالة موازية هنا)
  function sessionLive() {
    return !!session && guard.checkAction(session, { type: 'snapshot' }) === null;
  }

  // حالة الجلسة قبل أي حكم على المرجع: بلا اختيار ⇒ not_allowed، ومغلقة ⇒ closed (لا stale_ref مضلِّل)
  function sessionGate() {
    const denied = guard.checkAction(session, { type: 'snapshot' });
    return denied ? fromGuard(denied) : null;
  }

  function fromError(e) {
    if (e instanceof DesktopError) {
      if (e.code === 'helper_error') {
        if (e.details && e.details.code === 'closed') endSession();
        return fromHelperError(e.details);
      }
      if (e.code === 'helper_failed') return fail('closed', MESSAGES.helper_failed);
      if (e.code === 'closed') return fail('closed', e.message);
    }
    return fail('not_found', whyClosed('internal', 'تعذّر الفعل على سطح المكتب'));
  }

  function restartedNote() {
    return '⚠️ أُعيد تشغيل معين سطح المكتب بعد توقّفه وأُعيد ربط النافذة نفسها — المراجع السابقة أُبطلت، ورقم النافذة الآن '
      + session.targetId + '.';
  }

  // لقطة جديدة = جيل جديد: مراجع النموذج `w<جيل>:e<n>` تُترجم إلى مراجع المعين في خريطة هذا الجيل
  async function takeSnapshot() {
    const t0 = Date.now();
    const res = await call('tree/snapshot', { targetId: session.targetId, maxDepth: MAX_DEPTH, maxNodes: MAX_NODES }, SNAPSHOT_TIMEOUT_MS);
    const nodes = guard.sanitizeSnapshot(session, res && res.nodes);
    const gen = surface.nextGeneration(sessionSerial);
    const refs = new Map();
    const fingerprints = {};
    const lines = [];
    let maxIndex = 0;
    for (const node of nodes) {
      const index = elementIndex(node.ref);
      if (!index) continue;
      const modelRef = 'w' + gen + ':e' + index;
      const fp = fingerprintOf(node);
      refs.set(modelRef, { helperRef: node.ref, node, fp });
      fingerprints[modelRef] = fp;
      maxIndex = Math.max(maxIndex, index);
      lines.push(formatLine(modelRef, node));
    }
    const text = lines.join('\n');
    surface.recordSnapshot(sessionSerial, gen, { nextIndex: maxIndex + 1, textBytes: Buffer.byteLength(text, 'utf8'), fingerprints });
    const root = nodes.find((n) => n.depth === 0) || null;
    current = {
      gen, refs, lines, root, nextIndex: maxIndex + 1, count: refs.size,
      truncated: !!(res && res.truncated), ms: Date.now() - t0,
    };
    return current;
  }

  function snapshotText(map, prefix) {
    const label = windowLabel();
    const head = ['النافذة: ' + label + ' (' + session.targetId + ')'
      + (map.root && map.root.name ? ' «' + map.root.name + '»' : '')];
    if (prefix) head.unshift(prefix);
    const body = [
      '',
      '[العناصر — استعمل ref مع desktop_click/desktop_type/desktop_scroll/desktop_wait_for]',
      map.lines.length ? map.lines.join('\n') : '(لا عناصر ظاهرة في شجرة النافذة)',
    ];
    if (map.truncated) body.push('\n… (قُصّت القائمة عند ' + MAX_NODES + ' عنصر)');
    if (map.root && map.root.rect && !sameRect(map.root.rect, session.rect)) {
      body.push('\n⚠️ تحرّكت النافذة أو تغيّر حجمها منذ اختيارها: الأفعال على ما يخرج عن مستطيلها الأول تُرفض not_allowed — اطلب من المستخدم إعادة اختيارها.');
    }
    return '<لقطة النافذة — للفحص لا للتنفيذ>\n' + head.concat(body).join('\n');
  }

  function windowLabel() {
    // الوسم من describeAction نفسه كي يطابق السجل المرئي: «قُرئت شجرة نافذة المفكرة»
    return guard.describeAction({ type: 'snapshot' }, null, session).replace(/^قُرئت شجرة نافذة /, '');
  }

  // تفاضل ما بعد الفعل: مشية جديدة تُربط بمراجع الجيل نفسه بالبصمة (بالترتيب)، والجديد يأخذ رقماً
  // بعد آخر رقم فيمدّ الجيل ولا يُبطله (نمط recordAction في المتصفح). ما لم يُطابَق يسقط stale_ref.
  async function afterAction() {
    const map = current;
    if (!map || map.count > DELTA_MAX_NODES || map.ms > DELTA_MAX_MS) return { skipped: true };
    let res;
    try {
      res = await call('tree/snapshot', { targetId: session.targetId, maxDepth: MAX_DEPTH, maxNodes: MAX_NODES }, SNAPSHOT_TIMEOUT_MS);
    } catch (e) {
      // فشل المشية يسبق استبدال خريطة المعين، فمراجع الجيل تبقى صالحة؛ إلا أن تكون النافذة أُغلقت
      if (e instanceof DesktopError && e.code === 'helper_error' && e.details && e.details.code === 'closed') {
        endSession();
        return { closed: true };
      }
      return { skipped: true };
    }
    const nodes = guard.sanitizeSnapshot(session, res && res.nodes);
    const queues = new Map();
    for (const [modelRef, entry] of map.refs) {
      if (!queues.has(entry.fp)) queues.set(entry.fp, []);
      queues.get(entry.fp).push(modelRef);
    }
    const refs = new Map();
    const added = [];
    const fingerprints = {};
    let nextIndex = map.nextIndex;
    for (const node of nodes) {
      if (!elementIndex(node.ref)) continue;
      const fp = fingerprintOf(node);
      const queue = queues.get(fp);
      let modelRef;
      if (queue && queue.length) {
        modelRef = queue.shift();
      } else {
        modelRef = 'w' + map.gen + ':e' + nextIndex;
        nextIndex += 1;
        fingerprints[modelRef] = fp;
        added.push(formatLine(modelRef, node));
      }
      refs.set(modelRef, { helperRef: node.ref, node, fp });
    }
    let removed = 0;
    for (const queue of queues.values()) removed += queue.length;
    surface.recordAction(sessionSerial, map.gen, { nextIndex, fingerprints });
    map.refs = refs;
    map.nextIndex = nextIndex;
    map.count = refs.size;
    map.root = nodes.find((n) => n.depth === 0) || map.root;
    map.truncated = !!(res && res.truncated);
    return { added, removed, truncated: map.truncated };
  }

  function deltaText(delta) {
    if (!delta || delta.skipped) return 'إن تغيّرت النافذة بعد الفعل فخذ desktop_snapshot جديدة قبل متابعة غير مغطاة.';
    if (delta.closed) return 'أُغلقت النافذة المختارة بعد الفعل — انتهت الجلسة.';
    const lines = [];
    if (delta.added.length) {
      lines.push('[تغيّر الشجرة المختصر — refs الجديدة صالحة ضمن الجيل الحالي]');
      lines.push(delta.added.slice(0, DELTA_MAX_LINES).join('\n'));
      if (delta.added.length > DELTA_MAX_LINES) lines.push('… و' + (delta.added.length - DELTA_MAX_LINES) + ' عنصراً جديداً آخر — خذ desktop_snapshot لرؤيتها.');
    }
    if (delta.removed) lines.push('اختفى من الشجرة ' + delta.removed + ' عنصراً منذ لقطتك — مراجعها أُبطلت.');
    if (delta.truncated) lines.push('ملاحظة: قُصّت الشجرة؛ خذ desktop_snapshot قبل متابعة غير مغطاة بالـ refs الظاهرة.');
    return lines.length ? lines.join('\n') : 'لم تتغيّر شجرة النافذة المختصرة بعد الفعل.';
  }

  // مرجع النموذج ⇒ مدخل خريطة الجيل النشط، أو خطأ §٧ بلا لمس المعين
  function resolveRef(ref) {
    const value = typeof ref === 'string' ? ref.trim() : '';
    if (!value) return { failure: fail('bad_selector') };
    if (surface.locatorError(value, sessionSerial) === 'stale_ref') return { failure: fail('stale_ref') };
    if (!surface.refPattern.test(value)) return { failure: fail(OTHER_SURFACE_REF_RE.test(value) ? 'stale_ref' : 'bad_selector') };
    const entry = current && current.refs.get(value);
    if (!entry) return { failure: fail('stale_ref') };
    return { entry, ref: value };
  }

  // ── واجهة المستخدم (منتقي النافذة — الحارس ١) ──

  function publicTarget(t) {
    return {
      targetId: t.targetId,
      pid: t.pid,
      processName: guard.clipText(String(t.processName || ''), 64),
      title: guard.clipText(String(t.title || '')),
      rect: t.rect ? { x: t.rect.x, y: t.rect.y, w: t.rect.w, h: t.rect.h } : null,
    };
  }

  // نافذة سطر نفسها لا تُعرض ولا تُختار: وإلا نقر الوكيل «سماح» في مربع إذنه
  function selectable(t) {
    return !!t && typeof t === 'object' && TARGET_ID_RE.test(String(t.targetId || '')) && Number.isSafeInteger(t.pid)
      && t.pid !== selfPid && !!t.rect && !guard.isBlockedTarget(t).blocked;
  }

  function listTargets() {
    return exclusive(async () => {
      try {
        // عبر ensureHelper لا إقلاعاً مباشراً: جلسة حيّة يُعاد ربطها بالمعين الجديد وإلا ضاع اختيارها
        await ensureHelper();
        const list = await call('targets/list');
        const targets = (Array.isArray(list) ? list : []).filter(selectable).map(publicTarget);
        return { ok: true, targets };
      } catch (e) { return fromError(e); }
    });
  }

  function selectTarget(choice) {
    const c = choice && typeof choice === 'object' ? choice : {};
    if (typeof c.targetId !== 'string' || !TARGET_ID_RE.test(c.targetId) || !Number.isSafeInteger(c.pid) || c.pid <= 0) {
      return Promise.resolve(fail('bad_input', 'اختيار غير صالح: المتوقع {targetId:"w<n>", pid} من قائمة النوافذ.'));
    }
    return exclusive(async () => {
      try {
        if (!helper || !helper.alive) { helper = null; helper = await boot(); }
        const list = await call('targets/list');
        const target = (Array.isArray(list) ? list : []).find((t) => t && t.targetId === c.targetId && t.pid === c.pid);
        if (!target) return fail('not_found', 'النافذة لم تعد في القائمة — حدّث القائمة واختر من جديد.');
        if (target.pid === selfPid) return notAllowed('نافذة سطر نفسها لا تُختار');
        let fresh;
        try { fresh = guard.createSession(target); } catch (e) { return notAllowed(e.message); }
        try { await call('session/select', { targetId: fresh.targetId, pid: fresh.pid, rect: fresh.rect }); }
        catch (e) { guard.closeSession(fresh); return fromError(e); }
        if (session) guard.closeSession(session);
        session = fresh;
        sessionSerial += 1;
        restartUsed = false;
        handoffActive = false;
        surface.invalidate();
        current = null;
        return { ok: true, target: publicTarget(fresh) };
      } catch (e) { return fromError(e); }
    });
  }

  // سحب الاختيار = نهاية الجلسة: كل فعل بعده closed، والمعين يُغلق معها
  function clearTarget() {
    return exclusive(async () => {
      endSession();
      await closeHelper();
      return { ok: true };
    });
  }

  // ── الأدوات الثماني (§٧) ──

  function targets() {
    return exclusive(async () => {
      if (!session) return notAllowed('لم يختر المستخدم نافذة لهذه الجلسة بعد — اطلب منه اختيارها من منتقي النوافذ');
      const denied = guard.checkAction(session, { type: 'snapshot' });
      if (denied) return fromGuard(denied);
      try {
        const restarted = await ensureHelper();
        const list = await call('targets/list');
        const visible = guard.filterTargets(session, list).map(publicTarget);
        if (!visible.length) {
          return fail('closed', 'لم تعد النافذة المختارة ظاهرة (أُغلقت أو صُغّرت أو صار عنوانها محجوباً) — اطلب من المستخدم اختيارها من جديد.');
        }
        const t = visible[0];
        const lines = [
          restarted ? restartedNote() : '',
          'النافذة المختارة لهذه الجلسة (ولا غيرها): ' + t.targetId + ' — ' + windowLabel() + (t.title ? ' «' + t.title + '»' : ''),
          t.rect ? 'المستطيل: ' + t.rect.w + '×' + t.rect.h + ' عند (' + t.rect.x + '،' + t.rect.y + ')' : '',
          'خذ desktop_snapshot بـ target: "' + t.targetId + '" قبل أي فعل.',
        ].filter(Boolean);
        return { ok: true, targets: visible, text: lines.join('\n') };
      } catch (e) { return fromError(e); }
    });
  }

  function snapshot(target) {
    return exclusive(async () => {
      if (handoffActive) return fail('handoff');
      const denied = guard.checkAction(session, { type: 'snapshot', target: target === undefined || target === null ? undefined : String(target) });
      if (denied) return fromGuard(denied);
      try {
        const restarted = await ensureHelper();
        const map = await takeSnapshot();
        emitActivity({ type: 'snapshot' }, null);
        return { ok: true, text: snapshotText(map, restarted ? restartedNote() : ''), count: map.count, truncated: map.truncated, generation: map.gen };
      } catch (e) { return fromError(e); }
    });
  }

  // فعل بمرجع: surface ⇒ الحارس ⇒ المعين، ثم سطر السجل ثم التفاضل
  function refAction(type, ref, extra) {
    return exclusive(async () => {
      if (handoffActive) return fail('handoff');
      const gate = sessionGate();
      if (gate) return gate;
      const resolved = resolveRef(ref);
      if (resolved.failure) return resolved.failure;
      const entry = resolved.entry;
      const action = Object.assign({ type, ref: entry.helperRef }, extra || {});
      const denied = guard.checkAction(session, action, entry.node);
      if (denied) return fromGuard(denied);
      try {
        if (await ensureHelper()) return fail('stale_ref', restartedNote() + ' خذ desktop_snapshot جديدة.');
        const method = type === 'click' ? 'element/invoke' : type === 'type' ? 'element/setValue' : 'input/scroll';
        const params = { ref: entry.helperRef };
        if (type === 'type') params.text = extra.text;
        if (type === 'scroll') params.dy = extra.dy;
        const result = await call(method, params);
        emitActivity(action, entry.node);
        const delta = await afterAction();
        return { ok: true, text: actionText(type, result, entry.node, extra) + '\n' + deltaText(delta) };
      } catch (e) { return fromError(e); }
    });
  }

  function actionText(type, result, node, extra) {
    const element = '[' + (node.name || 'عنصر بلا اسم') + '] (' + node.role + ')';
    if (type === 'click') return 'نُقر على ' + element + ' عبر UI Automation.';
    if (type === 'type') {
      const wanted = normalizeEol(extra.text);
      const got = normalizeEol(result && result.value);
      const matches = got === wanted || (got.endsWith('…') && wanted.startsWith(got.slice(0, -1)));
      return 'كُتب النص في ' + element + ' — القراءة الثانية من العنصر ' + (matches ? 'تطابق المكتوب.' : 'لا تطابق المكتوب حرفياً (قد يحوّل الحقل النص).');
    }
    const via = result && result.via === 'pattern'
      ? 'بـScrollPattern (النسبة ' + result.before + '% ⇒ ' + result.after + '%)'
      : 'برسالة عجلة على مستطيل العنصر';
    return 'مُرِّر ' + element + ' ' + via + '.';
  }

  function click(ref) { return refAction('click', ref); }

  function type(ref, text) {
    if (typeof text !== 'string') return Promise.resolve(fail('bad_input', 'text مطلوب نصاً.'));
    if (text.length > MAX_TEXT_UNITS) return Promise.resolve(fail('bad_input', 'النص أطول من ' + MAX_TEXT_UNITS + ' محرفاً.'));
    return refAction('type', ref, { text });
  }

  function scroll(ref, dy) {
    if (!Number.isInteger(dy) || dy === 0 || Math.abs(dy) > MAX_SCROLL_STEPS) {
      return Promise.resolve(fail('bad_input', 'dy عدد خطوات صحيح بين -' + MAX_SCROLL_STEPS + ' و' + MAX_SCROLL_STEPS + ' بلا صفر (الموجب إلى الأسفل).'));
    }
    return refAction('scroll', ref, { dy });
  }

  function pressKey(keys) {
    const value = typeof keys === 'string' ? keys.trim() : '';
    if (!value || value.length > 32) return Promise.resolve(fail('bad_key'));
    return exclusive(async () => {
      if (handoffActive) return fail('handoff');
      const action = { type: 'press_key', keys: value };
      const denied = guard.checkAction(session, action);
      if (denied) return fromGuard(denied);
      try {
        const restarted = await ensureHelper();
        const result = await call('input/key', { keys: value }, KEY_TIMEOUT_MS);
        const canonical = typeof result.keys === 'string' ? result.keys : value;
        emitActivity({ type: 'press_key', keys: canonical }, null);
        const delta = await afterAction();
        return { ok: true, text: (restarted ? restartedNote() + '\n' : '') + 'ضُغط ' + canonical + ' في النافذة المختارة بعد جلبها إلى الأمام.\n' + deltaText(delta) };
      } catch (e) { return fromError(e); }
    });
  }

  function waitFor(input) {
    const a = input && typeof input === 'object' ? input : {};
    const timeout = a.timeout === undefined ? WAIT_DEFAULT_MS : a.timeout;
    if (!Number.isInteger(timeout) || timeout < WAIT_MIN_MS || timeout > WAIT_MAX_MS) {
      return Promise.resolve(fail('bad_input', 'timeout بالمللي ثانية بين ' + WAIT_MIN_MS + ' و' + WAIT_MAX_MS + '.'));
    }
    const hasRef = typeof a.ref === 'string' && a.ref.trim() !== '';
    const needle = typeof a.text === 'string' ? a.text.normalize('NFC').trim().toLowerCase() : '';
    if (!hasRef && !needle) return Promise.resolve(fail('bad_input', 'حدّد ref من آخر لقطة أو text يُنتظر ظهوره.'));
    if (!hasRef && needle.length > MAX_WAIT_TEXT) return Promise.resolve(fail('bad_input', 'text أطول من ' + MAX_WAIT_TEXT + ' محرفاً.'));
    return exclusive(async () => {
      if (handoffActive) return fail('handoff');
      const deadline = Date.now() + timeout;
      const gate = sessionGate();
      if (gate) return gate;
      if (hasRef) {
        const resolved = resolveRef(a.ref);
        if (resolved.failure) return resolved.failure;
        const entry = resolved.entry;
        const denied = guard.checkAction(session, { type: 'wait_for', ref: entry.helperRef }, entry.node);
        if (denied) return fromGuard(denied);
        try {
          if (await ensureHelper()) return fail('stale_ref', restartedNote() + ' خذ desktop_snapshot جديدة.');
          let ready = false;
          for (;;) {
            const state = await call('element/state', { ref: entry.helperRef });
            ready = !!(state && state.enabled === true && state.inside === true);
            if (ready || Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, pollMs));
          }
          emitActivity({ type: 'wait_for', ref: entry.helperRef }, entry.node);
          return { ok: true, found: ready, text: ready
            ? 'صار [' + (entry.node.name || 'العنصر') + '] متاحاً: مفعَّلاً وداخل النافذة المأذونة.'
            : 'انتهت المهلة ولم يصر [' + (entry.node.name || 'العنصر') + '] متاحاً.' };
        } catch (e) { return fromError(e); }
      }
      const denied = guard.checkAction(session, { type: 'wait_for' });
      if (denied) return fromGuard(denied);
      try {
        await ensureHelper();
        let map;
        let found = false;
        for (;;) {
          map = await takeSnapshot();
          found = [...map.refs.values()].some((e) => String(e.node.name || '').normalize('NFC').toLowerCase().includes(needle));
          if (found || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, pollMs));
        }
        emitActivity({ type: 'wait_for' }, null);
        return { ok: true, found, text: (found ? 'ظهر النص المطلوب في شجرة النافذة.' : 'انتهت المهلة ولم يظهر النص المطلوب.')
          + ' هذه لقطة جديدة أبطلت المراجع الأقدم:\n' + snapshotText(map) };
      } catch (e) { return fromError(e); }
    });
  }

  function screenshot(target) {
    return exclusive(async () => {
      if (handoffActive) return fail('handoff');
      const denied = guard.checkAction(session, { type: 'screenshot', target: target === undefined || target === null ? undefined : String(target) });
      if (denied) return fromGuard(denied);
      try {
        const restarted = await ensureHelper();
        const r = await call('capture/window', { targetId: session.targetId }, CAPTURE_TIMEOUT_MS);
        if (!r || typeof r.png !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.png)
          || !Number.isInteger(r.width) || !Number.isInteger(r.height)) {
          return fail('not_found', whyClosed('bad_capture', 'تعذّر التقاط النافذة'));
        }
        emitActivity({ type: 'screenshot' }, null);
        const notes = [];
        if (restarted) notes.push(restartedNote());
        if (r.sourceWidth > r.width) notes.push('صُغّرت الصورة من ' + r.sourceWidth + '×' + r.sourceHeight + ' إلى ' + r.width + '×' + r.height + '.');
        notes.push('آخر الملاذ: للحكم على الشكل وحده — الأفعال بمراجع desktop_snapshot لا بمواضع الصورة.');
        return { ok: true, base64: r.png, mimeType: 'image/png', width: r.width, height: r.height, note: notes.join('\n') };
      } catch (e) { return fromError(e); }
    });
  }

  // ── التسليم البشري: تعليق الأدوات كلها كما في المتصفح؛ نهايته تُبطل المراجع ──
  function startHandoff() {
    if (handoffActive) return { ok: false, error: 'active' };
    handoffActive = true;
    return { ok: true };
  }
  function endHandoff() {
    if (!handoffActive) return { ok: true, wasActive: false };
    handoffActive = false;
    surface.invalidate();
    current = null;
    return { ok: true, wasActive: true };
  }

  // تفاصيل مربع الإذن: النافذة والعنصر (من خريطة الجيل النشط) والنص — بلا مسار ولا مقبض
  function permissionDetail(toolName, input) {
    const bare = String(toolName || '').replace(TOOL_PREFIX_RE, '');
    const data = input && typeof input === 'object' ? input : {};
    const lines = [];
    if (session) lines.push('النافذة: ' + windowLabel() + ' (' + session.targetId + ')' + (session.title ? ' «' + session.title + '»' : ''));
    else lines.push('النافذة: لم يختر المستخدم نافذة لهذه الجلسة بعد');
    if (typeof data.ref === 'string' && data.ref) {
      const entry = current && current.refs.get(data.ref.trim());
      lines.push('العنصر: ' + guard.clipText(data.ref, 40) + (entry
        ? ' — ' + entry.node.role + (entry.node.name ? ' «' + entry.node.name + '»' : '')
        : ' (ليس من آخر لقطة — سيُرفض stale_ref)'));
    }
    if (bare === 'desktop_type') lines.push('النص المراد كتابته: ' + JSON.stringify(clipUnits(data.text, 600)));
    if (bare === 'desktop_press_key') lines.push('المفاتيح: ' + guard.clipText(String(data.keys || ''), 32));
    if (bare === 'desktop_scroll' && Number.isInteger(data.dy)) {
      lines.push('التمرير: ' + Math.abs(data.dy) + ' خطوة ' + (data.dy > 0 ? 'إلى الأسفل' : 'إلى الأعلى'));
    }
    return lines.join('\n');
  }

  async function shutdown() {
    handoffActive = false;
    endSession();
    await closeHelper();
  }

  return {
    isAvailable,
    listTargets,
    selectTarget,
    clearTarget,
    targets,
    snapshot,
    click,
    type,
    pressKey,
    scroll,
    waitFor,
    screenshot,
    startHandoff,
    endHandoff,
    isHandoffActive: () => handoffActive,
    permissionDetail,
    shutdown,
    setEventSink(fn) { sink = typeof fn === 'function' ? fn : null; },
    unavailableMessage: () => UNAVAILABLE_MESSAGE,
    // للاختبار وحده — نسخ لا مراجع حيّة
    _state() {
      return {
        helperPid: helper && helper.alive ? helper.pid : null,
        hasSession: !!session,
        targetId: session ? session.targetId : null,
        generation: surface.generation,
        refs: current ? [...current.refs.keys()] : [],
        stats: Object.assign({}, lastStats),
      };
    },
  };
}

const instance = createDesktop();

module.exports = Object.assign(instance, {
  createDesktop,
  resolveHelperPath,
  shouldRegister,
  validateResponse,
  formatLine,
  MESSAGES,
  UNAVAILABLE_MESSAGE,
  MAX_NODES,
  DEFAULT_BOOT_TIMEOUT_MS,
});
