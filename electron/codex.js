/**
 * سطر 2.0 — محرك Codex (OpenAI) الأصيل (المرحلة 1)
 *
 * محرك «خاص» ثانٍ موازٍ لـ agent.js (محرك Claude SDK) — لا محوّل أعمى. يقود Codex
 * أدواته الخاصة (صندوق الرمل، apply_patch، تنفيذ الأوامر) و«سطر» يعرض ويعترض، تماماً
 * كما يفعل مع Claude SDK. الركيزة: `codex app-server` عبر JSON-RPC ثنائي الاتجاه على
 * stdio (مثبَّت بالمسبار — لا exec --json لأنه بلا قناة ردّ فيستحيل اعتراض الأذونات).
 *
 * يطبّع خرج Codex (أحداث v2: thread/turn/item + ServerRequest للأذونات) إلى عقد أحداث
 * «سطر» نفسه (system/stream_text/assistant/user/result/permission_request/file_edit)،
 * مع phase اختيارية لنص الوكيل (commentary/final_answer) كي تفصل الواجهة سجل العمل عن
 * الإجابة. المصادقة: تسجيل دخول الاشتراك (~/.codex/auth.json) أولاً، والـ
 * API key ثانوياً (CODEX_API_KEY) — لا نحقنها هنا، الثنائي يقرأها بنفسه.
 *
 * تفاصيل مثبّتة بالمسبار (2026-07-12) موثّقة في ذاكرة codex-engine-plan:
 *  - طلب الإذن ServerRequest له id قد يكون 0 ⇒ فحص `id != null` لا truthy.
 *  - مفردات قرار v2: accept | acceptForSession | decline | cancel (لا مفردات v1).
 *  - النماذج الحديثة تعمل على Plus بعد تحديث الـ CLI (gpt-5.6-sol/terra/luna, gpt-5.5).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const { computeDiff } = require('./diff');
const skillCatalog = require('./skills');
const preview = require('./preview');   // وحدة المعاينة المشتركة (رؤية الويب لـ Codex — الخيار 1)
const codexmcp = require('./codexmcp');  // خادم MCP‏ streamable-HTTP داخل العملية
const keys = require('./keys');
const memory = require('./memory'); // ذاكرة مشروع شخصية — حقن قرائي مقصوص (تكافؤ agent.js)
const testsprite = require('./testsprite');
const testspriteHarness = require('./testspriteharness');
const envbrief = require('./envbrief');
const execguard = require('./execguard');
const browserpolicy = require('./browserpolicy');
const { queryCodex } = require('./codexrpc');

const IS_WIN = process.platform === 'win32';
const MAX_DIFF_BYTES = 2 * 1024 * 1024; // فوقه لا نلتقط لقطة تراجع ولا نعرض فرقاً
const DEFAULT_MODEL = 'gpt-5.6-sol';
// إصلاح الموثوقية (2026-07-30): سقوف زمنية لتسلسل الإقلاع والإيقاف — عملية app-server
// حيّة غير مستجيبة كانت تعلّق الدور في «يستعد» بلا نهاية، وتعليق turn/interrupt كان
// يعلّق stopAll فيحبس قفل الإرسال العام في main.js إلى الأبد (لا مخرج إلا إعادة التشغيل).
// تجاوز البيئة للاختبار القطعي فقط (fixture لا يمكنه انتظار 60ث) — عدد صحيح 100..600000.
function reliabilityTimeout(envName, fallback) {
  const raw = Number.parseInt(process.env[envName] || '', 10);
  return Number.isInteger(raw) && raw >= 100 && raw <= 600000 ? raw : fallback;
}
const BOOT_REQUEST_TIMEOUT_MS = reliabilityTimeout('SATR_CODEX_BOOT_TIMEOUT_MS', 60000);   // initialize/thread/turn — لكل طلب إقلاع
const INTERRUPT_TIMEOUT_MS = reliabilityTimeout('SATR_CODEX_INTERRUPT_TIMEOUT_MS', 5000); // turn/interrupt عند الإيقاف (نمط forceClose في SDK)

// ---------- لقطات التراجع (نظير agent.js) ----------
// المفتاح call_id للتعديل، القيمة { file_path, before } (before=null ⇒ ملف جديد، التراجع=حذف).
const editSnapshots = new Map();
const MAX_SNAPSHOTS = 40;
function rememberSnapshot(id, snap) {
  editSnapshots.set(id, snap);
  while (editSnapshots.size > MAX_SNAPSHOTS) {
    editSnapshots.delete(editSnapshots.keys().next().value);
  }
}
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

function relPath(cwd, fp) {
  try {
    const r = path.relative(cwd, fp);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return fp;
    return r.split(path.sep).join('/');
  } catch { return fp; }
}

// ---------- تحديد ثنائي codex المثبّت عالمياً (لا نحزمه — نمط resolveClaudeBin) ----------
// على ويندوز قد يكون: (1) حزمة npm مستقلة، (2) shim امتداد VS Code (openai.chatgpt-*).
// نحلّ إلى الـ exe الفعلي مباشرة (لا .cmd — spawn المباشر لها يفشل EINVAL، وshell:true
// قد يلتقط shim خاطئاً). force يتجاوز التخزين لزرّ «أعد الفحص» في البوابة (المرحلة 4).
let codexBinResolved;
function resolveCodexBin(force) {
  if (!force && codexBinResolved !== undefined) return codexBinResolved;
  const candidates = [];
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN);
  // (1) حزمة npm المستقلة: @openai/codex ⇒ حزمة المنصّة codex-<plat> ⇒ vendor/.../bin/codex.exe
  const plat = IS_WIN ? 'win32-x64' : (process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'));
  const triple = IS_WIN ? 'x86_64-pc-windows-msvc'
    : (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
      : (process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'));
  const exe = IS_WIN ? 'codex.exe' : 'codex';
  const npmVendorTail = path.join('node_modules', '@openai', 'codex', 'node_modules',
    '@openai', 'codex-' + plat, 'vendor', triple, 'bin', exe);
  const npmRoots = [];
  if (IS_WIN && process.env.APPDATA) npmRoots.push(path.join(process.env.APPDATA, 'npm'));
  if (!IS_WIN) npmRoots.push('/usr/local/lib', '/usr/lib');
  if (process.env.npm_config_prefix) npmRoots.push(process.env.npm_config_prefix);
  for (const root of npmRoots) candidates.push(path.join(root, npmVendorTail));
  // (2) shim امتداد VS Code (openai.chatgpt-<ver>-<plat>): أحدث نسخة
  try {
    if (IS_WIN && process.env.USERPROFILE) {
      const extDir = path.join(process.env.USERPROFILE, '.vscode', 'extensions');
      const dirs = fs.readdirSync(extDir)
        .filter((d) => /^openai\.chatgpt-.*win32-x64$/.test(d))
        .sort().reverse();
      for (const d of dirs) candidates.push(path.join(extDir, d, 'bin', 'windows-x86_64', 'codex.exe'));
    }
  } catch { /* لا امتداد */ }
  // (3) اشتقاق من موقع codex في PATH (قد يكون shim — نبحث عن exe بجواره)
  try {
    const found = execSync(IS_WIN ? 'where codex' : 'which codex', { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found && /\.exe$/i.test(found)) candidates.push(found);
  } catch { /* codex غير موجود في PATH */ }
  codexBinResolved = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
  return codexBinResolved;
}

// ---------- حالة تسجيل الدخول (للوحة الإرشاد/البوابة — المرحلة 4، لكن مفيدة الآن) ----------
// نقرأ ~/.codex/auth.json: chatgpt (اشتراك) أو apiKey. القيم لا تُعاد للواجهة (أمان).
function authStatus() {
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && raw.tokens && raw.tokens.id_token) return { ok: true, method: 'chatgpt' };
    if (raw && raw.OPENAI_API_KEY) return { ok: true, method: 'apikey' };
    return { ok: false, method: null };
  } catch { return { ok: false, method: null }; }
}

