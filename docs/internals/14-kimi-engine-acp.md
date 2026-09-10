### محرك Kimi Code الأصيل (ACP — 2.10.0)

- **الفصل المقصود**: `electron/kimi.js` محرك خاص ثالث مثل `agent.js` و`codex.js`، باسم
  `kimi-code` ووسم «Kimi Code — اشتراك». يشغّل `kimi acp` ويتكلم ACP v1 كـ JSON-RPC
  مفصول بأسطر فوق stdio؛ لا يحلّل خرج TUI ولا يعتمد على `KIMI_API_KEY`. المصادقة من
  اشتراك Kimi المحلي: مثبّت Windows الرسمي المستقل (المفضّل) أو
  `@moonshot-ai/kimi-code` مع Node 22.19+، ثم `kimi login`. خيار `kimi` القديم
  باقٍ بوسم «Kimi K3 — مفتاح API» كاحتياط مستقل.
- **استمرارية حقيقية**: التسلسل `initialize → session/new|session/resume → session/prompt`.
  معرّف Kimi نفسه يصل إلى الواجهة عبر حدث `system`، والإيقاف يرسل notification
  `session/cancel` وينتظر تفريغ الدور ثم يحرّره **دون قتل العملية** (K2)؛ الرسالة التالية
  على الجلسة نفسها تستأجر القناة الحية من سجل keep-alive (لا spawn ولا initialize ولا
  session/new)، وإن غابت عن السجل تستدعي `session/resume` بنفس المعرّف. إن رد إصدار
  أقدم بـ`methodNotFound` يتراجع إلى
  `session/load` مع كتمان بث التاريخ المعروض أصلاً. لذلك لا تضيع معرفة المهمة عند إيقاف
  الدور كما كان يحدث لمسار REST قبل حفظ النتيجة.
- **الجلسات والتصدير**: IPC المحدد `listKimiSessions/readKimiSession` يستعمل
  `session/list` و`session/load` الرسميين عبر عملية ACP قصيرة؛ لا يفسّر بنية
  `~/.kimi-code/sessions/**/wire.jsonl` الخاصة. لوحة `/جلسات` تعرض Kimi مع المجلد
  والتاريخ، والاستئناف يعيد المحرك والمجلد والخيط. تصدير Markdown يقرأ المصدر نفسه.
  وفاء العرض (2026-07-21): MAX_SESSIONS ‏80→200 (سقف صفحات 10) وMAX_MESSAGES ‏40→120،
  و`readSession` يلتقط نداءات الأدوات من إعادة بث `session/load` كعناصر `tool_use`
  (اسم معرّب + حالة نهائية، مدخلات منقاة) تعرضها الواجهة كسجل تنفيذ منجز؛ الفروقات
  التاريخية غير ملتقطة (قرار نطاق).
- **الأحداث**: `agent_message_chunk` → `stream_text/assistant`، و`tool_call*` →
  `tool_use/tool_result`، و`plan` → `task_update`، و`usage_update.cost` → تكلفة النتيجة.
  مدخلات الأدوات المنسوخة للأحداث مقصوصة، ويُحجب منها تكرارياً
  أي حقل token/key/password/secret/cookie؛ سقف سطر ACP ‏4MiB وسقف نص نتيجة أداة 20KiB.
  التفكير الحي مُعرض: `agent_thought_chunk` يُبثّ كنص `stream_text` بـ `phase: commentary`
  ويُدمج في رسالة `assistant` بكتلة `phase: commentary` منفصلة عن الإجابة النهائية
  (نفس تطبيع `thinking` في SDK)؛ سقف القصّ وحجب الأسرار مطبّقان، ولا يُدرَج في تصدير
  Markdown. جسّ 0.27.0 أكّد وصول 83 كتلة تفكير في دور واحد.
