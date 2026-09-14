#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس تطابق إصدار Claude Agent SDK (قطعي بلا شبكة).
 *
 * الدرس (‏OBS-137، قياس 2026-09-06): `package.json` كان يعلن `^0.3.261` والقفل يثبّت
 * `0.3.261` بينما `node_modules` عليه `0.3.176` فعلاً — أي أن `test:full` كله كان يقيس
 * إصداراً **لا يشحن**، وعقود SDK الخمسة في `docs/internals/` موصوفة بإصدارٍ غير المُعلَن.
 * الأخضر كان صحيح الإجراء كاذب المعنى. هذا الحارس يجعل الانحراف صريحاً قبل أي جسّ.
 *
 * ما يفحصه — أربعة أعمدة:
 *   ١. **القفل مقابل المثبَّت فعلاً**: `package-lock.json` و`node_modules/.../package.json`
 *      يتطابقان. (‏إن غاب `node_modules` — CI بلا تثبيت — يُعلَن التخطي سطراً ولا يُصبغ أحمر.)
 *   ٢. **النطاق المُعلَن مقابل المقفول**: النطاق يشمل المقفول، **و**أرضيّته تساويه بالضبط.
 *      الشرط الثاني هو لبّ `OBS-137`: `^0.3.261` يشمل `0.3.270` شكلاً، فالاكتفاء بالشمول
 *      يترك الوثيقة تعلن إصداراً غير الذي يشحن — وهي العلّة نفسها بثوب أخضر.
 *   ٣. **خط أساس الرادار**: `docs/radar/state.json` ← `baseline["claude-agent-sdk"]` يطابق
 *      القفل (حقل نملؤه نحن ويقرأه الرادار حقيقةً، فتقادمه يفسد كل مقارناته). ولا يُفحص
 *      `latest_seen` — فمعناه «آخر منشور upstream» لا «المثبَّت عندنا».
 *   ٤. **وثائق `docs/internals/`**: كل ذكر بالصيغة المُعلَنة `SDK المثبّت: x.y.z` يطابق القفل.
 *
 * ⚠️ **حدّ مُصرَّح به — الصيغة المفحوصة مُعلَنة لا مستنتَجة**: الملفات مليئة بأرقام
 * **تاريخية** («المسبار شُغّل على SDK `0.3.176`»، «إعادة تحقّق … SDK `0.3.261`») وهي سجلّ
 * قياس يجب أن يبقى كما هو — تحديثها تزوير للتاريخ. فالحارس **لا** يفحص كل `0.3.x` في
 * الوثائق، بل السلسلة الحرفية `SDK المثبّت:` وحدها. من أراد سطراً محروساً بإصدار اليوم
 * كتبه بهذه الصيغة؛ ومن كتب رقماً تاريخياً تركه بأي صيغة أخرى. الحارس لا يعرف أن سطراً
 * وصفياً فاتته صيغتُه — يحرس ما أُعلن محروساً لا اكتمال الإعلان.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_NAME = '@anthropic-ai/claude-agent-sdk';
const RADAR_KEY = 'claude-agent-sdk';
const INTERNALS = path.join(ROOT, 'docs', 'internals');