// ---------- تخطيط وضع «سطر» → سياسة Codex (approvalPolicy + sandbox) ----------
// قيم approvalPolicy الصالحة في Codex 0.144: untrusted | on-request | granular | never
// (on-failure المهجورة أُزيلت — كانت تُرجع Invalid request). درس مثبّت: `never` **لا** يعني
// «اقبل تلقائياً» بل «لا تصعّد» — فالكتابة تُحجب بصندوق read-only الفعلي (blocked by policy).
// لذا نُبقي on-request ونتحكّم بالقبول التلقائي في المعالج (نظير acceptEdits في Claude:
// التعديلات تُقبل تلقائياً والأوامر تبقى تسأل). bypassPermissions وحده never+full-access.
//  default          → on-request + workspace-write (المعالج يسأل عن كل شيء)
//  acceptEdits      → on-request + workspace-write (المعالج يقبل التعديلات تلقائياً، يسأل عن الأوامر)
//  plan             → on-request + read-only (لا كتابة)
//  bypassPermissions→ never + danger-full-access (بلا سؤال ولا صندوق)
function mapMode(mode) {
  switch (mode) {
    case 'acceptEdits': return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan': return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'bypassPermissions': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    default: return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

// متصفح «سطر» هو المسار الوحيد للمعاينة في أدوار الدردشة. نحجب إطلاق متصفح نظام خارجي
// عندما تكون أدوات المعاينة متاحة؛ أوامر خوادم التطوير العادية (npm run dev ونحوها) لا تتأثر.
// (دفعة «تحكم الوكيل الكامل» 2026-07-18: الدالة انتقلت إلى electron/browserguard.js
// المشترك مع محرك SDK — نسخة واحدة لا نسختان تتباعدان، مع promptRequestsExternalBrowser
// لاحترام طلب المستخدم الصريح لمتصفح خارجي.)
const { isExternalBrowserLaunchCommand, promptRequestsExternalBrowser } = require('./browserguard');
const browserorigin = require('./browserorigin');

// ---------- الأدوات الموافَق عليها «دائماً» (معزولة لكل جلسة، ولعمر التطبيق فقط) ----------
const sessionAllowed = new Map();
const MAX_PERMISSION_SESSIONS = 100;

function permissionSet(sessionId) {
  if (!sessionId) return null;
  let set = sessionAllowed.get(sessionId);
  if (!set) {
    set = new Set();
    sessionAllowed.set(sessionId, set);
    while (sessionAllowed.size > MAX_PERMISSION_SESSIONS) sessionAllowed.delete(sessionAllowed.keys().next().value);
  }
  return set;
}

async function accountStatus() {
  const bin = resolveCodexBin();
  if (!bin) return { ok: false, method: null };
  try {
    const result = await queryCodex(bin, 'account/read', { refreshToken: false });
    const account = result && result.account;
    if (!account) return { ok: result && result.requiresOpenaiAuth === false, method: null };
    return {
      ok: true,
      method: account.type === 'apiKey' ? 'apikey' : account.type,
      plan: account.type === 'chatgpt' ? account.planType || null : null,
    };
  } catch {
    return authStatus();
  }
}

async function listModels() {
  const bin = resolveCodexBin();
  if (!bin) return [];
  try {
    const result = await queryCodex(bin, 'model/list', { includeHidden: false, limit: 100 });
    return Array.isArray(result && result.data) ? result.data : [];
  } catch { return []; }
}

// cwd اختياري (الافتراضي المنزل): استدعاء على مستوى الحساب لا يعتمد على المشروع، و
// main.js لا يمرّره — فلا يصل مسار من renderer إلى spawn. يستعمله الاختبار القطعي فقط.
async function rateLimits(cwd) {
  const bin = resolveCodexBin();
  if (!bin) return null;
  try { return await queryCodex(bin, 'account/rateLimits/read', null, cwd ? { cwd } : {}); }
  catch { return null; }
}

// ---------- تنقية نص التوجيه أثناء الدور (C1) ----------
// دالة نقية يستهلكها main.js عند بوابة satr:steer (نمط nonSdkPerm في autogate.js:
// المنطق قابل للاختبار وحده، ونقطة الفرض تبقى في العملية الرئيسية). تُبنى فئة محارف
// التحكم/Bidi من نقاط الترميز نصّاً كي لا يحمل المصدر بايتات تحكم خام.
const MAX_STEER_CHARS = 32000;
const STEER_STRIP = new RegExp('[' + [
  '\\u0000-\\u0008', '\\u000b', '\\u000c', '\\u000e-\\u001f', '\\u007f',
  '\\u061c', '\\u200e', '\\u200f', '\\u202a-\\u202e', '\\u2066-\\u2069',
].join('') + ']', 'g');

function sanitizeSteerText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(STEER_STRIP, ' ')
    .slice(0, MAX_STEER_CHARS)
    .trim();
}

// ---------- لقطة سياق آخر قياس لكل خيط (C2 — /سياق) ----------
// **حدّ upstream مثبّت بالمسبار**: `model/list` لا يعلن نافذة سياق إطلاقاً (7 نماذج،
// صفر حقل contextWindow/maxTokens)، والمصدر الوحيد لها ولإشغالها هو إشعار
// `thread/tokenUsage/updated` الحيّ أثناء دور. لذا نحتفظ بآخر لقطة لكل خيط في ذاكرة
// العملية — لا مخزن قرص جديد ولا اعتمادية؛ وغيابها (إقلاع جديد أو جلسة بلا دور بعد)
// يعطي رسالة عربية هادئة بدل رقم مختلق.
// نستعمل `last` لا `total`: `total` تراكمي عبر الخيط فيكبر أبداً ولا يعكس الإشغال.
const contextSnapshots = new Map();
const MAX_CONTEXT_SNAPSHOTS = 100;
const CONTEXT_UNAVAILABLE = 'لم يصل قياس سياق من Codex بعد — أرسل رسالة في هذه الجلسة ثم حدّث اللوحة.';
const COMPACT_COMMAND = '/compact';

function rememberContext(id, snap) {
  if (!id || !snap) return;
  contextSnapshots.set(id, snap);
  while (contextSnapshots.size > MAX_CONTEXT_SNAPSHOTS) {
    contextSnapshots.delete(contextSnapshots.keys().next().value);
  }
}

// يطبّع اللقطة إلى عقد لوحة /سياق القائم (totalTokens/maxTokens/percentage/model/
// categories) — بلا IPC جديد: main.js يوجّه satr:contextUsage بفرع engine.
function contextUsage(cwd, sessionId) {
  const snap = sessionId ? contextSnapshots.get(sessionId) : null;
  if (!snap || !snap.contextWindow) return { ok: false, error: CONTEXT_UNAVAILABLE };
  const total = Math.max(0, Number(snap.totalTokens) || 0);
  const max = Math.max(0, Number(snap.contextWindow) || 0);
  const cat = (name, tokens) => ({ name, tokens: Math.max(0, Number(tokens) || 0), isDeferred: false });
  return {
    ok: true,
    usage: {
      totalTokens: total,
      maxTokens: max,
      percentage: max ? Math.round((total / max) * 100) : 0,
      model: snap.model || '',
      // الفئتان الأخيرتان مجموعتان فرعيتان (المخبّأ من الإدخال، والتفكير من الإخراج) —
      // الاسم يوضّح ذلك كي لا يُقرأ الشريط جمعاً مضاعفاً.
      categories: [
        cat('الإدخال', snap.inputTokens),
        cat('الإخراج', snap.outputTokens),
        cat('منها مخبّأ', snap.cachedInputTokens),
        cat('منه تفكير', snap.reasoningTokens),
      ].filter((item) => item.tokens > 0),
    },
  };
}

// ---------- لوحة موصّلات Codex (‏/موصلات — C3) ----------
// الطرق كلها من الـschema المولّد من الثنائي: mcpServerStatus/list ·
// config/mcpServer/reload (params = null) · mcpServer/oauth/login، وإشعارا
// mcpServer/startupStatus/updated وmcpServer/oauthLogin/completed.
//
// **حدود upstream مثبّتة بالمسبار (codex-cli 0.144.3)**:
//  1) `McpServerStatus` **لا يحمل حقل status إطلاقاً** — مفاتيحه المرصودة:
//     authStatus,name,resourceTemplates,resources,serverInfo,tools. فحالة الاتصال
//     الحقيقية تأتي **حصراً** من إشعارات mcpServer/startupStatus/updated.
//  2) تلك الإشعارات **لا تصل قبل بدء خيط**: صفر إشعار خلال 20ث بعد initialize، ثم
//     10 إشعارات فور thread/start (5 starting ثم ready/failed). لذلك نبدأ خيطاً
//     عابراً للقراءة فقط ثم نغلق العملية.
//  3) `tools` يعود **null دائماً** في هذا الإصدار (جُرّب detail الافتراضي وfull
//     وtoolsAndAuthOnly وبعد بدء خيط) ⇒ لا نعرض عدد أدوات لـCodex. `resources` يعمل.
const MCP_PROBE_STARTUP_MS = 9000;   // نافذة انتظار إشعارات الإقلاع بعد بدء الخيط
const MCP_PROBE_TIMEOUT_MS = 45000;  // سقف عمر الجسّ كله
const MCP_OAUTH_TTL_MS = 5 * 60 * 1000;
const MCP_MAX_ERROR_CHARS = 300;
const MCP_STARTUP_STATE = { ready: 'connected', starting: 'pending', failed: 'failed', cancelled: 'failed' };

// نص خطأ خادم MCP قد يحمل رابطاً أو رمزاً؛ ننقّيه ونحجبه إن طابق حارس الأسرار المشترك.
function sanitizeMcpError(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const text = raw.replace(STEER_STRIP, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  try { if (memory.hasSecret(text)) return 'حُجب نص الخطأ لاحتوائه بيانات حسّاسة.'; }
  catch { /* الحارس تحسين لا يكسر اللوحة */ }
  return text.length > MCP_MAX_ERROR_CHARS ? text.slice(0, MCP_MAX_ERROR_CHARS) + '…' : text;
}

// جلسة app-server عابرة تسمع الإشعارات (نمط withProbe): queryCodex أحادية الطلب ولا
// تعرض الإشعارات، وهذه اللوحة تحتاجها. تُغلق العملية دائماً في finally.
function openTransient(bin, cwd, onNotification) {
  const proc = spawn(bin, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
  const replies = new Map();
  let reqId = 0;
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 8 * 1024 * 1024) { buf = ''; return; }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && replies.has(msg.id)) {
        const pending = replies.get(msg.id); replies.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || 'rpc_error'));
        else pending.resolve(msg.result);
        continue;
      }
      if (msg.id != null && msg.method) {
        try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported' } }) + '\n'); } catch {}
        continue;
      }
      if (msg.method && onNotification) { try { onNotification(msg.method, msg.params || {}); } catch {} }
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('error', () => { for (const [, p] of replies) p.reject(new Error('codex_spawn_failed')); replies.clear(); });
  proc.on('exit', () => { for (const [, p] of replies) p.reject(new Error('codex_rpc_closed')); replies.clear(); });
  const write = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} };
  return {
    request(method, params) {
      const id = ++reqId;
      return new Promise((resolve, reject) => {
        replies.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params: params === undefined ? {} : params });
      });
    },
    notify(method, params) { write({ method, params: params || {} }); },
    close() { try { proc.stdin.end(); } catch {} setTimeout(() => { try { proc.kill(); } catch {} }, 200); },
  };
}

async function mcpStatus(cwd) {
  const bin = resolveCodexBin();
  if (!bin) return { ok: false, error: 'لم يُعثر على Codex CLI' };
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  const startup = new Map(); // name → {status, error, failureReason}
  let session = null;
  const guard = setTimeout(() => { if (session) session.close(); }, MCP_PROBE_TIMEOUT_MS);
  try {
    session = openTransient(bin, dir, (method, params) => {
      if (method !== 'mcpServer/startupStatus/updated') return;
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return;
      startup.set(name, {
        status: params.status,
        failureReason: params.failureReason || null,
        error: sanitizeMcpError(params.error),
      });
    });
    await session.request('initialize', { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } });
    session.notify('initialized', {});
    // خيط عابر للقراءة فقط: الإشعارات لا تصل قبله (حدّ upstream 2 أعلاه)
    try {
      await session.request('thread/start', {
        cwd: dir, approvalPolicy: 'on-request', sandbox: 'read-only',
        persistExtendedHistory: false, experimentalRawEvents: false,
      });
      await new Promise((resolve) => setTimeout(resolve, MCP_PROBE_STARTUP_MS));
    } catch { /* تعذّر بدء الخيط ⇒ نكتفي بجرد authStatus */ }
    const listed = await session.request('mcpServerStatus/list', {});
    const rows = listed && Array.isArray(listed.data) ? listed.data : [];
    const servers = rows
      // خادم المعاينة الداخلي تفصيل تنفيذي لا موصّل مستخدم — يُستثنى من العرض
      .filter((s) => s && typeof s.name === 'string' && s.name !== 'satr_preview')
      .map((s) => {
        const boot = startup.get(s.name) || null;
        const authStatus = typeof s.authStatus === 'string' ? s.authStatus : '';
        let status = boot ? (MCP_STARTUP_STATE[boot.status] || 'pending') : 'pending';
        if (boot && boot.status === 'failed' && boot.failureReason === 'reauthenticationRequired') status = 'needs-auth';
        if (authStatus === 'notLoggedIn') status = 'needs-auth';
        return {
          name: s.name,
          status,
          authStatus,
          // قابلية تسجيل الدخول من اللوحة: العقد يعلن oAuth/notLoggedIn فقط
          canLogin: authStatus === 'notLoggedIn' || authStatus === 'oAuth',
          resources: Array.isArray(s.resources) ? s.resources.length : 0,
          // tools يعود null دائماً في هذا الإصدار ⇒ لا ندّعي عدداً
          tools: Array.isArray(s.tools) ? s.tools.map((t) => ({ name: String((t && t.name) || '') })) : null,
          serverInfo: s.serverInfo && typeof s.serverInfo === 'object'
            ? { version: String(s.serverInfo.version || '').slice(0, 40) } : null,
          error: boot ? boot.error : '',
        };
      });
    return { ok: true, servers };
  } catch (e) {
    return { ok: false, error: 'تعذّر قراءة حالة موصّلات Codex' };
  } finally {
    clearTimeout(guard);
    if (session) session.close();
  }
}

// إعادة تحميل إعداد الخوادم — الطريقة المعلنة الوحيدة (params = null في الـschema).
// «سطر» لا يكتب config.toml، لذلك التفعيل/التعطيل غير مدعومين لـCodex عمداً.
async function mcpReload(cwd) {
  const bin = resolveCodexBin();
  if (!bin) return { ok: false, error: 'لم يُعثر على Codex CLI' };
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  let session = null;
  try {
    session = openTransient(bin, dir, null);
    await session.request('initialize', { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } });
    session.notify('initialized', {});
    await session.request('config/mcpServer/reload', null);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'تعذّر إعادة تحميل إعداد الموصّلات' };
  } finally {
    if (session) session.close();
  }
}

// ---------- تسجيل دخول OAuth لخادم MCP ----------
// **الرابط لا يعبر IPC ولا يُبثّ**: يبقى هنا في العملية الرئيسية، وmain.js يقرأه من
// الطلب المعلّق ويفتحه بـshell.openExternal بعد نقرة المستخدم (نمط حوار elicitation
// ‏URL). ولا يُخزَّن أي token في «سطر» — المصادقة كلها داخل Codex.
const pendingMcpOauth = new Map();
let mcpOauthSeq = 0;

function dropMcpOauth(id) {
  const entry = pendingMcpOauth.get(id);
  if (!entry) return;
  pendingMcpOauth.delete(id);
  clearTimeout(entry.timer);
  try { entry.session.close(); } catch {}
}

