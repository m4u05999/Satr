/**
 * اختبار Chromium حيّ لبطاقة حالة جولة TestSprite (العقد المجمّد v1 §4):
 * يشغّل المكوّن الحقيقي وورق التصميم الحقيقي تحت CSP مع جسر ضيق مزيّف، ويثبت
 * الظهور والحالات الست حرفياً والعدادات والنبضة المتجددة وزر الإيقاف وبقاء
 * البطاقة عبر الجلسات والإغلاق اليدوي للنهائي.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'testsprite-job-live.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertFixtureContract() {
  const source = fs.readFileSync(FIXTURE, 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/testsprite-job.js'), 'fixture لا يستورد مكوّن بطاقة TestSprite الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture يحوي style مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__tsJobLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__tsJobLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار بطاقة TestSprite الحي؛ المرحلة: ' + progress);
}

async function main() {
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 850,
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
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار بطاقة TestSprite داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء الاختبار.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء الاختبار.');
    for (const check of [
      'boot-guard-missing-channel', 'boot-inactive-hidden', 'boot-active-snapshot',
      'appears-on-active', 'six-states-labels', 'failure-code-shown',
      'counters-rendered', 'heartbeat-ticks', 'stall-note',
      'stop-sends-cancel', 'survives-new-session', 'final-persists',
      'manual-close', 'zero-csp-violations',
    ]) assert(result.checks.includes(check), 'غاب فحص بطاقة TestSprite الحي: ' + check);
    assert.deepStrictEqual(result.calls.cancel, ['tsjob-live-1'], 'لم يُبث طلب الإلغاء بمعرّف الجولة.');
    console.log('testsprite-job-live: نجح — 14 فحصاً (إقلاع محروس + ظهور + 6 حالات حرفية + عدادات/محجوبة + نبضة متجددة + لا نشاط مرصود + إيقاف بـconfirm + بقاء عبر الجلسة + نهائي يُغلق يدوياً)؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('testsprite-job-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
