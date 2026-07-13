/**
 * سجلّ المحوّلات (طبقة المزوّد) — المرحلة 5 + نقطة الربط §4.2 في ARCHITECTURE.md.
 *
 * كل محوّل يوفّر: start(input, cwd, emit) → { stop() }، ويبثّ أحداث «سطر» المطبَّعة
 * (system/stream_text/assistant/result). سجلّ **قابل للحقن** عبر register() فتضيف طبقة
 * Enterprise مزوّدين (نماذج محلية/خاصة) دون لمس النواة.
 *
 * ملاحظة: محرك SDK (agent.js) يبقى خاصاً ولا يُلفّ هنا (أدواته لا تُعمَّم).
 */

const claudeCli = require('./claude-cli');
const gemini = require('./gemini');
const openaiCompatible = require('./openai-compatible');
const openaiResponses = require('./openai-responses');

// name -> { adapter, meta:{ label, family } }
const REGISTRY = new Map();

// تسجيل محوّل تحت اسم محرّك (قيمة payload.engine من الواجهة)
function register(name, adapter, meta) {
  REGISTRY.set(name, { adapter, meta: meta || {} });
}

// نماذج Claude (لمحرك cli الاحتياطي — ومحرك sdk الخاص يعرّفها في الواجهة)
const CLAUDE_MODELS = [
  { value: '', label: 'الافتراضي' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

// ---- المحرّكات المدمجة في النواة ----
register('cli', claudeCli, { label: 'CLI — احتياطي', family: 'claude', models: CLAUDE_MODELS });
register('gemini', gemini, {
  label: 'Gemini (REST)', family: 'gemini', keyName: 'GEMINI_API_KEY',
  models: [
    { value: '', label: 'الافتراضي (Flash)' },
    { value: 'gemini-2.5-flash', label: '2.5 Flash' },
    { value: 'gemini-2.5-pro', label: '2.5 Pro' },
  ],
});

register('openai', openaiResponses, {
  label: 'OpenAI (Responses)', family: 'openai', keyName: 'OPENAI_API_KEY',
  // الجولة المنسّقة (vision): نماذج GPT-5.6 تقبل الصور؛ main.js يقرأ هذا من list()
  // ليمرّر input.images، وopenai-responses.js يقرّر الاستهلاك لكل نموذج. (أكمله Claude
  // لسدّ فجوة العقد إذ لم يصل البند لكودكس — يراجعه كودكس.)
  capabilities: { vision: true },
  models: [
    { value: '', label: 'الافتراضي (Terra)' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
  ],
});

// عائلة المتوافقة مع OpenAI: نفس البروتوكول، مفتاح لكل مزوّد في ~/.satr/keys.json.
// البروتوكول متحقَّق حيّاً (عبر نقطة Gemini المتوافقة)؛ المفاتيح يضيفها المستخدم.
register('deepseek', openaiCompatible.make({
  id: 'deepseek', // معرّف مجلد الذاكرة على القرص (~/.satr/chats/deepseek/) — الدفعة 1.3
  host: 'api.deepseek.com', path: '/chat/completions',
  keyName: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', label: 'DeepSeek', includeUsage: true,
  capabilities: { strictTools: true },
}), {
  label: 'DeepSeek', family: 'openai', keyName: 'DEEPSEEK_API_KEY',
  models: [
    { value: '', label: 'الافتراضي' },
    { value: 'deepseek-chat', label: 'Chat (V3)' },
    { value: 'deepseek-reasoner', label: 'Reasoner (R1)' },
  ],
});

register('qwen', openaiCompatible.make({
  id: 'qwen', // معرّف مجلد الذاكرة على القرص (~/.satr/chats/qwen/) — الدفعة 1.3
  host: 'dashscope-intl.aliyuncs.com', path: '/compatible-mode/v1/chat/completions',
  keyName: 'QWEN_API_KEY', defaultModel: 'qwen-plus', label: 'Qwen (Alibaba)', includeUsage: true,
}), {
  label: 'Qwen (Alibaba)', family: 'openai', keyName: 'QWEN_API_KEY',
  models: [
    { value: '', label: 'الافتراضي' },
    { value: 'qwen-plus', label: 'Plus' },
    { value: 'qwen-turbo', label: 'Turbo' },
    { value: 'qwen-max', label: 'Max' },
  ],
});

// MiniMax — نقطة متوافقة مع OpenAI (base_url: https://api.minimax.io/v1). الافتراضي
// M3 (نافذة 1M). أسماء النماذج بصيغة MiniMax-Mx الرسمية (فرق حالة الأحرف يسبب 400).
register('minimax', openaiCompatible.make({
  id: 'minimax', // معرّف مجلد الذاكرة على القرص (~/.satr/chats/minimax/) — الدفعة 1.3
  host: 'api.minimax.io', path: '/v1/chat/completions',
  keyName: 'MINIMAX_API_KEY', defaultModel: 'MiniMax-M3', label: 'MiniMax', includeUsage: true,
}), {
  label: 'MiniMax', family: 'openai', keyName: 'MINIMAX_API_KEY',
  models: [
    { value: '', label: 'الافتراضي (M3)' },
    { value: 'MiniMax-M3', label: 'M3' },
    { value: 'MiniMax-M2.7', label: 'M2.7' },
    { value: 'MiniMax-M2.5', label: 'M2.5' },
    { value: 'MiniMax-M2', label: 'M2' },
  ],
});

// يعيد المحوّل المطابق أو null
function get(engine) {
  const e = REGISTRY.get(engine);
  return e ? e.adapter : null;
}

// قائمة المزوّدين للواجهة (لبناء قائمة «المحرّك» ديناميكياً لاحقاً)
function list() {
  const out = [];
  for (const [name, { meta }] of REGISTRY) {
    out.push({
      name, label: meta.label || name, family: meta.family || '',
      keyName: meta.keyName || '', models: meta.models || [],
      capabilities: meta.capabilities || {}, // الجولة المنسّقة: main.js يقرأ vision منها
    });
  }
  return out;
}

module.exports = { get, register, list };
