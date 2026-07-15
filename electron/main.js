/**
 * سطر 2.0 — العملية الرئيسية (Main Process)
 * مسؤولة عن: إنشاء النافذة، تشغيل Claude CLI، جسر IPC مع الواجهة
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const sessions = require('./sessions');
const files = require('./files');
const searchMod = require('./search'); // بحث محتوى المشروع (الدفعة 4.6)
const gitdiff = require('./gitdiff'); // فروقات git للوحة التغييرات (الدفعة 4.7) — قراءة فقط
const gitactions = require('./gitactions'); // أفعال git للوحة التغييرات (stage/unstage/discard/commit)
const exporter = require('./exporter'); // تصدير المحادثة Markdown (الدفعة 4.8) — قراءة فقط
const skills = require('./skills');
const tasks = require('./tasks');
const verify = require('./verify');
const checkpoints = require('./checkpoints');
const memory = require('./memory');
const opsroom = require('./opsroom');
const opsroomindex = require('./opsroomindex');
const opsartifacts = require('./opsartifacts');
const opsBrainstormModule = require('./opsbrainstorm');
const opsPlannerModule = require('./opsplanner');
const agentsList = require('./agents');
const agent = require('./agent');
const orchestratorModule = require('./orchestrator'); // باحثون قراءة فقط — أولوية 6/الخطوة 1
const executorModule = require('./executor'); // نواة عامل محايدة عن المحرك داخل worktree — الخطوة 2
const executionTeamModule = require('./executionteam'); // 1–3 عوامل بملكية ملفات — الخطوة 3
const reviewerModule = require('./reviewer'); // مراجع فرق قراءة فقط — الخطوة 4
const integration = require('./integration'); // تحقق تكاملي داخل worktree مستقل — المرحلة 5
const merger = require('./merger'); // تطبيق patch بعد المراجعة والتحقق والموافقة — المرحلة 5
const codex = require('./codex'); // محرك Codex الأصيل (المرحلة 1) — خاص مثل sdk
const codexSessions = require('./codexsessions'); // جلسات Codex للوحة /جلسات (قراءة فقط)
const adapters = require('./adapters');
const SAFE_MODEL = /^[A-Za-z0-9.-]{1,64}$/;

// سياسة نماذج غرفة العمليات تُحل في الطبقة العليا فقط، منفصلة عن اختيار الدردشة.
// لا تصل قيم البيئة إلى renderer ولا تقرؤها النوى المحايدة عن المحرك.
function resolveOpsRoomModel(engine, env = process.env, codexDefaultModel = codex.DEFAULT_MODEL) {
  const config = engine === 'sdk'
    ? { defaultModel: 'claude-opus-4-8', envName: 'SATR_OPSROOM_CLAUDE_MODEL', label: 'Claude' }
    : engine === 'codex'
      ? { defaultModel: codexDefaultModel, envName: 'SATR_OPSROOM_CODEX_MODEL', label: 'Codex' }
      : null;
  if (!config) return { ok: false, error: 'ops_model_invalid', engine, envName: '' };
  const override = env && typeof env[config.envName] === 'string' ? env[config.envName] : '';
  const model = override || config.defaultModel;
  if (!SAFE_MODEL.test(model)) {
    return { ok: false, error: 'ops_model_invalid', engine, envName: config.envName, label: config.label };
  }
  return { ok: true, engine, model, source: override ? 'env' : 'default', envName: config.envName };
}

function preflightOpsRoomModels(engines, env = process.env, codexDefaultModel = codex.DEFAULT_MODEL) {
  const models = {};
  for (const engine of [...new Set(Array.isArray(engines) ? engines : [])]) {
    const resolved = resolveOpsRoomModel(engine, env, codexDefaultModel);
    if (!resolved.ok) {
      return {
        ok: false,
        error: 'ops_model_invalid',
        message: 'نموذج غرفة العمليات لمحرك ' + (resolved.label || engine || 'غير معروف')
          + ' غير صالح. صحّح ' + (resolved.envName || 'إعداد النموذج') + ' ثم أعد تشغيل «سطر».',
      };
    }
    models[engine] = resolved.model;
  }
  return { ok: true, models };
}

function resolveOpsRoomRunner(engine) {
  const resolved = resolveOpsRoomModel(engine);
  if (!resolved.ok) return null;
  if (engine === 'sdk') {
    return { engine, model: resolved.model, start: (input, cwd, emit) => agent.start(input, cwd, emit) };
  }
  if (engine === 'codex') {
    return { engine, model: resolved.model, start: (input, cwd, emit) => codex.start(input, cwd, emit) };
  }
  return null;
}

// المرحلة 2 من غرفة العمليات: المحرك الحالي يُحقن صراحةً في النواة المحايدة.
// إدخال Codex للمنفّذ مؤجل حتى ينجح probe العزل في المرحلة 3A.
const sdkExecutionRunner = Object.freeze({
  engine: 'sdk',
  get model() {
    const resolved = resolveOpsRoomModel('sdk');
    return resolved.ok ? resolved.model : null;
  },
  start: (input, cwd, emit) => agent.start(input, cwd, emit),
});
const sdkPlannerRunner = Object.freeze({
  engine: 'sdk',
  get model() { return sdkExecutionRunner.model; },
  start: (input, cwd, emit) => agent.start(input, cwd, emit, { mode: 'read-only-planner' }),
});
function resolveOpsBrainstormRunner(engine) {
  const runner = resolveOpsRoomRunner(engine);
  if (!runner) return null;
  if (engine === 'sdk') {
    return { ...runner, start: (input, cwd, emit) => agent.start(input, cwd, emit, { mode: 'text-only' }) };
  }
  return runner;
}
const executor = executorModule.create({ runner: sdkExecutionRunner });
const executionTeam = executionTeamModule.create({ runner: sdkExecutionRunner });
const orchestrator = orchestratorModule.create({ resolveEngine: resolveOpsRoomRunner });
const reviewer = reviewerModule.create({ resolveEngine: resolveOpsRoomRunner });
const opsBrainstorm = opsBrainstormModule.create({ resolveEngine: resolveOpsBrainstormRunner });
const opsPlanner = opsPlannerModule.create({ runner: sdkPlannerRunner });
const inject = require('./inject');
const chats = require('./chats');
const agentTools = require('./tools'); // أدوات المحوّلات (2.1/2.2) — للتراجع عن تعديلاتها
const features = require('./features');
const keys = require('./keys');
const bgprocs = require('./bgprocs');
const term = require('./term');
const updater = require('./updater');
const preview = require('./preview'); // لوحة المعاينة المدمجة (م-1 — الدفعة 5)

function sdkReviewEngineAvailable() {
  if (!agent.resolveClaudeBin()) return false;
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  try {
    const credentials = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    return !!(credentials && credentials.claudeAiOauth
      && (credentials.claudeAiOauth.accessToken || credentials.claudeAiOauth.refreshToken));
  } catch { return false; }
}

function reviewEngineAvailable(engine) {
  if (engine === 'sdk') return sdkReviewEngineAvailable();
  if (engine === 'codex') return !!codex.resolveCodexBin()
    && (codex.authStatus().ok || !!process.env.CODEX_API_KEY);
  return false;
}

function unavailableReviewEngines(producerEngines) {
  const required = reviewerModule.requiredReviewEngines(producerEngines);
  const engines = required ? [...new Set([...producerEngines, ...required])] : ['invalid'];
  return engines.filter((engine) => !reviewEngineAvailable(engine));
}

const IS_WIN = process.platform === 'win32';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico'); // أيقونة النافذة وشريط المهام

// هوية التطبيق على ويندوز: تضمن تجميع أيقونة شريط المهام تحت «سطر» بدل إلكترون
// (مطابقة لـ appId في البناء) — يجب ضبطها قبل إنشاء النافذة.
if (IS_WIN) { try { app.setAppUserModelId('ai.satr.app'); } catch (e) {} }

let mainWindow = null;
let currentCliRun = null; // مقبض محوّل غير SDK الجاري (cli الاحتياطي وما يليه) — له stop()
let currentRun = null;    // تشغيل Agent SDK الجاري (المسار الافتراضي) — له stop()+resolvePermission

// ---------- مناعة ضد إشارات تحكّم الكونسول (ويندوز) ----------
// المشكلة: الأوامر الطويلة (خادم تطوير مثل `npm run dev`) تعمل ضمن شجرة عمليات
// تشارك كونسول «سطر». عند إيقافها يُبثّ حدث تحكّم كونسول (CTRL_C/CTRL_BREAK) —
// وهو الطريقة المعيارية لإنهاء برامج الكونسول على ويندوز — فيصل **كل** عملية
// تشارك ذلك الكونسول: «سطر» نفسه والطرفية المُشغِّلة وأي طرفية شقيقة. هذا (لا
// taskkill /T الذي ثبت أنه لا يصعد للأب) هو ما كان يُسقط التطبيق.
// الحل: نتجاهل هذه الإشارات في العملية الرئيسية فلا يُنهيها حدث قادم من طفل —
// خروج «سطر» يكون بإغلاق النافذة فقط. (مكمّل لعزل العمليات المنبثقة في مسار CLI
// عبر detached؛ ومسار SDK لا يتيح detached فهذه المناعة هي حمايته الأساسية.)
if (IS_WIN) {
  for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => { /* تجاهل مقصود: لا نُسقط «سطر» بإشارة كونسول من عملية طفل */ }); } catch (e) {}
  }
}

// ---------- النافذة ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0E1116',
    title: 'سطر — Satr',
    autoHideMenuBar: true,
    // أيقونة النافذة (تظهر في شريط المهام عند التطوير؛ المثبّت يضبطها من build.win.icon)
    ...(fs.existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // الروابط الخارجية تفتح في المتصفح وليس داخل التطبيق
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    preview.destroy(); // عرض المعاينة ابن النافذة — تدمير صريح احتياطاً
    stopAll();
  });

  // التحديث التلقائي (المرحلة 17): يُفحص بعد الإقلاع، ويبثّ أحداثه للواجهة عبر emit.
  // لا يعمل إلا في النسخة المحزومة (updater.js يحرس app.isPackaged) فلا يعكّر npm start.
  updater.initUpdater(app, emitToWindow);
}

// ملاحظة: منطق إيقاف مسار cli (detached + taskkill /T) انتقل إلى adapters/claude-cli.js
// (المرحلة 5أ) — يملكه المحوّل عبر stop() على مقبضه. stopAll أدناه يوقّف كلا المحرّكين.

