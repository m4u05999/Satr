#!/usr/bin/env node
'use strict';

// الحارس يستورد وحدة الإنتاج، ويعزل مسار الفيديو وMediaRecorder فقط.
// يثبت طلب الجودة والأبعاد المقروءة؛ لا يثبت معدل البت أو جودة الترميز الفعليين.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const high42 = 'video/mp4;codecs=avc1.64002A';
const high51 = 'video/mp4;codecs=avc1.640033';
const legacy = [
  { mime: 'video/mp4;codecs=avc1.42E01E', container: 'video/mp4', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1', container: 'video/mp4', ext: 'mp4' },
  { mime: 'video/mp4', container: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9', container: 'video/webm', ext: 'webm' },
  { mime: 'video/webm', container: 'video/webm', ext: 'webm' },
];
let cases = 0;
const trackData = new WeakMap();
let media;

function installMediaFakes() {
  const state = { videos: [], tracks: [], timers: new Map(), delays: [], play: 'ready', frame: 'ready' };
  let nextTimer = 0;
  globalThis.setTimeout = (callback, delay) => {
    const id = nextTimer++;
    state.timers.set(id, callback);
    state.delays.push(delay);
    return id;
  };
  globalThis.clearTimeout = (id) => state.timers.delete(id);
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; state.tracks.push(...tracks); }
  };
  globalThis.document = {
    createElement(tag) {
      assert.strictEqual(tag, 'video');
      const video = {
        muted: false, srcObject: null, videoWidth: 0, videoHeight: 0,
        paused: 0, cancelled: [], frameRequests: 0, pendingFrame: null,
        play() {
          assert.strictEqual(this.muted, true);
          assert(this.srcObject instanceof MediaStream);
          if (state.play === 'fail') return Promise.reject(new Error('private play failure'));
          if (state.play === 'pending') return new Promise(resolve => { this.resolvePlay = resolve; });
          return Promise.resolve();
        },
        requestVideoFrameCallback(callback) {
          this.frameRequests += 1;
          const track = this.srcObject.tracks[0];
          this.pendingFrame = () => {
            const data = trackData.get(track);
            if (data) data.frameSeen = true;
            this.videoWidth = data ? data.frame && data.frame.width : 1920;
            this.videoHeight = data ? data.frame && data.frame.height : 1080;
            this.pendingFrame = null;
            callback(0, {});
          };
          if (state.frame === 'ready') queueMicrotask(() => { if (this.pendingFrame) this.pendingFrame(); });
          return 0;
        },
        cancelVideoFrameCallback(id) { this.cancelled.push(id); this.pendingFrame = null; },
        pause() { this.paused += 1; },
      };
      state.videos.push(video);
      return video;
    },
  };
  return state;
}

const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function fixture(settings = { width: 1920, height: 1080, resizeMode: 'none' }, frame = settings) {
  const calls = [];
  let applied = false;
  let hint = '';
  const track = {
    async applyConstraints(value) {
      calls.push(['applyConstraints', value]);
      await Promise.resolve();
      applied = true;
    },
    set contentHint(value) { hint = value; calls.push(['contentHint', value]); },
    get contentHint() { return hint; },
    getSettings() {
      calls.push(['getSettings']);
      assert(trackData.get(track).frameSeen, 'يجب انتظار أول إطار قبل قراءة إعدادات المسار');
      return applied ? settings : { width: 1280, height: 720, resizeMode: 'crop-and-scale' };
    },
    stop() { trackData.get(track).stops += 1; },
  };
  trackData.set(track, { frame, frameSeen: false, stops: 0 });
  return { track, calls };
}

function recorderSupport(mimes = [high42]) {
  const queries = [];
  window.MediaRecorder = { isTypeSupported(mime) { queries.push(mime); return mimes.includes(mime); } };
  return queries;
}

async function test(name, run) {
  try {
    media = installMediaFakes();
    recorderSupport();
    await run();
    assert.strictEqual(media.timers.size, 0, 'يجب تنظيف مهلة القياس');
    for (const video of media.videos) {
      assert.strictEqual(video.paused, 1, 'يجب إيقاف عنصر القياس');
      assert.strictEqual(video.srcObject, null, 'يجب فصل المسار المستعار');
    }
    for (const track of media.tracks) {
      const data = trackData.get(track);
      if (data) assert.strictEqual(data.stops, 0, 'التنظيف لا يوقف مسار المسجّل');
    }
    cases += 1;
  } catch (error) {
    throw new Error(name + ': ' + (error && error.stack || error));
  }
}

