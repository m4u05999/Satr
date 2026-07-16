'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CLIENT = path.join(__dirname, 'testspriteharness-client.js');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const INJECT_BEFORE = '<script src="vendor/xterm.js"></script>';
const MOCK_TAG = '<script src="/__testsprite__/mock-satr.js"></script>';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function harnessIndex() {
  const source = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  if (!source.includes(INJECT_BEFORE)) throw new Error('testsprite_harness_injection_point_missing');
  return source
    .replace(/<title>([^<]*)<\/title>/, '<title>$1 — TestSprite Harness</title>')
    .replace(INJECT_BEFORE, MOCK_TAG + '\n' + INJECT_BEFORE);
}

function safeAsset(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (error) { return null; }
  if (!decoded || decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '').replace(/\//g, path.sep);
  const target = path.resolve(SRC, relative);
  const prefix = SRC.endsWith(path.sep) ? SRC : SRC + path.sep;
  if (target !== SRC && !target.startsWith(prefix)) return null;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
  } catch (error) { return null; }
  return target;
}

function send(res, status, type, body, headOnly) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(headOnly ? undefined : data);
}

function createHarnessServer() {
  return http.createServer((req, res) => {
    const method = req.method || 'GET';
    const headOnly = method === 'HEAD';
    if (method !== 'GET' && !headOnly) {
      send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', headOnly);
      return;
    }
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch (error) { send(res, 400, 'text/plain; charset=utf-8', 'Bad Request', headOnly); return; }

    if (pathname === '/__testsprite__/health') {
      send(res, 200, MIME['.json'], JSON.stringify({ ok: true, harness: 'satr', version: 1 }), headOnly);
      return;
    }
    if (pathname === '/__testsprite__/mock-satr.js') {
      send(res, 200, MIME['.js'], fs.readFileSync(CLIENT), headOnly);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      send(res, 200, MIME['.html'], harnessIndex(), headOnly);
      return;
    }
    const asset = safeAsset(pathname);
    if (!asset) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not Found', headOnly);
      return;
    }
    send(res, 200, MIME[path.extname(asset).toLowerCase()] || 'application/octet-stream', fs.readFileSync(asset), headOnly);
  });
}

function parsePort(argv, env) {
  const index = argv.indexOf('--port');
  const raw = index === -1 ? env.TESTSPRITE_PORT : argv[index + 1];
  if (raw == null || raw === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(String(raw))) throw new Error('invalid_testsprite_port');
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error('invalid_testsprite_port');
  return port;
}

function supportsProject(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  try {
    const root = fs.realpathSync(cwd);
    const stat = fs.lstatSync(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.name === 'satr'
      && fs.statSync(path.join(root, 'electron', 'main.js')).isFile()
      && fs.statSync(path.join(root, 'src', 'index.html')).isFile();
  } catch (error) { return false; }
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/__testsprite__/health', timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(res.statusCode === 200 && body.ok === true && body.harness === 'satr' && body.version === 1);
        } catch (error) { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function start(port = DEFAULT_PORT) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new Error('invalid_testsprite_port'));
  }
  const server = createHarnessServer();
  return new Promise((resolve, reject) => {
    const fail = async (error) => {
      if (error && error.code === 'EADDRINUSE' && await probe(port)) {
        resolve({ port, url: `http://${HOST}:${port}`, owned: false, async close() {} });
        return;
      }
      reject(error);
    };
    server.once('error', fail);
    server.listen(port, HOST, () => {
      server.removeListener('error', fail);
      if (server.unref) server.unref();
      const actualPort = server.address().port;
      let closed = false;
      resolve({
        port: actualPort,
        url: `http://${HOST}:${actualPort}`,
        owned: true,
        async close() {
          if (closed) return;
          closed = true;
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

module.exports = {
  ROOT, SRC, CLIENT, HOST, DEFAULT_PORT,
  createHarnessServer, harnessIndex, safeAsset, parsePort, supportsProject, probe, start,
};
