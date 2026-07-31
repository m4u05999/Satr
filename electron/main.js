/**
 * سطر 2.0 — العملية الرئيسية (Main Process)
 * مسؤولة عن: إنشاء النافذة، تشغيل Claude CLI، جسر IPC مع الواجهة
 */

const { app, BrowserWindow, ipcMain: electronIpcMain, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');

const sessions = require('./sessions');
const sessionmeta = require('./sessionmeta');
const files = require('./files');
const searchMod = require('./search'); // بحث محتوى المشروع (الدفعة 4.6)
const gitdiff = require('./gitdiff'); // فروقات git للوحة التغييرات (الدفعة 4.7) — قراءة فقط
const gitactions = require('./gitactions'); // أفعال git للوحة التغييرات (stage/unstage/discard/commit)
const exporter = require('./exporter'); // تصدير المحادثة Markdown (الدفعة 4.8) — قراءة فقط
const skills = require('./skills');
const tasks = require('./tasks');
const verify = require('./verify');
const skillwriter = require('./skillwriter');
const checkpoints = require('./checkpoints');
const sdkrewinds = require('./sdkrewinds');
const memory = require('./memory');
const claudeElicitation = require('./elicitation');
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
const looprunnerModule = require('./looprunner'); // وضع الحلقة المحدودة — الجولة الخامسة
const reviewerModule = require('./reviewer'); // مراجع فرق قراءة فقط — الخطوة 4
const integration = require('./integration'); // تحقق تكاملي داخل worktree مستقل — المرحلة 5
const merger = require('./merger'); // تطبيق patch بعد المراجعة والتحقق والموافقة — المرحلة 5
const codex = require('./codex'); // محرك Codex الأصيل (المرحلة 1) — خاص مثل sdk
const codexSessions = require('./codexsessions'); // جلسات Codex للوحة /جلسات (قراءة فقط)
const kimi = require('./kimi'); // محرك Kimi Code الأصيل عبر ACP — اشتراك + جلسات حقيقية
const previewrecording = require('./previewrecording'); // تنزيل تسجيل المعاينة إلى Downloads + إشعار المسار
const promocapture = require('./promocapture'); // نافذة التقاط المنتج المرئية + تسجيل 30fps في renderer
const promostudio = require('./promostudio'); // storyboard محلي منقّى + حل أصول Downloads للاستوديو
const testsprite = require('./testsprite'); // تكامل TestSprite MCP — مفتاح مشفّر، لا يظهر كمحرّك
const claudeauth = require('./claudeauth');
const adapters = require('./adapters');
const renderertrust = require('./renderertrust');
// الشرطة المائلة مسموحة لقيم نماذج ACP المُنطَّقة مثل kimi-code/k3 (تُمرَّر كوسيطة مستقلة لا في صدفة).
// لاحقة [1m] (نافذة مليون رمز) مقبولة حصراً بقرار مالك 2026-07-27 — Claude Code صار
// يعلن Fable 5 وOpus 5 بهذه الصيغة فقط؛ لا أقواس أخرى.
const SAFE_MODEL = /^[A-Za-z0-9./-]{1,64}(\[1m\])?$/;
// إصلاح الموثوقية (2026-07-30): سقفان زمنيان يمنعان حبس قفل الإرسال sendRequestBusy
// إلى الأبد حين يعلق إيقاف دور سابق أو إقلاع محرك SDK (الشرح عند موضعي الاستخدام).
const STOP_ALL_SEND_TIMEOUT_MS = 15000;
const SDK_START_TIMEOUT_MS = 90000;

function cleanClaudePublicText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return Array.from(value
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
    .slice(0, maxLength)
    .join('');
}

function sanitizeClaudeModelsResult(result) {
  if (!result || result.ok !== true || !Array.isArray(result.models)) return { ok: false, models: [] };
  const seen = new Set();
  const models = [];
  for (const item of result.models) {
    const value = cleanClaudePublicText(item && item.value, 64);
    if (!SAFE_MODEL.test(value) || seen.has(value)) continue;
    const label = cleanClaudePublicText(item && item.displayName, 80) || value;
    const description = cleanClaudePublicText(item && item.description, 240);
    seen.add(value);
    models.push({ value, label, description });
    if (models.length >= 12) break;
  }
  return { ok: true, models };
}

function sanitizeClaudeAccountResult(result) {
  if (!result || result.ok !== true || !result.account || typeof result.account !== 'object') {
    return { ok: false };
  }
  const account = { ok: true };
  const limits = { email: 320, organization: 160, subscriptionType: 80 };
  for (const field of Object.keys(limits)) {
    const value = cleanClaudePublicText(result.account[field], limits[field]);
    if (value) account[field] = value;
  }
  return account;
}

function sanitizeClaudeFallbackModel(value, primaryModel) {
  if (typeof value !== 'string' || !SAFE_MODEL.test(value) || value === primaryModel) return null;
  return value;
}

async function handleClaudeModelsRequest(agentImpl = agent) {
  try {
    return sanitizeClaudeModelsResult(await agentImpl.claudeModels(os.homedir()));
  } catch {
    return { ok: false, models: [] };
  }
}

async function handleClaudeAccountRequest(agentImpl = agent) {
  try {
    return sanitizeClaudeAccountResult(await agentImpl.claudeAccount(os.homedir()));
  } catch {
    return { ok: false };
  }
}

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
    return { engine, model: resolved.model, start: (input, cwd, emit) => agent.start(input, cwd, emit, { mode: 'ops-room' }) };
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
  start: (input, cwd, emit) => agent.start(input, cwd, emit, { mode: 'ops-room' }),
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
const activity = require('./activity');
const keys = require('./keys');
const bgprocs = require('./bgprocs');
const term = require('./term');
const termjobs = require('./termjobs');
const devservers = require('./devservers');
const updater = require('./updater');
const preview = require('./preview'); // لوحة المعاينة المدمجة (م-1 — الدفعة 5)
const browserorigin = require('./browserorigin');
const browserpolicy = require('./browserpolicy');

// ثقة نطاقات المتصفح تعيش بعمر التطبيق فقط. localhost موثوق من browserorigin دائماً؛
// أما النطاق الخارجي فلا يدخل المجموعة إلا من شريط العنوان الذي حرّكه المستخدم بنفسه.
const trustedBrowserOrigins = new Set();
const browserBudgets = new Map();
function browserBudgetFor(engine, sessionId) {
  const sessionKey = sessionId ? engine + ':session:' + sessionId : '';
  if (sessionKey && browserBudgets.has(sessionKey)) return browserBudgets.get(sessionKey);
  const budget = browserpolicy.createActionBudget();
  if (sessionKey) browserBudgets.set(sessionKey, budget);
  while (browserBudgets.size > 50) browserBudgets.delete(browserBudgets.keys().next().value);
  return budget;
}

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
const UI_ENTRY = path.join(__dirname, '..', 'src', 'index.html');
const TRUSTED_RENDERER_URL = renderertrust.fileUrl(UI_ENTRY);

// هوية التطبيق على ويندوز: تضمن تجميع أيقونة شريط المهام تحت «سطر» بدل إلكترون
// (مطابقة لـ appId في البناء) — يجب ضبطها قبل إنشاء النافذة.
if (IS_WIN) { try { app.setAppUserModelId('ai.satr.app'); } catch (e) {} }

let mainWindow = null;
let currentCliRun = null; // مقبض محوّل غير SDK الجاري (cli الاحتياطي وما يليه) — له stop()
let currentRun = null;    // تشغيل Agent SDK الجاري (المسار الافتراضي) — له stop()+resolvePermission

// كل قنوات IPC مخصّصة لوثيقة «سطر» المحلية وإطارها الرئيسي فقط؛ أي مصدر آخر يفشل مغلقاً.
const ipcMain = {
  handle(channel, listener) {
    return electronIpcMain.handle(channel, (event, ...args) => {
      if (!renderertrust.isTrustedIpcEvent(event, mainWindow, TRUSTED_RENDERER_URL)) {
        return { ok: false, error: 'untrusted_sender' };
      }
      return listener(event, ...args);
    });
  },
};

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
      webviewTag: false,
    },
  });

  mainWindow.loadFile(UI_ENTRY);

  // تسجيل المعاينة يُنزّل Blob من renderer. نثبّت مساره داخل Downloads باسم منقّى، ثم
  // نبلغ الواجهة بالمسار الفعلي بعد اكتمال التنزيل؛ التنزيلات الأخرى لا يمسّها هذا الحارس.
  const ownerWebContents = mainWindow.webContents;
  const detachPreviewRecording = previewrecording.attach(ownerWebContents.session, ownerWebContents, {
    downloadsPath: app.getPath('downloads'), emit: emitToWindow,
    onResult: (result) => promocapture.downloadResult(result),
  });
  promocapture.configure({
    BrowserWindow,
    desktopCapturer,
    displaySession: ownerWebContents.session,
    ownerWebContents,
    downloadsPath: app.getPath('downloads'),
    isHttpUrl: preview.isHttpUrl,
    defaultUrl: () => preview.currentUrl(),
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:promo', event);
    },
    onTarget: (webContents) => {
      if (webContents) preview.attachExternalWebContents(webContents);
    },
  });
  promostudio.configure({
    downloadsPath: app.getPath('downloads'),
    exists: fs.existsSync,
    realpath: fs.realpathSync,
    aspectForPath: (candidate) => {
      const segment = promocapture.listSegments().segments.find((item) => item.path === candidate);
      return segment ? segment.aspect : '';
    },
    isAdditionalAllowed: (candidate) => promocapture.listSegments().segments.some((item) => item.path === candidate),
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:promo', event);
    },
  });
  preview.setExternalTargetProvider(() => promocapture.currentWebContents(), previewSender);

  // الروابط الخارجية تفتح في المتصفح وليس داخل التطبيق
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    renderertrust.allowNavigation(event, url, TRUSTED_RENDERER_URL);
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    detachPreviewRecording();
    mainWindow = null;
    preview.destroy(); // عرض المعاينة ابن النافذة — تدمير صريح احتياطاً
    promocapture.stopAll().catch(() => {});
    cancelPendingSendRequest();
    stopAll();
  });

  // التحديث التلقائي معطّل حتى يعلن بناء موقّع ذلك صراحةً؛ updater.js يحرس الشرطين.
  updater.initUpdater(app, emitToWindow, { edition: features.edition() });
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

// سجل Community المحلي: metadata محدودة للمشروع الحالي، بلا prompt/مدخلات/خرج أو مسارات مطلقة.
ipcMain.handle('satr:activityList', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  return cwd ? activity.list(cwd, 20) : { ok: false, error: 'bad_cwd', entries: [], count: 0 };
});
ipcMain.handle('satr:activityClear', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd || !payload || payload.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  return activity.clear(cwd);
});

// قائمة مزوّدي المحرّكات (طبقة المزوّد §4.2) — لبناء قائمة «المحرك» ديناميكياً في الواجهة
ipcMain.handle('satr:providers', () => ({
  providers: [kimi.publicInfo(), ...adapters.list()], integrations: [testsprite.publicInfo()],
}));

// حالة توفّر Codex (المرحلة 4): مثبَّت؟ ومسجَّل الدخول؟ — لإرشاد مضمّن حين يُختار المحرك
// codex وهو غير جاهز (لا يحجب الإطلاق — Claude يبقى بوابة الإطلاق الوحيدة). force=true
// يتجاوز تخزين resolveCodexBin ليلتقط تثبيتاً جرى بعد الإقلاع. لا يُعيد قيم الأسرار.
ipcMain.handle('satr:codexStatus', async () => {
  const bin = codex.resolveCodexBin(true);
  return { installed: !!bin, auth: bin ? await codex.accountStatus() : { ok: false, method: null } };
});

// بيانات Claude العامة فقط؛ دوال التنقية أعلاه تبني عقداً مسموحاً ولا تمرّر حقول SDK الأخرى.
ipcMain.handle('satr:claudeModels', () => handleClaudeModelsRequest());
ipcMain.handle('satr:claudeAccount', () => handleClaudeAccountRequest());

