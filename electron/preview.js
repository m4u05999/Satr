// لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب»): متصفح داخل النافذة عبر
// WebContentsView الأصلية في Electron (صفر اعتماديات — قاعدة CLAUDE.md ‏5).
// العرض المضمّن **محتوى غير موثوق بالتعريف** (قرار العزل المثبّت في ROADMAP):
//   - webContents منفصلة تماماً عن واجهة «سطر»: sandbox + contextIsolation،
//     **بلا preload إطلاقاً** (لا window.satr ولا أي جسر — الصفحة معزولة كمتصفح عادي)
//   - partition دائمة مستقلة ('persist:preview') — كوكيز المعاينة لا تلمس جلسة الواجهة
//   - http/https حصراً (will-navigate يحجب غيرها)، النوافذ المنبثقة تُحوَّل لنفس العرض
//   - طلبات أذونات الويب (كاميرا/ميكروفون/إشعارات/موقع…) مرفوضة كلها
// الواجهة ترسم «إطار» اللوحة (رأس + مساحة فارغة) وتبلّغ مستطيلها عبر satr:previewBounds —
// العرض الأصلي يطفو فوق تلك المساحة (إحداثيات DIP تطابق CSS px عند zoom=1).
// أحداث للواجهة عبر قناة مستقلة satr:preview: nav/title/loading/failed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebContentsView, session, app, nativeImage } = require('electron');
const memory = require('./memory');
const browserorigin = require('./browserorigin'); // تصنيف أدوات المتصفح — نقي بلا تبعيات

let view = null;      // WebContentsView الحيّة (تُنشأ عند الفتح وتُدمَّر عند الإغلاق)
let hostWin = null;   // النافذة المضيفة
let sender = null;    // دالة بثّ الأحداث للواجهة (يمرّرها main.js)
let lastBounds = null; // آخر مستطيل أبلغته الواجهة — يُطبَّق عند إنشاء عرض جديد
let viewportOverride = null; // مقاس طلبه الوكيل للتحقق المتجاوب؛ يُطبّق داخل مساحة اللوحة
let externalTargetProvider = null; // نافذة التقاط المنتج المرئية أثناء تسجيل البرومو
const wiredWebContents = new WeakSet();
const resizeWired = new WeakSet(); // نوافذ رُبط لها حارس إعادة تطبيق المستطيل (مرآة RTL)

let snapshotSequence = 0;
let activeSnapshotGeneration = 0;
let activeSnapshotOwnerId = null;
let activeSnapshotNextIndex = 0;
let activeSnapshotTextBytes = 0;
const SNAPSHOT_REF_RE = /^s([1-9][0-9]*):e([1-9][0-9]*)$/;
const LEGACY_SNAPSHOT_REF_RE = /^e[1-9][0-9]*$/;
let activeSnapshotFingerprints = new Map(); // ref → بصمة لحظة اللقطة (داخلية — لا تعبر للنموذج)
const MAX_TRACKED_FINGERPRINTS = 400;

// ---------- عقد اللقطة (Snapshot Lease) — علاج تنازع التحكم (OBS-013) ----------
// المستخدم والوكيل يقودان المعاينة نفسها. إن نقر المستخدم أو ضغط مفتاحاً بعد أن أخذ
// الوكيل لقطته فقد تبدّلت الصفحة تحت refs التي يحملها — فنرفض فعله مغلقاً ونطلب لقطة
// جديدة. العدّاد يرتفع من أحداث الإدخال **الملتزمة** حصراً؛ وmouseMove/mouseEnter/
// mouseLeave/mouseUp/keyUp/mouseWheel مستثناة صراحةً (التمرير والتحويم قراءة لا تفاعل).
// أفعال الوكيل عبر executeJavaScript لا تمر بمسار input-event أصلاً (أثبته المسبار
// الحاجز) فلا تلوّث الكاشف؛ أما pressKey فيمر فيستهلك العقد بنفسه — مقصود: عقد
// input-event بلا provenance، والالتباس يفشل مغلقاً.
const COMMITTED_INPUT_TYPES = new Set(['mouseDown', 'rawKeyDown', 'keyDown']);
let userInputCounter = 0;
let leaseUserRevision = 0;

function nextSnapshotGeneration(wc) {
  snapshotSequence = snapshotSequence >= Number.MAX_SAFE_INTEGER ? 1 : snapshotSequence + 1;
  activeSnapshotGeneration = snapshotSequence;
  activeSnapshotOwnerId = wc && Number.isInteger(wc.id) ? wc.id : null;
  activeSnapshotNextIndex = 0;
  activeSnapshotTextBytes = 0;
  activeSnapshotFingerprints = new Map();
  leaseUserRevision = userInputCounter; // اللقطة تجدّد العقد
  return activeSnapshotGeneration;
}

function invalidateSnapshotRefs(wc) {
  if (!wc || activeSnapshotOwnerId === wc.id) {
    activeSnapshotGeneration = 0;
    activeSnapshotOwnerId = null;
    activeSnapshotNextIndex = 0;
    activeSnapshotTextBytes = 0;
    activeSnapshotFingerprints = new Map();
  }
}

// الفحص الأول من فحصَي العقد: تستدعيه الأغلفة **قبل بوابة الإذن** كي لا يُفتح مربع بلا
// جدوى. الفحص الثاني داخل كل فعل هنا قبل التنفيذ مباشرة — فالحماية قائمة حتى لو لم
// يستدعِ غلافٌ هذه الدالة (fail-closed لا يعتمد على المتصل).
//
// العقد يحكم **أفعال act وحدها**. اللقطة والقراءة والتنقّل والإغلاق هي *مخرج* التنازع
// لا ضحيته: حجبها يغلق الحلقة على الوكيل — الرسالة تطلب لقطة جديدة واللقطة نفسها
// مرفوضة، فلا يبقى للمستخدم إلا إعادة تشغيل التطبيق (بلاغ حيّ 2026-08-18، 20 رفضاً
// متتالياً شمل open_preview وbrowser_snapshot وclose_preview وscreenshot معاً).
// كان التوقيع بلا معاملات بينما يمرّر إليه غلافا agent.js وcodexmcp.js اسم الأداة
// ظانَّين أنه يميّز — فتجاهلُه الاسمَ صامتاً هو العطل. الاستدعاء الداخلي (leaseGate)
// يبقى بلا اسم لأنه لا يقع إلا داخل فعل أصلاً.
function leaseError(name) {
  if (name !== undefined && browserorigin.classifyBrowserTool(name) !== 'act') return null;
  return userInputCounter === leaseUserRevision ? null : 'input_changed';
}

// أسباب تنازع التحكم الثلاثة: تُبثّ للواجهة **بلا أي محتوى صفحة** (السبب فقط).
function conflictError(reason, extra) {
  emit({ type: 'control_conflict', reason });
  return extra ? { error: reason, ...extra } : { error: reason };
}

function leaseGate() {
  return leaseError() ? conflictError('input_changed') : null;
}

// البصمة المتوقعة لهدف الفعل: تُعرف فقط لـ ref من اللقطة النشطة على العرض نفسه.
// مُحدِّد CSS بلا لقطة ⇒ '' ⇒ الحارس يتخطى المقارنة (سلوك ما قبل الدفعة).
function expectedFingerprint(locator, wc) {
  const ref = typeof locator === 'string' ? locator.trim() : '';
  if (!SNAPSHOT_REF_RE.test(ref)) return '';
  const target = wc || currentWC();
  if (!target || target.id !== activeSnapshotOwnerId || !activeSnapshotGeneration) return '';
  return activeSnapshotFingerprints.get(ref) || '';
}

// فاصل حقول البصمة — يُكتب هروباً لا محرف تحكم حرفياً في المصدر (درس loopfailure.js).
const FINGERPRINT_SEP = '\u001f';

// وسم مقروء للبصمة (بلا فاصلها الداخلي) — يظهر في رسالة «كان … وصار …» وحدها.
function fingerprintLabel(value) {
  return String(value || '').split(FINGERPRINT_SEP).map((part) => part.trim()).filter(Boolean).join(' ').slice(0, 160);
}

function rememberFingerprints(entries) {
  if (!entries || typeof entries !== 'object') return;
  for (const [ref, value] of Object.entries(entries)) {
    if (!SNAPSHOT_REF_RE.test(ref) || typeof value !== 'string') continue;
    if (!activeSnapshotFingerprints.has(ref) && activeSnapshotFingerprints.size >= MAX_TRACKED_FINGERPRINTS) continue;
    activeSnapshotFingerprints.set(ref, value);
  }
}

function locatorError(value, wc) {
  const locator = typeof value === 'string' ? value.trim() : '';
  if (LEGACY_SNAPSHOT_REF_RE.test(locator)) return 'stale_ref';
  const match = SNAPSHOT_REF_RE.exec(locator);
  if (!match) return null;
  const target = wc || currentWC();
  return target && target.id === activeSnapshotOwnerId && Number(match[1]) === activeSnapshotGeneration
    ? null : 'stale_ref';
}

function browserInputError(name, input, wc) {
  const bare = String(name || '').replace(/^mcp__satr-terminal__/, '');
  const data = input && typeof input === 'object' ? input : {};
  const refs = [];
  if (['browser_click', 'browser_type', 'browser_select_option', 'browser_hover', 'browser_screenshot_element'].includes(bare)) {
    refs.push(data.ref || data.selector);
  } else if (bare === 'browser_fill_form' && Array.isArray(data.fields)) {
    for (const field of data.fields) refs.push(field && (field.ref || field.selector));
  } else if (bare === 'browser_transfer_field') {
    refs.push(data.from_ref, data.to_ref);
  } else if (bare === 'browser_request_secret') {
    refs.push(data.field_ref || data.ref || data.selector);
  }
  return refs.some((ref) => locatorError(ref, wc) === 'stale_ref') ? 'stale_ref' : null;
}

const PARTITION = 'persist:preview';

// ---------- التقاط الـ console وأخطاء الشبكة (البند 1 — «الوكيل يرى أخطاء التشغيل») ----------
// الوكيل يبني صفحة ويعاينها لكنه أعمى عن أخطاء JavaScript وقت التشغيل وفشل طلبات الشبكة.
// نلتقطها من الصفحة المعزولة ونبثّها له عبر أداة browser_console فتُغلق حلقة «ابنِ→عايِن→صحّح».
// مخزنان دائريّان يُصفَّران عند تنقّل الإطار الرئيسي (كي يعكسا الصفحة الحالية).
let consoleBuf = []; // {level, message, line, source}
let netErrBuf = [];  // {url, error, type}
let netReqBuf = [];  // {method, url, status, type, fromCache} — كل الطلبات (البند ب)
const LOG_CAP = 300;
const LEVELS = ['verbose', 'info', 'warning', 'error']; // ترميز Electron لـ console-message
function pushLog(arr, item) { arr.push(item); if (arr.length > LOG_CAP) arr.shift(); }
function resetLogs() { consoleBuf = []; netErrBuf = []; netReqBuf = []; }

// ---------- التسليم البشري (browser_handoff — دفعة «تحكم الوكيل الكامل» 2026-07-18) ----------
// أثناء التسليم يقود المستخدم المعاينة بيده (تسجيل دخول/2FA/بيانات حساسة) و**تُعلَّق كل
// أدوات الوكيل — رؤيةً وفعلاً — fail-closed** حتى يضغط «استلمت» (قرار مالك: الوكيل لا
// يرى ولا يفعل لحظة إدخال البيانات الحساسة). العلم هنا في الوحدة المشتركة فيغطي محرك
// SDK (أدوات agent.js) وCodex ‏(codexmcp.js يفوّض إلينا) معاً. دوال **الواجهة** (action/
// captureFrame/startPick/setBounds) لا تُحجب — المستخدم هو القائد. navigate مشتركة بين
// شريط العنوان والوكيل فتُحجب عند **موقع الأداة** في المحرّكين لا هنا.
let handoffActive = false;
let sensitiveOperation = false;
const secretTransfers = new Map();
const MAX_SECRET_TRANSFERS = 8;
const SECRET_TRANSFER_TTL_MS = 10 * 60 * 1000;
let secretRequest = null;
function startHandoff() {
  if (!currentWC()) return { ok: false, error: 'closed' };
  if (handoffActive) return { ok: false, error: 'active' };
  handoffActive = true;
  return { ok: true };
}
// نهاية التسليم (استلام/إلغاء/إيقاف الدور): تصفير سجلّي console والشبكة إلزامي — قد
// تحمل ما أُدخل أثناء التسليم (كلمة مرور في جسم طلب مُعلَّم فاشلاً مثلاً). idempotent.
function endHandoff() {
  if (!handoffActive) return { ok: true, wasActive: false };
  handoffActive = false;
  resetLogs();
  // المستخدم كان يقود الصفحة بيده طوال التسليم: refs اللقطة السابقة لم تعد موثوقة
  // (عطل مكتشف — كانت تنجو من التسليم بلا إبطال).
  invalidateSnapshotRefs();
  return { ok: true, wasActive: true };
}
function isHandoffActive() { return handoffActive; }

