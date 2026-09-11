#!/usr/bin/env node
'use strict';

// يشغّل Service Worker الإنتاجي كاملاً في VM؛ النقل وCacheStorage فقط بدائل
// في الذاكرة. لا يعيد الحارس صياغة مطابقة المسارات أو اختيار استجابة الشبكة.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://satr-sw.invalid:9443';
const CORE_ASSETS = ['index.html', 'app.js', 'crypto.js', 'styles.css', 'icon.svg', 'manifest.webmanifest'];
const fontCss = fs.readFileSync(path.join(ROOT, 'src/vendor/fonts.css'), 'utf8');
const FONT_ASSETS = [...new Set([...fontCss.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map((match) => match[1]))];
const EXPECTED_ASSETS = [...CORE_ASSETS, 'fonts.css', ...FONT_ASSETS];

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    clone: () => response(body, status),
  };
}

function loadWorker(prefix) {
  const workerUrl = new URL(prefix + 'sw.js', ORIGIN);
  const handlers = {};
  const stores = new Map();
  const installed = [];
  const fetched = [];
  let skipped = 0;
  let claimed = 0;
  let network = 'online';
  let failPut = false;
  const key = (request) => new URL(typeof request === 'string' ? request : request.url, workerUrl).href;
  const storage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(assets) {
          for (const asset of assets) {
            const url = key(asset);
            installed.push(url);
            entries.set(url, response('installed:' + new URL(url).pathname));
          }
        },
        async put(request, value) {
          if (failPut) throw new Error('quota');
          entries.set(key(request), value);
        },
        async match(request) { return entries.get(key(request)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const entries of stores.values()) {
        if (entries.has(key(request))) return entries.get(key(request));
      }
    },
  };
  const sandbox = {
    URL, Set, Error, Promise,
    caches: storage,
    async fetch(request) {
      fetched.push(key(request));
      if (network === 'offline') throw new Error('network_unavailable');
      return response('network:' + key(request), network === 'http-error' ? 503 : 200);
    },
    self: {
      location: workerUrl,
      addEventListener(type, handler) {
        assert.equal(handlers[type], undefined, 'تسجيل مستمع مكرر: ' + type);
        handlers[type] = handler;
      },
      skipWaiting: async () => { skipped += 1; },
      clients: { claim: async () => { claimed += 1; } },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'pwa/sw.js'), 'utf8'), sandbox, {
    filename: 'pwa/sw.js',
  });

  async function lifecycle(type) {
    const pending = [];
    handlers[type]({ waitUntil: (promise) => pending.push(Promise.resolve(promise)) });
    await Promise.all(pending);
  }
  async function request(url, method = 'GET') {
    const pending = [];
    let result;
    let handled = false;
    handlers.fetch({
      request: { url: new URL(url, ORIGIN).href, method },
      waitUntil: (promise) => pending.push(Promise.resolve(promise)),
      respondWith(promise) {
        assert.equal(handled, false, 'respondWith مرة واحدة');
        handled = true;
        result = Promise.resolve(promise);
      },
    });
    if (!handled) return { handled };
    const value = await result;
    await Promise.all(pending);
    return { handled, response: value };
  }
  return {
    lifecycle, request, installed, fetched, stores,
    network: (value) => { network = value; },
    failPut: (value) => { failPut = value; },
    skipped: () => skipped,
    claimed: () => claimed,
  };
}

async function assertNetworkFallback(prefix) {
  const worker = loadWorker(prefix);
  await worker.lifecycle('install');
  for (const asset of EXPECTED_ASSETS) {
    const pathname = prefix + asset;
    const online = await worker.request(pathname);
    assert.equal(online.handled, true, 'shell request was not intercepted: ' + pathname);
    assert.equal(await online.response.text(), 'network:' + ORIGIN + pathname,
      'network-first did not return the current asset: ' + pathname);
    worker.network('offline');
    const fallback = await worker.request(pathname);
    assert.equal(fallback.handled, true, 'offline shell request was not intercepted: ' + pathname);
    assert.equal(await fallback.response.text(), 'network:' + ORIGIN + pathname,
      'offline did not return the refreshed asset: ' + pathname);
    worker.network('online');
  }
  assert.equal(worker.fetched.length, EXPECTED_ASSETS.length * 2, 'كل طلب يجرب الشبكة أولاً');
}

