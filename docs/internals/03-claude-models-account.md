### نماذج وحساب Claude الديناميكيان (دفعة B — 2026-07-25)

- **المسبار أولاً**: `scripts/claude-models-probe.js` شُغّل على
  `@anthropic-ai/claude-agent-sdk 0.3.176` و`Claude Code 2.1.214`. استخدم Query تحكم
  عابرة واحدة (`controlQueries:1`) وجمع `supportedModels()` و`accountInfo()` بالتوازي؛ أعاد
  `5` نماذج. ثم مرّر `fallbackModel` في دور عادي بلا أدوات (`haiku` أساسياً و`default`
  احتياطياً) فأنهى الدور بـ`resultSubtype:"success"` ونص طوله `43` محرفاً. المسبار لا
  يطبع قيم البريد أو المنظمة أو الاشتراك، بل حضور الحقول وأسماء المفاتيح فقط.
- **الكاش والتدهور**: `agent.js` يجمع الاستعلامين عبر `Promise.all` داخل
  `withControlQuery` واحدة، ويشارك النتيجة والطلب الجاري بين `claudeModels` و`claudeAccount`.
  مدة الكاش `120000ms` للنجاح والفشل؛ عند غياب الدوال أو CLI أقدم يعيد خطأ ثابتاً ورسالة
  عربية بلا نص خطأ upstream، فتظل قائمة الواجهة الثابتة والسلوك السابق للحساب عاملين.
- **عقد `satr:claudeModels`**: بلا مدخلات، ويعيد
  `{ok:true,models:[{value,label,description}]}` أو `{ok:false,models:[]}`. يبني `main.js`
  كائنات جديدة بقائمة سماح فقط، يزيل محارف التحكم وBidi ويطوي الفراغات ويقص بالقيم:
  `value≤64` ويلزم أن يطابق `SAFE_MODEL`، و`label≤80`، و`description≤240`، مع إزالة
  المكرر وسقف `12` نموذجاً. `preload.js` يكشف `claudeModels()` المحددة فقط.
- **عقد `satr:claudeAccount`**: بلا مدخلات، ويعيد
  `{ok:true,email?,organization?,subscriptionType?}` أو `{ok:false}`. السقوف النصية
  `email≤320` و`organization≤160` و`subscriptionType≤80` بعد التنقية نفسها. لا تعبر
  `apiProvider` أو `tokenSource` أو `apiKeySource` أو أي token/معرّف داخلي/حقل غير معلن
  أو خطأ خام إلى renderer. `preload.js` يكشف `claudeAccount()` المحددة فقط.
- **الواجهة**: محرك `sdk` يفضّل `claudeDynamicModels` ويعود إلى `CLAUDE_MODELS` عند
  فشل الجلب أو فراغه. بعد نجاح preflight القائم يبدأ جلب الحساب كسولاً؛ وجود البريد يغيّر
  الشريط إلى «مسجّل الدخول: <بريد>»، وفشل الجلب يترك النص والمؤقت القديمين. قسم «حساب
  Claude» في ⚙ يحدّث البريد والمنظمة ونوع الاشتراك عند الفتح، ويكتب القيم بـ`textContent`.
- **عقد فتح ⚙ (‏OBS-099 — 2026-09-04)**: `topbar.js` يبث `CustomEvent` اسمها
  `settings-open` (‏bubbles) من داخل `setSettingsOpen` عند **الانتقال من مغلقة إلى
  مفتوحة فقط**، و`app.js` يستمع لها على عنصر `satr-topbar` فيستدعي
  `refreshClaudeAccountView`/`refreshCodexAccountView`. لماذا حدث صريح: القشرة كانت
  تقرأ `settingsPop.hidden` داخل `queueMicrotask` على نقرة `#settingsBtn`، وindex.html
  يحمّل `app.js` قبل `topbar.js` فتُصرَّف المهمة الدقيقة قبل أن يبدّل مستمع topbar
  الحالة — فبقيت قسما الحساب مجمّدَين منذ دفعتَي B وC4 رغم أن الاستدعاء «موجود» في
  المصدر (الفحص الساكن لا يرى العطل). ممنوع `setTimeout` وتبديل ترتيب الوسوم — كلاهما
  يعيد بناء الهشاشة. الحارس الحي `test:settings-account` ينقر الزر فعلاً في Chromium
  تحت CSP ويستخرج وظائف الحسابات من مصدر `app.js` نفسه (لا نسخة يدوية).
