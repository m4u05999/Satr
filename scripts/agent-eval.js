#!/usr/bin/env node
'use strict';

/**
 * مرصد واختبارات وكيل «سطر».
 *
 * الوضع الافتراضي replay حتمي وبلا شبكة: ينفّذ سيناريوهات fixtures عبر أدوات «سطر»
 * الفعلية ويتحقق من عقد الأحداث والملفات. الوضع live اختياري ويشغّل محرك sdk أو codex
 * المثبّت محلياً. التقارير تحفظ hashes وmetadata فقط؛ المحتوى الحساس لا يُحفظ إلا
 * عند تمرير --include-sensitive صراحةً.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const tools = require('../electron/tools');
const term = require('../electron/term');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TASKS = path.join(__dirname, 'evals', 'tasks.json');
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, 'dist', 'agent-eval');
const TRACE_VERSION = 1;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const FORBIDDEN_BROWSER_TOOLS = new Set([
  'open_preview', 'read_page', 'browser_readability', 'screenshot', 'browser_click', 'browser_type',
  'browser_snapshot', 'browser_navigate', 'browser_wait_for',
]);
const EVENT_TYPES = new Set([
  'system', 'assistant', 'user', 'stream_text', 'result', 'permission_request',
  'file_edit', 'proc_done', 'stderr', 'spawn_error', 'model_term', 'stopped',
]);

function parseArgs(argv) {
  const out = {
    mode: 'replay', engine: 'replay', tasksFile: DEFAULT_TASKS,
    outputRoot: DEFAULT_OUTPUT_ROOT, taskIds: [], includeSensitive: false,
    approveWrites: false, approveExec: false, report: '', model: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') out.mode = String(argv[++i] || '');
    else if (arg === '--engine') out.engine = String(argv[++i] || '');
    else if (arg === '--tasks') out.tasksFile = path.resolve(argv[++i] || '');
    else if (arg === '--output') out.outputRoot = path.resolve(argv[++i] || '');
    else if (arg === '--task') out.taskIds.push(String(argv[++i] || ''));
    else if (arg === '--report') out.report = path.resolve(argv[++i] || '');
    else if (arg === '--model') out.model = String(argv[++i] || '');
    else if (arg === '--include-sensitive') out.includeSensitive = true;
    else if (arg === '--approve-writes') out.approveWrites = true;
    else if (arg === '--approve-exec') out.approveExec = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('وسيطة غير معروفة: ' + arg);
  }
  if (!['replay', 'live'].includes(out.mode)) throw new Error('--mode يجب أن يكون replay أو live');
  if (out.mode === 'replay') out.engine = 'replay';
  if (out.mode === 'live' && !['sdk', 'codex'].includes(out.engine)) {
    throw new Error('الوضع live يتطلب --engine sdk أو --engine codex');
  }
  return out;
}

function usage() {
  return [
    'الاستخدام:',
    '  node scripts/agent-eval.js',
    '  node scripts/agent-eval.js --task read-file --report docs/AGENT-EVAL-BASELINE.md',
    '  node scripts/agent-eval.js --mode live --engine codex --task read-file',
    '',
    'الخيارات:',
    '  --mode replay|live       replay افتراضي وحتمي بلا شبكة',
    '  --engine sdk|codex       مطلوب في live',
    '  --task <id>              يمكن تكراره لاختيار مهام',
    '  --approve-writes         موافقة صريحة لكتابات live',
    '  --approve-exec           موافقة صريحة لأوامر live',
    '  --include-sensitive      يحفظ النصوص والمدخلات في trace (غير موصى به)',
    '  --output <dir>           جذر مخرجات JSON (الافتراضي dist/agent-eval)',
    '  --report <file>          تقرير Markdown مختصر بلا prompts',
  ].join('\n');
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value), 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function digestValue(value, includeSensitive) {
  const stable = JSON.stringify(stableValue(value));
  const out = { sha256: sha256(stable), bytes: byteLength(stable) };
  if (includeSensitive) out.value = value;
  return out;
}

function digestText(value, includeSensitive) {
  const text = String(value || '');
  const out = { sha256: sha256(text), bytes: byteLength(text) };
  if (includeSensitive) out.text = text;
  return out;
}

function summarizeBlock(block, includeSensitive) {
  if (!block || typeof block !== 'object') return { type: 'invalid' };
  const out = { type: String(block.type || 'unknown') };
  if (block.id != null) out.id = String(block.id);
  if (block.name != null) out.name = String(block.name);
  if (block.tool_use_id != null) out.tool_use_id = String(block.tool_use_id);
  if (block.is_error != null) out.is_error = !!block.is_error;
  if (block.phase != null) out.phase = String(block.phase);
  if (typeof block.text === 'string') out.text = digestText(block.text, includeSensitive);
  if (block.input && typeof block.input === 'object') {
    out.input = digestValue(block.input, includeSensitive);
    out.input.keys = Object.keys(block.input).sort();
  }
  return out;
}

function summarizeEvent(event, seq, includeSensitive) {
  const out = { seq, type: String(event.type || '') };
  for (const key of ['subtype', 'phase', 'tool', 'id', 'session_id', 'code', 'is_error']) {
    if (event[key] != null) out[key] = event[key];
  }
  if (typeof event.text === 'string') out.text = digestText(event.text, includeSensitive);
  if (event.input && typeof event.input === 'object') {
    out.input = digestValue(event.input, includeSensitive);
    out.input.keys = Object.keys(event.input).sort();
  }
  const content = event.message && Array.isArray(event.message.content) ? event.message.content : null;
  if (content) out.content = content.map((block) => summarizeBlock(block, includeSensitive));
  if (event.type === 'file_edit') {
    const rel = String(event.rel || '');
    out.path = includeSensitive ? { value: rel, sha256: sha256(rel) } : { sha256: sha256(rel) };
    for (const key of ['tool', 'isNew', 'isDelete', 'added', 'removed', 'truncated']) {
      if (event[key] != null) out[key] = event[key];
    }
  }
  if (event.type === 'result') {
    for (const key of ['duration_ms', 'num_turns', 'provider']) {
      if (event[key] != null) out[key] = event[key];
    }
    if (typeof event.result === 'string') out.result = digestText(event.result, includeSensitive);
  }
  return out;
}

function validateEvent(event, state) {
  if (!event || typeof event !== 'object') throw new Error('حدث غير كائن');
  if (!EVENT_TYPES.has(event.type)) throw new Error('نوع حدث غير معروف: ' + String(event.type));
  if (event.type === 'stream_text' && typeof event.text !== 'string') throw new Error('stream_text بلا text');
  if (event.type === 'assistant') {
    if (!event.message || !Array.isArray(event.message.content)) throw new Error('assistant بلا content[]');
    for (const block of event.message.content) {
      if (!block || typeof block.type !== 'string') throw new Error('كتلة assistant غير صالحة');
      if (block.type === 'tool_use') {
        if (!block.id || !block.name) throw new Error('tool_use بلا id/name');
        state.toolUses.add(String(block.id));
        if (FORBIDDEN_BROWSER_TOOLS.has(String(block.name))) state.browserViolations.push(String(block.name));
      }
    }
  }
  if (event.type === 'user') {
    if (!event.message || !Array.isArray(event.message.content)) throw new Error('user بلا content[]');
    for (const block of event.message.content) {
      if (block.type === 'tool_result' && !state.toolUses.has(String(block.tool_use_id))) {
        throw new Error('tool_result بلا tool_use سابق: ' + String(block.tool_use_id));
      }
    }
  }
  if (event.type === 'permission_request' && (!event.id || !event.tool)) {
    throw new Error('permission_request بلا id/tool');
  }
  if (event.type === 'proc_done') state.procDone = true;
}

function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw new Error('مسار fixture غير صالح');
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) throw new Error('مسار fixture خارج الجذر');
  const absolute = path.resolve(root, normalized);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(prefix)) throw new Error('مسار fixture خارج الجذر');
  return absolute;
}

function materializeFile(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object' && typeof spec.repeat === 'string' && Number.isInteger(spec.count)) {
    if (spec.count < 0 || spec.count > 100000) throw new Error('repeat count خارج الحد');
    return spec.repeat.repeat(spec.count);
  }
  throw new Error('محتوى fixture غير صالح');
}

async function prepareWorkspace(task, tempRoot) {
  const workspace = path.join(tempRoot, task.id);
  await fsp.mkdir(workspace, { recursive: true });
  const files = task.fixture && task.fixture.files ? task.fixture.files : {};
  for (const [rel, spec] of Object.entries(files)) {
    const absolute = resolveInside(workspace, rel);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, materializeFile(spec), 'utf8');
  }
  return workspace;
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); resolve(false); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function createRecorder(task, engine, mode, includeSensitive) {
  const started = Date.now();
  const state = {
    toolUses: new Set(), browserViolations: [], procDone: false,
    rawEvents: [], traceEvents: [], toolResults: new Map(), sessions: new Map(),
    sessionResumed: false, interrupted: false, contractErrors: [],
  };
  function emit(event) {
    try { validateEvent(event, state); } catch (error) { state.contractErrors.push(error.message); }
    state.rawEvents.push(event);
    state.traceEvents.push(summarizeEvent(event, state.traceEvents.length + 1, includeSensitive));
  }
  function trace(status, errors) {
    const prompt = digestText(task.prompt, includeSensitive);
    return {
      schema_version: TRACE_VERSION,
      task: { id: task.id, title: task.title, tags: task.tags || [] },
      run: {
        mode, engine, platform: process.platform, arch: process.arch,
        node: process.version, started_at: new Date(started).toISOString(),
        duration_ms: Date.now() - started, status,
      },
      prompt,
      privacy: {
        sensitive_content_included: includeSensitive,
        default_policy: 'hashes-and-metadata',
      },
      metrics: {
        events: state.traceEvents.length,
        tool_calls: state.toolUses.size,
        permission_requests: state.rawEvents.filter((event) => event.type === 'permission_request').length,
        file_edits: state.rawEvents.filter((event) => event.type === 'file_edit').length,
      },
      errors,
      events: state.traceEvents,
    };
  }
  return { state, emit, trace };
}

async function runToolAction(action, workspace, recorder) {
  const id = String(action.id || ('eval-tool-' + (recorder.state.toolUses.size + 1)));
  const args = action.args && typeof action.args === 'object' ? action.args : {};
  recorder.emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: action.name, input: args }] },
  });
  const tier = tools.permissionTier(action.name);
  let output;
  if (tier) {
    recorder.emit({ type: 'permission_request', id, tool: action.name, input: args });
    if (action.permission !== 'allow') {
      output = { ok: false, content: 'رفض المستخدم هذا الإجراء' };
    } else if (action.name === 'run_command' && action.replay_executor === 'process') {
      output = await runReplayCommand(args.command, workspace, args.timeout_seconds);
    } else {
      output = await tools.run(action.name, workspace, args, { emit: recorder.emit, id });
    }
  } else {
    output = await tools.run(action.name, workspace, args, { emit: recorder.emit, id });
  }
  recorder.state.toolResults.set(id, output);
  recorder.emit({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !output.ok }] },
  });
}

function runReplayCommand(command, cwd, timeoutSeconds) {
  return new Promise((resolve) => {
    if (typeof command !== 'string' || !command.trim()) {
      resolve({ ok: false, content: 'خطأ: أمر replay فارغ' });
      return;
    }
    const isWindows = process.platform === 'win32';
    const executable = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const args = isWindows
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-lc', command];
    const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || 20, 1), 60) * 1000;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve({ ok: false, content: 'خطأ: تعذّر تشغيل أمر replay: ' + error.message });
      return;
    }
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(0, 512 * 1024);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish({ ok: false, content: 'خطأ: ' + error.message }));
    child.on('close', (code) => {
      const body = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      finish({
        ok: code === 0,
        content: 'exit code: ' + String(code) + '\n---\n' + (body || '(لا خرج)'),
      });
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, content: 'خطأ: انتهت مهلة أمر replay' });
    }, timeoutMs);
  });
}

async function runReplay(task, workspace, options) {
  const recorder = createRecorder(task, 'replay', 'replay', options.includeSensitive);
  const controller = new AbortController();
  let interruptTimer = null;
  const sessionId = 'eval-' + task.id;
  recorder.emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'deterministic-replay' });
  if (Number.isInteger(task.interrupt_after_ms)) {
    interruptTimer = setTimeout(() => controller.abort(), task.interrupt_after_ms);
  }
  try {
    for (const action of task.replay || []) {
      if (controller.signal.aborted) break;
      if (action.type === 'tool') await runToolAction(action, workspace, recorder);
      else if (action.type === 'delay') await delay(action.ms, controller.signal);
      else if (action.type === 'assistant_text') {
        recorder.emit({ type: 'stream_text', text: action.text, phase: action.phase || 'final_answer' });
        recorder.emit({
          type: 'assistant',
          message: { content: [{ type: 'text', text: action.text, phase: action.phase || 'final_answer' }] },
        });
      } else if (action.type === 'session_save') {
        recorder.state.sessions.set(action.session_id, Array.isArray(action.messages) ? action.messages.slice() : []);
      } else if (action.type === 'session_resume') {
        const history = recorder.state.sessions.get(action.session_id);
        if (!history) throw new Error('جلسة replay غير موجودة: ' + action.session_id);
        recorder.state.sessionResumed = true;
        recorder.emit({ type: 'system', subtype: 'init', session_id: action.session_id, model: 'deterministic-replay' });
      } else {
        throw new Error('نوع action غير معروف: ' + String(action.type));
      }
    }
    if (controller.signal.aborted) {
      recorder.state.interrupted = true;
      recorder.emit({ type: 'stopped' });
      recorder.emit({ type: 'result', subtype: 'interrupted', session_id: sessionId, is_error: true });
      recorder.emit({ type: 'proc_done', code: 130 });
    } else {
      recorder.emit({ type: 'result', session_id: sessionId, is_error: false });
      recorder.emit({ type: 'proc_done', code: 0 });
    }
  } finally {
    if (interruptTimer) clearTimeout(interruptTimer);
  }
  return recorder;
}

async function runLive(task, workspace, options) {
  if (task.live === false) return { skipped: 'المهمة replay-only' };
  const recorder = createRecorder(task, options.engine, 'live', options.includeSensitive);
  const engine = options.engine === 'sdk' ? require('../electron/agent') : require('../electron/codex');
  let handle = null;
  let finishRun;
  const done = new Promise((resolve) => { finishRun = resolve; });
  let stoppedForBrowser = false;

  const emit = (event) => {
    recorder.emit(event);
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && FORBIDDEN_BROWSER_TOOLS.has(block.name)) stoppedForBrowser = true;
      }
    }
    if (event.type === 'preview_open') stoppedForBrowser = true;
    if (stoppedForBrowser && handle) handle.stop().catch(() => {});
    if (event.type === 'permission_request') {
      const tier = tools.permissionTier(event.tool);
      const allow = tier === 'write' ? options.approveWrites : tier === 'exec' ? options.approveExec : false;
      queueMicrotask(() => { if (handle && handle.resolvePermission) handle.resolvePermission(event.id, allow, false); });
    }
    if (event.type === 'proc_done') finishRun();
  };

  const input = {
    prompt: task.prompt, sessionId: null, model: options.model || null,
    permissionMode: 'default', images: [], skills: [], effort: null, extraDirs: [],
  };
  handle = await engine.start(input, workspace, emit);
  const timeout = setTimeout(() => {
    if (handle && handle.stop) handle.stop().catch(() => {});
    recorder.state.contractErrors.push('انتهت مهلة live');
    finishRun();
  }, task.live_timeout_ms || RUN_TIMEOUT_MS);
  await done;
  clearTimeout(timeout);
  if (stoppedForBrowser) recorder.state.contractErrors.push('استُدعيت أداة browser محظورة في هذه الدفعة');
  return recorder;
}

function orderedSubset(actual, expected) {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) index++;
    if (index === expected.length) return true;
  }
  return expected.length === 0;
}

async function verifyTask(task, workspace, recorder, mode) {
  const errors = recorder.state.contractErrors.slice();
  if (recorder.state.browserViolations.length) {
    errors.push('أدوات browser محظورة: ' + recorder.state.browserViolations.join(', '));
  }
  const expected = task.expected || {};
  for (const file of expected.files || []) {
    const absolute = resolveInside(workspace, file.path);
    const exists = fs.existsSync(absolute);
    if (file.absent) {
      if (exists) errors.push('كان يجب ألا يوجد الملف: ' + file.path);
      continue;
    }
    if (!exists) {
      errors.push('الملف المتوقع غير موجود: ' + file.path);
      continue;
    }
    const actual = await fsp.readFile(absolute, 'utf8');
    const wanted = materializeFile(file.content);
    if (actual !== wanted) errors.push('محتوى غير مطابق: ' + file.path);
  }
  if (mode === 'replay') {
    const replay = expected.replay || {};
    const eventTypes = recorder.state.rawEvents.map((event) => event.type);
    if (replay.ordered_events && !orderedSubset(eventTypes, replay.ordered_events)) {
      errors.push('ترتيب الأحداث لا يحتوي التسلسل المتوقع: ' + replay.ordered_events.join(' → '));
    }
    for (const [type, count] of Object.entries(replay.event_counts || {})) {
      const actual = eventTypes.filter((value) => value === type).length;
      if (actual !== count) errors.push('عدد ' + type + ' المتوقع ' + count + ' والفعلي ' + actual);
    }
    for (const result of replay.tool_results || []) {
      const actual = recorder.state.toolResults.get(result.id);
      if (!actual) {
        errors.push('نتيجة أداة مفقودة: ' + result.id);
        continue;
      }
      if (typeof result.ok === 'boolean' && actual.ok !== result.ok) errors.push('حالة أداة غير مطابقة: ' + result.id);
      if (result.contains && !String(actual.content).includes(result.contains)) errors.push('ناتج الأداة لا يحوي النص المتوقع: ' + result.id);
      if (Number.isInteger(result.max_bytes) && byteLength(actual.content) > result.max_bytes) errors.push('ناتج الأداة تجاوز السقف: ' + result.id);
    }
    if (typeof replay.interrupted === 'boolean' && recorder.state.interrupted !== replay.interrupted) {
      errors.push('حالة المقاطعة غير مطابقة');
    }
    if (typeof replay.session_resumed === 'boolean' && recorder.state.sessionResumed !== replay.session_resumed) {
      errors.push('حالة استئناف الجلسة غير مطابقة');
    }
  }
  return errors;
}

function validateTasks(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.tasks)) throw new Error('ملف المهام غير صالح');
  const ids = new Set();
  for (const task of document.tasks) {
    if (!task || !/^[a-z0-9-]{2,64}$/.test(task.id || '')) throw new Error('معرّف مهمة غير صالح');
    if (ids.has(task.id)) throw new Error('معرّف مهمة مكرر: ' + task.id);
    ids.add(task.id);
    if (typeof task.title !== 'string' || typeof task.prompt !== 'string') throw new Error('مهمة بلا title/prompt: ' + task.id);
    if (!Array.isArray(task.replay)) throw new Error('مهمة بلا replay: ' + task.id);
    for (const action of task.replay) {
      if (action.type === 'tool' && FORBIDDEN_BROWSER_TOOLS.has(action.name)) {
        throw new Error('مهمة تستعمل browser المحظور: ' + task.id);
      }
      if (action.type === 'tool' && action.name === 'run_command' && action.replay_executor !== 'process') {
        throw new Error('أوامر replay يجب أن تستعمل executor حتمياً: ' + task.id);
      }
    }
  }
  if (document.tasks.length !== 12) throw new Error('baseline الضيق يجب أن يحوي 12 مهمة بالضبط');
  return document.tasks;
}

function runStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function closeModelTerminal() {
  const id = term.getModelTermId();
  if (id) {
    term.writeTerm(id, 'exit\r');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  term.killAll();
}

function markdownReport(summary) {
  const lines = [
    '# Baseline مرصد وكيل «سطر»',
    '',
    '> هذا التقرير لا يحفظ نصوص prompts أو نتائج الأدوات؛ يحفظ hashes وmetadata فقط.',
    '',
    '- التاريخ: `' + summary.started_at + '`',
    '- الوضع: `' + summary.mode + '`',
    '- المحرك: `' + summary.engine + '`',
    '- المنصة: `' + summary.platform + ' ' + summary.arch + '`',
    '- النتيجة: **' + summary.passed + '/' + summary.total + ' ناجحة**' + (summary.skipped ? '، ' + summary.skipped + ' متخطاة' : ''),
    '- سياسة الخصوصية: `hashes-and-metadata`',
    '- browser/preview: **غير مستخدم**',
    '',
    '| المهمة | الحالة | الأحداث | الأدوات | الأذونات | hash الطلب |',
    '|---|---:|---:|---:|---:|---|',
  ];
  for (const result of summary.results) {
    lines.push('| `' + result.id + '` | ' + result.status + ' | ' + result.events + ' | ' + result.tool_calls + ' | ' + result.permission_requests + ' | `' + result.prompt_sha256.slice(0, 12) + '` |');
  }
  lines.push('', 'شُغّل baseline مجدداً بالأمر:', '', '```powershell', 'npm run eval:agent', '```', '');
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const document = JSON.parse(await fsp.readFile(options.tasksFile, 'utf8'));
  let tasks = validateTasks(document);
  if (options.taskIds.length) {
    const wanted = new Set(options.taskIds);
    tasks = tasks.filter((task) => wanted.has(task.id));
    for (const id of wanted) if (!tasks.some((task) => task.id === id)) throw new Error('مهمة غير موجودة: ' + id);
  }

  const stamp = runStamp();
  const outputDir = path.join(options.outputRoot, stamp);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-agent-eval-'));
  const results = [];
  const startedAt = new Date().toISOString();
  try {
    for (const task of tasks) {
      if (Array.isArray(task.platforms) && !task.platforms.includes(process.platform)) {
        results.push({ id: task.id, status: 'متخطاة', skipped: 'المنصة', events: 0, tool_calls: 0, permission_requests: 0, prompt_sha256: sha256(task.prompt) });
        continue;
      }
      const workspace = await prepareWorkspace(task, tempRoot);
      const result = options.mode === 'replay'
        ? await runReplay(task, workspace, options)
        : await runLive(task, workspace, options);
      if (result.skipped) {
        results.push({ id: task.id, status: 'متخطاة', skipped: result.skipped, events: 0, tool_calls: 0, permission_requests: 0, prompt_sha256: sha256(task.prompt) });
        continue;
      }
      const errors = await verifyTask(task, workspace, result, options.mode);
      const status = errors.length ? 'فاشلة' : 'ناجحة';
      const trace = result.trace(status, errors);
      const serialized = JSON.stringify(trace);
      if (!options.includeSensitive && serialized.includes(task.prompt)) {
        errors.push('خرق الخصوصية: حُفظ prompt كاملاً في trace');
        trace.errors = errors;
        trace.run.status = 'فاشلة';
      }
      await writeJson(path.join(outputDir, task.id + '.json'), trace);
      results.push({
        id: task.id, status: errors.length ? 'فاشلة' : 'ناجحة', errors,
        events: trace.metrics.events, tool_calls: trace.metrics.tool_calls,
        permission_requests: trace.metrics.permission_requests,
        prompt_sha256: trace.prompt.sha256,
      });
      process.stdout.write((errors.length ? '✗ ' : '✓ ') + task.id + (errors.length ? ': ' + errors.join('؛ ') : '') + '\n');
    }
  } finally {
    await closeModelTerminal();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }

  const summary = {
    schema_version: TRACE_VERSION, started_at: startedAt,
    mode: options.mode, engine: options.engine, platform: process.platform,
    arch: process.arch, node: process.version,
    total: results.length,
    passed: results.filter((result) => result.status === 'ناجحة').length,
    failed: results.filter((result) => result.status === 'فاشلة').length,
    skipped: results.filter((result) => result.status === 'متخطاة').length,
    privacy: 'hashes-and-metadata', results,
  };
  await writeJson(path.join(outputDir, 'summary.json'), summary);
  if (options.report) {
    await fsp.mkdir(path.dirname(options.report), { recursive: true });
    await fsp.writeFile(options.report, markdownReport(summary), 'utf8');
  }
  process.stdout.write('\nالنتيجة: ' + summary.passed + '/' + summary.total + ' ناجحة؛ المخرجات: ' + path.relative(ROOT, outputDir) + '\n');
  if (summary.failed || summary.skipped) process.exitCode = 1;
}

main().catch((error) => {
  term.killAll();
  console.error('فشل مرصد الوكيل:', (error && error.stack) || error);
  process.exitCode = 1;
});
