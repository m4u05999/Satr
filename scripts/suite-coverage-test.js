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
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const FULL_SUITE_FILE = path.join(__dirname, 'full-suite.js');
const SCRIPT_NAME = /^(test|eval|audit):/;
const SCRIPT_LITERAL = /['"]((?:test|eval|audit):[\w:.-]+)['"]/g;
const NPM_RUN = /\bnpm\s+run\s+((?:test|eval|audit):[\w:.-]+)/g;
const SUB_SUITE_FILE = /\bscripts\/([\w.-]+-suite\.js)\b/;
const ARABIC = /[؀-ۿ]/;

/**
 * زرع `spawnSync` **قبل** استيراد `full-suite`: ذاك الملف يمسك المرجع عند التحميل
 * (‏`const { spawnSync } = require('child_process')`)، فيسمح الزرع بمحاكاة
 * «فشل ثم نجاح» و«فشل مرتين» دون لمس `package.json` ولا تشغيل npm فعلياً —
 * والمفحوض هو `main()` الحقيقي بجملته لا إعادة كتابة منطقه في الاختبار
 * (‏«حارس يقارن الشيء بنفسه»). يُسترجع في `finally` عند نهاية القسم السلوكي.
 */
const spawnLog = [];
let fakeStatuses = new Map();
const originalSpawnSync = cp.spawnSync;
cp.spawnSync = (command, args) => {
  const name = args[args.length - 1];
  const queue = fakeStatuses.get(name);
  const status = queue && queue.length ? queue.shift() : 0;
  spawnLog.push({ name, status });
  return { status, signal: null, error: undefined, pid: 0 };
};

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
  const { SUITE, EXCLUDED_FROM_SUITE, RETRYABLE, RETRYABLE_OBS, MAX_RETRIES } = suite;

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

  // ── 2) قائمة الإعادة المعلَنة مغلقة ومُبرَّرة (‏OBS-036) ──
  // العقد: Set مصدَّر، سقف محاولة واحدة بلا تفاوض، كل اسم مقيّس فيه موجود في
  // package.json **وفي SUITE** (إعادة بلا وصول بلا معنى)، وكل اسم يحمل تبريراً
  // برقم ملاحظة مقيسة في RETRYABLE_OBS **ومكتوباً بجواره في المصدر** — فلا يدخل
  // اسم «لأنه قد يتعثّر»، والقائمة مغلقة من الطرفين (لا تبريراً لغير مقيّس).
  check(RETRYABLE instanceof Set, 'RETRYABLE مصدَّرة كـSet');
  check(MAX_RETRIES === 1, `MAX_RETRIES === 1 — زيادة السقف تُفرغ الحارس (الواقع: ${MAX_RETRIES})`);
  if (RETRYABLE instanceof Set) {
    const suiteNames = new Set(SUITE);
    const suiteSource = fs.readFileSync(FULL_SUITE_FILE, 'utf8');
    for (const name of RETRYABLE) {
      check(typeof scripts[name] === 'string', `RETRYABLE تذكر «${name}» وهو غير موجود في package.json`);
      check(suiteNames.has(name), `RETRYABLE تذكر «${name}» وهو ليس في SUITE — إعادة بلا وصول`);
      const obs = RETRYABLE_OBS && RETRYABLE_OBS[name];
      check(typeof obs === 'string' && /^OBS-\d{3}$/.test(obs),
        `«${name}» بلا تبرير بصيغة OBS-### في RETRYABLE_OBS — القائمة تُبرَّر بسابقة مقيسة لا تُخمَّن`);
      check(new RegExp(`'${name}'[^\\n]*${obs}`).test(suiteSource),
        `«${name}» لا يذكر ${obs} بجواره في full-suite.js — التبرير يُقرأ حيث يُقرأ الاسم`);
    }
    for (const name of Object.keys(RETRYABLE_OBS || {})) {
      check(RETRYABLE.has(name), `RETRYABLE_OBS تبرّر «${name}» وهو غير مقيّس في RETRYABLE — تبرير يتيم`);
    }
  }

  // ── 3) الوصول: من SUITE عبر الأطقم الفرعية والسكربتات المركّبة ──
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

  // ── 4) العقد نفسه: لا يتيم ──
  const orphans = Object.keys(scripts)
    .filter((name) => SCRIPT_NAME.test(name) && !reachable.has(name) && !excludedNames.has(name));
  for (const name of orphans) {
    check(false, `«${name}» يتيم: لا يصله الطقم ولا هو في EXCLUDED_FROM_SUITE بسبب — أضفه لأحدهما`);
  }

  return { reachable: reachable.size, excluded: excludedNames.size };
}

const summary = run();

