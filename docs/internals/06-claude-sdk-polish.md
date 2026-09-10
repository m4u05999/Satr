### تلميع محرك Claude Agent SDK (دفعة E — 2026-07-27)

- **مصدر الحقيقة والمسبار الحي**: استُخدمت الحقول العامة المستقرة فقط من
  `@anthropic-ai/claude-agent-sdk/sdk.d.ts` في الإصدار `0.3.176`: الخياران
  `promptSuggestions` و`agentProgressSummaries`، و`PermissionResult.decisionClassification`،
  وخطافا `PostToolUseFailure` و`PostCompact`. لا واجهة `@alpha` أو `EXPERIMENTAL`.
  شُغّل `scripts/sdk-polish-probe.js` على Claude Code `2.1.220 (Claude Code)` والنموذج
  `sonnet`، وحُفظ الخرج الحرفي في `dist/sdk-polish-probe.log`.
- **أرقام الاقتراح والضغط الحية وحدّ upstream**: أكمل الدور التمهيدي بنتيجة واحدة، ثم
  أكمل الدور المستأنف بنتيجة واحدة من subtype ‏`success`. رغم تفعيل
  `promptSuggestions:true` لم يصل أي `prompt_suggestion`: كان `suggestionCount:0`،
  وبقي input مفتوحاً `15006ms` بعد `result` ثم أُغلق بسبب مهلة مضبوطة `15000ms`؛ لا
  متغير بيئة `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` ولا إعداد
  `promptSuggestionEnabled` محلي ظاهر عطّله. كذلك أكمل `/compact` بنتيجة `success` لكن
  لم يصل `PostCompact` ولا `compact_boundary` خلال مهلة `15000ms`. لذلك يظل الحقلان
  مدعومين في typings لكن الثنائي المثبت لا يصدر الحدث/الخطاف في هذين السيناريوهين؛ هذا
  حد upstream موثق لا يُعوّض بتخمين summary أو suggestion. الإنتاج يتدهور رشيقاً: ينتظر
  الاقتراح `1500ms` بعد النتيجة ثم يغلق input، ويعرض ملخص الضغط فقط إن وصل الخطاف فعلاً.
- **أرقام تقدم الوكيل الفعلية**: مع `agentProgressSummaries:true` وأمر وكيل مضبوط على
  `42000ms` وصل حدثا `task_progress` (`taskProgressCount:2`) وانتهت النتيجة
  `success`. أول summary كان النص `Running node timeout script` بطول `27`، وطول
  `description` كان `27`. مفاتيح الرسالة الفعلية كانت `description, session_id,
  subagent_type, subtype, summary, task_id, tool_use_id, type, usage, uuid`، ومفاتيح
  `usage` كانت `duration_ms, tool_uses, total_tokens`.
  إعادة السيناريو منفرداً ثلاث مرات لم تُصدر summary رغم بقاء الخيار مفعلاً؛ آخرها أصدر
  `taskProgressCount:1` بلا summary. فالملخص الدوري
  (~30s في typings) best-effort وغير مضمون لكل استدعاء وكيل، والواجهة تتجاهل غيابه بلا أثر.
- **حمولة الفشل الفعلية**: وصل `PostToolUseFailure` لأداة `Bash` مع المفاتيح
  `cwd, duration_ms, effort, error, hook_event_name, is_interrupt, permission_mode,
  prompt_id, session_id, tool_input, tool_name, tool_use_id, transcript_path`؛ كانت
  `duration_ms:14453` و`errorLength:11` و`is_interrupt:false`، ومفتاحا input هما
  `command, description`. الإنتاج لا يبث هذه الحمولة؛ يستعمل فقط `tool_name` و
  `tool_use_id` لحذف لقطة التعديل اليتيمة من `editSnapshots` عند فشل `Edit/Write/
  MultiEdit`.
- **موضع تصنيف الإذن المثبت**: `decisionClassification` حقل top-level في قيمة
  `PermissionResult` المعادة من `canUseTool`، لا داخل `updatedInput` أو خرج Hook. قبل
  SDK القرارات الثلاثة حياً بالترتيب: `allow/user_temporary` ثم
  `allow/user_permanent` ثم `deny/user_reject`، وانتهى الدور `success`. مفاتيح سياق
  callback في كل مرة كانت `agentID, blockedPath, decisionReason, description,
  displayName, signal, suggestions, title, toolUseID`. لذلك يوسم `resolvePermission`
  «دائماً» الفعلية `user_permanent`، والموافقة مرة/للدور `user_temporary`، والرفض
  `user_reject`؛ إلغاء التشغيل التقني لا يُنسب للمستخدم.
