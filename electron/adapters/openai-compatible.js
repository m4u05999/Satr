/**
 * مصنع محوّل متوافق مع OpenAI Chat Completions — يخدم رؤية «كل النماذج بالعربية».
 *
 * DeepSeek/Qwen/GLM/Kimi وأغلب المزوّدين (بما فيهم نقطة Gemini المتوافقة) يتكلّمون نفس
 * بروتوكول OpenAI: POST /chat/completions ببثّ SSE (`data: {choices[].delta}` ثم
 * `data: [DONE]`). فبدل محوّل لكل مزوّد، هذا **مصنع واحد** يُنتج محوّلاً لأي endpoint
 * بإعطائه إعداده — إضافة مزوّد جديد = سطر تسجيل واحد (docs/ARCHITECTURE.md §4.2).
 *
 * make(config) → { start(input, cwd, emit) → { stop() } }  (نفس عقد المحوّلات).
 * config: { id, host, path, keyName, defaultModel, label, includeUsage, capabilities,
 * reasoningKey, effortMap, promptCacheKey, authHint } — id هو معرّف مجلد الذاكرة
 * على القرص (~/.satr/chats/<id>/)؛ بدونه تبقى الذاكرة حيّة فقط (تُمسح بإعادة التشغيل).
 * خيارات إضافية (الدفعة 3 — مزوّدون محليون مثل Ollama):
 *   protocol: 'https' (افتراضي) أو 'http' (خوادم محلية) · port: منفذ مخصّص ·
 *   requiresKey: false = بلا مفتاح API (محلي) · connectHint: نص عربي يُعرض عند فشل
 *   الاتصال (ECONNREFUSED) يرشد المستخدم لتشغيل/تثبيت الخادم المحلي.
 *
 * حلقة الوكيل (الدفعة 2.1): الطلب يعلن أدوات «سطر» (electron/tools.js — قراءة فقط
 * حالياً). النموذج يطلب أداة ⇒ ننفّذها محلياً ونعيد النتيجة برسالة role:"tool" ونعاود
 * الطلب — حتى MAX_TOOL_ROUNDS جولات. بطاقات الأدوات تُبثّ للواجهة **بنفس عقد أحداث
 * SDK** (tool_use/tool_result) فلا تغيير في الواجهة. نموذج لا يدعم الأدوات (بعض نسخ
 * R1) ⇒ رفض HTTP يُعاد بعده الطلب مرة واحدة دونها (تدهور رشيق لدردشة عادية).
 *
 * أمان: المفتاح في ترويسة Authorization (لا spawn/صدفة)، البرومبت في جسم JSON (لا حقن)،
 * والأدوات تنفّذ عبر مسارات files.js المؤمَّنة (داخل cwd حصراً).
 * الصور اختيارية فقط عند capabilities.vision. جهد التفكير ومحتواه لا يُرسلان إلا لمزوّد
 * يعلن عقدهما صراحةً عبر effortMap/reasoningKey؛ فلا نخترع حقولاً لبقية المتوافقين.
 */

const https = require('https');
const http = require('http'); // خوادم محلية (Ollama وأمثاله) — HTTP على منفذ محلي
const crypto = require('crypto');
const keys = require('../keys');
const chats = require('../chats'); // ذاكرة على القرص (1.3): استئناف بعد إعادة التشغيل
const tools = require('../tools'); // أدوات الوكيل (2.1): read_file / list_files
const skillCatalog = require('../skills'); // metadata فقط أولاً؛ المحتوى عبر load_skill عند الطلب
const memory = require('../memory'); // ذاكرة مشروع شخصية مُقَرّة ضمن ميزانية
const termjobs = require('../termjobs'); // مهام الخلفية المعمّرة — كتلة «انتهت بلا دور نشط»
const contextBudget = require('../context'); // خلاصة repo map + usage تقديري موسوم estimate
const envbrief = require('../envbrief');
const usage = require('./usage'); // عقد input/output/cached/reasoning موحّد للمحوّلات

const MAX_TURNS = 40;       // آخر 40 رسالة لكل جلسة (سقف الرموز)
const PROTECTED_TOOL_ROUNDS = 1; // آخر جولة أدوات تبقى كاملة ليستطيع النموذج متابعة عمله
const CLEARED_TOOL_RESULT_TAIL_CHARS = 2000; // ذيل مفيد من النتائج الأقدم (رادار ٠٠٣، محور E)
const MAX_SESSIONS = 50;    // سقف الجلسات في الكاش الحيّ لكل مزوّد
const MAX_TOOL_ROUNDS = 8;  // سقف جولات الأدوات في الدور الواحد (حارس حلقة لانهائية)

