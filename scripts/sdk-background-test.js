#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const TOOL_USE_ID = 'toolu_' + 'A1b2C3d4E5f6G7h8J9k0Lm2N';
const TASK_ID = 'ab12cd34e';
const UNKNOWN_TASK_ID = '000000000';
const SECRET_SENTINEL = 'sk-proj-' + 'A'.repeat(32);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function taskMessage(status = 'completed', overrides = {}) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status,
    output_file: `C:\\internal\\${SECRET_SENTINEL}.txt`,
    summary: '  اكتملت\u202e\n المهمة  ',
    usage: { total_tokens: 9, tool_uses: 1, duration_ms: 20 },
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

async function testAgentController() {
  const {
    createSdkBackgroundController,
    emitClaudeTasks,
    sdkTaskNotificationEvent,
    sdkTaskStartedEvent,
    SAFE_SDK_TOOL_USE_ID,
    SAFE_SDK_TASK_ID,
  } = require('../electron/agent');
  assert.match(TOOL_USE_ID, SAFE_SDK_TOOL_USE_ID);
  assert.match(TASK_ID, SAFE_SDK_TASK_ID);

  const calls = { background: [], stop: [] };
  const events = [];
  let closes = 0;
  const controller = createSdkBackgroundController({
    query: {
      async backgroundTasks(id) { calls.background.push(id); return true; },
      async stopTask(id) { calls.stop.push(id); },
    },
    emit: (event) => events.push(event),
    closeInput: () => { closes++; },
    isolated: false,
  });
  controller.observe({ type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID });
  assert.deepEqual(plain(await controller.moveToBackground(TOOL_USE_ID)), { ok: true, taskId: TASK_ID });
  assert.deepEqual(calls.background, [TOOL_USE_ID]);
  controller.markResult();
  assert.equal(closes, 0, 'أُغلق Query قبل task_notification');
  assert.equal(controller.pendingCount(), 1);
  assert.deepEqual(plain(await controller.stopSdkTask(TASK_ID)), { ok: true });
  assert.deepEqual(calls.stop, [TASK_ID]);

  controller.observe(taskMessage());
  assert.equal(controller.pendingCount(), 0);
  assert.equal(closes, 1, 'لم يُغلق Query بعد حسم آخر مهمة خلفية');
  assert.deepEqual(plain(events), [{
    type: 'sdk_task_notification',
    taskId: TASK_ID,
    toolUseId: TOOL_USE_ID,
    status: 'completed',
    summary: 'اكتملت المهمة',
  }]);
  assert.ok(!JSON.stringify(events).includes(SECRET_SENTINEL), 'تسرّب output_file أو سر إلى الحدث');
  controller.finish();
  assert.equal((await controller.moveToBackground(TOOL_USE_ID)).error, 'no_active_turn');
  assert.equal((await controller.stopSdkTask(TASK_ID)).error, 'no_active_turn');

  const invalidCalls = [];
  const invalid = createSdkBackgroundController({
    query: {
      async backgroundTasks(id) { invalidCalls.push(id); return true; },
      async stopTask(id) { invalidCalls.push(id); },
    },
    emit: () => {}, closeInput: () => {}, isolated: false,
  });
  assert.equal((await invalid.moveToBackground('toolu_bad')).error, 'bad_id');
  assert.equal((await invalid.stopSdkTask('task_bad')).error, 'bad_id');
  assert.equal((await invalid.stopSdkTask(UNKNOWN_TASK_ID)).error, 'not_found');
  assert.deepEqual(invalidCalls, [], 'وصل معرّف مرفوض إلى SDK');

  const isolatedCalls = [];
  const isolated = createSdkBackgroundController({
    query: {
      async backgroundTasks(id) { isolatedCalls.push(id); return true; },
      async stopTask(id) { isolatedCalls.push(id); },
    },
    emit: () => {}, closeInput: () => {}, isolated: true,
  });
  assert.equal((await isolated.moveToBackground(TOOL_USE_ID)).error, 'unsupported');
  assert.equal((await isolated.stopSdkTask(TASK_ID)).error, 'unsupported');
  assert.deepEqual(isolatedCalls, [], 'وصل تحكم الخلفية إلى سياق معزول');

  const oldCli = createSdkBackgroundController({ query: {}, emit: () => {}, closeInput: () => {}, isolated: false });
  assert.equal((await oldCli.moveToBackground(TOOL_USE_ID)).error, 'unsupported');
  assert.equal((await oldCli.stopSdkTask(TASK_ID)).error, 'not_found');

  const partialCli = createSdkBackgroundController({
    query: { async backgroundTasks() { return true; } },
    emit: () => {}, closeInput: () => {}, isolated: false,
  });
  partialCli.observe({ type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID });
  assert.equal((await partialCli.moveToBackground(TOOL_USE_ID)).ok, true);
  assert.equal((await partialCli.stopSdkTask(TASK_ID)).error, 'unsupported');

  const throwing = createSdkBackgroundController({
    query: { async backgroundTasks() { throw new Error(SECRET_SENTINEL); } },
    emit: () => {}, closeInput: () => {}, isolated: false,
  });
  const thrown = await throwing.moveToBackground(TOOL_USE_ID);
  assert.equal(thrown.error, 'unsupported');
  assert.ok(!JSON.stringify(thrown).includes(SECRET_SENTINEL), 'تسرّب خطأ SDK الخام');

  let releaseBackground;
  let raceCloses = 0;
  const race = createSdkBackgroundController({
    query: { backgroundTasks: () => new Promise((resolve) => { releaseBackground = resolve; }) },
    emit: () => {}, closeInput: () => { raceCloses++; }, isolated: false,
  });
  const moving = race.moveToBackground(TOOL_USE_ID);
  race.markResult();
  assert.equal(raceCloses, 0, 'لم يحجز المتحكم Query أثناء control request');
  releaseBackground(false);
  assert.equal((await moving).error, 'not_found');
  assert.equal(raceCloses, 1, 'لم يُغلق Query بعد فشل النقل وعدم وجود مهمة معلقة');

  let releaseEarly;
  let earlyCalls = 0;
  let earlyCloses = 0;
  const earlyEvents = [];
  const early = createSdkBackgroundController({
    query: {
      backgroundTasks() {
        earlyCalls++;
        return new Promise((resolve) => { releaseEarly = resolve; });
      },
      async stopTask() {},
    },
    emit: (event) => earlyEvents.push(event),
    closeInput: () => { earlyCloses++; }, isolated: false,
  });
  early.observe({ type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID });
  const earlyMove = early.moveToBackground(TOOL_USE_ID);
  const duplicateMove = early.moveToBackground(TOOL_USE_ID);
  early.observe(taskMessage());
  early.markResult();
  assert.equal(earlyEvents.length, 0, 'بُث إشعار مبكر قبل إثبات نجاح النقل');
  assert.equal(earlyCloses, 0, 'أُغلق Query أثناء طلب نقل ذي إشعار مبكر');
  releaseEarly(true);
  assert.deepEqual(plain(await earlyMove), { ok: true, taskId: TASK_ID });
  assert.deepEqual(plain(await duplicateMove), { ok: true, taskId: TASK_ID });
  assert.equal(earlyCalls, 1, 'وصل طلب النقل المكرر مرتين إلى SDK');
  assert.equal(earlyEvents.length, 1, 'فُقد task_notification السابق لحسم التحكم');
  assert.equal(earlyEvents[0].status, 'completed');
  assert.equal(earlyCloses, 1, 'لم يُغلق Query بعد حسم الإشعار المبكر');

  const stoppedEvents = [];
  const stopped = createSdkBackgroundController({
    query: { async backgroundTasks() { return true; }, async stopTask() {} },
    emit: (event) => stoppedEvents.push(event), closeInput: () => {}, isolated: false,
  });
  stopped.observe({
    type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    description: 'بناء المشروع', session_id: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal((await stopped.moveToBackground(TOOL_USE_ID)).ok, true);
  stopped.finish('stopped');
  assert.equal(stoppedEvents.length, 2, 'لم تُحسم البطاقة وTask Ledger عند إيقاف الدور');
  assert.equal(stoppedEvents[0].status, 'stopped');
  assert.equal(stoppedEvents[1].type, 'task_update');
  assert.equal(stoppedEvents[1].tasks[0].status, 'blocked');
  assert.equal(stoppedEvents[1].tasks[0].title, 'بناء المشروع');
  assert.equal(stopped.ownsSdkTask(TASK_ID), false);

  const orphanEvents = [];
  const orphan = createSdkBackgroundController({
    query: { async backgroundTasks() { return true; } },
    emit: (event) => orphanEvents.push(event), closeInput: () => {}, isolated: false,
  });
  assert.deepEqual(plain(await orphan.moveToBackground(TOOL_USE_ID)), { ok: true });
  orphan.markResult();
  assert.equal(orphan.hasSdkBackgroundTasks(), true);
  orphan.finish('failed');
  assert.deepEqual(plain(orphanEvents), [{
    type: 'sdk_task_notification', toolUseId: TOOL_USE_ID, status: 'failed',
    summary: 'انتهى تشغيل Claude قبل وصول إشعار المهمة الخلفية.',
  }], 'لم تُحسم بطاقة النقل التي انتهت قبل وصول taskId');
  assert.equal(orphan.hasSdkBackgroundTasks(), false);

  const lateMappingEvents = [];
  const lateMappingCalls = [];
  const lateMapping = createSdkBackgroundController({
    query: {
      async backgroundTasks(id) { lateMappingCalls.push(['move', id]); return true; },
      async stopTask(id) { lateMappingCalls.push(['stop', id]); },
    },
    emit: (event) => lateMappingEvents.push(event), closeInput: () => {}, isolated: false,
  });
  assert.deepEqual(plain(await lateMapping.moveToBackground(TOOL_USE_ID)), { ok: true });
  lateMapping.observe({ type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID });
  assert.deepEqual(plain(lateMappingEvents), [{ type: 'sdk_task_started', toolUseId: TOOL_USE_ID, taskId: TASK_ID }]);
  assert.equal(lateMapping.ownsSdkTask(TASK_ID), true);
  assert.deepEqual(plain(await lateMapping.stopSdkTask(TASK_ID)), { ok: true });
  assert.deepEqual(lateMappingCalls, [['move', TOOL_USE_ID], ['stop', TASK_ID]]);

  const direct = sdkTaskNotificationEvent(taskMessage(), TOOL_USE_ID);
  assert.deepEqual(Object.keys(direct).sort(), ['status', 'summary', 'taskId', 'toolUseId', 'type']);
  assert.equal(direct.summary, 'اكتملت المهمة');
  assert.equal(sdkTaskNotificationEvent(taskMessage('failed')).status, 'failed');
  assert.equal(sdkTaskNotificationEvent(taskMessage('stopped')).status, 'stopped');
  assert.equal(sdkTaskNotificationEvent(taskMessage('running')), null);
  assert.equal(sdkTaskNotificationEvent(taskMessage('completed', { task_id: 'bad' })), null);
  assert.equal(sdkTaskNotificationEvent(taskMessage('completed', {
    tool_use_id: 'toolu_' + 'Z'.repeat(24),
  }), TOOL_USE_ID), null, 'قُبل إشعار بمعرّف أداة متعارض');
  const secretEvent = sdkTaskNotificationEvent(taskMessage('completed', { summary: SECRET_SENTINEL }));
  assert.deepEqual(Object.keys(secretEvent).sort(), ['status', 'taskId', 'toolUseId', 'type']);
  assert.ok(!JSON.stringify(secretEvent).includes(SECRET_SENTINEL));
  const longEvent = sdkTaskNotificationEvent(taskMessage('completed', { summary: 'أ'.repeat(400) }));
  assert.equal(Array.from(longEvent.summary).length, 300, 'لم يُطبّق سقف summary الموثق');
  const controlEvent = sdkTaskNotificationEvent(taskMessage('completed', { summary: 'أ\u0000ب\u2066ج' }));
  assert.equal(controlEvent.summary, 'أ ب ج', 'لم تُنظف محارف التحكم/Bidi من summary');
  assert.deepEqual(plain(sdkTaskStartedEvent(TOOL_USE_ID, TASK_ID)), {
    type: 'sdk_task_started', toolUseId: TOOL_USE_ID, taskId: TASK_ID,
  });
  assert.equal(sdkTaskStartedEvent('toolu_bad', TASK_ID), null);

  const ledgerEvents = [];
  const taskTitles = new Map();
  const taskStatuses = new Map();
  const pendingCreates = new Map();
  const startedTaskIds = new Set();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const emitTask = (message) => emitClaudeTasks(
    { session_id: sessionId, task_id: TASK_ID, ...message },
    (event) => ledgerEvents.push(event), taskTitles, taskStatuses, pendingCreates, startedTaskIds,
  );
  emitTask({ type: 'system', subtype: 'task_started', description: '  بناء\u202e\n المشروع  ', subagent_type: 'Claude\u2066' });
  emitTask({ type: 'system', subtype: 'task_progress', description: SECRET_SENTINEL, summary: SECRET_SENTINEL });
  emitTask({ type: 'system', subtype: 'task_updated', patch: {
    description: SECRET_SENTINEL, error: SECRET_SENTINEL, status: 'failed',
  } });
  emitTask({ type: 'system', subtype: 'task_notification', summary: SECRET_SENTINEL, status: 'stopped' });
  assert.equal(ledgerEvents.length, 4);
  assert.equal(ledgerEvents[0].tasks[0].title, 'بناء المشروع');
  assert.equal(ledgerEvents[0].tasks[0].owner, 'Claude');
  assert.deepEqual(plain(ledgerEvents.slice(1).map((event) => event.tasks[0].evidence)), [[], [], []]);
  assert.ok(!JSON.stringify(ledgerEvents).includes(SECRET_SENTINEL), 'تسرّب نص lifecycle إلى Task Ledger');

  const resumedEvents = [];
  const resumedTitles = new Map();
  const resumedStatuses = new Map();
  const resumedStarts = new Set();
  const emitResumed = (message) => emitClaudeTasks(
    { session_id: sessionId, task_id: TASK_ID, ...message },
    (event) => resumedEvents.push(event), resumedTitles, resumedStatuses, new Map(), resumedStarts,
  );
  emitResumed({ type: 'system', subtype: 'task_updated', patch: { description: 'تحديث قديم' } });
  emitResumed({ type: 'system', subtype: 'task_notification', status: 'stopped', summary: 'إشعار كاذب' });
  assert.equal(resumedEvents.length, 1, 'طُبق task_notification بلا task_started في Query نفسها');

  const agentSource = read('electron/agent.js');
  assert.match(agentSource, /subtype === 'task_notification'[\s\S]*?send\('merge', 'claude_agent'/);
  assert.match(agentSource, /function safeSdkTaskText\([\s\S]*?memory\.hasSecret\(text\)/);
  assert.match(agentSource, /rawPrivateLifecycle[\s\S]*?!rawPrivateLifecycle/);
  assert.match(agentSource, /if \(!startedTaskIds\.has\(id\)\) return/);
  assert.match(agentSource, /status === 'failed'[\s\S]*?status === 'stopped'\) return 'blocked'/);
  assert.match(agentSource, /isolated: !!internalPolicy/);
  const controllerSlice = agentSource.slice(
    agentSource.indexOf('function createSdkBackgroundController('),
    agentSource.indexOf('function emitClaudeTasks('),
  );
  assert.doesNotMatch(controllerSlice, /bgprocs|termjobs|keepalive|startJob|markBefore|markAfter/);
}

function loadMainHandlers() {
  const source = read('electron/main.js');
  const cleanStart = source.indexOf('function cleanClaudePublicText(');
  const cleanEnd = source.indexOf('function sanitizeClaudeModelsResult(', cleanStart);
  const start = source.indexOf('// ---------- مهام Claude SDK الخلفية (الدفعة D) ----------');
  const end = source.indexOf('// ---------- الطرفية العربية المدمجة', start);
  assert.ok(cleanStart >= 0 && cleanEnd > cleanStart && start >= 0 && end > start, 'تعذّر استخراج IPC الدفعة D');
  const sandbox = {
    ipcMain: { handle(channel, handler) { sandbox.handlers[channel] = handler; } },
    handlers: {},
    memory: require('../electron/memory'),
    exported: {},
  };
  vm.runInNewContext(`
    ${source.slice(cleanStart, cleanEnd)}
    let currentRun = null;
    let lastEngine = '';
    const sdkTaskOwners = new Map();
    ${source.slice(start, end)}
    exported.setState = (engine, run) => { lastEngine = engine; currentRun = run; };
    exported.clearOwners = () => sdkTaskOwners.clear();
  `, sandbox, { filename: 'main-sdk-background-extract.js' });
  return { ...sandbox, source: source.slice(start, end) };
}

async function testMainIpc() {
  const sandbox = loadMainHandlers();
  const background = (payload) => sandbox.handlers['satr:backgroundTask']({}, payload);
  const stop = (payload) => sandbox.handlers['satr:stopSdkTask']({}, payload);
  assert.equal(typeof background, 'function');
  assert.equal(typeof stop, 'function');

  for (const payload of [null, [], {}, { toolUseId: TOOL_USE_ID, extra: true }, { toolUseId: 'toolu_bad' }]) {
    assert.deepEqual(plain(await background(payload)), { ok: false, error: 'bad_input' });
  }
  for (const payload of [null, [], {}, { taskId: TASK_ID, extra: true }, { taskId: 'task_bad' }]) {
    assert.deepEqual(plain(await stop(payload)), { ok: false, error: 'bad_input' });
  }

  const calls = [];
  const run = {
    async moveToBackground(id) { calls.push(['move', id]); return { ok: true, taskId: TASK_ID, token: SECRET_SENTINEL }; },
    async stopSdkTask(id) { calls.push(['stop', id]); return { ok: true, output_file: SECRET_SENTINEL }; },
    ownsSdkTask(id) { return id === TASK_ID; },
  };
  sandbox.exported.setState('codex', run);
  assert.deepEqual(plain(await background({ toolUseId: TOOL_USE_ID })), { ok: false, error: 'unsupported' });
  assert.deepEqual(plain(await stop({ taskId: TASK_ID })), { ok: false, error: 'unsupported' });
  assert.deepEqual(calls, []);

  sandbox.exported.setState('sdk', null);
  assert.deepEqual(plain(await background({ toolUseId: TOOL_USE_ID })), { ok: false, error: 'no_active_turn' });
  assert.deepEqual(plain(await stop({ taskId: TASK_ID })), { ok: false, error: 'no_active_turn' });

  sandbox.exported.setState('sdk', run);
  assert.deepEqual(plain(await background({ toolUseId: TOOL_USE_ID })), { ok: true, taskId: TASK_ID });
  assert.deepEqual(plain(await stop({ taskId: TASK_ID })), { ok: true });
  sandbox.exported.setState('codex', null);
  assert.deepEqual(plain(await stop({ taskId: TASK_ID })), { ok: true }, 'لم يصل الإيقاف إلى مالك SDK بعد انتقال المحرك');
  assert.deepEqual(calls, [['move', TOOL_USE_ID], ['stop', TASK_ID], ['stop', TASK_ID]]);
  sandbox.exported.clearOwners();

  sandbox.exported.setState('sdk', {
    async moveToBackground() { return { ok: false, error: 'not_found', message: `  ${SECRET_SENTINEL}\n ` }; },
    async stopSdkTask() { return { ok: false, error: 'not_found', message: '  لم تعد\u202e\n موجودة  ' }; },
  });
  const secretReply = plain(await background({ toolUseId: TOOL_USE_ID }));
  assert.deepEqual(secretReply, { ok: false, error: 'not_found' });
  assert.ok(!JSON.stringify(secretReply).includes(SECRET_SENTINEL));
  assert.deepEqual(plain(await stop({ taskId: TASK_ID })), {
    ok: false, error: 'not_found', message: 'لم تعد موجودة',
  });

  const executableIpc = sandbox.source.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executableIpc, /bgprocs|termjobs|kimi\.keepalive|emitBgProcsMerged|bg_term|bg_procs/);
}

function testUiAndSeparationContracts() {
  const app = read('src/ui/app.js');
  const chat = read('src/ui/components/chat.js');
  const css = read('src/styles/base.css');
  const preload = read('electron/preload.js');
  const main = read('electron/main.js');
  const probe = read('scripts/sdk-background-probe.js');
  const pkg = JSON.parse(read('package.json'));
  const fullSuite = read('scripts/full-suite.js');
  const docs = read('CLAUDE.md');

  assert.match(preload, /backgroundTask: \(toolUseId\) => ipcRenderer\.invoke\('satr:backgroundTask', \{ toolUseId \}\)/);
  assert.match(preload, /stopSdkTask: \(taskId\) => ipcRenderer\.invoke\('satr:stopSdkTask', \{ taskId \}\)/);
  assert.match(main, /ipcMain\.handle\('satr:backgroundTask'/);
  assert.match(main, /ipcMain\.handle\('satr:stopSdkTask'/);
  assert.match(main, /const sdkBackgroundRuns = new Set\(\)/);
  assert.match(main, /const sdkTaskOwners = new Map\(\)/);
  assert.match(main, /lateSdkBackgroundEvent/);
  assert.match(main, /obj\.type === 'sdk_task_started'/);
  assert.match(main, /await stopAll\(false\)/);
  assert.match(chat, /const SDK_BACKGROUND_DELAY_MS = 15000/);
  assert.match(chat, /⏳ انقله للخلفية/);
  assert.match(chat, /يعمل في الخلفية/);
  assert.match(chat, /sdk-stop-task-request/);
  assert.match(chat, /function updateSdkTask\(event\)/);
  assert.match(chat, /function bindSdkTask\(toolUseId, taskId\)/);
  assert.match(chat, /function hasSdkBackgroundTasks\(\)/);
  assert.match(chat, /clearSdkToolRegistry\(\)/);
  assert.match(app, /window\.satr\.backgroundTask\(toolUseId\)/);
  assert.match(app, /window\.satr\.stopSdkTask\(taskId\)/);
  assert.match(app, /block\.addTool\(c\.id, c\.name, c\.input, ev\.parent_tool_use_id, runningEngine === 'sdk'\)/);
  assert.match(app, /if \(completedEngine === 'sdk'\) releaseRunControls\(\)/);
  assert.match(app, /if \(block\.resultHandled\) return;[\s\S]*?block\.resultHandled = true/);
  assert.match(app, /function releaseRunControls\(\)[\s\S]*?function endRun\(\)/);
  assert.match(app, /function hasSdkBackgroundSessionLock\(\)/);
  assert.match(app, /session-resume[\s\S]*?hasSdkBackgroundSessionLock\(\)/);
  assert.match(app, /ev\.engine !== \$\('engine'\)\.value \|\| !sessionId \|\| ev\.session_id !== sessionId/);
  assert.match(app, /أوقف مهمة Claude الخلفية أو انتظر اكتمالها قبل مسح هذه الجلسة/);
  const mappingIndex = app.indexOf("if (ev.type === 'sdk_task_started')");
  const notificationIndex = app.indexOf("if (ev.type === 'sdk_task_notification')");
  assert.ok(mappingIndex >= 0 && mappingIndex < notificationIndex, 'حدث mapping لا يسبق الإشعار النهائي');
  const blockGuardIndex = app.indexOf('const block = currentBlock;', notificationIndex);
  assert.ok(notificationIndex >= 0 && blockGuardIndex > notificationIndex, 'حدث المهمة المتأخر يقع بعد حارس الكتلة');
  assert.match(css, /\.sdk-background-move, \.sdk-task-stop/);
  assert.doesNotMatch(chat.slice(chat.indexOf('// الدفعة D:'), chat.indexOf('// ما يلي منقول')), /style\s*=/i);

  const appControlSlice = app.slice(
    app.indexOf('// الدفعة D: تحكم بطاقات SDK محلياً'),
    app.indexOf("chatEl.addEventListener('checkpoint-verify'"),
  );
  assert.doesNotMatch(appControlSlice, /composerEl|setBgProcs|upsertTermJob|termStart|killBgProc/);
  for (const relativePath of [
    'electron/termjobs.js', 'electron/bgprocs.js', 'electron/execguard.js',
    'electron/kimi-keepalive.js', 'src/ui/components/composer.js',
  ]) {
    assert.doesNotMatch(read(relativePath), /satr:backgroundTask|satr:stopSdkTask|sdk_task_started|sdk_task_notification/,
      `تداخل عقد SDK مع ${relativePath}`);
  }

  assert.match(probe, /query\.backgroundTasks\(trace\.toolUseId\)/);
  assert.match(probe, /message\.subtype === 'task_started'/);
  assert.match(probe, /query\.stopTask\(trace\.taskId\)/);
  assert.match(probe, /invalidWhileActive/);
  assert.match(probe, /ended/);
  assert.match(probe, /configuredDelaysMs/);
  assert.doesNotMatch(probe, /console\.log\([^\n]*(output_file|summary|toolInput)/);

  assert.equal(pkg.scripts['test:sdk-background'], 'node scripts/sdk-background-test.js');
  assert.match(fullSuite, /'test:elicitation',\s*\r?\n\s*'test:sdk-background',/);
  assert.match(docs, /### مهام Claude SDK الخلفية \(دفعة D/);
  assert.ok(docs.includes("{type:'sdk_task_notification',taskId?,toolUseId,status:'completed'|'failed'|'stopped',summary?}"));
  assert.ok(docs.includes('13557ms') && docs.includes('run_in_terminal'));
}

(async () => {
  await testAgentController();
  await testMainIpc();
  testUiAndSeparationContracts();
  console.log('sdk-background-test: ok — التحكم وIPC والحدث والواجهة والعزل وفصل السجلات');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});