ipcMain.handle('satr:codexModels', async () => {
  const models = await codex.listModels();
  const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  return (Array.isArray(models) ? models : [])
    .filter((item) => item && item.hidden !== true && SAFE_MODEL.test(item.id || '')
      && (/^gpt-5\.6-/.test(item.id) || item.id === 'gpt-5.5'))
    .map((item) => ({
      id: item.id,
      name: String(item.displayName || item.id).slice(0, 60),
      description: String(item.description || '').slice(0, 240),
      defaultEffort: efforts.has(item.defaultReasoningEffort) ? item.defaultReasoningEffort : null,
      efforts: (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
        .map((option) => option && option.reasoningEffort).filter((value) => efforts.has(value)),
      vision: Array.isArray(item.inputModalities) && item.inputModalities.includes('image'),
      isDefault: item.isDefault === true,
    }))
    .slice(0, 12);
});

ipcMain.handle('satr:codexRateLimits', () => codex.rateLimits());

// ---------- C4: حساب Codex واستهلاكه ----------
// عقود عامة مغلقة: أرقام استهلاك وحدود فقط. لا يُقرأ ~/.codex/auth.json ولا يعبر أي
// token أو رمز إلى renderer — المصادقة كلها داخل Codex.
ipcMain.handle('satr:codexUsage', () => codex.accountUsage());
ipcMain.handle('satr:codexLimits', () => codex.accountRateLimits());

// تسجيل دخول Codex — نمط OAuth الآمن من C3 حرفياً: **الرابط لا يعبر IPC إطلاقاً**.
// البدء يعيد معرّفاً فقط؛ والفتح يقرأ الرابط من الطلب المعلّق داخل codex.js (منقّى
// بـsafeOauthUrl fail-closed) ويفتحه في متصفح النظام بعد تأكيد صريح من المستخدم.
const SAFE_CODEX_LOGIN_ID = /^cxlogin_[0-9]{1,9}_[a-z0-9]{1,8}$/;
const codexLoginOpening = new Set();

ipcMain.handle('satr:codexLoginStart', async () => {
  const started = await codex.accountLoginStart();
  if (!started || !started.ok) return { ok: false, error: (started && started.error) || 'failed' };
  return { ok: true, id: started.id }; // قائمة سماح صارمة — لا رابط ولا loginId داخلي
});

ipcMain.handle('satr:codexLoginOpen', async (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_CODEX_LOGIN_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  const url = codex.accountLoginUrl(p.id);
  if (!url) { codex.accountLoginCancel(p.id); return { ok: false, error: 'bad_url' }; }
  if (codexLoginOpening.has(p.id)) return { ok: false, error: 'in_flight' };
  codexLoginOpening.add(p.id);
  try {
    await shell.openExternal(url);
  } catch {
    codexLoginOpening.delete(p.id);
    return { ok: false, error: 'open_failed' }; // يبقى الطلب معلّقاً لإعادة المحاولة
  }
  try {
    const done = await codex.accountLoginAwait(p.id);
    return done && done.ok ? { ok: true, success: done.success === true } : { ok: false, error: (done && done.error) || 'failed' };
  } finally { codexLoginOpening.delete(p.id); }
});

ipcMain.handle('satr:codexLoginCancel', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_CODEX_LOGIN_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  return codex.accountLoginCancel(p.id);
});

// Kimi Code الأصيل يعتمد CLI واشتراك Kimi المحليين، لا مفتاح KIMI_API_KEY في خزنة سطر.
// لا نعيد مسار الثنائي أو محتوى credentials/config إلى renderer.
ipcMain.handle('satr:kimiStatus', () => {
  const bin = kimi.resolveKimiBin(true);
  return { installed: !!bin, auth: kimi.authStatus() };
});

// نماذج Kimi المعلنة رسمياً عبر ACP (جسّ قصير مخزَّن دقيقتين في kimi.js). تُنقَّى هنا
// أيضاً قبل عبورها إلى renderer: معرّف بصيغة SAFE_MODEL واسم معروض قصير وسقف 12 نموذجاً.
ipcMain.handle('satr:kimiModels', async () => {
  const models = await kimi.listModels();
  return (Array.isArray(models) ? models : [])
    .filter((item) => item && SAFE_MODEL.test(item.id || ''))
    .map((item) => ({ id: item.id, name: String(item.name || item.id).slice(0, 60) }))
    .slice(0, 12);
});

// مساعد تسجيل الدخول: يشغّل `kimi login` في طرفية النموذج المرئية دون أتمتة إدخال.
// لا يُمرَّر أي credential من الواجهة — المستخدم يُكمل الخطوات يدوياً في التبويب.
ipcMain.handle('satr:kimiLogin', async (event, cwd) => {
  const bin = kimi.resolveKimiBin(true);
  if (!bin) return { ok: false, error: 'not_installed' };
  const dir = kimi._internals.loginCwd(cwd);
  const started = termjobs.startJob(dir, kimi._internals.loginCommand(bin), 'تسجيل دخول Kimi Code');
  return started.ok ? { ok: true, id: started.id } : { ok: false, error: started.error };
});

// ---------- مركز مفاتيح المزوّدين (§4.3 — مخزن الأسرار) ----------
// 🔒 أمان: الأسماء المقبولة محصورة بمفاتيح المزوّدين المسجّلين فقط، والقيم لا تُعاد
// للواجهة أبداً (satr:keysList يعيد الأسماء المضبوطة فقط). التكاملات المسجّلة وحدها قد
// تمرّر السر عبر env إلى عملية ثابتة؛ لا يدخل السر argv أو أمر صدفة مبنياً من المستخدم.
const SAFE_KEY_NAME = /^[A-Z][A-Z0-9_]{1,64}$/;
function knownKeyNames() {
  return new Set([...adapters.list().map((p) => p.keyName).filter(Boolean), testsprite.KEY_NAME]);
}

ipcMain.handle('satr:keysList', () => ({ names: keys.names() }));

ipcMain.handle('satr:keySet', (event, p) => {
  const name = p && typeof p.name === 'string' ? p.name : '';
  const value = p && typeof p.value === 'string' ? p.value.trim() : '';
  if (!SAFE_KEY_NAME.test(name) || !knownKeyNames().has(name)) return { ok: false, error: 'bad_name' };
  if (!value || value.length > 8192) return { ok: false, error: 'bad_value' };
  if (name === testsprite.KEY_NAME && !testsprite.isValidApiKey(value)) return { ok: false, error: 'bad_value' };
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
  if (claude.ok) {
    const auth = await claudeauth.probe(claude.path || CLAUDE_BIN, { env: process.env });
    claude.authChecked = auth.checked;
    claude.loggedIn = auth.loggedIn;
    claude.authMethod = auth.authMethod;
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
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

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

// ---------- تنقية الصور الملصقة (المحرّكات الأصلية والمزوّد المعلن vision فقط) ----------
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

const SAFE_SDK_POLISH_TOOL = /^toolu_[A-Za-z0-9]{16,64}$/;
const SAFE_SDK_POLISH_TASK = /^[a-z0-9]{6,64}$/;
function sanitizeClaudePolishText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = Array.from(value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, maxLength).join('');
  return text && !memory.hasSecret(text) ? text : '';
}

function sanitizeClaudePolishEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'prompt_suggestion') {
    const suggestion = sanitizeClaudePolishText(event.suggestion, 500);
    return suggestion ? { type: 'prompt_suggestion', suggestion } : null;
  }
  if (event.type === 'sdk_agent_progress') {
    const taskId = String(event.taskId || '');
    const toolUseId = String(event.toolUseId || '');
    const summary = sanitizeClaudePolishText(event.summary, 300);
    if (!SAFE_SDK_POLISH_TASK.test(taskId) || !summary) return null;
    const safe = { type: 'sdk_agent_progress', taskId, summary };
    if (SAFE_SDK_POLISH_TOOL.test(toolUseId)) safe.toolUseId = toolUseId;
    return safe;
  }
  if (event.type === 'system' && event.subtype === 'compact_summary') {
    const compactSummary = sanitizeClaudePolishText(event.compact_summary, 1200);
    return compactSummary ? { type: 'system', subtype: 'compact_summary', compact_summary: compactSummary } : null;
  }
  return event;
}

// إيقاف أي تشغيل جارٍ أياً كان محركه (محوّل غير SDK أو تشغيل SDK)
function stopAll(includeSdkBackground = true) {
  preview.clearSensitiveState();
  promocapture.stopAll().catch(() => {});
  const stops = [];
  const existingSdkStop = sdkStoppingPromise;
  if (existingSdkStop) stops.push(existingSdkStop);
  if (!existingSdkStop && sdkStartingPromise) {
    const starting = sdkStartingPromise;
    const stopping = Promise.resolve(starting).then(async (run) => {
      if (!run) return;
      if (currentRun === run) currentRun = null;
      await stopSdkRun(run);
    }).catch(() => {});
    stops.push(trackSdkStop(stopping));
  }
  if (currentCliRun) {
    const h = currentCliRun;
    currentCliRun = null;
    stops.push(Promise.resolve().then(() => h.stop()).catch(() => {}));
  }
  if (currentRun) {
    const run = currentRun;
    currentRun = null;
    const isSdkRun = sdkRunInFlight;
    const stopping = isSdkRun
      ? stopSdkRun(run).catch(() => {})
      : Promise.resolve().then(() => run.stop()).catch(() => {});
    if (isSdkRun) {
      stops.push(trackSdkStop(stopping));
    } else stops.push(stopping);
  }
  if (includeSdkBackground && sdkBackgroundRuns.size) {
    const runs = Array.from(sdkBackgroundRuns);
    for (const run of runs) forgetSdkBackgroundRun(run);
    const stopping = Promise.allSettled(runs.map((run) => stopSdkRun(run)));
    stops.push(trackSdkStop(stopping));
  }
  return Promise.allSettled(stops);
}

function notifyObservers(obj, meta) {
  try { activity.onEvent(obj, meta); } catch (e) { /* السجل المحلي أفضل جهد */ }
  try { features.notify(obj, meta); } catch (e) { /* عزل Enterprise */ }
}

function emitToWindow(obj, engineOverride) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:event', obj);
  // Community يسجل metadata مختصرة، وEnterprise يلتقط التدقيق/الاستهلاك عبر مجراه.
  // URL طلب المصادقة يصل للحوار فقط ولا يدخل سجل المراقبة (قد يحمل state/query حساسة).
  const observed = obj && obj.type === 'elicitation_request'
    ? { type: obj.type, id: obj.id, server: obj.server, mode: obj.mode, fields: obj.fields }
    : obj;
  notifyObservers(observed, { engine: engineOverride || lastEngine });
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

function emitOpsPreview(roomId, teamId, obj) {
  const previewState = obj && obj.type === 'execution_preview_update' ? obj.preview : null;
  if (previewState && opsroom.SAFE_ARTIFACT_ID.test(previewState.artifact_id || '')) {
    recordOpsSystem(roomId, 'verification', 'انتقلت المعاينة التكاملية إلى الحالة ' + previewState.state + '.',
      teamId, previewState.artifact_id, 'preview:' + previewState.artifact_id + ':' + previewState.state);
  }
  emitToWindow({ ...(obj || {}), room_id: roomId, team_id: teamId });
}

// آخر محرك أُرسل به طلب — وصفٌ لمجرى المراقبة (لا يغيّر سلوك النواة)
let lastEngine = 'sdk';

// تتبّع عمليات الخلفية: يُبثّ مباشرةً (لا عبر token الدور) لأنه يعيش بعد انتهاء الدور
// K2: جلسات Kimi ACP الحية (keep-alive) تُدمج في الشريط نفسه، وأحداثها المتأخرة
// بين الأدوار تصل الواجهة كإشعارات kimi_keepalive_event (محجوبة الأسرار في المحرك).
function emitBgProcsMerged() {
  emitToWindow({ type: 'bg_procs', procs: bgprocs.list().concat(kimi.keepalive.list()) });
}
bgprocs.setNotifier(emitBgProcsMerged);
kimi.keepalive.setNotifier(emitBgProcsMerged);
kimi.keepalive.setLateEventSink((evt) => emitToWindow(evt));
termjobs.setNotifier((event) => emitToWindow(event));

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

let sdkSessionControlBusy = false;
let sendRequestBusy = false;
let sendRequestEpoch = 0;
let sdkRunInFlight = false;
let sdkStartingPromise = null;
let sdkStoppingPromise = null;
// الدفعة D: Queries انتهى دورها وبقيت لها مهام SDK؛ سجل مستقل لا يندمج مع bgprocs/termjobs.
const sdkBackgroundRuns = new Set();
const sdkTaskOwners = new Map();

