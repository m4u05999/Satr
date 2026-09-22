### طبقة القدرات ونموذج Community + Enterprise (features.js — المرحلة 5ج)

**التصميم الكامل في `docs/ARCHITECTURE.md`** (نموذج «النواة + Enterprise إضافي» بطريقة
مستودع Community عام + مستودع Enterprise خاص يُحقن وقت البناء — اقرأه قبل أي عمل يمسّ الفصل).
- **`electron/features.js`**: المُحمِّل الشرطي (`try require('../enterprise')`) + feature-flags.
  النواة تعمل **كاملة** إن غاب `enterprise/` (معيار قبول دائم). فشل Enterprise معزول لا
  يُسقط النواة. هوية البناء (`community|enterprise`) مستقلة عن نجاح الوحدة والترخيص؛ فشل
  وحدة في حزمة Enterprise يظهر بحالة runtime صريحة ولا يتحول إلى Community صامت. `features.init()`
  في main.js؛ IPC `satr:features` (لقطة القدرات والهوية).
- **نقاط الربط**: §4.1 مُحمِّل شرطي، §4.2 سجلّ المحوّلات، §4.3 مخزن الأسرار، §4.4 flags.
- **بناء Enterprise**: `packageFiles` allowlist من checkout الخاص، metadata صريحة، مخرجات
  `dist/enterprise/`، بلا ناشر أو محدث Community. CI الخاص يفحص الحزمة ويولّد provenance.


### إصلاح التغليف التجاري — 2026-09-19

FileSet الخارجي تعارض مع asarUnpack في electron-builder 25.1.8؛ أثبت بناء الإنتاج السقوط،
ثم اجتاز بعد إضافة staging مؤقت من packageFiles داخل dist فقط. لا تغيير في محمل الوحدة
أو عزل Electron أو قواعد فك المهارات؛ publish يبقى null. تُرفض روابط المسارات وتصادمات
Windows، ويعاد فحص العقد قبل النسخ، وتتباعد مجلدات عمليات البناء مع تنظيف مملوك.
حارس enterprise-test يختبر منطق الإنتاج والفشل والتداخل والتنظيف؛ أدلة الدفعة في
dist/enterprise-packaging-review. التفاصيل وحدود الإثبات في 82-pro-saved-tasks-v1.md §19.
