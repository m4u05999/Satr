#!/usr/bin/env node
'use strict';

// حارس دورة تسجيل نافذة سطر: النافذة وهمية، لكن controller والسجل إنتاجيان.
// لا يثبت ترميز فيديو أو تنزيل Electron حقيقياً؛ ذلك مسؤولية الفحص الحي.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const promo = require('../electron/promocapture');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-app-window-'));
const owners = new WeakMap();
const fixtures = [];
const testRun = 'live_0123456789abcdef01234567';
let cases = 0;
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeWindow extends EventEmitter {
  constructor(id = 41) {
    super();
    this.id = id;
    this.title = 'سطر — Satr';
    this.destroyed = false;
    this.visible = true;
    this.effects = [];
    this.bounds = { x: 24, y: 30, width: 1180, height: 800 };
    this.session = {
      setDisplayMediaRequestHandler: () => this.effects.push('display-permission'),
      setPermissionRequestHandler: () => this.effects.push('permission-request'),
      setPermissionCheckHandler: () => this.effects.push('permission-check'),
    };
    this.webContents = { id, mainFrame: { id: 'frame-' + id }, session: this.session,
      isDestroyed: () => this.destroyed };
    owners.set(this.webContents, this);
  }
  static fromWebContents(contents) { return owners.get(contents) || null; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getTitle() { return this.title; }
  getBounds() { return { ...this.bounds }; }
  getMediaSourceId() { return 'window:' + this.id + ':1'; }
  loadURL() { this.effects.push('loadURL'); return Promise.resolve(); }
  loadFile() { this.effects.push('loadFile'); return Promise.resolve(); }
  setContentSize() { this.effects.push('resize'); }
  setBounds() { this.effects.push('bounds'); }
  setSize() { this.effects.push('size'); }
  show() { this.effects.push('show'); }
  destroy() { this.effects.push('destroy'); this.destroyed = true; this.emit('closed'); }
  closeByOwner() { this.destroyed = true; this.emit('closed'); }
}

function fixture({ enumerate = true, ready = true, readySync = false,
  capture = { width: 1180, height: 800 } } = {}) {
  const window = new FakeWindow();
  const downloads = path.join(tempRoot, 'fixture-' + fixtures.length);
  fs.mkdirSync(downloads);
  const effects = [];
  const events = [];
  const queries = [];
  const pending = [];
  let controller;
  controller = promo.create({
    BrowserWindow: FakeWindow, ownerWebContents: window.webContents,
    displaySession: window.session, downloadsPath: downloads,
    eventRoot: path.join(downloads, 'events'), readyDelayMs: 0, sourceAttempts: 1,
    isHttpUrl: (url) => /^https?:\/\//.test(url),
    desktopCapturer: { getSources: async (query) => {
      queries.push(query);
      return enumerate ? [
        { id: 'window:99:0', name: window.title },
        { id: 'screen:1:0', name: window.title },
        { id: 'window:41:0', name: window.title },
      ] : [];
    } },
    onTarget: () => effects.push('onTarget'),
    setEventSink: () => effects.push('eventSink'),
    showBeacon: async () => { effects.push('beacon'); return { ok: false }; },
    emit(event) {
      events.push(event);
      if (ready && event.type === 'capture_start') {
        const notifyReady = () => event.target_kind === 'app-window'
          ? controller.rendererReady(event.session_id, true, '', capture)
          : controller.rendererReady(event.session_id, true, '');
        pending.push(readySync ? notifyReady() : Promise.resolve().then(notifyReady));
      }
    },
  });
  const result = { window, controller, downloads, effects, events, queries, pending };
  fixtures.push(result);
  return result;
}

function options(extra = {}) {
  return { confirmed: true, testRun, scenario: 'send-message', ...extra };
}
async function start(f, extra) {
  const result = await f.controller.startAppWindow(f.window, options(extra));
  assert.strictEqual(result.ok, true, 'نافذة المالك المرئية يجب أن تبدأ التسجيل');
  await Promise.all(f.pending);
  return result;
}
async function save(f, pendingStop) {
  await tick();
  const event = f.events.filter((item) => item.type === 'capture_stop').at(-1);
  assert(event, 'الإيقاف يجب أن يطلب إنهاء MediaRecorder');
  const filename = promo.segmentFilename(event.session_id, new Date('2026-09-09T12:00:00Z'), 'webm');
  const file = promo.uniqueSegmentPath(f.downloads, filename);
  assert(file && promo.isInsideDownloads(f.downloads, file), 'ملف العينة محصور بالمجلد المؤقت');
  assert.deepStrictEqual(f.controller.rendererCommit(event.session_id, 1234, filename), { ok: true });
  // محاكاة إشعار اكتمال التنزيل، وليست دعوى وجود فيديو قابل لفك الترميز.
  fs.writeFileSync(file, Buffer.from('fake-download-completed'));
  assert.strictEqual(f.controller.downloadResult({ type: 'promo_recording_saved', filename, path: file }), true);
  return pendingStop;
}
async function test(name, run) {
  await run();
  cases += 1;
  process.stdout.write('ok ' + cases + ' — ' + name + '\n');
}

async function main() {
  await test('الإقرار الصريح مطلوب لكل بدء', async () => {
    const f = fixture();
    for (const confirmed of [false, undefined, 1, 'true']) {
      assert.deepStrictEqual(await f.controller.startAppWindow(f.window, options({ confirmed })),
        { ok: false, error: 'confirmation_required' });
    }
    assert.strictEqual(f.events.length, 0);
    assert.strictEqual(f.queries.length, 0);
  });
  await test('هوية نافذة المالك تتغلب على العنوان والمعرف المنسوخ', async () => {
    const f = fixture();
    for (const other of [new FakeWindow(99), new FakeWindow(41), null]) {
      assert.deepStrictEqual(await f.controller.startAppWindow(other, options()), { ok: false, error: 'bad_window' });
    }
    f.window.visible = false;
    assert.deepStrictEqual(await f.controller.startAppWindow(f.window, options()), { ok: false, error: 'bad_window' });
    f.window.visible = true;
    f.window.destroyed = true;
    assert.deepStrictEqual(await f.controller.startAppWindow(f.window, options()), { ok: false, error: 'bad_window' });
    assert.strictEqual(f.queries.length, 0);
  });
  await test('الصوت ومعرفات السيناريو غير الصالحة مرفوضة', async () => {
    const f = fixture();
    for (const extra of [{ audio: 'loopback' }, { microphone: true }, { testRun: '../escape' },
      { scenario: '../escape' }, { scenario: '' }]) {
      assert.deepStrictEqual(await f.controller.startAppWindow(f.window, options(extra)), { ok: false, error: 'bad_input' });
    }
    assert.strictEqual(f.events.length, 0);
  });
  await test('المصدر حصري والأبعاد أصلية ومسار المعاينة لا يتغير', async () => {
    const f = fixture();
    await start(f);
    const event = f.events.find((item) => item.type === 'capture_start');
    assert.strictEqual(event.source_id, 'window:41:0');
    assert.strictEqual(event.target_kind, 'app-window');
    assert.strictEqual(event.aspect, 'native');
    assert.strictEqual(event.width, 1180);
    assert.strictEqual(event.height, 800);
    assert.strictEqual(event.audio, false);
    assert.strictEqual(event.microphone, false);
    assert.deepStrictEqual(f.queries[0].types, ['window']);
    assert.strictEqual(f.controller.currentWebContents(), null);
    assert.deepStrictEqual(f.window.effects, [], 'التسجيل لا يحمل أو يصغر النافذة ولا يعدل أذوناتها');
    assert.deepStrictEqual(f.effects, [], 'التسجيل لا يغير onTarget أو eventSink ولا يحقن منارة');
  });
  await test('قياس الفيديو الغائب أو المشوه لا يعلن جاهزية تسجيل النافذة', async () => {
    const f = fixture({ ready: false });
    const started = f.controller.startAppWindow(f.window, options());
    await tick();
    const event = f.events.find((item) => item.type === 'capture_start');
    assert(event, 'يجب طلب الالتقاط قبل استقبال قياس الفيديو');
    for (const capture of [undefined, null, false, 1920, '1920x1080', [], {},
      { width: 1920 }, { height: 1080 }, { width: '1920', height: 1080 },
      { width: 1920, height: '1080' }, { width: 0, height: 1080 }, { width: 1920, height: 0 },
      { width: -1, height: 1080 }, { width: 1920, height: -1 },
      { width: 10001, height: 1080 }, { width: 1920, height: 10001 },
      { width: 1920.5, height: 1080 }, { width: 1920, height: 1080.5 },
      { width: Infinity, height: 1080 }, { width: 1920, height: NaN }]) {
      assert.deepStrictEqual(await f.controller.rendererReady(event.session_id, true, '', capture),
        { ok: false, error: 'bad_input' });
    }
    assert(!f.events.some((item) => item.type === 'capture_active'), 'القياس المرفوض لا يعلن بدء التسجيل');
    assert.strictEqual(f.controller.listSegments().segments.length, 0, 'القياس المرفوض لا ينشئ مقطعاً');
    assert.deepStrictEqual(await f.controller.rendererReady(event.session_id, true, '', { width: 1920, height: 1080 }),
      { ok: true });
    assert.strictEqual((await started).ok, true, 'القياس الصحيح وحده يكمل طلب البدء');
  });
  await test('فشل renderer يقبل العقد القديم دون قياس فيديو', async () => {
    const f = fixture({ ready: false });
    const started = f.controller.startAppWindow(f.window, options());
    await tick();
    const event = f.events.find((item) => item.type === 'capture_start');
    assert.deepStrictEqual(await f.controller.rendererReady(event.session_id, false, 'media_failed'), { ok: true });
    assert.deepStrictEqual(await started, { ok: false, error: 'media_failed' });
    assert.strictEqual(f.window.isDestroyed(), false);
  });
  await test('نهاية دور المحرك تبقي التسجيل جاريا حتى الإيقاف الصريح', async () => {
    const f = fixture();
    await start(f);
    assert.deepStrictEqual(await f.controller.stopAll({ scope: 'run' }), { ok: true });
    assert.strictEqual(f.events.filter((item) => item.type === 'capture_stop').length, 0);
    assert.deepStrictEqual(await f.controller.startAppWindow(f.window, options()), { ok: false, error: 'busy' });
    assert.strictEqual(f.window.listenerCount('closed'), 1);
    const stopped = await save(f, f.controller.stop());
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(stopped.duration_ms, 1234);
    assert.strictEqual(f.window.listenerCount('closed'), 0);
    assert.deepStrictEqual(f.window.effects, []);
    assert.deepStrictEqual(await f.controller.stop(), { ok: false, error: 'not_recording' });
  });
  await test('الإيقاف الشامل يحفظ التسجيل دون إغلاق نافذة سطر', async () => {
    const f = fixture();
    await start(f);
    assert.deepStrictEqual(await save(f, f.controller.stopAll()), { ok: true });
    assert.strictEqual(f.window.isDestroyed(), false);
    assert.strictEqual(f.window.listenerCount('closed'), 0);
    assert.deepStrictEqual(f.window.effects, []);
    assert.deepStrictEqual(f.effects, []);
  });
  await test('الفشل يلغي التسجيل ويفك الربط دون إغلاق النافذة', async () => {
    const f = fixture();
    const started = await start(f);
    assert.deepStrictEqual(f.controller.rendererAbort(started.session_id, 'empty_recording'), { ok: true });
    assert.strictEqual(f.window.listenerCount('closed'), 0);
    assert.strictEqual(f.window.isDestroyed(), false);
    assert.deepStrictEqual(f.window.effects, []);
    assert.deepStrictEqual(await f.controller.stop(), { ok: false, error: 'not_recording' });
    await start(f, { scenario: 'retry' });
    assert.strictEqual(f.window.listenerCount('closed'), 1);
  });
  await test('إغلاق المالك للنافذة يفك listener وينهي الحالة', async () => {
    const f = fixture();
    await start(f);
    f.window.closeByOwner();
    assert.strictEqual(f.window.listenerCount('closed'), 0, 'إغلاق النافذة يجب أن يزيل listener الذي أضافه التسجيل');
    assert(f.events.some((item) => item.type === 'capture_closed'));
    assert.deepStrictEqual(await f.controller.stop(), { ok: false, error: 'not_recording' });
    assert.deepStrictEqual(f.window.effects, []);
  });
  await test('غياب المصدر المعدد يرجع لمعرف النافذة المملوكة وحدها', async () => {
    const f = fixture({ enumerate: false });
    await start(f);
    const event = f.events.find((item) => item.type === 'capture_start');
    assert.strictEqual(event.source_id, f.window.getMediaSourceId());
    assert.strictEqual(event.source_enumerated, false);
    assert.strictEqual(f.controller.currentWebContents(), null);
    assert.deepStrictEqual(f.window.effects, []);
  });
  await test('السجل يحفظ السيناريو والتشغيلة والأبعاد دون توقيت متحقق مختلق', async () => {
    const f = fixture();
    await start(f);
    await save(f, f.controller.stop());
    const reloaded = promo.create({ downloadsPath: f.downloads });
    const segments = reloaded.listSegments().segments;
    assert.strictEqual(segments.length, 1);
    const item = segments[0];
    assert.strictEqual(item.target_kind, 'app-window');
    assert.strictEqual(item.test_run, testRun);
    assert.strictEqual(item.scenario, 'send-message');
    assert.strictEqual(item.aspect, 'native');
    assert.strictEqual(item.width, 1180);
    assert.strictEqual(item.height, 800);
    assert.strictEqual(item.timing_quality, 'unverified');
    assert.strictEqual(item.auto_crop_eligible, false);
    assert.strictEqual(item.available, true);
    assert(promo.isInsideDownloads(f.downloads, item.path));
    assert(promo.isInsideDownloads(f.downloads, item.events_file));
  });
  await test('السجل يحفظ بكسلات الفيديو الفعلية ولو وصلت الجاهزية متزامنة', async () => {
    for (const readySync of [false, true]) {
      const f = fixture({ readySync, capture: { width: 1920, height: 1080 } });
      await start(f);
      const event = f.events.find((item) => item.type === 'capture_start');
      assert.strictEqual(event.width, 1180);
      assert.strictEqual(event.height, 800);
      await save(f, f.controller.stop());
      const segments = promo.create({ downloadsPath: f.downloads }).listSegments().segments;
      assert.strictEqual(segments.length, 1);
      assert.strictEqual(segments[0].width, 1920, 'عرض الفيديو المقاس يجب أن يغلب عرض النافذة المنطقي');
      assert.strictEqual(segments[0].height, 1080, 'ارتفاع الفيديو المقاس يجب أن يغلب ارتفاع النافذة المنطقي');
      assert.strictEqual(segments[0].aspect, 'native');
      assert.strictEqual(segments[0].target_kind, 'app-window');
    }
  });
  await test('انتهاء مهلة التنزيل يفك النافذة المستعارة قبل تسجيل ويب تال', async () => {
    const f = fixture();
    await start(f);
    const originalSetTimeout = globalThis.setTimeout;
    let expireDownload = null;
    let captured = 0;
    try {
      // نستدعي callback الإنتاج نفسه بلا انتظار ولا تغيير مدة الإنتاج.
      globalThis.setTimeout = (callback, duration, ...args) => {
        if (duration === 15000) {
          captured += 1;
          expireDownload = () => callback(...args);
          return 0;
        }
        return originalSetTimeout(callback, duration, ...args);
      };
      const stopped = f.controller.stop();
      await tick();
      assert.strictEqual(captured, 1, 'يجب التقاط مؤقت التنزيل الإنتاجي مرة واحدة');
      assert(f.events.some((item) => item.type === 'capture_stop'));
      expireDownload();
      assert.deepStrictEqual(await stopped, { ok: false, error: 'download_timeout' });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    assert.strictEqual(f.window.listenerCount('closed'), 0,
      'انتهاء مهلة التنزيل يجب أن يفك نافذة سطر المستعارة');
    assert.strictEqual(f.controller.currentWebContents(), null);
    assert.deepStrictEqual(f.window.effects, []);
    class ProductWindow extends FakeWindow {
      constructor() { super(51); }
    }
    // معالج displayMedia حق مشروع للمسجل؛ نعزله عن عداد آثار نافذة المالك.
    const recorderSession = new FakeWindow(52).session;
    f.controller.configure({ BrowserWindow: ProductWindow, displaySession: recorderSession });
    const webStarted = await f.controller.start({ url: 'http://localhost:3000' });
    assert.strictEqual(webStarted.ok, true);
    const webContents = f.controller.currentWebContents();
    assert(webContents && webContents !== f.window.webContents,
      'تسجيل الويب التالي يجب أن ينشئ نافذة منتج مستقلة');
    assert.deepStrictEqual(f.window.effects, [],
      'تسجيل الويب التالي لا يحمل أو يصغر أو يغلق نافذة سطر');
    assert.strictEqual(f.window.isDestroyed(), false);
    await f.controller.stopAll({ discard: true });
    assert.deepStrictEqual(f.window.effects, [], 'تنظيف المنتج لا يغلق نافذة سطر');
  });
}

(async () => {
  try {
    await main();
    process.stdout.write('promo-app-window: ok — ' + cases + ' حالات\n');
  } catch (error) {
    process.exitCode = 1;
    console.error('promo-app-window: FAIL — ' + (error && error.stack || error));
  } finally {
    for (const f of fixtures) await f.controller.stopAll({ discard: true });
    // هذا الجذر أنشأه الحارس بنفسه؛ لا يمس مجلد المشروع ولا أي تنزيل للمستخدم.
    const resolved = path.resolve(tempRoot);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      && path.basename(resolved).startsWith('satr-promo-app-window-'), 'رفض تنظيف جذر خارج temp');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})();