- **العزل ودورة إغلاق input**: التشغيل العادي وحده يضبط
  `promptSuggestions:true` و`agentProgressSummaries:true`؛ كل تشغيل يحمل
  `internalPolicy` لا يضبطهما. بوابة الإغلاق تبدأ مهلة `1500ms` عند `result` وتغلق عند
  وصول الاقتراح أو انتهاء المهلة، لكنها لا تغلق بينما نقل SDK خلفي معلق؛ إذا انتهت
  المهلة أولاً تنتظر `task_notification` النهائي ثم تغلق. `stop()` بقي يقاطع Query عبر
  `interrupt()` ثم يغلق input مباشرة، وmain ما زال ينتظر stop و`done` حتى `5000ms` ثم
  `forceClose` ومهلة `1000ms`؛ لم يتغير عقد دفعة A أو قفل send/control.
- **عقود `satr:event` الجديدة المنقّاة**: اقتراح المؤلف هو
  `{type:'prompt_suggestion',suggestion}`، وتقدم بطاقة الوكيل هو
  `{type:'sdk_agent_progress',taskId,toolUseId?,summary}`، وملخص الضغط هو
  `{type:'system',subtype:'compact_summary',compact_summary}`. يزيل main محارف التحكم
  وBidi ويطوي الفراغات ويفحص `memory.hasSecret`، ويقص الحقول على الترتيب إلى
  `500/300/1200` نقطة Unicode. لا يعبر `uuid/session_id/usage/transcript_path/prompt_id`
  أو أي حقل SDK خام. `task_progress` الخام و`task_notification` الخام محجوبان عن renderer
  والمراقبين؛ ويعيد مسار lifecycle نفسه في agent تنقية summary قبل إنشاء الحدث وLedger.
- **الواجهة**: `sdk_agent_progress` يحدّث سطر تقدم داخل `agent-card` المرتبطة بـ
  `tool_use_id` (أو ربط task المعروف). `compact_summary` يضاف إلى بطاقة الضغط القائمة؛
  أرقام `pre_tokens/post_tokens` لا تتغير، واستدعاء Codex `compact_boundary` بلا أرقام أو
  summary يبقى كما كان. شريحة الاقتراح فوق المؤلف تملأ textarea ولا ترسل؛ تختفي عند
  الكتابة أو النقر أو بدء دور أو جلسة جديدة أو استئناف جلسة أو تبديل المحرك. لا style
  مضمّن ولا IPC جديد في preload.
- **إعادة تحقّق (2026-09-07، ‏SDK `0.3.261` وCC `2.1.261` — ‏`OBS-137`)**: الحدّان
  المعلنان أعلاه **قائمان بلا تغيير**: `promptSuggestions:true` أعطى `suggestionCount:0`
  وأُغلق input بمهلة `15007ms`، و`PostCompact` لم يصل ولا `compact_boundary` — فبوابة
  الإغلاق `1500ms` وعرضُ ملخّص الضغط عند وصوله فقط يبقيان تدهوراً رشيقاً لا احتياطاً.
  و`agentProgressSummaries` أعطى `taskProgressCount:1` **بلا summary**، وهو داخل
  السلوك best-effort الموصوف. وموضع `decisionClassification` كما هو: القرارات الثلاثة
  بالترتيب `user_temporary` ثم `user_permanent` ثم `user_reject`.
  **وانحرافان في حقول لا يستهلكها سطر**: خطّاف `PostToolUseFailure` **فقد** `effort`
  (‏`13 → 12` مفتاحاً؛ والإنتاج يقرأ `tool_name` و`tool_use_id` فقط)، وسياق `canUseTool`
  **كسب** `requestId` (‏`9 → 10`). و`errorLength:11` كما كان.
