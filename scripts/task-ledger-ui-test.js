/**
 * اختبار حي لبطاقة سجل المهام في مكوّن المحادثة الإنتاجي تحت CSP صارم وبلا preload.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'task-ledger-ui.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertStaticContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'task-ledger-ui-page.js'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'chat.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');

  assert(fixture.includes("script-src 'self'") && fixture.includes("style-src 'self'"),
    'يجب أن يعمل fixture تحت CSP صارم.');
  assert(!/\sstyle\s*=|\sonclick\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  assert(!/<style\b/i.test(fixture), 'يحتوي fixture كتلة style مضمّنة.');
  const scripts = [...fixture.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length === 2 && scripts.every((match) => /\bsrc\s*=/.test(match[1]) && !match[2].trim()),
    'يجب أن تكون كل سكربتات fixture خارجية.');
  assert(fixture.includes('<satr-chat></satr-chat>')
    && fixture.includes('src="../../src/ui/components/chat.js"'),
  'يجب أن يحمّل fixture مكوّن satr-chat الإنتاجي في light DOM.');
  assert(chat.includes('this.showTaskLedger = showTaskLedger;')
    && chat.includes('this.clearTaskLedger = clearTaskLedger;'),
  'اختفت واجهتا سجل المهام العامتان من المكوّن.');
  assert(page.includes("new CustomEvent('task-action')") === false,
    'يجب ألا يحاكي fixture حدث task-action بدلاً من المكوّن الإنتاجي.');
  assert.strictEqual(packageJson.scripts['test:task-ledger-ui'], 'electron scripts/task-ledger-ui-test.js');
  assert(fullSuite.includes("'test:task-ledger-ui'"), 'غاب test:task-ledger-ui من full-suite.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__taskLedgerUiResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة اختبار واجهة سجل المهام.');
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
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
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار سجل المهام داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation.');
    assert.deepStrictEqual(result.actions, [
      { action: 'pause', engine: 'sdk', sessionId: 'session-a' },
      { action: 'resume', engine: 'sdk', sessionId: 'session-a' },
    ]);
    assert.deepStrictEqual(result.checks, [
      'three-task-threshold',
      'progress-and-state',
      'all-statuses',
      'task-metadata',
      'collapse-persistence',
      'higher-revision-rebuild',
      'pause-resume-complete',
      'session-replacement',
      'public-clear',
      'zero-csp-violations',
    ]);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار سجل المهام.');
    console.log('task-ledger-ui: نجح — العتبة والتقدم والحالات والبيانات والطي والأفعال وتبديل الجلسة؛ صفر CSP/console.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('task-ledger-ui:', error && error.stack ? error.stack : error);
  app.exit(1);
});
