#!/usr/bin/env node
'use strict';

// OBS-148: نشغّل استقبال الحدث ونشر الحالة من main.js نفسه، مع مطبّع SDK
// ودفتر المهام وباني لقطة الهاتف الإنتاجية. المحرك والنقل فقط بدائل محلية.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const { emitClaudeTasks } = require('../electron/agent');
const tasks = require('../electron/tasks');
const mobilestate = require('../electron/mobilestate');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadRuntime(root) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, 'تعذّر استخراج منطق الإنتاج: ' + start);
    return source.slice(from, to);
  }
  const runs = [];
  const frames = [];
  const rendered = [];
  const dropped = [];
  const handlers = {};
  const sandbox = {
    fs, os, path, randomBytes, console,
    // المؤقتان مجرد سقفي إقلاع/إيقاف؛ السيناريو يحسم كليهما بلا ساعة حقيقية.
    setTimeout: () => ({ unref() {} }),
    STOP_ALL_SEND_TIMEOUT_MS: 5000, SDK_START_TIMEOUT_MS: 90000,
    runSeq: 0, currentRun: null, currentCliRun: null, lastEngine: '',
    activeConversationRunId: null,
    sdkSessionControlBusy: false, sdkRunInFlight: false,
    sdkStartingPromise: null, sdkStoppingPromise: null,
    sendRequestBusy: false, sendRequestEpoch: 0,
    sdkBackgroundRuns: new Set(), sdkTaskOwners: new Map(),
    mobileControlEnabled: true,
    mobileHandle: { publishState(state) { frames.push(plain(state)); return true; } },
    mobilestate,
    tasks: { ...tasks, apply: (update) => tasks.apply(update, { root }) },
    ipcMain: { handle(name, callback) { handlers[name] = callback; } },
    eventTrace: { emitted() {}, dropped(...args) { dropped.push(args); } },
    emitToWindow: (event, engine) => rendered.push({ event: plain(event), engine }),
    preview: { endHandoff() {}, clearSensitiveState() {} },
    promocapture: { stopAll: async () => {} },
    withdrawMobilePermissions() {}, notifyObservers() {}, noteShadowOverride() {},
    browserBudgetFor: () => ({}), browserBudgets: new Map(),
    trustedBrowserOrigins: new Set(),
    checkpoints: { begin() {}, bindSession() {}, consumeVerification: () => '', finish: () => null },
    sanitizeImages: () => [], sanitizeSkills: () => [], sanitizeExtraDirs: () => [],
    sanitizeClaudeFallbackModel: () => null,
    PERMISSION_MODES: new Set(['default']), EFFORT_LEVELS: new Set(),
    kimi: { ENGINE_ID: 'kimi-code' }, adapters: { get: () => null },
    nonSdkPerm: (mode) => mode,
    exported: {},
    agent: {
      async start(input, cwd, emit) {
        const run = {
          input, cwd, emit, stopped: false,
          hasSdkBackgroundTasks: () => true,
          ownsSdkTask: () => true,
          stop() { run.stopped = true; },
        };
        runs.push(run);
        return run;
      },
    },
  };
  sandbox.kimi.start = sandbox.agent.start;
  // هذه الدوال كلها نص الإنتاج بلا تبديل الشروط أو إعادة كتابة باعث الحدث.
  const code = [
    section('const SAFE_SESSION =', 'const MOBILE_PERMISSION_TTL_MS ='),
    section('const mobileStateBoot =', 'const SAFE_SKILL ='),
    section('function hasLiveMobileSession()', 'const mobileStateHeartbeat ='),
    section('function stopAll(', 'function notifyObservers('),
    section('function forgetSdkBackgroundRun(', 'const rewindPreviews ='),
    section('function markSdkRunInFlight(', 'function cancelPendingSendRequest('),
    section('async function handleSendRequest(', "ipcMain.handle('satr:stop',"),
    'exported.requestState = handleMobileStateRequest;',
  ].join('\n');
  vm.runInNewContext(code, sandbox, { filename: 'main-mobile-task-owner-extract.js' });

  async function start(cwd, sessionId, engine = 'sdk') {
    const reply = await handlers['satr:send']({}, { prompt: 'اختبار ملكية المهمة', engine, cwd, sessionId });
    assert.deepEqual(plain(reply), { started: true, engine });
    const run = runs.at(-1);
    const titles = new Map();
    const statuses = new Map();
    const creates = new Map();
    const started = new Set();
    run.message = (message) => emitClaudeTasks(
      { session_id: sessionId, ...message }, run.emit, titles, statuses, creates, started,
    );
    return run;
  }
  return { start, frames, rendered, dropped, sandbox, requestState: sandbox.exported.requestState };
}

