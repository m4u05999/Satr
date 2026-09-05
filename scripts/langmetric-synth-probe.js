/**
 * سطر — مسبار OBS-115: عيّنة اصطناعية لأنماط النثر البنيوي في ردود «سطر» اليوم.
 *
 * السؤال: بعد صقل `2e641d6` (‏METRIC_VERSION 4) نما مجتمع `structure` من
 * ‏1.12% إلى 1.97% بدل أن يتقلّص. فرضيتان: (أ) المقياس يُدين بباطل نمطاً
 * شائعاً في الردود الحديثة، (ب) الردود صارت أبنى فعلاً. هذا المسبار يفصل
 * الحقيقي عن الكاذب بعيّنة **تشبه ما ننتجه فعلاً** (جداول قياس، قوائم
 * مرقّمة بمسارات، أوامر مسيَّجة، مخرجات حرّاس، بصمات التزام، وسوم واجهات،
 * أسماء نماذج) — لا نصاً عاماً.
 *
 * يعمل في وضعين: قياس (تقرير الحق/الباطل) وحارس (يفشل بخروج ≠ 0 عند أي
 * حكم مخالف للتصميم). يستهلكه `scripts/langmetric-test.js` كمصدر واحد
 * للعيّنة حتى لا تتباعد النسختان.
 *
 * التصنيف المعتمد لكل حالة:
 *   - مشروع: نثر عربي في جوهره، والإنجليزي فيه معرّفات يوجب العقدُ بقاءها
 *     (‏`envbrief`: الكود والمسارات والأوامر والمصطلحات التقنية بالإنجليزية).
 *   - حقيقي: جملة إنجليزية كاملة في عنوان/بند/خلية — نمط شكوى المالك ذاته.
 *   - حدّ مقبول: يُدان ويبقى مُداناً عمداً (عناوين بحكمها، وأمر بلا سياج
 *     يُقرأ جملة — علاجه التنسيق لا المقياس).
 */
'use strict';

const assert = require('assert');
const { isSlip, structuralSlips } = require('../electron/langmetric');

// نثر عربي كافٍ لتجاوز بوابتي no_prose/short ورفع الحصّة فوق العتبة —
// فينحصر الحكم في الفرع البنيوي وحده (‏reason='structure' أو 'ok').
const AR_INTRO = 'راجعتُ الطبقات الثلاث كاملةً ووجدتُ أن معالج الأذونات يبتلع الأخطاء، '
  + 'وأن منطق إعادة المحاولة لا يعمل إطلاقاً، وأن سجل التدقيق لا يحمل معرّفات الأدوات. '
  + 'وهذا ملخّص ما سنشغّله ونقيسه في الدورة القادمة من المراجعة بالكامل.';
const AR_OUTRO = 'الخلاصة أن نبدأ بمعالج الأذونات لأنه جذر المشكلتين الأخريين، '
  + 'وأن نؤجّل سجل التدقيق إلى الدورة التالية بعد استقرار الاختبارات الحالية كلها.';

/** يلفّ أسطراً بنيوية في نثر عربي كي يجتاز الحالةُ بوابتَي الحجم والحصّة. */
function wrap(itemLines) {
  return AR_INTRO + '\n' + itemLines.join('\n') + '\n' + AR_OUTRO;
}

/**
 * العيّنة — كل حالة: اسم، أسطر بنيوية، تصنيف، والحكم المتوقع في التصميم
 * المصقول (‏v5): 'ok' = لا يُدان، 'structure' = يُدان بنيوياً.
 */