function pruneSecretTransfers(now) {
  const time = Number(now) || Date.now();
  for (const [id, entry] of secretTransfers) {
    if (!entry || entry.expiresAt <= time) secretTransfers.delete(id);
  }
  while (secretTransfers.size > MAX_SECRET_TRANSFERS) secretTransfers.delete(secretTransfers.keys().next().value);
}

function clearSecretTransfers() {
  secretTransfers.clear();
  return { ok: true };
}

function emit(ev) {
  if (typeof sender === 'function') { try { sender(ev); } catch (e) {} }
}

// http/https حصراً — تُستخدم في التحقق وفي حارس التنقل
function isHttpUrl(u) {
  try {
    const p = new URL(String(u));
    return (p.protocol === 'http:' || p.protocol === 'https:') && String(u).length <= 2048;
  } catch (e) { return false; }
}

// رفض كل أذونات الويب لجلسة المعاينة (مرة واحدة لكل partition — آمن للتكرار)
let permsWired = false;
function wirePermissions() {
  if (permsWired) return;
  permsWired = true;
  try {
    session.fromPartition(PARTITION).setPermissionRequestHandler((wc, permission, cb) => cb(false));
  } catch (e) {}
}

// التقاط طلبات الشبكة الفاشلة على مستوى جلسة المعاينة (مرة واحدة — مستقلة عن العرض)
let netWired = false;
function wireNetwork() {
  if (netWired) return;
  netWired = true;
  try {
    const wr = session.fromPartition(PARTITION).webRequest;
    wr.onErrorOccurred((details) => {
      if (handoffActive || sensitiveOperation) return;
      // ‏Blink يجرّب cache-only للخط قبل fallback الشبكي؛ ERR_CACHE_MISS هنا تمهيدي
      // وقد يتبعه GET ناجح. نبقيه لبقية الأنواع كي لا نخفي cache-only fetch حقيقية.
      if (!details || details.error === 'net::ERR_ABORTED'
          || (details.error === 'net::ERR_CACHE_MISS' && details.resourceType === 'font')) return;
      const entry = {
        url: String(details.url || '').slice(0, 500),
        error: String(details.error || ''),
        type: String(details.resourceType || ''),
      };
      if (memory.hasSecret(entry.url) || memory.hasSecret(entry.error)) return;
      pushLog(netErrBuf, entry);
      emit({ type: 'neterr', url: entry.url, error: entry.error, resourceType: entry.type });
    });
    // سجلّ الشبكة الكامل (البند ب): كل طلب مكتمل (لا الفاشل فقط) — للوكيل عبر
    // browser_network وللمستخدم في لوحة 🐞. نتجاهل data:/blob: (ضجيج بلا قيمة تشخيص).
    wr.onCompleted((details) => {
      if (handoffActive || sensitiveOperation) return;
      if (!details) return;
      const u = String(details.url || '');
      if (u.startsWith('data:') || u.startsWith('blob:')) return;
      const entry = {
        method: String(details.method || 'GET').slice(0, 8),
        url: u.slice(0, 500),
        status: Number(details.statusCode) || 0,
        type: String(details.resourceType || ''),
        fromCache: !!details.fromCache,
      };
      if (memory.hasSecret(entry.url)) return;
      pushLog(netReqBuf, entry);
      emit({ type: 'netreq', method: entry.method, url: entry.url, status: entry.status, resourceType: entry.type, fromCache: entry.fromCache });
    });
  } catch (e) {}
}

// تنزيلات صفحات المعاينة لا تُترك لسلوك Chromium الصامت: اسم منقّى + مسار فريد داخل
// Downloads، ثم حدث بالمسار الفعلي. partition المعاينة مستقلة فلا يلتقط هذا تسجيلات UI.
let downloadsWired = false;
function safeDownloadName(name) {
  const raw = path.basename(String(name || 'download'))
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, '_').replace(/[. ]+$/g, '').slice(0, 140);
  return raw && raw !== '.' && raw !== '..' ? raw : 'download';
}
function uniqueDownloadPath(downloadsPath, filename, exists = fs.existsSync) {
  if (typeof downloadsPath !== 'string' || !path.isAbsolute(downloadsPath)) return null;
  const safe = safeDownloadName(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(downloadsPath, index === 1 ? safe : stem + '-' + index + ext);
    if (!exists(candidate)) return candidate;
  }
  return null;
}
function wireDownloads() {
  if (downloadsWired) return;
  downloadsWired = true;
  try {
    session.fromPartition(PARTITION).on('will-download', (_event, item, webContents) => {
      if (!item || typeof item.getFilename !== 'function' || typeof item.setSavePath !== 'function') return;
      const wc = currentWC();
      if (webContents && wc && webContents.id !== wc.id) return;
      const savePath = uniqueDownloadPath(app.getPath('downloads'), item.getFilename());
      if (!savePath) {
        try { item.cancel(); } catch {}
        emit({ type: 'preview_download_failed', filename: safeDownloadName(item.getFilename()) });
        return;
      }
      item.setSavePath(savePath);
      if (typeof item.once === 'function') item.once('done', (_doneEvent, state) => {
        emit(state === 'completed'
          ? { type: 'preview_download_saved', filename: path.basename(savePath), path: savePath }
          : { type: 'preview_download_failed', filename: path.basename(savePath), state: String(state || 'unknown') });
      });
    });
  } catch {}
}

// شهادات التطوير الذاتية تُقبل لـ localhost/127.0.0.1 فقط. أي شهادة سيئة خارجية
// تُرفض صراحةً، ولا نمس webContents أخرى في التطبيق.
let certificateWired = false;
function isLocalHttpsUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch { return false; }
}
function wireCertificates() {
  if (certificateWired || !app || typeof app.on !== 'function') return;
  certificateWired = true;
  app.on('certificate-error', (event, webContents, url, _error, _certificate, callback) => {
    const wc = currentWC();
    if (!wc || !webContents || webContents.id !== wc.id) return;
    event.preventDefault();
    callback(isLocalHttpsUrl(url));
  });
}

function wireEvents(wc) {
  if (!wc || wiredWebContents.has(wc)) return;
  wiredWebContents.add(wc);
  const nav = () => emit({
    type: 'nav',
    url: wc.getURL(),
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
  });
  wc.on('did-navigate', nav);
  wc.on('did-navigate-in-page', nav);
  // عدّاد عقد اللقطة: الإدخال الملتزم من المستخدم داخل العرض المعزول. المستمع مرة واحدة
  // لكل webContents (‏wiredWebContents يحرس التكرار)، والعدّاد عام لأن المعاينة عرض واحد نشط.
  wc.on('input-event', (_event, inputEvent) => {
    if (inputEvent && COMMITTED_INPUT_TYPES.has(inputEvent.type)) userInputCounter += 1;
  });
  wc.on('page-title-updated', (e, title) => emit({ type: 'title', title: String(title || '').slice(0, 200) }));
  wc.on('did-start-loading', () => emit({ type: 'loading', loading: true }));
  wc.on('did-stop-loading', () => emit({ type: 'loading', loading: false }));
  // التقاط رسائل console الصفحة (تشمل الأخطاء غير الملتقطة): للوكيل عبر browser_console
  // (buffer) **وبثّ حيّ للواجهة** (لوحة console للمستخدم — الخيار 2).
  wc.on('console-message', (e, level, message, line, sourceId) => {
    if (handoffActive || sensitiveOperation) return;
    const entry = {
      level: Number(level) || 0,
      message: String(message || '').slice(0, 2000),
      line: Number(line) || 0,
      source: String(sourceId || '').slice(0, 300),
    };
    if (memory.hasSecret(entry.message) || memory.hasSecret(entry.source)) return;
    pushLog(consoleBuf, entry);
    emit({ type: 'console', levelLabel: LEVELS[entry.level] || 'log', message: entry.message, line: entry.line, source: entry.source });
  });
  // تصفير السجلّ عند تنقّل الإطار الرئيسي لصفحة جديدة (لا للتنقّل داخل الصفحة) — يعكس الحالية
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (isMainFrame) invalidateSnapshotRefs(wc);
    if (isMainFrame && !isInPlace) { resetLogs(); emit({ type: 'console_clear' }); }
  });
  // فشل التحميل الرئيسي فقط (-3 = أُجهض بتنقل جديد — ليس خطأ)
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) emit({ type: 'failed', code, desc: String(desc || ''), url: String(url || '') });
  });
  // حالة DevTools (البند أ): نبثّها كي يعكس زرّ اللوحة الفتح/الإغلاق حتى لو أغلقها
  // المستخدم من نافذة DevTools مباشرة (نافذة منفصلة mode:'detach' — لا طبقة فوق pvBox).
  wc.on('devtools-opened', () => emit({ type: 'devtools', open: true }));
  wc.on('devtools-closed', () => emit({ type: 'devtools', open: false }));
  // نافذة منبثقة (target=_blank…): لا نوافذ — رابط http/https يُفتح في نفس العرض
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) { try { wc.loadURL(url); } catch (e) {} }
    return { action: 'deny' };
  });
  // حارس التنقل: http/https حصراً (يمنع file:// وjavascript: وغيرهما)
  wc.on('will-navigate', (e, url) => { if (!isHttpUrl(url)) e.preventDefault(); });
}

function ensureView(win, send) {
  hostWin = win;
  sender = send;
  // تعويض المرآة يعتمد على عرض محتوى النافذة، فتغيّر الحجم وحده قد يُبطل الإحداثي
  // حتى لو لم يتغيّر مستطيل اللوحة المُبلَّغ — نعيد التطبيق هنا. (مرة واحدة لكل نافذة)
  if (isRtlUi() && !resizeWired.has(win)) {
    resizeWired.add(win);
    win.on('resize', () => { if (lastBounds) applyBounds(lastBounds); });
  }
  if (view && view.webContents && !view.webContents.isDestroyed()) return view;
  wirePermissions();
  wireNetwork();
  wireDownloads();
  wireCertificates();
  view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: PARTITION,
      // لا preload — الصفحة المعروضة لا ترى أي واجهة لـ «سطر»
    },
  });
  view.setBackgroundColor('#ffffff'); // المواقع تفترض خلفية فاتحة قبل رسم أنماطها
  wireEvents(view.webContents);
  win.contentView.addChildView(view);
  if (lastBounds) applyBounds(lastBounds);
  return view;
}

// فتح المعاينة على عنوان (تُنشأ الـ view عند أول فتح بعد كل إغلاق — دورة حياة بسيطة)
function open(win, send, url) {
  if (!isHttpUrl(url)) return { error: 'bad_url' };
  const external = externalWC();
  if (external) {
    sender = send;
    try { external.loadURL(String(url)); } catch (e) { return { error: 'load_failed' }; }
    return { ok: true };
  }
  const v = ensureView(win, send);
  try { v.webContents.loadURL(String(url)); } catch (e) { return { error: 'load_failed' }; }
  return { ok: true };
}

function navigate(url) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  if (!isHttpUrl(url)) return { error: 'bad_url' };
  try { wc.loadURL(String(url)); } catch (e) { return { error: 'load_failed' }; }
  return { ok: true };
}

function action(name) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const h = wc.navigationHistory;
  try {
    if (name === 'back') { if (h ? h.canGoBack() : wc.canGoBack()) (h ? h.goBack() : wc.goBack()); }
    else if (name === 'forward') { if (h ? h.canGoForward() : wc.canGoForward()) (h ? h.goForward() : wc.goForward()); }
    else if (name === 'reload') wc.reload();
    // DevTools حقيقية للعرض المعزول (البند أ): زرّ toggle. نافذة **منفصلة** (mode:'detach')
    // تتجنّب قيد الطفو فوق pvBox — لا تختبئ خلف العرض الأصلي. تعمل على الصفحة المعروضة
    // نفسها فيفحص المستخدم شبكتها/عناصرها/console بأدوات Chromium الكاملة.
    else if (name === 'devtools') {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
    }
    // مسح تخزين الصفحة (البند د): كوكيز + cache + localStorage/IndexedDB لـ partition
    // المعاينة، ثم إعادة تحميل كي تبدأ الصفحة بحالة نظيفة (اختبار أول زيارة/تسجيل خروج).
    else if (name === 'clear_storage') {
      try {
        session.fromPartition(PARTITION).clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'shadercache'],
        }).then(() => { try { wc.reload(); } catch (e) {} }).catch(() => {});
      } catch (e) {}
    }
    // محاكاة الشبكة (البند د): تعيد نتيجة setNetwork (قد تفشل إن كانت DevTools مفتوحة)
    else if (name === 'net_online' || name === 'net_offline' || name === 'net_slow' || name === 'net_fast') {
      return setNetwork(name);
    }
  } catch (e) {}
  return { ok: true };
}