// ---------- فحص أول التشغيل (Preflight) — مانع إطلاق ----------
// «سطر» يعتمد كلياً على Claude Code المثبّت عالمياً (محرك SDK يستدعي الثنائي عبر
// pathToClaudeCodeExecutable، والمحرك الاحتياطي CLI يحتاجه أيضاً). فبدونه يفشل أول
// طلب صامتاً. لذا الواجهة تحجب المحادثة خلف بوابة عربية حتى يتوفّر، وهذا الفحص مصدرها.
// نفحص node و npm أيضاً لأن خطوات الإرشاد تستخدمهما (npm install -g …).

// تشغيل أمر «--version» وإرجاع {ok, version}. shell على ويندوز لأن node/npm/claude قد تكون .cmd
function probeVersion(cmd, args) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { shell: IS_WIN, windowsHide: true });
    } catch (e) { return finish({ ok: false }); }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => finish({ ok: false }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, version: out.trim() } : { ok: false }));
    // حماية: بعض الأوامر قد تتعلّق — لا نُبقي البوابة منتظرة للأبد
    setTimeout(() => { try { child.kill(); } catch (e) {} finish({ ok: false }); }, 8000);
  });
}

// مقارنة semver ثلاثية [major, minor, patch] — تُرجع سالباً/صفراً/موجباً
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
  return 0;
}
// حدّ الميزات الحديثة الموصى به لـ Claude Code (Sonnet 5 وما بعده يحتاج 2.1.197+).
// يُراجَع يدوياً مع الإصدارات؛ لا يحجب التشغيل — إرشاد فقط (لا تحديث تلقائي).
const CLAUDE_MIN_RECOMMENDED = [2, 1, 197];

// لقطة القدرات للواجهة (قراءة فقط): تُظهر/تُخفي قدرات Enterprise. المجتمعية ⇒ {enterprise:false}
ipcMain.handle('satr:features', () => features.snapshot());

// قائمة مزوّدي المحرّكات (طبقة المزوّد §4.2) — لبناء قائمة «المحرك» ديناميكياً في الواجهة
ipcMain.handle('satr:providers', () => ({ providers: adapters.list() }));

// حالة توفّر Codex (المرحلة 4): مثبَّت؟ ومسجَّل الدخول؟ — لإرشاد مضمّن حين يُختار المحرك
// codex وهو غير جاهز (لا يحجب الإطلاق — Claude يبقى بوابة الإطلاق الوحيدة). force=true
// يتجاوز تخزين resolveCodexBin ليلتقط تثبيتاً جرى بعد الإقلاع. لا يُعيد قيم الأسرار.
ipcMain.handle('satr:codexStatus', () => {
  const bin = codex.resolveCodexBin(true);
  return { installed: !!bin, auth: codex.authStatus() };
});

// ---------- مركز مفاتيح المزوّدين (§4.3 — مخزن الأسرار) ----------
// 🔒 أمان: الأسماء المقبولة محصورة بمفاتيح المزوّدين المسجّلين فقط، والقيم لا تُعاد
// للواجهة أبداً (satr:keysList يعيد الأسماء المضبوطة فقط). الكتابة لملف لا spawn.
const SAFE_KEY_NAME = /^[A-Z][A-Z0-9_]{1,64}$/;
function knownKeyNames() {
  return new Set(adapters.list().map((p) => p.keyName).filter(Boolean));
}

ipcMain.handle('satr:keysList', () => ({ names: keys.names() }));

ipcMain.handle('satr:keySet', (event, p) => {
  const name = p && typeof p.name === 'string' ? p.name : '';
  const value = p && typeof p.value === 'string' ? p.value.trim() : '';
  if (!SAFE_KEY_NAME.test(name) || !knownKeyNames().has(name)) return { ok: false, error: 'bad_name' };
  if (!value || value.length > 8192) return { ok: false, error: 'bad_value' };
  try { keys.set(name, value); return { ok: true }; } catch (e) { return { ok: false, error: 'write_failed' }; }
});

ipcMain.handle('satr:keyDelete', (event, p) => {
  const name = p && typeof p.name === 'string' ? p.name : '';
  if (!SAFE_KEY_NAME.test(name) || !knownKeyNames().has(name)) return { ok: false, error: 'bad_name' };
  try { keys.remove(name); return { ok: true }; } catch (e) { return { ok: false, error: 'write_failed' }; }
});

ipcMain.handle('satr:preflight', async () => {
  const [node, npm] = await Promise.all([
    probeVersion('node', ['--version']),
    probeVersion('npm', ['--version']),
  ]);
  // مفتاح اختبار فقط: SATR_FORCE_NO_CLAUDE=1 يحاكي غياب Claude Code للتحقق من البوابة
  // دون إلغاء تثبيته فعلياً (معيار قبول المرحلة 6). لا أثر له في الاستخدام العادي.
  if (process.env.SATR_FORCE_NO_CLAUDE === '1') {
    return { claude: { ok: false, path: null }, node, npm };
  }
  // إعادة اكتشاف claude بالقوة: المستخدم قد ثبّته للتوّ ثم ضغط «أعد الفحص»
  const bin = agent.resolveClaudeBin(true);
  let claude;
  if (bin) {
    const v = await probeVersion(bin, ['--version']);
    claude = { ok: v.ok, version: v.version, path: bin };
  } else {
    // لم يُعثر على ثنائي مُحدَّد — جرّب claude الموجود في PATH مباشرةً
    const v = await probeVersion(CLAUDE_BIN, ['--version']);
    claude = { ok: v.ok, version: v.version, path: v.ok ? CLAUDE_BIN : null };
  }
  // الموجة 3 (خارطة المنصّات): توافق الإصدار. نستخرج semver من نص --version ونقارنه
  // بحدّ الميزات الحديثة؛ إن كان أقدم نضع outdated + الإصدار الموصى به لترشد الواجهة
  // المستخدم للتحديث (لا تحديث تلقائي — «سطر» يعتمد المثبّت العالمي عمداً).
  if (claude.ok && claude.version) {
    const m = String(claude.version).match(/(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      const cur = [Number(m[1]), Number(m[2]), Number(m[3])];
      claude.outdated = cmpVer(cur, CLAUDE_MIN_RECOMMENDED) < 0;
      if (claude.outdated) claude.recommended = CLAUDE_MIN_RECOMMENDED.join('.');
    }
  }
  return { claude, node, npm };
});

// ---------- اختيار مجلد المشروع (نافذة نظام أصلية) ----------

ipcMain.handle('satr:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر مجلد المشروع',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- إرسال طلب إلى Claude Code ----------

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_SKILL = /^[A-Za-z0-9_:.-]{1,64}$/; // اسم مهارة أو plugin:skill
// وضع الأذونات + بوابة auto (الموجة 4) — المنطق النقي في autogate.js (قابل للاختبار
// مستقلاً). PERMISSION_MODES يشمل 'auto'؛ nonSdkPerm يُسقط auto لـ default لغير SDK.
const { PERMISSION_MODES, nonSdkPerm } = require('./autogate');
// اسم خادم MCP قد يحوي مسافات ونقاطاً («claude.ai Google Drive») وأحرفاً غير لاتينية.
// لا يدخل وسائط spawn (يُمرَّر لدالة تحكّم في SDK) لكن نتحقق منه احترازاً.
const SAFE_MCP_NAME = /^[\p{L}\p{N} ._:\/-]{1,128}$/u;
const MCP_ACTIONS = new Set(['reconnect', 'enable', 'disable']);

// تنقية اختيار المهارات القادم من الواجهة قبل تمريره للـ SDK:
// 'all' = كل المكتشفة، مصفوفة أسماء = المُفعَّل فقط (تُفلتر بـ SAFE_SKILL)،
// أي شيء آخر = الافتراضي 'all'. مصفوفة فارغة تبقى فارغة (= لا مهارات مفعّلة).
// مستويات جهد التفكير المقبولة (المرحلة 14.4) — القيمة تُمرَّر لخيار effort في SDK
// (الـ SDK يخفّضها صامتاً إن لم يدعمها النموذج المختار)
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// المجلدات الإضافية (المرحلة 14.4): مصفوفة مسارات — يُقبل الموجود كمجلد فقط، بسقف 10
function sanitizeExtraDirs(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const d of arr.slice(0, 10)) {
    if (typeof d !== 'string' || !d.trim()) continue;
    const t = d.trim();
    try { if (fs.statSync(t).isDirectory()) out.push(t); } catch { /* غير موجود — يُسقط */ }
  }
  return out;
}

function sanitizeSkills(s) {
  if (s === 'all') return 'all';
  if (Array.isArray(s)) return s.filter((x) => typeof x === 'string' && SAFE_SKILL.test(x)).slice(0, 200);
  return 'all';
}

// ---------- تنقية الصور الملصقة (محرك SDK فقط) ----------
const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 10 * 1024 * 1024; // طول base64 لكل صورة (~7.5م.ب فعلية)
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// تتحقق صارماً من كل صورة قادمة من الواجهة: نوع مسموح + base64 خالص + حجم معقول
function sanitizeImages(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const im of arr.slice(0, MAX_IMAGES)) {
    if (!im || typeof im.data !== 'string') continue;
    if (!ALLOWED_MEDIA.has(im.media_type)) continue;
    if (im.data.length > MAX_IMAGE_B64 || !BASE64_RE.test(im.data)) continue;
    out.push({ media_type: im.media_type, data: im.data });
  }
  return out;
}

// إيقاف أي تشغيل جارٍ أياً كان محركه (محوّل غير SDK أو تشغيل SDK)
function stopAll() {
  if (currentCliRun) {
    const h = currentCliRun;
    currentCliRun = null;
    h.stop().catch(() => {});
  }
  if (currentRun) {
    const run = currentRun;
    currentRun = null;
    run.stop().catch(() => {});
  }
}

function emitToWindow(obj) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:event', obj);
  // مجرى المراقبة (§4.7 — الدفعة 3): التدقيق/الاستهلاك في Enterprise يلتقطان الأحداث.
  // رخيص عند غياب المشتركين (بناء مجتمعي = لا شيء)
  try { features.notify(obj, { engine: lastEngine }); } catch (e) { /* عزل */ }
}

const opsRoomTransitions = new Set();

function publishOpsEntry(result) {
  if (!result || !result.ok || !result.entry) return result;
  emitToWindow({
    type: 'ops_room_update',
    schema_version: opsroom.SCHEMA_VERSION,
    room_id: result.room.room_id,
    entry: { ...result.entry },
  });
  return result;
}

