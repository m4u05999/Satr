'use strict';

// قيادة تطوير للنافذة المملوكة للتجربة؛ لا تقبل عنوانا أو منفذا من المستدعي.
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const core = require('./live-test-run');
const { command } = require('../live-test');
const TIMEOUT_MS = 10000;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function validPort(value) { return Number.isInteger(value) && value > 0 && value <= 65535; }
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function validateStatus(run, status) {
  if (!run || !run.paths || !/^live_[a-f0-9]{24}$/.test(run.id || '')
      || !status || status.ok !== true || status.ready !== true || status.id !== run.id) throw failure('invalid_status');
  if (!samePath(status.profile, run.paths.profile)) throw failure('profile_mismatch');
  if (!Number.isInteger(status.windowId) || status.windowId < 1) throw failure('invalid_window');
  if (!validPort(status.debugPort)) throw failure('debug_unavailable');
  if (typeof run.paths.root !== 'string' || !path.isAbsolute(run.paths.root)) throw failure('invalid_status');
  const repo = path.dirname(path.dirname(path.dirname(run.paths.root)));
  const expectedUrl = pathToFileURL(path.join(repo, 'src', 'index.html')).href;
  if (status.mainUrl !== expectedUrl) throw failure('main_url_mismatch');
  return { id: status.id, profile: status.profile, windowId: status.windowId,
    mainUrl: status.mainUrl, debugPort: status.debugPort };
}
function selectTarget(catalog, status) {
  if (!Array.isArray(catalog) || catalog.length > 4096 || !status || !validPort(status.debugPort)
      || typeof status.mainUrl !== 'string' || !status.mainUrl.startsWith('file:///')) throw failure('invalid_catalog');
  const matches = catalog.filter((item) => item && item.type === 'page' && item.url === status.mainUrl);
  if (matches.length !== 1) throw failure(matches.length ? 'ambiguous_target' : 'main_target_missing');
  const item = matches[0];
  if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
      || typeof item.webSocketDebuggerUrl !== 'string') throw failure('invalid_debug_url');
  const match = /^ws:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/devtools\/page\/([A-Za-z0-9_-]{1,128})$/.exec(item.webSocketDebuggerUrl);
  if (!match || Number(match[2]) !== status.debugPort || match[3] !== item.id) throw failure('invalid_debug_url');
  return { id: item.id, url: item.url,
    webSocketDebuggerUrl: 'ws://127.0.0.1:' + status.debugPort + '/devtools/page/' + item.id };
}
function deadline(promise, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure(code)), TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
}
function readCatalog(port) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(failure('catalog_failed'));
        request.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          finish(failure('catalog_too_large'));
          request.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => finish(failure('catalog_failed')));
      response.on('end', () => {
        if (finished) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(failure('invalid_catalog')); }
      });
    });
    request.on('error', () => finish(failure('catalog_failed')));
    timer = setTimeout(() => { finish(failure('catalog_timeout')); request.destroy(); }, TIMEOUT_MS);
  });
}
function openClient(url) {
  if (typeof globalThis.WebSocket !== 'function') return Promise.reject(failure('websocket_unavailable'));
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = new WebSocket(url); }
    catch { reject(failure('debug_connect_failed')); return; }
    let closed = false;
    let opened = false;
    let nextId = 0;
    const pending = new Map();
    const timer = setTimeout(() => finish('debug_connect_timeout'), TIMEOUT_MS);
    function finish(code) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (!opened) reject(failure(code));
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure(code)); }
      pending.clear();
      try { socket.close(); } catch {}
    }
    function evaluate(expression) {
      if (closed) return Promise.reject(failure('debug_closed'));
      if (typeof expression !== 'string' || !expression || expression.length > 1024 * 1024) return Promise.reject(failure('invalid_expression'));
      const id = ++nextId;
      return new Promise((resolveRequest, rejectRequest) => {
        const requestTimer = setTimeout(() => { pending.delete(id); rejectRequest(failure('evaluate_timeout')); }, TIMEOUT_MS);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer: requestTimer });
        try {
          socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
            expression, awaitPromise: true, returnByValue: true,
          } }));
        } catch {
          clearTimeout(requestTimer);
          pending.delete(id);
          rejectRequest(failure('evaluate_send_failed'));
        }
      });
    }
    socket.addEventListener('open', () => {
      if (closed) return;
      opened = true;
      clearTimeout(timer);
      resolve({ evaluate, close: () => finish('debug_closed') });
    });
    socket.addEventListener('error', () => finish('debug_connect_failed'));
    socket.addEventListener('close', () => finish('debug_closed'));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { finish('invalid_debug_response'); return; }
      if (!message || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      // لا ننقل تفاصيل الاستثناء؛ قد تتضمن التعبير أو قيما خاصة بالواجهة.
      if (message.error) item.reject(failure('evaluate_failed'));
      else if (!message.result || message.result.exceptionDetails) item.reject(failure('evaluate_exception'));
      else if (!message.result.result) item.reject(failure('invalid_debug_response'));
      else item.resolve(message.result.result.value);
    });
  });
}
async function connectMain(repoRoot, id) {
  let run;
  try { run = core.loadRun(repoRoot, id); }
  catch { throw failure('invalid_run'); }
  let rawStatus;
  try { rawStatus = await deadline(command(run, 'status'), 'status_timeout'); }
  catch (error) { throw failure(error && error.code === 'status_timeout' ? 'status_timeout' : 'status_failed'); }
  const status = validateStatus(run, rawStatus);
  const target = selectTarget(await readCatalog(status.debugPort), status);
  return openClient(target.webSocketDebuggerUrl);
}
module.exports = { connectMain, validateStatus, selectTarget };