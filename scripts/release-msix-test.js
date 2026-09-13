#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس ساكن: **بوابة الإصدار تبني حزمة Microsoft Store وترفعها** (دفعة 2026-09-13).
 *
 * الدرس الذي يحرسه: حزمة MSIX كانت تُبنى **بيد المالك** بـ`npm run dist:appx` ثم تُرفع
 * إلى Partner Center يدوياً. فكل إصدار يخرج بمثبّت NSIS محدَّث وحزمة متجر متأخّرة بلا
 * أي أحمر — وهو نمط `OBS-161` نفسه: خطوة شحن قائمة على التذكّر لا على آليّة.
 *
 * والحزمة **تُبنى بعد نشر المعين `satr-uia` والتحقق منه** لا قبله: `extraResources`
 * يُنسخ في كل هدف، فبناؤها أولاً يشحن حزمة متجر بلا سطح ويندوز — وelectron-builder
 * يتخطّى المصدر الغائب صامتاً.
 *
 * ما يعضّ عليه:
 *   ١. أسماء الوظائف الثلاث (‏`verify` · `tests` · `release`) لم تتغيّر — معرّفات
 *      الفحوص المطلوبة في حماية الفرع، وتغييرها يفكّ البوابة صامتاً (‏OBS-117).
 *      ولهذا بقي المساران في وظيفة `release` نفسها ولم تُفتح وظيفة رابعة.
 *   ٢. خطوة `npm run dist:appx` موجودة داخل `release` و**بعد** خطوتَي المعين.
 *   ٣. اسم الأصل ثابت `Satr-Store-<version>.appx`، ويُرفع بـ`gh release upload --clobber`.
 *   ٤. خطوة «التحقق من أصول التحديث» تفحص `.appx` كما تفحص exe وlatest.yml.
 *   ٥. ملاحظات الإصدار تقول إن الحزمة للرفع إلى Partner Center لا للتثبيت المباشر.
 *   ٦. `workflow_dispatch` بمدخل `msix_only` موجود، ووظيفة `release` تعمل عليه،
 *      ويُرفع artifact بدل إصدار GitHub، وخطوات مسار الوسم مشروطة صراحةً.
 *   ٧. **لا اسم خطوة يحوي «: »** — يُسقط `workflow_dispatch` من واجهة Actions صامتاً.
 *   ٨. `build/appx/` يحوي الملفات الستة التي يكتبها `scripts/make-icon.js --appx`
 *      (الأسماء تُقرأ من المصدر لا تُنسخ هنا) — غيابها يشحن شعارات `SampleAppx`.
 *
 * ⚠️ **حدّان مُصرَّح بهما**: القراءة **نصّية لا YAML** (صفر اعتماديات — قاعدة ٥)، فهي
 * تحرس وجود الخطوات وترتيبها لا صحّة الصياغة كاملةً؛ وهي تحرس **الملف** لا التشغيل:
 * أن `dist:appx` ينجح على العدّاء وأن `makeappx` يأتي من كاش `winCodeSign` يثبته أول
 * تشغيل بعد الدمج، لا هذا الحارس. والرفع إلى Partner Center يبقى يدوياً في هذه الدفعة.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const MAKE_ICON = path.join(ROOT, 'scripts', 'make-icon.js');
const APPX_DIR = path.join(ROOT, 'build', 'appx');

// أسماء الوظائف الثلاث — معرّفات الفحوص المطلوبة في حماية الفرع (‏OBS-117).
const JOB_NAMES = ['verify', 'tests', 'release'];
const ASSET_PREFIX = 'Satr-Store-';

// خطوات لا معنى لها إلا مع وسم — بلا شرط صريح تسقط على `gh release` في التشغيل اليدوي.
const TAG_ONLY_STEPS = [
  'إنشاء ورفع نسخة ZIP من المثبّت',
  'التحقق من أصول التحديث',
  'نشر إصدار GitHub مع بصمة المثبّت',
  'رفع حزمة المتجر إلى الإصدار',
];

let checks = 0;
const problems = [];
function must(condition, message) {
  checks += 1;
  if (!condition) problems.push(message);
  return !!condition;
}

