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
const ollama = require('./ollama');

// name -> { adapter, meta:{ label, family } }
const REGISTRY = new Map();

// تسجيل محوّل تحت اسم محرّك (قيمة payload.engine من الواجهة)
function register(name, adapter, meta) {
  REGISTRY.set(name, { adapter, meta: meta || {} });
}

// نماذج Claude (لمحرك cli الاحتياطي — ومحرك sdk الخاص يعرّفها في الواجهة)
const CLAUDE_MODELS = [
  { value: '', label: 'الافتراضي' },
  // مثبت حياً 2026-09-02: supportedModels() على CLI 2.1.258 يعلن claude-fable-5-1[1m]
  // (بديل claude-fable-5)، وclaude --model claude-fable-5-1 -p قبِله مباشرة.
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

// ---- المحرّكات المدمجة في النواة ----
// التسميات بمبدأ «العلامة + طريقة الدخول» (اشتراك/مفتاح API/محلي) — جولة 2026-09-02:
// المعرّفات (name) لا تُمسّ أبداً: تُخزَّن في localStorage ومجلدات ~/.satr/chats و~/.satr/tasks.
register('cli', claudeCli, { label: 'Claude CLI — احتياطي', family: 'claude', models: CLAUDE_MODELS });
register('gemini', gemini, {
  label: 'Google Gemini — مفتاح API', family: 'gemini', keyName: 'GEMINI_API_KEY',
  models: [
    { value: '', label: 'الافتراضي (Flash)' },
    { value: 'gemini-2.5-flash', label: '2.5 Flash' },
    { value: 'gemini-2.5-pro', label: '2.5 Pro' },
  ],
});

register('openai', openaiResponses, {
  label: 'OpenAI — مفتاح API', family: 'openai', keyName: 'OPENAI_API_KEY',
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

register('ollama', ollama.build(), ollama.META);

// عائلة المتوافقة مع OpenAI: نفس البروتوكول، مفتاح لكل مزوّد في ~/.satr/keys.json.
// البروتوكول متحقَّق حيّاً (عبر نقطة Gemini المتوافقة)؛ المفاتيح يضيفها المستخدم.
register('deepseek', openaiCompatible.make({
  id: 'deepseek', // معرّف مجلد الذاكرة على القرص (~/.satr/chats/deepseek/) — الدفعة 1.3
  host: 'api.deepseek.com', path: '/chat/completions',
  keyName: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', label: 'DeepSeek', includeUsage: true,
  capabilities: { strictTools: true },
}), {
  label: 'DeepSeek — مفتاح API', family: 'openai', keyName: 'DEEPSEEK_API_KEY',
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
  label: 'Qwen — مفتاح API', family: 'openai', keyName: 'QWEN_API_KEY',
  models: [
    { value: '', label: 'الافتراضي' },
    { value: 'qwen-plus', label: 'Plus' },
    { value: 'qwen-turbo', label: 'Turbo' },
    { value: 'qwen-max', label: 'Max' },
  ],
});

// Kimi Code API — تكامل API مباشر بهوية سطر (لا التفاف عبر Claude Code ولا CLI).
// K3 يفكر دائماً؛ يجب حفظ reasoning_content مع رسائل نداء الأدوات كي يقبل الجولة التالية.
register('kimi', openaiCompatible.make({
  id: 'kimi',
  host: 'api.kimi.com', path: '/coding/v1/chat/completions',
  keyName: 'KIMI_API_KEY', defaultModel: 'k3', label: 'Kimi K3 API', includeUsage: true,
  capabilities: { vision: true },
  reasoningKey: 'reasoning_content',
  effortMap: { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
  promptCacheKey: true,
  authHint: 'مفتاح Kimi Code مرفوض. أنشئ مفتاحاً من Kimi Code Console؛ مفتاح Kimi Open Platform لا يعمل مع هذا المسار.',
}), {
  label: 'Kimi K3 — مفتاح API', family: 'openai', keyName: 'KIMI_API_KEY',
  capabilities: { vision: true },
  models: [
    { value: 'k3', label: 'K3 — 256K/1M حسب الخطة' },
  ],
});

// MiniMax — نقطة متوافقة مع OpenAI (base_url: https://api.minimax.io/v1). الافتراضي
// M3 (نافذة 1M). أسماء النماذج بصيغة MiniMax-Mx الرسمية (فرق حالة الأحرف يسبب 400).
register('minimax', openaiCompatible.make({
  id: 'minimax', // معرّف مجلد الذاكرة على القرص (~/.satr/chats/minimax/) — الدفعة 1.3
  host: 'api.minimax.io', path: '/v1/chat/completions',
  keyName: 'MINIMAX_API_KEY', defaultModel: 'MiniMax-M3', label: 'MiniMax', includeUsage: true,
}), {
  label: 'MiniMax — مفتاح API', family: 'openai', keyName: 'MINIMAX_API_KEY',
  models: [
    { value: '', label: 'الافتراضي (M3)' },
    { value: 'MiniMax-M3', label: 'M3' },
    { value: 'MiniMax-M2.7', label: 'M2.7' },
    { value: 'MiniMax-M2.5', label: 'M2.5' },
    { value: 'MiniMax-M2', label: 'M2' },
  ],
});

// ---- منصتان مجانيتان بمفتاح API (جولة «النماذج المجانية» 2026-09-02) ----
// البروتوكول (OpenAI Chat Completions + SSE) هو عقد المصنع المتحقَّق حيّاً؛ معرّفات
// النماذج أدناه من توثيق المنصتين المنشور، ويثبتها حيّاً scripts/free-providers-probe.js
// فور توفر مفتاح (المسبار يتخطى بصمت مزوّداً بلا مفتاح — نمط genmedia-probe).
// كلتاهما بطبقة مجانية دائمة بحساب فقط (بلا بطاقة ائتمان) وتدعمان tool calling —
// وهو الشرط الحاكم: بلا أدوات يصير المحرك دردشة لا وكيلاً.

// NVIDIA NIM — بوابة النماذج المفتوحة للمطورين (integrate.api.nvidia.com).
// النماذج أدناه مثبتة حياً 2026-09-02 بمفتاح حقيقي (SSE + جولة أداة كاملة):
// nemotron-3-super نجح فوراً، وdeepseek-v4-pro نجح بعد إعادة (الطبقة المجانية تتقلب
// بإقلاع بارد وECONNRESET عارض — المصنع يعيد الرسالة للمستخدم والدور التالي يمر).
// kimi-k3 وdeepseek-v4-flash على NIM أثبتا الدردشة لا الأدوات فلم يدخلا الكتالوج.
register('nvidia', openaiCompatible.make({
  id: 'nvidia', // مجلد الذاكرة ~/.satr/chats/nvidia/
  host: 'integrate.api.nvidia.com', path: '/v1/chat/completions',
  keyName: 'NVIDIA_API_KEY', defaultModel: 'nvidia/nemotron-3-super-120b-a12b', label: 'NVIDIA NIM', includeUsage: true,
  authHint: 'مفتاح NVIDIA مرفوض. أنشئ مفتاحاً مجانياً من build.nvidia.com (حساب مطوّر بلا بطاقة ائتمان).',
}), {
  label: 'NVIDIA NIM — مفتاح API مجاني', family: 'openai', keyName: 'NVIDIA_API_KEY',
  models: [
    { value: '', label: 'الافتراضي (Nemotron 3 Super)' },
    { value: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B' },
    { value: 'deepseek-ai/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro' },
  ],
});

// Groq — استدلال فائق السرعة (LPU) بطبقة مجانية دائمة ذات حدود يومية.
// النماذج مثبتة حياً 2026-09-02 (SSE + جولة أداة). allam-2-7b عربي سعودي لكنه
// دردشة فقط — Groq يرد 400 على tools والمصنع يتدهور رشيقاً لدردشة بلا أدوات.
register('groq', openaiCompatible.make({
  id: 'groq', // مجلد الذاكرة ~/.satr/chats/groq/
  host: 'api.groq.com', path: '/openai/v1/chat/completions',
  keyName: 'GROQ_API_KEY', defaultModel: 'openai/gpt-oss-120b', label: 'Groq', includeUsage: true,
  authHint: 'مفتاح Groq مرفوض. أنشئ مفتاحاً مجانياً من console.groq.com (حساب فقط، بلا بطاقة).',
}), {
  label: 'Groq — مفتاح API مجاني', family: 'openai', keyName: 'GROQ_API_KEY',
  models: [
    { value: '', label: 'الافتراضي (GPT-OSS 120B)' },
    { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { value: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — سريع' },
    { value: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B' },
    { value: 'allam-2-7b', label: 'ALLaM 7B — عربي، دردشة بلا أدوات' },
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
