/**
 * عامل منفّذ محايد عن المحرك داخل git worktree معزول — الأولوية 6/الخطوة 2.
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
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 600000;
const TIMEOUT_PRESETS_MS = Object.freeze([180000, 300000, 600000]);
const MAX_WRITE_PERMISSIONS = 30;
const MAX_MALFORMED_TOOLS = 3; // سقف محاولات أداة مسموحة بمدخل JSON معطوب قبل الفشل (منع loop)
const MAX_OWNERSHIP_PATTERNS = 16;
const MAX_PATTERN_CHARS = 256;
const SAFE_ENGINE_LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const READ_TOOLS = new Set(['read', 'grep', 'glob']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed']);
const PUBLIC_FAILURE_MESSAGES = Object.freeze({
  timeout: 'انتهت مهلة العامل.',
  user_stopped: 'أوقف المستخدم العامل.',
  engine_failed: 'فشل محرك العامل.',
  policy_violation: 'أوقف العامل خرقٌ لسياسة الأدوات أو المسارات.',
  worktree_violation: 'رُصد مسار خارج نسخة العمل المعزولة.',
  ownership_violation: 'رُصد تعديل خارج الملكية المعلنة.',
  artifact_capture_failed: 'تعذّر التقاط أثر العامل.',
  cleanup_failed: 'تعذّر تنظيف نسخة العمل المعزولة.',
});

let sequence = 0;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function normalizePattern(value) {
  const raw = cleanText(value, MAX_PATTERN_CHARS).replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return '';
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || !/^[\p{L}\p{N}._@+()*? -]+$/u.test(part))) return '';
  return parts.join('/');
}

function normalizeOwnership(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_OWNERSHIP_PATTERNS) return null;
  const patterns = value.map(normalizePattern);
  if (patterns.some((pattern) => !pattern)) return null;
  return [...new Set(patterns)];
}

function globRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') { source += '.*'; index++; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(source + '$', 'u');
}

function ownedBy(patterns, relative) {
  const normalized = normalizePattern(relative);
  if (!normalized || normalized.toLowerCase() === '.git' || normalized.toLowerCase().startsWith('.git/')) return false;
  return patterns.some((pattern) => globRegex(pattern).test(normalized));
}

function staticDirectory(pattern) {
  const wildcard = pattern.search(/[?*]/);
  const fixed = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  const slash = fixed.lastIndexOf('/');
  return slash < 0 ? '' : fixed.slice(0, slash + 1);
}

function patternsOverlap(left, right) {
  const leftWild = /[?*]/.test(left);
  const rightWild = /[?*]/.test(right);
  if (!leftWild && !rightWild) return left === right;
  if (!leftWild) return globRegex(right).test(left);
  if (!rightWild) return globRegex(left).test(right);
  const leftDir = staticDirectory(left);
  const rightDir = staticDirectory(right);
  return !leftDir || !rightDir || leftDir.startsWith(rightDir) || rightDir.startsWith(leftDir);
}

function ownershipsOverlap(left, right) {
  const a = normalizeOwnership(left);
  const b = normalizeOwnership(right);
  return !!a && !!b && a.some((one) => b.some((two) => patternsOverlap(one, two)));
}

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
    engine: run.engine,
    created_at: run.created_at,
    updated_at: run.updated_at,
    duration_ms: run.duration_ms,
    summary: run.summary,
    error: run.failure_code ? (PUBLIC_FAILURE_MESSAGES[run.failure_code] || 'فشل العامل بسبب غير مصنّف.') : '',
    failure_code: run.failure_code,
    cost: { ...run.cost },
    permissions: { ...run.permissions },
    edits_seen: run.edits_seen,
    ownership: run.ownership.slice(),
    changes: { ...run.changes, files: run.changes.files.map((file) => ({ ...file })) },
    worktree: run.worktree ? { ...run.worktree } : null,
    last_tool: run.last_tool,
    last_file: run.last_file,
    last_activity_at: run.last_activity_at,
    timeout_ms: run.timeout_ms,
    deadline_at: run.deadline_at,
    extended: run._extended === true,
    can_extend: run.state === 'running' && run._extended !== true
      && TIMEOUT_PRESETS_MS.some((value) => value > run.timeout_ms),
    artifact_ready: !!(run._artifact && run._artifact.patch),
    patch_bytes: Math.max(0, Number(run._artifact && run._artifact.bytes) || 0),
    merged: false,
    merge_supported: false,
  };
}

function create(options) {
  const settings = options || {};
  const manager = settings.worktrees || worktrees;
  const runner = settings.runner;
  const engine = cleanText(runner && runner.engine, 32);
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Math.max(20, Math.min(Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const runs = new Map();
  let activeRunId = null;

  function armTimeout(run) {
    clearTimeout(run._timer);
    const remaining = Math.max(1, run.deadline_at - now());
    run._timer = setTimeout(() => {
      run._stopping = true;
      stopThenFinish(run, 'timed_out', 'انتهت مهلة العامل المنفّذ', 'timeout');
    }, remaining);
  }

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

  // وسم SDK الصريح لمدخل فشل تحليله: input بمفتاح وحيد __unparsedToolInput قيمته
  // {raw:string, len:number}. الحصر بـsdk والبنية الدقيقة يمنعان محركاً آخر، أو مدخلاً يجمع
  // الوسم مع حقل قابل للتنفيذ (file_path)، من التسلل بوصفه «معطوباً» متجاوزاً فحص المسار.
  function isSdkUnparsedMarker(run, input) {
    if (run.engine !== 'sdk') return false;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== '__unparsedToolInput') return false;
    const marker = input.__unparsedToolInput;
    if (!marker || typeof marker !== 'object') return false;
    const mk = Object.keys(marker);
    return mk.length === 2 && typeof marker.raw === 'string' && typeof marker.len === 'number';
  }

  function allowedTool(run, name, input) {
    const normalized = String(name || '').toLowerCase();
    if (!READ_TOOLS.has(normalized) && !EDIT_TOOLS.has(normalized)) return { ok: false, error: 'forbidden_tool' };
    const wanted = candidatePath(run, input);
    // مدخل لم يحلّله SDK (علامة __unparsedToolInput الصريحة ⇒ InputValidationError، الأداة لن
    // تُنفَّذ): ليس خرق عزل، لكن نُبقيه ok:false (fail-closed بنيوياً) مع علامة malformed؛
    // onAssistant وحده يتسامح معه ضمن ميزانية متتالية ليعيد النموذج التصحيح. غياب المسار وحده لا
    // يكفي علامةً — قد ينفّذه محرك بحقلٍ لا يعرفه executor، فيبقى fail-closed أدناه.
    if (isSdkUnparsedMarker(run, input)) {
      return { ok: false, malformed: true, error: 'malformed_input' };
    }
    if ((normalized === 'grep' || normalized === 'glob') && !wanted) return { ok: true, tier: 'read', path: run._worktreePath };
    const insideWorktree = wanted && (path.resolve(wanted) === path.resolve(run._worktreePath) || manager.contains(run._worktreeId, wanted));
    if (!insideWorktree) return { ok: false, error: 'outside' };
    const tier = EDIT_TOOLS.has(normalized) ? 'write' : 'read';
    const relative = path.relative(run._worktreePath, wanted).replace(/\\/g, '/');
    if (tier === 'write' && !ownedBy(run.ownership, relative)) {
      return { ok: false, error: 'outside_ownership' };
    }
    return { ok: true, tier, path: wanted, relative };
  }

  function promptFor(task, ownership) {
    return [
      '[عامل منفّذ معزول داخل git worktree مؤقت]',
      'نفّذ المهمة التالية بتعديل الملفات داخل مجلد العمل الحالي فقط. لا تستخدم Bash أو الطرفية أو Git أو المتصفح أو أي وكيل فرعي.',
      'الأدوات المسموحة: Read وGrep وGlob وEdit وWrite وMultiEdit. لا تكتب مساراً مطلقاً ولا مساراً يحوي ..',
      'ملكية الكتابة المعلنة لك فقط: ' + ownership.join('، ') + '. اقرأ ما تحتاجه، لكن لا تعدّل ملفاً لا يطابقها.',
      'لا تلتزم ولا تدمج التغييرات؛ سطر سيجمع git diff ثم يحذف worktree. اختم بملخص موجز لما عدّلته.',
      '',
      'المهمة: ' + task,
    ].join('\n');
  }

  async function finish(run, desiredState, error, failureCode) {
    if (run._finishing) return run._finishPromise;
    run._finishing = true;
    run._finishPromise = (async () => {
      clearTimeout(run._timer);
      run.state = 'capturing';
      publish(run);
      let diff = { ok: false, error: 'diff_failed' };
      try { diff = await manager.diff(run._worktreeId); } catch { /* أفضل جهد */ }
      if (diff && diff.ok) {
        run.changes = publicChanges(diff);
        const outside = run.changes.files.find((file) => !ownedBy(run.ownership, file.rel));
        if (outside) {
          desiredState = 'failed';
          error = 'رُصد فرق خارج الملكية المعلنة: ' + outside.rel;
          failureCode = 'ownership_violation';
        }
      }
      let artifact = { ok: false, error: 'patch_failed' };
      try { artifact = await manager.patch(run._worktreeId); } catch { /* أفضل جهد */ }
      if (artifact && artifact.ok) {
        run._artifact = {
          patch: artifact.patch,
          bytes: artifact.bytes,
          head: artifact.head,
          sourceRoot: artifact.sourceRoot,
        };
      } else if (desiredState === 'completed') {
        desiredState = 'failed';
        error = (artifact && artifact.error) || 'patch_failed';
        failureCode = 'artifact_capture_failed';
      }
      let removed = { ok: false, error: 'remove_failed' };
      try { removed = await manager.remove(run._worktreeId); } catch { /* أفضل جهد */ }
      run.duration_ms = Math.max(0, now() - run.created_at);
      run.error = cleanText(error, 600);
      run.state = removed && removed.ok ? desiredState : 'cleanup_failed';
      run.failure_code = run.state === 'completed' ? '' : cleanText(failureCode, 64);
      if (run.state === 'cleanup_failed') {
        run.failure_code = 'cleanup_failed';
        if (!run.error) run.error = 'تعذّر حذف worktree المؤقت';
      }
      run._handle = null;
      activeRunId = activeRunId === run.id ? null : activeRunId;
      publish(run);
      return publicRun(run);
    })();
    return run._finishPromise;
  }

  async function stopThenFinish(run, desiredState, error, failureCode) {
    run._stopping = true;
    if (run._handle && run._handle.stop) await Promise.resolve(run._handle.stop()).catch(() => {});
    return finish(run, desiredState, error, failureCode);
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
        if (allowed.malformed) {
          run._malformed = (run._malformed || 0) + 1;
          if (run._malformed > MAX_MALFORMED_TOOLS) {
            return { ok: false, error: 'malformed_tool_budget: ' + String(block.name || 'unknown') };
          }
          continue;
        }
        if (!allowed.ok) return { ok: false, error: allowed.error + ': ' + String(block.name || 'unknown') };
        run.last_tool = String(block.name || '').toLowerCase();
        run.last_file = cleanText(allowed.relative, 512);
        run.last_activity_at = now();
        if (block.id) (run._okIds || (run._okIds = new Set())).add(block.id); // تُصفّر الميزانية عند نجاح تنفيذها الفعلي
      }
    }
    return { ok: true };
  }

  async function start(input, cwd, emit) {
    const task = cleanText(input && input.task, MAX_TASK_CHARS);
    const ownership = normalizeOwnership((input && input.ownership) || ['**']);
    if (!task || !ownership || typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_input' };
    if (activeRunId) return { ok: false, error: 'busy' };
    if (!runner || typeof runner.start !== 'function' || !SAFE_ENGINE_LABEL.test(engine)) {
      return { ok: false, error: 'engine_unavailable' };
    }

    const made = await manager.create(cwd);
    if (!made || !made.ok || !made.worktree) return made || { ok: false, error: 'worktree_failed' };
    const createdAt = now();
    const run = {
      id: 'execution-' + createdAt.toString(36) + '-' + (++sequence).toString(36),
      state: 'running',
      task,
      engine,
      ownership,
      created_at: createdAt,
      updated_at: createdAt,
      duration_ms: 0,
      summary: '',
      error: '',
      failure_code: '',
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
      last_tool: '',
      last_file: '',
      last_activity_at: createdAt,
      timeout_ms: timeoutMs,
      deadline_at: createdAt + timeoutMs,
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
      _extended: false,
      _artifact: null,
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
        if (allowed.ok) {
          run.last_tool = String(event.tool || '').toLowerCase();
          run.last_file = cleanText(allowed.relative, 512);
          run.last_activity_at = now();
        }
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
          stopThenFinish(run, 'failed', 'أوقف المنفّذ أداة أو مساراً غير مسموح: ' + checked.error, 'policy_violation');
        } else publish(run);
      } else if (event.type === 'user') {
        const rblocks = event.message && Array.isArray(event.message.content) ? event.message.content : [];
        for (const rb of rblocks) {
          if (rb && rb.type === 'tool_result' && rb.is_error !== true && run._okIds && run._okIds.has(rb.tool_use_id)) {
            run._malformed = 0; // تصفير الميزانية فقط عند نجاح تنفيذ أداة مسموحة فعلياً (لا مجرد قبول مسارها)
            run._okIds.delete(rb.tool_use_id); // استهلاك المعرّف مرة واحدة (منع تراكمه وإعادة استخدامه)
          }
        }
      } else if (event.type === 'file_edit') {
        const relative = cleanText(event.rel, 512).replace(/\\/g, '/');
        const absolute = relative && !path.isAbsolute(relative) ? path.resolve(run._worktreePath, relative) : '';
        if (!absolute || relative.split('/').includes('..') || !manager.contains(run._worktreeId, absolute)) {
          stopThenFinish(run, 'failed', 'رُصد تعديل خارج worktree', 'worktree_violation');
          return;
        }
        if (!ownedBy(run.ownership, relative)) {
          stopThenFinish(run, 'failed', 'رُصد تعديل خارج الملكية المعلنة: ' + relative, 'ownership_violation');
          return;
        }
        run.last_tool = run.last_tool || 'edit';
        run.last_file = relative;
        run.last_activity_at = now();
        run.edits_seen++;
        publish(run);
      } else if (event.type === 'model_term' || event.type === 'verification_result' || event.type === 'preview_open') {
        stopThenFinish(run, 'failed', 'أوقف المنفّذ حدث تنفيذ غير مسموح', 'policy_violation');
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
        finish(run, desired, event.code === 0 ? '' : run._diagnostics.join(' | ') || 'فشل العامل المنفّذ',
          event.code === 0 ? '' : 'engine_failed');
      }
    };

    armTimeout(run);

    Promise.resolve().then(() => runner.start({
      prompt: promptFor(task, ownership),
      images: [],
      sessionId: null,
      model: cleanText(runner && runner.model, 64) || null,
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
    }).catch((error) => finish(run, 'failed', String((error && error.message) || error), 'engine_failed'));

    return { ok: true, run: publicRun(run) };
  }

  async function stop(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const run = runs.get(runId);
    if (!run) return { ok: false, error: 'not_found' };
    if (TERMINAL_STATES.has(run.state)) return { ok: true, run: publicRun(run) };
    run._stopping = true;
    if (run._handle && run._handle.stop) await Promise.resolve(run._handle.stop()).catch(() => {});
    const snapshot = await finish(run, 'stopped', 'أوقف المستخدم العامل المنفّذ', 'user_stopped');
    return { ok: true, run: snapshot };
  }

  function extend(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const run = runs.get(runId);
    if (!run || run.state !== 'running' || run._stopping || run._finishing || run._extended) {
      return { ok: false, error: 'not_available' };
    }
    const nextTimeout = TIMEOUT_PRESETS_MS.find((value) => value > run.timeout_ms);
    if (!nextTimeout) return { ok: false, error: 'timeout_cap' };
    run.deadline_at += nextTimeout - run.timeout_ms;
    run.timeout_ms = nextTimeout;
    run._extended = true;
    armTimeout(run);
    publish(run);
    return { ok: true, run: publicRun(run) };
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

  function artifact(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return null;
    const run = runs.get(runId);
    if (!run || run.state !== 'completed' || !run._artifact || !run._artifact.patch) return null;
    return { ...run._artifact, ownership: run.ownership.slice(), changes: publicChanges(run.changes) };
  }

  return { start, stop, extend, stopAll, latest, artifact };
}

const singleton = create();

module.exports = {
  create,
  start: singleton.start,
  stop: singleton.stop,
  extend: singleton.extend,
  stopAll: singleton.stopAll,
  latest: singleton.latest,
  artifact: singleton.artifact,
  SAFE_RUN_ID,
  MAX_WRITE_PERMISSIONS,
  MAX_OWNERSHIP_PATTERNS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TIMEOUT_PRESETS_MS,
  SAFE_ENGINE_LABEL,
  normalizeOwnership,
  ownedBy,
  ownershipsOverlap,
};
