#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const harness = require('./testsprite-harness');

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: harness.HOST, port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  assert.strictEqual(harness.parsePort([], {}), 4173);
  assert.strictEqual(harness.parsePort(['--port', '5180'], {}), 5180);
  assert.throws(() => harness.parsePort(['--port', '0'], {}), /invalid_testsprite_port/);
  assert.strictEqual(harness.safeAsset('/ui/app.js'), path.join(harness.SRC, 'ui', 'app.js'));
  assert.strictEqual(harness.safeAsset('/..%2fpackage.json'), null);
  assert.strictEqual(harness.supportsProject(path.resolve(__dirname, '..')), true);
  assert.strictEqual(harness.supportsProject(path.join(__dirname, 'missing-project')), false);

  const index = harness.harnessIndex();
  assert(index.includes('/__testsprite__/mock-satr.js'));
  assert(index.includes('TestSprite Harness'));
  assert(index.includes("script-src 'self'"));
  assert(!fs.readFileSync(path.join(harness.SRC, 'index.html'), 'utf8').includes('/__testsprite__/mock-satr.js'),
    'تسرّب حقن harness إلى index الإنتاجي.');

  const server = harness.createHarnessServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, harness.HOST, resolve);
  });
  const port = server.address().port;
  try {
    const health = await request(port, '/__testsprite__/health');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(JSON.parse(health.body), { ok: true, harness: 'satr', version: 1 });
    assert.strictEqual(health.headers['cache-control'], 'no-store');
    assert.strictEqual(health.headers['x-content-type-options'], 'nosniff');

    const root = await request(port, '/');
    assert.strictEqual(root.status, 200);
    assert(root.body.includes('/__testsprite__/mock-satr.js'));
    const app = await request(port, '/ui/app.js');
    assert.strictEqual(app.status, 200);
    assert(String(app.headers['content-type']).startsWith('text/javascript'));
    const escape = await request(port, '/..%2fpackage.json');
    assert.strictEqual(escape.status, 404);
    const write = await request(port, '/', 'POST');
    assert.strictEqual(write.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const owned = await harness.start(0);
  assert.strictEqual(owned.owned, true);
  assert.strictEqual(await harness.probe(owned.port), true);
  const reused = await harness.start(owned.port);
  assert.strictEqual(reused.owned, false);
  assert.strictEqual(reused.url, owned.url);
  await reused.close();
  assert.strictEqual(await harness.probe(owned.port), true, 'إغلاق المقبض المعاد استخدامه قتل خادماً لا يملكه.');
  await owned.close();
  await owned.close();
  assert.strictEqual(await harness.probe(owned.port), false);

  // سطح site/: ثوابت وجذر وحواجز خادم الموقع الثابت.
  assert.strictEqual(harness.DEFAULT_SITE_PORT, 4620);
  assert.strictEqual(harness.supportsSite(path.resolve(__dirname, '..')), true);
  assert.strictEqual(harness.supportsSite(path.join(__dirname, 'missing-project')), false);
  assert.strictEqual(harness.safeAsset('/enterprise.html', harness.SITE), path.join(harness.SITE, 'enterprise.html'));
  assert.strictEqual(harness.safeAsset('/..%2fpackage.json', harness.SITE), null);

  const siteServer = harness.createSiteServer();
  await new Promise((resolve, reject) => {
    siteServer.once('error', reject);
    siteServer.listen(0, harness.HOST, resolve);
  });
  const sitePort = siteServer.address().port;
  try {
    const health = await request(sitePort, '/__testsprite__/health');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(JSON.parse(health.body), { ok: true, harness: 'satr', version: 1, surface: 'site' });
    const siteRoot = await request(sitePort, '/');
    assert.strictEqual(siteRoot.status, 200);
    assert(siteRoot.body.includes('سطر'));
    assert(!siteRoot.body.includes('mock-satr'), 'خادم site يحقن محاكاة لا يحتاجها الموقع.');
    // ‏regression جولة TestSprite الأولى: baseURL بشرطة مزدوجة (4620//) يجب أن يخدم index.
    const doubleSlash = await request(sitePort, '//');
    assert.strictEqual(doubleSlash.status, 200, 'المسار // حجب الصفحة الرئيسية.');
    assert(doubleSlash.body.includes('سطر'));
    assert.strictEqual((await request(sitePort, '//enterprise.html')).status, 200);
    for (const page of ['/enterprise.html', '/wallet.html']) {
      const res = await request(sitePort, page);
      assert.strictEqual(res.status, 200, page + ' غير مخدومة.');
      assert(String(res.headers['content-type']).startsWith('text/html'));
    }
    assert.strictEqual((await request(sitePort, '/__testsprite__/mock-satr.js')).status, 404,
      'خادم site يكشف عميل المحاكاة.');
    assert.strictEqual((await request(sitePort, '/..%2fpackage.json')).status, 404);
    assert.strictEqual((await request(sitePort, '/', 'POST')).status, 405);
    // بصمة السطحين متمايزة: probe بلا surface يخص الواجهة، وprobe('site') يخص الموقع.
    assert.strictEqual(await harness.probe(sitePort), false, 'خادم site قُبل كأنه سطح الواجهة.');
    assert.strictEqual(await harness.probe(sitePort, 'site'), true);
  } finally {
    await new Promise((resolve) => siteServer.close(resolve));
  }

  const siteOwned = await harness.startSite(0);
  assert.strictEqual(siteOwned.owned, true);
  assert.strictEqual(await harness.probe(siteOwned.port, 'site'), true);
  // خادم واجهة قائم على المنفذ نفسه لا يُقبل بديلاً عن سطح site (تمييز البصمة).
  const appOnSitePort = await harness.start(0);
  await assert.rejects(harness.startSite(appOnSitePort.port), /EADDRINUSE|listen/i,
    'startSite قبل خادم الواجهة كأنه سطح site.');
  await appOnSitePort.close();
  await siteOwned.close();
  assert.strictEqual(await harness.probe(siteOwned.port, 'site'), false);

  console.log('testsprite-harness: نجح — localhost فقط، حقن خارجي CSP-safe، منع traversal/الكتابة، وسطح site مستقل البصمة.');
}

main().catch((error) => {
  console.error('testsprite-harness:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
