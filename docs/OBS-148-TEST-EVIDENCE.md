# أدلة OBS-148 — ملكية مهام SDK في حالة الجوال

التاريخ: 2026-09-09. الفرع عند الفحص: `feat/project-connections`، الإصدار `2.16.21`.
نطاق الدفعة: OBS-148 فقط. لم تُستأنف تجارب التوصيلات أو OBS-144/147، ولم يحدث التزام أو نشر أو تغيير إصدار.

## النتيجة وإعادة الإنتاج

الحارس `node scripts/mobile-task-owner-test.js` يستخرج `handleSendRequest` كاملة
ومعالج `satr:send` و`stopAll` ودوال بناء/نشر الحالة من `electron/main.js` بلا تعديل شروطها.
يشغّل `emitClaudeTasks` من `electron/agent.js` و`tasks.apply` وتخزينه الفعلي
في مجلد مؤقت منفصل، و`mobilestate.buildState` الإنتاجية.
بدائل المحرك والنقل تسلّم الأحداث وتلتقط اللقطات؛ لا نسخة مقلدة من منطق استقبال الحدث أو الملكية.

قبل تعديل الإنتاج سقطت الحالات الأربع الأصلية برمز `1`:
مشروعان مختلفان، المشروع نفسه، الجلسة نفسها، وغياب معرّف الجلسة.
من الخرج الحرفي:

```text
AssertionError [ERR_ASSERTION]: OBS-148 different-projects: late A changed the published B state
+   task: 'تحديث متأخر من التشغيل الأول',
-   task: 'مهمة التشغيل الحالي',
+     completed: 0,
-     completed: 1,
+     total: 1
-     total: 2
AssertionError [ERR_ASSERTION]: OBS-148: 4 ownership scenarios failed
```

إضافة `owner !== runSeq` وحدها أغلقت التلوث المباشر، لكنها أسقطت حالة الجلسة نفسها:

```text
mobile-task-owner: ok different-projects
mobile-task-owner: ok same-project
AssertionError [ERR_ASSERTION]: OBS-148 same-session: B update reimported the stale shared ledger
+ actual - expected

+ ''
- 'تحديث صحيح من التشغيل الحالي'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:162:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:192:9)
mobile-task-owner: ok no-session
AssertionError [ERR_ASSERTION]: OBS-148: 1 ownership scenarios failed

1 !== 0

    at testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:199:12)
```

هذا إثبات مستقل لحاجة عزل التجميع: `tasks.apply` يحفظ A في دفتر الجلسة المشترك،
ثم يحمل تحديث B الجزئي ذلك الدفتر مجدداً إن نُشر كما هو.

## الإصلاح وحدوده السلوكية

- يُمرر `token` الملتقط في باعث التشغيل إلى ناشر مهام الهاتف؛ لا مصدر للملكية من حقول الحدث أو مسار المشروع.
- يُصفّر `mobileTaskSnapshot` عند بدء الدور؛ أحداث SDK الحالية وحدها تختزل فيه من `obj` الأصلي.
- استُخرج `reduceSnapshot` النقي من `tasks.apply` لتشارك التنقية والدمج والاستبدال والسقوف وقاعدة خطة Kimi.
- حفظ دفتر الجلسة وبثه المكتبي وأحداث SDK الخلفية المنقاة وملكية إيقاف المهمة باقية.
- بقية المحركات تنشر الدفتر المقبول كما كانت، بصيغة `replace`؛ لا تعيد خطة Kimi المحجوبة.
- عدادات هاتف SDK تخص مهام الدور الحالي حتى في جلسة مستأنفة؛ دفتر الجلسة المكتبي تراكمي وقد يختلف عداده عمداً.
- لم يتغير عقد IPC أو شكل إطار الهاتف أو كود PWA أو CSS.

## الاختبارات

