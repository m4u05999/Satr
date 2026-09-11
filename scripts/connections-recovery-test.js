#!/usr/bin/env node
'use strict';

// تعافٍ من موت مالك القفل وفشل حفظ بيانات الاستعمال بعد نجاح الفعل الخارجي.
// المخزن والقفل والتنفيذ من createManager الإنتاجي؛ الأطراف الخارجية والرموز مصطنعة.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const connectionTools = require('../electron/connection-tools');
const { createManager } = require('../electron/connections');

const FIXTURE_TOKEN = 'synthetic-connections-recovery-token';
const SERVICE = 'fixture';
const RESOURCE = 'owner/recovery';
const WAIT_MS = 10000;

function storage(beforeEncrypt = () => {}) {
  const key = crypto.createHash('sha256').update('connections-recovery-fixture-key').digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      beforeEncrypt(plain);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(encrypted) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(-16));
      return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

function provider(run = async () => ({ id: 'fixture-result' })) {
  return {
    id: SERVICE, label: 'خدمة الاختبار',
    actions: { create_item: { write: true } },
    authenticate: async () => ({ id: 'fixture-account', label: 'حساب الاختبار' }),
    listResources: async () => [{ id: RESOURCE, label: 'مورد الاختبار' }],
    inspect: async () => ({ id: RESOURCE, label: 'مورد الاختبار' }),
    run,
  };
}

function paths(root) {
  const resolved = path.resolve(root);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
    && path.basename(resolved).startsWith('satr-connections-recovery-'), 'unsafe recovery fixture root');
  return { root: resolved, project: path.join(resolved, 'project'), storeDir: path.join(resolved, 'store') };
}

function fixture() {
  const value = paths(fs.mkdtempSync(path.join(os.tmpdir(), 'satr-connections-recovery-')));
  fs.mkdirSync(value.project);
  return value;
}

function managerFor(value, safeStorage = storage(), service = provider()) {
  return createManager({ storeDir: value.storeDir, safeStorage, services: { [SERVICE]: service } });
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('connections-recovery timeout: ' + label)), WAIT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

