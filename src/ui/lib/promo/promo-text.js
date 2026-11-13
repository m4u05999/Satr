// العناوين العربية المتحركة والترجمة على الشاشة.
//
// القاعدة: التخطيط يحسبه المتصفح لا نحن. النص يوضع في عنصر DOM مخفي بالخط والعرض نفسيهما،
// ويؤخذ صندوق كل كلمة بـRange.getClientRects()، فيخرج الترتيب البصري الصحيح للنص المختلط
// والأرقام بلا أي منطق BiDi من عندنا. ثم يُرسم السطر كاملاً مرة واحدة إلى لوحة جانبية
// ويُكشف بالقص حسب صناديق الكلمات، فلا تُرسم كلمة منفردة ولا ينكسر وصل الحروف ولا التشكيل.
//
// التخطيط يُخزَّن بمفتاحه، فيبقى renderFrame حتمياً وسريعاً بعد أول استدعاء.

import { textDir } from '../text-dir.js';
import { easeInOutCubic } from './promo-camera.js';
import { safeArea, subtitleCues, cueAt } from './promo-subtitles.js';

export const TEXT_ANIMATIONS = Object.freeze(['none', 'words', 'slide', 'zoom']);
export const FONT_FAMILY = '"IBM Plex Sans Arabic", sans-serif';
// خطوط العناوين المضمّنة (src/vendor/fonts.css وfonts-promo.css). plex الافتراضي ومظهر v1.
export const TEXT_FONTS = Object.freeze({
  plex: FONT_FAMILY,
  cairo: '"Cairo", "IBM Plex Sans Arabic", sans-serif',
  naskh: '"Noto Naskh Arabic", "IBM Plex Sans Arabic", serif',
});
export const TEXT_FONT_NAMES = Object.freeze({ plex: 'IBM Plex Sans Arabic', cairo: 'Cairo', naskh: 'Noto Naskh Arabic' });
export function fontFamily(name) {
  return Object.prototype.hasOwnProperty.call(TEXT_FONTS, name) ? TEXT_FONTS[name] : FONT_FAMILY;
}
// يحمّل أوجه الخطوط الثلاثة بوزنَي العناوين والترجمة قبل القياس والتصدير.
export async function loadTextFonts() {
  const jobs = [];
  for (const name of Object.values(TEXT_FONT_NAMES)) for (const weight of [700, 500]) jobs.push(document.fonts.load(weight + ' 48px "' + name + '"', 'ع A ٢'));
  try { await Promise.all(jobs); } catch (error) {}
}
const WORD_STAGGER_MS = 110;
const WORD_FADE_MS = 320;
const BLOCK_IN_MS = 450;

const layoutCache = new Map();
let measureHost = null;

function host() {
  if (measureHost && measureHost.isConnected) return measureHost;
  measureHost = document.createElement('div');
  // CSSOM لا سمة style= (محجوبة بـCSP). العنصر خارج الشاشة وغير مرئي ولا يستقبل أحداثاً.
  const style = measureHost.style;
  style.position = 'fixed'; style.left = '-100000px'; style.top = '0'; style.visibility = 'hidden';
  style.pointerEvents = 'none'; style.whiteSpace = 'normal'; style.margin = '0'; style.padding = '0';
  style.border = '0'; style.letterSpacing = 'normal'; style.wordSpacing = 'normal';
  measureHost.setAttribute('aria-hidden', 'true');
  document.body.appendChild(measureHost);
  return measureHost;
}

