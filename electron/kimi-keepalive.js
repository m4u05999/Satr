/**
 * سطر — سجل جلسات Kimi ACP الحية (K2 keep-alive).
 *
 * المشكلة: كان كل دور في kimi.js يطلق `kimi acp` ثم يقتله عند end_turn، فتموت معه
 * أي حالة حية داخل Kimi (cron، أهداف طويلة) ولا تصل أحداثها المتأخرة إلى الواجهة.
 *
 * الحل: قناة ACP (proc + rpc + mcpHost) تبقى حية بعد انتهاء الدور وتُستأجر للدور
 * التالي على sessionId نفسه. السجل هنا يملك دورة الحياة فقط (تسجيل/استئجار/خمول/
 * قتل)؛ منطق الدور يبقى في kimi.js ويُفوَّض عبر entry.shared.turn القابل للتبديل.
 *
 * الضمانات (لا أيتام): سقف عمليتين حيتين، خمول 15 دقيقة يقتل تلقائياً، killAll
 * عند إغلاق سطر، ومعالج exit في kimi.js يزيل المدخل من السجل.
 */

'use strict';

const MAX_LIVE_DEFAULT = 2;
const IDLE_MS_DEFAULT = 15 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const LATE_TEXT_MAX = 4000;
const LATE_DEBOUNCE_MS = 800;

