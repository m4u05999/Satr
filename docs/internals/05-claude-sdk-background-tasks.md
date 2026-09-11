### مهام Claude SDK الخلفية (دفعة D — 2026-07-26)

- **مصدر الحقيقة والمسبار أولاً**: استُخدم عقد
  `Query.backgroundTasks(toolUseId?: string): Promise<boolean>` وعقد
  `Query.stopTask(taskId:string):Promise<void>` وشكل
  `task_notification` المثبت في `@anthropic-ai/claude-agent-sdk/sdk.d.ts` فقط؛ لا واجهة
  `@alpha` أو EXPERIMENTAL. شُغّل `scripts/sdk-background-probe.js` حياً على SDK
  `0.3.176` وClaude Code `2.1.220 (Claude Code)` والنموذج `sonnet`، مع تأخيرَي الأمر
  المضبوطين `12000ms` للاكتمال و`45000ms` للإيقاف.
- **سيناريو الاكتمال الحي**: كان `toolUseId` هو
  `toolu_01MWVn3hRGQMFXCki8cUdZxL` و`taskId` هو `ble75vvq9`. كانت أعداد الرسائل:
  `command_lifecycle:3` و`system:init:2` و`rate_limit_event:1` و`assistant:3` و
  `system:task_started:1` و`system:background_tasks_changed:2` و`system:task_updated:2`
  و`user:1` و`result:2` و`system:task_notification:1`. أعادت `backgroundTasks` القيمة
  المنطقية `true` خلال `3ms`، ووصل إشعار `completed` بعد `13557ms`، بطول ملخص `83`،
  مع حضور `output_file` و`tool_use_id` وغياب `usage` (`false`/`null`)؛ وكانت نتيجة الدور
  `success`. طول معرّف الأداة `30` وبادئته `toolu`، وطول معرّف المهمة `9` وبادئته
  `ble75vvq9`.
- **سيناريو الإيقاف الحي**: كان `toolUseId` هو
  `toolu_01MTANwYZuUq4iFmWRZJxZ99` و`taskId` هو `b3mwp3cko`. كانت أعداد الرسائل:
  `command_lifecycle:3` و`system:init:1` و`rate_limit_event:1` و`system:thinking_tokens:2`
  و`assistant:3` و`system:task_started:1` و`system:background_tasks_changed:2` و
  `system:task_updated:2` و`system:task_notification:1` و`user:1` و`result:1`. أعادت
  `backgroundTasks` القيمة المنطقية `true` خلال `2ms`، وحُسمت `stopTask` بقيمة
  `undefined` خلال `8ms`، ووصل إشعار `stopped` بعد `10ms`، بطول ملخص `38`، مع حضور
  `output_file` و`tool_use_id` وغياب `usage` (`false`/`null`)؛ وكانت نتيجة الدور
  `success`. طول معرّف الأداة `30` وبادئته `toolu`، وطول معرّف المهمة `9` وبادئته
  `b3mwp3cko`.
- **الحالات الحدّية المثبتة**: أثناء الدور أعاد `backgroundTasks` لمعرّف صالح شكلاً لكنه
  مجهول `false` من نوع boolean، بينما حُسمت `stopTask` لمعرّف مجهول بقيمة `undefined`.
  بعد انتهاء الدور رفض الاستدعاءان بخطأ `Error` ورسالة
  `ProcessTransport is not ready for writing`. الإنتاج لا يعيد هذه الرسالة الخام؛ يحولها
  إلى خطأ عربي ثابت، ولا يستدعي `stopTask` إلا لمعرّف مهمة تعلّمه من SDK وربطه بأداة
  نقلها المستخدم فعلاً.
