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
  إلى خطأ عربي ثابت، ولا يستدعي `stopTask` إلا لمعرّف مهمة تعلّمه من SDK ولم يُحسم بعد.
  ⚠️ **صيغة هذا البند تغيّرت بقرار معلن (OBS-151، 2026-09-15)**: كانت «وربطه بأداة نقلها
  المستخدم فعلاً» فصارت «عبر `task_started` في هذه Query نفسها ولم يُحسم بعد» — التفصيل في
  قسم «قناة حالة الوكلاء الأحياء وبقاء Query» آخر الملف.
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
- **ملكية لقطة الجوال (OBS-148، 2026-09-09)**: باعث التشغيل يمرّر هويته الداخلية
  إلى `publishMobileTaskState`؛ الحدث القديم لا يعدّل أصل لقطة الهاتف ولا ينشرها.
  مهام SDK تُختزل من حدث الدور نفسه في `mobileTaskSnapshot` تصفّر عند البدء،
  عبر `tasks.reduceSnapshot` المشترك مع دفتر الجلسة. لا يُعاد نشر الدفتر المشترك
  في تحديث B كي لا يحمل تغييرات A المتأخرة في الجلسة نفسها. الهاتف يعدّ مهام
  الدور الحالي، والدفتر المكتبي يبقى تراكمياً؛ حفظ الخلفية وإشعاراتها وملكيتها
  باقية. بقية المحركات تعرض الدفتر المقبول كما سابقاً. حارس
  `scripts/mobile-task-owner-test.js` ضمن `test:sdk-background` يثبت سبعة
  سيناريوهات بأحداث مضبوطة ومنطق الإنتاج، لا بمحرك أو هاتف حيّ؛
  [الأدلة والعضّات والحدود](docs/OBS-148-TEST-EVIDENCE.md).

- **رسالة حالة الجوال عبر الأدوار (تجربة حية 2026-09-09)**: إقرار إيقاف A يخص A؛
  عند قبول لقطة ذات run مختلف يتجدد نص الاتصال قبل رسم الحالة. نبضات run نفسه
  تحفظ تأكيده؛ لا تمس pendingStop أو حراس الإقرار المتأخر. القشرة satr-pwa-v16.
  حارس DOM72 يشمل الجانبين، وقد سقطا بزرعين فعليين. نجح طقم الجوال9/9 والتجربة
  الحية على بناء مطابق، [بحدودها المعلنة](docs/MOBILE-LIVE-20260909-EVIDENCE.md).

- **تأكيد إيقاف الجوال (OBS-147، 2026-09-09)**: `HTTP 202` إيصال إيداع،
  و`stopAll`/`proc_done` ليسا دليل انتهاء. ينتظر main `done` للمقبض الملتقط
  قبل نشر `stopped` ويعيد فحص رقم التشغيل ورمزه. Codex ينتظر exit وتنظيف MCP؛
  Kimi ينتظر نهاية prompt المؤكدة أو خروج القناة وتنظيفها، بلا حسم عند مهلة cancel.
  يطابق الهاتف `command_result` بـ`command_id` و`run`، ويعلن عدم التأكد عند
  المهلة أو غياب دليل موثوق. `stopAll(false)` يبقي سجل SDK الخلفي المنفصل؛
  الخلفية التابعة للتشغيل الجاري تتوقف معه. حراس الطرفين والنقل والمحركات
  داخل `test:mobile-integration`، وحارس الرسم داخل `test:pwa-dom`.
  [العقد](docs/MOBILE-CONTROL-PLAN.md) · [الأدلة والحدود](docs/OBS-147-TEST-EVIDENCE.md).