function forgetSdkBackgroundRun(run) {
  sdkBackgroundRuns.delete(run);
  for (const [taskId, owner] of sdkTaskOwners) {
    if (owner === run) sdkTaskOwners.delete(taskId);
  }
}

const rewindPreviews = new Map();
const REWIND_PREVIEW_TTL_MS = 2 * 60 * 1000;
const MAX_REWIND_PREVIEWS = 100;
const MAX_REWIND_FINGERPRINT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REWIND_FINGERPRINT_TOTAL_BYTES = 64 * 1024 * 1024;
const SDK_STOP_GRACE_MS = 5000;
const SDK_FORCE_CLOSE_GRACE_MS = 1000;

function markSdkRunInFlight(value) {
  sdkRunInFlight = value === true;
}

function cancelPendingSendRequest() {
  sendRequestEpoch++;
}

async function settleSdkPromise(promise, timeoutMs) {
  let timeout = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function stopSdkRun(run) {
  if (!run || typeof run.stop !== 'function') return;
  const stopSettled = await settleSdkPromise(
    Promise.resolve().then(() => run.stop()),
    SDK_STOP_GRACE_MS,
  );
  if (!stopSettled && typeof run.forceClose === 'function') {
    try { run.forceClose(); } catch {}
  }
  if (!run.done || typeof run.done.then !== 'function') return;
  const doneSettled = await settleSdkPromise(
    run.done,
    stopSettled ? SDK_STOP_GRACE_MS : SDK_FORCE_CLOSE_GRACE_MS,
  );
  if (!doneSettled && typeof run.forceClose === 'function') {
    try { run.forceClose(); } catch {}
    await settleSdkPromise(run.done, SDK_FORCE_CLOSE_GRACE_MS);
  }
}

function trackSdkStop(stopping) {
  let tracked;
  tracked = Promise.resolve(stopping).finally(() => {
    markSdkRunInFlight(false);
    if (sdkStoppingPromise === tracked) sdkStoppingPromise = null;
  });
  sdkStoppingPromise = tracked;
  return tracked;
}

async function runSdkSessionControl(operation) {
  if (sendRequestBusy || sdkRunInFlight || sdkStartingPromise || sdkStoppingPromise || sdkBackgroundRuns.size) {
    return { ok: false, error: 'session_run_busy', message: 'انتظر انتهاء دور Claude أو مهمته الخلفية قبل التفريع أو استرجاع الملفات.' };
  }
  if (sdkSessionControlBusy) {
    return { ok: false, error: 'session_control_busy', message: 'توجد عملية تفريع أو استرجاع ملفات قيد التنفيذ؛ انتظر اكتمالها.' };
  }
  sdkSessionControlBusy = true;
  try {
    return await operation();
  } finally {
    sdkSessionControlBusy = false;
  }
}

function pruneRewindPreviews(now = Date.now()) {
  for (const [token, preview] of rewindPreviews) {
    if (!preview || now - preview.createdAt > REWIND_PREVIEW_TTL_MS) rewindPreviews.delete(token);
  }
  while (rewindPreviews.size > MAX_REWIND_PREVIEWS) {
    rewindPreviews.delete(rewindPreviews.keys().next().value);
  }
}

function rememberRewindPreview(cwd, sessionId, userMessageId, digest) {
  pruneRewindPreviews();
  const token = randomUUID();
  rewindPreviews.set(token, { cwd, sessionId, userMessageId, digest, createdAt: Date.now() });
  pruneRewindPreviews();
  return token;
}

function takeRewindPreview(token, cwd, sessionId, userMessageId) {
  pruneRewindPreviews();
  if (!SAFE_UUID.test(String(token || ''))) return null;
  const preview = rewindPreviews.get(token);
  rewindPreviews.delete(token);
  if (!preview || preview.cwd !== cwd || preview.sessionId !== sessionId || preview.userMessageId !== userMessageId) return null;
  return preview;
}

function validProjectDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  const resolved = path.resolve(value.trim());
  try {
    return fs.statSync(resolved).isDirectory() ? fs.realpathSync(resolved) : null;
  } catch {
    return null;
  }
}

function safeRewindFiles(cwd, entries) {
  if (!Array.isArray(entries)) {
    return {
      filesChanged: [], allFiles: [], fileCount: 0, outsideCount: 0,
      invalidCount: 1, symlinkCount: 0, tooMany: false,
    };
  }
  const seen = new Set();
  const output = [];
  const allFiles = [];
  let outsideCount = 0;
  let invalidCount = 0;
  let symlinkCount = 0;
  const tooMany = entries.length > 500;
  for (const entry of entries.slice(0, 500)) {
    if (typeof entry !== 'string'
      || !entry.trim()
      || entry.length > 4096
      || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(entry)) {
      invalidCount++;
      continue;
    }
    let absolute;
    try {
      absolute = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(cwd, entry);
      const relative = path.relative(cwd, absolute);
      if (!relative) {
        invalidCount++;
        continue;
      }
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        outsideCount++;
        continue;
      }
      let cursor = cwd;
      let blockedBySymlink = false;
      let invalidPath = false;
      for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        try {
          if (fs.lstatSync(cursor).isSymbolicLink()) {
            blockedBySymlink = true;
            break;
          }
        } catch (error) {
          if (error && error.code === 'ENOENT') break;
          invalidPath = true;
          break;
        }
      }
      if (blockedBySymlink) {
        symlinkCount++;
        continue;
      }
      if (invalidPath) {
        invalidCount++;
        continue;
      }
    } catch {
      invalidCount++;
      continue;
    }
    const display = path.relative(cwd, absolute).split(path.sep).join('/');
    const key = path.sep === '\\' ? display.toLowerCase() : display;
    if (!seen.has(key)) {
      seen.add(key);
      allFiles.push(display);
      if (output.length < 100) output.push(display);
    }
  }
  return {
    filesChanged: output,
    allFiles,
    fileCount: seen.size,
    outsideCount,
    invalidCount,
    symlinkCount,
    tooMany,
  };
}

function safeRewindCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000000000 ? value : 0;
}

function fingerprintRewindFiles(cwd, files) {
  const fingerprints = [];
  let totalBytes = 0;
  for (const relative of files) {
    const absolute = path.resolve(cwd, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        fingerprints.push([relative, 'missing']);
        continue;
      }
      return { ok: false, error: 'fingerprint_failed' };
    }
    if (stat.isSymbolicLink()) return { ok: false, error: 'symlink_path' };
    if (!stat.isFile()) return { ok: false, error: 'invalid_file_type' };
    if (stat.size > MAX_REWIND_FINGERPRINT_FILE_BYTES
      || totalBytes + stat.size > MAX_REWIND_FINGERPRINT_TOTAL_BYTES) {
      return { ok: false, error: 'fingerprint_limit' };
    }
    let content;
    try {
      content = fs.readFileSync(absolute);
    } catch {
      return { ok: false, error: 'fingerprint_failed' };
    }
    if (content.length > MAX_REWIND_FINGERPRINT_FILE_BYTES
      || totalBytes + content.length > MAX_REWIND_FINGERPRINT_TOTAL_BYTES) {
      return { ok: false, error: 'fingerprint_limit' };
    }
    totalBytes += content.length;
    fingerprints.push([
      relative,
      'file',
      content.length,
      Math.floor(stat.mtimeMs),
      createHash('sha256').update(content).digest('hex'),
    ]);
  }
  return { ok: true, fingerprints };
}

function normalizeRewindPreview(cwd, result) {
  if (!result || result.ok !== true) {
    return { ok: false, error: 'sdk_unavailable', message: 'تعذّر التأكد من اكتمال استرجاع ملفات Claude؛ راجع تغييرات الملفات.' };
  }
  const safeFiles = safeRewindFiles(cwd, result.filesChanged);
  const response = {
    ok: true,
    canRewind: result.canRewind === true,
    filesChanged: safeFiles.filesChanged,
    fileCount: safeFiles.fileCount,
    insertions: safeRewindCount(result.insertions),
    deletions: safeRewindCount(result.deletions),
  };
  if (safeFiles.invalidCount > 0) {
    return { ok: false, error: 'sdk_invalid_response', message: 'أعاد Claude قائمة ملفات غير صالحة؛ أُلغي الاسترجاع احترازياً.' };
  }
  if (safeFiles.tooMany) {
    return { ...response, canRewind: false, error: 'too_many_files', message: 'تشمل نقطة الاسترجاع أكثر من 500 ملف؛ أُلغي التنفيذ احترازياً.' };
  }
  if (safeFiles.symlinkCount > 0) {
    return { ...response, canRewind: false, error: 'symlink_path', message: 'تشمل نقطة الاسترجاع رابطاً رمزياً أو junction؛ أُلغي التنفيذ احترازياً.' };
  }
  if (safeFiles.outsideCount > 0) {
    return {
      ...response,
      canRewind: false,
      error: 'outside_cwd',
      outsideCount: safeFiles.outsideCount,
      message: 'تشمل نقطة الاسترجاع ملفات خارج مجلد المشروع؛ أُلغي التنفيذ احترازياً.',
    };
  }
  if (!response.canRewind) {
    response.message = 'لا تتوفر نقطة استرجاع لهذه الرسالة في جلسة Claude الحالية.';
    return response;
  }
  const fingerprint = fingerprintRewindFiles(cwd, safeFiles.allFiles);
  if (!fingerprint.ok) {
    const labels = {
      symlink_path: 'تشمل نقطة الاسترجاع رابطاً رمزياً أو junction؛ أُلغي التنفيذ احترازياً.',
      invalid_file_type: 'تشمل نقطة الاسترجاع مساراً ليس ملفاً عادياً؛ أُلغي التنفيذ احترازياً.',
      fingerprint_limit: 'تعذّر بصم ملفات المعاينة ضمن سقف الأمان (16 MiB للملف و64 MiB إجمالاً)؛ أُلغي التنفيذ.',
      fingerprint_failed: 'تعذّرت بصمة محتوى ملفات المعاينة؛ أُلغي التنفيذ احترازياً.',
    };
    return {
      ...response,
      canRewind: false,
      error: fingerprint.error,
      message: labels[fingerprint.error] || labels.fingerprint_failed,
    };
  }
  response._previewDigest = createHash('sha256').update(JSON.stringify({
    files: safeFiles.allFiles.slice().sort(),
    fingerprints: fingerprint.fingerprints.slice().sort((left, right) => (
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
    )),
    fileCount: response.fileCount,
    insertions: response.insertions,
    deletions: response.deletions,
    canRewind: response.canRewind,
  })).digest('hex');
  return response;
}

function publicRewindPreview(preview) {
  if (!preview || typeof preview !== 'object') return preview;
  const { _previewDigest, ...safe } = preview;
  return safe;
}

async function handleSessionForkRequest(payload, sessionAgent = agent) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'invalid_payload', message: 'بيانات طلب التفريع غير صالحة.' };
  }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  if (!SAFE_UUID.test(sessionId)) {
    return { ok: false, error: 'invalid_session', message: 'معرّف جلسة Claude غير صالح.' };
  }
  let upToMessageId;
  if (payload.upToMessageId !== undefined) {
    if (typeof payload.upToMessageId !== 'string' || !SAFE_UUID.test(payload.upToMessageId)) {
      return { ok: false, error: 'invalid_message', message: 'معرّف رسالة المستخدم غير صالح.' };
    }
    upToMessageId = payload.upToMessageId;
  }
  if (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.length > 512)) {
    return { ok: false, error: 'invalid_title', message: 'عنوان الفرع غير صالح.' };
  }
  const rawTitle = typeof payload.title === 'string'
    ? payload.title.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    : payload.title;
  const title = sessionmeta.cleanTitle(rawTitle);
  try {
    const result = await sessionAgent.forkSession(sessionId, upToMessageId, title || undefined);
    if (!result || result.ok !== true) {
      return { ok: false, error: 'sdk_unavailable', message: 'تعذّر تفريع جلسة Claude؛ بقيت الجلسة الحالية كما هي.' };
    }
    if (!SAFE_UUID.test(String(result.sessionId || ''))) {
      return { ok: false, error: 'sdk_invalid_response', message: 'أعاد Claude معرّف فرع غير صالح؛ بقيت الجلسة الحالية كما هي.' };
    }
    return { ok: true, sessionId: result.sessionId };
  } catch {
    return { ok: false, error: 'sdk_unavailable', message: 'تعذّر تفريع جلسة Claude؛ بقيت الجلسة الحالية كما هي.' };
  }
}

