### التحديث التلقائي (المرحلة 17)

- **`electron/updater.js`** عبر `electron-updater` + إصدارات GitHub (`build.publish` = github):
  يزيل التوزيع اليدوي. **حارس `app.isPackaged`**: لا يعمل في npm start (يتخطّى صامتاً).
  بلا توقيع رقمي (ويندوز NSIS يحدّث بلا شهادة — تحقق حيّ). مثبّتنا per-user فلا صلاحيات مدير.
- **التدفق الآمن المعتمد**: فحص بعد 8ث من الإقلاع ⇒ إشعار عربي `available` لا يقاطع ⇒
  المستخدم يضغط «نزّل الآن» (`downloadUpdate`) ⇒ تقدّم `progress` ⇒ «أعد التشغيل الآن»
  عند `ready` (`quitAndInstall`). ‏`autoDownload=false` و`autoInstallOnAppQuit=false`:
  لا تنزيل قبل الموافقة ولا تثبيت عند الإغلاق. الأحداث تُبثّ للواجهة كنوع `update` عبر
  `emitToWindow` (قناة satr:event، مستقلة عن الدور)، وIPC
  `satr:downloadUpdate`/`satr:restartUpdate` للخطوتين الصريحتين.
- **دورية الفحص (جولة الصقل 2026-08-08)**: الفحص لم يعد مرة واحدة — من يبقي «سطر»
  مفتوحاً أياماً كان لا يرى التحديثات. صار: إقلاع (8ث) + دوري كل 4 ساعات (مؤقّت unref)
  + عند استعادة تركيز النافذة بخنق 30 دقيقة + يدوي من ⚙ (زر «تحقق من التحديثات الآن»
  عبر `satr:checkUpdates` ⇒ `updater.checkNow()`). بعد أول `available` تتوقف الفحوص
  التلقائية (لا إزعاج متكرراً بإشعار رُفض)؛ اليدوي وحده يتجاوز. التنزيل/التثبيت يبقيان
  بموافقة صريحة كما هما.
- **العقد**: `{type:'update', phase:'available'|'progress'|'ready'|'error'|'none'|
  'check_failed', version?, percent?}`. الخطأ التلقائي يُخفي الإشعار صامتاً (يبقى
  التثبيت اليدوي متاحاً)؛ `none` («أنت على أحدث نسخة») و`check_failed` يُبثّان **للفحص
  اليدوي فقط** فلا يزعج الدوري الصامت أحداً. preload يكشف
  `downloadUpdate` و`restartUpdate` و`checkUpdates` فقط.
- **تمهيد**: التحديث يبدأ من أول إصدار يحوي المُحدِّث (v2.4.1). النشر يرفع `latest.yml`
  مع المثبّت لكل إصدار (يولّده electron-builder عند dist مع publish config).
- **التحقق**: `npm run test:update-ui` (حي، ضمن test:full) — طبقتان: عقد updater.js مع
  fake autoUpdater محقون عبر require.cache (الأعلام autoDownload/autoInstallOnAppQuit=false،
  خرائط الأحداث الأربعة، عدم تسريب رسالة الخطأ الخام، التفويض الصريح فقط)، وتوست
  Chromium فعلي عبر `src/ui/lib/update-toast.js` المستخرجة (غير حاجب، الموافقتان،
  الفشل الصامت) تحت CSP صارم. fixture الترميز محروس بمطابقة `#updateToast` مع index.html.

