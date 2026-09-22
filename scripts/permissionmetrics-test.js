'use strict';
// حارس سلوكي: القياس والبوابات الإنتاجية؛ لا يتصل بمحرك أو موقع.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require(process.env.SATR_METRICS_MODULE_FILE || '../electron/permissionmetrics');
const browserpolicy = require('../electron/browserpolicy');
const browserorigin = require('../electron/browserorigin');
const { askFlags, decideAutoApproval } = require('../electron/autogate');
const root = path.join(__dirname, '..');
const sourceRoot = process.env.SATR_METRICS_SOURCE_ROOT || root;
const read = (file) => fs.readFileSync(path.join(sourceRoot, file), 'utf8').replace(/\r\n/g, '\n');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Production section missing: ' + start);
  return source.slice(a, b);
}
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
let time = 100;
const metrics = create({ now: () => time });
test('untracked reply still reaches original gate', () => {
  let calls = 0;
  assert.equal(metrics.reply('untracked', 'allow_once', () => { calls++; return true; }), true);
  assert.equal(calls, 1);
});
test('duplicate request preserves initial wait; synchronous SDK close is approval', () => {
  metrics.request('owner', 'p1', 'sdk', 'mcp__satr-terminal__browser_click', ['origin_trust']);
  time = 150;
  metrics.request('owner', 'p1', 'sdk', 'browser_click', ['origin_trust']);
  time = 300;
  assert.equal(metrics.reply('p1', 'allow_once', () => { metrics.close('p1', 'owner'); return true; }), true);
  const shot = metrics.snapshot();
  assert.equal(shot.totalStarted, 1);
  assert.equal(shot.completed[0].waitMs, 200);
  assert.equal(shot.completed[0].decision, 'allow_once');
  assert.equal(shot.completed[0].tool, 'browser_click');
});
test('stale reply, denial, cancellation and other owner remain distinct', () => {
  metrics.request('owner', 'p2', 'codex', 'browser_type');
  metrics.request('other', 'p3', 'kimi-code', 'browser_evaluate', ['sensitive_action']);
  assert.equal(metrics.reply('p2', 'deny', () => false), false);
  assert.equal(metrics.snapshot().pending.length, 2);
  metrics.reply('p2', 'deny', () => true);
  metrics.closeOwner('owner');
  assert.equal(metrics.snapshot().pending.length, 1);
  metrics.closeOwner('other');
  assert.equal(metrics.snapshot().counts.deny, 1);
  assert.equal(metrics.snapshot().counts.cancelled, 1);
});
test('owner close during reply and callback failure keep original return or error', () => {
  metrics.request('owner', 'p4', 'sdk', 'Bash');
  metrics.reply('p4', 'allow_scope', () => { metrics.closeOwner('owner'); return true; });
  assert.equal(metrics.snapshot().counts.allow_scope, 1);
  metrics.request('owner', 'p5', 'sdk', 'Bash');
  const error = new Error('synthetic callback error');
  assert.throws(() => metrics.reply('p5', 'allow_once', () => { metrics.close('p5'); throw error; }), (e) => e === error);
  assert.equal(metrics.snapshot().counts.cancelled, 2);
});
test('unknown payloads cannot enter snapshot; snapshots are detached', () => {
  const marker = 'SYNTHETIC_PRIVATE_VALUE';
  metrics.request(marker, marker, marker, marker, [marker, 'sensitive_action', 'sensitive_action']);
  const first = metrics.snapshot();
  assert.ok(!JSON.stringify(first).includes(marker));
  assert.deepEqual(first.pending[0].reasons, ['other', 'sensitive_action']);
  first.pending[0].reasons.push(marker);
  first.completed[0].reasons.push(marker);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes(marker));
  metrics.close(marker);
});
test('collision and old close do not cancel the new owner', () => {
  const m = create();
  m.request('a', 'same', 'sdk', 'Bash'); m.request('b', 'same', 'codex', 'Edit');
  assert.equal(m.close('same', 'a'), false);
  assert.equal(m.snapshot().interrupted, 1);
  assert.equal(m.snapshot().pending.length, 1);
});
test('bounded retention reports loss and evicted requests still reach gate', () => {
  const m = create();
  for (let i = 0; i < 300; i++) m.request('owner', 'q' + i, 'sdk', 'Bash');
  assert.equal(m.snapshot().pending.length, 256);
  assert.equal(m.snapshot().evictedPending, 44);
  let called = false;
  m.reply('q0', 'allow_once', () => { called = true; return true; });
  assert.equal(called, true);
  m.closeOwner('owner');
  for (let i = 0; i < 600; i++) {
    m.request('owner', 'r' + i, 'codex', 'Edit', ['tool_policy']);
    m.reply('r' + i, 'allow_once', () => true);
  }
  const shot = m.snapshot();
  assert.equal(shot.completed.length, 512);
  assert.equal(shot.evictedCompleted, 344);
  assert.equal(shot.totalCompleted, 856);
  assert.equal(shot.reasonCounts.tool_policy, 512);
});
test('monotonic clock and malformed key do not alter gate behavior', () => {
  metrics.request('owner', 'clock', 'sdk', 'Bash');
  time = -1; metrics.close('clock');
  assert.equal(metrics.snapshot().completed.at(-1).waitMs, 0);
  assert.equal(metrics.request('owner', 'x'.repeat(161), 'sdk', 'Bash'), false);
  assert.equal(metrics.reply('x'.repeat(161), 'allow_once', () => true), true);
});

