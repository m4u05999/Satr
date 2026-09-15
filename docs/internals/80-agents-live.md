## سطح الوكلاء الفرعيين الأحياء `<satr-agents-live>` (‏OBS-207 · OBS-151 — 2026-09-15)

> دفعة الواجهة. الحدث `sdk_agent_state` يبثّه فرع المحرّك بالعقد أدناه؛ هذا الملف يصف
> **المستهلك** (المكوّن والتوجيه والحارس) لا الباثّ.
>
> ⚠️ الرقم `80` لا `71` كما في حزمة المنفّذ: `71-boot-order-chat-guard.md` قائم منذ
> 2026-09-12، وإعادة استعمال الرقم تكسر فهرس `README.md` وحارس `test:claude-md-size`.

### العلّة — بلاغ المالك لا استنتاج

بلاغ 2026-09-14 (وكيل Opus 5 خلفي في نسخة عمل): «لم أجد في سطر كيفية رؤية الوكيل وهو
يعمل أو أين توقف؛ أحياناً يكون في السجل وأحياناً يختفي، والوكيل القديم يعطيني أنه انتهى».

القياس في الكود (‏`OBS-207`): بطاقة الوكيل **ابنةُ كتلة الدور** بثلاث طبقات:

1. `src/ui/components/chat.js` يُنشئ `agent-card` عند أداة `Task`/`Agent` من الخيط
   الرئيسي وحده — والاستئناف عبر `SendMessage` لا يمرّ بهذا الشرط فلا بطاقة له.
2. `src/ui/app.js` كان يُسقط `sdk_agent_progress` عند `!block || block.done`.
3. `endRun()` يضع `done = true` عند انتهاء الدور — فتقدّم الوكيل الخلفي **بعد** نتيجة
   الدور الرئيسي لا يصل أي بطاقة.

فالوكيل الخلفي يعيش أطول من الدور ويُستأنف عبر أدوار، بينما سطحُه الوحيد يموت مع الدور.

### القياسات المثبتة (‏SDK 0.3.270 / CLI 2.1.270 — مسبار `D:\sater\agents-live-probe\result.json`)

1. **مفتاح الهوية هو `task_id`** (‏`a1cadac9484258db2`): يساوي `requester` في
   `permission_request` (‏`agentID` في `canUseTool`) ويساوي المعرّف الذي يستأنف به
   النموذج الوكيلَ عبر `SendMessage`. ولذلك مفتاح الصف `taskId` **لا** `toolUseId`.
2. **الاستئناف = `task_started` جديد بالمعرّف نفسه** و`tool_use_id` جديد (أداة
   `SendMessage`) ثم `task_progress`/`task_notification` بمقطعه.
3. `task_progress.description` **يتغيّر** («Writing PROBE_A.txt») ويصف ما يفعله الوكيل
   الآن؛ و`summary` قد يغيب.
4. `task_notification.summary` هو ردّ الوكيل الأخير — وهو ما يجيب سؤال المالك «أين توقف؟».
5. `background_tasks_changed` قائمة كاملة بدلالة **REPLACE**؛ الغائب عنها بلا خاتمة بعدُ
   ليس منتهياً، بل «يُحسم…» (تصل خاتمته بعدها بأجزاء الثانية عادةً).

### عقد الحدث (مشترك مع فرع المحرّك — أسماء الحقول لا تتغيّر)

```js
{ type: 'sdk_agent_state', taskId, kind: 'started',
  toolUseId?, description, subagentType?, taskType: 'local_agent'|'local_bash'|string,
  backgrounded: true|false, spawnDepth?, resumed: true|false }
{ type: 'sdk_agent_state', taskId, kind: 'progress', toolUseId?, description?, summary? }
{ type: 'sdk_agent_state', taskId, kind: 'updated',
  status?: 'pending'|'running'|'completed'|'failed'|'killed'|'paused', description?, error?, backgrounded?: true }
{ type: 'sdk_agent_state', taskId, kind: 'finished', toolUseId?,
  status: 'completed'|'failed'|'stopped', summary?, local?: true }
{ type: 'sdk_agent_state', kind: 'live', taskIds: string[] }   // REPLACE
```

المحرّك ينقّي كل نصّ ويقصّه إلى 300، **والواجهة لا تثق**: `taskId` يطابق
`/^[a-z0-9]{6,64}$/` و`toolUseId` يطابق `/^toolu_[A-Za-z0-9]{16,64}$/`، وكل نصّ
`String(...).slice(0, 300)`، وغير ذلك يُهمل صامتاً و`applyAgentState` تعيد `false`.

