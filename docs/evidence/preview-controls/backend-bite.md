# دليل حارس العملية الرئيسية لأزرار المعاينة

الحارس يشغّل وحدة electron/preview.js كاملة، مع حدود Electron مضبوطة. لا يثبت هذا وحده سلوك Chromium الحقيقي؛ تجربته الحية مكملة. الزرع كله في نسخ مستقلة، ولم يتغير المصدر الإنتاجي.

إعادة الإثبات من جذر المستودع:

```powershell
node docs/evidence/preview-controls/backend-bite.cjs all
```

SHA-256 للمصدر المختبر: 5a72182c396ce5b81b2c72b62b65c38af4c6d54baca93eeb0c66427162c25291.

## cleanup

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "cleanup" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\cleanup\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: فشل أول تفعيل ترك debugger مملوكاً متصلاً
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "cleanup" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## cleanup_borrowed

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "cleanup_borrowed" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\cleanup_borrowed\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: فشل الشبكة فصل debugger مستعاراً
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "cleanup_borrowed" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## cleanup_previous

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "cleanup_previous" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\cleanup_previous\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: فشل الاستعادة فصل debugger رغم بقاء المحاكاة
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "cleanup_previous" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## reset

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "reset" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\reset\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: اختيار الجهاز الصريح لم يلغ مقاس الوكيل
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "reset" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## zero

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "zero" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\zero\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: المقاس المخصص حوّل الحجب إلى مستطيل غير صفري
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "zero" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## enable

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "enable" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\enable\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: أمر المحاكاة سبق اكتمال Network.enable
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "enable" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## emulate

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "emulate" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\emulate\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: لم ينتظر أمر المحاكاة
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "emulate" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## queue

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "queue" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\queue\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: طلبات الشبكة السريعة تداخلت
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "queue" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## ownership

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "ownership" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\ownership\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: فصلت محاكاة الشبكة debugger مستعاراً
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "ownership" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## stale

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "stale" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\stale\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: أحداث العرض القديم تسربت إلى واجهة الجديد
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "stale" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## closed

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "closed" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\closed\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: موت العرض لم يُبلّغ مرة واحدة
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "closed" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## action

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "action" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\action\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: فشل الزر أُعيد نجاحاً: reload
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "action" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

## storage

```text
زرع: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "plant" "storage" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
قبل/بعد: الأصل 1 → 0 · المتحوّر 0 → 1
اختبار: node "D:\sater\satr-2\scripts\preview-controls-backend-test.js" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX\storage\preview.js"
رمز الخروج: 1
فشل الحارس: preview-controls-backend: AssertionError [ERR_ASSERTION]: مسح التخزين لم ينتظر اكتماله
استعادة: node "D:\sater\satr-2\docs\evidence\preview-controls\backend-bite.cjs" "restore" "storage" "D:\sater\satr-2\dist\preview-controls-backend-bites-h8VXiX"
بعد الاستعادة: الأصل 1 · المتحوّر 0
```

بعد الاستعادة: preview-controls-backend: 80/80 PASS، وبصمة المصدر الإنتاجي لم تتغير.

السجل الحرفي في backend-bite.log. مسارات النسخ المؤقتة في الأوامر تخص هذه الجولة؛ أمر all أعلاه ينشئ نسخاً جديدة ويعيد جميع خطوات الزرع والعدّ والاختبار والاستعادة.


تنظيف الأدلة: أزيلت نسخ الجولة النهائية فقط (14 ملف مصدر مستعاد) بعد التحقق من المسار المطلق وبصمات الاستعادة وغياب ReparsePoint والعمليات المرتبطة. سبقها تنظيف 21 نسخة مصدر لجولتي الإثبات الأوليتين. بقي المصدر الإنتاجي كما هو، وبقي مشغّل إعادة الإثبات والسجل الحرفي في المستودع.