- **المحرك ودورة الحياة**: مقبض التشغيل العادي لمحرك `sdk` يكشف داخلياً فقط
  `moveToBackground(toolUseId)` و`stopSdkTask(taskId)`. الحارسان الصارمان يقبلان بادئة
  `toolu_` ثم `16..64` محرفاً أبجدياً رقمياً، أو معرّف مهمة من `6..64` محرفاً لاتينياً
  صغيراً/رقماً؛ الشكل المرصود بقي بطولي `30/9` أعلاه، أما النطاق المحدود فيتجنب تثبيت
  طول عينة لم يضمنه typings. يرفض المتحكم المعرّف المشوّه أو غياب الدور أو CLI الأقدم
  برسالة عربية بلا خطأ upstream. آلة حالات أحادية لكل `toolUseId` تشارك Promise الطلب
  المكرر، وتسجل الطلب قبل استدعاء SDK، وتخزن `task_notification` إن سبق حسم Promise ثم
  لا تبثه إلا بعد إثبات `true`. حجز النقل يمنع وصول `result` متزامنة من إغلاق Query؛
  وبعد نجاحه يبقى input مفتوحاً حتى الإشعار النهائي، ثم يغلق عند حسم آخر مهمة. كل تشغيل
  يحمل `internalPolicy` — السياقات المعزولة وعوامل غرفة العمليات — يرفض التحكم
  fail-closed ولا يستدعي الدالتين.
- **عقدا IPC**: `satr:backgroundTask {toolUseId}` يعيد
  `{ok:true,taskId?}` أو `{ok:false,error,message?}`، و`satr:stopSdkTask {taskId}` يعيد
  `{ok:true}` أو الغلاف الفاشل نفسه. يقبل `main.js` كائناً ذا مفتاح واحد مطابق فقط، يعيد
  فحص النمط، ويرفض أي محرك غير `sdk` بـ`unsupported` وأي تشغيل غائب بـ`no_active_turn`.
  الرد العام قائمة سماح؛ لا يعبر حقل SDK إضافي ولا رسالة يلتقطها `memory.hasSecret`.
  `preload.js` يكشف `backgroundTask(toolUseId)` و`stopSdkTask(taskId)` المحددتين فقط.
- **عقد الحدث الجديد**: الحدث المنقّى على `satr:event` هو
  `{type:'sdk_task_notification',taskId?,toolUseId,status:'completed'|'failed'|'stopped',summary?}`.
  يكون `taskId` إلزامياً عند إشعار SDK الحقيقي، ويغيب فقط في حسم محلي fail-closed إذا
  انتهت Query بعد نجاح النقل وقبل وصول `task_started`؛ عندها يكفي `toolUseId` لتحرير
  البطاقة اليتيمة. يُزال من `summary` التحكم وBidi وتُطوى الفراغات وتُقص إلى `300` نقطة
  Unicode، وتُحذف كاملة إن التقطها `memory.hasSecret`. لا يحمل الحدث `output_file` أو
  `usage` أو `uuid` أو `session_id` أو أي حقل SDK غير معلن. يستهلك المحرك
  `task_notification` الخام داخلياً ليولّد هذا الحدث و`task_update` القائم؛ الغلاف الخام
  لا يعبر إلى renderer أو المراقبين. وإذا وصل معرّف المهمة بعد حسم طلب النقل يبث الحدث
  المنقّى `{type:'sdk_task_started',taskId,toolUseId}` لربط الزر والمالك؛ لا يحمل عنواناً
  أو وصفاً أو حقلاً حراً. كل نص حر في دورة `task_started/task_updated/task_progress/
  task_notification` يُنظف من التحكم وBidi ويُقص ويمر عبر `memory.hasSecret` قبل إنشاء
  Ledger؛ الحقل الملتقط يسقط fail-closed. لا يحدّث إشعار مهمة الـLedger إلا إن شاهد Query
  نفسه `task_started` للمهمة، وتولّد حالات الإيقاف/الفشل المحلية snapshot من عقد
  `task_update` القائم بعد التنقية. لم يُضف عقد `task_update` جديد.
