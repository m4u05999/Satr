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
                        الاختبار: test:askquestion (نقي، خصومي) + test:question-dialog (الحيّ) + probe الحيّ.
                        كما يوفّر withControlQuery: تشغيل عابر لاستدعاء «دوال التحكّم» في SDK
                        (mcpServerStatus/reconnectMcpServer/toggleMcpServer/getContextUsage) للوحتي
                        /موصلات و /سياق — مولّد إدخال ينتظر فقط ليُبقي العملية حيّة، ثم close+q.close())
electron/preload.js  ← جسر آمن: يكشف window.satr فقط (contextIsolation مفعّل)
electron/sessions.js ← قراءة جلسات ~/.claude/projects (قراءة فقط + تحقق صارم من المسارات)
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
electron/integration.js ← بوابة تحقق تكاملي: أوامر HEAD المثبتة + worktree مستقل + نتيجة بلا خرج خام
electron/merger.js ← بوابة تطبيق patch بعد مراجعة وتحقق وموافقة؛ git apply بلا shell أو force
electron/opsroom.js ← سجل غرفة العمليات الدائم append-only؛ فصل سلطة المحرك/المستخدم/النظام
                       وحجب الأسرار والـpatch، بلا أي قدرة تشغيل أو دمج
electron/opsroomindex.js ← فهرس غرف حسب بصمة المشروع بلا مسار مطلق؛ يسوّي التشغيل القديم
                       إلى interrupted ويعرض التاريخ المنقّى
electron/opsartifacts.js ← خزنة patch مشفّرة fail-closed بـsafeStorage؛ استعادة/حذف/احتفاظ محدود
electron/opsbrainstorm.js ← رأيا SDK/Codex مستقلان داخل cwd فارغ وبلا أدوات أو حلقة تلقائية
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
electron/memory.js  ← ذاكرة مشروع شخصية منفصلة عن transcript تحت ~/.satr/memory/<cwd_sha256>.json:
                       facts/decisions/commands/failures بمصدر/تاريخ/ثقة/نطاق؛ رفض أسرار،
                       فهرس كلمات/مسارات، واسترجاع مقتصد. الاقتراح لا يكتب دون موافقة صريحة
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
electron/browserguard.js ← حارس المتصفح الخارجي (دفعة «تحكم الوكيل الكامل» 2026-07-18):
                       موديول نقي بلا تبعيات (نمط autogate.js) مشترك بين المحرّكين.
                       isExternalBrowserLaunchCommand (استُخرجت من codex.js — نسخة واحدة)
                       + promptRequestsExternalBrowser (طلب المستخدم الصريح لمتصفح خارجي
                       في رسالة الدور يعطّل الاعتراض — قرار مالك). اختبار test:browserguard
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
electron/bgprocs.js  ← متتبّع عمليات الخلفية المعمّرة (خوادم التطوير): الـ SDK لا يكشف
                       للمضيف أي مقبض لعمليات تُشغّلها الأدوات، فنتعقّبها على مستوى النظام.
                       خطّافا Bash (run_in_background) في agent.js يلتقطان أحفاد عملية «سطر»
                       قبل/بعد الأمر، والفرق = PIDs الأمر — تُسجَّل وتعيش بعد الدور فيقتلها
                       المستخدم من شريط «قيد التشغيل». السجلّ في العملية الرئيسية (مستقل عن الدور)
electron/term.js     ← الطرفية العربية المدمجة (المرحلة 8): دورة حياة pty واحدة عبر node-pty
                       (ConPTY، ويندوز 10 1809+) + IPC بثّ البايتات بالاتجاهين + تغيير الحجم +
                       قتل مضمون عند الإغلاق. التصميم الكامل في docs/PHASE8-DESIGN.md
electron/preview.js  ← لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب»): متصفح
                       WebContentsView أصلي (صفر اعتماديات) معزول كلياً — sandbox +
                       partition دائمة مستقلة + **بلا preload** (الصفحة لا ترى window.satr)
                       + http/https حصراً + رفض كل أذونات الويب + المنبثقات لنفس العرض.
                       الواجهة ترسم الإطار وتبلّغ مستطيل العرض (satr:previewBounds)
                       والعرض الأصلي يطفو فوقه؛ أحداثه عبر قناة satr:preview.
                       يبثّ أيضاً agent_activity (نشاط Codex على المتصفح) عبر previewSender
electron/codexmcp.js ← خادم MCP‏ streamable-HTTP داخل العملية يعطي محرك Codex رؤية الويب
                       (الخيار 1): يفوّض أدوات المعاينة (open_preview/read_page/snapshot/
                       console/network/screenshot + أفعال بالإذن) مباشرةً إلى preview.js.
                       http المدمجة صفر اعتماديات، 127.0.0.1، Bearer بزمن ثابت. codex.js
                       يبدأه قبل spawn ويحقنه عبر -c mcp_servers.satr_preview (انظر قسم
                       «رؤية الويب لـ Codex»). الأفعال تمرّ بمربع الإذن العربي عبر requestPermission
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
                       أنماط المكوّنات الحصرية) + panel.css.js (ورقة اللوحات الجانبية) +
                       diff.js (buildDiff بعقدها الثلاثي: محادثة/عارض/git) + diff.css.js
                       (المصدر الوحيد لأنماط بطاقة الفرق منذ ت-12: تُعتمد على المستند من
                       chat.js للـ light DOM وعلى shadowRoot في git/العارض) + highlight.js
                       (HL_CFG + hlLine) + update-toast.js (توست التحديث/الإشعار العابر —
                       استُخرج من app.js لاختباره حيّاً في test:update-ui، سلوك مطابق حرفياً).
                       جسر window.SatrUI أُزيل في ت-13 — استيراد مباشر فقط
