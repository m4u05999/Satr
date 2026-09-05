/**
 * أدوات الوكيل للمحوّلات «العمياء» (الدفعة 2.1 من ROADMAP.md).
 *
 * هذه بذرة «حلقة الوكيل الخاصة»: النموذج (DeepSeek/Qwen/… عبر tool-calling) يطلب
 * أداة، «سطر» ينفّذها محلياً ويعيد النتيجة، فيرث كل مزوّد الوكيل كاملاً دون أن
 * يملك أدوات بنفسه. 2.1 = قراءة فقط (read_file / list_files)؛ أدوات الكتابة
 * والتنفيذ تأتي في 2.2/2.3 مع مربع الإذن العربي.
 *
 * 🔒 أمان: التنفيذ يعيد استخدام مسارات مؤمَّنة قائمة — files.readText (داخل cwd
 * حصراً، رفض الثنائي، سقف حجم) و files.listFiles (مشي محدود). لا صدفة ولا spawn.
 * النتائج نصوص مقصوصة بسقف يحمي نافذة سياق النموذج.
 *
 * التعريفات بصيغة OpenAI tools (type:function + JSON Schema) — وهي لغة النموذج
 * (بالإنجليزية عمداً: أوثق عبر النماذج المتعددة)؛ رسائل الأخطاء بالعربية تصل
 * النموذج فيشرحها للمستخدم بلغته.
 */

const fs = require('fs');
const path = require('path');
const files = require('./files');
const search = require('./search'); // بحث «دلالي خفيف» (4.6) — أداة search_code
const repomap = require('./repomap'); // خريطة رموز/ملفات تقريبية للمزوّدات العمياء
const inject = require('./inject'); // resolveInside — تحقق مسار موحّد
const skills = require('./skills'); // مهارات محمولة: تحميل تدريجي لـ SKILL.md وموارده
const verify = require('./verify'); // تحقق صريح من .satr/verify.json — لا تشغيل تلقائي
const memory = require('./memory'); // اقتراح ذاكرة فقط؛ الحفظ الصريح يتم من الواجهة
const { computeDiff } = require('./diff');
const term = require('./term'); // طرفية النموذج المرئية (2.3) — نفس مفرد المرحلة 16
const termjobs = require('./termjobs');
const bgprocs = require('./bgprocs');

const MAX_RESULT = 48 * 1024;  // سقف نتيجة الأداة (محارف) — حماية سياق النموذج
const MAX_LIST = 1500;         // سقف أسطر list_files
const MAX_WRITE = 1024 * 1024; // سقف محتوى كتابة واحد (1م.ب)
const MAX_EDIT_SRC = 2 * 1024 * 1024; // لا تعديل على ملف أكبر (حماية ذاكرة + تراجع مضمون)
const MAX_EDIT_BLOCKS = 100;   // سقف كتل edit_file في النداء الذرّي الواحد
const MAX_SESSION_READS = 512; // سقف الملفات المتذكّرة لكل جلسة أدوات
const GENMEDIA_MISSING = 'ميزة التوليد لم تكتمل بعد';
const GENMEDIA_FILE = path.join(__dirname, 'genmedia.js');
const MEDIA_KINDS = new Set(['image', 'video', 'audio']);
let cachedGenmedia = null;

function resolveGenmedia(override) {
  if (override === null) return null;
  if (override && typeof override.estimate === 'function' && typeof override.generate === 'function') return override;
  if (cachedGenmedia) return cachedGenmedia;
  if (!fs.existsSync(GENMEDIA_FILE)) return null;
  try {
    const loaded = require(GENMEDIA_FILE);
    if (!loaded || typeof loaded.estimate !== 'function' || typeof loaded.generate !== 'function') return null;
    cachedGenmedia = loaded;
    return loaded;
  } catch {
    return null;
  }
}

function mediaRequest(cwd, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const kind = MEDIA_KINDS.has(input.kind) ? input.kind : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const count = input.count == null ? undefined : input.count;
  const refs = input.refs == null ? undefined : input.refs;
  const budget = input.budget_usd == null ? undefined : input.budget_usd;
  if (!kind || !prompt.trim()) return { ok: false, error: 'bad_input' };
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 4)) return { ok: false, error: 'bad_count' };
  if (refs !== undefined && (!Array.isArray(refs) || refs.length > 6 || refs.some((item) => typeof item !== 'string'))) {
    return { ok: false, error: 'bad_refs' };
  }
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) return { ok: false, error: 'bad_budget' };
  const request = { cwd, kind, prompt };
  if (typeof input.model === 'string' && input.model.trim()) request.model = input.model.trim();
  if (count !== undefined) request.count = count;
  if (refs !== undefined) request.refs = refs.slice();
  if (budget !== undefined) request.budget_usd = budget;
  return { ok: true, request };
}

function mediaObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  for (const key of ['estimate', 'result', 'entry', 'record', 'selected']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) return { ...value, ...value[key] };
  }
  return value;
}

function mediaToken(value, maxLength) {
  const cleaned = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()
    : '';
  return /^[A-Za-z0-9._/-]+$/.test(cleaned) && !memory.hasSecret(cleaned) ? cleaned.slice(0, maxLength) : '';
}

function mediaCost(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100000 ? number : 0;
}

function normalizeMediaEstimate(raw, request) {
  const item = mediaObject(raw);
  if (!raw || raw.ok === false || item.ok === false) {
    return { ok: false, error: mediaToken((item && item.error_code) || '', 64) || 'estimate_failed' };
  }
  const provider = mediaToken(item.provider || item.provider_id, 32);
  const model = mediaToken(item.model || request.model, 160);
  const cost = mediaCost(item.cost_usd_estimate ?? item.cost_usd ?? item.estimated_cost_usd ?? item.total_cost_usd);
  const count = Number.isInteger(item.count) && item.count >= 1 && item.count <= 4
    ? item.count : (request.count || 1);
  return {
    ok: true,
    provider: provider || 'auto',
    model: model || 'auto',
    count,
    cost_usd_estimate: cost,
    catalog_date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.catalog_date || '')) ? item.catalog_date : '',
  };
}

function mediaErrorText(error) {
  if (error === 'unavailable') return GENMEDIA_MISSING;
  if (error === 'over_budget') return 'رُفض التوليد لأن الكلفة التقديرية تتجاوز budget_usd.';
  if (error === 'missing_key' || error === 'no_provider') return 'لا يوجد مفتاح مزوّد مناسب لنوع التوليد المطلوب.';
  if (error === 'bad_count' || error === 'bad_refs' || error === 'bad_budget' || error === 'bad_input') {
    return 'مدخلات generate_media غير صالحة.';
  }
  return 'تعذّر تجهيز توليد الوسائط' + (error ? ' (' + error + ')' : '') + '.';
}

