/**
 * توليد أيقونة التطبيق build/icon.ico من علامة «سطر» — بلا أي اعتماديات.
 *
 * العلامة: خلفية داكنة (لون السطح) + «سطر نص» باهت + مؤشّر ذهبي عند بدايته (يسار = نهاية
 * الكتابة في RTL، أي بداية السطر العربي). تطابق روح الكلمة-العلامة (المؤشّر الذهبي الوامض).
 *
 * نبني PNG لكل مقاس يدوياً (zlib من Node) ثم نحزمها في ملف ICO (PNG مضمّن، مدعوم على
 * ويندوز فيستا فما فوق). يُشغَّل عبر `node scripts/make-icon.js` — وثّقناه ليُعاد توليده عند
 * تغيير العلامة. لا نضيف اعتمادية رسم؛ هذا متعمّد (قاعدة «أقل اعتماديات» في CLAUDE.md).
 *
 * **أصول Microsoft Store (‏MSIX)**: `node scripts/make-icon.js --appx` يكتب معها شعارات
 * `build/appx/*.png` التي يقرأها `electron-builder` عند `target: appx` (الأسماء ثابتة في
 * `app-builder-lib/out/targets/AppxTarget.js` — لا تُغيَّر). إن غابت استعمل electron-builder
 * شعارات `SampleAppx` الافتراضية، فتظهر علامة غريبة في المتجر. المستطيلات (البلاطة العريضة)
 * ترسم العلامة في مربع مركزي بمقياس الضلع الأقصر، والخلفية تملأ الباقي.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ألوان العلامة (من متغيّرات الواجهة)
const BG = [0x15, 0x1B, 0x23];   // --surface
const TEXT = [0x9A, 0xA3, 0xAE]; // --text-dim (سطر النص)
const GOLD = [0xD9, 0xA4, 0x41]; // --gold (المؤشّر)

const SIZES = [256, 128, 64, 48, 32, 16];

// رسم بكسلات مقاس واحد (RGBA) — مستطيلات صريحة، بلا تنعيم، فتبقى حادة بكل المقاسات.
// العرض والارتفاع منفصلان (شعارات المتجر ليست كلها مربعة): العلامة في مربع مركزي
// بمقياس الضلع الأقصر، والخلفية تملأ الإطار كاملاً.
function drawRGBA(W, H = W) {
  const buf = Buffer.alloc(W * H * 4);
  const S = Math.min(W, H);
  const offX = Math.round((W - S) / 2), offY = Math.round((H - S) / 2);
  const put = (x, y, c) => {
    const i = (y * W + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  };
  // الخلفية تملأ الإطار كله (بإحداثيات بكسل مطلقة لا نسبة العلامة)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, BG);
  // إحداثيات نسبية داخل مربع العلامة → بكسلات
  const rect = (x0, y0, x1, y1, c) => {
    const X0 = offX + Math.round(x0 * S), Y0 = offY + Math.round(y0 * S);
    const X1 = offX + Math.round(x1 * S), Y1 = offY + Math.round(y1 * S);
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) if (x >= 0 && x < W && y >= 0 && y < H) put(x, y, c);
  };
  // سطر النص الباهت (يمتدّ يميناً بعد المؤشّر)
  rect(0.34, 0.560, 0.80, 0.632, TEXT);
  // المؤشّر الذهبي عند يسار السطر (بداية الكتابة في RTL)
  rect(0.24, 0.300, 0.323, 0.652, GOLD);
  return buf;
}

// ---- تجميع PNG يدوياً (توقيع + IHDR + IDAT + IEND) ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePNG(W, H = W) {
  const rgba = drawRGBA(W, H);
  // إضافة بايت المرشّح (0) لبداية كل سطر
  const stride = W * 4 + 1;
  const raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // عمق البت
  ihdr[9] = 6;  // نوع اللون RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- تجميع ICO (إدخالات PNG مضمّنة) ----
function makeICO(sizes) {
  const pngs = sizes.map((s) => makePNG(s, s));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  for (let i = 0; i < count; i++) {
    const S = sizes[i], png = pngs[i], e = i * 16;
    entries[e] = S >= 256 ? 0 : S;       // العرض (0 تعني 256)
    entries[e + 1] = S >= 256 ? 0 : S;   // الارتفاع
    entries[e + 2] = 0; entries[e + 3] = 0;
    entries.writeUInt16LE(1, e + 4);     // الطبقات
    entries.writeUInt16LE(32, e + 6);    // بتات لكل بكسل
    entries.writeUInt32LE(png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += png.length;
  }
  return Buffer.concat([header, entries, ...pngs]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, makeICO(SIZES));
console.log('make-icon: كُتبت ' + out + ' (' + SIZES.join('، ') + ')');

// ---- شعارات MSIX (‏--appx) ----
// الأسماء ثابتة يقرؤها electron-builder؛ الأربعة الأولى تحلّ محلّ شعارات SampleAppx
// الافتراضية، والأخيرتان تُفعّلان بلاطتَي 310×310 و71×71 في قائمة ابدأ (اختياريتان لكن
// غيابهما يجعل البلاطة الكبيرة تسقط إلى الافتراضي).
const APPX_ASSETS = [
  ['StoreLogo.png', 50, 50],
  ['Square44x44Logo.png', 44, 44],
  ['Square150x150Logo.png', 150, 150],
  ['Wide310x150Logo.png', 310, 150],
  ['LargeTile.png', 310, 310],
  ['SmallTile.png', 71, 71],
];

if (process.argv.includes('--appx')) {
  const dir = path.join(__dirname, '..', 'build', 'appx');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, w, h] of APPX_ASSETS) {
    fs.writeFileSync(path.join(dir, name), makePNG(w, h));
  }
  console.log('make-icon: كُتبت شعارات MSIX في ' + dir + ' (' + APPX_ASSETS.length + ' ملفاً)');
}