const CORPUS = [
  // ── مشروع: لا يجوز أن يُدان — جوهره عربي ومعرّفاته مشروعة بنصّ العقد ──
  { name: 'جدول قياس إصدارين (نمط OBS-058)', expect: 'ok', cls: 'مشروع', lines: [
    '| | v2 | v4 |',
    '|---|---|---|',
    '| صفوف | 979 | 609 |',
    '| structure | 11 — 1.12% | 12 — 1.97% |',
    '| share | 15 — 1.53% | 2 — 0.33% |',
  ] },
  { name: 'جدول نتائج تقييم بأسماء مهام', expect: 'ok', cls: 'مشروع', lines: [
    '| المهمة | النتيجة | المدة |',
    '| single-edit | ✅ | 12.4s |',
    '| arabic-path | ✅ | 9.1s |',
  ] },
  { name: 'قائمة مرقّمة بمسارات وأوامر مسيَّجة', expect: 'ok', cls: 'مشروع', lines: [
    '1. أصلح `scripts/langmetric-test.js` ثم أعد التشغيل.',
    '2. شغّل `npm run test:langmetric` وراقب الخرج.',
    '3. راجع `electron/langmetric.js:146` قبل أي تعديل.',
  ] },
  { name: 'مخرجات حرّاس مقتبسة في بنود', expect: 'ok', cls: 'مشروع', lines: [
    '- `langmetric-test`: ok — 26 فحوص.',
    '- `langshadow-test`: ok — 19 فحصاً.',
  ] },
  { name: 'بصمات التزام ومراجع ملاحظات', expect: 'ok', cls: 'مشروع', lines: [
    '- أُصلح في `2e641d6` (OBS-057) وعولج الفرع البنيوي بالكامل.',
    '- أُعيد فتح الحساب في `01d99bb` بعد دمج جولة المراجعة الأخيرة.',
  ] },
  { name: 'بند بأسماء نماذج (معرّفات لا نثر)', expect: 'ok', cls: 'مشروع', lines: [
    '- أسماء نماذج Claude الرسمية: **Fable 5.1** وOpus 5 وSonnet 5 وHaiku 4.5.',
    '- فئات الاستبيان: Violence · Sexuality · Language · Controlled Substance · Age-Restricted.',
  ] },
  { name: 'خطوة مشي في واجهة إنجليزية (وسوم لا نثر)', expect: 'ok', cls: 'مشروع', lines: [
    '1. في **تطبيق Claude**: **Settings** ← **Capabilities** ← فعّل **GitHub**.',
    '2. اضغط **Verify 2FA now** ثم **Save** وأغلق النافذة.',
  ] },

  // ── حقيقي: يجب أن يُدان — جمل إنجليزية كاملة، نمط شكوى المالك ذاته ──
  { name: 'عناوين إنجليزية كاملة', expect: 'structure', cls: 'حقيقي', lines: [
    '## Where things stand',
    '## Recommended next steps',
  ] },
  { name: 'بنود إنجليزية كاملة', expect: 'structure', cls: 'حقيقي', lines: [
    '- The handler swallows every error silently.',
    '- The retry logic never runs at all.',
  ] },
  { name: 'جدول بخلية جملة إنجليزية', expect: 'structure', cls: 'حقيقي', lines: [
    '| Layer | Status | Every handler checked by the reviewer |',
    '| Area | Notes | The audit trail misses tool identifiers entirely |',
  ] },

  // ── حدود مقبولة: تُدان وتبقى مُدانة — العلاج فيها تنسيق لا مقياس ──
  { name: 'عنوان هو اسم أمر (العناوين بحكمها عمداً)', expect: 'structure', cls: 'حد', lines: [
    '## npm run test:langmetric',
    '## Where things stand',
  ] },
  { name: 'بند بأمر بلا سياج يُقرأ جملة', expect: 'structure', cls: 'حد', lines: [
    '- نفّذ npm run test:full الآن.',
    '- شغّل git push origin الآن.',
  ] },
];

/** يقيس العيّنة على المقياس الحالي ويعيد سجلاً لكل حالة. */
function measure() {
  return CORPUS.map((c) => {
    const text = wrap(c.lines);
    const verdict = isSlip(text);
    const condemnedLines = structuralSlips(text);
    // باطل = سطر مشروع أُدين خلافاً للتصميم؛ حقّ = سطر حقيقي/حد أُدين كما ينبغي.
    // العدّ **سطرياً لا قضيّاً**: العتبة 2 تخفي إدانةً مفردة في الحكم الكلي.
    const falseLines = c.cls === 'مشروع' ? condemnedLines.length : 0;
    const trueLines = c.cls !== 'مشروع' ? condemnedLines.length : 0;
    const missed = (c.cls === 'حقيقي' || c.cls === 'حد') && verdict.reason !== c.expect;
    return { ...c, verdict: verdict.reason, structural: verdict.structural,
             condemnedLines, falseLines, trueLines, missed };
  });
}

function report(results) {
  let falseCases = 0, falseLines = 0, trueLines = 0, missed = 0;
  console.log('langmetric-synth-probe: عيّنة OBS-115 — ' + CORPUS.length + ' حالات');
  for (const r of results) {
    const flag = r.falseLines ? ' ✗ باطل' : r.missed ? ' ✗ أفلت' : ' ✓';
    console.log(flag + ' [' + r.cls + '·متوقع ' + r.expect + '·فعلي ' + r.verdict + '] ' + r.name
      + (r.condemnedLines.length ? '\n    أُدين: ' + JSON.stringify(r.condemnedLines) : ''));
    if (r.falseLines) falseCases += 1;
    falseLines += r.falseLines;
    trueLines += r.trueLines;
    if (r.missed) missed += 1;
  }
  console.log('الحصيلة: ' + falseLines + ' سطراً مشروعاً أُدين بباطل (في ' + falseCases + ' حالات) · '
    + trueLines + ' سطراً حقيقياً أُدين بحقّ · ' + missed + ' إفلات');
  return { falseCases, falseLines, trueLines, missed };
}

function main() {
  const { falseLines, trueLines, missed } = report(measure());
  // وضع الحارس: أي سطر مشروع مُدين أو انزلاق مُفلت فشل صريح.
  assert.strictEqual(falseLines, 0,
    'المقياس أدان ' + falseLines + ' سطراً مشروعاً بباطل — عيّنة OBS-115 تثبت فرضية (أ)');
  assert.strictEqual(missed, 0,
    'المقياس أفلت انزلاقاً حقيقياً — الاستثناء أفرغ الحارس');
  console.log('langmetric-synth-probe: ok — التصميم المصقول يحكم العيّنة كلها صواباً '
    + '(' + trueLines + ' إدانة حقّ).');
}

module.exports = { CORPUS, measure, wrap, AR_INTRO, AR_OUTRO };

if (require.main === module) main();
