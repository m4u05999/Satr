/** قياس بطاقات الإذن في الذاكرة فقط؛ لا يقرر السماح ولا يحتفظ بمحتوى البطاقة. */
'use strict';

const { performance } = require('node:perf_hooks');
const MAX_PENDING = 256;
const MAX_COMPLETED = 512;
const ENGINES = new Set(['sdk', 'codex', 'kimi-code', 'other']);
const TOOLS = new Set([
  'open_preview', 'close_preview', 'read_page', 'read_article', 'browser_readability',
  'browser_snapshot', 'browser_click', 'browser_type', 'browser_select_option',
  'browser_press_key', 'browser_scroll', 'browser_hover', 'browser_navigate',
  'browser_wait_for', 'browser_evaluate', 'browser_set_viewport', 'browser_back',
  'browser_forward', 'browser_fill_form', 'browser_transfer_field', 'screenshot',
  'browser_request_secret', 'browser_screenshot_element', 'browser_console',
  'browser_network', 'browser_perf', 'browser_handoff', 'browser_handoff_step',
  'Bash', 'Read', 'Write', 'Edit', 'apply_patch', 'command', 'other',
]);
const REASONS = new Set([
  'sensitive_action', 'explicit_form_review', 'leak_risk', 'action_budget',
  'origin_trust', 'browser_control_off', 'tool_policy', 'other',
]);
const DECISIONS = new Set(['allow_once', 'allow_scope', 'deny', 'cancelled']);
const validKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160;

function cleanTool(value) {
  if (typeof value !== 'string' || value.length > 200) return 'other';
  const bare = value.replace(/^mcp__satr-terminal__/, '');
  return TOOLS.has(bare) ? bare : 'other';
}
function cleanReasons(values) {
  if (!Array.isArray(values) || !values.length) return ['tool_policy'];
  return [...new Set(values.slice(0, 8).map((value) => REASONS.has(value) ? value : 'other'))];
}

function create(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => performance.now();
  const pending = new Map();
  const completed = [];
  let lastNow = 0, totalStarted = 0, totalCompleted = 0;
  let interrupted = 0, evictedPending = 0, evictedCompleted = 0;
  function tick() {
    let value;
    try { value = now(); } catch { value = lastNow; }
    if (!Number.isFinite(value)) value = lastNow;
    lastNow = Math.max(0, lastNow, value);
    return lastNow;
  }
  function unlink(record) {
    record.finished = true;
    if (pending.get(record.id) === record) pending.delete(record.id);
  }
  function append(record, decision) {
    if (record.finished) return;
    unlink(record);
    completed.push({ engine: record.engine, tool: record.tool, reasons: record.reasons,
      decision, waitMs: Math.round(Math.max(0, tick() - record.startedAt)) });
    totalCompleted += 1;
    if (completed.length > MAX_COMPLETED) { completed.shift(); evictedCompleted += 1; }
  }
  function closeRecord(record) {
    if (!record || record.finished) return false;
    if (record.inFlight) record.deferredClose = true;
    else append(record, 'cancelled');
    return true;
  }
  function request(owner, id, engine, tool, reasons) {
    if (!validKey(owner) || !validKey(id)) return false;
    const existing = pending.get(id);
    if (existing && existing.owner === owner) return false;
    if (existing) { unlink(existing); interrupted += 1; }
    if (pending.size >= MAX_PENDING) {
      unlink(pending.values().next().value);
      evictedPending += 1;
    }
    pending.set(id, { owner, id, engine: ENGINES.has(engine) ? engine : 'other',
      tool: cleanTool(tool), reasons: cleanReasons(reasons), startedAt: tick(),
      inFlight: false, deferredClose: false, finished: false });
    totalStarted += 1;
    return true;
  }
  function close(id, owner) {
    const record = pending.get(id);
    if (!record || (owner !== undefined && record.owner !== owner)) return false;
    return closeRecord(record);
  }
  function closeOwner(owner) {
    for (const record of pending.values()) if (record.owner === owner) closeRecord(record);
  }
  function reply(id, decision, resolveCallback) {
    const record = pending.get(id);
    // القياس لا يحجب طلباً غائباً أو مطروداً بسبب السقف؛ البوابة الأصلية تُستدعى دائماً.
    if (!record || record.finished || record.inFlight) return resolveCallback();
    record.inFlight = true;
    try {
      const accepted = resolveCallback();
      if (accepted === true) append(record, DECISIONS.has(decision) ? decision : 'cancelled');
      else if (record.deferredClose) append(record, 'cancelled');
      return accepted;
    } catch (error) {
      if (record.deferredClose) append(record, 'cancelled');
      throw error;
    } finally { record.inFlight = false; }
  }
  function snapshot() {
    const at = tick();
    const counts = Object.fromEntries([...DECISIONS].map((key) => [key, 0]));
    const reasonCounts = Object.fromEntries([...REASONS].map((key) => [key, 0]));
    for (const record of completed) {
      counts[record.decision] += 1;
      for (const reason of record.reasons) reasonCounts[reason] += 1;
    }
    return {
      schema_version: 1, scope: 'main_chat_issued_requests', window: 'last_completed',
      maxPending: MAX_PENDING, maxCompleted: MAX_COMPLETED,
      counts, reasonCounts,
      pending: [...pending.values()].map((record) => ({ engine: record.engine,
        tool: record.tool, reasons: record.reasons.slice(), ageMs: Math.round(Math.max(0, at - record.startedAt)) })),
      completed: completed.map((record) => ({ ...record, reasons: record.reasons.slice() })),
      totalStarted, totalCompleted, interrupted, evictedPending, evictedCompleted,
    };
  }
  return { request, close, closeOwner, reply, snapshot };
}
module.exports = { create };
