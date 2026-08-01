/**
 * نواة توليد الوسائط في «سطر» (م١ من docs/GENERATION-PLAN.md — الجولة 8، البند الأول).
 *
 * سجل مزوّدين بطبقتين (مباشر: openai/gemini · مجمّع: fal) + كتالوج أسعار تقديري مؤرخ
 * + توجيه أرخص-أولاً حسب المفاتيح المتوفرة مع سقوط صريح + تنزيل الأصول إلى
 * `<cwd>/generations/` + سجل JSONL في `<cwd>/.satr/generations.jsonl`.
 *
 * === توسعة الجولة 9 (2026-08-01) ===
 *   • `kind:'audio'` عبر fal (‏fal-ai/ace-step) — مثبت حياً، $0.002 مقيسة لعشر ثوانٍ.
 *   • `refs` تعمل فعلاً: image-to-image عبر `fal-ai/flux/dev/image-to-image` والمرجع
 *     يُمرَّر **data: URI** (بلا رفع لأي خدمة)؛ وكل نموذج لم يثبت مساره يبقى refs_unsupported.
 *   • **افتراضي الصور** صار `fal-ai/gpt-image-1/text-to-image` (قرار المالك v2.1) بعد أن
 *     أثبت المسبار استضافة fal له **بلا BYOK** ورسمه «سطر» بأحرف عربية موصولة صحيحة؛
 *     وflux/schnell يبقى «الأرخص» يُطلب صراحةً. **لا افتراضي للفيديو** (نصّ العقد).
 *   • حارس مجلد المستخدم: `cwd` = home ⇒ `no_project` قبل أي شبكة (من تجربة المالك).
 *   • أسعار الكتالوج صارت **مقيسة حياً** بفرق رصيد fal قبل/بعد كل توليد، لا منقولة من توثيق.
 *
 * === توسعة الجولة 10 (2026-08-02) ===
 *   • مدد `ace-step` المثبتة صارت أربعاً (‏10/30/63/120ث) بمدخل كتالوج مستقل لكل واحدة
 *     وسعر مقيس لها؛ الاختيار عبر حقل `model` القائم فلا يتغيّر شكل الطلب المجمَّد.
 *     `wire_model` يفصل مسار السلك عن معرّف الكتالوج. وما لم يُقس لا يُمرَّر كما هو.
 *
 * ⚠️ «المسبار أولاً» (المبدأ 5 في الخطة): لا يُجمَّد عقد سلك قبل استدعاء حيّ يثبته.
 * `scripts/genmedia-probe.js` شُغّل حياً 2026-08-01 والنتيجة:
 *   • fal  — PROVEN (صورة + فيديو عبر queue). عقده مجمَّد أدناه حرفياً كما رُصد.
 *   • openai — UNPROVEN: المفتاح صالح والمسار يُقبل، لكن الحساب ردّ 400
 *     `billing_hard_limit_reached` ("Billing hard limit has been reached.") فلم تُرصد
 *     بنية استجابة ناجحة قط.
 *   • gemini — UNPROVEN: المسار يُقبل، لكن الحساب ردّ 429 `RESOURCE_EXHAUSTED` مع
 *     `limit: 0` على `generate_content_free_tier_requests` (توليد الصور خارج الطبقة
 *     المجانية) فلم تُرصد بنية استجابة ناجحة قط.
 * لذلك المزوّدان المباشران **معرَّفان في السجل ومعطَّلان** ولا يملكان مسار سلك: التوجيه
 * لا يختارهما، واختيارهما صراحةً يعيد `provider_unproven` fail-closed. لا كود تخميني
 * يدّعي عقداً لم يُرصد. بعد إصلاح الحساب: أعد المسبار ⇒ جمِّد الشكل المرصود ⇒ فعّلهما.
 *
 * 🔒 المفاتيح: بيئة النظام أولاً ثم مخزن «سطر» (keys.get) — لا تدخل نتيجةً أو حدثاً أو
 * سجلاً أبداً، ولا تُطبع في رسالة خطأ. البرومبت في السجل ≤2000 نقطة بعد التنقية، وإن
 * التقطه memory.hasSecret يُخزَّن فارغاً بعلامة `prompt_redacted`.
 *
 * 💰 `budget_usd` سقف صلب: التقدير الذي يتجاوزه يُرفض بـ`over_budget` **قبل أي استدعاء
 * شبكة**، لا أثناءه.
 *
 * صفر اعتماديات: https المدمجة (نمط adapters/gemini.js) — القاعدة 5.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const memory = require('./memory'); // hasSecret — حارس الأسرار المشترك
const inject = require('./inject'); // resolveInside — تحقّق المسارات النسبية داخل cwd

// ============================ الحدود والثوابت ============================

const SCHEMA_VERSION = 1;
const CATALOG_DATE = '2026-08-01'; // تاريخ الكتالوج — كل سعر تقديري منسوب إليه

const MAX_PROMPT_SEND = 4000;      // أقصى برومبت يُرسل للمزوّد (نقاط Unicode)
const MAX_PROMPT_LOG = 2000;       // أقصى برومبت يُخزَّن في السجل (نصّ العقد)
const MAX_REFS = 6;                // سقف المراجع (نصّ العقد)
const MAX_COUNT = 4;               // سقف العدد في الطلب الواحد (نصّ عقد الأداة)
const MAX_REF_BYTES = 8 * 1024 * 1024;    // ج9: سقف حجم ملف المرجع قبل ترميزه data: URI
const MAX_ASSET_BYTES = 64 * 1024 * 1024; // سقف حجم الأصل الواحد المنزَّل
const LOG_MAX_BYTES = 4 * 1024 * 1024;    // سقف ملف السجل (نصّ العقد) — يُقصّ الأقدم
const LOG_TRIM_TO = Math.floor(LOG_MAX_BYTES * 0.75);

const SUBMIT_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 3000;
const POLL_BUDGET_IMAGE_MS = 300000;
const POLL_BUDGET_VIDEO_MS = 900000;
const POLL_BUDGET_AUDIO_MS = 300000;
const ASSET_TIMEOUT_MS = 180000;

// ج9: `audio` أُضيف بعد إثباته حياً على fal (‏fal-ai/ace-step) — توسعة قيم لا حقول.
const KINDS = new Set(['image', 'video', 'audio']);

/**
 * امتدادات الأصول المسموحة (تُشتق من content-type لا من رابط المزوّد).
 * هذه **قائمة سماح أمنية** لا ادعاء عقد: المثبت حياً هو `image/jpeg` و`image/png`
 * و`video/mp4` و`audio/wav`؛ والبقية مُدرجة لأنها أنواع وسائط شائعة غير خطرة، وأي نوع
 * خارجها يُرفض بـ`asset_type_rejected` قبل الكتابة.
 */
