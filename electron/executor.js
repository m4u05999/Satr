/**
 * عامل SDK منفّذ واحد داخل git worktree معزول — الأولوية 6/الخطوة 2.
 *
 * لا merge ولا commit ولا Bash. يسمح بأدوات القراءة وتحرير الملفات داخل worktree
 * فقط، يجمع gitdiff بعد الدور، ثم يزيل النسخة المؤقتة. أي مسار خارجها يفشل مغلقاً.
 */

'use strict';

const path = require('path');
const worktrees = require('./worktrees');

const SAFE_RUN_ID = /^execution-[a-z0-9-]{6,80}$/;
const MAX_TASK_CHARS = 4000;
const MAX_SUMMARY_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 300000;
const MAX_WRITE_PERMISSIONS = 30;
const READ_TOOLS = new Set(['read', 'grep', 'glob']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed']);

let sequence = 0;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function defaultRunner() { return require('./agent'); }

function publicChanges(diff) {
  const files = diff && Array.isArray(diff.files) ? diff.files.map((file) => ({
    rel: file.rel,
    kind: file.kind,
    added: Math.max(0, Number(file.added) || 0),
    removed: Math.max(0, Number(file.removed) || 0),
    skipped: file.skipped || '',
  })) : [];
  return {
    files,
    more: Math.max(0, Number(diff && diff.more) || 0),
    partial: !!(diff && diff.partial),
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

function publicRun(run) {
  return {
    id: run.id,
    type: 'execution_update',
    schema_version: 1,
    state: run.state,
    task: run.task,
    engine: 'sdk',
    created_at: run.created_at,
    updated_at: run.updated_at,
    duration_ms: run.duration_ms,
    summary: run.summary,
    error: run.error,
    cost: { ...run.cost },
    permissions: { ...run.permissions },
    edits_seen: run.edits_seen,
    changes: { ...run.changes, files: run.changes.files.map((file) => ({ ...file })) },
    worktree: run.worktree ? { ...run.worktree } : null,
    merged: false,
    merge_supported: false,
  };
}

function create(options) {
  const settings = options || {};
  const manager = settings.worktrees || worktrees;
  const runner = settings.runner || defaultRunner();
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Math.max(20, Math.min(Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const runs = new Map();
  let activeRunId = null;

  function publish(run) {
    run.updated_at = now();
    if (typeof run._emit === 'function') run._emit({ type: 'execution_update', run: publicRun(run) });
  }

  function candidatePath(run, input) {
    if (!input || typeof input !== 'object') return '';
    const value = input.file_path || input.path;
    if (typeof value !== 'string' || !value.trim()) return '';
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(run._worktreePath, value);
  }

  function allowedTool(run, name, input) {
    const normalized = String(name || '').toLowerCase();
    if (normalized === 'glob') return { ok: true, tier: 'read' };
    if (!READ_TOOLS.has(normalized) && !EDIT_TOOLS.has(normalized)) return { ok: false, error: 'forbidden_tool' };
    const wanted = candidatePath(run, input);
    if (normalized === 'grep' && !wanted) return { ok: true, tier: 'read', path: run._worktreePath };
    if (!wanted || !manager.contains(run._worktreeId, wanted)) return { ok: false, error: 'outside' };
    return { ok: true, tier: EDIT_TOOLS.has(normalized) ? 'write' : 'read', path: wanted };
  }

  function promptFor(task) {
    return [
      '[عامل منفّذ معزول داخل git worktree مؤقت]',
      'نفّذ المهمة التالية بتعديل الملفات داخل مجلد العمل الحالي فقط. لا تستخدم Bash أو الطرفية أو Git أو المتصفح أو أي وكيل فرعي.',
      'الأدوات المسموحة: Read وGrep وGlob وEdit وWrite وMultiEdit. لا تكتب مساراً مطلقاً ولا مساراً يحوي ..',
      'لا تلتزم ولا تدمج التغييرات؛ سطر سيجمع git diff ثم يحذف worktree. اختم بملخص موجز لما عدّلته.',
      '',
      'المهمة: ' + task,
    ].join('\n');
  }

  async function finish(run, desiredState, error) {
    if (run._finishing) return run._finishPromise;
    run._finishing = true;
    run._finishPromise = (async () => {
      clearTimeout(run._timer);
      run.state = 'capturing';
      publish(run);
      let diff = { ok: false, error: 'diff_failed' };
      try { diff = await manager.diff(run._worktreeId); } catch { /* أفضل جهد */ }
      if (diff && diff.ok) run.changes = publicChanges(diff);
      let removed = { ok: false, error: 'remove_failed' };
      try { removed = await manager.remove(run._worktreeId); } catch { /* أفضل جهد */ }
      run.duration_ms = Math.max(0, now() - run.created_at);
      run.error = cleanText(error, 600);
      run.state = removed && removed.ok ? desiredState : 'cleanup_failed';
      if (run.state === 'cleanup_failed' && !run.error) run.error = 'تعذّر حذف worktree المؤقت';
      run._handle = null;
      activeRunId = activeRunId === run.id ? null : activeRunId;
      publish(run);
      return publicRun(run);
    })();
    return run._finishPromise;
  }

  async function stopThenFinish(run, desiredState, error) {
    run._stopping = true;
    if (run._handle && run._handle.stop) await Promise.resolve(run._handle.stop()).catch(() => {});
    return finish(run, desiredState, error);
  }

  function onAssistant(run, event) {
    const blocks = event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.phase !== 'commentary') {
        const text = cleanText(block.text, MAX_SUMMARY_CHARS);
        if (text) run._texts.push(text);
      } else if (block.type === 'tool_use') {
        const allowed = allowedTool(run, block.name, block.input);
        if (!allowed.ok) return { ok: false, error: allowed.error + ': ' + String(block.name || 'unknown') };
      }
    }
    return { ok: true };
  }

  async function start(input, cwd, emit) {
    const task = cleanText(input && input.task, MAX_TASK_CHARS);
    if (!task || typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_input' };
    if (activeRunId) return { ok: false, error: 'busy' };
    if (!runner || typeof runner.start !== 'function') return { ok: false, error: 'engine_unavailable' };

    const made = await manager.create(cwd);
    if (!made || !made.ok || !made.worktree) return made || { ok: false, error: 'worktree_failed' };
    const createdAt = now();
    const run = {
      id: 'execution-' + createdAt.toString(36) + '-' + (++sequence).toString(36),
      state: 'running',
      task,
      created_at: createdAt,
      updated_at: createdAt,
      duration_ms: 0,
      summary: '',
      error: '',
      cost: { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false },
      permissions: { write_limit: MAX_WRITE_PERMISSIONS, write_used: 0, denied: 0 },
      edits_seen: 0,
      changes: { files: [], more: 0, partial: false, added: 0, removed: 0 },
      worktree: {
        id: made.worktree.id,
        repo_name: made.worktree.repo_name,
        head: made.worktree.head,
        isolated: true,
      },
      _sourceCwd: path.resolve(cwd),
      _worktreeId: made.worktree.id,
      _worktreePath: made.worktree.path,
      _emit: emit,
      _handle: null,
      _pendingPermissions: [],
      _texts: [],
      _diagnostics: [],
      _stopping: false,
      _finishing: false,
      _finishPromise: null,
      _timer: null,
    };
    runs.set(run.id, run);
    activeRunId = run.id;
    publish(run);

    const handleEvent = (event) => {
      if (!event || typeof event !== 'object' || run._finishing || run._stopping) return;
      if (event.type === 'permission_request') {
        const allowed = allowedTool(run, event.tool, event.input);
        const canWrite = allowed.ok && allowed.tier === 'write' && run.permissions.write_used < run.permissions.write_limit;
        const canRead = allowed.ok && allowed.tier === 'read';
        const allow = canWrite || canRead;
        if (canWrite) run.permissions.write_used++;
        if (!allow) run.permissions.denied++;
        if (run._handle && typeof run._handle.resolvePermission === 'function') {
          run._handle.resolvePermission(event.id, allow, false);
        } else run._pendingPermissions.push({ id: event.id, allow });
        publish(run);
        return;
      }
      if (event.type === 'assistant') {
        const checked = onAssistant(run, event);
        if (!checked.ok) {
          stopThenFinish(run, 'failed', 'أوقف المنفّذ أداة أو مساراً غير مسموح: ' + checked.error);
        }
      } else if (event.type === 'file_edit') {
        const relative = cleanText(event.rel, 512).replace(/\\/g, '/');
        const absolute = relative && !path.isAbsolute(relative) ? path.resolve(run._worktreePath, relative) : '';
        if (!absolute || relative.split('/').includes('..') || !manager.contains(run._worktreeId, absolute)) {
          stopThenFinish(run, 'failed', 'رُصد تعديل خارج worktree');
          return;
        }
        run.edits_seen++;
        publish(run);
      } else if (event.type === 'model_term' || event.type === 'verification_result' || event.type === 'preview_open') {
        stopThenFinish(run, 'failed', 'أوقف المنفّذ حدث تنفيذ غير مسموح');
      } else if (event.type === 'result') {
        const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
        run.cost = {
          usd: Math.max(0, Number(event.total_cost_usd) || 0),
          input_tokens: Math.max(0, Number(usage.input_tokens) || 0),
          output_tokens: Math.max(0, Number(usage.output_tokens) || 0),
          estimate: usage.estimate === true,
        };
        run.summary = cleanText(run._texts.join('\n\n') || event.result, MAX_SUMMARY_CHARS);
      } else if (event.type === 'spawn_error' || event.type === 'stderr') {
        run._diagnostics.push(cleanText(event.text, 500));
      } else if (event.type === 'proc_done') {
        const desired = run._stopping ? 'stopped' : event.code === 0 ? 'completed' : 'failed';
        finish(run, desired, event.code === 0 ? '' : run._diagnostics.join(' | ') || 'فشل العامل المنفّذ');
      }
    };

    run._timer = setTimeout(() => {
      run._stopping = true;
      stopThenFinish(run, 'timed_out', 'انتهت مهلة العامل المنفّذ');
    }, timeoutMs);

    Promise.resolve().then(() => runner.start({
      prompt: promptFor(task),
      images: [],
      sessionId: null,
      model: null,
      permissionMode: 'acceptEdits',
      skills: [],
      effort: 'medium',
      extraDirs: [],
      browserControl: false,
    }, made.worktree.path, handleEvent)).then((handle) => {
      run._handle = handle;
      for (const pending of run._pendingPermissions.splice(0)) {
        if (handle && typeof handle.resolvePermission === 'function') handle.resolvePermission(pending.id, pending.allow, false);
      }
      if (run._finishing && handle && handle.stop) Promise.resolve(handle.stop()).catch(() => {});
    }).catch((error) => finish(run, 'failed', String((error && error.message) || error)));

    return { ok: true, run: publicRun(run) };
  }

  async function stop(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const run = runs.get(runId);
    if (!run) return { ok: false, error: 'not_found' };
    if (TERMINAL_STATES.has(run.state)) return { ok: true, run: publicRun(run) };
    run._stopping = true;
    if (run._handle && run._handle.stop) await Promise.resolve(run._handle.stop()).catch(() => {});
    const snapshot = await finish(run, 'stopped', 'أوقف المستخدم العامل المنفّذ');
    return { ok: true, run: snapshot };
  }

  async function stopAll() {
    const result = activeRunId ? await stop(activeRunId) : { ok: true, run: null };
    if (manager && typeof manager.removeAll === 'function') await manager.removeAll().catch(() => {});
    return result;
  }

  function latest(cwd) {
    const run = [...runs.values()].slice(-1)[0];
    if (run && typeof cwd === 'string' && cwd.trim() && path.resolve(cwd) !== run._sourceCwd) return null;
    return run ? publicRun(run) : null;
  }

  return { start, stop, stopAll, latest };
}

const singleton = create();

module.exports = {
  create,
  start: singleton.start,
  stop: singleton.stop,
  stopAll: singleton.stopAll,
  latest: singleton.latest,
  SAFE_RUN_ID,
  MAX_WRITE_PERMISSIONS,
  DEFAULT_TIMEOUT_MS,
};
