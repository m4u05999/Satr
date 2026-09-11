#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceFlag = process.argv.indexOf('--source');
const sourceFile = sourceFlag >= 0 ? process.argv[sourceFlag + 1] : path.join(__dirname, '../src/ui/app.js');
assert.ok(sourceFile, 'يلزم مسار بعد --source');
const source = fs.readFileSync(sourceFile, 'utf8').replace(/\r\n/g, '\n');

// نشغّل دوال القشرة ومستمعيها كما هي؛ البدائل محصورة في DOM وحدود IPC.
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'تعذّر استخراج منطق الإنتاج: ' + start);
  return source.slice(a, b);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function harness() {
  const elements = new Map(), notices = [], history = [], calls = { send: [], forget: [], stop: 0 };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', options: [], listeners: {},
      classList: { add() {}, remove() {} }, focus() {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
    });
    return elements.get(id);
  }
  for (const id of ['engine', 'model', 'cwd', 'input', 'send', 'sessionInfo', 'effort', 'perm', 'fallbackModel']) element(id);
  element('engine').value = 'sdk';
  element('engine').options = ['sdk', 'codex', 'kimi-code', 'groq', 'cli'].map((value) => ({ value }));
  element('cwd').value = 'D:\\project-a';
  element('model').value = 'model-a';
  const api = {
    async send(payload) { calls.send.push(plain(payload)); return { ok: true }; },
    async stop() { calls.stop++; },
    async conversationForget(cwd) { calls.forget.push(cwd); return { ok: true }; },
    async conversationCurrent() { return { ok: true, conversation: null }; },
    async lastChat() { return { sid: null }; }, forgetChat() {},
  };
  const noop = () => {};
  const chatEl = {
    clearThread() { history.length = 0; }, reset() { history.length = 0; },
    addUserMsg(text) { history.push({ role: 'user', text }); },
    addHistoryAssistant(message, engine) { history.push({ role: 'assistant', text: message.text, engine }); },
    addNoticeBefore(text) { notices.push(text); },
    newAssistantBlock() { return { el: {}, done: false, errors: [], error(text) { this.errors.push(text); }, showRetry: noop, stopped: noop }; },
    clearTaskLedger: noop, clearCheckpoint: noop, scrollToEnd: noop,
  };
  const state = {
    $: element, window: { satr: api }, localStorage: { setItem: noop },
    SAFE_SESSION: /^[A-Za-z0-9_-]{1,128}$/,
    sessionId: null, conversationId: null, continuitySource: null, conversationEpoch: 0,
    conversationRestoreBusy: false, conversationForgetPending: Promise.resolve(),
    sessionCwd: 'D:\\project-a', lastConversationCwd: 'D:\\project-a', lastEngine: 'sdk',
    busy: false, gated: false, sessionControlBusy: false, sessionResumeBusy: false, applyingResumedCwd: false,
    currentBlock: null, runningEngine: '', previewDirty: false, lastSentPrompt: '',
    lastUserTurn: { prompt: '', images: [] }, thinkingValue: '', browserControlOn: false,
    providersCache: [{ name: 'groq', family: 'openai' }, { name: 'kimi-code', capabilities: { native: true } }],
    chatEl, input: element('input'), sendBtn: element('send'),
    composerEl: { afterSend: noop, clearImages: noop, getImages: () => [] },
    topbarEl: { getExtraDirs: () => [] }, previewEl: { resetTaskTrace: noop },
    addNotice: (text) => notices.push(text), shortSessionLabel: (id) => id,
    hasSdkBackgroundSessionLock: () => false, clearPromptSuggestion: noop,
    resetSessionChanges: noop, loadTaskLedger: noop, loadCheckpoint: noop,
    rebuildModels: noop, rebuildEfforts: noop, syncAwareness: noop,
    applyEngineCommands: noop, checkCodexReady: noop, checkKimiReady: noop,
    refreshEngineModels: noop,
    refreshClaudeModels: noop, refreshCodexModels: noop, refreshKimiModels: noop,
    setBrowserControl: noop, engineLabel: () => element('engine').value,
    engineSupportsVision: () => true, engineSupportsEffort: () => true,
    computeSkillsPayload: () => 'all', steerEligible: () => false, steerTurn: noop,
    endRun() { state.busy = false; state.runningEngine = ''; },
    applyResumedCwd(cwd) { element('cwd').value = cwd; },
  };
  const script = [
    between('  function isBlindEngine(', '  // مجموعة مخزن الجلسات:'),
    between('  function sessionGroup(', '  function modelsForEngine('),
    between("  $('engine').addEventListener('change', async () => {", "  $('model').addEventListener('change'"),
    between("  $('model').addEventListener('change', () => {", '  loadProviders();'),
    between("  $('cwd').addEventListener('change', () => {", '\n\n  // ---------- تنبيه'),
    between('  function newSession(options)', "  $('newSession').addEventListener"),
    between('  function deadSessionRecovery(', '  function isClaudeAuthError('),
    between('  async function send() {', '  // ---------- ضغط المحادثة'),
    between('  async function compactConversation() {', '  // ---------- أوامر Kimi'),
  ].join('\n');
  vm.createContext(state);
  vm.runInContext(script, state, { filename: 'app-conversation-production-extract.js' });
  return {
    state, api, calls, history, notices, element,
    async engine(value) { element('engine').value = value; await element('engine').listeners.change(); },
    cwd(value) { element('cwd').value = value; element('cwd').listeners.change(); },
  };
}

