// <satr-question-dialog> — أسئلة اختيار عربية (AskUserQuestion، محرك SDK).
// كانت الأداة محجوبة (canUseTool سماح/رفض فقط)؛ أُثبت حيّاً أن SDK يقبل إرجاع updatedInput
// يحمل الاختيار (scripts/ask-user-question-probe.js). العقد: ask({id, questions}) يعرض
// 1–4 أسئلة، كل سؤال بخيارات (radio للأحادي، checkbox للمتعدد). الرد **مؤشرات فقط**
// (selections:[{questionIndex, optionIndexes}]) عبر window.satr.answerQuestion — لا نص حر،
// فتبني العملية الرئيسية updatedInput من input الأصلي (أمان). closeAll() للإيقاف/الانتهاء.
// بيانات النموذج (question/label/description/preview) تُعرض بـ textContent حصراً (لا حقن).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .55); z-index: var(--z-modal);
    display: none; align-items: center; justify-content: center;
  }
  :host([open]) { display: flex; }
  :host([open]) .q-box { animation: pop var(--dur) var(--ease); }
  @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.985); } }
  .q-box {
    background: var(--surface-2); border: 1px solid var(--gold); border-radius: 14px;
    padding: 18px 20px; width: 560px; max-width: 92vw; max-height: 86vh;
    display: flex; flex-direction: column; box-shadow: var(--shadow-modal);
  }
  h3 { color: var(--gold); font-size: 16px; margin-bottom: 4px; }
  .q-list { overflow-y: auto; margin-top: 6px; }
  .q-item { margin-top: 14px; }
  .q-item:first-child { margin-top: 8px; }
  .q-header { font-size: 12px; color: var(--text-dim); margin-bottom: 2px; }
  .q-text { color: var(--text); font-weight: 600; margin-bottom: 8px; }
  .q-options { display: flex; flex-direction: column; gap: 6px; }
  .q-opt {
    display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg); cursor: pointer;
    transition: border-color var(--dur) var(--ease);
  }
  .q-opt:hover { border-color: var(--gold); }
  .q-opt input { margin-top: 3px; flex: none; accent-color: var(--gold); }
  .q-opt-body { flex: 1; min-width: 0; }
  .q-opt-label { color: var(--text); }
  .q-opt-desc { font-size: 12px; color: var(--text-dim); margin-top: 2px; unicode-bidi: plaintext; }
  .q-opt-preview {
    font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); direction: ltr; text-align: start;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 8px; margin-top: 6px; max-height: 140px; overflow: auto;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .q-msg { color: var(--red); font-size: 12px; margin-top: 10px; }
  .q-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .q-actions .submit { background: var(--gold); color: var(--on-gold); border: none; font-weight: 600; }
  .q-actions .submit:disabled { opacity: .5; cursor: not-allowed; }
  .q-actions .cancel { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
  .q-actions button:disabled { opacity: .5; cursor: not-allowed; }
`);

class SatrQuestionDialog extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [controlsSheet, ownSheet];
    r.innerHTML =
      '<div class="q-box" role="dialog" aria-modal="true" aria-label="أسئلة من النموذج">' +
        '<h3>💬 يسأل النموذج</h3>' +
        '<div class="q-list"></div>' +
        '<div class="q-msg" hidden></div>' +
        '<div class="q-actions">' +
          '<button class="submit">إرسال الإجابة</button>' +
          '<button class="cancel">إلغاء</button>' +
        '</div>' +
      '</div>';
    this._list = r.querySelector('.q-list');
    this._submit = r.querySelector('.submit');
    this._cancel = r.querySelector('.cancel');
    this._msg = r.querySelector('.q-msg');
    this._queue = [];
    this._current = null;
    this._sending = false; // منع النقر المكرر أثناء انتظار الرد
    this._requestEpoch = 0; // يبطل أي رد IPC قديم بعد الإيقاف/انتهاء الدور
    this._groups = []; // لكل سؤال: { multiSelect, inputs:[HTMLInputElement] }
    this._submit.addEventListener('click', () => this._send());
    this._cancel.addEventListener('click', () => this._doCancel());
    r.addEventListener('keydown', (event) => { if (event.key === 'Tab') this._trapFocus(event); });
  }

  // طلب جديد من مجرى الأحداث: {id, questions} — questions منقّاة في العملية الرئيسية
  ask(req) {
    if (!req || !Array.isArray(req.questions) || !req.questions.length) return;
    this._queue.push(req);
    this._showNext();
  }

  // انتهاء/إيقاف الدور: تفريغ الطابور وإخفاء المربع (الردود المعلّقة تفكّها العملية الرئيسية)
  closeAll() {
    this._requestEpoch += 1;
    this._queue.length = 0;
    this._current = null;
    this._sending = false;
    this._cancel.disabled = false;
    this._setOpen(false);
  }

  _setOpen(on) {
    if (on) this.setAttribute('open', ''); else this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('perm-visible', { bubbles: true, detail: this.hasAttribute('open') }));
    if (on) queueMicrotask(() => { const f = this.shadowRoot.querySelector('.q-opt input'); if (f) f.focus(); });
  }

  _trapFocus(event) {
    const items = [...this.shadowRoot.querySelectorAll('input, button:not(:disabled)')];
    if (!items.length) return;
    const cur = items.indexOf(this.shadowRoot.activeElement);
    const next = event.shiftKey ? items[(cur <= 0 ? items.length : cur) - 1] : items[(cur + 1) % items.length];
    event.preventDefault(); next.focus();
  }

  _showNext() {
    if (this._current || !this._queue.length) return;
    this._current = this._queue.shift();
    this._render(this._current.questions);
    this._setOpen(true);
  }

  // بناء الأسئلة بـ DOM آمن (createElement/textContent) — لا innerHTML لبيانات النموذج
  _render(questions) {
    this._list.textContent = '';
    this._msg.hidden = true; this._msg.textContent = '';
    this._groups = [];
    questions.forEach((q, qi) => {
      const item = document.createElement('div'); item.className = 'q-item';
      if (q.header) { const h = document.createElement('div'); h.className = 'q-header'; h.textContent = q.header; item.appendChild(h); }
      const text = document.createElement('div'); text.className = 'q-text'; text.textContent = q.question || ''; item.appendChild(text);
      const opts = document.createElement('div'); opts.className = 'q-options';
      const inputs = [];
      const options = Array.isArray(q.options) ? q.options : [];
      options.forEach((o, oi) => {
        const lab = document.createElement('label'); lab.className = 'q-opt';
        const input = document.createElement('input');
        input.type = q.multiSelect ? 'checkbox' : 'radio';
        input.name = 'q_' + qi; // عزل مجموعة الاختيار لكل سؤال
        input.value = String(oi);
        input.addEventListener('change', () => this._syncSubmit());
        lab.appendChild(input);
        const body = document.createElement('div'); body.className = 'q-opt-body';
        const l = document.createElement('div'); l.className = 'q-opt-label'; l.textContent = o.label || ''; body.appendChild(l);
        if (o.description) { const d = document.createElement('div'); d.className = 'q-opt-desc'; d.textContent = o.description; body.appendChild(d); }
        if (o.preview) { const p = document.createElement('pre'); p.className = 'q-opt-preview'; p.textContent = o.preview; body.appendChild(p); }
        lab.appendChild(body);
        opts.appendChild(lab);
        inputs.push(input);
      });
      item.appendChild(opts);
      this._list.appendChild(item);
      this._groups.push({ multiSelect: !!q.multiSelect, inputs });
    });
    this._syncSubmit();
  }

  // زر الإرسال مفعّل فقط حين يُجاب كل سؤال (اختيار واحد على الأقل لكلٍّ)
  _syncSubmit() {
    const answeredAll = this._groups.every((g) => g.inputs.some((i) => i.checked));
    this._submit.disabled = !answeredAll || !this._groups.length || this._sending;
  }

  async _send() {
    if (!this._current || this._sending) return;
    const selections = this._groups.map((g, qi) => ({
      questionIndex: qi,
      optionIndexes: g.inputs.map((i, oi) => (i.checked ? oi : -1)).filter((i) => i >= 0),
    }));
    if (!selections.every((s) => s.optionIndexes.length)) return; // كل الأسئلة مُجابة (دفاعياً)
    await this._resolve(selections, '✓ أُرسلت إجابتك على سؤال النموذج', 'تعذّر إرسال الإجابة — حاول مرة أخرى.');
  }

  // إلغاء: إجابة فارغة ⇒ deny في العملية الرئيسية (النموذج يكمل بلا اختيار)
  async _doCancel() {
    if (!this._current || this._sending) return;
    await this._resolve([], '↩︎ أُلغيت الإجابة على سؤال النموذج', 'تعذّر الإلغاء — حاول مرة أخرى.');
  }

  // ينتظر رد العملية الرئيسية (P2-b): نجاح ⇒ إغلاق؛ فشل ⇒ إبقاء الحوار وإعادة تفعيل الأزرار.
  async _resolve(selections, okNotice, failMsg) {
    const req = this._current;
    const epoch = this._requestEpoch;
    this._sending = true;
    this._submit.disabled = true; this._cancel.disabled = true; this._msg.hidden = true;
    let ok = false;
    try { const r = await window.satr.answerQuestion(req.id, selections); ok = !!(r && r.ok); }
    catch (e) { ok = false; }
    if (epoch !== this._requestEpoch || this._current !== req) return;
    this._sending = false;
    this._cancel.disabled = false;
    if (ok) {
      this._current = null;
      this._setOpen(false);
      this.dispatchEvent(new CustomEvent('notice', { detail: okNotice }));
      this._showNext();
    } else {
      // السؤال لا يزال معلّقاً — أبقِ الحوار، أظهر الخطأ، أعِد تفعيل الإرسال حسب الاختيار
      this._msg.textContent = '⚠️ ' + failMsg; this._msg.hidden = false;
      this._syncSubmit();
    }
  }
}

customElements.define('satr-question-dialog', SatrQuestionDialog);
