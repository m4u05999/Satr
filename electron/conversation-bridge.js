/**
 * وصل سجل المحادثة بالجلسات الأصلية. القرّاء موثوقون وتُراجع هوية المشروع قبل الاستيراد.
 * لا يقرأ تاريخ العرض من renderer، ولا يختار آخر محادثة نيابة عن طلب إرسال جديد.
 */
'use strict';

const conversations = require('./conversations');
const sessions = require('./sessions');
const codexSessions = require('./codexsessions');
const ENGINES = new Set(['sdk', 'codex']);

function messageFor(error) {
  const messages = {
    transfer_limit: 'تجاوز سياق المحادثة سعة النقل. عُد إلى المحرك السابق أو افتح محادثة جديدة؛ لم تُرسل الرسالة إلى المحرك المختار.',
    transfer_incomplete: 'لا يتوفر سياق كامل يمكن نقله بأمان لهذه المحادثة. عُد إلى محركها السابق؛ لم تُرسل الرسالة إلى المحرك المختار.',
    source_unavailable: 'تعذرت قراءة تاريخ الجلسة الأصلية. لم تبدأ محادثة فارغة؛ أعد فتح الجلسة وحاول مجدداً.',
    project_mismatch: 'الجلسة الأصلية تخص مشروعاً آخر؛ تعذر ربطها بهذه المحادثة.',
    session_mismatch: 'لم تتطابق جلسة المحرك مع هذه المحادثة؛ أُوقف الربط لحماية السجل.',
    conversation_busy: 'هذه المحادثة قيد التشغيل في نافذة أخرى. انتظر انتهاء دورها.',
    restart_after_progress: 'تعذر استئناف الجلسة بعد بدء تنفيذها؛ لم يُكرر الطلب.',
  };
  return messages[error] || 'تعذر حفظ سياق المحادثة (' + error + '). لم يبدأ طلب جديد بلا سجل.';
}

function snapshot(data, engine, excludeRunId) {
  const selected = ENGINES.has(engine) ? engine
    : data.runs.at(-1)?.engine || data.messages.at(-1)?.engine || Object.keys(data.bindings)[0] || 'sdk';
  return {
    id: data.id, cwd: data.cwd, engine: selected, sessionId: data.bindings[selected]?.valid ? data.bindings[selected].sessionId : null,
    messages: data.messages.filter((message) => message.runId !== excludeRunId && ['user', 'assistant'].includes(message.role))
      .map(({ role, text, engine: sourceEngine, images }) => ({ role, text, engine: sourceEngine, ...(images ? { images } : {}) })),
    coverage: data.coverage,
  };
}

function createBridge({ store = conversations, readers = {
  sdk: (id) => sessions.readContinuitySession(id),
  codex: (id) => codexSessions.readCodexSession(id, { full: true }),
} } = {}) {
  async function prepare(input) {
    let conversationId = input.conversationId || null;
    let source = input.continuitySource;
    if (!conversationId && !source && input.sessionId) source = { engine: input.engine, sessionId: input.sessionId, cwd: input.cwd };
    if (!conversationId && source) {
      if (!ENGINES.has(source.engine) || !conversations.SAFE_SESSION.test(String(source.sessionId || ''))) return { ok: false, error: 'bad_source' };
      try {
        if (conversations.normalizeCwd(source.cwd) !== conversations.normalizeCwd(input.cwd)) return { ok: false, error: 'project_mismatch' };
      } catch (_) { return { ok: false, error: 'bad_cwd' }; }
      const found = store.findBySession(input.cwd, source.engine, source.sessionId);
      if (!found.ok) return found;
      if (found.conversation) conversationId = found.conversation.id;
      else {
        const original = await readers[source.engine](source.sessionId);
        if (!original || original.error || !Array.isArray(original.messages)) return { ok: false, error: 'source_unavailable' };
        try {
          if (conversations.normalizeCwd(original.cwd) !== conversations.normalizeCwd(input.cwd)) return { ok: false, error: 'project_mismatch' };
        } catch (_) { return { ok: false, error: 'project_mismatch' }; }
        const imported = store.create({ cwd: input.cwd, engine: source.engine, sessionId: source.sessionId,
          messages: original.messages, coverage: original.coverage });
        if (!imported.ok) return imported;
        conversationId = imported.id;
      }
    }
    const prepared = store.prepare({ ...input, conversationId });
    if (prepared.ok) {
      prepared.restored = !input.conversationId && !!source;
      prepared.snapshot = snapshot(prepared.conversation, input.engine, prepared.runId);
    }
    return prepared;
  }
  function current(cwd) {
    const found = store.latest(cwd);
    return found.ok ? { ok: true, conversation: found.conversation ? snapshot(found.conversation) : null } : found;
  }
  function forSession(cwd, engine, sessionId) {
    const found = store.findBySession(cwd, engine, sessionId);
    return found.ok && found.conversation ? snapshot(found.conversation, engine) : null;
  }
  function restart(runId) {
    const result = store.contextForRestart(runId);
    if (!result.ok) throw new Error(messageFor(result.error));
    return result.context;
  }
  return { prepare, current, forSession, restart };
}

module.exports = { messageFor, snapshot, createBridge, ...createBridge() };
