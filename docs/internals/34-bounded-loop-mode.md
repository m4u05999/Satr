### وضع الحلقة المحدودة (الجولة الخامسة — النواة)

الطبقة الرابعة (Loop Engineering): حلقة **نفّذ ← تحقق ← أصلح** تلقائية **داخل** بوابات غرفة
العمليات القائمة — لا مسار تنفيذ موازياً — والدمج بشري دائماً. المواصفة المعتمدة في
`docs/LOOP-MODE-DESIGN.md` (قرارات المالك الخمسة محسومة كما هي).

- **القرار المعماري**: `electron/looprunner.js` **لا يكرّر** طبقة الفريق ولا يعدّل عقودها؛ ينشئ
  نسخة `executionteam` خاصة ويحقن فيها **عاملاً واحداً يكرّر داخلياً** عبر `createExecutor`
  المعلن أصلاً في عقدها. بذلك تُعاد `teamPublic` و`buildArtifact` و
  `artifactId = sha256(head+'\0'+patch)` و`producer_engines` حرفياً، وتبقى بطاقات الغرفة
  صادقة عبر `execution_team_update` المعتاد. البديل (إدارة worktree/runner مباشرة وبناء
  الأثر يدوياً) رُفض لأنه يُضاعف بصمة الأثر وشكل اللقطة في موضعين.
- **حدود مجمَّدة**: عامل SDK واحد (حاجز 3A قائم — Codex لا ينفّذ)، worktree **واحد يعيش طوال
  الحلقة**، و`team_id` ثابت (فريق/تشغيل واحد لكل حلقة لا فريق جديد لكل دورة). الدورات
  `1..5` (افتراضي 3)، الميزانية `50k..2M` رمزاً (افتراضي 400k)، ومهلة **كل دورة** من
  presets ‏`180|300|600` ثانية (افتراضي 300).
- **مصدر التحقق الوحيد**: أوامر `.satr/verify.json` من **blob ‏HEAD حصراً** عبر
  `integration.preflight` (‏`worktrees.readFileAt` + `verify.parseConfig`) — تُقرأ **مرة واحدة**
  عند البدء وتُثبَّت snapshot لا يُعاد من الشجرة، وتُعرض حرفياً في **موافقة واحدة مسبقة** على
  الحلقة كاملة (الأوامر + عدد الدورات + الميزانية). لا TestSprite في MVP.
- **الدورة**: دور بـ`permissionMode:'acceptEdits'` وسياسة `executor` نفسها (قائمة الأدوات
  تُستورد من `executor.READ_TOOL_NAMES/EDIT_TOOL_NAMES` فمصدر الحقيقة واحد) ⇐ **تحقق داخلي**
  في worktree تكاملي مؤقت من HEAD المثبت + patch الحالي عبر `verify.boundedExecutor` المسقوف
  (لا الطرفية المرئية) ⇐ عند الفشل يُحقن `buildFailureInjection` في دور الإصلاح **بنفس جلسة
  العامل** (سياق متراكم) ⇐ حتى pass أو نفاد الدورات/الميزانية.
- **التحقق الوسيط داخلي**: لا يبثّ `execution_verification_update` ولا يلمس بوابة الدمج، ويحظر
  لمس ملف الإعداد داخل patch (‏`applyPatch` بقائمة الحجب — نمط `integration` حرفياً) فيفشل مغلقاً.
- **جلسة جديدة عند تلوث السياق**: فشل متطابق مرتين متتاليتين (`sameFailure`) ⇒ الدورة التالية
  بجلسة جديدة، وبرومبتها يحمل المهمة كاملةً + كتلة الفشل لأن السياق المتراكم سقط.
- **الميزانية**: تُجمع من `usage` الحقيقي حيث يتوفر وإلا التقدير، وتُوسم `estimate:true` دائماً في
  الحدث لأن العدّ التقريبي لا يُنسب إلى tokenizer المزوّد. تُفحص **قبل** بدء دورة جديدة فقط —
  لا قطع دور جارٍ.
- **سياسة الكتابة**: سقف `executor` (30 إذن كتابة) **لكل دورة** لأن كل دورة دورٌ مكافئ لتشغيل
  `executor` واحد، وسقف كلي = الدورات × 30 كي لا تتحول الحلقة إلى ميزانية مفتوحة؛ اللقطة تعرض
  السقف الكلي والمستهلك التراكمي.
