/**
 * محوّل Gemini عبر واجهة REST المباشرة (Generative Language API) — المرحلة 5 «الحل الجذري».
 *
 * لماذا REST لا gemini-cli؟ تحقّق حيّ أثبت أن gemini-cli أداة ثقيلة ومتقلّبة في الوضع
 * غير التفاعلي (طبقة OAuth المجانية أُلغيت، ثقة المجلد تُعلّق الموافقة، إضافات تُحمَّل،
 * «auto» يوجّه لنماذج بطيئة/محمّلة) — بينما واجهة REST بنموذج gemini-2.5-flash تردّ في ~3ث
 * بثبات. فنخاطبها مباشرة عبر وحدة https المدمجة (صفر اعتماديات — القاعدة 5).
 *
 * 🌱 بذرة «طبقة المزوّد» العامة (الرؤية: بوابة عربية لكل النماذج): البِتّات الخاصة بالمزوّد
 * معزولة أدناه (المسار/الترويسات/بناء الجسم/تحليل SSE)، فإضافة مزوّد متوافق مع OpenAI
 * (DeepSeek/Qwen/GLM/…) لاحقاً = محوّل جديد بنفس البنية دون لمس بقية «سطر».
 *
 * الواجهة الموحّدة: start(input, cwd, emit) → { stop() }. تطبيع لأحداث «سطر» نفسها
 * (system/stream_text/assistant/result) — الواجهة لا تتغيّر.
 *
 * أمان: المفتاح في ترويسة HTTP (لا وسائط spawn، لا صدفة)، والبرومبت في جسم JSON (لا حقن).
 * حدود موثّقة (المرحلة 5): نص فقط (لا صور/أدوات بعد)، لا كلفة معروضة، والذاكرة داخل
 * جلسة التطبيق (محفوظة في خريطة، تُمسح بإعادة التشغيل).
 */

const https = require('https');
const crypto = require('crypto');
const keys = require('../keys');
const chats = require('../chats'); // ذاكرة على القرص (1.3): استئناف بعد إعادة التشغيل

// ---- بِتّات خاصة بمزوّد Gemini (نقطة التعميم المستقبلية) ----
const API_HOST = 'generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
// ⚠️ متحقَّق حيّاً: «auto» يوجّه لنماذج بطيئة (>24ث) أو محمّلة (503)؛ 2.5-flash ~3ث بثبات.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_MODEL_RE = /^gemini[A-Za-z0-9.-]*$/i; // نموذج Gemini صريح من الواجهة

// ذاكرة المحادثة لكل جلسة (الواجهة تعيد session_id الذي نصدره) — REST بلا حالة فنمرّر
// كامل السجل كل دور. الخريطة كاش حيّ، والقرص (~/.satr/chats/gemini/) مصدر الاستئناف
// بعد إعادة التشغيل (الدفعة 1.3). سقف للطول يمنع انفجار الرموز.
const PROVIDER = 'gemini';
const histories = new Map();
const MAX_TURNS = 40;        // آخر 40 رسالة (مستخدم+نموذج) لكل جلسة
const MAX_SESSIONS = 50;     // سقف الجلسات في الكاش الحيّ (إخلاء الأقدم)

// مفتاح الواجهة: بيئة النظام أولاً، ثم مخزن مفاتيح «سطر» (~/.satr/keys.json) — الأخير
// موثوق لا يعتمد على وراثة البيئة أو إعادة التشغيل (بذرة أسرار Enterprise).
function resolveApiKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || keys.get('GEMINI_API_KEY') || '').trim();
}

