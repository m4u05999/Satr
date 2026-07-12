// <satr-execution-panel> — عامل منفّذ واحد داخل git worktree معزول.
// لا merge في هذه الخطوة: تعرض اللوحة خلاصة العامل وملخص git diff بعد حذف النسخة المؤقتة.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host { width: 500px; }
  .setup { display: grid; gap: 9px; padding: 13px; border-bottom: 1px solid var(--border); }
  textarea {
    width: 100%; min-height: 96px; resize: vertical; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: 8px 10px; font: 13px/1.6 var(--sans);
    outline: none; unicode-bidi: plaintext;
  }
  textarea:focus { border-color: var(--gold); }
  .start { color: var(--gold); border-color: var(--gold-border); justify-self: start; }
  .stop { color: var(--red); }
  .hint, .status { color: var(--text-dim); font-size: 11.5px; line-height: 1.7; }
  .status { padding: 8px 13px; min-height: 32px; border-bottom: 1px solid var(--border); }
  .agent-card { margin: 11px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow: hidden; }
  .agent-head { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; background: var(--gold-soft); }
  .aname { color: var(--gold); font-weight: 600; white-space: nowrap; }
  .adesc { flex: 1; color: var(--text-dim); font-size: 12px; }
  .state { color: var(--text-dim); font-size: 11px; }
  .completed .state { color: var(--green); }
  .failed .state, .timed_out .state, .cleanup_failed .state { color: var(--red); }
  .meta { padding: 6px 12px; color: var(--text-faint); font: 10.5px var(--mono); direction: ltr; text-align: left; }
  .summary { padding: 7px 13px 11px; white-space: pre-wrap; unicode-bidi: plaintext; font-size: 12.5px; line-height: 1.7; }
  .changes { margin: 11px 12px 16px; border: 1px solid var(--green-border); border-radius: 10px; overflow: hidden; }
  .changes-head { padding: 8px 11px; color: var(--green); font-weight: 600; font-size: 12.5px; background: var(--surface-2); }
  .change { display: flex; gap: 8px; padding: 7px 11px; border-top: 1px solid var(--border); font-size: 11.5px; }
  .change .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: left; font-family: var(--mono); }
  .change .nums { direction: ltr; font-family: var(--mono); color: var(--text-dim); }
  .no-merge { margin: 10px 12px; padding: 9px 11px; border: 1px solid var(--gold-border); border-radius: 9px; color: var(--gold); font-size: 11.5px; line-height: 1.7; }
  .empty { padding: 24px 16px; text-align: center; color: var(--text-dim); font-size: 13px; line-height: 1.8; }
