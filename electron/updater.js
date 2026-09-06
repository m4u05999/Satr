/**
 * سطر 2.0 — التحديث التلقائي (المرحلة 17) عبر electron-updater + إصدارات GitHub
 *
 * يزيل ألم التوزيع اليدوي (حجب المتصفح + التباس أرشيف المصدر): بعد أول تثبيت لنسخة
 * تحوي هذا المُحدِّث، تصل التحديثات داخل التطبيق بلا عودة لصفحة الإصدارات.
 *
 * القرارات المثبّتة:
 *  - **لا يعمل إلا في النسخة المحزومة** (app.isPackaged): في التطوير لا معنى للتحديث،
 *    وelectron-updater يرمي بلا dev-app-update.yml — فنتخطّاه صامتاً في npm start.
 *  - **قناة الثقة هي HTTPS + sha512** (درس علة 2026-08-08): شرطُ «signed === true»
 *    الذي دخل مع 2.10.0 لم يمرره أحد من main فقتل القناة بصمت في كل النسخ حتى
 *    2.14.1 (اكتشفه المالك حياً). التحديث يُجلب من GitHub عبر HTTPS وتُطابَق بصمة
 *    sha512 من latest.yml — نفس سلسلة ثقة التنزيل الأول للمثبّت غير الموقّع، فالشرط
 *    لم يكن يضيف حماية فعلية فوقها. حين يتوفر توقيع مستقبلاً يُمرَّر signed:false
 *    صراحةً لأي بناء يُراد تعطيل قناته.
 *  - **موافقة صريحة في كل خطوة** (قرار المالك 2026-07-12): لا تنزيل ولا تثبيت تلقائيان.
 *    autoDownload=false ⇒ نُشعر «تتوفّر نسخة» وننتظر «نزّل الآن» (downloadUpdate).
 *    autoInstallOnAppQuit=false ⇒ إغلاق التطبيق لا يثبّت شيئاً؛ التثبيت حصراً بزرّ
 *    «أعد التشغيل الآن» (quitAndInstall). المستخدم يملك كل خطوة.
 *  - الأحداث تُبثّ للواجهة عبر نفس نمط emit (قناة satr:event) بنوع `update`.
 *  - **الفحص ليس مرة واحدة** (جولة الصقل 2026-08-08): من يبقي «سطر» مفتوحاً أياماً كان
 *    لا يرى التحديثات أبداً. صار الفحص: مرة بعد الإقلاع + دورياً كل 4 ساعات + عند
 *    استعادة تركيز النافذة (بحد أدنى 30 دقيقة بين فحصين) + يدوياً من ⚙ عبر checkNow.
 *    بعد أول «تتوفّر نسخة» تتوقف الفحوص التلقائية كي لا يتكرر الإشعار المرفوض كل
 *    دورة؛ الفحص اليدوي وحده يتجاوز ذلك. التنزيل والتثبيت يبقيان بموافقة صريحة.
 *    طورا `none` و`check_failed` يُبثّان **للفحص اليدوي فقط** كي لا يزعج الفحص
 *    الدوري الصامت المستخدم بنتيجة «لا جديد».
 *  - **نسخة المتجر (‏MSIX) لا تحدّث نفسها**: حزمة Microsoft Store موقّعة من مايكروسوفت
 *    ومثبّتة للقراءة فقط، والمتجر هو من يحدّثها؛ فتنزيل مثبّت NSIS من GitHub داخلها
 *    عبثٌ ينتهي بنسختين متوازيتين. `main.js` يمرّر `msix: process.windowsStore === true`
 *    (علم Electron الرسمي للتشغيل من حاوية appx) فيصمت المُحدِّث تماماً.
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;   // الفحص الدوري
const FOCUS_THROTTLE_MS = 30 * 60 * 1000;       // حد أدنى بين فحصَي تركيز

let autoUpdater = null;
let lastCheckAt = 0;      // آخر فحص فعلي (أي مصدر)
let updateKnown = false;  // وصلت «تتوفّر نسخة» — أوقف الفحوص التلقائية
let manualPending = false; // فحص يدوي ينتظر نتيجة ⇒ يستحق ردّ none/check_failed

// يُهيّأ من main.js بدالة بثّ للواجهة (obj → satr:event) — نفس نمط بقية المحرّكات
function shouldEnableUpdates(app, options = {}) {
  return !!(app && app.isPackaged)
    && options.edition !== 'enterprise'
    && options.signed !== false
    && options.msix !== true;
}

function initUpdater(app, emit, options = {}) {
  // التطوير: لا تحديث (لا نسخة محزومة). التخطي صامت كي لا يعكّر npm start.
  // Enterprise لا يرث قناة GitHub العامة، والبناء غير الموقّع لا يحمّل تحديثات تنفيذية.
  if (!shouldEnableUpdates(app, options)) return;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    return; // الحزمة غائبة لسببٍ ما — لا نُسقط الإقلاع
  }

  autoUpdater.autoDownload = false;          // لا تنزيل قبل موافقة المستخدم («نزّل الآن»)
  autoUpdater.autoInstallOnAppQuit = false;  // الإغلاق لا يثبّت؛ التثبيت بزرّ «أعد التشغيل» فقط
  autoUpdater.on('update-available', (info) => {
    // متوفّر بانتظار الموافقة على التنزيل (لا يبدأ تلقائياً — autoDownload=false)
    updateKnown = true;   // كفى فحوصاً تلقائية — المستخدم أُبلغ، ولا نكرر الإشعار كل دورة
    manualPending = false; // النتيجة نفسها هي الردّ على الفحص اليدوي
    emit({ type: 'update', phase: 'available', version: info && info.version });
  });
  autoUpdater.on('update-not-available', () => {
    // «لا جديد» يهم الفحص اليدوي وحده؛ الفحوص التلقائية الصامتة لا تزعج المستخدم به
    if (manualPending) { manualPending = false; emit({ type: 'update', phase: 'none' }); }
  });
  autoUpdater.on('download-progress', (p) => {
    emit({ type: 'update', phase: 'progress', percent: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({ type: 'update', phase: 'ready', version: info && info.version });
  });
  autoUpdater.on('error', (err) => {
    // التفاصيل للسجل فقط؛ لا نزعج المستخدم برسالة خطأ تحديث خام. الفحص اليدوي
    // وحده يستحق ردّاً مرئياً كي لا يبدو زرّ ⚙ ميتاً عند انقطاع الشبكة.
    console.error('[updater]', (err && err.message) || err);
    if (manualPending) { manualPending = false; emit({ type: 'update', phase: 'check_failed' }); }
    else emit({ type: 'update', phase: 'error' });
  });

  // OBS-131: نافذة خنق التركيز تبدأ من لحظة التفعيل لا من الصفر — وإلا مرّ أول
  // browser-window-focus (قبل مؤقّت الإقلاع 8000ms) حتماً فتضاعف الفحص عند كل إقلاع
  lastCheckAt = Date.now();

  // فحص بعد ثوانٍ من الإقلاع (لا نزاحم تحميل الواجهة والبوابة)
  setTimeout(() => { doCheck(); }, 8000);

  // الفحص الدوري — unref كي لا يمنع المؤقّت إغلاق التطبيق
  const interval = setInterval(() => { if (!updateKnown) doCheck(); }, CHECK_INTERVAL_MS);
  if (interval && typeof interval.unref === 'function') interval.unref();

  // فحص عند استعادة تركيز النافذة (مخنوق) — يلتقط من يترك «سطر» مفتوحاً أياماً
  if (app && typeof app.on === 'function') {
    app.on('browser-window-focus', () => {
      if (updateKnown) return;
      if (Date.now() - lastCheckAt < FOCUS_THROTTLE_MS) return;
      doCheck();
    });
  }
}

// فحص فعلي واحد — كل المصادر (إقلاع/دوري/تركيز/يدوي) تمر من هنا
function doCheck() {
  if (!autoUpdater) return;
  lastCheckAt = Date.now();
  try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {}
}

// زرّ «تحقق من التحديثات الآن» في ⚙ — يتجاوز الخنق وحارس updateKnown عمداً
function checkNow() {
  if (!autoUpdater) return { ok: false, error: 'unavailable' };
  manualPending = true;
  doCheck();
  return { ok: true };
}

// يستدعيه معالج IPC عند ضغط المستخدم «نزّل الآن» — يبدأ التنزيل بعد الموافقة الصريحة
function downloadUpdate() {
  if (autoUpdater) { try { autoUpdater.downloadUpdate().catch(() => {}); } catch (e) {} }
}

// يستدعيه معالج IPC عند ضغط المستخدم «أعد التشغيل الآن»
function quitAndInstall() {
  if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch (e) {} }
}

module.exports = { shouldEnableUpdates, initUpdater, downloadUpdate, quitAndInstall, checkNow };