function recordOpsSystem(roomId, type, text, teamId, artifactId, transitionKey) {
  if (!opsroom.SAFE_ROOM_ID.test(roomId || '') || !opsroom.SAFE_TEAM_ID.test(teamId || '')) {
    return { ok: false, error: 'bad_input' };
  }
  if (artifactId && !opsroom.SAFE_ARTIFACT_ID.test(artifactId)) return { ok: false, error: 'bad_input' };
  const key = roomId + ':' + transitionKey;
  if (opsRoomTransitions.has(key)) return { ok: true, duplicate: true };
  if (typeof text !== 'string' || text.length > opsroom.MAX_INPUT_TEXT || memory.hasSecret(text)) {
    return { ok: false, error: memory.hasSecret(text) ? 'secret_detected' : 'text_too_large' };
  }
  const result = opsroom.appendSystem(roomId, type, {
    text: cleanMemoryText(text, opsroom.MAX_INPUT_TEXT),
    team_id: teamId,
    ...(artifactId ? { artifact_id: artifactId } : {}),
  });
  if (result.ok) opsRoomTransitions.add(key);
  return publishOpsEntry(result);
}

const savedOpsArtifacts = new Set();
const opsRoomIndexSignatures = new Map();

function updateOpsRoomIndex(cwd, team, restorable) {
  if (!team || !opsroom.SAFE_ROOM_ID.test(team.room_id || '') || !opsroom.SAFE_TEAM_ID.test(team.id || '')) return;
  const signature = [team.state, team.artifact_id || '', team.merged === true, restorable === true].join(':');
  if (opsRoomIndexSignatures.get(team.room_id) === signature) return;
  const result = opsroomindex.upsert(cwd, {
    room_id: team.room_id, team_id: team.id, state: team.state, updated_at: team.updated_at,
    artifact_id: team.artifact_id || '', restorable: restorable === true, merged: team.merged === true,
  });
  if (result.ok) opsRoomIndexSignatures.set(team.room_id, signature);
}

function savedOpsArtifactKey(cwd, artifactId) {
  return opsroomindex.projectKey(cwd) + ':' + artifactId;
}

function emitOpsTeam(roomId, cwd, obj) {
  const team = obj && obj.type === 'execution_team_update' ? obj.team : null;
  const terminalLabels = {
    completed: 'اكتمل تنفيذ الفريق.',
    failed: 'فشل تنفيذ الفريق.',
    timed_out: 'انتهت مهلة تنفيذ الفريق.',
    stopped: 'أوقف المستخدم تنفيذ الفريق.',
    conflict: 'توقف تنفيذ الفريق بسبب تعارض ملكية.',
    cleanup_failed: 'فشل تنظيف نسخة عمل معزولة؛ عُدّ التنفيذ فاشلاً.',
  };
  const failureLabels = {
    timeout: 'انتهت المهلة', user_stopped: 'أوقفه المستخدم', start_failed: 'تعذّر بدء العامل',
    engine_failed: 'فشل المحرك', policy_violation: 'رُصد خرق لسياسة الأدوات',
    worktree_violation: 'رُصد مسار خارج نسخة العمل', ownership_violation: 'رُصد تعديل خارج الملكية',
    artifact_capture_failed: 'تعذّر التقاط الأثر', cleanup_failed: 'تعذّر تنظيف نسخة العمل',
  };
  if (team && terminalLabels[team.state]) {
    const failures = (team.agents || []).filter((item) => item && item.failure_code).map((item) => {
      const label = failureLabels[item.failure_code] || 'فشل غير مصنّف';
      return (item.label || 'عامل') + ': ' + label;
    });
    const details = failures.length ? ' الأسباب: ' + failures.join('؛ ') + '.' : '';
    recordOpsSystem(roomId, 'note', terminalLabels[team.state] + details, team.id,
      team.artifact_id || '', 'team-terminal:' + team.id + ':' + team.state);
  }
  const savedKey = team && team.artifact_id ? savedOpsArtifactKey(cwd, team.artifact_id) : '';
  let restorable = !!(savedKey && savedOpsArtifacts.has(savedKey));
  if (team && team.artifact_id) {
    if (!savedOpsArtifacts.has(savedKey)) {
      const artifact = executionTeam.artifact(team.id);
      const persisted = artifact ? opsartifacts.save(artifact, team) : { ok: false, error: 'not_available' };
      if (persisted.ok) {
        savedOpsArtifacts.add(savedKey);
        restorable = true;
      } else {
        recordOpsSystem(roomId, 'note', 'تعذّر حفظ الأثر مشفّراً؛ يبقى متاحاً حتى إغلاق «سطر» فقط.',
          team.id, team.artifact_id, 'artifact-persistence:' + team.artifact_id + ':failed');
      }
    }
    recordOpsSystem(roomId, 'note', 'أصبح أثر فريق التنفيذ جاهزاً للمراجعة.', team.id,
      team.artifact_id, 'artifact:' + team.artifact_id);
  }
  if (team) updateOpsRoomIndex(cwd, team, restorable && team.merged !== true);
  emitToWindow(obj);
}

function emitOpsReview(roomId, obj) {
  const review = obj && obj.type === 'execution_review_update' ? obj.review : null;
  if (review && opsroom.SAFE_ARTIFACT_ID.test(review.artifact_id || '')) {
    const verdict = review.verdict && ['approve', 'changes_required', 'reject'].includes(review.verdict.decision)
      ? ' والحكم ' + review.verdict.decision : '';
    recordOpsSystem(roomId, 'review', 'انتقلت المراجعة إلى الحالة ' + review.state + verdict + '.',
      review.team_id, review.artifact_id, 'review:' + review.id + ':' + review.state);
  }
  emitToWindow(obj);
}

function emitOpsVerification(roomId, teamId, obj) {
  const verification = obj && obj.type === 'execution_verification_update' ? obj.verification : null;
  if (verification && opsroom.SAFE_ARTIFACT_ID.test(verification.artifact_id || '')) {
    recordOpsSystem(roomId, 'verification', 'انتقل التحقق إلى الحالة ' + verification.state + '.',
      teamId, verification.artifact_id, 'verification:' + verification.artifact_id + ':' + verification.state);
  }
  emitToWindow(obj);
}

// آخر محرك أُرسل به طلب — وصفٌ لمجرى المراقبة (لا يغيّر سلوك النواة)
let lastEngine = 'sdk';

// تتبّع عمليات الخلفية: يُبثّ مباشرةً (لا عبر token الدور) لأنه يعيش بعد انتهاء الدور
bgprocs.setNotifier((procs) => emitToWindow({ type: 'bg_procs', procs }));

// رقم تسلسلي للتشغيل: أحداث متأخرة من تشغيل أُلغي (proc_done مثلاً)
// لا يجوز أن تصل للواجهة فتُنهي رسالة التشغيل الجديد قبل أوانها
let runSeq = 0;
const pendingVerificationPermissions = new Map(); // verify_<n> → resolve(allow)، إذن واحد لكل suite
let verificationPermissionSeq = 0;

function activeTaskRef(engine, sessionId) {
  const ledger = tasks.load(engine, sessionId);
  if (!ledger || !Array.isArray(ledger.tasks)) return null;
  const active = ledger.tasks.filter((task) => task.status === 'in_progress');
  return active.length === 1 ? { id: active[0].id, title: active[0].title } : null;
}

function publishVerification({ engine, sessionId, runId, checkpointId, taskTitle, result }) {
  const checkpoint = runId
    ? checkpoints.recordVerification(runId, result)
    : checkpoints.recordVerificationForCheckpoint(checkpointId, result);
  const linkedTitle = taskTitle || (checkpoint && checkpoint.task_title) || '';
  const evidence = result && Array.isArray(result.checks) ? result.checks.map((check) => ({
    kind: check.passed ? 'verification_pass' : 'verification_fail',
    text: (check.passed ? 'نجح ' : 'فشل ') + (check.label || check.id)
      + ' (exit ' + (check.exit_code == null ? 'غير معروف' : check.exit_code) + ')',
  })) : [];
  const ledger = linkedTitle && sessionId
    ? tasks.addEvidence(engine, sessionId, { task_title: linkedTitle }, evidence) : null;
  const event = {
    type: 'verification_result',
    schema_version: 1,
    engine,
    session_id: sessionId,
    checkpoint_id: checkpoint ? checkpoint.id : (checkpointId || null),
    task_title: linkedTitle,
    linked_task: !!ledger,
    ok: !!(result && result.ok),
    passed: !!(result && result.passed),
    summary: result && result.summary || '',
    checks: result && Array.isArray(result.checks) ? result.checks : [],
  };
  if (ledger) emitToWindow(ledger);
  emitToWindow(event);
  if (checkpoint) emitToWindow(checkpoint);
  return { event, checkpoint, ledger };
}

