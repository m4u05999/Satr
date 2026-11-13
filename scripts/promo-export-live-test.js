#!/usr/bin/env electron
'use strict';

/**
 * اختبار حي لمحرك التصدير (الدفعة 6 من docs/PROMO-DIRECTOR-PLAN.md، §8.3).
 * storyboard ثابت مدته 10 ثوانٍ (1080p30): فيديو حقيقي + صورة بعنوان متحرك + فيديو بكاميرا وصوتين.
 * يمر بالمسار الفعلي: preload ⇒ IPC ⇒ promostudio.assetRead / promoexport في العملية الرئيسية.
 * يتحقق من: 300 إطار بالضبط بخطوة 1/30، مدة الصوت ±40ms، faststart، التشغيل حتى ended،
 * مطابقة إطارات التصدير لرسم المعاينة ≥ 99٪، الإلغاء بلا بقايا، وإعادة المحاولة عند فشل المرمّز.
 * Downloads مؤقت في مجلد النظام المؤقت؛ لا يُكتب شيء في تنزيلات المستخدم.
 *
 * التشغيل: npx electron scripts/promo-export-live-test.js
 * قياس 60 ثانية: PROMO_EXPORT_LONG=1 (يُسجَّل الزمن ولا يُحكم به).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const promostudio = require('../electron/promostudio');
const promoexport = require('../electron/promoexport');

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-export-live-'));
let finished = false;
let windowRef = null;
function finish(code, line) {
  if (finished) return;
  finished = true;
  (code ? console.error : console.log)(line);
  try { if (windowRef && !windowRef.isDestroyed()) windowRef.destroy(); } catch {}
  try { fs.rmSync(downloads, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
process.on('uncaughtException', (error) => finish(1, 'promo-export-live: ' + (error && error.stack || error)));
process.on('unhandledRejection', (error) => finish(1, 'promo-export-live: ' + (error && error.stack || error)));
const LONG = process.env.PROMO_EXPORT_LONG === '1';
setTimeout(() => finish(1, 'promo-export-live: timeout'), LONG ? 420000 : 180000).unref();

// WAV PCM16 ستيريو بنغمة ثابتة.
function wav(seconds, hz) {
  const rate = 48000, frames = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF', 0, 'latin1'); buffer.writeUInt32LE(36 + frames * 4, 4); buffer.write('WAVEfmt ', 8, 'latin1');
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1'); buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 9000);
    buffer.writeInt16LE(value, 44 + i * 4); buffer.writeInt16LE(value, 46 + i * 4);
  }
  return buffer;
}

async function main() {
  await app.whenReady();
  const studio = promostudio.create({ downloadsPath: downloads, exists: fs.existsSync, realpath: fs.realpathSync });
  const writer = promoexport.create({ downloadsPath: downloads });
  ipcMain.handle('satr:promoExportBegin', (event, payload) => writer.begin(payload && payload.kind === 'gif' ? 'gif' : 'mp4'));
  ipcMain.handle('satr:promoThumbnailSave', (event, payload) => writer.saveThumbnail(payload && payload.bytes));
  ipcMain.handle('satr:promoExportChunk', (event, payload) => writer.chunk(payload.handle, payload.seq, payload.bytes));
  ipcMain.handle('satr:promoExportFinish', (event, payload) => writer.finish(payload.handle, payload.header));
  ipcMain.handle('satr:promoExportAbort', (event, payload) => writer.abort(payload && payload.handle));
  // المخرجات تُقرأ للتحليل أيضاً: مسموح داخل Downloads المؤقت فقط، وللاختبار وحده.
  let analysisPath = '';
  ipcMain.handle('satr:promoAssetRead', (event, payload) => {
    if (payload.path === analysisPath) {
      const fd = fs.openSync(analysisPath, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(payload.length, size - payload.offset);
        const buffer = Buffer.alloc(Math.max(0, length));
        if (length > 0) fs.readSync(fd, buffer, 0, length, payload.offset);
        return { ok: true, size, bytes: buffer };
      } finally { fs.closeSync(fd); }
    }
    return studio.assetRead(payload.path, payload.offset, payload.length);
  });

  ipcMain.handle('satr:promoStudioState', () => ({ ...studio.state(), segments: [] }));
  ipcMain.handle('satr:promoAssetUrl', (event, payload) => studio.assetUrl(payload.path));

  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(__dirname, 'fixtures', 'promo-export-preload.js') },
  });
  windowRef = win;
  // المسار القديم ينزّل عبر رابط؛ نمنع حوار الحفظ في الاختبار.
  win.webContents.session.on('will-download', (event) => event.preventDefault());
  await win.loadFile(path.join(__dirname, 'fixtures', 'promo-export.html'));
  const run = (code) => win.webContents.executeJavaScript(code, true);

  const support = await run('window.__promoExportSupport()');
  if (!support.engine) {
    // جهاز بلا مرمّز H.264 أو AAC في WebCodecs: المحرك غير متاح، والمسار القديم يحرسه test:promo-studio.
    finish(0, 'promo-export-live: skipped — WebCodecs لا يدعم H.264/AAC هنا: ' + JSON.stringify(support));
    return;
  }

  // ── الأصول داخل Downloads المؤقت ──
  const clip = path.join(downloads, 'clip.mp4');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'promo-segment-fragmented.mp4'), clip);
  const image = path.join(downloads, 'shot.png');
  fs.writeFileSync(image, Buffer.from((await run('window.__promoMakePng(210)')).split(',')[1], 'base64'));
  const music = path.join(downloads, 'music.wav'), voice = path.join(downloads, 'voice.wav');
  fs.writeFileSync(music, wav(12, 220));
  fs.writeFileSync(voice, wav(2, 660));

  const board = { aspect: '16:9', scenes: [
    { asset: clip, duration_ms: 4000, trim_start_ms: 500, transition: 'cut', caption: 'Satr Pro متاح الآن', music, music_volume: 0.4 },
    { asset: image, duration_ms: 3000, transition: 'fade', caption: 'احجز موعدك في أقل من 30 ثانية', text_style: { animation: 'words', highlight: '30' }, music, music_volume: 0.4 },
    { asset: clip, duration_ms: 3000, trim_start_ms: 1500, transition: 'fade', fit: 'contain', caption: '', voice, voiceover_ar: 'أهلاً بكم في سطر. البيت العربي للأدوات الذكية.', subtitles: true,
      camera: { mode: 'manual', cursor: false, keyframes: [{ t_ms: 0, x: 0.5, y: 0.5, zoom: 1, ease: 'hold' }, { t_ms: 1200, x: 0.3, y: 0.3, zoom: 2, ease: 'inOut' }] } },
  ] };
  const proposed = studio.propose(board);
  if (!proposed.ok) throw new Error('propose: ' + proposed.error);
  const scenes = proposed.storyboard.scenes.map((scene) => ({ ...scene, src: pathToFileURL(scene.asset).href }));
  const listing = () => fs.readdirSync(downloads).filter((name) => name.startsWith('satr-promo-final') || name.startsWith('satr-promo-thumb')).sort();
  let gifLine = '';
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };

  // ── (1) التصدير ──
  const exported = await run('window.__promoExportRun(' + JSON.stringify(scenes) + ', {})');
  if (!exported.ok) throw new Error('export failed: ' + exported.error);
  const result = exported.result;
  expect('اسم الملف من main', /^satr-promo-final-[\d-]+\.mp4$/.test(result.filename) && path.dirname(result.path) === downloads, result.filename);
  expect('لا بقايا بعد التصدير', listing().length === 1 && listing()[0] === result.filename, listing());
  expect('300 إطار مرمَّز', result.frames === 300 && result.fps === 30 && result.width === 1920 && result.height === 1080, [result.frames, result.fps, result.width]);
  expect('المصادر فُتحت بالمفكِّك لا بالقفز', result.sources.length === 2 && result.sources.every((item) => item.mode === 'decoder'), result.sources);
  expect('ثلاثة مصادر صوت مُزجت (موسيقى ×2 + تعليق)', result.audio_sources === 3, result.audio_sources);
  expect('التقدم يُبلَّغ', exported.progress > 20 && exported.lastProgress === 'finalize:300', [exported.progress, exported.lastProgress]);

  // ── (2) تحليل الملف ──
  analysisPath = result.path;
  const analyzed = await run('window.__promoExportAnalyze(' + JSON.stringify(result.path) + ',' + JSON.stringify(pathToFileURL(result.path).href) + ','
    + JSON.stringify(scenes) + ',' + JSON.stringify([0, 45, 119, 121, 150, 209, 215, 250, 299]) + ')');
  if (!analyzed.ok) throw new Error('analyze failed: ' + analyzed.error);
  const report = analyzed.report;
  expect('عدد عينات الفيديو = 300 بالضبط', report.video_samples === 300, report.video_samples);
  expect('كل خطوة طابع = 1/30 ثانية (لا إطار ساقط ولا مكرر)', report.timestamp_steps_us.every((step) => step >= 33333 && step <= 33334), report.timestamp_steps_us);
  expect('مدة الفيديو 10 ثوانٍ', Math.abs(report.video_duration_ms - 10000) < 1, report.video_duration_ms);
  expect('انحراف مدة الصوت ≤ 40ms', report.audio_samples > 0 && Math.abs(report.audio_duration_ms - report.video_duration_ms) <= 40, [report.audio_duration_ms, report.video_duration_ms]);
  expect('إطار مفتاحي كل ثانيتين', report.keyframes === 5, report.keyframes);
  expect('ملف غير مجزّأ والرأس قبل البيانات (faststart)', report.fragmented === false && report.first_sample_offset > 600 && report.first_sample_offset < 200000, [report.fragmented, report.first_sample_offset]);
  expect('الأبعاد والمرمّز', report.width === 1920 && report.height === 1080 && /^avc1\.(64|4d|42)[0-9a-f]{2}28$/.test(report.codec) && report.audio_rate === 48000, [report.codec, report.width, report.audio_rate]);
  expect('الملف يُشغَّل في <video> حتى ended', report.playback.ended && Math.abs(report.playback.duration - 10) < 0.1 && report.playback.width === 1920, report.playback);
  const worst = Math.min(...report.matches.map((item) => item.ratio));
  expect('التصدير يطابق المعاينة ≥ 99٪ عند تسعة إطارات (كل المشاهد والانتقالات)', worst >= 0.99, report.matches);

  // ffprobe اختياري
  let probe = 'ffprobe: غير متاح';
  try {
    const ff = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,nb_frames,r_frame_rate,duration:format=duration', '-of', 'json', result.path], { encoding: 'utf8', timeout: 20000 });
    if (ff.status === 0 && ff.stdout) {
      const data = JSON.parse(ff.stdout);
      const video = data.streams.find((item) => item.codec_type === 'video'), audio = data.streams.find((item) => item.codec_type === 'audio');
      probe = 'ffprobe: ' + video.codec_name + '/' + video.nb_frames + '@' + video.r_frame_rate + ' ' + audio.codec_name + ' ' + Number(audio.duration).toFixed(3) + 's';
      expect('ffprobe يطابق', video.codec_name === 'h264' && Number(video.nb_frames) === 300 && video.r_frame_rate === '30/1' && audio.codec_name === 'aac'
        && Math.abs(Number(audio.duration) - Number(video.duration)) <= 0.04, probe);
    } else if (ff.status != null && ff.status !== 0) expect('ffprobe يقبل الملف', false, String(ff.stderr).slice(0, 200));
  } catch {}
  analysisPath = '';
  fs.unlinkSync(result.path);

  // ── (3) الإلغاء ──
  const cancelled = await run('window.__promoExportRun(' + JSON.stringify(scenes) + ', { cancelAtFrame: 40 })');
  expect('الإلغاء يرفض بـrender_cancelled', !cancelled.ok && cancelled.error === 'render_cancelled', cancelled);
  expect('الإلغاء لا يترك .part ولا ملفاً', listing().length === 0, listing());
  expect('لا تصدير نشط بعد الإلغاء', writer.state().active === false, writer.state());

  // ── (4) فشل المرمّز ⇒ إعادة برمجية. على جهاز يعمل مرمّزه العتادي ينجح بلا إعادة. ──
  const hardware = await run('window.__promoExportRun(' + JSON.stringify(scenes.slice(1, 2)) + ', { acceleration: "prefer-hardware" })');
  expect('طلب المرمّز العتادي ينتهي بملف صالح (مباشرة أو بعد إعادة برمجية)', hardware.ok && hardware.result.frames === 90, hardware.ok ? hardware.result.encoder : hardware.error);
  const retry = hardware.ok && hardware.result.encoder.retried_after ? 'أُعيد برمجياً بعد: ' + hardware.result.encoder.retried_after.slice(0, 50) : 'المرمّز العتادي عمل';
  expect('لا بقايا بعد الإعادة', listing().length === 1, listing());
  for (const name of listing()) fs.unlinkSync(path.join(downloads, name));

  // ── (5) زر «صيّر» في مكوّن الاستوديو: المحرك الجديد، ثم المسار القديم حين يُجبَر ──
  const short = studio.propose({ aspect: '16:9', scenes: [
    { asset: image, duration_ms: 1000, transition: 'cut', caption: 'Satr Pro متاح الآن', text_style: { animation: 'words' } },
    { asset: clip, duration_ms: 1000, trim_start_ms: 500, transition: 'fade', caption: '' },
  ] });
  if (!short.ok) throw new Error('short propose: ' + short.error);
  const viaStudio = await run('window.__promoStudioExport(false)');
  expect('الاستوديو يصدّر بالمحرك الجديد', viaStudio.engine === 'webcodecs' && viaStudio.frames === 60 && !viaStudio.error, viaStudio);
  expect('رسالة الاكتمال بلا ملاحظة تراجع', viaStudio.status === 'اكتمل التصيير إلى Downloads: ' + viaStudio.filename, viaStudio.status);
  expect('ملف MP4 في Downloads باسم main', listing().includes(viaStudio.filename), listing());
  const extras = viaStudio.extras || {};
  expect('الاستوديو يصدّر GIF بعد الاعتماد', !!extras.gif && extras.gif.engine === 'gif' && extras.gif.frames === 30 && extras.gif.width === 1280 && listing().includes(extras.gif.filename), extras);
  expect('رسالة GIF تذكر الملف وحجمه', /^اكتمل GIF إلى Downloads: satr-promo-final-[\d-]+\.gif \(/.test(extras.gifStatus || ''), extras.gifStatus);
  expect('الاستوديو يحفظ صورة مصغرة', !!extras.thumb && /^satr-promo-thumb-[\d-]+\.png$/.test(extras.thumb.filename) && listing().includes(extras.thumb.filename) && extras.thumb.bytes > 2000, extras);
  expect('GIF يلزمه اعتماد الخط الزمني، والصورة المصغرة لا', extras.gifDisabledWithoutApproval === true && extras.thumbEnabledWithoutApproval === true, extras);
  expect('لا بقايا .part بعد الثلاثة', listing().every((name) => !/part|tmp/.test(name)) && listing().length === 3, listing());
  expect('زر الإلغاء يظهر أثناء التصدير ويختفي بعده', viaStudio.cancelShownWhileRendering && viaStudio.cancelHiddenAfter, viaStudio);
  expect('1080p30 متاح، وما لا يدعمه الجهاز مقفل لا مخفي', viaStudio.options.length === 3 && viaStudio.options[0][0] === '1080p30' && viaStudio.options[0][1] === false
    && viaStudio.options.every(([name, disabled]) => disabled === !support.video[name]), viaStudio.options);
  for (const name of listing()) fs.unlinkSync(path.join(downloads, name));
  const viaLegacy = await run('window.__promoStudioExport(true)');
  expect('المسار القديم ما زال يعمل حين يُجبَر', viaLegacy.engine === 'legacy' && !viaLegacy.error && /^اكتمل التصيير/.test(viaLegacy.status), viaLegacy);
  expect('المسار القديم لا يمر بكاتب main', listing().length === 0 && writer.state().active === false, listing());

  // ── (6) GIF والصورة المصغرة عبر IPC حقيقي ──
  for (const name of listing()) fs.unlinkSync(path.join(downloads, name));
  const gifBoard = studio.propose({ aspect: '16:9', scenes: board.scenes.map((scene, index) => ({ ...scene, duration_ms: index === 0 ? 1000 : 500, trim_start_ms: 500, music: '', voice: '', camera: undefined })) });
  if (!gifBoard.ok) throw new Error('gif propose: ' + gifBoard.error);
  const withSrc = (list) => list.map((scene) => ({ ...scene, src: pathToFileURL(scene.asset).href }));
  const gif = await run('window.__promoExportGif(' + JSON.stringify(withSrc(gifBoard.storyboard.scenes)) + ')');
  expect('تصدير GIF ينجح', gif.ok && gif.result.engine === 'gif' && gif.result.frames === 30 && gif.result.fps === 15 && gif.result.width === 1280 && gif.result.height === 720, gif.ok ? gif.result : gif.error);
  if (gif.ok) {
    analysisPath = gif.result.path;
    const inspected = await run('window.__promoGifInspect(' + JSON.stringify(gif.result.path) + ')');
    analysisPath = '';
    expect('GIF: التوقيع والذيل والأبعاد', inspected.signature === 'GIF89a' && inspected.trailer === 0x3b && inspected.width === 1280 && inspected.height === 720, inspected);
    if (inspected.frameCount != null) {
      expect('GIF: مفكِّك المتصفح يقرأ 30 إطاراً بتكرار لانهائي', inspected.frameCount === 30 && inspected.frameWidth === 1280 && inspected.repetitions === 'infinite', inspected);
      expect('GIF: التوقيت 15 إطاراً/ث', inspected.firstDurationUs >= 60000 && inspected.firstDurationUs <= 70000 && Math.abs(inspected.lastTimestampUs - 29 * 1e6 / 15) < 30000, inspected);
    }
    gifLine = ' · GIF ' + (gif.result.bytes / 1048576).toFixed(1) + ' م.ب في ' + (gif.result.elapsed_ms / 1000).toFixed(1) + ' ث';
    try {
      const ff = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames,width,height', '-of', 'json', gif.result.path], { encoding: 'utf8', timeout: 30000 });
      if (ff.status === 0 && ff.stdout) {
        const stream = JSON.parse(ff.stdout).streams[0];
        expect('ffprobe يقرأ GIF', stream.codec_name === 'gif' && Number(stream.nb_read_frames) === 30 && stream.width === 1280, stream);
        gifLine += ' (ffprobe: gif/' + stream.nb_read_frames + ')';
      } else if (ff.status != null && ff.status !== 0) expect('ffprobe يقبل GIF', false, String(ff.stderr).slice(0, 200));
    } catch {}
  }
  const sixteen = studio.propose({ aspect: '16:9', scenes: Array.from({ length: 4 }, () => ({ asset: image, duration_ms: 4001 })) });
  const rejected = await run('window.__promoExportGif(' + JSON.stringify(withSrc(sixteen.storyboard.scenes)) + ')');
  expect('GIF فوق 15 ثانية مرفوض قبل الكتابة', !rejected.ok && rejected.error === 'gif_too_long' && writer.state().active === false, rejected);
  studio.propose(board);
  const filesBefore = listing().length;
  const gifCancelled = await run('window.__promoExportGif(' + JSON.stringify(scenes) + ', 20)');
  expect('إلغاء GIF بلا بقايا', !gifCancelled.ok && gifCancelled.error === 'render_cancelled' && listing().length === filesBefore && writer.state().active === false, [gifCancelled, listing()]);
  const thumb = await run('window.__promoThumbnail(' + JSON.stringify(scenes) + ', 5000)');
  expect('الصورة المصغرة PNG بمقاس التصدير', thumb.ok && thumb.width === 1920 && thumb.height === 1080 && JSON.stringify(thumb.signature) === '[137,80,78,71]'
    && /^satr-promo-thumb-[\d-]+\.png$/.test(thumb.saved.filename) && fs.existsSync(path.join(downloads, thumb.saved.filename)), thumb);
  for (const name of listing()) fs.unlinkSync(path.join(downloads, name));

  // ── (7) قياس 60 ثانية (اختياري) ──
  let long = '';
  if (LONG) {
    const sixty = studio.propose({ aspect: '16:9', scenes: Array.from({ length: 12 }, (_, i) => ({ ...board.scenes[i % 3], duration_ms: 5000, trim_start_ms: 300 })) });
    const longScenes = sixty.storyboard.scenes.map((scene) => ({ ...scene, src: pathToFileURL(scene.asset).href }));
    const measured = await run('window.__promoExportRun(' + JSON.stringify(longScenes) + ', {})');
    expect('تصدير 60 ثانية ينجح بـ1800 إطار', measured.ok && measured.result.frames === 1800, measured.ok ? measured.result.frames : measured.error);
    if (measured.ok) long = ' · 60 ثانية 1080p30 في ' + (measured.result.elapsed_ms / 1000).toFixed(1) + ' ثانية (' + measured.result.encoder.codec + '/' + measured.result.encoder.acceleration + ')';
  }

  if (failures.length) {
    finish(1, 'promo-export-live: FAIL — ' + JSON.stringify({ failures, report, result }, null, 1));
    return;
  }
  finish(0, 'promo-export-live: ok — 300 إطار بالضبط، انحراف الصوت ' + Math.abs(report.audio_duration_ms - report.video_duration_ms).toFixed(1)
    + 'ms، مطابقة المعاينة ≥ ' + (worst * 100).toFixed(2) + '٪، تصدير 10 ثوانٍ في ' + (result.elapsed_ms / 1000).toFixed(1) + ' ثانية ('
    + result.encoder.codec + '/' + result.encoder.acceleration + ')، الإلغاء بلا بقايا، ' + retry + gifLine + long + '. ' + probe);
}

main().catch((error) => finish(1, 'promo-export-live: ' + (error && error.stack || error)));