- **النموذج الاحتياطي**: ⚙ يعرض «نموذج احتياطي عند انشغال النموذج» بقائمة Claude
  الديناميكية (أو الثابتة عند الفشل) وخيار «بلا» افتراضي، ويحفظ الاختيار في
  `localStorage` بالمفتاح `satr_fallback_model`. `main.js` يقبل القيمة فقط إن طابقت
  `SAFE_MODEL` ولم تساو النموذج الأساسي، ثم يمررها `agent.js` إلى
  `options.fallbackModel` عند غياب `internalPolicy` فقط؛ لذلك لا تصل إلى سياقات
  `text-only`/`read-only-planner` ولا إلى أي عامل أو تشغيل غرفة عمليات.
- **حدود upstream المثبتة**: القيم الخام كانت `default` و`opus[1m]` و
  `claude-fable-5[1m]` و`sonnet` و`haiku` (أطوال الوصف `59/59/65/38/37`). القيمتان
  ذواتا الأقواس كانتا لا تطابقان `SAFE_MODEL` آنذاك فكان يعبر IPC ثلاثة نماذج فقط.
  **تحديث 2026-07-27 (قرار مالك، بعد إصدار 2.12.0)**: صار Claude Code ‏2.1.220 يعلن
  Fable 5 وOpus 5 بصيغة `[1m]` حصراً (والقيم النظيفة اليوم `default/sonnet/haiku/
  claude-opus-4-8`)، فوُسّعت `SAFE_MODEL` (‏main.js) و`SAFE_CLAUDE_MODEL` (‏agent.js)
  بلاحقة `(\[1m\])?` الاختيارية حصراً — أي قوس آخر يبقى مرفوضاً. ومعها شبكة أمان في
  `rebuildModels`: الاختيار المحفوظ غير المعلن من المحرك يُعرض خياراً موسوماً «(محفوظ)»
  بدل حقل فارغ، والقيمة تُرسل ما دام المحرك يقبلها. يغطيها `test:claude-models` المحدَّث. أعاد `accountInfo()` مفاتيح
  `apiProvider,email,organization,subscriptionType`، لكن العقد العام يسقط الأول. اختيار
  fallback مطابق للنموذج الأساسي يُسقط دفاعياً قبل SDK لتجنب دور غير صالح.
- **إعادة تحقّق بعد ترقية المحرّك (2026-08-27، ‏CLI ‏`2.1.241`)**: العقود أعلاه **صامدة**
  — `accountInfo()` بالمفاتيح الأربع نفسها، و`fallbackModel` أنهى دوره `success` بطول
  `83`. والانحراف **إضافي لا كاسر**: النماذج `5 → 6` (انضم `claude-opus-4-8`، وهو يمرّ
  `SAFE_MODEL` بلا تعديل)، وأطوال وصف `default`/`opus[1m]` ‏`59 → 57`، وكل نموذج صار
  يحمل تسعة حقول لا ثلاثة (`supportsEffort` و`supportedEffortLevels` و`supportsAutoMode`
  و`supportsFastMode` و`supportsAdaptiveThinking` و`resolvedModel` و`displayName`).
  قائمة السماح المغلقة تُسقطها كلها قبل renderer — سليم أمنياً، لكن المعلومة تضيع:
  ‏`OBS-063`.
