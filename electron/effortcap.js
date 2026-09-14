'use strict';
/**
 * سقف مستويات الجهد — وحدة نقية (المنطق) + قارئ إعدادات محدود الحجم (OBS-196).
 *
 * العلّة المقيسة: `electron/main.js` يشتقّ مستويات منتقي الجهد من **قدرة النموذج وحدها**
 * (‏`supportsEffort` و`supportedEffortLevels` في ردّ قائمة النماذج). لكن `maxEffortLevel`
 * في ملفات إعدادات Claude سقفٌ **ثالث** يقصّ من جانب العميل (‏`sdk.d.ts:8327`):
 *
 *   «Anything above it (an /effort or /model pick, --effort, CLAUDE_CODE_EFFORT_LEVEL, a model
 *    default) is clamped to it … Combines with an organization's per-model effort cap by taking
 *    the lower of the two; across settings files the lowest value wins, and
 *    modelSettings.<model>.maxEffortLevel replaces it per model.»
 *
 * فيعرض المنتقي مستوىً يختاره المستخدم ثم يُقصّ صامتاً — وهو بالضبط العطل الذي عالجه
 * OBS-063 على مستوى قدرة النموذج (إشعار «لا يعلن جهد كذا»)، تاركاً سقف الإعدادات بلا علاج.
 *
 * ثلاثة قرارات صريحة:
 *
 * (١) **الأدنى يغلب عبر الملفات، والنموذج يحلّ محلّ العام داخل الملف الواحد.** الترتيب مهمّ:
 *     لو جُمعت الأسقف العامة في رقم والأسقف النموذجية في رقم ثم طُبّقت الأسبقية، لانقلبت
 *     النتيجة حين يحمل ملفٌ سقفاً عاماً منخفضاً وملفٌ آخر سقفاً نموذجياً مرتفعاً
 *     (`low` عام + `xhigh` نموذجي ⇒ الصحيح `low`، والخاطئ `xhigh`). لذلك تُحسب الأسبقية
 *     **داخل كل ملف** أولاً ثم يُؤخذ الأدنى.
 *
 * (٢) **‏`'max'` سقفاً = لا قصّ.** هو أعلى الرتب، فالقصّ به لا يحذف شيئاً — وهو المعنى نفسه
 *     الذي يسمّيه التوثيق «"max" exempts it» حين يرد سقفاً نموذجياً فوق سقف عام أدنى.
 *
 * (٣) **‏`'max'` مستوىً = جلسيّ لا يُكتب في الإعدادات** (‏`sdk.d.ts` في وصف `setSettings`:
 *     «is session-only, runs as 'high' on a model without 'max' support, and runs no higher
 *     than the organization's effort limit for the model»). يُوسَم في بيانات المنتقي
 *     بـ`sessionOnly:true` كي تستطيع الواجهة قوله لاحقاً بلا تخمين — ولا تُغيَّر الواجهة
 *     في هذه الدفعة: مستهلك المستويات اليوم `src/ui/app.js:703` ويقرأ مصفوفة النصوص كما هي.
 *
 * **حدّ مُصرَّح به**: سقف المؤسسة (‏organization effort limit) يُطبَّق على الخادم ولا يظهر في
 * أي ملف محلي — هذه الوحدة تقصّ بما هو **مقروء على القرص** فقط، والسقف المؤسسي يبقى قصّاً
 * صامتاً لا يعرفه سطر. ولم يُقَس ردّ قائمة النماذج على حساب مؤسسي (السؤال المفتوح في OBS-196:
 * هل يخصم المحرّك السقفين من `supportedEffortLevels` أصلاً؟).
 */

const fs = require('fs');
const path = require('path');

// تصاعدياً — الفهرس هو الرتبة. القائمة **مغلقة** وتطابق اتحاد `maxEffortLevel` في sdk.d.ts.
const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// نفس سقف `hookguard.MAX_SETTINGS_BYTES` — الملفات هي هي، فلا يُخترع سقف ثانٍ.
const MAX_SETTINGS_BYTES = 256 * 1024;

