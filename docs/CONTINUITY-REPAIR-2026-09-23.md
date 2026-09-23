# إصلاح حفظ المحادثة ومقارنة الخطّافات — 2026-09-23

النطاق: إعادة محاولة محدودة لاستبدال الملف، تشخيص آمن للفشل النهائي، وقصر مقارنة الخطّافات على ما يفحصه الطرفان. لا تعطيل للحماية ولا تغيير للنموذج أو الاعتماديات. سبب استخدام مستوى المراجعة الحالي: مسار حفظ يستوقف المحرك وملف حارس أمني.

## التحقق

اعتمد المالك الدفعة صراحةً في الجلسة وطلب تجاوز الاختبار اليدوي بعد تعثر تسجيل الدخول. هذا اعتماد بقرار المالك، وليس نتيجة PASS للتجربة البشرية. لا تُطلب إعادة الاختبار اليدوي لهذه الدفعة.

بقيت نافذة Chrome التي يفتحها تسجيل الدخول بيضاء؛ لم يُثبت سببها ولم تُصلح في هذه الدفعة. وكُشف خطأ مستقل في سكربت استخراج رابط الدخول أثناء التجربة: حذف فواصل الأسطر ألحق كلمة Paste بقيمة state (48 محرفاً بدلاً من 43). صُحّح الاستخراج وتحقق طول state وcode_challenge، لكن لم يثبت اكتمال تسجيل الدخول بعد التصحيح. لم يتغير كود تسجيل الدخول في المنتج.

نجحت الاختبارات بعد استعادة كل العضّات: conversations 29/29، conversation-main 15/15، hookguard 84، conversation-ui 22/22، وconversation-history. تعثّر تشغيل conversations الأول داخل الصندوق عند فحص العملية المنتهية؛ نجح خارج الصندوق دون تغيير ذلك السيناريو.

نجح الطقم الكامل لاحقاً بالأمر `npm run test:full:evidence -- --quiet`: عدد المجموعات 153/153 ورمز الخروج 0. مُنع التشغيل الأول داخل الصندوق بخطأ spawn EPERM؛ أعيد خارج الصندوق بإذن الأداة. الدليل الكامل: `dist/test-runs/2026-09-22T22-26-43-559Z/summary.json` والسجل بجواره. أُعيد التحقق من تطابق ملفات الإصلاح الأربعة بين المصدر والحزمة المبنية بعد اكتمال الطقم.

أُغلقت نسخة التجربة المعزولة وانتهت مهمتها برمز 0؛ بقيت ملفات التجربة والأدلة على القرص. لم يُثبّت تحديث ولم يُنشأ التزام أو نشر. اعتماد المالك يتجاوز التجربة اليدوية ولا يحوّلها إلى اختبار ناجح.

## العضّات الفعلية

السكربت المحلي `dist/continuity-repair-bites.cjs` يحفظ بايتات الملف قبل الزرع، ويكتب التغيير، ويتحقق من العدّ، ثم يشغّل الحارس ويستعيد البايتات في `finally`. كل حارس أدناه خرج برمز 1، ثم عادت نسخة الإصلاح ونجح حارسها. ملفات الخرج الخام: `dist/continuity-bite-<name>.json`.

### retry

```text
زرع: node dist/continuity-repair-bites.cjs retry
الملف: electron/conversations.js
الأصل: if (!RENAME_RETRY_CODES.has(error.code) || attempt >= RENAME_BACKOFF_MS.length) throw error;
المتحوّر: if (true) throw error;
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس حرفياً:
AssertionError [ERR_ASSERTION]: {"ok":false,"error":"store_unavailable","code":"EPERM","operation":"rename"}

false !== true

    at ok (D:\sater\satr-2\scripts\conversations-test.js:26:30)
    at assistant (D:\sater\satr-2\scripts\conversations-test.js:30:10)
    at D:\sater\satr-2\scripts\conversations-test.js:55:13
    at test (D:\sater\satr-2\scripts\conversations-test.js:25:27)
    at main (D:\sater\satr-2\scripts\conversations-test.js:45:3)
    at Object.<anonymous> (D:\sater\satr-2\scripts\conversations-test.js:680:1)
    at Module._compile (node:internal/modules/cjs/loader:1934:14)
    at Object..js (node:internal/modules/cjs/loader:2074:10)
    at Module.load (node:internal/modules/cjs/loader:1656:32)
    at Module._load (node:internal/modules/cjs/loader:1448:12) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: 'strictEqual',
  diff: 'simple'
}
استعادة: node dist/continuity-repair-bites.cjs retry (finally: fs.writeFileSync(target, original))
عدّ الاستعادة: الأصل=1 · المتحوّر=0
```