- **إعادة تحقّق (2026-09-07، ‏SDK `0.3.261` وCC `2.1.261` — ‏`OBS-137`)**: **صامد** —
  `controlQueries:1` (التجميع يعمل)، و`6` نماذج بالحقول التسعة نفسها، و`accountInfo()`
  بمفاتيحه الأربعة (‏`email` حاضر — بخلاف `account/read` في Codex الذي أسقطه)، و
  `fallbackModel` أنهى دوره `success` بطول `291`. والانحراف الوحيد **تسمية**: معرّف Fable
  صار `claude-fable-5-1[1m]` (كان `claude-fable-5[1m]`) — يمرّ `SAFE_MODEL` بلا تعديل
  لأن اللاحقة `(\[1m\])?` والاسم أبجدي-رقمي، والواجهة تعرضه «Fable 5.1» منذ `2.16.14`.
- **مستويات الجهد المعلنة (‏`OBS-063` مرشّح أ — 2026-09-03)**: العقد العام كسب حقلاً
  اختيارياً واحداً `effortLevels`: مصفوفة من القائمة **المغلقة**
  `['low','medium','high','xhigh','max']` (تطابق اتحاد `sdk.d.ts`)، **بترتيب القائمة لا
  ترتيب SDK** كي لا يقلب إعلانٌ لاحق ترتيب المنتقي. يُبنى في `sanitizeClaudeEffortLevels`
  من حقلين داخليين يمرّرهما `agent.js` (‏`supportsEffort` و`supportedEffortLevels`)،
  ويُضاف **فقط** حين `supportsEffort === true` (لا truthy) والمصفوفة غير فارغة بعد
  التنقية؛ وتُسقَط القيمة غير النصية أو خارج القائمة، ويُزال التكرار، وتُعاد **مصفوفة
  جديدة** لا مرجع SDK. لا يعبر `supportsEffort` نفسه ولا الحقول الثلاثة الباقية
  (‏`supportsFastMode`/`supportsAutoMode`/`supportsAdaptiveThinking` — مرشّح (ب) مؤجّل:
  حقل مجمَّد بلا مستهلك عيب لا ميزة). **الواجهة**: `rebuildEfforts` في `app.js` يعرض
  للنموذج المُعلِن مستوياته وحدها مسبوقة بـ«الافتراضي» (نمط Codex القائم حرفياً)،
  والاختيار المحفوظ خارجها يسقط إلى الافتراضي **بإشعار عربي** بدل تخفيض SDK الصامت؛
  ودورة شريط الوعي صارت تُشتق من خيارات المنتقي الفعلية لا من `EFFORT_CYCLE` الأوسع
  (وإلا ضبطت قيمة بلا خيار مقابل فأفرغت الحقل). **المقيس حياً** على Claude Code
  `2.1.258` (‏SDK `0.3.176`): خمسة من ستة نماذج تعلن `supportsEffort:true` بالمستويات
  الخمسة، و`haiku` **لا يعلن حقول جهد إطلاقاً** (أربعة مفاتيح فقط). **حدّ مُصرَّح به**:
  غياب الحقلين لا يميّز «نموذج بلا جهد» عن «CLI أقدم»، فيُغلَّب التوافق الخلفي ويبقى
  `haiku` على القائمة الثابتة — أي أن تخفيضه الصامت لم يُعالَج بعد.
- **الأحداث والتحقق**: لا يضيف هذا التكامل أي نوع إلى `satr:event`. يغطي
  `npm run test:claude-models` عقدي IPC والتنقية والكاش/تجميع الطلبات وعدم تسريب الحقول،
  والسقوط إلى القائمة الثابتة، وحفظ fallback وعزله عن كل `internalPolicy`، ومنذ
  ‏`OBS-063`(أ) تنقية `effortLevels` وقائمة حقول العقد المغلقة ومنتقي الجهد الفعلي
  المستخرج من `app.js` داخل DOM مصغّر (القصر والسقوط والإشعار وثبات مسار Codex)؛ وهو داخل
  `test:full`. آخر تحقق للدفعة نجح فيه `npm run test:claude-models`، ثم نجحت حزمة
  `npm run test:full` كاملة `50/50`، ونجح `npm run eval:agent` مستقلاً `12/12`.
  يبقى المسبار الحي خارج `test:full` عمداً مثل بقية مسابير SDK.


### سقف الجهد من الإعدادات ورموز أخطاء المحرّك وقياس عقود الاستئناف (دفعة ب٤ — 2026-09-15)

