// <satr-elicitation-dialog> — طلبات إدخال موصّلات Claude غير السرّية.
// العقد: ask({id,server,mode,fields,url?}) يعرض form نصياً أو URL مصادقة غير قابل للنقر.
// الرد الوحيد عبر window.satr.elicitationDone؛ URL لا يُعاد من renderer، وزر الفتح نفسه
// هو التأكيد الصريح. closeAll() للعرض فقط لأن agent.js يحسم الطلبات المعلقة بـ decline.
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const SAFE_ID = /^el_[a-f0-9]{32}$/;

function codePointLength(value) { return Array.from(value).length; }

const ownSheet = sheet(`
  :host {
    position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-modal);
    display: none; align-items: center; justify-content: center;
  }
  :host([open]) { display: flex; }
  :host([open]) .el-box { animation: pop var(--dur) var(--ease); }
  @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.985); } }
  .el-box {
    background: var(--surface-2); border: 1px solid var(--gold); border-radius: var(--radius-xl);
    padding: var(--space-4) var(--space-5); width: 560px; max-width: 92vw; max-height: 86vh;
    display: flex; flex-direction: column; box-shadow: var(--shadow-modal);
  }
  h3 { color: var(--gold); font-size: 16px; margin-bottom: var(--space-1); }
  .el-intro, .el-warning { color: var(--text-dim); font-size: 12px; line-height: 1.7; }
  .el-server { color: var(--text); margin-top: var(--space-2); }
  .tech {
    direction: ltr; unicode-bidi: isolate; font-family: var(--mono); color: var(--text);
    overflow-wrap: anywhere;
  }
  .el-fields { overflow-y: auto; margin-top: var(--space-3); }
  .el-field { display: block; margin-top: var(--space-3); }
  .el-field:first-child { margin-top: 0; }
  .el-label { color: var(--text); font-weight: 600; unicode-bidi: plaintext; }
  .el-name { display: block; margin-top: var(--space-1); font-size: 11px; color: var(--text-faint); }
  .el-input {
    width: 100%; box-sizing: border-box; margin-top: var(--space-2); padding: var(--space-2h) var(--space-3);
    border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--text);
    unicode-bidi: plaintext;
  }
  .el-input:focus { border-color: var(--gold); outline: none; }
  .el-warning {
    margin-top: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--gold-soft);
    border: 1px solid var(--gold-border); border-radius: var(--radius-md); color: var(--text);
  }
  .el-url {
    direction: ltr; text-align: start; unicode-bidi: isolate; font-family: var(--mono); font-size: 12px;
    margin-top: var(--space-3); padding: var(--space-3); background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius-md); overflow-wrap: anywhere;
    max-height: 140px; overflow-y: auto; user-select: text;
  }
  .el-msg { color: var(--red); font-size: 12px; margin-top: var(--space-2h); }
  .el-actions { display: flex; gap: var(--space-2); margin-top: var(--space-4); flex-wrap: wrap; }
  .el-actions .submit { background: var(--gold); color: var(--on-gold); border: none; font-weight: 600; }
  .el-actions .cancel { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
  .el-actions button:disabled { opacity: .5; cursor: not-allowed; }
`);

