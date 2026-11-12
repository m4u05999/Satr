// الكاميرا الذكية: أحداث التسجيل ⇒ نقاط مفتاحية. دوال نقية بلا DOM، تُختبر بـnode.
// الإحداثيات كلها نسبية (0..1) إلى إطار المصدر: rect ÷ viewport. المسبار (الدفعة 0) قاس
// أن هذه النسبة تطابق موضع العنصر في الفيديو بخطأ ≤ 1 بكسل، بلا إزاحة.

export const CAMERA_DEFAULTS = Object.freeze({
  padding: 0.18,        // حاشية حول العنصر، نسبةً إلى بعده
  minZoom: 1.4,
  maxZoom: 2.5,
  pointerZoom: 1.3,     // حين يغيب rect أو يكون التوقيت غير موثّق
  leadMs: 350,          // الكاميرا تصل قبل الحدث بهذا القدر على الأقل
  holdMs: 1200,         // أقل زمن إمساك بعد آخر حدث في اللقطة
  mergeMs: 900,         // أحداث أقرب من هذا وفي المنطقة نفسها = لقطة واحدة
  idleMs: 2500,         // خمول أطول من هذا ⇒ عودة إلى الزوم 1
  minMoveMs: 350,
  maxCenterSpeed: 1.6,  // أقصى سرعة لحظية لمركز الكاميرا (عرض إطار/ثانية) — يمنع الدوار
  maxZoomSpeed: 3.0,    // أقصى تغيّر لحظي في الزوم (×/ثانية)
});

export const CAMERA_EASES = Object.freeze(['inOut', 'linear', 'hold']);
export const MAX_KEYFRAMES = 200;
export const MAX_ZOOM = 4;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits) => { const f = 10 ** digits; return Math.round(value * f) / f; };

// easeInOutCubic: مشتقته القصوى 3 عند المنتصف، وعليها يُحسب حد السرعة.
export function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
const EASE_PEAK = 3;

function applyEase(name, p) {
  if (name === 'hold') return p >= 1 ? 1 : 0;
  if (name === 'linear') return p;
  return easeInOutCubic(p);
}