// المستوى الجلسيّ الوحيد: يُختار للجلسة ولا يُحفظ في أي ملف إعدادات.
const SESSION_ONLY_LEVELS = Object.freeze(['max']);

function rank(level) {
  return EFFORT_ORDER.indexOf(level);
}

/** يعيد المستوى إن كان نصاً من القائمة المغلقة، وإلا null — القيمة الفاسدة تُتجاهل بصمت. */
function validLevel(value) {
  return typeof value === 'string' && rank(value) >= 0 ? value : null;
}

/**
 * الاسم القانوني للنموذج لمطابقة مفاتيح `modelSettings`. التوثيق (‏`sdk.d.ts:8340`):
 * «the canonical model name also matches its dated, [1m], Bedrock and Vertex spellings».
 * فتُزال: بادئة المزوّد (‏`us.anthropic.` / `anthropic.`)، ولاحقة نسخة Bedrock (‏`-v1:0`)،
 * ولاحقة `[1m]`، ومقطع التاريخ الأخير (‏`-20251001`). المقارنة بحروف صغيرة.
 */
function canonicalModel(value) {
  if (typeof value !== 'string') return '';
  let name = value.trim().toLowerCase();
  name = name.replace(/\[1m\]$/, '');
  name = name.replace(/^[a-z]{2,6}\./, '');       // us. / eu. / apac. (Bedrock cross-region)
  name = name.replace(/^anthropic\./, '');
  name = name.replace(/-v\d+:\d+$/, '');          // Bedrock: -v1:0
  name = name.replace(/@\d+$/, '');               // Vertex: @20251001
  name = name.replace(/-\d{6,}$/, '');            // مقطع التاريخ
  return name;
}

/**
 * يقصّ قائمة المستويات المعلَنة بالسقف. نقية بالكامل.
 *
 * `modelMax` (سقف هذا النموذج) **يحلّ محلّ** `maxEffortLevel` (السقف العام) حين يكون صالحاً —
 * هذه أسبقية **داخل مصدر واحد**؛ دمج مصادر متعددة مسؤولية `effectiveCap`.
 *
 * حين يقصّ السقف كل شيء (سقفٌ أدنى من أدنى مستوىً يعلنه النموذج) تُعاد أدنى رتبة معلَنة
 * لا مصفوفة فارغة: المصفوفة الفارغة تعني في العقد «لم يعلن النموذج شيئاً» فتسقط الواجهة
 * إلى قائمتها الثابتة — أي إلى مستويات **فوق** السقف، وهو عكس المطلوب.
 */
function clampEffortLevels(levels, caps) {
  const declared = (Array.isArray(levels) ? levels : []).filter((level) => validLevel(level));
  const options = caps && typeof caps === 'object' ? caps : {};
  const perModel = validLevel(options.modelMax);
  const cap = perModel !== null ? perModel : validLevel(options.maxEffortLevel);
  if (cap === null) return declared.slice();
  const limit = rank(cap);
  const kept = declared.filter((level) => rank(level) <= limit);
  if (kept.length || !declared.length) return kept;
  let lowest = declared[0];
  for (const level of declared) if (rank(level) < rank(lowest)) lowest = level;
  return [lowest];
}

/**
 * السقف الساري لنموذجٍ ما من **ملف إعدادات واحد** مُحلَّلاً: مفتاح النموذج يحلّ محلّ العام.
 * يعيد null إن لم يحمل الملف سقفاً صالحاً.
 */