src/ui/components/   ← 15 مكوّن Web Component (بادئة satr-، ملف لكل مكوّن) — انظر قسم
                       «مكوّنات الواجهة» أدناه (الخامس عشر: preview-panel — م-1)
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
docs/PLAN.md         ← خطة التنفيذ المرحلية — اقرأها قبل أي مرحلة جديدة
site/                ← صفحة الهبوط (قرار «توزيع أوسع» 2026-07-18): HTML/CSS/JS خالص بفكرة
                       «السطر الذي يلتئم»، GSAP+ScrollTrigger+Lenis مضمّنة vendored (صفر
                       CDN، CSP صارم، reduced-motion كامل)، اللوحة من tokens التطبيق،
                       واللقطات في assets/ من مكوّنات الواجهة الإنتاجية. خارج حزمة
                       التطبيق (files allowlist). التطوير: npm run site:serve (4600)؛
                       الترقية: vendor:site؛ توليد اللقطات: site:shots (حتمي — الزمن
                       مجمَّد في fixture الغرفة، ونافذة offscreen واحدة تُعاد — الثانية
                       تفشل ERR_FAILED). fixtures تحت scripts/fixtures/site-shots-*
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
أُضيف للمرحلة 4 ليسمح بمصغّرات الصور الملصقة (data: URL).
تنبيه نهايات الأسطر: محلّل HTML يطبّع CRLF إلى LF قبل حساب هاش CSP، وupdate-csp يطبّع
مثله قبل الهش — لا تحسب الهاش يدوياً على ملف CRLF (git autocrlf يسحب LF كـ CRLF على ويندوز).

### تدفق البيانات

1. الواجهة تستدعي `window.satr.send({prompt, cwd, sessionId, model, permissionMode, engine, images, skills})`
   - `images` (المرحلة 4): مصفوفة `[{media_type, data}]` للصور الملصقة، `data` base64 خالص.
     تُنقّى في main.js (`sanitizeImages`: أنواع `image/png|jpeg|webp|gif`، ≤10م.ب base64، ≤6 صور).
     محرك **sdk** فقط يدعمها (agent.js يبني `content` كمصفوفة كتل نص+صورة)؛ محرك **cli**
     يتجاهلها (الواجهة تنبّه وتُسقطها). طلب بلا نص يُقبل إن رافقته صورة.
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
     codex.js يطبّعه إلى مفتاح `model_reasoning_effort` الرسمي (`max→xhigh` غير مقبول)
     ويحقنه عبر `-c` عند spawn. المحوّلات لا تدعمه بعد.
   - `extraDirs` (⚙ «مجلدات إضافية» — المرحلة 14.4): مصفوفة مسارات يصل إليها النموذج
     بجانب cwd. تُنقّى في main.js (`sanitizeExtraDirs`: مجلد موجود فعلاً، سقف 10)
     وتُمرَّر `additionalDirectories`. تُحفظ في localStorage (`satr_extra_dirs`). sdk فقط.
