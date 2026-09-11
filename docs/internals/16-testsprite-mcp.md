### تكامل TestSprite MCP (اختياري)

- **الوحدة**: `electron/testsprite.js` تربط الحزمة الرسمية المثبّتة الإصدار
  `@testsprite/testsprite-mcp@0.0.38` عبر `stdio` ومن دون اعتمادية تشغيل جديدة. على ويندوز
  تُشغَّل عبر `cmd /d /s /c npx` لتفادي فشل تشغيل ملف `.cmd` مباشرة.
- **السر**: الاسم الداخلي `TESTSPRITE_API_KEY`، ويُحفظ من مركز «مفاتيح المزوّدين والتكاملات»
  عبر `keys.js`. لا يُعاد للواجهة ولا يدخل `argv` أو `.mcp.json`/`config.toml`؛ يصل إلى خادم
  TestSprite الرسمي بمتغيّر البيئة الذي يتطلبه، `API_KEY`، فقط.
- **التفعيل المقصود**: لا يُحقن الخادم في كل دور. يلزم أن يجمع طلب المستخدم بين ذكر
  `TestSprite`/«تست سبرايت» وفعل صريح مثل «استخدم/اختبر/اربط»، مع وجود مفتاح صالح؛ السؤال
  التعريفي وحده لا يفعّله، وغياب المفتاح يعرض تنبيهاً عربياً. سياقات المراجع/العصف المعزولة لا ترث التكامل.
  Claude يأخذ الخادم عبر `options.mcpServers` ويمرّر أدواته في `canUseTool`؛ Codex يأخذه عبر
  تجاوزات `-c` اللحظية لـ app-server مع `env_vars=["API_KEY"]`، بلا تلويث إعداد المستخدم.
  بروتوكول Codex الحالي لا يرسل طلب موافقة قابلاً للمعالجة في «سطر» لكل `mcpToolCall` خارجي؛
  لذلك يحقن `codexLaunch` قائمة `enabled_tools` ثابتة مع
  `default_tools_approval_mode="approve"` بعد الفعل الصريح فقط. أداة فتح dashboard مستبعدة،
  وأي أداة مستقبلية لا تُعتمد تلقائياً. عناصر `mcpToolCall` تظهر كبطاقات بدء/نتيجة في المحادثة.
- **حدّ المنتج**: قائمة التقنيات الرسمية لـ TestSprite تركّز على تطبيقات الويب وواجهات API ولا
  تعد Electron سطح E2E أصلياً. يمكن استعماله لاختبار واجهات/خوادم «سطر» القابلة للعرض كويب،
  ولا يُدّعى أنه يختبر تكاملات Electron/IPC/PTY كاملةً. يلزم Node.js 22+ و`npx` في `PATH`.
- **اختبار العقد**: `npm run test:testsprite` يستخدم مفتاحاً اصطناعياً فقط ويتحقق من التنقية،
  تثبيت الإصدار، عدم ظهور السر في الوسائط، بوابة الطلب الصريح، وعزل سياقات النظام. حزمة
  TestSprite قد تكتب `API_KEY` داخل `testsprite_tests/tmp/config.json` أثناء التنفيذ؛ ينقّيه
  المضيف عند بدء الدور ونهايته، ويُستبعد مجلد `tmp` كاملاً من Git مع إبقاء حالة التهيئة.
- **Web harness صفري الاعتماديات**: `npm run testsprite:harness` يخدم `src/` على
  `http://127.0.0.1:4173/`. النواة الموزّعة في `electron/testspriteharness.js` وعميل المحاكاة
  الخارجي في `electron/testspriteharness-client.js` (كلاهما يدخلان حزمة Electron)؛ سكربت CLI
  غلاف تشخيصي فقط. لا يغيّر `src/index.html` على القرص، ويعطّل الكتابة/المحركات/الأسرار.
- **التشغيل من الدردشة — مدير الجولة v1 (قرار المالك 2026-08-06)**: عند نية TestSprite
  الصريحة يستدعي محركا SDK وCodex ‏`testspritejobs.startJob({cwd, kind, prompt})`؛ المدير وحده
  يملك الـharness ومراقب النتائج وتستمر الجولة مستقلة عن عمر الدور حتى حالة نهائية أو إلغاء.
  يحقن المحرك عقد `chatPrompt`/`siteChatPrompt` القائم بعنوان المدير. إن كانت جولة نشطة يعيد
  المدير `busy` فلا يبدأ المحرك جولة ثانية؛ يحقن بدلاً منها كتلة متابعة قصيرة داخل
  `<satr_testsprite_run>` تحمل `state/summary/port` وتمنع bootstrap جديداً. تبقى تنقية
  `testsprite_tests/tmp/config.json` عند بدء الدور ونهايته دفاعاً إضافياً.
