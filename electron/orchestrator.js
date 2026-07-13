/**
 * منسّق باحثي «سطر» — الخطوة الأولى: بحث قراءة فقط بلا كتابة أو تنفيذ.
 *
 * يشغّل 1–3 أدوار مستقلة عبر عقد engine.start الصندوق الأسود. كل دور يُفرض عليه
 * permissionMode=plan، وأي permission_request يُرفض آلياً (ميزانية إذن صفرية).
 * التخزين حيّ داخل العملية فقط: حالات، خلاصة، مصادر وكلفة؛ لا transcript ولا قرص.
 */

'use strict';

const path = require('path');

const MAX_AGENTS = 3;
const MAX_QUESTION_CHARS = 4000;
const MAX_SUMMARY_CHARS = 12000;
const MAX_SOURCES = 24;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 180000;
const MAX_RUNS = 10;
const SAFE_RUN_ID = /^research-[a-z0-9-]{6,80}$/;
const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped']);
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob']);
const RESEARCH_LENSES = [
  'حلّل بنية المشروع وحدد الملفات والرموز الأكثر صلة بالسؤال.',
  'ابحث عن أدلة مباشرة ومصادر داخل المستودع تؤيد الإجابة أو تنفيها.',
  'راجع المخاطر والحالات الحدّية والتناقضات المحتملة في الأدلة.',
];

let globalSequence = 0;

function defaultResolveEngine(name) {
  if (name === 'sdk') return require('./agent');
  return require('./adapters').get(name);
}

function cleanText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function safeRelative(cwd, value) {
  let raw = cleanText(value, 512);
  if (!raw) return '';
  const lineMatch = raw.match(/^(.*?):(\d{1,7})$/);
  const line = lineMatch ? Number(lineMatch[2]) : null;
  if (lineMatch) raw = lineMatch[1];
  let relative;
  if (path.isAbsolute(raw)) {
    const root = path.resolve(cwd);
    const absolute = path.resolve(raw);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (absolute !== root && !absolute.startsWith(prefix)) return '';
    relative = path.relative(root, absolute);
  } else {
    relative = raw.replace(/\\/g, '/');
  }
  const parts = relative.replace(/\\/g, '/').split('/');
  if (!relative || parts.includes('..') || parts.includes('')) return '';
  const normalized = parts.join('/').slice(0, 512);
  return line ? normalized + ':' + line : normalized;
}

function addSource(worker, cwd, value) {
  const source = safeRelative(cwd, value);
  if (!source || worker._sourceSet.has(source) || worker.sources.length >= MAX_SOURCES) return false;
  worker._sourceSet.add(source);
  worker.sources.push(source);
  return true;
}

