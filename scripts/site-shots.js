#!/usr/bin/env node
'use strict';

/**
 * توليد لقطات واجهة «سطر» الحقيقية لصفحة الهبوط — نمط الاختبار الحي المثبّت:
 * ‏BrowserWindow يحمّل fixture يشغّل مكوّنات الواجهة الإنتاجية بمحتوى عربي مجهّز،
 * ثم capturePage إلى site/assets/. يُشغَّل يدوياً: npx electron scripts/site-shots.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'site', 'assets');
const TIMEOUT_MS = 30000;

const SHOTS = [
  { fixture: 'site-shots.html', out: 'app-tasks.png', width: 1500, height: 1220, query: { variant: 'ledger' } },
  { fixture: 'site-shots.html', out: 'app-chat.png', width: 1500, height: 1220, query: { variant: 'diff' } },
  { fixture: 'site-shots-term.html', out: 'app-term.png', width: 1500, height: 440 },
  { fixture: 'site-shots-ops.html', out: 'app-ops.png', width: 760, height: 700 },
  { fixture: 'site-shots-preview.html', out: 'app-preview.png', width: 1280, height: 860 },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(
      'window.__shotsError ? { error: window.__shotsError } : { ready: !!window.__shotsReady }', true);
    if (state.error) throw new Error('fixture error: ' + state.error);
    if (state.ready) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تجهيز لقطة الموقع.');
}

// نافذة واحدة يُعاد تحميلها لكل لقطة — إنشاء نافذة ثانية offscreen+sandbox
// يفشل حتمياً بـ ERR_FAILED في هذه البيئة (ملاحظة مثبّتة بالتجربة)
async function capture(win, shot) {
  win.setSize(shot.width, shot.height);
  await win.loadFile(path.join(__dirname, 'fixtures', shot.fixture), { query: shot.query || {} });
  await waitReady(win);
  await delay(250); // استقرار الرسم النهائي
  let image = await win.webContents.capturePage();
  if (image.isEmpty()) {
    // احتياط: بعض البيئات لا ترسم offscreen — نظهر النافذة خارج الشاشة لحظة
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
    width: 1500,
    height: 1220,
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
  console.error('site-shots:', error && error.stack ? error.stack : error);
  app.exit(1);
});
