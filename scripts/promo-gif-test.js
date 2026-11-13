// حارس مرمّز GIF — src/ui/lib/promo-export/gif.js (الدفعة 9 من مخرج الإعلانات).
// المفكِّك هنا مكتوب في الاختبار نفسه ومستقل عن المرمّز: جولة كاملة ترميز ⇒ فك ⇒ مطابقة البكسلات.
'use strict';

const assert = require('assert');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

// مفكِّك GIF89a أدنى: يعيد { width, height, loop, frames: [{ delayCs, width, height, rgba }] }.
function decodeGif(bytes) {
  let p = 0;
  const u16 = () => { const value = bytes[p] | (bytes[p + 1] << 8); p += 2; return value; };
  const signature = String.fromCharCode(...bytes.subarray(0, 6)); p = 6;
  const width = u16(), height = u16();
  const packed = bytes[p]; p += 3;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  const result = { signature, width, height, loop: null, frames: [], trailer: false };
  let delayCs = 0;
  while (p < bytes.length) {
    const marker = bytes[p]; p += 1;
    if (marker === 0x3b) { result.trailer = true; break; }
    if (marker === 0x21) {
      const label = bytes[p]; p += 1;
      if (label === 0xf9) { p += 1; p += 1; delayCs = u16(); p += 1; p += 1; continue; }
      if (label === 0xff) {
        const size = bytes[p]; const name = String.fromCharCode(...bytes.subarray(p + 1, p + 1 + size)); p += 1 + size;
        while (bytes[p] !== 0) { const sub = bytes[p]; if (name === 'NETSCAPE2.0' && sub === 3) result.loop = bytes[p + 2] | (bytes[p + 3] << 8); p += 1 + sub; }
        p += 1; continue;
      }
      while (bytes[p] !== 0) p += 1 + bytes[p];
      p += 1; continue;
    }
    if (marker !== 0x2c) throw new Error('bad_block_' + marker.toString(16) + '@' + (p - 1));
    p += 4;
    const frameWidth = u16(), frameHeight = u16();
    const flags = bytes[p]; p += 1;
    if (!(flags & 0x80)) throw new Error('no_local_table');
    const tableSize = 1 << ((flags & 7) + 1);
    const palette = bytes.subarray(p, p + tableSize * 3); p += tableSize * 3;
    const minCodeSize = bytes[p]; p += 1;
    const data = [];
    while (bytes[p] !== 0) { const size = bytes[p]; for (let i = 0; i < size; i += 1) data.push(bytes[p + 1 + i]); p += 1 + size; }
    p += 1;
    // LZW decode
    const clear = 1 << minCodeSize, end = clear + 1;
    let size = minCodeSize + 1, next = end + 1, bitBuffer = 0, bitCount = 0, at = 0, previous = null;
    let table = [];
    let clears = 0;
    const reset = () => { clears += 1; table = []; for (let i = 0; i < clear; i += 1) table[i] = [i]; table[clear] = []; table[end] = null; next = end + 1; size = minCodeSize + 1; previous = null; };
    reset();
    const indices = [];
    for (;;) {
      while (bitCount < size && at < data.length) { bitBuffer |= data[at] << bitCount; bitCount += 8; at += 1; }
      if (bitCount < size) break;
      const code = bitBuffer & ((1 << size) - 1);
      bitBuffer >>>= size; bitCount -= size;
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      let entry;
      if (code < next && table[code]) entry = table[code];
      else if (code === next && previous) entry = previous.concat(previous[0]);
      else throw new Error('bad_lzw_code_' + code + '_next_' + next);
      for (const value of entry) indices.push(value);
      if (previous && next < 4096) {
        table[next] = previous.concat(entry[0]);
        next += 1;
        if (next === (1 << size) && size < 12) size += 1;
      }
      previous = entry;
    }
    const rgba = new Uint8Array(frameWidth * frameHeight * 4);
    for (let i = 0; i < frameWidth * frameHeight; i += 1) {
      const index = indices[i];
      rgba[i * 4] = palette[index * 3]; rgba[i * 4 + 1] = palette[index * 3 + 1]; rgba[i * 4 + 2] = palette[index * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    result.frames.push({ delayCs, width: frameWidth, height: frameHeight, rgba, indexCount: indices.length, tableSize, clears: clears - 1 });
  }
  return result;
}

(async () => {
  const gif = await import('../src/ui/lib/promo-export/gif.js');
  const { gifSize, buildPalette, mapToPalette, lzwEncode, gifHeader, gifFrame, GIF_TRAILER, frameDelayCs } = gif;
  const concat = (parts) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
  const image = (width, height, fn) => { const rgba = new Uint8Array(width * height * 4); for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const [r, g, b] = fn(x, y); const i = (y * width + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; } return rgba; };
  const encode = (frames, width, height, fps) => concat([gifHeader(width, height), ...frames.map((rgba, index) => gifFrame(rgba, width, height, frameDelayCs(index, fps))), GIF_TRAILER]);

  // ── الأبعاد ──
  eq(gifSize(1920, 1080), { width: 1280, height: 720 }, '1080p ⇒ 720p');
  eq(gifSize(1080, 1920), { width: 720, height: 1280 }, 'عمودي ⇒ 720×1280');
  eq(gifSize(1080, 1080), { width: 720, height: 720 }, 'مربع ⇒ 720');
  eq(gifSize(3840, 2160), { width: 1280, height: 720 }, '4K ⇒ 720p');
  eq(gifSize(640, 360), { width: 640, height: 360 }, 'الأصغر لا يُكبَّر');
  eq(gifSize(641, 361), { width: 642, height: 362 }, 'أبعاد زوجية');

  // ── التأخير بلا انحراف ──
  let total = 0; for (let i = 0; i < 225; i += 1) total += frameDelayCs(i, 15);
  eq(total, 1500, '225 إطاراً @15 = 15 ثانية بالضبط');
  total = 0; for (let i = 0; i < 100; i += 1) total += frameDelayCs(i, 12);
  eq(total, Math.round(100 * 100 / 12), 'معدل لا يقسم المئة: المجموع صحيح');

  // ── جولة كاملة بلا فقد: صورة بألوان قليلة ──
  const few = image(64, 48, (x, y) => [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]][(Math.floor(x / 8) + Math.floor(y / 8)) % 5]);
  const decodedFew = decodeGif(encode([few], 64, 48, 15));
  eq([decodedFew.signature, decodedFew.width, decodedFew.height, decodedFew.loop, decodedFew.trailer, decodedFew.frames.length], ['GIF89a', 64, 48, 0, true, 1], 'الرأس والتكرار والذيل');
  eq(decodedFew.frames[0].indexCount, 64 * 48, 'عدد البكسلات المفكوكة');
  eq(Buffer.compare(Buffer.from(decodedFew.frames[0].rgba), Buffer.from(few)), 0, 'خمسة ألوان: مطابقة تامة');
  eq(decodedFew.frames[0].tableSize, 8, 'لوحة بحجم أصغر قوة 2 تكفي');

  // لون واحد، ولونان (أصغر حجم رمز)
  for (const [label, fn] of [['لون واحد', () => [10, 20, 30]], ['لونان', (x) => (x % 2 ? [0, 0, 0] : [255, 255, 255])]]) {
    const source = image(40, 30, fn);
    eq(Buffer.compare(Buffer.from(decodeGif(encode([source], 40, 30, 15)).frames[0].rgba), Buffer.from(source)), 0, label + ': مطابقة تامة');
  }

  // ── 256 لوناً بالضبط: مطابقة تامة، واللوحة ممتلئة ──
  const exact = image(256, 16, (x) => [x, 255 - x, (x * 7) % 256]);
  const decodedExact = decodeGif(encode([exact], 256, 16, 15));
  eq(Buffer.compare(Buffer.from(decodedExact.frames[0].rgba), Buffer.from(exact)), 0, '256 لوناً: مطابقة تامة');
  eq(decodedExact.frames[0].tableSize, 256, 'لوحة 256');

  // ── صورة كبيرة تملأ القاموس وتفرض رموز المسح (ضوضاء حتمية) ──
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed >>> 16; };
  const noise = image(320, 200, () => { const value = random() % 16; return [value * 16, (value * 5) % 256, 255 - value * 16]; });
  const decodedNoise = decodeGif(encode([noise], 320, 200, 15));
  eq(Buffer.compare(Buffer.from(decodedNoise.frames[0].rgba), Buffer.from(noise)), 0, 'ضوضاء 16 لوناً على 64000 بكسل: مطابقة تامة');
  ok(decodedNoise.frames[0].clears >= 3, 'القاموس امتلأ ومُسح فعلاً: ' + decodedNoise.frames[0].clears + ' رمز مسح');

  // ── تدرج بآلاف الألوان: تكميم بفقد محدود ──
  const gradient = image(200, 150, (x, y) => [Math.round(x * 255 / 199), Math.round(y * 255 / 149), Math.round((x + y) * 255 / 348)]);
  const decodedGradient = decodeGif(encode([gradient], 200, 150, 15)).frames[0].rgba;
  let worst = 0, sum = 0;
  for (let i = 0; i < gradient.length; i += 4) for (let c = 0; c < 3; c += 1) { const diff = Math.abs(gradient[i + c] - decodedGradient[i + c]); worst = Math.max(worst, diff); sum += diff; }
  ok(worst <= 48 && sum / (gradient.length / 4 * 3) < 8, 'التدرج: أقصى فرق ' + worst + ' ومتوسط ' + (sum / (gradient.length / 4 * 3)).toFixed(2));
  const { palette, colors } = buildPalette(gradient);
  ok(colors > 200 && colors <= 256, 'اللوحة تستعمل معظم الـ256: ' + colors);
  const mapped = mapToPalette(gradient, palette, colors);
  ok(mapped.every((index) => index < colors), 'كل الفهارس داخل اللوحة');

  // ── عدة إطارات بتأخيراتها ──
  const frames = [image(32, 32, () => [255, 0, 0]), image(32, 32, () => [0, 255, 0]), image(32, 32, (x) => (x < 16 ? [0, 0, 255] : [255, 255, 0]))];
  const multi = decodeGif(encode(frames, 32, 32, 15));
  eq(multi.frames.length, 3, 'ثلاثة إطارات');
  eq(multi.frames.map((frame) => frame.delayCs), [7, 6, 7], 'التأخيرات 7/6/7 جزءاً من المئة (15 إطاراً/ث)');
  frames.forEach((frame, index) => eq(Buffer.compare(Buffer.from(multi.frames[index].rgba), Buffer.from(frame)), 0, 'الإطار ' + (index + 1) + ' مطابق'));

  // ── LZW: الكتل الفرعية ≤ 255 وتنتهي بصفر ──
  const stream = lzwEncode(Uint8Array.from({ length: 5000 }, (_, i) => i % 7), 3);
  let at = 0, blocks = 0;
  while (stream[at] !== 0) { assert.ok(stream[at] <= 255 && stream[at] > 0); at += 1 + stream[at]; blocks += 1; }
  eq(at, stream.length - 1, 'الكتل الفرعية تغطي التيار وتنتهي بكتلة صفرية');
  ok(blocks >= 1, 'كتل فرعية: ' + blocks);

  console.log('promo-gif-test: ok — ' + checks + ' فحصاً (الأبعاد، التأخير، جولة ترميز/فك بلا فقد حتى 256 لوناً، امتلاء القاموس، التكميم، تعدد الإطارات).');
})().catch((error) => {
  console.error('promo-gif-test:', error && error.stack ? error.stack : error);
  process.exit(1);
});
