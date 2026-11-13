/**
 * تضمين خطَّي عناوين استوديو البرومو في src/vendor (قرار مالك 2026-11-13، الدفعة 10 من
 * docs/PROMO-DIRECTOR-PLAN.md): Cairo (خط عرض) وNoto Naskh Arabic (خط نسخي).
 *
 * نفس نمط scripts/vendor-fonts.js: ملفات woff2 تُنسخ من devDependency (‏@fontsource، رخصة OFL-1.1)
 * ويُولَّد src/vendor/fonts-promo.css، والناتج يُلتزَم في git. لا حزمة وقت تشغيل.
 * ملف مستقل عن fonts.css عمداً: fonts.css يُنسخ حرفياً إلى قشرة الهاتف (pwa/)، وخطوط الإعلانات
 * لا تلزمها.
 *
 * النطاق: مجموعتا subset عربي + لاتيني، الوزنان 500 (الترجمة على الشاشة) و700 (العناوين).
 *
 * يُشغَّل يدوياً عند ترقية إصدار الخط:
 *     node scripts/vendor-promo-fonts.js
 * جذر الحزم يُؤخذ من SATR_FONTSOURCE_ROOT إن وُجد (مجلد فيه cairo/ وnoto-naskh-arabic/)، وإلا
 * من node_modules/@fontsource.
 */
const fs = require('fs');
const path = require('path');

const sourceRoot = process.env.SATR_FONTSOURCE_ROOT
  ? path.resolve(process.env.SATR_FONTSOURCE_ROOT)
  : path.join(__dirname, '..', 'node_modules', '@fontsource');
const outDir = path.join(__dirname, '..', 'src', 'vendor');
const fontsDir = path.join(outDir, 'fonts');

const FAMILIES = [
  { pkg: 'cairo', license: 'OFL-Cairo.txt' },
  { pkg: 'noto-naskh-arabic', license: 'OFL-NotoNaskhArabic.txt' },
];
const WEIGHTS = [500, 700];
const SUBSETS = ['arabic', 'latin'];

fs.mkdirSync(fontsDir, { recursive: true });
const blocks = [];
const sources = [];
for (const family of FAMILIES) {
  const pkgDir = path.join(sourceRoot, family.pkg);
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  sources.push('@fontsource/' + family.pkg + '@' + version);
  for (const weight of WEIGHTS) {
    const css = fs.readFileSync(path.join(pkgDir, weight + '.css'), 'utf8');
    for (const subset of SUBSETS) {
      const name = family.pkg + '-' + subset + '-' + weight + '-normal';
      const match = css.match(new RegExp('/\\* ' + name + ' \\*/\\s*@font-face \\{[\\s\\S]*?\\}'));
      if (!match) {
        console.error('vendor-promo-fonts: لم يُعثر على كتلة ' + name + ' في CSS الحزمة');
        process.exit(1);
      }
      const file = name + '.woff2';
      fs.copyFileSync(path.join(pkgDir, 'files', file), path.join(fontsDir, file));
      // woff2 فقط + مسار نسبي داخل vendor (يغطيه font-src 'self' في CSP)
      blocks.push(match[0].replace(/src: url\([^)]*\.woff2\) format\('woff2'\)[^;]*;/, "src: url(fonts/" + file + ") format('woff2');"));
      console.log('vendor-promo-fonts: fonts/' + file);
    }
  }
  fs.copyFileSync(path.join(pkgDir, 'LICENSE'), path.join(fontsDir, family.license));
}

const header = '/* مولَّد آلياً عبر scripts/vendor-promo-fonts.js — لا تحرّره يدوياً.\n'
  + '   المصدر: ' + sources.join(' · ') + ' (رخصة OFL-1.1) */\n\n';
fs.writeFileSync(path.join(outDir, 'fonts-promo.css'), header + blocks.join('\n\n') + '\n', 'utf8');
console.log('vendor-promo-fonts: fonts-promo.css ← ' + sources.join(' · '));
