// <satr-mcp-panel> — لوحة «/موصلات»: حالة خوادم MCP وإجراءاتها (تفكيك ت-3).
// العقد: open(cwd) يفتح ويجلب عبر satr:mcpStatus، close() يغلق. أحداث للخارج:
// «panel-refresh» من زر تحديث (القشرة تعيد الفتح بـ cwd طازج) و«notice» بنص عربي
// (القشرة تعرضه في خيط المحادثة عبر addNotice). الإجراءات (تفعيل/تعطيل/إعادة اتصال)
// داخلية عبر satr:mcpAction ثم إعادة عرض تكشف الحالة الفعلية. نقل حرفي (ت-3).
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  /* صفوف الموصّلات — منقولة كما هي من base.css */
  .mcp { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .mcp-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .mcp-name { font-family: var(--mono); color: var(--gold); font-size: 13px; direction: ltr; flex: 1; min-width: 0; word-break: break-all; }
  .mcp-badge { font-size: 11px; border-radius: var(--radius-sm); padding: 1px 8px; white-space: nowrap; border: 1px solid var(--border); }
  .mcp-badge.connected { color: var(--green); border-color: var(--green-border); }
  .mcp-badge.pending   { color: var(--gold); border-color: var(--gold-border); }
  /* التمييز عن pending بالخلفية والحد الذهبيين؛ النص --text لتباين ≥4.5:1 على الخلفية
     المدموجة في الوضعين (الذهب نفسه 3.89:1 فقط في الفاتح على gold-soft فوق surface) */
  .mcp-badge.needsauth { color: var(--text); background: var(--gold-soft); border-color: var(--gold-border); }
  .mcp-badge.failed    { color: var(--red); border-color: var(--red-border); }
  .mcp-badge.disabled  { color: var(--text-dim); }
  .mcp-meta { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; direction: ltr; text-align: right; font-family: var(--mono); }
  .mcp-hint { font-size: 12px; color: var(--text-dim); margin-top: 5px; unicode-bidi: plaintext; line-height: 1.6; }
  .mcp-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .mcp-actions button { font-size: 12px; padding: 3px 11px; }
  .mcp-actions button:disabled { opacity: .55; cursor: default; border-color: var(--border); }
  /* إرشاد حالة الفراغ (كان .skill-hint المشترك في base.css — دَينُ ت-2 حُسم هنا) */
  .skill-hint { padding: 16px; color: var(--text-dim); font-size: 13px; line-height: 2; }
  .skill-hint p { margin-bottom: 6px; }
  .skill-hint code { font-family: var(--mono); direction: ltr; background: var(--bg); padding: 1px 5px; border-radius: var(--radius-xs); font-size: 12px; }
`);

// ترجمة الحالة لشارة عربية + صنف لوني
const MCP_STATUS = {
  connected:    { label: 'متصل',        cls: 'connected' },
  pending:      { label: 'قيد الاتصال', cls: 'pending' },
  'needs-auth': { label: 'يحتاج مصادقة', cls: 'needsauth' },
  failed:       { label: 'فشل',          cls: 'failed' },
  disabled:     { label: 'معطّل',        cls: 'disabled' },
};

class SatrMcpPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>الموصّلات (MCP)</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" title="تحديث">تحديث</button>' +
          '<button class="close" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    this._cwd = '';
    r.querySelector('.close').addEventListener('click', () => this.close());
    // التحديث للقشرة: تعيد الفتح بـ cwd لحظة النقر (قد يتغيّر واللوحة مفتوحة)
    r.querySelector('.refresh').addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('panel-refresh')));
  }

  close() { this.removeAttribute('open'); }

  _notice(text) { this.dispatchEvent(new CustomEvent('notice', { detail: text })); }

  async open(cwd) {
    this._cwd = cwd || '';
    this.setAttribute('open', '');
    this._list.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    const r = await window.satr.mcpStatus(this._cwd);
    if (!r || !r.ok) {
      this._list.innerHTML = '';
      const h = document.createElement('div'); h.className = 'hint';
      h.textContent = '✗ تعذّر قراءة حالة الموصّلات' + (r && r.error ? ' — ' + r.error : '');
      this._list.appendChild(h);
      return;
    }
    if (!r.servers.length) {
      this._list.innerHTML = '';
      const h = document.createElement('div'); h.className = 'skill-hint'; h.dir = 'rtl';
      h.innerHTML = '<p>لا توجد خوادم MCP مُعدّة.</p>' +
        '<p>أضِف خادماً عبر ملف <code dir="ltr">.mcp.json</code> في المشروع، ' +
        'أو فعّل موصّلات claude.ai من تطبيق Claude.</p>';
      this._list.appendChild(h);
      return;
    }
    this._list.innerHTML = '';
    for (const s of r.servers) this._list.appendChild(this._buildRow(s));
  }

  _buildRow(s) {
    const box = document.createElement('div'); box.className = 'mcp';
    const row = document.createElement('div'); row.className = 'mcp-row';
    const name = document.createElement('span'); name.className = 'mcp-name'; name.dir = 'ltr';
    name.textContent = s.name;
    const st = MCP_STATUS[s.status] || { label: s.status || '?', cls: 'pending' };
    const badge = document.createElement('span'); badge.className = 'mcp-badge ' + st.cls;
    badge.textContent = st.label;
    row.appendChild(name); row.appendChild(badge);
    box.appendChild(row);

    // سطر تفاصيل: النطاق + الإصدار + عدد الأدوات (LTR تقني)
    const bits = [];
    if (s.scope) bits.push(s.scope);
    if (s.serverInfo && s.serverInfo.version) bits.push('v' + s.serverInfo.version);
    if (Array.isArray(s.tools)) bits.push(s.tools.length + ' tools');
    if (bits.length) {
      const meta = document.createElement('div'); meta.className = 'mcp-meta'; meta.dir = 'ltr';
      meta.textContent = bits.join(' · ');
      box.appendChild(meta);
    }
    if (s.status === 'failed' && s.error) {
      const hint = document.createElement('div'); hint.className = 'mcp-hint';
      hint.textContent = 'الخطأ: ' + s.error;
      box.appendChild(hint);
    }
    if (s.status === 'needs-auth') {
      const hint = document.createElement('div'); hint.className = 'mcp-hint';
      hint.textContent = 'يحتاج تسجيل دخول — صادق عليه من Claude Code (الأمر /mcp) ثم اضغط «تحديث». ' +
        'زر «إعادة الاتصال» هنا أفضل جهد ولا يفتح نافذة الدخول.';
      box.appendChild(hint);
    }

    // الإجراءات: تفعيل إن كان معطّلاً، وإلا إعادة اتصال + تعطيل
    const actions = document.createElement('div'); actions.className = 'mcp-actions';
    if (s.status === 'disabled') {
      actions.appendChild(this._btn('تفعيل', s.name, 'enable', actions));
    } else {
      actions.appendChild(this._btn('إعادة الاتصال', s.name, 'reconnect', actions));
      actions.appendChild(this._btn('تعطيل', s.name, 'disable', actions));
    }
    box.appendChild(actions);
    return box;
  }

  _btn(label, name, action, container) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', async () => {
      container.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      b.textContent = 'جارٍ…';
      const r = await window.satr.mcpAction(this._cwd, name, action);
      if (r && r.ok) {
        this._notice('✓ ' + label + ': ' + name);
      } else {
        this._notice('✗ تعذّر «' + label + '» على ' + name + (r && r.error ? ' — ' + r.error : ''));
      }
      this.open(this._cwd); // تحديث اللوحة ليكشف الحالة الفعلية بعد الإجراء
    });
    return b;
  }
}

customElements.define('satr-mcp-panel', SatrMcpPanel);
