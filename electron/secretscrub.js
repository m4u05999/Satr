/**
 * سطر — بوابة حجب الأسرار المشتركة (K5-أ).
 *
 * موديول نقي بلا اعتماديات (نمط diff.js/autogate.js): مصدر واحد لحجب الأسرار
 * قبل بث أي نص إلى الواجهة أو الوكيل. يستهلكه kimi.js (scrubStreamText — وترثه
 * أحداث keep-alive المتأخرة عبر الحقن) وtermjobs.js (scrubDoneTail).
 *
 * القاعدة: النمطان القائمان (sk- وkey=value) محفوظان حرفياً — لا تغيير سلوكهما؛
 * الأنماط الجديدة تُضاف فوقهما، والتحفظ ضد الإيجابيات الكاذبة إلزامي (git SHA
 * وUUID والمسارات وأسماء الحزم لا تُحجب — يثبتها scripts/secretscrub-test.js).
 */

'use strict';

// — النمطان القائمان (سلوك K2/K4 المحفوظ حرفياً على مدخلاتهما الأصلية) —
const RE_SK_LIVE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
// استثناء «Bearer» من قيمة key=value (K5): بلاها كانت تُبتلع قبل نمط Bearer
// فيختفي السياق وتبقى قيمة التوكن مكشوفة — تضييق لا يمس أي مدخل موثق قائم.
const RE_KEY_VALUE = /(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*(?!Bearer\b)[^\s,;]+/ig;

// — الأنماط المضافة (K5) —
// JWT: ثلاثة مقاطع base64url تبدأ eyJ (ترويسة JWT تبدأ دوماً بـ {"typ"...)
const RE_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
// Bearer <token>: تُحجب القيمة وتُبقى الكلمة (سياق مفيد للمراجعة)
const RE_BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{10,}\b/g;
// AWS Access Key ID: AKIA + 16 من [0-9A-Z] — حدود الكلمة تمنع ابتلاع hex أطول
const RE_AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
// GitHub tokens: ghp_/gho_ (وبقية العائلة ghu_/ghs_/ghr_ احترازاً)
const RE_GITHUB = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
// Slack tokens: xox[abprs]-…
const RE_SLACK = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g;
// كتل PEM الخاصة: يُحجب المحتوى ويُبقى سطرا BEGIN/END (تبقى البنية واضحة للمراجعة)
const RE_PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;

/**
 * يحجب الأسرار المعروفة من نص ويعيد النسخة المنقّاة.
 * الترتيب مقصود: الأنماط المركّبة (PEM/JWT/Bearer) أولاً، والنمطان القائمان
 * (sk- وkey=value) آخراً كي لا تبتلع كلمة Bearer قبل نمطها — وسلوكهما على
 * مدخلاتهما الأصلية محفوظ حرفياً.
 * لا يقصّ ولا يزيل محارف تحكم — تلك مسؤولية المستهلك (kimi.js يقص بعد الحجب،
 * وtermjobs.js ينظّف ANSI قبله). غيّر الترتيب هنا فتتغير كل البوابات معاً.
 */
function scrubSecrets(value) {
  let text = String(value || '');
  text = text.replace(RE_PEM_PRIVATE, (match) => {
    const lines = match.split('\n');
    return lines.length > 2 ? lines[0] + '\n[secret]\n' + lines[lines.length - 1] : '[secret]';
  });
  return text
    .replace(RE_JWT, '[secret]')
    .replace(RE_BEARER, '$1 [secret]')
    .replace(RE_AWS_KEY, '[secret]')
    .replace(RE_GITHUB, '[secret]')
    .replace(RE_SLACK, '[secret]')
    .replace(RE_SK_LIVE, '[secret]')
    .replace(RE_KEY_VALUE, '$1=[secret]');
}

module.exports = { scrubSecrets };
