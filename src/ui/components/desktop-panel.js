// <satr-desktop-panel> — منتقي نافذة سطح ويندوز وسجلّ أفعال الوكيل (الخطوة ٥ من docs/COMPUTER-USE-DESKTOP.md).
// الحارس ١: المستخدم يختار نافذة واحدة لجلسة واحدة، بلا «دائماً» ولا حفظ. القائمة من satr:desktopTargets
// كما وصلت منقّاة من main.js (خمسة حقول) — النوافذ المحجوبة لا تصل أصلاً، فلا سبب لكل نافذة بل سطر ثابت.
// الحارس ٥: لكل فعل سطر عربي دائم يُقرأ لاحقاً (لا وميض) — النص من الحدث كما هو، textContent وحده.
// علم desktopControl ملك القشرة (app.js — نمط browserControl): اللوحة تعرضه وتبثّ طلب تبديله فقط.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';
import { textDir, applyDir } from '../lib/text-dir.js';

// أسماء عربية للنوافذ المعروفة — نسخة PROCESS_LABELS في electron/desktopguard.js (سطر السجل يستعملها)،
// ويحرس test:desktop-panel تطابق النسختين كي لا تتباعدا بصمت.
const PROCESS_LABELS = Object.freeze({
  notepad: 'المفكرة',
  mspaint: 'الرسام',
  calculatorapp: 'الحاسبة',
  explorer: 'مستكشف الملفات',
});
const MAX_ACTIVITY = 200;
const MAX_ACTIVITY_TEXT = 300;
const MAX_TITLE_POINTS = 80;

const ownSheet = sheet(`
  :host { width: min(440px, 52vw); }
  .desktop-content {
    flex: 1; min-height: var(--space-0); overflow-y: auto;
    padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4);
  }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2);
    padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2);
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .title { font-weight: 600; color: var(--text); }
  .hint { color: var(--text-dim); font-size: 12px; line-height: 1.7; }
  .state { color: var(--text-dim); font-size: 12px; }
  .state.on { color: var(--green); }
  .switch { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; color: var(--text); }
  .switch input { accent-color: var(--gold); inline-size: 18px; block-size: 18px; }
  .tech { direction: ltr; unicode-bidi: isolate; font-family: var(--mono); }
  .message { color: var(--red); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
  .selected-box {
    display: flex; align-items: center; gap: var(--space-2h);
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg);
    padding: var(--space-2) var(--space-2h);
  }
  .selected-box.on { border-color: var(--gold-border); background: var(--gold-soft); }
  .selected-text { flex: 1; min-width: 0; color: var(--text); font-size: 12.5px; line-height: 1.7; overflow-wrap: anywhere; }
  .selected-box button { flex: none; font-size: 12px; padding: var(--space-1) var(--space-2h); }
  .targets { display: flex; flex-direction: column; gap: var(--space-2); }
  .target {
    display: flex; align-items: center; gap: var(--space-2h);
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg);
    padding: var(--space-2) var(--space-2h);
  }
  .target.selected { border-color: var(--gold-border); background: var(--gold-soft); }
  .target-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
  .target-label { color: var(--text); font-weight: 600; font-size: 13px; }
  .target-title { color: var(--text); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .target-meta { color: var(--text-dim); font-size: 11px; display: flex; gap: var(--space-2); }
  .target button { flex: none; font-size: 12px; padding: var(--space-1) var(--space-2h); }
  .log-head .count { color: var(--text-dim); font-size: 12px; font-weight: 400; }
  .log-head button { font-size: 12px; padding: var(--space-1) var(--space-2h); }
  .log { list-style: none; display: flex; flex-direction: column; max-height: 320px; overflow-y: auto; }
  .log li {
    display: flex; align-items: baseline; gap: var(--space-2);
    padding: var(--space-1h) 0; border-top: 1px solid var(--border-dim); font-size: 12.5px; line-height: 1.7;
  }
  .log .time { flex: none; color: var(--text-dim); font: 11px var(--mono); direction: ltr; unicode-bidi: isolate; }
  .log .text { flex: 1; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
  button:disabled, input:disabled { opacity: .55; cursor: default; }
`);

function clip(value, max) {
  const points = Array.from(String(value || ''));
  return points.length <= max ? points.join('') : points.slice(0, max).join('') + '…';
}