async function lockChild(root, contender = false) {
  const value = paths(root);
  const safeStorage = storage((plain) => {
    const record = JSON.parse(plain);
    assert.equal(record.authStatus, 'authenticated');
    // وصلنا encryptString من commit الفعلي بعد حيازة القفل؛ writeSync يعلن قبل حجب الخيط.
    fs.writeSync(1, 'READY\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('lock holder unexpectedly resumed');
  });
  const result = await managerFor(value, safeStorage).authenticate(value.project, SERVICE, FIXTURE_TOKEN);
  if (contender && result.ok === false && result.error === 'storage_busy') { fs.writeSync(1, 'BLOCKED\n'); return; }
  throw new Error('lock child returned without blocking: ' + JSON.stringify(result));
}

async function testDeadLock(observed) {
  const value = fixture();
  let child;
  let exited;
  try {
    child = spawn(process.execPath, [__filename, '--lock-child', value.root], {
      cwd: value.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('READY\n')) resolve();
      });
      child.stderr.on('data', (chunk) => reject(new Error('lock child error: ' + chunk.toString('utf8'))));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('lock child exited before READY')));
    });
    await bounded(ready, 'commit lock acquired');
    observed.ready = true;
    observed.childPid = child.pid;
    const other = managerFor(value);
    const projectId = (await other.list(value.project)).projectId;
    observed.lockPresentWhileAlive = fs.existsSync(path.join(value.storeDir, projectId + '-' + SERVICE + '.json.lock'));
    assert.equal(observed.lockPresentWhileAlive, true, 'READY preceded creation of the real commit lock');
    observed.liveAttempt = await other.authenticate(value.project, SERVICE, FIXTURE_TOKEN);
    assert.deepEqual(observed.liveAttempt, { ok: false, error: 'storage_busy' }, 'live lock owner must remain exclusive');
    // نقتل الطفل الذي أنشأه الاختبار نفسه، ثم ننتظر إغلاقه؛ لا مطابقة أسماء عمليات أو قتل عام.
    assert.equal(child.kill('SIGKILL'), true, 'failed to terminate the lock-holder child');
    observed.childExit = await bounded(exited, 'lock-holder exit');
    const recovered = managerFor(value);
    observed.afterExit = await recovered.authenticate(value.project, SERVICE, FIXTURE_TOKEN);
    assert.equal(observed.afterExit.ok, true,
      'dead_lock_recovery: authenticate after child exit expected ok=true; actual=' + JSON.stringify(observed.afterExit));
    observed.selected = await recovered.select(value.project, SERVICE, RESOURCE, ['read', 'write']);
    assert.equal(observed.selected.ok, true, 'recovered manager must select a resource');
    observed.disconnected = await recovered.disconnect(value.project, SERVICE);
    assert.equal(observed.disconnected.ok, true, 'recovered manager must disconnect');
    assert.equal((await recovered.list(value.project)).services[0].authStatus, 'disconnected');
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    if (exited) await bounded(exited, 'fixture child cleanup');
    fs.rmSync(paths(value.root).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testRecoveryContenders(observed) {
  const value = fixture();
  const children = [];
  const launch = (contender = false) => {
    const child = spawn(process.execPath, [__filename, '--lock-child', value.root, ...(contender ? ['contender'] : [])], {
      cwd: value.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { child };
    entry.closed = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    entry.notice = new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('READY\n')) resolve('READY');
        if (stdout.includes('BLOCKED\n')) resolve('BLOCKED');
      });
      child.stderr.on('data', (chunk) => reject(new Error('recovery contender error: ' + chunk.toString('utf8'))));
      child.once('error', reject);
      child.once('exit', () => {
        if (!stdout.includes('READY\n') && !stdout.includes('BLOCKED\n')) reject(new Error('recovery contender exited before notice'));
      });
    });
    children.push(entry);
    return entry;
  };
  try {
    const oldOwner = launch();
    assert.equal(await bounded(oldOwner.notice, 'old owner commit acquired'), 'READY');
    assert.equal(oldOwner.child.kill('SIGKILL'), true);
    observed.oldOwnerExit = await bounded(oldOwner.closed, 'old owner exit before contenders');
    // يبدأ المتنافسان قبل انتظار أي نتيجة منهما؛ المالك الفائز يبقى محجوباً داخل commit.
    const first = launch(true);
    const second = launch(true);
    const notices = await bounded(Promise.all([first.notice, second.notice]), 'both recovery contender notices');
    observed.notices = notices;
    observed.readyCount = notices.filter((notice) => notice === 'READY').length;
    observed.blockedCount = notices.filter((notice) => notice === 'BLOCKED').length;
    assert.equal(observed.readyCount, 1,
      'recovery_contenders: exactly one commit owner required; notices=' + JSON.stringify(notices));
    assert.equal(observed.blockedCount, 1,
      'recovery_contenders: losing commit must return storage_busy; notices=' + JSON.stringify(notices));
    const entries = [first, second];
    const winner = entries[notices.indexOf('READY')];
    const loser = entries[notices.indexOf('BLOCKED')];
    observed.loserExit = await bounded(loser.closed, 'blocked contender exit');
    assert.equal(observed.loserExit.code, 0, 'blocked contender must exit cleanly');
    observed.winnerAlive = winner.child.exitCode == null && winner.child.signalCode == null;
    assert.equal(observed.winnerAlive, true, 'winning contender must retain the live lock');
    const another = managerFor(value);
    observed.whileWinnerAlive = await another.authenticate(value.project, SERVICE, FIXTURE_TOKEN);
    assert.deepEqual(observed.whileWinnerAlive, { ok: false, error: 'storage_busy' }, 'live winning contender lost lock exclusivity');
    assert.equal(winner.child.kill('SIGKILL'), true);
    observed.winnerExit = await bounded(winner.closed, 'winning contender exit');
    const recovered = managerFor(value);
    observed.afterWinnerExit = await recovered.authenticate(value.project, SERVICE, FIXTURE_TOKEN);
    assert.equal(observed.afterWinnerExit.ok, true,
      'recovery_contenders: third manager must recover after winner exit; actual=' + JSON.stringify(observed.afterWinnerExit));
    assert.equal((await recovered.select(value.project, SERVICE, RESOURCE, ['read', 'write'])).ok, true);
    assert.equal((await recovered.disconnect(value.project, SERVICE)).ok, true);
  } finally {
    for (const entry of children) {
      if (entry.child.exitCode == null && entry.child.signalCode == null) entry.child.kill('SIGKILL');
    }
    await bounded(Promise.all(children.map((entry) => entry.closed)), 'recovery contenders cleanup');
    fs.rmSync(paths(value.root).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testUsageSaveFailure(observed) {
  const value = fixture();
  let encryptUsageFails = false;
  let effects = 0;
  const effectsFile = path.join(value.root, 'provider-effects.txt');
  const successfulData = { id: 'created-fixture-item', created: true };
  const safeStorage = storage((plain) => {
    if (encryptUsageFails && JSON.parse(plain).lastEngineUse) throw new Error('fixture usage encryption failed');
  });
  const service = provider(async () => {
    effects += 1;
    fs.appendFileSync(effectsFile, 'created\n', 'utf8');
    encryptUsageFails = true;
    return successfulData;
  });
  const manager = managerFor(value, safeStorage, service);
  try {
    assert.equal((await manager.authenticate(value.project, SERVICE, FIXTURE_TOKEN)).ok, true);
    assert.equal((await manager.select(value.project, SERVICE, RESOURCE, ['read', 'write'])).ok, true);
    observed.result = await manager.execute(value.project, {
      service: SERVICE, resource: RESOURCE, action: 'create_item', params: { title: 'طلب مصطنع' },
    }, { engine: 'fixture', isActive: () => true, requestPermission: async () => true });
    observed.providerEffects = effects;
    observed.persistedEffects = fs.readFileSync(effectsFile, 'utf8').trim().split('\n').length;
    assert.equal(observed.providerEffects, 1, 'provider effect must run exactly once');
    assert.equal(observed.persistedEffects, 1, 'provider successful effect must exist exactly once on disk');
    assert.equal(observed.result.ok, true,
      'usage_save_failure: provider succeeded once; expected ok=true, warning=usage_not_saved, usageSaved=false; actual=' + JSON.stringify(observed.result));
    assert.deepEqual(observed.result.data, successfulData, 'successful provider data must be preserved');
    assert.equal(observed.result.warning, 'usage_not_saved');
    assert.equal(observed.result.usageSaved, false);
    const row = (await manager.list(value.project)).services[0];
    assert.equal(row.authStatus, 'authenticated', 'usage save failure must not expire authentication');
    assert.equal(row.lastEngineUse, null, 'failed metadata save must not claim a persisted use');
  } finally {
    fs.rmSync(paths(value.root).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testPostWriteConnectionChanged(observed) {
  const value = fixture();
  let effects = 0;
  const effectsFile = path.join(value.root, 'post-write-effects.txt');
  const newResource = 'owner/recovery-new';
  const successfulData = { id: 'old-connection-created-item', marker: 'OLD_WRITE_DATA_MUST_NOT_APPEAR' };
  const other = managerFor(value);
  let nextRow;
  const service = provider(async () => {
    effects += 1;
    fs.appendFileSync(effectsFile, 'created\n', 'utf8');
    // الفعل نجح بالفعل؛ مدير مستقل يبدّل المورد قبل عودة نتيجته إلى execute.
    assert.equal((await other.select(value.project, SERVICE, newResource, ['read'])).ok, true);
    nextRow = (await other.list(value.project)).services[0];
    return successfulData;
  });
  const manager = managerFor(value, storage(), service);
  try {
    assert.equal((await manager.authenticate(value.project, SERVICE, FIXTURE_TOKEN)).ok, true);
    assert.equal((await manager.select(value.project, SERVICE, RESOURCE, ['read', 'write'])).ok, true);
    observed.result = await manager.execute(value.project, {
      service: SERVICE, resource: RESOURCE, action: 'create_item', params: { title: 'طلب تغيّر اتصاله بعد الكتابة' },
    }, { engine: 'fixture', isActive: () => true, requestPermission: async () => true });
    observed.providerEffects = effects;
    observed.persistedEffects = fs.readFileSync(effectsFile, 'utf8').trim().split('\n').length;
    observed.currentRow = (await other.list(value.project)).services[0];
    assert.equal(observed.providerEffects, 1, 'post-write provider effect must run exactly once');
    assert.equal(observed.persistedEffects, 1, 'post-write successful effect must exist exactly once on disk');
    assert.deepEqual(observed.currentRow, nextRow, 'old write changed the newly selected connection');
    assert.equal(observed.currentRow.resource.id, newResource);
    assert.deepEqual(observed.currentRow.permissions, ['read']);
    assert.equal(observed.currentRow.lastEngineUse, null, 'old write attributed its usage to the new connection');
    assert.equal(observed.result.ok, false, 'stale write result must not be accepted by the new connection');
    assert.equal(observed.result.error, 'connection_changed');
    assert.equal(Object.hasOwn(observed.result, 'data'), false, 'stale write result leaked old connection data');
    assert.equal(JSON.stringify(observed.result).includes(successfulData.marker), false);
    assert.equal(observed.result.externalOutcome, 'succeeded',
      'post_write_connection_changed: successful external write must be declared; actual=' + JSON.stringify(observed.result));
    assert.equal(observed.result.retryable, false, 'post-write rejection must not invite a duplicate effect');
  } finally {
    fs.rmSync(paths(value.root).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testChangedDuringTestRelease(observed) {
  const value = fixture();
  const manager = managerFor(value);
  const other = managerFor(value);
  const newResource = 'owner/test-release-new';
  const originalClose = net.Server.prototype.close;
  let armed = false;
  let switchFailure;
  let nextRow;
  try {
    assert.equal((await manager.authenticate(value.project, SERVICE, FIXTURE_TOKEN)).ok, true);
    assert.equal((await manager.select(value.project, SERVICE, RESOURCE, ['read', 'write'])).ok, true);
    armed = true;
    net.Server.prototype.close = function (callback) {
      if (!armed || typeof callback !== 'function') return originalClose.apply(this, arguments);
      armed = false;
      // يغلق مقبس الإنتاج فعلاً؛ نبدّل المورد قبل تسليم callback التحرير إلى commit.
      return originalClose.call(this, (...args) => {
        Promise.resolve().then(async () => {
          observed.switched = await other.select(value.project, SERVICE, newResource, ['read']);
          nextRow = (await other.list(value.project)).services[0];
        }).catch((error) => { switchFailure = error; }).finally(() => callback(...args));
      });
    };
    observed.result = await bounded(manager.test(value.project, SERVICE), 'test commit release and resource switch');
    if (switchFailure) throw switchFailure;
    assert.equal(armed, false, 'test release hook did not intercept production net.Server.close');
    assert.equal(observed.switched.ok, true, 'second manager failed to switch after real socket close');
    observed.currentRow = (await other.list(value.project)).services[0];
    assert.deepEqual(observed.currentRow, nextRow, 'completed test rewrote the new connection');
    assert.equal(observed.currentRow.resource.id, newResource);
    assert.equal(observed.currentRow.lastTest, null);
    assert.equal(observed.result.ok, false,
      'test_release_connection_changed: test must reject a connection changed during lock release; actual=' + JSON.stringify(observed.result));
    assert.equal(observed.result.error, 'connection_changed');
    assert.equal(Object.hasOwn(observed.result, 'data'), false, 'old test data escaped after connection changed');
  } finally {
    net.Server.prototype.close = originalClose;
    fs.rmSync(paths(value.root).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testToolPostWriteInactive(observed) {
  const value = fixture();
  const effectsFile = path.join(value.root, 'tool-post-write-effects.txt');
  let active = true;
  let effects = 0;
  const service = provider(async () => {
    effects += 1;
    fs.appendFileSync(effectsFile, 'created\n', 'utf8');
    active = false;
    return { id: 'created-before-stop', token: FIXTURE_TOKEN, marker: 'OLD_TOOL_DATA_MUST_NOT_APPEAR' };
  });
  const manager = managerFor(value, storage(), service);
  try {
    assert.equal((await manager.authenticate(value.project, SERVICE, FIXTURE_TOKEN)).ok, true);
    assert.equal((await manager.select(value.project, SERVICE, RESOURCE, ['read', 'write'])).ok, true);
    observed.wrapperResult = await connectionTools.run('use_project_connection', value.project, {
      service: SERVICE, resource: RESOURCE, action: 'create_item', params: { title: 'طلب يكتمل قبل توقف الدور' },
    }, { manager, engine: 'fixture', isActive: () => active, requestPermission: async () => true });
    observed.providerEffects = effects;
    observed.persistedEffects = fs.readFileSync(effectsFile, 'utf8').trim().split('\n').length;
    observed.currentRow = (await manager.list(value.project)).services[0];
    assert.equal(observed.providerEffects, 1, 'stopped tool repeated the provider effect');
    assert.equal(observed.persistedEffects, 1, 'stopped tool repeated the persisted effect');
    assert.equal(observed.currentRow.lastEngineUse, null, 'stopped write claimed saved engine use');
    assert.equal(observed.wrapperResult.ok, false);
    assert.equal(observed.wrapperResult.content.includes(FIXTURE_TOKEN), false, 'stopped tool leaked a token');
    assert.equal(observed.wrapperResult.content.includes('OLD_TOOL_DATA_MUST_NOT_APPEAR'), false);
    try { observed.content = JSON.parse(observed.wrapperResult.content); }
    catch { assert.fail('tool_post_write_inactive: expected JSON preserving successful write outcome; actual=' + JSON.stringify(observed.wrapperResult)); }
    assert.equal(observed.content.ok, false);
    assert.equal(observed.content.error, 'inactive');
    assert.equal(observed.content.externalOutcome, 'succeeded', 'tool discarded the successful external write outcome');
    assert.equal(observed.content.retryable, false, 'stopped tool response invites duplicate write');
    assert.equal(Object.hasOwn(observed.content, 'data'), false);
  } finally {
    fs.rmSync(paths(value.root).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testConnectionRecovery(options = {}) {
  const cases = [];
  for (const [name, run] of [['dead_lock_recovery', testDeadLock], ['recovery_contenders', testRecoveryContenders], ['usage_save_failure', testUsageSaveFailure], ['post_write_connection_changed', testPostWriteConnectionChanged], ['test_release_connection_changed', testChangedDuringTestRelease], ['tool_post_write_inactive', testToolPostWriteInactive]]) {
    if (['dead_lock_recovery', 'recovery_contenders', 'test_release_connection_changed'].includes(name) && !['win32', 'linux'].includes(process.platform)) {
      const reason = 'local IPC lock requires win32 or linux; actual=' + process.platform;
      cases.push({ name, skipped: true, reason });
      console.log('connections-recovery: SKIP ' + name + ': ' + reason);
      continue;
    }
    const observed = {};
    try {
      await run(observed);
      cases.push({ name, ok: true, observed });
      console.log('connections-recovery: PASS ' + name);
    } catch (error) {
      const message = String(error && error.message || error);
      cases.push({ name, ok: false, observed, error: message });
      console.error('connections-recovery: FAIL ' + name + ': ' + message);
    }
  }
  const report = {
    at: new Date().toISOString(),
    production_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'electron', 'connections.js'))).digest('hex'),
    connection_tools_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'electron', 'connection-tools.js'))).digest('hex'),
    ok: cases.filter((entry) => !entry.skipped).every((entry) => entry.ok),
    counts: {
      passed: cases.filter((entry) => entry.ok === true).length,
      failed: cases.filter((entry) => entry.ok === false).length,
      skipped: cases.filter((entry) => entry.skipped === true).length,
      total: cases.length,
    }, cases,
  };
  console.log('connections-recovery: summary passed=' + report.counts.passed + ' failed=' + report.counts.failed
    + ' skipped=' + report.counts.skipped + ' total=' + report.counts.total);
  if (options.reportPath) {
    fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
    fs.writeFileSync(options.reportPath, JSON.stringify(report, null, 2), 'utf8');
  }
  assert.equal(report.ok, true, 'connections-recovery: failed ' + cases.filter((entry) => entry.ok === false).map((entry) => entry.name).join(', '));
  return report;
}

module.exports = { testConnectionRecovery };

if (require.main === module) {
  const task = process.argv[2] === '--lock-child'
    ? lockChild(process.argv[3], process.argv[4] === 'contender')
    : testConnectionRecovery({ reportPath: path.join(__dirname, '..', 'dist', 'connections-recovery', 'latest.json') });
  task.catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}