function start(input, cwd, emit) {
  const { prompt, sessionId, model } = input;

  const apiKey = resolveApiKey();
  if (!apiKey) {
    // خطأ واضح بالعربية بدل فقاعة فارغة (الكشف الخفيف — نمط بوابة أول التشغيل)
    queueMicrotask(() => {
      emit({ type: 'spawn_error', text: 'لم يُضبط مفتاح Gemini. ضع مفتاحك (من '
        + 'https://aistudio.google.com/apikey) في الملف ' + keys.KEYS_PATH
        + ' بالصيغة: {"GEMINI_API_KEY":"..."}' });
      emit({ type: 'result', session_id: sessionId || null, is_error: true, result: 'مفتاح API مفقود' });
      emit({ type: 'proc_done', code: 1 });
    });
    return { stop() { return Promise.resolve(); } };
  }

  const useModel = (model && GEMINI_MODEL_RE.test(model)) ? model : DEFAULT_MODEL;

  // جلسة قائمة (session_id صدر منّا سابقاً وله سجل) أو جلسة جديدة.
  // الكاش الحيّ أولاً، ثم القرص (استئناف بعد إعادة تشغيل «سطر» — 1.3)
  let resumed = (sessionId && histories.get(sessionId)) || null;
  if (sessionId && !resumed) resumed = chats.load(PROVIDER, sessionId);
  const sid = (sessionId && resumed) ? sessionId : crypto.randomUUID();
  const history = resumed || [];

  // بناء المحتوى: السجل + رسالة المستخدم الجديدة
  const contents = history.concat([{ role: 'user', parts: [{ text: prompt }] }]);
  const body = JSON.stringify({ contents });

  // مطابقة لعقد «سطر»: system(init) يحمل session_id فتخزّنه الواجهة وتعيده الدور القادم
  emit({ type: 'system', subtype: 'init', session_id: sid, model: useModel });

  const path = `/${API_VERSION}/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse`;
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
      // حفظ الدور في ذاكرة الجلسة (مع سقف الطول)
      const h = history.concat([
        { role: 'user', parts: [{ text: prompt }] },
        { role: 'model', parts: [{ text: textBuf }] },
      ]);
      while (h.length > MAX_TURNS) h.shift();
      if (!histories.has(sid) && histories.size >= MAX_SESSIONS) {
        histories.delete(histories.keys().next().value); // إخلاء الأقدم
      }
      histories.set(sid, h);
      chats.save(PROVIDER, sid, h); // حفظ على القرص — أفضل جهد (1.3)
      // الرسالة المكتملة تحل محل النص الجزئي (نمط stream_text ← assistant)
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: textBuf }] } });
    }
    const out = { type: 'result', session_id: sid, is_error: !!isError, duration_ms: Date.now() - startedAt };
    if (isError) out.result = String(errText || 'خطأ في Gemini');
    emit(out);
    emit({ type: 'proc_done', code: isError ? 1 : 0 });
  };

  // معالجة إطار SSE واحد: data: {json}
  const handleFrame = (jsonStr) => {
    if (!jsonStr || jsonStr === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(jsonStr); } catch (e) { return; }
    const cand = obj && obj.candidates && obj.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          textBuf += p.text;
          emit({ type: 'stream_text', text: p.text }); // عرض حيّ تدريجي
        }
      }
    }
  };

  const options = {
    host: API_HOST, path, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  req = https.request(options, (res) => {
    res.setEncoding('utf8');
    // خطأ HTTP: الجسم JSON فيه error.message — نجمّعه ونطبّعه بالعربية
    if (res.statusCode < 200 || res.statusCode >= 300) {
      let errBody = '';
      res.on('data', (d) => { errBody += d; });
      res.on('end', () => {
        let msg = 'رمز HTTP ' + res.statusCode;
        try { const j = JSON.parse(errBody); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
        emit({ type: 'spawn_error', text: 'فشل طلب Gemini: ' + msg });
        finalize(true, msg);
      });
      return;
    }
    // بثّ SSE ناجح: أسطر «data: {json}»
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
    if (aborted) return; // إيقاف مقصود
    emit({ type: 'spawn_error', text: 'تعذّر الاتصال بـ Gemini: ' + String(e && e.message) });
    finalize(true, e && e.message);
  });

  req.write(body);
  req.end();

  return {
    stop() {
      aborted = true;
      try { if (req) req.destroy(); } catch (e) {}
      // لا نبثّ result عند الإيقاف اليدوي — الواجهة تعرض «أُوقف» عبر مسارها الخاص
      finished = true;
      return Promise.resolve();
    },
  };
}

module.exports = { start };
