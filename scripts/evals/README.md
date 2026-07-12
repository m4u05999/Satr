# مرصد واختبارات وكيل «سطر»

هذه suite حتمية صغيرة تقيس عقد الوكيل والملفات والأذونات على 12 مهمة، بلا شبكة وبلا browser أو preview.

## التشغيل

```powershell
npm run eval:agent
```

يشغّل الأمر وضع `replay` الافتراضي، ويكتب traces منقّحة تحت `dist/agent-eval/` من دون تعديل ملف متتبّع.

لتحديث وثيقة baseline الملتزمة عمداً بعد تغيير المهام أو الـrunner:

```powershell
npm run eval:agent:baseline
```

لتشغيل مهمة واحدة:

```powershell
node scripts/agent-eval.js --task permission-denied
```

## الوضع الحي

الوضع `live` اختياري ويتطلب تثبيت المحرك وتسجيل الدخول. الأذونات مرفوضة افتراضياً؛ فعّل الكتابة أو التنفيذ صراحة عند الحاجة:

```powershell
node scripts/agent-eval.js --mode live --engine codex --task read-file
node scripts/agent-eval.js --mode live --engine sdk --task single-edit --approve-writes
```

إذا حاول محرك حي استعمال أداة browser تتوقف المهمة وتفشل؛ هذه الدفعة لا تختبر المعاينة.

## الخصوصية

افتراضياً لا يُحفظ نص prompt أو خرج أداة أو stream أو مدخل أداة. يحفظ trace:

- `SHA-256` والحجم بالبايت.
- نوع الحدث وmetadata العقد.
- عدادات الأدوات والأذونات والتعديلات.
- نسخة Node والمنصة والمحرك والوضع.

الخيار `--include-sensitive` مخصص للتشخيص المحلي فقط، ويضيف المحتوى الكامل إلى trace تحت `dist/` المتجاهل من Git.

## تحقق `Skills`

```powershell
npm run test:skills
```

الاختبار الافتراضي محلي وحتمي. للتحقق الحي الاختياري من runtime المثبت والمسجّل للدخول:

```powershell
node scripts/skills-test.js --live-codex
node scripts/skills-test.js --live-sdk
```

كل probe تنشئ skill مؤقتة داخل مجلد مؤقت، تعمل بوضع `plan`، وترفض أي إذن غير متوقع.

## المهام الاثنتا عشرة

1. قراءة ملف.
2. بحث في الكود.
3. تحرير ملف واحد.
4. تحرير متعدد الملفات.
5. أمر PowerShell ناجح.
6. مسار عربي.
7. محتوى RTL مشكول.
8. رفض إذن الكتابة.
9. مقاطعة قبل تعديل متأخر.
10. اختبار يفشل برمز خروج غير صفري.
11. استئناف جلسة بالمعرّف نفسه.
12. قص نتيجة أداة كبيرة وحماية trace.

ملف `tasks.json` جزء من baseline ويجب أن يبقى 12 مهمة بالضبط في هذه الدفعة. إضافة suite أوسع لاحقاً تكون في ملف مستقل كي لا ينجرف هذا الخط الأساس.
