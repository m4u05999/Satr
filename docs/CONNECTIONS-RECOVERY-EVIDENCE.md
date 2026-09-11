# أدلة التعافي من قفل التوصيلات وصدق نتيجة الكتابة

التاريخ: `2026-09-09` محلياً (`Asia/Riyadh`). القياس على `Windows x64` و`Node v26.5.0`.

## النتيجة ونطاق الحارس

نجح `node scripts/connections-recovery-test.js` في الحالات الست بعد الإصلاح برمز `0`. بعد العضّات الست والاستعادة، نجح `npm run test:connections` برمز `0` وأعلن الحارس `passed=6 failed=0 skipped=0 total=6`. الأدلة النهائية: `dist/connections-recovery/six-cases-green.json` و`six-cases-green.log` و`connections-final.json` و`connections-final.log`. قياس الحالات الأربع في مرحلة سابقة محفوظ في `four-cases-green.json` و`connections-four-final.json`.

الحارس في `scripts/connections-recovery-test.js` يستدعي `createManager` من `electron/connections.js` مباشرة؛ القفل و`commit` و`execute` من الإنتاج، وليست نسخة لمنطقها. `safeStorage` ومزوّد الخدمة مصطنعان، مع تشفير AES-GCM لمتجر الاختبار. كل مشروع ومتجر وأثر كتابة داخل مجلد مؤقت متحقق الحدود؛ لا حساب مستخدم أو رمز حقيقي أو شبكة خدمة خارجية.

| الحالة | ما قيس |
| --- | --- |
| `dead_lock_recovery` | طفل يعلن `READY` من `encryptString` بعد حيازة قفل `commit` الفعلي؛ مدير ثانٍ يُرفض وهو حي. بعد قتله وانتظار إغلاقه تنجح مصادقة مدير جديد ثم اختيار المورد ثم الفصل. |
| `recovery_contenders` | بعد موت مالك قديم يبدأ طفلان قبل انتظار أي نتيجة؛ فائز واحد يصل `READY`، والخاسر يعلن `BLOCKED` من `storage_busy` ويخرج `0`. محاولة مستقلة تُرفض أثناء بقاء الفائز حياً؛ وبعد قتله يتعافى مدير جديد. |
| `usage_save_failure` | المزوّد يكتب أثراً ناجحاً مرة واحدة ثم يفشل تشفير `lastEngineUse`. تبقى نتيجة الفعل ناجحة مع `warning:'usage_not_saved'` و`usageSaved:false`، ولا يُعاد الفعل أو يُدّعى حفظ الاستعمال. |
| `post_write_connection_changed` | المزوّد يكتب أثراً مرة واحدة ثم يبدّل مدير مستقل المورد قبل عودة النتيجة. يرجع `ok:false` و`connection_changed` دون `data`، مع `externalOutcome:'succeeded'` و`retryable:false`؛ يبقى المورد الجديد بصلاحياته ولا تُنسب إليه بيانات استعمال الفعل القديم. |
| `test_release_connection_changed` | إغلاق مقبس قفل الإنتاج فعلاً، ثم تبديل المورد بمدير ثانٍ قبل إعادة callback الإغلاق إلى `commit`؛ يجب أن ترفض `test()` بيانات الاتصال القديم بـ `connection_changed`، ويبقى المورد الجديد بلا `lastTest` قديم. |
| `tool_post_write_inactive` | غلاف `connection-tools.run` الفعلي فوق مدير فعلي؛ المزوّد يكتب مرة ثم يوقف صلاحية الدور قبل return. يبقى الرد JSON بـ `inactive` وإقرار نجاح الأثر ومنع إعادة المحاولة، بلا بيانات قديمة أو رمز. |

الانتظار مبني على أحداث stdout وإغلاق الأطفال، بسقف `10000ms` لكل انتظار. لا تأخير عشوائي طويل في الحارس، ولا قتل لعملية غير أطفاله. الشرط الأخير لا يجعل الحارس ضامناً لتصرف وكيل خارجي؛ يثبت حقول الرد وعدم تكرار `provider.run` داخلياً فقط.

## إعادة الإنتاج قبل الإصلاح