const EXT_BY_TYPE = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
};

// امتدادات المراجع المقبولة ⇒ نوع data: URI (المدخل لا يُشتق من محتوى الملف)
const REF_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

// ============================ كتالوج النماذج (تقديري ومؤرَّخ) ============================
/**
 * `unit_cost_usd` **مقيس حياً** لكل نموذج مثبت (فرق رصيد fal قبل/بعد توليد واحد، ج9)
 * ويبقى موسوماً تقديرياً لأنه قياسة واحدة بتاريخ CATALOG_DATE لا فاتورة المزوّد.
 * `proven` يعكس المسبار الحيّ حصراً؛ غير المثبت لا يدخل التوجيه.
 *
 * `default_for_kind` (ج9 — قرار المالك v2.1): النموذج المختار عند **غياب** model صريح.
 * للصور هو GPT Image لأنه الوحيد الذي أثبت رسم النص العربي صحيحاً موصولاً؛ وflux/schnell
 * يبقى «الأرخص» يُطلب صراحةً. **للفيديو لا افتراضي مفروض** (نصّ العقد): غياب model يسقط
 * إلى قاعدة الأرخص-أولاً العامة، ومهارة satr-generate تعرض الخيارات بأسعارها على المستخدم.
 */
const MODELS = [
  {
    id: 'fal-ai/gpt-image-1/text-to-image',
    provider: 'fal',
    kind: 'image',
    label: 'GPT Image — صور بنص عربي صحيح (fal)',
    unit: 'image',
    unit_cost_usd: 0.02, // مقيس حياً: 9.9049575 -> 9.8849575
    max_count: 4,
    supports_refs: false,
    proven: true,
    default_for_kind: 'image',
    arabic_text: true,
    // مجمَّد من المسبار: quality=low + 1024x1024 أعاد PNG ‏1024×1024 (970128 بايت)
    wire: { image_size: '1024x1024', quality: 'low' },
  },
  {
    id: 'fal-ai/flux/schnell',
    provider: 'fal',
    kind: 'image',
    label: 'FLUX schnell — الأرخص للمشاهد بلا نص (fal)',
    unit: 'image',
    unit_cost_usd: 0.003, // مقيس حياً: 9.8549575 -> 9.8519575
    max_count: 4,
    supports_refs: false,
    proven: true,
    arabic_text: false,
    // مجمَّد من المسبار: image_size=square_hd أعاد 1024×1024 image/jpeg
    wire: { image_size: 'square_hd' },
  },
  {
    id: 'fal-ai/flux/dev/image-to-image',
    provider: 'fal',
    kind: 'image',
    label: 'FLUX dev image-to-image — تعديل صورة مرجعية (fal)',
    unit: 'image',
    unit_cost_usd: 0.03, // مقيس حياً: 9.8849575 -> 9.8549575
    max_count: 4,
    supports_refs: true,
    max_refs: 1, // المسبار أثبت `image_url` مفرداً — لا مسار لأكثر من مرجع
    proven: true,
    arabic_text: false,
    // مجمَّد من المسبار: {prompt, image_url:data-URI, strength:0.6} ⇒ images[0].url
    wire: { strength: 0.6 },
  },
  // --- الفيديو: ثلاثة خيارات مثبتة و**لا افتراضي معلن** (نصّ العقد v2.1). مهارة
  // satr-generate تعرضها بأسعارها على المستخدم؛ وغياب model يسقط إلى الأرخص-أولاً العام.
  {
    id: 'fal-ai/ltx-video',
    provider: 'fal',
    kind: 'video',
    label: 'LTX Video — الأرخص للمشاهد القصيرة (fal)',
    unit: 'video',
    // مقيس حياً في ج9: 9.5461241667 -> 9.5261241667 = 0.02. كان تقدير ج8 ‏0.04 (ضِعف
    // الحقيقة) — أول تصحيح يثبت لماذا يجب أن يكون السعر مقيساً لا منقولاً.
    unit_cost_usd: 0.02,
    max_count: 1,
    supports_refs: false,
    proven: true,
    // مرصود: 71 استقصاءً و229143ms وأصل 2433833 بايت
    wire: {},
  },
  {
    id: 'fal-ai/ltxv-13b-098-distilled',
    provider: 'fal',
    kind: 'video',
    label: 'LTXV 13B distilled — جودة أعلى وزمن أطول (fal)',
    unit: 'video',
    unit_cost_usd: 0.052, // مقيس حياً: 9.8519575 -> 9.7999575
    max_count: 1,
    supports_refs: false,
    proven: true,
    // مرصود: 55 استقصاءً و177731ms حتى الاكتمال — أبطأ بكثير من LTX العادي
    wire: {},
  },
  {
    id: 'fal-ai/wan/v2.2-5b/text-to-video',
    provider: 'fal',
    kind: 'video',
    label: 'WAN 2.2 5B — الأجود والأغلى (fal)',
    unit: 'video',
    unit_cost_usd: 0.250833, // مقيس حياً: 9.7999575 -> 9.5491241667
    max_count: 1,
    supports_refs: false,
    proven: true,
    // مرصود: 6 استقصاءات و19571ms، وأصل 422785 بايت (أضخم بخمسة أضعاف من LTXV)
    wire: {},
  },
  // --- الصوت: مدخل كتالوج **لكل مدة مقيسة** (ج10) ---
  // لماذا مدخلات منفصلة لا حقل `duration` في الطلب: سعر الوحدة في هذا الكتالوج **مقيس**،
  // فلو صار طول المقطع حقلاً يرسله المتصل لانكسر ثبات `unit_cost_usd` وتعذّر على
  // `estimate()` حساب الكلفة من الكتالوج وحده قبل الشبكة. وبهذا الشكل أيضاً **لا يتغيّر
  // شكل الطلب المجمَّد** `{cwd,kind,prompt,model?,count?,refs?,budget_usd?}` ولا عقد أداة
  // `generate_media` (ملك كودكس) — الاختيار يمر بحقل `model` القائم.
  // `wire_model` هو مسار السلك الفعلي؛ المعرّف يبقى ضمن [A-Za-z0-9._/-] كي يعرضه مربع
  // إذن الكلفة (‏`mediaToken` في tools.js يرفض ما عداها).
  // المدد الأربع مقيسة حياً وسعرها خطي تماماً عند $0.0002/ثانية (4 نقاط قياس).
  {
    id: 'fal-ai/ace-step',
    provider: 'fal',
    kind: 'audio',
    label: 'ACE-Step — مقطع صوتي قصير 10ث (fal)',
    unit: 'clip',
    unit_cost_usd: 0.002, // مقيس حياً ج9: 9.9069575 -> 9.9049575
    max_count: 1,
    supports_refs: false,
    proven: true,
    wire: { duration: 10 },
    duration_seconds: 10,
  },
  {
    id: 'fal-ai/ace-step-30s',
    wire_model: 'fal-ai/ace-step',
    provider: 'fal',
    kind: 'audio',
    label: 'ACE-Step — مقطع صوتي 30ث (fal)',
    unit: 'clip',
    unit_cost_usd: 0.006, // مقيس حياً ج10: 9.5041241667 -> 9.4981241667 (الفعلي 29.91ث)
    max_count: 1,
    supports_refs: false,
    proven: true,
    wire: { duration: 30 },
    duration_seconds: 30,
  },
  {
    id: 'fal-ai/ace-step-63s',
    wire_model: 'fal-ai/ace-step',
    provider: 'fal',
    kind: 'audio',
    label: 'ACE-Step — موسيقى إعلان 63ث (fal)',
    unit: 'clip',
    unit_cost_usd: 0.0126, // مقيس حياً ج10: 9.4981241667 -> 9.4855241667 (الفعلي 62.97ث)
    max_count: 1,
    supports_refs: false,
    proven: true,
    wire: { duration: 63 },
    duration_seconds: 63,
  },
  {
    id: 'fal-ai/ace-step-120s',
    wire_model: 'fal-ai/ace-step',
    provider: 'fal',
    kind: 'audio',
    label: 'ACE-Step — مقطع صوتي 120ث (fal)',
    unit: 'clip',
    unit_cost_usd: 0.024, // مقيس حياً ج10: 9.4855241667 -> 9.4615241667 (الفعلي 119.91ث)
    max_count: 1,
    supports_refs: false,
    proven: true,
    wire: { duration: 120 },
    duration_seconds: 120,
  },
  {
    id: 'gpt-image-1-mini',
    provider: 'openai',
    kind: 'image',
    label: 'GPT Image mini (OpenAI — غير مثبت)',
    unit: 'image',
    unit_cost_usd: 0.005,
    max_count: 4,
    supports_refs: false,
    proven: false,
    unproven_reason: 'billing_hard_limit_reached',
  },
  {
    id: 'gemini-2.5-flash-image',
    provider: 'gemini',
    kind: 'image',
    label: 'Nano Banana (Gemini — غير مثبت)',
    unit: 'image',
    unit_cost_usd: 0.039,
    max_count: 4,
    supports_refs: false,
    proven: false,
    unproven_reason: 'free_tier_quota_zero',
  },
];

