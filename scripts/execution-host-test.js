#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../electron/execution-host');

const TASK_A = 'task_' + 'a'.repeat(32);
const TASK_B = 'task_' + 'b'.repeat(32);
const RUN_A = 'run_' + 'a'.repeat(32);
const RUN_B = 'run_' + 'b'.repeat(32);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mustStayPending(promise, label) {
  const marker = Symbol(label);
  assert.strictEqual(await Promise.race([promise, delay(25).then(() => marker)]), marker, label);
}

async function withTimeout(promise, label, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout: ' + label)), ms)),
  ]);
}

function projectId(root) {
  const normalized = process.platform === 'win32' ? root.toLowerCase() : root;
  return 'project_' + crypto.createHash('sha256').update(normalized).digest('hex');
}

function eventPair() {
  const sender = { mainFrame: {} };
  return {
    sender,
    event: { sender, senderFrame: sender.mainFrame },
    other: { sender: { mainFrame: {} }, senderFrame: null },
  };
}

function check(id, overrides = {}) {
  return {
    id,
    label: 'Check ' + id,
    command: 'node check-' + id + '.js',
    timeout_seconds: 30,
    ...overrides,
  };
}

function criteria(ids) {
  return ids.map((id, index) => ({
    id: 'criterion-' + index,
    verification_source: 'verify',
    verify_id: id,
  }));
}

function makeHost(root, overrides = {}) {
  const published = [];
  const config = overrides.config || {
    version: 1,
    checks: [check('alpha'), check('beta')],
    preview: { enabled: true },
    review_skill: 'review',
  };
  const verify = overrides.verify || {
    loadConfig: () => config,
    selectChecks: (loaded, ids) => ({
      ok: true,
      checks: ids.map((id) => loaded.checks.find((item) => item.id === id)),
    }),
    runChecks: async (_root, checks) => ({
      ok: true,
      passed: true,
      complete: true,
      aborted: false,
      expected_ids: checks.map((item) => item.id),
      checks: checks.map((item) => ({ id: item.id, passed: true, aborted: false, timed_out: false })),
    }),
  };
  const options = {
    isCoreBusy: () => false,
    launchCodex: async () => {
      throw new Error('unexpected launch');
    },
    publish: (_context, payload) => {
      published.push(payload);
      return true;
    },
    verify,
    getDataRoot: () => root,
    stopTimeoutMs: 40,
    ...overrides,
  };
  delete options.config;
  const host = create(options);
  return { host, published, config };
}

function selectProject(host, root, pair) {
  assert.deepStrictEqual(host.rememberProject(pair.event, root), { ok: true, projectRoot: root });
  const selected = host.getProjectContext(pair.event);
  assert.strictEqual(selected.ok, true);
  assert.strictEqual(host.resolveTrustedProjectRoot(selected.context), root);
  return selected.context;
}

function reserveBound(host, pair, root, taskId = TASK_A, runId = RUN_A) {
  const reserved = host.reserve(pair.event, { task_id: taskId });
  assert.strictEqual(reserved.ok, true);
  const owner = { task_id: taskId, run_id: runId, project_id: projectId(root) };
  assert.deepStrictEqual(host.bindRun(reserved.lease, owner), { ok: true });
  return { lease: reserved.lease, owner };
}

function makeHandle(options = {}) {
  const done = options.done || deferred();
  const stats = { stops: 0, permissions: [], questions: [], handoffs: [] };
  const handle = {
    done: done.promise,
    stop() {
      stats.stops += 1;
      if (options.stopResolvesDone) done.resolve();
      return Promise.resolve();
    },
    resolvePermission(id, allow, always, turn) {
      stats.permissions.push({ id, allow, always, turn });
      return options.permissionResult !== false;
    },
    resolveQuestion(id, selections) {
      stats.questions.push({ id, selections });
      return true;
    },
    resolveHandoff(id, complete) {
      stats.handoffs.push({ id, complete });
      return true;
    },
  };
  return { handle, done, stats };
}

