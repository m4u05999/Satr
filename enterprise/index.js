/**
 * سطر Enterprise — نقطة الدخول (الدفعة 3، ARCHITECTURE.md §4.1).
 *
 * تُستدعى register(seams) من مُحمِّل النواة الشرطي (features.init). هنا **فقط** يلتقي
 * Enterprise بالنواة — عبر نقاط الربط الممرَّرة، لا require عكسي أبداً.
 *
 * التسلسل: تحقق الترخيص (license.js) ⇒ تفعيل الأعلام المرخّصة ⇒ تسجيل القدرات:
 *  - local_models: مزوّد Ollama المحلي في سجلّ المحوّلات (§4.2)
 *  - usage_panel : سجل الاستهلاك + IPC ‏satr:ee:usage (§4.5/§4.7)
 *  - audit_log   : سجل التدقيق + IPC ‏satr:ee:audit (§4.5/§4.7)
 *
 * بلا ترخيص نشط: لا يُسجَّل شيء (الأعلام كلها معطّلة) — «سطر» يبقى مجتمعياً خالصاً.
 */

// ⚠️ الوحدة اسمها licensing.js لا license.js — على ويندوز (نظام ملفات غير حساس لحالة
// الأحرف) require('./license') يلتقط ملف LICENSE النصي فينفجر التحميل (درس مثبّت)
const license = require('./licensing');
const ollama = require('./providers/ollama');
const usage = require('./usage');
const audit = require('./audit');

let status = { active: false, error: 'not_checked' };

function register(seams) {
  status = license.check();
  if (!status.active) return; // بلا ترخيص: Enterprise حاضر لكنه خامل تماماً

  const has = (f) => status.features.includes(f);

  // 3.1 — مزوّد Ollama المحلي (يرث حلقة الوكيل كاملة من مصنع النواة)
  if (has('local_models')) {
    seams.setFlag('local_models', true);
    seams.registerProvider('ollama', ollama.build(seams.openaiCompatible), ollama.META);
  }

  // 3.3 — سجل الاستهلاك (رموز/كلفة لكل مزوّد وجلسة)
  if (has('usage_panel')) {
    seams.setFlag('usage_panel', true);
    seams.subscribe(usage.onEvent);
    seams.registerIpc('satr:ee:usage', () => usage.aggregate());
  }

  // 3.4 — سجل التدقيق (من فعل ماذا)
  if (has('audit_log')) {
    seams.setFlag('audit_log', true);
    seams.subscribe(audit.onEvent);
    seams.registerIpc('satr:ee:audit', () => audit.info());
  }
}

// معلومات عرض للوحة ⚙ (تصل الواجهة ضمن لقطة satr:features — بلا أسرار)
function info() {
  return {
    licensed: !!status.active,
    plan: status.plan || null,
    org: status.org || null,
    exp: status.exp || null,
    error: status.active ? null : status.error,
    licensePath: license.LICENSE_PATH,
  };
}

module.exports = { register, info };