async function handleRewindFilesRequest(payload, sessionAgent = agent) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'invalid_payload', message: 'بيانات طلب الاسترجاع غير صالحة.' };
  }
  const cwd = validProjectDirectory(payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_cwd', message: 'مجلد المشروع غير صالح للاسترجاع.' };
  if (typeof payload.sessionId !== 'string' || !SAFE_UUID.test(payload.sessionId)) {
    return { ok: false, error: 'invalid_session', message: 'معرّف جلسة Claude غير صالح.' };
  }
  if (typeof payload.userMessageId !== 'string' || !SAFE_UUID.test(payload.userMessageId)) {
    return { ok: false, error: 'invalid_message', message: 'معرّف رسالة المستخدم غير صالح.' };
  }
  if (typeof payload.dryRun !== 'boolean') {
    return { ok: false, error: 'invalid_dry_run', message: 'وضع معاينة الاسترجاع غير صالح.' };
  }
  if (!payload.dryRun && payload.confirmed !== true) {
    return { ok: false, error: 'confirmation_required', message: 'يلزم تأكيد الاسترجاع بعد عرض إحصاءات المعاينة.' };
  }
  let acceptedPreview = null;
  if (!payload.dryRun) {
    acceptedPreview = takeRewindPreview(
      payload.previewToken,
      cwd,
      payload.sessionId,
      payload.userMessageId,
    );
    if (!acceptedPreview) {
      return { ok: false, error: 'preview_required', message: 'انتهت معاينة الاسترجاع أو لم تعد صالحة؛ أعد المعاينة والتأكيد.' };
    }
  }
  try {
    const previewResult = await sessionAgent.rewindFiles(
      cwd,
      payload.sessionId,
      payload.userMessageId,
      true,
    );
    const preview = normalizeRewindPreview(cwd, previewResult);
    if (payload.dryRun) {
      const response = publicRewindPreview(preview);
      if (preview.ok && preview.canRewind && preview._previewDigest) {
        response.previewToken = rememberRewindPreview(
          cwd, payload.sessionId, payload.userMessageId, preview._previewDigest,
        );
      }
      return response;
    }
    if (!preview.ok || !preview.canRewind) return publicRewindPreview(preview);
    if (!preview._previewDigest || preview._previewDigest !== acceptedPreview.digest) {
      return { ok: false, error: 'preview_changed', message: 'تغيّرت معاينة استرجاع ملفات Claude؛ راجع الإحصاءات الجديدة ثم أكّد مرة أخرى.' };
    }
    const finalPreview = normalizeRewindPreview(cwd, previewResult);
    if (!finalPreview.ok || !finalPreview.canRewind) return publicRewindPreview(finalPreview);
    if (finalPreview._previewDigest !== acceptedPreview.digest) {
      return { ok: false, error: 'preview_changed', message: 'تغيّرت معاينة استرجاع ملفات Claude؛ راجع الإحصاءات الجديدة ثم أكّد مرة أخرى.' };
    }
    const staleCheckpoint = checkpoints.latest('sdk', payload.sessionId);
    const staleCheckpointId = staleCheckpoint && sdkrewinds.SAFE_CHECKPOINT.test(String(staleCheckpoint.id || ''))
      ? staleCheckpoint.id : '';
    if (staleCheckpointId) {
      const marked = sdkrewinds.mark(payload.sessionId, staleCheckpointId);
      if (!marked || marked.ok !== true) {
        return { ok: false, error: 'marker_write_failed', message: 'تعذّر حفظ حاجز checkpoint بأمان؛ أُلغي الاسترجاع قبل تغيير الملفات.' };
      }
    }
    const result = await sessionAgent.rewindFiles(cwd, payload.sessionId, payload.userMessageId, false);
    if (!result || result.ok !== true || result.canRewind !== true) {
      return { ok: false, error: 'sdk_unavailable', message: 'تعذّر التأكد من اكتمال استرجاع ملفات Claude؛ راجع تغييرات الملفات.' };
    }
    return {
      ...publicRewindPreview(finalPreview),
      ...(staleCheckpointId ? { suppressedCheckpointId: staleCheckpointId } : {}),
    };
  } catch {
    return { ok: false, error: 'sdk_unavailable', message: 'تعذّر التأكد من اكتمال استرجاع ملفات Claude؛ راجع تغييرات الملفات.' };
  }
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

ipcMain.handle('satr:sessionFork', async (event, payload) => runSdkSessionControl(
  () => handleSessionForkRequest(payload),
));
ipcMain.handle('satr:rewindFiles', async (event, payload) => runSdkSessionControl(
  () => handleRewindFilesRequest(payload),
));

async function handleSendRequest(event, payload, requestEpoch) {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const images = sanitizeImages(payload.images);
  // يُسمح بطلب بلا نص إن رافقته صورة («صف هذه الصورة» مثلاً)
  if (!prompt && !images.length) return { error: 'empty_prompt' };
  if (sdkSessionControlBusy) {
    return { error: 'session_control_busy', message: 'انتظر اكتمال تفريع الجلسة أو استرجاع الملفات قبل إرسال طلب جديد.' };
  }

  let cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : os.homedir();
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { error: 'bad_cwd', message: 'مجلد المشروع غير موجود: ' + cwd };
  }

  // إصلاح الموثوقية (2026-07-30): سقف دفاعي — تعليق إيقاف الدور السابق (قناة محرك
  // ميتة) كان يحبس sendRequestBusy إلى الأبد فترتد كل الرسائل بـ«انتظر اكتمال بدء
  // الطلب السابق». مهما حدث لا ينتظر الإرسال الإيقاف أكثر من السقف؛ مقابض الدور
  // القديم سُحبت مزامنةً داخل stopAll وأحداثه محجوبة بـrunSeq، وcleanup المحرك يقتل
  // العملية اليتيمة بمهلته الخاصة (BOOT/INTERRUPT timeouts في codex.js).
  await Promise.race([
    stopAll(false), // ينهي الدور التفاعلي السابق ويحافظ على Queries ذات مهام SDK الخلفية
    new Promise((resolve) => { const t = setTimeout(resolve, STOP_ALL_SEND_TIMEOUT_MS); if (t.unref) t.unref(); }),
  ]);
  if (requestEpoch !== sendRequestEpoch) {
    return { error: 'stopped', message: 'أوقف المستخدم الطلب قبل بدء تشغيله.' };
  }
  if (sdkSessionControlBusy) {
    return { error: 'session_control_busy', message: 'انتظر اكتمال تفريع الجلسة أو استرجاع الملفات قبل إرسال طلب جديد.' };
  }

  const token = ++runSeq;
  const runEngine = (payload.engine === 'codex' || payload.engine === kimi.ENGINE_ID || adapters.get(payload.engine))
    ? payload.engine : 'sdk';
  let activeSessionId = payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null;
  const browserBudget = browserBudgetFor(runEngine, activeSessionId);
  const priorVerification = activeSessionId ? checkpoints.consumeVerification(runEngine, activeSessionId) : '';
  const enginePrompt = priorVerification
    ? '<satr_verification_result>\n' + priorVerification + '\n</satr_verification_result>\n\n' + prompt
    : prompt;
  const runId = 'run-' + token;
  checkpoints.begin({ runId, engine: runEngine, sessionId: activeSessionId, cwd });
  let sdkRunForEmit = null;
  const emit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (runEngine === 'sdk' && (obj.type === 'prompt_suggestion' || obj.type === 'sdk_agent_progress'
        || obj.type === 'system' && obj.subtype === 'compact_summary')) {
      obj = sanitizeClaudePolishEvent(obj);
      if (!obj) return;
    }
    const lateSdkBackgroundEvent = token !== runSeq && runEngine === 'sdk'
      && sdkRunForEmit && sdkBackgroundRuns.has(sdkRunForEmit)
      && (obj.type === 'sdk_task_notification' || obj.type === 'sdk_task_started'
        || (obj.type === 'task_update' && obj.source === 'claude_agent'));
    if (token !== runSeq && !lateSdkBackgroundEvent) return;
    if (obj.type === 'result' && runEngine === 'sdk' && sdkRunForEmit
        && typeof sdkRunForEmit.hasSdkBackgroundTasks === 'function'
        && sdkRunForEmit.hasSdkBackgroundTasks()) {
      sdkBackgroundRuns.add(sdkRunForEmit);
      if (currentRun === sdkRunForEmit) currentRun = null;
      markSdkRunInFlight(false);
    }
    if (obj.type === 'sdk_task_started' && sdkRunForEmit
        && typeof sdkRunForEmit.ownsSdkTask === 'function'
        && sdkRunForEmit.ownsSdkTask(String(obj.taskId || ''))) {
      sdkTaskOwners.set(String(obj.taskId), sdkRunForEmit);
    }
    if (obj.type === 'sdk_task_notification' && sdkRunForEmit) {
      const owner = sdkTaskOwners.get(String(obj.taskId || ''));
      if (owner === sdkRunForEmit) sdkTaskOwners.delete(String(obj.taskId));
    }
    if (obj.type === 'user' && obj.uuid !== undefined) {
      if (!SAFE_UUID.test(String(obj.uuid || '')) || !SAFE_UUID.test(String(obj.session_id || ''))) return;
      obj = { ...obj, uuid: String(obj.uuid), session_id: String(obj.session_id) };
    }
    if (obj.type === 'system' && SAFE_SESSION.test(obj.session_id || '')) {
      activeSessionId = obj.session_id;
      browserBudgets.set(runEngine + ':session:' + activeSessionId, browserBudget);
      checkpoints.bindSession(runId, activeSessionId);
    }
    if (obj.type === 'task_update') {
      const eventSessionId = SAFE_SESSION.test(obj.session_id || '') ? obj.session_id : activeSessionId;
      if (!eventSessionId) return;
      const ledger = tasks.apply({ ...obj, engine: runEngine, session_id: eventSessionId });
      if (ledger) emitToWindow(ledger, lateSdkBackgroundEvent ? runEngine : undefined);
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
      if (runEngine === 'sdk' && activeSessionId) sdkrewinds.clear(activeSessionId);
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
      promocapture.stopAll().catch(() => {});
    }
    emitToWindow(obj, lateSdkBackgroundEvent ? runEngine : undefined);
  };

  // مجرى المراقبة (§4.7): حدث وصفي ببداية الدور — للتدقيق (من طلب ماذا وأين)
  lastEngine = runEngine;
  try {
    notifyObservers({ type: 'prompt', engine: lastEngine, cwd, prompt: prompt.slice(0, 2000) }, { engine: lastEngine });
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
        // الموجة 2: جهد التفكير — نفس تنقية SDK؛ Codex يمرّر max/ultra حين يدعمهما النموذج.
        effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null,
        // ثلاثي الحالة: true = تفويض كل أدوات المتصفح، null = الأدوات متاحة وتطلب إذناً،
        // false محجوز للسياقات المعزولة (مراجع/عصف) كي لا تُنشأ أدوات المعاينة أصلاً.
        browserControl: payload.browserControl === true ? true : null,
        trustedBrowserOrigins,
        browserBudget,
      }, cwd, emit);
      return { started: true, engine: 'codex' };
    } catch (e) {
      currentRun = null;
      return { error: 'codex_failed', message: 'تعذّر تشغيل محرك Codex: ' + String((e && e.message) || e) };
    }
  }

  // Kimi Code الأصيل: ACP ثنائي الاتجاه، جلسات محفوظة لدى CLI، وأذونات حية مثل Codex.
  // يبقى مزوّد `kimi` في adapters هو مسار REST الاحتياطي بمفتاح منفصل.
  if (payload.engine === kimi.ENGINE_ID) {
    try {
      currentRun = await kimi.start({
        prompt: enginePrompt,
        images,
        sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
        model: payload.model && SAFE_MODEL.test(payload.model) ? payload.model : kimi.DEFAULT_MODEL,
        permissionMode: nonSdkPerm(payload.permissionMode),
        skills: sanitizeSkills(payload.skills),
        effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null,
        thinking: payload.thinking === 'on' ? 'on' : null,
        browserControl: payload.browserControl === true ? true : null,
        trustedBrowserOrigins,
        browserBudget,
      }, cwd, emit);
      return { started: true, engine: kimi.ENGINE_ID };
    } catch (e) {
      currentRun = null;
      return { error: 'kimi_failed', message: 'تعذّر تشغيل محرك Kimi Code: ' + String((e && e.message) || e) };
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
    // vision فقط (يستهلكها openai-compatible/responses، وإلا تُتجاهل)، وeffort للمحوّل
    // الذي يعلن عقده (Responses أو Kimi عبر effortMap).
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
    markSdkRunInFlight(true);
    const primaryModel = payload.model && SAFE_MODEL.test(payload.model) ? payload.model : null;
    const fallbackModel = sanitizeClaudeFallbackModel(payload.fallbackModel, primaryModel);
    const starting = agent.start({
      prompt: enginePrompt,
      images,
      sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
      model: primaryModel,
      fallbackModel,
      permissionMode: PERMISSION_MODES.has(payload.permissionMode) ? payload.permissionMode : 'default',
      skills: sanitizeSkills(payload.skills),
      effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null,
      extraDirs: sanitizeExtraDirs(payload.extraDirs),
      browserControl: payload.browserControl === true, // وضع تحكّم المتصفح للمحرّك الأصلي الداعم
      trustedBrowserOrigins,
      browserBudget,
    }, cwd, emit);
    sdkStartingPromise = starting;
    let sdkRun;
    try {
      // إصلاح الموثوقية (2026-07-30): تعليق agent.start قبل الحسم كان يحبس قفل
      // الإرسال إلى الأبد (تكافؤ مهلة إقلاع Codex). عند التجاوز نفشل الدور برسالة
      // عربية، وحين يُحسم البدء المتأخر لاحقاً يُوقف تشغيله اليتيم فوراً.
      sdkRun = await Promise.race([
        starting,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('sdk_boot_timeout')), SDK_START_TIMEOUT_MS);
          if (t.unref) t.unref();
        }),
      ]);
    } catch (raceErr) {
      if (raceErr && raceErr.message === 'sdk_boot_timeout') {
        Promise.resolve(starting).then((run) => { if (run) stopSdkRun(run).catch(() => {}); }).catch(() => {});
        markSdkRunInFlight(false);
        currentRun = null;
        return { error: 'sdk_failed', message: 'تأخر إقلاع محرك Claude ولم يبدأ الدور خلال المهلة — أعد المحاولة.' };
      }
      throw raceErr;
    } finally {
      if (sdkStartingPromise === starting) sdkStartingPromise = null;
    }
    currentRun = sdkRun;
    sdkRunForEmit = sdkRun;
    if (sdkRun && sdkRun.done && typeof sdkRun.done.finally === 'function') {
      sdkRun.done.finally(() => {
        forgetSdkBackgroundRun(sdkRun);
        if (currentRun === sdkRun) {
          currentRun = null;
          markSdkRunInFlight(false);
        }
      }).catch(() => {});
    }
    return { started: true, engine: 'sdk' };
  } catch (e) {
    markSdkRunInFlight(false);
    currentRun = null;
    return { error: 'sdk_failed', message: 'تعذّر تشغيل محرك SDK: ' + String((e && e.message) || e) };
  }
}

