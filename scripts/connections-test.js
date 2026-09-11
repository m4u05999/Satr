'use strict';

// الاختبار يحقن خدمة خارجية وsafeStorage فقط؛ المخزن والتحقق والتنفيذ ومسار HTTP من الإنتاج.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createManager } = require('../electron/connections');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function post(server, name, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const request = http.request(server.url, { method: 'POST', headers: {
      authorization: 'Bearer ' + server.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function testCodexExit(root) {
  const codexmcp = require('../electron/codexmcp');
  const codex = require('../electron/codex');
  const originalStart = codexmcp.start;
  const previousBinary = process.env.CODEX_BIN;
  const project = path.join(root, 'codex-exit-project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'app-server'), String.raw`'use strict';
const readline = require('node:readline');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, {});
  if (message.method === 'thread/start') reply(message.id, { thread: { id: '019f8353-fe7f-7af2-b937-5337170f5f3e' } });
  if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: '019f8353-fe7f-7af2-b937-5337170f5f3f', status: 'inProgress' } });
    setTimeout(() => process.exit(17), 100);
  }
});
`);
  let context, host, handle;
  let hostStops = 0;
  const events = [];
  const exited = deferred();
  const withTimeout = (promise, ms, fallback) => {
    let timer;
    return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })])
      .finally(() => clearTimeout(timer));
  };
  try {
    process.env.CODEX_BIN = process.execPath;
    codex.resolveCodexBin(true);
    codexmcp.start = async (deps) => {
      context = deps.connectionContext;
      host = await originalStart(deps);
      const stopHost = host.stop;
      host.stop = (...args) => { hostStops++; return stopHost(...args); };
      return host;
    };
    handle = await codex.start({ prompt: 'contract fixture', images: [], sessionId: null, skills: [],
      model: 'gpt-5.6-sol', permissionMode: 'bypassPermissions', browserControl: null,
    }, project, (event) => { events.push(event); if (event.type === 'proc_done') exited.resolve(event); });
    assert(context && context.isActive(), 'لم يُنشأ سياق التوصيلات عبر codex.start الإنتاجي');
    const permission = context.requestPermission({ service: 'github', resource: 'owner/repo', action: 'create_issue', params: { title: 'اختبار الخروج' } });
    const permissionEvent = events.find((event) => event.type === 'permission_request' && event.tool === 'use_project_connection');
    assert(permissionEvent, 'لم يطلب codex.start إذناً صريحاً للتوصيلة في bypass');
    const outcome = await withTimeout(exited.promise, 4000, null);
    assert(outcome, 'لم يخرج app-server الاختباري');
    assert.equal(outcome.code, 17, 'تغير رمز خروج العملية');
    assert.equal(await withTimeout(permission, 350, 'pending'), false, 'Codex exit kept connection permission alive');
    assert.equal(context.isActive(), false, 'Codex exit kept connections active');
    assert.equal(hostStops, 1, 'Codex exit did not close its MCP host');
    assert.equal(handle.resolvePermission(permissionEvent.id, true), false, 'بقي إذن قابل للاستعمال بعد موت العملية');
    assert.equal(events.filter((event) => event.type === 'proc_done').length, 1);
    const reachable = await post(host, 'not_a_tool', {}).then(() => true, () => false);
    assert.equal(reachable, false, 'بقي منفذ MCP قابلاً للاتصال بعد خروج العملية');
  } finally {
    codexmcp.start = originalStart;
    if (host) await host.stop();
    if (handle) await withTimeout(Promise.resolve(handle.stop()).catch(() => {}), 1500, null);
    if (previousBinary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBinary;
    codex.resolveCodexBin(true);
  }
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-connections-'));
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(projectA); fs.mkdirSync(projectB);
  const token = 'synthetic-project-token-1234567890';
  const key = crypto.randomBytes(32);
  let available = true;
  let encryptionThrows = false;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString(plain) {
      if (encryptionThrows) throw new Error(token);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(encrypted) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(-16));
      return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  const calls = [];
  let mode = '';
  let pendingRun = null;
  let pendingAuth = null;
  const provider = {
    id: 'github', label: 'GitHub', loginUrl: 'https://github.com/settings/tokens',
    actions: { inspect: { write: false }, create_issue: { write: true } },
    async authenticate(secret) { calls.push({ kind: 'auth' }); assert.equal(secret, token); if (pendingAuth) await pendingAuth.promise; return { id: 'account-a', label: 'الحساب أ' }; },
    async listResources() { return { resources: [{ id: 'owner/repo', label: 'مستودع ' + token }, { id: 'owner/other', label: 'مستودع آخر' }], truncated: true }; },
    async inspect(secret, resource) {
      calls.push({ kind: 'inspect', resource }); assert.equal(secret, token);
      if (!['owner/repo', 'owner/other'].includes(resource)) throw Object.assign(new Error(token), { status: 403 });
      return { id: resource, label: 'مستودع معلوم', default_branch: 'main' };
    },
    async run(secret, resource, action, params) {
      assert.equal(secret, token); calls.push({ kind: 'run', resource, action, params });
      if (mode === 'expired') throw Object.assign(new Error(token), { code: 'auth_expired' });
      if (mode === 'forbidden') throw Object.assign(new Error(token), { status: 403 });
      if (mode === 'echo-error') throw Object.assign(new Error(token), { connectionCode: token });
      if (pendingRun) return pendingRun.promise;
      if (mode === 'long-data') return { content: 'x'.repeat(32010), truncated: false };
      return { resource, action, content: 'line1\n\tline2\n', summary: 'نتيجة ' + token, authorization: token, nested: { token, harmless: 'بيان آمن' } };
    },
  };
  const services = { github: provider };
  const manager = createManager({ storeDir, safeStorage, services });
  const otherManager = createManager({ storeDir, safeStorage, services });
  const execution = { engine: 'fixture', isActive: () => true };
  const readInput = { service: 'github', resource: 'owner/repo', action: 'inspect' };
  const writeInput = { service: 'github', resource: 'owner/repo', action: 'create_issue', params: { title: 'طلب تجريبي' } };
  const runs = () => calls.filter((item) => item.kind === 'run').length;
  const row = async (project = projectA) => (await manager.list(project, 'fixture')).services[0];
  async function connect(permissions = ['read']) {
    assert.equal((await manager.authenticate(projectA, 'github', token)).ok, true);
    assert.equal((await manager.select(projectA, 'github', 'owner/repo', permissions)).ok, true);
  }
  let server;
  try {
    assert.equal((await manager.list('')).error, 'bad_cwd');
    assert.equal((await manager.list('.')).error, 'bad_cwd');
    assert.equal((await manager.list(projectA + '\\..\\project-b')).error, 'bad_cwd');
    assert.equal((await manager.authenticate(projectA, 'unknown', token)).error, 'bad_service');
    assert.equal((await manager.authenticate(projectA, 'github', 'bad\nvalue')).error, 'bad_token');
    assert.equal((await row()).authStatus, 'disconnected');
    await connect();
    const projectId = (await manager.list(projectA)).projectId;
    const file = path.join(storeDir, projectId + '-github.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert(!raw.includes(token) && !raw.includes('account-a') && !raw.includes('owner/repo'), 'تسرّبت بيانات الاتصال الصريحة إلى القرص');
    assert.equal(JSON.parse(raw).enc, true);
    const listed = await manager.resources(projectA, 'github');
    assert.equal(listed.truncated, true);
    assert(!JSON.stringify(listed).includes(token), 'تسرّب الرمز في بيانات المورد');
    assert.equal((await row(projectB)).account, null, 'انتقل حساب المشروع الأول إلى الثاني');
    assert.equal((await manager.execute(projectB, readInput, execution)).error, 'not_connected');
    const unknownBefore = runs();
    assert.equal((await manager.execute(projectA, { ...readInput, resource: 'owner/unselected' }, execution)).error, 'bad_resource', 'accepted an unselected resource');
    assert.equal(runs(), unknownBefore, 'وصل المورد المرفوض إلى الخدمة');
    assert.equal((await manager.select(projectA, 'github', 'owner/unavailable', ['read'])).error, 'forbidden');
    assert.equal((await row()).resource.id, 'owner/repo', 'اختيار المورد المرفوض بدّل الاتصال السابق');
    assert.equal((await manager.test(projectA, 'github')).ok, true);
    assert.equal((await row()).connectionStatus, 'api-tested');
    assert.equal((await row()).lastEngineUse, null, 'اختبار API ادّعى استعمالاً من المحرك');
    const used = await manager.execute(projectA, readInput, execution);
    assert.equal(used.ok, true);
    assert(!JSON.stringify(used).includes(token), 'تسرّب الرمز من رد الخدمة');
    assert(!Object.hasOwn(used.data, 'authorization'));
    assert.equal(used.data.content, 'line1\n\tline2\n', 'تغيّرت أسطر محتوى الملف');
    mode = 'long-data';
    const longData = await manager.execute(projectA, readInput, execution);
    assert.equal(longData.data.content.length, 32000);
    assert.equal(longData.data.truncated, true, 'قص النواة لم يُعلَن في النتيجة');
    mode = '';
    assert.equal((await row()).lastEngineUse.engine, 'fixture');
    assert.equal((await manager.execute(projectA, writeInput, execution)).error, 'write_not_allowed');
    await manager.select(projectA, 'github', 'owner/repo', ['read', 'write']);
    let asked = 0;
    const deny = { ...execution, requestPermission: async () => { asked++; return false; } };
    const beforeDenied = runs();
    assert.equal((await manager.execute(projectA, writeInput, deny)).error, 'permission_denied');
    assert.equal((await manager.execute(projectA, writeInput, execution)).error, 'permission_denied');
    assert.equal(runs(), beforeDenied, 'الفعل المرفوض وصل إلى الخدمة');
    const allow = { ...execution, permissionMode: 'bypassPermissions', requestPermission: async () => { asked++; return true; } };
    assert.equal((await manager.execute(projectA, writeInput, allow)).ok, true);
    assert.equal((await manager.execute(projectA, writeInput, allow)).ok, true);
    assert.equal(asked, 3, 'أُعيد استعمال إذن سابق لفعل خدمة');
    const mutableInput = JSON.parse(JSON.stringify(writeInput));
    assert.equal((await manager.execute(projectA, mutableInput, { ...execution, requestPermission: async () => {
      mutableInput.action = 'unapproved_action'; mutableInput.params.title = 'بدّل بعد العرض'; return true;
    } })).ok, true);
    assert.equal(calls.at(-1).action, 'create_issue');
    assert.equal(calls.at(-1).params.title, 'طلب تجريبي', 'تغير محتوى الفعل بعد عرض إذنه');
    assert.equal((await manager.execute(projectA, readInput, { ...execution, isActive: () => false })).error, 'inactive');
    mode = 'echo-error';
    const error = await manager.execute(projectA, readInput, execution);
    assert.equal(error.error, 'service_failed'); assert(!JSON.stringify(error).includes(token));
    mode = 'forbidden';
    assert.equal((await manager.execute(projectA, readInput, execution)).error, 'forbidden');
    assert.equal((await row()).authStatus, 'authenticated', 'اختلط 403 بانتهاء المصادقة');
    mode = 'expired';
    assert.equal((await manager.execute(projectA, readInput, execution)).error, 'needs_auth');
    assert.equal((await row()).authStatus, 'needs-auth');
    const expiredBefore = runs();
    assert.equal((await manager.execute(projectA, readInput, execution)).error, 'needs_auth');
    assert.equal(runs(), expiredBefore, 'استُعملت مصادقة منتهية ثانيةً');
    mode = ''; await connect(['read', 'write']);
    const enteredPermission = deferred(); const permission = deferred();
    const waiting = manager.execute(projectA, writeInput, { ...execution, requestPermission: () => {
      enteredPermission.resolve(); return permission.promise;
    } });
    await enteredPermission.promise;
    const disconnectBefore = runs();
    assert.equal((await otherManager.disconnect(projectA, 'github')).ok, true);
    permission.resolve(true);
    assert.equal((await waiting).ok, false, 'موافقة قديمة أحيت اتصالاً مفصولاً');
    assert.equal(runs(), disconnectBefore, 'الفصل أثناء الإذن لم يمنع الأثر الخارجي');
    assert.equal((await row()).authStatus, 'disconnected');
    await connect(['read', 'write']);
    const selectionEntered = deferred(); const selectionPermission = deferred();
    const selectionWaiting = manager.execute(projectA, writeInput, { ...execution, requestPermission: () => {
      selectionEntered.resolve(); return selectionPermission.promise;
    } });
    await selectionEntered.promise;
    await otherManager.select(projectA, 'github', 'owner/other', ['read', 'write']);
    const selectionBefore = runs(); selectionPermission.resolve(true);
    assert.equal((await selectionWaiting).error, 'connection_changed');
    assert.equal(runs(), selectionBefore, 'تغيّر المورد أثناء الإذن ولم يمنع التنفيذ');
    await connect();
    pendingRun = deferred();
    const inFlight = manager.execute(projectA, readInput, execution);
    await otherManager.disconnect(projectA, 'github');
    pendingRun.resolve({ summary: 'STALE_RESULT_MUST_NOT_APPEAR' });
    const stale = await inFlight; pendingRun = null;
    assert.equal(stale.ok, false, 'accepted a disconnected in-flight result');
    assert(!JSON.stringify(stale).includes('STALE_RESULT_MUST_NOT_APPEAR'));
    assert.equal((await row()).lastEngineUse, null);
    await connect();
    const beforeEncryptionFailure = fs.readFileSync(file, 'utf8');
    encryptionThrows = true;
    assert.equal((await manager.authenticate(projectA, 'github', token)).error, 'encryption_unavailable');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeEncryptionFailure, 'فشل التشفير بدّل المخزن');
    encryptionThrows = false; available = false;
    assert.equal((await manager.authenticate(projectA, 'github', token)).error, 'encryption_unavailable');
    assert.equal((await manager.execute(projectA, readInput, execution)).error, 'encryption_unavailable');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeEncryptionFailure);
    assert.equal((await otherManager.disconnect(projectA, 'github')).ok, true, 'تعطل التشفير منع فصل الاتصال');
    const tombstone = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(tombstone).sort(), ['disconnected', 'projectId', 'revision', 'service', 'version']);
    assert.equal((await row()).authStatus, 'disconnected');
    available = true;
    assert.equal((await manager.execute(projectA, readInput, execution)).error, 'not_connected', 'عاد الاتصال المفصول بعد عودة التشفير');
    pendingAuth = deferred();
    const staleAuthentication = manager.authenticate(projectB, 'github', token);
    available = false;
    assert.equal((await otherManager.disconnect(projectB, 'github')).ok, true);
    available = true;
    pendingAuth.resolve(); pendingAuth = null;
    assert.equal((await staleAuthentication).error, 'connection_changed', 'أحيت مصادقة قديمة اتصالاً مفصولاً');
    assert.equal((await row(projectB)).authStatus, 'disconnected');
    await connect();
    const projectBId = (await manager.list(projectB)).projectId;
    const otherFile = path.join(storeDir, projectBId + '-github.json');
    fs.copyFileSync(file, otherFile);
    assert.equal((await row(projectB)).authStatus, 'unavailable', 'قُبل سجل مشفّر مملوك لمشروع آخر');
    assert.equal((await manager.execute(projectB, readInput, execution)).error, 'storage_unavailable');
    fs.writeFileSync(otherFile, JSON.stringify({ enc: false, data: token }));
    assert.equal((await row(projectB)).authStatus, 'unavailable', 'قُبل مخزن صريح غير مشفّر');
    fs.writeFileSync(file + '.lock', 'held');
    assert.equal((await manager.disconnect(projectA, 'github')).error, 'storage_busy');
    assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'held');
    fs.unlinkSync(file + '.lock');
    assert.equal(fs.readdirSync(storeDir).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);

    // مسار أدوات المحرك وHTTP الفعليان؛ الخدمة الاصطناعية وحدها حد خارجي محقون.
    const codexmcp = require('../electron/codexmcp');
    const connectionTools = require('../electron/connection-tools');
    const permissionEvents = [];
    const gate = connectionTools.createPermissionGate({ emit: (event) => { permissionEvents.push(event); }, isActive: () => true });
    const engineContext = { engine: 'codex', manager, isActive: () => true, requestPermission: gate.requestPermission };
    server = await codexmcp.start({ cwd: projectA, connectionContext: engineContext });
    const mcpRead = await post(server, 'use_project_connection', readInput);
    assert(!mcpRead.error && !mcpRead.result.isError, 'فشل وصول القراءة المسموحة عبر MCP الإنتاجي');
    const mcpBlocked = await post(server, 'use_project_connection', { ...readInput, resource: 'owner/unselected' });
    assert(mcpBlocked.result.isError, 'المورد المرفوض مر عبر MCP');
    await manager.select(projectA, 'github', 'owner/repo', ['read', 'write']);
    const pendingWrite = post(server, 'use_project_connection', writeInput);
    const deadline = Date.now() + 3000;
    while (!permissionEvents.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(permissionEvents.length, 1, 'لم يظهر إذن فعل الخدمة عبر المسار الحقيقي');
    assert.equal(permissionEvents[0].alwaysEligible, false);
    assert.equal(permissionEvents[0].turnEligible, false);
    gate.resolvePermission(permissionEvents[0].id, false);
    assert.equal((await pendingWrite).result.isError, true);
    gate.stop();

    // بوابة الإذن الإنتاجية: مرة واحدة، وانتهاء الدور وإشارة الإجهاض يمنعان الموافقة المتأخرة.
    let gateActive = true;
    const gateEvents = [];
    const realGate = connectionTools.createPermissionGate({ emit: (event) => gateEvents.push(event), isActive: () => gateActive });
    const allowedOnce = realGate.requestPermission(writeInput);
    const onceId = gateEvents.at(-1).id;
    assert.equal(realGate.resolvePermission(onceId, true), true);
    assert.equal(await allowedOnce, true);
    assert.equal(realGate.resolvePermission(onceId, true), false, 'أُعيد استعمال معرّف إذن مستهلك');
    const expiredGate = realGate.requestPermission(writeInput);
    gateActive = false;
    realGate.resolvePermission(gateEvents.at(-1).id, true);
    assert.equal(await expiredGate, false, 'إذن متأخر مر بعد انتهاء الدور');
    gateActive = true;
    const aborted = deferred();
    const abortedGate = realGate.requestPermission(writeInput, { abortedPromise: aborted.promise });
    const abortedId = gateEvents.at(-1).id;
    aborted.resolve();
    assert.equal(await abortedGate, false);
    assert.equal(realGate.resolvePermission(abortedId, true), false);
    const controller = new AbortController();
    const signalGate = realGate.requestPermission(writeInput, { signal: controller.signal });
    controller.abort();
    assert.equal(await signalGate, false);
    const stoppedGate = realGate.requestPermission(writeInput);
    realGate.stop();
    assert.equal(await stoppedGate, false);
    assert.equal(await realGate.requestPermission(writeInput), false);

    // غلاف IPC وعقود اللوحة الإنتاجية نفسها؛ يظل المدير هو مدير المخزن الحقيقي.
    const renderertrust = require('../electron/renderertrust');
    const connectionIpc = require('../electron/connection-ipc');
    const handlers = new Map();
    const url = 'file:///satr-test/index.html';
    const frame = { url };
    const webContents = { mainFrame: frame };
    const window = { isDestroyed: () => false, webContents };
    const event = { sender: webContents, senderFrame: frame };
    let managerLookups = 0;
    const guarded = renderertrust.guardIpcMain({ handle: (name, handler) => handlers.set(name, handler) }, () => window, url);
    connectionIpc.register(guarded, () => { managerLookups++; return manager; });
    const invoke = (name, payload, sender = event) => handlers.get('satr:' + name)(sender, payload);
    assert.equal(handlers.size, 6);
    assert.equal((await invoke('connectionList', { cwd: projectA, engine: 'codex' }, {})).error, 'untrusted_sender');
    assert.equal(managerLookups, 0);
    for (const cwd of [undefined, '.', projectA + '\\..\\project-b', projectA + ' ']) {
      assert.equal((await invoke('connectionList', { cwd, engine: 'codex' })).error, 'bad_cwd');
    }
    const beforeInvalidIpc = managerLookups;
    assert.equal((await invoke('connectionList', { cwd: projectA, engine: 'codex', token })).error, 'bad_input', 'accepted extra IPC field');
    assert.equal((await invoke('connectionResources', { cwd: projectA, service: 'unknown' })).error, 'bad_input');
    assert.equal((await invoke('connectionSelect', { cwd: projectA, service: 'github', resource: 'https://evil.invalid/repo', permissions: ['read'] })).error, 'bad_input');
    assert.equal(managerLookups, beforeInvalidIpc, 'وصلت حمولة IPC مرفوضة إلى المدير');
    const ipcList = await invoke('connectionList', { cwd: projectA, engine: 'codex' });
    assert.equal(ipcList.ok, true); assert(!JSON.stringify(ipcList).includes(token));
    assert.equal(ipcList.services[0].account.id, 'account-a');
    assert.equal((await invoke('connectionAuthenticate', { cwd: projectB, service: 'github', token })).ok, true);
    assert.equal((await invoke('connectionSelect', { cwd: projectB, service: 'github', resource: 'owner/repo', permissions: ['read'] })).ok, true);
    assert.equal((await invoke('connectionTest', { cwd: projectB, service: 'github' })).ok, true);
    assert.equal((await row(projectB)).connectionStatus, 'api-tested');
    assert.equal((await invoke('connectionDisconnect', { cwd: projectB, service: 'github' })).ok, true);
    assert.equal((await row(projectB)).authStatus, 'disconnected');
    assert.equal((await row()).authStatus, 'authenticated', 'فصل المشروع الثاني غيّر المشروع الأول');
    const racing = await Promise.all([
      manager.authenticate(projectB, 'github', token), otherManager.authenticate(projectB, 'github', token),
    ]);
    assert.equal(racing.filter((result) => result.ok).length, 1, 'فاز مديران بالتحديث من الحالة السابقة نفسها');
    assert.equal(racing.find((result) => !result.ok).error, 'connection_changed');
    // المسار المركب الفعلي: إنشاء issue يجري GET ثم POST؛ الفصل بينهما يمنع POST نفسه.
    const { createServices } = require('../electron/connection-services');
    const fetched = [];
    let delayedInspect = null;
    let inspectEntered = null;
    const repository = { id: 77, full_name: 'owner/repo', default_branch: 'main' };
    const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const actualServices = createServices({ fetchImpl: async (url, init) => {
      const endpoint = new URL(url).pathname;
      fetched.push({ endpoint, method: init.method });
      if (endpoint === '/user') return response({ id: 17, login: 'fixture-account' });
      if (endpoint === '/repos/owner/repo') {
        if (delayedInspect) { inspectEntered.resolve(); await delayedInspect.promise; }
        return response(repository);
      }
      if (endpoint === '/repos/owner/repo/issues') return response({ number: 1, title: 'اختبار', repository_url: 'https://api.github.com/repos/owner/repo' });
      throw new Error('unexpected fixture endpoint');
    } });
    const actualOptions = { storeDir: path.join(root, 'actual-provider-store'), safeStorage, services: actualServices };
    const actualManager = createManager(actualOptions);
    const actualOther = createManager(actualOptions);
    async function actualConnect() {
      assert.equal((await actualManager.authenticate(projectA, 'github', token)).ok, true);
      assert.equal((await actualManager.select(projectA, 'github', 'owner/repo', ['read', 'write'])).ok, true);
    }
    await actualConnect();
    delayedInspect = deferred(); inspectEntered = deferred();
    const actualWrite = actualManager.execute(projectA, writeInput, { ...execution, requestPermission: async () => true });
    await inspectEntered.promise;
    assert.equal((await actualOther.disconnect(projectA, 'github')).ok, true);
    delayedInspect.resolve();
    assert.equal((await actualWrite).ok, false);
    assert.equal(fetched.filter((item) => item.method === 'POST').length, 0, 'POST occurred after disconnect during provider GET');
    delayedInspect = null;
    await actualConnect();
    let actualActive = true;
    delayedInspect = deferred(); inspectEntered = deferred();
    const stoppedWrite = actualManager.execute(projectA, writeInput, { engine: 'fixture', isActive: () => actualActive, requestPermission: async () => true });
    await inspectEntered.promise;
    actualActive = false; delayedInspect.resolve();
    assert.equal((await stoppedWrite).error, 'inactive');
    assert.equal(fetched.filter((item) => item.method === 'POST').length, 0, 'POST occurred after stop during provider GET');
    await testCodexExit(root);
    await require('./connections-recovery-test').testConnectionRecovery();
    console.log('connections-test: OK — encrypted project store, scope, permissions, expiry, disconnect races and production MCP path');
  } finally {
    if (server) await server.stop();
    const resolvedRoot = path.resolve(root);
    assert(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedRoot).startsWith('satr-connections-'));
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