- **الحدث** `loop_update` ‏(schema v1، طبقة المنسّق مثل `execution_team_update`):
  `{type,schema_version:1,loop_id,team_id,room_id,state,iteration,max_iterations,
  last_failure_summary,cost{usd,input_tokens,output_tokens,estimate},
  budget{limit_tokens,used_tokens,estimate:true,exhausted},stop_reason,updated_at}`.
  الحالات `preparing|working|verifying|passed|failed_after_n|budget_exhausted|failed|stopped`،
  والاقتران إلزامي: `passed⇔pass · failed_after_n⇔iterations · budget_exhausted⇔budget ·
  stopped⇔user · failed⇔error`، وغير الطرفية `''`. ممنوع في الحدث: patch أو خرج أوامر أو مسار
  مطلق أو حقل SDK خام. المهلة تنتهي إلى `failed/error` (لا حالة `timed_out` في عقد الحلقة).
- **فصل خرج الأوامر (‏`electron/loopfailure.js` — نقي فوق `secretscrub`)**:
  `buildFailureInjection` نص **داخلي** لمدخل دور الإصلاح فقط (ذيل الخرج بعد حجب الأسرار وإزالة
  التحكم/Bidi وتعطيل قوسي الوسم، ≤2000 محرف/فحص وسقف كلي 8000، داخل
  `<untrusted_verification_output>`) — **لا يعبر أي حدث أو IPC أو سجل**؛ و`buildFailureSummary`
  هو **المصدر الوحيد** لـ`last_failure_summary` (بلا خرج إطلاقاً، ≤300 نقطة Unicode)؛
  و`sameFailure` بصمة الفشل. التنقية بمُسنِد نقاط Unicode لا بتعبير نمطي فيه محارف تحكم حرفية.
- **السجل**: كل دورة وقرار جلسة وحالة طرفية تُسجَّل `opsroom.appendSystem(roomId,'note',…)` —
  **لا نوع entry جديد** — بنص عربي قصير + الملخص المنقّى، ويمر ببوابات `hasSecret/patch_forbidden`.
- **IPC** (تنقية في `main.js` حصراً، preload محدد بأربع دوال): `satr:loopPreflight {cwd}` غلاف
  قراءة فقط فوق `integration.preflight` **يحذف `sourceRoot`** فلا يعبر مسار مطلق إلى renderer ·
  `satr:loopStart {cwd,task,ownership,loop{max_iterations,budget_tokens,timeout_seconds},
  confirmed:true}` · `satr:loopStop {loopId}` · `satr:loopLatest {cwd}`. الأخطاء:
  `confirmation_required` و`verification_config_required` و`busy` و`bad_input`، ومعها
  preflight الفريق المدمَج نفسه (`ops_model_invalid`/`review_engine_unavailable`) كي لا يُكتشف
  غياب محرك المراجعة بعد استهلاك دورات. **حصر متبادل**: حلقة نشطة ترفض `executionTeamStart`
  وفريق نشط يرفض `loopStart` — لأن الحلقة تملك فريقها.
- **التسليم للبوابة البشرية**: عند نهاية الحلقة يُلتقط patch نهائي واحد ويُسلَّم عبر
  `looprunner.handoff()` إلى `executionTeam.restore(bundle, cwd, emit)` — وهو **المنفذ الوحيد**،
  فتعمل المراجعة العمياء cross-engine والتحقق الرسمي وحفظ الأثر المشفّر وفهرس الغرفة وبوابة
  الدمج بالتأكيد الصريح **بلا تغيير حرف في أي منها**. التسليم يقع لحالات
  `passed|failed_after_n|budget_exhausted` (العامل أنهى أدواره نظيفاً) **و`stopped`**
  (قرار مالك 2026-08-01: إيقاف المستخدم نيّة صريحة، فالأثر الجزئي يستحق المراجعة)؛ أما
  `failed` و`timed_out` فتبقيان fail-closed لأن فشل المحرك قد يترك كتابة نصف مكتملة.