// مستطيل الحدث إلى إحداثيات نسبية. يعيد null إن غاب أحدهما أو كان المستطيل فارغاً.
export function eventToFrame(rect, viewport) {
  if (!rect || !viewport || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const x = clamp(rect.x / viewport.width, 0, 1), y = clamp(rect.y / viewport.height, 0, 1);
  return {
    x, y,
    width: clamp(rect.width / viewport.width, 0, 1 - x),
    height: clamp(rect.height / viewport.height, 0, 1 - y),
  };
}

export function pointToFrame(pointer, viewport) {
  if (!pointer || !viewport || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  return { x: clamp(pointer.x / viewport.width, 0, 1), y: clamp(pointer.y / viewport.height, 0, 1) };
}

// المركز يُقصّ كي لا تخرج نافذة الكاميرا عن الإطار.
export function clampCenter(x, y, zoom) {
  const half = 0.5 / Math.max(1, zoom);
  return { x: clamp(x, half, 1 - half), y: clamp(y, half, 1 - half) };
}

const FOCUS_ACTIONS = new Set(['click', 'type', 'select', 'mousedown']);

function isFocusEvent(event) {
  if (!event || !FOCUS_ACTIONS.has(event.action)) return false;
  return event.kind === 'action' || (event.kind === 'pointer' && event.action === 'mousedown');
}

// حدث ⇒ هدف كاميرا { t, x, y, zoom, box, ref, action } أو null إن لم يكن فيه ما يُكبَّر عليه.
function targetOf(event, options) {
  const box = eventToFrame(event.rect, event.viewport);
  const point = pointToFrame(event.pointer, event.viewport);
  const verified = event.timing_quality === 'verified';
  if (box && verified) {
    const span = 1 + 2 * options.padding;
    const zoom = clamp(Math.min(1 / (box.width * span), 1 / (box.height * span)), options.minZoom, options.maxZoom);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom, box, precise: true };
  }
  // التوقيت غير موثّق أو لا مستطيل: زوم أخف، على المؤشر إن وُجد وإلا على مركز المستطيل.
  const center = point || (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null);
  if (!center) return null;
  return { x: center.x, y: center.y, zoom: options.pointerZoom, box, precise: false };
}

// هل يقع الهدف الثاني داخل ما تراه الكاميرا وهي على الأول؟
function sameRegion(a, b) {
  const half = 0.5 / a.zoom;
  const center = clampCenter(a.x, a.y, a.zoom);
  return Math.abs(b.x - center.x) <= half && Math.abs(b.y - center.y) <= half;
}

// events: سجل الأحداث وفيه t_ms = زمن الحدث داخل المقطع المصدر (ميلي ثانية).
// input: { durationMs, sourceStartMs } حدود المشهد داخل المقطع.
// الناتج: نقاط مفتاحية بزمن نسبي إلى بداية المشهد، أولها دائماً عند 0.
export function planCamera(events, input, overrides) {
  const options = { ...CAMERA_DEFAULTS, ...(overrides || {}) };
  const durationMs = input && input.durationMs > 0 ? input.durationMs : 0;
  const sourceStartMs = input && input.sourceStartMs > 0 ? input.sourceStartMs : 0;
  const home = { x: 0.5, y: 0.5, zoom: 1 };
  const keyframes = [{ t_ms: 0, ...home, ease: 'hold', reason: 'start' }];
  if (!durationMs || !Array.isArray(events)) return keyframes;

  // 1) الأهداف داخل حدود المشهد، مرتبة زمنياً.
  const targets = [];
  for (const event of events) {
    if (!isFocusEvent(event) || !Number.isFinite(event.t_ms)) continue;
    const t = event.t_ms - sourceStartMs;
    if (t < 0 || t > durationMs) continue;
    const target = targetOf(event, options);
    if (target) targets.push({ ...target, t, ref: event.target_ref || null, action: event.action });
  }
  targets.sort((a, b) => a.t - b.t);

  // 2) الدمج في لقطات: كتابة متتالية على العنصر نفسه، أو أحداث متقاربة في المنطقة نفسها.
  const shots = [];
  for (const target of targets) {
    const last = shots[shots.length - 1];
    const gap = last ? target.t - last.lastT : Infinity;
    const sameElement = last && target.ref && target.ref === last.ref;
    const typing = sameElement && target.action === 'type' && gap < options.idleMs;
    if (last && (typing || (gap < options.mergeMs && sameRegion(last, target)))) {
      last.lastT = target.t;
      last.count += 1;
      // الكتابة المتتالية لا تغيّر الزوم؛ الأحداث المتقاربة توسّط المركز دون تكبير إضافي.
      if (!typing) {
        last.x = (last.x * (last.count - 1) + target.x) / last.count;
        last.y = (last.y * (last.count - 1) + target.y) / last.count;
        last.zoom = Math.min(last.zoom, target.zoom);
      }
      continue;
    }
    shots.push({ x: target.x, y: target.y, zoom: target.zoom, firstT: target.t, lastT: target.t, ref: target.ref, count: 1, precise: target.precise });
  }

  // 3) اللقطات ⇒ نقاط مفتاحية مع حد السرعة.
  let current = { ...home };
  let cursor = 0; // زمن آخر نقطة مفتاحية
  const moveMs = (from, to) => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    return Math.max(options.minMoveMs,
      EASE_PEAK * distance / options.maxCenterSpeed * 1000,
      EASE_PEAK * Math.abs(to.zoom - from.zoom) / options.maxZoomSpeed * 1000);
  };
  const push = (t, state, ease, reason) => {
    const time = clamp(Math.round(t), 0, durationMs);
    const last = keyframes[keyframes.length - 1];
    if (time <= last.t_ms) return false;
    keyframes.push({ t_ms: time, x: round(state.x, 4), y: round(state.y, 4), zoom: round(state.zoom, 3), ease, reason });
    cursor = time;
    return true;
  };

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const center = clampCenter(shot.x, shot.y, shot.zoom);
    const state = { x: center.x, y: center.y, zoom: shot.zoom };
    const travel = moveMs(current, state);
    // الوصول قبل الحدث بمهلة الاستباق إن سمح حد السرعة، وإلا في أقرب وقت بعد النقطة السابقة.
    const start = Math.max(cursor, shot.firstT - options.leadMs - travel);
    const arrive = start + travel;
    if (start > cursor) push(start, current, 'hold', 'wait');
    if (!push(arrive, state, 'inOut', shot.precise ? 'element' : 'pointer')) continue;
    current = state;
    const next = shots[i + 1];
    const holdEnd = Math.max(arrive, shot.lastT + options.holdMs);
    const nextStart = next ? next.firstT - options.leadMs : Infinity;
    if (next && nextStart - holdEnd <= options.idleMs) continue; // الانتقال مباشرة إلى اللقطة التالية
    // خمول بعد اللقطة: إمساك ثم عودة إلى الإطار الكامل.
    if (holdEnd < durationMs) {
      push(holdEnd, state, 'hold', 'hold');
      const back = moveMs(state, home);
      if (push(Math.min(durationMs, holdEnd + back), home, 'inOut', 'idle')) current = { ...home };
    }
  }
  return keyframes.slice(0, MAX_KEYFRAMES);
}

