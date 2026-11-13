// صف المسرح وصف التغبيش في بطاقة المشهد داخل استوديو البرومو. لا حالة هنا.

import { STAGE_FRAMES, STAGE_BACKGROUNDS, STAGE_MOTIONS, STAGE_SCALE_MIN, STAGE_SCALE_MAX, STAGE_TILT_MAX } from './promo-stage.js';
import { eventToFrame } from './promo-camera.js';

export const TRANSITION_IN_VALUES = Object.freeze(['none', 'crossfade', 'slide', 'zoom', 'blur']);
export const MAX_REDACTIONS = 20;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, min, max, fallback) => (typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback);

export function defaultStage() {
  return { frame: 'none', background: { type: 'none', color: '', color2: '', angle: 135, image: '', blur: 0 }, shadow: 0.6, scale: 0.84, radius: 1, tilt: { x: 0, y: 0 }, motion: 'none', label: '' };
}

// تنظيف جهة الواجهة؛ التنقية الملزمة في electron/promostudio.js.
export function cleanStage(raw) {
  const stage = defaultStage();
  if (!raw || typeof raw !== 'object') return stage;
  if (STAGE_FRAMES.includes(raw.frame)) stage.frame = raw.frame;
  const background = raw.background && typeof raw.background === 'object' ? raw.background : {};
  if (STAGE_BACKGROUNDS.includes(background.type)) stage.background.type = background.type;
  if (COLOR.test(background.color || '')) stage.background.color = background.color;
  if (COLOR.test(background.color2 || '')) stage.background.color2 = background.color2;
  stage.background.angle = number(background.angle, 0, 360, 135);
  stage.background.image = typeof background.image === 'string' ? background.image.slice(0, 4096) : '';
  stage.background.blur = number(background.blur, 0, 40, 0);
  stage.shadow = number(raw.shadow, 0, 1, 0.6);
  stage.scale = number(raw.scale, STAGE_SCALE_MIN, STAGE_SCALE_MAX, 0.84);
  stage.radius = raw.radius === 0 ? 0 : 1;
  const tilt = raw.tilt && typeof raw.tilt === 'object' ? raw.tilt : {};
  stage.tilt = { x: number(tilt.x, -STAGE_TILT_MAX, STAGE_TILT_MAX, 0), y: number(tilt.y, -STAGE_TILT_MAX, STAGE_TILT_MAX, 0) };
  if (STAGE_MOTIONS.includes(raw.motion)) stage.motion = raw.motion;
  stage.label = typeof raw.label === 'string' ? raw.label.slice(0, 60) : '';
  return stage;
}

export function cleanRedactions(raw, durationMs) {
  const list = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_REDACTIONS) : []) {
    if (!item || ![item.x, item.y, item.width, item.height, item.start_ms, item.end_ms].every(Number.isFinite)) continue;
    const x = clamp(item.x, 0, 1), y = clamp(item.y, 0, 1);
    const start = clamp(Math.round(item.start_ms), 0, durationMs), end = clamp(Math.round(item.end_ms), 0, durationMs);
    if (end <= start) continue;
    list.push({ x, y, width: clamp(item.width, 0.005, 1 - x), height: clamp(item.height, 0.005, 1 - y), start_ms: start, end_ms: end, auto: item.auto === true });
  }
  return list;
}

// اقتراح تغبيش من أحداث وُسمت حساسة عند الالتقاط (حقل كلمة مرور أو بطاقة أو رمز تحقق).
// المنطقة تُغبَّش من قبيل الحدث حتى نهاية المشهد: لا نعرف متى يختفي الحقل. نقية.
export function suggestRedactions(events, scene) {
  const durationMs = scene.duration_ms, sourceStartMs = scene.trim_start_ms || 0;
  const regions = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.sensitive !== true || !Number.isFinite(event.t_ms)) continue;
    const box = eventToFrame(event.rect, event.viewport);
    if (!box) continue;
    const t = event.t_ms - sourceStartMs;
    if (t > durationMs) continue;
    // حاشية صغيرة حول الحقل تغطي حدوده وأيقونة «إظهار».
    const padX = 0.01, padY = 0.01;
    const x = clamp(box.x - padX, 0, 1), y = clamp(box.y - padY, 0, 1);
    const region = { x, y, width: clamp(box.width + padX * 2, 0.005, 1 - x), height: clamp(box.height + padY * 2, 0.005, 1 - y),
      start_ms: clamp(Math.round(t - 400), 0, durationMs), end_ms: durationMs, auto: true };
    const same = regions.find((item) => Math.abs(item.x - region.x) < 0.01 && Math.abs(item.y - region.y) < 0.01);
    if (same) same.start_ms = Math.min(same.start_ms, region.start_ms);
    else if (regions.length < MAX_REDACTIONS && region.end_ms > region.start_ms) regions.push(region);
  }
  return regions;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function select(field, value, options) {
  const node = element('select');
  node.dataset.field = field;
  for (const [optionValue, label] of options) { const option = element('option', null, label); option.value = optionValue; node.appendChild(option); }
  node.value = value;
  return node;
}
function input(type, field, value, attributes) {
  const node = element('input', type === 'number' ? 'cam-num' : null);
  node.type = type; node.dataset.field = field; node.value = String(value);
  for (const [name, attribute] of Object.entries(attributes || {})) node.setAttribute(name, String(attribute));
  return node;
}
function labelled(text, control) { const node = element('label', null, text); node.appendChild(control); return node; }