// ---------- محاكاة شبكة بطيئة (البند د) ----------
// عبر CDP Network.emulateNetworkConditions (يُبقي debugger مرفقاً ما دامت المحاكاة فعّالة).
// **حدّ موثّق**: DevTools تحتجز عميل debugger الوحيد — إن كانت مفتوحة تعذّرت المحاكاة من
// هنا (استعمل تبويب Network في DevTools نفسها حينها). net_online يُوقف المحاكاة ويفصل.
const NET_PRESETS = {
  net_offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  net_slow: { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },   // ~Slow 3G
  net_fast: { offline: false, latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },  // ~Fast 3G
};
let netThrottled = false; // هل debugger مرفق للمحاكاة الآن؟
function setNetwork(preset) {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const dbg = wc.debugger;
  try {
    if (preset === 'net_online') {
      // إيقاف المحاكاة: أعِد الظروف الطبيعية ثم افصل debugger
      if (netThrottled) {
        try { dbg.sendCommand('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch (e) {}
        try { dbg.detach(); } catch (e) {}
        netThrottled = false;
      }
      return { ok: true, preset: 'net_online' };
    }
    const cond = NET_PRESETS[preset];
    if (!cond) return { error: 'bad_preset' };
    if (!dbg.isAttached || !dbg.isAttached()) { dbg.attach('1.3'); }
    dbg.sendCommand('Network.enable').catch(() => {});
    dbg.sendCommand('Network.emulateNetworkConditions', cond).catch(() => {});
    netThrottled = true;
    return { ok: true, preset };
  } catch (e) {
    // DevTools مفتوحة غالباً (عميل debugger محجوز) — سقوط رشيق
    return { error: 'throttle_unavailable' };
  }
}

// الواجهة تبلّغ مستطيل مساحة العرض داخل النافذة (تقيسه بـ getBoundingClientRect)
function effectiveBounds(bounds) {
  if (!viewportOverride || !bounds) return bounds;
  const width = Math.max(1, Math.min(bounds.width, viewportOverride.width));
  const height = viewportOverride.height
    ? Math.max(1, Math.min(bounds.height, viewportOverride.height)) : bounds.height;
  return {
    x: bounds.x + Math.max(0, Math.floor((bounds.width - width) / 2)),
    y: bounds.y,
    width,
    height,
  };
}
// ── تعويض مرآة RTL (بلاغ مستخدم + مسبار حي scripts/rtl-bounds-probe.js) ──────
// حين تكون لغة واجهة التطبيق RTL (نظام المستخدم بالعربية) يعكس Chromium إحداثي x
// لطبقة العرض الأصلي: يضعه عند contentWidth − x − width بدل x، فيطفو العرض فوق
// المحادثة بينما إطار اللوحة في مكانه. أثبته المسبار على Electron 33:
//   en-US: x=0→0 و x=400→400  ·  ar: x=0→584 و x=400→184 (‏contentWidth=784)
// المستطيل الذي تبلّغه الواجهة صحيح دائماً؛ التعويض هنا وحده — نعكسه مسبقاً
// فيصل إلى موضعه الفعلي. القائمة تطابق لغات RTL التي يعتمدها Chromium.
const RTL_UI_LANGS = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'nqo']);
let rtlUiCache = null;
function isRtlUi() {
  if (rtlUiCache === null) {
    let base = '';
    try { base = String(app.getLocale() || '').toLowerCase().split(/[-_]/)[0]; } catch { base = ''; }
    rtlUiCache = RTL_UI_LANGS.has(base);
  }
  return rtlUiCache;
}

// يحوّل مستطيل الواجهة (منطقي) إلى المستطيل الذي يجب تمريره لـsetBounds فعلياً.
function nativeBounds(b) {
  if (!b || !isRtlUi() || !(b.width > 0)) return b;
  let contentWidth = 0;
  try { if (hostWin && !hostWin.isDestroyed()) contentWidth = hostWin.getContentBounds().width; } catch { contentWidth = 0; }
  if (!(contentWidth > 0)) return b; // بلا عرض معلوم لا نخمّن — نبقي السلوك كما هو
  return { ...b, x: Math.max(0, Math.round(contentWidth - b.x - b.width)) };
}

function applyBounds(b) {
  if (view && view.webContents && !view.webContents.isDestroyed()) view.setBounds(nativeBounds(effectiveBounds(b)));
}

function setBounds(b) {
  lastBounds = b;
  applyBounds(b);
  return { ok: true };
}

// ---------- التحديد بالتأشير (م-2) ----------
// نحقن سكربتاً في الصفحة المعزولة عبر executeJavaScript يعيد Promise يُحلّ عند نقر
// المستخدم على عنصر (أو Escape ⇒ null). لا preload في العرض (معزول) فهذا المسار الوحيد
// لإخراج بيانات العنصر: قيمة الـ Promise تعود مباشرة لـ executeJavaScript. العنصر
// يُلتقط بـ outerHTML مقتطع + نص + selector تقريبي — يكفي النموذج ليجده بـ Grep في المصدر.
// **أمان**: outerHTML من صفحة غير موثوقة ⇒ يُغلَّف كـ «محتوى» في القشرة ويُقتطع (حقن
// برومبت محتمل موثّق في ROADMAP — م-2 وصف فقط بلا أفعال تلقائية، والمستخدم يبادر ويرسل).
const PICK_SCRIPT = `(function(){
  return new Promise(function(resolve){
    if (window.__satrPick) { try { window.__satrPick.cleanup(); } catch(e){} }
    var box = document.createElement('div');
    box.setAttribute('data-satr-pick','1');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #D9A441;background:rgba(217,164,65,.14);border-radius:2px;transition:left .04s,top .04s,width .04s,height .04s;';
    document.documentElement.appendChild(box);
    var current = null;
    function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); } catch(e){ return s; } }
    function cssPath(el){
      if (el.id) return '#' + esc(el.id);
      var parts = [], e = el, guard = 0;
      while (e && e.nodeType === 1 && guard++ < 5) {
        if (e.id) { parts.unshift('#' + esc(e.id)); break; }
        var sel = e.tagName.toLowerCase();
        if (e.classList && e.classList.length)
          sel += '.' + Array.prototype.slice.call(e.classList, 0, 2).map(esc).join('.');
        var par = e.parentElement;
        if (par) {
          var same = Array.prototype.filter.call(par.children, function(c){ return c.tagName === e.tagName; });
          if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
        }
        parts.unshift(sel);
        e = e.parentElement;
      }
      return parts.join(' > ');
    }
    function describe(el){
      var html = '';
      try { html = el.outerHTML || ''; } catch(e){}
      if (html.length > 600) html = html.slice(0, 600) + '…';
      var text = '';
      try { text = (el.textContent || '').replace(/\\s+/g, ' ').trim(); } catch(e){}
      if (text.length > 140) text = text.slice(0, 140) + '…';
      // فحص محسّن (البند ج): box-model + أبرز الأنماط المحسوبة — يراها المستخدم قبل الإرسال
      // وتُمرَّر للوكيل في سياق الطلب فيعرف الحالة الحالية بلا قراءة CSS يدوياً.
      var box = null, styles = null;
      try {
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        box = {
          w: Math.round(r.width), h: Math.round(r.height),
          pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(function(v){ return parseFloat(v) || 0; }),
          mar: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(function(v){ return parseFloat(v) || 0; }),
          bord: parseFloat(cs.borderTopWidth) || 0,
        };
        var idAttr = el.id ? '#' + el.id : '';
        var clsAttr = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (typeof el.className === 'string' ? el.className : '');
        styles = {
          id: idAttr,
          cls: clsAttr ? String(clsAttr).trim().split(/\\s+/).slice(0, 6).join(' ') : '',
          display: cs.display, position: cs.position,
          color: cs.color, background: cs.backgroundColor,
          font: (parseFloat(cs.fontSize) || 0) + 'px ' + (cs.fontWeight || '') + ' ' + (cs.fontFamily || '').split(',')[0].replace(/["']/g, ''),
        };
      } catch(e){}
      return { selector: cssPath(el), tag: el.tagName.toLowerCase(), html: html, text: text, box: box, styles: styles };
    }
    function move(e){
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box) return;
      current = el;
      var r = el.getBoundingClientRect();
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    }
    function pick(e){
      var el = current || document.elementFromPoint(e.clientX, e.clientY);
      e.preventDefault(); e.stopPropagation();
      var data = el ? describe(el) : null;
      cleanup(); resolve(data);
    }
    function swallow(e){ e.preventDefault(); e.stopPropagation(); } // يمنع تفعيل الروابط/الأزرار
    function key(e){ if (e.key === 'Escape') { cleanup(); resolve(null); } }
    function cleanup(){
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', pick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('pointerdown', swallow, true);
      document.removeEventListener('keydown', key, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      window.__satrPick = null;
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('pointerdown', swallow, true);
    document.addEventListener('keydown', key, true);
    window.__satrPick = { cleanup: cleanup, cancel: function(){ cleanup(); resolve(null); } };
  });
})()`;

async function startPick() {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return { error: 'closed' };
  // التأشير يسلّم الصفحة للمستخدم لينقر عنصراً: refs اللقطة السابقة تسقط معه
  // (العطل الثاني المكتشف — كان وضع التحديد لا يبطلها).
  invalidateSnapshotRefs();
  try {
    const pick = await view.webContents.executeJavaScript(PICK_SCRIPT, true);
    return { ok: true, pick: pick || null }; // null = أُلغي (Escape/إلغاء)
  } catch (e) { return { error: 'pick_failed' }; }
}

// إلغاء وضع التحديد من الواجهة (زر «تحديد» ثانيةً أو إغلاق) — يحلّ الـ Promise بـ null
async function cancelPick() {
  if (view && view.webContents && !view.webContents.isDestroyed()) {
    try { await view.webContents.executeJavaScript('window.__satrPick && window.__satrPick.cancel && window.__satrPick.cancel()', true); } catch (e) {}
  }
  return { ok: true };
}

// ---------- أدوات قراءة الصفحة للوكيل (م-3) ----------
// يستهلكها خادم MCP الداخلي في agent.js (preview.js موديول مشترك بين العمليتين مثل
// term.js — نفس نسخة الـ view). العرض تُنشئه القشرة عبر open_preview؛ هذه الأدوات
// تعمل على الـ view القائمة (قراءة فقط — لا أفعال، م-4 خلف بوابة قرار مستقلة).
// **أمان**: المحتوى المُستخرَج من صفحة غير موثوقة ⇒ نصّ مغلّف يقرؤه النموذج (حقن
// برومبت محتمل موثّق — قراءة فقط، الوكيل يطلبه عمداً ليفحص).
function currentWC() {
  return externalWC() || ((view && view.webContents && !view.webContents.isDestroyed()) ? view.webContents : null);
}

function externalWC() {
  if (typeof externalTargetProvider !== 'function') return null;
  try {
    const wc = externalTargetProvider();
    return wc && !wc.isDestroyed() ? wc : null;
  } catch { return null; }
}

function setExternalTargetProvider(provider, send) {
  invalidateSnapshotRefs();
  externalTargetProvider = typeof provider === 'function' ? provider : null;
  if (typeof send === 'function') sender = send;
  const wc = externalWC();
  if (wc) {
    wirePermissions();
    wireNetwork();
    wireDownloads();
    wireCertificates();
    wireEvents(wc);
  }
  return { ok: true };
}

function attachExternalWebContents(wc) {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'closed' };
  invalidateSnapshotRefs();
  wirePermissions();
  wireNetwork();
  wireDownloads();
  wireCertificates();
  wireEvents(wc);
  return { ok: true };
}

function currentUrl() {
  const wc = currentWC();
  return wc ? wc.getURL() : null;
}

function navigationTarget(direction) {
  const wc = currentWC();
  if (!wc || !wc.navigationHistory || typeof wc.navigationHistory.getAllEntries !== 'function') return null;
  try {
    const entries = wc.navigationHistory.getAllEntries();
    const active = wc.navigationHistory.getActiveIndex();
    const index = direction === 'back' ? active - 1 : direction === 'forward' ? active + 1 : -1;
    return entries[index] && entries[index].url ? String(entries[index].url) : null;
  } catch {
    return null;
  }
}