// ── 5) سلوك الإعادة حيّاً (‏OBS-036): الحارس لا يقارن الشيء بنسخة منه ──
// ثلاثة سيناريوهات على `main()` الحقيقي بزرع `spawnSync` المثبّت أعلاه:
//   (أ) فشل ثم نجاح لاسم مقيّس ⇒ يُعاد مرة واحدة، الإعلان الصاخب يظهر،
//       والخاتمة تذكر المُعاد صراحةً (لا «أخضر كاذب»).
//   (ب) فشل مرتين لاسم مقيّس ⇒ يسقط الطقم بعد محاولتين فقط (سقف MAX_RETRIES).
//   (ج) فشل لاسم غير مقيّس ⇒ محاولة واحدة فقط بلا أي إعلان إعادة — القائمة مغلقة.
function runRetryBehavioral() {
  const originalLog = console.log;
  const originalError = console.error;
  const captured = [];
  const originalSuite = [...suite.SUITE];

  const runOnce = (names, statusesByName) => {
    fakeStatuses = new Map(Object.entries(statusesByName).map(([k, v]) => [k, [...v]]));
    spawnLog.length = 0;
    captured.length = 0;
    console.log = (...a) => captured.push(a.join(' '));
    console.error = (...a) => captured.push(a.join(' '));
    try {
      suite.SUITE.length = 0;
      suite.SUITE.push(...names);
      process.exitCode = undefined;
      suite.main();
      const exitCode = process.exitCode || 0;
      process.exitCode = undefined;
      return { output: captured.join('\n'), calls: spawnLog.map((c) => `${c.name}:${c.status}`), exitCode };
    } finally {
      console.log = originalLog;
      console.error = originalError;
      suite.SUITE.length = 0;
      suite.SUITE.push(...originalSuite);
    }
  };

  const a = runOnce(['test:promocapture-live'], { 'test:promocapture-live': [1, 0] });
  check(a.exitCode === 0, `فشل-ثم-نجاح لاسم مقيّس: الطقم ينجح (الخرج ${a.exitCode})`);
  check(a.calls.join(',') === 'test:promocapture-live:1,test:promocapture-live:0',
    `يُعاد مرة واحدة بالضبط (النداءات: ${a.calls.join('، ')})`);
  check(a.output.includes('⚠ تعثّر «test:promocapture-live» (المحاولة 1/2)'),
    'الإعلان الصاخب يُطبع فور التعثّر باسم المجموعة ورقم المحاولة');
  check(a.output.includes('OBS-036'), 'الإعلان يذكر رقم الملاحظة المُبرِّرة');
  check(a.output.includes('أُعيد بعد تعثّر بيئي: test:promocapture-live'),
    'الخاتمة تذكر المُعاد صراحةً — «كله أخضر» بلا ذكر حارس أخضر كاذب');

  const b = runOnce(['test:promocapture-live'], { 'test:promocapture-live': [1, 1] });
  check(b.exitCode === 1, `فشل مرتين: الطقم يسقط فعلاً (الخرج ${b.exitCode})`);
  check(b.calls.length === 2, `سقف إعادة واحدة لا تُتجاوز — محاولتان فقط (${b.calls.length})`);
  check(b.output.includes('فشلت المجموعات التالية'), 'مسار السقوط يطبق قائمة الفاشلات');
  check(!b.output.includes('أُعيد بعد تعثّر بيئي'), 'مسار السقوط لا يزعم نجاحاً بإعادة');

  const c = runOnce(['test:readme-version'], { 'test:readme-version': [1, 1] });
  check(c.exitCode === 1, `فشل اسم غير مقيّس: الطقم يسقط (الخرج ${c.exitCode})`);
  check(c.calls.length === 1, `اسم غير مقيّس لا يُعاد أبداً — محاولة واحدة فقط (${c.calls.length})`);
  check(!c.output.includes('⚠ تعثّر'), 'لا إعلان إعادة لاسم خارج القائمة المغلقة');

  // نرفق خرج سيناريو السقوط بأثر «فشل ثم نجاح» ليُطبع دليله الحيّ أدناه.
  a.failTwiceOutput = b.output;
  return a;
}

let liveProof = null;
try {
  liveProof = runRetryBehavioral();
} finally {
  cp.spawnSync = originalSpawnSync;
}

// إثبات حيّ قابل للنسخ الحرفي في تقارير المراجعة: أسطر خرج المشغّل الحقيقي
// من سيناريو «فشل ثم نجاح» — الإعلان الصاخب وسطر الخاتمة كما طُبعتا فعلاً،
// وسطر السقوط من سيناريو «فشل مرتين».
if (liveProof) {
  const loudLine = liveProof.output.split('\n').find((line) => line.includes('⚠ تعثّر'));
  const finalLine = liveProof.output.split('\n').find((line) => line.includes('أُعيد بعد تعثّر بيئي'));
  console.log('suite-coverage-test: دليل حيّ — الإعلان الصاخب: ' + (loudLine || '(غائب!)'));
  console.log('suite-coverage-test: دليل حيّ — سطر الخاتمة: ' + (finalLine || '(غائب!)'));
  const failLine = (liveProof.failTwiceOutput || '').split('\n').find((line) => line.includes('فشلت المجموعات التالية'));
  console.log('suite-coverage-test: دليل حيّ — سطر السقوط (فشل مرتين): ' + (failLine || '(غائب!)'));
}

if (failures.length) {
  console.error('suite-coverage-test: FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('suite-coverage-test: ok — ' + checks + ' فحصاً؛ يصل الطقم إلى ' + summary.reachable
  + ' سكربتاً و' + summary.excluded + ' مستبعداً بسبب معلن، ولا يتيم.');
