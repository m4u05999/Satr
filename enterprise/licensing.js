/**
 * سطر Enterprise — التحقق من الترخيص (الدفعة 3.2، نقطة الربط §4.4).
 *
 * MVP دون خدمة خارجية: ملف ترخيص محلي `~/.satr/license.json` بالشكل:
 *   { "key": "SATR-EE-XXXXXX-XXXXXX", "org": "اسم الجهة", "plan": "enterprise",
 *     "exp": "YYYY-MM-DD", "features": ["usage_panel", "audit_log"] }
 *
 * التحقق الحالي: شكل المفتاح + تاريخ الانتهاء (تحقق «حسن نية» يكفي للنموذج الأولي —
 * وليس حماية تشفيرية). التوقيع الرقمي (مفتاح عام يوقّع محتوى الترخيص) يُضاف عند أول
 * عميل فعلي دون تغيير هذا العقد: check() → { active, plan, org, exp, features, error }.
 *
 * فشل القراءة/الشكل = ترخيص غير نشط — لا استثناءات تتسرب (النواة لا تتأثر).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LICENSE_PATH = path.join(os.homedir(), '.satr', 'license.json');
const KEY_RE = /^SATR-EE-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
// القدرات الافتراضية لخطة enterprise إن لم يعدّدها الترخيص
const DEFAULT_FEATURES = ['usage_panel', 'audit_log'];

function check() {
  let raw;
  try {
    raw = fs.readFileSync(LICENSE_PATH, 'utf8');
  } catch {
    return { active: false, error: 'no_license' }; // لا ملف — بناء بلا ترخيص
  }
  let j;
  try { j = JSON.parse(raw); } catch { return { active: false, error: 'bad_json' }; }
  if (!j || typeof j.key !== 'string' || !KEY_RE.test(j.key)) {
    return { active: false, error: 'bad_key' };
  }
  if (j.exp) {
    const exp = Date.parse(String(j.exp) + 'T23:59:59');
    if (Number.isFinite(exp) && exp < Date.now()) {
      return { active: false, error: 'expired', exp: j.exp, org: j.org || '' };
    }
  }
  const features = Array.isArray(j.features) && j.features.length
    ? j.features.filter((f) => typeof f === 'string').slice(0, 32)
    : DEFAULT_FEATURES;
  return {
    active: true,
    plan: typeof j.plan === 'string' ? j.plan : 'enterprise',
    org: typeof j.org === 'string' ? j.org : '',
    exp: j.exp || null,
    features,
  };
}

module.exports = { check, LICENSE_PATH };