// ---------- مصدر واحد لحلّ الهدف داخل الصفحة (كان مكرراً نصياً في أربعة عشر سكربتاً) ----------
// الهدف إمّا ref لقطة (‏sN:eN ⇒ سمة data-satr-ref) أو مُحدِّد CSS، أو الرمزان الخاصان
// __active__ (العنصر المركّز) و__page__ (جذر المستند — للوميض على الصفحة كلها).
// مُحدِّد فارغ أو فاسد يجعل querySelector يرمي، وكل مستدعٍ يلتقط ويعيد bad_selector —
// وهو سلوك النسخ الأربع عشرة قبل التوحيد حرفياً (المسارات التي كانت تعيد null للفارغ
// غير قابلة للوصول من العملية الرئيسية لأن cleanLocator يرفض الفارغ قبلها).
const RESOLVE_SRC = `function resolve(l){
  if(l==='__active__')return document.activeElement;
  if(l==='__page__')return document.documentElement;
  l=String(l==null?'':l);
  if(/^s[1-9][0-9]*:e[1-9][0-9]*$/.test(l))return document.querySelector('[data-satr-ref="'+l+'"]');
  return document.querySelector(l);
}`;

// ---------- دلالات اللقطة المشتركة: الدور والاسم والبصمة ----------
// مصدر واحد لـ vis()/name()/role() تستهلكه لقطة العناصر (SNAPSHOT_FN) ومسبار DOM delta
// (PROBE_BEGIN_FN) وحارس الهدف في العالم المعزول — فلا تنجرف الحسابات الثلاثة عن بعضها.
// البصمة = role + name + tag + (href للروابط أو type للحقول/الأزرار حيث وُجدا)، بتطبيع
// **فراغات فقط** (لا حذف أرقام: «حذف 1» ≠ «حذف 100»). tuple كاملة بلا hash — الاسم مسقوف
// بـ120 محرفاً أصلاً، وتصادم hash قصير خطر بلا مقابل.
// **حدّ مصرَّح به**: البصمة **كاشف انجراف لا برهان أمني** — صفحة عدائية تقدر أن تستنسخ
// دور واسم عنصر آخر. غايتها أن يفشل الفعل مغلقاً حين تتبدّل الصفحة تحت ref قديمة.
const SEMANTICS_SRC = `function clean(s){ return String(s || '').replace(/\\s+/g, ' ').trim(); }
function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); } catch(e){ return String(s); } }
function vis(el){
  if (!el || el.nodeType !== 1) return false;
  var s; try { s = getComputedStyle(el); } catch(e){ return false; }
  if (!s || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
  var r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1;
}
function name(el){
  var n = el.getAttribute && el.getAttribute('aria-label');
  if (n && clean(n)) return clean(n);
  var lb = el.getAttribute && el.getAttribute('aria-labelledby');
  if (lb) { var t = ''; lb.split(/\\s+/).forEach(function(id){ var e = document.getElementById(id); if (e) t += ' ' + (e.textContent || ''); }); if (clean(t)) return clean(t); }
  var tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    var ph = el.getAttribute('placeholder'); if (ph) return clean(ph);
    if (el.id) { var l; try { l = document.querySelector('label[for="' + esc(el.id) + '"]'); } catch(e){} if (l && clean(l.textContent)) return clean(l.textContent); }
    var nm = el.getAttribute('name'); if (nm) return clean(nm);
    return '';
  }
  if (tag === 'img') return clean(el.getAttribute('alt'));
  if (tag === 'textarea') return clean(el.getAttribute('placeholder') || el.getAttribute('name'));
  if (tag === 'select') return clean(el.getAttribute('name') || el.getAttribute('aria-label'));
  return clean(el.textContent).slice(0, 120);
}
function role(el){
  var r = el.getAttribute && el.getAttribute('role'); if (r) return clean(r);
  var tag = el.tagName.toLowerCase();
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    var t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    return 'textbox';
  }
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return tag;
}
function fingerprint(el){
  if (!el || el.nodeType !== 1) return '';
  var tag = el.tagName.toLowerCase(), extra = '';
  try {
    if (tag === 'a') extra = clean(el.getAttribute('href'));
    else if (tag === 'input' || tag === 'button') extra = clean(el.getAttribute('type'));
  } catch(e){}
  return role(el) + '\\u001f' + name(el) + '\\u001f' + tag + '\\u001f' + extra;
}
var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';`;

// حارس الهدف: يحل ref/مُحدِّداً ثم يقارن البصمة المتوقعة (التي حفظتها العملية الرئيسية
// لحظة اللقطة) بالمحسوبة الآن، فيمنع الفعل على عنصر تبدّل تحته. يعمل داخل العالم المعزول
// في نداء واحد مع التنفيذ — فلا تُترك نافذة بين الحل والفعل، ولا تخرّبه الصفحة.
// غياب المتوقعة (مُحدِّد CSS بلا لقطة) يُبقي السلوك القديم: not_found بدل ref_removed.
const TARGET_GUARD_SRC = `${RESOLVE_SRC}
${SEMANTICS_SRC}
function guard(loc, expect){
  var el; try { el = resolve(loc); } catch(e){ return { err: { ok:false, reason:'bad_selector' } }; }
  if (!el) return { err: { ok:false, reason: expect ? 'ref_removed' : 'not_found' } };
  if (expect) { var now = fingerprint(el); if (now !== expect) return { err: { ok:false, reason:'target_changed', was: expect, now: now } }; }
  return { el: el };
}`;

// هدف الفعل الأمني: النقر على رابط/زر إرسال يُنسب إلى وجهة الرابط أو form action لا
// إلى الصفحة الحالية فقط، كي لا يقفز فعل معفى من origin موثوق إلى origin جديد بصمت.
const ACTION_TARGET_FN = `function(name,loc){
  ${RESOLVE_SRC}
  var el;try{el=resolve(loc||'__active__');}catch(e){return null;}if(!el)return location.href;
  if(name==='browser_click'){
    var anchor=el.closest&&el.closest('a[href]');if(anchor&&anchor.href)return anchor.href;
    var form=el.form||(el.closest&&el.closest('form'));if(form&&form.action)return form.action;
  }
  if(name==='browser_press_key'){
    var active=document.activeElement,activeForm=active&&(active.form||(active.closest&&active.closest('form')));if(activeForm&&activeForm.action)return activeForm.action;
  }
  return location.href;
}`;
const ACTION_CONTEXT_FN = `function(name,input){
  ${RESOLVE_SRC}
  var bare=String(name||'').replace(/^mcp__satr-terminal__/,''),data=input&&typeof input==='object'?input:{},el=null;
  try{el=resolve(bare==='browser_press_key'?'__active__':data.ref||data.selector||'__active__');}catch(e){return {currentUrl:location.href,badSelector:true};}
  var form=el&&(el.form||(el.closest&&el.closest('form'))),target=location.href,formAction='',formMethod='';
  if(el){var anchor=el.closest&&el.closest('a[href]');if(anchor&&anchor.href)target=anchor.href;}
  if(form){formAction=form.action||location.href;formMethod=String(form.method||'get').toLowerCase();target=formAction;}
  var type=el&&el.getAttribute?String(el.getAttribute('type')||'').toLowerCase():'',tag=el&&el.tagName?el.tagName.toLowerCase():'';
  var text='';try{text=((el&&el.textContent)||'').replace(/\\s+/g,' ').trim().slice(0,160);}catch(e){}
  var aria='';try{aria=String((el&&el.getAttribute&&el.getAttribute('aria-label'))||'').replace(/\\s+/g,' ').trim().slice(0,160);}catch(e){}
  var isSubmit=!!el&&((!!form&&(type==='submit'||(tag==='button'&&(!type||type==='submit'))))||(el.getAttribute&&el.getAttribute('role')==='button'&&/submit/i.test(aria||text)));
  var cross=false;try{cross=!!form&&formMethod==='post'&&new URL(formAction,location.href).origin!==location.origin;}catch(e){}
  return {currentUrl:location.href,targetUrl:target,tag:tag,type:type,elementText:text,ariaLabel:aria,inForm:!!form,isSubmit:isSubmit,formAction:formAction,formMethod:formMethod,crossOriginPost:cross};
}`;

async function browserActionContext(name, input) {
  if (handoffActive) return null;
  const wc = currentWC();
  if (!wc) return null;
  const inputError = browserInputError(name, input, wc) || leaseError();
  if (inputError) return { currentUrl: wc.getURL(), targetUrl: wc.getURL(), error: inputError };
  try {
    return await wc.executeJavaScript('(' + ACTION_CONTEXT_FN + ')(' + JSON.stringify(String(name || '')) + ',' + JSON.stringify(input || {}) + ')', true);
  } catch { return { currentUrl: wc.getURL() }; }
}
async function browserTarget(name, input) {
  if (handoffActive) return null;
  const wc = currentWC();
  if (!wc) return null;
  if (browserInputError(name, input, wc)) return wc.getURL();
  const bare = String(name || '').replace(/^mcp__satr-terminal__/, '');
  if (bare !== 'browser_click' && bare !== 'browser_press_key') return wc.getURL();
  const locator = bare === 'browser_press_key' ? '__active__' : input && input.ref;
  try {
    const target = await wc.executeJavaScript('(' + ACTION_TARGET_FN + ')(' + JSON.stringify(bare) + ',' + JSON.stringify(String(locator || '')) + ')', true);
    return isHttpUrl(target) ? target : wc.getURL();
  } catch { return wc.getURL(); }
}

// انتظار انتهاء أي تحميل جارٍ (open_preview قبله بلحظة) بمهلة — كي يقرأ الوكيل بعد الجهوز
function waitReady(wc, ms) {
  if (!wc.isLoadingMainFrame || !wc.isLoadingMainFrame()) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, ms || 8000);
    wc.once('did-stop-loading', () => { clearTimeout(t); res(); });
  });
}

// سكربت استخراج snapshot نصي مفيد للنموذج: عنوان + روابط + عناوين + أزرار + نص الجسم
const READ_SCRIPT = `(function(){
  function txt(el){ try { return (el.textContent||'').replace(/\\s+/g,' ').trim(); } catch(e){ return ''; } }
  function q(sel){ try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch(e){ return []; } }
  var headings = q('h1,h2,h3,h4').slice(0,40).map(function(h){ return h.tagName.toLowerCase()+': '+txt(h).slice(0,120); }).filter(function(x){ return x.split(': ')[1]; });
  var links = q('a[href]').slice(0,50).map(function(a){ var t=txt(a).slice(0,60); return (t||'(بلا نص)')+' → '+a.getAttribute('href'); });
  var buttons = q('button,[role=button],input[type=submit],input[type=button]').slice(0,40).map(function(b){ return (txt(b)||b.value||'').slice(0,60); }).filter(Boolean);
  var inputs = q('input,textarea,select').slice(0,30).map(function(i){ return (i.tagName.toLowerCase())+(i.type?('['+i.type+']'):'')+(i.name?(' name='+i.name):'')+(i.placeholder?(' ph="'+i.placeholder.slice(0,40)+'"'):''); });
  var body = txt(document.body).slice(0, 4000);
  return { title: document.title, url: location.href, headings: headings, links: links, buttons: buttons, inputs: inputs, bodyText: body };
})()`;

async function readPage() {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const data = await wc.executeJavaScript(READ_SCRIPT, true);
    return { ok: true, page: data };
  } catch (e) { return { error: 'read_failed' }; }
}

// سجلّ الـ console وأخطاء الشبكة الملتقطة للصفحة الحالية (لا executeJavaScript — بثّ حيّ).
// LEVELS يترجم ترميز Electron، والأخطاء تُبرَز أولاً في العرض ليركّز عليها الوكيل.
function getConsole() {
  if (handoffActive) return { error: 'handoff' };
  if (!currentWC()) return { error: 'closed' };
  const logs = consoleBuf.slice(-150).map((l) => ({
    level: LEVELS[l.level] || 'log',
    message: l.message,
    line: l.line,
    source: l.source,
  }));
  return { ok: true, logs, netErrors: netErrBuf.slice(-80) };
}

// سجلّ الشبكة الكامل للصفحة الحالية (البند ب): كل الطلبات المكتملة + الفاشلة. للوكيل
// عبر browser_network (تشخيص: أي طلب رجع 404/500، أو لم يُطلب أصلاً). بثّ حيّ — لا executeJavaScript.
function getNetwork() {
  if (handoffActive) return { error: 'handoff' };
  if (!currentWC()) return { error: 'closed' };
  return { ok: true, requests: netReqBuf.slice(-150), netErrors: netErrBuf.slice(-80) };
}