- **أثر حلقة أوقفها المستخدم (قرار مالك 2026-08-01)**: يُسلَّم **فقط** إن التُقط patch سليم
  البنية فعلاً؛ التقاط فاشل أو patch فارغ ⇒ لا تسليم، وتبقى ملاحظة «انتهت الحلقة بلا أثر
  قابل للمراجعة» كما هي. البوابات البشرية بعده **لا تتغير حرفاً**: مراجعة عمياء cross-engine
  ⇒ تحقق رسمي ⇒ تأكيد بشري، بلا أي اختصار. ولا حالة `loop_update` جديدة ولا تغيير schema —
  `stopped` كما هي، والتغيير في ما يحدث بعدها فقط.
  - **البوابتان**: `executionteam.ARTIFACT_TEAM_STATES = {completed, stopped}` يستهلكها
    `artifact()` و`restore()`. أثرها على الفرق العادية **صفر** لأن `executor.artifact()`
    يشترط `run.state === 'completed'` فيعيد null لعامل موقوف، و`buildArtifact` يسقط عند أول
    أثر ناقص — فالتوسعة محصورة عملياً بعامل الحلقة الذي يملكه `looprunner`.
  - **الحالات تبقى صادقة**: بطاقة التشغيل الحيّة تقول `stopped` (فريقاً وعاملاً) و`loop_update`
    يقول `stopped`/`user`؛ ولم يُحوَّل تشغيل موقوف إلى «مكتمل». الفريق **المستعاد** وحده
    يُسجَّل `completed` لأنه تمثيل **طور المراجعة** لا طور التنفيذ — وبوابة `canReview` في
    `ops-room-state.js` تقرأ هذه الحالة.
  - **تمييز السجل**: ملاحظة نظامية عربية عبر `opsroom.appendSystem` القائمة (**بلا نوع entry
    جديد**) تذكر أنه «أثر جزئي من حلقة أوقفها المستخدم عند الدورة N من M»، وتُسجَّل فقط حين
    يكون الأثر قابلاً للتسليم فعلاً كي لا تناقض ملاحظة الغياب.
  - **الإيقاف أثناء المراجعة النوعية**: إجهاض `reviewOnce` يسري، فيُسلَّم الأثر **بلا حكم
    مراجعة** ويبقى `review.state` كما كان لحظة الإيقاف (لا verdict ولا summary).
- **حدود موثّقة**: (1) `loopStart` يوجب أن يكون `cwd` **جذر المستودع**، لأن خزنة الأثر
  (`opsartifacts`) توجب أصلاً `cwd === sourceRoot`؛ الفشل مبكر بـ`bad_input` لا عند التسليم.
  (2) المهلة لكل دورة، فأقصى زمن نظري 5 × 600ث + زمن التحقق. (3) الميزانية تقديرية لا فاتورة.
  (4) لا تمديد مهلة داخل الحلقة (لا `extend`) بخلاف الفريق اليدوي.
- **التحقق**: `npm run test:loop-live-probe` (حيّ بمحرك SDK — **خارج `test:full` عمداً** مثل بقية
  المسابير) يثبت الإصلاح خلال ≤3 دورات وsnapshot الأوامر من HEAD (‏`HEAD` وشجرة العمل الأصلية
  لا تتغيران) وتسجيل الدورات بلا خرج أوامر وعقد `loop_update` وصلاحية بصمة الأثر وقبول مسار
  المراجعة له. له سيناريوهان: `--scenario simple` (خلل معلن — المسار السعيد) و
  `--scenario repair` (خللان والمهمة تذكر الأول فقط، فالثاني لا يُعرف إلا من خرج التحقق
  المحقون) وهو **الدليل الحيّ أن حلقة الإصلاح تعمل بمحرك حقيقي**. طقم `test:opsroom-all` عقد
  عدم التراجع ويبقى 10/10.
- **الاختبار القطعي والتحصين الخصومي**: `npm run test:loop-mode` (قطعي، بلا شبكة) يغطي
  schema الحدث والاقتران state/stop_reason وfail-closed (غياب/فساد verify.json في HEAD، busy)
  والتنقية IPC والمسار السعيد والنفاد (failed_after_n/budget_exhausted) ونفس الجلسة والجلسة
  الجديدة عند تكرار نفس الفشل (`sameFailure`) والإيقاف الفوري وتنظيف worktrees وعدم تسريب
  الأسرار وثبات أنواع أحداث المحركات (loop_update خارج KNOWN_EVENT_TYPES). التحصينات الأربعة
  في `electron/loopfailure.js`: قص Unicode بلا كسر surrogate pairs (`slicePoints`)، تحييد وسم
  الإغلاق المزروع (تعطيل قوسي الوسم)، إزالة تحكم/Bidi، وfail-closed للمدخلات المشوهة — بلا
  تغيير تواقيع أو سقوف العقد.
