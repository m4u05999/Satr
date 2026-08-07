'use strict';

// مدير جولة TestSprite: وحدة مفردة في العملية الرئيسية تملك دورة حياة الجولة **عبر
// الأدوار** بدل تملّكها داخل دور واحد (كما كان في agent.js/codex.js). تملك الـharness
// والمراقب معاً، وتبثّ snapshot منقّى عبر notifier يحقنه main.js.
//
// حدود صارمة مقصودة:
// - لا تقرأ المفتاح ولا تحمله في الحالة إطلاقاً.
// - لا تشغّل أوامر TestSprite بنفسها؛ النموذج يشغّلها بأدوات الطرفية القائمة.
// - لا تعرف Electron ولا renderer؛ البثّ عبر دالة محقونة فقط.
// - snapshot بقائمة حقول مغلقة: لا مسار مطلق ولا برومبت ولا URL كامل (المنفذ يكفي).

const path = require('path');

const defaultTestsprite = require('./testsprite');
const defaultHarness = require('./testspriteharness');

const SCHEMA_VERSION = 1;
const JOB_ID_RE = /^tsj_[0-9]{1,15}_[a-z0-9]{1,10}$/;
const KINDS = Object.freeze(['app', 'site']);
const STATES = Object.freeze(['preparing', 'awaiting_setup', 'running', 'completed', 'cancelled', 'failed']);
const TERMINAL_STATES = Object.freeze(['completed', 'cancelled', 'failed']);
// قائمة مغلقة: لا نص خطأ خام يعبر إلى الحدث.
const FAILURE_CODES = Object.freeze(['harness_lost', 'internal_error']);
const START_ERRORS = Object.freeze(['bad_input', 'busy', 'harness_failed', 'cancelled', 'internal_error']);
const SUMMARY_FIELDS = Object.freeze(['total', 'completed', 'passed', 'failed', 'skipped', 'blocked']);

const HEARTBEAT_MS = 15000;
// مطلب «لا صمت غير مفسر >30s»: نبضة كل 15ث فأقصى صمت نصف دورتين.
const BROADCAST_MAX_SILENCE_MS = 30000;
const SCRUB_INTERVAL_MS = 60000;
// ثلاث نبضات متتالية بلا استجابة (~45 ثانية) = سقوط بلا استرجاع، لا تعثّر عابر.
const HARNESS_PROBE_FAILURES = 3;

const TERMINAL_SET = new Set(TERMINAL_STATES);

function intOf(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// عدّادات الملخّص فقط — لا testIds ولا complete ولا أي حقل يضيفه المراقب لاحقاً.
function pickSummary(source) {
  const raw = source && typeof source === 'object' ? source : {};
  const summary = {};
  for (const field of SUMMARY_FIELDS) summary[field] = intOf(raw[field]);
  return summary;
}

function newJobId(nowFn) {
  const stamp = String(Math.max(0, Math.floor(nowFn() || 0))).slice(-15) || '0';
  const rand = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '');
  return 'tsj_' + stamp + '_' + (rand || '0').slice(0, 10);
}