async function mcpOauthStart(cwd, name) {
  const bin = resolveCodexBin();
  if (!bin) return { ok: false, error: 'لم يُعثر على Codex CLI' };
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  let session = null;
  try {
    const entry = { name, url: '', session: null, timer: null, settle: null, outcome: null };
    session = openTransient(bin, dir, (method, params) => {
      if (method !== 'mcpServer/oauthLogin/completed') return;
      if (typeof params.name === 'string' && params.name !== name) return;
      entry.outcome = { success: params.success === true, error: sanitizeMcpError(params.error) };
      if (entry.settle) { const fn = entry.settle; entry.settle = null; fn(entry.outcome); }
    });
    entry.session = session;
    await session.request('initialize', { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } });
    session.notify('initialized', {});
    const result = await session.request('mcpServer/oauth/login', { name });
    const url = result && typeof result.authorizationUrl === 'string' ? result.authorizationUrl : '';
    if (!url) { session.close(); return { ok: false, error: 'لم يُعِد Codex رابط مصادقة لهذا الخادم' }; }
    entry.url = url;
    const id = 'cxoauth_' + (++mcpOauthSeq) + '_' + Math.random().toString(36).slice(2, 8);
    entry.timer = setTimeout(() => dropMcpOauth(id), MCP_OAUTH_TTL_MS);
    pendingMcpOauth.set(id, entry);
    return { ok: true, id, name };
  } catch (e) {
    if (session) session.close();
    return { ok: false, error: 'تعذّر بدء تسجيل الدخول لهذا الموصّل' };
  }
}

// تحقق رابط المصادقة — القواعد نفسها المعتمدة لحوار elicitation ‏URL: HTTPS، أو HTTP
// على loopback فقط، بلا username/password، بلا فراغ أو محارف تحكم/Bidi، وبسقف طول.
// دالة نقية يستهلكها main.js قبل shell.openExternal (نمط sanitizeSteerText في C1).
const MAX_OAUTH_URL = 2048;
function safeOauthUrl(value) {
  if (typeof value !== 'string') return '';
  if (STEER_STRIP.test(value)) { STEER_STRIP.lastIndex = 0; return ''; }
  STEER_STRIP.lastIndex = 0;
  const raw = value.trim();
  if (!raw || /\s/.test(raw) || Array.from(raw).length > MAX_OAUTH_URL) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return '';
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return '';
    return Array.from(parsed.href).length <= MAX_OAUTH_URL ? parsed.href : '';
  } catch { return ''; }
}

// main.js وحده يستدعيها ليقرأ الرابط ويتحقق منه قبل shell.openExternal — لا تُبثّ.
// العقد: نص صالح أو null — رابط upstream غير الآمن يُسقَط إلى null fail-closed.
function mcpOauthUrl(id) {
  const entry = pendingMcpOauth.get(id);
  return entry ? (safeOauthUrl(entry.url) || null) : null;
}

// ينتظر إشعار الاكتمال بعد فتح الرابط؛ المهلة تُنهي الانتظار بلا ادّعاء نجاح.
function mcpOauthAwait(id, timeoutMs) {
  const entry = pendingMcpOauth.get(id);
  if (!entry) return Promise.resolve({ ok: false, error: 'انتهت صلاحية طلب تسجيل الدخول' });
  if (entry.outcome) {
    const outcome = entry.outcome;
    dropMcpOauth(id);
    return Promise.resolve({ ok: true, success: outcome.success, error: outcome.error });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.settle = null;
      resolve({ ok: false, error: 'لم يصل تأكيد اكتمال تسجيل الدخول بعد' });
    }, Number.isInteger(timeoutMs) ? timeoutMs : 120000);
    entry.settle = (outcome) => {
      clearTimeout(timer);
      dropMcpOauth(id);
      resolve({ ok: true, success: outcome.success, error: outcome.error });
    };
  });
}

function mcpOauthCancel(id) { dropMcpOauth(id); return { ok: true }; }

// ---------- حساب Codex واستهلاكه (C4) ----------
// الطرق من الـschema المولّد: account/usage/read (params=null) →
// GetAccountTokenUsageResponse {summary, dailyUsageBuckets?}، وaccount/rateLimits/read
// (params=null) → GetAccountRateLimitsResponse {rateLimits, rateLimitResetCredits?, …}.
// `rateLimits()` القائمة تعيد الحمولة الخام؛ هنا نطبّعها إلى عقد عام مغلق للواجهة.
//
// **قاعدة ثابتة**: لا يُقرأ `~/.codex/auth.json` ولا يعبر أي token أو رمز إلى renderer —
// المصادقة كلها داخل Codex، و«سطر» يعرض حالة وأرقاماً عامة فقط.
const MAX_PLAN_CHARS = 40;
const MAX_LIMIT_NAME_CHARS = 60;

function cleanLabel(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(STEER_STRIP, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}
const asInt = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null);

// نافذة حدّ (RateLimitWindow): usedPercent إلزامي، والباقي اختياري في الـschema
function normalizeWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const used = Number(win.usedPercent);
  if (!Number.isFinite(used)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(used))),
    windowDurationMins: asInt(win.windowDurationMins),
    resetsAt: asInt(win.resetsAt),
  };
}

function normalizeRateLimits(raw) {
  const snapshot = raw && raw.rateLimits;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const credits = snapshot.credits && typeof snapshot.credits === 'object' ? snapshot.credits : null;
  return {
    planType: cleanLabel(snapshot.planType, MAX_PLAN_CHARS),
    limitName: cleanLabel(snapshot.limitName, MAX_LIMIT_NAME_CHARS),
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    // rateLimitReachedType يفيد المستخدم حين يبلغ الحد؛ قيمة معدودة لا نص حر
    reachedType: cleanLabel(snapshot.rateLimitReachedType, MAX_PLAN_CHARS),
    // credits.balance نص في الحمولة الحيّة (مثبّت بالمسبار) — نمرره منقّى لا مؤوَّلاً
    credits: credits ? {
      hasCredits: credits.hasCredits === true,
      unlimited: credits.unlimited === true,
      balance: cleanLabel(credits.balance, MAX_PLAN_CHARS),
    } : null,
    resetCredits: raw && raw.rateLimitResetCredits
      ? asInt(raw.rateLimitResetCredits.availableCount) : null,
  };
}

// cwd اختياري كما في rateLimits — main.js لا يمرّره (استدعاء على مستوى الحساب).
async function accountRateLimits(cwd) {
  const raw = await rateLimits(cwd);
  const normalized = normalizeRateLimits(raw);
  return normalized ? { ok: true, limits: normalized } : { ok: false, error: 'لم يُعِد Codex حدود الاستهلاك بعد' };
}

async function accountUsage(cwd) {
  const bin = resolveCodexBin();
  if (!bin) return { ok: false, error: 'لم يُعثر على Codex CLI' };
  let raw = null;
  try { raw = await queryCodex(bin, 'account/usage/read', null, cwd ? { timeoutMs: 15000, cwd } : { timeoutMs: 15000 }); }
  catch { return { ok: false, error: 'تعذّرت قراءة استهلاك حساب Codex' }; }
  const summary = raw && raw.summary && typeof raw.summary === 'object' ? raw.summary : null;
  if (!summary) return { ok: false, error: 'لم يُعِد Codex ملخّص الاستهلاك' };
  const buckets = Array.isArray(raw.dailyUsageBuckets) ? raw.dailyUsageBuckets : [];
  const recent = buckets.slice(-30)
    .map((b) => ({ startDate: cleanLabel(b && b.startDate, 24), tokens: asInt(b && b.tokens) }))
    .filter((b) => b.startDate && b.tokens != null);
  return {
    ok: true,
    usage: {
      lifetimeTokens: asInt(summary.lifetimeTokens),
      peakDailyTokens: asInt(summary.peakDailyTokens),
      currentStreakDays: asInt(summary.currentStreakDays),
      longestStreakDays: asInt(summary.longestStreakDays),
      longestRunningTurnSec: asInt(summary.longestRunningTurnSec),
      recentDays: recent.length,
      recentTokens: recent.reduce((sum, b) => sum + b.tokens, 0),
    },
  };
}

// ---------- تسجيل دخول حساب Codex (نمط C3 حرفياً) ----------
// **الرابط لا يعبر IPC ولا يُبثّ**: يبقى هنا، وmain.js يقرأه ويتحقق منه بـsafeOauthUrl
// نفسها ثم يفتحه بـshell.openExternal بعد تأكيد صريح من المستخدم.
// عقد v2 المثبّت: account/login/start {type:'chatgpt'} → {type,authUrl,loginId}؛
// account/login/cancel {loginId} → {status:'canceled'|'notFound'}؛ وإشعار
// account/login/completed {success, loginId?, error?}.
const pendingAccountLogin = new Map();
const ACCOUNT_LOGIN_TTL_MS = 5 * 60 * 1000;
let accountLoginSeq = 0;

function dropAccountLogin(id, cancelUpstream) {
  const entry = pendingAccountLogin.get(id);
  if (!entry) return;
  pendingAccountLogin.delete(id);
  clearTimeout(entry.timer);
  // إلغاء الدورة لدى Codex قبل إغلاق القناة كي لا تبقى معلّقة لديه
  if (cancelUpstream && entry.loginId) {
    try { entry.session.request('account/login/cancel', { loginId: entry.loginId }).catch(() => {}); } catch {}
  }
  setTimeout(() => { try { entry.session.close(); } catch {} }, cancelUpstream ? 300 : 0);
}

// cwd اختياري كما أعلاه — main.js لا يمرّره.
async function accountLoginStart(cwd) {
  const bin = resolveCodexBin();
  if (!bin) return { ok: false, error: 'لم يُعثر على Codex CLI' };
  let session = null;
  try {
    const entry = { url: '', loginId: '', session: null, timer: null, settle: null, outcome: null };
    session = openTransient(bin, cwd || os.homedir(), (method, params) => {
      if (method !== 'account/login/completed') return;
      if (entry.loginId && typeof params.loginId === 'string' && params.loginId !== entry.loginId) return;
      entry.outcome = { success: params.success === true, error: sanitizeMcpError(params.error) };
      if (entry.settle) { const fn = entry.settle; entry.settle = null; fn(entry.outcome); }
    });
    entry.session = session;
    await session.request('initialize', { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } });
    session.notify('initialized', {});
    const started = await session.request('account/login/start', { type: 'chatgpt' });
    const url = started && typeof started.authUrl === 'string' ? started.authUrl : '';
    const loginId = started && typeof started.loginId === 'string' ? started.loginId : '';
    if (!url || !loginId) { session.close(); return { ok: false, error: 'لم يُعِد Codex رابط تسجيل دخول صالحاً' }; }
    entry.url = url;
    entry.loginId = loginId;
    const id = 'cxlogin_' + (++accountLoginSeq) + '_' + Math.random().toString(36).slice(2, 8);
    entry.timer = setTimeout(() => dropAccountLogin(id, true), ACCOUNT_LOGIN_TTL_MS);
    pendingAccountLogin.set(id, entry);
    return { ok: true, id };
  } catch (e) {
    if (session) session.close();
    return { ok: false, error: 'تعذّر بدء تسجيل الدخول إلى Codex' };
  }
}

// العقد: نص صالح أو null — رابط upstream غير الآمن يُسقَط إلى null fail-closed.
function accountLoginUrl(id) {
  const entry = pendingAccountLogin.get(id);
  return entry ? (safeOauthUrl(entry.url) || null) : null;
}

function accountLoginAwait(id, timeoutMs) {
  const entry = pendingAccountLogin.get(id);
  if (!entry) return Promise.resolve({ ok: false, error: 'انتهت صلاحية طلب تسجيل الدخول' });
  if (entry.outcome) {
    const outcome = entry.outcome;
    dropAccountLogin(id, false);
    return Promise.resolve({ ok: true, success: outcome.success });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.settle = null;
      resolve({ ok: false, error: 'لم يصل تأكيد اكتمال تسجيل الدخول بعد' });
    }, Number.isInteger(timeoutMs) ? timeoutMs : 180000);
    entry.settle = (outcome) => {
      clearTimeout(timer);
      dropAccountLogin(id, false);
      resolve({ ok: true, success: outcome.success });
    };
  });
}

