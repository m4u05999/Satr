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
const skills = require('./skills');
const agentsList = require('./agents');
const agent = require('./agent');
const adapters = require('./adapters');
const inject = require('./inject');
const chats = require('./chats');
const features = require('./features');
const keys = require('./keys');
const bgprocs = require('./bgprocs');
const term = require('./term');
const updater = require('./updater');

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

// لقطة القدرات للواجهة (قراءة فقط): تُظهر/تُخفي قدرات Enterprise. المجتمعية ⇒ {enterprise:false}
ipcMain.handle('satr:features', () => features.snapshot());

// قائمة مزوّدي المحرّكات (طبقة المزوّد §4.2) — لبناء قائمة «المحرك» ديناميكياً في الواجهة
ipcMain.handle('satr:providers', () => ({ providers: adapters.list() }));

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
const SAFE_MODEL = /^[A-Za-z0-9.-]{1,64}$/;
const SAFE_SKILL = /^[A-Za-z0-9_:.-]{1,64}$/; // اسم مهارة أو plugin:skill
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
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
}

// تتبّع عمليات الخلفية: يُبثّ مباشرةً (لا عبر token الدور) لأنه يعيش بعد انتهاء الدور
bgprocs.setNotifier((procs) => emitToWindow({ type: 'bg_procs', procs }));

// رقم تسلسلي للتشغيل: أحداث متأخرة من تشغيل أُلغي (proc_done مثلاً)
// لا يجوز أن تصل للواجهة فتُنهي رسالة التشغيل الجديد قبل أوانها
let runSeq = 0;

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
  const emit = (obj) => { if (token === runSeq) emitToWindow(obj); };

  // المحرّكات غير SDK تمر عبر طبقة adapters (القاعدة 2: التنقية هنا في main.js)
  const adapter = adapters.get(payload.engine);
  if (adapter) {
    // 1.1 — حقن @الملفات (ROADMAP الدفعة 1): محوّلات REST لا ترى القرص، فنقرأ الملفات
    // المُشار إليها بـ @مسار ونحقنها في البرومبت. عائلة claude (cli) تُستثنى — كلود
    // يقرأ الملفات بنفسه. التنقية كلها في inject.js (داخل cwd حصراً + سقوف حجم).
    const meta = adapters.list().find((p) => p.name === payload.engine);
    const isBlind = !meta || meta.family !== 'claude';
    const inj = isBlind ? inject.injectFiles(prompt, cwd) : { prompt, attached: [], skipped: [] };

    // مسار نصّي عبر stdin — لا يدعم الصور (محرك SDK يدعمها)
    const input = {
      prompt: inj.prompt,
      sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
      model: payload.model && SAFE_MODEL.test(payload.model) ? payload.model : null,
      permissionMode: PERMISSION_MODES.has(payload.permissionMode) ? payload.permissionMode : 'default',
      extraDirs: sanitizeExtraDirs(payload.extraDirs), // متاحة للمحوّلات؛ cli/gemini الحاليان لا يستخدمانها
    };
    try {
      currentCliRun = adapter.start(input, cwd, emit);
      return {
        started: true, engine: payload.engine, imagesIgnored: images.length > 0,
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
      prompt,
      images,
      sessionId: payload.sessionId && SAFE_SESSION.test(payload.sessionId) ? payload.sessionId : null,
      model: payload.model && SAFE_MODEL.test(payload.model) ? payload.model : null,
      permissionMode: PERMISSION_MODES.has(payload.permissionMode) ? payload.permissionMode : 'default',
      skills: sanitizeSkills(payload.skills),
      effort: EFFORT_LEVELS.has(payload.effort) ? payload.effort : null,
      extraDirs: sanitizeExtraDirs(payload.extraDirs),
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

// ---------- عمليات الخلفية المعمّرة (خوادم التطوير ونحوها) ----------
// مستقلة عن الدور: تُسرد وتُقتل حتى بعد انتهاء التشغيل واختفاء زرّ الإيقاف.
const SAFE_BG_ID = /^bg_[0-9]{1,12}$/;
ipcMain.handle('satr:listBgProcs', () => bgprocs.list());
ipcMain.handle('satr:killBgProc', (event, id) => {
  if (typeof id !== 'string' || !SAFE_BG_ID.test(id)) return { ok: false, error: 'bad_id' };
  return bgprocs.kill(id);
});

// رد الواجهة على طلب إذن أداة (محرك SDK)
ipcMain.handle('satr:permission', (event, p) => {
  if (!currentRun || !p || typeof p.id !== 'string') return { ok: false };
  return { ok: currentRun.resolvePermission(p.id, !!p.allow, !!p.always) };
});

// ---------- التراجع عن تعديل ملف (المرحلة 3) ----------
// المعرّف هو tool_use_id الذي أصدره المحرك؛ نتحقق من شكله قبل تمريره.
// المسار نفسه مخزَّن في لقطة agent.js (ليس مدخلاً من الواجهة) فلا حقن مسارات.
const SAFE_EDIT_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
ipcMain.handle('satr:undoEdit', (event, id) => {
  if (typeof id !== 'string' || !SAFE_EDIT_ID.test(id)) return { ok: false, error: 'bad_id' };
  return agent.undoEdit(id);
});

// ---------- التحديث التلقائي (المرحلة 17) — رد الواجهة على «أعد التشغيل الآن» ----------
ipcMain.handle('satr:restartUpdate', () => { updater.quitAndInstall(); return { ok: true }; });

// ---------- متصفح الجلسات (قراءة فقط — التحقق من المدخلات داخل sessions.js) ----------

ipcMain.handle('satr:listSessions', () => sessions.listSessions());
ipcMain.handle('satr:readSession', (event, p) => sessions.readSession(p && p.project, p && p.id));

// ---------- سرد ملفات المشروع لمنصّة @ (قراءة فقط) ----------

ipcMain.handle('satr:listFiles', (event, cwd) => {
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return files.listFiles(dir);
});

// ---------- ذاكرة المحوّلات (الدفعة 1.3): مؤشر آخر جلسة لكل مزوّد ----------
// المؤشر على القرص مع ملفات الذاكرة (chats.js) — لا localStorage (قد لا يُفلَش فيضيع).
// معرّف المحوّل الأعمى = اسم مجلد الذاكرة (deepseek/qwen/gemini…).

const SAFE_ENGINE = /^[a-z0-9_-]{1,32}$/;

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  stopAll();
  // إنهاء عمليات الخلفية المتتبَّعة كي لا تبقى خوادم تطوير بلا واجهة تديرها بعد الإغلاق
  bgprocs.killAll();
  term.killAll(); // صدفة الطرفية المدمجة تموت مع «سطر» (المرحلة 8)
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { bgprocs.killAll(); term.killAll(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