- **تسميات عربية للأدوات**: خريطة `KIMI_TOOL_LABELS` + `toolLabel()` تغطي
  Agent/AgentSwarm/Cron*/Task*/TodoList/أدوات الهدف/Bash/Edit وغيرها، وتُطبَّق عند
  الانبعاث فقط — الحالة الداخلية والأذونات تبقى بالعنوان الخام. بطاقات الوكيل الفرعي
  في `chat.js` تقبل «وكيل فرعي» و«سرب وكلاء»؛ `addNotice` يقبل نصاً أو عنصر DOM
  (مثل إشعار تسجيل الدخول مع زر).
- **أوامر ACP المعلنة**: يلتقط `kimi.js` إشعار `available_commands_update` ويمرره كحدث
  `system/available_commands` بـ `commands[{name,description}]`. قائمة أوامر «/» في الواجهة
  تُضمّن أوامر Kimi المعلنة ديناميكياً (مع `engines:['kimi-code']`) بدلاً من ثبات
  `/حالة /مهام /مساعدة`، مع استبعاد ما تغطيه الأوامر العربية الأصلية (`compact` و
  `usage/context` تُخفيان لصالح `/ضغط` و`/سياق`).
- **JSON-RPC ثنائي الاتجاه**: طلبات Kimi العكسية (`fs/*` و`session/request_permission`) تملك فضاء
  معرّفات مستقلاً وقد يتطابق `id` فيها مع طلب صادر مثل `session/prompt`. لذلك يصنّف العميل الرسالة
  ذات `method` كطلب عكسي أولاً، ولا يطابق `pending` إلا لرسالة الرد بلا `method`. إصلاح 2.9.8 يمنع
  إنهاء الدور كاذباً بعد `Read` ويضمن بلوغ طلبات الأذونات اللاحقة؛ يغطيه اختبار اصطدام صريح وحيد.
- **الأذونات**: `session/request_permission` يمر بمربع سطر العربي ويعيد optionId من
  خيارات ACP الفعلية (`allow_once/allow_always/reject_*`). أوضاع plan/acceptEdits/
  bypassPermissions تُطبّق في العميل، والموافقة الدائمة بعمر التطبيق. أوامر خادم
  التطوير تُرفض وتوجّه إلى `run_in_background`، وفتح متصفح خارجي يُحجب لصالح معاينة
  سطر إلا بطلب المستخدم الصريح ثم إذن منفصل.
- **Filesystem fail-closed**: يعلن العميل `fs.readTextFile/writeTextFile` ولا يعلن
  terminal reverse-RPC. كل `fs/*` يقبل مساراً مطلقاً حقيقياً داخل cwd فقط مع منع هروب
  symlink؛ والاستثناء الوحيد ملف خطة Kimi النشط المطابق للجلسة تحت
  `~/.kimi-code/sessions/wd_*/session_{id}/agents/main/plans/*.md` كي تعمل دورة
  `Write → ExitPlanMode` بلا فتح بقية مجلد بيانات Kimi. القراءة/الكتابة ≤2MiB والقراءة
  ≤20000 سطر/نداء. الكتابة تحتاج منحة تعديل فعالة حتى لو حاول الوكيل تخطي طلب الإذن،
  وتصدر تعديلات المشروع `file_edit` بفرق ≤600 سطر ولقطة تراجع.
- **أدوات سطر**: عند السماح بالمتصفح يبدأ خادم `codexmcp.js` المحلي نفسه برمز Bearer
  عشوائي ويمرر إلى `session/new/resume` كـ MCP HTTP؛ بذلك يحصل Kimi على المعاينة، أدوات
  المتصفح، الخلفية، التسليم البشري والبرومو بنفس بوابات Codex، ويضيف داخلياً أدوات
  `load_skill/read_skill_resource` و`verification_config/verify_project` و
  `update_task_ledger/propose_memory` بعقود `tools.js` نفسها. لا تأتي تعريفات MCP من
  renderer أو المشروع. موجز
  `envbrief` يعامله محركاً أصلياً ويحقن كـ ACP embedded resource بعد رسالة المستخدم،
  ومعه كتالوج المهارات وذاكرة المشروع المقصوصة.
