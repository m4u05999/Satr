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

