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
    ويغطّي محرك `sdk` وحده لأن التظليل مقيسٌ فيه. يحرسه `test:hookguard` (‏82 فحصاً
    بعد دفعة `OBS-191`)، ومُثبَت أنه يعضّ.
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

### تضييق مربع الإذن بحقلَي المحرّك: `defaultToNo` و`suppressAlwaysAllowRule` (ب٢ — 2026-09-15، ‏OBS-192)

- **المصدر بنصّه**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (‏`0.3.270`)،
  الوسيط الثالث لـ`CanUseTool` (بعد `title`/`displayName`/`description`):
  - `defaultToNo?: boolean` — «The ask must not be approvable by a single stray
    keystroke: open the prompt on its decline option and offer no one-key approve
    shortcut.»
  - `suppressAlwaysAllowRule?: boolean` — «The ask must not offer a persistent "don't
    ask again" choice: the rule it would write grants more than this ask's own action.»
  كلاهما بصيغة **must على المضيف** لا اقتراحاً، وكلاهما يصف **هذا النداء بعينه**: المحرّك
  يعرف أن `Bash` هذه المرّة تكتب خارج مساحة العمل، بينما قرار «سطر» (`NEVER_ALWAYS_TOOLS`)
  باسم الأداة وحده. فالفكرتان متكاملتان لا متنافستان.
- **القاعدة المعمارية: يضيّقان ولا يوسّعان**. المنطق في دالة نقيّة واحدة
  `autogate.askFlags({ baseAlwaysEligible, baseNeverAlways, suppressAlwaysAllowRule,
  defaultToNo })` تعيد `{ alwaysEligible, neverAlways, suppressed, defaultToNo }`:
  `alwaysEligible = baseAlwaysEligible === true && !suppressed`. فلا يستطيع حقلٌ من
  المحرّك أن يرفع أهلية دوامٍ منعها «سطر»، وقائمة «سطر» تبقى سارية إن صمت المحرّك.
  والتضييق يُقاس **بالصدق** لا بـ`=== true` (محرّك يرسل `1`/`'yes'` يجب أن يضيّق)، بينما
  التوسيع وحده يشترط `=== true` (المجهول لا يوسّع) — نفس اتجاه fail-safe في `autogate`.
- **الحارس في العملية الرئيسية لا في الواجهة**: `suppressAlwaysAllowRule` لا يكتفي بتغيير
  ما يُبثّ؛ يُثبَّت في `pending` بـ`neverAlways: true` و`suppressAlways: true`، فردّ واجهة
  كاذب (`window.satr.permission(id, true, /*always*/ true)` من مصحّح أو واجهة مخترقة) لا
  يضيف الأداة إلى `alwaysAllowed`. و`suppressAlways` **ذُكر صراحةً في فرع ثقة النطاق**
  داخل `resolvePermission` لأن ذلك الفرع (`trustedBrowserOrigins.add(origin)`) لا يمرّ
  بـ`neverAlways` أصلاً — لولاه لبقيت «ثق بالنطاق لهذه الجلسة» قابلةً للكتابة رغم المنع،
  وهي أوسع من فعل الطلب نفسه بالتعريف.
- **المواضع الثلاثة**: كل بثّ لـ`permission_request` في `agent.js` يمرّ الآن على
  `askFlags` — مسار كلفة التوليد (كان `alwaysEligible:false` أصلاً)، وكتلة المتصفح
  (`baseAlwaysEligible = originTrust && !!origin`)، والمسار العام
  (`baseAlwaysEligible = !NEVER_ALWAYS_TOOLS.has(tool)`). `defaultToNo` يُبثّ **حقلاً
  مشروطاً** (`...(ask.defaultToNo ? { defaultToNo: true } : {})`) فشكل الحدث القائم لا
  يتغيّر حين يصمت المحرّك.