- **الواجهة والفصل الصريح**: كل بطاقة أداة SDK جارية تعرض بعد `15000ms` زر
  «⏳ انقله للخلفية». النجاح يغيّر حالتها إلى «يعمل في الخلفية»، ويربط معرّف المهمة بزر
  «⏹ إيقاف»؛ الحدث النهائي يحدّث البطاقة نفسها إلى مكتملة أو فاشلة أو موقوفة حتى لو وصل
  بعد `result`، والحسم المحلي بلا `taskId` يحرر البطاقة نفسها بدل تركها تحجب الجلسة.
  وصول أول `result` يحرر المؤلف فوراً ولا ينتظر انتهاء Query، لكنه لا يعلّم كتلة الدور
  منتهية قبل `proc_done`؛ أي `result` لاحقة للدور نفسه لا تعاد محاسبتها أو تمريرها إلى
  `block.finish/notifyTurnDone`. ينقل main المقبض إلى سجل SDK داخلياً مستقلاً، ويحافظ عليه
  عند بدء الدور التالي، ويسمح من التشغيل القديم فقط بأحداث SDK المنقّاة و`task_update`
  المتأخر عبر حارس `runSeq`. لا يعرض renderer snapshot متأخراً إلا إذا طابق `engine`
  و`session_id` الظاهرين. يبقى زر الإيقاف موجهاً دفاعياً في main إلى مالك `taskId`، وتُوقف
  المقابض المتبقية عند إغلاق التطبيق؛ التفريع/الاسترجاع يظلان fail-closed ما دام Query
  خلفي حياً، كما ترفض الواجهة جلسة جديدة أو استئناف جلسة أخرى أو تبديل المحرك كي لا تضيع
  البطاقة الوحيدة ذات زر الإيقاف. سجل البطاقات محلي داخل `<satr-chat>` ويُنظف بعد حسم
  المهام عند الجلسة الجديدة/إعادة بناء الخيط. هذه المهام ليست `termjobs` ولا `bgprocs`
  ولا Kimi keep-alive: لا PID أو PTY أو شريط عمليات مشترك، ولا تعديل في `execguard` أو
  محوّله للخوادم.
- **قفل الجلسة لنقل المستخدم وحده — شارة الخلفية عرضٌ لا قفل (بلاغ مالك 2026-09-10)**:
  شارة «يعمل في الخلفية» التي تضعها قناة `sdk_agent_progress{backgrounded}` (‏OBS-094 —
  ‏`is_backgrounded` من `task_started`/`task_updated.patch`، وتشمل كل `Bash` يشغّله
  النموذج بـ`run_in_background` وكل وكيل فرعي خلفي) كانت تستدعي `markSdkBackground`
  نفسها فتدخل قفل `hasSdkBackgroundTasks`، بينما main لا يتتبّع هذه المهام في
  `moveStates` ولا يعد بإشعار ختامي لها — فبقي القفل مغلقاً بعد الدور وحُجب «جلسة جديدة»
  وتبديل المحرك والمجلد واستئناف الجلسات **حتى إعادة تشغيل التطبيق**. الآن
  `markSdkBadgeBackground` في `chat.js` عرضٌ محض (لا `backgrounded` ولا زر إيقاف — main
  يردّ `not_found` لمهمة لم ينقلها المستخدم فالزر كان يكذب)، ونتيجة أداة الإطلاق (نص
  بديل فوري بنصّ `sdk.d.ts`) تغلق البطاقة مع إبقاء الشارة، و`observe` في
  `createSdkBackgroundController` يمرّر الإشعار الختامي المنقّى نفسه لمهام النموذج
  الخلفية (‏`modelBackgroundedTasks`) ويحسمها عند انتهاء Query بالصيغة نفسها، **بلا حجز
  input ولا Ledger إضافي**. الحرّاس: `test:chat-rtl` (القفل مفتوح بعد الشارة ونتيجة
  الإطلاق والإشعار؛ نقل المستخدم وحده يقفل — مُثبَت أنه يعضّ)، و`test:sdk-background`
  (تمرير الإشعار وعدم الحجز وبقاء الإيقاف مرفوضاً)، و`test:sdk-polish` (الفرع لا يستدعي
  `markSdkBackground`). حدّ مُصرَّح به: إيقاف مهمة خلفية بدأها النموذج غير متاح من
  الواجهة (سياسة `stopSdkTask` تشترط نقل المستخدم) — مسجَّل ملاحظةً.
- **حد upstream والتدهور**: typings توثق `backgroundTasks` لأداة `Bash` والعوامل الفرعية
  فقط؛ لا يوجد ضمان SDK لأداة MCP مثل `run_in_terminal`. لذلك قد يظهر الزر لبطاقة SDK
  طويلة ثم يعيد CLI `false` فتعود البطاقة لحالتها السابقة مع رسالة عربية، بلا تحويلها إلى
  سجل طرفية أو عملية خلفية أخرى. كما تعيد `backgroundTasks` boolean فقط ولا تعيد task ID؛
  يتعلمه سطر من `task_started`. أظهر التشغيل الحي نتيجتي `result` قبل إشعار الاكتمال، لذا
  إبقاء Query مفتوحاً حتى الإشعار جزء لازم من العقد وليس مهلة تخمينية.
