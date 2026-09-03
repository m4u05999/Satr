# سطر (Satr) 2.0 — دليل المشروع لـ Claude Code

## ما هذا المشروع

تطبيق سطح مكتب (Electron) يحل مشكلة عرض اللغة العربية (RTL + تشكيل الحروف) عند استخدام
أدوات الذكاء الاصطناعي في سطر الأوامر — وعلى رأسها Claude Code. الطرفيات التقليدية لا تدعم
BiDi فيظهر العربي مقطّعاً ومعكوساً؛ «سطر» يشغّل هذه الأدوات في الخلفية ويعرض المحادثة
في واجهة HTML تعرض العربية بشكل مثالي.

الرؤية النهائية: البيت العربي لكل أدوات CLI الذكية (Claude Code أولاً، ثم Gemini CLI و Codex عبر محوّلات).

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

### تدفق البيانات

1. الواجهة تستدعي `window.satr.send({prompt, cwd, sessionId, model, permissionMode, engine, images, skills})`
   - `images` (المرحلة 4): مصفوفة `[{media_type, data}]` للصور الملصقة، `data` base64 خالص.
     تُنقّى في main.js (`sanitizeImages`: أنواع `image/png|jpeg|webp|gif`، ≤10م.ب base64، ≤6 صور).
     المحركات الأصلية **sdk** و**codex** و**kimi-code** تدعمها (Kimi يرسل كتلة ACP
     `image`)؛ المحركات غير المعلنة vision تتجاهلها والواجهة تنبّه.
     طلب بلا نص يُقبل إن رافقته صورة.
   - `skills` (لوحة /مهارات): `'all'` أو مصفوفة أسماء مفعّلة. تُنقّى في main.js
     (`sanitizeSkills` + `SAFE_SKILL`) وتُمرَّر لكل المحرّكات. SDK يمرّر مهارات `.claude`
     للـ runtime الأصلي ويعرض `.agents` عبر أداتي MCP محليتين للتحميل التدريجي؛ Codex
     يرفق `UserInput(type:'skill', name, path)` الأصلي؛ والمحوّلات تعرض metadata في system
     context وتحمّل المحتوى فقط عبر `load_skill`/`read_skill_resource`.
   - `task_update` (Task Ledger، schema v1): snapshot كامل بعد التنقية والحفظ، بالشكل
     `{type, schema_version:1, engine, session_id, revision, state, source, updated_at,
     tasks:[{id,title,status,dependencies,owner,evidence:[{text,kind?}]}]}`. الحالات
     `pending|in_progress|completed|blocked`، وحالة السجل `active|paused|completed`.
     `main.js` هو نقطة التثبيت: يعترض الحدث الخام من المحرك، يربطه بالمحرك والجلسة
     المنقّيين، يستدعي `tasks.apply()`، ثم يبث snapshot المحفوظ للواجهة والمراقبة.
   - `checkpoint_update` (schema v1): `{id,engine,session_id,previous_id,state,
     edit_count,files,verification,restorable}`. الحالات `open|ready|passed|failed|
     restored|partial`. لا يحمل snapshots أو محتوى ملفات؛ `restorable` لا يكون true إلا
     لآخر checkpoint ذي لقطات undo حية وفي cwd نفسه.
   - `verification_result` (schema v1): `{engine,session_id,checkpoint_id,task_title,
     linked_task,passed,summary,checks[]}`. الخرج مقصوص في الحدث/tool_result؛ التخزين الدائم
     داخل checkpoint يحتفظ `SHA-256` والحجم والحالة فقط، لا الخرج الكامل.
   - `memory_candidate` (schema v1): مرشّحة منقّاة `{kind,content,source,confidence,scope,
     shareable}` للعرض فقط. `main.js` يعيد بناء المصدر ويرفض أنماط الأسرار قبل renderer؛ لا
     كتابة حتى `satr:memorySave` من زر المستخدم. `memory_rejected` لا يحمل المحتوى المرفوض.
   - `research_update` (schema v1): snapshot حيّ لفريق البحث `{run:{id,state,question,
     workers[],summary,sources,cost}}`. كل worker يحمل الحالة والخلاصة والمصادر والمدة والكلفة
     وعدد الأذونات المرفوضة. لا transcript ولا محتوى ملفات في الحدث.
   - `effort` (⚙ — المرحلة 14.4): مستوى جهد التفكير `low|medium|high|xhigh|max` أو فارغ
     (الافتراضي). يُنقّى بـ `EFFORT_LEVELS` في main.js ويُمرَّر كخيار `effort` — الـ SDK
     يخفّضه صامتاً إن لم يدعمه النموذج. محرك **sdk** و**codex** (خارطة المنصّات الموجة 2):
     codex.js يطبّعه إلى مفتاح `model_reasoning_effort` الرسمي، ويقبل `max` و`ultra` حين
     يعلنهما `model/list`، ويحقنه عبر `-c` عند spawn. المحوّلات لا تدعمه بعد.
   - `extraDirs` (⚙ «مجلدات إضافية» — المرحلة 14.4): مصفوفة مسارات يصل إليها النموذج
     بجانب cwd. تُنقّى في main.js (`sanitizeExtraDirs`: مجلد موجود فعلاً، سقف 10)
     وتُمرَّر `additionalDirectories`. تُحفظ في localStorage (`satr_extra_dirs`). sdk فقط.
2. حسب `engine` (قائمة «المحرك» في الواجهة، الافتراضي `sdk`؛ القائمة تُبنى ديناميكياً من
   `satr:providers`): المحركات الأصلية `sdk` و`codex` و`kimi-code` تُوجّه صراحةً إلى
   `agent.js` و`codex.js` و`kimi.js`، وما عداها يمر عبر **طبقة المحوّلات**
   `adapters.get(engine)` (main.js يُنقّي المدخلات ثم يستدعي `start`):
   - **sdk** (المرحلة 2): `electron/agent.js` يستدعي `query()` من `@anthropic-ai/claude-agent-sdk`
     بإدخال بثّي (مولّد يبقى مفتوحاً حتى نهاية الدور — شرط عمل `interrupt()`)
     مع `includePartialMessages` و `canUseTool` و `resume/model/permissionMode/cwd`
   - **cli** (احتياطي، `adapters/claude-cli.js`): `claude -p --output-format stream-json --verbose …`
     - البرومبت عبر **stdin**؛ على ويندوز `shell: true` لأن claude قد يكون `.cmd`
     - يُشغَّل بـ `detached: true` (ويندوز): مجموعة عمليات وكونسول خاصّان به، فأي
       حدث تحكّم كونسول (CTRL_C/CTRL_BREAK) من خادم تطوير طويل العمر يبقى محبوساً
       في شجرته ولا يصل «سطر». الإيقاف بـ `taskkill /T /F` (نزولاً فقط)
   - **codex**: `electron/codex.js` عبر `codex app-server` وJSON-RPC، بجلساته وأذوناته.
     اتصال app-server الواحد يضاعف إشعارات خيط الجذر وخيوط `spawn_agent`؛ لذلك تُرشّح
     أحداث v2 للنص/العنصر/الخطة/الاستخدام/الدور بـ`threadId` و`turnId`. لا تستبدل
     `thread/started` الفرعية هوية الجذر، ولا ينهي `turn/completed` لطفل دور الجذر.
     يثبت `test:codex-contract` عدم تسرب رسالة وخطة وأداة واستخدام الطفل أو إنهائه المبكر،
     و`test:codex-subagent-live` يشغّل ثلاثة فروع فعلية بعلامات ثابتة ويتحقق من حاجز الجذر.
   - **kimi-code**: `electron/kimi.js` عبر `kimi acp` وJSON-RPC، باشتراك Kimi وجلساته.
   - **gemini / deepseek / qwen / …** (المرحلة 5): محوّلات REST (لا CLI) — انظر
     «طبقة المحوّلات والمزوّدين» أدناه. مقبضها في main.js هو `currentCliRun` (له `stop()`)
   - **عزل العمليات (حرج)**: العملية الرئيسية تتجاهل `SIGINT/SIGBREAK/SIGHUP` على
     ويندوز (انظر مناعة الكونسول في main.js) حتى لا يُسقطها حدث تحكّم كونسول قادم من
     عملية طفل. هذا ضروري لمسار **SDK** الذي يبثّ فيه الـ SDK عملية claude **بلا**
     detached (لا يتيح خياره)، فالمناعة هي حمايته الوحيدة. خروج «سطر» بإغلاق النافذة فقط.
3. الأحداث تصل الواجهة عبر `satr:event` — أحداث تشغيل ملغى تُحجب بـ `runSeq` في main.js
4. الواجهة تعالج الأحداث حسب `type`:
   - `system` (init): يحمل `session_id`
   - `assistant`: رسالة فيها `message.content[]` من نوع `text` أو `tool_use` (لها `id`, `name`, `input`).
     نصا Claude وCodex يحملان `phase: commentary | final_answer` لفصل سجل العمل عن الإجابة؛
     `agent.js` يطبّع كتل Claude ‏`thinking` إلى نص commentary، و`redacted_thinking` إلى
     إشعار آمن بلا بياناتها المشفّرة. غياب phase يعني `final_answer` للتوافق مع المحوّلات.
   - `user`: نتائج الأدوات `tool_result` (لها `tool_use_id`, `is_error`)؛ وفي محرك sdk
     يمر أيضاً إطار هوية رسالة المستخدم `{type:'user', message:{role:'user',content:''},
     parent_tool_use_id:null, uuid, session_id}`. الـUUID هو نفسه المولّد في
     `SDKUserMessage.uuid` داخل `promptStream`، وكلا المعرّفين يمران بحارس UUID صارم في
     `main.js`. لا يُعرض الإطار رسالةً ثانية؛ يربط فقط زرّي التفريع/الاسترجاع بفقاعة المستخدم.
   - `result`: النهائي — فيه `total_cost_usd`, `duration_ms`, `session_id`, `is_error`
   - `stream_text`: جزء نصي تدريجي `{text, phase?}` — يُعرض فوراً ويُستبدل بنص `assistant`
     المكتمل؛ المحركات الأصلية ترسل phase، والمحوّلات التي تغيب عنها تتراجع إلى الإجابة.
   - `permission_request`: `{id, tool, input, requester?, turnEligible?, alwaysEligible?}` —
     تفتح مربعاً عربياً بطابور FIFO وعدّاد الطلبات المعلّقة وسياق الطالب best-effort.
     الرد عبر `window.satr.permission(id, allow, always, turn)`؛ موافقة الدور مجموعة محلية
     في agent.js تُصفّر عند result/stop ولا تشمل exec/الإيقاف، و«دائماً» تبقى لعمر التطبيق.
   - `elicitation_request` (محرك SDK العادي فقط):
     `{id,server,mode:'form'|'url',fields:[{name,label?}],url?}` — `id` يطابق
     `^el_[a-f0-9]{32}$`، و`url` لا يوجد إلا في وضع URL. يفتح حوار موصّل عربي؛ أسماء
     الحقول وأوصافها منقّاة فقط، ولا تعبر رسالة MCP أو schema الخام. نسخة Community/
     Enterprise observer تحذف `url` كي لا تدخل query/state في سجل التدقيق. الرد المحدد
     الوحيد `window.satr.elicitationDone(id,action,content?)` موثّق في عقد دفعة C أدناه.
   - `file_edit` (المحرّكات ذات أدوات كتابة): `{id, tool, rel, isNew, added, removed, lines, truncated}`
     — يصدر بعد نجاح تعديل/كتابة، وتعرضه الواجهة كبطاقة
     فرق قابلة للطيّ. `id` هو `tool_use_id` (يربط الفرق بنفس الأداة). الرد على «تراجع»
     عبر `window.satr.undoEdit(id)` → `satr:undoEdit` (يعيد الملف أو يحذفه إن كان جديداً).
     وتجمع `app.js` الحدث نفسه لكل `rel` في ملخّص «تغييرات هذه الجلسة» (`+/−` وآخر
     بطاقة)؛ يُصفّر مع جلسة/خيط جديد ولا يغيّر عقد الحدث أو منطق البث.
   - `bg_procs`: قائمة عمليات الخلفية الحيّة `{procs:[{id, command, count, startedAt}]}`
     — **مستقل عن الدور** (يُبثّ مباشرةً لا عبر token الدور، ويصل حتى بعد انتهاء التشغيل).
     الواجهة تعرضه كشريط فوق المحرّر، وكل عملية لها زرّ قتل. الردّ عبر
     `window.satr.killBgProc(id)` → `satr:killBgProc` (id يطابق `^bg_[0-9]+$`)، والاسترجاع
     عند الإقلاع عبر `window.satr.listBgProcs()` → `satr:listBgProcs`. القتل بـ `taskkill /T /F`.
     تُقتل كل العمليات المتتبَّعة عند إغلاق «سطر» (`window-all-closed`/`before-quit`).
   - `bg_term`: `{id,label,shell,cwd}` لمهمة pty معمّرة؛ مستقل عن token الدور. الواجهة
     تتبنّاها كتبويب `🛠 <label>` وتضيفها إلى شريط «قيد التشغيل» مع إظهار/إيقاف.
   - `bg_term_done` (K4): `{id,label,exitCode,tail}` يُبث عند خروج مهمة pty معمّرة.
     `exitCode` رقم أو null (قتل/انهيار بلا رمز) · `label` منقّى ≤48 محرفاً كما
     عند البدء · `tail` نص منقّى: إزالة ANSI ومحارف التحكم، حجب أسرار ببوابة K2،
     قص ≤8000 محرف مع لاحقة `…` عند القص. يبقى خارج سجل المحادثة حتى ينقر المستخدم
     «أرسل الخرج للوكيل» فيُرسل دوراً عادياً بالذيل موسوماً غير موثوق.
   - `system`/`compact_boundary` (SDK فقط، أمر /ضغط): `{compact_metadata:{trigger, pre_tokens,
     post_tokens, …}}` — يصدر عند ضغط المحادثة، تعرضه الواجهة كبطاقة «ضُغطت المحادثة: X ← Y رمز».
     الجلسة تبقى نفسها (session_id) فتكمل المحادثة بالملخّص.
   - أحداث داخلية: `stderr`, `spawn_error`, `proc_done`

حالة الحلقة اليومية تبقى في renderer ولا تضيف عقد أحداث: `app.js` يحفظ آخر دور مستخدم
(`prompt` وصور data URL) لإظهار «أعد المحاولة» عند `spawn_error` أو `result.is_error` أو
الإيقاف، ويزيل الزر عند بدء دور جديد. قلم رسالة المستخدم يعيد نسخة النص والصور إلى
المحرّر ويرسلها لاحقاً عبر `send()` نفسه؛ هذا السلوك البسيط بقي الافتراضي ولم يتحول إلى
rollback. أما محرك sdk فيضيف بجواره فعلاً مستقلاً «🌿 فرّع من هنا» واسترجاع ملفات أصلياً
كما في العقد التالي.

### تفريع واسترجاع Claude الأصلي (دفعة A — 2026-07-24)

- **المسبار أولاً**: `scripts/fork-rewind-probe.js` شُغّل على
  `@anthropic-ai/claude-agent-sdk 0.3.176` و`Claude Code 2.1.214`. أثبت فرعاً بمعرّف جديد
  قابلاً للاستئناف، ومعاينة `rewindFiles(...,{dryRun:true})` لملف واحد بإحصاءات `+1/−1`،
  ثم استرجاعاً فعلياً أعاد البايتات تماماً. أُغلقت Query الدور الأصلية أولاً، ثم نُفّذت
  المعاينة والتنفيذ كلٌّ عبر Query تحكم عابرة مستقلة مستأنفة، وهو مسار الإنتاج نفسه. مصدر الرسالة هو UUID مولّد في
  `SDKUserMessage.uuid` الصادرة؛ طابق UUID سجل الجلسة وقبله `rewindFiles` و`forkSession`.
- **نطاق نقاط Claude الأصلية**: `enableFileCheckpointing:true` يمر فقط للتشغيل العادي
  لمحرك `sdk`. كل تشغيل يحمل `internalPolicy` — السياقات المعزولة وعوامل/غرفة العمليات —
  لا يفعّله. `rewindFiles` العابر يستأنف الجلسة عبر `withControlQuery` ويعيد تفعيله لذلك
  الاستدعاء فقط. آخر UUID مستخدم محفوظ بذاكرة محدودة (200 جلسة) لتتبّع الهوية فقط؛ لا يحل محل
  `userMessageId` الصريح ولا يُستخدم كمؤشر rollback ضمني.
- **IPC المنقّى**: `satr:sessionFork {sessionId,upToMessageId?,title?}` يقبل UUIDات
  canonical صارمة، يرفض عنواناً خاماً أطول من 512 محرفاً أو نوعاً غير نصي، يزيل محارف التحكم/Bidi
  وينقّي العنوان إلى ≤80 محرفاً، ويعيد `{ok:true,sessionId}` بعد التحقق
  من UUID الفرع. `satr:rewindFiles {cwd,sessionId,userMessageId,dryRun,confirmed?,previewToken?}` يرفض
  cwd غير الموجود وUUID المشوّه و`dryRun` غير المنطقي. التنفيذ `dryRun:false` لا يصل إلى
  SDK إلا مع `confirmed:true`، ويعيد main تنفيذ dry-run خادمية مباشرة قبل التنفيذ الفعلي. قفل واحد
  يمنع تداخل fork/rewind، ويرفض التحكم إن بدأ دور SDK أولاً ويرفض `satr:send` إن بدأ التحكم أولاً.
  معالج send نفسه محمي بـmutex كي لا يمر طلبان متزامنان قبل تسجيل المقبض. فترة `agent.start()`
  متتبعة أيضاً، وطلب الإيقاف التالي ينتظر مقبض البداية ثم يوقفه؛ بعد `proc_done` يبقى القفل حتى
  يحسم `run.done` (انتهاء استهلاك Query والتنظيف). الإيقاف ينتظر interrupt و`done` حتى 5ث، ثم
  يستعمل `forceClose` ويمهل ثانية أخيرة بدلاً من تعليق التطبيق مع CLI أقدم. `satr:stop` وإغلاق
  النافذة/التطبيق يرفع cancellation epoch، فيفشل أي send كان ينتظر إيقافاً سابقاً قبل بدء Query جديد.
  نجاح dry-run يصدر `previewToken` UUID أحادي الاستخدام صالحاً لدقيقتين ومربوطاً بـcwd/session/message
  وSHA-256 حتمي للمسارات الداخلية الكاملة والإحصاءات وبصمة كل ملف: SHA-256 للمحتوى الكامل والحجم
  وmtime (أو علامة `missing`). تُرتب المدخلات قبل digest، وسقف البصم 16MiB للملف و64MiB للمجموع؛
  تجاوزه يعيد `fingerprint_limit` بلا token، وفشل القراءة/نوع غير ملف يعيد
  `fingerprint_failed`/`invalid_file_type`. التنفيذ يقارن إعادة المعاينة بهذا digest ويعيد
  `preview_changed` بلا تنفيذ إن اختلفت. تُفحص المسارات مكوّناً مكوّناً بـ`lstat`؛ أي symlink/junction أو
  مسار خارج cwd أو محرف تحكم/Bidi أو قائمة تتجاوز 500 ملف يرفض العملية كاملة fail-closed بلا كشف المسار
  الخارجي. الخرج يعيد `{canRewind,filesChanged,fileCount,insertions,deletions,outsideCount?,previewToken?}`؛
  `fileCount` عدد المسارات الداخلية الفريدة لا طول قائمة SDK الخام، و`canRewind:true` بلا مصفوفة
  `filesChanged` يُرفض كاستجابة SDK مشوهة، ولا يعبر خطأ SDK الخام إلى renderer.
- **الواجهة**: القلم بقي نسخاً بسيطاً. «🌿 فرّع من هنا» يبدّل `sessionId` إلى الفرع الجديد
  ويعيد نص الرسالة وصورها إلى المؤلف بلا إرسال تلقائي. «↩ استرجع الملفات» يشغّل dry-run
  أولاً ثم يعرض مربع تأكيد عربي فيه عدد الملفات وإحصاءات الإدراج/الحذف والمسارات النسبية؛
  القبول وحده يرسل `confirmed:true`. حارس epoch يمنع الإرسال والجلسة الجديدة وتبديل المحرك أو استئناف
  جلسة أخرى أثناء العملية، ويُلغي الانتقال إن تغيّر cwd. بعد التفريع تُقص الرسائل اللاحقة من العرض حتى
  يطابق الفرع الجديد، ويغلق بحث الخيط ويصفّر ملخص التكلفة الذي كان يشمل أدوار الأصل المقصوصة. قفل مستقل
  لاستئناف الجلسات يمنع سباق قراءة جلسة قديمة مع fork/rewind، وإن عدّل المستخدم مسودته أثناء انتظار fork
  تُحفظ المسودة الأحدث ولا تُستبدل. بعد الاسترجاع تُمسح بطاقات session changes/checkpoint القديمة وتُعاد
  معاينة المشروع. ردود task ledger/checkpoint المتأخرة لا تُعرض إن تغيّر engine/session أثناء انتظار IPC،
  وفشل `localStorage` لا يحوّل نجاح الاسترجاع إلى رسالة فشل. رسائل السجل تحمل `messageId` فقط إن اجتاز UUID الحارس.
- **العلاقة مع checkpoint المشترك**: `electron/checkpoints.js` لم يتغير؛ يبقى طبقة سطر
  المشتركة لكل المحركات المبنية على `file_edit` ولقطات undo الحية. نقاط Claude الأصلية
  تحسين إضافي خاص بـsdk وعلى مستوى رسالة المستخدم، ولا تستبدل الطبقة المشتركة ولا تدمج
  سجلاتها معها. بعد نجاح native rewind يحجب main آخر checkpoint مشترك لتلك الجلسة عن العرض/restore/verify
  حتى يصل `file_edit` جديد. قبل استدعاء actual يكتب main الحاجز ذرياً عبر `electron/sdkrewinds.js`؛ فشل
  الكتابة يلغي actual، وبعد بدء actual تبقى العلامة حتى إن كانت النتيجة غير مؤكدة لأن تغييرات جزئية لا يمكن
  نفيها. العلامة الدائمة هي مصدر الحقيقة عبر إعادة فتح التطبيق، و`localStorage` دفاع إضافي فقط؛ لم يُحذف
  سجل checkpoint ولم يتغير عقد وحدته.
- **حدود upstream المثبتة**: CLI ‏2.1.214 لا يعيد بث رسالة الإدخال الأولى كحدث `user` في
  خرج `Query` (`queryEchoedUserMessage:false`)، لذلك يولّد سطر UUID في حدث promptStream
  الصادر ثم يبث إسقاط هوية منقّى بعد وصول session_id. نتيجة الاسترجاع الفعلي أعادت الملف
  لكنها لم تعد إحصاءات (`filesChanged:0` وغياب insertions/deletions)، لذا شاشة التأكيد تعتمد
  إحصاءات dry-run فقط. وعقد SDK ينص أن التفريع يعيد تعيين UUIDات الرسائل ولا ينسخ تاريخ
  file checkpointing؛ لذلك تُعطّل أزرار UUID القديمة عند الانتقال إلى الفرع حتى تصل هوية
  جديدة أو يعاد فتحه من `/جلسات`. كما أن Write لملف قائم في CLI الحالي يفرض Read قبله. لا يتيح عقد
  `rewindFiles` allowlist للمسارات؛ إن شملت نقطة Claude ملفات خارج cwd (ومنها احتمال تشغيل استخدم
  `extraDirs`) يرفض سطر الاسترجاع الأصلي كله بدلاً من تنفيذ أثر لا يظهر كاملاً في مربع التأكيد. كما لا تعيد
  dry-run معرّف snapshot أو hashes لمحتوى الملفات ولا تتيح allowlist ذرية للتنفيذ؛ لذلك يحسب سطر بنفسه
  hashes كاملة قبل العرض وقبل actual، ويرفض reparse points ويعيد فحصها قبل الاستدعاء. يبقى حد upstream:
  لا يستطيع سطر إلغاء TOCTOU ذري من عملية خارجية تغيّر نظام الملفات داخل استدعاء SDK نفسه.
- **التدهور والتحقق**: غياب الدالة أو CLI أقدم أو استجابة SDK مشوهة تعيد رسالة عربية ثابتة
  بلا خطأ خام؛ ولأن فشل SDK قد يقع بعد بدء التنفيذ، تطلب الرسالة مراجعة تغييرات الملفات ولا تدّعي
  أنها لم تتغير. `npm run test:fork-rewind` يغطي التنقية ورفض UUID المشوه وبوابة confirmed وإعادة
  dry-run في main وtoken أحادي الاستخدام وتغيّر المحتوى مع ثبات المسار/الحجم/mtime، وثبات digest عند انعكاس
  ترتيب الملفات، وسقوف البصمة، والمسارات الخارجية/symlink، وغياب `filesChanged`، وبقاء حاجز checkpoint عند
  actual غير مؤكد، وذرية sidecar مع فشل rename، وانتظار `run.done` وقفل send/control في الاتجاهين، وعدم
  تسريب أخطاء SDK والتوصيل. وهو داخل
  `test:full`. آخر تحقق للدفعة نجح `49/49`، ثم نجح `npm run eval:agent` مستقلاً `12/12`.
  المسبار الحي متعمد خارج `test:full` مثل مسابير SDK الأخرى.

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

### إدخال موصّلات Claude (دفعة C — 2026-07-26)

- **مصدر الحقيقة والمسبار أولاً**: استُخدم نوعا `OnElicitation` و`ElicitationRequest`
  المثبتان في `@anthropic-ai/claude-agent-sdk/sdk.d.ts` فقط، بلا واجهة alpha أو
  EXPERIMENTAL. شُغّل `scripts/elicitation-probe.js` حياً على Claude Agent SDK
  `0.3.176` وMCP SDK `1.29.0` وClaude Code `2.1.220` والنموذج `sonnet`. خادم stdio
  اصطناعي نفّذ form ثم URL: وصل إلى `onElicitation` **4 استدعاءات** (`1` form و`3`
  URL مكررة للطلب نفسه). حمل form حقلين، وحمل الطلبان المفاتيح التسعة
  `serverName/message/mode/url/elicitationId/requestedSchema/title/displayName/description`؛
  كانت الإشارة غير مجهضة، وأعاد المعالج `accept` للوضعين.
- **السلوك الافتراضي المثبت**: عند حذف `onElicitation` لم يقع أي callback (`0`)، وأعاد
  form ‏`action:'decline'`. طلب URL الافتراضي انتهى بنتيجة أداة `isError:false` طولها
  `139` محرفاً، تذكر الرفض ولا تذكر الرابط أو القبول. في السيناريو المعالَج أعاد URL
  بعد `accept` نتيجة أداة `isError:true` طولها `60` محرفاً بلا ذكر للرابط/القبول/الرفض؛
  فتح صفحة المصادقة لا يعني أن الخادم تلقّى إشارة اكتمال، وتبقى متابعة المصادقة من عقد
  الموصّل upstream.
- **حدود النقل المثبتة**: `createSdkMcpServer` داخل العملية لم يعلن قدرة form للعميل،
  فأعاد حرفياً `Client does not support form elicitation.` قبل بلوغ callback. واستدعاء
  `server.elicitInput({mode:'url'})` المباشر عبر stdio أعاد النظير الخاص بـURL. لذلك يثبت
  المسبار form عبر stdio، ويثبت URL بالخطأ القياسي `UrlElicitationRequiredError` ذي الرمز
  `-32042`. كما أعاد CLI callback طلب URL نفسه ثلاث مرات؛ يحتفظ الإنتاج بحالة واحدة حسب
  هوية `serverName` الخام داخلياً مع `elicitationId`، ويبث حواراً واحداً ويشارك قراره
  بين الاستدعاءات. اختلاف URL مع المفتاح نفسه يُرفض، وAbort لنسخة مكررة يحسم تلك النسخة
  فقط ولا يحوّل قرار الطلب المشترك إلى قبول أو رفض.
- **النطاق والتدهور**: `agent.js` يمرر `options.onElicitation` للتشغيل العادي فقط؛ أي
  `internalPolicy` (السياقات المعزولة وعوامل غرفة العمليات) لا يحمل الخيار، فيبقى رفض SDK
  الافتراضي fail-closed. الإلغاء وإشارة abort والإيقاف والتنظيف بعد نهاية الدور تحسم كل
  انتظار بـ`decline`. إن أعاد CLI أقدم خطأ عدم دعم form/URL المعروف، يضيف التشغيل العادي
  إشعاراً عربياً ثابتاً مرة واحدة يطلب التحديث أو `/mcp`، ولا يكسر الدور أو يعيد نص خطأ
  upstream داخل ذلك الإشعار.
- **التنقية وحارس الأسرار**: `electron/elicitation.js` يقبل form نصياً فقط، من `1` إلى
  `20` حقلاً، ويزيل محارف التحكم C0/C1 وBidi ويقص `server≤160` واسم الحقل `≤160`
  ووسمه `≤400` بنقاط Unicode. أي اسم/عنوان/وصف للحقل أو سياق form العلوي يطابق
  `memory.hasSecret` أو أنماط `password/passwd/pwd/passphrase/token/key/secret/credential`
  (camelCase/acronym والأسماء الشائعة المدمجة مشمولة) يرفض الطلب كاملاً برسالة عربية
  ثابتة توجه إلى `/mcp` في Claude Code أو `browser_handoff`. تُعاد القيم بعد التنقية إلى
  مفاتيح schema الأصلية داخلياً فقط؛ أي قيمة يلتقطها `memory.hasSecret` تحسم الرفض، ولا
  تُبث أو تُسجّل أو تعاد في IPC.
- **عقد IPC والـURL**: `satr:elicitationDone`
  `{id,action:'accept'|'decline',content?}` يقبل كائناً بقائمة سماح فقط؛ `id` بالنمط الصارم
  أعلاه، وform يقبل كائن نصوص `≤20` حقلاً و`≤2000` محرف Unicode لكل قيمة. decline وURL
  يمنعان `content`. الواجهة لا ترسل URL إطلاقاً؛ `main.js` يقرأ URL المعلّق من مقبض الدور،
  يعيد التحقق منه (HTTPS، أو HTTP loopback فقط، وبلا username/password)، ولا يستدعي
  `shell.openExternal` إلا بعد زر «افتح في متصفح النظام». URL متجاوز `2048` نقطة
  Unicode يُرفض قبل التحليل ولا يُقص دلالياً، وقفل ID يمنع فتحين متزامنين. فشل الفتح
  يبقي الطلب معلقاً للمحاولة أو الإلغاء، ولا يعود الرابط أو المحتوى في الاستجابة.
- **الواجهة والتحقق**: `<satr-elicitation-dialog>` يحاكي طابور حوار الأسئلة داخل Shadow
  DOM وبـ`adoptedStyleSheets` فقط. يعرض العربية وقيم server/field/URL ‏LTR، والرابط نص
  غير قابل للنقر ولا يفتح تلقائياً. يحافظ renderer على اسم الحقل المنقّى نفسه بلا قص
  UTF-16 ثانٍ، ويمحو قيم inputs فور أي حسم ناجح. الإلغاء وEscape يرسلان decline،
  ونهاية الدور تغلق العرض بعد أن يكون المحرك قد حسم الانتظار. `npm run test:elicitation` يغطي schema الحدث، التنقية
  fail-closed، رفض حقول/قيم الأسرار، سقوف IPC، الفتح الصريح، حذف URL من المراقبين، دمج
  callbacks المتكررة، abort/stop، عزل كل `internalPolicy`، ورسالة CLI الأقدم؛ وهو مسجل
  داخل `test:full`. آخر تشغيل مستقل له نجح، ونجح `npm run eval:agent` بـ`12/12`؛ لم تُشغّل
  الحزمة الكاملة محلياً التزاماً بتنسيق الجولة، ويبقى المسبار الحي خارجها عمداً.

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
- **التحقق القطعي**: `npm run test:sdk-polish` يغطي الخيارات الخمسة، تنقية lifecycle
  وقائمة سماح main، عدم تسريب حقول SDK، بوابة الاقتراح مع مهام دفعة D والخيار القديم،
  تنظيف snapshot، موضع التصنيف، إضافة بطاقة الضغط دون تغيير أرقام Codex، سلوك الشريحة
  بلا إرسال، وعقد الإيقاف؛ وهو مسجل داخل `test:full` ولا يشغّل شبكة. حارس
  `test:sdk-background` الذي كان يثبت الاسم المحلي `rawTaskNotification` حُدث بوعي إلى
  `rawPrivateLifecycle` ليثبت حجب كل من `task_notification/task_progress` الخامَين.
### استمرارية الجلسة

كل رسالة جديدة تمرّر `--resume <session_id>` المأخوذ من حدث `result` السابق.
«جلسة جديدة» = تصفير sessionId.

### طبقة المحوّلات والمزوّدين (Adapters/Providers — المرحلة 5)

إثبات رؤية «البيت العربي لكل أدوات CLI/النماذج» بمحرّكات ثانية بجانب Claude، **بصفر تغيير
في الواجهة**: كل محوّل يطبّع خرجه إلى أنواع أحداث «سطر» نفسها (`system/stream_text/assistant/
result`)، فالواجهة لا تتغيّر.

- **العقد الموحّد**: `start(input, cwd, emit) → { stop() }`. `input` **مُنقّى في main.js**
  (القاعدة 2): `{prompt, sessionId, model, permissionMode, extraDirs}`. `emit(obj)` يبثّ حدثاً
  (مقيّد بـ `runSeq`). `stop()` يعيد Promise. المقبض يُخزَّن في `currentCliRun` (بجانب
  `currentRun` لمحرك SDK الذي يحمل `resolvePermission`).
- **السجلّ** (`adapters/index.js`): `register(name, adapter, meta)` / `get(engine)` /
  `list()` (يعيد `{name, label, family, keyName}`). **قابل للحقن** فتضيف طبقة Enterprise
  مزوّدين دون لمس النواة (نقطة الربط §4.2 في ARCHITECTURE.md). المدمج: cli, gemini,
  openai, deepseek, qwen, kimi, minimax, ollama, nvidia وgroq. **التسميات بمبدأ
  «العلامة + طريقة الدخول»** (اشتراك/مفتاح API/محلي — جولة 2026-09-02)، والمعرّفات لا
  تُمسّ أبداً (تُخزَّن في localStorage و`~/.satr/chats/` و`~/.satr/tasks/`).
  `nvidia` (‏NVIDIA NIM — ‏`integrate.api.nvidia.com`، المفتاح `NVIDIA_API_KEY`)
  و`groq` (‏`api.groq.com/openai/v1`، المفتاح `GROQ_API_KEY`) منصتان بطبقة مجانية
  دائمة بلا بطاقة ائتمان وتدعمان tool calling؛ البروتوكول عقد المصنع المتحقَّق، ومعرّفات
  نماذجهما يثبتها حيّاً `scripts/free-providers-probe.js` فور توفر مفتاح (يتخطى بصمت
  مزوّداً بلا مفتاح). خيار `kimi` هو **Kimi API (REST)**
  مباشرةً (`api.kimi.com/coding/v1`، النموذج `k3`، المفتاح `KIMI_API_KEY`) ولا يلتف
  عبر Claude Code. وهو مستقل عن محرك الاشتراك الأصلي `kimi-code` الموثّق أدناه.
- **`adapters/claude-cli.js`**: مسار `claude -p` المنقول من main.js (نفس detached+taskkill).
- **`adapters/gemini.js`**: Gemini عبر **REST مباشر** (`https` مدمجة، بثّ SSE من
  `streamGenerateContent`) لا gemini-cli. **قرار مثبّت**: gemini-cli أُسقط لأنه غير موثوق
  للوضع غير التفاعلي (طبقة OAuth المجانية أُلغيت من Google، ثقة المجلد تُعلّق، «auto» بطيء) —
  REST بنموذج `gemini-2.5-flash` سريع وثابت. المفتاح في ترويسة HTTP، ذاكرة محادثة في خريطة
  لكل session_id (يُمرَّر كامل السجل كل دور).
- **`adapters/openai-compatible.js`**: **مصنع** `make(config)` لأي endpoint متوافق مع OpenAI
  Chat Completions (بثّ `choices[].delta.content` + `[DONE]`). DeepSeek/Qwen/GLM/Kimi كلها
  بنفس البروتوكول ⇒ إضافة مزوّد = سطر `register()` واحد. يدعم اختيارياً `effortMap`
  لإرسال `reasoning_effort` و`reasoningKey` لجمع حقل التفكير وإعادته في تاريخ رسائل
  الأدوات فقط للمزوّد الذي يعلن العقد. يحتاج K3 ذلك لأن الجولة التالية تُرفض إن غاب
  `reasoning_content` عن رسالة assistant التي تحمل `tool_calls`. لا يُعرض التفكير في
  الواجهة. يدعم أيضاً `promptCacheKey` الاختياري؛ Kimi يرسله بقيمة session_id ثابتة عبر
  كل جولات الدور والاستئناف لتحسين كاش Kimi Code. متحقَّق بخادم SSE محلي وجولتي طلب/أداة.
- **حلقة الوكيل (الدفعات 2.1–2.4 — عائلتا openai وgemini)**: الطلب يعلن أدوات «سطر»
  (`electron/tools.js`)؛ النموذج يطلب أداة ⇒ المحوّل ينفّذها محلياً ويعيد النتيجة برسالة
  `role:"tool"` ويعاود الطلب (سقف 8 جولات/دور). البثّ للواجهة بنفس عقد أحداث SDK
  (`tool_use`/`tool_result` في رسائل assistant/user) ⇒ بطاقات الأدوات تظهر بصفر تغيير
  واجهة. نموذج يرفض الأدوات (4xx أول طلب، مثل بعض نسخ R1) ⇒ يُعاد الطلب مرة واحدة
  دونها (تدهور رشيق لدردشة عادية). رسائل الأدوات تُحفظ في الذاكرة (1.3) بصيغتها،
  والقصّ يسقط رسائل tool اليتيمة من المقدمة (المزوّد يرفضها بلا نداء يسبقها).
- **أدوات الكتابة بالأذونات العربية (الدفعة 2.2)**: write_file/edit_file تمرّ بمربع
  الإذن العربي **قبل** التنفيذ — المحوّل يبثّ `permission_request` (نفس عقد SDK؛ نسخة
  العرض تقصّ الحقول الطويلة) وينتظر `resolvePermission` على مقبض التشغيل (main.js يوجّه
  `satr:permission` للمقبض الجاري أياً كان محركه). «موافقة دائمة» لعمر التطبيق (Set
  مشترك لعائلة openai)، وأوضاع acceptEdits/bypassPermissions تعفي من السؤال، والرفض
  يعود للنموذج نصاً (لا يكرر المحاولة). التنفيذ يُصدر `file_edit` فتظهر بطاقة diff
  و«تراجع» يعمل عبر لقطات tools.js (satr:undoEdit يجرّب agent ثم tools). إيقاف الدور
  يفكّ أي إذن معلّق بالرفض.
- **تعميم الحلقة لـ Gemini (الدفعة 2.4)**: gemini.js يملك الحلقة نفسها بصيغته
  (functionDeclarations/functionCall/functionResponse — أداة بلا وسائط تُحذف parameters
  كلياً لأنه يرفض OBJECT فارغ الخصائص، والمعرّفات تُولَّد محلياً `gm_…` لأنه لا يصدرها)
  وبنفس طبقات الإذن وعقد الأحداث. إضافة مزوّد جديد لأي من العائلتين = يرث الوكيل كاملاً.
- **Kimi K3 عبر REST (2026-07-20)**: نموذج واحد بمعرّف API ‏`k3`، وصور Base64 بعد تنقية
  `main.js`، وجهد `low→low` و`medium|high→high` و`xhigh|max→max`؛ غياب الاختيار يترك
  افتراضي الخدمة. نافذة السياق 256K أو 1M حسب خطة Kimi ولا يغيّرها سطر أو يتحايل عليها.
  يجب أن يكون المفتاح من Kimi Code Console؛ مفاتيح Kimi Open Platform غير متبادلة معه.
  تعرض الواجهة خيار `k3` واحداً، ويحوّل المحوّل رفض `401/403` إلى إرشاد عربي ولا يعيد
  طلب المصادقة كأنه رفضٌ لعقد الأدوات.
- **حدود موثّقة**: Kimi REST وOpenAI Responses يعلنان الصور؛ بقية المحوّلات النصية
  تتجاهلها. كل محوّلات REST ترث أدوات الملفات/البحث/التنفيذ بإذن سطر، لكنها لا تملك
  أدوات المتصفح. الاستمرار في REST يبقى سجل رسائل محلياً؛ الإيقاف قبل نهاية الدور لا
  يستطيع حفظ جزء لم يؤكده API، لذلك المسار الموصى به للاشتراك والاستمرار هو `kimi-code`.
- **الذاكرة (الدفعة 1.3)**: سجلّ المحادثة كاش حيّ (Map) فوق **قرص** (`electron/chats.js` —
  `~/.satr/chats/<provider>/<session>.json`) فتُستأنف المحادثة بعد إعادة تشغيل «سطر».
  مؤشر «آخر جلسة» على **القرص أيضاً** (`<provider>/last.txt` يكتبه `chats.save`) — **ليس
  localStorage** (درس مثبّت من اختبار القبول: كتابة localStorage قد لا تصل القرص فيضيع
  المؤشر). الواجهة تستعيده عند الإقلاع وعند التبديل للمحرك عبر IPC `satr:lastChat {engine}`
  → `{sid}`، و«جلسة جديدة» تنساه عبر `satr:forgetChat` (`chats.forget` يحذف last.txt
  والسجلّ يبقى للتنظيف بالأقدم). preload يكشفهما `lastChat/forgetChat`. sdk↔cli يتشاركان
  جلسات كلود كما كانا (لا مساس). المصنع openai-compatible يأخذ `id` في config هو اسم
  مجلد الذاكرة؛ بدونه تبقى الذاكرة حيّة فقط.

### التوجيه أثناء الدور لمحرك Codex (turn/steer — الدفعة C1، 2026-07-26)

- **المسبار أولاً**: `scripts/codex-steer-probe.js` على codex-cli ‏0.144.3 (نموذج
  `gpt-5.6-sol`). طبقتان: **سلك خام** (المسبار يشغّل `codex app-server` بنفسه ويتكلم
  JSON-RPC مباشرةً، فالنتيجة توثّق عقد upstream مستقلاً عن تنفيذ «سطر») ثم **تكامل** عبر
  مقبض `codex.start()`. مصدر العقد هو الـschema المولّد من الثنائي المثبّت
  (`codex app-server generate-json-schema --out <dir> --experimental`، ملفات `v2/` حصراً):
  `TurnSteerParams` يوجب `{threadId, expectedTurnId, input:[UserInput]}` و`TurnSteerResponse`
  يعيد `{turnId}`. لم يُبنَ شيء على `thread/rollback` (موسوم DEPRECATED في الـschema).
- **نتائج المسبار الفعلية**: التوجيه أثناء دور جارٍ نجح ووصل إلى النموذج في الدور نفسه
  (ظهرت العلامة في الإجابة النهائية، طولها `3283` محرفاً بعد `1012` إشعاراً، وحالة
  `turn/completed` = `completed`). **التوجيه لا ينشئ دوراً جديداً**: `turn/steer` أعاد
  معرّف الدور نفسه (`steer_turn_id_equals_start:true`) وكذلك `turn/completed`، لذلك
  مرشّح `belongsToRootTurn` وعزل أحداث الوكلاء الفرعيين يبقيان صحيحين **بلا أي تعديل**.
- **حدّ upstream مثبّت (أمني)**: `expectedTurnId` شرط مسبق إلزامي لا تحسين — عدم المطابقة
  يردّ `-32600` برسالة `expected active turn id \`X\` but found \`Y\``، **وهي تحمل معرّف
  الدور النشط الفعلي**. لذلك لا تُمرَّر رسالة upstream الخام إلى renderer إطلاقاً؛ يعيد
  المحرك رموزاً ثابتة (`rejected`) فقط. وبعد `turn/completed` يردّ `-32600`
  ‏`no active turn to steer`.
- **المحرك**: `electron/codex.js` يضيف `steer(text)` إلى مقبض التشغيل (بجانب
  `resolvePermission`/`resolveQuestion`/`resolveHandoff`/`stop`). يرفض محلياً قبل السلك إن
  كان النص فارغاً أو لا دور نشطاً (`finished || stopping || !threadId || !turnId`)، ويرسل
  `expectedTurnId: turnId` النشط. ويصدّر `sanitizeSteerText` النقية و`MAX_STEER_CHARS`.
- **IPC**: `satr:steer {text}` — التنقية تُفرض في `main.js` عبر `codex.sanitizeSteerText`
  (نمط `nonSdkPerm` من autogate.js: منطق نقي مختبَر وحده، ونقطة الفرض في العملية
  الرئيسية): نص فقط، تطبيع CRLF، إزالة محارف التحكم ومحارف Bidi
  (`U+061C/200E/200F/202A-202E/2066-2069`)، وسقف `32000` محرف. ثم بوابتان: `lastEngine`
  يجب أن يكون `codex` (غيره ⇒ `unsupported`) ووجود `currentRun.steer` (وإلا
  `no_active_turn`). `preload.js` يكشف `steer(text)` المحددة فقط. **لا نوع حدث جديد في
  `satr:event`** ولا تغيير في أي عقد قائم.
- **الواجهة**: أثناء دور Codex الجاري لا يُقفل المؤلّف. كتابة نص تحوّل زرّ الإرسال إلى
  «↪ وجّه» ويستدعي `satr:steer`؛ الحقل الفارغ يبقيه «إيقاف» فلا يضيع فعل الإيقاف ولا
  يلزم زرّ ثالث. المرجع هو `runningEngine` (المحرك الجاري فعلاً) لا منتقي الواجهة، فتبديل
  المنتقي أثناء دور جارٍ لا يضلّل الزر. الرسالة المُوجَّهة تظهر كفقاعة مستخدم موسومة
  «↪ توجيه أثناء الدور» (`meta.steer` في `chat.addUserMsg`) وبلا أزرار تحرير/تفريع/
  استرجاع/غرفة عمليات لأنها ليست حدّ دور. بقية المحركات بلا تغيير سلوكي.
- **لماذا Codex وحده**: Kimi ACP يرفض دوراً ثانياً أثناء دور جارٍ (‏`-32600` — موثّق في
  قسم Kimi)، ومحرك SDK لا يملك عقد steer. لذلك `unsupported` صريحة لا محاكاة.
- **إعادة تحقّق (2026-08-27، ‏codex-cli ‏`0.149.1`)**: عقد السلك **صامد حرفياً** —
  `steer_turn_id_equals_start:true`، وعدم المطابقة يردّ `-32600` **ومعه معرّف الدور
  النشط** (فيبقى حجب نص upstream لازماً لا احتياطاً)، وبعد الاكتمال `no active turn to
  steer`. العلامة بلغت الإجابة النهائية (`3269` محرفاً بعد `996` إشعاراً).
- **التحقق**: `npm run test:codex-steer` (قطعي، بلا شبكة — fixture عبر `CODEX_BIN=node`
  بنمط `codex-contract-test.js`) يغطي التنقية النقية (النوع، الفراغ، السقف، CRLF،
  محارف التحكم، اثني عشر محرف Bidi)، وعقد السلك (`threadId`/`expectedTurnId` النشط/شكل
  `UserInput` وعدم تسرّب حقول زائدة)، ورفض الفارغ بلا حركة على السلك، ورفض ما بعد نهاية
  الدور، وتطبيع خطأ upstream إلى `rejected` مع **فحص صريح لعدم تسرّب معرّف الدور أو نص
  الخطأ**، وثبات مجموعة أنواع `satr:event`. وهو داخل `test:full`. المسبار الحيّ
  `npm run test:codex-steer-probe` يبقى خارج `test:full` عمداً مثل بقية مسابير Codex
  (يستهلك دورين حقيقيين؛ `--raw-only` يشغّل عقد السلك وحده).

### تكافؤ /ضغط و/سياق لمحرك Codex (الدفعة C2، 2026-07-26)

- **المسبار أولاً**: `scripts/codex-compact-probe.js` (سلك خام — يشغّل `codex app-server`
  بنفسه) على codex-cli ‏0.144.3 والنموذج `gpt-5.6-sol`. شُغّل جولتين متطابقتين بنيوياً؛
  أرقام الجولة الثانية: `thread/compact/start` أعاد **كائناً فارغاً `{}`**، واكتمل خلال
  `7018ms` (الجولة الأولى `7736ms`) بـ`8` إشعارات، وإجمالي `353` إشعاراً للمسبار كله.
- **إشارة الاكتمال (حدّ upstream مثبّت)**: إشعار `thread/compacted` **لم يصل قط** — وهو
  موسوم `Deprecated` في الـschema (`ContextCompactedNotification`). الواصل فعلاً هو
  `item/completed` بعنصر `type:'contextCompaction'`، **وحمولته `{id, type}` فقط**.
  لذلك **لا تتوفّر أرقام رموز قبل/بعد للضغط في Codex**، ولا يخترعها «سطر»: يبثّ
  `system/compact_boundary` بـ`compact_metadata:{trigger:'manual'}` بلا `pre_tokens`/
  `post_tokens`، والبطاقة القائمة في `chat.js` تعرض الأرقام فقط إن كان `pre_tokens`
  رقماً ⇒ تظهر «🗜 ضُغطت المحادثة» صادقة بلا أي تغيير في المكوّن.
- **الضغط يجري كدور حقيقي**: الإشعارات داخل نافذته كانت `turn/started` و`item/started`
  و`item/completed` و`thread/tokenUsage/updated` و`account/rateLimits/updated` و
  `thread/status/changed` و`turn/completed`. لذلك `finishTurn` القائم يغلق التشغيل
  طبيعياً ويبقى `session_id` هو `threadId` نفسه.
- **الاستمرارية مثبّتة**: بعد الضغط بقي الخيط قابلاً للإكمال (`turn_status_after_compact`
  = `completed`) واسترجع النموذج رمزاً زُرع قبل الضغط (`memo_recalled:true`, `14` محرفاً).
- **حدّ upstream ثانٍ**: `thread/compact/start` أثناء دور جارٍ **قُبِل بلا خطأ**
  (`during_active_turn.accepted:true`). «سطر» لا يستغل ذلك: `compactConversation()` في
  `app.js` يحجب الأمر أثناء `busy` كما كان لبقية المحركات.
- **حدّ upstream ثالث (نافذة السياق)**: `model/list` **لا يعلن نافذة سياق إطلاقاً** —
  تحقق حيّ: `7` نماذج وصفر حقل `contextWindow`/`maxTokens` (والـschema يؤكد: تعريف
  `Model` بلا أي حقل كهذا). المصدر الوحيد هو `modelContextWindow` داخل إشعار
  `thread/tokenUsage/updated` الحيّ (القيمة المرصودة `258400`).
- **`last` لا `total`**: `ThreadTokenUsage` يحمل الاثنين؛ `total` **تراكمي عبر الخيط**
  فيكبر أبداً ولا يعكس الإشغال (رُصد `14337` ثم `31474`)، بينما `last` يصف آخر طلب
  (`17137`). لذلك لوحة `/سياق` تُبنى من `last`. ملاحظة مرصودة: لقطة الضغط نفسها أعادت
  `last.totalTokens=5656` بـ`inputTokens=0` و`outputTokens=0` — يسجّلها «سطر» كما أعلنها
  upstream بلا تأويل. ولم يتقلّص إدخال الدور التالي في هذا القياس
  (`last_input_shrank_after_compact:false`) لأن الخيط كان صغيراً (~14k من 258k).
- **المحرك**: `electron/codex.js` يعترض `prompt.trim() === '/compact'` في تسلسل الإقلاع
  ويستدعي `thread/compact/start {threadId}` بدل `turn/start` (نمط `kimi.js`: الأمر المائل
  يُعالَج داخل المحرك) — بلا مهارات ولا ذاكرة ولا صور ولا مدخل نصّي. ويحتفظ بخريطة
  `contextSnapshots` (آخر لقطة لكل خيط، سقف `100`) في ذاكرة العملية — **لا مخزن قرص
  جديد ولا اعتمادية**. ويصدّر `contextUsage(cwd, sessionId)` و`COMPACT_COMMAND`.
- **التدهور الرشيق**: فشل `thread/compact/start` (إصدار لا يعلن الطريقة) يعطي رسالة
  عربية ثابتة «إصدار Codex المثبّت لا يدعم ضغط المحادثة من سطر» بلا نص خطأ upstream
  خام، ثم يُغلق الدور بنتيجة عادية. واكتمال الدور **بلا** عنصر `contextCompaction` لا
  يُظهر بطاقة ضغط بل تحذيراً «لم يؤكّد Codex اكتمال ضغط المحادثة».
- **IPC**: **لا قناة جديدة** — `satr:contextUsage` القائم أُضيف له فرع `engine === 'codex'`
  يوجّه إلى `codex.contextUsage`. غياب اللقطة (إقلاع جديد أو جلسة بلا دور بعد) يعيد
  `{ok:false}` برسالة عربية هادئة. الفئات المعروضة: الإدخال والإخراج، ومعهما «منها
  مخبّأ» و«منه تفكير» بأسماء تُظهر أنهما مجموعتان فرعيتان فلا يُقرأ الشريط جمعاً مضاعفاً.
- **الواجهة**: `/سياق` و`/ضغط` أُضيف لهما `'codex'` في `engines`، و`compactConversation()`
  يقبل codex. **لا نوع حدث جديد في `satr:event`** ولا تغيير في أي مكوّن.
- **إعادة تحقّق (2026-08-27، ‏`0.149.1`)**: **صامد** — `thread/compact/start` يعيد `{}`،
  والإشارة تبقى `item/completed:contextCompaction` بحمولة `{id,type}` فقط (فلا أرقام
  رموز)، و`modelContextWindow` ما زال `258400`، والضغط أثناء دور جارٍ ما زال مقبولاً،
  واسترجاع الرمز المزروع نجح.
- **التحقق**: `npm run test:codex-compact` (قطعي، بلا شبكة — fixture عبر `CODEX_BIN=node`)
  يغطي: استدعاء `thread/compact/start` مرة واحدة بحقل `threadId` وحده و**بلا** `turn/start`،
  وتحويل `contextCompaction` إلى `compact_boundary` مع بقاء `session_id` وغياب
  `pre_tokens`/`post_tokens`، والتدهور الرشيق مع **فحص صريح لعدم تسرّب نص خطأ upstream**،
  والاكتمال الصامت بلا بطاقة كاذبة، وتطبيع `/سياق` من `last` لا `total`، ورسالة الغياب،
  وعزل اللقطات بين الخيوط، وثبات مجموعة أنواع `satr:event`. وهو داخل `test:full`.
  المسبار الحيّ `npm run test:codex-compact-probe` خارجها عمداً (يستهلك ثلاثة أدوار).

### لوحة موصّلات Codex ‏(/موصلات + OAuth — الدفعة C3، 2026-07-27)

- **المسبار أولاً**: `scripts/codex-mcp-panel-probe.js` (سلك خام) على codex-cli ‏0.144.3.
  الطرق كلها من الـschema المولّد (v2/): `mcpServerStatus/list` و`config/mcpServer/reload`
  و`mcpServer/oauth/login`، وإشعارا `mcpServer/startupStatus/updated` و
  `mcpServer/oauthLogin/completed`. أرقام التشغيل الفعلي: `5` خوادم، زمن السرد `4835ms`،
  وإجمالي `10` إشعارات إقلاع.
- **حدّ upstream 1 — لا حقل حالة في السرد**: مفاتيح `McpServerStatus` المرصودة هي
  `authStatus,name,resourceTemplates,resources,serverInfo,tools` و`has_status_field:false`.
  فحالة الاتصال **لا تأتي من السرد إطلاقاً**، بل من إشعارات
  `mcpServer/startupStatus/updated` وحدها (`McpServerStartupState`:
  `starting|ready|failed|cancelled`، و`McpServerStartupFailureReason`:
  `reauthenticationRequired`).
- **حدّ upstream 2 — الإشعارات لا تصل قبل بدء خيط**: صفر إشعار خلال `20` ثانية بعد
  `initialize`، ثم **10 إشعارات فوراً** بعد `thread/start` (خمسة `starting`، ثم
  `chrome-devtools/supabase/context7` → `failed` بنص خطأ، و`codex_apps/openaiDeveloperDocs`
  → `ready`). لذلك `codex.mcpStatus` يبدأ خيطاً عابراً **للقراءة فقط**
  (`sandbox:'read-only'`) وينتظر `9000ms` ثم يسرد ويغلق العملية.
- **حدّ upstream 3 — `tools` يعود null دائماً**: جُرّب `detail` الافتراضي و`full` و
  `toolsAndAuthOnly` وبعد بدء خيط ⇒ `tools_ever_array:false`. لذلك لا تعرض اللوحة عدد
  أدوات لـCodex (بخلاف مسار sdk)؛ `resources` يعمل (رُصد `26` لـ`codex_apps`، ويصير `0`
  تحت `toolsAndAuthOnly`).
- **اشتقاق الحالة**: `ready→connected` · `starting→pending` · `failed→failed` ·
  `cancelled→failed` · `failed` مع `reauthenticationRequired`‏→`needs-auth` ·
  و`authStatus==='notLoggedIn'` يفرض `needs-auth` دائماً. غياب أي إشعار ⇒ `pending`.
- **الإجراءات**: `config/mcpServer/reload` (params **null** إلزاماً في الـschema) هو
  الفعل الوحيد المعلن — نجح في `13ms` بردّ `{}`. التفعيل/التعطيل **غير مدعومين لـCodex
  عمداً** لأنهما يستلزمان الكتابة في `~/.codex/config.toml` و«سطر» لا يلمسه؛ يردّ
  `satr:mcpAction` بـ`unsupported` ولا تعرض اللوحة زرّاً يوهم بقدرة غير موجودة.
- **OAuth بلا تسريب رابط**: `mcpServer/oauth/login {name}` يعيد `authorizationUrl`.
  **الرابط لا يعبر IPC ولا يُبثّ إطلاقاً**: يبقى في `pendingMcpOauth` داخل `codex.js`
  (سقف عمر `5` دقائق)، و`satr:mcpOauthStart` يعيد `{ok,id,name}` فقط. الواجهة تعرض
  `confirm` عربياً صريحاً، ثم `satr:mcpOauthOpen {id}` يقرأ الرابط عبر `codex.mcpOauthUrl`
  (منقّى بـ`safeOauthUrl`: HTTPS أو HTTP loopback فقط، بلا `username/password`، بلا فراغ
  أو محارف تحكم/Bidi، وسقف `2048`) ثم `shell.openExternal` وينتظر
  `mcpServer/oauthLogin/completed`. رابط upstream غير آمن يُسقَط إلى `null` fail-closed.
  فشل الفتح يبقي الطلب معلّقاً لإعادة المحاولة، و`satr:mcpOauthCancel` يُسقطه.
  **لا يُخزَّن أي token في «سطر»** — المصادقة كلها داخل Codex.
- **حجب الأسرار**: نص خطأ الخادم يمرّ بـ`sanitizeMcpError` (إزالة محارف التحكم/Bidi،
  سقف `300` محرف، وحجب كامل إن طابق `memory.hasSecret` المشترك). و`serverInfo` مقصور
  على `version` فلا يعبر `websiteUrl` أو غيره. خادم `satr_preview` الداخلي **مستثنى من
  العرض** (تفصيل تنفيذي لا موصّل مستخدم).
- **حدّ لم يُتحقَّق منه حيّاً**: لا يوجد على جهاز التطوير خادم يعلن `notLoggedIn` أو
  `oAuth` (‏`distinct_auth_status` المرصودة: `bearerToken` و`unsupported`)، فدورة OAuth
  الحيّة **لم تُنفَّذ فعلياً**؛ غطّاها الاختبار القطعي بـfixture يحاكي العقد المعلن.
- **IPC والواجهة**: `satr:mcpStatus` صار يقبل `{cwd, engine}` (النص المجرّد يبقى مقبولاً)،
  و`satr:mcpAction` أضيف له `engine`. الجديد: `satr:mcpOauthStart/Open/Cancel` بمعرّف
  بنمط `^cxoauth_[0-9]{1,9}_[a-z0-9]{1,8}$`. `/موصلات` صار `engines:['sdk','codex']`،
  و`mcpEl.open(cwd, engine)`. **لا نوع حدث جديد في `satr:event`** ومسار sdk بلا تغيير.
- **التحقق**: `npm run test:codex-mcp-panel` (قطعي، بلا شبكة) يغطي اشتقاق الحالات الأربع،
  استثناء `satr_preview`، إلزام الخيط العابر `read-only`، `reload` بـ`params:null` وفشله
  بلا تسريب، حجب الأسرار ونص upstream الخام، قائمة حقول الصف المغلقة، تحقق الرابط
  fail-closed (‏12 حالة)، ودورة OAuth كاملة (نجاح/رفض/إلغاء/رابط غير آمن/بلا رابط) مع
  **فحص صريح لعدم تسرّب الرابط من قناة البدء**، وثبات مسار sdk في `main.js`. زمنه `12.4s`
  وهو داخل `test:full`. المسبار الحيّ `npm run test:codex-mcp-panel-probe` خارجها عمداً.

### حساب Codex واستهلاكه ‏(⚙ + تسجيل دخول — الدفعة C4، 2026-07-27)

- **المسبار أولاً**: `scripts/codex-account-probe.js` (سلك خام) على codex-cli ‏0.144.3.
  الطرق من الـschema المولّد (v2/) حصراً: `account/read` و`account/usage/read`
  و`account/rateLimits/read` (كلاهما `params:null`) و`account/login/start` و
  `account/login/cancel`، وإشعار `account/login/completed`. المسبار **لا يكمل OAuth ولا
  يفتح متصفحاً ولا يطبع الرابط أو البريد** — البنية والأطوال فقط، ويتحقق في نهايته أن
  الاعتماد القائم لم يتأثر.
- **أرقام التشغيل الفعلي**: `account/read` في `4ms` أعاد
  `{requiresOpenaiAuth:true, account:{email,planType,type}}` بنوع `chatgpt`.
  `account/usage/read` في `903ms` أعاد `summary` بخمسة حقول
  (`currentStreakDays,lifetimeTokens,longestRunningTurnSec,longestStreakDays,peakDailyTokens`)
  و`42` حاوية يومية بمفتاحي `startDate,tokens`. `account/rateLimits/read` في `692ms`
  أعاد `planType:'prolite'` و`primary:{resetsAt,usedPercent,windowDurationMins}` و
  `secondary:null` و`rateLimitResetCredits.availableCount`.
- **حدّ upstream 1 — البدء فوق اعتماد قائم يُقبل**: `account/login/start {type:'chatgpt'}`
  **لم يُرفض** رغم أن الجهاز مسجَّل الدخول (`accepted_while_logged_in:true` في `1ms`)،
  وأعاد `{type,authUrl,loginId}` — الرابط `https` على مضيف OpenAI بطول `481` محرفاً،
  و`loginId` بطول `36`. لذلك تعرض الواجهة زرّ «سجّل دخول Codex» **فقط** عند
  `installed && !auth.ok` ولا تتيح بدء دورة تفسد اعتماداً صالحاً.
- **حدّ upstream 2 — الإلغاء يولّد إشعار اكتمال «فاشل»**: بعد `account/login/cancel`
  (‏`status:'canceled'` في `1ms`) وصل `account/login/completed` بـ`success:false` ومعه نص
  خطأ. لذلك «سطر» لا يعرض فشلاً حين يكون الإلغاء بطلب المستخدم؛ ولا يمرّر نص الخطأ.
- **حدّ upstream 3 — إلغاء معرّف مجهول يردّ خطأ لا حالة**: الـschema يعلن
  `CancelLoginAccountStatus: canceled|notFound`، لكن الاستدعاء بمعرّف غير موجود ردّ
  خطأ JSON-RPC ‏`-32600` بدل `status:'notFound'`. لا نعوّل على القيمة المعلنة.
- **حدّ upstream 4 — `credits.balance` نص لا رقم** (رُصد `"0"`)، و`limitName` و
  `rateLimitReachedType` قد تكونان `null`. التطبيع يمرّرها منقّاة بلا تأويل عددي.
- **المحرك**: `electron/codex.js` يضيف `accountUsage()` و`accountRateLimits()` فوق
  `rateLimits()` القائمة، و`normalizeRateLimits()` النقية (قصّ `usedPercent` إلى
  `0..100`، وإسقاط نافذة بلا `usedPercent`، وقائمة حقول مغلقة). ودورة الدخول
  `accountLoginStart/Url/Await/Cancel` **بنمط C3 حرفياً**. الثلاث الأُوَل تقبل `cwd`
  اختيارياً (الافتراضي المنزل) للاختبار القطعي فقط — **main.js لا يمرّره**، فلا يصل مسار
  من renderer إلى `spawn`.
- **أمان تسجيل الدخول**: الرابط لا يعبر IPC ولا يُبثّ؛ يبقى في `pendingAccountLogin`
  داخل `codex.js` بسقف عمر `5` دقائق. `satr:codexLoginStart` يعيد `{ok,id}` **فقط**
  (لا رابط ولا `loginId` الداخلي)، بمعرّف بنمط `^cxlogin_[0-9]{1,9}_[a-z0-9]{1,8}$`. بعد
  `confirm` عربي صريح يقرأ `satr:codexLoginOpen` الرابط عبر `accountLoginUrl` المنقّى
  بـ`safeOauthUrl` نفسها (C3) fail-closed ثم `shell.openExternal` وينتظر الإشعار. فشل
  الفتح يبقي الطلب معلّقاً لإعادة المحاولة، والإلغاء يُرسل `account/login/cancel` إلى
  Codex ثم يُسقط الطلب. **لا يُخزَّن أي token في «سطر»، ولا يُقرأ `auth.json` في مسار
  C4 إطلاقاً** (‏`authStatus()` القائمة تبقى احتياطاً لـ`accountStatus` كما كانت).
- **الواجهة**: قسم «حساب Codex» في ⚙ بنمط قسم «حساب Claude» (دفعة B): الحالة وطريقة
  الاعتماد والخطة ونسبة استهلاك النافذة ورموز آخر 30 يوماً والإجمالي التراكمي، بأرقام
  LTR وتحديث كسول عند فتح ⚙ فقط. زر تسجيل الدخول يظهر عند `installed && !auth.ok`.
  بوابة أول التشغيل تبقى خاصة بكلود بلا تغيير.
- **قرار: `review/start` أُسقط من هذه الدفعة** (كان اختيارياً). السبب من الـschema لا من
  ضيق الوقت: `ReviewStartResponse` يعيد `{reviewThreadId, turn}` — أي أن المراجعة تجري في
  **خيط منفصل**، وأحداثها تصل بـ`threadId` مختلف عن الجذر. عرضها يستلزم مسار توجيه أحداث
  لخيط ثانٍ يخترق مرشّح `belongsToRootThread/belongsToRootTurn` الذي يحرسه
  `test:codex-contract` (وهو عقد عدم تراجع ملزم)، ويستلزم كذلك عملاً في `chat.js` الحسّاس.
  ذلك دفعة مستقلة بحاجزها الخاص، لا ذيل دفعة. (تأكيد إضافي من الـschema:
  `NonSteerableTurnKind` يضم `review` — دور المراجعة صنف مستقل غير قابل للتوجيه.)
- **إعادة تحقّق (2026-08-27، ‏`0.149.1`)**: العقود **صامدة** (البدء فوق اعتماد قائم ما
  زال يُقبل، والإلغاء يولّد `completed` بـ`success:false`، والمعرّف المجهول يردّ `-32600`،
  و`credits.balance` نص). والانحراف **إضافي**: `usage/read` كسب `threadUsage`، و
  `rateLimits/read` كسب `rateLimitsByLimitId` و`individualLimit` و`limitId` و
  `spendControlReached`. قائمة الحقول المغلقة في `normalizeRateLimits` تُسقطها
  fail-closed فلا يتأثر العرض.
- **التحقق**: `npm run test:codex-account` (قطعي، بلا شبكة — fixture عبر `CODEX_BIN=node`)
  يغطي تطبيع الاستهلاك والحدود وقوائم الحقول المغلقة، `params:null` على السلك، دورة
  الدخول (نجاح/رفض/إلغاء يُرسل `account/login/cancel`/رابط غير آمن/بلا رابط/فشل)،
  **فحصاً صريحاً لعدم تسرّب الرابط أو `loginId` من قناة البدء**، غياب أي بريد أو رمز في
  كل ردّ، عدم قراءة ملف من القرص داخل كتلة C4، عقود `main.js` وpreload، التدهور الرشيق
  برسائل عربية بلا نص upstream، وثبات مجموعة أنواع `satr:event`. وهو داخل `test:full`.
  المسبار الحيّ `npm run test:codex-account-probe` خارجها عمداً.

### موثوقية الإرسال — مهلات الإقلاع والإيقاف (إصلاح 2026-07-30)

- **العلة المشخّصة**: عملية `codex app-server` حيّة غير مستجيبة كانت تعلّق الدور في
  «يستعد» بلا نهاية (`request()` وعد عارٍ بلا مهلة في تسلسل الإقلاع)، وتعليق
  `turn/interrupt` عند الإيقاف كان يعلّق `stopAll` فيحبس قفل `sendRequestBusy` في
  `main.js` إلى الأبد — كل رسالة لاحقة ترتد «انتظر اكتمال بدء الطلب السابق» حتى
  إعادة تشغيل التطبيق. نفس البنية في مسار SDK حين يعلق `agent.start` قبل الحسم.
- **الإصلاح**: `request(method, params, timeoutMs?)` في `codex.js` صار يقبل مهلة
  اختيارية (الطلبات بلا مهلة كما كانت)؛ طلبات الإقلاع الخمسة
  (initialize/thread-resume/thread-start/compact/turn-start) مقيدة بـ
  `BOOT_REQUEST_TIMEOUT_MS=60000` فتفشل صريحاً في مسار catch القائم
  (spawn_error + result خطأ + cleanup يقتل العملية)، و`turn/interrupt` في `stop()`
  مقيد بـ`INTERRUPT_TIMEOUT_MS=5000` ثم cleanup (نمط forceClose في SDK). وفي
  `main.js`: `stopAll(false)` داخل مسار الإرسال داخل `Promise.race` بسقف
  `STOP_ALL_SEND_TIMEOUT_MS=15000` (المقابض تُسحب مزامنةً وأحداث الدور القديم
  محجوبة بـ`runSeq`)، و`await agent.start` بسقف `SDK_START_TIMEOUT_MS=90000` —
  التجاوز يعيد رسالة عربية ويوقف التشغيل اليتيم عند حسمه المتأخر. تجاوز البيئة
  `SATR_CODEX_BOOT_TIMEOUT_MS`/`SATR_CODEX_INTERRUPT_TIMEOUT_MS` (‏100..600000)
  للاختبار القطعي حصراً.
- **التحقق**: `npm run test:send-liveness` (قطعي، بلا شبكة — fixtures بنمط
  `CODEX_BIN=node`): إقلاع صامت يفشل خلال المهلة بدل الصمت الأبدي، إيقاف على قناة
  ميتة يُحسم خلال المهلة، وحرس نصية على حصون main وحدود تجاوز البيئة؛ مسجل في
  `test:full`. عقود Codex الخمسة (contract/steer/compact/account/mcp-panel) أعيد
  تشغيلها خضراء بعد التعديل، و`eval:agent` ‏12/12.

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

### مخزن الأسرار ومركز المفاتيح (keys.js — المرحلة 5ب)

- **`electron/keys.js`**: `~/.satr/keys.json` (كائن اسم→قيمة). المحوّلات تقرأ المفتاح:
  بيئة النظام أولاً ثم `keys.get(name)` — موثوق لا يعتمد على وراثة البيئة أو إعادة التشغيل
  (يُقرأ لحظة الطلب). بذرة إدارة أسرار Enterprise (نقطة الربط §4.3).
- **🔒 أمان مثبّت**: قيم الأسرار **لا تُعاد للواجهة أبداً** — `satr:keysList` يعيد الأسماء
  المضبوطة فقط. `satr:keySet {name, value}` يقبل **أسماء مفاتيح المزوّدين المسجّلين فقط**
  (`SAFE_KEY_NAME` + فحص `adapters.list()`)، قيمة ≤8ك، كتابة لملف لا spawn. `satr:keyDelete`.
- **الواجهة**: قسم «مفاتيح المزوّدين» في ⚙ (منتقي مزوّد + حالة «مضبوط/غير مضبوط» + إدخال
  password + حفظ/مسح). الحفظ فوري (بلا إعادة تشغيل).

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

### نواة مدير جولة TestSprite (testspritejobs.js — العقد المجمَّد v1)

`electron/testspritejobs.js` وحدة مفردة تنقل ملكية جولة TestSprite من **الدور** إلى
**التطبيق**: كانت الـharness والمراقب يعيشان داخل دور واحد في `agent.js`/`codex.js`
فتضيع الجولة بانتهائه، وصارت الوحدة تملكهما عبر الأدوار وتبثّ حالتها بشفافية.

- **العقد**: `startJob({cwd, kind, prompt})` → `{ok:true, jobId, url}` أو `{ok:false, error}`
  (`bad_input|busy|harness_failed|cancelled|internal_error`) · `status()` → snapshot منقّى
  أو `{active:false}` قبل أول جولة · `cancel(jobId)` · `cleanupBeforeQuit()` ·
  `setNotifier(fn)` (و`create(deps)` لحقن مزيّفين في الاختبار). `kind ∈ {app, site}`
  يوجّه داخلياً إلى `testspriteharness.start()` أو `startSite()`، و`jobId` بنمط
  `^tsj_[0-9]{1,15}_[a-z0-9]{1,10}$`.
- **جولة نشطة واحدة**: الفحص والتسجيل **متزامنان قبل أي await** فلا يمرّ طلبان متسابقان
  ولا يقلع خادمان؛ الثاني يعيد `busy` بمعرّف النشطة. الحالة المنتهية تبقى محفوظة للعرض
  والترطيب، ولا تمنع جولة جديدة.
- **الحالات الست**: `preparing → awaiting_setup → running → completed`، مع `cancelled`
  و`failed`. `awaiting_setup` نافذة نموذج bootstrap (لا نتائج تغيّرت ولا config مكتمل)،
  ويرفعها أول تغيّر نتائج **أو** اكتمال التهيئة. `failed` بـ`failure_code` من قائمة
  مغلقة (`harness_lost` بعد ثلاث نبضات بلا استجابة ≈45ث، و`internal_error`) — لا نص
  خطأ خام.
- **النبض والبثّ**: مؤقّت unref كل 15ث يحدّث `heartbeat_at` من **مصدرين فقط**: تغيّر
  بصمة ملف النتائج، أو نجاح probe صحة الـharness (ببصمة `site` لجولة الموقع). البثّ عند
  كل تغيّر حالة أو تقدّم، وعلى الأقل كل 30ث أثناء الجولة الحيّة (السقف مطلب «لا صمت غير
  مفسّر»؛ التطبيق يشمل `awaiting_setup` أيضاً لأن العقد يضع أرضية لا سقفاً).
- **حدّ توقيت مقصود**: الحالة النهائية تُبثّ **قبل** إغلاق الخادم، لأن `server.close()`
  ينتظر تصريف اتصالات keep-alive (ثوانٍ مع متصفح الاختبار) فلا تتأخر بطاقة الحالة عن
  الحقيقة. التنقية الأخيرة بعد الإغلاق.
- **التنقية — حدودها مصححة بدرس حي (2026-08-08)**: `testsprite.scrubConfig(cwd)` عند
  البدء (قبل أي CLI) وعند الحالات **النهائية** وبعد الإغلاق فقط — لا مؤقّت دوري ولا
  تنقية على انتقال وسيط، لأن غلاف CLI التنفيذي **يقرأ المفتاح من config المؤقت
  أثناء الجولة** (التنقية الدورية الأصلية جوّعته فأعاد `CREATE_API_KEY` رغم نجاح
  `check_account_info` من بيئة الدور). الضمانة الجوهرية: المدير ينقّي عند **أي**
  نهاية حتى مع سقوط الدور — أقوى من تنظيف حدود الدور القديم؛ وجود المفتاح في tmp
  أثناء الجولة النشطة حدّ من تصميم الحزمة نفسه (الملف خارج Git).
- **ممنوع في النواة**: قراءة المفتاح أو حمله، تشغيل أوامر TestSprite بنفسها (يشغّلها
  النموذج بأدوات الطرفية القائمة)، أو معرفة Electron/renderer. **والبرومبت الخام لا
  يُخزَّن**: تُستخرج منه `testIds` فوراً ثم يُهمَل. لا `restart` ولا `resume` في هذا
  العقد (لا استئناف مدّعى بلا idempotency موثّق).
- **حدث `testsprite_job` (schema v1)**: `{type, schema_version:1, job_id, kind, state,
  port, started_at, heartbeat_at, summary:{total, completed, passed, failed, skipped,
  blocked}, failure_code, updated_at}` — قائمة حقول مغلقة: لا مفتاح ولا مسار مطلق ولا
  برومبت ولا URL كامل (المنفذ يكفي والواجهة تبني `http://127.0.0.1:port` للعرض LTR).
  حدث **منسَّق** لا حدث محرك، فلا يدخل `KNOWN_EVENT_TYPES` (نمط `loop_update`).
- **التحقق**: `npm run test:testspritejobs` قطعي بلا شبكة ولا قرص ولا مؤقّتات حقيقية
  (كل اعتماد محقون بمزيّف): بدء النوعين، `busy` تحت طلبين متزامنين، الانتقالات الست،
  `awaiting_setup`، النبض بمصدريه وسقف البثّ، التنقية بمواضعها الأربعة، الإلغاء
  وcleanup بلا إغلاق مكرر وبلا لمس خادم غير مملوك، وقائمة حقول اللقطة المغلقة مع فحص
  تسريب المفتاح والمسار والبرومبت وURL.

### طبقة القدرات ونموذج Community + Enterprise (features.js — المرحلة 5ج)

**التصميم الكامل في `docs/ARCHITECTURE.md`** (نموذج «النواة + Enterprise إضافي» بطريقة
مستودع Community عام + مستودع Enterprise خاص يُحقن وقت البناء — اقرأه قبل أي عمل يمسّ الفصل).
- **`electron/features.js`**: المُحمِّل الشرطي (`try require('../enterprise')`) + feature-flags.
  النواة تعمل **كاملة** إن غاب `enterprise/` (معيار قبول دائم). فشل Enterprise معزول لا
  يُسقط النواة. هوية البناء (`community|enterprise`) مستقلة عن نجاح الوحدة والترخيص؛ فشل
  وحدة في حزمة Enterprise يظهر بحالة runtime صريحة ولا يتحول إلى Community صامت. `features.init()`
  في main.js؛ IPC `satr:features` (لقطة القدرات والهوية).
- **نقاط الربط**: §4.1 مُحمِّل شرطي، §4.2 سجلّ المحوّلات، §4.3 مخزن الأسرار، §4.4 flags.
- **بناء Enterprise**: `packageFiles` allowlist من checkout الخاص، metadata صريحة، مخرجات
  `dist/enterprise/`، بلا ناشر أو محدث Community. CI الخاص يفحص الحزمة ويولّد provenance.

### IPCs المرحلة 5 (قراءة/كتابة، مُنقّاة في main.js)

`satr:providers` (قائمة المزوّدين للقائمة الديناميكية) · `satr:features` (لقطة القدرات) ·
`satr:keysList`/`keySet`/`keyDelete` (مركز المفاتيح) · `satr:appVersion` (رقم إصدار
التطبيق لسطر «إصدار سطر» أسفل ⚙ — قراءة بلا مدخلات، تعبئة كسولة مرة واحدة).
preload يكشفها كلها. القائمة «المحرك»
في index.html تُبنى من `satr:providers` (sdk خاص أولاً + المحوّلات)، والاختيار يُحفظ في
localStorage (`satr_engine`)؛ فشل الجلب ⇒ الخيارات الثابتة احتياطياً.

### متصفح الجلسات (المرحلة 1)

- IPC إضافي للقراءة فقط: `satr:listSessions` (قائمة الجلسات عبر كل المشاريع، الأحدث أولاً،
  العنوان من أول رسالة مستخدم أو `aiTitle`) و `satr:readSession {project, id}`
  (يعيد `{cwd, total, messages:[{role, text, tools?}]}` — آخر 40 رسالة مهيأة للعرض)
- التحقق في `electron/sessions.js`: أسماء المشروع والجلسة مكوّن مسار واحد عبر regex صارم
  (لا فواصل مسار ولا `..`) + فحص أن المسار النهائي داخل `~/.claude/projects`
- **التثبيت وإعادة التسمية**: تبقى ملفات `~/.claude` و`~/.codex` ومحادثات المحوّلات
  قراءة فقط؛ `electron/sessionmeta.js` يحفظ `{pinned?, title?}` جانبياً في
  `~/.satr/session-meta.json`. قناتا IPC المحددتان هما `satr:sessionMetaList` و
  `satr:sessionMetaSet {sessionId,pinned?,title?}`؛ `main.js` يعيد التحقق من `sessionId`
  بـ`SAFE_SESSION` ومن الأنواع قبل المخزن. العنوان المنقّى يجُبّ المشتق، والمثبتة تصعد
  أعلى القائمة. `preload.js` يكشف `sessionMetaList()` و`sessionMetaSet()` فقط.
- **وسم جلسات الأدوات (‏OBS-068 ب — 2026-09-03)**: لوحة الجلسات تخفي «جلسات الأدوات»
  افتراضياً، وكان كشفها **بالمسار** وحده (`~/.satr/worktrees` أو `Temp`) — فلا يُكشف ما
  جرى **داخل مجلد مشروع حقيقي** (المخطط والعصف لا يستعملان worktree؛ ومن 47 عنواناً
  مكرراً في أرشيف المالك كشف المرشّح 10 فقط). فصار المصدر الأول **وسماً وقت الإنشاء**:
  حقل `kind` **additive** بقائمة مغلقة (`['tool']`) و`setKind(sessionId, kind)` في
  `sessionmeta.js`، تستدعيه **خمسة مواضع** حين تعرف `session_id` من حدث المحرك —
  `executor.js` و`reviewer.js` (داخل `applyReviewEvent`: سياسة العمى المشتركة فتغطي
  هيئة القضاة و`reviewOnce` معاً) و`orchestrator.js` و`opsbrainstorm.js`
  و`opsplanner.js`. كلها تقبل `settings.sessionmeta` محقوناً (نمط `settings.worktrees`)
  والافتراض المخزن الحقيقي. واللوحة تقرأ **الوسم أولاً** (`toolTagged` — علم مستقل لأن
  `session.kind` محجوز لعائلة المحرك chat/codex/kimi) ثم تتراجع إلى `TOOL_PATH` للجلسات
  القديمة التي سبقت الوسم؛ والمثبّتة تنجو من المرشّح كما كانت.
  **الوسم لا يمرّ من renderer**: قائمة سماح `set` تبقى `pinned/title` وحدهما و
  `satr:sessionMetaSet` بلا تغيير، فلا تُخفي الواجهة جلسة مستخدم بادّعاء أنها أداة؛
  و`satr:sessionMetaList` يمرّر `list()` كما هو فيعبر الحقل الجديد **بلا سطر في
  `main.js`**. وللوسوم حصّة `MAX_TOOL_ENTRIES = 200` داخل سقف الـ500 بإخلاء FIFO
  للوسوم **الخالصة** وحدها (بلا تثبيت ولا عنوان): دورة غرفة عمليات واحدة تسم نحو عشر
  جلسات، فبلا حصّة يمتلئ المخزن ويعيد `set` خطأ `limit` **صامتاً** (اللوحة تتجاهل
  الفشل) فيتعطّل زرّ التثبيت. الثمن معلن: وسمٌ أُخلي يعود صاحبه للظهور إن لم يكشفه
  المسار. التحقق: `test:sessionmeta` (وحدات `setKind` + **فحص وصل** يشغّل الوحدات
  الخمس بمحرّك مزيّف يبثّ `system`) و`test:sessions-panel` (ثلاث جلسات في مجلد المشروع
  الحقيقي نفسه: موسومة تُخفى، وتوأمها غير الموسوم يظهر، وموسومة مثبّتة تنجو).
- الاستئناف في الواجهة: أمر `/جلسات` يفتح اللوحة، والنقر يضبط `sessionId` و `cwd`
  ويعرض آخر الرسائل — الرسالة التالية تمر بـ `--resume` طبيعياً
- **محادثات المحوّلات في اللوحة (الدفعة 4)**: اللوحة تدمج محادثات `~/.satr/chats`
  (DeepSeek/Gemini/…) مع جلسات كلود بالأحدث أولاً؛ صف المحوّل يعرض اسم المزوّد بدل
  المجلد. IPC قراءة فقط: `satr:listChats` (كل المزوّدين — العنوان من أول رسالة مستخدم
  مع فكّ ترويسة حقن @ في chats.js) و `satr:readChat {provider, id}` (آخر 40 رسالة نصية
  مطبّعة من صيغتَي OpenAI/Gemini — رسائل الأدوات تُتخطى). التحقق داخل chats.js (نفس
  regex الحفظ). الاستئناف: `resumeChat` يبدّل المحرك يدوياً **دون** حدث change (منطقه
  يستأنف «آخر جلسة» وقد تكون غير المنقورة) ويضبط sessionId — الرسالة التالية تستأنف
  من ذاكرة القرص (`chats.load`) طبيعياً

### لوحة المهارات (Skills)

- **السرد والأولوية**: IPC للقراءة فقط `satr:listSkills(cwd)` (`electron/skills.js`) يفحص
  `.agents/skills/*/SKILL.md` ثم `.claude/skills/*/SKILL.md` في المشروع، ثم المسارين نفسيهما
  تحت home، ثم مهارات التطبيق المضمّنة بأدنى أولوية. أول اسم يفوز، لذلك المشروع يغلب المستخدم
  وكلاهما يغلب المضمّن، والقياسي `.agents` يغلب نسخة التوافق `.claude`. يعاد
  `[{name, description, source, format, location}]` بلا مسارات مطلقة للواجهة.
- **progressive disclosure**: الفهرس يقرأ رأس `SKILL.md` فقط. المحتوى الكامل (≤128KiB)
  والموارد النصية (≤256KiB للملف، ≤100 مورداً، عمق ≤5) لا تُقرأ إلا باستدعاء الأداة.
  `realpath` يحصر المورد داخل مجلد المهارة؛ الثنائي و`..` مرفوضان؛ السكربت يُعرض كنص ولا
  يُنفّذ تلقائياً. catalog metadata مسقوف بـ16KiB ونتيجة الأداة بـ48K محرفاً.
- **المحرّكات**: Claude SDK يبقي runtime `.claude` الأصلي وplugin skills، ويخدم `.agents`
  بأداتي `load_skill` و`read_skill_resource` للقراءة فقط. Codex 0.144.1 يأخذ مدخلات skill
  الأصلية في `turn/start`. Kimi ACP يأخذ الأداتين عبر MCP المحلي مع نفس `skillContext`
  المختار من الواجهة. Gemini وعائلة OpenAI-compatible تعلنان الأداتين ضمن الحلقة؛
  Claude CLI الاحتياطي يستقبل metadata ومسارات `.agents` في stdin من دون محتوى المهارة.
- **الواجهة**: أمر `/مهارات` يفتح لوحة جانبية بمربعات اختيار. تُخزَّن **المهارات المعطّلة** في
  localStorage (`satr_disabled_skills`) لا المفعّلة، فيُفعَّل أي جديد تلقائياً. عند الإرسال:
  لا معطّل ⇐ `'all'`؛ غير ذلك ⇐ مصفوفة (المكتشف ناقص المعطّل)، ومصفوفة فارغة = لا مهارات.
- **مثال**: `.agents/skills/tafqeet/SKILL.md` (تفقيط الأرقام بالعربية) — مهارة قياسية للتجربة.
- **مهارة معرفة سطر الذاتية (satr-guide — قرار «معرفة سطر» 2026-07-18)**: `.agents/skills/
  satr-guide/` تجعل الوكيل يجيب أسئلة المستخدم عن «سطر» نفسه من مصدر حقيقة واحد بدل
  التخمين. `SKILL.md` هوية + قواعد إجابة ملزمة (حاجز هلوسة صريح «لا أعرف بدل التخمين»،
  تمييز «أنفّذه أنا/تفعله أنت من الواجهة»)، وموردان بالتحميل التدريجي: `features.md`
  (دليل الميزات بلغة المستخدم النهائي — يعتمده المالك، ولا يحيل لوثائق التطوير الداخلية)
  و`tools.md` (**مولّد آلياً**: `npm run gen:satr-guide` يشتقه من `codexmcp.buildTools()`
  و`tools.defs()` — لا يُحرَّر يدوياً). الحارس `npm run test:satr-guide` (ضمن test:full)
  يقارن الكتالوج بالمولَّد لحظياً فأي تغيير أداة دون إعادة التوليد **يكسر الطقم** —
  علاج التقادم آلي لا بشري.
  **وحارس ثانٍ ضدّ تعفّن نصفه البشري** (2026-08-27): نصف الدليل محروس ونصفه لا —
  `tools.md` مولَّد ويفشل عند أي انحراف، بينما `features.md` نثرٌ بشري معتمد من المالك
  **يتقادم بصمت**. سقطت منه `satr-generate` و`satr-design-ar` ولم يكشفه شيء حتى سأل
  المالك. فصار `test:satr-guide` يشترط أن يذكر `features.md` **كل اسم في
  `skills.BUILTIN_SKILLS`** (صارت مُصدَّرة ليقرأها الحارس من المصدر الواحد لا من نسخة
  تتباعد بصمت). **حدّه معلن**: يحرس **الذكر لا الدقة** — مهارة بوصف متقادم تمرّ — ولا
  يغطّي بقية الميزات؛ تلك تبقى على المراجعة البشرية. ولأن حزمة المهارة مسقوفة بـ40ك.ب
  والمتبقي **169 بايتاً**، أي إضافة لاحقة تستلزم شدّ النثر لا رفع السقف.
  تُحزم `satr-guide` مع `satr-diverge` كمصدري `builtin` بأدنى
  أولوية، من دون زرع أي ملف في home؛ ويبقى `tafqeet` مثال مشروع فقط. تخزين التعطيل بالاسم في اللوحة يشمل
  المهارتين مثل أي مهارة أخرى.
- **مهارة القرار المتباعد (satr-diverge — 2026-07-23)**: نسخة محمولة مشتقة من ADHD
  بترخيص MIT، ومكيّفة لعقود «سطر» بلا حزمة npm. تعمل عبر سبع مراحل: brief مجمّد، تباعد
  متوازٍ معزول، نقد أعمى، تدقيق أدلة، تصحيح متوازٍ، نقد خصومي، ثم حزمة قرار عربية.
  الميزانية الافتراضية 3 فروع، وتفشل مغلقاً إن لم يظهر primitive عزل حقيقي؛ لا تحاكي
  الفروع تسلسلياً ولا تشغّل LLM عبر shell. مواردها المنفصلة تصف أطر سطر ومحولات Claude/
  Codex/Kimi ودرجات الدليل والأمان وبروتوكول A/B قبل أي ادعاء تفوق. محول Codex يفرض
  حاجز اكتمال صريحاً: `wait_agent` واحد ليس حاجزاً، ولا يجوز إنهاء الجذر بخرج فرع منفرد؛
  يسجل `launched/completed/failed/missing` ويفشل مغلقاً عند فقد سياق. `test:skills`
  يثبت اكتشافها كمضمّنة، والتحميل التدريجي لمواردها، ومدخل Codex وعقد أدوات Claude/Kimi.
- **مهارة القبول البشري (satr-accept — قرار مالك 2026-08-25)**: تنظّم الجزء الذي لا يؤتمت
  من اعتماد دفعة تمسّ ما يراه المستخدم: بناء نسخة، بيئة تجربة تُعرف نتيجتها سلفاً، خطوات
  مرقّمة بمعيار «صواب/فشل» **مكتوب قبل التنفيذ**، ثم تسليم وانتظار لقطاته. قواعدها
  الملزمة: المستخدم ينقر لا الوكيل (المحاكاة تُفرغ الغرض فتصير اختباراً آلياً ثانياً)،
  ولا ادّعاء لما لم تُظهره اللقطة، وعند تعارض الدليل مع ذاكرة المستخدم تُقرأ الشيفرة ثم
  تُصمَّم **خطوة واحدة حاسمة** بدل الجدال أو التصديق. وتعلن **متى لا تصلح** (تغيير بلا
  سطح مرئي كـ`looprunner`/`merger`، أو دفعة من سطرين، أو ما يمسكه حارس آلي) كي لا تصير
  طقساً. ومنذ `OBS-055` تملك **ترساً أوسط** بين البروتوكول الكامل وإحالة الطقم: «فحص
  مصغّر» لفجوة بصرية **واحدة** تُعرض في نسخة عاملة **بلا بناء**، بشروط ثلاثة صريحة
  (ادعاء مفرد · بلا بناء · معيار مكتوب سلفاً) وبقاء «هو ينقر لا أنت» بلا تخفيف —
  فلا يصير الترس إذناً بإغلاق الفجوة بالاستنتاج. والوصف نفسه يذكره لأن حدّ «دفعة من
  سطرين» كان يصرف الوكيل عن تحميل المهارة في الحالة عينها التي يخدمها الترس. موردها `example.md` جلسة حقيقية كاملة (‏2.16.9) تسجّل أخطاء المنفّذ فيها لا
  نتائجها وحدها. القاعدة نفسها مثبّتة في `AGENTS.md`. **المبرّر مقيس**: أول تطبيق كامل
  لها كشف `OBS-053` — عطلاً كان يُسقط التطبيق في إصدار منشور — بينما `test:full` أخضر 75/75.
- **مهارة واجهات الحرف العربي (satr-design-ar — 2026-08-27)**: تحمل خبرة «سطر» المقيسة في
  واجهات الحرف العربي إلى **مشاريع المستخدمين** (لا إلى واجهة «سطر» نفسها — قرار مالك)،
  ونطاقها **عائلة الحرف كلها** (‏`OBS-037`): العربية والفارسية/الدَرية والأردية والبشتو
  والسورانية والسندية والأويغورية. تدور حول حلقة **قِس ← أصلح ← أعد القياس** بأداة
  `browser_readability`، ومحورها العطل المركزي: `getComputedStyle(el).direction` يكذب —
  يعيد `rtl` الموروثة بينما الفقرة رست LTR — فلا يكشفه إلا موضع أول محرف بالبكسل، ولا
  يفحصه أي مدقّق ويب عام. تحمل الدالة الإحصائية `ar*2 >= lat` **مضمَّنة نصاً** لا محالاً
  إليها، ودروس القوائم (`<bdi>` لأن `plaintext` ينقل صندوق العلامة) والجداول والكود
  المضمّن (`unicode-bidi: isolate`) والتخطيط المرآتي (`text-align` صريحة لأن الوراثة تغلب
  `dir`)، والاستضافة الذاتية للخط مع `unicode-range`، ومقايضة النستعليق المعلنة (الأردو
  تُرسم Naskh). مواردها الأربعة (`direction/fonts/locales/checklist`) بالتحميل التدريجي.
  - **المحمولية شرط وجودها لا تحسينها** (‏`OBS-060`): تعمل داخل مشروع المستخدم حيث لا
    وجود لـ`docs/` ولا `electron/` ولا سكربتاتنا، فالإحالة إلى مسار غائب **أسوأ من
    السكوت** — كلّفت جلسةً 1014 ثانية و‏$13.77. لذلك المهارة مكتفية بذاتها، ويفشل
    `test:skills` على أي تسريب مسار من مستودعنا إلى نصّها أو أي مورد من مواردها.
  - **تعلن ما لا تقيس**: جودة تشكيل الحروف واتصالها، والجمال، وترخيص الخط، وما داخل
    Shadow DOM أو `<iframe>` — ومعها حدود الأداة نفسها (‏عناصر الكتل فقط، سقف 200،
    تخطّي التباين فوق خلفية صورة/تدرّج). وتذكر «متى **لا** تُستعمل» صراحةً كي لا تصير طقساً.
- **مهارة نصّ YouTube (satr-youtube — 2026-09-01)**: تعطي الوكيل ما يفعله المستخدم
  يدوياً اليوم — يعطيه رابط فيديو فيفهمه معه. مضمّنة، وتشغّل `yt-dlp` في الطرفية المرئية.
  - **مسار المتصفح ميت، والحكم مقيس لا مقدَّر** (‏أربع إشارات متسقة على فيديو حقيقي):
    `ytInitialPlayerResponse` **يعلن** مسار ترجمة فيبدو الطريق سالكاً · لكن جلب
    `baseUrl` يعيد **`200` بجسم فارغ** والرابط بلا `pot` (‏Proof-of-Origin الذي فرضته
    YouTube ضد الاستخراج الآلي) · ولوحة النصّ في DOM تُفتح `EXPANDED` وجسمها **26
    محرفاً** (تبويبات فقط) · وزرّ CC في المشغّل يقول «غير متاحة». **الإشارة الرابعة
    حاسمة**: الحجب على مستوى الجلسة لا على مستوى قراءتنا، فأي عمل في مُحدِّدات DOM أو
    صيغ `fmt=` ضائع. ولذلك المسار الميت **موثّق داخل المهارة نفسها** كي لا يُعاد.
  - **ولماذا تعمل إضافات المتصفح (‏Glasp) ونحن لا**: تعيش في Chrome بملف مستخدم وكوكيز
    تجتاز فحوص السلامة؛ معاينة «سطر» ‏`WebContentsView` بـpartition منفصلة لا تجتازها.
  - **`yt-dlp` اجتازه**: حلّ تحدّي JS ثم استخرج **488 مقطعاً · 16301 محرفاً · ~4075
    رمزاً** لعشرين دقيقة ⇒ قاعدة السياق المدوَّنة **~200 رمز لكل دقيقة**.
  - **فخّ PATH مقيس**: تثبيت `winget` يضع الأداة في `%LOCALAPPDATA%\Microsoft\WinGet\
    Links` وهو **ليس في PATH الذي ورثه التطبيق عند إقلاعه** — فتبدو غائبة وهي مثبَّتة.
    (نظير درس `resolveClaudeBin` في بوابة أول التشغيل.)
  - **حدود معلَنة**: بلا ترجمة ⇒ لا ملخّص ولا تفريغ صوتي بنموذج ولا تخمين · التفريغ
    الآلي يحرّف المصطلحات فيُقال ذلك · ولا تُطلب ترجمة YouTube التلقائية بالعربية لفيديو
    إنجليزي (ترجمة آلية فوق تفريغ آلي) بل تُطلب لغة الأصل ويترجم النموذج.
- **التحقق**: `npm run test:skills` يثبت precedence والتحميل التدريجي وحدود الموارد وأدوات
  المحوّلات ومدخلات Codex، ثم `npm run eval:agent` يحمي baseline الوكيل 12/12.
  و`test:satr-guide` صار يشتقّ قائمة المضمّنات من `BUILTIN_SKILLS` لا من نسخة مكرّرة —
  الدرس نفسه الذي بُني عليه فحص `features.md`: قائمةٌ ثانية تتباعد بصمت.

### سجل المهام الدائم (Task Ledger — الأولوية 2)

- **التخزين**: `electron/tasks.js` يحفظ snapshot فقط تحت
  `~/.satr/tasks/<engine>/<session_id>.json`؛ لا prompt ولا transcript. المعرّفات منقّاة
  كمكوّن مسار واحد، والسجل ≤50 مهمة، والدليل ≤6 بنود للمهمة، والملف ≤512KiB.
  الكتابة عبر ملف مؤقت ثم rename وأفضل جهد؛ فشل القرص لا يكسر الدور.
- **المحرّكات**: Codex يطبّع `turn/plan/updated` المثبّت من schema v2، وKimi ACP يطبّع
  تحديث `plan` ويمكنه استعمال `update_task_ledger` عبر MCP. Claude SDK
  يطبّع أدوات `TodoWrite` و`TaskCreate` و`TaskUpdate` ورسائل النظام الحقيقية
  `task_started/task_updated/task_progress/task_notification` المثبتة من `sdk.d.ts`؛
  لا يعتمد على تخمين حدث غير موجود. المحوّلات تملك أداة `update_task_ledger` في حلقة الأدوات.
- **العرض**: `<satr-chat>` يعرض التقدم والحالات والاعتماديات والمالك ودليل التحقق في بطاقة
  خفيفة أعلى الخيط. `satr:taskLedger` يعيد snapshot عند استئناف جلسة، و`satr:taskAction`
  يقبل `pause|resume` فقط. الإيقاف زر ظاهر يوقف الدور ويحفظ ledger؛ الاستئناف ظاهر ولا
  يرسل prompt تلقائياً — يطلب من المستخدم إرسال متابعة.
- **مهام إعداد المنصات**: يوجّه `envbrief` المحرّكين إلى تحديث السجل بعد كل منصة بما اكتمل
  وما ينتظر المستخدم وما يلي، فتعيش خطة Brevo/Netlify/Gmail عبر الأدوار. لوحة المعاينة
  تضيف أثراً مرئياً مقتضباً للصفحات وآخر فعل وزر «إيقاف المهمة»؛ هذا أثر شفافية لا مخزن جديد.
- **التحقق**: `npm run test:tasks` يغطي schema/التخزين/merge/الأدلة/الإيقاف والاستئناف
  وحدود الإدخال وأداة المحوّلات. و`npm run test:task-ledger-ui` (حي، ضمن test:full) يغطي
  بطاقة السجل في `<satr-chat>` الإنتاجي داخل Chromium تحت CSP صارم: عتبة الظهور (≥3 مهام)،
  التقدم LTR، الحالات الأربع، الاعتماديات/المالك/الأدلة، الطي المحفوظ، أحداث pause/resume
  بعقدها، وتبديل الجلسة بلا تكديس. `npm run eval:agent` يبقى baseline ‏12/12.

### حلقة التحقق وcheckpoint الدور (الأولوية 3)

- **إعداد صريح فقط**: لا يكتشف «سطر» أوامر من `package.json` ولا يخمّنها. المشروع يضيف:

  ```json
  {
    "version": 1,
    "commands": [
      { "id": "lint", "label": "فحص التنسيق", "command": "npm run lint", "timeout_seconds": 120 },
      { "id": "test", "label": "الاختبارات", "command": "npm test", "timeout_seconds": 300 }
    ],
    "preview": {
      "command": "npm run dev",
      "url": "http://localhost:5173/",
      "timeout_seconds": 60
    }
  }
  ```

  الملف `.satr/verify.json` داخل `cwd` حصراً، symlink مرفوض، ≤64KiB، ≤6 أوامر، وكل
  command سطر واحد ≤1000 محرف. `preview` اختياري، وأمره سطر واحد بالحد نفسه، وعنوانه
  `http|https` محلي فقط (`localhost|127.0.0.1|[::1]`) ومهلته 1–600 ثانية. قراءة `verification_config` بلا إذن ولا تنفيذ؛
  `verify_project` طبقة `exec` فيعرض مربع الإذن العربي الأوامر الفعلية ثم يشغّل snapshot
  نفسه في طرفية النموذج. لا «موافقة دائمة» للتحقق.
- **معالج الإنشاء اليدوي**: زر «إعداد التحقق» داخل غرفة العمليات يفتح
  `satr-verify-config-dialog` لإدخال `id/label/command/timeout` يدوياً (لا قراءة
  `package.json` ولا اكتشاف scripts). يعرض JSON للمراجعة قبل الكتابة؛ الملف القائم يفرض
  تأكيد استبدال ثانياً. `satr:verifyConfigCreate` منقّى في `main.js`، والكاتب الذرّي في
  `verify.js` يثبت المسار `.satr/verify.json` داخل cwd، ويرفض root/`.satr`/الهدف الرمزي
  والخروج والكتابة فوق ملف بلا `overwrite:true`. الإنشاء لا يشغّل شيئاً، ويبقى الملف مطلوباً
  داخل `HEAD` قبل غرفة قابلة للدمج.
- **مهارة المراجعة النوعية**: المعالج نفسه يتيح اختيارياً معاينة
  `review_skill:{name}` داخل JSON قبل أي كتابة. عقد preload المحدد هو
  `verifyConfigCreate(cwd, commands, overwrite, confirmed, reviewSkill)`؛ تنقّي قناة
  `satr:verifyConfigCreate` المرجع ثم تمرّره إلى `verify.createConfig`، وهو الكاتب الوحيد
  لـ`.satr/verify.json`. إنشاء المصدر مستقل وصريح عبر
  `reviewSkillCreate(cwd, skill, overwrite, confirmed)` وقناة `satr:reviewSkillCreate`، حيث
  `skill={name,description,criteria}` ولا يمرّر renderer مسار الهدف. `electron/skillwriter.js`
  يثبت الهدف في `.agents/skills/<name>/SKILL.md`، والاسم يطابق
  `[A-Za-z0-9._-]{1,64}`، والمعايير لا تتجاوز 16KiB وتُزال منها محارف التحكم/Bidi وتُرفض
  كلياً إن التقطها `memory.hasSecret`. يفحص الكاتب `realpath` لكل مكوّن ويرفض
  symlink/junction والخروج بلا كشف المسار الخارجي، ولا يستبدل بلا `overwrite:true`، ويكتب
  ذرياً عبر temp+rename مع استعادة الملف السابق عند فشل الاستبدال. غياب المهارة يبقي العقد
  السابق بلا تغيير، وأي فشل في التنقية أو المسار مغلق ولا يتحول إلى كتابة جزئية.
- **المحرّكات**: Claude SDK يملك خادم MCP مستقل `satr-verify` خارج `satr-terminal`؛
  Kimi ACP والمحوّلات يملكون الأداتين عبر `tools.js` (Kimi من MCP المحلي). Codex لم يُعدّل: `main.js` يجمع تعديلاته مثل
  غيره، وزر التحقق اليدوي يعيد ملخص النتيجة إلى دوره التالي مرة واحدة عبر
  `<satr_verification_result>` ثم يعلّمها مستهلكة.
- **checkpoint**: يبدأ مع الدور ولا يظهر/يُحفظ حتى أول `file_edit`. يجمع ≤50 edit ID
  وملخص الملفات، ويربط تلقائياً بالمهمة فقط حين توجد مهمة `in_progress` وحيدة. عند
  التحقق تُضاف evidence من نوع `verification_pass|verification_fail` إلى المهمة المطابقة
  بالعنوان دون تغيير حالتها خفيةً.
- **الاستعادة**: زر ظاهر مع تأكيد؛ آخر checkpoint الحي فقط، وفي cwd نفسه، ويستدعي undo
  لكل edit ID بالعكس. لا `git reset` ولا commit ولا لمس history. بعد إعادة تشغيل التطبيق
  تبقى metadata وhashes للمقارنة لكن `restorable=false` لأن snapshots الذاكرية انتهت.
  الفشل يوقف السلسلة فوراً ويعلّم checkpoint `partial` بدلاً من متابعة قد تفسد الملفات.
- **IPC**: `satr:checkpointLatest(engine,sessionId)` قراءة فقط؛
  `satr:verifyCheckpoint(...)` يفتح permission_request؛ `satr:checkpointRestore(...)`
  يتحقق من engine/session/checkpoint/cwd في `main.js` ثم يستخدم undo الموحّدة.
- **التحقق**: `npm run test:verify` يغطي schema/رفض الأسطر المتعددة/runner/حدود الخرج/
  persistence/reverse restore/cwd/عودة النتيجة مرة واحدة. `npm run eval:agent` يبقى 12/12.
### ذاكرة المشروع المحلية الصريحة (الأولوية 4)

- **الفصل والتخزين**: `electron/memory.js` يحفظ JSON صغيراً لكل مشروع تحت
  `~/.satr/memory/<cwd_sha256>.json`، منفصلاً كلياً عن transcript و`AGENTS.md`. كل مدخل نوعه
  `fact|decision|command|failure` وله المصدر وتاريخا الإنشاء/التحديث والثقة والنطاق
  (`project` أو مسار نسبي داخل المشروع). السقف 200 مدخل و512KiB للملف، وكتابة ذرية أفضل جهد.
- **الموافقة والأسرار**: `propose_memory` في SDK وحلقة `tools.js` تبث `memory_candidate` فقط؛
  لا تكتب. الحفظ يحدث من زر «حفظ في الذاكرة» عبر IPC منقّى في `main.js`. مفاتيح API وJWT
  وPrivate Keys وBearer والقيم المسندة إلى password/secret تُرفض قبل القرص وقبل عرض المرشّحة.
- **الاسترجاع**: فهرس كلمات/مسارات بلا dependency أو vector DB؛ الاستعلام أقصاه 8 كلمات،
  والحقن أقصاه 8 مداخل/6000 محرف. يُحقن كسياق غير تنفيذي في دور SDK وClaude CLI وGemini
  والمحوّلات المتوافقة مع OpenAI. **ومحركا Codex وKimi Code الأصيلان**: كتلة
  `<satr_project_memory>` تُحقن سياقاً مستقلاً قبل التنفيذ، مستَرجعة من
  prompt المستخدم الأصلي (لا effectivePrompt المعالج)؛ السياقات المعزولة
  (المراجع/العصف — `browserControl:false` الصريح، نفس بوابة TestSprite) لا ترثها.
  حارس عدم تراجع في `test:memory`.
- **الواجهة**: `/ذاكرة` يفتح `satr-memory-panel` للبحث والتعديل والحذف. وصول مرشّحة يفتح
  مربع مراجعة قابل للتحرير مع حفظ/رفض صريحين. `shareable` يعرض اقتراح النقل إلى `AGENTS.md`
  أو Skill؛ لا نقل تلقائياً ولا كتابة في ملفات المشروع.
- **التحقق**: `npm run test:memory` يغطي عدم الكتابة بلا موافقة، رفض الأسرار، حدود الفهرس
  وميزانية الاسترجاع، التعديل والحذف. `npm run eval:agent` يبقى 12/12.

### خريطة المستودع المقتصدة للمزوّدات العمياء (الأولوية 5 — الدفعة الأولى)

- **النطاق**: `electron/repomap.js` يبني عند الطلب خريطة تقريبية للمسارات وأبرز تعريفات
  `function|class|const|export` بتعابير regex بسيطة حسب عائلات JS/TS وPython وRuby وPHP
  وGo وRust وJVM/.NET وC/C++ وSwift. لا parser ولا vector DB ولا dependency أو فهرس دائم.
- **الأمان والاقتصاد**: لا قراءة مسار جديدة؛ السرد عبر `files.listFiles` والقراءة عبر
  `files.readText` المؤمَّنتين، وترتيب الاستعلام يعيد استخدام `search.normalize/queryTerms`.
  السقوف: 400 ملف مرشّح، 256KiB/ملف، أول 96KiB و4000 سطر، 12 رمزاً/ملف و500 إجمالاً،
  120 ملفاً في الناتج، 1.2ث للمسح و24KiB للنص. لا تُعرض قيم الثوابت أو أجسام الدوال؛
  التوقيع فقط. نفاد أي سقف يعيد نتيجة جزئية بدلاً من تمديد العمل.
- **العقد**: أداة `repo_map({query?})` موجودة في `electron/tools.js` فقط، قراءة بلا إذن؛
  عائلتا OpenAI-compatible وGemini ترثانها تلقائياً. الناتج موسوم
  `<satr_repo_map estimate="true">` ويوجّه النموذج للتحقق بـ`search_code/read_file` قبل
  التعديل. لا تكامل في `agent.js` أو `codex.js` لأن المحرّكين الأصليين يملكان أدوات بحثهما.
- **التحقق**: `npm run test:repomap` يغطي الاستخراج متعدد اللغات، تجاهل المجلدات الثقيلة،
  الملف الضخم، أولوية الاستعلام وسقوف الوقت/الملفات/الرموز/الناتج وعقد القراءة بلا إذن.

#### حقن الخلاصة وتقدير الميزانية (الأولوية 5 — الدفعة الثانية)

- **الخلاصة التلقائية**: `repomap.summarize(cwd,prompt)` تبني في بداية كل دور للمحوّلات
  العمياء نسخة أصغر موسومة `<satr_repo_map mode="summary" estimate="true">`: حتى 160 ملفاً
  ممسوحاً، 24 ملفاً في الخلاصة، 600ms و3200 محرف (≈1600 رمز تقديري في أسوأ توزيع محارف).
  تُدمج مع سياق Skills والذاكرة في system context لعائلتَي OpenAI-compatible وGemini،
  قبل أول طلب؛ محركا SDK وCodex لا يتأثران.
- **ميزانية تقديرية صريحة**: `electron/context.js` يستخدم heuristic محلياً (ASCII نحو 4
  محارف/رمز، وغير ASCII نحو محرفين/رمز) ويحقن كتلة
  `<satr_context_budget estimate="true" method="character_heuristic">`. الرقم إرشادي لا
  يُنسب إلى tokenizer المزوّد، ويوجّه النموذج لاختيار الملفات ثم التدرج بـ`search_code/read_file`.
- **عقد usage**: كل طلب وجولة يضيفان تقدير input/output محلياً. إن أعاد API usage حقيقياً
  فهو المصدر المقدّم بلا تغيير؛ إن غاب يعود `result.usage` بالشكل
  `{input_tokens,output_tokens,estimate:true,method:'character_heuristic'}`، ومعه
  `context_estimate` لميزانية بداية الدور. لا تكلفة مالية مشتقة من هذا التقدير.
- **التحقق**: `npm run test:context` يغطي سقف الخلاصة، وسم estimate، أولوية usage الحقيقي،
  fallback التقديري، ودورة HTTP فعلية تثبت وصول الخلاصة والميزانية لمحوّل OpenAI-compatible.
- **ملخص استهلاك جلسة Community**: `src/ui/lib/usage-summary.js` يطبّع ويجمع usage لكل
  نتيجة دور في الذاكرة فقط، ويدعم `input/output` و`input_tokens/output_tokens`، مع وسم
  التقدير ومنع تكرار كائن النتيجة عبر `WeakSet` بلا الاحتفاظ به. تبقى رموز cache مستقلة
  عن input لأن Claude قد يعيد cache أكبر من الإدخال غير المخبّأ. `src/ui/components/chat.js` يعرض الإجمالي في `#costInfo`
  ويصفّره عند جلسة جديدة أو تفريغ الخيط؛ لا ينقل ذلك تجميع Enterprise اليومي/الشهري.
- **سجل نشاط Community المحلي**: `electron/activity.js` يحفظ آخر 200 حدث metadata في
  `~/.satr/activity.json` بكتابة ذرية أفضل جهد وبصمة داخلية للمشروع. لا يدوّن نص الطلب أو
  مدخلات الأدوات أو المخرجات أو المسارات المطلقة أو معرّفات الجلسات/الأذونات. قسم «النشاط
  المحلي» في ⚙ يعرض آخر 20 حدثاً للمشروع الحالي، ومسحه يتطلب تأكيداً صريحاً؛ سجل Enterprise
  الكامل في `satr-enterprise/audit.js` الخاص مستقل.

### منسّق باحثين للقراءة فقط (الأولوية 6 — الخطوة 1)

- **النطاق الصغير**: `electron/orchestrator.js` يشغّل 1–3 باحثين متوازيين على سؤال واحد.
  هذه الجولة تستخدم محرك SDK فقط من IPC، لكن النواة تستدعي عقد `engine.start` صندوقاً أسود
  وقابلة لحقن resolver للمحوّلات لاحقاً. لا Codex ولا worktree ولا كتابة أو دمج.
- **الأمان fail-closed**: كل دور يُمرّر حتماً بـ`permissionMode:'plan'` و`browserControl:false`
  وSkills فارغة. أي `permission_request` يُرفض آلياً (ميزانية إذن صفرية)، وقائمة الأدوات
  البيضاء هي `Read|Grep|Glob` فقط؛ `Task/Agent/Bash/Edit/Write` وأي أداة أخرى توقف الباحث.
  وصول `file_edit` أو طرفية نموذج أو نتيجة تحقق يوقفه كخرق. لكل باحث مهلة 90ث وسقف خلاصة
  12k محرفاً و24 مصدراً؛ التوازي الأقصى 3، وتشغيل فريق ثانٍ أثناء الأول يُرفض بـ`busy`.
- **الجمع والإيقاف**: المصادر تأتي من مدخلات Read/Grep ومن المسارات المذكورة في الخلاصة،
  وتُنقّى إلى مسارات نسبية داخل cwd. النهاية تدمج خلاصات الباحثين والمصادر بلا تكرار وتجمع
  usage/التكلفة. `stop(runId)` يقاطع كل مقابض الفريق، وإغلاق التطبيق يستدعي `stopAll()`.
- **IPC والواجهة**: `satr:researchStart {cwd,question,count}` و`satr:researchStop {runId}`
  و`satr:researchLatest {cwd}` منقّاة في `main.js` (آخر نتيجة محصورة بالمشروع الحالي). الأمر `/بحث` يفتح `satr-research-panel`؛
  بطاقات بهيئة `agent-card` تعرض الحالة والكلفة والخلاصة والمصادر، وزر «إيقاف الكل» يقاطع
  الفريق. النقر على مصدر يفتح عارض الملف عند السطر إن وُجد.
- **التحقق**: `npm run test:orchestrator` يغطي باحثاً واحداً، التوازي 3، فرض plan ورفض
  الإذن، المهلة، الإيقاف الجماعي، fail-closed لأحداث الكتابة ومنع الأدوات غير المقروءة.

### عامل منفّذ محايد عن المحرك في worktree معزول (الأولوية 6 — الخطوة 2)

- **دورة الحياة**: `electron/worktrees.js` يتحقق أن `cwd` مستودع Git ذو `HEAD`، ثم
  ينشئ detached worktree من نفس الرأس تحت `~/.satr/worktrees`. كل أوامر Git عبر
  `execFile` ومصفوفة وسائط بلا shell، والمسار يجب أن يبقى داخل جذر التخزين وخارج
  المستودع الأصلي. تُرفض symlinks وsubmodules المتعقّبة قبل التنفيذ. `--force` محصور
  في حذف worktree المؤقت المولّد داخلياً بعد التقاط الفرق؛ لا force على فرع المستخدم.
- **التنفيذ المحصور**: `electron/executor.js` يستدعي runner محقوناً بعقد `start` صندوقاً أسود بوضع
  `permissionMode:'acceptEdits'` و`cwd` مسار worktree. القائمة البيضاء `Read|Grep|Glob|Edit|Write|MultiEdit`
  فقط؛ أي أداة تنفيذ/Git/متصفح/وكيل فرعي أو مسار خارجي يوقف الدور fail-closed. ميزانية
  إذن الكتابة 30 وطلباً كحد أقصى. فرق غرفة العمليات تختار مهلة كل عامل من presets ثابتة
  180/300/600ث (الافتراضي 300ث والسقف 600ث)، ويتوفر interrupt واحد. يجب أن يحمل
  runner اسم محرك صريحاً مطابقاً لـ`SAFE_ENGINE_LABEL`؛ غيابه أو غياب `start` يعيد
  `engine_unavailable` قبل إنشاء worktree. يحقن `main.js` محرك SDK الحالي صراحةً، ولا يدخل Codex هنا بعد.
- **النتيجة بلا دمج**: بعد النهاية/المهلة/المقاطعة يقرأ المنفّذ `gitdiff.changes`، يحتفظ
  بملخص الملفات/الأسطر وبيانات `file_edit` كنقطة مراجعة، ثم يحذف worktree. لا API للدمج
  أو commit في هذه الخطوة، والنتيجة تصرّح دائماً `merged:false` و`merge_supported:false`. لم نشغّل
  أوامر verify داخل العامل لأن هذه النسخة الصغرى تمنع exec كلياً.
- **IPC والواجهة**: بدء `satr:executionStart {cwd,task,confirmed:true}` يتطلب تأكيداً صريحاً
  وينقّي `cwd/task` في `main.js`؛ الإيقاف وآخر نتيجة عبر `satr:executionStop`/
  `satr:executionLatest`. الحدث `execution_update` (schema v1) يغذّي لوحة `/تنفيذ-معزول`، وتعرض الحالة/
  الكلفة/ميزانية الكتابة/الملخص/الفرق، ولا تقدّم زر دمج.
- **التحقق**: `npm run test:worktrees` يغطي دورة الإنشاء/الفرق/الإزالة، عزل الكتابة
  عن المستودع الأصلي، runnerين مزيفين موسومين يمران بالسياسة نفسها، رفض runner مفقود أو بلا هوية أو مشوّه
  قبل إنشاء worktree، المهلة/المقاطعة، رفض المسار الخارجي، وغياب الدمج التلقائي.

### عوامل منفّذة متوازية بملكية ملفات (الأولوية 6 — الخطوة 3)

- **الفريق المحدود**: `electron/executionteam.js` يشغّل 1–3 نسخ مستقلة من عقد
  `electron/executor.js` بالتوازي؛ لكل عامل SDK ‏worktree منفصل من `HEAD` ومهلة وميزانية
  كتابة وقائمة الأدوات البيضاء نفسها من الخطوة 2. التشغيل يبقى SDK فقط ولا يستدعي Codex.
- **الملكية المعلنة**: كل مهمة تحمل 1–16 مساراً أو نمطاً نسبياً (`*` و`?` و`**` فقط)،
  منقّاة مرة في `main.js` ومرة في النواة. القراءة مسموحة داخل worktree، أما `Edit|Write|MultiEdit`
  فتُقبل فقط إن طابق المسار ملكية العامل. يفحص `file_edit` الملكية فوراً، ثم يعيد فحص كل ملفات
  `gitdiff.changes` قبل حذف worktree كي يفشل مغلقاً حتى لو غاب حدث أداة.
- **التعارض**: قبل إنشاء أي worktree تُرفض الملكيات المتداخلة تحفظياً بـ`ownership_overlap`؛
  الأنماط الغامضة ذات الجذر الثابت نفسه تُعد متداخلة لصالح الأمان. بعد التنفيذ يبني المنسّق
  خريطة الملفات الملموسة، وأي ملف يظهر لدى عاملين يسجّل `same_file` ويوقف الفريق. لا دمج
  تلقائي ولا commit؛ يبقى `merged:false` حتى تمر بوابة المراجعة والموافقة في الخطوة 4.
- **IPC والواجهة**: القنوات المنفصلة `satr:executionTeamStart/Stop/Extend/Latest` تتحقق من `cwd`،
  عدد العوامل، المهام، الملكيات، preset المهلة (`180|300|600` ثانية)، ومعرّف الفريق في `main.js`.
  الحدث `execution_team_update` (schema v1) يغذّي غرفة العمليات: إعداد عامل واحد افتراضياً
  حتى 3، وبطاقة لكل عامل تعرض المهمة والملكية والحالة والكلفة وميزانية الكتابة والفرق، والنشاط
  العام المنقّى فقط (`last_tool/last_file/last_activity_at/timeout_ms/deadline_at`) بلا مدخل أداة أو
  محتوى أو خرج خام، وتحذير تعارض وزر «إيقاف الكل».
- **التحقق**: `npm run test:executionteam` يغطي توازي ثلاثة عوامل في worktrees حقيقية،
  حصر الملكية fail-closed، رفض التداخل قبل الإنشاء، كشف لمس الملف نفسه دفاعياً، والمقاطعة
  الجماعية مع إزالة النسخ. يبقى `npm run test:worktrees` عقد عدم التراجع للعامل الواحد.

### مراجع ثانٍ ودمج بموافقة صريحة (الأولوية 6 — الخطوة 4)

- **أثر قابل للمراجعة**: قبل حذف كل worktree يستدعي `electron/worktrees.js` ‏`git add -N`
  داخل النسخة المؤقتة فقط ثم يلتقط `git diff --binary --full-index HEAD` بسقف 4MiB لكل عامل.
  يحتفظ `executor/executionteam` بالـpatch داخل العملية ولا يرسله في أحداث IPC؛ وبعد اكتمال الفريق
  تحفظه `opsartifacts.js` مشفّراً بالكامل عبر `safeStorage` إن كان متاحاً، وإلا يفشل الحفظ مغلقاً
  ويبقى الأثر في الذاكرة حتى الإغلاق فقط. الواجهة ترى الملفات والإحصاءات والحجم فقط. ملفات العوامل
  غير المتداخلة تُجمع في patch واحد، وتُشتق هويته
  بـ`sha256(head + '\0' + patch)` مع `producer_engines` مرتبة؛ أي تغير في الرأس أو الفرق يبطل المراجعات.
- **المراجعون العميان cross-engine**: `electron/reviewer.js` يختار السياسة الثابتة
  `[sdk]→[codex]` و`[codex]→[sdk]` و`[sdk,codex]→[sdk,codex]`. كل مراجع يعمل مستقلاً في cwd
  مؤقت فارغ لا يحوي جذر المشروع، ويستقبل قائمة الملفات والـpatch فقط بلا محادثة العامل أو هويته أو
  verdict مراجع آخر. يمرّر `permissionMode:'plan'` وصوراً وSkills وextra dirs فارغة و
  `browserControl:false`؛ و`codex.js` لا ينشئ MCP المعاينة عند هذه القيمة. وعند غياب نموذج صريح يثبّت
  `gpt-5.6-sol` بدلاً من وراثة default قديم غير مدعوم من إعداد Codex المحلي. كل طلب إذن يُرفض ثم يفشل
  الدور، وأي tool_use أو tool_result أو file_edit أو طرفية أو preview يوقف المراجعة fail-closed.
  الـdiff موسوم بيانات غير موثوقة لمقاومة prompt injection، سقفه 400k محرف، ويُرفض قبل الإرسال إن
  طابق حارس الأسرار المشترك في `memory.js`. كل verdict يحمل `artifact_id` نفسه، وغياب السطر الآلي أو
  فساده ينتج `changes_required` بمصدر `fallback`; يبقى `recommendation` alias عرض مؤقتاً.
- **preflight المحركات**: قبل `executionTeam.start` يتحقق `main.js` محلياً من وجود Claude SDK وCodex
  وتسجيل الدخول إليهما (أو مفتاح البيئة الموافق). أي غياب يعيد `review_engine_unavailable` قبل إنشاء
  worktree أو استهلاك دور؛ لا fallback إلى عائلة المنتج. Codex ما زال محظوراً من executor وفق نتيجة 3A.
- **بوابة الدمج**: `electron/merger.js` لا يعمل إلا بـ`confirmed:true`، ويتحقق أن المستودع نفسه،
  و`HEAD` ما زال يساوي رأس إنشاء worktrees، وشجرة العمل/الفهرس نظيفان. يكتب patch مؤقتاً تحت
  `~/.satr/merge` ثم يشغّل `git apply --check` قبل `git apply` بمصفوفة وسائط بلا shell. لا force
  ولا rebase ولا commit ولا حذف تاريخ؛ التعارض أو تغيّر HEAD أو شجرة غير نظيفة يُرفض قبل الكتابة.
  النجاح يطبق الفرق على شجرة العمل فقط ليظل قابلاً للمراجعة والالتزام اليدوي.
- **الموافقة والعقد**: القنوات المنفصلة `satr:executionReviewStart/Stop/Latest` و
  `satr:executionMerge` منقّاة في `main.js`. الدمج يتطلب مجموعة مراجعات مكتملة ومعرّفها مطابقاً للفريق،
  وكل المراجعات المطلوبة مرتبطة ببصمة artifact الحالية وأحكامها `approve`،
  ثم `confirmed:true` في `main.js` ومرة ثانية في `merger.js`. لوحة `/تنفيذ-معزول` تشغّل المراجع
  بعد اكتمال الفريق، تعرض بطاقة مستقلة لكل محرك وحكمه، ولا تُظهر زر «دمج» إلا لحكم aggregate
  `approve`. بوابة `reviewer.mergeGate` تعيد حساب المطلوب من `producer_engines` وتمنع
  `changes_required` و`reject` وfallback والمراجعة الناقصة أو بصمة مختلفة؛ لا يجاوزها تأكيد المستخدم.
  الزر نفسه يعرض confirm عربياً صريحاً. لا دمج تلقائي في أي مسار.
- **التحقق**: `npm run test:reviewmerge` يغطي مصفوفات المنتجين الثلاث، استقلال البرومبتات، cwd فارغاً
  ومحاولة قراءة Codex الصامتة، وضع plan وتعطيل المتصفح، وفشل SDK/Codex عند الإذن/الأداة/الكتابة/
  الطرفية/preview/المهلة، وربط الأحكام بالبصمة، وaggregate approve فقط عند موافقة الجميع،
  رفض الدمج بلا تأكيد، تعارض `git apply --check` مع بقاء الشجرة نظيفة، ثم تطبيقاً صحيحاً يثبت
  بقاء `HEAD` والفرع والتاريخ بلا تغيير. اختبارات `worktrees/executionteam` تثبت عدم التراجع.

#### هيئة القضاة — ثلاث زوايا لكل محرك (الجولة السادسة، النواة)

تحويل المراجعة العمياء من **عقدة واحدة لكل محرك** إلى **ثلاث عقد زوايا متوازية**، مع تقرير
مدموج يُبنى كوداً ونموذج اختياري لكل عقدة. `mergeGate` و`aggregateVerdict` على مستوى الدفعة
وبوابة الدمج البشرية **لم تتغيّر حرفاً**.

- **الزوايا الثابتة**: `LENSES = ['correctness','security','simplicity']` («الصحة»/«الأمان»/
  «التبسيط»). مصفوفة `requiredReviewEngines` لم تتغيّر؛ كل محرك مطلوب يشغّل الزوايا الثلاث،
  **كل زاوية في عزلة `mkdtemp` مستقلة وبمهلتها الخاصة** وبسياسة العمى نفسها حرفياً (وضع
  `plan`، صفر أدوات، رفض كل إذن، `FORBIDDEN_EVENTS` كما هي). أقصى عدد عقد تشغيل = 3 زوايا ×
  2 محركين = **6** (كلفة موثّقة؛ لا توسعة زوايا في هذه الدفعة).
- **برومبت الزاوية** = البرومبت الأعمى القائم حرفياً + فقرة تركيز الزاوية + تعليمة وسم البنود.
  البرومبت لكل زاوية **واحد يتشاركه المحركان** فيبقى العمى cross-engine كما كان.
- **تجميع حكم المحرك fail-closed** (`aggregateLensVerdict`): أي زاوية غير `completed` ⇒
  `{changes_required, fallback}`؛ وإلا أسوأ قرار (`reject > changes_required > approve`)،
  و`source='explicit'` فقط إن كانت **كل** الزوايا explicit. و`aggregateLensState`:
  `completed` فقط باكتمال الثلاث، وإلا الأسوأ `failed > timed_out > stopped > running`.
  **تغيّر مقصود**: بند محرك طرفي غير مكتمل كان `verdict:null` فصار يحمل الحكم المجمَّع
  الصريح؛ `mergeGate` لا يتأثر لأنه يفحص `state === 'completed'` أولاً. حكم **الزاوية** نفسها
  يبقى `null` إن لم تكتمل، وبند المحرك يبقى `null` ما دام `running`.
- **التوسعة additive في `execution_review_update`** (لا حذف ولا تغيير حقل قائم): بند المراجع
  يضيف `lenses:[{lens,state,summary,verdict|null,duration_ms,cost}]`، و`item.summary` يدمج
  ملخصات الزوايا بعناوين `## <التسمية العربية>` (محلل `reviewSections` في renderer يبقى عاملاً).
  والدفعة تضيف `merged_report:{schema_version:1,items:[{severity,lens,engine,text}],truncated}|null`.
- **التقرير المدموج يُبنى كوداً لا بعقدة LLM**: `parseRiskItems` يستخرج بنود
  `[risk: critical|high|medium|low]` من **خرج المراجع**، والوسم مقبول **أول السطر فقط** (بعد
  فراغ بادئ لا غير — لا شرطة ولا رمز قائمة، ولا وسم في منتصف سطر)، وخطورة خارج الأربع تُرفض،
  والبنود بلا وسم تبقى نصاً في الأقسام ولا تدخل التقرير (لا تخمين severity). الترتيب
  `critical→high→medium→low` ثم بترتيب `LENSES` ثم ترتيب المحركات، وسقف
  `MAX_MERGED_ITEMS=60` و`MAX_ITEM_TEXT_POINTS=500` نقطة Unicode بعد إزالة تحكم/Bidi وطي
  الفراغات؛ أي بند يلتقطه `memory.hasSecret` **يُسقط كلياً**، و`truncated=true` عند أي قص أو
  إسقاط. يُبنى مرة واحدة عند بلوغ الدفعة حالة طرفية ويُخزَّن.
  **حاجز أمني مثبَّت**: الـdiff بيانات غير موثوقة وقد يزرع أسطر `[risk:…]` داخل محتواه؛ المحلل
  يقرأ خرج المراجع لا الـdiff، ويثبت الاختبار أن وسماً مزروعاً في الفرق يصل البرومبت ولا يصل
  التقرير إطلاقاً.
- **نموذج لكل عقدة (‏`models` — اختياري backward-compatible)**: `satr:executionReviewStart`
  يقبل `models:{sdk?,codex?}` لعقد الزوايا، و`satr:executionTeamStart` و`satr:loopStart`
  يقبلان `models:{worker?}` لعامل sdk. التنقية في `main.js` حصراً عبر `sanitizeOpsModels`
  بـ`SAFE_MODEL` القائم: الغياب أو الكائن الفارغ = السلوك القائم حرفياً (‏`resolveOpsRoomModel`:
  env ثم الافتراضي)، ومفتاح غير معلن أو قيمة لا تطابق `SAFE_MODEL` ⇒ `bad_input` **لا تجاهل
  صامت**. قيم البيئة لا تصل renderer كما كانت. `preload` يضيف معاملاً أخيراً اختيارياً في
  الدوال الثلاث فتبقى الاستدعاءات القائمة صالحة حرفياً. التخزين في الواجهة
  (`satr_ops_models::<cwd>`) ولا تخزين في main.
- **توسعتان additive معلَّمتان**: `executionteam.start` يقبل `input.model` و`looprunner.start`
  يقبل `payload.model`، وكلاهما يبني runner بديلاً بنفس `engine`/`start` ونموذج مختلف؛ الغياب
  = المحرك المحقون كما هو، وصفر تغيير سلوكي (‏`test:executionteam` و`test:loop-mode` خضراء بلا
  تعديل ملفيهما).
- **التحقق**: `npm run test:reviewmerge` توسّع — لا سكربت جديد. كل فحوص الأمان القائمة بقيت
  وتوسّعت من «النداء الأول» إلى **كل عقدة زاوية**: العمى (لا هوية عامل في أي برومبت)، العزل
  (مجلد مؤقت خاص لكل زاوية، فارغ إلا من `workspace`، ويُحذف)، fail-closed (إذن/أداة/حدث محظور
  يفشل الزوايا الثلاث)، عدم تسريب patch أو سر، وبوابة `mergeGate` كاملة. وأُضيف: عدد الزوايا
  وهويتها وتمايز برومبتاتها، تجميع الحكم والحالة، شكل `lenses[]`، المحلل، ترتيب/سقوف/إسقاط
  السر في `merged_report`، الوسم المزروع في الـdiff، وتمرير `models` وقيمته الفاسدة.
  ملاحظة تنفيذ مثبَّتة: عقد الزوايا تتسابق على `mkdtemp` فترتيب `calls` غير حتمي عبر المحركات؛
  الاختبار يُسند كل نداء إلى زاويته من فقرة التركيز داخل برومبته بدل الاعتماد على الفهرس.
- **الاختبار الخصومي المستقل**: `npm run test:review-panel` (قطعي، بلا شبكة) يهاجم عقد الزوايا
  والتقرير المدموج والنماذج من الزوايا التي لا يغطيها `test:reviewmerge`: حقن severity من الـdiff،
  فيض بنود 500+، أسرار K5 في البنود، قص Unicode خصومي بمحارف surrogate/RTL/Bidi، severity مشوهة
  (بما فيها حالة الأحرف — `RISK_LINE` حساسة للحالة كما يطبّقها الكود الحقيقي)، التجميع fail-closed
  عند timed_out، النموذج بمحارف حقن، والتوافق الخلفي لحدث بلا `lenses`/`merged_report`.

### التحقق التكاملي قبل الدمج (غرفة العمليات — المرحلة 5)

- **preflight أو مسودة نهائية**: المسار القابل للدمج يقرأ `.satr/verify.json` حصراً من blob ‏Git عند
  `HEAD` قبل إنشاء عوامل أو استهلاك دور. غياب الملف أو فساده يعيد `verification_config_required` مع
  إرشاد عربي، بلا اكتشاف تلقائي لـ`npm test` أو أي script. يمكن لعامل واحد العمل بوضع `draft` بلا
  الإعداد أو محرك المراجعة الآخر، لكنه يعلن `merge_supported:false` منذ البداية ولا يقبل الترقية؛
  الدمج يتطلب فريقاً جديداً قابلاً للدمج. معالج الإنشاء يساعد المستخدم في كتابة الملف داخل شجرة
  العمل فقط؛ لا يغيّر هذا العقد ولا يضيفه إلى Git أو `HEAD` تلقائياً.
- **تثبيت المصدر والتأكيد**: `electron/integration.js` يعيد الأوامر المنقّاة من
  `artifact.head:.satr/verify.json` للعرض فقط، ثم يتطلب `confirmed:true` مستقلاً لتشغيل snapshot نفسه.
  لا IPC يقبل command أو اختيار check من renderer أو نموذج. `electron/verify.js` يعيد استخدام parser
  الواحد (≤64KiB، ≤6 أوامر، سطر واحد، مهلة ≤600 ثانية)، ويشغّل كل أمر بصدفة نظام محددة داخل cwd
  التكاملي مع مهلة وذاكرة خرج مجمعة ≤64KiB.
- **worktree تكاملي**: `electron/worktrees.js` ينشئ detached worktree من `artifact.head` المحدد،
  ويفحص patch عبر `git apply --numstat -z` لمنع لمس `.satr/verify.json`، ثم ينفذ
  `git apply --check` قبل `git apply`. كل أوامر Git بمصفوفة وسائط بلا shell، والـpatch مؤقت داخل مخزن
  «سطر». النجاح والفشل والمهلة والمقاطعة تنظف worktree؛ فشل التنظيف يقلب النتيجة إلى `failed`.
- **«شاهدها تعمل» دورة مستقلة**: الحقل الاختياري `preview` في `.satr/verify.json` يُقرأ من
  blob ‏`artifact.head` نفسه، ولا يقبل IPC أمراً من renderer. `preparePreview` لا يستدعي `run()` ولا
  يغيّر نتيجته؛ يشترط تحققاً `passed` للبصمة نفسها و`confirmed:true`، وينشئ worktree جديداً ويطبق
  الأثر مع حظر ملف الإعداد نفسه، ثم يبدأ الأمر عبر `termjobs` في تبويب 🛠 وينتظر العنوان المحلي ضمن
  المهلة. المعاينة الحية واحدة فقط؛ الثانية تعيد `busy`. تستخدم `{recordDevServer:false}` كي لا
  يسجل المسار المؤقت في `devservers`، ولا يحمل حدث `bg_term` مسار worktree. الإيقاف، والدمج الناجح،
  وبدء فريق جديد، وإغلاق التطبيق توقف المهمة ثم تحذف worktree قبل قتل الطرفيات. فشل أي إزالة يبقى
  `cleanup_failed` صريحاً وقابلاً لإعادة محاولة التنظيف.
- **النتيجة والبوابة**: النتيجة العامة محصورة في
  `{artifact_id,state,checks:[{id,label,passed,exit_code,timed_out,duration_ms}]}` بلا command أو خرج
  خام أو أسرار. `merger.js` يرفض العمل إلا مع بوابة مراجعات `approve` ونتيجة `passed` للبصمة نفسها
  وتأكيد الدمج، ثم يطبق حراس HEAD ونظافة الشجرة و`git apply --check` السابقة بلا commit أو push أو
  rebase أو تغيير history.
- **IPC والواجهة**: القنوات `satr:executionVerificationPrepare/Run/Stop/Latest` و
  `satr:executionPreviewStart/Stop` محددة في preload؛ الأولى تنقّي الفريق/الأثر والتأكيد و`cwd`
  وترفض وجود `command` في الحمولة. لوحة التنفيذ تعرض الأوامر المثبتة أولاً وزر تشغيل مستقل، وتظهر
  «🖥 شاهدها تعمل» بعد نجاح تحقق الأثر نفسه. فتح المعاينة مساعد ثقة فقط: شرط الدمج بقي مراجعات
  `approve` + تحقق `passed` للبصمة نفسها، سواء شُغّلت المعاينة أم لا.
- **الاختبار**: `npm run test:integration` يستخدم مستودع Git حقيقياً لنجاح/فشل/مهلة/مقاطعة، غياب
  الإعداد، رفض بلا تأكيد، رفض تعديل الإعداد داخل patch، تبدل artifact، تنظيف كل worktree، منع تسريب
  الخرج، وبقاء المصدر بلا لمس حتى الدمج الصريح. اختبارات `verify/worktrees/reviewmerge/executionteam`
  و`eval:agent` عقود عدم تراجع إلزامية.

### «راجع تغييراتي الآن» — المراجعة العمياء من المحادثة (2026-08-25)

- **لماذا**: جولة عصف ثلاثي (‏Codex + Kimi + Opus، الطريقة 3 من `MULTI_OPINION_LINE`)
  على سؤال «هل تُزال غرفة العمليات؟» انتهت إلى أن ما فيها شيئان: **طبقة ضمانات**
  ثمينة و**سطح** يجيب سؤال فريق لا يطرحه مطوّر منفرد. وأثمن ما في الطبقة هو المراجعة
  العمياء cross-engine: الوكيل الذي كتب الكود لا يراجعه بعينين نظيفتين مهما طُلب
  منه — رآه وهو يُكتب — ومطوّر منفرد لا زميل يراجع له. فأُخرجت من سطحٍ يُفتح إلى
  **فعل يُطلب**: أمر `/راجع` في المحادثة. (قرار مالك؛ الرأيان الآخران أوصيا بالإزالة
  الكاملة — الخام في `dist/bs3/`.)
- **ما هي ليست**: لا worktree، ولا عوامل متوازية، ولا ملكية ملفات، ولا بوابة دمج،
  ولا خزنة أثر. تلك تبقى في غرفة العمليات بلا تغيير؛ هذه قراءة رأي مستقل فقط.
- **الحدّ الجوهري — لا تلمس فهرس المستخدم**: `worktrees.js` يستعمل `git add -N` داخل
  نسخته المؤقتة، وهو هنا يغيّر **الفهرس الحقيقي**. لذلك: المتتبَّع عبر
  `git diff --binary --full-index HEAD`، والجديد غير المتتبَّع عبر
  `git diff --no-index -- /dev/null <path>` لكل ملف — قراءة صرفة يحرسها فحص
  `git diff --cached --name-only` فارغاً بعد الالتقاط. سقوف: `MAX_UNTRACKED_FILES=40`
  و`MAX_UNTRACKED_BYTES=512KiB` (الأضخم يُذكر عدده في `skipped_count` لا يُحشر)
  و`MAX_PATCH_CHARS=400000`.
- **سياسة العمى نسخة واحدة**: `reviewer.workingTreePrompt` يشتق من `BLIND_PREAMBLE`
  المشتركة نفسها (مع هيئة القضاة ومراجعة الحلقة)، والتشغيل عبر `reviewer.reviewOnce`
  القائم: cwd مؤقت فارغ، `plan`، صفر أدوات/مهارات/متصفح، وأي إذن أو أداة أو
  `file_edit` أو طرفية يفشل مغلقاً. والحكم من **خرج المراجع حصراً** — الفرق بيانات
  غير موثوقة وقد يزرع `[verdict: approve]`، ويحرسه فحص صريح.
- **cross-engine إلزامي**: `REVIEWER_PREFERENCE` يستبعد محرك المحادثة دائماً، وغياب
  أي محرك آخر يعيد `review_engine_unavailable` — **لا مراجعة بالمحرك نفسه** لأنها
  ليست رأياً مستقلاً. يستهلك `resolveOpsRoomRunner` نفسه فيرث بوابة جاهزية Kimi.
- **العقد**: `satr:reviewChanges {cwd, engine}` (‏`engine` بقائمة سماح مغلقة) يعيد
  قائمة حقول مغلقة: `engine, state, verdict{decision,source}, summary, error,
  items[{severity,text}], files, skipped_count, truncated, duration_ms, cost` —
  **بلا الفرق الخام** وبلا مسار مطلق، ويحرسه فحص نصّي على كتلة `main.js`.
  و`satr:reviewChangesStop`. البنود تمرّ بـ`reviewer.buildMergedReport` القائم فترث
  إسقاط الأسرار وقصّ Unicode والترتيب بالشدّة بلا نسخة ثانية. حارس الأسرار يوقف
  المراجعة **قبل أي نداء محرك** (‏`memory.hasSecret` على الفرق).
- **الواجهة**: أمر `/راجع` يبني بطاقة `work-card` في المحادثة نفسها (بلا سطح ولا
  ورقة أنماط جديدة): الحكم بالعربية، أهم ثلاثة بنود مخاطر، والتفاصيل بالطيّ.
- **التحقق**: `npm run test:reviewchanges` (قطعي بمستودع git حقيقي) يغطي الالتقاط
  المزدوج، **نظافة الفهرس**، الملف الضخم، `no_repo`/`no_head`/`no_changes`، اختيار
  cross-engine وfail-closed، العزل ووضع plan، الأداة تفشل المراجعة، الحكم المزروع،
  حجب السر قبل النداء، وقوائم حقول `main.js`/`preload`. وهو داخل `test:opsroom-all`
  فـ`test:full`.

### سجل القرارات والأدلة (غرفة العمليات — المرحلة 6)

- **التخزين والعقد**: `electron/opsroom.js` يحفظ كل غرفة في
  `~/.satr/opsroom/<room_id>.json` بـschema v1: `room_id` ومصفوفة `entries` فقط. الكتابة ذرية
  `temp→rename`، والقراءة تعيد تنقية الملف كاملاً. السقف 200 إدخال و512KiB للملف و1000 محرف للنص؛
  عند بلوغ السقف يُرفض الإدخال الجديد ولا يُحذف قديم، لذلك يبقى السجل append-only فعلياً عبر إعادة التشغيل.
- **فصل السلطة fail-closed**: للمحرك مدخل `appendEngine` لا يقبل إلا `proposal|note` ويثبت actor إلى
  `sdk|codex`. قرار المستخدم يمر حصراً عبر `appendUserDecision` ثم IPC
  `satr:opsRoomDecision {roomId,text,teamId,artifactId?,confirmed:true}`؛ أي `id/type/actor` وارد من
  renderer يُرفض، وكذلك غياب التأكيد. النظام وحده يسجل `review|verification|phase_gate|note` عبر
  `appendSystem`. لا API حذف أو تعديل، ولا تحمل النواة runner أو merger أو أي قدرة تشغيلية.
- **التنقية والحجب**: `room_id/entry.id/team_id/artifact_id` تخضع regex صارماً في `main.js` والنواة.
  النص يزال منه محارف التحكم ويُقتطع، مع إعادة استخدام `memory.hasSecret` قبل الكتابة؛ patch markers
  والحمولات الأطول من 64KiB تُرفض. أحداث `ops_room_update` العامة تحمل الإدخال المنقّى فقط، ولا تحمل
  patch أو summaries أو commands أو output خاماً.
- **الربط بالانتقالات**: `executionteam.js` ينشر `room_id` مع snapshot الفريق والأثر فقط، بلا منطق سجل.
  `main.js` ينشئ الغرفة عند بدء الفريق ويسجل مهام العوامل المنقّاة، وكل نهاية فعلية للفريق
  (`completed|failed|timed_out|stopped|conflict|cleanup_failed`) مع taxonomy من رموز ثابتة بلا
  `stderr` خام، وجاهزية الأثر، وكل حالة فعلية مميزة للمراجعة والتحقق، ثم `phase_gate` نظامية بعد
  نجاح الدمج الفعلي؛ كل entry ترتبط بـ`team_id` وبـ
  `artifact_id` متى أصبح متاحاً. السجل سلبي ولا يبدأ مراجعة أو تحققاً أو دمجاً بذاته.
- **IPC والاختبار**: القراءة عبر `satr:opsRoomLoad(roomId)` والقرار المؤكد عبر
  `satr:opsRoomDecision(...)` في preload. `npm run test:opsroom` يستدعي النواة الفعلية وعقد
  `executionteam` لإثبات persistence، append-only والسقوف، رفض انتحال قرار/مستخدم/بوابة مرحلة، حجب
  الأسرار والـpatch والخرج الطويل، التنقية الصارمة، وربط room/team/artifact بلا تسريب الفرق.
- **الفهرس والاستمرارية**: `opsroomindex.js` يحفظ `room/team/state/artifact` حسب بصمة SHA-256
  داخلية للمسار ولا يعيد البصمة أو المسار إلى renderer. عند الإقلاع تتحول حالات
  `preparing|running|stopping` القديمة إلى `interrupted`. قنوات `satr:opsRoomHistory` و
  `satr:opsRoomRestore` و`satr:opsRoomArtifactDelete` تتحقق من cwd والغرفة والأثر والتأكيد؛
  الاستعادة تعيد فريقاً مكتمل الأثر إلى الذاكرة لكن تصفّر المراجعة والتحقق، فلا يُعاد استعمال دليل قديم.
- **خزنة الأثر**: الملف المشفّر ذري ومفصول ببصمة المشروع وبسقف 18MiB، والـpatch حتى 12MiB، وتُعاد مطابقة
  `sha256(head+'\0'+patch)` وكل المراجع والمسارات بعد فكّه. لا fallback صريح عند غياب التشفير.
  يُحذف الأثر بعد الدمج أو بطلب مستخدم مؤكد، وتزيل سياسة الاحتفاظ ما تجاوز 30 يوماً أو أحدث 50 أثراً.
  ولأن البصمة مشتقة من HEAD+patch فقد تتشاركها غرف عدة (صقل أ‑1 البند 29): كل حذف — بعد
  الدمج أو يدوياً أو بالاحتفاظ — يعلّم عبر `markArtifactsUnavailable` كل مدخلات الفهرس
  المتشاركة البصمة غير قابلة للاستعادة، وفشل `opsartifacts.load` عند الاستعادة بغياب/فساد
  الملف يعلّمها دفاعاً ثانياً؛ وإن أعادت غرفة حية حفظ الأثر من ذاكرتها يعود مدخلها صادقاً.
  `npm run test:opscontinuity` يغطي غياب التشفير والعبث والفهرسة والاستعادة والتسوية والاحتفاظ.

### واجهة غرفة العمليات (المرحلة 7)

- **السطح: «المسار الموجّه» (الدفعة ب — تصميم معتمد 2026-08-09، مراحله في
  docs/OPS-ROOM-GUIDED-PATH-PROPOSAL.md)**: منذ ب‑1/ب‑2 لم تعد اللوحة أقساماً بحسب نوع
  البيانات؛ سطحها شريط خمس محطات تفاعلي (إعداد ← تنفيذ ← مراجعة ← تحقق ← دمج) مشتق
  حصراً من `deriveStations` النقية في `ops-room-state.js` (✓ منجزة/● حالية/⚠ تنبيه —
  إيقاف المستخدم ليس تنبيهاً، والمراجعة غير الموافقة تبقي محطتها الحالية). النقر على
  محطة منجزة/حالية يعرض قسمها (tasks/review/evidence/diffs) واللاحقة تعرض نص البوابة
  (ومنذ ب‑3 تصمت لغير الدمج حين يحمل شريط الفعل السفلي الخطوة — لا ازدواج)؛
  العرض يتبع المحطة الحالية ويحترم الاختيار اليدوي حتى انتقال حالة. «المزيد ⌄» يضم
  التاريخ (يتصدر ويظهر بنقرة واحدة — بند 17) والقرارات والنقاش، و«🧠 عصف» زر في بطاقة
  الإعداد. التبويبات القديمة وشاراتها وتفضيلات group/views حُذفت نهائياً في ب‑2 (قرار
  مالك)؛ تفضيلا العرض/الطي باقيان، وسطر الحالة يصمت في الغرفة الفارغة (شريط الفعل يحمل
  الإرشاد) ويُحجب صفه بلا رسالة. تحت 44rem تتكدس المحطات عمودياً.
  أحداث السجل الحية تدخل الخيط كبطاقات inline مطوية عبر `chat.showOpsEvent` و`cardSheet` المشتركة.
  تأكيد بدء التنفيذ وتشغيل الاختبارات والدمج يمر عبر `satr-ops-dialog` الحاجب؛ التنبيهات غير
  القرارية تبقى في `status`/الإشعارات ولا تحمل سير قرار.
- **الدخول والإعداد**: كل رسالة مستخدم تحمل زر «🏗 نفّذ في غرفة العمليات»؛ القشرة تفتح السطح عبر
  `surfaceCoordinator` ثم تمرر نص الرسالة إلى method عامة `seedTask` بعد الفتح. المكوّن لا يقرأ
  حالة الدردشة، والبذرة نص فقط: لا session ولا استئناف ولا تشغيل تلقائي. الفريق الجديد يبدأ بعامل
  واحد افتراضياً لمسار «تنفيذ معزول ← مراجعة ← تحقق ← شاهدها تعمل ← دمج»، بينما 2–3 عوامل خيار
  متقدم. «إعادة المحاولة بفريق جديد» وحدها ترث عدد الفريق والمهام والملكيات والمهلة السابقة.
- **صقل أ‑1 «لا طريق مسدود» (2026-08-09)**: لا حالة طرفية بلا فعل تالٍ — الفريق المدموج
  يقدّم `nextAction.action='start'` وزر «ابدأ مهمة جديدة» بنموذج نظيف (وراثة نموذج
  «إعادة المحاولة» محصورة بالعقد المصدّر `INHERIT_TEMPLATE_TEAM_STATES`: فشل/مهلة/
  إيقاف/تعارض/فشل تنظيف)؛ ومراجعة طرفية بلا أحكام مكتملة (`stopped/failed/timed_out`)
  تعيد فتح `canReview` للأثر نفسه بينما المراجعة `completed` غير الموافقة تبقى نهائية؛
  و`errorLabel` يميز انقطاع IPC ‏(`result==null`) ويذيّل الرمز غير المترجم ويترجم
  `bad_patch/read_failed`؛ وزر «🔧 أصلح بالملاحظات» لا يُنشأ بلا بنود حرجة/مرتفعة؛
  وعنوان «أُوقِف الدور» في الدردشة محروس من نتيجة أداة متأخرة. يحرسها test:opsroom-ui
  وtest:chat-rtl ومشهد ui:audit ‏42.
- **صقل أ‑2 «كلام بشري» (2026-08-09)**: `src/ui/lib/lifecycle-labels.js` (ملك القائد)
  الخريطة العربية الواحدة + `countLabel` (تصريف العدد) + `truncateWords` (قص بنقاط
  Unicode) — تستهلكها ops-room.js (كل الحالات المعروفة معرّبة والمجهولة «حالة غير
  معروفة»، لا توكن إنجليزياً خاماً) وchat.js (بطاقة `showOpsEvent`: عنوان عربي وحالة من
  الخريطة وملخص بلا تكرار؛ النصوص العربية السياقية القائمة — checkpoint والمهام المؤنثة —
  بقيت عمداً أدق من الخريطة). ومعها: مراجعة موقوفة «أوقفها المستخدم قبل اكتمال الأحكام»
  لا حكماً (27)؛ بصمة الأثر بادئة 12 محرفاً والكاملة خلف التفاصيل (19)؛ صف التاريخ بشري
  (مقتطف المهمة + فريق/حلقة + وقت ميلادي لاتيني LTR — الحقلان الاختياريان
  `task_excerpt`/`run_kind` في مدخل `opsroomindex` بتنقية fail-closed تسقط الحقل لا
  المدخل، وschema يبقى v1) (30+4)؛ إسقاط metadata الفارغة وتوحيد الفاعل (5+12)؛ رسالة
  بوابة الدمج ديناميكية بما تبقى فقط (13)؛ عزل `code` التقني LTR في رسائل الحالة (16)؛
  إرشاد واحد يختفي عند اكتمال الشروط (3)؛ افتراضي «السجل» التاريخ (17)؛
  و`verify.exitLabel` يترجم أكواد NTSTATUS المعروفة (‏`-1073741510` إيقاف مقصود بلا ⚠️)
  إلى `exit_label` ‏additive في صفوف checks (23)، و`satr:devServerInfo` يعيد
  `integration_preview:true` فتقول شارة المعاينة «معاينة تكاملية مؤقتة تعمل» (20).
  يحرسها test:opsroom-ui وtest:chat-rtl وtest:opscontinuity وtest:integration.
- **الحقيقة والبوابات**: `src/ui/lib/ops-room-state.js` reducer نقي هو مصدر اشتقاق حالات الأزرار.
  لا يظهر الدمج إلا إذا اكتملت كل `required_review_engines` بحكم `approve` صريح لنفس
  `artifact_id` ونجح التحقق للبصمة نفسها. أي verdict أو verification قديم يغلق البوابة. المكوّن
  لا يبدأ المراجعة أو التحقق تلقائياً؛ كل انتقال من نقرة مستخدم ويستدعي IPC الخلفي الفعلي.
- **وضوح التشغيل بعد التجربة الحية**: reducer يشتق `nextAction` حتمياً من البوابات نفسها، والسطح
  يعرض زر تشغيل رئيسياً واحداً مأخوذاً منه ومقيّداً بعلم `can*` الموافق بلا تشغيل تلقائي. «إيقاف»
  يبقى بجانب حالة الانتقال الجاري، و«تمديد» بجانب تحذير العدّاد؛ فلا يختبئان في قائمة. مؤشر
  «الإعداد/التنفيذ/التحقق/الاعتماد» وصفي فقط ولا يفتح انتقالاً. بطاقات العوامل تعرض آخر أداة مسموحة ومساراً نسبياً منقّى والوقت
  المتبقي ومدة التنفيذ وميزانية الكتابة، بلا نسبة إنجاز تخمينية. `last_activity_at` يصف نشاط أداة
  أو ملف قابلاً للرصد فقط، لا التفكير النصي؛ بعد دقيقة بلا حدث جديد تقول الواجهة صراحةً «لم يصل
  نشاط أداة أو ملف قابل للرصد» ولا تدّعي أن العامل عالق أو متوقف. نموذج البدء يختار مهلة 3/5/10 دقائق، وتتحقق
  العملية الرئيسية والنواة من preset قبل إنشاء worktree. خلال الدقيقة الأخيرة يظهر تحذير وزر تمديد صريح لمرة
  واحدة فقط إلى preset التالي، ولا يتجاوز السقف المطلق 10 دقائق ولا يحدث أي تمديد تلقائي.
- **التعافي وكثافة السطح**: الأخطاء العامة تستخدم `failure_code` ثابتاً ورسالة آمنة بلا `stderr`
  خام، وتعرض البطاقة إرشاد تعافٍ خاصاً بالسبب. الفريق النهائي يعيد تعبئة المهام والملكيات والمهلة
  في نموذج «إعادة المحاولة» لكنه يبدأ فريقاً جديداً من `HEAD` ولا يدّعي استئناف session/worktree.
  اللوحة قابلة لتغيير العرض بمقبض `separator` مخصص على حافتها اليسرى: السحب يزيد العرض باتجاه
  اليسار، وتدعم لوحة المفاتيح `ArrowLeft/ArrowRight/Home/End` وفق موضع اللوحة في RTL. تُقيد
  القيمة رقمياً ثم تمر عبر ورقة `adoptedStyleSheets` مستقلة، لا `style=`. الطيّ الحقيقي يقلّص
  `width/min-width/max-width` إلى شريط token ضيق يعيد مساحة الدردشة وينقل التركيز إلى زر الفتح.
  المضيف عنصر flex نسبي داخل `#midRow` وشقيق `#chatColumn`، لذلك يبقى محصوراً بين الهيدر والطرفية ويستخدم ظل
  dock مستقلّاً أخف في الوضع الفاتح عبر `--shadow-dock` بدلاً من ظل اللوحات العائمة.
  يُحفظ العرض والطيّ والقسم والعرض الفرعي لكل مشروع في `localStorage`. تحت `44rem` تتحول اللوحة
  إلى drawer كامل العرض مع `role=dialog` و`aria-modal`، ويصبح `#chatColumn` كله `inert` حتى الإغلاق
  واستعادة التركيز. تُحجب المعاينة مؤقتاً إطاراً وحدوداً أصلية إن كانت مفتوحة، ويختفي السحب والطيّ
  حتى العودة لسطح المكتب.
  الإشعارات الداخلية محصورة في نهايات التنفيذ والمراجعة والتحقق.
  `npm run test:opsroom-ui-live` يشغّل المكوّن الحقيقي داخل Chromium ويغطي النشاط الحديث والهادئ
  وانتهاء المهلة وإرشاد التعافي وبذر المهمة وافتراضي العامل الواحد ومنع تكرار الإشعار تحت CSP الفعلية.
- **العصف الثلاثي الاختياري (‏OBS-012 بند ب — 2026-08-24)**: `REQUIRED_ENGINES` هما
  SDK وCodex (غياب أيّهما ⇒ `brainstorm_engine_unavailable`)، و`OPTIONAL_ENGINES` هي
  `kimi-code` — تنضم رأياً ثالثاً حين يعيد `resolveOpsRoomRunner` مشغّلاً، وتُتخطّى
  **بصمت** إن لم تفعل (غياباً أو رمياً). الاختيارية مقصودة: جعل Kimi إلزامياً كان
  سيُسقط الميزة عن كل من لم يثبّته — سلبُ قدرة قائمة ثمناً لقدرة جديدة. بوابة
  الجاهزية `kimi.resolveKimiBin() && kimi.authStatus().ok` **قرص فقط بلا إطلاق
  عملية** (بخلاف فحص Codex الذي يكلّف ~1.4ث — `OBS-043`). البرومبت يسمّي المستشار
  بتسمية بشرية (`ENGINE_LABELS`) ولا يذكر محرّكاً آخر فيبقى العمى المتبادل.
  و`resolveOpsBrainstormRunner` يحقن **`keepAlive:false`** لمشغّل Kimi: رأي العصف
  لقطة واحدة لا جلسة، فلا يحجز أحد مقعدَي K2 ولا يطرد جلسة المستخدم الخاملة. العلم
  صريح أحادي الغرض **ولا يُشتق من `browserControl`** — تلك علامة كشف الأدوات لا عمر
  العملية، وتحميلها معنى ثالثاً يخلط محورين (أمسكه `test:kimi` عند أول محاولة).
- **العصف والتقسيم الاقتراحي**: عرض العصف داخل قسم «العمل» يرسل brief منقّى إلى المحرّكات بصورة مستقلة ومربوطة
  بالمشروع الحالي؛ لكل
  محرك cwd مؤقت فارغ و`plan` وSkills/صور/extra dirs فارغة و`browserControl:false`. ويُشغّل SDK
  بعقد بنيوي `tools:[]` ومن دون setting sources أو حفظ جلسة. أي إذن أو أداة
  أو tool_result أو كتابة أو طرفية أو preview يفشل المستشار، ولا يرى أحدهما رأي الآخر. عند وجود غرفة
  تسجّل الخلاصات المقبولة كـ`proposal` بسلطة المحرك. مخطط التقسيم يستخدم SDK فقط داخل worktree
  مؤقت من `HEAD` بعقد SDK بنيوي لقائمة `Read|Grep|Glob` فقط، ومن دون setting sources أو حفظ جلسة،
  وبمسارات محصورة، ويرفض symlinks/submodules عبر حارس
  worktrees نفسه وينظف النسخة على كل نهاية، ثم لا يعيد إلا JSON منقّى لـ1–3 مهام وملكيات غير متداخلة لملء
  النموذج؛ لا يبدأ التنفيذ. `npm run test:opsadvisor` يغطي العزل ومنع الأدوات والمسار الخارجي والتداخل.
- **منسّق الأسطح**: `surfaceCoordinator` في `app.js` يسجل `active|held|hidden`، ويستبدل اللوحة
  الرئيسية الحالية، ويحفظ مصدر الفتح ويعيد التركيز. الحوارات تضع المعاينة الأصلية في `held`
  عبر `preview.holdForDialog(true)` ثم تعيدها بقياس حي، ولا تحاول رفع DOM فوق WebContentsView.
  `#chatColumn` يجمع `satr-chat` و`satr-composer` كعمود flex وحيد قابل للتمدد داخل `#midRow`؛
  غرفة العمليات والمعاينة شقيقان ثابتَا العرض، والطرفية تبقى أسفل الصف كاملة العرض. تحت `120rem`
  لا يظهر إلا سطح جانبي واحد، وفوقها يمكن اجتماعهما. انتقالات عرض الأسطح تستدعي
  `preview.remeasure()` عند `transitionend` مع مهلة احتياط بعد `--dur` لأن `ResizeObserver` لا يرصد
  تغيّر موضع `WebContentsView` إن بقي حجم مساحة المعاينة ثابتاً.
  `#chatColumn` حاوية inline باسم `chat-column`: المؤلّف يحافظ على شكله الواسع افتراضياً، ويلتف
  تحت `48rem` من عرض العمود، ثم يحوّل حقوله وأزراره إلى شبكة قابلة للاستخدام تحت `28rem`؛ لذلك
  لا يعتمد تكيّفه على عرض النافذة بينما تضيق الدردشة بسبب سطح جانبي.
  يحرس `npm run test:chatcolumn-layout` هذه العقود داخل Chromium حي عند عروض عمود `806/504/381px`؛
  يستورد `base.css` ومكوّن المؤلّف الحقيقيين، ويقيس انعدام التجاوز واحتواء القوائم والمرفقات وشريط
  العمليات وبقاء الطرفية كاملة العرض. محاذاة `WebContentsView` وحالة drawer/استعادة التركيز تبقيان
  ضمن التحقق الحي للتطبيق الكامل لأن الـfixture المعزول لا يملك طبقة المعاينة الأصلية.
- **الأمان والعرض**: الواجهة تستهلك snapshots العامة والسجل المنقّى فقط؛ لا تستقبل patch في أي
  حدث بث، ولا `source_root` ولا خرج أوامر كاملاً. **استثناء واعٍ مقصود**: عند نقر ملف معروف في
  الأثر تستدعي `satr:executionFileDiff {teamId,artifactId,rel}` كسولاً؛ تتحقق العملية الرئيسية أن
  `rel` ضمن `artifact.files` وتشتق بطاقة ملف واحد من patch المحجوز، بسقف 256KiB و600 سطر و`noUndo`.
  لا تعيد القناة patch النصي ولا تسمح بمسار خارج القائمة. أعلى النتائج يظهر إجمالي الملفات و`+س −ص`،
  وبطاقات المراجعين تطوي قوائم «المخاطر/الملاحظات/التوصية» المأخوذة من `summary` مع حقل
  `recommendation` الفعلي، ويبقى verdict وربطه بالبصمة كما هما. كل معرّف ومسار تقني LTR.
- **واجهة هيئة القضاة**: حين يحمل `execution_review_update` حقلي `lenses` و`merged_report` تعرض
  الواجهة زوايا «الصحة/الأمان/التبسيط» داخل بطاقة كل محرك، وتقريراً مدموجاً يحافظ على ترتيب بنوده
  وشدّتها وحالة `truncated`. زر «🔧 أصلح بالملاحظات» يعبّئ نموذج فريق جديد ببنود `critical/high`
  ضمن سقف 2000 نقطة Unicode للمراجعة البشرية ولا يبدأ التنفيذ تلقائياً. منتقيات نموذج العامل
  ومراجعي Claude وCodex اختيارية، تحفظ محلياً في `satr_ops_models::<cwd>`، وتُمرّر overrides
  المتاحة فقط؛ واختيار نموذج قاضٍ ضعيف يعرض التحذير غير الحاجب المتفق عليه. الأحداث القديمة التي
  تغيب عنها الحقول الجديدة تستمر بالعرض السابق، ولا تتغير بوابة الحكم المجمّع أو الدمج.
- **الحوكمة والاختبار**: سلالم `--z-*` و`--space-*` و`--radius-*` في `base.css`، والأوراق
  `panelSheet/cardSheet` عبر `adoptedStyleSheets`. `npm run test:opsroom-ui` يستورد reducer الفعلي
  ويختبر ترتيب/إزالة تكرار الأحداث، حالات الأزرار، رفض البصمة القديمة، CSP، وحارس z-index/HTML/
  Shadow DOM على الملفات المتغيرة، ويثبت اشتقاق زر المعاينة بعد النجاح والطلب الكسول للفرق وعرض
  بنود المراجع. توسعت عقود IPC المحددة أعلاه بلا كسر، ولم تُضف اعتمادية.
  يشغّل `npm run test:opsroom-all` طقم غرفة العمليات القطعي بالتسلسل، وتبقى اختبارات Electron الأبطأ منفصلة في `npm run test:opsroom-all-live`.
- **بطاقة الحلقة المحدودة**: يستهلك reducer حدث `loop_update` ذي `schema_version:1` كحقيقة
  عامة منقّاة ومربوطة بـ`room_id` و`team_id`، ويرطّبها عبر `loopLatest`. أثناء الحالات غير
  الطرفية تملك الحلقة الفريق وتغلق بدء فريق جديد والمراجعة والتحقق الرسمي، ويعرض قسم «العمل»
  الدورة والحالة وآخر فشل منقّى والكلفة وميزانية الرموز التقديريتين مع إيقاف مؤكد صريح. بدء الحلقة
  متاح لعامل واحد فقط، ويسبق `loopStart` فحص `loopPreflight` وموافقة واحدة تعرض أوامر `HEAD`
  حرفياً والسقوف؛ وبعد النهاية تعود المراجعة العمياء والتحقق الرسمي والدمج البشري بلا اختصار.
- **المراجعة النوعية داخل الحلقة**: يضيف snapshot اختيارياً
  `review:{configured,state,summary}`؛ ينسخه reducer بشكل additive في الحدث الحي والترطيب من
  `loopLatest`، وغيابه يبقي شكل الحلقة القديم وعرضه حرفياً. الحقل عرض فقط ولا يدخل
  `deriveOpsRoomState`، فلا يغير `nextAction` أو `canMerge` أو ملكية الحلقة لأي بوابة. تظهر بطاقة
  «المراجعة النوعية» فقط عند `configured:true` بحالات عربية، ويُعرض `summary` المنقّى كنص خامل
  مقصوص بنقاط Unicode ومطوي بصرياً داخل `ownSheet`/`adoptedStyleSheets`. خطأ البدء
  `review_skill_unavailable` يعرض إرشاداً عربياً وزر «افتح إعداد التحقق» الذي يبث حدث
  `verify-config-open` القائم؛ لا قناة IPC جديدة ولا تشغيل أو إصلاح تلقائي.
- **حد أمني ثابت**: التنفيذ الإنتاجي ما زال عبر Claude SDK فقط؛ فريق Codex أو فريق مختلط غير
  متاح لأن حاجز 3A أثبت قراءة/كتابة خارج worktree وتجاوز ownership وأغلق 3B. Codex يبقى مراجعاً
  قراءة فقط. لا تعرض الواجهة اختياراً يوحي بعزل غير مثبت، ولا يُفتح هذا الحد ضمن عمل UI.
- **مؤجّل عمداً**: Codex منفذاً أو فريق مختلط، قوالب المهام، مقارنة المخرجات جنباً لجنب، بث التفكير
  الحي، وإحياء معاينة تكاملية بعد إعادة تشغيل التطبيق؛ ليست مرفوضة، لكنها تحتاج دفعات مستقلة وحواجزها.

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

### نواة توليد الوسائط BYOK (م١ — الجولة 8، البند الأول)

> الخطة الحاكمة `docs/GENERATION-PLAN.md` وعقدها المجمَّد §1. هذا القسم يوثّق **ما أثبته
> المسبار الحيّ حصراً** — لا عقد سلك مجمَّد بلا استدعاء حيّ (المبدأ 5).

- **المسبار أولاً**: `scripts/genmedia-probe.js` شُغّل حياً 2026-08-01 على
  Node ‏v26.5.0/win32 بأصغر كلفة (صورة واحدة لكل مزوّد + فيديو واحد قصير). يطبع البنية
  والأطوال ورموز الحالة لا المحتوى، وكل سطر يمر بـ`redact()` فلا يظهر مفتاح؛ مفتاح غائب
  ⇒ `SKIPPED: no key`. الأصول للمعاينة البشرية في `dist/genmedia-probe/`.
- **fal — PROVEN (الوحيد المفعَّل)**. العقد المجمَّد كما رُصد حرفياً:
  1. `POST https://queue.fal.run/<model>` بترويسة `Authorization: Key <FAL_KEY>` ⇒ `200`
     مع `{status:'IN_QUEUE', request_id(len=36), response_url, status_url, cancel_url,
     logs:null, metrics:{}, queue_position:0}`.
  2. `GET status_url` ⇒ **`202` ما دام `IN_QUEUE`/`IN_PROGRESS`، و`200` عند `COMPLETED`**.
     التسلسل المرصود: `IN_QUEUE -> IN_PROGRESS -> COMPLETED`.
  3. `GET response_url` ⇒ `200`؛ صورة: `{images:[{url,width,height,content_type}], timings,
     seed, has_nsfw_concepts, prompt}` · فيديو: `{video:{url,content_type,file_name,
     file_size}, seed}`.
  4. الأصل يُجلب بـ`GET` عادي على `url` **بلا ترويسة اعتماد** (متحقَّق: `image/jpeg` و
     `video/mp4` بمطابقة magic bytes).
  ⚠️ **`status_url`/`response_url` تُستعملان كما أعادهما المزوّد ولا تُبنيان محلياً**: المسار
  المرصود يطوي `fal-ai/flux/schnell` إلى `fal-ai/flux/requests/<id>`.
  الأرقام الفعلية: صورة `fal-ai/flux/schnell` بـ`image_size:'square_hd'` ⇒ `1024×1024`
  و`41948` بايت في `3416ms` باستقصاء واحد؛ فيديو `fal-ai/ltx-video` ⇒ `3699240` بايت
  MP4 بعد `67` استقصاءً و`215738ms`.
- **openai — UNPROVEN**: المفتاح مقبول والمسار صحيح، لكن الحساب ردّ `400`
  `billing_hard_limit_reached` («Billing hard limit has been reached.») على
  `gpt-image-1-mini` و`gpt-image-1` معاً — فلم تُرصد بنية استجابة ناجحة قط.
- **gemini — UNPROVEN**: `gemini-2.5-flash-image` ردّ `429 RESOURCE_EXHAUSTED` مع
  `limit: 0` على `generate_content_free_tier_requests` (توليد الصور خارج الطبقة المجانية)،
  و`gemini-2.5-flash-image-preview` ردّ `404 NOT_FOUND` (النموذج غير موجود بهذا الاسم).
- **أثر ذلك في الكود (fail-closed)**: المزوّدان المباشران **معرَّفان في السجل ومعطَّلان بلا
  مسار سلك**: التوجيه لا يختارهما، واختيار نموذجهما صراحةً يعيد `provider_unproven` برسالة
  عربية ترشد إلى إصلاح الحساب. لا كود تخميني يدّعي عقداً لم يُرصد. بعد إصلاح الحساب:
  أعد المسبار ⇒ جمّد الشكل المرصود ⇒ فعّلهما. وخانة `managed` (م٣) معرَّفة معطَّلة بلا منطق.
- **API الوحدة**: `listCatalog()` · `estimate(req)` · `generate(req, ctx)` · `readLog(cwd,n)`
  حيث `req = {cwd, kind, prompt, model?, count?, refs?, budget_usd?}`. الأنواع `image`
  (fal) و`video` (fal)؛ الصوت خارج ج8.
- **السقف الصلب**: `budget_usd` يُفحص **قبل أي استدعاء شبكة** ويعيد `over_budget` بلا نداء،
  ويُعاد فحصه لكل مرشّح في سلسلة السقوط فلا يتجاوز السقوط الميزانية أبداً.
- **المفاتيح**: بيئة النظام أولاً ثم `keys.get` (تحميل كسول كي تعمل الاختبارات بلا Electron)
  — لا تدخل نتيجةً أو حدثاً أو سجلاً أو رسالة خطأ. متحقَّق بفحص صريح.
- **الأصول والسجل**: الأصول تحت `<cwd>/generations/` باسم مبنيّ لا مشتق من البرومبت
  (`gen-<kind>-<epoch>-<rand>-<i><ext>`) وبامتداد من `content-type` بقائمة سماح، وسقف
  `64MiB`؛ **حارس النطاق**: الأصل لا يُجلب إلا من `https` ونطاق `fal.media` (أو نطاق فرعي)
  فيُرفض رابط من نطاق آخر قبل التنزيل. السجل `<cwd>/.satr/generations.jsonl` بحقول v1
  المجمَّدة، إلحاق ذرّي أفضل جهد، سقف `4MiB` بقصّ الأقدم عبر temp+rename.
  البرومبت ≤`2000` نقطة Unicode بعد إزالة التحكم/Bidi، وإن التقطه `memory.hasSecret`
  يُخزَّن فارغاً بعلامة `prompt_redacted`. لا مسار مطلق ولا مفتاح ولا خرج API خام.
- **المراجع**: مسارات نسبية داخل `cwd` حصراً بحارس `inject.resolveInside` نفسه (لا مطلق،
  لا `..`، ولا هروب symlink) بسقف `6`. ولأن **مسار المراجع لم يُثبته المسبار لأي نموذج
  مفعَّل**، فالمرجع الصالح يُرفض بـ`refs_unsupported` بدل تجاهله صامتاً (ج9).
- **حدود موثّقة**: أرخص صورة اليوم `1024×1024` من `fal-ai/flux/schnell` — أحجام أخرى غير
  مثبتة. الفيديو نموذج واحد بلا معاملات مدة/دقة مثبتة و`max_count=1`. الأسعار تقديرية
  بتاريخ `catalog_date` ولا تُنسب إلى فاتورة المزوّد. `ctx.models`/`ctx.request`/
  `ctx.baseUrls` منافذ **داخلية للاختبار** (ctx لا يعبر من renderer، والسائق محصور في
  `DRIVERS`).
- **التحقق**: `node scripts/genmedia-test.js` (قطعي، بلا شبكة خارجية — خادم HTTP محلي
  يحاكي عقد fal المرصود) غطّى `26/26`: الكتالوج الموسوم، عزل غير المثبت، التوجيه الأرخص
  والسقوط الصريح، السقف الصلب قبل الشبكة وداخل السقوط، دورة `202/200`، حصر المراجع،
  حارس النطاق ونوع الأصل، schema السجل والقصّ وreadLog، تفريغ البرومبت الحسّاس، وعدم
  تسريب المفتاح في أي نتيجة/سجل/اسم ملف. وتحقّق حيّ من طرف إلى طرف عبر الوحدة الحقيقية
  (بلا حقن) ولّد `35801` بايت JPEG وكتب سطر السجل بلا تسريب. `npm run eval:agent` بقي `12/12`.

### توسعة نواة التوليد (الجولة 9 — الصوت وrefs وافتراضي الصور وحارس المنزل)

> العقد الحاكم §1 من «العقد المجمَّد للجولة 9 (v2/v2.1)» في `docs/GENERATION-PLAN.md`.
> كل رقم أدناه **منسوخ من خرج مسبار حيّ**؛ لا سعر ولا حقل من توثيق منشور (المبدأ 5).

- **مرحلة اكتشاف مجانية أولاً**: قبل أي توليد مدفوع يفحص المسبار وجود المعرّف بـPOST بجسم
  فارغ ثم يُلغي فوراً. **حدّ upstream مثبت (وتصحيح فرضية)**: بوابة طابور fal **لا تتحقّق من
  المدخل عند التقديم** — أعادت `200 IN_QUEUE` لكل معرّف موجود ولو بجسم فارغ، والتحقق وقت
  التنفيذ؛ فالإشارة الوحيدة الموثوقة هي `404` (غير مستضاف) مقابل `200` (المعرّف موجود).
  من `26` معرّفاً مرشّحاً كان `fal-ai/cassetteai/sound-effects-generator` وحده `404`.
  النتيجة تُخزَّن في `dist/genmedia-probe/discovery.json` كي لا تتكرر الإدراجات.
- **الأسعار صارت مقيسة لا مقدَّرة**: fal **لا يعيد كلفة في استجابة التوليد**، فيقيسها
  المسبار من فرق الرصيد الحيّ: `GET https://rest.alpha.fal.ai/billing/user_balance`
  بترويسة `Authorization: Key <FAL_KEY>` ⇒ `200` وجسمه **رقم عشري عارٍ لا JSON**.
  ⚠️ التسوية **ليست فورية**: بقي الرصيد ثابتاً بعد ست ثوانٍ من الاكتمال ثم تحرّك، لذلك
  يستقصي المسبار حتى التغيّر (سقف `150000ms`) ويُبلغ `unsettled` بدل تسجيل صفر كاذب.
  المقيس فعلياً: `flux/schnell` ‏`9.8549575→9.8519575` = **$0.003** · `gpt-image-1`
  ‏`9.9049575→9.8849575` = **$0.02** · `flux/dev/image-to-image` ‏`9.8849575→9.8549575`
  = **$0.03** · `ace-step` ‏`9.9069575→9.9049575` = **$0.002** · `ltx-video`
  ‏`9.5461241667→9.5261241667` = **$0.02** · `ltxv-13b-098-distilled`
  ‏`9.8519575→9.7999575` = **$0.052** · `wan/v2.2-5b` ‏`9.7999575→9.5491241667` =
  **$0.250833**. تبقى موسومة تقديرية لأنها قياسة واحدة بتاريخ `catalog_date` لا فاتورة.
  **أول ثمرة للقياس**: سعر `ltx-video` في كتالوج ج8 كان `0.04` أي **ضِعف الحقيقة** —
  دليل عملي على أن السعر يجب أن يُقاس لا يُنقَل. وثبات `flux/schnell` على `0.003` في
  قياستين منفصلتين يثبت موثوقية طريقة القياس نفسها.
- **خيارات الفيديو الثلاثة (بلا افتراضي — نصّ العقد)**: `ltx-video` ‏`$0.02` (‏71 استقصاءً
  و`229143ms`، أصل `2433833` بايت) · `ltxv-13b-098-distilled` ‏`$0.052` (‏55 استقصاءً
  و`177731ms`، `83678` بايت) · `wan/v2.2-5b/text-to-video` ‏`$0.250833` (‏6 استقصاءات
  و`19571ms`، `422785` بايت — الأسرع والأجود والأغلى بمرتبة). نموذجا Kling وHailuo
  **مُخطَّيان بحارس كلفة صريح** في المسبار (`--include-premium-video` يثبتهما) كي لا يُقرأ
  غيابهما نقصاً في التغطية.
- **`kind:'audio'` (توسعة قيم لا حقول — schema السجل يبقى v1)**: النموذج المثبت
  `fal-ai/ace-step` بدورة queue نفسها. المدخل المجمَّد `{prompt, duration:10}` والخرج
  المرصود `{audio:{url, content_type:"audio/wav", file_name, file_size:null}, seed, tags,
  lyrics}` والأصل `1921214` بايت RIFF/WAVE. **مُدد أخرى غير مقيسة فلا تُمرَّر** كي يبقى
  السعر صادقاً. `EXT_BY_TYPE` كسبت `audio/wav` (مثبت) و`audio/mpeg` (قائمة سماح أمنية لا
  ادعاء عقد)، و`max_count:1`.
- **`refs` تعمل فعلاً**: `fal-ai/flux/dev/image-to-image` بمدخل
  `{prompt, image_url:"data:<mime>;base64,…", strength:0.6}`. المرجع يُرمَّز **data: URI
  محلياً فلا نقطة رفع ولا يغادر ملف المستخدم إلى خدمة تخزين**. فوق حارس `sanitizeRefs`
  القائم: امتداد من قائمة سماح (`png/jpg/jpeg/webp` — النوع لا يُشتق من المحتوى) وسقف
  `MAX_REF_BYTES=8MiB`، و`max_refs:1` (المسبار أثبت `image_url` مفرداً) فالمرجع الثاني
  يُرفض بـ`refs_too_many` صراحةً لا بإسقاط صامت. الرموز الجديدة: `refs_too_many` ·
  `refs_type_rejected` · `refs_too_large`. وكل نموذج لم يثبت مساره يبقى `refs_unsupported`.
  ووجود مراجع **يغيّر التوجيه**: `routeChain` لا يُبقي إلا نموذجاً يدعمها فعلاً بدل اختيار
  الأرخص ثم الفشل المضمون؛ وغياب أي مرشّح داعم يعيد `refs_unsupported` لا `no_provider` المضلِّل.
- **افتراضي الصور = GPT Image (قرار المالك v2.1، مشروطاً بالمسبار — وقد ثبت)**:
  `fal-ai/gpt-image-1/text-to-image` **مستضاف على fal بلا BYOK** وأنتج «سطر» بأحرف عربية
  موصولة صحيحة (‏PNG ‏1024×1024، ‏`970128` بايت) — وهو مبرر جعله الافتراضي. المدخل المجمَّد
  `{prompt, image_size:'1024x1024', quality:'low'}`. ⚠️ نسختا `/byok` تلزمان مفتاح OpenAI
  الخاص بالمستخدم: `gpt-image-1/text-to-image/byok` أعاد عند جلب الخرج **422**
  (`detail[0].type="missing"`) و`gpt-image-1-mini/text-to-image/byok` أعاد **404**.
  القاعدة: `default_for_kind` أولاً ثم البقية أرخص-فأرخص؛ و`flux/schnell` يبقى «الأرخص»
  يُطلب **صراحةً بـmodel**، وضيق `budget_usd` يُسقط الافتراضي إلى الأرخص الذي تسعه بدل
  الفشل. الميزانية **لا تُرشِّح السلسلة** كي يبقى تجاوز السقف مذكوراً في `fallbacks`.
  **لا افتراضي مفروض للفيديو** (نصّ العقد): غياب `model` يسقط إلى الأرخص-أولاً، والكتالوج
  يعلن الخيارات بأسعارها كي تعرضها مهارة `satr-generate` عبر AskUserQuestion.
- **⚠️ حدّ upstream مثبت (خطر صامت)**: `status=COMPLETED` **لا يعني نجاحاً** — رصد المسبار
  حياً وظيفتين بلغتا COMPLETED ثم أعاد جلب الخرج `422` و`404`. لذلك فحص
  `out.status !== 200` بعد الاكتمال **شرط لازم لا احتياط**.
- **🏠 حارس مجلد المستخدم**: `req.cwd` يساوي المنزل ⇒ `{ok:false, error_code:'no_project'}`
  **قبل التقدير وقبل أي شبكة**، برسالة عربية ترشد لاختيار مجلد المشروع. المقارنة على
  `realpath` (فيسقط الرابط الرمزي واسم 8.3) وبلا حساسية حالة على ويندوز، وتشمل اللاحقة
  والمسار غير المُطبَّع. الحارس على **المنزل نفسه لا شجرته** — مشروع بداخله يعمل طبيعياً.
  `ctx.homeDir` منفذ اختبار داخلي (نظير `ctx.models`) لا يعبر من renderer.
- **openai/gemini يبقيان unproven**: أُعيد المسبار في ج9 ولم يتغيّر شيء —
  `openai` ‏`400 billing_hard_limit_reached` ("Billing hard limit has been reached.")
  للنموذجين، و`gemini` ‏`429 RESOURCE_EXHAUSTED` بـ`limit: 0` على
  `generate_content_free_tier_requests`، و`gemini-2.5-flash-image-preview` ‏`404 NOT_FOUND`.
  لا كود تخميني لهما، وملاحظة openai تشير الآن إلى توفّر GPT Image نفسه عبر fal بلا حساب OpenAI.
- **حدود موثّقة**: `duration` غير `10` للصوت، وأحجام صور غير المجمَّدة، ومرجع ثانٍ — كلها
  غير مقيسة فلا تُدَّعى. الأسعار قياسة واحدة لا فاتورة. مرحلة الاكتشاف تُدرج وظيفة ثم
  تُلغيها؛ الإلغاء أفضل جهد ووظيفة الجسم الفارغ تنتهي بخطأ تحقّق فلا استدلال ⇒ لا كلفة.
- **التحقق**: `node scripts/genmedia-test.js` صار **`46/46`** (‏`26` من ج8 محفوظة بلا نقص
  + `20` جديدة): كتالوج الصوت وتوليده وسطر سجله بحقول v1 نفسها، المرجع data: URI ومطابقة
  بايتاته للملف وعدم تسرّبه إلى نتيجة أو سجل، توجيه المراجع وحُرّاسها الثلاثة، حارس المنزل
  بأشكاله وعدم حجب ما بداخله، الافتراضي فوق الأرخص والأرخص الصريح وضيق الميزانية والسقوط
  من الافتراضي، وخيارات الفيديو الثلاثة مرتبة بالسعر وبلا افتراضي. وتحقّق **حيّ من طرف إلى طرف عبر
  الوحدة الحقيقية بلا حقن**: صوت `1921214` بايت RIFF/WAVE بـ`$0.002`، ثم افتراضي الصور
  ولّد PNG بـ`$0.02`، ثم refs عليه ولّد JPEG بـ`$0.03` — وسطور السجل الثلاثة بلا مفتاح ولا
  مسار مطلق ولا `data:` URI. `npm run eval:agent` بقي `12/12`.

### مدد الصوت وموسيقى الإعلان المولَّدة (الجولة 10 — أولى دفعات م٢)

> العقد الحاكم §1 من «العقد المجمَّد للجولة 10 (v3)» في `docs/GENERATION-PLAN.md`.
> الأرقام كلها منسوخة من خرج مسبار حيّ — لا سعر ولا مدة من توثيق منشور.

- **مدد `ace-step` صارت أربعاً مقيسة** (‏`--only audio-duration`): المسبار يقرأ **الطول
  الفعلي من ترويسة WAV** (‏`fmt`+`data` ÷ byteRate) بدل تصديق ما طُلب، ويقيس السعر بفرق
  الرصيد. المرصود: `30s→29.91s` بـ**$0.006** · `63s→62.97s` بـ**$0.0126** ·
  `120s→119.91s` بـ**$0.024**، ومعها `10s` من ج9 بـ**$0.002**. الصيغة ثابتة
  `audio/wav 48kHz stereo 16-bit`. السعر **خطي تماماً عند $0.0002/ثانية في نقاط القياس
  الأربع** — والاختبار القطعي يحرس هذه النسبة فأي انحراف يكسر الطقم.
  ⇒ **لا حاجة لمزج crossfade**: المدة المطلوبة (≥62ث) مدعومة أصلاً.
- **لماذا مدخل كتالوج لكل مدة لا حقل `duration` في الطلب** (قرار تصميم): سعر الوحدة في
  هذا الكتالوج **مقيس**، فلو صار الطول حقلاً يرسله المتصل لانكسر ثبات `unit_cost_usd`
  وتعذّر على `estimate()` حساب الكلفة من الكتالوج وحده **قبل الشبكة** — وهي ركيزة مربع
  إذن الكلفة. وبهذا الشكل **لا يتغيّر شكل الطلب المجمَّد**
  `{cwd,kind,prompt,model?,count?,refs?,budget_usd?}` ولا عقد أداة `generate_media`
  (ملك كودكس): الاختيار يمر بحقل `model` القائم. المعرّفات
  `fal-ai/ace-step[-30s|-63s|-120s]`، و`wire_model` يعلن مسار السلك صراحةً — **لا اشتقاق
  بقصّ اللاحقة** كي لا يخترع الكود معرّفاً لم يثبته المسبار. واللاحقة تبقى ضمن
  `[A-Za-z0-9._/-]` لأن `mediaToken` في `tools.js` يرفض ما عداها فلا يُعرض المعرّف في
  مربع الإذن. حقل `duration` من المتصل يُتجاهل تماماً (محروس باختبار).
- **موسيقى الإعلان مولَّدة بالميزة نفسها**: أربع مرشّحات ×63ث بـ**$0.0504** إجمالاً.
  الوكيل لا يسمع، فالفرز الموضوعي في `promo/analyze-music.js` (صفر اعتماديات، يقرأ PCM
  مباشرة): المدة الفعلية · مغلّف RMS بنافذة ثانية وميل انحداره · تقدير BPM بالارتباط
  الذاتي لمغلّف البدايات (**تقريبي موسوم لا قياس مرجعي**) · الذروة والاقتطاع. المرصود
  (‏`sec/rise/slope`): `A-arp 62.97/1.47/0.0088` · `B-wave 62.97/3.63/0.0252` ·
  `C-tech 62.97/1.10/0.0016` · `D-build 62.97/1.22/0.0041`، وصفر اقتطاع في الأربع.
  وشكل الطاقة بنوافذ 10ث حسم الاختيار: `B-wave` يصعد `0.038→0.201` وذروته على المشهد
  الختامي، بينما `C` مسطّح و`D` ينخفض عند الخاتمة. **الغناء والذوق خارج القياس** —
  يبقيان للاعتماد السمعي البشري، ولذلك صُيِّرت نسخة بديلة كاملة بـ`A-arp` للمقارنة.
- **التجميع**: `TOTAL` يُحسب من قائمة المونتاج (‏**59.80ث** اليوم) ويحكم `atrim` وبداية
  الخفوت — كان الرقم `60` ثابتاً فينقطع الخفوت قبل تمامه حين يقلّ المجموع عن دقيقة.
  و`PROMO_OUT` يسمح باسم ناتج بديل لتصيير نسخة مقارنة بلا لمس القائمة. الناتج
  `promo/satr-promo-60s.mp4`: `h264 1920x1080 60fps` + `aac 48kHz stereo`، المدة
  `59.800000`ث والحجم `7481578` بايت، **بلا أي بطاقة نائبة** (‏11 مقطعاً كلها حاضرة).
- **حدّ بيئي موثّق**: `promo/footage/**` كله مُتجاهَل في Git (`/promo/**/*.mp4|*.mp3`)
  فمخزنه الفيزيائي واحد في الشجرة الرئيسية؛ شجرة المنفّذ تصل إليه بـjunction فلا تُنسخ
  1.2غ.ب ولا تتسخ `git status`. لذلك **الموسيقى والفيديو الناتج لا يعبران الدمج** —
  يُسلَّمان كملفات على القرص.
- **حدود موثّقة**: مُدد غير `10/30/63/120` تبقى غير مقيسة فلا تُمرَّر. تقدير BPM عرضة
  لخطأ الأوكتاف (رُصد `70/95/139/168` لمرشّحات صُممت 122–128) فلا يُتخذ معياراً حاسماً
  وحده. الموسيقى مقطع واحد بلا فواصل بنيوية معلنة من المزوّد.
- **التحقق**: `node scripts/genmedia-test.js` صار **`51/51`** (‏`46` من ج8/ج9 محفوظة +
  `5` جديدة): المدد الأربع بأسعارها ومدّاتها ونسبة `$0.0002/ث`، مسار السلك من `wire_model`
  و`duration` المجمَّد على السلك، رفض معرّف مدة غير مقيسة بـ`unknown_model` بلا نداء شبكة،
  تجاهل حقل `duration` من المتصل، ترتيب التوجيه الأرخص-أولاً، وإعلان `wire_model` لكل
  معرّف ذي لاحقة مدة. `npm run eval:agent` بقي `12/12`.

### جولة جودة موسيقى الإعلان بعد الرفض السمعي (الجولة 10 التكميلي)

قرار محمد المؤرخ 2026-08-02: رفض مرشحي `ace-step` بسبب التشويش المسموع والطابع
الموسيقي، واعتمد اتجاهاً سينمائياً ملحمياً هادئ البداية (بيانو/وتريات تتراكم إلى
ذروة الخاتمة)، بلا غناء، وبسقف الجولة كله `$2.00`.

- **تصحيح قياس حرج**: أول قراءة لـLyria صدّقت `byteRate` غير المتسق في ترويسة WAV
  فأظهرت `65.54s` كاذبة. `ffprobe` قرأ الملف نفسه `32.768229s`، وعداد إطارات PCM
  في الفارز أعطى `32.77s`. لذلك صار `wavSeconds` يحسب
  `dataBytes ÷ (sampleRate × channels × bits/8)` ولا يثق بـ`byteRate`.
- **`fal-ai/lyria2` مثبت لكن قصير**: المدخل المقيس
  `{prompt, negative_prompt}` بلا مدة، والخرج WAV ‏PCM16 `48000Hz` stereo
  بطول `32.77s`. فرق الرصيد `9.4111241667→9.3111241667` = `$0.1`.
  دخل الكتالوج بـ`wire_model` صريح، لكنه مستبعد من إعلان ≥62ث كمقطع منفرد.
- **`fal-ai/minimax-music` غير مثبت**: يتطلب
  `{prompt, reference_audio_url}` بلا حقل مدة في الشكل المجسوس. رفض `data:`
  بـ`file_download_error`، ثم رفض أصل `fal.media` بـ`value_error` قبل أصل صوتي؛
  بقي الرصيد `9.2111241667→9.2111241667` وظهر `delta USD: 0` مع
  `settled:false`. لا سعر ولا مدخل كتالوج يُخترع له.
- **`fal-ai/stable-audio-25/text-to-audio` هو الفائز التقني**: المدخل المقيس
  `{prompt, seconds_total:65}`، والخرج WAV ‏PCM16 `44100Hz` stereo بطول `65s`.
  فرق الرصيد `9.2111241667→9.0111241667` = `$0.2`. جُمّد
  `wire_model` صراحةً، ولا يُمرّر غير `seconds_total:65` مع البرومبت.
- **المرشحات والفرز**: استُخدم أصل المسبار + مرشحان عبر `genmedia.generate`.
  الفارز يقيس خاتمة الإعلان عند `50..60s` (آخر `5s` في أصل `65s` هامش)، ويميّز
  عينة Full Scale منفردة عن clipping مستمر (الرفض عند `3` عينات متتالية). النتائج
  `rise/slope/finalPeak/peakAt/clipped?`: المرشح `1`
  `3.98/0.0167/1.2/50/false`؛ المرشح `2`
  `1.42/0.0049/0.95/43/false`؛ أصل المسبار
  `0.73/-0.008/0.58/0/false`. لذلك الأول فائز موضوعي والثاني احتياط، والحكم
  الذوقي/الغناء يبقى لمحمد.
- **الإنفاق والتصيير**: الرصيد الكلي `9.4111241667→8.6111241667`، أي `$0.8`
  من سقف `$2.00`. صُيّرت نسختان كاملتان: `satr-promo-60s-cine1.mp4`
  (`7307KB`) و`satr-promo-60s-cine2.mp4` (`7313KB`)؛ كلتاهما
  `59.80s` و`1920x1080` و`60fps`. بقي `promo/footage/music.mp3` على
  المرشح الأول بعد المقارنة.
- **التحقق القطعي**: `npm run test:genmedia` صار `53/53`؛ الاختباران الجديدان
  يثبتان `wire_model` ومعاملات Lyria وStable المقيسة، ويرفضان تسريب
  `duration`/معامل غير مقيس إلى السلك. `npm run eval:agent` خرج `12/12`.

### أوامر التكافؤ مع Claude Code (الدفعة الأخيرة قبل التجميد)

ثلاثة أوامر أساسية تطابق ما يعتمده مستخدم Claude Code اليومي. **بعد هذه الدفعة تُجمَّد
الأوامر** (لا أوامر جديدة قبل الإصدار — المرحلة 6). كلها عبر محرك SDK فقط.

- **`/موصلات` (MCP)**: لوحة جانبية لحالة خوادم MCP. IPC `satr:mcpStatus(cwd)` →
  `{ok, servers:[{name, status, scope, serverInfo, error, tools}]}` عبر `query().mcpServerStatus()`
  في تشغيل عابر (`withControlQuery` في agent.js). الحالات: `connected`/`pending`/`needs-auth`/
  `failed`/`disabled`. الإجراءات عبر `satr:mcpAction {cwd, name, action}` حيث action ∈
  `{reconnect, enable, disable}` (تُنقّى بـ `SAFE_MCP_NAME` و `MCP_ACTIONS` في main.js) →
  `reconnectMcpServer`/`toggleMcpServer`. **حدّ معروف**: أفعال لوحة الحالة نفسها لا تبدأ
  مصادقة OAuth. إن أطلق الموصّل أثناء أداة طلب URL قياسياً، يعرض سطر حوار دفعة C ويفتحه
  بعد تأكيد صريح؛ وإلا يُصادَق على `needs-auth` من Claude Code بالأمر `/mcp` ثم «تحديث».
  «إعادة الاتصال» أفضل جهد، والإجراءات تحدّث اللوحة لتكشف الحالة الفعلية.
- **`/سياق` (context)**: لوحة تعرض امتلاء نافذة السياق. IPC `satr:contextUsage {cwd, sessionId}`
  → `{ok, usage}` عبر `query().getContextUsage()` (يستأنف الجلسة إن وُجد sessionId ليعكس رموز
  المحادثة الفعلية، وإلا السياق الأساس). `usage` فيه `totalTokens`/`maxTokens`/`percentage`/
  `model`/`categories[{name, tokens, isDeferred}]`. الواجهة تعرض النسبة وشريطاً وصفوف الفئات
  (عدا «الفراغ»، مع وسم «مؤجّل» لغير المحمّل). الأرقام والنموذج LTR.
- **`/ضغط` (compact)**: يرسل `/compact` كدور SDK عادي (لا IPC جديد) — النموذج يلخّص ويُصدر
  `system/compact_boundary`، والواجهة تعرض بطاقة بالرموز قبل/بعد. الجلسة تبقى نفسها فتكمل
  المحادثة. يتطلب جلسة قائمة (sessionId)؛ يُرفض أثناء انشغال دور آخر.

### الوكلاء الفرعيون (Subagents — المرحلة 14.2)

- **الاكتشاف**: `electron/agents.js` (نمط skills.js) يفحص `<cwd>/.claude/agents/*.md` و
  `~/.claude/agents/*.md` — كل وكيل ملف Markdown بمقدمة YAML (name/description/tools/model)
  وجسمه برومبت الوكيل؛ المشروع يفوز عند تكرار الاسم. IPC قراءة فقط `satr:listAgents(cwd)`.
  الـ SDK نفسه يحمّل الوكلاء من القرص (settingSources) — السرد للعرض فقط.
- **العرض المتداخل**: `forwardSubagentText: true` في agent.js يمرّر نصوص الوكيل كرسائل
  بـ `parent_tool_use_id`. الواجهة: أداة الإطلاق (Task/Agent) من الخيط الرئيسي تصير
  **بطاقة وكيل** (`agent-card`: رأس 🤖 بالحالة + وصف المهمة)، وكل ما يصل بـ
  parent_tool_use_id يتوجّه داخلها — أدوات متداخلة (قائمة ملتصقة بالآخر) وسجل نصي حي
  (renderMD). tool_result للإطلاق يعلّم البطاقة ✓/✗ عبر toolEls القائمة.
- **اللوحة**: أمر `/وكلاء` يفتح لوحة قراءة فقط (اسم/مصدر/وصف/نموذج/أدوات، وإرشاد إنشاء
  عند الخلو). وكيل نموذجي للمشروع: `.claude/agents/muraji-amn.md` (مراجع أمني عربي).

### التحديث التلقائي (المرحلة 17)

- **`electron/updater.js`** عبر `electron-updater` + إصدارات GitHub (`build.publish` = github):
  يزيل التوزيع اليدوي. **حارس `app.isPackaged`**: لا يعمل في npm start (يتخطّى صامتاً).
  بلا توقيع رقمي (ويندوز NSIS يحدّث بلا شهادة — تحقق حيّ). مثبّتنا per-user فلا صلاحيات مدير.
- **التدفق الآمن المعتمد**: فحص بعد 8ث من الإقلاع ⇒ إشعار عربي `available` لا يقاطع ⇒
  المستخدم يضغط «نزّل الآن» (`downloadUpdate`) ⇒ تقدّم `progress` ⇒ «أعد التشغيل الآن»
  عند `ready` (`quitAndInstall`). ‏`autoDownload=false` و`autoInstallOnAppQuit=false`:
  لا تنزيل قبل الموافقة ولا تثبيت عند الإغلاق. الأحداث تُبثّ للواجهة كنوع `update` عبر
  `emitToWindow` (قناة satr:event، مستقلة عن الدور)، وIPC
  `satr:downloadUpdate`/`satr:restartUpdate` للخطوتين الصريحتين.
- **دورية الفحص (جولة الصقل 2026-08-08)**: الفحص لم يعد مرة واحدة — من يبقي «سطر»
  مفتوحاً أياماً كان لا يرى التحديثات. صار: إقلاع (8ث) + دوري كل 4 ساعات (مؤقّت unref)
  + عند استعادة تركيز النافذة بخنق 30 دقيقة + يدوي من ⚙ (زر «تحقق من التحديثات الآن»
  عبر `satr:checkUpdates` ⇒ `updater.checkNow()`). بعد أول `available` تتوقف الفحوص
  التلقائية (لا إزعاج متكرراً بإشعار رُفض)؛ اليدوي وحده يتجاوز. التنزيل/التثبيت يبقيان
  بموافقة صريحة كما هما.
- **العقد**: `{type:'update', phase:'available'|'progress'|'ready'|'error'|'none'|
  'check_failed', version?, percent?}`. الخطأ التلقائي يُخفي الإشعار صامتاً (يبقى
  التثبيت اليدوي متاحاً)؛ `none` («أنت على أحدث نسخة») و`check_failed` يُبثّان **للفحص
  اليدوي فقط** فلا يزعج الدوري الصامت أحداً. preload يكشف
  `downloadUpdate` و`restartUpdate` و`checkUpdates` فقط.
- **تمهيد**: التحديث يبدأ من أول إصدار يحوي المُحدِّث (v2.4.1). النشر يرفع `latest.yml`
  مع المثبّت لكل إصدار (يولّده electron-builder عند dist مع publish config).
- **التحقق**: `npm run test:update-ui` (حي، ضمن test:full) — طبقتان: عقد updater.js مع
  fake autoUpdater محقون عبر require.cache (الأعلام autoDownload/autoInstallOnAppQuit=false،
  خرائط الأحداث الأربعة، عدم تسريب رسالة الخطأ الخام، التفويض الصريح فقط)، وتوست
  Chromium فعلي عبر `src/ui/lib/update-toast.js` المستخرجة (غير حاجب، الموافقتان،
  الفشل الصامت) تحت CSP صارم. fixture الترميز محروس بمطابقة `#updateToast` مع index.html.

### دمج الطرفية مع النموذج — أداة run_in_terminal (المرحلة 16)

- **الفكرة**: بدل تنفيذ أوامر النموذج في Bash الخفي، أداة `run_in_terminal` تشغّلها في
  **طرفية مرئية** فيرى المستخدم ما يجري حياً (تشغيل المشروع/الاختبارات).
- **البنية**: خادم MCP داخل العملية (`createSdkMcpServer`+`tool` في agent.js) — تحقق حيّ:
  النموذج يستدعي الأداة ويتلقى نتيجتها. الـ pty يعيش في نفس العملية (term.js مفرد مشترك
  بين main.js وagent.js) فالأداة تستدعي `term.runCapture` مباشرة بلا جولة renderer.
- **طرفية النموذج**: `term.ensureModelTerm(cwd)` — تبويب واحد مخصّص يُعاد عبر الأدوار
  (`modelTermId`)؛ عند إنشائه يُبثّ حدث `model_term {id, shell, cwd}` فتتبنّاه الواجهة
  كتبويب «🤖 النموذج» (`adoptModelTerm`: لا termStart — الـ pty موجود، فقط ربط xterm بمعرّفه
  والموجّه satr:term يوصل خرجه). النقر/الكتابة كأي تبويب.
- **الالتقاط** (`term.runCapture`، المرحلة 16.1): يكتب الأمر بـ **اللصق المُقوّس** (bracketed
  paste — يمنع إسقاط PSReadLine لمحارف السطر الطويل)، ويلتقط الخرج بين علامتَي بداية/نهاية
  فريدتين (البداية سطر مستقل بمطابقة تامة تستبعد صدى الأمر)، مع رمز خروج رقمي دائماً
  (تصفير `$LASTEXITCODE`+السقوط لـ `$?`)، ومهلة وسقف خرج 512ك.ب. طلبات الالتقاط لنفس
  الطرفية تمر بطابور FIFO فلا تتشابك علامات نداءين متوازيين (يشمل verify/run_command).
- **🔒 أمان (مثبّت)**: الأداة تمر بـ `canUseTool` مثل Bash تماماً — **لا** تُضاف لـ
  `alwaysAllowed`، فمربع الإذن العربي يعمل عليها؛ العرض المرئي لا يخفّف التنفيذ. الأمر نص
  لمجرى pty لا لوسائط spawn، وبايتات التحكم تُنقّى (`sanitizeCommand`). حدّ موثّق:
  الخوادم الطويلة لا تستخدم هذه الأداة؛ يحولها execguard إلى run_in_background.

### مهام الطرفية المعمّرة — run_in_background

- `termjobs.startJob(cwd,command,label)` ينشئ pty حقيقياً عبر `term.startTerm`؛ المهمة
  تعيش بعد نهاية الدور وتبديل الجلسة ولا تموت إلا بخروجها أو
  `termKill/stop_background_task` أو إغلاق التطبيق. يُلحق خروجاً للصدفة بعد الأمر مع
  حفظ رمز خروج الأمر الأصلي كي
  يختفي التبويب تلقائياً حين تكتمل مهمة محدودة، بينما الخادم يبقيها مشغولة. `MAX_JOBS=4` مستقل، و`MAX_TERMS=12`
  يترك ثمانية تبويبات غير مهام للمستخدم وأربعة للمهام.
- **الأمر يُقلع في وسائط spawn لا في سطر الطرفية (‏OBS-065 — 2026-08-28)**: كان يُكتب
  خاماً إلى pty فور إنشائه، فأمرٌ متعدد الأسطر يُعلّق القشرة عند مِحَثّ `>>` بلا نهاية
  والمهمة تبدو حيّة بلا عمل.
  - **العلّة الجذرية مقيسة، وليست الطول**: `term.sanitizeCommand` يحذف `\n` **بلا بديل**
    (ضمن الصنف `[\x00-\x08\x0A-\x1F…]`)، فتلتصق الجُمل — `$b = @'⏎نص⏎'@⏎Write-Output $b`
    تصير `$b = @'نص'@Write-Output $b` — والناتج **جملة غير مكتملة**، وهي المعنى الوحيد
    لمِحَثّ `>>`. أما الطول فسُبر ونُفي: أمر **7986 محرفاً** (‏67 سطراً ملتفاً على طرفية
    120×30) وصل سليماً بالكتابة الخام برمز خروجه الصحيح؛ فتفسير «تجاوز الطول ما تتحمله
    PowerShell» في سجل تفكير الوكيل كان تفسيره لنفسه لا قياساً.
  - **العلاج**: `term.sanitizeScript` نظيرٌ يحفظ `\n` و`\t` ويوحّد `\r\n`→`\n` (سقف 8000)،
    و`startTerm` يقبل `meta.script` فيمرّره إلى `powershell.exe -EncodedCommand <base64
    UTF-16LE>` عند spawn ويعيد `launchedScript:true`؛ عندها لا يكتب `startJob` سطراً
    إطلاقاً. فلا يمرّ الأمر بمحرِّر السطر: لا حدّ طول، ولا PSReadLine، وأي جملة غير مكتملة
    تصير خروجاً فورياً برمز 1 ورسالة `TerminatorExpectedAtEndOfString` بدل علقٍ صامت.
  - **`sanitizeCommand` لم يُلمَس**: `runCaptureNow` يوجب سطراً واحداً بنيوياً (بروتوكول
    علامتَي البداية/النهاية)، فالتغيير محصور بمسار المهام.
  - **لماذا لا ملف `.ps1` مؤقت** (المرشّح المدوَّن أصلاً في OBS-065): يعمل، لكنه يورث
    الاعتماد على `ExecutionPolicy` — جهاز التطوير `CurrentUser=RemoteSigned` فيمرّ،
    وافتراضي ويندوز للعميل `Restricted` يحجب `& 'file.ps1'` ⇒ عطل يخفيه جهاز المطوّر عن
    المستخدمين (نمط درس مرآة RTL نفسه). ويضيف قرصاً وتنظيفاً وBOM بلا مقابل.
  - **سقفان حتميان**: صدى الأمر في التبويب مقصوص عند `MAX_ECHO_CHARS=400` — **ليس
    تجميلاً**: الصدى يضاعف الطول داخل السكربت، وقد رصد الحارس حيّاً
    `Cannot create process, error code: 206` لأمر 7000 محرف. وbase64 مفحوص قبل spawn
    مقابل `MAX_ENCODED_COMMAND=30000` فيردّ `script_too_long` برسالة عربية بدل رمز نظام
    غامض. أسوأ حالة ‏400+8000+الغلاف ≈ 8700 محرفاً ⇒ base64 ≈ 23200 ⇒ هامش ~9500.
  - **حدّ معلَن**: `cmd` وصدف POSIX تبقى على الكتابة إلى السطر بسطر واحد — العطل المرصود
    خاص بـPSReadLine، وتحويل `bash` إلى `-c` يُسقط قراءة `.bashrc` (الصدفة اليوم تفاعلية)
    فيتغيّر PATH للمستخدم: تغييرٌ غير مقيس لا نُقدم عليه.
  - **الحارس**: `npm run test:term-longline` (‏39 فحصاً، داخل `test:full`) — **مُثبَت أنه
    يعضّ**: أُعيد المسار القديم فسقط عند `انتهت مهلة: bg_term_done للمهمة متعددة الأسطر`،
    أي أنه يلتقط العلق نفسه لا مجرد غياب دالة.
  - **جدول ثوابت التحويل المعلَن** (‏مخرَج جولة قرار — انظر `OBS-065`): `term.structuralDelta`
    دالة نقية تعيد فرق الشكل البنيوي (بايتات UTF-8، أسطر، اقتباس) بين نصّين، **بلا أي
    مستدعٍ في مسار الإنتاج** (يحرسه فحص صريح على ستة ملفات). يستهلكها الحارس وحده ليثبّت
    التحويل المعلَن رقماً: `sanitizeScript` تحويل هوية · `sanitizeCommand` يُسقط كل
    الأسطر عمداً · `buildPwshJobScript` يضيف **4** أسطر بالتصميم زائد أسطر الصدى ·
    والصدى مقصوص عند 400. سبب وجوده أن الفرق البنيوي **غير صفري في المسار السليم**، فأي
    سجلّ يرصده «شذوذاً» يشتعل دائماً؛ أما تثبيته ثابتاً فيُسقط أي انحراف في CI قبل الشحن.
    البِتّة مُثبَتة: إضافة سطر واحد إلى الغلاف تُسقط الحارس بدليل `newlines:5` بدل 4.
- أدوات كل المحركات: `run_in_background` و`stop_background_task` من طبقة exec، و
  `get_background_output` (ذيل ≤48K) و`list_background_tasks` قرائيتان. الإيقاف لا يقبل
  «دائماً»، ووضع تحكم المتصفح لا يعفي التشغيل أو الإيقاف في Codex.
- `term.js` يخزن آخر 256KiB من خرج كل pty من نفس `onData`. `satr:termList` +
  `satr:termReadBuffer` يعيدان تبنّي التبويبات بعد reload من دون قتل العمليات.
- **«أكمل بالوكيل» (K4 — 2026-07-27)**: عند خروج مهمة محدودة يلتقط `term.js` ذيلها
  الخام (≤32KiB من المخزن الدائري) **قبل** حذف الطرفية ويرفقه بحدث `exit`؛ و`termjobs`
  ينقّيه (إزالة ANSI ومحارف التحكم، حجب أسرار ببوابة `secretscrub` المشتركة (K5)، قص ≤8000 محرف
  بعلامة `…` مع الاحتفاظ **بنهاية** الخرج الفعلية) ويبث `bg_term_done` عبر notifier القائم — بلا IPC جديد. الواجهة تعرض
  إشعار فعل `addActionNotice` (✅ لكود 0 وإلا ⚠️) والنقر يرسل دوراً عادياً بالذيل
  موسوماً `<untrusted_terminal_output>` — لا إرسال تلقائي، النقرة هي الموافقة.
  الخوادم الحية لا `exit` لها فلا يصلها الحدث. `npm run test:termjobs-done` يغطي
  الالتقاط والحجب والقص ورمزي النجاح والفشل والخوادم الحية وثبات الأنواع.
- `execguard.js` يرفض تشغيل خادم معروف أو `run_in_background=true` عبر Bash/
  run_in_terminal قبل alwaysAllowed، ويرشد الأداة الصحيحة. `bgprocs` يبقى شبكة أمان.

### توصيل `bg_term_done` إلى النموذج (دفعة تغذية الأدوات الراجعة — 2026-08-24)

- **العطل المشخَّص**: الحدث `bg_term_done` كان يُبثّ فعلاً بحمولته كاملةً (رمز الخروج +
  ذيل منقّى من ANSI ومحجوب الأسرار) لكنه يصل **الواجهة** وحدها (`app.js`). فكان النموذج
  إمّا يستقصي بحلقة نوم ثم `list_background_tasks` (رُصد 25+ دورة في جلسة واحدة عند
  مستخدم خارجي)، وإمّا لا يعرف أصلاً أن المهمة ماتت («الموت الصامت»). **العيبان الأثقل
  في التقرير الخارجي عطلٌ واحد**: توصيل ما هو مبني لا بناء جديد.
- **قرار المالك (2026-08-24)**: **لا دور تلقائي**. «الإيقاظ» = انتظار حاجب داخل الدور +
  حقن عند بدء الدور التالي. لا يبدأ «سطر» دوراً من تلقاء نفسه ولا ينفق بلا المستخدم،
  ولا يُوقَظ دور جارٍ فيفسده.
- **ثلاث طبقات في `termjobs.js`** (لا مخزن قرص جديد، وكلها في ذاكرة العملية):
  1. **`waitForExit(id, timeoutMs)`** — انتظار حاجب يعود **لحظة** الخروج بـ
     `{status:'exited', id, label, exit_code, tail}`. خروج وقع قبل النداء يعود فوراً من
     السجل الدائري، ومعرّف مجهول يعيد `{status:'unknown'}`، والمهلة تعيد
     `{status:'running', waited_ms}` **بلا خطأ** فيمدّد النموذج بنداء واحد. المدى
     `1000..600000ms` (يوافق `tool_timeout_sec` المحقون لـCodex) والافتراضي `120000`.
     المؤقّت `unref` فلا يعلّق إغلاق التطبيق.
  2. **`recentExitList()` / `lastExit(id)`** — سجل دائري بـ`MAX_RECENT_EXITS = 16`.
     يظهر حقلاً `recent_exits` في `list_background_tasks` (بلا ذيل — مختصر)، و
     `get_background_output` بمعرّف مهمة خرجت يعيد ملخّص خروجها بدل «لا توجد مهمة».
  3. **`pendingNoticeText()`** — كتلة `<satr_background_tasks>` تُحقن **مرة واحدة** في
     بداية الدور التالي لمهام خرجت بلا دور نشط. سقف `MAX_PENDING_NOTICES = 4` مهام
     و`MAX_NOTICE_TAIL = 1200` محرفاً لكل ذيل (الإغراق محجوب؛ المُسقَط يُذكر عدده)،
     والذيل يبقى داخل `<untrusted_terminal_output>` بنفس صياغة الواجهة اليوم. ما عَلِمه
     النموذج عبر `waitForExit` يُعلَّم مستهلَكاً فلا يُحقن ثانيةً.
- **الأداة الجديدة `wait_for_background_task`** في الأسطح الثلاثة: `agent.js` (‏SDK) و
  `codexmcp.js` (‏Codex + Kimi، `access:'read'`) و`tools.js` (المحوّلات، بلا إذن).
  و`envbrief` يوجّه صراحةً إلى استعمالها بدل حلقة النوم، وإلى `recent_exits` عند اختفاء
  مهمة. عدد أدوات Codex MCP صار **36** (يحرسه `test:codexmcp`).
- **بوابة الحقن = بوابة الذاكرة حرفياً**: `isolatedPolicy` في `agent.js` و
  `browserControl === false` في `codex.js`/`kimi.js`. السياقات المعزولة (المراجعون
  والعصف وعوامل غرفة العمليات) لا ترث الكتلة. المواضع السبعة هي مواضع
  `memory.retrieve` نفسها (المحرّكات الثلاثة + المحوّلات الأربعة).
- **`scrubDoneTail(raw, limit)`** كسبت سقفاً اختيارياً: `bg_term_done` يبقى على
  `MAX_DONE_TAIL = 8000` بلا تغيير، و`get_background_output` يمرّر `48KiB` فيقرأ سجلاً
  طويلاً **بالتنقية نفسها** (كانت الأداة تعيد ANSI خاماً في المواضع الثلاثة).
- **ما لم يتغيّر**: عقد حدث `bg_term_done` وحقوله وسلوك الواجهة و`MAX_JOBS` وسجلات
  `bgprocs`/Kimi keep-alive. `test:termjobs-done` عقد عدم تراجع، وتوسّع بسبعة عقود جديدة
  (السقف الموسّع، السجل الدائري، الانتظار الحاجب بشقّيه، الكتلة ووسمها وسقفها واستهلاكها
  مرة واحدة، وعدم إعادة حقن ما عَلِمه الانتظار).

### وعي بيئة «سطر» الموحّد — envbrief

- `electron/envbrief.js` هو المصدر الفعلي لهوية «سطر» وجرد أدوات المحرك وسياسة التنفيذ
  المرئي وسياسة المعاينة و`runtimeenv.environmentLine`. يستهلكه `agent.js` و`codex.js`
  والمحوّلان `openai-compatible.js` و`gemini.js` (نسخة مختصرة للمحوّلات).
- السياسة: build/test/install/run المرئي عبر `run_in_terminal` أو `run_command`؛ الخادم
  حصراً عبر `run_in_background`، يسبقه `list_background_tasks` ويتبعه `open_preview`
  حيث تتوفر أدوات المتصفح و`get_background_output` للسجل. `test:envbrief` يقارن كل جرد
  بتعريفات الأدوات الفعلية كي يفشل عند التقادم.
- سياسة المتصفح الموحدة تذكر أن القراءة حرة مع التفويض، وأن التنقّل/الفعل/التقييم على
  origin خارجي جديد يسأل مرة قبل الثقة، وتفرض تحقق التجاوب بـ`browser_set_viewport`
  مع دليل لقطة أو أبعاد فعلية.
- **صدق تسمية الوكلاء الفرعيين** (‏`SUBAGENT_NAMING_LINE` — ‏`OBS-012` بند ج، 2026-08-24):
  بلاغ مالك بلقطة أن وكيل SDK أطلق ثلاثة وكلاء فرعيين — وهم Claude نفسه بسياقات
  معزولة — **وسمّاهم «كودكس/كيمي/أوبس»** بشخصيات، فبدت للمستخدم نماذجَ حقيقية
  واكتشف ذلك بحدسه لا من الواجهة. السطر يحظر تسمية وكيل فرعي باسم محرّك آخر ونسبة
  رأي «نموذج مختلف» إليه، **ويحمل البديل معه** (‏`satr-diverge` أو عصف غرفة العمليات
  أو تشغيل المحرّك الآخر مع التصريح) لأن الحظر وحده يترك الطلب المشروع بلا مخرج.
  للمحرّكات الأصيلة الثلاثة فقط (تملك وكلاء فرعيين فعلاً)؛ حدّ مُصرَّح به: `claude-cli`
  يُطبَّع `adapter` فلا يصله رغم امتلاكه `Task`. يحرسه `test:envbrief` بأربعة فحوص.
- **العصف متعدد الآراء** (‏`MULTI_OPINION_LINE` — ‏`OBS-012` بند أ): بلاغ مالك أن
  الوكيل سُئل «عصفاً ثلاثياً» فأجاب بوصف ما لا يستطيع بينما الطرق الثلاث متاحة كلها —
  فجوة معرفية لا قدرة نموذج. السطر يعرضها صراحةً: `satr-diverge` · عصف غرفة العمليات ·
  تشغيل محرّك آخر من الطرفية بأعلامه (`docs/AGENT-CLI-FLAGS.md`). **لكل المحرّكات
  والمحوّلات** — المهارة محمولة وغرفة العمليات سطح تطبيق، فلا يخصّ أيّهما محركاً بعينه.
  يحرسه `test:envbrief` على الأسطح الأربعة.
- سياسة البرومو توجّه المحرّكين إلى `promo_record_start` ثم أدوات المتصفح القائمة ثم
  `promo_record_stop`، وتثبت أن البدء تسجيل شاشة حساس بإذن صريح كل مرة وبلا «دائماً»،
  وأن الالتقاط نافذة المنتج وحدها والملفات محلية في Downloads بلا رفع.
- في إعداد المنصات تفضّل السياسة `API/CLI` المتاح (`gh`/`netlify`) عبر الطرفية المرئية،
  وتلجأ للمتصفح للفجوات البصرية فقط. كما تمنع تمرير الأسرار نصاً وتوجّه إلى
  `browser_transfer_field`/`browser_request_secret` وتفرض `task_update` عبر المنصات.

### أداة توليد الوسائط وقنوات المعرض — الجولة 8

- `generate_media {kind,prompt,model?,count?,refs?,budget_usd?}` متاحة في SDK وCodex/Kimi MCP
  والمحوّلات. تصنيفها `exec` مع `neverAlways`: لا موافقة دائمة ولا موافقة دور، ولا يعفيها
  إلا `bypassPermissions`. قبل التنفيذ تستدعي `genmedia.estimate` وتعرض النوع والمزوّد
  والنموذج والعدد والكلفة التقديرية وتراكمي الجلسة؛ ثم تفوّض صندوقاً أسود إلى
  `genmedia.generate` وتعيد نصاً عربياً منقّى بالمسارات النسبية والكلفة وسقوط المزوّد.
- `electron/tools.js` يوحّد تحضير الطلب والتقدير والصياغة بين الأسطح. تحميل
  `electron/genmedia.js` محروس بوجود الملف، وغيابه يعيد «ميزة التوليد لم تكتمل بعد» بلا
  كسر الإقلاع. خرج الأداة لا يمرّر كائن المزوّد الخام ولا حقول المفاتيح.
- IPC القراءة فقط: `satr:generationsList` يعيد أحدث 200 سطر v1 منقّى، و`satr:genThumb`
  يقبل صورة تحت `generations/` حصراً حتى `3MiB` مع رفض traversal/symlink، و
  `satr:genProviders` يعيد `{keyName,label,set}` بلا قيم. `FAL_KEY` مضاف إلى قائمة سماح
  مركز المفاتيح، وقيم المفاتيح لا تعبر أي رد.
- `scripts/codexmcp-test.js` يحقن `genmedia` مزيّفاً لإثبات التصنيف وحقول الإذن والكلفة
  التراكمية والرفض والتدهور وعدم تسريب حقل سري. الوصلة الحية ومسابر المزوّدين تنتظر دمج
  نواة أوبس `electron/genmedia.js` و`scripts/genmedia-test.js`.

### حدث اكتمال التوليد ومهارة `satr-generate` — الجولة 9

- بعد نجاح `generate_media` تعيد `electron/tools.js` بناء حدث العرض وحده بالشكل المغلق
  `{type:'generation_done',kind,files:[rel],cost_usd_estimate,provider,model}`. الملفات
  نسبية تحت `generations/`، والأنواع تشمل `image|video|audio`؛ لا يدخل الحدث البرومبت أو
  المفتاح أو كائن المزوّد/SDK الخام. الفشل أو النجاح الخام بلا ملف نسبي صالح لا يبث حدثاً.
- المحوّلات تمرّر `ctx.emit` القائم، وSDK يمرّر باعث الدور نفسه إلى الطبقة المشتركة.
  `codexmcp.js` يقبل باعثاً محلياً للاختبار، وفي التشغيل يمر عبر مصرف واحد يربطه `main.js`
  بمسار `satr:event`. يعيد `main.js` تنقية الحدث بقائمة الحقول المغلقة نفسها قبل renderer؛
  لا يدخل `KNOWN_EVENT_TYPES` لأنه حدث منسّق، نظير `loop_update`.
- المهارة المضمّنة `.agents/skills/satr-generate/` تطبق سياسة الطبقات الثلاث: HTML/CSS
  للنص العربي والهوية الدقيقة، و`generate_media` للمشاهد، والموصّل الخارجي فقط إذا سمّاه
  المستخدم. مواردها تحميل تدريجي للصياغة، والعربية المشروطة بالنموذج، والميزانية، ونمط
  `promo/instagram/post.html` + `scripts/ig-post-shots.js` الموثق.
- سياسة الصور v2.1: GPT Image افتراضي الجودة والعربية، و`fal-ai/flux/schnell` لطلب
  «الأرخص» والمشهد بلا نص. الفيديو بلا نموذج يمر `AskUserQuestion` بخيارات المسبار المثبتة
  وأسعارها المؤرخة وينتظر المستخدم؛ لا اختيار تلقائي. لقطة المسودة الحالية لا تخترع
  خيارات الجولة 9 قبل دمج نتيجة مسبار أوبس واعتماد المالك.
- `satr-generate` مضافة إلى `BUILTIN_SKILLS` وإلى `build.files`/`asarUnpack` بنمط
  `satr-guide`. `scripts/codexmcp-test.js` يثبت schema والتنقية وعدم التسريب والأسطح
  الثلاثة بالمزيّف، و`tools.md` يبقى مولّداً حصراً عبر `npm run gen:satr-guide`.

### مزامنة أوامر CLI في قائمة «/» (المرحلة 14.1)

- IPC قراءة فقط `satr:listCommands(cwd)` → `{ok, commands:[{name, description, argumentHint,
  aliases}]}` عبر `q.supportedCommands()` في تشغيل عابر (`withControlQuery`). يعيد ما يفهمه
  CLI في هذا المشروع: مهارات مضمّنة (verify/code-review/init/review/security-review/…)
  ومهارات المستخدم/المشروع وأوامر أساسية.
- الواجهة: جلب كسول لكل cwd عند فتح قائمة «/» (الأصلية تظهر فوراً وأوامر CLI تلحق بلون
  مميز)؛ الاختيار **يُدرج** `/name ` في المحرّر (يتيح الوسائط) والإرسال كدور عادي —
  نمط `/ضغط` المثبت. المستبعد: `clear/compact/context` (نسخ عربية أصلية أفضل).
- تحديث منتصف الجلسة: حدث `system/commands_changed` (يمرّ عبر بث system القائم) يستبدل
  الكاش كاملاً — supportedCommands تُلتقط عند init ولا تعكس تغييرات لاحقة.

### بوابة أول التشغيل + الأيقونة (المرحلة 6 — تلميع المنتج)

- **بوابة أول التشغيل (مانع إطلاق)**: «سطر» يعتمد كلياً على Claude Code المثبّت عالمياً (محرك
  SDK يستدعيه عبر `pathToClaudeCodeExecutable`، والاحتياطي CLI كذلك)، فبدونه يفشل أول طلب
  صامتاً. لذا الواجهة تحجب المحادثة خلف بوابة عربية (`#gate` overlay في index.html) حتى يتوفّر.
  - IPC `satr:preflight` (يستبدل `satr:check` القديم) → `{claude:{ok, version, path, outdated?,
    recommended?}, node:{ok, version}, npm:{ok, version}}`. يفحص node و npm (تستخدمهما خطوات
    الإرشاد) وclaude. **توافق الإصدار (خارطة المنصّات الموجة 3)**: يستخرج semver من `--version`
    ويقارنه بـ `CLAUDE_MIN_RECOMMENDED` (2.1.197 لـ Sonnet 5)؛ إن كان أقدم يضع `outdated`+
    `recommended` فتعرض البوابة إرشاد تحديث غير حاجب (banner `note` ذهبي) — لا تحديث تلقائي
    («سطر» يعتمد المثبّت العالمي عمداً). يستدعي
    `agent.resolveClaudeBin(true)` — **بالقوة** ليتجاوز التخزين، فزرّ «أعد الفحص» يلتقط تثبيتاً
    جرى بعد إقلاع «سطر». كل فحص بمهلة 8ث حتى لا تتعلّق البوابة.
  - الواجهة: متغيّر `gated` (يبدأ `true`) يمنع `send()`. البوابة تظهر فوراً بحالة «جارٍ التحقق»،
    ثم: claude جاهز ⇐ تُخفى البوابة + شريط نجاح؛ غير ذلك ⇐ خطوات عربية (تثبيت Node مع رابط
    nodejs.org، ثم `npm install -g @anthropic-ai/claude-code`، ثم `claude` لتسجيل الدخول) مع
    أزرار نسخ الأوامر وزرّ «أعد الفحص». تسجيل الدخول إرشادي (لا يُكشف من `--version`).
  - **للاختبار فقط**: `SATR_FORCE_NO_CLAUDE=1` يحاكي غياب Claude Code (تظهر البوابة بخطواتها)
    دون إلغاء تثبيته — للتحقق من معيار قبول المرحلة 6. بلا أثر في الاستخدام العادي.
- **الأيقونة وعلامة شريط المهام**: `build/icon.ico` (يولّدها `scripts/make-icon.js`). main.js يضبط
  `app.setAppUserModelId('ai.satr.app')` وأيقونة النافذة (دلالياً للتطوير؛ المثبّت يضمّن الأيقونة
  في الـ exe عبر `build.win.icon`). الملف خارج `files` فلا يُحزَم في asar — في الإنتاج تأتي
  الأيقونة من مورد الـ exe، وفي التطوير من الملف على القرص (الحارس `fs.existsSync`).
- **مؤجَّل للمرحلة 7**: التحديث التلقائي (electron-updater) — يحتاج مستودع GitHub عاماً وإصدارات
  (Releases) لا توجد بعد، فيُنفَّذ مع إطلاق المصدر المفتوح. ولوحة `/تكلفة` مُلغاة (تجميد الأوامر).

### لوحة ملفات المشروع + عارض القراءة (الدفعة 1.2 من ROADMAP)

- **الفتح**: زر 📄 في الشريط العلوي (ليس أمر `/` — احتراماً لتجميد الأوامر) يفتح لوحة
  جانبية بشجرة ملفات المشروع (من `satr:listFiles` القائمة؛ بناء الأبناء كسول عند فتح
  المجلد). النقر على ملف يفتح **عارض قراءة** (ليس محرّراً): نافذة وسطية، كود LTR بأرقام
  أسطر (عدّاد CSS).
- **تظليل كود بسيط (الدفعة 4.3)**: مميّز رموز يدوي في index.html بلا اعتماديات
  (`hlLine`/`HL_CFG`) — أربع فئات فقط (تعليق/نص/كلمة مفتاحية/رقم بألوان tokens:
  `.hl-c/-s/-k/-n`)، اللغة من الامتداد (`HL_CFG`: عائلة C-like وpy وsh/yaml وcss
  وhtml/xml وsql…)، حالة تعليق كتلي تعبر الأسطر، البناء بعناصر DOM لا innerHTML.
  حدود واعية: سطر >2000 حرف بلا تظليل (minified)، امتداد مجهول = نص خام،
  والحالات النادرة (regex literals، نصوص متعددة الأسطر) تتدهور لنص عادي بأمان.
- **أساس اتجاه موحّد للملف (قبول 4.3 — لقطتا مالك)**: بنية السطر flex — عمود أرقام ثابت
  يساراً (`::before` عنصر flex) + نص السطر `.lt` بأساس اتجاه **واحد للملف كله**.
  **درس مثبّت**: `dir=auto` لكل سطر جُرّب أولاً وشتّت القراءة (كل سطر يرسو على حافة
  مختلفة) — الأساس الموحّد يريح العين والكود داخل الأسطر العربية ينعزل LTR بخوارزمية
  BiDi (كنمط فقاعات المحادثة). «تلقائي» يحسم: امتداد كود معروف (HL_CFG) = LTR دائماً؛
  غيره بإحصاء المحارف (عربي ≥ نصف اللاتيني ⇐ RTL). زر «الاتجاه: تلقائي/RTL/LTR» يدور
  للتجاوز اليدوي — **مؤقت**: كل فتح يعود تلقائياً.
- **IPC جديد**: `satr:readFile {cwd, rel}` → `{ok, content, truncated, bytes}` أو
  `{ok:false, error: outside|notfound|binary|error|bad_cwd|bad_input}` — قراءة فقط عبر
  `files.readText` (تحقق موحّد مع inject.js: داخل cwd حصراً، رفض الثنائي، سقف 256ك.ب).
  preload يكشفه كـ `readFile(cwd, rel)`.
- **حدود العرض**: 256ك.ب و5000 سطر DOM — الأطول يُعرض أوله مع ملاحظة «✂️». Escape يغلق
  العارض ثم اللوحة؛ النقر على الخلفية المعتمة يغلق العارض.
- **تحرير خفيف في العارض (الدفعة 4 — تكملة)**: زرّ «✏️ تحرير» في رأس العارض يبدّل
  لـ **textarea** بديل (لا contenteditable — استخراج النص من DOM التظليل هشّ): تراجع/إعادة
  أصليان وIME عربي سليم، والاتجاه يرث قرار العرض المحسوم. **مقايضة واعية**: لا تظليل ولا
  أرقام أسطر أثناء التحرير. يُحرَّر المحتوى **الخام** كما قُرئ ويُحفظ كما هو (لا عبث بنهايات
  الأسطر — العرض وحده يقصّ `\r`). لا تحرير للمقصوص (truncated أو >5000 سطر — الحفظ حينها
  يُتلف بقية الملف؛ الزرّ معطّل مع تلميح). مؤشر «●» غير محفوظ + Ctrl+S يحفظ + Esc/إغلاق
  مع تغيير غير محفوظ يسأل (`confirm`) — Esc في التحرير يعود للقراءة لا يغلق العارض.
  - **IPC**: `satr:readFile` يعيد `version` (SHA-256 للمحتوى الكامل)، ثم
    `satr:writeFile {cwd, rel, content, version}` → `{ok, card}` أو `{ok:false, error:
    bad_input|bad_cwd|bad_version|conflict|too_big|outside|notfound|error(+message)}`. التنقية في main.js
    (القاعدة 2: cwd مجلد قائم، rel ≤ 512، content نص، version بصمة hex صارمة) والتنفيذ عبر
    `tools.saveFromViewer` — **إعادة استخدام** المسار المؤمَّن نفسه: `resolveExisting`
    (تسامح NFC/NFD) + `readBefore` (رفض الثنائي/الضخم) + `commitWrite` (سقف 1م.ب +
    لقطة `editSnapshots` فالتراجع القائم يعمل). كتابة **ملف قائم فقط** (العارض لا ينشئ).
    preload يكشفه `writeFile(cwd, rel, content, version)`.
  - **بطاقة diff خارج الدور (درس مثبّت)**: بيانات `file_edit` تعود في **الردّ** (`card`)
    لا حدثاً عبر `satr:event` — حدث خارج دور يسقط على حارس الكتلة (`currentBlock`).
    الواجهة تبنيها بـ `buildDiff` وتضيفها للمحادثة مستقلة (`addStandaloneDiff`) — طيّ
    وتراجع يعملان كأي بطاقة. قبل الكتابة يقارن `saveFromViewer` بصمة نسخة الفتح بالمحتوى
    الحالي؛ عند تغيّر الملف يعيد `conflict` ولا يكتب شيئاً، وتبقى تعديلات المستخدم في textarea.
- **بحث محتوى الملفات (الدفعة 4.6)**: حقل 🔍 أعلى الشجرة — Enter يبحث (مسح فعلي لكل
  الملفات، ليس ترشيحاً فورياً كبحث الجلسات) عبر IPC قراءة فقط `satr:searchFiles
  {cwd, query}` → `{ok, hits:[{rel, line, text}], partial}` (تنقية main.js: query ≤ 256؛
  المحرك في `electron/search.js` — انظر خريطة الملفات). النتائج «ملف:سطر + مقتطف»
  والنقر يفتح العارض **ويقفز للسطر** مميّزاً (`openViewer(rel, line)` — سطر خارج
  المعروض يُتجاهل بأمان؛ line=0 = تطابق اسم ملف ثنائي/ضخم). حقل فارغ يعيد الشجرة،
  Escape يمسح ثم يغلق (نمط بحث الجلسات)، ونتيجة استعلام قديم تُتجاهل إن تغيّر الحقل.
  المحرك نفسه تستدعيه أداة `search_code` للمحوّلات العمياء (كل مزوّدي عائلتَي openai
  وgemini يرثونها من حلقة الوكيل) — محرك SDK لا يتأثر (كلود يملك Grep أصلاً).

### لوحة تغييرات git ± (الدفعة 4.7 — «فرق»)

- **الفتح**: زرّ ± في الشريط العلوي (نمط 📄 — لا أمر `/`) يفتح لوحة جانبية بالملفات
  المتغيّرة منذ HEAD: شارة (جديد/معدَّل/حُذف/ثنائي/ضخم) + ‎+س −ص، والنقر يفرد بطاقة
  الفرق (بناء كسول، `buildDiff` القائمة بمرآة RTL) مع `noUndo` — **لا زرّ تراجع**:
  ليست لقطات «سطر» والتراجع عنها يعني checkout مدمّراً.
- **أفعال git (دفعة «أفعال git»)**: اللوحة صارت **تفاعلية**. كل صف له زرّا «تجهيز/إلغاء
  التجهيز» (حسب حالة `staged` الجديدة من gitdiff) و«تجاهل»؛ وشريط علوي برسالة الالتزام +
  زرّ «التزام» يظهر حين يوجد مُجهَّز. الأفعال الأربعة: stage/unstage/discard/commit عبر
  `electron/gitactions.js` (الجانب الكاتب — gitdiff.js يبقى قراءة فقط). «تجاهل» مدمّر
  فتؤكّده الواجهة بـ `confirm` عربي قبل الاستدعاء (checkout HEAD للمتتبَّع، حذف قرص للجديد).
  بعد كل فعل تُعاد قراءة القائمة، ونجاح الالتزام/الفشل يظهر تنبيهاً عربياً.
- **IPC**: `satr:gitChanges {cwd}` → `{ok, repo, head, files:[{rel, kind, staged, renamedFrom?,
  skipped?, added, removed, lines, truncated}], more, partial}` (أُضيف `staged` ثم `head`) ·
  `satr:gitAction {cwd, op, rel?, message?}` حيث op ∈ `{stage, unstage, discard, commit}`
  → `{ok, hash?}` أو `{ok:false, error}` (`no_git|no_repo|bad_cwd|bad_input|not_changed|
  nothing_staged|empty_message|outside|error(+message)}`). التنقية في main.js (op قائمة
  بيضاء `GIT_OPS`، cwd مجلد قائم)، و**المسار يُتحقَّق منه في gitactions مقابل مجموعة git
  status الحيّة** (لا حقن مسار). preload يكشف `gitChanges(cwd)` و`gitAction(cwd, op, rel, message)`.
- **درسان مثبّتان بالتجربة**: (1) توحيد CRLF/LF قبل computeDiff — git يخزّن LF والقرص
  CRLF فيظهر الملف كله متغيّراً زوراً. (2) الملفات المعدَّلة عبر تحليل `git diff` الموحّد
  لا computeDiff — سقف LCS ‏400×400 يسقط للحذف-ثم-إضافة على الملفات الكبيرة
  (main.js ظهر +517 −501 لتعديل 16 سطراً). عقد الأسطر واحد (`{t, text, old, new}`).
- **حدود**: 100 ملف (الأكثر يُعدّ)، تخطّي الثنائي/الضخم >2م.ب (شارة بلا بطاقة)،
  ميزانية كلية 10ث (`partial`).
- **تنبيه «لا شبكة استرجاع» (‏OBS-034 — 2026-09-03)**: لقطات التراجع ذاكرية تموت
  بإغلاق «سطر»، وcheckpoint يفقد `restorable` بعدها، فيبقى git الأرضية الوحيدة —
  وقد تغيب. لذلك يعيد `gitdiff.changes` حقلاً **additive** هو `head:boolean` (‏commit
  واحد على الأقل)، مشتقاً من `hasHead` نفسه الذي يحكم حساب الفروقات فلا مصدر حقيقة
  ثانٍ، ويصحب `repo:false` دائماً `head:false`. معالج `satr:gitChanges` يمرّر ردّ
  `gitdiff` كما هو ⇒ **صفر تعديل في `main.js`**. وعند أول `file_edit` في الجلسة
  تستدعي `app.js` ‏`warnIfNoGitSafetyNet(cwd)` **بعد** عرض الفرق وبلا `await` (لا
  تؤخّر الدور، ولا ترفض أبداً فلا تؤثّر في المسار)، فتعرض `addNotice` عربياً غير
  حاجب **مرة واحدة لكل مشروع** يميّز «ليس مستودعاً» من «مستودع بلا أي commit»،
  ويُخزَّن القرار في `satr_git_safety_notice::<cwd>` (نمط `satr_draft::<cwd>`).
  **fail-open للصمت عمداً**: ردّ فاشل أو بلا حقل `head` (بناء أقدم) لا يُنبّه ولا
  يُسجَّل — لا ادّعاء بغياب شبكة استرجاع بلا دليل. والمستودع السليم يصمت **بلا كتابة
  مفتاح** كي يبقى الفحص قائماً لجلسة لاحقة؛ ثمنه استعلام واحد لكل مشروع في الجلسة
  (كلفة فتح لوحة ± مرة). **تمييز لازم**: الإشعار يَعِد بكشف واسترجاع لا بإنفاذ ملكية
  — العزل الحقيقي (worktree + ملكية مسارات) يبقى في غرفة العمليات وحدها.
  الحارس: `npm run test:gitdiff` (قطعي بمستودعات git حقيقية) يغطي `head` في الحالات
  الثلاث وعدم تراجع الحقول القائمة، ومنطق التنبيه **مستخرَجاً من `app.js` وقت
  التشغيل** (نمط منتقي الجهد في `test:claude-models`) لا نسخةً موازية.

### تصدير المحادثة 📤 (الدفعة 4.8 — «مشاركة»)

- **الفتح**: زرّ 📤 في الشريط العلوي (نمط ± — لا أمر `/`) يصدّر **المحادثة الحالية**
  ملف Markdown: ترويسة (تاريخ/مشروع/محرك/جلسة) + «👤 المستخدم / 🤖 النموذج» بالتناوب
  وأدوات المساعد سطر اقتباس. يتطلب جلسة قائمة (قبل أول رسالة ⇒ تنبيه هادئ).
- **IPC قراءة فقط**: `satr:exportChat {engine, sessionId, cwd}` → `{ok, markdown, filename,
  messages, truncated}` أو `{ok:false, error: notfound|empty|bad_input|error}` — تنقية
  بـ `SAFE_ENGINE`/`SAFE_SESSION` القائمين، وcwd للترويسة الوصفية فقط. المحرك في
  `electron/exporter.js` (انظر خريطة الملفات): عائلة claude (sdk/cli) من
  `sessions.readFullSession` (كامل — لا سقف الـ40 الخاص بالعرض)، وغيرها من
  `chats.read(provider, sid, 0)`. سقف الناتج 2م.ب (`truncated`).
- **الحفظ بلا IPC كتابة**: الواجهة تبني Blob وتنقر `<a download>` — حوار الحفظ الافتراضي
  في Electron يتولى الوجهة. preload يكشفه `exportChat(engine, sessionId, cwd)`.
- **حدود**: الجلسة الحالية فقط (تصدير جلسة تاريخية من اللوحة توسعة إن طُلبت)؛
  الصيغة Markdown حصراً.

### اتجاه المحتوى المختلط في المحادثة (دفعة «RTL المختلط» — 2026-07-18)

- **المشكلة (لقطات مالك)**: فقرات المحادثة كانت على `unicode-bidi: plaintext` — الاتجاه
  يُحسم من **أول حرف قوي**، فأي فقرة عربية الجوهر تبدأ برمز لاتيني (`SPACE_DECL_RE …`،
  `(1) radius-scale …` — نمط التقارير التقنية، جوهر استخدام «سطر») كانت تُرسى LTR
  كاملة: ترتيبها البصري ينقلب وعلامات الترقيم تقفز للطرف الخاطئ والأسهم تنعكس.
- **الحل**: حسم **إحصائي صريح** على مستوى العنصر (نمط عارض الملفات المثبّت: عربي ≥
  نصف اللاتيني ⇒ RTL) — `textDir()` في chat.js تضبط `dir` صريحاً على فقرات `<p>`
  وعناصر `<li><bdi>` (بالنص الخام قبل inlineMD) وفقاعة المستخدم (اتجاه موحّد للفقاعة
  كلها — نمط أساس العارض الموحّد). `plaintext` أُزيلت من `.md p` وفقاعة المستخدم في
  base.css (كانت تتجاهل dir الصريح)؛ كتل الكود و`code` المضمّنة والجداول والعناوين
  بأساسها الثابت بلا تغيير.
- **التحقق**: `npm run test:chat-rtl` (حي في الطقم) — فقرة/عنصر عربي بادئ برمز ⇒
  rtl، إنجليزي خالص ⇒ ltr، الكود LTR، والرسو المحسوب في Chromium فعلي.

### منصّة @ للملفات + لصق الصور (المرحلة 4)

- **سرد الملفات**: IPC للقراءة فقط `satr:listFiles(cwd)` → مصفوفة مسارات نسبية بفواصل `/`
  (`electron/files.js`: مشي محدود — تجاهل `node_modules/.git/dist/…`، سقف 6000 ملف وعمق 12،
  تخزين مؤقت 15ث لكل cwd). الواجهة تجلب القائمة مرة وترشّحها محلياً عند كل حرف.
- **@ في الواجهة**: كتابة `@` (بداية النص أو بعد مسافة) تفتح قائمة ملفات بترتيب (بداية الاسم
  ← تضمّن الاسم ← تضمّن المسار)، أسهم/Enter/Tab تختار فتُدرج `@المسار ` مكان الرمز.
- **لصق الصور**: `paste` في المحرّر يلتقط صور الحافظة عبر `FileReader` → base64، تُعرض كمصغّرات
  قابلة للإزالة فوق المحرّر وفي فقاعة المستخدم، وتُمرَّر في `images` (انظر تدفق البيانات).

### عارض الفرق (Diff) العربي (المرحلة 3)

- **الالتقاط عبر الخطّافات**: agent.js يسجّل خطّافي SDK `PreToolUse`/`PostToolUse` لأدوات
  `Edit`/`Write`/`MultiEdit`. عملية claude **تنتظر** رد `PreToolUse` قبل تنفيذ الأداة،
  فهو اللحظة المضمونة لقراءة محتوى «قبل» متزامناً (القراءة تسبق الكتابة حتى مع ثنائي خارجي
  وفي وضع acceptEdits حيث لا يُستدعى `canUseTool`). `PostToolUse` (نجاح فقط — الفشل يمرّ عبر
  `PostToolUseFailure`) يقرأ «بعد» الفعلي ويحسب الفرق ويصدر `file_edit`.
- **حساب الفرق**: `electron/diff.js` (نقي، بلا اعتماديات): قصّ البادئة/اللاحقة المشتركة ثم
  LCS محدود الحجم (سقف 400×400، وإلا fallback حذف-ثم-إضافة) ثم طيّ السياق (يبقى 3 أسطر حول
  كل تغيير) وسقف 600 سطر معروض. الكود يبقى LTR داخل الواجهة RTL.
- **فرق الملفات العربية (الدفعة 4 — ملاحظة مالك من قبول 2.2)**: نفس قاعدة اتجاه العارض —
  امتداد كود معروف (HL_CFG) = LTR دائماً؛ غيره بإحصاء محارف أسطر الفرق المعروضة
  (عربي ≥ نصف اللاتيني ⇐ صنف `rtl-doc` على البطاقة): مرآة كاملة — عمودا الرقم والإشارة
  يميناً، النص يرسو يميناً ويلتف (pre-wrap، لا تمرير أفقي)، وtext-align صريحة
  (درس العارض: الوراثة تغلب dir).
- **التراجع**: agent.js يحتفظ بلقطة المحتوى السابق في `editSnapshots` (سقف 40، إخلاء الأقدم)
  تعيش بعد انتهاء التشغيل. `undoEdit(id)` يكتب «قبل» مجدداً أو يحذف الملف إن كان جديداً
  (`before == null`). الحدّ: ملفات > 2م.ب لا تُلتقط (لا فرق ولا تراجع).

### الطرفية العربية المدمجة (المرحلة 8 — مكتملة: 8.1–8.4)

> التصميم الكامل والقرارات المثبّتة في `docs/PHASE8-DESIGN.md` — اقرأه قبل أي عمل عليها.
> المعمارية: نسخة xterm.js حقيقية **واحدة** (محرك الحالة) + عارضان (BiDi HTML افتراضياً،
> الشبكة للشاشة البديلة/وضع «شبكي» اليدوي).

- **عرض BiDi (المرحلة 8.2 — الافتراضي)**: إسقاط HTML **نافذي** للقراءة فقط من Buffer API —
  يُرسم ما يظهر في نافذة التمرير فقط (+هامش OVERSCAN)، فالأداء محدود بحجم الشاشة لا بحجم
  scrollback (القصّ يتولاه سقف xterm نفسه: 5000). كل سطر عنصر `dir=auto` (اتجاه تلقائي من
  أول حرف قوي)، والمقاطع الملوّنة spans من سمات الخلايا (لوحة 256 + truecolor + عكس/غامق/…).
  المزامنة: `onWriteParsed` يعلّم متسخاً ⇐ rAF واحد يجمع؛ بصمة لكل سطر تمنع إعادة بناء ما
  لم يتغير؛ التصاق بالذيل ينفك حين يمرّر المستخدم لأعلى. **انحراف موثَّق عن خطة القسم 8.4
  في وثيقة التصميم**: الإسقاط النافذي عوّض خطة «الثابت/الحي + الإلحاق مرة واحدة» — انظر
  «ملاحظات تنفيذ 8.2» في الوثيقة (كشف الإلحاق ينكسر عند تشبّع scrollback).
- **سطر الإدخال (المرحلة 8.3)**: حقل HTML «عابر» أسفل اللوحة (`#termInput`) — يُفرَّغ عند
  الإرسال وصدى الصدفة هو المعروض الوحيد (لا ازدواج بالبناء؛ قرار الصدى في وثيقة التصميم).
  عقد المفاتيح (وثيقة التصميم §8.3): Enter يرسل السطر+`\r` (فارغ ⇐ `\r` خام)؛ Ctrl+C =
  `\x03` ويفرّغ الحقل؛ Ctrl+Z/D خامان؛ ▲▼ تاريخ الصدفة والحقل فارغ؛ Tab محجوب (حدّ موثّق)؛
  لصق متعدد الأسطر يمرَّر خاماً فوراً. زرّ 👁 يبدّل عرض الحقل يدوياً بين `text/password`
  بحالة ومسودة معزولتين لكل تبويب وعمر الجلسة فقط. **هذا إخفاء بصري في line-mode، لا اكتشاف
  لـecho ولا دعم لبرامج password التفاعلية مثل sudo/ssh**؛ لا IPC جديد ولا مساس بـPTY —
  كله عبر `satr:termInput` القائم.
  صنف الوضع (`mode-bidi`/`mode-grid`) على `#termPanel`؛ في الشبكي يختفي صف الإدخال
  (إدخال خام عبر xterm مباشرة) وفي العربي تُخفى الشبكة بـ `visibility:hidden` (لوحة
  المفاتيح صارت لسطر الإدخال — انتهى مبرر opacity المؤقت من 8.2).
- **تبديل العارض (المرحلة 8.4)**: ثلاث طبقات — (1) **تلقائي مع الشاشة البديلة**:
  `term.buffer.onBufferChange` — بديلة (vim/htop/less) ⇐ شبكي، وعادية ⇐ استرجاع اختيار
  المستخدم (`userView` لا يمسّه التبديل التلقائي). (2) **تلقائي بالأمر**: أوامر معروفة
  تعكس العربية بصرياً بنفسها (`VISUAL_ORDER_APPS`، حالياً `claude`) ترسم في الشاشة
  العادية فلا يلتقطها onBufferChange — سطر الإدخال يكشفها عند الإطلاق ويبدّل للشبكي مع
  شريط تنبيه ذهبي (`#termNotice`) فيه زرّ عودة. (3) **يدوي**: زرّ «العرض: عربي/شبكي»
  (يضبط `userView`).

- **الفتح والتبويبات (المرحلة 15)**: زرّ 🖥️ في الشريط العلوي يطوي/يفرد لوحة الطرفية —
  **ليس أمر `/` جديداً** (احتراماً لتجميد الأوامر). **تعدد طرفيات** (رُفع قيد «طرفية واحدة»
  في MVP): شريط تبويبات في الرأس (تبويب لكل طرفية + زرّ ＋)، بسقف 8 تبويبات غير مهام
  و4 تبويبات مهام 🛠 (MAX_TERMS=12). كل تبويب كائن
  مستقل في الواجهة (نسخة xterm + عارضاه + إسقاط BiDi + حالة عرض)، والنشط وحده ظاهر
  (`.term-view.active`)؛ الرأس وسطر الإدخال والتنبيه تعمل على النشط. موجّه `satr:term`
  يوزّع الأحداث بالمعرّف على تبويبها (الخلفية متعددة عبر Map في term.js منذ 15.1).
- **أسماء التبويبات (المرحلة 15.4)**: الاسم مشتق من الصدفة ثم OSC منقّى بسقف 40 محرفاً وthrottle، وF2 يثبت اسماً يدوياً لعمر التبويب؛ يحرسها `npm run test:terminal-tabs`.
- **العقد (IPC)** — كله في `electron/term.js` مع تنقية في main.js:
  - `satr:termStart {cwd, cols, rows}` → `{ok, id, shell}` — ينشئ pty **جديداً** كل مرة
    (سجلّ Map بسقف MAX_TERMS=12؛ الصدفة PowerShell، cwd مجلد موجود، cols/rows 2..500).
    `satr:termList` يعيد `[{id,label,isModel,isJob,shell,cwd}]` للطرفيات الحيّة، و
    `satr:termReadBuffer {id,tailBytes}` يعيد ذيل المخزن الدائري.
  - `satr:termInput {id, data}` — كتابة خام إلى pty (id يطابق `^term_[0-9]+$`، data نص
    ≤ 1م.ب). البرومبت/الإدخال آمن لأنه يذهب لـ pty لا لوسائط spawn.
  - `satr:termResize {id, cols, rows}` — أعداد صحيحة 2..500.
  - `satr:termKill {id}` — إنهاء العملية (شجرتها تموت مع ConPTY).
  - أحداث للواجهة عبر قناة مستقلة `satr:term` (عالية الإنتاجية — لا تمر بقناة `satr:event`):
    `{type:'data', id, data}` و `{type:'exit', id, exitCode}`.
  - preload يكشف دوالاً محددة: `termStart/termList/termReadBuffer/termInput/termResize/
    termKill/onTerm` فقط.
- **دورة الحياة**: pty يُقتل في `window-all-closed`/`before-quit` (نفس فلسفة bgprocs)،
  وخروج الصدفة يصل الواجهة كحدث `exit` فتعرض «انتهت الجلسة» وزرّ إعادة تشغيل.
- **الترميز (تصحيح مثبت بالتجربة)**: خرج البرامج يصل UTF-8 سليماً بلا ضبط، لكن **صدى
  الإدخال** العربي يمر بصفحة ترميز conhost القديمة فيصير «؟؟؟». الحل في term.js: PowerShell
  يُشغَّل بـ `-NoExit -Command [Console]::InputEncoding=[Console]::OutputEncoding=UTF8`
  (وcmd بـ `/K chcp 65001 >nul`) — تحقق آلي: `ARABIC_ECHO=true QMARKS=false`.
  ومنذ 2026-08-24 تُحقن `PYTHONUTF8=1` و`PYTHONIOENCODING=utf-8` في بيئة كل pty (لا
  تطمسان قيمة ضبطها المستخدم): طباعة العربية من Python كانت تفشل بـcp1252 على ويندوز.
- **رمز خروج `run_in_terminal`/`run_command` (تصحيح 2026-08-24)**: كان `runCaptureNow`
  يصفّر `$LASTEXITCODE=0` قبل الأمر، فيبقى **رقماً** حتى حين يفشل cmdlet لا يضبطه أصلاً
  ⇒ لا يُستشار `$?` أبداً ويُعلَن نجاح كاذب. وكان `$?` يُقرأ بعد إسناد فيصف نجاح الإسناد
  لا الأمر. صار التصفير `$null` و`$ok=$?` يُلتقط فور الأمر (نمط `termjobs.js` المثبت).
  **الأولوية تبقى لـ`$LASTEXITCODE` حين يكون رقماً** — رمز الأمر الأصلي هو الحقيقة، فلا
  ينقلب نجاح `... 2>&1` إلى فشل بسبب `NativeCommandError` الذي يضبط `$?=false` في
  PowerShell 5.1. وحين يخالف العلمان (`$?` فشل ورمز الخروج 0) يعود `shellFailed:true`
  فتضيف الأداة سطر تنبيه ولا تكذّب رمز الخروج. العلامة تحمل الآن حقلاً ثالثاً اختيارياً
  (`END:<code>:<ok>`) وصدفتا cmd/sh بلا تغيير (النمط القديم ما زال يُطابَق).
  **أثر مقصود على `verify.js`**: أمر تحقق يفشل كـcmdlet كان يمرّ نجاحاً وصار يفشل صحيحاً.
- **تنبيه «قيد الكتابة»** (‏`files.readText` — العيب ③ في تغذية 2026-08-24): ملف عُدّل
  قبل أقل من `WRITE_WINDOW_MS = 1500` يعود بـ`recentlyWritten:true`، وأداة `read_file`
  تسبق محتواه بسطر تنبيه. **حدّ مُصرَّح به**: يغطي `files.readText` وحدها (‏`read_file`
  للمحوّلات وحقن `@` والعارض)؛ أدوات `Read` الأصلية في Claude وCodex وKimi خارج سيطرتنا.
  ولا قفل هنا — القفل بين عمليات مستقلة غير متاح، والادعاء به أسوأ من الصراحة بالاحتمال.
- **البناء (حرج)**: `npmRebuild: false` في package.json — node-pty 1.1.0 يشحن prebuilds
  تعمل تحت Electron 33 كما هي (تحقق حيّ)، وإعادة البناء تتطلب Visual Studio غير موجود
  على جهاز التطوير. electron-builder يفكّ node-pty تلقائياً إلى `app.asar.unpacked`
  (الوحدات الأصلية لا تعمل من داخل asar)، و`files` يستثني prebuilds غير win32-x64
  ومجلدات المصادر فيبقى المثبّت ~80م.ب.

### لوحة المعاينة المدمجة 🌐 (م-1 — الدفعة 5 «سطر يرى الويب»)

> خطة الدفعة 5 وقرارات النطاق والعزل في `docs/ROADMAP.md` — اقرأها قبل م-2/م-3/م-4.

- **الفكرة**: متصفح مدمج بجانب المحادثة (زرّ 🌐 — لا أمر `/`) يعرض مشروع الويب الجاري
  تطويره. `#midRow` صفّ flex أفقي (RTL: المحادثة يميناً والمعاينة يساراً بمقبض عرض).
- **البنية**: `electron/preview.js` يملك `WebContentsView` (انظر خريطة الملفات — العزل
  الكامل موثّق هناك)؛ المكوّن `<satr-preview-panel>` (Shadow) يرسم الإطار (رأس: ✕/رجوع/
  تقدم/تحديث/حقل عنوان LTR) ويقيس مساحة العرض بـ ResizeObserver ويبلّغها — **العرض
  الأصلي يطفو فوق المساحة** (طبقة نظام فوق كل محتوى المتصفح).
- **العقد (IPC — تنقية في main.js)**: `satr:previewOpen/previewNavigate {url}` (http/https
  حصراً ≤ 2048) · `satr:previewAction {action}` ∈ back/forward/reload ·
  `satr:previewBounds {x,y,width,height}` (أعداد صحيحة 0..20000) · `satr:previewClose`
  (يدمّر العرض — partition الدائمة تحفظ الكوكيز). أحداث عبر قناة مستقلة `satr:preview`:
  `{type:'nav', url, canGoBack, canGoForward}` / `{type:'title', title}` /
  `{type:'loading', loading}` / `{type:'failed', code, desc, url}`. preload يكشفها
  `previewOpen/previewNavigate/previewAction/previewBounds/previewClose/onPreview`.
  طلب السر يبث `secret_request {id,reason}`/`secret_end {id}` على القناة نفسها؛ preload
  يكشف `secretDone(id,done)` فقط، وmain لا يقبل إلا `secret_<32hex>` وboolean ولا قيمة.
  فتح الوكيل يستخدم IPCين منفصلين `previewOpenAgent/previewNavigateAgent` بنفس تنقية URL
  كي لا يُسجَّل origin كثقة مستخدم. `previewElementShot {selector}` يقبل نصاً بلا محارف
  تحكم ≤1000 فقط ويلتقط العنصر المحدد دون بث مصغرة وكيل.
- **اقتراح localhost التلقائي**: الطرفية (terminal-panel) ترصد عناوين
  `localhost/127.0.0.1` في خرج أي تبويب (بما فيها طرفية النموذج 🤖) وتبثّ حدث DOM
  ‏`localhost-url`؛ القشرة تعرض إشعاراً بزرّ «افتح المعاينة» (`chatEl.addActionNotice` —
  مرة لكل عنوان). **حدّ موثّق**: خوادم يشغّلها SDK بأداة Bash الخفية لا تمرّ بالطرفية
  فلا تُرصد (bgprocs يعرف PID لا URL) — عوّضته م-1-ب أدناه.
- **الوكيل يعرف المعاينة (م-1-ب — لقطة مالك من قبول م-1: النموذج فتح كروم بـ
  Start-Process لجهله بالمعاينة)**: ‏(1) `systemPrompt` ملحق في agent.js (preset
  claude_code + append) يعرّف النموذج ببيئة «سطر» ويوجّهه: لا متصفح خارجياً إلا بطلب
  صريح. (2) أداة MCP ‏`open_preview(url)` في خادم satr-terminal الداخلي: تتحقق من
  http/https وتبثّ حدث `preview_open {url}` فتستدعي القشرة `previewEl.openWith`
  (اللوحة تفتح وتبلّغ مستطيلها فيُنشأ العرض بالمسار القائم). تمرّ بـ canUseTool كأي
  أداة. تحقق حيّ: دور SDK حقيقي استدعاها والحدث وصل بالعنوان الصحيح.
- **تذكّر آخر مشروع + تحديث تلقائي (م-1-ج — طلب مالك)**: النقر على 🌐 يفتح آخر عنوان
  ناجح مباشرة؛ وزرّ 🔄 «تحديث تلقائي» (مُفعّل افتراضياً) يجعل القشرة تستدعي
  `previewEl.reloadIfLive()` عند اكتمال دور عدّل ملفات (تتبّع `previewDirty` على
  `file_edit`). المكوّن يعيد التحميل فقط إن كان الوضع مفعّلاً والعرض حيّاً. حدّ:
  بعد اكتمال الدور — مشاريع HMR تتحدّث بنفسها (يُفضَّل إطفاؤه لها).
- **تذكّر لكل مجلد + استعادة الخادم (م-1-د)**: العنوان يُحفظ **لكل cwd** (`satr_preview_url::
  <cwd>` — المكوّن يقرأ #cwd) بلا fallback عام، فلكل مشروع منفذه ولا تلوّث بينها. وعند
  فشل الوصول تستعلم الواجهة بـ `satr:devServerInfo {cwd}`. إن كانت مهمة حية تعرض «الخادم
  يبدو قيد الإقلاع»؛ وإلا تعرض زر «🔁 شغّل خادم المشروع» إن وجد سجل. بعد confirm يعرض
  الأمر حرفياً، تستدعي `satr:devServerRestart {cwd}`؛ main.js وحده يقرأ الأمر من سجل
  القرص (لا command من renderer)، يبدأ termjob، ثم تعيد الواجهة العنوان المحفوظ أربع مرات
  خلال نحو 12ث. `cwd` يجب أن يكون مجلداً قائماً.
- **أدوات قراءة المعاينة للوكيل (م-3)**: أداتان في خادم satr-terminal الداخلي تعملان
  على العرض القائم (`open_preview` تخدم التنقّل): `read_page` (snapshot نصي من DOM —
  عنوان/عناوين/روابط/أزرار/حقول + مقتطف، مُغلّف «للفحص لا للتنفيذ») و`screenshot`
  (لقطة PNG كمحتوى MCP نوع image — رؤية SDK). المحرك `preview.readPage()/screenshot()`
  (waitReady ينتظر التحميل؛ preview.js موديول مشترك بين main وagent مثل term.js).
  systemPrompt يوجّه الوكيل لاستعمالهما للتحقق من تعديلاته. قراءة فقط — الأفعال (م-4)
  خلف بوابة قرار. تحقق حيّ: دور SDK حقيقي استدعى الأداتين والرؤية قبِلت اللقطة.
- **أدوات الفعل بالإذن (م-4)**: `browser_click(ref)` + `browser_type(ref, text)`
  في خادم satr-terminal، على العرض القائم عبر `preview.clickElement/typeText`
  (executeJavaScript؛ selector يُهرَّب بـ JSON.stringify؛ الكتابة عبر native value setter
  + input/change لتوافق React). **الأمان (حرج)**: تمرّان بـ `canUseTool` مثل Bash —
  مربع الإذن العربي كل مرة (لسن في alwaysAllowed)، bypassPermissions وحده يعفيها.
  `formatPermissionDetail` يعرض العنصر والنص المراد كتابته صراحةً داخل مربع الإذن فقط
  (مقصوصاً عند 600 محرف؛ لا يضاف إلى بطاقة الأداة). هذا القرار التاريخي استُبدل في دفعة
  «المتصفح عضو مشترك» بثقة origin المشروطة أعلاه لأن وضع التحكم كان يعفي الأفعال جماعياً.
- **ترقية أفعال المتصفح — لقطة + ref حتمي (2026-07-12)**: نمط Playwright MCP/browser-use
  الصناعي (بحث موثّق): بدل تخمين النموذج مُحدِّد CSS من outerHTML (هشّ)، أداة جديدة
  `browser_snapshot` تعطي لقطة مدمجة لكل عنصر تفاعلي `[ref] role "name"` (تسِم كلاً بسمة
  `data-satr-ref="sN:eN"` — كفاءة رموز عالية)، و`browser_click`/`browser_type` قبِلا **ref**
  (مثل `s3:e5` ⇒ يُحلّ عبر `[data-satr-ref]` حتمياً) مع **إبقاء مُحدِّد CSS تراجعاً**.
  كل لقطة ترفع جيلاً مركزياً مرتبطاً بـ`webContents` الحالي، وأي ref من جيل سابق أو الصيغة
  القديمة `eN` يعيد `stale_ref` قبل لمس DOM أو بوابة الإذن؛ التنقّل وإغلاق/تبديل العرض
  يبطلان الجيل النشط أيضاً. التغيّر الموضعي لا يعيد استخدام الفهارس المحذوفة: العناصر
  التفاعلية الجديدة تحصل على ref متزايدة داخل الجيل نفسه، وتبقى صالحة حتى لقطة/تنقّل تالٍ.
  أُضيفت `browser_navigate(url)` (تنقّل العرض
  القائم) و`browser_wait_for({text|selector, timeout_ms})` (استقصاء دوري للصفحات
  الديناميكية). كله في `preview.js` (snapshot/waitFor/resolve — بلا preload، صفر
  اعتماديات) + كتلة أدوات المتصفح في `agent.js`. تحقّق حيّ (مسبار معزول 8/8، خادم HTTP فعلي): لقطة بأدوار/أسماء/
  refs صحيحة · نقر/كتابة بـ ref يغيّران DOM ويُطلقان input · wait_for (ظهور/مهلة) ·
  تراجع CSS · ref قديم ⇒ `stale_ref` بلا فعل أو إذن · مُحدِّد فاسد ⇒ bad_selector.
- **DOM delta بعد الفعل (H1 — 2026-07-22)**: صار `MutationObserver` نفسه يبني فرقاً
  دلالياً محدوداً للعناصر التفاعلية (`+` إضافة، `-` حذف، `~` تغيير)، ويمنح العنصر الجديد
  ref متزايدة من الجيل النشط. تُعاد الأسطر داخل نتيجة الفعل، مع أولوية الإضافات، وسقف
  `min(1600 bytes, 25% من لقطة العناصر السابقة)`؛ عند القص تُطلب لقطة كاملة صراحةً.
  لا تُعاد delta بعد التنقّل، واللقطة التالية تبطل كل refs القديمة كالمعتاد. أثبت
  `test:preview-member-live` نقر عنصر بديل مرتين متتاليتين بلا لقطة وسيطة، ثم رفض ref
  عند لقطة جديدة. وفي مسبار Claude SDK بـ200 عنصر انخفضت اللقطات `7→1` والأدوار `15→9`
  وحجم نتائج الأدوات `45,951→8,121 bytes`، بينما لم يثبت التشغيل المفرد وفراً مالياً بسبب
  اختلاف توزيع cache creation/read. زوجا `AB/BA` لاحقان دعما وفراً أولياً 19.1% وخفضا
  الزمن 45.1%، لكن `n=2` لا يكفي لادعاء مالي منشور. وفي Kimi ACP خفّض زوجا `AB/BA`
  نتائج الأدوات 82.97% والزمن 44.24%، بلا بيانات تكلفة من ACP. كشف القياس أيضاً موافقة
  ACP زائدة حول MCP المدمج؛ صار `kimi.js` يقبل الغلاف فقط للاسم الصريح
  `mcp__satr__<known-tool>`، مع بقاء بوابة `codexmcp` الداخلية كاملة، فلا يعفى اسم مجرد
  أو خادم خارجي.
- **انتظار أفعال تكيفي (2026-07-22)**: أُلغي انتظار `360ms` الثابت بعد click/type؛
  `MutationObserver` داخل الصفحة يوقظ Promise عند أول mutation حقيقي (مع تجاهل وميض الوكيل)
  أو hash/popstate، و`preview.js` يبقي حد `360ms` مستقلاً في العملية الرئيسية كي لا تعلق
  صفحة مخنوقة أو فعل بلا أثر. `WebContentsView` المعاينة يستخدم `backgroundThrottling:false`
  لأن الوكيل يجب أن يكمل التصفح عند تبديل المستخدم للنافذة. مسبار MCP الحي خفّض وسيط
  النقر من 376.5ms إلى 5ms؛ `test:preview-member-live` يغطي تغيراً متزامناً ومؤخراً 120ms
  وفعل no-op وتنقلاً، مع تنظيف observer في النجاح والفشل.
- **وضع تحكّم المتصفح + النطاقات الموثوقة (دفعة «المتصفح عضو مشترك» — 2026-07-19)**:
  زرّ `#browserCtl` يمنح قيادة سلسة لكنه **لا يعفي كل فعل على كل نطاق**. مجموعة origins
  تعيش بعمر التطبيق في main: localhost/127.0.0.1 (أي منفذ) موثوقان دائماً، وأي origin
  خارجي لا يدخلها إلا حين يفتحه المستخدم بنفسه من شريط العنوان أو يضغط «ثق بالنطاق لهذه
  الجلسة» في طلب الإذن. قراءة `read_page/snapshot/console/network/screenshot/wait/scroll/
  hover/set_viewport/perf` حرة تحت التفويض على أي صفحة؛ `open_preview/navigate/back/forward`
  و`click/type/select/press/evaluate` لا تمر تلقائياً إلا على origin موثوق. الطلب يعرض
  الفعل والعنوان والمدخل، والموافقة الموسعة تثق بالـorigin لا باسم الأداة؛ حارس SDK يسبق
  `alwaysAllowed`، وCodex يمرّر target من `codexmcp` إلى `shouldAutoApproveMcp`.
  للنقر/Enter يجب أن يكون origin الصفحة الحالية موثوقاً، وتُفحص أيضاً وجهة `a[href]` أو
  `form.action` قبل الإعفاء، فلا يقفز رابط من صفحة موثوقة إلى origin جديد بصمت ولا تعفي
  وجهة موثوقة فعلاً صادراً من صفحة وافق المستخدم على زيارتها مرةً فقط.
  `browser_handoff` منح قيادة آمن مستقل، و`bypassPermissions` وحده يتجاوز البوابة كلها.
  التشغيل/الإيقاف والملفات لا تدخل هذا التفويض. الاختبارات: `test:browserorigin` +
  `test:codexmcp` (تصنيف وtarget وثقة/fail-closed).
- **مساعد إعداد المنصات والتكاملات (2026-07-19)**: `browserpolicy.js` طبقة مستقلة بعد
  ثقة origin: submit وEnter داخل نموذج وcross-origin POST والأزرار ذات مفردات
  send/save/deploy/delete/authorize ونظائرها العربية، وكذلك `browser_evaluate`، تُؤكّد
  **كل مرة** بلا «دائماً» ولا موافقة دور؛ `bypassPermissions` وحده يتجاوزها. التنقّل أو
  evaluate ذوا حمولة >1024 محرف أو تطابق `memory.hasSecret` يُعرضان منقّحين، وميزانية
  المهمة 40 فعلاً مؤثراً تُمدّد صراحةً 20 فعلاً. الموافقة الموسعة في طلب مركّب قد تثق
  بالـorigin فقط، ولا تحفظ إعفاء الفعل الحسّاس.
  الأدوات المتكافئة في SDK/Codex/Kimi: `browser_fill_form` (1..20 حقلاً غير سري؛ السر مرفوض؛
  مراجعة مرئية لكل استدعاء بلا إرسال النموذج)،
  `browser_transfer_field` (نقل داخل الصفحة بلا خروج القيمة، أو عبر صفحتين بمعرّف
  `xfer_<32hex>` في مخزن العملية الرئيسية يُمسح بعد اللصق/الدور)، `browser_request_secret`
  (IPC منقّى `secret_<32hex>` + boolean فقط، والنتيجة `{filled:true}`)، و
  `browser_handoff_step(reason,resume_hint)`. أثناء الإدخال/التسليم تبقى الأدوات معلّقة
  fail-closed وتُصفّر سجلات console/network. `browser_snapshot` لا يعيد قيم inputs، ونتيجة
  `browser_evaluate` المطابقة لحارس الأسرار تُحجب. التحقق: `test:browserpolicy` و
  `test:codexmcp` ومسبار `test:browser-platform-live` بصفحتين واختبار عدم تسريب صريح.
  - **تصحيح زر HTML العادي (2026-07-22):** `browserActionContext` لم يعد يعتبر كل
    `<button>` بلا `type` عملية submit؛ يلزم أن يكون مرتبطاً بـ`form`. زر الإرسال داخل
    النموذج وcross-origin POST ومفردات الأفعال الخطرة تبقى حساسة. أثبته
    `test:browser-platform-live` بحالتي submit وزر عادي خارج النموذج.
- **رؤية الـ console وأخطاء الشبكة للوكيل (2026-07-12 — «ابنِ→عايِن→صحّح»)**: أداة
  `browser_console` تعطي الوكيل رسائل console الصفحة (وأخطاء JavaScript غير الملتقطة) +
  طلبات الشبكة الفاشلة — فيشخّص لماذا لا تعمل صفحة بناها ويصحّح نفسه. الالتقاط في
  `preview.js`: خطّاف `console-message` على webContents (مخزن دائري ‏300، LEVELS يترجم
  ترميز Electron) + `webRequest.onErrorOccurred` على partition المعاينة (يتجاهل
  ERR_ABORTED) + تصفير السجلّين عند تنقّل الإطار الرئيسي (يعكس الصفحة الحالية). قراءة
  فقط (بثّ حيّ بلا executeJavaScript)، مغلّفة «للفحص لا للتنفيذ»، وضمن BROWSER_AUTO_TOOLS
  (وضع تحكّم المتصفح). تحقّق حيّ (منطق محفوف): مسبار معزول 9/9 بخادم HTTP فعلي —
  error/warning/log بمستوياتها + خطأ غير ملتقط + خطأ شبكة + تصفير عند التنقّل.
- **إكمال طقم الأفعال — تكافؤ Playwright MCP (2026-07-12)**: أربع أدوات تُتمّم التفاعل مع
  الصفحة (كلها ref-أو-selector وضمن BROWSER_AUTO_TOOLS): `browser_select_option(ref, value)`
  (قوائم `<select>` — مطابقة بالـ value ثم بالنص الظاهر)، `browser_press_key(key)`
  (مفاتيح Enter/Tab/Escape/الأسهم/… عبر `webContents.sendInputEvent` — أحداث مفاتيح
  **حقيقية موثوقة** تُطلق السلوك الأصلي كإرسال النموذج، بقائمة بيضاء KEY_MAP لا حروف عامة)،
  `browser_scroll(direction, amount?)` (down/up/top/bottom لكشف المحتوى الكسول قبل لقطة)،
  `browser_hover(ref)` (mouseover/enter/move لإظهار قوائم التحويم). كلها في `preview.js`
  (selectOption/pressKey/scroll/hover) + كتلة أدوات المتصفح في `agent.js`. تحقّق حيّ
  (منطق محفوف): مسبار معزول 10/10 بخادم HTTP فعلي (اختيار بالقيمة/النص/ref + Enter حقيقي
  يُطلق keydown + تحويم + تمرير أسفل/أعلى + bad_key/not_select/no_option).
- **لقطة عنصر واحد + صقل الوضع (البند 3/4 — 2026-07-12)**: `browser_screenshot_element(ref)`
  (رؤية مركّزة أرخص رموزاً من الصفحة كاملة): RECT_FN يمرّر العنصر للنافذة ويعيد مستطيله
  (viewport = DIP عند zoom=1) لـ `capturePage(rect)`. تحقّق حيّ: عنصر 200×100 التُقط بدقّة
  مقابل صفحة 800×600 (نافذة مرئية — capturePage يحتاج سطحاً مرسوماً). وصقل «وضع تحكّم
  المتصفح» (app.js): إطفاء تلقائي عند «جلسة جديدة» + نقطة «●» مؤشّراً دائماً. **قرار**:
  «تعطيل الزرّ حين لا معاينة» أُسقط عمداً — open_preview ضمن المُوافَق عليها فالوضع يفتحها.
- **مؤشّر النشاط + مؤشّر الوضع + لقطة كاملة (2026-07-12، بالتوازي مع Codex)**: (1) مؤشّر
  «الوكيل يقود المتصفح» حيّ: `previewEl.flashAgentActivity(toolName)` — شارة عابرة
  «🤖 الوكيل <فعل>…» + خيط علوي نابض في رأس اللوحة (المنطقة الوحيدة غير المغطّاة بالعرض
  الطافي فوق pvBox)؛ القشرة تناديها في فرع tool_use والمكوّن يفلتر غير أدوات المتصفح.
  (2) مؤشّر دائم أن «وضع تحكّم المتصفح» مفعّل: شارة «🖱️ تحكّم» + توهّج حافة اللوحة، تُقرأ
  حالته من `aria-pressed` لزرّ `#browserCtl` عبر **MutationObserver** — تكامل **بلا تعديل
  app.js** (كان Codex يحرّره). (3) لقطة الصفحة كاملةً: `screenshot` يقبل `full_page=true`
  ⇒ `preview.screenshotFull` عبر CDP `Page.captureScreenshot` (`captureBeyondViewport`،
  سقف 20000px، سقوط رشيق). تحقّق حيّ: صفحة 2400px التُقطت 783×2400 مقابل 800×600 للعرض.
- **معاينة متجاوبة/محاكاة الأجهزة (2026-07-12)**: زرّ `#pvDevice` في رأس اللوحة يدوّر
  كامل/موبايل(390)/لوحي(768) — `reportBounds` يبلّغ مستطيلاً بعرض الجهاز **موسّطاً** في
  pvBox (الجوانب خلفية اللوحة)، فعرض WebContentsView الأضيق = viewport الصفحة ⇒ تتفاعل
  media queries حقيقةً (لا محاكاة CDP). لقطة الوكيل تعكس مقاس الجهاز. **preview-panel.js
  وحده** (بلا تصادم). الاختيار يُحفظ `satr_preview_device`. تحقّق حيّ: عرض 390 ⇒
  `innerWidth=390` والصفحة تُعيد التدفّق وmedia query تُفعَّل.
- **لوحة Console/أخطاء للمستخدم (الخيار 2 — DevTools مصغّرة، 2026-07-12)**: زرّ 🐞 في
  رأس اللوحة يفتح لوحة سفلية تعرض **حيّاً** رسائل console الصفحة (log/warn/error) وأخطاء
  الشبكة الفاشلة — فيرى **المستخدم** ما يراه الوكيل (أداة browser_console). `preview.js`
  يبثّ أحداث `console`/`neterr`/`console_clear` عبر قناة `satr:preview` القائمة (passthrough
  في main.js `previewSender` — **بلا تعديل main.js**، فصفر تصادم مع Codex)، مع إبقاء
  buffers الوكيل. المكوّن: سقف 500 سطر DOM، شارة عدّاد أخطاء غير مرئية على الزرّ، التصاق
  بالذيل، مسح، وتصفير عند التنقّل. أسفل pvBox فلا يغطّيها العرض الطافي (فتحها يصغّر pvBox
  ⇒ reportBounds). تحقّق حيّ: بثّ error/warning/info + neterr + console_clear عند التنقّل.
- **تطويرات المتصفح المِلكية أ/ب/ج/د (الخيار 2 — 2026-07-12)**: أربعة تحسينات تُكمِل أدوات
  المطوّر المدمجة. **كلها عبر قناة المعاينة القائمة**: الأفعال بلا وسائط تمرّ بـ
  `previewAction` (main.js: أُضيفت للـ `PREVIEW_ACTIONS` الآمنة)، والأحداث الجديدة تُبثّ
  من `preview.js` عبر `previewSender` **بلا تعديل main.js آخر** (صفر تصادم مع Codex).
  - **(أ) DevTools حقيقية بزرّ 🔧**: `action('devtools')` ⇒ `wc.openDevTools({mode:'detach'})`
    (نافذة **منفصلة** تتجنّب قيد الطفو فوق pvBox — لا تختبئ خلف العرض). toggle، والحالة
    الفعلية تصل بحدث `devtools {open}` (يعكس إغلاق المستخدم للنافذة مباشرةً).
  - **(ب) سجلّ الشبكة الكامل**: `webRequest.onCompleted` يلتقط **كل** طلب (لا الفاشل فقط —
    method/url/status/type/fromCache، تجاهل data:/blob:) في `netReqBuf` (سقف 300)، يُبثّ
    حيّاً كحدث `netreq`. للوكيل عبر أداة **`browser_network`** (تُبرز الطلبات ≥400 أولاً —
    ضمن BROWSER_AUTO_TOOLS + systemPrompt)، وللمستخدم في لوحة 🐞 بمرشّح فئة (الكل/Console/
    الشبكة). أحمر لرمز حالة ≥400.
  - **(ج) فحص العنصر المحسّن**: `describe()` في PICK_SCRIPT صار يعيد **box-model** (أبعاد/
    padding/margin/border من getBoundingClientRect+getComputedStyle) و**أبرز الأنماط
    المحسوبة** (id/class/display/position/color/background/font). شريط 🎯 يعرضها شرائحَ
    صغيرة LTR مع عيّنات لون؛ والحقول تُمرَّر أيضاً في حدث `preview-edit` (لاستهلاك app.js
    مستقبلاً — لم يُعدَّل app.js فهو نشط لدى Codex؛ البطاقة المرئية هي ثمرة البند).
  - **(د) مسح تخزين 🧹 + محاكاة شبكة 🚦**: `action('clear_storage')` يمسح كوكيز+localStorage+
    cache+SW لـ partition المعاينة ثم يعيد التحميل (تأكيد confirm في الواجهة). ومحاكاة
    الشبكة عبر CDP `Network.emulateNetworkConditions` (net_online/slow/fast/offline — زرّ
    يدوّرها). **حدّ موثّق**: DevTools تحجز عميل debugger الوحيد؛ إن كانت مفتوحة تفشل المحاكاة
    (`throttle_unavailable`) والواجهة تنبّه «أغلِق DevTools» — استعمل تبويب Network فيها حينها.
  - تحقّق: `node --check` + مسبار معزول يُصرِّف كل سكربتات الحقن العشرة (0 فشل) + إقلاع نظيف
    (`ELECTRON_ENABLE_LOGGING`، 20ث بلا أخطاء JS — العروض المتبقية بيئية GPU/cache).
- **رؤية الويب لـ Codex (الخيار 1 — 2026-07-12)**: إعطاء محرك Codex نفس رؤية الويب التي
  يملكها SDK (open_preview/read_page/browser_snapshot/browser_console/browser_network/
  screenshot) على **نفس** لوحة المعاينة. `electron/codexmcp.js`: خادم MCP‏ **streamable-HTTP
  داخل العملية** (http المدمجة، صفر اعتماديات) يستمع على 127.0.0.1 بمنفذ ورمز عشوائيين،
  كل طلب يتحقّق من `Authorization: Bearer` بزمن ثابت، ويفوّض الأدوات مباشرةً إلى
  `preview.js` (نفس نسخة WebContentsView). `electron/codex.js` يبدأ الخادم **قبل** spawn
  ويحقن إعداده في `codex app-server` عبر تجاوزات `-c`:
  `mcp_servers.satr_preview.url="…"` + `bearer_token_env_var="SATR_MCP_TOKEN"` (الرمز في
  البيئة)، ويوقفه في cleanup. **قرارات مثبّتة بفحص codex-cli 0.144.1 واختبار حيّ**: (1)
  codex يدعم نقل `streamable_http` (رابط+bearer) لا stdio فقط؛ (2) `mcpServers` في طبقات
  الإعداد لا في `thread/start`، لكن `-c` وقت الإطلاق يحقنه **لكل جلسة بلا تلويث
  config.toml العام وبلا عملية جسر**؛ (3) الرمز يُقرأ من **متغيّر بيئة** لا حرفياً. اختبار
  حيّ بـ codex حقيقي: `initialize → tools/list → satr_preview=ready` (بينما فشلت خوادمه
  الأخرى). إشعار `mcpServer/startupStatus/updated` (كان يُتجاهَل) يُرصد الآن لفشل
  satr_preview فقط (تدهور رشيق: Codex يعمل بلا رؤية إن فشل). في دردشة Codex تبقى الأدوات
  متاحة دائماً: زر «متصفح» مفعّل = القراءة حرة والفعل/التنقّل مشروط بثقة origin، ومطفأ =
  كل tools/call يمرّ بمربع الإذن العربي (بما فيه open_preview والقراءة)، بينما `browserControl:false`
  الصريح في المراجع/العصف يعطّل الخادم كلياً. open_preview يبثّ
  `preview_open` للواجهة (app.js يفتح اللوحة generically لأي محرك). codex.js محجوز لـ Claude
  (حدّ ملكية الملفات في الفريق الثلاثي).
  - **طقم الأفعال الكامل (دفعة تالية — 2026-07-12)**: أُضيفت بقية أدوات SDK بتكافؤ كامل:
    browser_screenshot_element/wait_for/scroll/hover (رؤية/قراءة — بلا إذن) +
    browser_click/type/select_option/press_key (تُغيّر الصفحة). **الأمان (حرج)**: Codex
    **لا** يبوّب نداءات MCP (طبقة موافقته للأوامر/الملفات فقط) فالأفعال كانت ستُنفَّذ بلا
    سؤال — خطر مع صفحات غير موثوقة (حقن برومبت). الحل: `codexmcp.js` يمرّر الأفعال الأربع
    التي تُغيّر الصفحة عبر `deps.requestPermission(tool, input)` الذي يوفّره codex.js فيبثّ
    `permission_request` (مربع الإذن العربي نفسه) وينتظر الردّ عبر `mcpPerms` +
    `resolvePermission` (قناة أذونات الأوامر نفسها). في وضع التحكم لا تعفي «موافقة دائمة»
    قديمة فعلاً على origin جديد؛ زر الثقة يضيف origin فقط. `bypassPermissions` وحده يتجاوز؛
    الرفض/إيقاف الدور يفكّ الإذن المعلّق. أدوات المتصفح كلها مصنّفة
    `browser` وتُبوّب، بينما get/list_background_tasks وحدهما `read` بلا إذن. تحقّق:
    `npm run test:codexmcp` (يشمل تصنيف browser/read/exec/target وfail-closed) +
    `eval:agent` 12/12 + إقلاع نظيف.
  - **مهلة أداة MCP لأفعال الإذن (إصلاح اختبار يدوي — 2026-07-13)**: بوابة الإذن أعلاه
    تُبقي استدعاء أداة MCP معلّقاً (‏`await requestPermission` في guard) حتى يوافق المستخدم
    على مربع الإذن. مهلة Codex الافتراضية على أداة MCP قصيرة، فكانت تُلغي الاستدعاء قبل أن
    يلحق المستخدم الموافقة — فيتلقّى النموذج فشلاً ويقترح `bypassPermissions` بدل انتظار
    الإذن (كشفه اختبار يدوي: الوكيل «لم يسأل» وطلب تجاوز الأذونات يدوياً). الحل في `codex.js`
    عند spawn: حقن `mcp_servers.satr_preview.tool_timeout_sec=600` (+`startup_timeout_sec=30`)
    عبر `-c` ليتّسع لموافقة بشرية؛ الأدوات القرائية لا تنتظر إذناً فلا تتأثر، وإيقاف الدور
    يفكّ أي إذن معلّق فلا تعليق دائم. مثبّت حيّاً: codex 0.144.1 يقبل المفتاحين مع
    `--strict-config` بلا `unknown configuration field` (بـ CODEX_HOME نظيف).
  - **موافقة MCP الخارجية الفارغة (إصلاح رفض صامت — 2026-07-22)**: Codex 0.144.3 مع
    `approvalPolicy:on-request` يرسل قبل كل أداة من `satr_preview` طلب
    `mcpServer/elicitation/request` بنموذج `object` فارغ ووسم
    `_meta.codex_approval_kind="mcp_tool_call"`. كان معالج النماذج يعتبره غير مدعوم ويردّ
    `decline`، فتفشل حتى `list_background_tasks` برسالة `user rejected MCP tool call` بلا بطاقة.
    `codex.js` يقبل هذه البوابة الخارجية تلقائياً **فقط** لخادم `satr_preview` المدمج وبالبصمة
    الفارغة الدقيقة؛ ثم تبقى بوابة `codexmcp.js` الداخلية صاحبة القرار الفعلي (قراءة حرة،
    وثقة origin، وأفعال حساسة، وميزانية، و`requestPermission`). الخوادم الخارجية والنماذج ذات
    الحقول لا تُعفى. يثبت ذلك `test:codex-contract` ومسباران حيان: القراءة تنجح بلا إذن، و
    `open_preview` الخارجي يصل إلى `permission_request` الداخلي بدل الرفض الصامت.
- **اعتراض المتصفح الخارجي + التسليم البشري (دفعة «تحكم الوكيل الكامل» — 2026-07-18)**:
  علاج «نسيان» النموذج للمعاينة المدمجة بثلاث طبقات + ميزة تسليم القيادة للمستخدم:
  - **الاعتراض (الشق 1)**: `electron/browserguard.js` (انظر خريطة الملفات) يستهلكه
    المحرّكان — في SDK اعتراض داخل `canUseTool` لأمر `Bash`/`run_in_terminal` يفتح
    متصفح نظام خارجي ⇒ `deny` برسالة عربية توجّه لأدوات المعاينة (قبل مربع الإذن وقبل
    أي «موافقة دائمة» — يعمل حتى في bypass/acceptEdits)؛ وفي Codex الحاجب القائم في
    `codex.js` صار يستورد الدالة المشتركة. **ذكر المستخدم للمتصفح الخارجي** («افتح
    كروم»، in chrome…) في رسالة الدور لا يعطّل الحاجب بل يحوّله إلى **مربع إذن قسري
    لمرة واحدة** في المحرّكين — يتخطى «الموافقة الدائمة» ووضع auto
    (`promptRequestsExternalBrowser` — heuristic؛ ملاحظة مراجعة Codex المثبّتة: التعطيل
    الكلي كان يجعل الذكر العابر + موافقة Bash دائمة تنفيذاً صامتاً). التوجيه قُوّي في المحرّكين:
    المعاينة **للويب العام لا localhost فقط** + «اعرض تنفيذ الخطوات اليدوية بنفسك».
  - **التسليم البشري (الشق 2 — `browser_handoff(reason)`)**: أداة في خادم satr-terminal
    ‏(SDK) وcodexmcp ‏(Codex) — حين تحتاج خطوة بيانات حساسة (تسجيل دخول/2FA) يسلّم
    الوكيل قيادة المعاينة للمستخدم يدخلها بيده في WebContentsView (الكوكيز في partition
    الدائمة تعيش عبر التشغيلات). تبثّ `handoff_request {id, reason}` ⇒ شريط 🤝 في
    `preview-panel` بزرّي «استلمت ✓»/«إلغاء» ⇒ الردّ `satr:handoffDone {id, done}`
    (منقّى `SAFE_HANDOFF_ID`، ‏boolean فقط — preload يكشفه `handoffDone`) ⇒
    `resolveHandoff` على مقبض المحرك، ثم `handoff_end {id}` يخفي الشريط (يغطي حسم
    الإيقاف). النتيجة للنموذج نصية فقط («استلم — خذ snapshot جديداً» / «ألغى») بلا أي
    محتوى صفحة. **الأمان (قرار مالك، fail-closed)**: أثناء التسليم علم `handoffActive`
    في `preview.js` المشترك يعلّق **كل** أدوات الوكيل رؤيةً وفعلاً (`{error:'handoff'}`
    من الدوال الوكيلية الـ14؛ `navigate`/`open_preview` المشتركتان مع الواجهة تُحجبان
    عند موقع الأداة في المحرّكين)، وعند نهاية التسليم `endHandoff` **يصفّر سجلّي
    console/الشبكة** (قد تحمل أسراراً أُدخلت أثناءه). أزرار الواجهة (رجوع/تحديث/العنوان/
    التسجيل) لا تُحجب — المستخدم هو القائد. `browser_handoff` ضمن BROWSER_AUTO_TOOLS
    (منح القيادة للمستخدم فعل آمن fail-safe)، ومهلة أداة MCP في Codex رُفعت
    600⇒**1800ث** لتتّسع لدخول + 2FA. إيقاف الدور يفكّ التسليم بالإلغاء في المحرّكين.
    الاختبار: `test:browserguard` (نقي 32) + توسعة `test:codexmcp` (64 — دورة كاملة
    استلام/إلغاء/تعليق/fail-closed).
- **شفافية المتصفح المشتركة (دفعة «المتصفح عضو مشترك»)**:
  - `click/type/select/hover/scroll/press` تومض outline ذهبياً **داخل الصفحة** قبل الفعل.
    الأفعال الأربعة المؤثرة تعيد `{ok,navigated,dom_changed,note?}` بعد رصد URL و
    `MutationObserver` قصير؛ عدم رصد أثر يُقال للنموذج صراحةً بدل نجاح وهمي. الكتابة تدعم
    `contenteditable` عبر focus+selection+beforeinput/execCommand/input.
  - `screenshot` و`browser_screenshot_element` يبثان `agent_screenshot` بمصغرة PNG ≤360px/
    512KiB عبر قناة `satr:preview`؛ القشرة تضيفها إلى بطاقة أدوات الدور، والنقر يفتح عارضاً
    مكبراً. صورة MCP الأصلية تبقى للنموذج. لقطة 🎯 تستخدم IPC صامتاً فلا تُسجّل كلقطة وكيل.
  - كل خطأ console/شبكة في لوحة 🐞 له زر «🤖 أصلحه» يرسل سياقاً منظماً كدور عادي. بعد
    `reloadIfLive` تُجمع الأخطاء الجديدة 4.2ث وتظهر مرة لكل موجة في `addActionNotice`
    بزر «أرسلها للوكيل».
  - شريط 🎯 يضيف «اشرح/أصلح/حسّن»، ويلتقط العنصر تلقائياً ويرفق PNG عبر مسار صور
    المحرّكين الأصيلين؛ المحوّلات النصية تتراجع للوصف. outerHTML يبقى محتوى غير موثوقاً
    مقتطعاً. رأس المعاينة يعرض شارة خادم cwd خضراء، أو رمادية بزر تشغيل من سجل devservers.
- **عدة التحقق الذاتي**: الأدوات المتكافئة في SDK/Codex/Kimi هي `browser_evaluate` (act؛ تعبير
  ≤8000، CDP timeout، نتيجة ≤48K)، `browser_set_viewport` (read؛ 240..1920×240..1200
  ويعيد innerWidth الفعلي)، `browser_perf` (read؛ navigation/resources/طلبات فاشلة)، و
  `browser_back/browser_forward` (navigate مع target من سجل NavigationHistory). تدخل
  `envbrief` و`satr-guide` وحارس الجرد تلقائياً.
- **قياس قرائية الحرف العربي — `browser_readability`** (2026-08-27): أداة **قرائية محضة**
  (بلا مدخلات) في المحرّكات الثلاثة، تقيس الصفحة المفتوحة في المعاينة على أربعة محاور:
  (1) **رسو اتجاه كل فقرة بالبكسل** عبر `Range.getBoundingClientRect()` لأول محرف مقابل
  صندوق العنصر، ومقارنته بحسم إحصائي (`ar*2 >= lat`) — وهو العطل الذي **لا تكشفه**
  `getComputedStyle(el).direction` لأنها تعيد `rtl` الموروثة بينما الفقرة رست LTR
  (نفس مقياس `scripts/arabic-rtl-probe.js`)، ووصف المخالفة يسمّي بصمة `plaintext/dir=auto`
  حين يبدأ النص برمز لاتيني؛ (2) التباين مقابل WCAG (‏4.5/3 حسب الحجم والوزن) مع تصنيف
  خلفية الصورة/التدرّج «غير محدَّد» بلا تخمين؛ (3) التجاوز الأفقي للمستند وللعنصر؛
  (4) أسر الخطوط المستعملة على نصّ بالحرف العربي وغير المحمّلة في الصفحة (`document.fonts`)
  ⇒ سقوط صامت إلى خط النظام. النطاق **عائلة الحرف كلها** (‏`OBS-037`): عربي + ملحقه +
  الموسّعان أ/ب + شكلا العرض — أوسع من نطاق `text-dir.js` عمداً لأن المقيس مشاريع المستخدمين.
  - **لماذا تدخل `AUTO_SAFE_TOOLS` وحدها من أدوات الفحص البنيوي**: قرائيتها المحضة
    **مُثبَتة بفحص حيّ** لا مفترضة — `test:readability` يفحص DOM بعد القياس ويشترط صفر
    `data-satr-ref` وصفر عنصر مُقحَم وصفر تمرير. بذلك تُغلق حلقة «قِس ← أصلح ← أعد القياس»
    بلا مقاطعة المستخدم عشرات المرات، بخلاف `browser_evaluate` التي تُؤكَّد كل مرة بلا
    «دائماً». ولهذا بقيت `browser_snapshot` (تكتب `data-satr-ref`) و`browser_scroll`
    (تطلق lazy-load) و`browser_hover` خارج القائمة كما كانت.
  - **الصدق في الناتج**: `unseen:{shadow_roots,iframes}` يُصرَّح به لأن `querySelectorAll`
    لا يخترقهما (القيد نفسه في `SNAPSHOT_FN`/`READ_SCRIPT`) — فلا يُقرأ الصمت «صفر
    مخالفات»؛ و`viewport` يعيد `innerWidth` الفعلي مع سبب التضييق (‏`OBS-028`) لأن الحكم
    على التجاوز الأفقي بعرض مقصوص حكمٌ مضلّل؛ و`total_findings` يذكر الإجمالي قبل القصّ.
    السقوف: 200 عنصراً ممسوحاً · 20 مخالفة مرتّبة بالأسوأ · ناتج ≈2ك.ب.
  - **نسخة صياغة واحدة**: `codexmcp.formatReadability` يستهلكها الخادم و`agent.js` معاً
    (نمط `whyClosed`) فلا يتباعد تقرير المحرّكين لقياس واحد. والسكربت في العالم المعزول
    (‏`runIsolated` — `OBS-018`) لا في main world.
  - **الحارس**: `npm run test:readability` (‏Electron حيّ، داخل `test:full`) يستخرج
    `READABILITY_FN` من `preview.js` **وقت التشغيل** ويشغّله على fixture فيه العيوب الأربعة
    مزروعة — فلا يقارن نسخةً بنسخة (درس `test:langmetric`)، ويضيف عقوداً ساكنة على مواضع
    التسجيل الستة فيفشل عند أي موضع منسيّ. مُثبَت أنه يعضّ: شُغِّل قبل الوصل فسقطت الخمسة.
- **إعلان تضييق `browser_set_viewport`** (‏`OBS-028` + تغذية راجعة 2026-08-24): عرض
  اللوحة سقفٌ للطلب دائماً (‏`effectiveBounds` يقصّه)، وكان التجاوز **صامتاً** — طلب
  `1280` يعيد `ok:true` و`actual:390` بلا تفسير، فيتعذّر الحكم على تخطيط سطح المكتب.
  الآن تبلّغ اللوحة الوضع النشط مع المستطيل (`previewBounds(x,y,w,h,device)` — معامل
  خامس اختياري، والاستدعاءات بأربعة تبقى صالحة)، و`main.js` ينقّيه بقائمة مغلقة
  `mobile|tablet` (أي قيمة أخرى ⇒ `null` بلا إفشال الطلب)، و`setViewport` يعيد
  `clamped:true` و`note` عربياً يسمّي السبب — وضع محاكاة الأجهزة باسمه أو ضيق اللوحة —
  ويذكر العلاج. الأداة تطبع الملاحظة **قبل** JSON في المحرّكين فلا تُدفن. لا تغيير في
  حدود المقاس ولا في سلوك «كامل» (‏`mode` يُبلَّغ فقط حين يضيّق العرض فعلاً).
- **عقد اللقطة وحصانة العالم المعزول (دفعة «صقل متصفح سطر» — OBS-013/014،
  2026-08-15)**: علاج تنازع التحكم بين المستخدم والوكيل (مسبار الاستنساخ أثبت أن
  تغيير الحالة وتبديل معنى العنصر كانا **صامتين** — الوكيل رأى «حفظ» ونفّذ «حذف»
  بـ`ok:true`). **الكشف في العملية الرئيسية حصراً** (المسبار الحاجز
  `scripts/browser-guard-probe.js` أثبت أن `sendInputEvent` يُطلق `input-event`
  وأن أفعال `executeJavaScript` الوكيلية لا تمر به): عدّاد إدخال ملتزم
  (‏`mouseDown`/`rawKeyDown`/`keyDown` فقط) في `wireEvents`، وكل لقطة تحفظ
  `leaseUserRevision`، وأي فعل `act` يمر **بفحصين** (قبل بوابة الإذن عبر
  `preview.leaseError()` المصدَّرة — تستدعيها الأغلفة، وبعدها قبل التنفيذ) ⇒
  تدخّلٌ بعد اللقطة يرفض الفعل `input_changed` **حجباً شاملاً v1 بقرار مالك**
  (التخفيف لدرجتين لاحقاً بأرقام محلل السجلات). `pressKey` يمر بمسار الإدخال
  فيستهلك العقد بنفسه (لا provenance في `input-event` — الالتباس يفشل مغلقاً).
  **بصمة الهدف** `role+name+tag(+href/type)` بتطبيع فراغات فقط (لا حذف أرقام)
  تُحسب في مرور `SNAPSHOT_FN` وتُخزن في main (لا تعبر للنموذج)، وحلّ الهدف +
  المقارنة + التنفيذ في نداء `executeJavaScriptInIsolatedWorld` واحد
  (‏`AGENT_WORLD_ID=1013` — على `WebContents` نفسه لا `WebFrameMain`؛ يقاوم صفحة
  تخرّب `querySelector` في main world) ⇒ تباعدٌ يرفض `target_changed` بالاسمين
  (was/now)، واختفاء السمة بعد وجودها في الجيل يشخَّص `ref_removed`. البصمة
  **كاشف انجراف لا برهان أمني**. الإبطال يشمل الآن `endHandoff` و`startPick`
  (عطل اكتشفه العصف الثلاثي). حدث `control_conflict` على قناة `satr:preview`
  تعرضه اللوحة شارة عابرة غير حاجبة — أزرار المستخدم لا تُحجب أبداً. **دلالة
  النتيجة الصادقة**: `dispatched`/`effect_observed`/`satisfied` (‏الأخير
  لـtype/select فقط ويعود فوراً بلا مهلة عند تحققه) مع بقاء `dom_changed`
  للتوافق، والرسائل العربية الثلاث نسخة واحدة في `codexmcp.js` يستهلكها
  `agent.js` (‏`whyClosed` مصدَّرة). توجيه اللقطة الكاملة (قرار مالك): وصف
  `screenshot` وenvbrief يشرحان ضيق اللوحة، و`screenshot({includePageMetrics:true})`
  يعيد `page_metrics` فيُلحق تلميح «الصفحة أطول من المعروض N×» عند ≥3×.
  المهلات (‏360/250/150ms) **لم تُلمس عمداً** — يحرسها عقد حي والأرقام لم تبرر
  لمسها. محلل التوزيع `scripts/browser-session-audit.js` (قراءة فقط فوق
  `~/.claude/projects`): من 25 جلسة — حصة اللقطات البصرية **99.7%** من البايتات
  ووسيط دور النموذج بعد `screenshot` ‏12.1s (انظر OBS-016). الحارس القطعي
  `test:preview-lease` (‏Electron حي، 11 عضّة مستعادة) داخل `test:full`، مع
  توسعة `test:codexmcp` (‏147) و`test:browser-member-live` (شارة التنازع).
  خام الدفعة كله (عصف/نقد/عقد مجمَّد/تقارير) في `D:\sater\prompts-browser-bs\`.
- **متانة العرض والتنزيل**: partition المعاينة يعترض `will-download`، ينقّي الاسم ويختار
  مساراً فريداً داخل Downloads ثم يبث المسار الفعلي أو الفشل؛ لا حفظ صامت. خطاف
  `certificate-error` يقبل شهادة ذاتية لـ`https://localhost`/`127.0.0.1` حصراً ويرفض
  الشهادة السيئة لأي origin خارجي. `test:preview-member-live` يغطي الفعل/الوميض/
  contenteditable/evaluate/viewport/history/download وحصر الاستثناء، و
  `test:browser-member-live` يغطي المصغرة/أصلحه/موجة الأخطاء/🎯/شارة الخادم تحت CSP.
- **تسجيل فيديو التصفح (م-5، ترقية «استوديو البروموا الوكيلي» — المرحلة 1)**: زرّ ⏺
  يختار `16:9` ‏(1920×1080) أو `9:16` ‏(1080×1920) أو `1:1` ‏(1080×1080)، ثم يطلب
  إذناً صريحاً ويفتح `BrowserWindow` مرئية، مستقلة، sandbox، بلا preload أو واجهة «سطر».
  `promocapture.js` يحمّل URL المنتج وينتظر استقراره، ويستدعي
  `desktopCapturer.getSources({types:['window']})` ويطابق `HWND` لمعرّف النافذة حصراً.
  على Electron 33/Windows ثبت حياً أن `getSources` قد لا يدرج نافذة **العملية نفسها** رغم
  ظهورها؛ عندها فقط يستخدم `BrowserWindow.getMediaSourceId()` المباشر (`window:HWND:1`)
  للنافذة المنشأة، وتمنح بوابة `setDisplayMediaRequestHandler` إطار المنتج نفسه حصراً.
  لا title fallback ولا شاشة كاملة ولا source id من renderer.
- الواجهة تستقبل المعرّف من main وتطلب `getUserMedia` بقيود
  `chromeMediaSource:'desktop'` + المعرّف + `30fps`، ثم `MediaRecorder` مباشرةً؛ أزيلت
  حلقة `capturePage`/PNG و`canvas.captureStream(8)` من مسار التسجيل. مؤشر ⏹ أحمر نابض
  يبقى في رأس المعاينة، والإيقاف/انتهاء الدور/إغلاق التطبيق يوقف المسارات ويغلق نافذة
  المنتج. التنزيل محلي في Downloads باسم `satr-promo-segment-*` منقّى وفريد ولا يُرفع.
- الأدوات المتكافئة: `promo_record_start({aspect,url?})` و`promo_record_stop()` أفعال
  `neverAlways` في SDK وCodex وKimi، و`promo_list_segments()` قراءة. أدوات القيادة هي أدوات
  المتصفح القائمة لأن `preview.js` يوجّهها مؤقتاً إلى نافذة المنتج؛ لا أدوات قيادة جديدة.
  IPC الواجهة محددة (`promoCaptureStart/Stop/Ready/Commit/Abort`)؛ `confirmed:true` لازم،
  وmain يرفض `sourceId` من renderer. تحقق Electron الحي: `ERR_FAILED=false`، stream واحد،
  `frameRate=30`، MediaRecorder‏ MP4/H.264 ذو `ftyp` وBlob غير فارغ، ثم إغلاق كامل.
- **استوديو الإنتاج (ترقية م-5 — المرحلة 2)**: الأداة المتكافئة
  `promo_propose_storyboard({scenes})` تقبل 1–40 مشهداً، كل واحد `segment_path|asset`
  محلياً داخل Downloads، و`caption/duration_ms/transition/music/voice` اختيارية، ومعها
  `trim_start_ms` و`fit` و`caption_position/style` ومستويات `clip/music/voice_volume`. main
  يرفض URL بعيداً، مساراً خارج Downloads، امتداداً غير وسائطياً، أو مدة خارج
  `250..120000ms`؛ الأداة تبث الاقتراح فقط ولا تعتمد أو تصيّر. إن توفرت أداة Higgsfield
  ‏`generate_audio` للوكيل، يولّد الموسيقى/التعليق بها ثم **ينزّل الملف أولاً** إلى
  Downloads ويشير إلى مساره المحلي؛ الاستوديو لا يحمّل URL بعيداً ولا يرفع أي أصل.
- `<satr-promo-studio>` حوار Shadow بأنماط `adoptedStyleSheets` وtokens، ويُدار عبر
  `surfaceCoordinator` كي تُحجب WebContentsView الأصلية أثناءه. يعرض المشاهد ويتيح أزرار
  إعادة الترتيب والتكرار، قص البداية والمدة، ملاءمة cover/contain، تحرير موضع ونمط العنوان
  العربي، ضبط مستويات المقطع والموسيقى والتعليق، حذف مشهد، وإعادة تسجيله عبر مسار المرحلة 1.
  كل تعديل يسقط الاعتماد؛ زر «صيّر» لا يعمل حتى يضغط
  المستخدم «اعتماد الخط الزمني» صراحةً (الوكيل يقترح ولا يقرر النتيجة النهائية).
- المُصيّر صفري الاعتماديات في `promo-renderer.js`: `<video>`/`Image` تفك الأصول المحلية،
  ويطبق قص البداية ثم يرسمها `canvas` بنسبة storyboard مع cover/contain و`cut` أو fade،
  ويطبع العنوان بخط IBM Plex Sans Arabic واتجاه `rtl` في أعلى/وسط/أسفل بصندوق أو نمط بسيط.
  Web Audio يمزج صوت المقطع + music + voice بمستويات كل مشهد إلى
  `MediaStreamDestination`؛ تُضم مساراته إلى `canvas.captureStream(30)` ثم MediaRecorder
  يخرج `satr-promo-final-*` إلى Downloads. التصيير **فوري بزمن الجدار**: 60 ثانية فيديو
  تستغرق نحو 60 ثانية، وتبقى نافذة الاستوديو مفتوحة خلاله.
- **مقايضة واعية**: التصيير المبني على `requestAnimationFrame` وMediaRecorder غير حتمي
  frame-perfect وقد يسقط/يكرر إطاراً تحت الحمل. `VideoEncoder:false` في Chromium الحالي
  وffmpeg ممنوع كاعتمادية يحافظان على النواة المفتوحة صفريّة الاعتماديات؛ ترقية مستقبلية
  ممكنة باكتشاف ffmpeg اختياري مثبت لدى المستخدم، لا بشحنه ولا بجعله شرطاً.
- تحقق `test:promo-studio` الحي تحت CSP الصارمة يولّد مقطعين، يغيّر ترتيبهما ومدتهما
  وعنوانهما والموسيقى، ويختبر القص وcontain والتكرار وموضع/نمط العنوان ومستويات الصوت،
  ويمر ببوابة الاعتماد وإعادة التسجيل، ويمزج WAV محلياً من `file:` مع عنوان RTL ثم ينتج
  MP4 غير فارغ. `media-src 'self' blob:` هو التوسعة الوحيدة للقالب.
- **الحاوية mp4 مفضّلة (دفعة «mp4»)**: `pickRecMime()` يفاضل `video/mp4;codecs=avc1…`
  أولاً ثم webm عبر `MediaRecorder.isTypeSupported`، والنوع والامتداد يتبعان المُختار.
  التنزيل ليس صامتاً: `previewrecording.js` يعترض أسماء `satr-preview-*` و
  `satr-promo-segment-*` القادمة من renderer الرئيسي، يثبت مساراً فريداً داخل
  `app.getPath('downloads')`، ثم يبث
  `preview_recording_saved` بالمسار الفعلي لتعرضه المحادثة. **قرار مثبّت بمسبار حيّ**:
  Electron 33 (Chromium 130) يدعم MediaRecorder بحاوية mp4
  (H.264) فلا حاجة لـ muxer ولا ffmpeg ولا أي اعتمادية — MediaRecorder يغلّف داخلياً.
  مسار WebCodecs (VideoEncoder) **غير متاح في هذا المحرك** (المسبار: `VideoEncoder:false`)
  فلا يُعوَّل عليه. السقوط لـ webm تلقائي إن غاب دعم mp4 مستقبلاً.
- **التحرير بالتأشير (م-2)**: زرّ 🎯 يبدأ وضع تحديد — `preview.startPick()` يحقن سكربتاً
  في الصفحة المعزولة عبر `executeJavaScript` يعيد **Promise يُحلّ عند نقر المستخدم** على
  عنصر (outline ذهبي يتتبّع المؤشر + يمنع تفعيل الروابط + Escape/إلغاء ⇒ null). لا
  preload في العرض ⇒ قيمة الـ Promise هي مخرج البيانات الوحيد. يلتقط `{selector تقريبي،
  tag، outerHTML مقتطع، نص}` ⇒ شريط ملخّص + حقل طلب ⇒ حدث `preview-edit` ⇒ القشرة تركّب
  سياقاً وترسله **كدور عادي** (مسار send — صفر عقد جديد). IPC: `previewPick`/
  `previewPickCancel`. **أمان**: outerHTML من صفحة غير موثوقة يُغلَّف كـ «محتوى» ويُقتطع
  (حقن برومبت محتمل موثّق — م-2 وصف فقط، المستخدم يبادر ويرسل).
- **حجب المعاينة أثناء مربع الإذن (إصلاح لقطة مالك)**: WebContentsView طبقة نظام فوق كل
  DOM — فمربع الإذن (perm-dialog) كان يختبئ خلف المعاينة، والوكيل يعلّق بانتظار ردّ لا
  يُرى (خاصة في acceptEdits حيث تمرّ Edit بلا إذن لكن Bash/أدوات المعاينة تطلبه). الحل:
  perm-dialog يبثّ `perm-visible {visible}` عند كل ظهور/إخفاء، ومنسّق الأسطح في القشرة ينقله
  إلى `held` ويستدعي `previewEl.holdForDialog(visible)` فتُخفي العرض الأصلي (previewBounds صفر)
  أثناء المربع ثم تعيده بقياس حي بعد الرد. الحوار يحبس التركيز ويعيده المنسّق إلى المصدر.

### نظام التصميم (الدفعة 4.1)

> المرجع الحاكم في `docs/DESIGN-SYSTEM.md` — اقرأه قبل أي عمل على الواجهة أو إضافة عنصر UI جديد.

- **Design Tokens في `:root`** (`src/styles/base.css`): الرمادية الدافئة مقتبسة **قيماً** من مقياس
  Sand الداكن في Radix Colors (نسخ قيم لا تثبيت حزم)، والدلاليات من Grass/Red الداكنين.
  الهوية الذهبية `--gold: #D9A441` ثابتة. **الأسماء القديمة باقية تعمل**
  (`--bg/--surface/--surface-2/--border/--text/--text-dim/--gold-soft/--green/--red`)
  وأُضيفت درجات جديدة: `--bg-deep` (الطرفية/عارض القراءة — بديل ‎#0B0E13 الصلب)،
  `--surface-3`، `--border-dim/-strong`، `--text-faint` (أرقام الأسطر)، `--gold-strong/-border`،
  `--green-soft/-border`، `--red-soft/-border`، وظلال (`--shadow-pop/-panel/-modal`)
  وحركة موحّدة (`--ease`, `--dur`). **قاعدة حاكمة**: كل لون عبر متغيّر — لا تُدخل ألواناً
  صلبة جديدة في CSS (شرط عمل الوضعين معاً).
- **السلالم الحاكمة**: `--z-base..--z-system` و`--space-0..7` و`--radius-xs..pill` بالقيم
  المرجعية في `docs/DESIGN-SYSTEM.md`. الترحيل عند لمس المكوّن فقط؛ WebContentsView خارج سلم CSS.
- **حارس التصميم الآلي (دفعة «design-guard»)**: `npm run test:design-guard`
  (`scripts/design-guard-test.js`) يفحص src/ui وindex.html: ألوان صلبة خارج tokens،
  ‏z-index رقمية خارج سلّم `--z-*`، وقيم px داخل تصريحات `border-radius` خارج سلّم
  `--radius-*` (العدّ على كل قيمة في التصريح لا بدايته — ملاحظة مراجعة Codex: فحص
  البداية يُمرّر «var(--radius-md) 11px»)، وسمات مضمّنة (CSP). دفعة «سلّم الزوايا»
  رحّلت المرحلة أ (43 موضعاً مطابقاً حرفياً — صفر تغيير بصري) ثم المرحلة ب باعتماد
  المالك (24 قيمة بين الدرجات قُرّبت: 5→sm، 7→md، 3→xs، 9→md، 13→lg، **10→lg** قرار
  مالك، 14→xl توحيداً مع verify-config، 20→pill، والمركّبات يدوياً)؛ baseline المتبقي
  زوايا هوية فقاعتَي المحادثة حصراً (3px و3px 14px 14px 3px — لا تُقرَّب).
  ودفعة «سلّم المسافات» (قرارا مالك): الجرد أظهر أن 6px (×37) و10px (×27) إيقاع
  الواجهة الفعلي خارج السلّم النظري ⇒ **وُسّع السلّم** بدرجتين وسيطتين
  `--space-1h: 6px` و`--space-2h: 10px` (السلّم يخدم القائم لا العكس — موثّق في
  DESIGN-SYSTEM.md §4.2) ثم رُحّلت 260 قيمة مطابقة + **مرحلة ب** (137 تقريباً
  معتمداً: 5→1h، 7→2، 9→2h، 11/13→3، 14/15/17/18→4، 22/26→5، 30→6 — التعادل
  لأعلى) داخل تصريحات gap/padding/margin، كل قيمة في التصريح المركّب (درس
  الفقاعة). regex الحارس مربوط ببداية التصريح بـ lookbehind (ملاحظة مراجعة Codex:
  بدونه تُلتقط --card-padding/scroll-padding خطأً). الصغائر 1/2/3px حدود/إزاحات
  خارج السلّم ولا يفحصها الحارس؛ baseline المتبقي **7 قيم حصراً** — 20px (×6)
  و28px (×1) على بعد 4px من الجارين، قرار مالك: تبقى (لا تستحق زحزحة مدركة). **baseline صريح بالأسباب**: زيادة
  تفشل (انتهاك جديد) ونقص يفشل أيضاً («حدّث baseline» — تشديد تدريجي). المستثنى الموثّق:
  لوحة ANSI في terminal-panel (سطحا الكود داكنان دائماً) + مقارنة runtime في preview-panel +
  ‏z-index المحلية داخل الطرفية في base.css. الدفعة نفسها رحّلت النص-على-لون إلى tokens
  `--on-gold/--on-green/--on-danger` (أُكملت تعريفاتها في الوضع الفاتح — كانت خلل تباين)
  ووحّدت خلفية الحوارات المعتمة في `--scrim`، وعارض الملفات على `--z-toast` (=90 القديمة،
  تحت حوارات `--z-modal`). **قرار الترحيل: توحيد لا مطابقة حرفية** — القيم الفريدة القريبة
  من عائلة token (‏`#E0A33E`→`--gold-strong`، `#1a1206`/`#241A05`→`--on-gold`، وحدود
  الشارات→`--gold-border`) وُحّدت على أقرب token بفرق بصري طفيف مقصود في الداكن؛
  المطابقة الحرفية كانت ستستلزم tokens جديدة لكل انحراف قديم وهو عكس هدف السلّم.
- **الوضع الفاتح/الداكن (دفعة «وضع فاتح»)**: كتلة `html[data-theme="light"]` في base.css
  تعيد تعريف tokens الواجهة فقط (لوحة Sand الفاتحة، والذهب/الأخضر/الأحمر مُغمَّقة للتباين
  على خلفية فاتحة). التبديل: زرّ 🌙/☀️ في الشريط العلوي (`#themeToggle`) + `localStorage`
  (`satr_theme=light|dark`)؛ وإن غاب المفتاح فالافتراضي **الداكن دائماً** (قرار المالك — لا يتبع `prefers-color-scheme`)،
  والاختيار اليدوي يُحفظ ويغلب الافتراضي. المنطق في `app.js` (`applyTheme/initTheme`) يُطبَّق مبكراً
  لتقليل الومضة، والثيمة على `<html>` فتعبر حدود Shadow بالوراثة (لا مساس بأي مكوّن).
  **سطحا الكود يبقيان داكنين دائماً**: الطرفية (`#termPanel`) والعارض (`satr-file-viewer` —
  الـ tokens تعبر Shadow بالوراثة من المضيف في light DOM) يُعاد تثبيت القيم الداكنة عليهما
  في الوضع الفاتح، و`--bg-deep` لا يُقلب — قرار موثّق: عكس لوحة ANSI/ألوان الكود على خلفية
  فاتحة رديء، وxterm ألوانه صلبة في JS. `color-scheme` يُقلب مع الثيمة (عناصر أصلية/تمرير).
- **دفعة إصلاح عيوب الفاتح المقاسة (kimi-code)**: خمسة عيوب قيست على الـ harness
  (`npm run ui:audit` — مشاهد 22–26 تطبع التباين والقيم المحسوبة فتكشف عودة أي عيب)
  وأُصلحت في كتلة الفاتح حصراً، والداكن ثبتت مطابقته بايتياً في اللقطات:
  فقاعة الرد `--chat-answer-surface` α 0.045→0.11 (تباين وسط الفقاعة/محيطها 1.07→1.12)؛
  تقوية السلّم `--surface-2 #e6e5e2` `--surface-3 #d8d6d2` والحدود
  `--border-dim #d6d4cf` (1.17→1.34) `--border #c2c1bb` (1.42→1.63 على surface)؛
  `--text-faint #6e6c66` (3.26→5.16 على bg و3.00→4.73 على surface — WCAG AA)؛
  أخضر الفاتح `--green #26733a` (شريط النجاح 3.68→4.96:1 على `--green-soft`)؛
  وقاعدة الحقول العامة صارت تغطي `input[type="password"]` (حقل مفتاح API كان بلا
  أي قاعدة فيرث شكل المتصفح «المعطّل» في الوضعين معاً). أُصلحت أيضاً ثغرة مجاورة:
  `--green-border` لم تكن مثبّتة في كتلة إعادة التثبيت الداكن للطرفية والعارض
  فكانت قيمة الفاتح تتسرّب إليهما — ثبّتت `rgba(113, 208, 131, 0.4)` مع شقيقتيها.
  **درس**: أي token جديد في `:root` يخص سطحي الكود يجب تثبيته في تلك الكتلة.
- **بند الأيقونات (تحقيق بند ٨ — حكم: لا عيب)**: على التطبيق الحقيقي (npm start عبر
  CDP) الإيموجي يُرسم بخط رموز **ملوّن** (اختبار canvas: الحروف تتجاهل fillStyle
  وتُرسم بألوانها — Segoe UI Emoji احتياطياً)، فتطابقت تغطية الحروف وعدّات
  بكسلاتها بين الوضعين تماماً، والرموز الأحادية (⚙ ⋯ ✓) ترث لون النص فينقلب مع
  الثيمة بتباين عالٍ (#eeeeec على #222221 داكناً، #21201c على #e6e5e2 فاتحاً).
  اللقطات: dist/icon-audit-dark.png وdist/icon-audit-light.png. لا تغيير مطلوب.
- **دفعة الجزر الداكنة خارج كتلة التثبيت (kimi-code، متابعة الفاتح)**: جرد القائد كشف
  مستهلكي `--bg-deep` خارج كتلة إعادة التثبيت يبقون داكنين في الفاتح بلا المعاملة
  الكاملة. الحكم لكل سطح (قياسات مشاهد ui:audit ‏27–29 قبل/بعد): `.shot-lightbox`
  (نص 1.19:1 وcolor-scheme فاتح) و`satr-promo-studio` (نص 1.19:1، عنوان 3.27:1،
  **caption المُصيّر 1.24:1 — عيب في الفيديو الناتج لا العرض فقط**) أُلحقا بمحدّد
  كتلة إعادة التثبيت نفسها فصارا جزيرتين كاملتين (16.74:1، عنوان 9.34:1، caption
  17.46:1 — ألوان المُصيّر تُقرأ من `getComputedStyle(host)` فيرث التثبيت تلقائياً).
  أما `satr-preview-panel` فلوحته تتبع الثيمة إلا درج السجلّ `#pvConsole`: رُتّب
  بتمرير القيم الداكنة tokens مُنطقية `--pv-console-*` من base.css إلى المضيف،
  ويعيد المكوّن تثبيت الـtokens القياسية عليها محلياً باحتياط **`inherit`**
  (سجلّ 3.11→9.27:1 وcolor-scheme:dark). **درسان مثبتان**: احتياط `var(--x)` داخل
  إعادة تثبيت `--x` نفسها يصنع دورة custom property (الاحتياط يدخل رسم
  الاعتماديات) فتنهار القيمة إلى guaranteed-invalid — الحل `inherit`؛ وأي سطح
  جديد يُبنى داكناً دائماً يُلحق بكتلة التثبيت أو بآلية `--pv-console-*` نفسها.
- **مشهدا بطاقة الحلقة بالمراجعة النوعية (kimi-code)**: ui:audit ‏30–31 (داكن/فاتح)
  يبثّان `loop_update` اصطناعياً (review.configured بحالة changes_required وملخص
  عربي) عبر خطّاف الـharness `__SATR_TESTSPRITE_HARNESS__.emitEvent` فيمرّ بالمسار
  الحقيقي app.js ⇒ opsRoomEl.handleEvent ⇒ reducer، ويقيسان تباين نصوص القسم.
  القياس الحالي: الداكن سليم (7.08/4.77/7.60)؛ الفاتح كان عنوانه 3.75:1 وحالته 4.14:1
  على --surface-2 — تحت AA النص العادي، **عولج بدفعة القائد**: token منطقيان
  `--ops-review-title/--ops-review-alert` في base.css (يتبعان --gold/--red في الداكن
  ويُغمَّقان في الفاتح إلى `#7d560d`/`#b12429`)، تستهلكهما عناوين/حالات بطاقات المراجعة
  في ops-room.js (بطاقة الحلقة + هيئة القضاة) باحتياط var القائم.
  وصُحّح تناقض توثيق الثيمة: الافتراضي داكن دائماً بقرار مالك (لا يتبع
  prefers-color-scheme) في تعليق app.js والجملة أعلاه — تصحيح توثيق بلا سلوك.
- **الخط**: IBM Plex Sans Arabic مضمّن (`src/vendor/fonts/` + `fonts.css` — انظر
  scripts/vendor-fonts.js أعلاه) هو أول `--sans` والاحتياط نظامي؛ حجم الأساس رُفع إلى 16px
  (قرار مالك عند قبول 4.1 — كان 15px مع Segoe UI).
  الخط الأحادي يبقى نظامياً (Cascadia/Consolas — قرار مالك: الكود لاتيني، لا مكسب من تضمين
  mono). ثيمة xterm وألوان الافتراض في JS حُدّثت لتطابق `--bg-deep`/`--text`.
- **الحركات**: دخول الرسائل (`rise`) وظهور المنبثقات (`pop`) عبر `--dur/--ease`، مع تعطيل
  شامل تحت `prefers-reduced-motion` — أي حركة جديدة تستخدم المتغيرين لا أرقاماً صلبة.
### دفعة UX السريعة (بعد 4.1 — من مراجعة UX بموافقة المالك)

خمسة تحسينات واجهة خالصة (بلا IPC جديد وبلا مساس بتجميد الأوامر):
- **الالتصاق الذكي بالذيل**: `scrollDown()` لم يعد قسرياً — `chatPinned` ينفكّ حين يمرّر
  المستخدم لأعلى أثناء البث (نفس منطق `pinned` في الطرفية) وزر «⬇ الأحدث» العائم
  (sticky داخل `main`) يعيد الالتصاق. إرسال المستخدم يعيده دائماً (`scrollDown(true)`).
- **أزرار نسخ**: لكل كتلة كود (`.code-copy` تظهر بالتحويم، تُحقن **بعد** اكتمال الدور لأن
  البث يعيد بناء innerHTML) ولكل رسالة (`.msg-copy` في سطر «من») — مساران: حي وتاريخي.
- **حفظ المسودة**: نص المحرّر في `localStorage` لكل مشروع بالمفتاح
  `satr_draft::<cwd>`؛ المفتاح القديم `satr_draft` يُرحّل مرة إلى المشروع الحالي،
  وتُحفظ المسودة السابقة قبل تبديل `cwd`. المحرّر يفعّل spellcheck الأصلي في Chromium.
- **بحث الجلسات**: حقل ترشيح فوري (`#sessSearch`) بالعنوان أو المجلد في لوحة `/جلسات`؛
  Escape يمسح النص أولاً ثم يغلق اللوحة.
- **إشعار اكتمال الدور**: `Notification` عند `result` والنافذة غير مركزة
  (`document.hasFocus()`) — النقر يعيد التركيز. يظهر باسم «سطر» بفضل AppUserModelId.

### دفعة تلميع الحلقة اليومية (2026-07-19)

- **حرّر وأعد الإرسال**: قلم رسالة المستخدم يعيد نصّها وصورها إلى المؤلّف ويعلّم الأصل
  «مُعدَّلة/متجاوَزة». القلم نفسه يبقى راحة نسخ/تحرير فقط ولا يغيّر سياق الخادم؛ التفريع
  الحقيقي والاسترجاع في فعلي «🌿 فرّع من هنا» و«↩ استرجع الملفات» المستقلين (دفعة A أعلاه).
- **الفشل والإيقاف**: `spawn_error` و`result.is_error` والإيقاف تعرض «🔄 أعد المحاولة»
  لآخر دور مستخدم. النص الجزئي لا يُمحى، وتبقى حالة «⏹ أُوقِف الدور» على كتلته.
- **شريط الوعي**: قرب المؤلّف يعرض النموذج والجهد والأذونات ونسبة السياق. النموذج يفتح
  القائمة القائمة، والجهد يدور ضمن `EFFORT_LEVELS`، والأذونات تدور بين
  `default→acceptEdits→plan→auto` فقط (التجاوز الخطر يبقى في ⚙)، والسياق يعيد استخدام
  لوحة `/سياق` و`contextUsage` القائمين. التحديث كسول عند النقر وبعد `result`.
- **مراجعة الخيط**: `Ctrl+F` داخل منطقة الدردشة فقط يفتح بحثاً يبرز النتائج ويتنقل
  بينها، وملخّص Δ في topbar يجمع ملفات `file_edit` و`+/−` ويفتح آخر بطاقة فرق قائمة.
- **اختصارات بلا أوامر جديدة**: `Ctrl+Alt+N/S/I/T/P` للجلسة الجديدة، الإيقاف، تركيز
  المؤلّف، الطرفية، والمعاينة. زر «؟» يعرضها؛ لا تُلتقط اختصارات التحرير المعتادة.

### مكوّنات الواجهة (تفكيك Web Components — اكتمل ت-0…ت-13)

> الخطة والسجل الكامل بالدروس المثبّتة في `docs/COMPONENTS-PLAN.md` — اقرأه قبل أي
> عمل على الواجهة. صفر اعتماديات وبنّائين: Web Components أصلية + وحدات ES.

- **المعمارية**: `src/ui/app.js` قشرة إقلاع وتوجيه (وحدة ES تعمل أولاً — ترتيب الوسوم)
  تملك حالة التطبيق ومجرى `satr:event` ومنسّق الأسطح؛ المكوّنات ذاتية التسجيل في
  `src/ui/components/`؛
  المشتركات وحدات في `src/ui/lib/`. العقد: أحداث `CustomEvent` للخارج + methods عامة +
  الحالة تُمرَّر لحظة الفتح (المكوّنات لا تقرأ حالة القشرة).
- **الأنماط**: Shadow DOM ⇒ `adoptedStyleSheets` حصراً (وسم `<style>` داخل Shadow
  **محجوب بـ CSP**)؛ light DOM ⇒ base.css. Tokens تعبر الحدود بالوراثة من `:root`.
- **بـ Shadow DOM** (عزل حقيقي): لوحات agents/skills/mcp/context/sessions/git/files +
  file-viewer + gate + perm-dialog + preview-panel (م-1 — بعد اكتمال التفكيك).
- **بلا Shadow (light DOM بغلاف `display:contents`)**: terminal-panel (xterm يقيس
  المستند) + composer وtopbar (الترميز داخل الوسم في index.html — القشرة تربط عناصرهما)
  + **chat** (البث يعيد بناء innerHTML؛ يبني `<main>` بداخله ويعيد كتلة
  `newAssistantBlock(label)` بعقدها للقشرة، ويعتمد diffSheet على المستند). `composer`
  يملك المسودات لكل cwd واستعادة النص/الصور؛ `chat` يملك البحث وقلم الرسالة وحالة
  الإيقاف وزر الإعادة؛ `topbar` يعرض ملخّص تغييرات الجلسة ودليل الاختصارات؛ و`app.js`
  يبقى مالك حالة النموذج/الجهد/الأذونات/السياق وآخر دور وخريطة `file_edit`.
- **دروس مثبّتة**: retargeting نقرات Shadow على مستمع المضيف ⇒ `composedPath()[0]`؛
  نداء مبكر لمكوّن ⇒ `customElements.whenDefined`؛ grep لكل id/صنف قبل حذف CSS.

### لوحة معرض التوليدات 🖼 (الجولة 8 من «ولّد من سطر» — kimi-code)

العقد القانوني في `docs/GENERATION-PLAN.md` §4. اللوحة `src/ui/components/gallery-panel.js`
(Shadow + adoptedStyleSheets + panelSheet، بادئة `gal-`) بزر `#galleryToggle` في درج ⋯
بنمط 📄/±، وتُسجَّل سطحاً `gallery` في منسّق الأسطح. تعتمد قناتي IPC المجمَّدتين
`generationsList(cwd)` و`genThumb(cwd, rel)` (تُضافان عند الدمج من طرف كودكس — حتى
then تُختبر عبر fixture يحقن window.satr مزيفاً، والوصلة الحية يتحقق منها القائد).
- **المحتوى**: شبكة بطاقات من سجل v1 — مصغرة كسولة عبر IntersectionObserver (السجل
  حتى 200 عنصر والمصغرة حتى 3MiB فالتحميل المسبق مرفوض)، البرومبت `dir=auto` بزر نسخ،
  الكلفة والنموذج/المزوّد LTR، «أرسل المسار للمؤلف» حدث `gallery-insert` للقشرة
  (تُلحق المسار بـ #input وتبث input لحفظ المسودة — **بلا إرسال**)، ونقر المصغرة
  يفتح عرضاً مكبراً داخل اللوحة (Escape/✕/نقر الستارة يغلقه؛ Escape بـ capture كي
  لا يغلق اللوحة). الفيديو بطاقة معلومات بلا معاينة (مؤجل — حُدّث في ج9، انظر القسم التالي)، والفاشلة تعرض
  error_code بلا زر مسار، وفراغ السجل ⇒ حالة عربية إرشادية.
- **قرار مظهر**: العرض المكبر **يتبع الثيمة** (ستارة --scrim الثابتة + شرح بأسطح
  الثيمة) — لا جزيرة داكنة جديدة، فلم تلزم توسعة كتلة التثبيت في base.css (درس
  «الجزر الداكنة»). قياسات الفاتح (مشهد 33): برومبت 12.94:1 · ميتا 4.97:1 · شرح
  العرض 14.70:1.
- **الاختبار**: `scripts/gallery-live-test.js` (Electron حي تحت CSP، fixture
  `gallery-live.html`/`gallery-live-page.js` + بيانات `gallery-fixture.js`
  المشتركة) يغطي: فتح/إغلاق، شبكة 5 بطاقات (مع الصوت منذ ج9)، مصغرات كسولة، فيديو مؤجل، فاشلة،
  نسخ، إدراج بلا send، عرض مكبر، حالة فارغة. مشاهد ui:audit ‏32–34 (داكن/فاتح
  مقاس/فارغة) — لقطة الحالة الفارغة إلزامية بصرياً (درس «زر الأحدث»).

### بطاقة التوليد في المحادثة وبطاقة الصوت (الجولة 9 §2/§4 — kimi-code)

العقد القانوني في `docs/GENERATION-PLAN.md` §2 (الحدث) و§4 (الواجهة). البثّ الحي
للحدث من طرف كودكس؛ هنا الالتقاط والعرض، والاختبار بحقن اصطناعي حتى الدمج.
- **الالتقاط (app.js)**: `generation_done` حدث منسّق لا حدث محرك — يُلتقط بنمط
  `loop_update` قبل قاطع «الكتلة المنتهية» فيستقل عن عمر الدور، ولا يغيّر عقد
  KNOWN_EVENT_TYPES. القشرة تستدعي `chatEl.addGenerationCard(ev, cwd, onOpen)`
  مارّرةً `sessionCwd || #cwd` ومعاودة `openGalleryPanel` (تملك مسار فتح اللوحة).
- **البطاقة (chat.js — method واحدة بحدها الأدنى)**: بنمط addStandaloneDiff —
  `article.work-card.gen-card` يستهلك cardSheet القائمة حصراً (بلا ورقة ولا لون
  جديد). الصورة بمصغرة عبر `genThumb` القائمة (سقوطها ⇒ «تعذّر تحميل المصغرة»
  صراحةً)، والصوت/الفيديو بطاقة معلومات (المشغّل والمعاينة مؤجلان عمداً). الكلفة
  `$0.040` والمسار في `bdi.work-card-tech` (LTR دائماً)، ونقر البطاقة يفتح المعرض
  (CSSOM للمؤشر — لا سمة style بـ CSP). قياسات مشهد 36 الفاتح: عنوان 12.94:1 ·
  مزوّد/نموذج 4.64:1 · كلفة/مسار 4.73:1.
- **بطاقة الصوت في المعرض**: `kind:'audio'` ⇒ صندوق `.gal-audio` (🎵 «صوت —
  المشغّل يأتي لاحقاً») بأعراف الفيديو المؤجل نفسها، بلا مصغرة ولا طلب genThumb.
  نص تأجيل الفيديو صار «تأتي لاحقاً» (ج10). **قرار مظهر مصحِّح**: صناديق
  المعلومات النصية (فيديو/صوت/فشل) نُقلت من --bg-deep الثابتة إلى --surface-3
  التي تُقلب — نصها --text-dim/--red كان ~1.9:1 في الفاتح (ثغرة رافقت بطاقة
  الفيديو من ج8 كشفها قياس الصوت الجديد)؛ والمصغرات الفعلية تبقى على --bg-deep
  كما صُمّمت. **جولة الصقل 2026-08-08**: قيمة 4.31:1 الناتجة كانت لا تزال تحت
  AA، فصار نص الصناديق عبر token ‏`--media-note` (داكن: --text-dim، فاتح: ‎#585550
  ⇒ 5.11:1 مقاسة) ونص الفشل عبر `--ops-review-alert` (‏3.59 → 4.59:1).
- **الحقن الاصطناعي**: بنمط بطاقة المراجعة (30–31) — مشاهد ui:audit ‏35/36
  (داكن/فاتح مقاس) تبثّ `generation_done` عبر `__SATR_TESTSPRITE_HARNESS__.emitEvent`
  فيمرّ بمسار القشرة الحقيقي كاملاً، و36 ينقر البطاقة فيفتح المعرض ببطاقة الصوت.
  fixture الحي الثاني `gen-card-live.html`/`gen-card-live-page.js` يختبر
  addGenerationCard مباشرةً (مصغرة/LTR/نقر/سقوط). **درس Electron**: تشغيل fixture
  ثانٍ في العملية نفسها يلزمه `app.on('window-all-closed', () => {})` — إتلاف
  النافذة الأولى يبدأ الإغلاق التلقائي فيفشل تحميل الثانية بـ ERR_FAILED.

### مشغّلا الوسائط في المعرض (الجولة 10 §3 — kimi-code)

المؤجل الموثق («المعاينة/المشغّل يأتي لاحقاً») نُفّذ. العقد القانوني في
`docs/GENERATION-PLAN.md` §3 (v3). بطاقة التوليد في المحادثة (chat.js) لم تُلمس —
تبقى معلومات + فتح المعرض.
- **IPC `satr:genMedia {cwd, rel}` → `{ok, dataUrl, mime}`**: كتلة موضعية معلَّمة
  في `electron/main.js` (بين «كتلة genMedia»/«نهاية كتلة genMedia») تنسخ نمط
  genThumb حرفياً — `safeGenerationRel(cwd, rel, true)` (داخل `generations/`
  حصراً) + `realpathSync` (traversal/symlink مرفوضان) + قائمة سماح امتدادات
  `{mp4, webm, wav, mp3}` (النوع من الامتداد — لا اشتقاق من المحتوى) + سقف
  **24MiB** ⇒ `bad_path`/`bad_size`/`read_failed`. preload يكشف `genMedia(cwd,
  rel)` المحددة فقط (سطر واحد). لا حدث جديد ولا بث.
- **المشغّلان (gallery-panel.js)**: بطاقتا الفيديو/الصوت معلومات + زر «▶ شغّل
  المعاينة»/«▶ شغّل المقطع» — `genMedia` عند النقر فقط (كسل صارم، لا تحميل
  مسبق)، ثم Blob ← objectURL ← `<video/audio controls>`. فكّ base64 يدوي
  (atob→Uint8Array) لا fetch — ‏`connect-src 'none'` في fixtures. الفشل/تجاوز
  السقف ⇒ بطاقة المعلومات القائمة + «تعذّر تحميل المعاينة» صراحةً.
  `revokeObjectURL` عند إغلاق اللوحة/إعادة فتحها/إزالتها (Set في `_mediaUrls`
  تُسحب في close/open/disconnectedCallback). قرار موثّق: لا معالج لخطأ فكّ
  الترميز — عنصر الوسائط الأصيل يعرض حالته بنفسه، ورسالتنا الصريحة لطور
  الجلب/السقف. سطح المشغّل --bg-deep (لا نص فوقه — لا جزيرة)، وأزرار التشغيل
  والنصوص على --surface-3 المُقلبة (إصلاح ج9).
- **الاختبار**: `test:gallery` كسب فحوص `media-lazy-no-preload` ·
  `video-player-lazy` · `audio-player-lazy` · `media-oversize-rejected` ·
  `media-path-ext-rejected` · `media-revoke-on-close` (عدّاد createObjectURL/
  revokeObjectURL يثبت التساوي) + فحص ساكن لكتلة main.js والسطر في preload
  (نمط assertStaticContract). وسائط fixture حقيقية مولّدة بـ ffmpeg (mp4 ‏0.5ث
  ‏5734 بايت · mp3 ‏2421 بايت) — وElectron الفعلي فكّ ترميز H.264 وعرض الإطار.
  مشاهد ui:audit ‏37 (داكن) و38 (فاتح مقاس): زر التشغيل 12.94:1 · نص بطاقة
  الصوت 4.31:1 آنذاك (صار 5.11:1 عبر --media-note في جولة الصقل 2026-08-08) ·
  المشغّلان بُنيا بـ blob: وcontrols.

## قواعد إلزامية

1. **الأمان أولاً**: لا تعطّل `contextIsolation` أو `sandbox`، ولا تفعّل `nodeIntegration`.
   كل قدرة جديدة تمر عبر preload.js بدالة محددة — لا تكشف ipcRenderer كاملاً أبداً.
2. **التحقق من المدخلات في main.js**: أي قيمة تدخل في وسائط spawn يجب أن تمر على
   regex تحقق صارم (انظر SAFE_SESSION و SAFE_MODEL الموجودة). البرومبت نفسه آمن لأنه عبر stdin.
3. **العربية أولاً**: كل نص واجهة بالعربية. الأكواد والمسارات والأرقام التقنية دائماً
   `direction: ltr`. أما **اتجاه النص المختلط فيُحسم بحسب الوعاء لا بقاعدة واحدة**
   (‏`OBS-061` — الصياغة السابقة كانت توصي بالعلّة نفسها التي أُصلحت في 2026-07-18):
   - **فقرة أو عنصر قائمة أو عنوان أو خلية جدول أو فقاعة رسالة ⇒ حسم إحصائي صريح**
     عبر `textDir()` من `src/ui/lib/text-dir.js` (المصدر الواحد) ثم ضبط `dir` على
     العنصر. السبب مقيس: `unicode-bidi: plaintext` و`dir="auto"` يحسمان من **أول حرف
     قوي**، فأي فقرة عربية الجوهر تبدأ برمز لاتيني (`SHA-256 …` · `npm run …`) ترسو
     LTR كاملة — وهو نمط التقارير التقنية لا حالة نادرة.
   - **حاوية أو نص قصير بلا رمز لاتيني بادئ ⇒ `dir="auto"` مقبول** ويبقى مستعملاً
     عمداً (`chat.js:742, 796, 967, 1213`). لا تُطارد هذه المواضع.
   - **كتلة متعددة الأسطر (‏`<pre>`/عارض ملف/سجلّ) ⇒ اتجاه واحد للكتلة كلها**؛
     `dir="auto"` لكل سطر جُرّب وأخفق (كل سطر يرسو على حافة مختلفة).
   - ⚠️ **`getComputedStyle(el).direction` لا يكشف هذا العطل** — يعيد `rtl` الموروثة
     بينما الفقرة رست LTR. الدليل الوحيد موضع أول محرف بالبكسل
     (‏`scripts/arabic-rtl-probe.js`)، وأداة `browser_readability` تقيسه لصفحات المعاينة.
4. **الكود بالإنجليزية، التعليقات بالعربية**: أسماء المتغيرات والدوال إنجليزية،
   التعليقات التوضيحية عربية (صاحب المشروع يقرأ بالعربية).
5. **أقل اعتماديات ممكنة**: لا تضف حزمة npm إلا لضرورة واضحة. الواجهة صفر اعتماديات
   وقت التشغيل — حافظ على ذلك. العملية الرئيسية تعتمد `@anthropic-ai/claude-agent-sdk` فقط
   (أساس المرحلة 2).
   **استثناء واعٍ وموثَّق (المرحلة 8 — الطرفية):** `node-pty` اعتمادية **أصلية (native)**
   ثانية في العملية الرئيسية. المبرر: الطرفية المدمجة تستحيل بلا pseudoterminal حقيقي
   (ConPTY) ولا بديل JS خالص له — spawn العادي لا يعطي TTY (لا ألوان ولا تفاعلية)؛ الحزمة
   من مايكروسوفت وتشغّل VS Code نفسه. أما xterm.js وخط IBM Plex Sans Arabic في الواجهة
   فليسا اعتماديتَي تشغيل npm بل **مُضمّنان (vendored)** في `src/vendor/` (المصدر
   devDependency، والنسخ عبر `scripts/vendor-xterm.js` و`scripts/vendor-fonts.js`،
   والناتج مُلتزَم) — فقاعدة الواجهة تبقى قائمة بمعناها.
   لا استثناءات أخرى دون قرار يُوثَّق هنا.
6. **لا تكسر العقد بين الطبقات**: أي تغيير في صيغة أحداث IPC يتطلب تحديث الطرفين معاً
   وتحديث هذا الملف.
7. **اختبر على ويندوز ذهنياً**: المسارات بـ `\`، الأوامر `.cmd`، الترميز UTF-8 —
   هذه البيئة الأساسية للمستخدمين.
8. **التحقق من النماذج**: قائمة النماذج في الواجهة تمرر القيمة لـ `--model` كما هي.
   عند إضافة نموذج جديد تحقق أولاً أن claude يقبله (مثال: `claude --model claude-fable-5 -p "hi"`).

## سجل الملاحظات المؤجَّلة (قاعدة مالك — 2026-08-13)

**أي ملاحظة تظهر أثناء دفعة جارية تُسجَّل في `docs/OBSERVATIONS.md` ولا تُنفَّذ.**
الغاية مزدوجة: ألّا تضيع الملاحظة، وألّا تنتفخ الدفعة الجارية فيضيع حاجزها.

- **ثلاثة استثناءات تُنفَّذ فوراً** (وإلا صارت القاعدة ذريعة لتأجيل عطل حقيقي):
  تراجع أمني · عطل يكسر الدفعة الجارية نفسها · سطر واحد داخل ملف يُعدَّل أصلاً.
- **القائد وحده يكتب في الملف.** المنفّذون يذكرون ملاحظاتهم في تقاريرهم النهائية
  (بند «تغيير لزم في ملف لا أملكه — مذكوراً لا منفَّذاً») والقائد ينقلها. هذا يمنع
  تعارضات الدمج ويُبقي الملف ضمن ملكية `docs/`.
- **السحب خطوة إلزامية أولى في كل دفعة جديدة**: تُقرأ الملاحظات المفتوحة، وتُرشَّح
  المطابقة لوسم الدفعة، **وتُعرض على المالك ليقرر** أيها يدخل. لا ضمّ تلقائي — وإلا
  عادت الدفعات المنتفخة التي بُنيت هذه القاعدة لمنعها.
- **الإغلاق بمرجع**: المنجزة تحمل رقم التزام، والمرفوضة تحمل سبباً. **لا تُحذف
  ملاحظة أبداً** — تاريخ الرفض يمنع إعادة فتح نقاش محسوم بعد أشهر.
- الوسم من قائمة مغلقة (`mobile · ui · ops-room · engines · preview · generation ·
  security · process · docs · perf`)، والدليل (`ملف:سطر` أو التزام) إلزامي: بلا دليل
  تصير الملاحظة رأياً لا يمكن التحقق منه بعد شهر.

`npm run test:observations` (ضمن `test:full`) يحرس الشكل والأوسمة والأدلة والترقيم.
**حدّه مُصرَّح به**: لا يستطيع أن يعرف أن ملاحظةً لوحظت ولم تُسجَّل — يحرس صحة الملف
وعدم تعفّنه لا اكتمال التسجيل. ادّعاء غير ذلك يكون «الحارس الأخضر الكاذب» نفسه.

## أوامر التشغيل والبناء

```
npm install        # مرة واحدة
npm start          # تشغيل التطبيق للتطوير
npm run dist       # بناء مثبّت ويندوز NSIS في مجلد dist/
npm run dist:dir   # بناء مجلد بدون مثبّت (أسرع للتجربة)
```

ملاحظات البناء (مهمة):
- **حجم المثبّت**: لا نحزم ثنائي claude (~234م.ب)؛ نوجّه SDK إلى المثبّت عالمياً
  (انظر agent.js). البناء يستثني `claude-agent-sdk-win32-x64` عبر `files`، ومع node-pty
  مقلَّم الـ prebuilds (المرحلة 8) يبلغ المثبّت ~80م.ب.
- **لا إعادة بناء أصلية**: `npmRebuild: false` — انظر «الطرفية العربية المدمجة» أعلاه.
- **المهارة المضمّنة**: `build.files` يضم `.agents/skills/satr-guide/**/*` فقط، ويطابقه
  `asarUnpack` لأن حصر الموارد يعتمد `realpathSync`. في الإنتاج يحوّل `skills.js` جذر
  `app.asar` إلى `app.asar.unpacked`؛ وفي التطوير يقرأ المسار المباشر نفسه.
- **مثبّت عربي بالكامل**: `build/installer.nsh` يفرض `$LANGUAGE=1025` في `preInit` و
  `customUnInit`. **لا تضع `multiLanguageInstaller: false`** — في electron-builder تعني
  تجاهل `installerLanguages` وفرض الإنجليزية (en_US). اترك `installerLanguages: ["ar_SA"]`
  وحدها مع ملف الـ nsh.
- **ذاكرات البناء على D:**: متغيّرات `ELECTRON_BUILDER_CACHE` و `ELECTRON_CACHE` (نطاق User)
  و `npm config cache` كلها على `D:\dev-caches`. عند البناء من هذه الجلسة مرّرها inline.

## مرجع سريع لـ Claude Code CLI

- التوثيق: https://code.claude.com/docs/en/cli-reference و https://code.claude.com/docs/en/headless
- الوضع غير التفاعلي: `claude -p` + `--output-format stream-json` (يتطلب `--verbose`)
- `--include-partial-messages`: يضيف أحداث بث جزئية (حرفاً بحرف) — مخطط للمرحلة 3
- أوضاع الصلاحيات: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto` (خارطة
  المنصّات الموجة 4 — محرك SDK فقط): مصنّف Anthropic يوافق القرائية تلقائياً، والأدوات ذات
  الأثر تُجبَر على مربع الإذن العربي عبر `preToolUse:'ask'`. المنطق النقي في `electron/autogate.js`
  (`AUTO_SAFE_TOOLS`/`autoNeedsPrompt`/`decideAutoApproval`/`nonSdkPerm`)، يستهلكه agent.js
  (canUseTool يستدعي `decideAutoApproval` المُختبَرة) وmain.js (`nonSdkPerm` يسقط auto لغير SDK).
  **fail-safe**: whitelist للآمن لا blacklist للخطر (المجهول يُسأل)؛ «موافقة دائمة» سابقة لا
  تعفي أداة غير آمنة في auto؛ `browserControl` استثناء صريح للمتصفح. اختبار `npm run test:autogate`.
- جلسات Claude Code المحفوظة محلياً: `~/.claude/projects/<مسار-مرمّز>/*.jsonl` — تُستخدم في المرحلة 2 (متصفح الجلسات)
- للترقية المستقبلية: Claude Agent SDK (TypeScript) يوفر تحكماً برمجياً كاملاً بما فيه
  اعتراض طلبات الأذونات — هذا أساس المرحلة 3. تحقق من توثيقه الرسمي قبل البدء.

## خطة العمل

اقرأ `docs/PLAN.md` — لا تنفذ أكثر من مرحلة واحدة في الجلسة الواحدة،
وبعد كل مرحلة: شغّل التطبيق، تحقق من معايير القبول المذكورة، ثم قدّم ملخصاً.