2. حسب `engine` (قائمة «المحرك» في الواجهة، الافتراضي `sdk`؛ القائمة تُبنى ديناميكياً من
   `satr:providers`): `sdk` خاص يذهب لـ agent.js، وأي `engine` آخر يمرّ عبر
   **طبقة المحوّلات** `adapters.get(engine)` (main.js يُنقّي المدخلات ثم يستدعي `start`):
   - **sdk** (المرحلة 2): `electron/agent.js` يستدعي `query()` من `@anthropic-ai/claude-agent-sdk`
     بإدخال بثّي (مولّد يبقى مفتوحاً حتى نهاية الدور — شرط عمل `interrupt()`)
     مع `includePartialMessages` و `canUseTool` و `resume/model/permissionMode/cwd`
   - **cli** (احتياطي، `adapters/claude-cli.js`): `claude -p --output-format stream-json --verbose …`
     - البرومبت عبر **stdin**؛ على ويندوز `shell: true` لأن claude قد يكون `.cmd`
     - يُشغَّل بـ `detached: true` (ويندوز): مجموعة عمليات وكونسول خاصّان به، فأي
       حدث تحكّم كونسول (CTRL_C/CTRL_BREAK) من خادم تطوير طويل العمر يبقى محبوساً
       في شجرته ولا يصل «سطر». الإيقاف بـ `taskkill /T /F` (نزولاً فقط)
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
   - `user`: نتائج الأدوات `tool_result` (لها `tool_use_id`, `is_error`)
   - `result`: النهائي — فيه `total_cost_usd`, `duration_ms`, `session_id`, `is_error`
   - `stream_text`: جزء نصي تدريجي `{text, phase?}` — يُعرض فوراً ويُستبدل بنص `assistant`
     المكتمل؛ المحركان الأصليان يرسلان phase، والمحوّلات التي تغيب عنها تتراجع إلى الإجابة.
   - `permission_request` (SDK فقط): `{id, tool, input}` — تفتح مربع حوار عربياً،
     والرد عبر `window.satr.permission(id, allow, always)` → `satr:permission`
     («دائماً» تُحفظ لعمر التطبيق في agent.js)
   - `file_edit` (SDK فقط، المرحلة 3): `{id, tool, rel, isNew, added, removed, lines, truncated}`
     — يصدر من خطّاف `PostToolUse` بعد نجاح Edit/Write/MultiEdit، تعرضه الواجهة كبطاقة
     فرق قابلة للطيّ. `id` هو `tool_use_id` (يربط الفرق بنفس الأداة). الرد على «تراجع»
     عبر `window.satr.undoEdit(id)` → `satr:undoEdit` (يعيد الملف أو يحذفه إن كان جديداً)
   - `bg_procs`: قائمة عمليات الخلفية الحيّة `{procs:[{id, command, count, startedAt}]}`
     — **مستقل عن الدور** (يُبثّ مباشرةً لا عبر token الدور، ويصل حتى بعد انتهاء التشغيل).
     الواجهة تعرضه كشريط فوق المحرّر، وكل عملية لها زرّ قتل. الردّ عبر
     `window.satr.killBgProc(id)` → `satr:killBgProc` (id يطابق `^bg_[0-9]+$`)، والاسترجاع
     عند الإقلاع عبر `window.satr.listBgProcs()` → `satr:listBgProcs`. القتل بـ `taskkill /T /F`.
     تُقتل كل العمليات المتتبَّعة عند إغلاق «سطر» (`window-all-closed`/`before-quit`).
   - `system`/`compact_boundary` (SDK فقط، أمر /ضغط): `{compact_metadata:{trigger, pre_tokens,
     post_tokens, …}}` — يصدر عند ضغط المحادثة، تعرضه الواجهة كبطاقة «ضُغطت المحادثة: X ← Y رمز».
     الجلسة تبقى نفسها (session_id) فتكمل المحادثة بالملخّص.
   - أحداث داخلية: `stderr`, `spawn_error`, `proc_done`

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
  deepseek, qwen, minimax (M3 افتراضياً — `api.minimax.io/v1`، مفتاح `MINIMAX_API_KEY`).
- **`adapters/claude-cli.js`**: مسار `claude -p` المنقول من main.js (نفس detached+taskkill).
- **`adapters/gemini.js`**: Gemini عبر **REST مباشر** (`https` مدمجة، بثّ SSE من
  `streamGenerateContent`) لا gemini-cli. **قرار مثبّت**: gemini-cli أُسقط لأنه غير موثوق
  للوضع غير التفاعلي (طبقة OAuth المجانية أُلغيت من Google، ثقة المجلد تُعلّق، «auto» بطيء) —
  REST بنموذج `gemini-2.5-flash` سريع وثابت. المفتاح في ترويسة HTTP، ذاكرة محادثة في خريطة
  لكل session_id (يُمرَّر كامل السجل كل دور).
- **`adapters/openai-compatible.js`**: **مصنع** `make(config)` لأي endpoint متوافق مع OpenAI
  Chat Completions (بثّ `choices[].delta.content` + `[DONE]`). DeepSeek/Qwen/GLM/Kimi كلها
  بنفس البروتوكول ⇒ إضافة مزوّد = سطر `register()` واحد. متحقَّق حيّاً بالبروتوكول.
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
- **حدود موثّقة**: نص فقط (لا صور في هذه المحوّلات — حصرية لمحرك SDK).
- **الذاكرة (الدفعة 1.3)**: سجلّ المحادثة كاش حيّ (Map) فوق **قرص** (`electron/chats.js` —
  `~/.satr/chats/<provider>/<session>.json`) فتُستأنف المحادثة بعد إعادة تشغيل «سطر».
  مؤشر «آخر جلسة» على **القرص أيضاً** (`<provider>/last.txt` يكتبه `chats.save`) — **ليس
  localStorage** (درس مثبّت من اختبار القبول: كتابة localStorage قد لا تصل القرص فيضيع
  المؤشر). الواجهة تستعيده عند الإقلاع وعند التبديل للمحرك عبر IPC `satr:lastChat {engine}`
  → `{sid}`، و«جلسة جديدة» تنساه عبر `satr:forgetChat` (`chats.forget` يحذف last.txt
  والسجلّ يبقى للتنظيف بالأقدم). preload يكشفهما `lastChat/forgetChat`. sdk↔cli يتشاركان
  جلسات كلود كما كانا (لا مساس). المصنع openai-compatible يأخذ `id` في config هو اسم
  مجلد الذاكرة؛ بدونه تبقى الذاكرة حيّة فقط.
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
- **التشغيل من الدردشة**: في دور Codex الصريح لـTestSprite داخل مشروع «سطر»، يبدأ المضيف
  الـharness قبل app-server ويحقن تلقائياً عنوانه وتسلسل MCP ثم `npm run test:full` في مدخل
  الدور. يرتبط المقبض بعمر الدور ويُغلق عند النجاح/الفشل/الإيقاف؛ إن كان harness «سطر» يعمل
  أصلاً على `4173` يعاد استخدامه بلا امتلاك أو قتل. لا IPC ولا أمر `/` جديدان.