function fileCap(parsed, model) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const general = validLevel(parsed.maxEffortLevel);
  const modelSettings = parsed.modelSettings;
  if (modelSettings && typeof modelSettings === 'object' && !Array.isArray(modelSettings)) {
    const wanted = canonicalModel(model);
    if (wanted) {
      for (const [key, entry] of Object.entries(modelSettings)) {
        if (!entry || typeof entry !== 'object' || canonicalModel(key) !== wanted) continue;
        const perModel = validLevel(entry.maxEffortLevel);
        if (perModel !== null) return perModel;   // يحلّ محلّ العام في هذا الملف
      }
    }
  }
  return general;
}

/** الأدنى عبر الملفات: لكل ملف سقفه الساري (بأسبقيته الداخلية) ثم أدنى الرتب. */
function effectiveCap(parsedFiles, model) {
  let best = null;
  for (const parsed of (Array.isArray(parsedFiles) ? parsedFiles : [])) {
    const cap = fileCap(parsed, model);
    if (cap === null) continue;
    if (best === null || rank(cap) < rank(best)) best = cap;
  }
  return best;
}

/**
 * مسارات ملفات الإعدادات الثلاثة بالترتيب المعلن في التوثيق. الترتيب لا يغيّر النتيجة
 * (الأدنى يغلب لا الأخير) لكنه يُبقي القراءة مفهومة.
 */
function settingsPaths(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const files = [];
  if (opts.homeDir) files.push(path.join(opts.homeDir, '.claude', 'settings.json'));
  if (opts.cwd) {
    files.push(path.join(opts.cwd, '.claude', 'settings.json'));
    files.push(path.join(opts.cwd, '.claude', 'settings.local.json'));
  }
  return files;
}

/**
 * قراءة متزامنة محدودة — نمطُ `hookguard.allowToolNamesInFile` حرفياً (‏`lstat` يرفض الرابط
 * الرمزي وغير الملف والحجم فوق السقف **قبل** أي قراءة). القارئ هناك غير مُصدَّر ومربوط
 * بقواعد السماح، فلا يُعاد تصديره لأجل حقلٍ آخر — والنمط هو المشترك لا الدالة.
 *
 * متزامنة لأن المنتقي يُبنى في استدعاء IPC واحد قصير، وثلاثة ملفات صغيرة بسقفها المعلن.
 * fail-open: أي فشل (غياب/تلف/حجم) يعني «لا سقف من هذا الملف» — ولا يُعطَّل بناء القائمة.
 */
function readSettingsFile(file, io) {
  const impl = io || fs;
  try {
    const stat = impl.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return null;
    const raw = impl.readFileSync(file, 'utf8');
    if (typeof raw !== 'string' || raw.length > MAX_SETTINGS_BYTES) return null;
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return null;
  }
}

/** يقرأ الملفات الثلاثة مرة واحدة ويعيد المُحلَّل منها — يُستدعى مرة لكل طلب قائمة نماذج. */
function readSettings(options) {
  const io = options && options.io;
  return settingsPaths(options).map((file) => readSettingsFile(file, io)).filter((parsed) => parsed !== null);
}

/** الواجهة المختصرة: قائمة مستويات مقصوصة لنموذجٍ ما من إعدادات مقروءة مسبقاً. */
function clampForModel(levels, parsedFiles, model) {
  return clampEffortLevels(levels, { maxEffortLevel: effectiveCap(parsedFiles, model), modelMax: null });
}

/**
 * وسم المستويات الجلسيّة. يُضاف إلى عقد المنتقي حقلاً موازياً لا بديلاً: `effortLevels`
 * (مصفوفة نصوص) يبقى كما هو للمستهلك القائم `src/ui/app.js:703`.
 */
function describeEffortLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .filter((level) => validLevel(level))
    .map((level) => ({ level, sessionOnly: SESSION_ONLY_LEVELS.includes(level) }));
}

module.exports = {
  EFFORT_ORDER,
  SESSION_ONLY_LEVELS,
  MAX_SETTINGS_BYTES,
  canonicalModel,
  clampEffortLevels,
  fileCap,
  effectiveCap,
  settingsPaths,
  readSettings,
  clampForModel,
  describeEffortLevels,
};