- **توسعة additive وحيدة في ملف عدم تراجع**: `electron/executor.js` صدّر
  `READ_TOOL_NAMES`/`EDIT_TOOL_NAMES` (مصفوفتان مجمَّدتان من الـSets القائمة) ليبقى مصدر قائمة
  الأدوات واحداً؛ صفر تغيير سلوكي، و`test:worktrees`/`test:executionteam`/`test:integration`/
  `test:reviewmerge`/`test:opsroom` خضراء بلا تعديل ملفات اختبارها.
- **مؤجّل عمداً**: بطاقة الحلقة في الواجهة واختبار الطقم القطعي (منفّذان آخران في الجولة نفسها)،
  وTestSprite مصدر تحقق ثانياً، وحلقة متعددة العوامل، ومتابعة الدورات بعد مهلة دور.
  (تسليم أثر حلقة أوقفها المستخدم **نُفِّذ** بقرار المالك — انظر أعلاه.)

#### مرحلة المراجعة النوعية داخل الحلقة (الجولة السابعة — البند ٣)

- **حقل `review_skill` في `.satr/verify.json`** (اختياري كلياً): `{name, label?,
  timeout_seconds?}` — الاسم يطابق `/^[A-Za-z0-9._-]{1,64}$/`، والوسم ≤120 نقطة Unicode
  تُزال منها محارف التحكم وBidi ثم تُقصّ، والمهلة عدد صحيح `1..600` بافتراضي `300`. رمز
  الخطأ موحّد للقراءة والكتابة: `bad_review_skill`. الحقل **خارج عدّ `MAX_CHECKS=6`** وحجم
  الملف يبقى ≤64KiB. **غياب الحقل = السلوك القائم حرفياً** (توافق خلفي إلزامي، محروس
  باختبار يقارن `buildConfig(commands).source` ببايتات الملف القديمة نفسها).
- **مصدر واحد للعقدين**: `verify.normalizeReviewSkill` يستهلكه `parseConfig` (قراءة)
  و`buildConfig` (كتابة) فلا يتباعدان. تنقية الوسم بمُسنِد نقاط Unicode لا بتعبير نمطي فيه
  محارف تحكم حرفية (درس `loopfailure.js` — التعبير الحرفي يُتلف الملف عند تحريره).
- **إغلاق الوصلة مع البند ٤**: `verify.createConfig(cwd, commands, {confirmed, overwrite,
  reviewSkill})` صار يمرّر `settings.reviewSkill` إلى `buildConfig` فيُكتب الحقل فعلاً.
  التوقيع لم يتغيّر ولا اسم الخيار ولا شكله؛ كان السلوك السابق `ok:true` مع سقوط الحقل صامتاً.
- **موضع المرحلة**: **بعد نجاح كل أوامر `commands` في الدورة** لا قبلها ولا مع كل أمر —
  فشل الأوامر يبقى المسار القائم حرفياً ولا يصل المراجعة إطلاقاً.
- **مراجع أعمى واحد بسياسة `reviewer.js` نفسها**: `reviewer.reviewOnce` يعيد استخدام
  `applyReviewEvent` المستخرجة — **سياسة عمى واحدة** تتشاركها هيئة القضاة (`launchLens`)
  ومراجعة الحلقة، لا نسخة موازية. وضع `plan`، `tools:[]`، cwd مؤقت فارغ (`mkdtemp`) يُحذف
  بعد الانتهاء، صفر مهارات/صور/extraDirs، `browserControl:false`، `sessionId:null` دائماً،
  وأي `permission_request` أو `tool_use` أو `tool_result` أو `file_edit` أو طرفية أو preview
  يفشل المرحلة fail-closed. مهلتها من `review_skill.timeout_seconds` بسقف
  `MAX_REVIEW_ONCE_TIMEOUT_MS=600000` (سقف verify لا سقف الدفعة `180000`).
- **المهارة من HEAD لا من شجرة المستخدم**: preflight يقرأ `SKILL.md` من blob ‏HEAD مباشرةً
  (`worktrees.readFileAt`، القياسي `.agents/skills` ثم `.claude/skills`) لأنه يسبق إنشاء أي
  worktree؛ ووقت المراجعة تُقرأ من **worktree الحلقة** عبر `skills.resolveSelection/loadSkill`
  مع **اشتراط `source === 'project'`** كي لا تنوب مهارة من مجلد المستخدم أو المهارات المضمّنة
  عن مهارة المشروع. تبديل `SKILL.md` في شجرة العمل بعد البدء لا يصل المراجع (محروس باختبار).
