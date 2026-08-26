/**
 * سطر — اختبار مقياس حصّة العربية (قطعي، بلا شبكة).
 *
 * الخطر المزدوج الذي يحرسه: مقياس **متشدد** يعدّ الكود انزلاقاً فيحمرّ على الجواب
 * الصحيح (يُعطَّل ثم لا يحرس شيئاً)، ومقياس **متساهل** يفوّت تقرير لقطة المالك.
 * كل حالة هنا من أحد الطرفين.
 */
'use strict';

const assert = require('assert');
const {
  arabicShare, structuralSlips, proseOf, scriptOf, isSlip, METRIC_VERSION,
} = require('../electron/langmetric');

/**
 * نسخة v2 **مجمَّدة** من دالة الحكم — مصدر الحقيقة لادعاء التوافق في `langmetric.js`.
 *
 * ليست تكراراً للمنطق بل **بصمة تاريخية**: تُبنى فوق `arabicShare`/`structuralSlips`
 * الحاليتين (وهما اللتان يعِد العقد بعدم مسّهما) وتعيد ما كان `isSlip` يعيده قبل
 * وعي الخط. فإن مسّ أحدٌ الإقصاءات أو العتبات انهار التطابق وسقط الفحص — وهو
 * المقصود: الادعاء أن بيانات v2 الـ906 ما زالت قابلة للمعايرة، وهذه هي عضّته.
 */
function isSlipV2(text) {
  const measured = arabicShare(text);
  const strong = measured.arabic + measured.latin;
  if (measured.share === null) return { slip: false, reason: 'no_prose', ...measured };
  if (strong < MIN_STRONG) return { slip: false, reason: 'short', ...measured };
  const slips = structuralSlips(text);
  if (measured.share < SHARE_V2) return { slip: true, reason: 'share', structural: slips.length, ...measured };
  if (slips.length >= STRUCTURAL_V2) return { slip: true, reason: 'structure', structural: slips.length, ...measured };
  return { slip: false, reason: 'ok', structural: slips.length, ...measured };
}
// العتبات كما جُمّدت في v2 — مكتوبة هنا حرفياً لا مستوردة، وإلا تحرّكت مع الإنتاج
// فصار الفحص يقارن الشيء بنفسه ويمرّ دائماً (حارس أخضر كاذب).
const SHARE_V2 = 0.5;
const MIN_STRONG = 120;
const STRUCTURAL_V2 = 2;

let checks = 0;
function ok(cond, msg) { checks += 1; assert(cond, msg); }

// ── 1) الجواب الصحيح لا يُعاقَب: شرح عربي حول كود كثيف ──────────────────────
{
  const answer = 'المشكلة في دالة التحقق: انظر الكود.\n\n'
    + '```js\nfunction validate(input) {\n  if (!input) return null;\n  return input.trim();\n}\n```\n\n'
    + 'السبب أن `input.trim()` يستدعى قبل فحص النوع، والعلاج نقل الفحص إلى '
    + 'أول الدالة في src/ui/app.js مع خيار --strict عند التشغيل.';
  const m = arabicShare(answer);
  ok(m.share !== null && m.share > 0.9,
    'شرح عربي حول كود كثيف يقيس عربياً صافياً (وجدنا ' + (m.share && m.share.toFixed(2)) + ')');
  ok(structuralSlips(answer).length === 0, 'ولا بنية إنجليزية فيه');
}

// ── 2) نمط لقطة المالك يُمسَك: تقرير إنجليزي مُهيكل ─────────────────────────
{
  const slipped = '## Findings\n\n'
    + '| Area | Status | Notes |\n|---|---|---|\n'
    + '| Higgsfield API | not production | one video model exposed |\n'
    + '| Billing | broken | balance not funded |\n\n'
    + 'The developer catalogue stays useful as an evaluation lab.\n';
  const m = arabicShare(slipped);
  ok(m.share !== null && m.share < 0.1,
    'التقرير الإنجليزي الكامل يقيس انزلاقاً صريحاً (' + (m.share && m.share.toFixed(2)) + ')');
  ok(structuralSlips(slipped).length >= 3,
    'والبنية الإنجليزية (عنوان + صفوف جدول) مكشوفة (' + structuralSlips(slipped).length + ' سطراً)');
}

// ── 3) الانزلاق الجزئي: نثر إنجليزي داخل ردّ عربي ───────────────────────────
{
  const mixed = 'راجعت الملف كاملاً.\n\n'
    + 'The main issue is that the handler swallows errors silently and the retry '
    + 'logic never fires, which makes debugging very hard for the user.\n\n'
    + 'اقتراحي أن نصلح المعالج أولاً.';
  const m = arabicShare(mixed);
  ok(m.share !== null && m.share > 0.2 && m.share < 0.7,
    'الردّ المختلط يقيس في الوسط لا في الطرفين (' + (m.share && m.share.toFixed(2)) + ')');
}

