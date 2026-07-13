/**
 * منسّق عوامل SDK منفّذة متوازية — الأولوية 6/الخطوة 3.
 *
 * كل عامل يملك worktree منفصلاً وملكية كتابة معلنة غير متداخلة. لا دمج ولا commit؛
 * أي تداخل مسبق أو لمس الملف نفسه يوقف الفريق ويفشل مغلقاً.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const executorModule = require('./executor');
const worktrees = require('./worktrees');

const MAX_AGENTS = 3;
const MAX_RUNS = 10;
const SAFE_RUN_ID = /^execution-team-[a-z0-9-]{6,80}$/;
const SAFE_ROOM_ID = /^ops-room-[a-z0-9-]{6,80}$/;
const TERMINAL_AGENT_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed']);
const TERMINAL_TEAM_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed']);

let sequence = 0;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function ownershipConflicts(agents) {
  const conflicts = [];
  for (let left = 0; left < agents.length; left++) {
    for (let right = left + 1; right < agents.length; right++) {
      if (executorModule.ownershipsOverlap(agents[left].ownership, agents[right].ownership)) {
        conflicts.push({ left, right, reason: 'ownership_overlap' });
      }
    }
  }
  return conflicts;
}

function artifactId(head, patch) {
  return crypto.createHash('sha256').update(String(head || '') + '\0' + String(patch || '')).digest('hex');
}

function agentPublic(worker) {
  const snapshot = worker.snapshot || {};
  return {
    id: worker.id,
    label: worker.label,
    task: worker.task,
    engine: snapshot.engine || worker.engine || '',
    ownership: worker.ownership.slice(),
    state: snapshot.state || worker.state,
    summary: snapshot.summary || '',
    error: snapshot.error || worker.error || '',
    duration_ms: Math.max(0, Number(snapshot.duration_ms) || 0),
    cost: { ...(snapshot.cost || { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false }) },
    permissions: { ...(snapshot.permissions || { write_limit: executorModule.MAX_WRITE_PERMISSIONS, write_used: 0, denied: 0 }) },
    edits_seen: Math.max(0, Number(snapshot.edits_seen) || 0),
    changes: snapshot.changes
      ? { ...snapshot.changes, files: snapshot.changes.files.map((file) => ({ ...file })) }
      : { files: [], more: 0, partial: false, added: 0, removed: 0 },
    worktree: snapshot.worktree ? { ...snapshot.worktree } : null,
    artifact_ready: snapshot.artifact_ready === true,
    patch_bytes: Math.max(0, Number(snapshot.patch_bytes) || 0),
    merged: false,
    merge_supported: false,
  };
}

function teamPublic(team) {
  const agents = team.agents.map(agentPublic);
  const artifactReady = team.state === 'completed' && agents.length > 0 && agents.every((agent) => agent.artifact_ready === true);
  const artifact = artifactReady ? buildArtifact(team) : null;
  const cost = agents.reduce((total, agent) => ({
    usd: total.usd + (Number(agent.cost.usd) || 0),
    input_tokens: total.input_tokens + (Number(agent.cost.input_tokens) || 0),
    output_tokens: total.output_tokens + (Number(agent.cost.output_tokens) || 0),
    estimate: total.estimate || agent.cost.estimate === true,
  }), { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false });
  return {
    id: team.id,
    room_id: team._roomId,
    type: 'execution_team_update',
    schema_version: 1,
    state: team.state,
    created_at: team.created_at,
    updated_at: team.updated_at,
    duration_ms: team.duration_ms,
    cost,
    conflicts: team.conflicts.map((conflict) => ({ ...conflict })),
    agents,
    artifact_id: artifact ? artifact.artifact_id : '',
    producer_engines: artifact ? artifact.producer_engines.slice() : [],
    mode: team._mode,
    verification: team._verification ? {
      artifact_id: team._verification.artifact_id,
      state: team._verification.state,
      checks: (team._verification.checks || []).map((check) => ({ ...check })),
    } : null,
    merged: team._merged === true,
    merge_supported: team._mode === 'mergeable' && !!artifact && team._merged !== true,
  };
}

function buildArtifact(team) {
  const artifacts = team.agents.map((worker) => {
    if (!worker.executor || !worker.snapshot || typeof worker.executor.artifact !== 'function') return null;
    return worker.executor.artifact(worker.snapshot.id);
  });
  if (artifacts.some((item) => !item || !item.patch)) return null;
  const head = artifacts[0].head;
  const sourceRoot = artifacts[0].sourceRoot;
  if (artifacts.some((item) => item.head !== head || path.resolve(item.sourceRoot) !== path.resolve(sourceRoot))) return null;
  const patch = artifacts.map((item) => item.patch.trimEnd()).filter(Boolean).join('\n') + '\n';
  const producerEngines = ['sdk', 'codex'].filter((engine) => team.agents.some((worker) => {
    const workerEngine = cleanText(worker.snapshot && worker.snapshot.engine, 32) || cleanText(worker.engine, 32);
    return workerEngine === engine || workerEngine.startsWith(engine + '-');
  }));
  if (!producerEngines.length) return null;
  const identity = artifactId(head, patch);
  return {
    schema_version: 1,
    artifact_id: identity,
    room_id: team._roomId,
    team_id: team.id,
    teamId: team.id,
    cwd: team._cwd,
    source_root: sourceRoot,
    sourceRoot,
    head,
    patch,
    bytes: Buffer.byteLength(patch, 'utf8'),
    producer_engines: producerEngines,
    ownership: team.agents.map((worker) => worker.ownership.slice()),
    files: team.agents.flatMap((worker) => ((worker.snapshot && worker.snapshot.changes && worker.snapshot.changes.files) || [])
      .map((file) => ({
        ...file,
        agent: worker.label,
        agent_id: worker.id,
        engine: cleanText(worker.snapshot && worker.snapshot.engine, 32) || cleanText(worker.engine, 32),
      }))),
  };
}

function create(options) {
  const settings = options || {};
  const manager = settings.worktrees || worktrees;
  const runner = settings.runner;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const makeExecutor = typeof settings.createExecutor === 'function'
    ? settings.createExecutor
    : (executorOptions) => executorModule.create(executorOptions);
  const runs = new Map();
  let activeRunId = null;

  function publish(team) {
    team.updated_at = now();
    if (typeof team._emit === 'function') team._emit({ type: 'execution_team_update', team: teamPublic(team) });
  }

  function allTerminal(team) {
    return team.agents.every((worker) => TERMINAL_AGENT_STATES.has((worker.snapshot && worker.snapshot.state) || worker.state));
  }

  function finalizeState(team) {
    if (!allTerminal(team)) return;
    if (team.conflicts.length) team.state = 'conflict';
    else if (team._stopRequested) team.state = 'stopped';
    else {
      const states = team.agents.map((worker) => (worker.snapshot && worker.snapshot.state) || worker.state);
      if (states.every((state) => state === 'completed')) team.state = 'completed';
      else if (states.includes('cleanup_failed')) team.state = 'cleanup_failed';
      else if (states.includes('timed_out')) team.state = 'timed_out';
      else team.state = 'failed';
    }
    team.duration_ms = Math.max(0, now() - team.created_at);
    activeRunId = activeRunId === team.id ? null : activeRunId;
  }

  async function stopWorkers(team) {
    await Promise.all(team.agents.map((worker) => {
      if (!worker.executor || !worker.snapshot || TERMINAL_AGENT_STATES.has(worker.snapshot.state)) return null;
      return worker.executor.stop(worker.snapshot.id).catch(() => null);
    }));
  }

  function detectTouchedConflict(team) {
    const touched = new Map();
    for (let index = 0; index < team.agents.length; index++) {
      const files = team.agents[index].snapshot && team.agents[index].snapshot.changes
        ? team.agents[index].snapshot.changes.files : [];
      for (const file of files) {
        const relative = String(file.rel || '').replace(/\\/g, '/');
        if (!relative) continue;
        if (touched.has(relative) && touched.get(relative) !== index) {
          const conflict = { left: touched.get(relative), right: index, reason: 'same_file', path: relative };
          if (!team.conflicts.some((item) => item.reason === conflict.reason && item.path === relative)) team.conflicts.push(conflict);
        } else touched.set(relative, index);
      }
    }
    if (team.conflicts.length && !team._conflictStopping) {
      team._conflictStopping = true;
      team.state = 'conflict';
      publish(team);
      stopWorkers(team).finally(() => { finalizeState(team); publish(team); });
    }
  }

  function onAgentEvent(team, worker, event) {
    if (!event || event.type !== 'execution_update' || !event.run) return;
    worker.snapshot = event.run;
    worker.state = event.run.state;
    detectTouchedConflict(team);
    finalizeState(team);
    publish(team);
  }

  async function start(input, cwd, emit) {
    const specs = input && Array.isArray(input.agents) ? input.agents : [];
    const mode = input && input.mode === 'draft' ? 'draft' : 'mergeable';
    const roomId = cleanText(input && (input.roomId || input.room_id), 96);
    if (specs.length < 1 || specs.length > MAX_AGENTS || typeof cwd !== 'string' || !cwd.trim()) {
      return { ok: false, error: 'bad_input' };
    }
    if (roomId && !SAFE_ROOM_ID.test(roomId)) return { ok: false, error: 'bad_input' };
    if (mode === 'draft' && specs.length !== 1) return { ok: false, error: 'draft_single_engine_only' };
    if (activeRunId) return { ok: false, error: 'busy' };
    const agents = [];
    for (const spec of specs) {
      const task = cleanText(spec && spec.task, 4000);
      const ownership = executorModule.normalizeOwnership(spec && spec.ownership);
      if (!task || !ownership) return { ok: false, error: 'bad_input' };
      agents.push({ task, ownership });
    }
    const declared = ownershipConflicts(agents);
    if (declared.length) return { ok: false, error: 'ownership_overlap', conflicts: declared };

    const createdAt = now();
    const team = {
      id: 'execution-team-' + createdAt.toString(36) + '-' + (++sequence).toString(36),
      state: 'preparing',
      created_at: createdAt,
      updated_at: createdAt,
      duration_ms: 0,
      conflicts: [],
      agents: agents.map((spec, index) => ({
        id: 'executor-' + (index + 1),
        label: 'عامل ' + (index + 1),
        task: spec.task,
        engine: cleanText(runner && runner.engine, 32),
        ownership: spec.ownership,
        state: 'queued',
        error: '',
        snapshot: null,
        executor: null,
      })),
      _cwd: path.resolve(cwd),
      _emit: emit,
      _stopRequested: false,
      _conflictStopping: false,
      _mode: mode,
      _roomId: roomId,
      _verification: null,
      _merged: false,
    };
    runs.set(team.id, team);
    while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
    activeRunId = team.id;
    publish(team);

    const results = await Promise.all(team.agents.map(async (worker) => {
      worker.executor = makeExecutor({ worktrees: manager, runner, timeoutMs: settings.timeoutMs });
      const result = await worker.executor.start({ task: worker.task, ownership: worker.ownership }, cwd,
        (event) => onAgentEvent(team, worker, event));
      if (!result || !result.ok) {
        worker.state = 'failed';
        worker.error = cleanText((result && result.error) || 'start_failed', 500);
      } else {
        worker.snapshot = result.run;
        worker.state = result.run.state;
      }
      publish(team);
      return result;
    }));

    if (results.some((result) => !result || !result.ok)) {
      team._stopRequested = true;
      await stopWorkers(team);
      team.state = 'failed';
      team.duration_ms = Math.max(0, now() - team.created_at);
      activeRunId = activeRunId === team.id ? null : activeRunId;
      publish(team);
      return { ok: false, error: 'agent_start_failed', team: teamPublic(team) };
    }
    team.state = 'running';
    finalizeState(team);
    publish(team);
    return { ok: true, team: teamPublic(team) };
  }

  async function stop(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const team = runs.get(runId);
    if (!team) return { ok: false, error: 'not_found' };
    if (TERMINAL_TEAM_STATES.has(team.state)) return { ok: true, team: teamPublic(team) };
    team._stopRequested = true;
    team.state = 'stopping';
    publish(team);
    await stopWorkers(team);
    finalizeState(team);
    if (!TERMINAL_TEAM_STATES.has(team.state)) team.state = 'stopped';
    team.duration_ms = Math.max(0, now() - team.created_at);
    activeRunId = activeRunId === team.id ? null : activeRunId;
    publish(team);
    return { ok: true, team: teamPublic(team) };
  }

  async function stopAll() {
    return activeRunId ? stop(activeRunId) : { ok: true, team: null };
  }

  function latest(cwd) {
    const team = [...runs.values()].slice(-1)[0];
    if (team && typeof cwd === 'string' && cwd.trim() && path.resolve(cwd) !== team._cwd) return null;
    return team ? teamPublic(team) : null;
  }

  function artifact(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return null;
    const team = runs.get(runId);
    if (!team || team.state !== 'completed' || team._merged || team._mode !== 'mergeable') return null;
    return buildArtifact(team);
  }

  function references(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return null;
    const team = runs.get(runId);
    if (!team || !SAFE_ROOM_ID.test(team._roomId || '')) return null;
    const built = team.state === 'completed' ? buildArtifact(team) : null;
    return {
      room_id: team._roomId,
      team_id: team.id,
      artifact_id: built ? built.artifact_id : '',
    };
  }

  function setVerification(runId, verification) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const team = runs.get(runId);
    const artifact = team && team._mode === 'mergeable' ? buildArtifact(team) : null;
    if (!team || team.state !== 'completed' || !artifact || !verification
      || verification.artifact_id !== artifact.artifact_id
      || !['pending_confirmation', 'running', 'passed', 'failed'].includes(verification.state)) {
      return { ok: false, error: 'verification_artifact_mismatch' };
    }
    team._verification = {
      artifact_id: verification.artifact_id,
      state: verification.state,
      checks: Array.isArray(verification.checks) ? verification.checks.map((check) => ({ ...check })) : [],
    };
    publish(team);
    return { ok: true, team: teamPublic(team) };
  }

  function markMerged(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const team = runs.get(runId);
    if (!team || team.state !== 'completed' || team._merged) return { ok: false, error: 'not_available' };
    team._merged = true;
    publish(team);
    return { ok: true, team: teamPublic(team) };
  }

  return { start, stop, stopAll, latest, artifact, references, setVerification, markMerged };
}

const singleton = create();

module.exports = {
  create,
  start: singleton.start,
  stop: singleton.stop,
  stopAll: singleton.stopAll,
  latest: singleton.latest,
  artifact: singleton.artifact,
  references: singleton.references,
  setVerification: singleton.setVerification,
  markMerged: singleton.markMerged,
  ownershipConflicts,
  artifactId,
  SAFE_RUN_ID,
  SAFE_ROOM_ID,
  MAX_AGENTS,
};
