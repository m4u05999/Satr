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
  .requester[hidden], .pending-count[hidden], .turn[hidden] { display: none; }
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
    this._queue = [];
    this._current = null;
    this._buttons = [...r.querySelectorAll('button')];
    r.querySelector('.allow').addEventListener('click', () => this._answer(true, false));
    this._turn.addEventListener('click', () => this._answer(true, false, true));
    r.querySelector('.always').addEventListener('click', () => this._answer(true, true));
    r.querySelector('.deny').addEventListener('click', () => this._answer(false, false));
    r.addEventListener('keydown', (event) => this._trapFocus(event));
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
    if (on) queueMicrotask(() => this._buttons[0].focus());
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

  // انتهاء/إيقاف الدور: تفريغ الطابور وإخفاء المربع
  closeAll() {
    this._queue.length = 0;
    this._current = null;
    this._setOpen(false);
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
    this._always.hidden = this._current.alwaysEligible === false;
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
    this._showNext();
  }
}

customElements.define('satr-perm-dialog', SatrPermDialog);