ipcMain.handle('satr:send', async (event, payload) => {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const images = sanitizeImages(payload.images);
  // يُسمح بطلب بلا نص إن رافقته صورة («صف هذه الصورة» مثلاً)
  if (!prompt && !images.length) return { error: 'empty_prompt' };

  let cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : os.homedir();
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { error: 'bad_cwd', message: 'مجلد المشروع غير موجود: ' + cwd };
  }

  stopAll(); // طلب جديد يلغي السابق

  const token = ++runSeq;
  const runEngine = (payload.engine === 'codex' || adapters.get(payload.engine)) ? payload.engine : 'sdk';
  let activeSessionId = payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null;
  const priorVerification = activeSessionId ? checkpoints.consumeVerification(runEngine, activeSessionId) : '';
  const enginePrompt = priorVerification
    ? '<satr_verification_result>\n' + priorVerification + '\n</satr_verification_result>\n\n' + prompt
    : prompt;
  const runId = 'run-' + token;
  checkpoints.begin({ runId, engine: runEngine, sessionId: activeSessionId, cwd });
  const emit = (obj) => {
    if (token !== runSeq || !obj || typeof obj !== 'object') return;
    if (obj.type === 'system' && SAFE_SESSION.test(obj.session_id || '')) {
      activeSessionId = obj.session_id;
      checkpoints.bindSession(runId, activeSessionId);
    }
    if (obj.type === 'task_update') {
      const eventSessionId = SAFE_SESSION.test(obj.session_id || '') ? obj.session_id : activeSessionId;
      if (!eventSessionId) return;
      const ledger = tasks.apply({ ...obj, engine: runEngine, session_id: eventSessionId });
      if (ledger) emitToWindow(ledger);
      return;
    }
    if (obj.type === 'memory_candidate') {
      const raw = obj.candidate && typeof obj.candidate === 'object' ? obj.candidate : {};
      const proposed = memory.propose({
        kind: raw.kind,
        content: raw.content,
        confidence: raw.confidence,
        scope: raw.scope,
        source: {
          type: 'agent',
          engine: runEngine,
          detail: raw.source && typeof raw.source.detail === 'string' ? raw.source.detail : '',
        },
        shareable: raw.shareable === true,
      }, { type: 'agent', engine: runEngine });
      if (proposed.ok) emitToWindow({ type: 'memory_candidate', schema_version: 1, candidate: proposed.candidate });
      else emitToWindow({ type: 'memory_rejected', reason: proposed.error === 'secret' ? 'secret' : 'invalid' });
      return;
    }
    if (obj.type === 'file_edit') {
      const checkpoint = checkpoints.addEdit(runId, obj, activeSessionId ? activeTaskRef(runEngine, activeSessionId) : null);
      emitToWindow(obj);
      if (checkpoint) emitToWindow(checkpoint);
      return;
    }
    if (obj.type === 'verification_result') {
      if (!activeSessionId || !obj.ok) { emitToWindow(obj); return; }
      publishVerification({
        engine: runEngine,
        sessionId: activeSessionId,
        runId,
        taskTitle: typeof obj.task_title === 'string' ? obj.task_title.trim().slice(0, 300) : '',
        result: obj,
      });
      return;
    }
    if (obj.type === 'result' || obj.type === 'proc_done') {
      const checkpoint = checkpoints.finish(runId);
      if (checkpoint) emitToWindow(checkpoint);
    }
    emitToWindow(obj);
  };

  // مجرى المراقبة (§4.7): حدث وصفي ببداية الدور — للتدقيق (من طلب ماذا وأين)
  lastEngine = runEngine;
  try {
    features.notify({ type: 'prompt', engine: lastEngine, cwd, prompt: prompt.slice(0, 2000) });
  } catch (e) { /* عزل */ }

  // محرك Codex الأصيل (المرحلة 1) — خاص مثل sdk (له resolvePermission+stop، فيسكن
  // currentRun لا currentCliRun). ليس محوّلاً في السجلّ، فنوجّهه صراحةً قبل طبقة adapters.
  if (payload.engine === 'codex') {
    try {
      currentRun = await codex.start({
        prompt: enginePrompt,
        images, // مُنقّاة بـ sanitizeImages (نفس محرك SDK) — نماذج Codex تقبل الصور
        sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
        model: payload.model && SAFE_MODEL.test(payload.model) ? payload.model : null,
        permissionMode: nonSdkPerm(payload.permissionMode), // auto→default (Codex لا يفهمه)
        skills: sanitizeSkills(payload.skills),
        // الموجة 2: جهد التفكير — نفس تنقية SDK (EFFORT_LEVELS)؛ codex.js يطبّع max→xhigh
        effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null,
      }, cwd, emit);
      return { started: true, engine: 'codex' };
    } catch (e) {
      currentRun = null;
      return { error: 'codex_failed', message: 'تعذّر تشغيل محرك Codex: ' + String((e && e.message) || e) };
    }
  }

  // المحرّكات غير SDK تمر عبر طبقة adapters (القاعدة 2: التنقية هنا في main.js)
  const adapter = adapters.get(payload.engine);
  if (adapter) {
    // 1.1 — حقن @الملفات (ROADMAP الدفعة 1): محوّلات REST لا ترى القرص، فنقرأ الملفات
    // المُشار إليها بـ @مسار ونحقنها في البرومبت. عائلة claude (cli) تُستثنى — كلود
    // يقرأ الملفات بنفسه. التنقية كلها في inject.js (داخل cwd حصراً + سقوف حجم).
    const meta = adapters.list().find((p) => p.name === payload.engine);
    const isBlind = !meta || meta.family !== 'claude';
    const inj = isBlind ? inject.injectFiles(enginePrompt, cwd) : { prompt: enginePrompt, attached: [], skipped: [] };

    // vision + effort للمحوّلات (الجولة المنسّقة): نمرّر الصور المُنقّاة للمزوّد المعلن
    // vision فقط (يستهلكها openai-compatible/responses، وإلا تُتجاهل)، وeffort لمحوّل Responses.
    // capabilities تأتي من meta في adapters.list() (يوسّعها مسار المحوّلات).
    const supportsVision = !!(meta && meta.capabilities && meta.capabilities.vision);
    const input = {
      prompt: inj.prompt,
      sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
      model: payload.model && SAFE_MODEL.test(payload.model) ? payload.model : null,
      permissionMode: nonSdkPerm(payload.permissionMode), // auto→default (المحوّلات لا تفهمه)
      skills: sanitizeSkills(payload.skills),
      extraDirs: sanitizeExtraDirs(payload.extraDirs), // متاحة للمحوّلات؛ cli/gemini الحاليان لا يستخدمانها
      images: supportsVision ? images : [], // base64 مُنقّاة (sanitizeImages) — للمعلن vision فقط
      effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null, // openai-responses: reasoning.effort
    };
    try {
      currentCliRun = adapter.start(input, cwd, emit);
      return {
        started: true, engine: payload.engine, imagesIgnored: images.length > 0 && !supportsVision,
        // معلومات الحقن للواجهة (تنبيهات شفافية): ما أُرفق وما تُخطّي ولماذا
        injectedFiles: inj.attached, skippedFiles: inj.skipped,
      };
    } catch (e) {
      currentCliRun = null;
      return { error: 'adapter_failed', message: 'تعذّر تشغيل المحرك: ' + String((e && e.message) || e) };
    }
  }

  // المسار الافتراضي: Agent SDK — نفس التحقق الصارم من المدخلات
  try {
    currentRun = await agent.start({
      prompt: enginePrompt,
      images,
      sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
      model: payload.model && SAFE_MODEL.test(payload.model) ? payload.model : null,
      permissionMode: PERMISSION_MODES.has(payload.permissionMode) ? payload.permissionMode : 'default',
      skills: sanitizeSkills(payload.skills),
      effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null,
      extraDirs: sanitizeExtraDirs(payload.extraDirs),
      browserControl: payload.browserControl === true, // وضع تحكّم المتصفح (محرك SDK فقط)
    }, cwd, emit);
    return { started: true, engine: 'sdk' };
  } catch (e) {
    currentRun = null;
    return { error: 'sdk_failed', message: 'تعذّر تشغيل محرك SDK: ' + String((e && e.message) || e) };
  }
});

ipcMain.handle('satr:stop', () => {
  stopAll();
  return { ok: true };
});

// ---------- الطرفية العربية المدمجة (المرحلة 8) ----------
// أحداث الطرفية عالية الإنتاجية تمرّ بقناة مستقلة satr:term (لا satr:event) —
// انظر «الطرفية العربية المدمجة» في CLAUDE.md وdocs/PHASE8-DESIGN.md.
const SAFE_TERM_ID = /^term_[0-9]{1,12}$/;
const MAX_TERM_INPUT = 1024 * 1024; // سقف كتابة واحدة إلى pty (نص ≤ 1م.ب)

term.setNotifier((obj) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:term', obj);
});

ipcMain.handle('satr:termStart', (event, p) => {
  const cwd = typeof (p && p.cwd) === 'string' ? p.cwd : '';
  const cols = Number.isInteger(p && p.cols) ? p.cols : 0;
  const rows = Number.isInteger(p && p.rows) ? p.rows : 0;
  return term.startTerm(cwd, cols, rows);
});

ipcMain.handle('satr:termInput', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_TERM_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  if (typeof p.data !== 'string' || !p.data.length || p.data.length > MAX_TERM_INPUT)
    return { ok: false, error: 'bad_data' };
  return term.writeTerm(p.id, p.data);
});

ipcMain.handle('satr:termResize', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_TERM_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  return term.resizeTerm(p.id, p.cols | 0, p.rows | 0);
});

ipcMain.handle('satr:termKill', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_TERM_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  return term.killTerm(p.id);
});

// ---------- لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب») ----------
// متصفح WebContentsView معزول (التفاصيل والعزل في electron/preview.js) — التنقية هنا
// (القاعدة 2): http/https حصراً بسقف طول، أفعال من قائمة، ومستطيل أعداد صحيحة محدودة.
// أحداثه للواجهة عبر قناة مستقلة satr:preview (nav/title/loading/failed).
// أفعال المعاينة عبر previewAction (سلسلة واحدة بلا وسائط): تنقّل + DevTools (البند أ) +
// مسح التخزين ومحاكاة الشبكة (البند د). كلها آمنة (تعمل على العرض المعزول فقط).
const PREVIEW_ACTIONS = new Set([
  'back', 'forward', 'reload', 'devtools', 'clear_storage',
  'net_online', 'net_offline', 'net_slow', 'net_fast',
]);
function previewSender(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:preview', ev);
}
ipcMain.handle('satr:previewOpen', (event, p) => {
  const url = p && p.url;
  if (!preview.isHttpUrl(url)) return { error: 'bad_url' };
  if (!mainWindow || mainWindow.isDestroyed()) return { error: 'no_window' };
  return preview.open(mainWindow, previewSender, url);
});
ipcMain.handle('satr:previewNavigate', (event, p) => {
  const url = p && p.url;
  if (!preview.isHttpUrl(url)) return { error: 'bad_url' };
  return preview.navigate(url);
});
ipcMain.handle('satr:previewAction', (event, p) => {
  const a = p && p.action;
  if (typeof a !== 'string' || !PREVIEW_ACTIONS.has(a)) return { error: 'bad_action' };
  return preview.action(a);
});
ipcMain.handle('satr:previewBounds', (event, p) => {
  const ok = p && ['x', 'y', 'width', 'height'].every(
    (k) => Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 20000);
  if (!ok) return { error: 'bad_bounds' };
  return preview.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height });
});
ipcMain.handle('satr:previewPick', () => preview.startPick());       // م-2: التحديد بالتأشير
ipcMain.handle('satr:previewPickCancel', () => preview.cancelPick());
ipcMain.handle('satr:previewFrame', () => preview.captureFrame());   // م-5: إطار للتسجيل
ipcMain.handle('satr:previewClose', () => preview.close());

