// <satr-sessions-panel> — لوحة «/جلسات»: تصفح الجلسات المحفوظة واستئنافها (تفكيك ت-4).
// المكوّن يملك الجلب (جلسات كلود + محادثات المحوّلات معاً — الدفعة 4) والدمج بالأحدث
// أولاً والترشيح الفوري والعرض. **الاستئناف ليس شأنه**: النقر/Enter يُصدر حدث
// «session-resume» بحمولة عنصر الجلسة، والقشرة تنفّذ (تبديل محرك/عرض التاريخ/ضبط
// sessionId — حالة عميقة تبقى ملكها حتى دفعات لاحقة). العقد: open(providers) — قائمة
// المزوّدين تُمرَّر لحظة الفتح لتسمية محادثات المحوّلات (حالة قشرة، لا يقرؤها المكوّن).
// Escape في حقل البحث يمسح النص أولاً (داخلي)؛ إغلاق اللوحة بـ Escape توجيه القشرة.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';
import { applyDir } from '../lib/text-dir.js';

const ownSheet = sheet(`
  /* عرض لوحة الجلسات 400px (أضيق من افتراضي panel.css.js) */
  :host { width: 400px; }
  /* صفوف الجلسات — منقولة كما هي من base.css */
  .sess { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); cursor: pointer; display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: flex-start; }
  .sess:hover, .sess:focus-visible { background: var(--gold-soft); outline: none; }
  .sess.pinned { border-inline-start: 2px solid var(--gold); }
  .sess-main { flex: 1; min-width: 0; }
  .sess-actions { display: flex; gap: var(--space-1); flex: none; }
  .sess-actions button { padding: var(--space-1) var(--space-2); font-size: 11px; }
  .sess-actions .pin.active { color: var(--gold); border-color: var(--gold-border); background: var(--gold-soft); }
  .sess-more { flex-basis: 100%; }
  .sess-more summary { cursor: pointer; color: var(--text-dim); font-size: 11px; width: max-content; }
  .sess-more-menu { display: flex; flex-wrap: wrap; gap: var(--space-1); padding-top: var(--space-1); }
  .sess-more-menu button { padding: var(--space-1) var(--space-2); font-size: 11px; }
  /* لا unicode-bidi: plaintext هنا: العنوان **أول رسالة مستخدم** — نفس نوع محتوى
     فقاعة المحادثة — و«أول حرف قوي» كان يرسي «F1 — الهاتف يرنّ» وأمثالها LTR كاملة.
     قِيس حيّاً (arabic-rtl-probe): أول محرف على بعد 0px من اليسار و281px من اليمين.
     الحسم الآن إحصائي صريح عبر lib/text-dir.js */
  .sess .t {
    font-size: 13.5px; line-height: 1.55;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .sess .m {
    font-size: 11px; color: var(--text-dim); font-family: var(--mono);
    direction: ltr; text-align: right; margin-top: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* ---- التجميع بالمشروع (‏OBS-068): 22 مشروعاً كانت متشابكة زمنياً في قائمة واحدة ---- */
  .grp {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--surface-2); border-bottom: 1px solid var(--border);
    cursor: pointer; user-select: none; position: sticky; top: 0; z-index: var(--z-sticky);
  }
  .grp:hover, .grp:focus-visible { background: var(--surface-3); outline: none; }
  .grp .caret { flex: none; color: var(--text-dim); font-size: 10px; width: 10px; }
  /* اسم المجلد مسار تقني — LTR دائماً مهما كان محيطه */
  .grp .name {
    flex: 1; min-width: 0; font-size: 12px; font-family: var(--mono);
    direction: ltr; text-align: right;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .grp .count {
    flex: none; font-size: 10.5px; color: var(--text-dim);
    background: var(--surface); border: 1px solid var(--border-dim);
    border-radius: var(--radius-pill); padding: 1px var(--space-2);
  }
  .grp.current .name { color: var(--gold); }
  .panel-tools {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border);
    font-size: 11.5px; color: var(--text-dim);
  }
  .panel-tools label { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
  .panel-tools .spacer { flex: 1; }
  .meta-status {
    padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border);
    color: var(--red); font-size: 11.5px; line-height: 1.6;
  }
`);

