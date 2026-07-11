// <satr-preview-panel> — لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب»).
// المكوّن يرسم «إطار» اللوحة فقط (رأس بأزرار وعنوان + مساحة عرض فارغة) — الصفحة
// نفسها ترسمها WebContentsView أصلية في العملية الرئيسية **تطفو فوق** مساحة العرض:
// المكوّن يقيس مستطيل المساحة (getBoundingClientRect) ويبلّغه عبر satr:previewBounds
// (ResizeObserver + resize النافذة)، والأحداث تصله عبر onPreview (nav/title/loading/failed).
// **حدّ معماري موثّق**: العرض الأصلي فوق كل محتوى المتصفح — منبثقات الواجهة المركزية
// (مربع الأذونات مثلاً) قد تختفي جزئياً خلفه على الشاشات الضيقة (تُقيَّم معالجة لاحقاً).
// زر 🌐 في الشريط العلوي يربطه المكوّن بنفسه (نمط زر 🖥️ في الطرفية — ت-9).
// العقد للخارج: openWith(url) — تستدعيها القشرة عند اقتراح localhost المرصود.
import { sheet } from '../lib/sheet.js';
import { controlsSheet } from '../lib/panel.css.js';

const previewSheet = sheet(`
  :host { display: none; }
  :host([open]) {
    display: flex; flex-direction: column; position: relative;
    width: var(--pv-w, 44%); min-width: 280px; max-width: 78vw; flex: none;
    border-inline-start: 1px solid var(--border); background: var(--bg-deep);
  }
  .pv-head {
    display: flex; align-items: center; gap: 6px; padding: 7px 10px;
    background: var(--surface); border-bottom: 1px solid var(--border);
  }
  .pv-head button {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 4px 9px; font-size: 12.5px; cursor: pointer;
  }
  .pv-head button:hover { border-color: var(--gold); }
  .pv-head button:disabled { opacity: .45; cursor: default; border-color: var(--border); }
  #pvUrl {
    flex: 1; min-width: 0; direction: ltr; text-align: left; font-family: var(--mono);
    font-size: 12px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: 5px 9px; outline: none;
  }
  #pvUrl:focus { border-color: var(--gold); }
  #pvReload.loading { color: var(--gold); border-color: var(--gold-border); }
  #pvAuto.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  /* مساحة العرض: فارغة — WebContentsView الأصلية تُرسم فوقها بنفس المستطيل */
  #pvBox { flex: 1; position: relative; min-height: 0; }
  .pv-hint {
    position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
    align-items: center; justify-content: center; color: var(--text-dim);
    font-size: 13px; text-align: center; padding: 20px;
  }
  .pv-hint .big { font-size: 26px; }
  #pvErr {
    display: none; padding: 6px 12px; font-size: 12px; color: var(--red);
    background: var(--red-soft); border-top: 1px solid var(--red-border);
    unicode-bidi: plaintext;
  }
  #pvErr.show { display: block; }
  /* مقبض تغيير العرض على الحافة الملاصقة للمحادثة (inline-start = يمين في RTL) */
  #pvResizer {
    position: absolute; top: 0; bottom: 0; inset-inline-start: -3px; width: 7px;
    cursor: ew-resize; z-index: 5;
  }
  #pvResizer:hover { background: var(--gold-soft); }
`);

const MARKUP = `
  <div id="pvResizer" title="اسحب لتغيير العرض"></div>
  <div class="pv-head">
    <button id="pvClose" type="button" title="إغلاق المعاينة">✕</button>
    <button id="pvBack" type="button" title="رجوع" disabled>→</button>
    <button id="pvFwd" type="button" title="تقدم" disabled>←</button>
    <button id="pvReload" type="button" title="تحديث">⟳</button>
    <button id="pvAuto" type="button" title="تحديث تلقائي بعد كل تعديل من الوكيل">🔄</button>
    <input id="pvUrl" type="text" placeholder="http://localhost:3000 …" spellcheck="false">
  </div>
  <div id="pvBox">
    <div class="pv-hint" id="pvHint">
      <span class="big">🌐</span>
      <span>أدخل عنوان مشروعك أعلاه — أو شغّل خادم التطوير في الطرفية
      و«سطر» سيقترح فتحه هنا تلقائياً.</span>
    </div>
  </div>
  <div id="pvErr"></div>
`;

