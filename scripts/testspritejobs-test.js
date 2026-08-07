#!/usr/bin/env node
'use strict';

// اختبار قطعي لنواة مدير جولة TestSprite: بلا شبكة وبلا قرص وبلا مؤقّتات حقيقية.
// كل اعتماد خارجي (testsprite / testspriteharness / الساعة / المؤقّتات) محقون بمزيّف،
// فالفحص يصف عقد النواة نفسه لا سلوك الحزمة الخارجية.

const assert = require('assert');
const path = require('path');
const jobs = require('../electron/testspritejobs');

const CWD = path.resolve('/', 'satr-fake-project', 'root');
const SECRET = 'sk-user-' + 'a'.repeat(44);
const PROMPT = 'اختبر TC101 عبر TestSprite. المفتاح ' + SECRET + ' وسرّ المستخدم لا يجوز تسريبه.';

let checks = 0;
function ok(label) { checks += 1; console.log('  ✔ ' + label); }

// حدّ غير متزامن مقصود في النواة: إغلاق الخادم ثم التنقية الأخيرة يقعان بعد بثّ
// الحالة النهائية (كي لا تنتظر البطاقة تصريف keep-alive). ننتظرهما صراحةً.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeEnv(settings) {
  const options = settings && typeof settings === 'object' ? settings : {};
  const state = {
    clock: 1000,
    fingerprint: null,        // بصمة ملف النتائج الحالية
    configComplete: false,    // testsprite_tests/tmp/config.json مكتمل
    probeAlive: true,
    events: [],               // ما يبثّه notifier
    scrubs: 0,
    startCalls: [],           // ['app'|'site']
    probeCalls: [],           // [port, surface]
    closed: [],               // منافذ أُغلقت فعلاً
    watchers: [],             // مراقبو النتائج المنشأون
    timers: new Map(),        // ms → callback
    unrefs: 0,
    // أعطال قابلة للإطفاء أثناء الاختبار كي نثبت التعافي لا الفشل الدائم.
    startThrows: options.startThrows === true,
    watchThrows: options.watchThrows === true,
  };

  const ts = {
    extractTestIds(prompt) {
      return [...new Set((String(prompt || '').match(/\bTC\d{3,}\b/gi) || []).map((id) => id.toUpperCase()))];
    },
    watchResults(cwd, opts) {
      if (state.watchThrows) throw new Error('watch_boom');
      const watcher = {
        cwd, testIds: opts.testIds, stopped: false,
        baseline: state.fingerprint ? { fingerprint: state.fingerprint } : null,
        emit: opts.onUpdate,
        stop() { this.stopped = true; },
      };
      state.watchers.push(watcher);
      return watcher;
    },
    resultSnapshot(cwd) {
      assert.strictEqual(cwd, CWD, 'المراقب يقرأ مجلد الجولة نفسه');
      return state.fingerprint ? { fingerprint: state.fingerprint } : null;
    },
    completedConfig() { return state.configComplete; },
    scrubConfig(cwd) {
      assert.strictEqual(cwd, CWD, 'التنقية على مجلد الجولة نفسه');
      state.scrubs += 1;
      return true;
    },
  };

  function makeHost(port, kind) {
    return {
      port, url: 'http://127.0.0.1:' + port, owned: options.owned === false ? false : true,
      async close() { state.closed.push(port); },
      kind,
    };
  }

  const harness = {
    async start() {
      state.startCalls.push('app');
      if (state.startThrows) throw new Error('EADDRINUSE');
      return makeHost(4173, 'app');
    },
    async startSite() {
      state.startCalls.push('site');
      if (state.startThrows) throw new Error('EADDRINUSE');
      return makeHost(4620, 'site');
    },
    async probe(port, surface) {
      state.probeCalls.push([port, surface]);
      return state.probeAlive;
    },
  };

  const manager = jobs.create({
    testsprite: ts,
    harness,
    now: () => state.clock,
    notifier: (event) => state.events.push(event),
    setInterval: (fn, ms) => { state.timers.set(ms, fn); return { ms, unref() { state.unrefs += 1; } }; },
    clearInterval: (handle) => { if (handle && state.timers.has(handle.ms)) state.timers.delete(handle.ms); },
  });

  return {
    state, manager,
    advance(ms) { state.clock += ms; },
    async beat() {
      const fn = state.timers.get(jobs.HEARTBEAT_MS);
      assert(fn, 'مؤقّت النبض غير مسجَّل');
      await fn();
    },
    scrubTick() {
      const fn = state.timers.get(jobs.SCRUB_INTERVAL_MS);
      assert(fn, 'مؤقّت التنقية غير مسجَّل');
      fn();
    },
    watcher() { return state.watchers[state.watchers.length - 1]; },
    last() { return state.events[state.events.length - 1]; },
  };
}

