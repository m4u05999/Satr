// اختبار حي للإخراج البصري: بكسلات المسرح والإطارات والإمالة والتغبيش والانتقالات، ثم واجهة الاستوديو.

import { buildTimeline } from '../../src/ui/lib/promo/promo-timeline.js';
import { renderFrame } from '../../src/ui/lib/promo/promo-frame.js';
import { stageLayout } from '../../src/ui/lib/promo/promo-stage.js';
import { glAvailable } from '../../src/ui/lib/promo/promo-gl.js';
import { defaultStage } from '../../src/ui/lib/promo/studio-stage.js';

const W = 1920, H = 1080;
const COLORS = {
  background: '#000000', captionBackground: '#101010', captionText: '#ffffff', accent: '#d9a441',
  chrome: { body: '#30343c', bar: '#3a3f48', pill: '#1c1f24', text: '#c8ccd2', dots: ['#e5484d', '#d9a441', '#3fb950'], shadow: '#000000' },
};
const BLUE = '#1040c0';

// مصدر أخضر كله، فيه شبكة خطوط سوداء رفيعة في منطقة معلومة (نص وهمي حاد الحواف).
async function makeSource() {
  const canvas = new OffscreenCanvas(1600, 900);
  const context = canvas.getContext('2d');
  context.fillStyle = '#00c000'; context.fillRect(0, 0, 1600, 900);
  context.fillStyle = '#000000';
  for (let x = 480; x < 1120; x += 8) context.fillRect(x, 360, 4, 180); // المنطقة النسبية: x 0.3..0.7، y 0.4..0.6
  return { source: await createImageBitmap(canvas), width: 1600, height: 900 };
}

function draw(scene, t, frames, extra) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const runtime = { width: W, height: H, colors: COLORS, timeline: buildTimeline({ scenes: extra && extra.scenes ? extra.scenes : [scene] }), aspect: '16:9', ...(extra || {}) };
  renderFrame(canvas.getContext('2d', { alpha: false }), runtime, t, frames);
  return canvas;
}
const data = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
const pixel = (canvas, x, y) => { const d = canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
function bbox(canvas, test) {
  const d = data(canvas);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
    const i = (y * canvas.width + x) * 4;
    if (test(d[i], d[i + 1], d[i + 2])) { count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return count ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count } : { count: 0 };
}
const green = (r, g, b) => g > 150 && r < 70 && b < 70;
const blue = (r, g, b) => b > 150 && r < 60 && g < 110;
// تباين الحواف الأفقية داخل مستطيل: مجموع |فرق الجار| في القناة الخضراء. نص حاد ⇒ قيمة عالية.
function edgeEnergy(canvas, x, y, width, height) {
  const d = canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), Math.round(width), Math.round(height)).data;
  let sum = 0;
  const w = Math.round(width);
  for (let i = 0; i < d.length - 4; i += 4) if ((i / 4) % w !== w - 1) sum += Math.abs(d[i + 1] - d[i + 5]);
  return sum / (d.length / 4);
}

