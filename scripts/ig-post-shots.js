#!/usr/bin/env node
'use strict';

/**
 * توليد بوستات إنستقرام لـ«سطر» بخط المشروع نفسه — نمط site-shots.js المثبّت:
 * ‏BrowserWindow offscreen يحمّل promo/instagram/post.html ثم capturePage إلى
 * ‏promo/instagram/out/. يُشغَّل يدوياً: npx electron scripts/ig-post-shots.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'promo', 'instagram', 'post.html');
const OUT_DIR = path.join(ROOT, 'promo', 'instagram', 'out');
const TIMEOUT_MS = 30000;

const SHOTS = [
  { out: 'satr-ig-square.png', width: 1080, height: 1080 },
  { out: 'satr-ig-portrait.png', width: 1080, height: 1350, query: { variant: 'tall' } },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript('!!window.__shotsReady', true);
    if (ready) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تجهيز البوست.');
}

// نافذة واحدة يُعاد تحميلها لكل لقطة (درس site-shots: نافذة offscreen ثانية تفشل ERR_FAILED)
async function capture(win, shot) {
  win.setSize(shot.width, shot.height);
  await win.loadFile(PAGE, { query: shot.query || {} });
  await waitReady(win);
  await delay(300); // استقرار الخط والرسم
  let image = await win.webContents.capturePage();
  if (image.isEmpty()) {
    win.setPosition(-4000, -4000);
    win.show();
    await delay(600);
    image = await win.webContents.capturePage();
  }
  if (image.isEmpty()) throw new Error('capturePage أعادت صورة فارغة: ' + shot.out);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, shot.out);
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  console.log('✓', shot.out, size.width + 'x' + size.height, Math.round(fs.statSync(file).size / 1024) + 'KB');
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1080,
    height: 1080,
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
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('ig-post-shots:', error && error.stack ? error.stack : error);
  app.exit(1);
});
