/**
 * سجل نشاط Community المحلي المختصر.
 *
 * يحفظ metadata تشغيلية محدودة فقط: بدء دور، أسماء الأدوات، المسارات النسبية المعدلة،
 * قرارات الأذونات، ونتيجة الدور. لا يحفظ prompt أو مدخل أداة أو خرجاً خاماً أو cwd مطلقاً
 * أو session/permission ids. التخزين محلي محدود، والواجهة لا ترى إلا مشروعها الحالي.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.satr', 'activity.json');
const VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const SAFE_PROJECT = /^[a-f0-9]{64}$/;
const SAFE_KINDS = new Set(['prompt', 'tool', 'file_edit', 'permission', 'result']);

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function cleanEngine(value) {
  const engine = cleanText(value, 32).toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(engine) ? engine : 'sdk';
}

function cleanRelative(value) {
  const rel = cleanText(value, 300).replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return '';
  if (rel.split('/').some((part) => part === '..')) return '';
  return rel;
}

function boundedInt(value, max = 1000000) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(max, Math.floor(number)) : 0;
}

function projectId(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  let resolved;
  try { resolved = path.resolve(cwd.trim()); } catch { return null; }
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return crypto.createHash('sha256').update(resolved).digest('hex');
}

function sanitizeStoredEntry(value) {
  const raw = value && typeof value === 'object' ? value : {};
  if (!SAFE_PROJECT.test(raw.project_id || '') || !SAFE_KINDS.has(raw.kind)) return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const entry = {
    ts: Math.floor(ts),
    project_id: raw.project_id,
    kind: raw.kind,
    engine: cleanEngine(raw.engine),
  };
  const tool = cleanText(raw.tool, 120);
  const rel = cleanRelative(raw.rel);
  if (tool) entry.tool = tool;
  if (rel) entry.rel = rel;
  if (raw.kind === 'file_edit') {
    entry.added = boundedInt(raw.added);
    entry.removed = boundedInt(raw.removed);
  }
  if (raw.kind === 'permission') entry.allow = raw.allow === true;
  if (raw.kind === 'result') {
    entry.is_error = raw.is_error === true;
    entry.duration_ms = boundedInt(raw.duration_ms, 24 * 60 * 60 * 1000);
  }
  return entry;
}

function readEntries(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.map(sanitizeStoredEntry).filter(Boolean).slice(-MAX_ENTRIES);
  } catch { return []; }
}

function createStore(options = {}) {
  const file = options.file || FILE;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let entries = readEntries(file);
  const activeProjects = new Map();
  const pendingPermissions = new Map();

  function persist() {
    let temp = '';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      temp = file + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(temp, JSON.stringify({ version: VERSION, entries }), 'utf8');
      fs.renameSync(temp, file);
      return true;
    } catch {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      return false;
    }
  }

  function append(raw) {
    const entry = sanitizeStoredEntry(raw);
    if (!entry) return false;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    return persist();
  }

  function activeProject(engine) {
    return activeProjects.get(engine) || null;
  }

  function onEvent(event, meta = {}) {
    if (!event || typeof event !== 'object') return;
    const engine = cleanEngine(event.engine || meta.engine);

    if (event.type === 'prompt') {
      const id = projectId(event.cwd);
      if (!id) return;
      activeProjects.set(engine, id);
      for (const [permissionId, pending] of pendingPermissions) {
        if (pending.engine === engine) pendingPermissions.delete(permissionId);
      }
      append({ ts: now(), project_id: id, kind: 'prompt', engine });
      return;
    }

    const currentProject = activeProject(engine);
    if (event.type === 'permission_request') {
      if (!currentProject || typeof event.id !== 'string') return;
      if (pendingPermissions.size >= 64) pendingPermissions.delete(pendingPermissions.keys().next().value);
      pendingPermissions.set(event.id, {
        project_id: currentProject,
        engine,
        tool: cleanText(event.tool, 120),
      });
      return;
    }
    if (event.type === 'permission_reply') {
      const pending = pendingPermissions.get(event.id);
      if (pending) pendingPermissions.delete(event.id);
      const project = pending ? pending.project_id : currentProject;
      if (!project) return;
      append({
        ts: now(), project_id: project, kind: 'permission',
        engine: pending ? pending.engine : engine,
        tool: pending ? pending.tool : '', allow: event.allow === true,
      });
      return;
    }
    if (!currentProject) return;

    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const content of event.message.content) {
        if (content && content.type === 'tool_use') {
          append({
            ts: now(), project_id: currentProject, kind: 'tool', engine,
            tool: cleanText(content.name, 120),
          });
        }
      }
    } else if (event.type === 'file_edit') {
      append({
        ts: now(), project_id: currentProject, kind: 'file_edit', engine,
        tool: cleanText(event.tool, 120), rel: cleanRelative(event.rel),
        added: boundedInt(event.added), removed: boundedInt(event.removed),
      });
    } else if (event.type === 'result') {
      append({
        ts: now(), project_id: currentProject, kind: 'result', engine,
        is_error: event.is_error === true,
        duration_ms: boundedInt(event.duration_ms, 24 * 60 * 60 * 1000),
      });
    }
  }

  function list(cwd, limit = 20) {
    const id = projectId(cwd);
    if (!id) return { ok: false, error: 'bad_cwd', entries: [], count: 0 };
    const projectEntries = entries.filter((entry) => entry.project_id === id);
    const safeLimit = Math.max(1, Math.min(50, boundedInt(limit, 50) || 20));
    const publicEntries = projectEntries.slice(-safeLimit).reverse().map((entry) => {
      const { project_id: _projectId, ...publicEntry } = entry;
      return publicEntry;
    });
    return { ok: true, entries: publicEntries, count: projectEntries.length };
  }

  function clear(cwd) {
    const id = projectId(cwd);
    if (!id) return { ok: false, error: 'bad_cwd' };
    const previous = entries;
    const before = entries.length;
    entries = entries.filter((entry) => entry.project_id !== id);
    if (!persist()) {
      entries = previous;
      return { ok: false, error: 'write_failed' };
    }
    return { ok: true, removed: before - entries.length };
  }

  return { onEvent, list, clear };
}

const store = createStore();

module.exports = {
  onEvent: store.onEvent,
  list: store.list,
  clear: store.clear,
  createStore,
  projectId,
  FILE,
  MAX_ENTRIES,
};
