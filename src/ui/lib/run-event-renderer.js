// مصيّر أحداث محرك مستقل عن حالة المحادثة العامة.
// يستقبل كتلة بعقد <satr-chat> ويعيد استعمال العرض دون لمس currentBlock.
export function renderRunEvent(block, event) {
  if (!block || !event || typeof event !== 'object') return false;
  if (event.type === 'sdk_agent_progress' && block.updateAgentProgress) {
    block.updateAgentProgress(event); return true;
  }
  if (event.type === 'api_retry' && block.apiRetry) {
    block.apiRetry(event); return true;
  }
  if (event.type === 'stream_text' && typeof event.text === 'string') {
    block.addDelta(event.text, event.phase); return true;
  }
  if (event.type === 'system' && event.subtype === 'compact_boundary' && block.compacted) {
    block.compacted(event.compact_metadata); return true;
  }
  if (event.type === 'system' && event.subtype === 'compact_summary' && block.compacted) {
    block.compacted({ compact_summary:event.compact_summary }); return true;
  }
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    for (const item of event.message.content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') block.addText(item.text, item.parent_tool_use_id || event.parent_tool_use_id, item.phase || event.phase);
      else if (item.type === 'tool_use') block.addTool(item.id, item.name, item.input, item.parent_tool_use_id || event.parent_tool_use_id, item.is_sdk);
    }
    return true;
  }
  if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
    for (const item of event.message.content) {
      if (item && item.type === 'tool_result') block.toolDone(item.tool_use_id, item.is_error === true);
    }
    return true;
  }
  if (event.type === 'file_edit' && block.addDiff) {
    block.addDiff({ ...event, noUndo:true }); return true;
  }
  if ((event.type === 'screenshot' || event.type === 'agent_screenshot') && block.addScreenshot) {
    block.addScreenshot(event.dataUrl || event.data_url, event.kind); return true;
  }
  if (event.type === 'desktop_activity' && block.addDesktopActivity) {
    block.addDesktopActivity(event.text, event.stamp || event.time); return true;
  }
  if (event.type === 'stderr' && typeof event.text === 'string') {
    block.addText('ملاحظة من المحرك:\n' + event.text, null, 'commentary'); return true;
  }
  if (event.type === 'spawn_error') {
    block.addText('تعذّر بدء المحرك لهذه المحاولة.', null, 'commentary'); return true;
  }
  return false;
}