async function permissionForVerification(host, pair, runPromise, published, allow) {
  const permission = published.find((item) => item.event && item.event.type === 'permission_request');
  assert(permission, 'verification permission must be published');
  const reply = host.resolveControl(pair.event, {
    run_id: RUN_A,
    id: permission.event.id,
    allow,
    always: false,
    turn: false,
  }, 'permission');
  assert.deepStrictEqual(reply, { ok: true });
  return runPromise;
}

async function testIdentityAndReservation(root) {
  const pair = eventPair();
  pair.other.senderFrame = pair.other.sender.mainFrame;
  const { host } = makeHost(root);

  assert.deepStrictEqual(host.rememberProject({
    sender: pair.sender,
    senderFrame: {},
  }, root), { ok: false, error: 'untrusted_sender' });
  const context = selectProject(host, root, pair);
  const info = host.projectInfo(context);
  assert.deepStrictEqual(info, { project_id: projectId(root), path: root });
  assert.strictEqual(Object.isFrozen(info), true);
  assert.deepStrictEqual(Object.keys(info), ['project_id', 'path']);
  assert.throws(() => host.resolveTrustedProjectRoot({ root }), /project_required/);
  assert.throws(() => host.projectInfo({ root }), /project_required/);
  assert.deepStrictEqual(host.verificationCatalog({}), { ok: false, error: 'project_required' });
  assert.deepStrictEqual(host.snapshotVerification({}, []), { ok: false, error: 'project_required' });
  const catalog = host.verificationCatalog(context);
  assert.strictEqual(catalog.ok, true);
  assert.strictEqual(catalog.status, 'available');
  assert.deepStrictEqual(catalog.checks, [
    { id: 'alpha', label: 'Check alpha', timeout_seconds: 30 },
    { id: 'beta', label: 'Check beta', timeout_seconds: 30 },
  ]);
  assert.strictEqual(Object.hasOwn(catalog.checks[0], 'command'), false);
  assert.strictEqual(host.snapshotVerification(context, criteria(['alpha'])).config_fingerprint,
    catalog.config_fingerprint);
  const unavailable = makeHost(root, { verify: {
    loadConfig: () => ({ ok: false, error: 'missing' }),
    selectChecks: () => { throw new Error('must not select'); },
    runChecks: () => { throw new Error('must not run'); },
  } }).host;
  const unavailableContext = selectProject(unavailable, root, pair);
  assert.deepStrictEqual(unavailable.verificationCatalog(unavailableContext), {
    ok: false, error: 'verify_unavailable', status: 'no_checks', checks: [],
  });

  const reserved = host.reserve(pair.event, { task_id: TASK_A });
  assert.strictEqual(reserved.ok, true);
  assert.deepStrictEqual(host.reserve(pair.event, { task_id: TASK_B }), { ok: false, error: 'busy' });
  assert.deepStrictEqual(host.rememberProject(pair.other, root), { ok: false, error: 'task_busy' });
  assert.deepStrictEqual(host.bindRun(reserved.lease, {
    task_id: TASK_A,
    run_id: RUN_A,
    project_id: 'project_' + 'f'.repeat(64),
  }), { ok: false, error: 'bad_owner' });
  assert.deepStrictEqual(host.bindRun(reserved.lease, {
    task_id: TASK_A,
    run_id: RUN_A,
    project_id: projectId(root),
  }), { ok: true });
  assert.deepStrictEqual(host.bindRun(reserved.lease, {
    task_id: TASK_A,
    run_id: RUN_B,
    project_id: projectId(root),
  }), { ok: false, error: 'bad_owner' });
  assert.strictEqual(host.sameWindow(pair.other, context), false);
  assert.strictEqual(host.release(Object.freeze({ id: reserved.lease.id })), false);
  assert.strictEqual(host.release(reserved.lease), true);
  const secondRoot = path.join(root, 'project-two');
  fs.mkdirSync(secondRoot);
  assert.deepStrictEqual(host.rememberProject(pair.event, secondRoot), { ok: true, projectRoot: secondRoot });
  const secondContext = host.getProjectContext(pair.event).context;
  assert.deepStrictEqual(host.projectInfo(secondContext), {
    project_id: projectId(secondRoot), path: secondRoot,
  });
  assert.throws(() => host.projectInfo(context), /stale_project/);

  let busy = true;
  const busyHost = makeHost(root, { isCoreBusy: () => busy }).host;
  selectProject(busyHost, root, pair);
  assert.deepStrictEqual(busyHost.reserve(pair.event, { task_id: TASK_A }), { ok: false, error: 'busy' });
  busy = false;
  assert.strictEqual(busyHost.reserve(pair.event, { task_id: TASK_A }).ok, true);
}

