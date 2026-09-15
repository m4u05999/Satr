// <satr-agents-live> — سطح دائم للوكلاء الفرعيين الأحياء (‏OBS-207 · OBS-151).
//
// العلّة (بلاغ المالك 2026-09-14): بطاقة الوكيل في `chat.js` ابنةُ كتلة الدور — تُنشأ
// من أداة الإطلاق في الخيط الرئيسي وحدها، ويسقط تقدّمها حين `block.done`، والاستئناف
// عبر `SendMessage` لا يمرّ بشرط الإنشاء أصلاً. فالوكيل الخلفي يعيش أطول من الدور
// ويُستأنف عبر أدوار، والمالك يرى بطاقة «✓ انتهى» بينما الوكيل يعمل أو توقف.
//
// العلاج: شريط مستقل عن الكتل (نمط <satr-testsprite-job> و`bgBar`) مفتاحه **`taskId`**
// لا `toolUseId` — لأن الاستئناف يصل بـ`toolUseId` جديد و`taskId` نفسه (قياس
// `D:\sater\agents-live-probe\result.json`، ‏SDK 0.3.270). بطاقة الكتلة تبقى كما هي؛
// هذا السطح يضاف ولا يستبدلها.
//
// العقد للخارج (‏methods): `applyAgentState(ev)` · `setWaitingPermission(taskId, tool, permId)`
// · `clearWaitingPermission(permId)` · `failStop(taskId, message)` · `reset()` · `snapshot()`.
// ويبثّ `agent-stop-request` بـ`{taskId}` (نمط `sdk-stop-task-request` في `chat.js`).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';
import { applyDir } from '../lib/text-dir.js';

// تحقّق دفاعي على حدود الواجهة: ما لا يطابق يُهمل صامتاً (العقد مع منفّذ المحرّك)
const SAFE_TASK_ID = /^[a-z0-9]{6,64}$/;
const SAFE_TOOL_USE_ID = /^toolu_[A-Za-z0-9]{16,64}$/;
const TEXT_MAX = 300;
// حدّ الذاكرة: الصفوف المنتهية وحدها تُقلَّم (الأقدم يسقط)؛ الحيّة لا تُسقط أبداً
const MAX_FINISHED_ROWS = 50;
// فوق هذا الطول يصير الملخّص الختامي مطويّاً بزرّ توسيع
const SUMMARY_CLAMP = 120;
const COLLAPSED_KEY = 'satr_agents_live_collapsed';

function safeText(value) {
  if (typeof value !== 'string' || !value) return '';
  return value.slice(0, TEXT_MAX);
}

// الزمن منذ أول إطلاق — أرقام LTR داخل bdi. الاستئناف لا يصفّر البداية (قرار موثّق
// في docs/internals/71-agents-live.md): الصف واحد للوكيل، فعمره عمر الوكيل لا عمر مقطعه.
function formatAge(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  if (h > 0) return h + 'س ' + pad(m) + 'د';
  if (m > 0) return m + 'د ' + pad(s) + 'ث';
  return s + 'ث';
}

