/**
 * سجلّ مهام «سطر» الموحّد والدائم (Task Ledger).
 *
 * الشكل على القرص: ~/.satr/tasks/<engine>/<session_id>.json. كل ملف يحمل snapshot
 * منقّطة لا transcript ولا prompt: مهام وحالات واعتماديات ومالك ودليل تحقق فقط.
 * كل مدخل يُنقّى هنا، والكتابة ذرية وأفضل جهد كي لا يكسر فشل القرص دور الوكيل.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const ROOT = path.join(os.homedir(), '.satr', 'tasks');
const SAFE_ENGINE = /^[a-z0-9_-]{1,32}$/;
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked']);
const LEDGER_STATES = new Set(['active', 'paused', 'completed']);
const MODES = new Set(['replace', 'merge']);
const MAX_TASKS = 50;
const MAX_DEPENDENCIES = 12;
const MAX_EVIDENCE = 6;
const MAX_TITLE = 300;
const MAX_OWNER = 80;
const MAX_EVIDENCE_TEXT = 300;
const MAX_FILE = 512 * 1024;

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function fileFor(engine, sessionId, options) {
  if (!SAFE_ENGINE.test(engine || '') || !SAFE_SESSION.test(sessionId || '')) return null;
  const root = options && options.root ? path.resolve(options.root) : ROOT;
  return path.join(root, engine, sessionId + '.json');
}

function sanitizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const item of value.slice(0, MAX_EVIDENCE)) {
    const text = cleanText(typeof item === 'string' ? item : item && item.text, MAX_EVIDENCE_TEXT);
    if (!text) continue;
    const kind = cleanText(item && typeof item === 'object' ? item.kind : '', 32);
    output.push(kind ? { text, kind } : { text });
  }
  return output;
}

function sanitizeTask(value, fallbackId) {
  if (!value || typeof value !== 'object') return null;
  const rawId = cleanText(value.id, 128);
  const id = SAFE_TASK_ID.test(rawId) ? rawId : fallbackId;
  if (!SAFE_TASK_ID.test(id || '')) return null;
  const title = cleanText(value.title || value.step || value.subject || value.description, MAX_TITLE);
  if (!title) return null;
  const status = STATUSES.has(value.status) ? value.status : 'pending';
  const dependencies = [];
  const rawDependencies = Array.isArray(value.dependencies)
    ? value.dependencies : Array.isArray(value.blockedBy) ? value.blockedBy : [];
  for (const dependency of rawDependencies.slice(0, MAX_DEPENDENCIES)) {
    if (typeof dependency === 'string' && SAFE_TASK_ID.test(dependency) && dependency !== id && !dependencies.includes(dependency)) {
      dependencies.push(dependency);
    }
  }
  return {
    id,
    title,
    status,
    dependencies,
    owner: cleanText(value.owner, MAX_OWNER),
    evidence: sanitizeEvidence(value.evidence),
  };
}

function sanitizeTasks(values) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  for (let index = 0; index < values.length && output.length < MAX_TASKS; index++) {
    const task = sanitizeTask(values[index], 'task-' + (index + 1));
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    output.push(task);
  }
  return output;
}

function publicLedger(value) {
  if (!value) return null;
  return {
    type: 'task_update',
    schema_version: SCHEMA_VERSION,
    engine: value.engine,
    session_id: value.session_id,
    revision: value.revision,
    state: value.state,
    source: value.source,
    updated_at: value.updated_at,
    tasks: value.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dependencies: task.dependencies.slice(),
      owner: task.owner,
      evidence: task.evidence.map((item) => ({ ...item })),
    })),
  };
}

function readFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION) return null;
    const tasks = sanitizeTasks(parsed.tasks);
    return {
      schema_version: SCHEMA_VERSION,
      engine: parsed.engine,
      session_id: parsed.session_id,
      revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
      state: LEDGER_STATES.has(parsed.state) ? parsed.state : 'active',
      source: cleanText(parsed.source, 64) || 'stored',
      updated_at: Number.isFinite(parsed.updated_at) ? parsed.updated_at : 0,
      tasks,
    };
  } catch {
    return null;
  }
}

function load(engine, sessionId, options) {
  const file = fileFor(engine, sessionId, options);
  if (!file) return null;
  const ledger = readFile(file);
  if (!ledger || ledger.engine !== engine || ledger.session_id !== sessionId) return null;
  return publicLedger(ledger);
}

function writeBestEffort(ledger, options) {
  const file = fileFor(ledger.engine, ledger.session_id, options);
  if (!file) return false;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    const serialized = JSON.stringify(ledger);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE) return false;
    fs.writeFileSync(temp, serialized, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

function mergeTasks(previous, incoming) {
  const map = new Map(previous.map((task) => [task.id, task]));
  for (const task of incoming) {
    const old = map.get(task.id);
    const dependencies = old
      ? [...new Set(old.dependencies.concat(task.dependencies))].slice(0, MAX_DEPENDENCIES)
      : task.dependencies;
    const evidence = old
      ? old.evidence.concat(task.evidence).filter((item, index, values) =>
        values.findIndex((other) => other.text === item.text && other.kind === item.kind) === index).slice(-MAX_EVIDENCE)
      : task.evidence;
    map.set(task.id, old ? {
      ...old,
      ...task,
      dependencies,
      owner: task.owner || old.owner,
      evidence,
    } : task);
  }
  return [...map.values()].slice(0, MAX_TASKS);
}

function deriveState(tasks, previousState) {
  if (previousState === 'paused') return 'paused';
  return tasks.length && tasks.every((task) => task.status === 'completed') ? 'completed' : 'active';
}

function apply(update, options) {
  if (!update || update.schema_version !== SCHEMA_VERSION) return null;
  const engine = cleanText(update.engine, 32);
  const sessionId = cleanText(update.session_id, 128);
  const file = fileFor(engine, sessionId, options);
  if (!file) return null;
  const incoming = sanitizeTasks(update.tasks);
  if (!incoming.length && update.mode !== 'replace') return null;
  const previous = readFile(file);
  const mode = MODES.has(update.mode) ? update.mode : 'merge';
  const source = cleanText(update.source, 64) || 'engine';

  // خطة Kimi التلقائية (source: kimi_plan) لا تستبدل سجلاً صريحاً أنشأه
  // المستخدم أو أداة update_task_ledger (أي مصدر غير kimi_plan).
  if (mode === 'replace' && source === 'kimi_plan' && previous && previous.source !== 'kimi_plan') {
    return publicLedger(previous);
  }

  const nextTasks = mode === 'replace' ? incoming : mergeTasks(previous ? previous.tasks : [], incoming);
  const ledger = {
    schema_version: SCHEMA_VERSION,
    engine,
    session_id: sessionId,
    revision: (previous ? previous.revision : 0) + 1,
    state: deriveState(nextTasks, previous && previous.state),
    source,
    updated_at: Date.now(),
    tasks: nextTasks,
  };
  writeBestEffort(ledger, options);
  return publicLedger(ledger);
}

function action(engine, sessionId, actionName, options) {
  if (actionName !== 'pause' && actionName !== 'resume') return null;
  const file = fileFor(engine, sessionId, options);
  if (!file) return null;
  const previous = readFile(file);
  if (!previous) return null;
  const state = actionName === 'pause'
    ? 'paused'
    : (previous.tasks.length && previous.tasks.every((task) => task.status === 'completed') ? 'completed' : 'active');
  const ledger = {
    ...previous,
    revision: previous.revision + 1,
    state,
    source: 'user_' + actionName,
    updated_at: Date.now(),
  };
  writeBestEffort(ledger, options);
  return publicLedger(ledger);
}

function addEvidence(engine, sessionId, selector, evidence, options) {
  const file = fileFor(engine, sessionId, options);
  if (!file) return null;
  const previous = readFile(file);
  if (!previous || !selector || !Array.isArray(evidence) || !evidence.length) return null;
  const taskId = cleanText(selector.task_id, 128);
  const taskTitle = cleanText(selector.task_title, MAX_TITLE);
  const task = previous.tasks.find((item) => taskId && item.id === taskId)
    || previous.tasks.find((item) => taskTitle && item.title === taskTitle);
  if (!task) return null;
  return apply({
    schema_version: SCHEMA_VERSION,
    engine,
    session_id: sessionId,
    mode: 'merge',
    source: 'verification',
    tasks: [{ ...task, evidence }],
  }, options);
}

module.exports = {
  SCHEMA_VERSION,
  apply,
  load,
  action,
  addEvidence,
  sanitizeTasks,
  SAFE_ENGINE,
  SAFE_SESSION,
  SAFE_TASK_ID,
};