async function assertPrecache(prefix) {
  const worker = loadWorker(prefix);
  worker.stores.set('satr-pwa-obsolete', new Map());
  await worker.lifecycle('install');
  assert.deepEqual(worker.installed.slice().sort(),
    EXPECTED_ASSETS.map((asset) => ORIGIN + prefix + asset).sort(),
    'precache did not include the shell, fonts.css and every vendored font');
  assert.equal(worker.skipped(), 1, 'install لم يطلب تفعيل النسخة الجديدة');
  const currentNames = [...worker.stores.keys()].filter((name) => name !== 'satr-pwa-obsolete');
  assert.equal(currentNames.length, 1, 'التثبيت اختار كاشاً واحداً للقشرة');
  await worker.lifecycle('activate');
  assert.deepEqual([...worker.stores.keys()], currentNames, 'activate did not retire the old cache');
  assert.equal(worker.claimed(), 1, 'activate لم يتولَّ العملاء');
  worker.network('offline');
  for (const asset of EXPECTED_ASSETS) {
    const pathname = prefix + asset;
    const cached = await worker.request(pathname + '?revision=15');
    assert.equal(cached.handled, true, 'precache request was not intercepted: ' + pathname);
    assert.equal(await cached.response.text(), 'installed:' + pathname,
      'precache fallback missed an asset with a query string: ' + pathname);
  }
  const entry = await worker.request(prefix);
  assert.equal(entry.handled, true, 'shell entry was not intercepted: ' + prefix);
  assert.equal(await entry.response.text(), 'installed:' + prefix + 'index.html',
    'shell entry did not use the installed index.html');
}

async function assertRequestBoundaries() {
  for (const prefix of ['/', '/pwa/']) {
    const worker = loadWorker(prefix);
    const excluded = [
      ['https://outside.invalid/pwa/app.js', 'GET'],
      ['https://outside.invalid' + prefix + 'app.js', 'GET'],
      [ORIGIN.replace('https:', 'http:') + prefix + 'app.js', 'GET'],
      ['https://satr-sw.invalid:9444' + prefix + 'app.js', 'GET'],
      ...['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((method) => [prefix + 'app.js', method]),
      ...['/poll', '/reply', '/pair', '/state', '/api/app.js', prefix + 'unknown.js',
        prefix + 'fonts/unknown.woff2', prefix + 'app.js/extra', '/pwa-other/app.js',
        prefix === '/' ? '/pwa/app.js' : '/app.js'].map((url) => [url, 'GET']),
    ];
    for (const [url, method] of excluded) {
      const result = await worker.request(url, method);
      assert.equal(result.handled, false, 'excluded request was intercepted: ' + method + ' ' + url);
    }
    assert.equal(worker.fetched.length, 0, 'الطلب المستبعد خرج عبر fetch الخاص بالعامل');
    assert.equal(worker.stores.size, 0, 'الطلب المستبعد فتح كاشاً');
  }
}

async function assertCacheFailures() {
  for (const prefix of ['/', '/pwa/']) {
    const worker = loadWorker(prefix);
    await worker.lifecycle('install');
    worker.network('http-error');
    const failure = await worker.request(prefix + 'app.js');
    assert.equal(failure.handled, true, 'HTTP error request was not intercepted: ' + prefix);
    assert.equal(failure.response.status, 503, 'HTTP error became a success from cache');
    worker.network('offline');
    const cached = await worker.request(prefix + 'app.js');
    assert.equal(await cached.response.text(), 'installed:' + prefix + 'app.js',
      'HTTP error replaced a valid cache entry');
    worker.network('online');
    worker.failPut(true);
    const fresh = await worker.request(prefix + 'app.js');
    assert.equal(await fresh.response.text(), 'network:' + ORIGIN + prefix + 'app.js',
      'cache write failure hid a successful network response');
  }
}

async function assertCacheMiss() {
  for (const prefix of ['/', '/pwa/']) {
    const worker = loadWorker(prefix);
    worker.network('offline');
    await assert.rejects(worker.request(prefix + 'app.js'), /offline/,
      'offline cache miss did not reject: ' + prefix);
  }
}

async function testPwaSw() {
  assert.ok(FONT_ASSETS.length > 0, 'لم تُقرأ ملفات الخط من CSS المصدر');
  const cases = [
    ['root-network-fallback', () => assertNetworkFallback('/')],
    ['pwa-network-fallback', () => assertNetworkFallback('/pwa/')],
    ['root-precache-entry', () => assertPrecache('/')],
    ['pwa-precache-entry', () => assertPrecache('/pwa/')],
    ['request-boundaries', assertRequestBoundaries],
    ['cache-errors', assertCacheFailures],
    ['offline-cache-miss', assertCacheMiss],
  ];
  const failures = [];
  for (const [name, run] of cases) {
    try {
      await run();
      console.log('pwa-sw: ok ' + name);
    } catch (error) {
      failures.push({ name, message: error.message });
      console.error('pwa-sw: FAIL ' + name + '\n' + error.stack);
    }
  }
  console.log('pwa-sw: ' + (cases.length - failures.length) + '/' + cases.length + ' scenarios passed');
  assert.equal(failures.length, 0, 'pwa-sw: ' + failures.length + '/' + cases.length + ' scenarios failed');
  return { passed: cases.length, total: cases.length, fonts: FONT_ASSETS.length };
}

module.exports = { testPwaSw };
if (require.main === module) {
  testPwaSw().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
