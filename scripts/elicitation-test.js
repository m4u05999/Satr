#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const VALID_ID = 'el_' + 'a'.repeat(32);
const SECRET_SENTINEL = 'sk-proj-' + 'A'.repeat(24);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function formRequest(overrides = {}) {
  return {
    serverName: '  موصّل التجربة\u202e  ',
    message: 'رسالة داخلية لا ينبغي بثها',
    mode: 'form',
    title: 'عنوان داخلي',
    displayName: 'اسم داخلي',
    description: 'وصف داخلي',
    url: 'https://should-not-leak.invalid/',
    requestedSchema: {
      type: 'object',
      properties: {
        'project\u0000\u0085\u202eName': {
          type: 'string',
          title: '  اسم المشروع\u202e  ',
          description: '  وصف غير سرّي\nللحقل  ',
        },
      },
    },
    ...overrides,
  };
}

function urlRequest(overrides = {}) {
  return {
    serverName: 'oauth-server',
    message: 'افتح صفحة المصادقة',
    mode: 'url',
    url: 'https://example.invalid/oauth?state=opaque-state',
    elicitationId: 'oauth-request-1',
    ...overrides,
  };
}

function loadMainHandler() {
  const source = read('electron/main.js');
  const start = source.indexOf('const elicitationOpening = new Set();');
  const end = source.indexOf('// رد الواجهة على التسليم البشري browser_handoff', start);
  assert.ok(start >= 0 && end > start, 'تعذّر استخراج IPC الخاص بـ elicitation من main.js');
  const sandbox = {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'satr:elicitationDone');
        sandbox.exported.handler = handler;
      },
    },
    claudeElicitation: require('../electron/elicitation'),
    shell: {
      async openExternal(url) { sandbox.opened.push(url); },
    },
    opened: [],
    emitted: [],
    exported: {},
  };
  vm.runInNewContext(`
    let currentRun = null;
    const emitToWindow = (event) => emitted.push(event);
    ${source.slice(start, end)}
    exported.setRun = (run) => { currentRun = run; };
  `, sandbox, { filename: 'main-elicitation-extract.js' });
  return sandbox;
}

async function testRequestEventAndSanitization() {
  const elicitation = require('../electron/elicitation');
  const events = [];
  const controller = elicitation.createElicitationController({ emit: (event) => events.push(event) });
  const resultPromise = controller.handle(formRequest(), { signal: new AbortController().signal });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.deepEqual(Object.keys(event).sort(), ['fields', 'id', 'mode', 'server', 'type']);
  assert.match(event.id, elicitation.SAFE_ID);
  assert.equal(event.type, 'elicitation_request');
  assert.equal(event.mode, 'form');
  assert.equal(event.server, 'موصّل التجربة');
  assert.deepEqual(plain(event.fields), [{
    name: 'project Name',
    label: 'اسم المشروع — وصف غير سرّي للحقل',
  }]);
  assert.doesNotMatch(JSON.stringify(event), /رسالة داخلية|عنوان داخلي|اسم داخلي|should-not-leak/);
  assert.doesNotMatch(JSON.stringify(event), /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);

  const reply = controller.resolve(event.id, 'accept', { 'project Name': '  قيمة\u0085\u202e\nآمنة  ' });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(plain(await resultPromise), {
    action: 'accept',
    content: { 'project\u0000\u0085\u202eName': 'قيمة آمنة' },
  });
  assert.equal(controller.pendingCount(), 0);

  const astralName = '😀'.repeat(100);
  const astralEvents = [];
  const astralController = elicitation.createElicitationController({ emit: (item) => astralEvents.push(item) });
  const astralPending = astralController.handle(formRequest({
    requestedSchema: { type: 'object', properties: { [astralName]: { type: 'string' } } },
  }), {});
  assert.equal(astralEvents[0].fields[0].name, astralName, 'تغير اسم field ذي astral code points');
  assert.deepEqual(astralController.resolve(astralEvents[0].id, 'accept', { [astralName]: 'ok' }), { ok: true });
  assert.deepEqual(plain(await astralPending), { action: 'accept', content: { [astralName]: 'ok' } });
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
    `field${index}`,
    { type: 'string' },
  ]));
  assert.equal(elicitation.sanitizeElicitationRequest(formRequest({
    requestedSchema: { type: 'object', properties: tooMany },
  })).ok, false, 'مرّ أكثر من 20 حقلاً');
  assert.equal(elicitation.sanitizeElicitationRequest(formRequest({
    requestedSchema: { type: 'object', properties: { count: { type: 'number' } } },
  })).ok, false, 'مر نوع حقل لا يدعمه الحوار النصي');
  assert.equal(elicitation.safeUrl('http://example.com/auth'), '', 'قُبل HTTP بعيد');
  assert.equal(elicitation.safeUrl('http://localhost:8787/auth'), 'http://localhost:8787/auth');
  assert.equal(elicitation.safeUrl('https://user:pass@example.com/auth'), '', 'قُبل URL يحوي اعتماداً');
  const urlPrefix = 'https://example.invalid/';
  assert.equal(elicitation.safeUrl(urlPrefix + 'a'.repeat(2049 - urlPrefix.length)), '', 'قُص URL متجاوز بدلاً من رفضه');
  assert.equal(elicitation.sanitizeElicitationRequest(urlRequest({ elicitationId: 'bad\u0085id' })).ok, false,
    'مر محرف تحكم C1 في elicitationId');
}

