// <satr-sessions-panel> — لوحة «/جلسات»: تصفح الجلسات المحفوظة واستئنافها (تفكيك ت-4).
// المكوّن يملك الجلب (جلسات كلود + محادثات المحوّلات معاً — الدفعة 4) والدمج بالأحدث
// أولاً والترشيح الفوري والعرض. **الاستئناف ليس شأنه**: النقر/Enter يُصدر حدث
// «session-resume» بحمولة عنصر الجلسة، والقشرة تنفّذ (تبديل محرك/عرض التاريخ/ضبط
// sessionId — حالة عميقة تبقى ملكها حتى دفعات لاحقة). العقد: open(providers) — قائمة
// المزوّدين تُمرَّر لحظة الفتح لتسمية محادثات المحوّلات (حالة قشرة، لا يقرؤها المكوّن).
// Escape في حقل البحث يمسح النص أولاً (داخلي)؛ إغلاق اللوحة بـ Escape توجيه القشرة.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  /* عرض لوحة الجلسات 400px (أضيق من افتراضي panel.css.js) */
  :host { width: 400px; }
  /* صفوف الجلسات — منقولة كما هي من base.css */
  .sess { padding: 11px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .sess:hover, .sess:focus-visible { background: var(--gold-soft); outline: none; }
  .sess .t {
    font-size: 13.5px; unicode-bidi: plaintext; line-height: 1.55;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .sess .m {
    font-size: 11px; color: var(--text-dim); font-family: var(--mono);
    direction: ltr; text-align: right; margin-top: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
`);

// عمر الجلسة بصيغة عربية مقروءة
function fmtAge(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return 'قبل ' + m + ' د';
  const h = Math.round(m / 60);
  if (h < 24) return 'قبل ' + h + ' س';
  return 'قبل ' + Math.round(h / 24) + ' يوم';
}

class SatrSessionsPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>الجلسات المحفوظة</span>' +
        '<button class="close" title="إغلاق">✕</button>' +
      '</div>' +
      '<div class="panel-search">' +
        '<input type="text" placeholder="🔍 ابحث بالعنوان أو المجلد…" autocomplete="off">' +
      '</div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    this._search = r.querySelector('input');
    this._data = [];
    this._providers = [];
    r.querySelector('.close').addEventListener('click', () => this.close());
    // ترشيح فوري بالعنوان أو المجلد/المزوّد (دفعة UX) — القائمة تُجلب مرة وتُرشَّح محلياً
    this._search.addEventListener('input', () => this._render());
    // Escape في حقل البحث: امسح النص أولاً؛ فارغ ⇐ يمر لمستمع القشرة العام فيغلق اللوحة
    this._search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._search.value) {
        e.stopPropagation(); this._search.value = ''; this._render();
      }
    });
  }

  close() { this.removeAttribute('open'); }

  // تسمية مزوّد محادثة محوّل (الدفعة 4) — من قائمة المزوّدين الممرَّرة عند الفتح
  _label(name) {
    const p = this._providers.find((x) => x.name === name);
    return (p && p.label) ? p.label : name;
  }

  _render() {
    const q = this._search.value.trim().toLowerCase();
    const hay = (s) => (String(s.title || '') + ' ' +
      String(s.cwd || s.project || '') + ' ' +
      (s.kind === 'chat' ? s.provider + ' ' + this._label(s.provider) : '')).toLowerCase();
    const list = q ? this._data.filter((s) => hay(s).includes(q)) : this._data;
    this._list.innerHTML = '';
    if (!list.length) {
      this._list.innerHTML = '<div class="hint">' +
        (q ? 'لا نتائج مطابقة.' : 'لا توجد جلسات محفوظة.') + '</div>';
      return;
    }
    for (const s of list) {
      const el = document.createElement('div');
      el.className = 'sess';
      el.tabIndex = 0;
      const t = document.createElement('div'); t.className = 't'; t.textContent = s.title;
      const m = document.createElement('div'); m.className = 'm';
      // محادثة محوّل: اسم المزوّد بدل المجلد (محادثات REST غير مرتبطة بمجلد)
      m.textContent = (s.kind === 'chat' ? this._label(s.provider) : (s.cwd || s.project)) + ' · ' + fmtAge(s.mtime);
      el.appendChild(t); el.appendChild(m);
      const open = () => this.dispatchEvent(new CustomEvent('session-resume', { detail: s }));
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      this._list.appendChild(el);
    }
  }

  async open(providers) {
    this._providers = Array.isArray(providers) ? providers : [];
    this.setAttribute('open', '');
    this._list.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    // جلسات Claude Code + محادثات المحوّلات (الدفعة 4) معاً، الأحدث أولاً
    const [claude, chats] = await Promise.all([
      window.satr.listSessions().catch(() => []),
      window.satr.listChats().catch(() => []),
    ]);
    const merged = (Array.isArray(claude) ? claude : [])
      .concat((Array.isArray(chats) ? chats : []).map((c) => ({ ...c, kind: 'chat' })));
    merged.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    this._data = merged;
    this._render();
    this._search.focus();
  }
}

customElements.define('satr-sessions-panel', SatrSessionsPanel);
