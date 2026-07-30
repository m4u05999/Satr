/**
 * سطر — تلخيص فشل التحقق لوضع الحلقة المحدودة (الجولة الخامسة، النواة).
 *
 * موديول نقي بلا اعتماديات (نمط diff.js/autogate.js/secretscrub.js) فوق
 * `secretscrub.scrubSecrets` وحده. مسؤوليته الفصل الحاسم بين مسارين:
 *
 *   1) `buildFailureInjection` — نص **داخلي** يُحقن في مدخل دور الإصلاح فقط.
 *      يحمل ذيل خرج الأوامر الفاشلة بعد حجب الأسرار والقص، ومغلّفاً بوسم
 *      `<untrusted_verification_output>` لأنه محتوى غير موثوق (نمط K4).
 *      **لا يعبر أي حدث ولا IPC ولا سجل غرفة.**
 *   2) `buildFailureSummary` — النص **العام** الوحيد المسموح في
 *      `loop_update.last_failure_summary` وسجل الغرفة: بلا خرج أوامر إطلاقاً،
 *      بلا مسارات، ومقصوص بنقاط Unicode.
 *
 * و`sameFailure` بصمة الفشل التي يقرر بها المنسّق بدء جلسة جديدة (القاعدة 3.1:
 * فشل متطابق مرتين متتاليتين ⇒ سياق ملوّث ⇒ دورة بجلسة جديدة).
 *
 * العقد مجمَّد (تواقيع وسقوف): النواة لا تعرف إلا هذه الدوال، والتحصين الخصومي
 * يجري فوق العقد نفسه بلا تغيير التواقيع أو السقوف.
 *
 * ملاحظة تنفيذ: تنقية المحارف بمُسنِد نقاط Unicode لا بتعبير نمطي فيه محارف
 * تحكم حرفية — يمنع ذلك تلف الملف عند تحريره ويجعل الحدود قابلة للاختبار عدداً.
 */

'use strict';

const { scrubSecrets } = require('./secretscrub');

const MAX_INJECTION_CHARS = 8000;
const MAX_SUMMARY_POINTS = 300;
// سقف ذيل الخرج لكل فحص فاشل داخل الحقن (قبل السقف الكلي أعلاه)
const MAX_CHECK_OUTPUT_CHARS = 2000;
// عدد الفحوص الفاشلة المذكورة بالاسم في الملخص العام؛ ما زاد يُعدّ عدداً فقط
const MAX_SUMMARY_FAILURES = 2;
const MAX_SUMMARY_LABEL = 120;
const MAX_ID_CHARS = 64;

const OPEN_TAG = '<untrusted_verification_output>';
const CLOSE_TAG = '</untrusted_verification_output>';

const TAB = 0x09;
const LINE_FEED = 0x0a;

/**
 * محرف يجب حجبه: تحكّم C0/C1 (‏DEL ضمناً) أو أحد محارف Bidi التي تقلب ترتيب
 * العرض. عند `keepLines` يُستثنى السطر الجديد والمسافة الأفقية وحدهما.
 */
function isUnsafePoint(code, keepLines) {
  if (keepLines && (code === LINE_FEED || code === TAB)) return false;
  if (code <= 0x1f) return true; // C0 (يشمل \r و\0)
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true; // ALM/LRM/RLM
  if (code >= 0x202a && code <= 0x202e) return true; // LRE/RLE/PDF/LRO/RLO
  if (code >= 0x2066 && code <= 0x2069) return true; // LRI/RLI/FSI/PDI
  return false;
}

function stripUnsafe(value, keepLines) {
  let out = '';
  for (const char of String(value == null ? '' : value)) {
    if (!isUnsafePoint(char.codePointAt(0), keepLines === true)) out += char;
  }
  return out;
}

/** قصّ بنقاط Unicode لا بوحدات UTF-16 (كي لا يُقطع محرف مركّب أو رمز تعبيري). */
function slicePoints(value, max) {
  const points = [...String(value == null ? '' : value)];
  return points.length <= max ? points.join('') : points.slice(0, max).join('');
}

function isFailedCheck(check) {
  if (!check || typeof check !== 'object') return false;
  if (check.passed === true) return false;
  return check.passed === false || check.timed_out === true || check.exit_code !== 0;
}

function failedChecks(checks) {
  return (Array.isArray(checks) ? checks : []).filter(isFailedCheck);
}

function checkId(check) {
  return slicePoints(stripUnsafe(typeof check.id === 'string' ? check.id : '', false).trim(), MAX_ID_CHARS);
}

function checkLabel(check) {
  const raw = typeof check.label === 'string' && check.label.trim() ? check.label : checkId(check);
  const cleaned = stripUnsafe(raw, false).replace(/\s+/g, ' ').trim();
  return slicePoints(cleaned, MAX_SUMMARY_LABEL);
}