const CLEARED_TOOL_RESULT_NOTICE = '[مُسحت نتيجة أداة قديمة لتقليل حجم السياق. '
  + 'لا تفترض محتواها الكامل؛ لاستعادته شغّل read_file أو run_command مرة أخرى.]';

/**
 * ينسخ سجل الطلب ويمسح **محتوى** نتائج الأدوات الأقدم فقط. لا يحذف الرسائل ولا
 * يغيّر اقتران tool_call_id، وآخر جولة محمية كاملة. الأصل الذي تحفظه chats.js
 * لا يُمسّ؛ هذه نسخة عابرة لجسم الطلب وحده.
 */
function clearOldToolResults(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const protectedIds = new Set();
  let protectedRounds = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const calls = message && message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls : [];
    if (!calls.length) continue;
    if (protectedRounds < PROTECTED_TOOL_ROUNDS) {
      for (const call of calls) {
        if (call && typeof call.id === 'string' && call.id) protectedIds.add(call.id);
      }
    }
    protectedRounds++;
  }

  return messages.map((message) => {
    if (!message || message.role !== 'tool' || protectedIds.has(message.tool_call_id)
        || typeof message.content !== 'string'
        || message.content.startsWith(CLEARED_TOOL_RESULT_NOTICE)) return message;
    const tail = message.content.slice(-CLEARED_TOOL_RESULT_TAIL_CHARS);
    return { ...message, content: CLEARED_TOOL_RESULT_NOTICE + '\n\n[ذيل النتيجة المحفوظ]\n' + tail };
  });
}

// السقف القائم يبقى مستقلاً: نسخة الحفظ تمرّ هنا بلا مسح فتظل حقيقة القرص كاملة.
function capHistory(messages) {
  const capped = Array.isArray(messages) ? messages.slice() : [];
  while (capped.length > MAX_TURNS) capped.shift();
  // لا رسالة أداة يتيمة في المقدمة بعد القصّ (المزوّد يرفض tool بلا نداء يسبقها)
  while (capped.length && capped[0].role === 'tool') capped.shift();
  return capped;
}

/** المسح يسبق سقف الرسائل، ثم تُضاف بادئة OBS-103 بايتياً كما بناها context.js. */
function prepareRequestMessages(messages, systemPrompt) {
  const prepared = capHistory(clearOldToolResults(messages));
  return systemPrompt ? [{ role: 'system', content: systemPrompt }].concat(prepared) : prepared;
}

// ---- حدود المعدّل: 429 (‏OBS-086) ----
// الطبقات المجانية التي تفتح بها البوابة اليوم ضيّقة: Groq ‏30 طلباً و8000 رمز في
// الدقيقة، وNVIDIA NIM نحو 40 طلباً في الدقيقة — فجلسة وكيلية تصطدم بالحدّ من أول
// مخرج CLI طويل. قبل هذه الكتلة لم يكن للمصنع أي تطابق على 429: تعبر رسالة المزوّد
// الخام إلى المستخدم بلا معنى، أو تُقرأ رفضاً لعقد الأدوات. الآن: تراجع محدود ثم
// رسالة عربية **تسمّي الحدّ** الذي اصطُدم به.
//
// ⚠️ ترويسات هذا المسار (`Retry-After` و`x-ratelimit-*`) **بيانات شبكة غير موثوقة**:
// تُقبل بأنماط رقمية صارمة، ويُرفض ما تجاوز السقف بدل النوم دقائق لأن ترويسة قالت ذلك.
// ولا يدخل جسم الاستجابة الخام أيَّ رسالة تُبثّ — النص كله من جدول مغلق أدناه.
const RATE_LIMIT_STATUS = 429;
const MAX_RATE_LIMIT_RETRIES = 3;               // سقف صريح — لا حلقة إعادة محاولة مفتوحة
const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000]; // تراجع أسّي حين لا يعلن المزوّد مهلة
const RETRY_AFTER_MAX_MS = 20000;               // أطول انتظار نقبله من ترويسة واحدة
const RATE_LIMIT_BUDGET_MS = 30000;             // سقف مجموع الانتظار في الدور الواحد
const MAX_RETRY_AFTER_SECONDS = 86400;          // أكبر من يوم ⇒ ترويسة مشوّهة تُهمَل

const RATE_KIND_PHRASE = { tokens: 'الرموز', requests: 'الطلبات' };
const RATE_WINDOW_PHRASE = { minute: 'في الدقيقة', day: 'في اليوم' };

