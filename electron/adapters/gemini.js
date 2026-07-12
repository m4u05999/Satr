/**
 * محوّل Gemini عبر واجهة REST المباشرة (Generative Language API) — المرحلة 5 «الحل الجذري».
 *
 * لماذا REST لا gemini-cli؟ تحقّق حيّ أثبت أن gemini-cli أداة ثقيلة ومتقلّبة في الوضع
 * غير التفاعلي (طبقة OAuth المجانية أُلغيت، ثقة المجلد تُعلّق الموافقة، إضافات تُحمَّل،
 * «auto» يوجّه لنماذج بطيئة/محمّلة) — بينما واجهة REST بنموذج gemini-2.5-flash تردّ في ~3ث
 * بثبات. فنخاطبها مباشرة عبر وحدة https المدمجة (صفر اعتماديات — القاعدة 5).
 *
 * حلقة الوكيل (الدفعة 2.4 — تعميم 2.1/2.2/2.3): نفس أدوات «سطر» (electron/tools.js)
 * بصيغة Gemini (functionDeclarations / functionCall / functionResponse) وبنفس عقد
 * الأحداث للواجهة (tool_use/tool_result/permission_request/file_edit) — كل نموذج جديد
 * يرث الوكيل كاملاً. الأذونات بطبقتي write/exec كما في openai-compatible.
 *
 * الواجهة الموحّدة: start(input, cwd, emit) → { stop(), resolvePermission() }.
 *
 * أمان: المفتاح في ترويسة HTTP (لا وسائط spawn، لا صدفة)، والبرومبت في جسم JSON (لا حقن)،
 * والأدوات تنفّذ عبر مسارات files.js/term.js المؤمَّنة. حدود: نص فقط (لا صور).
 * الذاكرة: كاش حيّ + قرص (1.3) بصيغة Gemini الأصلية (contents بما فيها نداءات الأدوات).
 */

const https = require('https');
const crypto = require('crypto');
const keys = require('../keys');
const chats = require('../chats'); // ذاكرة على القرص (1.3): استئناف بعد إعادة التشغيل
const tools = require('../tools'); // أدوات الوكيل (2.1–2.3)
const skillCatalog = require('../skills'); // فهرس المهارات المحمولة والتحميل التدريجي
const memory = require('../memory'); // ذاكرة مشروع شخصية مُقَرّة ضمن ميزانية
const contextBudget = require('../context'); // خلاصة repo map + usage تقديري موسوم estimate

// ---- بِتّات خاصة بمزوّد Gemini ----
const API_HOST = 'generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
// ⚠️ متحقَّق حيّاً: «auto» يوجّه لنماذج بطيئة (>24ث) أو محمّلة (503)؛ 2.5-flash ~3ث بثبات.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_MODEL_RE = /^gemini[A-Za-z0-9.-]*$/i; // نموذج Gemini صريح من الواجهة

const PROVIDER = 'gemini';
const histories = new Map(); // session_id → contents بصيغة Gemini (كاش حيّ فوق القرص)
const MAX_TURNS = 40;        // آخر 40 مدخل contents لكل جلسة
const MAX_SESSIONS = 50;     // سقف الجلسات في الكاش الحيّ
const MAX_TOOL_ROUNDS = 8;   // سقف جولات الأدوات في الدور (حارس حلقة لانهائية)

// «موافقة دائمة» لعمر التطبيق (نفس نموذج openai-compatible — طبقة write فقط)
const alwaysAllowed = new Set();

// تعريفات أدوات «سطر» بصيغة Gemini: functionDeclarations من defs() الموحّدة.
// أداة بلا وسائط ⇐ تُحذف parameters كلياً (Gemini يرفض OBJECT بخصائص فارغة)
function geminiToolDefs() {
  const decls = [];
  for (const d of tools.defs()) {
    const f = d.function;
    const decl = { name: f.name, description: f.description };
    const props = f.parameters && f.parameters.properties;
    if (props && Object.keys(props).length) decl.parameters = f.parameters;
    decls.push(decl);
  }
  return [{ functionDeclarations: decls }];
}

// نسخة عرض لوسائط الأداة في مربع الإذن — تقصّ الحقول الطويلة (نفس نمط openai-compatible)
function displayInput(args) {
  const out = {};
  for (const k of Object.keys(args || {})) {
    const v = args[k];
    out[k] = (typeof v === 'string' && v.length > 800) ? v.slice(0, 800) + '… (+' + (v.length - 800) + ')' : v;
  }
  return out;
}

// مفتاح الواجهة: بيئة النظام أولاً، ثم مخزن مفاتيح «سطر» (~/.satr/keys.json)
function resolveApiKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || keys.get('GEMINI_API_KEY') || '').trim();
}

