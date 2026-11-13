#!/usr/bin/env electron
'use strict';

/**
 * الحارس المرجعي لإطار الإعلان (الدفعة 1 من docs/PROMO-DIRECTOR-PLAN.md).
 * يثبت أن renderFrame حتمية، وأن مظهر مشاهد v1 يطابق الرسم القديم بكسلاً ببكسل.
 *
 * التشغيل: npx electron scripts/promo-golden-live-test.js
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
process.on('uncaughtException', (error) => finish(1, 'promo-golden-live: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-golden-live: ' + (error && error.stack || error)));
setTimeout(() => finish(1, 'promo-golden-live: timeout_60s'), 60000).unref();

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-golden.html'));
  const report = await win.webContents.executeJavaScript(
    'window.__promoGolden.catch(function(e){return {ok:false,cases:0,failures:[String(e&&e.stack||e)]};})', true);
  if (!win.isDestroyed()) win.destroy();
  if (!report || !report.ok || report.cases !== 24) {
    finish(1, 'promo-golden-live: FAIL — ' + JSON.stringify(report));
    return;
  }
  finish(0, 'promo-golden-live: ok — ' + report.cases + ' حالة (3 مقاسات × 8 أزمنة)، حتمية ومطابقة لمظهر v1، الخط محمَّل=' + report.font_loaded);
}

main().catch((error) => finish(1, 'promo-golden-live: ' + (error && error.stack || error)));