// ============================ سجل المزوّدين ============================
const PROVIDERS = [
  {
    name: 'fal',
    tier: 'aggregator',
    label: 'fal.ai',
    keyName: 'FAL_KEY',
    enabled: true,
    proven: true,
    baseUrl: 'https://queue.fal.run',
    assetHosts: ['fal.media'], // الأصول تُجلب من هذا النطاق حصراً (أو نطاقاته الفرعية)
  },
  {
    name: 'openai',
    tier: 'direct',
    label: 'OpenAI (مباشر)',
    keyName: 'OPENAI_API_KEY',
    enabled: false,
    proven: false,
    unproven: {
      code: 'billing_hard_limit_reached',
      probed_at: '2026-08-01', // أُعيد المسبار في ج9 والنتيجة لم تتغيّر (400 نفسه لكلا النموذجين)
      note: 'المفتاح مقبول والمسار صحيح، لكن الحساب ردّ 400 قبل أي توليد. ارفع حد الإنفاق '
        + 'أو أضِف رصيداً في platform.openai.com ثم أعد تشغيل المسبار. '
        + 'وحتى ذلك الحين يتوفّر GPT Image نفسه عبر fal بلا حساب OpenAI.',
    },
  },
  {
    name: 'gemini',
    tier: 'direct',
    label: 'Google Gemini (مباشر)',
    keyName: 'GEMINI_API_KEY',
    enabled: false,
    proven: false,
    unproven: {
      code: 'free_tier_quota_zero',
      probed_at: '2026-08-01', // أُعيد المسبار في ج9 والنتيجة لم تتغيّر (429 نفسه)
      note: 'المسار صحيح، لكن حصة الطبقة المجانية لتوليد الصور صفر (429 RESOURCE_EXHAUSTED, '
        + 'limit: 0). فعّل الفوترة على مشروع المفتاح ثم أعد تشغيل المسبار.',
    },
  },
  {
    // خانة م٣ (رصيد سطر المُدار) — معرَّفة ومعطَّلة، بلا أي منطق في ج8.
    name: 'managed',
    tier: 'managed',
    label: 'رصيد «سطر» المُدار (لاحقاً)',
    keyName: '',
    enabled: false,
    proven: false,
    managed: true,
    unproven: { code: 'not_available_yet', probed_at: '', note: 'يُفتح في المرحلة ٣ من خطة التسييل.' },
  },
];

function providerByName(name) {
  return PROVIDERS.find((p) => p.name === name) || null;
}

/**
 * ج10: مسار النموذج على سلك المزوّد. يساوي معرّف الكتالوج إلا حين يحمل المعرّف لاحقة
 * تمييز داخلية (مثل لاحقة المدة `-63s`) فيُعلن `wire_model` صراحةً. لا اشتقاق بقصّ
 * اللاحقة — المسار معلن في الكتالوج كي لا يخترع الكود معرّفاً لم يثبته المسبار.
 */
function wireModelOf(model) {
  return (model && model.wire_model) || (model && model.id) || '';
}

/**
 * مصدر قائمة النماذج. `ctx.models` منفذ **داخلي للاختبار القطعي حصراً** (نظير `ctx.request`
 * و`ctx.baseUrls`): ctx يأتي من العملية الرئيسية أو الأدوات ولا يعبر من renderer إطلاقاً،
 * ويبقى السائق محصوراً في DRIVERS فلا يفتح الحقن مزوّداً جديداً. غيابه = الكتالوج الحقيقي.
 */
function modelsOf(ctx) {
  return (ctx && Array.isArray(ctx.models) && ctx.models.length) ? ctx.models : MODELS;
}

// ============================ المفاتيح ============================
// بيئة النظام أولاً ثم مخزن «سطر» — القيمة لا تغادر هذه الوحدة إلى نتيجة أو سجل.
function resolveKey(keyName, ctx) {
  if (!keyName) return '';
  const env = (ctx && ctx.env) || process.env;
  const fromEnv = String((env && env[keyName]) || '').trim();
  if (fromEnv) return fromEnv;
  if (ctx && typeof ctx.getKey === 'function') {
    try { return String(ctx.getKey(keyName) || '').trim(); } catch (e) { return ''; }
  }
  try {
    // lazy: keys.js يستورد electron — لا نحمّله إلا عند الحاجة كي تعمل الاختبارات بلا Electron
    return String(require('./keys').get(keyName) || '').trim();
  } catch (e) { return ''; }
}

