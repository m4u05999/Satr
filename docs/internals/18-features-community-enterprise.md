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