ثلاثة بنود من دفعة ترقية SDK إلى `0.3.270`، مستقلّة بحدودها: `OBS-193` و`OBS-196` كود،
و`OBS-195` **قياس فقط** بلا استهلاك.

- **فكّ تعارض `verification_required` (‏`OBS-193`)**: أضاف `0.3.270` القيمة `'verification_required'`
  إلى اتحاد `SDKAssistantMessageError` في **عائلة أخطاء الحساب** (بين `account_on_hold`
  و`billing_error`)، وهي السلسلة نفسها التي يستعملها سطر **رمزاً داخلياً** في غرفة العمليات
  بمعنى «لم تُشغَّل الاختبارات المعتمدة قبل الدمج». الرمز الداخلي صار `verification_not_passed`
  في المواضع الثلاثة (`electron/integration.js` في `gate`، و`electron/merger.js`، وجدول الترجمة
  في `src/ui/components/ops-room.js`) وفي `scripts/integration-test.js`؛ **النصّ العربي لم يتغيّر**.
  وجواب الجرد الذي طلبته الملاحظة («هل يوجد جدول واحد يترجم رموز الأخطاء بلا تمييز مصدرها؟»):
  **لا** — ولم يكن لرموز المحرّك جدول أصلاً (بحث `account_on_hold|billing_error|authentication_failed`
  في `electron/` و`src/` أعطى صفر نتيجة). فأُنشئ `electron/engineerror.js`: وحدة نقية تترجم
  الاتحاد المغلق كلّه (١٣ رمزاً) وتوسم عائلة الحساب بـ`account:true`، وتعيد `null` للمجهول
  (محرّك أحدث) بدل اختراع نصّ. **موضع الوصل**: `apiRetryEvent` في `agent.js` — وهو الموضع
  **الوحيد** اليوم في سطر المطبوع `SDKAssistantMessageError`؛ يُلحَق
  `engine_error: {code, message, account}` بجانب `error` الخام لا بدلاً منه، و`chat.js` يقدّم
  عائلة الحساب على تصنيف الشبكة في سطر السبب (سببها لا يزول بإعادة محاولة، فإخفاؤه خلف
  «تعذّر الوصول إلى الخادم» يترك المستخدم ينتظر ما لا يأتي). **حدّ مُصرَّح به**: `assistant.error`
  ومدخل خطّاف `StopFailure` يحملان الرمز نفسه ولم يُوصَلا بعدُ بهذا الجدول، ولم يُرَ خطأ حساب
  حقيقي يحمل `verification_required` (التصنيف مبنيّ على النوع لا على مشاهدة).