function hasKey(provider, ctx) {
  return !!resolveKey(provider.keyName, ctx);
}

// ============================ التنقية ============================

// إزالة محارف التحكم C0/C1 وBidi ثم طيّ الفراغات
function cleanText(value) {
  let out = String(value == null ? '' : value);
  let result = '';
  for (const ch of out) {
    const cp = ch.codePointAt(0);
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    const bidi = cp === 0x061c || cp === 0x200e || cp === 0x200f
      || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    result += (control || bidi) ? ' ' : ch;
  }
  return result.replace(/\s+/g, ' ').trim();
}

// قصّ بنقاط Unicode (لا وحدات UTF-16) كي لا ينكسر زوج بديل
function slicePoints(value, max) {
  const points = Array.from(String(value || ''));
  return points.length <= max ? points.join('') : points.slice(0, max).join('');
}

/**
 * برومبت السجل: منقّى ومقصوص ≤2000 نقطة. إن التقطه memory.hasSecret يُخزَّن فارغاً
 * بعلامة `prompt_redacted` (نصّ العقد: «يُخزَّن فارغاً بعلامة»).
 */
function logPrompt(rawPrompt) {
  const cleaned = cleanText(rawPrompt);
  if (memory.hasSecret(cleaned)) return { prompt: '', redacted: true };
  return { prompt: slicePoints(cleaned, MAX_PROMPT_LOG), redacted: false };
}

// اسم أصل منقّى بالبناء (لا يُشتق من البرومبت أو من رابط المزوّد إطلاقاً)
function assetName(kind, stamp, rand, index, ext) {
  return 'gen-' + kind + '-' + stamp + '-' + rand + '-' + index + ext;
}

function uniquePath(dir, name, exists) {
  const check = exists || fs.existsSync;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= 999; i += 1) {
    const candidate = path.join(dir, i === 1 ? name : stem + '-' + i + ext);
    if (!check(candidate)) return candidate;
  }
  return null;
}

/**
 * المراجع: مسارات نسبية داخل cwd حصراً (نفس حارس inject.resolveInside: لا مطلق، لا `..`،
 * ولا هروب symlink)، بسقف MAX_REFS. أي مرجع غير صالح يُفشل الطلب كاملاً fail-closed.
 */
function sanitizeRefs(refs, cwd) {
  if (refs == null) return { ok: true, refs: [] };
  if (!Array.isArray(refs)) return { ok: false, error_code: 'refs_invalid' };
  if (refs.length > MAX_REFS) return { ok: false, error_code: 'refs_invalid' };
  const out = [];
  for (const raw of refs) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error_code: 'refs_invalid' };
    const rel = cleanText(raw).replace(/\\/g, '/');
    if (!rel) return { ok: false, error_code: 'refs_invalid' };
    const abs = inject.resolveInside(cwd, rel);
    if (!abs) return { ok: false, error_code: 'refs_outside' };
    let stat;
    try { stat = fs.statSync(abs); } catch (e) { return { ok: false, error_code: 'refs_missing' }; }
    if (!stat.isFile()) return { ok: false, error_code: 'refs_missing' };
    if (!out.includes(rel)) out.push(rel);
  }
  return { ok: true, refs: out };
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/**
 * 🏠 حارس مجلد المستخدم (ج9 — من تجربة المالك الأولى): توليد بـ`cwd` يساوي مجلد المنزل
 * كان يسكب الأصول والسجل في `C:\Users\<name>\generations` بلا أن ينتبه أحد. يُرفض الآن
 * **قبل أي استدعاء شبكة** بـ`no_project`.
 *
 * المقارنة على المسار الحقيقي (realpath) كي لا يلتفّ عليها رابط رمزي أو اسم 8.3، وبلا
 * حساسية حالة على ويندوز. فشل realpath يسقط إلى المسار المُطبَّع (فحص أضعف لا تجاوز).
 * `ctx.homeDir` منفذ اختبار داخلي فقط (نظير ctx.models — لا يعبر من renderer).
 */