- **قشرة الهاتف في تسليم 2026-09-09**: الخط المضمّن نفسه يُنسخ إلى `pwa/fonts`
  عبر `vendor-fonts.js` وتُحمّل `fonts.css` محلياً؛ يقدّم `mobilelink` امتداد
  `woff2` بـ`font/woff2` ضمن حصر الجذر القائم. رُفع تباين `--text-faint`
  واستُعمل الوزن 700 المضمّن بدل 600. كاش `satr-pwa-v15` يشتق عناوين القشرة
  من موضع العامل، للجذر و`/pwa/`، ويستثني الأصول الخارجية وطلبات API.
  حارسا القرائية والكاش داخل `test:pwa-dom` يستدعيان منطق الإنتاج؛
  [قياس القرائية والعضّات](docs/PWA-READABILITY-EVIDENCE.md) و[دليل الكاش](docs/PWA-SW-EVIDENCE.md).

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


#### طلب الإذن من وكيل فرعي خلفي بعد انتهاء الدور (OBS-208 — 2026-09-14)

- **العطل المقيس**: وكيل فرعي أُطلق خلفياً (`Agent` بـ`run_in_background`) وطلب إذناً بعد أن
  انتهى دور Query الأصلي وبدأ دور جديد. `canUseTool` في `agent.js` يبثّ `permission_request`
  برمز الدور القديم، ومرشّح `runSeq` في `main.js` كان يُسقطه «بائتاً» (الاستثناء كان لإشعارات
  المهام الخلفية وحدها). فيبقى وعد الإذن بلا ردّ حتى يغلق Claude Code قناة الإذن
  (`Tool permission stream closed`) ويرفض كل ما بعدها بنصّه الإنجليزي «The user doesn't want
  to take this action right now» — ورآه المالك رفضاً غامضاً بلا مربع إذن. المسبار في المقدمة
  (الدور الحيّ) نجح في الكتابة والتعديل والصدفة في نسخة العمل ومجلد الجلسة، فحصر العطل
  بالمسار الخلفي.
- **الإصلاح**: `lateSdkBackgroundEvent` يشمل الآن `permission_request` و`question_request` حين
  يكون مصدرهما Query في `sdkBackgroundRuns`؛ والواجهة تعالج طلب الإذن ولو انتهت الكتلة أصلاً.
  والردّ يعود إلى مالكه: `resolvePermissionThroughCurrentHandles` و`satr:answerQuestion`
  يجرّبان `sdkBackgroundRuns` بعد الدور الحالي — المعرّف يحسم المالك ولا يُسند لغيره.
- **الحارس**: `npm run test:subagent-permission` (‏23 فحصاً بعد توسيع OBS-207، ضمن `test:full`) يشغّل المرشّح
  ومسارَي الردّ من نصّ `main.js` الإنتاجي في صندوق بمحرك بديل يعدّ الردود: الطلب والسؤال
  الخلفيان يصلان ويعودان إلى الدور الخلفي نفسه؛ والبثّ المتأخر ما زال بائتاً؛ ودور انتهى بلا
  مهام خلفية لا يمرّر طلباً متأخراً ولا يجد مالكاً؛ والمعرّف المجهول يُرفض. فحصا طفرة (إسقاط
  التوسيع · إسقاط توجيه الردّ) يُسقطانه عند الفحص المعني.
- **حدود مُصرَّح بها**: الإصلاح لمحرك SDK وحده (Codex وKimi بلا وكلاء خلفيين عبر هذا المسار).
  طلب `elicitation` من وكيل خلفي لم يُقَس ولم يُوسَّع له. السطح المرئي للوكيل الخلفي
  (‏OBS-207) ما زال ناقصاً: الطلب يظهر في مربع الإذن باسم الطالب، لكن لا بطاقة حيّة له.
  قاعدة التشغيل حتى قبول الإصلاح بشرياً: المنفّذون في المقدمة.
  **حُلّ الشقّ الأخير في القسم التالي** (‏OBS-207/151، 2026-09-15).


#### قناة حالة الوكلاء الأحياء وبقاء Query (OBS-207/151 — 2026-09-15)