const ownSheet = sheet(`
  /* مخفي تماماً عند الخلو: لا ارتفاع ولا حشوة — الشريط يظهر بوجود صف فقط */
  :host { display: none; flex: none; }
  :host([has-rows]) { display: block; }
  .bar {
    max-width: var(--column-max); margin: 0 auto;
    padding: var(--space-1h) var(--space-4) 0;
  }
  .frame {
    border: 1px solid var(--border); border-radius: var(--radius-lg);
    background: var(--surface); overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-1h) var(--space-2h);
  }
  .head-title { font-weight: 600; font-size: 12.5px; color: var(--text); }
  .counts { font-size: 12px; color: var(--text-dim); }
  .head .spacer { margin-inline-start: auto; }
  .toggle, .clear { font-size: 12px; padding: var(--space-1) var(--space-2); }
  .rows { display: flex; flex-direction: column; gap: var(--space-1h); padding: 0 var(--space-2h) var(--space-2h); }
  .frame[data-collapsed="1"] .rows { display: none; }
  .row {
    display: flex; align-items: flex-start; gap: var(--space-2);
    border-top: 1px solid var(--border-dim); padding-top: var(--space-1h);
  }
  .row:first-child { border-top: none; padding-top: 0; }
  .ico { flex: none; font-size: 13px; line-height: 1.6; }
  .body { flex: 1; min-width: 0; }
  .line { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .name { font-weight: 600; font-size: 12.5px; color: var(--text); }
  .desc { font-size: 12px; color: var(--text-dim); max-width: 100%; }
  .badge {
    font-size: 11.5px; font-weight: 600; border-radius: var(--radius-sm);
    padding: 1px var(--space-1h); background: var(--surface-3); color: var(--ops-review-title);
  }
  .row[data-state="done"] .badge { background: var(--green-soft); color: var(--green); }
  .row[data-state="failed"] .badge { background: var(--red-soft); color: var(--red); }
  .row[data-state="stopped"] .badge { background: var(--surface-3); color: var(--text-dim); }
  .row[data-state="waiting"] .badge { background: var(--gold-soft); color: var(--gold); }
  .resumes { font-size: 11.5px; color: var(--text-faint); }
  .age { font: 11.5px var(--mono); color: var(--text-faint); }
  .row .spacer { margin-inline-start: auto; }
  .stop, .hide { font-size: 11.5px; padding: 1px var(--space-1h); }
  .stop:disabled { opacity: .5; cursor: not-allowed; }
  .hide { border: none; background: transparent; color: var(--text-dim); }
  .hide:hover { color: var(--text); background: var(--surface-3); }
  /* سطر التقدّم والملخّص: نصّ حرّ يُحسم اتجاهه بـtextDir لا بـplaintext (القاعدة ٣) */
  .prog { font-size: 12px; color: var(--text-dim); margin-top: 2px; overflow-wrap: anywhere; }
  .summary { font-size: 12px; color: var(--text); margin-top: 2px; overflow-wrap: anywhere; }
  .summary.clamped { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .more { font-size: 11.5px; padding: 0 var(--space-1h); border: none; background: transparent; color: var(--gold); }
  .err { color: var(--red); }
  [hidden] { display: none !important; }
`);

