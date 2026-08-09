// غرفة العمليات: لوحة عمل عربية تعرض الحقيقة العامة المنقّاة فقط، وتترك كل انتقال
// تشغيلي لنقرة مستخدم صريحة. لا patch ولا خرج أوامر كامل يدخل هذا المكوّن.
import { sheet } from '../lib/sheet.js';
import { panelSheet, controlsSheet } from '../lib/panel.css.js';
import { cardSheet } from '../lib/card.css.js';
import { buildDiff } from '../lib/diff.js';
import { diffSheet } from '../lib/diff.css.js';
import {
  createOpsRoomState, deriveAgentActivity, deriveOpsRoomState, deriveStations,
  INHERIT_TEMPLATE_TEAM_STATES, opsRoomReducer, STATION_KEYS,
} from '../lib/ops-room-state.js';
import {
  LIFECYCLE_LABELS, lifecycleLabel, countLabel, truncateWords,
} from '../lib/lifecycle-labels.js';

const roomSheet = sheet(`
  :host {
    position: relative; inset: auto; display: none; align-self: stretch;
    width: clamp(min(22rem, 94vw), var(--ops-room-width, 42rem), min(60rem, 94vw));
    min-width: min(22rem, 94vw); max-width: min(60rem, 94vw);
    height: 100%; min-height: var(--space-0); flex: 0 0 auto;
    z-index: var(--z-panel); resize: none; overflow: visible; box-shadow: var(--shadow-dock);
    transform: none; transition: width var(--dur) var(--ease),
      min-width var(--dur) var(--ease), max-width var(--dur) var(--ease);
  }
  :host([open]) { display: flex; transform: none; }
  :host([compact]) {
    width: var(--space-7); min-width: var(--space-7); max-width: var(--space-7);
    flex: 0 0 var(--space-7); resize: none;
  }
  :host([compact]) .action-bar, :host([compact]) .guided-path,
  :host([compact]) .room-nav, :host([compact]) .status-row,
  :host([compact]) .timeout-row, :host([compact]) .next-step,
  :host([compact]) .station-title, :host([compact]) .panel-list { display: none; }
  :host([compact]) .panel-head {
    flex: 1; flex-direction: column; justify-content: flex-start;
    padding: var(--space-2); gap: var(--space-3);
  }
  :host([compact]) .panel-title { writing-mode: vertical-rl; text-orientation: mixed; }
  :host([compact]) .panel-head-actions { flex-direction: column; }
  :host([compact]) .panel-head button { width: 100%; padding: var(--space-1); }
  :host([compact]) .verify-config { display: none; }
  :host([compact]) .compact-state { display: inline-flex; }
  :host([compact]) .resize-handle, :host([drawer]) .resize-handle { display: none; }
  :host([drawer]), :host([drawer][compact]) {
    width: 100vw; min-width: 100vw; max-width: 100vw; flex: 0 0 100vw;
    resize: none;
  }
  :host([drawer]) .compact { display: none; }
  .resize-handle {
    position: absolute; top: var(--space-0); bottom: var(--space-0);
    left: var(--space-0); width: var(--space-3); transform: translateX(-50%);
    z-index: var(--z-sticky); cursor: ew-resize; touch-action: none;
  }
  .resize-handle::before {
    content: ''; position: absolute; top: var(--space-2); bottom: var(--space-2); left: 50%;
    width: 1px; background: var(--border); transition: background var(--dur) var(--ease);
  }
  .resize-handle:hover::before, .resize-handle:focus-visible::before,
  .resize-handle[data-active="true"]::before { background: var(--gold); }
  .resize-handle:focus-visible { outline: 2px solid var(--gold); outline-offset: var(--space-1); }
  .panel-head { gap: var(--space-3); }
  .verify-config { color: var(--gold); border-color: var(--gold-border); }
  .panel-head-actions, .action-bar, .setup-actions {
    display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
  }
  .compact-state {
    display: none; align-items: center; justify-content: center;
    min-width: var(--space-5); min-height: var(--space-5);
    border: 1px solid var(--border); border-radius: var(--radius-pill);
    color: var(--gold); font-weight: 700;
  }
  .compact-state[data-alert="true"] { color: var(--red); border-color: var(--red); }
  .action-bar {
    position: sticky; bottom: var(--space-0); flex: 0 0 auto;
    padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border);
    background: var(--surface); z-index: var(--z-local);
  }
  .action-bar[hidden] { display: none; }
  .action-bar[data-attention] { background: var(--gold-soft); }
  .action-bar button { flex: 0 0 auto; font-size: .75rem; }
  .primary-action { color: var(--gold); border-color: var(--gold-border); background: var(--surface-3); }
  .primary-action[data-action="merge"] { color: var(--green); border-color: var(--green-border); }
  .preview-action { color: var(--gold); border-color: var(--gold-border); }
  .preview-stop { color: var(--red); }
  .primary-reason { color: var(--red); font-size: .72rem; unicode-bidi: plaintext; }
  .primary-reason[hidden] { display: none; }
  .status-row, .timeout-row {
    display: flex; align-items: center; gap: var(--space-2);
    padding-inline-end: var(--space-3); border-bottom: 1px solid var(--border);
  }
  .status-row .stop { color: var(--red); white-space: nowrap; }
  .status-row .verify-config-recovery { color: var(--gold); border-color: var(--gold-border); white-space: nowrap; }
  .status-row .verify-config-recovery[hidden] { display: none; }
  .timeout-row[hidden] { display: none; }
  .timeout-row .extend { color: var(--gold); border-color: var(--gold-border); white-space: nowrap; }
  .room-nav {
    display: none;
  }
  .room-nav button {
    flex: 1; display: inline-flex; align-items: center; justify-content: center;
    gap: var(--space-1); white-space: nowrap; padding: var(--space-1) var(--space-2);
  }
  .room-nav button[aria-selected="true"] { color: var(--gold); border-color: var(--gold); }
  .group-badge {
    padding-inline: var(--space-1); border: 1px solid var(--gold-border);
    border-radius: var(--radius-pill); color: var(--gold); font-size: .68rem;
  }
  .group-badge[data-alert="true"] { color: var(--red); border-color: var(--red); }
  .guided-path {
    position: relative; display: flex; align-items: stretch; gap: var(--space-2);
    padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border);
    background: var(--surface-2); z-index: var(--z-local);
  }
  .station-strip {
    flex: 1; min-width: 0; display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--space-1);
  }
  .station-strip button {
    min-width: 0; display: inline-flex; align-items: center; justify-content: center;
    gap: var(--space-1); padding: var(--space-1); color: var(--text-dim);
    white-space: nowrap; font-size: .68rem;
  }
  .station-strip button[data-state="completed"] { color: var(--green); border-color: var(--green-border); }
  .station-strip button[data-state="current"],
  .station-strip button[data-current="true"] { color: var(--gold); border-color: var(--gold-border); }
  .station-strip button[data-alert="true"] { color: var(--ops-review-alert); border-color: var(--ops-review-alert); }
  .station-strip button[data-selected="true"] { background: var(--surface-3); font-weight: 700; }
  .station-marker { font-weight: 700; }
  .more-wrap { position: relative; flex: none; }
  .more-toggle { height: 100%; white-space: nowrap; }
  .more-menu {
    position: absolute; inset-block-start: calc(100% + var(--space-1)); inset-inline-end: var(--space-0);
    min-width: 11rem; display: grid; gap: var(--space-1); padding: var(--space-2);
    border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--surface); box-shadow: var(--shadow-dock); z-index: var(--z-sticky);
  }
  .more-menu[hidden] { display: none; }
  .more-menu button { text-align: start; white-space: nowrap; }
  .station-title {
    padding: var(--space-2) var(--space-3); color: var(--text-dim);
    border-bottom: 1px solid var(--border); font-size: .72rem; font-weight: 600;
    unicode-bidi: plaintext;
  }
  .status {
    flex: 1; min-width: 0; min-height: var(--space-6); padding: var(--space-2) var(--space-3);
    color: var(--text-dim); font-size: .78rem;
    unicode-bidi: plaintext;
  }
  .timeout-warning { flex: 1; color: var(--gold); font-size: .78rem; padding: var(--space-2) var(--space-3); }
  .next-step {
    flex: 1 1 var(--space-7); min-width: 0; color: var(--text-dim);
    font-size: .75rem; line-height: 1.6; unicode-bidi: plaintext;
  }
  .action-bar[data-attention] .next-step { color: var(--text); }
  .next-step::before { content: 'التالي: '; color: var(--gold); font-weight: 600; }
  .panel-list { min-height: 0; padding: var(--space-3); overflow-y: auto; overscroll-behavior: contain; }
  .group-view { display: grid; gap: var(--space-3); }
  .group-view[hidden] { display: none; }
  .subnav { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; }
  .subnav button {
    flex: 1; white-space: nowrap; padding: var(--space-1) var(--space-2);
    color: var(--text-dim); background: transparent; border-color: transparent; font-size: .72rem;
  }
  .subnav button[aria-selected="true"] {
    color: var(--gold); border-color: var(--border); background: var(--surface-2);
  }
  .view { display: grid; gap: var(--space-3); }
  .view[hidden] { display: none; }
  .empty {
    padding: var(--space-5); color: var(--text-dim); text-align: center;
    border: 1px dashed var(--border); border-radius: var(--radius-lg); line-height: 1.8;
  }
  .setup {
    display: grid; gap: var(--space-2); padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2);
  }
  .setup-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .setup-fields {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3); align-self: stretch;
  }
  .setup-field { display: grid; gap: var(--space-1); min-width: 0; }
  .setup-field > span { color: var(--text-dim); font-size: .75rem; }
  .setup-note { color: var(--text-dim); font-size: .75rem; line-height: 1.7; }
  /* الإعدادات المتقدمة مطوية: الحلقة ونماذج العامل والمراجعين */
  .setup-advanced { display: grid; gap: var(--space-2); }
  .setup-advanced-toggle {
    background: none; border: none; color: var(--text-dim); cursor: pointer;
    font: inherit; font-size: .78rem; padding: var(--space-1) 0; text-align: start;
  }
  .setup-advanced-toggle:hover { color: var(--gold); }
  .setup-advanced-toggle.open { color: var(--gold); }
  .setup-advanced-body { display: grid; gap: var(--space-3); }
  .model-fields {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3);
    padding: var(--space-3); border: 1px solid var(--border);
    border-radius: var(--radius-md); background: var(--surface);
  }
  .model-input {
    width: 100%; direction: ltr; text-align: left; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--radius-md); padding: var(--space-2); font: .8rem/1.7 var(--mono);
  }
  .model-input:focus { border-color: var(--gold); outline: none; }
  .judge-model-warning {
    grid-column: 1 / -1; color: var(--gold); font-size: .75rem; line-height: 1.7;
    unicode-bidi: plaintext;
  }
  .judge-model-warning[hidden] { display: none; }
  .loop-options {
    display: grid; gap: var(--space-2); padding: var(--space-3);
    border: 1px solid var(--gold-border); border-radius: var(--radius-md); background: var(--surface);
  }
  .loop-toggle { display: flex; align-items: center; gap: var(--space-2); color: var(--gold); }
  .loop-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .loop-fields[hidden] { display: none; }
  input[type="number"] {
    width: 100%; direction: ltr; text-align: left; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--radius-md); padding: var(--space-2); font: .8rem/1.7 var(--mono);
  }
  .worker-input {
    display: grid; gap: var(--space-2); padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface);
  }
  .worker-input[hidden] { display: none; }
  .worker-title { color: var(--gold); font-weight: 600; }
  select, textarea {
    width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-2); font: .8rem/1.7 var(--sans);
    outline: none; unicode-bidi: plaintext;
  }
  select:focus, textarea:focus { border-color: var(--gold); }
  textarea { resize: vertical; min-height: calc(var(--space-7) + var(--space-5)); }
  .worker-input .setup-field { display: flex; flex-direction: column; }
  .task, .ownership { flex: 1 1 auto; }
  .task { min-height: calc(var(--space-7) + var(--space-6)); }
  .ownership {
    direction: ltr; text-align: left; font-family: var(--mono);
    min-height: calc(var(--space-7) + var(--space-3));
  }
  .decision-box { display: grid; gap: var(--space-2); }
  .decision-box textarea { min-height: 5rem; }
  .agent-meta, .file-row, .check-row {
    display: flex; gap: var(--space-2); align-items: baseline; justify-content: space-between;
    padding-block: var(--space-2); border-bottom: 1px solid var(--border-dim);
  }
  .agent-meta:last-child, .file-row:last-child, .check-row:last-child { border-bottom: none; }
  .file-diff-request {
    width: 100%; background: transparent; border: none; border-radius: var(--space-0);
    color: var(--text); text-align: start; cursor: pointer;
  }
  .file-diff-request:hover { background: var(--surface-3); border: none; }
  .file-diff-error { padding: var(--space-2); color: var(--red); unicode-bidi: plaintext; }
  .path, .command, .artifact {
    direction: ltr; unicode-bidi: isolate; font-family: var(--mono); text-align: left;
    overflow-wrap: anywhere;
  }
  .path, .command { flex: 1; min-width: 0; }
  .counts { direction: ltr; font-family: var(--mono); color: var(--text-dim); white-space: nowrap; }
  .check-result { unicode-bidi: plaintext; color: var(--text-dim); }
  .summary { white-space: pre-wrap; unicode-bidi: plaintext; }
  .loop-card { display: grid; gap: var(--space-3); }
  .loop-head, .loop-metrics, .loop-actions {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap;
  }
  .loop-metric { display: inline-flex; align-items: baseline; gap: var(--space-1); color: var(--text-dim); }
  .loop-title { color: var(--gold); font-weight: 700; }
  .loop-state { color: var(--text-dim); }
  .loop-progress { width: 100%; height: var(--space-2); accent-color: var(--gold); }
  .loop-progress::-webkit-progress-bar { background: var(--surface-3); border-radius: var(--radius-pill); }
  .loop-progress::-webkit-progress-value { background: var(--gold); border-radius: var(--radius-pill); }
  .loop-failure, .loop-guidance { unicode-bidi: plaintext; line-height: 1.7; }
  .loop-failure { color: var(--red); }
  .loop-guidance { color: var(--text-dim); }
  .loop-stop { color: var(--red); }
  .loop-review {
    display: grid; gap: var(--space-2); padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2);
  }
  .loop-review-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
  .loop-review-title { color: var(--ops-review-title, var(--gold)); font-weight: 600; }
  .loop-review-state { color: var(--text-dim); }
  .loop-review-state[data-state="approve"] { color: var(--green); }
  .loop-review-state[data-state="changes_required"], .loop-review-state[data-state="reject"],
  .loop-review-state[data-state="failed"] { color: var(--ops-review-alert, var(--red)); }
  .loop-review-summary {
    display: -webkit-box; margin: var(--space-0); overflow: hidden; overflow-wrap: anywhere;
    color: var(--text-dim); line-height: 1.7; unicode-bidi: plaintext;
    -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  }
  .review-section { display: grid; gap: var(--space-1); }
  .review-section h4 { color: var(--ops-review-title, var(--gold)); font-size: .78rem; }
  .review-section ul { margin: var(--space-0); padding-inline-start: var(--space-5); display: grid; gap: var(--space-1); }
  .review-section li { unicode-bidi: plaintext; }
  .merged-report {
    display: grid; gap: var(--space-3); padding: var(--space-3);
    border: 1px solid var(--gold-border); border-radius: var(--radius-lg); background: var(--surface-2);
  }
  .merged-head, .merged-counts, .merged-item-head, .review-lens-head {
    display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
  }
  .merged-head { justify-content: space-between; }
  .merged-title { color: var(--gold); font-weight: 700; }
  .merged-count, .merged-severity, .merged-truncated, .review-lens-state, .review-lens-verdict {
    display: inline-flex; align-items: center; padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border); border-radius: var(--radius-pill); font-size: .7rem;
  }
  .merged-count[data-severity="critical"], .merged-severity[data-severity="critical"] {
    color: var(--red); border-color: var(--red);
  }
  .merged-count[data-severity="high"], .merged-severity[data-severity="high"] {
    color: var(--red); border-color: var(--red);
  }
  .merged-count[data-severity="medium"], .merged-severity[data-severity="medium"] {
    color: var(--gold); border-color: var(--gold-border);
  }
  .merged-count[data-severity="low"], .merged-severity[data-severity="low"] {
    color: var(--green); border-color: var(--green-border);
  }
  .merged-truncated { color: var(--gold); border-color: var(--gold-border); }
  .merged-items, .review-lenses { display: grid; gap: var(--space-2); }
  .merged-item, .review-lens {
    display: grid; gap: var(--space-2); padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface);
  }
  .merged-lens { color: var(--text-dim); }
  .merged-engine { direction: ltr; unicode-bidi: isolate; font-family: var(--mono); color: var(--text-dim); }
  .merged-text { unicode-bidi: plaintext; line-height: 1.7; }
  .merged-repair { justify-self: start; color: var(--gold); border-color: var(--gold-border); }
  .review-lens-title { color: var(--ops-review-title, var(--gold)); font-weight: 700; }
  .review-lens-state, .review-lens-verdict { color: var(--text-dim); }
  .live-activity {
    display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
    padding: 0 var(--space-3) var(--space-3); color: var(--text-dim); font-size: .75rem;
  }
  .observable-activity { unicode-bidi: plaintext; }
  .observable-activity[data-activity="quiet"] { color: var(--gold); }
  .warning { color: var(--red); }
  .gate-summary {
    padding: var(--space-3); border: 1px solid var(--gold-border);
    border-radius: var(--radius-lg); color: var(--text-dim); line-height: 1.8;
  }
  @media (max-width: 44rem) {
    :host { width: 100vw; max-width: 100vw; }
    .panel-head { align-items: flex-start; }
    .action-bar { align-items: stretch; }
    .action-bar button { flex: 1 1 auto; }
    .setup-head { align-items: flex-start; flex-direction: column; }
    .model-fields { grid-template-columns: minmax(0, 1fr); }
    .loop-fields { grid-template-columns: minmax(0, 1fr); }
    /* قرار المسار الموجّه: المحطات تبقى ظاهرة وتتكدس عمودياً داخل drawer. */
    .guided-path { align-items: stretch; }
    .station-strip { grid-template-columns: minmax(0, 1fr); }
    .station-strip button { justify-content: flex-start; }
    .more-toggle { height: auto; }
    .next-step { display: none; }
  }
`);

