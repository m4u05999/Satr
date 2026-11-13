// رسم إطار واحد من الإعلان — الدالة الحتمية التي تشترك فيها المعاينة والتصدير.
// العقد (§2 من docs/PROMO-DIRECTOR-PLAN.md): لا ساعة ولا قراءة لزمن عنصر فيديو هنا.
// المستدعي يجهّز مصدر الرسم الصحيح لزمن tMs ويمرّره في frames.

import { sceneAt, fadeOpacity } from './promo-timeline.js';
import { cameraAt, cameraTransform, pointerAt } from './promo-camera.js';
import { usesTitleEngine, drawTitle, drawSubtitle, sceneCue } from './promo-text.js';
import { usesStage, stageLayout, drawBackground, drawDevice, tiltAt } from './promo-stage.js';
import { tiltCanvas } from './promo-gl.js';

export const TRANSITIONS_IN = Object.freeze(['none', 'crossfade', 'slide', 'zoom', 'blur']);
export const TRANSITION_IN_MS = 500;

// لوحات جانبية مشتركة يُعاد استعمالها بين الإطارات (لا حالة تنتقل: تُمسح قبل كل استعمال).
const scratch = new Map();
function scratchCanvas(name, width, height) {
  let canvas = scratch.get(name);
  if (!canvas) { canvas = document.createElement('canvas'); scratch.set(name, canvas); }
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  return canvas;
}

// تغبيش مناطق حساسة: region بإحداثيات اللوحة الحالية. المنطقة تُنسخ ثم تُعاد مغبَّشة ومقصوصة.
function blurRegion(context, region) {
  const x = Math.floor(region.x), y = Math.floor(region.y);
  const width = Math.ceil(region.width), height = Math.ceil(region.height);
  if (width < 2 || height < 2) return;
  const radius = Math.max(6, Math.min(40, Math.round(height * 0.3)));
  const pad = radius * 2;
  const copy = scratchCanvas('redact', width + pad * 2, height + pad * 2);
  const copyContext = copy.getContext('2d');
  copyContext.clearRect(0, 0, copy.width, copy.height);
  copyContext.drawImage(context.canvas, x - pad, y - pad, copy.width, copy.height, 0, 0, copy.width, copy.height);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.beginPath(); context.rect(x, y, width, height); context.clip();
  context.filter = 'blur(' + radius + 'px)';
  // مرّتان تُعتمان ما تسرّبه حواف التغبيش فلا يُقرأ النص من هالته.
  context.drawImage(copy, x - pad, y - pad);
  context.drawImage(copy, x - pad, y - pad);
  context.restore();
}

// يرسم محتوى المشهد (المصدر + الكاميرا + التغبيش + المؤشر) داخل rect من السياق المعطى، مقصوصاً به.
// يُستعمل لمسار المسرح؛ المسار القديم (بلا مسرح) يبقى في renderFrame حرفياً.
function drawStagedContent(context, rect, scene, frame, localMs, runtime, sceneIndex, colors, height) {
  const fitted = fittedRect(frame.width, frame.height, rect.width, rect.height, true);
  if (!fitted) return;
  const view = cameraTransform(cameraAt(scene.camera, localMs), fitted, rect.width, rect.height);
  context.save();
  context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip();
  context.translate(rect.x, rect.y);
  context.save();
  context.transform(view.scale, 0, 0, view.scale, view.tx, view.ty);
  context.imageSmoothingQuality = 'high';
  context.drawImage(frame.source, fitted.x, fitted.y, fitted.width, fitted.height);
  context.restore();
  const toLocal = (point) => ({
    x: (fitted.x + point.x * fitted.width) * view.scale + view.tx,
    y: (fitted.y + point.y * fitted.height) * view.scale + view.ty,
  });
  for (const region of activeRedactions(scene, localMs)) {
    const a = toLocal({ x: region.x, y: region.y }), b = toLocal({ x: region.x + region.width, y: region.y + region.height });
    const left = Math.max(0, a.x), top = Math.max(0, a.y), right = Math.min(rect.width, b.x), bottom = Math.min(rect.height, b.y);
    if (right > left && bottom > top) blurRegion(context, { x: rect.x + left, y: rect.y + top, width: right - left, height: bottom - top });
  }
  const track = scene.camera && scene.camera.mode !== 'off' && scene.camera.cursor !== false
    && runtime.pointers && typeof runtime.pointers.get === 'function' ? runtime.pointers.get(sceneIndex) : null;
  const pointer = track ? pointerAt(track, localMs) : null;
  if (pointer) {
    const at = toLocal(pointer);
    const ripple = pointer.ripple ? { ...toLocal(pointer.ripple), progress: pointer.ripple.progress } : null;
    drawPointer(context, at.x, at.y, ripple, height, colors);
  }
  context.restore();
}

