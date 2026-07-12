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
                        ويمنع AskUserQuestion عبر disallowedTools: أداة اختيار تفاعلية لا يوفّر «سطر»
                        واجهتها (canUseTool سماح/رفض فقط) فكانت تعلّق — منعها يجعل النموذج يسأل نصّاً.
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
electron/skills.js   ← سرد المهارات المكتشَفة (<cwd>/.claude/skills و ~/.claude/skills) للوحة
                       /مهارات (قراءة فقط + تحليل مقدمة SKILL.md، المشروع يفوز عند تكرار الاسم)
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
                       2.1–2.3 بالأذونات العربية). محرك SDK يبقى خاصاً في
                       agent.js (لا يُلفّ). انظر «طبقة المحوّلات والمزوّدين» أدناه + docs/ARCHITECTURE.md
electron/keys.js     ← مخزن أسرار «سطر» (~/.satr/keys.json): get/names/set/remove — بذرة إدارة
                       مفاتيح المزوّدين (نقطة الربط §4.3). القيم لا تُعاد للواجهة أبداً
electron/tools.js    ← أدوات الوكيل للمحوّلات العمياء (الدفعتان 2.1/2.2): defs() تعريفات
                       بصيغة OpenAI tools + run(name, cwd, args, ctx) تنفيذ محلي يعيد
                       {ok, content}. القراءة: read_file/list_files (فوق files.js المؤمَّنة،
                       سقف نتيجة 48ك، بلا إذن — تطابق Claude Code) وsearch_code (4.6 —
                       بحث «دلالي خفيف» فوق search.js، بلا إذن — نمط Grep). الكتابة (2.2):
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
                       (§4.2) + openaiCompatible (المصنع — Enterprise يبني عليه بلا تكرار) +
                       registerIpc (قنوات satr:ee: حصراً — §4.5) + subscribe (§4.7 مجرى
                       مراقبة أحداث: main.js يبثّ عبر notify() كل أحداث الدور + prompt +
                       permission_reply — للتدقيق والاستهلاك). notify رخيص بلا مشتركين