const dialogSheet = sheet(`
  :host {
    position: fixed; inset: var(--space-0); z-index: var(--z-modal);
    display: none; align-items: center; justify-content: center;
    padding: var(--space-4); background: color-mix(in srgb, var(--bg) 72%, transparent);
  }
  :host([open]) { display: flex; }
  .dialog-box {
    width: min(34rem, 94vw); max-height: min(38rem, 88vh); overflow: auto;
    display: grid; gap: var(--space-3); padding: var(--space-5);
    background: var(--surface-2); border: 1px solid var(--gold);
    border-radius: var(--radius-xl); box-shadow: var(--shadow-modal);
  }
  h2 { color: var(--gold); font-size: 1.05rem; }
  .description { color: var(--text-dim); line-height: 1.8; unicode-bidi: plaintext; }
  .items {
    max-height: 32vh; overflow: auto; display: grid; gap: var(--space-2);
    padding: var(--space-3); border: 1px solid var(--border);
    border-radius: var(--radius-md); background: var(--bg);
  }
  .items[hidden] { display: none; }
  .item { direction: ltr; unicode-bidi: plaintext; font-family: var(--mono); overflow-wrap: anywhere; }
  .item-details summary { cursor: pointer; color: var(--text-dim); }
  .item-details .item { margin-block-start: var(--space-2); }
  .dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .confirm { color: var(--green); border-color: var(--green-border); }
  @media (prefers-reduced-motion: no-preference) {
    :host([open]) .dialog-box { animation: ops-dialog-in var(--dur) var(--ease); }
    @keyframes ops-dialog-in { from { opacity: 0; transform: translateY(var(--space-1)); } }
  }
`);

const GROUPS = [
  { id: 'work', label: 'العمل', views: [['brainstorm', 'العصف'], ['tasks', 'المهام والنشاط']] },
  { id: 'results', label: 'النتائج', views: [['diffs', 'الفروقات'], ['evidence', 'الأدلة'], ['review', 'المراجعة']] },
  { id: 'log', label: 'السجل', views: [['decisions', 'القرارات'], ['discussion', 'النقاش'], ['history', 'التاريخ']] },
];

const STATION_VIEWS = {
  setup: 'tasks', execute: 'tasks', review: 'review', verify: 'evidence', merge: 'diffs',
};
const MORE_VIEWS = [
  ['brainstorm', 'العصف'], ['decisions', 'القرارات'], ['discussion', 'النقاش'], ['history', 'التاريخ'],
];
const DRAWER_MEDIA = '(max-width: 44rem)';
const LAYOUT_STORAGE_PREFIX = 'satr_ops_layout:';
const MODEL_STORAGE_PREFIX = 'satr_ops_models::';
const WEAK_JUDGE_MODEL = /haiku|mini|lite|flash|nano/i;
const LENS_LABELS = { correctness: 'الصحة', security: 'الأمان', simplicity: 'التبسيط' };
const SEVERITY_LABELS = { critical: 'حرج', high: 'مرتفع', medium: 'متوسط', low: 'منخفض' };
const PRIMARY_ACTIONS = {
  start: { label: 'ابدأ التنفيذ', can: 'canStart', method: '_startExecution' },
  review: { label: 'ابدأ المراجعة', can: 'canReview', method: '_startReview' },
  prepare: { label: 'ثبّت التحقق', can: 'canPrepareVerification', method: '_prepareVerification' },
  verify: { label: 'شغّل الاختبارات', can: 'canRunVerification', method: '_runVerification' },
  merge: { label: 'ادمج الأثر', can: 'canMerge', method: '_merge' },
};

const TEAM_STATES = {
  preparing: 'يجهّز النسخ المعزولة…', queued: 'في الانتظار', running: 'ينفّذ…',
  capturing: 'يجمع وصف الفروقات…', stopping: 'يوقف الفريق…', completed: 'اكتمل التنفيذ',
  failed: 'فشل التنفيذ', timed_out: 'انتهت المهلة', stopped: 'توقف',
  cleanup_failed: 'فشل التنظيف', conflict: 'تعارض ملكية',
  interrupted: 'انقطع بإغلاق سابق',
};

const LOOP_STATES = {
  preparing: 'يجهّز الحلقة', working: 'ينفّذ الإصلاح', verifying: 'يتحقق', passed: 'نجحت',
  failed_after_n: 'فشلت بعد نفاد الدورات', budget_exhausted: 'نفدت الميزانية',
  failed: 'فشلت', stopped: 'توقفت',
};
const LOOP_REVIEW_STATES = {
  idle: 'بانتظار المراجع', running: 'جارية', approve: 'اعتمدت',
  changes_required: 'تطلب تعديلات', reject: 'رفضت', failed: 'فشلت',
};
const LOOP_STOP_REASONS = {
  pass: 'نجح التحقق', iterations: 'نفدت الدورات', budget: 'نفدت الميزانية',
  user: 'أوقفها المستخدم', error: 'حدث خطأ',
};
const ACTOR_LABELS = {
  system: 'النظام', user: 'المستخدم', reviewer: 'المراجع', advisor: 'المستشار',
};
const ENTRY_TYPE_LABELS = {
  proposal: 'مقترح', decision: 'قرار', phase_gate: 'انتقال مرحلي', review: 'مراجعة',
  verification: 'تحقق', note: 'ملاحظة',
};
const RUN_KIND_LABELS = { team: 'فريق', loop: 'حلقة' };
const FILE_COUNT_FORMS = { one: 'ملف واحد', two: 'ملفان', plural: 'ملفات', many: 'ملفاً' };
const TECHNICAL_PARTS = /(\.satr[\\/][A-Za-z0-9._\\/-]*[A-Za-z0-9_-]|\b(?:HEAD|Git|worktree|commit|push|patch|preview)\b)/g;
const TECHNICAL_PART = /^(?:\.satr[\\/][A-Za-z0-9._\\/-]*[A-Za-z0-9_-]|HEAD|Git|worktree|commit|push|patch|preview)$/;

const TERMINAL_AGENT_STATES = new Set(['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed']);
const TOOL_LABELS = {
  read: 'قراءة', grep: 'بحث نصي', glob: 'بحث ملفات', edit: 'تحرير', write: 'كتابة', multiedit: 'تحرير متعدد',
};
const FAILURE_GUIDANCE = {
  timeout: 'ضيّق المهمة أو اختر مهلة أطول ثم أعد المحاولة من HEAD.',
  user_stopped: 'يمكنك مراجعة الإحصاءات ثم إعادة المحاولة بفريق جديد.',
  start_failed: 'تحقق من المحرك والمستودع ثم أعد المحاولة.',
  engine_failed: 'تحقق من توفر Claude وتسجيل الدخول، ثم أعد المحاولة.',
  policy_violation: 'راجع المهمة والملكية؛ لا توسّع السياسة لتجاوز الحارس.',
  worktree_violation: 'صحّح أي مسار مطلق أو خارج نسخة العمل ثم أعد المحاولة.',
  ownership_violation: 'وسّع الملكية صراحةً أو قسّم المهمة؛ لا تدمج الفرق المخالف.',
  artifact_capture_failed: 'تحقق من Git وحجم الفرق ثم أعد التنفيذ.',
  cleanup_failed: 'نظّف worktree المؤقت يدوياً قبل تشغيل فريق جديد.',
};

const ERROR_LABELS = {
  no_repo: 'المجلد ليس مستودع Git — افتح مستودعاً صالحاً ثم أعد المحاولة.',
  no_head: 'المستودع بلا HEAD — أنشئ أول commit ثم أعد المحاولة.',
  unsafe_links: 'المستودع يحوي رابطاً رمزياً أو submodule غير آمن — أزله أو افتح مشروعاً آمناً ثم أعد المحاولة.',
  busy: 'يوجد انتقال يعمل بالفعل — انتظر اكتماله أو أوقفه قبل بدء انتقال جديد.',
  ownership_overlap: 'تتداخل ملكيات عاملين — افصل أنماط الملفات بين العاملين ثم أعد المحاولة.',
  review_engine_unavailable: 'محرك المراجعة المستقل غير متاح — تحقق من توفر المحركات وتسجيل الدخول ثم أعد المراجعة؛ بقيت البوابة مغلقة.',
  ops_model_invalid: 'اسم النموذج المختار غير صالح — راجع منتقي نماذج غرفة العمليات أو اترك الحقل فارغاً لاستخدام الافتراضي.',
  verification_config_required: 'يلزم ملف .satr/verify.json صالح ومعتمد في HEAD — أضفه في مهمة مستقلة ثم أعد التحقق.',
  verification_config_changed: 'يمس الأثر سياسة التحقق؛ يلزم اعتمادها في مهمة مستقلة.',
  confirmation_required: 'يلزم تأكيد صريح — أعد المحاولة ووافق في نافذة التأكيد.',
  verification_prepare_required: 'يلزم تثبيت تحقق جديد للأثر الحالي — اختر «ثبّت التحقق» ثم شغّل الاختبارات.',
  review_not_approved: 'لم توافق كل المراجعات — عالج الملاحظات ثم أعد التنفيذ والمراجعة؛ لا يمكن تجاوز الحكم.',
  review_required: 'يلزم اكتمال المراجعات المستقلة وموافقتها — ابدأ المراجعة وعالج نتائجها أولاً.',
  review_artifact_mismatch: 'المراجعة تخص أثراً قديماً — أعد المراجعة للأثر الحالي.',
  verification_artifact_mismatch: 'التحقق يخص أثراً قديماً — ثبّت التحقق وشغّل الاختبارات للأثر الحالي.',
  verification_required: 'يلزم نجاح التحقق للأثر الحالي — شغّل الاختبارات المعتمدة وعالج أي فشل قبل الدمج.',
  preview_config_required: 'يلزم قسم preview صالح في .satr/verify.json المعتمد عند HEAD.',
  preview_timeout: 'لم تصبح المعاينة جاهزة ضمن المهلة المعتمدة — افحص أمر المعاينة ثم أعد المحاولة.',
  preview_exited: 'توقفت مهمة المعاينة قبل أن تصبح جاهزة — افحص أمر المعاينة ثم أعد المحاولة.',
  preview_failed: 'تعذّر تجهيز المعاينة التكاملية المعزولة — أعد المحاولة بعد فحص إعداد المعاينة.',
  dirty_worktree: 'شجرة المشروع غير نظيفة — احفظ (commit) أو تراجع عن تعديلاتك غير الملتزمة قبل الدمج.',
  head_changed: 'تغيّر HEAD منذ التنفيذ — أعد التنفيذ والمراجعة والتحقق على HEAD الحالي قبل الدمج.',
  conflict: 'يتعارض الأثر مع شجرة المشروع — أعد التنفيذ من HEAD الحالي ثم كرر المراجعة والتحقق.',
  apply_failed: 'تعذّر تطبيق الأثر بأمان ولم تُجرَ تغييرات جزئية — أعد التنفيذ من HEAD الحالي ثم كرر المراجعة والتحقق.',
  cleanup_failed: 'تعذّر تنظيف worktree — نظّفه يدوياً قبل بدء انتقال جديد؛ عُدّ المسار فاشلاً.',
  encryption_unavailable: 'التخزين المشفّر غير متاح على هذا النظام؛ لا يمكن استعادة الأثر بعد الإغلاق.',
  artifact_unavailable: 'تعذّر فتح الأثر المشفّر — أعد التنفيذ لإنشاء أثر جديد.',
  artifact_invalid: 'فشلت سلامة الأثر المحفوظ — احذف الأثر التالف وأعد التنفيذ.',
  artifact_mismatch: 'الأثر المحفوظ لا يخص هذه الغرفة أو هذا المشروع — افتح المشروع الأصلي ثم أعد الاستعادة.',
  not_available: 'هذا الانتقال غير متاح للحالة الحالية — أكمل الخطوة المقترحة في الغرفة أولاً.',
  not_found: 'لم يعد السجل أو الانتقال موجوداً — حدّث الغرفة ثم أعد المحاولة.',
  timeout_cap: 'بلغت المهلة سقف 10 دقائق ولا يمكن تمديدها — ضيّق المهمة ثم أعد التنفيذ.',
  brainstorm_engine_unavailable: 'محركا العصف المستقلان غير متاحين — تحقق من توفر Claude وCodex وتسجيل الدخول ثم أعد المحاولة.',
  planner_engine_unavailable: 'مخطط المهام عبر Claude غير متاح — تحقق من توفر Claude وتسجيل الدخول ثم أعد المحاولة.',
  review_skill_unavailable: 'مهارة المراجعة المضبوطة غير متاحة — افتح «إعداد التحقق» وأنشئ المهارة أو صحح اسمها، ثم أعد بدء الحلقة.',
  invalid_plan: 'لم يعد المخطط اقتراحاً بنيوياً صالحاً — وضّح المهمة وملكياتها ثم اطلب التقسيم من جديد.',
  secret_detected: 'حُجب الناتج لأنه قد يحتوي سراً — أزل الأسرار أو القيم الحساسة ثم أعد المحاولة.',
  forbidden_tool: 'أوقف المخطط طلب أداة غير مسموحة — أعد صياغة المهمة لتبقى قراءةً فقط ثم أعد المحاولة.',
  wrong_repo: 'الأثر يخص مستودعاً آخر — افتح المشروع الأصلي وأعد الانتقال هناك.',
  bad_artifact: 'بيانات الأثر غير صالحة — أعد التنفيذ لإنشاء أثر جديد.',
  status_failed: 'تعذّر فحص حالة Git — تحقق من عمل Git وصلاحيات المجلد ثم أعد الدمج.',
  storage_failed: 'تعذّر إنشاء ملف الأثر المؤقت — تحقق من مساحة القرص وصلاحيات مجلد التطبيق ثم أعد الدمج.',
  unsafe_path: 'حُجب مسار تخزين غير آمن — أعد تشغيل التطبيق ثم أعد المحاولة.',
  patch_too_large: 'حجم الأثر أكبر من حد الدمج — قسّم المهمة إلى آثار أصغر ثم أعد التنفيذ.',
  diff_too_large: 'حجم الفرق أكبر من حد المراجعة — قسّم المهمة إلى آثار أصغر ثم أعد التنفيذ.',
  worktree_failed: 'تعذّر إنشاء worktree للمخطط — تحقق من Git ونظافة المستودع ثم أعد المحاولة.',
  agent_start_failed: 'تعذّر بدء أحد العوامل — تحقق من توفر Claude ثم أعد المحاولة بفريق جديد.',
  text_too_large: 'النص أطول من الحد المسموح — اختصره ثم أعد المحاولة.',
  reference_mismatch: 'لم يعد القرار يخص الفريق أو الأثر الحالي — حدّث الغرفة ثم سجّل القرار من جديد.',
  file_limit: 'ملف الأثر المشفّر أكبر من الحد — قسّم المهمة إلى أثر أصغر ثم أعد التنفيذ.',
  persistence_failed: 'تعذّر حفظ الأثر المشفّر — تحقق من مساحة القرص وصلاحيات مجلد التطبيق ثم أعد التنفيذ.',
  remove_failed: 'تعذّر حذف الأثر المحفوظ — أغلق أي برنامج يستخدم الملف ثم أعد المحاولة.',
  not_running: 'لم يعد الانتقال جارياً — حدّث الغرفة قبل محاولة الإيقاف مجدداً.',
  bad_patch: 'ملف الأثر تالف أو غير صالح البنية — أعد التنفيذ لإنشاء أثر جديد.',
  read_failed: 'تعذّرت قراءة بيانات المستودع أو الأثر — تحقق من عمل Git وصلاحيات المجلد ثم أعد المحاولة.',
};

const BAD_INPUT_LABELS = {
  execution: 'تعذّر بدء التنفيذ — افتح مجلد مشروع صالحاً، واكتب مهمة وملكية ملفات لكل عامل.',
  review: 'تعذّر بدء المراجعة لأن بيانات الفريق أو الأثر لم تعد صالحة — حدّث الغرفة ثم أعد التنفيذ إن استمر الخطأ.',
  verification: 'تعذّر بدء التحقق لأن بيانات الفريق أو الأثر لم تعد صالحة — حدّث الغرفة ثم ثبّت التحقق من جديد.',
  merge: 'تعذّر الدمج لأن بيانات الفريق أو المراجعة لم تعد صالحة — حدّث الغرفة ثم أعد المراجعة والتحقق.',
  decision: 'تعذّر تسجيل القرار — اكتب قراراً موجزاً للغرفة والأثر الحاليين ثم أعد المحاولة.',
  brainstorm: 'تعذّر بدء العصف — افتح مجلد مشروع أولاً، ثم اكتب الموجز.',
  planner: 'تعذّر بدء التخطيط — افتح مجلد مشروع أولاً، ثم اكتب المهمة الكبيرة في حقل العامل الأول.',
  restore: 'تعذّرت استعادة الأثر — افتح مجلد المشروع الذي أُنشئ فيه الأثر ثم أعد المحاولة.',
  history: 'تعذّر تعديل الأثر المحفوظ — افتح مجلد المشروع الأصلي ثم أعد المحاولة.',
  timeout: 'تعذّر تمديد المهلة لأن بيانات الفريق لم تعد صالحة — حدّث الغرفة ثم أعد المحاولة.',
};

function errorLabel(result, context, fallback) {
  if (result == null) {
    return 'لم يصل رد من العملية الرئيسية (خطأ داخلي أو انقطاع) — أعد المحاولة، وإن تكرر أعد تشغيل التطبيق.';
  }
  const error = typeof result === 'string' ? result : result && result.error;
  if (error === 'bad_input') return BAD_INPUT_LABELS[context] || fallback;
  if (ERROR_LABELS[error]) return ERROR_LABELS[error];
  return error ? fallback + ' (الرمز التقني: ' + error + ')' : fallback;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function makeElement(tagName, className, label) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (label) element.textContent = label;
  return element;
}

function visibleLifecycleLabel(value, fallback) {
  const state = text(value);
  return Object.prototype.hasOwnProperty.call(LIFECYCLE_LABELS, state)
    ? lifecycleLabel(state) : (fallback || 'حالة غير معروفة');
}

function actorLabel(value) {
  const actor = text(value);
  if (ACTOR_LABELS[actor]) return ACTOR_LABELS[actor];
  if (actor === 'sdk' || actor === 'codex') return engineLabel(actor);
  return actor;
}

function fingerprintLabel(value) {
  const fingerprint = text(value);
  return /^[a-f0-9]{64}$/i.test(fingerprint) ? [...fingerprint].slice(0, 12).join('') : fingerprint;
}

