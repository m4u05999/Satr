#!/usr/bin/env electron
'use strict';

/**
 * اختبار العضّة العربي (الدفعة 3 من docs/PROMO-DIRECTOR-PLAN.md، §6.2 — إلزامي).
 * يرسم العناوين في ثلاث لحظات (أول كلمة، المنتصف، الاكتمال)، ويتحقق آلياً من الترتيب البصري
 * للنص المختلط ومن المساحة الآمنة ومن حارس التطابق، ويحفظ الصور في dist/promo-bite/ لعين المالك.
 *
 * التشغيل: npx electron scripts/promo-arabic-bite-test.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const outDir = path.join(__dirname, '..', 'dist', 'promo-bite');
let finished = false;
function finish(code, line) {
  if (finished) return;
  finished = true;
  (code ? console.error : console.log)(line);
  app.exit(code);
}
process.on('uncaughtException', (error) => finish(1, 'promo-arabic-bite: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-arabic-bite: ' + (error && error.stack || error)));
setTimeout(() => finish(1, 'promo-arabic-bite: timeout_90s'), 90000).unref();

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-bite.html'));
  const report = await win.webContents.executeJavaScript('window.__promoBite', true);
  if (!win.isDestroyed()) win.destroy();
  let saved = 0;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const image of report.images || []) {
      if (!/^[0-9a-z-]+\.png$/.test(image.name)) continue;
      fs.writeFileSync(path.join(outDir, image.name), Buffer.from(String(image.data).split(',')[1], 'base64'));
      saved += 1;
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ok: report.ok, failures: report.failures, titles: report.summary }, null, 2) + '\n', 'utf8');
  } catch {}
  if (!report || !report.ok) {
    finish(1, 'promo-arabic-bite: FAIL — ' + JSON.stringify(report && report.failures, null, 1));
    return;
  }
  finish(0, 'promo-arabic-bite: ok — ' + report.summary.length + ' عناوين × 3 لحظات، الترتيب البصري والمساحة الآمنة وحارس التطابق سليمة؛ ' + saved + ' صورة في dist/promo-bite/');
}

main().catch((error) => finish(1, 'promo-arabic-bite: ' + (error && error.stack || error)));
