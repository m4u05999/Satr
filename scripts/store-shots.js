#!/usr/bin/env node
'use strict';

/**
 * لقطات Microsoft Store بمقاس 1366×768 — أحد مقاسَي لقطات سطح المكتب اللذين يقبلهما
 * المتجر للقطات سطح المكتب، ولقطات صفحة الهبوط في `site/assets` بمقاسات أخرى
 * (‏1500×1220 و760×1080 …) فلا تصلح.
 *
 * يعيد استخدام fixtures `site-shots-*` نفسها — أي **مكوّنات الواجهة الإنتاجية**
 * بمحتوى عربي مجهّز — لكن داخل نافذة بمقاس المتجر، فتخرج اللقطة كما يراها مستخدم
 * على شاشة عريضة لا كقصاصة مقصوصة. يُشغَّل يدوياً:
 *   npx electron scripts/store-shots.js
 * والناتج في `dist/store-shots/` (خارج Git — لقطات ترفع يدوياً إلى Partner Center).
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'store-shots');
const WIDTH = 1366;
const HEIGHT = 768;
const TIMEOUT_MS = 30000;

// profile محلي يمنع تصادم cache مع site-shots أو نسخة سطر العاملة
app.setPath('userData', path.join(ROOT, 'dist', '.store-shots-profile'));

const SHOTS = [
  { fixture: 'site-shots.html', out: '01-chat.png', query: { variant: 'diff' } },
  { fixture: 'site-shots.html', out: '02-tasks.png', query: { variant: 'ledger' } },
  { fixture: 'site-shots-preview.html', out: '03-preview.png' },
  { fixture: 'site-shots-term.html', out: '04-terminal.png' },
  { fixture: 'site-shots-ops.html', out: '05-ops.png' },
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(
      'window.__shotsError ? { error: window.__shotsError } : { ready: !!window.__shotsReady }', true);
    if (state.error) throw new Error('fixture error: ' + state.error);
    if (state.ready) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تجهيز اللقطة.');
}

async function capture(win, shot) {
  await win.loadFile(path.join(__dirname, 'fixtures', shot.fixture), { query: shot.query || {} });
  await waitReady(win);
  await delay(300); // استقرار الرسم والخطوط

  let image = await win.webContents.capturePage();
  if (image.isEmpty()) {
    // احتياط مثبّت في site-shots.js: بعض البيئات لا ترسم offscreen
    win.setPosition(-4000, -4000);
    win.show();
    await delay(600);
    image = await win.webContents.capturePage();
  }
  if (image.isEmpty()) throw new Error('capturePage أعادت صورة فارغة: ' + shot.out);

  const size = image.getSize();
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    // المتجر يرفض أي مقاس آخر؛ نفشل صراحةً بدل رفع لقطة تُردّ
    throw new Error(`مقاس غير مقبول لـ${shot.out}: ${size.width}x${size.height} (المطلوب ${WIDTH}x${HEIGHT})`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, shot.out);
  fs.writeFileSync(file, image.toPNG());
  console.log('✓', shot.out, size.width + 'x' + size.height, Math.round(fs.statSync(file).size / 1024) + 'KB');
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    // بدونها تُحسب الأبعاد شاملةً الإطار فتخرج اللقطة 1920×1040 ويرفضها المتجر
    useContentSize: true,
    frame: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    for (const shot of SHOTS) await capture(win, shot);
    console.log('store-shots: الناتج في dist/store-shots/');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('store-shots:', error && error.stack ? error.stack : error);
  app.exit(1);
});