- **الاختبار**: العقد والحواجز ودورة ملكية الخادم والواجهة الحية في
  `npm run test:testsprite-ready`. الطريقة الأساسية من الدردشة والتشخيص اليدوي في
  `docs/TESTSPRITE.md`.

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
`satr:keysList`/`keySet`/`keyDelete` (مركز المفاتيح). preload يكشفها كلها. القائمة «المحرك»
في index.html تُبنى من `satr:providers` (sdk خاص أولاً + المحوّلات)، والاختيار يُحفظ في
localStorage (`satr_engine`)؛ فشل الجلب ⇒ الخيارات الثابتة احتياطياً.

### متصفح الجلسات (المرحلة 1)

- IPC إضافي للقراءة فقط: `satr:listSessions` (قائمة الجلسات عبر كل المشاريع، الأحدث أولاً،
  العنوان من أول رسالة مستخدم أو `aiTitle`) و `satr:readSession {project, id}`
  (يعيد `{cwd, total, messages:[{role, text, tools?}]}` — آخر 40 رسالة مهيأة للعرض)
- التحقق في `electron/sessions.js`: أسماء المشروع والجلسة مكوّن مسار واحد عبر regex صارم
  (لا فواصل مسار ولا `..`) + فحص أن المسار النهائي داخل `~/.claude/projects`
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
  تحت home. أول اسم يفوز، لذلك القياسي `.agents` يغلب نسخة التوافق `.claude`. يعاد
  `[{name, description, source, format, location}]` بلا مسارات مطلقة للواجهة.
- **progressive disclosure**: الفهرس يقرأ رأس `SKILL.md` فقط. المحتوى الكامل (≤128KiB)
  والموارد النصية (≤256KiB للملف، ≤100 مورداً، عمق ≤5) لا تُقرأ إلا باستدعاء الأداة.
  `realpath` يحصر المورد داخل مجلد المهارة؛ الثنائي و`..` مرفوضان؛ السكربت يُعرض كنص ولا
  يُنفّذ تلقائياً. catalog metadata مسقوف بـ16KiB ونتيجة الأداة بـ48K محرفاً.
- **المحرّكات**: Claude SDK يبقي runtime `.claude` الأصلي وplugin skills، ويخدم `.agents`
  بأداتي `load_skill` و`read_skill_resource` للقراءة فقط. Codex 0.144.1 يأخذ مدخلات skill
  الأصلية في `turn/start`. Gemini وعائلة OpenAI-compatible تعلنان الأداتين ضمن الحلقة؛
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
  علاج التقادم آلي لا بشري. **حدّ حالي موثّق**: المهارة تُكتشف من مجلد المشروع فقط
  (`.agents` خارج حزمة التوزيع) — إيصالها لمستخدمي «سطر» النهائيين (مصدر «مهارات مضمّنة»
  ثالث في skills.js بأدنى أولوية + إدخالها الحزمة، أو زرع في home) قرار مؤجَّل للمالك.
- **التحقق**: `npm run test:skills` يثبت precedence والتحميل التدريجي وحدود الموارد وأدوات
  المحوّلات ومدخلات Codex، ثم `npm run eval:agent` يحمي baseline الوكيل 12/12.

### سجل المهام الدائم (Task Ledger — الأولوية 2)

- **التخزين**: `electron/tasks.js` يحفظ snapshot فقط تحت
  `~/.satr/tasks/<engine>/<session_id>.json`؛ لا prompt ولا transcript. المعرّفات منقّاة
  كمكوّن مسار واحد، والسجل ≤50 مهمة، والدليل ≤6 بنود للمهمة، والملف ≤512KiB.
  الكتابة عبر ملف مؤقت ثم rename وأفضل جهد؛ فشل القرص لا يكسر الدور.
- **المحرّكات**: Codex يطبّع `turn/plan/updated` المثبّت من schema v2. Claude SDK
  يطبّع أدوات `TodoWrite` و`TaskCreate` و`TaskUpdate` ورسائل النظام الحقيقية
  `task_started/task_updated/task_progress/task_notification` المثبتة من `sdk.d.ts`؛
  لا يعتمد على تخمين حدث غير موجود. المحوّلات تملك أداة `update_task_ledger` في حلقة الأدوات.
