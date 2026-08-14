/**
 * سطر — مقياس حصّة العربية في نثر ردود الوكيل (‏OBS-001).
 *
 * وحدة **نقية** بلا اعتماديات (نمط `diff.js`): يستهلكها مسبار القياس الحيّ
 * (`scripts/language-probe.js`) واختبارها القطعي، ولاحقاً أي حارس يقرّره العصف
 * الثلاثي — فيبقى تعريف «الانزلاق» تنفيذاً واحداً لا نسخاً تتباعد.
 *
 * **المبدأ الحاكم — نقيس النثر لا النص كله**: عقد «سطر» نفسه (‏envbrief) يوجب أن
 * يبقى الكود والمسارات والأوامر والمصطلحات التقنية **بالإنجليزية**. فمقياسٌ يعدّ
 * محارف الردّ كله يعاقب الجواب الصحيح (شرح عربي حول كود كثيف) ويكافئ الخطأ
 * (نثر إنجليزي قليل الكود). لذلك تُقصى قبل العدّ: الكتل المسيَّجة · الكود المضمّن ·
 * الروابط · المسارات · رموز الأوامر والأعلام. ما يتبقى هو النثر الموجَّه للمستخدم،
 * وهو وحده موضع العقد.
 */

'use strict';

// حروف عربية (بما فيها الملحقات) — الأرقام والترقيم خارج العدّ عمداً
const ARABIC_RE = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/g;
const LATIN_RE = /[A-Za-z]/g;

const FENCED_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/g;
// مسار: مقطعان فأكثر بفاصل / أو \ — يلتقط src/ui/app.js وD:\sater ونحوهما
const PATH_RE = /(?:[A-Za-z]:)?(?:[\w.-]+[\\/]){1,}[\w.*-]+/g;
// رمز تقني لاتيني ملتصق: camelCase · snake_case · kebab-flag · اسم.امتداد · CONST_CASE
// · وPascalCase بحدبتين (‏WebSocket/JavaScript) — أثبت التشغيل الحيّ الأول أن عدّها
// نثراً يتّهم صفّ جدولٍ سليماً بمصطلحاته المشروعة (إيجابية كاذبة مقيسة لا مفترضة).
const TECH_TOKEN_RE = /\b(?:--?[\w-]+|[A-Za-z][\w]*(?:[_.-][\w]+)+|[A-Z]{2,}[A-Z0-9_]*|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

/** يعيد النثر بعد إقصاء ما يوجب العقدُ بقاءَه إنجليزياً. */
function proseOf(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(FENCED_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(PATH_RE, ' ')
    .replace(TECH_TOKEN_RE, ' ');
}

/**
 * يقيس حصّة العربية في نثر النص.
 * @returns {{arabic:number, latin:number, share:number|null, prose_sample:string}}
 *   `share` = عربي ÷ (عربي + لاتيني) في النثر، أو `null` حين لا حروف قوية أصلاً
 *   (ردّ كوديّ خالص — لا يُحسب انزلاقاً ولا التزاماً).
 */
function arabicShare(text) {
  const prose = proseOf(text);
  const arabic = (prose.match(ARABIC_RE) || []).length;
  const latin = (prose.match(LATIN_RE) || []).length;
  const total = arabic + latin;
  return {
    arabic,
    latin,
    share: total ? arabic / total : null,
    prose_sample: prose.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

/**
 * كشف **البنية الإنجليزية**: عناوين Markdown وصفوف جداول وبنود قوائم نثرها لاتيني.
 * هذا نمط لقطتي المالك بالضبط (2026-08-13 و2026-08-14): تقرير مُهيكل إنجليزي كامل
 * داخل واجهة عربية — إشارة أوضح من النسبة الإجمالية لأن سطراً بنيوياً واحداً
 * بالإنجليزية يقفز إلى العين حتى داخل ردٍّ معظمه عربي.
 */
function structuralSlips(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.replace(FENCED_RE, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^(#{1,4}\s|\|.*\||[-*]\s|\d+[.)]\s)/.test(trimmed)) continue;
    const measured = arabicShare(trimmed);
    if (measured.share !== null && measured.share < 0.5
        && (measured.arabic + measured.latin) >= 12) {
      out.push(trimmed.slice(0, 80));
    }
  }
  return out;
}

module.exports = { arabicShare, structuralSlips, proseOf };