// حالة الكاميرا عند زمن نسبي إلى بداية المشهد. camera: { mode, keyframes } أو null.
export function cameraAt(camera, tMs) {
  const home = { x: 0.5, y: 0.5, zoom: 1 };
  const keyframes = camera && camera.mode !== 'off' && Array.isArray(camera.keyframes) ? camera.keyframes : null;
  if (!keyframes || !keyframes.length) return home;
  if (tMs <= keyframes[0].t_ms) return { x: keyframes[0].x, y: keyframes[0].y, zoom: keyframes[0].zoom };
  for (let i = 1; i < keyframes.length; i += 1) {
    const to = keyframes[i];
    if (tMs > to.t_ms) continue;
    const from = keyframes[i - 1];
    const span = to.t_ms - from.t_ms;
    const eased = applyEase(to.ease, span > 0 ? (tMs - from.t_ms) / span : 1);
    return {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      zoom: from.zoom + (to.zoom - from.zoom) * eased,
    };
  }
  const last = keyframes[keyframes.length - 1];
  return { x: last.x, y: last.y, zoom: last.zoom };
}

// تحويل الرسم: fitted = مستطيل المصدر على اللوحة قبل الكاميرا { x, y, width, height }.
// يعيد { scale, tx, ty } بحيث: نقطة_اللوحة = نقطة_قبل_الكاميرا × scale + (tx, ty).
// المحتوى الذي يغطي اللوحة يبقى مغطياً لها؛ الأصغر منها يتوسّط.
export function cameraTransform(state, fitted, width, height) {
  const scale = Math.max(1, state.zoom);
  if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
  const axis = (focus, start, size, canvas) => {
    const scaled = size * scale;
    if (scaled <= canvas) return canvas / 2 - (start + size / 2) * scale;
    const wanted = canvas / 2 - (start + focus * size) * scale;
    return clamp(wanted, canvas - (start + size) * scale, -start * scale) + 0; // + 0 يحوّل الصفر السالب
  };
  return {
    scale,
    tx: axis(state.x, fitted.x, fitted.width, width),
    ty: axis(state.y, fitted.y, fitted.height, height),
  };
}

