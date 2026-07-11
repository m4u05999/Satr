// <satr-git-panel> — لوحة تغييرات git ± (الدفعة 4.7 — تفكيك ت-5).
// عرض فقط: صف لكل ملف متغيّر منذ HEAD، والنقر يفرد بطاقة الفرق (buildDiff المشتركة
// بمرآة RTL — noUndo لأنها ليست لقطات «سطر»). لا أفعال git (قرار نطاق مثبّت).
// العقد: open(cwd) / close(). أحداث: «panel-refresh» (زر تحديث ⇒ القشرة تعيد الفتح
// بـ cwd طازج) و«panel-close» (الإغلاق الداخلي ⇒ القشرة تطفئ توهج زر ± في الشريط).
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';
import { diffSheet } from '../lib/diff.css.js';
import { buildDiff } from '../lib/diff.js';

const ownSheet = sheet(`
  /* صفوف لوحة git — منقولة كما هي من base.css */
  .gd-row { display: flex; align-items: center; gap: 8px; padding: 7px 14px; cursor: pointer; border-bottom: 1px solid var(--border-dim); }
  .gd-row:hover, .gd-row:focus-visible { background: var(--gold-soft); outline: none; }
  .gd-badge { flex: none; font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
  .gd-badge.new { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
  .gd-badge.del { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
  .gd-badge.mod { color: var(--gold); border-color: var(--gold-border); background: var(--gold-soft); }
  .gd-name { flex: 1; min-width: 0; font-family: var(--mono); direction: ltr; unicode-bidi: embed; text-align: left; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gd-counts { flex: none; font-family: var(--mono); direction: ltr; font-size: 11.5px; }
  .gd-counts .a { color: var(--green); }
  .gd-counts .d { color: var(--red); margin-inline-start: 5px; }
  .gd-card { padding: 0 10px 8px; }
  .gd-card[hidden] { display: none; }
  .gd-card .diff { margin: 0; }
`);

const GD_KIND = { new: 'جديد', del: 'حُذف', mod: 'معدَّل' };
const GD_SKIP = { binary: 'ثنائي', big: 'ضخم', error: 'تعذّر' };

class SatrGitPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, diffSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>تغييرات المشروع ±</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" title="إعادة قراءة التغييرات">تحديث</button>' +
          '<button class="close" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    r.querySelector('.close').addEventListener('click', () => this.close());
    r.querySelector('.refresh').addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('panel-refresh')));
  }

  close() {
    this.removeAttribute('open');
    // القشرة تطفئ توهج زر ± (زر الشريط العلوي خارج المكوّن)
    this.dispatchEvent(new CustomEvent('panel-close'));
  }

  _hint(text) {
    const h = document.createElement('div');
    h.className = 'hint'; h.textContent = text;
    this._list.appendChild(h);
  }

  async open(cwd) {
    this.setAttribute('open', '');
    this._list.innerHTML = '';
    if (!cwd) { this._hint('اختر مجلد المشروع أولاً 📁'); return; }
    this._hint('جارٍ قراءة التغييرات…');
    const r = await window.satr.gitChanges(cwd);
    if (!this.hasAttribute('open')) return; // أُغلقت أثناء الانتظار
    this._list.innerHTML = '';
    if (!r || !r.ok) {
      const why = {
        no_git: 'git غير مثبّت — ثبّته من git-scm.com ثم أعد المحاولة',
        bad_cwd: 'مجلد المشروع غير موجود',
      };
      this._hint('⚠️ ' + (why[(r && r.error) || ''] || 'تعذّرت قراءة تغييرات git'));
      return;
    }
    if (!r.repo) { this._hint('هذا المجلد ليس مستودع git'); return; }
    if (!r.files.length) { this._hint('✓ لا تغييرات غير ملتزمة — شجرة العمل نظيفة'); return; }
    for (let i = 0; i < r.files.length; i++) {
      const f = r.files[i];
      const row = document.createElement('div');
      row.className = 'gd-row'; row.tabIndex = 0;
      const badge = document.createElement('span');
      badge.className = 'gd-badge ' + f.kind;
      badge.textContent = f.skipped ? GD_SKIP[f.skipped] : GD_KIND[f.kind];
      const name = document.createElement('span'); name.className = 'gd-name';
      name.textContent = f.rel + (f.renamedFrom ? ' ← ' + f.renamedFrom : '');
      name.title = f.rel;
      row.appendChild(badge); row.appendChild(name);
      if (!f.skipped) {
        const counts = document.createElement('span'); counts.className = 'gd-counts';
        const a = document.createElement('span'); a.className = 'a'; a.textContent = '+' + f.added;
        const d = document.createElement('span'); d.className = 'd'; d.textContent = '−' + f.removed;
        counts.appendChild(a); counts.appendChild(d);
        row.appendChild(counts);
      }
      this._list.appendChild(row);
      if (f.skipped) continue; // صف شارة فقط — لا بطاقة تُفرد
      // بطاقة الفرق كسولة: تُبنى عند أول فرد (100 بطاقة دفعة واحدة تثقل الفتح)
      const holder = document.createElement('div');
      holder.className = 'gd-card'; holder.hidden = true;
      this._list.appendChild(holder);
      let built = false;
      const toggle = () => {
        holder.hidden = !holder.hidden;
        if (!built && !holder.hidden) {
          holder.appendChild(buildDiff({
            id: 'git_' + i, tool: 'git', noUndo: true,
            rel: f.rel, isNew: f.kind === 'new', isDelete: f.kind === 'del',
            added: f.added, removed: f.removed, lines: f.lines, truncated: f.truncated,
          }));
          built = true;
        }
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    if (r.more) this._hint('… و' + r.more + ' ملفاً آخر لم يُعرض (سقف 100)');
    if (r.partial) this._hint('⏱ قراءة جزئية — نفدت ميزانية الوقت');
  }
}

customElements.define('satr-git-panel', SatrGitPanel);
