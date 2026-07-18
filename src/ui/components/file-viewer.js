// <satr-file-viewer> — عارض القراءة (الدفعة 1.2) + التظليل (4.3) + الاتجاه الموحّد
// + التحرير الخفيف (4.5) — تفكيك ت-7. نقل حرفي لمنطق القشرة.
// العقد: open(cwd, rel, line?) يفتح ويقرأ (line يقفز لسطر نتيجة بحث 4.6)، close()،
// handleEscape() تستدعيها سلسلة Escape في القشرة — تعيد true إن استهلكت الضغطة
// (تحرير ⇒ عودة للقراءة بسؤال؛ قراءة ⇒ إغلاق). حدث «file-saved» {card} بعد حفظ ناجح
// — القشرة تعرض بطاقة الفرق في المحادثة (addStandaloneDiff تبقى ملكها حتى ت-12).
// التظليل باستيراد مباشر من lib/highlight.js (المكوّن وحدة — لا حاجة للجسر).
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';
import { HL_CFG, hlLine } from '../lib/highlight.js';

const MAX_VIEW_LINES = 5000; // سقف أسطر DOM (الملفات الأطول تُقصّ مع ملاحظة)

const ownSheet = sheet(`
  /* المضيف هو الغلاف المعتم (كان #viewerOverlay) */
  /* بين اللوحات (--z-panel) وحوارات القرار (--z-modal تعلوه) — القيمة تطابق 90 القديمة */
  :host { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-toast); display: none; }
  :host([open]) { display: flex; }
  :host([open]) .viewer-box { animation: pop var(--dur) var(--ease); }
  @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.985); } }
  .viewer-box { margin: auto; width: min(1020px, 94vw); height: 86vh; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-modal); }
  .viewer-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .viewer-name { font-family: var(--mono); direction: ltr; text-align: left; color: var(--gold); font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .viewer-meta { font-size: 11.5px; color: var(--text-dim); font-family: var(--mono); direction: ltr; white-space: nowrap; }
  .viewer-body { flex: 1; overflow: auto; background: var(--bg-deep); }
  pre { margin: 0; padding: 10px 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.65; direction: ltr; text-align: left; counter-reset: ln; width: max-content; min-width: 100%; }
  /* السطر flex: عمود أرقام ثابت (::before عنصر flex مجهول) + نص السطر .lt بأساس
     اتجاه موحّد للملف (قبول 4.3 — لقطات مالك). ملف كود: أرقام يساراً ونص pre يمتد أفقياً */
  pre .l { display: flex; counter-increment: ln; }
  pre .l::before { content: counter(ln); flex: 0 0 64px; padding-inline-end: 16px; color: var(--text-faint); text-align: right; user-select: none; }
  pre .lt { flex: 1; white-space: pre; padding-inline-end: 16px; min-width: 0; }
  /* وضع «مستند عربي» (rtl-doc): مرآة كاملة — الأرقام عمود يميناً، النص يرسو يميناً
     بجانبها، والأسطر الطويلة تلتف داخل العرض (pre-wrap) بدل التمدد الأفقي القاطع للقراءة */
  pre.rtl-doc { width: auto; }
  pre.rtl-doc .l { flex-direction: row-reverse; }
  pre.rtl-doc .l::before { text-align: left; padding-inline-end: 8px; padding-inline-start: 16px; }
  /* text-align: right ضرورية صراحةً — الوراثة تغلب اتجاه dir=rtl (لقطة مالك مثبّتة) */
  pre.rtl-doc .lt { white-space: pre-wrap; overflow-wrap: anywhere; padding-inline-end: 0; text-align: right; }
  /* سطر القفز من نتيجة بحث (4.6) */
  pre .l.hit { background: var(--gold-soft); }
  /* تظليل الكود البسيط (4.3): أربع فئات رموز فقط — بألوان الـ tokens */
  .hl-c { color: var(--text-faint); font-style: italic; } /* تعليق */
  .hl-s { color: var(--green); }                          /* نص مقتبس */
  .hl-k { color: var(--gold); }                           /* كلمة مفتاحية */
  .hl-n { color: var(--blue); }                           /* رقم */
  .viewer-note { padding: 8px 14px; font-size: 12px; color: var(--gold); border-top: 1px solid var(--border); }
  .viewer-note[hidden] { display: none; }
  /* تحرير خفيف (4.5): textarea بديل يملأ الجسم — تراجع/إعادة أصليان وIME عربي سليم؛
     بلا تظليل ولا أرقام أسطر أثناء التحرير (مقايضة واعية — قبول المالك للنطاق) */
  textarea { display: none; width: 100%; height: 100%; border: 0; outline: none; resize: none; background: var(--bg-deep); color: var(--text); font-family: var(--mono); font-size: 12.5px; line-height: 1.65; padding: 10px 16px; box-sizing: border-box; }
  .viewer-body.editing { overflow: hidden; }
  .viewer-body.editing textarea { display: block; }
  .viewer-body.editing pre { display: none; }
  .viewer-dirty { color: var(--gold); font-size: 15px; line-height: 1; }
  .viewer-dirty[hidden] { display: none; }
  button[hidden] { display: none; }
`);

