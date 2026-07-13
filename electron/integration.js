/**
 * بوابة التحقق التكاملي لفرق التنفيذ داخل worktree مستقل.
 *
 * مصدر الأوامر الوحيد هو blob الإعداد عند artifact.head. تُثبّت الأوامر قبل تطبيق الفرق،
 * ثم لا يبدأ أي أمر إلا بعد تأكيد مستقل. النتيجة العامة لا تحمل خرج الأوامر أو أسرارها.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const verify = require('./verify');
const worktrees = require('./worktrees');

const SAFE_ARTIFACT_ID = /^[0-9a-f]{64}$/;
const MAX_RECORDS = 20;
const CONFIG_PATH = '.satr/verify.json';

function artifactIdentity(head, patch) {
  return crypto.createHash('sha256').update(String(head || '') + '\0' + String(patch || '')).digest('hex');
}

function validArtifact(artifact) {
  return !!artifact && SAFE_ARTIFACT_ID.test(artifact.artifact_id || '')
    && /^[0-9a-f]{40,64}$/i.test(artifact.head || '')
    && typeof artifact.patch === 'string' && artifact.patch.length > 0
    && typeof artifact.sourceRoot === 'string' && artifact.sourceRoot.trim()
    && artifactIdentity(artifact.head, artifact.patch) === artifact.artifact_id;
}

function publicChecks(checks, includeCommands) {
  return (checks || []).map((check) => {
    const value = { id: check.id, label: check.label };
    if (includeCommands) {
      value.command = check.command;
      value.timeout_seconds = check.timeout_seconds;
    } else {
      value.passed = !!check.passed;
      value.exit_code = Number.isInteger(check.exit_code) ? check.exit_code : null;
      value.timed_out = !!check.timed_out;
      value.duration_ms = Math.max(0, Number(check.duration_ms) || 0);
    }
    return value;
  });
}

function publicRecord(record) {
  if (!record) return null;
  if (record.state === 'passed' || record.state === 'failed') {
    return { artifact_id: record.artifact_id, state: record.state, checks: publicChecks(record.results, false) };
  }
  return {
    artifact_id: record.artifact_id,
    state: record.state,
    checks: publicChecks(record.checks, record.state === 'pending_confirmation'),
  };
}

function configRequired(detail) {
  return {
    ok: false,
    error: 'verification_config_required',
    detail: detail || 'invalid',
    message: 'يلزم ملف .satr/verify.json صالح ومعتمد في HEAD قبل بدء غرفة قابلة للدمج.',
  };
}

function create(options) {
  const settings = options || {};
  const manager = settings.worktrees || worktrees;
  const verifier = settings.verify || verify;
  const records = new Map();
  let activeArtifactId = '';

  function remember(record) {
    records.set(record.artifact_id, record);
    while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
  }

  async function configAt(cwd, head) {
    const blob = await manager.readFileAt(cwd, head, CONFIG_PATH, verifier.MAX_CONFIG_BYTES);
    if (!blob.ok) return configRequired(blob.error);
    const config = verifier.parseConfig(blob.content);
    if (!config.ok) return configRequired(config.error);
    return { ok: true, head, sourceRoot: blob.sourceRoot, checks: config.checks };
  }

  async function preflight(cwd) {
    const repo = await manager.repository(cwd);
    if (!repo.ok) return repo;
    const configured = await configAt(repo.repoRoot, repo.head);
    if (!configured.ok) return configured;
    return {
      ok: true,
      head: repo.head,
      sourceRoot: repo.repoRoot,
      checks: publicChecks(configured.checks, true),
    };
  }

  async function prepare(artifact) {
    if (!validArtifact(artifact)) return { ok: false, error: 'bad_artifact' };
    const configured = await configAt(artifact.sourceRoot, artifact.head);
    if (!configured.ok) {
      remember({ artifact_id: artifact.artifact_id, state: 'failed', checks: [], results: [] });
      return configured;
    }
    if (path.resolve(configured.sourceRoot) !== path.resolve(artifact.sourceRoot)) {
      return { ok: false, error: 'wrong_repo' };
    }
    // Git numstat يعرض وجهة rename فقط؛ ذكر المسار الثابت في patch غموضٌ يُغلق البوابة تحفظياً.
    if (artifact.patch.includes(CONFIG_PATH)) {
      remember({ artifact_id: artifact.artifact_id, state: 'failed', checks: configured.checks, results: [] });
      return { ok: false, error: 'verification_config_changed' };
    }
    const inspected = await manager.inspectPatch(artifact.sourceRoot, artifact.patch);
    if (!inspected.ok) return { ok: false, error: inspected.error };
    if (inspected.paths.includes(CONFIG_PATH)) {
      remember({ artifact_id: artifact.artifact_id, state: 'failed', checks: configured.checks, results: [] });
      return { ok: false, error: 'verification_config_changed' };
    }
    const record = {
      artifact_id: artifact.artifact_id,
      head: artifact.head,
      sourceRoot: artifact.sourceRoot,
      patch: artifact.patch,
      state: 'pending_confirmation',
      checks: configured.checks.map((check) => ({ ...check })),
      results: [],
      controller: null,
      worktreeId: '',
      completion: null,
      resolveCompletion: null,
    };
    remember(record);
    return { ok: true, verification: publicRecord(record) };
  }

  async function run(artifact, confirmed, emit) {
    if (!validArtifact(artifact)) return { ok: false, error: 'bad_artifact' };
    if (confirmed !== true) return { ok: false, error: 'confirmation_required' };
    const record = records.get(artifact.artifact_id);
    if (!record || record.state !== 'pending_confirmation' || record.head !== artifact.head
      || record.patch !== artifact.patch || path.resolve(record.sourceRoot) !== path.resolve(artifact.sourceRoot)) {
      return { ok: false, error: 'verification_prepare_required' };
    }
    if (activeArtifactId) return { ok: false, error: 'busy' };
    activeArtifactId = record.artifact_id;
    record.state = 'running';
    record.controller = new AbortController();
    record.completion = new Promise((resolve) => { record.resolveCompletion = resolve; });
    if (typeof emit === 'function') emit({ type: 'execution_verification_update', verification: publicRecord(record) });
    let created = null;
    let failure = '';
    let cleanupFailed = false;
    try {
      created = await manager.create(record.sourceRoot, record.head);
      if (!created.ok) failure = created.error;
      if (!failure) {
        record.worktreeId = created.worktree.id;
        const applied = await manager.applyPatch(record.worktreeId, record.patch, [CONFIG_PATH]);
        if (!applied.ok) failure = applied.error === 'blocked_path' ? 'verification_config_changed' : applied.error;
      }
      if (!failure) {
        const result = await verifier.runChecks(created.worktree.path, record.checks, { signal: record.controller.signal }, {
          execute: (cwd, check, ctx) => verifier.boundedExecutor(cwd, check, ctx),
        });
        record.results = publicChecks(result.checks, false);
        record.state = result.passed && !record.controller.signal.aborted ? 'passed' : 'failed';
      }
    } catch {
      failure = 'verification_failed';
    } finally {
      let cleanup = { ok: true };
      if (record.worktreeId) cleanup = await manager.remove(record.worktreeId);
      cleanupFailed = !cleanup.ok;
      record.worktreeId = '';
      record.controller = null;
      activeArtifactId = activeArtifactId === record.artifact_id ? '' : activeArtifactId;
      if (failure || !cleanup.ok || record.state === 'running') record.state = 'failed';
      const published = publicRecord(record);
      if (typeof emit === 'function') emit({ type: 'execution_verification_update', verification: published });
      if (record.resolveCompletion) record.resolveCompletion(published);
      record.resolveCompletion = null;
    }
    if (cleanupFailed) return { ok: false, error: 'cleanup_failed', verification: publicRecord(record) };
    if (failure) return { ok: false, error: failure, verification: publicRecord(record) };
    return { ok: true, verification: publicRecord(record) };
  }

  async function stop(artifactId) {
    if (!SAFE_ARTIFACT_ID.test(artifactId || '')) return { ok: false, error: 'bad_input' };
    const record = records.get(artifactId);
    if (!record || record.state !== 'running' || !record.controller) return { ok: false, error: 'not_running' };
    record.controller.abort();
    const verification = record.completion ? await record.completion : publicRecord(record);
    return { ok: true, verification };
  }

  async function stopAll() {
    if (!activeArtifactId) return { ok: true };
    return stop(activeArtifactId);
  }

  function latest(artifactId) {
    if (!SAFE_ARTIFACT_ID.test(artifactId || '')) return null;
    return publicRecord(records.get(artifactId));
  }

  function gate(artifact, verification) {
    if (!validArtifact(artifact) || !verification) return { ok: false, error: 'verification_required' };
    if (verification.artifact_id !== artifact.artifact_id) return { ok: false, error: 'verification_artifact_mismatch' };
    if (verification.state !== 'passed') return { ok: false, error: 'verification_required' };
    return { ok: true };
  }

  return { preflight, prepare, run, stop, stopAll, latest, gate };
}

const singleton = create();

module.exports = {
  create,
  preflight: singleton.preflight,
  prepare: singleton.prepare,
  run: singleton.run,
  stop: singleton.stop,
  stopAll: singleton.stopAll,
  latest: singleton.latest,
  gate: singleton.gate,
  artifactIdentity,
  SAFE_ARTIFACT_ID,
  CONFIG_PATH,
};
