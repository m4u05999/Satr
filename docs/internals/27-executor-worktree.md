### عامل منفّذ محايد عن المحرك في worktree معزول (الأولوية 6 — الخطوة 2)

- **دورة الحياة**: `electron/worktrees.js` يتحقق أن `cwd` مستودع Git ذو `HEAD`، ثم
  ينشئ detached worktree من نفس الرأس تحت `~/.satr/worktrees`. كل أوامر Git عبر
  `execFile` ومصفوفة وسائط بلا shell، والمسار يجب أن يبقى داخل جذر التخزين وخارج
  المستودع الأصلي. تُرفض symlinks وsubmodules المتعقّبة قبل التنفيذ. `--force` محصور
  في حذف worktree المؤقت المولّد داخلياً بعد التقاط الفرق؛ لا force على فرع المستخدم.
- **التنفيذ المحصور**: `electron/executor.js` يستدعي runner محقوناً بعقد `start` صندوقاً أسود بوضع
  `permissionMode:'acceptEdits'` و`cwd` مسار worktree. القائمة البيضاء `Read|Grep|Glob|Edit|Write|MultiEdit`
  فقط؛ أي أداة تنفيذ/Git/متصفح/وكيل فرعي أو مسار خارجي يوقف الدور fail-closed. ميزانية
  إذن الكتابة 30 وطلباً كحد أقصى. فرق غرفة العمليات تختار مهلة كل عامل من presets ثابتة
  180/300/600ث (الافتراضي 300ث والسقف 600ث)، ويتوفر interrupt واحد. يجب أن يحمل
  runner اسم محرك صريحاً مطابقاً لـ`SAFE_ENGINE_LABEL`؛ غيابه أو غياب `start` يعيد
  `engine_unavailable` قبل إنشاء worktree. يحقن `main.js` محرك SDK الحالي صراحةً، ولا يدخل Codex هنا بعد.
- **النتيجة بلا دمج**: بعد النهاية/المهلة/المقاطعة يقرأ المنفّذ `gitdiff.changes`، يحتفظ
  بملخص الملفات/الأسطر وبيانات `file_edit` كنقطة مراجعة، ثم يحذف worktree. لا API للدمج
  أو commit في هذه الخطوة، والنتيجة تصرّح دائماً `merged:false` و`merge_supported:false`. لم نشغّل
  أوامر verify داخل العامل لأن هذه النسخة الصغرى تمنع exec كلياً.
- **IPC والواجهة**: بدء `satr:executionStart {cwd,task,confirmed:true}` يتطلب تأكيداً صريحاً
  وينقّي `cwd/task` في `main.js`؛ الإيقاف وآخر نتيجة عبر `satr:executionStop`/
  `satr:executionLatest`. الحدث `execution_update` (schema v1) يغذّي لوحة `/تنفيذ-معزول`، وتعرض الحالة/
  الكلفة/ميزانية الكتابة/الملخص/الفرق، ولا تقدّم زر دمج.
- **التحقق**: `npm run test:worktrees` يغطي دورة الإنشاء/الفرق/الإزالة، عزل الكتابة
  عن المستودع الأصلي، runnerين مزيفين موسومين يمران بالسياسة نفسها، رفض runner مفقود أو بلا هوية أو مشوّه
  قبل إنشاء worktree، المهلة/المقاطعة، رفض المسار الخارجي، وغياب الدمج التلقائي.

