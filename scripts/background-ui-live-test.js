'use strict';

const assert = require('assert');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const fixture = path.join(__dirname, 'fixtures', 'background-ui-live.html');
const timeoutMs = 30000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) errors.push(String(message));
  });
  try {
    await win.loadFile(fixture);
    const deadline = Date.now() + timeoutMs;
    let result = null;
    while (Date.now() < deadline && !result) {
      result = await win.webContents.executeJavaScript('window.__backgroundUiResult || null', true);
      if (!result) await delay(50);
    }
    assert(result, 'انتهت مهلة اختبار واجهة المهام.');
    assert.strictEqual(result.pass, true, result.error || 'فشل fixture');
    assert.deepStrictEqual(result.violations, [], 'رُصد خرق CSP');
    assert.deepStrictEqual(errors, [], 'ظهرت أخطاء console');
    console.log('background-ui-live: نجح — تبويب 🛠، chip إظهار/إيقاف، وعدّاد الأذونات.');
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

main().then(() => app.quit()).catch((error) => { console.error(error.stack || error); app.exit(1); });
