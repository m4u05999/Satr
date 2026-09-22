'use strict';

const assert = require('assert');
const { previewUserAgent } = require('../electron/preview-user-agent');
let checks = 0;
function check(label, fn) { fn(); checks += 1; console.log('PASS ' + label); }
const native = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Satr/2.18.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';
const expected = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36';
check('preview identity', () => assert.strictEqual(previewUserAgent(native), expected));
check('native identity opt-out', () => assert.strictEqual(previewUserAgent(native, true), native));
check('idempotence', () => assert.strictEqual(previewUserAgent(expected), expected));
check('preserve unrelated products', () => assert.strictEqual(previewUserAgent('OtherSatr/1 Chrome/140.1 Electron/40.0 Satr/2.19.0-beta.1'), 'OtherSatr/1 Chrome/140.1'));
check('case-insensitive application tokens', () => assert.strictEqual(previewUserAgent('satr/2.18.0 Chrome/130.0 ELECTRON/33.4.11'), 'Chrome/130.0'));

// بيانات اصطناعية فقط: قد ينجح JSON.parse مع تلف محتوى الرمز، لذا نقارن القيمة كاملة.
const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'synthetic-user', exp: 2000000000 })).toString('base64url'),
  'synthetic-signature'].join('.');
const encrypt = (value, secret) => [...JSON.stringify(value)].map(c => String.fromCharCode(c.charCodeAt(0) + secret)).join('');
const decrypt = (value, secret) => JSON.parse([...value].map(c => String.fromCharCode(c.charCodeAt(0) - secret)).join(''));
check('surrogate collision reproduces token corruption', () => {
  const encoded = encrypt(token, 56238);
  assert(encoded.length > [...encoded].length);
  assert.notStrictEqual(decrypt(encoded, 56238), token);
});
check('safe sample shift round-trips exactly', () => assert.strictEqual(decrypt(encrypt(token, 656), 656), token));
console.log('preview-user-agent: ' + checks + '/' + checks + ' PASS');