function accountLoginCancel(id) { dropAccountLogin(id, true); return { ok: true }; }

function projectPath(cwd, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    ? absolute : null;
}

function isInternalMcpApprovalElicitation(params) {
  if (!params) return false;
  const schema = params && params.requestedSchema;
  const meta = params && params._meta;
  const properties = schema && schema.properties;
  return params.serverName === 'satr_preview'
    && params.mode === 'form'
    && meta && meta.codex_approval_kind === 'mcp_tool_call'
    && schema && schema.type === 'object'
    && properties && typeof properties === 'object' && !Array.isArray(properties)
    && Object.keys(properties).length === 0
    && (!Array.isArray(schema.required) || schema.required.length === 0);
}

function shouldAutoApproveMcp(access, browserControl, permissionMode, remembered, neverAlways, toolName, target, trustedSet, currentUrl, input, pageContext, budgetStatus) {
  if (permissionMode === 'bypassPermissions') return true;
  if (browserpolicy.isSensitiveAction(toolName, input, pageContext)
    || browserpolicy.requiresExplicitApproval(toolName)
    || browserpolicy.hasLeakRisk(browserpolicy.leakValueForTool(toolName, input))
    || (budgetStatus && budgetStatus.impacting && !budgetStatus.allowed)) return false;
  if (access === 'browser' && browserControl === true) {
    const browserClass = browserorigin.classifyBrowserTool(toolName);
    if (!browserorigin.canAutoControl(toolName, target, trustedSet)) return false;
    return browserClass !== 'act' || browserorigin.isTrusted(currentUrl || target, trustedSet);
  }
  return remembered === true && neverAlways !== true;
}

/**
 * عميل JSON-RPC خفيف فوق `codex app-server` (stdio، أسطر JSON مفصولة بـ \n).
 * يبثّ ServerRequest (أذونات) وnotifications (أحداث)، ويستقبل ردودنا.
 */
function decodeBase64(s) { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return s; } }

/**
 * يبدأ دوراً واحداً ويعيد مقبضاً فيه stop و resolvePermission (نفس عقد agent.start).
 */
