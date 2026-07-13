// غرفة العمليات: لوحة عمل عربية تعرض الحقيقة العامة المنقّاة فقط، وتترك كل انتقال
// تشغيلي لنقرة مستخدم صريحة. لا patch ولا خرج أوامر كامل يدخل هذا المكوّن.
import { sheet } from '../lib/sheet.js';
import { panelSheet, controlsSheet } from '../lib/panel.css.js';
import { cardSheet } from '../lib/card.css.js';
import { createOpsRoomState, deriveOpsRoomState, opsRoomReducer } from '../lib/ops-room-state.js';

const roomSheet = sheet(`
  :host { width: min(42rem, 94vw); z-index: var(--z-panel); }
  .panel-head { gap: var(--space-3); }
  .panel-head-actions, .room-actions, .room-nav, .setup-actions {
    display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
  }
  .room-actions { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
  .room-actions button { font-size: .75rem; }
  .room-actions .stop { color: var(--red); }
  .room-actions .merge { color: var(--green); border-color: var(--green-border); }
  .room-actions .verify, .room-actions .review { color: var(--gold); border-color: var(--gold-border); }
  .room-nav {
    flex-wrap: nowrap; overflow-x: auto; padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border); background: var(--surface-2);
  }
  .room-nav button { white-space: nowrap; padding: var(--space-1) var(--space-2); }
  .room-nav button[aria-selected="true"] { color: var(--gold); border-color: var(--gold); }
  .status {
    min-height: var(--space-6); padding: var(--space-2) var(--space-3);
    color: var(--text-dim); font-size: .78rem; border-bottom: 1px solid var(--border);
    unicode-bidi: plaintext;
  }
  .panel-list { padding: var(--space-3); overflow-y: auto; overscroll-behavior: contain; }
  .view { display: grid; gap: var(--space-3); }
  .view[hidden] { display: none; }
  .empty {
    padding: var(--space-5); color: var(--text-dim); text-align: center;
    border: 1px dashed var(--border); border-radius: var(--radius-lg); line-height: 1.8;
  }
  .setup {
    display: grid; gap: var(--space-3); padding: var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2);
  }
  .setup-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .setup-note { color: var(--text-dim); font-size: .75rem; line-height: 1.7; }
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
  textarea { resize: vertical; min-height: 4.5rem; }
  .ownership { direction: ltr; text-align: left; font-family: var(--mono); min-height: 3rem; }
  .decision-box { display: grid; gap: var(--space-2); }
  .decision-box textarea { min-height: 5rem; }
  .agent-meta, .file-row, .check-row {
    display: flex; gap: var(--space-2); align-items: baseline; justify-content: space-between;
    padding-block: var(--space-2); border-bottom: 1px solid var(--border-dim);
  }
  .agent-meta:last-child, .file-row:last-child, .check-row:last-child { border-bottom: none; }
  .path, .command, .artifact {
    direction: ltr; unicode-bidi: isolate; font-family: var(--mono); text-align: left;
    overflow-wrap: anywhere;
  }
  .path, .command { flex: 1; min-width: 0; }
  .counts { direction: ltr; font-family: var(--mono); color: var(--text-dim); white-space: nowrap; }
  .summary { white-space: pre-wrap; unicode-bidi: plaintext; }
  .warning { color: var(--red); }
  .gate-summary {
    padding: var(--space-3); border: 1px solid var(--gold-border);
    border-radius: var(--radius-lg); color: var(--text-dim); line-height: 1.8;
  }
  @media (max-width: 44rem) {
    :host { width: 100vw; max-width: 100vw; }
    .panel-head { align-items: flex-start; }
    .room-actions { max-height: 24vh; overflow-y: auto; }
    .setup-head { align-items: flex-start; flex-direction: column; }
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
  .dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .confirm { color: var(--green); border-color: var(--green-border); }
  @media (prefers-reduced-motion: no-preference) {
    :host([open]) .dialog-box { animation: ops-dialog-in var(--dur) var(--ease); }
    @keyframes ops-dialog-in { from { opacity: 0; transform: translateY(var(--space-1)); } }
  }
`);

const VIEWS = [
  ['decisions', 'القرارات'],
  ['tasks', 'المهام والملكية'],
  ['discussion', 'النقاش المحدود'],
  ['evidence', 'الأدلة والاختبارات'],
  ['diffs', 'الفروقات'],
  ['review', 'المراجعة والدمج'],
];