- **العرض**: `<satr-chat>` يعرض التقدم والحالات والاعتماديات والمالك ودليل التحقق في بطاقة
  خفيفة أعلى الخيط. `satr:taskLedger` يعيد snapshot عند استئناف جلسة، و`satr:taskAction`
  يقبل `pause|resume` فقط. الإيقاف زر ظاهر يوقف الدور ويحفظ ledger؛ الاستئناف ظاهر ولا
  يرسل prompt تلقائياً — يطلب من المستخدم إرسال متابعة.
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
    ]
  }
  ```

  الملف `.satr/verify.json` داخل `cwd` حصراً، symlink مرفوض، ≤64KiB، ≤6 أوامر، وكل
  command سطر واحد ≤1000 محرف. قراءة `verification_config` بلا إذن ولا تنفيذ؛
  `verify_project` طبقة `exec` فيعرض مربع الإذن العربي الأوامر الفعلية ثم يشغّل snapshot
  نفسه في طرفية النموذج. لا «موافقة دائمة» للتحقق.
- **معالج الإنشاء اليدوي**: زر «إعداد التحقق» داخل غرفة العمليات يفتح
  `satr-verify-config-dialog` لإدخال `id/label/command/timeout` يدوياً (لا قراءة
  `package.json` ولا اكتشاف scripts). يعرض JSON للمراجعة قبل الكتابة؛ الملف القائم يفرض
  تأكيد استبدال ثانياً. `satr:verifyConfigCreate` منقّى في `main.js`، والكاتب الذرّي في
  `verify.js` يثبت المسار `.satr/verify.json` داخل cwd، ويرفض root/`.satr`/الهدف الرمزي
  والخروج والكتابة فوق ملف بلا `overwrite:true`. الإنشاء لا يشغّل شيئاً، ويبقى الملف مطلوباً
  داخل `HEAD` قبل غرفة قابلة للدمج.
- **المحرّكات**: Claude SDK يملك خادم MCP مستقل `satr-verify` خارج `satr-terminal`؛
  المحوّلات تملك الأداتين في `tools.js`. Codex لم يُعدّل: `main.js` يجمع تعديلاته مثل
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
  والمحوّلات المتوافقة مع OpenAI. **ومحرك Codex** (أُغلق التأجيل): كتلة
  `<satr_project_memory>` عنصرَ نصٍّ مستقلاً في `inputItems` قبل نص الدور، مستَرجعة من
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
  الحدث `execution_team_update` (schema v1) يغذّي لوحة `/تنفيذ-معزول`: إعداد عاملين افتراضياً
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
- **النتيجة والبوابة**: النتيجة العامة محصورة في
  `{artifact_id,state,checks:[{id,label,passed,exit_code,timed_out,duration_ms}]}` بلا command أو خرج
  خام أو أسرار. `merger.js` يرفض العمل إلا مع بوابة مراجعات `approve` ونتيجة `passed` للبصمة نفسها
  وتأكيد الدمج، ثم يطبق حراس HEAD ونظافة الشجرة و`git apply --check` السابقة بلا commit أو push أو
  rebase أو تغيير history.
- **IPC والواجهة**: القنوات `satr:executionVerificationPrepare/Run/Stop/Latest` محددة في preload؛
  لوحة التنفيذ تعرض الأوامر المثبتة أولاً وزر تشغيل مستقل، ولا تظهر «دمج» إلا بعد نجاح تحقق الأثر نفسه.
- **الاختبار**: `npm run test:integration` يستخدم مستودع Git حقيقياً لنجاح/فشل/مهلة/مقاطعة، غياب
  الإعداد، رفض بلا تأكيد، رفض تعديل الإعداد داخل patch، تبدل artifact، تنظيف كل worktree، منع تسريب
  الخرج، وبقاء المصدر بلا لمس حتى الدمج الصريح. اختبارات `verify/worktrees/reviewmerge/executionteam`
  و`eval:agent` عقود عدم تراجع إلزامية.

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
  `npm run test:opscontinuity` يغطي غياب التشفير والعبث والفهرسة والاستعادة والتسوية والاحتفاظ.

### واجهة غرفة العمليات (المرحلة 7)

- **السطح والتصنيف**: `satr-ops-room` لوحة عمل جانبية واحدة بتمرير داخلي وثلاثة أقسام هادئة:
  «العمل» للعصف والمهام والنشاط، و«النتائج» للفروقات والأدلة والمراجعة، و«السجل» للقرارات
  والنقاش والتاريخ. داخل كل قسم تظهر مفاتيحه الفرعية فقط، وتنبّه شارة نصية إلى الفشل أو نتيجة
  لم تُعرض بعد من دون إضافة حالة إلى IPC أو schema.
  أحداث السجل الحية تدخل الخيط كبطاقات inline مطوية عبر `chat.showOpsEvent` و`cardSheet` المشتركة.
  تأكيد بدء التنفيذ وتشغيل الاختبارات والدمج يمر عبر `satr-ops-dialog` الحاجب؛ التنبيهات غير
  القرارية تبقى في `status`/الإشعارات ولا تحمل سير قرار.
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
  وانتهاء المهلة وإرشاد التعافي ومنع تكرار الإشعار تحت CSP الفعلية.
- **العصف والتقسيم الاقتراحي**: عرض العصف داخل قسم «العمل» يرسل brief منقّى إلى SDK وCodex بصورة مستقلة ومربوطة
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
- **الأمان والعرض**: الواجهة تستهلك snapshots العامة والسجل المنقّى فقط؛ لا تستقبل patch ولا
  `source_root` ولا خرج أوامر كاملاً. بطاقات الفروقات تعرض المسار والإضافات/الحذف فقط، وكل بطاقة
  تعرض actor/engine/artifact/time مع عزل المعرّفات والمسارات LTR.
- **الحوكمة والاختبار**: سلالم `--z-*` و`--space-*` و`--radius-*` في `base.css`، والأوراق
  `panelSheet/cardSheet` عبر `adoptedStyleSheets`. `npm run test:opsroom-ui` يستورد reducer الفعلي
  ويختبر ترتيب/إزالة تكرار الأحداث، حالات الأزرار، رفض البصمة القديمة، CSP، وحارس z-index/HTML/
  Shadow DOM على الملفات المتغيرة. لم يتغير عقد IPC ولم تُضف اعتمادية.
  يشغّل `npm run test:opsroom-all` طقم غرفة العمليات القطعي بالتسلسل، وتبقى اختبارات Electron الأبطأ منفصلة في `npm run test:opsroom-all-live`.
- **حد أمني ثابت**: التنفيذ الإنتاجي ما زال عبر Claude SDK فقط؛ فريق Codex أو فريق مختلط غير
  متاح لأن حاجز 3A أثبت قراءة/كتابة خارج worktree وتجاوز ownership وأغلق 3B. Codex يبقى مراجعاً
  قراءة فقط. لا تعرض الواجهة اختياراً يوحي بعزل غير مثبت، ولا يُفتح هذا الحد ضمن عمل UI.

### أوامر التكافؤ مع Claude Code (الدفعة الأخيرة قبل التجميد)

ثلاثة أوامر أساسية تطابق ما يعتمده مستخدم Claude Code اليومي. **بعد هذه الدفعة تُجمَّد
الأوامر** (لا أوامر جديدة قبل الإصدار — المرحلة 6). كلها عبر محرك SDK فقط.

- **`/موصلات` (MCP)**: لوحة جانبية لحالة خوادم MCP. IPC `satr:mcpStatus(cwd)` →
  `{ok, servers:[{name, status, scope, serverInfo, error, tools}]}` عبر `query().mcpServerStatus()`
  في تشغيل عابر (`withControlQuery` في agent.js). الحالات: `connected`/`pending`/`needs-auth`/
  `failed`/`disabled`. الإجراءات عبر `satr:mcpAction {cwd, name, action}` حيث action ∈
  `{reconnect, enable, disable}` (تُنقّى بـ `SAFE_MCP_NAME` و `MCP_ACTIONS` في main.js) →
  `reconnectMcpServer`/`toggleMcpServer`. **حدّ معروف**: الـ SDK لا يقود مصادقة OAuth في المتصفح،
  فموصّل `needs-auth` يُصادَق عليه من Claude Code (الأمر `/mcp`) ثم «تحديث»؛ «إعادة الاتصال»
  أفضل جهد. الإجراءات تحدّث اللوحة لتكشف الحالة الفعلية.
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
- **العقد**: `{type:'update', phase:'available'|'progress'|'ready'|'error', version?, percent?}`.
  الخطأ يُخفي الإشعار صامتاً (يبقى التثبيت اليدوي متاحاً). preload يكشف
  `downloadUpdate` و`restartUpdate` فقط.
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
  (تصفير `$LASTEXITCODE`+السقوط لـ `$?`)، ومهلة (120ث تقطع الخوادم التفاعلية) وسقف خرج 512ك.ب.
- **🔒 أمان (مثبّت)**: الأداة تمر بـ `canUseTool` مثل Bash تماماً — **لا** تُضاف لـ
  `alwaysAllowed`، فمربع الإذن العربي يعمل عليها؛ العرض المرئي لا يخفّف التنفيذ. الأمر نص
  لمجرى pty لا لوسائط spawn، وبايتات التحكم تُنقّى (`sanitizeCommand`). حدّ موثّق:
  التطبيقات التفاعلية طويلة العمر تُقطع بالمهلة (الخرج حتى تلك اللحظة يعود للنموذج).

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
- **IPC**: `satr:gitChanges {cwd}` → `{ok, repo, files:[{rel, kind, staged, renamedFrom?,
  skipped?, added, removed, lines, truncated}], more, partial}` (أُضيف `staged`) ·
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
  في MVP): شريط تبويبات في الرأس (تبويب لكل طرفية + زرّ ＋)، بسقف 8. كل تبويب كائن
  مستقل في الواجهة (نسخة xterm + عارضاه + إسقاط BiDi + حالة عرض)، والنشط وحده ظاهر
  (`.term-view.active`)؛ الرأس وسطر الإدخال والتنبيه تعمل على النشط. موجّه `satr:term`
  يوزّع الأحداث بالمعرّف على تبويبها (الخلفية متعددة عبر Map في term.js منذ 15.1).
- **أسماء التبويبات (المرحلة 15.4)**: الاسم مشتق من الصدفة ثم OSC منقّى بسقف 40 محرفاً وthrottle، وF2 يثبت اسماً يدوياً لعمر التبويب؛ يحرسها `npm run test:terminal-tabs`.
- **العقد (IPC)** — كله في `electron/term.js` مع تنقية في main.js:
  - `satr:termStart {cwd, cols, rows}` → `{ok, id, shell}` — ينشئ pty **جديداً** كل مرة
    (سجلّ Map بسقف MAX_TERMS=8؛ الصدفة `COMSPEC`/PowerShell، cwd مجلد موجود، cols/rows 2..500).
    `satr:termList` يعيد المعرّفات الحيّة.
  - `satr:termInput {id, data}` — كتابة خام إلى pty (id يطابق `^term_[0-9]+$`، data نص
    ≤ 1م.ب). البرومبت/الإدخال آمن لأنه يذهب لـ pty لا لوسائط spawn.
  - `satr:termResize {id, cols, rows}` — أعداد صحيحة 2..500.
  - `satr:termKill {id}` — إنهاء العملية (شجرتها تموت مع ConPTY).
  - أحداث للواجهة عبر قناة مستقلة `satr:term` (عالية الإنتاجية — لا تمر بقناة `satr:event`):
    `{type:'data', id, data}` و `{type:'exit', id, exitCode}`.
  - preload يكشف: `termStart/termInput/termResize/termKill/onTerm` فقط.
- **دورة الحياة**: pty يُقتل في `window-all-closed`/`before-quit` (نفس فلسفة bgprocs)،
  وخروج الصدفة يصل الواجهة كحدث `exit` فتعرض «انتهت الجلسة» وزرّ إعادة تشغيل.
- **الترميز (تصحيح مثبت بالتجربة)**: خرج البرامج يصل UTF-8 سليماً بلا ضبط، لكن **صدى
  الإدخال** العربي يمر بصفحة ترميز conhost القديمة فيصير «؟؟؟». الحل في term.js: PowerShell
  يُشغَّل بـ `-NoExit -Command [Console]::InputEncoding=[Console]::OutputEncoding=UTF8`
  (وcmd بـ `/K chcp 65001 >nul`) — تحقق آلي: `ARABIC_ECHO=true QMARKS=false`.
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
- **تذكّر لكل مجلد + خادم متوقف (م-1-د)**: العنوان يُحفظ **لكل cwd** (`satr_preview_url::
  <cwd>` — المكوّن يقرأ #cwd) بلا fallback عام، فلكل مشروع منفذه ولا تلوّث بينها. وعند
  فشل الوصول رسالة واضحة توجّه «اطلب من الوكيل شغّل المشروع». **مبدأ**: المعاينة **تعرض**
  خادماً حيّاً لا **تشغّله** — تشغيله مهمة الوكيل/المستخدم، واستئناف جلسة لا يحيي خوادمها.
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
  (مقصوصاً عند 600 محرف؛ لا يضاف إلى بطاقة الأداة). قائمة النطاقات لم تلزم لأن الإذن
  اليدوي لكل فعل أقوى.
- **ترقية أفعال المتصفح — لقطة + ref حتمي (2026-07-12)**: نمط Playwright MCP/browser-use
  الصناعي (بحث موثّق): بدل تخمين النموذج مُحدِّد CSS من outerHTML (هشّ)، أداة جديدة
  `browser_snapshot` تعطي لقطة مدمجة لكل عنصر تفاعلي `[ref] role "name"` (تسِم كلاً بسمة
  `data-satr-ref="eN"` — كفاءة رموز عالية)، و`browser_click`/`browser_type` قبِلا **ref**
  (مثل e5 ⇒ يُحلّ عبر `[data-satr-ref]` حتمياً) مع **إبقاء مُحدِّد CSS تراجعاً** (لا كسر
  عقد م-4: resolve يميّز `^e\d+$` من المُحدِّد). **الـ ref يقدُم بعد أي تنقّل/تغيّر DOM**
  (يُعاد أخذ اللقطة — قاعدة صناعية مثبّتة). أُضيفت `browser_navigate(url)` (تنقّل العرض
  القائم) و`browser_wait_for({text|selector, timeout_ms})` (استقصاء دوري للصفحات
  الديناميكية). كله في `preview.js` (snapshot/waitFor/resolve — بلا preload، صفر
  اعتماديات) + كتلة أدوات المتصفح في `agent.js` + توجيه systemPrompt (حلقة
  snapshot→act→snapshot). تحقّق حيّ (مسبار معزول 8/8، خادم HTTP فعلي): لقطة بأدوار/أسماء/
  refs صحيحة · نقر/كتابة بـ ref يغيّران DOM ويُطلقان input · wait_for (ظهور/مهلة) ·
  تراجع CSS · ref قديم بعد reload ⇒ not_found · مُحدِّد فاسد ⇒ bad_selector.
- **وضع تحكّم المتصفح (نمط Comet — 2026-07-12)**: زرّ toggle `#browserCtl` بجوار زرّ
  الإرسال (🖱️ متصفح) يمنح الوكيل صلاحية قيادة المعاينة بسلاسة (حلقة snapshot→act بلا مربع
  إذن لكل فعل). العلم `browserControl` يمرّ في send (app.js `browserControlOn` +
  localStorage `satr_browser_control`، منقّى في main.js boolean) إلى `agent.start` و
  `codex.start`. **الأمان (حرج، fail-safe)**: في SDK يوافق `canUseTool` تلقائياً **فقط**
  على أدوات المتصفح الثماني
  المؤهَّلة (`BROWSER_AUTO_TOOLS` = mcp__satr-terminal__{open_preview,read_page,screenshot,
  browser_snapshot,browser_click,browser_type,browser_navigate,browser_wait_for}) — و
  **`run_in_terminal` وكل أدوات الملفّات تبقى تطلب إذناً** (ليست في المجموعة، فأي اسم
  خاطئ يُقلّل الصلاحية لا يزيدها). معطّل افتراضياً، حالته ظاهرة (زرّ ذهبي `.active` +
  aria-pressed) وإشعار عربي عند التبديل. **Codex يملك الرؤية والأفعال نفسها** عبر
  `codexmcp.js`؛ أفعاله تمرّ افتراضياً عبر `requestPermission` داخل الخادم ويعفيها
  `browserControl` الصريح. المحوّلات لا تملك أدوات المتصفح.
  تهديد حقن البرومبت من صفحات الويب يبقى قائماً — لذا الوضع اختياري صريح يبادر به المستخدم.
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
  متاحة دائماً: زر «متصفح» مفعّل = تفويض صريح بلا مربعات متكررة، ومطفأ = كل tools/call
  يمرّ بمربع الإذن العربي (بما فيه open_preview والقراءة)، بينما `browserControl:false`
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
    `resolvePermission` (قناة أذونات الأوامر نفسها). bypassPermissions أو «موافقة دائمة»
    للأداة يعفيان؛ الرفض/إيقاف الدور يفكّ الإذن المعلّق. القراءة/الرؤية لا تُبوَّب. تحقّق:
    `npm run test:codexmcp` (29 — يشمل بوابة الإذن قبولاً/رفضاً وعدم تبويب القراءة) +
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
    الاختبار: `test:browserguard` (نقي 31) + توسعة `test:codexmcp` (47 — دورة كاملة
    استلام/إلغاء/تعليق/fail-closed).
