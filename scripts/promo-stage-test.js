// حارس الإخراج البصري — تخطيط المسرح والإمالة (نقية)، وتنقية stage / transition_in / redactions
// في electron/promostudio.js، ووسم الحقول الحساسة في سجل الأحداث.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

(async () => {
  const stageModule = await import('../src/ui/lib/promo/promo-stage.js');
  const { stageLayout, frameInsets, tiltAt, usesStage, STAGE_FRAMES, STAGE_SCALE_MIN, STAGE_SCALE_MAX, STAGE_TILT_MAX } = stageModule;
  const { tiltMatrix, TILT_MARGIN } = await import('../src/ui/lib/promo/promo-gl.js');
  const { suggestRedactions, cleanStage, cleanRedactions, defaultStage } = await import('../src/ui/lib/promo/studio-stage.js');
  const studio = require('../electron/promostudio');
  const capture = require('../electron/promocapture');

  // ── usesStage: مشهد v1 لا مسرح له ──
  eq(usesStage({}), false, 'بلا stage');
  eq(usesStage({ stage: defaultStage() }), false, 'المسرح الافتراضي غير فعّال');
  eq(usesStage({ stage: { ...defaultStage(), frame: 'phone' } }), true, 'إطار ⇒ فعّال');
  eq(usesStage({ stage: { ...defaultStage(), background: { type: 'linear' } } }), true, 'خلفية ⇒ فعّال');

  // ── التخطيط: الجهاز داخل الحجم المطلوب، والمحتوى يحافظ على نسبة المصدر، لكل إطار ومقاس ──
  for (const frame of STAGE_FRAMES) {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [3840, 2160]]) {
      for (const [sourceWidth, sourceHeight] of [[1920, 1040], [1080, 1920], [800, 800]]) {
        for (const scale of [STAGE_SCALE_MIN, 0.84, STAGE_SCALE_MAX]) {
          const layout = stageLayout({ frame, scale }, sourceWidth, sourceHeight, width, height);
          const { device, content, insets } = layout;
          const label = [frame, width + 'x' + height, sourceWidth + 'x' + sourceHeight, scale].join(' ');
          assert.ok(device.width <= width * scale + 1 && device.height <= height * scale + 1, 'الجهاز داخل الحجم: ' + label);
          assert.ok(device.x >= 0 && device.y >= 0 && device.x + device.width <= width && device.y + device.height <= height, 'الجهاز داخل اللوحة: ' + label);
          assert.ok(Math.abs(content.width / content.height - sourceWidth / sourceHeight) < 0.01, 'نسبة المحتوى = نسبة المصدر: ' + label);
          assert.ok(content.x === device.x + insets.left && content.y === device.y + insets.top, 'المحتوى بعد الهوامش: ' + label);
          assert.ok(content.x + content.width <= device.x + device.width && content.y + content.height <= device.y + device.height, 'المحتوى داخل الجهاز: ' + label);
          assert.ok(Math.abs((device.x + device.width / 2) - width / 2) <= 1 && Math.abs((device.y + device.height / 2) - height / 2) <= 1, 'الجهاز في الوسط: ' + label);
          // أحد البعدين يبلغ الحد تقريباً: لا تصغير زائد
          assert.ok(device.width >= width * scale * 0.97 || device.height >= height * scale * 0.97, 'الجهاز يملأ الحجم المتاح: ' + label);
          checks += 1;
        }
      }
    }
  }
  eq(stageLayout({ frame: 'none', scale: 5 }, 1920, 1080, 1920, 1080).device.width <= 1920 * STAGE_SCALE_MAX + 1, true, 'الحجم فوق الحد يُقصّ');
  eq(stageLayout({ frame: 'none', scale: 0.1 }, 1920, 1080, 1920, 1080).device.width >= 1920 * STAGE_SCALE_MIN - 2, true, 'الحجم تحت الحد يُرفع');
  eq(frameInsets('none', 1000, 600).top, 0, 'بلا إطار بلا هوامش');
  ok(frameInsets('browser', 1000, 600).top > 0 && frameInsets('browser', 1000, 600).left === 0, 'المتصفح: شريط علوي فقط');
  ok(frameInsets('laptop', 1000, 600).extraBottom > 0, 'اللابتوب: قاعدة');
  const phone = frameInsets('phone', 600, 1300);
  ok(phone.top === phone.bottom && phone.left === phone.right && phone.radius > phone.left, 'الجوال: حافة متساوية وزوايا كبيرة');

  // ── الإمالة ──
  eq(tiltAt({ tilt: { x: 5, y: -12 }, motion: 'none' }, 500, 3000), { x: 5, y: -12 }, 'ثابتة');
  eq(tiltAt({ tilt: { x: 99, y: -99 } }, 0, 1000), { x: STAGE_TILT_MAX, y: -STAGE_TILT_MAX }, 'تُقصّ عند ±25°');
  eq(tiltAt(null, 0, 1000), { x: 0, y: 0 }, 'بلا مسرح');
  eq(tiltAt({ tilt: { x: NaN, y: 'x' } }, 0, 1000), { x: 0, y: 0 }, 'قيم معطوبة');
  const orbitStart = tiltAt({ tilt: { x: 0, y: 0 }, motion: 'orbit' }, 0, 4000), orbitEnd = tiltAt({ tilt: { x: 0, y: 0 }, motion: 'orbit' }, 4000, 4000);
  ok(Math.abs(orbitStart.y - 4) < 1e-9 && Math.abs(orbitEnd.y + 4) < 1e-9, 'المدار: من +4° إلى −4°');
  for (let t = 0; t <= 4000; t += 100) {
    const tilt = tiltAt({ tilt: { x: 24, y: 24 }, motion: 'orbit' }, t, 4000);
    assert.ok(Math.abs(tilt.x) <= STAGE_TILT_MAX && Math.abs(tilt.y) <= STAGE_TILT_MAX, 'المدار لا يتجاوز الحد');
  }
  checks += 1;

  // ── مصفوفة الإمالة: إسقاط زوايا الجهاز ──
  const project = (matrix, x, y) => {
    const cx = matrix[0] * x + matrix[4] * y + matrix[12], cy = matrix[1] * x + matrix[5] * y + matrix[13], cw = matrix[3] * x + matrix[7] * y + matrix[15];
    return [cx / cw, cy / cw];
  };
  const flat = tiltMatrix(0, 0, 16 / 9, TILT_MARGIN * 2);
  const expected = 1 / (1 + TILT_MARGIN * 2);
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const [px, py] = project(flat, x, y);
    assert.ok(Math.abs(px - x * expected) < 1e-6 && Math.abs(py - y * expected) < 1e-6, 'بلا إمالة: الجهاز يملأ ما عدا الهامش');
  }
  checks += 1;
  for (const [tx, ty] of [[25, 25], [-25, 25], [25, -25], [-25, -25], [0, 25], [25, 0]]) {
    const matrix = tiltMatrix(tx, ty, 16 / 9, TILT_MARGIN * 2);
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [px, py] = project(matrix, x, y);
      assert.ok(Math.abs(px) <= expected + 1e-6 && Math.abs(py) <= expected + 1e-6, 'الجهاز المائل لا يتجاوز أثره وهو مستوٍ: ' + [tx, ty, x, y, px.toFixed(3), py.toFixed(3)]);
    }
  }
  checks += 1;
  const turned = tiltMatrix(0, 20, 16 / 9, TILT_MARGIN * 2);
  const leftHeight = project(turned, -1, 1)[1] - project(turned, -1, -1)[1], rightHeight = project(turned, 1, 1)[1] - project(turned, 1, -1)[1];
  ok(Math.abs(leftHeight - rightHeight) > 0.05, 'الإمالة الأفقية تجعل أحد الطرفين أقصر (منظور)');

  // ── تنقية stage في main ──
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-stage-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-stage-out-'));
  try {
    const clip = path.join(downloads, 'clip.mp4'), image = path.join(downloads, 'bg.png'), secret = path.join(outside, 'bg.png');
    for (const file of [clip, image, secret]) fs.writeFileSync(file, 'x');
    const clean = (extra, index = 0) => {
      const scenes = Array.from({ length: index + 1 }, () => ({ asset: clip, duration_ms: 3000 }));
      scenes[index] = { ...scenes[index], ...extra };
      const result = studio.sanitizeStoryboard({ scenes }, { downloadsPath: downloads });
      return result.ok ? result.storyboard.scenes[index] : result;
    };
    const base = clean({});
    eq(base.stage, { frame: 'none', background: { type: 'none', color: '', color2: '', angle: 135, image: '', blur: 0 }, shadow: 0.6, scale: 0.84, radius: 1, tilt: { x: 0, y: 0 }, motion: 'none', label: '' }, 'الافتراضي = مظهر v1');
    eq([base.transition_in, base.redactions], ['none', []], 'بلا انتقال ولا تغبيش');
    eq(cleanStage(undefined), base.stage, 'افتراضي الواجهة يطابق افتراضي main');
    const full = clean({ stage: { frame: 'browser', background: { type: 'linear', color: '#AABBCC', color2: '#112233', angle: 45 }, shadow: 0.9, scale: 0.8, radius: 0, tilt: { x: 5, y: -10 }, motion: 'orbit', label: ' example.com ' } });
    eq(full.stage, { frame: 'browser', background: { type: 'linear', color: '#aabbcc', color2: '#112233', angle: 45, image: '', blur: 0 }, shadow: 0.9, scale: 0.8, radius: 0, tilt: { x: 5, y: -10 }, motion: 'orbit', label: 'example.com' }, 'قيم صالحة');
    const bad = clean({ stage: { frame: 'hologram', background: { type: 'laser', color: 'red', color2: 'url(x)', angle: 999, blur: -5 }, shadow: 7, scale: 3, tilt: { x: 90, y: NaN }, motion: 'spin', label: 5 } });
    eq(bad.stage, base.stage, 'كل قيمة خارج النطاق تعود إلى الافتراضي');
    eq(clean({ stage: 'browser' }).stage, base.stage, 'stage ليس كائناً');
    eq(clean({ stage: { background: ['linear'], tilt: [1, 2] } }).stage, base.stage, 'حقول فرعية مصفوفات');
    eq(clean({ stage: { frame: 'browser', label: 'a‮b\u0000c‏d' + 'x'.repeat(200) } }).stage.label.length, 60, 'نص الرابط بلا محارف تحكم ومحدود');
    ok(!/[\u0000-\u001f‮‏]/.test(clean({ stage: { label: 'a‮b\u0000c‏d' } }).stage.label), 'لا محارف اتجاه في نص الرابط');
    eq(clean({ stage: { background: { type: 'image', image, blur: 12 } } }).stage.background, { type: 'image', color: '', color2: '', angle: 135, image, blur: 12 }, 'صورة داخل Downloads');
    eq(clean({ stage: { background: { type: 'image', image: secret } } }).stage.background.type, 'none', 'صورة خارج Downloads ⇒ بلا خلفية');
    eq(clean({ stage: { background: { type: 'image', image: secret } } }).stage.background.image, '', 'ولا يُحفظ مسارها');
    eq(clean({ stage: { background: { type: 'image', image: clip } } }).stage.background.type, 'none', 'ملف ليس صورة');
    eq(clean({ stage: { background: { type: 'image' } } }).stage.background.type, 'none', 'صورة بلا مسار');
    // الانتقال: أول مشهد دائماً بلا انتقال
    eq(clean({ transition_in: 'slide' }, 0).transition_in, 'none', 'أول مشهد لا ينتقل');
    eq(clean({ transition_in: 'slide' }, 1).transition_in, 'slide', 'المشهد الثاني ينتقل');
    eq(clean({ transition_in: 'explode' }, 1).transition_in, 'none', 'انتقال مجهول');

    // ── التغبيش: المعطوب يُرفض ولا يُسقط بصمت ──
    const region = (extra) => ({ x: 0.2, y: 0.3, width: 0.2, height: 0.05, start_ms: 0, end_ms: 3000, ...extra });
    eq(clean({ redactions: [region({ x: 0.123456 }), region({ auto: true, start_ms: 500 })] }).redactions,
      [{ x: 0.1235, y: 0.3, width: 0.2, height: 0.05, start_ms: 0, end_ms: 3000, auto: false }, { x: 0.2, y: 0.3, width: 0.2, height: 0.05, start_ms: 500, end_ms: 3000, auto: true }], 'مناطق صالحة');
    for (const [label, item] of [['x سالب', region({ x: -0.1 })], ['عرض صفر', region({ width: 0 })], ['يتجاوز الحافة', region({ x: 0.9, width: 0.3 })], ['NaN', region({ y: NaN })],
      ['Infinity', region({ height: Infinity })], ['زمن خارج المدة', region({ end_ms: 3001 })], ['نهاية قبل البداية', region({ start_ms: 2000, end_ms: 1000 })],
      ['زمن كسري', region({ start_ms: 1.5 })], ['نص', region({ x: '0.2' })], ['ليس كائناً', 5], ['null', null]]) {
      eq(clean({ redactions: [region({}), item] }).error, 'bad_redaction', 'منطقة مرفوضة ترفض المشروع: ' + label);
    }
    eq(clean({ redactions: Array.from({ length: 21 }, () => region({})) }).error, 'bad_redaction', 'أكثر من 20 منطقة');
    eq(clean({ redactions: Array.from({ length: 20 }, () => region({})) }).redactions.length, 20, '20 منطقة مقبولة');
    eq(clean({ redactions: 'all' }).error, 'bad_redaction', 'redactions ليست مصفوفة');
    // جولة حفظ/تحميل + الأصل المسموح
    const file = path.join(downloads, 'p.satr-promo.json');
    const board = { scenes: [{ asset: clip, duration_ms: 3000 }, { asset: clip, duration_ms: 3000, transition_in: 'blur', redactions: [region({})],
      stage: { frame: 'phone', background: { type: 'image', image, blur: 8 }, tilt: { x: 3, y: 12 } } }] };
    eq(studio.saveProject(downloads, board, file).ok, true, 'حفظ');
    const loaded = studio.loadProject(file, downloads).storyboard.scenes[1];
    eq([loaded.stage.frame, loaded.stage.background.image, loaded.stage.tilt, loaded.transition_in, loaded.redactions.length], ['phone', image, { x: 3, y: 12 }, 'blur', 1], 'الحقول تعود كما حُفظت');
    const controller = studio.create({ downloadsPath: downloads });
    controller.propose(board);
    eq(controller.assetUrl(image).ok, true, 'صورة الخلفية أصل مسموح بعرضه');
    eq(controller.assetUrl(path.join(downloads, 'other.png')).ok, false, 'صورة ليست في المشروع');

    // ── اقتراح التغبيش من الأحداث الحساسة ──
    const viewport = { width: 1000, height: 500 };
    const event = (t, extra) => ({ t_ms: t, kind: 'pointer', action: 'mousedown', rect: { x: 200, y: 100, width: 300, height: 40 }, viewport, ...extra });
    const scene = { duration_ms: 6000, trim_start_ms: 1000 };
    eq(suggestRedactions([event(2000)], scene), [], 'حدث غير حساس لا يُغبَّش');
    const suggested = suggestRedactions([event(3000, { sensitive: true }), event(3500, { sensitive: true }), event(4000, { sensitive: true, rect: { x: 600, y: 300, width: 200, height: 40 } }), event(9000, { sensitive: true }), event(2000, { sensitive: true, rect: null })], scene);
    eq(suggested.length, 2, 'حقلان حساسان (المكرر يُدمج، وما بعد المشهد وما بلا مستطيل يُهمل)');
    eq([suggested[0].start_ms, suggested[0].end_ms, suggested[0].auto], [1600, 6000, true], 'من قبيل الحدث حتى نهاية المشهد');
    ok(suggested[0].x < 0.2 && suggested[0].x + suggested[0].width > 0.5 && suggested[0].y < 0.2 && suggested[0].y + suggested[0].height > 0.28, 'المنطقة تغطي الحقل بحاشية');
    eq(studio.sanitizeRedactions(suggested, 6000).ok, true, 'المقترح يقبله main');
    eq(cleanRedactions([{ x: 0.5, y: 0.5, width: 0.9, height: 0.9, start_ms: -5, end_ms: 99999 }], 3000), [{ x: 0.5, y: 0.5, width: 0.5, height: 0.5, start_ms: 0, end_ms: 3000, auto: false }], 'تنظيف الواجهة يقصّ إلى الحدود');
    eq(cleanRedactions([{ x: 0.5 }, null, { x: 0, y: 0, width: 0.1, height: 0.1, start_ms: 10, end_ms: 10 }], 3000), [], 'تنظيف الواجهة يُسقط الناقص');

    // ── وسم الحقل الحساس يمر في سجل الأحداث: علم فقط ──
    const root = capture.eventRootFor(downloads);
    const segmentId = 'promo_' + 'c'.repeat(24);
    const sink = capture.createEventSink({ segmentId, root, now: () => 1000 });
    sink.markBeacon('start', { capture_ms: 0, media_ms: 0, visible: true });
    sink.record({ kind: 'pointer', source: 'human', action: 'mousedown', monotonic_ms: 500, sensitive: true, value: 'hunter2', viewport: { width: 800, height: 600, dpr: 1 }, rect: { x: 1, y: 2, width: 30, height: 10 } });
    sink.record({ kind: 'pointer', source: 'human', action: 'mousedown', monotonic_ms: 600, sensitive: 'yes', viewport: { width: 800, height: 600, dpr: 1 } });
    sink.markBeacon('end', { capture_ms: 1000, media_ms: 1000, visible: true });
    const finalized = sink.finalize(1000);
    const raw = fs.readFileSync(finalized.path, 'utf8');
    ok(!raw.includes('hunter2') && !raw.includes('value'), 'لا قيمة حقل تُكتب في السجل');
    const events = capture.readSegmentEvents(finalized.path).events;
    eq([events[0].sensitive, 'sensitive' in events[1]], [true, false], 'العلم true فقط يمر');
    const preview = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preview.js'), 'utf8');
    ok(preview.includes("input[type=password]") && preview.includes('sensitive:sens(event.target)') && preview.includes('sensitive: !!(meta && meta.sensitive)'), 'الالتقاط يسم حقول كلمة المرور للإنسان والوكيل');
    ok(!/sensitive[^\n]{0,80}\.value/.test(preview), 'الوسم لا يقرأ قيمة الحقل');
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  console.log('promo-stage-test: ok — ' + checks + ' فحصاً (التخطيط، الإمالة، تنقية المسرح والتغبيش، اقتراح التغبيش، وسم الحقول الحساسة).');
})().catch((error) => {
  console.error('promo-stage-test:', error && error.stack ? error.stack : error);
  process.exit(1);
});
