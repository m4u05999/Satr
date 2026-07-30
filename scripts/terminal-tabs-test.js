/**
 * اختبار حي لتسمية تبويبات الطرفية داخل Chromium مع CSP الفعلية والمكوّن الحقيقي.
 */
const assert = require('assert');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-tabs.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__terminalTabsResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__terminalTabsProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار تبويبات الطرفية؛ المرحلة: ' + progress);
}

async function main() {
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
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
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار تبويبات الطرفية داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء اختبار التبويبات.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار التبويبات.');
    for (const check of [
      'derived-shell-name', 'keyboard-tab', 'osc-sanitized', 'osc-truncated', 'title-throttled',
      'osc-exe-path-shortened',
      'keyboard-rename', 'manual-priority', 'isolated-names', 'stable-switch-restart-exit',
      'password-toggle', 'isolated-input-mask', 'line-mode-unchanged',
      'model-tab-distinct', 'session-only', 'zero-csp-violations',
    ]) assert(result.checks.includes(check), 'غاب فحص تبويبات الطرفية: ' + check);
    console.log('terminal-tabs: نجح — الأسماء والعزل وإخفاء الإدخال لكل تبويب وline-mode وتبويب النموذج؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('terminal-tabs:', error && error.stack ? error.stack : error);
  app.exit(1);
});