### التصميم

- **الموضع**: `#chatColumn` مباشرةً تحت `<satr-chat>` وفوق `<satr-composer>` — تحت الخيط
  حيث تقع العين بعد قراءة الردّ، وفوق المؤلّف فلا يزيح الكتابة. Shadow DOM +
  `adoptedStyleSheets` (‏`<style>` داخل Shadow محجوب بـCSP)، وTokens بالوراثة من `:root`.
- **الظهور**: `:host { display: none }` و`:host([has-rows]) { display: block }` — **بلا
  `hidden` وهميّ يُبقي ارتفاعاً**؛ الحارس يقيس `height === 0` و`display === 'none'`.
- **الطيّ** محفوظ في `localStorage` بمفتاح `satr_agents_live_collapsed` (نمط
  `satr_ledger_collapsed`)، وزرّه يحمل `aria-expanded` و`aria-label` عربياً يتبع الحالة.
- **الصف** مفتاحه `taskId`: أيقونة النوع (‏🤖 وكيل · ⌨ أمر خلفي بحسب `taskType`) ·
  الاسم (`subagentType` وإلا «وكيل فرعي») ووصفه الأصلي · الشارة · «استُؤنف ×N» ·
  الزمن · «⏹ إيقاف» للحيّ و«✕» للمنتهي · سطر التقدّم الحيّ · الملخّص الختامي.