async function testLifecycleAndControls(root) {
  const pair = eventPair();
  pair.other.senderFrame = pair.other.sender.mainFrame;
  const engine = makeHandle();
  let emit;
  let onDoneCalls = 0;
  const { host, published } = makeHost(root, {
    launchCodex: async (_input, cwd, send) => {
      assert.strictEqual(cwd, root);
      emit = send;
      return engine.handle;
    },
  });
  selectProject(host, root, pair);
  const { lease } = reserveBound(host, pair, root);
  assert.deepStrictEqual(await host.launch(lease, { prompt: 'run' }, (event) => {
    host.publish(lease, event);
  }, () => { onDoneCalls += 1; }), { ok: true });

  emit({ type: 'result', value: 'early' });
  emit({ type: 'proc_done', code: 0 });
  assert.strictEqual(host.isReserved(), true);
  assert.strictEqual(onDoneCalls, 0);

  emit({ type: 'permission_request', id: 'perm-one' });
  assert.deepStrictEqual(host.resolveControl(pair.other, {
    run_id: RUN_A, id: 'perm-one', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'stale_owner' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_B, id: 'perm-one', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'stale_owner' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A, id: 'perm-one', allow: true, always: false, turn: false,
  }, 'permission'), { ok: true });
  assert.strictEqual(engine.stats.permissions.length, 1);
  emit({ type: 'permission_request', id: 'perm-one' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A, id: 'perm-one', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'not_pending' });
  assert.strictEqual(engine.stats.permissions.length, 1);

  emit({ type: 'question_request', id: 'question-one' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A,
    id: 'question-one',
    selections: [{ questionIndex: 0, optionIndexes: [1], text: null }],
  }, 'question'), { ok: true });
  emit({ type: 'handoff_request', id: 'ho_one' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A, id: 'ho_one', done: true,
  }, 'handoff'), { ok: true });

  engine.handle.resolvePermission = () => { throw new Error('resolver failed'); };
  emit({ type: 'permission_request', id: 'perm-throws' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A, id: 'perm-throws', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'rejected' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A, id: 'perm-throws', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'not_pending' });

  engine.done.resolve();
  await engine.handle.done;
  await delay(0);
  assert.strictEqual(onDoneCalls, 1);
  emit({ type: 'permission_request', id: 'after-done' });
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_A, id: 'after-done', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'not_pending' });
  assert.strictEqual(host.isReserved(), true);
  assert.strictEqual(host.release(lease), true);

  const oldPublished = published.length;
  const nextEngine = makeHandle();
  const { lease: leaseB } = reserveBound(host, pair, root, TASK_B, RUN_B);
  emit({ type: 'permission_request', id: 'old-after-release' });
  assert.strictEqual(published.length, oldPublished);
  assert.deepStrictEqual(host.resolveControl(pair.event, {
    run_id: RUN_B, id: 'old-after-release', allow: true, always: false, turn: false,
  }, 'permission'), { ok: false, error: 'not_pending' });
  assert.strictEqual(nextEngine.stats.permissions.length, 0);
  assert.strictEqual(host.release(leaseB), true);
}