- **سقف الجهد من ملفات الإعدادات (‏`OBS-196`)**: `sanitizeClaudeEffortLevels` كان يشتقّ المنتقي من
  **قدرة النموذج وحدها**، بينما `maxEffortLevel` (‏`sdk.d.ts:8327`) سقفٌ ثالث يقصّ **من جانب العميل**،
  فيُعرَض مستوى يُختار ثم يُقصّ صامتاً — العلّة نفسها التي عولجت في `OBS-063` على مستوى قدرة
  النموذج. المنطق في وحدة جديدة `electron/effortcap.js`. **القرار المعماري الوحيد الذي يسهل خطؤه**:
  الأسبقية تُحسَب **داخل كل ملف أوّلاً** (سقف `modelSettings.<model>` يحلّ محلّ العام) **ثمّ يُؤخذ
  الأدنى عبر الملفات**؛ لو جُمِعت الأسقف العامة في رقم والنموذجية في رقم ثم طُبّقت الأسبقية،
  لأعطى ملفٌ بـ`low` عام مع ملفٍ آخر بـ`xhigh` نموذجي النتيجة `xhigh` والصحيح `low` (فحص قائم
  في الحارس). وقصٌّ يُفرِغ القائمة يعود بـ**أدنى رتبة معلَنة** لا بمصفوفة فارغة، لأن الفارغة تعني
  في العقد «لم يُعلِن» فتسقط الواجهة إلى قائمتها الثابتة — أي إلى مستويات **فوق** السقف.
  القارئ متزامن بسقف حجم (`256KB` كـ`hookguard`) ورفض الروابط الرمزية قبل القراءة — **نمط**
  `hookguard.allowToolNamesInFile` لا دالتُه (قارئه غير مُصدَّر ومربوط بقواعد السماح، فلم يُوسّع
  سطحه لأجل حقل آخر). والعقد العام كسب حقلاً اختيارياً ثانياً `effortLevelInfo`
  (‏`[{level, sessionOnly}]`) يوسم `max` جلسيّاً؛ **الواجهة لم تُغيَّر** — مستهلِك المستويات القائم
  `src/ui/app.js:703` (‏`declaredEffortLevels`) يقرأ `effortLevels` وحده، وعرض الوسم دفعة لاحقة.
  **حدّان مُصرَّح بهما**: (١) سقف المؤسسة يُطبّق على الخادم ولا يظهر في أي ملف محلي، فيبقى قصّاً
  صامتاً لا يعرفه سطر (وسؤال `OBS-196` المفتوح — هل يخصم المحرّك السقفين من
  `supportedEffortLevels`؟ — يحتاج حساباً مؤسسياً ولم يُقَس)؛ (٢) معالج الـIPC `satr:claudeModels`
  لا يمرّر `cwd` اليوم، فيسري سقف `~/.claude/settings.json` وحده فعلياً؛ وسقفا المشروع
  (`settings.json` و`settings.local.json`) مدعومان في الوحدة ومغطّيان بالحارس، ويسريان فور
  تمرير `cwd` من الواجهة (يلزم تغيير في `preload.js` والمعالج مع تحقّق من المسار).
  الحارس: `npm run test:effortcap` (‏`scripts/effortcap-test.js`، ٤٨ فحصاً، داخل `full-suite`)،
  و`test:claude-models` كسب فحوص القصّ والوسم وحُقن `effortcap` في صندوق استخراج `main.js`.

- **`OBS-195` — القياس** (مسبار حيّ خارج المستودع: `D:/sater/resume-probe/probe.mjs` ← `result.json`؛
  `claude-haiku-4-5-20251001` · `maxTurns:1` · CLI `2.1.270` · SDK `0.3.270`). أربع نتائج:
  1. **`pending_permission_requests` و`pending_user_dialogs` غائبتان تماماً** من ردّ
     `q.initializationResult()` — لا مصفوفتين فارغتين — في الجلسة الجديدة وفي المستأنفة سواءً.
     المفاتيح الـ١٨ الحاضرة: `account, agents, analytics_disabled, available_output_styles,
     commands, current_permission_mode, fast_mode_disabled_reason, fast_mode_state,
     ide_rc_auto_enable_gate, models, output_style, pid, remote_control_*×٤, session_state,
     user_output_styles_dir`. **وهذا يُسقِط القاعدة التي وعد بها التوثيق**: «Always present
     (possibly empty) … from Claude Code v2.1.268 or later; … treat absence as an older CLI» —
     الـCLI هنا `2.1.270` والحقلان غائبان، فمن يبني على «الغياب = محرّك أقدم» يخطئ على المحرّك
     الحالي. (‏`session_state` حاضر، وهو ما يذكر التوثيق أنّه يشير بـ`requires_action` إلى سؤال
     موروث.) لذلك **لا يُبنى استهلاك على الحقلين في هذه الدفعة**، ولا يُستنتج من غيابهما شيء.
  2. **`resume_reason` لم يظهر على أي إطار** (فُحِصت كل الأطر لا نوعٌ بعينه): لا في الجديدة ولا
     في المستأنفة. متسق مع التوثيق (يوسم الدور المُعاد **آلياً بعد انقطاع** لا كلّ استئناف)،
     لكنّه يعني أن المسار **لم يُقَس حيّاً بعد**: إثارته تحتاج موت عامل في منتصف دور. أطر الدور
     كلاهما متطابقة: `system/init` · `system/thinking_tokens`×٢ · `assistant`×٢ ·
     `rate_limit_event` · `result/success`.
  3. **`context_usage` لا يصل مع دور عادي أصلاً** — التوثيق يقول إنّه يركب **رسالة `/context`
     الاصطناعية وحدها**، فغيابه في المسبار متوقّع لا نتيجة. والمسار الذي يستعمله سطر هو
     `q.getContextUsage()`، وقُيس ردّه: **كل صف فئة يحمل `kind`** (‏`has_kind_on_every_row: true`)،
     ومفاتيح الصف `{color, kind, name, tokens}` (و`isDeferred` على المؤجّل وحده). المقيس فعلاً:
     `System tools`→`used` · `System tools (deferred)`→`deferred` · `Custom agents`→`used` ·
     `Memory files`→`used` · `Skills`→`used` · `Free space`→`free`. **وجواب الجرد الذي طلبته
     الملاحظة**: نعم — `src/ui/components/context-panel.js:107` يصنّف بـ`/free/i.test(c.name)` أي
     **بالاسم الإنجليزي**، وهو بالضبط ما ينهى عنه `sdk.d.ts` («Use `kind` (not this name) to
     classify the row»). يعمل اليوم صدفةً لأن الاسم `Free space`، وينكسر بأي إعادة تسمية أو
     تعريب. **مُسجَّل لا مُنفَّذ** — دفعة الواجهة.
  4. **درس تشغيلي** أسقط أوّل تشغيلين صامتاً (خروج `0` بلا ملف ولا خطأ): الشرطة الخلفية في
     مسارات ويندوز المكتوبة داخل مستند منقول عبر طبقات اقتباس تنهار إلى محارف هروب
     (`\s`⇒`s` و`\r`⇒CR)، فصار جذر المستودع `D:satersatr-2-b4`. المسبار يكتب مساراته بشرطة
     أمامية ويطبع سطر إنهاء إلى stderr لأجل هذا.