function setMixedTechnicalText(container, value) {
  container.textContent = '';
  for (const part of text(value).split(TECHNICAL_PARTS).filter(Boolean)) {
    if (!TECHNICAL_PART.test(part)) {
      container.appendChild(document.createTextNode(part)); continue;
    }
    const code = document.createElement('code'); code.dir = 'ltr'; code.textContent = part;
    container.appendChild(code);
  }
}

function timeLabel(value) {
  const timestamp = Number(value);
  return timestamp > 0 ? new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(timestamp)) : 'وقت غير متاح';
}

function checkResultLabel(check) {
  const current = check || {};
  const exitLabel = text(current.exit_label).trim();
  if (exitLabel) return { value: exitLabel, technical: false };
  if (current.exit_code != null) return { value: 'exit=' + String(current.exit_code), technical: true };
  if (text(current.command)) return { value: current.command, technical: true };
  return { value: 'لم تتوفر نتيجة بعد', technical: false };
}

function mergeGateLabel(state, derived) {
  const current = state || {};
  if (derived.canMerge) return 'بوابة الدمج جاهزة؛ بقي التأكيد الصريح لتطبيق الأثر.';
  if (current.team && current.team.merged) return 'دُمج الأثر سابقاً ولا توجد خطوة دمج متبقية.';
  const remaining = [];
  if (!derived.reviewApproved) {
    const reviewState = current.review && current.review.state;
    if (!current.review) remaining.push('بدء المراجعات المستقلة');
    else if (reviewState === 'stopped') remaining.push('إعادة المراجعة للأثر نفسه');
    else if (reviewState === 'running') remaining.push('اكتمال المراجعات المستقلة');
    else remaining.push('موافقة المراجعات على الأثر الحالي');
  }
  if (!derived.verificationPassed) {
    const verification = current.verification;
    if (derived.reviewApproved && !verification) remaining.push('تثبيت تحقق الأثر الحالي');
    else if (verification && verification.state === 'pending_confirmation') remaining.push('تشغيل الاختبارات المعتمدة');
    else if (verification && verification.state === 'running') remaining.push('اكتمال التحقق التكاملي');
    else if (verification && verification.state === 'failed') remaining.push('معالجة فشل التحقق وإعادة تشغيله');
    else remaining.push('نجاح التحقق التكاملي للأثر الحالي');
  }
  return remaining.length ? 'بوابة الدمج مغلقة. المتبقي: ' + remaining.join('، ') + '.'
    : 'بوابة الدمج مغلقة حتى تكتمل الخطوة الحالية.';
}

