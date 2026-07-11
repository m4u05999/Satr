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
  #pvPick.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvRec.rec { color: #fff; border-color: var(--red); background: var(--red); animation: pvRecPulse 1.4s infinite; }
  @keyframes pvRecPulse { 50% { opacity: .55; } }
  /* شريط التحديد بالتأشير (م-2): يظهر أسفل الرأس عند التقاط عنصر */
  #pvPickBar { display: none; flex-direction: column; gap: 6px; padding: 8px 10px;
    background: var(--surface); border-bottom: 1px solid var(--gold-border); }
  #pvPickBar.show { display: flex; }
  #pvPickBar .pb-el { display: flex; align-items: baseline; gap: 8px; font-size: 12px; min-width: 0; }
  #pvPickBar .pb-tag { font-family: var(--mono); color: var(--gold); direction: ltr; flex: none; }
  #pvPickBar .pb-text { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; unicode-bidi: plaintext; }
  #pvPickBar .pb-row { display: flex; gap: 6px; }
  #pvPickBar #pbInput { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: var(--sans);
    outline: none; unicode-bidi: plaintext; }
  #pvPickBar #pbInput:focus { border-color: var(--gold); }
  #pvPickBar #pbSend { background: var(--gold); color: #1A1408; border: none; font-weight: 600;
    border-radius: 8px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
  #pvPickBar #pbCancel { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
    border-radius: 8px; padding: 6px 10px; cursor: pointer; }
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
    <button id="pvPick" type="button" title="تحديد عنصر لتعديله (أشِر وانقر)">🎯</button>
    <button id="pvRec" type="button" title="تسجيل فيديو للتصفح (webm)">⏺</button>
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
  <!-- شريط التحديد بالتأشير (م-2): يظهر بعد التقاط عنصر — ملخّص + طلب التعديل -->
  <div id="pvPickBar">
    <div class="pb-el"><span class="pb-tag" id="pbTag"></span><span class="pb-text" id="pbText"></span></div>
    <div class="pb-row">
      <input id="pbInput" type="text" placeholder="ماذا تريد أن يتغيّر في هذا العنصر؟ (مثال: اجعله أخضر)">
      <button id="pbSend" type="button" title="إرسال للوكيل">إرسال</button>
      <button id="pbCancel" type="button" title="إلغاء">✕</button>
    </div>
  </div>
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
    let held = false; // محجوب مؤقتاً أثناء مربع إذن (يبرز فوق العرض) — لا نبلّغ مستطيلاً
    const reportBounds = () => {
      if (!this.hasAttribute('open') || !started || held) return;
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
      // م-2: أنهِ أي تحديد جارٍ/شريط مفتوح (الدوال مهيّأة وقت الاستدعاء — تُعرَّف أدناه)
      if (picking) { window.satr.previewPickCancel(); endPickMode(); }
      closePickBar();
      if (recording) stopRec(); // م-5: أوقِف التسجيل وأنزِل ما سُجّل قبل إغلاق العرض
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

    // ---------- التحديد بالتأشير (م-2) ----------
    // زر 🎯 يبدأ وضع التحديد: previewPick يعيد Promise يُحلّ عند نقر المستخدم على عنصر
    // في الصفحة (أو null عند الإلغاء/Escape). ثم يظهر شريط بملخّص العنصر وحقل طلب التعديل.
    const pickBtn = $('pvPick'), pickBar = $('pvPickBar');
    const pbTag = $('pbTag'), pbText = $('pbText'), pbInput = $('pbInput');
    let picking = false;
    let picked = null; // العنصر الملتقط {selector, tag, html, text}

    const endPickMode = () => { picking = false; pickBtn.classList.remove('on'); };
    const closePickBar = () => { pickBar.classList.remove('show'); picked = null; pbInput.value = ''; };

    const startPick = async () => {
      if (!started) { showErr('افتح المعاينة على مشروعك أولاً ثم استخدم التحديد.'); return; }
      if (picking) { window.satr.previewPickCancel(); endPickMode(); return; } // نقرة ثانية = إلغاء
      closePickBar();
      picking = true; pickBtn.classList.add('on');
      const r = await window.satr.previewPick();
      endPickMode();
      if (!r || !r.ok || !r.pick) return; // أُلغي أو فشل — بلا ضجيج
      picked = r.pick;
      pbTag.textContent = '<' + picked.tag + '>';
      pbText.textContent = picked.text || '(بلا نص)';
      pickBar.classList.add('show');
      pbInput.focus();
    };
    pickBtn.addEventListener('click', startPick);
    $('pbCancel').addEventListener('click', closePickBar);

    const submitPick = () => {
      const instruction = pbInput.value.trim();
      if (!instruction || !picked) return;
      // يُرسل للقشرة سياق العنصر + الطلب — القشرة تركّبه وترسله كدور محادثة عادي
      this.dispatchEvent(new CustomEvent('preview-edit', {
        bubbles: true,
        detail: { instruction, url: urlIn.value, tag: picked.tag, selector: picked.selector, html: picked.html, text: picked.text },
      }));
      closePickBar();
    };
    $('pbSend').addEventListener('click', submitPick);
    pbInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPick();
      else if (e.key === 'Escape') closePickBar();
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

    // ---------- تسجيل فيديو التصفح (م-5) ----------
    // صفر اعتماديات: previewFrame (لقطة PNG من العرض) ⇒ رسم على <canvas> ⇒
    // canvas.captureStream(fps) ⇒ MediaRecorder ⇒ webm blob ⇒ تنزيل. ~8 إطارات/ث كافية
    // لتوثيق التصفح. الـ canvas مخفي داخل Shadow. الإيقاف يجمع القطع وينزّل الملف.
    const recBtn = $('pvRec');
    let recording = false, mediaRec = null, recChunks = [], recTimer = 0, recCanvas = null, recCtx = null;

    const stopRec = () => {
      recording = false;
      if (recTimer) { clearTimeout(recTimer); recTimer = 0; }
      recBtn.classList.remove('rec');
      recBtn.textContent = '⏺';
      try { if (mediaRec && mediaRec.state !== 'inactive') mediaRec.stop(); } catch (e) {}
    };

    const drawFrame = (r) => {
      if (!recCanvas) return;
      if (recCanvas.width !== r.width || recCanvas.height !== r.height) {
        recCanvas.width = r.width; recCanvas.height = r.height;
      }
      const img = new Image();
      img.onload = () => { try { recCtx.drawImage(img, 0, 0, recCanvas.width, recCanvas.height); } catch (e) {} };
      img.src = 'data:image/png;base64,' + r.base64;
    };

    const tick = async () => {
      if (!recording) return;
      try { const r = await window.satr.previewFrame(); if (r && r.ok) drawFrame(r); } catch (e) {}
      if (recording) recTimer = setTimeout(tick, 125); // ~8fps
    };

    const startRec = async () => {
      if (!started) { showErr('افتح المعاينة على مشروعك أولاً ثم ابدأ التسجيل.'); return; }
      // إطار أول متزامن ليُضبط حجم الـ canvas قبل بدء MediaRecorder
      const first = await window.satr.previewFrame();
      if (!first || !first.ok) { showErr('تعذّر بدء التسجيل (لا إطار من المعاينة).'); return; }
      recCanvas = document.createElement('canvas');
      recCanvas.width = first.width; recCanvas.height = first.height;
      recCtx = recCanvas.getContext('2d');
      drawFrame(first);
      let stream;
      try { stream = recCanvas.captureStream(8); } catch (e) { showErr('التسجيل غير مدعوم في هذه البيئة.'); return; }
      const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) ? 'video/webm;codecs=vp9' : 'video/webm';
      try { mediaRec = new MediaRecorder(stream, { mimeType: mime }); }
      catch (e) { showErr('التسجيل غير مدعوم في هذه البيئة.'); return; }
      recChunks = [];
      mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      mediaRec.onstop = () => {
        const blob = new Blob(recChunks, { type: 'video/webm' });
        recChunks = []; recCanvas = null; recCtx = null;
        if (!blob.size) return;
        const a = document.createElement('a');
        const u = URL.createObjectURL(blob);
        a.href = u;
        a.download = 'satr-preview-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.webm';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 10000);
      };
      mediaRec.start();
      recording = true;
      recBtn.classList.add('rec');
      recBtn.textContent = '⏹';
      tick();
    };
    recBtn.addEventListener('click', () => { if (recording) stopRec(); else startRec(); });

    // ---------- العقد العام ----------
    // فتح بعنوان جاهز (اقتراح localhost المرصود / أداة open_preview — القشرة تستدعيها).
    // autoLast=false: العنوان القادم أدقّ من المحفوظ فلا نفتح الأخير أولاً (تفادي سباق).
    this.openWith = (url) => { openPanel(false); go(url); };
    // م-1-ج: تحديث تلقائي — القشرة تستدعيها عند اكتمال دور عدّل ملفات والمعاينة مفتوحة.
    // reload فعلي فقط إن كان الوضع مُفعّلاً والعرض حيّاً (خارج ذلك تجاهل صامت آمن).
    this.reloadIfLive = () => {
      if (autoReload && started && this.hasAttribute('open')) window.satr.previewAction('reload');
    };
    // إصلاح احتجاب مربع الإذن خلف المعاينة (لقطة مالك): القشرة تستدعيها عند ظهور/إخفاء
    // مربع إذن — نُخفي العرض الأصلي (bounds صفر) فيبرز المربع فوق اللوحة، ثم نعيده.
    this.holdForDialog = (hold) => {
      held = !!hold;
      if (!started) return;
      if (held) window.satr.previewBounds(0, 0, 0, 0); // العرض بحجم صفر ⇒ مخفي، المربع يظهر
      else reportBounds(); // استعادة الموضع الفعلي بعد الرد
    };
  }
}

customElements.define('satr-preview-panel', SatrPreviewPanel);