async function testSecretsFailClosed() {
  const elicitation = require('../electron/elicitation');
  for (const fieldName of ['password', 'password1', 'passwordfield', 'pwd', 'mytoken', 'oauthtoken', 'accessToken', 'IDToken', 'apiKey', 'apikey', 'APIKey', 'api\u202eKey', 'keymaterial', 'DBPassword', 'JWTSecret', 'clientSecret', 'usercredentialvalue']) {
    const events = [];
    const controller = elicitation.createElicitationController({ emit: (event) => events.push(event) });
    const result = await controller.handle(formRequest({
      requestedSchema: { type: 'object', properties: { [fieldName]: { type: 'string' } } },
    }), {});
    assert.deepEqual(result, { action: 'decline' }, `لم يُرفض الحقل السري ${fieldName}`);
    assert.equal(events.some((event) => event.type === 'elicitation_request'), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'stderr');
    assert.match(events[0].text, /\/mcp/);
    assert.match(events[0].text, /browser_handoff/);
  }

  const serverEvents = [];
  const serverController = elicitation.createElicitationController({ emit: (event) => serverEvents.push(event) });
  assert.deepEqual(await serverController.handle(formRequest({ serverName: SECRET_SENTINEL }), {}), { action: 'decline' });
  assert.equal(serverEvents.some((event) => event.type === 'elicitation_request'), false);
  assert.ok(!JSON.stringify(serverEvents).includes(SECRET_SENTINEL), 'تسرّب سر من اسم الخادم');

  const contextEvents = [];
  const contextController = elicitation.createElicitationController({ emit: (event) => contextEvents.push(event) });
  assert.deepEqual(await contextController.handle(formRequest({
    message: 'enterapitokenhere',
    requestedSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }), {}), { action: 'decline' });
  assert.equal(contextEvents.some((event) => event.type === 'elicitation_request'), false,
    'مر طلب سرّي موصوف في سياق form العلوي');
  const metadataEvents = [];
  const metadataController = elicitation.createElicitationController({ emit: (event) => metadataEvents.push(event) });
  const metadataResult = await metadataController.handle(formRequest({
    requestedSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: `قيمة ${SECRET_SENTINEL}` } },
    },
  }), {});
  assert.deepEqual(metadataResult, { action: 'decline' });
  assert.ok(!JSON.stringify(metadataEvents).includes(SECRET_SENTINEL), 'تسرّب سر من metadata الحقل');

  const contentEvents = [];
  const contentController = elicitation.createElicitationController({ emit: (event) => contentEvents.push(event) });
  const pending = contentController.handle(formRequest({
    requestedSchema: { type: 'object', properties: { note: { type: 'string' } } },
  }), {});
  const event = contentEvents.find((item) => item.type === 'elicitation_request');
  const resolved = contentController.resolve(event.id, 'accept', { note: SECRET_SENTINEL });
  assert.deepEqual(resolved, { ok: true, declined: true, error: 'secret' });
  assert.deepEqual(await pending, { action: 'decline' });
  assert.ok(!JSON.stringify(contentEvents).includes(SECRET_SENTINEL), 'تسرّبت قيمة سرية إلى الحدث');
}