ipcMain.handle('satr:send', async (event, payload) => {
  if (sendRequestBusy) {
    return { error: 'send_busy', message: 'انتظر اكتمال بدء الطلب السابق قبل إرسال طلب جديد.' };
  }
  sendRequestBusy = true;
  const requestEpoch = sendRequestEpoch;
  try {
    return await handleSendRequest(event, payload, requestEpoch);
  } finally {
    sendRequestBusy = false;
  }
});

ipcMain.handle('satr:stop', async () => {
  cancelPendingSendRequest();
  await stopAll(false);
  return { ok: true };
});

// ---------- مهام Claude SDK الخلفية (الدفعة D) ----------
// منفصلة صراحةً عن termjobs/bgprocs/Kimi keep-alive؛ لا سجل PID/PTTY ولا شريط مشترك.
const SAFE_SDK_TOOL_USE_ID = /^toolu_[A-Za-z0-9]{16,64}$/;
const SAFE_SDK_TASK_ID = /^[a-z0-9]{6,64}$/;
const SDK_CONTROL_ERRORS = new Set(['bad_id', 'unsupported', 'no_active_turn', 'not_found']);

function sanitizeSdkControlPayload(payload, field, pattern) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== field) return '';
  const value = payload[field];
  return typeof value === 'string' && pattern.test(value) ? value : '';
}

function publicSdkControlResult(result, includeTaskId) {
  if (result && result.ok === true) {
    const response = { ok: true };
    if (includeTaskId && SAFE_SDK_TASK_ID.test(String(result.taskId || ''))) response.taskId = result.taskId;
    return response;
  }
  const error = result && SDK_CONTROL_ERRORS.has(result.error) ? result.error : 'unsupported';
  const response = { ok: false, error };
  const message = cleanClaudePublicText(result && result.message, 240);
  if (message && !memory.hasSecret(message)) response.message = message;
  return response;
}

async function handleSdkBackgroundTaskRequest(payload) {
  const toolUseId = sanitizeSdkControlPayload(payload, 'toolUseId', SAFE_SDK_TOOL_USE_ID);
  if (!toolUseId) return { ok: false, error: 'bad_input' };
  if (lastEngine !== 'sdk') return { ok: false, error: 'unsupported' };
  const run = currentRun;
  if (!run || typeof run.moveToBackground !== 'function') return { ok: false, error: 'no_active_turn' };
  try {
    const result = publicSdkControlResult(await run.moveToBackground(toolUseId), true);
    if (result.ok && result.taskId && typeof run.ownsSdkTask === 'function' && run.ownsSdkTask(result.taskId)) {
      sdkTaskOwners.set(result.taskId, run);
    }
    return result;
  } catch {
    return { ok: false, error: 'unsupported', message: 'تعذّر نقل الأداة إلى الخلفية.' };
  }
}

async function handleStopSdkTaskRequest(payload) {
  const taskId = sanitizeSdkControlPayload(payload, 'taskId', SAFE_SDK_TASK_ID);
  if (!taskId) return { ok: false, error: 'bad_input' };
  let run = sdkTaskOwners.get(taskId) || null;
  if (!run) {
    if (lastEngine !== 'sdk') return { ok: false, error: 'unsupported' };
    run = currentRun;
  }
  if (!run || typeof run.stopSdkTask !== 'function') return { ok: false, error: 'no_active_turn' };
  try {
    return publicSdkControlResult(await run.stopSdkTask(taskId), false);
  } catch {
    return { ok: false, error: 'unsupported', message: 'تعذّر إيقاف مهمة Claude الخلفية.' };
  }
}

ipcMain.handle('satr:backgroundTask', (event, payload) => handleSdkBackgroundTaskRequest(payload));
ipcMain.handle('satr:stopSdkTask', (event, payload) => handleStopSdkTaskRequest(payload));

// ---------- الطرفية العربية المدمجة (المرحلة 8) ----------
// أحداث الطرفية عالية الإنتاجية تمرّ بقناة مستقلة satr:term (لا satr:event) —
// انظر «الطرفية العربية المدمجة» في CLAUDE.md وdocs/PHASE8-DESIGN.md.
const SAFE_TERM_ID = /^term_[0-9]{1,12}$/;
const MAX_TERM_INPUT = 1024 * 1024; // سقف كتابة واحدة إلى pty (نص ≤ 1م.ب)

term.setNotifier((obj) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:term', obj);
});

ipcMain.handle('satr:termStart', (event, p) => {
  const cwd = sanitizeMemoryCwd(p && p.cwd);
  // السبب الأشيع لفشل البدء أن المستخدم لم يختر مجلد المشروع بعد؛ الرمز وحده كان
  // يظهر له «تعذّر بدء الطرفية» بلا سبب. بقية أخطاء startTerm تحمل رسائلها أصلاً.
  if (!cwd) {
    return { ok: false, error: 'bad_cwd', message: 'اختر مجلد المشروع أولاً من الشريط العلوي 📁 ثم أعد المحاولة.' };
  }
  const cols = Number.isInteger(p && p.cols) ? p.cols : 0;
  const rows = Number.isInteger(p && p.rows) ? p.rows : 0;
  return term.startTerm(cwd, cols, rows);
});

ipcMain.handle('satr:termList', () => term.listTerms());
ipcMain.handle('satr:termReadBuffer', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_TERM_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  const tailBytes = Number.isInteger(p.tailBytes) && p.tailBytes > 0
    ? Math.min(p.tailBytes, term.MAX_BUFFER_BYTES) : term.MAX_BUFFER_BYTES;
  return term.readBuffer(p.id, tailBytes);
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
const SAFE_PREVIEW_SELECTOR = /^[^\x00-\x1F\x7F]{1,1000}$/;
function previewSender(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('satr:preview', ev);
}
ipcMain.handle('satr:previewOpen', (event, p) => {
  const url = p && p.url;
  if (!preview.isHttpUrl(url)) return { error: 'bad_url' };
  if (!mainWindow || mainWindow.isDestroyed()) return { error: 'no_window' };
  browserorigin.trust(url, trustedBrowserOrigins);
  return preview.open(mainWindow, previewSender, url);
});
ipcMain.handle('satr:previewNavigate', (event, p) => {
  const url = p && p.url;
  if (!preview.isHttpUrl(url)) return { error: 'bad_url' };
  browserorigin.trust(url, trustedBrowserOrigins);
  return preview.navigate(url);
});
// فتح الوكيل منفصل صراحةً عن فعل المستخدم: يعرض العنوان ولا يمنحه ثقة ضمنية.
ipcMain.handle('satr:previewOpenAgent', (event, p) => {
  const url = p && p.url;
  if (!preview.isHttpUrl(url)) return { error: 'bad_url' };
  if (!mainWindow || mainWindow.isDestroyed()) return { error: 'no_window' };
  return preview.open(mainWindow, previewSender, url);
});
ipcMain.handle('satr:previewNavigateAgent', (event, p) => {
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
ipcMain.handle('satr:previewElementShot', async (event, p) => {
  const selector = p && p.selector;
  if (typeof selector !== 'string' || !SAFE_PREVIEW_SELECTOR.test(selector)) return { error: 'bad_selector' };
  return preview.screenshotElement(selector, { emitThumbnail: false });
});
ipcMain.handle('satr:previewClose', () => preview.close());

// ---------- التقاط البرومو الأصلي (30fps) ----------
// لا أمر أو source id يأتي من renderer: الوحدة تنشئ نافذة المنتج وتشتق مصدر
// desktopCapturer بنفسها. الواجهة ترسل aspect من قائمة بيضاء وURL ‏http/https فقط.
ipcMain.handle('satr:promoCaptureStart', async (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const aspect = promocapture.sanitizeAspect(p.aspect);
  const url = p.url == null || p.url === '' ? '' : String(p.url);
  if (!aspect || p.confirmed !== true || url && !preview.isHttpUrl(url)
      || Object.prototype.hasOwnProperty.call(p, 'sourceId')) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  return promocapture.start({ aspect, url });
});

ipcMain.handle('satr:promoCaptureStop', () => promocapture.stop());

ipcMain.handle('satr:promoCaptureReady', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!promocapture.SAFE_PROMO_SESSION.test(p.sessionId || '') || typeof p.ok !== 'boolean'
      || p.error != null && typeof p.error !== 'string') return { ok: false, error: 'bad_input' };
  return promocapture.rendererReady(p.sessionId, p.ok, p.error || '');
});

ipcMain.handle('satr:promoCaptureCommit', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!promocapture.SAFE_PROMO_SESSION.test(p.sessionId || '')
      || !Number.isInteger(p.durationMs) || !promocapture.SAFE_SEGMENT_NAME.test(p.filename || '')) {
    return { ok: false, error: 'bad_input' };
  }
  return promocapture.rendererCommit(p.sessionId, p.durationMs, p.filename);
});

ipcMain.handle('satr:promoCaptureAbort', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!promocapture.SAFE_PROMO_SESSION.test(p.sessionId || '')
      || typeof p.error !== 'string' || !/^[a-z0-9_:-]{1,80}$/i.test(p.error)) {
    return { ok: false, error: 'bad_input' };
  }
  return promocapture.rendererAbort(p.sessionId, p.error);
});

