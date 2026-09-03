/**
 * مخطط مهام غرفة العمليات: SDK قراءة فقط يقترح 1–3 مهام وملكيات.
 * الاقتراح لا ينفّذ شيئاً؛ الواجهة تعبئ النموذج والمستخدم يراجع ويؤكد بدء فريق جديد.
 */

'use strict';

const path = require('path');

const executor = require('./executor');
const memory = require('./memory');
const sessionmeta = require('./sessionmeta');
const worktrees = require('./worktrees');

const MAX_TASK_CHARS = 4000;
const MAX_OUTPUT_CHARS = 16000;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 180000;
const SAFE_RUN_ID = /^ops-plan-[a-z0-9-]{6,80}$/;
const READ_TOOLS = new Set(['read', 'grep', 'glob']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped']);

let sequence = 0;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function promptFor(task) {
  return [
    '[مخطط غرفة العمليات — قراءة فقط]',
    'افحص بنية المشروع بأدوات Read وGrep وGlob فقط. لا تستخدم Bash أو Git أو الكتابة أو المتصفح أو الوكلاء الفرعيين.',
    'اقترح من مهمة واحدة إلى ثلاث مهام تنفيذ مستقلة بملكيات ملفات غير متداخلة. استخدم مسارات نسبية وأنماط * و? و** فقط.',
    'لا تنفّذ أي تعديل. أعد في النهاية كتلة واحدة فقط بهذه الصيغة:',
    '<ops_plan>{"tasks":[{"task":"وصف عربي محدد","ownership":["src/area/**"]}]}</ops_plan>',
    'لا تضع أسراراً أو محتوى ملفات في JSON؛ أسماء المسارات والوصف الموجز فقط.',
    '',
    'المهمة الكبيرة:',
    task,
  ].join('\n');
}

function parsePlan(value) {
  const matches = [...String(value || '').matchAll(/<ops_plan>([\s\S]*?)<\/ops_plan>/g)];
  if (!matches.length) return null;
  try {
    const parsed = JSON.parse(matches.at(-1)[1]);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length < 1 || parsed.tasks.length > 3) return null;
    const tasks = parsed.tasks.map((item) => ({
      task: cleanText(item && item.task, MAX_TASK_CHARS),
      ownership: executor.normalizeOwnership(item && item.ownership),
    }));
    if (tasks.some((item) => !item.task || !item.ownership)) return null;
    for (let left = 0; left < tasks.length; left++) {
      for (let right = left + 1; right < tasks.length; right++) {
        if (executor.ownershipsOverlap(tasks[left].ownership, tasks[right].ownership)) return null;
      }
    }
    return { tasks };
  } catch { return null; }
}

function publicRun(run) {
  return {
    id: run.id, type: 'ops_plan_update', schema_version: 1, state: run.state,
    task: run.task, plan: run.plan ? { tasks: run.plan.tasks.map((item) => ({ task: item.task, ownership: item.ownership.slice() })) } : null,
    error: run.error, created_at: run.created_at, updated_at: run.updated_at, duration_ms: run.duration_ms,
  };
}