// ---------- لقطة شجرة الوصول بمُعرّفات ثابتة (ترقية أفعال المتصفح 2026-07-12) ----------
// نمط Playwright MCP / browser-use المعتمد صناعياً: بدل أن يخمّن النموذج مُحدِّد CSS من
// outerHTML (هشّ)، يأخذ **لقطة مدمجة** لكل عنصر تفاعلي فيها `role "name" [ref=sN:eN]`، ثم
// يتصرّف بـ ref حتمياً (browser_click/type يقبلان ref). نسِم كل عنصر بـ data-satr-ref="sN:eN"
// فيُحلّ الفعل عبر [data-satr-ref="sN:eN"] بلا تخمين. التنقّل أو اللقطة التالية يبطلان الجيل؛
// أما التغيّر الموضعي فيعيد DOM delta محدودة وقد يمنح refs جديدة متزايدة صالحة ضمن الجيل نفسه.
// كفاءة رموز: ~مئات مقابل
// آلاف للـDOM الخام. صفر اعتماديات، بلا preload (يطابق عزل العرض) — كله executeJavaScript.
const SNAPSHOT_FN = `function(generation){
  ${SEMANTICS_SRC}
  try { Array.prototype.forEach.call(document.querySelectorAll('[data-satr-ref]'), function(e){ e.removeAttribute('data-satr-ref'); }); } catch(e){}
  var els; try { els = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch(e){ els = []; }
  var out = [], fps = {}, n = 0, CAP = 200, prefix = 's' + generation + ':e';
  for (var i = 0; i < els.length && out.length < CAP; i++) {
    var el = els[i];
    if (!vis(el)) continue;
    var ref = prefix + (++n);
    try { el.setAttribute('data-satr-ref', ref); } catch(e){ continue; }
    var nm = name(el);
    var line = '[' + ref + '] ' + role(el) + (nm ? ' "' + nm.replace(/"/g, "'") + '"' : '');
    if (el.disabled) line += ' (معطّل)';
    out.push(line);
    fps[ref] = fingerprint(el);
  }
  return { title: document.title, url: location.href, generation: generation, count: out.length, elements: out, truncated: out.length >= CAP, fps: fps };
}`;

async function snapshot() {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  const generation = nextSnapshotGeneration(wc);
  try {
    const data = await wc.executeJavaScript('(' + SNAPSHOT_FN + ')(' + generation + ')', true);
    if (activeSnapshotGeneration === generation && activeSnapshotOwnerId === wc.id) {
      activeSnapshotNextIndex = Math.max(0, Number(data && data.count) || 0);
      activeSnapshotTextBytes = Buffer.byteLength(((data && data.elements) || []).join('\n'), 'utf8');
      rememberFingerprints(data && data.fps);
    }
    // البصمات داخلية بحتة: نبني اللقطة المعادة بقائمة حقول مغلقة فلا تعبر إلى النموذج.
    return { ok: true, snap: {
      title: data && data.title, url: data && data.url, generation,
      count: (data && data.count) || 0, elements: (data && data.elements) || [],
      truncated: !!(data && data.truncated),
    } };
  } catch (e) {
    if (activeSnapshotGeneration === generation) invalidateSnapshotRefs(wc);
    return { error: 'snapshot_failed' };
  }
}

// انتظار ظهور نص أو عنصر (selector) في الصفحة بمهلة — للصفحات الديناميكية (SPA/بعد فعل).
// استقصاء دوري عبر executeJavaScript (بلا globals في الصفحة). يعيد {ok, found}.
const WAIT_FN = `function(opt){
  try {
    if (opt.selector) return { found: !!document.querySelector(opt.selector) };
    if (opt.text) return { found: ((document.body && document.body.innerText) || '').indexOf(opt.text) !== -1 };
  } catch(e){ return { found: false, err: 1 }; }
  return { found: false };
}`;

async function waitFor(cond, timeoutMs) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const c = cond || {};
  if (!c.text && !c.selector) return { error: 'bad_condition' };
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 8000, 500), 30000);
  const arg = JSON.stringify({ text: c.text ? String(c.text).slice(0, 200) : '', selector: c.selector ? String(c.selector) : '' });
  while (Date.now() < deadline) {
    try {
      const r = await wc.executeJavaScript('(' + WAIT_FN + ')(' + arg + ')', true);
      if (r && r.err) return { error: 'bad_condition' };
      if (r && r.found) return { ok: true, found: true };
    } catch (e) {}
    await new Promise((res) => setTimeout(res, 250));
  }
  return { ok: true, found: false };
}

function emitScreenshotThumbnail(image, kind, locator) {
  try {
    if (!image || image.isEmpty()) return;
    const size = image.getSize();
    const thumb = size.width > 360 ? image.resize({ width: 360, quality: 'good' }) : image;
    const data = thumb.toPNG();
    if (!data || !data.length || data.length > 512 * 1024) return;
    emit({
      type: 'agent_screenshot', kind: String(kind || 'page'),
      locator: locator ? String(locator).slice(0, 500) : '',
      dataUrl: 'data:image/png;base64,' + data.toString('base64'),
    });
  } catch {}
}

// جسر تكامل الدفعة (بند «مذكور لا منفَّذ» في تقرير منفّذ ب): الأغلفة تطلب قياس
// طول الصفحة داخل نداء اللقطة نفسه كي تلحق تلميح «الصفحة أطول من المعروض —
// خذ full_page:true» (بند مالك — لوحة سطر أضيق من متصفح عادي). فشل القياس لا
// يفشل اللقطة — التلميح تحسين لا شرط.
async function screenshot(options) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    let pageMetrics;
    if (options && options.includePageMetrics) {
      try {
        pageMetrics = await wc.executeJavaScript(
          '({content_height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), viewport_height: window.innerHeight})', true);
      } catch { pageMetrics = undefined; }
    }
    const img = await wc.capturePage();
    const png = img.toPNG();
    if (!png || !png.length) return { error: 'empty' };
    emitScreenshotThumbnail(img, 'page');
    return { ok: true, base64: png.toString('base64'), page_metrics: pageMetrics };
  } catch (e) { return { error: 'shot_failed' }; }
}

// لقطة عنصر واحد بـ ref/selector (البند 4): فحص بصري مركّز أرخص رموزاً من الصفحة كاملة.
// يمرّر العنصر لنافذة العرض ثم يعيد مستطيله (إحداثيات viewport = DIP عند zoom=1) لـ capturePage.
const RECT_FN = `function(loc){
  ${RESOLVE_SRC}
  var el; try { el = resolve(loc); } catch(e){ return {err:'bad_selector'}; }
  if (!el) return {err:'not_found'};
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){}
  var r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return {err:'not_visible'};
  return {x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height)};
}`;

async function screenshotElement(locator, options) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const inputError = locatorError(locator, wc);
  if (inputError) return { error: inputError };
  await waitReady(wc);
  try {
    const rect = await wc.executeJavaScript('(' + RECT_FN + ')(' + JSON.stringify(String(locator)) + ')', true);
    if (!rect || rect.err) return { error: (rect && rect.err) || 'rect_failed' };
    await new Promise((res) => setTimeout(res, 150)); // مهلة كي يكتمل التمرير قبل الالتقاط
    const img = await wc.capturePage({
      x: rect.x, y: rect.y,
      width: Math.min(rect.width, 4000), height: Math.min(rect.height, 4000),
    });
    const png = img.toPNG();
    if (!png || !png.length) return { error: 'empty' };
    if (!options || options.emitThumbnail !== false) emitScreenshotThumbnail(img, 'element', locator);
    return { ok: true, base64: png.toString('base64') };
  } catch (e) { return { error: 'shot_failed' }; }
}

// لقطة الصفحة **كاملةً** (بالتمرير — لا نافذة العرض فقط): عبر CDP
// Page.captureScreenshot بـ captureBeyondViewport، لقطة واحدة للمحتوى القابل للتمرير كلّه.
// سقف ارتفاع 20000px (أداء/رموز)، وسقوط للقطة العادية إن تعذّر CDP. scale:1 ⇒ 1 CSS px = 1 بكسل.
const MAX_FULL_HEIGHT = 20000;
async function screenshotFull() {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  const dbg = wc.debugger;
  let attached = false;
  try {
    try { dbg.attach('1.3'); attached = true; } catch (e) { attached = dbg.isAttached && dbg.isAttached(); }
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize || {};
    const width = Math.max(1, Math.ceil(size.width || 0));
    const height = Math.min(Math.max(1, Math.ceil(size.height || 0)), MAX_FULL_HEIGHT);
    const clip = { x: 0, y: 0, width, height, scale: 1 };
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip,
    });
    if (!shot || !shot.data) return { error: 'empty' };
    try { emitScreenshotThumbnail(nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')), 'full_page'); } catch {}
    return { ok: true, base64: shot.data, truncated: height >= MAX_FULL_HEIGHT };
  } catch (e) {
    // سقوط رشيق للقطة نافذة العرض العادية إن فشل مسار CDP
    try {
      const img = await wc.capturePage();
      const png = img.toPNG();
      if (png && png.length) {
        emitScreenshotThumbnail(img, 'page');
        return { ok: true, base64: png.toString('base64'), fellBack: true };
      }
    } catch (e2) {}
    return { error: 'shot_failed' };
  } finally {
    if (attached) { try { dbg.detach(); } catch (e) {} }
  }
}

// ---------- أدوات الفعل في المعاينة (م-4 + ترقية ref 2026-07-12 — خلف إذن إلزامي) ----------
// الهدف (loc) إمّا **ref حتمي** من browser_snapshot (مثل s3:e5 ⇒ [data-satr-ref="s3:e5"]) أو
// مُحدِّد CSS (تراجع للتوافق مع م-4). يُهرَّب بـ JSON.stringify — لا حقن.
// **الأمان (حرج)**: أدوات agent.js تمرّ بـ canUseTool مثل Bash — مربع الإذن العربي كل
// مرة، bypassPermissions وحده يعفيها (لا acceptEdits). الإذن اليدوي لكل فعل أقوى من
// قائمة نطاقات (يعفي فعلاً لا نطاقاً) فلم تلزم. الكتابة عبر native value setter
// ليلتقطها React/Vue (input/change events)، والنقر el.click() بعد scrollIntoView.
// resolve: ref (^sN:eN$) ⇒ سمة data-satr-ref؛ غيره ⇒ querySelector (قد يرمي ⇒ bad_selector).
const FLASH_FN = `function(loc){
  ${RESOLVE_SRC}
  var el; try { el=resolve(loc); } catch(e){ return {ok:false,reason:'bad_selector'}; }
  if(!el) return {ok:false,reason:'not_found'};
  try { if(loc!=='__page__') el.scrollIntoView({block:'center',inline:'center'}); } catch(e){}
  var old=document.querySelector('[data-satr-agent-flash]'); if(old) old.remove();
  var r=loc==='__page__'?{left:4,top:4,width:Math.max(1,innerWidth-8),height:Math.max(1,innerHeight-8)}:el.getBoundingClientRect();
  var box=document.createElement('div'); box.setAttribute('data-satr-agent-flash','1');
  box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #D9A441;border-radius:5px;background:rgba(217,164,65,.12);box-shadow:0 0 0 3px rgba(217,164,65,.20);transition:opacity .35s;';
  box.style.left=Math.max(0,r.left)+'px'; box.style.top=Math.max(0,r.top)+'px'; box.style.width=Math.max(1,r.width)+'px'; box.style.height=Math.max(1,r.height)+'px';
  document.documentElement.appendChild(box); setTimeout(function(){box.style.opacity='0';},850); setTimeout(function(){box.remove();},1250);
  return {ok:true};
}`;
const PROBE_BEGIN_FN = `function(opt){
  ${SEMANTICS_SRC}
  try{var old=window.__satrActionProbe;if(old){if(old.ob)old.ob.disconnect();removeEventListener('hashchange',old.nav);removeEventListener('popstate',old.nav);if(old.timer)clearTimeout(old.timer);if(old.resolve)old.resolve(old.payload?old.payload():{count:old.count||0,url:location.href});}}catch(e){}
  var generation=Math.max(0,Number(opt&&opt.generation)||0),prefix=generation?'s'+generation+':e':'',nextIndex=Math.max(0,Number(opt&&opt.nextIndex)||0);
  var p={count:0,url:location.href,generation:generation,nextIndex:nextIndex,delta:[],deltaChars:0,deltaTruncated:false,seen:{},fps:{},fpCount:0,resolve:null,timer:null};
  p.payload=function(){return{count:p.count||0,url:location.href,generation:p.generation,nextIndex:p.nextIndex,delta:p.delta.slice(),deltaTruncated:!!p.deltaTruncated,fps:p.fps};};
  // كل ref يراها الوكيل في delta تُبصم لحظة توليدها (‏+ الجديدة و~ المتغيّرة) وإلا انفتح
  // مسار غير محمي داخل الجيل نفسه. المحذوفة (‏-) لا تُبصم وتبقى بصمتها القديمة في العملية
  // الرئيسية كي يشخّص الفعل التالي عليها ref_removed بدل not_found العامة.
  p.add=function(kind,el,ref){if(!ref||p.seen[kind+ref])return;p.seen[kind+ref]=1;if(kind!=='-'&&p.fpCount<200){if(!(ref in p.fps))p.fpCount++;p.fps[ref]=fingerprint(el);}var nm=name(el),line=kind+' ['+ref+'] '+role(el)+(nm?' "'+nm.replace(/"/g,"'")+'"':'');if(el.disabled)line+=' (معطّل)';if(p.delta.length>=40||p.deltaChars+line.length>4000){p.deltaTruncated=true;return;}p.delta.push(line);p.deltaChars+=line.length+1;};
  p.notify=function(){if(!p.resolve)return;var done=p.resolve;p.resolve=null;if(p.timer)clearTimeout(p.timer);p.timer=null;done(p.payload());};p.nav=function(){p.notify();};
  function refs(node){var out=[];if(!node||node.nodeType!==1)return out;if(node.hasAttribute&&node.hasAttribute('data-satr-ref'))out.push(node);try{out=out.concat([].slice.call(node.querySelectorAll('[data-satr-ref]')));}catch(e){}return out;}
  function interactives(node){var out=[];if(!node||node.nodeType!==1)return out;try{if(node.matches(SEL))out.push(node);out=out.concat([].slice.call(node.querySelectorAll(SEL)));}catch(e){}return out;}
  function activeRef(el){var ref=el&&el.getAttribute&&el.getAttribute('data-satr-ref');return ref&&prefix&&ref.indexOf(prefix)===0?ref:'';}
  p.ob=new MutationObserver(function(records){records.forEach(function(r){
    if(r.type==='attributes'&&r.attributeName==='data-satr-ref')return;
    var t=r.target&&r.target.nodeType===1?r.target:r.target&&r.target.parentElement;
    if(t&&((t.matches&&t.matches('[data-satr-agent-flash]'))||(t.closest&&t.closest('[data-satr-agent-flash]'))))return;
    var nodes=[].slice.call(r.addedNodes||[]).concat([].slice.call(r.removedNodes||[]));
    if(nodes.length&&nodes.every(function(x){return x.nodeType===1&&x.matches&&x.matches('[data-satr-agent-flash]');}))return;
    p.count++;
    [].slice.call(r.removedNodes||[]).forEach(function(node){refs(node).forEach(function(el){var ref=activeRef(el);if(ref)p.add('-',el,ref);});});
    [].slice.call(r.addedNodes||[]).forEach(function(node){interactives(node).forEach(function(el){if(!vis(el))return;var ref=activeRef(el),kind='~';if(!ref&&generation){ref=prefix+(++p.nextIndex);try{el.setAttribute('data-satr-ref',ref);}catch(e){return;}kind='+';}if(ref)p.add(kind,el,ref);});});
    if(!r.addedNodes||!r.addedNodes.length){var changed=t&&t.closest?t.closest('[data-satr-ref]'):null,changedRef=activeRef(changed);if(changedRef)p.add('~',changed,changedRef);}
  });if(p.count)p.notify();});
  p.ob.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});addEventListener('hashchange',p.nav);addEventListener('popstate',p.nav);window.__satrActionProbe=p;return{url:p.url,generation:p.generation,nextIndex:p.nextIndex};
}`;
const ACTION_OBSERVE_TIMEOUT_MS = 360;
const PROBE_WAIT = `(function(ms){var p=window.__satrActionProbe;if(!p)return Promise.resolve({count:0,url:location.href,delta:[]});if(p.count>0||location.href!==p.url)return Promise.resolve(p.payload());return new Promise(function(resolve){p.resolve=resolve;p.timer=setTimeout(function(){if(p.resolve===resolve)p.resolve=null;p.timer=null;resolve(p.payload());},ms);});})(${ACTION_OBSERVE_TIMEOUT_MS})`;
const PROBE_END = `(function(){var p=window.__satrActionProbe;if(!p)return {count:0,url:location.href,delta:[]};try{p.ob.disconnect();removeEventListener('hashchange',p.nav);removeEventListener('popstate',p.nav);}catch(e){}if(p.timer)clearTimeout(p.timer);var payload=p.payload();if(p.resolve){var done=p.resolve;p.resolve=null;done(payload);}window.__satrActionProbe=null;return payload;})()`;