const TEAM_STATES = {
  preparing: 'يجهّز النسخ المعزولة…', queued: 'في الانتظار', running: 'ينفّذ…',
  capturing: 'يجمع وصف الفروقات…', stopping: 'يوقف الفريق…', completed: 'اكتمل التنفيذ',
  failed: 'فشل التنفيذ', timed_out: 'انتهت المهلة', stopped: 'توقف',
  cleanup_failed: 'فشل التنظيف', conflict: 'تعارض ملكية',
};

const ERROR_LABELS = {
  no_repo: 'المجلد ليس مستودع Git.', no_head: 'المستودع بلا HEAD.',
  unsafe_links: 'المستودع يحوي رابطاً رمزياً أو submodule غير آمن.',
  busy: 'يوجد فريق يعمل بالفعل.', ownership_overlap: 'تتداخل ملكيات عاملين.',
  bad_input: 'تحقق من المهام وأنماط الملكية.',
  review_engine_unavailable: 'محرك المراجعة المستقل غير متاح؛ بقيت البوابة مغلقة.',
  verification_config_required: 'يلزم ملف .satr/verify.json صالح ومعتمد في HEAD.',
  verification_config_changed: 'يمس الأثر سياسة التحقق؛ يلزم اعتمادها في مهمة مستقلة.',
  confirmation_required: 'يلزم تأكيد صريح.', verification_prepare_required: 'يلزم تثبيت تحقق جديد للأثر الحالي.',
  review_not_approved: 'لم توافق كل المراجعات؛ لا يمكن تجاوز الحكم.',
  review_artifact_mismatch: 'المراجعة تخص أثراً قديماً.', verification_artifact_mismatch: 'التحقق يخص أثراً قديماً.',
  verification_required: 'يلزم نجاح التحقق للأثر الحالي.', dirty_worktree: 'شجرة المشروع غير نظيفة.',
  head_changed: 'تغيّر HEAD منذ التنفيذ.', conflict: 'يتعارض الأثر مع شجرة المشروع.',
  apply_failed: 'تعذّر تطبيق الأثر بلا تغيير جزئي.', cleanup_failed: 'تعذّر تنظيف worktree؛ عُدّ المسار فاشلاً.',
};

function text(value) {
  return typeof value === 'string' ? value : '';
}

function timeLabel(value) {
  const timestamp = Number(value);
  return timestamp > 0 ? new Date(timestamp).toLocaleString('ar-SA') : 'وقت غير متاح';
}

function engineLabel(value) {
  if (value === 'sdk') return 'Claude SDK';
  if (value === 'codex') return 'Codex';
  if (value === 'system') return 'النظام';
  if (value === 'user') return 'المستخدم';
  return value || 'غير محدد';
}

