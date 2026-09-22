// عرض السجل عبر كتلة الرد الحية نفسها؛ لا تلخيص ولا تحويل السرد المرحلي إلى إجابات.
export function renderConversationHistory(chat, messages) {
  let block = null, key = '', status = '';
  const toolOwners = new Map();
  function finish() {
    if (!block) return;
    if (['stopped', 'interrupted', 'running'].includes(status)) block.stopped();
    else block.finish(status === 'failed' ? { is_error: true } : undefined);
    block.done = true;
    block = null;
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.text !== 'string') continue;
    if (message.role === 'user') {
      finish(); key = '';
      const images = (message.images || []).filter(image => typeof image.dataUrl === 'string').map(image => image.dataUrl);
      chat.addUserMsg(message.text, images, { steer: message.steer === true, messageId: message.messageId, sessionId: message.sessionId, cwd: message.cwd });
      if ((message.images || []).length > images.length) chat.addNotice('مرفق قديم غير متوفر في السجل المحفوظ.');
      continue;
    }
    if (!['assistant', 'tool_use', 'tool_result'].includes(message.role)) continue;
    if (message.role === 'tool_result') {
      toolOwners.get(message.toolId)?.toolDone(message.toolId, message.isError === true);
      continue;
    }
    const nextKey = message.runId || 'imported-' + message.engine;
    if (block && key !== nextKey) finish();
    if (!block) {
      key = nextKey; status = message.status || '';
      block = chat.newAssistantBlock(message.engine === 'codex' ? 'Codex' : 'Claude Code', { history: true });
    }
    if (message.role === 'tool_use') {
      block.addTool(message.toolId, message.name || 'أداة', {}, null, false);
      toolOwners.set(message.toolId, block);
    }
    else if (message.text) block.addText(message.text, null, message.phase);
  }
  finish();
}
