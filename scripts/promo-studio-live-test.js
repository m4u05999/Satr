#!/usr/bin/env electron
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');

function wavBuffer() {
  const sampleRate = 8000; const samples = 4000; const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.sin(index / 12) * 5000, 44 + index * 2);
  return buffer;
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: true, width: 1100, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const musicPath = path.join(os.tmpdir(), 'satr-promo-studio-tone-' + process.pid + '.wav');
  const firstPath = path.join(os.tmpdir(), 'satr-promo-studio-first-' + process.pid + '.mp4');
  const secondPath = path.join(os.tmpdir(), 'satr-promo-studio-second-' + process.pid + '.mp4');
  fs.writeFileSync(musicPath, wavBuffer());
  win.webContents.session.on('will-download', (event) => event.preventDefault());
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-studio-live.html'), {
    query: { music: pathToFileURL(musicPath).href },
  });
  const clips = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now(); const timer = setInterval(() => {
      if (window.__promoStudioClips) { clearInterval(timer); resolve(window.__promoStudioClips); }
      else if (Date.now() - started > 10000) { clearInterval(timer); reject(new Error('clip_generation_timeout')); }
    }, 25);
  })`, true);
  fs.writeFileSync(firstPath, Buffer.from(clips.first, 'base64'));
  fs.writeFileSync(secondPath, Buffer.from(clips.second, 'base64'));
  await win.webContents.executeJavaScript(`window.__setLocalClips(
    ${JSON.stringify(pathToFileURL(firstPath).href)}, ${JSON.stringify(pathToFileURL(secondPath).href)})`, true);
  const result = await win.webContents.executeJavaScript(`Promise.race([
    window.__promoStudioReady.catch((error) => { throw new Error(error.message + ':' + JSON.stringify(window.__clipInfo)); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('live_timeout:' + window.__promoStudioStep)), 20000))
  ])`, true);
  if (!result || result.scenes_rendered !== 3 || result.bytes < 1024 || result.caption_direction !== 'rtl'
      || result.captions_rendered < 1 || result.audio_sources < 1 || !result.reordered
      || result.editedCaption !== 'عنوان عربي مُحرّر' || result.editedDuration !== 650
      || !result.musicChanged || !result.duplicated || !result.advancedControls
      || !result.totalLabel.includes('المدة الإجمالية') || result.trimmed_scenes < 1
      || result.contained_scenes < 1 || result.mixed_audio_sources < 2 || result.captureStarts !== 1
      || !/media-src 'self' blob:/.test(result.csp) || !/^satr-promo-final-.*\.(mp4|webm)$/.test(result.filename)) {
    throw new Error('فشل اختبار الاستوديو: ' + JSON.stringify(result));
  }
  if (!win.isDestroyed()) win.destroy();
  for (const candidate of [musicPath, firstPath, secondPath]) { try { fs.unlinkSync(candidate); } catch (error) {} }
  console.log('promo-studio-live: قص وملاءمة وتكرار وعنوان RTL ومزج صوتي + MediaRecorder = '
    + result.bytes + ' bytes (' + result.filename.split('.').pop() + ')');
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('promo-studio-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