function create(options) {
  const settings = options || {};
  const runner = settings.runner;
  const manager = settings.worktrees || worktrees;
  const meta = settings.sessionmeta || sessionmeta;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Math.max(20, Math.min(Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const runs = new Map();
  let activeRunId = null;

  function publish(run) {
    run.updated_at = now();
    if (typeof run._emit === 'function') run._emit({ type: 'ops_plan_update', run: publicRun(run) });
  }

  function stopHandle(run) {
    if (run._handle && typeof run._handle.stop === 'function') Promise.resolve(run._handle.stop()).catch(() => {});
  }

  function finish(run, state, error) {
    if (run._finishing) return run._finishPromise;
    run._finishing = true;
    run._finished = true;
    clearTimeout(run._timer);
    const combined = run._texts.join('\n\n').trim() || run._stream.trim() || run._result;
    if (state === 'completed') {
      if (memory.hasSecret(combined)) { state = 'failed'; error = 'secret_detected'; }
      else {
        run.plan = parsePlan(combined);
        if (!run.plan) { state = 'failed'; error = 'invalid_plan'; }
      }
    }
    run.state = 'cleaning'; publish(run);
    run._finishPromise = Promise.resolve(manager.remove(run._worktreeId)).catch(() => ({ ok: false })).then((removed) => {
      run.state = removed && removed.ok ? state : 'failed';
      run.error = removed && removed.ok ? cleanText(error, 200) : 'cleanup_failed';
      run.duration_ms = Math.max(0, now() - run.created_at);
      run._handle = null; activeRunId = activeRunId === run.id ? null : activeRunId; publish(run);
      return publicRun(run);
    });
    return run._finishPromise;
  }

  function allowedTool(run, name, input) {
    const tool = String(name || '').toLowerCase();
    if (!READ_TOOLS.has(tool)) return false;
    const raw = input && typeof input === 'object' ? input.file_path || input.path : '';
    if (!raw && (tool === 'grep' || tool === 'glob')) return true;
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(run._cwd, raw);
    const relative = path.relative(run._cwd, target);
    return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  }

  async function start(input, cwd, emit) {
    const task = cleanText(input && input.task, MAX_TASK_CHARS);
    if (!task || memory.hasSecret(task) || typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_input' };
    if (!runner || typeof runner.start !== 'function' || runner.engine !== 'sdk') return { ok: false, error: 'planner_engine_unavailable' };
    if (activeRunId) return { ok: false, error: 'busy' };
    const made = await manager.create(cwd);
    if (!made || !made.ok || !made.worktree) return made || { ok: false, error: 'worktree_failed' };
    const createdAt = now();
    const run = {
      id: 'ops-plan-' + createdAt.toString(36) + '-' + (++sequence).toString(36), state: 'running', task,
      plan: null, error: '', created_at: createdAt, updated_at: createdAt, duration_ms: 0,
      _sourceCwd: path.resolve(cwd), _cwd: made.worktree.path, _worktreeId: made.worktree.id,
      _emit: emit, _handle: null, _pendingDenials: [], _texts: [], _stream: '', _result: '',
      _diagnostics: [], _timer: null, _finished: false, _finishing: false, _finishPromise: null,
    };
    runs.set(run.id, run); activeRunId = run.id; publish(run);
    const onEvent = (event) => {
      if (run._finished || !event || typeof event !== 'object') return;
      // وسم جلسة الأداة وقت إنشائها (‏OBS-068 ب) — لا تُكشف بالمسار وحده لاحقاً.
      if (event.session_id && (event.type === 'system' || event.type === 'result')) meta.setKind(event.session_id, 'tool');
      if (event.type === 'permission_request') {
        const safe = allowedTool(run, event.tool, event.input);
        if (run._handle && typeof run._handle.resolvePermission === 'function') run._handle.resolvePermission(event.id, safe, false);
        else run._pendingDenials.push({ id: event.id, allow: safe });
        if (!safe) { stopHandle(run); finish(run, 'failed', 'forbidden_tool'); }
      } else if (event.type === 'assistant') {
        const blocks = event.message && Array.isArray(event.message.content) ? event.message.content : [];
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_use' && !allowedTool(run, block.name, block.input)) {
            stopHandle(run); finish(run, 'failed', 'forbidden_tool'); return;
          }
          if (block.type === 'text' && block.phase !== 'commentary') {
            const value = cleanText(block.text, MAX_OUTPUT_CHARS); if (value) run._texts.push(value);
          }
        }
      } else if (event.type === 'stream_text') {
        run._stream = (run._stream + String(event.text || '')).slice(0, MAX_OUTPUT_CHARS);
      } else if (event.type === 'file_edit' || event.type === 'model_term' || event.type === 'verification_result'
        || /^(?:preview_|browser_|terminal_)/.test(event.type)) {
        stopHandle(run); finish(run, 'failed', 'forbidden_event');
      } else if (event.type === 'result') {
        run._result = cleanText(event.result, MAX_OUTPUT_CHARS);
      } else if (event.type === 'spawn_error') {
        stopHandle(run); finish(run, 'failed', 'planner_engine_unavailable');
      } else if (event.type === 'stderr') {
        run._diagnostics.push(cleanText(event.text, 200));
      } else if (event.type === 'proc_done') {
        finish(run, event.code === 0 ? 'completed' : 'failed', event.code === 0 ? '' : 'engine_failed');
      }
    };
    run._timer = setTimeout(() => { stopHandle(run); finish(run, 'timed_out', 'timeout'); }, timeoutMs);
    Promise.resolve(runner.start({
      prompt: promptFor(task), images: [], sessionId: null, model: cleanText(runner.model, 64) || null,
      permissionMode: 'plan', skills: [], effort: 'medium', extraDirs: [], browserControl: false,
    }, run._cwd, onEvent)).then((handle) => {
      run._handle = handle;
      for (const pending of run._pendingDenials.splice(0)) {
        if (handle && typeof handle.resolvePermission === 'function') handle.resolvePermission(pending.id, pending.allow, false);
      }
      if (run._finished) stopHandle(run);
    }).catch(() => finish(run, 'failed', 'planner_engine_unavailable'));
    return { ok: true, run: publicRun(run) };
  }

  async function stop(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const run = runs.get(runId); if (!run) return { ok: false, error: 'not_found' };
    if (TERMINAL_STATES.has(run.state)) return { ok: true, run: publicRun(run) };
    stopHandle(run); const snapshot = await finish(run, 'stopped', 'user_stopped'); return { ok: true, run: snapshot };
  }

  function latest(cwd) {
    const run = [...runs.values()].slice(-1)[0];
    if (run && cwd && path.resolve(cwd) !== run._sourceCwd) return null;
    return run ? publicRun(run) : null;
  }

  async function stopAll() { return activeRunId ? stop(activeRunId) : { ok: true, run: null }; }

  return { start, stop, stopAll, latest };
}

module.exports = { create, SAFE_RUN_ID, parsePlan, MAX_TASK_CHARS };