// ملخّص المراقب الخام كما يبثّه testsprite.watchResults (بحقول زائدة يجب ألا تعبر).
function progress(phase, extra) {
  return Object.assign({
    type: 'testsprite_progress', phase,
    testIds: ['TC101'], total: 1, completed: 0, passed: 0, failed: 0, skipped: 0, blocked: 0,
    complete: phase === 'complete',
  }, extra || {});
}

async function testStartBothKinds() {
  for (const kind of ['app', 'site']) {
    const env = makeEnv();
    const res = await env.manager.startJob({ cwd: CWD, kind, prompt: PROMPT });
    assert.strictEqual(res.ok, true, 'بدء جولة ' + kind);
    assert(jobs.JOB_ID_RE.test(res.jobId), 'معرّف الجولة يطابق النمط: ' + res.jobId);
    assert.strictEqual(res.url, kind === 'site' ? 'http://127.0.0.1:4620' : 'http://127.0.0.1:4173');
    assert.deepStrictEqual(env.state.startCalls, [kind], 'يبدأ سطح النوع الصحيح فقط');
    assert.strictEqual(env.last().port, kind === 'site' ? 4620 : 4173);
    assert.strictEqual(env.last().kind, kind);
    assert.strictEqual(env.state.watchers.length, 1, 'مراقب واحد للجولة');
    assert.deepStrictEqual(env.watcher().testIds, ['TC101'], 'المعرّفات مستخرجة من البرومبت');
    assert.strictEqual(env.state.unrefs, 2, 'مؤقّتا النبض والتنقية unref');
  }
  ok('startJob ينجح للنوعين app/site ويبدأ السطح والمراقب المطابقين');
}

async function testStartValidationAndBusy() {
  const env = makeEnv();
  assert.deepStrictEqual(await env.manager.startJob({ cwd: 'relative/path', kind: 'app' }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(await env.manager.startJob({ cwd: CWD, kind: 'web' }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(await env.manager.startJob(null), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(env.manager.status(), { active: false }, 'مدخل فاسد لا ينشئ جولة');

  const first = await env.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  const second = await env.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'busy');
  assert.strictEqual(second.jobId, first.jobId, 'busy يحمل معرّف الجولة النشطة');
  assert.deepStrictEqual(env.state.startCalls, ['app'], 'الطلب الثاني لا يبدأ خادماً ثانياً');

  // سباق: طلبان متزامنان قبل اكتمال إقلاع الخادم.
  const race = makeEnv();
  const [a, b] = await Promise.all([
    race.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT }),
    race.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT }),
  ]);
  assert.strictEqual(a.ok !== b.ok, true, 'واحد فقط ينجح في السباق');
  assert.strictEqual((a.ok ? b : a).error, 'busy');
  assert.deepStrictEqual(race.state.startCalls, ['app'], 'السباق لا يقلع خادمين');
  ok('busy وتحقق المدخلات: جولة نشطة واحدة حتى تحت طلبين متزامنين');
}

async function testAwaitingSetupThenRunning() {
  const env = makeEnv();
  await env.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  assert.strictEqual(env.state.events[0].state, 'preparing', 'أول بثّ حالة التجهيز');
  assert.strictEqual(env.manager.status().state, 'awaiting_setup', 'بلا تغيّر نتائج وبلا config مكتمل');

  // نبضة بلا أي جديد تبقي الحالة كما هي (نافذة نموذج bootstrap).
  env.advance(jobs.HEARTBEAT_MS);
  await env.beat();
  assert.strictEqual(env.manager.status().state, 'awaiting_setup');

  // اكتمال التهيئة وحده يرفع النافذة حتى قبل أول نتيجة.
  env.state.configComplete = true;
  env.advance(jobs.HEARTBEAT_MS);
  await env.beat();
  assert.strictEqual(env.manager.status().state, 'running', 'config مكتمل ⇒ running');

  // وفي جولة تهيئتها مكتملة سلفاً لا يمرّ awaiting_setup إطلاقاً.
  const ready = makeEnv();
  ready.state.configComplete = true;
  await ready.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  assert.strictEqual(ready.manager.status().state, 'running');
  assert.strictEqual(ready.state.events.some((e) => e.state === 'awaiting_setup'), false);
  ok('awaiting_setup قبل أول تغيّر نتائج، ويرتفع بالتهيئة المكتملة أو بالنتائج');
}

