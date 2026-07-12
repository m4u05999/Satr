/**
 * سطر 2.0 — التحديث التلقائي (المرحلة 17) عبر electron-updater + إصدارات GitHub
 *
 * يزيل ألم التوزيع اليدوي (حجب المتصفح + التباس أرشيف المصدر): بعد أول تثبيت لنسخة
 * تحوي هذا المُحدِّث، تصل التحديثات داخل التطبيق بلا عودة لصفحة الإصدارات.
 *
 * القرارات المثبّتة:
 *  - **لا يعمل إلا في النسخة المحزومة** (app.isPackaged): في التطوير لا معنى للتحديث،
 *    وelectron-updater يرمي بلا dev-app-update.yml — فنتخطّاه صامتاً في npm start.
 *  - **بلا توقيع رقمي**: تحقق حيّ من التوثيق — ويندوز NSIS يحدّث بلا شهادة (بعكس ماك).
 *    مثبّتنا per-user (oneClick:false, perMachine:false) فلا حاجة صلاحيات مدير.
 *  - **موافقة صريحة في كل خطوة** (قرار المالك 2026-07-12): لا تنزيل ولا تثبيت تلقائيان.
 *    autoDownload=false ⇒ نُشعر «تتوفّر نسخة» وننتظر «نزّل الآن» (downloadUpdate).
 *    autoInstallOnAppQuit=false ⇒ إغلاق التطبيق لا يثبّت شيئاً؛ التثبيت حصراً بزرّ
 *    «أعد التشغيل الآن» (quitAndInstall). المستخدم يملك كل خطوة.
 *  - الأحداث تُبثّ للواجهة عبر نفس نمط emit (قناة satr:event) بنوع `update`.
 */

let autoUpdater = null;

// يُهيّأ من main.js بدالة بثّ للواجهة (obj → satr:event) — نفس نمط بقية المحرّكات
function initUpdater(app, emit) {
  // التطوير: لا تحديث (لا نسخة محزومة). التخطي صامت كي لا يعكّر npm start.
  if (!app.isPackaged) return;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    return; // الحزمة غائبة لسببٍ ما — لا نُسقط الإقلاع
  }

  autoUpdater.autoDownload = false;          // لا تنزيل قبل موافقة المستخدم («نزّل الآن»)
  autoUpdater.autoInstallOnAppQuit = false;  // الإغلاق لا يثبّت؛ التثبيت بزرّ «أعد التشغيل» فقط
  autoUpdater.on('update-available', (info) => {
    // متوفّر بانتظار الموافقة على التنزيل (لا يبدأ تلقائياً — autoDownload=false)
    emit({ type: 'update', phase: 'available', version: info && info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    emit({ type: 'update', phase: 'progress', percent: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({ type: 'update', phase: 'ready', version: info && info.version });
  });
  autoUpdater.on('error', (err) => {
    // التفاصيل للسجل فقط؛ لا نزعج المستخدم برسالة خطأ تحديث خام
    console.error('[updater]', (err && err.message) || err);
    emit({ type: 'update', phase: 'error' });
  });

  // فحص بعد ثوانٍ من الإقلاع (لا نزاحم تحميل الواجهة والبوابة)
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 8000);
}

// يستدعيه معالج IPC عند ضغط المستخدم «نزّل الآن» — يبدأ التنزيل بعد الموافقة الصريحة
function downloadUpdate() {
  if (autoUpdater) { try { autoUpdater.downloadUpdate().catch(() => {}); } catch (e) {} }
}

// يستدعيه معالج IPC عند ضغط المستخدم «أعد التشغيل الآن»
function quitAndInstall() {
  if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch (e) {} }
}

module.exports = { initUpdater, downloadUpdate, quitAndInstall };
