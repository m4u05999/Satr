#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const conversations = require('../electron/conversations');
const bridgeModule = require('../electron/conversation-bridge');
const sourceFlag = process.argv.indexOf('--source');
const sourceFile = sourceFlag >= 0 ? process.argv[sourceFlag + 1] : path.join(__dirname, '../electron/main.js');
assert.ok(sourceFile, 'يلزم مسار بعد --source');
const source = fs.readFileSync(sourceFile, 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'تعذّر استخراج منطق الإنتاج: ' + start);
  return source.slice(from, to);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function loadRuntime(root, options = {}) {
  const store = conversations.createStore({ root: path.join(root, 'store'), ...options.storeOptions });
  const bridge = bridgeModule.createBridge({ store, readers: options.readers || {
    sdk: async () => ({ error: 'not_found' }), codex: async () => ({ error: 'not_found' }),
  } });
  const nativeRuns = [], rendered = [], dropped = [], handlers = {};
  const noop = () => {};
  function native(engine) {
    return {
      async start(input, cwd, emit) {
        const run = { engine, input, cwd, emit, stopped: false, hasSdkBackgroundTasks: () => false,
          async stop() { run.stopped = true; } };
        nativeRuns.push(run);
        return run;
      },
    };
  }
  const sandbox = {
    fs, os, path, randomBytes, console,
    setTimeout: () => ({ unref() {} }), clearTimeout: noop,
    STOP_ALL_SEND_TIMEOUT_MS: 5000, SDK_START_TIMEOUT_MS: 90000,
    runSeq: 0, currentRun: null, currentCliRun: null, lastEngine: '', activeConversationRunId: null,
    sdkSessionControlBusy: false, sdkRunInFlight: false, sdkStartingPromise: null, sdkStoppingPromise: null,
    sendRequestBusy: false, sendRequestEpoch: 0, sdkBackgroundRuns: new Set(), sdkTaskOwners: new Map(),
    conversations: { ...conversations, ...store }, conversationBridge: { ...bridge, messageFor: bridgeModule.messageFor },
    agent: native('sdk'), codex: native('codex'), kimi: { ENGINE_ID: 'kimi-code' }, adapters: { get: () => null },
    ipcMain: { handle(name, callback) { handlers[name] = callback; } },
    eventTrace: { emitted: noop, dropped(...args) { dropped.push(args); } },
    emitToWindow: (event, engine) => rendered.push({ event: plain(event), engine }),
    preview: { endHandoff: noop, clearSensitiveState: noop }, promocapture: { stopAll: async () => {} },
    browserBudgetFor: () => ({}), browserBudgets: new Map(), trustedBrowserOrigins: new Set(),
    checkpoints: { begin: noop, bindSession: noop, consumeVerification: () => '', finish: () => null },
    sanitizeImages: (images) => images || [], sanitizeSkills: () => [], sanitizeExtraDirs: () => [],
    sanitizeClaudeFallbackModel: () => null, nonSdkPerm: (mode) => mode,
    PERMISSION_MODES: new Set(['default']), EFFORT_LEVELS: new Set(),
    withdrawMobilePermissions: noop, notifyObservers: noop, noteShadowOverride: noop,
    beginMobileRunState: noop, finishMobileRunState: noop,
  };
  // المسار الحقيقي يشمل stopAll وقفل sendRequest وإسقاط أحداث الأدوار القديمة؛ لا محاكاة لشروطه.
  vm.runInNewContext([
    section('const SAFE_MODEL =', '\n'),
    section('const SAFE_SESSION =', 'const MOBILE_PERMISSION_TTL_MS ='),
    section('function stopAll(', 'function notifyObservers('),
    section('function forgetSdkBackgroundRun(', 'const rewindPreviews ='),
    section('const SDK_STOP_GRACE_MS =', 'async function runSdkSessionControl('),
    section('async function handleSendRequest(', "ipcMain.handle('satr:stop',"),
  ].join('\n'), sandbox, { filename: 'main-conversation-production-extract.js' });
  async function send(payload) {
    return handlers['satr:send']({}, { engine: 'sdk', cwd: root, prompt: 'طلب', model: 'model-a',
      conversationId: null, clientEpoch: nativeRuns.length + 1, ...payload });
  }
  function identity() { return rendered.filter(({ event }) => event.type === 'conversation').at(-1)?.event; }
  function finish(run, sessionId, text) {
    run.emit({ type: 'system', subtype: 'init', session_id: sessionId });
    run.emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    run.emit({ type: 'result', session_id: sessionId });
  }
  return { send, finish, identity, store, bridge, sandbox, nativeRuns, rendered, dropped };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-conversation-main-'));
  let passed = 0;
  async function test(name, run) {
    const project = path.join(root, String(passed + 1)); fs.mkdirSync(project);
    await run(project); passed++; console.log('PASS ' + name);
  }
  try {
    await test('المسار الفعلي ينقل sdk ثم codex ثم sdk ويحفظ الطلب مرة واحدة', async (project) => {
      const h = loadRuntime(project);
      assert.deepEqual(plain(await h.send({ prompt: 'USER_ONE' })), { started: true, engine: 'sdk' });
      const a = h.nativeRuns.at(-1); assert.equal(a.input.prompt, 'USER_ONE'); assert.equal(a.input.continuityContext, '');
      h.finish(a, 'sdk-a', 'ANSWER_ONE'); const id = h.identity().conversation_id;
      assert.deepEqual(plain(await h.send({ engine: 'codex', conversationId: id, prompt: 'USER_TWO' })), { started: true, engine: 'codex' });
      const b = h.nativeRuns.at(-1);
      assert.ok(b.input.continuityContext.includes('USER_ONE'), 'لم يصل سجل المحادثة إلى المحرك الثاني');
      assert.ok(b.input.continuityContext.includes('ANSWER_ONE'));
      assert.ok(!b.input.continuityContext.includes('USER_TWO'), 'تكرر الطلب الجاري داخل التاريخ');
      assert.equal(b.input.prompt, 'USER_TWO'); assert.equal(b.input.sessionId, null);
      h.finish(b, 'codex-b', 'ANSWER_TWO');
      await h.send({ engine: 'sdk', conversationId: id, prompt: 'USER_THREE' });
      const c = h.nativeRuns.at(-1); assert.equal(c.input.sessionId, 'sdk-a');
      assert.ok(c.input.continuityContext.includes('USER_TWO')); assert.ok(c.input.continuityContext.includes('ANSWER_TWO'));
      assert.ok(!c.input.continuityContext.includes('USER_THREE'));
      h.finish(c, 'sdk-a', 'ANSWER_THREE');
      const data = h.store.load(id, project); assert.equal(data.ok, true);
      assert.deepEqual(data.conversation.messages.filter((message) => message.role === 'user').map((message) => message.text),
        ['USER_ONE', 'USER_TWO', 'USER_THREE']);
      assert.equal(h.identity().conversation_id, id);
    });
    await test('تغيير النموذج يستأنف sessionId نفسه بلا نقل مكرر', async (project) => {
      const h = loadRuntime(project); await h.send({ prompt: 'MODEL_FIRST', model: 'model-a' });
      h.finish(h.nativeRuns.at(-1), 'sdk-model', 'MODEL_ANSWER'); const id = h.identity().conversation_id;
      await h.send({ conversationId: id, sessionId: 'sdk-model', prompt: 'MODEL_SECOND', model: 'model-b' });
      const run = h.nativeRuns.at(-1); assert.equal(run.input.sessionId, 'sdk-model');
      assert.equal(run.input.model, 'model-b'); assert.equal(run.input.continuityContext, '');
      h.finish(run, 'sdk-model', 'MODEL_DONE');
    });
    await test('الأحداث المتأخرة لا تكتب في السجل ولا تصل إلى المصير', async (project) => {
      const h = loadRuntime(project); await h.send({ prompt: 'OLD_USER' });
      const old = h.nativeRuns.at(-1); h.finish(old, 'sdk-old', 'OLD_ANSWER'); const id = h.identity().conversation_id;
      await h.send({ engine: 'codex', conversationId: id, prompt: 'NEW_USER' });
      const before = plain(h.store.load(id, project).conversation), count = h.rendered.length;
      old.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'STALE_ANSWER' }] } });
      old.emit({ type: 'system', subtype: 'init', session_id: 'sdk-stale' });
      assert.equal(h.rendered.length, count); assert.deepEqual(h.store.load(id, project).conversation, before);
      assert.equal(h.dropped.length, 2); assert.ok(h.dropped.every((args) => args[2] === 'stale_token'));
      h.finish(h.nativeRuns.at(-1), 'codex-new', 'NEW_ANSWER');
    });
    await test('مجلد غير صالح ومصدر من مشروع آخر يُرفضان قبل native.start', async (project) => {
      const foreign = path.join(project, 'foreign'); fs.mkdirSync(foreign);
      const h = loadRuntime(project, { readers: { sdk: async () => ({ cwd: foreign, messages: [{ role: 'user', text: 'FOREIGN' }] }) } });
      assert.equal((await h.send({ cwd: path.join(project, 'missing') })).error, 'bad_cwd');
      assert.equal((await h.send({ continuitySource: { engine: 'sdk', sessionId: 'old-source', cwd: project } })).error, 'project_mismatch');
      assert.equal(h.nativeRuns.length, 0); assert.equal(h.rendered.length, 0);
    });
    await test('فشل prepare لا يبدأ محركاً أو محادثة فارغة', async (project) => {
      const h = loadRuntime(project, { storeOptions: { maxTransferChars: 80 } });
      await h.send({ prompt: 'A'.repeat(100) }); h.finish(h.nativeRuns.at(-1), 'sdk-limit', 'B'.repeat(100));
      const id = h.identity().conversation_id, count = h.nativeRuns.length;
      const result = await h.send({ engine: 'codex', conversationId: id, prompt: 'BLOCKED_CURRENT' });
      assert.equal(result.error, 'transfer_limit'); assert.equal(h.nativeRuns.length, count);
      assert.ok(!h.store.load(id, project).conversation.messages.some((message) => message.text === 'BLOCKED_CURRENT'));
    });
    await test('مرجع جلسة قديمة يستورد القرص ويعيد تاريخاً بلا الطلب الجاري', async (project) => {
      const h = loadRuntime(project, { readers: { sdk: async () => ({ cwd: project, messages: [
        { role: 'user', text: 'IMPORTED_USER' }, { role: 'assistant', text: 'IMPORTED_ANSWER' },
      ] }) } });
      await h.send({ engine: 'codex', prompt: 'IMPORTED_CURRENT', continuitySource: { engine: 'sdk', sessionId: 'sdk-import', cwd: project } });
      const event = h.identity(), run = h.nativeRuns.at(-1);
      assert.equal(event.restored, true); assert.equal(event.messages.length, 2);
      assert.ok(!JSON.stringify(event.messages).includes('IMPORTED_CURRENT'));
      assert.equal(run.input.prompt, 'IMPORTED_CURRENT'); assert.ok(run.input.continuityContext.includes('IMPORTED_USER'));
      h.finish(run, 'codex-import', 'IMPORT_DONE');
    });
    await test('تعافي Codex يعيد السياق الكامل عبر callback الإنتاجية', async (project) => {
      const h = loadRuntime(project); await h.send({ engine: 'codex', prompt: 'RESTART_FIRST' });
      h.finish(h.nativeRuns.at(-1), 'codex-before', 'RESTART_ANSWER'); const id = h.identity().conversation_id;
      await h.send({ engine: 'codex', conversationId: id, prompt: 'RESTART_CURRENT' });
      const run = h.nativeRuns.at(-1); assert.equal(run.input.sessionId, 'codex-before'); assert.equal(run.input.continuityContext, '');
      assert.equal(typeof run.input.continuityRestart, 'function');
      const full = run.input.continuityRestart(); assert.ok(full.includes('RESTART_FIRST')); assert.ok(full.includes('RESTART_ANSWER'));
      assert.ok(!full.includes('RESTART_CURRENT'));
      h.finish(run, 'codex-after', 'RESTART_DONE');
      assert.equal(h.store.load(id, project).conversation.bindings.codex.sessionId, 'codex-after');
    });
    await test('إلغاء طلب أثناء قراءة المصدر يمنع بدءه بعد حسم القراءة', async (project) => {
      const wait = deferred(); const h = loadRuntime(project, { readers: { sdk: () => wait.promise } });
      const pending = h.send({ continuitySource: { engine: 'sdk', sessionId: 'sdk-wait', cwd: project } });
      await new Promise((resolve) => setImmediate(resolve)); h.sandbox.cancelPendingSendRequest();
      wait.resolve({ cwd: project, messages: [{ role: 'user', text: 'WAIT_SOURCE' }, { role: 'assistant', text: 'WAIT_ANSWER' }] });
      assert.equal((await pending).error, 'stopped'); assert.equal(h.nativeRuns.length, 0);
      const latest = h.store.latest(project); assert.equal(latest.ok, true);
      assert.equal(latest.conversation.runs.at(-1).status, 'stopped');
    });
    console.log('conversation-main: ' + passed + '/' + passed + ' passed');
  } finally {
    // جذر أنشأه هذا الحارس نفسه، مع تحقق حدّه قبل التنظيف على Windows.
    const resolved = path.resolve(root), tempRoot = path.resolve(os.tmpdir());
    assert.ok(path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('satr-conversation-main-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
