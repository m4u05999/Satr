/**
 * Checkpoints أدوار «سطر»: تجميع معرّفات file_edit وmetadata فقط، بلا Git history.
 *
 * الاستعادة متاحة لآخر checkpoint حيّ فقط، وتعكس edit IDs بالترتيب عبر undo القائمة.
 * بعد إعادة التشغيل يبقى checkpoint قابلاً للعرض والمقارنة، لكن snapshots الذاكرية
 * تكون منتهية فيظهر restorable=false بدلاً من ادعاء استعادة غير ممكنة.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const ROOT = path.join(os.homedir(), '.satr', 'checkpoints');
const SAFE_ENGINE = /^[a-z0-9_-]{1,32}$/;
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_CHECKPOINTS = 20;
const MAX_EDITS = 50;
const MAX_FILES = 50;
const MAX_FILE = 512 * 1024;

const activeRuns = new Map();
const liveCheckpoints = new Map();
let sequence = 0;

function rootFor(options) {
  return options && options.root ? path.resolve(options.root) : ROOT;
}

function hashCwd(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex');
}

function fileFor(engine, sessionId, options) {
  if (!SAFE_ENGINE.test(engine || '') || !SAFE_SESSION.test(sessionId || '')) return null;
  return path.join(rootFor(options), engine, sessionId + '.json');
}

function readCollection(engine, sessionId, options) {
  const file = fileFor(engine, sessionId, options);
  if (!file) return [];
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.schema_version === SCHEMA_VERSION && Array.isArray(parsed.checkpoints)
      ? parsed.checkpoints.slice(-MAX_CHECKPOINTS) : [];
  } catch {
    return [];
  }
}

function writeCollection(engine, sessionId, checkpoints, options) {
  const file = fileFor(engine, sessionId, options);
  if (!file) return false;
  try {
    const data = JSON.stringify({ schema_version: SCHEMA_VERSION, checkpoints: checkpoints.slice(-MAX_CHECKPOINTS) });
    if (Buffer.byteLength(data, 'utf8') > MAX_FILE) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, data, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

function storedShape(checkpoint) {
  const verification = checkpoint.verification ? {
    passed: !!checkpoint.verification.passed,
    summary: String(checkpoint.verification.summary || '').slice(0, 300),
    checks: Array.isArray(checkpoint.verification.checks) ? checkpoint.verification.checks.slice(0, 6).map((check) => {
      const output = String(check.output || '');
      return {
        id: String(check.id || '').slice(0, 64),
        label: String(check.label || '').slice(0, 120),
        passed: !!check.passed,
        exit_code: Number.isInteger(check.exit_code) ? check.exit_code : null,
        duration_ms: Number.isFinite(check.duration_ms) ? Math.max(0, Math.floor(check.duration_ms)) : 0,
        output_sha256: crypto.createHash('sha256').update(output).digest('hex'),
        output_bytes: Buffer.byteLength(output, 'utf8'),
      };
    }) : [],
  } : null;
  return {
    id: checkpoint.id,
    engine: checkpoint.engine,
    session_id: checkpoint.session_id,
    run_id: checkpoint.run_id,
    previous_id: checkpoint.previous_id,
    state: checkpoint.state,
    created_at: checkpoint.created_at,
    updated_at: checkpoint.updated_at,
    edit_ids: checkpoint.edit_ids.slice(0, MAX_EDITS),
    files: checkpoint.files.slice(0, MAX_FILES).map((file) => ({ ...file })),
    verification,
    resume_pending: !!checkpoint.resume_pending,
    task_id: checkpoint.task_id || '',
    task_title: checkpoint.task_title || '',
    cwd_hash: checkpoint.cwd_hash,
  };
}

function publicShape(checkpoint) {
  if (!checkpoint) return null;
  const live = liveCheckpoints.get(checkpoint.id);
  return {
    type: 'checkpoint_update',
    schema_version: SCHEMA_VERSION,
    id: checkpoint.id,
    engine: checkpoint.engine,
    session_id: checkpoint.session_id,
    previous_id: checkpoint.previous_id || null,
    state: checkpoint.state,
    created_at: checkpoint.created_at,
    updated_at: checkpoint.updated_at,
    edit_count: checkpoint.edit_ids.length,
    files: checkpoint.files.map((file) => ({ ...file })),
    verification: checkpoint.verification ? JSON.parse(JSON.stringify(checkpoint.verification)) : null,
    task_id: checkpoint.task_id || '',
    task_title: checkpoint.task_title || '',
    restorable: !!live && checkpoint.state !== 'open' && checkpoint.state !== 'restored' && checkpoint.state !== 'partial',
  };
}

function persist(checkpoint, options) {
  if (!checkpoint.session_id) return;
  const collection = readCollection(checkpoint.engine, checkpoint.session_id, options);
  const index = collection.findIndex((item) => item.id === checkpoint.id);
  const stored = storedShape(checkpoint);
  if (index >= 0) collection[index] = stored;
  else collection.push(stored);
  writeCollection(checkpoint.engine, checkpoint.session_id, collection, options);
}

function begin(info, options) {
  if (!info || !SAFE_ENGINE.test(info.engine || '') || !SAFE_ID.test(info.runId || '') || typeof info.cwd !== 'string') return null;
  const sessionId = SAFE_SESSION.test(info.sessionId || '') ? info.sessionId : null;
  const previous = sessionId ? readCollection(info.engine, sessionId, options).slice(-1)[0] : null;
  const checkpoint = {
    id: 'cp-' + Date.now().toString(36) + '-' + (++sequence).toString(36),
    engine: info.engine,
    session_id: sessionId,
    run_id: info.runId,
    previous_id: previous ? previous.id : null,
    state: 'open',
    created_at: Date.now(),
    updated_at: Date.now(),
    edit_ids: [],
    files: [],
    verification: null,
    resume_pending: false,
    task_id: '',
    task_title: '',
    cwd_hash: hashCwd(info.cwd),
    _cwd: path.resolve(info.cwd),
    _options: options,
  };
  activeRuns.set(info.runId, checkpoint);
  liveCheckpoints.set(checkpoint.id, checkpoint);
  return publicShape(checkpoint);
}

function bindSession(runId, sessionId) {
  const checkpoint = activeRuns.get(runId);
  if (!checkpoint || !SAFE_SESSION.test(sessionId || '')) return null;
  checkpoint.session_id = sessionId;
  if (!checkpoint.previous_id) {
    const previous = readCollection(checkpoint.engine, sessionId, checkpoint._options).slice(-1)[0];
    checkpoint.previous_id = previous ? previous.id : null;
  }
  checkpoint.updated_at = Date.now();
  return publicShape(checkpoint);
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return '';
  const parts = value.replace(/\\/g, '/').split('/');
  return parts.includes('..') || parts.includes('') ? '' : parts.join('/').slice(0, 512);
}

function addEdit(runId, event, taskRef) {
  const checkpoint = activeRuns.get(runId);
  if (!checkpoint || !event || !SAFE_ID.test(event.id || '') || checkpoint.edit_ids.length >= MAX_EDITS) return null;
  if (!checkpoint.edit_ids.includes(event.id)) checkpoint.edit_ids.push(event.id);
  const rel = safeRelative(event.rel);
  if (rel) {
    const existing = checkpoint.files.find((file) => file.rel === rel);
    const data = {
      rel,
      added: Math.max(0, Number.isInteger(event.added) ? event.added : 0),
      removed: Math.max(0, Number.isInteger(event.removed) ? event.removed : 0),
    };
    if (existing) Object.assign(existing, data);
    else if (checkpoint.files.length < MAX_FILES) checkpoint.files.push(data);
  }
  if (taskRef && typeof taskRef === 'object') {
    if (SAFE_ID.test(taskRef.id || '')) checkpoint.task_id = taskRef.id;
    if (typeof taskRef.title === 'string' && taskRef.title.trim()) checkpoint.task_title = taskRef.title.trim().slice(0, 300);
  }
  if (checkpoint.verification) checkpoint.verification = null;
  checkpoint.state = 'open';
  checkpoint.updated_at = Date.now();
  persist(checkpoint, checkpoint._options);
  return publicShape(checkpoint);
}

function recordVerification(runId, verification) {
  const checkpoint = activeRuns.get(runId);
  if (!checkpoint || !checkpoint.edit_ids.length || !verification) return null;
  checkpoint.verification = JSON.parse(JSON.stringify(verification));
  checkpoint.resume_pending = false; // أداة المحرك أعادت النتيجة في tool_result فوراً
  checkpoint.state = verification.passed ? 'passed' : 'failed';
  checkpoint.updated_at = Date.now();
  persist(checkpoint, checkpoint._options);
  return publicShape(checkpoint);
}

function recordVerificationForCheckpoint(checkpointId, verification) {
  const checkpoint = liveCheckpoints.get(checkpointId);
  if (!checkpoint || !checkpoint.edit_ids.length || !verification) return null;
  checkpoint.verification = JSON.parse(JSON.stringify(verification));
  checkpoint.resume_pending = true; // تحقق يدوي بعد الدور: يُعاد للمحرك مرة في الدور التالي
  checkpoint.state = verification.passed ? 'passed' : 'failed';
  checkpoint.updated_at = Date.now();
  persist(checkpoint, checkpoint._options);
  return publicShape(checkpoint);
}

function consumeVerification(engine, sessionId, options) {
  const collection = readCollection(engine, sessionId, options);
  const stored = collection.slice(-1)[0];
  if (!stored || !stored.resume_pending || !stored.verification) return '';
  stored.resume_pending = false;
  writeCollection(engine, sessionId, collection, options);
  const live = liveCheckpoints.get(stored.id);
  if (live) live.resume_pending = false;
  const lines = [stored.verification.passed ? 'نجح التحقق اليدوي السابق.' : 'فشل التحقق اليدوي السابق.'];
  for (const check of stored.verification.checks || []) {
    lines.push((check.passed ? 'PASS ' : 'FAIL ') + (check.label || check.id)
      + ' (exit ' + (check.exit_code == null ? 'unknown' : check.exit_code) + ')');
  }
  return lines.join('\n').slice(0, 4000);
}

function finish(runId) {
  const checkpoint = activeRuns.get(runId);
  if (!checkpoint) return null;
  if (!checkpoint.edit_ids.length) {
    activeRuns.delete(runId);
    liveCheckpoints.delete(checkpoint.id);
    return null;
  }
  if (checkpoint.state === 'open') checkpoint.state = 'ready';
  checkpoint.updated_at = Date.now();
  persist(checkpoint, checkpoint._options);
  activeRuns.delete(runId);
  return publicShape(checkpoint);
}

function latest(engine, sessionId, options) {
  const collection = readCollection(engine, sessionId, options);
  const checkpoint = collection.slice(-1)[0];
  if (!checkpoint) return null;
  const live = liveCheckpoints.get(checkpoint.id);
  return publicShape(live || checkpoint);
}

async function restore(info, undo) {
  if (!info || typeof undo !== 'function') return { ok: false, error: 'bad_input' };
  const latestCheckpoint = latest(info.engine, info.sessionId, info.options);
  if (!latestCheckpoint || latestCheckpoint.id !== info.checkpointId) return { ok: false, error: 'not_latest' };
  const checkpoint = liveCheckpoints.get(info.checkpointId);
  if (!checkpoint || checkpoint.state === 'open') return { ok: false, error: 'expired' };
  if (hashCwd(info.cwd) !== checkpoint.cwd_hash) return { ok: false, error: 'wrong_cwd' };
  const restored = [];
  let failure = null;
  for (const editId of checkpoint.edit_ids.slice().reverse()) {
    const result = await undo(editId);
    if (!result || !result.ok) { failure = { id: editId, error: result && result.error || 'failed' }; break; }
    restored.push(editId);
  }
  checkpoint.state = failure ? 'partial' : 'restored';
  checkpoint.updated_at = Date.now();
  persist(checkpoint, checkpoint._options);
  liveCheckpoints.delete(checkpoint.id);
  return { ok: !failure, error: failure && failure.error, restored, checkpoint: publicShape(checkpoint) };
}

module.exports = {
  SCHEMA_VERSION,
  begin,
  bindSession,
  addEdit,
  recordVerification,
  recordVerificationForCheckpoint,
  finish,
  latest,
  restore,
  consumeVerification,
};
