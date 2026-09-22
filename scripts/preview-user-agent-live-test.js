'use strict';

// نختبر مسار preview.open الفعلي وأول طلب وJavaScript دون بيانات دخول حقيقية.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-preview-ua-'));
app.setPath('userData', profile);
const preview = require('../electron/preview');
const { previewUserAgent } = require('../electron/preview-user-agent');
const previousFlag = process.env.SATR_PREVIEW_NATIVE_UA;
delete process.env.SATR_PREVIEW_NATIVE_UA;
let server, win, checks = 0;
const requests = [];
function check(label, fn) { fn(); checks += 1; console.log('PASS ' + label); }
const deadline = setTimeout(() => { console.error('FAIL preview-user-agent timeout'); app.exit(1); }, 20000);
async function main() {
  await app.whenReady();
  const original = app.userAgentFallback;
  const defaultIdentity = session.defaultSession.getUserAgent();
  server = http.createServer((req, res) => {
    requests.push({ path: req.url, ua: req.headers['user-agent'], hints: req.headers['sec-ch-ua'] || null });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html lang="en"><body><p id="ready">Preview identity fixture</p></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(base + '/host');
  const hostIdentity = await win.webContents.executeJavaScript('navigator.userAgent');
  preview.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  async function open(label) {
    assert.strictEqual(preview.open(win, () => {}, base + '/' + label).ok, true);
    assert((await preview.waitFor({ selector: '#ready' }, 5000)).found, 'fixture did not load');
    const wc = win.contentView.children.find(child => child.webContents).webContents;
    return { wc, values: await wc.executeJavaScript('({ua:navigator.userAgent,brands:navigator.userAgentData?.brands})') };
  }
  const first = await open('first');
  const expected = previewUserAgent(original);
  check('first request uses preview identity', () => assert.strictEqual(requests.find(r => r.path === '/first').ua, expected));
  check('JavaScript sees same preview identity', () => {
    assert.strictEqual(first.values.ua, expected);
    assert(!/\b(?:Satr|Electron)\//i.test(first.values.ua));
    assert.strictEqual(/Chrome\/([\d.]+)/.exec(first.values.ua)[1], process.versions.chrome);
  });
  check('preview security isolation remains enabled', () => {
    const prefs = first.wc.getLastWebPreferences();
    assert(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration && !prefs.preload);
    assert.notStrictEqual(first.wc.session, session.defaultSession);
  });
  await first.wc.executeJavaScript("localStorage.setItem('ua-fixture','preserved');document.cookie='ua_fixture=preserved; path=/'");
  preview.close();
  const reopened = await open('reopened');
  check('recreated view keeps normalized identity', () => {
    assert.strictEqual(reopened.values.ua, expected);
    assert.strictEqual(requests.find(r => r.path === '/reopened').ua, expected);
  });
  const stored = await reopened.wc.executeJavaScript("({local:localStorage.getItem('ua-fixture'),cookie:document.cookie})");
  check('recreation preserves preview storage', () => {
    assert.strictEqual(stored.local, 'preserved');
    assert(stored.cookie.includes('ua_fixture=preserved'));
  });
  preview.close();
  process.env.SATR_PREVIEW_NATIVE_UA = '1';
  const legacy = await open('native');
  check('opt-out restores native identity', () => {
    assert.strictEqual(legacy.values.ua, original);
    assert.strictEqual(requests.find(r => r.path === '/native').ua, original);
  });
  preview.close();
  delete process.env.SATR_PREVIEW_NATIVE_UA;
  const restored = await open('restored');
  check('normalization resumes after opt-out', () => assert.strictEqual(restored.values.ua, expected));
  const afterHost = await win.webContents.executeJavaScript('navigator.userAgent');
  check('host and default session remain unchanged', () => {
    assert.strictEqual(afterHost, hostIdentity);
    assert.strictEqual(session.defaultSession.getUserAgent(), defaultIdentity);
    assert.strictEqual(app.userAgentFallback, original);
  });
  console.log('CLIENT_HINTS=' + JSON.stringify({ native: legacy.values.brands, preview: first.values.brands,
    nativeHeader: requests.find(r => r.path === '/native').hints, previewHeader: requests.find(r => r.path === '/first').hints }));
  console.log('preview-user-agent-live: ' + checks + '/' + checks + ' PASS');
}
main().then(() => finish(0), error => { console.error(error.stack); finish(1); });
function finish(code) {
  clearTimeout(deadline);
  if (previousFlag === undefined) delete process.env.SATR_PREVIEW_NATIVE_UA;
  else process.env.SATR_PREVIEW_NATIVE_UA = previousFlag;
  preview.close();
  if (win && !win.isDestroyed()) win.destroy();
  if (server) server.close();
  // يبقى المجلد المؤقت حتى خروج Electron وتحرير ملفاته؛ يطبع مساره لتنظيف التجربة.
  console.log('TEST_PROFILE=' + profile);
  app.exit(code);
}
