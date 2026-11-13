#!/usr/bin/env electron
'use strict';

/**
 * دليل حي للكاميرا الذكية على تسجيل حقيقي (ليس جزءاً من الطقم: يعتمد على التقاط نافذة فعلي).
 *
 * يسجّل صفحة فيها زرّان عبر promocapture الحقيقي، ينقرهما بإدخال محقون، ثم يقرأ سجل الأحداث
 * الذي كتبه التطبيق، ويخطط الكاميرا، ويتحقق على **إطارات الفيديو المسجَّل نفسه** أن التكبير يقع
 * على الزر المنقور. ثم يصدّر المقطع بالكاميرا إلى MP4 لعين المالك.
 *
 * حدّه: لا منارات وسائط في هذا الحاضن، فتوقيت الأحداث «غير موثّق» كما يكتبه التطبيق. الهندسة
 * (هل يقع التكبير على الزر؟) تُفحص بوضع «موثّق» مفروض؛ إزاحة الزمن الحقيقية تُفحص من داخل سطر.
 *
 * التشغيل: npm run evidence:promo-camera
 * الخرج: dist/promo-camera-evidence/{camera-demo.mp4, click-1.png, click-2.png, report.json}
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const promocapture = require('../electron/promocapture');
const promostudio = require('../electron/promostudio');
const promoexport = require('../electron/promoexport');
const preview = require('../electron/preview');

const outDir = path.join(__dirname, '..', 'dist', 'promo-camera-evidence');
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-camera-evidence-'));
const report = { ok: false, stage: 'boot', error: '' };
let finished = false;

function finish(code) {
  if (finished) return;
  finished = true;
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); } catch {}
  process.stdout.write(code === 0
    ? 'promo-camera-evidence: ok — ' + report.summary + '\n'
    : 'promo-camera-evidence: FAIL at ' + report.stage + ' — ' + String(report.error).split('\n')[0] + '\n');
  for (const win of BrowserWindow.getAllWindows()) { try { win.destroy(); } catch {} }
  try { fs.rmSync(downloads, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
process.on('uncaughtException', (error) => { report.error = String(error && error.stack || error); finish(1); });
process.on('unhandledRejection', (error) => { report.error = String(error && error.stack || error); finish(1); });
app.on('window-all-closed', () => {});
setTimeout(() => { report.error = 'timeout_150s'; finish(1); }, 150000).unref();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BUTTONS = [
  { id: 'primary', x: 300, y: 200, width: 240, height: 120, color: '#ff00ff' },
  { id: 'secondary', x: 1300, y: 700, width: 260, height: 110, color: '#00e5ff' },
];

async function startRecording(sourceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, minFrameRate: 30, maxFrameRate: 30, maxWidth: 3840, maxHeight: 2160 } } });
  const candidates = ['video/mp4;codecs=avc1.64002A', 'video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'];
  const mime = candidates.find((item) => MediaRecorder.isTypeSupported(item)) || '';
  const state = window.__rec = { stream, chunks: [], mime, recorder: new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 24000000 } : {}) };
  state.recorder.ondataavailable = (event) => { if (event.data && event.data.size) state.chunks.push(event.data); };
  state.recorder.start(1000);
  return { mime };
}

async function stopRecording() {
  const state = window.__rec;
  const blob = await new Promise((resolve) => { state.recorder.onstop = () => resolve(new Blob(state.chunks, { type: state.mime || 'video/mp4' })); state.recorder.stop(); });
  state.stream.getTracks().forEach((track) => track.stop());
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { type: blob.type, base64: btoa(binary) };
}

// يُحقن في صفحة التحليل (scripts/fixtures/promo-export.html): الكاميرا على إطارات المقطع الحقيقي.
async function analyze(input) {
  const { planCamera, cameraAt, pointerTrack } = await import('../../src/ui/lib/promo/promo-camera.js');
  const { buildTimeline } = await import('../../src/ui/lib/promo/promo-timeline.js');
  const { renderFrame } = await import('../../src/ui/lib/promo/promo-frame.js');
  const { createDecoderSource } = await import('../../src/ui/lib/promo-export/frame-source.js');
  const { exportStoryboard } = await import('../../src/ui/lib/promo-export/export.js');
  const readAsset = (assetPath, offset, length) => window.satr.promoAssetRead(assetPath, offset, length);
  const readAt = async (offset, length) => { const part = await readAsset(input.asset, offset, length); return part.bytes instanceof Uint8Array ? part.bytes : new Uint8Array(part.bytes); };
  const size = (await readAsset(input.asset, 0, 0)).size;
  const source = await createDecoderSource(readAt, size);
  const durationMs = Math.floor(source.durationUs / 1000) - 100;
  const colors = { background: '#0b0f14', captionBackground: 'rgba(0,0,0,0.62)', captionText: '#f4f6f8', accent: '#d9a441' };
  // الهندسة تُفحص بتوقيت «موثّق» مفروض؛ ما كتبه التطبيق فعلاً يُسجَّل في التقرير.
  const verified = input.events.map((event) => ({ ...event, timing_quality: 'verified' }));
  const bounds = { durationMs, sourceStartMs: 0 };
  const keyframes = planCamera(verified, bounds).map(({ t_ms, x, y, zoom, ease }) => ({ t_ms, x, y, zoom, ease }));
  const scene = { asset: input.asset, src: input.src, asset_type: 'video', duration_ms: durationMs, trim_start_ms: 0, transition: 'cut', fit: 'cover', caption: 'Satr Pro متاح الآن',
    caption_position: 'bottom', caption_style: 'box', text_style: { animation: 'words', font: 'cairo', highlight: 'Pro' }, camera: { mode: 'auto', cursor: true, keyframes }, redactions: [],
    transition_in: 'none', clip_volume: 1, music: '', voice: '' };
  const pointers = new Map([[0, pointerTrack(verified, bounds)]]);
  const W = 1920, H = 1080;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  const bbox = (test) => {
    const data = context.getImageData(0, 0, W, H).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const i = (y * W + x) * 4; if (test(data[i], data[i + 1], data[i + 2])) { count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
    return count ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count } : { count: 0 };
  };
  const tests = { primary: (r, g, b) => r > 190 && g < 90 && b > 190, secondary: (r, g, b) => r < 90 && g > 180 && b > 190 };
  const draw = async (tMs, camera) => {
    const frame = await source.frameAt(source.startUs + tMs * 1000);
    renderFrame(context, { width: W, height: H, colors, timeline: buildTimeline({ scenes: [{ ...scene, caption: '', camera }] }), aspect: '16:9' }, tMs, new Map([[0, frame]]));
  };
  const clicks = [];
  const images = [];
  const downs = verified.filter((event) => event.action === 'mousedown');
  for (let i = 0; i < downs.length; i += 1) {
    const event = downs[i];
    const button = input.buttons[i];
    // لحظة بعد النقرة بقليل: الكاميرا وصلت وهي ممسكة.
    const t = Math.min(durationMs - 50, event.t_ms + 400);
    await draw(t, { mode: 'off', cursor: false, keyframes: [] });
    const flat = bbox(tests[button.id]);
    await draw(t, { mode: 'auto', cursor: false, keyframes });
    const zoomed = bbox(tests[button.id]);
    const state = cameraAt({ mode: 'auto', keyframes }, t);
    images.push({ name: 'click-' + (i + 1) + '.png', data: canvas.toDataURL('image/png') });
    clicks.push({ button: button.id, event_t_ms: event.t_ms, rect: event.rect, viewport: event.viewport, camera: state, flat, zoomed,
      scale: flat.count && zoomed.count ? Math.round(zoomed.width / flat.width * 100) / 100 : 0,
      inside: zoomed.count > 0 && zoomed.x > 0 && zoomed.y > 0 && zoomed.x + zoomed.width < W && zoomed.y + zoomed.height < H,
      center_offset: zoomed.count ? [Math.round(zoomed.x + zoomed.width / 2 - W / 2), Math.round(zoomed.y + zoomed.height / 2 - H / 2)] : null });
  }
  source.close();
  const exported = await exportStoryboard({
    scenes: [scene], aspect: '16:9', preset: '1080p30', colors, pointers, readAsset,
    writer: { begin: (kind) => window.satr.promoExportBegin(kind), chunk: (h, q, b) => window.satr.promoExportChunk(h, q, b), finish: (h, head) => window.satr.promoExportFinish(h, head), abort: (h) => window.satr.promoExportAbort(h) },
  });
  return { durationMs, keyframes, clicks, images, exported: { filename: exported.filename, path: exported.path, frames: exported.frames, elapsed_ms: exported.elapsed_ms, sources: exported.sources } };
}

async function main() {
  await app.whenReady();
  const page = '<!doctype html><meta charset="utf-8"><title>دليل الكاميرا</title><style>html,body{margin:0;height:100%;background:#f4f6f8;overflow:hidden;font:28px sans-serif}'
    + 'header{height:90px;background:#17324d}'
    + BUTTONS.map((b) => '#' + b.id + '{position:absolute;left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.width + 'px;height:' + b.height + 'px;background:' + b.color + ';border:0;padding:0;margin:0;outline:0}').join('')
    + '</style><header></header>' + BUTTONS.map((b) => '<button id="' + b.id + '"></button>').join('');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url.startsWith('/rec') ? '<!doctype html><title>rec</title>' : page); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const receiver = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await receiver.loadURL(base + '/rec');
  const inject = (fn, ...args) => '(' + fn.toString() + ')(' + args.map((item) => JSON.stringify(item)).join(',') + ').catch(function(e){throw new Error(String(e&&e.name)+": "+String(e&&e.message));})';

  report.stage = 'record';
  let captureContents = null, stopResult = null, recordError = '';
  let controller;
  controller = promocapture.create({
    BrowserWindow, desktopCapturer, displaySession: receiver.webContents.session, ownerWebContents: receiver.webContents,
    downloadsPath: downloads, isHttpUrl: (value) => /^https?:\/\//.test(value), readyDelayMs: 400,
    onTarget(webContents) {
      captureContents = webContents;
      const win = webContents && BrowserWindow.fromWebContents(webContents);
      if (win) { win.moveTop(); win.focus(); }
      try { preview.setExternalTargetProvider(() => webContents, () => {}); preview.attachExternalWebContents(webContents); } catch {}
    },
    emit(event) {
      if (event.type === 'capture_start') {
        receiver.webContents.executeJavaScript(inject(startRecording, event.source_id), true)
          .then(() => controller.rendererReady(event.session_id, true, ''))
          .catch((error) => { recordError = String(error && error.message || error); controller.rendererReady(event.session_id, false, 'media_failed'); });
      } else if (event.type === 'capture_stop') {
        receiver.webContents.executeJavaScript(inject(stopRecording), true).then((value) => {
          const filename = promocapture.segmentFilename(event.session_id, new Date(), /mp4/.test(value.type) ? 'mp4' : 'webm');
          const target = path.join(downloads, filename);
          fs.writeFileSync(target, Buffer.from(value.base64, 'base64'));
          stopResult = { filename, path: target };
          controller.rendererCommit(event.session_id, 6500, filename);
          controller.downloadResult({ type: 'promo_recording_saved', filename, path: target });
        }).catch((error) => { recordError = String(error && error.message || error); });
      }
    },
  });
  const started = await controller.start({ aspect: '16:9', url: base + '/' });
  if (!started.ok) throw new Error('capture start: ' + started.error + ' ' + recordError);
  const click = async (button) => {
    const x = Math.round(button.x + button.width / 2), y = Math.round(button.y + button.height / 2);
    captureContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 1, movementY: 1 });
    captureContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    captureContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  report.capture_page = await captureContents.executeJavaScript('({innerWidth:innerWidth,innerHeight:innerHeight,dpr:devicePixelRatio})', true);
  // الزر الثاني قد يقع خارج مساحة العمل على شاشة صغيرة (OBS-223)؛ ننقر ما هو ظاهر فقط.
  const visible = BUTTONS.filter((b) => b.x + b.width <= report.capture_page.innerWidth && b.y + b.height <= report.capture_page.innerHeight);
  await delay(1500);
  await click(visible[0]);
  await delay(2600);
  if (visible[1]) await click(visible[1]);
  await delay(2400);
  const stopped = await controller.stop();
  for (let i = 0; i < 60 && !stopResult && !recordError; i += 1) await delay(100);
  if (!stopped.ok || !stopResult) throw new Error('no recording: ' + JSON.stringify({ stopped, recordError }));
  try { await controller.stopAll(); } catch {}

  report.stage = 'events';
  const segment = controller.listSegments().segments.find((item) => item.path === stopResult.path);
  const events = controller.segmentEvents(stopResult.path);
  if (!events.ok) throw new Error('segment events: ' + events.error);
  report.events = { count: events.events.length, timing_quality: events.timing_quality, offset_known: events.offset_known, events_file: segment && path.basename(segment.events_file),
    mousedowns: events.events.filter((event) => event.action === 'mousedown').map((event) => ({ t_ms: event.t_ms, rect: event.rect })) };

  report.stage = 'analyze';
  const studio = promostudio.create({ downloadsPath: downloads, exists: fs.existsSync, realpath: fs.realpathSync });
  const proposed = studio.propose({ scenes: [{ asset: stopResult.path, duration_ms: 3000 }] });
  if (!proposed.ok) throw new Error('propose: ' + proposed.error);
  const writer = promoexport.create({ downloadsPath: downloads });
  ipcMain.handle('satr:promoExportBegin', (event, payload) => writer.begin(payload && payload.kind === 'gif' ? 'gif' : 'mp4'));
  ipcMain.handle('satr:promoExportChunk', (event, payload) => writer.chunk(payload.handle, payload.seq, payload.bytes));
  ipcMain.handle('satr:promoExportFinish', (event, payload) => writer.finish(payload.handle, payload.header));
  ipcMain.handle('satr:promoExportAbort', (event, payload) => writer.abort(payload && payload.handle));
  ipcMain.handle('satr:promoAssetRead', (event, payload) => studio.assetRead(payload.path, payload.offset, payload.length));
  const analysis = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'fixtures', 'promo-export-preload.js') } });
  await analysis.loadFile(path.join(__dirname, 'fixtures', 'promo-export.html'));
  const result = await analysis.webContents.executeJavaScript(inject(analyze, {
    asset: stopResult.path, src: pathToFileURL(stopResult.path).href, events: events.events, buttons: visible,
  }), true);

  fs.mkdirSync(outDir, { recursive: true });
  for (const image of result.images) fs.writeFileSync(path.join(outDir, image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  fs.copyFileSync(result.exported.path, path.join(outDir, 'camera-demo.mp4'));
  report.duration_ms = result.durationMs;
  report.keyframes = result.keyframes;
  report.clicks = result.clicks;
  report.exported = { file: 'camera-demo.mp4', frames: result.exported.frames, elapsed_ms: result.exported.elapsed_ms, sources: result.exported.sources };

  // الحكم: كل زر منقور مكبَّر ≥ 1.35× وكله داخل الإطار.
  const failures = result.clicks.filter((item) => !(item.scale >= 1.35 && item.inside));
  report.ok = result.clicks.length === visible.length && failures.length === 0;
  report.summary = result.clicks.length + ' نقرة على تسجيل حقيقي (' + report.capture_page.innerWidth + '×' + report.capture_page.innerHeight + ')؛ التكبير '
    + result.clicks.map((item) => item.scale + '×').join(' و') + ' والزر كله داخل الإطار؛ توقيت السجل كما كتبه التطبيق: ' + events.timing_quality
    + '؛ الفيديو في dist/promo-camera-evidence/camera-demo.mp4 (' + result.exported.frames + ' إطاراً)';
  if (!report.ok) { report.error = 'التكبير لم يقع على الزر: ' + JSON.stringify(failures.length ? failures : result.clicks); report.stage = 'verdict'; finish(1); return; }
  report.stage = 'done';
  finish(0);
}

main().catch((error) => { report.error = String(error && error.stack || error); finish(1); });