/** الصيغة المُعلَنة للحالة الراهنة في الوثائق — انظر الحدّ المصرَّح به في الرأس. */
const DECLARED_MARKER = 'SDK المثبّت:';
const DECLARED_RE = /SDK المثبّت:\s*`?(\d+\.\d+\.\d+)`?/g;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parse(version, what) {
  const m = SEMVER.exec(String(version).trim());
  assert(m, `${what}: «${version}» ليس إصداراً بصيغة x.y.z`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * مقارن نطاق صغير يغطي ما نستعمله فعلاً (`^` و`~` و`>=` والمساواة الحرفية).
 * أي صيغة أخرى تُسقط الحارس عمداً: توسيعه قرار واعٍ لا استنتاج صامت.
 */
function rangeBounds(range) {
  const raw = String(range).trim();
  const op = /^(\^|~|>=|=|v)?\s*(\d+\.\d+\.\d+)$/.exec(raw);
  assert(op, `صيغة نطاق غير مدعومة في package.json: «${raw}» — وسّع الحارس عمداً قبل استعمالها`);
  const base = parse(op[2], 'أرضية النطاق');
  const prefix = op[1] === 'v' ? '' : (op[1] || '');
  let upper = null; // حصري
  if (prefix === '^') {
    if (base[0] > 0) upper = [base[0] + 1, 0, 0];
    else if (base[1] > 0) upper = [0, base[1] + 1, 0];
    else upper = [0, 0, base[2] + 1];
  } else if (prefix === '~') {
    upper = [base[0], base[1] + 1, 0];
  } else if (prefix === '>=') {
    upper = null;
  } else {
    upper = [base[0], base[1], base[2] + 1];
  }
  return { base, upper };
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const lock = readJson(path.join(ROOT, 'package-lock.json'));

// ── ١. النطاق المُعلَن والمقفول ────────────────────────────────────────────────
const declaredRange = (pkg.dependencies || {})[PKG_NAME];
assert(typeof declaredRange === 'string' && declaredRange,
  `${PKG_NAME} غائب من dependencies في package.json — وهو اعتمادية العملية الرئيسية المعلنة في CLAUDE.md`);

const lockEntry = (lock.packages && lock.packages[`node_modules/${PKG_NAME}`])
  || (lock.dependencies && lock.dependencies[PKG_NAME]);
assert(lockEntry && lockEntry.version, `${PKG_NAME} غائب من package-lock.json — القفل هو ما يثبّته npm ci في CI`);
const locked = String(lockEntry.version);
const lockedParts = parse(locked, 'الإصدار المقفول');

const { base, upper } = rangeBounds(declaredRange);
// الشمول أولاً (الشرط الأضعف): مع صيغ النطاق المدعومة اليوم تُغنيه مساواةُ الأرضية بعده،
// وهو مُبقًى عمداً لأنه الشرط الصحيح إن اتّسعت الصيغ لاحقاً (مدى بحدّين، `||`، …).
assert(cmp(lockedParts, base) >= 0 && (upper === null || cmp(lockedParts, upper) < 0),
  `النطاق المُعلَن «${declaredRange}» لا يشمل المقفول «${locked}» — القفل يثبّت ما لا تسمح به الحزمة`);
assert.strictEqual(cmp(base, lockedParts), 0,
  `أرضية النطاق في package.json (${declaredRange}) لا تساوي المقفول (${locked}) — ` +
  'هذه علّة OBS-137 نفسها: الوثيقة تعلن إصداراً والمشحون آخر. اضبط النطاق على ' +
  `«^${locked}» في التزام الترقية نفسه (لا تلمس القفل وحده).`);

// ── ٢. المثبَّت فعلاً في node_modules ──────────────────────────────────────────
const installedFile = path.join(ROOT, 'node_modules', PKG_NAME, 'package.json');
let installed = null;
if (fs.existsSync(installedFile)) {
  installed = String(readJson(installedFile).version);
  assert.strictEqual(installed, locked,
    `المثبَّت في node_modules (${installed}) يخالف القفل (${locked}) — ` +
    'كل اختبار ومسبار يقيس الآن إصداراً لا يشحن (OBS-137). أعد التثبيت قبل أي جسّ.');
}

// ── ٣. خط أساس الرادار ────────────────────────────────────────────────────────
const state = readJson(path.join(ROOT, 'docs', 'radar', 'state.json'));
const radarBaseline = (state.baseline || {})[RADAR_KEY];
if (radarBaseline !== undefined && radarBaseline !== null) {
  assert.strictEqual(String(radarBaseline), locked,
    `docs/radar/state.json ← baseline["${RADAR_KEY}"] = ${radarBaseline} لا يطابق القفل (${locked}) — ` +
    'الرادار يقارن بهذا الرقم، فتقادمه يجعل كل مقارناته خاطئة.');
}

// ── ٤. وثائق docs/internals/ بالصيغة المُعلَنة ─────────────────────────────────
const docHits = [];
for (const name of fs.readdirSync(INTERNALS)) {
  if (!name.endsWith('.md')) continue;
  const file = path.join(INTERNALS, name);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    DECLARED_RE.lastIndex = 0;
    let match;
    while ((match = DECLARED_RE.exec(line)) !== null) {
      docHits.push({ file: `docs/internals/${name}`, line: index + 1, version: match[1] });
    }
  });
}
const docDrift = docHits.filter((hit) => hit.version !== locked);
assert.deepStrictEqual(docDrift, [],
  `وثيقة تعلن «${DECLARED_MARKER} …» بإصدار غير المقفول (${locked}): ` +
  `${docDrift.map((h) => `${h.file}:${h.line} ← ${h.version}`).join(' · ')} — ` +
  'حدّثها في التزام الترقية نفسه (الأرقام التاريخية لا تُمسّ، فهي سجلّ قياس).');

console.log(
  `sdk-version-parity: نجح — القفل ${locked}؛ النطاق ${declaredRange} أرضيّته تساويه؛ ` +
  `المثبَّت ${installed === null ? 'غير موجود (node_modules غائب — تُخطّى المقارنة معلنةً)' : installed}؛ ` +
  `baseline["${RADAR_KEY}"]=${radarBaseline === undefined ? 'غائب' : radarBaseline}؛ ` +
  `و${docHits.length} سطراً بصيغة «${DECLARED_MARKER}» في docs/internals/ كلها مطابقة.`
);