function normalizeDirPath(p) {
  let out = path.resolve(String(p || ''));
  try { out = fs.realpathSync.native ? fs.realpathSync.native(out) : fs.realpathSync(out); }
  catch (e) { /* غير موجود أو ممنوع — يبقى المُطبَّع */ }
  out = out.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function isHomeDir(cwd, ctx) {
  let home = '';
  try { home = (ctx && ctx.homeDir) || require('os').homedir(); } catch (e) { home = ''; }
  if (!home) return false;
  return normalizeDirPath(cwd) === normalizeDirPath(home);
}

// ============================ الكتالوج والتقدير ============================

function modelPublic(m) {
  const out = {
    id: m.id, provider: m.provider, kind: m.kind, label: m.label,
    unit: m.unit, unit_cost_usd: m.unit_cost_usd, max_count: m.max_count,
    supports_refs: m.supports_refs, proven: m.proven,
    estimate: true, catalog_date: CATALOG_DATE,
  };
  // ج9: حقول عرض تستهلكها مهارة satr-generate لعرض الخيارات على المستخدم
  if (m.default_for_kind) out.default_for_kind = m.default_for_kind;
  if (m.supports_refs) out.max_refs = m.max_refs || 1;
  if (typeof m.arabic_text === 'boolean') out.arabic_text = m.arabic_text;
  if (m.duration_seconds) out.duration_seconds = m.duration_seconds;
  if (!m.proven) out.unproven_reason = m.unproven_reason || '';
  return out;
}

function providerPublic(p) {
  const out = {
    name: p.name, tier: p.tier, label: p.label, keyName: p.keyName,
    enabled: p.enabled, proven: p.proven,
  };
  if (p.managed) out.managed = true;
  if (p.unproven) out.unproven = { code: p.unproven.code, probed_at: p.unproven.probed_at, note: p.unproven.note };
  return out;
}

/** كتالوج عام: نماذج ومزوّدون بأسعار تقديرية مؤرخة. لا مفاتيح ولا قيم. */
function listCatalog() {
  return {
    schema_version: SCHEMA_VERSION,
    catalog_date: CATALOG_DATE,
    estimate: true,
    kinds: Array.from(KINDS),
    providers: PROVIDERS.map(providerPublic),
    models: MODELS.map(modelPublic),
  };
}

function costFor(model, count) {
  const n = Math.max(1, Math.min(count || 1, model.max_count));
  return Math.round(model.unit_cost_usd * n * 1e6) / 1e6;
}

/** مرشّحو التوجيه: مثبت + مزوّده مفعّل + المفتاح مضبوط + يدعم النوع. الأرخص أولاً. */
function candidatesFor(kind, ctx) {
  return modelsOf(ctx)
    .filter((m) => m.kind === kind && m.proven)
    .filter((m) => {
      const p = providerByName(m.provider);
      return p && p.enabled && p.proven && hasKey(p, ctx);
    })
    .sort((a, b) => a.unit_cost_usd - b.unit_cost_usd);
}

/**
 * ترتيب التوجيه عند **غياب** model صريح (ج9 — قرار المالك v2.1):
 *   • مراجع مطلوبة ⇒ لا يدخل إلا نموذج يدعمها فعلاً (وإلا لكان الفشل مضموناً).
 *   • وإلا: الافتراضي المعلن للنوع أولاً ثم البقية أرخص-فأرخص.
 *   • **لا افتراضي للفيديو** ⇒ الترتيب يبقى الأرخص-أولاً كما كان.
 * الميزانية **لا تُرشِّح هنا**: الفحص لكل مرشّح داخل حلقة التوليد كي يُذكر تجاوز السقف
 * صراحةً في `fallbacks` بدل اختفاء المرشّح صامتاً.
 */
function routeChain(kind, ctx, wantRefs) {
  let cands = candidatesFor(kind, ctx);
  if (wantRefs) cands = cands.filter((m) => m.supports_refs);
  const def = cands.find((m) => m.default_for_kind === kind);
  return def ? [def].concat(cands.filter((m) => m !== def)) : cands;
}

/** أول مرشّح تسعه الميزانية (وإلا الأول — فيعيد generate رمز over_budget صريحاً). */
function pickWithinBudget(chain, count, budget) {
  if (budget == null || !Number.isFinite(budget)) return chain[0];
  return chain.find((m) => costFor(m, count) <= budget) || chain[0];
}

/**
 * التقدير قبل أي شبكة. نموذج صريح ⇒ مزوّده (ولو غير مثبت — نعيد سبباً صريحاً)؛
 * غيابه ⇒ الأرخص المتاح للنوع.
 */
function estimate(req, ctx) {
  const r = req || {};
  const kind = String(r.kind || '');
  if (!KINDS.has(kind)) return { ok: false, error_code: 'unsupported_kind' };

  const prompt = cleanText(r.prompt);
  if (!prompt) return { ok: false, error_code: 'bad_input' };

  const rawCount = r.count == null ? 1 : r.count;
  if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 1 || rawCount > MAX_COUNT) {
    return { ok: false, error_code: 'bad_count' };
  }

  // ج9: وجود مراجع يغيّر التوجيه — لا نختار نموذجاً يفشل حتماً بها
  const wantRefs = Array.isArray(r.refs) && r.refs.length > 0;
  const budget = (r.budget_usd != null && Number.isFinite(Number(r.budget_usd)))
    ? Number(r.budget_usd) : null;

  let chosen = null;
  let chain = [];
  if (r.model) {
    const wanted = String(r.model);
    const model = modelsOf(ctx).find((m) => m.id === wanted);
    if (!model) return { ok: false, error_code: 'unknown_model' };
    if (model.kind !== kind) return { ok: false, error_code: 'kind_mismatch' };
    const provider = providerByName(model.provider);
    if (!model.proven || !provider || !provider.enabled || !provider.proven) {
      return {
        ok: false, error_code: 'provider_unproven', provider: model.provider,
        reason: (provider && provider.unproven && provider.unproven.code) || model.unproven_reason || '',
      };
    }
    if (!hasKey(provider, ctx)) return { ok: false, error_code: 'no_key', provider: provider.name, key_name: provider.keyName };
    chosen = model;
  } else {
    chain = routeChain(kind, ctx, wantRefs);
    if (!chain.length) {
      // فرّق بين «لا مزوّد لهذا النوع» و«لا نموذج يدعم المراجع»
      return wantRefs && candidatesFor(kind, ctx).length
        ? { ok: false, error_code: 'refs_unsupported', kind }
        : { ok: false, error_code: 'no_provider', kind };
    }
    chosen = pickWithinBudget(chain, rawCount, budget);
  }

  if (rawCount > chosen.max_count) return { ok: false, error_code: 'count_exceeded', max_count: chosen.max_count };

  return {
    ok: true,
    kind,
    provider: chosen.provider,
    model: chosen.id,
    count: rawCount,
    cost_usd_estimate: costFor(chosen, rawCount),
    catalog_date: CATALOG_DATE,
    estimate: true,
    alternatives: chain.filter((m) => m !== chosen).map((m) => m.id),
  };
}

// ============================ نقل HTTP (https المدمجة) ============================
function defaultRequest(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad_url')); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(payload.length); }
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method, headers: h,
    }, (res) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_ASSET_BYTES) { aborted = true; res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) { reject(new Error('asset_too_large')); return; }
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        let json = null;
        if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* ليس JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, json, contentType: ct });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || SUBMIT_TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function transportOf(ctx) {
  return (ctx && typeof ctx.request === 'function') ? ctx.request : defaultRequest;
}
function sleeper(ctx) {
  return (ctx && typeof ctx.sleep === 'function')
    ? ctx.sleep
    : ((ms) => new Promise((r) => setTimeout(r, ms)));
}
function baseUrlFor(provider, ctx) {
  const override = ctx && ctx.baseUrls && ctx.baseUrls[provider.name];
  return override || provider.baseUrl;
}

/**
 * 🔒 رابط الأصل: https ونطاق المزوّد المعلن حصراً. رابط من نطاق آخر (استجابة مزوّد
 * غريبة/مخترقة) يُرفض قبل أي جلب. `ctx.extraAssetHosts` منفذ اختبار محلي فقط.
 */
