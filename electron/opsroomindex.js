/**
 * فهرس غرف العمليات حسب المشروع. لا يحفظ مهاماً أو patch أو مسارات مطلقة؛
 * مفتاح المشروع بصمة داخلية لا تُعاد إلى الواجهة.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const opsroom = require('./opsroom');

const SCHEMA_VERSION = 1;
const FILE = path.join(os.homedir(), '.satr', 'opsroom', 'index.json');
const MAX_ENTRIES = 300;
const SAFE_STATE = new Set(['preparing', 'running', 'stopping', 'interrupted', 'completed', 'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed']);

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function projectKey(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '';
  const resolved = path.resolve(cwd);
  const stable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function fileFor(options) {
  return options && options.file ? path.resolve(options.file) : FILE;
}

function sanitizeEntry(value) {
  if (!value || typeof value !== 'object'
    || !opsroom.SAFE_ROOM_ID.test(value.room_id || '')
    || !opsroom.SAFE_TEAM_ID.test(value.team_id || '')
    || !/^[0-9a-f]{64}$/.test(value.project_key || '')
    || !SAFE_STATE.has(value.state)
    || !Number.isFinite(value.updated_at) || value.updated_at < 0) return null;
  const artifactId = cleanText(value.artifact_id, 64);
  if (artifactId && !opsroom.SAFE_ARTIFACT_ID.test(artifactId)) return null;
  return {
    room_id: value.room_id,
    team_id: value.team_id,
    project_key: value.project_key,
    project_name: cleanText(value.project_name, 120) || 'مشروع',
    state: value.state,
    updated_at: value.updated_at,
    ...(artifactId ? { artifact_id: artifactId } : {}),
    restorable: value.restorable === true,
    merged: value.merged === true,
  };
}

function read(options) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(options), 'utf8'));
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION || !Array.isArray(parsed.entries)
      || parsed.entries.length > MAX_ENTRIES) return [];
    const entries = parsed.entries.map(sanitizeEntry);
    return entries.some((entry) => !entry) ? [] : entries;
  } catch { return []; }
}

function write(entries, options) {
  const file = fileFor(options);
  let temp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, JSON.stringify({ schema_version: SCHEMA_VERSION, entries }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    return { ok: true };
  } catch {
    if (temp) try { fs.unlinkSync(temp); } catch {}
    return { ok: false, error: 'persistence_failed' };
  }
}

function upsert(cwd, value, options) {
  const key = projectKey(cwd);
  const raw = value && typeof value === 'object' ? value : {};
  const entry = sanitizeEntry({
    ...raw,
    project_key: key,
    project_name: cleanText(path.basename(path.resolve(cwd || '.')), 120),
    updated_at: Number(raw.updated_at) || Date.now(),
  });
  if (!key || !entry) return { ok: false, error: 'bad_input' };
  const entries = read(options).filter((item) => item.room_id !== entry.room_id);
  entries.push(entry);
  entries.sort((left, right) => right.updated_at - left.updated_at);
  const bounded = entries.slice(0, MAX_ENTRIES);
  const result = write(bounded, options);
  return result.ok ? { ok: true, entry: { ...entry } } : result;
}

function list(cwd, options) {
  const key = projectKey(cwd);
  if (!key) return [];
  return read(options).filter((entry) => entry.project_key === key).map((entry) => ({
    room_id: entry.room_id,
    team_id: entry.team_id,
    project_name: entry.project_name,
    state: entry.state,
    updated_at: entry.updated_at,
    artifact_id: entry.artifact_id || '',
    restorable: entry.restorable,
    merged: entry.merged,
  }));
}

function find(cwd, roomId, options) {
  return list(cwd, options).find((entry) => entry.room_id === roomId) || null;
}

function interruptStale(options) {
  const entries = read(options);
  let changed = false;
  const updated = entries.map((entry) => {
    if (!['preparing', 'running', 'stopping'].includes(entry.state)) return entry;
    changed = true;
    return { ...entry, state: 'interrupted', updated_at: Date.now(), restorable: false };
  });
  if (!changed) return { ok: true, changed: false };
  updated.sort((left, right) => right.updated_at - left.updated_at);
  const result = write(updated, options);
  return result.ok ? { ok: true, changed: true } : result;
}

function markArtifactsUnavailable(artifacts, options) {
  const keys = new Set((Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) => {
    if (!artifact || typeof artifact !== 'object'
      || !/^[0-9a-f]{64}$/.test(artifact.artifact_id || '')
      || !/^[0-9a-f]{64}$/.test(artifact.project_key || '')) return [];
    return [artifact.project_key + ':' + artifact.artifact_id];
  }));
  if (!keys.size) return { ok: true, changed: false };
  const entries = read(options);
  let changed = false;
  const updated = entries.map((entry) => {
    if (!entry.artifact_id || !keys.has(entry.project_key + ':' + entry.artifact_id) || !entry.restorable) return entry;
    changed = true; return { ...entry, restorable: false, updated_at: Date.now() };
  });
  if (!changed) return { ok: true, changed: false };
  updated.sort((left, right) => right.updated_at - left.updated_at);
  const result = write(updated, options);
  return result.ok ? { ok: true, changed: true } : result;
}

module.exports = {
  SCHEMA_VERSION, FILE, MAX_ENTRIES, projectKey, upsert, list, find, interruptStale, markArtifactsUnavailable,
};