class SatrElicitationDialog extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [controlsSheet, ownSheet];
    root.innerHTML =
      '<div class="el-box" role="dialog" aria-modal="true" aria-label="طلب إدخال من موصّل Claude">' +
        '<h3>🔌 طلب من موصّل Claude</h3>' +
        '<div class="el-intro"></div>' +
        '<div class="el-server"></div>' +
        '<div class="el-fields"></div>' +
        '<div class="el-url" hidden></div>' +
        '<div class="el-warning">لا تُدخل كلمة مرور أو رمزاً أو مفتاحاً هنا. للمصادقة السرّية استخدم <bdi class="tech">/mcp</bdi> في Claude Code أو <bdi class="tech">browser_handoff</bdi>.</div>' +
        '<div class="el-msg" hidden></div>' +
        '<div class="el-actions">' +
          '<button class="submit">إرسال القيم</button>' +
          '<button class="cancel">إلغاء</button>' +
        '</div>' +
      '</div>';
    this._intro = root.querySelector('.el-intro');
    this._server = root.querySelector('.el-server');
    this._fields = root.querySelector('.el-fields');
    this._url = root.querySelector('.el-url');
    this._submit = root.querySelector('.submit');
    this._cancel = root.querySelector('.cancel');
    this._msg = root.querySelector('.el-msg');
    this._queue = [];
    this._current = null;
    this._inputs = [];
    this._sending = false;
    this._requestEpoch = 0;
    this._submit.addEventListener('click', () => this._accept());
    this._cancel.addEventListener('click', () => this._decline());
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') this._trapFocus(event);
      else if (event.key === 'Escape') { event.preventDefault(); this._decline(); }
    });
  }

  ask(request) {
    const fields = request && Array.isArray(request.fields) ? request.fields : null;
    const mode = request && request.mode;
    if (!request || !SAFE_ID.test(String(request.id || '')) || typeof request.server !== 'string'
      || !request.server || codePointLength(request.server) > 160) return;
    if ((mode !== 'form' && mode !== 'url') || !fields || fields.length > 20) return;
    if (mode === 'form' && !fields.length) return;
    if (mode === 'url' && (fields.length || typeof request.url !== 'string' || codePointLength(request.url) > 2048)) return;
    if (fields.some((field) => !field || typeof field.name !== 'string' || !field.name
      || codePointLength(field.name) > 160
      || (field.label != null && (typeof field.label !== 'string' || codePointLength(field.label) > 400)))) return;
    if ((this._current && this._current.id === request.id) || this._queue.some((item) => item.id === request.id)) return;
    this._queue.push({
      id: request.id,
      server: request.server,
      mode,
      fields: fields.map((field) => ({ name: field.name, label: field.label || '' })),
      url: mode === 'url' ? request.url : '',
    });
    this._showNext();
  }

  closeAll() {
    this._requestEpoch += 1;
    this._queue.length = 0;
    this._current = null;
    this._scrubInputs();
    this._sending = false;
    this._submit.disabled = false;
    this._cancel.disabled = false;
    this._fields.textContent = '';
    this._url.textContent = '';
    this._setOpen(false);
  }

  _scrubInputs() {
    for (const field of this._inputs) field.input.value = '';
    this._inputs = [];
  }
  _setOpen(on) {
    if (on) this.setAttribute('open', ''); else this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('perm-visible', { bubbles: true, detail: this.hasAttribute('open') }));
    if (on) queueMicrotask(() => {
      const focusTarget = this.shadowRoot.querySelector('.el-input') || this._submit;
      if (focusTarget) focusTarget.focus();
    });
  }

  _trapFocus(event) {
    const items = [...this.shadowRoot.querySelectorAll('input, button:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(this.shadowRoot.activeElement);
    const next = event.shiftKey
      ? items[(current <= 0 ? items.length : current) - 1]
      : items[(current + 1) % items.length];
    event.preventDefault();
    next.focus();
  }

  _showNext() {
    if (this._current || !this._queue.length) return;
    this._current = this._queue.shift();
    this._render(this._current);
    this._setOpen(true);
  }

  _render(request) {
    this._fields.textContent = '';
    this._url.textContent = '';
    this._url.hidden = true;
    this._msg.hidden = true;
    this._msg.textContent = '';
    this._inputs = [];
    this._submit.textContent = request.mode === 'url' ? 'افتح في متصفح النظام' : 'إرسال القيم';
    this._intro.textContent = request.mode === 'url'
      ? 'يحتاج الموصّل فتح صفحة مصادقة خارجية. راجع الرابط ثم افتحه بنفسك؛ لن يفتح تلقائياً.'
      : 'يطلب الموصّل معلومات غير سرّية لإكمال الأداة.';
    this._server.textContent = 'الموصّل: ';
    const serverName = document.createElement('span');
    serverName.className = 'tech';
    serverName.textContent = request.server;
    this._server.appendChild(serverName);

    if (request.mode === 'url') {
      this._url.textContent = request.url;
      this._url.hidden = false;
      return;
    }
    for (const field of request.fields) {
      const wrapper = document.createElement('label');
      wrapper.className = 'el-field';
      const label = document.createElement('span');
      label.className = 'el-label';
      label.textContent = field.label || field.name;
      wrapper.appendChild(label);
      if (field.label) {
        const name = document.createElement('span');
        name.className = 'el-name tech';
        name.textContent = field.name;
        wrapper.appendChild(name);
      }
      const input = document.createElement('input');
      input.className = 'el-input';
      input.type = 'text';
      input.dir = 'auto';
      input.maxLength = 2000;
      input.autocomplete = 'off';
      input.spellcheck = false;
      wrapper.appendChild(input);
      this._fields.appendChild(wrapper);
      this._inputs.push({ name: field.name, input });
    }
  }

  async _accept() {
    if (!this._current || this._sending) return;
    if (this._current.mode === 'url') {
      await this._resolve('accept', undefined, '↗ فُتحت صفحة الموصّل في متصفح النظام.');
      return;
    }
    const content = Object.create(null);
    for (const field of this._inputs) content[field.name] = field.input.value;
    await this._resolve('accept', content, '✓ أُرسلت القيم غير السرّية إلى الموصّل.');
  }

  async _decline() {
    if (!this._current || this._sending) return;
    await this._resolve('decline', undefined, '↩︎ رُفض طلب إدخال الموصّل.');
  }

  async _resolve(action, content, okNotice) {
    const request = this._current;
    const epoch = this._requestEpoch;
    this._sending = true;
    this._submit.disabled = true;
    this._cancel.disabled = true;
    this._msg.hidden = true;
    let reply = null;
    try { reply = await window.satr.elicitationDone(request.id, action, content); }
    catch { reply = null; }
    if (epoch !== this._requestEpoch || this._current !== request) return;
    this._sending = false;
    this._cancel.disabled = false;
    if (reply && reply.ok) {
      this._current = null;
      this._scrubInputs();
      this._fields.textContent = '';
      this._url.textContent = '';
      this._setOpen(false);
      const notice = reply.declined && reply.error === 'secret'
        ? 'رُفضت القيمة لأنها تبدو سرّية؛ استخدم مسار المصادقة الآمن.'
        : okNotice;
      this.dispatchEvent(new CustomEvent('notice', { detail: notice }));
      this._showNext();
      return;
    }
    this._msg.textContent = reply && reply.error === 'open_failed'
      ? '⚠️ تعذّر فتح متصفح النظام — حاول مرة أخرى أو ألغِ الطلب.'
      : '⚠️ تعذّر حسم الطلب — حاول مرة أخرى.';
    this._msg.hidden = false;
    this._submit.disabled = false;
  }
}

customElements.define('satr-elicitation-dialog', SatrElicitationDialog);
