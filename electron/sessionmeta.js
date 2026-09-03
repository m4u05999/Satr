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
// حصّة وسوم الأدوات داخل السقف العام: جلسات الأدوات تُولَد بالعشرات في كل دورة غرفة
// عمليات، فلا يجوز أن تقضم سعة تثبيت المستخدم وتسميته. الوسوم نافذة متدحرجة، وقرارات
// المستخدم لا تُمَسّ؛ وعند امتلاء السقف يخلي `set` أقدم وسم خالص قبل القرار الجديد.
const MAX_TOOL_ENTRIES = 200;
const MAX_TITLE = 80;
// أنواع الجلسة — قائمة مغلقة قابلة للتوسّع. `tool`: جلسة أداة لا محادثة مستخدم
// (عوامل غرفة العمليات والمراجعون والباحثون) — تُوسَم وقت إنشائها لا تُخمَّن (‏OBS-068).
const KINDS = Object.freeze(['tool']);
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  return value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

function cleanKind(value) {
  return typeof value === 'string' && KINDS.includes(value) ? value : null;
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
  const kind = cleanKind(value.kind);
  if (kind) entry.kind = kind;
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
    const before = entries[sessionId] ? { ...entries[sessionId] } : null;
    const evicted = [];
    if (!before && Object.keys(entries).length >= MAX_ENTRIES) {
      // قرار المستخدم أولى بالسعة من أثر الأداة: يُخلى أقدم وسم خالص فقط، بترتيب
      // الإدراج نفسه في `setKind`. التثبيت والعنوان يحصّنان المدخل ولو حمل وسم أداة.
      const toolOnly = Object.keys(entries).filter((id) => {
        const entry = entries[id];
        return entry.kind && entry.pinned !== true && !entry.title;
      });
      let overflow = Object.keys(entries).length - (MAX_ENTRIES - 1);
      for (let index = 0; index < toolOnly.length && overflow > 0; index++, overflow--) {
        evicted.push([toolOnly[index], entries[toolOnly[index]]]);
        delete entries[toolOnly[index]];
      }
      if (Object.keys(entries).length >= MAX_ENTRIES) {
        for (const [id, entry] of evicted) entries[id] = entry;
        return { ok: false, error: 'limit' };
      }
    }
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
      for (const [id, entry] of evicted) entries[id] = entry;
      return { ok: false, error: 'write_failed' };
    }
    return { ok: true, entry: entries[sessionId] ? { ...entries[sessionId] } : null };
  }

  /**
   * وسم جلسة أداة وقت إنشائها (‏OBS-068 ب) — أفضل جهد، ولا يمرّ من renderer إطلاقاً:
   * `set` تبقى قائمة سماحها `pinned/title` وحدهما، فلا تستطيع الواجهة إخفاء جلسة
   * مستخدم بادّعاء أنها أداة. الوسم يجاور التثبيت/التسمية ولا يمحوهما.
   */
  function setKind(sessionId, kind) {
    ensureLoaded();
    const clean = cleanKind(kind);
    if (!safeSessionId(sessionId) || !clean) return { ok: false, error: 'bad_input' };
    // الوسم نفسه مرّة واحدة: أحداث `system` تتكرر مع الاستئناف، ولا كتابة قرص بلا تغيير.
    if (entries[sessionId] && entries[sessionId].kind === clean) {
      return { ok: true, entry: { ...entries[sessionId] } };
    }
    const before = entries[sessionId] ? { ...entries[sessionId] } : null;
    const evicted = [];
    if (!before) {
      // إخلاء نافذة الوسوم: يُطرد الأقدم من **الوسوم الخالصة** فقط (بلا تثبيت ولا عنوان)
      // بترتيب الإدراج، فتبقى قرارات المستخدم الصريحة خارج الإخلاء.
      const toolOnly = Object.keys(entries).filter((id) => {
        const entry = entries[id];
        return entry.kind && entry.pinned !== true && !entry.title;
      });
      let overflow = toolOnly.length - (MAX_TOOL_ENTRIES - 1);
      for (let index = 0; index < toolOnly.length && overflow > 0; index++, overflow--) {
        evicted.push([toolOnly[index], entries[toolOnly[index]]]);
        delete entries[toolOnly[index]];
      }
      if (Object.keys(entries).length >= MAX_ENTRIES) {
        for (const [id, entry] of evicted) entries[id] = entry;
        return { ok: false, error: 'limit' };
      }
    }
    entries[sessionId] = { ...(before || {}), kind: clean };
    if (!persist()) {
      if (before) entries[sessionId] = before;
      else delete entries[sessionId];
      for (const [id, entry] of evicted) entries[id] = entry;
      return { ok: false, error: 'write_failed' };
    }
    return { ok: true, entry: { ...entries[sessionId] } };
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

  return { list, get, set, setKind, remove };
}

const store = createStore();

module.exports = {
  list: store.list,
  get: store.get,
  set: store.set,
  setKind: store.setKind,
  remove: store.remove,
  createStore,
  cleanTitle,
  cleanKind,
  safeSessionId,
  KINDS,
  MAX_ENTRIES,
  MAX_TOOL_ENTRIES,
  MAX_TITLE,
};
