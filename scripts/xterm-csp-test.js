/**
 * Smoke test حقيقي لـxterm داخل Chromium مع CSP المطابقة لسياسة «سطر».
 * يختبر السلوك وقت التشغيل لأن update-csp لا يستطيع رؤية عناصر <style> الديناميكية.
 */
const assert = require('assert');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__xtermCspResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__xtermCspProgress || "unknown"', true);
  throw new Error('انتهت مهلة smoke test قبل اكتمال اختبار xterm؛ المرحلة: ' + progress);
}

async function main() {
  await app.whenReady();
  const cspConsoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (_event, _level, message) => {
    if (/securitypolicyviolation|content security policy|refused to apply inline style/i.test(String(message))) {
      cspConsoleErrors.push(String(message));
    }
  });

  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'xterm-csp.html'));
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل smoke test في الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء تشغيل xterm.');
    assert.deepStrictEqual(cspConsoleErrors, [], 'ظهرت رسالة CSP في console أثناء تشغيل xterm.');
    assert(result.checks.includes('multiple-terminals'));
    assert(result.checks.includes('dispose-reopen'));
    console.log('xterm-csp: نجح — عدة طرفيات، resize، cursor blink، ANSI، scrollback، الثيمان، dispose/reopen؛ صفر CSP violations.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('xterm-csp:', error && error.stack ? error.stack : error);
  app.exit(1);
});
