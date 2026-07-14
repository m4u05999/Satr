/**
 * عصف غرفة العمليات: رأيان مستقلان من SDK وCodex داخل cwd فارغ، بلا أدوات أو أذونات.
 * لا حلقة بين المحركين ولا وصول إلى المشروع؛ المستخدم هو صاحب القرار والجولة التالية.
 */

'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_BRIEF_CHARS = 12000;
const MAX_SUMMARY_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 180000;
const SAFE_RUN_ID = /^ops-brainstorm-[a-z0-9-]{6,80}$/;
const ENGINES = Object.freeze(['sdk', 'codex']);
const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'timed_out', 'stopped']);
const FORBIDDEN_EVENTS = new Set(['file_edit', 'model_term', 'verification_result', 'preview_open']);

let sequence = 0;

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function promptFor(brief, engine) {
  return [
    '[عصف غرفة العمليات — رأي نصي مستقل بلا أدوات]',
    'أنت مستشار ' + engine + ' مستقل. لا تطلب أدوات ولا ملفات ولا متصفحاً ولا طرفية.',
    'حلّل الموجز فقط كما هو؛ لا تفترض أنك ترى المشروع. قدّم رأياً منظماً: فرص، مخاطر، ترتيب أولويات، وأسئلة حسم.',
    'لا تحاول مخاطبة المستشار الآخر أو بدء جولة جديدة. المستخدم وحده يوحّد الرأيين ويقرر.',
    '',
    'الموجز غير التنفيذي:',
    brief,
  ].join('\n');
}

function workerPublic(worker) {
  return {
    id: worker.id, engine: worker.engine, state: worker.state, summary: worker.summary,
    error: worker.error, created_at: worker.created_at, updated_at: worker.updated_at,
    duration_ms: worker.duration_ms, cost: { ...worker.cost }, permission_denied: worker.permission_denied,
  };
}

function runPublic(run) {
  return {
    id: run.id, type: 'ops_brainstorm_update', schema_version: 1,
    state: run.state, brief: run.brief, created_at: run.created_at, updated_at: run.updated_at,
    duration_ms: run.duration_ms, workers: run.workers.map(workerPublic),
  };
}

