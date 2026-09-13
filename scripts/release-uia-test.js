#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس ساكن: **مثبّت الإصدار يحمل المعين `satr-uia`** (‏OBS-161).
 *
 * الدرس المقيس: `package.json → build.extraResources` يشير إلى
 * `native/satr-uia/out-aot`، و**electron-builder يتخطّى المصدر الغائب صامتاً**.
 * وكان المعين يُبنى في `uia-helper.yml` وحده (مسار مستقل لا يمسّ الإصدار)، فخرج
 * مثبّت 2.16.22 بلا معين وزرّ «سطح ويندوز» ميتاً بلا أي أحمر في أي بوابة.
 *
 * فالحارس يثبت أن سلسلة الشحن ما زالت قائمة في **النصّ** قبل أن يُقطع وسمٌ:
 *   ١. وظائف `release.yml` الثلاث (‏`verify` · `tests` · `release`) لم تتغيّر أسماؤها —
 *      فهي معرّفات الفحوص المطلوبة في حماية الفرع، وتغييرها يفكّ البوابة صامتاً.
 *   ٢. وظيفة `release` تحوي الخطوات الأربع **بهذا الترتيب**: إعداد .NET ⇐ نشر المعين
 *      NativeAOT ⇐ التحقق قبل التعبئة ⇐ `npm run dist` ⇐ التحقق داخل النسخة المبنية.
 *      (النشر قبل البناء وإلا لا شيء يُنسخ؛ والتحقق بعده وإلا يقيس النيّة لا الناتج.)
 *   ٣. خطوة النشر بلا `continue-on-error` — احتمال السقوط هناك يعني مثبّتاً ناقصاً.
 *   ٤. مسار خرج `dotnet publish` يساوي `from` في `extraResources` حرفاً بحرف: زحفُ
 *      أحدهما وحده يعيد العطل نفسه بصمت.
 *   ٥. `filter` ما زال يضمّ `satr-uia.exe`، وخطوة التحقق بعد البناء تفحص المسار الذي
 *      ينسخ إليه electron-builder فعلاً (‏`resources/<to>/`).
 *
 * ⚠️ **حدّان مُصرَّح بهما**: القراءة **نصّية لا YAML** (صفر اعتماديات — قاعدة ٥)، فهي
 * تحرس وجود الخطوات وترتيبها لا صحّة الصياغة كاملةً؛ وهي تحرس **الملف** لا التشغيل:
 * أن `dotnet publish` ينجح فعلاً على العدّاء يثبته أول إصدار بعد الدمج، لا هذا الحارس.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

// أسماء الوظائف الثلاث — معرّفات الفحوص المطلوبة في حماية الفرع (‏OBS-117).
const JOB_NAMES = ['verify', 'tests', 'release'];

// الخطوات المطلوبة داخل `release` بترتيبها الملزم.
const ORDERED = [
  // ⚠️ `\b` في JS حدٌّ **آسكيّ**: بعد حرف عربي لا يقع حدّ أبداً، فنمطٌ ينتهي بـ`\b`
  // لا يطابق اسم خطوة عربياً (وقع فعلاً أثناء بناء الحارس). الإرساء بنهاية السطر.
  { label: 'إعداد .NET 10', re: /-\s*name:\s*إعداد \.NET 10\s*$/m },
  { label: 'نشر المعين NativeAOT', re: /-\s*name:\s*نشر المعين NativeAOT\s*$/m },
  { label: 'التحقق من المعين قبل التعبئة', re: /-\s*name:\s*التحقق من المعين قبل التعبئة\s*$/m },
  { label: 'بناء الأصول (‏npm run dist)', re: /\bnpm run dist\b/ },
  { label: 'التحقق من المعين داخل النسخة المبنية', re: /-\s*name:\s*التحقق من المعين داخل النسخة المبنية\s*$/m },
];

const PUBLISH_OUT = /dotnet publish\s+native\/satr-uia\b[^\n]*?-o\s+(\S+)/;
const HELPER_EXE = 'satr-uia.exe';

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

