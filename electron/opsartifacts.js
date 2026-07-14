/**
 * خزنة آثار غرفة العمليات. المحتوى مشفّر بالكامل ولا يعود إلى renderer؛
 * غياب safeStorage يفشل مغلقاً ولا يسقط إلى patch صريح على القرص.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const executor = require('./executor');
const memory = require('./memory');
const opsroom = require('./opsroom');

const SCHEMA_VERSION = 1;
const ROOT = path.join(os.homedir(), '.satr', 'opsroom', 'artifacts');
const MAX_PATCH_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 18 * 1024 * 1024;
const MAX_ARTIFACTS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_HEAD = /^[0-9a-f]{40,64}$/;
const SAFE_ENGINE = new Set(['sdk', 'codex']);

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function defaultCodec() {
  try {
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) return null;
    return {
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buffer) => safeStorage.decryptString(buffer),
    };
  } catch { return null; }
}

function codecFor(options) {
  const codec = options && options.codec ? options.codec : defaultCodec();
  return codec && typeof codec.encrypt === 'function' && typeof codec.decrypt === 'function' ? codec : null;
}

function rootFor(options) {
  return options && options.root ? path.resolve(options.root) : ROOT;
}

function projectScope(projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return '';
  const resolved = path.resolve(projectRoot);
  const stable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function fileFor(artifactId, options) {
  if (!opsroom.SAFE_ARTIFACT_ID.test(artifactId || '')) return null;
  const scope = projectScope(options && options.projectRoot);
  if (!scope) return null;
  return path.join(rootFor(options), scope, artifactId + '.bin');
}

function sanitizeFile(file) {
  const rel = cleanText(file && file.rel, 512).replace(/\\/g, '/');
  if (/[?*]/.test(rel) || !executor.normalizeOwnership([rel])) return null;
  return {
    rel,
    kind: cleanText(file && file.kind, 20),
    added: Math.max(0, Number(file && file.added) || 0),
    removed: Math.max(0, Number(file && file.removed) || 0),
    agent: cleanText(file && file.agent, 80),
    agent_id: cleanText(file && file.agent_id, 80),
    engine: cleanText(file && file.engine, 32),
  };
}

function sanitizeAgent(agent) {
  const ownership = executor.normalizeOwnership(agent && agent.ownership);
  const task = cleanText(agent && agent.task, 4000);
  if (!ownership || !task) return null;
  const changes = agent && agent.changes && Array.isArray(agent.changes.files)
    ? agent.changes.files.map(sanitizeFile) : [];
  if (changes.some((file) => !file)) return null;
  return {
    id: cleanText(agent.id, 80), label: cleanText(agent.label, 80), task,
    engine: cleanText(agent.engine, 32), ownership, state: 'completed',
    summary: cleanText(agent.summary, 12000), error: '', failure_code: '',
    duration_ms: Math.max(0, Number(agent.duration_ms) || 0),
    cost: { ...(agent.cost || {}) }, permissions: { ...(agent.permissions || {}) },
    edits_seen: Math.max(0, Number(agent.edits_seen) || 0),
    changes: { files: changes, more: 0, partial: false,
      added: changes.reduce((sum, file) => sum + file.added, 0),
      removed: changes.reduce((sum, file) => sum + file.removed, 0) },
    worktree: null, last_tool: cleanText(agent.last_tool, 32), last_file: cleanText(agent.last_file, 512),
    last_activity_at: Math.max(0, Number(agent.last_activity_at) || 0),
    timeout_ms: Math.max(0, Number(agent.timeout_ms) || 0), deadline_at: Math.max(0, Number(agent.deadline_at) || 0),
    artifact_ready: true, patch_bytes: Math.max(0, Number(agent.patch_bytes) || 0), merged: false, merge_supported: false,
  };
}

function sanitizeBundle(artifact, team) {
  if (!artifact || !team || team.state !== 'completed'
    || !opsroom.SAFE_ARTIFACT_ID.test(artifact.artifact_id || '')
    || !opsroom.SAFE_ROOM_ID.test(artifact.room_id || '')
    || !opsroom.SAFE_TEAM_ID.test(artifact.team_id || '')
    || artifact.team_id !== team.id || artifact.room_id !== team.room_id
    || !SAFE_HEAD.test(artifact.head || '') || typeof artifact.patch !== 'string') return null;
  if (Buffer.byteLength(artifact.patch, 'utf8') > MAX_PATCH_BYTES) return null;
  if (memory.hasSecret(artifact.patch)) return null;
  const identity = crypto.createHash('sha256').update(artifact.head + '\0' + artifact.patch).digest('hex');
  if (identity !== artifact.artifact_id) return null;
  const rawSourceRoot = artifact.sourceRoot || artifact.source_root;
  const rawCwd = artifact.cwd;
  if (typeof rawSourceRoot !== 'string' || !path.isAbsolute(rawSourceRoot)
    || typeof rawCwd !== 'string' || !path.isAbsolute(rawCwd)) return null;
  const sourceRoot = path.resolve(rawSourceRoot);
  const cwd = path.resolve(rawCwd);
  if (sourceRoot !== cwd) return null;
  const engines = Array.isArray(artifact.producer_engines) ? [...new Set(artifact.producer_engines)] : [];
  if (!engines.length || engines.some((engine) => !SAFE_ENGINE.has(engine))) return null;
  const ownership = Array.isArray(artifact.ownership) ? artifact.ownership.map(executor.normalizeOwnership) : [];
  if (!ownership.length || ownership.some((item) => !item)) return null;
  const files = Array.isArray(artifact.files) ? artifact.files.map(sanitizeFile) : [];
  const agents = Array.isArray(team.agents) ? team.agents.map(sanitizeAgent) : [];
  if (files.some((file) => !file) || !agents.length || agents.some((agent) => !agent)) return null;
  return {
    schema_version: SCHEMA_VERSION,
    saved_at: Date.now(),
    artifact: {
      schema_version: 1, artifact_id: artifact.artifact_id, room_id: artifact.room_id,
      team_id: artifact.team_id, teamId: artifact.team_id, cwd, source_root: sourceRoot,
      sourceRoot, head: artifact.head, patch: artifact.patch, bytes: Buffer.byteLength(artifact.patch, 'utf8'),
      producer_engines: engines, ownership, files,
    },
    team: {
      id: team.id, room_id: team.room_id, state: 'completed',
      created_at: Math.max(0, Number(team.created_at) || 0), updated_at: Math.max(0, Number(team.updated_at) || 0),
      duration_ms: Math.max(0, Number(team.duration_ms) || 0), conflicts: [], agents,
      artifact_id: artifact.artifact_id, producer_engines: engines, mode: 'mergeable',
      timeout_ms: Math.max(0, Number(team.timeout_ms) || executor.DEFAULT_TIMEOUT_MS),
      verification: null, merged: false, merge_supported: true,
    },
  };
}

function save(artifact, team, options) {
  const bundle = sanitizeBundle(artifact, team);
  const codec = codecFor(options);
  if (!bundle) return { ok: false, error: 'bad_input' };
  if (!codec) return { ok: false, error: 'encryption_unavailable' };
  const file = fileFor(bundle.artifact.artifact_id, { ...options, projectRoot: bundle.artifact.sourceRoot });
  let temp = '';
  try {
    const encrypted = Buffer.from(codec.encrypt(JSON.stringify(bundle)));
    if (!encrypted.length || encrypted.length > MAX_FILE_BYTES) return { ok: false, error: 'file_limit' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, encrypted, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { ok: true, artifact_id: bundle.artifact.artifact_id };
  } catch {
    if (temp) try { fs.unlinkSync(temp); } catch {}
    return { ok: false, error: 'persistence_failed' };
  }
}

function load(artifactId, options) {
  const codec = codecFor(options);
  const file = fileFor(artifactId, options);
  if (!file) return { ok: false, error: 'bad_input' };
  if (!codec) return { ok: false, error: 'encryption_unavailable' };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { ok: false, error: 'file_limit' };
    const parsed = JSON.parse(codec.decrypt(fs.readFileSync(file)));
    const bundle = sanitizeBundle(parsed && parsed.artifact, parsed && parsed.team);
    if (!bundle || bundle.artifact.artifact_id !== artifactId) return { ok: false, error: 'artifact_invalid' };
    return { ok: true, artifact: bundle.artifact, team: bundle.team };
  } catch { return { ok: false, error: 'artifact_unavailable' }; }
}

function remove(artifactId, options) {
  const file = fileFor(artifactId, options);
  if (!file) return { ok: false, error: 'bad_input' };
  try { fs.unlinkSync(file); return { ok: true }; }
  catch (error) { return error && error.code === 'ENOENT' ? { ok: true } : { ok: false, error: 'remove_failed' }; }
}

function prune(options) {
  const root = rootFor(options);
  try {
    const now = Date.now();
    const files = [];
    for (const scope of fs.readdirSync(root, { withFileTypes: true })) {
      if (!scope.isDirectory() || !/^[0-9a-f]{64}$/.test(scope.name)) continue;
      const directory = path.join(root, scope.name);
      for (const name of fs.readdirSync(directory)) {
        if (!/^[0-9a-f]{64}\.bin$/.test(name)) continue;
        const file = path.join(directory, name); const stat = fs.statSync(file);
        files.push({ file, artifact_id: name.slice(0, 64), project_key: scope.name, mtime: stat.mtimeMs });
      }
    }
    files.sort((left, right) => right.mtime - left.mtime);
    const removed = [];
    for (let index = 0; index < files.length; index++) {
      if (index < MAX_ARTIFACTS && now - files[index].mtime <= MAX_AGE_MS) continue;
      try {
        fs.unlinkSync(files[index].file);
        removed.push({ artifact_id: files[index].artifact_id, project_key: files[index].project_key });
        try { fs.rmdirSync(path.dirname(files[index].file)); } catch {}
      } catch {}
    }
    return { ok: true, removed };
  } catch (error) {
    return error && error.code === 'ENOENT' ? { ok: true, removed: [] } : { ok: false, error: 'prune_failed', removed: [] };
  }
}

module.exports = {
  SCHEMA_VERSION, ROOT, MAX_PATCH_BYTES, MAX_FILE_BYTES, MAX_ARTIFACTS, MAX_AGE_MS,
  projectScope, fileFor, save, load, remove, prune,
};