function actionProbeExpression(wc) {
  const active = wc && wc.id === activeSnapshotOwnerId && activeSnapshotGeneration > 0;
  const input = { generation: active ? activeSnapshotGeneration : 0, nextIndex: active ? activeSnapshotNextIndex : 0 };
  return '(' + PROBE_BEGIN_FN + ')(' + JSON.stringify(input) + ')';
}

function boundActionDelta(lines, alreadyTruncated) {
  const source = Array.isArray(lines) ? lines.map((line) => String(line || '').slice(0, 500)).filter(Boolean) : [];
  source.sort((left, right) => {
    const rank = (line) => line.startsWith('+ ') ? 0 : line.startsWith('~ ') ? 1 : 2;
    return rank(left) - rank(right);
  });
  const byteLimit = Math.min(1600, Math.floor(activeSnapshotTextBytes * 0.25));
  const delta = [];
  let used = 0;
  let truncated = !!alreadyTruncated;
  for (const line of source) {
    const bytes = Buffer.byteLength((delta.length ? '\n' : '') + line, 'utf8');
    if (used + bytes > byteLimit) { truncated = true; break; }
    delta.push(line);
    used += bytes;
  }
  return { delta, truncated };
}

// الوميض تجميلي لا أمني: يبقى في main world، **وفشله لا يوقف الفعل**. كان قبل هذه الدفعة
// يعمل مدقّقاً مسبقاً للهدف (يعيد not_found/bad_selector فيقطع الفعل)، وذلك يجعل صفحةً
// تخرّب document.querySelector قادرةً على تعطيل الوكيل. الحارس في العالم المعزول هو
// السلطة الآن، وهو يعيد الرمزين نفسيهما فالمخرَج للنموذج لم يتغيّر.
async function flashLocator(wc, locator) {
  try { return await wc.executeJavaScript('(' + FLASH_FN + ')(' + JSON.stringify(String(locator)) + ')', true); }
  catch { return { ok: false, reason: 'flash_failed' }; }
}

// معرّف العالم المعزول لأفعال الوكيل. أثبت المسبار الحاجز أنه — على WebContents نفسه —
// يقرأ DOM سليماً ويرى سمات data-satr-ref الموسومة من main world، حتى حين تخرّب الصفحة
// document.querySelector وEventTarget.prototype.addEventListener؛ وglobals العالم المعزول
// محجوبة عن الصفحة. لذلك يجري حل الهدف ومقارنة البصمة والتنفيذ فيه في نداء واحد.
const AGENT_WORLD_ID = 1013;

function runIsolated(wc, expression) {
  if (typeof wc.executeJavaScriptInIsolatedWorld !== 'function') {
    return wc.executeJavaScript(expression, true); // سقوط رشيق لبناء لا يعلن الـAPI
  }
  return wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: expression }], true);
}

// تركيب نداء الفعل المحروس: (‏loc, expect, …وسائط الفعل) — expect من خريطة البصمات الداخلية.
function guardedExpression(fnSource, locator, wc, ...args) {
  const values = [String(locator), expectedFingerprint(locator, wc)].concat(args);
  return '(' + fnSource + ')(' + values.map((value) => JSON.stringify(value)).join(',') + ')';
}

// أسباب التنازع تُترجم هنا مرة واحدة: تُبثّ للواجهة، ويُحوَّل وسم البصمة إلى نص مقروء.
function actionFailure(result) {
  const reason = (result && result.reason) || 'action_failed';
  if (reason === 'target_changed') {
    return conflictError(reason, { was: fingerprintLabel(result.was), now: fingerprintLabel(result.now) });
  }
  if (reason === 'ref_removed') return conflictError(reason);
  const extra = result && Number.isInteger(result.index) ? { index: result.index } : null;
  return extra ? { error: reason, ...extra } : { error: reason };
}

async function observedResult(wc, beforeUrl, actionResult) {
  let observedCount = 0;
  let observedUrl = beforeUrl;
  let observedProbe = null;
  // postcondition معلوم ومحقَّق (‏type/select) ⇒ لا انتظار: النتيجة صادقة بلا نافذة الرصد.
  if (!actionResult.changed && !actionResult.satisfied) {
    try {
      const pageWait = wc.executeJavaScript(PROBE_WAIT, true).catch(() => null);
      let mainTimer;
      const mainWait = new Promise((resolve) => { mainTimer = setTimeout(() => resolve(null), ACTION_OBSERVE_TIMEOUT_MS); });
      const signaled = await Promise.race([pageWait, mainWait]);
      clearTimeout(mainTimer);
      if (signaled) {
        observedCount = Number(signaled.count) || 0;
        observedUrl = signaled.url || observedUrl;
        observedProbe = signaled;
      }
    } catch {}
  }
  let probe = observedProbe || { count: observedCount, url: observedUrl, delta: [] };
  try {
    const ended = await wc.executeJavaScript(PROBE_END, true);
    if (ended) probe = { ...ended, count: Math.max(observedCount, Number(ended.count) || 0), url: ended.url || observedUrl };
  } catch {}
  let currentUrl = observedUrl;
  try { currentUrl = wc.getURL(); } catch {}
  const navigated = currentUrl !== beforeUrl || probe.url !== beforeUrl;
  const domChanged = !!actionResult.changed || Number(probe.count) > 0;
  let delta = [];
  let deltaTruncated = false;
  if (!navigated && wc.id === activeSnapshotOwnerId && Number(probe.generation) === activeSnapshotGeneration) {
    activeSnapshotNextIndex = Math.max(activeSnapshotNextIndex, Number(probe.nextIndex) || 0);
    rememberFingerprints(probe.fps);
    const bounded = boundActionDelta(probe.delta, probe.deltaTruncated);
    delta = bounded.delta;
    deltaTruncated = bounded.truncated;
  }
  // دلالة صادقة: dispatched أن الفعل أُرسل، effect_observed أن أثراً رُصد فعلاً،
  // وsatisfied حيث postcondition معلوم فقط. dom_changed يبقى كما هو للتوافق الخلفي.
  return {
    ...actionResult, ok: true, navigated,
    dispatched: true, effect_observed: domChanged, dom_changed: domChanged,
    delta: delta.length ? delta : undefined,
    delta_truncated: deltaTruncated || undefined,
    note: !navigated && !domChanged
      ? 'نُفِّذ الفعل ولم يُرصد أثر في DOM أو التنقّل — لا تكرره لمجرد ذلك؛ تحقق بلقطة أو browser_wait_for إن كنت تتوقع أثراً.'
      : undefined,
  };
}

async function observeScript(wc, expression) {
  const beforeUrl = wc.getURL();
  // المسبار يبقى في main world (المراقب يرى تحوّلات DOM أياً كان العالم الذي أحدثها)،
  // والفعل نفسه في العالم المعزول مع حارسه.
  try { await wc.executeJavaScript(actionProbeExpression(wc), true); } catch {}
  try {
    const result = await runIsolated(wc, expression);
    if (!result || !result.ok) {
      try { await wc.executeJavaScript(PROBE_END, true); } catch {}
      return actionFailure(result);
    }
    return observedResult(wc, beforeUrl, result);
  } catch {
    if (wc.getURL() !== beforeUrl) return { ok: true, navigated: true, dom_changed: false, note: 'انتقلت الصفحة أثناء الفعل.' };
    try { await wc.executeJavaScript(PROBE_END, true); } catch {}
    return { error: 'action_failed' };
  }
}

const CLICK_FN = `function(loc, expect){
  ${TARGET_GUARD_SRC}
  var g = guard(loc, expect); if (g.err) return g.err;
  var el = g.el;
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){}
  try { el.click(); } catch(e){ return {ok:false, reason:'click_error'}; }
  return {ok:true, tag: el.tagName.toLowerCase(), text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80)};
}`;
const TYPE_FN = `function(loc, expect, text){
  ${TARGET_GUARD_SRC}
  var g = guard(loc, expect); if (g.err) return g.err;
  var el = g.el;
  var before = '';
  try {
    el.focus();
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      before = el.value;
      var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    } else if (el.isContentEditable) {
      before = el.innerHTML;
      var selection = getSelection(), range = document.createRange();
      range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
      var beforeInput = new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType:'insertText', data:text});
      if (el.dispatchEvent(beforeInput)) {
        var inserted = false;
        try { inserted = document.execCommand('insertText', false, text); } catch(e){}
        if (!inserted) el.textContent = text;
      }
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
    } else { return {ok:false, reason:'not_editable'}; }
  } catch(e){ return {ok:false, reason:'type_error'}; }
  var after = el.isContentEditable ? el.innerHTML : el.value;
  var value = el.isContentEditable ? (el.textContent || '') : el.value;
  return {ok:true, tag: el.tagName.toLowerCase(), changed: after !== before, satisfied: value === String(text)};
}`;

