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