// تصريف «ثانية» بالعربية — الأرقام هنا ديناميكية فلا تصحّ صيغة واحدة لكل الحالات
function secondsPhrase(seconds) {
  if (seconds <= 1) return 'ثانية واحدة';
  if (seconds === 2) return 'ثانيتين';
  if (seconds <= 10) return seconds + ' ثوانٍ';
  return seconds + ' ثانية';
}

/**
 * `Retry-After` بالثواني حصراً. صيغة HTTP-date مشروعة في المعيار لكنها **غير مدعومة
 * عمداً**: تحليلها يجعل ساعةَ مزوّد منحرفة تُترجَم إلى نوم ساعات؛ غيابها يسقط إلى
 * التراجع الأسّي. يعيد ميلي ثانية أو null.
 */
function parseRetryAfterMs(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d{1,7}(?:\.\d{1,3})?$/.test(text)) return null;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_RETRY_AFTER_SECONDS) return null;
  return Math.round(seconds * 1000);
}

// عدد صحيح من ترويسة — أي شيء غير رقم خالص (≤9 خانات) يُهمَل بلا تأويل
function headerNumber(headers, name) {
  const raw = headers && headers[name];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string' || !/^\d{1,9}$/.test(text.trim())) return null;
  return Number(text.trim());
}

/**
 * أي حدّ اصطُدم به؟ الجواب من قائمة مغلقة (`tokens|requests|''` × `minute|day|''`).
 * جسم الاستجابة يُقرأ **إشارةً فقط** (مقصوصاً) ولا يخرج منه حرف إلى المستخدم.
 */
function classifyRateLimit(headers, body) {
  const text = typeof body === 'string' ? body.slice(0, 2000) : '';
  let kind = '';
  if (/tokens\s+per\s+(?:minute|day)|\bTPM\b|\bTPD\b/i.test(text)) kind = 'tokens';
  else if (/requests\s+per\s+(?:minute|day)|\bRPM\b|\bRPD\b/i.test(text)) kind = 'requests';
  else if (headerNumber(headers, 'x-ratelimit-remaining-tokens') === 0) kind = 'tokens';
  else if (headerNumber(headers, 'x-ratelimit-remaining-requests') === 0) kind = 'requests';
  let window = '';
  if (/per\s+day|\bTPD\b|\bRPD\b/i.test(text)) window = 'day';
  else if (/per\s+minute|\bTPM\b|\bRPM\b/i.test(text)) window = 'minute';
  const limit = kind === 'tokens' ? headerNumber(headers, 'x-ratelimit-limit-tokens')
    : kind === 'requests' ? headerNumber(headers, 'x-ratelimit-limit-requests') : null;
  return { kind, window, limit, retryAfterMs: parseRetryAfterMs(headers && headers['retry-after']) };
}

// جملة «بلغتَ حدّ …» — مبنية من الجدول المغلق أعلاه لا من نص المزوّد
function rateLimitHead(label, info) {
  const kindPhrase = RATE_KIND_PHRASE[info.kind];
  const windowPhrase = RATE_WINDOW_PHRASE[info.window];
  let head = kindPhrase
    ? 'بلغتَ حدّ ' + kindPhrase + (windowPhrase ? ' ' + windowPhrase : '') + ' لدى ' + label
    : 'بلغتَ حدّ الاستخدام لدى ' + label;
  if (kindPhrase && info.limit !== null) head += ' (الحدّ المعلن: ' + info.limit + ')';
  return head + '.';
}

// الرسالة النهائية حين ينفد التراجع. `/ضغط` غير متاح لمحوّلات REST (‏engines في
// app.js: sdk/codex/kimi-code) فلا يُقترح هنا — البدائل الصادقة وحدها.
function rateLimitMessage(label, info) {
  const wait = info.retryAfterMs !== null
    ? ' أعِد المحاولة بعد ' + secondsPhrase(Math.max(1, Math.ceil(info.retryAfterMs / 1000))) + '.'
    : ' انتظر قليلاً ثم أعِد المحاولة.';
  const advice = info.kind === 'tokens'
    ? ' لتخفيف الاستهلاك: قلّل مخرجات الطرفية والملفات المرفقة، أو ابدأ جلسة جديدة، أو بدّل المحرّك من قائمة «المحرك».'
    : ' أبطئ وتيرة الطلبات، أو بدّل المحرّك من قائمة «المحرك».';
  return rateLimitHead(label, info) + wait + advice;
}

