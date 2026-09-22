'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SAFE_TASK_ID = /^task_[a-f0-9]{32}$/;
const SAFE_RUN_ID = /^run_[a-f0-9]{32}$/;
const SAFE_PROJECT_ID = /^project_[a-f0-9]{64}$/;
const SAFE_CONTROL_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const SAFE_HANDOFF_ID = /^ho_[A-Za-z0-9_]{1,64}$/;
const MAX_EVENT_BYTES = 256 * 1024;

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizeRoot(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function projectIdFor(root) { return 'project_' + digest(normalizeRoot(root)); }
function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}
function eventKey(event) {
  if (!event || !event.sender || !event.senderFrame || event.sender.mainFrame !== event.senderFrame) return null;
  return event.sender;
}
function sanitizeQuestionSelections(value) {
  if (!Array.isArray(value) || value.length > 4) return null;
  return value.map((selection) => ({
    questionIndex: Number.isInteger(selection && selection.questionIndex) ? selection.questionIndex : -1,
    optionIndexes: Array.isArray(selection && selection.optionIndexes) && selection.optionIndexes.length <= 4
      ? selection.optionIndexes.map((index) => (Number.isInteger(index) ? index : -1)) : [-1],
    text: typeof (selection && selection.text) === 'string' && Array.from(selection.text).length <= 4000
      ? selection.text : null,
  }));
}

