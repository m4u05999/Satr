/**
 * تضمين (vendoring) خط IBM Plex Sans Arabic في src/vendor للواجهة — الدفعة 4.1
 *
 * الواجهة صفر اعتماديات npm وقت التشغيل (القاعدة 5 في CLAUDE.md) — لذا لا نحمّل الخط
 * من CDN (الـ CSP يمنع أصلاً) بل ننسخ ملفات woff2 من devDependency
 * ‏@fontsource/ibm-plex-sans-arabic (رخصة OFL-1.1) إلى src/vendor/fonts/
 * ونولّد src/vendor/fonts.css والناتج يُلتزَم في git — نفس نمط vendor-xterm.js.
 *
 * النطاق المُضمّن (قرار مالك 2026-07-11): مجموعتا subset عربي + لاتيني فقط
 * (لا cyrillic/latin-ext)، الأوزان 400 (نص) و500 (عناوين فرعية) و700 (عناوين/أزرار)،
 * بصيغة woff2 حصراً (Chromium/Electron يدعمها دائماً — لا حاجة لـ woff الاحتياطي).
 * كتل @font-face تُستخرج من CSS الحزمة نفسها (unicode-range يبقى متزامناً مع الترقية).
 *
 * يُشغَّل يدوياً فقط عند ترقية إصدار الخط:
 *     node scripts/vendor-fonts.js
 */
const fs = require('fs');
const path = require('path');

const pkgDir = path.join(__dirname, '..', 'node_modules', '@fontsource', 'ibm-plex-sans-arabic');
const outDir = path.join(__dirname, '..', 'src', 'vendor');
const fontsDir = path.join(outDir, 'fonts');

const WEIGHTS = [400, 500, 700];
const SUBSETS = ['arabic', 'latin'];

const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
fs.mkdirSync(fontsDir, { recursive: true });

const blocks = [];
const copied = [];
for (const w of WEIGHTS) {
  const css = fs.readFileSync(path.join(pkgDir, w + '.css'), 'utf8');
  for (const subset of SUBSETS) {
    // كتلة الـ subset المطلوب: التعليق التعريفي يسبق كل @font-face في CSS الحزمة
    const re = new RegExp(
      '/\\* ibm-plex-sans-arabic-' + subset + '-' + w + '-normal \\*/\\s*@font-face \\{[\\s\\S]*?\\}'
    );
    const m = css.match(re);
    if (!m) {
      console.error('vendor-fonts: لم يُعثر على كتلة ' + subset + '-' + w + ' في CSS الحزمة');
      process.exit(1);
    }
    const file = 'ibm-plex-sans-arabic-' + subset + '-' + w + '-normal.woff2';
    fs.copyFileSync(path.join(pkgDir, 'files', file), path.join(fontsDir, file));
    copied.push(file);
    // woff2 فقط + مسار نسبي داخل vendor (يغطيه font-src 'self' في CSP)
    const block = m[0].replace(
      /src: url\([^)]*\.woff2\) format\('woff2'\)[^;]*;/,
      "src: url(fonts/" + file + ") format('woff2');"
    );
    blocks.push(block);
  }
}

const header =
  '/* مولَّد آلياً عبر scripts/vendor-fonts.js — لا تحرّره يدوياً.\n' +
  '   المصدر: @fontsource/ibm-plex-sans-arabic@' + version + ' (رخصة OFL-1.1) */\n\n';
fs.writeFileSync(path.join(outDir, 'fonts.css'), header + blocks.join('\n\n') + '\n', 'utf8');

for (const f of copied) console.log('vendor-fonts: fonts/' + f);
console.log('vendor-fonts: fonts.css ← @fontsource/ibm-plex-sans-arabic@' + version);
