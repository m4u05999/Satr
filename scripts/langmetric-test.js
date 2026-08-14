/**
 * سطر — اختبار مقياس حصّة العربية (قطعي، بلا شبكة).
 *
 * الخطر المزدوج الذي يحرسه: مقياس **متشدد** يعدّ الكود انزلاقاً فيحمرّ على الجواب
 * الصحيح (يُعطَّل ثم لا يحرس شيئاً)، ومقياس **متساهل** يفوّت تقرير لقطة المالك.
 * كل حالة هنا من أحد الطرفين.
 */
'use strict';

const assert = require('assert');
const { arabicShare, structuralSlips, proseOf } = require('../electron/langmetric');

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

console.log('langmetric-test: ok — ' + checks
  + ' فحوص (الجواب الصحيح لا يُعاقَب، ولقطة المالك تُمسَك، والحواف لا تكسر).');
