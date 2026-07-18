// <satr-skills-panel> — لوحة «/مهارات»: .agents معيار «سطر» و.claude للتوافق.
// المكوّن يملك حالة المهارات كاملة: القائمة المجلوبة لكل cwd + مجموعة المعطّلة
// (localStorage ‏satr_disabled_skills — نخزّن المعطّل لا المفعّل ليُفعَّل أي جديد تلقائياً
// مطابقةً لمعنى 'all'). العقد: open(cwd) يفتح ويجلب من القرص، close() يغلق،
// getSkillsPayload(cwd) تستدعيها القشرة عند الإرسال — تعيد 'all' أو مصفوفة المفعّل.
// نقل حرفي لمنطق القشرة (ت-2) بلا تغيير سلوك.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  /* عرض لوحة المهارات 400px (كانت مع الجلسات — أضيق من افتراضي panel.css.js) */
  :host { width: 400px; }
  /* صفوف المهارات — منقولة كما هي من base.css */
  .skill { display: flex; gap: 10px; align-items: flex-start; padding: 11px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .skill:hover { background: var(--gold-soft); }
  .skill input[type="checkbox"] { margin-top: 3px; width: 16px; height: 16px; flex: 0 0 auto; accent-color: var(--gold); cursor: pointer; }
  .skill-info { flex: 1; min-width: 0; }
  .skill-row { display: flex; align-items: baseline; gap: 8px; }
  .skill-name { font-family: var(--mono); color: var(--gold); font-size: 13px; direction: ltr; }
  .skill-src { font-size: 10.5px; color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 5px; white-space: nowrap; }
  .skill-desc { font-size: 12px; color: var(--text-dim); margin-top: 2px; unicode-bidi: plaintext; line-height: 1.5; }
  .skill-hint { padding: 16px; color: var(--text-dim); font-size: 13px; line-height: 2; }
  .skill-hint p { margin-bottom: 6px; }
  .skill-hint code { font-family: var(--mono); direction: ltr; background: var(--bg); padding: 1px 5px; border-radius: var(--radius-xs); font-size: 12px; }
`);

class SatrSkillsPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>المهارات</span>' +
        '<button class="close" title="إغلاق">✕</button>' +
      '</div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    r.querySelector('.close').addEventListener('click', () => this.close());

    // المكتشَف لكل cwd (كاش) + المعطّل يدوياً من localStorage
    this._skills = [];
    this._cwd = null;
    this._disabled = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem('satr_disabled_skills') || '[]');
      if (Array.isArray(saved)) this._disabled = new Set(saved.filter((x) => typeof x === 'string'));
    } catch { /* تخزين تالف — نتجاهله */ }
  }

  close() { this.removeAttribute('open'); }

  _persistDisabled() {
    localStorage.setItem('satr_disabled_skills', JSON.stringify([...this._disabled]));
  }

  // قائمة المهارات تُجلب لكل cwd وتُعاد عند الإرسال (المكوّن يحسب المفعّل منها)
  async _ensureList(cwd, force) {
    if (!force && this._cwd === cwd && this._skills.length) return;
    this._cwd = cwd;
    this._skills = (await window.satr.listSkills(cwd)) || [];
  }

  // ما يُمرَّر للـ SDK: 'all' إن لم يُعطَّل شيء، وإلا مصفوفة المفعّل (المكتشف ناقص المعطّل)
  async getSkillsPayload(cwd) {
    if (!this._disabled.size) return 'all';
    await this._ensureList(cwd);
    return this._skills.map((s) => s.name).filter((n) => !this._disabled.has(n));
  }

  // إرشاد عند غياب أي مهارة — يشرح كيف يُضيف المستخدم مهارة (نص ثابت آمن)
  _renderEmpty() {
    this._list.innerHTML =
      '<div class="skill-hint" dir="rtl">' +
      '<p>لا توجد مهارات مكتشَفة بعد.</p>' +
      '<p>أضِف مهارة بإنشاء ملف <code>SKILL.md</code> في أحد المسارين:</p>' +
      '<p>• للمشروع الحالي: <code dir="ltr">.agents/skills/&lt;الاسم&gt;/SKILL.md</code></p>' +
      '<p>• لكل المشاريع: <code dir="ltr">~/.agents/skills/&lt;الاسم&gt;/SKILL.md</code></p>' +
      '<p>مسارات <code dir="ltr">.claude/skills/</code> القديمة تبقى مدعومة للتوافق.</p>' +
      '<p>يبدأ الملف بمقدمة <code>name</code> و<code>description</code> ثم تعليمات المهارة — ثم أعِد فتح هذه اللوحة.</p>' +
      '</div>';
  }

  async open(cwd) {
    this.setAttribute('open', '');
    this._list.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    await this._ensureList(cwd, true); // تحديث من القرص في كل فتح (قد تكون مهارة أُضيفت لتوّها)
    if (!this._skills.length) { this._renderEmpty(); return; }
    this._list.innerHTML = '';
    for (const s of this._skills) {
      const row = document.createElement('label'); // label ليطوّع النقر على الصف الاختيار
      row.className = 'skill';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !this._disabled.has(s.name);
      cb.addEventListener('change', () => {
        if (cb.checked) this._disabled.delete(s.name); else this._disabled.add(s.name);
        this._persistDisabled();
      });
      const info = document.createElement('div'); info.className = 'skill-info';
      const r = document.createElement('div'); r.className = 'skill-row';
      const nm = document.createElement('span'); nm.className = 'skill-name'; nm.dir = 'ltr'; nm.textContent = s.name;
      const src = document.createElement('span'); src.className = 'skill-src';
      const scope = s.source === 'project' ? 'المشروع' : 'المستخدم';
      const format = s.format === 'standard' ? 'قياسية' : 'Claude';
      src.textContent = scope + ' · ' + format;
      r.appendChild(nm); r.appendChild(src);
      const desc = document.createElement('div'); desc.className = 'skill-desc';
      desc.textContent = s.description || '(بلا وصف)';
      info.appendChild(r); info.appendChild(desc);
      row.appendChild(cb); row.appendChild(info);
      this._list.appendChild(row);
    }
  }
}

customElements.define('satr-skills-panel', SatrSkillsPanel);