// تخطيط نص داخل عرض أقصى. يعيد:
// { dir, fontSize, lineHeight, width, height, mismatch, lines: [{ text, left, width, words: [{ index, text, left, width }] }] }
// left منسوب إلى الحافة اليسرى للكتلة؛ index ترتيب الكلمة في القراءة (المنطقي).
export function layoutText(text, options) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const fontSize = Math.round(options.fontSize);
  const weight = options.weight || 700;
  const maxWidth = Math.max(1, Math.round(options.maxWidth));
  const maxLines = options.maxLines || 3;
  const family = fontFamily(options.font);
  const key = [clean, fontSize, weight, maxWidth, maxLines, family].join('\u0001');
  if (layoutCache.has(key)) return layoutCache.get(key);
  const dir = textDir(clean) || 'rtl';
  const lineHeight = Math.round(fontSize * 1.45);
  const element = host();
  element.dir = dir;
  element.style.width = maxWidth + 'px';
  element.style.font = weight + ' ' + fontSize + 'px ' + family;
  element.style.lineHeight = lineHeight + 'px';
  element.style.textAlign = dir === 'rtl' ? 'right' : 'left';
  element.textContent = clean;
  const node = element.firstChild;
  const origin = element.getBoundingClientRect();
  const lines = [];
  if (node) {
    const range = document.createRange();
    let offset = 0, index = 0;
    for (const word of clean.split(' ')) {
      range.setStart(node, offset);
      range.setEnd(node, offset + word.length);
      offset += word.length + 1;
      // كلمة فيها خطّان (مثل «25%») قد تعيد أكثر من مستطيل؛ نأخذ اتحادها على السطر نفسه.
      let left = Infinity, right = -Infinity, top = null;
      for (const rect of range.getClientRects()) {
        if (!rect.width) continue;
        if (top == null) top = rect.top;
        if (Math.abs(rect.top - top) > lineHeight / 2) continue;
        left = Math.min(left, rect.left); right = Math.max(right, rect.right);
      }
      if (top == null) { index += 1; continue; }
      const row = Math.round((top - origin.top) / lineHeight);
      if (!lines[row]) lines[row] = { text: '', left: Infinity, right: -Infinity, words: [] };
      const line = lines[row];
      line.words.push({ index, text: word, left: left - origin.left, width: right - left });
      line.text += (line.text ? ' ' : '') + word;
      line.left = Math.min(line.left, left - origin.left); line.right = Math.max(line.right, right - origin.left);
      index += 1;
    }
  }
  const kept = lines.filter(Boolean).slice(0, maxLines);
  // حارس التطابق: عرض السطر في DOM مقابل measureText على لوحة بالخط نفسه.
  const probe = (layoutText.probe = layoutText.probe || document.createElement('canvas').getContext('2d'));
  probe.font = weight + ' ' + fontSize + 'px ' + family;
  probe.direction = dir;
  let mismatch = 0, width = 0;
  for (const line of kept) {
    line.width = line.right - line.left;
    mismatch = Math.max(mismatch, Math.abs(probe.measureText(line.text).width - line.width));
    width = Math.max(width, line.width);
    delete line.right;
  }
  // الأسطر تُحاذى داخل كتلة بعرض أطولها: نزيح left ليصير منسوباً إلى الكتلة لا إلى العرض الأقصى.
  const blockLeft = dir === 'rtl' ? maxWidth - width : 0;
  for (const line of kept) {
    line.left -= blockLeft;
    for (const word of line.words) word.left -= blockLeft;
  }
  const layout = { dir, fontSize, weight, family, lineHeight, width, height: kept.length * lineHeight, mismatch, lines: kept, wordCount: kept.reduce((sum, line) => sum + line.words.length, 0) };
  if (layoutCache.size > 300) layoutCache.clear();
  layoutCache.set(key, layout);
  return layout;
}

// السطر مرسوماً كاملاً على لوحة جانبية بلون واحد. يُخزَّن على التخطيط نفسه.
function lineBitmap(layout, lineIndex, color) {
  const line = layout.lines[lineIndex];
  line.bitmaps = line.bitmaps || new Map();
  if (line.bitmaps.has(color)) return line.bitmaps.get(color);
  // حاشية حول السطر تتسع لما يخرج عن صندوق التقدّم (ذيول الحروف والتشكيل).
  const pad = Math.ceil(layout.fontSize * 0.5); // يطابق حاشية wordSlices
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(line.width) + pad * 2;
  canvas.height = layout.lineHeight + pad * 2;
  const context = canvas.getContext('2d');
  context.font = layout.weight + ' ' + layout.fontSize + 'px ' + layout.family;
  context.direction = layout.dir;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(line.text, pad, pad + layout.lineHeight / 2);
  const bitmap = { canvas, pad };
  line.bitmaps.set(color, bitmap);
  return bitmap;
}