- **الشارات الثماني** بترتيب أسبقية مقصود — الانتظار أعلى الكل (الوكيل متوقّف فعلاً
  ينتظر المالك)، ثم الخاتمة، ثم الحسم، ثم الحياة:

  | الشارة | متى |
  | --- | --- |
  | `ينتظر إذنك: <أداة>` | `permission_request.requester` يطابق الصف، ولم يُحسم بعد |
  | `انتهى مع الدور` | `finished` بـ`local: true` (حسم محليّ لا خبر من الوكيل) |
  | `فشل` / `أُوقف` / `اكتمل` | `finished.status` = `failed` / `stopped` / `completed` |
  | — | **الصفّ المحسوم لا يُعاد حسمه**: `finished{local:true}` يُبثّ لكل مهمة رآها Query عند انتهائه، فيصل لوكيلٍ أُنهي صفّه قبله بـ`updated{completed}` ويقلب «اكتمل» إلى «انتهى مع الدور» — تراجعٌ في الدقة لا تحديث. الاستثناء الوحيد: صفٌّ منتهٍ **بالحسم المحلي** يقبل خاتمةً حقيقية لاحقة (بلا `local`) لأن إشعار الوكيل أدقّ من حسمنا عنه. (مراجعة القائد على PR #161) |
  | `يُحسم…` | غائب عن `live` ولم تصل خاتمته |
  | `يعمل في الخلفية` / `يعمل` | حيّ، بحسب `backgrounded` |

- **الاتجاه** (القاعدة ٣): كل نصّ حرّ (‏`description`/`summary`/`error`) يمرّ على
  `applyDir()` من `src/ui/lib/text-dir.js` — لا `unicode-bidi: plaintext` ولا `dir="auto"`،
  لأن وصفاً عربيّ الجوهر يبدأ برمز لاتيني (`SHA-256 …`) يرسو LTR كاملاً معهما. المعرّفات
  والأرقام في `<bdi dir="ltr">`.
- **الوصولية**: الحاوية `role="region"` بـ`aria-label="الوكلاء الفرعيون"`، وكل شارة
  `role="status"`، وكل زر رمزي `aria-label` عربي — يمسح الملفَّ تلقائياً
  `npm run test:a11y-names` (يقرأ `src/ui/components/*.js` كلها).
- **الذاكرة**: 50 صفاً منتهياً حدّاً أقصى (الأقدم ختاماً يسقط)، والحيّ لا يسقط أبداً.

### التوجيه في القشرة (`src/ui/app.js`)

- `sdk_agent_state` يُعالَج **قبل** `const block = currentBlock; if (!block || block.done) return;`
  ومستقلاً عن `runningEngine`/`busy` (نمط `bg_procs`) — وهذا هو إصلاح `OBS-207` نفسه،
  ويثبّته الحارس بمقارنة موضعَي السطرين في المصدر.
- `permission_request` بـ`requester` معروف ⇒ `setWaitingPermission(requester, tool, id)`.
  والزوال **بمعرّف الطلب**: `perm-dialog.js` صار يبثّ `perm-answered {id, allow}` عند
  الرد **وعند `closeAll()`** لكل طلب مسحوب (قرار الجوال و`releaseRunControls` يمرّان بها)
  — إضافة إعلان بحتة لا تمسّ `window.satr.permission` ولا ترتيب الطابور، والحارس يثبّت
  سطر الرد حرفياً كي لا يتسلّل تغيير سلوك تحت عنوان «إعلان».
- `agent-stop-request` ⇒ `window.satr.stopSdkTask(taskId)` (القناة القائمة — لا تعديل في
  `preload.js`)، و`{ok:false}` ⇒ `failStop(taskId, message)` فيعود الزر ومعه رسالة عربية
  داخل الصف (نمط `failSdkTaskStop`).
- `reset()` من `detachConversation()` — وهي البوّابة التي تمرّ منها **كل** مسارات «جلسة
  جديدة/استئناف/تبديل مجلد» — ومن مستمع تبديل المحرّك أيضاً (فرع الاستمرارية لا يمرّ
  بها: المحادثة تستمر والوكلاء لا). ولذلك يُعلَن `agentsLiveEl` **مبكراً** في القشرة:
  منطقة الموت الزمنية (‏TDZ) لثابتٍ مُعلَن متأخراً ترمي `ReferenceError` لا يلتقطه `typeof`.
- تنبيه واحد يُضاف: `finished` بـ`status: 'failed'` ⇒ «⚠ توقف وكيل فرعي: …». الاكتمال
  **لا** يُنبَّه له (ضجيج)، وتنبيه طلب الإذن القائم يبقى كما هو.

### الحارس — `npm run test:agents-live-ui`

`scripts/agents-live-ui-test.js` + `scripts/fixtures/agents-live.html` (يستورد `base.css`
والمكوّن الإنتاجيَّين، بلا script/style مضمّن) + السائق الخارجي `agents-live-page.js`.
اثنا عشر فحصاً: صفٌّ واحد عبر الاستئناف مع عدّاده · الشارات الثماني بنصّها · REPLACE
(«يُحسم…» ثم الخاتمة) · **لا إعادة حسم لصفٍّ محسوم** · «ينتظر إذنك» وزوالها بالمعرّف
الصحيح دون الخاطئ · زر الإيقاف يبثّ ويعود عند `failStop` · الاختفاء التام بارتفاع مقيس ·
**رسوّ الاتجاه بالبكسل** عبر `Range` لا `getComputedStyle` · رفض المعرّفات المشوّهة
وقصّ 300 · حدّ الخمسين · صفر CSP.

**وفحص طفرة داخل الحارس**: نسخة من سطر التقدّم بـ`dir="auto"` **يجب** أن ترسو LTR
(مقيس: `fromLeft=0`) — وإلا فقياس الاتجاه بلا أسنان لأنه لا يميّز الحسم الإحصائي من
الحسم بأول حرف قوي. وطفرةٌ في المصدر (‏استبدال `applyDir` بـ`dir="auto"` في سطر التقدّم)
أُجريت وأسقطت الحارس فعلاً ثم رُجعت.

### حدود مُصرَّح بها

- **لا شجرة عمق > 1**: `spawnDepth` يُقرأ ويُخزَّن ولا يُرسم تعشيشاً — الوكيل الحفيد يظهر
  صفّاً مستوياً كغيره. `parent_agent_id` لا يصل في البث الحيّ أصلاً (‏`agent.js:394`).
- **الاستئناف لا يُنشئ بطاقة داخل الكتلة** ولا يغيّرها: بطاقة `chat.js` تبقى كما هي
  (قرار الحزمة)، فالسطحان يتعايشان — الكتلة للسرد، والشريط للحالة.
- **الزمن منذ أول إطلاق** لا منذ المقطع الحالي، فيشمل فجوة ما بين الانتهاء والاستئناف.
  الصف واحد للوكيل، فعمره عمر الوكيل.
- **`role="status"` لكل صف** يعني مناطق حيّة متعددة؛ لم يُختبر نطقها بقارئ شاشة حقيقي.
- **زر الإيقاف يعتمد سياسة `main`**: حتى يوسّع فرع المحرّك `ownsSdkTask` (‏`OBS-151`)
  ستردّ القناة `not_found` لمهمة لم ينقلها المستخدم — والصف **يقول ذلك برسالة عربية**
  ولا يبتلعه، فلا يكذب الزر.
- **هذا حارس واجهة**: لا يشغّل SDK ولا يثبت أن `electron/` يبثّ الحدث فعلاً — ذاك على
  فرع المحرّك.