function integerLabel(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function usdLabel(value) {
  return '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    .format(Number(value) || 0);
}

function engineLabel(value) {
  if (value === 'sdk') return 'Claude SDK';
  if (value === 'codex') return 'Codex';
  if (value === 'system') return 'النظام';
  if (value === 'user') return 'المستخدم';
  return value || '';
}

function reviewSections(summary, recommendation) {
  const sections = { risks: [], notes: [], recommendation: [] };
  const names = { المخاطر: 'risks', الملاحظات: 'notes', التوصية: 'recommendation' };
  let current = 'notes';
  for (const raw of text(summary).replace(/\[verdict:\s*(?:approve|changes_required|reject)\s*\]/ig, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const headingLine = line.replace(/^#{1,6}\s*/, '')
      .replace(/^\*\*(المخاطر|الملاحظات|التوصية)\s*:?\*\*\s*:?[ \t]*/, '$1: ');
    const heading = /^(المخاطر|الملاحظات|التوصية)\s*:?\s*(.*)$/.exec(headingLine);
    if (heading) {
      current = names[heading[1]];
      if (heading[2]) sections[current].push(heading[2].replace(/^[-*•]\s*/, ''));
      continue;
    }
    sections[current].push(line.replace(/^[-*•]\s*/, ''));
  }
  if (recommendation) sections.recommendation.push('عقد المراجع: ' + recommendation);
  return sections;
}

function reviewDecisionLabel(decision) {
  return decision ? visibleLifecycleLabel(decision, 'حكم غير معروف') : 'بلا حكم';
}

function reviewStateLabel(state) {
  return state ? visibleLifecycleLabel(state) : 'غير متاحة';
}

function truncatePoints(value, maximum, suffix) {
  const points = Array.from(text(value));
  if (points.length <= maximum) return points.join('');
  const tail = Array.from(suffix);
  return points.slice(0, Math.max(0, maximum - tail.length)).join('') + tail.join('');
}

function remainingLabel(deadline) {
  const seconds = Math.max(0, Math.ceil((Number(deadline) - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes + ':' + String(seconds % 60).padStart(2, '0');
}

function durationLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? hours + ':' + String(minutes).padStart(2, '0') + ':' + String(remainder).padStart(2, '0')
    : minutes + ':' + String(remainder).padStart(2, '0');
}

function activityLabel(activity) {
  if (!activity || activity.kind === 'waiting') return 'بانتظار أول نشاط أداة أو ملف قابل للرصد…';
  if (activity.kind === 'quiet') {
    return 'لم يصل نشاط أداة أو ملف قابل للرصد منذ ' + durationLabel(activity.elapsedMs) + '.';
  }
  if (activity.kind === 'recent') {
    return activity.elapsedMs < 5_000
      ? 'آخر نشاط أداة أو ملف قابل للرصد: الآن.'
      : 'آخر نشاط أداة أو ملف قابل للرصد منذ ' + durationLabel(activity.elapsedMs) + '.';
  }
  return '';
}

function syncActivityElement(element, agent, now) {
  const activity = deriveAgentActivity(agent, now);
  element.dataset.activity = activity.kind;
  element.textContent = activityLabel(activity);
  element.title = activity.lastActivityAt > 0 ? 'وقت آخر نشاط قابل للرصد: ' + timeLabel(activity.lastActivityAt) : '';
}

class SatrOpsDialog extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [controlsSheet, dialogSheet];
    const box = makeElement('div', 'dialog-box'); box.setAttribute('role', 'document');
    this._title = makeElement('h2');
    this._description = makeElement('div', 'description'); this._description.dir = 'auto';
    this._items = makeElement('div', 'items');
    const actions = makeElement('div', 'dialog-actions');
    this._cancel = makeElement('button', 'cancel', 'إلغاء'); this._cancel.type = 'button';
    this._confirm = makeElement('button', 'confirm', 'تأكيد'); this._confirm.type = 'button';
    actions.appendChild(this._cancel); actions.appendChild(this._confirm);
    box.appendChild(this._title); box.appendChild(this._description); box.appendChild(this._items);
    box.appendChild(actions); root.appendChild(box);
    this._resolver = null;
    this._confirm.addEventListener('click', () => this._answer(true));
    this._cancel.addEventListener('click', () => this._answer(false));
    root.addEventListener('keydown', (event) => this._trapFocus(event));
  }

  openDialog(options) {
    const data = options || {};
    if (this._resolver) this._answer(false);
    this._title.textContent = text(data.title) || 'تأكيد القرار';
    this._description.textContent = text(data.description);
    this._confirm.textContent = text(data.confirmLabel) || 'تأكيد';
    this._items.textContent = '';
    const items = Array.isArray(data.items) ? data.items.filter((item) => typeof item === 'string' && item) : [];
    this._items.hidden = !items.length;
    for (const item of items) {
      if (/^[a-f0-9]{64}$/i.test(item)) {
        const details = document.createElement('details'); details.className = 'item-details';
        const summary = document.createElement('summary'); summary.textContent = 'بصمة الأثر ';
        const prefix = document.createElement('bdi'); prefix.className = 'item'; prefix.textContent = fingerprintLabel(item);
        summary.appendChild(prefix);
        const full = document.createElement('div'); full.className = 'item'; full.textContent = item;
        details.appendChild(summary); details.appendChild(full); this._items.appendChild(details); continue;
      }
      const row = document.createElement('div');
      row.className = 'item'; row.textContent = item; this._items.appendChild(row);
    }
    this.setAttribute('open', '');
    queueMicrotask(() => this._cancel.focus());
    return new Promise((resolve) => { this._resolver = resolve; });
  }

  _trapFocus(event) {
    if (event.key !== 'Tab') return;
    const focusable = [this._cancel, this._confirm].filter((button) => !button.disabled && !button.hidden);
    const index = focusable.indexOf(this.shadowRoot.activeElement);
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length];
    event.preventDefault(); next.focus();
  }

  _answer(confirmed) {
    if (!this._resolver) return;
    const resolve = this._resolver; this._resolver = null;
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('ops-dialog-visible', { bubbles: true, detail: false }));
    resolve(confirmed === true);
  }
}

class SatrOpsRoom extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    this._layoutSheet = sheet(':host {}');
    root.adoptedStyleSheets = [panelSheet, cardSheet, diffSheet, roomSheet, this._layoutSheet];
    const head = makeElement('div', 'panel-head');
    const title = makeElement('span', 'panel-title', 'غرفة العمليات');
    const compactState = makeElement('span', 'compact-state'); compactState.setAttribute('aria-live', 'polite');
    const headActions = makeElement('div', 'panel-head-actions');
    const verifyConfigButton = makeElement('button', 'verify-config', 'إعداد التحقق'); verifyConfigButton.type = 'button';
    verifyConfigButton.disabled = true;
    const compactButton = makeElement('button', 'compact', 'طيّ'); compactButton.type = 'button';
    compactButton.setAttribute('aria-pressed', 'false');
    const closeButton = makeElement('button', 'close', '✕'); closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'إغلاق غرفة العمليات');
    headActions.appendChild(verifyConfigButton); headActions.appendChild(compactButton); headActions.appendChild(closeButton);
    head.appendChild(title); head.appendChild(compactState); head.appendChild(headActions);

    const actionBar = makeElement('div', 'action-bar');
    const nextStep = makeElement('div', 'next-step'); nextStep.setAttribute('aria-live', 'polite');
    const primaryButton = makeElement('button', 'primary-action'); primaryButton.type = 'button'; primaryButton.hidden = true;
    const previewButton = makeElement('button', 'preview-action', '🖥 شاهدها تعمل'); previewButton.type = 'button'; previewButton.hidden = true;
    const previewStopButton = makeElement('button', 'preview-stop', 'أوقف المعاينة'); previewStopButton.type = 'button'; previewStopButton.hidden = true;
    const primaryReason = makeElement('span', 'primary-reason'); primaryReason.hidden = true;
    primaryReason.setAttribute('aria-live', 'polite');
    actionBar.appendChild(nextStep); actionBar.appendChild(primaryReason); actionBar.appendChild(previewButton);
    actionBar.appendChild(previewStopButton); actionBar.appendChild(primaryButton);
    const guidedPath = makeElement('div', 'guided-path');
    const stationStrip = makeElement('nav', 'station-strip');
    stationStrip.setAttribute('aria-label', 'محطات غرفة العمليات');
    const moreWrap = makeElement('div', 'more-wrap');
    const moreButton = makeElement('button', 'more-toggle', 'المزيد ⌄'); moreButton.type = 'button';
    moreButton.setAttribute('aria-expanded', 'false'); moreButton.setAttribute('aria-haspopup', 'menu');
    const moreMenu = makeElement('div', 'more-menu'); moreMenu.hidden = true; moreMenu.setAttribute('role', 'menu');
    moreWrap.appendChild(moreButton); moreWrap.appendChild(moreMenu);
    guidedPath.appendChild(stationStrip); guidedPath.appendChild(moreWrap);
    const nav = makeElement('nav', 'room-nav'); nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'أقسام غرفة العمليات');
    const statusRow = makeElement('div', 'status-row');
    const status = makeElement('div', 'status'); status.setAttribute('aria-live', 'polite');
    const verifyConfigRecovery = makeElement('button', 'verify-config-recovery', 'افتح إعداد التحقق');
    verifyConfigRecovery.type = 'button'; verifyConfigRecovery.hidden = true;
    const stopButton = makeElement('button', 'stop', 'إيقاف المرحلة'); stopButton.type = 'button'; stopButton.hidden = true;
    statusRow.appendChild(status); statusRow.appendChild(verifyConfigRecovery); statusRow.appendChild(stopButton);
    const timeoutRow = makeElement('div', 'timeout-row'); timeoutRow.hidden = true;
    const timeoutWarning = makeElement('div', 'timeout-warning'); timeoutWarning.setAttribute('aria-live', 'polite');
    const extendButton = makeElement('button', 'extend', 'مدّد المهلة مرة'); extendButton.type = 'button';
    timeoutRow.appendChild(timeoutWarning); timeoutRow.appendChild(extendButton);
    const stationTitle = makeElement('div', 'station-title'); stationTitle.setAttribute('aria-live', 'polite');
    const list = makeElement('div', 'panel-list');
    const resizeHandle = makeElement('div', 'resize-handle'); resizeHandle.tabIndex = 0;
    resizeHandle.setAttribute('role', 'separator'); resizeHandle.setAttribute('aria-orientation', 'vertical');
    resizeHandle.setAttribute('aria-label', 'تغيير عرض غرفة العمليات؛ السهم الأيسر يوسّع والأيمن يضيّق');
    resizeHandle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End');
    for (const element of [head, guidedPath, nav, statusRow, timeoutRow, stationTitle, list, actionBar, resizeHandle]) {
      root.appendChild(element);
    }
    this._root = root;
    this._nav = nav;
    this._list = list;
    this._status = status;
    this._statusRow = statusRow;
    this._timeoutRow = timeoutRow;
    this._timeoutWarning = timeoutWarning;
    this._nextStep = nextStep;
    this._actionBar = actionBar;
    this._primaryButton = primaryButton;
    this._primaryReason = primaryReason;
    this._compactState = compactState;
    this._stationStrip = stationStrip;
    this._stationTitle = stationTitle;
    this._moreButton = moreButton;
    this._moreMenu = moreMenu;
    this._resizeHandle = resizeHandle;
    this._closeButton = closeButton;
    this._verifyConfigButton = verifyConfigButton;
    this._verifyConfigRecovery = verifyConfigRecovery;
    this._buttons = {
      primary: this._primaryButton, preview: previewButton, previewStop: previewStopButton,
      extend: extendButton, stop: stopButton,
    };
    this._state = createOpsRoomState();
    this._cwd = '';
    this._group = 'work';
    this._view = 'tasks';
    this._groupViews = { work: 'tasks', results: 'diffs', log: 'history' };
    this._groupSeen = { work: '', results: '', log: '' };
    this._currentStationKey = '';
    this._displayedStationKey = '';
    this._displayedMoreView = '';
    this._stationUserView = false;
    this._primaryAction = '';
    this._preferredCompact = false;
    this._preferredWidth = 0;
    this._resizeSession = null;
    this._history = [];
    this._brainstorm = null;
    this._brainstormDraft = '';
    this._plan = null;
    this._planDraft = '';
    this._models = { worker: '', sdk: '', codex: '' };
    this._appliedPlanId = '';
    this._notified = new Set();
    this._diffCache = new Map();
    this._clock = null;
    this._buildStations();
    this._buildMoreMenu();
    this._buildViews();
    closeButton.addEventListener('click', () => this.close());
    verifyConfigButton.addEventListener('click', () => this._openVerifyConfig());
    verifyConfigRecovery.addEventListener('click', () => this._openVerifyConfig());
    this._compactButton = compactButton;
    this._compactButton.addEventListener('click', () => this._toggleCompact());
    this._primaryButton.addEventListener('click', () => this._runPrimaryAction());
    this._buttons.preview.addEventListener('click', () => this._startPreview());
    this._buttons.previewStop.addEventListener('click', () => this._stopPreview());
    this._buttons.extend.addEventListener('click', () => this._extendTimeout());
    this._buttons.stop.addEventListener('click', () => this._stop());
    moreButton.addEventListener('click', () => this._toggleMoreMenu());
    resizeHandle.addEventListener('pointerdown', (event) => this._beginResize(event));
    resizeHandle.addEventListener('pointermove', (event) => this._moveResize(event));
    resizeHandle.addEventListener('pointerup', (event) => this._endResize(event));
    resizeHandle.addEventListener('pointercancel', (event) => this._endResize(event));
    resizeHandle.addEventListener('keydown', (event) => this._resizeWithKeyboard(event));
    this._drawerQuery = window.matchMedia(DRAWER_MEDIA);
    this._drawerQuery.addEventListener('change', () => this._syncResponsiveMode());
    window.addEventListener('resize', () => this._updateResizeAccessibility());
    this._syncResponsiveMode();
  }

  _buildStations() {
    this._stationButtons = {};
    for (const key of STATION_KEYS) {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.station = key;
      const marker = document.createElement('span'); marker.className = 'station-marker'; marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'station-label';
      button.appendChild(marker); button.appendChild(label);
      button.addEventListener('click', () => this._selectStation(key));
      this._stationStrip.appendChild(button); this._stationButtons[key] = { button, marker, label };
    }
  }

  _buildMoreMenu() {
    this._moreViewButtons = {};
    for (const [id, label] of MORE_VIEWS) {
      const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
      button.textContent = label; button.addEventListener('click', () => this._selectMoreView(id));
      this._moreMenu.appendChild(button); this._moreViewButtons[id] = button;
    }
  }

  _openVerifyConfig() {
    if (!this._cwd) return;
    this.dispatchEvent(new CustomEvent('verify-config-open', { bubbles: true, detail: { cwd: this._cwd } }));
  }

  _buildViews() {
    this._views = {};
    this._groups = {};
    this._groupButtons = {};
    this._groupBadges = {};
    this._subnavButtons = {};
    for (const group of GROUPS) {
      const button = document.createElement('button'); button.type = 'button'; button.role = 'tab';
      const label = document.createElement('span'); label.textContent = group.label; button.appendChild(label);
      const badge = document.createElement('span'); badge.className = 'group-badge'; badge.hidden = true;
      button.appendChild(badge); button.addEventListener('click', () => this._selectGroup(group.id));
      this._nav.appendChild(button); this._groupButtons[group.id] = button; this._groupBadges[group.id] = badge;

      const groupView = document.createElement('section'); groupView.className = 'group-view'; groupView.dataset.group = group.id;
      const subnav = document.createElement('nav'); subnav.className = 'subnav'; subnav.role = 'tablist';
      subnav.setAttribute('aria-label', 'تفاصيل قسم ' + group.label); groupView.appendChild(subnav);
      this._groups[group.id] = groupView; this._subnavButtons[group.id] = {};
      for (const [id, viewLabel] of group.views) {
        const subButton = document.createElement('button'); subButton.type = 'button'; subButton.role = 'tab';
        subButton.textContent = viewLabel; subButton.addEventListener('click', () => this._selectView(id));
        subnav.appendChild(subButton); this._subnavButtons[group.id][id] = subButton;
        const view = document.createElement('section'); view.className = 'view'; view.dataset.view = id;
        groupView.appendChild(view); this._views[id] = view;
      }
      this._list.appendChild(groupView);
    }
    this._updateNavigation();
  }

  _groupForView(id) {
    return GROUPS.find((group) => group.views.some(([viewId]) => viewId === id));
  }

  _show(id, persist = true) {
    const group = this._groupForView(id);
    if (!group || !this._views[id]) return false;
    this._group = group.id; this._view = id; this._groupViews[group.id] = id;
    this._updateNavigation(); this._markGroupSeen(group.id); this._renderGroupBadges();
    if (persist) this._saveLayoutPreferences();
    return true;
  }

  _selectGroup(id) {
    if (!this._groups[id]) return;
    this._group = id; this._view = this._groupViews[id];
    this._updateNavigation(); this._markGroupSeen(id); this._renderGroupBadges(); this._saveLayoutPreferences();
  }

  _selectView(id) {
    if (!this._show(id)) return;
    const stations = deriveStations(this._state);
    const current = stations.find((station) => station.current);
    const displayed = current && STATION_VIEWS[current.key] === id ? current
      : stations.find((station) => station.completed && STATION_VIEWS[station.key] === id);
    this._stationUserView = true;
    this._displayedStationKey = displayed ? displayed.key : '';
    this._displayedMoreView = MORE_VIEWS.some(([viewId]) => viewId === id) ? id : '';
    this._renderStations(stations, deriveOpsRoomState(this._state));
  }

  _toggleMoreMenu() {
    const open = this._moreMenu.hidden;
    this._moreMenu.hidden = !open;
    this._moreButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  _closeMoreMenu() {
    this._moreMenu.hidden = true;
    this._moreButton.setAttribute('aria-expanded', 'false');
  }

  _selectMoreView(id) {
    if (!MORE_VIEWS.some(([viewId]) => viewId === id) || !this._show(id)) return;
    this._stationUserView = true; this._displayedStationKey = ''; this._displayedMoreView = id;
    this._closeMoreMenu();
    this._renderStations(deriveStations(this._state), deriveOpsRoomState(this._state));
  }

  _selectStation(key) {
    const stations = deriveStations(this._state);
    const station = stations.find((item) => item.key === key);
    if (!station) return;
    if (!station.completed && !station.current) {
      const derived = deriveOpsRoomState(this._state);
      const guidance = key === 'merge' ? mergeGateLabel(this._state, derived)
        : text(derived.nextAction && derived.nextAction.label);
      setMixedTechnicalText(this._status, guidance);
      return;
    }
    this._stationUserView = true; this._displayedStationKey = key; this._displayedMoreView = '';
    this._show(STATION_VIEWS[key], false); this._closeMoreMenu();
    this._renderStations(stations, deriveOpsRoomState(this._state));
  }

  _syncStationView(stations) {
    const current = stations.find((station) => station.current) || stations[0];
    if (!current) return;
    if (current.key !== this._currentStationKey) {
      this._currentStationKey = current.key; this._stationUserView = false;
      this._displayedStationKey = current.key; this._displayedMoreView = '';
      this._show(STATION_VIEWS[current.key], false); this._closeMoreMenu();
    } else if (!this._stationUserView && !this._displayedStationKey) {
      this._displayedStationKey = current.key; this._displayedMoreView = '';
      this._show(STATION_VIEWS[current.key], false);
    }
  }

  _updateNavigation() {
    for (const group of GROUPS) {
      const activeGroup = group.id === this._group;
      this._groups[group.id].hidden = !activeGroup;
      this._groupButtons[group.id].setAttribute('aria-selected', activeGroup ? 'true' : 'false');
      const selectedView = this._groupViews[group.id];
      for (const [viewId] of group.views) {
        const activeView = viewId === selectedView;
        this._views[viewId].hidden = !activeView;
        this._subnavButtons[group.id][viewId].setAttribute('aria-selected', activeView ? 'true' : 'false');
      }
    }
  }

  _layoutStorageKey() {
    const project = this._cwd.trim().replace(/\//g, '\\').toLowerCase();
    return project ? LAYOUT_STORAGE_PREFIX + encodeURIComponent(project) : '';
  }

  _loadLayoutPreferences() {
    this._group = 'work'; this._view = 'tasks';
    this._groupViews = { work: 'tasks', results: 'diffs', log: 'history' };
    this._preferredCompact = false; this._preferredWidth = 0;
    this._layoutSheet.replaceSync(':host {}');
    let saved = null;
    const key = this._layoutStorageKey();
    try { if (key) saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    if (saved && typeof saved === 'object') {
      if (this._groups[saved.group]) this._group = saved.group;
      for (const group of GROUPS) {
        const selected = saved.views && saved.views[group.id];
        if (group.views.some(([viewId]) => viewId === selected)) this._groupViews[group.id] = selected;
      }
      this._view = this._groupViews[this._group];
      this._preferredCompact = saved.compact === true;
      if (Number.isFinite(saved.width) && saved.width > 0) {
        const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const width = Math.round(Math.min(rootFont * 60, Math.max(rootFont * 22, saved.width)));
        this._preferredWidth = width;
        this._layoutSheet.replaceSync(':host { --ops-room-width: ' + width + 'px; }');
      }
    } else {
      try { this._preferredCompact = localStorage.getItem('satr_ops_compact') === '1'; } catch {}
    }
    this._updateNavigation(); this._syncResponsiveMode();
  }

  _saveLayoutPreferences() {
    const key = this._layoutStorageKey();
    if (!key) return;
    const payload = {
      compact: this._preferredCompact === true,
      width: this._preferredWidth || 0,
      group: this._group,
      views: { ...this._groupViews },
    };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch {}
  }

  _modelStorageKey() {
    return this._cwd ? MODEL_STORAGE_PREFIX + this._cwd : '';
  }

  _loadModelPreferences() {
    let saved = null;
    const key = this._modelStorageKey();
    try { if (key) saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    this._models = {
      worker: text(saved && saved.worker),
      sdk: text(saved && saved.sdk),
      codex: text(saved && saved.codex),
    };
  }

  _saveModelPreferences() {
    const key = this._modelStorageKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(this._models)); } catch {}
  }

  _modelOverrides(names) {
    const models = {};
    for (const name of names) {
      const value = text(this._models[name]).trim();
      if (value) models[name] = value;
    }
    return Object.keys(models).length ? models : null;
  }

  _supportsModels(method, arity) {
    return typeof method === 'function' && method.length >= arity;
  }

  _syncResponsiveMode() {
    const drawer = !!(this._drawerQuery && this._drawerQuery.matches);
    this.toggleAttribute('drawer', drawer);
    if (drawer) {
      this.setAttribute('role', 'dialog'); this.setAttribute('aria-modal', 'true');
    } else {
      this.removeAttribute('role'); this.removeAttribute('aria-modal');
    }
    this._applyCompactState(!drawer && this._preferredCompact);
    if (drawer && this._root.activeElement === this._compactButton) queueMicrotask(() => this._closeButton.focus());
    this._updateResizeAccessibility();
  }

  _resizeBounds() {
    const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const viewportLimit = window.innerWidth * 0.94;
    const minimum = Math.min(rootFont * 22, viewportLimit);
    const maximum = Math.max(minimum, Math.min(rootFont * 60, viewportLimit));
    return { minimum, maximum };
  }

  _updateResizeAccessibility() {
    if (!this._resizeHandle) return;
    const bounds = this._resizeBounds();
    const current = Math.min(bounds.maximum, Math.max(bounds.minimum, this.getBoundingClientRect().width || bounds.minimum));
    const unavailable = this.hasAttribute('compact') || this.hasAttribute('drawer');
    this._resizeHandle.tabIndex = unavailable ? -1 : 0;
    this._resizeHandle.setAttribute('aria-valuemin', String(Math.round(bounds.minimum)));
    this._resizeHandle.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
    this._resizeHandle.setAttribute('aria-valuenow', String(Math.round(current)));
    this._resizeHandle.setAttribute('aria-valuetext', 'عرض اللوحة ' + Math.round(current) + ' بكسل');
  }

  _setRoomWidth(value, persist) {
    const width = Number(value);
    if (!Number.isFinite(width)) return;
    const bounds = this._resizeBounds();
    const clamped = Math.round(Math.min(bounds.maximum, Math.max(bounds.minimum, width)));
    this._preferredWidth = clamped;
    this._layoutSheet.replaceSync(':host { --ops-room-width: ' + clamped + 'px; }');
    this._updateResizeAccessibility();
    if (persist !== false) this._saveLayoutPreferences();
  }

  _beginResize(event) {
    if (event.button !== 0 || this.hasAttribute('compact') || this.hasAttribute('drawer')) return;
    event.preventDefault();
    this._resizeSession = {
      pointerId: event.pointerId, startX: event.clientX, startWidth: this.getBoundingClientRect().width,
    };
    this._resizeHandle.setPointerCapture(event.pointerId);
    this._resizeHandle.setAttribute('data-active', 'true');
  }

  _moveResize(event) {
    const session = this._resizeSession;
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    this._setRoomWidth(session.startWidth + session.startX - event.clientX, false);
  }

  _endResize(event) {
    const session = this._resizeSession;
    if (!session || event.pointerId !== session.pointerId) return;
    this._resizeSession = null; this._resizeHandle.removeAttribute('data-active');
    if (this._resizeHandle.hasPointerCapture(event.pointerId)) this._resizeHandle.releasePointerCapture(event.pointerId);
    this._saveLayoutPreferences(); this._updateResizeAccessibility();
  }

  _resizeWithKeyboard(event) {
    if (this.hasAttribute('compact') || this.hasAttribute('drawer')) return;
    const bounds = this._resizeBounds();
    const current = this.getBoundingClientRect().width;
    const step = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-6')) || 1;
    let next = null;
    if (event.key === 'ArrowLeft') next = current + step;
    else if (event.key === 'ArrowRight') next = current - step;
    else if (event.key === 'Home') next = bounds.minimum;
    else if (event.key === 'End') next = bounds.maximum;
    if (next == null) return;
    event.preventDefault(); this._setRoomWidth(next, true);
  }

  _dispatch(action) {
    const previousArtifact = this._state.team && this._state.team.artifact_id;
    this._state = opsRoomReducer(this._state, action);
    const nextArtifact = this._state.team && this._state.team.artifact_id;
    if (previousArtifact !== nextArtifact) this._diffCache.clear();
    this._render();
    if ((action.type === 'settled' || action.type === 'status') && text(action.status)) {
      this.dispatchEvent(new CustomEvent('ops-notice', { bubbles: true, detail: action.status }));
    }
  }

  _empty(container, message) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = message;
    container.appendChild(empty);
  }

  _card(options) {
    const data = options || {};
    const artifact = text(data.artifact);
    const hasFingerprintDetails = /^[a-f0-9]{64}$/i.test(artifact);
    const card = document.createElement('article');
    card.className = 'work-card'; card.dataset.state = text(data.state);
    const head = document.createElement('div'); head.className = 'work-card-head';
    const title = document.createElement('div'); title.className = 'work-card-title'; title.textContent = text(data.title);
    const state = document.createElement('div'); state.className = 'work-card-state';
    state.textContent = text(data.stateLabel) || visibleLifecycleLabel(data.state);
    head.appendChild(title); head.appendChild(state);
    let body = null;
    if (typeof data.body === 'function' || hasFingerprintDetails) {
      const toggle = document.createElement('button');
      toggle.className = 'work-card-toggle'; toggle.type = 'button'; toggle.textContent = 'التفاصيل';
      toggle.setAttribute('aria-expanded', 'false');
      head.appendChild(toggle);
      body = document.createElement('div'); body.className = 'work-card-body'; body.hidden = true;
      if (typeof data.body === 'function') data.body(body);
      if (hasFingerprintDetails) {
        const artifactRow = document.createElement('div'); artifactRow.className = 'agent-meta';
        const artifactTitle = document.createElement('span'); artifactTitle.textContent = 'بصمة الأثر الكاملة';
        const artifactValue = document.createElement('bdi'); artifactValue.className = 'artifact';
        artifactValue.textContent = artifact; artifactRow.appendChild(artifactTitle); artifactRow.appendChild(artifactValue);
        body.appendChild(artifactRow);
      }
      toggle.addEventListener('click', () => {
        body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      });
    }
    card.appendChild(head);
    const summary = document.createElement('div'); summary.className = 'work-card-summary';
    summary.dir = 'auto'; summary.textContent = text(data.summary) || 'لا توجد خلاصة إضافية.'; card.appendChild(summary);
    if (body) card.appendChild(body);
    const foot = document.createElement('div'); foot.className = 'work-card-foot';
    const values = [];
    if (text(data.actor)) values.push(['الفاعل', actorLabel(data.actor), false]);
    if (text(data.engine)) values.push(['المحرك', engineLabel(data.engine), false]);
    if (artifact) values.push(['الأثر', fingerprintLabel(artifact), true]);
    if (Number(data.time) > 0) values.push(['الوقت', timeLabel(data.time), true]);
    for (const [label, value, technical] of values) {
      const item = document.createElement('span'); item.textContent = label + ': ';
      const content = document.createElement('bdi'); content.textContent = value;
      if (technical) { content.className = 'work-card-tech'; content.dir = 'ltr'; }
      item.appendChild(content); foot.appendChild(item);
    }
    if (values.length) card.appendChild(foot);
    return card;
  }

  _setupCard(template) {
    const previous = template && Array.isArray(template.agents) ? template.agents : [];
    const setup = document.createElement('section'); setup.className = 'setup';
    const head = document.createElement('div'); head.className = 'setup-head';
    const title = document.createElement('strong'); title.textContent = previous.length ? 'إعادة المحاولة بفريق جديد' : 'فريق تنفيذ جديد';
    const countWrap = document.createElement('label'); countWrap.className = 'setup-field';
    const countLabel = document.createElement('span'); countLabel.textContent = 'عدد العوامل';
    const count = document.createElement('select'); count.setAttribute('aria-label', 'عدد عوامل التنفيذ');
    for (let value = 1; value <= 3; value++) {
      const option = document.createElement('option'); option.value = String(value); option.textContent = String(value);
      if (value === (previous.length || 1)) option.selected = true; count.appendChild(option);
    }
    countWrap.appendChild(countLabel); countWrap.appendChild(count);
    const timeoutWrap = document.createElement('label'); timeoutWrap.className = 'setup-field';
    const timeoutLabel = document.createElement('span'); timeoutLabel.textContent = 'مهلة كل عامل';
    const timeout = document.createElement('select'); timeout.setAttribute('aria-label', 'مهلة كل عامل');
    for (const [seconds, label] of [[180, '3 دقائق'], [300, '5 دقائق'], [600, '10 دقائق']]) {
      const option = document.createElement('option'); option.value = String(seconds); option.textContent = label;
      if (seconds === Math.round((Number(template && template.timeout_ms) || 300000) / 1000)) option.selected = true;
      timeout.appendChild(option);
    }
    timeoutWrap.appendChild(timeoutLabel); timeoutWrap.appendChild(timeout);
    const fields = document.createElement('div'); fields.className = 'setup-fields';
    fields.appendChild(countWrap); fields.appendChild(timeoutWrap);
    head.appendChild(title); head.appendChild(fields); setup.appendChild(head);
    // الحلقة ومنتقيات النماذج إعدادات متقدمة تُضبط نادراً، وكانت معروضة كلها قبل
    // أن يكتب المستخدم حرفاً فتزحم أول ما يراه. تُطوى خلف زر، ويُحفظ فتحها لمن
    // يعتمد عليها. لا تتغيّر قيمها ولا عقودها — الطيّ عرضٌ فقط.
    const advanced = document.createElement('section'); advanced.className = 'setup-advanced';
    const advancedToggle = document.createElement('button');
    advancedToggle.type = 'button'; advancedToggle.className = 'setup-advanced-toggle';
    advancedToggle.setAttribute('aria-expanded', 'false');
    advancedToggle.textContent = '⌄ إعدادات متقدمة — الحلقة المحدودة ونماذج العامل والمراجعين';
    const advancedBody = document.createElement('div');
    advancedBody.className = 'setup-advanced-body'; advancedBody.hidden = true;
    let advancedOpen = false;
    try { advancedOpen = localStorage.getItem('satr_ops_advanced') === '1'; } catch {}
    const syncAdvanced = () => {
      advancedBody.hidden = !advancedOpen;
      advancedToggle.setAttribute('aria-expanded', String(advancedOpen));
      advancedToggle.classList.toggle('open', advancedOpen);
    };
    advancedToggle.addEventListener('click', () => {
      advancedOpen = !advancedOpen;
      try { localStorage.setItem('satr_ops_advanced', advancedOpen ? '1' : '0'); } catch {}
      syncAdvanced();
    });
    advanced.appendChild(advancedToggle); advanced.appendChild(advancedBody);
    const loopOptions = document.createElement('section'); loopOptions.className = 'loop-options';
    const loopToggle = document.createElement('label'); loopToggle.className = 'loop-toggle';
    const loopMode = document.createElement('input'); loopMode.type = 'checkbox';
    loopMode.setAttribute('aria-label', 'تشغيل حلقة محدودة');
    const loopLabel = document.createElement('span'); loopLabel.textContent = '🔁 حلقة محدودة';
    loopToggle.appendChild(loopMode); loopToggle.appendChild(loopLabel); loopOptions.appendChild(loopToggle);
    const loopFields = document.createElement('div'); loopFields.className = 'loop-fields'; loopFields.hidden = true;
    const iterationWrap = document.createElement('label'); iterationWrap.className = 'setup-field';
    const iterationLabel = document.createElement('span'); iterationLabel.textContent = 'الحد الأقصى للدورات';
    const maxIterations = document.createElement('input'); maxIterations.type = 'number';
    maxIterations.min = '1'; maxIterations.max = '5'; maxIterations.step = '1'; maxIterations.value = '3';
    maxIterations.setAttribute('aria-label', 'الحد الأقصى لدورات الحلقة');
    iterationWrap.appendChild(iterationLabel); iterationWrap.appendChild(maxIterations);
    const budgetWrap = document.createElement('label'); budgetWrap.className = 'setup-field';
    const budgetLabel = document.createElement('span'); budgetLabel.textContent = 'ميزانية الرموز التقديرية';
    const budgetTokens = document.createElement('input'); budgetTokens.type = 'number';
    budgetTokens.min = '50000'; budgetTokens.max = '2000000'; budgetTokens.step = '50000'; budgetTokens.value = '400000';
    budgetTokens.setAttribute('aria-label', 'ميزانية رموز الحلقة');
    budgetWrap.appendChild(budgetLabel); budgetWrap.appendChild(budgetTokens);
    loopFields.appendChild(iterationWrap); loopFields.appendChild(budgetWrap); loopOptions.appendChild(loopFields);
    advancedBody.appendChild(loopOptions);
    const modelFields = document.createElement('section'); modelFields.className = 'model-fields';
    const modelInputs = {};
    for (const [name, label, className] of [
      ['worker', 'نموذج العامل', 'worker-model'],
      ['sdk', 'مراجع Claude', 'sdk-review-model'],
      ['codex', 'مراجع Codex', 'codex-review-model'],
    ]) {
      const wrap = document.createElement('label'); wrap.className = 'setup-field';
      const fieldLabel = document.createElement('span'); fieldLabel.textContent = label;
      const input = document.createElement('input'); input.type = 'text';
      input.className = 'model-input ' + className; input.dir = 'ltr';
      input.value = text(this._models[name]); input.placeholder = 'الافتراضي';
      input.setAttribute('aria-label', label);
      wrap.appendChild(fieldLabel); wrap.appendChild(input); modelFields.appendChild(wrap);
      modelInputs[name] = input;
    }
    const judgeWarning = document.createElement('div'); judgeWarning.className = 'judge-model-warning';
    judgeWarning.textContent = 'عقدة القاضي أخطر مكان للتوفير — نموذج ضعيف هنا يُصلح ما ليس مكسوراً ويكلّف أكثر مما يوفّر';
    judgeWarning.setAttribute('role', 'status'); modelFields.appendChild(judgeWarning);
    const syncJudgeWarning = () => {
      judgeWarning.hidden = !WEAK_JUDGE_MODEL.test(modelInputs.sdk.value) && !WEAK_JUDGE_MODEL.test(modelInputs.codex.value);
    };
    for (const [name, input] of Object.entries(modelInputs)) {
      input.addEventListener('input', () => {
        this._models[name] = input.value;
        this._saveModelPreferences();
        syncJudgeWarning();
      });
    }
    syncJudgeWarning();
    advancedBody.appendChild(modelFields);
    syncAdvanced(); setup.appendChild(advanced);
    const note = document.createElement('div'); note.className = 'setup-note';
    note.textContent = 'المسار الافتراضي بعامل واحد: تنفيذ معزول ← مراجعة ← تحقق ← شاهدها تعمل ← دمج. الفريق من عاملين أو ثلاثة خيار متقدم للمهام ذات الملكيات المنفصلة.';
    const planRow = document.createElement('div'); planRow.className = 'setup-actions';
    const planButton = document.createElement('button'); planButton.type = 'button';
    const planRunning = this._plan && this._plan.state === 'running';
    planButton.textContent = planRunning ? 'أوقف التخطيط' : 'اقترح تقسيم المهمة';
    planButton.addEventListener('click', () => planRunning ? this._stopPlan() : this._startPlan());
    planRow.appendChild(planButton);
    const planHint = document.createElement('span'); planHint.className = 'setup-note'; planRow.appendChild(planHint);
    if (this._plan) {
      const planStatus = document.createElement('span'); planStatus.className = 'setup-note';
      planStatus.textContent = this._plan.state === 'completed' ? 'اقتراح منقّى جاهز للمراجعة قبل التنفيذ.'
        : this._plan.state === 'running' ? 'يفحص Claude بنية المشروع قراءةً فقط…'
          : errorLabel(this._plan.error, 'planner', 'لم يكتمل اقتراح التقسيم — وضّح المهمة ثم أعد المحاولة.');
      planRow.appendChild(planStatus);
    }
    const inputs = [];
    for (let index = 1; index <= 3; index++) {
      const worker = document.createElement('section'); worker.className = 'worker-input'; worker.hidden = index > (previous.length || 1);
      const workerTitle = document.createElement('div'); workerTitle.className = 'worker-title'; workerTitle.textContent = 'عامل ' + index;
      const taskWrap = document.createElement('label'); taskWrap.className = 'setup-field';
      const taskLabel = document.createElement('span'); taskLabel.textContent = 'المهمة';
      const task = document.createElement('textarea'); task.className = 'task'; task.maxLength = 4000;
      task.placeholder = 'مهمة العامل ' + index + '…'; task.setAttribute('aria-label', 'مهمة العامل ' + index);
      taskWrap.appendChild(taskLabel); taskWrap.appendChild(task);
      const ownershipWrap = document.createElement('label'); ownershipWrap.className = 'setup-field';
      const ownershipLabel = document.createElement('span'); ownershipLabel.textContent = 'ملكية الملفات';
      const ownership = document.createElement('textarea'); ownership.className = 'ownership'; ownership.maxLength = 2048;
      ownership.placeholder = 'src/area/**, tests/area/**'; ownership.setAttribute('aria-label', 'ملكية العامل ' + index);
      ownershipWrap.appendChild(ownershipLabel); ownershipWrap.appendChild(ownership);
      if (previous[index - 1]) {
        task.value = text(previous[index - 1].task);
        ownership.value = Array.isArray(previous[index - 1].ownership) ? previous[index - 1].ownership.join(', ') : '';
      } else if (index === 1 && this._planDraft) {
        task.value = this._planDraft;
      }
      task.addEventListener('input', () => {
        if (index === 1) this._planDraft = task.value;
        this._syncSetupActions();
      });
      ownership.addEventListener('input', () => this._syncSetupActions());
      worker.appendChild(workerTitle); worker.appendChild(taskWrap); worker.appendChild(ownershipWrap);
      setup.appendChild(worker); inputs.push(worker);
    }
    setup.appendChild(note); setup.appendChild(planRow);
    const syncLoopOptions = () => {
      const singleWorker = Number(count.value) === 1;
      if (!singleWorker) loopMode.checked = false;
      loopMode.disabled = !singleWorker;
      loopMode.title = singleWorker ? '' : 'الحلقة المحدودة تعمل بعامل واحد فقط.';
      loopFields.hidden = !loopMode.checked;
      maxIterations.disabled = !loopMode.checked;
      budgetTokens.disabled = !loopMode.checked;
      timeoutLabel.textContent = loopMode.checked ? 'مهلة كل دورة' : 'مهلة كل عامل';
      timeout.setAttribute('aria-label', loopMode.checked ? 'مهلة كل دورة' : 'مهلة كل عامل');
    };
    loopMode.addEventListener('change', () => { syncLoopOptions(); this._syncSetupActions(); });
    count.addEventListener('change', () => {
      inputs.forEach((worker, index) => { worker.hidden = index >= Number(count.value); });
      syncLoopOptions();
      this._syncSetupActions();
    });
    this._setup = {
      count, timeout, inputs, planButton, planHint, loopMode, loopFields, maxIterations, budgetTokens, modelInputs,
    };
    syncLoopOptions();
    this._syncSetupActions();
    return setup;
  }

  _syncSetupActions() {
    const derived = deriveOpsRoomState(this._state);
    const count = this._setup ? Number(this._setup.count.value) || 1 : 0;
    const incomplete = this._setup ? this._setup.inputs.slice(0, count).some((worker) => {
      const task = worker.querySelector('.task').value.trim();
      const ownership = worker.querySelector('.ownership').value.split(/[,\r\n]+/).some((item) => item.trim());
      return !task || !ownership;
    }) : true;
    let primaryReason = '';
    if (this._primaryAction === 'start') {
      this._primaryButton.disabled = !derived.canStart || !this._cwd || incomplete;
      primaryReason = !this._cwd ? 'افتح مجلد مشروع أولاً.'
        : incomplete ? 'اكتب مهمة وملكية ملفات لكل عامل.' : '';
      this._primaryButton.title = primaryReason;
      // إرشاد واحد: المانع الحاجب يفوز، وإلا يعود نص الخطوة التالية من nextAction —
      // الإخفاء الكلي كان يدهس إرشاد التعافي (انتهاء المهلة/ما بعد الدمج).
      this._nextStep.textContent = primaryReason
        || text(derived.nextAction && derived.nextAction.label);
      this._nextStep.hidden = !this._nextStep.textContent;
      this._primaryReason.textContent = ''; this._primaryReason.hidden = true;
      this._actionBar.toggleAttribute('data-attention', Boolean(primaryReason));
    }
    if (!this._setup) return;
    const planRunning = this._plan && this._plan.state === 'running';
    const missingTask = !this._setup.inputs[0].querySelector('.task').value.trim();
    const planHint = primaryReason ? '' : !this._cwd ? 'افتح مجلد مشروع لتشغيل المخطط.'
      : missingTask ? 'اكتب المهمة الكبيرة في حقل العامل الأول.' : '';
    this._setup.planButton.disabled = !planRunning && Boolean(planHint);
    this._setup.planButton.title = planHint;
    this._setup.planHint.textContent = planRunning ? '' : planHint;
    this._setup.planHint.hidden = planRunning || !planHint;
  }

  _renderDecisions() {
    const view = this._views.decisions; view.textContent = '';
    if (this._state.team && this._state.room) {
      const box = document.createElement('div'); box.className = 'decision-box';
      const input = document.createElement('textarea'); input.maxLength = 1000;
      input.placeholder = 'قرار موجز يخص المهمة أو الأثر الحالي…'; input.setAttribute('aria-label', 'نص القرار');
      const action = document.createElement('button'); action.type = 'button'; action.textContent = 'سجّل القرار';
      const syncAction = () => {
        action.disabled = !input.value.trim();
        action.title = action.disabled ? 'اكتب قراراً موجزاً أولاً.' : '';
      };
      input.addEventListener('input', syncAction); syncAction();
      action.addEventListener('click', () => this._recordDecision(input));
      box.appendChild(input); box.appendChild(action); view.appendChild(box);
    }
    const entries = this._state.entries.filter((entry) => entry.type === 'decision');
    for (const entry of entries) view.appendChild(this._entryCard(entry));
    if (!entries.length && !this._state.team) this._empty(view, 'لا قرارات مسجلة بعد.');
  }

  _renderLoop(view, derived) {
    const loop = this._state.loop;
    if (!loop) return;
    const card = document.createElement('article'); card.className = 'setup loop-card';
    const head = document.createElement('div'); head.className = 'loop-head';
    const title = document.createElement('div'); title.className = 'loop-title'; title.textContent = 'حلقة محدودة — الدورة ';
    const iteration = document.createElement('bdi'); iteration.className = 'counts';
    iteration.textContent = integerLabel(loop.iteration) + '/' + integerLabel(loop.max_iterations);
    title.appendChild(iteration);
    const state = document.createElement('span'); state.className = 'loop-state';
    state.textContent = LOOP_STATES[loop.state] || visibleLifecycleLabel(loop.state);
    head.appendChild(title); head.appendChild(state); card.appendChild(head);
    const progress = document.createElement('progress'); progress.className = 'loop-progress';
    progress.max = Math.max(1, Number(loop.max_iterations) || 1);
    progress.value = Math.min(progress.max, Math.max(0, Number(loop.iteration) || 0));
    progress.setAttribute('aria-label', 'تقدم دورات الحلقة المحدودة'); card.appendChild(progress);
    if (loop.last_failure_summary) {
      const failure = document.createElement('div'); failure.className = 'loop-failure'; failure.dir = 'auto';
      failure.textContent = 'آخر فشل: ' + loop.last_failure_summary; card.appendChild(failure);
    }
    const loopReview = loop.review;
    if (loopReview && loopReview.configured === true) {
      const review = document.createElement('section'); review.className = 'loop-review';
      const reviewHead = document.createElement('div'); reviewHead.className = 'loop-review-head';
      const reviewTitle = document.createElement('span'); reviewTitle.className = 'loop-review-title';
      reviewTitle.textContent = 'المراجعة النوعية';
      const reviewState = document.createElement('span'); reviewState.className = 'loop-review-state';
      reviewState.dataset.state = loopReview.state || 'idle';
      reviewState.textContent = LOOP_REVIEW_STATES[loopReview.state] || 'بانتظار المراجع';
      reviewHead.appendChild(reviewTitle); reviewHead.appendChild(reviewState); review.appendChild(reviewHead);
      if (loopReview.summary) {
        const summary = document.createElement('p'); summary.className = 'loop-review-summary'; summary.dir = 'auto';
        summary.textContent = truncatePoints(loopReview.summary, 300, '…'); review.appendChild(summary);
      }
      card.appendChild(review);
    }
    const metrics = document.createElement('div'); metrics.className = 'loop-metrics';
    const cost = document.createElement('span'); cost.className = 'loop-metric'; cost.textContent = 'الكلفة (إدخال/إخراج) ';
    const costValue = document.createElement('bdi'); costValue.className = 'counts';
    const costEstimate = loop.cost && loop.cost.estimate ? ' · تقديري' : '';
    costValue.textContent = usdLabel(loop.cost && loop.cost.usd) + ' · '
      + integerLabel(loop.cost && loop.cost.input_tokens) + '/'
      + integerLabel(loop.cost && loop.cost.output_tokens);
    cost.appendChild(costValue);
    if (costEstimate) cost.appendChild(document.createTextNode(costEstimate));
    const budget = document.createElement('span'); budget.className = 'loop-metric'; budget.textContent = 'الميزانية (رمز) ';
    const budgetValue = document.createElement('bdi'); budgetValue.className = 'counts';
    const budgetEstimate = loop.budget && loop.budget.estimate ? ' · تقديري' : '';
    budgetValue.textContent = integerLabel(loop.budget && loop.budget.used_tokens) + '/'
      + integerLabel(loop.budget && loop.budget.limit_tokens);
    budget.appendChild(budgetValue);
    if (budgetEstimate) budget.appendChild(document.createTextNode(budgetEstimate));
    metrics.appendChild(cost); metrics.appendChild(budget); card.appendChild(metrics);
    if (derived.loopTerminal) {
      const guidance = document.createElement('div'); guidance.className = 'loop-guidance';
      const reason = LOOP_STOP_REASONS[loop.stop_reason] || LOOP_STATES[loop.state]
        || visibleLifecycleLabel(loop.state);
      guidance.textContent = 'سبب التوقف: ' + reason + '. ' + (loop.state === 'passed'
        ? 'راجع الأثر ثم امشِ بوابة الدمج كالمعتاد.'
        : 'راجع الأثر الجزئي وسجل الغرفة، ثم قرر الخطوة التالية عبر البوابات المعتادة.');
      card.appendChild(guidance);
    } else {
      const actions = document.createElement('div'); actions.className = 'loop-actions';
      const hint = document.createElement('span'); hint.className = 'setup-note';
      hint.textContent = 'الإيقاف يقاطع العامل ويحفظ الأثر الجزئي للمراجعة إن أمكن.';
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'loop-stop';
      stop.textContent = '⏹ أوقف الحلقة'; stop.disabled = Boolean(this._state.pending);
      stop.addEventListener('click', () => this._stopLoop(loop));
      actions.appendChild(hint); actions.appendChild(stop); card.appendChild(actions);
    }
    view.appendChild(card);
  }

  _renderTasks() {
    const view = this._views.tasks; view.textContent = '';
    this._setup = null;
    const derived = deriveOpsRoomState(this._state);
    const team = this._state.team;
    const template = team && INHERIT_TEMPLATE_TEAM_STATES.has(team.state) ? team : null;
    if (derived.canStart) view.appendChild(this._setupCard(template));
    else this._syncSetupActions();
    this._renderLoop(view, derived);
    if (!team) { if (!derived.canStart && !this._state.loop) this._empty(view, 'لا يوجد فريق تنفيذ.'); return; }
    for (const agent of team.agents || []) {
      const card = this._card({
        title: agent.label || 'عامل', state: agent.state,
        stateLabel: TEAM_STATES[agent.state] || visibleLifecycleLabel(agent.state),
        summary: agent.error || agent.summary || (agent.last_tool
          ? 'آخر نشاط آمن: ' + (TOOL_LABELS[agent.last_tool] || agent.last_tool) : 'ينفّذ داخل worktree معزول.'),
        actor: agent.label || agent.id,
        engine: agent.engine || 'sdk', artifact: team.artifact_id, time: team.updated_at,
        body: (body) => {
          const ownership = document.createElement('div'); ownership.className = 'agent-meta';
          const label = document.createElement('span'); label.textContent = 'الملكية';
          const value = document.createElement('span'); value.className = 'path'; value.textContent = (agent.ownership || []).join(', ');
          ownership.appendChild(label); ownership.appendChild(value); body.appendChild(ownership);
          const worktree = document.createElement('div'); worktree.className = 'agent-meta';
          worktree.textContent = agent.worktree ? 'نسخة العمل معزولة ونشطة وفق حالة العامل.' : 'لا توجد نسخة عمل نشطة.';
          body.appendChild(worktree);
        },
      });
      if (agent.failure_code && FAILURE_GUIDANCE[agent.failure_code]) {
        const recovery = document.createElement('div'); recovery.className = 'live-activity';
        recovery.textContent = 'التعافي المقترح: ' + FAILURE_GUIDANCE[agent.failure_code];
        card.querySelector('.work-card-summary').after(recovery);
      }
      if (!TERMINAL_AGENT_STATES.has(agent.state)) {
        const activity = document.createElement('div'); activity.className = 'live-activity';
        const tool = document.createElement('span');
        tool.textContent = agent.last_tool ? 'الأداة: ' + (TOOL_LABELS[agent.last_tool] || agent.last_tool) : 'بانتظار أول نشاط آمن…';
        activity.appendChild(tool);
        if (agent.last_file) {
          const file = document.createElement('span'); file.textContent = 'الملف: ';
          const path = document.createElement('bdi'); path.className = 'path'; path.textContent = agent.last_file;
          file.appendChild(path); activity.appendChild(file);
        }
        if (agent.deadline_at) {
          const remaining = document.createElement('span'); remaining.className = 'counts';
          remaining.dataset.deadline = String(agent.deadline_at); activity.appendChild(remaining);
        }
        const observable = document.createElement('span'); observable.className = 'observable-activity';
        observable.dataset.agentActivity = 'true';
        observable._opsAgent = agent; syncActivityElement(observable, agent, Date.now()); activity.appendChild(observable);
        const elapsed = document.createElement('span'); elapsed.className = 'observable-activity elapsed';
        elapsed.dataset.startedAt = String(Number(team.created_at) || Date.now());
        elapsed.textContent = 'المدة ' + durationLabel(Date.now() - Number(elapsed.dataset.startedAt));
        activity.appendChild(elapsed);
        const budget = document.createElement('span'); budget.className = 'counts';
        budget.textContent = 'كتابة ' + ((agent.permissions && agent.permissions.write_used) || 0) + '/'
          + ((agent.permissions && agent.permissions.write_limit) || 0);
        activity.appendChild(budget);
        card.querySelector('.work-card-summary').after(activity);
      }
      view.appendChild(card);
    }
    this._refreshCountdowns();
  }

  _renderDiscussion() {
    const view = this._views.discussion; view.textContent = '';
    const entries = this._state.entries.filter((entry) => entry.type === 'proposal' || entry.type === 'note');
    for (const entry of entries) view.appendChild(this._entryCard(entry));
    if (!entries.length) this._empty(view, 'لا نقاش مسجلاً؛ الغرفة لا تشغّل حلقة تلقائية بين العوامل.');
  }

  _renderEvidence() {
    const view = this._views.evidence; view.textContent = '';
    const verification = this._state.verification;
    if (verification) {
      view.appendChild(this._card({
        title: 'التحقق التكاملي', state: verification.state,
        stateLabel: visibleLifecycleLabel(verification.state),
        summary: verification.artifact_id === deriveOpsRoomState(this._state).artifactId
          ? 'نتيجة التحقق مرتبطة بالأثر الحالي.' : 'هذه النتيجة تخص أثراً قديماً ولا تفتح الدمج.',
        actor: 'system', engine: 'system', artifact: verification.artifact_id,
        time: this._state.team && this._state.team.updated_at,
        body: (body) => {
          for (const check of verification.checks || []) {
            const row = document.createElement('div'); row.className = 'check-row';
            const label = document.createElement('span'); label.textContent = check.label + ' [' + check.id + ']';
            const presented = checkResultLabel(check);
            const result = document.createElement('bdi'); result.className = presented.technical ? 'counts' : 'check-result';
            result.dir = presented.technical ? 'ltr' : 'auto';
            result.textContent = presented.value + (check.timed_out ? ' · ' + lifecycleLabel('timed_out') : '')
              + ' · ' + (check.duration_ms || 0) + 'ms';
            row.appendChild(label); row.appendChild(result); body.appendChild(row);
          }
        },
      }));
    }
    const entries = this._state.entries.filter((entry) => entry.type === 'verification');
    for (const entry of entries) view.appendChild(this._entryCard(entry));
    if (!verification && !entries.length) this._empty(view, 'لم تُثبّت اختبارات للأثر الحالي بعد.');
  }

  _renderDiffs() {
    const view = this._views.diffs; view.textContent = '';
    const team = this._state.team;
    const files = ((team && team.agents) || []).flatMap((agent) => {
      const changes = agent.changes || {};
      return (Array.isArray(changes.files) ? changes.files : []).map((file) => ({ file, agent }));
    });
    if (files.length) {
      const totals = files.reduce((value, item) => ({
        added: value.added + (Number(item.file.added) || 0),
        removed: value.removed + (Number(item.file.removed) || 0),
      }), { added: 0, removed: 0 });
      const summary = document.createElement('div'); summary.className = 'gate-summary';
      summary.textContent = 'سيُدمج ' + countLabel(files.length, FILE_COUNT_FORMS)
        + ': +' + totals.added + ' −' + totals.removed;
      view.appendChild(summary);
    }
    for (const agent of (team && team.agents) || []) {
      const changes = agent.changes || {};
      if (!Array.isArray(changes.files) || !changes.files.length) continue;
      view.appendChild(this._card({
        title: 'فروقات ' + (agent.label || agent.id), state: agent.state,
        stateLabel: countLabel(changes.files.length, FILE_COUNT_FORMS),
        summary: 'اختر ملفاً لعرض التغييرات التي تخصه ومراجعتها على حدة.',
        actor: agent.label || agent.id, engine: agent.engine || 'sdk', artifact: team.artifact_id, time: team.updated_at,
        body: (body) => {
          for (const file of changes.files) {
            const result = document.createElement('div');
            const row = document.createElement('button'); row.type = 'button'; row.className = 'file-row file-diff-request';
            const path = document.createElement('span'); path.className = 'path'; path.textContent = file.rel;
            const counts = document.createElement('span'); counts.className = 'counts';
            counts.textContent = '+' + (file.added || 0) + ' −' + (file.removed || 0);
            row.appendChild(path); row.appendChild(counts); body.appendChild(row); body.appendChild(result);
            const key = team.artifact_id + '\0' + file.rel;
            const cached = this._diffCache.get(key);
            if (cached && cached.ok) result.appendChild(buildDiff({ ...cached.diff, noUndo: true }));
            else if (cached) {
              result.className = 'file-diff-error'; result.textContent = 'تعذّر عرض فرق هذا الملف: ' + cached.error;
            }
            row.addEventListener('click', () => this._loadFileDiff(team.id, team.artifact_id, file, row, result));
          }
        },
      }));
    }
    if (!files.length) this._empty(view, 'لا توجد بيانات فروقات عامة بعد.');
  }

  async _loadFileDiff(teamId, artifactId, file, button, container) {
    const key = artifactId + '\0' + file.rel;
    if (this._diffCache.has(key) || button.disabled) return;
    button.disabled = true;
    const previous = button.title; button.title = 'جارٍ تحميل فرق الملف…';
    let result = null;
    try { result = await window.satr.executionFileDiff(teamId, artifactId, file.rel); } catch {}
    const stored = result && result.ok && result.diff ? result : { ok: false, error: result && result.error || 'diff_unavailable' };
    this._diffCache.set(key, stored);
    container.textContent = '';
    if (stored.ok) container.appendChild(buildDiff({ ...stored.diff, noUndo: true }));
    else {
      container.className = 'file-diff-error';
      container.textContent = stored.error === 'binary_diff' ? 'هذا ملف ثنائي ولا يتوفر له فرق نصي.' : 'تعذّر عرض فرق هذا الملف.';
    }
    button.disabled = false; button.title = previous;
  }

  _appendReviewSections(container, sections) {
    for (const [label, values] of [
      ['المخاطر', sections.risks], ['الملاحظات', sections.notes], ['التوصية', sections.recommendation],
    ]) {
      const section = document.createElement('section'); section.className = 'review-section';
      const title = document.createElement('h4'); title.textContent = label; section.appendChild(title);
      const list = document.createElement('ul');
      const items = values.length ? values : ['لم يذكر المراجع بنوداً مستقلة.'];
      for (const value of items) {
        const row = document.createElement('li'); row.dir = 'auto'; row.textContent = value; list.appendChild(row);
      }
      section.appendChild(list); container.appendChild(section);
    }
  }

  _repairTaskFromReport(report) {
    const items = Array.isArray(report && report.items) ? report.items : [];
    const important = items.filter((item) => item && (item.severity === 'critical' || item.severity === 'high'));
    const lines = important.map((item) => '- [' + item.severity + '] [' + (LENS_LABELS[item.lens] || item.lens || 'زاوية غير محددة')
      + '] [' + engineLabel(item.engine) + '] ' + text(item.text));
    const draft = 'أصلح ملاحظات هيئة القضاة الحرجة والمرتفعة التالية، ثم شغّل التحقق المناسب:\n\n'
      + (lines.length ? lines.join('\n') : 'لا توجد بنود حرجة أو مرتفعة في التقرير الحالي.');
    this.seedTask(truncatePoints(draft, 2000, '\n… [قُصّ ذيل الملاحظات]'));
  }

  _renderMergedReport(view, report) {
    const items = Array.isArray(report && report.items) ? report.items : [];
    if (!items.length) return;
    const card = document.createElement('article'); card.className = 'merged-report';
    const head = document.createElement('div'); head.className = 'merged-head';
    const title = document.createElement('strong'); title.className = 'merged-title'; title.textContent = 'تقرير هيئة القضاة المدموج';
    const counts = document.createElement('div'); counts.className = 'merged-counts';
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const count = document.createElement('span'); count.className = 'merged-count'; count.dataset.severity = severity;
      count.textContent = (SEVERITY_LABELS[severity] || severity) + ': ' + integerLabel(
        items.filter((item) => item && item.severity === severity).length,
      );
      counts.appendChild(count);
    }
    head.appendChild(title); head.appendChild(counts); card.appendChild(head);
    if (report.truncated === true) {
      const truncated = document.createElement('span'); truncated.className = 'merged-truncated';
      truncated.textContent = 'مقصوص'; card.appendChild(truncated);
    }
    const list = document.createElement('div'); list.className = 'merged-items';
    for (const item of items) {
      const row = document.createElement('section'); row.className = 'merged-item';
      row.dataset.severity = text(item && item.severity);
      const itemHead = document.createElement('div'); itemHead.className = 'merged-item-head';
      const severity = document.createElement('span'); severity.className = 'merged-severity';
      severity.dataset.severity = text(item && item.severity);
      severity.textContent = SEVERITY_LABELS[item && item.severity] || text(item && item.severity);
      const lens = document.createElement('span'); lens.className = 'merged-lens';
      lens.textContent = LENS_LABELS[item && item.lens] || text(item && item.lens) || 'زاوية غير محددة';
      const engine = document.createElement('bdi'); engine.className = 'merged-engine';
      engine.textContent = engineLabel(item && item.engine);
      itemHead.appendChild(severity); itemHead.appendChild(lens); itemHead.appendChild(engine);
      const content = document.createElement('div'); content.className = 'merged-text'; content.dir = 'auto';
      content.textContent = text(item && item.text);
      row.appendChild(itemHead); row.appendChild(content); list.appendChild(row);
    }
    card.appendChild(list);
    const repairable = items.some((item) => item
      && (item.severity === 'critical' || item.severity === 'high'));
    if (repairable) {
      const repair = document.createElement('button'); repair.type = 'button'; repair.className = 'merged-repair';
      repair.textContent = '🔧 أصلح بالملاحظات';
      repair.addEventListener('click', () => this._repairTaskFromReport(report));
      card.appendChild(repair);
    }
    view.appendChild(card);
  }

  _renderReview() {
    const view = this._views.review; view.textContent = '';
    const derived = deriveOpsRoomState(this._state);
    const review = this._state.review;
    const reviewStopped = !!(review && review.state === 'stopped');
    if (!reviewStopped) this._renderMergedReport(view, review && review.merged_report);
    for (const item of (review && review.reviews) || []) {
      const decision = reviewStopped ? '' : item.verdict && item.verdict.decision;
      const sections = reviewSections(item.summary, item.recommendation);
      view.appendChild(this._card({
        title: 'مراجعة ' + engineLabel(item.engine), state: reviewStopped ? 'stopped' : decision || item.state,
        stateLabel: reviewStopped ? 'أوقفها المستخدم قبل اكتمال الأحكام'
          : decision ? reviewDecisionLabel(decision) : reviewStateLabel(item.state),
        summary: reviewStopped ? 'أوقفها المستخدم قبل اكتمال الأحكام؛ يمكنك إعادة المراجعة للأثر نفسه.'
          : item.error || 'حكم مراجعة عمياء قراءة فقط؛ افتح التفاصيل لرؤية المخاطر والملاحظات والتوصية.',
        actor: 'reviewer',
        engine: item.engine, artifact: item.artifact_id, time: item.updated_at,
        body: (body) => {
          if (Array.isArray(item.lenses)) {
            const lenses = document.createElement('div'); lenses.className = 'review-lenses';
            for (const lens of item.lenses) {
              const section = document.createElement('section'); section.className = 'review-lens';
              section.dataset.lens = text(lens && lens.lens);
              const head = document.createElement('div'); head.className = 'review-lens-head';
              const title = document.createElement('strong'); title.className = 'review-lens-title';
              title.textContent = LENS_LABELS[lens && lens.lens] || text(lens && lens.lens) || 'زاوية غير محددة';
              const state = document.createElement('span'); state.className = 'review-lens-state';
              state.textContent = reviewStateLabel(lens && lens.state);
              const verdict = document.createElement('span'); verdict.className = 'review-lens-verdict';
              if (!reviewStopped) verdict.textContent = reviewDecisionLabel(lens && lens.verdict && lens.verdict.decision);
              head.appendChild(title); head.appendChild(state);
              if (!reviewStopped) head.appendChild(verdict);
              section.appendChild(head);
              this._appendReviewSections(section, reviewSections(lens && lens.summary));
              lenses.appendChild(section);
            }
            body.appendChild(lenses);
          } else {
            this._appendReviewSections(body, sections);
          }
        },
      }));
    }
    const gate = document.createElement('div'); gate.className = 'gate-summary';
    gate.textContent = mergeGateLabel(this._state, derived);
    view.appendChild(gate);
    const entries = this._state.entries.filter((entry) => entry.type === 'review' || entry.type === 'phase_gate');
    for (const entry of entries) view.appendChild(this._entryCard(entry));
  }

  _entryCard(entry) {
    return this._card({
      title: entry.type === 'decision' ? 'قرار مستخدم' : entry.type === 'review' ? 'حدث مراجعة'
        : entry.type === 'verification' ? 'حدث تحقق' : entry.type === 'phase_gate' ? 'انتقال مرحلي' : 'ملاحظة تشغيلية',
      state: entry.type, stateLabel: ENTRY_TYPE_LABELS[entry.type] || 'حدث تشغيلي',
      summary: entry.text, actor: entry.actor,
      engine: entry.actor, artifact: entry.artifact_id, time: entry.created_at,
    });
  }

  _runPrimaryAction() {
    const derived = deriveOpsRoomState(this._state);
    const action = derived.nextAction && derived.nextAction.action;
    const config = PRIMARY_ACTIONS[action];
    if (!config || action !== this._primaryAction || derived[config.can] !== true || this._primaryButton.disabled) return;
    if (typeof this[config.method] === 'function') this[config.method]();
  }

  _renderPrimaryAction(derived) {
    const action = derived.nextAction && derived.nextAction.action;
    const key = derived.nextAction && derived.nextAction.key;
    const config = PRIMARY_ACTIONS[action];
    const available = !!(config && derived[config.can] === true);
    this._primaryAction = available ? action : '';
    this._actionBar.hidden = !text(derived.nextAction && derived.nextAction.label);
    this._nextStep.textContent = text(derived.nextAction && derived.nextAction.label);
    this._nextStep.hidden = !this._nextStep.textContent;
    this._actionBar.toggleAttribute('data-attention', !available && !['wait', 'merged'].includes(key));
    this._primaryButton.hidden = !available;
    this._primaryButton.disabled = !available;
    this._primaryButton.dataset.action = available ? action : '';
    this._primaryButton.textContent = key === 'merged' && available ? 'ابدأ مهمة جديدة'
      : action === 'start' && this._state.team ? 'ابدأ فريقاً جديداً'
      : available ? config.label : '';
    this._primaryButton.title = '';
    this._primaryReason.textContent = '';
    this._primaryReason.hidden = true;
    if (available && action !== 'start') this._primaryButton.disabled = false;
  }

  _stationLifecycleState(key) {
    if (key === 'setup') return this._state.team ? 'completed' : '';
    if (key === 'execute') return text(this._state.team && this._state.team.state);
    if (key === 'review') return text(this._state.review && this._state.review.state);
    if (key === 'verify') return text(this._state.verification && this._state.verification.state);
    if (key === 'merge') return this._state.team && this._state.team.merged ? 'completed' : '';
    return '';
  }

  _stationStatusLabel(station) {
    const lifecycleState = this._stationLifecycleState(station.key);
    const lifecycle = lifecycleState && Object.prototype.hasOwnProperty.call(LIFECYCLE_LABELS, lifecycleState)
      ? lifecycleLabel(lifecycleState) : '';
    if (station.alert) return lifecycle ? 'تحتاج الانتباه — ' + lifecycle : 'تحتاج الانتباه';
    if (lifecycle) return lifecycle;
    if (station.completed) return 'مكتملة';
    if (station.current) return 'الحالية';
    return 'لاحقة';
  }

  _renderStations(stations, derived) {
    for (const station of stations) {
      const parts = this._stationButtons[station.key];
      if (!parts) continue;
      const state = station.completed ? 'completed' : station.current ? 'current' : 'pending';
      const statusLabel = this._stationStatusLabel(station);
      parts.button.dataset.state = state;
      if (station.alert) parts.button.dataset.alert = 'true'; else delete parts.button.dataset.alert;
      if (station.current) parts.button.dataset.current = 'true'; else delete parts.button.dataset.current;
      if (station.key === this._displayedStationKey) parts.button.dataset.selected = 'true';
      else delete parts.button.dataset.selected;
      if (station.current) parts.button.setAttribute('aria-current', 'step');
      else parts.button.removeAttribute('aria-current');
      parts.button.setAttribute('aria-label', station.label + ' — ' + statusLabel);
      parts.marker.textContent = station.alert ? '⚠' : station.completed ? '✓' : station.current ? '●' : '○';
      parts.label.textContent = station.label;
    }
    const displayed = stations.find((station) => station.key === this._displayedStationKey);
    if (displayed) {
      this._stationTitle.textContent = 'المحطة: ' + displayed.label + ' — ' + this._stationStatusLabel(displayed);
    } else {
      const more = MORE_VIEWS.find(([id]) => id === this._displayedMoreView);
      this._stationTitle.textContent = more ? 'المزيد: ' + more[1] : '';
    }
    this._moreButton.toggleAttribute('data-selected', Boolean(this._displayedMoreView));
    this._moreButton.setAttribute('aria-label', this._displayedMoreView ? 'المزيد — القسم المعروض' : 'المزيد من أقسام غرفة العمليات');
    if (derived && derived.nextAction) this._stationStrip.dataset.nextAction = text(derived.nextAction.key);
  }

  _groupSignature(groupId) {
    const team = this._state.team;
    if (groupId === 'work') {
      const loop = this._state.loop;
      if (!team && !loop && !this._plan && !this._brainstorm) return '';
      return [team && team.id, team && team.state, team && team.updated_at,
        loop && loop.loop_id, loop && loop.state, loop && loop.updated_at,
        this._plan && this._plan.id, this._plan && this._plan.state,
        this._brainstorm && this._brainstorm.id, this._brainstorm && this._brainstorm.state].join(':');
    }
    if (groupId === 'results') {
      const fileCount = ((team && team.agents) || []).reduce((total, agent) =>
        total + ((agent.changes && agent.changes.files && agent.changes.files.length) || 0), 0);
      if (!fileCount && !this._state.review && !this._state.verification) return '';
      return [team && team.artifact_id, fileCount, this._state.review && this._state.review.id,
        this._state.review && this._state.review.state, this._state.review && this._state.review.updated_at,
        this._state.verification && this._state.verification.artifact_id,
        this._state.verification && this._state.verification.state].join(':');
    }
    const lastEntry = this._state.entries[this._state.entries.length - 1];
    const lastHistory = this._history[this._history.length - 1];
    return lastEntry || lastHistory ? [lastEntry && lastEntry.id, lastEntry && lastEntry.created_at,
      lastHistory && lastHistory.room_id, lastHistory && lastHistory.updated_at].join(':') : '';
  }

  _groupAlerts() {
    const team = this._state.team;
    const work = !!(team && ['failed', 'timed_out', 'conflict', 'cleanup_failed'].includes(team.state))
      || !!(this._state.loop && ['failed_after_n', 'budget_exhausted', 'failed'].includes(this._state.loop.state))
      || ((team && team.agents) || []).some((agent) => agent && ['failed', 'timed_out', 'cleanup_failed'].includes(agent.state))
      || !!(this._plan && this._plan.state === 'failed')
      || ((this._brainstorm && this._brainstorm.workers) || []).some((worker) => worker && worker.state === 'failed');
    const reviewItems = (this._state.review && this._state.review.reviews) || [];
    const results = !!(this._state.verification && this._state.verification.state === 'failed')
      || !!(this._state.review && ['failed', 'timed_out'].includes(this._state.review.state))
      || reviewItems.some((item) => item && item.verdict && item.verdict.decision !== 'approve');
    return { work, results, log: false };
  }

  _markGroupSeen(groupId) {
    if (this._groupSeen && this._groupSeen[groupId] != null) this._groupSeen[groupId] = this._groupSignature(groupId);
  }

  _renderGroupBadges() {
    this._markGroupSeen(this._group);
    const alerts = this._groupAlerts();
    for (const group of GROUPS) {
      const signature = this._groupSignature(group.id);
      const unseen = !!(signature && signature !== this._groupSeen[group.id]);
      const badge = this._groupBadges[group.id];
      const value = alerts[group.id] ? 'تنبيه' : unseen ? 'جديد' : '';
      badge.textContent = value; badge.hidden = !value;
      badge.toggleAttribute('data-alert', alerts[group.id] === true);
      this._groupButtons[group.id].setAttribute('aria-label', group.label + (value ? ' — ' + value : ''));
    }
  }

  _renderCompactState(derived) {
    const alerts = this._groupAlerts();
    const hasAlert = alerts.work || alerts.results;
    const running = derived.loopActive || derived.teamActive || derived.reviewActive || derived.verificationActive;
    const merged = !!(this._state.team && this._state.team.merged);
    this._compactState.textContent = hasAlert ? '!' : this._primaryAction ? '←' : running ? '…' : merged ? '✓' : '•';
    this._compactState.toggleAttribute('data-alert', hasAlert);
    this._compactState.setAttribute('aria-label', hasAlert ? 'توجد حالة تحتاج الانتباه'
      : this._primaryAction ? 'توجد خطوة تالية متاحة' : running ? 'يوجد انتقال جارٍ'
        : merged ? 'اكتمل الدمج' : 'غرفة العمليات جاهزة');
  }

  _render() {
    const derived = deriveOpsRoomState(this._state);
    const stations = deriveStations(this._state);
    this._syncStationView(stations);
    this._renderPrimaryAction(derived);
    this._buttons.preview.hidden = !derived.showPreview || derived.previewNeedsCleanup;
    this._buttons.preview.disabled = !derived.previewActive && !derived.canPreview;
    this._buttons.preview.textContent = derived.previewActive ? '🖥 افتح المعاينة' : '🖥 شاهدها تعمل';
    this._buttons.previewStop.hidden = !derived.canStopPreview;
    this._timeoutRow.hidden = true;
    this._buttons.stop.hidden = !derived.canStop;
    this._verifyConfigRecovery.hidden = this._state.status !== ERROR_LABELS.review_skill_unavailable;
    this._verifyConfigRecovery.disabled = !this._cwd;
    const statusMessage = this._state.status || (this._state.pending ? 'جارٍ تنفيذ الانتقال المطلوب…'
      : this._state.loop && derived.loopActive
        ? (LOOP_STATES[this._state.loop.state] || visibleLifecycleLabel(this._state.loop.state))
        : this._state.team
          ? (TEAM_STATES[this._state.team.state] || visibleLifecycleLabel(this._state.team.state))
        : 'حدّد المهام والملكية، ثم ابدأ انتقال التنفيذ صراحةً.');
    setMixedTechnicalText(this._status, statusMessage);
    this._renderHistory(); this._renderBrainstorm(); this._renderDecisions(); this._renderTasks(); this._renderDiscussion();
    this._renderEvidence(); this._renderDiffs(); this._renderReview();
    this._renderStations(stations, derived); this._renderGroupBadges(); this._renderCompactState(derived);
  }

  _confirm(options) {
    return new Promise((resolve) => {
      this.dispatchEvent(new CustomEvent('ops-confirm-request', {
        bubbles: true, detail: {
          ...options, source: this._primaryAction === options.kind ? this._primaryButton : this, resolve,
        },
      }));
    });
  }

  async _startExecution() {
    if (!this._setup) { this._selectView('tasks'); return; }
    if (!this._cwd) { this._dispatch({ type: 'status', status: BAD_INPUT_LABELS.execution }); return; }
    const count = Number(this._setup.count.value) || 1;
    const timeoutSeconds = Number(this._setup.timeout.value) || 300;
    const agents = this._setup.inputs.slice(0, count).map((worker) => ({
      task: worker.querySelector('.task').value.trim(),
      ownership: worker.querySelector('.ownership').value.split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean),
    }));
    if (agents.some((agent) => !agent.task || !agent.ownership.length)) {
      this._dispatch({ type: 'status', status: 'اكتب مهمة وملكية ملفات لكل عامل.' }); return;
    }
    if (this._setup.loopMode.checked) {
      if (count !== 1) {
        this._dispatch({ type: 'status', status: 'الحلقة المحدودة تعمل بعامل واحد فقط.' }); return;
      }
      if (typeof window.satr.loopPreflight !== 'function' || typeof window.satr.loopStart !== 'function') {
        this._dispatch({ type: 'status', status: 'وضع الحلقة المحدودة غير متاح في هذه النسخة حالياً.' }); return;
      }
      const maxIterations = Number(this._setup.maxIterations.value);
      const budgetTokens = Number(this._setup.budgetTokens.value);
      if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5
        || !Number.isInteger(budgetTokens) || budgetTokens < 50000 || budgetTokens > 2000000) {
        this._dispatch({ type: 'status', status: 'راجع عدد الدورات وميزانية الرموز قبل بدء الحلقة.' }); return;
      }
      let preflight = null;
      try { preflight = await window.satr.loopPreflight(this._cwd); } catch {}
      if (!preflight || !preflight.ok) {
        this._dispatch({ type: 'status', status: errorLabel(preflight, 'execution',
          'تعذّر فحص إعداد التحقق للحلقة — راجع .satr/verify.json المعتمد في HEAD.') });
        return;
      }
      const confirmed = await this._confirm({
        kind: 'loop-start', title: 'تأكيد الحلقة المحدودة', confirmLabel: 'ابدأ الحلقة',
        description: 'موافقة واحدة على الحلقة كاملة: حتى ' + integerLabel(maxIterations)
          + ' دورات، وميزانية ' + integerLabel(budgetTokens)
          + ' رمز تقديرية، ومهلة ' + integerLabel(timeoutSeconds) + ' ثانية لكل دورة. لن يندمج شيء تلقائياً.',
        items: (preflight.checks || []).map((check) => check.command).filter((command) => typeof command === 'string'),
      });
      if (!confirmed) return;
      this._dispatch({ type: 'pending', action: 'loop-start' });
      let result = null;
      const models = this._modelOverrides(['worker']);
      try {
        const loop = {
          max_iterations: maxIterations, budget_tokens: budgetTokens, timeout_seconds: timeoutSeconds,
        };
        result = models && this._supportsModels(window.satr.loopStart, 6)
          ? await window.satr.loopStart(this._cwd, agents[0].task, agents[0].ownership, loop, true, models)
          : await window.satr.loopStart(this._cwd, agents[0].task, agents[0].ownership, loop, true);
      } catch {}
      if (!result || !result.ok) {
        this._dispatch({ type: 'settled', status: errorLabel(result, 'execution',
          'تعذّر بدء الحلقة المحدودة — راجع المهمة والملكية وإعداد التحقق ثم أعد المحاولة.') });
        return;
      }
      this._dispatch({ type: 'settled', status: 'بدأت الحلقة المحدودة داخل نسخة عمل معزولة.' });
      if (result.loop) this._dispatch({ type: 'event', event: { ...result.loop, type: 'loop_update' } });
      if (result.loop && result.loop.room_id) await this._loadRoom(result.loop.room_id);
      return;
    }
    const confirmed = await this._confirm({
      kind: 'start', title: 'تأكيد بدء التنفيذ المعزول', confirmLabel: 'ابدأ التنفيذ',
      description: 'سينشئ «سطر» worktree مستقلاً لكل عامل بمهلة ' + (timeoutSeconds / 60)
        + ' دقائق، وينفّذ داخل الملكيات المعلنة فقط. لن يدمج شيئاً تلقائياً.',
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'start' });
    let result = null;
    const models = this._modelOverrides(['worker']);
    try {
      result = models && this._supportsModels(window.satr.executionTeamStart, 6)
        ? await window.satr.executionTeamStart(this._cwd, agents, true, 'mergeable', timeoutSeconds, models)
        : await window.satr.executionTeamStart(this._cwd, agents, true, 'mergeable', timeoutSeconds);
    } catch {}
    if (!result || !result.ok) {
      this._dispatch({ type: 'settled', ...(result && result.team ? { team: result.team } : {}),
        status: errorLabel(result, 'execution', 'تعذّر بدء فريق التنفيذ — تحقق من المجلد والمهام والملكيات ثم أعد المحاولة.') });
      if (result && result.team && result.team.room_id) await this._loadRoom(result.team.room_id);
      return;
    }
    this._dispatch({ type: 'settled', team: result.team, status: 'بدأ التنفيذ داخل النسخ المعزولة.' });
    await this._loadRoom(result.team && result.team.room_id);
  }

  async _stopLoop(loop) {
    if (!loop || !loop.loop_id) return;
    if (typeof window.satr.loopStop !== 'function') {
      this._dispatch({ type: 'status', status: 'إيقاف الحلقة غير متاح في هذه النسخة حالياً.' }); return;
    }
    const confirmed = await this._confirm({
      kind: 'loop-stop', title: 'تأكيد إيقاف الحلقة', confirmLabel: 'أوقف الحلقة',
      description: 'سيُقاطع العامل فوراً، ويحفظ «سطر» الأثر الجزئي للمراجعة إن أمكن التقاطه.',
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'loop-stop' });
    let result = null;
    try { result = await window.satr.loopStop(loop.loop_id); } catch {}
    this._dispatch({ type: 'settled', status: result && result.ok
      ? 'توقفت الحلقة المحدودة بطلب المستخدم.'
      : errorLabel(result, 'execution', 'تعذّر إيقاف الحلقة — حدّث الغرفة ثم أعد المحاولة.') });
    if (result && result.loop) this._dispatch({ type: 'event', event: { ...result.loop, type: 'loop_update' } });
  }

  async _startReview() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canReview) return;
    this._dispatch({ type: 'pending', action: 'review' });
    let result = null;
    const models = this._modelOverrides(['sdk', 'codex']);
    try {
      result = models && this._supportsModels(window.satr.executionReviewStart, 2)
        ? await window.satr.executionReviewStart(this._state.team.id, models)
        : await window.satr.executionReviewStart(this._state.team.id);
    } catch {}
    this._dispatch({ type: 'settled', ...(result && result.review ? { review: result.review } : {}),
      status: result && result.ok ? 'بدأت المراجعات المستقلة.'
        : errorLabel(result, 'review', 'تعذّر بدء المراجعة — حدّث الغرفة وتحقق من اكتمال الأثر ثم أعد المحاولة.') });
  }

  async _prepareVerification() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canPrepareVerification) return;
    this._dispatch({ type: 'pending', action: 'prepare' });
    let result = null;
    try { result = await window.satr.executionVerificationPrepare(this._state.team.id, this._state.review.id); } catch {}
    this._dispatch({ type: 'settled', ...(result && result.verification ? { verification: result.verification } : {}),
      status: result && result.ok ? 'ثُبّتت اختبارات الأثر وتنتظر تأكيد التشغيل.'
        : errorLabel(result, 'verification', 'تعذّر تثبيت التحقق — راجع المراجعات وملف .satr/verify.json ثم أعد المحاولة.') });
  }

  async _runVerification() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canRunVerification) return;
    const confirmed = await this._confirm({
      kind: 'verify', title: 'تأكيد تشغيل الاختبارات', confirmLabel: 'شغّل الاختبارات',
      description: 'ستعمل الأوامر المعتمدة في HEAD داخل worktree تكاملي معزول فقط.',
      items: (this._state.verification.checks || []).map((check) => check.command).filter(Boolean),
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'verify' });
    let result = null;
    try {
      result = await window.satr.executionVerificationRun(
        this._state.team.id, this._state.review.id, this._state.verification.artifact_id, true,
      );
    } catch {}
    this._dispatch({ type: 'settled', ...(result && result.verification ? { verification: result.verification } : {}),
      status: result && result.ok ? 'اكتمل تشغيل التحقق.'
        : errorLabel(result, 'verification', 'تعذّر تشغيل التحقق التكاملي — ثبّت التحقق للأثر الحالي ثم أعد المحاولة.') });
  }

  async _merge() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canMerge) return;
    const confirmed = await this._confirm({
      kind: 'merge', title: 'تأكيد دمج الأثر المعتمد', confirmLabel: 'طبّق الأثر',
      description: 'سيطبّق «سطر» الأثر المراجع والمتحقق منه على شجرة مشروع نظيفة، بلا commit أو push.',
      items: [derived.artifactId],
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'merge' });
    let result = null;
    try { result = await window.satr.executionMerge(this._state.team.id, this._state.review.id, true); } catch {}
    this._dispatch({ type: 'settled', ...(result && result.team ? { team: result.team } : {}),
      ...(result && Object.prototype.hasOwnProperty.call(result, 'preview') ? { preview: result.preview } : {}),
      status: result && result.ok && result.preview_cleanup_failed
        ? 'طُبّق الأثر، لكن تعذّر تنظيف معاينته التكاملية؛ نظّف worktree يدوياً.'
        : result && result.ok ? 'طُبّق الأثر بلا commit.'
        : errorLabel(result, 'merge', 'تعذّر الدمج بأمان — راجع حالة Git ثم أعد المحاولة.') });
  }

  async _startPreview() {
    const derived = deriveOpsRoomState(this._state);
    const active = this._state.preview;
    if (derived.previewActive && active && active.url) {
      this.dispatchEvent(new CustomEvent('ops-preview-open', { bubbles: true, detail: { url: active.url } }));
      return;
    }
    if (!derived.canPreview) return;
    const confirmed = await this._confirm({
      kind: 'preview', title: 'تأكيد تشغيل المعاينة التكاملية', confirmLabel: 'شغّل المعاينة',
      description: 'ستعمل المعاينة المعتمدة عند HEAD داخل worktree تكاملي مؤقت بعد نجاح التحقق للأثر نفسه.',
      items: [derived.artifactId],
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'preview' });
    let result = null;
    try {
      result = await window.satr.executionPreviewStart(this._cwd, this._state.team.id, derived.artifactId, true);
    } catch {}
    this._dispatch({ type: 'settled', ...(result && result.preview ? { preview: result.preview } : {}),
      status: result && result.ok ? 'المعاينة التكاملية جاهزة في تبويب الأدوات.'
        : errorLabel(result, 'verification', 'تعذّر تشغيل المعاينة التكاملية — افحص إعداد preview ثم أعد المحاولة.') });
    if (result && result.ok && result.url) {
      this.dispatchEvent(new CustomEvent('ops-preview-open', { bubbles: true, detail: { url: result.url } }));
    }
  }

  async _stopPreview() {
    if (!deriveOpsRoomState(this._state).canStopPreview) return;
    this._dispatch({ type: 'pending', action: 'preview-stop' });
    let result = null;
    try { result = await window.satr.executionPreviewStop(); } catch {}
    this._dispatch({ type: 'settled',
      ...(result && Object.prototype.hasOwnProperty.call(result, 'preview') ? { preview: result.preview } : {}),
      status: result && result.ok ? 'أُوقفت المعاينة التكاملية ونُظّفت نسختها المؤقتة.'
        : errorLabel(result, 'verification', 'تعذّر تنظيف المعاينة التكاملية؛ نظّف worktree يدوياً ثم أعد المحاولة.') });
  }

  async _stop() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canStop) return;
    this._dispatch({ type: 'pending', action: 'stop' });
    let result = null;
    try {
      if (derived.verificationActive) result = await window.satr.executionVerificationStop(this._state.verification.artifact_id);
      else if (derived.reviewActive) result = await window.satr.executionReviewStop(this._state.review.id);
      else result = await window.satr.executionTeamStop(this._state.team.id);
    } catch {}
    this._dispatch({ type: 'settled', ...(result && result.team ? { team: result.team } : {}),
      ...(result && result.review ? { review: result.review } : {}),
      ...(result && result.verification ? { verification: result.verification } : {}),
      status: result && result.ok ? 'أُوقف الانتقال الجاري.'
        : errorLabel(result, 'verification', 'تعذّر إيقاف الانتقال الجاري — انتظر تحديث حالته ثم أعد المحاولة.') });
  }

  async _recordDecision(input) {
    const value = input.value.trim();
    const team = this._state.team; const room = this._state.room;
    if (!value || !team || !room) return;
    this._dispatch({ type: 'pending', action: 'decision' });
    let result = null;
    try { result = await window.satr.opsRoomDecision(room.room_id, value, team.id, team.artifact_id || '', true); } catch {}
    input.value = '';
    this._dispatch({ type: 'settled', status: result && result.ok ? 'سُجّل القرار في السجل الدائم.'
      : errorLabel(result, 'decision', 'تعذّر تسجيل القرار — حدّث الغرفة ثم أعد المحاولة.') });
  }

  async _loadRoom(roomId) {
    if (!roomId) return;
    try {
      const loaded = await window.satr.opsRoomLoad(roomId);
      if (loaded && loaded.room) {
        this._state = opsRoomReducer(this._state, {
          type: 'hydrate', room: loaded.room, team: this._state.team,
          review: this._state.review, verification: this._state.verification, preview: this._state.preview,
        });
        this._render();
      }
    } catch {}
  }

  async _extendTimeout() {
    const team = this._state.team;
    if (!team || team.can_extend !== true) return;
    let result = null;
    try { result = await window.satr.executionTeamExtend(team.id); } catch {}
    this._dispatch({ type: 'settled', ...(result && result.team ? { team: result.team } : {}),
      status: result && result.ok ? 'مُدّدت مهلة الفريق مرة واحدة ضمن سقف 10 دقائق.'
        : errorLabel(result, 'timeout', 'تعذّر تمديد المهلة — ضيّق المهمة ثم أعد التنفيذ إن انتهت المهلة.') });
  }

  async _startBrainstorm() {
    const brief = this._brainstormDraft.trim();
    if (!this._cwd) { this._dispatch({ type: 'status', status: BAD_INPUT_LABELS.brainstorm }); return; }
    if (!brief) { this._dispatch({ type: 'status', status: 'اكتب موجز العصف أولاً.' }); return; }
    let result = null;
    try { result = await window.satr.opsBrainstormStart(this._cwd, brief, this._state.team && this._state.team.id); } catch {}
    if (!result || !result.ok) {
      this._dispatch({ type: 'status', status: errorLabel(result, 'brainstorm',
        'تعذّر بدء العصف المستقل — تحقق من توفر المحركين ثم أعد المحاولة.') }); return;
    }
    this._brainstorm = result.run; this._renderBrainstorm();
  }

  async _stopBrainstorm() {
    if (!this._brainstorm) return;
    let result = null;
    try { result = await window.satr.opsBrainstormStop(this._brainstorm.id); } catch {}
    if (!result || !result.ok) {
      this._dispatch({ type: 'status', status: errorLabel(result, 'brainstorm',
        'تعذّر إيقاف العصف — انتظر تحديث حالته ثم أعد المحاولة.') }); return;
    }
    if (result.run) this._brainstorm = result.run;
    this._renderBrainstorm();
  }

  async _startPlan() {
    if (!this._setup) return;
    if (!this._cwd) { this._dispatch({ type: 'status', status: BAD_INPUT_LABELS.planner }); return; }
    const task = this._setup.inputs[0].querySelector('.task').value.trim();
    if (!task) { this._dispatch({ type: 'status', status: 'اكتب المهمة الكبيرة في حقل العامل الأول ثم اطلب التقسيم.' }); return; }
    this._planDraft = task;
    let result = null;
    try { result = await window.satr.opsPlanStart(this._cwd, task); } catch {}
    if (!result || !result.ok) {
      this._dispatch({ type: 'status', status: errorLabel(result, 'planner',
        'تعذّر بدء مخطط المهام — تحقق من توفر Claude ثم أعد المحاولة.') }); return;
    }
    this._plan = result.run; this._renderTasks();
  }

  async _stopPlan() {
    if (!this._plan) return;
    let result = null;
    try { result = await window.satr.opsPlanStop(this._plan.id); } catch {}
    if (!result || !result.ok) {
      this._dispatch({ type: 'status', status: errorLabel(result, 'planner',
        'تعذّر إيقاف المخطط — انتظر تحديث حالته ثم أعد المحاولة.') }); return;
    }
    if (result.run) this._plan = result.run;
    this._renderTasks();
  }

  _applyPlan() {
    const tasks = this._plan && this._plan.plan && this._plan.plan.tasks;
    if (!this._setup || !Array.isArray(tasks) || !tasks.length || this._appliedPlanId === this._plan.id) return;
    this._appliedPlanId = this._plan.id;
    this._setup.count.value = String(tasks.length);
    this._setup.inputs.forEach((worker, index) => {
      worker.hidden = index >= tasks.length;
      worker.querySelector('.task').value = tasks[index] ? tasks[index].task : '';
      worker.querySelector('.ownership').value = tasks[index] ? tasks[index].ownership.join(', ') : '';
    });
    this._planDraft = tasks[0].task;
    this._syncSetupActions();
  }

  _renderBrainstorm() {
    const view = this._views.brainstorm; view.textContent = '';
    const setup = document.createElement('section'); setup.className = 'setup';
    const title = document.createElement('strong'); title.textContent = 'عصف مستقل مع Claude وCodex';
    const note = document.createElement('div'); note.className = 'setup-note';
    note.textContent = 'يستقبل المحركان الموجز فقط داخل مجلدين فارغين، بلا أدوات أو مشروع أو متصفح، ولا يتخاطبان تلقائياً.';
    const input = document.createElement('textarea'); input.maxLength = 12000;
    input.placeholder = 'اكتب الموجز أو القرار الذي تريد رأيين مستقلين حوله…'; input.setAttribute('aria-label', 'موجز العصف');
    input.value = this._brainstormDraft;
    const actions = document.createElement('div'); actions.className = 'setup-actions';
    const active = this._brainstorm && this._brainstorm.state === 'running';
    const action = document.createElement('button'); action.type = 'button'; action.textContent = active ? 'أوقف العصف' : 'ابدأ رأيين مستقلين';
    const actionHint = document.createElement('span'); actionHint.className = 'setup-note';
    const syncAction = () => {
      const hint = !this._cwd ? 'افتح مجلد مشروع أولاً لحفظ العصف ضمن سياقه.'
        : !input.value.trim() ? 'اكتب موجز العصف أولاً.' : '';
      action.disabled = !active && Boolean(hint);
      action.title = active ? '' : hint;
      actionHint.textContent = active ? '' : hint;
      actionHint.hidden = active || !hint;
    };
    input.addEventListener('input', () => { this._brainstormDraft = input.value; syncAction(); });
    action.addEventListener('click', () => active ? this._stopBrainstorm() : this._startBrainstorm());
    actions.appendChild(action); actions.appendChild(actionHint); syncAction();
    setup.appendChild(title); setup.appendChild(note); setup.appendChild(input); setup.appendChild(actions); view.appendChild(setup);
    for (const worker of (this._brainstorm && this._brainstorm.workers) || []) {
      view.appendChild(this._card({
        title: 'رأي ' + engineLabel(worker.engine), state: worker.state,
        stateLabel: worker.state === 'running' ? 'يفكّر…' : visibleLifecycleLabel(worker.state),
        summary: worker.summary || worker.error || 'ينتظر الرأي النصي المستقل.',
        actor: 'advisor', engine: worker.engine, artifact: '', time: worker.updated_at,
      }));
    }
  }

  async _loadHistory() {
    try {
      const result = await window.satr.opsRoomHistory(this._cwd);
      this._history = result && Array.isArray(result.rooms) ? result.rooms : [];
      this._renderHistory(); this._renderGroupBadges();
    } catch {
      this._history = []; this._renderHistory(); this._renderGroupBadges();
    }
  }

  async _openHistory(item) {
    try {
      const loaded = await window.satr.opsRoomLoad(item.room_id);
      if (!loaded || !loaded.room) return;
      const sameTeam = this._state.team && this._state.team.room_id === item.room_id ? this._state.team : null;
      this._state = opsRoomReducer(this._state, { type: 'hydrate', room: loaded.room, team: sameTeam });
      this._selectView('decisions'); this._render();
    } catch {}
  }

  async _restoreHistory(item) {
    const confirmed = await this._confirm({
      kind: 'start', title: 'تأكيد استعادة الأثر المشفّر', confirmLabel: 'استعد الأثر',
      description: 'سيُعاد الأثر إلى ذاكرة غرفة العمليات فقط. لن يُطبّق على المشروع، ويلزم تشغيل المراجعة والتحقق من جديد.',
      items: [item.artifact_id],
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'restore' });
    let result = null;
    try { result = await window.satr.opsRoomRestore(this._cwd, item.room_id, item.artifact_id, true); } catch {}
    if (!result || !result.ok || !result.team) {
      this._dispatch({ type: 'settled', status: errorLabel(result, 'restore',
        'تعذّرت استعادة الأثر — افتح المشروع الأصلي ثم أعد المحاولة.') }); return;
    }
    this._dispatch({ type: 'hydrate', team: result.team, room: null, review: null, verification: null });
    await this._loadRoom(item.room_id); this._selectView('tasks'); await this._loadHistory();
  }

  async _deleteHistoryArtifact(item) {
    const confirmed = await this._confirm({
      kind: 'start', title: 'تأكيد حذف الأثر المحفوظ', confirmLabel: 'احذف الأثر',
      description: 'سيُحذف الأثر المشفّر نهائياً من خزنة «سطر». يبقى السجل المنقّى، ولن تتاح الاستعادة بعد ذلك.',
      items: [item.artifact_id],
    });
    if (!confirmed) return;
    let result = null;
    try { result = await window.satr.opsRoomArtifactDelete(this._cwd, item.room_id, item.artifact_id, true); } catch {}
    this._dispatch({ type: 'status', status: result && result.ok ? 'حُذف الأثر المشفّر وبقي السجل المنقّى.'
      : errorLabel(result, 'history', 'تعذّر حذف الأثر المحفوظ — حدّث السجل ثم أعد المحاولة.') });
    await this._loadHistory();
  }

  async open(cwd) {
    this._cwd = typeof cwd === 'string' ? cwd : '';
    this._verifyConfigButton.disabled = !this._cwd;
    this._loadLayoutPreferences();
    this._loadModelPreferences();
    this.setAttribute('open', '');
    clearInterval(this._clock);
    this._clock = setInterval(() => this._refreshCountdowns(), 1000);
    this._history = []; this._brainstorm = null; this._plan = null; this._planDraft = '';
    this._diffCache.clear();
    this._groupSeen = { work: '', results: '', log: '' };
    this._currentStationKey = ''; this._displayedStationKey = ''; this._displayedMoreView = '';
    this._stationUserView = false; this._closeMoreMenu();
    this._state = createOpsRoomState(); this._render();
    let team = null; let review = null; let verification = null; let preview = null; let room = null; let loop = null;
    const loopLatestAvailable = typeof window.satr.loopLatest === 'function';
    try {
      const brainstormed = await window.satr.opsBrainstormLatest(this._cwd);
      this._brainstorm = brainstormed && brainstormed.run;
      const planned = await window.satr.opsPlanLatest(this._cwd);
      this._plan = planned && planned.run;
      if (loopLatestAvailable) {
        try {
          const loopLatest = await window.satr.loopLatest(this._cwd);
          loop = loopLatest && loopLatest.loop;
        } catch {}
      }
      const latest = await window.satr.executionTeamLatest(this._cwd);
      team = latest && latest.team;
      if (team) {
        const reviewed = await window.satr.executionReviewLatest(team.id);
        review = reviewed && reviewed.review;
        const verified = await window.satr.executionVerificationLatest(team.id);
        verification = verified && verified.verification || team.verification;
        preview = verified && verified.preview;
        if (team.room_id) {
          const loaded = await window.satr.opsRoomLoad(team.room_id);
          room = loaded && loaded.room;
        }
      }
    } catch {}
    this._dispatch({ type: 'hydrate', room, team, review, verification, preview, loop });
    if (this._plan && this._plan.state === 'completed') this._applyPlan();
    await this._loadHistory();
  }

  seedTask(task) {
    const value = text(task).trim().slice(0, 4000);
    if (!value) return false;
    this._planDraft = value;
    this._selectView('tasks');
    this._renderTasks();
    if (this._setup && this._setup.inputs[0]) {
      this._setup.inputs[0].querySelector('.task').value = value;
      this._syncSetupActions();
    }
    return true;
  }

  close() {
    this._saveLayoutPreferences();
    clearInterval(this._clock); this._clock = null;
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('panel-close', { bubbles: true }));
  }

  focusInitial() {
    const target = this.hasAttribute('compact') ? this._compactButton : this._root.querySelector('.close');
    if (target) target.focus();
  }

  _renderHistory() {
    const view = this._views.history; view.textContent = '';
    for (const item of this._history) {
      const taskExcerpt = truncateWords(text(item.task_excerpt).trim(), 80);
      const runKind = RUN_KIND_LABELS[item.run_kind] || '';
      const availability = item.merged ? 'دُمج أثر هذه الغرفة سابقاً.'
        : item.restorable ? 'يتوفر أثر مشفّر يمكن استعادته للمراجعة والتحقق من جديد.' : 'يتوفر السجل المنقّى فقط.';
      view.appendChild(this._card({
        title: taskExcerpt || item.room_id, state: item.state,
        stateLabel: TEAM_STATES[item.state] || visibleLifecycleLabel(item.state),
        summary: (runKind ? 'نوع التشغيل: ' + runKind + '. ' : '') + availability,
        actor: 'system', engine: 'system', artifact: item.artifact_id, time: item.updated_at,
        body: (body) => {
          if (taskExcerpt) {
            const room = document.createElement('div'); room.className = 'agent-meta';
            const roomTitle = document.createElement('span'); roomTitle.textContent = 'معرّف الغرفة';
            const roomId = document.createElement('bdi'); roomId.className = 'artifact'; roomId.textContent = item.room_id;
            room.appendChild(roomTitle); room.appendChild(roomId); body.appendChild(room);
          }
          const actions = document.createElement('div'); actions.className = 'setup-actions';
          const open = document.createElement('button'); open.type = 'button'; open.textContent = 'فتح السجل';
          open.addEventListener('click', () => this._openHistory(item)); actions.appendChild(open);
          if (item.restorable && !item.merged) {
            const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = 'استعادة الأثر';
            restore.addEventListener('click', () => this._restoreHistory(item)); actions.appendChild(restore);
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'حذف الأثر المحفوظ';
            remove.addEventListener('click', () => this._deleteHistoryArtifact(item)); actions.appendChild(remove);
          }
          body.appendChild(actions);
        },
      }));
    }
    if (!this._history.length) this._empty(view, 'لا توجد غرف سابقة لهذا المشروع بعد.');
  }

  _refreshCountdowns() {
    const now = Date.now();
    for (const element of this._root.querySelectorAll('[data-deadline]')) {
      element.textContent = 'متبقٍ ' + remainingLabel(element.dataset.deadline);
    }
    for (const element of this._root.querySelectorAll('.observable-activity[data-agent-activity]')) {
      syncActivityElement(element, element._opsAgent, now);
    }
    for (const element of this._root.querySelectorAll('[data-started-at]')) {
      element.textContent = 'المدة ' + durationLabel(now - Number(element.dataset.startedAt));
    }
    const team = this._state.team;
    const deadlines = ((team && team.agents) || []).filter((agent) => !TERMINAL_AGENT_STATES.has(agent.state))
      .map((agent) => Number(agent.deadline_at) || 0).filter(Boolean);
    const remaining = deadlines.length ? Math.min(...deadlines) - Date.now() : Infinity;
    const warn = team && team.state === 'running' && team.can_extend === true && remaining > 0 && remaining <= 60000;
    this._timeoutRow.hidden = !warn;
    this._timeoutWarning.textContent = warn
      ? 'بقي أقل من دقيقة. يمكنك تمديد المهلة مرة واحدة إلى الـpreset التالي، وبحد أقصى 10 دقائق.' : '';
  }

  _applyCompactState(compact) {
    const moveFocus = compact === true && this._root.activeElement && this._root.activeElement !== this._compactButton;
    this.toggleAttribute('compact', compact === true);
    this._compactButton.setAttribute('aria-pressed', compact === true ? 'true' : 'false');
    this._compactButton.setAttribute('aria-label', compact === true ? 'توسيع غرفة العمليات' : 'طي غرفة العمليات');
    this._compactButton.textContent = compact === true ? 'فتح' : 'طيّ';
    if (moveFocus) queueMicrotask(() => this._compactButton.focus());
    this._updateResizeAccessibility();
  }

  _setCompact(compact, persist) {
    this._preferredCompact = compact === true;
    this._applyCompactState(!this.hasAttribute('drawer') && this._preferredCompact);
    if (persist !== false) this._saveLayoutPreferences();
  }

  _toggleCompact() {
    this._setCompact(!this._preferredCompact, true);
  }

  _notifyRuntime(key, message) {
    if (this._notified.has(key)) return;
    this._notified.add(key);
    this.dispatchEvent(new CustomEvent('ops-notice', { bubbles: true, detail: message }));
  }

  handleEvent(event) {
    if (!event) return;
    if (event.type === 'ops_brainstorm_update' && event.run) {
      this._brainstorm = event.run; this._renderBrainstorm(); this._renderGroupBadges();
      this._renderCompactState(deriveOpsRoomState(this._state)); return;
    }
    if (event.type === 'ops_plan_update' && event.run) {
      this._plan = event.run; this._renderTasks();
      if (event.run.state === 'completed') this._applyPlan();
      this._renderGroupBadges(); this._renderCompactState(deriveOpsRoomState(this._state));
      return;
    }
    this._dispatch({ type: 'event', event });
    if (event.type === 'execution_team_update' && event.team
      && ['completed', 'failed', 'timed_out', 'stopped', 'conflict', 'cleanup_failed'].includes(event.team.state)) {
      this._notifyRuntime('team:' + event.team.id + ':' + event.team.state,
        event.team.state === 'completed' ? 'اكتمل فريق غرفة العمليات؛ راجع الخطوة التالية.' : 'انتهى فريق غرفة العمليات بحالة تحتاج مراجعة.');
      this._loadHistory();
    }
    if (event.type === 'execution_review_update' && event.review
      && ['completed', 'failed', 'timed_out', 'stopped'].includes(event.review.state)) {
      this._notifyRuntime('review:' + event.review.id + ':' + event.review.state, 'اكتملت مرحلة المراجعة أو توقفت؛ راجع أحكامها.');
    }
    if (event.type === 'execution_verification_update' && event.verification
      && ['passed', 'failed'].includes(event.verification.state)) {
      this._notifyRuntime('verification:' + event.verification.artifact_id + ':' + event.verification.state,
        event.verification.state === 'passed' ? 'نجح التحقق التكاملي للأثر الحالي.' : 'فشل التحقق التكاملي؛ راجع الأدلة.');
    }
  }
}

customElements.define('satr-ops-dialog', SatrOpsDialog);
customElements.define('satr-ops-room', SatrOpsRoom);