الأمر الحرفي: `node scripts/connections-recovery-test.js`؛ رمز الخروج `1`. نجحت شروط وصول الطفل إلى القفل ورفض المالك الحي، ثم فشلت مصادقة المدير الجديد بعد موت الطفل بـ `storage_busy`. وفي الحالة الثانية قيس أثر ناجح واحد في الذاكرة والقرص، بينما رجع تنفيذ العملية فاشلاً بـ `encryption_unavailable`.

```text
connections-recovery: FAIL dead_lock_recovery: dead_lock_recovery: authenticate after child exit expected ok=true; actual={"ok":false,"error":"storage_busy"}
connections-recovery: FAIL usage_save_failure: usage_save_failure: provider succeeded once; expected ok=true, warning=usage_not_saved, usageSaved=false; actual={"ok":false,"error":"encryption_unavailable"}
```

هذه إعادة إنتاج فعلية على الإنتاج القديم وليست عضّة زرع. التفاصيل والخرج الكامل في `dist/connections-recovery/original.json` و`reproduction.log` و`reproduction.md`. بصمة الإنتاج القديم: `32f938b8f058d6399fd80a682ba0b662b537ba257b8966a5ccfbc30fb824dffd`.

بعد إصلاح القفل ونتيجة حفظ الاستعمال نجحت الحالات الثلاث الأولى (`three-cases-green.json`). ثم أُضيفت حالة تغيّر الاتصال بعد الكتابة وقيس سقوطها قبل إضافة حقول النتيجة، بالأمر نفسه وبرمز `1`:

```text
connections-recovery: FAIL post_write_connection_changed: post_write_connection_changed: successful external write must be declared; actual={"ok":false,"error":"connection_changed"}
+ actual - expected

+ undefined
- 'succeeded'
```

الأدلة: `post-write-red.json` و`post-write-red.log` و`post-write-red.md`. شرط `retryable:false` تالٍ ولم يصل إليه القياس الأحمر حينها؛ وصل إليه الأخضر بعد الإصلاح.

## إعادة إنتاج حدّي العودة غير المتزامنة

بعد نجاح الحالات الأربع الأولى كشفت المراجعة حدّين آخرين. أُضيف الحارسان قبل تعديل الإنتاج، وشُغّل الأمر الحرفي `node scripts/connections-recovery-test.js`؛ النتيجة `passed=4 failed=2 skipped=0 total=6` وبرمز خروج `1`. الأدلة: `six-cases-red.json` و`six-cases-red.log`.

الحالة الأولى تستبدل `net.Server.prototype.close` مؤقتاً بغلاف يستدعي الإغلاق الحقيقي أولاً ثم يُكمل `select` بمدير ثانٍ قبل callback الأول، مرة واحدة فقط؛ تعيد الدالة الأصلية في `finally`. الحالة الثانية تستدعي `connectionTools.run` فعلياً؛ لا تقليد لغلاف الرد. الخرج الحرفي:

```text
connections-recovery: PASS dead_lock_recovery
connections-recovery: PASS recovery_contenders
connections-recovery: PASS usage_save_failure
connections-recovery: PASS post_write_connection_changed
connections-recovery: FAIL test_release_connection_changed: test_release_connection_changed: test must reject a connection changed during lock release; actual={"ok":true,"data":{"id":"owner/recovery","label":"مورد الاختبار"}}

true !== false

connections-recovery: FAIL tool_post_write_inactive: tool_post_write_inactive: expected JSON preserving successful write outcome; actual={"ok":false,"content":"أُلغي استخدام التوصيلة لانتهاء الدور."}
connections-recovery: summary passed=4 failed=2 skipped=0 total=6
AssertionError [ERR_ASSERTION]: connections-recovery: failed test_release_connection_changed, tool_post_write_inactive

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:413:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

## العضّات الست

المشغّل المحفوظ: `dist/connections-recovery/mutation-runner.js`. كل زرع يستهدف تطابقاً واحداً حرفياً في `electron/connections.js`، ما عدا `tool_outcome` الذي يستهدف `electron/connection-tools.js`؛ يحفظ Buffer قبل الزرع في `<name>.baseline.bin`، ويعدّ الأصل والمتحوّر قبل الكتابة وبعدها. الاستعادة تتحقق أولاً أن الملف ما زال يطابق بصمة النسخة المزروعة، ثم تكتب Buffer السابقة وتطابقها بايتياً وبـ SHA-256. لا `reset` أو `stash` أو استعادة من Git.

بصمة الأصل والاستعادة المشتركة للعضّات الأربع الأولى: `2d3c5f0d857a5d13858f3f953435992e8953097d327ae0ec472ae3a48aa23688`. كل زرع سقط برمز `1`؛ كل استعادة رجعت برمز `0` وبالعد `original=1 mutant=0`. `*.receipt.json` تحمل الأوامر والعد والبصمات والخرج الحرفي، و`*.mutant.json` نتائج الحالات على المتحوّر. أُضيف إعلان التخطي للمنصات الأخرى بعد العضّات الأربع الأولى؛ لم تتغير شروطها على Windows. العضّتان اللاحقتان تعملان على النسخة التي أغلقت حدّي العودة الإضافيين، لذا لهما بصمتا استعادة مستقلتان أدناه.

### تعطيل إزالة العلامة القديمة عند الاسترداد

زرع كما نُفّذ:

```powershell
node dist/connections-recovery/mutation-runner.js plant reclaim
```

العد المقيس: الأصل `1 → 0`؛ المتحوّر `0 → 1`.

الاختبار كما نُفّذ:

```powershell
node scripts/connections-recovery-test.js
```

رمز الخروج `1`، والخرج الحرفي:

```text
connections-recovery: FAIL dead_lock_recovery: dead_lock_recovery: authenticate after child exit expected ok=true; actual={"ok":false,"error":"storage_busy"}

false !== true

connections-recovery: FAIL recovery_contenders: recovery_contenders: exactly one commit owner required; notices=["BLOCKED","BLOCKED"]

0 !== 1

connections-recovery: PASS usage_save_failure
connections-recovery: PASS post_write_connection_changed
AssertionError [ERR_ASSERTION]: connections-recovery: failed dead_lock_recovery, recovery_contenders

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:315:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

الاستعادة كما نُفّذت:

```powershell
node dist/connections-recovery/mutation-runner.js restore reclaim
```

استعادة دقيقة: `restored=true`؛ الأصل `1` والمتحوّر `0`. التفاصيل في `dist/connections-recovery/reclaim.receipt.json`.

### تجاوز قفل النواة مع إبقاء قفل الملف

زرع كما نُفّذ:

```powershell
node dist/connections-recovery/mutation-runner.js plant kernel
```

العد المقيس: الأصل `1 → 0`؛ المتحوّر `0 → 1`.

الاختبار كما نُفّذ:

```powershell
node scripts/connections-recovery-test.js
```

رمز الخروج `1`، والخرج الحرفي:

```text
connections-recovery: FAIL dead_lock_recovery: live lock owner must remain exclusive
+ actual - expected

  {
+   account: {
+     id: 'fixture-account',
+     label: 'حساب الاختبار'
+   },
+   ok: true
-   error: 'storage_busy',
-   ok: false
  }

connections-recovery: FAIL recovery_contenders: recovery_contenders: exactly one commit owner required; notices=["READY","READY"]

2 !== 1

connections-recovery: PASS usage_save_failure
connections-recovery: PASS post_write_connection_changed
AssertionError [ERR_ASSERTION]: connections-recovery: failed dead_lock_recovery, recovery_contenders

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:315:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

الاستعادة كما نُفّذت:

```powershell
node dist/connections-recovery/mutation-runner.js restore kernel
```

استعادة دقيقة: `restored=true`؛ الأصل `1` والمتحوّر `0`. التفاصيل في `dist/connections-recovery/kernel.receipt.json`.

### إعادة رمي خطأ حفظ بيانات الاستعمال

زرع كما نُفّذ:

```powershell
node dist/connections-recovery/mutation-runner.js plant usage
```

العد المقيس: الأصل `1 → 0`؛ المتحوّر `0 → 1`.

الاختبار كما نُفّذ:

```powershell
node scripts/connections-recovery-test.js
```

رمز الخروج `1`، والخرج الحرفي:

```text
connections-recovery: PASS dead_lock_recovery
connections-recovery: PASS recovery_contenders
connections-recovery: FAIL usage_save_failure: usage_save_failure: provider succeeded once; expected ok=true, warning=usage_not_saved, usageSaved=false; actual={"ok":false,"error":"encryption_unavailable","externalOutcome":"succeeded","retryable":false}

