/**
 * أثرُ أحداث الدور — عدّادٌ نقيّ يجيب سؤالاً واحداً: **أين يسقط الحدث؟**
 *
 * سببه [OBS-142]: نصُّ إجابةٍ أُنتج نظيفاً (`stop_reason:'end_turn'`، `1194` محرفاً،
 * مقيسٌ في سجل الجلسة) ولم يُعرض في الواجهة. وأُسقطت التفسيرات بالقياس واحداً واحداً
 * حتى بقيت دائرةٌ واحدة: الانقطاع **بعد التطبيع** — في حارس `runSeq`، أو نقل IPC، أو
 * هوية الكتلة في `app.js`. واتفق ثلاثة مستشارين مستقلين على التجربة نفسها: عدّاد
 * أحداث ثلاثي النقاط **مع تسجيل سبب الإسقاط**.
 *
 * ولماذا يلزم عدّاد أصلاً: `main.js` كان يُسقط الحدث القديم بـ`return` **صامت** بلا
 * أثر — فغيابُ الحدث لا يفرَّق عن عدم إنتاجه. هذا هو نفسه سبب بقاء `OBS-142` مفتوحة.
 *
 * ## ما لا يمرّ من هنا — بحكم البناء لا بحكم الانضباط
 *
 * **لا نصّ إطلاقاً**: لا `text` ولا `prompt` ولا مدخل أداة ولا خرجها. المسجَّل هو
 * `type` و`subtype` و`phase` و**طول** النصّ و`tool` (اسم الأداة بلا وسيطتها) وسبب
 * الإسقاط ورمزا الدور. فلا يحتاج المخزن إلى حجب أسرار لأنه لا يحمل ما يُحجب.
 *
 * ولا قرص ولا شبكة: كل شيء في ذاكرة العملية، ويُقرأ عند الطلب، ويُفقد بإغلاق التطبيق.
 * أي أنه أداة تشخيص للحادثة الحيّة لا سجلٌّ دائم.
 */

'use strict';

// سقوف مقصودة: الحلقة تكفي لدور طويل جداً (دور OBS-142 حمل 15 أداة و13 كتلة نصّ)،
// وتبقى الذاكرة مهملة. وما تجاوزها يظهر في `overflow` فلا يمرّ القصّ صامتاً.
const MAX_RING = 200;
const MAX_TOOL_NAME = 64;
// قائمة مغلقة لأسباب الإسقاط — سببٌ غير معلن يصير `other` ولا يُخترع له اسم.
const REASONS = new Set(['stale_token', 'sanitized_out', 'no_window']);

function safeName(value) {
  return String(value == null ? '' : value)
    .split('')
    .filter((ch) => {
      const c = ch.codePointAt(0);
      // نفس مجموعة `MCP_UNSAFE_NAME` في hookguard.js، لكن **بمُسنِد نقاط لا بتعبير
      // نمطي**: التعبير يحتاج المحارف حرفيّةً في المصدر، وهي التي تُتلف الملف.
      if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return false;
      if (c === 0x061C || c === 0x200E || c === 0x200F) return false;
      if (c >= 0x202A && c <= 0x202E) return false;
      if (c >= 0x2066 && c <= 0x2069) return false;
      return true;
    })
    .join('')
    .slice(0, MAX_TOOL_NAME);
}

// طول النصّ لا نصّه: يفرّق «حدثٌ فارغ» عن «حدثٌ حمل 1194 محرفاً» بلا تسريب حرف.
function textLen(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  if (typeof obj.text === 'string') return obj.text.length;
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') n += b.text.length;
  }
  return n;
}

// بصمة الحدث المعروضة — قائمة حقول **مغلقة**؛ ما ليس فيها لا يُنسخ.
function shape(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  const kinds = [...new Set(content.map((b) => (b && b.type) || '').filter(Boolean))];
  const toolNames = content
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => safeName(b.name));
  return {
    type: safeName(o.type),
    subtype: safeName(o.subtype),
    phase: safeName(o.phase),
    blocks: kinds,
    tools: toolNames.slice(0, 8),
    textLen: textLen(o),
  };
}

function create() {
  // لكل رمز دور سجلٌّ مستقل: خلط الأدوار هو نفسه ما نشخّصه، فلا يُخلط في القياس.
  const runs = new Map();
  let ring = [];
  let overflow = 0;

  function runOf(token) {
    const key = String(token);
    if (!runs.has(key)) {
      runs.set(key, { token: key, emitted: 0, sent: 0, dropped: 0, byType: {}, droppedByReason: {} });
    }
    return runs.get(key);
  }

  return {
    /** حدثٌ دخل `emit` قبل أي مرشّح. */
    emitted(token, obj) {
      const r = runOf(token);
      r.emitted += 1;
      const s = shape(obj);
      r.byType[s.type || '?'] = (r.byType[s.type || '?'] || 0) + 1;
      return s;
    },
    /** حدثٌ عبر كل المرشّحات وأُرسل إلى النافذة. */
    sent(token) { runOf(token).sent += 1; },
    /**
     * حدثٌ أُسقط — **والسبب إلزامي**. هذه هي النقطة التي كانت `return` صامتاً.
     * `currentSeq` يُسجَّل مع رمز الدور: تفاوتهما هو تعريف «قديم» نفسه.
     */
    dropped(token, obj, reason, currentSeq) {
      const why = REASONS.has(reason) ? reason : 'other';
      const r = runOf(token);
      r.dropped += 1;
      r.droppedByReason[why] = (r.droppedByReason[why] || 0) + 1;
      if (ring.length >= MAX_RING) { ring.shift(); overflow += 1; }
      ring.push({ ...shape(obj), reason: why, token: String(token), seq: String(currentSeq) });
    },
    /** لقطة للقراءة — بلا نصّ، وبالسقوف معلنة. */
    snapshot() {
      return {
        schema_version: 1,
        runs: [...runs.values()].slice(-16),
        drops: ring.slice(-MAX_RING),
        dropsOverflow: overflow,
        maxRing: MAX_RING,
      };
    },
    reset() { runs.clear(); ring = []; overflow = 0; },
  };
}

module.exports = { create, shape, textLen, MAX_RING, REASONS };