async function testLifecycleAndUrlDedupe() {
  const elicitation = require('../electron/elicitation');
  const stopEvents = [];
  const stopController = elicitation.createElicitationController({ emit: (event) => stopEvents.push(event) });
  const stopped = stopController.handle(formRequest(), {});
  assert.equal(stopController.pendingCount(), 1);
  stopController.declineAll();
  assert.deepEqual(await stopped, { action: 'decline' });
  assert.equal(stopController.pendingCount(), 0);
  assert.deepEqual(await stopController.handle(formRequest(), {}), { action: 'decline' });

  const throwingController = elicitation.createElicitationController({ emit: () => { throw new Error('renderer gone'); } });
  assert.deepEqual(await throwingController.handle(formRequest(), {}), { action: 'decline' });
  assert.equal(throwingController.pendingCount(), 0, 'بقي طلب معلق بعد فشل بث الحدث');

  const abortEvents = [];
  const abortController = elicitation.createElicitationController({ emit: (event) => abortEvents.push(event) });
  const signalController = new AbortController();
  const aborted = abortController.handle(formRequest(), { signal: signalController.signal });
  signalController.abort();
  assert.deepEqual(await aborted, { action: 'decline' });
  assert.equal(abortController.pendingCount(), 0);

  const urlEvents = [];
  const urlController = elicitation.createElicitationController({ emit: (event) => urlEvents.push(event) });
  const requests = [1, 2, 3].map(() => urlController.handle(urlRequest(), {}));
  assert.equal(urlEvents.filter((event) => event.type === 'elicitation_request').length, 1,
    'لم تُدمج استدعاءات URL المتكررة من CLI');
  const urlEvent = urlEvents[0];
  assert.deepEqual(Object.keys(urlEvent).sort(), ['fields', 'id', 'mode', 'server', 'type', 'url']);
  assert.deepEqual(urlEvent.fields, []);
  const preAborted = new AbortController();
  preAborted.abort();
  assert.deepEqual(await urlController.handle(urlRequest(), { signal: preAborted.signal }), { action: 'decline' });
  const duplicateAbort = new AbortController();
  const abortedDuplicate = urlController.handle(urlRequest(), { signal: duplicateAbort.signal });
  duplicateAbort.abort();
  assert.deepEqual(await abortedDuplicate, { action: 'decline' });
  assert.deepEqual(urlController.resolve(urlEvent.id, 'accept'), { ok: true });
  const results = await Promise.all(requests);
  assert.deepEqual(plain(results), [{ action: 'accept' }, { action: 'accept' }, { action: 'accept' }]);
  assert.deepEqual(await urlController.handle(urlRequest(), {}), { action: 'accept' });
  assert.equal(urlEvents.length, 1, 'أعيد بث URL نفسه بعد حسمه');
  assert.deepEqual(await urlController.handle(urlRequest({
    url: 'https://different.invalid/oauth',
  }), {}), { action: 'decline' }, 'قُبل URL مختلف بإعادة استخدام elicitationId');
  assert.equal(urlEvents.filter((event) => event.type === 'elicitation_request').length, 1,
    'بُث حوار ثانٍ لمعرّف URL معاد الاستخدام برابط مختلف');

  const identityEvents = [];
  const identityController = elicitation.createElicitationController({ emit: (event) => identityEvents.push(event) });
  const firstIdentity = identityController.handle(urlRequest({ serverName: 'same\u202e' }), {});
  const secondIdentity = identityController.handle(urlRequest({ serverName: 'same' }), {});
  const identityRequests = identityEvents.filter((event) => event.type === 'elicitation_request');
  assert.equal(identityRequests.length, 2, 'تصادمت هويتان خام مختلفتان بعد تنقية اسم الخادم');
  identityController.resolve(identityRequests[0].id, 'decline');
  identityController.resolve(identityRequests[1].id, 'decline');
  assert.deepEqual(plain(await Promise.all([firstIdentity, secondIdentity])), [
    { action: 'decline' }, { action: 'decline' },
  ]);
}