- **القياسات السبعة** (مسبار حيّ `D:\sater\agents-live-probe\probe.mjs` ونتيجته
  `result.json`، ‏SDK `0.3.270` وCLI `2.1.270 (Claude Code)`، النموذج `sonnet`، دوران:
  إطلاق وكيل خلفي ثم استئنافه بـ`SendMessage`):
  1. **`agentID` في `canUseTool` == `task_id` حرفياً**: `a1cadac9484258db2` (‏17 محرفاً من
     `[a-z0-9]`، يطابق `SAFE_SDK_TASK_ID`). وهو نفسه `requester` الذي يبثّه `agent.js` في
     `permission_request`، ونفسه قيمة `to` في أداة `SendMessage`. فمعرّف المهمة هو **مفتاح
     الربط الوحيد** بين مربع الإذن والسطح الحيّ.
  2. **الاستئناف بـ`SendMessage` في دور لاحق يولّد `task_started` جديداً بالمعرّف نفسه**
     (‏`a1cadac9484258db2`) وبـ`tool_use_id` جديد هو معرّف أداة `SendMessage`
     (‏`toolu_01Fe9aJLKrhbVCLfAmJmMty7` للإطلاق مقابل `toolu_01LNHDNVCgrHk1sKiCesmZqF`
     للاستئناف)، ومعه `is_backgrounded: true` و`description` الأصلي («probe agent») و
     `subagent_type` و`task_type: 'local_agent'` و`spawn_depth: 1` و`prompt` (نصّ الرسالة).
     فـ`resumed` يُحسم بـ«هل رأت هذه Query بداية هذا المعرّف من قبل؟» لا بحقل من SDK.
  3. **`background_tasks_changed` بدلالة REPLACE**: يصل قبل `task_started` مباشرةً بقائمة
     **كاملة** `[{task_id, task_type, description, ambient?}]` (‏seq 7 ثم 29)، ويصل ثانيةً
     **بقائمة فارغة** (‏seq 17 ثم 39) قبل `task_updated{status:'completed'}` و
     `task_notification`. فالقائمة الفارغة = خمول، وهي إشارة الإفراج المقيسة.
  4. **`task_progress`** يحمل `description` **متغيّراً** («Writing PROBE_A.txt» ثم
     «Writing PROBE_B.txt») و`tool_use_id` مقطع الإطلاق/الاستئناف الحالي؛ `summary` قد يغيب.
  5. **`task_notification`** يصل لكل مقطع (إطلاق واستئناف) بـ`tool_use_id` مقطعه و`status`
     و`summary` (نصّ ردّ الوكيل الأخير: `AGENT_DONE_1` ثم `AGENT_DONE_2`).
  6. **بعد كل `task_notification` يشغّل CLI دوراً تلقائياً** في الجلسة نفسها (`init` →
     `assistant` → `result`) يسلّم النموذجَ نتيجة الوكيل — أي أن Query القديمة تبثّ
     `assistant`/`result` بعد نتيجة الدور الأصلية (‏`result:4` في دورين). خارج نطاق هذه
     الدفعة، لكن `result` الثانية ليست خطأ ولا تُعامل معاملته.
  7. **`parent_agent_id` لا يصل في البثّ الحي** (مثبت سابقاً في
     `scripts/subagent-tree-probe.js`) — لا يُعتمد عليه في الربط.
- **العطل المقيس**: `createSdkBackgroundController.hasSdkBackgroundTasks()` كانت تعيد
  `moveStates.size > 0` — أي **نقل المستخدم وحده**. وكيل خلفي أطلقه النموذج
  (‏`is_backgrounded`) كان يبقى في `modelBackgroundedTasks` فقط، فلا تدخل Query في
  `sdkBackgroundRuns` بـ`main.js`، فترتّب على ذلك ثلاثة: (أ) الإرسال التالي يستدعي
  `stopAll(false)` فيوقف `currentRun` و**يقتل الوكيل الخلفي**؛ (ب) شرط
  `lateSdkBackgroundEvent` (إصلاح OBS-208) يشترط `sdkBackgroundRuns.has(run)` فطلب إذن ذلك
  الوكيل بعد انتهاء الدور يبقى بائتاً رغم الإصلاح؛ (ج) `promptSuggestionGate` يغلق `input`
  عند `result` لأن `holdInput` لم يكن يُستدعى إلا لنقل المستخدم.
