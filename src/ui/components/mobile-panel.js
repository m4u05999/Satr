// <satr-mobile-panel> — إدارة قناة التحكم المحلية من الجوال (م1).
// لا يرى المكوّن مفاتيح أو سجلات خاماً؛ كل القيم المعروضة عادت من IPC منقّى في main.js.
import { sheet } from '../lib/sheet.js';
import { panelSheet } from '../lib/panel.css.js';

const ownSheet = sheet(`
  :host { width: min(440px, 52vw); }
  .mobile-content { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); overflow-y: auto; }
  .card { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2); padding: var(--space-3); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .row + .row { margin-top: var(--space-2); }
  .title { font-weight: 600; color: var(--text); }
  .hint { color: var(--text-dim); font-size: 12px; line-height: 1.7; unicode-bidi: plaintext; }
  .state { color: var(--text-dim); font-size: 12px; }
  .state.on { color: var(--green); }
  .state.off { color: var(--red); }
  .switch { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
  .switch input { accent-color: var(--gold); inline-size: 18px; block-size: 18px; }
  .tech { direction: ltr; unicode-bidi: isolate; font-family: var(--mono); overflow-wrap: anywhere; text-align: left; }
  .url { margin-top: var(--space-2); padding: var(--space-2); border-radius: var(--radius-sm); background: var(--bg); font-size: 11px; }
  .pair-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
  .pairing { margin-top: var(--space-3); }
  textarea {
    width: 100%; min-height: 112px; resize: vertical; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2);
    font: 11px/1.6 var(--mono); direction: ltr; unicode-bidi: isolate; outline: none;
  }
  textarea:focus { border-color: var(--gold); }
  .sas { font: 600 18px var(--mono); direction: ltr; letter-spacing: .12em; color: var(--gold); }
  .devices { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }
  .device { border-top: 1px solid var(--border); padding-top: var(--space-2); }
  .device:first-child { border-top: 0; padding-top: 0; }
  .device-main { display: flex; align-items: center; gap: var(--space-2); }
  .device-label { flex: 1; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
  .device-id { margin-top: var(--space-1); color: var(--text-dim); font-size: 10.5px; }
  .revoked { color: var(--red); font-size: 11px; }
  .device button { font-size: 11px; padding: 3px var(--space-2); }
  button:disabled, input:disabled { opacity: .55; cursor: default; }
`);