// ---------- عمليات الخلفية المعمّرة (خوادم التطوير ونحوها) ----------
// مستقلة عن الدور: تُسرد وتُقتل حتى بعد انتهاء التشغيل واختفاء زرّ الإيقاف.
const SAFE_BG_ID = /^bg_[0-9]{1,12}$/;
ipcMain.handle('satr:listBgProcs', () => bgprocs.list());
ipcMain.handle('satr:killBgProc', (event, id) => {
  if (typeof id !== 'string' || !SAFE_BG_ID.test(id)) return { ok: false, error: 'bad_id' };
  return bgprocs.kill(id);
});

// رد الواجهة على طلب إذن أداة — يوجَّه للمقبض الجاري أياً كان محركه:
// محرك SDK (currentRun) أو محوّل بحلقة وكيل (currentCliRun منذ 2.2)
ipcMain.handle('satr:permission', (event, p) => {
  if (!p || typeof p.id !== 'string') return { ok: false };
  let ok = false;
  if (currentRun) ok = currentRun.resolvePermission(p.id, !!p.allow, !!p.always);
  if (!ok && currentCliRun && typeof currentCliRun.resolvePermission === 'function') {
    ok = currentCliRun.resolvePermission(p.id, !!p.allow, !!p.always);
  }
  if (!ok && pendingVerificationPermissions.has(p.id)) {
    const resolve = pendingVerificationPermissions.get(p.id);
    pendingVerificationPermissions.delete(p.id);
    resolve(!!p.allow);
    ok = true;
  }
  // مجرى المراقبة (§4.7): قرار الإذن — عنصر أساسي في سجل التدقيق (3.4)
  try {
    features.notify({ type: 'permission_reply', id: p.id, allow: !!p.allow, always: !!p.always, engine: lastEngine });
  } catch (e) { /* عزل */ }
  return { ok };
});

// رد أسئلة AskUserQuestion (SDK فقط) — selections مؤشرات صحيحة محدودة حصراً (لا نص حر):
// agent.js يبني updatedInput من input الأصلي المحفوظ، فالتنقية هنا طبقة أولى ثم فحص ثانٍ هناك.
ipcMain.handle('satr:answerQuestion', (event, p) => {
  // selections فارغة = إلغاء صريح (⇒ deny في agent.js). >4 أسئلة يخالف العقد ⇒ رفض الحمولة.
  if (!p || typeof p.id !== 'string' || !Array.isArray(p.selections) || p.selections.length > 4) return { ok: false };
  // تطبيع نوع فقط بلا إسقاط عناصر (لا filter صامت): أي مؤشر مخالف يصبح -1 فيرفضه agent.js
  // fail-closed كطبقة ثانية (رفض كامل، لا إجابة جزئية). العقد يسمح حتى 4 خيارات للسؤال.
  const selections = p.selections.map((s) => ({
    questionIndex: Number.isInteger(s && s.questionIndex) ? s.questionIndex : -1,
    optionIndexes: Array.isArray(s && s.optionIndexes) && s.optionIndexes.length <= 4
      ? s.optionIndexes.map((i) => (Number.isInteger(i) ? i : -1)) : [-1],
  }));
  let ok = false;
  if (currentRun && typeof currentRun.resolveQuestion === 'function') ok = currentRun.resolveQuestion(p.id, selections);
  return { ok };
});

// ---------- التراجع عن تعديل ملف (المرحلة 3) ----------
// المعرّف هو tool_use_id الذي أصدره المحرك؛ نتحقق من شكله قبل تمريره.
// المسار نفسه مخزَّن في لقطة agent.js (ليس مدخلاً من الواجهة) فلا حقن مسارات.
const SAFE_EDIT_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
function undoAnyEdit(id) {
  const r = agent.undoEdit(id);
  if (r && r.ok) return r;
  const r2 = agentTools.undoEdit(id);
  if (r2 && r2.ok) return r2;
  const r3 = codex.undoEdit(id);
  return (r3 && r3.ok) ? r3 : r;
}
ipcMain.handle('satr:undoEdit', (event, id) => {
  if (typeof id !== 'string' || !SAFE_EDIT_ID.test(id)) return { ok: false, error: 'bad_id' };
  // لقطات SDK أولاً ثم أدوات المحوّلات ثم Codex — نفس المسار تستعمله استعادة checkpoint.
  return undoAnyEdit(id);
});

// ---------- التحديث التلقائي (المرحلة 17) — رد الواجهة على «أعد التشغيل الآن» ----------
ipcMain.handle('satr:downloadUpdate', () => { updater.downloadUpdate(); return { ok: true }; });
ipcMain.handle('satr:restartUpdate', () => { updater.quitAndInstall(); return { ok: true }; });

// ---------- متصفح الجلسات (قراءة فقط — التحقق من المدخلات داخل sessions.js) ----------

ipcMain.handle('satr:listSessions', () => sessions.listSessions());
ipcMain.handle('satr:readSession', (event, p) => sessions.readSession(p && p.project, p && p.id));

// جلسات Codex (تلميع المرحلة 4 — قراءة فقط، التحقق من المعرّف داخل codexsessions.js)
ipcMain.handle('satr:listCodexSessions', () => codexSessions.listCodexSessions());
ipcMain.handle('satr:readCodexSession', (event, p) => codexSessions.readCodexSession(p && p.id));

// ---------- سرد ملفات المشروع لمنصّة @ (قراءة فقط) ----------

ipcMain.handle('satr:listFiles', (event, cwd) => {
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return files.listFiles(dir);
});

// ---------- ذاكرة المحوّلات (الدفعة 1.3): مؤشر آخر جلسة لكل مزوّد ----------
// المؤشر على القرص مع ملفات الذاكرة (chats.js) — لا localStorage (قد لا يُفلَش فيضيع).
// معرّف المحوّل الأعمى = اسم مجلد الذاكرة (deepseek/qwen/gemini…).

const SAFE_ENGINE = /^[a-z0-9_-]{1,32}$/;

// ---------- سجلّ المهام الدائم (الأولوية 2) ----------
// قراءة snapshot أو تغيير حالة ledger فقط. لا تحرير مهام خفيّ من الواجهة؛ الوكيل
// يحدّثها عبر task_update، والمستخدم يملك إيقافاً/استئنافاً صريحين ظاهرين.
const TASK_ACTIONS = new Set(['pause', 'resume']);

// ---------- ذاكرة المشروع الشخصية (الأولوية 4) ----------
// كل IPC يعيد بناء حمولة صغيرة من قائمة بيضاء هنا قبل وصولها إلى memory.js. المسار
// يجب أن يكون مجلد مشروع موجوداً، والنطاق المساري نسبي بلا ..؛ core يعيد فحص الأسرار.
const MEMORY_KINDS = new Set(['fact', 'decision', 'command', 'failure']);
const MEMORY_CONFIDENCE = new Set(['low', 'medium', 'high']);
const MEMORY_SCOPE = new Set(['project', 'path']);
const MEMORY_SOURCE = new Set(['agent', 'user', 'imported']);

function sanitizeMemoryCwd(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const resolved = path.resolve(value.trim());
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch { return null; }
}

function cleanMemoryText(value, max) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)
    : '';
}

function sanitizeMemoryScope(value) {
  const raw = value && typeof value === 'object' ? value : {};
  if (!MEMORY_SCOPE.has(raw.type)) return null;
  if (raw.type === 'project') return { type: 'project', path: '' };
  const relative = cleanMemoryText(raw.path, 512).replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative)) return null;
  const parts = relative.split('/');
  if (parts.includes('..') || parts.includes('')) return null;
  return { type: 'path', path: parts.join('/') };
}

function sanitizeMemoryForm(value, includeSource) {
  if (!value || typeof value !== 'object' || !MEMORY_KINDS.has(value.kind)
      || !MEMORY_CONFIDENCE.has(value.confidence)) return null;
  const content = cleanMemoryText(value.content, 2000);
  const scope = sanitizeMemoryScope(value.scope);
  if (!content || !scope) return null;
  const output = { kind: value.kind, content, confidence: value.confidence, scope, shareable: value.shareable === true };
  if (includeSource) {
    const raw = value.source && typeof value.source === 'object' ? value.source : {};
    output.source = {
      type: MEMORY_SOURCE.has(raw.type) ? raw.type : 'user',
      engine: SAFE_ENGINE.test(raw.engine || '') ? raw.engine : '',
      detail: cleanMemoryText(raw.detail, 240),
    };
  }
  return output;
}

ipcMain.handle('satr:memoryList', (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  if (!cwd || (p.query != null && typeof p.query !== 'string')) return { ok: false, error: 'bad_input' };
  const query = cleanMemoryText(p.query || '', 200);
  return memory.search(cwd, query);
});

ipcMain.handle('satr:memorySave', (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const candidate = sanitizeMemoryForm(p.candidate, true);
  if (!cwd || !candidate) return { ok: false, error: 'bad_input' };
  return memory.save(cwd, candidate);
});

ipcMain.handle('satr:memoryUpdate', (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const patch = sanitizeMemoryForm(p.patch, false);
  if (!cwd || !memory.SAFE_ID.test(p.id || '') || !patch) return { ok: false, error: 'bad_input' };
  return memory.update(cwd, p.id, patch);
});

ipcMain.handle('satr:memoryDelete', (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  if (!cwd || !memory.SAFE_ID.test(p.id || '')) return { ok: false, error: 'bad_input' };
  return memory.remove(cwd, p.id);
});

// ---------- منسّق باحثين للقراءة فقط (الأولوية 6 — الخطوة 1) ----------
// لا اختيار محرك من renderer في هذه الجولة: SDK فقط، permissionMode=plan يُفرض في النواة.
ipcMain.handle('satr:researchStart', (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const question = cleanMemoryText(p.question, 4000);
  if (!cwd || !question || !Number.isInteger(p.count) || p.count < 1 || p.count > 3) {
    return { ok: false, error: 'bad_input' };
  }
  const modelCheck = preflightOpsRoomModels(['sdk']);
  if (!modelCheck.ok) return modelCheck;
  return orchestrator.start({ question, count: p.count, engine: 'sdk' }, cwd, emitToWindow);
});

ipcMain.handle('satr:researchStop', (event, payload) => {
  const p = payload || {};
  if (!orchestratorModule.SAFE_RUN_ID.test(p.runId || '')) return { ok: false, error: 'bad_input' };
  return orchestrator.stop(p.runId);
});

ipcMain.handle('satr:researchLatest', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, run: orchestrator.latest(cwd) };
});

// ---------- عامل منفّذ واحد داخل worktree معزول (الأولوية 6 — الخطوة 2) ----------
ipcMain.handle('satr:executionStart', async (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const task = cleanMemoryText(p.task, 4000);
  if (!cwd || !task || p.confirmed !== true) return { ok: false, error: 'bad_input' };
  const modelCheck = preflightOpsRoomModels(['sdk']);
  if (!modelCheck.ok) return modelCheck;
  return executor.start({ task }, cwd, emitToWindow);
});

