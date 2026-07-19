#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionmeta = require('../electron/sessionmeta');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-sessionmeta-'));
const file = path.join(root, '.satr', 'session-meta.json');

try {
  const store = sessionmeta.createStore({ file });
  assert.deepStrictEqual(store.list(), {});
  assert.deepStrictEqual(store.set('../bad', { pinned: true }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(store.set('valid-session', { pinned: 'yes' }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(store.set('valid-session', { unknown: true }), { ok: false, error: 'bad_input' });

  const rawTitle = '\u0000  عنوان\n جلسة\t' + 'ط'.repeat(100);
  const saved = store.set('valid-session', { pinned: true, title: rawTitle });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.entry.pinned, true);
  assert.strictEqual(saved.entry.title.includes('\n'), false);
  assert.strictEqual(saved.entry.title.length, sessionmeta.MAX_TITLE);
  assert.deepStrictEqual(store.get('valid-session'), saved.entry);
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.tmp-')), false);

  const reloaded = sessionmeta.createStore({ file });
  assert.deepStrictEqual(reloaded.get('valid-session'), saved.entry);
  assert.strictEqual(reloaded.set('valid-session', { pinned: false, title: '' }).ok, true);
  assert.strictEqual(reloaded.get('valid-session'), null);
  assert.deepStrictEqual(reloaded.remove('missing-session'), { ok: true, removed: false });

  const cappedFile = path.join(root, 'cap.json');
  const seed = {};
  for (let index = 0; index < sessionmeta.MAX_ENTRIES; index++) seed['s' + index] = { pinned: true };
  fs.writeFileSync(cappedFile, JSON.stringify(seed), 'utf8');
  const capped = sessionmeta.createStore({ file: cappedFile });
  assert.strictEqual(Object.keys(capped.list()).length, sessionmeta.MAX_ENTRIES);
  assert.deepStrictEqual(capped.set('overflow', { pinned: true }), { ok: false, error: 'limit' });
  assert.strictEqual(capped.set('s0', { title: 'مسموح' }).ok, true);
  assert.strictEqual(capped.remove('s1').removed, true);
  assert.strictEqual(capped.set('replacement', { pinned: true }).ok, true);

  const operations = [];
  const memoryFs = {
    readFileSync() { throw new Error('missing'); },
    mkdirSync() { operations.push('mkdir'); },
    writeFileSync(name) { operations.push(['write', name]); },
    renameSync(from, to) { operations.push(['rename', from, to]); },
    unlinkSync() {},
  };
  const atomic = sessionmeta.createStore({ file: path.join(root, 'atomic.json'), fs: memoryFs });
  assert.strictEqual(atomic.set('atomic-session', { pinned: true }).ok, true);
  assert.strictEqual(operations[1][0], 'write');
  assert(operations[1][1].includes('.tmp-'));
  assert.deepStrictEqual(operations[2].slice(0, 1), ['rename']);
  assert.strictEqual(operations[2][2], path.join(root, 'atomic.json'));

  console.log('sessionmeta: نجح — get/set/remove والتنقية والسقف والكتابة الذرية ورفض المدخلات.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
