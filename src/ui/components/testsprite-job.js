// <satr-testsprite-job> — بطاقة حالة جولة TestSprite الدائمة أعلى منطقة المحادثة
// (العقد المجمّد v1 — قرار المالك 2026-08-06؛ القسم 4 واجهة). مستقلة عن الدور
// والجلسة: حدث testsprite_job يُبث من main مباشرة (نمط bg_procs) فتلتقطه القشرة
// خارج token الدور وتمرّره هنا. تظهر البطاقة عند snapshot نشط، وبعد الحالة
// النهائية تبقى معروضة حتى يغلقها المستخدم يدوياً بزر ✕.
// العقد للخارج: handleEvent(ev) «من مجرى satr:event» · boot() «عند الإقلاع —
// يلتقط جولة حية بعد reload عبر window.satr.testspriteJobStatus()، محروساً بـ
// typeof فلا ينكسر الإقلاع قبل دمج قناة كودكس». كل البيانات تُعرض بـ textContent.
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

// مفردات الحالة الست حرفياً من العقد المجمّد — لا تُغيَّر دون قرار مالك.
const STATE_LABELS = {
  preparing: 'تجهيز الجولة',
  awaiting_setup: 'بانتظار حفظ نموذج الإعداد',
  running: 'قيد التنفيذ',
  completed: 'اكتملت',
  cancelled: 'أُلغيت',
  failed: 'متوقفة بسبب البنية',
};
const FINAL_STATES = new Set(['completed', 'cancelled', 'failed']);
const KIND_LABELS = { app: 'التطبيق', site: 'الموقع' };
const STALL_MS = 45000; // فوقها بلا نبضة ⇒ تنبيه هادئ «لا نشاط مرصود» دون ادعاء تعليق

const ownSheet = sheet(`
  :host { display: none; flex: none; padding: var(--space-3) var(--space-4) 0; }
  :host([open]) { display: block; }
  .card {
    max-width: 640px; margin: 0 auto; border: 1px solid var(--border);
    border-radius: var(--radius-lg); background: var(--surface);
    padding: var(--space-2) var(--space-3); box-shadow: var(--shadow-pop);
  }
  .head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); flex: none; }
  .card[data-state="completed"] .dot { background: var(--green); }
  .card[data-state="failed"] .dot { background: var(--red); }
  .card[data-state="cancelled"] .dot { background: var(--text-faint); }
  .card[data-state="preparing"] .dot,
  .card[data-state="awaiting_setup"] .dot,
  .card[data-state="running"] .dot { animation: pulse 1.6s var(--ease) infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .title { font-weight: 600; color: var(--text); }
  .kind { color: var(--text-faint); font-size: 12px; }
  .state { font-weight: 600; color: var(--gold); }
  .card[data-state="completed"] .state { color: var(--green); }
  .card[data-state="failed"] .state { color: var(--red); }
  .card[data-state="cancelled"] .state { color: var(--text-dim); }
  .heart { color: var(--text-dim); font-size: 12px; margin-inline-start: auto; }
  .stop { font-size: 12.5px; }
  .stop:disabled { opacity: .5; cursor: not-allowed; }
  .close {
    border: none; background: transparent; color: var(--text-dim);
    padding: var(--space-1) var(--space-1h); font-size: 13px;
  }
  .close:hover { color: var(--text); background: var(--surface-3); }
  .counters { display: flex; flex-wrap: wrap; gap: var(--space-1h) var(--space-3); margin-top: var(--space-1h); }
  .counter { font-size: 12.5px; color: var(--text-dim); }
  .counter b { color: var(--text); font-weight: 600; }
  .counter.passed b { color: var(--green); }
  .counter.failed b { color: var(--red); }
  .meta { display: flex; flex-wrap: wrap; gap: var(--space-1h) var(--space-3); margin-top: var(--space-1h); align-items: baseline; }
  .meta .tech { font: 11.5px var(--mono); direction: ltr; color: var(--text-faint); }
  .stall { color: var(--text-dim); font-size: 12px; }
  .failure { font-size: 12px; color: var(--red); }
`);