- **حد upstream صريح**: إصدار Kimi ACP الحالي لا يوصل `terminal/*` العكسي؛ أوامر Bash
  تنفذها عملية Kimi المحلية بعد إذن سطر وتظهر كأداة ونتيجة في المحادثة، لا كتبويب PTY.
  لذلك يُرفض خادم التطوير المدمج ويُستخدم MCP `run_in_background` المرئي. التحضير
  لـ terminal reverse-RPC مسبقاً: يُفحص `agentCapabilities.terminalCapabilities.reverseRpc`
  عند `initialize` ويبقى معطّلاً حتى يُعلنه Kimي صراحةً؛ عندها فقط نُعلن قدرة العميل
  terminal ونوجّه الأوامر إلى تبويبات pty المرئية. لا دعم مُدّعى غير موجود.
- **تفريع الجلسات (OBS-048)**: منذ Kimi 0.38.0 صارت `session/fork` متاحة وتتطلّب
  `{sessionId, cwd}` وتعيد `{sessionId, configOptions, modes}`. «سطر» يستعملها كتفريع
  من النهاية فقط — الزر «🌿 فرّع من هنا» يظهر على آخر رسالة مستخدم، وعند النقر تُنشأ
  جلسة فرعية تحمل كل السياق السابق وتُبدّل `sessionId` في الواجهة. `upToMessageId` يُمرَّر
  إن وُجد لكن سلوكه لم يُثبت بالجسّ الحقيقي على 0.40.1، لذا تُعامل الدفعة كاملة كتفريع
  من النهاية.
- **حدود upstream مؤكدة بالجسّ الحقيقي على Kimi 0.27.0 (2026-07-21)**:
  Steering مرفوض — `session/prompt` أثناء دور جارٍ يرد بـ
  `-32600 "Cannot launch a new turn while another turn (ID 0) is active"`.
  التفريع وundo للرسائل غير موجودين: `session/fork` و`session/undo` تردان
  `-32601 Method not found`. و`/goal` `/plan` `/btw` `/swarm` غير معلنة كأوامر مائلة
  عبر ACP — المعلن فقط: compact, status, usage, mcp, tasks, help (أدوات الهدف وcron
  تعمل كأدوات نموذج أثناء الدور وتظهر بطاقاتها). وإطلاقات cron واستمرارات الهدف بين
  الأدوار كانت لا تصل لأن سطر كان يقتل عملية `kimi acp` بعد كل دور — K2 أبقى القناة
  حية وجهّز جسر `kimi_keepalive_event`، لكن المسابير الحية (K3-ب لـ cron وK5-ب للهدف،
  2026-07-27) رصدت أن Kimi 0.27.0 لا يبث إطلاق cron ولا استمرار الهدف على قناة
  الجلسة أصلاً: القناة بقيت حية في السجل 150 ثانية بلا أي حدث متأخر في كلتيهما.
  حدّ upstream موثّق في `docs/KIMI-CAPABILITIES.md`؛ الجسر مفعّل ومختبَر بإشعارات
  مصطنعة ويعمل فور بثّ Kimi. وeffort يبقى غير معلن
  (thinking=on فقط ضمن configOptions).
