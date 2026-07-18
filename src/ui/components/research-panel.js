// <satr-research-panel> — فريق بحث قراءة فقط (الأولوية 6/الخطوة 1).
// يبدأ 1–3 باحثين SDK في وضع plan، ويعرض حالاتهم وكلفتهم وخلاصاتهم ومصادرهم.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host { width: 520px; }
  .setup { display: grid; gap: 9px; padding: 13px; border-bottom: 1px solid var(--border); }
  textarea, select {
    width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: 8px 10px; font-family: var(--sans); font-size: 13px; outline: none;
  }
  textarea { min-height: 86px; resize: vertical; unicode-bidi: plaintext; line-height: 1.6; }
  textarea:focus, select:focus { border-color: var(--gold); }
  .setup-row { display: flex; gap: 8px; align-items: center; }
  .setup-row select { width: 150px; }
  .setup-row .start { color: var(--gold); border-color: var(--gold-border); }
  .setup-hint, .status { color: var(--text-dim); font-size: 11.5px; line-height: 1.6; }
  .status { padding: 7px 13px; min-height: 30px; border-bottom: 1px solid var(--border); }
  .stop { color: var(--red); }
  .agent-card { margin: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
  .agent-head { display: flex; align-items: baseline; gap: 8px; padding: 7px 12px; font-size: 12.5px; background: var(--gold-soft); }
  .agent-head .aname { color: var(--gold); font-weight: 600; white-space: nowrap; }
  .agent-head .adesc { color: var(--text-dim); flex: 1; }
  .agent-head .state { flex: none; font-size: 11px; color: var(--text-dim); }
  .agent-card.completed .state { color: var(--green); }
  .agent-card.failed .state, .agent-card.timed_out .state { color: var(--red); }
  .agent-meta { padding: 6px 12px; color: var(--text-faint); font: 10.5px var(--mono); direction: ltr; text-align: left; }
  .agent-summary { padding: 6px 13px 10px; white-space: pre-wrap; unicode-bidi: plaintext; line-height: 1.7; font-size: 12.5px; }
  .sources { padding: 0 13px 10px; display: flex; flex-wrap: wrap; gap: 5px; }
  .source { padding: 2px 7px; font: 10.5px var(--mono); direction: ltr; color: var(--gold); }
  .merged { margin: 10px 12px 16px; padding: 11px 13px; border: 1px solid var(--green-border); border-radius: var(--radius-lg); }
  .merged h3 { color: var(--green); font-size: 13px; margin-bottom: 7px; }
  .merged pre { white-space: pre-wrap; unicode-bidi: plaintext; font: 12.5px/1.7 var(--sans); color: var(--text); }
  .empty { padding: 24px 16px; text-align: center; color: var(--text-dim); font-size: 13px; line-height: 1.8; }
`);

const STATE_LABELS = {
  queued: 'بانتظار البدء', running: 'يبحث…', completed: '✓ مكتمل', failed: 'فشل',
  timed_out: 'انتهت المهلة', stopped: 'متوقف',
};

class SatrResearchPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head"><span>فريق البحث</span><div class="panel-head-actions">' +
        '<button class="stop" type="button" hidden>إيقاف الكل</button><button class="close" type="button">✕</button>' +
      '</div></div>' +
      '<div class="setup"><textarea class="question" maxlength="4000" placeholder="ما السؤال الذي تريد بحثه داخل المشروع؟"></textarea>' +
        '<div class="setup-row"><select class="count"><option value="1">باحث واحد</option><option value="2">باحثان</option><option value="3">3 باحثين</option></select>' +
        '<button class="start" type="button">ابدأ البحث</button></div>' +
        '<div class="setup-hint">قراءة فقط: بلا كتابة أو أوامر أو أذونات. كل باحث مستقل وله مهلة محدودة.</div></div>' +
      '<div class="status" aria-live="polite"></div><div class="panel-list"><div class="empty">ابدأ بسؤال محدد؛ سيعيد الباحث خلاصة ومصادر من ملفات المشروع.</div></div>';
    this._question = root.querySelector('.question');
    this._count = root.querySelector('.count');
    this._start = root.querySelector('.start');
    this._stop = root.querySelector('.stop');
    this._status = root.querySelector('.status');
    this._list = root.querySelector('.panel-list');
    this._cwd = '';
    this._run = null;
    root.querySelector('.close').addEventListener('click', () => this.close());
    this._start.addEventListener('click', () => this._startResearch());
    this._stop.addEventListener('click', () => this._stopResearch());
  }

  close() { this.removeAttribute('open'); }

  _terminal(state) { return ['completed', 'failed', 'timed_out', 'stopped'].includes(state); }

  _costText(cost, duration) {
    const value = cost || {};
    const tokens = (value.input_tokens || 0) + (value.output_tokens || 0);
    const parts = [];
    if (tokens) parts.push((value.estimate ? '≈' : '') + tokens + ' tokens');
    if (value.usd) parts.push('$' + Number(value.usd).toFixed(4));
    if (duration) parts.push((duration / 1000).toFixed(1) + 's');
    return parts.join(' · ');
  }

  _sourceButton(source) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'source'; button.textContent = source;
    button.addEventListener('click', () => {
      const match = source.match(/^(.*?):(\d+)$/);
      this.dispatchEvent(new CustomEvent('research-source', {
        detail: { rel: match ? match[1] : source, line: match ? Number(match[2]) : 0 },
      }));
    });
    return button;
  }

  _render() {
    const run = this._run;
    this._list.innerHTML = '';
    if (!run) {
      this._list.innerHTML = '<div class="empty">ابدأ بسؤال محدد؛ سيعيد الباحث خلاصة ومصادر من ملفات المشروع.</div>';
      this._stop.hidden = true; this._start.disabled = false; return;
    }
    const active = !this._terminal(run.state);
    this._stop.hidden = !active;
    this._start.disabled = active;
    this._status.textContent = active
      ? 'يعمل ' + run.workers.filter((worker) => worker.state === 'running').length + ' من ' + run.workers.length + ' باحثين…'
      : (run.state === 'completed' ? '✓ اكتمل البحث' : 'انتهى البحث: ' + (STATE_LABELS[run.state] || run.state));
    for (const worker of run.workers) {
      const card = document.createElement('article'); card.className = 'agent-card ' + worker.state;
      const head = document.createElement('div'); head.className = 'agent-head';
      const name = document.createElement('span'); name.className = 'aname'; name.textContent = '🔎 ' + worker.label;
      const desc = document.createElement('span'); desc.className = 'adesc'; desc.textContent = 'باحث قراءة فقط';
      const state = document.createElement('span'); state.className = 'state'; state.textContent = STATE_LABELS[worker.state] || worker.state;
      head.appendChild(name); head.appendChild(desc); head.appendChild(state); card.appendChild(head);
      const meta = document.createElement('div'); meta.className = 'agent-meta';
      meta.textContent = this._costText(worker.cost, worker.duration_ms) + (worker.permission_denied ? ' · denied=' + worker.permission_denied : '');
      if (meta.textContent) card.appendChild(meta);
      const summary = document.createElement('div'); summary.className = 'agent-summary'; summary.dir = 'auto';
      summary.textContent = worker.summary || worker.error || (worker.state === 'running' ? 'جارٍ جمع الأدلة…' : '');
      if (summary.textContent) card.appendChild(summary);
      if (worker.sources && worker.sources.length) {
        const sources = document.createElement('div'); sources.className = 'sources';
        for (const source of worker.sources) sources.appendChild(this._sourceButton(source));
        card.appendChild(sources);
      }
      this._list.appendChild(card);
    }
    if (run.summary) {
      const merged = document.createElement('section'); merged.className = 'merged';
      const title = document.createElement('h3'); title.textContent = 'الخلاصة المدموجة';
      const text = document.createElement('pre'); text.dir = 'auto'; text.textContent = run.summary;
      merged.appendChild(title); merged.appendChild(text);
      if (run.sources && run.sources.length) {
        const sources = document.createElement('div'); sources.className = 'sources';
        for (const source of run.sources) sources.appendChild(this._sourceButton(source));
        merged.appendChild(sources);
      }
      this._list.appendChild(merged);
    }
  }

  async _startResearch() {
    const question = this._question.value.trim();
    if (!question) { this._status.textContent = 'اكتب سؤال البحث أولاً.'; this._question.focus(); return; }
    this._status.textContent = 'جارٍ بدء الباحثين…'; this._start.disabled = true;
    let result;
    try { result = await window.satr.researchStart(this._cwd, question, Number(this._count.value)); }
    catch { result = null; }
    if (!result || !result.ok) {
      this._status.textContent = result && result.error === 'busy' ? 'يوجد فريق بحث يعمل بالفعل.' : 'تعذّر بدء البحث.';
      this._start.disabled = false; return;
    }
    this._run = result.run; this._render();
  }

  async _stopResearch() {
    if (!this._run) return;
    this._stop.disabled = true;
    try {
      const result = await window.satr.researchStop(this._run.id);
      if (result && result.run) this._run = result.run;
    } catch { this._status.textContent = 'تعذّر إيقاف الفريق.'; }
    this._stop.disabled = false; this._render();
  }

  handleEvent(event) {
    if (!event || event.type !== 'research_update' || !event.run) return;
    this._run = event.run;
    this._render();
  }

  async open(cwd) {
    this._cwd = typeof cwd === 'string' ? cwd : '';
    this.setAttribute('open', '');
    try {
      const latest = await window.satr.researchLatest(this._cwd);
      this._run = latest && latest.run ? latest.run : null;
    } catch { /* أفضل جهد */ }
    this._render();
    this._question.focus();
  }
}

customElements.define('satr-research-panel', SatrResearchPanel);
