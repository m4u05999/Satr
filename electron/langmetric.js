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

// حروف الخط العربي (بما فيها الملحقات) — الأرقام والترقيم خارج العدّ عمداً.
// ⚠️ هذا النطاق **خطٌّ لا لغة**: يشمل الفارسية والأردية والكردية وغيرها (‏OBS-022)،
// فلا يكفي وحده للحكم على الالتزام بالعربية — انظر `scriptOf` أدناه.
const ARABIC_RE = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/g;
const LATIN_RE = /[A-Za-z]/g;

/**
 * إشارات موجبة تفصل العربية عن الفارسية (‏OBS-022) — **لا نطاقٌ واحد يُقصي**.
 *
 * الفاصلان الأوثق زوجا محارف متشابهة بصرياً مختلفة ترميزاً: الكاف `ك` مقابل
 * الكهة `ک`، والياء `ي` مقابل الياء الفارسية `ی`. ويضاف ما لا وجود
 * له في الطرف الآخر: پ چ ژ گ وأرقام ۰–۹ وفاصل ZWNJ للفارسية، والتاء المربوطة
 * والألف المقصورة وأرقام ٠–٩ للعربية.
 *
 * تُكتب بـ`\u` عمداً لا محارفَ حرفية: ZWNJ **عديم العرض**، وزوجا الكاف/الياء لا
 * يُفرَّقان بالعين في المصدر — فالكتابة الحرفية تجعل مراجعة هذين السطرين مستحيلة.
 * وآ `آ` مستثناة رغم شيوعها في العربية لأنها شائعة في الفارسية أيضاً.
 */
const FA_MARK_RE = /[\u067e\u0686\u0698\u06af\u06a9\u06cc\u06f0-\u06f9\u200c]/g;
const AR_MARK_RE = /[\u0629\u0643\u064a\u0649\u0660-\u0669]/g;

/**
 * وسم إصدار المقياس — **مجمَّد بقرار العصف الثلاثي (2026-08-15)**.
 *
 * السبب: في التشغيل الحيّ الأول عُدِّل المقياس (فرع PascalCase) **بعد** جمع
 * الأرقام، فصُفِّرت إشارتان رجعياً — رصده النقد الخصومي «حارساً أخضر كاذباً»
 * محتملاً. القاعدة منذئذ: كل ملف نتائج يحمل `metric_version`، وأي تغيير في
 * الإقصاءات أو العتبات يرفع الرقم، والأرقام لا تُقارن عبر إصدارين.
 */
const METRIC_VERSION = 4; // ‏1 قبل PascalCase · 2 قبل وعي الخط · 3 قبل استثناء صفوف الجداول

/**
 * **توافق ضيّق ومحروس**: `arabicShare` والعتبات لم تُمَسّ في أيٍّ من الرفعين، وفحصُ
 * الخط يقع **بعد** بوابتَي `no_prose`/`short` وقبل الحصّة. فكل نثر وسمُه
 * `script:'ar'` **ولا صفوفَ جداول فيه** يعطي `share` و`slip` و`reason` مطابقةً
 * حرفياً لـv2؛ ولا يتغيّر إلا حكم الفارسي الخالص (‏v3) وصفوف الجداول (‏v4).
 *
 * وهذا ليس تجميلاً: سجل الظلّ راكم ‏921 قياساً على v2، وقاعدة «لا تُقارن الأرقام
 * عبر إصدارين» كانت ستُهدرها كلها وتعيد ساعة معايرة الخروج من الظلّ إلى الصفر.
 * يحرس التطابقَ فحصٌ في `test:langmetric` يشغّل نسخة v2 مجمَّدة بجانب الحالية على
 * مجموعة عربية/إنجليزية/كودية ويثبت تساوي الحكم حقلاً حقلاً.
 *
 * **وحدُّ v4 معلَن**: الأحد عشر صفَّ `structure` المتراكمة قيست بالقاعدة القديمة،
 * فلا تصلح لمعايرة الجديدة — إخراج `structure` من الظلّ يحتاج بيانات v4 طازجة.
 */

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
 * يصنّف خطّ النثر: `'ar'` أو `'fa'` أو `'mixed'`، و`null` حين لا حرف عربيَّ الخط أصلاً
 * (نثر لاتيني خالص — لا حكم لغويّ عليه هنا، تكفيه `share`).
 *
 * **الميل عند الغموض إلى `'ar'` عمداً**: نثر عربي طويل قد يخلو من `ة/ك/ي` نادراً،
 * أما النثر الفارسي فلا يكاد يخلو من `ی` أو `ک`. والأهم أن كلفة الخطأين غير
 * متماثلة — وسمُ عربيٍّ سليم «فارسياً» إنذارٌ كاذب، وقد نصّت هذه الوحدة نفسها على
 * أن «حارساً يُطلق إنذارات كاذبة يُعطَّل ثم لا يحرس شيئاً». فالغموض يُحسم لصالح
 * السكوت، وأسوأ ما يقع عندها هو سلوك v2 نفسه لا أسوأ منه.
 */
