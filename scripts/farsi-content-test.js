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
const { app, BrowserWindow } = require('electron');
// مفكّك cmap مشترك (‏OBS-037) — كان محلياً هنا، ونُقل حرفياً ليستعمله الحارس المُعمَّم
const {
  pointLabel, extractWoff2Table, cmapHasGlyph, parseUnicodeRanges,
} = require('./lib/woff2cmap');

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