async function start({ prompt, images, sessionId, model, permissionMode, skills, effort, browserControl, trustedBrowserOrigins, browserBudget }, cwd, emit) {
  const bin = resolveCodexBin();
  if (!bin) {
    emit({ type: 'spawn_error', text: 'لم يُعثر على Codex CLI. ثبّته: npm install -g @openai/codex' });
    emit({ type: 'proc_done', code: 1 });
    return { resolvePermission() { return false; }, async stop() {} };
  }

  // رؤية الويب لـ Codex (الخيار 1): نستضيف خادم MCP‏ streamable-HTTP **داخل العملية**
  // (electron/codexmcp.js) بوصول مباشر لـ preview.js، ونحقن إعداده في `codex app-server`
  // عبر تجاوزات `-c` وقت الإطلاق (بلا تلويث ~/.codex/config.toml وبلا عملية جسر). الرمز
  // يُمرَّر عبر متغيّر بيئة (codex يقرأه من bearer_token_env_var). أثبته اختبار حيّ:
  // codex اتصل، طلب tools/list، وأبلغ satr_preview=ready. أي فشل هنا لا يكسر الدور —
  // Codex يعمل بلا رؤية ويب (تدهور رشيق). open_preview يبثّ preview_open للواجهة لتفتح اللوحة.
  let mcpHost = null;
  let testspriteHarnessHost = null;
  let testspriteProgressWatcher = null;
  let effectivePrompt = prompt;
  const actionBudget = browserBudget && typeof browserBudget.check === 'function'
    ? browserBudget : browserpolicy.createActionBudget();
  // طلب المستخدم الصريح لمتصفح خارجي في رسالة هذا الدور يعطّل حاجب browserguard (قرار مالك)
  const allowExternalBrowser = promptRequestsExternalBrowser(prompt);
  if (browserControl !== false) try {
    mcpHost = await codexmcp.start({
      preview,
      cwd,
      openPreview: (url) => emit({ type: 'preview_open', url }),
      // أفعال المتصفح (نقر/كتابة/اختيار/مفتاح) تمرّ بمربع الإذن العربي نفسه — Codex لا
      // يبوّب نداءات MCP، فنبوّبها هنا (نفس قناة أذونات الأوامر: emit + resolvePermission).
      // الفعل الحسّاس وميزانية الأفعال يتجاوزان «الموافقة الدائمة» ووضع التحكم؛ bypassPermissions وحده يعفيهما.
      requestPermission: (toolName, input, access, neverAlways, target, currentUrl, pageContext, rawInput) => new Promise((resolve) => {
        const policyInput = rawInput && typeof rawInput === 'object' ? rawInput : input;
        const budgetStatus = actionBudget.check(toolName);
        const sensitive = browserpolicy.isSensitiveAction(toolName, policyInput, pageContext);
        const leakRisk = browserpolicy.hasLeakRisk(browserpolicy.leakValueForTool(toolName, policyInput));
        const forcePrompt = sensitive || browserpolicy.requiresExplicitApproval(toolName)
          || leakRisk || (budgetStatus.impacting && !budgetStatus.allowed);
        if (shouldAutoApproveMcp(access, browserControl, permissionMode,
          remembered(toolName), neverAlways, toolName, target, trustedBrowserOrigins, currentUrl,
          policyInput, pageContext, budgetStatus)) {
          actionBudget.consume(toolName);
          resolve(true); return;
        }
        const permId = 'cxmcp_' + (++mcpPermSeq) + '_' + Math.random().toString(36).slice(2, 6);
        const browserClass = browserorigin.classifyBrowserTool(toolName);
        const targetTrusted = browserorigin.isTrusted(target, trustedBrowserOrigins);
        const currentTrusted = browserorigin.isTrusted(currentUrl, trustedBrowserOrigins);
        const trustTarget = targetTrusted && browserClass === 'act' && !currentTrusted ? currentUrl : target;
        const origin = browserorigin.originOf(trustTarget);
        const originTrust = browserControl === true
          && (browserClass === 'navigate' || browserClass === 'act')
          && (!targetTrusted || (browserClass === 'act' && !currentTrusted));
        const policyDetail = browserpolicy.permissionDetail(toolName, policyInput, pageContext, budgetStatus);
        mcpPerms.set(permId, {
          resolve, tool: toolName, neverAlways: !!neverAlways || forcePrompt, originTrust, origin,
          budgetAction: budgetStatus.impacting, budgetExtend: budgetStatus.impacting && !budgetStatus.allowed,
        });
        emit({
          type: 'permission_request', id: permId, tool: toolName, input: input || {},
          detail: [originTrust ? browserorigin.trustPrompt(toolName, trustTarget) + (trustTarget !== target ? '\nوجهة الفعل: ' + target : '') : '',
            policyDetail, 'تفاصيل الفعل:\n' + JSON.stringify(input || {}, null, 2).slice(0, 8000)].filter(Boolean).join('\n\n'),
          turnEligible: false, alwaysEligible: originTrust ? !!origin : (!neverAlways && !forcePrompt),
          alwaysLabel: originTrust ? 'ثق بالنطاق لهذه الجلسة' : '', originTrust,
        });
      }),
      // مؤشّر نشاط: عند كل نداء أداة يومض «🤖 الوكيل …» على لوحة المعاينة (عبر preview.js
      // → previewSender → preview-panel). أدوات Codex تُنفَّذ على خادم HTTP منفصل فلا تظهر
      // كـ tool_use في دوره، فهذا المسار البديل لإظهار نشاطه على المتصفح (نظير app.js لـ SDK).
      onActivity: (method, tool) => { if (method === 'tools/call' && tool) { try { preview.emitAgentActivity(tool); } catch (e) {} } },
      // التسليم البشري (browser_handoff): يبثّ شريط الاستلام للواجهة وينتظر ردّها عبر
      // resolveHandoff (‏satr:handoffDone). بعد الحسم يبثّ handoff_end فيختفي الشريط حتى
      // لو جاء الحسم من إيقاف الدور. startHandoff/endHandoff في يد codexmcp (نظير أداة SDK).
      requestHandoff: (reason, meta) => {
        const id = 'ho_cx_' + (++handoffSeq) + '_' + Math.random().toString(36).slice(2, 6);
        return new Promise((resolve) => {
          pendingHandoffs.set(id, { resolve });
          emit({ type: 'handoff_request', id, reason, mode: meta && meta.mode === 'step' ? 'step' : 'full' });
        }).then((done) => { emit({ type: 'handoff_end', id }); return done; });
      },
    });
  } catch (e) { mcpHost = null; }
  const appServerArgs = ['app-server'];
  const spawnEnv = Object.assign({}, process.env);
  if (mcpHost) {
    appServerArgs.push(
      '-c', 'mcp_servers.satr_preview.url="' + mcpHost.url + '"',
      '-c', 'mcp_servers.satr_preview.bearer_token_env_var="SATR_MCP_TOKEN"',
      // مهلة استدعاء أداة MCP: أفعال المتصفح (نقر/كتابة/اختيار/مفتاح) تنتظر موافقة المستخدم
      // على مربع الإذن العربي عبر guard في codexmcp. مهلة Codex الافتراضية على أداة MCP
      // قصيرة، فكانت تُلغي الاستدعاء قبل أن يلحق المستخدم الموافقة — فيتلقّى النموذج فشلاً
      // ويقترح bypassPermissions بدل انتظار الإذن. نرفعها لتتّسع لموافقة بشرية (الأدوات
      // القرائية لا تنتظر إذناً فلا تتأثر). إيقاف الدور يفكّ أي إذن معلّق فلا تعليق دائم.
      // 1800ث (قرار مالك 2026-07-18): browser_handoff ينتظر تسجيل دخول + 2FA + بريد
      // تحقق بيد المستخدم — 600ث كانت تضيق عنها فيُلغى النداء قبل «استلمت».
      '-c', 'mcp_servers.satr_preview.tool_timeout_sec=1800',
      '-c', 'mcp_servers.satr_preview.startup_timeout_sec=30',
    );
    spawnEnv.SATR_MCP_TOKEN = mcpHost.token;
  }
  // TestSprite لا يدخل المراجعين/العصف المعزول (`browserControl:false`). في دردشة المستخدم
  // يُحقن فقط عند وجود مفتاح من خزنة «سطر»؛ المفتاح في بيئة app-server، وتطلب إعدادات
  // Codex تمريره إلى خادم MCP الثابت دون ظهوره في argv أو config.toml.
  const testspriteApiKey = keys.get(testsprite.KEY_NAME);
  const testspriteRequested = browserControl !== false && testsprite.requested(prompt, {
    available: testsprite.isValidApiKey(testspriteApiKey),
  });
  if (testspriteRequested) {
    testsprite.scrubConfig(cwd);
    const launch = testsprite.codexLaunch(testspriteApiKey);
    if (launch) {
      appServerArgs.push(...launch.args);
      Object.assign(spawnEnv, launch.env);
      if (testspriteHarness.supportsProject(cwd)) {
        try {
          testspriteHarnessHost = await testspriteHarness.start();
          effectivePrompt = testsprite.chatPrompt(prompt, { url: testspriteHarnessHost.url, cwd });
          testspriteProgressWatcher = testsprite.watchResults(cwd, {
            testIds: testsprite.extractTestIds(prompt),
            onUpdate: emit,
          });
          emit({ type: 'testsprite_progress', phase: 'preparing', total: testsprite.extractTestIds(prompt).length,
            completed: 0, passed: 0, failed: 0, skipped: 0 });
          emit({
            type: 'assistant',
            message: { role: 'assistant', content: [{
              type: 'text',
              text: '🧪 بدأ «سطر» سطح TestSprite المؤقت داخل هذا الدور؛ سيوقفه تلقائياً عند الانتهاء.',
            }] },
          });
        } catch (error) {
          const code = error && error.code === 'EADDRINUSE' ? 'المنفذ 4173 مستخدم' : String((error && error.message) || error);
          emit({
            type: 'assistant',
            message: { role: 'assistant', content: [{
              type: 'text',
              text: '⚠️ تعذّر بدء سطح TestSprite التلقائي: ' + code + '. لم يبدأ اختبار الواجهة.',
            }] },
          });
        }
      }
    } else emit({ type: 'stderr', text: testsprite.MISSING_KEY_MESSAGE });
  }
  // الموجة 2 (خارطة المنصّات): جهد التفكير. codex يقبل مفتاح config الرسمي
  // model_reasoning_effort بقيم minimal|low|medium|high|xhigh|max|ultra حسب النموذج.
  // نحقنه عبر -c عند spawn مثل بقية الإعدادات؛ لا --strict-config في الإطلاق
  // فقيمة غير معروفة تُتجاهَل بلا كسر. spawn لكل دور فيعكس اختيار الواجهة اللحظي.
  const CODEX_EFFORT = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra' };
  const eff = CODEX_EFFORT[effort];
  if (eff) appServerArgs.push('-c', 'model_reasoning_effort="' + eff + '"');
  const proc = spawn(bin, appServerArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
  const startedAt = Date.now();
  const skillContext = skillCatalog.resolveSelection(cwd, skills);

  // ترقيم الطلبات وربط الردود؛ pending للأذونات المعلّقة (id طلب الخادم → معلومات)
  let reqId = 0;
  const replies = new Map();       // id طلبنا → {resolve, reject}
  const perms = new Map();         // id طلب الخادم (إذن) → {reqId, tool}
  const pendingQuestions = new Map(); // سؤال app-server → محوّل إجابة الواجهة إلى رد البروتوكول
  const mcpPerms = new Map();      // إذن فعل متصفح MCP معلّق: permId → {resolve, tool}
  let mcpPermSeq = 0;
  const pendingHandoffs = new Map(); // تسليم بشري معلّق: id → {resolve} (browser_handoff)
  let handoffSeq = 0;
  let threadId = null;
  let turnId = null;
  let latestUsage = null;
  let latestContextWindow = null;
  let latestRateLimits = null;
  let finished = false;
  let stopping = false;
  let compacting = false;      // C2: هذا التشغيل ضغط سياق لا دور نصّي
  let compactionSeen = false;  // وصل عنصر contextCompaction المؤكِّد للاكتمال

  // تراكم نصّ رسالة الوكيل الحالية (نبثّه deltas ثم نُصدر assistant مكتملاً)
  const agentText = new Map();     // itemId → نص متراكم
  const agentPhase = new Map();    // itemId → commentary | final_answer
  const startedToolCards = new Set(); // أدوات ظهرت عند item/started وتنتظر نتيجتها
  // بيانات تغييرات الملفات لكل عنصر (تُلتقط عند item/started قبل تطبيق الرقعة):
  // itemId → [{ path, kind }]. تخدم غرضين: عرض المسارات في مربع الإذن (params
  // الإذن في v2 لا تحملها)، والتقاط لقطة «قبل» للتراجع في اللحظة الصحيحة (نظير PreToolUse).
  const fileChangeMeta = new Map();
  const blockedFileChanges = new Set();

  function remembered(toolName) {
    const set = permissionSet(threadId || sessionId);
    return !!set && set.has(toolName);
  }

  function remember(toolName) {
    const set = permissionSet(threadId || sessionId);
    if (set) set.add(toolName);
  }

  function writeMsg(obj) {
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* أُغلق */ }
  }
  function request(method, params, timeoutMs) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      // إصلاح الموثوقية (2026-07-30): وعد RPC عارٍ بلا مهلة كان يعلّق الدور صامتاً
      // إلى الأبد حين تكون عملية app-server حيّة لكن غير مستجيبة («يستعد» بلا نهاية).
      // مهلة اختيارية: عند تجاوزها يُحذف الإدخال ويُرفض الوعد فيقع في مسارات الفشل
      // القائمة (spawn_error/cleanup) بدل الصمت الأبدي. الطلبات بلا مهلة تبقى كما كانت.
      let timer = null;
      if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (replies.delete(id)) reject(new Error('rpc_timeout:' + method));
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      replies.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (err) => { if (timer) clearTimeout(timer); reject(err); },
      });
      writeMsg({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  function respond(id, result) { writeMsg({ jsonrpc: '2.0', id, result }); }
  function respondError(id, code, message) { writeMsg({ jsonrpc: '2.0', id, error: { code, message } }); }

  function normalizeAgentPhase(phase) {
    return phase === 'commentary' ? 'commentary' : 'final_answer';
  }

  // app-server يضاعف إشعارات خيط الجذر وخيوط الوكلاء الفرعيين على الاتصال نفسه.
  // من دون هذا المرشح قد تُعرض رسالة طفل كإجابة الجذر، والأسوأ أن turn/completed
  // للطفل ينهي تشغيل «سطر» كله قبل أن يجمع الجذر بقية النتائج.
  function notificationThreadId(params) {
    return params && (params.threadId || (params.thread && params.thread.id)) || null;
  }
  function notificationTurnId(params) {
    return params && (params.turnId || (params.turn && params.turn.id)) || null;
  }
  function belongsToRootThread(params) {
    const incomingThreadId = notificationThreadId(params);
    return !incomingThreadId || !threadId || incomingThreadId === threadId;
  }
  function belongsToRootTurn(params) {
    if (!belongsToRootThread(params)) return false;
    const incomingTurnId = notificationTurnId(params);
    return !incomingTurnId || !turnId || incomingTurnId === turnId;
  }

  // تُصدر رسالة assistant نصية مكتملة بمرحلتها (تستبدل بثّ stream_text المناظر في الواجهة)
  function emitAssistantText(text, phase) {
    if (!text) return;
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text, phase: normalizeAgentPhase(phase) }] },
    });
  }
  function emitToolStart(id, name, input) {
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }
  function emitToolResult(id, output, isError) {
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output || '', is_error: !!isError }] } });
  }
  function mcpResultText(item) {
    if (item && item.error && item.error.message) return String(item.error.message).slice(0, 20000);
    const result = item && item.result;
    const blocks = result && Array.isArray(result.content) ? result.content : [];
    let text = blocks.map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block.text === 'string') return block.text;
      try { return JSON.stringify(block); } catch { return ''; }
    }).filter(Boolean).join('\n');
    if (!text && result && result.structuredContent != null) {
      try { text = JSON.stringify(result.structuredContent); } catch { text = ''; }
    }
    return text.length > 20000 ? text.slice(0, 20000) + '…' : text;
  }
  // مسار احتياطي إن لم يرسل app-server حدث item/started لإصدار بعينه.
  function emitToolCard(id, name, input, output, isError) {
    emitToolStart(id, name, input);
    emitToolResult(id, output, isError);
  }

  // التقاط لقطة «قبل» لتغيير ملف — تُستدعى عند item/started (قبل تطبيق الرقعة).
  // add ⇒ before=null (التراجع=حذف). update/delete ⇒ before=محتوى القرص الحالي.
  function captureSnapshot(callId, filePath, kind) {
    try {
      const absPath = projectPath(cwd, filePath);
      if (!absPath) return false;
      let before = null, tooLarge = false;
      if (kind !== 'add') {
        try {
          const st = fs.statSync(absPath);
          if (st.isFile()) {
            if (st.size > MAX_DIFF_BYTES) tooLarge = true;
            else before = fs.readFileSync(absPath, 'utf8');
          }
        } catch { before = null; } // غير موجود ⇒ يُعامل كجديد
      }
      rememberSnapshot(callId + '::' + absPath, { file_path: absPath, before, tooLarge });
      return true;
    } catch { /* الالتقاط تحسين، لا يكسر الدور */ }
    return false;
  }

  // بطاقة فرق من تغيير ملف Codex بعد تطبيقه (نقرأ «بعد» من القرص، و«قبل» من اللقطة).
  function emitFileChange(callId, filePath, kind) {
    try {
      const absPath = projectPath(cwd, filePath);
      if (!absPath) return;
      const snap = editSnapshots.get(callId + '::' + absPath);
      if (snap && snap.tooLarge) return;
      const before = snap ? snap.before : null;
      let after = null;
      if (kind === 'delete') after = '';
      else { try { after = fs.readFileSync(absPath, 'utf8'); } catch { after = null; } }
      if (after == null) return;
      if (Buffer.byteLength(after) > MAX_DIFF_BYTES) return;
      const d = computeDiff(before == null ? '' : before, after);
      emit({
        type: 'file_edit', id: callId + '::' + absPath, tool: 'apply_patch',
        rel: relPath(cwd, absPath), isNew: before == null,
        added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
      });
    } catch { /* العرض تحسين، لا يكسر الدور */ }
  }

  // ---------- معالجة رسالة واردة من app-server ----------
  function handle(m) {
    // (أ) ردّ على طلب أرسلناه
    if (m.id != null && replies.has(m.id)) {
      const { resolve, reject } = replies.get(m.id);
      replies.delete(m.id);
      if (m.error) reject(new Error((m.error && m.error.message) || 'rpc_error'));
      else resolve(m.result);
      return;
    }
    // (ب) ServerRequest (id قد يكون 0! ⇒ id != null لا truthy) — أذونات
    if (m.id != null && m.method) {
      onServerRequest(m);
      return;
    }
    // (ج) notification (بلا id) — أحداث. نعتمد v2 (item/* thread/* turn/*) ونتجاهل توأم v1 (codex/event/*)
    if (m.method) onNotification(m.method, m.params || {});
  }

  function onServerRequest(m) {
    const method = m.method || '';
    const p = m.params || {};
    if (method === 'item/tool/requestUserInput') {
      const rawQuestions = Array.isArray(p.questions) ? p.questions : [];
      const supported = rawQuestions.length >= 1 && rawQuestions.length <= 3
        && rawQuestions.every((question) => !Array.isArray(question.options)
          || (question.options.length >= 2 && question.options.length <= 6));
      if (!supported) {
        respond(m.id, { answers: {} });
        emit({ type: 'stderr', text: 'طلب Codex أسئلة خارج الحدود المدعومة؛ أُلغي الطلب بأمان.' });
        return;
      }
      const id = 'cxq_' + m.id + '_' + Math.random().toString(36).slice(2, 8);
      const questions = rawQuestions.map((question) => ({
        header: String(question.header || '').slice(0, 80),
        question: String(question.question || '').slice(0, 1000),
        kind: Array.isArray(question.options) ? (question.isOther ? 'choiceOther' : 'choice') : 'text',
        secret: question.isSecret === true,
        multiSelect: false,
        options: (question.options || []).map((option) => ({
          label: String(option.label || '').slice(0, 200),
          description: String(option.description || '').slice(0, 600),
        })),
      }));
      pendingQuestions.set(id, {
        serverId: m.id,
        answer(selections) {
          const answers = {};
          for (const selection of selections || []) {
            const source = rawQuestions[selection.questionIndex];
            if (!source) continue;
            if (typeof selection.text === 'string' && selection.text) {
              answers[source.id] = { answers: [selection.text] };
            } else if (Array.isArray(source.options)) {
              answers[source.id] = { answers: (selection.optionIndexes || [])
                .map((index) => source.options[index] && source.options[index].label).filter(Boolean) };
            }
          }
          respond(m.id, { answers });
        },
      });
      emit({ type: 'question_request', id, questions });
      return;
    }
    if (method === 'item/permissions/requestApproval') {
      const permissionId = 'cxperm_' + m.id + '_' + Math.random().toString(36).slice(2, 8);
      const requested = p.permissions && typeof p.permissions === 'object' ? p.permissions : {};
      const paths = [];
      const fileSystem = requested.fileSystem || {};
      for (const name of ['read', 'write']) if (Array.isArray(fileSystem[name])) paths.push(...fileSystem[name]);
      if (Array.isArray(fileSystem.entries)) {
        for (const entry of fileSystem.entries) {
          const item = entry && entry.path;
          if (item && item.type === 'path') paths.push(item.path);
          else if (item && item.type !== 'special') paths.push('');
          else if (item && item.value && item.value.kind !== 'project_roots') paths.push('');
          else if (item && item.value && item.value.subpath != null
            && (typeof item.value.subpath !== 'string' || path.isAbsolute(item.value.subpath)
              || !projectPath(cwd, item.value.subpath))) paths.push('');
        }
      }
      const safe = paths.every((filePath) => filePath && projectPath(cwd, filePath));
      perms.set(permissionId, {
        serverId: m.id, tool: 'request_permissions',
        decide(allow, always) {
          respond(m.id, { permissions: allow && safe ? requested : {}, scope: allow && always ? 'session' : 'turn' });
        },
      });
      emit({ type: 'permission_request', id: permissionId, tool: 'request_permissions',
        input: { cwd: p.cwd || cwd, reason: p.reason || '', permissions: requested }, alwaysEligible: safe });
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      // هذه موافقة Codex الخارجية فقط؛ بوابة codexmcp الداخلية تبقى صاحبة قرار الأمان الفعلي.
      if (isInternalMcpApprovalElicitation(p)) {
        respond(m.id, { action: 'accept', content: {} });
        return;
      }
      if (p.mode === 'form' && p.requestedSchema && p.requestedSchema.properties) {
        const fields = Object.entries(p.requestedSchema.properties);
        const normalized = fields.map(([name, schema]) => {
          let options = [];
          if (Array.isArray(schema.enum)) {
            options = schema.enum.map((value, index) => ({ value,
              label: Array.isArray(schema.enumNames) && schema.enumNames[index] || value }));
          } else if (Array.isArray(schema.oneOf)) {
            options = schema.oneOf.map((item) => ({ value: item.const, label: item.title || item.const }));
          } else if (schema.type === 'array' && schema.items) {
            const items = Array.isArray(schema.items.enum) ? schema.items.enum.map((value) => ({ value, label: value }))
              : Array.isArray(schema.items.anyOf)
                ? schema.items.anyOf.map((item) => ({ value: item.const, label: item.title || item.const })) : [];
            options = items;
          } else if (schema.type === 'boolean') {
            options = [{ value: true, label: 'نعم' }, { value: false, label: 'لا' }];
          }
          const text = ['string', 'number', 'integer'].includes(schema.type);
          return { name, schema, options, text, multi: schema.type === 'array' };
        });
        if (normalized.length && normalized.length <= 3
          && normalized.every((field) => field.text || field.options.length >= 2)) {
          const questionId = 'cxelicitq_' + m.id + '_' + Math.random().toString(36).slice(2, 8);
          pendingQuestions.set(questionId, {
            serverId: m.id,
            answer(selections) {
              if (!Array.isArray(selections) || !selections.length) {
                respond(m.id, { action: 'decline', content: null });
                return;
              }
              const content = {};
              let valid = true;
              for (const selection of selections) {
                const field = normalized[selection.questionIndex];
                if (!field) continue;
                if (field.text && typeof selection.text === 'string') {
                  const value = field.schema.type === 'string' ? selection.text : Number(selection.text);
                  const lengthOk = field.schema.type !== 'string'
                    || ((field.schema.minLength == null || value.length >= field.schema.minLength)
                      && (field.schema.maxLength == null || value.length <= field.schema.maxLength));
                  const numberOk = field.schema.type === 'integer' ? Number.isInteger(value)
                    : field.schema.type === 'number' ? Number.isFinite(value) : true;
                  const rangeOk = typeof value !== 'number'
                    || ((field.schema.minimum == null || value >= field.schema.minimum)
                      && (field.schema.maximum == null || value <= field.schema.maximum));
                  if (lengthOk && numberOk && rangeOk) content[field.name] = value;
                  else valid = false;
                } else {
                  const selected = (selection.optionIndexes || []).map((index) => field.options[index]).filter(Boolean);
                  if (field.multi && selected.length) content[field.name] = selected.map((option) => option.value);
                  else if (selected[0]) content[field.name] = selected[0].value;
                  else valid = false;
                }
              }
              respond(m.id, valid ? { action: 'accept', content } : { action: 'decline', content: null });
            },
          });
          emit({ type: 'question_request', id: questionId, questions: normalized.map((field) => ({
            header: String(field.schema.title || p.serverName || 'MCP').slice(0, 80),
            question: String(field.schema.description || p.message || field.name).slice(0, 1000),
            kind: field.text ? 'text' : 'choice',
            secret: field.schema.format === 'password',
            multiSelect: field.multi,
            options: field.options.map((option) => ({ label: String(option.label), description: '' })),
          })) });
          return;
        }
        respond(m.id, { action: 'decline', content: null });
        emit({ type: 'stderr', text: 'نموذج MCP يتطلب حقولاً حرة غير مدعومة؛ أُلغي بأمان.' });
        return;
      }
      if (p.mode !== 'url') {
        respond(m.id, { action: 'decline', content: null });
        return;
      }
      const permissionId = 'cxelicit_' + m.id + '_' + Math.random().toString(36).slice(2, 8);
      perms.set(permissionId, {
        serverId: m.id, tool: 'mcp_elicitation',
        decide(allow) {
          if (allow && typeof p.url === 'string') emit({ type: 'preview_open', url: p.url });
          respond(m.id, { action: allow ? 'accept' : 'decline', content: null });
        },
      });
      emit({ type: 'permission_request', id: permissionId, tool: 'mcp_elicitation',
        input: { server: p.serverName || '', mode: p.mode || '', message: p.message || '', url: p.url || '' },
        alwaysEligible: false });
      return;
    }
    if (method === 'item/tool/call') {
      respond(m.id, { success: false, contentItems: [{ type: 'inputText', text: 'الأدوات الديناميكية غير مسجلة في سطر.' }] });
      return;
    }
    // أذونات تنفيذ الأوامر وتعديل الملفات — نبثّها كمربع إذن عربي وننتظر الرد
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
        || method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const isFile = method.includes('fileChange') || method.includes('applyPatch');
      const toolName = isFile ? 'apply_patch' : 'Shell';
      const command = isFile ? '' : (Array.isArray(p.command) ? p.command.join(' ') : (p.command || ''));
      const knownFilePaths = isFile
        ? (fileChangeMeta.get(p.itemId) || []).map((change) => change.path)
          .concat(Object.keys(p.fileChanges || p.changes || {})) : [];
      const unsafeFileRequest = isFile && (
        blockedFileChanges.has(p.itemId)
        || (p.grantRoot && !projectPath(cwd, p.grantRoot))
        || knownFilePaths.some((filePath) => !projectPath(cwd, filePath))
      );
      if (unsafeFileRequest) {
        respond(m.id, { decision: 'decline' });
        emit({ type: 'stderr', text: 'حُجب تعديل أو منح كتابة خارج جذر المشروع.' });
        return;
      }
      if (!isFile && execguard.isServerCommand(command)) {
        respond(m.id, { decision: 'decline' });
        emit({ type: 'stderr', text: execguard.buildRedirectMessage() });
        return;
      }
      // **مراجعة Codex (مثبّتة)**: ذكر المستخدم للمتصفح الخارجي لا يعطّل الحاجب كلياً —
      // المطابقة (externalBrowser + allowExternalBrowser) تفرض مربع إذن **لمرة واحدة**
      // بتخطي القبول التلقائي أدناه، فلا تعفيها «موافقة دائمة» سابقة على Shell.
      const externalBrowser = !isFile && browserControl !== false && isExternalBrowserLaunchCommand(command);
      if (externalBrowser && !allowExternalBrowser) {
        respond(m.id, { decision: 'decline' });
        emit({ type: 'stderr', text: 'حُجب فتح متصفح خارجي. استخدم أدوات معاينة «سطر» (open_preview وbrowser_*).' });
        return;
      }
      // قبول تلقائي بلا سؤال:
      //  - أداة موافَق عليها «دائماً» لهذه الجلسة (عدا أمر متصفح خارجي — يسأل كل مرة).
      //  - وضع acceptEdits: التعديلات (apply_patch) تُقبل تلقائياً — الأوامر تبقى تسأل
      //    (مطابقة سلوك acceptEdits في Claude: Edit/Write تلقائية وBash يسأل).
      if (!externalBrowser && (remembered(toolName)
        || (permissionMode === 'acceptEdits' && isFile && knownFilePaths.length > 0))) {
        respond(m.id, { decision: 'accept' });
        return;
      }
      // input للعرض في المربع (نقصّ الطويل). params إذن الملفات في v2 لا تحمل المسارات،
      // فنجلبها من fileChangeMeta الملتقطة عند item/started (بمفتاح itemId).
      let input;
      if (isFile) {
        const meta = fileChangeMeta.get(p.itemId) || [];
        const files = meta.map((c) => relPath(cwd, c.path));
        input = { changes: files.length ? files : Object.keys(p.fileChanges || p.changes || {}).map((f) => relPath(cwd, f)) };
      } else {
        input = { command, cwd: p.cwd || cwd, reason: p.reason || undefined };
      }
      const permId = 'cx_' + m.id + '_' + Math.random().toString(36).slice(2, 8);
      perms.set(permId, { serverId: m.id, tool: toolName });
      emit({ type: 'permission_request', id: permId, tool: toolName, input });
      return;
    }
    // طلبات أخرى من الخادم لا نتعامل معها الآن — ردّ فارغ حتى لا يعلّق
    respondError(m.id, -32601, 'Server request not supported by Satr: ' + method);
  }

  function onNotification(method, p) {
    switch (method) {
      case 'thread/started': {
        if (!belongsToRootThread(p)) break;
        threadId = notificationThreadId(p) || threadId;
        if (threadId) emit({ type: 'system', subtype: 'init', session_id: threadId });
        break;
      }
      case 'turn/started': {
        if (!belongsToRootTurn(p)) break;
        turnId = p.turn && p.turn.id || turnId;
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (!belongsToRootTurn(p)) break;
        const tokenUsage = p.tokenUsage || {};
        const total = tokenUsage.total || {};
        latestUsage = {
          input: Number(total.inputTokens) || 0,
          output: Number(total.outputTokens) || 0,
          cached: Number(total.cachedInputTokens) || 0,
          reasoning: Number(total.reasoningOutputTokens) || 0,
          source: 'actual',
        };
        latestContextWindow = Number(tokenUsage.modelContextWindow) || null;
        // C2: لقطة سياق للوحة /سياق — من `last` (آخر طلب) لا `total` التراكمي.
        // نسجّل ما يعلنه upstream كما هو بلا تأويل، ونتخطى الإشعار بلا نافذة سياق.
        const last = tokenUsage.last || {};
        if (latestContextWindow) rememberContext(threadId, {
          totalTokens: Number(last.totalTokens) || 0,
          inputTokens: Number(last.inputTokens) || 0,
          outputTokens: Number(last.outputTokens) || 0,
          cachedInputTokens: Number(last.cachedInputTokens) || 0,
          reasoningTokens: Number(last.reasoningOutputTokens) || 0,
          contextWindow: latestContextWindow,
          model: model || DEFAULT_MODEL,
          at: Date.now(),
        });
        emit({ type: 'usage_update', usage: latestUsage, context_window: latestContextWindow });
        break;
      }
      case 'account/rateLimits/updated': {
        latestRateLimits = p.rateLimits || null;
        emit({ type: 'rate_limits', rate_limits: latestRateLimits });
        break;
      }
      case 'model/rerouted': {
        if (!belongsToRootTurn(p)) break;
        emit({ type: 'stderr', text: 'حوّل Codex النموذج تلقائياً من ' + String(p.fromModel || 'النموذج المختار')
          + ' إلى ' + String(p.toModel || 'نموذج بديل') + ' بسبب سياسة الخدمة.' });
        break;
      }
      case 'model/verification': {
        if (!belongsToRootTurn(p)) break;
        if (Array.isArray(p.verifications) && p.verifications.length) {
          emitAssistantText('تحقق Codex من متطلبات الوصول الخاصة بهذا الدور.', 'commentary');
        }
        break;
      }
      case 'item/agentMessage/delta': {
        if (!belongsToRootTurn(p)) break;
        if (p.delta) {
          const itemId = p.itemId || '_';
          const phase = normalizeAgentPhase(p.phase || agentPhase.get(itemId));
          if (p.phase) agentPhase.set(itemId, phase);
          emit({ type: 'stream_text', text: p.delta, phase });
          agentText.set(itemId, (agentText.get(itemId) || '') + p.delta);
        }
        break;
      }
      case 'item/started': {
        if (!belongsToRootTurn(p)) break;
        // بداية عنصر: لعناصر تغيير الملفات نلتقط لقطة «قبل» الآن (قبل تطبيق الرقعة —
        // اللحظة الصحيحة للتراجع، نظير PreToolUse) ونخزّن مساراتها لمربع الإذن.
        const it = p.item || {};
        if (it.type === 'agentMessage' && it.id && it.phase) agentPhase.set(it.id, normalizeAgentPhase(it.phase));
        if (it.type === 'commandExecution' && it.id) {
          const command = typeof it.command === 'string' ? it.command : (Array.isArray(it.command) ? it.command.join(' ') : '');
          emitToolStart(it.id, 'Shell', { command, cwd: it.cwd || cwd });
          startedToolCards.add(it.id);
        }
        if (it.type === 'mcpToolCall' && it.id) {
          emitToolStart(it.id, (it.server ? it.server + ':' : '') + (it.tool || 'MCP'), it.arguments || {});
          startedToolCards.add(it.id);
        }
        if (it.type === 'fileChange' && Array.isArray(it.changes)) {
          const meta = [];
          for (const ch of it.changes) {
            const abs = projectPath(cwd, ch.path || '');
            const kind = (ch.kind && ch.kind.type) || 'update';
            if (!abs) {
              blockedFileChanges.add(it.id);
              emit({ type: 'stderr', text: 'حُجب مسار تعديل خارج جذر المشروع.' });
              continue;
            }
            meta.push({ path: abs, kind });
            if (abs) captureSnapshot(it.id, abs, kind);
          }
          fileChangeMeta.set(it.id, meta);
        }
        break;
      }
      case 'turn/plan/updated': {
        if (!belongsToRootTurn(p)) break;
        // عقد Codex v2 المثبّت بالـschema: plan[{step,status pending|inProgress|completed}].
        // التفكير يبقى transcript؛ الخطة تُطبّع كحالة task_update كاملة قابلة للحفظ والقياس.
        if (Array.isArray(p.plan)) emit({
          type: 'task_update',
          schema_version: 1,
          session_id: p.threadId || threadId,
          mode: 'replace',
          source: 'codex_plan',
          tasks: p.plan.map((item, index) => ({
            id: 'codex-plan-' + (index + 1),
            title: item && item.step,
            status: item && item.status === 'inProgress' ? 'in_progress'
              : item && item.status === 'completed' ? 'completed' : 'pending',
            owner: 'Codex',
            dependencies: [],
            evidence: [],
          })),
        });
        break;
      }
      case 'item/completed': {
        if (!belongsToRootTurn(p)) break;
        onItemCompleted(p.item || {});
        break;
      }
      case 'turn/completed': {
        if (!belongsToRootTurn(p)) break;
        finishTurn(p.turn || {});
        break;
      }
      case 'turn/failed': {
        if (!belongsToRootTurn(p)) break;
        finishTurn(p.turn || { status: 'failed', error: p.error });
        break;
      }
      case 'mcpServer/startupStatus/updated': {
        // رؤية الويب (الخيار 1): نرصد حالة خادمنا satr_preview فقط. الفشل نادر (المنفذ
        // محلي والرمز يُمرَّر بالبيئة) لكن إن حدث نُبلّغه كـ stderr للتشخيص بلا كسر الدور.
        if (p && p.name === 'satr_preview' && p.status === 'failed') {
          emit({ type: 'stderr', text: 'تعذّر ربط رؤية الويب (satr_preview MCP) — يعمل Codex بلا معاينة.' });
        }
        break;
      }
      default: break;
    }
  }

  function onItemCompleted(item) {
    const t = item.type;
    if (t === 'agentMessage') {
      // النص الكامل — نُصدر assistant (يستبدل بثّ stream_text في الواجهة)
      const text = (typeof item.text === 'string' && item.text) || agentText.get(item.id) || '';
      const phase = normalizeAgentPhase(item.phase || agentPhase.get(item.id));
      emitAssistantText(text, phase);
      agentText.delete(item.id);
      agentPhase.delete(item.id);
    } else if (t === 'commandExecution') {
      const cmd = typeof item.command === 'string' ? item.command : (Array.isArray(item.command) ? item.command.join(' ') : '');
      const out = item.aggregatedOutput || item.stdout || '';
      const isErr = typeof item.exitCode === 'number' ? item.exitCode !== 0 : false;
      if (startedToolCards.delete(item.id)) emitToolResult(item.id, out, isErr);
      else emitToolCard(item.id, 'Shell', { command: cmd, cwd: item.cwd || cwd }, out, isErr);
    } else if (t === 'fileChange') {
      // نفضّل بيانات item/started الملتقطة (قد يختصر item/completed الحقول)؛ وإلا item الحالي
      const changes = fileChangeMeta.get(item.id)
        || (Array.isArray(item.changes) ? item.changes.map((ch) => ({ path: ch.path, kind: (ch.kind && ch.kind.type) || 'update' })) : []);
      for (const ch of changes) {
        if (ch.path) emitFileChange(item.id, ch.path, ch.kind);
      }
      fileChangeMeta.delete(item.id);
      blockedFileChanges.delete(item.id);
    } else if (t === 'mcpToolCall') {
      const output = mcpResultText(item);
      const isError = item.status === 'failed' || !!item.error;
      if (startedToolCards.delete(item.id)) emitToolResult(item.id, output, isError);
      else emitToolCard(
        item.id,
        (item.server ? item.server + ':' : '') + (item.tool || 'MCP'),
        item.arguments || {},
        output,
        isError
      );
    } else if (t === 'reasoning') {
      // ملخّص تفكير (نادر الظهور — «سطر» لا يعرض تفكير Claude أصلاً). نعرضه مقتضباً إن وُجد.
      // الحقل غير مضمون عبر الإصدارات فنجرّب text/summary/content دفاعياً.
      let r = (typeof item.text === 'string' && item.text)
        || (typeof item.summary === 'string' && item.summary)
        || (Array.isArray(item.content) ? item.content.map((c) => (c && (c.text || c.summary)) || '').filter(Boolean).join(' ') : '');
      r = String(r || '').trim();
      if (r) emitAssistantText('💭 ' + (r.length > 600 ? r.slice(0, 600) + '…' : r), 'commentary');
    } else if (t === 'webSearch') {
      emitToolCard(item.id, 'WebSearch', { query: item.query || '' }, item.action || 'اكتمل البحث', false);
    } else if (t === 'imageView') {
      emitToolCard(item.id, 'ImageView', { path: item.path || '' }, 'اكتملت معاينة الصورة', false);
    } else if (t === 'dynamicToolCall') {
      const output = Array.isArray(item.contentItems)
        ? item.contentItems.map((part) => part && (part.text || part.imageUrl) || '').filter(Boolean).join('\n') : '';
      emitToolCard(item.id, item.tool || 'DynamicTool', item.arguments || {}, output, item.success === false);
    } else if (t === 'collabAgentToolCall') {
      emitToolCard(item.id, 'Codex:' + (item.tool || 'collaboration'),
        { model: item.model || '', receivers: item.receiverThreadIds || [] }, item.status || '', item.status === 'failed');
    } else if (t === 'enteredReviewMode' || t === 'exitedReviewMode') {
      emitAssistantText(t === 'enteredReviewMode' ? 'بدأ Codex وضع المراجعة.' : 'أنهى Codex وضع المراجعة.', 'commentary');
    } else if (t === 'contextCompaction') {
      // C2 — إشارة اكتمال الضغط المثبّتة بالمسبار: `thread/compacted` (الموسومة
      // Deprecated في الـschema) لم تصل قط؛ الواصل فعلاً هو عنصر contextCompaction
      // بحمولة {id, type} فقط — **بلا أرقام رموز قبل/بعد** (حدّ upstream موثّق).
      if (compacting) {
        compactionSeen = true;
        // بطاقة الواجهة القائمة تعرض الأرقام فقط إن كان pre_tokens رقماً، فغيابها
        // يعطي «🗜 ضُغطت المحادثة» صادقة بلا رقم مختلق ولا تغيير في المكوّن.
        emit({
          type: 'system', subtype: 'compact_boundary', session_id: threadId,
          compact_metadata: { trigger: 'manual' },
        });
      } else emitAssistantText('ضغط Codex سياق المحادثة لمتابعة العمل.', 'commentary');
    }
  }

  function finishTurn(turn) {
    if (finished) return;
    finished = true;
    const isError = turn.status === 'failed' || !!turn.error;
    const errMsg = turn.error && (turn.error.message || turn.error);
    // خطأ الطبقة (نموذج غير مدعوم بالخطة/الإصدار…) — نظهره نصاً واضحاً للمستخدم
    if (isError && errMsg) {
      let human = String(errMsg);
      try { const j = JSON.parse(human); if (j && j.detail) human = j.detail; } catch {}
      emitAssistantText('⚠️ تعذّر إكمال الدور: ' + human, 'final_answer');
    }
    // C2: ضغط انتهى دوره بلا عنصر contextCompaction ⇒ لا ندّعي نجاحاً ببطاقة ضغط
    if (compacting && !compactionSeen && !isError) {
      emitAssistantText('⚠️ لم يؤكّد Codex اكتمال ضغط المحادثة. المحادثة مستمرة كما هي.', 'final_answer');
    }
    emit({
      type: 'result', subtype: isError ? 'error' : 'success',
      is_error: isError, session_id: threadId,
      duration_ms: Date.now() - startedAt, total_cost_usd: null,
      usage: latestUsage, context_window: latestContextWindow, rate_limits: latestRateLimits,
    });
    cleanup(0);
  }

  function cleanup(code) {
    // رفض أي إذن معلّق ثم إنهاء العملية بلطف. نغلق stdin (إشارة إنهاء لـ app-server)
    // ونمهله لحظة ليُفرّغ ملف الجلسة إلى القرص قبل القتل — وإلا قد يُبتر فيفشل
    // استئنافها لاحقاً (درس مثبّت: القتل الفوري بعد result يقطع تفريغ الجلسة).
    for (const [permId, info] of perms) {
      try { if (info.decide) info.decide(false, false); else respond(info.serverId, { decision: 'cancel' }); } catch {}
      perms.delete(permId);
    }
    for (const [questionId, info] of pendingQuestions) {
      try { info.answer([]); } catch {}
      pendingQuestions.delete(questionId);
    }
    // فكّ أي إذن فعل متصفح معلّق بالرفض (لا يعلّق نداء MCP بعد إنهاء الدور)
    for (const [permId, info] of mcpPerms) { try { info.resolve(false); } catch {} mcpPerms.delete(permId); }
    // فكّ أي تسليم بشري معلّق بالإلغاء (متابعة codexmcp تنهي التسليم وتصفّر السجلات)
    for (const [hid, info] of pendingHandoffs) { try { info.resolve(false); } catch {} pendingHandoffs.delete(hid); }
    preview.clearSecretTransfers();
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 500);
    if (mcpHost) { try { mcpHost.stop(); } catch {} mcpHost = null; } // أوقِف خادم رؤية الويب MCP
    if (testspriteHarnessHost) {
      const host = testspriteHarnessHost;
      testspriteHarnessHost = null;
      host.close().catch(() => {});
    }
    if (testspriteProgressWatcher) {
      testspriteProgressWatcher.stop();
      testspriteProgressWatcher = null;
    }
    if (testspriteRequested) {
      testsprite.scrubConfig(cwd);
      setTimeout(() => testsprite.scrubConfig(cwd), 750);
    }
    if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
  }
  let emittedDone = false;

  // ---------- قراءة stdout سطراً سطراً ----------
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      try { handle(m); } catch (e) { emit({ type: 'stderr', text: 'codex handle: ' + String((e && e.message) || e) }); }
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    // نُخفي ضوضاء تحديث التوكن؛ نمرّر الباقي كـ stderr
    if (!/refresh|models_manager|token/i.test(s)) emit({ type: 'stderr', text: s });
  });
  proc.on('error', (e) => {
    emit({ type: 'spawn_error', text: 'تعذّر تشغيل Codex: ' + String((e && e.message) || e) });
    cleanup(1);
  });
  proc.on('exit', (code) => {
    if (testspriteRequested) testsprite.scrubConfig(cwd);
    if (!finished && !stopping) emit({ type: 'spawn_error', text: 'أُنهيت عملية Codex (كود ' + code + ')' });
    if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
  });

  // ---------- تسلسل الإقلاع: initialize → thread/start أو resume → turn/start ----------
  (async () => {
    try {
      await request('initialize', { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } }, BOOT_REQUEST_TIMEOUT_MS);
      writeMsg({ method: 'initialized', params: {} });
  const { approvalPolicy, sandbox } = mapMode(permissionMode);
  const resolvedModel = model || DEFAULT_MODEL;
      // تعريف الوكيل ببيئته والنموذج المختار (نظير systemPrompt في agent.js). النماذج لا
      // تعرف اسمها الرمزي (بيانات التدريب تسبق الإصدار) فتُعرّف نفسها عموماً بـ GPT-5؛
      // حقن الاسم هنا يجعلها تجيب بدقّة. developerInstructions إضافي (لا يستبدل تعليمات Codex).
      const devInstructions = envbrief.build('codex', resolvedModel);
      const startParams = { cwd, approvalPolicy, sandbox, developerInstructions: devInstructions, experimentalRawEvents: false, persistExtendedHistory: false };
      if (sessionId) {
        // استئناف خيط قائم من القرص (~/.codex/sessions) بمعرّفه. الحقول cwd/السياسة/
        // persistExtendedHistory مطلوبة (persistExtendedHistory ليست اختيارية في السكيمة).
        try {
          const r = await request('thread/resume', { threadId: sessionId, cwd, approvalPolicy, sandbox, developerInstructions: devInstructions, persistExtendedHistory: false }, BOOT_REQUEST_TIMEOUT_MS);
          threadId = (r && r.thread && r.thread.id) || sessionId;
        } catch (e) {
          // فشل الاستئناف (جلسة محذوفة/تالفة) ⇒ نبدأ خيطاً جديداً بدل تعليق الدور
          emit({ type: 'stderr', text: 'تعذّر استئناف جلسة Codex — بدء جلسة جديدة' });
          const r = await request('thread/start', startParams, BOOT_REQUEST_TIMEOUT_MS);
          threadId = r && r.thread && r.thread.id;
        }
      } else {
        const r = await request('thread/start', startParams, BOOT_REQUEST_TIMEOUT_MS);
        threadId = r && r.thread && r.thread.id;
      }
      if (threadId) emit({ type: 'system', subtype: 'init', session_id: threadId });
      // ---------- C2: ضغط سياق Codex (/ضغط) ----------
      // «/compact» ليس نصّ دور عند Codex بل استدعاء `thread/compact/start {threadId}`
      // (نمط kimi.js المثبّت: الأمر المائل يُعالَج داخل المحرك). لا مهارات ولا ذاكرة
      // ولا صور تُحقن — لا مدخل نصّياً أصلاً. الاكتمال يصل كعنصر contextCompaction ثم
      // turn/completed، فيتولّاهما onNotification ويبقى session_id نفسه.
      if (typeof prompt === 'string' && prompt.trim() === COMPACT_COMMAND) {
        compacting = true;
        try {
          await request('thread/compact/start', { threadId }, BOOT_REQUEST_TIMEOUT_MS);
        } catch (e) {
          // تدهور رشيق: إصدار لا يعلن الطريقة (‏-32601) أو يرفضها ⇒ رسالة عربية ثابتة
          // بلا نص خطأ upstream الخام.
          compacting = false;
          emitAssistantText('⚠️ إصدار Codex المثبّت لا يدعم ضغط المحادثة من «سطر».', 'final_answer');
          finishTurn({ status: 'completed' });
        }
        return;
      }
      // مدخلات الدور: نصّ + صور (نماذج Codex تقبل الصور — تحقّق حيّ). الصور base64
      // تُمرَّر كـ data-URL (لا حاجة لملف مؤقت — كلا الشكلين image/localImage يعمل).
      const inputItems = [];
      inputItems.push(...skillCatalog.codexInputs(skillContext));
      // ذاكرة المشروع (الأولوية 4 — تكافؤ agent.js/المحوّلات): استرجاع مقصوص من prompt
      // المستخدم الأصلي (لا effectivePrompt الذي قد يحمل حقن TestSprite)، ككتلة نصية
      // موسومة <satr_project_memory> غير تنفيذية قبل نص الدور. السياقات المعزولة
      // (المراجع/العصف — browserControl:false الصريح، نفس بوابة TestSprite) لا ترثها.
      const memoryPrompt = browserControl === false ? '' : memory.retrieve(cwd, prompt).text;
      if (memoryPrompt) inputItems.push({ type: 'text', text: memoryPrompt, text_elements: [] });
      if (effectivePrompt) inputItems.push({ type: 'text', text: effectivePrompt, text_elements: [] });
      if (Array.isArray(images)) {
        for (const im of images) {
          if (im && im.media_type && im.data) {
            inputItems.push({ type: 'image', url: 'data:' + im.media_type + ';base64,' + im.data });
          }
        }
      }
      if (!inputItems.length) inputItems.push({ type: 'text', text: effectivePrompt || '', text_elements: [] });
      const turnParams = { threadId, input: inputItems, model: resolvedModel };
      const startedTurn = await request('turn/start', turnParams, BOOT_REQUEST_TIMEOUT_MS);
      turnId = startedTurn && startedTurn.turn && startedTurn.turn.id || turnId;
      // الأحداث تصل عبر notifications؛ الدور ينتهي بـ turn/completed
    } catch (e) {
      if (!finished) {
        emit({ type: 'spawn_error', text: 'تعذّر بدء دور Codex: ' + String((e && e.message) || e) });
        emit({ type: 'result', subtype: 'error', is_error: true, session_id: threadId, duration_ms: Date.now() - startedAt, total_cost_usd: null });
      }
      cleanup(1);
    }
  })();

  return {
    // رد الواجهة على طلب إذن → قرار Codex بمفردات v2 (accept/acceptForSession/decline)
    resolvePermission(id, allow, always) {
      // فعل متصفح MCP معلّق (لا serverId — نحلّ Promise الأداة مباشرةً)
      const mcp = mcpPerms.get(id);
      if (mcp) {
        mcpPerms.delete(id);
        if (allow && mcp.budgetExtend) actionBudget.extend();
        if (allow && mcp.budgetAction && !actionBudget.consume(mcp.tool).allowed) {
          try { mcp.resolve(false); } catch {}
          return true;
        }
        if (allow && always && mcp.originTrust && mcp.origin && trustedBrowserOrigins instanceof Set) {
          trustedBrowserOrigins.add(mcp.origin);
        } else if (allow && always && !mcp.neverAlways) remember(mcp.tool);
        try { mcp.resolve(!!allow); } catch {}
        return true;
      }
      const info = perms.get(id);
      if (!info) return false;
      perms.delete(id);
      if (info.decide) {
        info.decide(!!allow, !!always);
        return true;
      }
      if (allow && always) remember(info.tool);
      const decision = allow ? (always ? 'acceptForSession' : 'accept') : 'decline';
      respond(info.serverId, { decision });
      return true;
    },
    resolveQuestion(id, selections) {
      const info = pendingQuestions.get(id);
      if (!info) return false;
      pendingQuestions.delete(id);
      try { info.answer(Array.isArray(selections) ? selections : []); } catch { return false; }
      return true;
    },
    // ---------- التوجيه أثناء الدور (turn/steer — الدفعة C1) ----------
    // عقد v2 من الـschema المولّد: {threadId, expectedTurnId, input:[UserInput]} → {turnId}.
    // expectedTurnId شرط مسبق إلزامي لا تحسيناً: يفشل الطلب إن لم يطابق الدور النشط، فلا
    // يتسرّب توجيه إلى دور لاحق. مثبّت حيّاً (scripts/codex-steer-probe.js على codex-cli
    // 0.144.3): التوجيه الناجح يعيد **معرّف الدور نفسه** (لا ينشئ دوراً جديداً) فمرشّح
    // belongsToRootTurn يبقى صحيحاً بلا تعديل؛ وعدم المطابقة يردّ -32600، وبعد
    // turn/completed يردّ -32600 «no active turn to steer».
    // أمان: رسالة خطأ upstream تحمل معرّف الدور النشط الفعلي، فلا نمرّرها للواجهة —
    // نعيد رموزاً ثابتة فقط.
    async steer(text) {
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body) return { ok: false, error: 'empty' };
      if (finished || stopping || !threadId || !turnId) return { ok: false, error: 'no_active_turn' };
      try {
        const r = await request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text: body, text_elements: [] }],
        });
        return { ok: true, turnId: r && typeof r.turnId === 'string' ? r.turnId : turnId };
      } catch (e) {
        return { ok: false, error: 'rejected' };
      }
    },
    // رد الواجهة على تسليم browser_handoff: done=true «استلمت» / false «إلغاء»
    resolveHandoff(id, done) {
      const h = pendingHandoffs.get(id);
      if (!h) return false;
      pendingHandoffs.delete(id);
      try { h.resolve(!!done); } catch {}
      return true;
    },
    // إيقاف: مقاطعة الدور + رفض الأذونات المعلّقة + إنهاء العملية
    async stop() {
      stopping = true;
      preview.clearSensitiveState();
      for (const [permId, info] of perms) {
        try { if (info.decide) info.decide(false, false); else respond(info.serverId, { decision: 'cancel' }); } catch {}
        perms.delete(permId);
      }
      for (const [questionId, info] of pendingQuestions) { try { info.answer([]); } catch {} pendingQuestions.delete(questionId); }
      for (const [permId, info] of mcpPerms) { try { info.resolve(false); } catch {} mcpPerms.delete(permId); }
      if (threadId && turnId) { try { await request('turn/interrupt', { threadId, turnId }, INTERRUPT_TIMEOUT_MS); } catch {} }
      cleanup(0);
    },
  };
}

module.exports = {
  start, undoEdit, resolveCodexBin, authStatus, accountStatus, listModels, rateLimits, DEFAULT_MODEL,
  isExternalBrowserLaunchCommand, shouldAutoApproveMcp,
  sanitizeSteerText, MAX_STEER_CHARS, // C1: تنقية نص turn/steer (يستهلكها main.js)
  contextUsage, COMPACT_COMMAND,      // C2: لوحة /سياق وأمر /ضغط
  // C3: لوحة /موصلات — mcpOauthUrl لـmain.js وحدها (الرابط لا يعبر IPC)
  mcpStatus, mcpReload, mcpOauthStart, mcpOauthUrl, mcpOauthAwait, mcpOauthCancel,
  safeOauthUrl, sanitizeMcpError,
  // C4: الحساب والاستهلاك — accountLoginUrl لـmain.js وحدها (الرابط لا يعبر IPC)
  accountUsage, accountRateLimits, normalizeRateLimits,
  accountLoginStart, accountLoginUrl, accountLoginAwait, accountLoginCancel,
  _internals: { projectPath, isInternalMcpApprovalElicitation },
};
