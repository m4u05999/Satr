// <satr-files-panel> — لوحة ملفات المشروع 📄 (الدفعة 1.2) + بحث المحتوى (4.6) — تفكيك ت-6.
// شجرة قراءة فقط (بناء الأبناء كسول عند أول فتح) وبحث Enter يمسح الملفات فعلياً.
// **العارض ليس شأنه**: فتح ملف (من الشجرة أو نتيجة بحث) يُصدر حدث «file-open»
// بحمولة {rel, line} والقشرة تفتح العارض (يُفكّك في ت-7). العقد: open(cwd) / close().
// أحداث: «panel-refresh» (تحديث بـ cwd طازج) و«panel-close» (إطفاء توهج زر 📄 بالشريط).
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  /* صفوف الشجرة: مجلد قابل للطي وملف قابل للفتح — الأسماء LTR داخل واجهة RTL */
  .ft-row { display: flex; align-items: center; gap: 7px; padding: 4px 14px; cursor: pointer; font-size: 13px; color: var(--text); }
  .ft-row:hover, .ft-row:focus-visible { background: var(--gold-soft); outline: none; }
  .ft-row .ft-ico { flex: none; font-size: 12px; width: 16px; text-align: center; }
  .ft-row .ft-name { font-family: var(--mono); direction: ltr; unicode-bidi: embed; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ft-row.dir .ft-name { color: var(--gold); }
  .ft-kids[hidden] { display: none; }
  /* نتائج بحث المحتوى (4.6): موضع LTR (ملف:سطر) + مقتطف باتجاه تلقائي */
  .panel-list[hidden] { display: none; }
  .fh-row { padding: 6px 14px; cursor: pointer; border-bottom: 1px solid var(--border-dim); }
  .fh-row:hover, .fh-row:focus-visible { background: var(--gold-soft); outline: none; }
  .fh-loc { display: block; font-family: var(--mono); direction: ltr; unicode-bidi: embed; text-align: left; font-size: 11.5px; color: var(--gold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fh-text { display: block; font-family: var(--mono); font-size: 12px; color: var(--text-dim); text-align: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`);

class SatrFilesPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>ملفات المشروع</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" title="إعادة قراءة الشجرة">تحديث</button>' +
          '<button class="close" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="panel-search">' +
        '<input type="text" placeholder="🔍 ابحث في محتوى الملفات… (Enter)" autocomplete="off">' +
      '</div>' +
      '<div class="panel-list hits" hidden></div>' +
      '<div class="panel-list tree"></div>';
    this._tree = r.querySelector('.tree');
    this._hits = r.querySelector('.hits');
    this._search = r.querySelector('input');
    this._cwd = '';
    r.querySelector('.close').addEventListener('click', () => this.close());
    r.querySelector('.refresh').addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('panel-refresh')));
    // Enter يبحث؛ Escape يمسح النص أولاً (نمط بحث الجلسات) ثم يمرّ لمعالج القشرة فيغلق
    this._search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._runSearch(); }
      else if (e.key === 'Escape' && this._search.value) {
        e.stopPropagation(); this._resetSearch();
      }
    });
    this._search.addEventListener('input', () => { if (!this._search.value.trim()) this._runSearch(); });
  }

  close() {
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('panel-close'));
  }

  _openFile(rel, line) {
    this.dispatchEvent(new CustomEvent('file-open', { detail: { rel, line: line || 0 } }));
  }

  // بناء شجرة متداخلة من قائمة المسارات المسطّحة (a/b/c.js …)
  _buildTree(paths) {
    const root = { dirs: new Map(), files: [] };
    for (const p of paths) {
      const parts = p.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
        node = node.dirs.get(parts[i]);
      }
      node.files.push(parts[parts.length - 1]);
    }
    return root;
  }

  // رسم مستوى واحد: مجلدات أولاً (بناء الأبناء كسول عند أول فتح) ثم ملفات
  _renderTree(node, container, prefix, depth) {
    const pad = (14 + depth * 16) + 'px';
    const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
    for (const name of [...node.dirs.keys()].sort(byName)) {
      const row = document.createElement('div');
      row.className = 'ft-row dir'; row.tabIndex = 0;
      row.style.paddingInlineStart = pad; // CSSOM لا سمة مضمّنة (CSP)
      const ico = document.createElement('span'); ico.className = 'ft-ico'; ico.textContent = '📁';
      const nm = document.createElement('span'); nm.className = 'ft-name'; nm.textContent = name;
      row.appendChild(ico); row.appendChild(nm);
      const kids = document.createElement('div'); kids.className = 'ft-kids'; kids.hidden = true;
      let built = false;
      const toggle = () => {
        kids.hidden = !kids.hidden;
        ico.textContent = kids.hidden ? '📁' : '📂';
        if (!built && !kids.hidden) {
          this._renderTree(node.dirs.get(name), kids, prefix + name + '/', depth + 1);
          built = true;
        }
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      container.appendChild(row); container.appendChild(kids);
    }
    for (const f of node.files.sort(byName)) {
      const row = document.createElement('div');
      row.className = 'ft-row file'; row.tabIndex = 0;
      row.style.paddingInlineStart = pad;
      const ico = document.createElement('span'); ico.className = 'ft-ico'; ico.textContent = '📄';
      const nm = document.createElement('span'); nm.className = 'ft-name'; nm.textContent = f;
      row.appendChild(ico); row.appendChild(nm);
      const open = () => this._openFile(prefix + f);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      container.appendChild(row);
    }
  }

  _resetSearch() {
    this._search.value = '';
    this._hits.hidden = true;
    this._hits.innerHTML = '';
    this._tree.hidden = false;
  }

  async _runSearch() {
    const q = this._search.value.trim();
    if (!q) { this._hits.hidden = true; this._hits.innerHTML = ''; this._tree.hidden = false; return; }
    if (!this._cwd) return;
    this._tree.hidden = true;
    this._hits.hidden = false;
    this._hits.innerHTML = '<div class="hint">جارٍ البحث…</div>';
    const r = await window.satr.searchFiles(this._cwd, q);
    if (this._search.value.trim() !== q) return; // الاستعلام تغيّر أثناء الانتظار — تجاهل نتيجة قديمة
    this._hits.innerHTML = '';
    if (!r || !r.ok) {
      this._hits.innerHTML = '<div class="hint">تعذّر البحث — جرّب كلمات أخرى (حرفان فأكثر)</div>';
      return;
    }
    if (!r.hits.length) {
      this._hits.innerHTML = '<div class="hint">لا نتائج</div>';
      return;
    }
    for (const h of r.hits) {
      const row = document.createElement('div');
      row.className = 'fh-row'; row.tabIndex = 0;
      const loc = document.createElement('span'); loc.className = 'fh-loc';
      loc.textContent = h.rel + (h.line ? ':' + h.line : '');
      const tx = document.createElement('span'); tx.className = 'fh-text'; tx.dir = 'auto';
      tx.textContent = h.text;
      row.appendChild(loc); row.appendChild(tx);
      const open = () => this._openFile(h.rel, h.line || 0);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      this._hits.appendChild(row);
    }
    if (r.partial) {
      const n = document.createElement('div'); n.className = 'hint';
      n.textContent = '⏱ مسح جزئي — المشروع كبير ونفدت ميزانية الوقت';
      this._hits.appendChild(n);
    }
  }

  async open(cwd) {
    this._cwd = cwd || '';
    this.setAttribute('open', '');
    this._resetSearch(); // فتح/تحديث = عودة للشجرة (بحث 4.6 يُصفَّر)
    if (!this._cwd) { this._tree.innerHTML = '<div class="hint">اختر مجلد المشروع أولاً 📁</div>'; return; }
    this._tree.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    const list = (await window.satr.listFiles(this._cwd)) || [];
    this._tree.innerHTML = '';
    if (!list.length) { this._tree.innerHTML = '<div class="hint">لا ملفات في هذا المجلد</div>'; return; }
    this._renderTree(this._buildTree(list), this._tree, '', 0);
  }
}

customElements.define('satr-files-panel', SatrFilesPanel);