function processLabel(name) {
  const key = String(name || '').toLowerCase().replace(/\.exe$/, '');
  return Object.prototype.hasOwnProperty.call(PROCESS_LABELS, key) ? PROCESS_LABELS[key] : (key || 'نافذة');
}

function sameTarget(a, b) {
  return !!a && !!b && a.targetId === b.targetId && a.pid === b.pid;
}

function pad2(n) { return String(n).padStart(2, '0'); }

class SatrDesktopPanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head">' +
        '<span>🪟 سطح ويندوز</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" type="button" title="حدّث قائمة النوافذ">تحديث</button>' +
          '<button class="close" type="button" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="desktop-content">' +
        '<section class="card control">' +
          '<div class="row">' +
            '<div><div class="title">تحكّم الوكيل بسطح المكتب</div><div class="state">متوقف</div></div>' +
            '<label class="switch"><span>تفعيل</span><input class="enable" type="checkbox"></label>' +
          '</div>' +
          '<div class="hint">يُسجَّل مع أول رسالة في الجلسة ولا يُبدَّل أثناءها، ولمحرك «Claude — اشتراك Claude Code» وحده.</div>' +
          '<div class="hint pending" hidden>الجلسة الحالية ثبّتت قرارها عند أول رسالة — التبديل يسري مع الجلسة القادمة. لإيقاف أفعال الوكيل الآن: ألغِ اختيار النافذة.</div>' +
        '</section>' +
        '<section class="card picker">' +
          '<div class="title">النافذة المأذونة لهذه الجلسة</div>' +
          '<div class="selected-box"><span class="selected-text">لم تُختر نافذة — الوكيل لا يرى أي نافذة.</span>' +
            '<button class="clear" type="button" hidden>ألغِ الاختيار</button></div>' +
          '<div class="hint">الاختيار لهذه الجلسة وحدها ولا يُحفظ، ولا «دائماً»: الوكيل لا يرى إلا النافذة المختارة، وكل فعل عليها يمرّ على مربع الإذن.</div>' +
          '<div class="message" hidden></div>' +
          '<div class="targets"></div>' +
          '<div class="hint fixed">نوافذ النظام ونافذة سطر والمصغّرة لا تُعرض.</div>' +
        '</section>' +
        '<section class="card activity">' +
          '<div class="row log-head">' +
            '<span class="title">سجلّ الأفعال <span class="count">(0)</span></span>' +
            '<button class="clear-log" type="button" disabled>مسح</button>' +
          '</div>' +
          '<div class="hint empty">لا أفعال بعد. كل فعل للوكيل على النافذة المختارة يظهر هنا سطراً بزمنه.</div>' +
          '<ol class="log" aria-live="polite"></ol>' +
        '</section>' +
      '</div>';

    this._enable = root.querySelector('.enable');
    this._state = root.querySelector('.state');
    this._pending = root.querySelector('.pending');
    this._selectedBox = root.querySelector('.selected-box');
    this._selectedText = root.querySelector('.selected-text');
    this._clear = root.querySelector('.clear');
    this._message = root.querySelector('.message');
    this._targets = root.querySelector('.targets');
    this._log = root.querySelector('.log');
    this._count = root.querySelector('.count');
    this._empty = root.querySelector('.empty');
    this._clearLog = root.querySelector('.clear-log');
    this._list = [];
    this._selected = null;
    this._activity = [];
    this._busy = false;
    this._epoch = 0;

    root.querySelector('.close').addEventListener('click', () => this.close());
    root.querySelector('.refresh').addEventListener('click', () => this.refresh());
    // التبديل ملك القشرة: نعيد الحالة المعروضة ونبثّ الطلب، والقشرة تعيد الرسم بـsetControlState
    this._enable.addEventListener('change', () => {
      const on = this._enable.checked;
      this._enable.checked = !on;
      this.dispatchEvent(new CustomEvent('desktop-control', { detail: { on } }));
    });
    this._clear.addEventListener('click', () => this.clearSelection());
    this._clearLog.addEventListener('click', () => this.clearActivity());
  }

  get selected() { return this._selected ? Object.assign({}, this._selected) : null; }

  _notice(text) {
    this.dispatchEvent(new CustomEvent('notice', { detail: text }));
  }

  open(state) {
    this.setAttribute('open', '');
    if (state) this.setControlState(state);
    this.refresh();
  }

  close() {
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('panel-close'));
  }

  focusInitial() { this._enable.focus(); }

  // {on, sessionActive}: حالة العلم من القشرة، و«يسري مع الجلسة القادمة» حين تكون الجلسة قد ثبّتت قرارها
  setControlState(state) {
    const s = state || {};
    this._enable.checked = s.on === true;
    this._state.textContent = s.on === true ? 'مفعّل — يُسجَّل للجلسة التي تبدأ به' : 'متوقف';
    this._state.className = 'state' + (s.on === true ? ' on' : '');
    this._pending.hidden = s.sessionActive !== true;
  }

  _showMessage(text) {
    const value = String(text || '');
    this._message.hidden = !value;
    this._message.textContent = value;
    applyDir(this._message, value);
  }

  _setBusy(on) {
    this._busy = on;
    for (const button of this._targets.querySelectorAll('button')) button.disabled = on || button.dataset.selected === '1';
    this._clear.disabled = on;
  }

  // يسرد النوافذ ويرسمها؛ يعيد القائمة أو null عند الفشل (والرسالة معروضة)
  async _fetchTargets() {
    const epoch = ++this._epoch;
    let result;
    try { result = await window.satr.desktopTargets(); } catch { result = null; }
    if (epoch !== this._epoch) return null;
    if (!result || result.ok !== true) {
      this._list = [];
      this._renderTargets();
      this._showMessage((result && result.message) || 'تعذّرت قراءة قائمة النوافذ.');
      return null;
    }
    this._list = Array.isArray(result.targets) ? result.targets : [];
    this._showMessage('');
    this._renderTargets();
    return this._list;
  }

  async refresh() {
    await this._fetchTargets();
  }

  _renderTargets() {
    this._targets.replaceChildren();
    if (!this._list.length) {
      const hint = document.createElement('div'); hint.className = 'hint';
      hint.textContent = 'لا نوافذ قابلة للاختيار الآن — افتح النافذة التي تريد (مثل المفكرة) ثم «تحديث».';
      this._targets.appendChild(hint);
    }
    for (const target of this._list) this._targets.appendChild(this._targetRow(target));
    this._renderSelected();
  }

  _targetRow(target) {
    const row = document.createElement('div'); row.className = 'target';
    const isSelected = sameTarget(target, this._selected);
    row.classList.toggle('selected', isSelected);
    if (isSelected) row.setAttribute('aria-current', 'true');
    const main = document.createElement('div'); main.className = 'target-main';
    const label = document.createElement('span'); label.className = 'target-label';
    label.textContent = processLabel(target.processName);
    const titleLine = document.createElement('div'); titleLine.className = 'target-title';
    const title = document.createElement('bdi');
    const titleText = clip(target.title || '', MAX_TITLE_POINTS);
    title.textContent = titleText || '(بلا عنوان)';
    title.setAttribute('dir', textDir(titleText) || 'ltr');
    titleLine.title = target.title || '';
    titleLine.appendChild(title);
    const meta = document.createElement('div'); meta.className = 'target-meta';
    const id = document.createElement('bdi'); id.className = 'tech'; id.textContent = target.targetId;
    meta.appendChild(id);
    if (target.rect) {
      const size = document.createElement('bdi'); size.className = 'tech';
      size.textContent = target.rect.w + '×' + target.rect.h;
      meta.appendChild(size);
    }
    main.appendChild(label); main.appendChild(titleLine); main.appendChild(meta);
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = isSelected ? '✓ المختارة' : 'اختر لهذه الجلسة';
    button.dataset.selected = isSelected ? '1' : '0';
    button.disabled = this._busy || isSelected;
    button.addEventListener('click', () => this._select(target));
    row.appendChild(main); row.appendChild(button);
    return row;
  }

  _renderSelected() {
    const t = this._selected;
    this._selectedBox.classList.toggle('on', !!t);
    this._clear.hidden = !t;
    if (!t) {
      this._selectedText.textContent = 'لم تُختر نافذة — الوكيل لا يرى أي نافذة.';
      this._selectedText.removeAttribute('dir');
      return;
    }
    this._selectedText.replaceChildren();
    this._selectedText.appendChild(document.createTextNode('المختارة: ' + processLabel(t.processName) + ' '));
    const title = document.createElement('bdi');
    const titleText = clip(t.title || '', MAX_TITLE_POINTS);
    title.textContent = titleText ? '«' + titleText + '»' : '';
    title.setAttribute('dir', textDir(titleText) || 'ltr');
    const id = document.createElement('bdi'); id.className = 'tech'; id.textContent = t.targetId;
    this._selectedText.appendChild(title);
    this._selectedText.appendChild(document.createTextNode(' '));
    this._selectedText.appendChild(id);
    this._selectedText.setAttribute('dir', 'rtl');
  }

  async _trySelect(target) {
    try { return await window.satr.desktopSelect(target.targetId, target.pid); } catch { return null; }
  }

  // اختيار بالمعرّف ورقم العملية وحدهما (satr:desktopSelect يرفض أي مفتاح زائد). رفض not_allowed يعني غالباً
  // أن مستطيل النافذة تغيّر بين السرد والنقر ⇒ سرد جديد **مرة واحدة** ثم محاولة ثانية بالهوية نفسها،
  // وإن تكرّر الرفض تُعرض رسالة main كما هي (لا حلقة).
  async _select(target) {
    if (this._busy || !target) return;
    this._setBusy(true);
    this._showMessage('');
    let result = await this._trySelect(target);
    if (result && result.ok === false && result.error === 'not_allowed') {
      const fresh = await this._fetchTargets();
      const again = fresh && fresh.find((t) => sameTarget(t, target));
      if (again) result = await this._trySelect(again);
    }
    this._setBusy(false);
    if (result && result.ok === true && result.target) {
      this._selected = Object.assign({}, result.target);
      this._renderTargets();
      this.dispatchEvent(new CustomEvent('desktop-selection', { detail: { target: this.selected } }));
      this._notice('🪟 اختيرت نافذة ' + processLabel(result.target.processName) + ' (' + result.target.targetId + ') لهذه الجلسة وحدها.');
      return;
    }
    this._renderTargets();
    this._showMessage((result && result.message) || 'تعذّر اختيار النافذة — حدّث القائمة واختر من جديد.');
  }

  // سحب الاختيار = نهاية جلسة سطح المكتب في main (كل فعل بعده closed والمعين يُغلق)
  async clearSelection(options) {
    const silent = !!(options && options.silent);
    if (!this._selected) return true;
    this._setBusy(true);
    let result;
    try { result = await window.satr.desktopClear(); } catch { result = null; }
    this._setBusy(false);
    if (result && result.ok === true) {
      this._selected = null;
      this._renderTargets();
      this.dispatchEvent(new CustomEvent('desktop-selection', { detail: { target: null } }));
      if (!silent) this._notice('🪟 سُحب اختيار النافذة — انتهت جلسة سطح المكتب، وأي فعل بعده يُرفض.');
      return true;
    }
    this._showMessage((result && result.message) || 'تعذّر سحب اختيار النافذة.');
    return false;
  }

  // سطر سجل لكل desktop_activity: النص كما وصل (منقّى ومقصوص في main) + زمن الواجهة؛ الأقدم يسقط بعد 200
  appendActivity(ev) {
    const text = ev && typeof ev.text === 'string' ? ev.text.slice(0, MAX_ACTIVITY_TEXT) : '';
    if (!text.trim()) return null;
    const now = new Date();
    const stamp = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    const entry = { text, stamp };
    this._activity.push(entry);
    const li = document.createElement('li');
    const time = document.createElement('bdi'); time.className = 'time'; time.textContent = stamp;
    const body = document.createElement('span'); body.className = 'text'; body.textContent = text;
    applyDir(body, text);
    li.appendChild(time); li.appendChild(body);
    this._log.appendChild(li);
    while (this._activity.length > MAX_ACTIVITY) {
      this._activity.shift();
      if (this._log.firstElementChild) this._log.firstElementChild.remove();
    }
    this._renderActivityCount();
    this._log.scrollTop = this._log.scrollHeight;
    return Object.assign({}, entry);
  }

  clearActivity() {
    this._activity = [];
    this._log.replaceChildren();
    this._renderActivityCount();
  }

  _renderActivityCount() {
    const count = this._activity.length;
    this._count.textContent = '(' + count + ')';
    this._empty.hidden = count > 0;
    this._clearLog.disabled = count === 0;
  }
}

SatrDesktopPanel.PROCESS_LABELS = PROCESS_LABELS;
SatrDesktopPanel.MAX_ACTIVITY = MAX_ACTIVITY;

customElements.define('satr-desktop-panel', SatrDesktopPanel);