function collectTextSources(worker, cwd, text) {
  const input = String(text || '');
  const quoted = input.match(/`([^`\r\n]{1,520})`/g) || [];
  for (const token of quoted) addSource(worker, cwd, token.slice(1, -1));
  const paths = input.match(/(?:^|\s)([\p{L}\p{N}_.@-]+(?:[/\\][\p{L}\p{N}_.@-]+)+(?::\d{1,7})?)/gu) || [];
  for (const token of paths) addSource(worker, cwd, token.trim());
}

function collectAssistant(worker, cwd, event) {
  const blocks = event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.phase !== 'commentary') {
      const text = cleanText(block.text, MAX_SUMMARY_CHARS);
      if (text) worker._texts.push(text);
      collectTextSources(worker, cwd, text);
    } else if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
      const tool = String(block.name || '').toLowerCase();
      if (tool === 'read') addSource(worker, cwd, block.input.file_path || block.input.path);
      else if (tool === 'grep') addSource(worker, cwd, block.input.path);
    }
  }
}

function forbiddenTool(event) {
  const blocks = event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
  for (const block of blocks) {
    if (!block || block.type !== 'tool_use') continue;
    const name = String(block.name || '').toLowerCase();
    if (!READ_ONLY_TOOLS.has(name)) return String(block.name || 'unknown');
  }
  return '';
}

function researchPrompt(question, lens, index, count) {
  return [
    '[مهمة بحث قراءة فقط داخل سطر]',
    'أنت باحث رقم ' + (index + 1) + ' من ' + count + '. لا تعدّل أي ملف، لا تنفّذ أوامر، لا تفتح متصفحاً، ولا تطلب إذناً.',
    'استخدم أدوات القراءة فقط مثل Read/Grep/Glob. إن احتجت كتابة أو تنفيذ فتوقف واشرح أن ذلك خارج النطاق.',
    lens,
    'السؤال: ' + question,
    '',
    'اختم بإجابة عربية موجزة، ثم قسم «المصادر» بمسارات المشروع النسبية وأرقام الأسطر إن أمكن.',
  ].join('\n');
}

function workerPublic(worker) {
  return {
    id: worker.id,
    label: worker.label,
    state: worker.state,
    summary: worker.summary,
    sources: worker.sources.slice(),
    error: worker.error,
    permission_denied: worker.permission_denied,
    duration_ms: worker.duration_ms,
    cost: { ...worker.cost },
  };
}

function runPublic(run) {
  return {
    id: run.id,
    type: 'research_update',
    schema_version: 1,
    state: run.state,
    question: run.question,
    engine: run.engine,
    created_at: run.created_at,
    updated_at: run.updated_at,
    duration_ms: run.duration_ms,
    summary: run.summary,
    sources: run.sources.slice(),
    cost: { ...run.cost },
    workers: run.workers.map(workerPublic),
  };
}

function create(options) {
  const settings = options || {};
  const resolveEngine = typeof settings.resolveEngine === 'function' ? settings.resolveEngine : defaultResolveEngine;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const configuredTimeout = Math.max(10, Math.min(Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const runs = new Map();
  let activeRunId = null;

  function publish(run) {
    run.updated_at = now();
    if (typeof run._emit === 'function') run._emit({ type: 'research_update', run: runPublic(run) });
  }

  function sourceCost(worker, event) {
    if (!event || event.type !== 'result') return;
    const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
    worker.cost = {
      usd: Math.max(0, Number(event.total_cost_usd) || 0),
      input_tokens: Math.max(0, Number(usage.input_tokens) || 0),
      output_tokens: Math.max(0, Number(usage.output_tokens) || 0),
      estimate: usage.estimate === true,
    };
  }

  function runWorker(run, worker, runner, timeoutMs) {
    return new Promise((resolve) => {
      let finished = false;
      let handle = null;
      const pendingDenials = [];
      const startedAt = now();

      function finish(state, error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.state = state;
        worker.error = cleanText(error, 500);
        worker.duration_ms = Math.max(0, now() - startedAt);
        const combined = worker._texts.join('\n\n').trim();
        worker.summary = cleanText(combined || worker._resultText, MAX_SUMMARY_CHARS);
        worker._cancel = null;
        worker._handle = null;
        publish(run);
        resolve();
      }

      function stopHandle() {
        if (handle && typeof handle.stop === 'function') Promise.resolve(handle.stop()).catch(() => {});
      }

      const timer = setTimeout(() => {
        stopHandle();
        finish('timed_out', 'انتهت مهلة الباحث');
      }, timeoutMs);

      worker._cancel = () => {
        stopHandle();
        finish('stopped', 'أوقف المستخدم فريق البحث');
      };
      worker.state = 'running';
      publish(run);

      const onEvent = (event) => {
        if (finished || !event || typeof event !== 'object') return;
        if (event.type === 'permission_request') {
          worker.permission_denied++;
          if (handle && typeof handle.resolvePermission === 'function') handle.resolvePermission(event.id, false, false);
          else pendingDenials.push(event.id);
          publish(run);
          return;
        }
        if (event.type === 'file_edit' || event.type === 'model_term' || event.type === 'verification_result') {
          stopHandle();
          finish('failed', 'أوقف المنسّق حدثاً غير مسموح في وضع البحث');
          return;
        }
        if (event.type === 'assistant') {
          const forbidden = forbiddenTool(event);
          if (forbidden) {
            stopHandle();
            finish('failed', 'أوقف المنسّق أداة غير مسموحة في البحث: ' + forbidden);
            return;
          }
          const before = worker.sources.length;
          collectAssistant(worker, run._cwd, event);
          if (worker.sources.length !== before) publish(run);
        } else if (event.type === 'result') {
          sourceCost(worker, event);
          worker._resultText = cleanText(event.result, MAX_SUMMARY_CHARS);
        } else if (event.type === 'spawn_error' || event.type === 'stderr') {
          worker._diagnostics.push(cleanText(event.text, 500));
        } else if (event.type === 'proc_done') {
          if (run._stopRequested) finish('stopped', 'أوقف المستخدم فريق البحث');
          else if (event.code === 0) finish('completed', '');
          else finish('failed', worker._diagnostics.join(' | ') || 'فشل الباحث');
        }
      };

      Promise.resolve(runner.start({
        prompt: researchPrompt(run.question, worker._lens, worker._index, run.workers.length),
        images: [],
        sessionId: null,
        model: cleanText(runner && runner.model, 64) || null,
        permissionMode: 'plan',
        skills: [],
        effort: 'low',
        extraDirs: [],
        browserControl: false,
      }, run._cwd, onEvent)).then((started) => {
        handle = started;
        worker._handle = started;
        for (const id of pendingDenials.splice(0)) {
          if (handle && typeof handle.resolvePermission === 'function') handle.resolvePermission(id, false, false);
        }
        if (finished) stopHandle();
      }).catch((error) => finish('failed', String((error && error.message) || error)));
    });
  }

  function finalize(run) {
    const completed = run.workers.filter((worker) => worker.state === 'completed');
    if (run._stopRequested) run.state = 'stopped';
    else if (completed.length) run.state = 'completed';
    else if (run.workers.some((worker) => worker.state === 'timed_out')) run.state = 'timed_out';
    else run.state = 'failed';
    run.duration_ms = Math.max(0, now() - run.created_at);
    run.summary = completed.map((worker) => '### ' + worker.label + '\n' + (worker.summary || '(بلا خلاصة)')).join('\n\n').slice(0, MAX_SUMMARY_CHARS * MAX_AGENTS);
    const seen = new Set();
    run.sources = [];
    for (const worker of run.workers) {
      for (const source of worker.sources) {
        if (!seen.has(source) && run.sources.length < MAX_SOURCES * MAX_AGENTS) {
          seen.add(source);
          run.sources.push(source);
        }
      }
    }
    run.cost = run.workers.reduce((total, worker) => ({
      usd: total.usd + worker.cost.usd,
      input_tokens: total.input_tokens + worker.cost.input_tokens,
      output_tokens: total.output_tokens + worker.cost.output_tokens,
      estimate: total.estimate || worker.cost.estimate,
    }), { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false });
    activeRunId = activeRunId === run.id ? null : activeRunId;
    publish(run);
  }

  function start(input, cwd, emit) {
    const info = input || {};
    const question = cleanText(info.question, MAX_QUESTION_CHARS);
    const count = Math.max(1, Math.min(Number.isInteger(info.count) ? info.count : 1, MAX_AGENTS));
    const engineName = cleanText(info.engine, 32) || 'sdk';
    if (!question || typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_input' };
    if (activeRunId) return { ok: false, error: 'busy' };
    const runner = resolveEngine(engineName);
    if (!runner || typeof runner.start !== 'function') return { ok: false, error: 'engine_unavailable' };
    const createdAt = now();
    const run = {
      id: 'research-' + createdAt.toString(36) + '-' + (++globalSequence).toString(36),
      state: 'running',
      question,
      engine: engineName,
      created_at: createdAt,
      updated_at: createdAt,
      duration_ms: 0,
      summary: '',
      sources: [],
      cost: { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false },
      workers: Array.from({ length: count }, (_, index) => ({
        id: 'researcher-' + (index + 1),
        label: 'باحث ' + (index + 1),
        state: 'queued',
        summary: '',
        sources: [],
        error: '',
        permission_denied: 0,
        duration_ms: 0,
        cost: { usd: 0, input_tokens: 0, output_tokens: 0, estimate: false },
        _index: index,
        _lens: RESEARCH_LENSES[index],
        _sourceSet: new Set(),
        _texts: [],
        _resultText: '',
        _diagnostics: [],
        _handle: null,
        _cancel: null,
      })),
      _cwd: path.resolve(cwd),
      _emit: emit,
      _stopRequested: false,
    };
    runs.set(run.id, run);
    while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
    activeRunId = run.id;
    publish(run);
    Promise.all(run.workers.map((worker) => runWorker(run, worker, runner, configuredTimeout)))
      .then(() => finalize(run)).catch(() => finalize(run));
    return { ok: true, run: runPublic(run) };
  }

  function stop(runId) {
    if (!SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
    const run = runs.get(runId);
    if (!run) return { ok: false, error: 'not_found' };
    if (TERMINAL_STATES.has(run.state)) return { ok: true, run: runPublic(run) };
    run._stopRequested = true;
    run.state = 'stopped';
    for (const worker of run.workers) if (typeof worker._cancel === 'function') worker._cancel();
    publish(run);
    return { ok: true, run: runPublic(run) };
  }

  function stopAll() {
    if (activeRunId) return stop(activeRunId);
    return { ok: true, run: null };
  }

  function latest(cwd) {
    const run = [...runs.values()].slice(-1)[0];
    if (run && typeof cwd === 'string' && cwd.trim() && path.resolve(cwd) !== run._cwd) return null;
    return run ? runPublic(run) : null;
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
  MAX_AGENTS,
  DEFAULT_TIMEOUT_MS,
  MAX_SUMMARY_CHARS,
  MAX_SOURCES,
};
