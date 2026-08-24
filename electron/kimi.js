/**
 * سطر — محرك Kimi Code الأصيل عبر ACP.
 *
 * يشغّل `kimi acp` كعملية JSON-RPC فوق stdio، ويطبّع الجلسات والبث والأدوات والأذونات
 * إلى عقد أحداث «سطر». يظل محوّل Kimi REST منفصلاً كخيار احتياطي بمفتاح API.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const browserorigin = require('./browserorigin');
const browserpolicy = require('./browserpolicy');
const codexmcp = require('./codexmcp');
const { computeDiff } = require('./diff');
const envbrief = require('./envbrief');
const execguard = require('./execguard');
const memory = require('./memory');
const preview = require('./preview');
const skillCatalog = require('./skills');
const agentTools = require('./tools');
const termjobs = require('./termjobs'); // مهام الخلفية المعمّرة — كتلة «انتهت بلا دور نشط»
const { isExternalBrowserLaunchCommand, promptRequestsExternalBrowser } = require('./browserguard');
const keepaliveFactory = require('./kimi-keepalive');
const { scrubSecrets } = require('./secretscrub');

const ENGINE_ID = 'kimi-code';
const DEFAULT_MODEL = 'k3';
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RPC_LINE = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_TEXT = 20000;
const MAX_SESSIONS = 200;
const MAX_MESSAGES = 120;
const SATR_TOOL_NAMES = Object.freeze([
  'verification_config', 'verify_project', 'update_task_ledger',
  'propose_memory', 'load_skill', 'read_skill_resource',
]);
const EMBEDDED_MCP_TOOL_NAMES = new Set(codexmcp.buildTools({ preview }).map((tool) => tool.name));
// تسميات عربية لأدوات Kimi الداخلية المعروفة (قاعدة «العربية أولاً»). تُطبَّق على
// العنوان الأولي لـ tool_call فقط؛ عناوين tool_call_update الحرة (مثل «Listing
// scheduled cron jobs») نص حر من Kimi وتُعرض كما هي.
const KIMI_TOOL_LABELS = Object.freeze({
  Agent: 'وكيل فرعي',
  AgentSwarm: 'سرب وكلاء',
  CronCreate: 'إنشاء تذكير مجدول',
  CronList: 'عرض المهام المجدولة',
  CronDelete: 'حذف مهمة مجدولة',
  TaskList: 'المهام الخلفية',
  TaskOutput: 'مخرجات مهمة',
  TaskStop: 'إيقاف مهمة',
  TodoList: 'قائمة المهام',
  CreateGoal: 'إنشاء هدف',
  UpdateGoal: 'تحديث الهدف',
  GetGoal: 'حالة الهدف',
  SetGoalBudget: 'ميزانية الهدف',
  AskUserQuestion: 'سؤال للمستخدم',
  Skill: 'مهارة',
  WebSearch: 'بحث ويب',
  FetchURL: 'جلب صفحة',
  ReadMediaFile: 'قراءة وسائط',
  Bash: 'تنفيذ أمر',
  Read: 'قراءة ملف',
  Edit: 'تعديل ملف',
  Write: 'كتابة ملف',
  Glob: 'بحث عن ملفات',
  Grep: 'بحث في المحتوى',
});

function toolLabel(title) {
  return KIMI_TOOL_LABELS[title] || title;
}

function isEmbeddedMcpTool(tool, mcpHost) {
  if (!mcpHost || !tool) return false;
  const title = String(tool.title || '');
  const prefix = 'mcp__satr__';
  return title.startsWith(prefix) && EMBEDDED_MCP_TOOL_NAMES.has(title.slice(prefix.length));
}
const IS_WIN = process.platform === 'win32';
const APP_VERSION = (() => {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

const editSnapshots = new Map();
const alwaysAllowed = new Set();
let kimiBinResolved;

function publicInfo() {
  return {
    name: ENGINE_ID,
    label: 'Kimi Code — أصلي (ACP)',
    family: 'kimi-native',
    keyName: '',
    capabilities: {
      native: true, vision: true, sessions: true, browser: true,
      contextUsage: true, compact: true, effort: false, keepalive: true,
    },
    models: [{ value: DEFAULT_MODEL, label: 'K3 — عبر اشتراك Kimi Code' }],
  };
}

function fileExists(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function pathExists(candidate) {
  try { fs.statSync(candidate); return true; } catch { return false; }
}

function resolveKimiBin(force) {
  if (!force && kimiBinResolved !== undefined) return kimiBinResolved;
  const candidates = [];
  if (process.env.KIMI_BIN) candidates.push(process.env.KIMI_BIN);
  const home = os.homedir();
  if (IS_WIN) {
    candidates.push(path.join(home, '.local', 'bin', 'kimi.exe'));
    candidates.push(path.join(home, '.local', 'bin', 'kimi.cmd'));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'kimi.cmd'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'kimi-code', 'kimi.exe'));
  } else {
    candidates.push(path.join(home, '.local', 'bin', 'kimi'), '/usr/local/bin/kimi', '/usr/bin/kimi');
  }
  try {
    const found = execSync(IS_WIN ? 'where kimi' : 'which kimi', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    candidates.push(...found);
  } catch { /* غير مثبت في PATH */ }
  kimiBinResolved = candidates.find(fileExists) || null;
  return kimiBinResolved;
}

function dataRoot() {
  const configured = typeof process.env.KIMI_CODE_HOME === 'string' ? process.env.KIMI_CODE_HOME.trim() : '';
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.kimi-code');
}

function authStatus() {
  const root = dataRoot();
  try {
    const credentialDir = path.join(root, 'credentials');
    const entries = fs.readdirSync(credentialDir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
      return { ok: true, method: 'oauth' };
    }
  } catch { /* لا اعتماد OAuth */ }
  try {
    const configPath = path.join(root, 'config.toml');
    const stat = fs.statSync(configPath);
    if (stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024) {
      const config = fs.readFileSync(configPath, 'utf8');
      if (/\b(api_key|api_key_env|access_token)\s*=/i.test(config)) return { ok: true, method: 'configured' };
    }
  } catch { /* لا إعداد مزوّد */ }
  return { ok: false, method: null };
}

