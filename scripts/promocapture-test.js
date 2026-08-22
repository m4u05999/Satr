#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const promo = require('../electron/promocapture');

assert.strictEqual(promo.sanitizeAspect('16:9'), '16:9');
assert.strictEqual(promo.sanitizeAspect('9:16'), '9:16');
assert.strictEqual(promo.sanitizeAspect('1:1'), '1:1');
assert.strictEqual(promo.sanitizeAspect('4:3'), '');
assert.strictEqual(promo.mediaSourceWindowKey('window:41:1'), 'window:41');
assert.strictEqual(promo.mediaSourceWindowKey('screen:41:0'), '');

const downloads = path.resolve('tmp-promo-downloads');
// السجل صار دائماً؛ يبدأ الحارس بعينة نظيفة كي لا يعتمد على ترتيب تشغيلاته السابقة.
try { fs.rmSync(downloads, { recursive: true, force: true }); } catch {}
fs.mkdirSync(downloads, { recursive: true });
const sessionId = 'promo_0123456789abcdef01234567';
const filename = promo.segmentFilename(sessionId, new Date('2026-07-19T10:20:30Z'), 'mp4');
assert.strictEqual(filename, 'satr-promo-segment-' + sessionId + '-2026-07-19-10-20-30.mp4');
assert.strictEqual(promo.segmentFilename('../escape', new Date(), 'mp4'), '');
assert.strictEqual(promo.uniqueSegmentPath('relative', filename), null);
assert.strictEqual(promo.uniqueSegmentPath(downloads, '../outside.mp4'), null);
assert.strictEqual(promo.uniqueSegmentPath(downloads, filename, () => false), path.join(downloads, filename));
assert.strictEqual(promo.uniqueSegmentPath(downloads, filename,
  (candidate) => candidate === path.join(downloads, filename)),
path.join(downloads, filename.replace('.mp4', '-2.mp4')));
assert.strictEqual(promo.isInsideDownloads(downloads, path.join(downloads, filename)), true);
assert.strictEqual(promo.isInsideDownloads(downloads, path.resolve(downloads, '..', filename)), false);

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = { id: 41, mainFrame: { id: 'capture-frame' }, isDestroyed: () => this.destroyed };
  }
  isDestroyed() { return this.destroyed; }
  async loadURL(url) { this.url = url; }
  show() {}
  setContentSize(width, height) { this.contentSize = [width, height]; }
  getMediaSourceId() { return 'window:41:1'; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

(async () => {
  const displaySession = { handler: null, setDisplayMediaRequestHandler(handler) { this.handler = handler; } };
  const events = [];
  let controller;
  controller = promo.create({
    BrowserWindow: FakeWindow,
    desktopCapturer: { getSources: async () => [{ id: 'window:41:0', name: 'capture' }, { id: 'screen:1:0' }] },
    displaySession,
    ownerWebContents: { id: 7 },
    downloadsPath: downloads,
    readyDelayMs: 0,
    isHttpUrl: (url) => /^https?:\/\//.test(url),
    emit(event) {
      events.push(event);
      if (event.type === 'capture_start') setImmediate(() => controller.rendererReady(event.session_id, true, ''));
      if (event.type === 'capture_stop') setImmediate(() => {
        const name = promo.segmentFilename(event.session_id, new Date('2026-07-19T11:00:00Z'), 'mp4');
        controller.rendererCommit(event.session_id, 1234, name);
        controller.downloadResult({ type: 'promo_recording_saved', filename: name, path: path.join(downloads, name) });
      });
    },
  });

  assert.deepStrictEqual(await controller.start({ aspect: '4:3', url: 'http://localhost:3000' }), { ok: false, error: 'bad_aspect' });
  assert.deepStrictEqual(await controller.start({ aspect: '16:9', url: 'file:///tmp/app' }), { ok: false, error: 'bad_url' });
  const started = await controller.start({ aspect: '16:9', url: 'http://localhost:3000' });
  assert(started.ok && promo.SAFE_PROMO_SESSION.test(started.session_id));
  assert(events.some((event) => event.type === 'capture_start' && event.fps === 30 && event.source_id === 'window:41:0'));

  let granted = null;
  displaySession.handler({ frame: { top: { webContents: { id: 99 } } }, videoRequested: true, audioRequested: false }, (value) => { granted = value; });
  assert.deepStrictEqual(granted, {}, 'مصدر الالتقاط لا يُمنح لـwebContents أخرى');
  displaySession.handler({ frame: { top: { webContents: { id: 7 } } }, videoRequested: true, audioRequested: false }, (value) => { granted = value; });
  assert.strictEqual(granted.video.id, 'window:41:0', 'المصدر الوحيد الممنوح هو نافذة المنتج');

  const stopped = await controller.stop();
  assert(stopped.ok && stopped.duration_ms === 1234 && promo.isInsideDownloads(downloads, stopped.path));
  const listed = controller.listSegments();
  assert.strictEqual(listed.segments.length, 1);
  assert.strictEqual(listed.segments[0].path, stopped.path);
  await controller.stopAll();
  assert.strictEqual(displaySession.handler, null);

  const fallbackEvents = [];
  let fallback;
  fallback = promo.create({
    BrowserWindow: FakeWindow,
    desktopCapturer: { getSources: async () => [] },
    displaySession,
    ownerWebContents: { id: 7, isDestroyed: () => false },
    downloadsPath: downloads,
    readyDelayMs: 0,
    sourceAttempts: 1,
    isHttpUrl: (url) => /^https?:\/\//.test(url),
    emit(event) {
      fallbackEvents.push(event);
      if (event.type === 'capture_start') setImmediate(() => fallback.rendererReady(event.session_id, true, ''));
    },
  });
  const fallbackStarted = await fallback.start({ aspect: '1:1', url: 'http://localhost:3000' });
  assert(fallbackStarted.ok && fallbackEvents.some((event) => event.type === 'capture_start'
    && event.source_enumerated === false && event.source_id === 'window:41:1'),
  'نافذة العملية نفسها تستخدم getMediaSourceId المحصور إن لم يُرجعها getSources');
  assert.deepStrictEqual(fallback.rendererAbort(fallbackStarted.session_id, 'empty_recording'), { ok: true });
  assert.strictEqual(fallback.currentWebContents(), null, 'فشل MediaRecorder يغلق نافذة المنتج فوراً');

  const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'components', 'preview-panel.js'), 'utf8');
  assert(panelSource.includes('navigator.mediaDevices.getUserMedia') && panelSource.includes('minFrameRate: 30')
    && panelSource.includes('maxFrameRate: 30'), 'الواجهة تلتقط MediaStream أصلياً بـ30fps');
  assert(!panelSource.includes('previewFrame()') && !panelSource.includes('captureStream(8)'), 'حلقة PNG القديمة 8fps أزيلت من التسجيل');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert(mainSource.includes("Object.prototype.hasOwnProperty.call(p, 'sourceId')")
    && mainSource.includes("ipcMain.handle('satr:promoCaptureAbort'"), 'IPC لا يقبل sourceId من renderer وله إنهاء فشل منقّى');
  const agentSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
  assert(agentSource.includes('PROMO_START_TOOL') && agentSource.includes('PROMO_STOP_TOOL')
    && agentSource.includes('PROMO_READ_TOOLS'), 'SDK يصنّف أدوات البرومو ويمنع الموافقة الدائمة للفعل');

  try { fs.rmSync(downloads, { recursive: true, force: true }); } catch {}
  console.log('promocapture: نجح — aspect، مصدر نافذة حصري، fallback العملية، IPC، مسار Downloads، ودورة التسجيل.');
})().catch((error) => {
  try { fs.rmSync(downloads, { recursive: true, force: true }); } catch {}
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
