---
paths:
  - "electron/opsroom.js"
  - "electron/opsroomindex.js"
  - "electron/opsplanner.js"
  - "electron/opsbrainstorm.js"
  - "electron/orchestrator.js"
  - "electron/executor.js"
  - "electron/executionteam.js"
  - "electron/worktrees.js"
  - "electron/reviewer.js"
  - "electron/merger.js"
  - "electron/verify.js"
  - "electron/integration.js"
  - "electron/opsartifacts.js"
  - "electron/looprunner.js"
  - "electron/loopfailure.js"
  - "electron/checkpoints.js"
  - "electron/tasks.js"
  - "electron/reviewchanges.js"
  - "src/ui/components/ops-room.js"
  - "src/ui/components/execution-panel.js"
  - "src/ui/components/research-panel.js"
  - "src/ui/lib/ops-room-state.js"
---

# ops-room — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/22-task-ledger.md` — سجل المهام الدائم (Task Ledger — الأولوية 2)
- `docs/internals/23-verify-loop-checkpoint.md` — حلقة التحقق وcheckpoint الدور (الأولوية 3)
- `docs/internals/26-research-orchestrator.md` — منسّق باحثين للقراءة فقط (الأولوية 6 — الخطوة 1)
- `docs/internals/27-executor-worktree.md` — عامل منفّذ محايد عن المحرك في worktree معزول (الأولوية 6 — الخطوة 2)
- `docs/internals/28-parallel-executors.md` — عوامل منفّذة متوازية بملكية ملفات (الأولوية 6 — الخطوة 3)
- `docs/internals/29-reviewer-merge.md` — مراجع ثانٍ ودمج بموافقة صريحة (الأولوية 6 — الخطوة 4)
- `docs/internals/30-integration-verify.md` — التحقق التكاملي قبل الدمج (غرفة العمليات — المرحلة 5)
- `docs/internals/31-review-my-changes.md` — «راجع تغييراتي الآن» — المراجعة العمياء من المحادثة (2026-08-25)
- `docs/internals/32-decisions-evidence-log.md` — سجل القرارات والأدلة (غرفة العمليات — المرحلة 6)
- `docs/internals/33-ops-room-ui.md` — واجهة غرفة العمليات (المرحلة 7)
- `docs/internals/34-bounded-loop-mode.md` — وضع الحلقة المحدودة (الجولة الخامسة — النواة)