export function activeRedactions(scene, localMs) {
  const list = Array.isArray(scene.redactions) ? scene.redactions : [];
  return list.filter((item) => item && localMs >= item.start_ms && localMs <= item.end_ms);
}

// تقدّم انتقال الدخول (0..1)، أو null إن لم يكن جارياً.
export function transitionInProgress(scene, localMs, durationMs) {
  if (!scene.transition_in || scene.transition_in === 'none') return null;
  const span = Math.min(TRANSITION_IN_MS, durationMs / 3);
  return localMs < span ? localMs / span : null;
}

// انتقال الدخول: a = لقطة آخر إطار من المشهد السابق، b = الإطار الحالي المرسوم على اللوحة.
function applyTransitionIn(context, snapshot, type, progress, width, height) {
  const p = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  if (type === 'crossfade') {
    context.save(); context.globalAlpha = 1 - p; context.drawImage(snapshot, 0, 0, width, height); context.restore();
    return;
  }
  const current = scratchCanvas('transition', width, height);
  const currentContext = current.getContext('2d');
  currentContext.clearRect(0, 0, width, height);
  currentContext.drawImage(context.canvas, 0, 0);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (type === 'slide') {
    // السابق يخرج يساراً والجديد يدخل من اليمين (اتجاه القراءة العربي).
    context.drawImage(snapshot, -Math.round(p * width), 0, width, height);
    context.drawImage(current, Math.round((1 - p) * width), 0);
  } else if (type === 'zoom') {
    context.drawImage(current, 0, 0);
    const scale = 1 + 0.35 * p;
    context.globalAlpha = 1 - p;
    context.drawImage(snapshot, (width - width * scale) / 2, (height - height * scale) / 2, width * scale, height * scale);
  } else if (type === 'blur') {
    const radius = height * 0.03;
    context.filter = 'blur(' + ((1 - p) * radius).toFixed(2) + 'px)';
    context.drawImage(current, 0, 0);
    context.filter = 'blur(' + (p * radius).toFixed(2) + 'px)';
    context.globalAlpha = 1 - p;
    context.drawImage(snapshot, 0, 0, width, height);
  }
  context.restore();
}

