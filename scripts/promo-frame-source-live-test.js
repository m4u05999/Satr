#!/usr/bin/env electron
'use strict';

/**
 * اختبار حي لمصدر الإطارات والمُغلِّف (الدفعتان 4 و5 من docs/PROMO-DIRECTOR-PLAN.md).
 * فيديو اصطناعي كل إطار فيه يحمل رقمه ⇒ ترميز ⇒ mp4-mux ⇒ source-mp4 + VideoDecoder ⇒ الإطار
 * المعاد هو المطلوب بالضبط. ثم المقطع الحقيقي مقابل عنصر <video>، ثم بديل القفز.
 * يحفظ الملف الاصطناعي في dist/promo-frame-source/ ويفحصه بـffprobe إن وُجد (اختياري).
 *
 * التشغيل: npx electron scripts/promo-frame-source-live-test.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const outDir = path.join(__dirname, '..', 'dist', 'promo-frame-source');
let finished = false;
function finish(code, line) {
  if (finished) return;
  finished = true;
  (code ? console.error : console.log)(line);
  app.exit(code);
}
process.on('uncaughtException', (error) => finish(1, 'promo-frame-source-live: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-frame-source-live: ' + (error && error.stack || error)));
let windowRef = null;
// عند المهلة نسأل الصفحة عن آخر مرحلة بلغتها؛ تعليق غير متزامن يبقى قابلاً للاستجواب.
setTimeout(async () => {
  let stage = 'unknown';
  try { stage = await Promise.race([windowRef.webContents.executeJavaScript('window.__promoFrameSourceStage', true), new Promise((resolve) => setTimeout(() => resolve('renderer_blocked'), 3000))]); } catch {}
  finish(1, 'promo-frame-source-live: timeout_90s عند المرحلة ' + stage);
}, 90000).unref();

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  windowRef = win;
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-frame-source.html'));
  const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'promo-segment-fragmented.mp4')).toString('base64');
  const result = await win.webContents.executeJavaScript(
    'window.__promoFrameSource(' + JSON.stringify(real) + ').catch(function(e){return {ok:false,failures:[String(e&&e.stack||e)],report:{}};})', true);
  if (!win.isDestroyed()) win.destroy();
  if (result.skipped) { finish(0, 'promo-frame-source-live: skipped — ' + result.skipped); return; }
  const aac = !!(result.report.codecs && result.report.codecs.aac_encode);
  let probe = 'ffprobe: غير متاح';
  if (result.sample) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, 'synthetic.mp4');
      fs.writeFileSync(file, Buffer.from(result.sample, 'base64'));
      const run = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,nb_frames,duration', '-of', 'json', file], { encoding: 'utf8', timeout: 15000 });
      if (run.status === 0 && run.stdout) {
        const streams = JSON.parse(run.stdout).streams || [];
        probe = 'ffprobe: ' + streams.map((s) => s.codec_type + '=' + s.codec_name + '/' + s.nb_frames).join(' ');
        const video = streams.find((s) => s.codec_type === 'video'), audio = streams.find((s) => s.codec_type === 'audio');
        if (!video || video.codec_name !== 'h264' || Number(video.nb_frames) !== 60 || (aac && (!audio || audio.codec_name !== 'aac'))) {
          result.ok = false;
          result.failures.push('ffprobe لا يطابق: ' + probe);
        }
      } else if (run.status != null && run.status !== 0) {
        result.ok = false;
        result.failures.push('ffprobe رفض الملف: ' + String(run.stderr).slice(0, 300));
      }
    } catch {}
  }
  if (!result.ok) {
    finish(1, 'promo-frame-source-live: FAIL — ' + JSON.stringify({ failures: result.failures, report: result.report }, null, 1));
    return;
  }
  const real2 = result.report.real;
  finish(0, 'promo-frame-source-live: ok — 60 إطاراً اصطناعياً تُعاد بأرقامها، الملف المُغلَّف يُشغَّل حتى النهاية، المقطع الحقيقي ('
    + real2.frames + ' إطاراً) يطابق <video>، تتابع ' + real2.sequential_fps + ' إطار/ث، وبديل القفز يعمل. '
    + (aac ? '' : 'مسار AAC متخطّى: لا مرمّز AAC في WebCodecs هنا. ') + probe);
}

main().catch((error) => finish(1, 'promo-frame-source-live: ' + (error && error.stack || error)));
