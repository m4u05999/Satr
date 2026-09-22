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
    session_lost: 'تعذّر استئناف جلسة المحرك لهذه المحادثة، وتاريخها أطول من أن يُنقل كاملاً. افتح «جلسة جديدة» للمتابعة؛ لم تُرسل الرسالة.',
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
    messages: [
      ...data.messages.filter((message) => message.runId !== excludeRunId && !(message.role === 'user' && message.displayText === '' && !message.images?.length))
        .map(({ role, text, displayText, engine: sourceEngine, images, seq, runId, phase, toolId, isError, steer, messageId, sourceSessionId }) => ({
          role, text: displayText ?? text, engine: sourceEngine, seq, runId, phase, toolId, isError, steer,
          status: data.runs.find(run => run.id === runId)?.status || 'imported',
          ...(selected === 'sdk' && sourceEngine === 'sdk' && messageId ? { messageId, sessionId: sourceSessionId || data.bindings.sdk?.sessionId, cwd: data.cwd } : {}),
          ...(images ? { images } : {}),
        })),
      ...data.runs.filter(run => run.id !== excludeRunId).flatMap(run => (run.displayTools || []).map(tool => ({
        role: 'tool_use', text: '', engine: run.engine, runId: run.id, status: run.status, ...tool,
      }))),
      ...data.runs.filter(run => run.id !== excludeRunId && run.status === 'running').flatMap(run =>
        Object.entries(run.draft || {}).map(([phase, text], index) => ({
          role: 'assistant', text, phase, engine: run.engine, runId: run.id,
          status: 'interrupted', seq: data.revision + 1 + index,
        }))),
    ].sort((a, b) => a.seq - b.seq),
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
      const restored = store.load(prepared.id, input.cwd);
      prepared.snapshot = snapshot(restored.ok && restored.conversation ? restored.conversation : prepared.conversation, input.engine, prepared.runId);
    }
    return prepared;
  }
  function current(cwd) {
    const found = store.latest(cwd);
    return found.ok ? { ok: true, conversation: found.conversation ? snapshot(found.conversation, found.engine) : null } : found;
  }
  function forSession(cwd, engine, sessionId) {
    const found = store.findBySession(cwd, engine, sessionId);
    return found.ok && found.conversation ? snapshot(found.conversation, engine) : null;
  }
  async function openSession(cwd, engine, sessionId) {
    const found = store.findBySession(cwd, engine, sessionId);
    if (!found.ok) return found;
    if (found.conversation) return { ok: true, conversation: snapshot(found.conversation, engine) };
    const original = await readers[engine](sessionId);
    if (!original || original.error || !Array.isArray(original.messages)) return { ok: false, error: 'source_unavailable' };
    try {
      if (conversations.normalizeCwd(original.cwd) !== conversations.normalizeCwd(cwd)) return { ok: false, error: 'project_mismatch' };
    } catch (_) { return { ok: false, error: 'bad_cwd' }; }
    const imported = store.create({ cwd, engine, sessionId, messages: original.messages, coverage: original.coverage });
    return imported.ok ? read(imported.id, cwd, engine) : imported;
  }
  function read(id, cwd, engine) {
    const found = store.load(id, cwd);
    return found.ok ? { ok: true, conversation: found.conversation ? snapshot(found.conversation, engine) : null } : found;
  }
  function restart(runId) {
    const result = store.contextForRestart(runId);
    if (!result.ok) throw new Error(messageFor(result.error));
    return result.context;
  }
  return { prepare, current, forSession, read, openSession, restart };
}

module.exports = { messageFor, snapshot, createBridge, ...createBridge() };