async function testStateTransitions() {
  const seen = new Set();
  const record = (env) => env.state.events.forEach((e) => seen.add(e.state));

  // preparing → awaiting_setup → running → completed
  const done = makeEnv();
  await done.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  done.watcher().emit(progress('running', { completed: 1, passed: 1 }));
  assert.strictEqual(done.manager.status().state, 'running', 'أول تغيّر نتائج ⇒ running');
  assert.deepStrictEqual(done.manager.status().summary,
    { total: 1, completed: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 });
  done.watcher().emit(progress('complete', { completed: 1, passed: 1 }));
  assert.strictEqual(done.manager.status().state, 'completed');
  assert.strictEqual(done.manager.status().failure_code, null);
  assert.strictEqual(done.watcher().stopped, true, 'المراقب يتوقف عند الاكتمال');
  assert.deepStrictEqual(done.state.closed, [4173], 'الخادم المملوك يُغلق عند الاكتمال');
  assert.strictEqual(done.state.timers.size, 0, 'المؤقّتات تُلغى عند الحالة النهائية');
  record(done);

  // اكتمال متأخر بعد الحالة النهائية لا يعيد فتح الجولة.
  const before = done.state.events.length;
  done.watcher().emit(progress('running'));
  assert.strictEqual(done.state.events.length, before, 'تحديث متأخر بعد النهاية مُهمَل');
  assert.strictEqual(done.manager.status().state, 'completed');

  // cancelled
  const stopped = makeEnv();
  const started = await stopped.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  assert.deepStrictEqual(await stopped.manager.cancel('tsj_1_zz'), { ok: false, error: 'not_found' });
  assert.deepStrictEqual(await stopped.manager.cancel(started.jobId), { ok: true });
  assert.strictEqual(stopped.manager.status().state, 'cancelled');
  assert.deepStrictEqual(await stopped.manager.cancel(started.jobId), { ok: false, error: 'not_active' });
  record(stopped);

  // failed / harness_lost: ثلاث نبضات متتالية بلا استجابة.
  const lost = makeEnv();
  await lost.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  lost.state.probeAlive = false;
  for (let i = 1; i <= jobs.HARNESS_PROBE_FAILURES; i += 1) {
    lost.advance(jobs.HEARTBEAT_MS);
    await lost.beat();
    if (i < jobs.HARNESS_PROBE_FAILURES) {
      assert.notStrictEqual(lost.manager.status().state, 'failed', 'تعثّر عابر لا يُسقط الجولة (نبضة ' + i + ')');
    }
  }
  assert.strictEqual(lost.manager.status().state, 'failed');
  assert.strictEqual(lost.manager.status().failure_code, 'harness_lost');
  assert(jobs.FAILURE_CODES.includes(lost.manager.status().failure_code), 'رمز الفشل من القائمة المغلقة');
  assert.deepStrictEqual(lost.state.closed, [4173], 'السقوط يغلق ما تملكه الجولة');
  record(lost);

  // failed / internal_error عند فشل بنيوي في إنشاء المراقب.
  const broken = makeEnv({ watchThrows: true });
  const res = await broken.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  assert.deepStrictEqual(res, { ok: false, error: 'internal_error' });
  assert.strictEqual(broken.manager.status().state, 'failed');
  assert.strictEqual(broken.manager.status().failure_code, 'internal_error');
  assert.deepStrictEqual(broken.state.closed, [4173], 'الفشل البنيوي لا يترك خادماً يتيماً');
  record(broken);

  // فشل إقلاع الخادم: لا جولة معلّقة أصلاً.
  const noHost = makeEnv({ startThrows: true });
  assert.deepStrictEqual(await noHost.manager.startJob({ cwd: CWD, kind: 'site', prompt: PROMPT }),
    { ok: false, error: 'harness_failed' });
  assert.deepStrictEqual(noHost.manager.status(), { active: false }, 'فشل الإقلاع لا يترك جولة');
  noHost.state.startThrows = false;
  assert.strictEqual((await noHost.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT })).ok, true,
    'الفشل لا يقفل المدير عن جولة تالية');

  assert.deepStrictEqual([...seen].sort(), [...jobs.STATES].sort(), 'الحالات الست كلها مرّت فعلياً');
  ok('الانتقالات الست: preparing/awaiting_setup/running/completed/cancelled/failed');
}

