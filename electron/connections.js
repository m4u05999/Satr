'use strict';

// توصيلات المشروع: لا يرث الحساب من البيئة، ولا يُكتب سر دون تشفير النظام.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const STRIP = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SAFE_SERVICE = /^[a-z][a-z0-9_-]{0,39}$/;
const SAFE_ACTION = /^[a-z][a-z0-9_]{0,63}$/;
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api.?key/i;
const MAX_STORE_BYTES = 256 * 1024;
const ERROR_CODES = new Set(['bad_cwd', 'bad_service', 'bad_token', 'bad_service_data', 'encryption_unavailable', 'storage_unavailable', 'storage_busy', 'connection_changed', 'not_connected', 'needs_auth', 'forbidden', 'inactive', 'bad_resource', 'bad_permissions', 'read_not_allowed', 'write_not_allowed', 'bad_action', 'bad_params', 'permission_denied', 'service_failed', 'network', 'not_found', 'invalid_response', 'bad_input']);
const fail = (code) => Object.assign(new Error(code), { connectionCode: code });
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const clean = (value, token, max = 240) => {
  let text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (token) text = text.split(token).join('[محجوب]');
  return text.replace(STRIP, ' ').trim().slice(0, max);
};

function publicData(value, token, depth = 0, state = { truncated: false }) {
  if (depth > 8) { state.truncated = true; return null; }
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = (token ? value.split(token).join('[محجوب]') : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
    if (text.length > 32000) state.truncated = true;
    return text.slice(0, 32000);
  }
  if (Array.isArray(value)) {
    if (value.length > 300) state.truncated = true;
    return value.slice(0, 300).map((item) => publicData(item, token, depth + 1, state));
  }
  if (typeof value !== 'object') return null;
  const output = {};
  const keys = Object.keys(value);
  if (keys.length > 100) state.truncated = true;
  for (const key of keys.slice(0, 100)) {
    if (SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const safeKey = clean(key, token, 120);
    if (safeKey && safeKey !== '__proto__') output[safeKey] = publicData(value[key], token, depth + 1, state);
  }
  if (depth === 0 && state.truncated) output.truncated = true;
  return output;
}
function identity(value, token) {
  const id = value && (typeof value.id === 'string' || typeof value.id === 'number') ? String(value.id) : '';
  if (!SAFE_ID.test(id) || (token && id.includes(token))) throw fail('bad_service_data');
  return { id, label: clean(value.label || id, token) };
}

function createManager(options = {}) {
  const storeDir = path.resolve(options.storeDir || path.join(os.homedir(), '.satr', 'connections'));
  const safeStorage = options.safeStorage || require('electron').safeStorage;
  const supplied = options.services || require('./connection-services').createServices();
  const services = new Map((Array.isArray(supplied) ? supplied.map((item) => [item.id, item]) : Object.entries(supplied))
    .filter(([id, item]) => SAFE_SERVICE.test(id) && item && typeof item === 'object'));

  function encryptionReady() {
    try {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }

  function context(cwd, service) {
    if (typeof cwd !== 'string' || !cwd.trim() || cwd !== cwd.trim() || cwd.length > 4096
      || !path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..') || STRIP.test(cwd)) {
      STRIP.lastIndex = 0; throw fail('bad_cwd');
    }
    STRIP.lastIndex = 0;
    let canonical;
    try {
      canonical = fs.realpathSync(cwd.trim());
      if (!fs.statSync(canonical).isDirectory()) throw new Error();
    } catch { throw fail('bad_cwd'); }
    const projectId = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
    if (service != null && !services.has(service)) throw fail('bad_service');
    return { projectId, service, provider: services.get(service),
      file: service == null ? null : path.join(storeDir, projectId + '-' + service + '.json') };
  }

  function rawState(ctx) {
    try {
      const stat = fs.statSync(ctx.file);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES || fs.lstatSync(ctx.file).isSymbolicLink()) throw fail('storage_unavailable');
      const text = fs.readFileSync(ctx.file, 'utf8');
      return { fingerprint: hash(text), text };
    } catch (error) {
      if (error.code === 'ENOENT') return { fingerprint: '', text: '' };
      throw fail('storage_unavailable');
    }
  }

  function decode(ctx, raw) {
    if (!raw.text) return null;
    let envelope;
    try { envelope = JSON.parse(raw.text); } catch { throw fail('storage_unavailable'); }
    const bound = (record) => record && record.version === 1 && record.projectId === ctx.projectId && record.service === ctx.service
      && typeof record.revision === 'string' && /^[0-9a-f-]{36}$/.test(record.revision);
    // علامة فصل بلا أسرار تعمل حتى عند تعطل DPAPI. لا تسمح بأي حقل إضافي أو صلاحية.
    if (envelope && envelope.disconnected === true) {
      if (!bound(envelope) || Object.keys(envelope).length !== 5
        || Object.keys(envelope).some((key) => !['version', 'projectId', 'service', 'revision', 'disconnected'].includes(key))) throw fail('storage_unavailable');
      return envelope;
    }
    if (!encryptionReady()) throw fail('encryption_unavailable');
    try {
      if (!envelope || envelope.version !== 1 || envelope.enc !== true || typeof envelope.data !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) throw new Error();
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, 'base64')));
      if (!bound(record)) throw new Error();
      if (record.disconnected === true) return record;
      if (typeof record.token !== 'string' || !record.token || !record.account
        || !['authenticated', 'needs-auth'].includes(record.authStatus)
        || !Array.isArray(record.permissions) || record.permissions.some((item) => item !== 'read' && item !== 'write')) throw new Error();
      return record;
    } catch { throw fail('storage_unavailable'); }
  }
  function read(ctx) { return decode(ctx, rawState(ctx)); }

  async function acquireKernelLock(endpoint) {
    const deadline = Date.now() + 500;
    for (;;) {
      const server = net.createServer((socket) => { socket.on('error', () => {}); socket.destroy(); });
      try {
        await new Promise((resolve, reject) => {
          server.on('error', reject);
          server.listen({ path: endpoint, exclusive: true }, resolve);
        });
        return () => new Promise((resolve) => { server.close(() => resolve()); });
      } catch (error) {
        await new Promise((resolve) => { server.close(() => resolve()); });
        // قد يخفي EADDRINUSE رفض صلاحية على Windows؛ لا نستنتج منه موت المالك أو نحذف ملفاً.
        if (error.code !== 'EADDRINUSE') throw fail('storage_unavailable');
        if (Date.now() >= deadline) throw fail('storage_busy');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async function acquireStoreLock(ctx) {
    fs.mkdirSync(storeDir, { recursive: true });
    const lockFile = ctx.file + '.lock';
    const canonicalStore = fs.realpathSync(storeDir);
    // UNC وباقي المنصات تبقى على القفل السابق؛ لا وعد باسترداد مخزن شبكي أو مشترك.
    if (process.platform !== 'win32' && process.platform !== 'linux'
      || process.platform === 'win32' && (storeDir.startsWith('\\\\') || canonicalStore.startsWith('\\\\'))) {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      return async () => {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      };
    }
    // توحيد junction/symlink في مسار المخزن يمنع اسمَي قفل لنفس الملف على الجهاز.
    const canonical = path.join(canonicalStore, path.basename(ctx.file));
    const fileId = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
    const hostId = hash(os.hostname().toLowerCase());
    const endpoint = (process.platform === 'win32' ? '\\\\.\\pipe\\' : '\0') + 'satr-connections-v2-' + hash(hostId + ':' + fileId);
    const releaseKernel = await acquireKernelLock(endpoint);
    const marker = JSON.stringify({ version: 2, file: fileId, host: hostId }) + '\n';
    const markerTemporary = lockFile + '.' + crypto.randomUUID() + '.tmp';
    let owned = false;
    try {
      // يظهر المحتوى كاملاً عند link، فلا تُترك علامة فارغة إن ماتت العملية أثناء الكتابة.
      fs.writeFileSync(markerTemporary, marker, { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(markerTemporary, lockFile); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(marker)
          || fs.readFileSync(lockFile, 'utf8') !== marker) throw fail('storage_busy');
        // الاسترداد لعمليات الجهاز وnamespace نفسها فقط؛ لا نحذف علامة جهاز آخر أو قفل قديم مجهول.
        fs.unlinkSync(lockFile);
        // قد تفوز نسخة قديمة هنا بـ wx؛ فشل link لا يمنحنا ملكية ملفها ولا حق حذفه.
        fs.linkSync(markerTemporary, lockFile);
      }
      owned = true;
    } catch (error) {
      try { fs.unlinkSync(markerTemporary); } catch {}
      await releaseKernel();
      throw error;
    }
    try { fs.unlinkSync(markerTemporary); } catch {}
    return async () => {
      if (owned) { try { fs.unlinkSync(lockFile); } catch {} }
      await releaseKernel();
    };
  }

  // القفل قصير ولا يحيط بالشبكة؛ المقارنة والكتابة الذرية تمنع مديراً قديماً من إحياء اتصال مفصول.
  async function commit(ctx, expected, transform, allowUnreadable = false, tombstone = false) {
    if (!tombstone && !encryptionReady()) throw fail('encryption_unavailable');
    let releaseLock;
    const temporary = ctx.file + '.' + crypto.randomUUID() + '.tmp';
    try { releaseLock = await acquireStoreLock(ctx); }
    catch (error) { throw error.connectionCode ? error : fail(error.code === 'EEXIST' ? 'storage_busy' : 'storage_unavailable'); }
    try {
      const raw = rawState(ctx);
      const current = allowUnreadable ? null : decode(ctx, raw);
      if (expected.fingerprint != null && raw.fingerprint !== expected.fingerprint
        || expected.revision != null && (!current || current.revision !== expected.revision)) throw fail('connection_changed');
      const next = transform(current);
      let text;
      if (tombstone) text = JSON.stringify(next);
      else {
        let encrypted;
        try { encrypted = safeStorage.encryptString(JSON.stringify(next)); }
        catch { throw fail('encryption_unavailable'); }
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw fail('encryption_unavailable');
        text = JSON.stringify({ version: 1, enc: true, data: encrypted.toString('base64') });
      }
      if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw fail('storage_unavailable');
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, ctx.file);
      return next;
    } catch (error) { throw error.connectionCode ? error : fail('storage_unavailable'); }
    finally {
      try { fs.unlinkSync(temporary); } catch {}
      await releaseLock();
    }
  }

  function connected(ctx, selected = false) {
    const record = read(ctx);
    if (!record || record.disconnected) throw fail('not_connected');
    if (record.authStatus === 'needs-auth') throw fail('needs_auth');
    if (selected && !record.resource) throw fail('bad_resource');
    return record;
  }

  function active(ctx, record, execution = {}) {
    if (typeof execution.isActive === 'function' && execution.isActive() !== true) throw fail('inactive');
    const latest = connected(ctx);
    if (latest.revision !== record.revision) throw fail('connection_changed');
    return latest;
  }

  function errorCode(error) {
    if (error && ERROR_CODES.has(error.connectionCode)) return error.connectionCode;
    const status = error && (error.status || error.statusCode);
    if (status === 401 || error && ['unauthorized', 'needs_auth', 'needs-auth', 'auth_expired'].includes(error.code)) return 'needs_auth';
    if (status === 403 || error && error.code === 'forbidden') return 'forbidden';
    if (error && ['network', 'not_found', 'invalid_response', 'bad_input'].includes(error.code)) return error.code;
    return 'service_failed';
  }

  async function rememberFailure(ctx, record, error, isTest = false) {
    const code = errorCode(error);
    if (record && (code === 'needs_auth' || isTest)) {
      try {
        await commit(ctx, { revision: record.revision }, (latest) => ({ ...latest,
          ...(code === 'needs_auth' ? { authStatus: 'needs-auth', connectionStatus: 'configured' } : {}),
          ...(isTest ? { lastTest: { at: now(), ok: false, error: code } } : {}) }));
      } catch {}
    }
    return { ok: false, error: code };
  }

  async function list(cwd, engine) {
    try {
      const project = context(cwd);
      const rows = [];
      for (const [id, provider] of services) {
        const row = { id, label: clean(provider.label || id), loginUrl: '', account: null, resource: null,
          permissions: [], authStatus: 'disconnected', connectionStatus: 'disconnected', lastTest: null, lastEngineUse: null, actions: {} };
        try {
          const url = new URL(provider.loginUrl);
          if (url.protocol === 'https:' && !url.username && !url.password) row.loginUrl = url.href;
        } catch {}
        for (const [name, action] of Object.entries(provider.actions || {})) {
          if (SAFE_ACTION.test(name) && action && typeof action.write === 'boolean') row.actions[name] = { write: action.write };
        }
        try {
          const record = read(context(cwd, id));
          if (record && !record.disconnected) {
            Object.assign(row, { account: publicData(record.account, record.token), resource: publicData(record.resource, record.token),
              permissions: [...record.permissions], authStatus: record.authStatus, connectionStatus: record.connectionStatus,
              lastTest: publicData(record.lastTest, record.token), lastEngineUse: publicData(record.lastEngineUse, record.token) });
          }
        } catch (error) { row.authStatus = 'unavailable'; row.connectionStatus = 'unavailable'; row.error = errorCode(error); }
        rows.push(row);
      }
      return { ok: true, projectId: project.projectId, services: rows };
    } catch (error) { return { ok: false, error: errorCode(error), services: [] }; }
  }

  async function authenticate(cwd, service, token) {
    try {
      const ctx = context(cwd, service);
      if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n\0]/.test(token)) throw fail('bad_token');
      token = token.trim();
      if (!encryptionReady()) throw fail('encryption_unavailable');
      const expected = rawState(ctx);
      const account = identity(await ctx.provider.authenticate(token), token);
      await commit(ctx, { fingerprint: expected.fingerprint }, () => ({ version: 1, projectId: ctx.projectId, service,
        revision: crypto.randomUUID(), token, account, resource: null, permissions: [],
        authStatus: 'authenticated', connectionStatus: 'unconfigured', lastTest: null, lastEngineUse: null }), true);
      return { ok: true, account };
    } catch (error) { return { ok: false, error: errorCode(error) }; }
  }

  async function resources(cwd, service) {
    let ctx, record;
    try {
      ctx = context(cwd, service); record = connected(ctx);
      const result = await ctx.provider.listResources(record.token);
      active(ctx, record);
      const items = Array.isArray(result) ? result : result && result.resources;
      if (!Array.isArray(items)) throw fail('bad_service_data');
      return { ok: true, resources: items.slice(0, 500).map((item) => identity(item, record.token)), truncated: items.length > 500 || result.truncated === true };
    } catch (error) { return ctx ? rememberFailure(ctx, record, error) : { ok: false, error: errorCode(error) }; }
  }

  async function select(cwd, service, resourceId, permissions) {
    let ctx, record;
    try {
      ctx = context(cwd, service); record = connected(ctx);
      if (typeof resourceId !== 'string' || !SAFE_ID.test(resourceId)) throw fail('bad_resource');
      if (!Array.isArray(permissions) || !permissions.includes('read') || permissions.length > 2
        || new Set(permissions).size !== permissions.length
        || permissions.some((item) => item !== 'read' && item !== 'write')
        || permissions.includes('write') && !Object.values(ctx.provider.actions || {}).some((action) => action.write === true)) throw fail('bad_permissions');
      const result = await ctx.provider.inspect(record.token, resourceId);
      active(ctx, record);
      const resource = identity({ id: resourceId, label: result && (result.label || result.name) || resourceId }, record.token);
      await commit(ctx, { revision: record.revision }, (latest) => ({ ...latest, revision: crypto.randomUUID(), resource,
        permissions: [...new Set(permissions)], connectionStatus: 'configured', lastTest: null, lastEngineUse: null }));
      return { ok: true, resource };
    } catch (error) { return ctx ? rememberFailure(ctx, record, error) : { ok: false, error: errorCode(error) }; }
  }

  async function test(cwd, service) {
    let ctx, record;
    try {
      ctx = context(cwd, service); record = connected(ctx, true);
      if (!record.permissions.includes('read')) throw fail('read_not_allowed');
      const data = await ctx.provider.inspect(record.token, record.resource.id);
      active(ctx, record);
      await commit(ctx, { revision: record.revision }, (latest) => ({ ...latest, connectionStatus: 'api-tested', lastTest: { at: now(), ok: true } }));
      active(ctx, record);
      return { ok: true, data: publicData(data, record.token) };
    } catch (error) { return ctx ? rememberFailure(ctx, record, error, true) : { ok: false, error: errorCode(error) }; }
  }

  async function disconnect(cwd, service) {
    try {
      const ctx = context(cwd, service);
      const expected = rawState(ctx);
      await commit(ctx, { fingerprint: expected.fingerprint }, () => ({ version: 1, projectId: ctx.projectId, service,
        revision: crypto.randomUUID(), disconnected: true }), true, true);
      return { ok: true };
    } catch (error) { return { ok: false, error: errorCode(error) }; }
  }

  async function execute(cwd, input, execution = {}) {
    let ctx, record, writeSucceeded = false;
    try {
      if (!input || typeof input !== 'object') throw fail('bad_action');
      const serialized = JSON.stringify(input);
      if (serialized.length > 36000) throw fail('bad_params');
      input = JSON.parse(serialized);
      ctx = context(cwd, input.service); record = connected(ctx, true);
      if (input.resource !== record.resource.id) throw fail('bad_resource');
      if (typeof input.action !== 'string' || !SAFE_ACTION.test(input.action)
        || !Object.hasOwn(ctx.provider.actions || {}, input.action)) throw fail('bad_action');
      const action = ctx.provider.actions[input.action];
      if (!action || typeof action.write !== 'boolean') throw fail('bad_action');
      if (!record.permissions.includes('read')) throw fail('read_not_allowed');
      active(ctx, record, execution);
      const params = input.params == null ? {} : input.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('bad_params');
      if (JSON.stringify(params).length > 32000) throw fail('bad_params');
      if (action.write) {
        if (!record.permissions.includes('write')) throw fail('write_not_allowed');
        if (typeof execution.requestPermission !== 'function' || await execution.requestPermission({
          service: input.service, resource: record.resource.id, action: input.action, params: publicData(params, record.token),
        }) !== true) throw fail('permission_denied');
      }
      active(ctx, record, execution);
      const data = await ctx.provider.run(record.token, record.resource.id, input.action, params, {
        assertActive: () => active(ctx, record, execution),
      });
      writeSucceeded = action.write;
      active(ctx, record, execution);
      const engine = clean(execution.engine, record.token, 64);
      try {
        await commit(ctx, { revision: record.revision }, (latest) => {
          active(ctx, record, execution);
          return { ...latest, connectionStatus: 'engine-used', lastEngineUse: { engine, at: now() } };
        });
      } catch (error) {
        if (!['storage_busy', 'storage_unavailable', 'encryption_unavailable'].includes(errorCode(error))) throw error;
        // نجاح الفعل الخارجي لا يتحول إلى فشل قابل للتكرار بسبب تعذر حفظ بيانات استعماله.
        active(ctx, record, execution);
        return { ok: true, data: publicData(data, record.token), warning: 'usage_not_saved', usageSaved: false };
      }
      active(ctx, record, execution);
      return { ok: true, data: publicData(data, record.token) };
    } catch (error) {
      const result = ctx ? await rememberFailure(ctx, record, error) : { ok: false, error: errorCode(error) };
      // لا نكشف بيانات اتصال تبدّل، لكن نقرّ بالكتابة الناجحة كي لا يُعاد أثرها.
      return writeSucceeded ? { ...result, externalOutcome: 'succeeded', retryable: false } : result;
    }
  }

  return { list, authenticate, resources, select, test, disconnect, execute };
}

let manager;
function getManager() { if (!manager) manager = createManager(); return manager; }
module.exports = { createManager, getManager };
