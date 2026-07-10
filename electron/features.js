/**
 * طبقة القدرات (feature-flags) + المُحمِّل الشرطي لطبقة Enterprise.
 *
 * حجر أساس نموذج «النواة + Enterprise إضافي» (docs/ARCHITECTURE.md §4.1 و §4.4):
 *  - النواة (Community) تعمل **كاملة** إن غاب مجلد `enterprise/` (البناء المجتمعي يستثنيه).
 *  - إن وُجد `enterprise/`، يُحمَّل ويُمرَّر له «نقاط الربط» (seams) ليسجّل قدراته — دون أن
 *    تعرف النواة شيئاً عن داخله (لا require صريح من النواة إلى enterprise).
 *
 * القاعدة الصارمة: أي فشل في تحميل/تسجيل Enterprise **لا يُسقط النواة** إطلاقاً.
 */

// خريطة الأعلام: اسم القدرة → مُفعّلة؟ (غياب الاسم = معطّلة، فالمجتمعية تُخفي قدرات Enterprise)
const flags = new Map();

let enterprise = null;   // مرجع وحدة Enterprise إن حُمِّلت، وإلا null (بناء مجتمعي)
let started = false;     // منع التهيئة المزدوجة

// نقاط الربط المُمرَّرة لـ Enterprise عند التسجيل. تُوسَّع لاحقاً (adapters.register،
// خطّافات IPC، فتحات الواجهة) — كل نقطة جديدة توثَّق في ARCHITECTURE.md §4.
function buildSeams() {
  return {
    // يفعّل/يعطّل علماً (يستدعيه Enterprise بعد التحقق من الترخيص)
    setFlag: (name, on) => { flags.set(String(name), !!on); },
  };
}

// تهيئة الطبقة عند إقلاع «سطر». تُستدعى مرة واحدة من main.js.
function init() {
  if (started) return { loaded: !!enterprise };
  started = true;
  try {
    // يُحمَّل فقط إن وُجد المجلد؛ البناء المجتمعي يستثني enterprise/ فيفشل require بهدوء
    enterprise = require('../enterprise');
  } catch (e) {
    enterprise = null; // بناء مجتمعي: لا Enterprise — النواة تكمل وحدها
  }
  if (enterprise && typeof enterprise.register === 'function') {
    try {
      enterprise.register(buildSeams());
    } catch (e) {
      // تسجيل Enterprise فشل — نعزله ولا نُسقط النواة
      enterprise = null;
      flags.clear();
    }
  }
  return { loaded: !!enterprise };
}

// هل القدرة مُفعّلة؟ (غير المعروفة = false — النواة آمنة افتراضياً)
function enabled(name) {
  return flags.get(String(name)) === true;
}

// هل نعمل ضمن بناء Enterprise (حُمِّل ونُجح تسجيله)؟
function isEnterprise() {
  return !!enterprise;
}

// لقطة للواجهة عبر IPC: تُظهر/تُخفي قدرات Enterprise
function snapshot() {
  const out = {};
  for (const [k, v] of flags) out[k] = v;
  return { enterprise: !!enterprise, flags: out };
}

module.exports = { init, enabled, isEnterprise, snapshot };
