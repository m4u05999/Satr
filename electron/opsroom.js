/**
 * سجل غرفة العمليات الدائم: timeline محدود وappend-only بلا أي قدرة تنفيذية.
 *
 * الشكل على القرص: ~/.satr/opsroom/<room_id>.json. لا يحفظ patch أو خرج أوامر،
 * وتُفصل سلطة المحرك والمستخدم والنظام بدوال مستقلة تفشل مغلقاً عند الانتحال.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./memory');

const SCHEMA_VERSION = 1;
const ROOT = path.join(os.homedir(), '.satr', 'opsroom');
const SAFE_ROOM_ID = /^ops-room-[a-z0-9-]{6,80}$/;
const SAFE_ENTRY_ID = /^ops-entry-[a-z0-9-]{6,80}$/;
const SAFE_TEAM_ID = /^execution-team-[a-z0-9-]{6,80}$/;
const SAFE_ARTIFACT_ID = /^[0-9a-f]{64}$/;
const ENTRY_TYPES = new Set(['proposal', 'decision', 'phase_gate', 'review', 'verification', 'note']);
const ACTORS = new Set(['user', 'sdk', 'codex', 'system']);
const ENGINE_TYPES = new Set(['proposal', 'note']);
const SYSTEM_TYPES = new Set(['phase_gate', 'review', 'verification', 'note']);
const MAX_ENTRIES = 200;
const MAX_TEXT = 1000;
const MAX_INPUT_TEXT = 64 * 1024;
const MAX_FILE = 512 * 1024;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function containsPatch(value) {
  const text = String(value || '');
  return /(?:^|\n)\s*(?:diff --git |```diff\b|@@\s+-\d|---\s+a\/|\+\+\+\s+b\/)/i.test(text);
}

function rootFor(options) {
  return options && options.root ? path.resolve(options.root) : ROOT;
}

function fileFor(roomId, options) {
  if (!SAFE_ROOM_ID.test(roomId || '')) return null;
  return path.join(rootFor(options), roomId + '.json');
}

function publicRoom(room) {
  return {
    schema_version: SCHEMA_VERSION,
    room_id: room.room_id,
    entries: room.entries.map((entry) => ({ ...entry })),
  };
}

function validAuthority(type, actor) {
  if (!ENTRY_TYPES.has(type) || !ACTORS.has(actor)) return false;
  if (actor === 'user') return type === 'decision';
  if (actor === 'sdk' || actor === 'codex') return ENGINE_TYPES.has(type);
  return actor === 'system' && SYSTEM_TYPES.has(type);
}

function sanitizeReference(value, pattern) {
  if (value == null || value === '') return { ok: true, value: '' };
  const cleaned = cleanText(value, 128);
  return pattern.test(cleaned) ? { ok: true, value: cleaned } : { ok: false, value: '' };
}

function sanitizeText(value) {
  if (typeof value !== 'string') return { ok: false, error: 'bad_input' };
  if (value.length > MAX_INPUT_TEXT) return { ok: false, error: 'text_too_large' };
  if (memory.hasSecret(value)) return { ok: false, error: 'secret_detected' };
  if (containsPatch(value)) return { ok: false, error: 'patch_forbidden' };
  const text = cleanText(value, MAX_TEXT);
  return text ? { ok: true, text } : { ok: false, error: 'empty_text' };
}

function sanitizeStoredEntry(value) {
  if (!value || typeof value !== 'object' || !SAFE_ENTRY_ID.test(value.id || '')
    || !validAuthority(value.type, value.actor)) return null;
  const text = sanitizeText(value.text);
  const team = sanitizeReference(value.team_id, SAFE_TEAM_ID);
  const artifact = sanitizeReference(value.artifact_id, SAFE_ARTIFACT_ID);
  if (!text.ok || !team.ok || !artifact.ok || !Number.isFinite(value.created_at) || value.created_at < 0) return null;
  return {
    id: value.id,
    type: value.type,
    actor: value.actor,
    text: text.text,
    ...(team.value ? { team_id: team.value } : {}),
    ...(artifact.value ? { artifact_id: artifact.value } : {}),
    created_at: value.created_at,
  };
}

function readRoom(roomId, options) {
  const file = fileFor(roomId, options);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION || parsed.room_id !== roomId
      || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) return null;
    const entries = parsed.entries.map(sanitizeStoredEntry);
    if (entries.some((entry) => !entry)) return null;
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return null;
    return { schema_version: SCHEMA_VERSION, room_id: roomId, entries };
  } catch {
    return null;
  }
}

function writeRoom(room, options) {
  const file = fileFor(room.room_id, options);
  if (!file) return { ok: false, error: 'bad_input' };
  let temp = '';
  try {
    const serialized = JSON.stringify(room);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE) return { ok: false, error: 'file_limit' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, serialized, 'utf8');
    fs.renameSync(temp, file);
    return { ok: true };
  } catch {
    if (temp) try { fs.unlinkSync(temp); } catch {}
    return { ok: false, error: 'persistence_failed' };
  }
}

function randomId(prefix) {
  return prefix + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

function createRoom(options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const roomId = randomId('ops-room-');
    if (fs.existsSync(fileFor(roomId, options))) continue;
    const room = { schema_version: SCHEMA_VERSION, room_id: roomId, entries: [] };
    const written = writeRoom(room, options);
    if (written.ok) return { ok: true, room: publicRoom(room) };
    if (written.error !== 'persistence_failed') return written;
  }
  return { ok: false, error: 'persistence_failed' };
}

function load(roomId, options) {
  const room = readRoom(roomId, options);
  return room ? publicRoom(room) : null;
}

function append(roomId, type, actor, value, options) {
  const room = readRoom(roomId, options);
  if (!room) return { ok: false, error: 'not_found' };
  if (!validAuthority(type, actor)) return { ok: false, error: 'authority_denied' };
  if (room.entries.length >= MAX_ENTRIES) return { ok: false, error: 'entry_limit' };
  const raw = value && typeof value === 'object' ? value : {};
  if (raw.id != null || raw.type != null && raw.type !== type || raw.actor != null && raw.actor !== actor) {
    return { ok: false, error: 'authority_denied' };
  }
  const text = sanitizeText(raw.text);
  const team = sanitizeReference(raw.team_id, SAFE_TEAM_ID);
  const artifact = sanitizeReference(raw.artifact_id, SAFE_ARTIFACT_ID);
  if (!text.ok) return text;
  if (!team.ok || !artifact.ok) return { ok: false, error: 'bad_input' };
  const entry = {
    id: randomId('ops-entry-'),
    type,
    actor,
    text: text.text,
    ...(team.value ? { team_id: team.value } : {}),
    ...(artifact.value ? { artifact_id: artifact.value } : {}),
    created_at: Date.now(),
  };
  const next = { ...room, entries: room.entries.concat(entry) };
  const written = writeRoom(next, options);
  return written.ok ? { ok: true, entry: { ...entry }, room: publicRoom(next) } : written;
}

function appendEngine(roomId, engine, value, options) {
  const raw = value && typeof value === 'object' ? value : {};
  if (engine !== 'sdk' && engine !== 'codex') return { ok: false, error: 'authority_denied' };
  if (!ENGINE_TYPES.has(raw.type) || raw.actor != null && raw.actor !== engine) {
    return { ok: false, error: 'authority_denied' };
  }
  return append(roomId, raw.type, engine, raw, options);
}

function appendUserDecision(roomId, value, confirmed, options) {
  const raw = value && typeof value === 'object' ? value : {};
  if (confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (raw.type != null && raw.type !== 'decision' || raw.actor != null && raw.actor !== 'user') {
    return { ok: false, error: 'authority_denied' };
  }
  return append(roomId, 'decision', 'user', raw, options);
}

function appendSystem(roomId, type, value, options) {
  const raw = value && typeof value === 'object' ? value : {};
  if (!SYSTEM_TYPES.has(type) || raw.type != null && raw.type !== type
    || raw.actor != null && raw.actor !== 'system') return { ok: false, error: 'authority_denied' };
  return append(roomId, type, 'system', raw, options);
}

module.exports = {
  SCHEMA_VERSION,
  SAFE_ROOM_ID,
  SAFE_ENTRY_ID,
  SAFE_TEAM_ID,
  SAFE_ARTIFACT_ID,
  MAX_ENTRIES,
  MAX_TEXT,
  MAX_INPUT_TEXT,
  MAX_FILE,
  createRoom,
  load,
  appendEngine,
  appendUserDecision,
  appendSystem,
  fileFor,
};