- **حد الاستئناف المتزامن المثبت حياً**: في تشخيص تكميلي على SDK `0.3.176` وCLI
  `2.1.220` وأمر `Bash` مدته `18000ms`، نجح نقل الأداة
  `toolu_01CQgmb7JURSFWUT2QuvUjif` إلى المهمة `bglwklow3` (`true` بين
  `19877ms` و`19897ms`)، وانتهت نتيجة Query الأولى عند `22728ms`. بدأ Query مستأنف
  ثانٍ في الجلسة نفسها ونجح عند `25621ms` ثم انتهى عند `27938ms`، بينما وصل إشعار
  الاكتمال الحقيقي للأول عند `36625ms` وانتهى عند `38898ms`؛ سبق نجاح الثاني الاكتمال
  الحقيقي بـ`11004ms`. لكن Query الثاني تلقى داخلياً إشعار `task_notification:stopped`
  كاذباً عند `25573ms` لمهمة لم يشاهد لها `task_started`. هذه مفارقة upstream عند تشغيل
  Query مستأنف بالتوازي مع مالك المهمة القديم؛ سطر لا يعرض الغلاف الكاذب ولا يطبقه على
  Task Ledger، ويترك Query القديم وحده يرسل حالة `completed` الحقيقية. لا يستطيع الغلاف
  منع Claude Code نفسه من رؤية الإشعار الداخلي، لذا يبقى هذا قيداً موثقاً لا تسريباً
  لعقود الواجهة.
- **إعادة تحقّق (2026-09-07، ‏SDK `0.3.261` وCC `2.1.261` — ‏`OBS-137`)**: **مطابق
  حرفياً وبلا انحراف واحد** — وهو أثبت العقود الخمسة. `backgroundTasks` أعادت `true`
  منطقياً في `2ms` في السيناريوهين، و`stopTask` حُسمت `undefined` في `10ms`. وأطوال
  الملخّصات نفسها بالضبط: `completed` بطول **`83`** و`stopped` بطول **`38`**، ومعهما
  `output_file` و`tool_use_id` وغياب `usage` (`false`/`null`). ومعرّف الأداة `30`
  بادئته `toolu` والمهمة `9`. والحالات الحدّية كما هي: معرّف مجهول أثناء الدور يعيد
  `false` منطقياً و`undefined`، وبعد نهاية الدور يرفض الاثنان بـ
  `ProcessTransport is not ready for writing` — فتحويلها إلى خطأ عربي ثابت يبقى لازماً.
- **التحقق**: `npm run test:sdk-background` يغطي الأنماط والتنقية وقائمة سماح IPC، رفض
  غير `sdk` وغياب الدور وCLI الأقدم، سباق `result` والإشعار السابق لحسم التحكم والطلب
  المكرر، حسم الإيقاف وبطاقة النقل التي تنتهي بلا `taskId`، تحرير المؤلف بلا محاسبة
  النتيجة المكررة، حراسة مسارات الجلسة والمحرك، مطابقة Ledger المتأخر، توجيه الإيقاف إلى
  المالك، عقد الحدث وتنقية كل نصوص lifecycle وعدم تسريب الغلاف الخام، عزل كل
  `internalPolicy`، مؤقت الواجهة، وعدم لمس سجلات `termjobs/bgprocs/Kimi`؛ وهو مسجل داخل
  `test:full`. المسبار الحي يبقى خارج
  الحزمة عمداً مثل بقية مسابير SDK. آخر تشغيل مستقل طبع
  `sdk-background-test: ok — التحكم وIPC والحدث والواجهة والعزل وفصل السجلات`، ونجح
  `npm run eval:agent` بـ`12/12` مع المخرجات
  `dist\agent-eval\2026-07-26T22-11-53-950Z`. لم تُشغّل `test:full` محلياً التزاماً
  بتنسيق الجولة؛ يشغّلها قائد الفريق عند المراجعة.

