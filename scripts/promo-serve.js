#!/usr/bin/env node
'use strict';

/**
 * خادم ثابت صفر اعتماديات لمشاهد إعلان promo/ (نمط site-serve.js حرفياً).
 * ‏127.0.0.1:4700 — للتسجيل والمعاينة أثناء الإنتاج حصراً؛ promo/ خارج حزمة التطبيق.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'promo');
const PORT = Number(process.env.PROMO_PORT) || 4700;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  // حماية decodeURIComponent من الترميز المشوّه (درس site-serve المثبّت)
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end('bad request'); return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
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
  console.log('promo scenes: http://127.0.0.1:' + PORT + '/?hud=1');
});