function testAgentIsolation() {
  const { applyClaudeElicitation, isUnsupportedElicitationResult } = require('../electron/agent');
  const handler = async () => ({ action: 'decline' });
  const regular = {};
  assert.equal(applyClaudeElicitation(regular, handler, null), true);
  assert.equal(regular.onElicitation, handler);
  for (const policy of ['text-only', 'read-only-planner', 'ops-room']) {
    const isolated = {};
    assert.equal(applyClaudeElicitation(isolated, handler, policy), false);
    assert.equal(Object.prototype.hasOwnProperty.call(isolated, 'onElicitation'), false,
      `تسرّب onElicitation إلى ${policy}`);
  }
  assert.equal(isUnsupportedElicitationResult({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'Client does not support form elicitation.' }] },
  }), true);
  assert.equal(isUnsupportedElicitationResult({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Client does not support url elicitation.' }] }] },
  }), true);
  assert.equal(isUnsupportedElicitationResult({
    type: 'user', message: { content: [{ type: 'tool_result', content: SECRET_SENTINEL }] },
  }), false);
  const source = read('electron/agent.js');
  assert.match(source, /applyClaudeElicitation\(options, elicitationController\.handle, internalPolicy\)/);
  assert.ok((source.match(/elicitationController\.declineAll\(\)/g) || []).length >= 2,
    'لا تُحسم الطلبات في الإيقاف والتنظيف النهائي');
}

async function testMainIpcContract() {
  const sandbox = loadMainHandler();
  const calls = [];
  let pending = { mode: 'form', url: '' };
  const run = {
    peekElicitation(id) { return id === VALID_ID ? pending : null; },
    resolveElicitation(...args) { calls.push(args); return { ok: true }; },
  };
  sandbox.exported.setRun(run);
  const invoke = (payload) => sandbox.exported.handler({}, payload);

  assert.deepEqual(plain(await invoke(null)), { ok: false });
  assert.deepEqual(plain(await invoke({ id: 'el_bad', action: 'accept', content: {} })), { ok: false });
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'cancel' })), { ok: false });
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'decline', extra: true })), { ok: false });
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'decline', content: {} })), { ok: false });
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'decline' })), { ok: true });
  assert.deepEqual(calls.pop(), [VALID_ID, 'decline']);

  const twentyOne = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`f${index}`, 'v']));
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'accept', content: twentyOne })), {
    ok: false, error: 'too_many_fields',
  });
  const longValue = `  \u0085${'x'.repeat(2005)}\u202e\n  `;
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'accept', content: { note: longValue } })), { ok: true });
  const accepted = calls.pop();
  assert.equal(accepted[0], VALID_ID);
  assert.equal(accepted[1], 'accept');
  assert.equal(accepted[2].note.length, 2000);
  assert.doesNotMatch(accepted[2].note, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);

  const emittedBeforeSecret = sandbox.emitted.length;
  const secretReply = plain(await invoke({ id: VALID_ID, action: 'accept', content: { note: SECRET_SENTINEL } }));
  assert.deepEqual(secretReply, { ok: true, declined: true, error: 'secret' });
  assert.deepEqual(calls.pop(), [VALID_ID, 'decline']);
  assert.equal(sandbox.emitted.length, emittedBeforeSecret + 1);
  assert.ok(!JSON.stringify(sandbox.emitted).includes(SECRET_SENTINEL), 'تسرّب السر في رد/حدث main');

  pending = { mode: 'url', url: 'https://example.invalid/oauth?state=internal-only' };
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'accept', content: {} })), { ok: false });
  let releaseOpen;
  sandbox.shell.openExternal = async (url) => {
    sandbox.opened.push(url);
    await new Promise((resolve) => { releaseOpen = resolve; });
  };
  const firstOpen = invoke({ id: VALID_ID, action: 'accept' });
  await Promise.resolve();
  assert.deepEqual(plain(await invoke({ id: VALID_ID, action: 'accept' })), { ok: false, error: 'in_flight' });
  releaseOpen();
  const urlReply = plain(await firstOpen);
  assert.deepEqual(urlReply, { ok: true });
  assert.deepEqual(sandbox.opened, ['https://example.invalid/oauth?state=internal-only']);
  assert.deepEqual(calls.pop(), [VALID_ID, 'accept']);
  assert.ok(!JSON.stringify(urlReply).includes('internal-only'), 'عاد URL في رد IPC');

  sandbox.shell.openExternal = async () => { throw new Error(SECRET_SENTINEL); };
  const failedOpen = plain(await invoke({ id: VALID_ID, action: 'accept' }));
  assert.deepEqual(failedOpen, { ok: false, error: 'open_failed' });
  assert.equal(calls.length, 0, 'حُسم الطلب قبولاً رغم فشل فتح المتصفح');
}