class SatrPreviewPanel extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [controlsSheet, previewSheet];
    const wrap = document.createElement('div');
    // الغلاف يرث flex العمودي من :host عبر display:contents
    wrap.style.display = 'contents';
    wrap.innerHTML = MARKUP;
    root.appendChild(wrap);
    const $ = (id) => root.getElementById(id);
    const urlIn = $('pvUrl'), box = $('pvBox'), hint = $('pvHint'), err = $('pvErr');
    const backBtn = $('pvBack'), fwdBtn = $('pvFwd'), reloadBtn = $('pvReload'), autoBtn = $('pvAuto');
    const toggleBtn = document.getElementById('previewToggle'); // زر الشريط العلوي (light DOM)

    let started = false; // هل حُمّل عنوان في العرض الأصلي؟

    // م-1-ج: تحديث تلقائي بعد تعديلات الوكيل (افتراضياً مُفعّل — طلب المالك «تتحدث مباشرة»).
    // القيمة المحفوظة '0' وحدها تُطفئه؛ أي شيء آخر (بما فيه الغياب أول مرة) = مُفعّل.
    let autoReload = localStorage.getItem('satr_preview_autoreload') !== '0';
    autoBtn.classList.toggle('on', autoReload);
    autoBtn.addEventListener('click', () => {
      autoReload = !autoReload;
      autoBtn.classList.toggle('on', autoReload);
      localStorage.setItem('satr_preview_autoreload', autoReload ? '1' : '0');
    });

    // عرض اللوحة المحفوظ (نمط ارتفاع الطرفية)
    const savedW = parseInt(localStorage.getItem('satr_preview_w') || '', 10);
    if (savedW && savedW >= 280) this.style.setProperty('--pv-w', savedW + 'px');

    // ---------- إبلاغ مستطيل مساحة العرض للعملية الرئيسية ----------
    // WebContentsView تُرسم فوق pvBox — أي تغيير تخطيط (فتح الطرفية/تغيير حجم/سحب
    // المقبض) يغيّر المستطيل، وResizeObserver يلتقطه كله. إحداثيات CSS px = DIP.
    let boundsRaf = 0;
    const reportBounds = () => {
      if (!this.hasAttribute('open') || !started) return;
      cancelAnimationFrame(boundsRaf);
      boundsRaf = requestAnimationFrame(() => {
        const r = box.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        window.satr.previewBounds(Math.round(r.left), Math.round(r.top),
          Math.round(r.width), Math.round(r.height));
      });
    };
    new ResizeObserver(reportBounds).observe(box);
    window.addEventListener('resize', reportBounds);

    // م-1-د: تذكّر آخر عنوان **لكل مجلد مشروع** (لا عنواناً عاماً واحداً) — لكل مشروع
    // منفذه، فالنقر على 🌐 يعيد عنوان المشروع الحالي لا آخر ما فُتح في أي مكان. المفتاح
    // يقرأ #cwd من الشريط العلوي (light DOM — نمط terminal-panel). fallback للمفتاح العام
    // القديم للتوافق مع ما حُفظ في م-1-ج.
    const savedKey = () => {
      const cwd = (document.getElementById('cwd') && document.getElementById('cwd').value || '').trim();
      return cwd ? 'satr_preview_url::' + cwd : 'satr_preview_url';
    };
    // كل مجلد مشروع مستقل — لا fallback عام (يسبّب تلوّثاً: مشروع جديد يرث عنوان آخر).
    // مشروع بلا عنوان محفوظ ⇒ شاشة hint حتى يُفتح عنوانه أول مرة.
    const loadSavedUrl = () => localStorage.getItem(savedKey()) || '';

    // ---------- الفتح/الإغلاق ----------
    // م-1-ج/د: النقر على 🌐 يفتح **آخر عنوان لهذا المشروع مباشرة** (طلب المالك). إن توقّف
    // الخادم (استئناف جلسة قديمة مثلاً) يظهر تنبيه واضح والحقل يبقى قابلاً لإعادة المحاولة.
    const openPanel = (autoLast = true) => {
      this.setAttribute('open', '');
      if (toggleBtn) toggleBtn.classList.add('active');
      if (!started && autoLast) {
        const last = loadSavedUrl();
        if (last) { urlIn.value = last; go(last); }
        else urlIn.focus();
      } else if (!started) urlIn.focus();
      reportBounds();
    };
    const closePanel = () => {
      this.removeAttribute('open');
      if (toggleBtn) toggleBtn.classList.remove('active');
      started = false;
      hint.style.display = '';
      err.classList.remove('show');
      window.satr.previewClose(); // يدمّر العرض الأصلي (الكوكيز تبقى في partition الدائمة)
    };
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      if (this.hasAttribute('open')) closePanel(); else openPanel();
    });
    $('pvClose').addEventListener('click', closePanel);

    // ---------- التنقل ----------
    // تطبيع العنوان: بلا مخطط ⇐ http:// (خوادم التطوير المحلية)؛ غير http/https يُرفض
    const normalize = (raw) => {
      let u = String(raw || '').trim();
      if (!u) return null;
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) u = 'http://' + u;
      try {
        const p = new URL(u);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
        return u;
      } catch (e) { return null; }
    };
    const go = async (raw) => {
      const u = normalize(raw);
      if (!u) { showErr('عنوان غير صالح — http/https فقط'); return; }
      err.classList.remove('show');
      // loadURL يعود ok فور بدء التحميل؛ فشل خادم متوقف يصل لاحقاً عبر حدث failed
      const r = started ? await window.satr.previewNavigate(u) : await window.satr.previewOpen(u);
      if (r && r.ok) {
        started = true;
        hint.style.display = 'none';
        urlIn.value = u;
        // م-1-د: تذكّر لكل مجلد مشروع + مفتاح عام (توافق/احتياط بلا cwd)
        localStorage.setItem(savedKey(), u);
        localStorage.setItem('satr_preview_url', u);
        reportBounds(); // العرض أُنشئ الآن — أبلغه مستطيله فوراً
      } else showErr('تعذّر فتح العنوان' + (r && r.error ? ' (' + r.error + ')' : ''));
    };
    urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(urlIn.value); });
    backBtn.addEventListener('click', () => window.satr.previewAction('back'));
    fwdBtn.addEventListener('click', () => window.satr.previewAction('forward'));
    reloadBtn.addEventListener('click', () => {
      if (started) window.satr.previewAction('reload'); else go(urlIn.value);
    });

    function showErr(text) { err.textContent = '⚠ ' + text; err.classList.add('show'); }

    // ---------- أحداث العرض الأصلي ----------
    window.satr.onPreview((ev) => {
      if (!ev) return;
      if (ev.type === 'nav') {
        // لا نكتب فوق ما يكتبه المستخدم الآن
        if (root.activeElement !== urlIn && ev.url) urlIn.value = ev.url;
        backBtn.disabled = !ev.canGoBack;
        fwdBtn.disabled = !ev.canGoForward;
        err.classList.remove('show');
      } else if (ev.type === 'loading') {
        reloadBtn.classList.toggle('loading', !!ev.loading);
      } else if (ev.type === 'failed') {
        // م-1-د: فشل الوصول غالباً = الخادم غير قائم (استئناف جلسة قديمة، أو لم يُشغَّل
        // بعد). رسالة واضحة توجّه المستخدم لتشغيله بدل رمز خطأ غامض — العرض يبقى حيّاً
        // (يُظهر صفحة خطأ المتصفح) و⟳ يعيد المحاولة عليه مباشرة.
        showErr('تعذّر الوصول إلى ' + (ev.url || 'العنوان') +
          ' — تأكد أن خادم التطوير يعمل (اطلب من الوكيل «شغّل المشروع») ثم اضغط ⟳.');
      }
      // ev.type === 'title' متاح مستقبلاً (لا مكان لعرضه في رأس م-1 المضغوط)
    });

    // ---------- مقبض تغيير العرض (نمط مقبض ارتفاع الطرفية) ----------
    const resizer = $('pvResizer');
    let drag = null;
    resizer.addEventListener('pointerdown', (e) => {
      drag = { startX: e.clientX, startW: this.getBoundingClientRect().width };
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    resizer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // اللوحة في الجهة اليسرى (RTL): السحب يميناً يوسّعها
      const w = Math.max(280, Math.min(window.innerWidth * 0.78, drag.startW + (e.clientX - drag.startX)));
      this.style.setProperty('--pv-w', Math.round(w) + 'px');
    });
    resizer.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      localStorage.setItem('satr_preview_w', String(Math.round(this.getBoundingClientRect().width)));
    });

    // ---------- العقد العام ----------
    // فتح بعنوان جاهز (اقتراح localhost المرصود / أداة open_preview — القشرة تستدعيها).
    // autoLast=false: العنوان القادم أدقّ من المحفوظ فلا نفتح الأخير أولاً (تفادي سباق).
    this.openWith = (url) => { openPanel(false); go(url); };
    // م-1-ج: تحديث تلقائي — القشرة تستدعيها عند اكتمال دور عدّل ملفات والمعاينة مفتوحة.
    // reload فعلي فقط إن كان الوضع مُفعّلاً والعرض حيّاً (خارج ذلك تجاهل صامت آمن).
    this.reloadIfLive = () => {
      if (autoReload && started && this.hasAttribute('open')) window.satr.previewAction('reload');
    };
  }
}

customElements.define('satr-preview-panel', SatrPreviewPanel);
