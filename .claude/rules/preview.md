---
paths:
  - "electron/preview.js"
  - "electron/previewrecording.js"
  - "electron/surface.js"
  - "electron/browserguard.js"
  - "electron/browserorigin.js"
  - "electron/browserpolicy.js"
  - "electron/desktopguard.js"
  - "electron/devservers.js"
  - "src/ui/components/preview-panel.js"
  - "src/ui/lib/preview-shield.js"
---

# preview — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/58-preview-panel.md` — لوحة المعاينة المدمجة 🌐 (م-1 — الدفعة 5 «سطر يرى الويب»)
- `docs/internals/68-models-boot-and-preview-controls.md` — أسقف اللوحات وحجب المعاينة وأزرار المعاينة وقصد المستخدم (2026-09-10)
- `docs/COMPUTER-USE-DESKTOP.md` — مواصفة سطح ويندوز: `desktopguard.js` يحمل حرّاس §٩ على عقد §٧ (لا ملف internals له قبل الخطوة ٤)
