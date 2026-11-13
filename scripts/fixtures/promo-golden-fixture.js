// الحارس المرجعي لـrenderFrame: حتمية + مطابقة بكسلية لمظهر v1.
// المرجع ليس بصمات محفوظة (تختلف بين الأجهاز بخط وكرت مختلفين) بل نسخة حرفية من
// كود الرسم قبل الدفعة 1، تُرسم على الجهاز نفسه وتُقارن بكسلاً ببكسل.

import { buildTimeline, sceneAt } from '../../src/ui/lib/promo/promo-timeline.js';
import { renderFrame } from '../../src/ui/lib/promo/promo-frame.js';

// ───── نسخة حرفية من الرسم القديم (promo-renderer.js عند 690eb6b) — لا تُعدَّل ─────
function legacyCover(context, element, sourceWidth, sourceHeight, width, height) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale;
  context.drawImage(element, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}
function legacyContain(context, element, sourceWidth, sourceHeight, width, height) {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale;
  context.drawImage(element, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}
function legacyWrap(context, caption, maxWidth) {
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
function legacyCaption(context, caption, width, height, colors, position = 'bottom', style = 'box') {
  if (!caption) return;
  const fontSize = Math.max(30, Math.round(height * 0.052));
  const lineHeight = Math.round(fontSize * 1.45);
  const padding = Math.round(fontSize * 0.72);
  context.save();
  context.direction = 'rtl';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.font = `700 ${fontSize}px "IBM Plex Sans Arabic", sans-serif`;
  const lines = legacyWrap(context, caption, width * 0.78);
  if (!lines.length) { context.restore(); return; }
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
}
function legacyFrame(context, canvas, scene, elapsed, visual, colors) {
  context.fillStyle = colors.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const draw = scene.fit === 'contain' ? legacyContain : legacyCover;
  draw(context, visual.source, visual.width, visual.height, canvas.width, canvas.height);
  if (scene.transition === 'fade') {
    const edge = Math.min(500, scene.duration_ms / 3);
    const opacity = elapsed < edge ? 1 - elapsed / edge
      : elapsed > scene.duration_ms - edge ? 1 - (scene.duration_ms - elapsed) / edge : 0;
    if (opacity > 0) {
      context.save(); context.globalAlpha = opacity; context.fillStyle = colors.background;
      context.fillRect(0, 0, canvas.width, canvas.height); context.restore();
    }
  }
  legacyCaption(context, scene.caption, canvas.width, canvas.height, colors, scene.caption_position, scene.caption_style);
}
// ─────────────────────────────────────────────────────────────────────────────

async function makeImage(width, height, hue) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 70% 35%)`);
  gradient.addColorStop(1, `hsl(${hue + 80} 70% 60%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  for (let i = 0; i < 8; i += 1) context.fillRect(40 + i * (width / 9), 60 + i * (height / 11), width / 14, height / 16);
  return { source: await createImageBitmap(canvas), width, height };
}

function pixels(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

function countDiff(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff += 1;
  }
  return diff;
}

export const GOLDEN_SCENES = [
  { caption: 'Satr Pro متاح الآن', duration_ms: 2000, transition: 'cut', fit: 'cover', caption_position: 'bottom', caption_style: 'box', trim_start_ms: 0 },
  { caption: 'احجز موعدك في أقل من 30 ثانية — بدون تسجيل ولا انتظار ولا أوراق، من أي مكان وفي أي وقت يناسبك', duration_ms: 3000, transition: 'fade', fit: 'contain', caption_position: 'top', caption_style: 'minimal', trim_start_ms: 0 },
  { caption: '', duration_ms: 1500, transition: 'fade', fit: 'cover', caption_position: 'center', caption_style: 'box', trim_start_ms: 0 },
];
export const GOLDEN_TIMES = [0, 1000, 1999, 2100, 3500, 4900, 5200, 6499];
export const GOLDEN_COLORS = { background: '#0b0f14', captionBackground: 'rgba(0,0,0,0.62)', captionText: '#f4f6f8' };

async function run() {
  await document.fonts.load('700 56px "IBM Plex Sans Arabic"', 'متاح Satr');
  const images = [await makeImage(1600, 900, 200), await makeImage(800, 1200, 20), await makeImage(1600, 900, 120)];
  const timeline = buildTimeline({ scenes: GOLDEN_SCENES });
  const frames = new Map(images.map((image, index) => [index, image]));
  const report = { ok: true, cases: 0, font_loaded: [...document.fonts].some((face) => face.status === 'loaded' && face.family.includes('IBM Plex Sans Arabic')), failures: [] };
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
    const runtime = { width, height, colors: GOLDEN_COLORS, timeline };
    for (const time of GOLDEN_TIMES) {
      const make = () => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; };
      const first = make(), second = make(), reference = make();
      renderFrame(first.getContext('2d', { alpha: false }), runtime, time, frames);
      // رسم زمن آخر بينهما يثبت أن الدالة لا تحمل حالة من استدعاء سابق.
      renderFrame(second.getContext('2d', { alpha: false }), runtime, (time + 1234) % timeline.totalMs, frames);
      renderFrame(second.getContext('2d', { alpha: false }), runtime, time, frames);
      const placement = sceneAt(timeline, time);
      legacyFrame(reference.getContext('2d', { alpha: false }), reference, placement.entry.scene, placement.localMs, images[placement.entry.index], GOLDEN_COLORS);
      const a = pixels(first);
      const nondeterministic = countDiff(a, pixels(second));
      const drift = countDiff(a, pixels(reference));
      report.cases += 1;
      if (nondeterministic || drift) {
        report.ok = false;
        report.failures.push({ width, height, time, nondeterministic, drift });
      }
    }
  }
  return report;
}

window.__promoGolden = run();
