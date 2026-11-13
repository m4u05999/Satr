// اختبار حي للكاميرا الذكية: (أ) بكسلات renderFrame مع الزوم والمؤشر، (ب) واجهة الاستوديو.

import { buildTimeline } from '../../src/ui/lib/promo/promo-timeline.js';
import { renderFrame } from '../../src/ui/lib/promo/promo-frame.js';
import { pointerTrack } from '../../src/ui/lib/promo/promo-camera.js';

const TARGET = { x: 300, y: 200, width: 240, height: 120 };
const VIEWPORT = { width: 1920, height: 1080 };
const COLORS = { background: '#000000', captionBackground: '#000000', captionText: '#ffffff' };

async function makeSource() {
  const canvas = new OffscreenCanvas(1920, 1080);
  const context = canvas.getContext('2d');
  context.fillStyle = '#101820'; context.fillRect(0, 0, 1920, 1080);
  context.fillStyle = '#ff00ff'; context.fillRect(TARGET.x, TARGET.y, TARGET.width, TARGET.height);
  return { source: await createImageBitmap(canvas), width: 1920, height: 1080 };
}

function scan(canvas, test) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      if (test(data[i], data[i + 1], data[i + 2])) {
        count += 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return count ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count } : { count: 0 };
}
const magenta = (r, g, b) => r > 200 && g < 70 && b > 200;
const white = (r, g, b) => r > 235 && g > 235 && b > 235;

async function pixels() {
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail)); };
  const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;
  const image = await makeSource();
  const camera = { mode: 'manual', cursor: true, keyframes: [
    { t_ms: 0, x: 0.5, y: 0.5, zoom: 1, ease: 'hold' },
    { t_ms: 1000, x: 0.25, y: 0.25, zoom: 2, ease: 'inOut' },
    { t_ms: 3000, x: 0.25, y: 0.25, zoom: 2, ease: 'hold' },
  ] };
  const scene = { duration_ms: 4000, transition: 'cut', fit: 'cover', caption: '', camera };
  const frames = new Map([[0, image]]);
  const draw = (sceneValue, t, pointers, width = 1920, height = 1080) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    renderFrame(canvas.getContext('2d', { alpha: false }),
      { width, height, colors: COLORS, timeline: buildTimeline({ scenes: [sceneValue] }), pointers }, t, frames);
    return canvas;
  };
  const start = scan(draw(scene, 0), magenta);
  expect('الزوم 1 يطابق الموضع الأصلي', near(start.x, 300) && near(start.y, 200) && near(start.width, 240) && near(start.height, 120), start);
  const zoomed = scan(draw(scene, 1000), magenta);
  expect('الزوم 2 يضاعف العنصر ويضعه في مكانه المحسوب', near(zoomed.x, 600) && near(zoomed.y, 400) && near(zoomed.width, 480) && near(zoomed.height, 240), zoomed);
  const middle = scan(draw(scene, 500), magenta);
  expect('منتصف الحركة بين الحالتين', middle.width > 250 && middle.width < 470, middle);
  const held = scan(draw(scene, 2500), magenta);
  expect('الإمساك يثبّت اللقطة', near(held.x, 600) && near(held.width, 480), held);
  const off = scan(draw({ ...scene, camera: { ...camera, mode: 'off' } }, 1000), magenta);
  expect('الوضع off يلغي الزوم', near(off.x, 300) && near(off.width, 240), off);
  const portrait = scan(draw({ ...scene, fit: 'contain' }, 1000, null, 1080, 1920), magenta);
  expect('contain في لوحة عمودية: العنصر مكبَّر وداخل اللوحة', portrait.count > 0 && portrait.width > 240 * (1080 / 1920) * 1.5 && portrait.x >= 0 && portrait.x + portrait.width <= 1080, portrait);

  // المؤشر الاصطناعي: نقرة عند مركز الزر عند t=1000.
  const track = pointerTrack([{ t_ms: 1000, kind: 'pointer', action: 'mousedown', pointer: { x: 420, y: 260, button: 0 }, viewport: VIEWPORT }],
    { durationMs: 4000, sourceStartMs: 0 });
  const pointers = new Map([[0, track]]);
  const without = scan(draw(scene, 1100), white);
  const withPointer = scan(draw(scene, 1100, pointers), white);
  expect('لا بياض بلا مؤشر', without.count === 0, without);
  // مركز الزر (420,260) بعد زوم 2 مع tx=ty=0 ⇒ (840,520)
  expect('المؤشر مرسوم عند موضع النقرة بعد الكاميرا', withPointer.count > 80 && withPointer.x <= 845 && withPointer.x + withPointer.width >= 840
    && withPointer.y <= 525 && withPointer.y + withPointer.height >= 520, withPointer);
  const before = scan(draw(scene, 900, pointers), white);
  expect('لا مؤشر قبل أول حدث', before.count === 0, before);
  const hidden = scan(draw({ ...scene, camera: { ...camera, cursor: false } }, 1100, pointers), white);
  expect('cursor:false يخفي المؤشر', hidden.count === 0, hidden);
  const first = draw(scene, 1100, pointers), second = draw(scene, 1100, pointers);
  const a = first.getContext('2d').getImageData(0, 0, 1920, 1080).data, b = second.getContext('2d').getImageData(0, 0, 1920, 1080).data;
  let diff = 0; for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  expect('الإطار مع الكاميرا والمؤشر حتمي', diff === 0, { diff });
  return failures;
}

