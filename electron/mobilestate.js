/**
 * سطر — بناء لقطة حالة الجوال (§7.7.6).
 *
 * وحدة نقية: لا HTTP ولا تعمية ولا Electron. كل مستهلك يبني/يعيد التحقق من اللقطة
 * هنا كي تبقى قائمة الحقول والسقوف والتنقية تنفيذاً واحداً لا نسخاً تتباعد.
 */

'use strict';

const { scrubSecrets } = require('./secretscrub');

// الأسماء الأحد عشر المرقّمة حرفياً في §7.7.6/أ؛ لا يُخترع حقل خارج القائمة المغلقة.
const STATE_KEYS = Object.freeze([
  'boot', 'seq', 'ttl_ms', 'run', 'phase', 'project', 'task', 'tasks', 'edits', 'cost_usd', 'verify',
]);
const PHASES = Object.freeze(['idle', 'working', 'waiting_permission', 'done', 'error', 'stopped']);
const VERIFY_VALUES = new Set(['pass', 'fail', '']);
const PHASE_SET = new Set(PHASES);

const TTL_MS = 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;
const MAX_STATE_FRAME_BYTES = 2 * 1024;
const STATE_REQUEST_MIN_INTERVAL_MS = 2 * 1000;
const TEXT_LIMIT = 160;
const RUN_TOKEN_RE = /^[a-f0-9]{16}$/;
const BOOT_RE = /^[a-f0-9]{8}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function truncatePoints(value, limit) {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit - 1).join('') + '…';
}

/** نفس عقد cleanText في mobileenvelope: حجب، تحكم/Bidi، طيّ، ثم قص Unicode. */
function cleanText(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  try {
    const text = scrubSecrets(String(value))
      .replace(CONTROL_RE, ' ')
      .replace(BIDI_RE, '')
      .replace(/\s+/gu, ' ')
      .trim();
    return truncatePoints(text, limit);
  } catch { return ''; }
}

function dataValue(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined;
  } catch { return undefined; }
}

function contextValue(raw, ctx, key) {
  const fromContext = dataValue(ctx, key);
  return fromContext === undefined ? dataValue(raw, key) : fromContext;
}

function boundedInt(value, max) {
  if (!Number.isFinite(value)) return 0;
  const integer = Math.floor(value);
  if (integer <= 0) return 0;
  return Math.min(integer, max);
}

function safeCount(value) {
  return boundedInt(value, Number.MAX_SAFE_INTEGER);
}

function taskCounts(value) {
  return {
    total: boundedInt(dataValue(value, 'total'), 999),
    pending: boundedInt(dataValue(value, 'pending'), 999),
    in_progress: boundedInt(dataValue(value, 'in_progress'), 999),
    completed: boundedInt(dataValue(value, 'completed'), 999),
    blocked: boundedInt(dataValue(value, 'blocked'), 999),
  };
}

function editCounts(value) {
  return {
    files: safeCount(dataValue(value, 'files')),
    added: safeCount(dataValue(value, 'added')),
    removed: safeCount(dataValue(value, 'removed')),
  };
}

function cleanTask(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const source = String(value);
  try {
    // عنوان حُجب منه سر لا يُعرض ناقصاً؛ العدادات والحالة تبقيان صادقتين.
    if (scrubSecrets(source) !== source) return '';
  } catch { return ''; }
  return cleanText(source, TEXT_LIMIT);
}

function cleanCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value * 10000) / 10000;
  return Number.isFinite(rounded) ? rounded : value;
}

/** يبني نسخة جديدة كلياً بقائمة الحقول المغلقة والسقوف المجمّدة. */
function buildState(raw, ctx) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const context = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  const bootValue = String(contextValue(source, context, 'boot') || '').toLowerCase();
  const runValue = String(contextValue(source, context, 'run') || '').toLowerCase();
  const seqValue = contextValue(source, context, 'seq');
  const phaseValue = dataValue(source, 'phase');
  const verifyValue = dataValue(source, 'verify');

  return {
    boot: BOOT_RE.test(bootValue) ? bootValue : '00000000',
    seq: Number.isSafeInteger(seqValue) && seqValue >= 1 ? seqValue : 1,
    ttl_ms: TTL_MS,
    run: RUN_TOKEN_RE.test(runValue) ? runValue : '',
    phase: PHASE_SET.has(phaseValue) ? phaseValue : 'idle',
    project: cleanText(dataValue(source, 'project'), TEXT_LIMIT),
    task: cleanTask(dataValue(source, 'task')),
    tasks: taskCounts(dataValue(source, 'tasks')),
    edits: editCounts(dataValue(source, 'edits')),
    cost_usd: cleanCost(dataValue(source, 'cost_usd')),
    verify: VERIFY_VALUES.has(verifyValue) ? verifyValue : '',
  };
}

module.exports = {
  buildState,
  cleanText,
  STATE_KEYS,
  TTL_MS,
  HEARTBEAT_MS,
  MAX_STATE_FRAME_BYTES,
  PHASES,
  STATE_REQUEST_MIN_INTERVAL_MS,
};
