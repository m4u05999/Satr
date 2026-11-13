#!/usr/bin/env electron
'use strict';

/**
 * اختبار حي للكاميرا الذكية (الدفعة 2 من docs/PROMO-DIRECTOR-PLAN.md): بكسلات renderFrame
 * مع الزوم والمؤشر الاصطناعي، وواجهة صف الكاميرا في الاستوديو.
 *
 * التشغيل: npx electron scripts/promo-camera-live-test.js
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
process.on('uncaughtException', (error) => finish(1, 'promo-camera-live: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-camera-live: ' + (error && error.stack || error)));
setTimeout(() => finish(1, 'promo-camera-live: timeout_60s'), 60000).unref();

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-camera.html'));
  const report = await win.webContents.executeJavaScript(
    'window.__promoCamera.catch(function(e){return {ok:false,pixelFailures:[String(e&&e.stack||e)],uiFailures:[]};})', true);
  if (!win.isDestroyed()) win.destroy();
  if (!report || !report.ok) {
    finish(1, 'promo-camera-live: FAIL — ' + JSON.stringify(report, null, 1));
    return;
  }
  finish(0, 'promo-camera-live: ok — بكسلات الزوم والمؤشر مطابقة، وواجهة الاستوديو (اقتراح، تحديد، سحب، حذف، قصّ خمول) تعمل.');
}

main().catch((error) => finish(1, 'promo-camera-live: ' + (error && error.stack || error)));