### nonretryable

```text
زرع: node dist/continuity-repair-bites.cjs nonretryable
الملف: electron/conversations.js
الأصل: if (!RENAME_RETRY_CODES.has(error.code) || attempt >= RENAME_BACKOFF_MS.length) throw error;
المتحوّر: if (attempt >= RENAME_BACKOFF_MS.length) throw error;
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس حرفياً:
AssertionError [ERR_ASSERTION]: retry budget and nonretryable errors must be respected

6 !== 1

    at D:\sater\satr-2\scripts\conversations-test.js:78:14
    at test (D:\sater\satr-2\scripts\conversations-test.js:25:27)
    at main (D:\sater\satr-2\scripts\conversations-test.js:62:3)
    at Object.<anonymous> (D:\sater\satr-2\scripts\conversations-test.js:680:1)
    at Module._compile (node:internal/modules/cjs/loader:1934:14)
    at Object..js (node:internal/modules/cjs/loader:2074:10)
    at Module.load (node:internal/modules/cjs/loader:1656:32)
    at Module._load (node:internal/modules/cjs/loader:1448:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 6,
  expected: 1,
  operator: 'strictEqual',
  diff: 'simple'
}
استعادة: node dist/continuity-repair-bites.cjs nonretryable (finally: fs.writeFileSync(target, original))
عدّ الاستعادة: الأصل=1 · المتحوّر=0
```

### diagnostic

```text
زرع: node dist/continuity-repair-bites.cjs diagnostic
الملف: electron/conversations.js
الأصل: failure('store_unavailable', storageDiagnostic(error))
المتحوّر: failure('store_unavailable')
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس حرفياً:
AssertionError [ERR_ASSERTION]: primary diagnostic must survive cleanup
+ actual - expected

  {
-   code: 'EBUSY',
    error: 'store_unavailable',
    ok: false,
-   operation: 'rename'
  }

    at D:\sater\satr-2\scripts\conversations-test.js:79:14
    at test (D:\sater\satr-2\scripts\conversations-test.js:25:27)
    at main (D:\sater\satr-2\scripts\conversations-test.js:62:3)
    at Object.<anonymous> (D:\sater\satr-2\scripts\conversations-test.js:680:1)
    at Module._compile (node:internal/modules/cjs/loader:1934:14)
    at Object..js (node:internal/modules/cjs/loader:2074:10)
    at Module.load (node:internal/modules/cjs/loader:1656:32)
    at Module._load (node:internal/modules/cjs/loader:1448:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: [Object],
  expected: [Object],
  operator: 'deepStrictEqual',
  diff: 'simple'
}
استعادة: node dist/continuity-repair-bites.cjs diagnostic (finally: fs.writeFileSync(target, original))
عدّ الاستعادة: الأصل=1 · المتحوّر=0
```

### cleanup

```text
زرع: node dist/continuity-repair-bites.cjs cleanup
الملف: electron/conversations.js
الأصل: if (!primaryError && cleanupError) throw cleanupError;
المتحوّر: if (cleanupError) throw cleanupError;
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس حرفياً:
AssertionError [ERR_ASSERTION]: primary diagnostic must survive cleanup
+ actual - expected

  {
+   code: 'EACCES',
-   code: 'EBUSY',
    error: 'store_unavailable',
    ok: false,
+   operation: 'unlink'
-   operation: 'rename'
  }

    at D:\sater\satr-2\scripts\conversations-test.js:79:14
    at test (D:\sater\satr-2\scripts\conversations-test.js:25:27)
    at main (D:\sater\satr-2\scripts\conversations-test.js:62:3)
    at Object.<anonymous> (D:\sater\satr-2\scripts\conversations-test.js:680:1)
    at Module._compile (node:internal/modules/cjs/loader:1934:14)
    at Object..js (node:internal/modules/cjs/loader:2074:10)
    at Module.load (node:internal/modules/cjs/loader:1656:32)
    at Module._load (node:internal/modules/cjs/loader:1448:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: [Object],
  expected: [Object],
  operator: 'deepStrictEqual',
  diff: 'simple'
}
استعادة: node dist/continuity-repair-bites.cjs cleanup (finally: fs.writeFileSync(target, original))
عدّ الاستعادة: الأصل=1 · المتحوّر=0
```