async function main() {
  let passed = 0;
  const test = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
  await test('تغيير النموذج يبقي المحادثة والجلسة', async () => {
    const h = harness(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a' });
    h.element('model').value = 'model-b'; h.element('model').listeners.change();
    assert.equal(h.state.conversationId, 'chat-a'); assert.equal(h.state.sessionId, 'sdk-a');
  });
  await test('الانتقال بين المحركين يبقي الهوية ويفصل جلسة المحرك', async () => {
    const h = harness(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a' });
    await h.engine('codex');
    assert.equal(h.state.conversationId, 'chat-a', 'فُقدت هوية المحادثة عند تبديل المحرك');
    assert.equal(h.state.sessionId, null); assert.equal(h.state.continuitySource, null);
    await h.engine('sdk'); assert.equal(h.state.conversationId, 'chat-a');
  });
  await test('مصدر جلسة قديمة يبقى عبر تبديلات متكررة قبل الإرسال', async () => {
    const h = harness(); h.state.sessionId = 'sdk-old';
    await h.engine('codex'); await h.engine('sdk'); await h.engine('codex');
    assert.deepEqual(plain(h.state.continuitySource), { engine: 'sdk', sessionId: 'sdk-old', cwd: 'D:\\project-a' });
    h.element('input').value = 'واصل'; await h.state.send();
    assert.equal(h.calls.send[0].sessionId, null);
    assert.deepEqual(h.calls.send[0].continuitySource, { engine: 'sdk', sessionId: 'sdk-old', cwd: 'D:\\project-a' });
  });
  await test('المحرك والمجلد وجديدة محجوبة أثناء الدور بلا إيقاف خفي', async () => {
    const h = harness(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a', busy: true });
    await h.engine('codex'); h.cwd('D:\\project-b');
    assert.equal(h.state.newSession(), false);
    assert.equal(h.element('engine').value, 'sdk'); assert.equal(h.element('cwd').value, 'D:\\project-a');
    assert.equal(h.state.conversationId, 'chat-a'); assert.equal(h.calls.stop, 0);
  });
  await test('جديدة تفصل الهوية وتنسى المؤشر وحده', async () => {
    const h = harness(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a' });
    assert.equal(h.state.newSession(), true); await h.state.conversationForgetPending;
    assert.equal(h.state.conversationId, null); assert.equal(h.state.sessionId, null);
    assert.deepEqual(h.calls.forget, ['D:\\project-a']);
    h.state.newSession({ fromResume: true }); assert.equal(h.calls.forget.length, 1);
  });
  await test('تغيير المشروع أو محرك غير مشمول يفصل المحادثة', async () => {
    const h = harness(); h.state.conversationId = 'chat-a'; h.cwd('D:\\project-b');
    assert.equal(h.state.conversationId, null); assert.equal(h.state.sessionId, null);
    h.state.conversationId = 'chat-b'; await h.engine('groq');
    assert.equal(h.state.conversationId, null); assert.equal(h.state.continuitySource, null);
  });
  await test('الاستعادة تعرض canonical وتختار المحرك المحفوظ', async () => {
    const h = harness(); h.api.conversationCurrent = async () => ({ ok: true, conversation: {
      id: 'chat-a', cwd: 'D:\\project-a', engine: 'codex', sessionId: 'codex-a',
      messages: [{ role: 'user', text: 'السؤال' }, { role: 'assistant', text: 'الجواب', engine: 'sdk' }],
    } });
    assert.equal(await h.state.restoreCurrentConversation(), true);
    assert.equal(h.state.conversationId, 'chat-a'); assert.equal(h.state.sessionId, 'codex-a');
    assert.equal(h.element('engine').value, 'codex'); assert.equal(h.history.length, 2);
  });
  await test('استعادة متأخرة لا تعيد محادثة بعد جديدة', async () => {
    const h = harness(), wait = deferred(); h.api.conversationCurrent = () => wait.promise;
    const pending = h.state.restoreCurrentConversation(); h.state.newSession();
    wait.resolve({ ok: true, conversation: { id: 'old-chat', cwd: 'D:\\project-a', engine: 'sdk', sessionId: 'old-sdk', messages: [] } });
    assert.equal(await pending, false); assert.equal(h.state.conversationId, null);
  });
  await test('استعادة محول متأخرة لا تلوث المحرك الجديد', async () => {
    const h = harness(), wait = deferred(); h.api.lastChat = () => wait.promise;
    const pending = h.engine('groq'); await h.engine('codex'); wait.resolve({ sid: 'groq-old' }); await pending;
    assert.equal(h.element('engine').value, 'codex'); assert.equal(h.state.sessionId, null);
  });
  await test('الإرسال يلتقط النموذج والجلسة قبل انتظار المهارات', async () => {
    const h = harness(), wait = deferred(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a' });
    h.state.computeSkillsPayload = () => wait.promise; h.element('input').value = 'ابدأ';
    const pending = h.state.send(); h.element('model').value = 'model-b'; await h.engine('codex');
    wait.resolve('all'); await pending;
    assert.equal(h.calls.send.length, 1); assert.equal(h.calls.send[0].model, 'model-a');
    assert.equal(h.calls.send[0].engine, 'sdk'); assert.equal(h.calls.send[0].sessionId, 'sdk-a');
    assert.equal(h.calls.send[0].conversationId, 'chat-a'); assert.ok(Number.isSafeInteger(h.calls.send[0].clientEpoch));
  });
  await test('إيقاف التحضير يلغي الإرسال المتأخر', async () => {
    const h = harness(), wait = deferred(); h.state.computeSkillsPayload = () => wait.promise;
    h.element('input').value = 'طلب'; const pending = h.state.send(); await h.state.send();
    wait.resolve('all'); await pending; assert.equal(h.calls.send.length, 0); assert.equal(h.calls.stop, 1);
  });
  await test('أحداث هوية قديمة أو لمشروع آخر لا تُقبل', async () => {
    const h = harness(); h.state.conversationEpoch = 4;
    const event = { engine: 'sdk', cwd: 'D:\\project-a', client_epoch: 4, conversation_id: 'chat-a', session_id: 'sdk-a' };
    for (const change of [{ client_epoch: 3 }, { engine: 'codex' }, { cwd: 'D:\\project-b' }, { conversation_id: '../bad' }]) {
      assert.equal(h.state.acceptConversationEvent({ ...event, ...change }), false);
    }
    assert.equal(h.state.conversationId, null); assert.equal(h.state.acceptConversationEvent(event), true);
    assert.equal(h.state.acceptConversationEvent({ ...event, conversation_id: 'chat-b' }), false);
    assert.equal(h.state.conversationId, 'chat-a'); assert.equal(h.state.sessionId, 'sdk-a');
  });
  await test('تاريخ جلسة مستوردة لا يكرر الطلب الجاري', async () => {
    const h = harness(); h.state.busy = true; h.state.currentBlock = h.state.chatEl.newAssistantBlock();
    h.state.lastUserTurn = { prompt: 'طلب جديد', images: [] };
    const event = { engine: 'sdk', cwd: 'D:\\project-a', client_epoch: 0, conversation_id: 'chat-a', session_id: 'sdk-a', restored: true,
      messages: [{ role: 'user', text: 'طلب قديم' }, { role: 'assistant', text: 'جواب قديم', engine: 'codex' }] };
    assert.equal(h.state.acceptConversationEvent(event), true); h.state.acceptConversationEvent(event);
    assert.equal(h.history.filter((message) => message.text === 'طلب جديد').length, 1); assert.equal(h.history.length, 3);
  });
  await test('قراءة جلسة مرتبطة تفضل سجل المحادثة الكامل', async () => {
    const h = harness(); h.state.sessionResumeBusy = true;
    assert.equal(h.state.restoreReadConversation({ id: 'chat-a', cwd: 'D:\\project-a', engine: 'codex', sessionId: 'codex-a',
      messages: [{ role: 'user', text: 'سجل مشترك' }] }), true);
    assert.equal(h.state.conversationId, 'chat-a'); assert.equal(h.element('engine').value, 'codex');
    assert.equal(h.history[0].text, 'سجل مشترك'); assert.equal(h.calls.forget.length, 0);
  });
  await test('الضغط يبقي هوية المحادثة والجلسة', async () => {
    const h = harness(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a' });
    await h.state.compactConversation(); assert.equal(h.calls.send[0].prompt, '/compact');
    assert.equal(h.calls.send[0].conversationId, 'chat-a'); assert.equal(h.calls.send[0].sessionId, 'sdk-a');
  });
  await test('فشل IPC لا يترك المؤلف مشغولاً', async () => {
    const h = harness(); h.api.send = async () => { throw new Error('ipc_failed'); };
    h.element('input').value = 'طلب'; await h.state.send(); assert.equal(h.state.busy, false);
    assert.equal(h.state.currentBlock.errors.length, 1);
  });
  await test('فقدان جلسة المحرك يبقي المحادثة ومجلدها ويشرح الاستعادة', async () => {
    const h = harness(); Object.assign(h.state, { conversationId: 'chat-a', sessionId: 'sdk-a', lastSentPrompt: 'أعد الطلب' });
    assert.equal(h.state.deadSessionRecovery('No conversation found with session ID sdk-a'), true);
    assert.equal(h.state.conversationId, 'chat-a'); assert.equal(h.state.sessionId, null);
    assert.equal(h.state.sessionCwd, 'D:\\project-a'); assert.equal(h.element('input').value, 'أعد الطلب');
    assert.ok(h.notices.at(-1).includes('سياق المحادثة محفوظ'));
  });
  await test('استئناف جلسة يحجب تغيير المجلد إلا لتحديثه الداخلي', async () => {
    const h = harness(); Object.assign(h.state, { sessionResumeBusy: true, sessionId: 'sdk-a', conversationId: 'chat-a' });
    h.cwd('D:\\foreign');
    assert.equal(h.element('cwd').value, 'D:\\project-a'); assert.equal(h.state.conversationId, 'chat-a');
    h.state.applyingResumedCwd = true; h.cwd('D:\\resumed');
    assert.equal(h.state.lastConversationCwd, 'D:\\resumed'); assert.equal(h.state.conversationId, 'chat-a');
  });
  await test('فشل الاستعادة يُعلن بلا تسريب ولا إشعار من سياق قديم', async () => {
    const error = harness(); error.api.conversationCurrent = async () => ({ ok: false, error: 'PRIVATE_PATH' });
    assert.equal(await error.state.restoreCurrentConversation(), false);
    assert.deepEqual(error.notices, ['تعذرت استعادة المحادثة المحفوظة لهذا المشروع.']);
    const thrown = harness(); thrown.api.conversationCurrent = async () => { throw new Error('PRIVATE_PATH'); };
    assert.equal(await thrown.state.restoreCurrentConversation(), false);
    assert.deepEqual(thrown.notices, ['تعذرت استعادة المحادثة المحفوظة لهذا المشروع.']);
    const empty = harness(); assert.equal(await empty.state.restoreCurrentConversation(), false); assert.equal(empty.notices.length, 0);
    const stale = harness(), wait = deferred(); stale.api.conversationCurrent = () => wait.promise;
    const pending = stale.state.restoreCurrentConversation(); stale.state.newSession();
    wait.reject(new Error('PRIVATE_PATH')); await pending;
    assert.equal(stale.notices.length, 0);
  });
  console.log('conversation-ui: ' + passed + '/' + passed + ' passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