ipcMain.handle('satr:executionStop', async (event, payload) => {
  const p = payload || {};
  if (!executor.SAFE_RUN_ID.test(p.runId || '')) return { ok: false, error: 'bad_input' };
  return executor.stop(p.runId);
});

ipcMain.handle('satr:executionLatest', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, run: executor.latest(cwd) };
});

// ---------- عصف مستقل ومخطط قراءة فقط لغرفة العمليات ----------
function emitOpsBrainstorm(obj, references) {
  const run = obj && obj.type === 'ops_brainstorm_update' ? obj.run : null;
  if (run && ['completed', 'partial'].includes(run.state) && references) {
    for (const worker of run.workers || []) {
      if (!worker || worker.state !== 'completed' || !worker.summary) continue;
      const key = references.room_id + ':brainstorm:' + run.id + ':' + worker.engine;
      if (opsRoomTransitions.has(key)) continue;
      const recorded = opsroom.appendEngine(references.room_id, worker.engine, {
        type: 'proposal', text: worker.summary, team_id: references.team_id,
        ...(references.artifact_id ? { artifact_id: references.artifact_id } : {}),
      });
      if (recorded.ok) opsRoomTransitions.add(key);
      publishOpsEntry(recorded);
    }
  }
  emitToWindow(obj);
}

ipcMain.handle('satr:opsBrainstormStart', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const brief = cleanMemoryText(p.brief, opsBrainstormModule.MAX_BRIEF_CHARS);
  if (!cwd || !brief || memory.hasSecret(brief)) return { ok: false, error: 'bad_input' };
  const modelCheck = preflightOpsRoomModels(['sdk', 'codex']);
  if (!modelCheck.ok) return modelCheck;
  let references = null;
  if (p.teamId) {
    if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId)) return { ok: false, error: 'bad_input' };
    references = executionTeam.references(p.teamId);
    if (!references) return { ok: false, error: 'not_available' };
  }
  return opsBrainstorm.start({ brief }, cwd, (obj) => emitOpsBrainstorm(obj, references));
});

ipcMain.handle('satr:opsBrainstormStop', (event, payload) => {
  const runId = payload && payload.runId;
  if (!opsBrainstormModule.SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
  return opsBrainstorm.stop(runId);
});

ipcMain.handle('satr:opsBrainstormLatest', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, run: opsBrainstorm.latest(cwd) };
});

ipcMain.handle('satr:opsPlanStart', async (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const task = cleanMemoryText(p.task, opsPlannerModule.MAX_TASK_CHARS);
  if (!cwd || !task || memory.hasSecret(task)) return { ok: false, error: 'bad_input' };
  const modelCheck = preflightOpsRoomModels(['sdk']);
  if (!modelCheck.ok) return modelCheck;
  return opsPlanner.start({ task }, cwd, emitToWindow);
});

ipcMain.handle('satr:opsPlanStop', (event, payload) => {
  const runId = payload && payload.runId;
  if (!opsPlannerModule.SAFE_RUN_ID.test(runId || '')) return { ok: false, error: 'bad_input' };
  return opsPlanner.stop(runId);
});

ipcMain.handle('satr:opsPlanLatest', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, run: opsPlanner.latest(cwd) };
});

// ---------- فريق عوامل منفّذة بملكية ملفات معلنة (الأولوية 6 — الخطوة 3) ----------
const OPS_TIMEOUT_SECONDS = new Set([180, 300, 600]);

function sanitizeOwnership(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16) return null;
  const patterns = value.map((item) => cleanMemoryText(item, 256).replace(/\\/g, '/'));
  if (patterns.some((pattern) => {
    if (!pattern || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) return true;
    const parts = pattern.split('/');
    return parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || !/^[\p{L}\p{N}._@+()*? -]+$/u.test(part));
  })) return null;
  return [...new Set(patterns)];
}

ipcMain.handle('satr:executionTeamStart', async (event, payload) => {
  const p = payload || {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const mode = p.mode === 'draft' ? 'draft' : p.mode === 'mergeable' || p.mode == null ? 'mergeable' : '';
  const timeoutSeconds = p.timeoutSeconds == null ? 300 : p.timeoutSeconds;
  if (!cwd || p.confirmed !== true || !Array.isArray(p.agents) || p.agents.length < 1 || p.agents.length > 3) {
    return { ok: false, error: 'bad_input' };
  }
  if (!Number.isInteger(timeoutSeconds) || !OPS_TIMEOUT_SECONDS.has(timeoutSeconds)) {
    return { ok: false, error: 'bad_input' };
  }
  if (!mode || (mode === 'draft' && p.agents.length !== 1)) return { ok: false, error: 'bad_input' };
  const agents = [];
  for (const raw of p.agents) {
    const task = cleanMemoryText(raw && raw.task, 4000);
    const ownership = sanitizeOwnership(raw && raw.ownership);
    if (!task || !ownership) return { ok: false, error: 'bad_input' };
    agents.push({ task, ownership });
  }
  const modelCheck = preflightOpsRoomModels(mode === 'mergeable' ? ['sdk', 'codex'] : ['sdk']);
  if (!modelCheck.ok) return modelCheck;
  if (mode === 'mergeable') {
    const configured = await integration.preflight(cwd);
    if (!configured.ok) return configured;
    const unavailable = unavailableReviewEngines(['sdk']);
    if (unavailable.length) return { ok: false, error: 'review_engine_unavailable', engines: unavailable };
  }
  const created = opsroom.createRoom();
  if (!created.ok) return { ok: false, error: 'ops_room_unavailable' };
  const roomId = created.room.room_id;
  const result = await executionTeam.start({ agents, mode, roomId, timeoutMs: timeoutSeconds * 1000 }, cwd,
    (obj) => emitOpsTeam(roomId, cwd, obj));
  if (!result || !result.ok || !result.team) return result;
  for (let index = 0; index < agents.length; index++) {
    const taskText = 'مهمة العامل ' + (index + 1) + ': ' + agents[index].task;
    const recorded = recordOpsSystem(roomId, 'note', taskText, result.team.id, '', 'task:' + (index + 1));
    if (!recorded.ok) {
      recordOpsSystem(roomId, 'note', 'حُجب نص مهمة العامل ' + (index + 1) + ' وفق سياسة المحتوى الحساس.',
        result.team.id, '', 'task-redacted:' + (index + 1));
    }
  }
  return result;
});

ipcMain.handle('satr:executionTeamStop', async (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.runId || '')) return { ok: false, error: 'bad_input' };
  return executionTeam.stop(p.runId);
});

ipcMain.handle('satr:executionTeamExtend', async (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.runId || '')) return { ok: false, error: 'bad_input' };
  return executionTeam.extend(p.runId);
});

ipcMain.handle('satr:executionTeamLatest', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, team: executionTeam.latest(cwd) };
});

// ---------- مراجعة ثانية ودمج صريح لفرق الفريق (الأولوية 6 — الخطوة 4) ----------
ipcMain.handle('satr:executionReviewStart', (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '')) return { ok: false, error: 'bad_input' };
  const artifact = executionTeam.artifact(p.teamId);
  if (!artifact || !opsroom.SAFE_ROOM_ID.test(artifact.room_id || '')) return { ok: false, error: 'not_available' };
  const modelCheck = preflightOpsRoomModels(reviewerModule.requiredReviewEngines(artifact.producer_engines));
  if (!modelCheck.ok) return modelCheck;
  return reviewer.start({
    teamId: p.teamId,
    artifactId: artifact.artifact_id,
    patch: artifact.patch,
    files: artifact.files,
    producerEngines: artifact.producer_engines,
  }, (obj) => emitOpsReview(artifact.room_id, obj));
});

ipcMain.handle('satr:executionReviewStop', async (event, payload) => {
  const p = payload || {};
  if (!reviewerModule.SAFE_REVIEW_ID.test(p.reviewId || '')) return { ok: false, error: 'bad_input' };
  return reviewer.stop(p.reviewId);
});

ipcMain.handle('satr:executionReviewLatest', (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '')) return { ok: false, error: 'bad_input' };
  return { ok: true, review: reviewer.latest(p.teamId) };
});

ipcMain.handle('satr:executionVerificationPrepare', async (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '') || !reviewerModule.SAFE_REVIEW_ID.test(p.reviewId || '')) {
    return { ok: false, error: 'bad_input' };
  }
  const review = reviewer.latest(p.teamId);
  const artifact = executionTeam.artifact(p.teamId);
  const reviewed = reviewerModule.mergeGate(review, artifact, p.reviewId);
  if (!reviewed.ok) return reviewed;
  const prepared = await integration.prepare(artifact);
  if (prepared.verification) {
    executionTeam.setVerification(p.teamId, prepared.verification);
    emitOpsVerification(artifact.room_id, p.teamId, {
      type: 'execution_verification_update', verification: prepared.verification,
    });
  }
  return prepared;
});

ipcMain.handle('satr:executionVerificationRun', async (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '') || !reviewerModule.SAFE_REVIEW_ID.test(p.reviewId || '')
    || !integration.SAFE_ARTIFACT_ID.test(p.artifactId || '') || p.confirmed !== true) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  const review = reviewer.latest(p.teamId);
  const artifact = executionTeam.artifact(p.teamId);
  const reviewed = reviewerModule.mergeGate(review, artifact, p.reviewId);
  if (!reviewed.ok) return reviewed;
  if (!artifact || artifact.artifact_id !== p.artifactId) return { ok: false, error: 'verification_artifact_mismatch' };
  const result = await integration.run(artifact, true, (obj) => emitOpsVerification(artifact.room_id, p.teamId, obj));
  if (result.verification) executionTeam.setVerification(p.teamId, result.verification);
  return result;
});

ipcMain.handle('satr:executionVerificationStop', async (event, payload) => {
  const artifactId = payload && payload.artifactId;
  if (!integration.SAFE_ARTIFACT_ID.test(artifactId || '')) return { ok: false, error: 'bad_input' };
  return integration.stop(artifactId);
});

ipcMain.handle('satr:executionVerificationLatest', (event, payload) => {
  const teamId = payload && payload.teamId;
  if (!executionTeamModule.SAFE_RUN_ID.test(teamId || '')) return { ok: false, error: 'bad_input' };
  const artifact = executionTeam.artifact(teamId);
  return { ok: true, verification: artifact ? integration.latest(artifact.artifact_id) : null };
});