async function clickElement(locator) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const inputError = locatorError(locator, wc);
  if (inputError) return { error: inputError };
  const leased = leaseGate();
  if (leased) return leased;
  await waitReady(wc);
  await flashLocator(wc, locator);
  const r = await observeScript(wc, guardedExpression(CLICK_FN, locator, wc));
  return r.error === 'action_failed' ? { error: 'click_failed' } : r;
}

async function typeText(locator, text) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const inputError = locatorError(locator, wc);
  if (inputError) return { error: inputError };
  const leased = leaseGate();
  if (leased) return leased;
  await waitReady(wc);
  await flashLocator(wc, locator);
  const r = await observeScript(wc, guardedExpression(TYPE_FN, locator, wc, String(text)));
  return r.error === 'action_failed' ? { error: 'type_failed' } : r;
}

// ---------- إعداد المنصات: تعبئة جماعية ونقل أسرار بلا رؤية الوكيل ----------
// fillForm لا يقبل سراً ويعيد عدد الحقول فقط. transferField يقرأ القيمة داخل العرض؛
// في الصفحة نفسها لا تخرج القيمة حتى للعملية الرئيسية، وبين صفحتين تحفظ مؤقتاً تحت
// معرّف مبهم ثم تُمسح بعد اللصق/نهاية المهمة. لا نتيجة أو حدث يحمل القيمة.
const FILL_FIELDS_FN = `function(fields){
  ${TARGET_GUARD_SRC}
  function writable(el){return !!el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable);}
  function set(el,value){el.focus();if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc&&desc.set)desc.set.call(el,value);else el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}else{el.textContent=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}}
  var resolved=[];for(var i=0;i<fields.length;i++){var g=guard(fields[i].ref,fields[i].expect||'');if(g.err){g.err.index=i;return g.err;}if(!writable(g.el))return {ok:false,reason:'not_editable',index:i};resolved.push(g.el);}
  for(var j=0;j<resolved.length;j++)set(resolved[j],String(fields[j].value));
  return {ok:true,filled:resolved.length};
}`;
const TRANSFER_SAME_FN = `function(fromLoc,fromExpect,toLoc,toExpect){
  ${TARGET_GUARD_SRC}
  function read(el){if(el.tagName==='INPUT'||el.tagName==='TEXTAREA')return el.value;if(el.isContentEditable)return el.textContent||'';return null;}
  function write(el,value){if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc&&desc.set)desc.set.call(el,value);else el.value=value;el.setAttribute('data-satr-secret-field','1');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}if(el.isContentEditable){el.textContent=value;el.setAttribute('data-satr-secret-field','1');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));return true;}return false;}
  var gf=guard(fromLoc,fromExpect);if(gf.err)return gf.err;var gt=guard(toLoc,toExpect);if(gt.err)return gt.err;
  var from=gf.el,to=gt.el,value=read(from);if(value===null)return {ok:false,reason:'not_readable'};from.setAttribute('data-satr-secret-field','1');if(!write(to,value))return {ok:false,reason:'not_editable'};return {ok:true,moved:true};
}`;
const TRANSFER_READ_FN = `function(loc,expect){${TARGET_GUARD_SRC}var g=guard(loc,expect);if(g.err)return g.err;var el=g.el;var value=(el.tagName==='INPUT'||el.tagName==='TEXTAREA')?el.value:(el.isContentEditable?(el.textContent||''):null);if(value===null)return {ok:false,reason:'not_readable'};el.setAttribute('data-satr-secret-field','1');return {ok:true,value:String(value)};}`;
const TRANSFER_WRITE_FN = `function(loc,expect,value){${TARGET_GUARD_SRC}var g=guard(loc,expect);if(g.err)return g.err;var el=g.el;if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc&&desc.set)desc.set.call(el,value);else el.value=value;el.setAttribute('data-satr-secret-field','1');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,moved:true};}if(el.isContentEditable){el.textContent=value;el.setAttribute('data-satr-secret-field','1');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));return {ok:true,moved:true};}return {ok:false,reason:'not_editable'};}`;

function cleanLocator(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 1000 && !/[\u0000-\u001F\u007F]/.test(text) ? text : '';
}

async function fillForm(fields) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  if (!Array.isArray(fields) || !fields.length || fields.length > 20) return { error: 'bad_fields' };
  let total = 0;
  const cleaned = [];
  for (const field of fields) {
    const ref = cleanLocator(field && (field.ref || field.selector));
    const value = typeof (field && field.value) === 'string' ? field.value : '';
    total += value.length;
    if (!ref || value.length > 4000 || total > 16000) return { error: 'bad_fields' };
    const inputError = locatorError(ref, wc);
    if (inputError) return { error: inputError, index: cleaned.length };
    if (memory.hasSecret(value)) return { error: 'secret' };
    cleaned.push({ ref, value, expect: expectedFingerprint(ref, wc) });
  }
  const leased = leaseGate();
  if (leased) return leased;
  await waitReady(wc);
  try {
    const result = await runIsolated(wc, '(' + FILL_FIELDS_FN + ')(' + JSON.stringify(cleaned) + ')');
    return result && result.ok
      ? { ok: true, filled: result.filled, dispatched: true }
      : actionFailure(result || { reason: 'fill_failed' });
  } catch { return { error: 'fill_failed' }; }
}

async function transferField(fromLocator, toLocator, transferId) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const fromRef = cleanLocator(fromLocator);
  const toRef = cleanLocator(toLocator);
  const token = typeof transferId === 'string' && /^xfer_[a-f0-9]{32}$/.test(transferId) ? transferId : '';
  if ((!fromRef || !toRef) && !(fromRef && !toRef && !token) && !(!fromRef && toRef && token)) return { error: 'bad_input' };
  const inputError = locatorError(fromRef, wc) || locatorError(toRef, wc);
  if (inputError) return { error: inputError };
  const leased = leaseGate();
  if (leased) return leased;
  await waitReady(wc);
  sensitiveOperation = true;
  try {
    if (fromRef && toRef) {
      const result = await runIsolated(wc, '(' + TRANSFER_SAME_FN + ')(' + JSON.stringify(fromRef) + ','
        + JSON.stringify(expectedFingerprint(fromRef, wc)) + ',' + JSON.stringify(toRef) + ','
        + JSON.stringify(expectedFingerprint(toRef, wc)) + ')');
      return result && result.ok ? { ok: true, moved: true, dispatched: true } : actionFailure(result || { reason: 'transfer_failed' });
    }
    if (fromRef) {
      const result = await runIsolated(wc, guardedExpression(TRANSFER_READ_FN, fromRef, wc));
      if (result && !result.ok && (result.reason === 'target_changed' || result.reason === 'ref_removed')) return actionFailure(result);
      if (!result || !result.ok || typeof result.value !== 'string' || !result.value || result.value.length > 32768) {
        return { error: (result && result.reason) || 'empty_source' };
      }
      pruneSecretTransfers();
      const id = 'xfer_' + crypto.randomBytes(16).toString('hex');
      secretTransfers.set(id, { value: result.value, expiresAt: Date.now() + SECRET_TRANSFER_TTL_MS });
      pruneSecretTransfers();
      return { ok: true, moved: false, stored: true, transfer_id: id };
    }
    pruneSecretTransfers();
    const entry = secretTransfers.get(token);
    if (!entry) return { error: 'transfer_expired' };
    const result = await runIsolated(wc, guardedExpression(TRANSFER_WRITE_FN, toRef, wc, entry.value));
    if (result && result.ok) secretTransfers.delete(token);
    return result && result.ok ? { ok: true, moved: true, dispatched: true } : actionFailure(result || { reason: 'transfer_failed' });
  } catch { return { error: 'transfer_failed' }; }
  finally {
    sensitiveOperation = false;
    resetLogs();
    emit({ type: 'console_clear' });
  }
}

const SECRET_MARK_FN = `function(loc,expect){${TARGET_GUARD_SRC}var g=guard(loc,expect);if(g.err)return g.err;var el=g.el;if(!(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable))return {ok:false,reason:'not_editable'};try{el.scrollIntoView({block:'center',inline:'center'});el.focus();el.setAttribute('data-satr-secret-field','1');var old=document.querySelector('[data-satr-secret-request]');if(old)old.remove();var r=el.getBoundingClientRect(),box=document.createElement('div');box.setAttribute('data-satr-secret-request','1');box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #D9A441;border-radius:5px;box-shadow:0 0 0 4px rgba(217,164,65,.22);';box.style.left=Math.max(0,r.left)+'px';box.style.top=Math.max(0,r.top)+'px';box.style.width=Math.max(1,r.width)+'px';box.style.height=Math.max(1,r.height)+'px';document.documentElement.appendChild(box);}catch(e){}return {ok:true};}`;
// تنظيف بعد إدخال المستخدم للسر: **بلا حارس بصمة عمداً** — الحقل تغيّر بفعل المستخدم
// نفسه وهذا هو المقصود، والدالة لا تنفّذ فعلاً للوكيل بل تزيل الوسم وتعلن هل مُلئ.
const SECRET_DONE_FN = `function(loc){${RESOLVE_SRC}var el=null;try{el=resolve(loc);}catch(e){}var box=document.querySelector('[data-satr-secret-request]');if(box)box.remove();if(!el)return {ok:false,filled:false};var value=(el.tagName==='INPUT'||el.tagName==='TEXTAREA')?el.value:(el.isContentEditable?(el.textContent||''):'');el.setAttribute('data-satr-secret-field','1');return {ok:true,filled:String(value||'').length>0};}`;

async function requestSecret(locator, reason) {
  const wc = currentWC();
  const ref = cleanLocator(locator);
  const why = typeof reason === 'string' ? reason.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 300) : '';
  if (!wc) return { error: 'closed' };
  if (!ref || !why || memory.hasSecret(why)) return { error: 'bad_input' };
  const inputError = locatorError(ref, wc);
  if (inputError) return { error: inputError };
  const leased = leaseGate();
  if (leased) return leased;
  if (secretRequest || handoffActive) return { error: 'active' };
  const expect = expectedFingerprint(ref, wc);
  const state = startHandoff();
  if (!state.ok) return { error: state.error };
  sensitiveOperation = true;
  let marked;
  try { marked = await runIsolated(wc, '(' + SECRET_MARK_FN + ')(' + JSON.stringify(ref) + ',' + JSON.stringify(expect) + ')'); }
  catch { marked = null; }
  finally { sensitiveOperation = false; }
  if (!marked || !marked.ok) { endHandoff(); return actionFailure(marked || { reason: 'request_failed' }); }
  const id = 'secret_' + crypto.randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    secretRequest = { id, ref, resolve };
    emit({ type: 'secret_request', id, reason: why });
  });
}

async function resolveSecretRequest(id, done) {
  const pending = secretRequest;
  if (!pending || pending.id !== id || typeof done !== 'boolean') return { ok: false };
  secretRequest = null;
  let filled = false;
  sensitiveOperation = true;
  try {
    const wc = currentWC();
    const result = wc ? await wc.executeJavaScript('(' + SECRET_DONE_FN + ')(' + JSON.stringify(pending.ref) + ')', true) : null;
    filled = !!(done && result && result.ok && result.filled);
  } catch { filled = false; }
  finally {
    sensitiveOperation = false;
    endHandoff();
    emit({ type: 'secret_end', id });
  }
  pending.resolve(filled ? { ok: true, filled: true } : { ok: false, filled: false, error: done ? 'empty' : 'cancelled' });
  return { ok: true };
}

function cancelSecretRequest() {
  if (!secretRequest) return { ok: true, active: false };
  const id = secretRequest.id;
  resolveSecretRequest(id, false).catch(() => {});
  return { ok: true, active: true };
}

function clearSensitiveState() {
  clearSecretTransfers();
  cancelSecretRequest();
  return { ok: true };
}