function spawnKimi(bin, args, options, spawnImpl) {
  const run = spawnImpl || spawn;
  if (IS_WIN && /\.(?:cmd|bat)$/i.test(bin)) {
    const command = '"' + String(bin).replace(/"/g, '""') + '" '
      + args.map((arg) => '"' + String(arg).replace(/"/g, '""') + '"').join(' ');
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], options);
  }
  return run(bin, args, options);
}

function scrubError(value) {
  return scrubStreamText(value, 4000);
}

function scrubStreamText(value, max) {
  // K5-أ: الحجب عبر البوابة المشتركة secretscrub (JWT/Bearer/PEM/AWS/GitHub/Slack
  // فوق النمطين القائمين)، والقص يبقى هنا مسؤولية المستهلك.
  const text = scrubSecrets(value);
  return max && text.length > max ? text.slice(0, max) + '…' : text;
}

function configOptionValues(option) {
  if (!option || !Array.isArray(option.options)) return [];
  return option.options.flatMap((item) => Array.isArray(item && item.options) ? item.options : [item])
    .filter((item) => item && typeof item.value === 'string');
}

function configValue(option, requested, allowSuffix) {
  if (typeof requested !== 'string' || !requested) return null;
  const values = configOptionValues(option);
  const exact = values.find((item) => item.value === requested);
  if (exact) return exact.value;
  if (!allowSuffix) return null;
  const suffix = values.find((item) => item.value.endsWith('/' + requested));
  return suffix ? suffix.value : null;
}

function parseNumber(value) {
  const parsed = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseUsageText(value) {
  const text = String(value || '');
  const context = text.match(/-\s*Context:\s*([\d,]+)\s*\/\s*([\d,]+)\s*\(([\d.]+)%\)/i);
  if (!context) return null;
  const totals = text.match(/-\s*Total:\s*input\s+([\d,]+),\s*output\s+([\d,]+),\s*cache read\s+([\d,]+),\s*cache creation\s+([\d,]+)/i);
  const modelLine = text.split(/\r?\n/).find((line) => /^-\s*[^:\n]+:\s*input\s+[\d,]+/i.test(line)
    && !/^-\s*(?:Total|Context):/i.test(line));
  const model = modelLine && modelLine.match(/^-\s*([^:\n]+):/);
  const categories = [];
  if (totals) {
    const values = [
      ['مدخلات الجلسة', totals[1]], ['مخرجات الجلسة', totals[2]],
      ['قراءة الذاكرة المخبأة', totals[3]], ['إنشاء الذاكرة المخبأة', totals[4]],
    ];
    for (const [name, raw] of values) {
      const tokens = parseNumber(raw);
      if (tokens) categories.push({ name, tokens, isDeferred: false });
    }
  }
  return {
    totalTokens: parseNumber(context[1]), maxTokens: parseNumber(context[2]),
    percentage: Number(context[3]), model: model ? model[1].trim() : '', categories,
  };
}

function parseCompactionText(value) {
  const text = String(value || '');
  const messages = text.match(/Messages compacted:\s*([\d,]+)/i);
  const before = text.match(/Tokens before:\s*([\d,]+)/i);
  const after = text.match(/Tokens after:\s*([\d,]+)/i);
  if (!before || !after) return null;
  return {
    trigger: 'manual', pre_tokens: parseNumber(before[1]), post_tokens: parseNumber(after[1]),
    messages_compacted: messages ? parseNumber(messages[1]) : null,
  };
}

function relPath(cwd, absolute) {
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/') : path.basename(absolute);
}

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return IS_WIN ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function safePlanPath(root, sessionId, requested, mustExist) {
  if (!SAFE_SESSION.test(sessionId || '') || typeof requested !== 'string' || !path.isAbsolute(requested)) return null;
  try {
    const data = fs.realpathSync(root);
    const requestedPath = path.resolve(requested);
    const planDir = fs.realpathSync(path.dirname(requestedPath));
    if (!samePath(path.dirname(requestedPath), planDir)) return null;
    const parts = path.relative(data, planDir).split(path.sep);
    if (parts.length !== 6
        || parts[0] !== 'sessions'
        || !/^wd_[A-Za-z0-9._-]{1,200}$/.test(parts[1])
        || parts[2] !== 'session_' + sessionId
        || parts[3] !== 'agents'
        || parts[4] !== 'main'
        || parts[5] !== 'plans') return null;
    const filename = path.basename(requestedPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.md$/.test(filename)) return null;
    const target = path.join(planDir, filename);
    if (!mustExist && !fileExists(target)) return target;
    const realTarget = fs.realpathSync(target);
    return samePath(realTarget, target) ? realTarget : null;
  } catch { return null; }
}

function safeExistingPath(cwd, requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) return null;
  try {
    const root = fs.realpathSync(cwd);
    const target = fs.realpathSync(requested);
    return inside(root, target) ? target : null;
  } catch { return null; }
}

function safeWritablePath(cwd, requested) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) return null;
  const root = fs.realpathSync(cwd);
  const resolved = path.resolve(requested);
  if (!inside(root, resolved)) return null;
  if (fileExists(resolved)) return safeExistingPath(cwd, resolved);
  let parent = path.dirname(resolved);
  while (!pathExists(parent)) {
    const next = path.dirname(parent);
    if (next === parent || !inside(root, next)) return null;
    parent = next;
  }
  try {
    const realParent = fs.realpathSync(parent);
    return inside(root, realParent) ? resolved : null;
  } catch { return null; }
}

function rememberSnapshot(id, filePath, before) {
  editSnapshots.set(id, { file_path: filePath, before });
  while (editSnapshots.size > 60) editSnapshots.delete(editSnapshots.keys().next().value);
}

function undoEdit(id) {
  const snapshot = editSnapshots.get(id);
  if (!snapshot) return { ok: false, error: 'expired' };
  try {
    if (snapshot.before == null) {
      try { fs.unlinkSync(snapshot.file_path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      fs.mkdirSync(path.dirname(snapshot.file_path), { recursive: true });
      fs.writeFileSync(snapshot.file_path, snapshot.before, 'utf8');
    }
    editSnapshots.delete(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: scrubError(error && error.message) };
  }
}

function safeToolInput(input) {
  if (!input || typeof input !== 'object') return {};
  function clean(value, depth) {
    if (depth > 4) return '[مقصوص]';
    if (typeof value === 'string') return scrubError(value).slice(0, 2000);
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => clean(item, depth + 1));
    if (typeof value !== 'object') return '[غير قابل للعرض]';
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
      out[key] = /api.?key|token|authorization|password|secret|cookie/i.test(key)
        ? '[secret]' : clean(child, depth + 1);
    }
    return out;
  }
  return clean(input, 0);
}

function toolText(content, rawOutput) {
  const parts = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (item && item.type === 'content' && item.content && item.content.type === 'text') parts.push(item.content.text || '');
  }
  if (!parts.length && rawOutput != null) {
    try { parts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)); } catch { /* لا شيء */ }
  }
  const text = parts.filter(Boolean).join('\n');
  return text.length > MAX_TOOL_TEXT ? text.slice(0, MAX_TOOL_TEXT) + '…' : text;
}

function mutationKind(kind) {
  return kind === 'edit' || kind === 'delete' || kind === 'move';
}

function safeReadKind(kind) {
  return kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch';
}

function questionLike(tool) {
  const title = String(tool && tool.title || '').toLowerCase();
  const input = tool && tool.rawInput;
  return /ask|question|clarif|سؤال|استفسار/.test(title)
    || !!(input && typeof input === 'object' && (input.question || Array.isArray(input.questions)));
}

function questionText(tool) {
  const input = tool && tool.rawInput;
  if (input && typeof input.question === 'string') return input.question.slice(0, 2000);
  if (input && Array.isArray(input.questions) && input.questions[0]
      && typeof input.questions[0].question === 'string') return input.questions[0].question.slice(0, 2000);
  return String(tool && tool.title || 'اختر إجابة لـ Kimi Code').slice(0, 2000);
}

function executeCommand(tool) {
  const input = tool && tool.rawInput;
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  if (Array.isArray(input.command)) return input.command.join(' ');
  return '';
}

function selectedOutcome(options, allow, always) {
  const list = Array.isArray(options) ? options : [];
  const preferred = allow
    ? (always ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'])
    : (always ? ['reject_always', 'reject_once'] : ['reject_once', 'reject_always']);
  for (const kind of preferred) {
    const option = list.find((item) => item && item.kind === kind && typeof item.optionId === 'string');
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

function buildSatrMcpTools(cwd, skillContext, emit) {
  const definitions = new Map(agentTools.defs().map((definition) => [definition.function.name, definition.function]));
  let callSeq = 0;
  return SATR_TOOL_NAMES.map((name) => {
    const definition = definitions.get(name);
    return {
      name,
      description: definition.description,
      inputSchema: definition.parameters,
      access: name === 'verify_project' ? 'exec' : 'read',
      neverAlways: name === 'verify_project',
      handler: async (args) => {
        // K3-أ: على قنوات keep-alive يصل skillContext مرجعاً حياً { current } يُحدَّث
        // كل دور، فيرى الدور المستأجر اختياره الحالي لا اختيار دور بناء القناة.
        // الاستخدامات الثابتة تمرر الكائن العادي كما هو (توافق خلفي).
        const activeSkillContext = skillContext && typeof skillContext === 'object'
          && Object.prototype.hasOwnProperty.call(skillContext, 'current')
          ? skillContext.current : skillContext;
        const result = await agentTools.run(name, cwd, args || {}, {
          emit, id: 'kmmcp_tool_' + (++callSeq), skillContext: activeSkillContext, engine: ENGINE_ID,
        });
        return {
          content: [{ type: 'text', text: String(result && result.content || '') }],
          isError: !(result && result.ok),
        };
      },
    };
  }).filter((tool) => tool.description && tool.inputSchema);
}

function shouldAutoApproveMcp(access, browserControl, permissionMode, remembered, neverAlways,
  toolName, target, trustedOrigins, currentUrl, input, pageContext, budgetStatus) {
  if (permissionMode === 'bypassPermissions') return true;
  if (browserpolicy.isSensitiveAction(toolName, input, pageContext)
      || browserpolicy.requiresExplicitApproval(toolName)
      || browserpolicy.hasLeakRisk(browserpolicy.leakValueForTool(toolName, input))
      || budgetStatus && budgetStatus.impacting && !budgetStatus.allowed) return false;
  if (access === 'browser' && browserControl === true) {
    const browserClass = browserorigin.classifyBrowserTool(toolName);
    if (!browserorigin.canAutoControl(toolName, target, trustedOrigins)) return false;
    return browserClass !== 'act' || browserorigin.isTrusted(currentUrl || target, trustedOrigins);
  }
  return remembered === true && neverAlways !== true;
}

function createRpc(proc, handlers) {
  let nextId = 0;
  let buffer = '';
  let closed = false;
  const pending = new Map();

  function write(message) {
    if (closed) return;
    try { proc.stdin.write(JSON.stringify(message) + '\n'); } catch { /* أُغلقت العملية */ }
  }
  function request(method, params, timeoutMs) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs) timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('انتهت مهلة ' + method));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      write({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  function notify(method, params) { write({ jsonrpc: '2.0', method, params: params || {} }); }
  function respond(id, result) { write({ jsonrpc: '2.0', id, result }); }
  function respondError(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

  function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id != null && message.method) {
      Promise.resolve(handlers.onRequest && handlers.onRequest(message, { respond, respondError }))
        .catch((error) => respondError(message.id, -32603, scrubError(error && error.message)));
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'rpc_error');
        error.code = message.error.code;
        item.reject(error);
      } else item.resolve(message.result);
      return;
    }
    if (message.method && handlers.onNotification) handlers.onNotification(message.method, message.params || {});
  }

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_RPC_LINE && !buffer.includes('\n')) {
      if (handlers.onProtocolError) handlers.onProtocolError(new Error('ACP line too large'));
      buffer = '';
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); }
      catch { if (handlers.onProtocolError) handlers.onProtocolError(new Error('ACP JSON invalid')); }
    }
  });

  function close(error) {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) item.reject(error || new Error('ACP closed'));
    pending.clear();
  }
  return { request, notify, respond, respondError, close, write };
}