ipcMain.handle('satr:executionMerge', async (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '') || !reviewerModule.SAFE_REVIEW_ID.test(p.reviewId || '') || p.confirmed !== true) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  const review = reviewer.latest(p.teamId);
  const artifact = executionTeam.artifact(p.teamId);
  const gate = reviewerModule.mergeGate(review, artifact, p.reviewId);
  if (!gate.ok) return gate;
  const verification = artifact ? integration.latest(artifact.artifact_id) : null;
  const verified = integration.gate(artifact, verification);
  if (!verified.ok) return verified;
  const result = await merger.apply({ ...artifact, review_gate: gate, verification, confirmed: true });
  if (!result.ok) return result;
  const marked = executionTeam.markMerged(p.teamId);
  opsartifacts.remove(artifact.artifact_id, { projectRoot: artifact.sourceRoot });
  savedOpsArtifacts.delete(savedOpsArtifactKey(artifact.sourceRoot, artifact.artifact_id));
  if (marked && marked.team) updateOpsRoomIndex(artifact.sourceRoot, marked.team, false);
  recordOpsSystem(artifact.room_id, 'phase_gate', 'اكتمل انتقال الدمج للأثر المعتمد.',
    p.teamId, artifact.artifact_id, 'merge:completed');
  return { ...result, team: marked && marked.team ? marked.team : null };
});

// ---------- سجل غرفة العمليات الدائم (المرحلة 6) ----------
ipcMain.handle('satr:opsRoomLoad', (event, payload) => {
  const roomId = payload && payload.roomId;
  if (!opsroom.SAFE_ROOM_ID.test(roomId || '')) return { ok: false, error: 'bad_input' };
  const room = opsroom.load(roomId);
  return room ? { ok: true, room } : { ok: false, error: 'not_found' };
});

ipcMain.handle('satr:opsRoomHistory', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, rooms: opsroomindex.list(cwd) };
});

ipcMain.handle('satr:opsRoomRestore', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  if (!cwd || !opsroom.SAFE_ROOM_ID.test(p.roomId || '')
    || !opsroom.SAFE_ARTIFACT_ID.test(p.artifactId || '') || p.confirmed !== true) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  const indexed = opsroomindex.find(cwd, p.roomId);
  if (!indexed || indexed.artifact_id !== p.artifactId || !indexed.restorable || indexed.merged) {
    return { ok: false, error: 'not_available' };
  }
  const loaded = opsartifacts.load(p.artifactId, { projectRoot: cwd });
  if (!loaded.ok || loaded.artifact.room_id !== p.roomId
    || path.resolve(loaded.artifact.sourceRoot) !== path.resolve(cwd)) {
    return { ok: false, error: loaded.error || 'artifact_mismatch' };
  }
  savedOpsArtifacts.add(savedOpsArtifactKey(cwd, p.artifactId));
  const restored = executionTeam.restore(loaded, cwd, (obj) => emitOpsTeam(p.roomId, cwd, obj));
  if (restored.ok) {
    recordOpsSystem(p.roomId, 'note', 'استُعيد الأثر المشفّر بعد إعادة التشغيل؛ يلزم إعادة المراجعة والتحقق.',
      restored.team.id, p.artifactId, 'artifact-restored:' + p.artifactId);
  }
  return restored;
});

ipcMain.handle('satr:opsRoomArtifactDelete', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  if (!cwd || !opsroom.SAFE_ROOM_ID.test(p.roomId || '')
    || !opsroom.SAFE_ARTIFACT_ID.test(p.artifactId || '') || p.confirmed !== true) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  const indexed = opsroomindex.find(cwd, p.roomId);
  if (!indexed || indexed.artifact_id !== p.artifactId) return { ok: false, error: 'not_available' };
  const removed = opsartifacts.remove(p.artifactId, { projectRoot: cwd });
  if (!removed.ok) return removed;
  savedOpsArtifacts.delete(savedOpsArtifactKey(cwd, p.artifactId));
  opsroomindex.markArtifactsUnavailable([{
    artifact_id: p.artifactId,
    project_key: opsroomindex.projectKey(cwd),
  }]);
  return { ok: true };
});

ipcMain.handle('satr:opsRoomDecision', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!opsroom.SAFE_ROOM_ID.test(p.roomId || '') || !opsroom.SAFE_TEAM_ID.test(p.teamId || '')
    || p.artifactId && !opsroom.SAFE_ARTIFACT_ID.test(p.artifactId)
    || p.confirmed !== true || p.id != null || p.type != null || p.actor != null) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  if (typeof p.text !== 'string' || p.text.length > opsroom.MAX_INPUT_TEXT || memory.hasSecret(p.text)) {
    return { ok: false, error: memory.hasSecret(p.text) ? 'secret_detected' : 'text_too_large' };
  }
  const references = executionTeam.references(p.teamId);
  if (!references || references.room_id !== p.roomId
    || p.artifactId && references.artifact_id !== p.artifactId) {
    return { ok: false, error: 'reference_mismatch' };
  }
  const text = cleanMemoryText(p.text, opsroom.MAX_INPUT_TEXT);
  if (!text) return { ok: false, error: 'bad_input' };
  return publishOpsEntry(opsroom.appendUserDecision(p.roomId, {
    text,
    team_id: p.teamId,
    ...(p.artifactId ? { artifact_id: p.artifactId } : {}),
  }, true));
});

ipcMain.handle('satr:taskLedger', (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '')) return null;
  return tasks.load(p.engine, p.sessionId);
});

ipcMain.handle('satr:taskAction', (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '') || !TASK_ACTIONS.has(p.action)) return null;
  const ledger = tasks.action(p.engine, p.sessionId, p.action);
  if (ledger) emitToWindow(ledger);
  return ledger;
});

// ---------- تحقق المشروع وcheckpoints (الأولوية 3) ----------
const SAFE_CHECKPOINT_ID = /^cp-[A-Za-z0-9-]{3,80}$/;
const MAX_VERIFY_CWD = 4096;

ipcMain.handle('satr:verifyConfigCreate', (event, payload) => {
  const p = payload || {};
  if (p.confirmed !== true || typeof p.overwrite !== 'boolean'
      || typeof p.cwd !== 'string' || !p.cwd.trim() || p.cwd.length > MAX_VERIFY_CWD
      || p.cwd.includes('\0') || !path.isAbsolute(p.cwd.trim())
      || !Array.isArray(p.commands) || !p.commands.length || p.commands.length > verify.MAX_CHECKS) {
    return { ok: false, error: 'bad_input' };
  }
  const cwd = p.cwd.trim();
  try {
    const cwdStat = fs.lstatSync(cwd);
    if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()) throw new Error();
  } catch { return { ok: false, error: 'bad_cwd' }; }
  const commands = [];
  const seenIds = new Set();
  for (const value of p.commands) {
    const id = value && typeof value.id === 'string' ? value.id.trim() : '';
    const label = value && typeof value.label === 'string' ? value.label.trim() : '';
    const command = value && typeof value.command === 'string' ? value.command.trim() : '';
    if (!value || typeof value !== 'object'
        || typeof value.id !== 'string' || value.id.length > 64
        || typeof value.label !== 'string' || value.label.length > verify.MAX_LABEL
        || typeof value.command !== 'string' || value.command.length > verify.MAX_COMMAND
        || !verify.SAFE_CHECK_ID.test(id) || seenIds.has(id)
        || !label || /[\u0000-\u001F\u007F]/.test(label)
        || !command || /[\r\n\0]/.test(command)
        || !Number.isInteger(value.timeout_seconds)
        || value.timeout_seconds < 1 || value.timeout_seconds > verify.MAX_TIMEOUT_SECONDS) {
      return { ok: false, error: 'bad_input' };
    }
    seenIds.add(id);
    commands.push({
      id, label, command, timeout_seconds: value.timeout_seconds,
    });
  }
  if (Buffer.byteLength(JSON.stringify({ version: 1, commands }), 'utf8') > verify.MAX_CONFIG_BYTES) {
    return { ok: false, error: 'bad_input' };
  }
  return verify.createConfig(cwd, commands, { confirmed: true, overwrite: p.overwrite });
});

ipcMain.handle('satr:checkpointLatest', (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '')) return null;
  return checkpoints.latest(p.engine, p.sessionId);
});

ipcMain.handle('satr:checkpointRestore', async (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '')
      || !SAFE_CHECKPOINT_ID.test(p.checkpointId || '') || typeof p.cwd !== 'string' || !p.cwd.trim()) {
    return { ok: false, error: 'bad_input' };
  }
  try { if (!fs.statSync(p.cwd).isDirectory()) throw new Error(); }
  catch { return { ok: false, error: 'bad_cwd' }; }
  const result = await checkpoints.restore({
    engine: p.engine, sessionId: p.sessionId, checkpointId: p.checkpointId, cwd: p.cwd,
  }, async (editId) => undoAnyEdit(editId));
  if (result.checkpoint) emitToWindow(result.checkpoint);
  return result;
});

ipcMain.handle('satr:verifyCheckpoint', async (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '')
      || !SAFE_CHECKPOINT_ID.test(p.checkpointId || '') || typeof p.cwd !== 'string' || !p.cwd.trim()) {
    return { ok: false, error: 'bad_input' };
  }
  try { if (!fs.statSync(p.cwd).isDirectory()) throw new Error(); }
  catch { return { ok: false, error: 'bad_cwd' }; }
  const configured = verify.loadConfig(p.cwd);
  const selected = verify.selectChecks(configured, p.checks);
  if (!selected.ok) return { ok: false, error: selected.error };
  const latest = checkpoints.latest(p.engine, p.sessionId);
  if (!latest || latest.id !== p.checkpointId || !latest.restorable) return { ok: false, error: 'not_restorable' };
  const permissionId = 'verify_' + (++verificationPermissionSeq);
  const allowed = await new Promise((resolve) => {
    pendingVerificationPermissions.set(permissionId, resolve);
    emitToWindow({
      type: 'permission_request',
      id: permissionId,
      tool: 'verify_project',
      input: {
        checks: selected.checks.map((check) => ({ id: check.id, command: check.command })),
        task_title: latest.task_title || '',
      },
    });
  });
  if (!allowed) return { ok: false, error: 'denied' };
  // ننفّذ snapshot الأوامر نفسه الذي ظهر في مربع الإذن؛ لا نعيد قراءة الملف بعد الموافقة.
  const result = await verify.runChecks(p.cwd, selected.checks, { emit: emitToWindow });
  const published = publishVerification({
    engine: p.engine,
    sessionId: p.sessionId,
    checkpointId: p.checkpointId,
    taskTitle: latest.task_title || '',
    result,
  });
  return { ok: !!result.ok, passed: !!result.passed, checkpoint: published.checkpoint };
});

