---
paths:
  - "electron/codex.js"
  - "electron/codexrpc.js"
  - "electron/codexmcp.js"
  - "electron/codexsessions.js"
  - "src/ui/components/mcp-panel.js"
---

# codex-engine — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/09-codex-steer.md` — التوجيه أثناء الدور لمحرك Codex (turn/steer — الدفعة C1، 2026-07-26)
- `docs/internals/10-codex-compact-context.md` — تكافؤ /ضغط و/سياق لمحرك Codex (الدفعة C2، 2026-07-26)
- `docs/internals/11-codex-connectors-panel.md` — لوحة موصّلات Codex ‏(/موصلات + OAuth — الدفعة C3، 2026-07-27)
- `docs/internals/12-codex-account-usage.md` — حساب Codex واستهلاكه ‏(⚙ + تسجيل دخول — الدفعة C4، 2026-07-27)
- `docs/internals/13-send-liveness-timeouts.md` — موثوقية الإرسال — مهلات الإقلاع والإيقاف (إصلاح 2026-07-30)
