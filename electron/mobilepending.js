/**
 * سطر — نواة الظروف المعلّقة للتحكم من الجوال (مشتركة بين النقلين)
 *
 * منطق **مستقل عن النقل** كلياً: بناء الظرف، طابور FIFO، المهلة، الحسم مرة واحدة،
 * والسحب. تستهلكه القناة المحلية (`mobilelink.js` — خادم LAN) وعميل الوسيط
 * (`mobilerelay.js`) فيبقى **تنفيذ واحد**.
 *
 * ⚠️ سبب الاستخراج: نسخ هذا المنطق لكل نقل يعيد نمط الأعطال الثمانية في
 * docs/MOBILE-CONTROL-PLAN.md §5.5 — عقدٌ واحد بقارئين يتباعدان بصمت بينما
 * اختبارات كل طرف خضراء. الحسم والسحب وحارس «ما زال معلّقاً» عقد أمني: تكراره
 * يعني احتمال تباعده.
 *
 * لا يعرف HTTP ولا تعمية ولا أجهزة — النقل يحقن `buildEnvelope` ويستدعي
 * `onOffer` ليوقظ مستهلكيه.
 */
'use strict';

const DECISIONS = new Set(['allow', 'allow_turn', 'deny']);
const MAX_PENDING = 32;
const MAX_ENVELOPE_ID = 200;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 1000;

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * @param {{buildEnvelope:Function, onOffer?:Function, maxPending?:number}} deps
 *   buildEnvelope(rawReq, {project, taskSummary, createdAt, ttlMs}) -> envelope
 *   onOffer() — يُستدعى بعد إدراج ظرف جديد (إيقاظ منتظرين/دفع للوسيط)
 */
function createPendingStore(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  if (typeof d.buildEnvelope !== 'function') throw new Error('bad_deps');
  const onOffer = typeof d.onOffer === 'function' ? d.onOffer : () => {};
  const maxPending = Number.isSafeInteger(d.maxPending) && d.maxPending > 0 ? d.maxPending : MAX_PENDING;

  const byId = new Map(); // envelope_id -> record
  const order = []; // نفس السجلات بالأقدم أولاً (FIFO للتسليم)
  let stopped = false;

  function remove(record) {
    byId.delete(record.id);
    const index = order.indexOf(record);
    if (index !== -1) order.splice(index, 1);
  }

  /** يحسم معلّقاً مرة واحدة ويسحبه — القرار أو `null` (لا حسم). */
  function settle(record, decision) {
    if (!record || record.done) return false;
    record.done = true;
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    remove(record);
    const value = DECISIONS.has(decision) ? decision : null;
    try { record.resolve(value); } catch { /* لا يفشل الحسم بسبب مستهلك */ }
    return true;
  }

  function oldest() {
    for (const record of order) {
      if (!record.done) return record;
    }
    return null;
  }

  /**
   * يعرض طلب إذن. يعيد وعداً بقرار الجوال أو `null` (لم يحسم).
   * @returns {Promise<'allow'|'allow_turn'|'deny'|null>}
   */
  function offer(rawReq, ctx) {
    if (stopped) return Promise.resolve(null);
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    const now = Date.now();
    const ttlMs = clampInt(context.ttlMs, MIN_TTL_MS, MAX_TTL_MS, DEFAULT_TTL_MS);
    const createdAt = Number.isFinite(context.createdAt) && context.createdAt >= 0
      ? Math.floor(context.createdAt) : now;

    let envelope = null;
    try {
      envelope = d.buildEnvelope(rawReq, {
        project: typeof context.project === 'string' ? context.project : undefined,
        taskSummary: typeof context.taskSummary === 'string' ? context.taskSummary : undefined,
        createdAt,
        ttlMs,
      });
    } catch { return Promise.resolve(null); }

    const id = envelope && typeof envelope.envelope_id === 'string' ? envelope.envelope_id : '';
    // ظرف بلا معرّف لا يمكن ربط ردّ به ⇒ لا يُسجَّل (فشل مغلق، يبقى مربع سطح المكتب)
    if (!id || id.length > MAX_ENVELOPE_ID) return Promise.resolve(null);
    if (order.length >= maxPending) return Promise.resolve(null);

    // معرّف مكرّر: نسحب القديم بلا قرار كي لا يبقى ظرف قابل للإجابة عن نداء منتهٍ
    const previous = byId.get(id);
    if (previous) settle(previous, null);

    return new Promise((resolve) => {
      const record = { id, envelope, resolve, done: false, timer: null };
      record.timer = setTimeout(() => { settle(record, null); }, ttlMs);
      if (typeof record.timer.unref === 'function') record.timer.unref();
      byId.set(id, record);
      order.push(record);
      onOffer();
    });
  }

  /** سطح المكتب حسم أولاً ⇒ يُزال المعلّق فوراً (حارس الموافقة القديمة). */
  function withdraw(envelopeId) {
    if (typeof envelopeId !== 'string' || !envelopeId) return false;
    const record = byId.get(envelopeId);
    if (!record) return false;
    return settle(record, null);
  }

  /** حسم ردّ وارد: يشترط أن يكون الظرف **ما زال معلّقاً** (حارس الموافقة القديمة). */
  function resolveDecision(envelopeId, decision) {
    const record = byId.get(envelopeId);
    if (!record || record.done) return false;
    if (!DECISIONS.has(decision)) return false;
    return settle(record, decision);
  }

  /** يحسم كل المعلّقات بلا قرار — عند الإغلاق. */
  function stop() {
    stopped = true;
    for (const record of order.slice()) settle(record, null);
  }

  function pendingCount() {
    return order.filter((record) => !record.done).length;
  }

  return { offer, withdraw, oldest, settle, resolveDecision, stop, pendingCount, get: (id) => byId.get(id) };
}

module.exports = {
  createPendingStore,
  DECISIONS,
  MAX_PENDING,
  MAX_ENVELOPE_ID,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
};
