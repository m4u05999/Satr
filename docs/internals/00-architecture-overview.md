## المعمارية

```
electron/main.js     ← العملية الرئيسية: النافذة، توجيه المحركين (SDK/CLI)، معالجات IPC
electron/agent.js    ← محرك Claude Agent SDK: بث جزئي + اعتراض الأذونات + مقاطعة حقيقية
                       (يضبط settingSources=['user','project','local'] ليحمّل خوادم MCP
                        وموصّلات claude.ai والمهارات وأذونات الملفات مثل Claude Code التفاعلي.
                        يوجّه SDK إلى claude.exe المثبّت عالمياً عبر pathToClaudeCodeExecutable
                        بدل حزم ثنائي ثانٍ ~234م.ب — لذا المثبّت يبقى ~79م.ب. resolveClaudeBin
                        يحدد المسار، والبناء يستثني claude-agent-sdk-win32-x64 من الحزمة.
                        يمرّر أيضاً خيار skills للـ SDK: 'all' أو مصفوفة الأسماء المختارة من لوحة /مهارات.
                        ويدعم AskUserQuestion بأسئلة اختيار عربية (بعد أن كان محجوباً): أُثبت حيّاً
                        (scripts/ask-user-question-probe.js) أن SDK يقبل إرجاع {behavior:'allow',
                        updatedInput:{...input, answers:{[question]:label}}} من canUseTool فيستعمله
                        النموذج في الدور التالي. فمسار خاص في canUseTool يبثّ question_request منقّى
                        (sanitizeQuestions) لمكوّن <satr-question-dialog>، والردّ **مؤشرات فقط**
                        (satr:answerQuestion) تبني updatedInput من input الأصلي (buildQuestionAnswer —
                        لا نص حر، أمان). التنقية fail-closed صارمة: sanitizeQuestions يرفض التجاوز
                        (لا قصّ فيتطابق المعروض والمُعاد) وتكرار نص السؤال/label؛ buildQuestionAnswer
                        يرفض كلياً أي جزئية (سؤال ناقص/أحادي بعدة خيارات/مؤشر خارج النطاق). زر «إلغاء»
                        يرسل إجابة فارغة ⇒ deny (والواجهة تنتظر ok وتُبقي الحوار عند الفشل). الإدخال
                        الحر (Other) خارج النطاق — يطرحه النموذج نصّاً. السياقات المعزولة ترفضه fail-closed.
                        محرك Codex يستخدم المكوّن نفسه ويدعم حقول `requestUserInput` النصية والسرّية
                        وخيار «أخرى»؛ بينما يبقى عقد Claude/Kimi القائم مؤشرات فقط بلا تغيير.
                        الاختبار: test:askquestion (نقي، خصومي) + test:question-dialog (الحيّ) + probe الحيّ.
                        كما يوفّر withControlQuery: تشغيل عابر لاستدعاء «دوال التحكّم» في SDK
                        (mcpServerStatus/reconnectMcpServer/toggleMcpServer/getContextUsage) للوحتي
                        /موصلات و /سياق — مولّد إدخال ينتظر فقط ليُبقي العملية حيّة؛ يغلق الإدخال
                        ثم ينتظر مستهلك Query (مهلة 5ث) قبل q.close())
                        ومن دفعة A (2026-07-24): التشغيل العادي لمحرك sdk يمرّر
                        enableFileCheckpointing:true، ويولّد UUID صارماً في SDKUserMessage الصادرة
                        ويحفظ آخر UUID لكل جلسة في ذاكرة محدودة. تشغيلات internalPolicy (السياقات
                        المعزولة وغرفة العمليات/العوامل) لا تفعّل file checkpointing. ويوفّر غلافين
                        ثابتين forkSession وrewindFiles؛ الأخير يستعمل withControlQuery مع
                        enableFileCheckpointing:true ويتدهور برسالة عربية ثابتة بلا تسريب خطأ SDK.
electron/preload.js  ← جسر آمن: يكشف window.satr فقط (contextIsolation مفعّل)
electron/sessions.js ← قراءة جلسات ~/.claude/projects (قراءة فقط + تحقق صارم من المسارات)
electron/sessionmeta.js ← ميتاداتا جانبية لتثبيت الجلسات وتسميتها ووسم جلسات الأدوات
                       تحت ~/.satr/session-meta.json: get/set/setKind/remove، سقف 500،
                       عنوان منقّى ≤80 محرفاً، وكتابة ذرية أفضل جهد؛ لا يلمس مخازن
                       الجلسات الأصلية — انظر «وسم جلسات الأدوات» أدناه
electron/files.js    ← سرد ملفات المشروع لمنصّة @ (مشي محدود + تجاهل مجلدات ثقيلة + تخزين
                       مؤقت لكل cwd، قراءة فقط) — المرحلة 4. ومنذ الدفعة 1.2: readText
                       (قراءة ملف للعارض — تحقق موحّد مع inject.js، سقف 256ك، رفض الثنائي)
electron/search.js   ← بحث محتوى «دلالي خفيف» (الدفعة 4.6): مسح عند الطلب فوق
                       files.listFiles/readText المؤمَّنتين (لا فهرس دائم — فهرسة embeddings
                       خارج التموضع بقرار ROADMAP). تطبيع عربي (تشكيل/أإآ/ة/ى) + مطابقة
                       جزئية بعد خفض الحالة (تصيب camelCase/snake_case مجاناً) + ترتيب
                       بالنقاط (مسار أثقل + مكافأة كل الكلمات + سقف ضد طغيان التكرار)،
                       ميزانية مسح 2ث (الأطول يعود جزئياً). يستهلكه طرفان بعقد واحد:
                       أداة search_code (tools.js) وIPC ‏satr:searchFiles (بحث لوحة 📄)
electron/repomap.js  ← خريطة مستودع تقريبية مقتصدة للمزوّدات العمياء: مسارات + أبرز
                       function/class/const/export بتعابير regex حسب اللغة، فوق
                       files.listFiles/readText وتطبيع search.js؛ بلا parser أو اعتماديات
electron/context.js  ← سياق المزوّدات العمياء: يحقن خلاصة repomap صغيرة ويحسب تقدير
                       رموز محلياً (heuristic) موسوماً estimate؛ usage الحقيقي يظلّ مقدّماً
electron/orchestrator.js ← منسّق باحثين قراءة فقط (الأولوية 6/الخطوة 1): 1–3 أدوار SDK
                       متوازية بوضع plan، مهلة/إيقاف جماعي، خلاصات ومصادر وكلفة حية
electron/worktrees.js ← دورة حياة git worktree مؤقت ومعزول من HEAD، بمسار منقّى
                       تحت ~/.satr/worktrees وأوامر git بمصفوفة وسائط بلا shell
electron/executor.js ← نواة عامل منفّذ محايدة عن المحرك داخل worktree فقط؛ لا تعمل إلا
                       بـrunner محقون يحمل engine label صريحاً، وتجمع git diff وتحذف النسخة
                       المؤقتة بلا commit أو merge
electron/executionteam.js ← منسّق 1–3 عوامل منفّذة متوازية؛ worktree وملكية كتابة لكل عامل،
                       كشف تعارض وإيقاف جماعي، ويحفظ patch داخلياً للمراجعة
electron/reviewer.js ← مراجع ثانٍ SDK/محوّل بوضع plan بلا أدوات؛ مخاطر وملاحظات وتوصية عربية
electron/reviewchanges.js ← «راجع تغييراتي الآن»: مراجعة عمياء cross-engine لشجرة
                       العمل **من المحادثة** لا من سطح غرفة العمليات — انظر القسم أدناه
electron/integration.js ← بوابة تحقق تكاملي: أوامر HEAD المثبتة + worktree مستقل + نتيجة بلا خرج خام
electron/merger.js ← بوابة تطبيق patch بعد مراجعة وتحقق وموافقة؛ git apply بلا shell أو force
electron/opsroom.js ← سجل غرفة العمليات الدائم append-only؛ فصل سلطة المحرك/المستخدم/النظام
                       وحجب الأسرار والـpatch، بلا أي قدرة تشغيل أو دمج
electron/opsroomindex.js ← فهرس غرف حسب بصمة المشروع بلا مسار مطلق؛ يسوّي التشغيل القديم
                       إلى interrupted ويعرض التاريخ المنقّى
electron/opsartifacts.js ← خزنة patch مشفّرة fail-closed بـsafeStorage؛ استعادة/حذف/احتفاظ محدود
electron/opsbrainstorm.js ← آراء مستقلة داخل cwd فارغ وبلا أدوات أو حلقة تلقائية.
                       SDK وCodex **إلزاميان**، وKimi Code **اختياري** ينضم ثالثاً
                       حين يكون جاهزاً ويُتخطّى بصمت إن لم يكن (OBS-012 بند ب)
electron/opsplanner.js ← مخطط SDK قراءة فقط يقترح مهاماً وملكيات بنيوية غير متداخلة
electron/gitdiff.js  ← فروقات git للوحة «تغييرات المشروع» ± (الدفعة 4.7 — قراءة فقط):
                       git بمصفوفة وسائط بلا shell، status --porcelain -z (أسماء عربية
                       خام)، المعدَّل عبر تحليل git diff الموحّد (دقيق لأي حجم — سقف LCS
                       في diff.js يضلّل الملفات الكبيرة)، والجديد/المحذوف عبر computeDiff
                       بتوحيد CRLF/LF (درسان مثبّتان). قراءة فقط (الأفعال في gitactions.js)
electron/gitactions.js ← أفعال git للوحة ± (دفعة «أفعال git»): stage/unstage/discard/commit.
                       الجانب الكاتب المقابل لـ gitdiff.js (يبقى قراءة فقط). أمان: المسار
                       يُتحقَّق منه مقابل مجموعة `git status -z` الحيّة (لا حقن — مسار ليس
                       متغيّراً يُرفض)، execFile بمصفوفة وسائط بلا shell + فاصل `--`، وحذف
                       غير المتتبَّع بـ fs داخل جذر المستودع حصراً. discard مدمّر (checkout
                       HEAD للمتتبَّع، حذف قرص للجديد) — تؤكّده الواجهة بـ confirm قبل الاستدعاء
electron/exporter.js ← تصدير المحادثة Markdown (الدفعة 4.8 «مشاركة» — قراءة فقط):
                       القرص مصدر الحقيقة للمحرّكين — جلسات كلود عبر sessions.readFullSession
                       (تحديد الملف بمعرّف الجلسة UUID بمسح مجلدات المشاريع — لا اشتقاق
                       ترميز اسم المجلد من cwd) ومحادثات المحوّلات عبر chats.read(cap=0).
                       الحفظ في الواجهة (Blob + تنزيل) — لا مسار كتابة في العملية الرئيسية
electron/skills.js   ← فهرس مهارات محمول: .agents/skills هو المعيار و.claude/skills للتوافق
                       (مشروع ثم مستخدم)، metadata فقط أولاً ثم SKILL.md/الموارد عند الطلب؛
                       تحقق مسار/حجم ولا تنفيذ تلقائي للسكربتات
electron/tasks.js    ← Task Ledger موحّد ودائم تحت ~/.satr/tasks/<engine>/<session>.json:
                       pending/in_progress/completed/blocked + dependencies/owner/evidence؛
                       schema v1، تنقية وسقوف وكتابة ذرية أفضل جهد، بلا prompts/transcript
electron/verify.js   ← قارئ/مشغّل .satr/verify.json الصريح: ≤6 أوامر أحادية السطر، لا تخمين
                       ولا تشغيل تلقائي؛ التنفيذ في طرفية النموذج بعد إذن exec والخرج مسقوف
electron/checkpoints.js ← checkpoint لكل دور يجمع file_edit IDs وmetadata تحت ~/.satr/checkpoints؛
                       استعادة عكسية لآخر checkpoint الحي عبر undo القائمة، بلا Git history
electron/sdkrewinds.js ← حاجز دائم خاص بـnative rewind تحت ~/.satr/sdk-native-rewinds.json؛
                       UUID/checkpoint منقّيان، ≤200 جلسة، وكتابة temp+rename ذرية. لا يغيّر
                       checkpoints.js ولا يخزن مسارات أو محتوى ملفات
electron/memory.js  ← ذاكرة مشروع شخصية منفصلة عن transcript تحت ~/.satr/memory/<cwd_sha256>.json:
                       facts/decisions/commands/failures بمصدر/تاريخ/ثقة/نطاق؛ رفض أسرار،
                       فهرس كلمات/مسارات، واسترجاع مقتصد. الاقتراح لا يكتب دون موافقة صريحة
electron/genmedia.js ← نواة توليد الوسائط BYOK (م١/ج8+ج9+ج10): سجل مزوّدين بطبقتين + كتالوج
                       بأسعار **مقيسة حياً** ومؤرَّخة + توجيه بافتراضي معلن ثم أرخص-فأرخص
                       بسقوط صريح + تنزيل الأصول إلى <cwd>/generations/ وسجل JSONL في
                       <cwd>/.satr/generations.jsonl. الأنواع image/video/audio، وrefs عبر
                       image-to-image بـdata: URI (بلا رفع)، وافتراضي الصور GPT Image عبر fal
                       (النص العربي) وflux/schnell «الأرخص» صريحاً، ولا افتراضي للفيديو.
                       حارس مجلد المستخدم يرفض cwd=home بـno_project قبل أي شبكة.
                       مدد الصوت 10/30/63/120ث مدخل كتالوج لكل واحدة بسعرها المقيس
                       (wire_model يفصل مسار السلك عن المعرّف — لا حقل duration في الطلب).
                       fal وحده مثبت بمسبار حيّ؛ openai/gemini معرَّفان معطَّلان (unproven)
                       وmanaged خانة م٣ معطَّلة. صفر اعتماديات (https المدمجة)
electron/diff.js     ← حساب فرق الأسطر (قصّ بادئة/لاحقة + LCS محدود + طيّ السياق)
                       دالة نقية بلا اعتماديات — المرحلة 3
electron/inject.js   ← حقن @الملفات للمحوّلات (الدفعة 1.1 من ROADMAP): يقرأ الملفات المُشار
                       إليها بـ @مسار ويحقنها في برومبت المحوّلات «العمياء» (كل محرك غير SDK
                       ليس من عائلة claude — cli مستثنى لأن كلود يقرأ بنفسه). نقي بلا اعتماديات
                       (نمط diff.js). تنقية: المسار داخل cwd حصراً (لا مطلق ولا ..)، سقف
                       64ك/ملف و192ك إجمالاً و12 ملفاً، رفض الثنائي (بايت NUL)، تجاهل غير
                       الموجود بصمت (@ قد لا تكون إشارة ملف). يعيد {prompt, attached, skipped}
                       — ردّ satr:send يحملها (injectedFiles/skippedFiles) والواجهة تعرض
                       تنبيهات «📎 أُرفق…»/«⚠️ لم يُرفق…»
electron/adapters/   ← طبقة المحوّلات/المزوّدين (المرحلة 5): سجلّ قابل للحقن + عقد موحّد
                       index.js (register/get/list) + claude-cli.js (مسار claude -p المنقول) +
                       gemini.js (REST مباشر + حلقة وكيل بصيغته — 2.4) + openai-compatible.js
                       (مصنع لأي endpoint متوافق OpenAI: DeepSeek/Qwen/GLM… + حلقة وكيل
                       2.1–2.3 بالأذونات العربية) + openai-responses.js (خارطة المنصّات: محوّل
                       OpenAI عبر Responses API — api.openai.com ثابت، store:false، allowlist
                       نماذج، SSE typed، strict schemas + Structured Outputs) + usage.js (عقد
                       usage موحّد {input,output,cached,reasoning,source} لـ Chat وResponses).
                       محرك SDK يبقى خاصاً في agent.js (لا يُلفّ).
                       انظر «طبقة المحوّلات والمزوّدين» أدناه + docs/ARCHITECTURE.md
electron/autogate.js ← بوابة وضع «تلقائي ذكي» (auto — خارطة المنصّات الموجة 4): موديول نقي
                       بلا تبعيات (نمط diff.js) يستهلكه agent.js وmain.js. AUTO_SAFE_TOOLS
                       (whitelist للآمن fail-safe) + autoNeedsPrompt + decideAutoApproval (سياسة
                       canUseTool المستخرجة المُختبَرة) + nonSdkPerm. اختبار scripts/autogate.test.js
electron/secretscrub.js ← بوابة حجب الأسرار المشتركة (K5): موديول نقي بلا اعتماديات
                       (نمط diff.js) — النمطان القائمان sk- وkey=value + JWT/Bearer/PEM/
                       AWS/GitHub/Slack، وتحفظ إلزامي ضد الإيجابيات الكاذبة (SHA/UUID/
                       مسارات/حزم). يستهلكه kimi.js (scrubStreamText) وtermjobs.js
                       (scrubDoneTail). اختبار scripts/secretscrub-test.js
electron/browserguard.js ← حارس المتصفح الخارجي (دفعة «تحكم الوكيل الكامل» 2026-07-18):
                       موديول نقي بلا تبعيات (نمط autogate.js) مشترك بين المحرّكين.
                       isExternalBrowserLaunchCommand (استُخرجت من codex.js — نسخة واحدة)
                       + promptRequestsExternalBrowser (طلب المستخدم الصريح لمتصفح خارجي
                       في رسالة الدور يعطّل الاعتراض — قرار مالك). اختبار test:browserguard
electron/browserorigin.js ← تطبيع origin وتصنيف أدوات المتصفح (read/navigate/act/handoff)
                       وثقة localhost/نطاقات المستخدم؛ منطق نقي يحرسه test:browserorigin.
electron/browserpolicy.js ← سياسة متعامدة للأفعال الحسّاسة/خطر التسريب/ميزانية أفعال مهمة التصفح:
                       تستعمل memory.hasSecret، وتفرض neverAlways، ويحرسها test:browserpolicy.
electron/execguard.js ← حارس نقي لأوامر الخوادم: يرفض Bash/run_in_terminal الخلفي أو أمر
                       خادم معروف ويوجّه إلى run_in_background قبل أي موافقة دائمة.
electron/envbrief.js  ← المصدر الموحّد لهوية «سطر» وجرد أدوات كل محرك وسياسة التنفيذ
                       المرئي والمتصفح وسطر البيئة؛ يحرسه test:envbrief ضد التقادم.
electron/keys.js     ← مخزن أسرار «سطر» (~/.satr/keys.json): get/names/set/remove — بذرة إدارة
                       مفاتيح المزوّدين (نقطة الربط §4.3). القيم لا تُعاد للواجهة أبداً
electron/tools.js    ← أدوات الوكيل للمحوّلات العمياء (الدفعتان 2.1/2.2): defs() تعريفات
                       بصيغة OpenAI tools + run(name, cwd, args, ctx) تنفيذ محلي يعيد
                       {ok, content}. القراءة: read_file/list_files (فوق files.js المؤمَّنة،
                       سقف نتيجة 48ك، بلا إذن — تطابق Claude Code) وsearch_code (4.6 —
                       بحث «دلالي خفيف» فوق search.js) وrepo_map (الأولوية 5 — خريطة
                       تقريبية مقتصدة)، وكلاهما بلا إذن. الكتابة (2.2):
                       write_file/edit_file/delete_file — needsPermission() يوجب مربع الإذن العربي
                       (delete_file أُضيف لأن حذف الأسماء العربية عبر صدفة del/rm هشّ؛
                       resolveExisting يتسامح مع تطبيع Unicode NFC/NFD فيصيب الملف القائم).
                       (يسأل المحوّل قبل التنفيذ)، وctx {emit, id} يُصدر file_edit
                       (نفس عقد SDK: بطاقة diff + تراجع) بلقطات editSnapshots خاصة
                       وundoEdit() نظيرة agent.undoEdit (main.js يجرّب الاثنين).
                       حدود: 1م.ب/كتابة، لا تعديل ملف >2م.ب أو ثنائي. والتنفيذ (2.3):
                       run_command في طرفية النموذج المرئية (term.ensureModelTerm +
                       runCapture — نفس مسار run_in_terminal للمرحلة 16) بطبقة إذن 'exec'
                       إلزامية كل مرة (لا «موافقة دائمة» ولا يعفيها acceptEdits —
                       bypassPermissions وحده). permissionTier() تعيد write/exec/null
                       وتضيف run/stop_background_task كـexec وget/list كقراءة.
electron/chats.js    ← ذاكرة المحوّلات على القرص (الدفعة 1.3): load/save لسجلّ محادثات REST
                       في ~/.satr/chats/<provider>/<session>.json بصيغة المحوّل الأصلية.
                       تنقية regex صارمة للمعرّفات، سقف 50 جلسة/مزوّد (تنظيف بالأقدم)،
                       أفضل جهد (فشل القرص لا يكسر الدور — الكاش الحيّ يكمل)
electron/features.js ← طبقة القدرات (feature-flags) + المُحمِّل الشرطي لـ enterprise/ (نقطة الربط
                       §4.1/§4.4): النواة تعمل كاملة إن غاب enterprise/. أساس نموذج Community+Enterprise.
                       منذ الدفعة 3 نقاط الربط الممرَّرة: setFlag (§4.4) + registerProvider
                       (§4.2) + openaiCompatible (المصنع — Ollama والمزوّدون يبنون عليه بلا تكرار) +
                       registerIpc (قنوات satr:ee: حصراً — §4.5) + subscribe (§4.7 مجرى
                       مراقبة أحداث: main.js يبثّ عبر notify() كل أحداث الدور + prompt +
                       permission_reply — للتدقيق والاستهلاك). notify رخيص بلا مشتركين
electron/eventtrace.js ← عدّاد أحداث الدور (‏OBS-142): وحدة نقية بلا تبعيات (نمط
                       diff.js) تجيب «أين يسقط الحدث؟» بأربع نقاط قياس — `emit` قبل
                       أي مرشّح · حارس `runSeq` (وكان `return` صامتاً) · `emitToWindow`
                       · و`onEvent` في `app.js`. لا يمرّ منها نصّ إطلاقاً: النوع
                       والطور و**طول** النصّ واسم الأداة بلا وسيطتها وسبب الإسقاط
                       ورمزا الدور. ذاكرة العملية فقط — لا قرص ولا شبكة — وتُقرأ
                       بـ`satr:eventTrace` (قراءة فقط بلا مدخلات). حلقة 200 إسقاط
                       والقصّ معلن في `dropsOverflow`. أداةُ قياسٍ لا علاج.
electron/activity.js ← سجل Community محلي مختصر ومحدود (200 حدث): يخزن نوع النشاط والمحرك
                       واسم الأداة والمسار النسبي وقرار الإذن والنتيجة فقط، مفصولاً ببصمة
                       المشروع. لا prompt أو tool input/output أو cwd/session/permission ids؛
                       `satr:activityList/Clear` يعرضان ويمسحان المشروع الحالي فقط.
scripts/enterprise-  ← عقد checkout الخاص لـEnterprise: `enterprise-source.js` يتحقق من
source.js               SATR_ENTERPRISE_DIR المطلق خارج Community ومن contractVersion=1؛
                       `ee-builder-config.js` يحقنه في enterprise/ داخل حزمة EE فقط.
                       المصدر المملوك في مستودع `satr-enterprise` الخاص ولا يدخل Git العام.
                       غيابه = النواة تعمل كاملة (معيار §1، متحقق في test:enterprise)؛
                       Ollama الفردي موجود في electron/adapters/ollama.js ولا يتطلب الترخيص.
electron/bgprocs.js  ← شبكة أمان للعمليات الخلفية القديمة التي تفلت من المسار المرئي:
                       خطّافا Bash يلتقطان PIDs قبل/بعد، وتظهر بجانب مهام pty في شريط
                       «قيد التشغيل». المسار الأساسي للخوادم هو termjobs لا bgprocs.
electron/term.js     ← عدة pty عبر node-pty + مخزن خرج دائري 256KiB لكل طرفية + قفل FIFO
                       لـrunCapture + استعادة التبويبات الحيّة. التصميم في docs/PHASE8-DESIGN.md
electron/termjobs.js ← مهام معمّرة فوق term.js (MAX_JOBS=4): خوادم/عمليات طويلة في تبويبات
                       🛠 مرئية، مستقلة عن الدور والجلسة، ولا تكرّر spawn. ومنذ دفعة
                       «توصيل bg_term_done للنموذج» (2026-08-24) يملك أيضاً سجل الخروج
                       الأخير والانتظار الحاجب وكتلة الحقن — انظر القسم المخصص أدناه.
electron/devservers.js ← سجلّ آخر أمر خادم لكل بصمة cwd في ~/.satr/devservers.json، مع
                       رصد last_url من خرج مهام pty وكتابة ذرية أفضل جهد.
electron/preview.js  ← لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب»): متصفح
                       WebContentsView أصلي (صفر اعتماديات) معزول كلياً — sandbox +
                       partition دائمة مستقلة + **بلا preload** (الصفحة لا ترى window.satr)
                       + http/https حصراً + رفض كل أذونات الويب + المنبثقات لنفس العرض.
                       الواجهة ترسم الإطار وتبلّغ مستطيل العرض (satr:previewBounds)
                       والعرض الأصلي يطفو فوقه؛ أحداثه عبر قناة satr:preview.
                       يبثّ أيضاً agent_activity (نشاط Codex على المتصفح) عبر previewSender
                       ويملك تعبئة النماذج غير السرّية ونقل الأسرار بمخزن مؤقت مبهم وطلب
                       إدخال المستخدم داخل الحقل؛ لا يعيد قيمة سرّية ولا يسجلها.
                       **مرآة RTL (درس مثبّت — بلاغ مستخدم 2026-08-11)**: حين تكون لغة
                       واجهة التطبيق RTL (نظام المستخدم بالعربية) يعكس Chromium إحداثي x
                       لطبقة العرض الأصلي فيضعه عند contentWidth − x − width، فيطفو فوق
                       المحادثة بينما إطار اللوحة في مكانه. المستطيل الذي تبلّغه الواجهة
                       صحيح دائماً؛ التعويض في preview.js وحده (nativeBounds/applyBounds
                       + isRtlUi من app.getLocale + إعادة تطبيق عند resize لأن عرض المحتوى
                       يدخل الحساب). أثبته scripts/rtl-bounds-probe.js حياً على Electron 33:
                       en-US ‏x=0→0 و400→400 · ar ‏x=0→584 و400→184 (‏contentWidth=784).
                       الحارس: npm run test:rtl-preview (حيّ — يشغّل الوحدة الإنتاجية تحت
                       ‏--lang=ar ويقيس الموضع من لقطة شاشة). **خارج test:full عمداً** لأنه
                       يحتاج نافذة مرئية وdesktopCapturer؛ يُشغَّل يدوياً عند مسّ المعاينة.
                       ⚠️ بيئة التطوير اللاتينية أخفت هذا العطل عن كل المستخدمين العرب —
                       أي عمل على موضع العرض الأصلي يُختبر بـ--lang=ar قبل الإصدار.
electron/promocapture.js ← دورة نافذة التقاط المنتج المرئية وتفرد تسجيل البرومو: نسب اجتماعية
                       بيضاء، URL‏ http/https، حصر مصدر desktop capture بالنافذة المنشأة،
                       إيقاف/إغلاق، وسجل مقاطع الجلسة داخل Downloads. لا يسجّل MediaStream
                       في main؛ renderer وحده يرمّز عبر MediaRecorder.
electron/promostudio.js ← عقد storyboard المنقّى: 1–40 مشهداً من فيديو/صورة داخل Downloads
                       فقط، مدة مقيدة، cut/fade، عنوان، وموسيقى/تعليق صوتي محليان. يبث
                       الاقتراح للواجهة ولا يصيّر أو يرفع؛ يحل file URL كسولاً للأصول
                       الموجودة في storyboard أو مقاطع جلسة الالتقاط فقط.
electron/previewrecording.js ← يثبّت تنزيلات المعاينة ومقاطع البرومو ذات الأسماء المنقّاة
                       في Downloads بمسارات فريدة، ويرفض بقية تنزيلات النافذة عن هذا العقد.
electron/codexmcp.js ← خادم MCP‏ streamable-HTTP داخل العملية يعطي محرك Codex رؤية الويب
                       (الخيار 1): يفوّض أدوات المعاينة (open_preview/read_page/snapshot/
                       console/network/screenshot + أفعال بالإذن) مباشرةً إلى preview.js.
                       http المدمجة صفر اعتماديات، 127.0.0.1، Bearer بزمن ثابت. codex.js
                       يبدأه قبل spawn ويحقنه عبر -c mcp_servers.satr_preview (انظر قسم
                       «رؤية الويب لـ Codex»). ويعرض أدوات الخلفية الأربع وأدوات البرومو
                       الثلاث؛ الأدوات مصنّفة browser/read/exec كي لا يعفي browserControl التنفيذ.
src/index.html       ← هيكل الواجهة: HTML فقط — وسوم المكوّنات + ترميز light DOM لمن يحتاجه
                       (topbar/composer) + وسوم تحميل الوحدات (التفكيك اكتمل — docs/COMPONENTS-PLAN.md)
src/styles/base.css  ← الورقة الأساس: Design Tokens في :root (تعبر حدود Shadow بالوراثة) +
                       أنماط مناطق light DOM (المحادثة/الطرفية/المؤلّف/الشريط) — أنماط
                       مكوّنات Shadow في أوراق ui/lib عبر adoptedStyleSheets حصراً
src/ui/app.js        ← قشرة الإقلاع والتوجيه (وحدة ES منذ ت-13): تملك حالة التطبيق
                       (sessionId/busy/currentBlock/المحرك/النماذج) + مجرى أحداث satr:event
                       (orchestration يستدعي methods كتلة newAssistantBlock من مكوّن المحادثة)
                       + send/compact + COMMANDS + الاستئناف + التصدير + التحديث التلقائي
src/ui/lib/          ← وحدات ES مشتركة للمكوّنات: sheet.js (مساعد adoptedStyleSheets — آلية
                       أنماط المكوّنات الحصرية) + panel.css.js (ورقة اللوحات الجانبية —
                       منذ جولة الصقل 2026-08-08 تعزل code المضمّن LTR/isolate كي لا تتشوه
                       المسارات داخل النص العربي؛ يحرسه مشهد ui:audit ‏41 هندسياً) +
                       diff.js (buildDiff بعقدها الثلاثي: محادثة/عارض/git) + diff.css.js
                       (المصدر الوحيد لأنماط بطاقة الفرق منذ ت-12: تُعتمد على المستند من
                       chat.js للـ light DOM وعلى shadowRoot في git/العارض) + highlight.js
                       (HL_CFG + hlLine) + promo-renderer.js (فك فيديو/صورة + canvas‏ RTL +
                       Web Audio + MediaRecorder فوري) + update-toast.js (توست التحديث/الإشعار العابر —
                       استُخرج من app.js لاختباره حيّاً في test:update-ui، سلوك مطابق حرفياً).
                       جسر window.SatrUI أُزيل في ت-13 — استيراد مباشر فقط
src/ui/components/   ← 16 مكوّن Web Component (بادئة satr-، ملف لكل مكوّن) — انظر قسم
                       «مكوّنات الواجهة» أدناه (السادس عشر: promo-studio)
src/vendor/          ← أصول مُضمّنة (vendored) للواجهة — الناتج مُلتزَم (لا اعتمادية npm وقت
                       تشغيل للواجهة): xterm.js (يولّده scripts/vendor-xterm.js) + خط IBM Plex
                       Sans Arabic في fonts/ مع fonts.css (يولّدهما scripts/vendor-fonts.js)
scripts/vendor-xterm.js ← ينسخ lib/xterm.js و css/xterm.css من node_modules إلى src/vendor —
                       يُشغَّل يدوياً عند ترقية إصدار xterm.js فقط
scripts/vendor-fonts.js ← يضمّن خط IBM Plex Sans Arabic (OFL) من devDependency
                       ‏@fontsource/ibm-plex-sans-arabic: مجموعتا subset عربي+لاتيني ×
                       الأوزان 400/500/700، woff2 حصراً (~190ك.ب)، وكتل @font-face تُستخرج
                       من CSS الحزمة (unicode-range يبقى متزامناً) — يُشغَّل يدوياً عند الترقية
docs/PHASE8-DESIGN.md ← تصميم الطرفية العربية: المقاربات الثلاث، القرارات المثبّتة (الصدى،
                       حدود الإدخال، الأداء، محرك واحد بعارضين)، المراحل الفرعية 8.1–8.4
docs/DESIGN-SYSTEM.md ← نظام التصميم الحاكم: التصنيف السداسي، منسّق الأسطح، سلالم الـ tokens،
                       والحوكمة الملزِمة لأي عنصر UI جديد
scripts/update-csp.js ← يحدّث هاشات CSP لكتل style/script المضمّنة — يعمل تلقائياً قبل start و dist
scripts/make-icon.js  ← يولّد build/icon.ico من علامة «سطر» (بلا اعتماديات: zlib يبني PNG ثم
                       يُحزَم ICO) — يُشغَّل يدوياً عند تغيير العلامة، والملف الناتج مُلتزَم
scripts/agent-eval.js ← مرصد واختبارات الوكيل (الأولوية 0): replay حتمي بلا شبكة فوق 12 fixture
                       في scripts/evals/tasks.json + live اختياري لمحركي sdk/codex. يتحقق من
                       عقد الأحداث والملفات والأذونات والمقاطعة؛ يمنع أدوات browser في هذه
                       الدفعة. traces تحت dist/agent-eval تحفظ hashes/metadata لا prompts أو
                       خرج أدوات افتراضياً. التشغيل: npm run eval:agent؛ baseline الملتزم في
                       docs/AGENT-EVAL-BASELINE.md (تحديثه الصريح: npm run eval:agent:baseline).
scripts/full-suite.js ← مشغّل البوابة (‏`npm run test:full`): ‏SUITE المعلنة +
                       EXCLUDED_FROM_SUITE بأسباب ومهل مقيسة (‏OBS-056) وتخطٍّ معلن على POSIX.
                       ومن `OBS-036`: إعادة محاولة معلَنة لعثرات بيئية مقيسة — ‏RETRYABLE مغلقة
                       (كل اسم بتبرير OBS-### في RETRYABLE_OBS محفور بجواره في المصدر)، سقف
                       ‏MAX_RETRIES=1، إعلان صاخب عند التعثّر وذكر المُعاد في الخاتمة. العقد
                       مفحوص ساكناً وسلوكياً في `test:suite-coverage` (زرع spawnSync وثلاثة
                       سيناريوهات على `main()` الحقيقي: فشل-ثم-نجاح، فشل مرتين، اسم غير مقيّس).
docs/AGENT-CLI-FLAGS.md ← أعلام تشغيل محرّكات الوكلاء من سطر الأوامر (codex/kimi/claude)
                       موسومة **مثبت** (من `--help` حيّ أو استعمال في المستودع) مقابل
                       **مُبلَّغ** (تقرير خارجي غير متحقَّق منه). سببها عطل مكلف: قائد
                       خارجي ظن أن `codex exec` لا ينفّذ شيئاً فبنى ست سكربتات سياق
                       يدوية، والسبب علم مفقود (`--dangerously-bypass-approvals-and-sandbox`)
                       لا عطل منصة. يوثّق أيضاً أن `-o/--output-last-message` يغني عن
                       استخراج الرد من `~/.codex/sessions/*.jsonl`
docs/PLAN.md         ← خطة التنفيذ المرحلية — اقرأها قبل أي مرحلة جديدة
site/                ← صفحة الهبوط (قرار «توزيع أوسع» 2026-07-18): HTML/CSS/JS خالص بفكرة
                       «السطر الذي يلتئم»، GSAP+ScrollTrigger+Lenis مضمّنة vendored (صفر
                       CDN، CSP صارم، reduced-motion كامل)، اللوحة من tokens التطبيق،
                       واللقطات في assets/ من مكوّنات الواجهة الإنتاجية. خارج حزمة
                       التطبيق (files allowlist). التطوير: npm run site:serve (4600)؛
                       الترقية: vendor:site؛ توليد اللقطات: site:shots (حتمي — الزمن
                       مجمَّد في fixture الغرفة، ونافذة offscreen واحدة تُعاد — الثانية
                       تفشل ERR_FAILED). fixtures تحت scripts/fixtures/site-shots-*.
                       منذ ج10: قسم «ولّد من سطر» يشرح التوليد العربي وبطاقة المحادثة
                       والمعرض والكلفة قبل التنفيذ وBYOK المجاني دائماً؛ لقطاته الثلاث
                       من مكوّنات chat/gallery/perm الإنتاجية وبيانات ثابتة في
                       scripts/fixtures/site-shots-gen*، بلا CDN أو رابط تنزيل جديد.
```

ملاحظة CSP: لا يوجد `'unsafe-inline'` — أي `<style>` أو `<script>` مضمّن جديد في index.html
يتطلب إعادة حساب الهاش، وهذا يحدث تلقائياً عبر `prestart`/`predist`. السمات المضمّنة
(`style="..."` أو `onclick="..."`) محظورة — استخدم CSSOM و addEventListener.
**منذ ت-0 (تفكيك المكوّنات)**: لا كتل مضمّنة أصلاً — الأنماط في `styles/base.css` والمنطق
في `ui/app.js` (تغطيهما `'self'`) والتوجيهان يخرجان **بلا هاشات**؛ update-csp يبقى حارساً
يهشّ أي كتلة مضمّنة تعود مستقبلاً. أنماط المكوّنات عبر `adoptedStyleSheets` حصراً
(`ui/lib/sheet.js`) — **وسم `<style>` داخل Shadow DOM محجوب بـ CSP** (تحقق حيّ مثبّت
في docs/COMPONENTS-PLAN.md §1).
قالب الـ CSP نفسه (التوجيهات لا الهاشات) معرّف في `scripts/update-csp.js`، فأي توجيه جديد
يُضاف هناك لا في index.html مباشرة (وإلا داسه `prestart`). مثال: `img-src 'self' data:`
أُضيف للمرحلة 4 ليسمح بمصغّرات الصور الملصقة (data: URL)، و`media-src 'self' blob:`
يسمح حصراً بعرض/تجميع وسائط الاستوديو المحلية؛ لا `connect-src` جديد ولا URL وسائط بعيد.
تنبيه نهايات الأسطر: محلّل HTML يطبّع CRLF إلى LF قبل حساب هاش CSP، وupdate-csp يطبّع
مثله قبل الهش — لا تحسب الهاش يدوياً على ملف CRLF (git autocrlf يسحب LF كـ CRLF على ويندوز).

