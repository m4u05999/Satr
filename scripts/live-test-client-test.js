#!/usr/bin/env node
'use strict';

// هذا الحارس يستدعي التحقق الإنتاجي فقط: بلا اتصال أو ملفات أو قراءة أسرار.
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { validateStatus, selectTarget } = require('./lib/live-test-client');
const repo = path.resolve(__dirname, '..');
const id = 'live_0123456789abcdef01234567';
const root = path.join(repo, 'dist', 'live-tests', id);
const run = { id, paths: { root, profile: path.join(root, 'profile') } };
const status = { ok: true, ready: true, id, profile: run.paths.profile, windowId: 7,
  debugPort: 9222, mainUrl: pathToFileURL(path.join(repo, 'src', 'index.html')).href };
const main = { id: 'ABC-123', type: 'page', url: status.mainUrl,
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC-123' };
let cases = 0;
function test(name, runCase) { runCase(); cases++; console.log('ok ' + cases + ' — ' + name); }
function rejects(fn, code) { assert.throws(fn, (error) => error.code === code && error.message === code); }
try {
  test('الحالة تربط النافذة بالتجربة والملف المعزول', () => {
    assert.deepStrictEqual(validateStatus(run, status), { id, profile: run.paths.profile,
      windowId: 7, debugPort: 9222, mainUrl: status.mainUrl });
  });
  test('عدم الجاهزية أو هوية تجربة أخرى يرفضان قبل الشبكة', () => {
    for (const change of [{ ok: false }, { ready: false }, { ready: 'true' }, { id: 'live_ffffffffffffffffffffffff' }]) {
      rejects(() => validateStatus(run, { ...status, ...change }), 'invalid_status');
    }
  });
  test('ملف المستخدم الأصلي والمسار النسبي لا يصلحان للربط', () => {
    for (const profile of [path.join(repo, 'profile'), 'profile', '', null]) {
      rejects(() => validateStatus(run, { ...status, profile }), 'profile_mismatch');
    }
  });
  test('معرف النافذة والمنفذ إلزاميان وصحيحان عدديا', () => {
    for (const windowId of [0, -1, '7', null]) rejects(() => validateStatus(run, { ...status, windowId }), 'invalid_window');
    for (const debugPort of [0, -1, 65536, 1.5, '9222', null]) rejects(() => validateStatus(run, { ...status, debugPort }), 'debug_unavailable');
  });
  test('عنوان القشرة لا يستبدل بصفحة خارجية أو ملف آخر', () => {
    for (const mainUrl of ['https://example.com', 'file:///other.html', status.mainUrl + '?other', status.mainUrl + '#other']) {
      rejects(() => validateStatus(run, { ...status, mainUrl }), 'main_url_mismatch');
    }
  });
  test('الهدف الصحيح يختار ولو سبقته المعاينة وصفحة أخرى', () => {
    const selected = selectTarget([
      { ...main, id: 'preview', url: 'http://localhost:3000' },
      { ...main, id: 'worker', type: 'worker' }, main,
    ], status);
    assert.strictEqual(selected.id, main.id);
    assert.strictEqual(selected.webSocketDebuggerUrl, main.webSocketDebuggerUrl);
  });
  test('غياب القشرة أو تعدد نسخها يرفضان دون اختيار تخميني', () => {
    rejects(() => selectTarget([], status), 'main_target_missing');
    rejects(() => selectTarget([{ ...main, type: 'worker' }], status), 'main_target_missing');
    rejects(() => selectTarget([main, { ...main, id: 'other-main' }], status), 'ambiguous_target');
    rejects(() => selectTarget({}, status), 'invalid_catalog');
  });
  test('localhost يحول إلى عنوان الحلقة المحلي نفسه', () => {
    const target = selectTarget([{ ...main, webSocketDebuggerUrl: main.webSocketDebuggerUrl.replace('127.0.0.1', 'localhost') }], status);
    assert.strictEqual(target.webSocketDebuggerUrl, main.webSocketDebuggerUrl);
  });
  test('المنفذ والهدف والبروتوكول لا يخرجان عن حالة التجربة', () => {
    for (const webSocketDebuggerUrl of [
      'ws://127.0.0.1:9223/devtools/page/ABC-123',
      'ws://example.com:9222/devtools/page/ABC-123',
      'wss://127.0.0.1:9222/devtools/page/ABC-123',
      'ws://127.0.0.1:9222/devtools/page/another',
      'ws://127.0.0.1:9222/devtools/browser/ABC-123',
      'ws://user@127.0.0.1:9222/devtools/page/ABC-123',
      main.webSocketDebuggerUrl + '?token=private',
      main.webSocketDebuggerUrl + '#other',
    ]) rejects(() => selectTarget([{ ...main, webSocketDebuggerUrl }], status), 'invalid_debug_url');
  });
  test('بيانات الهدف الناقصة لا تنتج اتصالا', () => {
    for (const change of [{ id: '../escape' }, { id: '' }, { webSocketDebuggerUrl: undefined }]) {
      rejects(() => selectTarget([{ ...main, ...change }], status), 'invalid_debug_url');
    }
  });
  console.log('live-test-client: ok — ' + cases + ' حالات');
} catch (error) {
  console.error('live-test-client: FAIL — ' + (error && error.stack || error));
  process.exitCode = 1;
}