/** يقتطع كتلة وظيفة من نصّ مسار العمل (مسافتان بادئتان لاسم الوظيفة). */
function jobBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z_][\w-]*:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** يقتطع كتلة `on:` من رأس الملف (حتى أول مفتاح جذري تالٍ). */
function onBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * يقتطع كتلة خطوة باسمها العربي حتى بداية الخطوة التالية.
 *
 * ⚠️ بلا وسم `m` عمداً: مع `m` يصير `$` نهايةَ **سطر** لا نهاية النصّ، فالتكرار الكسول
 * `[\s\S]*?` يتوقف عند أول سطر وتعود الكتلة سطرَ الاسم وحده — فيمرّ كل فحص محتوى
 * صامتاً (وقع فعلاً في أول تشغيل لهذا الحارس). الإرساء بسطر جديد بعد الاسم.
 */
function stepBlock(job, name) {
  const re = new RegExp(`-\\s*name:\\s*${name}[ \\t]*\\r?\\n[\\s\\S]*?(?=\\n {6}- name:|$)`);
  const match = re.exec(job);
  return match ? match[0] : null;
}

function main() {
  assert.ok(fs.existsSync(WORKFLOW), `لم يُعثر على ${WORKFLOW}`);
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');

  // ---------- ١. أسماء الوظائف الثلاث ----------
  // ⚠️ المسح يبدأ من سطر `jobs:` لا من رأس الملف: مفاتيح `on:` (‏`push` · `pull_request`
  // · `workflow_dispatch`) تقع على المسافة البادئة نفسها فتُعدّ وظائف زوراً.
  const jobsStart = yaml.split(/\r?\n/).findIndex((line) => /^jobs:\s*$/.test(line));
  must(jobsStart >= 0, 'لم يُعثر على مفتاح `jobs:` في release.yml.');
  const declared = yaml.split(/\r?\n/).slice(jobsStart + 1)
    .filter((line) => /^ {2}[A-Za-z_][\w-]*:\s*$/.test(line))
    .map((line) => line.trim().replace(/:$/, ''));
  for (const name of JOB_NAMES) {
    must(declared.includes(name),
      `غابت وظيفة «${name}» من release.yml — أسماء الوظائف الثلاث (${JOB_NAMES.join(' · ')}) `
      + 'معرّفات الفحوص المطلوبة في حماية الفرع، وتغييرها يفكّ البوابة صامتاً (OBS-117).');
  }
  must(declared.length === JOB_NAMES.length,
    `‏release.yml يعلن ${declared.length} وظيفة (${declared.join(' · ')}) لا ${JOB_NAMES.length} — `
    + 'الوظيفة الرابعة تبقى اختيارية في حماية الفرع حتى تُعلَّم مطلوبة يدوياً، '
    + 'فمسار MSIX يعيش داخل «release» نفسها (OBS-117).');

  const release = jobBlock(yaml, 'release');
  if (!must(release, 'تعذّر اقتطاع كتلة وظيفة «release» من release.yml')) return report();

  // ---------- ٢. dist:appx بعد خطوتَي المعين ----------
  const posPrePack = release.search(/-\s*name:\s*التحقق من المعين قبل التعبئة\s*$/m);
  const posPostBuild = release.search(/-\s*name:\s*التحقق من المعين داخل النسخة المبنية\s*$/m);
  const posAppx = release.search(/\bnpm run dist:appx(\s|$)/m);
  must(posPrePack >= 0, 'غابت خطوة «التحقق من المعين قبل التعبئة» من وظيفة release (OBS-161).');
  must(posPostBuild >= 0, 'غابت خطوة «التحقق من المعين داخل النسخة المبنية» من وظيفة release (OBS-161).');
  must(posAppx >= 0,
    'غاب أمر `npm run dist:appx` من وظيفة release — حزمة المتجر تعود إلى البناء اليدوي '
    + 'فتتأخّر عن كل إصدار بلا أي أحمر.');
  if (posAppx >= 0 && posPrePack >= 0) {
    must(posAppx > posPrePack,
      'أمر `npm run dist:appx` يسبق «التحقق من المعين قبل التعبئة» في release.yml — '
      + 'بناء الحزمة قبل نشر المعين يشحن حزمة متجر بلا satr-uia، وelectron-builder '
      + 'يتخطّى المصدر الغائب صامتاً (OBS-161).');
  }
  if (posAppx >= 0 && posPostBuild >= 0) {
    must(posAppx > posPostBuild,
      'أمر `npm run dist:appx` يسبق «التحقق من المعين داخل النسخة المبنية» — الترتيب الملزم: '
      + 'نشر المعين ⇐ التحقق قبل التعبئة ⇐ npm run dist ⇐ التحقق داخل النسخة المبنية ⇐ dist:appx.');
  }

  // ---------- ٣. اسم الأصل الثابت ورفعه ----------
  must(release.includes(`"${ASSET_PREFIX}$version.appx"`),
    `لم يُبنَ اسم الأصل الثابت «${ASSET_PREFIX}$version.appx» في وظيفة release — `
    + 'اسم electron-builder الافتراضي يحمل فراغات فيتغيّر شكله بعد الرفع.');
  const uploadStep = stepBlock(release, 'رفع حزمة المتجر إلى الإصدار');
  if (must(uploadStep, 'غابت خطوة «رفع حزمة المتجر إلى الإصدار» من وظيفة release.')) {
    must(/gh release upload[^\n]*--clobber/.test(uploadStep),
      'خطوة رفع حزمة المتجر بلا `gh release upload … --clobber` — '
      + 'بلا --clobber يفشل الرفع على وسم أُعيد قطعه.');
    must(uploadStep.includes(ASSET_PREFIX),
      `خطوة رفع حزمة المتجر لا تذكر البادئة «${ASSET_PREFIX}».`);
  }

  // ---------- ٤. فحص الأصول يشمل appx ----------
  const assetsStep = stepBlock(release, 'التحقق من أصول التحديث');
  if (must(assetsStep, 'غابت خطوة «التحقق من أصول التحديث» من وظيفة release.')) {
    must(/\.appx/.test(assetsStep),
      'خطوة «التحقق من أصول التحديث» لا تفحص وجود أصل `.appx` — فحزمة متجر لم تُرفع '
      + 'تمرّ صامتة ويخرج الإصدار ناقصاً.');
    must(assetsStep.includes(ASSET_PREFIX),
      `خطوة «التحقق من أصول التحديث» لا تطابق البادئة «${ASSET_PREFIX}» — `
      + 'اسم عشوائي من electron-builder يمرّ كأنه الأصل المقصود.');
  }

  // ---------- ٥. ملاحظات الإصدار تشرح أن الحزمة للرفع لا للتثبيت ----------
  const notesStep = stepBlock(release, 'نشر إصدار GitHub مع بصمة المثبّت');
  if (must(notesStep, 'غابت خطوة «نشر إصدار GitHub مع بصمة المثبّت» من وظيفة release.')) {
    must(/Partner Center/.test(notesStep) && /غير موقّعة/.test(notesStep),
      'ملاحظات الإصدار لا تشرح أن حزمة MSIX **غير موقّعة** وأنها للرفع إلى Partner Center '
      + 'لا للتثبيت المباشر — فمستخدم يحمّلها يصطدم بفشل تثبيت بلا تفسير.');
  }

  // ---------- ٦. مسار التجربة بلا وسم ----------
  const on = onBlock(yaml);
  if (must(on, 'تعذّر اقتطاع كتلة «on» من release.yml')) {
    must(/^ {2}workflow_dispatch:\s*$/m.test(on),
      'غاب `workflow_dispatch` من release.yml — فلا سبيل لتجربة بناء حزمة المتجر بلا قطع وسم.');
    must(/^ {6}msix_only:\s*$/m.test(on),
      'غاب المدخل `msix_only` من `workflow_dispatch.inputs` في release.yml.');
    must(/type:\s*boolean/.test(on) && /default:\s*false/.test(on),
      'المدخل `msix_only` ليس منطقياً بافتراضي false — الافتراضي true يحوّل كل تشغيل يدوي '
      + 'إلى بناء ناقص بلا مثبّت.');
  }
  must(/if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*\|\|\s*github\.event_name\s*==\s*'workflow_dispatch'/
    .test(release),
    'شرط وظيفة release لا يسمح بالتشغيل اليدوي — `workflow_dispatch` يُعلَن ولا يفعل شيئاً.');
  must(/uses:\s*actions\/upload-artifact@v\d+/.test(release),
    'غاب `actions/upload-artifact` من وظيفة release — مسار التجربة بلا وسم لا مخرج له.');
  const artifactStep = stepBlock(release, 'رفع حزمة المتجر artifact');
  if (must(artifactStep, 'غابت خطوة «رفع حزمة المتجر artifact» من وظيفة release.')) {
    must(/github\.event_name\s*==\s*'workflow_dispatch'/.test(artifactStep),
      'خطوة رفع الـartifact غير مشروطة بـ`workflow_dispatch` — ترفع نسخة مكرّرة في كل إصدار وسم.');
    must(artifactStep.includes(ASSET_PREFIX),
      `مسار الـartifact لا يذكر البادئة «${ASSET_PREFIX}».`);
  }
  // ‏`msix_only` يجب أن يتخطّى مثبّت NSIS فعلاً لا اسماً.
  must(/if:\s*\$\{\{\s*!inputs\.msix_only\s*\}\}/.test(release),
    'لا خطوة مشروطة بـ`!inputs.msix_only` في وظيفة release — المدخل معلَن بلا أثر، '
    + 'فالتشغيل اليدوي يبني مثبّت NSIS كاملاً رغم طلب حزمة المتجر وحدها.');
  for (const name of TAG_ONLY_STEPS) {
    const step = stepBlock(release, name);
    must(step && /github\.event_name\s*!=\s*'workflow_dispatch'/.test(step),
      `خطوة «${name}» بلا شرط يستثني التشغيل اليدوي — لا وسم هناك، فتسقط على gh release.`);
  }

  // ---------- ٧. لا «: » في اسم خطوة ----------
  for (const line of yaml.split(/\r?\n/)) {
    const match = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    checks += 1;
    if (/:\s/.test(match[1])) {
      problems.push(`اسم الخطوة «${match[1]}» يحوي «: » — يُسقط workflow_dispatch من واجهة `
        + 'Actions صامتاً (درس مقيس). اقتبس الاسم أو أعد صياغته.');
    }
  }

  // ---------- ٨. شعارات build/appx الستة ----------
  const iconSource = fs.readFileSync(MAKE_ICON, 'utf8');
  const assetsBlock = /const APPX_ASSETS = \[([\s\S]*?)\];/.exec(iconSource);
  if (must(assetsBlock, 'تعذّر قراءة APPX_ASSETS من scripts/make-icon.js — هل تغيّر شكل التعريف؟')) {
    const names = [...assetsBlock[1].matchAll(/'([^']+\.png)'/g)].map((m) => m[1]);
    must(names.length === 6,
      `‏APPX_ASSETS في make-icon.js يعلن ${names.length} شعاراً لا ستة — راجع الدفعة قبل تعديل الحارس.`);
    for (const name of names) {
      must(fs.existsSync(path.join(APPX_DIR, name)),
        `غاب الشعار build/appx/${name} — بغيابه يشحن electron-builder شعارات SampleAppx `
        + 'الافتراضية في حزمة المتجر (شغّل `node scripts/make-icon.js --appx`).');
    }
  }

  return report();
}

function report() {
  if (problems.length) {
    console.error('');
    for (const problem of problems) console.error('✗ ' + problem);
    throw new Error(`release-msix: ${problems.length} مخالفة من ${checks} فحصاً`);
  }
  console.log(`release-msix: نجح — ${checks} فحصاً: وظائف release.yml الثلاث كما هي، `
    + 'وdist:appx بعد التحقق من المعين، والأصل Satr-Store-*.appx يُرفع ويُفحص، '
    + 'وworkflow_dispatch/msix_only يعطي مسار تجربة بلا وسم، وشعارات build/appx الستة قائمة.');
}

try { main(); } catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
}
