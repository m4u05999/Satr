#!/usr/bin/env electron
'use strict';

/**
 * اختبار حيّ تحت CSP لمعاينة استوديو البرومو.
 *
 * التشغيل: npx electron scripts/promo-studio-preview-test.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

async function main() {
  await app.whenReady();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-preview-test-'));
  app.setPath('userData', userData);
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.session.on('will-download', (event) => event.preventDefault());
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-studio-preview.html'));
  const result = await win.webContents.executeJavaScript(`Promise.race([
    window.__promoStudioPreviewReady.catch((error) => { throw new Error(error.message + ':' + window.__promoStudioPreviewStep); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('preview_timeout:' + window.__promoStudioPreviewStep)), 15000))
  ])`, true);
  if (!result || !result.ok) throw new Error('preview_test_failed: ' + JSON.stringify(result));
  if (!win.isDestroyed()) win.destroy();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  console.log('promo-studio-preview: معاينة + استيراد + مشروع تحت CSP = ' + JSON.stringify(result));
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('promo-studio-preview:', error && error.stack ? error.stack : error);
  app.exit(1);
});