async function testLaunchAndStopRaces(root) {
  const pair = eventPair();

  const handleGate = deferred();
  const lateEngine = makeHandle();
  const late = makeHost(root, { launchCodex: () => handleGate.promise, stopTimeoutMs: 200 });
  selectProject(late.host, root, pair);
  const lateBound = reserveBound(late.host, pair, root);
  const launching = late.host.launch(lateBound.lease, {}, () => {}, () => {});
  const stopping = late.host.stop(lateBound.lease);
  await mustStayPending(stopping, 'stop must wait for a pending native handle');
  handleGate.resolve(lateEngine.handle);
  await launching;
  await delay(0);
  assert(lateEngine.stats.stops >= 1, 'pending launch must receive stop when its handle arrives');
  await mustStayPending(stopping, 'stop must wait for handle.done, not handle.stop');
  lateEngine.done.resolve();
  assert.deepStrictEqual(await stopping, { ok: true, done: true });
  assert.strictEqual(late.host.release(lateBound.lease), true);

  const rejected = makeHost(root, {
    launchCodex: async () => { throw new Error('native failure'); },
  });
  selectProject(rejected.host, root, pair);
  const rejectedBound = reserveBound(rejected.host, pair, root);
  assert.deepStrictEqual(await rejected.host.launch(rejectedBound.lease, {}, () => {}, () => {}),
    { ok: false, error: 'start_failed', may_have_started: true });
  assert.strictEqual(rejected.host.isReserved(), true);

  const hangingEngine = makeHandle();
  const hanging = makeHost(root, {
    launchCodex: async () => hangingEngine.handle,
    stopTimeoutMs: 25,
  });
  selectProject(hanging.host, root, pair);
  const hangingBound = reserveBound(hanging.host, pair, root);
  await hanging.host.launch(hangingBound.lease, {}, () => {}, () => {});
  assert.deepStrictEqual(await withTimeout(hanging.host.stop(hangingBound.lease), 'hanging stop'),
    { ok: false, error: 'unknown', done: false });
  assert.strictEqual(hanging.host.isReserved(), true);

  const failedDone = deferred();
  const rejectedDoneEngine = makeHandle({ done: failedDone });
  const rejectedDone = makeHost(root, {
    launchCodex: async () => rejectedDoneEngine.handle,
    stopTimeoutMs: 100,
  });
  selectProject(rejectedDone.host, root, pair);
  const rejectedDoneBound = reserveBound(rejectedDone.host, pair, root);
  await rejectedDone.host.launch(rejectedDoneBound.lease, {}, () => {}, () => {});
  const rejectedStop = rejectedDone.host.stop(rejectedDoneBound.lease);
  failedDone.reject(new Error('unknown termination'));
  assert.deepStrictEqual(await rejectedStop, { ok: false, error: 'unknown', done: false });
  assert.strictEqual(rejectedDone.host.isReserved(), true);

  const raceEngine = makeHandle();
  let raceLease;
  const race = makeHost(root, {
    launchCodex: async () => raceEngine.handle,
    stopTimeoutMs: 100,
  });
  selectProject(race.host, root, pair);
  raceLease = reserveBound(race.host, pair, root).lease;
  await race.host.launch(raceLease, {}, () => {}, () => { race.host.release(raceLease); });
  const raceStop = race.host.stop(raceLease);
  raceEngine.done.resolve();
  assert.deepStrictEqual(await raceStop, { ok: true, done: true });
  const next = race.host.reserve(pair.event, { task_id: TASK_B });
  assert.strictEqual(next.ok, true);
  assert.strictEqual(race.host.release(next.lease), true);
}

