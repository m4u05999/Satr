### التحقق التكاملي قبل الدمج (غرفة العمليات — المرحلة 5)

- **preflight أو مسودة نهائية**: المسار القابل للدمج يقرأ `.satr/verify.json` حصراً من blob ‏Git عند
  `HEAD` قبل إنشاء عوامل أو استهلاك دور. غياب الملف أو فساده يعيد `verification_config_required` مع
  إرشاد عربي، بلا اكتشاف تلقائي لـ`npm test` أو أي script. يمكن لعامل واحد العمل بوضع `draft` بلا
  الإعداد أو محرك المراجعة الآخر، لكنه يعلن `merge_supported:false` منذ البداية ولا يقبل الترقية؛
  الدمج يتطلب فريقاً جديداً قابلاً للدمج. معالج الإنشاء يساعد المستخدم في كتابة الملف داخل شجرة
  العمل فقط؛ لا يغيّر هذا العقد ولا يضيفه إلى Git أو `HEAD` تلقائياً.
- **تثبيت المصدر والتأكيد**: `electron/integration.js` يعيد الأوامر المنقّاة من
  `artifact.head:.satr/verify.json` للعرض فقط، ثم يتطلب `confirmed:true` مستقلاً لتشغيل snapshot نفسه.
  لا IPC يقبل command أو اختيار check من renderer أو نموذج. `electron/verify.js` يعيد استخدام parser
  الواحد (≤64KiB، ≤6 أوامر، سطر واحد، مهلة ≤600 ثانية)، ويشغّل كل أمر بصدفة نظام محددة داخل cwd
  التكاملي مع مهلة وذاكرة خرج مجمعة ≤64KiB.
- **worktree تكاملي**: `electron/worktrees.js` ينشئ detached worktree من `artifact.head` المحدد،
  ويفحص patch عبر `git apply --numstat -z` لمنع لمس `.satr/verify.json`، ثم ينفذ
  `git apply --check` قبل `git apply`. كل أوامر Git بمصفوفة وسائط بلا shell، والـpatch مؤقت داخل مخزن
  «سطر». النجاح والفشل والمهلة والمقاطعة تنظف worktree؛ فشل التنظيف يقلب النتيجة إلى `failed`.
- **«شاهدها تعمل» دورة مستقلة**: الحقل الاختياري `preview` في `.satr/verify.json` يُقرأ من
  blob ‏`artifact.head` نفسه، ولا يقبل IPC أمراً من renderer. `preparePreview` لا يستدعي `run()` ولا
  يغيّر نتيجته؛ يشترط تحققاً `passed` للبصمة نفسها و`confirmed:true`، وينشئ worktree جديداً ويطبق
  الأثر مع حظر ملف الإعداد نفسه، ثم يبدأ الأمر عبر `termjobs` في تبويب 🛠 وينتظر العنوان المحلي ضمن
  المهلة. المعاينة الحية واحدة فقط؛ الثانية تعيد `busy`. تستخدم `{recordDevServer:false}` كي لا
  يسجل المسار المؤقت في `devservers`، ولا يحمل حدث `bg_term` مسار worktree. الإيقاف، والدمج الناجح،
  وبدء فريق جديد، وإغلاق التطبيق توقف المهمة ثم تحذف worktree قبل قتل الطرفيات. فشل أي إزالة يبقى
  `cleanup_failed` صريحاً وقابلاً لإعادة محاولة التنظيف.
- **النتيجة والبوابة**: النتيجة العامة محصورة في
  `{artifact_id,state,checks:[{id,label,passed,exit_code,timed_out,duration_ms}]}` بلا command أو خرج
  خام أو أسرار. `merger.js` يرفض العمل إلا مع بوابة مراجعات `approve` ونتيجة `passed` للبصمة نفسها
  وتأكيد الدمج، ثم يطبق حراس HEAD ونظافة الشجرة و`git apply --check` السابقة بلا commit أو push أو
  rebase أو تغيير history.
- **IPC والواجهة**: القنوات `satr:executionVerificationPrepare/Run/Stop/Latest` و
  `satr:executionPreviewStart/Stop` محددة في preload؛ الأولى تنقّي الفريق/الأثر والتأكيد و`cwd`
  وترفض وجود `command` في الحمولة. لوحة التنفيذ تعرض الأوامر المثبتة أولاً وزر تشغيل مستقل، وتظهر
  «🖥 شاهدها تعمل» بعد نجاح تحقق الأثر نفسه. فتح المعاينة مساعد ثقة فقط: شرط الدمج بقي مراجعات
  `approve` + تحقق `passed` للبصمة نفسها، سواء شُغّلت المعاينة أم لا.
- **الاختبار**: `npm run test:integration` يستخدم مستودع Git حقيقياً لنجاح/فشل/مهلة/مقاطعة، غياب
  الإعداد، رفض بلا تأكيد، رفض تعديل الإعداد داخل patch، تبدل artifact، تنظيف كل worktree، منع تسريب
  الخرج، وبقاء المصدر بلا لمس حتى الدمج الصريح. اختبارات `verify/worktrees/reviewmerge/executionteam`
  و`eval:agent` عقود عدم تراجع إلزامية.