- **العقد الجديد** — حدث منقّى واحد على `satr:event` بخمسة أنواع (يضاف ولا يستبدل:
  `sdk_agent_progress` و`sdk_task_started` و`sdk_task_notification` و`task_update` تبقى كما
  هي، فبطاقة الكتلة ودفتر المهام يستهلكانها):
  - `{type:'sdk_agent_state',taskId,kind:'started',toolUseId?,description,subagentType?,taskType,backgrounded,spawnDepth?,resumed}`
  - `{type:'sdk_agent_state',taskId,kind:'progress',toolUseId?,description?,summary?}`
  - `{type:'sdk_agent_state',taskId,kind:'updated',status?,description?,error?,backgrounded?}`
  - `{type:'sdk_agent_state',taskId,kind:'finished',toolUseId?,status,summary?,local?}`
  - `{type:'sdk_agent_state',kind:'live',taskIds:string[]}`
  يولّده `sdkAgentStateEvent(message, ctx)` **النقية** في `agent.js` (مصدَّرة للاختبار،
  و`ctx.seen` مجموعة المعرّفات التي رأت هذه Query بدايتها). `started` لـ`task_type` من
  `local_agent` و`local_bash` فقط؛ `status` في `updated` من قائمة سماح
  (`pending|running|completed|failed|killed|paused`) وفي `finished` من
  `completed|failed|stopped`. كل نص حرّ يمرّ بـ`safeSdkTaskText` (تنظيف التحكم وBidi، قصّ
  `300` نقطة Unicode، إسقاط كامل عند `memory.hasSecret`)، والمعرّفات تُفحص بـ
  `SAFE_SDK_TASK_ID`/`SAFE_SDK_TOOL_USE_ID`، ومهام `ambient`/`skip_transcript` تُستبعد. لا
  يعبر `prompt` ولا `output_file` ولا `usage` ولا `uuid` ولا `session_id`. و`local:true`
  يميّز الحسم **المحلي** (انتهاء Query أو إيقاف الدور) بملخص عربي ثابت، فلا تعرضه الواجهة
  بوصفه نتيجة الوكيل.
- **«مهمة حيّة» — التعريف المنفَّذ**: مهمة بدأها النموذج خلفياً تدخل `modelLiveTasks` عند
  `task_started{is_backgrounded}` أو `task_updated.patch.is_backgrounded`، وتخرج منها بأحد
  ثلاثة: غيابها عن آخر قائمة `background_tasks_changed` (دلالة REPLACE — القياس 3)، أو
  وصول إشعارها الختامي، أو نهاية Query. و`hasSdkBackgroundTasks()` صارت
  `moveStates.size > 0 || modelLiveTasks.size > 0`، ويُستدعى `holdInput` عند أول مهمة حيّة
  و`closeInput` عند خلوّ الاثنين (مع بقاء شرط `resultSeen` — فالإفراج لا يسبق نتيجة الدور).
  `finish()` يبثّ `finished{local:true}` لكل مهمة حيّة **معروفة** (نقل المستخدم، وخلفية
  النموذج، وكل مهمة رأينا بدايتها ولم يصل إشعارها) لا لمهام `moveStates` وحدها كما كان.