- **Keep-alive (K2 — 2026-07-25)**: قناة ACP (العملية + RPC + خادم MCP) تبقى حية بعد
  end_turn في سجل `electron/kimi-keepalive.js` (نسخة لكل `create()`), وتُستأجر للدور
  التالي على `sessionId` و`cwd` نفسيهما فلا تتكرر initialize/session-new ولا يُرسل
  `session/cancel` عند نهاية الدور. الضمانات غير قابلة للتفاوض: **سقف عمليتين حيتين**
  (الثالثة تطرد الأقدم خمولاً بلا دور نشط؛ وامتلاء السقف بأدوار نشطة يرفض التسجيل
  فيكمل الدور كعملية لكل دور تُدمَّر عند نهايتها — سقوط رشيق)، **خمول 15 دقيقة**
  يقتل القنوات الخاملة (فحص كل 60 ثانية بمؤقّت unref)، **لا أيتام**: `killAll` في
  `cleanupBeforeQuit` ومعالج `exit` يزيل المدخل من السجل. ربط الدور بالقناة قابل
  للتبديل عبر `shared.turn` (جسر RPC ومعالجات العملية وخادم MCP يفوّضون إلى الدور
  النشط فقط)، فلا يعلق emit دورٍ ميت في معالجات طويلة العمر، وطلبات الوكيل بلا دور
  نشط تُرفض بلطف (الأذونات تُلغى). زر إيقاف الدور يبقي الجلسة حية؛ القتل الكامل من
  شريط bg_procs فقط: عناصر `ks_<sessionId>` مدمجة مع عمليات الخلفية عبر
  `emitBgProcsMerged` في main.js، و`satr:killBgProc` يوجّه البادئة `ks_` إلى
  `kimi.keepalive.kill`. `applyConfigOptions` يعيد تطبيق model/effort/thinking/mode
  على القناة المستأجرة من configOptions المخزّنة. وسياق المهارات مرجع حيّ
  `shared.skillContextRef` يُحدَّث كل دور (K3-أ): إغلاقات `extraTools` تحلّه وقت
  النداء فيرى الدور المستأجر اختياره الحالي ولا يتسرّب اختيار دور البناء — زال بذلك
  قيد K2 الموثق («أدوات MCP تبقى بسياق الدور الأول»).
- **عقد `kimi_keepalive_event` (schema)**: نشاط الوكيل بين الأدوار (cron/هدف) يصل على
  قناة حية بلا دور نشط فيُبثّ للواجهة إشعاراً مؤقتاً — لا يُدرج في سجل المحادثة —
  بعد مروره ببوابة الحجب والقص نفسها المطبقة على أحداث الدور (قرار القائد أ).
  الحقول والسقوف: `type` ثابت `kimi_keepalive_event` · `sessionId` مطابق
  `SAFE_SESSION` ‏(≤128) · `kind` ∈ `message|thought|tool|plan` · `text` محجوب
  الأسرار ومقصوص ≤4000 حرف بعلامة `…` · `tool` (لـ kind=tool فقط) ≤120 · `status`
  (لـ kind=tool فقط) ∈ `completed|failed|cancelled` · `at` ‏epoch ms. نصوص
  message/thought المجزّأة تُجمَّع حسب `messageId` وتُبث بعد سكون 800ms؛ تحديثات
  الأدوات غير المنهية (pending/in_progress) وusage/available_commands لا تُترجم
  إشعارات. الواجهة (`app.js`) تعرضها عبر `showTransientNotice` بلا أي حالة محادثة.
- **خيار thinking**: إن أعلن `configOptions` خيار `thinking` (Kimi 0.27.0 يعلنه `on`) يظهر
  مفتاح صغير في شريط الوعي لمحرك `kimi-code` (مكان الجهد المعطّل) ويُطبَّق القيمة عبر
  `session/set_config_option` دون كتابة `config.toml` العام. غياب الإعلان = لا مفتاح ولا
  إعداد يُرسل.
- **مساعد تسجيل الدخول**: عندما يُبلّغ `satr:kimiStatus` أن Kimi Code مثبَّت لكنه غير
  مسجّل الدخول، تُعرض الواجهة زر «سجّل الدخول» بدلاً من الإرشاد النصي فقط. الزر يشغّل
  `kimi login` في طرفية النموذج المرئية (`termjobs.startJob`) ولا يُدخل أي credential
  تلقائياً — المستخدم يُكمل خطوات OAuth يدوياً في التبويب.
- **مسبار القدرات الدائم**: `scripts/kimi-capability-probe.js` يفحص الإصدار المثبَّت
  فعلياً (steering، fork/undo، effort/thinking/mode، terminal، الأوامر المعلنة) ويقارنه
  بخط الأساس في `docs/KIMI-CAPABILITIES.md`، ويطبع أي فرق واضح. يُشغَّل يدوياً بعد كل
  ترقية Kimi.
- **حالة الجاهزية**: `satr:kimiStatus` وpreload المحدد يعيدان installed + نوع اعتماد فقط،
  بلا مسار ثنائي أو credential. `/كيمي-حالة` والتنبيه عند الاختيار يرشدان إلى التثبيت/
  `kimi login`. لا تسجيل دخول أو تثبيت تلقائيان.
