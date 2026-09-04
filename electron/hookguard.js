/**
 * حارس خفيف لإعدادات Claude التي قد تعمل تلقائياً من مستودع غير موثوق.
 *
 * يفحص مسارات ثابتة فقط تحت .claude/، ولا يمشي الشجرة ولا يشغّل عملية. يحفظ
 * بصمة المحتوى ذي الصلة لكل مشروع بلا مساره أو أوامر الخطّاف، بكتابة ذرية
 * أفضل جهد. أي فشل قراءة/تحليل/كتابة يتدهور إلى الصمت بلا تسجيل (fail-open).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scrubSecrets } = require('./secretscrub');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'claude-hook-fingerprints.json');
const STORE_VERSION = 1;
const MAX_PROJECTS = 256;
const MAX_STORE_BYTES = 128 * 1024;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_SETUP_BYTES = 512 * 1024;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function projectKey(cwd) {
  let normalized = path.resolve(String(cwd || '')).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return digest(Buffer.from(normalized, 'utf8'));
}

async function readLimited(io, file, maxBytes, missingOk) {
  let stat;
  try {
    stat = await io.promises.lstat(file);
  } catch (error) {
    if (missingOk && error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error('unsafe_file');
  const bytes = await io.promises.readFile(file);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > maxBytes) throw new Error('oversize_file');
  return buffer.toString('utf8');
}

function hasSessionStartHook(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || !Object.prototype.hasOwnProperty.call(hooks, 'SessionStart')) return false;
  const value = hooks.SessionStart;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

async function scanProject(io, cwd) {
  const claudeDir = path.join(path.resolve(cwd), '.claude');
  let dirStat;
  try {
    dirStat = await io.promises.lstat(claudeDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe_directory');

  const findings = [];
  for (const name of SETTINGS_FILES) {
    const relativePath = '.claude/' + name;
    const raw = await readLimited(io, path.join(claudeDir, name), MAX_SETTINGS_BYTES, true);
    if (raw == null) continue;
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!hasSessionStartHook(parsed)) continue;
    findings.push({
      kind: 'session_start',
      path: relativePath,
      contentDigest: digest(Buffer.from(JSON.stringify(parsed.hooks.SessionStart), 'utf8')),
    });
  }

  const setupPath = path.join(claudeDir, 'setup.mjs');
  const setup = await readLimited(io, setupPath, MAX_SETUP_BYTES, true);
  if (setup != null) {
    findings.push({
      kind: 'setup',
      path: '.claude/setup.mjs',
      contentDigest: digest(Buffer.from(setup, 'utf8')),
    });
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

function cleanProjects(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== STORE_VERSION || !value.projects
      || typeof value.projects !== 'object' || Array.isArray(value.projects)) {
    throw new Error('invalid_store');
  }
  const source = value.projects;
  const projects = {};
  for (const [key, entry] of Object.entries(source)) {
    if (Object.keys(projects).length >= MAX_PROJECTS) break;
    if (!SAFE_DIGEST.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!SAFE_DIGEST.test(String(entry.fingerprint || ''))) continue;
    projects[key] = {
      fingerprint: entry.fingerprint,
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at.slice(0, 40) : '',
    };
  }
  return projects;
}

async function loadProjects(io, file) {
  const raw = await readLimited(io, file, MAX_STORE_BYTES, true);
  if (raw == null) return {};
  return cleanProjects(JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw));
}

async function persist(io, file, projects) {
  const temp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  try {
    await io.promises.mkdir(path.dirname(file), { recursive: true });
    const body = JSON.stringify({ version: STORE_VERSION, projects }, null, 2);
    if (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES) return false;
    await io.promises.writeFile(temp, body, 'utf8');
    await io.promises.rename(temp, file);
    return true;
  } catch {
    try { await io.promises.unlink(temp); } catch {}
    return false;
  }
}

function noticeText(findings) {
  const places = findings.map((finding) => finding.kind === 'session_start'
    ? 'خطّاف SessionStart في ' + finding.path
    : 'ملف الإعداد ' + finding.path);
  return scrubSecrets('⚠️ تنبيه أمني: عُثر داخل هذا المشروع على إعدادات قد تعمل تلقائياً مع Claude: '
    + places.join('، ') + '. راجع هذه الملفات قبل متابعة العمل؛ لن يوقف «سطر» هذا الدور.');
}

function noticeEvent(notice) {
  const normalized = String(notice || '')
    .replace(/[\x00-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g, '');
  const text = scrubSecrets(normalized).trim().slice(0, 1200);
  if (!text) return null;
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function createGuard(options = {}) {
  const io = options.fs || fs;
  const file = options.file || process.env.SATR_HOOK_GUARD_FILE || DEFAULT_FILE;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  let queue = Promise.resolve();

  async function inspect(cwd) {
    try {
      if (typeof cwd !== 'string' || !cwd.trim()) return null;
      const findings = await scanProject(io, cwd);
      const fingerprint = digest(Buffer.from(JSON.stringify(findings.map((finding) => ({
        kind: finding.kind, path: finding.path, contentDigest: finding.contentDigest,
      }))), 'utf8'));
      const key = projectKey(cwd);
      const projects = await loadProjects(io, file);
      if (projects[key] && projects[key].fingerprint === fingerprint) return null;

      const next = { ...projects };
      delete next[key];
      next[key] = { fingerprint, updated_at: now().toISOString() };
      while (Object.keys(next).length > MAX_PROJECTS) delete next[Object.keys(next)[0]];
      if (!await persist(io, file, next)) return null;
      return findings.length ? noticeText(findings) : null;
    } catch {
      return null;
    }
  }

  function inspectProject(cwd) {
    const run = queue.then(() => inspect(cwd), () => inspect(cwd));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { inspectProject };
}

const guard = createGuard();

module.exports = {
  inspectProject: guard.inspectProject,
  createGuard,
  noticeEvent,
  projectKey,
  DEFAULT_FILE,
  STORE_VERSION,
  MAX_PROJECTS,
  MAX_STORE_BYTES,
  MAX_SETTINGS_BYTES,
  MAX_SETUP_BYTES,
};