async function ui() {
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };
  const asset = 'C:\\Downloads\\satr-promo-segment-test.mp4';
  const events = [
    { t_ms: 1500, kind: 'pointer', source: 'human', action: 'mousedown', rect: TARGET, pointer: { x: 420, y: 260, button: 0 }, viewport: VIEWPORT, timing_quality: 'verified' },
    { t_ms: 7000, kind: 'action', source: 'agent', action: 'click', target_ref: 's1:e2', rect: { x: 1400, y: 700, width: 200, height: 80 }, pointer: null, viewport: VIEWPORT, timing_quality: 'verified' },
  ];
  let eventCalls = 0;
  window.satr = {
    promoStudioState: async () => ({ ok: true, storyboard: null, segments: [{ path: asset, duration_ms: 9000, aspect: '16:9' }] }),
    promoAssetUrl: async () => ({ ok: false }),
    promoSegmentEvents: async (path) => { eventCalls += 1; return path === asset ? { ok: true, events } : { ok: false, error: 'not_a_segment' }; },
    promoListDownloads: async () => ({ ok: true, files: [] }),
    promoCaptureStart: async () => ({ ok: true }), promoCaptureStop: async () => ({ ok: true }),
    onPromoCapture() { return () => {}; },
  };
  await import('../../src/ui/components/promo-studio.js');
  const studio = document.querySelector('satr-promo-studio');
  await studio.open();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  await settle();
  const root = studio.shadowRoot;
  const card = () => root.querySelector('.scene[data-index="0"]');
  const scene = () => studio.getStoryboard().scenes[0];

  expect('الأحداث طُلبت مرة واحدة للمقطع', eventCalls === 1, eventCalls);
  expect('مقطع جديد يأخذ كاميرا تلقائية', scene().camera.mode === 'auto' && scene().camera.keyframes.length > 2, scene().camera);
  expect('نقطة لكل مفتاح على الشريط', card().querySelectorAll('.cam-key').length === scene().camera.keyframes.length, card().querySelectorAll('.cam-key').length);
  expect('اقتراح قصّ الخمول ظاهر', card().querySelectorAll('[data-action="cut-gap"]').length >= 1);
  expect('لا محرر قبل التحديد', !card().querySelector('.cam-editor'));

  // تحديد نقطة ثم تعديل الزوم ⇒ يدوية
  card().querySelectorAll('.cam-key')[1].click();
  await settle();
  expect('التحديد يفتح المحرر', !!card().querySelector('.cam-editor') && card().querySelectorAll('.cam-key.selected').length === 1);
  const zoomInput = card().querySelector('[data-field="key_zoom"]');
  zoomInput.value = '3.5';
  zoomInput.dispatchEvent(new Event('input', { bubbles: true }));
  expect('تعديل الزوم يصل المشروع ويحوّل الوضع إلى يدوي', scene().camera.keyframes[1].zoom === 3.5 && scene().camera.mode === 'manual', scene().camera.keyframes[1]);
  zoomInput.value = '99';
  zoomInput.dispatchEvent(new Event('input', { bubbles: true }));
  expect('الزوم يُقصّ عند الحد', scene().camera.keyframes[1].zoom === 4, scene().camera.keyframes[1].zoom);

  // السحب يغيّر الزمن ويبقى بين الجارتين
  const dot = card().querySelectorAll('.cam-key')[1];
  const strip = dot.parentElement;
  const box = strip.getBoundingClientRect();
  const beforeDrag = scene().camera.keyframes.map((key) => key.t_ms);
  dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerId: 7, clientX: box.left }));
  strip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: box.left + box.width * 0.99 }));
  strip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
  await settle();
  const afterDrag = scene().camera.keyframes.map((key) => key.t_ms);
  expect('السحب يحرّك النقطة ولا يتجاوز الجارة', afterDrag[1] > beforeDrag[1] && afterDrag[1] < afterDrag[2], { beforeDrag, afterDrag });

  // حذف النقطة المحددة
  const countBefore = scene().camera.keyframes.length;
  card().querySelector('[data-action="key-remove"]').click();
  await settle();
  expect('حذف النقطة', scene().camera.keyframes.length === countBefore - 1 && !card().querySelector('.cam-editor'), scene().camera.keyframes.length);

  // إضافة نقطة عند زمن المعاينة
  studio.previewTime = 4321;
  card().querySelector('[data-action="key-add"]').click();
  await settle();
  expect('إضافة نقطة عند زمن المعاينة', scene().camera.keyframes.some((key) => key.t_ms === 4321), scene().camera.keyframes.map((key) => key.t_ms));

  // off يخفي الشريط، واقترح يعيد التلقائية
  const mode = card().querySelector('[data-field="camera_mode"]');
  mode.value = 'off'; mode.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect('off يخفي الشريط ويعطّل خانة المؤشر', !card().querySelector('.cam-strip') && card().querySelector('[data-field="camera_cursor"]').disabled);
  card().querySelector('[data-action="camera-suggest"]').click();
  await settle();
  expect('اقترح كاميرا يعيد الخطة التلقائية', scene().camera.mode === 'auto' && scene().camera.keyframes.length > 2 && !!card().querySelector('.cam-strip'));
  expect('أي تعديل يلغي الاعتماد', studio.approved === false);

  // تغيير المدة يعيد تخطيط التلقائية داخل المدة الجديدة
  const duration = card().querySelector('[data-field="duration_ms"]');
  duration.value = '3000'; duration.dispatchEvent(new Event('change', { bubbles: true }));
  expect('تقصير المشهد يُسقط نقاط ما بعد المدة', scene().camera.keyframes.every((key) => key.t_ms <= 3000), scene().camera.keyframes.map((key) => key.t_ms));
  duration.value = '9000'; duration.dispatchEvent(new Event('change', { bubbles: true }));
  studio.changed();
  await settle();

  // قصّ الخمول يقسم المشهد ويعيد تخطيط كل جزء
  const total = studio.totalDuration();
  card().querySelector('[data-action="cut-gap"]').click();
  await settle();
  const after = studio.getStoryboard().scenes;
  expect('قصّ الخمول يقسم المشهد ويقصّر المجموع', after.length === 2 && studio.totalDuration() < total && after[1].trim_start_ms > 0, after.map((item) => [item.trim_start_ms, item.duration_ms]));
  expect('كل جزء كاميرته داخل مدته', after.every((item) => item.camera.keyframes.every((key) => key.t_ms <= item.duration_ms)));

  // مشروع محمَّل لا يُخطَّط له تلقائياً
  await studio.open({ aspect: '16:9', scenes: [{ id: 'x', asset, asset_type: 'video', caption: '', duration_ms: 9000 }] });
  await settle();
  expect('storyboard مُمرَّر يبقى بلا كاميرا', scene().camera.mode === 'off' && scene().camera.keyframes.length === 0, scene().camera);
  expect('زر الاقتراح متاح لأن للمقطع أحداثاً', !card().querySelector('[data-action="camera-suggest"]').disabled);
  return failures;
}

window.__promoCamera = (async () => {
  const pixelFailures = await pixels();
  const uiFailures = await ui();
  return { ok: !pixelFailures.length && !uiFailures.length, pixelFailures, uiFailures };
})();