`);

const STATES = {
  running: 'ينفّذ…', capturing: 'يجمع الفرق…', completed: '✓ مكتمل', failed: 'فشل',
  timed_out: 'انتهت المهلة', stopped: 'متوقف', cleanup_failed: 'فشل التنظيف',
};

class SatrExecutionPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head"><span>تنفيذ معزول</span><div class="panel-head-actions">' +
        '<button class="stop" type="button" hidden>إيقاف</button><button class="close" type="button">✕</button>' +
      '</div></div>' +
      '<div class="setup"><textarea class="task" maxlength="4000" placeholder="صف التعديل المطلوب داخل نسخة العمل المعزولة…"></textarea>' +
        '<button class="start" type="button">أنشئ نسخة ونفّذ</button>' +
        '<div class="hint">ينفّذ عامل SDK واحد داخل worktree مؤقت من HEAD. لا أوامر، لا Git، ولا دمج تلقائي.</div></div>' +
      '<div class="status" aria-live="polite"></div><div class="panel-list"><div class="empty">لن يتغير مجلد مشروعك. بعد التنفيذ سترى ملخص الفرق فقط.</div></div>';
    this._task = root.querySelector('.task');
    this._start = root.querySelector('.start');
    this._stop = root.querySelector('.stop');
    this._status = root.querySelector('.status');
    this._list = root.querySelector('.panel-list');
    this._cwd = '';
    this._run = null;
    root.querySelector('.close').addEventListener('click', () => this.close());
    this._start.addEventListener('click', () => this._startExecution());
    this._stop.addEventListener('click', () => this._stopExecution());
  }

  close() { this.removeAttribute('open'); }
  _terminal(state) { return ['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed'].includes(state); }

  _meta(run) {
    const cost = run.cost || {};
    const tokens = (cost.input_tokens || 0) + (cost.output_tokens || 0);
    const parts = [];
    if (tokens) parts.push((cost.estimate ? '≈' : '') + tokens + ' tokens');
    if (cost.usd) parts.push('$' + Number(cost.usd).toFixed(4));
    if (run.duration_ms) parts.push((run.duration_ms / 1000).toFixed(1) + 's');
    parts.push('writes=' + ((run.permissions && run.permissions.write_used) || 0) + '/' + ((run.permissions && run.permissions.write_limit) || 0));
    return parts.join(' · ');
  }

  _render() {
    const run = this._run;
    this._list.innerHTML = '';
    if (!run) {
      this._list.innerHTML = '<div class="empty">لن يتغير مجلد مشروعك. بعد التنفيذ سترى ملخص الفرق فقط.</div>';
      this._stop.hidden = true; this._start.disabled = false; return;
    }
    const active = !this._terminal(run.state);
    this._stop.hidden = !active; this._start.disabled = active;
    this._status.textContent = active ? (STATES[run.state] || run.state) : (STATES[run.state] || run.state);
    const card = document.createElement('article'); card.className = 'agent-card ' + run.state;
    const head = document.createElement('div'); head.className = 'agent-head';
    const name = document.createElement('span'); name.className = 'aname'; name.textContent = '🛠️ عامل منفّذ';
    const desc = document.createElement('span'); desc.className = 'adesc'; desc.textContent = run.worktree ? run.worktree.repo_name + ' · worktree معزول' : 'worktree معزول';
    const state = document.createElement('span'); state.className = 'state'; state.textContent = STATES[run.state] || run.state;
    head.appendChild(name); head.appendChild(desc); head.appendChild(state); card.appendChild(head);
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = this._meta(run); card.appendChild(meta);
    const summary = document.createElement('div'); summary.className = 'summary'; summary.dir = 'auto';
    summary.textContent = run.summary || run.error || (active ? 'جارٍ تنفيذ التعديلات داخل النسخة المؤقتة…' : '');
    card.appendChild(summary); this._list.appendChild(card);
    const changes = run.changes || { files: [] };
    if (changes.files && changes.files.length) {
      const box = document.createElement('section'); box.className = 'changes';
      const title = document.createElement('div'); title.className = 'changes-head';
      title.textContent = 'ملخص الفرق — ' + changes.files.length + ' ملفات · +' + changes.added + ' −' + changes.removed;
      box.appendChild(title);
      for (const file of changes.files) {
        const row = document.createElement('div'); row.className = 'change';
        const rel = document.createElement('span'); rel.className = 'path'; rel.textContent = file.rel;
        const nums = document.createElement('span'); nums.className = 'nums'; nums.textContent = '+' + file.added + ' −' + file.removed;
        row.appendChild(rel); row.appendChild(nums); box.appendChild(row);
      }
      this._list.appendChild(box);
    }
    if (this._terminal(run.state)) {
      const notice = document.createElement('div'); notice.className = 'no-merge';
      notice.textContent = 'لم يُدمج أي تغيير في مشروعك. الدمج غير متاح في هذه الخطوة وسيحتاج موافقة صريحة لاحقاً.';
      this._list.appendChild(notice);
    }
  }

  async _startExecution() {
    const task = this._task.value.trim();
    if (!task) { this._status.textContent = 'اكتب مهمة التنفيذ أولاً.'; this._task.focus(); return; }
    if (!confirm('سيُنشئ «سطر» worktree مؤقتاً من HEAD وينفّذ التعديل داخله فقط. لن تُدمج التغييرات في مشروعك. هل تبدأ؟')) return;
    this._start.disabled = true; this._status.textContent = 'جارٍ إنشاء worktree معزول…';
    let result;
    try { result = await window.satr.executionStart(this._cwd, task, true); } catch { result = null; }
    if (!result || !result.ok) {
      const labels = { no_repo: 'المجلد ليس مستودع Git.', no_head: 'المستودع بلا HEAD.', unsafe_links: 'المستودع يحوي symlink أو submodule غير آمن للتنفيذ المعزول.', busy: 'يوجد عامل منفّذ يعمل بالفعل.' };
      this._status.textContent = labels[result && result.error] || 'تعذّر بدء التنفيذ المعزول.';
      this._start.disabled = false; return;
    }
    this._run = result.run; this._render();
  }

  async _stopExecution() {
    if (!this._run) return;
    this._stop.disabled = true;
    try {
      const result = await window.satr.executionStop(this._run.id);
      if (result && result.run) this._run = result.run;
    } catch { this._status.textContent = 'تعذّر إيقاف العامل.'; }
    this._stop.disabled = false; this._render();
  }

  handleEvent(event) {
    if (!event || event.type !== 'execution_update' || !event.run) return;
    this._run = event.run; this._render();
  }

  async open(cwd) {
    this._cwd = typeof cwd === 'string' ? cwd : '';
    this.setAttribute('open', '');
    try {
      const latest = await window.satr.executionLatest(this._cwd);
      this._run = latest && latest.run ? latest.run : null;
    } catch { this._run = null; }
    this._render(); this._task.focus();
  }
}

customElements.define('satr-execution-panel', SatrExecutionPanel);
