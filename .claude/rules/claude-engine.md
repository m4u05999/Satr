---
paths:
  - "electron/agent.js"
  - "electron/claudeauth.js"
  - "electron/sessions.js"
  - "electron/chats.js"
  - "electron/sdkrewinds.js"
  - "electron/elicitation.js"
  - "electron/envbrief.js"
  - "electron/agents.js"
  - "electron/enginesupdate.js"
---

# claude-engine — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/02-claude-fork-rewind.md` — تفريع واسترجاع Claude الأصلي (دفعة A — 2026-07-24)
- `docs/internals/03-claude-models-account.md` — نماذج وحساب Claude الديناميكيان (دفعة B — 2026-07-25)
- `docs/internals/04-claude-connectors.md` — إدخال موصّلات Claude (دفعة C — 2026-07-26)
- `docs/internals/05-claude-sdk-background-tasks.md` — مهام Claude SDK الخلفية (دفعة D — 2026-07-26)
- `docs/internals/06-claude-sdk-polish.md` — تلميع محرك Claude Agent SDK (دفعة E — 2026-07-27)
- `docs/internals/07-session-continuity.md` — استمرارية الجلسة
- `docs/internals/13-send-liveness-timeouts.md` — موثوقية الإرسال — مهلات الإقلاع والإيقاف (إصلاح 2026-07-30)
- `docs/internals/20-sessions-browser.md` — متصفح الجلسات (المرحلة 1)
- `docs/internals/39-claude-code-parity-commands.md` — أوامر التكافؤ مع Claude Code (الدفعة الأخيرة قبل التجميد)
- `docs/internals/40-subagents.md` — الوكلاء الفرعيون (Subagents — المرحلة 14.2)
- `docs/internals/46-envbrief.md` — وعي بيئة «سطر» الموحّد — envbrief
