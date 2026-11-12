// رسم إطار واحد من الإعلان — الدالة الحتمية التي تشترك فيها المعاينة والتصدير.
// العقد (§2 من docs/PROMO-DIRECTOR-PLAN.md): لا ساعة ولا قراءة لزمن عنصر فيديو هنا.
// المستدعي يجهّز مصدر الرسم الصحيح لزمن tMs ويمرّره في frames.

import { sceneAt, fadeOpacity } from './promo-timeline.js';
import { cameraAt, cameraTransform, pointerAt } from './promo-camera.js';
import { usesTitleEngine, drawTitle, drawSubtitle, sceneCue } from './promo-text.js';

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

// runtime: { width, height, colors, timeline, pointers?, aspect?, voiceDurations? }
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
  const fitted = frame && frame.source ? fittedRect(frame.width, frame.height, width, height, scene.fit !== 'contain') : null;
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
  return { index: entry.index, localMs, drawn, captionLines };
}
