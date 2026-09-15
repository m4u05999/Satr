// <satr-perm-dialog> — مربع حوار أذونات الأدوات العربي (المحركات الأصلية والمحوّلات) — تفكيك ت-8.
// المكوّن يملك الطابور والعرض؛ نص التفاصيل تُحضّره القشرة (toolDetail مشتركة مع بطاقات
// المحادثة فتبقى فيها). العقد: request({id, tool, detail}) يضيف للطابور ويعرض التالي،
// closeAll() يفرّغه عند انتهاء/إيقاف الدور (الردود المعلّقة تفكّها العملية الرئيسية).
// الرد عبر window.satr.permission مباشرة (نفس الأصل) + حدث «notice» بالنص العربي
// فتعرضه القشرة في خيط المحادثة. لا إغلاق بنقر الخلفية (قرار الأصل — طلب إذن يُجاب).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host {
    position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-modal);
    display: none; align-items: center; justify-content: center;
  }
  :host([open]) { display: flex; }
  :host([open]) .perm-box { animation: pop var(--dur) var(--ease); }
  @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.985); } }
  .perm-box {
    background: var(--surface-2); border: 1px solid var(--gold); border-radius: var(--radius-xl);
    padding: 20px var(--space-5); width: 500px; max-width: 92vw;
    box-shadow: var(--shadow-modal);
  }
  h3 { color: var(--gold); font-size: 16px; margin-bottom: var(--space-2h); }
  .tool-name {
    font-family: var(--mono); direction: ltr; unicode-bidi: embed;
    color: var(--text); background: var(--bg); border-radius: var(--radius-sm); padding: 2px var(--space-2);
  }
  .perm-detail {
    font-family: var(--mono); text-align: start;
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-2h); margin: var(--space-2h) 0 0; font-size: 12px;
    max-height: 180px; overflow: auto; white-space: pre-wrap;
    /* plaintext: كل سطر يحلّ اتجاهه بنفسه (أمر لاتيني LTR، رسالة عربية RTL).
       overflow-wrap يلفّ الرموز الطويلة دون كسر الحروف العربية وسط الكلمة */
    unicode-bidi: plaintext; overflow-wrap: anywhere;
  }
  .requester, .pending-count { margin-top: var(--space-2); color: var(--text-dim); font-size: 12px; }
  /* طلب حسّاس (‏defaultToNo): سطر يشرح لماذا لا يقبل المربع ضغطة مفتاح */
  .sensitive { margin-top: var(--space-2); color: var(--red); font-size: 12px; font-weight: 600; }
  .requester[hidden], .pending-count[hidden], .turn[hidden], .sensitive[hidden] { display: none; }
  .perm-actions { display: flex; gap: var(--space-2); margin-top: var(--space-4); flex-wrap: wrap; }
  .perm-actions .allow { background: var(--green); color: var(--on-green); border: none; font-weight: 600; }
  .perm-actions .deny { background: var(--red); color: var(--on-danger); border: none; font-weight: 600; }