// ── 4) الردّ الكودي الخالص لا يُحسب انزلاقاً ولا التزاماً ────────────────────
{
  const codeOnly = '```bash\nnpm run test:full\n```';
  const m = arabicShare(codeOnly);
  ok(m.share === null, 'ردّ كوديّ خالص ⇒ share=null (خارج الحكم)');
}

// ── 5) الإقصاءات لا تبتلع النثر: مصطلح تقني وسط جملة إنجليزية يبقى مقيساً ────
{
  const p = proseOf('You should refactor the sendUplink function because it mixes concerns badly.');
  ok((p.match(/[A-Za-z]/g) || []).length > 30,
    'الجملة الإنجليزية تبقى مقيسة رغم إقصاء sendUplink التقني (بقي '
    + (p.match(/[A-Za-z]/g) || []).length + ' حرفاً)');
}

// ── 6) كتلة مسيَّجة غير مغلقة (ردّ مقطوع) لا تكسر القياس ────────────────────
{
  const truncated = 'الحل كما يلي:\n```js\nconst x = 1;\n// قُطع الردّ هنا';
  const m = arabicShare(truncated);
  ok(m.arabic > 0 && m.latin === 0,
    'السياج غير المغلق يُقصى حتى نهاية النص ولا يتسرب كوده إلى النثر');
}

// ── 7) القوائم العربية المرقّمة ليست بنية إنجليزية ──────────────────────────
{
  const arabicList = '1. جمّد العقد أولاً\n2. أطلق المنفّذين\n3. راجع النتائج بالعضّات';
  ok(structuralSlips(arabicList).length === 0, 'قائمة عربية مرقّمة لا تُعدّ انزلاقاً بنيوياً');
}

// ── 8) السطر البنيوي القصير جداً لا يُحسب (ضجيج) ────────────────────────────
{
  ok(structuralSlips('- ok\n- done').length === 0,
    'بنود لاتينية أقصر من عتبة الحروف لا تُعدّ — سطر بنيوي يُدان بحروف كافية فقط');
}

// ── 9) إيجابيتا التشغيل الحيّ الأول لا تعودان: PascalCase مصطلح لا نثر ────────
{
  const tableHeader = '| المعيار | WebSocket | Long-Polling |';
  ok(structuralSlips(tableHeader).length === 0,
    'صفّ جدول عربي بمصطلحات PascalCase لا يُتّهم (إيجابية كاذبة مقيسة 2026-08-14)');
  const heading = '## مثال بسيط (JavaScript)';
  ok(structuralSlips(heading).length === 0, 'وعنوان عربي بمصطلح تقني كذلك');
  // والاتجاه المعاكس محفوظ: جملة إنجليزية فيها PascalCase تبقى انزلاقاً
  const m = arabicShare('The WebSocket handler reconnects after every failure automatically.');
  ok(m.share !== null && m.share < 0.1,
    'الجملة الإنجليزية حول المصطلح تبقى مقيسة انزلاقاً (' + (m.share && m.share.toFixed(2)) + ')');
}

// ── 10) دالة الحكم isSlip — عتبات العصف المجمَّدة ────────────────────────────
{
  ok(Number.isInteger(METRIC_VERSION) && METRIC_VERSION >= 2,
    'المقياس موسوم بإصدار (قرار العصف: لا أرقام بلا metric_version)');

  // انزلاق لقطة المالك: نثر إنجليزي طويل ⇒ slip بحصّة
  const slipped = isSlip('The review found three issues in the permission layer. '
    + 'First the handler swallows errors, second the retry logic never fires, and '
    + 'third the audit trail misses tool identifiers entirely across engines.');
  ok(slipped.slip === true && slipped.reason === 'share', 'النثر الإنجليزي الطويل انزلاق صريح');

  // الردّ العربي السليم ⇒ لا انزلاق
  const fine = isSlip('راجعت الطبقات الثلاث كاملة ووجدت أن معالج الأذونات يبتلع الأخطاء، '
    + 'وأن منطق إعادة المحاولة لا يعمل إطلاقاً، وأن سجل التدقيق لا يحمل معرّفات الأدوات. '
    + 'اقتراحي أن نبدأ بإصلاح المعالج لأنه جذر المشكلتين الأخريين.');
  ok(fine.slip === false && fine.reason === 'ok', 'الردّ العربي السليم لا يُتّهم');

  // القصير خارج الحكم — لا إنذارات كاذبة على «Done» ونحوها
  ok(isSlip('Done, all tests pass.').slip === false
    && isSlip('Done, all tests pass.').reason === 'short', 'القصير خارج الحكم');

  // الكودي الخالص خارج الحكم
  ok(isSlip('```bash\nnpm test\n```').reason === 'no_prose', 'الكودي الخالص خارج الحكم');

  // البنية وحدها تدين حتى لو رفعت المصطلحاتُ الحصّةَ فوق العتبة
  const structural = isSlip('إليك الملخص الكامل للمراجعة التي أجريتها اليوم على الطبقات:\n'
    + '## Findings and open questions from the full review\n'
    + '| Layer | Status | Every handler checked |\n'
    + 'وسأكمل البقية غداً بإذن الله مع تقرير التغطية الشاملة للأدوات كلها.');
  ok(structural.slip === true && structural.reason === 'structure',
    'بنيتان إنجليزيتان تدينان ولو كانت الحصّة الإجمالية فوق العتبة');
}

