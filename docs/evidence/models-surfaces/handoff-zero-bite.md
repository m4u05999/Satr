# تصحيح حارسي التحديث والتسليم

نجح npm run test:update-ui وnpm run test:handoff-bar-live بعد تحديث الحارسين، دون تعديل الإنتاج في هذه المهمة.

- update-ui: الاستخراج يحدد div بهوية updateToast مع السماح بسمات إضافية، والمقارنة بين ترميز fixture والإنتاج تبقى كاملة. أضيفت data-preview-overlay="overlap" إلى fixture لتطابق الإنتاج.
- handoff: كان الحارس يعد كل إرسال bounds تسريباً. العقد الصحيح يطلب مستطيلاً صفرياً قبل إنشاء العرض وأثناء الحجب، ثم استعادة المستطيل الفعلي بعد فك الحجب قبل تجربة إعادة التنقل.

الدليل الأخضر الحرفي:

```text
OBS078_FILTER_C={"open_during_hold":1,"open_calls":2,"bounds_before_open":[[0,0,0,0]],"bounds_during_hold":[[0,0,0,0]],"bounds_after_release":[[20,30,420,360,null]],"navigate_calls":1}
handoff-bar-live: نجح — التسليم الكامل/المرحلي، طلب السر، أثر المهمة، وإيقافها؛ صفر CSP.
```

## العضّة الفعلية

نسخة الإنتاج المعزولة تحت dist/handoff-zero-bite، ولنافذة الحارس profile مستقل. لم يُزرع العطل في شجرة العمل.

```text
زرع: node dist/handoff-zero-bite/mutate.cjs plant
before original=1 mutant=0
after original=0 mutant=1
اختبار: & node_modules\.bin\electron.cmd dist/handoff-zero-bite/scripts/handoff-bar-live-test.js
OBS078_FILTER_C={"open_during_hold":1,"open_calls":2,"bounds_before_open":[[20,30,420,360]],"bounds_during_hold":[[20,30,420,360]],"bounds_after_release":[[20,30,420,360,null]],"navigate_calls":1}
فشل الحارس: handoff-bar-live: AssertionError [ERR_ASSERTION]: holdForDialog سرّب مستطيل العرض أثناء الحوار.
guard_exit=1
استعادة: node dist/handoff-zero-bite/mutate.cjs restore
restored isolated production copy
```

## إعادة الإثبات بعد تنظيف النسخة التجريبية

الأوامر أعلاه توثّق التنفيذ الأصلي حرفياً؛ أزيل مجلد `dist/handoff-zero-bite` بعد حفظ هذا الدليل. لإعادة الزرع والاختبار والاستعادة من ملفات المشروع الحالية:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs/evidence/models-surfaces/handoff-zero-bite.ps1
```

المشغّل [`handoff-zero-bite.ps1`](handoff-zero-bite.ps1) ينسخ الملفات الضرورية إلى مجلد جديد ذي اسم فريد تحت `dist`، ويستخدم [`handoff-zero-bite.cjs`](handoff-zero-bite.cjs) للزرع والعدّ والاستعادة. لا يغيّر المصدر الأصلي، ولا يحتاج إلى بقاء النسخة التجريبية القديمة. تُحفظ نتيجة الجولة الجديدة داخل مجلدها المطبوع. يتطلب اعتماديات المشروع المثبتة. فُحصت صيغة ملفي الإعادة دون إعادة تشغيل الطقم أثناء تسليم الدليل.

بصمة مصدر `preview-panel.js` الذي زُرع ثم استُعيد: `0CB4A12E59C4AC56F93918F3AB5CF95669D909C3DBE8242E596890745E3A9826`.