/**
 * كم ننتظر قبل المحاولة التالية؟ `null` = لا تراجع بعد (نفدت المحاولات، أو طلب
 * المزوّد أطول من سقفنا، أو تجاوز مجموعُ الانتظار ميزانيةَ الدور) ⇒ فشل صريح.
 */
function planRateLimitWait(state, retryAfterMs) {
  if (state.attempts >= MAX_RATE_LIMIT_RETRIES) return null;
  const wait = retryAfterMs === null ? RATE_LIMIT_BACKOFF_MS[state.attempts] : retryAfterMs;
  if (!Number.isFinite(wait) || wait < 0 || wait > RETRY_AFTER_MAX_MS) return null;
  if (state.spentMs + wait > RATE_LIMIT_BUDGET_MS) return null;
  return wait;
}

// تحليل وسائط أداة قادمة من النموذج — نص JSON قد يكون معطوباً، فلا استثناء أبداً
function safeParse(s) {
  try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}

// «موافقة دائمة» لأداة (2.2) — لعمر التطبيق، مشتركة بين مزوّدي عائلة openai
// (نفس نموذج alwaysAllowed في agent.js لمسار SDK)
const alwaysAllowed = new Set();

// نسخة عرض لوسائط الأداة في مربع الإذن — تقصّ الحقول الطويلة (content ضخم مثلاً)
// حتى لا ينفجر المربع؛ التنفيذ يستعمل الوسائط الكاملة وبطاقة diff تعرض التفاصيل بعده
function displayInput(args) {
  const out = {};
  for (const k of Object.keys(args || {})) {
    const v = args[k];
    out[k] = (typeof v === 'string' && v.length > 800) ? v.slice(0, 800) + '… (+' + (v.length - 800) + ')' : v;
  }
  return out;
}