| الأمر | النتيجة |
|---|---|
| `node scripts/mobile-task-owner-test.js` | 7 سيناريوهات ناجحة |
| `npm run test:sdk-background` | ناجح، ويستدعي الحارس الجديد؛ مسجل أصلاً في `test:full` |
| `npm run test:tasks` | ناجح: التخزين والدمج والإيقاف والاستئناف والسقوف وقاعدة `kimi_plan` |
| `npm run test:mobile-relay` | ناجح: 203 فحوص |
| `npm run test:mobile-integration` | ناجح: 291 فحصاً عبر HTTPS/WebCrypto الحقيقيين محلياً |
| `npm run test:sdk-polish` | ناجح: 5/5 |
| `npm run test:observations` | ناجح: 1445 فحصاً |
| `node --check` للإنتاج والحارس الجديد | ناجح |
| `git diff --check` | ناجح؛ تنبيها CRLF يخصان ملفين سابقين غير معدّلين في هذه الدفعة |

السيناريوهات السبعة: مشروعان؛ مشروع واحد بجلسات مختلفة؛ الجلسة نفسها؛ الجلسة نفسها
مع بداية B بـ`merge` بلا مسح؛ هاتف معطّل ثم إعادة طلب الحالة؛ غياب الجلسة؛
ودفتر Kimi المقبول. يُفحص في سيناريوهات SDK استمرار B بعد A، واستبدال خطة B،
وحفظ A وبثها المكتبي، وملكية إشعاراتها، وحجب `proc_done` القديم.

الحارس البنيوي القديم في `scripts/mobilerelay-test.js` كان يثبت
`publishMobileTaskState(ledger)` حرفياً؛ حُدّث للنداء بمالك، ويغطي الحارس السلوكي
الجديد فرعي النشر الحقيقيين.

لم يُشغّل `test:full` لهذه الدفعة؛ نتيجة طقم التوصيلات السابق `102/103` برمز `1`
تبقى غير محسومة، ولا تُنسب إلى هذا الإصلاح.

## فحص الإقلاع

شُغّل عبر `run_in_background` في المهمة `term_26`:

```powershell
npm start -- --user-data-dir=D:\sater\satr-2\dist\obs148-smoke-profile --enable-logging=stderr
```

أعلن `prestart` أن CSP محدّث بالفعل، ثم ظهرت عملية Electron الخاصة بهذا الملف
بعنوان نافذة `سطر — Satr` ومعرّف نافذة غير صفري `15076354` (PID `56188`).
هذا دليل إقلاع فقط؛ لا شهادة بصرية للسلوك محل الإصلاح.
أُوقفت المهمة صراحةً عبر `stop_background_task`، ثم أعاد
`wait_for_background_task` رمز `2` مع `^C`؛ هذا خرج الإيقاف المقصود، وليس نتيجة اختبار خضراء.
حُذف ملف المستخدم المؤقت بعد التحقق من مساره وغياب عملياته. لم تُوقف `term_25`
الخاصة بقبول التوصيلات ولم يُمس ملفها.

## حدود الإثبات والقبول

اختبار السباق لا يشغّل عملية Claude SDK حقيقية ولا PWA أو هاتفاً فعلياً. اختبار HTTPS
المستقل يثبت عقد القناة، ولا يثبت السباق فوق الشبكة. لم تُفحص بكسلات ولم يُدّعَ ذلك.
قُرئت مهارة `satr-accept` من ملفها: نطاق الادعاء هنا ملكية البيانات قابل للإثبات آلياً،
ولا تغيير رسم أو نص أو تخطيط يحتاج نقرة بشرية؛ لم تُطلب تجربة بشرية.

## العضّات الفعلية

كل زرع أدناه غيّر ملف الإنتاج على القرص. العدّ من الطرفين بـ`regex.Escape`،
والاستعادة استبدال الموضع نفسه فقط. تطابقت SHA-256 بعد كل استعادة مع ما قبل العضّات:

```text
electron/main.js  8B95AC0A07609E6A0E9BBB35911F55CA8B6331AC01C0D2B338BAE901638E7D34
electron/tasks.js F6F1AC72C3D590F057D46E13FC44A7CFC89947FAB0FFDD3A1F97D697AB68D5F3
```

### owner-off

أمر الزرع كما نُفّذ، من جذر المشروع:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/main.js'
$obsOriginal = 'if (owner !== runSeq) return;'
$obsMutant = 'if (false) return;'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('if (owner !== runSeq) return;')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('if (owner !== runSeq) return;', 'if (false) return;'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الزرع الحرفي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=266DA22446F8B927255C8295B011DB41D90AF3AD5592EB294801D8F99D15E8AD
```

أمر الحارس: `node scripts/mobile-task-owner-test.js`، رمز الخروج: `1`.

خرج فشل الحارس الحرفي:

```text
AssertionError [ERR_ASSERTION]: OBS-148 different-projects: late A changed the published B state
+ actual - expected
... Skipped lines

  {
    boot: 'aa194eca',
    cost_usd: null,
    edits: {
      added: 0,
...
    run: 'a18ddea5aa372037',
+   seq: 10,
+   task: '',
-   seq: 9,
-   task: 'مهمة التشغيل الحالي',
    tasks: {
      blocked: 0,
      completed: 1,
+     in_progress: 2,
-     in_progress: 1,
      pending: 0,
+     total: 3
-     total: 2
    },
    ttl_ms: 60000,
    verify: ''
  }

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:145:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: OBS-148 same-project: late A changed the published B state
+ actual - expected
... Skipped lines

  {
    boot: '17a72fd4',
    cost_usd: null,
    edits: {
      added: 0,
...
    run: '627f64ecd68fabca',
+   seq: 10,
+   task: '',
-   seq: 9,
-   task: 'مهمة التشغيل الحالي',
    tasks: {
      blocked: 0,
      completed: 1,
+     in_progress: 2,
-     in_progress: 1,
      pending: 0,
+     total: 3
-     total: 2
    },
    ttl_ms: 60000,
    verify: ''
  }

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:145:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: OBS-148 same-session: late A changed the published B state
+ actual - expected
... Skipped lines

  {
    boot: 'f49461cf',
    cost_usd: null,
    edits: {
      added: 0,
...
    run: '389d7d47281cafdf',
+   seq: 10,
+   task: '',
-   seq: 9,
-   task: 'مهمة التشغيل الحالي',
    tasks: {
      blocked: 0,
      completed: 1,
+     in_progress: 2,
-     in_progress: 1,
      pending: 0,
+     total: 3
-     total: 2
    },
    ttl_ms: 60000,
    verify: ''
  }

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:145:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: OBS-148 same-session-merge-first: late A changed the published B state
+ actual - expected
... Skipped lines

  {
    boot: '576ae8c0',
    cost_usd: null,
    edits: {
      added: 0,
...
    run: 'dd3e91d1557bb7a5',
+   seq: 9,
+   task: '',
-   seq: 8,
-   task: 'مهمة التشغيل الحالي',
    tasks: {
      blocked: 0,
      completed: 1,
+     in_progress: 2,
-     in_progress: 1,
      pending: 0,
+     total: 3
-     total: 2
    },
    ttl_ms: 60000,
    verify: ''
  }

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:145:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: تغير الأصل الداخلي وإن لم تُرسل لقطة فوراً
+ actual - expected
... Skipped lines

  {
    boot: '1b751930',
    cost_usd: null,
    edits: {
      added: 0,
...
    seq: 9,
+   task: '',
-   task: 'مهمة التشغيل الحالي',
    tasks: {
      blocked: 0,
      completed: 1,
+     in_progress: 2,
-     in_progress: 1,
      pending: 0,
+     total: 3
-     total: 2
    },
    ttl_ms: 60000,
    verify: ''
  }

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:150:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: OBS-148 no-session: late A changed the published B state
+ actual - expected
... Skipped lines

  {
    boot: '3e73bf43',
    cost_usd: null,
    edits: {
      added: 0,
...
    run: 'c32acabe80a75724',
+   seq: 8,
+   task: '',
-   seq: 7,
-   task: 'مهمة التشغيل الحالي',
    tasks: {
      blocked: 0,
      completed: 0,
+     in_progress: 2,
-     in_progress: 1,
      pending: 0,
+     total: 2
-     total: 1
    },
    ttl_ms: 60000,
    verify: ''
  }

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:145:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
mobile-task-owner: ok other-engine-accepted-ledger
AssertionError [ERR_ASSERTION]: OBS-148: 6 ownership scenarios failed

6 !== 0

    at testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:226:12)
```

أمر الاستعادة كما نُفّذ:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/main.js'
$obsOriginal = 'if (owner !== runSeq) return;'
$obsMutant = 'if (false) return;'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('if (false) return;')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('if (false) return;', 'if (owner !== runSeq) return;'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الاستعادة الحرفي:

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=8B95AC0A07609E6A0E9BBB35911F55CA8B6331AC01C0D2B338BAE901638E7D34
```

### shared-ledger

أمر الزرع كما نُفّذ، من جذر المشروع:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/main.js'
$obsOriginal = 'const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };'
$obsMutant = 'const mobileUpdate = { ...ledger, mode: ''replace'' };'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };', 'const mobileUpdate = { ...ledger, mode: ''replace'' };'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الزرع الحرفي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=82A5E72B3BF3402D336A4A4AE290D4C3077E5D710942A6D9BAF2CED62216750A
```

أمر الحارس: `node scripts/mobile-task-owner-test.js`، رمز الخروج: `1`.

خرج فشل الحارس الحرفي:

```text
mobile-task-owner: ok different-projects
mobile-task-owner: ok same-project
AssertionError [ERR_ASSERTION]: OBS-148 same-session: B update reimported the stale shared ledger
+ actual - expected

+ ''
- 'تحديث صحيح من التشغيل الحالي'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:166:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'مهمة التشغيل الحالي'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:140:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: OBS-148 phone-offline: B update reimported the stale shared ledger
+ actual - expected

+ ''
- 'تحديث صحيح من التشغيل الحالي'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:166:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
mobile-task-owner: ok no-session
mobile-task-owner: ok other-engine-accepted-ledger
AssertionError [ERR_ASSERTION]: OBS-148: 3 ownership scenarios failed

3 !== 0

    at testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:226:12)
```

أمر الاستعادة كما نُفّذ:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/main.js'
$obsOriginal = 'const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };'
$obsMutant = 'const mobileUpdate = { ...ledger, mode: ''replace'' };'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('const mobileUpdate = { ...ledger, mode: ''replace'' };')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('const mobileUpdate = { ...ledger, mode: ''replace'' };', 'const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الاستعادة الحرفي:

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=8B95AC0A07609E6A0E9BBB35911F55CA8B6331AC01C0D2B338BAE901638E7D34
```

### replace-as-merge

أمر الزرع كما نُفّذ، من جذر المشروع:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/tasks.js'
$obsOriginal = 'const nextTasks = mode === ''replace'' ? incoming : mergeTasks(previous ? previous.tasks : [], incoming);'
$obsMutant = 'const nextTasks = mergeTasks(previous ? previous.tasks : [], incoming);'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('const nextTasks = mode === ''replace'' ? incoming : mergeTasks(previous ? previous.tasks : [], incoming);')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('const nextTasks = mode === ''replace'' ? incoming : mergeTasks(previous ? previous.tasks : [], incoming);', 'const nextTasks = mergeTasks(previous ? previous.tasks : [], incoming);'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الزرع الحرفي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=8B8B4888ACCB527E409623C3FB4D408378CBB016A1570383877FFD97A68E770E
```

أمر الحارس: `node scripts/mobile-task-owner-test.js`، رمز الخروج: `1`.

خرج فشل الحارس الحرفي:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'الخطة البديلة الحالية'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:173:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'الخطة البديلة الحالية'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:173:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'الخطة البديلة الحالية'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:173:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'الخطة البديلة الحالية'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:173:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'الخطة البديلة الحالية'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:173:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- 'الخطة البديلة الحالية'

    at scenario (D:\sater\satr-2\scripts\mobile-task-owner-test.js:173:10)
    at async testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:206:9)
mobile-task-owner: ok other-engine-accepted-ledger
AssertionError [ERR_ASSERTION]: OBS-148: 6 ownership scenarios failed

6 !== 0

    at testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:226:12)
```

أمر الاستعادة كما نُفّذ:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/tasks.js'
$obsOriginal = 'const nextTasks = mode === ''replace'' ? incoming : mergeTasks(previous ? previous.tasks : [], incoming);'
$obsMutant = 'const nextTasks = mergeTasks(previous ? previous.tasks : [], incoming);'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('const nextTasks = mergeTasks(previous ? previous.tasks : [], incoming);')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('const nextTasks = mergeTasks(previous ? previous.tasks : [], incoming);', 'const nextTasks = mode === ''replace'' ? incoming : mergeTasks(previous ? previous.tasks : [], incoming);'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الاستعادة الحرفي:

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=F6F1AC72C3D590F057D46E13FC44A7CFC89947FAB0FFDD3A1F97D697AB68D5F3
```

### bypass-accepted-ledger

أمر الزرع كما نُفّذ، من جذر المشروع:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/main.js'
$obsOriginal = 'const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };'
$obsMutant = 'const mobileUpdate = obj;'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };', 'const mobileUpdate = obj;'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الزرع الحرفي:

```text
before original=1 mutant=0
after original=0 mutant=1
sha256=04FD2EDBA71CC9C965796D7119A9268B19D875FD881434B1DAA24FF90FE76EFF
```

أمر الحارس: `node scripts/mobile-task-owner-test.js`، رمز الخروج: `1`.

خرج فشل الحارس الحرفي:

```text
mobile-task-owner: ok different-projects
mobile-task-owner: ok same-project
mobile-task-owner: ok same-session
mobile-task-owner: ok same-session-merge-first
mobile-task-owner: ok phone-offline
mobile-task-owner: ok no-session
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'الخطة التلقائية المحجوبة'
- 'الخطة الصريحة المحفوظة'
           ^

    at testMobileTaskOwnership (D:\sater\satr-2\scripts\mobile-task-owner-test.js:223:12)
```

أمر الاستعادة كما نُفّذ:

```powershell
$obsPath = Join-Path (Get-Location) 'electron/main.js'
$obsOriginal = 'const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };'
$obsMutant = 'const mobileUpdate = obj;'
$obsSource = [IO.File]::ReadAllText($obsPath)
'before original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
if ([regex]::Matches($obsSource, [regex]::Escape('const mobileUpdate = obj;')).Count -ne 1) { throw 'expected_one_match' }
[IO.File]::WriteAllText($obsPath, $obsSource.Replace('const mobileUpdate = obj;', 'const mobileUpdate = runEngine === ''sdk'' ? obj : { ...ledger, mode: ''replace'' };'), [Text.UTF8Encoding]::new($false))
$obsSource = [IO.File]::ReadAllText($obsPath)
'after original={0} mutant={1}' -f ([regex]::Matches($obsSource, [regex]::Escape($obsOriginal)).Count), ([regex]::Matches($obsSource, [regex]::Escape($obsMutant)).Count)
'sha256=' + (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash
```

خرج الاستعادة الحرفي:

```text
before original=0 mutant=1
after original=1 mutant=0
sha256=8B95AC0A07609E6A0E9BBB35911F55CA8B6331AC01C0D2B338BAE901638E7D34
```

بعد استعادة العضّات الأربع أُعيد `npm run test:sdk-background` و`npm run test:tasks`؛ كلاهما نجح برمز `0`.
