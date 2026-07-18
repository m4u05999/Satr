/**
 * اختبار حي لاتجاه المحتوى المختلط في المحادثة داخل Chromium الفعلي (دفعة RTL —
 * لقطات مالك 2026-07-18): الحسم الإحصائي الصريح بدل «أول حرف قوي» الذي كان يكسر
 * الفقرات العربية البادئة برموز لاتينية. يشغّل مكوّن chat الإنتاجي تحت CSP صارم.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'chat-rtl.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertStaticContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const chatSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'chat.js'), 'utf8');
  const baseCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'base.css'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
  assert(!/\sstyle\s*=|\sonclick\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  assert(chatSource.includes('function textDir('),
    'يجب أن يملك chat.js دالة الحسم الإحصائي textDir.');
  assert(!/\.md p \{[^}]*plaintext/.test(baseCss) && !/\.msg\.user \.bubble \{[^}]*plaintext[^}]*\}/s.test(baseCss.replace(/\/\*[\s\S]*?\*\//g, '')),
    'يجب ألا تعود plaintext إلى فقرات .md أو فقاعة المستخدم (dir الصريح يتولى).');
  assert.strictEqual(packageJson.scripts['test:chat-rtl'], 'electron scripts/chat-rtl-test.js');
  assert(fullSuite.includes("'test:chat-rtl'"), 'غاب test:chat-rtl من full-suite.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__chatRtlResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة اختبار اتجاه المحادثة.');
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert(result.pass, 'فشل اختبار الاتجاه:\n' + (result.error || '') +
      '\nviolations: ' + JSON.stringify(result.violations || []));
    console.log('chat-rtl: نجح — الحسم الإحصائي للفقرات والقوائم وفقاعة المستخدم؛ الكود LTR؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