const META_ERROR_MESSAGES = Object.freeze({
  limit: 'تعذّر الحفظ: امتلأ سجلّ بيانات الجلسات.',
  write_failed: 'تعذّر الحفظ: تعذّرت الكتابة إلى ملف بيانات الجلسات.',
});
const OPEN_GROUPS_KEY = 'satr_sessions_open_groups';

function readOpenGroups() {
  const raw = localStorage.getItem(OPEN_GROUPS_KEY);
  if (!raw) return { customized: false, open: new Set() };
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !Array.isArray(value.open)
      || !value.open.every((key) => typeof key === 'string')) throw new Error('invalid');
    return { customized: value.customized === true, open: new Set(value.open) };
  } catch {
    localStorage.removeItem(OPEN_GROUPS_KEY);
    return { customized: false, open: new Set() };
  }
}

function normalizePath(value) {
  const path = String(value || '').trim();
  if (!path) return '';
  if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\|^\/\//.test(path)) {
    return path.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
  }
  return path;
}

function displayPath(value) {
  const path = String(value || '').trim();
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\|^\/\//.test(path)
    ? path.replace(/\//g, '\\').replace(/\\+$/g, '') : path;
}

// جلسة أداة لا جلسة مستخدم: عوامل غرفة العمليات والمراجعون والباحثون والمسابير.
// **الوسم أولاً** (‏OBS-068 ب): تُوسَم وقت إنشائها في `sessionmeta` فتُكشف حتى إن جرت
// داخل مجلد مشروع حقيقي (المخطط والعصف لا يستعملان worktree). وكشف المسار يبقى احتياطاً
// للجلسات القديمة التي سبقت الوسم — بيقين من المسار وحده؛ أما مجلدات مثل `<project>-opus`
// فهي مجلدات حقيقية على قرص المستخدم ولا يميّزها شيء، فلا نخمّنها.
const TOOL_PATH = /(^|[\\/])\.satr[\\/]worktrees[\\/]|[\\/]AppData[\\/]Local[\\/]Temp[\\/]|[\\/]Temp[\\/]satr-/i;
function isToolSession(s) {
  if (s && s.toolTagged === true) return true;
  return TOOL_PATH.test(String((s && s.cwd) || ''));
}

// ‏OBS-135: خريطة «اسم مجلد Claude المُرمَّز ⇒ مسار المشروع»، تُبنى ممّا رأيناه مقترناً
// في جلسة واحدة على الأقل. أول اقتران يفوز — والمصدر واحد (‏`sessions.js` يقرأ **أول**
// `cwd` في الملف، وهو مجلد بدء الجلسة الثابت) فلا تعارض متوقّع. ودالة نقية كي يختبرها
// الحارس بلا DOM.
function buildProjectCwdMap(list) {
  const map = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.project || !s.cwd) continue;
    const project = String(s.project);
    if (!map.has(project)) map.set(project, s.cwd);
    if (!map.has(project.toLowerCase())) map.set(project.toLowerCase(), s.cwd);
  }
  return map;
}

function nativeEngine(session) {
  return session.engine || (session.kind === 'chat' ? session.provider
    : session.kind === 'codex' ? 'codex' : session.kind === 'kimi' ? 'kimi-code' : 'sdk');
}

function bindingKeys(conversation) {
  const keys = new Set();
  const add = (bindings) => {
    if (!bindings || typeof bindings !== 'object') return;
    for (const [engine, ids] of Object.entries(bindings)) {
      for (const id of Array.isArray(ids) ? ids : [ids]) if (id) keys.add(String(engine) + ':' + String(id));
    }
  };
  add(conversation.bindings); add(conversation.previousBindings);
  return keys;
}

function nativeBindingKey(session) {
  const id = session.sessionId || session.id;
  return id ? nativeEngine(session) + ':' + String(id) : '';
}

