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

// عقود دفعة 2.16.2 (بلاغ مستخدم 2026-08-23): رابط ملاحظات الإصدار، وإشعار الانتباه
// عند توقّف الدور، وخنق توست تقدّم TestSprite، ورفع النافذة من العملية الرئيسية.
function assertNotificationContract() {
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'chat.js'), 'utf8');
  const toast = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'lib', 'update-toast.js'), 'utf8');

  // (1) رفع النافذة يقع في main — window.focus() وحده لا يرفع نافذة Electron على ويندوز
  assert(main.includes("ipcMain.handle('satr:focusWindow'"), 'غاب معالج satr:focusWindow.');
  assert(main.includes('setAlwaysOnTop(true)') && main.includes('setAlwaysOnTop(false)'),
    'satr:focusWindow لا يستعمل حيلة alwaysOnTop اللحظية لتخطي قيد المقدمة في ويندوز.');
  assert(preload.includes('focusWindow:'), 'غاب focusWindow من preload.');
  assert(chat.includes('window.satr.focusWindow()'), 'النقر على الإشعار لا يمرّ بـfocusWindow.');

  // (2) رابط ملاحظات الإصدار يُبنى في main — لا URL يعبر من renderer
  assert(main.includes("ipcMain.handle('satr:openReleaseNotes'"), 'غاب معالج satr:openReleaseNotes.');
  assert(main.includes('SAFE_RELEASE_VERSION'), 'إصدار ملاحظات الإصدار بلا تحقق نمطي.');
  assert(!/openReleaseNotes[\s\S]{0,400}p\.url/.test(main), 'satr:openReleaseNotes يقبل URL من renderer.');
  assert(preload.includes('openReleaseNotes:'), 'غاب openReleaseNotes من preload.');
  assert(toast.includes('satr.openReleaseNotes(pendingVersion)'), 'زر «افتح في المتصفح» الثانوي غير موصول.');
  assert(main.includes("ipcMain.handle('satr:releaseNotes'"), 'غاب معالج جلب ملاحظات الإصدار.');
  // نظافة المصدر: منظّف ملاحظات الإصدار يكتب بايتات التحكم كهروب \xNN لا خاماً —
  // بايت خام واحد يجعل git/grep يعاملان main.js (أكبر ملف في المستودع) كثنائي.
  assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(main), 'بايتات تحكم خام داخل electron/main.js.');
  assert(main.includes('.replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f'), 'منظّف ملاحظات الإصدار لا يستعمل هروب \\xNN.');
  assert(toast.includes('satr.releaseNotes'), 'زر «ما الجديد» لا يفتح الحوار الداخلي.');
  assert(toast.includes('function openNotesFor'), 'الحوار غير قابل للفتح من خارج بطاقة التحديث.');
  assert(index.includes('id="appNotesBtn"') && appSource.includes('appNotesBtn'),
    'غاب «ما الجديد» من ⚙ — من هو على أحدث نسخة لا يرى بطاقة تحديث فيتعذّر فتحه.');
  assert(toast.includes('dialogBody.textContent'), 'نص الملاحظات يجب أن يُكتب بـtextContent — محتوى خارجي.');
  assert(!/dialogBody.innerHTML/.test(toast), 'نص ملاحظات خارجي يُحقن كـHTML.');

  // (3) إشعار الانتباه: الدور متوقف ينتظر قراراً — أذونات وأسئلة وموصّلات
  assert(chat.includes('function notifyAttention'), 'غابت notifyAttention من chat.js.');
  assert(chat.includes("'satr-attention'"), 'إشعار الانتباه بلا tag يمنع التكديس.');
  assert(chat.includes("'satr-turn'"), 'إشعار نهاية الدور بلا tag.');
  for (const needle of ['مطلوب إذن', 'سؤال ينتظر إجابتك', 'موصّل ينتظر إدخالك']) {
    assert(appSource.includes(needle), 'غاب إشعار الانتباه لحالة: ' + needle);
  }

  // (5) «ما الجديد؟» بلا محتوى وعدٌ كاذب: يلزم قسم للإصدار الحالي في CHANGELOG، وسير
  // النشر يجب أن يستخرجه — وإلا فتح الزر صفحةً فيها اسم الملف وبصمته فقط.
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const heading = new RegExp('^##\\s+' + version.replace(/\./g, '\\.') + '(\\s|$)', 'm');
  assert(heading.test(changelog), 'CHANGELOG.md بلا قسم للإصدار الحالي ' + version + '.');
  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert(release.includes('CHANGELOG.md'), 'سير النشر لا يقرأ CHANGELOG.md.');
  assert(release.includes('release-notes.md'), 'سير النشر لا يكتب ملاحظات الإصدار.');

  // (4) خنق توست TestSprite: لا يتكرر بلا تقدّم فعلي
  assert(appSource.includes('testspriteNoticeState'), 'غابت حالة خنق توست TestSprite.');
  assert(/testspriteNoticeState\.signature !== signature/.test(appSource),
    'توست تقدّم TestSprite يُعرض بلا مقارنة بالتقدّم السابق.');
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
    && appSource.includes('} = createUpdateToast({') && appSource.includes('showTransientNotice, handleUpdateEvent'),
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
  const originalSetInterval = global.setInterval;
  const originalDateNow = Date.now;
  const scheduled = [];
  const intervals = [];
  global.setTimeout = (callback, timeout) => {
    scheduled.push({ callback, timeout });
    return { unref() {} };
  };
  global.setInterval = (callback, timeout) => {
    const item = { callback, timeout, unrefed: false };
    intervals.push(item);
    return { unref() { item.unrefed = true; } };
  };

  try {
    const updater = require('../electron/updater');
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: false }), false);
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'enterprise' }), false);
    // درس علة 2026-08-08: القناة تعمل بلا signed (ثقة HTTPS+sha512 — نفس ثقة
    // التنزيل الأول)؛ اشتراط signed===true غير الممرَّر كان يقتلها بصمت منذ 2.10.0.
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community' }), true);
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community', signed: true }), true);
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community', signed: false }), false,
      'التعطيل الصريح signed:false يبقى محترماً');
    // نسخة المتجر (‏MSIX): المتجر يحدّثها، وتنزيل مثبّت NSIS داخلها ينتج نسختين متوازيتين
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community', msix: true }), false,
      'msix:true يعطّل قناة GitHub داخل حزمة المتجر');
    assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community', msix: false }), true,
      'msix:false لا يغيّر السلوك القائم');
    // قبل init: الفحص اليدوي يعيد unavailable بدل الانفجار (وضع التطوير)
    assert.deepStrictEqual(updater.checkNow(), { ok: false, error: 'unavailable' });

    const emitted = [];
    const fakeApp = new EventEmitter();
    fakeApp.isPackaged = true;
    updater.initUpdater(fakeApp, (event) => emitted.push(event), { edition: 'community', signed: true });
    assert.strictEqual(fake.autoDownload, false);
    assert.strictEqual(fake.autoInstallOnAppQuit, false);
    assert.deepStrictEqual(scheduled.map((item) => item.timeout), [8000]);
    assert.deepStrictEqual(intervals.map((item) => item.timeout), [4 * 60 * 60 * 1000],
      'الفحص الدوري كل 4 ساعات غائب.');
    assert.strictEqual(intervals[0].unrefed, true, 'مؤقّت الفحص الدوري يجب ألا يمنع إغلاق التطبيق (unref).');
    assert.deepStrictEqual(calls, { check: 0, download: 0, quit: 0 });

    // ① الفحوص التلقائية: إقلاع + خنق التركيز + الدوري — كلها صامتة بلا حدث
    // OBS-131: أول browser-window-focus قد يسبق مؤقّت الإقلاع (8000ms) — يجب ألا يضاعف الفحص
    fakeApp.emit('browser-window-focus');
    assert.strictEqual(calls.check, 0, 'OBS-131: فحص مزدوج عند الإقلاع — التركيز سبق مؤقّت الإقلاع.');
    scheduled[0].callback();
    assert.strictEqual(calls.check, 1, 'فحص الإقلاع لم يعمل.');
    fakeApp.emit('browser-window-focus');
    assert.strictEqual(calls.check, 1, 'فحص التركيز تجاهل نافذة الخنق (30 دقيقة).');
    // الفحص اليدوي يتجاوز خنق التركيز عمداً حتى داخل نافذته (عقد زرّ ⚙)
    assert.deepStrictEqual(updater.checkNow(), { ok: true });
    assert.strictEqual(calls.check, 2, 'الفحص اليدوي يجب أن يتجاوز خنق التركيز.');
    fake.emit('update-not-available');
    assert.deepStrictEqual(emitted, [{ type: 'update', phase: 'none' }], 'الفحص اليدوي لم يستلم ردّ «لا جديد».');
    emitted.length = 0;
    Date.now = () => originalDateNow() + 31 * 60 * 1000;
    fakeApp.emit('browser-window-focus');
    assert.strictEqual(calls.check, 3, 'فحص التركيز لم يعمل بعد انقضاء الخنق.');
    intervals[0].callback();
    assert.strictEqual(calls.check, 4, 'الفحص الدوري لم يعمل.');
    fake.emit('update-not-available');
    assert.deepStrictEqual(emitted, [], 'فحص تلقائي صامت بثّ «لا جديد» للمستخدم.');

    // ② الفحص اليدوي: none عند «لا جديد» وcheck_failed عند الخطأ — بلا نص خام
    assert.deepStrictEqual(updater.checkNow(), { ok: true });
    assert.strictEqual(calls.check, 5);
    fake.emit('update-not-available');
    assert.deepStrictEqual(emitted, [{ type: 'update', phase: 'none' }]);
    assert.deepStrictEqual(updater.checkNow(), { ok: true });
    assert.strictEqual(calls.check, 6);
    const silencedError = console.error;
    console.error = () => {};
    try { fake.emit('error', new Error('OFFLINE_RAW_DETAIL')); } finally { console.error = silencedError; }
    assert.deepStrictEqual(emitted[1], { type: 'update', phase: 'check_failed' });
    assert(!JSON.stringify(emitted).includes('OFFLINE_RAW_DETAIL'), 'تسرّب خطأ الفحص اليدوي الخام.');
    emitted.length = 0;

    // ③ خرائط الأحداث الأربعة كما كانت (بلا manualPending ⇒ error صامت)
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

    // ④ بعد «تتوفّر نسخة» تتوقف الفحوص التلقائية؛ اليدوي وحده يتجاوز
    intervals[0].callback();
    fakeApp.emit('browser-window-focus');
    assert.strictEqual(calls.check, 6, 'استمر فحص تلقائي بعد معرفة التحديث — إزعاج متكرر.');
    assert.deepStrictEqual(updater.checkNow(), { ok: true });
    assert.strictEqual(calls.check, 7, 'الفحص اليدوي يجب أن يتجاوز حارس updateKnown.');
    Date.now = originalDateNow;

    updater.downloadUpdate();
    assert.strictEqual(calls.download, 1);
    assert.strictEqual(calls.quit, 0);
    updater.quitAndInstall();
    assert.strictEqual(calls.quit, 1);
    return ['updater-flags', 'updater-events', 'updater-guards', 'explicit-consent',
      'periodic-focus-checks', 'manual-check-contract'];
  } finally {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    Date.now = originalDateNow;
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
  assertNotificationContract();
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
    assert.deepStrictEqual(result.calls, { download: 1, restart: 1, notes: 1, notesVersion: '3.2.1', fetch: 1, fetchVersion: '3.2.1' });
    assert.deepStrictEqual(result.checks, [
      'shared-transient-toast',
      'notes-visible-available',
      'available-nonblocking',
      'download-consent',
      'progress',
      'notes-opens-release',
      'ready-restart',
      'silent-error',
      'manual-check-feedback',
      'dismiss',
      'zero-csp-violations',
    ]);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار واجهة التحديث.');
    assert.deepStrictEqual(contractChecks, [
      'updater-flags', 'updater-events', 'updater-guards', 'explicit-consent',
      'periodic-focus-checks', 'manual-check-contract',
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
