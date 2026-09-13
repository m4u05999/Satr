'use strict';
/**
 * تصنيف أخطاء الشبكة — وحدة نقية بلا Electron ولا قرص (2026-09-13).
 *
 * العلة المقيسة: انقطاع واي-فاي (نقطة اتصال هاتف عبر محوّل USB) استمر 58 دقيقة؛ Claude Code
 * أعاد المحاولة ثلاث دقائق صامتاً ثم أخرج «API Error: Can't reach the API server … (ENOTFOUND)»
 * وخرج برمز 1، فألصقت الواجهة عليه «تأكد أنه مثبت ومسجّل دخوله» — تلميح دخول لعطل شبكة.
 * الحل: تصنيف واحد في نقطة الخروج المشتركة لكل المحرّكات (emit في main.js) يُلحق بالحدث
 * حقل `net` بنصّ عربي يقول السبب الحقيقي، والواجهة تعرضه بدل التلميح العام.
 *
 * التصنيف بالنصّ لا برمز الخروج (درس OBS-189): رمز الخطأ يصل داخل نصّ الرسالة أياً كان
 * المحرك (SDK/Codex/Kimi/محوّلات REST)، ولا نملك كائن الخطأ نفسه عبر حدود العمليات.
 */

// الترتيب مقصود: الأدقّ أولاً (DNS قبل «تعذّر الوصول» العام) كي يحمل `code` أدلّ رمز.
const RULES = [
  { kind: 'dns', re: /\bENOTFOUND\b|\bEAI_AGAIN\b|\bEAI_NONAME\b|\bEAI_FAIL\b|getaddrinfo|ERR_NAME_NOT_RESOLVED|check your internet or DNS/i },
  { kind: 'unreachable', re: /\bENETUNREACH\b|\bEHOSTUNREACH\b|\bENETDOWN\b|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Network is unreachable/i },
  { kind: 'refused', re: /\bECONNREFUSED\b|ERR_CONNECTION_REFUSED/i },
  { kind: 'reset', re: /\bECONNRESET\b|\bEPIPE\b|socket hang up|Connection reset by peer|UND_ERR_SOCKET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/i },
  { kind: 'timeout', re: /\bETIMEDOUT\b|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ERR_CONNECTION_TIMED_OUT|Connect Timeout Error/i },
  { kind: 'offline', re: /Can't reach the API server|Cannot reach the API server|Unable to reach the API|\bfetch failed\b|APIConnectionError|Connection error\.?(\s|$)|Failed to fetch\b|network error/i },
];

// رمز الخطأ الظاهر في النصّ (إن وُجد) — يُعرض للمستخدم كي يبحث به، ولا يُترجم.
const CODE_RE = /\b(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_[A-Z_]+|ERR_[A-Z_]+)\b/;

const KIND_TEXT = {
  dns: 'تعذّر حلّ اسم الخادم (DNS) — غالباً انقطع الإنترنت: الواي-فاي أو نقطة اتصال الهاتف سقطت.',
  unreachable: 'الشبكة غير قابلة للوصول — لا مسار إلى الإنترنت من هذا الجهاز الآن.',
  refused: 'الخادم رفض الاتصال — إن كان مزوّداً محلياً فتأكد أنه يعمل على المنفذ المضبوط.',
  reset: 'انقطع الاتصال في منتصف الطلب — الوصلة أُغلقت من الطرف الآخر أو سقطت الشبكة.',
  timeout: 'انتهت مهلة الاتصال بالخادم — الشبكة بطيئة جداً أو مقطوعة.',
  offline: 'تعذّر الوصول إلى خادم المحرك — يبدو أن الإنترنت مقطوع.',
};

/**
 * يصنّف نصّ خطأ. يعيد null إن لم يكن خطأ شبكة، وإلا {kind, code}.
 * `code` رمز الخطأ الحرفي من النصّ أو الـkind بأحرف كبيرة إن غاب الرمز.
 */
function classify(text) {
  const s = typeof text === 'string' ? text : (text && typeof text.message === 'string' ? text.message : '');
  if (!s) return null;
  const sample = s.slice(0, 4000);
  for (const rule of RULES) {
    if (!rule.re.test(sample)) continue;
    const m = CODE_RE.exec(sample);
    return { kind: rule.kind, code: m ? m[1] : rule.kind.toUpperCase() };
  }
  return null;
}

/** النصّ العربي الموجَّه للمستخدم؛ الرمز التقني يُلحق بين قوسين LTR. */
function messageFor(cls, engineLabel) {
  if (!cls || !KIND_TEXT[cls.kind]) return '';
  const who = engineLabel ? String(engineLabel).slice(0, 40) : 'المحرك';
  return 'انقطع الاتصال أثناء دور ' + who + ' (' + cls.code + '). ' + KIND_TEXT[cls.kind]
    + ' المحادثة محفوظة ولم يضع شيء — تحقّق من الشبكة ثم اضغط «أعد المحاولة».';
}

/**
 * يُلحق بحدث خطأ (result بخطأ أو spawn_error) حقل `net` إن كان شبكياً؛ يعيد الحدث نفسه وإلا.
 * لا يعدّل الكائن الأصلي — نسخة سطحية — لأن سجل المحادثة استلم الأصل قبله.
 */
function annotate(event, engineLabel) {
  if (!event || typeof event !== 'object') return event;
  let text = '';
  if (event.type === 'result' && event.is_error) text = typeof event.result === 'string' ? event.result : '';
  else if (event.type === 'spawn_error') text = typeof event.text === 'string' ? event.text : '';
  else if (event.type === 'api_retry') text = typeof event.error === 'string' ? event.error : '';
  else return event;
  const cls = classify(text);
  if (!cls) return event;
  return { ...event, net: { kind: cls.kind, code: cls.code, message: messageFor(cls, engineLabel) } };
}

module.exports = { classify, messageFor, annotate, KINDS: Object.keys(KIND_TEXT) };