function mergeCatalog(nativeSessions, catalog, meta) {
  if (!Array.isArray(catalog)) return nativeSessions;
  const nativeByBinding = new Map(nativeSessions.map((session) => [nativeBindingKey(session), session]));
  const bound = new Set();
  const conversations = [];
  const seen = new Set();
  for (const item of catalog) {
    if (!item || !item.id || item.archived === true || seen.has(String(item.id))) continue;
    seen.add(String(item.id));
    const keys = bindingKeys(item);
    const sources = [...keys].map((key) => nativeByBinding.get(key)).filter(Boolean);
    if (sources.some((source) => source.kind === 'codex' && source.archived === true)) continue;
    for (const key of keys) bound.add(key);
    const customTitle = sources.map((source) => meta[source.id]).find((entry) => entry && entry.title);
    const allToolTagged = keys.size > 0 && sources.length === keys.size && sources.every((source) =>
      source.toolTagged === true || (meta[source.id] && meta[source.id].kind === 'tool'));
    const inheritedPinned = sources.some((source) =>
      source.pinned === true || (meta[source.id] && meta[source.id].pinned === true));
    conversations.push({
      ...item,
      kind: 'conversation',
      inheritedTitle: (customTitle && customTitle.title) || '',
      inheritedPinned,
      toolTagged: allToolTagged,
    });
  }
  return conversations.concat(nativeSessions.filter((session) => !bound.has(nativeBindingKey(session))));
}