false !== true

connections-recovery: PASS post_write_connection_changed
AssertionError [ERR_ASSERTION]: connections-recovery: failed usage_save_failure

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:315:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

الاستعادة كما نُفّذت:

```powershell
node dist/connections-recovery/mutation-runner.js restore usage
```

استعادة دقيقة: `restored=true`؛ الأصل `1` والمتحوّر `0`. التفاصيل في `dist/connections-recovery/usage.receipt.json`.

### حذف إقرار نجاح الكتابة من رد الاتصال المتغيّر

زرع كما نُفّذ:

```powershell
node dist/connections-recovery/mutation-runner.js plant outcome
```

العد المقيس: الأصل `1 → 0`؛ المتحوّر `0 → 1`.

الاختبار كما نُفّذ:

```powershell
node scripts/connections-recovery-test.js
```

رمز الخروج `1`، والخرج الحرفي:

```text
connections-recovery: PASS dead_lock_recovery
connections-recovery: PASS recovery_contenders
connections-recovery: PASS usage_save_failure
connections-recovery: FAIL post_write_connection_changed: post_write_connection_changed: successful external write must be declared; actual={"ok":false,"error":"connection_changed"}
+ actual - expected

+ undefined
- 'succeeded'

AssertionError [ERR_ASSERTION]: connections-recovery: failed post_write_connection_changed

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:315:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

الاستعادة كما نُفّذت:

```powershell
node dist/connections-recovery/mutation-runner.js restore outcome
```

استعادة دقيقة: `restored=true`؛ الأصل `1` والمتحوّر `0`. التفاصيل في `dist/connections-recovery/outcome.receipt.json`.


### حذف فحص الملكية بعد تحرير قفل test

زرع كما نُفّذ:

```powershell
node dist/connections-recovery/mutation-runner.js plant test_release
```

العد المقيس: الأصل `1 → 0`؛ المتحوّر `0 → 1`.

الاختبار كما نُفّذ:

```powershell
node scripts/connections-recovery-test.js
```

رمز الخروج `1`، والخرج الحرفي:

```text
connections-recovery: PASS dead_lock_recovery
connections-recovery: PASS recovery_contenders
connections-recovery: PASS usage_save_failure
connections-recovery: PASS post_write_connection_changed
connections-recovery: FAIL test_release_connection_changed: test_release_connection_changed: test must reject a connection changed during lock release; actual={"ok":true,"data":{"id":"owner/recovery","label":"مورد الاختبار"}}

true !== false

connections-recovery: PASS tool_post_write_inactive
connections-recovery: summary passed=5 failed=1 skipped=0 total=6
AssertionError [ERR_ASSERTION]: connections-recovery: failed test_release_connection_changed

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:413:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

الاستعادة كما نُفّذت:

```powershell
node dist/connections-recovery/mutation-runner.js restore test_release
```

استعادة دقيقة: `restored=true`؛ الأصل `1` والمتحوّر `0`؛ SHA-256 قبل الزرع وبعد الاستعادة: `2e151db8f05e7a3741ba6afb6c2e988ea453f127f7adb58208a6afa60cd17d8e`. التفاصيل في `dist/connections-recovery/test_release.receipt.json`.

### تعطيل حفظ إقرار الكتابة في غلاف الأداة

زرع كما نُفّذ:

```powershell
node dist/connections-recovery/mutation-runner.js plant tool_outcome
```

العد المقيس: الأصل `1 → 0`؛ المتحوّر `0 → 1`.

الاختبار كما نُفّذ:

```powershell
node scripts/connections-recovery-test.js
```

رمز الخروج `1`، والخرج الحرفي:

```text
connections-recovery: PASS dead_lock_recovery
connections-recovery: PASS recovery_contenders
connections-recovery: PASS usage_save_failure
connections-recovery: PASS post_write_connection_changed
connections-recovery: PASS test_release_connection_changed
connections-recovery: FAIL tool_post_write_inactive: tool_post_write_inactive: expected JSON preserving successful write outcome; actual={"ok":false,"content":"أُلغي استخدام التوصيلة لانتهاء الدور."}
connections-recovery: summary passed=5 failed=1 skipped=0 total=6
AssertionError [ERR_ASSERTION]: connections-recovery: failed tool_post_write_inactive

false !== true

    at testConnectionRecovery (D:\sater\satr-2\scripts\connections-recovery-test.js:413:10)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

الاستعادة كما نُفّذت:

```powershell
node dist/connections-recovery/mutation-runner.js restore tool_outcome
```

استعادة دقيقة: `restored=true`؛ الأصل `1` والمتحوّر `0`؛ SHA-256 قبل الزرع وبعد الاستعادة: `2dae585bce82f666089122af28296cb18beedf4f09bd9ee11f4a3bd14bb7bfdb`. التفاصيل في `dist/connections-recovery/tool_outcome.receipt.json`.

## قياس ما بعد الاستعادة

الأمر الحرفي: `npm run test:connections`؛ رمز الخروج `0`:

```text
> satr@2.16.21 test:connections
> node scripts/connections-test.js

connections-recovery: PASS dead_lock_recovery
connections-recovery: PASS recovery_contenders
connections-recovery: PASS usage_save_failure
connections-recovery: PASS post_write_connection_changed
connections-recovery: PASS test_release_connection_changed
connections-recovery: PASS tool_post_write_inactive
connections-recovery: summary passed=6 failed=0 skipped=0 total=6
connections-test: OK — encrypted project store, scope, permissions, expiry, disconnect races and production MCP path
```

بصمتا الإنتاج النهائيتان: `connections.js` = `2e151db8f05e7a3741ba6afb6c2e988ea453f127f7adb58208a6afa60cd17d8e`؛ `connection-tools.js` = `2dae585bce82f666089122af28296cb18beedf4f09bd9ee11f4a3bd14bb7bfdb`.

الحارس مرتبط بطقم `connections-test.js`، وتصدير `testConnectionRecovery` مع `require.main` بقي محفوظاً. لا تعديل إصدار أو التزام أو نشر ضمن هذا العمل.

## حدود القفل والقياس

يعتمد الاسترداد على قفل IPC محلي يزول بخروج مالكه: `named pipe` على Windows، و`abstract Unix socket` على Linux. يوضح توثيق Node أن أنابيب Windows تُغلق وتزول عند خروج العملية المالكة، وأن مقابس Linux المجردة تزول بانغلاق آخر مرجع؛ لذلك لا تُستخدم مقابس ملفات Unix العادية التي قد تبقى بعد التعطل. المصدر: [Node.js — IPC paths](https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections).

نطاق الاسترداد في الإنتاج المحلي هو Windows وLinux؛ مسارات UNC وباقي المنصات تبقى على قفل الملف المحافظ. لا وعد بتعافي مخزن شبكي أو مشترك بين أجهزة أو namespaces مختلفة، ولا باسترداد علامة مجهولة/قديمة أو تخص جهازاً آخر. الحارس يتخطى حالتي استرداد القفل وحالة `test_release_connection_changed` خارج Windows وLinux بإعلان `SKIP` وعدّ مستقل، إذ تتطلب الثالثة تحرير قفل IPC الفعلي؛ لا تُحسب الحالات المتخطاة نجاحاً. تبقى حالات نتيجة الكتابة وغلاف الأداة الثلاث عامة.

القياس هنا على Windows فقط؛ Linux ودقة إعلان التخطي على نظام آخر لم يُشغّلا. التنافس الفعلي في هذه الجولة لا يستنفد كل ترتيب لجدولة العمليات أو كل نقطة تعطل، ولا يشمل موت العملية أثناء إنشاء الملف المؤقت قبل ظهور علامة القفل. المزوّد مصطنع؛ لا ادعاء قبول بشري أو منصة خارجية أو صحة الطقم الكامل من هذا التقرير. نتائج الطقم الكامل وتعثّره التاريخي لها سجل مستقل.