function isAllowedAssetUrl(rawUrl, provider, ctx) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { return false; }
  const extra = (ctx && Array.isArray(ctx.extraAssetHosts)) ? ctx.extraAssetHosts : [];
  if (extra.includes(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
  if (u.protocol !== 'https:') return false;
  return (provider.assetHosts || []).some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

// ============================ سائق fal (مجمَّد من المسبار الحيّ) ============================
/**
 * العقد المرصود حرفياً 2026-08-01 (codex-cli غير معني — هذا سلك fal):
 *  1) POST {base}/{model}  header `Authorization: Key <FAL_KEY>`  body: مدخلات النموذج
 *     ⇒ 200 { status:'IN_QUEUE', request_id(36), response_url, status_url, cancel_url,
 *             logs:null, metrics:{}, queue_position:0 }
 *  2) GET status_url ⇒ **HTTP 202** ما دام IN_QUEUE/IN_PROGRESS، و**HTTP 200** عند COMPLETED.
 *     التسلسل المرصود: IN_QUEUE -> IN_PROGRESS -> COMPLETED.
 *  3) GET response_url ⇒ 200 وبنية الخرج:
 *     صورة: { images:[{url,width,height,content_type}], timings, seed, has_nsfw_concepts, prompt }
 *     فيديو: { video:{url,content_type,file_name,file_size}, seed }
 *     صوت (ج9): { audio:{url,content_type:"audio/wav",file_name,file_size:null}, seed, tags, lyrics }
 *  4) الأصل يُجلب بـGET عادي على url **بلا ترويسة اعتماد**.
 * ⚠️ status_url/response_url تُستعملان كما أعادهما المزوّد ولا تُبنيان محلياً: المسار
 *    المرصود يطوي `fal-ai/flux/schnell` إلى `fal-ai/flux/requests/<id>`.
 * ⚠️ **حدّ upstream مثبت في ج9**: `status=COMPLETED` **لا يعني نجاحاً**. رصد المسبار حياً
 *    وظيفة بلغت COMPLETED ثم أعاد جلب الخرج **422** (‏`detail[0].type="missing"`) وأخرى
 *    **404**. لذلك فحص `out.status !== 200` بعد الاكتمال شرط لازم لا احتياط.
 * ⚠️ المراجع (ج9): تُمرَّر **data: URI** في `image_url` — أثبته المسبار حياً فلا حاجة إلى
 *    نقطة رفع ولا يغادر ملف المستخدم إلى أي خدمة تخزين.
 */
async function falGenerate(model, args, ctx, provider, key) {
  const request = transportOf(ctx);
  const sleep = sleeper(ctx);
  const base = baseUrlFor(provider, ctx);
  const auth = { authorization: 'Key ' + key };

  const input = Object.assign({}, model.wire, { prompt: args.prompt });
  if (model.kind === 'image') input.num_images = args.count;
  if (model.supports_refs && args.refDataUri) input.image_url = args.refDataUri;

  // ج10: معرّف الكتالوج قد يحمل لاحقة مدة (‏`…-63s`) بينما مسار السلك هو النموذج نفسه
  const submit = await request('POST', base + '/' + wireModelOf(model), auth, input, SUBMIT_TIMEOUT_MS);
  if (submit.status !== 200 || !submit.json || !submit.json.status_url || !submit.json.response_url) {
    return { ok: false, error_code: 'provider_error', http_status: submit.status };
  }
  const statusUrl = String(submit.json.status_url);
  const responseUrl = String(submit.json.response_url);

  const budget = model.kind === 'video' ? POLL_BUDGET_VIDEO_MS
    : (model.kind === 'audio' ? POLL_BUDGET_AUDIO_MS : POLL_BUDGET_IMAGE_MS);
  const started = Date.now();
  let completed = false;
  while (Date.now() - started < budget) {
    await sleep(POLL_INTERVAL_MS);
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error_code: 'aborted' };
    let st;
    try { st = await request('GET', statusUrl, auth, null, SUBMIT_TIMEOUT_MS); }
    catch (e) { return { ok: false, error_code: 'provider_error' }; }
    const status = st.json && st.json.status ? String(st.json.status) : '';
    if (status === 'COMPLETED') { completed = true; break; }
    if (status === 'FAILED' || status === 'ERROR') return { ok: false, error_code: 'provider_failed' };
  }
  if (!completed) return { ok: false, error_code: 'timeout' };

  let out;
  try { out = await request('GET', responseUrl, auth, null, SUBMIT_TIMEOUT_MS); }
  catch (e) { return { ok: false, error_code: 'provider_error' }; }
  if (out.status !== 200 || !out.json) return { ok: false, error_code: 'provider_error', http_status: out.status };

  const assets = [];
  if (model.kind === 'image') {
    for (const img of (Array.isArray(out.json.images) ? out.json.images : [])) {
      if (img && img.url) assets.push({ url: String(img.url), contentType: String(img.content_type || '') });
    }
  } else if (model.kind === 'audio') {
    const a = out.json.audio || (Array.isArray(out.json.audios) ? out.json.audios[0] : null);
    if (a && a.url) assets.push({ url: String(a.url), contentType: String(a.content_type || '') });
  } else {
    const v = out.json.video || (Array.isArray(out.json.videos) ? out.json.videos[0] : null);
    if (v && v.url) assets.push({ url: String(v.url), contentType: String(v.content_type || '') });
  }
  if (!assets.length) return { ok: false, error_code: 'no_assets' };
  return { ok: true, assets };
}

const DRIVERS = { fal: falGenerate };

/**
 * ج9 — بناء data: URI للمرجع الأول. المسار مُتحقَّق منه مسبقاً بـ`sanitizeRefs`
 * (‏`inject.resolveInside`: داخل cwd، لا مطلق، لا `..`، ولا هروب symlink)؛ هنا نضيف
 * سقف الحجم ونوع الامتداد من قائمة سماح — لا يُشتق النوع من محتوى الملف.
 */
function refDataUri(cwd, rel) {
  const abs = inject.resolveInside(cwd, rel);
  if (!abs) return { ok: false, error_code: 'refs_outside' };
  const mime = REF_MIME_BY_EXT[path.extname(abs).toLowerCase()];
  if (!mime) return { ok: false, error_code: 'refs_type_rejected' };
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { return { ok: false, error_code: 'refs_missing' }; }
  if (!stat.isFile()) return { ok: false, error_code: 'refs_missing' };
  if (stat.size > MAX_REF_BYTES) return { ok: false, error_code: 'refs_too_large' };
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, error_code: 'refs_missing' }; }
  return { ok: true, uri: 'data:' + mime + ';base64,' + buf.toString('base64') };
}

// ============================ كتابة الأصول ============================
async function downloadAssets(assets, opts) {
  const { cwd, kind, provider, ctx, stamp, rand } = opts;
  const request = transportOf(ctx);
  const dir = path.join(cwd, 'generations');
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return { ok: false, error_code: 'write_failed' }; }

  const files = [];
  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    if (!isAllowedAssetUrl(asset.url, provider, ctx)) return { ok: false, error_code: 'asset_rejected' };
    let res;
    try { res = await request('GET', asset.url, {}, null, ASSET_TIMEOUT_MS); }
    catch (e) {
      return { ok: false, error_code: e && e.message === 'asset_too_large' ? 'asset_too_large' : 'provider_error' };
    }
    if (res.status !== 200 || !res.buffer || !res.buffer.length) return { ok: false, error_code: 'provider_error' };
    if (res.buffer.length > MAX_ASSET_BYTES) return { ok: false, error_code: 'asset_too_large' };

    const type = String(res.contentType || asset.contentType || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return { ok: false, error_code: 'asset_type_rejected' };

    const target = uniquePath(dir, assetName(kind, stamp, rand, i + 1, ext));
    if (!target) return { ok: false, error_code: 'write_failed' };
    try { fs.writeFileSync(target, res.buffer); }
    catch (e) { return { ok: false, error_code: 'write_failed' }; }
    files.push(path.relative(cwd, target).replace(/\\/g, '/'));
  }
  return { ok: true, files };
}

