// <satr-context-panel> — لوحة «/سياق»: امتلاء نافذة السياق وتوزيع الرموز (تفكيك ت-3).
// العقد: open(cwd, sessionId, busy) — حالة الجلسة/الانشغال ملك القشرة وتُمرَّر لحظة
// الفتح (لا يقرؤها المكوّن)؛ close() يغلق؛ حدث «panel-refresh» من زر تحديث كي تعيد
// القشرة الفتح بحالة طازجة (busy/sessionId يتغيّران واللوحة مفتوحة). نقل حرفي (ت-3).
// أشرطة النسب عبر CSSOM (style.width من JS) — مسموح تحت CSP (المحظور السمات المضمّنة).
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  /* لوحة السياق — منقولة كما هي من base.css */
  .ctx-top { padding: var(--space-4); border-bottom: 1px solid var(--border); }
  .ctx-pct { font-size: 26px; font-weight: 700; color: var(--gold); font-family: var(--mono); direction: ltr; }
  .ctx-tokens { font-size: 12.5px; color: var(--text-dim); font-family: var(--mono); direction: ltr; margin-top: 2px; }
  .ctx-model { font-size: 12px; color: var(--text-dim); direction: ltr; margin-top: var(--space-1); }
  .ctx-bar { height: 10px; border-radius: var(--radius-sm); background: var(--surface-2); overflow: hidden; margin-top: var(--space-2h); border: 1px solid var(--border); }
  .ctx-bar > span { display: block; height: 100%; background: var(--gold); }
  .ctx-cat { padding: var(--space-2h) var(--space-4); border-bottom: 1px solid var(--border); }
  .ctx-cat-row { display: flex; align-items: baseline; gap: var(--space-2); }
  .ctx-cat-name { font-size: 13px; flex: 1; min-width: 0; unicode-bidi: plaintext; }
  .ctx-cat-tok { font-size: 12px; color: var(--text-dim); font-family: var(--mono); direction: ltr; }
  .ctx-cat-bar { height: 5px; border-radius: var(--radius-xs); background: var(--surface-2); overflow: hidden; margin-top: var(--space-1h); }
  .ctx-cat-bar > span { display: block; height: 100%; background: var(--gold); opacity: .75; }
  /* ملاحظات أسفل المؤشر — نفس نمط mcp-hint (نسخة اللوحة، الأصل انتقل لمكوّن الموصّلات) */
  .mcp-hint { font-size: 12px; color: var(--text-dim); margin-top: var(--space-1h); unicode-bidi: plaintext; line-height: 1.6; }
`);

const fmtTok = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

class SatrContextPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>السياق</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" title="تحديث">تحديث</button>' +
          '<button class="close" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    r.querySelector('.close').addEventListener('click', () => this.close());
    r.querySelector('.refresh').addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('panel-refresh')));
  }

  close() { this.removeAttribute('open'); }

  async open(cwd, sessionId, busy) {
    this.setAttribute('open', '');
    this._list.innerHTML = '<div class="hint">جارٍ الحساب…</div>';
    const r = await window.satr.contextUsage(cwd || '', sessionId);
    this._list.innerHTML = '';
    if (!r || !r.ok) {
      const h = document.createElement('div'); h.className = 'hint';
      h.textContent = '✗ تعذّر حساب السياق' + (r && r.error ? ' — ' + r.error : '');
      this._list.appendChild(h);
      return;
    }
    this.dispatchEvent(new CustomEvent('context-usage', { bubbles: true, composed: true, detail: r.usage }));
    this._render(r.usage, sessionId, busy);
  }

  _render(u, sessionId, busy) {
    const total = typeof u.totalTokens === 'number' ? u.totalTokens : 0;
    const max = typeof u.maxTokens === 'number' && u.maxTokens > 0 ? u.maxTokens : 0;
    const pct = typeof u.percentage === 'number' ? u.percentage : (max ? Math.round((total / max) * 100) : 0);

    const top = document.createElement('div'); top.className = 'ctx-top';
    const pctEl = document.createElement('div'); pctEl.className = 'ctx-pct'; pctEl.dir = 'ltr';
    pctEl.textContent = pct + '%';
    const tok = document.createElement('div'); tok.className = 'ctx-tokens'; tok.dir = 'ltr';
    tok.textContent = fmtTok(total) + ' / ' + fmtTok(max) + ' tokens';
    top.appendChild(pctEl); top.appendChild(tok);
    if (u.model) {
      const md = document.createElement('div'); md.className = 'ctx-model'; md.dir = 'ltr';
      md.textContent = u.model;
      top.appendChild(md);
    }
    const bar = document.createElement('div'); bar.className = 'ctx-bar';
    const fill = document.createElement('span'); fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
    bar.appendChild(fill); top.appendChild(bar);
    if (!sessionId) {
      const note = document.createElement('div'); note.className = 'mcp-hint';
      note.textContent = 'جلسة جديدة — هذا هو السياق الأساس (تعليمات وأدوات وذاكرة) قبل أي رسائل.';
      top.appendChild(note);
    } else if (busy) {
      const note = document.createElement('div'); note.className = 'mcp-hint';
      note.textContent = 'هناك طلب جارٍ — قد يكون القياس تقريبياً حتى انتهائه.';
      top.appendChild(note);
    }
    this._list.appendChild(top);

    // صفوف الفئات (عدا «الفراغ» الذي تعكسه النسبة أصلاً)
    const cats = Array.isArray(u.categories) ? u.categories : [];
    for (const c of cats) {
      if (/free/i.test(c.name) || !c.tokens) continue;
      const cell = document.createElement('div'); cell.className = 'ctx-cat';
      const r = document.createElement('div'); r.className = 'ctx-cat-row';
      const nm = document.createElement('span'); nm.className = 'ctx-cat-name';
      nm.textContent = c.name + (c.isDeferred ? ' (مؤجّل)' : '');
      const tk = document.createElement('span'); tk.className = 'ctx-cat-tok'; tk.dir = 'ltr';
      tk.textContent = fmtTok(c.tokens);
      r.appendChild(nm); r.appendChild(tk);
      const cb = document.createElement('div'); cb.className = 'ctx-cat-bar';
      const cf = document.createElement('span');
      cf.style.width = Math.min(100, total ? (c.tokens / total) * 100 : 0) + '%';
      cf.style.opacity = c.isDeferred ? '0.4' : '0.75';
      cb.appendChild(cf);
      cell.appendChild(r); cell.appendChild(cb);
      this._list.appendChild(cell);
    }
  }
}

customElements.define('satr-context-panel', SatrContextPanel);
