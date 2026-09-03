#!/usr/bin/env node
/**
 * سطر — حارس تغطية الطقم: **لا اختبار يتيماً**.
 *
 * الدرس (OBS-011 ثم تكراره بلا ملاحظة): سكربت `test:*` يُسجَّل في `package.json`
 * ثم لا يُضاف إلى `SUITE` في `full-suite.js`، فيصير «يُشغَّل بالتذكّر» — وما يُشغَّل
 * بالتذكّر لا يُشغَّل. هكذا بقيت `test:qr` و`test:promocapture-batch1`
 * و`test:promostudio-batch1` — قطعية نقية بلا شبكة — خارج البوابة بلا أن ينتبه أحد.
 *
 * العقد: كل سكربت باسم `test:`/`eval:`/`audit:` إمّا:
 *   (أ) **يصله الطقم** — مباشرةً من `SUITE`، أو عبر طقم فرعي (`*-suite.js`
 *       كـ`opsroom-suite`/`mobile-suite`)، أو عبر سكربت مركّب `npm run X && npm run Y`
 *       (كـ`test:testsprite-ready`)؛ وإمّا
 *   (ب) **مذكور بسببه** في `EXCLUDED_FROM_SUITE` داخل `full-suite.js`.
 *
 * وظيفة الحارس منع اليُتم **المستقبلي** لا حشر كل شيء في الطقم: المسبار الحيّ الذي
 * يستهلك أدواراً بكلفة فعلية مكانه القائمة (ب) — لكن بسطر يقول لماذا.
 *
 * ⚠️ **حدّ مُصرَّح به**: الطقم الفرعي يُقرأ نصّياً (أسماء `'test:…'` الحرفية في ملفه)
 * لأنه ينفّذ فور الاستيراد ولا يصدّر قائمته. فاسم مذكور في تعليق داخله يُحسب
 * «يصله الطقم». هذا يخطئ نحو التساهل لا نحو الأخضر الكاذب في الاتجاه الخطر — لكنه
 * ليس صفراً، فلا تذكر أسماء سكربتات في تعليقات الأطقم الفرعية إلا وهي تُشغَّل فعلاً.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const SCRIPT_NAME = /^(test|eval|audit):/;
const SCRIPT_LITERAL = /['"]((?:test|eval|audit):[\w:.-]+)['"]/g;
const NPM_RUN = /\bnpm\s+run\s+((?:test|eval|audit):[\w:.-]+)/g;
const SUB_SUITE_FILE = /\bscripts\/([\w.-]+-suite\.js)\b/;
const ARABIC = /[؀-ۿ]/;

const suite = require('./full-suite');

let checks = 0;
const failures = [];

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

/** أسماء السكربتات الحرفية داخل ملف طقم فرعي — انظر حدّ الحارس في الرأس. */
function scriptsNamedIn(file) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(SCRIPT_LITERAL)) names.add(match[1]);
  return names;
}

/**
 * يوسّع مجموعة البذور حتى الثبات: كل اسم يصله الطقم يُفحص أمره في `package.json`،
 * فإن استدعى `npm run X` أُضيف X، وإن شغّل `scripts/*-suite.js` أُضيف ما يسمّيه ذاك الملف.
 */
function reachableFrom(seeds, scripts) {
  const reachable = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    for (const match of command.matchAll(NPM_RUN)) queue.push(match[1]);
    const sub = command.match(SUB_SUITE_FILE);
    if (sub) {
      const file = path.join(ROOT, 'scripts', sub[1]);
      if (fs.existsSync(file)) for (const child of scriptsNamedIn(file)) queue.push(child);
    }
  }
  return reachable;
}

function run() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const scripts = pkg.scripts || {};
  const { SUITE, EXCLUDED_FROM_SUITE } = suite;

  // ── 1) شكل القائمتين: بلا تكرار، وكل اسم موجود فعلاً في package.json ──
  assert(Array.isArray(SUITE) && SUITE.length > 0, 'SUITE مصدَّرة وغير فارغة');
  assert(Array.isArray(EXCLUDED_FROM_SUITE), 'EXCLUDED_FROM_SUITE مصدَّرة كمصفوفة');
  check(new Set(SUITE).size === SUITE.length, 'SUITE بلا اسم مكرّر');
  for (const name of SUITE) {
    check(typeof scripts[name] === 'string', `SUITE تذكر «${name}» وهو غير موجود في package.json`);
  }

  const excludedNames = new Set();
  for (const item of EXCLUDED_FROM_SUITE) {
    const valid = item && typeof item.name === 'string' && typeof item.reason === 'string';
    check(valid, 'كل قيد في EXCLUDED_FROM_SUITE كائن { name, reason }');
    if (!valid) continue;
    check(!excludedNames.has(item.name), `EXCLUDED_FROM_SUITE تكرّر «${item.name}»`);
    excludedNames.add(item.name);
    // السبب هو الفرق بين «استبعاد معلن» و«يُتم بغطاء» — فارغ أو غير عربي = لا سبب
    check(item.reason.trim().length >= 10 && ARABIC.test(item.reason),
      `سبب استبعاد «${item.name}» فارغ أو ليس بالعربية`);
    check(typeof scripts[item.name] === 'string',
      `EXCLUDED_FROM_SUITE تذكر «${item.name}» وهو لم يعد في package.json — قيد بائت يُحذف`);
  }

  // ── 2) الوصول: من SUITE عبر الأطقم الفرعية والسكربتات المركّبة ──
  const reachable = reachableFrom(SUITE, scripts);
  // شرط سلامة للتوسيع نفسه: الأطقم الفرعية المعروفة يجب أن تُقرأ فعلاً، وإلا
  // فالحارس يفحص فراغاً — «الأخضر الكاذب» بعينه
  check(reachable.has('test:opsroom') && reachable.has('test:mobile-crypto'),
    'التوسيع يقرأ opsroom-suite.js وmobile-suite.js فعلاً');
  check(reachable.has('test:testsprite'), 'التوسيع يتبع npm run داخل السكربتات المركّبة');

  // قيد في القائمة (ب) صار يصله الطقم = قيد بائت يُضلّل القارئ، فيُرفض
  for (const name of excludedNames) {
    check(!reachable.has(name), `«${name}» مستبعد ومع ذلك يصله الطقم — احذفه من EXCLUDED_FROM_SUITE`);
  }

  // ── 3) العقد نفسه: لا يتيم ──
  const orphans = Object.keys(scripts)
    .filter((name) => SCRIPT_NAME.test(name) && !reachable.has(name) && !excludedNames.has(name));
  for (const name of orphans) {
    check(false, `«${name}» يتيم: لا يصله الطقم ولا هو في EXCLUDED_FROM_SUITE بسبب — أضفه لأحدهما`);
  }

  return { reachable: reachable.size, excluded: excludedNames.size };
}

const summary = run();

if (failures.length) {
  console.error('suite-coverage-test: FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('suite-coverage-test: ok — ' + checks + ' فحصاً؛ يصل الطقم إلى ' + summary.reachable
  + ' سكربتاً و' + summary.excluded + ' مستبعداً بسبب معلن، ولا يتيم.');
