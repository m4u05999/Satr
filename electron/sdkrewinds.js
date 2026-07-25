/**
 * علامة جانبية دائمة تمنع إعادة استعمال checkpoint «سطر» سبق أن تجاوزه
 * native rewind في Claude SDK. لا تعدّل مخزن checkpoints نفسه.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'sdk-native-rewinds.json');
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CHECKPOINT = /^cp-[A-Za-z0-9-]{3,80}$/;
const MAX_ENTRIES = 200;

function createStore(options = {}) {
  const file = options.file || process.env.SATR_SDK_REWINDS_FILE || DEFAULT_FILE;
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
        if (!SAFE_UUID.test(sessionId) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        if (!SAFE_CHECKPOINT.test(String(value.checkpointId || ''))) continue;
        entries[sessionId.toLowerCase()] = {
          checkpointId: value.checkpointId,
          at: Number.isFinite(value.at) && value.at > 0 ? Math.floor(value.at) : 0,
        };
      }
    } catch {}
  }

  function persist(nextEntries) {
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(temp, JSON.stringify(nextEntries, null, 2), 'utf8');
      io.renameSync(temp, file);
      return true;
    } catch {
      try { io.unlinkSync(temp); } catch {}
      return false;
    }
  }

  function get(sessionId) {
    ensureLoaded();
    if (!SAFE_UUID.test(String(sessionId || ''))) return null;
    const entry = entries[String(sessionId).toLowerCase()];
    return entry ? { ...entry } : null;
  }

  function mark(sessionId, checkpointId) {
    ensureLoaded();
    if (!SAFE_UUID.test(String(sessionId || '')) || !SAFE_CHECKPOINT.test(String(checkpointId || ''))) {
      return { ok: false, error: 'bad_input' };
    }
    const key = String(sessionId).toLowerCase();
    const nextEntries = { ...entries };
    delete nextEntries[key];
    nextEntries[key] = { checkpointId, at: Date.now() };
    while (Object.keys(nextEntries).length > MAX_ENTRIES) delete nextEntries[Object.keys(nextEntries)[0]];
    if (!persist(nextEntries)) return { ok: false, error: 'write_failed' };
    entries = nextEntries;
    return { ok: true, entry: { ...entries[key] } };
  }

  function clear(sessionId) {
    ensureLoaded();
    if (!SAFE_UUID.test(String(sessionId || ''))) return { ok: false, error: 'bad_input' };
    const key = String(sessionId).toLowerCase();
    if (!(key in entries)) return { ok: true, removed: false };
    const nextEntries = { ...entries };
    delete nextEntries[key];
    if (!persist(nextEntries)) return { ok: false, error: 'write_failed', removed: false };
    entries = nextEntries;
    return { ok: true, removed: true };
  }

  return { get, mark, clear };
}

const store = createStore();

module.exports = {
  get: store.get,
  mark: store.mark,
  clear: store.clear,
  createStore,
  SAFE_UUID,
  SAFE_CHECKPOINT,
  MAX_ENTRIES,
};
