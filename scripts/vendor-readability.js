/**
 * تضمين (vendoring) قارئ المقالات في src/vendor للحقن في صفحة المعاينة — رادار ٠٠٣ محور A.
 *
 * **لماذا vendored لا تبعية npm**: القاعدة 5 في CLAUDE.md — الواجهة صفر اعتماديات وقت
 * تشغيل، والعملية الرئيسية تعتمد `claude-agent-sdk` و`node-pty` فقط باستثناءين موثّقين.
 * والملفّان هنا لا يُستدعيان من Node أصلاً: يُحقنان نصّاً في **صفحة المعاينة** عبر
 * `executeJavaScriptInIsolatedWorld`، فتبعية npm وقت التشغيل لا تعني شيئاً لهما.
 * نفس نمط `vendor-xterm.js` و`vendor-fonts.js`: المصدر devDependency، والناتج مُلتزَم.
 *
 * ما يُضمَّن ولماذا هذان الملفان بالذات:
 *  - `@mozilla/readability` → `Readability.js` **وحده**. لا `JSDOMParser.js` (‏37ك.ب):
 *    غرضه تحليل HTML في Node، ونحن نمرّر مستنداً حيّاً من متصفح حقيقي. ولا `index.js`
 *    (‏`require`) ولا `Readability-readerable.js` (لا نستعمل الكشف الاحتمالي).
 *  - `turndown` → `lib/turndown.browser.cjs.js`. بناء المتصفح تحديداً: تبعية
 *    `@mixmark-io/domino` (لبناء Node) **غائبة منه تماماً** — متحقَّق في هذا السكربت
 *    بأنه صفر `require(` وصفر ذكر لـdomino، وإلا فشل التوليد. فالناتج صفر تبعيات فعلاً
 *    لا ادّعاءً.
 *
 * الناتج `src/vendor/reader.js` **تعبير JavaScript واحد** يُقيَّم إلى
 * `{ Readability, TurndownService }` بلا تلويث `globalThis` في العالم المعزول: كل مكتبة
 * داخل نطاق دالة، وفرعا CommonJS/AMD فيهما محيَّدان بمتغيّرات محليّة.
 *
 * يُشغَّل يدوياً فقط عند ترقية إحدى المكتبتين:
 *     node scripts/vendor-readability.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const outDir = path.join(ROOT, 'src', 'vendor');
const OUT = path.join(outDir, 'reader.js');

function pkgDir(name) {
  return path.join(ROOT, 'node_modules', ...name.split('/'));
}
function version(name) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir(name), 'package.json'), 'utf8')).version;
}
function fail(message) {
  console.error('vendor-readability: ' + message);
  process.exit(1);
}

// حارس نقاء: بناء المتصفح يجب أن يكون مكتفياً بذاته. أي `require(` أو ذكر لـdomino يعني
// أننا نضمّن ملفاً يفترض بيئة Node — فيفشل التوليد بدل شحن ملف يتعطّل داخل الصفحة.
function readSelfContained(file, label, allowRequire) {
  const src = fs.readFileSync(file, 'utf8');
  if (!allowRequire && /\brequire\s*\(/.test(src)) fail(label + ' يستدعي require — ليس بناء متصفح');
  if (/domino/i.test(src)) fail(label + ' يذكر domino — استُعمل بناء Node بالخطأ');
  return src;
}

const readabilityVersion = version('@mozilla/readability');
const turndownVersion = version('turndown');

const readabilitySrc = readSelfContained(
  path.join(pkgDir('@mozilla/readability'), 'Readability.js'), 'Readability.js', false
);
const turndownSrc = readSelfContained(
  path.join(pkgDir('turndown'), 'lib', 'turndown.browser.cjs.js'), 'turndown.browser.cjs.js', false
);

// عقد التصدير: نتحقق من الشكل الذي نعتمد عليه في الغلاف بدل افتراضه.
if (!/^function Readability\(/m.test(readabilitySrc)) fail('Readability.js لا يعلن `function Readability(`');
if (!/module\.exports = TurndownService;\s*$/.test(turndownSrc)) fail('turndown لا ينتهي بـ module.exports');

const banner = [
  '/* مولَّد آلياً عبر scripts/vendor-readability.js — لا تحرّره يدوياً.',
  ' *',
  ' * يُقيَّم إلى { Readability, TurndownService } ويُحقن في صفحة المعاينة داخل عالم معزول.',
  ' *',
  ' * @mozilla/readability@' + readabilityVersion + ' — Readability.js',
  ' *   Copyright (c) 2010 Arc90 Inc — مرخّص بـ Apache License 2.0.',
  ' *   نسخة الرخصة: http://www.apache.org/licenses/LICENSE-2.0',
  ' *   التعديل الوحيد: لفّه في نطاق دالة وتحييد فرع CommonJS (لا تغيير في المنطق).',
  ' *',
  ' * turndown@' + turndownVersion + ' — lib/turndown.browser.cjs.js',
  ' *   Copyright (c) 2017 Dom Christie — مرخّص بـ MIT.',
  ' *   التعديل الوحيد: لفّه في نطاق دالة بـ module.exports محلي (لا تغيير في المنطق).',
  ' *',
  ' * الإسناد الكامل في ملف NOTICE بجذر المستودع.',
  ' */',
].join('\n');

// `var module, exports, define;` يحيّد فروع CommonJS/AMD داخل النطاق: `typeof module`
// يصير "undefined" فلا يُنفَّذ فرع التصدير ولا يُكتب شيء في globalThis.
const bundle = banner + '\n(function(){\n'
  + "'use strict';\n"
  + 'var __readability = (function(){\n'
  + 'var module, exports, define;\n'
  + readabilitySrc
  + '\nreturn Readability;\n})();\n'
  + 'var __turndown = (function(){\n'
  + 'var module = { exports: {} }, exports = module.exports, define;\n'
  + turndownSrc
  + '\nreturn module.exports;\n})();\n'
  + 'return { Readability: __readability, TurndownService: __turndown };\n'
  + '})()\n';

// فحص بنيوي أخير: الناتج تعبير صالح يُقيَّم إلى الكائن المتوقّع.
// eslint-disable-next-line no-new-func
const probe = new Function('return (' + bundle + ');')();
if (typeof probe.Readability !== 'function' || typeof probe.TurndownService !== 'function') {
  fail('الناتج لا يُقيَّم إلى { Readability, TurndownService }');
}
if (typeof globalThis.Readability !== 'undefined' || typeof globalThis.TurndownService !== 'undefined') {
  fail('الناتج لوّث globalThis — الغلاف لم يحيّد فرع التصدير');
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, bundle, 'utf8');

console.log('vendor-readability: src/vendor/reader.js ← @mozilla/readability@' + readabilityVersion
  + ' + turndown@' + turndownVersion + ' — ' + Buffer.byteLength(bundle, 'utf8') + ' بايت');
