/**
 * اختبار حي لقائمة «/» المنظّمة داخل Chromium الفعلي، بلا preload أو IPC جديد.
 * يحقن fixture عقد listCommands/listSkills ويشغّل مكوّن composer الإنتاجي تحت CSP صارم.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'slash-menu.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertStaticContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
  assert(fixture.includes("script-src 'self'") && !/<(?:script|style)(?:\s[^>]*)?>\s*[^<\s]/i.test(fixture),
    'يجب أن يبقى fixture بلا script/style مضمّن تحت CSP صارم.');
  assert(!/\sstyle\s*=|\sonclick\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  const changed = appSource.indexOf("ev.type === 'system' && ev.subtype === 'commands_changed'");
  const blockGuard = appSource.indexOf('const block = currentBlock', changed);
  assert(changed !== -1 && blockGuard !== -1 && changed < blockGuard,
    'يجب أن يستبدل system/commands_changed الكاش قبل حارس كتلة الرد.');
  assert.strictEqual(packageJson.scripts['test:slash-menu'], 'electron scripts/slash-menu-test.js');
  assert(fullSuite.includes("'test:slash-menu'"), 'غاب test:slash-menu من full-suite.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__slashMenuResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة اختبار قائمة /.');
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
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
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار قائمة / داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation.');
    assert.deepStrictEqual(result.checks, [
      'group-order',
      'separators-skip-arrows',
      'enter-tab-insertion',
      'builtin-localization',
      'skill-descriptions',
      'hide-user-skills',
      'commands-changed-replaces-cache',
      'zero-csp-violations',
    ]);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار قائمة /.');
    console.log('slash-menu: نجح — تجميع وتعريب وتنقّل وإدراج وإخفاء واستبدال كاش؛ صفر CSP violations.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('slash-menu:', error && error.stack ? error.stack : error);
  app.exit(1);
});