function create(options = {}) {
  if (typeof options.isCoreBusy !== 'function' || typeof options.launchCodex !== 'function'
      || typeof options.publish !== 'function' || !options.verify) {
    throw new Error('saved_task_host_dependencies');
  }
  const fileSystem = options.fs || fs;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const stopTimeoutMs = Number.isFinite(options.stopTimeoutMs) ? options.stopTimeoutMs : 10000;
  const projects = new WeakMap();
  const projectContexts = new WeakSet();
  const invalidatedProjects = new WeakSet();
  let active = null;
  let storeFactory = null;
  let shutdownHandler = null;

  function trustedProject(event) {
    const key = eventKey(event);
    const context = key && projects.get(key);
    return context && context.frame === event.senderFrame ? context : null;
  }

  function rememberProject(event, projectRoot) {
    const key = eventKey(event);
    if (!key) return { ok: false, error: 'untrusted_sender' };
    if (active) return { ok: false, error: 'task_busy' };
    let real;
    try {
      const stat = fileSystem.lstatSync(projectRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      real = fileSystem.realpathSync.native ? fileSystem.realpathSync.native(projectRoot) : fileSystem.realpathSync(projectRoot);
    } catch { return { ok: false, error: 'bad_project' }; }
    const context = Object.freeze({ root: real, sender: key, frame: event.senderFrame, selected_at: now() });
    invalidatedProjects.delete(key);
    projects.set(key, context);
    projectContexts.add(context);
    return { ok: true, projectRoot: real };
  }

  function clearProject(event) {
    const key = eventKey(event);
    if (!key) return false;
    if (active && active.context && active.context.sender === key) invalidatedProjects.add(key);
    else projects.delete(key);
    return true;
  }

  function getProjectContext(event) {
    const key = eventKey(event);
    if (key && invalidatedProjects.has(key) && !active) {
      projects.delete(key);
      invalidatedProjects.delete(key);
      return { ok: false, error: 'project_required' };
    }
    const context = trustedProject(event);
    return context ? { ok: true, context } : { ok: false, error: 'project_required' };
  }

  function resolveTrustedProjectRoot(context) {
    if (!context || !projectContexts.has(context)) throw new Error('project_required');
    const current = projects.get(context.sender);
    if (current !== context || current.frame !== context.sender.mainFrame) throw new Error('stale_project');
    return context.root;
  }

  function projectInfo(context) {
    const root = resolveTrustedProjectRoot(context);
    return Object.freeze({ project_id: projectIdFor(root), path: root });
  }

  function sameWindow(event, context) {
    return !!context && trustedProject(event) === context;
  }

  function reserve(event, owner) {
    if (active || options.isCoreBusy()) return { ok: false, error: 'busy' };
    const context = trustedProject(event);
    if (!context) return { ok: false, error: 'project_required' };
    if (!owner || !SAFE_TASK_ID.test(owner.task_id || '')) return { ok: false, error: 'bad_owner' };
    const lease = Object.freeze({ id: randomBytes(16).toString('hex') });
    active = {
      lease, context, task_id: owner.task_id, run_id: null, project_id: null,
      turn_token: randomBytes(16).toString('hex'), handle: null, launching: false,
      stop_requested: false, done: false, controls: new Map(), consumedControls: new Set(), released: false, verifyOperation: null,
      handleReady: null, resolveHandleReady: null,
    };
    active.handleReady = new Promise((resolve) => { active.resolveHandleReady = resolve; });
    return { ok: true, lease };
  }

  function owned(lease) { return !!active && active.lease === lease && !active.released; }
  function bindRun(lease, owner) {
    if (!owned(lease) || active.run_id || !owner || !SAFE_RUN_ID.test(owner.run_id || '')
        || !SAFE_PROJECT_ID.test(owner.project_id || '') || owner.task_id !== active.task_id
        || owner.project_id !== projectIdFor(active.context.root)) {
      return { ok: false, error: 'bad_owner' };
    }
    active.run_id = owner.run_id;
    active.project_id = owner.project_id;
    return { ok: true };
  }

  function publicOwner() {
    return active && active.run_id ? {
      project_id: active.project_id, task_id: active.task_id, run_id: active.run_id,
    } : null;
  }

  function safeEvent(value) {
    try {
      const cloned = plain(value);
      return Buffer.byteLength(JSON.stringify(cloned), 'utf8') <= MAX_EVENT_BYTES ? cloned : null;
    } catch { return null; }
  }

  function noteControl(event) {
    if (!active || active.stop_requested || active.done || !event
        || typeof event.id !== 'string' || !SAFE_CONTROL_ID.test(event.id)) return;
    const kind = event.type === 'permission_request' ? 'permission'
      : event.type === 'question_request' ? 'question'
        : event.type === 'handoff_request' ? 'handoff' : '';
    if (!kind || (kind === 'handoff' && !SAFE_HANDOFF_ID.test(event.id))) return;
    const key = kind + ':' + event.id;
    if (active.consumedControls.has(key) || active.controls.has(key)) return;
    active.controls.set(key, { target: 'handle' });
  }

  async function launch(lease, input, onEvent, onDone) {
    if (!owned(lease) || active.handle || active.launching) return { ok: false, error: 'bad_lease' };
    active.launching = true;
    try {
      const handle = await options.launchCodex(input, active.context.root, (raw) => {
        if (!owned(lease)) return;
        noteControl(raw);
        const event = safeEvent(raw);
        if (event && typeof onEvent === 'function') onEvent(event);
      });
      if (!handle || typeof handle.stop !== 'function' || !handle.done || typeof handle.done.then !== 'function') {
        if (handle && typeof handle.stop === 'function') Promise.resolve(handle.stop()).catch(() => {});
        if (owned(lease) && active.resolveHandleReady) active.resolveHandleReady(null);
        return { ok: false, error: 'invalid_handle', may_have_started: true };
      }
      if (!owned(lease)) {
        Promise.resolve(handle.stop()).catch(() => {});
        return { ok: false, error: 'stale_lease' };
      }
      active.handle = handle;
      if (active.resolveHandleReady) active.resolveHandleReady(handle);
      if (active.stop_requested) Promise.resolve(handle.stop()).catch(() => {});
      Promise.resolve(handle.done).then(
        () => {
          if (!owned(lease)) return;
          active.done = true;
          for (const [key, control] of active.controls) if (control.target === 'handle') {
            active.controls.delete(key);
            active.consumedControls.add(key);
          }
          if (typeof onDone === 'function') Promise.resolve(onDone(true)).catch(() => {
            publish(lease, { type: 'saved_task_storage_pending', error: 'completion_handler_failed' });
          });
        },
        () => {
          if (!owned(lease)) return;
          active.done = true;
          for (const [key, control] of active.controls) if (control.target === 'handle') {
            active.controls.delete(key);
            active.consumedControls.add(key);
          }
          if (typeof onDone === 'function') Promise.resolve(onDone(false)).catch(() => {
            publish(lease, { type: 'saved_task_storage_pending', error: 'completion_handler_failed' });
          });
        },
      );
      return { ok: true };
    } catch {
      if (owned(lease) && active.resolveHandleReady) active.resolveHandleReady(null);
      return { ok: false, error: 'start_failed', may_have_started: true };
    } finally {
      if (owned(lease)) active.launching = false;
    }
  }

  function publish(lease, event) {
    if (!owned(lease)) return false;
    const owner = publicOwner();
    const safe = safeEvent(event);
    if (!owner || !safe) return false;
    try { return options.publish(active.context, { owner, event: safe }) === true; } catch { return false; }
  }

  function resolveControl(event, payload, kind) {
    if (!active || active.stop_requested || !sameWindow(event, active.context) || !payload || payload.run_id !== active.run_id
        || typeof payload.id !== 'string' || !SAFE_CONTROL_ID.test(payload.id)) {
      return { ok: false, error: 'stale_owner' };
    }
    const key = kind + ':' + payload.id;
    const control = active.controls.get(key);
    if (!control) return { ok: false, error: 'not_pending' };
    if (control.target === 'verify') {
      if (kind !== 'permission' || typeof payload.allow !== 'boolean' || typeof payload.always !== 'boolean'
          || typeof payload.turn !== 'boolean') return { ok: false, error: 'bad_input' };
      active.controls.delete(key);
      active.consumedControls.add(key);
      try { control.resolve(payload.allow); return { ok: true }; }
      catch { return { ok: false, error: 'rejected' }; }
    }
    if (!active.handle) return { ok: false, error: 'not_pending' };
    let ok = false;
    if (kind === 'permission') {
      if (typeof payload.allow !== 'boolean' || typeof payload.always !== 'boolean' || typeof payload.turn !== 'boolean'
          || typeof active.handle.resolvePermission !== 'function') return { ok: false, error: 'bad_input' };
      active.controls.delete(key);
      active.consumedControls.add(key);
      try { ok = active.handle.resolvePermission(payload.id, payload.allow, payload.always, payload.turn); }
      catch { return { ok: false, error: 'rejected' }; }
    } else if (kind === 'question') {
      const selections = sanitizeQuestionSelections(payload.selections);
      if (!selections || typeof active.handle.resolveQuestion !== 'function') return { ok: false, error: 'bad_input' };
      active.controls.delete(key);
      active.consumedControls.add(key);
      try { ok = active.handle.resolveQuestion(payload.id, selections); }
      catch { return { ok: false, error: 'rejected' }; }
    } else if (kind === 'handoff') {
      if (!SAFE_HANDOFF_ID.test(payload.id) || typeof payload.done !== 'boolean'
          || typeof active.handle.resolveHandoff !== 'function') return { ok: false, error: 'bad_input' };
      active.controls.delete(key);
      active.consumedControls.add(key);
      try { ok = active.handle.resolveHandoff(payload.id, payload.done); }
      catch { return { ok: false, error: 'rejected' }; }
    }
    return { ok: ok === true, ...(ok === true ? {} : { error: 'rejected' }) };
  }

  async function stop(lease) {
    if (!owned(lease)) return { ok: false, error: 'bad_lease' };
    const ownedRun = active;
    ownedRun.stop_requested = true;
    if (ownedRun.verifyOperation) ownedRun.verifyOperation.controller.abort();
    for (const [key, control] of ownedRun.controls) {
      if (control.target === 'verify') {
        ownedRun.controls.delete(key);
        ownedRun.consumedControls.add(key);
        try { control.resolve(false); } catch {}
      }
    }
    let timer;
    const wait = (async () => {
      const handle = ownedRun.handle || await ownedRun.handleReady;
      if (!handle) return false;
      try { Promise.resolve(handle.stop()).catch(() => {}); } catch {}
      const engineDone = await Promise.resolve(handle.done).then(() => true, () => false);
      if (!engineDone) return false;
      if (ownedRun.verifyOperation) await ownedRun.verifyOperation.done.catch(() => {});
      return !ownedRun.verifyOperation;
    })();
    const confirmed = await Promise.race([
      wait,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), stopTimeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return confirmed ? { ok: true, done: true } : { ok: false, error: 'unknown', done: false };
  }
  function release(lease) {
    if (!owned(lease)) return false;
    active.released = true;
    active.controls.clear();
    const sender = active.context && active.context.sender;
    active = null;
    if (sender && invalidatedProjects.has(sender)) {
      projects.delete(sender);
      invalidatedProjects.delete(sender);
    }
    return true;
  }

  function configuredVerification(context) {
    let root;
    try { root = resolveTrustedProjectRoot(context); } catch { return { ok: false, error: 'project_required' }; }
    const configured = options.verify.loadConfig(root);
    if (!configured || configured.ok === false || !Array.isArray(configured.checks)) {
      return { ok: false, error: 'verify_unavailable', status: 'no_checks', checks: [] };
    }
    const fullConfig = {
      version: configured.version,
      checks: configured.checks.map((check) => ({
        id: check.id, label: check.label, command: check.command, timeout_seconds: check.timeout_seconds,
      })),
      preview: configured.preview || null,
      review_skill: configured.review_skill || null,
    };
    return { ok: true, root, configured, config_fingerprint: digest(JSON.stringify(fullConfig)) };
  }

  function verificationCatalog(context) {
    const loaded = configuredVerification(context);
    if (!loaded.ok) return loaded;
    const checks = loaded.configured.checks.map((check) => ({
      id: check.id, label: check.label, timeout_seconds: check.timeout_seconds,
    }));
    return Object.freeze({
      ok: true, status: checks.length ? 'available' : 'no_checks',
      config_fingerprint: loaded.config_fingerprint, checks: Object.freeze(checks),
    });
  }

  function snapshotVerification(context, criteria) {
    try { resolveTrustedProjectRoot(context); } catch { return { ok: false, error: 'project_required' }; }
    const ids = [];
    for (const criterion of Array.isArray(criteria) ? criteria : []) {
      if (criterion && criterion.verification_source === 'verify' && !ids.includes(criterion.verify_id)) {
        ids.push(criterion.verify_id);
      }
    }
    if (!ids.length) {
      const canonical = { schema_version: 1, expected_ids: [], checks: [] };
      return { ok: true, ...canonical, fingerprint: digest(JSON.stringify(canonical)), config_fingerprint: digest('none') };
    }
    const loaded = configuredVerification(context);
    if (!loaded.ok) return loaded;
    const configured = loaded.configured;
    const selected = options.verify.selectChecks(configured, ids);
    if (!selected || !selected.ok) return { ok: false, error: (selected && selected.error) || 'verify_unavailable' };
    const checks = plain(selected.checks);
    const expected = checks.map((check) => check.id);
    if (!sameArray(ids, expected)) return { ok: false, error: 'verify_mismatch' };
    const canonical = { schema_version: 1, expected_ids: expected, checks: checks.map((check) => ({
      id: check.id, label: check.label, command: check.command, timeout_seconds: check.timeout_seconds,
    })) };

    return Object.freeze({
      ok: true, schema_version: 1, expected_ids: Object.freeze(expected),
      checks: Object.freeze(canonical.checks), fingerprint: digest(JSON.stringify(canonical)),
      config_fingerprint: loaded.config_fingerprint,
    });
  }

  async function runVerification(lease, snapshot) {
    if (!owned(lease) || !snapshot || snapshot.ok !== true || active.stop_requested) {
      return { ok: false, error: 'bad_lease' };
    }
    const ownedRun = active;
    const captured = { lease, context: ownedRun.context, owner: publicOwner() };
    const expected = Array.from(snapshot.expected_ids || []);
    const stillMatches = () => {
      const live = snapshotVerification(captured.context, expected.map((verifyId) => ({
        verification_source: 'verify', verify_id: verifyId,
      })));
      return live.ok === true && live.fingerprint === snapshot.fingerprint
        && live.config_fingerprint === snapshot.config_fingerprint;
    };
    if (!expected.length) {
      return {
        ok: true,
        result: { ok: true, passed: true, complete: true, aborted: false, expected_ids: [], checks: [] },
        owner: captured.owner,
        snapshot: { fingerprint: snapshot.fingerprint, expected_ids: [] },
      };
    }
    if (!stillMatches()) return { ok: false, error: 'verification_changed' };
    const permissionId = 'verify_task_' + randomBytes(12).toString('hex');
    const allowed = await new Promise((resolve) => {
      ownedRun.controls.set('permission:' + permissionId, { target: 'verify', resolve });
      publish(lease, {
        type: 'permission_request', id: permissionId, tool: 'verify_project',
        input: { checks: snapshot.checks.map((check) => ({ id: check.id, command: check.command })) },
      });
    });
    if (!allowed || !owned(lease) || active !== ownedRun
        || ownedRun.context !== captured.context || ownedRun.stop_requested) {
      return { ok: false, error: allowed ? 'stale_owner' : 'denied' };
    }
    if (!stillMatches()) return { ok: false, error: 'verification_changed' };
    const controller = new AbortController();
    let settleOperation;
    const operationDone = new Promise((resolve) => { settleOperation = resolve; });
    ownedRun.verifyOperation = { controller, done: operationDone };
    let result;
    try {
      result = await options.verify.runChecks(captured.context.root, plain(snapshot.checks), {
        signal: controller.signal,
        emit: (event) => publish(lease, event),
      });
    } finally {
      if (ownedRun.verifyOperation && ownedRun.verifyOperation.controller === controller) {
        ownedRun.verifyOperation = null;
      }
      settleOperation();
    }
    if (!owned(lease) || active !== ownedRun || ownedRun.context !== captured.context
        || !captured.owner || captured.owner.run_id !== ownedRun.run_id) return { ok: false, error: 'stale_owner' };
    const checks = result && Array.isArray(result.checks) ? result.checks : [];
    const executed = checks.map((check) => check && check.id);
    const exact = sameArray(result && result.expected_ids, expected) && sameArray(executed, expected)
      && new Set(executed).size === executed.length;
    const complete = !!(result && result.ok && result.complete === true && result.aborted === false && exact
      && checks.every((check) => check && check.aborted !== true && check.timed_out !== true));
    const normalized = { ...plain(result || {}), passed: complete && result.passed === true, complete };
    return {
      ok: true,
      result: normalized,
      owner: captured.owner,
      snapshot: { fingerprint: snapshot.fingerprint, expected_ids: expected },
    };
  }
  function registerFactory(factory) {
    if (storeFactory || !factory || typeof factory.forProject !== 'function') throw new Error('saved_task_factory_invalid');
    storeFactory = factory;
  }
  async function storeFor(context) {
    if (!storeFactory || !projectContexts.has(context)) throw new Error('feature_unavailable');
    return storeFactory.forProject(context);
  }
  function registerShutdown(fn) {
    if (shutdownHandler || typeof fn !== 'function') throw new Error('saved_task_shutdown_invalid');
    shutdownHandler = fn;
  }
  async function shutdown() {
    if (!active || !shutdownHandler) return { ok: true };
    try { return await shutdownHandler(); } catch { return { ok: false, error: 'shutdown_failed' }; }
  }

  return Object.freeze({
    rememberProject, clearProject, getProjectContext, resolveTrustedProjectRoot, projectInfo, sameWindow,
    reserve, bindRun, launch, publish, resolveControl, stop, release,
    snapshotVerification, verificationCatalog, runVerification, registerFactory, storeFor, registerShutdown, shutdown,
    isReserved: () => !!active,
    activeOwner: () => plain(publicOwner()),
    storageSeam: Object.freeze({
      registerFactory, getDataRoot: options.getDataRoot, resolveTrustedProjectRoot,
      hasSecret: options.hasSecret, hasEntitlement: options.hasEntitlement,
    }),
  });
}

module.exports = {
  create, sanitizeQuestionSelections, SAFE_TASK_ID, SAFE_RUN_ID, SAFE_PROJECT_ID,
};