- **المربع (`perm-dialog.js`)**: الطلب الحسّاس يفتح على **«رفض»** (هو المركَّز لا زرّ
  الموافقة)، ويعرض سطراً عربياً «⚠ طلب حسّاس: القبول بالنقر الصريح — لا يقبله مفتاح.»
  وتنفيذ «لا اختصار قبول بمفتاح واحد» بطبقتين: `keydown` على `Enter`/`Space` فوق زرّ قبول
  يُمنع بـ`preventDefault` (قبل أن يولّد المتصفح النقرة الأصلية)، وأزرار القبول تمرّ عبر
  `_approve` الذي يشترط نقرة مؤشّر حقيقية (`event.detail > 0`؛ النقرة المولَّدة بلوحة
  المفاتيح تصل بـ`detail === 0`). **الرفض يبقى متاحاً بالمفتاح كاملاً** — العقد يمنع
  القبول العابر لا يغلق الباب على من لا يستعمل فأرة. وإخفاء صفّ «الموافقة الدائمة» عند
  `alwaysEligible === false` كان قائماً من قبل (كتلة المتصفح) فلم يُغيَّر، بل ثُبّت بالحارس.
- **الحارس `npm run test:perm-ask-fields`** (‏`electron scripts/perm-ask-fields-test.js`،
  ‏49 فحصاً، بلا شبكة): يشغّل **مصدر الإنتاج نفسه** — يستخرج ذيل `canUseTool` وجسد
  `resolvePermission` نصّياً من `agent.js` ويشغّلهما في `vm` بمُوفِّرات مزيّفة، فلا يقارن
  الشيء بإعادة كتابته. يغطّي: التضييق في الحدث وفي `pending`، أن `always:true` الكاذب لا
  يُثمر دواماً ولا ثقة نطاق، أن السلوك القائم بلا الحقلين لم يتغيّر (ومعه شاهدٌ موجب: بلا
  `suppress` يُكتب الدوام وثقة النطاق فعلاً)، وعقد المصدر النصّي (المواضع الثلاثة كلها
  تمرّ على `askFlags`، ولا `alwaysEligible` محسوب خارجها). ثم يقيس المربع **حيّاً في
  Chromium** (‏`BrowserWindow show:false` + fixture بـCSP صارم وجسر `window.satr` مزيّف):
  تركيز «رفض»، منع النقرة المولَّدة بلوحة المفاتيح، `preventDefault` على `Enter`، قبول
  النقرة الحقيقية، وأن الطلب العادي بقي على سلوكه (تركيز «موافقة» والقبول بالمفتاح).
  ⚠️ **فخّ مقيس في الحارس**: `instanceof Set` لا يعبر عوالم `vm` — فحص الإنتاج
  `trustedBrowserOrigins instanceof Set` كان يفشل صامتاً مع `Set` من عالم المضيف فيُسقط
  فرع ثقة النطاق (أخضر كاذب)؛ لذا يُنشأ داخل عالم الصندوق.
- **⚠️ حدّان مُصرَّح بهما**: (١) **لم يُرَ طلب إذن حقيقي من المحرّك يحمل الحقلين** ولا
  يُعرف متى يضبطهما — المقيس هو سلوك «سطر» **إن وصلا**، لا أنهما يصلان. (٢) المسار
  **غير مكتمل من طرف الواجهة**: `src/ui/app.js` يبني وسيط `permEl.request(...)` بحقول
  مسمّاة (`turnEligible`/`alwaysEligible`/`alwaysLabel`) فيُسقط `defaultToNo` قبل أن يصل
  المكوّن. يلزم سطر واحد هناك (`defaultToNo: ev.defaultToNo === true`) — الملف ليس ملكاً
  لهذه الدفعة فلم يُلمَس. **التضييق الأمني (`suppressAlwaysAllowRule`) يعمل كاملاً بلا
  ذلك السطر** لأن مرساته في العملية الرئيسية؛ المعلَّق هو أثر `defaultToNo` البصري وحده.