async function generationPermission(cwd, args, ctx) {
  const prepared = mediaRequest(cwd, args);
  if (!prepared.ok) return { ok: false, error: prepared.error, content: mediaErrorText(prepared.error) };
  const genmedia = resolveGenmedia(ctx && ctx.genmedia);
  if (!genmedia) return { ok: false, error: 'unavailable', content: GENMEDIA_MISSING };
  let raw;
  try { raw = await genmedia.estimate(prepared.request); }
  catch { return { ok: false, error: 'estimate_failed', content: mediaErrorText('estimate_failed') }; }
  const estimate = normalizeMediaEstimate(raw, prepared.request);
  if (!estimate.ok) return { ...estimate, content: mediaErrorText(estimate.error) };
  const current = mediaCost(ctx && ctx.mediaCostState && ctx.mediaCostState.total);
  return {
    ok: true,
    request: prepared.request,
    estimate,
    input: {
      kind: prepared.request.kind,
      provider: estimate.provider,
      model: estimate.model,
      count: estimate.count,
      cost_usd_estimate: estimate.cost_usd_estimate,
      session_cost_usd_estimate: current + estimate.cost_usd_estimate,
      ...(estimate.catalog_date ? { catalog_date: estimate.catalog_date } : {}),
    },
  };
}

function safeMediaRel(cwd, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.win32.isAbsolute(value)) return '';
  const rel = value.replace(/\\/g, '/');
  if (!rel.startsWith('generations/') || rel.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, rel);
  return resolved.startsWith(root + path.sep) && !memory.hasSecret(rel) ? rel.slice(0, 1000) : '';
}

function formatMediaResult(cwd, raw, estimate, request) {
  const item = mediaObject(raw);
  const error = mediaToken((item && item.error_code) || '', 64);
  if (!raw || raw.ok === false || item.ok === false || item.status === 'failed') {
    return { ok: false, content: mediaErrorText(error || 'generation_failed'), cost: 0 };
  }
  const candidates = Array.isArray(item.files) ? item.files : Array.isArray(item.assets) ? item.assets : [];
  const paths = candidates.map((value) => safeMediaRel(cwd, value)).filter(Boolean).slice(0, 4);
  const cost = mediaCost(item.cost_usd_estimate ?? item.cost_usd ?? item.estimated_cost_usd
    ?? (estimate && estimate.cost_usd_estimate));
  const provider = mediaToken(item.provider, 32) || mediaToken(estimate && estimate.provider, 32) || 'auto';
  const model = mediaToken(item.model, 160) || mediaToken(estimate && estimate.model, 160) || 'auto';
  const kind = MEDIA_KINDS.has(item.kind) ? item.kind : request && request.kind;
  const fallbackValues = Array.isArray(item.fallbacks) ? item.fallbacks
    : Array.isArray(item.fallback) ? item.fallback : item.fallback ? [item.fallback] : [];
  const fallbacks = fallbackValues.map((value) => {
    if (typeof value === 'string') {
      const parts = value.split(/\s*(?:→|->)\s*/).map((part) => mediaToken(part, 32)).filter(Boolean);
      return parts.length === 2 ? parts[0] + ' → ' + parts[1] : (parts[0] || '');
    }
    if (!value || typeof value !== 'object') return '';
    const from = mediaToken(value.from || value.provider, 32);
    const to = mediaToken(value.to || value.fallback_provider, 32);
    return from && to ? from + ' → ' + to : (to || from);
  }).filter(Boolean).slice(0, 4);
  const lines = [
    paths.length ? 'اكتمل توليد الوسائط:' : 'اكتمل طلب التوليد بلا مسار أصل صالح.',
    ...paths.map((rel) => '- ' + rel),
    'الكلفة التقديرية: $' + cost.toFixed(6),
    provider ? 'المزوّد: ' + provider : '',
    model ? 'النموذج: ' + model : '',
    fallbacks.length ? 'سقوط المزوّد: ' + fallbacks.join('، ') : '',
  ].filter(Boolean);
  const event = paths.length && MEDIA_KINDS.has(kind) ? {
    type: 'generation_done',
    kind,
    files: paths,
    cost_usd_estimate: cost,
    provider,
    model,
  } : null;
  return { ok: paths.length > 0, content: lines.join('\n'), cost: paths.length ? cost : 0, event };
}

async function runGenerateMedia(cwd, args, ctx) {
  const permission = await generationPermission(cwd, args, ctx);
  if (!permission.ok) return { ok: false, content: permission.content };
  const genmedia = resolveGenmedia(ctx && ctx.genmedia);
  let raw;
  try { raw = await genmedia.generate(permission.request, ctx || {}); }
  catch { return { ok: false, content: mediaErrorText('generation_failed') }; }
  const formatted = formatMediaResult(cwd, raw, permission.estimate, permission.request);
  if (formatted.ok && ctx && ctx.mediaCostState) {
    ctx.mediaCostState.total = mediaCost(ctx.mediaCostState.total) + formatted.cost;
  }
  if (formatted.ok && formatted.event && ctx && typeof ctx.emit === 'function') {
    try { ctx.emit(formatted.event); } catch { /* بث العرض أفضل جهد ولا يغيّر نجاح التوليد */ }
  }
  return { ok: formatted.ok, content: formatted.content };
}

// ---------- أدوات الكتابة (الدفعة 2.2): إذن عربي إلزامي + diff + تراجع ----------
// نفس نموذج agent.js: لقطة «قبل» لكل تعديل تعيش بعد الدور ليعمل «تراجع» لاحقاً.
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const editSnapshots = new Map(); // call_id → { file_path, before|null }
const MAX_SNAPSHOTS = 40;

// بوابة «اقرأ قبل التعديل» لا ترى إلا read_file المنفّذة هنا. باعث الدور هو أقرب
// هوية جلسة متاحة بلا توسيع عقد المحوّلات؛ كل محوّل يعيد استعماله بين نداءات أدوات
// الدور نفسه. الغياب مخصّص للمستهلكات البرمجية القديمة ويأخذ جلسة محلية واحدة.
const anonymousReadSession = {};
const sessionReads = new WeakMap(); // session token → Set<absolute normalized path>

function readSessionToken(ctx) {
  if (ctx && (typeof ctx.sessionToken === 'object' || typeof ctx.sessionToken === 'function') && ctx.sessionToken) {
    return ctx.sessionToken;
  }
  return ctx && typeof ctx.emit === 'function' ? ctx.emit : anonymousReadSession;
}