ipcMain.handle('satr:promoStudioState', () => ({
  ...promostudio.state(), segments: promocapture.listSegments().segments,
}));

ipcMain.handle('satr:promoAssetUrl', (event, payload) => {
  const candidate = payload && typeof payload.path === 'string' ? payload.path : '';
  if (!candidate || candidate.length > 4096 || !path.isAbsolute(candidate)) return { ok: false, error: 'bad_path' };
  return promostudio.assetUrl(candidate);
});

ipcMain.handle('satr:devServerInfo', (event, p) => {
  const cwd = sanitizeMemoryCwd(p && p.cwd);
  if (!cwd) return { ok: false, error: 'bad_cwd' };
  const record = devservers.info(cwd);
  const running = termjobs.list().some((job) => path.resolve(job.cwd) === cwd);
  return { ok: true, record, running };
});
ipcMain.handle('satr:devServerRestart', (event, p) => {
  const cwd = sanitizeMemoryCwd(p && p.cwd);
  if (!cwd) return { ok: false, error: 'bad_cwd' };
  const record = devservers.info(cwd);
  if (!record || typeof record.command !== 'string') return { ok: false, error: 'no_record' };
  if (termjobs.list().some((job) => path.resolve(job.cwd) === cwd)) return { ok: false, error: 'already_running' };
  const started = termjobs.startJob(cwd, record.command, record.label);
  return started.ok ? {
    ok: true, id: started.id, label: started.label, shell: started.shell,
    cwd: started.cwd, last_url: record.last_url || null,
  } : started;
});

// ---------- عمليات الخلفية المعمّرة (خوادم التطوير ونحوها) ----------
// مستقلة عن الدور: تُسرد وتُقتل حتى بعد انتهاء التشغيل واختفاء زرّ الإيقاف.
const SAFE_BG_ID = /^bg_[0-9]{1,12}$/;
const SAFE_KS_ID = /^ks_[A-Za-z0-9_-]{1,128}$/; // جلسة Kimi حية في سجل keep-alive (K2)
ipcMain.handle('satr:listBgProcs', () => bgprocs.list().concat(kimi.keepalive.list()));
ipcMain.handle('satr:killBgProc', (event, id) => {
  if (typeof id === 'string' && SAFE_KS_ID.test(id)) return kimi.keepalive.kill(id.slice(3));
  if (typeof id !== 'string' || !SAFE_BG_ID.test(id)) return { ok: false, error: 'bad_id' };
  return bgprocs.kill(id);
});

// رد الواجهة على طلب إذن أداة — يوجَّه للمقبض الجاري أياً كان محركه:
// محرك SDK (currentRun) أو محوّل بحلقة وكيل (currentCliRun منذ 2.2)
ipcMain.handle('satr:permission', (event, p) => {
  if (!p || typeof p.id !== 'string') return { ok: false };
  let ok = false;
  if (currentRun) ok = currentRun.resolvePermission(p.id, !!p.allow, !!p.always, !!p.turn);
  if (!ok && currentCliRun && typeof currentCliRun.resolvePermission === 'function') {
    ok = currentCliRun.resolvePermission(p.id, !!p.allow, !!p.always, !!p.turn);
  }
  if (!ok && pendingVerificationPermissions.has(p.id)) {
    const resolve = pendingVerificationPermissions.get(p.id);
    pendingVerificationPermissions.delete(p.id);
    resolve(!!p.allow);
    ok = true;
  }
  // مجرى المراقبة (§4.7): قرار الإذن — عنصر أساسي في سجل التدقيق (3.4)
  try {
    notifyObservers({ type: 'permission_reply', id: p.id, allow: !!p.allow, always: !!p.always, engine: lastEngine }, { engine: lastEngine });
  } catch (e) { /* عزل */ }
  return { ok };
});

// ---------- C1: التوجيه أثناء الدور (turn/steer) — محرك Codex حصراً ----------
// «سطر» لا يوقف الدور ليضيف تعليمة: النص يُحقن في الدور الجاري نفسه. المحركات الأخرى
// لا تملك العقد (Kimi ACP يرفض دوراً ثانياً بـ-32600، وSDK بلا steer) ⇒ unsupported.
// التنقية تُفرض هنا (القاعدة 2) عبر codex.sanitizeSteerText النقية — نمط nonSdkPerm في
// autogate.js: المنطق مختبَر وحده والفرض في العملية الرئيسية (نص فقط، محارف التحكم
// وBidi تُزال، وسقف صريح). ولا يمرّ خطأ upstream الخام (رسالته تحمل معرّف الدور النشط
// الفعلي) — الرموز المعادة ثابتة.
ipcMain.handle('satr:steer', async (event, p) => {
  if (!p || typeof p.text !== 'string') return { ok: false, error: 'bad_input' };
  const text = codex.sanitizeSteerText(p.text);
  if (!text) return { ok: false, error: 'empty' };
  if (lastEngine !== 'codex') return { ok: false, error: 'unsupported' };
  if (!currentRun || typeof currentRun.steer !== 'function') return { ok: false, error: 'no_active_turn' };
  const r = await currentRun.steer(text);
  return r && r.ok === true ? { ok: true } : { ok: false, error: (r && r.error) || 'rejected' };
});

// رد أسئلة النموذج: محركات الاختيار تستخدم المؤشرات، وCodex قد يضيف نصاً حراً محدوداً.
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
    text: typeof (s && s.text) === 'string' && Array.from(s.text).length <= 4000 ? s.text : null,
  }));
  let ok = false;
  if (currentRun && typeof currentRun.resolveQuestion === 'function') ok = currentRun.resolveQuestion(p.id, selections);
  return { ok };
});

const elicitationOpening = new Set();

// رد حوار إدخال موصّل Claude. ID/action/content تُنقّى هنا ثم يعيد agent.js فحص
// الأسماء والقيم مقابل schema الأصلي. URL لا يأتي من renderer إطلاقاً: نقرأه من الطلب
// المعلّق، نفتحه فقط بعد نقرة المستخدم، ثم نعيد accept إلى SDK إن نجح الفتح.
ipcMain.handle('satr:elicitationDone', async (event, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  const payloadKeys = Object.keys(payload);
  if (payloadKeys.some((key) => key !== 'id' && key !== 'action' && key !== 'content')) return { ok: false };
  if (typeof payload.id !== 'string' || !claudeElicitation.SAFE_ID.test(payload.id)) return { ok: false };
  if (payload.action !== 'accept' && payload.action !== 'decline') return { ok: false };
  const run = currentRun;
  if (!run || typeof run.peekElicitation !== 'function' || typeof run.resolveElicitation !== 'function') {
    return { ok: false };
  }
  const pendingRequest = run.peekElicitation(payload.id);
  if (!pendingRequest) return { ok: false };
  const hasContent = Object.prototype.hasOwnProperty.call(payload, 'content');
  const publicReply = (result) => {
    if (result && typeof result === 'object') {
      const reply = { ok: result.ok === true };
      if (result.declined === true) reply.declined = true;
      if (typeof result.error === 'string') reply.error = result.error.slice(0, 80);
      return reply;
    }
    return { ok: result === true };
  };

  if (payload.action === 'decline') {
    if (hasContent) return { ok: false };
    return publicReply(run.resolveElicitation(payload.id, 'decline'));
  }
  if (pendingRequest.mode === 'url') {
    if (hasContent) return { ok: false };
    const url = claudeElicitation.safeUrl(pendingRequest.url);
    if (!url) {
      run.resolveElicitation(payload.id, 'decline');
      return { ok: false, error: 'bad_url' };
    }
    if (elicitationOpening.has(payload.id)) return { ok: false, error: 'in_flight' };
    elicitationOpening.add(payload.id);
    try {
      await shell.openExternal(url);
      return publicReply(run.resolveElicitation(payload.id, 'accept'));
    } catch {
      return { ok: false, error: 'open_failed' };
    } finally {
      elicitationOpening.delete(payload.id);
    }
  }
  if (pendingRequest.mode !== 'form' || !hasContent) return { ok: false };
  const cleaned = claudeElicitation.sanitizeRendererContent(payload.content);
  if (!cleaned.ok) {
    if (cleaned.error === 'secret') {
      emitToWindow({ type: 'stderr', text: claudeElicitation.SECRET_REJECTION_MESSAGE });
      run.resolveElicitation(payload.id, 'decline');
      return { ok: true, declined: true, error: 'secret' };
    }
    return { ok: false, error: cleaned.error };
  }
  return publicReply(run.resolveElicitation(payload.id, 'accept', cleaned.content));
});

// رد الواجهة على التسليم البشري browser_handoff (زرا «استلمت»/«إلغاء» في شريط لوحة
// المعاينة): id بنمط ho_… من المحرك (SDK أو Codex — كلاهما في currentRun)، وdone
// boolean فقط. لا نص حر — التنقية طبقة أولى وresolveHandoff يتجاهل معرّفاً غير معلّق.
const SAFE_HANDOFF_ID = /^ho_[A-Za-z0-9_]{1,64}$/;
ipcMain.handle('satr:handoffDone', (event, p) => {
  // مراجعة Codex: boolean حصراً — !!"false" أو !!{} كانت تتحول «استلمت» زوراً
  if (!p || typeof p.id !== 'string' || !SAFE_HANDOFF_ID.test(p.id) || typeof p.done !== 'boolean') return { ok: false };
  let ok = false;
  if (currentRun && typeof currentRun.resolveHandoff === 'function') ok = currentRun.resolveHandoff(p.id, p.done);
  return { ok };
});

// إدخال سرّ بيد المستخدم داخل WebContentsView: الواجهة تعيد id+boolean فقط، وpreview.js
// يتحقق من امتلاء الحقل داخلياً بلا إعادة القيمة أو تسجيلها.
const SAFE_SECRET_REQUEST_ID = /^secret_[a-f0-9]{32}$/;
ipcMain.handle('satr:secretDone', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_SECRET_REQUEST_ID.test(p.id) || typeof p.done !== 'boolean') return { ok: false };
  return preview.resolveSecretRequest(p.id, p.done);
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
  if (r3 && r3.ok) return r3;
  const r4 = kimi.undoEdit(id);
  return (r4 && r4.ok) ? r4 : r;
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
ipcMain.handle('satr:sessionMetaList', () => ({ ok: true, entries: sessionmeta.list() }));
ipcMain.handle('satr:sessionMetaSet', (event, p) => {
  if (!p || typeof p.sessionId !== 'string' || !SAFE_SESSION.test(p.sessionId)) {
    return { ok: false, error: 'bad_input' };
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(p, 'pinned')) {
    if (typeof p.pinned !== 'boolean') return { ok: false, error: 'bad_input' };
    patch.pinned = p.pinned;
  }
  if (Object.prototype.hasOwnProperty.call(p, 'title')) {
    if (typeof p.title !== 'string' || p.title.length > 1000) return { ok: false, error: 'bad_input' };
    patch.title = p.title;
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'bad_input' };
  return sessionmeta.set(p.sessionId, patch);
});

// جلسات Codex (تلميع المرحلة 4 — قراءة فقط، التحقق من المعرّف داخل codexsessions.js)
ipcMain.handle('satr:listCodexSessions', () => codexSessions.listCodexSessions());
ipcMain.handle('satr:readCodexSession', (event, p) => codexSessions.readCodexSession(p && p.id));
ipcMain.handle('satr:nameCodexSession', (event, p) => codexSessions.setCodexSessionName(p && p.id, p && p.name));
ipcMain.handle('satr:archiveCodexSession', (event, p) => codexSessions.archiveCodexSession(p && p.id));
ipcMain.handle('satr:deleteCodexSession', (event, p) => codexSessions.deleteCodexSession(p && p.id));
ipcMain.handle('satr:forkCodexSession', (event, p) => codexSessions.forkCodexSession(p && p.id));

// جلسات Kimi تُقرأ عبر ACP الرسمي (`session/list` و`session/load`) لا بتحليل wire.jsonl.
ipcMain.handle('satr:listKimiSessions', () => kimi.listSessions());
ipcMain.handle('satr:readKimiSession', (event, p) => kimi.readSession(p && p.id));

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