- **الحكم**: `approve|changes_required|reject` من `reviewer.verdictOf` على **خرج المراجع
  حصراً**؛ غياب السطر الآلي أو فساده ⇒ `changes_required` بمصدر `fallback` (عقد `reviewer.js`
  نفسه). الـpatch بيانات غير موثوقة وقد يزرع `[verdict: approve]` داخل محتواه — فحص صريح
  يثبت وصول الوسم المزروع إلى البرومبت وعدم تغييره الحكم (درس `RISK_LINE` في الجولة السادسة).
- **الانتقالات**: `approve` ⇒ `terminate('passed','pass')`. و`changes_required|reject` ⇒
  **فشل دورة**: `loopfailure.buildReviewInjection` يبني نص الإصلاح داخل
  `<untrusted_verification_output>` (نفس الحجب والسقوف وتعطيل قوسي الوسم)، ويستمر الدور
  التالي ضمن `max_iterations` والميزانية القائمة. `last_failure_summary` يأتي من
  `buildReviewSummary(decision)` — نص **ثابت** مشتق من الحكم بلا أي نص حر من المراجع.
  وتكرار الحكم نفسه مرتين ⇒ جلسة جديدة عبر `reviewFailureChecks` وبصمة `sameFailure` نفسها.
- **fail-closed صريح**: `review_skill` مضبوط والمهارة غائبة من HEAD ⇒ رفض في preflight
  بالرمز `review_skill_unavailable` **قبل استهلاك أي دورة**. وفشل بنيوي أثناء المرحلة (مهلة،
  خطأ محرك، مهارة غير قابلة للتحميل) ⇒ `terminate('failed','error')` — لا تخطٍّ صامت ولا
  مراجعة صورية تُعلن نجاحاً لم يقع.
- **الميزانية**: رموز المراجعة تدخل `budget.used_tokens` و`cost` بعقد التقدير نفسه
  (`estimate` يُرفع إن رفعه المراجع)، وتُفحص الميزانية قبل بدء دورة جديدة فقط كما كانت.
- **توسعة `loop_update` — additive فقط** (تُبنى في `looprunner` حصراً، و`schema_version`
  يبقى `1` وكل الحقول القائمة بقيمها ودلالاتها): `review:{configured:boolean,
  state:'idle'|'running'|'approve'|'changes_required'|'reject'|'failed', summary:string}`.
  الملخص يمر بـ`buildReviewSummaryText` (حجب أسرار + إزالة تحكم/Bidi + طيّ فراغات + قصّ
  ≤300 نقطة Unicode) **ثم بحارس `memory.hasSecret`** فيُفرَّغ كلياً إن التقطه. ممنوع فيه
  خرج أوامر خام أو patch أو مسار مطلق أو حقل SDK خام. `main.js` يمرّر `loop_update` كما هو
  (`emitLoopEvent` بلا قائمة سماح) فلا تعديل في `main.js` أو `preload.js`. **لم تُضف حالة
  حلقة جديدة**: أثناء المراجعة تبقى `loop.state === 'verifying'` و`review.state === 'running'`.
- **التحقق**: `npm run test:verify` توسّع (‏`review_skill` قراءةً وكتابةً، الكتابة الفعلية
  على القرص، الافتراضات، السقوف، العشر حالات الفاسدة بالرمز الموحّد عبر المسارات الثلاثة،
  الحقل خارج `MAX_CHECKS`، والتوافق الخلفي بايتاً ببايت). و`npm run test:loop-mode` توسّع
  بثمانية عقود جديدة. `test:integration` و`test:reviewmerge` و`test:opsroom` عقود عدم تراجع.
- **مؤجّل عمداً في هذا البند**: عرض حقل `review` في الواجهة (دفعة لاحقة خارج الجولة)، ومراجعة
  متعددة الزوايا داخل الحلقة (زاوية واحدة بمعايير المشروع تكفي وتُبقي كلفة الدورة محدودة)،
  ومراجع cross-engine داخل الحلقة (يبقى في مسار الدمج البشري بعد التسليم).