// ============================ سجل JSONL ============================
function logFileFor(cwd) {
  return path.join(cwd, '.satr', 'generations.jsonl');
}

/** قصّ الأقدم حين يتجاوز السجل السقف — temp+rename، أفضل جهد. */
function rotate(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= LOG_MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let kept = lines;
    while (kept.length > 1 && Buffer.byteLength(kept.join('\n') + '\n', 'utf8') > LOG_TRIM_TO) {
      kept = kept.slice(1); // الأقدم أولاً
    }
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, kept.join('\n') + '\n', 'utf8');
    fs.renameSync(temp, file);
  } catch (e) { /* أفضل جهد — فشل القصّ لا يكسر التوليد */ }
}

/** إلحاق سطر واحد (O_APPEND ذرّي أفضل جهد). الفشل لا يكسر الدور. */
function appendLog(cwd, entry) {
  try {
    const file = logFileFor(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    rotate(file);
    return true;
  } catch (e) { return false; }
}

/** قراءة أحدث N سطر منقّى (يستهلكها IPC عند كودكس). */
function readLog(cwd, limit) {
  const max = Math.max(1, Math.min(limit || 200, 1000));
  try {
    const lines = fs.readFileSync(logFileFor(cwd), 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-max)) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') out.push(entry);
      } catch (e) { /* سطر تالف — يُتخطى */ }
    }
    return out.reverse(); // الأحدث أولاً
  } catch (e) { return []; }
}

function buildEntry(base, extra) {
  // ترتيب حقول v1 كما في العقد المجمَّد
  const entry = {
    id: base.id,
    at: base.at,
    kind: base.kind,
    provider: base.provider,
    model: base.model,
    prompt: base.prompt,
    refs: base.refs,
    files: extra.files || [],
    cost_usd_estimate: base.cost_usd_estimate,
    catalog_date: CATALOG_DATE,
    status: extra.status,
  };
  if (base.prompt_redacted) entry.prompt_redacted = true;
  if (extra.error_code) entry.error_code = extra.error_code;
  return entry;
}

// ============================ التوليد ============================
/**
 * `generate(req, ctx)` — req = {cwd, kind, prompt, model?, count?, refs?, budget_usd?}
 * ctx (اختياري، للحقن في الاختبار): {request, sleep, baseUrls, extraAssetHosts, env,
 * getKey, now, random, signal}
 */
async function generate(req, ctx) {
  const r = req || {};
  const context = ctx || {};
  const now = typeof context.now === 'function' ? context.now() : Date.now();
  const rand = typeof context.random === 'function'
    ? String(context.random()) : crypto.randomBytes(4).toString('hex');
  const id = 'gen_' + now + '_' + rand;
  const at = new Date(now).toISOString();

  const cwd = typeof r.cwd === 'string' ? r.cwd : '';
  if (!cwd || !path.isAbsolute(cwd) || !isDirectory(cwd)) {
    return { ok: false, id, error_code: 'bad_cwd', message: 'مجلد المشروع غير صالح.' };
  }

  // 🏠 ج9: مجلد المستخدم ليس مشروعاً — يُرفض قبل التقدير وقبل أي شبكة
  if (isHomeDir(cwd, context)) {
    return { ok: false, id, error_code: 'no_project', message: MESSAGES.no_project };
  }

  // 1) التقدير أولاً — لا شبكة قبله
  const plan = estimate(r, context);
  if (!plan.ok) {
    return { ok: false, id, error_code: plan.error_code, provider: plan.provider || '', message: messageFor(plan) };
  }

  // 2) المراجع
  const refs = sanitizeRefs(r.refs, cwd);
  if (!refs.ok) {
    return { ok: false, id, error_code: refs.error_code, message: messageFor({ error_code: refs.error_code }) };
  }
  const model = modelsOf(context).find((m) => m.id === plan.model);
  if (refs.refs.length && !model.supports_refs) {
    return {
      ok: false, id, error_code: 'refs_unsupported',
      message: 'النموذج المختار (' + model.id + ') لا يملك مسار مراجع مثبتاً بالمسبار — '
        + 'استعمل نموذجاً يدعم المراجع أو أزِلها.',
    };
  }
  // النموذج المثبت يقبل مرجعاً واحداً؛ تمرير أكثر يُرفض صريحاً بدل إسقاط الزائد صامتاً
  if (refs.refs.length > (model.max_refs || 1) && model.supports_refs) {
    return {
      ok: false, id, error_code: 'refs_too_many', max_refs: model.max_refs || 1,
      message: 'النموذج المختار (' + model.id + ') أثبت مسار مرجع واحد فقط — أرسل مرجعاً واحداً.',
    };
  }
  // ترميز المرجع الأول data: URI (بلا رفع لأي خدمة)
  let refDataUriValue = '';
  if (refs.refs.length && model.supports_refs) {
    const encoded = refDataUri(cwd, refs.refs[0]);
    if (!encoded.ok) {
      return { ok: false, id, error_code: encoded.error_code, message: messageFor({ error_code: encoded.error_code }) };
    }
    refDataUriValue = encoded.uri;
  }

  // 3) 💰 السقف الصلب — قبل أي استدعاء شبكة
  if (r.budget_usd != null) {
    const budget = Number(r.budget_usd);
    if (!Number.isFinite(budget) || budget < 0) {
      return { ok: false, id, error_code: 'bad_input', message: 'قيمة budget_usd غير صالحة.' };
    }
    if (plan.cost_usd_estimate > budget) {
      return {
        ok: false, id, error_code: 'over_budget',
        cost_usd_estimate: plan.cost_usd_estimate, budget_usd: budget, catalog_date: CATALOG_DATE,
        message: 'الكلفة التقديرية ' + plan.cost_usd_estimate + '$ تتجاوز السقف المطلوب '
          + budget + '$ — لم يُجرَ أي استدعاء.',
      };
    }
  }

  // 4) سلسلة المرشّحين (سقوط صريح): النموذج الصريح وحده، أو الأرخص فالأرخص
  const chain = r.model
    ? [model]
    : routeChain(plan.kind, context, refs.refs.length > 0).filter((m) => plan.count <= m.max_count);
  const logged = logPrompt(r.prompt);
  const stamp = String(now);
  const fallbacks = [];

  for (const candidate of chain) {
    const provider = providerByName(candidate.provider);
    const driver = DRIVERS[candidate.provider];
    const key = resolveKey(provider.keyName, context);
    if (!driver || !key) { fallbacks.push({ provider: candidate.provider, model: candidate.id, error_code: 'no_key' }); continue; }

    const cost = costFor(candidate, plan.count);
    // السقف يُعاد فحصه لكل مرشّح — السقوط لأغلى لا يتجاوز الميزانية أبداً
    if (r.budget_usd != null && cost > Number(r.budget_usd)) {
      fallbacks.push({ provider: candidate.provider, model: candidate.id, error_code: 'over_budget' });
      continue;
    }

    let outcome;
    try {
      outcome = await driver(candidate, {
        prompt: slicePoints(cleanText(r.prompt), MAX_PROMPT_SEND),
        count: plan.count,
        refDataUri: refDataUriValue,
      }, context, provider, key);
    } catch (e) {
      outcome = { ok: false, error_code: 'provider_error' };
    }

    if (outcome.ok) {
      const saved = await downloadAssets(outcome.assets, {
        cwd, kind: plan.kind, provider, ctx: context, stamp, rand,
      });
      const base = {
        id, at, kind: plan.kind, provider: candidate.provider, model: candidate.id,
        prompt: logged.prompt, prompt_redacted: logged.redacted, refs: refs.refs,
        cost_usd_estimate: cost,
      };
      if (!saved.ok) {
        appendLog(cwd, buildEntry(base, { status: 'failed', error_code: saved.error_code }));
        return {
          ok: false, id, error_code: saved.error_code, provider: candidate.provider, model: candidate.id,
          fallbacks, message: messageFor({ error_code: saved.error_code }),
        };
      }
      appendLog(cwd, buildEntry(base, { status: 'completed', files: saved.files }));
      return {
        ok: true, id, kind: plan.kind, provider: candidate.provider, model: candidate.id,
        files: saved.files, count: saved.files.length,
        cost_usd_estimate: cost, catalog_date: CATALOG_DATE, estimate: true,
        refs: refs.refs, fallbacks,
      };
    }
    fallbacks.push({ provider: candidate.provider, model: candidate.id, error_code: outcome.error_code });
  }

  const lastCode = fallbacks.length ? fallbacks[fallbacks.length - 1].error_code : 'no_provider';
  appendLog(cwd, buildEntry({
    id, at, kind: plan.kind, provider: plan.provider, model: plan.model,
    prompt: logged.prompt, prompt_redacted: logged.redacted, refs: refs.refs,
    cost_usd_estimate: plan.cost_usd_estimate,
  }, { status: 'failed', error_code: lastCode }));

  return {
    ok: false, id, error_code: lastCode, kind: plan.kind, fallbacks,
    message: messageFor({ error_code: lastCode }),
  };
}