function noOpHandle() {
  return {
    resolvePermission() { return false; },
    resolveHandoff() { return false; },
    async stop() {},
  };
}

function create(deps) {
  const options = deps || {};
  const spawnImpl = options.spawn || spawn;
  const resolveBin = options.resolveKimiBin || resolveKimiBin;
  const resolveDataRoot = options.dataRoot || dataRoot;
  const mcpFactory = options.startMcp || codexmcp.start;
  // K2 keep-alive: سجل قنوات ACP الحية لهذه النسخة من المحرك (سقف 2، خمول 15 دقيقة).
  // الحجب والقص يُحقنان هنا حتى تمر الأحداث المتأخرة ببوابة أحداث الدور نفسها.
  const keepalive = options.keepalive || keepaliveFactory.create({
    maxLive: options.keepaliveMaxLive,
    idleMs: options.keepaliveIdleMs,
    scrub: scrubStreamText,
    toolText,
    toolLabel,
  });

  async function start(input, cwd, emit) {
    const bin = resolveBin();
    if (!bin) {
      emit({
        type: 'spawn_error',
        text: 'لم يُعثر على Kimi Code CLI. ثبّته من PowerShell: irm https://code.kimi.com/kimi-code/install.ps1 | iex',
      });
      emit({ type: 'proc_done', code: 1 });
      return noOpHandle();
    }

    const startedAt = Date.now();
    const permissionMode = input.permissionMode || 'default';
    const browserControl = input.browserControl;
    const trustedOrigins = input.trustedBrowserOrigins instanceof Set ? input.trustedBrowserOrigins : new Set();
    const actionBudget = input.browserBudget && typeof input.browserBudget.check === 'function'
      ? input.browserBudget : browserpolicy.createActionBudget();
    const allowExternalBrowser = promptRequestsExternalBrowser(input.prompt);
    const pendingPermissions = new Map();
    const pendingQuestions = new Map();
    const pendingMcpPermissions = new Map();
    const pendingHandoffs = new Map();
    const toolCalls = new Map();
    const completedTools = new Set();
    const messages = new Map();
    const messageOrder = [];
    const commentaryMessages = new Map();
    const commentaryOrder = [];
    const emittedDiffs = new Set();
    let permissionSeq = 0;
    let handoffSeq = 0;
    let editSeq = 0;
    let writeGrantUntil = 0;
    let sessionId = null;
    let promptRequest = null;
    let mcpHost = null;
    let finished = false;
    let stopping = false;
    let emittedDone = false;
    let usage = null;
    let replayingSession = false;
    const compactCommand = /^\/compact(?:\s|$)/i.test(String(input.prompt || '').trim());
    const skillContext = skillCatalog.resolveSelection(cwd, input.skills);

    // K2 keep-alive: استئجار قناة حية للجلسة (نفس cwd) أو إنشاء قناة جديدة.
    // أي فشل هنا يسقط إلى «عملية لكل دور» — السلوك الحالي بلا كسر للدور.
    let lease = null;
    if (input.sessionId && SAFE_SESSION.test(input.sessionId)) {
      try { lease = keepalive.acquire(input.sessionId); } catch { lease = null; }
      if (lease && !samePath(lease.cwd, path.resolve(cwd))) lease = null;
    }
    // shared.turn يحمل ربط الدور النشط على القناة؛ يصفَّر عند انتهاء الدور وتبقى
    // القناة حية. كل بثّ قناوي (MCP، stderr، جسر RPC) يمر عبره كي لا يعلق emit
    // دورٍ ميت في معالجات طويلة العمر.
    const shared = lease ? lease.shared : { turn: null };
    const emitShared = (event) => { const t = shared.turn; if (t && t.emit) t.emit(event); };
    const channelRef = { sessionId: lease ? lease.sessionId : null };
    // القناة المستأجرة مسجّلة أصلاً؛ القناة الجديدة تُسجَّل بعد نجاح session setup.
    let keepAliveActive = !!lease;
    // K3-أ: مرجع حي لسياق المهارات على القناة المشتركة — يُحدَّث في كل دور (أول أو
    // مستأجَر) فتقرأ إغلاقات extraTools طويلة العمر سياق الدور النشط لا دور البناء.
    if (shared.skillContextRef) shared.skillContextRef.current = skillContext;
    else shared.skillContextRef = { current: skillContext };

    if (lease) {
      mcpHost = lease.mcpHost;
    } else if (browserControl !== false) try {
      mcpHost = await mcpFactory({
        preview,
        cwd,
        extraTools: buildSatrMcpTools(cwd, shared.skillContextRef, emitShared),
        openPreview: (url) => emitShared({ type: 'preview_open', url }),
        closePreview: () => emitShared({ type: 'preview_close' }),
        onActivity: (method, tool) => {
          if (method === 'tools/call' && tool) try { preview.emitAgentActivity(tool); } catch { /* تحسين */ }
        },
        // الإذن والتسليم حالة دورية: يُفوَّضان إلى الدور النشط على القناة، ويُرفضان بلا دور.
        requestPermission: (...args) => {
          const t = shared.turn;
          return t && t.requestMcpPermission ? t.requestMcpPermission(...args) : Promise.resolve(false);
        },
        requestHandoff: (reason, meta) => {
          const t = shared.turn;
          return t && t.requestMcpHandoff ? t.requestMcpHandoff(reason, meta) : Promise.resolve(false);
        },
      });
    } catch { mcpHost = null; }

    let proc;
    if (lease) {
      proc = lease.proc;
    } else {
      try {
        proc = spawnKimi(bin, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true }, spawnImpl);
      } catch (error) {
        if (mcpHost) await mcpHost.stop().catch(() => {});
        emit({ type: 'spawn_error', text: 'تعذّر تشغيل Kimi Code: ' + scrubError(error && error.message) });
        emit({ type: 'proc_done', code: 1 });
        return noOpHandle();
      }
    }

    function emitAssistantMessages() {
      // التفكير الحي يُعرض في قسم «سجل التفكير» منفصل عن الإجابة، ولا يُدرَج في تصدير Markdown.
      for (const id of commentaryOrder) {
        const text = commentaryMessages.get(id);
        if (!text || !text.trim()) continue;
        emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text, phase: 'commentary' }] } });
      }
      commentaryMessages.clear(); commentaryOrder.length = 0;
      for (const id of messageOrder) {
        const text = messages.get(id);
        if (!text || !text.trim()) continue;
        emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text, phase: 'final_answer' }] } });
      }
      messages.clear(); messageOrder.length = 0;
    }

    function emitToolStart(tool) {
      if (!tool || !tool.toolCallId || toolCalls.has(tool.toolCallId)) return;
      const normalized = {
        toolCallId: tool.toolCallId,
        title: tool.title || 'Kimi Tool',
        kind: tool.kind || 'other',
        rawInput: tool.rawInput || {},
      };
      toolCalls.set(tool.toolCallId, normalized);
      emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{
          type: 'tool_use', id: normalized.toolCallId, name: toolLabel(normalized.title), input: safeToolInput(normalized.rawInput),
        }] },
      });
    }

    function emitDiff(callId, diff) {
      if (!diff || diff.type !== 'diff' || typeof diff.path !== 'string'
          || typeof diff.newText !== 'string' || diff.newText.length > MAX_FILE_BYTES) return;
      const absolute = safeWritablePath(cwd, diff.path);
      if (!absolute) return;
      const before = typeof diff.oldText === 'string' ? diff.oldText : null;
      if (before != null && before.length > MAX_FILE_BYTES) return;
      const key = crypto.createHash('sha256').update(absolute).update('\0').update(before || '').update('\0').update(diff.newText).digest('hex');
      if (emittedDiffs.has(key)) return;
      emittedDiffs.add(key);
      const id = 'km_' + String(callId || 'edit').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 70) + '_' + (++editSeq);
      rememberSnapshot(id, absolute, before);
      const calculated = computeDiff(before || '', diff.newText);
      emit({
        type: 'file_edit', id, tool: 'Kimi Edit', rel: relPath(cwd, absolute), isNew: before == null,
        added: calculated.added, removed: calculated.removed, lines: calculated.lines, truncated: calculated.truncated,
      });
    }

    function finishTool(update) {
      const id = update.toolCallId;
      if (!id || completedTools.has(id)) return;
      if (update.status !== 'completed' && update.status !== 'failed' && update.status !== 'cancelled') return;
      completedTools.add(id);
      for (const item of Array.isArray(update.content) ? update.content : []) if (item && item.type === 'diff') emitDiff(id, item);
      emit({
        type: 'user',
        message: { role: 'user', content: [{
          type: 'tool_result', tool_use_id: id, content: toolText(update.content, update.rawOutput),
          is_error: update.status !== 'completed',
        }] },
      });
    }

    function autoPermission(tool, rpc, serverId, optionsList) {
      const kind = tool.kind || 'other';
      const key = 'acp:' + kind + ':' + String(tool.title || 'tool').slice(0, 120);
      const command = kind === 'execute' ? executeCommand(tool) : '';
      const planWrite = mutationKind(kind)
        && !!safePlanPath(resolveDataRoot(), sessionId, tool.rawInput && tool.rawInput.path, false);
      // Kimi يضيف بوابة ACP خارجية حول أداة MCP المدمجة. نقبل الغلاف فقط؛ معالج
      // codexmcp الداخلي يبقى صاحب قرار النطاق والفعل الحساس والميزانية (لا تجاوز أذونات).
      if (isEmbeddedMcpTool(tool, mcpHost)) {
        rpc.respond(serverId, { outcome: selectedOutcome(optionsList, true, false) });
        return true;
      }
      if (command && execguard.isServerCommand(command)) {
        rpc.respond(serverId, { outcome: selectedOutcome(optionsList, false, false) });
        emit({ type: 'stderr', text: execguard.buildRedirectMessage() });
        return true;
      }
      if (command && browserControl !== false && isExternalBrowserLaunchCommand(command) && !allowExternalBrowser) {
        rpc.respond(serverId, { outcome: selectedOutcome(optionsList, false, false) });
        emit({ type: 'stderr', text: 'حُجب فتح متصفح خارجي. استخدم أدوات معاينة «سطر» (open_preview وbrowser_*).' });
        return true;
      }
      const risky = mutationKind(kind) || kind === 'execute' || !safeReadKind(kind);
      const allow = permissionMode === 'bypassPermissions'
        || permissionMode === 'acceptEdits' && mutationKind(kind)
        || permissionMode === 'plan' && planWrite
        || alwaysAllowed.has(key)
        || !risky;
      if (permissionMode === 'plan' && risky && !planWrite) {
        rpc.respond(serverId, { outcome: selectedOutcome(optionsList, false, false) });
        return true;
      }
      if (allow) {
        if (mutationKind(kind)) writeGrantUntil = Date.now() + 120000;
        rpc.respond(serverId, { outcome: selectedOutcome(optionsList, true, alwaysAllowed.has(key)) });
        return true;
      }
      return false;
    }

    // إذن أداة MCP المدمجة — منطق دوري يُفوَّض إليه من خادم MCP طويل العمر (K2).
    function requestMcpPermission(toolName, displayInput, access, neverAlways, target, currentUrl, pageContext, rawInput) {
      return new Promise((resolve) => {
        const policyInput = rawInput && typeof rawInput === 'object' ? rawInput : displayInput;
        const budgetStatus = actionBudget.check(toolName);
        const forcePrompt = browserpolicy.isSensitiveAction(toolName, policyInput, pageContext)
          || browserpolicy.requiresExplicitApproval(toolName)
          || browserpolicy.hasLeakRisk(browserpolicy.leakValueForTool(toolName, policyInput))
          || budgetStatus.impacting && !budgetStatus.allowed;
        if (shouldAutoApproveMcp(access, browserControl, permissionMode, alwaysAllowed.has('mcp:' + toolName),
          neverAlways, toolName, target, trustedOrigins, currentUrl, policyInput, pageContext, budgetStatus)) {
          actionBudget.consume(toolName); resolve(true); return;
        }
        const id = 'kmmcp_' + (++permissionSeq) + '_' + Math.random().toString(36).slice(2, 6);
        const browserClass = browserorigin.classifyBrowserTool(toolName);
        const targetTrusted = browserorigin.isTrusted(target, trustedOrigins);
        const currentTrusted = browserorigin.isTrusted(currentUrl, trustedOrigins);
        const trustTarget = targetTrusted && browserClass === 'act' && !currentTrusted ? currentUrl : target;
        const origin = browserorigin.originOf(trustTarget);
        const originTrust = browserControl === true
          && (browserClass === 'navigate' || browserClass === 'act')
          && (!targetTrusted || browserClass === 'act' && !currentTrusted);
        pendingMcpPermissions.set(id, {
          resolve, toolName, neverAlways: !!neverAlways || forcePrompt, originTrust, origin,
          budgetAction: budgetStatus.impacting, budgetExtend: budgetStatus.impacting && !budgetStatus.allowed,
        });
        const policyDetail = browserpolicy.permissionDetail(toolName, policyInput, pageContext, budgetStatus);
        emit({
          type: 'permission_request', id, tool: toolName, input: displayInput || {},
          detail: [originTrust ? browserorigin.trustPrompt(toolName, trustTarget) : '', policyDetail].filter(Boolean).join('\n\n'),
          turnEligible: false, alwaysEligible: originTrust ? !!origin : (!neverAlways && !forcePrompt),
          alwaysLabel: originTrust ? 'ثق بالنطاق لهذه الجلسة' : '', originTrust,
        });
      });
    }

    function requestMcpHandoff(reason, meta) {
      const id = 'ho_km_' + (++handoffSeq) + '_' + Math.random().toString(36).slice(2, 6);
      return new Promise((resolve) => {
        pendingHandoffs.set(id, { resolve });
        emit({ type: 'handoff_request', id, reason, mode: meta && meta.mode === 'step' ? 'step' : 'full' });
      }).then((done) => { emit({ type: 'handoff_end', id }); return done; });
    }

    // معالجا القناة لأحداث هذا الدور — يُسجَّلان في shared.turn ويُفصلان عند انتهائه.
    function handleServerRequest(message, channel) {
        const params = message.params || {};
        if (message.method === 'session/request_permission') {
          const known = params.toolCall && params.toolCall.toolCallId ? toolCalls.get(params.toolCall.toolCallId) : null;
          const tool = { ...(known || {}), ...(params.toolCall || {}) };
          emitToolStart(tool);
          if (questionLike(tool) && Array.isArray(params.options) && params.options.length >= 2) {
            const id = 'kmq_' + (++permissionSeq) + '_' + Math.random().toString(36).slice(2, 7);
            pendingQuestions.set(id, { serverId: message.id, options: params.options });
            emit({
              type: 'question_request', id,
              questions: [{
                question: questionText(tool), header: 'Kimi Code', multiSelect: false,
                options: params.options.slice(0, 8).map((option) => ({
                  label: String(option && option.name || option && option.optionId || 'خيار').slice(0, 400),
                  description: '',
                })),
              }],
            });
            return;
          }
          if (autoPermission(tool, channel, message.id, params.options)) return;
          const id = 'km_' + (++permissionSeq) + '_' + Math.random().toString(36).slice(2, 7);
          const key = 'acp:' + (tool.kind || 'other') + ':' + String(tool.title || 'tool').slice(0, 120);
          pendingPermissions.set(id, { serverId: message.id, options: params.options, tool, key });
          emit({
            type: 'permission_request', id, tool: toolLabel(tool.title || 'Kimi Tool'), input: safeToolInput(tool.rawInput),
            detail: 'Kimi Code يطلب تنفيذ أداة من النوع: ' + (tool.kind || 'other'),
            turnEligible: false, alwaysEligible: true,
          });
          return;
        }
        if (message.method === 'fs/read_text_file') {
          const target = safeExistingPath(cwd, params.path)
            || safePlanPath(resolveDataRoot(), sessionId, params.path, true);
          if (!target) { channel.respondError(message.id, -32602, 'المسار خارج مجلد المشروع'); return; }
          let stat;
          try { stat = fs.statSync(target); } catch { channel.respondError(message.id, -32602, 'الملف غير موجود'); return; }
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { channel.respondError(message.id, -32602, 'الملف غير صالح أو كبير'); return; }
          const all = fs.readFileSync(target, 'utf8').split('\n');
          const line = Number.isInteger(params.line) && params.line > 0 ? params.line - 1 : 0;
          const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 20000) : 20000;
          channel.respond(message.id, { content: all.slice(line, line + limit).join('\n') });
          return;
        }
        if (message.method === 'fs/write_text_file') {
          if (permissionMode !== 'bypassPermissions' && permissionMode !== 'acceptEdits' && Date.now() > writeGrantUntil) {
            channel.respondError(message.id, -32001, 'لا توجد موافقة كتابة فعالة'); return;
          }
          if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > MAX_FILE_BYTES) {
            channel.respondError(message.id, -32602, 'المحتوى غير صالح أو كبير'); return;
          }
          const target = safeWritablePath(cwd, params.path)
            || safePlanPath(resolveDataRoot(), sessionId, params.path, false);
          if (!target) { channel.respondError(message.id, -32602, 'المسار خارج مجلد المشروع'); return; }
          let before = null;
          try { before = fs.readFileSync(target, 'utf8'); } catch { before = null; }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, params.content, 'utf8');
          emitDiff('fs', { type: 'diff', path: target, oldText: before, newText: params.content });
          channel.respond(message.id, {});
          return;
        }
        channel.respondError(message.id, -32601, 'طريقة ACP غير مدعومة في سطر');
    }

    function handleSessionNotification(method, params) {
        if (method !== 'session/update') return;
        // session/load يعيد بث التاريخ قبل إكمال الدور؛ الجلسة موجودة أصلاً في واجهة سطر.
        if (replayingSession) return;
        const update = params.update || {};
        if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
          const id = update.messageId || '_message';
          if (!messages.has(id)) messageOrder.push(id);
          const text = String(update.content.text || '');
          messages.set(id, (messages.get(id) || '') + text);
          if (text && !compactCommand) emit({ type: 'stream_text', text, phase: 'final_answer' });
        } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content && update.content.type === 'text') {
          // تطبيع التفكير الحي ليعرض في قسم «سرد حي» منفصل عن الإجابة النهائية، تماماً كما
          // يُعالج SDK محرك Claude كتلة thinking → commentary.
          const id = update.messageId || '_thought';
          if (!commentaryMessages.has(id)) commentaryOrder.push(id);
          const text = String(update.content.text || '');
          const scrubbed = scrubStreamText(text, MAX_TOOL_TEXT);
          commentaryMessages.set(id, (commentaryMessages.get(id) || '') + scrubbed);
          if (scrubbed && !compactCommand) emit({ type: 'stream_text', text: scrubbed, phase: 'commentary' });
        } else if (update.sessionUpdate === 'tool_call') {
          emitToolStart(update);
          finishTool(update);
        } else if (update.sessionUpdate === 'tool_call_update') {
          const previous = toolCalls.get(update.toolCallId) || {};
          const merged = { ...previous, ...update, rawInput: update.rawInput || previous.rawInput || {} };
          if (!toolCalls.has(update.toolCallId)) emitToolStart(merged);
          else toolCalls.set(update.toolCallId, merged);
          finishTool(merged);
        } else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
          emit({
            type: 'task_update', schema_version: 1, session_id: params.sessionId || sessionId,
            mode: 'replace', source: 'kimi_plan',
            tasks: update.entries.map((entry, index) => ({
              id: 'kimi-plan-' + (index + 1), title: entry && entry.content,
              status: entry && entry.status === 'completed' ? 'completed'
                : entry && entry.status === 'in_progress' ? 'in_progress' : 'pending',
              owner: 'Kimi Code', dependencies: [], evidence: [],
            })),
          });
        } else if (update.sessionUpdate === 'usage_update') usage = update;
        else if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
          // عقد satr:event — system/available_commands: Kimi يعلن أوامره المائلة عبر ACP
          // (compact/status/usage/tasks/help…). الواجهة تغطي الأساسي منها بأسماء عربية
          // ثابتة في COMMANDS (/ضغط /سياق /حالة /مهام /مساعدة) وتخزّن القائمة الخام.
          emit({
            type: 'system', subtype: 'available_commands',
            commands: update.availableCommands.slice(0, 40).map((command) => ({
              name: String(command && command.name || '').slice(0, 60),
              description: String(command && command.description || '').slice(0, 300),
            })).filter((command) => command.name),
          });
        }
    }

    // جسر القناة (K2): يفوّض إلى الدور النشط في shared.turn؛ وبلا دور تُرفض طلبات
    // الوكيل بلطف وتُعالج إشعاراته كأحداث متأخرة تُبث كإشعارات مؤقتة للواجهة.
    let rpc;
    if (lease) {
      rpc = lease.rpc;
    } else {
      rpc = createRpc(proc, {
        onProtocolError(error) {
          const t = shared.turn;
          if (t && t.emit) t.emit({ type: 'stderr', text: 'خطأ في قناة Kimi ACP: ' + scrubError(error.message) });
        },
        onRequest(message, channel) {
          const reqSid = message.params && typeof message.params.sessionId === 'string' ? message.params.sessionId : null;
          if (reqSid) keepalive.touchSession(reqSid);
          const t = shared.turn;
          if (t && t.onRequest) { t.onRequest(message, channel); return; }
          if (message.method === 'session/request_permission') {
            channel.respond(message.id, { outcome: { outcome: 'cancelled' } });
            return;
          }
          channel.respondError(message.id, -32603, 'لا يوجد دور نشط على جلسة Kimi');
        },
        onNotification(method, params) {
          const sid = params && typeof params.sessionId === 'string' ? params.sessionId : null;
          if (sid) keepalive.touchSession(sid);
          const t = shared.turn;
          if (t && t.onNotification) { t.onNotification(method, params); return; }
          if (sid) keepalive.handleLateNotificationBySession(sid, method, params);
        },
      });
    }

    function cancelPending() {
      for (const item of pendingPermissions.values()) {
        try { rpc.respond(item.serverId, { outcome: { outcome: 'cancelled' } }); } catch { /* إغلاق */ }
      }
      pendingPermissions.clear();
      for (const item of pendingQuestions.values()) {
        try { rpc.respond(item.serverId, { outcome: { outcome: 'cancelled' } }); } catch { /* إغلاق */ }
      }
      pendingQuestions.clear();
      for (const item of pendingMcpPermissions.values()) { try { item.resolve(false); } catch { /* إغلاق */ } }
      pendingMcpPermissions.clear();
      for (const [id, item] of pendingHandoffs) {
        try { item.resolve(false); } catch { /* إغلاق */ }
        emit({ type: 'handoff_end', id });
      }
      pendingHandoffs.clear();
    }

    // K2: نهاية دور طبيعية — تُلغى المعلقات ويُفصل الدور عن القناة وتبقى حية في السجل.
    async function releaseTurn(code) {
      cancelPending();
      preview.clearSensitiveState();
      shared.turn = null;
      if (channelRef.sessionId) keepalive.touchSession(channelRef.sessionId);
      if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
    }

    // تدمير كامل للقناة (أخطاء التهيئة/العملية أو سقوط رشيق بلا تسجيل) = السلوك القديم.
    async function destroyChannel(code) {
      cancelPending();
      preview.clearSensitiveState();
      shared.turn = null;
      if (channelRef.sessionId) keepalive.remove(channelRef.sessionId);
      rpc.close();
      try { proc.stdin.end(); } catch { /* مغلق */ }
      setTimeout(() => { try { proc.kill(); } catch { /* منتهٍ */ } }, 500);
      if (mcpHost) { const host = mcpHost; mcpHost = null; await host.stop().catch(() => {}); }
      if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
    }

    function finishTurn(result) {
      if (finished) return;
      finished = true;
      const compactMetadata = compactCommand
        ? parseCompactionText(messageOrder.map((id) => messages.get(id) || '').join('\n')) : null;
      if (compactMetadata) {
        messages.clear(); messageOrder.length = 0;
        emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: compactMetadata });
      } else emitAssistantMessages();
      const reason = result && result.stopReason || 'end_turn';
      const isError = reason !== 'end_turn' && reason !== 'cancelled';
      if (!stopping) emit({
        type: 'result', subtype: isError ? 'error' : 'success', is_error: isError,
        result: isError ? 'أوقف Kimi الدور بسبب: ' + reason : undefined,
        session_id: sessionId, duration_ms: Date.now() - startedAt,
        total_cost_usd: usage && usage.cost && usage.cost.currency === 'USD' ? usage.cost.amount : null,
      });
      // K2: لا session/cancel ولا قتل عند نهاية الدور — القناة تعود للسجل حية.
      if (keepAliveActive) releaseTurn(isError ? 1 : 0);
      else destroyChannel(isError ? 1 : 0);
    }

    // ربط هذا الدور بالقناة: يقرأه جسر RPC ومعالجات العملية وخادم MCP طويل العمر.
    const turnHandle = {
      emit,
      onRequest: handleServerRequest,
      onNotification: handleSessionNotification,
      requestMcpPermission,
      requestMcpHandoff,
      // يستدعيه سجل keep-alive عند قتل جلسة عليها دور نشط: يلغي الدور وينهيه في الواجهة.
      async abortTurn() {
        if (finished) return;
        stopping = true;
        cancelPending();
        if (sessionId) try { rpc.notify('session/cancel', { sessionId }); } catch { /* أُغلقت */ }
        await Promise.race([
          promptRequest ? promptRequest.catch(() => null) : Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
        if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: 0 }); }
      },
      onProcError(error) {
        if (!finished) emit({ type: 'spawn_error', text: 'تعذّر تشغيل Kimi Code: ' + scrubError(error && error.message) });
        finished = true;
        destroyChannel(1);
      },
      onProcExit(code) {
        if (!finished && !stopping) emit({ type: 'spawn_error', text: 'أُنهيت عملية Kimi Code (كود ' + code + ')' });
        if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
        shared.turn = null;
      },
    };
    shared.turn = turnHandle;

    // معالجات العملية تُسجَّل مرة واحدة عند إنشاء القناة وتفوّض دوماً إلى الدور النشط.
    if (!lease) {
      proc.stderr.on('data', (chunk) => {
        const text = scrubError(chunk.toString('utf8'));
        if (text && !/debug|trace|polling|token refresh/i.test(text)) emitShared({ type: 'stderr', text });
      });
      proc.on('error', (error) => {
        if (channelRef.sessionId) keepalive.remove(channelRef.sessionId);
        const t = shared.turn;
        if (t && t.onProcError) t.onProcError(error);
      });
      proc.on('exit', (code) => {
        rpc.close(new Error('Kimi exited'));
        if (channelRef.sessionId) keepalive.remove(channelRef.sessionId);
        const t = shared.turn;
        if (t && t.onProcExit) t.onProcExit(code);
      });
    }

    // خيارات ACP هي المصدر الوحيد لإعداد الجلسة. لا نمرّر قيماً لا يعلنها Kimi.
    // مستخرجة لتعمل في المسارين: جلسة جديدة (configOptions طازجة) أو مستأجرة (المخزّنة).
    async function applyConfigOptions(configOptions) {
      const modelOption = configOptions.find((item) => item && item.id === 'model');
      const modelValue = configValue(modelOption, input.model || DEFAULT_MODEL, true);
      if (modelValue && modelValue !== modelOption.currentValue) {
        await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: modelValue }, 15000);
        modelOption.currentValue = modelValue;
      }
      const effortOption = configOptions.find((item) => item && (
        item.id === 'effort' || item.id === 'reasoning_effort' || item.category === 'thought_level'
      ));
      const effortValue = configValue(effortOption, input.effort, false);
      if (effortValue && effortValue !== effortOption.currentValue) {
        await rpc.request('session/set_config_option', {
          sessionId, configId: effortOption.id, value: effortValue,
        }, 15000);
        effortOption.currentValue = effortValue;
      }
      // خيار التفكير الحي: نطبّقه فقط إن أعلنه ACP فعلاً (Kimi 0.27.0 يعلنه 'on' فقط).
      // لا نكتب config.toml العام أبداً — session/set_config_option فقط.
      const thinkingOption = configOptions.find((item) => item && item.id === 'thinking');
      const thinkingValue = configValue(thinkingOption, input.thinking, false);
      if (thinkingValue && thinkingValue !== thinkingOption.currentValue) {
        await rpc.request('session/set_config_option', { sessionId, configId: 'thinking', value: thinkingValue }, 15000);
        thinkingOption.currentValue = thinkingValue;
      }
      // Plan mode عقد ACP لا مجرد منع أذونات: نضبط config الفعلي إن أعلن Kimi خيار mode=plan.
      if (permissionMode === 'plan') {
        const mode = configOptions.find((item) => item && item.id === 'mode');
        if (configValue(mode, 'plan', false)) {
          await rpc.request('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' }, 15000);
        }
      }
    }

    let promptCaps = null; // قدرات البرومبت المعلنة — تُخزَّن مع القناة لتعمل الأدوار المستأجرة

    (async () => {
      try {
        if (lease) {
          // قناة مستأجرة (K2): الجلسة حية أصلاً — لا initialize ولا session/new.
          sessionId = lease.sessionId;
          promptCaps = lease.promptCapabilities || {};
          emit({ type: 'system', subtype: 'init', session_id: sessionId, model: input.model || DEFAULT_MODEL });
          await applyConfigOptions(Array.isArray(lease.configOptions) ? lease.configOptions : []);
        } else {
          // terminal reverse-RPC: يبقى معطّلاً حالياً لأن Kimi 0.27.0 لا يعلنه. إن أعلنه
          // إصدار لاحق في agentCapabilities.terminalCapabilities.reverseRpc، نُعلن قدرة
          // العميل terminal: true ونوجّه طلبات terminal/* إلى تبويبات pty المرئية عبر
          // termjobs/term.js (نفس مسار run_in_terminal). هذا capability-gated ولا يُفعّل
          // أبداً دون إعلان صريح من الوكيل.
          const initialized = await rpc.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
            clientInfo: { name: 'satr', title: 'سطر', version: APP_VERSION },
          }, 15000);
          if (!initialized || initialized.protocolVersion !== 1) throw new Error('إصدار ACP غير مدعوم');
          const capabilities = initialized.agentCapabilities || {};
          promptCaps = capabilities.promptCapabilities || {};
          const terminalReverseRpc = !!(capabilities.terminalCapabilities && capabilities.terminalCapabilities.reverseRpc);
          // إن أعلن Kimi دعم terminal reverse-RPC، نُفعّل البوابة ونوجّه الأوامر إلى pty.
          // الآن: العميل لا يُعلن terminal، لذا لن تصل طلبات terminal/* أصلاً.
          const mcpServers = mcpHost && capabilities.mcpCapabilities && capabilities.mcpCapabilities.http
            ? [{
              type: 'http', name: 'satr', url: mcpHost.url,
              headers: [{ name: 'Authorization', value: 'Bearer ' + mcpHost.token }],
            }] : [];
          if (mcpHost && !mcpServers.length) { const host = mcpHost; mcpHost = null; await host.stop().catch(() => {}); }
          const lifecycle = { cwd: path.resolve(cwd), mcpServers };
          let sessionResult;
          if (input.sessionId && SAFE_SESSION.test(input.sessionId)) {
            try {
              try {
                sessionResult = await rpc.request('session/resume', {
                  ...lifecycle, sessionId: input.sessionId,
                }, 30000);
              } catch (resumeError) {
                if (resumeError && resumeError.code !== -32601) throw resumeError;
                replayingSession = true;
                try {
                  sessionResult = await rpc.request('session/load', {
                    ...lifecycle, sessionId: input.sessionId,
                  }, 30000);
                } finally {
                  replayingSession = false;
                }
              }
              sessionId = input.sessionId;
            } catch {
              emit({ type: 'stderr', text: 'تعذّر استئناف جلسة Kimi Code — بدأت جلسة جديدة.' });
            }
          }
          if (!sessionId) {
            sessionResult = await rpc.request('session/new', lifecycle, 30000);
            sessionId = sessionResult && sessionResult.sessionId;
          }
          if (!sessionId || !SAFE_SESSION.test(sessionId)) throw new Error('معرّف جلسة Kimi غير صالح');
          channelRef.sessionId = sessionId;
          emit({ type: 'system', subtype: 'init', session_id: sessionId, model: input.model || DEFAULT_MODEL });

          const configOptions = sessionResult && Array.isArray(sessionResult.configOptions)
            ? sessionResult.configOptions : [];
          await applyConfigOptions(configOptions);

          // تسجيل القناة في سجل keep-alive (K2). إن رفض السجل (سقف ممتلئ بأدوار نشطة)
          // يكمل الدور كعملية لكل دور ويُدمَّر عند نهايته — سقوط رشيق بلا كسر.
          keepAliveActive = await keepalive.register({
            sessionId, proc, rpc, shared, mcpHost,
            cwd: path.resolve(cwd), model: input.model || DEFAULT_MODEL,
            configOptions, promptCapabilities: promptCaps,
            startedAt: Date.now(), lastActivityAt: Date.now(),
          });
        }

        const prompt = [{ type: 'text', text: input.prompt || '' }];
        const resources = [];
        resources.push({ uri: 'satr://environment', text: envbrief.build(ENGINE_ID, input.model || DEFAULT_MODEL) });
        const skillPrompt = skillCatalog.catalogPrompt(skillContext, { onlyStandard: true });
        if (skillPrompt) resources.push({ uri: 'satr://skills', text: skillPrompt });
        const memoryPrompt = browserControl === false ? '' : memory.retrieve(cwd, input.prompt || '').text;
        if (memoryPrompt) resources.push({ uri: 'satr://memory', text: memoryPrompt });
        // مهام خلفية خرجت بلا دور نشط — كتلة سياق تُحقن مرة واحدة بنفس بوابة الذاكرة
        const backgroundPrompt = browserControl === false ? '' : termjobs.pendingNoticeText(cwd);
        if (backgroundPrompt) resources.push({ uri: 'satr://background-tasks', text: backgroundPrompt });
        if (!compactCommand && promptCaps && promptCaps.embeddedContext) {
          for (const resource of resources) prompt.push({
            type: 'resource', resource: { uri: resource.uri, mimeType: 'text/plain', text: resource.text },
          });
        }
        if (!compactCommand && Array.isArray(input.images) && promptCaps && promptCaps.image) {
          for (const image of input.images) if (image && image.data && image.media_type) {
            prompt.push({ type: 'image', data: image.data, mimeType: image.media_type });
          }
        }
        promptRequest = rpc.request('session/prompt', { sessionId, prompt });
        promptRequest.then(finishTurn).catch((error) => {
          if (stopping) {
            if (keepAliveActive) releaseTurn(0); else destroyChannel(0);
            return;
          }
          if (!finished) {
            finished = true;
            emitAssistantMessages();
            const message = error && error.code === -32000
              ? 'Kimi Code غير مسجَّل الدخول. شغّل `kimi login` في طرفية سطر ثم أعد المحاولة.'
              : 'تعذّر بدء دور Kimi Code: ' + scrubError(error && error.message);
            emit({ type: 'spawn_error', text: message });
            emit({ type: 'result', subtype: 'error', is_error: true, session_id: sessionId, duration_ms: Date.now() - startedAt });
          }
          destroyChannel(1);
        });
      } catch (error) {
        if (!finished) {
          finished = true;
          const message = error && error.code === -32000
            ? 'Kimi Code غير مسجَّل الدخول. شغّل `kimi login` في طرفية سطر ثم أعد المحاولة.'
            : 'تعذّر تهيئة Kimi Code: ' + scrubError(error && error.message);
          emit({ type: 'spawn_error', text: message });
          emit({ type: 'result', subtype: 'error', is_error: true, session_id: sessionId, duration_ms: Date.now() - startedAt });
        }
        destroyChannel(1);
      }
    })();

    return {
      resolvePermission(id, allow, always) {
        const mcp = pendingMcpPermissions.get(id);
        if (mcp) {
          pendingMcpPermissions.delete(id);
          if (allow && mcp.budgetExtend) actionBudget.extend();
          if (allow && mcp.budgetAction && !actionBudget.consume(mcp.toolName).allowed) allow = false;
          if (allow && always && mcp.originTrust && mcp.origin) trustedOrigins.add(mcp.origin);
          else if (allow && always && !mcp.neverAlways) alwaysAllowed.add('mcp:' + mcp.toolName);
          try { mcp.resolve(!!allow); } catch { /* أُغلق */ }
          return true;
        }
        const item = pendingPermissions.get(id);
        if (!item) return false;
        pendingPermissions.delete(id);
        if (allow && always) alwaysAllowed.add(item.key);
        if (allow && mutationKind(item.tool.kind)) writeGrantUntil = Date.now() + 120000;
        rpc.respond(item.serverId, { outcome: selectedOutcome(item.options, !!allow, !!always) });
        return true;
      },
      resolveHandoff(id, done) {
        const item = pendingHandoffs.get(id);
        if (!item) return false;
        pendingHandoffs.delete(id);
        try { item.resolve(!!done); } catch { /* أُغلق */ }
        return true;
      },
      resolveQuestion(id, selections) {
        const item = pendingQuestions.get(id);
        if (!item) return false;
        pendingQuestions.delete(id);
        const first = Array.isArray(selections) && selections[0];
        const index = first && Array.isArray(first.optionIndexes) ? first.optionIndexes[0] : -1;
        const option = Number.isInteger(index) ? item.options[index] : null;
        const outcome = option && typeof option.optionId === 'string'
          ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
        rpc.respond(item.serverId, { outcome });
        return true;
      },
      async stop() {
        // إيقاف الدور فقط (K2 — قرار القائد 2): يُلغي الدور الجاري عبر session/cancel
        // ويحرّره، والجلسة تبقى حية في سجل keep-alive؛ القتل الكامل من شريط bg_procs.
        if (stopping) return;
        stopping = true;
        cancelPending();
        if (sessionId) try { rpc.notify('session/cancel', { sessionId }); } catch { /* أُغلقت */ }
        await Promise.race([
          promptRequest ? promptRequest.catch(() => null) : Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
        if (keepAliveActive) await releaseTurn(0);
        else await destroyChannel(0);
      },
    };
  }

  async function withProbe(task, onNotification) {
    const bin = resolveBin(true);
    if (!bin) throw new Error('not_installed');
    const proc = spawnKimi(bin, ['acp'], { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true }, spawnImpl);
    let rpc;
    rpc = createRpc(proc, {
      onRequest(message, channel) { channel.respondError(message.id, -32601, 'غير متاح أثناء قراءة الجلسات'); },
      onNotification(method, params) { if (onNotification) onNotification(method, params); },
    });
    proc.on('error', (error) => rpc.close(error));
    proc.on('exit', () => rpc.close(new Error('Kimi exited')));
    try {
      const initialized = await rpc.request('initialize', {
        protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'satr', title: 'سطر', version: APP_VERSION },
      }, 15000);
      return await task(rpc, initialized || {});
    } finally {
      rpc.close();
      try { proc.stdin.end(); } catch { /* مغلق */ }
      setTimeout(() => { try { proc.kill(); } catch { /* منتهٍ */ } }, 100);
    }
  }

  async function rawSessionList() {
    return withProbe(async (rpc, initialized) => {
      const supported = initialized.agentCapabilities && initialized.agentCapabilities.sessionCapabilities
        && initialized.agentCapabilities.sessionCapabilities.list;
      if (!supported) return [];
      const sessions = [];
      let cursor;
      // تصفّح بالمؤشر حتى سقف MAX_SESSIONS؛ سقف الصفحات (10) حاجز أمان فقط حتى
      // يظل السقف الكلي قابلاً للبلوغ حتى مع صفحات صغيرة من الوكيل.
      for (let page = 0; page < 10 && sessions.length < MAX_SESSIONS; page++) {
        const result = await rpc.request('session/list', cursor ? { cursor } : {}, 15000);
        for (const item of result && Array.isArray(result.sessions) ? result.sessions : []) sessions.push(item);
        cursor = result && typeof result.nextCursor === 'string' && result.nextCursor.length <= 2048 ? result.nextCursor : '';
        if (!cursor) break;
      }
      return sessions.slice(0, MAX_SESSIONS);
    });
  }

  async function listSessions() {
    try {
      const sessions = await rawSessionList();
      return sessions.filter((item) => item && SAFE_SESSION.test(item.sessionId || '') && path.isAbsolute(item.cwd || ''))
        .map((item) => ({
          id: item.sessionId,
          cwd: item.cwd,
          title: String(item.title || 'جلسة Kimi Code').replace(/\s+/g, ' ').slice(0, 90),
          mtime: Number.isFinite(Date.parse(item.updatedAt || '')) ? Date.parse(item.updatedAt) : 0,
        }))
        .sort((left, right) => right.mtime - left.mtime);
    } catch { return []; }
  }

  async function readSession(id) {
    if (!SAFE_SESSION.test(id || '')) return { error: 'bad_args' };
    let session;
    try { session = (await rawSessionList()).find((item) => item && item.sessionId === id); }
    catch { return { error: 'not_found' }; }
    if (!session || !path.isAbsolute(session.cwd || '')) return { error: 'not_found' };
    const messages = [];
    const toolCalls = new Map();
    const onNotification = (method, params) => {
      if (method !== 'session/update') return;
      const update = params.update || {};
      // نداءات الأدوات من التاريخ المعاد بثه تُدرج كرسائل مساعد بكتلة tool_use موحّدة
      // (الاسم عبر التسميات العربية، والمدخل منقّى كما في البث الحي). النتائج الكاملة
      // غير مطلوبة — يكفي الاسم والحالة النهائية لاستعادة السياق بصرياً.
      if (update.sessionUpdate === 'tool_call') {
        const id = String(update.toolCallId || '');
        if (!id || toolCalls.has(id)) return;
        const block = {
          type: 'tool_use', id, name: toolLabel(update.title || 'Kimi Tool'),
          input: safeToolInput(update.rawInput), status: update.status || 'pending',
        };
        toolCalls.set(id, block);
        messages.push({ role: 'assistant', toolUse: block });
        return;
      }
      if (update.sessionUpdate === 'tool_call_update') {
        const block = toolCalls.get(String(update.toolCallId || ''));
        if (block && update.status) block.status = update.status;
        return;
      }
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user'
        : update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : '';
      if (!role || !update.content || update.content.type !== 'text') return;
      const messageId = update.messageId || role + '_' + messages.length;
      const last = messages[messages.length - 1];
      if (last && !last.toolUse && last.role === role && last.messageId === messageId) last.text += update.content.text || '';
      else messages.push({ role, messageId, text: update.content.text || '' });
    };
    try {
      await withProbe(async (rpc, initialized) => {
        if (!initialized.agentCapabilities || !initialized.agentCapabilities.loadSession) throw new Error('unsupported');
        await rpc.request('session/load', { sessionId: id, cwd: session.cwd, mcpServers: [] }, 30000);
      }, onNotification);
    } catch { return { error: 'not_found' }; }
    const clean = messages.filter((item) => item.toolUse || (item.text && item.text.trim()))
      .map((item) => item.toolUse ? { role: item.role, content: [item.toolUse] } : { role: item.role, text: item.text });
    return { cwd: session.cwd, total: clean.length, messages: clean.slice(-MAX_MESSAGES) };
  }

  async function contextUsage(cwd, id) {
    if (!SAFE_SESSION.test(id || '')) return { ok: false, error: 'ابدأ جلسة Kimi أولاً' };
    let capture = false;
    let output = '';
    try {
      await withProbe(async (rpc, initialized) => {
        const capabilities = initialized.agentCapabilities || {};
        const lifecycle = { cwd: path.resolve(cwd || os.homedir()), sessionId: id, mcpServers: [] };
        const canResume = capabilities.sessionCapabilities && capabilities.sessionCapabilities.resume;
        if (canResume) {
          try { await rpc.request('session/resume', lifecycle, 30000); }
          catch (error) {
            if (!error || error.code !== -32601 || !capabilities.loadSession) throw error;
            await rpc.request('session/load', lifecycle, 30000);
          }
        } else if (capabilities.loadSession) await rpc.request('session/load', lifecycle, 30000);
        else throw new Error('إصدار Kimi ACP لا يدعم استئناف الجلسة');
        capture = true;
        await rpc.request('session/prompt', {
          sessionId: id, prompt: [{ type: 'text', text: '/usage' }],
        }, 30000);
      }, (method, params) => {
        const update = params && params.update || {};
        if (capture && method === 'session/update' && update.sessionUpdate === 'agent_message_chunk'
            && update.content && update.content.type === 'text') output += update.content.text || '';
      });
      const usage = parseUsageText(output);
      return usage ? { ok: true, usage } : { ok: false, error: 'تعذّر قراءة استخدام سياق Kimi' };
    } catch (error) {
      return { ok: false, error: scrubError(error && error.message) };
    }
  }

  // نماذج Kimi المعلنة رسمياً: جسّ قصير العمر (session/new ثم قراءة خيار model من
  // configOptions). يُخزَّن دقيقتين حتى لا تُفتح عملية `kimi acp` عند كل فتح لقائمة
  // النماذج في الواجهة. أي فشل يعيد قائمة فارغة (لا رمي) فتبقى القائمة الثابتة في الواجهة.
  const MODELS_CACHE_TTL = 2 * 60 * 1000;
  let modelsCache = null;
  let modelsCacheAt = 0;
  async function listModels() {
    if (modelsCache && Date.now() - modelsCacheAt < MODELS_CACHE_TTL) return modelsCache;
    try {
      const models = await withProbe(async (rpc) => {
        const created = await rpc.request('session/new', { cwd: os.homedir(), mcpServers: [] }, 30000);
        const options = created && Array.isArray(created.configOptions) ? created.configOptions : [];
        const modelOption = options.find((item) => item && item.id === 'model');
        // المعرّف هو القيمة الكاملة (kimi-code/k3) — configValue يطابقها تاماً عند الإرسال.
        return configOptionValues(modelOption)
          .filter((item) => /^[A-Za-z0-9./-]{1,64}$/.test(item.value))
          .map((item) => ({ id: item.value, name: String(item.name || item.value).slice(0, 60) }))
          .slice(0, 12);
      });
      if (!models.length) return [];
      modelsCache = models;
      modelsCacheAt = Date.now();
      return models;
    } catch { return []; }
  }

  return { start, listSessions, readSession, contextUsage, listModels, keepalive };
}

const runtime = create();

// مساعد تسجيل الدخول: يُبنى الأمر بصيغة PowerShell الآمنة ويُنقّى cwd إلى مجلد موجود.
function loginCommand(bin) {
  return '& "' + bin + '" login';
}

function loginCwd(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  if (!raw) return os.homedir();
  try {
    if (fs.statSync(raw).isDirectory()) return raw;
  } catch { /* يسقط إلى homedir */ }
  return os.homedir();
}

module.exports = {
  ENGINE_ID, DEFAULT_MODEL, SAFE_SESSION, publicInfo, resolveKimiBin, authStatus, undoEdit,
  start: runtime.start, listSessions: runtime.listSessions, readSession: runtime.readSession,
  contextUsage: runtime.contextUsage, listModels: runtime.listModels,
  keepalive: runtime.keepalive,
  create,
  _internals: {
    inside, safeExistingPath, safeWritablePath, safePlanPath, selectedOutcome, spawnKimi, scrubError,
    buildSatrMcpTools, configOptionValues, configValue, parseUsageText, parseCompactionText,
    toolLabel, isEmbeddedMcpTool, loginCommand, loginCwd,
  },
};
