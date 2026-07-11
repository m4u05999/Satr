// <satr-perm-dialog> — مربع حوار أذونات الأدوات العربي (محرك SDK والمحوّلات) — تفكيك ت-8.
// المكوّن يملك الطابور والعرض؛ نص التفاصيل تُحضّره القشرة (toolDetail مشتركة مع بطاقات
// المحادثة فتبقى فيها). العقد: request({id, tool, detail}) يضيف للطابور ويعرض التالي،
// closeAll() يفرّغه عند انتهاء/إيقاف الدور (الردود المعلّقة تفكّها العملية الرئيسية).
// الرد عبر window.satr.permission مباشرة (نفس الأصل) + حدث «notice» بالنص العربي
// فتعرضه القشرة في خيط المحادثة. لا إغلاق بنقر الخلفية (قرار الأصل — طلب إذن يُجاب).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .55); z-index: 100;
    display: none; align-items: center; justify-content: center;
  }
  :host([open]) { display: flex; }
  :host([open]) .perm-box { animation: pop var(--dur) var(--ease); }
  @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.985); } }
  .perm-box {
    background: var(--surface-2); border: 1px solid var(--gold); border-radius: 14px;
    padding: 20px 22px; width: 500px; max-width: 92vw;
    box-shadow: var(--shadow-modal);
  }
  h3 { color: var(--gold); font-size: 16px; margin-bottom: 10px; }
  .tool-name {
    font-family: var(--mono); direction: ltr; unicode-bidi: embed;
    color: var(--text); background: var(--bg); border-radius: 6px; padding: 2px 8px;
  }
  .perm-detail {
    font-family: var(--mono); text-align: start;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 10px; margin: 10px 0 0; font-size: 12px;
    max-height: 180px; overflow: auto; white-space: pre-wrap;
    /* plaintext: كل سطر يحلّ اتجاهه بنفسه (أمر لاتيني LTR، رسالة عربية RTL).
       overflow-wrap يلفّ الرموز الطويلة دون كسر الحروف العربية وسط الكلمة */
    unicode-bidi: plaintext; overflow-wrap: anywhere;
  }
  .perm-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  .perm-actions .allow { background: var(--green); color: #10250D; border: none; font-weight: 600; }
  .perm-actions .deny { background: var(--red); color: #fff; border: none; font-weight: 600; }
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
        '<div class="perm-detail" dir="ltr"></div>' +
        '<div class="perm-actions">' +
          '<button class="allow">موافقة</button>' +
          '<button class="always">موافقة دائمة لهذه الأداة</button>' +
          '<button class="deny">رفض</button>' +
        '</div>' +
      '</div>';
    this._tool = r.querySelector('.tool-name');
    this._detail = r.querySelector('.perm-detail');
    this._queue = [];
    this._current = null;
    r.querySelector('.allow').addEventListener('click', () => this._answer(true, false));
    r.querySelector('.always').addEventListener('click', () => this._answer(true, true));
    r.querySelector('.deny').addEventListener('click', () => this._answer(false, false));
  }

  // طلب جديد من مجرى الأحداث: {id, tool, detail} — detail نص عرض جاهز من القشرة
  request(req) {
    this._queue.push(req);
    this._showNext();
  }

  // ضبط ظهور المربع + بثّ الحالة — القشرة تحجب المعاينة أثناء ظهوره فيبرز فوقها
  // (WebContentsView طبقة نظام فوق DOM؛ بلا هذا يختبئ المربع خلف المعاينة — لقطة مالك)
  _setOpen(on) {
    if (on) this.setAttribute('open', ''); else this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('perm-visible', { bubbles: true, detail: this.hasAttribute('open') }));
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
    this._setOpen(true);
  }

  _answer(allow, always) {
    if (!this._current) return;
    const req = this._current;
    this._current = null;
    this._setOpen(false);
    window.satr.permission(req.id, allow, !!always);
    this.dispatchEvent(new CustomEvent('notice', {
      detail: allow
        ? (always ? '✓ موافقة دائمة على أداة ' + req.tool : '✓ تمت الموافقة على أداة ' + req.tool)
        : '✗ رُفض استخدام أداة ' + req.tool,
    }));
    this._showNext();
  }
}

customElements.define('satr-perm-dialog', SatrPermDialog);
