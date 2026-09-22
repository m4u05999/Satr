'use strict';

// OBS-213: يشغّل معالج app.js ومكوّني الحوار من مصادر الإنتاج؛ لا ينسخ منطق الملكية.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function section(source, start, end, includeEnd = false) {
  assert.equal(source.split(start).length - 1, 1, 'مرساة app.js غير فريدة: ' + start);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, 'تعذّر استخراج مقطع app.js: ' + start);
  return source.slice(from, to + (includeEnd ? end.length : 0));
}

function loadDialogPrototype(root, file, className) {
  const source = fs.readFileSync(path.join(root, 'src/ui/components', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  let Dialog;
  vm.runInNewContext(source, {
    HTMLElement: class {}, sheet: () => ({}), controlsSheet: {}, applyDir() {},
    queueMicrotask: (fn) => fn(),
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    customElements: { define(_name, ctor) { Dialog = ctor; } },
  }, { filename: className + '-production.js' });
  assert.ok(Dialog, 'تعذّر تحميل مكوّن الإنتاج: ' + className);
  return Dialog.prototype;
}

function el() {
  return { textContent: '', hidden: false, disabled: false, classList: { remove() {} }, focus() {} };
}
function base(proto) {
  return Object.assign(Object.create(proto), {
    _queue: [], _current: null, _sending: false, _requestEpoch: 0, _attrs: new Set(),
    shadowRoot: { querySelector: () => null },
    setAttribute(name) { this._attrs.add(name); },
    removeAttribute(name) { this._attrs.delete(name); },
    hasAttribute(name) { return this._attrs.has(name); },
    dispatchEvent() { return true; },
  });
}
function permissionDialog(proto) {
  return Object.assign(base(proto), {
    _buttons: [el(), el(), el(), el()], _tool: el(), _detail: el(), _requester: el(),
    _pendingCount: el(), _turn: el(), _always: el(), _sensitive: el(), _deny: el(),
  });
}
function questionDialog(proto) {
  return Object.assign(base(proto), {
    _pendingWrite: null, _list: el(), _write: el(), _cancel: el(), _render() {},
  });
}
function ids(dialog) {
  return [dialog._current, ...dialog._queue].filter(Boolean)
    .map((req) => req.id + '@' + (req.ownerKey || ''));
}

function loadApp(root, permEl, questionEl) {
  const source = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8');
  const handler = section(source, '  window.satr.onEvent((ev) => {',
    '  });\n\n  // ---------- شريط عمليات الخلفية:', true);
  const closePerm = section(source, '  function closePermDialog() {',
    '\n\n  // ---------- أسئلة الاختيار العربية:');
  const closeQuestion = section(source, '  function closeQuestionDialog() {',
    '\n\n  // ---------- المهام المحفوظة:');
  const release = section(source, '  function releaseRunControls() {', '\n\n  function endRun()');
  let onEvent;
  const currentBlock = { done: false, resultHandled: false, finish() {}, showRetry() {}, error() {} };
  const sandbox = {
    console, queueMicrotask: (fn) => fn(),
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    window: { satr: { onEvent(fn) { onEvent = fn; } } },
    uiEventCounts: { total: 0, byType: Object.create(null) }, permEl, questionEl, currentBlock,
    busy: true, runningEngine: 'sdk', previewDirty: false, sessionId: '', sessionCwd: '', conversationId: '',
    sendBtn: { textContent: '', classList: { remove() {} } }, input: { focus() {}, value: '' },
    previewEl: { hideHandoff() {}, hideSecretRequest() {}, reloadIfLive() {} },
    chatEl: { notifyAttention() {}, lastAssistantText: () => '', notifyTurnDone() {} },
    agentsLiveEl: null, $: () => ({ value: 'sdk', textContent: '' }),
    permDetailText: () => '', addNotice() {}, acceptConversationEvent() {}, closeElicitationDialog() {},
    refreshAwarenessContext() {}, deadSessionRecovery: () => false, isClaudeAuthError: () => false,
    claudeAuthErrorMessage: () => '', shortSessionLabel: (v) => v, paintDesktopControl() {},
    formatDownTime: () => '', applyEngineCommands() {},
  };
  vm.runInNewContext([handler, closePerm, closeQuestion, release].join('\n'), sandbox,
    { filename: 'app-sdk-control-production.js' });
  assert.equal(typeof onEvent, 'function', 'تعذّر تحميل معالج app.js الحقيقي');
  return {
    dispatch: (event) => onEvent(event),
    result() {
      currentBlock.done = false; currentBlock.resultHandled = false;
      sandbox.runningEngine = 'sdk'; sandbox.busy = true; onEvent({ type: 'result' });
    },
  };
}


function mainOwned(events) {
  const permission = events.find((ev) => ev && ev.type === 'permission_request'
    && /^sdk:[0-9]+$/.test(ev.ownerKey || ''));
  const question = events.find((ev) => ev && ev.type === 'question_request'
    && /^sdk:[0-9]+$/.test(ev.ownerKey || ''));
  assert.ok(permission, 'لم يصل permission_request المملوك من main إلى app');
  assert.ok(question, 'لم يصل question_request المملوك من main إلى app');
  assert.equal(permission.ownerKey, question.ownerKey, 'الإذن والسؤال ليسا لمالك Query واحد');
  return { permission, question, owner: permission.ownerKey };
}

function checkAppControlEvents(root, mainEvents) {
  const { permission, question, owner: ownerA } = mainOwned(mainEvents);
  const perm = permissionDialog(loadDialogPrototype(root, 'perm-dialog.js', 'SatrPermDialog'));
  const questions = questionDialog(loadDialogPrototype(root, 'question-dialog.js', 'SatrQuestionDialog'));
  const app = loadApp(root, perm, questions);
  let passed = 0;
  const ok = (value, message) => { passed += 1; assert.ok(value, message); };
  const ownerB = 'sdk:902';
  const saved = 'saved-task:probe';
  const q = [{ question: 'اختبار', header: '', options: [
    { label: 'نعم', description: '' }, { label: 'لا', description: '' },
  ], multiSelect: false }];

  // أول حدثين من main runtime نفسه؛ البقية توسع الطابور عبر معالج app الحقيقي.
  app.dispatch({ ...permission, id: 'pa1' });
  app.dispatch({ ...permission, id: 'pa2' });
  app.dispatch({ ...permission, id: 'pa3' });
  app.dispatch({ ...question, id: 'qa1', questions: q });
  app.dispatch({ ...question, id: 'qa2', questions: q });
  app.dispatch({ ...question, id: 'qa3', questions: q });
  app.dispatch({ type: 'permission_request', id: 'pb1', tool: 'Edit', ownerKey: ownerB });
  app.dispatch({ type: 'permission_request', id: 'pb2', tool: 'Edit', ownerKey: ownerB });
  app.dispatch({ type: 'question_request', id: 'qb1', questions: q, ownerKey: ownerB });
  // جسر saved-tasks في app يمرر مالكه إلى المكوّن مباشرة، لا عبر satr:event.
  perm.request({ id: 'ps1', tool: 'Edit', ownerKey: saved });
  questions.ask({ id: 'qs1', questions: q, ownerKey: saved });

  const p0 = ids(perm); const q0 = ids(questions);
  app.result(); // B result
  ok(JSON.stringify(ids(perm)) === JSON.stringify(p0), 'نتيجة B سحبت إذن A أو مالكاً آخر');
  ok(JSON.stringify(ids(questions)) === JSON.stringify(q0), 'نتيجة B سحبت سؤال A أو مالكاً آخر');
  app.result(); // A result: المالك لا يغلق قبل خروج Query
  ok(JSON.stringify(ids(perm)) === JSON.stringify(p0), 'نتيجة A سحبت إذناً قبل خروج Query');
  ok(JSON.stringify(ids(questions)) === JSON.stringify(q0), 'نتيجة A سحبت سؤالاً قبل خروج Query');

  app.dispatch({ type: 'sdk_control_request_closed', id: 'pa2', kind: 'permission', ownerKey: ownerA });
  ok(!ids(perm).includes('pa2@' + ownerA) && ids(perm).includes('pa3@' + ownerA),
    'إغلاق الإذن لم يقتصر على id+owner');
  app.dispatch({ type: 'sdk_control_request_closed', id: 'qa2', kind: 'question', ownerKey: ownerA });
  ok(!ids(questions).includes('qa2@' + ownerA) && ids(questions).includes('qa1@' + ownerA),
    'إغلاق السؤال لم يقتصر على id+owner');

  const pi = ids(perm); const qi = ids(questions);
  app.dispatch({ type: 'sdk_control_request_closed', id: 'pb2', kind: 'permission', ownerKey: 'bad' });
  app.dispatch({ type: 'sdk_control_request_closed', id: 'pb2', kind: 'bad', ownerKey: ownerB });
  app.dispatch({ type: 'sdk_control_owner_closed', ownerKey: 'sdk:bad' });
  ok(JSON.stringify(ids(perm)) === JSON.stringify(pi)
    && JSON.stringify(ids(questions)) === JSON.stringify(qi),
  'مالك أو kind غير صالح مسّ الطابور');

  app.dispatch({ type: 'mobile_decision', envelope_id: 'pb1', ownerKey: ownerB, decision: 'deny' });
  ok(!ids(perm).includes('pb1@' + ownerB) && ids(perm).includes('pb2@' + ownerB)
    && ids(perm).includes('ps1@' + saved), 'قرار الجوال أغلق أكثر من طلبه');

  app.dispatch({ type: 'sdk_control_owner_closed', ownerKey: ownerA });
  ok(!ids(perm).some((id) => id.endsWith('@' + ownerA))
    && ids(perm).includes('pb2@' + ownerB) && ids(perm).includes('ps1@' + saved),
  'إغلاق A لم ينظف أذوناته وحدها');
  ok(!ids(questions).some((id) => id.endsWith('@' + ownerA))
    && ids(questions).includes('qb1@' + ownerB) && ids(questions).includes('qs1@' + saved),
  'إغلاق A لم ينظف أسئلته وحدها');
  return passed;
}

module.exports = { checkAppControlEvents, loadDialogPrototype };