#### مذكورات منفّذي الدفعة ب (2026-09-15) — أربعة شقوق صغيرة أُغلقت دفعةً واحدة

- **`satr:claudeModels` يمرّر `cwd` المشروع** (‏`preload.js` ⇒ `{ cwd }` ⇒ `handleClaudeModelsRequest(agent, cwd)`)
  فيسري سقفا `.claude/settings.json`/`settings.local.json` في المشروع (كان حدّاً مُصرَّحاً به في OBS-196:
  سقف المستخدم وحده). الواجهة تطلب القائمة بـ`$('cwd')` وتعيد طلبها عند تغيير المجلد (معالج مسمّى
  `refreshModelsForProject` — صياغة السهم كانت تسبق مرساة اقتطاع `conversation-ui-test`). الحارس:
  `test:claude-models` (مجلد مؤقت بسقف `medium` ⇒ `['low','medium']`؛ بلا cwd ⇒ القائمة كاملة).
- **`effortLevelInfo.sessionOnly` يُعرض**: منتقي الجهد يلحق «— لهذه الجلسة فقط» وعنواناً بالمستوى الجلسي
  (`max`)؛ اللاحقة بعد « — » كي يبقى `effortShort` كما هو في شريط الوعي. `refreshClaudeModels` صار يحمل
  الحقل الموازي إلى `claudeDynamicModels`.
- **`assistant.error` يمرّ بـ`engineerror`**: `annotateAssistantMessage` يضيف `engine_error` المترجَم (الرمز
  الأصلي يبقى)، والقشرة تحفظه في الكتلة وتقدّمه في نتيجة الدور قبل التخمين من النصّ. مسار خطّاف
  `StopFailure` **غير موصول** بعد (حدّ مُصرَّح به — لا خطّاف مسجَّل له في `agent.js`). الحارس في `test:neterror`.
- **لوحة السياق تصنّف بـ`kind`** (‏`used`/`deferred`/`free` — القيم المقيسة في `getContextUsage`) لا بالاسم
  الإنجليزي؛ الاسم احتياط لمحرّك بلا `kind`. عقد مصدر في `test:daily-loop-ui`.
