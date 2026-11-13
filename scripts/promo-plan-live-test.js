#!/usr/bin/env electron
'use strict';

/**
 * اختبار حي لبطاقة سيناريو الإعلان (الدفعة 8 من docs/PROMO-DIRECTOR-PLAN.md): الفتح باقتراح الوكيل،
 * التعديل، حدود المدة، الاعتماد والرفض، ثم مسار اقتراح الوكيل في الاستوديو (كاميرا تلقائية وتغبيش
 * افتراضي ولا اعتماد).
 *
 * التشغيل: npx electron scripts/promo-plan-live-test.js
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
process.on('uncaughtException', (error) => finish(1, 'promo-plan-live: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-plan-live: ' + (error && error.stack || error)));
setTimeout(() => finish(1, 'promo-plan-live: timeout_60s'), 60000).unref();

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-plan.html'));
  const report = await win.webContents.executeJavaScript(
    'window.__promoPlan.catch(function(e){return {ok:false,failures:[String(e&&e.stack||e)]};})', true);
  if (!win.isDestroyed()) win.destroy();
  if (!report || !report.ok) {
    finish(1, 'promo-plan-live: FAIL — ' + JSON.stringify(report, null, 1));
    return;
  }
  finish(0, 'promo-plan-live: ok — بطاقة السيناريو (فتح، تعديل، حد 180 ثانية، اعتماد، رفض) ومسار اقتراح الوكيل في الاستوديو (كاميرا تلقائية، تغبيش افتراضي، بلا اعتماد) يعملان.');
}

main().catch((error) => finish(1, 'promo-plan-live: ' + (error && error.stack || error)));
