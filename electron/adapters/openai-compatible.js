/**
 * مصنع محوّل متوافق مع OpenAI Chat Completions — يخدم رؤية «كل النماذج بالعربية».
 *
 * DeepSeek/Qwen/GLM/Kimi وأغلب المزوّدين (بما فيهم نقطة Gemini المتوافقة) يتكلّمون نفس
 * بروتوكول OpenAI: POST /chat/completions ببثّ SSE (`data: {choices[].delta.content}` ثم
 * `data: [DONE]`). فبدل محوّل لكل مزوّد، هذا **مصنع واحد** يُنتج محوّلاً لأي endpoint
 * بإعطائه إعداده — إضافة مزوّد جديد = سطر تسجيل واحد (docs/ARCHITECTURE.md §4.2).
 *
 * make(config) → { start(input, cwd, emit) → { stop() } }  (نفس عقد المحوّلات).
 * config: { id, host, path, keyName, defaultModel, label } — id هو معرّف مجلد الذاكرة
 * على القرص (~/.satr/chats/<id>/)؛ بدونه تبقى الذاكرة حيّة فقط (تُمسح بإعادة التشغيل).
 *
 * أمان: المفتاح في ترويسة Authorization (لا spawn/صدفة)، البرومبت في جسم JSON (لا حقن).
 * حدود: نص فقط (لا صور/أدوات بعد)؛ الذاكرة كاش حيّ + قرص (الدفعة 1.3).
 */

const https = require('https');
const crypto = require('crypto');
const keys = require('../keys');
const chats = require('../chats'); // ذاكرة على القرص (1.3): استئناف بعد إعادة التشغيل

const MAX_TURNS = 40;     // آخر 40 رسالة لكل جلسة (سقف الرموز)
const MAX_SESSIONS = 50;  // سقف الجلسات في الكاش الحيّ لكل مزوّد

function make(config) {
  const { id: providerId, host, path: apiPath, keyName, defaultModel, label } = config;
  const histories = new Map(); // session_id -> [{role, content}] (كاش حيّ فوق القرص)

  // المفتاح: بيئة النظام أولاً ثم مخزن «سطر» (~/.satr/keys.json) — موثوق بلا وراثة بيئة
  function resolveKey() {
    return (process.env[keyName] || keys.get(keyName) || '').trim();
  }

  function start(input, cwd, emit) {
    const { prompt, sessionId, model } = input;

    const apiKey = resolveKey();
    if (!apiKey) {
      queueMicrotask(() => {
        emit({ type: 'spawn_error', text: 'لم يُضبط مفتاح ' + label + '. ضع مفتاحك في الملف '
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

    const messages = history.concat([{ role: 'user', content: prompt }]);
    const body = JSON.stringify({ model: useModel, messages, stream: true });

    emit({ type: 'system', subtype: 'init', session_id: sid, model: useModel });

    const startedAt = Date.now();
    let textBuf = '';
    let sseBuf = '';
    let finished = false;
    let aborted = false;
    let req = null;

    const finalize = (isError, errText) => {
      if (finished) return;
      finished = true;
      if (!isError && textBuf) {
        const h = history.concat([
          { role: 'user', content: prompt },
          { role: 'assistant', content: textBuf },
        ]);
        while (h.length > MAX_TURNS) h.shift();
        if (!histories.has(sid) && histories.size >= MAX_SESSIONS) {
          histories.delete(histories.keys().next().value);
        }
        histories.set(sid, h);
        if (providerId) chats.save(providerId, sid, h); // حفظ على القرص — أفضل جهد (1.3)
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: textBuf }] } });
      }
      const out = { type: 'result', session_id: sid, is_error: !!isError, duration_ms: Date.now() - startedAt };
      if (isError) out.result = String(errText || ('خطأ في ' + label));
      emit(out);
      emit({ type: 'proc_done', code: isError ? 1 : 0 });
    };

    // إطار SSE: data: {choices[0].delta.content} أو data: [DONE]
    const handleFrame = (jsonStr) => {
      if (!jsonStr || jsonStr === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(jsonStr); } catch (e) { return; }
      const choice = obj && obj.choices && obj.choices[0];
      const piece = choice && choice.delta && choice.delta.content;
      if (typeof piece === 'string' && piece) {
        textBuf += piece;
        emit({ type: 'stream_text', text: piece });
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

    req = https.request(options, (res) => {
      res.setEncoding('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = '';
        res.on('data', (d) => { errBody += d; });
        res.on('end', () => {
          let msg = 'رمز HTTP ' + res.statusCode;
          try { const j = JSON.parse(errBody); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
          emit({ type: 'spawn_error', text: 'فشل طلب ' + label + ': ' + msg });
          finalize(true, msg);
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
      res.on('end', () => finalize(false));
    });

    req.on('error', (e) => {
      if (aborted) return;
      emit({ type: 'spawn_error', text: 'تعذّر الاتصال بـ ' + label + ': ' + String(e && e.message) });
      finalize(true, e && e.message);
    });

    req.write(body);
    req.end();

    return {
      stop() {
        aborted = true;
        try { if (req) req.destroy(); } catch (e) {}
        finished = true;
        return Promise.resolve();
      },
    };
  }

  return { start };
}

module.exports = { make };