// عمر الجلسة بصيغة عربية سليمة: مفرد/مثنى/جمع 3–10/تمييز 11+ (جولة الصقل 2026-08-08 —
// كانت «قبل 1 س» و«قبل 2 يوم» أرقاماً واختصارات بلا مثنى)
function agoUnit(n, one, two, few, many) {
  if (n === 1) return 'قبل ' + one;
  if (n === 2) return 'قبل ' + two;
  if (n <= 10) return 'قبل ' + n + ' ' + few;
  return 'قبل ' + n + ' ' + many;
}
function fmtAge(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return agoUnit(m, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة');
  const h = Math.round(m / 60);
  if (h < 24) return agoUnit(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة');
  return agoUnit(Math.round(h / 24), 'يوم', 'يومين', 'أيام', 'يوماً');
}

class SatrSessionsPanel extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [panelSheet, ownSheet];
    r.innerHTML =
      '<div class="panel-head">' +
        '<span>الجلسات المحفوظة</span>' +
        '<button class="close" title="إغلاق" aria-label="إغلاق لوحة الجلسات المحفوظة">✕</button>' +
      '</div>' +
      '<div class="panel-search">' +
        '<input type="text" placeholder="🔍 ابحث بالعنوان أو المجلد…" aria-label="البحث في الجلسات بالعنوان أو المجلد" autocomplete="off">' +
      '</div>' +
      '<div class="panel-tools">' +
        '<label><input type="checkbox" class="hidetools"> أخفِ جلسات الأدوات</label>' +
        '<span class="spacer"></span><span class="tally"></span>' +
      '</div>' +
      '<div class="meta-status" role="status" aria-live="polite" aria-atomic="true" dir="rtl" hidden></div>' +
      '<div class="panel-list"></div>';
    this._list = r.querySelector('.panel-list');
    this._search = r.querySelector('.panel-search input');
    this._hideTools = r.querySelector('.hidetools');
    this._tally = r.querySelector('.tally');
    this._metaStatus = r.querySelector('.meta-status');
    this._data = [];
    this._providers = [];
    this._meta = {};
    this._cwd = '';
    const savedOpen = readOpenGroups();
    this._open = savedOpen.open;
    this._openCustomized = savedOpen.customized;
    // الافتراضي: إخفاء جلسات الأدوات — هي أثر تشغيل لا محادثة يبحث عنها المستخدم
    this._hideTools.checked = localStorage.getItem('satr_sessions_show_tools') !== '1';
    this._hideTools.addEventListener('change', () => {
      localStorage.setItem('satr_sessions_show_tools', this._hideTools.checked ? '0' : '1');
      this._render();
    });
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

  _showMetaError(result) {
    const error = result && result.error;
    this._metaStatus.textContent = META_ERROR_MESSAGES[error] || 'تعذّر حفظ بيانات الجلسة.';
    this._metaStatus.hidden = false;
  }

  _clearMetaError() {
    this._metaStatus.textContent = '';
    this._metaStatus.hidden = true;
  }

  _showError(message) {
    this._metaStatus.textContent = message;
    this._metaStatus.hidden = false;
  }

  async _saveMeta(sessionId, patch) {
    let result = null;
    try { result = await window.satr.sessionMetaSet(sessionId, patch); } catch {}
    if (!result || !result.ok) { this._showMetaError(result); return null; }
    this._clearMetaError();
    return result;
  }

  // تسمية مزوّد محادثة محوّل (الدفعة 4) — من قائمة المزوّدين الممرَّرة عند الفتح
  _label(name) {
    const p = this._providers.find((x) => x.name === name);
    return (p && p.label) ? p.label : name;
  }

  _engineLabel(name) {
    if (name === 'sdk') return 'Claude Code';
    if (name === 'codex') return 'Codex';
    if (name === 'kimi-code') return 'Kimi Code';
    return this._label(name) || 'محادثة';
  }

  // مفتاح التجميع: المجلد للمحرّكات الأصيلة، واسم المزوّد لمحادثات المحوّلات (بلا مجلد).
  //
  // ‏OBS-135: جلسةٌ بلا `cwd` كانت تُجمَّع باسم مجلد Claude **المُرمَّز**، فينشقّ المشروع
  // الواحد مجموعتين متجاورتين (‏`D--sater-satr-2` و`D:\sater\satr-2`) لكلٍّ طيُّها
  // المستقل — فيبدو الطيّ معطوباً ويظهر نصف المشروع «مختفياً». و`cwd` ليس مضموناً:
  // `sessions.js` يلتقطه من رأس الملف (‏64ك.ب) فقط، وقياسٌ على أربع جلسات أعطى
  // ثلاثاً تحمله وواحدة بصفر.
  //
  // نتعرّف على الاسم عبر خريطة رأيناها مقترنة بمسار في جلسة أخرى من المجلد نفسه —
  // **ولا نشتقّ مساراً من الاسم**: الاتجاه من المسار إلى الاسم أحادي المعنى، أما
  // العكس فمستحيل بأمان (`D--sater-satr-2` قد يكون `D:\sater\satr-2` أو
  // `D:\sater\satr\2`، و`D--sater-satr-2-opus` مجلد مستقل فعلاً).
  _groupOf(s, projectMap) {
    if (s.kind === 'chat') {
      const label = this._label(s.provider);
      return { key: 'provider:' + String(s.provider || label), label };
    }
    const known = projectMap && s.project
      ? (projectMap.get(String(s.project)) || projectMap.get(String(s.project).toLowerCase())) : '';
    const label = displayPath(s.cwd || known || s.project || '(بلا مجلد)');
    return { key: 'cwd:' + normalizePath(label), label };
  }

  _render() {
    const q = this._search.value.trim().toLowerCase();
    const hay = (s) => (String(s.displayTitle || s.title || '') + ' ' +
      String(s.cwd || s.project || '') + ' ' +
      (s.kind === 'chat' ? s.provider + ' ' + this._label(s.provider) : '')).toLowerCase();
    // المثبّتة تنجو من مرشّح الأدوات دائماً: تثبيتها قرار صريح من المستخدم
    const visible = this._data.filter((s) =>
      s.pinned || !this._hideTools.checked || !isToolSession(s));
    const list = (q ? visible.filter((s) => hay(s).includes(q)) : visible.slice())
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

    this._tally.textContent = list.length === this._data.length
      ? list.length + ' جلسة'
      : list.length + ' من ' + this._data.length;

    this._list.innerHTML = '';
    if (!list.length) {
      this._list.innerHTML = '<div class="hint">' +
        (q ? 'لا نتائج مطابقة.' : 'لا توجد جلسات محفوظة.') + '</div>';
      return;
    }

    // بناء المجموعات — المثبّتة مجموعة مستقلة أولاً، ثم المشروع الحالي، ثم الأحدث نشاطاً
    const groups = new Map();
    const push = (group, s) => {
      const { key, label } = group;
      if (!groups.has(key)) groups.set(key, { key, label, items: [], mtime: 0 });
      const g = groups.get(key);
      g.items.push(s);
      if ((s.mtime || 0) > g.mtime) g.mtime = s.mtime || 0;
    };
    const PINNED = 'pinned:';
    // من `_data` كلها لا من `list` المرشَّحة: اقتران المجلد بمساره حقيقةٌ عن المشروع
    // لا عن العرض، فبحثٌ يخفي الجلسة حاملةَ المسار يجب ألّا يشقّ المجموعة (‏OBS-135).
    const projectMap = buildProjectCwdMap(this._data);
    for (const s of list) push(s.pinned
      ? { key: PINNED, label: '📌 المثبّتة' } : this._groupOf(s, projectMap), s);

    const cwd = 'cwd:' + normalizePath(this._cwd);
    if (this._cwd && groups.has(cwd)) groups.get(cwd).label = displayPath(this._cwd);
    const order = [...groups.values()].sort((a, b) =>
      Number(b.key === PINNED) - Number(a.key === PINNED)
      || Number(b.key === cwd) - Number(a.key === cwd)
      || b.mtime - a.mtime);

    // الفرد الافتراضي بميزانية صفوف لا بقاعدة صلبة: المثبّتة والمشروع الحالي أولاً، ثم
    // الأحدث فالأحدث ما دام المعروض ضمن ملء الشاشة تقريباً. وبهذا لا تبدو اللوحة فارغة
    // حين لا يكون للمشروع الحالي جلسات — وهي حالة أوقعتني فيها القاعدة الصلبة أولاً
    // (أمسكها `test:daily-loop-ui`): كل المجموعات مطوية والمستخدم أمام قائمة رؤوس.
    const ROW_BUDGET = 12;
    const auto = new Set();
    let budget = ROW_BUDGET;
    for (const g of order) {
      const forced = g.key === PINNED || g.key === cwd;
      if (forced || budget > 0) { auto.add(g.key); if (!forced) budget -= g.items.length; }
    }

    for (const g of order) {
      const isCurrent = g.key === cwd;
      // البحث يفرد ما فيه نتائج؛ وبعد أول تبديل يدوي تصير `_open` مصدر الحقيقة
      const expanded = q ? true : (this._openCustomized ? this._open.has(g.key) : auto.has(g.key));
      const head = document.createElement('div');
      head.className = 'grp' + (isCurrent ? ' current' : '');
      head.tabIndex = 0;
      head.setAttribute('role', 'button');
      head.setAttribute('aria-expanded', String(expanded));
      const caret = document.createElement('span'); caret.className = 'caret';
      caret.textContent = expanded ? '▾' : '▸';
      const name = document.createElement('span'); name.className = 'name';
      name.textContent = g.label; name.title = g.label;
      const count = document.createElement('span'); count.className = 'count';
      count.textContent = g.items.length + ' · ' + fmtAge(g.mtime);
      head.appendChild(caret); head.appendChild(name); head.appendChild(count);
      const toggle = () => {
        // أول نقرة تثبّت ما يراه المستخدم الآن (‏`auto`) ثم تبدّل المطلوب — وإلا قفزت
        // مجموعات أخرى مع نقرته الأولى.
        if (!this._openCustomized) for (const key of auto) this._open.add(key);
        this._openCustomized = true;
        if (this._open.has(g.key)) this._open.delete(g.key); else this._open.add(g.key);
        localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify({
          version: 1, customized: true, open: [...this._open],
        }));
        this._render();
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      this._list.appendChild(head);
      if (!expanded) continue;
      for (const s of g.items) this._list.appendChild(this._row(s));
    }
  }

  _row(s) {
    {
      const el = document.createElement('div');
      el.className = 'sess' + (s.pinned ? ' pinned' : '');
      el.tabIndex = 0;
      const main = document.createElement('div'); main.className = 'sess-main';
      const t = document.createElement('div'); t.className = 't';
      // العنوان نصّ مستخدم مختلط: يُحسم اتجاهه إحصائياً كفقاعة المحادثة تماماً
      applyDir(t, t.textContent = s.displayTitle || s.title);
      const m = document.createElement('div'); m.className = 'm';
      // محادثة محوّل: اسم المزوّد بدل المجلد؛ المحركات الأصيلة تعرض اسمها + المجلد.
      m.textContent = (s.kind === 'chat' ? this._label(s.provider)
        : s.kind === 'conversation' ? (this._engineLabel(s.engine) + ' · ' + (s.cwd || ''))
        : s.kind === 'codex' ? ('Codex · ' + (s.cwd || ''))
        : s.kind === 'kimi' ? ('Kimi Code · ' + (s.cwd || ''))
        : (s.cwd || s.project)) + ' · ' + fmtAge(s.mtime);
      main.appendChild(t); main.appendChild(m); el.appendChild(main);
      const actions = document.createElement('div'); actions.className = 'sess-actions';
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'pin' + (s.pinned ? ' active' : '');
      // الاسم الوصولي يتبع الحالة كما يتبعها التلميح — الرمز وحده لا يُنطق
      pin.textContent = '📌'; pin.title = s.pinned ? 'إلغاء تثبيت الجلسة' : 'تثبيت الجلسة';
      pin.setAttribute('aria-label', pin.title);
      pin.addEventListener('click', async (event) => {
        event.stopPropagation();
        const patch = { pinned: !s.pinned };
        if (s.pinned && s.inheritedPinned === true) patch.preservePinnedFalse = true;
        const result = await this._saveMeta(s.id, patch);
        if (!result) return;
        this._meta[s.id] = result.entry || {};
        this._applyMeta(); this._render();
      });
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'rename';
      rename.textContent = '✏️'; rename.title = 'إعادة تسمية الجلسة';
      rename.setAttribute('aria-label', rename.title);
      rename.addEventListener('click', async (event) => {
        event.stopPropagation();
        const title = window.prompt('اسم الجلسة المخصّص (اتركه فارغاً لاستعادة العنوان الأصلي):', s.displayTitle || s.title);
        if (title === null) return;
        if (s.kind === 'codex' && window.satr.nameCodexSession) {
          const official = await window.satr.nameCodexSession(s.id, title);
          if (!official || !official.ok) { this._showMetaError(official); return; }
        }
        const result = await this._saveMeta(s.id, { title });
        if (!result) return;
        this._meta[s.id] = result.entry || {};
        this._applyMeta(); this._render();
      });
      actions.appendChild(pin); actions.appendChild(rename); el.appendChild(actions);
      if (s.kind === 'codex') {
        const more = document.createElement('details'); more.className = 'sess-more';
        const summary = document.createElement('summary'); summary.textContent = 'إجراءات أخرى';
        summary.setAttribute('aria-label', 'إظهار إجراءات جلسة Codex الأخرى');
        const menu = document.createElement('div'); menu.className = 'sess-more-menu';
        more.appendChild(summary); more.appendChild(menu);
        more.addEventListener('click', (event) => event.stopPropagation());
        const fork = document.createElement('button'); fork.type = 'button'; fork.textContent = 'تفريع'; fork.title = 'تفريع جلسة Codex';
        fork.setAttribute('aria-label', fork.title);
        fork.addEventListener('click', async (event) => {
          event.stopPropagation();
          let result = null;
          try { result = await window.satr.forkCodexSession(s.id); } catch {}
          if (result && result.ok) await this.open(this._providers, this._cwd);
          else this._showError('تعذّر تفريع جلسة Codex.');
        });
        const archive = document.createElement('button'); archive.type = 'button'; archive.textContent = 'أرشفة'; archive.title = 'أرشفة جلسة Codex';
        archive.setAttribute('aria-label', archive.title);
        archive.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!window.confirm('أرشفة جلسة Codex هذه وإخفاؤها من القائمة؟')) return;
          let result = null;
          try { result = await window.satr.archiveCodexSession(s.id); } catch {}
          if (result && result.ok) await this.open(this._providers, this._cwd);
          else this._showError('تعذّرت أرشفة جلسة Codex.');
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'حذف'; remove.title = 'حذف جلسة Codex نهائياً';
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!window.confirm('حذف جلسة Codex هذه نهائياً؟ لا يمكن التراجع.')) return;
          let result = null;
          try { result = await window.satr.deleteCodexSession(s.id); } catch {}
          if (result && result.ok) await this.open(this._providers, this._cwd);
          else this._showError('تعذّر حذف جلسة Codex.');
        });
        menu.appendChild(fork); menu.appendChild(archive); menu.appendChild(remove);
        el.appendChild(more);
      }
      const open = () => this.dispatchEvent(new CustomEvent('session-resume', { detail: s }));
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) open(); });
      return el;
    }
  }

  _applyMeta() {
    this._data = this._data.map((session) => {
      const meta = this._meta[session.id] || {};
      // `session.kind` محجوز لعائلة المحرك (chat/codex/kimi)؛ وسم الميتاداتا يصل بعلم مستقل.
      return {
        ...session,
        pinned: typeof meta.pinned === 'boolean' ? meta.pinned : session.inheritedPinned === true,
        toolTagged: session.toolTagged === true || meta.kind === 'tool',
        displayTitle: meta.title || session.inheritedTitle || session.title,
      };
    });
  }

  async open(providers, cwd) {
    this._providers = Array.isArray(providers) ? providers : [];
    if (typeof cwd === 'string') this._cwd = cwd.trim();
    this._clearMetaError();
    this.setAttribute('open', '');
    this._list.innerHTML = '<div class="hint">جارٍ التحميل…</div>';
    // الكتالوج مستقل إن توفر، والمصادر الأصيلة fallback للسجلات غير المربوطة.
    const calls = [
      ['جلسات Claude Code', window.satr.listSessions],
      ['محادثات المزوّدين', window.satr.listChats],
      ['جلسات Codex', window.satr.listCodexSessions],
      ['جلسات Kimi Code', window.satr.listKimiSessions],
      ['بيانات الجلسات', window.satr.sessionMetaList],
      ['كتالوج المحادثات', window.satr.listConversations],
    ];
    const results = await Promise.allSettled(calls.map(([, fn]) =>
      typeof fn === 'function' ? Promise.resolve().then(() => fn.call(window.satr)) : Promise.resolve(null)));
    const value = (index, fallback) => results[index].status === 'fulfilled' && results[index].value != null
      ? results[index].value : fallback;
    const claude = value(0, []); const chats = value(1, []);
    const codex = value(2, []); const kimi = value(3, []);
    const metaResult = value(4, { entries: {} }); const catalogResult = value(5, null);
    const errors = calls.flatMap(([label, fn], index) =>
      typeof fn === 'function' && results[index].status === 'rejected' ? [label] : []);
    if (typeof window.satr.listConversations === 'function' && (!catalogResult || catalogResult.ok !== true)) {
      errors.push('كتالوج المحادثات');
    }
    if (catalogResult && Array.isArray(catalogResult.errors) && catalogResult.errors.length) {
      errors.push('تعذّرت قراءة بعض المحادثات من الكتالوج');
    }
    this._meta = metaResult && metaResult.entries && typeof metaResult.entries === 'object' ? metaResult.entries : {};
    const merged = (Array.isArray(claude) ? claude : [])
      .concat((Array.isArray(chats) ? chats : []).map((c) => ({ ...c, kind: 'chat' })))
      .concat((Array.isArray(codex) ? codex : []).map((c) => ({ ...c, kind: 'codex' })))
      .concat((Array.isArray(kimi) ? kimi : []).map((c) => ({ ...c, kind: 'kimi' })))
      .map((session) => {
        const meta = this._meta[session.id] || {};
        return {
          ...session,
          displayTitle: meta.title || session.title,
          toolTagged: session.toolTagged === true || meta.kind === 'tool',
        };
      });
    const catalog = catalogResult && catalogResult.ok === true ? catalogResult.conversations : null;
    this._data = mergeCatalog(merged, catalog, this._meta).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    this._applyMeta();
    this._render();
    if (errors.length) this._showError('تعذّر تحميل بعض السجلات: ' + errors.join('، ') + '.');
    this._search.focus();
  }
}

customElements.define('satr-sessions-panel', SatrSessionsPanel);
