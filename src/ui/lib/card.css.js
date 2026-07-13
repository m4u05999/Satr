import { sheet } from './sheet.js';

export const cardSheet = sheet(`
  .work-card {
    border: 1px solid var(--border); border-radius: var(--radius-lg);
    background: var(--surface); overflow: hidden;
  }
  .work-card-head {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-3); background: var(--surface-2);
  }
  .work-card-title { flex: 1; min-width: 0; color: var(--text); font-weight: 600; }
  .work-card-state { color: var(--text-dim); font-size: .75rem; }
  .work-card-summary {
    padding: var(--space-3); color: var(--text-dim); font-size: .8rem;
    line-height: 1.7; unicode-bidi: plaintext;
  }
  .work-card-body {
    max-height: 33vh; overflow: auto; padding: var(--space-3);
    border-top: 1px solid var(--border-dim);
  }
  .work-card-body[hidden] { display: none; }
  .work-card-foot {
    display: flex; flex-wrap: wrap; gap: var(--space-2);
    padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border-dim);
    color: var(--text-faint); font-size: .7rem;
  }
  .work-card-tech {
    direction: ltr; unicode-bidi: isolate; font-family: var(--mono);
    overflow-wrap: anywhere;
  }
  .work-card-toggle { padding: var(--space-1) var(--space-2); }
  .work-card[data-state="completed"] .work-card-state,
  .work-card[data-state="passed"] .work-card-state,
  .work-card[data-state="approve"] .work-card-state { color: var(--green); }
  .work-card[data-state="failed"] .work-card-state,
  .work-card[data-state="reject"] .work-card-state,
  .work-card[data-state="changes_required"] .work-card-state { color: var(--red); }
`);