// ---------- نموذج لكل عقدة (هيئة القضاة) — تنقية في main.js حصراً ----------
// الغياب أو الكائن الفارغ = السلوك القائم حرفياً (resolveOpsRoomModel: env ثم
// الافتراضي). قيمة موجودة لا تطابق SAFE_MODEL ⇒ bad_input، لا تجاهل صامت.
// قيم البيئة لا تصل renderer كما كانت.
function sanitizeOpsModels(value, allowedKeys) {
  if (value == null) return { ok: true, models: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const models = {};
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return { ok: false };
    const raw = value[key];
    if (raw == null || raw === '') continue;
    if (typeof raw !== 'string' || !SAFE_MODEL.test(raw)) return { ok: false };
    models[key] = raw;
  }
  return { ok: true, models };
}

function sanitizeArtifactRel(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || /[\x00-\x1F\x7F-\x9F?*]/.test(value)) return '';
  const rel = value.replace(/\\/g, '/');
  const normalized = executorModule.normalizeOwnership([rel]);
  return normalized && normalized.length === 1 && normalized[0] === rel ? rel : '';
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
  // حلقة نشطة تملك فريقها؛ بدء فريق يدوي بجانبها يخلق منفّذين متزامنين على المشروع.
  if (loopRunner.isActive()) return { ok: false, error: 'busy' };
  const agents = [];
  for (const raw of p.agents) {
    const task = cleanMemoryText(raw && raw.task, 4000);
    const ownership = sanitizeOwnership(raw && raw.ownership);
    if (!task || !ownership) return { ok: false, error: 'bad_input' };
    agents.push({ task, ownership });
  }
  const modelCheck = preflightOpsRoomModels(mode === 'mergeable' ? ['sdk', 'codex'] : ['sdk']);
  if (!modelCheck.ok) return modelCheck;
  // هيئة القضاة: نموذج عوامل sdk لهذا التشغيل (اختياري).
  const teamModels = sanitizeOpsModels(p.models, ['worker']);
  if (!teamModels.ok) return { ok: false, error: 'bad_input' };
  if (mode === 'mergeable') {
    const configured = await integration.preflight(cwd);
    if (!configured.ok) return configured;
    const unavailable = unavailableReviewEngines(['sdk']);
    if (unavailable.length) return { ok: false, error: 'review_engine_unavailable', engines: unavailable };
  }
  const previewCleanup = await integration.stopPreview();
  if (!previewCleanup.ok) return previewCleanup;
  const created = opsroom.createRoom();
  if (!created.ok) return { ok: false, error: 'ops_room_unavailable' };
  const roomId = created.room.room_id;
  const result = await executionTeam.start({
    agents, mode, roomId, timeoutMs: timeoutSeconds * 1000, model: teamModels.models.worker || '',
  }, cwd, (obj) => emitOpsTeam(roomId, cwd, obj));
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

// ---------- وضع الحلقة المحدودة (الجولة الخامسة — النواة) ----------
// الحلقة تملك فريقاً واحداً طوال عمرها، فبدء فريق يدوي أثناءها مرفوض والعكس.
// عند نهايتها يُسلَّم الأثر إلى مسار المراجعة/التحقق/الدمج القائم عبر restore بلا
// تغيير أي بوابة: البوابة البشرية تبقى مراجعة عمياء + تحقق passed + تأكيد صريح.
const LOOP_ITERATION_MIN = looprunnerModule.MIN_ITERATIONS;
const LOOP_ITERATION_MAX = looprunnerModule.MAX_ITERATIONS;
const LOOP_BUDGET_MIN = looprunnerModule.MIN_BUDGET_TOKENS;
const LOOP_BUDGET_MAX = looprunnerModule.MAX_BUDGET_TOKENS;
const LOOP_BLOCKING_TEAM_STATES = new Set(['preparing', 'running', 'stopping']);
const loopHandoffSeen = new Set();

const loopRunner = looprunnerModule.create({
  runner: sdkExecutionRunner,
  recordNote: (note) => {
    const value = note && typeof note === 'object' ? note : {};
    recordOpsSystem(value.roomId, 'note', value.text, value.teamId, '', value.transitionKey);
  },
});

function loopTeamBusy() {
  const team = executionTeam.latest();
  return !!(team && LOOP_BLOCKING_TEAM_STATES.has(team.state));
}

/**
 * تسليم أثر الحلقة مرة واحدة: restore يسجّل الفريق المكتمل في نسخة main، فيبثّ
 * execution_team_update عبر emitOpsTeam فيجري حفظ الأثر المشفّر وملاحظة الجهوزية
 * وفهرس الغرفة كما لأي فريق عادي — بلا مسار حفظ ثانٍ وبلا تكرار.
 */
function finalizeLoopHandoff(roomId, cwd, loopEvent) {
  if (loopHandoffSeen.has(loopEvent.loop_id)) return;
  loopHandoffSeen.add(loopEvent.loop_id);
  while (loopHandoffSeen.size > 20) loopHandoffSeen.delete(loopHandoffSeen.values().next().value);
  if (!looprunnerModule.HANDOFF_STATES.has(loopEvent.state)) return;
  const handoff = loopRunner.handoff(loopEvent.loop_id);
  if (!handoff || !handoff.ok) {
    recordOpsSystem(roomId, 'note', 'انتهت الحلقة بلا أثر قابل للمراجعة.', loopEvent.team_id, '',
      'loop-handoff-empty:' + loopEvent.loop_id);
    return;
  }
  const restored = executionTeam.restore(handoff.bundle, handoff.cwd, (obj) => emitOpsTeam(roomId, cwd, obj));
  if (!restored || !restored.ok) {
    recordOpsSystem(roomId, 'note', 'تعذّر تسليم أثر الحلقة إلى مسار المراجعة؛ ابدأ فريقاً جديداً للمتابعة.',
      loopEvent.team_id, '', 'loop-handoff-failed:' + loopEvent.loop_id);
  }
}

function emitLoopEvent(roomId, cwd, obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.type === 'loop_update') {
    emitToWindow(obj);
    if (looprunnerModule.TERMINAL_LOOP_STATES.has(obj.state)) finalizeLoopHandoff(roomId, cwd, obj);
    return;
  }
  // execution_team_update من نسخة الحلقة الخاصة: بثّ مباشر بلا bookkeeping الأثر،
  // كي لا يُحاول حفظ أثر لفريق لم يُسجَّل بعد في نسخة main (يجري ذلك عند التسليم).
  emitToWindow(obj);
}

ipcMain.handle('satr:loopPreflight', async (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  const configured = await integration.preflight(cwd);
  if (!configured || !configured.ok) return configured || { ok: false, error: 'verification_config_required' };
  // sourceRoot مسار مطلق ولا يعبر إلى renderer — العقد يعيد head والأوامر فقط.
  return {
    ok: true,
    head: configured.head,
    checks: (configured.checks || []).map((check) => ({
      id: check.id,
      label: check.label,
      command: check.command,
      timeout_seconds: check.timeout_seconds,
    })),
  };
});

ipcMain.handle('satr:loopStart', async (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  const task = cleanMemoryText(p.task, 4000);
  const ownership = sanitizeOwnership(p.ownership);
  const options = p.loop && typeof p.loop === 'object' && !Array.isArray(p.loop) ? p.loop : {};
  const maxIterations = options.max_iterations == null ? looprunnerModule.DEFAULT_ITERATIONS : options.max_iterations;
  const budgetTokens = options.budget_tokens == null ? looprunnerModule.DEFAULT_BUDGET_TOKENS : options.budget_tokens;
  const timeoutSeconds = options.timeout_seconds == null ? 300 : options.timeout_seconds;
  if (p.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (!cwd || !task || !ownership) return { ok: false, error: 'bad_input' };
  if (!Number.isInteger(maxIterations) || maxIterations < LOOP_ITERATION_MIN || maxIterations > LOOP_ITERATION_MAX) {
    return { ok: false, error: 'bad_input' };
  }
  if (!Number.isInteger(budgetTokens) || budgetTokens < LOOP_BUDGET_MIN || budgetTokens > LOOP_BUDGET_MAX) {
    return { ok: false, error: 'bad_input' };
  }
  if (!Number.isInteger(timeoutSeconds) || !OPS_TIMEOUT_SECONDS.has(timeoutSeconds)) {
    return { ok: false, error: 'bad_input' };
  }
  // هيئة القضاة: نموذج عامل الحلقة لهذا التشغيل (اختياري).
  const loopModels = sanitizeOpsModels(p.models, ['worker']);
  if (!loopModels.ok) return { ok: false, error: 'bad_input' };
  if (loopRunner.isActive() || loopTeamBusy()) return { ok: false, error: 'busy' };
  // الحلقة مسار قابل للدمج دائماً: نفس preflight الفريق المدمَج كي لا يُكتشف غياب
  // محرك المراجعة أو الإعداد بعد استهلاك دورات.
  const modelCheck = preflightOpsRoomModels(['sdk', 'codex']);
  if (!modelCheck.ok) return modelCheck;
  const configured = await integration.preflight(cwd);
  if (!configured.ok) return configured;
  const unavailable = unavailableReviewEngines(['sdk']);
  if (unavailable.length) return { ok: false, error: 'review_engine_unavailable', engines: unavailable };
  const previewCleanup = await integration.stopPreview();
  if (!previewCleanup.ok) return previewCleanup;
  const created = opsroom.createRoom();
  if (!created.ok) return { ok: false, error: 'ops_room_unavailable' };
  const roomId = created.room.room_id;
  const result = await loopRunner.start({
    task, ownership, roomId, maxIterations, budgetTokens, timeoutMs: timeoutSeconds * 1000,
    model: loopModels.models.worker || '',
  }, cwd, (obj) => emitLoopEvent(roomId, cwd, obj));
  if (!result || !result.ok || !result.loop) return result;
  const teamId = result.loop.team_id;
  const recorded = recordOpsSystem(roomId, 'note', 'مهمة الحلقة: ' + task, teamId, '',
    'loop-task:' + result.loop.loop_id);
  if (!recorded.ok) {
    recordOpsSystem(roomId, 'note', 'حُجب نص مهمة الحلقة وفق سياسة المحتوى الحساس.', teamId, '',
      'loop-task-redacted:' + result.loop.loop_id);
  }
  recordOpsSystem(roomId, 'note', 'حدود الحلقة المعتمدة: حتى ' + maxIterations + ' دورات، وميزانية تقديرية '
    + budgetTokens + ' رمزاً، ومهلة ' + timeoutSeconds + ' ثانية لكل دورة، والدمج يبقى بمراجعة وتحقق وتأكيد صريح.',
  teamId, '', 'loop-limits:' + result.loop.loop_id);
  return result;
});

ipcMain.handle('satr:loopStop', async (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!looprunnerModule.SAFE_LOOP_ID.test(p.loopId || '')) return { ok: false, error: 'bad_input' };
  return loopRunner.stop(p.loopId);
});

ipcMain.handle('satr:loopLatest', (event, payload) => {
  const cwd = sanitizeMemoryCwd(payload && payload.cwd);
  if (!cwd) return { ok: false, error: 'bad_input' };
  return { ok: true, loop: loopRunner.latest(cwd) };
});