`);

class SatrPermDialog extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [controlsSheet, ownSheet];
    r.innerHTML =
      '<div class="perm-box">' +
        '<h3>🔐 طلب إذن لاستخدام أداة</h3>' +
        '<p>يطلب النموذج استخدام الأداة <span class="tool-name"></span></p>' +
        '<p class="requester" hidden></p>' +
        '<p class="sensitive" hidden>⚠ طلب حسّاس: القبول بالنقر الصريح — لا يقبله مفتاح.</p>' +
        '<div class="perm-detail" dir="ltr"></div>' +
        '<p class="pending-count" hidden></p>' +
        '<div class="perm-actions">' +
          '<button class="allow">موافقة</button>' +
          '<button class="turn" hidden>موافقة لهذه الأداة حتى نهاية الدور</button>' +
          '<button class="always">موافقة دائمة لهذه الأداة</button>' +
          '<button class="deny">رفض</button>' +
        '</div>' +
      '</div>';
    this._tool = r.querySelector('.tool-name');
    this._detail = r.querySelector('.perm-detail');
    this._requester = r.querySelector('.requester');
    this._pendingCount = r.querySelector('.pending-count');
    this._turn = r.querySelector('.turn');
    this._always = r.querySelector('.always');
    this._sensitive = r.querySelector('.sensitive');
    this._deny = r.querySelector('.deny');
    this._queue = [];
    this._current = null;
    this._buttons = [...r.querySelectorAll('button')];
    r.querySelector('.allow').addEventListener('click', (e) => this._approve(e, false, false));
    this._turn.addEventListener('click', (e) => this._approve(e, false, true));
    r.querySelector('.always').addEventListener('click', (e) => this._approve(e, true, false));
    this._deny.addEventListener('click', () => this._answer(false, false));
    r.addEventListener('keydown', (event) => this._onKeyDown(event));
  }

  // ‏OBS-192 — عقد المحرّك بنصّه: «The ask must not be approvable by a single stray
  // keystroke: open the prompt on its decline option and offer no one-key approve
  // shortcut.» فالقبول في الطلب الحسّاس يلزمه نقر مؤشّر حقيقي: نقرة مولّدة بلوحة
  // المفاتيح (‏Enter/Space على زرّ مركَّز) تصل بـ`detail === 0`، والنقرة الحقيقية بـ≥ 1.
  // الرفض يبقى متاحاً بالمفتاح كاملاً — لا يُغلق الباب على من لا يستعمل فأرة.
  _approve(event, always, turn) {
    if (this._current && this._current.defaultToNo === true && !(event && event.detail > 0)) return;
    this._answer(true, always, turn);
  }

  // طلب جديد من مجرى الأحداث: {id, tool, detail} — detail نص عرض جاهز من القشرة
  request(req) {
    this._queue.push(req);
    this._showNext();
    this._renderPending();
  }

  // ضبط ظهور المربع + بثّ الحالة — القشرة تحجب المعاينة أثناء ظهوره فيبرز فوقها
  // (WebContentsView طبقة نظام فوق DOM؛ بلا هذا يختبئ المربع خلف المعاينة — لقطة مالك)
  _setOpen(on) {
    if (on) this.setAttribute('open', ''); else this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('perm-visible', { bubbles: true, detail: this.hasAttribute('open') }));
    // الطلب الحسّاس يفتح على «رفض» (الخيار المركَّز)، وغيره على «موافقة» كما كان.
    if (on) {
      const first = this._current && this._current.defaultToNo === true ? this._deny : this._buttons[0];
      queueMicrotask(() => first.focus());
    }
  }

  _onKeyDown(event) {
    // الطلب الحسّاس: Enter/Space على زرّ قبول لا يفعل شيئاً (نمنع النقرة الأصلية التي
    // يولّدها المتصفح قبل أن تُولد)؛ المفتاح على «رفض» يبقى عاملاً.
    if (this._current && this._current.defaultToNo === true
      && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')) {
      const target = event.composedPath ? event.composedPath()[0] : event.target;
      if (target && target !== this._deny && target.tagName === 'BUTTON') { event.preventDefault(); return; }
    }
    this._trapFocus(event);
  }

  _trapFocus(event) {
    if (event.key !== 'Tab') return;
    const buttons = this._buttons.filter((button) => !button.hidden && !button.disabled);
    const current = buttons.indexOf(this.shadowRoot.activeElement);
    const next = event.shiftKey
      ? buttons[(current <= 0 ? buttons.length : current) - 1]
      : buttons[(current + 1) % buttons.length];
    event.preventDefault(); next.focus();
  }

  // إعلان حسم الطلب بمعرّفه — إضافة OBS-207 (سطح الوكلاء الأحياء): الصف يقول «ينتظر
  // إذنك» ويلزمه أن يعرف متى زال الانتظار **بالمعرّف** لا بالتخمين. حدث إعلان بحت:
  // لا يمسّ الرد ولا ترتيبه ولا الطابور — يُبثّ بعد ما كان يحدث أصلاً.
  _announceAnswered(id, allow) {
    if (id == null || id === '') return;
    this.dispatchEvent(new CustomEvent('perm-answered', {
      bubbles: true, composed: true, detail: { id, allow: !!allow },
    }));
  }

  // انتهاء/إيقاف الدور: تفريغ الطابور وإخفاء المربع
  closeAll() {
    // الطلبات المسحوبة تُعلَن أيضاً (الردود المعلّقة تفكّها العملية الرئيسية): بلا هذا
    // يبقى صفّ الوكيل على «ينتظر إذنك» إلى الأبد بعد انتهاء الدور أو قرار الجوال.
    const dropped = this._current ? [this._current, ...this._queue] : [...this._queue];
    this._queue.length = 0;
    this._current = null;
    this._setOpen(false);
    for (const req of dropped) this._announceAnswered(req.id, false);
  }

  _showNext() {
    if (this._current || !this._queue.length) return;
    this._current = this._queue.shift();
    this._tool.textContent = this._current.tool;
    this._detail.textContent = this._current.detail || '';
    const requester = String(this._current.requester || '').trim();
    this._requester.hidden = !requester;
    this._requester.textContent = requester ? 'الطالب: ' + requester : '';
    this._turn.hidden = this._current.turnEligible !== true;
    // ‏alwaysEligible === false يخفي «الموافقة الدائمة» (قائم منذ كتلة المتصفح) — وهو
    // ما يصله الآن مضيَّقاً بـsuppressAlwaysAllowRule من المحرّك؛ والحارس يثبّته.
    this._always.hidden = this._current.alwaysEligible === false;
    this._sensitive.hidden = this._current.defaultToNo !== true;
    this._always.textContent = this._current.alwaysLabel || 'موافقة دائمة لهذه الأداة';
    this._renderPending();
    this._setOpen(true);
  }

  _renderPending() {
    const count = this._queue.length;
    this._pendingCount.hidden = count === 0;
    this._pendingCount.textContent = count ? 'وبعده ' + count + ' طلبات معلّقة' : '';
  }

  _answer(allow, always, turn) {
    if (!this._current) return;
    const req = this._current;
    this._current = null;
    this._setOpen(false);
    window.satr.permission(req.id, allow, !!always, !!turn);
    this.dispatchEvent(new CustomEvent('notice', {
      detail: allow
        ? (always ? (req.alwaysLabel ? '✓ وُثق بالنطاق لهذه الجلسة' : '✓ موافقة دائمة على أداة ' + req.tool)
          : (turn ? '✓ موافقة حتى نهاية الدور على أداة ' + req.tool : '✓ تمت الموافقة على أداة ' + req.tool))
        : '✗ رُفض استخدام أداة ' + req.tool,
    }));
    this._announceAnswered(req.id, allow);
    this._showNext();
  }
}

customElements.define('satr-perm-dialog', SatrPermDialog);