function canonicalReadPath(abs) {
  const normalized = path.resolve(abs).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function rememberSessionRead(ctx, abs) {
  const token = readSessionToken(ctx);
  let reads = sessionReads.get(token);
  if (!reads) { reads = new Set(); sessionReads.set(token, reads); }
  const target = canonicalReadPath(abs);
  reads.delete(target);
  reads.add(target);
  while (reads.size > MAX_SESSION_READS) reads.delete(reads.values().next().value);
}

function wasReadInSession(ctx, abs) {
  const reads = sessionReads.get(readSessionToken(ctx));
  return !!(reads && reads.has(canonicalReadPath(abs)));
}

function rememberSnapshot(id, snap) {
  editSnapshots.set(id, snap);
  while (editSnapshots.size > MAX_SNAPSHOTS) {
    editSnapshots.delete(editSnapshots.keys().next().value);
  }
}

// «تراجع» عن تعديل أداة محوّل — نظير agent.undoEdit (main.js يجرّب الاثنين)
function undoEdit(id) {
  const snap = editSnapshots.get(id);
  if (!snap) return { ok: false, error: 'expired' };
  try {
    if (snap.before == null) {
      try { fs.unlinkSync(snap.file_path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else {
      fs.writeFileSync(snap.file_path, snap.before, 'utf8');
    }
    editSnapshots.delete(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// طبقة إذن الأداة (المحوّل يسأل قبل التنفيذ — مربع الإذن العربي):
// 'write' = كتابة ملفات (يعفيها acceptEdits و«موافقة دائمة»)
// 'exec'  = تنفيذ أوامر (2.3 — موافقة إلزامية كل مرة؛ bypassPermissions وحده يعفيها)
// null    = قراءة بلا إذن (تطابق Claude Code)
function permissionTier(name) {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'run_command' || name === 'verify_project'
    || name === 'run_in_background' || name === 'stop_background_task'
    || name === 'generate_media') return 'exec';
  return null;
}
function needsPermission(name) { return permissionTier(name) !== null; }

// تعريفات الأدوات المعلنة للنموذج (بروتوكول OpenAI Chat Completions)
const DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "Read a text file from the user's project. Use it to inspect code before answering. Path must be relative to the project root (e.g. src/index.html).",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project, forward slashes' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "List the files of the user's project as relative paths, one per line. Use it to discover the project structure before reading files.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: "Search all project files for text (grep-like). Returns matching lines as path:line: excerpt, best-matching files first. Matching is lenient: case-insensitive, Arabic diacritics and letter variants ignored, and substrings match inside identifiers (searching 'save viewer' finds saveFromViewer). Use it to locate where something is defined or handled instead of reading whole files.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Space-separated words to search for (1-8 words, 2+ characters each)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_map',
      description: "Build a compact approximate map of the user's repository before choosing files to read. Returns prioritized file paths and prominent regex-detected definitions (function/class/const/export) with line numbers. This is an estimate, not a parser; verify with search_code and read_file before editing.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional task keywords used only to prioritize relevant paths and symbols (up to 8 terms)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verification_config',
      description: 'Read the explicit .satr/verify.json checks approved for this project. This only reads configuration and never runs commands.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_project',
      description: 'Run configured verification checks from .satr/verify.json in the visible terminal after user permission. Never invent commands. Provide the exact ledger task title so evidence can be linked.',
      parameters: {
        type: 'object',
        properties: {
          checks: { type: 'array', items: { type: 'string' }, description: 'Configured check IDs; omit or empty means all configured checks' },
          task_title: { type: 'string', description: 'Exact visible Task Ledger title to receive verification evidence' },
        },
        required: ['task_title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_ledger',
      description: 'Create or update the visible persistent task plan. Include status, dependencies, owner, and concrete verification evidence when available. Use replace for a complete plan and merge for incremental updates.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['replace', 'merge'] },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
                dependencies: { type: 'array', items: { type: 'string' } },
                owner: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'title', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_memory',
      description: 'Propose one durable project memory for explicit user review. This never saves by itself. Use only for a fact, decision, reusable command, or failure lesson that will matter in later turns. Never include secrets. Mark shareable team knowledge so the UI recommends AGENTS.md or a Skill instead.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'decision', 'command', 'failure'] },
          content: { type: 'string', description: 'Concise durable knowledge, without credentials or secret values' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          scope_type: { type: 'string', enum: ['project', 'path'] },
          path: { type: 'string', description: 'Relative project path when scope_type is path' },
          source: { type: 'string', description: 'Short provenance, such as a user statement, file, command result, or failure' },
          shareable: { type: 'boolean', description: 'True when this belongs in AGENTS.md or a reusable Skill for the team' },
        },
        required: ['kind', 'content', 'confidence', 'scope_type', 'source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: "Load the instructions for one enabled Satr Agent Skill when its description matches the current task. Skills use progressive disclosure: call this only when relevant. Bundled scripts are resources to inspect, never automatic commands.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact enabled skill name from the portable skills catalog' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_resource',
      description: "Read one text resource bundled with an enabled Agent Skill after load_skill lists it. The path must be relative to that skill directory. This reads content only and never executes scripts.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact enabled skill name' },
          resource: { type: 'string', description: 'Relative resource path returned by load_skill' },
        },
        required: ['name', 'resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: "Create a new file or completely overwrite an existing file in the user's project. The user is asked for permission first. Prefer edit_file for small changes to existing files.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project' },
          content: { type: 'string', description: 'Full new content of the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: "Delete a file from the user's project. The user is asked for permission first. This is reliable for any filename (including Arabic names) — prefer it over shell commands like del/rm for deleting files.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_media',
      description: 'Generate image, video, or audio assets in the project generations/ folder. This always shows the selected provider, model, count, estimated cost, and session cumulative cost for one-time approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          prompt: { type: 'string', description: 'Media generation prompt' },
          model: { type: 'string', description: 'Optional catalog model ID' },
          count: { type: 'integer', minimum: 1, maximum: 4 },
          refs: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          budget_usd: { type: 'number', minimum: 0 },
        },
        required: ['kind', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: "Run a single-line shell command (PowerShell on Windows) in the user's visible terminal and return its output. The user must approve each command. Long-running interactive apps (servers) will be cut by the timeout.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'One-line shell command to run' },
          timeout_seconds: { type: 'number', description: 'Optional timeout in seconds (default 120, max 600)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_in_background',
      description: "Start a development server or long-running task in a persistent visible Satr terminal tab. It survives the turn and chat session until stopped.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'One-line shell command' },
          label: { type: 'string', description: 'Short label for the visible terminal tab' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_background_output',
      description: 'Read the tail of a persistent Satr background terminal without stopping it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tail_lines: { type: 'integer', minimum: 1, maximum: 2000 },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_background_task',
      description: 'Block until a persistent Satr background job exits, then return its exit code and log tail. Use this instead of a sleep + list_background_tasks polling loop. On timeout it returns status=running so you can extend the wait with one more call.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_background_tasks',
      description: 'List persistent Satr terminal jobs and legacy tracked background processes, plus the most recent jobs that exited with their exit codes. Call before starting another server.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_background_task',
      description: 'Stop one persistent background task. The user is asked for permission every time.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      // الوصف مشدود عمداً: يُشحن للنموذج كل دور، ويدخل حزمة satr-guide المسقوفة بـ40KiB
      // (تجاوزها التوليدُ بـ61 بايتاً بعد تحصين OBS-108/edit_file). القاعدة المكتوبة في
      // CLAUDE.md: «شدّ النثر لا رفع السقف». المعاني الخمسة كلها محفوظة: الذرّية،
      // استقلال الترتيب، القراءة أولاً، الارتداد الوحيد بالمسافات، والإذن.
      description: "Edit an existing file with atomic search/replace blocks: old_string/new_string for one, or edits[] for several (order-independent). Read the file first. Exact match, then a unique whitespace-only fallback. Asks permission.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
          edits: {
            type: 'array', minItems: 1, maxItems: MAX_EDIT_BLOCKS,
            description: 'Atomic order-independent search/replace blocks; use instead of top-level old_string/new_string',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Exact text to replace' },
                new_string: { type: 'string', description: 'Replacement text' },
                replace_all: { type: 'boolean', description: 'Replace every exact occurrence (default false)' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path'],
      },
    },
  },
];

function nullableSchema(schema) {
  const out = { ...schema };
  if (typeof out.type === 'string') out.type = [out.type, 'null'];
  else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = out.type.concat('null');
  if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = out.enum.concat(null);
  return out;
}

// OpenAI strict tools تشترط منع الخصائص الزائدة واعتبار كل خاصية required؛
// الاختياري الأصلي يبقى اختيارياً دلالياً عبر قبول null. لا نعدّل DEFS المشتركة.
function strictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (schema.items) out.items = strictSchema(schema.items);
  if (schema.properties && typeof schema.properties === 'object') {
    const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = {};
    for (const [name, value] of Object.entries(schema.properties)) {
      const strictValue = strictSchema(value);
      properties[name] = originallyRequired.has(name) ? strictValue : nullableSchema(strictValue);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

const STRICT_DEFS = DEFS.map((definition) => ({
  ...definition,
  function: {
    ...definition.function,
    strict: true,
    parameters: strictSchema(definition.function.parameters),
  },
}));

function defs(options) {
  return options && options.strictTools === true ? STRICT_DEFS : DEFS;
}

// ترجمة أخطاء readText لنص عربي يفهمه النموذج (ويشرحه للمستخدم عند الحاجة)
const READ_ERRORS = {
  outside: 'المسار خارج مجلد المشروع — مسموح فقط بمسارات نسبية داخله',
  notfound: 'الملف غير موجود — استخدم list_files لمعرفة المسارات الصحيحة',
  binary: 'ملف ثنائي — لا يمكن قراءته نصاً',
  error: 'تعذّرت قراءة الملف',
};

// حلّ مسار داخل cwd مع تسامح تطبيع Unicode (حرج للأسماء العربية): إن لم يوجد المسار
// حرفياً، نطابق أسماء المجلد بعد التطبيع (NFC) — يعالج اختلاف NFC/NFD بين ما يكتبه
// النموذج وما هو مخزَّن فعلاً على القرص. يعيد المسار المطلق الفعلي أو الأصلي.
function resolveExisting(cwd, rel) {
  const abs = inject.resolveInside(cwd, rel);
  if (!abs) return null;
  if (fs.existsSync(abs)) return abs;
  try {
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    const want = base.normalize('NFC');
    for (const name of fs.readdirSync(dir)) {
      if (name.normalize('NFC') === want) return path.join(dir, name);
    }
  } catch { /* المجلد غير موجود — يبقى المسار الأصلي */ }
  return abs;
}

// قراءة «قبل» لملف تعديل: null = ملف جديد؛ يرمي إن كان ثنائياً أو ضخماً
function readBefore(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; } // غير موجود — ملف جديد
  if (!st.isFile()) throw new Error('المسار ليس ملفاً');
  if (st.size > MAX_EDIT_SRC) throw new Error('الملف أكبر من حدّ التعديل (2م.ب)');
  const buf = fs.readFileSync(abs);
  if (inject.looksBinary(buf)) throw new Error('ملف ثنائي — لا يُعدَّل نصاً');
  return buf.toString('utf8');
}

// كتابة + لقطة تراجع + بطاقة diff للواجهة (نفس عقد file_edit في مسار SDK)
function commitWrite(ctx, cwd, toolName, rel, abs, before, after) {
  fs.mkdirSync(path.dirname(abs), { recursive: true }); // مجلدات وسيطة (داخل cwd حتماً)
  fs.writeFileSync(abs, after, 'utf8');
  const id = (ctx && ctx.id) || ('tool_' + Math.random().toString(36).slice(2));
  rememberSnapshot(id, { file_path: abs, before });
  if (ctx && typeof ctx.emit === 'function') {
    const d = computeDiff(before == null ? '' : before, after);
    ctx.emit({
      type: 'file_edit', id, tool: toolName,
      rel, isNew: before == null,
      added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
    });
  }
}

function parseEditBlocks(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const hasBatch = input.edits != null;
  const hasSingle = input.old_string != null || input.new_string != null;
  if (hasBatch && hasSingle) {
    return { ok: false, error: 'خطأ: مرّر edits أو old_string/new_string، لا الصيغتين معاً — لم يُكتب شيء' };
  }
  const raw = hasBatch ? input.edits : [{
    old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all,
  }];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'خطأ: edits يجب أن تكون مصفوفة غير فارغة — لم يُكتب شيء' };
  }
  if (raw.length > MAX_EDIT_BLOCKS) {
    return { ok: false, error: 'خطأ: عدد كتل التعديل تجاوز السقف (' + MAX_EDIT_BLOCKS + ') — قسّم النداء ولم يُكتب شيء' };
  }
  const blocks = [];
  for (let i = 0; i < raw.length; i++) {
    const block = raw[i];
    if (!block || typeof block !== 'object' || Array.isArray(block)
        || typeof block.old_string !== 'string' || !block.old_string
        || typeof block.new_string !== 'string') {
      return { ok: false, error: 'خطأ: الكتلة ' + (i + 1) + ' تحتاج old_string غير فارغة وnew_string نصية — لم يُكتب شيء' };
    }
    blocks.push({
      oldString: block.old_string,
      newString: block.new_string,
      replaceAll: !!block.replace_all,
      index: i,
    });
  }
  return { ok: true, blocks, multi: hasBatch };
}

function exactMatchRanges(content, needle) {
  const ranges = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const start = content.indexOf(needle, from);
    if (start === -1) break;
    ranges.push({ start, end: start + needle.length });
    from = start + needle.length; // يطابق سلوك split/join القديم: مواضع غير متداخلة
  }
  return ranges;
}

function contentLineRecords(content) {
  const records = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) {
      records.push({ start, end: content.length, text: content.slice(start), eol: '' });
      break;
    }
    const end = newline > start && content[newline - 1] === '\r' ? newline - 1 : newline;
    records.push({ start, end, text: content.slice(start, end), eol: content.slice(end, newline + 1) });
    start = newline + 1;
  }
  return records;
}

// الارتداد محدود عمداً: نفس عدد الأسطر ونفس متن كل سطر بعد حذف المسافات
// البادئة/اللاحقة فقط. لا تشابه تقريبي ولا طيّ لمسافات داخلية.
function whitespaceMatchRanges(content, needle) {
  const records = contentLineRecords(content);
  const oldLines = needle.replace(/\r\n?/g, '\n').split('\n');
  const normalized = oldLines.map((line) => line.trim());
  if (normalized.every((line) => !line)) return [];
  const matches = [];
  for (let startLine = 0; startLine + normalized.length <= records.length; startLine++) {
    let matchesBlock = true;
    for (let offset = 0; offset < normalized.length; offset++) {
      if (records[startLine + offset].text.trim() !== normalized[offset]) {
        matchesBlock = false;
        break;
      }
    }
    if (!matchesBlock) continue;
    const endLine = startLine + normalized.length - 1;
    matches.push({
      start: records[startLine].start,
      end: records[endLine].end,
      actualLines: records.slice(startLine, endLine + 1).map((record) => record.text),
      eol: records.slice(startLine, endLine + 1).find((record) => record.eol)?.eol
        || (content.includes('\r\n') ? '\r\n' : '\n'),
    });
  }
  return matches;
}

function leadingWhitespace(line) {
  const match = /^[\t ]*/.exec(line);
  return match ? match[0] : '';
}

function firstContentIndent(lines) {
  const line = lines.find((item) => item.trim());
  return line == null ? '' : leadingWhitespace(line);
}

function adaptFallbackReplacement(actualLines, oldString, newString, eol) {
  const oldLines = oldString.replace(/\r\n?/g, '\n').split('\n');
  const newLines = newString.replace(/\r\n?/g, '\n').split('\n');
  const actualIndent = firstContentIndent(actualLines);
  const oldIndent = firstContentIndent(oldLines);
  return newLines.map((line) => {
    if (!line.trim()) return line;
    const leading = leadingWhitespace(line);
    const relative = oldIndent && leading.startsWith(oldIndent) ? leading.slice(oldIndent.length) : leading;
    return actualIndent + relative + line.slice(leading.length);
  }).join(eol);
}

// كل المديات تُستخرج من نسخة «قبل» نفسها؛ لذلك لا تستطيع كتلة إنشاء مطابقة لكتلة
// لاحقة أو إزاحة موضعها. أي تداخل يرفض الخطة كلها قبل commitWrite الوحيد.
function planEditBlocks(content, blocks) {
  const planned = [];
  let fallbackCount = 0;
  for (const block of blocks) {
    let matches = exactMatchRanges(content, block.oldString);
    if (matches.length > 1 && !block.replaceAll) {
      return {
        ok: false,
        error: 'خطأ: الكتلة ' + (block.index + 1) + ' تتكرر ' + matches.length
          + ' مرات حرفياً — وسّع سياق old_string أو مرّر replace_all: true؛ لم يُكتب شيء',
      };
    }
    if (matches.length === 0) {
      matches = whitespaceMatchRanges(content, block.oldString);
      if (matches.length > 1) {
        return {
          ok: false,
          error: 'خطأ: الكتلة ' + (block.index + 1) + ' تطابق ' + matches.length
            + ' مواضع بعد تطبيع المسافات البادئة/اللاحقة — وسّع السياق ليصبح التطابق وحيداً؛ لم يُكتب شيء',
        };
      }
      if (matches.length === 0) {
        return {
          ok: false,
          error: 'خطأ: الكتلة ' + (block.index + 1)
            + ' غير موجودة حرفياً ولا بعد تطبيع المسافات البادئة/اللاحقة — اقرأ الملف مجدداً وانسخ old_string من محتواه؛ لم يُكتب شيء',
        };
      }
      matches[0].replacement = adaptFallbackReplacement(
        matches[0].actualLines, block.oldString, block.newString, matches[0].eol,
      );
      fallbackCount++;
    }
    for (const match of matches) {
      planned.push({
        start: match.start, end: match.end,
        replacement: match.replacement == null ? block.newString : match.replacement,
        blockIndex: block.index,
      });
    }
  }
  const ascending = [...planned].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let i = 1; i < ascending.length; i++) {
    const previous = ascending[i - 1];
    const current = ascending[i];
    if (current.start < previous.end) {
      return {
        ok: false,
        error: 'خطأ: الكتلتان ' + (previous.blockIndex + 1) + ' و' + (current.blockIndex + 1)
          + ' تتصادمان على المدى نفسه أو على مديين متداخلين — افصل التعديلين؛ رُفض النداء كله ولم يُكتب شيء',
      };
    }
  }
  return { ok: true, planned, fallbackCount };
}

function applyPlannedEdits(content, planned) {
  let result = content;
  const descending = [...planned].sort((left, right) => right.start - left.start || right.end - left.end);
  for (const edit of descending) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/**
 * حفظ من عارض القراءة (تحرير خفيف — الدفعة 4): كتابة ملف **قائم** فقط بإعادة
 * استخدام المسار المؤمَّن نفسه — resolveExisting (تسامح NFC/NFD للأسماء العربية) +
 * readBefore (يرمي للثنائي/الضخم) + commitWrite (كتابة + لقطة تراجع) — فيأتي
 * «تراجع» (editSnapshots/undoEdit) وبيانات بطاقة diff مجاناً. لا يُنشئ ملفات
 * (العارض يفتح الموجود فقط). بطاقة file_edit تُعاد في الردّ نفسه (card) بدل بثّها
 * حدثاً: حدث خارج دور يسقط على حارس الكتلة في الواجهة — الردّ المتزامن أسلم ترتيباً.
 */
function saveFromViewer(cwd, rel, content, expectedVersion) {
  try {
    if (typeof content !== 'string' || content.length > MAX_WRITE) return { ok: false, error: 'too_big' };
    if (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)) {
      return { ok: false, error: 'bad_version' };
    }
    const abs = resolveExisting(cwd, rel);
    if (!abs) return { ok: false, error: 'outside' };
    const before = readBefore(abs); // يرمي للثنائي/الضخم — يلتقطه catch أدناه
    if (before == null) return { ok: false, error: 'notfound' }; // العارض لا ينشئ ملفات
    if (files.contentVersion(before) !== expectedVersion) return { ok: false, error: 'conflict' };
    const id = 'view_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    let card = null;
    commitWrite({ emit: (ev) => { card = ev; }, id }, cwd, 'viewer_edit', rel.replace(/\\/g, '/'), abs, before, content);
    return { ok: true, card };
  } catch (e) {
    return { ok: false, error: 'error', message: String((e && e.message) || e) };
  }
}

/**
 * تنفيذ أداة باسمها — يعيد دائماً { ok, content } والمحتوى نص يُعاد للنموذج
 * (الفشل نص خطأ عربي، لا استثناء — النموذج يصحح مساره بنفسه).
 * ctx (اختياري): { emit, id, sessionToken } — باعث الأحداث/رمز الجلسة يربطان قراءة
 * read_file بتعديلها، وid يربط بطاقة diff ببطاقة الأداة (أدوات الكتابة).
 * ⚠️ أدوات الكتابة يجب ألا تُستدعى إلا بعد موافقة المستخدم (needsPermission في المحوّل).
 */
async function run(name, cwd, args, ctx) {
  try {
    if (name === 'read_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (!rel) return { ok: false, content: 'خطأ: وسيطة path مطلوبة' };
      const r = files.readText(cwd, rel);
      if (!r.ok) return { ok: false, content: 'خطأ: ' + (READ_ERRORS[r.error] || r.error) };
      const readAbs = resolveExisting(cwd, rel);
      if (readAbs) rememberSessionRead(ctx, readAbs);
      let content = r.content;
      let truncated = r.truncated;
      if (content.length > MAX_RESULT) { content = content.slice(0, MAX_RESULT); truncated = true; }
      if (truncated) content += '\n…(قُصّ الملف هنا — تجاوز سقف حجم النتيجة)';
      // العيب ③: ملف عُدّل قبل لحظات قد يكون منتصف كتابة كاتب آخر — نقول ذلك بدل
      // تسليم نسخة ناقصة تبدو كاملة. تنبيه لا حجب: القراءة صحيحة لِما كان على القرص.
      if (r.recentlyWritten) {
        content = '⚠️ عُدّل هذا الملف قبل أقل من ثانيتين — قد تكون هذه نسخة منتصف كتابة.'
          + ' أعد قراءته إن بدا ناقصاً أو غير متسق.\n---\n' + content;
      }
      return { ok: true, content };
    }
    if (name === 'list_files') {
      const list = await files.listFiles(cwd);
      if (!list.length) return { ok: true, content: '(لا ملفات — المجلد فارغ أو غير مقروء)' };
      let content = list.slice(0, MAX_LIST).join('\n');
      if (list.length > MAX_LIST) content += '\n…(' + (list.length - MAX_LIST) + ' ملفاً آخر لم يُعرض)';
      return { ok: true, content };
    }
    if (name === 'search_code') {
      // بحث «دلالي خفيف» (الدفعة 4.6) — قراءة بلا إذن، نمط Grep في Claude Code
      const q = args && typeof args.query === 'string' ? args.query.trim() : '';
      if (!q) return { ok: false, content: 'خطأ: وسيطة query مطلوبة' };
      const r = await search.search(cwd, q);
      if (!r.ok) return { ok: false, content: 'خطأ: استعلام غير صالح — كلمة واحدة على الأقل من حرفين' };
      if (!r.hits.length) return { ok: true, content: '(لا نتائج — جرّب كلمات أخرى أو list_files)' };
      let content = r.hits
        .map((h) => h.rel + (h.line ? ':' + h.line : '') + ': ' + h.text)
        .join('\n');
      if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + '\n…(قُصّت النتائج)';
      if (r.partial) content += '\n(مسح جزئي — نفدت ميزانية الوقت قبل تغطية كل الملفات)';
      return { ok: true, content };
    }
    if (name === 'repo_map') {
      // خريطة تقريبية مقتصدة — قراءة بلا إذن، وتعيد استخدام files/search المؤمّنتين.
      const query = args && typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
      const result = await repomap.build(cwd, query);
      return { ok: true, content: result.text };
    }
    if (name === 'verification_config') {
      return { ok: true, content: verify.formatConfig(verify.loadConfig(cwd)) };
    }
    if (name === 'verify_project') {
      const taskTitle = args && typeof args.task_title === 'string' ? args.task_title.trim() : '';
      if (!taskTitle) return { ok: false, content: 'خطأ: task_title مطلوبة لربط دليل التحقق بالمهمة' };
      const result = await verify.run(cwd, args && args.checks, ctx);
      if (ctx && typeof ctx.emit === 'function') {
        ctx.emit({ type: 'verification_result', schema_version: 1, task_title: taskTitle, ...result });
      }
      return { ok: !!result.ok, content: verify.formatResult(result) };
    }
    if (name === 'update_task_ledger') {
      if (!ctx || typeof ctx.emit !== 'function') return { ok: false, content: 'تعذّر تحديث سجل المهام في هذا المحرك' };
      const taskList = args && Array.isArray(args.tasks) ? args.tasks : [];
      if (!taskList.length && (!args || args.mode !== 'replace')) return { ok: false, content: 'خطأ: tasks مطلوبة' };
      ctx.emit({
        type: 'task_update',
        schema_version: 1,
        mode: args && args.mode === 'replace' ? 'replace' : 'merge',
        source: 'adapter_tool',
        tasks: taskList,
      });
      return { ok: true, content: 'حُدّث سجل المهام المرئي والدائم.' };
    }
    if (name === 'propose_memory') {
      if (!ctx || typeof ctx.emit !== 'function') return { ok: false, content: 'تعذّر عرض اقتراح الذاكرة في هذا المحرك' };
      const result = memory.propose({
        kind: args && args.kind,
        content: args && args.content,
        confidence: args && args.confidence,
        scope: { type: args && args.scope_type, path: args && args.path },
        source: { type: 'agent', engine: ctx.engine || '', detail: args && args.source },
        shareable: !!(args && args.shareable),
      }, { type: 'agent', engine: ctx.engine || '' });
      if (!result.ok) {
        const message = result.error === 'secret'
          ? 'رُفض الاقتراح لأنه يشبه سراً أو مفتاحاً. لا تُعد إرساله ولا تعرض القيمة.'
          : 'اقتراح الذاكرة غير صالح: ' + result.error;
        return { ok: false, content: message };
      }
      ctx.emit({ type: 'memory_candidate', schema_version: 1, candidate: result.candidate });
      return { ok: true, content: 'عُرض اقتراح الذاكرة للمستخدم ولم يُحفظ. لن يدخل الذاكرة إلا إذا ضغط المستخدم «حفظ» صراحةً.' };
    }
    if (name === 'load_skill') {
      const skillName = args && typeof args.name === 'string' ? args.name.trim() : '';
      if (!skillName) return { ok: false, content: 'خطأ: وسيطة name مطلوبة' };
      const loaded = skills.loadSkill(ctx && ctx.skillContext, skillName);
      if (!loaded.ok) return { ok: false, content: 'خطأ: ' + (loaded.message || loaded.error) };
      const resources = loaded.resources.length
        ? loaded.resources.map((item) => '- ' + item.path + (Number.isFinite(item.bytes) ? ' (' + item.bytes + ' bytes)' : '')).join('\n')
        : '(لا موارد إضافية)';
      let content = loaded.instructions + '\n\n[Bundled resources — inspect with read_skill_resource; do not execute automatically]\n' + resources;
      if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + '\n…(قُصّت المهارة — تجاوزت سقف النتيجة)';
      return { ok: true, content };
    }
    if (name === 'read_skill_resource') {
      const skillName = args && typeof args.name === 'string' ? args.name.trim() : '';
      const resource = args && typeof args.resource === 'string' ? args.resource.trim() : '';
      if (!skillName || !resource) return { ok: false, content: 'خطأ: الوسيطتان name و resource مطلوبتان' };
      const loaded = skills.readResource(ctx && ctx.skillContext, skillName, resource);
      if (!loaded.ok) return { ok: false, content: 'خطأ: ' + (loaded.message || loaded.error) };
      let content = loaded.content;
      if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + '\n…(قُصّ المورد — تجاوز سقف النتيجة)';
      return { ok: true, content };
    }
    if (name === 'generate_media') return runGenerateMedia(cwd, args, ctx);
    if (name === 'write_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      const content = args && typeof args.content === 'string' ? args.content : null;
      if (!rel || content == null) return { ok: false, content: 'خطأ: الوسيطتان path و content مطلوبتان' };
      if (content.length > MAX_WRITE) return { ok: false, content: 'خطأ: المحتوى أكبر من سقف الكتابة (1م.ب)' };
      const abs = resolveExisting(cwd, rel); // تسامح تطبيع (يصيب الملف العربي القائم لا نسخة مكرّرة)
      if (!abs) return { ok: false, content: 'خطأ: ' + READ_ERRORS.outside };
      const before = readBefore(abs); // يرمي للثنائي/الضخم — يلتقطه catch أدناه
      commitWrite(ctx, cwd, name, rel.replace(/\\/g, '/'), abs, before, content);
      const n = content.split('\n').length;
      return { ok: true, content: (before == null ? 'أُنشئ الملف ' : 'استُبدل محتوى الملف ') + rel + ' (' + n + ' سطراً)' };
    }
    if (name === 'edit_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (!rel) return { ok: false, content: 'خطأ: الوسيطة path مطلوبة — لم يُكتب شيء' };
      const parsed = parseEditBlocks(args);
      if (!parsed.ok) return { ok: false, content: parsed.error };
      const abs = resolveExisting(cwd, rel); // تسامح تطبيع (أسماء عربية)
      if (!abs) return { ok: false, content: 'خطأ: ' + READ_ERRORS.outside };
      if (!wasReadInSession(ctx, abs)) {
        return {
          ok: false,
          content: 'خطأ: لم يُقرأ الملف في جلسة أدوات سطر الحالية — استخدم read_file على المسار نفسه أولاً. '
            + 'هذه البوابة تتتبّع read_file داخل أدوات سطر فقط، ولا تعرف ما قرأه المحرك الأصيل بأدواته؛ لم يُكتب شيء',
        };
      }
      const before = readBefore(abs);
      if (before == null) return { ok: false, content: 'خطأ: الملف غير موجود — استخدم write_file لإنشاء ملف جديد' };
      const plan = planEditBlocks(before, parsed.blocks);
      if (!plan.ok) return { ok: false, content: plan.error };
      const after = applyPlannedEdits(before, plan.planned);
      if (after.length > MAX_WRITE * 2) return { ok: false, content: 'خطأ: الناتج أكبر من الحد المسموح' };
      commitWrite(ctx, cwd, name, rel.replace(/\\/g, '/'), abs, before, after);
      const count = plan.planned.length;
      const detail = parsed.multi ? ' (' + parsed.blocks.length + ' كتل، ' + count + ' مواضع)'
        : (count > 1 ? ' (' + count + ' مواضع)' : '');
      const fallback = plan.fallbackCount
        ? ' — استُخدم تطبيع المسافات البادئة/اللاحقة في ' + plan.fallbackCount + ' كتلة فريدة'
        : '';
      return { ok: true, content: 'عُدّل الملف ' + rel + detail + fallback };
    }
    if (name === 'delete_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (!rel) return { ok: false, content: 'خطأ: الوسيطة path مطلوبة' };
      const abs = resolveExisting(cwd, rel); // تسامح تطبيع (أسماء عربية)
      if (!abs) return { ok: false, content: 'خطأ: ' + READ_ERRORS.outside };
      let st;
      try { st = fs.statSync(abs); } catch { return { ok: false, content: 'خطأ: الملف غير موجود (' + rel + ')' }; }
      if (!st.isFile()) return { ok: false, content: 'خطأ: المسار ليس ملفاً' };
      // لقطة المحتوى قبل الحذف ليعمل «تراجع» (يعيد إنشاء الملف) — نصّي فقط
      let before = null;
      try {
        if (st.size <= MAX_EDIT_SRC) {
          const buf = fs.readFileSync(abs);
          if (!inject.looksBinary(buf)) before = buf.toString('utf8');
        }
      } catch { before = null; }
      fs.unlinkSync(abs);
      const id = (ctx && ctx.id) || ('tool_' + Math.random().toString(36).slice(2));
      // لقطة الحذف: before = المحتوى، والتراجع يعيد كتابته (undoEdit يتكفّل)
      rememberSnapshot(id, { file_path: abs, before: before == null ? '' : before });
      if (ctx && typeof ctx.emit === 'function') {
        const d = computeDiff(before == null ? '' : before, '');
        ctx.emit({
          type: 'file_edit', id, tool: name,
          rel: rel.replace(/\\/g, '/'), isNew: false, isDelete: true,
          added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
        });
      }
      return { ok: true, content: 'حُذف الملف ' + rel };
    }
    if (name === 'run_in_background') {
      const result = termjobs.startJob(cwd, args && args.command, args && args.label);
      if (!result.ok) return { ok: false, content: 'خطأ: ' + (result.message || result.error) };
      if (ctx && typeof ctx.emit === 'function') {
        ctx.emit({ type: 'bg_term', id: result.id, label: result.label, shell: result.shell, cwd: result.cwd });
      }
      return { ok: true, content: 'بدأت المهمة ' + result.id + ' في تبويب مرئي. استخدم get_background_output للاطلاع على سجلها وopen_preview لعرض الخادم.' };
    }
    if (name === 'get_background_output') {
      const id = String((args && args.id) || '');
      if (!termjobs.info(id)) {
        // المهمة خرجت: أعد رمز خروجها وذيلها المحفوظ بدل «لا توجد مهمة» الصامتة
        const done = termjobs.lastExit(id);
        if (done) return { ok: true, content: termjobs.exitSummaryText(done).slice(0, MAX_RESULT) };
        return { ok: false, content: 'خطأ: لا توجد مهمة حيّة بهذا المعرّف ولا سجل خروج محفوظ لها.' };
      }
      const read = term.readBuffer(id, term.MAX_BUFFER_BYTES);
      if (!read.ok) return { ok: false, content: 'خطأ: تعذّرت قراءة سجل المهمة.' };
      const count = Number.isInteger(args && args.tail_lines) ? Math.min(args.tail_lines, 2000) : 200;
      const raw = read.data.replace(/\r/g, '').split('\n').slice(-count).join('\n');
      // تنقية واحدة مشتركة مع bg_term_done: ANSI ومحارف التحكم تُزال والأسرار تُحجب
      const output = termjobs.scrubDoneTail(raw, MAX_RESULT);
      return { ok: true, content: output || '(لا يوجد خرج بعد)' };
    }
    if (name === 'wait_for_background_task') {
      const id = String((args && args.id) || '');
      const result = await termjobs.waitForExit(id, args && args.timeout_ms);
      if (result.status === 'unknown') return { ok: false, content: 'خطأ: لا توجد مهمة حيّة بهذا المعرّف ولا سجل خروج محفوظ لها.' };
      if (result.status === 'running') {
        return { ok: true, content: 'ما زالت المهمة ' + id + ' تعمل بعد ' + Math.round(result.waited_ms / 1000)
          + 'ث. نادِ الأداة ثانيةً للاستمرار في الانتظار، أو get_background_output لقراءة سجلها الآن.' };
      }
      return { ok: true, content: termjobs.exitSummaryText(result).slice(0, MAX_RESULT) };
    }
    if (name === 'list_background_tasks') {
      return { ok: true, content: JSON.stringify({
        terminal_jobs: termjobs.list(), recent_exits: termjobs.recentExitList(), legacy_processes: bgprocs.list(),
      }, null, 2).slice(0, MAX_RESULT) };
    }
    if (name === 'stop_background_task') {
      const id = String((args && args.id) || '');
      const result = termjobs.info(id) ? termjobs.stop(id) : bgprocs.kill(id);
      return result.ok
        ? { ok: true, content: 'أُوقفت المهمة ' + id + '.' }
        : { ok: false, content: 'خطأ: لم تُوجد مهمة حيّة بهذا المعرّف.' };
    }
    if (name === 'run_command') {
      // 2.3: تنفيذ في طرفية النموذج المرئية (نفس مسار run_in_terminal للـ SDK — المرحلة 16):
      // المستخدم يرى الأمر وخرجه حياً، والأمر نصّ لمجرى pty لا لوسائط spawn (sanitizeCommand
      // في term.js ينقّي بايتات التحكم). ⚠️ لا يُستدعى إلا بعد موافقة المستخدم (tier 'exec').
      const command = args && typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) return { ok: false, content: 'خطأ: الوسيطة command مطلوبة' };
      const ensured = term.ensureModelTerm(cwd);
      if (!ensured.ok) return { ok: false, content: 'خطأ: تعذّر فتح طرفية النموذج: ' + (ensured.message || ensured.error) };
      // تبنّي الواجهة لتبويب «🤖 النموذج» عند إنشائه (نفس حدث مسار SDK)
      if (ensured.created && ctx && typeof ctx.emit === 'function') {
        ctx.emit({ type: 'model_term', id: ensured.id, shell: ensured.shell, cwd });
      }
      const secs = (args && Number.isFinite(args.timeout_seconds) && args.timeout_seconds > 0)
        ? Math.min(Math.floor(args.timeout_seconds), 600) : 120;
      const r = await term.runCapture(ensured.id, command, { timeoutMs: secs * 1000 });
      if (!r.ok) return { ok: false, content: 'خطأ: تعذّر التشغيل: ' + (r.message || r.error) };
      let output = r.output || '(لا خرج)';
      if (output.length > MAX_RESULT) output = output.slice(0, MAX_RESULT) + '\n…(قُصّ الخرج — تجاوز السقف)';
      const head = (r.timedOut ? '[انتهت المهلة — قد يكون أمراً طويلاً/تفاعلياً]\n' : '')
        + (r.shellFailed ? '[⚠️ أبلغت الصدفة عن فشل رغم رمز الخروج 0 — راجع الخرج بحثاً عن خطأ]\n' : '')
        + 'exit code: ' + (r.exitCode === null ? 'غير معروف' : r.exitCode) + '\n---\n';
      return { ok: r.exitCode === 0 || r.exitCode === null, content: head + output };
    }
    return { ok: false, content: 'خطأ: أداة غير معروفة: ' + String(name) };
  } catch (e) {
    return { ok: false, content: 'خطأ: ' + String((e && e.message) || e) };
  }
}

module.exports = {
  defs, run, needsPermission, permissionTier, undoEdit, saveFromViewer, MAX_RESULT,
  generationPermission, runGenerateMedia, GENMEDIA_MISSING,
};
