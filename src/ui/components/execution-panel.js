// <satr-execution-panel> — فريق من 1–3 عوامل داخل worktrees معزولة وملكيات كتابة معلنة.
// المراجع قراءة فقط؛ زر الدمج لا يظهر إلا بعد مراجعته ويتطلب تأكيداً صريحاً.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host { width: 540px; }
  .setup { display: grid; gap: 9px; padding: 13px; border-bottom: 1px solid var(--border); }
  .team-size { display: flex; align-items: center; gap: 8px; color: var(--text-dim); font-size: 12px; }
  select, textarea {
    background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 8px;
    padding: 7px 9px; font: 12.5px/1.6 var(--sans); outline: none; unicode-bidi: plaintext;
  }
  select:focus, textarea:focus { border-color: var(--gold); }
  .worker-input { display: grid; gap: 6px; padding: 9px; border: 1px solid var(--border); border-radius: 9px; }
  .worker-input[hidden] { display: none; }
  .worker-title { color: var(--gold); font-weight: 600; font-size: 12px; }
  .task { width: 100%; min-height: 64px; resize: vertical; }
  .ownership { width: 100%; min-height: 38px; resize: vertical; direction: ltr; text-align: left; font-family: var(--mono); }
  .start { color: var(--gold); border-color: var(--gold-border); justify-self: start; }
  .stop { color: var(--red); }
  .merge { color: var(--green); border-color: var(--green-border); }
  .hint, .status { color: var(--text-dim); font-size: 11.5px; line-height: 1.7; }
  .status { padding: 8px 13px; min-height: 32px; border-bottom: 1px solid var(--border); }
  .agent-card { margin: 11px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow: hidden; }
  .agent-head { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; background: var(--gold-soft); }
  .aname { color: var(--gold); font-weight: 600; white-space: nowrap; }
  .adesc { flex: 1; color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { color: var(--text-dim); font-size: 11px; }
  .completed .state { color: var(--green); }
  .failed .state, .timed_out .state, .cleanup_failed .state, .conflict .state { color: var(--red); }
  .ownership-view { padding: 6px 12px; color: var(--text-dim); font: 10.5px/1.6 var(--mono); direction: ltr; text-align: left; border-bottom: 1px solid var(--border); }
  .meta { padding: 6px 12px; color: var(--text-faint); font: 10.5px var(--mono); direction: ltr; text-align: left; }
  .summary { padding: 7px 13px 11px; white-space: pre-wrap; unicode-bidi: plaintext; font-size: 12.5px; line-height: 1.7; }
  .changes { margin: 0 12px 12px; border: 1px solid var(--green-border); border-radius: 9px; overflow: hidden; }
  .changes-head { padding: 7px 10px; color: var(--green); font-weight: 600; font-size: 11.5px; background: var(--surface-2); }
  .change { display: flex; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--border); font-size: 11px; }
  .change .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: left; font-family: var(--mono); }
  .change .nums { direction: ltr; font-family: var(--mono); color: var(--text-dim); }
  .warning, .no-merge { margin: 10px 12px; padding: 9px 11px; border: 1px solid var(--gold-border); border-radius: 9px; color: var(--gold); font-size: 11.5px; line-height: 1.7; }
  .warning { color: var(--red); border-color: var(--red-border); }
  .review-card { margin: 11px 12px; border: 1px solid var(--gold-border); border-radius: 10px; overflow: hidden; }
  .review-head { padding: 8px 11px; color: var(--gold); font-weight: 600; background: var(--gold-soft); }
  .recommendation { padding: 7px 11px; color: var(--text-dim); font-size: 11.5px; border-top: 1px solid var(--border); }
  .empty { padding: 24px 16px; text-align: center; color: var(--text-dim); font-size: 13px; line-height: 1.8; }
