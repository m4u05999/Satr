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
                        كما يوفّر withControlQuery: تشغيل عابر لاستدعاء «دوال التحكّم» في SDK
                        (mcpServerStatus/reconnectMcpServer/toggleMcpServer/getContextUsage) للوحتي
                        /موصلات و /سياق — مولّد إدخال ينتظر فقط ليُبقي العملية حيّة، ثم close+q.close())
electron/preload.js  ← جسر آمن: يكشف window.satr فقط (contextIsolation مفعّل)
electron/sessions.js ← قراءة جلسات ~/.claude/projects (قراءة فقط + تحقق صارم من المسارات)
electron/files.js    ← سرد ملفات المشروع لمنصّة @ (مشي محدود + تجاهل مجلدات ثقيلة + تخزين
                       مؤقت لكل cwd، قراءة فقط) — المرحلة 4
electron/skills.js   ← سرد المهارات المكتشَفة (<cwd>/.claude/skills و ~/.claude/skills) للوحة
                       /مهارات (قراءة فقط + تحليل مقدمة SKILL.md، المشروع يفوز عند تكرار الاسم)
electron/diff.js     ← حساب فرق الأسطر (قصّ بادئة/لاحقة + LCS محدود + طيّ السياق)
                       دالة نقية بلا اعتماديات — المرحلة 3
electron/bgprocs.js  ← متتبّع عمليات الخلفية المعمّرة (خوادم التطوير): الـ SDK لا يكشف
                       للمضيف أي مقبض لعمليات تُشغّلها الأدوات، فنتعقّبها على مستوى النظام.
                       خطّافا Bash (run_in_background) في agent.js يلتقطان أحفاد عملية «سطر»
                       قبل/بعد الأمر، والفرق = PIDs الأمر — تُسجَّل وتعيش بعد الدور فيقتلها
                       المستخدم من شريط «قيد التشغيل». السجلّ في العملية الرئيسية (مستقل عن الدور)
src/index.html       ← الواجهة كاملة (HTML/CSS/JS في ملف واحد حالياً)
scripts/update-csp.js ← يحدّث هاشات CSP لكتل style/script المضمّنة — يعمل تلقائياً قبل start و dist
scripts/make-icon.js  ← يولّد build/icon.ico من علامة «سطر» (بلا اعتماديات: zlib يبني PNG ثم
                       يُحزَم ICO) — يُشغَّل يدوياً عند تغيير العلامة، والملف الناتج مُلتزَم
