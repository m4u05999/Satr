#!/usr/bin/env electron
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');

// أصول اختبار مولّدة محلياً مرة واحدة من lavfi؛ البصمة تمنع تمرير ملف فارغ أو متغيّر للمصيّر.
const FIXTURE_CLIPS = [
  {
    query: 'first',
    name: 'promo-studio-clip-one.mp4',
    bytes: 2713,
    sha256: '04503d41611a1415e3488daa5087480f0b56ecfbc7db87981e68ad4cf989a078',
  },
  {
    query: 'second',
    name: 'promo-studio-clip-two.mp4',
    bytes: 2712,
    sha256: 'df7e2ab4eb13b420dc088bc7ca9b78de8eadc783d7b27a1d0674136d7524130a',
  },
];

function verifiedClipUrls() {
  return Object.fromEntries(FIXTURE_CLIPS.map((fixture) => {
    const fixturePath = path.join(__dirname, 'fixtures', fixture.name);
    const bytes = fs.readFileSync(fixturePath);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== fixture.bytes || sha256 !== fixture.sha256) {
      throw new Error('fixture_video_invalid:' + fixture.name + ':bytes=' + bytes.length + ':sha256=' + sha256);
    }
    return [fixture.query, pathToFileURL(fixturePath).href];
  }));
}

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-studio-'));
  const musicPath = path.join(tempDir, 'tone.wav');
  let win = null;
  try {
    const clipUrls = verifiedClipUrls();
    fs.writeFileSync(musicPath, wavBuffer());
    win = new BrowserWindow({
      show: true, width: 1100, height: 760,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.session.on('will-download', (event) => event.preventDefault());
    await win.loadFile(path.join(__dirname, 'fixtures', 'promo-studio-live.html'), {
      query: { music: pathToFileURL(musicPath).href, ...clipUrls },
    });
    const result = await win.webContents.executeJavaScript(`Promise.race([
      window.__promoStudioReady.catch((error) => {
        throw new Error(error.message + ':' + JSON.stringify(window.__fixtureClipInfo));
      }),
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
    console.log('promo-studio-live: قص وملاءمة وتكرار وعنوان RTL ومزج صوتي + MediaRecorder = '
      + result.bytes + ' bytes (' + result.filename.split('.').pop() + ')');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('promo-studio-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
