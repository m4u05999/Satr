#!/usr/bin/env node
'use strict';

/**
 * اختبار Chromium حيّ للوحة معرض التوليدات 🖼 (الجولة 8): يشغّل المكوّن الحقيقي
 * وورق التصميم الحقيقي تحت CSP الفعلية بنمط اللوحات، مع جسر window.satr مزيف
 * يقدّم بيانات fixture (قنوات generationsList/genThumb تُضاف عند الدمج — هذا
 * الاختبار يثبت عقد اللوحة معها، والقائد يتحقق من الوصلة الحية بعد الدمج).
 *
 * يغطي: الفتح والإغلاق، الشبكة بأربع بطاقات (صورتان + فيديو مؤجل + فاشلة)،
 * المصغرات الكسولة عبر genThumb، نسخ البرومبت، حدث gallery-insert بلا إرسال
 * فعلي، العرض المكبر (فتح/Escape/✕)، والحالة الفارغة الإرشادية.
 *
 * التشغيل المباشر (سكربت npm ‏test:gallery يضيفه كودكس عند الدمج):
 *   electron scripts/gallery-live-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'gallery-live.html');
const TIMEOUT_MS = 30000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function assertFixtureContract() {
  const source = fs.readFileSync(FIXTURE, 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/gallery-panel.js'), 'fixture لا يستورد مكوّن المعرض الحقيقي.');
  assert(source.includes('gallery-fixture.js'), 'fixture لا يحمّل بيانات fixture المشتركة.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture يحوي style مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__galleryLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__galleryLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار لوحة المعرض الحي؛ المرحلة: ' + progress);
}

async function main() {
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 1100, height: 850,
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
    assert.strictEqual(result.pass, true,
      'فشل اختبار لوحة المعرض داخل الصفحة (' + (result.progress || '?') + '): ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء الاختبار.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء الاختبار.');
    for (const check of [
      'grid-four-cards', 'lazy-thumbs', 'video-deferred-card', 'failed-card',
      'meta-ltr-prompt-auto', 'copy-prompt', 'insert-event-no-send',
      'lightbox-open-esc-close', 'close-event', 'empty-state',
    ]) assert(result.checks.includes(check), 'غاب فحص لوحة المعرض الحي: ' + check);
    console.log('gallery-live: نجح — شبكة 4 بطاقات (صورتان/فيديو مؤجل/فاشلة)، مصغرات كسولة، نسخ، إدراج بلا إرسال، عرض مكبّر، حالة فارغة؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('gallery-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
