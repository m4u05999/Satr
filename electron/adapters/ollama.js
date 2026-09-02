/**
 * سطر Community — مزوّد Ollama المحلي.
 *
 * نماذج تعمل على جهاز المستخدم بلا إنترنت ولا مفاتيح (سيادة بيانات كاملة —
 * الكود لا يغادر الجهاز). Ollama يخدم واجهة متوافقة مع OpenAI Chat Completions
 * على http://127.0.0.1:11434/v1 — فنبنيه فوق مصنع النواة (صفر تكرار).
 * ويرث حلقة الوكيل كاملة: قراءة/كتابة/تنفيذ بالأذونات العربية + الذاكرة.
 *
 * عند غياب Ollama (غير مثبّت أو غير مشغّل): رسالة إرشاد عربية خطوة بخطوة
 * (connectHint في المصنع تلتقط ECONNREFUSED) — لا خطأ تقني غامض.
 */

const openaiCompatible = require('./openai-compatible');

const CONNECT_HINT = [
  'تعذّر الوصول إلى Ollama على هذا الجهاز (المنفذ 11434).',
  '',
  'Ollama يشغّل نماذج الذكاء محلياً — بلا إنترنت ولا مفاتيح، وكودك لا يغادر جهازك.',
  'خطوات التفعيل:',
  '1) ثبّته من: https://ollama.com/download (ويندوز — تثبيت عادي بنقرة)',
  '2) نزّل نموذج برمجة (مرة واحدة، ~4.7 ج.ب):  ollama pull qwen2.5-coder:7b',
  '3) تأكد أنه يعمل:  ollama list',
  'ثم أعد إرسال طلبك من «سطر» — سيجده تلقائياً.',
].join('\n');

// يبني المحوّل فوق مصنع البروتوكول المشترك ويرث عقد المحوّلات الكامل
function build() {
  return openaiCompatible.make({
    id: 'ollama', // مجلد الذاكرة ~/.satr/chats/ollama/
    protocol: 'http',
    host: '127.0.0.1',
    port: 11434,
    path: '/v1/chat/completions',
    requiresKey: false,
    defaultModel: 'qwen2.5-coder:7b',
    label: 'Ollama (محلي)',
    connectHint: CONNECT_HINT,
  });
}

// بيانات التسجيل في سجلّ المحوّلات (تظهر في قائمة «المحرك» بالواجهة)
const META = {
  label: 'Ollama — نماذج محلية',
  family: 'openai',
  keyName: '', // بلا مفتاح
  models: [
    { value: '', label: 'الافتراضي (qwen2.5-coder:7b)' },
    { value: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B' },
    { value: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B' },
    { value: 'llama3.1:8b', label: 'Llama 3.1 8B' },
    { value: 'deepseek-r1:7b', label: 'DeepSeek R1 7B' },
  ],
};

module.exports = { build, META };
