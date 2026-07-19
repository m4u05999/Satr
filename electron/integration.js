/**
 * بوابة التحقق التكاملي لفرق التنفيذ داخل worktree مستقل.
 *
 * مصدر الأوامر الوحيد هو blob الإعداد عند artifact.head. تُثبّت الأوامر قبل تطبيق الفرق،
 * ثم لا يبدأ أي أمر إلا بعد تأكيد مستقل. النتيجة العامة لا تحمل خرج الأوامر أو أسرارها.
 */

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const verify = require('./verify');
const worktrees = require('./worktrees');
const termjobs = require('./termjobs');

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

function publicPreview(record) {
  if (!record) return null;
  return { artifact_id: record.artifact_id, state: record.state, url: record.url };
}

function probeUrl(url, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(false);
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      timeout: 1000,
      ...(url.startsWith('https:') ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('timeout', () => { request.destroy(); });
    request.on('error', () => resolve(false));
  });
}

async function waitForPreviewUrl(url, timeoutMs, signal, jobAlive) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    if (typeof jobAlive === 'function' && !jobAlive()) return { ok: false, error: 'preview_exited' };
    if (await probeUrl(url, signal)) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, error: signal.aborted ? 'preview_stopped' : 'preview_timeout' };
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
  const jobs = settings.termjobs || termjobs;
  const waitForUrl = settings.waitForUrl || waitForPreviewUrl;
  const records = new Map();
  const previewRecords = new Map();
  let activeArtifactId = '';
  let activePreview = null;

  function remember(record) {
    records.set(record.artifact_id, record);
    while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
  }

  async function configAt(cwd, head) {
    const blob = await manager.readFileAt(cwd, head, CONFIG_PATH, verifier.MAX_CONFIG_BYTES);
    if (!blob.ok) return configRequired(blob.error);
    const config = verifier.parseConfig(blob.content);
    if (!config.ok) return configRequired(config.error);
    return { ok: true, head, sourceRoot: blob.sourceRoot, checks: config.checks, preview: config.preview || null };
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

  function emitPreview(record, emit) {
    if (typeof emit === 'function') emit({ type: 'execution_preview_update', preview: publicPreview(record) });
  }

  async function cleanupPreview(record, finalState, emit) {
    if (!record) return { ok: true, preview: null };
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      let failed = false;
      if (record.jobId && jobs.info(record.jobId)) {
        const stopped = jobs.stop(record.jobId);
        if (!stopped || !stopped.ok) failed = true;
        const deadline = Date.now() + 5000;
        while (jobs.info(record.jobId) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (jobs.info(record.jobId)) failed = true;
      }
      if (!jobs.info(record.jobId)) record.jobId = '';
      if (record.worktreeId) {
        const removed = await manager.remove(record.worktreeId);
        if (!removed.ok) failed = true;
        else record.worktreeId = '';
      }
      if (failed) {
        record.state = 'cleanup_failed';
        record.cleanupPromise = null;
        emitPreview(record, emit || record.emit);
        return { ok: false, error: 'cleanup_failed', preview: publicPreview(record) };
      }
      record.state = finalState;
      if (activePreview === record) activePreview = null;
      emitPreview(record, emit || record.emit);
      return { ok: true, preview: publicPreview(record) };
    })();
    return record.cleanupPromise;
  }

  async function preparePreview(artifact, confirmed, emit) {
    if (!validArtifact(artifact)) return { ok: false, error: 'bad_artifact' };
    if (confirmed !== true) return { ok: false, error: 'confirmation_required' };
    const verified = gate(artifact, latest(artifact.artifact_id));
    if (!verified.ok) return verified;
    if (activePreview) return { ok: false, error: 'busy', preview: publicPreview(activePreview) };
    const record = {
      artifact_id: artifact.artifact_id,
      state: 'starting',
      url: '',
      controller: new AbortController(),
      worktreeId: '',
      jobId: '',
      cleanupPromise: null,
      emit,
    };
    record.resourcesReady = new Promise((resolve) => { record.resolveResources = resolve; });
    activePreview = record;
    previewRecords.set(record.artifact_id, record);
    emitPreview(record, emit);
    let failure = '';
    let failureResult = null;
    let configured = null;
    const resourcesReady = () => {
      if (record.resolveResources) record.resolveResources();
      record.resolveResources = null;
    };
    try {
      configured = await configAt(artifact.sourceRoot, artifact.head);
      if (!configured.ok) { failure = configured.error; failureResult = configured; }
      else if (!configured.preview) failure = 'preview_config_required';
      else if (path.resolve(configured.sourceRoot) !== path.resolve(artifact.sourceRoot)) failure = 'wrong_repo';
      else record.url = configured.preview.url;
      if (!failure && record.controller.signal.aborted) failure = 'preview_stopped';
      if (!failure && artifact.patch.includes(CONFIG_PATH)) failure = 'verification_config_changed';
      if (!failure) {
        const inspected = await manager.inspectPatch(artifact.sourceRoot, artifact.patch);
        if (!inspected.ok) failure = inspected.error;
        else if (inspected.paths.includes(CONFIG_PATH)) failure = 'verification_config_changed';
      }
      if (!failure && record.controller.signal.aborted) failure = 'preview_stopped';
      let created = null;
      if (!failure) {
        created = await manager.create(artifact.sourceRoot, artifact.head);
        if (!created.ok) failure = created.error;
      }
      if (!failure) {
        record.worktreeId = created.worktree.id;
        const applied = await manager.applyPatch(record.worktreeId, artifact.patch, [CONFIG_PATH]);
        if (!applied.ok) failure = applied.error === 'blocked_path' ? 'verification_config_changed' : applied.error;
      }
      if (!failure && record.controller.signal.aborted) failure = 'preview_stopped';
      if (!failure) {
        const started = jobs.startJob(created.worktree.path, configured.preview.command, 'معاينة تكاملية', {
          recordDevServer: false,
          publicCwd: '',
          onExit: () => {
            record.jobId = '';
            if (record.state !== 'stopping') cleanupPreview(record, 'failed', record.emit).catch(() => {});
          },
        });
        if (!started.ok) failure = started.error;
        else record.jobId = started.id;
      }
      resourcesReady();
      if (!failure) {
        const ready = await waitForUrl(
          configured.preview.url,
          configured.preview.timeout_seconds * 1000,
          record.controller.signal,
          () => !!jobs.info(record.jobId),
        );
        if (!ready || !ready.ok) failure = ready && ready.error || 'preview_timeout';
        else if (!record.jobId || !jobs.info(record.jobId) || activePreview !== record || record.state === 'failed') {
          failure = 'preview_exited';
        }
      }
      if (!failure) {
        record.state = 'running';
        emitPreview(record, emit);
        return { ok: true, url: record.url, preview: publicPreview(record) };
      }
    } catch {
      failure = 'preview_failed';
    } finally {
      resourcesReady();
    }
    const cleaned = await cleanupPreview(record, failure === 'preview_stopped' ? 'stopped' : 'failed', emit);
    if (!cleaned.ok) return cleaned;
    if (failureResult) return { ...failureResult, preview: publicPreview(record) };
    return { ok: false, error: failure || 'preview_failed', preview: publicPreview(record) };
  }

  async function stopPreview() {
    if (!activePreview) return { ok: true, preview: null };
    const record = activePreview;
    record.state = 'stopping';
    record.controller.abort();
    emitPreview(record, record.emit);
    if (record.resourcesReady) await record.resourcesReady;
    return cleanupPreview(record, 'stopped', record.emit);
  }

  function latestPreview(artifactId) {
    if (artifactId != null && !SAFE_ARTIFACT_ID.test(artifactId || '')) return null;
    return publicPreview(artifactId ? previewRecords.get(artifactId) : activePreview);
  }

  async function stopAll() {
    const results = await Promise.all([
      activeArtifactId ? stop(activeArtifactId) : Promise.resolve({ ok: true }),
      activePreview ? stopPreview() : Promise.resolve({ ok: true }),
    ]);
    return results.find((result) => !result.ok) || { ok: true };
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

  return { preflight, prepare, run, stop, preparePreview, stopPreview, latestPreview, stopAll, latest, gate };
}

const singleton = create();

module.exports = {
  create,
  preflight: singleton.preflight,
  prepare: singleton.prepare,
  run: singleton.run,
  stop: singleton.stop,
  preparePreview: singleton.preparePreview,
  stopPreview: singleton.stopPreview,
  latestPreview: singleton.latestPreview,
  stopAll: singleton.stopAll,
  latest: singleton.latest,
  gate: singleton.gate,
  artifactIdentity,
  SAFE_ARTIFACT_ID,
  CONFIG_PATH,
};
