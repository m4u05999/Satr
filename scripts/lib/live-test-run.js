/**
 * ملكية بيئة الاختبار الحي وعزلها. لا يشغّل عمليات ولا شبكة ولا يحذف مجلدات.
 * كل قراءة تعيد فحص السلسلة والبيان؛ لا تتحول هوية التجربة إلى مسار يختاره المستدعي.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER = 'satr-live-test';
const SAFE_ID = /^live_[a-f0-9]{24}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const SAFE_EVIDENCE = /^[a-z][a-z0-9-]{0,47}\.json$/;
const RESERVED_FILE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_JSON_BYTES = 16384;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function fail(code) {
  const error = new Error('بيئة الاختبار الحي: ' + code);
  error.code = code;
  throw error;
}

function plain(value) {
  return value != null && Object.getPrototypeOf(value) === Object.prototype;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/** نفحص كل سلف، ففحص المجلد الأخير وحده لا يرى junction في dist مثلاً. */
function assertDirectory(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('unsafe-directory');
  const resolved = path.resolve(target);
  const anchor = path.parse(resolved).root;
  let current = anchor;
  for (const part of resolved.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('linked-directory');
    if (!samePath(fs.realpathSync.native(current), current)) fail('escaped-directory');
  }
  return resolved;
}

function ensureDirectory(target) {
  try { fs.mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return assertDirectory(target);
}

function readJson(file, maxBytes = MAX_JSON_BYTES) {
  assertDirectory(path.dirname(file));
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) fail('unsafe-json-file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) fail('changed-json-file');
    if (stat.size > maxBytes) fail('json-too-large');
    const content = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(content) > maxBytes) fail('json-too-large');
    try { return JSON.parse(content); }
    catch { fail('invalid-json'); } // لا نطبع نص JSON فقد يحتوي ملف متلاعب به على سر.
  } finally { fs.closeSync(fd); }
}

function createJson(file, value) {
  assertDirectory(path.dirname(file));
  const content = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_JSON_BYTES) fail('json-too-large');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, content, 'utf8'); }
  finally { fs.closeSync(fd); }
}

function expectedPaths(repoRoot, id) {
  const root = path.join(repoRoot, 'dist', 'live-tests', id);
  const home = path.join(root, 'home');
  return {
    root, home,
    profile: path.join(root, 'profile'),
    workspace: path.join(root, 'workspace'),
    evidence: path.join(root, 'evidence'),
    downloads: path.join(home, 'Downloads'),
  };
}

function validTime(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateManifest(repoRoot, id, manifest) {
  const keys = ['schemaVersion', 'owner', 'id', 'version', 'createdAt', 'state', 'paths'];
  if (!plain(manifest) || Object.keys(manifest).length !== keys.length
      || !keys.every((key) => Object.hasOwn(manifest, key))
      || manifest.schemaVersion !== 1 || manifest.owner !== OWNER || manifest.id !== id
      || manifest.state !== 'prepared' || typeof manifest.version !== 'string'
      || manifest.version.length > 64 || !SAFE_VERSION.test(manifest.version)
      || !validTime(manifest.createdAt) || !plain(manifest.paths)) fail('invalid-manifest');
  const expected = expectedPaths(repoRoot, id);
  if (Object.keys(manifest.paths).length !== Object.keys(expected).length) fail('invalid-owned-paths');
  for (const [key, target] of Object.entries(expected)) {
    if (manifest.paths[key] !== target || !inside(repoRoot, target)) fail('invalid-owned-paths');
    assertDirectory(target);
  }
  return manifest;
}

function loadRun(repoRoot, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) fail('invalid-run-id');
  const repo = assertDirectory(repoRoot);
  const root = expectedPaths(repo, id).root;
  assertDirectory(root);
  return validateManifest(repo, id, readJson(path.join(root, 'manifest.json')));
}

function homeDirectories(home) {
  return [
    'AppData', path.join('AppData', 'Roaming'), path.join('AppData', 'Local'),
    '.codex', '.claude', '.gemini', '.kimi-code', '.config', '.satr', path.join('.satr', 'mobile-tls'),
    'tmp',
  ].map((name) => path.join(home, name));
}

function prepareRun(repoRoot, options = {}) {
  if (!plain(options) || Object.keys(options).some((key) => key !== 'version')) fail('invalid-options');
  const repo = assertDirectory(repoRoot);
  const version = options.version === undefined ? readJson(path.join(repo, 'package.json'), 262144).version : options.version;
  if (typeof version !== 'string' || version.length > 64 || !SAFE_VERSION.test(version)) fail('invalid-version');
  ensureDirectory(path.join(repo, 'dist'));
  const base = ensureDirectory(path.join(repo, 'dist', 'live-tests'));
  let id;
  let paths;
  for (let attempt = 0; attempt < 8; attempt++) {
    id = 'live_' + crypto.randomBytes(12).toString('hex');
    paths = expectedPaths(repo, id);
    assertDirectory(base);
    try { fs.mkdirSync(paths.root, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 7) fail('run-id-collision');
    }
  }
  for (const target of Object.values(paths)) ensureDirectory(target);
  for (const target of homeDirectories(paths.home)) ensureDirectory(target);
  const manifest = {
    schemaVersion: 1, owner: OWNER, id, version,
    createdAt: new Date().toISOString(), state: 'prepared', paths,
  };
  createJson(path.join(paths.root, 'manifest.json'), manifest);
  return loadRun(repo, id);
}

