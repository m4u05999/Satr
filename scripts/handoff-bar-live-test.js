// اختبار Chromium حيّ لشريط التسليم البشري: يشغّل مكوّن preview-panel الإنتاجي تحت
// CSP صارم، ويثبت عقد handoff_request/Done/end ونهاية الدور بلا نسخة من المكوّن.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'handoff-bar-live.html');
const TIMEOUT_MS = 30000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function assertStaticContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'preview-panel.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');

  assert(fixture.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(fixture.includes('../../src/ui/components/preview-panel.js'), 'fixture لا يستورد preview-panel الحقيقي.');
  assert(fixture.includes("script-src 'self'") && fixture.includes("style-src 'self'"), 'fixture ليس تحت CSP صارم.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(fixture), 'fixture يحوي script مضمّناً.');
  assert(!/<style\b|\sstyle\s*=|\son[a-z]+\s*=/i.test(fixture), 'fixture يحوي نمطاً أو معالجاً مضمّناً.');

  assert(/ev\.type === 'handoff_request'[\s\S]{0,220}previewEl\.showHandoff/.test(appSource),
    'app.js لا يوجّه handoff_request إلى preview-panel.');
  assert(/ev\.type === 'handoff_end'[\s\S]{0,180}previewEl\.hideHandoff/.test(appSource),
    'app.js لا يخفي الشريط عند handoff_end.');
  // مسار تحرير الدور يخفي الشريط. دفعة D استخرجت جسمه إلى releaseRunControls التي
  // يستدعيها endRun، فنتحقق من الدالة الحاملة للإخفاء ومن استدعائها معاً — لا من
  // موضع السطر داخل endRun حرفياً.
  const releaseName = appSource.includes('function releaseRunControls()') ? 'releaseRunControls' : 'endRun';
  const releaseStart = appSource.indexOf('function ' + releaseName + '()');
  const releaseEnd = appSource.indexOf('\n  }', releaseStart);
  assert(releaseStart !== -1 && releaseEnd !== -1
    && appSource.slice(releaseStart, releaseEnd).includes('previewEl.hideHandoff'),
  'مسار تحرير الدور لا يخفي شريط التسليم.');
  if (releaseName !== 'endRun') {
    const endRunStart = appSource.indexOf('function endRun()');
    const endRunEnd = appSource.indexOf('\n  }', endRunStart);
    assert(endRunStart !== -1 && endRunEnd !== -1
      && appSource.slice(endRunStart, endRunEnd).includes(releaseName + '()'),
    'endRun لا يستدعي مسار تحرير الدور.');
  }
  assert(panelSource.includes('window.satr.handoffDone(id, done)'), 'المكوّن لا يرد عبر handoffDone بعقد boolean.');
  assert(panelSource.includes('window.satr.secretDone(id, done)'), 'المكوّن لا يرد عبر secretDone بعقد boolean.');
  assert.strictEqual(packageJson.scripts['test:handoff-bar-live'], 'electron scripts/handoff-bar-live-test.js');
  assert(fullSuite.includes("'test:handoff-bar-live'"), 'غاب test:handoff-bar-live من full-suite.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__handoffLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__handoffLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار شريط التسليم؛ المرحلة: ' + progress);
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
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
    win.showInactive();
    await delay(100);
    const holdProbe = await win.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('satr-preview-panel');
      const openCalls = [];
      const navigateCalls = [];
      const boundsCalls = [];
      panel.shadowRoot.getElementById('pvBox').getBoundingClientRect = () => ({
        left: 20, top: 30, width: 420, height: 360, right: 440, bottom: 390,
      });
      window.satr.previewOpenAgent = async (url) => { openCalls.push(url); return { ok: true }; };
      window.satr.previewNavigateAgent = async (url) => { navigateCalls.push(url); return { error: 'closed' }; };
      window.satr.previewBounds = (...args) => { boundsCalls.push(args); return Promise.resolve({ ok: true }); };
      panel.holdForDialog(true);
      panel.openWith('https://hold-probe.example/path', { agent: true });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const during = boundsCalls.slice();
      const openDuringHold = openCalls.length;
      panel.holdForDialog(false);
      panel.remeasure();
      await new Promise((resolve) => setTimeout(resolve, 120));
      panel.openWith('https://hold-probe.example/reopen', { agent: true });
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { open_during_hold: openDuringHold, open_calls: openCalls.length, bounds_during_hold: during.length,
        bounds_after_release: boundsCalls.length - during.length, navigate_calls: navigateCalls.length };
    })()`, true);
    win.hide();
    console.log('OBS078_FILTER_C=' + JSON.stringify(holdProbe));
    assert.strictEqual(holdProbe.open_during_hold, 1,
      'holdForDialog منع طلب إنشاء العرض بدلاً من حجب مستطيله فقط.');
    assert.strictEqual(holdProbe.bounds_during_hold, 0,
      'holdForDialog سرّب مستطيل العرض أثناء الحوار.');
    assert(holdProbe.bounds_after_release > 0,
      'رفع holdForDialog لم يُعد إبلاغ مستطيل العرض.');
    assert.strictEqual(holdProbe.navigate_calls, 1,
      'فحص OBS-078 لم يمرّ بحالة started القديمة قبل إعادة الفتح.');
    assert.strictEqual(holdProbe.open_calls, 2,
      'حالة started القديمة لم تتراجع من navigate:closed إلى إنشاء عرض جديد.');
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار شريط التسليم داخل الصفحة.');
    assert.deepStrictEqual(result.calls, [
      { id: 'ho_live_done', done: true },
      { id: 'ho_live_cancel', done: false },
      { id: 'ho_live_step', done: true },
    ]);
    assert.deepStrictEqual(result.secretCalls, [{ id: 'secret_0123456789abcdef0123456789abcdef', done: true }]);
    assert.strictEqual(result.stopCalls, 1);
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار شريط التسليم.');
    console.log('handoff-bar-live: نجح — التسليم الكامل/المرحلي، طلب السر، أثر المهمة، وإيقافها؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('handoff-bar-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