async function testHeartbeatAndBroadcast() {
  const env = makeEnv();
  await env.manager.startJob({ cwd: CWD, kind: 'site', prompt: PROMPT });
  env.watcher().emit(progress('running'));
  assert.strictEqual(env.manager.status().state, 'running');

  // لا صمت غير مفسّر > 30 ثانية أثناء running.
  let lastAt = env.state.clock;
  let gaps = 0;
  for (let i = 0; i < 8; i += 1) {
    env.advance(jobs.HEARTBEAT_MS);
    const before = env.state.events.length;
    await env.beat();
    if (env.state.events.length > before) {
      gaps = Math.max(gaps, env.state.clock - lastAt);
      lastAt = env.state.clock;
    }
    assert(env.state.clock - lastAt <= jobs.BROADCAST_MAX_SILENCE_MS,
      'صمت ' + (env.state.clock - lastAt) + 'ms يتجاوز السقف');
  }
  assert(gaps > 0 && gaps <= jobs.BROADCAST_MAX_SILENCE_MS, 'بثّ دوري فعلي ضمن السقف');
  assert.deepStrictEqual(env.state.probeCalls[0], [4620, 'site'], 'probe يفحص بصمة سطح الموقع');

  // النبض يتقدّم من مصدرين: بصمة ملف النتائج، ونجاح probe.
  const fresh = makeEnv();
  await fresh.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  const beat0 = fresh.manager.status().heartbeat_at;
  fresh.advance(jobs.HEARTBEAT_MS);
  fresh.state.fingerprint = '111:222';
  await fresh.beat();
  assert(fresh.manager.status().heartbeat_at > beat0, 'تغيّر بصمة النتائج يرفع النبض');
  assert.strictEqual(fresh.manager.status().state, 'running', 'تغيّر النتائج يرفع نافذة التهيئة');

  const beat1 = fresh.manager.status().heartbeat_at;
  fresh.advance(jobs.HEARTBEAT_MS);
  await fresh.beat();
  assert(fresh.manager.status().heartbeat_at > beat1, 'نجاح probe وحده يرفع النبض');
  ok('النبض: مصدران فقط، وبثّ دوري لا يتجاوز 30 ثانية أثناء running');
}

async function testPeriodicScrub() {
  const env = makeEnv();
  await env.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  const afterStart = env.state.scrubs;
  assert(afterStart >= 2, 'تنقية عند البدء وعند انتقال الحالة');

  env.scrubTick();
  assert.strictEqual(env.state.scrubs, afterStart + 1, 'مؤقّت 60 ثانية ينقّي');

  const beforeTransition = env.state.scrubs;
  env.watcher().emit(progress('running'));
  assert(env.state.scrubs > beforeTransition, 'كل انتقال حالة ينقّي');

  const beforeFinish = env.state.scrubs;
  env.watcher().emit(progress('complete'));
  assert(env.state.scrubs > beforeFinish, 'الاكتمال ينقّي عند الانتقال فوراً');
  await flush();
  assert(env.state.scrubs >= beforeFinish + 2, 'وتنقية أخيرة بعد إغلاق الخادم');
  assert.strictEqual(env.state.timers.has(jobs.SCRUB_INTERVAL_MS), false, 'مؤقّت التنقية يتوقف بعد النهاية');
  ok('التنقية الدورية: عند البدء وكل 60 ثانية وكل انتقال وبعد الإغلاق');
}

async function testCancelAndQuitCleanup() {
  const env = makeEnv();
  await env.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  const scrubsBefore = env.state.scrubs;
  await env.manager.cancel();
  assert.strictEqual(env.manager.status().state, 'cancelled');
  assert.strictEqual(env.watcher().stopped, true, 'الإلغاء يوقف المراقب');
  assert.deepStrictEqual(env.state.closed, [4173], 'الإلغاء يغلق الخادم المملوك');
  assert(env.state.scrubs > scrubsBefore, 'الإلغاء ينقّي config');
  assert.strictEqual(env.state.timers.size, 0, 'الإلغاء يلغي كل المؤقّتات');
  assert.strictEqual(env.last().state, 'cancelled', 'الإلغاء يُبثّ');

  // خادم غير مملوك (أُعيد استخدامه) لا يُغلق من تحت صاحبه.
  const shared = makeEnv({ owned: false });
  await shared.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  await shared.manager.cancel();
  assert.deepStrictEqual(shared.state.closed, [], 'الخادم غير المملوك يبقى');

  // cleanupBeforeQuit يلغي النشطة ويغلق كل ما تملكه.
  const quit = makeEnv();
  await quit.manager.startJob({ cwd: CWD, kind: 'site', prompt: PROMPT });
  await quit.manager.cleanupBeforeQuit();
  assert.strictEqual(quit.manager.status().state, 'cancelled');
  assert.deepStrictEqual(quit.state.closed, [4620]);
  assert.strictEqual(quit.state.timers.size, 0);
  await quit.manager.cleanupBeforeQuit(); // تكرار آمن
  assert.deepStrictEqual(quit.state.closed, [4620], 'التنظيف المكرر لا يغلق مرتين');

  const idle = makeEnv();
  await idle.manager.cleanupBeforeQuit(); // بلا جولة إطلاقاً
  assert.deepStrictEqual(idle.manager.status(), { active: false });
  ok('cancel وcleanupBeforeQuit ينظّفان المراقب والخادم والمؤقّتات بلا تكرار');
}