// حدود قطعة الكلمة داخل لوحة السطر: من منتصف الفراغ قبلها إلى منتصف الفراغ بعدها،
// فتغطي القطع السطر كله بلا تداخل ولا ثغرة.
function wordSlices(layout, lineIndex) {
  const line = layout.lines[lineIndex];
  if (line.slices) return line.slices;
  const pad = Math.ceil(layout.fontSize * 0.5); // يطابق حاشية lineBitmap
  // حارس التطابق: إن خالف قياس اللوحة تخطيط DOM (حرف بلا رسم في الخط فيسقط كلٌّ منهما إلى خط
  // بديل مختلف) فصناديق الكلمات لا تصلح للقص. نتراجع إلى قطعة واحدة للسطر كله: يظهر السطر
  // دفعة واحدة مع أول كلمة فيه، ولا ينكسر شيء.
  if (layout.mismatch > 1) {
    const first = Math.min(...line.words.map((word) => word.index));
    line.slices = [{ index: first, text: line.text, sx: 0, sw: Math.ceil(line.width) + pad * 2 }];
    return line.slices;
  }
  const visual = line.words.slice().sort((a, b) => a.left - b.left);
  const edges = [0];
  for (let i = 1; i < visual.length; i += 1) {
    edges.push(Math.round(pad + (visual[i - 1].left - line.left + visual[i - 1].width + visual[i].left - line.left) / 2));
  }
  edges.push(Math.ceil(line.width) + pad * 2);
  line.slices = visual.map((word, i) => ({ index: word.index, text: word.text, sx: edges[i], sw: edges[i + 1] - edges[i] }));
  return line.slices;
}

function blockOrigin(layout, width, height, position, safe, reserveBottom) {
  const padding = Math.round(layout.fontSize * 0.72);
  const boxHeight = layout.height + padding * 2;
  const boxWidth = layout.width + padding * 2;
  const margin = Math.round(width * 0.06);
  const boxX = layout.dir === 'rtl' ? width - margin - boxWidth : margin;
  const top = Math.round(height * safe.top), bottom = height - Math.round(height * safe.bottom) - reserveBottom;
  const boxY = position === 'top' ? top : position === 'center' ? Math.round((height - boxHeight) / 2) : bottom - boxHeight;
  return { padding, boxX: Math.round(boxX), boxY: Math.round(boxY), boxWidth: Math.ceil(boxWidth), boxHeight };
}

