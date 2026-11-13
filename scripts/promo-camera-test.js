// حارس الكاميرا الذكية — اختبارات قطعية لـ src/ui/lib/promo/promo-camera.js
// ولتنقية حقل camera وترحيل v1 ⇒ v2 في electron/promostudio.js، ولقراءة أحداث المقطع.
// التوقعات ثوابت (حدود وسرعة واحتواء) لا أرقام حرفية، كي لا ينكسر الحارس عند ضبط الثوابت.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

const VIEWPORT = { width: 1920, height: 1040 };
const event = (t, extra) => ({
  t_ms: t, kind: 'pointer', source: 'human', action: 'mousedown', target_ref: null,
  rect: { x: 300, y: 200, width: 240, height: 120 }, pointer: { x: 420, y: 260, button: 0 },
  viewport: VIEWPORT, timing_quality: 'verified', ...extra,
});

(async () => {
  const camera = await import('../src/ui/lib/promo/promo-camera.js');
  const { planCamera, cameraAt, cameraTransform, eventToFrame, clampCenter, pointerTrack, pointerAt, idleGaps, CAMERA_DEFAULTS } = camera;
  const studio = require('../electron/promostudio');
  const capture = require('../electron/promocapture');

  // أقصى سرعة لحظية لمركز الكاميرا وللزوم على امتداد المشهد، بالعيّنة كل 5ms.
  const peaks = (keyframes, durationMs) => {
    let center = 0, zoom = 0, maxZoom = 1, minZoom = Infinity;
    let previous = cameraAt({ mode: 'auto', keyframes }, 0);
    for (let t = 5; t <= durationMs; t += 5) {
      const state = cameraAt({ mode: 'auto', keyframes }, t);
      center = Math.max(center, Math.hypot(state.x - previous.x, state.y - previous.y) / 0.005);
      zoom = Math.max(zoom, Math.abs(state.zoom - previous.zoom) / 0.005);
      maxZoom = Math.max(maxZoom, state.zoom); minZoom = Math.min(minZoom, state.zoom);
      previous = state;
    }
    return { center, zoom, maxZoom, minZoom };
  };
  // هل العنصر كله داخل نافذة الكاميرا عند زمن ما؟
  const contains = (keyframes, t, rect) => {
    const state = cameraAt({ mode: 'auto', keyframes }, t);
    const half = 0.5 / state.zoom;
    const box = eventToFrame(rect, VIEWPORT);
    return box.x >= state.x - half - 1e-6 && box.x + box.width <= state.x + half + 1e-6
      && box.y >= state.y - half - 1e-6 && box.y + box.height <= state.y + half + 1e-6;
  };
  const invariants = (keyframes, durationMs, label) => {
    eq(keyframes[0].t_ms, 0, label + ': تبدأ عند الصفر');
    for (let i = 1; i < keyframes.length; i += 1) assert.ok(keyframes[i].t_ms > keyframes[i - 1].t_ms, label + ': الزمن متصاعد');
    for (const key of keyframes) {
      assert.ok(key.t_ms >= 0 && key.t_ms <= durationMs && key.zoom >= 1 && key.zoom <= CAMERA_DEFAULTS.maxZoom, label + ': النقطة داخل الحدود');
      const center = clampCenter(key.x, key.y, key.zoom);
      assert.ok(Math.abs(center.x - key.x) < 1e-3 && Math.abs(center.y - key.y) < 1e-3, label + ': النافذة داخل الإطار');
    }
    const peak = peaks(keyframes, durationMs);
    assert.ok(peak.center <= CAMERA_DEFAULTS.maxCenterSpeed * 1.02, label + ': سرعة المركز ' + peak.center.toFixed(2));
    assert.ok(peak.zoom <= CAMERA_DEFAULTS.maxZoomSpeed * 1.02, label + ': سرعة الزوم ' + peak.zoom.toFixed(2));
    assert.ok(peak.maxZoom <= CAMERA_DEFAULTS.maxZoom + 1e-9, label + ': الزوم لا يتجاوز الحد');
    checks += 4;
    return peak;
  };

  // ── نقرة واحدة ──
  const scene = { durationMs: 8000, sourceStartMs: 0 };
  const single = planCamera([event(3000)], scene);
  const singlePeak = invariants(single, 8000, 'نقرة واحدة');
  ok(singlePeak.maxZoom >= CAMERA_DEFAULTS.minZoom, 'النقرة تكبّر');
  ok(cameraAt({ mode: 'auto', keyframes: single }, 3000).zoom >= CAMERA_DEFAULTS.minZoom, 'الكاميرا وصلت عند لحظة النقرة');
  ok(contains(single, 3000, event(0).rect), 'الزر كله داخل الإطار عند النقرة');
  ok(contains(single, 3000 + CAMERA_DEFAULTS.holdMs - 50, event(0).rect), 'اللقطة ممسوكة طوال مدة الإمساك');
  eq(cameraAt({ mode: 'auto', keyframes: single }, 8000).zoom, 1, 'تعود إلى الإطار الكامل بعد الخمول');
  eq(cameraAt({ mode: 'auto', keyframes: single }, 500).zoom, 1, 'ثابتة قبل الاقتراب من الحدث');
  eq(cameraAt({ mode: 'off', keyframes: single }, 3000), { x: 0.5, y: 0.5, zoom: 1 }, 'الوضع off يعطّل النقاط');
  eq(cameraAt(null, 3000), { x: 0.5, y: 0.5, zoom: 1 }, 'غياب الكاميرا = الإطار الكامل');

  // ── عنصر صغير جداً: الزوم يقف عند الحد ──
  const tiny = planCamera([event(2000, { rect: { x: 900, y: 500, width: 20, height: 12 } })], scene);
  eq(invariants(tiny, 8000, 'عنصر صغير').maxZoom, CAMERA_DEFAULTS.maxZoom, 'الزوم عند الحد الأقصى بالضبط');
  // ── عنصر كبير: الزوم عند الحد الأدنى ──
  const wide = planCamera([event(2000, { rect: { x: 100, y: 100, width: 1500, height: 700 } })], scene);
  eq(invariants(wide, 8000, 'عنصر كبير').maxZoom, CAMERA_DEFAULTS.minZoom, 'العنصر الكبير يأخذ أقل زوم');
  // ── عنصر عند الزاوية: المركز يُقصّ ──
  invariants(planCamera([event(2000, { rect: { x: 0, y: 0, width: 80, height: 40 }, pointer: { x: 10, y: 10, button: 0 } })], scene), 8000, 'زاوية');

  // ── نقرات متقاربة في المنطقة نفسها ⇒ لقطة واحدة ──
  const burst = planCamera([event(2000), event(2400, { rect: { x: 340, y: 230, width: 200, height: 100 } }), event(2800)], scene);
  invariants(burst, 8000, 'نقرات متقاربة');
  eq(burst.filter((key) => key.reason === 'element').length, 1, 'ثلاث نقرات متقاربة = اقتراب واحد');
  ok(contains(burst, 2800 + 600, event(0).rect), 'اللقطة ممسوكة بعد آخر نقرة');
  // ── نقرتان متباعدتان مكاناً وزمناً ⇒ لقطتان ──
  const far = planCamera([event(1500), event(4000, { rect: { x: 1500, y: 800, width: 200, height: 100 }, pointer: { x: 1600, y: 850, button: 0 } })], scene);
  invariants(far, 8000, 'نقرتان متباعدتان');
  eq(far.filter((key) => key.reason === 'element').length, 2, 'هدفان = اقترابان');
  ok(cameraAt({ mode: 'auto', keyframes: far }, 2000).zoom > 1 && cameraAt({ mode: 'auto', keyframes: far }, 3500).zoom > 1, 'لا رجوع للإطار الكامل بين لقطتين متقاربتين زمنياً');

  // ── كتابة متتالية من الوكيل على العنصر نفسه ⇒ لا قفزات زوم ──
  const typing = [0, 400, 900, 1500, 2200].map((offset) => event(2000 + offset, {
    kind: 'action', source: 'agent', action: 'type', target_ref: 's1:e7', pointer: null, rect: { x: 600, y: 400, width: 500, height: 60 },
  }));
  const typed = planCamera(typing, scene);
  invariants(typed, 8000, 'كتابة');
  eq(typed.filter((key) => key.reason === 'element').length, 1, 'الكتابة المتتالية لقطة واحدة');
  const zoomDuringTyping = [2000, 2600, 3300, 4100].map((t) => cameraAt({ mode: 'auto', keyframes: typed }, t).zoom);
  eq(new Set(zoomDuringTyping.map((z) => z.toFixed(3))).size, 1, 'الزوم ثابت أثناء الكتابة');

  // ── خمول طويل ⇒ عودة إلى الزوم 1 ثم اقتراب جديد ──
  const idle = planCamera([event(1000), event(7000)], { durationMs: 10000, sourceStartMs: 0 });
  invariants(idle, 10000, 'خمول');
  eq(cameraAt({ mode: 'auto', keyframes: idle }, 4500).zoom, 1, 'الإطار الكامل أثناء الخمول');
  ok(cameraAt({ mode: 'auto', keyframes: idle }, 7000).zoom > 1, 'اقتراب جديد بعد الخمول');

  // ── rect مفقود ⇒ المؤشر بزوم أخف؛ وكلاهما مفقود ⇒ لا حركة ──
  const noRect = planCamera([event(3000, { rect: null })], scene);
  eq(invariants(noRect, 8000, 'بلا مستطيل').maxZoom, CAMERA_DEFAULTS.pointerZoom, 'بلا مستطيل ⇒ زوم المؤشر');
  eq(planCamera([event(3000, { rect: null, pointer: null })], scene).length, 1, 'بلا مستطيل ولا مؤشر ⇒ لا حركة');
  // ── توقيت غير موثّق ⇒ الزوم الأخف حتى مع وجود المستطيل ──
  const unverified = planCamera([event(3000, { timing_quality: 'unverified' })], scene);
  eq(invariants(unverified, 8000, 'غير موثّق').maxZoom, CAMERA_DEFAULTS.pointerZoom, 'غير موثّق ⇒ زوم المؤشر');
  // حدث وكيل غير موثّق بلا مؤشر ⇒ مركز المستطيل بالزوم الأخف
  const agentUnverified = planCamera([event(3000, { kind: 'action', source: 'agent', action: 'click', pointer: null, timing_quality: 'unverified' })], scene);
  eq(invariants(agentUnverified, 8000, 'وكيل غير موثّق').maxZoom, CAMERA_DEFAULTS.pointerZoom, 'حدث الوكيل بلا مؤشر يستعمل مركز المستطيل');

  // ── ما لا يحرّك الكاميرا ──
  eq(planCamera([event(3000, { action: 'mousemove' })], scene).length, 1, 'حركة المؤشر لا تكبّر');
  eq(planCamera([event(3000, { kind: 'navigation', action: null })], scene).length, 1, 'التنقل لا يكبّر');
  eq(planCamera([event(3000, { kind: 'action', action: 'hover' })], scene).length, 1, 'hover لا يكبّر');
  eq(planCamera([event(9000)], scene).length, 1, 'حدث خارج مدة المشهد يُهمل');
  eq(planCamera([event(500)], { durationMs: 8000, sourceStartMs: 2000 }).length, 1, 'حدث قبل بداية القص يُهمل');
  eq(planCamera(null, scene).length, 1, 'مدخل فارغ');
  eq(planCamera([event(1)], { durationMs: 0 }).length, 1, 'مدة صفرية');
  // ── القص يزيح الزمن ──
  const trimmed = planCamera([event(5000)], { durationMs: 6000, sourceStartMs: 2000 });
  ok(cameraAt({ mode: 'auto', keyframes: trimmed }, 3000).zoom > 1, 'حدث عند 5000 في المصدر يظهر عند 3000 في المشهد المقصوص');
  // ── حدث في أول المشهد: الكاميرا تلحق دون تجاوز حد السرعة ──
  invariants(planCamera([event(50)], scene), 8000, 'حدث مبكر');
  // ── سيل أحداث: الناتج محدود ──
  const flood = planCamera(Array.from({ length: 5000 }, (_, i) => event(i * 30, { rect: { x: (i * 137) % 1700, y: (i * 71) % 900, width: 100, height: 60 }, pointer: null })), { durationMs: 150000, sourceStartMs: 0 });
  ok(flood.length <= camera.MAX_KEYFRAMES, 'النقاط لا تتجاوز الحد: ' + flood.length);

  // ── تحويل الإحداثيات ──
  eq(eventToFrame({ x: 480, y: 260, width: 960, height: 520 }, VIEWPORT), { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 'النسبة إلى viewport');
  eq(eventToFrame({ x: 0, y: 0, width: 0, height: 10 }, VIEWPORT), null, 'مستطيل فارغ');
  eq(eventToFrame({ x: 1, y: 1, width: 5, height: 5 }, null), null, 'بلا viewport');

  // ── تحويل الرسم ──
  const fitted = { x: 0, y: 0, width: 1920, height: 1080 };
  eq(cameraTransform({ x: 0.5, y: 0.5, zoom: 1 }, fitted, 1920, 1080), { scale: 1, tx: 0, ty: 0 }, 'زوم 1 = لا تحويل');
  const centered = cameraTransform({ x: 0.5, y: 0.5, zoom: 2 }, fitted, 1920, 1080);
  eq(centered, { scale: 2, tx: -960, ty: -540 }, 'زوم 2 حول المركز');
  const corner = cameraTransform({ x: 0, y: 0, zoom: 2 }, fitted, 1920, 1080);
  eq([corner.tx, corner.ty], [0, 0], 'الزاوية لا تكشف خارج المصدر');
  const farCorner = cameraTransform({ x: 1, y: 1, zoom: 2 }, fitted, 1920, 1080);
  eq([farCorner.tx, farCorner.ty], [-1920, -1080], 'الزاوية البعيدة');
  const letterbox = cameraTransform({ x: 0.5, y: 0.5, zoom: 1.2 }, { x: 0, y: 270, width: 1920, height: 540 }, 1920, 1080);
  ok(Math.abs((270 * 1.2 + letterbox.ty) - (1080 - 540 * 1.2) / 2) < 1e-6, 'المحتوى الأصغر من اللوحة يتوسّط');
  // نقطة البؤرة تقع في مركز اللوحة حين لا قصّ
  const focus = cameraTransform({ x: 0.3, y: 0.6, zoom: 2 }, fitted, 1920, 1080);
  eq([0.3 * 1920 * 2 + focus.tx, 0.6 * 1080 * 2 + focus.ty], [960, 540], 'البؤرة في مركز اللوحة');

  // ── المؤشر الاصطناعي ──
  const track = pointerTrack([
    event(1000, { action: 'mousemove', pointer: { x: 192, y: 104, button: 0 } }),
    event(2000),
    event(3000, { kind: 'action', source: 'agent', action: 'click', pointer: null, rect: { x: 960, y: 520, width: 192, height: 104 } }),
    event(3500, { kind: 'action', source: 'agent', action: 'type', pointer: null, rect: { x: 960, y: 520, width: 192, height: 104 } }),
  ], scene);
  eq(track.map((point) => point.click), [false, true, true, false], 'النقر والفعل نقرة؛ الحركة والكتابة لا');
  eq([track[2].x, track[2].y], [0.55, 0.55], 'حدث الوكيل بلا مؤشر ⇒ مركز المستطيل');
  eq(pointerAt(track, 500), null, 'لا مؤشر قبل أول نقطة');
  eq([pointerAt(track, 1200).x, pointerAt(track, 1200).ripple], [0.1, null], 'ثابت قبل نافذة الحركة');
  const arriving = pointerAt(track, 1900);
  ok(arriving.x > 0.1 && arriving.x < 420 / 1920, 'يتحرك نحو النقطة التالية في آخر 400ms');
  const clicked = pointerAt(track, 2100);
  ok(clicked.ripple && Math.abs(clicked.ripple.progress - 100 / 450) < 1e-9, 'موجة النقرة تتقدم مع الزمن');
  eq(pointerAt(track, 2600).ripple, null, 'الموجة تنتهي');
  eq(pointerAt([], 100), null, 'مسار فارغ');

  // ── فجوات الخمول ──
  eq(idleGaps([event(1000), event(6000)], { durationMs: 12000, sourceStartMs: 0 }), [{ start_ms: 1500, end_ms: 5500 }, { start_ms: 6500, end_ms: 12000 }], 'فجوة وسطى وفجوة أخيرة');
  eq(idleGaps([event(4000)], { durationMs: 5000, sourceStartMs: 0 }), [{ start_ms: 0, end_ms: 3500 }], 'فجوة في البداية');
  eq(idleGaps([event(1000), event(2500)], { durationMs: 4000, sourceStartMs: 0 }), [], 'لا فجوة تحت العتبة');
  eq(idleGaps([], { durationMs: 9000, sourceStartMs: 0 }), [], 'بلا أحداث لا اقتراح');

  // ── تنقية camera في main ──
  const key = (extra) => ({ t_ms: 0, x: 0.5, y: 0.5, zoom: 1, ease: 'inOut', ...extra });
  const clean = (camera) => studio.sanitizeCamera(camera, 5000);
  eq(clean(undefined), { ok: true, camera: { mode: 'off', cursor: true, keyframes: [] } }, 'الغياب = off');
  eq(clean({ mode: 'auto', keyframes: [key(), key({ t_ms: 1000, zoom: 2, x: 0.33333333, ease: 'weird' })] }).camera,
    { mode: 'auto', cursor: true, keyframes: [key(), { t_ms: 1000, x: 0.3333, y: 0.5, zoom: 2, ease: 'inOut' }] }, 'تقريب وقائمة بيضاء للمنحنى');
  eq(clean({ mode: 'bogus', cursor: false }).camera, { mode: 'off', cursor: false, keyframes: [] }, 'وضع مجهول ⇒ off');
  for (const [label, bad] of [
    ['NaN', key({ x: NaN })], ['Infinity', key({ zoom: Infinity })], ['zoom 99', key({ zoom: 99 })], ['zoom < 1', key({ zoom: 0.5 })],
    ['x خارج النطاق', key({ x: 1.2 })], ['y سالب', key({ y: -0.1 })], ['زمن خارج المدة', key({ t_ms: 5001 })],
    ['زمن كسري', key({ t_ms: 1.5 })], ['زمن نصي', key({ t_ms: '100' })], ['x نصي', key({ x: '0.5' })], ['ليس كائناً', 7],
  ]) eq(clean({ mode: 'auto', keyframes: [bad] }).ok, false, 'مرفوض: ' + label);
  eq(clean({ mode: 'auto', keyframes: [key({ t_ms: 100 }), key({ t_ms: 100 })] }).ok, false, 'زمن مكرر مرفوض');
  eq(clean({ mode: 'auto', keyframes: [key({ t_ms: 200 }), key({ t_ms: 100 })] }).ok, false, 'زمن متراجع مرفوض');
  eq(clean({ mode: 'auto', keyframes: Array.from({ length: 10000 }, (_, i) => key({ t_ms: i })) }).ok, false, '10,000 نقطة مرفوضة');
  eq(clean({ mode: 'auto', keyframes: Array.from({ length: 200 }, (_, i) => key({ t_ms: i })) }).ok, true, '200 نقطة مقبولة');
  eq(clean({ mode: 'auto', keyframes: 'x' }).ok, false, 'keyframes ليست مصفوفة');
  eq(clean([]).ok, false, 'camera مصفوفة');
  eq(clean('auto').ok, false, 'camera نص');

  // ── الترحيل v1 ⇒ v2 والحفظ ──
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-camera-'));
  try {
    const clip = path.join(downloads, 'clip.mp4');
    fs.writeFileSync(clip, 'x');
    const v1 = path.join(downloads, 'old.satr-promo.json');
    fs.writeFileSync(v1, JSON.stringify({ version: 1, aspect: '16:9', scenes: [{ id: 'a', asset: clip, asset_type: 'video', caption: 'قديم', duration_ms: 3000, transition: 'fade' }] }));
    const loaded = studio.loadProject(v1, downloads);
    eq(loaded.ok, true, 'مشروع v1 يُفتح');
    eq(loaded.storyboard.scenes[0].camera, { mode: 'off', cursor: true, keyframes: [] }, 'الترحيل يضيف camera off');
    eq([loaded.storyboard.scenes[0].caption, loaded.storyboard.scenes[0].transition, loaded.storyboard.scenes[0].duration_ms], ['قديم', 'fade', 3000], 'حقول v1 كما هي');
    const v2 = path.join(downloads, 'new.satr-promo.json');
    const withCamera = { aspect: '16:9', scenes: [{ asset: clip, duration_ms: 4000, camera: { mode: 'manual', cursor: false, keyframes: [key(), key({ t_ms: 2000, zoom: 2.2, x: 0.3, y: 0.4 })] } }] };
    eq(studio.saveProject(downloads, withCamera, v2).ok, true, 'حفظ v2');
    const saved = JSON.parse(fs.readFileSync(v2, 'utf8'));
    eq(saved.version, 2, 'الملف المحفوظ بالإصدار 2');
    eq(studio.loadProject(v2, downloads).storyboard.scenes[0].camera, { mode: 'manual', cursor: false, keyframes: [key(), key({ t_ms: 2000, zoom: 2.2, x: 0.3, y: 0.4 })] }, 'الكاميرا تعود كما حُفظت');
    eq(studio.saveProject(downloads, { scenes: [{ asset: clip, duration_ms: 4000, camera: { mode: 'auto', keyframes: [key({ zoom: 99 })] } }] }, v2).error, 'bad_camera', 'الحفظ يرفض كاميرا خبيثة');
    fs.writeFileSync(v2, JSON.stringify({ version: 2, aspect: '16:9', scenes: [{ asset: clip, duration_ms: 3000, camera: { mode: 'auto', keyframes: [key({ x: NaN })] } }] }).replace('null', 'NaN'));
    eq(studio.loadProject(v2, downloads).ok, false, 'ملف v2 معطوب مرفوض');
    fs.writeFileSync(v2, JSON.stringify({ version: 3, aspect: '16:9', scenes: [] }));
    eq(studio.loadProject(v2, downloads).error, 'bad_schema', 'إصدار مستقبلي مرفوض');

    // ── قراءة أحداث المقطع ──
    const root = capture.eventRootFor(downloads);
    fs.mkdirSync(root, { recursive: true });
    const segmentId = 'promo_' + 'a'.repeat(24);
    const file = path.join(root, segmentId + '.events.jsonl');
    const record = (extra) => JSON.stringify({ v: 0, kind: 'pointer', source: 'human', action: 'mousedown', t_capture_ms: 1000,
      rect: { x: 10, y: 20, width: 30, height: 40 }, pointer: { x: 15, y: 25, button: 0 }, viewport: { width: 800, height: 600, dpr: 1 }, timing_quality: 'verified', ...extra });
    fs.writeFileSync(file, [
      record(), 'ليس JSON', record({ kind: 'evil', t_capture_ms: 5 }), record({ t_capture_ms: -4 }), record({ action: '<script>', t_capture_ms: 1200, target_ref: '../x', rect: { x: 'a' } }),
      record({ kind: 'action', source: 'agent', action: 'click', t_capture_ms: 2000, target_ref: 's1:e3', pointer: null, extra_field: 'secret' }),
      JSON.stringify({ kind: 'clock', t_capture_ms: 4000, capture_duration_ms: 4000, media_duration_ms: 4100, start_media_ms: 120 }),
    ].join('\n'));
    eq(capture.isEventFileFor(file, segmentId, downloads), true, 'ملف الأحداث داخل الجذر المعتمد');
    eq(capture.isEventFileFor(path.join(downloads, segmentId + '.events.jsonl'), segmentId, downloads), false, 'خارج الجذر مرفوض');
    eq(capture.isEventFileFor(file, 'promo_' + 'b'.repeat(24), downloads), false, 'اسم لا يطابق المقطع مرفوض');
    eq(capture.isEventFileFor(path.join('C:\\proj', '.satr', 'promo', 'events', segmentId + '.events.jsonl'), segmentId, downloads), process.platform === 'win32', 'جذر المشروع مقبول');
    const read = capture.readSegmentEvents(file);
    eq([read.ok, read.events.length, read.offset_ms, read.offset_known, read.media_duration_ms], [true, 3, 120, true, 4100], 'ثلاثة أحداث صالحة وإزاحة المنارة');
    eq(read.events.map((item) => item.t_ms), [1120, 1320, 2120], 'زمن الوسائط = زمن الالتقاط + الإزاحة');
    eq([read.events[1].action, read.events[1].target_ref, read.events[1].rect], [null, null, null], 'الحقول المعطوبة تُصفَّر');
    eq(Object.keys(read.events[2]).sort(), ['action', 'kind', 'pointer', 'rect', 'source', 't_capture_ms', 't_ms', 'target_ref', 'timing_quality', 'viewport'], 'لا حقول زائدة تعبر');
    eq(read.events[0].viewport, { width: 800, height: 600 }, 'viewport بلا dpr');
    eq(capture.readSegmentEvents(path.join(root, 'missing.jsonl')).error, 'events_missing', 'ملف غائب');
    fs.writeFileSync(file, record() + '\n');
    const noClock = capture.readSegmentEvents(file);
    eq([noClock.offset_ms, noClock.offset_known], [0, false], 'بلا سجل ساعة ⇒ إزاحة صفر غير معلومة');
    // المتحكم: مسار غير مسجَّل
    const controller = capture.create({ downloadsPath: downloads });
    eq(controller.segmentEvents(clip).error, 'not_a_segment', 'أصل ليس مقطعاً مسجَّلاً');
    eq(controller.segmentEvents('relative.mp4').error, 'bad_path', 'مسار نسبي');
    // سجل الساعة يحمل موضع منارة البدء
    const sink = capture.createEventSink({ segmentId, root, now: () => 5000 });
    sink.markBeacon('start', { capture_ms: 1000, media_ms: 140, visible: true });
    sink.record({ kind: 'pointer', source: 'human', action: 'mousedown', monotonic_ms: 2000, viewport: { width: 800, height: 600, dpr: 1 }, pointer: { x: 1, y: 2, button: 0 } });
    sink.markBeacon('end', { capture_ms: 5000, media_ms: 4140, visible: true });
    const finalized = sink.finalize(4200);
    eq(finalized.timing_quality, 'verified', 'المنارتان متطابقتان');
    const roundTrip = capture.readSegmentEvents(finalized.path);
    eq([roundTrip.offset_ms, roundTrip.offset_known, roundTrip.events[0].t_ms, roundTrip.timing_quality], [140, true, 1140, 'verified'], 'الإزاحة تُكتب في سجل الساعة وتُقرأ');
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
  }

  console.log('promo-camera-test: ok — ' + checks + ' فحصاً (التخطيط، حد السرعة، التحويل، المؤشر، الخمول، التنقية، الترحيل، قراءة الأحداث).');
})().catch((error) => {
  console.error('promo-camera-test:', error && error.stack ? error.stack : error);
  process.exit(1);
});
