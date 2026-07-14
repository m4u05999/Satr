// اختبار Chromium حيّ لمكوّن أسئلة AskUserQuestion: يشغّل المكوّن الحقيقي وورق التصميم
// الحقيقي، ويثبت العرض والاختيار (أحادي/متعدد) وجمع المؤشرات وأمان preview وصفر CSP.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'question-dialog-live.html');
const TIMEOUT_MS = 30000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function assertFixtureContract() {
  const source = fs.readFileSync(FIXTURE, 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/question-dialog.js'), 'fixture لا يستورد المكوّن الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture يحوي script مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__questionLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__questionLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار مكوّن الأسئلة؛ المرحلة: ' + progress);
}

async function main() {
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار المكوّن داخل الصفحة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء الاختبار.');
    console.log('question-dialog-live: نجح — عرض، اختيار، فشل/إلغاء، إبطال الرد القديم، أمان preview؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('question-dialog-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
