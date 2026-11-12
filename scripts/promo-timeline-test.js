// حارس الخط الزمني للإعلان — اختبارات قطعية لـ src/ui/lib/promo/promo-timeline.js
// ولسقف المدة الإجمالية في electron/promostudio.js، ولعقد الحتمية في promo-frame.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

(async () => {
  const timelineModule = await import('../src/ui/lib/promo/promo-timeline.js');
  const { buildTimeline, sceneAt, frameCount, frameTimeMs, fadeOpacity, MAX_TOTAL_MS } = timelineModule;
  const studio = require('../electron/promostudio');

  // ── حدود المشاهد ──
  const board = { scenes: [
    { duration_ms: 2000, trim_start_ms: 500, transition: 'cut' },
    { duration_ms: 3000, trim_start_ms: 0, transition: 'fade' },
    { duration_ms: 1500, transition: 'fade' },
  ] };
  const timeline = buildTimeline(board);
  eq(timeline.totalMs, 6500, 'المجموع');
  eq(timeline.scenes.map((s) => [s.startMs, s.endMs, s.sourceStartMs]), [[0, 2000, 500], [2000, 5000, 0], [5000, 6500, 0]], 'الحدود');
  eq(timeline.overLimit, false, 'تحت السقف');
  eq(sceneAt(timeline, 0).entry.index, 0, 'البداية');
  eq(sceneAt(timeline, 1999.999).entry.index, 0, 'قبل الحد');
  eq(sceneAt(timeline, 2000).entry.index, 1, 'الحد ينتمي للمشهد التالي');
  eq(sceneAt(timeline, 2000).localMs, 0, 'الزمن المحلي عند الحد');
  eq(sceneAt(timeline, 1000).sourceMs, 1500, 'زمن المصدر يضيف القص');
  eq(sceneAt(timeline, 6500).entry.index, 2, 'النهاية تُنسب لآخر مشهد');
  eq(sceneAt(timeline, 6500).localMs, 1500, 'النهاية عند آخر لحظة');
  eq(sceneAt(timeline, 99999).entry.index, 2, 'بعد النهاية');
  eq(sceneAt(timeline, -5).entry.index, 0, 'السالب يُقصّ إلى الصفر');
  eq(sceneAt(timeline, NaN), null, 'NaN');
  eq(sceneAt(buildTimeline({ scenes: [] }), 0), null, 'بلا مشاهد');
  eq(buildTimeline(null).totalMs, 0, 'مدخل فارغ');
  eq(buildTimeline({ scenes: [{ duration_ms: 0 }, { duration_ms: 1000 }] }).scenes.map((s) => s.index), [1], 'المدة الصفرية تُتخطى ويبقى الفهرس الأصلي');

  // ── الإطارات ──
  eq(frameCount(10000, 30), 300, '10 ثوانٍ × 30');
  eq(frameCount(60000, 60), 3600, '60 ثانية × 60');
  eq(frameCount(6500, 30), 195, 'مدة غير صحيحة');
  eq(frameTimeMs(0, 30), 0, 'الإطار الأول');
  ok(Math.abs(frameTimeMs(299, 30) - 9966.6667) < 0.001, 'آخر إطار قبل النهاية');
  for (let i = 0; i < 195; i += 1) {
    const placement = sceneAt(timeline, frameTimeMs(i, 30));
    assert.ok(placement && placement.localMs < placement.entry.durationMs, 'كل إطار داخل مشهده: ' + i);
  }
  checks += 1;

  // ── التلاشي ──
  eq(fadeOpacity('cut', 0, 3000), 0, 'القطع بلا غطاء');
  eq(fadeOpacity('fade', 0, 3000), 1, 'بداية التلاشي');
  eq(fadeOpacity('fade', 250, 3000), 0.5, 'منتصف الحافة');
  eq(fadeOpacity('fade', 1500, 3000), 0, 'الوسط');
  eq(fadeOpacity('fade', 2750, 3000), 0.5, 'حافة الخروج');
  eq(fadeOpacity('fade', 100, 600), 0.5, 'الحافة ثلث المشهد القصير');

  // ── السقف: الثابتان متطابقان، والتنقية ترفض، والتحميل يتسامح ──
  eq(MAX_TOTAL_MS, 180000, 'السقف 180 ثانية');
  eq(studio.MAX_TOTAL_MS, MAX_TOTAL_MS, 'ثابت main يطابق ثابت الواجهة');
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-timeline-'));
  try {
    const clip = path.join(downloads, 'clip.mp4');
    fs.writeFileSync(clip, 'x');
    const scenes = (count, ms) => Array.from({ length: count }, () => ({ asset: clip, duration_ms: ms }));
    const options = { downloadsPath: downloads };
    eq(studio.sanitizeStoryboard({ scenes: scenes(2, 90000) }, options).ok, true, '180 ثانية بالضبط مقبولة');
    const over = studio.sanitizeStoryboard({ scenes: scenes(2, 90001) }, options);
    eq([over.ok, over.error, over.total_ms], [false, 'bad_total_duration', 180002], 'فوق السقف مرفوض');
    eq(studio.sanitizeStoryboard({ scenes: scenes(40, 4500) }, options).ok, true, '40 مشهداً × 4.5 ثانية');
    eq(studio.sanitizeStoryboard({ scenes: scenes(40, 4501) }, options).error, 'bad_total_duration', '40 مشهداً فوق السقف');
    eq(studio.sanitizeStoryboard({ scenes: scenes(2, 120000) }, { ...options, allowMissingAssets: true }).ok, true, 'التحميل يفتح مشروعاً قديماً طويلاً');
    const controller = studio.create({ downloadsPath: downloads });
    eq(controller.propose({ scenes: scenes(3, 70000) }).error, 'bad_total_duration', 'اقتراح الوكيل الطويل مرفوض');
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
  }

  // ── عقد الحتمية: لا ساعة ولا قراءة لزمن الفيديو في وحدتي الرسم ──
  for (const name of ['promo-timeline.js', 'promo-frame.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'lib', 'promo', name), 'utf8')
      .replace(/\/\/[^\n]*/g, '');
    for (const banned of ['Date.now', 'performance.now', 'currentTime', 'requestAnimationFrame', 'Math.random', 'new Date']) {
      ok(!source.includes(banned), name + ' لا يستعمل ' + banned);
    }
  }

  // ── renderFrame بسياق مسجِّل: نفس المدخل ⇒ نفس سلسلة أوامر الرسم ──
  const { renderFrame } = await import('../src/ui/lib/promo/promo-frame.js');
  const recorder = () => {
    const log = [];
    const context = new Proxy({ measureText: (text) => ({ width: String(text).length * 20 }) }, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === '__log') return log;
        return (...args) => { log.push([String(key), ...args.map((arg) => (typeof arg === 'object' ? 'obj' : arg))]); };
      },
      set(target, key, value) { log.push(['set', String(key), value]); return true; },
    });
    return context;
  };
  const runtime = { width: 1920, height: 1080, colors: { background: '#000', captionBackground: '#111', captionText: '#fff' }, timeline: buildTimeline({ scenes: [
    { duration_ms: 2000, transition: 'fade', fit: 'contain', caption: 'مرحباً Satr', caption_position: 'top', caption_style: 'box' },
    { duration_ms: 1000, transition: 'cut', fit: 'cover', caption: '' },
  ] }) };
  const frames = new Map([[0, { source: {}, width: 800, height: 600 }], [1, { source: {}, width: 1600, height: 900 }]]);
  const a = recorder(), b = recorder();
  const first = renderFrame(a, runtime, 100, frames);
  renderFrame(b, runtime, 2500, frames);
  const length = b.__log.length;
  const second = renderFrame(b, runtime, 100, frames);
  eq(b.__log.slice(length), a.__log, 'سلسلة الرسم لا تعتمد على استدعاء سابق');
  eq(first, second, 'القيمة المعادة متطابقة');
  eq([first.index, first.drawn, first.captionLines], [0, true, 1], 'المشهد الأول مرسوم بتسمية');
  const contain = a.__log.find((entry) => entry[0] === 'drawImage');
  eq(contain.slice(2), [240, 0, 1440, 1080], 'contain يحافظ على النسبة داخل اللوحة');
  const cover = recorder();
  const coverResult = renderFrame(cover, runtime, 2500, frames);
  eq(cover.__log.find((entry) => entry[0] === 'drawImage').slice(2), [0, 0, 1920, 1080], 'cover يملأ اللوحة');
  eq(coverResult.captionLines, 0, 'بلا تسمية');
  eq(renderFrame(recorder(), runtime, 100, new Map()).drawn, false, 'غياب الإطار ⇒ خلفية فقط');
  eq(renderFrame(recorder(), { ...runtime, timeline: buildTimeline({ scenes: [] }) }, 0, frames), null, 'بلا مشاهد');

  console.log('promo-timeline-test: ok — ' + checks + ' فحصاً (الحدود، الإطارات، التلاشي، سقف 180 ثانية، عقد الحتمية).');
})().catch((error) => {
  console.error('promo-timeline-test:', error && error.stack ? error.stack : error);
  process.exit(1);
});