async function testSnapshotIsSealed() {
  const env = makeEnv();
  await env.manager.startJob({ cwd: CWD, kind: 'site', prompt: PROMPT });
  env.watcher().emit(progress('running', { completed: 1, blocked: 1 }));
  const snap = env.manager.status();

  assert.deepStrictEqual(Object.keys(snap).sort(), [
    'failure_code', 'heartbeat_at', 'job_id', 'kind', 'port', 'schema_version',
    'started_at', 'state', 'summary', 'type', 'updated_at',
  ], 'حقول اللقطة قائمة سماح مغلقة');
  assert.deepStrictEqual(Object.keys(snap.summary).sort(), [...jobs.SUMMARY_FIELDS].sort(),
    'الملخّص ستة عدّادات فقط — لا testIds ولا complete');
  assert.strictEqual(snap.type, 'testsprite_job');
  assert.strictEqual(snap.schema_version, 1);
  assert(jobs.STATES.includes(snap.state));
  assert.strictEqual(typeof snap.port, 'number');
  assert.strictEqual(snap.summary.blocked, 1, 'blocked يعبر كعدّاد مستقل');

  const wire = JSON.stringify(snap);
  assert(!wire.includes(SECRET) && !wire.includes('sk-user-'), 'لا مفتاح في اللقطة');
  assert(!wire.includes(CWD) && !/[A-Za-z]:\\\\|\/satr-fake-project/.test(wire), 'لا مسار مطلق في اللقطة');
  assert(!wire.includes('سرّ المستخدم') && !wire.includes('اختبر'), 'لا برومبت في اللقطة');
  assert(!wire.includes('127.0.0.1') && !wire.includes('http'), 'لا URL كامل في اللقطة — المنفذ يكفي');
  assert(!wire.includes('TC101'), 'لا معرّفات حالات في اللقطة');

  // اللقطة نسخة: العبث بها لا يغيّر حالة المدير.
  snap.summary.passed = 99;
  snap.state = 'completed';
  assert.strictEqual(env.manager.status().summary.passed, 0);
  assert.strictEqual(env.manager.status().state, 'running');

  // كل حدث مبثوث يخضع للعقد نفسه.
  for (const event of env.state.events) {
    assert.strictEqual(event.type, 'testsprite_job');
    assert.strictEqual(event.schema_version, 1);
    assert.strictEqual(Object.keys(event).length, 11);
    const line = JSON.stringify(event);
    assert(!line.includes('sk-user-') && !line.includes(CWD) && !line.includes('http'), 'حدث مبثوث نظيف');
  }
  ok('اللقطة والحدث: قائمة حقول مغلقة بلا مفتاح أو مسار أو برومبت أو URL');
}

async function testNotifierContract() {
  const env = makeEnv();
  env.manager.setNotifier(null); // بلا مستهلك: لا انفجار
  await env.manager.startJob({ cwd: CWD, kind: 'app', prompt: PROMPT });
  assert.strictEqual(env.state.events.length, 0);
  assert.strictEqual(env.manager.status().state, 'awaiting_setup', 'الجولة تعمل بلا notifier');

  const received = [];
  env.manager.setNotifier((event) => { received.push(event); throw new Error('renderer_boom'); });
  env.watcher().emit(progress('running'));
  assert.strictEqual(received.length, 1, 'notifier يستقبل بعد الربط المتأخر');
  assert.strictEqual(env.manager.status().state, 'running', 'انفجار المستهلك لا يكسر الجولة');
  ok('setNotifier: ربط متأخر، وفشل المستهلك معزول');
}

async function main() {
  console.log('testspritejobs-test:');
  await testStartBothKinds();
  await testStartValidationAndBusy();
  await testAwaitingSetupThenRunning();
  await testStateTransitions();
  await testHeartbeatAndBroadcast();
  await testPeriodicScrub();
  await testCancelAndQuitCleanup();
  await testSnapshotIsSealed();
  await testNotifierContract();
  console.log('testspritejobs-test: ok — ' + checks + '/' + checks + ' (دورة الحياة والنبض والتنقية وعقد اللقطة)');
}

main().catch((error) => {
  console.error('testspritejobs-test: FAILED —', error && error.message);
  console.error(error);
  process.exit(1);
});