class SatrMobilePanel extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [panelSheet, ownSheet];
    root.innerHTML =
      '<div class="panel-head">' +
        '<span>التحكم من الجوال</span>' +
        '<span class="panel-head-actions">' +
          '<button class="refresh" type="button" title="تحديث">تحديث</button>' +
          '<button class="close" type="button" title="إغلاق">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="mobile-content">' +
        '<section class="card">' +
          '<div class="row">' +
            '<div><div class="title">القناة المحلية</div><div class="state">جارٍ قراءة الحالة…</div></div>' +
            '<label class="switch"><span>تفعيل</span><input class="enable" type="checkbox"></label>' +
          '</div>' +
          '<div class="url tech" hidden></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="title">اقتران جهاز</div>' +
          '<div class="hint">أنشئ رمز اقتران أحادي الاستخدام صالحاً لثلاث دقائق. في م1 يُعرض النص القابل للنسخ؛ QR البصري تحسين لاحق.</div>' +
          '<div class="pair-actions"><button class="pair" type="button">إنشاء رمز اقتران</button><button class="copy" type="button" disabled>نسخ الرمز</button></div>' +
          '<div class="pairing" hidden><textarea readonly aria-label="رمز الاقتران"></textarea></div>' +
          '<div class="row"><span class="hint">رمز التحقق المتوقع (SAS)</span><span class="sas">——</span></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="row"><span class="title">الأجهزة المقترنة</span><span class="device-count state">0</span></div>' +
          '<div class="devices"><div class="hint">لا توجد أجهزة مقترنة.</div></div>' +
        '</section>' +
      '</div>';

    this._state = root.querySelector('.state');
    this._enable = root.querySelector('.enable');
    this._url = root.querySelector('.url');
    this._pair = root.querySelector('.pair');
    this._copy = root.querySelector('.copy');
    this._pairing = root.querySelector('.pairing');
    this._payload = root.querySelector('textarea');
    this._sas = root.querySelector('.sas');
    this._devices = root.querySelector('.devices');
    this._deviceCount = root.querySelector('.device-count');
    this._epoch = 0;

    root.querySelector('.close').addEventListener('click', () => this.close());
    root.querySelector('.refresh').addEventListener('click', () => this.refresh());
    this._enable.addEventListener('change', () => this._setEnabled(this._enable.checked));
    this._pair.addEventListener('click', () => this._startPairing());
    this._copy.addEventListener('click', () => this._copyPayload());
  }

  _notice(text) {
    this.dispatchEvent(new CustomEvent('notice', { detail: text }));
  }

  open() {
    this.setAttribute('open', '');
    this.refresh();
  }

  close() {
    this.removeAttribute('open');
    // رمز الاقتران يحمل سراً أحادي الاستخدام؛ لا نُبقيه في DOM بعد إغلاق اللوحة.
    this._payload.value = '';
    this._pairing.hidden = true;
    this._copy.disabled = true;
    this.dispatchEvent(new CustomEvent('panel-close'));
  }

  focusInitial() { this._enable.focus(); }

  async refresh() {
    const epoch = ++this._epoch;
    try {
      const [status, listed] = await Promise.all([
        window.satr.mobileStatus(), window.satr.mobileDevices(),
      ]);
      if (epoch !== this._epoch) return;
      this._renderStatus(status || {});
      this._renderDevices(Array.isArray(listed) ? listed : []);
    } catch {
      if (epoch !== this._epoch) return;
      this._state.textContent = 'تعذّرت قراءة حالة القناة';
      this._state.className = 'state off';
    }
  }

  _renderStatus(status) {
    const enabled = status.enabled === true;
    const running = status.running === true;
    this._enable.checked = enabled;
    this._state.textContent = running ? 'متصلة بالشبكة المحلية' : (enabled ? 'مفعّلة وغير متصلة' : 'متوقفة');
    this._state.className = 'state ' + (running ? 'on' : 'off');
    this._url.hidden = !status.url;
    this._url.textContent = status.url || '';
    this._pair.disabled = !running;
    this._sas.textContent = typeof status.sas === 'string' ? status.sas : '——';
  }

  async _setEnabled(enable) {
    this._enable.disabled = true;
    try {
      const status = await window.satr.mobileEnable(enable);
      this._renderStatus(status || {});
      if (!status || status.error) {
        this._notice(enable ? '✗ تعذّر تشغيل قناة الجوال المحلية' : '✗ تعذّر إيقاف قناة الجوال');
      } else {
        this._notice(enable ? '✓ فُعّلت قناة التحكم من الجوال' : 'أُوقفت قناة التحكم من الجوال');
      }
    } catch {
      this._notice('✗ تعذّر تغيير حالة قناة الجوال');
    } finally {
      this._enable.disabled = false;
      this.refresh();
    }
  }

  async _startPairing() {
    this._pair.disabled = true;
    try {
      const result = await window.satr.mobilePairingStart();
      if (!result || !result.ok || typeof result.qr !== 'string') {
        this._notice('✗ تعذّر إنشاء رمز الاقتران');
        return;
      }
      this._payload.value = result.qr;
      this._pairing.hidden = false;
      this._copy.disabled = false;
      this._notice('✓ أُنشئ رمز اقتران صالح لثلاث دقائق');
    } catch {
      this._notice('✗ تعذّر إنشاء رمز الاقتران');
    } finally {
      this._pair.disabled = false;
    }
  }

  async _copyPayload() {
    if (!this._payload.value) return;
    try {
      await navigator.clipboard.writeText(this._payload.value);
      this._notice('✓ نُسخ رمز الاقتران');
    } catch {
      this._payload.focus();
      this._payload.select();
      this._notice('حدّد الرمز لنسخه يدوياً');
    }
  }

  _renderDevices(devices) {
    this._devices.replaceChildren();
    this._deviceCount.textContent = String(devices.filter((device) => !device.revoked).length);
    if (!devices.length) {
      const hint = document.createElement('div'); hint.className = 'hint';
      hint.textContent = 'لا توجد أجهزة مقترنة.';
      this._devices.appendChild(hint);
      return;
    }
    for (const device of devices) this._devices.appendChild(this._deviceRow(device));
  }

  _deviceRow(device) {
    const box = document.createElement('div'); box.className = 'device';
    const main = document.createElement('div'); main.className = 'device-main';
    const label = document.createElement('span'); label.className = 'device-label'; label.dir = 'auto';
    label.textContent = device.label || 'جهاز جوال';
    main.appendChild(label);
    if (device.revoked) {
      const revoked = document.createElement('span'); revoked.className = 'revoked'; revoked.textContent = 'مُبطَل';
      main.appendChild(revoked);
    } else {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'إبطال';
      button.addEventListener('click', () => this._revoke(device, button));
      main.appendChild(button);
    }
    const id = document.createElement('div'); id.className = 'device-id tech'; id.textContent = device.deviceId;
    const seen = document.createElement('div'); seen.className = 'hint';
    seen.textContent = 'آخر ظهور: ' + this._formatTime(device.lastSeen);
    box.appendChild(main); box.appendChild(id); box.appendChild(seen);
    return box;
  }

  _formatTime(value) {
    if (!Number.isFinite(value) || value <= 0) return 'غير معروف';
    try { return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return 'غير معروف'; }
  }

  async _revoke(device, button) {
    if (!window.confirm('إبطال «' + (device.label || 'جهاز جوال') + '»؟ سيحتاج إلى اقتران جديد.')) return;
    button.disabled = true;
    try {
      const result = await window.satr.mobileRevoke(device.deviceId);
      this._notice(result && result.ok ? '✓ أُبطل الجهاز' : '✗ تعذّر إبطال الجهاز');
    } catch { this._notice('✗ تعذّر إبطال الجهاز'); }
    this.refresh();
  }
}

customElements.define('satr-mobile-panel', SatrMobilePanel);