- **⚠️ تحذير upstream جديد رُصد أثناء الجسّ**: `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` ظهر في
  ثلاثة مسابير، ومصدره **وسائطُ المسابير نفسها** (‏`allowedTools` صريحة أو
  `permissionMode:'bypassPermissions'`) لا الإنتاج: `agent.js` **لا يمرّر `allowedTools`
  إطلاقاً** (موثّق عنده صراحةً)، وتجاوز `bypassPermissions` معلن أصلاً في هذا الملف.
  لكن نصّ التحذير يذكر أيضاً أن **قواعد السماح في ملفات الإعدادات تظلّل `canUseTool`
  وهي غير مرئية له** — وسطر يضبط `settingSources:['user','project','local']`. **وقد
  قِيس بفخوخ حيّة (‏`OBS-140`)، والنتيجة تفترق بالطبقة لا بالمجلد**:

  | الملف | يظلّل المربع؟ | المسبار |
  |---|---|---|
  | `~/.claude/settings.json` | 🔴 **نعم** | `probe:obs140-user` |
  | `<cwd>/.claude/settings.local.json` | 🔴 **نعم** | `probe:obs140-user` |
  | `<cwd>/.claude/settings.json` | ✅ لا | `probe:obs140` |

  - **النفي مسنود بشاهد موجب** لا بصمت: `deny:['Write']` أسقطت الأداة من إعلان
    `system:init` (‏`73 → 72`) فالملف مقروء يقيناً؛ والإثبات بدليل مزدوج (علامةٌ على
    القرص + `File created successfully`).
  - **و`settings.local.json` أخطرُ الثلاثة ناقلاً**: مُتجاهَلٌ في Git فلا تراه مراجعة
    الفرق، لكنه يصل كاملاً مع نسخة `.zip` أو USB. وضابطُه داخل التشغيل نفسه:
    `settings.json` في المجلد عينه مرّ بالمربع — فالفرق **اسم الملف وحده**.
  - **ولا يمسّ المالك اليوم** (لا مفتاح `permissions` في إعداده).
  - **والتنبيه منفَّذ في `hookguard.js`** (‏إخبارٌ): يقرأ `permissions.allow` من
    **النطاقين المُظلِّلَين** عند بدء الدور ويبثّ تنبيهاً عربياً يسمّي الأدوات، بنصٍّ
    خاص لكلٍّ لأن العلاج يختلف (إعدادُك تحرّره · ملفٌّ وصل مع المشروع تراجعه وتحذفه).
    ‏`settings.json` في المشروع **لا ينبّه** — تحذيرٌ عن ملفٍ لا يظلّل كذبٌ بالزيادة.
    يأخذ **اسم الأداة بلا وسيطتها**، ويخزّن **بصمتين** في حقلَي `allow` و`allowLocal`
    الاختياريين بجانب `mcp` (بلا رفع `STORE_VERSION`) — **مستقلّتين** كي لا يُسكِت
    تغيّرُ إحداهما تنبيهَ الأخرى.
  - **✅ والإنفاذ منفَّذ**: **لا خطّاف جديد** — `agent.js` يسجّل `PreToolUse` أصلاً وفيه
    فرعٌ قائم يعيد `permissionDecision:'ask'` لأدوات وضع `auto`؛ وُسّع الفرع نفسه بشرط
    ثانٍ يوجّه أدوات قواعد السماح إلى المربع. والمجموعة تُقرأ **متزامنةً قبل بدء الدور**
    (`hookguard.shadowingAllowToolNamesSync(cwd)` — اتحادُ النطاقين المُظلِّلَين وحدهما)
    لأن الخطّاف قد يقع قبل حسم قراءة لاحقة.
    مُثبَت على مسار الإنتاج بـ`npm run probe:obs140-enforce` **للنطاقين**: مع
    `allow:['Write']` صار `permissionRequests:1` ولم تقع الكتابة، وشاهدٌ سالب سليم.
    **تجاوزان معلَنان**: `bypassPermissions` مستثنى (تجاوزه مقصود)، والمطابقة **بالاسم
    وحده** فقاعدة `Bash(npm run test:*)` تُلزم كل `Bash` بالسؤال — البديل نسخةٌ ثانية من
    مطابِق قواعد Claude تتباعد بصمت، والسؤال الزائد يُستدرك والتنفيذ الصامت لا يُستدرك.
    ويغطّي محرك `sdk` وحده لأن التظليل مقيسٌ فيه. يحرسه `test:hookguard` (‏65 فحصاً)،
    ومُثبَت أنه يعضّ.
  - **وصيغُ القواعد مقيسة**: الاسم المجرّد (`Write`/`Bash`) **يظلّل**، والمقيَّدة
    المخالِفة (`Write(//nowhere/…)`/`Bash(git:*)`) **تُبوَّب** ⇒ الوسيطة تُقرأ فعلاً.
    فالمطابقة بالاسم وحده **كاملة لا ناقصة** (تمسك المجرّد وتمسك المقيَّد لو ظلّل)،
    وزيادتُها سؤالٌ لا خطر. و**`Read` مُعفاة من المربع أصلاً بلا أي قاعدة** (مقيس)،
    فقاعدة سماح عليها لا تغيّر شيئاً.
- **التحقق القطعي**: `npm run test:sdk-polish` يغطي الخيارات الخمسة، تنقية lifecycle
  وقائمة سماح main، عدم تسريب حقول SDK، بوابة الاقتراح مع مهام دفعة D والخيار القديم،
  تنظيف snapshot، موضع التصنيف، إضافة بطاقة الضغط دون تغيير أرقام Codex، سلوك الشريحة
  بلا إرسال، وعقد الإيقاف؛ وهو مسجل داخل `test:full` ولا يشغّل شبكة. حارس
  `test:sdk-background` الذي كان يثبت الاسم المحلي `rawTaskNotification` حُدث بوعي إلى
  `rawPrivateLifecycle` ليثبت حجب كل من `task_notification/task_progress` الخامَين.
