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
  .gd-row { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-4); cursor: pointer; border-bottom: 1px solid var(--border-dim); }
  .gd-row:hover, .gd-row:focus-visible { background: var(--gold-soft); outline: none; }
  .gd-badge { flex: none; font-size: 10.5px; padding: 1px var(--space-2); border-radius: var(--radius-pill); border: 1px solid var(--border); color: var(--text-dim); }
  .gd-badge.new { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
  .gd-badge.del { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
  .gd-badge.mod { color: var(--gold); border-color: var(--gold-border); background: var(--gold-soft); }
  .gd-name { flex: 1; min-width: 0; font-family: var(--mono); direction: ltr; unicode-bidi: embed; text-align: left; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gd-counts { flex: none; font-family: var(--mono); direction: ltr; font-size: 11.5px; }
  .gd-counts .a { color: var(--green); }
  .gd-counts .d { color: var(--red); margin-inline-start: var(--space-1h); }
  .gd-card { padding: 0 var(--space-2h) var(--space-2); }
  .gd-card[hidden] { display: none; }
  .gd-card .diff { margin: 0; }
  /* أفعال git (دفعة «أفعال git») — أزرار صغيرة لكل صف + شريط الالتزام */
  .gd-actions { flex: none; display: flex; gap: var(--space-1); }
  .gd-act { font-size: 11px; padding: 2px var(--space-2); border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface-2); color: var(--text-dim); cursor: pointer; white-space: nowrap; }
  .gd-act:hover { border-color: var(--gold); color: var(--text); }
  .gd-act.staged { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
  .gd-act.discard:hover { border-color: var(--red-border); color: var(--red); background: var(--red-soft); }
  .gd-act:disabled { opacity: .5; cursor: default; }
  .gd-commit { display: flex; gap: var(--space-1h); align-items: center; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); background: var(--surface); }
  .gd-commit input { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); font-family: var(--sans); font-size: 12.5px; outline: none; }
  .gd-commit input:focus { border-color: var(--gold); }
  .gd-commit button { flex: none; font-size: 12px; padding: var(--space-1h) var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--gold-border); background: var(--gold-soft); color: var(--gold); cursor: pointer; }
  .gd-commit button:hover { background: var(--gold); color: var(--bg); }
  .gd-commit button:disabled { opacity: .5; cursor: default; background: var(--surface-2); color: var(--text-dim); border-color: var(--border); }
  .hint.gd-ok { color: var(--green); }
  .hint.gd-err { color: var(--red); }
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
    this._cwd = cwd || ''; // تحتاجه الأفعال (stage/commit/…) وإعادة القراءة بعدها
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

    // شريط الالتزام (أفعال git): يظهر حين يوجد مُجهَّز — git commit يلتزم المُجهَّز فقط
    const stagedCount = r.files.filter((f) => f.staged).length;
    if (stagedCount) this._commitBar(stagedCount);

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
      // أفعال الصف (لكل ملف حتى المتخطّى — يمكن تجهيز/تجاهل ثنائي أيضاً).
      // stopPropagation حتى لا يفتح النقر بطاقة الفرق. الأزرار خارج tab الصف مستقلة.
      const actions = document.createElement('span'); actions.className = 'gd-actions';
      const stageBtn = document.createElement('button');
      stageBtn.type = 'button';
      stageBtn.className = 'gd-act' + (f.staged ? ' staged' : '');
      stageBtn.textContent = f.staged ? 'إلغاء التجهيز' : 'تجهيز';
      stageBtn.title = f.staged ? 'إزالة من المُجهَّز' : 'تجهيز للالتزام';
      stageBtn.addEventListener('click', (e) => { e.stopPropagation(); this._do(f.staged ? 'unstage' : 'stage', f.rel); });
      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'gd-act discard';
      discardBtn.textContent = 'تجاهل';
      discardBtn.title = 'تجاهل تغييرات هذا الملف — لا يمكن التراجع';
      discardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const what = f.kind === 'new' ? 'حذف الملف الجديد «' + f.rel + '»' : 'تجاهل كل تغييرات «' + f.rel + '»';
        if (confirm(what + '؟\nلا يمكن التراجع عن هذا الإجراء.')) this._do('discard', f.rel);
      });
      actions.appendChild(stageBtn); actions.appendChild(discardBtn);
      row.appendChild(actions);

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

  // شريط رسالة الالتزام أعلى القائمة — Enter أو الزرّ يلتزم المُجهَّز
  _commitBar(stagedCount) {
    const bar = document.createElement('div'); bar.className = 'gd-commit';
    const inp = document.createElement('input'); inp.type = 'text';
    inp.placeholder = 'رسالة الالتزام (' + stagedCount + ' ملف مُجهَّز)…';
    inp.spellcheck = false;
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'التزام';
    const submit = async () => {
      const msg = inp.value.trim();
      if (!msg) { inp.focus(); return; }
      btn.disabled = true; inp.disabled = true;
      await this._do('commit', null, msg); // النجاح يعيد بناء القائمة؛ الفشل يظهر تنبيهاً
    };
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    bar.appendChild(inp); bar.appendChild(btn);
    this._list.appendChild(bar);
  }

  // تنفيذ فعل git ثم إعادة قراءة القائمة، مع تنبيه عربي عند الفشل/نجاح الالتزام
  async _do(op, rel, message) {
    if (this._busy) return false;
    this._busy = true;
    let r;
    try { r = await window.satr.gitAction(this._cwd, op, rel, message); }
    catch { r = { ok: false, error: 'error' }; }
    this._busy = false;
    await this.open(this._cwd); // إعادة القراءة تعكس الحالة الجديدة
    if (!this.hasAttribute('open')) return !!(r && r.ok);
    if (!r || !r.ok) this._flash('⚠️ ' + GD_ERR(r), false);
    else if (op === 'commit') this._flash('✓ التُزم' + (r.hash ? ' (' + r.hash + ')' : ''), true);
    return !!(r && r.ok);
  }

  // تنبيه عابر يُدرَج أعلى القائمة بعد إعادة البناء
  _flash(text, ok) {
    const h = document.createElement('div');
    h.className = 'hint ' + (ok ? 'gd-ok' : 'gd-err'); h.textContent = text;
    this._list.insertBefore(h, this._list.firstChild);
  }
}

// رسائل أخطاء أفعال git بالعربية
function GD_ERR(r) {
  const e = (r && r.error) || 'error';
  const map = {
    nothing_staged: 'لا شيء مُجهَّز للالتزام — جهّز ملفاً أولاً',
    empty_message: 'اكتب رسالة الالتزام أولاً',
    not_changed: 'الملف لم يعد ضمن التغييرات — حُدّثت القائمة',
    no_git: 'git غير مثبّت',
    no_repo: 'هذا المجلد ليس مستودع git',
    outside: 'مسار خارج المستودع — مرفوض',
    bad_input: 'مدخل غير صالح',
    bad_cwd: 'مجلد المشروع غير موجود',
  };
  return map[e] || ((r && r.message) ? r.message : 'تعذّر تنفيذ أمر git');
}

customElements.define('satr-git-panel', SatrGitPanel);