async function scenario(root, name, sameProject, sameSession, anonymous = false, clearLedger = true, phoneOffline = false) {
  const runtime = loadRuntime(path.join(root, 'ledger-' + name));
  const projectA = path.join(root, 'project-a');
  const projectB = sameProject ? projectA : path.join(root, 'project-b');
  const sessionA = anonymous ? undefined : 'session-a';
  const sessionB = anonymous ? undefined : sameSession ? sessionA : 'session-b';
  const a = await runtime.start(projectA, sessionA);
  const update = (run, id, title, status = 'in_progress') => {
    if (anonymous) {
      run.emit({ type: 'task_update', schema_version: 1, source: 'claude_agent', mode: 'merge',
        tasks: [{ id, title, status }] });
    } else {
      run.message({ type: 'system', subtype: 'task_started', task_id: id, description: title });
      if (status !== 'in_progress') {
        run.message({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status } });
      }
    }
  };
  update(a, 'taska001', 'مهمة التشغيل الأول');
  const firstRun = runtime.frames.at(-1).run;
  a.emit({ type: 'result', total_cost_usd: 0.25 });
  assert.ok(runtime.sandbox.sdkBackgroundRuns.has(a), 'لم ينفصل A عبر result الإنتاجية');
  update(a, 'taska001', 'خلفية مشروعة قبل الدور التالي');
  assert.equal(runtime.frames.at(-1).task, 'خلفية مشروعة قبل الدور التالي');

  const b = await runtime.start(projectB, sessionB);
  assert.notEqual(runtime.frames.at(-1).run, firstRun, 'يجب تجديد هوية التشغيل في المشروع نفسه');
  // خطة B الصريحة تستبدل دفتر الجلسة السابق، ثم تحديثاتها اللاحقة جزئية.
  if (clearLedger) b.emit({ type: 'task_update', schema_version: 1, session_id: sessionB,
    source: 'claude_todo', mode: 'replace', tasks: [] });
  update(b, 'taskb001', 'مهمة التشغيل الحالي');
  if (!anonymous) update(b, 'taskb002', 'مهمة حالية مكتملة', 'completed');
  const before = runtime.frames.at(-1);
  const frameCount = runtime.frames.length;
  assert.equal(before.project, path.basename(projectB));
  assert.equal(before.task, 'مهمة التشغيل الحالي');
  assert.equal(before.tasks.total, anonymous ? 1 : 2);

  if (phoneOffline) runtime.sandbox.mobileControlEnabled = false;
  update(a, 'taska001', 'تحديث متأخر من التشغيل الأول');
  assert.deepEqual(runtime.frames.at(-1), before,
    'OBS-148 ' + name + ': late A changed the published B state');
  assert.equal(runtime.frames.length, frameCount, 'لا ينشر A القديم حتى لقطة إضافية');
  runtime.sandbox.mobileControlEnabled = true;
  runtime.requestState();
  assert.deepEqual({ ...runtime.frames.at(-1), seq: before.seq }, before,
    'تغير الأصل الداخلي وإن لم تُرسل لقطة فوراً');

  if (!anonymous) {
    const oldLedger = tasks.load('sdk', sessionA, { root: path.join(root, 'ledger-' + name) });
    assert.equal(oldLedger.tasks.find((task) => task.id === 'taska001').title,
      'تحديث متأخر من التشغيل الأول', 'فُقد حفظ تحديث الخلفية المشروع');
    assert.ok(runtime.rendered.some(({ event, engine }) => engine === 'sdk'
      && event.session_id === sessionA && event.tasks.some((task) => task.title === 'تحديث متأخر من التشغيل الأول')),
    'فُقد إرسال دفتر الخلفية إلى مساره المكتبي');
  }

  update(b, 'taskb001', 'تحديث صحيح من التشغيل الحالي');
  const after = runtime.frames.at(-1);
  assert.equal(after.run, before.run);
  assert.equal(after.project, before.project);
  assert.equal(after.task, 'تحديث صحيح من التشغيل الحالي',
    'OBS-148 ' + name + ': B update reimported the stale shared ledger');
  assert.deepEqual(after.tasks, before.tasks, 'عدادات B تغيرت بسبب دفتر A المشترك');

  b.emit({ type: 'task_update', schema_version: 1, session_id: sessionB,
    source: 'claude_todo', mode: 'replace',
    tasks: [{ id: 'replacement', title: 'الخطة البديلة الحالية', status: 'in_progress' }] });
  assert.equal(runtime.frames.at(-1).task, 'الخطة البديلة الحالية');
  assert.deepEqual(runtime.frames.at(-1).tasks,
    { total: 1, pending: 0, in_progress: 1, completed: 0, blocked: 0 },
    'replace لم يحذف مهام B السابقة');

  // إشعارات الخلفية المنقاة وتوجيه مالكها يظلان يعملان بعد انتقال الدور.
  a.emit({ type: 'sdk_task_started', taskId: 'taska001', toolUseId: 'toolu_' + 'A'.repeat(20) });
  assert.equal(runtime.sandbox.sdkTaskOwners.get('taska001'), a);
  a.emit({ type: 'sdk_task_notification', taskId: 'taska001', status: 'completed' });
  assert.equal(runtime.sandbox.sdkTaskOwners.has('taska001'), false);
  assert.equal(runtime.rendered.at(-1).event.type, 'sdk_task_notification');
  const saved = runtime.frames.at(-1);
  a.emit({ type: 'proc_done' });
  assert.deepEqual(runtime.frames.at(-1), saved, 'إنهاء A القديم غيّر حالة B');
  assert.ok(runtime.dropped.some((args) => args[2] === 'stale_token'));
  assert.equal(a.stopped, false, 'بدء B أوقف خلفية A');
}

