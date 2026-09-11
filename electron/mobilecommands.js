/**
 * سطر — عقد أوامر الجوال ونتيجتها المشتركة بين النقلين (OBS-147).
 * قبول الطلب ليس اكتماله؛ لا نتيجة نجاح إلا من تقرير المنفّذ نفسه.
 */
'use strict';

const RUN_TOKEN_RE = /^[a-f0-9]{16}$/;
const RESULT_STATUSES = new Set(['stopped', 'stale_run', 'unknown']);
const RESULT_TTL_MS = 60000;
const MAX_RESULTS_PER_DEVICE = 4;

function parseStopRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.type !== 'stop' || typeof payload.run !== 'string'
      || !RUN_TOKEN_RE.test(payload.run)) return null;
  const hasId = Object.prototype.hasOwnProperty.call(payload, 'command_id');
  const keys = Object.keys(payload);
  if (keys.length !== (hasId ? 3 : 2)
      || !keys.every((key) => ['type', 'run', 'command_id'].includes(key))) return null;
  if (hasId && (typeof payload.command_id !== 'string' || !RUN_TOKEN_RE.test(payload.command_id))) return null;
  return hasId ? { type: 'stop', run: payload.run, command_id: payload.command_id }
    : { type: 'stop', run: payload.run };
}

function dispatchStop(payload, onStop, onResult) {
  const command = parseStopRequest(payload);
  if (!command) return false;
  let finished = false;
  let invoking = true;
  let queuedStatus = null;
  function finish(status) {
    if (finished) return false;
    finished = true;
    if (command.command_id && typeof onResult === 'function') {
      const result = { v: 1, type: 'command_result', command_id: command.command_id,
        run: command.run, status };
      try { onResult(result); } catch { /* ضياع الرد لا يحوّل نتيجة التنفيذ */ }
    }
    return true;
  }
  function report(status) {
    if (finished) return false;
    const safeStatus = RESULT_STATUSES.has(status) ? status : 'unknown';
    // تقرير متزامن لا يسبق معرفة قبول الأمر؛ الرفض يغلب أي تقرير مبكر.
    if (invoking) {
      if (queuedStatus !== null) return false;
      queuedStatus = safeStatus;
      return true;
    }
    return finish(safeStatus);
  }
  let accepted = false;
  let threw = false;
  try { accepted = typeof onStop === 'function' && onStop(command.run, report) === true; }
  catch { threw = true; }
  invoking = false;
  if (threw) finish('unknown');
  else if (!accepted) finish('stale_run');
  else if (queuedStatus !== null) finish(queuedStatus);
  return accepted;
}

module.exports = { parseStopRequest, dispatchStop, RUN_TOKEN_RE, RESULT_TTL_MS, MAX_RESULTS_PER_DEVICE };
