/**
 * حارس «سلامة عرض المحتوى الفارسي» — فحص الخط الساكن + اختبار Electron الحي.
 *
 * لا يعتمد على مكتبة خطوط: يفك دليل WOFF2، ثم يفك مجرى Brotli المضمّن ويقرأ
 * جدول cmap غير المحوّل مباشرةً. يشغّل بعده مكوّني المحادثة وعارض الملفات
 * الإنتاجيين تحت CSP صارم، ويقيس الاتجاه وبقاء ZWNJ والتظليل والخط المضمّن.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FONT_CSS = path.join(ROOT, 'src', 'vendor', 'fonts.css');
const FIXTURE = path.join(__dirname, 'fixtures', 'farsi-content.html');
const WEIGHTS = [400, 500, 700];
const TIMEOUT_MS = 30000;

// القائمة المقصودة هي كل النقاط المسماة في العقد المجمّد. النص المرجعي المستقل
// تحتها يمنع إضعاف الحارس بحذف نقطة من هذه القائمة من دون أن يحمرّ الاختبار.
const REQUIRED_POINTS = [
  { char: 'پ', codePoint: 0x067e },
  { char: 'چ', codePoint: 0x0686 },
  { char: 'ژ', codePoint: 0x0698 },
  { char: 'گ', codePoint: 0x06af },
  { char: 'ک', codePoint: 0x06a9 },
  { char: 'ی', codePoint: 0x06cc },
  { char: '۰', codePoint: 0x06f0 },
  { char: '۱', codePoint: 0x06f1 },
  { char: '۲', codePoint: 0x06f2 },
  { char: '۳', codePoint: 0x06f3 },
  { char: '۴', codePoint: 0x06f4 },
  { char: '۵', codePoint: 0x06f5 },
  { char: '۶', codePoint: 0x06f6 },
  { char: '۷', codePoint: 0x06f7 },
  { char: '۸', codePoint: 0x06f8 },
  { char: '۹', codePoint: 0x06f9 },
];
const CONTRACT_POINT_SEQUENCE = 'پچژگکی۰۱۲۳۴۵۶۷۸۹';

const KNOWN_WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf',
];

function pointLabel(char, codePoint = char.codePointAt(0)) {
  return char + ' U+' + codePoint.toString(16).toUpperCase().padStart(4, '0');
}

function readBase128(buffer, state) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    assert(state.offset < buffer.length, 'انتهى دليل WOFF2 داخل UIntBase128.');
    const byte = buffer[state.offset++];
    assert(!(i === 0 && byte === 0x80), 'ترميز UIntBase128 غير قانوني في WOFF2.');
    assert(value <= 0x01ffffff, 'تجاوز UIntBase128 سعة 32 بت في WOFF2.');
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error('UIntBase128 أطول من خمسة بايتات في WOFF2.');
}

function extractWoff2Table(buffer, wantedTag) {
  assert(buffer.length >= 48 && buffer.toString('ascii', 0, 4) === 'wOF2',
    'ملف الخط ليس WOFF2 صالحاً.');
  assert.strictEqual(buffer.readUInt32BE(8), buffer.length, 'طول WOFF2 في الرأس لا يطابق الملف.');
  const numTables = buffer.readUInt16BE(12);
  const compressedLength = buffer.readUInt32BE(20);
  const state = { offset: 48 };
  const entries = [];

  for (let i = 0; i < numTables; i++) {
    assert(state.offset < buffer.length, 'انتهى دليل جداول WOFF2 مبكراً.');
    const flags = buffer[state.offset++];
    const tagIndex = flags & 0x3f;
    let tag;
    if (tagIndex === 0x3f) {
      assert(state.offset + 4 <= buffer.length, 'وسم WOFF2 مخصص مبتور.');
      tag = buffer.toString('ascii', state.offset, state.offset + 4);
      state.offset += 4;
    } else {
      tag = KNOWN_WOFF2_TAGS[tagIndex];
      assert(tag, 'فهرس وسم WOFF2 غير معروف: ' + tagIndex);
    }
    const originalLength = readBase128(buffer, state);
    const transformVersion = flags >>> 6;
    const transformed = (tag === 'glyf' || tag === 'loca')
      ? transformVersion === 0 : transformVersion !== 0;
    const storedLength = transformed ? readBase128(buffer, state) : originalLength;
    entries.push({ tag, originalLength, storedLength });
  }

  assert(state.offset + compressedLength <= buffer.length, 'مجرى Brotli في WOFF2 مبتور.');
  const stream = zlib.brotliDecompressSync(buffer.subarray(state.offset, state.offset + compressedLength));
  let tableOffset = 0;
  for (const entry of entries) {
    assert(tableOffset + entry.storedLength <= stream.length,
      'بيانات جدول ' + entry.tag + ' تتجاوز مجرى WOFF2 المفكوك.');
    if (entry.tag === wantedTag) {
      assert.strictEqual(entry.storedLength, entry.originalLength,
        'جدول ' + wantedTag + ' محوّل على نحو لا يدعمه القارئ المحدود.');
      return stream.subarray(tableOffset, tableOffset + entry.originalLength);
    }
    tableOffset += entry.storedLength;
  }
  throw new Error('غاب جدول ' + wantedTag + ' من WOFF2.');
}

function cmapSubtables(cmap) {
  assert(cmap.length >= 4 && cmap.readUInt16BE(0) === 0, 'رأس cmap غير صالح.');
  const count = cmap.readUInt16BE(2);
  assert(4 + count * 8 <= cmap.length, 'سجل ترميزات cmap مبتور.');
  const tables = [];
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    const offset = cmap.readUInt32BE(record + 4);
    if (offset + 2 > cmap.length) continue;
    const format = cmap.readUInt16BE(offset);
    if ((platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))
        && (format === 4 || format === 12 || format === 13)) {
      tables.push({ offset, format });
    }
  }
  assert(tables.length, 'لا جدول Unicode مدعوماً داخل cmap.');
  return tables;
}

function format4HasGlyph(cmap, offset, codePoint) {
  if (codePoint > 0xffff || offset + 16 > cmap.length) return false;
  const length = cmap.readUInt16BE(offset + 2);
  const limit = Math.min(cmap.length, offset + length);
  const segmentCount = cmap.readUInt16BE(offset + 6) / 2;
  const endStart = offset + 14;
  const startStart = endStart + segmentCount * 2 + 2;
  const deltaStart = startStart + segmentCount * 2;
  const rangeStart = deltaStart + segmentCount * 2;
  if (!Number.isInteger(segmentCount) || rangeStart + segmentCount * 2 > limit) return false;
  for (let i = 0; i < segmentCount; i++) {
    const end = cmap.readUInt16BE(endStart + i * 2);
    if (codePoint > end) continue;
    const start = cmap.readUInt16BE(startStart + i * 2);
    if (codePoint < start) return false;
    const delta = cmap.readInt16BE(deltaStart + i * 2);
    const rangeWord = rangeStart + i * 2;
    const range = cmap.readUInt16BE(rangeWord);
    if (range === 0) return ((codePoint + delta) & 0xffff) !== 0;
    const glyphOffset = rangeWord + range + (codePoint - start) * 2;
    if (glyphOffset + 2 > limit) return false;
    const glyph = cmap.readUInt16BE(glyphOffset);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

function format12Or13HasGlyph(cmap, offset, codePoint, format) {
  if (offset + 16 > cmap.length) return false;
  const length = cmap.readUInt32BE(offset + 4);
  const limit = Math.min(cmap.length, offset + length);
  const groups = cmap.readUInt32BE(offset + 12);
  if (offset + 16 + groups * 12 > limit) return false;
  let low = 0;
  let high = groups - 1;
  while (low <= high) {
    const index = (low + high) >>> 1;
    const group = offset + 16 + index * 12;
    const start = cmap.readUInt32BE(group);
    const end = cmap.readUInt32BE(group + 4);
    if (codePoint < start) high = index - 1;
    else if (codePoint > end) low = index + 1;
    else {
      const firstGlyph = cmap.readUInt32BE(group + 8);
      return format === 13 ? firstGlyph !== 0 : firstGlyph + codePoint - start !== 0;
    }
  }
  return false;
}

function cmapHasGlyph(cmap, codePoint) {
  return cmapSubtables(cmap).some((table) => table.format === 4
    ? format4HasGlyph(cmap, table.offset, codePoint)
    : format12Or13HasGlyph(cmap, table.offset, codePoint, table.format));
}

function parseUnicodeRanges(value) {
  return value.split(',').map((part) => {
    const match = part.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
    assert(match, 'unicode-range غير مفهوم: ' + part.trim());
    return [parseInt(match[1], 16), parseInt(match[2] || match[1], 16)];
  });
}

function assertStaticFontContract() {
  const css = fs.readFileSync(FONT_CSS, 'utf8');
  const blocks = css.match(/@font-face\s*\{[\s\S]*?\}/g) || [];
  const requiredByCodePoint = new Map(REQUIRED_POINTS.map((point) => [point.codePoint, point]));
  for (const char of Array.from(CONTRACT_POINT_SEQUENCE)) {
    const codePoint = char.codePointAt(0);
    assert(requiredByCodePoint.has(codePoint),
      'غابت النقطة ' + pointLabel(char, codePoint) + ' من قائمة الفحص الساكن.');
  }
  assert.strictEqual(requiredByCodePoint.size, Array.from(CONTRACT_POINT_SEQUENCE).length,
    'قائمة الفحص الساكن تحوي نقطة زائدة أو مكررة.');

  for (const weight of WEIGHTS) {
    const block = blocks.find((candidate) => new RegExp('font-weight:\\s*' + weight + '\\s*;').test(candidate)
      && new RegExp('arabic-' + weight + '-normal\\.woff2').test(candidate));
    assert(block, 'غاب @font-face العربي للوزن ' + weight + '.');
    const rangeMatch = block.match(/unicode-range:\s*([^;]+);/i);
    assert(rangeMatch, 'غاب unicode-range للوزن ' + weight + '.');
    const ranges = parseUnicodeRanges(rangeMatch[1]);
    assert(ranges.some(([start, end]) => start <= 0x0600 && end >= 0x06ff),
      'unicode-range لا يغطي U+0600-06FF كاملاً للوزن ' + weight + '.');

    const sourceMatch = block.match(/src:\s*url\(([^)]+)\)\s*format\(['"]woff2['"]\)/i);
    assert(sourceMatch, 'غاب مصدر WOFF2 للوزن ' + weight + '.');
    const fontFile = path.resolve(path.dirname(FONT_CSS), sourceMatch[1].replace(/^['"]|['"]$/g, ''));
    assert(fs.existsSync(fontFile), 'غاب ملف الخط للوزن ' + weight + ': ' + fontFile);
    const cmap = extractWoff2Table(fs.readFileSync(fontFile), 'cmap');
    for (const point of REQUIRED_POINTS) {
      assert(cmapHasGlyph(cmap, point.codePoint),
        'غابت النقطة ' + pointLabel(point.char, point.codePoint) + ' من cmap للوزن ' + weight + '.');
    }
  }

  console.log('farsi-content-static: نجح — unicode-range وcmap للنقاط الفارسية المسماة في الأوزان 400/500/700.');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLiveResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__farsiContentResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة اختبار سلامة عرض المحتوى الفارسي الحي.');
}

async function assertLiveContract() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForLiveResult(win);
    assert(result.pass, 'فشل اختبار سلامة عرض المحتوى الفارسي الحي:\n'
      + (result.error || '') + '\nviolations: ' + JSON.stringify(result.violations || []));
    assert.strictEqual(result.zwnj.before, 1, 'يجب أن يحوي fixture نقطة ZWNJ واحدة قبل العرض.');
    assert.strictEqual(result.zwnj.user, 1, 'فقاعة المستخدم لم تحتفظ بـ ZWNJ واحدة.');
    assert.strictEqual(result.zwnj.assistant, 1, 'فقرة المساعد لم تحتفظ بـ ZWNJ واحدة.');
    console.log('farsi-content-live: نجح — المحادثة RTL والمسار والكود LTR؛ عارض JS مظلّل LTR؛ ZWNJ 1→1؛ الخط المضمّن حاضر؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main() {
  assertStaticFontContract();
  await assertLiveContract();
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
