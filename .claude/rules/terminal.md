---
paths:
  - "electron/term.js"
  - "electron/termjobs.js"
  - "electron/bgprocs.js"
  - "electron/execguard.js"
  - "src/ui/components/terminal-panel.js"
  - "src/vendor/**"
---

# terminal — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/43-run-in-terminal-tool.md` — دمج الطرفية مع النموذج — أداة run_in_terminal (المرحلة 16)
- `docs/internals/44-background-terminal-jobs.md` — مهام الطرفية المعمّرة — run_in_background
- `docs/internals/45-bg-term-done-feedback.md` — توصيل `bg_term_done` إلى النموذج (دفعة تغذية الأدوات الراجعة — 2026-08-24)
- `docs/internals/57-arabic-terminal.md` — الطرفية العربية المدمجة (المرحلة 8 — مكتملة: 8.1–8.4)
