/**
 * ميتاداتا جانبية لجلسات المحادثة — لا تلمس مخازن Claude/Codex/المحوّلات الأصلية.
 * التخزين: ~/.satr/session-meta.json بكتابة ذرية أفضل جهد.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'session-meta.json');
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ENTRIES = 500;
const MAX_TITLE = 80;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  return value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

function safeSessionId(value) {
  return typeof value === 'string' && SAFE_SESSION.test(value);
}

function cleanEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = {};
  if (value.pinned === true) entry.pinned = true;
  const title = cleanTitle(value.title);
  if (title) entry.title = title;
  return Object.keys(entry).length ? entry : null;
}

function createStore(options = {}) {
  const file = options.file || process.env.SATR_SESSION_META_FILE || DEFAULT_FILE;
  const io = options.fs || fs;
  let loaded = false;
  let entries = {};

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    entries = {};
    try {
      const parsed = JSON.parse(io.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (Object.keys(entries).length >= MAX_ENTRIES) break;
        if (!safeSessionId(sessionId)) continue;
        const entry = cleanEntry(value);
        if (entry) entries[sessionId] = entry;
      }
    } catch (error) {}
  }

  function persist() {
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf8');
      io.renameSync(temp, file);
      return true;
    } catch (error) {
      try { io.unlinkSync(temp); } catch (cleanupError) {}
      return false;
    }
  }

  function list() {
    ensureLoaded();
    return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { ...entry }]));
  }

  function get(sessionId) {
    ensureLoaded();
    if (!safeSessionId(sessionId) || !entries[sessionId]) return null;
    return { ...entries[sessionId] };
  }

  function set(sessionId, patch) {
    ensureLoaded();
    if (!safeSessionId(sessionId) || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'bad_input' };
    }
    const allowed = new Set(['pinned', 'title']);
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((key) => !allowed.has(key))) return { ok: false, error: 'bad_input' };
    if ('pinned' in patch && typeof patch.pinned !== 'boolean') return { ok: false, error: 'bad_input' };
    if ('title' in patch && typeof patch.title !== 'string') return { ok: false, error: 'bad_input' };
    if (!entries[sessionId] && Object.keys(entries).length >= MAX_ENTRIES) return { ok: false, error: 'limit' };

    const before = entries[sessionId] ? { ...entries[sessionId] } : null;
    const next = { ...(before || {}) };
    if ('pinned' in patch) {
      if (patch.pinned) next.pinned = true;
      else delete next.pinned;
    }
    if ('title' in patch) {
      const title = cleanTitle(patch.title);
      if (title) next.title = title;
      else delete next.title;
    }
    if (Object.keys(next).length) entries[sessionId] = next;
    else delete entries[sessionId];
    if (!persist()) {
      if (before) entries[sessionId] = before;
      else delete entries[sessionId];
      return { ok: false, error: 'write_failed' };
    }
    return { ok: true, entry: entries[sessionId] ? { ...entries[sessionId] } : null };
  }

  function remove(sessionId) {
    ensureLoaded();
    if (!safeSessionId(sessionId)) return { ok: false, error: 'bad_input' };
    if (!(sessionId in entries)) return { ok: true, removed: false };
    const before = { ...entries[sessionId] };
    delete entries[sessionId];
    if (!persist()) { entries[sessionId] = before; return { ok: false, error: 'write_failed' }; }
    return { ok: true, removed: true };
  }

  return { list, get, set, remove };
}

const store = createStore();

module.exports = {
  list: store.list,
  get: store.get,
  set: store.set,
  remove: store.remove,
  createStore,
  cleanTitle,
  safeSessionId,
  MAX_ENTRIES,
  MAX_TITLE,
};