class SatrTestspriteJob extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [controlsSheet, ownSheet];
    r.innerHTML =
      '<div class="card" role="status" aria-label="حالة جولة TestSprite">' +
        '<div class="head">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<span class="title">🧪 جولة TestSprite</span>' +
          '<span class="kind"></span>' +
          '<span class="state"></span>' +
          '<span class="heart"></span>' +
          '<button class="stop" type="button">⏹ إيقاف الجولة</button>' +
          '<button class="close" type="button" aria-label="إغلاق البطاقة" hidden>✕</button>' +
        '</div>' +
        '<div class="counters"></div>' +
        '<div class="meta"></div>' +
      '</div>';
    this._card = r.querySelector('.card');
    this._kind = r.querySelector('.kind');
    this._state = r.querySelector('.state');
    this._heart = r.querySelector('.heart');
    this._stopBtn = r.querySelector('.stop');
    this._closeBtn = r.querySelector('.close');
    this._counters = r.querySelector('.counters');
    this._meta = r.querySelector('.meta');
    this._snap = null;
    this._stopping = false;
    this._stopBtn.addEventListener('click', () => this._stop());
    this._closeBtn.addEventListener('click', () => {
      // إغلاق يدوي للنهائي: يخفي البطاقة ويمسح اللقطة — جولة جديدة تعيد فتحها
      this._snap = null;
      this.removeAttribute('open');
    });
  }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    // تحديث «آخر نشاط قبل Xث» محلياً كل ثانية من heartbeat_at (بلا انتظار حدث)
    this._timer = setInterval(() => this._tick(), 1000);
    this.boot();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._wired = false;
  }

  // التقاط جولة حية عند الإقلاع (reload أثناء جولة). محروس بـ typeof: قناة
  // testspriteJobStatus يكشفها كودكس بالتوازي، وغيابها لا يجوز أن يكسر الإقلاع.
  boot() {
    if (typeof window.satr === 'undefined' || !window.satr) return;
    if (typeof window.satr.testspriteJobStatus !== 'function') return;
    Promise.resolve(window.satr.testspriteJobStatus()).then((snap) => {
      if (!snap || snap.active === false || typeof snap.job_id !== 'string') return;
      this._applySnapshot(snap);
    }).catch(() => {});
  }

  // من مجرى satr:event — schema v1 حصراً (العقد المجمّد §2)
  handleEvent(ev) {
    if (!ev || ev.type !== 'testsprite_job' || ev.schema_version !== 1) return;
    this._applySnapshot(ev);
  }

  _applySnapshot(snap) {
    if (!snap || typeof snap.state !== 'string') return;
    this._snap = snap;
    this._stopping = false;
    this.setAttribute('open', '');
    this._render();
  }

  _render() {
    const snap = this._snap;
    if (!snap) return;
    const isFinal = FINAL_STATES.has(snap.state);
    this._card.dataset.state = snap.state;
    this._state.textContent = STATE_LABELS[snap.state] || snap.state;
    this._kind.textContent = KIND_LABELS[snap.kind] ? '· ' + KIND_LABELS[snap.kind] : '';
    // العدادات — summary دفاعي، ومنها blocked «محجوبة» حرفياً
    const s = snap.summary && typeof snap.summary === 'object' ? snap.summary : {};
    const num = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    const items = [
      ['الإجمالي', num(s.total), ''],
      ['اكتملت', num(s.completed), ''],
      ['نجحت', num(s.passed), 'passed'],
      ['فشلت', num(s.failed), 'failed'],
      ['تخطّت', num(s.skipped), ''],
      ['محجوبة', num(s.blocked), ''],
    ];
    this._counters.textContent = '';
    for (const [label, value, cls] of items) {
      const chip = document.createElement('span');
      chip.className = 'counter' + (cls ? ' ' + cls : '');
      chip.appendChild(document.createTextNode(label + ' '));
      const b = document.createElement('b');
      b.textContent = String(value);
      chip.appendChild(b);
      this._counters.appendChild(chip);
    }
    // الميتا: المنفذ (الواجهة تبني http://127.0.0.1:port للعرض) والمعرف — LTR داخل bdi
    this._meta.textContent = '';
    if (Number.isInteger(snap.port) && snap.port > 0) {
      const port = document.createElement('span');
      port.appendChild(document.createTextNode('المنفذ: '));
      const bdi = document.createElement('bdi');
      bdi.dir = 'ltr';
      bdi.className = 'tech';
      bdi.textContent = 'http://127.0.0.1:' + snap.port;
      port.appendChild(bdi);
      this._meta.appendChild(port);
    }
    if (typeof snap.job_id === 'string' && snap.job_id) {
      const jid = document.createElement('span');
      jid.appendChild(document.createTextNode('المعرّف: '));
      const bdi = document.createElement('bdi');
      bdi.dir = 'ltr';
      bdi.className = 'tech';
      bdi.textContent = snap.job_id;
      jid.appendChild(bdi);
      this._meta.appendChild(jid);
    }
    const stall = document.createElement('span');
    stall.className = 'stall';
    stall.hidden = true;
    stall.textContent = 'لا نشاط مرصود';
    this._meta.appendChild(stall);
    this._stall = stall;
    if (snap.state === 'failed' && typeof snap.failure_code === 'string' && snap.failure_code) {
      const failure = document.createElement('span');
      failure.className = 'failure';
      failure.appendChild(document.createTextNode('رمز التوقف: '));
      const bdi = document.createElement('bdi');
      bdi.dir = 'ltr';
      bdi.className = 'tech';
      bdi.textContent = snap.failure_code;
      failure.appendChild(bdi);
      this._meta.appendChild(failure);
    }
    // زر الإيقاف يُعطَّل بعد الحالات النهائية، والنهائي يُغلق يدوياً بزر ✕
    this._stopBtn.disabled = isFinal;
    this._stopBtn.textContent = '⏹ إيقاف الجولة';
    this._closeBtn.hidden = !isFinal;
    this._tick();
  }

  // نبضة محلية كل ثانية: عمر heartbeat_at + تنبيه «لا نشاط مرصود» فوق 45ث
  // (الحالات النهائية تجمّد النص — الجولة انتهت فلا معنى لعدّ تصاعدي أبدي).
  _tick() {
    const snap = this._snap;
    if (!snap || !this.hasAttribute('open')) return;
    if (FINAL_STATES.has(snap.state)) return;
    const hb = Number(snap.heartbeat_at);
    if (!Number.isFinite(hb) || hb <= 0) { this._heart.textContent = ''; return; }
    const ageMs = Date.now() - hb;
    this._heart.textContent = 'آخر نشاط قبل ' + Math.max(0, Math.floor(ageMs / 1000)) + 'ث';
    if (this._stall) this._stall.hidden = ageMs <= STALL_MS;
  }

  async _stop() {
    const snap = this._snap;
    if (!snap || FINAL_STATES.has(snap.state) || this._stopping) return;
    if (typeof window.satr === 'undefined' || !window.satr
        || typeof window.satr.testspriteJobCancel !== 'function') return;
    if (!window.confirm('إيقاف جولة TestSprite الجارية؟\nستُلغى الجولة ولن تُستأنف من نقطة توقفها.')) return;
    this._stopping = true;
    this._stopBtn.disabled = true;
    this._stopBtn.textContent = 'يُوقَف…';
    try {
      await window.satr.testspriteJobCancel(snap.job_id);
    } catch (_) { /* الحدث القادم يعكس الحالة الحقيقية */ }
    // إن لم تصل حالة نهائية (رفض الإلغاء مثلاً) يعود الزر فعالاً
    if (this._snap === snap && !FINAL_STATES.has(snap.state)) {
      this._stopping = false;
      this._stopBtn.disabled = false;
      this._stopBtn.textContent = '⏹ إيقاف الجولة';
    }
  }
}

customElements.define('satr-testsprite-job', SatrTestspriteJob);