### display

```text
زرع: node dist/continuity-repair-bites.cjs display
الملف: electron/main.js
الأصل: conversationBridge.messageFor(error.error, error, { duringRun: true })
المتحوّر: conversationBridge.messageFor(error.error)
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس حرفياً:
AssertionError [ERR_ASSERTION]: original storage diagnostic must reach user
    at D:\sater\satr-2\scripts\conversation-main-test.js:268:14
    at async test (D:\sater\satr-2\scripts\conversation-main-test.js:98:5)
    at async main (D:\sater\satr-2\scripts\conversation-main-test.js:251:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}
استعادة: node dist/continuity-repair-bites.cjs display (finally: fs.writeFileSync(target, original))
عدّ الاستعادة: الأصل=1 · المتحوّر=0
```

### hooks

```text
زرع: node dist/continuity-repair-bites.cjs hooks
الملف: electron/hookguard.js
الأصل: if (event !== 'SessionStart' || !['project', 'local'].includes(scope)) continue;
المتحوّر: if (false) continue;
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس حرفياً:
فشل: uncovered hooks must not produce a false mismatch
استعادة: node dist/continuity-repair-bites.cjs hooks (finally: fs.writeFileSync(target, original))
عدّ الاستعادة: الأصل=1 · المتحوّر=0
```

## حدود التجربة الحية

التجربة `live_5990d9a8014366e600122a69` أقلعت من المصدر ووصلت ready بهوية ومساحة معزولتين، ثم أُغلقت وأعادت completion status=closed. استُخدم --smoke أولاً ثم تبيّن أنه سيناريو تسجيل، فأُغلق قبل التسجيل؛ كانت recording=false. ظهر Object_has_been_destroyed نتيجة قطع السيناريو، فلا تُعد هذه نتيجة PASS لسيناريو smoke، ولو كان رمز خروج المشغّل صفرًا. ظهر أيضاً تحذير No handler registered for satr:ee:savedTasksAvailability؛ خارج نطاق الإصلاح ولم يُعالج. الأدلة محفوظة في dist/live-tests/<id>/evidence. لا تسجيل ولا طلب نموذج مدفوع ولا تعديل لملف المالك الشخصي.

## ما لم يثبت

أُزيلت مجلدات `home/profile/workspace` الخاصة بالتجربة بعد التأكد من خروج مهمتها
وفحص المسارات المطلقة؛ بقيت الأدلة والبيانات الوصفية. لم تُمس موارد نافذة المالك.

لا دليل على رمز الخطأ الأصلي للحوادث القديمة، ولا على مسؤولية Defender، ولا على خصوصية العطل بأوبس. لم تُختبر الحزمة المثبتة أو تُستبدل. إعادة المحاولة تحمي من القفل القصير فقط، والتشخيص النهائي يصل في النص الظاهر دون مسارات أو رسائل استثناء حرة.

## تصدير الإصدار 2.18.3

### الحزمة المجمّعة النهائية — 2026-09-23

طلب المالك التصدير فوراً بسبب تكرر انقطاع المحادثات، مع تأجيل تشخيص Chrome.
أُعيد البناء إلى `dist/release-2.18.3-final` مع إصلاحي النسخ من الطرفية والتذكير
باللغة بعد الأدوات. نجحت `test:terminal-tabs` و`test:langshadow` و`test:langoverride`
ثم البناء برمز 0 (المهمة `term_6`). لم يُعد الطقم الكامل بعد هذين التعديلين؛
نتيجة 153/153 أدناه تخص الدفعة السابقة.