function create(options) {
  const opts = options || {};
  const maxLive = Number.isInteger(opts.maxLive) && opts.maxLive > 0 ? opts.maxLive : MAX_LIVE_DEFAULT;
  const idleMs = Number.isInteger(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : IDLE_MS_DEFAULT;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  // حجب الأسرار والقص — يحقنه kimi.js (scrubStreamText) كي يمرّ كل حدث متأخر
  // بنفس بوابة أحداث الدور قبل بثه (قرار القائد أ).
  const scrub = typeof opts.scrub === 'function' ? opts.scrub : (value) => String(value || '');
  const toolTextFn = typeof opts.toolText === 'function' ? opts.toolText : () => '';
  const toolLabelFn = typeof opts.toolLabel === 'function' ? opts.toolLabel : (title) => String(title || '');

  // sessionId → { sessionId, proc, rpc, shared, mcpHost, cwd, model, configOptions,
  //               startedAt, lastActivityAt, lateBuffers, lateTimers }
  const registry = new Map();
  let notifier = null;      // يضبطها main.js لبث شريط bg_procs المدمج
  let lateEventSink = null; // يضبطها main.js لبث kimi_keepalive_event
  let pruneTimer = null;

  function setNotifier(fn) { notifier = fn; }
  function setLateEventSink(fn) { lateEventSink = fn; }

  function snapshotForUi() {
    const out = [];
    for (const e of registry.values()) {
      out.push({
        id: 'ks_' + e.sessionId,
        command: 'Kimi Code — جلسة ' + e.sessionId.slice(0, 12) + ' (' + (e.model || 'k3') + ')',
        count: 1,
        startedAt: e.startedAt,
      });
    }
    return out;
  }

  function notify() { if (notifier) { try { notifier(snapshotForUi()); } catch { /* لا نكسر السجل */ } } }

  function procAlive(proc) {
    return !!proc && proc.exitCode == null && proc.signalCode == null && !proc.killed;
  }

  function touch(entry) { entry.lastActivityAt = now(); }

  function acquire(sessionId) {
    const entry = registry.get(sessionId);
    if (!entry) return null;
    if (!procAlive(entry.proc)) { registry.delete(sessionId); notify(); return null; }
    if (entry.shared && entry.shared.turn) return null; // دور نشط عليها — لا استئجار مزدوج
    touch(entry);
    return entry;
  }

  // تدمير قناة: إلغاء الدور النشط أولاً ثم session/cancel وإغلاق العملية وخادم MCP.
  async function destroy(entry, reason) {
    if (!entry) return;
    registry.delete(entry.sessionId);
    for (const timer of entry.lateTimers.values()) clearTimeout(timer);
    entry.lateTimers.clear();
    entry.lateBuffers.clear();
    const turn = entry.shared && entry.shared.turn;
    if (turn && typeof turn.abortTurn === 'function') {
      try { await turn.abortTurn(); } catch { /* أفضل جهد */ }
    }
    if (entry.shared) entry.shared.turn = null;
    try { entry.rpc.notify('session/cancel', { sessionId: entry.sessionId }); } catch { /* أُغلقت */ }
    try { entry.rpc.close(new Error('keepalive: ' + (reason || 'destroy'))); } catch { /* أُغلقت */ }
    try { entry.proc.stdin.end(); } catch { /* مغلق */ }
    setTimeout(() => { try { entry.proc.kill(); } catch { /* منتهٍ */ } }, 300);
    if (entry.mcpHost) { const host = entry.mcpHost; entry.mcpHost = null; await host.stop().catch(() => {}); }
    notify();
  }

  // تسجيل قناة جديدة مع فرض السقف: يُطرد الأقدم خمولاً بلا دور نشط. إن تعذّر الإخلاء
  // (كل القنوات عليها أدوار نشطة) يعيد false — السقوط الرشيق: عملية لكل دور كالمعتاد.
  async function register(entry) {
    if (!entry || !entry.sessionId || registry.has(entry.sessionId)) return false;
    entry.lateBuffers = new Map();
    entry.lateTimers = new Map();
    if (registry.size >= maxLive) {
      const idleCandidates = [...registry.values()]
        .filter((item) => !(item.shared && item.shared.turn))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      if (!idleCandidates.length) return false;
      await destroy(idleCandidates[0], 'evict');
    }
    registry.set(entry.sessionId, entry);
    ensurePruneTimer();
    notify();
    return true;
  }

  function remove(sessionId) {
    const entry = registry.get(sessionId);
    if (!entry) return false;
    for (const timer of entry.lateTimers.values()) clearTimeout(timer);
    registry.delete(sessionId);
    notify();
    return true;
  }

  async function kill(sessionId) {
    const entry = registry.get(sessionId);
    if (!entry) return { ok: false };
    await destroy(entry, 'kill');
    return { ok: true };
  }

  async function killAll() {
    const entries = [...registry.values()];
    for (const entry of entries) await destroy(entry, 'killAll');
  }

  // خمول 15 دقيقة: يقتل القنوات الخاملة التي لا دور نشط عليها.
  async function prune() {
    const cutoff = now() - idleMs;
    const stale = [...registry.values()]
      .filter((entry) => entry.lastActivityAt < cutoff && !(entry.shared && entry.shared.turn));
    for (const entry of stale) await destroy(entry, 'idle');
    return stale.length;
  }

  function ensurePruneTimer() {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => { prune().catch(() => {}); }, PRUNE_INTERVAL_MS);
    if (pruneTimer.unref) pruneTimer.unref();
  }

  function touchSession(sessionId) {
    const entry = registry.get(sessionId);
    if (entry) touch(entry);
  }

  function list() { return snapshotForUi(); }

  // ---------- الأحداث المتأخرة (بين الأدوار) ----------
  // تصل session/update على قناة حية بلا دور نشط. كل حدث يمر ببوابة الحجب/القص نفسها
  // (scrub + سقف نص) ثم يُبث كإشعار مؤقت — لا يُدرج في سجل المحادثة (قرار القائد 4).

  function emitLate(entry, kind, text, extra) {
    if (!lateEventSink) return;
    const clean = scrub(text, LATE_TEXT_MAX);
    if (!clean || !clean.trim()) return;
    touch(entry);
    try {
      lateEventSink({
        type: 'kimi_keepalive_event',
        sessionId: entry.sessionId,
        kind,
        text: clean,
        ...(extra || {}),
        at: now(),
      });
    } catch { /* بثّ الإشعار لا يكسر القناة */ }
  }

  // رسائل النص تصل مقطّعة؛ نجمّعها حسب messageId ونبثها دفعة واحدة بعد سكون قصير.
  function bufferLateText(entry, kind, messageId, text) {
    const key = kind + ':' + (messageId || '_');
    const previous = entry.lateBuffers.get(key) || '';
    entry.lateBuffers.set(key, scrub(previous + String(text || ''), LATE_TEXT_MAX));
    if (entry.lateTimers.has(key)) clearTimeout(entry.lateTimers.get(key));
    entry.lateTimers.set(key, setTimeout(() => {
      entry.lateTimers.delete(key);
      const joined = entry.lateBuffers.get(key) || '';
      entry.lateBuffers.delete(key);
      emitLate(entry, kind, joined);
    }, LATE_DEBOUNCE_MS));
    if (entry.lateTimers.get(key).unref) entry.lateTimers.get(key).unref();
  }

  // يُستدعى من جسر القناة في kimi.js عندما لا يوجد دور نشط. يعيد true إن عولج الحدث.
  function handleLateNotificationBySession(sessionId, method, params) {
    const entry = registry.get(sessionId);
    if (!entry) return false;
    return handleLateNotification(entry, method, params);
  }

  // يُستدعى من جسر القناة في kimi.js عندما لا يوجد دور نشط. يعيد true إن عولج الحدث.
  function handleLateNotification(entry, method, params) {
    if (!entry || method !== 'session/update') return false;
    touch(entry);
    const update = params && params.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
      bufferLateText(entry, 'message', update.messageId, update.content.text);
      return true;
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content && update.content.type === 'text') {
      bufferLateText(entry, 'thought', update.messageId, update.content.text);
      return true;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const status = typeof update.status === 'string' ? update.status : '';
      if (status && status !== 'completed' && status !== 'failed' && status !== 'cancelled') return true;
      const title = toolLabelFn(update.title || 'Kimi Tool').slice(0, 120);
      const output = toolTextFn(update.content, update.rawOutput);
      emitLate(entry, 'tool', output || title, { tool: title, status: status || 'completed' });
      return true;
    }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
      emitLate(entry, 'plan', 'حدّث Kimi الخطة (' + update.entries.length + ' بنداً)');
      return true;
    }
    return false;
  }

  return {
    acquire, register, remove, kill, killAll, prune, list, touch, touchSession, procAlive,
    setNotifier, setLateEventSink, handleLateNotification, handleLateNotificationBySession,
    _internals: { registry, snapshotForUi, destroy },
  };
}

module.exports = { create, MAX_LIVE_DEFAULT, IDLE_MS_DEFAULT, LATE_TEXT_MAX };