docs/PLAN.md         ← خطة التنفيذ المرحلية — اقرأها قبل أي مرحلة جديدة
```

ملاحظة CSP: لا يوجد `'unsafe-inline'` — أي `<style>` أو `<script>` مضمّن جديد في index.html
يتطلب إعادة حساب الهاش، وهذا يحدث تلقائياً عبر `prestart`/`predist`. السمات المضمّنة
(`style="..."` أو `onclick="..."`) محظورة — استخدم CSSOM و addEventListener.
قالب الـ CSP نفسه (التوجيهات لا الهاشات) معرّف في `scripts/update-csp.js`، فأي توجيه جديد
يُضاف هناك لا في index.html مباشرة (وإلا داسه `prestart`). مثال: `img-src 'self' data:`
أُضيف للمرحلة 4 ليسمح بمصغّرات الصور الملصقة (data: URL).

### تدفق البيانات

1. الواجهة تستدعي `window.satr.send({prompt, cwd, sessionId, model, permissionMode, engine, images, skills})`
   - `images` (المرحلة 4): مصفوفة `[{media_type, data}]` للصور الملصقة، `data` base64 خالص.
     تُنقّى في main.js (`sanitizeImages`: أنواع `image/png|jpeg|webp|gif`، ≤10م.ب base64، ≤6 صور).
     محرك **sdk** فقط يدعمها (agent.js يبني `content` كمصفوفة كتل نص+صورة)؛ محرك **cli**
     يتجاهلها (الواجهة تنبّه وتُسقطها). طلب بلا نص يُقبل إن رافقته صورة.
   - `skills` (لوحة /مهارات): `'all'` أو مصفوفة أسماء مفعّلة. تُنقّى في main.js
     (`sanitizeSkills` + `SAFE_SKILL`) وتُمرَّر كخيار `skills` للـ SDK في agent.js. محرك
     **sdk** فقط (مسار cli لا يضبطها). انظر «لوحة المهارات» أدناه.
2. حسب `engine` (قائمة «المحرك» في الواجهة، الافتراضي `sdk`):
   - **sdk** (المرحلة 2): `electron/agent.js` يستدعي `query()` من `@anthropic-ai/claude-agent-sdk`
     بإدخال بثّي (مولّد يبقى مفتوحاً حتى نهاية الدور — شرط عمل `interrupt()`)
     مع `includePartialMessages` و `canUseTool` و `resume/model/permissionMode/cwd`
   - **cli** (احتياطي): `claude -p --output-format stream-json --verbose [--resume id] …`
     - البرومبت عبر **stdin**؛ على ويندوز `shell: true` لأن claude قد يكون `.cmd`
     - يُشغَّل بـ `detached: true` (ويندوز): مجموعة عمليات وكونسول خاصّان به، فأي
       حدث تحكّم كونسول (CTRL_C/CTRL_BREAK) من خادم تطوير طويل العمر يبقى محبوساً
       في شجرته ولا يصل «سطر». الإيقاف بـ `taskkill /T /F` (نزولاً فقط، انظر killCurrent)
   - **عزل العمليات (حرج)**: العملية الرئيسية تتجاهل `SIGINT/SIGBREAK/SIGHUP` على
     ويندوز (انظر مناعة الكونسول في main.js) حتى لا يُسقطها حدث تحكّم كونسول قادم من
     عملية طفل. هذا ضروري لمسار **SDK** الذي يبثّ فيه الـ SDK عملية claude **بلا**
     detached (لا يتيح خياره)، فالمناعة هي حمايته الوحيدة. خروج «سطر» بإغلاق النافذة فقط.
3. الأحداث تصل الواجهة عبر `satr:event` — أحداث تشغيل ملغى تُحجب بـ `runSeq` في main.js
4. الواجهة تعالج الأحداث حسب `type`:
   - `system` (init): يحمل `session_id`
   - `assistant`: رسالة فيها `message.content[]` من نوع `text` أو `tool_use` (لها `id`, `name`, `input`)
   - `user`: نتائج الأدوات `tool_result` (لها `tool_use_id`, `is_error`)
   - `result`: النهائي — فيه `total_cost_usd`, `duration_ms`, `session_id`, `is_error`
   - `stream_text` (SDK فقط): جزء نصي تدريجي `{text}` — يُعرض فوراً ويُستبدل بنص `assistant` المكتمل
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

### متصفح الجلسات (المرحلة 1)

- IPC إضافي للقراءة فقط: `satr:listSessions` (قائمة الجلسات عبر كل المشاريع، الأحدث أولاً،
  العنوان من أول رسالة مستخدم أو `aiTitle`) و `satr:readSession {project, id}`
  (يعيد `{cwd, total, messages:[{role, text, tools?}]}` — آخر 40 رسالة مهيأة للعرض)
- التحقق في `electron/sessions.js`: أسماء المشروع والجلسة مكوّن مسار واحد عبر regex صارم
  (لا فواصل مسار ولا `..`) + فحص أن المسار النهائي داخل `~/.claude/projects`
- الاستئناف في الواجهة: أمر `/جلسات` يفتح اللوحة، والنقر يضبط `sessionId` و `cwd`
  ويعرض آخر الرسائل — الرسالة التالية تمر بـ `--resume` طبيعياً

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
- **التراجع**: agent.js يحتفظ بلقطة المحتوى السابق في `editSnapshots` (سقف 40، إخلاء الأقدم)
  تعيش بعد انتهاء التشغيل. `undoEdit(id)` يكتب «قبل» مجدداً أو يحذف الملف إن كان جديداً
  (`before == null`). الحدّ: ملفات > 2م.ب لا تُلتقط (لا فرق ولا تراجع).

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
  (انظر agent.js). البناء يستثني `claude-agent-sdk-win32-x64` عبر `files` فيبقى ~79م.ب.
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