function exitCodeOf(check) {
  return Number.isInteger(check && check.exit_code) ? check.exit_code : null;
}

/**
 * تنقية ذيل خرج أمر فاشل: حجب الأسرار أولاً (المصدر المشترك secretscrub)، ثم
 * إزالة محارف التحكم وBidi مع إبقاء الأسطر، ثم تعطيل قوسي الوسم كي لا يزرع خرج
 * الأمر وسم إغلاق كاذباً يهرب من غلاف `<untrusted_verification_output>`، ثم أخذ
 * **الذيل** لأن رسالة الخطأ الفعلية تقع في نهاية خرج الاختبارات عادةً.
 */
function sanitizeCheckOutput(value) {
  const cleaned = stripUnsafe(scrubSecrets(String(value == null ? '' : value)), true)
    .split('<').join(' ')
    .split('>').join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if ([...cleaned].length <= MAX_CHECK_OUTPUT_CHARS) return cleaned;
  return '…' + slicePoints(cleaned.slice(cleaned.length - MAX_CHECK_OUTPUT_CHARS * 2), MAX_CHECK_OUTPUT_CHARS);
}

/**
 * نص الحقن الداخلي لدور الإصلاح. يعيد '' إن لم يوجد فحص فاشل.
 * الاستهلاك الوحيد المسموح: مدخل الدور التالي داخل الحلقة نفسها.
 */
function buildFailureInjection(checks) {
  const failed = failedChecks(checks);
  if (!failed.length) return '';
  const budget = MAX_INJECTION_CHARS - OPEN_TAG.length - CLOSE_TAG.length - 2;
  const blocks = [];
  let used = 0;
  for (let index = 0; index < failed.length; index++) {
    const check = failed[index];
    const code = exitCodeOf(check);
    const header = 'فحص فاشل: ' + (checkLabel(check) || 'بلا عنوان')
      + ' [' + (checkId(check) || 'unknown') + ']'
      + ' — رمز الخروج: ' + (code == null ? 'غير معروف' : String(code))
      + (check.timed_out === true ? ' — انتهت المهلة' : '');
    const output = sanitizeCheckOutput(check.output);
    const block = output ? header + '\n' + output : header;
    if (used + block.length + 1 > budget) {
      const note = 'وبقي ' + (failed.length - index) + ' فحصاً فاشلاً بلا تفصيل (تجاوز سقف الحقن).';
      if (used + note.length + 1 <= budget) blocks.push(note);
      break;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  if (!blocks.length) return '';
  const text = OPEN_TAG + '\n' + blocks.join('\n\n') + '\n' + CLOSE_TAG;
  return slicePoints(text, MAX_INJECTION_CHARS);
}

/**
 * الملخص العام الوحيد المسموح خارج الحلقة (حدث `loop_update` + سجل الغرفة).
 * لا يحمل خرج أوامر ولا مسارات؛ العناوين والرموز فقط، ومقصوص بنقاط Unicode.
 */
function buildFailureSummary(checks) {
  const failed = failedChecks(checks);
  if (!failed.length) return '';
  const named = failed.slice(0, MAX_SUMMARY_FAILURES).map((check) => {
    const label = checkLabel(check) || checkId(check) || 'فحص';
    if (check.timed_out === true) return 'فشل ' + label + ' (مهلة)';
    const code = exitCodeOf(check);
    return 'فشل ' + label + (code == null ? ' (رمز خروج غير معروف)' : ' (رمز الخروج ' + code + ')');
  });
  const extra = failed.length - named.length;
  if (extra > 0) named.push('و' + extra + ' أخرى');
  const text = stripUnsafe(named.join('، '), false).replace(/\s+/g, ' ').trim();
  return slicePoints(text, MAX_SUMMARY_POINTS);
}

function fingerprint(checks) {
  const failed = failedChecks(checks);
  if (!failed.length) return '';
  return failed
    .map((check) => (checkId(check) || 'unknown') + '|'
      + (exitCodeOf(check) == null ? 'null' : String(exitCodeOf(check))) + '|'
      + (check.timed_out === true ? '1' : '0'))
    .sort()
    .join(';');
}

/**
 * هل الفشلان متطابقان؟ (مجموعة ids الفاشلة + رمز الخروج + المهلة، بترتيب مستقر)
 * غياب أي فشل في أحد الطرفين ⇒ false: «لا فشل» ليس تطابقاً يبرّر جلسة جديدة.
 */
function sameFailure(a, b) {
  const left = fingerprint(a);
  const right = fingerprint(b);
  return !!left && !!right && left === right;
}

module.exports = {
  buildFailureInjection,
  buildFailureSummary,
  sameFailure,
  MAX_INJECTION_CHARS,
  MAX_SUMMARY_POINTS,
};