المثبّت: `dist/release-2.18.3-final/Satr Setup 2.18.3.exe`، حجمه 78927071 بايت.
بصمة SHA-256: `109d6e92efaed47ce4c9417f38056022074cbfa07ee05284a343cb5f8b5faf96`.
تحقق `verification.json` بجواره من الإصدار 2.18.3 والتطابق البايتي لستة ملفات:
`agent.js` و`langanchor.js` و`terminal-panel.js` و`conversations.js` و`main.js`
و`hookguard.js` بين المصدر وأرشيف الحزمة. الناتج تصدير محلي، غير موقّع رقمياً،
ولم يُثبّت تلقائياً أو يُنشر عاماً. مشكلة نافذة Chrome البيضاء ما زالت غير محلولة.

### التصدير الأول قبل إضافة إصلاحي اللغة والنسخ

طلب المالك الالتزام وتصدير نسخة جديدة بعد اعتماده الدفعة وإعفائها من الاختبار اليدوي. زُومن رقم الإصدار في الحزمة والقفل وREADME وخط أساس الرادار، وأُضيف وصف الإصلاح إلى CHANGELOG. نجح حارسا readme-version وradar-graveyard.

نجح `npm run dist -- --publish never --config.directories.output=dist/release-2.18.3` برمز خروج 0 خارج العزل بعد منع المحاولة الأولى بخطأ spawn EPERM. الناتج المحلي: `dist/release-2.18.3/Satr Setup 2.18.3.exe`؛ لا نشر عام ولا تثبيت تلقائي. المثبّت غير موقّع رقمياً لعدم وجود شهادة توقيع في بيئة البناء.

تحقّق أرشيف الحزمة أثبت الإصدار 2.18.3 وتطابق ملفات الإصلاح الأربعة بايتياً مع المصدر، وكذلك تطابق المعين `resources/satr-uia/satr-uia.exe` مع ثنائي البناء. دليل الطقم الكامل السابق 153/153 يغطي كود الإصلاح نفسه؛ تغييرات هذه المرحلة تخص رقم الإصدار والتوثيق فقط. مشكلة Chrome البيضاء ليست إصلاحاً مشحوناً في هذا الإصدار.

## الحزمة الجاهزة للتجربة

بُنيت الحزمة بالأمر `npm run dist:dir -- --config.directories.output=dist/continuity-repair-build` ونجح البناء برمز خروج 0 بعد إعادة التشغيل خارج العزل (المحاولة الأولى مُنعت بخطأ spawn EPERM).

أقلعت الحزمة `dist/continuity-repair-build/win-unpacked/Satr.exe` في التجربة `live_9bc025b82bedde60092ecce8`، وظهر `PACKAGED_READY`. تحقّق المشغّل من التطابق البايتّي لملفات الإصلاح الأربعة في app.asar مع المصدر. الأدلة: `verified-files.json` و`package-state.json` و`acceptance-ready.json` داخل مجلد التجربة. هذه نتيجة إقلاع حزمة، وليست قبولاً بشرياً أو اختباراً بمحرك حقيقي.

عنوان النافذة: «سطر — تجربة إصلاح حفظ المحادثة». المنزل والملف الشخصي والبيئة معزولة؛ لم تُنسخ اعتمادات المحرك. المشروع التجريبي يحوي README بعلامة CONTINUITY-READY وخطّاف PreToolUse لأداة Read ينتهي بنجاح دون فعل. لا طلب نموذج حتى التسليم. بقيت النافذة وموارد التجربة متاحة للمالك؛ التنظيف بعد انتهاء التجربة فقط.

معيار التجربة قبل التنفيذ: بعد إعداد Claude في النسخة المعزولة، يرسل المالك «اقرأ README.md وأخبرني بعلامة التجربة فقط». الصواب: CONTINUITY-READY، اكتمال الدور وعدم ظهور تنبيه اختلاف PreToolUse لهذا الخطاف. الفشل: ظهور ذلك التنبيه أو انقطاع الدور. نجاح الدور القصير لا يثبت زوال الانقطاع المتقطع تحت الحمل؛ تشخيص رمز الخطأ الجديد مطلوب إذا عاد.