async function rejects(prepare, track, code) {
  await assert.rejects(prepare(track), (error) => {
    assert.strictEqual(error.code, code, 'رمز الفشل يجب أن يكون ثابتاً');
    assert.strictEqual(error.message, code, 'تفاصيل الخطأ الأصلية لا تعبر إلى المستدعي');
    return true;
  });
}

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/lib/media-recorder.js'), 'utf8');
  const { prepareAppRecording, pickRecMime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  // أبعاد الطلب الافتراضية معلومة؛ يظل التحقق والحساب داخل دالة الإنتاج المستوردة.
  const prepare = (track, pixels = { width: 1920, height: 1080 }) => prepareAppRecording(track, pixels);

  for (const pixels of [undefined, null, false, '1920x1080', [], {}]) {
    await test('رفض شكل pixels قبل طلب الالتقاط: ' + String(pixels), async () => {
      const f = fixture();
      await rejects((track) => prepareAppRecording(track, pixels), f.track, 'bad_capture_dimensions');
      assert.deepStrictEqual(f.calls, [], 'الأبعاد المطلوبة الفاسدة يجب أن تُرفض قبل طلب الالتقاط');
    });
  }
  for (const dimension of ['width', 'height']) {
    for (const value of [undefined, 0, -1, 1.5, '1920', NaN, Infinity, 10001]) {
      await test('رفض بعد pixels قبل الالتقاط ' + dimension + ': ' + String(value), async () => {
        const f = fixture();
        const pixels = { width: 1920, height: 1080, [dimension]: value };
        await rejects((track) => prepareAppRecording(track, pixels), f.track, 'bad_capture_dimensions');
        assert.deepStrictEqual(f.calls, [], 'الأبعاد المطلوبة الفاسدة يجب أن تُرفض قبل طلب الالتقاط');
      });
    }
  }

  await test('القيود تسبق hint وقراءة الأبعاد وتُنتظر حتى الاكتمال', async () => {
    const f = fixture();
    const result = await prepare(f.track);
    assert.deepStrictEqual(f.calls, [
      ['applyConstraints', { resizeMode: { exact: 'none' }, width: { exact: 1920 }, height: { exact: 1080 } }],
      ['contentHint', 'detail'],
      ['getSettings'],
    ]);
    assert.strictEqual(f.track.contentHint, 'detail');
    assert.deepStrictEqual(result.capture, { width: 1920, height: 1080 },
      'الأبعاد يجب أن تأتي من المسار بعد القيود، لا من الالتقاط المصغّر السابق');
    assert.deepStrictEqual(result.format, { mime: high42, container: 'video/mp4', ext: 'mp4' });
    assert.deepStrictEqual(result.options, { videoBitsPerSecond: 24883200, mimeType: high42 });
  });
  await test('قيود 2360×1600 تطلب البكسلات الفعلية لمساحة العرض', async () => {
    const pixels = { width: 2360, height: 1600 };
    const f = fixture({ ...pixels, resizeMode: 'none' });
    const result = await prepare(f.track, pixels);
    assert.deepStrictEqual(f.calls[0], ['applyConstraints', { resizeMode: { exact: 'none' },
      width: { exact: 2360 }, height: { exact: 1600 } }]);
    assert.deepStrictEqual(result.capture, { width: 2360, height: 1600 });
    assert.strictEqual(result.options.videoBitsPerSecond, 45312000);
  });
  await test('السجل يعتمد 760 الفعلية عند طلب ارتفاع 761', async () => {
    const pixels = { width: 1164, height: 761 };
    const f = fixture({ width: 1164, height: 761, resizeMode: 'none' }, { width: 1164, height: 760 });
    const result = await prepare(f.track, pixels);
    assert.deepStrictEqual(f.calls[0], ['applyConstraints', { resizeMode: { exact: 'none' },
      width: { exact: 1164 }, height: { exact: 761 } }]);
    assert.deepStrictEqual(result.capture, { width: 1164, height: 760 },
      'تقريب صف واحد في المسار يجب أن يُحفظ كما قيس، لا أن يُستبدل بالطلب');
  });
  await test('مهلة تشغيل الفيديو تنظف العنصر ولا تسجل callback متأخراً', async () => {
    media.play = 'pending';
    const f = fixture();
    const rejected = rejects(prepare, f.track, 'native_capture_unavailable');
    await flush();
    assert.deepStrictEqual(media.delays, [3000], 'مهلة واحدة تحصر التشغيل والإطار معاً');
    const video = media.videos[0];
    assert.strictEqual(video.frameRequests, 0);
    assert.strictEqual(media.timers.size, 1);
    media.timers.values().next().value();
    await rejected;
    video.resolvePlay();
    await flush();
    assert.strictEqual(video.frameRequests, 0, 'انتهاء play بعد المهلة لا يعيد تسجيل callback');
  });
  await test('مهلة أول إطار تلغي callback حتى حين يكون معرّفه صفراً', async () => {
    media.frame = 'pending';
    const f = fixture();
    const rejected = rejects(prepare, f.track, 'native_capture_unavailable');
    await flush();
    assert.deepStrictEqual(media.delays, [3000], 'play والإطار يشتركان في المهلة نفسها');
    const video = media.videos[0];
    assert.strictEqual(video.frameRequests, 1);
    assert.strictEqual(media.timers.size, 1);
    media.timers.values().next().value();
    await rejected;
    assert.deepStrictEqual(video.cancelled, [0]);
    assert.strictEqual(video.pendingFrame, null);
  });
  await test('فشل play ينظف العنصر وينقّي الخطأ', async () => {
    media.play = 'fail';
    const f = fixture();
    await rejects(prepare, f.track, 'native_capture_unavailable');
    assert.strictEqual(media.videos[0].frameRequests, 0);
  });
  for (const [name, track] of [
    ['مسار مفقود', null],
    ['قيود غير متاحة', {}],
    ['رفض القيود', { applyConstraints: async () => { throw new Error('private device failure'); } }],
    ['إعدادات غير متاحة', { applyConstraints: async () => {} }],
    ['فشل قراءة الإعدادات', { applyConstraints: async () => {}, getSettings() { throw new Error('private device failure'); } }],
    ['فشل كتابة hint', { applyConstraints: async () => {}, set contentHint(value) { throw new Error('private device failure'); } }],
  ]) {
    await test(name, () => rejects(prepare, track, 'native_capture_unavailable'));
  }
  for (const resizeMode of ['crop-and-scale', undefined, '', true]) {
    await test('رفض resizeMode غير الأصلي: ' + String(resizeMode), () => rejects(prepare,
      fixture({ width: 1920, height: 1080, resizeMode }).track, 'native_capture_unavailable'));
  }
  await test('الإعدادات الفارغة لا تثبت التقاطاً أصلياً', () => rejects(prepare,
    fixture(null).track, 'native_capture_unavailable'));
  for (const dimension of ['width', 'height']) {
    for (const value of [undefined, 0, -1, 1.5, '1920', NaN, Infinity, 10001]) {
      await test('رفض البعد الفاسد ' + dimension + ': ' + String(value), () => rejects(prepare,
        fixture({ width: 1920, height: 1080, resizeMode: 'none', [dimension]: value }).track, 'bad_capture_dimensions'));
    }
  }
  await test('أفضلية H.264 High 4.2', async () => {
    const queries = recorderSupport([high42, high51, ...legacy.map((item) => item.mime)]);
    const result = await prepare(fixture().track);
    assert.strictEqual(result.format.mime, high42);
    assert.deepStrictEqual(queries, [high42]);
  });
  await test('السقوط إلى H.264 High 5.1', async () => {
    const queries = recorderSupport([high51, ...legacy.map((item) => item.mime)]);
    const result = await prepare(fixture().track);
    assert.strictEqual(result.format.mime, high51);
    assert.strictEqual(result.options.mimeType, high51);
    assert.deepStrictEqual(queries, [high42, high51]);
  });
  for (const [index, expected] of legacy.entries()) {
    await test('السقوط إلى الصيغة القائمة: ' + expected.mime, async () => {
      const queries = recorderSupport([expected.mime]);
      const result = await prepare(fixture().track);
      assert.deepStrictEqual(result.format, expected);
      assert.strictEqual(result.options.mimeType, expected.mime);
      assert.deepStrictEqual(queries, [high42, high51, ...legacy.slice(0, index + 1).map((item) => item.mime)]);
    });
  }
  await test('اختيار المتصفح الافتراضي لا يمرر mimeType فارغاً', async () => {
    recorderSupport([]);
    const result = await prepare(fixture().track);
    assert.deepStrictEqual(result.format, { mime: '', container: 'video/webm', ext: 'webm' });
    assert.deepStrictEqual(result.options, { videoBitsPerSecond: 24883200 });
  });
  await test('الصيغة المشتركة القائمة تحتفظ بأفضليتها', async () => {
    const queries = recorderSupport([high42, high51, ...legacy.map((item) => item.mime)]);
    assert.deepStrictEqual(pickRecMime(), legacy[0]);
    assert.deepStrictEqual(queries, [legacy[0].mime]);
  });
  for (const [width, height, bitrate] of [
    [1, 1, 24000000],
    [1280, 720, 24000000],
    [1920, 1080, 24883200],
    [2560, 1440, 44236800],
    [3840, 2160, 80000000],
    [10000, 10000, 80000000],
  ]) {
    await test('معدل البت المطلوب للأبعاد ' + width + '×' + height, async () => {
      const result = await prepare(fixture({ width, height, resizeMode: 'none' }).track, { width, height });
      assert.deepStrictEqual(result.capture, { width, height });
      assert.strictEqual(result.options.videoBitsPerSecond, bitrate);
      assert(Number.isSafeInteger(result.options.videoBitsPerSecond));
    });
  }
}

const originalGlobals = new Map(['window', 'document', 'MediaStream', 'setTimeout', 'clearTimeout']
  .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
(async () => {
  try {
    await main();
    process.stdout.write('app-recording-quality: ok — ' + cases + ' حالات\n');
  } catch (error) {
    process.exitCode = 1;
    console.error('app-recording-quality: FAIL — ' + (error && error.stack || error));
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
})();
