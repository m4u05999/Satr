#!/usr/bin/env electron
'use strict';

/**
 * اختبار حي للإخراج البصري (الدفعة 7 من docs/PROMO-DIRECTOR-PLAN.md): بكسلات الخلفيات وإطارات
 * الأجهزة والظل والإمالة (WebGL2) والتغبيش وانتقالات الدخول، ثم صف المسرح في الاستوديو.
 *
 * التشغيل: npx electron scripts/promo-stage-live-test.js
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

let finished = false;
function finish(code, line) {
  if (finished) return;
  finished = true;
  (code ? console.error : console.log)(line);
  app.exit(code);
}
// خطأ إقلاع في العملية الرئيسية يعلّق Electron بحوار؛ نحوّله إلى خروج.
process.on('uncaughtException', (error) => finish(1, 'promo-stage-live: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-stage-live: ' + (error && error.stack || error)));
setTimeout(() => finish(1, 'promo-stage-live: timeout_60s'), 60000).unref();

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-stage.html'));
  const report = await win.webContents.executeJavaScript(
    'window.__promoStage.catch(function(e){return {ok:false,pixelFailures:[String(e&&e.stack||e)],uiFailures:[]};})', true);
  if (!win.isDestroyed()) win.destroy();
  if (!report || !report.ok) {
    finish(1, 'promo-stage-live: FAIL — ' + JSON.stringify(report, null, 1));
    return;
  }
  finish(0, 'promo-stage-live: ok — الخلفيات والإطارات الأربعة والظل والتغبيش وانتقالات الدخول مطابقة بكسلياً، WebGL2=' + report.gl + (report.gl ? ' (الإمالة مُختبَرة)' : ' (الإمالة غير مُختبَرة: بديل 2D)') + '، وصف المسرح في الاستوديو يعمل.');
}

main().catch((error) => finish(1, 'promo-stage-live: ' + (error && error.stack || error)));
