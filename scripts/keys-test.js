#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'));

// حقن safeStorage مزيّف قبل أن تُحمّل keys.js — تمويه DPAPI لا يحتاج Electron
const electronPath = require.resolve('electron');
const fakeSafeStorage = {
  isEncryptionAvailable() { return true; },
  encryptString(plain) { return Buffer.from('mock:' + plain, 'utf8'); },
  decryptString(buf) {
    const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (!s.startsWith('mock:')) throw new Error('cannot decrypt — key belongs to another profile');
    return s.slice(5);
  },
};
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { safeStorage: fakeSafeStorage },
};

// احتجاز ملف المفاتيح داخل مجلد مؤقّت
os.homedir = () => tmpdir;
const keys = require('../electron/keys.js');

const entries = {
  good: { enc: true, v: fakeSafeStorage.encryptString('secret-value').toString('base64') },
  bad: { enc: true, v: Buffer.from('corrupt-ciphertext').toString('base64') },
  plain: { enc: false, v: 'plain-value' },
  legacy: 'legacy-value',
};

fs.mkdirSync(path.join(tmpdir, '.satr'), { recursive: true });
fs.writeFileSync(path.join(tmpdir, '.satr', 'keys.json'), JSON.stringify(entries, null, 2));

// names() تُدرج المفتاح المعطوب لأنها تفحص وجود النصّ المشفّر بلا فكّ
assert.deepStrictEqual(keys.names().sort(), ['bad', 'good', 'legacy', 'plain']);

// hasUsableValue ترفض المفتاح الذي لا يفكّه DPAPI على هذا الجهاز
assert.strictEqual(keys.hasUsableValue('bad'), false, 'مفتاح معطوب يُفكّ');
// وتقبل المفتاح المشفّر السليم
assert.strictEqual(keys.hasUsableValue('good'), true, 'مفتاح سليم مرفوض');
// والمفتاح الصريح الموسوم
assert.strictEqual(keys.hasUsableValue('plain'), true, 'مفتاح صريح مرفوض');
// والصيغة القديمة
assert.strictEqual(keys.hasUsableValue('legacy'), true, 'مفتاح قديم مرفوض');
// والغائب
assert.strictEqual(keys.hasUsableValue('missing'), false, 'مفتاح غائب مقبول');

// لا تُعاد القيمة أبداً — الناتج boolean صرف
assert.strictEqual(typeof keys.hasUsableValue('good'), 'boolean');

fs.rmSync(tmpdir, { recursive: true, force: true });
console.log('keys-test: OK — hasUsableValue rejects undecryptable keys without leaking values');