// استخراج مواضع السؤال الفعلية، بما فيها قرار الإعفاء السابق لها.
async function gate(engine, scenario) {
  const file = engine === 'sdk' ? 'agent' : engine === 'codex' ? 'codex' : 'kimi';
  const source = read('electron/' + file + '.js');
  const events = [], pending = new Map();
  const actionBudget = browserpolicy.createActionBudget(scenario.exhausted ? 1 : 40);
  if (scenario.exhausted) actionBudget.consume('browser_click');
  const currentUrl = scenario.untrusted ? 'https://unknown.test/' : 'https://trusted.test/';
  const tool = scenario.tool || 'browser_click';
  const input = scenario.input || { ref: 's1:e1' };
  const context = scenario.context || {};
  const sandbox = { browserpolicy, browserorigin, Set, Promise, askFlags, decideAutoApproval,
    actionBudget, browserControl: scenario.control !== false,
    permissionMode: scenario.bypass ? 'bypassPermissions' : 'default',
    trustedBrowserOrigins: new Set(['https://trusted.test']), trustedOrigins: new Set(['https://trusted.test']),
    remembered: () => false, alwaysAllowed: new Set(), turnAllowed: new Set(),
    mcpPerms: pending, pendingMcpPermissions: pending, pending,
    mcpPermSeq: 0, permissionSeq: 0, toolUseID: 'test-permission', agentID: null,
    defaultToNo: false, suppressAlwaysAllowRule: false, signal: null, externalBrowserCmd: false,
    preview: { currentUrl: () => currentUrl, browserActionContext: async () => context },
    emit(event) {
      events.push(event);
      const entry = pending.get(event.id);
      if (entry) entry.resolve(true);
    },
    waitForSdkControl(map, id, entry, event) { events.push(event); return { behavior: 'allow', updatedInput: input }; },
    desktop: { permissionDetail: () => '' }, DESKTOP_TOOL_RE: /^mcp__satr-desktop__/,
  };
  for (const key of ['PORTABLE_SKILL_TOOLS', 'READ_ONLY_VERIFY_TOOLS', 'MEMORY_PROPOSAL_TOOLS',
    'BACKGROUND_READ_TOOLS', 'PROMO_READ_TOOLS', 'BROWSER_AUTO_TOOLS', 'NEVER_TURN_TOOLS', 'NEVER_ALWAYS_TOOLS']) sandbox[key] = new Set();
  vm.createContext(sandbox);
  let result;
  if (engine === 'sdk') {
    const body = section(source, '      const browserClass = browserorigin.classifyBrowserTool(toolName);', '\n    },\n  };');
    const fn = vm.runInContext('(async function(toolName, input) {' + body + '\n})', sandbox);
    result = await fn('mcp__satr-terminal__' + tool, input);
    assert.equal(result.behavior, 'allow');
  } else {
    const end = engine === 'codex' ? '\nconst TESTSPRITE_JOB_STATES' : '\nfunction createRpc';
    vm.runInContext(section(source, 'function shouldAutoApproveMcp(', end), sandbox);
    let fn;
    if (engine === 'codex') {
      const start = 'requestPermission: (toolName, input, access, neverAlways, target, currentUrl, pageContext, rawInput)';
      const code = section(source, start, '\n      }),').trim().replace(/^requestPermission: /, '') + '\n      })';
      fn = vm.runInContext('(' + code + ')', sandbox);
    } else {
      fn = vm.runInContext('(' + section(source, 'function requestMcpPermission(', '    function requestMcpHandoff(').trim() + ')', sandbox);
    }
    result = await fn(tool, input, 'browser', false, currentUrl, currentUrl, context, input);
    assert.equal(result, true);
  }
  return { events, used: actionBudget.snapshot().used };
}
async function main() {
  const scenarios = [
    { name: 'trusted routine action', reasons: [] },
    { name: 'origin trust', untrusted: true, reasons: ['origin_trust'] },
    { name: 'sensitive submit', context: { isSubmit: true }, reasons: ['sensitive_action'] },
    { name: 'evaluate', tool: 'browser_evaluate', input: { expression: '1+1' }, reasons: ['sensitive_action'] },
    { name: 'form review', tool: 'browser_fill_form', input: { fields: [] }, reasons: ['explicit_form_review'] },
    { name: 'budget', exhausted: true, reasons: ['action_budget'] },
    { name: 'control off', control: false, reasons: ['browser_control_off'] },
    { name: 'combined causes', untrusted: true, exhausted: true, tool: 'browser_evaluate', input: { expression: 'x'.repeat(1025) }, reasons: ['sensitive_action', 'leak_risk', 'action_budget', 'origin_trust'] },
    { name: 'existing bypass unchanged', bypass: true, context: { isSubmit: true }, reasons: [] },
  ];
  for (const engine of ['sdk', 'codex', 'kimi-code']) for (const scenario of scenarios) {
    const { events } = await gate(engine, scenario);
    assert.equal(events.length, scenario.reasons.length ? 1 : 0, engine + ': gate decision changed: ' + scenario.name);
    if (events.length) assert.deepEqual(Array.from(events[0].permissionReasons), scenario.reasons, engine + ': reasons: ' + scenario.name);
    checks++;
  }
  console.log('PASS production browser gates: 27 cases');
  const mainSource = read('electron/main.js');
  const measured = create();
  let calls = 0;
  const sandbox = { permissionMetrics: measured, savedTaskHost: { isReserved: () => false },
    currentRun: { resolvePermission(id) { calls++; measured.close(id, 'owner'); return true; } },
    currentCliRun: null, sdkBackgroundRuns: new Set(), pendingVerificationPermissions: new Map() };
  vm.createContext(sandbox);
  vm.runInContext(section(mainSource, 'function resolvePermissionThroughCurrentHandles(', '\nfunction mobileDebug('), sandbox);
  measured.request('owner', 'approved', 'sdk', 'Bash');
  assert.equal(sandbox.resolvePermissionThroughCurrentHandles('approved', true, false, false), true);
  assert.equal(measured.snapshot().counts.allow_once, 1);
  assert.equal(sandbox.resolvePermissionThroughCurrentHandles('not-tracked', true, false, false), true);
  assert.equal(calls, 2);
  checks++;
// قناة القراءة تعيد النسخة المنقاة ذاتها، وpreload لا يكشف IPC عاماً.
  const handlers = {};
  vm.runInNewContext(mainSource.match(/^ipcMain.handle\('satr:permissionMetrics'.*$/m)[0], {
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, permissionMetrics: measured,
  });
  let api;
  vm.runInNewContext(read('electron/preload.js'), { require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { api = value; } },
    ipcRenderer: { invoke: (channel) => handlers[channel]() },
  }) });
  assert.deepEqual(api.permissionMetrics(), measured.snapshot());
  assert.ok(!('ipcRenderer' in api));
  checks++;
  console.log('permissionmetrics: ' + checks + ' checks passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