// ── وعي الخط (‏OBS-022) وتوافق v3 مع v2 ─────────────────────────────────────
{
  const FA = 'این یک متن فارسی خالص است که برای آزمایش نوشته شده و هیچ کلمه عربی در آن '
    + 'وجود ندارد. نویسنده این متن می خواهد نشان دهد که سنجه زبان فارسی را عربی می شمارد.';
  const AR = 'هذا نصّ عربي خالص كُتب للاختبار كي يتجاوز عتبة المحارف القوية فيُحكَم عليه، '
    + 'ولا يحوي أي كلمة فارسية على الإطلاق. والغرض إثبات أن الحكم عليه لم يتغيّر بين الإصدارين.';
  const EN = 'This is a fully English paragraph written to cross the strong character threshold '
    + 'so that the metric actually judges it rather than skipping it as too short to matter here.';

  // العطل المرصود حرفياً في OBS-022: فارسي خالص كان يعطي share≈0.96 وحكم ok
  ok(scriptOf(FA) === 'fa', 'الفارسي الخالص يُصنَّف fa لا ar');
  const faVerdict = isSlip(FA);
  ok(faVerdict.slip === true && faVerdict.reason === 'script',
    'الفارسي الخالص لم يعد يُسجَّل ملتزماً بالعربية (كان reason=ok)');
  ok(isSlipV2(FA).slip === false, 'وهذا فرقٌ حقيقي عن v2 — وإلا لما لزم رفع الإصدار');

  ok(scriptOf(AR) === 'ar', 'العربي الخالص يُصنَّف ar');
  ok(scriptOf(EN) === null, 'النثر اللاتيني بلا حكم خطّ');
  // المختلط لا يُدان تحفظاً (عربيٌّ يقتبس فارسية حالة مشروعة) لكنه موسوم للمعايرة
  const mixed = isSlip(AR + ' ' + FA);
  ok(mixed.script === 'mixed' && mixed.slip === false, 'المختلط يُوسم ولا يُدان');

  // ادعاء التوافق: كل نثر عربي/لاتيني/كودي يعطي حكماً مطابقاً حقلاً حقلاً
  const CORPUS = [AR, EN, 'Done, all tests pass.', '```bash\nnpm test\n```',
    'راجعت الطبقات الثلاث كاملة ووجدت أن معالج الأذونات يبتلع الأخطاء، وأن منطق '
      + 'إعادة المحاولة لا يعمل، وأن سجل التدقيق لا يحمل معرّفات الأدوات إطلاقاً.',
    'إليك الملخص:\n## Findings and open questions from the full review\n'
      + '| Layer | Status | Every handler checked |\nوسأكمل البقية غداً بتقرير التغطية.',
    'المشكلة في `validate()` داخل src/ui/app.js مع العلم --strict، والعلاج نقل الفحص '
      + 'إلى أول الدالة كي لا يُستدعى trim قبل فحص النوع الصحيح للمدخل الوارد.'];
  for (const sample of CORPUS) {
    const now = isSlip(sample);
    const before = isSlipV2(sample);
    ok(now.slip === before.slip && now.reason === before.reason && now.share === before.share,
      'حكم v3 يطابق v2 لهذه العيّنة غير الفارسية — وإلا أُهدرت ‏906 قياساً متراكمة: '
        + JSON.stringify(sample.slice(0, 40)) + ' ⇒ v3=' + now.reason + ' vs v2=' + before.reason);
  }
  ok(METRIC_VERSION === 3, 'وسم الإصدار ارتفع مع تغيّر الحكم');
}

console.log('langmetric-test: ok — ' + checks
  + ' فحوص (الجواب الصحيح لا يُعاقَب، ولقطة المالك تُمسَك، والحواف لا تكسر، '
  + 'ووعي الخط يمسك الفارسية دون أن يُهدر بيانات v2).');