class SatrFileViewer extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.adoptedStyleSheets = [controlsSheet, ownSheet];
    r.innerHTML =
      '<div class="viewer-box">' +
        '<div class="viewer-head">' +
          '<span class="viewer-name"></span>' +
          '<span class="viewer-dirty" title="تغييرات غير محفوظة" hidden>●</span>' +
          '<span class="viewer-meta"></span>' +
          '<button class="edit" type="button" title="تحرير الملف" hidden>✏️ تحرير</button>' +
          '<button class="save" type="button" title="حفظ التغييرات (Ctrl+S)" hidden>💾 حفظ</button>' +
          '<button class="cancel" type="button" title="إلغاء التحرير والعودة للقراءة" hidden>إلغاء</button>' +
          '<button class="dir" type="button" title="اتجاه العرض: تلقائي (عربي يميناً وكود يساراً) أو تجاوز يدوي RTL/LTR">الاتجاه: تلقائي</button>' +
          '<button class="x" title="إغلاق">✕</button>' +
        '</div>' +
        '<div class="viewer-body"><pre></pre><textarea spellcheck="false"></textarea></div>' +
        '<div class="viewer-note" hidden></div>' +
      '</div>';
    const q = (s) => r.querySelector(s);
    this._body = q('.viewer-body'); this._pre = q('pre'); this._ta = q('textarea');
    this._name = q('.viewer-name'); this._meta = q('.viewer-meta'); this._note = q('.viewer-note');
    this._dirtyMark = q('.viewer-dirty');
    this._btnEdit = q('.edit'); this._btnSave = q('.save'); this._btnCancel = q('.cancel');
    this._btnDir = q('.dir');

    // حالة العارض (كانت متغيّرات القشرة)
    this._cwd = '';
    this._rel = '';
    this._raw = null;        // المحتوى الخام كما قُرئ من القرص (أساس كشف «غير محفوظ»)
    this._version = null;    // بصمة نسخة الفتح — تمنع الكتابة فوق تغيير خارجي صامت
    this._editable = false;  // قابل للتحرير (قُرئ كاملاً بلا قصّ)
    this._dirty = false;
    this._dirMode = 'auto';  // تلقائي ← RTL ← LTR (يعود تلقائياً كل فتح)
    this._fileDir = 'ltr';   // ما حسمه «تلقائي» للملف المفتوح

    q('.x').addEventListener('click', () => this._requestClose());
    this._btnEdit.addEventListener('click', () => this._enterEdit());
    this._btnSave.addEventListener('click', () => this._save());
    this._btnCancel.addEventListener('click', () => { if (this._confirmDiscard()) this._exitEdit(); });
    this._btnDir.addEventListener('click', () => {
      this._dirMode = this._dirMode === 'auto' ? 'rtl' : (this._dirMode === 'rtl' ? 'ltr' : 'auto');
      this._applyDir();
    });
    this._ta.addEventListener('input', () => this._setDirty(this._ta.value !== this._raw));
    this._ta.addEventListener('keydown', (e) => {
      // Ctrl+S يحفظ داخل التحرير (حدّ موثّق: Tab ينقل التركيز — تحرير خفيف لا محرّر)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this._save(); }
    });
    // النقر على الخلفية المعتمة (المضيف خارج الصندوق) يغلق.
    // ⚠️ درس مثبّت بالمسبار: e.target على مستمع المضيف يُعاد توجيهه (retargeting)
    // إلى المضيف نفسه لكل نقرة قادمة من داخل Shadow — فكانت أزرار العارض تغلقه!
    // composedPath()[0] يعيد الهدف الحقيقي داخل الشجرة الظليلة.
    this.addEventListener('click', (e) => { if (e.composedPath()[0] === this) this._requestClose(); });
  }

  // سلسلة Escape (القشرة توجّه): تعيد true إن استهلك العارض الضغطة
  handleEscape() {
    if (!this.hasAttribute('open')) return false;
    // Esc أثناء التحرير يعود للقراءة (بسؤال عند تغيير غير محفوظ) — لا يغلق العارض
    if (this._body.classList.contains('editing')) {
      if (this._confirmDiscard()) this._exitEdit();
      return true;
    }
    this.close();
    return true;
  }

  _setDirty(d) {
    this._dirty = d;
    this._dirtyMark.hidden = !d;
    this._btnSave.disabled = !d;
  }
  _enterEdit() {
    if (!this._editable || this._raw == null) return;
    this._body.classList.add('editing');
    this._ta.value = this._raw;
    this._ta.dir = this._dirMode === 'auto' ? this._fileDir : this._dirMode; // يرث اتجاه العرض المحسوم
    this._btnEdit.hidden = true;
    this._btnSave.hidden = false;
    this._btnCancel.hidden = false;
    this._setDirty(false);
    this._ta.focus();
  }
  _exitEdit() {
    this._body.classList.remove('editing');
    this._ta.value = '';
    this._btnEdit.hidden = this._raw == null; // لا زرّ تحرير قبل قراءة ناجحة
    this._btnSave.hidden = true;
    this._btnCancel.hidden = true;
    this._setDirty(false);
  }
  // يسأل عند وجود تغيير غير محفوظ — يعيد true لو جاز المتابعة
  _confirmDiscard() {
    return !this._dirty || confirm('توجد تغييرات غير محفوظة — تجاهلها؟');
  }
  async _save() {
    if (!this._dirty) { this._exitEdit(); return; }
    const content = this._ta.value;
    this._btnSave.disabled = true;
    const r = await window.satr.writeFile(this._cwd, this._rel, content, this._version);
    if (!r || !r.ok) {
      const why = {
        too_big: 'المحتوى أكبر من سقف الكتابة (1م.ب)', outside: 'المسار خارج مجلد المشروع',
        notfound: 'الملف غير موجود على القرص', bad_cwd: 'مجلد المشروع غير موجود', bad_input: 'مدخل غير صالح',
        bad_version: 'نسخة الملف المفتوحة غير صالحة — أعد فتح الملف',
        conflict: 'تغيّر الملف على القرص بعد فتحه — لم يُكتب شيء. احتفظ بنصك ثم أعد فتح الملف',
      };
      this._note.textContent = '⚠️ تعذّر الحفظ: ' + (why[(r && r.error) || ''] || (r && r.message) || 'خطأ غير معروف');
      this._note.hidden = false;
      this._btnSave.disabled = false;
      return;
    }
    // بطاقة فرق + تراجع في المحادثة (توثيق مرئي) — القشرة تعرضها
    if (r.card) this.dispatchEvent(new CustomEvent('file-saved', { detail: r.card }));
    this._exitEdit();
    await this.open(this._cwd, this._rel); // إعادة قراءة من القرص: عرض مظلَّل حديث + حالة صادقة
  }
  close() {
    this._raw = null;
    this._version = null;
    this._exitEdit();
    this.removeAttribute('open');
    this._pre.textContent = '';
  }
  // إغلاق «مهذّب»: أثناء تحرير غير محفوظ يسأل أولاً (Esc/خلفية/زرّ ✕)
  _requestClose() {
    if (this._body.classList.contains('editing') && !this._confirmDiscard()) return;
    this.close();
  }

  // اتجاه العرض (قبول 4.3 — لقطتا مالك): أساس اتجاه موحّد للملف كله لا لكل سطر.
  _applyDir() {
    const label = { auto: 'تلقائي', rtl: 'RTL', ltr: 'LTR' };
    this._btnDir.textContent = 'الاتجاه: ' + label[this._dirMode];
    const dir = this._dirMode === 'auto' ? this._fileDir : this._dirMode;
    this._pre.classList.toggle('rtl-doc', dir === 'rtl'); // مرآة كاملة: أرقام يميناً + التفاف
    for (const lt of this._pre.querySelectorAll('.lt')) lt.dir = dir;
  }

  // line اختياري (بحث المحتوى 4.6): يميّز السطر ويوسّطه بعد البناء
  async open(cwd, rel, line) {
    this._cwd = cwd || '';
    this._dirMode = 'auto'; // «تعديل مؤقت» — كل فتح يبدأ تلقائياً
    this._raw = null; this._version = null; this._rel = rel; this._editable = false;
    this._exitEdit(); // فتح جديد = وضع قراءة نظيف (زرّ التحرير يظهر بعد قراءة ناجحة)
    this._btnDir.textContent = 'الاتجاه: تلقائي';
    this._name.textContent = rel;
    this._meta.textContent = '';
    this._note.hidden = true;
    this._pre.textContent = '';
    this.setAttribute('open', '');
    const r = await window.satr.readFile(this._cwd, rel);
    if (!r || !r.ok) {
      const why = {
        outside: 'المسار خارج مجلد المشروع', notfound: 'الملف غير موجود',
        binary: 'ملف ثنائي — لا يُعرض نصاً', error: 'تعذّرت قراءة الملف',
        bad_cwd: 'مجلد المشروع غير موجود', bad_input: 'مدخل غير صالح',
      };
      this._note.textContent = '⚠️ ' + (why[(r && r.error) || ''] || 'خطأ غير معروف');
      this._note.hidden = false;
      return;
    }
    let lines = r.content.split('\n');
    const clipped = lines.length > MAX_VIEW_LINES;
    if (clipped) lines = lines.slice(0, MAX_VIEW_LINES);
    // تحرير خفيف: المحتوى الخام محفوظ للتحرير — المقصوص لا يُحرَّر (حفظه يُتلف بقية الملف)
    this._raw = r.content;
    this._version = typeof r.version === 'string' ? r.version : null;
    this._editable = /^[a-f0-9]{64}$/.test(this._version || '') && !r.truncated && !clipped;
    this._btnEdit.hidden = false;
    this._btnEdit.disabled = !this._editable;
    this._btnEdit.title = this._editable ? 'تحرير الملف'
      : 'الملف أطول من حدّ العرض — التحرير على الجزء المعروض يُتلف بقيته';
    // تظليل حسب الامتداد (4.3) — امتداد غير معروف يبقى نصاً خاماً كما كان
    const ext = (rel.split('.').pop() || '').toLowerCase();
    const cfg = HL_CFG[ext] || null;
    // «تلقائي»: ملف كود = LTR دائماً؛ غيره (md/txt/…) بإحصاء عيّنة المحارف
    if (cfg) this._fileDir = 'ltr';
    else {
      const sample = r.content.slice(0, 65536);
      const ar = (sample.match(/[؀-ۿ]/g) || []).length;
      const lat = (sample.match(/[A-Za-z]/g) || []).length;
      this._fileDir = ar >= lat * 0.5 ? 'rtl' : 'ltr';
    }
    const dirNow = this._dirMode === 'auto' ? this._fileDir : this._dirMode;
    const hlState = { block: false };
    const frag = document.createDocumentFragment();
    for (const ln of lines) {
      const d = document.createElement('div');
      d.className = 'l';
      // نص السطر في عمود مستقل بأساس اتجاه الملف الموحّد (لا لكل سطر — قبول 4.3)
      const lt = document.createElement('span');
      lt.className = 'lt';
      lt.dir = dirNow;
      const text = ln.replace(/\r$/, ''); // السطر الفارغ يبقى بارتفاعه (رقم السطر في ::before يملؤه)
      if (cfg) hlLine(lt, text, cfg, hlState);
      else lt.textContent = text;
      d.appendChild(lt);
      frag.appendChild(d);
    }
    this._pre.appendChild(frag);
    this._applyDir(); // يطبّق صنف rtl-doc (مرآة الأرقام + الالتفاف) حسب الاتجاه المحسوم
    const kb = (r.bytes / 1024).toFixed(r.bytes < 10240 ? 1 : 0);
    this._meta.textContent = kb + ' KB · ' + lines.length + (clipped || r.truncated ? '+' : '') + ' سطر';
    if (r.truncated || clipped) {
      this._note.textContent = '✂️ الملف أطول من حدّ العرض — يُعرض أوله فقط (' +
        (r.truncated ? '256 ك.ب' : MAX_VIEW_LINES + ' سطر') + ')';
      this._note.hidden = false;
    }
    // قفز لسطر نتيجة بحث (4.6): تمييز + توسيط — سطر خارج المعروض يُتجاهل بأمان
    if (line > 0 && line <= this._pre.children.length) {
      const target = this._pre.children[line - 1];
      target.classList.add('hit');
      target.scrollIntoView({ block: 'center' });
    }
  }
}

customElements.define('satr-file-viewer', SatrFileViewer);