async function testMobileTaskOwnership() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-obs148-'));
  try {
    fs.mkdirSync(path.join(root, 'project-a'));
    fs.mkdirSync(path.join(root, 'project-b'));
    const failures = [];
    for (const args of [
      ['different-projects', false, false],
      ['same-project', true, false],
      ['same-session', true, true],
      ['same-session-merge-first', true, true, false, false],
      ['phone-offline', true, true, false, true, true],
      ['no-session', true, true, true],
    ]) {
      try {
        await scenario(root, ...args);
        console.log('mobile-task-owner: ok ' + args[0]);
      } catch (error) {
        failures.push(error);
        console.error(error.stack);
      }
    }
    // بقية المحركات تظل تعرض الدفتر المقبول، بما فيه حجب خطة Kimi التلقائية.
    const kimiRoot = path.join(root, 'ledger-kimi');
    tasks.apply({ schema_version: 1, engine: 'kimi-code', session_id: 'kimi-session',
      source: 'adapter_tool', mode: 'replace',
      tasks: [{ id: 'explicit', title: 'الخطة الصريحة المحفوظة', status: 'in_progress' }] },
    { root: kimiRoot });
    const runtime = loadRuntime(kimiRoot);
    const kimi = await runtime.start(path.join(root, 'project-a'), 'kimi-session', 'kimi-code');
    kimi.emit({ type: 'task_update', schema_version: 1, source: 'kimi_plan', mode: 'replace',
      tasks: [{ id: 'automatic', title: 'الخطة التلقائية المحجوبة', status: 'in_progress' }] });
    assert.equal(runtime.frames.at(-1).task, 'الخطة الصريحة المحفوظة');
    assert.equal(runtime.frames.at(-1).tasks.total, 1);
    console.log('mobile-task-owner: ok other-engine-accepted-ledger');
    assert.equal(failures.length, 0, 'OBS-148: ' + failures.length + ' ownership scenarios failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { testMobileTaskOwnership };
if (require.main === module) {
  testMobileTaskOwnership().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
