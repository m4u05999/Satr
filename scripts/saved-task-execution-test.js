#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const executionHostModule = require('../electron/execution-host');
const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
function section(start, end) {
  const from = mainSource.indexOf(start), to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'تعذر استخراج main production: ' + start);
  return mainSource.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function sender() {
  const frame = {};
  const value = { mainFrame: frame, send() {}, isDestroyed: () => false };
  return { sender: value, senderFrame: frame };
}
async function main() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-saved-task-main-'));
  const starts = [];
  const fakeDone = deferred();
  const codex = {
    start(input, cwd, emit) {
      starts.push({ input, cwd, emit });
      return Promise.resolve({
        done: fakeDone.promise, stop: () => Promise.resolve(),
        resolvePermission: () => true, resolveQuestion: () => true, resolveHandoff: () => true,
      });
    },
  };
  const sandbox = {
    console, require, Buffer, setTimeout, clearTimeout,
    executionHostModule, codex,
    verify: { loadConfig: () => ({ ok: false }), selectChecks: () => ({ ok: false }), runChecks: async () => ({}) },
    app: { getPath: () => project }, memory: { hasSecret: () => false },
    features: { edition: () => 'enterprise' },
    sanitizeImages: (value) => Array.isArray(value) ? value.slice(0, 1) : [],
    sanitizeSkills: (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [],
    nonSdkPerm: (value) => value === 'acceptEdits' ? value : 'default',
    browserpolicy: require('../electron/browserpolicy'),
    SAFE_SESSION: /^[A-Za-z0-9_-]{1,128}$/, SAFE_MODEL: /^[A-Za-z0-9._:-]{1,128}$/,
    EFFORT_LEVELS: new Set(['medium']), trustedBrowserOrigins: new Set(['https://ordinary.example']),
    pendingVerificationPermissions: new Map(), nativeStoppingRuns: new Set(),
    currentRun: null, currentCliRun: null, kimiSessionControlBusy: false, exported: {},
    handlers: {}, ipcMain: { handle(name, fn) { sandbox.handlers[name] = fn; } },
    sendCalls: 0, stopCalls: 0, dialogCalls: 0,
    handleSendRequest: async () => { sandbox.sendCalls++; return { started: true }; },
    stopAll: async () => { sandbox.stopCalls++; }, cancelPendingSendRequest() {},
    nextDialogResult: null,
    dialog: { async showOpenDialog() {
      sandbox.dialogCalls++;
      return sandbox.nextDialogResult ? sandbox.nextDialogResult : { canceled: true, filePaths: [] };
    } },
    mainWindow: null,
    resolvePermissionThroughCurrentHandles: () => { throw new Error('must not resolve'); },
    mobilePermissionRaces: new Map(), withdrawMobilePermission() {}, publishMobileState() {},
    notifyObservers() {}, lastEngine: 'codex',
  };
  const code = [
    section('let verificationRunsInFlight = 0;', 'function forgetSdkBackgroundRun('),
    'exported.host = savedTaskHost;',
    'exported.executionSeam = savedTasksExecution;',
    'exported.startCodexHandle = startCodexHandle;',
    'exported.trackNativeRunStop = trackNativeRunStop;',
    "exported.setBusy = function(name, value) { if (name === 'send') sendRequestBusy = value; if (name === 'sdkRun') sdkRunInFlight = value; if (name === 'sdkStarting') sdkStartingPromise = value; if (name === 'sdkStopping') sdkStoppingPromise = value; if (name === 'verify') verificationRunsInFlight = value; if (name === 'restore') checkpointRestoreInFlight = value; if (name === 'session') sdkSessionControlBusy = value; };",
    'exported.background = sdkBackgroundRuns;',
    section("ipcMain.handle('satr:pickFolder',", '// ---------- إرسال طلب إلى Claude Code ----------'),
    section("ipcMain.handle('satr:send',", '// ---------- مهام Claude SDK الخلفية'),
    section("ipcMain.handle('satr:permission',", '// ---------- C1: التوجيه أثناء الدور'),
  ].join('\n');
  vm.runInNewContext(code, sandbox, { filename: 'saved-task-main-production-extract.js' });
  const event = sender();
  assert.equal(typeof sandbox.exported.executionSeam.verificationCatalog, 'function');
  assert.equal(sandbox.exported.host.rememberProject(event, project).ok, true);
  const taskId = 'task_' + 'a'.repeat(32);
  const beforeContext = sandbox.exported.host.getProjectContext(event).context;
  const delayedDialog = deferred();
  sandbox.nextDialogResult = delayedDialog.promise;
  const delayedPick = sandbox.handlers['satr:pickFolder'](event);
  await Promise.resolve();
  const duringDialog = sandbox.exported.host.reserve(event, { task_id: taskId });
  assert.equal(duringDialog.ok, true);
  delayedDialog.resolve({ canceled: false, filePaths: [fs.mkdtempSync(path.join(os.tmpdir(), 'satr-other-project-'))] });
  assert.equal(await delayedPick, null);
  assert.strictEqual(sandbox.exported.host.getProjectContext(event).context, beforeContext);
  assert.equal(sandbox.exported.host.release(duringDialog.lease), true);
  sandbox.nextDialogResult = null;
  const busyCases = [
    ['send', true], ['sdkRun', true], ['sdkStarting', Promise.resolve()],
    ['sdkStopping', Promise.resolve()], ['verify', 1], ['restore', 1], ['session', true],
  ];
  for (const [name, value] of busyCases) {
    sandbox.exported.setBusy(name, value);
    assert.equal(sandbox.exported.host.reserve(event, { task_id: taskId }).error, 'busy', name);
    sandbox.exported.setBusy(name, name === 'verify' || name === 'restore' ? 0
      : name === 'send' || name === 'sdkRun' || name === 'session' ? false : null);
  }
  sandbox.exported.background.add({});
  assert.equal(sandbox.exported.host.reserve(event, { task_id: taskId }).error, 'busy');
  sandbox.exported.background.clear();
  sandbox.pendingVerificationPermissions.set('verify_old', () => {});
  assert.equal(sandbox.exported.host.reserve(event, { task_id: taskId }).error, 'busy');
  sandbox.pendingVerificationPermissions.clear();
  const reserved = sandbox.exported.host.reserve(event, { task_id: taskId });
  assert.equal(reserved.ok, true);
  const projectId = 'project_' + require('node:crypto').createHash('sha256')
    .update(process.platform === 'win32' ? fs.realpathSync(project).toLowerCase() : fs.realpathSync(project)).digest('hex');
  assert.equal(sandbox.exported.host.bindRun(reserved.lease, {
    project_id: projectId, task_id: taskId, run_id: 'run_' + 'b'.repeat(32),
  }).ok, true);
  const launched = await sandbox.exported.host.launch(reserved.lease, {
    prompt: 'TASK_ONLY', model: 'gpt-5.6-sol', effort: 'medium',
  }, () => {}, () => {});
  assert.equal(launched.ok, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].input.prompt, 'TASK_ONLY');
  assert.equal(starts[0].input.sessionId, null);
  assert.equal(starts[0].input.continuityContext, '');
  assert.deepEqual(Array.from(starts[0].input.images), []);
  assert.deepEqual(Array.from(starts[0].input.skills), []);
  assert.equal(starts[0].input.browserControl, null);
  assert.equal(starts[0].input.trustedBrowserOrigins.size, 0);
  sandbox.exported.host.release(reserved.lease);
  const stopDone = deferred();
  const nativeRun = { done: stopDone.promise, stop: () => Promise.resolve('stop-requested') };
  await sandbox.exported.trackNativeRunStop(nativeRun);
  assert.equal(sandbox.nativeStoppingRuns.size, 1, 'stop Promise لا يثبت done');
  assert.equal(sandbox.exported.host.reserve(event, { task_id: taskId }).error, 'busy');
  stopDone.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(sandbox.nativeStoppingRuns.size, 0);
  const gate = sandbox.exported.host.reserve(event, { task_id: taskId });
  assert.equal(gate.ok, true);
  assert.equal((await sandbox.handlers['satr:send'](event, { prompt: 'must-not-run' })).error, 'task_busy');
  assert.equal(sandbox.sendCalls, 0);
  assert.equal((await sandbox.handlers['satr:stop'](event)).error, 'task_busy');
  assert.equal(sandbox.stopCalls, 0);
  assert.equal(sandbox.handlers['satr:permission'](event, { id: 'old', allow: true }).error, 'task_busy');
  assert.equal(await sandbox.handlers['satr:pickFolder'](event), null);
  assert.equal(sandbox.dialogCalls, 1);
  sandbox.exported.host.release(gate.lease);
  let stopCalls = 0, previewCalls = 0;
  const mobileSandbox = {
    Promise, setTimeout, clearTimeout,
    mobileRunToken: 'old-token', runSeq: 7, mobileStopRequest: null,
    currentRun: { done: Promise.resolve() }, currentCliRun: null, sdkStartingPromise: null,
    MOBILE_STOP_CONFIRM_TIMEOUT_MS: 1000,
    savedTaskHost: { isReserved: () => true },
    mobileDebug() {}, cancelPendingSendRequest() {}, stopAll() { stopCalls++; },
    publishMobileState() {}, preview: { clearSensitiveState() { previewCalls++; } }, exported: {},
  };
  vm.runInNewContext([
    section('function currentMobileRunToken()', 'function runMobileOffer('),
    'exported.stop = handleMobileStop;',
  ].join('\n'), mobileSandbox, { filename: 'saved-task-mobile-stop-production-extract.js' });
  assert.equal(mobileSandbox.exported.stop('old-token', () => {}), false);
  assert.equal(stopCalls, 0); assert.equal(previewCalls, 0);
  console.log('PASS saved task main extraction: busy gates, isolated Codex start, done proof, IPC guards, mobile stop');
}
main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