- **تكافؤ المرحلة الرابعة**: ناتج `session/new|resume.configOptions` هو مصدر إعدادات الجلسة؛
  اختيار `k3` يطابق القيمة المعلنة `kimi-code/k3` ويضبطها عبر `session/set_config_option` قبل
  البرومبت. النماذج ديناميكية (2026-07-21): `kimi.listModels()` بنمط withProbe وcache دقيقتان
  يقرأ خيار model من configOptions — Kimi 0.27.0 يعلن ثلاثة نماذج:
  `kimi-code/kimi-for-coding` (K2.7 Coding)، و`kimi-code/kimi-for-coding-highspeed`
  (K2.7 Coding Highspeed)، و`kimi-code/k3` (K3). IPC جديد `satr:kimiModels` وpreload
  `window.satr.kimiModels()`، ومنتقي الواجهة يفضّل الديناميكية ويسقط إلى k3 الثابت، و
  `SAFE_MODEL` في `main.js` صار يسمح بـ`/`. `/سياق` يفتح عملية ACP قصيرة، يستأنف الجلسة،
  ينفذ أمر Kimi الرسمي `/usage` ويطبّع
  `Context current/max/%` وعدادات input/output/cache إلى عقد لوحة السياق. `/ضغط` يرسل أمر
  `/compact` الأصلي بلا موارد أو صور ملحقة، ويحوّل `Tokens before/after` إلى
  `system/compact_boundary` مع بقاء sessionId نفسه. إصدار Kimi ACP 0.27.0 لا يعلن خيار effort
  ضمن `configOptions` (يعلن `model/thinking/mode` فقط)، لذلك تعطل الواجهة effort لمحرك
  `kimi-code` ولا تكتب `config.toml` العام ولا تتظاهر بتطبيق قيمة غير مدعومة. إن أعلن إصدار
  لاحق خيار `effort|reasoning_effort` بقيم مطابقة فالمحرك يطبقه من العقد المعلن.
- **التحقق**: `npm run test:kimi` يحاكي ACP ثنائي الاتجاه ويثبت new/prompt/permission/
  question/cancel/resume، ودورة `Write → ExitPlanMode →` تعديل المشروع مع بقاء غير ملف
  الخطة محجوباً خارج cwd، وfallback بلا تكرار التاريخ، حجب السر المتداخل، حصر المسار،
  مهارات MCP وسرد/تحميل الجلسات، وضبط model، و`/usage`، و`/compact`، وعدم إرسال effort غير
  المعلن، و`agent_thought_chunk` → `stream_text/commentary` مع الدمج والقص وحجب السر،
  وتحويل `available_commands_update` إلى أوامر «/» ديناميكية، وضبط `thinking` عند إعلانه،
  ورفض terminal reverse-RPC عند عدم إعلانه، وK2: استئجار القناة بلا spawn/initialize/
  session-new ثانية ولا cancel عند end_turn، والأحداث المتأخرة المحجوبة خارج سجل
  المحادثة، وstop يبقي الجلسة حية، وطرد الأقدم خمولاً عند سقف عمليتين، والدور
  المستأجر يرى مهارات اختياره عبر المرجع الحي (K3-أ) بلا تسرّب من دور البناء.
  `npm run test:kimi-keepalive` يغطي وحدة السجل (تسجيل/سقف/خمول 15 دقيقة/استئجار/
  قتل مع دور نشط/killAll/تجميع وحجب وقص الأحداث المتأخرة). كلاهما يدخل `test:full`،
  و`test:envbrief` يثبت تكافؤ جرد MCP للمحركات الأصيلة الثلاثة. صفر اعتماديات جديدة.

- **رؤية الملفات (الدفعة 1.1)**: `@مسار` في الرسالة يُحقن محتواه في البرومبت قبل
  `adapter.start` (عبر `electron/inject.js` — انظر خريطة الملفات أعلاه). للمحوّلات العمياء
  فقط (عائلة claude مستثناة)؛ صفر تغيير في المحوّلات نفسها.

