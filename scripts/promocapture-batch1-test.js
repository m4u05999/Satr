#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const promo = require('../electron/promocapture');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promocapture-b1-'));
const segmentId = 'promo_0123456789abcdef01234567';

function event(overrides) {
  return {
    kind: 'action', source: 'agent', action: 'click', target_ref: 's1:e2', document_id: 'd1',
    rect: { x: 10, y: 20, width: 30, height: 40 }, pointer: null,
    viewport: { width: 800, height: 600, dpr: 1 },
    ...overrides,
  };
}

function forbiddenKeys(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  const forbidden = new Set([
    'browser_type', 'value', 'input', 'textarea', 'contenteditable', 'password', 'token', 'api_key',
    'clipboard', 'key', 'prompt', 'text', 'aria_label', 'selector', 'xpath', 'url', 'origin',
    'path', 'query', 'fragment', 'userinfo', 'cookies', 'headers', 'body', 'localStorage',
    'sessionStorage', 'console', 'base64', 'iframe',
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) found.push(key);
    if (item && typeof item === 'object') forbiddenKeys(item, found);
  }
  return found;
}

class FakeSession {
  setPermissionRequestHandler(handler) { this.requestHandler = handler; }
  setPermissionCheckHandler(handler) { this.checkHandler = handler; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = {
      id: 41, mainFrame: { id: 'capture-main-frame' }, session: new FakeSession(),
      isDestroyed: () => this.destroyed,
    };
  }
  isDestroyed() { return this.destroyed; }
  async loadURL(url) { this.url = url; }
  show() {}
  setContentSize() {}
  getMediaSourceId() { return 'window:41:1'; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function controllerDeps(downloads, extra = {}) {
  const displaySession = { setDisplayMediaRequestHandler(handler) { this.handler = handler; } };
  return {
    BrowserWindow: FakeWindow,
    desktopCapturer: { getSources: async () => [{ id: 'window:41:0', name: 'capture' }] },
    displaySession,
    ownerWebContents: { id: 7, mainFrame: { id: 'owner-main-frame' }, isDestroyed: () => false },
    downloadsPath: downloads,
    readyDelayMs: 0,
    isHttpUrl: (url) => /^https?:\/\//.test(url),
    showBeacon: async () => ({ ok: false }),
    setEventSink: () => ({ ok: true }),
    ...extra,
  };
}

async function startReady(controller, options) {
  const original = controller;
  const deps = options.deps;
  deps.emit = (item) => {
    options.events.push(item);
    if (item.type === 'capture_start') setImmediate(() => original.rendererReady(item.session_id, true, ''));
  };
  controller.configure(deps);
  return controller.start(options.start || { aspect: '16:9', url: 'http://localhost:3000' });
}

async function main() {
  assert.strictEqual(promo.EVENT_LOG_VERSION, 0, 'إصدار سجل الأحداث تغيّر');
  assert.strictEqual(promo.EVENT_LOG_MAX_RECORDS, 10000, 'سقف السجلات ليس 10000');
  assert.strictEqual(promo.EVENT_LOG_MAX_BYTES, 2 * 1024 * 1024, 'سقف السجل ليس 2MiB');
  assert.strictEqual(promo.EVENT_MOUSEMOVE_INTERVAL_MS, 100, 'نافذة دمج mousemove ليست 100ms');
  assert.strictEqual(promo.projectEventRoot(tmp), path.join(tmp, '.satr', 'promo', 'events'), 'جذر الأحداث لا يبقى داخل المشروع');
  const oversizedRegistry = Array.from({ length: 520 }, (_item, index) => ({ index, padding: 'x'.repeat(2500) }));
  const trimmedRegistry = promo.trimRegistry(oversizedRegistry);
  assert(trimmedRegistry.length <= promo.SEGMENT_REGISTRY_MAX_COUNT, 'سجل المقاطع تجاوز سقف العدد');
  assert.strictEqual(trimmedRegistry[trimmedRegistry.length - 1].index, 519, 'التنظيف لم يُبقِ الأحدث');
  assert(Buffer.byteLength(JSON.stringify({ version: 1, segments: trimmedRegistry }, null, 2) + '\n', 'utf8')
    <= promo.SEGMENT_REGISTRY_MAX_BYTES, 'سجل المقاطع تجاوز سقف الحجم');

  // السجل ينجو من إنشاء controller جديد، والملف المفقود لا يُمحى من السرد.
  const downloads = path.join(tmp, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const events = [];
  const first = promo.create(controllerDeps(downloads));
  const firstDeps = controllerDeps(downloads);
  const started = await startReady(first, { deps: firstDeps, events });
  assert.strictEqual(started.ok, true, 'فشل بدء محاكاة الاستمرارية');
  const filename = promo.segmentFilename(started.session_id, new Date('2026-08-22T10:20:30Z'), 'mp4');
  const file = path.join(downloads, filename);
  fs.writeFileSync(file, Buffer.alloc(2048, 7));
  assert.strictEqual(first.rendererCommit(started.session_id, 1234, filename).ok, true);
  first.downloadResult({ type: 'promo_recording_saved', filename, path: file });
  const restarted = promo.create(controllerDeps(downloads));
  let listed = restarted.listSegments();
  assert.strictEqual(listed.segments.length, 1, 'السجل لم ينجُ من إعادة تشغيل محاكاة');
  assert.strictEqual(listed.segments[0].available, true, 'الملف الموجود وُسم مفقوداً');
  fs.unlinkSync(file);
  listed = restarted.listSegments();
  assert.strictEqual(listed.segments.length, 1, 'المقطع المفقود اختفى صامتاً');
  assert.strictEqual(listed.segments[0].missing, true, 'المقطع المفقود بلا وسم missing');
  assert.strictEqual(listed.segments[0].disabled, true, 'المقطع المفقود غير معطّل');

  // rename الفاشل لا يستبدل آخر سجل صالح ولا يترك temp، والنداء نفسه لا يرمي.
  const registry = promo.registryFileFor(downloads);
  const before = fs.readFileSync(registry, 'utf8');
  const failingFs = Object.assign({}, fs, { renameSync() { throw new Error('rename_failed_by_guard'); } });
  assert.doesNotThrow(() => promo.atomicWriteRegistry(registry, [], failingFs), 'فشل rename كسر مسار التسجيل');
  assert.strictEqual(fs.readFileSync(registry, 'utf8'), before, 'فشل rename أتلف السجل السابق');
  assert.strictEqual(fs.readdirSync(downloads).filter((name) => name.includes('.tmp-')).length, 0, 'ملف temp تُرك بعد فشل rename');

  // الدمج عند 100ms، سقف العدد، وسجل truncated أخير.
  let now = 1000;
  const capped = promo.createEventSink({ root: path.join(tmp, 'events-count'), segmentId, now: () => now, maxRecords: 5 });
  capped.markBeacon('start', { capture_ms: 1000, visible: true, media_ms: 0 });
  capped.record(event({ kind: 'pointer', source: 'human', action: 'mousemove', monotonic_ms: 1000 }));
  capped.record(event({ kind: 'pointer', source: 'human', action: 'mousemove', monotonic_ms: 1099 }));
  capped.record(event({ kind: 'pointer', source: 'human', action: 'mousemove', monotonic_ms: 1100 }));
  capped.record(event({ monotonic_ms: 1200 }));
  capped.record(event({ monotonic_ms: 1300 }));
  capped.record(event({ monotonic_ms: 1400 }));
  const cappedState = capped.state();
  assert.strictEqual(cappedState.records.filter((item) => item.action === 'mousemove').length, 2, 'mousemove لم يُدمج كل 100ms');
  assert.strictEqual(cappedState.records.length, 5, 'سقف العدد لم يُحترم');
  assert.strictEqual(cappedState.records[4].kind, 'truncated', 'السجل الأخير لا يسمّي truncated');
  assert.deepStrictEqual(cappedState.records.map((item) => item.seq), [1, 2, 3, 4, 5], 'seq فيه فجوة');

  // سقف الحجم يكتب truncated ولا يتجاوز الحد المضبوط للاختبار.
  const byteSink = promo.createEventSink({ root: path.join(tmp, 'events-bytes'), segmentId, maxBytes: 1100 });
  byteSink.markBeacon('start', { capture_ms: 0, visible: true, media_ms: 0 });
  for (let index = 0; index < 20 && !byteSink.state().truncated; index += 1) {
    byteSink.record(event({ monotonic_ms: index * 200, target_ref: 's999999:e999999' }));
  }
  assert.strictEqual(byteSink.state().truncated, true, 'سقف الحجم لم يكتب truncated');
  assert(byteSink.state().bytes <= 1100, 'سجل الأحداث تجاوز سقف الحجم');

  // قائمة بيضاء مغلقة: نفحص كل اسم محظور منفرداً، ونفحص غياب قيمة السر نفسها.
  const leakSink = promo.createEventSink({ root: path.join(tmp, 'events-leak'), segmentId });
  leakSink.markBeacon('start', { capture_ms: 0, visible: true, media_ms: 0 });
  const poisoned = event({ monotonic_ms: 10 });
  const secret = 'SECRET-LOW-ENTROPY-123';
  for (const key of [
    'browser_type', 'value', 'input', 'textarea', 'contenteditable', 'password', 'token', 'api_key',
    'clipboard', 'key', 'prompt', 'text', 'aria_label', 'selector', 'xpath', 'url', 'origin',
    'path', 'query', 'fragment', 'userinfo', 'cookies', 'headers', 'body', 'localStorage',
    'sessionStorage', 'console', 'base64', 'iframe',
  ]) poisoned[key] = secret;
  leakSink.record(poisoned);
  const clean = leakSink.state().records[0];
  assert.deepStrictEqual(forbiddenKeys(clean), [], 'تسرّبت أسماء حقول محظورة: ' + forbiddenKeys(clean).join(','));
  assert(!JSON.stringify(clean).includes(secret), 'تسرّبت قيمة حقل محظور أو تجزئتها الأصلية');

  // غياب المنارة أو انحراف النهاية يوسم المقطع unverified؛ الصالح وحده يفتح الاشتقاق.
  const missingBeacon = promo.createEventSink({ root: path.join(tmp, 'events-missing-beacon'), segmentId });
  assert.strictEqual(missingBeacon.record(event()).error, 'beacon_missing');
  missingBeacon.markBeacon('start', { capture_ms: 0, visible: false });
  missingBeacon.markBeacon('end', { capture_ms: 1000, visible: true, media_ms: 1000 });
  assert.strictEqual(missingBeacon.finalize(1000).timing_quality, 'unverified', 'غياب منارة البدء لم يحجب المقطع');
  const drift = promo.createEventSink({ root: path.join(tmp, 'events-drift'), segmentId });
  drift.markBeacon('start', { capture_ms: 0, visible: true, media_ms: 0 });
  drift.markBeacon('end', { capture_ms: 1000, visible: true, media_ms: 1200 });
  assert.strictEqual(drift.finalize(1200).auto_crop_eligible, false, 'انحراف النهاية لم يحجب الاشتقاق');
  const verified = promo.createEventSink({ root: path.join(tmp, 'events-verified'), segmentId });
  verified.markBeacon('start', { capture_ms: 0, visible: true, media_ms: 50 });
  verified.markBeacon('end', { capture_ms: 1000, visible: true, media_ms: 1090 });
  assert.strictEqual(verified.finalize(1100).timing_quality, 'verified', 'منارة ضمن 80ms لم تُقبل');

  // صوت النظام opt-in فقط، ويستخدم mainFrame+loopback لا window-source.
  const audioEvents = [];
  const audioDeps = controllerDeps(path.join(tmp, 'audio'));
  fs.mkdirSync(audioDeps.downloadsPath, { recursive: true });
  const audioController = promo.create(audioDeps);
  const audioStarted = await startReady(audioController, {
    deps: audioDeps, events: audioEvents,
    start: { aspect: '16:9', url: 'http://localhost:3000', audio: 'loopback', microphone: true },
  });
  assert.strictEqual(audioStarted.ok, true);
  const startEvent = audioEvents.find((item) => item.type === 'capture_start');
  assert.strictEqual(startEvent.audio, 'loopback');
  assert.strictEqual(startEvent.system_wide, true, 'خطر systemWide غير معلن في العقد');
  let granted = null;
  audioDeps.displaySession.handler({ frame: { top: { webContents: { id: 7 } } }, videoRequested: true, audioRequested: true }, (value) => { granted = value; });
  assert.strictEqual(granted.audio, 'loopback');
  assert.strictEqual(granted.video.id, 'capture-main-frame', 'loopback لم يستخدم mainFrame');
  audioDeps.displaySession.handler({ frame: { top: { webContents: { id: 7 } } }, videoRequested: true, audioRequested: false }, (value) => { granted = value; });
  assert.deepStrictEqual(granted, {}, 'طلب بلا صوت تجاوز بوابة opt-in');

  const captureWc = audioController.currentWebContents();
  assert.strictEqual(audioController.armMicrophone(audioStarted.session_id).ok, true);
  let permission = null;
  captureWc.session.requestHandler(captureWc, 'notifications', (value) => { permission = value; }, {});
  assert.strictEqual(permission, false, 'إذن غير الميكروفون فُتح');
  captureWc.session.requestHandler(captureWc, 'media', (value) => { permission = value; }, { mediaTypes: ['video'] });
  assert.strictEqual(permission, false, 'إذن كاميرا فُتح');
  captureWc.session.requestHandler(captureWc, 'media', (value) => { permission = value; }, { mediaTypes: ['audio'] });
  assert.strictEqual(permission, true, 'منحة الميكروفون الأحادية لم تُفتح');
  captureWc.session.requestHandler(captureWc, 'media', (value) => { permission = value; }, { mediaTypes: ['audio'] });
  assert.strictEqual(permission, false, 'منحة الميكروفون استُعملت أكثر من مرة');
  audioController.rendererAbort(audioStarted.session_id, 'test_done');

  const noAudioEvents = [];
  const noAudioDeps = controllerDeps(path.join(tmp, 'no-audio'));
  fs.mkdirSync(noAudioDeps.downloadsPath, { recursive: true });
  const noAudio = promo.create(noAudioDeps);
  const noAudioStarted = await startReady(noAudio, { deps: noAudioDeps, events: noAudioEvents });
  assert.strictEqual(noAudioStarted.ok, true);
  const noAudioStart = noAudioEvents.find((item) => item.type === 'capture_start');
  assert.strictEqual(noAudioStart.audio, false, 'صوت النظام صار افتراضياً');
  noAudio.rendererAbort(noAudioStarted.session_id, 'test_done');

  console.log('promocapture-batch1: ok — الاستمرارية والذرية والمفقود والسقوف والتعقيم والمنارات وبوابتا الصوت');
}

main().then(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
