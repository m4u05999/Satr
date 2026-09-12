---
paths:
  - "src/index.html"
  - "src/styles/**"
  - "src/ui/app.js"
  - "src/ui/components/chat.js"
  - "src/ui/components/composer.js"
  - "src/ui/components/topbar.js"
  - "src/ui/components/gate.js"
  - "src/ui/components/files-panel.js"
  - "src/ui/components/file-viewer.js"
  - "src/ui/components/git-panel.js"
  - "src/ui/components/sessions-panel.js"
  - "src/ui/components/perm-dialog.js"
  - "src/ui/components/desktop-panel.js"
  - "src/ui/components/question-dialog.js"
  - "src/ui/lib/text-dir.js"
  - "src/ui/lib/diff.js"
  - "src/ui/lib/diff.css.js"
  - "src/ui/lib/highlight.js"
  - "src/ui/lib/sheet.js"
  - "src/ui/lib/card.css.js"
  - "src/ui/lib/panel.css.js"
  - "electron/exporter.js"
  - "electron/files.js"
  - "electron/search.js"
  - "electron/gitdiff.js"
  - "electron/gitactions.js"
  - "electron/diff.js"
  - "electron/inject.js"
---

# ui-shell — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/01-data-flow.md` — تدفق البيانات
- `docs/internals/07-session-continuity.md` — استمرارية المحادثة والجلسة (حدث `conversation` في القشرة)
- `docs/internals/20-sessions-browser.md` — متصفح الجلسات (المرحلة 1)
- `docs/internals/49-slash-menu-sync.md` — مزامنة أوامر CLI في قائمة «/» (المرحلة 14.1)
- `docs/internals/50-first-run-gate-icon.md` — بوابة أول التشغيل + الأيقونة (المرحلة 6 — تلميع المنتج)
- `docs/internals/51-project-files-panel-reader.md` — لوحة ملفات المشروع + عارض القراءة (الدفعة 1.2 من ROADMAP)
- `docs/internals/52-git-changes-panel.md` — لوحة تغييرات git ± (الدفعة 4.7 — «فرق»)
- `docs/internals/53-chat-export.md` — تصدير المحادثة 📤 (الدفعة 4.8 — «مشاركة»)
- `docs/internals/54-mixed-direction-chat.md` — اتجاه المحتوى المختلط في المحادثة (دفعة «RTL المختلط» — 2026-07-18)
- `docs/internals/55-at-files-image-paste.md` — منصّة @ للملفات + لصق الصور (المرحلة 4)
- `docs/internals/56-arabic-diff-viewer.md` — عارض الفرق (Diff) العربي (المرحلة 3)
- `docs/internals/59-design-system.md` — نظام التصميم (الدفعة 4.1)
- `docs/internals/60-quick-ux-batch.md` — دفعة UX السريعة (بعد 4.1 — من مراجعة UX بموافقة المالك)
- `docs/internals/61-daily-loop-polish.md` — دفعة تلميع الحلقة اليومية (2026-07-19)
- `docs/internals/62-web-components.md` — مكوّنات الواجهة (تفكيك Web Components — اكتمل ت-0…ت-13)
- `docs/internals/66-reply-readability.md` — قرائية ردود الوكيل: سلّم العناوين وعارض Markdown وعمود النثر (2026-09-11)
- `docs/internals/68-models-boot-and-preview-controls.md` — إقلاع النماذج (`refreshEngineModels`) وأسقف اللوحات (2026-09-10)
- `docs/internals/69-computer-use-desktop.md` — لوحة 🪟 سطح ويندوز: المنتقي وسجلّ الأفعال وعلم `desktopControl` (الخطوة ٥)