function start(input, cwd, emit) {
  const { prompt, sessionId, model, permissionMode } = input;
  const skillContext = skillCatalog.resolveSelection(cwd, input.skills);
  const skillPrompt = skillCatalog.catalogPrompt(skillContext);
  const memoryPrompt = memory.retrieve(cwd, prompt).text;
  let contextPrompt = [skillPrompt, memoryPrompt].filter(Boolean).join('\n\n');
  const autoAllowWrites = permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';

  const apiKey = resolveApiKey();
  if (!apiKey) {
    queueMicrotask(() => {
      emit({ type: 'spawn_error', text: 'لم يُضبط مفتاح Gemini. أضِفه من ⚙ ← «مفاتيح المزوّدين» (المفتاح من '
        + 'https://aistudio.google.com/apikey) أو في الملف ' + keys.KEYS_PATH
        + ' بالصيغة: {"GEMINI_API_KEY":"..."}' });
      emit({ type: 'result', session_id: sessionId || null, is_error: true, result: 'مفتاح API مفقود' });
      emit({ type: 'proc_done', code: 1 });
    });
    return { stop() { return Promise.resolve(); } };
  }

  const useModel = (model && GEMINI_MODEL_RE.test(model)) ? model : DEFAULT_MODEL;

  // جلسة قائمة: الكاش الحيّ أولاً ثم القرص (استئناف بعد إعادة التشغيل — 1.3)
  let resumed = (sessionId && histories.get(sessionId)) || null;
  if (sessionId && !resumed) resumed = chats.load(PROVIDER, sessionId);
  const sid = (sessionId && resumed) ? sessionId : crypto.randomUUID();
  const history = resumed || [];

  emit({ type: 'system', subtype: 'init', session_id: sid, model: useModel });

  const apiPath = `/${API_VERSION}/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse`;
  const startedAt = Date.now();
  let aborted = false;
  let currentReq = null;
  let toolsOk = true; // يُعطَّل إن رفض المزوّد الأدوات (تدهور رشيق لدردشة)
  let callSeq = 0;    // Gemini لا يصدر معرّفات نداءات — نولّدها لبطاقات الواجهة
  // استهلاك الدور (3.3): آخر usageMetadata (طلب Gemini يشمل السجل كاملاً فالأخير أشمل)
  const usageTotal = { input_tokens: 0, output_tokens: 0 };
  const estimatedUsage = { input_tokens: 0, output_tokens: 0 };
  let contextEstimate = null;

  // ---------- الإذن العربي (نفس عقد openai-compatible — 2.2/2.3) ----------
  const pendingPerms = new Map();
  function askPermission(callId, name, args, tier) {
    if (permissionMode === 'bypassPermissions') return Promise.resolve(true);
    if (tier === 'write' && (autoAllowWrites || alwaysAllowed.has(name))) return Promise.resolve(true);
    emit({ type: 'permission_request', id: callId, tool: name, input: displayInput(args) });
    return new Promise((resolve) => { pendingPerms.set(callId, { resolve, name }); });
  }

  // طلب واحد: يبثّ النص حيّاً ويجمع نداءات الأدوات (functionCall) من SSE
  function requestOnce(contents, withTools) {
    return new Promise((resolve) => {
      let textBuf = '';
      let sseBuf = '';
      const calls = []; // { name, args } — تصل كاملة في أجزاء parts (لا تجزئة كالبروتوكول الآخر)
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };

      const bodyObj = { contents };
      if (contextPrompt) bodyObj.systemInstruction = { parts: [{ text: contextPrompt }] };
      if (withTools) bodyObj.tools = geminiToolDefs();
      estimatedUsage.input_tokens += contextBudget.estimateTokens(bodyObj);
      const body = JSON.stringify(bodyObj);

      const handleFrame = (jsonStr) => {
        if (!jsonStr || jsonStr === '[DONE]') return;
        let obj;
        try { obj = JSON.parse(jsonStr); } catch (e) { return; }
        // استهلاك الرموز (3.3): usageMetadata يصل مع الإطارات الأخيرة — نأخذ آخر قيمة
        if (obj && obj.usageMetadata) {
          usageTotal.input_tokens = obj.usageMetadata.promptTokenCount || usageTotal.input_tokens;
          usageTotal.output_tokens = obj.usageMetadata.candidatesTokenCount || usageTotal.output_tokens;
        }
        const cand = obj && obj.candidates && obj.candidates[0];
        const parts = cand && cand.content && cand.content.parts;
        if (!Array.isArray(parts)) return;
        for (const p of parts) {
          if (typeof p.text === 'string' && p.text) {
            textBuf += p.text;
            emit({ type: 'stream_text', text: p.text });
          }
          if (p.functionCall && p.functionCall.name) {
            calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
          }
        }
      };

      const options = {
        host: API_HOST, path: apiPath, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        res.setEncoding('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let errBody = '';
          res.on('data', (d) => { errBody += d; });
          res.on('end', () => {
            let msg = 'رمز HTTP ' + res.statusCode;
            try { const j = JSON.parse(errBody); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
            done({ error: msg, status: res.statusCode });
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
        res.on('end', () => done({ text: textBuf, calls }));
      });

      req.on('error', (e) => {
        done({ error: aborted ? '__aborted__' : ('تعذّر الاتصال بـ Gemini: ' + String(e && e.message)) });
      });

      currentReq = req;
      req.write(body);
      req.end();
    });
  }

  const fail = (msg) => {
    emit({ type: 'spawn_error', text: 'فشل طلب Gemini: ' + msg });
    emit({ type: 'result', session_id: sid, is_error: true, duration_ms: Date.now() - startedAt, result: msg });
    emit({ type: 'proc_done', code: 1 });
  };

  // حلقة الوكيل (2.4): functionCall ⇒ إذن حسب الطبقة ⇒ تنفيذ محلي ⇒ functionResponse ⇒ معاودة
  (async () => {
    const builtContext = await contextBudget.buildBlindContext({
      cwd,
      prompt,
      systemParts: [skillPrompt, memoryPrompt],
      history,
      toolDefinitions: tools.defs(),
    });
    if (aborted) return;
    contextPrompt = builtContext.systemPrompt;
    contextEstimate = builtContext.estimate;
    const contents = history.concat([{ role: 'user', parts: [{ text: prompt }] }]);
    let rounds = 0;
    while (true) {
      const r = await requestOnce(contents, toolsOk);
      if (aborted || r.error === '__aborted__') return;
      if (r.error) {
        // رفض 4xx في أول طلب مع أدوات ⇐ محاولة واحدة دونها (تدهور رشيق)
        if (toolsOk && rounds === 0 && r.status >= 400 && r.status < 500) {
          toolsOk = false;
          continue;
        }
        fail(r.error);
        return;
      }
      estimatedUsage.output_tokens += contextBudget.estimateTokens({ text: r.text, calls: r.calls });

      if (r.calls.length && rounds < MAX_TOOL_ROUNDS) {
        rounds++;
        // معرّفات لبطاقات الواجهة (وثبات الربط بين tool_use و tool_result)
        const withIds = r.calls.map((c) => ({ ...c, id: 'gm_' + sid.slice(0, 8) + '_' + (++callSeq) }));
        const blocks = withIds.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }));
        if (r.text) blocks.unshift({ type: 'text', text: r.text });
        emit({ type: 'assistant', message: { content: blocks } });

        // دور النموذج في السجل (بصيغة Gemini الأصلية — تُحفظ كما هي في الذاكرة)
        const modelParts = [];
        if (r.text) modelParts.push({ text: r.text });
        for (const c of r.calls) modelParts.push({ functionCall: { name: c.name, args: c.args } });
        contents.push({ role: 'model', parts: modelParts });

        const responseParts = [];
        for (const c of withIds) {
          if (aborted) return;
          const tier = tools.permissionTier(c.name);
          let out;
          if (tier) {
            const allowed = await askPermission(c.id, c.name, c.args, tier);
            if (aborted) return;
            out = allowed
              ? await tools.run(c.name, cwd, c.args, { emit, id: c.id, skillContext, engine: PROVIDER })
              : { ok: false, content: 'رفض المستخدم هذا الإجراء — لا تعاود المحاولة نفسها؛ اشرح ما كنت ستفعله أو اقترح بديلاً' };
          } else {
            out = await tools.run(c.name, cwd, c.args, { emit, id: c.id, skillContext, engine: PROVIDER });
          }
          emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, is_error: !out.ok }] } });
          responseParts.push({ functionResponse: { name: c.name, response: { result: out.content } } });
        }
        contents.push({ role: 'user', parts: responseParts });
        continue;
      }

      // دور مكتمل (نص نهائي أو استُنفدت الجولات)
      if (r.text) {
        contents.push({ role: 'model', parts: [{ text: r.text }] });
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: r.text }] } });
      }
      const h = contents.slice();
      while (h.length > MAX_TURNS) h.shift();
      // لا functionResponse يتيم في المقدمة بعد القصّ (المزوّد يرفضه بلا functionCall يسبقه)
      while (h.length && (h[0].role === 'model'
        || (Array.isArray(h[0].parts) && h[0].parts.some((p) => p.functionResponse)))) h.shift();
      if (!histories.has(sid) && histories.size >= MAX_SESSIONS) {
        histories.delete(histories.keys().next().value); // إخلاء الأقدم
      }
      histories.set(sid, h);
      chats.save(PROVIDER, sid, h); // حفظ على القرص — أفضل جهد (1.3)
      emit({
        type: 'result', session_id: sid, is_error: false,
        duration_ms: Date.now() - startedAt, num_turns: rounds + 1,
        usage: contextBudget.resolveUsage(usageTotal, estimatedUsage),
        context_estimate: contextEstimate,
        provider: PROVIDER,
      });
      emit({ type: 'proc_done', code: 0 });
      return;
    }
  })();

  return {
    stop() {
      aborted = true;
      for (const [, p] of pendingPerms) { try { p.resolve(false); } catch (e) {} }
      pendingPerms.clear();
      try { if (currentReq) currentReq.destroy(); } catch (e) {}
      return Promise.resolve();
    },
    resolvePermission(id, allow, always) {
      const p = pendingPerms.get(id);
      if (!p) return false;
      pendingPerms.delete(id);
      if (allow && always && tools.permissionTier(p.name) !== 'exec') alwaysAllowed.add(p.name);
      p.resolve(!!allow);
      return true;
    },
  };
}

module.exports = { start };
