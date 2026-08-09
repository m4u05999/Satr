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
// البند 30: نوعا التشغيل الظاهران في قائمة التاريخ (فريق يدوي أو حلقة محدودة).
const SAFE_RUN_KIND = new Set(['team', 'loop']);
const MAX_TASK_EXCERPT = 80;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

// البند 30: مقتطف مهمة للقراءة البشرية. تنقية بمُسنِد نقاط Unicode لا بتعبير نمطي
// فيه محارف تحكم حرفية (درس loopfailure.js/verify.js: الحرفي يُتلف الملف عند تحريره)،
// والقصّ بنقاط Unicode لا بوحدات UTF-16 كي لا يُكسر زوج بديل عند الحد.
function isUnsafeExcerptPoint(code) {
  if (code <= 0x1f) return true; // C0 (تشمل الصفر والسطر الجديد والإرجاع والجدولة)
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true; // ALM/LRM/RLM
  if (code >= 0x202a && code <= 0x202e) return true; // LRE/RLE/PDF/LRO/RLO
  if (code >= 0x2066 && code <= 0x2069) return true; // LRI/RLI/FSI/PDI
  return false;
}

function excerptText(value, maxPoints) {
  if (typeof value !== 'string') return '';
  let cleaned = '';
  for (const char of value) {
    if (!isUnsafeExcerptPoint(char.codePointAt(0))) cleaned += char;
  }
  const folded = cleaned.replace(/\s+/g, ' ').trim();
  const points = [...folded];
  return points.length <= maxPoints ? folded : points.slice(0, maxPoints).join('');
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
  // البند 30: حقلان اختياريان additive منقّيان fail-closed — قيمة فاسدة تُسقط الحقل
  // وحده لا المدخل، وschema يبقى v1 (القراءة القديمة لملف بلا الحقلين تستمر).
  const taskExcerpt = excerptText(value.task_excerpt, MAX_TASK_EXCERPT);
  const runKind = SAFE_RUN_KIND.has(value.run_kind) ? value.run_kind : '';
  return {
    room_id: value.room_id,
    team_id: value.team_id,
    project_key: value.project_key,
    project_name: cleanText(value.project_name, 120) || 'مشروع',
    state: value.state,
    updated_at: value.updated_at,
    ...(artifactId ? { artifact_id: artifactId } : {}),
    ...(taskExcerpt ? { task_excerpt: taskExcerpt } : {}),
    ...(runKind ? { run_kind: runKind } : {}),
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
    // البند 30: حقلا العرض يُدرجان فقط عند وجودهما فيبقى شكل القائمة القديم حرفياً.
    ...(entry.task_excerpt ? { task_excerpt: entry.task_excerpt } : {}),
    ...(entry.run_kind ? { run_kind: entry.run_kind } : {}),
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
  SCHEMA_VERSION, FILE, MAX_ENTRIES, MAX_TASK_EXCERPT, projectKey, upsert, list, find, interruptStale, markArtifactsUnavailable,
};
