/**
 * مصنع محوّل متوافق مع OpenAI Chat Completions — يخدم رؤية «كل النماذج بالعربية».
 *
 * DeepSeek/Qwen/GLM/Kimi وأغلب المزوّدين (بما فيهم نقطة Gemini المتوافقة) يتكلّمون نفس
 * بروتوكول OpenAI: POST /chat/completions ببثّ SSE (`data: {choices[].delta}` ثم
 * `data: [DONE]`). فبدل محوّل لكل مزوّد، هذا **مصنع واحد** يُنتج محوّلاً لأي endpoint
 * بإعطائه إعداده — إضافة مزوّد جديد = سطر تسجيل واحد (docs/ARCHITECTURE.md §4.2).
 *
 * make(config) → { start(input, cwd, emit) → { stop() } }  (نفس عقد المحوّلات).
 * config: { id, host, path, keyName, defaultModel, label } — id هو معرّف مجلد الذاكرة
 * على القرص (~/.satr/chats/<id>/)؛ بدونه تبقى الذاكرة حيّة فقط (تُمسح بإعادة التشغيل).
 *
 * حلقة الوكيل (الدفعة 2.1): الطلب يعلن أدوات «سطر» (electron/tools.js — قراءة فقط
 * حالياً). النموذج يطلب أداة ⇒ ننفّذها محلياً ونعيد النتيجة برسالة role:"tool" ونعاود
 * الطلب — حتى MAX_TOOL_ROUNDS جولات. بطاقات الأدوات تُبثّ للواجهة **بنفس عقد أحداث
 * SDK** (tool_use/tool_result) فلا تغيير في الواجهة. نموذج لا يدعم الأدوات (بعض نسخ
 * R1) ⇒ رفض HTTP يُعاد بعده الطلب مرة واحدة دونها (تدهور رشيق لدردشة عادية).
 *
 * أمان: المفتاح في ترويسة Authorization (لا spawn/صدفة)، البرومبت في جسم JSON (لا حقن)،
 * والأدوات تنفّذ عبر مسارات files.js المؤمَّنة (داخل cwd حصراً).
 * حدود: لا صور؛ أدوات القراءة فقط (الكتابة/التنفيذ في 2.2/2.3)؛ الذاكرة كاش حيّ + قرص (1.3).
 */

const https = require('https');
const crypto = require('crypto');
const keys = require('../keys');
const chats = require('../chats'); // ذاكرة على القرص (1.3): استئناف بعد إعادة التشغيل
const tools = require('../tools'); // أدوات الوكيل (2.1): read_file / list_files

const MAX_TURNS = 40;       // آخر 40 رسالة لكل جلسة (سقف الرموز)
const MAX_SESSIONS = 50;    // سقف الجلسات في الكاش الحيّ لكل مزوّد
const MAX_TOOL_ROUNDS = 8;  // سقف جولات الأدوات في الدور الواحد (حارس حلقة لانهائية)

// تحليل وسائط أداة قادمة من النموذج — نص JSON قد يكون معطوباً، فلا استثناء أبداً
function safeParse(s) {
  try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}