- **تسجيل فيديو التصفح (م-5 — طلب مالك)**: زرّ ⏺ يسجّل جلسة المعاينة فيديو قابل للتنزيل
  بصفر اعتماديات: `preview.captureFrame()` (PNG دوري ~8/ث عبر satr:previewFrame) ⇒
  رسم على `<canvas>` مخفي ⇒ `captureStream(8)` ⇒ `MediaRecorder` ⇒ Blob ⇒ `<a download>`
  (نمط تصدير 4.8 — لا CSP جديد). يسجّل العرض وحده؛ الإغلاق يوقف وينزّل.
- **الحاوية mp4 مفضّلة (دفعة «mp4»)**: `pickRecMime()` يفاضل `video/mp4;codecs=avc1…`
  أولاً ثم webm عبر `MediaRecorder.isTypeSupported`، والنوع والامتداد يتبعان المُختار.
  التنزيل ليس صامتاً بعد الآن: `previewrecording.js` يعترض فقط أسماء `satr-preview-*`
  القادمة من renderer الرئيسي، يثبت مساراً فريداً داخل `app.getPath('downloads')`، ثم يبث
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
  (`satr_theme=light|dark`)؛ وإن غاب المفتاح يتبع `prefers-color-scheme` كافتراضي أول تشغيل،
  والاختيار اليدوي يغلبه ويُحفظ. المنطق في `app.js` (`applyTheme/initTheme`) يُطبَّق مبكراً
  لتقليل الومضة، والثيمة على `<html>` فتعبر حدود Shadow بالوراثة (لا مساس بأي مكوّن).
  **سطحا الكود يبقيان داكنين دائماً**: الطرفية (`#termPanel`) والعارض (`satr-file-viewer` —
  الـ tokens تعبر Shadow بالوراثة من المضيف في light DOM) يُعاد تثبيت القيم الداكنة عليهما
  في الوضع الفاتح، و`--bg-deep` لا يُقلب — قرار موثّق: عكس لوحة ANSI/ألوان الكود على خلفية
  فاتحة رديء، وxterm ألوانه صلبة في JS. `color-scheme` يُقلب مع الثيمة (عناصر أصلية/تمرير).
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
- **حفظ المسودة**: نص المحرّر في `localStorage` (`satr_draft`) يُستعاد عند الإقلاع
  ويُمسح عند الإرسال/تشغيل أمر.