// options: { imageOptions: [مسارات صور المشروع], fallbackColor, fallbackColor2, canSuggestRedactions, isFirst }
export function buildStageRows(scene, options) {
  const stage = scene.stage;
  const wrap = element('div', 'camera');
  const first = element('div', 'row');
  first.append(
    labelled('الإطار', select('stage_frame', stage.frame, [['none', 'بدون'], ['browser', 'متصفح'], ['laptop', 'لابتوب'], ['phone', 'جوال'], ['tablet', 'تابلت']])),
    labelled('الخلفية', select('stage_background', stage.background.type, [['none', 'بدون'], ['color', 'لون'], ['linear', 'تدرج خطي'], ['radial', 'تدرج شعاعي'], ['image', 'صورة من المشروع']])),
  );
  const active = stage.frame !== 'none' || stage.background.type !== 'none';
  if (stage.background.type === 'color' || stage.background.type === 'linear' || stage.background.type === 'radial') {
    first.appendChild(labelled('لون', input('color', 'stage_color', stage.background.color || options.fallbackColor)));
    if (stage.background.type !== 'color') first.appendChild(labelled('لون ثانٍ', input('color', 'stage_color2', stage.background.color2 || options.fallbackColor2)));
  }
  if (stage.background.type === 'image') {
    const images = [['', 'اختر صورة…']].concat(options.imageOptions.map((path) => [path, path.split(/[\\/]/).pop()]));
    first.appendChild(labelled('الصورة', select('stage_image', stage.background.image, images)));
    first.appendChild(labelled('تغبيش', input('number', 'stage_blur', stage.background.blur, { min: 0, max: 40, step: 2 })));
  }
  wrap.appendChild(first);
  if (active) {
    const second = element('div', 'row');
    second.append(
      labelled('الحجم ٪', input('number', 'stage_scale', Math.round(stage.scale * 100), { min: STAGE_SCALE_MIN * 100, max: STAGE_SCALE_MAX * 100, step: 1 })),
      labelled('إمالة أفقية°', input('number', 'stage_tilt_y', stage.tilt.y, { min: -STAGE_TILT_MAX, max: STAGE_TILT_MAX, step: 1 })),
      labelled('إمالة رأسية°', input('number', 'stage_tilt_x', stage.tilt.x, { min: -STAGE_TILT_MAX, max: STAGE_TILT_MAX, step: 1 })),
      labelled('حركة', select('stage_motion', stage.motion, [['none', 'ثابتة'], ['orbit', 'مدار خفيف']])),
      labelled('الظل', input('number', 'stage_shadow', stage.shadow, { min: 0, max: 1, step: 0.1 })),
    );
    if (stage.frame === 'browser') {
      const label = input('text', 'stage_label', stage.label, { maxlength: 60, placeholder: 'example.com' });
      label.className = 'highlight';
      second.appendChild(labelled('نطاق العرض', label));
    }
    wrap.appendChild(second);
  }
  const third = element('div', 'row');
  const transition = select('transition_in', scene.transition_in, [['none', 'بدون'], ['crossfade', 'تلاشٍ متقاطع'], ['slide', 'انزلاق'], ['zoom', 'تكبير عابر'], ['blur', 'تغبيش عابر']]);
  if (options.isFirst) { transition.disabled = true; transition.dataset.locked = '1'; transition.title = 'أول مشهد لا يسبقه شيء ينتقل منه'; }
  third.appendChild(labelled('انتقال الدخول', transition));
  const count = scene.redactions.length;
  third.appendChild(element('span', 'cam-hint', count ? 'مناطق مغبَّشة: ' + count : 'لا تغبيش'));
  const suggest = element('button', null, 'اقترح تغبيش');
  suggest.type = 'button'; suggest.dataset.action = 'redact-suggest';
  suggest.title = options.canSuggestRedactions ? 'غبّش حقول كلمات المرور والبطاقات التي كُتب فيها أثناء التسجيل' : 'لا حقول حساسة في سجل هذا المقطع';
  if (!options.canSuggestRedactions) { suggest.disabled = true; suggest.dataset.locked = '1'; }
  const add = element('button', null, '＋ تغبيش يدوي');
  add.type = 'button'; add.dataset.action = 'redact-add'; add.title = 'أضف مستطيل تغبيش في وسط الإطار ثم عدّل موضعه';
  third.append(suggest, add);
  wrap.appendChild(third);
  scene.redactions.forEach((region, index) => {
    const row = element('div', 'row cam-editor');
    row.dataset.redaction = String(index);
    const percent = (value) => Math.round(value * 1000) / 10;
    const remove = element('button', null, '✕');
    remove.type = 'button'; remove.dataset.action = 'redact-remove'; remove.dataset.redaction = String(index);
    remove.title = 'احذف منطقة التغبيش'; remove.setAttribute('aria-label', 'احذف منطقة التغبيش ' + (index + 1));
    row.append(
      element('span', 'cam-hint', region.auto ? 'تلقائي' : 'يدوي'),
      labelled('أفقي٪', input('number', 'redact_x', percent(region.x), { min: 0, max: 100, step: 0.5 })),
      labelled('رأسي٪', input('number', 'redact_y', percent(region.y), { min: 0, max: 100, step: 0.5 })),
      labelled('عرض٪', input('number', 'redact_width', percent(region.width), { min: 0.5, max: 100, step: 0.5 })),
      labelled('ارتفاع٪', input('number', 'redact_height', percent(region.height), { min: 0.5, max: 100, step: 0.5 })),
      remove,
    );
    wrap.appendChild(row);
  });
  return wrap;
}
