// مرمّز GIF89a مكتوب يدوياً: لوحة ألوان لكل إطار بـmedian-cut ثم ضغط LZW. بلا اعتماديات، نقي
// (يعمل في المتصفح وnode). لإعلانات قصيرة للمعاينة والمشاركة السريعة؛ MP4 هو الناتج الأساسي.
//
// القيود (الدفعة 9 من docs/PROMO-DIRECTOR-PLAN.md): 720p و15 إطاراً/ث و15 ثانية على الأكثر.

export const GIF_MAX_FPS = 15;
export const GIF_MAX_MS = 15000;
export const GIF_MAX_LONG_SIDE = 1280;
export const GIF_MAX_SHORT_SIDE = 720;

// أبعاد GIF لمقاس مصدر: تصغير يحافظ على النسبة حتى يدخل في 1280×720 (أو 720×1280). أبعاد زوجية.
export function gifSize(width, height) {
  const long = Math.max(width, height), short = Math.min(width, height);
  const scale = Math.min(1, GIF_MAX_LONG_SIDE / long, GIF_MAX_SHORT_SIDE / short);
  const even = (value) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

// median-cut على عيّنة من البكسلات ⇒ لوحة ≤ 256 لوناً (Uint8Array بطول 768، RGB).
export function buildPalette(rgba, maxColors = 256, maxSamples = 24000) {
  const pixels = rgba.length >> 2;
  // إطار ألوانه المميزة ≤ الحد: اللوحة هي الألوان نفسها بلا تكميم ولا عيّنات. أخذ العيّنات قد
  // يفوّت لوناً صغير المساحة (خط رفيع، أيقونة) فيُستبدل بأقرب لون.
  const distinct = new Map();
  for (let i = 0; i < pixels && distinct.size <= maxColors; i += 1) {
    const color = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    if (!distinct.has(color)) distinct.set(color, distinct.size);
  }
  if (distinct.size <= maxColors) {
    const exact = new Uint8Array(768);
    for (const [color, index] of distinct) { exact[index * 3] = color >> 16; exact[index * 3 + 1] = (color >> 8) & 255; exact[index * 3 + 2] = color & 255; }
    return { palette: exact, colors: Math.max(1, distinct.size) };
  }
  const step = Math.max(1, Math.floor(pixels / maxSamples));
  const samples = [];
  for (let i = 0; i < pixels; i += step) samples.push((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]);
  let boxes = [samples];
  const channel = (color, shift) => (color >> shift) & 255;
  while (boxes.length < maxColors) {
    // الصندوق الأوسع مدىً في أي قناة يُقسم عند وسيطه.
    let best = -1, bestRange = 0, bestShift = 0;
    for (let b = 0; b < boxes.length; b += 1) {
      const box = boxes[b];
      if (box.length < 2) continue;
      for (const shift of [16, 8, 0]) {
        let min = 255, max = 0;
        for (const color of box) { const value = channel(color, shift); if (value < min) min = value; if (value > max) max = value; }
        if (max - min > bestRange) { bestRange = max - min; best = b; bestShift = shift; }
      }
    }
    if (best < 0 || bestRange === 0) break;
    const box = boxes[best].slice().sort((a, c) => channel(a, bestShift) - channel(c, bestShift));
    // القسمة عند قيمة لا عند فهرس: البكسلات المتساوية تبقى في صندوق واحد، فلا تتكرر الألوان في
    // اللوحة (صورة بخمسة ألوان كانت تخرج بلوحة 128).
    let middle = box.length >> 1;
    const pivot = channel(box[middle], bestShift);
    while (middle < box.length && channel(box[middle], bestShift) === pivot) middle += 1;
    if (middle === box.length) { middle = box.length >> 1; while (middle > 0 && channel(box[middle - 1], bestShift) === pivot) middle -= 1; }
    boxes.splice(best, 1, box.slice(0, middle), box.slice(middle));
  }
  const palette = new Uint8Array(768);
  boxes = boxes.filter((box) => box.length);
  boxes.forEach((box, index) => {
    let r = 0, g = 0, b = 0;
    for (const color of box) { r += channel(color, 16); g += channel(color, 8); b += channel(color, 0); }
    palette[index * 3] = Math.round(r / box.length);
    palette[index * 3 + 1] = Math.round(g / box.length);
    palette[index * 3 + 2] = Math.round(b / box.length);
  });
  return { palette, colors: boxes.length };
}

// كل بكسل ⇒ فهرس أقرب لون في اللوحة. الذاكرة المؤقتة على مرحلتين: مفتاح اللون الكامل (24 بت)
// ما دامت الألوان المميزة قليلة، فتخرج لقطات الواجهات المسطحة بلا فقد؛ وحين تكثر الألوان
// (فيديو، تدرجات) ينتقل الباقي إلى مفتاح تقريبي 15 بت كي يبقى البحث مرة لكل لون تقريبي.
const EXACT_CACHE_LIMIT = 20000;
export function mapToPalette(rgba, palette, colors) {
  const pixels = rgba.length >> 2;
  const indices = new Uint8Array(pixels);
  const exact = new Map();
  const coarse = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    let bestDistance = Infinity, best = 0;
    for (let c = 0; c < colors; c += 1) {
      const dr = r - palette[c * 3], dg = g - palette[c * 3 + 1], db = b - palette[c * 3 + 2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) { bestDistance = distance; best = c; }
    }
    return best;
  };
  for (let i = 0; i < pixels; i += 1) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const full = (r << 16) | (g << 8) | b;
    let index = exact.get(full);
    if (index === undefined) {
      if (exact.size < EXACT_CACHE_LIMIT) {
        index = nearest(r, g, b);
        exact.set(full, index);
      } else {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        index = coarse[key];
        if (index < 0) { index = nearest(r, g, b); coarse[key] = index; }
      }
    }
    indices[i] = index;
  }
  return indices;
}