- **بحث الجلسات**: حقل ترشيح فوري (`#sessSearch`) بالعنوان أو المجلد في لوحة `/جلسات`؛
  Escape يمسح النص أولاً ثم يغلق اللوحة.
- **إشعار اكتمال الدور**: `Notification` عند `result` والنافذة غير مركزة
  (`document.hasFocus()`) — النقر يعيد التركيز. يظهر باسم «سطر» بفضل AppUserModelId.

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
  `newAssistantBlock(label)` بعقدها للقشرة، ويعتمد diffSheet على المستند).
- **دروس مثبّتة**: retargeting نقرات Shadow على مستمع المضيف ⇒ `composedPath()[0]`؛
  نداء مبكر لمكوّن ⇒ `customElements.whenDefined`؛ grep لكل id/صنف قبل حذف CSS.

## قواعد إلزامية

1. **الأمان أولاً**: لا تعطّل `contextIsolation` أو `sandbox`، ولا تفعّل `nodeIntegration`.
   كل قدرة جديدة تمر عبر preload.js بدالة محددة — لا تكشف ipcRenderer كاملاً أبداً.
2. **التحقق من المدخلات في main.js**: أي قيمة تدخل في وسائط spawn يجب أن تمر على
   regex تحقق صارم (انظر SAFE_SESSION و SAFE_MODEL الموجودة). البرومبت نفسه آمن لأنه عبر stdin.
3. **العربية أولاً**: كل نص واجهة بالعربية. النصوص المختلطة تستخدم `dir="auto"` أو
   `unicode-bidi: plaintext`. الأكواد والمسارات والأرقام التقنية دائماً `direction: ltr`.
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