class SatrOpsDialog extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [controlsSheet, dialogSheet];
    root.innerHTML = '<div class="dialog-box" role="document">'
      + '<h2></h2><div class="description" dir="auto"></div><div class="items"></div>'
      + '<div class="dialog-actions"><button class="cancel" type="button">إلغاء</button>'
      + '<button class="confirm" type="button">تأكيد</button></div></div>';
    this._title = root.querySelector('h2');
    this._description = root.querySelector('.description');
    this._items = root.querySelector('.items');
    this._confirm = root.querySelector('.confirm');
    this._cancel = root.querySelector('.cancel');
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
    root.adoptedStyleSheets = [panelSheet, cardSheet, roomSheet];
    root.innerHTML = '<div class="panel-head"><span>غرفة العمليات</span>'
      + '<div class="panel-head-actions"><button class="close" type="button" aria-label="إغلاق غرفة العمليات">✕</button></div></div>'
      + '<div class="room-actions">'
      + '<button class="start" type="button">تنفيذ</button><button class="review" type="button" hidden>ابدأ المراجعة</button>'
      + '<button class="prepare" type="button" hidden>ثبّت التحقق</button><button class="verify" type="button" hidden>شغّل الاختبارات</button>'
      + '<button class="merge" type="button" hidden>دمج</button><button class="stop" type="button" hidden>إيقاف المرحلة</button></div>'
      + '<nav class="room-nav" role="tablist" aria-label="مسارات غرفة العمليات"></nav>'
      + '<div class="status" aria-live="polite"></div><div class="panel-list"></div>';
    this._root = root;
    this._nav = root.querySelector('.room-nav');
    this._list = root.querySelector('.panel-list');
    this._status = root.querySelector('.status');
    this._buttons = {
      start: root.querySelector('.start'), review: root.querySelector('.review'),
      prepare: root.querySelector('.prepare'), verify: root.querySelector('.verify'),
      merge: root.querySelector('.merge'), stop: root.querySelector('.stop'),
    };
    this._state = createOpsRoomState();
    this._cwd = '';
    this._view = 'tasks';
    this._buildViews();
    root.querySelector('.close').addEventListener('click', () => this.close());
    this._buttons.start.addEventListener('click', () => this._startExecution());
    this._buttons.review.addEventListener('click', () => this._startReview());
    this._buttons.prepare.addEventListener('click', () => this._prepareVerification());
    this._buttons.verify.addEventListener('click', () => this._runVerification());
    this._buttons.merge.addEventListener('click', () => this._merge());
    this._buttons.stop.addEventListener('click', () => this._stop());
  }

  _buildViews() {
    this._views = {};
    for (const [id, label] of VIEWS) {
      const button = document.createElement('button');
      button.type = 'button'; button.role = 'tab'; button.textContent = label;
      button.setAttribute('aria-selected', id === this._view ? 'true' : 'false');
      button.addEventListener('click', () => this._selectView(id));
      this._nav.appendChild(button);
      const view = document.createElement('section');
      view.className = 'view'; view.dataset.view = id; view.hidden = id !== this._view;
      this._list.appendChild(view); this._views[id] = view;
    }
  }

  _selectView(id) {
    if (!this._views[id]) return;
    this._view = id;
    for (const [index, [viewId]] of VIEWS.entries()) {
      this._views[viewId].hidden = viewId !== id;
      this._nav.children[index].setAttribute('aria-selected', viewId === id ? 'true' : 'false');
    }
  }

  _dispatch(action) {
    this._state = opsRoomReducer(this._state, action);
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
    const card = document.createElement('article');
    card.className = 'work-card'; card.dataset.state = text(data.state);
    const head = document.createElement('div'); head.className = 'work-card-head';
    const title = document.createElement('div'); title.className = 'work-card-title'; title.textContent = text(data.title);
    const state = document.createElement('div'); state.className = 'work-card-state'; state.textContent = text(data.stateLabel || data.state);
    head.appendChild(title); head.appendChild(state);
    let body = null;
    if (typeof data.body === 'function') {
      const toggle = document.createElement('button');
      toggle.className = 'work-card-toggle'; toggle.type = 'button'; toggle.textContent = 'التفاصيل';
      toggle.setAttribute('aria-expanded', 'false');
      head.appendChild(toggle);
      body = document.createElement('div'); body.className = 'work-card-body'; body.hidden = true;
      data.body(body);
      toggle.addEventListener('click', () => {
        body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      });
    }
    card.appendChild(head);
    const summary = document.createElement('div'); summary.className = 'work-card-summary';
    summary.dir = 'auto'; summary.textContent = text(data.summary) || 'لا توجد خلاصة إضافية.'; card.appendChild(summary);
    if (body) card.appendChild(body);
    const foot = document.createElement('div'); foot.className = 'work-card-foot';
    const values = [
      ['الفاعل', text(data.actor) || 'system', false],
      ['المحرك', engineLabel(data.engine), false],
      ['الأثر', text(data.artifact) || 'غير متاح', true],
      ['الوقت', timeLabel(data.time), false],
    ];
    for (const [label, value, technical] of values) {
      const item = document.createElement('span'); item.textContent = label + ': ';
      const content = document.createElement('bdi'); content.textContent = value;
      if (technical) content.className = 'work-card-tech';
      item.appendChild(content); foot.appendChild(item);
    }
    card.appendChild(foot);
    return card;
  }

  _setupCard() {
    const setup = document.createElement('section'); setup.className = 'setup';
    const head = document.createElement('div'); head.className = 'setup-head';
    const title = document.createElement('strong'); title.textContent = 'فريق تنفيذ جديد';
    const countWrap = document.createElement('label'); countWrap.textContent = 'عدد العوامل ';
    const count = document.createElement('select'); count.setAttribute('aria-label', 'عدد عوامل التنفيذ');
    for (let value = 1; value <= 3; value++) {
      const option = document.createElement('option'); option.value = String(value); option.textContent = String(value);
      if (value === 2) option.selected = true; count.appendChild(option);
    }
    countWrap.appendChild(count); head.appendChild(title); head.appendChild(countWrap); setup.appendChild(head);
    const note = document.createElement('div'); note.className = 'setup-note';
    note.textContent = 'التنفيذ متاح حالياً عبر Claude SDK فقط؛ Codex مراجع قراءة فقط بعد إغلاق حاجز العزل 3A.';
    setup.appendChild(note);
    const inputs = [];
    for (let index = 1; index <= 3; index++) {
      const worker = document.createElement('section'); worker.className = 'worker-input'; worker.hidden = index > 2;
      const workerTitle = document.createElement('div'); workerTitle.className = 'worker-title'; workerTitle.textContent = 'عامل ' + index;
      const task = document.createElement('textarea'); task.className = 'task'; task.maxLength = 4000;
      task.placeholder = 'مهمة العامل ' + index + '…'; task.setAttribute('aria-label', 'مهمة العامل ' + index);
      const ownership = document.createElement('textarea'); ownership.className = 'ownership'; ownership.maxLength = 2048;
      ownership.placeholder = 'src/area/**, tests/area/**'; ownership.setAttribute('aria-label', 'ملكية العامل ' + index);
      worker.appendChild(workerTitle); worker.appendChild(task); worker.appendChild(ownership);
      setup.appendChild(worker); inputs.push(worker);
    }
    count.addEventListener('change', () => inputs.forEach((worker, index) => { worker.hidden = index >= Number(count.value); }));
    this._setup = { count, inputs };
    return setup;
  }

  _renderDecisions() {
    const view = this._views.decisions; view.textContent = '';
    if (this._state.team && this._state.room) {
      const box = document.createElement('div'); box.className = 'decision-box';
      const input = document.createElement('textarea'); input.maxLength = 1000;
      input.placeholder = 'قرار موجز يخص المهمة أو الأثر الحالي…'; input.setAttribute('aria-label', 'نص القرار');
      const action = document.createElement('button'); action.type = 'button'; action.textContent = 'سجّل القرار';
      action.addEventListener('click', () => this._recordDecision(input));
      box.appendChild(input); box.appendChild(action); view.appendChild(box);
    }
    const entries = this._state.entries.filter((entry) => entry.type === 'decision');
    for (const entry of entries) view.appendChild(this._entryCard(entry));
    if (!entries.length && !this._state.team) this._empty(view, 'لا قرارات مسجلة بعد.');
  }

  _renderTasks() {
    const view = this._views.tasks; view.textContent = '';
    const derived = deriveOpsRoomState(this._state);
    if (derived.canStart) view.appendChild(this._setupCard());
    const team = this._state.team;
    if (!team) { if (!derived.canStart) this._empty(view, 'لا يوجد فريق تنفيذ.'); return; }
    for (const agent of team.agents || []) {
      view.appendChild(this._card({
        title: agent.label || 'عامل', state: agent.state, stateLabel: TEAM_STATES[agent.state] || agent.state,
        summary: agent.summary || agent.error || 'ينفّذ داخل worktree معزول.', actor: agent.label || agent.id,
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
      }));
    }
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
        stateLabel: verification.state === 'passed' ? 'نجح' : verification.state === 'failed' ? 'فشل' : verification.state,
        summary: verification.artifact_id === deriveOpsRoomState(this._state).artifactId
          ? 'نتيجة التحقق مرتبطة بالأثر الحالي.' : 'هذه النتيجة تخص أثراً قديماً ولا تفتح الدمج.',
        actor: 'system', engine: 'system', artifact: verification.artifact_id,
        time: this._state.team && this._state.team.updated_at,
        body: (body) => {
          for (const check of verification.checks || []) {
            const row = document.createElement('div'); row.className = 'check-row';
            const label = document.createElement('span'); label.textContent = check.label + ' [' + check.id + ']';
            const result = document.createElement('span'); result.className = 'counts';
            result.textContent = check.command || ('exit=' + (check.exit_code == null ? 'unknown' : check.exit_code)
              + (check.timed_out ? ' · timeout' : '') + ' · ' + (check.duration_ms || 0) + 'ms');
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
    let count = 0;
    for (const agent of (team && team.agents) || []) {
      const changes = agent.changes || {};
      if (!Array.isArray(changes.files) || !changes.files.length) continue;
      count += changes.files.length;
      view.appendChild(this._card({
        title: 'فروقات ' + (agent.label || agent.id), state: agent.state,
        stateLabel: changes.files.length + ' ملفات',
        summary: 'يعرض السطح أسماء الملفات والإحصاءات فقط؛ نص patch يبقى في العملية الرئيسية.',
        actor: agent.label || agent.id, engine: agent.engine || 'sdk', artifact: team.artifact_id, time: team.updated_at,
        body: (body) => {
          for (const file of changes.files) {
            const row = document.createElement('div'); row.className = 'file-row';
            const path = document.createElement('span'); path.className = 'path'; path.textContent = file.rel;
            const counts = document.createElement('span'); counts.className = 'counts';
            counts.textContent = '+' + (file.added || 0) + ' −' + (file.removed || 0);
            row.appendChild(path); row.appendChild(counts); body.appendChild(row);
          }
        },
      }));
    }
    if (!count) this._empty(view, 'لا توجد بيانات فروقات عامة بعد.');
  }

  _renderReview() {
    const view = this._views.review; view.textContent = '';
    const derived = deriveOpsRoomState(this._state);
    const review = this._state.review;
    for (const item of (review && review.reviews) || []) {
      const decision = item.verdict && item.verdict.decision;
      view.appendChild(this._card({
        title: 'مراجعة ' + engineLabel(item.engine), state: decision || item.state,
        stateLabel: decision === 'approve' ? 'موافقة' : decision === 'changes_required' ? 'تغييرات مطلوبة'
          : decision === 'reject' ? 'رفض' : item.state,
        summary: item.summary || item.error || 'مراجعة عمياء قراءة فقط.', actor: 'reviewer',
        engine: item.engine, artifact: item.artifact_id, time: item.updated_at,
      }));
    }
    const gate = document.createElement('div'); gate.className = 'gate-summary';
    gate.textContent = derived.canMerge
      ? 'بوابة الدمج مفتوحة: كل المراجعات وافقت ونجح التحقق للأثر نفسه. يبقى التأكيد الصريح مطلوباً.'
      : 'بوابة الدمج مغلقة حتى توافق كل المراجعات وينجح التحقق التكاملي للأثر نفسه.';
    view.appendChild(gate);
    const entries = this._state.entries.filter((entry) => entry.type === 'review' || entry.type === 'phase_gate');
    for (const entry of entries) view.appendChild(this._entryCard(entry));
  }

  _entryCard(entry) {
    return this._card({
      title: entry.type === 'decision' ? 'قرار مستخدم' : entry.type === 'review' ? 'حدث مراجعة'
        : entry.type === 'verification' ? 'حدث تحقق' : entry.type === 'phase_gate' ? 'انتقال مرحلي' : 'ملاحظة تشغيلية',
      state: entry.type, stateLabel: entry.type, summary: entry.text, actor: entry.actor,
      engine: entry.actor, artifact: entry.artifact_id, time: entry.created_at,
    });
  }

  _render() {
    const derived = deriveOpsRoomState(this._state);
    this._buttons.start.disabled = !derived.canStart;
    this._buttons.start.hidden = !derived.canStart;
    this._buttons.review.hidden = !derived.canReview;
    this._buttons.prepare.hidden = !derived.canPrepareVerification;
    this._buttons.verify.hidden = !derived.canRunVerification;
    this._buttons.merge.hidden = !derived.canMerge;
    this._buttons.stop.hidden = !derived.canStop;
    this._status.textContent = this._state.status || (this._state.pending ? 'جارٍ تنفيذ الانتقال المطلوب…'
      : this._state.team ? (TEAM_STATES[this._state.team.state] || this._state.team.state)
        : 'حدّد المهام والملكية، ثم ابدأ انتقال التنفيذ صراحةً.');
    this._renderDecisions(); this._renderTasks(); this._renderDiscussion();
    this._renderEvidence(); this._renderDiffs(); this._renderReview();
  }

  _confirm(options) {
    return new Promise((resolve) => {
      this.dispatchEvent(new CustomEvent('ops-confirm-request', {
        bubbles: true, detail: { ...options, source: this._buttons[options.kind] || this, resolve },
      }));
    });
  }

  async _startExecution() {
    if (!this._setup) { this._selectView('tasks'); return; }
    const count = Number(this._setup.count.value) || 1;
    const agents = this._setup.inputs.slice(0, count).map((worker) => ({
      task: worker.querySelector('.task').value.trim(),
      ownership: worker.querySelector('.ownership').value.split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean),
    }));
    if (agents.some((agent) => !agent.task || !agent.ownership.length)) {
      this._dispatch({ type: 'status', status: 'اكتب مهمة وملكية ملفات لكل عامل.' }); return;
    }
    const confirmed = await this._confirm({
      kind: 'start', title: 'تأكيد بدء التنفيذ المعزول', confirmLabel: 'ابدأ التنفيذ',
      description: 'سينشئ «سطر» worktree مستقلاً لكل عامل وينفّذ داخل الملكيات المعلنة فقط. لن يدمج شيئاً تلقائياً.',
    });
    if (!confirmed) return;
    this._dispatch({ type: 'pending', action: 'start' });
    let result = null;
    try { result = await window.satr.executionTeamStart(this._cwd, agents, true, 'mergeable'); } catch {}
    if (!result || !result.ok) {
      this._dispatch({ type: 'settled', status: ERROR_LABELS[result && result.error] || 'تعذّر بدء فريق التنفيذ.' }); return;
    }
    this._dispatch({ type: 'settled', team: result.team, status: 'بدأ التنفيذ داخل النسخ المعزولة.' });
    await this._loadRoom(result.team && result.team.room_id);
  }

  async _startReview() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canReview) return;
    this._dispatch({ type: 'pending', action: 'review' });
    let result = null;
    try { result = await window.satr.executionReviewStart(this._state.team.id); } catch {}
    this._dispatch({ type: 'settled', ...(result && result.review ? { review: result.review } : {}),
      status: result && result.ok ? 'بدأت المراجعات المستقلة.' : (ERROR_LABELS[result && result.error] || 'تعذّر بدء المراجعة.') });
  }

  async _prepareVerification() {
    const derived = deriveOpsRoomState(this._state);
    if (!derived.canPrepareVerification) return;
    this._dispatch({ type: 'pending', action: 'prepare' });
    let result = null;
    try { result = await window.satr.executionVerificationPrepare(this._state.team.id, this._state.review.id); } catch {}
    this._dispatch({ type: 'settled', ...(result && result.verification ? { verification: result.verification } : {}),
      status: result && result.ok ? 'ثُبّتت اختبارات الأثر وتنتظر تأكيد التشغيل.'
        : (ERROR_LABELS[result && result.error] || 'تعذّر تثبيت التحقق.') });
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
        : (ERROR_LABELS[result && result.error] || 'تعذّر تشغيل التحقق التكاملي.') });
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
      status: result && result.ok ? 'طُبّق الأثر بلا commit.'
        : (ERROR_LABELS[result && result.error] || 'تعذّر الدمج بأمان.') });
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
      status: result && result.ok ? 'أُوقف الانتقال الجاري.' : 'تعذّر إيقاف الانتقال الجاري.' });
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
      : (ERROR_LABELS[result && result.error] || 'تعذّر تسجيل القرار.') });
  }

  async _loadRoom(roomId) {
    if (!roomId) return;
    try {
      const loaded = await window.satr.opsRoomLoad(roomId);
      if (loaded && loaded.room) {
        this._state = opsRoomReducer(this._state, {
          type: 'hydrate', room: loaded.room, team: this._state.team,
          review: this._state.review, verification: this._state.verification,
        });
        this._render();
      }
    } catch {}
  }

  async open(cwd) {
    this._cwd = typeof cwd === 'string' ? cwd : '';
    this.setAttribute('open', '');
    this._state = createOpsRoomState(); this._render();
    let team = null; let review = null; let verification = null; let room = null;
    try {
      const latest = await window.satr.executionTeamLatest(this._cwd);
      team = latest && latest.team;
      if (team) {
        const reviewed = await window.satr.executionReviewLatest(team.id);
        review = reviewed && reviewed.review;
        const verified = await window.satr.executionVerificationLatest(team.id);
        verification = verified && verified.verification || team.verification;
        if (team.room_id) {
          const loaded = await window.satr.opsRoomLoad(team.room_id);
          room = loaded && loaded.room;
        }
      }
    } catch {}
    this._dispatch({ type: 'hydrate', room, team, review, verification });
  }

  close() {
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('panel-close', { bubbles: true }));
  }

  focusInitial() {
    const close = this._root.querySelector('.close'); if (close) close.focus();
  }

  handleEvent(event) {
    if (!event) return;
    this._dispatch({ type: 'event', event });
  }
}

customElements.define('satr-ops-dialog', SatrOpsDialog);
customElements.define('satr-ops-room', SatrOpsRoom);