async function pixels() {
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };
  const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance;
  const image = await makeSource();
  const frames = new Map([[0, image]]);
  const stage = (extra) => ({ ...defaultStage(), ...extra, background: { ...defaultStage().background, ...(extra && extra.background) } });
  const scene = (stageValue, extra) => ({ duration_ms: 4000, transition: 'cut', fit: 'cover', caption: '', stage: stageValue, redactions: [], transition_in: 'none', ...(extra || {}) });

  // ── الخلفية وموضع المحتوى لكل إطار ──
  for (const frame of ['none', 'browser', 'laptop', 'phone', 'tablet']) {
    const value = stage({ frame, shadow: 0, background: { type: 'color', color: BLUE } });
    const canvas = draw(scene(value), 0, frames);
    const layout = stageLayout(value, 1600, 900, W, H);
    const content = bbox(canvas, green);
    expect(frame + ': الخلفية تملأ الزوايا', blue(...pixel(canvas, 4, 4)) && blue(...pixel(canvas, W - 5, H - 5)), [pixel(canvas, 4, 4), pixel(canvas, W - 5, H - 5)]);
    expect(frame + ': المحتوى في مستطيل التخطيط', near(content.x, layout.content.x, 4) && near(content.y, layout.content.y, 4)
      && near(content.width, layout.content.width, 8) && near(content.height, layout.content.height, 8), { content, expected: layout.content });
    if (frame !== 'none') {
      const mid = pixel(canvas, layout.device.x + layout.device.width / 2, layout.device.y + Math.max(2, layout.insets.top / 4));
      expect(frame + ': جسم الإطار مرسوم فوق المحتوى', !green(...mid) && !blue(...mid), mid);
    }
    expect(frame + ': زاوية الجهاز دائرية (بكسل الزاوية خلفية)', blue(...pixel(canvas, layout.device.x + 1, layout.device.y + 1)), pixel(canvas, layout.device.x + 1, layout.device.y + 1));
  }
  // نقاط شريط المتصفح الثلاث
  const browser = stage({ frame: 'browser', shadow: 0, label: 'example.com', background: { type: 'color', color: BLUE } });
  const browserCanvas = draw(scene(browser), 0, frames);
  const browserLayout = stageLayout(browser, 1600, 900, W, H);
  const bar = browserLayout.insets.top;
  const red = bbox(browserCanvas, (r, g, b) => r > 200 && g < 110 && b < 110);
  expect('المتصفح: النقطة الحمراء في الشريط', red.count > 20 && red.y >= browserLayout.device.y && red.y + red.height <= browserLayout.device.y + bar, red);
  const labelInk = bbox(browserCanvas, (r, g, b) => r > 170 && g > 170 && b > 170);
  expect('المتصفح: نص النطاق مرسوم داخل الشريط', labelInk.count > 30 && labelInk.y >= browserLayout.device.y && labelInk.y + labelInk.height <= browserLayout.device.y + bar, labelInk);
  // زوايا بلا تدوير
  const square = stage({ frame: 'none', radius: 0, shadow: 0, background: { type: 'color', color: BLUE } });
  const squareLayout = stageLayout(square, 1600, 900, W, H);
  expect('radius 0: الزاوية محتوى لا خلفية', green(...pixel(draw(scene(square), 0, frames), squareLayout.device.x + 1, squareLayout.device.y + 1)));

  // ── التدرجات ──
  const linear = draw(scene(stage({ frame: 'none', shadow: 0, background: { type: 'linear', color: '#ff0000', color2: '#0000ff', angle: 0 } })), 0, frames);
  const leftPixel = pixel(linear, 5, H / 2), rightPixel = pixel(linear, W - 6, H / 2);
  expect('التدرج الخطي: أحمر يساراً وأزرق يميناً عند الزاوية 0', leftPixel[0] > 200 && leftPixel[2] < 60 && rightPixel[2] > 200 && rightPixel[0] < 60, [leftPixel, rightPixel]);
  const radial = draw(scene(stage({ frame: 'phone', shadow: 0, scale: 0.78, background: { type: 'radial', color: '#000000', color2: '#ffffff' } })), 0, frames);
  expect('التدرج الشعاعي: الزاوية أعتم من منتصف الحافة العليا (الأقرب إلى المركز)', pixel(radial, 5, 5)[0] + 30 < pixel(radial, W / 2, 6)[0], [pixel(radial, 5, 5), pixel(radial, W / 2, 6)]);

  // ── الظل ──
  const light = { ...COLORS, background: '#808080' };
  const shadowed = stage({ frame: 'none', shadow: 1, background: { type: 'color', color: '#808080' } });
  const shadowLayout = stageLayout(shadowed, 1600, 900, W, H);
  const below = (value) => {
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    renderFrame(canvas.getContext('2d', { alpha: false }), { width: W, height: H, colors: light, timeline: buildTimeline({ scenes: [scene(value)] }), aspect: '16:9' }, 0, frames);
    return pixel(canvas, W / 2, shadowLayout.device.y + shadowLayout.device.height + 14)[0];
  };
  expect('الظل يعتّم ما تحت الجهاز', below(shadowed) < below({ ...shadowed, shadow: 0 }) - 20, [below(shadowed), below({ ...shadowed, shadow: 0 })]);

  // ── الإمالة عبر WebGL2 ──
  const gl = glAvailable();
  const flatStage = stage({ frame: 'none', shadow: 0, radius: 0, background: { type: 'color', color: BLUE } });
  const flat = draw(scene(flatStage), 0, frames);
  const flatBox = bbox(flat, green);
  if (gl) {
    const tilted = draw(scene({ ...flatStage, tilt: { x: 0, y: 22 } }), 0, frames);
    const tiltedBox = bbox(tilted, green);
    // ارتفاع العمود الأخضر قرب الحافتين: المنظور يجعل أحدهما أقصر
    const column = (canvas, x) => { let count = 0; const d = canvas.getContext('2d').getImageData(Math.round(x), 0, 1, H).data; for (let i = 0; i < d.length; i += 4) if (green(d[i], d[i + 1], d[i + 2])) count += 1; return count; };
    const leftColumn = column(tilted, tiltedBox.x + 12), rightColumn = column(tilted, tiltedBox.x + tiltedBox.width - 12);
    expect('الإمالة الأفقية: أحد الطرفين أقصر (منظور)', Math.abs(leftColumn - rightColumn) > 40, [leftColumn, rightColumn]);
    expect('الإمالة تضيّق العرض الظاهر', tiltedBox.width < flatBox.width - 20, [tiltedBox.width, flatBox.width]);
    expect('الجهاز المائل داخل اللوحة', tiltedBox.x > 0 && tiltedBox.y > 0 && tiltedBox.x + tiltedBox.width < W && tiltedBox.y + tiltedBox.height < H, tiltedBox);
    expect('المائل يبقى في الوسط تقريباً', Math.abs(tiltedBox.x + tiltedBox.width / 2 - W / 2) < 60 && Math.abs(tiltedBox.y + tiltedBox.height / 2 - H / 2) < 40, tiltedBox);
    const zeroTilt = draw(scene({ ...flatStage, tilt: { x: 0, y: 0 } }), 0, frames);
    expect('إمالة صفر = الرسم المستوي تماماً', zeroTilt.toDataURL() === flat.toDataURL());
    const again = draw(scene({ ...flatStage, tilt: { x: 8, y: -15 }, shadow: 0.7 }), 0, frames);
    const again2 = draw(scene({ ...flatStage, tilt: { x: 8, y: -15 }, shadow: 0.7 }), 0, frames);
    expect('الإطار المائل حتمي', again.toDataURL() === again2.toDataURL());
    const orbitA = draw(scene({ ...flatStage, motion: 'orbit' }), 0, frames), orbitB = draw(scene({ ...flatStage, motion: 'orbit' }), 3900, frames);
    expect('المدار يغيّر الإطار مع الزمن', orbitA.toDataURL() !== orbitB.toDataURL());
  }

  // ── التغبيش ──
  const redaction = { x: 0.3, y: 0.4, width: 0.4, height: 0.2, start_ms: 1000, end_ms: 3000, auto: true };
  for (const [label, sceneValue] of [
    ['بلا مسرح', scene(defaultStage(), { redactions: [redaction] })],
    ['مع إطار جوال وخلفية', scene(stage({ frame: 'tablet', shadow: 0, background: { type: 'color', color: BLUE } }), { redactions: [redaction] })],
    ['مع كاميرا مكبّرة', scene(defaultStage(), { redactions: [redaction], camera: { mode: 'manual', cursor: false, keyframes: [{ t_ms: 0, x: 0.5, y: 0.5, zoom: 1.6, ease: 'hold' }] } })],
  ]) {
    const before = draw(sceneValue, 500, frames), during = draw(sceneValue, 2000, frames), after = draw(sceneValue, 3500, frames);
    const lines = bbox(before, (r, g, b) => r < 40 && g < 60 && b < 40 && true);
    // منطقة الخطوط كما تظهر قبل التغبيش (سوداء على أخضر) نأخذها من فرق الإطارين
    const region = (() => {
      const a = data(before), b = data(during);
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (Math.abs(a[i + 1] - b[i + 1]) > 30) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      return maxX < 0 ? null : { x: minX + 6, y: minY + 6, width: maxX - minX - 12, height: maxY - minY - 12 };
    })();
    expect(label + ': التغبيش يغيّر منطقة داخل الإطار', !!region && region.width > 100 && region.height > 30, { region, lines: lines.count });
    if (region) {
      const sharp = edgeEnergy(before, region.x, region.y, region.width, region.height);
      const blurred = edgeEnergy(during, region.x, region.y, region.width, region.height);
      expect(label + ': الحواف الحادة تختفي داخل المنطقة', sharp > 20 && blurred < sharp * 0.15, { sharp, blurred });
    }
    expect(label + ': خارج نافذة الزمن لا تغبيش', before.toDataURL() === after.toDataURL());
    // خارج المنطقة لا يتغير شيء
    const a = data(before), b = data(during);
    let outside = 0;
    for (let i = 0; i < 400 * W * 4 * 0 + W * 4 * 60; i += 4) if (Math.abs(a[i + 1] - b[i + 1]) > 8) outside += 1;
    expect(label + ': أعلى الإطار خارج المنطقة لم يتغير', outside === 0, outside);
  }

  // ── انتقالات الدخول ──
  const second = await (async () => {
    const canvas = new OffscreenCanvas(1600, 900); const context = canvas.getContext('2d');
    context.fillStyle = '#c00000'; context.fillRect(0, 0, 1600, 900);
    return { source: await createImageBitmap(canvas), width: 1600, height: 900 };
  })();
  const redFn = (r, g, b) => r > 150 && g < 70 && b < 70;
  const two = (type) => [scene(defaultStage()), scene(defaultStage(), { transition_in: type })];
  const bothFrames = new Map([[0, image], [1, second]]);
  const snapshot = draw(two('none')[0], 3999, frames);
  for (const type of ['crossfade', 'slide', 'zoom', 'blur']) {
    const scenes = two(type);
    const at = (t) => draw(null, 4000 + t, bothFrames, { scenes, snapshots: new Map([[1, snapshot]]) });
    const start = at(0), middle = at(250), end = at(600);
    const plain = draw(null, 4600, bothFrames, { scenes: two('none') });
    expect(type + ': بعد الانتقال الإطار هو المشهد الجديد وحده', end.toDataURL() === plain.toDataURL());
    const startGreen = bbox(start, green).count, middleGreen = bbox(middle, green).count, middleRed = bbox(middle, redFn).count;
    expect(type + ': يبدأ من لقطة المشهد السابق', startGreen > W * H * 0.5, startGreen);
    expect(type + ': في المنتصف يظهر المشهدان أو مزيجهما', type === 'slide' ? (middleGreen > W * H * 0.2 && middleRed > W * H * 0.2) : middle.toDataURL() !== start.toDataURL() && middle.toDataURL() !== end.toDataURL(), { middleGreen, middleRed });
    expect(type + ': بلا لقطة لا انتقال (لا انهيار)', draw(null, 4250, bothFrames, { scenes }).toDataURL() === draw(null, 4250, bothFrames, { scenes: two('none') }).toDataURL());
  }
  const slide = draw(null, 4250, bothFrames, { scenes: two('slide'), snapshots: new Map([[1, snapshot]]) });
  expect('slide: الجديد يدخل من اليمين والسابق يخرج يساراً', redFn(...pixel(slide, W - 20, 100)) && green(...pixel(slide, 20, 100)), [pixel(slide, W - 20, 100), pixel(slide, 20, 100)]);
  return { failures, gl };
}