// مسار المؤشر الاصطناعي: نقاط { t_ms, x, y, click } بزمن نسبي إلى بداية المشهد.
// أحداث الوكيل بلا مؤشر، فيُجعل موضعها مركز العنصر.
export function pointerTrack(events, input) {
  const durationMs = input && input.durationMs > 0 ? input.durationMs : 0;
  const sourceStartMs = input && input.sourceStartMs > 0 ? input.sourceStartMs : 0;
  const track = [];
  if (!durationMs || !Array.isArray(events)) return track;
  for (const event of events) {
    if (!event || !Number.isFinite(event.t_ms)) continue;
    if (event.kind !== 'pointer' && event.kind !== 'action') continue;
    const t = event.t_ms - sourceStartMs;
    if (t < -2000 || t > durationMs) continue;
    let point = pointToFrame(event.pointer, event.viewport);
    if (!point) {
      const box = eventToFrame(event.rect, event.viewport);
      if (box) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (!point) continue;
    track.push({ t_ms: Math.round(t), x: round(point.x, 4), y: round(point.y, 4), click: isFocusEvent(event) && event.action !== 'type' });
  }
  track.sort((a, b) => a.t_ms - b.t_ms);
  return track.slice(0, 2000);
}

// موضع المؤشر عند زمن ما + تقدّم موجة النقرة (0..1) إن كانت جارية. null قبل أول نقطة.
export function pointerAt(track, tMs, rippleMs = 450) {
  if (!Array.isArray(track) || !track.length || tMs < track[0].t_ms) return null;
  let index = 0;
  while (index + 1 < track.length && track[index + 1].t_ms <= tMs) index += 1;
  const from = track[index], to = track[index + 1];
  let x = from.x, y = from.y;
  if (to) {
    // الحركة نحو النقطة التالية تنضغط في آخر 400ms كي لا ينجرف المؤشر ببطء عبر الخمول.
    const span = Math.min(400, to.t_ms - from.t_ms);
    const begin = to.t_ms - span;
    if (tMs > begin && span > 0) {
      const p = easeInOutCubic((tMs - begin) / span);
      x = from.x + (to.x - from.x) * p; y = from.y + (to.y - from.y) * p;
    }
  }
  let ripple = null;
  for (let i = index; i >= 0 && tMs - track[i].t_ms <= rippleMs; i -= 1) {
    if (track[i].click) { ripple = { x: track[i].x, y: track[i].y, progress: (tMs - track[i].t_ms) / rippleMs }; break; }
  }
  return { x, y, ripple };
}

// فجوات الخمول داخل المشهد: اقتراح قص، لا تنفيذ. تعيد [{ start_ms, end_ms }] بزمن نسبي للمشهد.
export function idleGaps(events, input, minGapMs = 3000) {
  const durationMs = input && input.durationMs > 0 ? input.durationMs : 0;
  const sourceStartMs = input && input.sourceStartMs > 0 ? input.sourceStartMs : 0;
  if (!durationMs || !Array.isArray(events)) return [];
  const times = events
    .filter((event) => event && Number.isFinite(event.t_ms) && (event.kind === 'action' || event.kind === 'pointer' || event.kind === 'navigation'))
    .map((event) => event.t_ms - sourceStartMs)
    .filter((t) => t >= 0 && t <= durationMs)
    .sort((a, b) => a - b);
  if (!times.length) return [];
  const gaps = [];
  const marks = [0, ...times, durationMs];
  for (let i = 1; i < marks.length; i += 1) {
    if (marks[i] - marks[i - 1] > minGapMs) {
      // نبقي نصف ثانية بعد الحدث السابق وقبل اللاحق كي لا يُقصّ أثر الفعل.
      const start = Math.round(marks[i - 1] + (i === 1 ? 0 : 500));
      const end = Math.round(marks[i] - (i === marks.length - 1 ? 0 : 500));
      if (end - start >= 1000) gaps.push({ start_ms: start, end_ms: end });
    }
  }
  return gaps;
}