// مستطيل المصدر على اللوحة قبل الكاميرا.
export function fittedRect(sourceWidth, sourceHeight, width, height, cover) {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = cover ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

// المؤشر الاصطناعي وموجة النقرة، بإحداثيات اللوحة بعد الكاميرا. الحجم ثابت على اللوحة
// كي يبقى مقروءاً مهما كان الزوم.
// الألوان من سمة الاستوديو نفسها (نص العنوان وخلفيته) لا قيم صلبة.
function drawPointer(context, x, y, ripple, height, colors) {
  const size = Math.max(18, height * 0.03);
  context.save();
  if (ripple) {
    context.beginPath();
    context.arc(ripple.x, ripple.y, size * (0.5 + 1.6 * ripple.progress), 0, Math.PI * 2);
    context.lineWidth = Math.max(2, size * 0.14);
    context.globalAlpha = 0.9 * (1 - ripple.progress);
    context.strokeStyle = colors.captionText;
    context.stroke();
    context.globalAlpha = 1;
  }
  context.translate(x, y);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(0, size);
  context.lineTo(size * 0.27, size * 0.76);
  context.lineTo(size * 0.45, size * 1.14);
  context.lineTo(size * 0.6, size * 1.07);
  context.lineTo(size * 0.42, size * 0.7);
  context.lineTo(size * 0.72, size * 0.7);
  context.closePath();
  context.shadowColor = colors.background;
  context.shadowBlur = size * 0.25;
  context.shadowOffsetY = size * 0.08;
  context.fillStyle = colors.captionText;
  context.fill();
  context.shadowColor = 'transparent';
  context.lineWidth = Math.max(1.5, size * 0.07);
  context.lineJoin = 'round';
  context.strokeStyle = colors.background;
  context.stroke();
  context.restore();
}

function wrapCaption(context, caption, maxWidth) {
  const words = String(caption || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (line && context.measureText(candidate).width > maxWidth) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export function drawCaption(context, caption, width, height, colors, position = 'bottom', style = 'box') {
  if (!caption) return 0;
  const fontSize = Math.max(30, Math.round(height * 0.052));
  const lineHeight = Math.round(fontSize * 1.45);
  const padding = Math.round(fontSize * 0.72);
  context.save();
  context.direction = 'rtl';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.font = `700 ${fontSize}px "IBM Plex Sans Arabic", sans-serif`;
  const lines = wrapCaption(context, caption, width * 0.78);
  if (!lines.length) { context.restore(); return 0; }
  const boxHeight = lines.length * lineHeight + padding * 2;
  const boxWidth = Math.min(width * 0.88, Math.max(...lines.map((line) => context.measureText(line).width)) + padding * 2);
  const x = width - Math.round(width * 0.06);
  const y = position === 'top' ? Math.round(height * 0.07)
    : position === 'center' ? Math.round((height - boxHeight) / 2)
      : height - Math.round(height * 0.07) - boxHeight;
  if (style !== 'minimal') {
    context.fillStyle = colors.captionBackground;
    context.fillRect(x - boxWidth, y, boxWidth, boxHeight);
  } else {
    context.shadowColor = colors.captionBackground;
    context.shadowBlur = Math.max(4, Math.round(fontSize * 0.18));
  }
  context.fillStyle = colors.captionText;
  lines.forEach((line, index) => context.fillText(line, x - padding, y + padding + lineHeight * (index + 0.5)));
  context.restore();
  return lines.length;
}

// runtime: { width, height, colors, timeline, pointers?, aspect?, voiceDurations?, images?, snapshots? }
// images: Map مسار صورة الخلفية ⇒ { source, width, height }. snapshots: Map فهرس المشهد ⇒ لوحة آخر
// إطار من المشهد السابق (لانتقال الدخول).
// colors.accent لون إبراز الكلمة (اختياري). voiceDurations: Map فهرس المشهد ⇒ مدة التعليق بالميلي ثانية.
// pointers: Map من فهرس المشهد إلى مسار المؤشر (pointerTrack) — اختياري.
// frames: Map من فهرس المشهد إلى { source, width, height }؛ غياب المدخل ⇒ خلفية فقط.
// تعيد { index, localMs, drawn, captionLines } أو null إن لم يكن عند tMs مشهد.
export function renderFrame(context, runtime, tMs, frames) {
  const { width, height, colors, timeline } = runtime;
  context.fillStyle = colors.background;
  context.fillRect(0, 0, width, height);
  const placement = sceneAt(timeline, tMs);
  if (!placement) return null;
  const { entry, localMs } = placement;
  const scene = entry.scene;
  const frame = frames && typeof frames.get === 'function' ? frames.get(entry.index) : null;
  let drawn = false;
  let view = null;
  const staged = usesStage(scene) && frame && frame.source;
  if (staged) {
    const stage = scene.stage;
    drawBackground(context, stage, width, height, colors, runtime.images);
    const layout = stageLayout(stage, frame.width, frame.height, width, height);
    const device = scratchCanvas('device', layout.device.width, layout.device.height);
    drawDevice(device.getContext('2d'), stage, layout, colors, (deviceContext, rect) => {
      drawStagedContent(deviceContext, rect, scene, frame, localMs, runtime, entry.index, colors, height);
    });
    const tilt = tiltAt(stage, localMs, entry.durationMs);
    const tilted = tilt.x || tilt.y ? tiltCanvas(device, tilt.x, tilt.y) : null;
    const strength = Math.max(0, Math.min(1, Number(stage.shadow) || 0));
    context.save();
    if (strength > 0) {
      // الظل يتبع شكل الجهاز نفسه (شفافية الصورة)، مائلاً كان أو مستوياً.
      context.shadowColor = (colors.chrome && colors.chrome.shadow) || colors.captionBackground;
      context.shadowBlur = height * 0.05 * strength;
      context.shadowOffsetY = height * 0.022 * strength;
    }
    if (tilted) context.drawImage(tilted.canvas, layout.device.x - tilted.marginX, layout.device.y - tilted.marginY);
    else context.drawImage(device, layout.device.x, layout.device.y);
    context.restore();
    drawn = true;
  }
  const fitted = !staged && frame && frame.source ? fittedRect(frame.width, frame.height, width, height, scene.fit !== 'contain') : null;
  if (fitted) {
    // مشهد بلا كاميرا (v1) يمر بالمسار القديم حرفياً: لا تحويل ولا حفظ حالة.
    view = cameraTransform(cameraAt(scene.camera, localMs), fitted, width, height);
    if (view.scale === 1) {
      context.drawImage(frame.source, fitted.x, fitted.y, fitted.width, fitted.height);
    } else {
      context.save();
      context.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);
      context.imageSmoothingQuality = 'high';
      context.drawImage(frame.source, fitted.x, fitted.y, fitted.width, fitted.height);
      context.restore();
    }
    drawn = true;
    for (const region of activeRedactions(scene, localMs)) {
      const ax = (fitted.x + region.x * fitted.width) * view.scale + view.tx, ay = (fitted.y + region.y * fitted.height) * view.scale + view.ty;
      const bx = (fitted.x + (region.x + region.width) * fitted.width) * view.scale + view.tx, by = (fitted.y + (region.y + region.height) * fitted.height) * view.scale + view.ty;
      const left = Math.max(0, ax), top = Math.max(0, ay), right = Math.min(width, bx), bottom = Math.min(height, by);
      if (right > left && bottom > top) blurRegion(context, { x: left, y: top, width: right - left, height: bottom - top });
    }
    // مسار المؤشر مشتق من سجل الأحداث وقت التشغيل (runtime.pointers) ولا يُحفظ في المشروع.
    const track = scene.camera && scene.camera.mode !== 'off' && scene.camera.cursor !== false
      && runtime.pointers && typeof runtime.pointers.get === 'function' ? runtime.pointers.get(entry.index) : null;
    const pointer = track ? pointerAt(track, localMs) : null;
    if (pointer) {
      const toCanvas = (point) => ({
        x: (fitted.x + point.x * fitted.width) * view.scale + view.tx,
        y: (fitted.y + point.y * fitted.height) * view.scale + view.ty,
      });
      const at = toCanvas(pointer);
      const ripple = pointer.ripple ? { ...toCanvas(pointer.ripple), progress: pointer.ripple.progress } : null;
      drawPointer(context, at.x, at.y, ripple, height, colors);
    }
  }
  const opacity = fadeOpacity(scene.transition, localMs, entry.durationMs);
  if (opacity > 0) {
    context.save();
    context.globalAlpha = opacity;
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  // مشهد v1 (بلا text_style ولا ترجمة) يبقى على drawCaption القديمة حرفياً.
  let captionLines;
  if (usesTitleEngine(scene)) {
    const aspect = runtime.aspect || '16:9';
    const voiceMs = runtime.voiceDurations && typeof runtime.voiceDurations.get === 'function' ? runtime.voiceDurations.get(entry.index) : 0;
    const reserve = drawSubtitle(context, sceneCue(scene, localMs, voiceMs), { width, height, colors, aspect });
    const title = drawTitle(context, scene.caption, {
      width, height, colors, aspect, localMs, position: scene.caption_position, boxStyle: scene.caption_style,
      style: scene.text_style, reserveBottom: scene.caption_position === 'bottom' || !scene.caption_position ? reserve : 0,
    });
    captionLines = title ? title.layout.lines.length : 0;
  } else {
    captionLines = drawCaption(context, scene.caption, width, height, colors, scene.caption_position, scene.caption_style);
  }
  // انتقال الدخول يطبَّق على الإطار كله (بعناوينه) مقابل لقطة آخر إطار من المشهد السابق.
  const progress = transitionInProgress(scene, localMs, entry.durationMs);
  const snapshot = progress != null && runtime.snapshots && typeof runtime.snapshots.get === 'function' ? runtime.snapshots.get(entry.index) : null;
  if (snapshot) applyTransitionIn(context, snapshot, scene.transition_in, progress, width, height);
  return { index: entry.index, localMs, drawn, captionLines, staged: !!staged };
}