`);

const STATES = {
  preparing: 'يجهّز النسخ…', queued: 'في الانتظار', running: 'ينفّذ…', capturing: 'يجمع الفرق…',
  stopping: 'يوقف الفريق…', completed: '✓ مكتمل', failed: 'فشل', timed_out: 'انتهت المهلة',
  stopped: 'متوقف', cleanup_failed: 'فشل التنظيف', conflict: 'تعارض',
};

class SatrExecutionPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head"><span>فريق تنفيذ معزول</span><div class="panel-head-actions">' +
        '<button class="merge" type="button" hidden>دمج</button><button class="stop" type="button" hidden>إيقاف الكل</button><button class="close" type="button">✕</button>' +
      '</div></div><div class="setup">' +
        '<label class="team-size">عدد العوامل <select class="count"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select></label>' +
        this._inputMarkup(1) + this._inputMarkup(2) + this._inputMarkup(3) +
        '<button class="start" type="button">أنشئ النسخ ونفّذ</button>' +
        '<div class="hint">ملكية كل عامل مسارات أو أنماط نسبية مفصولة بفاصلة، مثل <bdi>src/ui/**</bdi>. التداخل مرفوض قبل التشغيل.</div>' +
      '</div><div class="status" aria-live="polite"></div><div class="panel-list"><div class="empty">كل عامل يعمل في worktree مستقل. لا تغيير ولا دمج في مجلد مشروعك.</div></div>';
    this._count = root.querySelector('.count');
    this._inputs = [...root.querySelectorAll('.worker-input')];
    this._start = root.querySelector('.start');
    this._stop = root.querySelector('.stop');
    this._merge = root.querySelector('.merge');
    this._status = root.querySelector('.status');
    this._list = root.querySelector('.panel-list');
    this._cwd = '';
    this._team = null;
    this._review = null;
    this._reviewRequested = false;
    root.querySelector('.close').addEventListener('click', () => this.close());
    this._count.addEventListener('change', () => this._syncInputs());
    this._start.addEventListener('click', () => this._startExecution());
    this._stop.addEventListener('click', () => this._stopExecution());
    this._merge.addEventListener('click', () => this._mergeExecution());
    this._syncInputs();
  }

  _inputMarkup(index) {
    return '<section class="worker-input" data-index="' + index + '"><div class="worker-title">عامل ' + index + '</div>' +
      '<textarea class="task" maxlength="4000" placeholder="مهمة العامل ' + index + '…"></textarea>' +
      '<textarea class="ownership" maxlength="2048" dir="ltr" placeholder="src/area/**, tests/area/**"></textarea></section>';
  }

  close() { this.removeAttribute('open'); }
  _terminal(state) { return ['completed', 'failed', 'timed_out', 'stopped', 'cleanup_failed', 'conflict'].includes(state); }
  _reviewActive() { return this._review && !['completed', 'failed', 'timed_out', 'stopped'].includes(this._review.state); }
  _syncInputs() {
    const count = Number(this._count.value) || 1;
    this._inputs.forEach((input, index) => { input.hidden = index >= count; });
  }

  _meta(agent) {
    const cost = agent.cost || {};
    const tokens = (cost.input_tokens || 0) + (cost.output_tokens || 0);
    const parts = [];
    if (tokens) parts.push((cost.estimate ? '≈' : '') + tokens + ' tokens');
    if (cost.usd) parts.push('$' + Number(cost.usd).toFixed(4));
    if (agent.duration_ms) parts.push((agent.duration_ms / 1000).toFixed(1) + 's');
    parts.push('writes=' + ((agent.permissions && agent.permissions.write_used) || 0) + '/' + ((agent.permissions && agent.permissions.write_limit) || 0));
    return parts.join(' · ');
  }

  _renderChanges(agent, card) {
    const changes = agent.changes || { files: [] };
    if (!changes.files || !changes.files.length) return;
    const box = document.createElement('section'); box.className = 'changes';
    const title = document.createElement('div'); title.className = 'changes-head';
    title.textContent = 'الفرق — ' + changes.files.length + ' ملفات · +' + changes.added + ' −' + changes.removed;
    box.appendChild(title);
    for (const file of changes.files) {
      const row = document.createElement('div'); row.className = 'change';
      const rel = document.createElement('span'); rel.className = 'path'; rel.textContent = file.rel;
      const nums = document.createElement('span'); nums.className = 'nums'; nums.textContent = '+' + file.added + ' −' + file.removed;
      row.appendChild(rel); row.appendChild(nums); box.appendChild(row);
    }
    card.appendChild(box);
  }

  _render() {
    const team = this._team;
    this._list.innerHTML = '';
    if (!team) {
      this._list.innerHTML = '<div class="empty">كل عامل يعمل في worktree مستقل. لا تغيير ولا دمج في مجلد مشروعك.</div>';
      this._stop.hidden = true; this._merge.hidden = true; this._start.disabled = false; return;
    }
    const active = !this._terminal(team.state);
    const reviewActive = this._reviewActive();
    this._stop.hidden = !active && !reviewActive; this._start.disabled = active || reviewActive;
    this._stop.textContent = reviewActive ? 'إيقاف المراجع' : 'إيقاف الكل';
    this._merge.hidden = !(this._review && this._review.state === 'completed' && team.merge_supported && !team.merged);
    this._status.textContent = reviewActive ? 'المراجع الثاني يراجع الفرق…' : (STATES[team.state] || team.state);
    for (const agent of team.agents || []) {
      const card = document.createElement('article'); card.className = 'agent-card ' + agent.state;
      const head = document.createElement('div'); head.className = 'agent-head';
      const name = document.createElement('span'); name.className = 'aname'; name.textContent = '🛠️ ' + agent.label;
      const desc = document.createElement('span'); desc.className = 'adesc'; desc.dir = 'auto'; desc.textContent = agent.task;
      const state = document.createElement('span'); state.className = 'state'; state.textContent = STATES[agent.state] || agent.state;
      head.appendChild(name); head.appendChild(desc); head.appendChild(state); card.appendChild(head);
      const ownership = document.createElement('div'); ownership.className = 'ownership-view';
      ownership.textContent = 'owns: ' + (agent.ownership || []).join(', '); card.appendChild(ownership);
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = this._meta(agent); card.appendChild(meta);
      const summary = document.createElement('div'); summary.className = 'summary'; summary.dir = 'auto';
      summary.textContent = agent.summary || agent.error || (active ? 'جارٍ العمل داخل النسخة المعزولة…' : 'بلا خلاصة.');
      card.appendChild(summary); this._renderChanges(agent, card); this._list.appendChild(card);
    }
    if (team.conflicts && team.conflicts.length) {
      const warning = document.createElement('div'); warning.className = 'warning';
      warning.textContent = 'أوقف الفريق بسبب تعارض ملكية أو لمس الملف نفسه. لم يُدمج أي تغيير.';
      this._list.appendChild(warning);
    }
    if (this._review) {
      const reviewCard = document.createElement('section'); reviewCard.className = 'review-card';
      const reviewHead = document.createElement('div'); reviewHead.className = 'review-head';
      reviewHead.textContent = '🔎 المراجع الثاني — ' + (this._review.state === 'completed' ? 'اكتملت المراجعة' : this._review.state === 'running' ? 'يراجع…' : 'تعذّرت المراجعة');
      reviewCard.appendChild(reviewHead);
      const summary = document.createElement('div'); summary.className = 'summary'; summary.dir = 'auto';
      summary.textContent = this._review.summary || this._review.error || 'يفحص المخاطر والملاحظات والتوصية بلا أدوات أو كتابة.';
      reviewCard.appendChild(summary);
      if (this._review.recommendation) {
        const labels = { accept: 'اقبل', modify: 'عدّل', reject: 'ارفض' };
        const recommendation = document.createElement('div'); recommendation.className = 'recommendation';
        recommendation.textContent = 'التوصية: ' + (labels[this._review.recommendation] || this._review.recommendation);
        reviewCard.appendChild(recommendation);
      }
      this._list.appendChild(reviewCard);
    }
    if (this._terminal(team.state)) {
      const notice = document.createElement('div'); notice.className = 'no-merge';
      notice.textContent = team.merged
        ? 'طُبّق الفرق على شجرة عمل مشروعك بعد المراجعة والموافقة الصريحة. لم يُنشأ commit.'
        : 'لم يُدمج أي تغيير بعد. زر الدمج لا يتاح إلا بعد مراجعة ثانية وموافقة صريحة.';
      this._list.appendChild(notice);
    }
  }

  _collectAgents() {
    const count = Number(this._count.value) || 1;
    return this._inputs.slice(0, count).map((input) => ({
      task: input.querySelector('.task').value.trim(),
      ownership: input.querySelector('.ownership').value.split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean),
    }));
  }

  async _startExecution() {
    const agents = this._collectAgents();
    if (agents.some((agent) => !agent.task || !agent.ownership.length)) {
      this._status.textContent = 'اكتب مهمة وملكية ملفات لكل عامل.'; return;
    }
    if (!confirm('سيُنشئ «سطر» worktree مستقلاً لكل عامل وينفّذ بالتوازي داخل الملكيات المعلنة فقط. لن تُدمج التغييرات. هل تبدأ؟')) return;
    this._start.disabled = true; this._status.textContent = 'جارٍ إنشاء worktrees معزولة…';
    let result;
    try { result = await window.satr.executionTeamStart(this._cwd, agents, true); } catch { result = null; }
    if (!result || !result.ok) {
      const labels = {
        no_repo: 'المجلد ليس مستودع Git.', no_head: 'المستودع بلا HEAD.',
        unsafe_links: 'المستودع يحوي symlink أو submodule غير آمن.', busy: 'يوجد فريق منفّذ يعمل بالفعل.',
        ownership_overlap: 'تتداخل ملكيات عاملين. افصل المسارات قبل التشغيل.', bad_input: 'تحقق من المهام وأنماط الملكية.',
      };
      this._status.textContent = labels[result && result.error] || 'تعذّر بدء فريق التنفيذ.';
      this._start.disabled = false; return;
    }
    this._team = result.team; this._review = null; this._reviewRequested = false; this._render();
  }

  async _stopExecution() {
    if (!this._team) return;
    this._stop.disabled = true;
    try {
      if (this._reviewActive()) {
        const result = await window.satr.executionReviewStop(this._review.id);
        if (result && result.review) this._review = result.review;
      } else {
        const result = await window.satr.executionTeamStop(this._team.id);
        if (result && result.team) this._team = result.team;
      }
    } catch { this._status.textContent = 'تعذّر إيقاف الفريق.'; }
    this._stop.disabled = false; this._render();
  }

  handleEvent(event) {
    if (!event) return;
    if (event.type === 'execution_team_update' && event.team) {
      this._team = event.team; this._render();
      if (this._team.state === 'completed' && this._team.merge_supported && !this._review) this._startReview();
    } else if (event.type === 'execution_review_update' && event.review) {
      this._review = event.review; this._render();
    }
  }

  async _startReview() {
    if (!this._team || this._review || this._reviewRequested || !this._team.merge_supported) return;
    this._reviewRequested = true; this._status.textContent = 'جارٍ تشغيل المراجع الثاني…';
    let errorText = '';
    try {
      const result = await window.satr.executionReviewStart(this._team.id);
      if (result && result.review) this._review = result.review;
      else {
        const labels = { secret_detected: 'رُفضت المراجعة لأن الفرق قد يحوي سراً.', diff_too_large: 'الفرق أكبر من ميزانية المراجعة.' };
        errorText = labels[result && result.error] || 'تعذّر بدء المراجعة الثانية.';
        this._review = { state: 'failed', summary: '', error: errorText, recommendation: '' };
      }
    } catch {
      errorText = 'تعذّر بدء المراجعة الثانية.';
      this._review = { state: 'failed', summary: '', error: errorText, recommendation: '' };
    }
    this._render();
    if (errorText) this._status.textContent = errorText;
  }

  async _mergeExecution() {
    if (!this._team || !this._review || this._review.state !== 'completed') return;
    if (!confirm('سيُطبّق «سطر» الفرق المراجع على شجرة عمل مشروعك الآن، بلا commit. يجب أن يكون HEAD مطابقاً والشجرة نظيفة. هل تريد الدمج؟')) return;
    this._merge.disabled = true; this._status.textContent = 'يتحقق من التعارض ثم يطبّق الفرق…';
    let result;
    let statusText = '';
    try { result = await window.satr.executionMerge(this._team.id, this._review.id, true); } catch { result = null; }
    if (result && result.ok) {
      if (result.team) this._team = result.team;
      statusText = 'تم تطبيق الفرق بلا commit.';
    } else {
      const labels = {
        confirmation_required: 'يتطلب الدمج موافقة صريحة.', review_required: 'يجب اكتمال المراجعة أولاً.',
        dirty_worktree: 'شجرة عمل المشروع غير نظيفة؛ لم يُطبّق شيء.', head_changed: 'تغيّر HEAD منذ التنفيذ؛ لم يُطبّق شيء.',
        conflict: 'يتعارض الفرق مع المشروع الحالي؛ لم يُطبّق شيء.', apply_failed: 'تعذّر تطبيق الفرق؛ لم يُنشأ commit.',
      };
      statusText = labels[result && result.error] || 'تعذّر دمج الفرق بأمان.';
    }
    this._merge.disabled = false; this._render();
    this._status.textContent = statusText;
  }

  async open(cwd) {
    this._cwd = typeof cwd === 'string' ? cwd : '';
    this.setAttribute('open', '');
    try {
      const latest = await window.satr.executionTeamLatest(this._cwd);
      this._team = latest && latest.team ? latest.team : null;
      if (this._team) {
        const reviewed = await window.satr.executionReviewLatest(this._team.id);
        this._review = reviewed && reviewed.review ? reviewed.review : null;
      } else this._review = null;
    } catch { this._team = null; this._review = null; }
    this._reviewRequested = !!this._review;
    this._render();
    if (this._team && this._team.state === 'completed' && this._team.merge_supported && !this._review) this._startReview();
  }
}

customElements.define('satr-execution-panel', SatrExecutionPanel);