// يرسم عنواناً متحركاً. style: { animation, highlight }. يعيد وصفاً للكتلة للاختبار.
export function drawTitle(context, text, input) {
  const { width, height, colors, position, boxStyle, style, localMs, aspect, reserveBottom = 0, scale = 1 } = input;
  if (!text) return null;
  const fontSize = Math.max(30, Math.round(height * 0.052 * scale));
  const layout = layoutText(text, { fontSize, maxWidth: width * 0.78, font: style && style.font });
  if (!layout.lines.length) return null;
  const box = blockOrigin(layout, width, height, position, safeArea(aspect), reserveBottom);
  const animation = TEXT_ANIMATIONS.includes(style && style.animation) ? style.animation : 'none';
  const blockProgress = animation === 'none' ? 1 : Math.min(1, Math.max(0, localMs / BLOCK_IN_MS));
  const eased = easeInOutCubic(blockProgress);
  const highlightWord = style && typeof style.highlight === 'string' ? style.highlight.trim() : '';
  context.save();
  // حركة الكتلة كلها: الانزلاق من جهة بداية القراءة، والتكبير الخفيف حول مركزها.
  if (animation === 'slide') {
    context.globalAlpha = eased;
    context.translate((layout.dir === 'rtl' ? 1 : -1) * (1 - eased) * width * 0.08, 0);
  } else if (animation === 'zoom') {
    const factor = 0.92 + 0.08 * eased;
    const cx = box.boxX + box.boxWidth / 2, cy = box.boxY + box.boxHeight / 2;
    context.globalAlpha = eased;
    context.translate(cx, cy); context.scale(factor, factor); context.translate(-cx, -cy);
  }
  const blockAlpha = context.globalAlpha;
  // في «كلمة بكلمة» الصندوق وحده يتلاشى دخولاً؛ الكلمات لها عتامتها.
  if (animation === 'words') context.globalAlpha = Math.min(1, localMs / 200);
  if (boxStyle !== 'minimal') {
    context.fillStyle = colors.captionBackground;
    context.fillRect(box.boxX, box.boxY, box.boxWidth, box.boxHeight);
  } else {
    context.shadowColor = colors.captionBackground;
    context.shadowBlur = Math.max(4, Math.round(fontSize * 0.18));
  }
  let visibleWords = 0;
  layout.lines.forEach((line, lineIndex) => {
    const base = lineBitmap(layout, lineIndex, colors.captionText);
    const accent = highlightWord && colors.accent ? lineBitmap(layout, lineIndex, colors.accent) : null;
    const lineX = Math.round(box.boxX + box.padding + line.left - base.pad);
    const lineY = Math.round(box.boxY + box.padding + lineIndex * layout.lineHeight - base.pad);
    for (const slice of wordSlices(layout, lineIndex)) {
      let alpha = 1, rise = 0;
      if (animation === 'words') {
        const p = Math.min(1, Math.max(0, (localMs - slice.index * WORD_STAGGER_MS) / WORD_FADE_MS));
        // خروج سريع ثم استقرار: الكلمة مقروءة من أول لحظة ظهورها.
        alpha = 1 - Math.pow(1 - p, 3);
        rise = (1 - alpha) * fontSize * 0.35;
      }
      if (alpha <= 0) continue;
      visibleWords += 1;
      const source = accent && slice.text.replace(/[.,،؛:!?؟()«»"']/g, '') === highlightWord ? accent : base;
      context.globalAlpha = blockAlpha * alpha;
      context.drawImage(source.canvas, slice.sx, 0, slice.sw, source.canvas.height, lineX + slice.sx, lineY + Math.round(rise), slice.sw, source.canvas.height);
    }
  });
  context.restore();
  return { layout, box, visibleWords };
}

// الترجمة على الشاشة: مقطع واحد ثابت عند أسفل المساحة الآمنة. يعيد ارتفاع ما حجزه.
export function drawSubtitle(context, cue, input) {
  const { width, height, colors, aspect, font } = input;
  if (!cue) return 0;
  const fontSize = Math.max(24, Math.round(height * 0.036));
  const layout = layoutText(cue.text, { fontSize, maxWidth: width * 0.84, weight: 500, maxLines: 2, font });
  if (!layout.lines.length) return 0;
  const padding = Math.round(fontSize * 0.5);
  const boxWidth = layout.width + padding * 2, boxHeight = layout.height + padding * 2;
  const boxX = Math.round((width - boxWidth) / 2);
  const boxY = height - Math.round(height * safeArea(aspect).bottom) - boxHeight;
  context.save();
  context.fillStyle = colors.captionBackground;
  context.fillRect(boxX, boxY, boxWidth, boxHeight);
  layout.lines.forEach((line, lineIndex) => {
    const bitmap = lineBitmap(layout, lineIndex, colors.captionText);
    // كل سطر يتوسّط داخل الكتلة.
    const x = Math.round(boxX + padding + (layout.width - line.width) / 2 - bitmap.pad);
    context.drawImage(bitmap.canvas, x, Math.round(boxY + padding + lineIndex * layout.lineHeight - bitmap.pad));
  });
  context.restore();
  return boxHeight + Math.round(fontSize * 0.5);
}

// مقاطع الترجمة لمشهد، مخزّنة على مفتاح نصها ومدتها.
const cueCache = new Map();
export function sceneCue(scene, localMs, voiceDurationMs) {
  if (!scene.subtitles || !scene.voiceover_ar) return null;
  const duration = voiceDurationMs > 0 ? Math.min(voiceDurationMs, scene.duration_ms) : scene.duration_ms;
  const key = scene.voiceover_ar + '\u0001' + duration;
  if (!cueCache.has(key)) {
    if (cueCache.size > 200) cueCache.clear();
    cueCache.set(key, subtitleCues(scene.voiceover_ar, duration));
  }
  return cueAt(cueCache.get(key), localMs);
}

// هل يطلب المشهد مسار العناوين الجديد؟ مشهد v1 (بلا text_style ولا ترجمة) يبقى على الرسم القديم.
export function usesTitleEngine(scene) {
  const style = scene.text_style;
  return !!((style && (style.animation && style.animation !== 'none' || style.highlight || (style.font && style.font !== 'plex'))) || (scene.subtitles && scene.voiceover_ar));
}

export function clearTextCaches() {
  layoutCache.clear();
  cueCache.clear();
}