function create(deps) {
  const options = deps && typeof deps === 'object' ? deps : {};
  const ts = options.testsprite || defaultTestsprite;
  const harness = options.harness || defaultHarness;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
  const clearTimer = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;

  let notifier = typeof options.notifier === 'function' ? options.notifier : null;
  // الجولة الحالية، أو آخر جولة منتهية (تبقى للعرض/الترطيب بعد الاكتمال).
  let job = null;
  let heartbeatTimer = null;
  let scrubTimer = null;
  let lastBroadcastAt = 0;
  let ticking = false;

  function isActive() {
    return Boolean(job) && !TERMINAL_SET.has(job.state);
  }

  function snapshot() {
    if (!job) return null;
    return {
      type: 'testsprite_job',
      schema_version: SCHEMA_VERSION,
      job_id: job.id,
      kind: job.kind,
      state: job.state,
      port: Number.isInteger(job.port) ? job.port : null,
      started_at: job.startedAt,
      heartbeat_at: job.heartbeatAt,
      summary: { ...job.summary },
      failure_code: job.failureCode,
      updated_at: job.updatedAt,
    };
  }

  function broadcast() {
    const payload = snapshot();
    if (!payload) return;
    lastBroadcastAt = now();
    if (!notifier) return;
    try { notifier(payload); } catch { /* فشل المستهلك لا يكسر الجولة */ }
  }

  // حزمة TestSprite قد تكتب API_KEY في config المؤقت أثناء التشغيل.
  function scrub() {
    if (!job) return;
    try { ts.scrubConfig(job.cwd); } catch { /* أفضل جهد */ }
  }

  function configReady(cwd) {
    try { return ts.completedConfig(cwd) === true; } catch { return false; }
  }

  function transition(next, failureCode) {
    if (!job || job.state === next) return false;
    job.state = next;
    job.failureCode = next === 'failed' && FAILURE_CODES.includes(failureCode) ? failureCode : null;
    job.updatedAt = now();
    scrub(); // تنقية عند كل انتقال حالة — لا اعتماد على المؤقّت وحده
    return true;
  }

  function stopTimers() {
    if (heartbeatTimer) { try { clearTimer(heartbeatTimer); } catch {} heartbeatTimer = null; }
    if (scrubTimer) { try { clearTimer(scrubTimer); } catch {} scrubTimer = null; }
  }

  async function closeHost(host) {
    if (!host || !host.owned || typeof host.close !== 'function') return;
    try { await host.close(); } catch { /* أفضل جهد */ }
  }

  // تحرير متزامن (مؤقّتات + مراقب) يعيد الخادم كي يُغلق بعد البثّ.
  function releaseLocal() {
    stopTimers();
    if (!job) return null;
    const watcher = job.watcher;
    job.watcher = null;
    if (watcher && typeof watcher.stop === 'function') {
      try { watcher.stop(); } catch {}
    }
    const host = job.host;
    job.host = null;
    return host;
  }

  async function finish(state, failureCode) {
    if (!job || TERMINAL_SET.has(job.state)) return;
    transition(state, failureCode);
    const host = releaseLocal();
    // البثّ قبل الإغلاق عمداً: server.close() ينتظر تصريف اتصالات keep-alive (ثوانٍ
    // مع متصفح الاختبار)، ولا يجوز أن تنتظر بطاقة الحالة ذلك لتعرف أن الجولة انتهت.
    broadcast();
    await closeHost(host);
    scrub(); // config قد يُكتب أثناء الإغلاق، فالتنقية الأخيرة بعد تحرير كل شيء
  }

  function handleWatcherUpdate(owner, update) {
    if (!job || job !== owner || TERMINAL_SET.has(job.state)) return;
    const payload = update && typeof update === 'object' ? update : {};
    job.summary = pickSummary(payload);
    job.heartbeatAt = now(); // مصدر النبض 1: تغيّر ملف النتائج
    job.updatedAt = job.heartbeatAt;
    if (payload.phase === 'complete') {
      finish('completed', null).catch(() => {});
      return;
    }
    transition('running'); // أول تغيّر للنتائج يرفع نافذة انتظار التهيئة
    broadcast();
  }

  function probeHost(owner) {
    if (!Number.isInteger(owner.port) || typeof harness.probe !== 'function') return Promise.resolve(true);
    try {
      return Promise.resolve(harness.probe(owner.port, owner.kind === 'site' ? 'site' : undefined))
        .then((value) => value === true, () => false);
    } catch { return Promise.resolve(false); }
  }

  async function runTick() {
    if (!isActive()) return;
    const owner = job;
    let progressed = false;

    // مصدر النبض 1: بصمة ملف النتائج.
    let fingerprint = null;
    try {
      const snap = ts.resultSnapshot(owner.cwd);
      fingerprint = (snap && snap.fingerprint) || null;
    } catch { fingerprint = null; }
    if (fingerprint && fingerprint !== owner.lastFingerprint) {
      owner.lastFingerprint = fingerprint;
      owner.heartbeatAt = now();
      progressed = true;
    }

    // نافذة نموذج bootstrap انتهت: تغيّرت النتائج أو اكتملت التهيئة.
    if (owner.state === 'awaiting_setup' && (progressed || configReady(owner.cwd))) {
      if (transition('running')) progressed = true;
    }

    // مصدر النبض 2: صحة الـharness.
    const alive = await probeHost(owner);
    if (job !== owner || TERMINAL_SET.has(owner.state)) return;
    if (alive) {
      owner.probeFailures = 0;
      owner.heartbeatAt = now();
    } else {
      owner.probeFailures += 1;
      if (owner.probeFailures >= HARNESS_PROBE_FAILURES) {
        await finish('failed', 'harness_lost');
        return;
      }
    }

    if (progressed || now() - lastBroadcastAt >= BROADCAST_MAX_SILENCE_MS) {
      owner.updatedAt = now();
      broadcast();
    }
  }

  async function heartbeatTick() {
    if (ticking) return; // نبضة سابقة ما زالت تنتظر probe
    ticking = true;
    try { await runTick(); } catch { /* لا نكسر المؤقّت */ } finally { ticking = false; }
  }

  async function startJob(input) {
    const request = input && typeof input === 'object' ? input : {};
    const cwd = request.cwd;
    const kind = request.kind;
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return { ok: false, error: 'bad_input' };
    if (!KINDS.includes(kind)) return { ok: false, error: 'bad_input' };
    // جولة نشطة واحدة فقط — الفحص والتسجيل متزامنان قبل أي await كي لا يمرّ طلبان.
    if (isActive()) return { ok: false, error: 'busy', jobId: job.id };

    // البرومبت الخام لا يُخزَّن: نستخرج المعرّفات فوراً ثم نتخلى عنه.
    let testIds = [];
    try {
      const extracted = ts.extractTestIds(request.prompt);
      if (Array.isArray(extracted)) testIds = extracted;
    } catch { testIds = []; }

    const startedAt = now();
    const current = {
      id: newJobId(now),
      kind,
      cwd,
      state: 'preparing',
      port: null,
      startedAt,
      heartbeatAt: startedAt,
      updatedAt: startedAt,
      failureCode: null,
      summary: pickSummary({ total: testIds.length }),
      host: null,
      watcher: null,
      lastFingerprint: null,
      probeFailures: 0,
    };
    job = current;
    lastBroadcastAt = 0;
    scrub();
    broadcast();

    let host;
    try {
      host = kind === 'site' ? await harness.startSite() : await harness.start();
    } catch (error) {
      if (job === current) job = null; // لا نترك جولة معلّقة على خادم لم يقلع
      return { ok: false, error: 'harness_failed' };
    }
    if (job !== current) {
      await closeHost(host); // أُلغيت الجولة أثناء الإقلاع — لا خادم يتيم
      return { ok: false, error: 'cancelled' };
    }

    current.host = host;
    current.port = Number.isInteger(host && host.port) ? host.port : null;
    try {
      current.watcher = ts.watchResults(cwd, {
        testIds,
        onUpdate: (update) => handleWatcherUpdate(current, update),
      });
      const baseline = current.watcher && current.watcher.baseline;
      current.lastFingerprint = (baseline && baseline.fingerprint) || null;
    } catch (error) {
      await finish('failed', 'internal_error');
      return { ok: false, error: 'internal_error' };
    }

    // تهيئة مكتملة سلفاً ⇒ لا نافذة bootstrap ننتظرها.
    transition(configReady(cwd) ? 'running' : 'awaiting_setup');
    heartbeatTimer = setTimer(heartbeatTick, HEARTBEAT_MS);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    scrubTimer = setTimer(scrub, SCRUB_INTERVAL_MS);
    if (scrubTimer && typeof scrubTimer.unref === 'function') scrubTimer.unref();
    broadcast();
    return { ok: true, jobId: current.id, url: host && host.url };
  }

  function status() {
    return snapshot() || { active: false };
  }

  async function cancel(jobId) {
    if (!job) return { ok: false, error: 'not_found' };
    if (typeof jobId === 'string' && jobId && jobId !== job.id) return { ok: false, error: 'not_found' };
    if (TERMINAL_SET.has(job.state)) return { ok: false, error: 'not_active' };
    await finish('cancelled', null);
    return { ok: true };
  }

  async function cleanupBeforeQuit() {
    if (!job) { stopTimers(); return; }
    if (!TERMINAL_SET.has(job.state)) { await finish('cancelled', null); return; }
    await closeHost(releaseLocal());
  }

  function setNotifier(fn) {
    notifier = typeof fn === 'function' ? fn : null;
  }

  return { startJob, status, cancel, cleanupBeforeQuit, setNotifier };
}

const shared = create();

module.exports = {
  SCHEMA_VERSION, JOB_ID_RE, KINDS, STATES, TERMINAL_STATES, FAILURE_CODES, START_ERRORS,
  SUMMARY_FIELDS, HEARTBEAT_MS, BROADCAST_MAX_SILENCE_MS, SCRUB_INTERVAL_MS, HARNESS_PROBE_FAILURES,
  create,
  startJob: shared.startJob,
  status: shared.status,
  cancel: shared.cancel,
  cleanupBeforeQuit: shared.cleanupBeforeQuit,
  setNotifier: shared.setNotifier,
};