function testPublicContracts() {
  const preload = read('electron/preload.js');
  const main = read('electron/main.js');
  const app = read('src/ui/app.js');
  const html = read('src/index.html');
  const component = read('src/ui/components/elicitation-dialog.js');
  const probe = read('scripts/elicitation-probe.js');
  const docs = read('CLAUDE.md');
  const packageJson = JSON.parse(read('package.json'));
  const fullSuite = read('scripts/full-suite.js');

  assert.match(preload, /elicitationDone:\s*\(id, action, content\)\s*=>\s*ipcRenderer\.invoke\('satr:elicitationDone'/);
  assert.doesNotMatch(preload, /openElicitation|elicitationOpen|openExternal/);
  assert.match(main, /obj\.type === 'elicitation_request'[\s\S]*?fields: obj\.fields[\s\S]*?: obj;/,
    'لا يُحذف URL من نسخة المراقبين');
  assert.match(app, /ev\.type === 'elicitation_request'/);
  assert.match(app, /closeElicitationDialog\(\)/);
  assert.match(html, /<satr-elicitation-dialog><\/satr-elicitation-dialog>/);
  assert.match(html, /ui\/components\/elicitation-dialog\.js/);
  assert.match(component, /افتح في متصفح النظام/);
  assert.match(component, /window\.satr\.elicitationDone\(request\.id, action, content\)/);
  assert.match(component, /input\.maxLength = 2000/);
  assert.match(component, /_scrubInputs\(\)/);
  assert.match(component, /this\._cancel\.addEventListener\('click', \(\) => this\._decline\(\)\)/);
  assert.match(component, /event\.key === 'Escape'/);
  assert.match(component, /this\._resolve\('decline'/);
  assert.match(component, /codePointLength\(field\.name\) > 160/);
  assert.match(component, /name: field\.name/);
  assert.match(component, /<bdi class="tech">\/mcp<\/bdi>/);
  assert.match(component, /\.textContent\s*=/);
  assert.doesNotMatch(component, /window\.open|<a\b|<style\b|style\s*=/i);

  assert.match(probe, /UrlElicitationRequiredError/);
  assert.match(probe, /async function runStdioServer/);
  assert.match(probe, /defaultWithoutHandler/);
  assert.match(probe, /callbackCalls/);
  assert.doesNotMatch(probe, /console\.log\([^\n]*(?:content|resultText)/,
    'المسبار يطبع محتوى الإدخال أو النتيجة الخام');

  assert.equal(packageJson.scripts['test:elicitation'], 'node scripts/elicitation-test.js');
  assert.match(fullSuite, /'test:claude-models',\s*\r?\n\s*'test:elicitation',/);
  assert.match(docs, /elicitation_request/);
  assert.match(docs, /satr:elicitationDone/);
  assert.match(docs, /callbackCalls:4|4.*استدعاءات/);
}

async function main() {
  await testRequestEventAndSanitization();
  await testSecretsFailClosed();
  await testLifecycleAndUrlDedupe();
  testAgentIsolation();
  await testMainIpcContract();
  testPublicContracts();
  console.log('elicitation-test: ok — عقد الحدث وIPC، تنقية fail-closed، الأسرار، URL، الإيقاف، العزل والتدهور');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});