function main() {
  assert.ok(fs.existsSync(WORKFLOW), `لم يُعثر على ${WORKFLOW}`);
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));

  // ---------- ١. أسماء الوظائف ----------
  const declared = (yaml.split(/\r?\n/)
    .filter((line) => /^ {2}[A-Za-z_][\w-]*:\s*$/.test(line))
    .map((line) => line.trim().replace(/:$/, '')));
  for (const name of JOB_NAMES) {
    must(declared.includes(name),
      `غابت وظيفة «${name}» من release.yml — أسماء الوظائف الثلاث (${JOB_NAMES.join(' · ')}) `
      + 'معرّفات الفحوص المطلوبة في حماية الفرع، وتغييرها يفكّ البوابة صامتاً.');
  }

  const release = jobBlock(yaml, 'release');
  if (!must(release, 'تعذّر اقتطاع كتلة وظيفة «release» من release.yml')) return report();

  // ---------- ٢. الخطوات الأربع وترتيبها ----------
  const positions = [];
  for (const step of ORDERED) {
    const match = step.re.exec(release);
    if (!must(match, `غابت خطوة «${step.label}» من وظيفة release في release.yml — `
      + 'بدونها يخرج المثبّت بلا معين satr-uia وelectron-builder يتخطّى المصدر الغائب صامتاً (OBS-161).')) {
      positions.push(null);
      continue;
    }
    positions.push(match.index);
  }
  for (let i = 1; i < ORDERED.length; i++) {
    if (positions[i] === null || positions[i - 1] === null) continue;
    must(positions[i] > positions[i - 1],
      `ترتيب خاطئ في وظيفة release: «${ORDERED[i].label}» تسبق «${ORDERED[i - 1].label}» — `
      + 'الترتيب الملزم: ' + ORDERED.map((s) => s.label).join(' ⇐ ')
      + ' (النشر قبل البناء وإلا لا شيء يُنسخ، والتحقق بعده وإلا يقيس النيّة لا الناتج).');
  }

  // ---------- ٣. النشر بلا continue-on-error ----------
  if (positions[1] !== null && positions[2] !== null && positions[2] > positions[1]) {
    const publishStep = release.slice(positions[1], positions[2]);
    must(!/continue-on-error/.test(publishStep),
      'خطوة «نشر المعين NativeAOT» في release.yml تحمل continue-on-error — '
      + 'سقوط النشر عندها يمرّ صامتاً فيخرج مثبّت بلا معين (OBS-161).');
  }

  // ---------- ٤. مسار الخرج = from في extraResources ----------
  const publishMatch = PUBLISH_OUT.exec(release);
  must(publishMatch, 'لم يُعثر على أمر `dotnet publish native/satr-uia … -o <مسار>` في وظيفة release.');
  const publishOut = publishMatch ? publishMatch[1].replace(/\\/g, '/').replace(/\/+$/, '') : null;
  if (publishOut) {
    must(publishOut === 'native/satr-uia/out-aot',
      `مسار خرج dotnet publish في release.yml هو «${publishOut}» لا «native/satr-uia/out-aot» — `
      + '‏out يحمل ناتج JIT (مشغّل + dll) فحزمه يشحن معيناً لا يعمل (المواصفة §١٠ الصفّ ١).');
  }

  const extra = (pkg.build && Array.isArray(pkg.build.extraResources)) ? pkg.build.extraResources : [];
  const entry = extra.find((item) => item && typeof item.from === 'string'
    && item.from.replace(/\\/g, '/').replace(/\/+$/, '') === publishOut);
  const froms = extra.map((item) => (item && item.from) || '(بلا from)').join(' · ') || '(لا مدخلات)';
  must(entry,
    `‏package.json → build.extraResources لا يحوي مدخلاً from يساوي مسار نشر release.yml: `
    + `المُعلن «${froms}» بينما الإصدار ينشر إلى «${publishOut}» — زحف أحد المسارين وحده `
    + 'يعيد عطل OBS-161: electron-builder يتخطّى المصدر الغائب صامتاً فيخرج مثبّت بلا معين.');

  // ---------- ٥. filter ومسار الناتج المفحوص ----------
  if (entry) {
    const filter = Array.isArray(entry.filter) ? entry.filter : [];
    must(filter.includes(HELPER_EXE),
      `‏extraResources.filter لا يضمّ «${HELPER_EXE}» (المُعلن: ${filter.join(' · ') || 'فارغ'}).`);
    const to = String(entry.to || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    must(to, '‏extraResources بلا `to` — يحدّد مجلد المعين داخل resources/.');
    if (to) {
      const expected = `dist/win-unpacked/resources/${to}/${HELPER_EXE}`;
      must(release.includes(expected),
        `خطوة «التحقق من المعين داخل النسخة المبنية» لا تفحص المسار الذي ينسخ إليه `
        + `electron-builder فعلاً: المنتظَر «${expected}» (‏extraResources.to = «${to}»).`);
    }
  }

  return report();
}

function report() {
  if (problems.length) {
    console.error('');
    for (const problem of problems) console.error('✗ ' + problem);
    throw new Error(`release-uia: ${problems.length} مخالفة من ${checks} فحصاً`);
  }
  console.log(`release-uia: نجح — ${checks} فحصاً: وظائف release.yml الثلاث كما هي، `
    + 'وخطوات بناء المعين والتحقق منه قائمة بترتيبها، ومسار out-aot متطابق مع extraResources.');
}

try { main(); } catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
}
