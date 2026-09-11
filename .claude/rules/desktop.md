---
paths:
  - "electron/desktop.js"
  - "electron/desktopguard.js"
  - "electron/surface.js"
  - "native/satr-uia/**"
  - "src/ui/components/desktop-panel.js"
  - "scripts/desktop-test.js"
  - "scripts/desktop-live-test.js"
  - "scripts/desktop-panel-live-test.js"
  - "scripts/uia-helper-test.js"
  - "scripts/lib/fake-uia-helper.js"
---

# desktop — اقرأ قبل أن تلمس

سطح ويندوز (استعمال الحاسوب): المعين الأصلي والمراجع والحرّاس والأدوات الثماني. **قبل تعديلها اقرأ ما يخصّ
تغييرك، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/69-computer-use-desktop.md` — ما بُني بالأرقام (الخطوات ٠–٤) والقرارات التي مسّت المواصفة
- `docs/COMPUTER-USE-DESKTOP.md` — المواصفة الملزمة: §٦ التسجيل · §٧ العقد · §٨ البروتوكول · §٩ الحرّاس الخمسة
- `native/satr-uia/README.md` — البروتوكول وجداول COM (أي واجهة جديدة تُستخرج من `UIAutomationClient.idl` لا من الذاكرة)

ثوابت: لا `desktop_evaluate` ولا إحداثيات ولا نموذج رؤية ولا تعداد بلا اختيار المستخدم · الخادم يُسجَّل عند بدء
الجلسة فقط · الاختيار لجلسة واحدة ويُسحب مع «جلسة جديدة» · لا فعل بلا سطر مرئي (اللوحة **و**بطاقة الأداة في
المحادثة) · الأدوات الثماني خارج `BROWSER_AUTO_TOOLS` و`AUTO_SAFE_TOOLS` · الحرّاس `test:desktop`
و`test:desktop-live` و`test:uia-helper` و`test:desktopguard` و`test:surface` و`test:desktop-panel`.