// ============================ الرسائل العربية (بلا نص مزوّد خام) ============================
const MESSAGES = {
  unsupported_kind: 'نوع التوليد غير مدعوم — المتاح: صورة أو فيديو أو صوت.',
  bad_input: 'طلب غير صالح — تحقّق من الوصف.',
  bad_count: 'العدد المطلوب خارج النطاق المسموح (1 إلى 4).',
  bad_cwd: 'مجلد المشروع غير صالح.',
  no_project: 'مجلد العمل الحالي هو مجلد المستخدم (home) لا مجلد مشروع، فلن تُكتب الأصول فيه. '
    + 'اختر مجلد المشروع من شريط «سطر» العلوي ثم أعد الطلب.',
  unknown_model: 'النموذج المطلوب غير موجود في الكتالوج.',
  kind_mismatch: 'النموذج المطلوب لا يولّد هذا النوع.',
  count_exceeded: 'العدد المطلوب يتجاوز سقف هذا النموذج.',
  no_provider: 'لا مزوّد متاح لهذا النوع — اضبط FAL_KEY من ⚙ ← «مفاتيح المزوّدين».',
  no_key: 'مفتاح المزوّد غير مضبوط — أضِفه من ⚙ ← «مفاتيح المزوّدين».',
  provider_unproven: 'هذا المزوّد غير مفعَّل في «سطر» بعد: لم يثبته مسبار حيّ (حساب المزوّد يرفض الطلب).',
  refs_invalid: 'المراجع غير صالحة — مسارات نسبية داخل المشروع بحد أقصى 6.',
  refs_outside: 'المراجع يجب أن تكون داخل مجلد المشروع حصراً.',
  refs_missing: 'ملف مرجعي غير موجود.',
  refs_unsupported: 'لا نموذج مثبت يدعم المراجع لهذا النوع — أزِل المراجع أو اختر نموذجاً يدعمها.',
  refs_too_many: 'النموذج المختار يقبل مرجعاً واحداً فقط.',
  refs_type_rejected: 'نوع ملف المرجع غير مدعوم — المسموح: PNG أو JPEG أو WebP.',
  refs_too_large: 'ملف المرجع أكبر من الحد المسموح (8 م.ب).',
  provider_error: 'تعذّر إكمال التوليد لدى المزوّد.',
  provider_failed: 'أبلغ المزوّد بفشل التوليد.',
  timeout: 'انتهت مهلة انتظار المزوّد قبل اكتمال التوليد.',
  aborted: 'أُلغي التوليد.',
  no_assets: 'لم يُعِد المزوّد أي أصل.',
  asset_rejected: 'رابط الأصل من نطاق غير معتمد — رُفض قبل التنزيل.',
  asset_type_rejected: 'نوع الأصل المُعاد غير مدعوم.',
  asset_too_large: 'الأصل المُعاد يتجاوز الحجم المسموح.',
  write_failed: 'تعذّرت كتابة الأصل في مجلد المشروع.',
};

function messageFor(plan) {
  const code = plan && plan.error_code;
  const base = MESSAGES[code] || 'تعذّر التوليد.';
  if (code === 'provider_unproven' && plan && plan.provider) {
    const p = providerByName(plan.provider);
    if (p && p.unproven && p.unproven.note) return base + ' ' + p.unproven.note;
  }
  return base;
}

module.exports = {
  listCatalog,
  estimate,
  generate,
  readLog,
  // مُصدَّرات للاختبار القطعي وللقنوات (بلا أسرار)
  CATALOG_DATE,
  SCHEMA_VERSION,
  MAX_REFS,
  MAX_COUNT,
  MAX_PROMPT_LOG,
  MAX_REF_BYTES,
  LOG_MAX_BYTES,
  logFileFor,
  logPrompt,
  sanitizeRefs,
  isAllowedAssetUrl,
  providerByName,
  candidatesFor,
  routeChain,
  isHomeDir,
  wireModelOf,
  messageFor,
};
