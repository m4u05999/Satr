#!/usr/bin/env node
'use strict';
// نشغّل دوال القشرة نفسها ومستمع جاهزية البوابة؛ البدائل عند DOM وIPC فقط.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flag = process.argv.indexOf('--source');
const source = fs.readFileSync(flag < 0 ? path.join(__dirname, '../src/ui/app.js') : process.argv[flag + 1], 'utf8').replace(/\r\n/g, '\n');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'تعذّر استخراج منطق الإنتاج: ' + start);
  return source.slice(a, b);
}
function sourceFunction(name) {
  const marker = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(marker + name + '('), end = source.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, 'تعذّر استخراج الدالة: ' + name);
  return source.slice(start, end + 5);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const catalog = [
  { id: 'gpt-5.6-sol', name: 'Sol', isDefault: false },
  { id: 'gpt-6-astra', name: 'Astra', isDefault: true },
];
function harness({ engine = 'codex', saved, gate = true } = {}) {
  const values = new Map([['satr_engine', engine]]), nodes = new Map(), timers = new Map(), notices = [];
  const counts = { sdk: 0, codex: 0, 'kimi-code': 0, commands: [] };
  let nextTimer = 0;
  class Element {
    constructor(id) {
      this.id = id; this.options = []; this._value = ''; this.listeners = {};
      this.textContent = ''; this.style = {}; this.classList = { add() {}, remove() {} };
    }
    get value() { return this._value; }
    set value(value) { this._value = ['engine', 'model', 'fallbackModel'].includes(this.id) && !this.options.some((item) => item.value === value) ? '' : value; }
    set innerHTML(_) { this.options = []; this._value = ''; }
    appendChild(option) { this.options.push(option); if (this.options.length === 1) this._value = option.value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    dispatchEvent(event) { return this.listeners[event.type] && this.listeners[event.type](event); }
    focus() {}
  }
  const element = (id) => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  for (const name of ['sdk', 'codex', 'kimi-code', 'groq']) element('engine').appendChild({ value: name });
  element('engine').value = engine;
  element('cwd').value = 'D:\\model-test';
  if (saved !== undefined) values.set('satr_model_' + engine, saved);
  const api = {
    async providers() { return { providers: [{ name: 'kimi-code', models: [{ value: 'k3', label: 'K3' }] }, { name: 'groq', models: [{ value: 'groq-a', label: 'Groq' }] }] }; },
    async codexModels() { counts.codex++; return catalog; },
    async claudeModels() { counts.sdk++; return { ok: true, models: [{ value: 'claude-current', label: 'Claude الحالي' }] }; },
    async kimiModels() { counts['kimi-code']++; return [{ id: 'kimi-current', name: 'Kimi الحالي' }]; },
    async conversationCurrent() { return { ok: true, conversation: null }; },
    async readSession() { return { messages: [], total: 0 }; },
    async readCodexSession() { return { messages: [], total: 0 }; },
    async readKimiSession() { return { messages: [], total: 0 }; },
    async readChat() { return { ok: true, messages: [] }; },
  };
  const noop = () => {};
  const state = {
    $: element, window: { satr: api }, gated: gate,
    document: { getElementById: element, createElement: () => ({ value: '', textContent: '' }), querySelector: element },
    localStorage: { getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value) },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    gateReadyEngines: null, gatePreferred: null, gateBannerTimer: null,
    addNotice: (notice) => notices.push(notice), hideGateBannerAfter: noop, fetchClaudeAccount: async () => null,
    rebuildEfforts: noop, syncAwareness: noop, applyEngineCommands: (value) => counts.commands.push(value),
    checkCodexReady: noop, checkKimiReady: noop, restoreAdapterSession: async () => {},
    lastEngine: engine, SAFE_SESSION: /^[A-Za-z0-9_-]{1,128}$/, conversationId: null, sessionId: null,
    continuitySource: null, conversationEpoch: 0, busy: false, sessionResumeBusy: false,
    sessionControlBusy: false, conversationRestoreBusy: false, currentBlock: null, sessionCwd: null,
    lastConversationCwd: element('cwd').value,
    clearPromptSuggestion: noop, resetSessionChanges: noop, loadTaskLedger: noop, loadCheckpoint: noop, shortSessionLabel: (id) => id,
    composerEl: { clearImages: noop }, chatEl: { clearTaskLedger: noop, clearCheckpoint: noop, clearThread: noop, scrollToEnd: noop, addUserMsg: noop, addHistoryAssistant: noop },
    input: element('input'), sessionsEl: { close: noop }, newSession: () => true,
    applyResumedCwd: noop, hasSdkBackgroundSessionLock: () => false,
    exports: {},
  };
  const script = [
    "const GATED_ENGINES = ['sdk', 'codex', 'kimi-code'];",
    "const GATED_ENGINE_LABELS = { sdk: 'Claude', codex: 'Codex', 'kimi-code': 'Kimi' };",
    between('  const CLAUDE_MODELS = [', '  // محوّل «أعمى» (1.3):'),
    ...['applyGateEngineSwitch', 'modelsForEngine', 'rebuildModels', 'loadProviders',
      'supportsConversation', 'conversationContextIsCurrent', 'detachConversation', 'rememberContinuitySource', 'isBlindEngine', 'sessionGroup', 'showConversationHistory',
      'restoreCurrentConversation', 'restoreReadConversation', 'resumeSession', 'resumeCodexSession', 'resumeKimiSession', 'resumeChat', 'providerLabel'].map(sourceFunction),
    between("  $('engine').addEventListener('change', async () => {", "  $('model').addEventListener('change'"),
    between("  $('model').addEventListener('change', () => {", '  loadProviders();'),
    between("  document.querySelector('satr-gate').addEventListener('gate-ready',", '  // بناء قائمة «المحرك»'),
    "Object.assign(exports, { refreshEngineModels, rebuildModels, loadProviders, restoreReadConversation, restoreCurrentConversation, resumeSession, resumeCodexSession, resumeKimiSession, resumeChat });",
  ].join('\n');
  vm.createContext(state); vm.runInContext(script, state, { filename: 'model-boot-production.js' });
  return { state, api, counts, values, timers, notices, element, ...state.exports,
    async ready(readyEngines = [engine]) { element('satr-gate').dispatchEvent({ type: 'gate-ready', detail: { readyEngines, engineLabel: engine } }); await this.settle(); },
    async settle() { const pending = vm.runInContext('[...engineModelsRequests.values()]', state); await Promise.all(pending); },
    async tick() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) await timer.fn(); },
    models() { return element('model').options.map((item) => item.value); },
    async select(engine) { element('engine').value = engine; await element('engine').dispatchEvent({ type: 'change' }); await vm.runInContext('engineModelsRequests.get($("engine").value)', state); },
  };
}
async function main() {
  let passed = 0;
  const test = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
  for (const engine of ['codex', 'sdk', 'kimi-code']) {
    for (const order of ['providers-first', 'gate-first']) {
      await test('إقلاع ' + engine + ' بترتيب ' + order, async () => {
        const h = harness({ engine });
        if (order === 'providers-first') {
          await h.loadProviders(); assert.equal(h.counts[engine], 0, 'بدأ الجلب قبل جاهزية البوابة');
          await h.ready();
        } else { await h.ready(); await h.loadProviders(); await h.settle(); }
        const expected = engine === 'codex' ? 'gpt-6-astra' : engine === 'sdk' ? 'claude-current' : 'kimi-current';
        assert.ok(h.models().includes(expected), 'بقيت القائمة الاحتياطية بعد جاهزية ' + engine);
        assert.equal(h.element('engine').value, engine);
      });
    }
  }
  await test('اختيار الافتراضي المعلن ولو لم يكن أول القائمة', async () => {
    const h = harness({ gate: false }); await h.loadProviders(); await h.settle();
    assert.equal(h.element('model').value, 'gpt-6-astra', 'لم يُحترم isDefault المعلن');
  });
  await test('اختيار المستخدم المحفوظ يغلب الافتراضي', async () => {
    const h = harness({ gate: false, saved: 'gpt-5.6-sol' }); await h.loadProviders(); await h.settle();
    assert.equal(h.element('model').value, 'gpt-5.6-sol');
  });
  await test('النموذج المحفوظ خارج الكتالوج يبقى ظاهراً', async () => {
    const h = harness({ gate: false, saved: 'custom-model' }); await h.loadProviders(); await h.settle();
    assert.equal(h.element('model').value, 'custom-model'); assert.ok(h.models().includes('custom-model'));
  });
  await test('الجلب المتزامن يشترك في طلب واحد', async () => {
    const h = harness({ gate: false }), pending = deferred();
    h.api.codexModels = () => { h.counts.codex++; return pending.promise; };
    const first = h.refreshEngineModels(), second = h.refreshEngineModels();
    assert.equal(first, second, 'لم تُشارك هوية الطلب الجاري');
    await Promise.resolve(); assert.equal(h.counts.codex, 1);
    pending.resolve(catalog); await first;
  });
  await test('استجابة متأخرة لا تغيّر نموذج محرك آخر', async () => {
    const h = harness({ gate: false }), pending = deferred();
    h.api.codexModels = () => pending.promise;
    const first = h.refreshEngineModels(); await h.select('sdk');
    pending.resolve(catalog); await first;
    assert.equal(h.element('engine').value, 'sdk'); assert.equal(h.element('model').value, 'claude-current');
    await h.select('codex'); assert.ok(h.models().includes('gpt-6-astra'));
  });
  await test('اختيار جديد أثناء الجلب يبقى بعد وصول القائمة', async () => {
    const h = harness({ gate: false }), pending = deferred();
    h.api.codexModels = () => pending.promise; h.rebuildModels();
    const first = h.refreshEngineModels();
    h.element('model').value = 'gpt-5.6-sol'; h.element('model').dispatchEvent({ type: 'change' });
    pending.resolve(catalog); await first;
    assert.equal(h.element('model').value, 'gpt-5.6-sol');
  });
  await test('فشل متأخر بعد مغادرة Codex لا يضيف مؤقتاً أو إنذاراً', async () => {
    const h = harness({ gate: false }), pending = deferred();
    h.api.codexModels = () => pending.promise; const first = h.refreshEngineModels();
    await h.select('sdk'); pending.resolve([]); await first;
    assert.equal(h.timers.size, 0); assert.equal(h.notices.length, 0);
  });
  await test('استنفاد محدود ثم محاولة جديدة تلغي مؤقت الإعادة السابق', async () => {
    const h = harness({ gate: false }); h.api.codexModels = async () => { h.counts.codex++; return []; };
    await h.refreshEngineModels(); await h.tick(); await h.tick();
    assert.equal(h.counts.codex, 3); assert.equal(h.timers.size, 0); assert.equal(h.notices.length, 1);
    await h.refreshEngineModels(); assert.equal(h.timers.size, 1);
    h.api.codexModels = async () => catalog; await h.refreshEngineModels();
    assert.equal(h.timers.size, 0, 'بقي مؤقت قديم بعد نجاح الجلب'); assert.ok(h.models().includes('gpt-6-astra'));
  });
  await test('فشل لاحق يبقي الكتالوج الناجح', async () => {
    const h = harness({ gate: false }); await h.refreshEngineModels();
    h.api.codexModels = async () => []; await h.refreshEngineModels();
    assert.ok(h.models().includes('gpt-6-astra')); assert.equal(h.timers.size, 0);
  });
  await test('الاستعادة عند الإقلاع تجلب نماذج محرك المحادثة', async () => {
    const h = harness({ engine: 'sdk', gate: false });
    h.api.conversationCurrent = async () => ({ ok: true, conversation: { id: 'conversation-a', engine: 'codex', cwd: h.element('cwd').value, messages: [] } });
    await h.loadProviders(); await h.settle();
    assert.equal(h.element('engine').value, 'codex'); assert.ok(h.models().includes('gpt-6-astra'), 'الاستعادة تركت كتالوج Codex الثابت');
  });
  await test('فتح محادثة محفوظة يجلب كتالوجها', async () => {
    const h = harness({ engine: 'sdk', gate: false });
    assert.equal(h.restoreReadConversation({ id: 'conversation-b', engine: 'codex', cwd: h.element('cwd').value, messages: [] }), true);
    await h.settle(); assert.ok(h.models().includes('gpt-6-astra'), 'فتح المحادثة لم يجلب النماذج');
  });
  for (const [engine, fn, expected] of [['sdk', 'resumeSession', 'claude-current'], ['codex', 'resumeCodexSession', 'gpt-6-astra'], ['kimi-code', 'resumeKimiSession', 'kimi-current']]) {
    await test('استئناف جلسة ' + engine + ' يجلب قائمتها', async () => {
      const h = harness({ engine: 'groq', gate: false }); await h[fn]({ id: 'session-a', project: 'project-a' }); await h.settle();
      assert.equal(h.element('engine').value, engine); assert.ok(h.models().includes(expected), 'استئناف ' + engine + ' لم يجلب القائمة');
    });
  }
  await test('استئناف المحول يزامن أوامر المحرر', async () => {
    const h = harness({ gate: false }); await h.loadProviders(); await h.settle();
    await h.resumeChat({ provider: 'groq', id: 'chat-a' });
    assert.equal(h.counts.commands.at(-1), 'groq'); assert.equal(h.element('engine').value, 'groq');
  });
  console.log('model-boot-test: OK ' + passed + '/' + passed);
}
const deadline = setTimeout(() => { console.error('model-boot-test: FAIL unresolved production request'); process.exit(1); }, 10000);
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));