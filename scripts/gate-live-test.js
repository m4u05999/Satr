#!/usr/bin/env node
'use strict';

/**
 * اختبار Chromium حيّ لبوابة أول التشغيل بعد عقد الجاهزية بحسب المحرك
 * (أسبوع خطة العصف — البند الأول، قرار 2026-08-23).
 *
 * لماذا حيّ ولا يكفي اختبار readiness النقي؟ لأن الحاجز المعتمد يقول «البوابة تفتح
 * لمن يملك Codex أو Kimi» — وهذا سلوك مكوّن، لا حساب دالة. الدرس المثبّت عندنا أن
 * حارساً يختبر منطقاً موازياً بدل منطق الطرف نفسه يبقى أخضر بينما الميزة معطّلة.
 * لذلك يشغّل هذا الاختبار <satr-gate> الإنتاجي تحت CSP الفعلية ويضغط «أعد الفحص»
 * كما يفعل المستخدم، ويتحقق من الحجب/الفتح والإرشاد المعروض فعلاً.
 *
 * ويثبت أيضاً عقد main.js الساكن (نمط assertStaticContract): أن preflight يسأل
 * مسبارَي Codex وKimi ويعيد لقطة الجاهزية، وأن مفاتيح المحاكاة الثلاثة موجودة.
 *
 * التشغيل (سكربت npm ‏test:gate-live): electron scripts/gate-live-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TIMEOUT_MS = 30000;
const CHECKS = [
  'codex-only-opens', 'claude-only-opens', 'kimi-only-opens',
  'none-installed-blocks', 'three-engines-guided', 'logged-out-guides-login',
  'fail-open-unknown-auth', 'legacy-preflight-fallback', 'null-preflight-blocks',
  'recheck-button-drives-scan',
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// عقد main.js الساكن: البوابة لا تعمل إن لم يجمع preflight حالات المحركات الثلاثة.
function assertPreflightContract() {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('satr:preflight'");
  assert(start !== -1, 'غاب معالج satr:preflight من main.js.');
  const block = main.slice(start, start + 5000);
  for (const needle of [
    'readiness.deriveReadiness', 'codex.resolveCodexBin(true)', 'codex.accountStatus()',
    'kimi.resolveKimiBin(true)', 'kimi.authStatus()',
    "forced('CLAUDE')", "forced('CODEX')", "forced('KIMI')",
    'readyEngines', 'preferred',
  ]) assert(block.includes(needle), 'نقص في معالج preflight بـ main.js: ' + needle);
  // العقد القديم يجب أن يبقى — كل مستهلك قائم يقرأ claude/node/npm كما كان
  assert(/return\s*\{\s*\n?\s*claude,\s*node,\s*npm,/.test(block), 'عقد preflight القديم (claude/node/npm) تغيّر.');
  assert(main.includes("const readiness = require('./readiness')"), 'readiness.js غير مربوط في main.js.');
}

function assertFixtureContract() {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'gate-live.html'), 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture البوابة لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/gate.js'), 'fixture البوابة لا يستورد المكوّن الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture البوابة يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture البوابة يحوي style مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__gateLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__gateLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار البوابة الحي؛ المرحلة: ' + progress);
}

async function main() {
  assertPreflightContract();
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'gate-live.html'));
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true,
      'فشل اختبار البوابة داخل الصفحة (' + (result.progress || '?') + '): ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation في البوابة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار البوابة.');
    for (const check of CHECKS) assert(result.checks.includes(check), 'غاب فحص البوابة الحي: ' + check);
    console.log('gate-live: نجح — البوابة تفتح على Codex أو Kimi أو Claude، وتحجب بلا محرك مع إرشاد الثلاثة، '
      + 'وتُرشد لتسجيل الدخول للمثبّت، وتتراجع لعقد preflight القديم؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('gate-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
