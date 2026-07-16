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
  console.log('testsprite-harness: نجح — localhost فقط، حقن خارجي CSP-safe، ومنع traversal/الكتابة.');
}

main().catch((error) => {
  console.error('testsprite-harness:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