function make(config) {
  const { id: providerId, host, path: apiPath, keyName, defaultModel, label } = config;
  const requiresKey = config.requiresKey !== false; // المزوّدون المحليون بلا مفتاح
  const transport = config.protocol === 'http' ? http : https;
  const port = config.port || undefined;
  const connectHint = config.connectHint || ''; // إرشاد عربي عند فشل الاتصال (خادم محلي غائب)
  const authHint = config.authHint || ''; // إرشاد مزوّد محدد عند رفض المفتاح
  const includeUsage = config.includeUsage === true; // يُفعّل فقط لنقطة موثّقة كي لا نكسر مزوّداً محلياً
  const strictTools = !!(config.capabilities && config.capabilities.strictTools === true);
  const supportsVision = !!(config.capabilities && config.capabilities.vision === true);
  const reasoningKey = typeof config.reasoningKey === 'string' && /^[a-z_]{1,64}$/.test(config.reasoningKey)
    ? config.reasoningKey : '';
  const effortMap = config.effortMap && typeof config.effortMap === 'object' ? config.effortMap : null;
  const histories = new Map(); // session_id -> رسائل بصيغة OpenAI (كاش حيّ فوق القرص)

  function normalizeEffort(value) {
    if (!effortMap || typeof value !== 'string') return null;
    const mapped = effortMap[value];
    return typeof mapped === 'string' && mapped ? mapped : null;
  }

  // المفتاح: بيئة النظام أولاً ثم مخزن «سطر» (~/.satr/keys.json) — موثوق بلا وراثة بيئة
  function resolveKey() {
    if (!requiresKey) return null;
    return (process.env[keyName] || keys.get(keyName) || '').trim();
  }

  function start(input, cwd, emit) {
    const { prompt, sessionId, model, permissionMode } = input;
    const reasoningEffort = normalizeEffort(input.effort);
    const skillContext = skillCatalog.resolveSelection(cwd, input.skills);
    const skillPrompt = skillCatalog.catalogPrompt(skillContext);
    const memoryPrompt = memory.retrieve(cwd, prompt).text;
    // مهام خلفية خرجت بلا دور نشط — كتلة سياق تُحقن مرة واحدة (termjobs.pendingNoticeText)
    const backgroundPrompt = termjobs.pendingNoticeText(cwd);
    let contextPrompt = '';
    let turnPrompt = '';
    let turnMessageIndex = -1;
    // acceptEdits/bypassPermissions تمرّان الكتابة بلا سؤال (نفس دلالة أوضاع SDK)
    const autoAllowWrites = permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';

    const apiKey = resolveKey();
    if (requiresKey && !apiKey) {
      queueMicrotask(() => {
        emit({ type: 'spawn_error', text: 'لم يُضبط مفتاح ' + label + '. أضِفه من ⚙ ← «مفاتيح المزوّدين» أو في الملف '
          + keys.KEYS_PATH + ' بالصيغة: {"' + keyName + '":"..."}' });
        emit({ type: 'result', session_id: sessionId || null, is_error: true, result: 'مفتاح API مفقود' });
        emit({ type: 'proc_done', code: 1 });
      });
      return { stop() { return Promise.resolve(); } };
    }

    const useModel = (typeof model === 'string' && model && !/claude/i.test(model)) ? model : defaultModel;
    // الكاش الحيّ أولاً، ثم القرص (استئناف بعد إعادة تشغيل «سطر» — 1.3)
    let resumed = (sessionId && histories.get(sessionId)) || null;
    if (sessionId && !resumed && providerId) resumed = chats.load(providerId, sessionId);
    const sid = (sessionId && resumed) ? sessionId : crypto.randomUUID();
    const history = resumed || [];

    emit({ type: 'system', subtype: 'init', session_id: sid, model: useModel });

    const startedAt = Date.now();
    let aborted = false;
    let currentReq = null;
    // نوم تراجع 429 قابل للقطع: `stop()` يمسح المؤقّت ويحسم الوعد فوراً، فلا يبقى
    // دورٌ معلّقاً في نوم بعد الإيقاف (ولا مؤقّت يتيم يبقي حلقة الأحداث حيّة).
    let sleepTimer = null;
    let wakeSleep = null;
    const sleep = (ms) => new Promise((resolve) => {
      if (aborted) return resolve();
      wakeSleep = resolve;
      sleepTimer = setTimeout(() => { sleepTimer = null; wakeSleep = null; resolve(); }, ms);
    });
    let toolsOk = true; // يُعطَّل بعد رفض المزوّد للأدوات (نموذج لا يدعم tool-calling)
    // استهلاك الرموز عبر جولات الدور (3.3): يُجمَع من إطارات usage إن وفّرها المزوّد
    const usageTotal = usage.emptyActual();
    const estimatedUsage = { input_tokens: 0, output_tokens: 0 };
    let contextEstimate = null;
    const mediaCostState = { total: 0 }; // generate_media فقط: تراكمي تقديري للجلسة

    // ---------- الإذن العربي لأدوات الكتابة والتنفيذ (2.2/2.3) ----------
    // نفس عقد مسار SDK: permission_request للواجهة، والرد يصل عبر resolvePermission
    // على مقبض التشغيل (main.js يوجّه satr:permission إلى المقبض الجاري أياً كان محركه).
    // طبقات: 'write' يعفيها acceptEdits/«موافقة دائمة»؛ 'exec' موافقة إلزامية كل مرة
    // (bypassPermissions وحده يعفيها — العرض المرئي في الطرفية لا يخفّف التنفيذ)
    const pendingPerms = new Map(); // id → { resolve, name }
    async function askPermission(callId, name, args, tier) {
      if (permissionMode === 'bypassPermissions') return Promise.resolve(true);
      if (tier === 'write' && (autoAllowWrites || alwaysAllowed.has(name))) return Promise.resolve(true);
      const id = String(callId);
      let visibleInput = displayInput(args);
      if (name === 'generate_media') {
        const prepared = await tools.generationPermission(cwd, args, { mediaCostState });
        if (!prepared.ok) return true; // التنفيذ يعيد التدهور العربي المنقّى للنموذج
        visibleInput = prepared.input;
      }
      emit({ type: 'permission_request', id, tool: name, input: visibleInput,
        alwaysEligible: tier !== 'exec', ...(name === 'generate_media' ? { turnEligible: false } : {}) });
      return new Promise((resolve) => { pendingPerms.set(id, { resolve, name }); });
    }

    // طلب واحد للمزوّد: يبثّ النص حيّاً ويجمع نداءات الأدوات المتدفقة (SSE)
    function requestOnce(messages, withTools) {
      return new Promise((resolve) => {
        let textBuf = '';
        let reasoningBuf = '';
        let sseBuf = '';
        const calls = new Map(); // index -> { id, name, args } (الوسائط تصل مجزّأة)
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };

        // رسالة سياق لاحقة تبقي رسالة المستخدم (ومنها الصور) بايتياً كما هي ولا تدخل السجل المحفوظ.
        const messagesWithTurnPrompt = messages.slice();
        if (turnPrompt && turnMessageIndex >= 0 && turnMessageIndex < messagesWithTurnPrompt.length) {
          messagesWithTurnPrompt.splice(turnMessageIndex + 1, 0, { role: 'system', content: turnPrompt });
        }
        const requestMessages = prepareRequestMessages(messagesWithTurnPrompt, contextPrompt);
        const bodyObj = { model: useModel, messages: requestMessages, stream: true };
        if (config.promptCacheKey === true) bodyObj.prompt_cache_key = sid;
        if (reasoningEffort) bodyObj.reasoning_effort = reasoningEffort;
        if (includeUsage) bodyObj.stream_options = { include_usage: true };
        if (withTools) bodyObj.tools = tools.defs({ strictTools });
        const requestInputEstimate = contextBudget.estimateTokens(bodyObj);
        estimatedUsage.input_tokens += requestInputEstimate;
        const body = JSON.stringify(bodyObj);

        let requestUsage = null; // الإطار الأخير يحمل إجمالي الطلب؛ لا نجمعه أكثر من مرة
        // إطار SSE: data: {choices[0].delta{content|tool_calls}} أو data: [DONE]
        const handleFrame = (jsonStr) => {
          if (!jsonStr || jsonStr === '[DONE]') return;
          let obj;
          try { obj = JSON.parse(jsonStr); } catch (e) { return; }
          // مع include_usage يصل إطار أخير choices=[]؛ نحتفظ بآخر إجمالي موثّق للطلب.
          if (obj && obj.usage) requestUsage = usage.parseChat(obj.usage) || requestUsage;
          const choice = obj && obj.choices && obj.choices[0];
          if (!choice) return;
          const delta = choice.delta || {};
          if (reasoningKey && typeof delta[reasoningKey] === 'string') {
            reasoningBuf += delta[reasoningKey];
          }
          if (typeof delta.content === 'string' && delta.content) {
            textBuf += delta.content;
            emit({ type: 'stream_text', text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              if (!calls.has(idx)) calls.set(idx, { id: '', name: '', args: '' });
              const c = calls.get(idx);
              if (tc.id) c.id = tc.id;                       // يصل مرة واحدة أول جزء
              if (tc.function && tc.function.name) c.name = tc.function.name;
              if (tc.function && typeof tc.function.arguments === 'string') c.args += tc.function.arguments;
            }
          }
        };

        const headers = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey; // المحلي بلا مفتاح
        const options = { host, port, path: apiPath, method: 'POST', headers };

        const req = transport.request(options, (res) => {
          res.setEncoding('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', (d) => { errBody += d; });
            res.on('end', () => {
              let msg = 'رمز HTTP ' + res.statusCode;
              try { const j = JSON.parse(errBody); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
              if ((res.statusCode === 401 || res.statusCode === 403) && authHint) msg = authHint;
              // `headers`/`errBody` **داخليان**: يستهلكهما تصنيف 429 وحده ولا يُبثّان.
              done({ error: msg, status: res.statusCode, headers: res.headers, errorBody: errBody,
                estimatedInput: requestInputEstimate });
            });
            return;
          }
          res.on('data', (chunk) => {
            sseBuf += chunk;
            let idx;
            while ((idx = sseBuf.indexOf('\n')) >= 0) {
              const line = sseBuf.slice(0, idx).trim();
              sseBuf = sseBuf.slice(idx + 1);
              if (line.startsWith('data:')) handleFrame(line.slice(5).trim());
            }
          });
          res.on('end', () => {
            const tail = sseBuf.trim();
            if (tail.startsWith('data:')) handleFrame(tail.slice(5).trim());
            if (requestUsage) {
              usage.add(usageTotal, requestUsage);
            }
            done({
              text: textBuf,
              reasoning: reasoningBuf,
              calls: [...calls.values()].filter((c) => c.id && c.name),
              usage: requestUsage,
            });
          });
        });

        req.on('error', (e) => {
          if (aborted) return done({ error: '__aborted__' });
          // خادم محلي غائب (ECONNREFUSED) وله إرشاد ⇐ رسالة عربية موجّهة بدل خطأ تقني
          const refused = e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND');
          if (refused && connectHint) return done({ error: connectHint, isHint: true });
          done({ error: 'تعذّر الاتصال بـ ' + label + ': ' + String(e && e.message) });
        });

        currentReq = req;
        req.write(body);
        req.end();
      });
    }

    const fail = (msg) => {
      emit({ type: 'spawn_error', text: 'فشل طلب ' + label + ': ' + msg });
      emit({ type: 'result', session_id: sid, is_error: true, duration_ms: Date.now() - startedAt, result: msg });
      emit({ type: 'proc_done', code: 1 });
    };

    // حلقة الوكيل (2.1): نداءات أدوات ⇒ تنفيذ محلي وإعادة الطلب؛ نص فقط ⇒ انتهى الدور
    (async () => {
      const builtContext = await contextBudget.buildBlindContext({
        cwd,
        prompt,
        systemParts: [envbrief.build('adapter', useModel, { compact: true }), skillPrompt],
        turnParts: [memoryPrompt, backgroundPrompt],
        history,
        toolDefinitions: tools.defs({ strictTools }),
      });
      if (aborted) return;
      contextPrompt = builtContext.systemPrompt;
      turnPrompt = builtContext.turnPrompt;
      contextEstimate = builtContext.estimate;
      // الصور لا تأتي إلا من sanitizeImages في main.js؛ لا نقبل URL أو مساراً من النموذج.
      const userContent = supportsVision && Array.isArray(input.images) && input.images.length
        ? [{ type: 'text', text: prompt }].concat(input.images.map((image) => ({
          type: 'image_url',
          image_url: { url: 'data:' + image.media_type + ';base64,' + image.data },
        })))
        : prompt;
      const messages = history.concat([{ role: 'user', content: userContent }]);
      turnMessageIndex = history.length;
      let rounds = 0;
      const rateLimit = { attempts: 0, spentMs: 0 }; // حالة تراجع 429 لهذا الدور وحده
      while (true) {
        const r = await requestOnce(messages, toolsOk);
        if (aborted || r.error === '__aborted__') return;
        if (r.error) {
          // 429 (‏OBS-086): تراجع محدود ثم رسالة تسمّي الحدّ. مشروط بالحالة وحدها،
          // فلا يمسّ المسار السليم ولا بقية رموز الخطأ لأي مزوّد من مزوّدي المصنع.
          if (r.status === RATE_LIMIT_STATUS) {
            const info = classifyRateLimit(r.headers, r.errorBody);
            const wait = planRateLimitWait(rateLimit, info.retryAfterMs);
            if (wait === null) { fail(rateLimitMessage(label, info)); return; }
            rateLimit.attempts++;
            rateLimit.spentMs += wait;
            // الطلب رُفض قبل التنفيذ، فلا يُحتسب إدخاله مرتين في التقدير
            estimatedUsage.input_tokens -= r.estimatedInput || 0;
            emit({ type: 'stream_text', phase: 'commentary',
              text: '⏳ ' + rateLimitHead(label, info) + ' أنتظر '
                + secondsPhrase(Math.max(1, Math.ceil(wait / 1000))) + ' ثم أعيد المحاولة ('
                + rateLimit.attempts + '/' + MAX_RATE_LIMIT_RETRIES + ').\n\n' });
            await sleep(wait);
            if (aborted) return;
            continue;
          }
          // رفض صيغة الطلب في أول جولة قد يعني أن النموذج لا يدعم الأدوات؛ لا نعيد أخطاء المصادقة.
          if (toolsOk && rounds === 0 && (r.status === 400 || r.status === 422)) {
            toolsOk = false;
            continue;
          }
          fail(r.error);
          return;
        }
        estimatedUsage.output_tokens += contextBudget.estimateTokens({ text: r.text, calls: r.calls });
        // عدّاد الطلب الحقيقي مقدّم؛ إن غاب وحده يسقط القياس إلى character_heuristic
        // الموسوم. نداءات الأدوات مستثناة لأن عدادها يجمع النص وJSON ولا يمكن فصلُهما.
        if (r.text && !r.calls.length) {
          usage.recordOutputMetric((providerId || 'openai-compatible') + ':' + useModel, r.text, r.usage);
        }

        if (r.calls.length && rounds < MAX_TOOL_ROUNDS) {
          rounds++;
          // بطاقات الأدوات للواجهة — نفس عقد أحداث SDK (صفر تغيير واجهة)
          const blocks = r.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: safeParse(c.args) }));
          if (r.text) blocks.unshift({ type: 'text', text: r.text });
          emit({ type: 'assistant', message: { content: blocks } });

          // سجل المحادثة بصيغة OpenAI الأصلية (يُحفظ كما هو في الذاكرة — 1.3)
          const assistantMessage = {
            role: 'assistant',
            content: r.text || null,
            tool_calls: r.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
          };
          // Kimi مع التفكير يرفض الجولة التالية إذا غاب reasoning_content عن رسالة نداء الأداة.
          if (reasoningKey) assistantMessage[reasoningKey] = r.reasoning || '';
          messages.push(assistantMessage);
          for (const c of r.calls) {
            if (aborted) return;
            const parsed = safeParse(c.args);
            const tier = tools.permissionTier(c.name);
            let out;
            if (tier) {
              // أداة كتابة/تنفيذ (2.2/2.3): موافقة المستخدم أولاً — الرفض يعود للنموذج نصاً
              const allowed = await askPermission(c.id, c.name, parsed, tier);
              if (aborted) return;
              out = allowed
                ? await tools.run(c.name, cwd, parsed, { emit, id: c.id, skillContext, engine: providerId || 'adapter', mediaCostState })
                : { ok: false, content: 'رفض المستخدم هذا الإجراء — لا تعاود المحاولة نفسها؛ اشرح ما كنت ستفعله أو اقترح بديلاً' };
            } else {
              out = await tools.run(c.name, cwd, parsed, { emit, id: c.id, skillContext, engine: providerId || 'adapter', mediaCostState });
            }
            emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, is_error: !out.ok }] } });
            messages.push({ role: 'tool', tool_call_id: c.id, content: out.content });
          }
          continue;
        }

        // دور مكتمل (نص نهائي، أو استُنفدت الجولات)
        if (r.text) {
          const assistantMessage = { role: 'assistant', content: r.text };
          if (reasoningKey && r.reasoning) assistantMessage[reasoningKey] = r.reasoning;
          messages.push(assistantMessage);
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: r.text }] } });
        }
        // الحفظ يأخذ الأصل الكامل؛ المسح خاص بنسخة الطلب ولا يسرّب إلى chats.js.
        const h = capHistory(messages);
        if (!histories.has(sid) && histories.size >= MAX_SESSIONS) {
          histories.delete(histories.keys().next().value); // إخلاء الأقدم من الكاش
        }
        histories.set(sid, h);
        if (providerId) chats.save(providerId, sid, h); // حفظ على القرص — أفضل جهد (1.3)
        emit({
          type: 'result', session_id: sid, is_error: false,
          duration_ms: Date.now() - startedAt, num_turns: rounds + 1,
          // استهلاك الدور (3.3) — إن وفّره المزوّد؛ مجرى المراقبة (§4.7) يلتقطه للوحة الاستهلاك
          usage: usage.normalize(usageTotal, estimatedUsage),
          context_estimate: contextEstimate,
          provider: providerId || undefined,
        });
        emit({ type: 'proc_done', code: 0 });
        return;
      }
    })();

    return {
      stop() {
        aborted = true;
        // قطع نوم تراجع 429 فوراً — لا انتظار معلّق بعد الإيقاف
        if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
        if (wakeSleep) { const wake = wakeSleep; wakeSleep = null; wake(); }
        // إنهاء أي إذن معلّق بالرفض حتى لا تبقى الحلقة منتظرة للأبد
        for (const [, p] of pendingPerms) { try { p.resolve(false); } catch (e) {} }
        pendingPerms.clear();
        try { if (currentReq) currentReq.destroy(); } catch (e) {}
        return Promise.resolve();
      },
      // رد الواجهة على مربع الإذن (main.js يوجّهه إلى المقبض الجاري)
      resolvePermission(id, allow, always) {
        const p = pendingPerms.get(id);
        if (!p) return false;
        pendingPerms.delete(id);
        // «موافقة دائمة» لعمر التطبيق — لا تسري على أدوات التنفيذ (exec إلزامي كل مرة)
        if (allow && always && tools.permissionTier(p.name) !== 'exec') alwaysAllowed.add(p.name);
        p.resolve(!!allow);
        return true;
      },
    };
  }

  return { start };
}

// `make` هو العقد العام؛ البقية دوال نقية مُصدَّرة ليحرسها test:adapters بحالاتها
// الحدّية (ترويسة مشوّهة/HTTP-date/سقف) بلا نوم حقيقي لكل حالة.
module.exports = {
  make, parseRetryAfterMs, classifyRateLimit, rateLimitMessage, planRateLimitWait,
  clearOldToolResults, capHistory, prepareRequestMessages,
  MAX_TURNS, PROTECTED_TOOL_ROUNDS, CLEARED_TOOL_RESULT_TAIL_CHARS, CLEARED_TOOL_RESULT_NOTICE,
  MAX_RATE_LIMIT_RETRIES, RATE_LIMIT_BACKOFF_MS, RETRY_AFTER_MAX_MS, RATE_LIMIT_BUDGET_MS,
};
