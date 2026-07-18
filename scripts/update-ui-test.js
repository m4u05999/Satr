/**
 * اختبار التحديث التلقائي بطبقتين: عقد updater مع autoUpdater مزيف، ثم توست حي
 * في Chromium الفعلي عبر وحدة الواجهة الإنتاجية، تحت CSP صارم وبلا preload.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'update-ui.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractToast(source) {
  const startTag = '<div id="updateToast" hidden>';
  const start = source.indexOf(startTag);
  const end = source.indexOf('</div>', start);
  assert(start !== -1 && end !== -1, 'تعذّر إيجاد ترميز #updateToast.');
  return source.slice(start, end + '</div>'.length).replace(/>\s+</g, '><').trim();
}

function assertStaticContract() {
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
  assert.strictEqual(extractToast(fixture), extractToast(index),
    'انحرف ترميز #updateToast في fixture عن src/index.html.');
  assert(fixture.includes("script-src 'self'") && fixture.includes("style-src 'self'"),
    'يجب أن يعمل fixture تحت CSP صارم.');
  assert(!/\sstyle\s*=|\sonclick\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  const scripts = [...fixture.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0 && scripts.every((match) => /\bsrc\s*=/.test(match[1]) && !match[2].trim()),
    'يجب أن تكون كل سكربتات fixture خارجية.');
  assert(!/<style\b/i.test(fixture), 'يحتوي fixture كتلة style مضمّنة.');
  assert(appSource.includes("import { createUpdateToast } from './lib/update-toast.js';")
    && appSource.includes('const { showTransientNotice, handleUpdateEvent } = createUpdateToast({'),
  'app.js لا يستخدم وحدة update-toast الإنتاجية.');
  assert(!appSource.includes('function showTransientNotice(') && !appSource.includes('function handleUpdateEvent('),
    'بقيت نسخة مغلقة من منطق التوست داخل app.js.');
  assert(appSource.includes("if (ev.type === 'testsprite_progress')")
    && appSource.includes("showTransientNotice('🧪 يجري تجهيز TestSprite"),
  'انقطع استخدام TestSprite للدالة المستخرجة.');
  assert.strictEqual(packageJson.scripts['test:update-ui'], 'electron scripts/update-ui-test.js');
  assert(fullSuite.includes("'test:update-ui'"), 'غاب test:update-ui من full-suite.');
}

function testUpdaterContract() {
  const dependencyPath = require.resolve('electron-updater');
  const updaterPath = require.resolve('../electron/updater');
  const previousDependency = require.cache[dependencyPath];
  const previousUpdater = require.cache[updaterPath];
  const fake = new EventEmitter();
  const calls = { check: 0, download: 0, quit: 0 };
  fake.checkForUpdates = async () => { calls.check++; };
  fake.downloadUpdate = async () => { calls.download++; };
  fake.quitAndInstall = () => { calls.quit++; };
  const fakeModule = new Module(dependencyPath, module);
  fakeModule.filename = dependencyPath;
  fakeModule.loaded = true;
  fakeModule.exports = { autoUpdater: fake };
  require.cache[dependencyPath] = fakeModule;
  delete require.cache[updaterPath];

  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (callback, timeout) => {
    scheduled.push({ callback, timeout });
    return { unref() {} };
  };

  try {
    const updater = require('../electron/updater');
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: false }), false);
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'enterprise' }), false);
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community' }), true);

    const emitted = [];
    updater.initUpdater({ isPackaged: true }, (event) => emitted.push(event));
    assert.strictEqual(fake.autoDownload, false);
    assert.strictEqual(fake.autoInstallOnAppQuit, false);
    assert.deepStrictEqual(scheduled.map((item) => item.timeout), [8000]);
    assert.deepStrictEqual(calls, { check: 0, download: 0, quit: 0 });

    fake.emit('update-available', { version: '3.2.1' });
    fake.emit('download-progress', { percent: 67.6 });
    fake.emit('update-downloaded', { version: '3.2.1' });
    const originalError = console.error;
    console.error = () => {};
    try { fake.emit('error', new Error('RAW_UPDATER_SECRET')); } finally { console.error = originalError; }
    assert.deepStrictEqual(emitted, [
      { type: 'update', phase: 'available', version: '3.2.1' },
      { type: 'update', phase: 'progress', percent: 68 },
      { type: 'update', phase: 'ready', version: '3.2.1' },
      { type: 'update', phase: 'error' },
    ]);
    assert(!JSON.stringify(emitted).includes('RAW_UPDATER_SECRET'), 'تسرّبت رسالة updater الخام إلى الحدث.');
    assert.deepStrictEqual(calls, { check: 0, download: 0, quit: 0 });

    updater.downloadUpdate();
    assert.strictEqual(calls.download, 1);
    assert.strictEqual(calls.quit, 0);
    updater.quitAndInstall();
    assert.strictEqual(calls.quit, 1);
    return ['updater-flags', 'updater-events', 'updater-guards', 'explicit-consent'];
  } finally {
    global.setTimeout = originalSetTimeout;
    delete require.cache[updaterPath];
    if (previousUpdater) require.cache[updaterPath] = previousUpdater;
    if (previousDependency) require.cache[dependencyPath] = previousDependency;
    else delete require.cache[dependencyPath];
  }
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__updateUiResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة اختبار واجهة التحديث.');
}

async function main() {
  assertStaticContract();
  const contractChecks = testUpdaterContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار توست التحديث داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation.');
    assert.deepStrictEqual(result.calls, { download: 1, restart: 1 });
    assert.deepStrictEqual(result.checks, [
      'shared-transient-toast',
      'available-nonblocking',
      'download-consent',
      'progress',
      'ready-restart',
      'silent-error',
      'dismiss',
      'zero-csp-violations',
    ]);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار واجهة التحديث.');
    assert.deepStrictEqual(contractChecks, [
      'updater-flags', 'updater-events', 'updater-guards', 'explicit-consent',
    ]);
    console.log('update-ui: نجح — عقد updater والموافقة الصريحة وتوست Chromium غير الحاجب؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('update-ui:', error && error.stack ? error.stack : error);
  app.exit(1);
});