function make(config) {
  const { id: providerId, host, path: apiPath, keyName, defaultModel, label } = config;
  const histories = new Map(); // session_id -> رسائل بصيغة OpenAI (كاش حيّ فوق القرص)

  // المفتاح: بيئة النظام أولاً ثم مخزن «سطر» (~/.satr/keys.json) — موثوق بلا وراثة بيئة
  function resolveKey() {
    return (process.env[keyName] || keys.get(keyName) || '').trim();
  }

  function start(input, cwd, emit) {
    const { prompt, sessionId, model } = input;

    const apiKey = resolveKey();
    if (!apiKey) {
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
    let toolsOk = true; // يُعطَّل بعد رفض المزوّد للأدوات (نموذج لا يدعم tool-calling)

    // طلب واحد للمزوّد: يبثّ النص حيّاً ويجمع نداءات الأدوات المتدفقة (SSE)
    function requestOnce(messages, withTools) {
      return new Promise((resolve) => {
        let textBuf = '';
        let sseBuf = '';
        const calls = new Map(); // index -> { id, name, args } (الوسائط تصل مجزّأة)
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };

        const bodyObj = { model: useModel, messages, stream: true };
        if (withTools) bodyObj.tools = tools.defs();
        const body = JSON.stringify(bodyObj);

        // إطار SSE: data: {choices[0].delta{content|tool_calls}} أو data: [DONE]
        const handleFrame = (jsonStr) => {
          if (!jsonStr || jsonStr === '[DONE]') return;
          let obj;
          try { obj = JSON.parse(jsonStr); } catch (e) { return; }
          const choice = obj && obj.choices && obj.choices[0];
          if (!choice) return;
          const delta = choice.delta || {};
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

        const options = {
          host, path: apiPath, method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
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
          res.on('end', () => done({
            text: textBuf,
            calls: [...calls.values()].filter((c) => c.id && c.name),
          }));
        });

        req.on('error', (e) => {
          done({ error: aborted ? '__aborted__' : ('تعذّر الاتصال بـ ' + label + ': ' + String(e && e.message)) });
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
      const messages = history.concat([{ role: 'user', content: prompt }]);
      let rounds = 0;
      while (true) {
        const r = await requestOnce(messages, toolsOk);
        if (aborted || r.error === '__aborted__') return;
        if (r.error) {
          // رفض 4xx في أول طلب مع أدوات ⇐ الأرجح نموذج لا يدعمها — محاولة واحدة دونها
          if (toolsOk && rounds === 0 && r.status >= 400 && r.status < 500) {
            toolsOk = false;
            continue;
          }
          fail(r.error);
          return;
        }

        if (r.calls.length && rounds < MAX_TOOL_ROUNDS) {
          rounds++;
          // بطاقات الأدوات للواجهة — نفس عقد أحداث SDK (صفر تغيير واجهة)
          const blocks = r.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: safeParse(c.args) }));
          if (r.text) blocks.unshift({ type: 'text', text: r.text });
          emit({ type: 'assistant', message: { content: blocks } });

          // سجل المحادثة بصيغة OpenAI الأصلية (يُحفظ كما هو في الذاكرة — 1.3)
          messages.push({
            role: 'assistant',
            content: r.text || null,
            tool_calls: r.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
          });
          for (const c of r.calls) {
            if (aborted) return;
            const out = await tools.run(c.name, cwd, safeParse(c.args));
            emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, is_error: !out.ok }] } });
            messages.push({ role: 'tool', tool_call_id: c.id, content: out.content });
          }
          continue;
        }

        // دور مكتمل (نص نهائي، أو استُنفدت الجولات)
        if (r.text) {
          messages.push({ role: 'assistant', content: r.text });
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: r.text }] } });
        }
        const h = messages.slice();
        while (h.length > MAX_TURNS) h.shift();
        // لا رسالة أداة يتيمة في المقدمة بعد القصّ (المزوّد يرفض tool بلا نداء يسبقها)
        while (h.length && h[0].role === 'tool') h.shift();
        if (!histories.has(sid) && histories.size >= MAX_SESSIONS) {
          histories.delete(histories.keys().next().value); // إخلاء الأقدم من الكاش
        }
        histories.set(sid, h);
        if (providerId) chats.save(providerId, sid, h); // حفظ على القرص — أفضل جهد (1.3)
        emit({ type: 'result', session_id: sid, is_error: false, duration_ms: Date.now() - startedAt, num_turns: rounds + 1 });
        emit({ type: 'proc_done', code: 0 });
        return;
      }
    })();

    return {
      stop() {
        aborted = true;
        try { if (currentReq) currentReq.destroy(); } catch (e) {}
        return Promise.resolve();
      },
    };
  }

  return { start };
}

module.exports = { make };
