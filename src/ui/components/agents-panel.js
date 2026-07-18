// <satr-agents-panel> — لوحة «/وكلاء»: الوكلاء الفرعيون المكتشفون (قراءة فقط — المرحلة 14.2).
// أول مكوّن من تفكيك الواجهة (ت-1 — docs/COMPONENTS-PLAN.md): نقل حرفي لمنطق openAgents
// من القشرة بلا أي تغيير سلوك. العقد: open(cwd) يفتح ويجلب، close() يغلق،
// وزرّا «تحديث/✕» داخليان. الأنماط عبر adoptedStyleSheets حصراً (CSP يحجب وسم style في Shadow).
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  /* صفوف لوحة /وكلاء — منقولة كما هي من base.css */
  .agent-row { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .agent-row .aname { font-family: var(--mono); direction: ltr; unicode-bidi: embed; color: var(--gold); font-size: 13px; }
  .agent-row .abadge { font-size: 10.5px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1px 7px; color: var(--text-dim); margin-inline-start: 8px; }
  .agent-row .adesc { font-size: 12.5px; color: var(--text-dim); margin-top: 4px; unicode-bidi: plaintext; }
  .agent-row .ameta { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; direction: ltr; text-align: right; font-family: var(--mono); }
`);

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class SatrAgentsPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    // هيكل ثابت (لا مدخلات مستخدم) — innerHTML آمن هنا، ولا أنماط/معالجات مضمّنة (CSP)
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>الوكلاء الفرعيون</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" title="تحديث">تحديث</button>' +
          '<button class="close" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    this._cwd = '';
    r.querySelector('.close').addEventListener('click', () => this.close());
    r.querySelector('.refresh').addEventListener('click', () => this.open(this._cwd));
  }

  close() { this.removeAttribute('open'); }

  async open(cwd) {
    this._cwd = cwd || '';
    this.setAttribute('open', '');
    this._list.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    const list = await window.satr.listAgents(this._cwd);
    this._list.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      this._list.innerHTML =
        '<div class="hint"><p>لا وكلاء فرعيين في المسارين المفحوصين:</p>' +
        '<p><code>' + (this._cwd ? esc(this._cwd) + '\\.claude\\agents\\' : '(لم تختر مجلد مشروع — وكلاء المشروع تحتاج مجلداً 📁)') + '</code><br>' +
        '<code>~\\.claude\\agents\\</code> (وكلاء المستخدم — تظهر في كل المشاريع)</p>' +
        '<p>أنشئ ملف <code>&lt;name&gt;.md</code> في أحدهما بمقدمة ' +
        '<code>name</code> و<code>description</code> (واختيارياً <code>tools</code> و' +
        '<code>model</code>)، وجسم الملف هو برومبت الوكيل — والنموذج يستدعيه تلقائياً ' +
        'حين يناسب وصفه المهمة، وتظهر أعماله بطاقةً متداخلة في المحادثة.</p>' +
        '<p>💡 مستودع «سطر» نفسه فيه وكيل نموذجي: اختر مجلده ثم أعد الفتح.</p></div>';
      return;
    }
    for (const a of list) {
      const row = document.createElement('div');
      row.className = 'agent-row';
      const top = document.createElement('div');
      const nm = document.createElement('span'); nm.className = 'aname'; nm.textContent = a.name;
      const badge = document.createElement('span'); badge.className = 'abadge';
      badge.textContent = a.source === 'project' ? 'المشروع' : 'المستخدم';
      top.appendChild(nm); top.appendChild(badge);
      const desc = document.createElement('div'); desc.className = 'adesc';
      desc.textContent = a.description || '(بلا وصف)';
      const meta = document.createElement('div'); meta.className = 'ameta';
      meta.textContent = (a.model ? a.model + ' · ' : '') +
        (a.tools && a.tools.length ? a.tools.join(', ') : 'يرث كل أدوات الجلسة');
      row.appendChild(top); row.appendChild(desc); row.appendChild(meta);
      this._list.appendChild(row);
    }
  }
}

customElements.define('satr-agents-panel', SatrAgentsPanel);