ipcMain.handle('satr:lastChat', (event, payload) => {
  const eng = payload && typeof payload.engine === 'string' ? payload.engine : '';
  if (!SAFE_ENGINE.test(eng)) return { sid: null };
  return { sid: chats.last(eng) };
});

ipcMain.handle('satr:forgetChat', (event, payload) => {
  const eng = payload && typeof payload.engine === 'string' ? payload.engine : '';
  if (SAFE_ENGINE.test(eng)) chats.forget(eng);
  return { ok: true };
});

// ---------- تصفح محادثات المحوّلات في لوحة الجلسات (الدفعة 4 — قراءة فقط) ----------
// التحقق من المعرّفات داخل chats.js (نفس regex الحفظ) — القراءة أفضل جهد

ipcMain.handle('satr:listChats', () => {
  try { return chats.list(); } catch { return []; }
});

ipcMain.handle('satr:readChat', (event, payload) => {
  const p = payload || {};
  try { return chats.read(p.provider, p.id); } catch { return { ok: false, error: 'error' }; }
});

// ---------- عارض القراءة (الدفعة 1.2): قراءة ملف نصّي للعرض فقط ----------
// التحقق الأمني في files.readText (المسار داخل cwd حصراً + رفض الثنائي + سقف حجم)

ipcMain.handle('satr:readFile', (event, payload) => {
  const p = payload || {};
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : '';
  const rel = typeof p.rel === 'string' ? p.rel.trim() : '';
  if (!cwd || !rel || rel.length > 512) return { ok: false, error: 'bad_input' };
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { ok: false, error: 'bad_cwd' };
  }
  return files.readText(cwd, rel);
});

// ---------- تحرير خفيف في العارض (الدفعة 4): حفظ محتوى ملف قائم ----------
// التنقية هنا (القاعدة 2)؛ التنفيذ بمسار tools.js المؤمَّن نفسه (resolveExisting
// المتسامح مع NFC/NFD + رفض الثنائي/الضخم + لقطة تراجع + بطاقة diff في الردّ).
// كتابة ملف قائم فقط — العارض لا ينشئ ملفات. content ≤ 1م.ب (سقف tools.js نفسه).

ipcMain.handle('satr:writeFile', (event, payload) => {
  const p = payload || {};
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : '';
  const rel = typeof p.rel === 'string' ? p.rel.trim() : '';
  const version = typeof p.version === 'string' ? p.version : '';
  if (!cwd || !rel || rel.length > 512 || typeof p.content !== 'string') return { ok: false, error: 'bad_input' };
  if (!/^[a-f0-9]{64}$/.test(version)) return { ok: false, error: 'bad_version' };
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { ok: false, error: 'bad_cwd' };
  }
  return agentTools.saveFromViewer(cwd, rel, p.content, version);
});

// ---------- بحث محتوى المشروع (الدفعة 4.6): قراءة فقط ----------
// المحرك في search.js فوق files.listFiles/readText المؤمَّنتين — لا مسار قراءة جديداً.
// نفس المحرك تستهلكه أداة search_code للمحوّلات العمياء (tools.js).

ipcMain.handle('satr:searchFiles', async (event, payload) => {
  const p = payload || {};
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : '';
  const query = typeof p.query === 'string' ? p.query.trim() : '';
  if (!cwd || !query || query.length > 256) return { ok: false, error: 'bad_input' };
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { ok: false, error: 'bad_cwd' };
  }
  try { return await searchMod.search(cwd, query); } catch { return { ok: false, error: 'error' }; }
});

// ---------- فروقات git — لوحة «تغييرات المشروع» (الدفعة 4.7): قراءة فقط ----------
// git يُشغَّل بمصفوفة وسائط بلا shell والمسارات من خرجه نفسه (التفاصيل في gitdiff.js).

ipcMain.handle('satr:gitChanges', async (event, payload) => {
  const p = payload || {};
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : '';
  if (!cwd) return { ok: false, error: 'bad_input' };
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { ok: false, error: 'bad_cwd' };
  }
  try { return await gitdiff.changes(cwd); } catch { return { ok: false, error: 'error' }; }
});

// ---------- أفعال git — لوحة «تغييرات المشروع» (دفعة «أفعال git») ----------
// stage/unstage/discard/commit. الأمان (القاعدة 2): op من قائمة بيضاء، والمسار
// يتحقّق منه gitactions مقابل مجموعة تغييرات git الحيّة (لا حقن مسار)، وgit بمصفوفة
// وسائط بلا shell. الأفعال المدمّرة (discard) تُؤكَّد في الواجهة قبل الوصول هنا.
const GIT_OPS = new Set(['stage', 'unstage', 'discard', 'commit']);
ipcMain.handle('satr:gitAction', async (event, payload) => {
  const p = payload || {};
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : '';
  const op = typeof p.op === 'string' ? p.op : '';
  if (!cwd || !GIT_OPS.has(op)) return { ok: false, error: 'bad_input' };
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { return { ok: false, error: 'bad_cwd' }; }
  try {
    if (op === 'commit') {
      const message = typeof p.message === 'string' ? p.message : '';
      return await gitactions.commit(cwd, message);
    }
    // stage/unstage/discard: تحتاج مساراً (يتحقق gitactions أنه من تغييرات git الحيّة)
    const rel = typeof p.rel === 'string' && p.rel.length && p.rel.length <= 4096 ? p.rel : '';
    if (!rel) return { ok: false, error: 'bad_input' };
    return await gitactions[op](cwd, rel);
  } catch { return { ok: false, error: 'error' }; }
});

// ---------- تصدير المحادثة الحالية Markdown (الدفعة 4.8 «مشاركة») — قراءة فقط ----------
// القرص مصدر الحقيقة (sessions.js/chats.js)؛ الحفظ في الواجهة (Blob + تنزيل) —
// لا مسار كتابة جديداً هنا. cwd للترويسة الوصفية فقط (لا عمليات ملفات عليه).

ipcMain.handle('satr:exportChat', async (event, payload) => { // SAFE_ENGINE معرّف أعلاه (1.3)
  const p = payload || {};
  const engine = typeof p.engine === 'string' ? p.engine : '';
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
  const cwd = typeof p.cwd === 'string' ? p.cwd.slice(0, 512) : '';
  if (!SAFE_ENGINE.test(engine) || !SAFE_SESSION.test(sessionId)) return { ok: false, error: 'bad_input' };
  try { return await exporter.toMarkdown({ engine, sessionId, cwd }); } catch { return { ok: false, error: 'error' }; }
});

// ---------- سرد المهارات المكتشَفة للوحة /مهارات (قراءة فقط) ----------

ipcMain.handle('satr:listSkills', (event, cwd) => {
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return skills.listSkills(dir);
});

// ---------- حالة موصّلات MCP للوحة /موصلات (عبر دوال تحكّم SDK) ----------
// عرض الحالة قراءة فقط؛ الإجراءات (reconnect/enable/disable) أفضل جهد ولا تقود OAuth.

ipcMain.handle('satr:mcpStatus', (event, cwd) => {
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return agent.mcpStatus(dir);
});

ipcMain.handle('satr:mcpAction', (event, p) => {
  if (!p || typeof p.name !== 'string' || !SAFE_MCP_NAME.test(p.name))
    return { ok: false, error: 'bad_name' };
  if (!MCP_ACTIONS.has(p.action)) return { ok: false, error: 'bad_action' };
  const dir = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : os.homedir();
  return agent.mcpAction(dir, p.name, p.action);
});

// ---------- استخدام نافذة السياق للوحة /سياق (عبر getContextUsage في SDK) ----------

// ---------- سرد الوكلاء الفرعيين للوحة /وكلاء (قراءة فقط — المرحلة 14.2) ----------

ipcMain.handle('satr:listAgents', (event, cwd) => {
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return agentsList.listAgents(dir);
});

// ---------- قائمة أوامر «/» من CLI لمزامنة قائمة الواجهة (قراءة فقط) ----------

ipcMain.handle('satr:listCommands', (event, cwd) => {
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return agent.listCommands(dir);
});

ipcMain.handle('satr:contextUsage', (event, p) => {
  const dir = typeof (p && p.cwd) === 'string' && p.cwd.trim() ? p.cwd.trim() : os.homedir();
  const sid = p && typeof p.sessionId === 'string' && SAFE_SESSION.test(p.sessionId) ? p.sessionId : null;
  return agent.contextUsage(dir, sid);
});

// ---------- دورة حياة التطبيق ----------

// تهيئة طبقة القدرات + المُحمِّل الشرطي لـ Enterprise (docs/ARCHITECTURE.md §4.1).
// النواة تعمل كاملة إن غاب enterprise/. لا يُسقط الإقلاع إن فشل.
try { features.init(); } catch (e) { /* عزل: فشل Enterprise لا يمنع إقلاع النواة */ }

// ترحيل مفاتيح المزوّدين إلى التخزين المشفّر (safeStorage) بعد جهوزية التطبيق —
// التشفير غير متاح قبلها. أفضل جهد: لا يمنع الإقلاع إن فشل.
app.whenReady().then(() => {
  try { keys.migrate(); } catch (e) { /* أفضل جهد */ }
  try { opsroomindex.interruptStale(); } catch (e) { /* أفضل جهد */ }
  try {
    const pruned = opsartifacts.prune();
    if (pruned.ok && pruned.removed.length) opsroomindex.markArtifactsUnavailable(pruned.removed);
  } catch (e) { /* أفضل جهد */ }
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  stopAll();
  orchestrator.stopAll();
  opsBrainstorm.stopAll();
  opsPlanner.stopAll();
  executor.stopAll();
  executionTeam.stopAll();
  reviewer.stopAll();
  integration.stopAll();
  // إنهاء عمليات الخلفية المتتبَّعة كي لا تبقى خوادم تطوير بلا واجهة تديرها بعد الإغلاق
  bgprocs.killAll();
  term.killAll(); // صدفة الطرفية المدمجة تموت مع «سطر» (المرحلة 8)
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { orchestrator.stopAll(); opsBrainstorm.stopAll(); opsPlanner.stopAll(); executor.stopAll(); executionTeam.stopAll(); reviewer.stopAll(); integration.stopAll(); bgprocs.killAll(); term.killAll(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