### OBS-191 — ما يعلنه المحرّك مقابل ما يقرؤه `hookguard` بيده (دفعة ب٣ — 2026-09-15، ‏SDK 0.3.270)

- **المسبار الحيّ ونتيجته** (‏`D:\sater\hooks-probe\probe.mjs` خارج المستودع عمداً،
  خرجه `result.json`): `query()` بـ`pathToClaudeCodeExecutable` على `claude.exe` المثبّت
  عالمياً، ‏`cwd = D:\sater\satr-2-b3`، ‏`claude-haiku-4-5-20251001`، ‏`maxTurns: 1`،
  ‏prompt `hi`، والنداءان بعد أوّل `system/init`. النتيجة: `result` بـ`success`،
  و**الطريقتان موجودتان وتُجيبان** (`typeof === 'function'` لكليهما، ولا خطأ).
- **⚠️ فجوة typings مقيسة**: `getHooksListing` و`listPermissionRules` **موجودتان في
  `sdk.mjs` ومنفَّذتان** (`request({subtype:'get_hooks_listing'}).response`) لكنهما
  **غير معلنتين على `interface Query` في `sdk.d.ts@0.3.270`** — أنواع الطلب/الردّ معلنة
  (`SDKControlGetHooksListingResponse`، ‏`SDKControlListPermissionRulesResponse`،
  ‏`SDKPermissionRuleEntry`) والطريقتان لا. فالاستدعاء يعمل ولا يُطمئنه المُترجم؛ لا
  يُبنى على وجودهما بلا فحص `typeof`.
- **الشكل الفعلي المقيس — وهو غير متماثل بين النداءين**:
  - `getHooksListing()` يعيد **الكائن مباشرةً**: مفاتيحه `events` · `hooks` ·
    `eventCatalog` · `policy` (و`errors` **غائب** حين لا خطأ، لا فارغ).
  - `listPermissionRules()` يعيده **ملفوفاً** `{ state: { rules, workspaceDirectories,
    originalCwd, managedOnly } }` (و`errors` غائب كذلك). لذلك يقبل `permissionState()`
    الشكلين معاً فلا تنكسر المطابقة بتغيّر اللفّ.
- **الأعداد الحيّة**: `events` عنصر واحد (`PreToolUse`، ‏`hookCount:1`، ‏`supportsMatcher:true`)،
  و`hooks` **صفّ واحد** بمفاتيح `commandText, contentLabel, displayText, editable, event,
  matcher, source, sourceLabel, timeout, type` ومصدره `projectSettings`
  (`sourceLabel: "Project settings (.claude/settings.json)"`) — وهو خطّاف
  `PreToolUse` الحقيقي في `.claude/settings.json`. و`eventCatalog` **٣٣ حدثاً**
  (وهذا جواب سؤال `OBS-191` الأول: **القائمة المعروضة صفوفُ `hooks` لا الكتالوج**،
  فالعدد المتوقَّع في مشروع حقيقي واحدٌ لا ٣٣ — فلا خطر «تدريب على تجاهل التنبيه»).
  و`policy` كلُّه سالب: `disabledByPolicy/managedOnly/pluginOnly/allDisabled = false`
  و`policyHookCount: 0`؛ ولا `safeMode` ولا `bareMode`.
  و`state.rules` **قاعدتان**، كلتاهما `behavior:'allow'` · `source:'localSettings'` ·
  `editability:'persistent'` (بلا `description` وبلا `notInEffect`)، من فخّ قياس مؤقت
  (`WebFetch(domain:example.invalid)` و`Read(//nowhere/**)`) كُتب في
  `.claude/settings.local.json` المُتجاهَل ثم أُزيل. `workspaceDirectories` فارغة،
  و`originalCwd` مسار المشروع، و`managedOnly:false`. لا قاعدة `cliArg` — لأن `agent.js`
  لا يمرّر `allowedTools` إطلاقاً (مطابق لما هو موثّق أعلاه).