class SatrAgentsLive extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [controlsSheet, ownSheet];
    root.innerHTML =
      '<div class="bar">' +
        '<div class="frame" data-collapsed="0" role="region" aria-label="الوكلاء الفرعيون">' +
          '<div class="head">' +
            '<button class="toggle" type="button" aria-expanded="true" aria-label="طيّ شريط الوكلاء الفرعيين">▾</button>' +
            '<span class="head-title">الوكلاء الفرعيون</span>' +
            '<span class="counts"></span>' +
            '<span class="spacer"></span>' +
            '<button class="clear" type="button">مسح المنتهي</button>' +
          '</div>' +
          '<div class="rows"></div>' +
        '</div>' +
      '</div>';
    this._frame = root.querySelector('.frame');
    this._counts = root.querySelector('.counts');
    this._rowsEl = root.querySelector('.rows');
    this._toggle = root.querySelector('.toggle');
    this._clearBtn = root.querySelector('.clear');
    /** @type {Map<string, object>} مفتاحه taskId — صف واحد للوكيل مهما استُؤنف */
    this._rows = new Map();
    /** معرّف طلب الإذن ⇒ taskId، كي يزول الانتظار بالمعرّف لا بالتخمين */
    this._perms = new Map();
    this._collapsed = false;
    try { this._collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch (e) {}
    this._applyCollapsed();
    this._toggle.addEventListener('click', () => {
      this._collapsed = !this._collapsed;
      try { localStorage.setItem(COLLAPSED_KEY, this._collapsed ? '1' : '0'); } catch (e) {}
      this._applyCollapsed();
    });
    this._clearBtn.addEventListener('click', () => this.clearFinished());
  }

  connectedCallback() {
    if (this._timer) return;
    // عدّاد الزمن يتجدّد محلياً كل ثانية للصفوف الحيّة فقط (المنتهي مجمّد)
    this._timer = setInterval(() => this._tickAges(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  // ---------- العقد العام ----------

  /** حدث `sdk_agent_state` بأشكاله الخمسة — ما لا يطابق العقد يُهمل صامتاً. */
  applyAgentState(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (ev.kind === 'live') return this._applyLive(ev.taskIds);
    const taskId = typeof ev.taskId === 'string' ? ev.taskId : '';
    if (!SAFE_TASK_ID.test(taskId)) return false;
    if (ev.kind === 'started') return this._applyStarted(taskId, ev);
    if (ev.kind === 'progress') return this._applyProgress(taskId, ev);
    if (ev.kind === 'updated') return this._applyUpdated(taskId, ev);
    if (ev.kind === 'finished') return this._applyFinished(taskId, ev);
    return false;
  }

  /** الوكيل صاحب `requester` هو من يطلب الإذن — الصف يقول «ينتظر إذنك: <أداة>». */
  setWaitingPermission(taskId, toolName, permissionId) {
    if (!SAFE_TASK_ID.test(String(taskId || ''))) return false;
    const row = this._rows.get(taskId);
    if (!row || row.ended) return false;
    const id = String(permissionId == null ? '' : permissionId).slice(0, 128);
    row.waitingTool = safeText(String(toolName || '')) || 'أداة';
    row.waitingId = id;
    if (id) this._perms.set(id, taskId);
    this._renderRow(row);
    this._renderCounts();
    return true;
  }

  /** حسم الطلب (رد المستخدم · قرار الجوال · إغلاق المربع بانتهاء الدور). */
  clearWaitingPermission(permissionId) {
    const id = String(permissionId == null ? '' : permissionId).slice(0, 128);
    if (!id) return false;
    const taskId = this._perms.get(id);
    this._perms.delete(id);
    if (!taskId) return false;
    const row = this._rows.get(taskId);
    if (!row || row.waitingId !== id) return false;
    row.waitingTool = '';
    row.waitingId = '';
    this._renderRow(row);
    this._renderCounts();
    return true;
  }

  /** رفض `main` طلبَ الإيقاف ⇒ يعود الزر ومعه رسالة عربية (نمط `failSdkTaskStop`). */
  failStop(taskId, message) {
    const row = this._rows.get(String(taskId || ''));
    if (!row || row.ended) return false;
    row.stopping = false;
    row.stopError = safeText(String(message || '')) || 'تعذّر إيقاف هذا الوكيل.';
    this._renderRow(row);
    return true;
  }

  /** جلسة جديدة أو تبديل محرك أو تفريغ الخيط. */
  reset() {
    this._rows.clear();
    this._perms.clear();
    this._rowsEl.textContent = '';
    this._syncVisibility();
    this._renderCounts();
  }

  /** إزالة الصفوف المنتهية وحدها (زر «مسح المنتهي»). */
  clearFinished() {
    for (const [taskId, row] of [...this._rows]) {
      if (!row.ended) continue;
      if (row.el && row.el.parentNode) row.el.remove();
      this._rows.delete(taskId);
    }
    this._syncVisibility();
    this._renderCounts();
  }

  /** لقطة الحالة للحارس — لا تحمل إلا ما يُعرض فعلاً. */
  snapshot() {
    return [...this._rows.values()].map((row) => ({
      taskId: row.taskId,
      name: row.nameEl ? row.nameEl.textContent : '',
      description: row.description,
      badge: row.badgeEl ? row.badgeEl.textContent : '',
      progress: row.progEl ? row.progEl.textContent : '',
      summary: row.summary,
      resumes: row.resumes,
      ended: row.ended,
      settling: row.settling,
      waiting: !!row.waitingTool,
      stopVisible: !!(row.stopBtn && !row.stopBtn.hidden),
      stopDisabled: !!(row.stopBtn && row.stopBtn.disabled),
      hiddenRow: !!(row.el && row.el.hidden),
      taskType: row.taskType,
    }));
  }

  // ---------- تطبيق الأحداث ----------

  _applyStarted(taskId, ev) {
    let row = this._rows.get(taskId);
    const resumed = ev.resumed === true;
    if (!row) {
      row = this._createRow(taskId);
      this._rows.set(taskId, row);
    } else if (resumed) {
      // الاستئناف يحيي الصف نفسه ولا يُنشئ ثانياً (‏`taskId` مستقرّ عبر `SendMessage`)
      row.resumes += 1;
    }
    row.ended = false;
    row.endKind = '';
    row.settling = false;
    row.stopping = false;
    row.stopError = '';
    row.summary = '';
    row.error = '';
    row.el.hidden = false;
    if (SAFE_TOOL_USE_ID.test(String(ev.toolUseId || ''))) row.toolUseId = ev.toolUseId;
    const description = safeText(String(ev.description || ''));
    if (description) row.description = description;
    const subagentType = safeText(String(ev.subagentType || ''));
    if (subagentType) row.subagentType = subagentType;
    const taskType = safeText(String(ev.taskType || ''));
    if (taskType) row.taskType = taskType;
    row.backgrounded = ev.backgrounded === true;
    if (Number.isInteger(ev.spawnDepth) && ev.spawnDepth >= 0) row.spawnDepth = ev.spawnDepth;
    if (!row.startedAt) row.startedAt = Date.now();
    row.endedAt = 0;
    this._renderRow(row);
    this._syncVisibility();
    this._renderCounts();
    return true;
  }

  _applyProgress(taskId, ev) {
    const row = this._rows.get(taskId);
    if (!row) return false;
    if (SAFE_TOOL_USE_ID.test(String(ev.toolUseId || ''))) row.toolUseId = ev.toolUseId;
    // `description` يصف ما يفعله الوكيل الآن، و`summary` قد يغيب (قياس النموذج ٣)
    const text = safeText(String(ev.description || '')) || safeText(String(ev.summary || ''));
    if (text) { row.progress = text; row.progressIsError = false; }
    this._renderRow(row);
    return true;
  }

  _applyUpdated(taskId, ev) {
    const row = this._rows.get(taskId);
    if (!row) return false;
    const description = safeText(String(ev.description || ''));
    if (description) { row.progress = description; row.progressIsError = false; }
    const error = safeText(String(ev.error || ''));
    if (error) { row.progress = error; row.progressIsError = true; }
    if (ev.backgrounded === true) row.backgrounded = true;
    // الحالات النهائية وحدها تُنهي الصف؛ `pending`/`running`/`paused` تصحيح حالة لا خاتمة
    if (ev.status === 'completed') this._endRow(row, 'done');
    else if (ev.status === 'failed') this._endRow(row, 'failed');
    else if (ev.status === 'killed') this._endRow(row, 'stopped');
    else this._renderRow(row);
    this._renderCounts();
    return true;
  }

  _applyFinished(taskId, ev) {
    const row = this._rows.get(taskId);
    if (!row) return false;
    // `local: true` ⇒ حسم محلي عند انتهاء Query أو إيقاف الدور، لا خبر من الوكيل نفسه
    const local = ev.local === true;
    // **لا يُعاد حسم صفٍّ محسوم** (مراجعة القائد على PR #161): المحرّك يبثّ
    // `finished{local:true}` عند انتهاء Query لكل مهمة رآها، فيصل لوكيلٍ أمامي أُنهي
    // صفّه قبله بـ`updated{status:'completed'}` فيقلب «اكتمل» إلى «انتهى مع الدور» —
    // تراجعٌ في الدقة لا تحديث. الاستثناء الوحيد: صفٌّ منتهٍ **بالحسم المحلي** يقبل
    // خاتمةً حقيقية لاحقة (بلا `local`)، لأن إشعار الوكيل نفسه أدقّ من حسمنا عنه.
    if (row.ended && !(row.endKind === 'local' && !local)) return false;
    if (SAFE_TOOL_USE_ID.test(String(ev.toolUseId || ''))) row.toolUseId = ev.toolUseId;
    const summary = safeText(String(ev.summary || ''));
    if (summary) row.summary = summary;
    const kind = local ? 'local'
      : ev.status === 'failed' ? 'failed'
      : ev.status === 'stopped' ? 'stopped' : 'done';
    this._endRow(row, kind);
    this._renderCounts();
    return true;
  }

  // دلالة REPLACE: القائمة كاملة. الغائب عنها بلا `finished` بعدُ ⇒ «يُحسم…»
  // (يصل `finished` بعده بأجزاء الثانية عادةً — قياس النموذج ٥).
  _applyLive(taskIds) {
    if (!Array.isArray(taskIds)) return false;
    const live = new Set(taskIds.filter((id) => typeof id === 'string' && SAFE_TASK_ID.test(id)));
    for (const row of this._rows.values()) {
      if (row.ended) continue;
      const settling = !live.has(row.taskId);
      if (settling === row.settling) continue;
      row.settling = settling;
      this._renderRow(row);
    }
    this._renderCounts();
    return true;
  }

  _endRow(row, kind) {
    row.ended = true;
    row.endKind = kind;
    row.settling = false;
    row.stopping = false;
    row.stopError = '';
    row.backgrounded = false;
    if (row.waitingId) { this._perms.delete(row.waitingId); row.waitingId = ''; }
    row.waitingTool = '';
    row.endedAt = Date.now();
    this._renderRow(row);
    this._trimFinished();
    this._syncVisibility();
  }

  // حدّ الذاكرة: 50 صفاً منتهياً، الأقدم ختاماً يسقط أولاً
  _trimFinished() {
    const finished = [...this._rows.values()].filter((row) => row.ended);
    if (finished.length <= MAX_FINISHED_ROWS) return;
    finished.sort((a, b) => a.endedAt - b.endedAt);
    for (const row of finished.slice(0, finished.length - MAX_FINISHED_ROWS)) {
      if (row.el && row.el.parentNode) row.el.remove();
      this._rows.delete(row.taskId);
    }
  }

  // ---------- بناء الصف وعرضه ----------

  _createRow(taskId) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.taskId = taskId;

    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.setAttribute('aria-hidden', 'true');
    el.appendChild(ico);

    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);

    const line = document.createElement('div');
    line.className = 'line';
    body.appendChild(line);

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    line.appendChild(nameEl);

    const descEl = document.createElement('span');
    descEl.className = 'desc';
    line.appendChild(descEl);

    const badgeEl = document.createElement('span');
    badgeEl.className = 'badge';
    badgeEl.setAttribute('role', 'status');
    line.appendChild(badgeEl);

    const resumesEl = document.createElement('span');
    resumesEl.className = 'resumes';
    resumesEl.hidden = true;
    line.appendChild(resumesEl);

    const ageEl = document.createElement('bdi');
    ageEl.className = 'age';
    ageEl.dir = 'ltr';
    line.appendChild(ageEl);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    line.appendChild(spacer);

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'stop';
    stopBtn.textContent = '⏹ إيقاف';
    stopBtn.setAttribute('aria-label', 'أوقف هذا الوكيل الفرعي');
    stopBtn.addEventListener('click', () => this._requestStop(taskId));
    line.appendChild(stopBtn);

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'hide';
    hideBtn.textContent = '✕';
    hideBtn.setAttribute('aria-label', 'إخفاء صف الوكيل المنتهي');
    hideBtn.hidden = true;
    hideBtn.addEventListener('click', () => {
      const row = this._rows.get(taskId);
      if (!row || !row.ended) return;
      row.el.hidden = true;
      this._syncVisibility();
      this._renderCounts();
    });
    line.appendChild(hideBtn);

    const progEl = document.createElement('div');
    progEl.className = 'prog';
    progEl.hidden = true;
    body.appendChild(progEl);

    const summaryWrap = document.createElement('div');
    summaryWrap.className = 'summary-wrap';
    summaryWrap.hidden = true;
    const summaryEl = document.createElement('div');
    summaryEl.className = 'summary';
    summaryWrap.appendChild(summaryEl);
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'more';
    moreBtn.textContent = 'عرض الملخّص كاملاً';
    moreBtn.hidden = true;
    moreBtn.addEventListener('click', () => {
      const row = this._rows.get(taskId);
      if (!row) return;
      row.summaryOpen = !row.summaryOpen;
      summaryEl.classList.toggle('clamped', !row.summaryOpen);
      moreBtn.textContent = row.summaryOpen ? 'طيّ الملخّص' : 'عرض الملخّص كاملاً';
    });
    summaryWrap.appendChild(moreBtn);
    body.appendChild(summaryWrap);

    this._rowsEl.appendChild(el);
    return {
      taskId, toolUseId: '', description: '', subagentType: '', taskType: '',
      backgrounded: false, spawnDepth: 0, resumes: 0,
      progress: '', progressIsError: false, summary: '', summaryOpen: false,
      waitingTool: '', waitingId: '', stopping: false, stopError: '',
      ended: false, endKind: '', settling: false, startedAt: 0, endedAt: 0,
      el, ico, nameEl, descEl, badgeEl, resumesEl, ageEl, stopBtn, hideBtn,
      progEl, summaryWrap, summaryEl, moreBtn,
    };
  }

  // الشارات الثماني — بالعربية حصراً، وترتيب الأسبقية مقصود:
  // الانتظار أعلى من كل شيء (الوكيل متوقّف فعلاً ينتظر المالك)، ثم الخاتمة، ثم الحسم.
  _badgeOf(row) {
    if (row.ended) {
      if (row.endKind === 'local') return { text: 'انتهى مع الدور', state: 'stopped' };
      if (row.endKind === 'failed') return { text: 'فشل', state: 'failed' };
      if (row.endKind === 'stopped') return { text: 'أُوقف', state: 'stopped' };
      return { text: 'اكتمل', state: 'done' };
    }
    if (row.waitingTool) return { text: 'ينتظر إذنك: ' + row.waitingTool, state: 'waiting' };
    if (row.settling) return { text: 'يُحسم…', state: 'settling' };
    if (row.backgrounded) return { text: 'يعمل في الخلفية', state: 'live' };
    return { text: 'يعمل', state: 'live' };
  }

  _renderRow(row) {
    const badge = this._badgeOf(row);
    row.el.dataset.state = badge.state;
    row.badgeEl.textContent = badge.text;
    // الأيقونة بحسب النوع: أمر خلفي أم وكيل فرعي
    const isBash = row.taskType === 'local_bash';
    row.ico.textContent = isBash ? '⌨' : '🤖';
    row.nameEl.textContent = row.subagentType || (isBash ? 'أمر خلفي' : 'وكيل فرعي');
    // اسم نوع الوكيل معرّف تقني ⇒ LTR؛ والوصف نصّ حرّ ⇒ حسم إحصائي
    row.nameEl.dir = row.subagentType ? 'ltr' : 'rtl';
    row.descEl.hidden = !row.description;
    if (row.description) {
      row.descEl.textContent = row.description;
      applyDir(row.descEl, row.description);
    }
    row.resumesEl.hidden = row.resumes <= 0;
    row.resumesEl.textContent = row.resumes > 0 ? 'استُؤنف ×' + (row.resumes + 1) : '';
    const progress = row.stopError || row.progress;
    row.progEl.hidden = !progress;
    row.progEl.classList.toggle('err', !!row.stopError || row.progressIsError);
    if (progress) {
      row.progEl.textContent = progress;
      applyDir(row.progEl, progress);
    }
    row.summaryWrap.hidden = !row.summary;
    if (row.summary) {
      row.summaryEl.textContent = row.summary;
      applyDir(row.summaryEl, row.summary);
      const long = row.summary.length > SUMMARY_CLAMP;
      row.moreBtn.hidden = !long;
      row.summaryEl.classList.toggle('clamped', long && !row.summaryOpen);
    }
    row.stopBtn.hidden = row.ended;
    row.stopBtn.disabled = row.stopping;
    row.stopBtn.textContent = row.stopping ? 'يُوقَف…' : '⏹ إيقاف';
    row.hideBtn.hidden = !row.ended;
    this._tickRowAge(row);
  }

  _requestStop(taskId) {
    const row = this._rows.get(taskId);
    if (!row || row.ended || row.stopping) return;
    row.stopping = true;
    row.stopError = '';
    this._renderRow(row);
    this.dispatchEvent(new CustomEvent('agent-stop-request', {
      bubbles: true, composed: true, detail: { taskId },
    }));
  }

  _tickRowAge(row) {
    if (!row.startedAt) { row.ageEl.textContent = ''; return; }
    const end = row.ended && row.endedAt ? row.endedAt : Date.now();
    row.ageEl.textContent = formatAge(end - row.startedAt);
  }

  _tickAges() {
    for (const row of this._rows.values()) {
      if (row.ended) continue; // المنتهي مجمّد على زمن خاتمته
      this._tickRowAge(row);
    }
  }

  _renderCounts() {
    let live = 0;
    let finished = 0;
    for (const row of this._rows.values()) {
      if (row.el && row.el.hidden) continue;
      if (row.ended) finished += 1; else live += 1;
    }
    this._counts.textContent = '(' + live + ' حيّ · ' + finished + ' منتهٍ)';
  }

  _applyCollapsed() {
    this._frame.dataset.collapsed = this._collapsed ? '1' : '0';
    this._toggle.setAttribute('aria-expanded', this._collapsed ? 'false' : 'true');
    this._toggle.textContent = this._collapsed ? '▸' : '▾';
    this._toggle.setAttribute('aria-label',
      this._collapsed ? 'فرد شريط الوكلاء الفرعيين' : 'طيّ شريط الوكلاء الفرعيين');
  }

  _syncVisibility() {
    const visible = [...this._rows.values()].some((row) => row.el && !row.el.hidden);
    if (visible) this.setAttribute('has-rows', '');
    else this.removeAttribute('has-rows');
  }
}

customElements.define('satr-agents-live', SatrAgentsLive);