async function ui() {
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };
  const asset = 'C:\\Downloads\\satr-promo-segment-stage.mp4', picture = 'C:\\Downloads\\bg.png';
  const brandCalls = [];
  const viewport = { width: 1000, height: 500 };
  const events = [
    { t_ms: 1000, kind: 'pointer', source: 'human', action: 'mousedown', rect: { x: 100, y: 100, width: 200, height: 40 }, pointer: { x: 150, y: 120, button: 0 }, viewport, timing_quality: 'verified' },
    { t_ms: 2000, kind: 'action', source: 'agent', action: 'type', rect: { x: 400, y: 300, width: 300, height: 40 }, pointer: null, viewport, timing_quality: 'verified', sensitive: true },
  ];
  window.satr = {
    promoStudioState: async () => ({ ok: true, storyboard: null, segments: [{ path: asset, duration_ms: 5000, aspect: '16:9' }, { path: asset, duration_ms: 3000, aspect: '16:9' }] }),
    promoAssetUrl: async () => ({ ok: false }),
    promoSegmentEvents: async () => ({ ok: true, events }),
    promoListDownloads: async () => ({ ok: true, files: [] }),
    promoCaptureStart: async () => ({ ok: true }), promoCaptureStop: async () => ({ ok: true }),
    promoBrandSave: async (cwd, brand) => { brandCalls.push(['save', cwd, JSON.parse(JSON.stringify(brand))]); return { ok: true, brand }; },
    promoBrandLoad: async (cwd) => { brandCalls.push(['load', cwd]); return { ok: true, exists: true, brand: { name: 'من الملف', primary: '#010203', secondary: '#040506', accent: '#070809', closing: 'عبارة الملف', logo: '' } }; },
    onPromoCapture() { return () => {}; },
  };
  await import('../../src/ui/components/promo-studio.js');
  const studio = document.querySelector('satr-promo-studio');
  await studio.open();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  await settle();
  const root = studio.shadowRoot;
  const card = (index = 0) => root.querySelector('.scene[data-index="' + index + '"]');
  const scene = (index = 0) => studio.getStoryboard().scenes[index];
  const set = async (index, field, value, type = 'change') => {
    const control = card(index).querySelector('[data-field="' + field + '"]');
    if (!control) throw new Error('no control ' + field);
    control.value = value;
    control.dispatchEvent(new Event(type, { bubbles: true }));
    await settle();
  };

  expect('مقطع جديد فيه حقل حساس يُغبَّش افتراضياً', scene().redactions.length === 1 && scene().redactions[0].auto === true, scene().redactions);
  const auto = scene().redactions[0];
  expect('منطقة التغبيش تغطي الحقل الحساس لا الزر العادي', auto.x < 0.4 && auto.x + auto.width > 0.7 && auto.y < 0.6 && auto.y + auto.height > 0.68, auto);
  expect('صف منطقة التغبيش ظاهر وموسوم «تلقائي»', card().querySelectorAll('div[data-redaction]').length === 1 && card().textContent.includes('تلقائي'));
  expect('حقول المسرح التفصيلية مخفية قبل تفعيله', !card().querySelector('[data-field="stage_scale"]'));
  expect('انتقال الدخول مقفل لأول مشهد ومتاح للثاني', card(0).querySelector('[data-field="transition_in"]').disabled && !card(1).querySelector('[data-field="transition_in"]').disabled);

  await set(0, 'stage_frame', 'browser');
  expect('اختيار الإطار يصل المشروع ويُظهر الحقول', scene().stage.frame === 'browser' && !!card().querySelector('[data-field="stage_scale"]') && !!card().querySelector('[data-field="stage_label"]'), scene().stage);
  await set(0, 'stage_background', 'linear');
  expect('الخلفية المتدرجة تُظهر لونين', scene().stage.background.type === 'linear' && !!card().querySelector('[data-field="stage_color"]') && !!card().querySelector('[data-field="stage_color2"]'));
  await set(0, 'stage_color', '#123456', 'input');
  await set(0, 'stage_tilt_y', '99', 'input');
  await set(0, 'stage_scale', '50', 'input');
  await set(0, 'stage_label', 'satr.app', 'input');
  expect('القيم تُقصّ عند الحدود', scene().stage.background.color === '#123456' && scene().stage.tilt.y === 25 && scene().stage.scale === 0.78 && scene().stage.label === 'satr.app', scene().stage);
  await set(1, 'transition_in', 'slide');
  expect('انتقال الدخول للمشهد الثاني', scene(1).transition_in === 'slide', scene(1).transition_in);
  expect('أي تعديل يلغي الاعتماد', studio.approved === false);

  card().querySelector('[data-action="redact-add"]').click();
  await settle();
  expect('تغبيش يدوي يُضاف', scene().redactions.length === 2 && scene().redactions[1].auto === false, scene().redactions.length);
  const widthInput = card().querySelectorAll('div[data-redaction]')[1].querySelector('[data-field="redact_width"]');
  widthInput.value = '500'; widthInput.dispatchEvent(new Event('input', { bubbles: true }));
  expect('أبعاد التغبيش تُقصّ داخل الإطار', scene().redactions[1].x + scene().redactions[1].width <= 1.0001, scene().redactions[1]);
  card().querySelector('[data-action="redact-remove"][data-redaction="0"]').click();
  await settle();
  expect('حذف التغبيش التلقائي بقرار المستخدم', scene().redactions.length === 1 && scene().redactions[0].auto === false, scene().redactions);
  card().querySelector('[data-action="redact-suggest"]').click();
  await settle();
  expect('«اقترح تغبيش» يعيد التلقائي ويبقي اليدوي', scene().redactions.length === 2 && scene().redactions.some((item) => item.auto) && scene().redactions.some((item) => !item.auto), scene().redactions);

  // تقصير المشهد يقصّ التغبيش التلقائي عند المدة الجديدة
  await set(0, 'duration_ms', '3000');
  expect('التغبيش يتبع مدة المشهد', scene().redactions.every((item) => item.end_ms <= 3000), scene().redactions);

  // ما يُحفظ يقبله main: نفس القيود
  const saved = studio.getStoryboard();
  expect('المشروع قابل للتسلسل وفيه حقول المسرح', JSON.parse(JSON.stringify(saved)).scenes[0].stage.frame === 'browser' && Array.isArray(saved.scenes[0].redactions));

  // ── القوالب والهوية (الدفعة 9) ──
  const project = () => root.querySelector('.project');
  const status = () => root.getElementById('status').textContent;
  expect('بطاقة القالب والهوية أعلى الخط الزمني', !!project() && project().querySelector('[data-field="template"]').options.length >= 4);
  const keptCamera = JSON.stringify(scene().camera), keptRedactions = JSON.stringify(scene().redactions), keptCaption = scene().caption;
  const templateSelect = project().querySelector('[data-field="template"]');
  templateSelect.value = 'new-feature'; templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
  project().querySelector('[data-action="template-apply"]').click();
  await settle();
  expect('القالب يغيّر المقاس والمسرح والانتقال', studio.getStoryboard().aspect === '16:9' && scene(0).stage.frame === 'browser' && scene(0).stage.background.type === 'linear'
    && scene(0).transition_in === 'none' && scene(1).transition_in === 'slide' && scene(0).text_style.animation === 'slide', [scene(0).stage, scene(1).transition_in]);
  expect('القالب لا يمس الكاميرا ولا التغبيش ولا النص ولا نطاق العرض', JSON.stringify(scene().camera) === keptCamera && JSON.stringify(scene().redactions) === keptRedactions
    && scene().caption === keptCaption && scene().stage.label === 'satr.app', scene().stage.label);
  expect('القالب يلغي الاعتماد ويشرح', studio.approved === false && status().includes('ميزة جديدة'), status());
  expect('القالب المختار يبقى محدداً بعد إعادة الرسم', project().querySelector('[data-field="template"]').value === 'new-feature');
  const setProject = (field, value, type = 'input') => { const control = project().querySelector('[data-field="' + field + '"]'); control.value = value; control.dispatchEvent(new Event(type, { bubbles: true })); };
  setProject('brand_name', 'سطر');
  setProject('brand_primary', '#112233');
  setProject('brand_closing', 'حمّل التطبيق الآن');
  expect('حقول الهوية مسودة لا تغيّر المشاهد قبل التطبيق', scene(0).stage.background.color !== '#112233' && !studio.getStoryboard().brand);
  project().querySelector('[data-action="brand-apply"]').click();
  await settle();
  const brand = studio.getStoryboard().brand;
  expect('تطبيق الهوية يلوّن الخلفيات ويحفظها في المشروع', scene(0).stage.background.color === '#112233' && scene(1).stage.background.color === '#112233' && brand && brand.primary === '#112233' && brand.name === 'سطر', brand);
  expect('لون لم يُختر يأخذ القيمة الظاهرة في الحقل', /^#[0-9a-f]{6}$/.test(brand.secondary) && scene(0).stage.background.color2 === brand.secondary, brand);
  expect('عبارة ختام بلا شعار: لا بطاقة، والرسالة تشرح', studio.getStoryboard().scenes.length === 2 && status().includes('شعار'), status());
  expect('حقول الهوية تعرض المحفوظ بعد إعادة الرسم', project().querySelector('[data-field="brand_name"]').value === 'سطر' && project().querySelector('[data-field="brand_primary"]').value === '#112233');
  project().querySelector('[data-action="brand-save"]').click();
  await settle();
  expect('الحفظ بلا مجلد مشروع يشرح ولا يستدعي main', brandCalls.length === 0 && status().includes('مجلد المشروع'), status());
  studio.getProjectRoot = () => 'C:\\Projects\\demo';
  project().querySelector('[data-action="brand-save"]').click();
  await settle();
  expect('الحفظ يرسل مجلد المشروع والهوية', brandCalls.length === 1 && brandCalls[0][0] === 'save' && brandCalls[0][1] === 'C:\\Projects\\demo' && brandCalls[0][2].primary === '#112233', brandCalls);
  project().querySelector('[data-action="brand-load"]').click();
  await settle();
  expect('التحميل يملأ الحقول ولا يلوّن المشاهد حتى التطبيق', brandCalls.length === 2 && project().querySelector('[data-field="brand_name"]').value === 'من الملف'
    && studio.getStoryboard().brand.accent === '#070809' && scene(0).stage.background.color === '#112233', [brandCalls.length, studio.getStoryboard().brand]);
  expect('أزرار GIF والصورة المصغرة معطّلة بلا قنوات التصدير', root.getElementById('gif').disabled && root.getElementById('thumb').disabled);

  // مشروع مُمرَّر لا يُغبَّش تلقائياً (قرار المستخدم محفوظ)
  await studio.open({ aspect: '16:9', scenes: [{ id: 'x', asset, asset_type: 'video', caption: '', duration_ms: 5000 }] });
  await settle();
  expect('storyboard مُمرَّر لا يُفرض عليه تغبيش', scene().redactions.length === 0, scene().redactions);
  expect('لكن زر الاقتراح متاح لأن في السجل حقلاً حساساً', !card().querySelector('[data-action="redact-suggest"]').disabled);
  void picture;
  return failures;
}

window.__promoStage = (async () => {
  const pixel = await pixels();
  const uiFailures = await ui();
  return { ok: !pixel.failures.length && !uiFailures.length, gl: pixel.gl, pixelFailures: pixel.failures, uiFailures };
})().catch((error) => ({ ok: false, pixelFailures: [String(error && error.stack || error)], uiFailures: [] }));