// ---------- إكمال طقم الأفعال (البند 2) — قائمة منسدلة/مفتاح/تمرير/تحويم ----------
// select/hover يُحلّان الهدف بنفس منطق ref-أو-selector (resolve مضمّن). press_key عبر
// sendInputEvent (أحداث مفاتيح حقيقية موثوقة — تُرسل للعرض المعزول وحده، فتُطلق سلوك
// النموذج الأصلي مثل إرسال النموذج بـ Enter، بعكس الحدث المُصطنع غير الموثوق).
const SELECT_FN = `function(loc, expect, val){
  ${TARGET_GUARD_SRC}
  var g = guard(loc, expect); if (g.err) return g.err;
  var el = g.el;
  if (el.tagName !== 'SELECT') return {ok:false, reason:'not_select'};
  var opts = Array.prototype.slice.call(el.options), match = null, i;
  for (i=0;i<opts.length;i++){ if (opts[i].value === val){ match = opts[i]; break; } }
  if (!match) for (i=0;i<opts.length;i++){ if ((opts[i].textContent||'').replace(/\\s+/g,' ').trim() === val){ match = opts[i]; break; } }
  if (!match) return {ok:false, reason:'no_option'};
  var before = el.value;
  el.value = match.value;
  el.dispatchEvent(new Event('input', {bubbles:true}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
  return {ok:true, label: (match.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80), changed: el.value !== before, satisfied: el.value === match.value};
}`;
const HOVER_FN = `function(loc, expect){
  ${TARGET_GUARD_SRC}
  var g = guard(loc, expect); if (g.err) return g.err;
  var el = g.el;
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){}
  try {
    var r = el.getBoundingClientRect();
    var opt = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
    el.dispatchEvent(new MouseEvent('mouseover', opt));
    el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:false, clientX:opt.clientX, clientY:opt.clientY}));
    el.dispatchEvent(new MouseEvent('mousemove', opt));
  } catch(e){ return {ok:false, reason:'hover_error'}; }
  return {ok:true, tag: el.tagName.toLowerCase()};
}`;
const SCROLL_FN = `function(dir, amount){
  var before = window.scrollY || document.documentElement.scrollTop || 0;
  var amt = amount || Math.round((window.innerHeight || 600) * 0.9);
  if (dir === 'top') window.scrollTo(0, 0);
  else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
  else if (dir === 'up') window.scrollBy(0, -amt);
  else window.scrollBy(0, amt);
  var after = window.scrollY || document.documentElement.scrollTop || 0;
  return {ok:true, scrollY: Math.round(after), moved: Math.round(after - before), max: Math.round(document.documentElement.scrollHeight)};
}`;

async function selectOption(locator, value) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const inputError = locatorError(locator, wc);
  if (inputError) return { error: inputError };
  const leased = leaseGate();
  if (leased) return leased;
  await waitReady(wc);
  await flashLocator(wc, locator);
  const r = await observeScript(wc, guardedExpression(SELECT_FN, locator, wc, String(value)));
  return r.error === 'action_failed' ? { error: 'select_failed' } : r;
}

async function hover(locator) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const inputError = locatorError(locator, wc);
  if (inputError) return { error: inputError };
  const leased = leaseGate();
  if (leased) return leased;
  await waitReady(wc);
  await flashLocator(wc, locator);
  try {
    const r = await runIsolated(wc, guardedExpression(HOVER_FN, locator, wc));
    return r && r.ok ? { ok: true, tag: r.tag, dispatched: true } : actionFailure(r || { reason: 'hover_failed' });
  } catch (e) { return { error: 'hover_failed' }; }
}

async function scroll(direction, amount) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  const dir = ['up', 'down', 'top', 'bottom'].indexOf(String(direction)) >= 0 ? String(direction) : 'down';
  const amt = Number(amount) > 0 ? Math.min(Number(amount), 20000) : 0;
  await flashLocator(wc, '__page__');
  try {
    const r = await wc.executeJavaScript('(' + SCROLL_FN + ')(' + JSON.stringify(dir) + ',' + JSON.stringify(amt) + ')', true);
    return r && r.ok ? { ok: true, scrollY: r.scrollY, moved: r.moved, max: r.max } : { error: 'scroll_failed' };
  } catch (e) { return { error: 'scroll_failed' }; }
}

// أحداث مفاتيح حقيقية عبر sendInputEvent (على العنصر المركّز في العرض المعزول). خريطة
// أسماء ودّية → keyCodes Electron. الحصر بقائمة بيضاء (لا حروف عامة — الكتابة عبر browser_type).
const KEY_MAP = {
  Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
async function pressKey(key) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const code = KEY_MAP[String(key)];
  if (!code) return { error: 'bad_key' };
  // العقد يُفحص قبل الإرسال؛ وبعده يرتفع العدّاد من مسار الإدخال نفسه فيستهلك العقد —
  // فالضغطة التالية تحتاج لقطة جديدة (مقصود: عقد input-event بلا provenance).
  const leased = leaseGate();
  if (leased) return leased;
  await flashLocator(wc, '__active__');
  const beforeUrl = wc.getURL();
  try { await wc.executeJavaScript(actionProbeExpression(wc), true); } catch {}
  try {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
  } catch (e) { return { error: 'press_failed' }; }
  return observedResult(wc, beforeUrl, { ok: true, key: String(key) });
}

// JavaScript تشخيصي خلف بوابة origin. السقف يحمي السياق، وCDP timeout يوقف التنفيذ
// المتزامن الطويل بدلاً من ترك executeJavaScript معلّقاً. النتيجة تُعاد by-value فقط.
async function evaluate(expression) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const expr = typeof expression === 'string' ? expression.trim() : '';
  if (!expr || expr.length > 8000) return { error: 'bad_expression' };
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached || !dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
    const source = `(async function(expr){
      function clean(value){
        if(value===undefined)return 'undefined';
        if(typeof value==='string')return value;
        try{return JSON.stringify(value,function(key,item){if(typeof item==='bigint')return String(item)+'n';if(typeof item==='function')return '[Function]';return item;},2);}catch(e){return String(value);}
      }
      var value=await Promise.race([Promise.resolve().then(function(){return (0,eval)(expr);}),new Promise(function(_,reject){setTimeout(function(){reject(new Error('timeout'));},3000);})]);
      return clean(value);
    })(${JSON.stringify(expr)})`;
    const result = await dbg.sendCommand('Runtime.evaluate', {
      expression: source, awaitPromise: true, returnByValue: true, timeout: 3500,
    });
    if (result && result.exceptionDetails) return { error: 'evaluate_failed', message: String(result.exceptionDetails.text || 'JavaScript error').slice(0, 1000) };
    const value = result && result.result ? result.result.value : undefined;
    const text = String(value == null ? value : value);
    if (memory.hasSecret(text)) return { error: 'secret_result', message: 'حُجبت النتيجة لأنها قد تحتوي سراً؛ استخدم browser_transfer_field بدلاً من قراءتها.' };
    return { ok: true, value: text.slice(0, 48 * 1024), truncated: text.length > 48 * 1024 };
  } catch (error) {
    try { if (dbg.isAttached && dbg.isAttached()) await dbg.sendCommand('Runtime.terminateExecution'); } catch {}
    return { error: 'evaluate_failed', message: String((error && error.message) || error).slice(0, 1000) };
  } finally {
    if (attachedHere) { try { dbg.detach(); } catch {} }
  }
}

async function setViewport(width, height) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const w = Number(width), h = height == null ? null : Number(height);
  if (!Number.isInteger(w) || w < 240 || w > 1920
      || (h != null && (!Number.isInteger(h) || h < 240 || h > 1200))) return { error: 'bad_viewport' };
  viewportOverride = { width: w, height: h };
  if (view && lastBounds) applyBounds(lastBounds);
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    const actual = await wc.executeJavaScript('({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio})', true);
    return { ok: true, requested: { width: w, height: h }, actual };
  } catch { return { error: 'viewport_failed' }; }
}

async function perf() {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  await waitReady(wc);
  try {
    const data = await wc.executeJavaScript(`(function(){
      var nav=performance.getEntriesByType('navigation')[0];
      var resources=performance.getEntriesByType('resource').map(function(r){return {name:r.name.slice(0,500),type:r.initiatorType||'',duration:Math.round(r.duration),transferSize:Number(r.transferSize)||0,decodedSize:Number(r.decodedBodySize)||0};}).sort(function(a,b){return b.duration-a.duration;}).slice(0,12);
      return {url:location.href,navigation:nav?{dns:Math.round(nav.domainLookupEnd-nav.domainLookupStart),connect:Math.round(nav.connectEnd-nav.connectStart),ttfb:Math.round(nav.responseStart-nav.requestStart),domContentLoaded:Math.round(nav.domContentLoadedEventEnd-nav.startTime),load:Math.round(nav.loadEventEnd-nav.startTime),transferSize:Number(nav.transferSize)||0}:null,resources:resources};
    })()`, true);
    return { ok: true, perf: data, failed_requests: netReqBuf.filter((item) => item.status >= 400 || item.status === 0).slice(-20) };
  } catch { return { error: 'perf_failed' }; }
}

async function historyNavigate(direction) {
  if (handoffActive) return { error: 'handoff' };
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  const history = wc.navigationHistory;
  const canGo = direction === 'back'
    ? (history ? history.canGoBack() : wc.canGoBack())
    : (history ? history.canGoForward() : wc.canGoForward());
  if (!canGo) return { ok: true, navigated: false, dom_changed: false, note: direction === 'back' ? 'لا يوجد سجل رجوع.' : 'لا يوجد سجل تقدّم.' };
  const before = wc.getURL();
  try { direction === 'back' ? (history ? history.goBack() : wc.goBack()) : (history ? history.goForward() : wc.goForward()); }
  catch { return { error: 'navigation_failed' }; }
  await Promise.race([
    new Promise((resolve) => wc.once('did-navigate', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1800)),
  ]);
  return { ok: true, navigated: wc.getURL() !== before, dom_changed: false, url: wc.getURL() };
}

function back() { return historyNavigate('back'); }
function forward() { return historyNavigate('forward'); }

// ---------- التقاط إطار للتسجيل (م-5) ----------
// المكوّن يطلب إطاراً دورياً (~8/ث) فنعيد PNG base64؛ الواجهة ترسمه على <canvas>
// وتسجّله بـ MediaRecorder ⇒ webm (صفر اعتماديات — كله APIs Chromium). حجم الإطار =
// أبعاد العرض. عائد سريع (بلا waitReady) — التسجيل يلتقط الحالة اللحظية أثناء التصفح.
async function captureFrame() {
  const wc = currentWC();
  if (!wc) return { error: 'closed' };
  try {
    const img = await wc.capturePage();
    const png = img.toPNG();
    if (!png || !png.length) return { error: 'empty' };
    const size = img.getSize();
    return { ok: true, base64: png.toString('base64'), width: size.width, height: size.height };
  } catch (e) { return { error: 'capture_failed' }; }
}

// بثّ نشاط الوكيل على المعاينة (لمحرك Codex): codexmcp.js يستدعيها عبر onActivity حين
// ينفّذ Codex أداة متصفح، فتصل preview-panel.js كحدث agent_activity (عبر previewSender
// القائم — بلا تعديل main.js) فيومض مؤشّر «🤖 الوكيل …». لمحرك SDK يتكفّل app.js بذلك من
// tool_use؛ أما أدوات Codex فتُنفَّذ على خادم HTTP منفصل فلا تظهر كـ tool_use في دوره.
function emitAgentActivity(tool) {
  const t = String(tool || '');
  if (t) emit({ type: 'agent_activity', tool: t });
  return { ok: true };
}

// إغلاق اللوحة = تدمير العرض كلياً (يحرّر الذاكرة؛ partition الدائمة تحفظ الكوكيز)
function close() {
  clearSensitiveState();
  // OBS-021: إغلاق المستخدم للوحة فعل قاطع — يفكّ أيضاً علم التسليم البشري إن كان
  // عالقاً (دورة handoff انقطعت دون حسم: مهلة أداة MCP لدى codex تقطع النداء بينما
  // dispatch في خادمنا ينتظر للأبد، والعملية المعمّرة لا تمرّ بـcleanup بين الأدوار).
  // بدون هذا يبقى العرض الجديد بعد إعادة الفتح مرفوض الأدوات كلها «تسليم جارٍ».
  endHandoff();
  invalidateSnapshotRefs();
  if (!view) return { ok: true };
  try { if (hostWin && !hostWin.isDestroyed()) hostWin.contentView.removeChildView(view); } catch (e) {}
  try { if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close(); } catch (e) {}
  view = null;
  viewportOverride = null;
  netThrottled = false; // عرض جديد يبدأ بلا محاكاة شبكة (debugger مات مع الإغلاق)
  return { ok: true };
}

// عند إغلاق التطبيق (نفس فلسفة bgprocs/term)
function destroy() { close(); hostWin = null; sender = null; }

module.exports = {
  open, navigate, action, setBounds, startPick, cancelPick, readPage, snapshot, waitFor,
  getConsole, getNetwork, screenshot, screenshotFull, screenshotElement, clickElement, typeText,
  selectOption, hover, scroll, pressKey, evaluate, setViewport, perf, back, forward,
  fillForm, transferField, requestSecret, resolveSecretRequest, clearSecretTransfers, clearSensitiveState,
  currentUrl, navigationTarget, browserTarget, browserActionContext, browserInputError, leaseError,
  captureFrame, emitAgentActivity, startHandoff, endHandoff,
  isHandoffActive, close, destroy, isHttpUrl, setExternalTargetProvider, attachExternalWebContents,
  _internals: {
    safeDownloadName, uniqueDownloadPath, effectiveBounds, isLocalHttpsUrl, locatorError,
    fingerprintLabel, AGENT_WORLD_ID, COMMITTED_INPUT_TYPES,
    snapshotFingerprints: () => new Map(activeSnapshotFingerprints),
    leaseState: () => ({ userInputCounter, leaseUserRevision }),
  },
};