function verifiedRun(run) {
  if (!plain(run) || !plain(run.paths) || typeof run.paths.root !== 'string'
      || !path.isAbsolute(run.paths.root)) fail('invalid-run');
  const repo = path.dirname(path.dirname(path.dirname(run.paths.root)));
  const disk = loadRun(repo, run.id);
  validateManifest(repo, run.id, run);
  if (JSON.stringify(run) !== JSON.stringify(disk)) fail('changed-manifest');
  return disk;
}

function buildChildEnv(baseEnv, run) {
  if (baseEnv == null || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) fail('invalid-environment');
  const owned = verifiedRun(run);
  const home = owned.paths.home;
  const overrides = {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GEMINI_CLI_HOME: path.join(home, '.gemini'),
    KIMI_CODE_HOME: path.join(home, '.kimi-code'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SATR_MOBILE_TLS_DIR: path.join(home, '.satr', 'mobile-tls'),
    SATR_RELAY_URL: ' ',
    TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(path.parse(home).root.replace(/[\\/]$/, '').length),
  };
  for (const target of homeDirectories(home)) assertDirectory(target);
  const env = {};
  const sensitive = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|(^|_)(KEY|CERT)(_|$)/i;
  const unsafeOverride = /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|ELECTRON_RUN_AS_NODE|SSH_AGENT_PID|SSH_ASKPASS|GIT_ASKPASS|GIT_CONFIG(?:_.*)?|NPM_CONFIG_USERCONFIG|KUBECONFIG|DOCKER_CONFIG)$/i;
  for (const [key, value] of Object.entries(baseEnv)) {
    const upper = key.toUpperCase();
    if (Object.hasOwn(overrides, upper) || sensitive.test(key) || unsafeOverride.test(key)
        || /^SATR_/i.test(key) || /(?:^|_)PROXY$/i.test(key)) continue;
    if (typeof value === 'string') env[key] = value;
  }
  return Object.assign(env, overrides);
}

function validateEvidence(record) {
  if (!plain(record)) fail('invalid-evidence');
  const allowed = new Set([
    'kind', 'status', 'scenario', 'time', 'pid', 'windowId', 'width', 'height', 'frames',
    'durationMs', 'bytes', 'file', 'sha256', 'errorCode',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))
      || !['launch', 'recording', 'scenario', 'shutdown'].includes(record.kind)
      || !['ready', 'recording', 'passed', 'failed', 'stopped', 'closed'].includes(record.status)
      || !validTime(record.time)) fail('invalid-evidence');
  for (const field of ['pid', 'windowId', 'width', 'height', 'frames', 'durationMs', 'bytes']) {
    if (Object.hasOwn(record, field) && (!Number.isSafeInteger(record[field]) || record[field] < 0)) fail('invalid-evidence-number');
  }
  if (Object.hasOwn(record, 'scenario') && (typeof record.scenario !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(record.scenario))) fail('invalid-evidence-scenario');
  if (Object.hasOwn(record, 'file') && (typeof record.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.(?:mp4|webm)$/.test(record.file) || RESERVED_FILE.test(record.file))) fail('invalid-evidence-file');
  if (Object.hasOwn(record, 'sha256') && (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256))) fail('invalid-evidence-hash');
  if (Object.hasOwn(record, 'errorCode') && (typeof record.errorCode !== 'string' || !/^[-a-z0-9_]{1,80}$/.test(record.errorCode))) fail('invalid-evidence-error');
  return record;
}

function evidencePath(repoRoot, id, name) {
  if (typeof name !== 'string' || !SAFE_EVIDENCE.test(name) || RESERVED_FILE.test(name)) fail('invalid-evidence-name');
  return path.join(loadRun(repoRoot, id).paths.evidence, name);
}

function writeEvidence(repoRoot, id, name, record) {
  const file = evidencePath(repoRoot, id, name);
  if (!plain(record)) fail('invalid-evidence');
  const clean = validateEvidence({ ...record, time: record.time === undefined ? new Date().toISOString() : record.time });
  createJson(file, clean);
  return clean;
}

function readEvidence(repoRoot, id, name) {
  return validateEvidence(readJson(evidencePath(repoRoot, id, name)));
}

module.exports = { prepareRun, loadRun, buildChildEnv, writeEvidence, readEvidence };