function create(options) {
  const settings = options || {};
  const resolveEngine = typeof settings.resolveEngine === 'function' ? settings.resolveEngine : () => null;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Math.max(20, Math.min(Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const isolationRoot = path.resolve(settings.isolationRoot || os.tmpdir());
  const runs = new Map();
  let activeRunId = null;

  function publish(run) {
    run.updated_at = now();
    if (typeof run._emit === 'function') run._emit({ type: 'ops_brainstorm_update', run: runPublic(run) });
  }

  function finalize(run) {
    if (!run.workers.every((worker) => TERMINAL_STATES.has(worker.state) && worker.state !== 'partial')) return;
    const completed = run.workers.filter((worker) => worker.state === 'completed').length;
    if (run._stopRequested) run.state = 'stopped';
    else if (completed === run.workers.length) run.state = 'completed';
    else if (completed > 0) run.state = 'partial';
    else if (run.workers.some((worker) => worker.state === 'timed_out')) run.state = 'timed_out';
    else run.state = 'failed';
    run.duration_ms = Math.max(0, now() - run.created_at);
    activeRunId = activeRunId === run.id ? null : activeRunId;
    publish(run);
  }

  function finish(run, worker, state, error) {
    if (worker._finished) return;
    worker._finished = true;
    clearTimeout(worker._timer);
    const combined = worker._texts.join('\n\n').trim() || worker._stream.trim() || worker._result;
    worker.summary = state === 'completed' ? cleanText(combined, MAX_SUMMARY_CHARS) : '';
    worker.state = state;
    worker.error = cleanText(error, 500);
    worker.duration_ms = Math.max(0, now() - worker.created_at);
    worker.updated_at = now();
    worker._handle = null;
    if (worker._root) {
      fsp.rm(worker._root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      worker._root = '';
    }
    publish(run);
    finalize(run);
  }

  function stopHandle(worker) {
    if (worker._handle && typeof worker._handle.stop === 'function') Promise.resolve(worker._handle.stop()).catch(() => {});
  }

  async function launch(run, worker, runner) {
    try {
      const root = await fsp.mkdtemp(path.join(isolationRoot, 'satr-brainstorm-'));
      const cwd = path.join(root, 'workspace');
      await fsp.mkdir(cwd, { recursive: false });
      worker._root = root;
      if (worker._finished) {
        await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
        worker._root = '';
        return;
      }
      const onEvent = (event) => {
        if (worker._finished || !event || typeof event !== 'object') return;
        if (event.type === 'permission_request') {
          worker.permission_denied++;
          if (worker._handle && typeof worker._handle.resolvePermission === 'function') {
            worker._handle.resolvePermission(event.id, false, false);
          } else worker._pendingDenials.push(event.id);
          stopHandle(worker); finish(run, worker, 'failed', 'أوقف العصف طلب إذن غير مسموح'); return;
        }
        if (event.type === 'assistant') {
          const blocks = event.message && Array.isArray(event.message.content) ? event.message.content : [];
          if (blocks.some((block) => block && block.type === 'tool_use')) {
            stopHandle(worker); finish(run, worker, 'failed', 'أوقف العصف أداة غير مسموحة'); return;
          }
          for (const block of blocks) {
            if (block && block.type === 'text' && block.phase !== 'commentary') {
              const value = cleanText(block.text, MAX_SUMMARY_CHARS);
              if (value) worker._texts.push(value);
            }
          }
        } else if (event.type === 'user') {
          const blocks = event.message && Array.isArray(event.message.content) ? event.message.content : [];
          if (blocks.some((block) => block && block.type === 'tool_result')) {
            stopHandle(worker); finish(run, worker, 'failed', 'أوقف العصف ناتج أداة غير مسموح');
          }
        } else if (event.type === 'stream_text') {
          worker._stream = (worker._stream + String(event.text || '')).slice(0, MAX_SUMMARY_CHARS);
        } else if (FORBIDDEN_EVENTS.has(event.type) || /^(?:preview_|browser_|terminal_)/.test(event.type)) {
          stopHandle(worker); finish(run, worker, 'failed', 'أوقف العصف حدث تنفيذ غير مسموح');
        } else if (event.type === 'result') {
          const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
          worker.cost = { usd: Math.max(0, Number(event.total_cost_usd) || 0),
            input_tokens: Math.max(0, Number(usage.input_tokens) || 0), output_tokens: Math.max(0, Number(usage.output_tokens) || 0),
            estimate: usage.estimate === true };
          worker._result = cleanText(event.result, MAX_SUMMARY_CHARS);
        } else if (event.type === 'spawn_error') {
          stopHandle(worker); finish(run, worker, 'failed', 'brainstorm_engine_unavailable');
        } else if (event.type === 'stderr') {
          worker._diagnostics.push(cleanText(event.text, 500));
        } else if (event.type === 'proc_done') {
          finish(run, worker, event.code === 0 ? 'completed' : 'failed',
            event.code === 0 ? '' : worker._diagnostics.join(' | ') || 'فشل مستشار العصف');
        }
      };
      const handle = await runner.start({
        prompt: promptFor(run.brief, worker.engine), images: [], sessionId: null,
        model: cleanText(runner.model, 64) || null, permissionMode: 'plan', skills: [],
        effort: 'medium', extraDirs: [], browserControl: false,
      }, cwd, onEvent);
      worker._handle = handle;
      for (const id of worker._pendingDenials.splice(0)) {
        if (handle && typeof handle.resolvePermission === 'function') handle.resolvePermission(id, false, false);
      }
      if (worker._finished) stopHandle(worker);
    } catch (error) { finish(run, worker, 'failed', String((error && error.message) || error)); }
  }

  function start(input, cwd, emit) {
    const brief = cleanText(input && input.brief, MAX_BRIEF_CHARS);
    if (!brief || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { ok: false, error: 'bad_input' };
    if (activeRunId) return { ok: false, error: 'busy' };
    const runners = new Map();
    for (const engine of ENGINES) {
      const runner = resolveEngine(engine);
      if (!runner || typeof runner.start !== 'function') return { ok: false, error: 'brainstorm_engine_unavailable', engine };
      runners.set(engine, runner);
    }
    const createdAt = now();
    const run = {
      id: 'ops-brainstorm-' + createdAt.toString(36) + '-' + (++sequence).toString(36), state: 'running', brief,
      created_at: createdAt, updated_at: createdAt, duration_ms: 0, _emit: emit, _stopRequested: false,
      _sourceCwd: path.resolve(cwd),
      workers: ENGINES.map((engine, index) => ({
        id: 'brainstorm-' + (index + 1), engine, state: 'running', summary: '', error: '',
        created_at: createdAt, updated_at: createdAt, duration_ms: 0,
        cost: { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false }, permission_denied: 0,
        _handle: null, _pendingDenials: [], _texts: [], _stream: '', _result: '', _diagnostics: [],
        _finished: false, _root: '', _timer: null,
      })),
    };
    runs.set(run.id, run); activeRunId = run.id; publish(run);
    for (const worker of run.workers) {
      worker._timer = setTimeout(() => { stopHandle(worker); finish(run, worker, 'timed_out', 'انتهت مهلة مستشار العصف'); }, timeoutMs);
      launch(run, worker, runners.get(worker.engine));
    }
    return { ok: true, run: runPublic(run) };
  }

  async function stop(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const run = runs.get(runId);
    if (!run) return { ok: false, error: 'not_found' };
    if (TERMINAL_STATES.has(run.state)) return { ok: true, run: runPublic(run) };
    run._stopRequested = true;
    for (const worker of run.workers) {
      if (!worker._finished) { stopHandle(worker); finish(run, worker, 'stopped', 'أوقف المستخدم العصف'); }
    }
    finalize(run);
    return { ok: true, run: runPublic(run) };
  }

  function latest(cwd) {
    const run = [...runs.values()].slice(-1)[0];
    if (run && cwd && path.resolve(cwd) !== run._sourceCwd) return null;
    return run ? runPublic(run) : null;
  }

  async function stopAll() { return activeRunId ? stop(activeRunId) : { ok: true, run: null }; }

  return { start, stop, stopAll, latest };
}

module.exports = { create, SAFE_RUN_ID, MAX_BRIEF_CHARS };