- **قرار توسيع الإيقاف (OBS-151 — بقرار معلن لا تسلّلاً)**: سياسة `stopSdkTask`/`ownsSdkTask`
  كانت «مهمة نقلها المستخدم بنفسه» (‏`moveStates[toolUseId].status === 'backgrounded'`)،
  فصارت **كل مهمة شاهدت Query نفسها `task_started` لها ولم تُحسم بعد** — نقل المستخدم أو
  خلفية النموذج سواء. الأساس المقيس: `query.stopTask(taskId)` يُحسم `undefined` لأي معرّف
  يعرفه CLI أثناء حياة Query، ويرفض بعدها بـ`ProcessTransport is not ready for writing`
  (يُحوَّل إلى الخطأ العربي الثابت، ولا يُستدعى أصلاً لأن `active=false` يردّ
  `no_active_turn`). المجهول يبقى مرفوضاً `fail-closed`، والمحسومة لا تُوقف ثانيةً،
  والاستئناف يعيدها حيّة بالمعرّف نفسه فتصير قابلة للإيقاف من جديد. تبعاً لذلك **انقلب
  بندان في `test:sdk-background`** بقرار واعٍ ومعلن في رسالة الالتزام وفي الحارس نفسه:
  «Query لا تُحجز لمهمة لم ينقلها المستخدم» و«إيقاف مهمة النموذج الخلفية يبقى مرفوضاً» —
  البند القديم في هذه الوثيقة («لا يستدعي `stopTask` إلا لمعرّف تعلّمه من SDK وربطه بأداة
  نقلها المستخدم فعلاً») يُقرأ من اليوم: **إلا لمعرّف تعلّمه من SDK عبر `task_started` في
  هذه Query نفسها ولم يُحسم بعد**.
- **`main.js`**: `sdk_agent_state` أُضيف إلى `lateSdkBackgroundEvent` فيعبر من Query انتهى
  دوره وبقي في `sdkBackgroundRuns`؛ ويُسجَّل المالك في `sdkTaskOwners` عند
  `kind:'started'` إن أقرّ `ownsSdkTask` (بجانب التسجيل القائم عند `sdk_task_started`)،
  ويُسحب عند `kind:'finished'`. لا عقد IPC جديد ولا تعديل في `preload.js`: `satr:stopSdkTask
  {taskId}` القائم يكفي.
- **الأثر المقبول والموثَّق**: `runSdkSessionControl` (التفريع/استرجاع الملفات) يبقى مشغولاً
  ما دام وكيل خلفي حيّاً — رسالته العربية القائمة («انتظر انتهاء دور Claude أو مهمته
  الخلفية…») تكفي. والجلسة الجديدة/تبديل المحرك يستدعيان `stopAll(true)` فتُوقَف Queries
  الخلفية ⇒ تصل الواجهةَ `finished{local:true,status:'stopped'}` فلا يبقى سطر معلّق.
- **حدود مُصرَّح بها**: (١) الحدث يُنقّى في `agent.js` ولا يُعاد تنقيته في `main.js` — نظير
  `sdk_task_notification` القائم، لا استثناء جديد. (٢) القياسات من دور مسبار واحد بنموذج
  `sonnet` وعمق تفريع 1؛ الوكيل الأعمق (`spawn_depth > 1`) لم يُقَس حياً وإن كان الحقل
  يعبر. (٣) القياس 6 (الدور التلقائي بعد الإشعار) لم يُعالَج في هذه الدفعة — مسجَّل ملاحظةً.
  (٤) الإفراج عند القائمة الفارغة مشروط بوصول `result`؛ لو لم يبثّ CLI
  `background_tasks_changed` أصلاً فالإفراج من الإشعار الختامي أو نهاية Query (لا تعليق إلى
  الأبد)، وهو محروس. (٥) لا قياس حيّ لهذا الإصلاح نفسه بعد — الحرّاس صندوقية بأشكال المسبار.
- **التحقق**: `npm run test:sdk-agent-state` (جديد، ضمن `test:full`) يغطي الأنواع الخمسة
  وتنقيتها والاستئناف وambient والسرّ والإشعار الكاذب ودلالة REPLACE وحجز/إفراج input
  وسياسة الإيقاف وحدودها، بثلاثة فحوص طفرة موسومة `⭐` (إسقاط توسيع `hasSdkBackgroundTasks`
  يُسقطها). و`npm run test:sdk-background` مُحدَّث بالبندين المنقلبين. و
  `npm run test:subagent-permission` أضيف إليه سيناريو محرك بديل تُشتق فيه
  `hasSdkBackgroundTasks` من مهام النموذج: قبل التوسيع يوقف الإرسالُ التالي Queryَ الوكيل
  الخلفي ويبقى طلب إذنها بائتاً، وبعده تنجو ويصل طلبها ويعود إليها.