function canonicalFingerprint(snapshot) {
  const canonical = {
    schema_version: 1,
    expected_ids: snapshot.expected_ids,
    checks: snapshot.checks.map(({ id, label, command, timeout_seconds }) => ({
      id, label, command, timeout_seconds,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function testVerificationSnapshots(root) {
  const pair = eventPair();
  const config = {
    version: 7,
    checks: [check('alpha'), check('unused')],
    preview: { command: 'preview-one' },
    review_skill: 'review-one',
  };
  const fixture = makeHost(root, { config });
  const context = selectProject(fixture.host, root, pair);
  const snapshot = fixture.host.snapshotVerification(context, [
    ...criteria(['alpha']),
    { id: 'shared', verification_source: 'verify', verify_id: 'alpha' },
  ]);
  assert.strictEqual(snapshot.ok, true);
  assert.deepStrictEqual(snapshot.expected_ids, ['alpha']);
  assert.strictEqual(snapshot.fingerprint, canonicalFingerprint(snapshot));
  const firstConfigFingerprint = snapshot.config_fingerprint;
  config.preview = { command: 'preview-two' };
  const changed = fixture.host.snapshotVerification(context, criteria(['alpha']));
  assert.notStrictEqual(changed.config_fingerprint, firstConfigFingerprint);
  config.preview = { command: 'preview-one' };
  config.checks[1].command = 'node changed-unselected.js';
  const changedUnselected = fixture.host.snapshotVerification(context, criteria(['alpha']));
  assert.notStrictEqual(changedUnselected.config_fingerprint, firstConfigFingerprint);

  const human = fixture.host.snapshotVerification(context, [
    { id: 'human', verification_source: 'human' },
  ]);
  assert.deepStrictEqual(human.expected_ids, []);
  assert.deepStrictEqual(human.checks, []);
  assert.strictEqual(human.fingerprint, canonicalFingerprint(human));
}

async function runVerificationCase(root, resultFactory) {
  const pair = eventPair();
  let runs = 0;
  const verify = {
    loadConfig: () => ({
      version: 1,
      checks: [check('alpha'), check('beta')],
      preview: null,
      review_skill: null,
    }),
    selectChecks: (config, ids) => ({
      ok: true,
      checks: ids.map((id) => config.checks.find((item) => item.id === id)),
    }),
    runChecks: async (_root, checks, options) => {
      runs += 1;
      return resultFactory(checks, options);
    },
  };
  const fixture = makeHost(root, { verify });
  const context = selectProject(fixture.host, root, pair);
  const bound = reserveBound(fixture.host, pair, root);
  const snapshot = fixture.host.snapshotVerification(context, criteria(['alpha', 'beta']));
  return { ...fixture, pair, context, bound, snapshot, runs: () => runs };
}

async function testVerificationRuntime(root) {
  const denied = await runVerificationCase(root, async () => {
    throw new Error('denied verification must not execute');
  });
  const deniedPromise = denied.host.runVerification(denied.bound.lease, denied.snapshot);
  const deniedResult = await permissionForVerification(
    denied.host, denied.pair, deniedPromise, denied.published, false,
  );
  assert.deepStrictEqual(await deniedResult, { ok: false, error: 'denied' });
  assert.strictEqual(denied.runs(), 0);

  for (const phase of ['before', 'during_permission']) {
    const changingConfig = {
      version: 1,
      checks: [check('alpha'), check('unused')],
      preview: { command: 'one' },
      review_skill: 'review-one',
    };
    let changingRuns = 0;
    const changingVerify = {
      loadConfig: () => changingConfig,
      selectChecks: (config, ids) => ({
        ok: true,
        checks: ids.map((id) => config.checks.find((item) => item.id === id)),
      }),
      runChecks: async () => { changingRuns += 1; return {}; },
    };
    const changing = makeHost(root, { verify: changingVerify });
    const changingPair = eventPair();
    const changingContext = selectProject(changing.host, root, changingPair);
    const changingBound = reserveBound(changing.host, changingPair, root);
    const changingSnapshot = changing.host.snapshotVerification(changingContext, criteria(['alpha']));
    if (phase === 'before') changingConfig.checks[1].command = 'node changed-before.js';
    const changingPromise = changing.host.runVerification(changingBound.lease, changingSnapshot);
    let changingResult;
    if (phase === 'during_permission') {
      changingConfig.review_skill = 'review-two';
      changingResult = await permissionForVerification(
        changing.host, changingPair, changingPromise, changing.published, true,
      );
    } else {
      await delay(0);
      const unexpectedPermission = changing.published.find((item) => (
        item.event && item.event.type === 'permission_request'
      ));
      if (unexpectedPermission) changing.host.resolveControl(changingPair.event, {
        run_id: RUN_A, id: unexpectedPermission.event.id, allow: true, always: false, turn: false,
      }, 'permission');
      changingResult = await changingPromise;
      assert.strictEqual(changing.published.length, 0);
    }
    assert.deepStrictEqual(changingResult, { ok: false, error: 'verification_changed' });
    assert.strictEqual(changingRuns, 0);
  }

  const exact = await runVerificationCase(root, async (checks) => ({
    ok: true,
    passed: true,
    complete: true,
    aborted: false,
    expected_ids: checks.map((item) => item.id),
    checks: checks.map((item) => ({
      id: item.id,
      passed: true,
      aborted: false,
      timed_out: false,
      stdout: 'x'.repeat(12),
      stdout_truncated: true,
    })),
  }));
  const exactPromise = exact.host.runVerification(exact.bound.lease, exact.snapshot);
  const exactResult = await permissionForVerification(
    exact.host, exact.pair, exactPromise, exact.published, true,
  );
  const completed = await exactResult;
  assert.strictEqual(completed.ok, true);
  assert.deepStrictEqual(completed.owner, exact.bound.owner);
  assert.deepStrictEqual(completed.snapshot, {
    fingerprint: exact.snapshot.fingerprint,
    expected_ids: ['alpha', 'beta'],
  });
  assert.strictEqual(completed.result.complete, true);
  assert.strictEqual(completed.result.passed, true);
  assert.strictEqual(completed.result.checks[0].stdout_truncated, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(completed, 'evidence_ref'), false);

  const variants = [
    {
      name: 'missing',
      make: (checks) => ({
        ok: true, passed: true, complete: true, aborted: false,
        expected_ids: checks.map((item) => item.id),
        checks: [{ id: 'alpha', passed: true }],
      }),
    },
    {
      name: 'duplicate',
      make: () => ({
        ok: true, passed: true, complete: true, aborted: false,
        expected_ids: ['alpha', 'beta'],
        checks: [{ id: 'alpha', passed: true }, { id: 'alpha', passed: true }],
      }),
    },
    {
      name: 'aborted',
      make: (checks) => ({
        ok: true, passed: true, complete: true, aborted: true,
        expected_ids: checks.map((item) => item.id),
        checks: checks.map((item) => ({ id: item.id, passed: true })),
      }),
    },
    {
      name: 'timeout',
      make: (checks) => ({
        ok: true, passed: true, complete: true, aborted: false,
        expected_ids: checks.map((item) => item.id),
        checks: checks.map((item, index) => ({ id: item.id, passed: true, timed_out: index === 1 })),
      }),
    },
  ];
  for (const variant of variants) {
    const item = await runVerificationCase(root, async (checks) => variant.make(checks));
    const pending = item.host.runVerification(item.bound.lease, item.snapshot);
    const resolved = await permissionForVerification(item.host, item.pair, pending, item.published, true);
    const output = await resolved;
    assert.strictEqual(output.result.complete, false, variant.name);
    assert.strictEqual(output.result.passed, false, variant.name);
  }

  const pendingPermission = await runVerificationCase(root, async () => {
    throw new Error('stopped permission must not execute');
  });
  const permissionPending = pendingPermission.host.runVerification(
    pendingPermission.bound.lease,
    pendingPermission.snapshot,
  );
  const permissionStop = pendingPermission.host.stop(pendingPermission.bound.lease);
  assert.deepStrictEqual(await permissionPending, { ok: false, error: 'denied' });
  assert.deepStrictEqual(await withTimeout(permissionStop, 'permission stop'),
    { ok: false, error: 'unknown', done: false });
  assert.strictEqual(pendingPermission.runs(), 0);
  assert.strictEqual(pendingPermission.host.isReserved(), true);

  const executeGate = deferred();
  let observedSignal;
  const executing = await runVerificationCase(root, async (_checks, options) => {
    observedSignal = options.signal;
    return executeGate.promise;
  });
  const engine = makeHandle();
  executing.host.release(executing.bound.lease);

  const executeFixture = makeHost(root, {
    verify: {
      loadConfig: () => ({
        version: 1,
        checks: [check('alpha'), check('beta')],
        preview: null,
        review_skill: null,
      }),
      selectChecks: (config, ids) => ({
        ok: true,
        checks: ids.map((id) => config.checks.find((item) => item.id === id)),
      }),
      runChecks: async (_root, _checks, options) => {
        observedSignal = options.signal;
        return executeGate.promise;
      },
    },
    launchCodex: async () => engine.handle,
    stopTimeoutMs: 200,
  });
  const executeContext = selectProject(executeFixture.host, root, executing.pair);
  const executeBound = reserveBound(executeFixture.host, executing.pair, root);
  const executeSnapshot = executeFixture.host.snapshotVerification(
    executeContext,
    criteria(['alpha', 'beta']),
  );
  await executeFixture.host.launch(executeBound.lease, {}, () => {}, () => {});
  const executingPromise = executeFixture.host.runVerification(executeBound.lease, executeSnapshot);
  const executePermission = executeFixture.published.find((item) => (
    item.event && item.event.type === 'permission_request'
  ));
  assert(executePermission);
  assert.deepStrictEqual(executeFixture.host.resolveControl(executing.pair.event, {
    run_id: RUN_A, id: executePermission.event.id, allow: true, always: false, turn: false,
  }, 'permission'), { ok: true });
  await delay(0);
  const stopping = executeFixture.host.stop(executeBound.lease);
  assert.strictEqual(observedSignal.aborted, true);
  engine.done.resolve();
  await mustStayPending(stopping, 'stop must remain pending until the running verification settles');
  executeGate.resolve({
    ok: true,
    passed: false,
    complete: false,
    aborted: true,
    expected_ids: ['alpha', 'beta'],
    checks: [{ id: 'alpha', aborted: true }],
  });
  const partial = await executingPromise;
  assert.strictEqual(partial.result.complete, false);
  assert.strictEqual(partial.result.passed, false);
  assert.deepStrictEqual(await stopping, { ok: true, done: true });

  const staleGate = deferred();
  const staleFixture = makeHost(root, {
    verify: {
      loadConfig: () => ({
        version: 1, checks: [check('alpha')], preview: null, review_skill: null,
      }),
      selectChecks: (config, ids) => ({
        ok: true, checks: ids.map((id) => config.checks.find((item) => item.id === id)),
      }),
      runChecks: () => staleGate.promise,
    },
  });
  const stalePair = eventPair();
  const staleContext = selectProject(staleFixture.host, root, stalePair);
  const staleA = reserveBound(staleFixture.host, stalePair, root);
  const staleSnapshot = staleFixture.host.snapshotVerification(staleContext, criteria(['alpha']));
  const stalePromise = staleFixture.host.runVerification(staleA.lease, staleSnapshot);
  const stalePermission = staleFixture.published.find((item) => (
    item.event && item.event.type === 'permission_request'
  ));
  assert(stalePermission);
  assert.deepStrictEqual(staleFixture.host.resolveControl(stalePair.event, {
    run_id: RUN_A, id: stalePermission.event.id, allow: true, always: false, turn: false,
  }, 'permission'), { ok: true });
  await delay(0);
  assert.strictEqual(staleFixture.host.release(staleA.lease), true);
  const staleB = reserveBound(staleFixture.host, stalePair, root, TASK_B, RUN_B);
  staleGate.resolve({
    ok: true, passed: true, complete: true, aborted: false,
    expected_ids: ['alpha'], checks: [{ id: 'alpha', passed: true }],
  });
  assert.deepStrictEqual(await stalePromise, { ok: false, error: 'stale_owner' });
  assert.deepStrictEqual(staleFixture.host.activeOwner(), staleB.owner);
  assert.strictEqual(staleFixture.host.release(staleB.lease), true);

  const human = makeHost(root);
  const pairForHuman = eventPair();
  const humanContext = selectProject(human.host, root, pairForHuman);
  const humanBound = reserveBound(human.host, pairForHuman, root);
  const humanSnapshot = human.host.snapshotVerification(humanContext, []);
  const humanResult = await human.host.runVerification(humanBound.lease, humanSnapshot);
  assert.strictEqual(humanResult.ok, true);
  assert.deepStrictEqual(humanResult.owner, humanBound.owner);
  assert.deepStrictEqual(humanResult.snapshot, {
    fingerprint: humanSnapshot.fingerprint,
    expected_ids: [],
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(humanResult, 'evidence_ref'), false);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-execution-host-test-'));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project);
  const root = fs.realpathSync.native ? fs.realpathSync.native(project) : fs.realpathSync(project);
  try {
    await testIdentityAndReservation(root);
    await testLifecycleAndControls(root);
    await testLaunchAndStopRaces(root);
    await testVerificationSnapshots(root);
    await testVerificationRuntime(root);
    console.log('execution-host: project capability, reservation, and immutable owner passed');
    console.log('execution-host: native done, stop races, stale callbacks, and single-use controls passed');
    console.log('execution-host: canonical verification, permission, abort, completeness, and truncation passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