// ضغط LZW بصيغة GIF: رموز متغيرة الطول، رمز مسح عند امتلاء القاموس (4096)، وكتل فرعية ≤ 255 بايتاً.
export function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize, end = clear + 1;
  const out = [];
  let block = [];
  let bitBuffer = 0, bitCount = 0;
  const emit = (code, size) => {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      block.push(bitBuffer & 255);
      bitBuffer >>>= 8; bitCount -= 8;
      if (block.length === 255) { out.push(255, ...block); block = []; }
    }
  };
  let dictionary = new Map();
  let next = end + 1, size = minCodeSize + 1;
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const value = indices[i];
    const key = (prefix << 8) | value;
    const found = dictionary.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix, size);
    if (next < 4096) {
      dictionary.set(key, next);
      if (next === (1 << size) && size < 12) size += 1;
      next += 1;
    } else {
      emit(clear, size);
      dictionary = new Map();
      next = end + 1; size = minCodeSize + 1;
    }
    prefix = value;
  }
  emit(prefix, size);
  emit(end, size);
  if (bitCount > 0) block.push(bitBuffer & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return Uint8Array.from(out);
}

function u16(value) { return [value & 255, (value >> 8) & 255]; }

// رأس الملف: GIF89a + واصف الشاشة (بلا لوحة عامة) + امتداد التكرار اللانهائي.
export function gifHeader(width, height) {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(width), ...u16(height), 0x70, 0, 0,
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0, 0, 0,
  ]);
}

// إطار واحد: امتداد التحكم (التأخير بجزء من مئة من الثانية) + واصف الصورة بلوحة محلية + البيانات.
export function gifFrame(rgba, width, height, delayCs) {
  const { palette, colors } = buildPalette(rgba);
  const indices = mapToPalette(rgba, palette, colors);
  let bits = 1;
  while ((1 << bits) < colors) bits += 1;
  bits = Math.max(1, bits);
  const tableSize = 1 << bits;
  const minCodeSize = Math.max(2, bits);
  const data = lzwEncode(indices, minCodeSize);
  const head = [0x21, 0xf9, 0x04, 0x00, ...u16(Math.max(2, delayCs)), 0x00, 0x00,
    0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0x80 | (bits - 1)];
  const frame = new Uint8Array(head.length + tableSize * 3 + 1 + data.length);
  frame.set(head, 0);
  frame.set(palette.subarray(0, tableSize * 3), head.length);
  frame[head.length + tableSize * 3] = minCodeSize;
  frame.set(data, head.length + tableSize * 3 + 1);
  return frame;
}

export const GIF_TRAILER = Uint8Array.from([0x3b]);

// تأخير الإطار i بجزء من مئة من الثانية بلا انحراف تراكمي: الفرق بين طابعين مقرَّبين.
export function frameDelayCs(index, fps) {
  return Math.round((index + 1) * 100 / fps) - Math.round(index * 100 / fps);
}
