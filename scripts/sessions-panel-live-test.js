#!/usr/bin/env node
'use strict';

/**
 * اختبار Chromium حيّ للوحة الجلسات بعد التجميع بالمشروع (‏OBS-068).
 *
 * لماذا حيّ ولا يكفي فحص ساكن؟ لأن الادعاء سلوك مكوّن لا حساب دالة: «المشروع الحالي
 * مفرود والبقية مطوية»، و«البحث يصل جلسة داخل مجموعة مطوية»، و«الطيّ يُخفي صفوفاً
 * فعلاً». والدرس المثبّت في هذا المستودع أن حارساً يختبر منطقاً موازياً بدل منطق
 * الطرف نفسه يبقى أخضر بينما الميزة معطّلة.
 *
 * التشغيل (سكربت npm ‏test:sessions-panel): electron scripts/sessions-panel-live-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TIMEOUT_MS = 30000;
const CHECKS = [
  'grouped', 'tools-hidden-by-default', 'pinned-and-current-first',
  'current-expanded-others-collapsed', 'collapse-toggles-rows', 'tools-filter-toggles',
  'search-reaches-collapsed', 'chat-grouped-by-provider', 'row-click-resumes',
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// عقد ساكن: السقف رُفع فعلاً، والقشرة تمرّر cwd للوحة (وإلا فلا «مشروع حالي»).
function assertStaticContract() {
  const sessions = fs.readFileSync(path.join(__dirname, '..', 'electron', 'sessions.js'), 'utf8');
  const cap = sessions.match(/const MAX_SESSIONS = (\d+);/);
  assert(cap && Number(cap[1]) >= 500,
    'سقف سرد الجلسات عاد صغيراً (' + (cap && cap[1]) + ') — البتر يعيد عطل «تهت في الجلسات».');
  assert(/HEAD_BYTES = 64 \* 1024/.test(sessions),
    'HEAD_BYTES قُلّل — القياس أعطى 16ك.ب ⇒ 125/156 مقابل 64ك.ب ⇒ 143/156.');

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');
  assert(/sessionsEl\.open\(providersCache, \$\('cwd'\)\.value\.trim\(\)\)/.test(appJs),
    'القشرة لا تمرّر cwd إلى لوحة الجلسات — يسقط تمييز «المشروع الحالي».');

  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'components', 'sessions-panel.js'), 'utf8');
  const toolPath = (panel.match(/^const TOOL_PATH = .*$/m) || [''])[0];
  assert(toolPath && /worktrees/.test(toolPath), 'كشف جلسات الأدوات غائب من اللوحة.');
  // الحدّ المعلن: يُكشف مسار الأداة بيقين (worktrees/Temp) ولا يُخمَّن مجلد مستخدم
  // حقيقي من نمط اسمه مثل `<project>-opus`. والفحص على **التعبير نفسه** لا على الملف
  // كله — أول صياغة كانت تقرأ الملف فأطلقت إنذاراً كاذباً على التعليق الذي يشرح القاعدة.
  assert(!/-opus|_opus|-wt/.test(toolPath),
    'TOOL_PATH يخمّن مجلدات فريق من أنماط أسماء — تلك مجلدات مستخدم حقيقية لا تُكشف بيقين.');
}

function assertFixtureContract() {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'sessions-panel-live.html'), 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture اللوحة لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/sessions-panel.js'), 'fixture اللوحة لا يستورد المكوّن الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture اللوحة يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture اللوحة يحوي style مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__panelResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__panelProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار لوحة الجلسات؛ المرحلة: ' + progress);
}

async function main() {
  assertStaticContract();
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'sessions-panel-live.html'));
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, 'فشل اختبار اللوحة داخل الصفحة: ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation في اللوحة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار اللوحة.');
    for (const check of CHECKS) assert(result.checks.includes(check), 'غاب فحص اللوحة الحي: ' + check);
    console.log('sessions-panel-live: نجح — التجميع بالمشروع، والمثبّتة والمشروع الحالي أولاً، '
      + 'وإخفاء جلسات الأدوات وكشفها، والبحث يصل مجموعة مطوية، والطيّ يُخفي صفوفاً؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('sessions-panel-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