enterprise/          ← طبقة Enterprise (الدفعة 3 — رخصة تجارية في enterprise/LICENSE،
                       ليست MIT): index.js (نقطة الدخول: ترخيص ⇒ أعلام ⇒ تسجيل قدرات) +
                       licensing.js (⚠️ ليس license.js — يتصادم مع ملف LICENSE على ويندوز
                       غير الحساس لحالة الأحرف؛ يقرأ ~/.satr/license.json: key بنمط
                       SATR-EE-XXXXXX-XXXXXX + exp + features) + providers/ollama.js
                       (3.1: نماذج محلية فوق مصنع openai-compatible — http://127.0.0.1:11434،
                       بلا مفتاح، يرث حلقة الوكيل كاملة، وإرشاد عربي عند غيابه عبر
                       connectHint) + usage.js (3.3: ~/.satr/usage/YYYY-MM.jsonl + تجميع
                       satr:ee:usage) + audit.js (3.4: ~/.satr/audit/YYYY-MM-DD.jsonl —
                       prompt/tool_use/file_edit/أذونات + satr:ee:audit).
                       البناء المجتمعي يستثنيه (!enterprise/** + قائمة السماح)؛ بناء EE
                       عبر npm run dist:ee (scripts/ee-builder-config.js يوسّع إعداد
                       package.json). حذف المجلد كلياً = النواة تعمل كاملة (معيار §1 —
                       متحقَّق آلياً). قسم «سطر Enterprise» في ⚙ يظهر عند تحميل الطبقة
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
                       والعرض الأصلي يطفو فوقه؛ أحداثه عبر قناة satr:preview
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
                       (HL_CFG + hlLine). جسر window.SatrUI أُزيل في ت-13 — استيراد مباشر فقط
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
scripts/update-csp.js ← يحدّث هاشات CSP لكتل style/script المضمّنة — يعمل تلقائياً قبل start و dist
scripts/make-icon.js  ← يولّد build/icon.ico من علامة «سطر» (بلا اعتماديات: zlib يبني PNG ثم
                       يُحزَم ICO) — يُشغَّل يدوياً عند تغيير العلامة، والملف الناتج مُلتزَم
docs/PLAN.md         ← خطة التنفيذ المرحلية — اقرأها قبل أي مرحلة جديدة
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
     (`sanitizeSkills` + `SAFE_SKILL`) وتُمرَّر كخيار `skills` للـ SDK في agent.js. محرك
     **sdk** فقط (مسار cli لا يضبطها). انظر «لوحة المهارات» أدناه.
   - `effort` (⚙ — المرحلة 14.4): مستوى جهد التفكير `low|medium|high|xhigh|max` أو فارغ
     (الافتراضي). يُنقّى بـ `EFFORT_LEVELS` في main.js ويُمرَّر كخيار `effort` — الـ SDK
     يخفّضه صامتاً إن لم يدعمه النموذج. محرك **sdk** فقط.
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

### طبقة القدرات ونموذج Community + Enterprise (features.js — المرحلة 5ج)

**التصميم الكامل في `docs/ARCHITECTURE.md`** (نموذج «النواة + Enterprise إضافي» بطريقة
مستودع GitHub واحد + مجلد `enterprise/` مُقفل — اقرأه قبل أي عمل يمسّ الفصل).
- **`electron/features.js`**: المُحمِّل الشرطي (`try require('../enterprise')`) + feature-flags.
  النواة تعمل **كاملة** إن غاب `enterprise/` (معيار قبول دائم). فشل Enterprise معزول لا
  يُسقط النواة. `features.init()` في main.js؛ IPC `satr:features` (لقطة القدرات).
- **نقاط الربط**: §4.1 مُحمِّل شرطي، §4.2 سجلّ المحوّلات، §4.3 مخزن الأسرار، §4.4 flags.

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

- **السرد**: IPC للقراءة فقط `satr:listSkills(cwd)` (`electron/skills.js`) يفحص
  `<cwd>/.claude/skills/*/SKILL.md` و `~/.claude/skills/*/SKILL.md`، يحلّل مقدمة YAML البسيطة
  (`name`/`description` بلا اعتماديات) ويعيد `[{name, description, source}]`. عند تكرار الاسم
  تفوز مهارة المشروع (تُفحص أولاً).
- **التفعيل**: محرك SDK يكتشف المهارات من القرص عند كل تشغيل؛ خيار `skills` يفلتر ما يُعرض
  للنموذج: `'all'` (كل المكتشفة) أو مصفوفة أسماء. agent.js يضبطه **دائماً صراحةً** — تركه
  محذوفاً يجعل التحميل يعتمد على افتراضيات الـ CLI وغير مضمون (انظر توثيق الخيار في sdk.d.ts).
- **الواجهة**: أمر `/مهارات` يفتح لوحة جانبية بمربعات اختيار. تُخزَّن **المهارات المعطّلة** في
  localStorage (`satr_disabled_skills`) لا المفعّلة، فيُفعَّل أي جديد تلقائياً. عند الإرسال:
  لا معطّل ⇐ `'all'`؛ غير ذلك ⇐ مصفوفة (المكتشف ناقص المعطّل)، ومصفوفة فارغة = لا مهارات.
- **مثال**: `.claude/skills/tafqeet/SKILL.md` (تفقيط الأرقام بالعربية) — مهارة مشروع للتجربة.

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
- **التدفق**: فحص بعد 8ث من الإقلاع ⇒ تنزيل خلفي تلقائي (`autoDownload`) ⇒ إشعار عربي
  لا يقاطع أسفل النافذة، وزرّ «أعد التشغيل الآن» عند الجهوز (`quitAndInstall`)؛ وإلا
  يُثبَّت عند الإغلاق (`autoInstallOnAppQuit`). الأحداث تُبثّ للواجهة كنوع `update` عبر
  `emitToWindow` (قناة satr:event، مستقلة عن الدور)، وIPC `satr:restartUpdate` للتثبيت.
- **العقد**: `{type:'update', phase:'available'|'progress'|'ready'|'error', version?, percent?}`.
  الخطأ يُخفي الإشعار صامتاً (يبقى التثبيت اليدوي متاحاً). preload يكشف `restartUpdate`.
- **تمهيد**: التحديث يبدأ من أول إصدار يحوي المُحدِّث (v2.4.1). النشر يرفع `latest.yml`
  مع المثبّت لكل إصدار (يولّده electron-builder عند dist مع publish config).

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
  - IPC `satr:preflight` (يستبدل `satr:check` القديم) → `{claude:{ok, version, path}, node:{ok,
    version}, npm:{ok, version}}`. يفحص node و npm (تستخدمهما خطوات الإرشاد) وclaude. يستدعي
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
  - **IPC**: `satr:writeFile {cwd, rel, content}` → `{ok, card}` أو `{ok:false, error:
    bad_input|bad_cwd|too_big|outside|notfound|error(+message)}`. التنقية في main.js
    (القاعدة 2: cwd مجلد قائم، rel ≤ 512، content نص) والتنفيذ عبر
    `tools.saveFromViewer` — **إعادة استخدام** المسار المؤمَّن نفسه: `resolveExisting`
    (تسامح NFC/NFD) + `readBefore` (رفض الثنائي/الضخم) + `commitWrite` (سقف 1م.ب +
    لقطة `editSnapshots` فالتراجع القائم يعمل). كتابة **ملف قائم فقط** (العارض لا ينشئ).
    preload يكشفه `writeFile(cwd, rel, content)`.
  - **بطاقة diff خارج الدور (درس مثبّت)**: بيانات `file_edit` تعود في **الردّ** (`card`)
    لا حدثاً عبر `satr:event` — حدث خارج دور يسقط على حارس الكتلة (`currentBlock`).
    الواجهة تبنيها بـ `buildDiff` وتضيفها للمحادثة مستقلة (`addStandaloneDiff`) — طيّ
    وتراجع يعملان كأي بطاقة. **حدّ موثّق**: لا كشف تعارض إن تغيّر الملف على القرص بين
    الفتح والحفظ (آخر كاتب يفوز، والتراجع متاح).
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
  لصق متعدد الأسطر يمرَّر خاماً فوراً. لا IPC جديد — كله عبر `satr:termInput` القائم.
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
- **أدوات الفعل بالإذن (م-4)**: `browser_click(selector)` + `browser_type(selector, text)`
  في خادم satr-terminal، على العرض القائم عبر `preview.clickElement/typeText`
  (executeJavaScript؛ selector يُهرَّب بـ JSON.stringify؛ الكتابة عبر native value setter
  + input/change لتوافق React). **الأمان (حرج)**: تمرّان بـ `canUseTool` مثل Bash —
  مربع الإذن العربي كل مرة (لسن في alwaysAllowed)، bypassPermissions وحده يعفيها؛
  `toolDetail` يُظهر selector في الإذن. قائمة النطاقات لم تلزم (الإذن اليدوي لكل فعل
  أقوى). حدّ: النص المكتوب لا يظهر كاملاً في الإذن (selector فقط).
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
  localStorage `satr_browser_control`، منقّى في main.js boolean) إلى `agent.start`.
  **الأمان (حرج، fail-safe)**: canUseTool يوافق تلقائياً **فقط** على أدوات المتصفح الثماني
  المؤهَّلة (`BROWSER_AUTO_TOOLS` = mcp__satr-terminal__{open_preview,read_page,screenshot,
  browser_snapshot,browser_click,browser_type,browser_navigate,browser_wait_for}) — و
  **`run_in_terminal` وكل أدوات الملفّات تبقى تطلب إذناً** (ليست في المجموعة، فأي اسم
  خاطئ يُقلّل الصلاحية لا يزيدها). معطّل افتراضياً، حالته ظاهرة (زرّ ذهبي `.active` +
  aria-pressed) وإشعار عربي عند التبديل. محرك SDK فقط (أدوات المتصفح لا توجد في codex.js).
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
- **تسجيل فيديو التصفح (م-5 — طلب مالك)**: زرّ ⏺ يسجّل جلسة المعاينة فيديو قابل للتنزيل
  بصفر اعتماديات: `preview.captureFrame()` (PNG دوري ~8/ث عبر satr:previewFrame) ⇒
  رسم على `<canvas>` مخفي ⇒ `captureStream(8)` ⇒ `MediaRecorder` ⇒ Blob ⇒ `<a download>`
  (نمط تصدير 4.8 — لا CSP جديد). يسجّل العرض وحده؛ الإغلاق يوقف وينزّل.
- **الحاوية mp4 مفضّلة (دفعة «mp4»)**: `pickRecMime()` يفاضل `video/mp4;codecs=avc1…`
  أولاً ثم webm عبر `MediaRecorder.isTypeSupported`، والنوع والامتداد يتبعان المُختار.
  **قرار مثبّت بمسبار حيّ**: Electron 33 (Chromium 130) يدعم MediaRecorder بحاوية mp4
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
  perm-dialog يبثّ `perm-visible {visible}` عند كل ظهور/إخفاء، والقشرة تستدعي
  `previewEl.holdForDialog(visible)` فتُخفي العرض الأصلي (previewBounds صفر) أثناء المربع
  ثم تعيده بعد الرد — المربع يبرز فوق اللوحة. (`held` يمنع reportBounds من الإبلاغ أثناء الحجب.)

### نظام التصميم (الدفعة 4.1)

- **Design Tokens في `:root`** (src/index.html): الرمادية الدافئة مقتبسة **قيماً** من مقياس
  Sand الداكن في Radix Colors (نسخ قيم لا تثبيت حزم)، والدلاليات من Grass/Red الداكنين.
  الهوية الذهبية `--gold: #D9A441` ثابتة. **الأسماء القديمة باقية تعمل**
  (`--bg/--surface/--surface-2/--border/--text/--text-dim/--gold-soft/--green/--red`)
  وأُضيفت درجات جديدة: `--bg-deep` (الطرفية/عارض القراءة — بديل ‎#0B0E13 الصلب)،
  `--surface-3`، `--border-dim/-strong`، `--text-faint` (أرقام الأسطر)، `--gold-strong/-border`،
  `--green-soft/-border`، `--red-soft/-border`، وظلال (`--shadow-pop/-panel/-modal`)
  وحركة موحّدة (`--ease`, `--dur`). **قاعدة حاكمة**: كل لون عبر متغيّر — لا تُدخل ألواناً
  صلبة جديدة في CSS (شرط عمل الوضعين معاً).
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
  تملك حالة التطبيق ومجرى `satr:event`؛ 14 مكوّناً ذاتي التسجيل في `src/ui/components/`؛
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
- أوضاع الصلاحيات: `default`, `acceptEdits`, `plan`, `bypassPermissions`
- جلسات Claude Code المحفوظة محلياً: `~/.claude/projects/<مسار-مرمّز>/*.jsonl` — تُستخدم في المرحلة 2 (متصفح الجلسات)
- للترقية المستقبلية: Claude Agent SDK (TypeScript) يوفر تحكماً برمجياً كاملاً بما فيه
  اعتراض طلبات الأذونات — هذا أساس المرحلة 3. تحقق من توثيقه الرسمي قبل البدء.

## خطة العمل

اقرأ `docs/PLAN.md` — لا تنفذ أكثر من مرحلة واحدة في الجلسة الواحدة،
وبعد كل مرحلة: شغّل التطبيق، تحقق من معايير القبول المذكورة، ثم قدّم ملخصاً.