function scriptOf(text) {
  const prose = typeof text === 'string' ? proseOf(text) : '';
  if (!prose) return null;
  if (!(prose.match(ARABIC_RE) || []).length) return null;
  const fa = (prose.match(FA_MARK_RE) || []).length;
  const ar = (prose.match(AR_MARK_RE) || []).length;
  if (!fa) return 'ar';
  if (!ar) return 'fa';
  return 'mixed';
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
 *
 * **استثناء صفوف الجداول (‏OBS-057، 2026-08-27)** — مقيس لا مفترض: عيّنة تحاكي
 * أشكال ردود «سطر» أظهرت أن جدول مقارنةٍ عربياً بحصّة `0.91` يُدان بسطرين هما
 * `| share | same | same |` و`| script | absent | ar/fa/mixed |` — أسماءُ حقول
 * وقيمٌ **يوجب العقد نفسه** بقاءها إنجليزية. أي أن الحكم كان يعاقب الجواب الصحيح.
 *
 * الفارق ليس اللغة بل **الجملة**: خليةُ معرّفاتٍ ليست نثراً، وخليةُ نثرٍ نثرٌ.
 * فيُشترط لصف الجدول تتابعُ ثلاث كلمات إنجليزية **داخل خلية واحدة** — والأنبوب
 * يقطع التتابع فيسقط الجدول التقني ويبقى `| Layer | Status | Every handler
 * checked |` مُداناً. والقاعدة **لصفوف الجداول وحدها**: العناوين والبنود نثرٌ
 * بطبيعتها، وهي نمط شكوى المالك الأصلية فتبقى بحكمها.
 */
const TABLE_ROW_RE = /^\|.*\|/;
const ENGLISH_RUN_RE = /[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){2,}/;

function structuralSlips(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.replace(FENCED_RE, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^(#{1,4}\s|\|.*\||[-*]\s|\d+[.)]\s)/.test(trimmed)) continue;
    const measured = arabicShare(trimmed);
    if (measured.share !== null && measured.share < 0.5
        && (measured.arabic + measured.latin) >= 12) {
      // صف جدول بلا جملة إنجليزية = خلايا معرّفات، وهي مشروعة بنصّ العقد
      if (TABLE_ROW_RE.test(trimmed) && !ENGLISH_RUN_RE.test(proseOf(trimmed))) continue;
      out.push(trimmed.slice(0, 80));
    }
  }
  return out;
}

/**
 * دالة الحكم — **عتبات العصف الثلاثي المحافظة (2026-08-15)**، لا مجرد أرقام:
 * كان يوجد مقياس بلا حَكَم، فكلُّ مستهلكٍ سيخترع عتبته وتتباعد الأحكام بصمت.
 *
 * لا حكم إلا إذا اجتمع شرطان (وإلا `{slip:false, reason:'short'|'no_prose'}`):
 *   1. النثر ≥ MIN_STRONG_CHARS حرفاً قوياً — الردود القصيرة خارج الحكم.
 *   2. `share < SHARE_THRESHOLD` **أو** ≥ STRUCTURAL_THRESHOLD بنية إنجليزية.
 *
 * العتبات محافظة عمداً (حصّة 0.5 لا 0.65): حارس يُطلق إنذارات كاذبة يُعطَّل ثم
 * لا يحرس شيئاً — درس مكرر. رفعها لاحقاً قرار معايرة على بيانات القياس الرجعي،
 * ويرفع `METRIC_VERSION`.
 */
const SHARE_THRESHOLD = 0.5;
const MIN_STRONG_CHARS = 120;
const STRUCTURAL_THRESHOLD = 2;

function isSlip(text) {
  const measured = arabicShare(text);
  const strong = measured.arabic + measured.latin;
  const script = scriptOf(text);
  if (measured.share === null) return { slip: false, reason: 'no_prose', script, ...measured };
  if (strong < MIN_STRONG_CHARS) return { slip: false, reason: 'short', script, ...measured };
  // ‏OBS-022: نثر فارسي خالص كان يعطي share=1 وحكم `ok` — أعلى من عربيٍّ قيس بجانبه.
  // يسبق فحصَ الحصّة لأن الحصّة عمياء عنه بنيةً؛ و`mixed` **لا يُحكم عليه** تحفظاً
  // (عربيٌّ يقتبس فارسية حالة مشروعة)، فيُسجَّل وسمُه وتستبعده المعايرة إن شاءت.
  if (script === 'fa') return { slip: true, reason: 'script', script, structural: 0, ...measured };
  const slips = structuralSlips(text);
  if (measured.share < SHARE_THRESHOLD) {
    return { slip: true, reason: 'share', script, structural: slips.length, ...measured };
  }
  if (slips.length >= STRUCTURAL_THRESHOLD) {
    return { slip: true, reason: 'structure', script, structural: slips.length, ...measured };
  }
  return { slip: false, reason: 'ok', script, structural: slips.length, ...measured };
}

module.exports = {
  arabicShare, structuralSlips, proseOf, scriptOf, isSlip,
  METRIC_VERSION, SHARE_THRESHOLD, MIN_STRONG_CHARS, STRUCTURAL_THRESHOLD,
};
