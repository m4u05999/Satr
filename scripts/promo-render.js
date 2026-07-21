#!/usr/bin/env node
'use strict';

/**
 * مُصيّر مشاهد الـ typography لإعلان «سطر» إلى فيديو 1080p60 نقيّ — بلا تسجيل شاشة يدوي.
 *
 * نمط site-shots المثبّت: BrowserWindow ‏offscreen يحمّل promo/index.html?render=1،
 * لكن بدل لقطة واحدة نقود مشهد GSAP **إطاراً بإطار** (window.__promo.seek(t)) ونلتقط
 * كل إطار PNG، ثم ffmpeg يجمع الإطارات إلى mp4. الزمن يدوي بالكامل (ticker مجمّد) فالناتج
 * حتمي — نفس نمط تجميد الزمن في site:shots.
 *
 * يتطلب: خادم promo (node scripts/promo-serve.js على 4700) + ffmpeg في FFMPEG أو PATH.
 * التشغيل: npx electron scripts/promo-render.js [scene1 scene2 …]  (بلا وسائط = كل المشاهد)
 * الناتج: promo/footage/<NN>-<scene>.mp4
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'promo', 'footage');
const BASE = process.env.PROMO_URL || 'http://127.0.0.1:4700';
const FPS = Number(process.env.PROMO_FPS) || 60;
const W = 1920;
const H = 1080;
const READY_TIMEOUT = 20000;

// ترتيب المشاهد وأرقامها في قائمة المونتاج (promo/EDIT-PLAN.md).
// page: صفحة المصدر (index=مشاهد typography، ui=نماذج الواجهة). scene: معامل ?scene.
const SCENE_FILES = {
  hook:      { file: '01-hook',        page: 'index', scene: 'hook' },
  otlob:     { file: '02-title-otlob', page: 'index', scene: 'otlob' },
  'ui-otlob':{ file: '03-ui-otlob',    page: 'ui',    scene: 'otlob' },
  '3ayen':   { file: '04-title-3ayen', page: 'index', scene: '3ayen' },
  'ui-3ayen':{ file: '05-ui-3ayen',    page: 'ui',    scene: '3ayen' },
  sallem:    { file: '06-title-sallem',page: 'index', scene: 'sallem' },
  'ui-sallem':{ file: '07-ui-sallem',  page: 'ui',    scene: 'sallem' },
  watch:     { file: '08-watch',       page: 'index', scene: 'watch' },
  crescendo: { file: '09-crescendo',   page: 'index', scene: 'crescendo' },
  cta:       { file: '11-cta',         page: 'index', scene: 'cta' },
};

function resolveFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const guess = path.join('D:', 'sater', 'tools', 'ffmpeg.exe');
  if (fs.existsSync(guess)) return guess;
  return 'ffmpeg'; // من PATH
}
const FFMPEG = resolveFfmpeg();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(win) {
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript('!!window.__promoReady', true);
    if (ok) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تجهيز صفحة المشاهد — هل خادم promo يعمل على ' + BASE + '؟');
}

async function renderScene(win, key) {
  const spec = SCENE_FILES[key];
  const label = spec.file;
  const page = spec.page === 'ui' ? '/ui.html' : '/';
  await win.loadURL(BASE + page + '?render=1&scene=' + encodeURIComponent(spec.scene));
  await waitReady(win);
  await win.webContents.executeJavaScript('document.fonts.ready').catch(() => {});
  const duration = await win.webContents.executeJavaScript(
    'window.__promo.build(' + JSON.stringify(spec.scene) + ')', true);
  if (!duration || duration <= 0) throw new Error('مشهد بلا مدة: ' + key);
  const frames = Math.ceil(duration * FPS);
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-' + key + '-'));
  console.log('▶', label, '— ' + duration.toFixed(2) + 'ث × ' + FPS + ' = ' + frames + ' إطار');

  for (let f = 0; f < frames; f++) {
    const t = Math.min(f / FPS, duration);
    await win.webContents.executeJavaScript('window.__promo.seek(' + t + ')', true);
    let img = await win.webContents.capturePage();
    if (img.isEmpty()) { await delay(30); img = await win.webContents.capturePage(); }
    if (img.isEmpty()) throw new Error('لقطة فارغة عند الإطار ' + f + ' من ' + key);
    fs.writeFileSync(path.join(framesDir, 'f' + String(f).padStart(5, '0') + '.png'), img.toPNG());
    if (f % 30 === 0) process.stdout.write('.');
  }
  process.stdout.write('\n');

  // ffmpeg: إطارات PNG → mp4 (H.264، yuv420p للتوافق، بلا صوت)
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, label + '.mp4');
  const args = [
    '-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%05d.png'),
    '-c:v', 'libx264', '-crf', '16', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), out,
  ];
  const r = spawnSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(framesDir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('ffmpeg فشل على ' + key + ' (كود ' + r.status + ')');
  console.log('✓', label + '.mp4', '(' + Math.round(fs.statSync(out).size / 1024) + 'KB)');
}

async function main() {
  const scenes = process.argv.slice(2).filter((a) => SCENE_FILES[a]);
  const list = scenes.length ? scenes : Object.keys(SCENE_FILES);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: W, height: H, frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false, webSecurity: false },
  });
  win.webContents.setFrameRate(FPS);
  try {
    for (const s of list) await renderScene(win, s);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((e) => {
  console.error('promo-render:', e && e.stack ? e.stack : e);
  app.exit(1);
});