- **الحالة والتحكم**: المدير يبث حدث `testsprite_job` ذي `schema_version:1` عبر `emitToWindow`
  مستقلاً عن token الدور. القراءة عبر `satr:testspriteJobStatus` بلا مدخلات، والإلغاء عبر
  `satr:testspriteJobCancel {jobId, confirmed:true}` فقط؛ معرّف الجولة محصور بالنمط
  `^tsj_[0-9]{1,15}_[a-z0-9]{1,10}$`. الإغلاق العام يستدعي `cleanupBeforeQuit()`، ولا restart/resume.
- **جولة الموقع (site/) — 2026-08-06**: ذكر «الموقع/صفحة الهبوط/site/landing أو
  enterprise.html/wallet.html» داخل طلب TestSprite الصريح نفسه (`testsprite.siteRequested`)
  يحوّل الدور إلى جولة موقع: خادم `site/` الثابت على `127.0.0.1:4620`
  (`testspritejobs.startJob` مع `kind:'site'` — نفس حواجز safeAsset، بلا حقن mock، بصمة health
  تحمل `surface:'site'` فلا يُقبل خادم الواجهة بديلاً عند EADDRINUSE والعكس)، وعقد
  `siteChatPrompt` نطاقه الصفحات الثلاث حصراً: bootstrap يُستدعى دائماً (تهيئة الواجهة
  السابقة لمنفذ آخر)، تغطية الروابط/mailto/الأسعار LTR/التجاوب/reduced-motion/صفر
  console-CSP، **وبلا `test:full`** (الموقع مستقل عن Electron). الفرع موصول في
  المحرّكين agent.js وcodex.js، ويغطيه `test:testsprite` (النية والعقد وفحص التوصيل)
  و`test:testsprite-harness` (خادم site وحواجزه وتمايز البصمة).
- **الاختبار**: `npm run test:testsprite` يغطي توصيل المدير بالمحركين و`busy` وقائمة سماح
  قناتي IPC، والعقد والحواجز ودورة ملكية الخادم والواجهة الحية في
  `npm run test:testsprite-ready`. الطريقة الأساسية من الدردشة والتشخيص اليدوي في
  `docs/TESTSPRITE.md`.
- **بطاقة حالة الجولة في الواجهة (العقد المجمّد v1 — قرار المالك 2026-08-06 §2/§4)**:
  `<satr-testsprite-job>` (`src/ui/components/testsprite-job.js`) بطاقة دائمة أعلى
  منطقة المحادثة، مستقلة عن الدور والجلسة — حدث `testsprite_job` (schema v1) يُبث من
  main مباشرة (نمط `bg_procs`) وتلتقطه القشرة خارج token الدور إلى
  `handleEvent`. تظهر عند snapshot نشط، وبعد حالة نهائية
  (completed/cancelled/failed) تبقى حتى إغلاقها يدوياً بزر ✕ مع تعطيل زر الإيقاف.
  الحالات الست بالعربية حرفياً من العقد (preparing=«تجهيز الجولة» …
  failed=«متوقفة بسبب البنية»)، والعدادات ومنها blocked «محجوبة»، و«آخر نشاط قبل Xث»
  من `heartbeat_at` يتحدث محلياً كل ثانية (فوق 45ث تنبيه هادئ «لا نشاط مرصود»)،
  والمنفذ (`http://127.0.0.1:port` تبنيه الواجهة) والمعرّف LTR داخل `bdi`. زر
  «⏹ إيقاف الجولة» ⇒ confirm عربي ⇒ `window.satr.testspriteJobCancel(job_id)`.
  الإقلاع يلتقط جولة حية بعد reload عبر `window.satr.testspriteJobStatus()` محروساً
  بـ `typeof` (فلا ينكسر قبل دمج قناة كودكس). الاختبار الحي
  `npm run test:testsprite-job-live` (14 فحصاً تحت CSP) ومشهدا ui-audit 39/40
  (داكن/فاتح مقاس التباين) يبثّان snapshot اصطناعياً.

