#!/usr/bin/env node
'use strict';

/**
 * خادم ثابت صفر اعتماديات لمعاينة صفحة الهبوط site/ أثناء التطوير.
 * ‏http المدمجة فقط (نمط codexmcp/testspriteharness) — 127.0.0.1:4600.
 * الإنتاج على GitHub Pages؛ هذا للتطوير حصراً.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'site');
const PORT = Number(process.env.SITE_PORT) || 4600;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
  // ‏decodeURIComponent يرمي URIError على ترميز مشوّه (مثل /%E0%A4%A) —
  // بلا الحماية يسقط الخادم كاملاً (ملاحظة مراجعة Codex)
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end('bad request'); return;
  }
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  // حصر داخل site/ حصراً
  if (!abs.startsWith(ROOT + path.sep) && abs !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('site preview: http://127.0.0.1:' + PORT + '/');
});