- **جواب السؤال الثاني في `OBS-191` (تُبصَم `commandText` أم تُخزَّن؟): لا هذا ولا ذاك.**
  الهويّة المقارَنة **اسم الحدث/الأداة ونطاق المصدر وحدهما** (`hook:PreToolUse@project`،
  ‏`allow:Write@local`). المحرّك يعطي `commandText` و`editable.config` كاملَين؛ وقاعدة
  الملف ألّا يعبره محتوى إعداد، فلا يُخزَّنان ولا يُبصَمان ولا يدخلان التنبيه. وحتى
  `matcher` مستبعَد (قد يحمل نصّاً من مستودع غير موثوق). والاسم يمرّ بمصفاة
  `/^[A-Za-z0-9_.:-]{1,48}$/` **على الطرفين معاً** فلا يولّد إسقاطُها فرقاً كاذباً.
- **المنفَّذ**: `reconcileWithEngine({ hooksListing, permissionRules }, snapshot)` نقيّة
  بلا أثر جانبي تعيد `{ agreed, missingInLocal, missingInEngine, engineErrors }`، ومعها
  `reconcileNoticeText(report)` (نصٌّ عربيّ **من الحارس** لا من المحرّك) و
  `guard.reconcileProject(cwd, engine)` الذي يمسح بنفسه ويعيد النصّ أو `null`.
  `engineErrors` تحمل **اسم الملف المجرّد وحقله** (`settings.json → hooks.SessionStart`)
  ولا تحمل المسار ولا رسالة المحرّك (قد تحمل قيمة الإعداد المخالفة أو أمراً).
- **حدود الدفعة — معلنة**:
  - **مصدر الحقيقة لم يتبدّل**: المسح اليدوي يبقى المصدر، وهذه مطابقةٌ إخبارية
    بتنبيه واحد. تحويل المصدر إلى المحرّك دفعةٌ لاحقة.
  - **غير موصولة**: لا استدعاء في `agent.js` بعد — ملكيةُ ذلك الملف خارج هذه الدفعة.
  - قواعد السماح تُقارَن في **النطاقين المقيسين مُظلِّلَين** (`userSettings` و
    `localSettings`) وحدهما؛ ‏`session`/`cliArg`/`projectSettings` خارج المدى عمداً
    (‏`OBS-140`) — وإدخال `session` كان سينبّه عند كل موافقة جلسة.
  - `.claude/setup.mjs` ليس خطّافاً عند المحرّك فلا يدخل الطرفين.
  - كلُّ قسم `fail-open` ومعزول: مدخلٌ لا يُقرأ «غير معروف» فيُسقط **قسمه** من
    المطابقة، لا يُقرأ «لا شيء» (الدرس نفسه من `OBS-087 ب` و`OBS-140`). والمدخل
    المشوّه يعيد `agreed:true` بقوائم فارغة — «لا شيء يُقال» لا «كلّ شيء اختفى».
  - **لم يُقَس زمن النداءين** ولا سلوكهما قبل أول دور غير `init`؛ المقيس أنهما
    يُجابان مباشرةً بعد `system/init`.
- **الشاهد الحيّ على الإنتاج**: تمرير `result.json` نفسه على
  `reconcileProject('D:/sater/satr-2-b3', …)` أعطى بنداً واحداً — «خطّاف «PreToolUse»
  (المشروع)» في `missingInLocal` — وهو **فجوة `OBS-156` بعينها** (الحارس يمسح
  `SessionStart` وحده)؛ والقاعدتان المحليّتان تطابقتا فلم تُنتجا فرقاً. أي أن
  المطابقة تعضّ على العطل القائم لا على ضجيج.
- **الحارس**: `npm run test:hookguard` — ‏82 فحصاً (كانت 65)، منها ١٧ لـ`OBS-191`.