// ---------- مراجعة ثانية ودمج صريح لفرق الفريق (الأولوية 6 — الخطوة 4) ----------
ipcMain.handle('satr:executionReviewStart', (event, payload) => {
  const p = payload || {};
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '')) return { ok: false, error: 'bad_input' };
  const artifact = executionTeam.artifact(p.teamId);
  if (!artifact || !opsroom.SAFE_ROOM_ID.test(artifact.room_id || '')) return { ok: false, error: 'not_available' };
  const modelCheck = preflightOpsRoomModels(reviewerModule.requiredReviewEngines(artifact.producer_engines));
  if (!modelCheck.ok) return modelCheck;
  // هيئة القضاة: نموذج اختياري لعقد زوايا كل محرك مراجعة.
  const reviewModels = sanitizeOpsModels(p.models, ['sdk', 'codex']);
  if (!reviewModels.ok) return { ok: false, error: 'bad_input' };
  return reviewer.start({
    teamId: p.teamId,
    artifactId: artifact.artifact_id,
    patch: artifact.patch,
    files: artifact.files,
    producerEngines: artifact.producer_engines,
    models: reviewModels.models,
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

ipcMain.handle('satr:executionFileDiff', (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const rel = sanitizeArtifactRel(p.rel);
  if (!executionTeamModule.SAFE_RUN_ID.test(p.teamId || '')
    || !integration.SAFE_ARTIFACT_ID.test(p.artifactId || '') || !rel) {
    return { ok: false, error: 'bad_input' };
  }
  const artifact = executionTeam.artifact(p.teamId);
  if (!artifact || artifact.artifact_id !== p.artifactId) return { ok: false, error: 'artifact_mismatch' };
  return opsartifacts.fileDiff(artifact, rel);
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
  return {
    ok: true,
    verification: artifact ? integration.latest(artifact.artifact_id) : null,
    preview: artifact ? integration.latestPreview(artifact.artifact_id) : null,
  };
});

ipcMain.handle('satr:executionPreviewStart', async (event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = sanitizeMemoryCwd(p.cwd);
  if (!cwd || !executionTeamModule.SAFE_RUN_ID.test(p.teamId || '')
    || !integration.SAFE_ARTIFACT_ID.test(p.artifactId || '') || p.confirmed !== true
    || Object.prototype.hasOwnProperty.call(p, 'command')) {
    return { ok: false, error: p.confirmed === true ? 'bad_input' : 'confirmation_required' };
  }
  const artifact = executionTeam.artifact(p.teamId);
  if (!artifact || artifact.artifact_id !== p.artifactId
    || path.resolve(artifact.sourceRoot) !== path.resolve(cwd)) {
    return { ok: false, error: 'artifact_mismatch' };
  }
  return integration.preparePreview(artifact, true,
    (obj) => emitOpsPreview(artifact.room_id, p.teamId, obj));
});

ipcMain.handle('satr:executionPreviewStop', async () => integration.stopPreview());

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
  const previewCleanup = await integration.stopPreview();
  const marked = executionTeam.markMerged(p.teamId);
  opsartifacts.remove(artifact.artifact_id, { projectRoot: artifact.sourceRoot });
  savedOpsArtifacts.delete(savedOpsArtifactKey(artifact.sourceRoot, artifact.artifact_id));
  if (marked && marked.team) updateOpsRoomIndex(artifact.sourceRoot, marked.team, false);
  recordOpsSystem(artifact.room_id, 'phase_gate', 'اكتمل انتقال الدمج للأثر المعتمد.',
    p.teamId, artifact.artifact_id, 'merge:completed');
  return {
    ...result,
    team: marked && marked.team ? marked.team : null,
    preview: previewCleanup.preview || null,
    ...(previewCleanup.ok ? {} : { preview_cleanup_failed: true, cleanup_error: 'cleanup_failed' }),
  };
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
const REVIEW_CONTROL_AND_BIDI = /[\u0000-\u0009\u000B-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function sanitizeReviewSkillReference(value) {
  if (value == null) return { ok: true, value: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.name !== 'string' || value.name.length > 64) {
    return { ok: false, error: 'bad_review_skill' };
  }
  const name = value.name.trim();
  return skillwriter.SAFE_SKILL_NAME.test(name) && name !== '.' && name !== '..'
    ? { ok: true, value: { name } }
    : { ok: false, error: 'bad_review_skill' };
}

function sanitizeReviewSkillDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'bad_skill' };
  if (typeof value.name !== 'string' || value.name.length > 64) return { ok: false, error: 'bad_name' };
  const name = value.name.trim();
  if (!skillwriter.SAFE_SKILL_NAME.test(name) || name === '.' || name === '..') return { ok: false, error: 'bad_name' };
  if (typeof value.description !== 'string'
      || Array.from(value.description).length > skillwriter.MAX_DESCRIPTION_POINTS) {
    return { ok: false, error: 'bad_description' };
  }
  const description = value.description.replace(REVIEW_CONTROL_AND_BIDI, ' ').replace(/\s+/g, ' ').trim();
  if (!description) return { ok: false, error: 'bad_description' };
  if (typeof value.criteria !== 'string'
      || Buffer.byteLength(value.criteria, 'utf8') > skillwriter.MAX_CRITERIA_BYTES) {
    return { ok: false, error: 'bad_criteria' };
  }
  if (memory.hasSecret(value.criteria)) return { ok: false, error: 'secret' };
  const criteria = value.criteria.replace(/\r\n?/g, '\n').replace(REVIEW_CONTROL_AND_BIDI, '').trim();
  if (!criteria) return { ok: false, error: 'bad_criteria' };
  return { ok: true, value: { name, description, criteria } };
}

ipcMain.handle('satr:reviewSkillCreate', (event, payload) => {
  const p = payload || {};
  if (p.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (typeof p.overwrite !== 'boolean'
      || typeof p.cwd !== 'string' || !p.cwd.trim() || p.cwd.length > MAX_VERIFY_CWD
      || p.cwd.includes('\0') || !path.isAbsolute(p.cwd.trim())) {
    return { ok: false, error: 'bad_input' };
  }
  const cwd = p.cwd.trim();
  try {
    const cwdStat = fs.lstatSync(cwd);
    if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()) throw new Error();
  } catch { return { ok: false, error: 'bad_cwd' }; }
  const draft = sanitizeReviewSkillDraft(p.skill);
  if (!draft.ok) return { ok: false, error: draft.error };
  return skillwriter.createSkill(cwd, draft.value, { confirmed: true, overwrite: p.overwrite });
});

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
  const reviewSkill = sanitizeReviewSkillReference(p.reviewSkill);
  if (!reviewSkill.ok) return { ok: false, error: reviewSkill.error };
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
  const configShape = { version: 1, commands, ...(reviewSkill.value ? { review_skill: reviewSkill.value } : {}) };
  if (Buffer.byteLength(JSON.stringify(configShape), 'utf8') > verify.MAX_CONFIG_BYTES) {
    return { ok: false, error: 'bad_input' };
  }
  return verify.createConfig(cwd, commands, {
    confirmed: true, overwrite: p.overwrite, reviewSkill: reviewSkill.value,
  });
});

ipcMain.handle('satr:checkpointLatest', (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '')) return null;
  const latest = checkpoints.latest(p.engine, p.sessionId);
  if (p.engine === 'sdk') {
    const marker = sdkrewinds.get(p.sessionId);
    if (marker && (!latest || marker.checkpointId === latest.id)) return null;
    if (marker && latest && marker.checkpointId !== latest.id) sdkrewinds.clear(p.sessionId);
  }
  return latest;
});

ipcMain.handle('satr:checkpointRestore', async (event, payload) => {
  const p = payload || {};
  if (!SAFE_ENGINE.test(p.engine || '') || !SAFE_SESSION.test(p.sessionId || '')
      || !SAFE_CHECKPOINT_ID.test(p.checkpointId || '') || typeof p.cwd !== 'string' || !p.cwd.trim()) {
    return { ok: false, error: 'bad_input' };
  }
  const rewindMarker = p.engine === 'sdk' ? sdkrewinds.get(p.sessionId) : null;
  if (rewindMarker && rewindMarker.checkpointId === p.checkpointId) {
    return { ok: false, error: 'superseded_by_sdk_rewind' };
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
  const rewindMarker = p.engine === 'sdk' ? sdkrewinds.get(p.sessionId) : null;
  if (rewindMarker && rewindMarker.checkpointId === p.checkpointId) {
    return { ok: false, error: 'superseded_by_sdk_rewind' };
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

// C3: الحمولة صارت كائناً {cwd, engine} — النص المجرّد يبقى مقبولاً كتوافق.
ipcMain.handle('satr:mcpStatus', (event, p) => {
  const raw = p && typeof p === 'object' ? p.cwd : p;
  const dir = typeof raw === 'string' && raw.trim() ? raw.trim() : os.homedir();
  if (p && typeof p === 'object' && p.engine === 'codex') return codex.mcpStatus(dir);
  return agent.mcpStatus(dir);
});

ipcMain.handle('satr:mcpAction', (event, p) => {
  if (!p || typeof p.name !== 'string' || !SAFE_MCP_NAME.test(p.name))
    return { ok: false, error: 'bad_name' };
  if (!MCP_ACTIONS.has(p.action)) return { ok: false, error: 'bad_action' };
  const dir = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : os.homedir();
  // C3: Codex يعلن إعادة تحميل الإعداد فقط (config/mcpServer/reload). التفعيل/التعطيل
  // يستلزمان الكتابة في ~/.codex/config.toml — و«سطر» لا يلمسه ⇒ unsupported صريحة.
  if (p.engine === 'codex') {
    if (p.action !== 'reconnect') return { ok: false, error: 'unsupported' };
    return codex.mcpReload(dir);
  }
  return agent.mcpAction(dir, p.name, p.action);
});

// ---------- C3: تسجيل دخول OAuth لموصّل Codex ----------
// **الرابط لا يعبر IPC إطلاقاً**: البدء يعيد معرّفاً فقط، والفتح يقرأ الرابط من الطلب
// المعلّق داخل codex.js ويتحقق منه ثم يفتحه في متصفح النظام بعد نقرة المستخدم
// (نمط حوار elicitation ‏URL). ولا يُخزَّن أي token في «سطر» — المصادقة داخل Codex.
const SAFE_MCP_OAUTH_ID = /^cxoauth_[0-9]{1,9}_[a-z0-9]{1,8}$/;
const mcpOauthOpening = new Set();

ipcMain.handle('satr:mcpOauthStart', async (event, p) => {
  if (!p || typeof p.name !== 'string' || !SAFE_MCP_NAME.test(p.name))
    return { ok: false, error: 'bad_name' };
  const dir = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : os.homedir();
  const started = await codex.mcpOauthStart(dir, p.name);
  // قائمة سماح صارمة على المُعاد — لا تسريب رابط أو حقول داخلية
  if (!started || !started.ok) return { ok: false, error: (started && started.error) || 'failed' };
  return { ok: true, id: started.id, name: started.name };
});

ipcMain.handle('satr:mcpOauthOpen', async (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_MCP_OAUTH_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  const url = codex.mcpOauthUrl(p.id);   // منقّى داخلياً بـsafeOauthUrl
  if (!url) { codex.mcpOauthCancel(p.id); return { ok: false, error: 'bad_url' }; }
  if (mcpOauthOpening.has(p.id)) return { ok: false, error: 'in_flight' };
  mcpOauthOpening.add(p.id);
  try {
    await shell.openExternal(url);
  } catch {
    mcpOauthOpening.delete(p.id);
    return { ok: false, error: 'open_failed' }; // يبقى الطلب معلّقاً لإعادة المحاولة
  }
  try {
    const done = await codex.mcpOauthAwait(p.id);
    return done && done.ok ? { ok: true, success: done.success === true } : { ok: false, error: (done && done.error) || 'failed' };
  } finally { mcpOauthOpening.delete(p.id); }
});

ipcMain.handle('satr:mcpOauthCancel', (event, p) => {
  if (!p || typeof p.id !== 'string' || !SAFE_MCP_OAUTH_ID.test(p.id)) return { ok: false, error: 'bad_id' };
  return codex.mcpOauthCancel(p.id);
});

// ---------- استخدام نافذة السياق للوحة /سياق (Claude SDK أو أمر Kimi ACP الرسمي /usage) ----------

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
  if (p && p.engine === kimi.ENGINE_ID) return kimi.contextUsage(dir, sid);
  // C2: Codex — لقطة آخر thread/tokenUsage/updated المحفوظة في codex.js (لا IPC جديد)
  if (p && p.engine === 'codex') return codex.contextUsage(dir, sid);
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
let shutdownCleanup = null;
let shutdownClean = false;

async function cleanupBeforeQuit() {
  cancelPendingSendRequest();
  await stopAll();
  await Promise.allSettled([
    orchestrator.stopAll(), opsBrainstorm.stopAll(), opsPlanner.stopAll(), executor.stopAll(),
    executionTeam.stopAll(), loopRunner.stopAll(), reviewer.stopAll(), integration.stopAll(), promocapture.stopAll(),
  ]);
  if (integration.latestPreview()) await integration.stopAll();
  bgprocs.killAll();
  await kimi.keepalive.killAll(); // K2: لا تبقى عمليات kimi acp يتيمة بعد إغلاق سطر
  term.killAll();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.quit(); return; }
  cleanupBeforeQuit().catch(() => {});
});
app.on('before-quit', (event) => {
  if (shutdownClean) return;
  event.preventDefault();
  if (shutdownCleanup) return;
  shutdownCleanup = cleanupBeforeQuit().finally(() => {
    shutdownClean = true;
    app.quit();
  });
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
