// رسم إطار واحد من الإعلان — الدالة الحتمية التي تشترك فيها المعاينة والتصدير.
// العقد (§2 من docs/PROMO-DIRECTOR-PLAN.md): لا ساعة ولا قراءة لزمن عنصر فيديو هنا.
// المستدعي يجهّز مصدر الرسم الصحيح لزمن tMs ويمرّره في frames.

import { sceneAt, fadeOpacity } from './promo-timeline.js';

function drawFitted(context, source, sourceWidth, sourceHeight, width, height, cover) {
  if (!sourceWidth || !sourceHeight) return;
  const scale = cover ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
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

// runtime: { width, height, colors, timeline }
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
  if (frame && frame.source) {
    drawFitted(context, frame.source, frame.width, frame.height, width, height, scene.fit !== 'contain');
    drawn = true;
  }
  const opacity = fadeOpacity(scene.transition, localMs, entry.durationMs);
  if (opacity > 0) {
    context.save();
    context.globalAlpha = opacity;
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  const captionLines = drawCaption(context, scene.caption, width, height, colors, scene.caption_position, scene.caption_style);
  return { index: entry.index, localMs, drawn, captionLines };
}
