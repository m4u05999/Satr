// <satr-preview-panel> — لوحة المعاينة المدمجة (م-1 — الدفعة 5 «سطر يرى الويب»).
// المكوّن يرسم «إطار» اللوحة فقط (رأس بأزرار وعنوان + مساحة عرض فارغة) — الصفحة
// نفسها ترسمها WebContentsView أصلية في العملية الرئيسية **تطفو فوق** مساحة العرض:
// المكوّن يقيس مستطيل المساحة (getBoundingClientRect) ويبلّغه عبر satr:previewBounds
// (ResizeObserver + resize النافذة + remeasure صريح لتغيّر الموضع بعد انتقال التخطيط)،
// والأحداث تصله عبر onPreview (nav/title/loading/failed).
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
  :host([drawer-held]) { display: none; }
  .pv-head {
    display: flex; align-items: center; gap: var(--space-1h); padding: var(--space-2) var(--space-2h);
    background: var(--surface); border-bottom: 1px solid var(--border);
  }
  .pv-head button {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2h); font-size: 12.5px; cursor: pointer;
  }
  .pv-head button:hover { border-color: var(--gold); }
  .pv-head button:disabled { opacity: .45; cursor: default; border-color: var(--border); }
  #pvUrl {
    flex: 1; min-width: 0; direction: ltr; text-align: left; font-family: var(--mono);
    font-size: 12px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); outline: none;
  }
  #pvUrl:focus { border-color: var(--gold); }
  #pvReload.loading { color: var(--gold); border-color: var(--gold-border); }
  #pvAuto.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvPick.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvRec.rec { color: var(--on-danger); border-color: var(--red); background: var(--red); animation: pvRecPulse 1.4s infinite; }
  @keyframes pvRecPulse { 50% { opacity: .55; } }
  /* مؤشّر «الوكيل يقود المتصفح» (الخيار 2): شارة عابرة فوق الرأس (لا يغطّيها العرض الأصلي
     لأنه يطفو فوق pvBox فقط) + خيط علوي نابض. يظهران أثناء تنفيذ الوكيل فعلَ متصفح. */
  #pvAgentTag {
    position: absolute; top: 5px; inset-inline: 0; margin-inline: auto; width: max-content;
    max-width: 70%; z-index: var(--z-local); display: none; align-items: center; gap: var(--space-1h);
    background: var(--gold); color: var(--on-gold); border-radius: var(--radius-pill); padding: 3px var(--space-3);
    font-size: 11.5px; font-weight: 600; box-shadow: var(--shadow-pop);
    pointer-events: none; unicode-bidi: plaintext; white-space: nowrap;
  }
  #pvAgentTag.show { display: flex; animation: pop var(--dur) var(--ease); }
  #pvAgentLine {
    position: absolute; top: 0; inset-inline: 0; height: 3px; z-index: var(--z-local);
    background: var(--gold); display: none; pointer-events: none;
  }
  #pvAgentLine.show { display: block; animation: pvAgentPulse 1.2s var(--ease) infinite; }
  @keyframes pvAgentPulse { 50% { opacity: .28; } }
  /* مؤشّر دائم أن «وضع تحكّم المتصفح» مفعّل (الخيار A): شارة في الرأس + توهّج حافة اللوحة.
     الحالة تُقرأ من aria-pressed لزرّ الوضع في المحرّر (MutationObserver — بلا تعديل app.js). */
  #pvCtlBadge {
    display: none; align-items: center; gap: var(--space-1); flex: none; pointer-events: none;
    background: var(--gold-soft); color: var(--gold-strong); border: 1px solid var(--gold-border);
    border-radius: var(--radius-pill); padding: var(--space-1) var(--space-2h); font-size: 11.5px; font-weight: 600; white-space: nowrap;
  }
  :host(.ctl-mode) #pvCtlBadge { display: inline-flex; }
  :host(.ctl-mode) { border-inline-start-color: var(--gold); }
  /* معاينة متجاوبة (محاكاة الأجهزة): زرّ يدوّر بين كامل/موبايل/لوحي. حين يُختار جهاز
     يُعرَض المحتوى بعرضه موسّطاً في pvBox (الجوانب خلفية اللوحة) فتتفاعل media queries. */
  #pvDevice.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  /* لوحة Console/أخطاء للمستخدم (الخيار 2): لوحة سفلية تعرض رسائل console وأخطاء الشبكة
     حيّاً (بثّ من preview.js). أسفل pvBox فلا يغطّيها العرض الأصلي (يطفو فوق pvBox فقط). */
  #pvConsoleBtn.has-err { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
  #pvDevtools.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvNet.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvConsole { display: none; flex-direction: column; height: 170px; min-height: 0;
    background: var(--bg-deep); border-top: 1px solid var(--border); }
  #pvConsole.show { display: flex; }
  #pvConsole .pc-head { display: flex; align-items: center; gap: var(--space-1h); padding: var(--space-1h) var(--space-2h);
    background: var(--surface); border-bottom: 1px solid var(--border); }
  #pvConsole .pc-title { flex: 1; color: var(--text-dim); font-size: 12px; }
  #pvConsole .pc-head button { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
    border-radius: var(--radius-md); padding: 3px var(--space-2h); font-size: 11.5px; cursor: pointer; }
  #pvConsole .pc-head button:hover { border-color: var(--gold); color: var(--text); }
  #pcLog { flex: 1; overflow: auto; padding: 3px 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.6; }
  #pcLog .pc-line { padding: 1px var(--space-2h); white-space: pre-wrap; word-break: break-word;
    border-bottom: 1px solid var(--border-dim); unicode-bidi: plaintext; direction: ltr; text-align: left; }
  #pcLog .pc-line.error, #pcLog .pc-line.net { color: var(--red); }
  #pcLog .pc-line.warning { color: var(--gold-strong); }
  #pcLog .pc-line.log, #pcLog .pc-line.info, #pcLog .pc-line.verbose { color: var(--text-dim); }
  #pcLog .pc-line.netreq { color: var(--text-dim); }
  #pcLog .pc-line.netreq.bad { color: var(--red); }
  #pcLog .pc-src { color: var(--text-faint); }
  /* مرشّح فئة السجلّ (البند ب): إخفاء الفئة غير المختارة عبر صنف على الحاوية */
  #pcLog.only-console .pc-line[data-cat="net"] { display: none; }
  #pcLog.only-net .pc-line[data-cat="console"] { display: none; }
  .pc-filt { color: var(--text-faint) !important; }
  .pc-filt.on { color: var(--gold) !important; border-color: var(--gold-border) !important; }
  #pcLog .pc-empty { padding: var(--space-4); text-align: center; color: var(--text-faint); font-size: 12px; direction: rtl; }
  /* شريط التحديد بالتأشير (م-2): يظهر أسفل الرأس عند التقاط عنصر */
  #pvPickBar { display: none; flex-direction: column; gap: var(--space-1h); padding: var(--space-2) var(--space-2h);
    background: var(--surface); border-bottom: 1px solid var(--gold-border); }
  #pvPickBar.show { display: flex; }
  #pvPickBar .pb-el { display: flex; align-items: baseline; gap: var(--space-2); font-size: 12px; min-width: 0; }
  #pvPickBar .pb-tag { font-family: var(--mono); color: var(--gold); direction: ltr; flex: none; }
  #pvPickBar .pb-text { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; unicode-bidi: plaintext; }
  /* فحص محسّن (البند ج): بطاقة الأنماط/box-model — شرائح صغيرة LTR */
  #pvPickBar .pb-info { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-1h); direction: ltr; }
  #pvPickBar .pb-info:empty { display: none; }
  #pvPickBar .pb-chip { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim);
    background: var(--bg); border: 1px solid var(--border-dim); border-radius: var(--radius-sm); padding: 1px var(--space-1h);
    unicode-bidi: plaintext; display: inline-flex; align-items: center; gap: var(--space-1); }
  #pvPickBar .pb-chip b { color: var(--text-faint); font-weight: 400; }
  #pvPickBar .pb-sw { width: 11px; height: 11px; border-radius: var(--radius-xs); border: 1px solid var(--border-strong); flex: none; }
  #pvPickBar .pb-row { display: flex; gap: var(--space-1h); }
  #pvPickBar #pbInput { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); font-size: 13px; font-family: var(--sans);
    outline: none; unicode-bidi: plaintext; }
  #pvPickBar #pbInput:focus { border-color: var(--gold); }
  #pvPickBar #pbSend { background: var(--gold); color: var(--on-gold); border: none; font-weight: 600;
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-4); font-size: 12.5px; cursor: pointer; }
  #pvPickBar #pbCancel { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); cursor: pointer; }
  /* شريط التسليم البشري (browser_handoff): الوكيل سلّم القيادة — المستخدم يكمل بيده
     ثم يضغط «استلمت». يظهر تحت الرأس مباشرة (منطقة لا يغطّيها العرض الأصلي بعد إعادة
     القياس — فتحه يقلّص pvBox عبر التدفق الطبيعي فيبلَّغ المستطيل الجديد تلقائياً). */
  #pvHandoff { display: none; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-2h);
    background: var(--gold-soft); border-bottom: 1px solid var(--gold-border); }
  #pvHandoff.show { display: flex; animation: pop var(--dur) var(--ease); }
  #pvHandoff .ho-icon { flex: none; font-size: 16px; }
  #pvHandoff .ho-text { flex: 1; min-width: 0; font-size: 12.5px; color: var(--text); unicode-bidi: plaintext; }
  #pvHandoff .ho-text b { color: var(--gold-strong); }
  #pvHandoff #hoDone { background: var(--gold); color: var(--on-gold); border: none; font-weight: 600;
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-4); font-size: 12.5px; cursor: pointer; flex: none; }
  #pvHandoff #hoCancel { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); cursor: pointer; flex: none; }
  /* مساحة العرض: فارغة — WebContentsView الأصلية تُرسم فوقها بنفس المستطيل */
  #pvBox { flex: 1; position: relative; min-height: 0; }
  .pv-hint {
    position: absolute; inset: 0; display: flex; flex-direction: column; gap: var(--space-2);
    align-items: center; justify-content: center; color: var(--text-dim);
    font-size: 13px; text-align: center; padding: 20px;
  }
  .pv-hint .big { font-size: 26px; }
  #pvErr {
    display: none; align-items: center; gap: var(--space-2); flex-wrap: wrap;
    padding: var(--space-1h) var(--space-3); font-size: 12px; color: var(--red);
    background: var(--red-soft); border-top: 1px solid var(--red-border);
    unicode-bidi: plaintext;
  }
  #pvErr.show { display: flex; }
  #pvErrText { flex: 1; min-width: 220px; }
  #pvRestartServer { color: var(--text); background: var(--surface-2); border: 1px solid var(--red-border);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2h); cursor: pointer; }
  #pvRestartServer[hidden] { display: none; }
  /* مقبض تغيير العرض على الحافة الملاصقة للمحادثة (inline-start = يمين في RTL) */
  #pvResizer {
    position: absolute; top: 0; bottom: 0; inset-inline-start: -3px; width: 7px;
    cursor: ew-resize; z-index: var(--z-local);
  }
  #pvResizer:hover { background: var(--gold-soft); }
`);

const MARKUP = `
  <div id="pvResizer" title="اسحب لتغيير العرض"></div>
  <div id="pvAgentLine"></div>
  <div id="pvAgentTag"></div>
  <div class="pv-head">
    <button id="pvClose" type="button" title="إغلاق المعاينة">✕</button>
    <button id="pvBack" type="button" title="رجوع" disabled>→</button>
    <button id="pvFwd" type="button" title="تقدم" disabled>←</button>
    <button id="pvReload" type="button" title="تحديث">⟳</button>
    <button id="pvAuto" type="button" title="تحديث تلقائي بعد كل تعديل من الوكيل">🔄</button>
    <button id="pvPick" type="button" title="تحديد عنصر لتعديله (أشِر وانقر)">🎯</button>
    <button id="pvRec" type="button" title="تسجيل فيديو للتصفح (mp4)">⏺</button>
    <button id="pvDevice" type="button" title="محاكاة الأجهزة: كامل/موبايل/لوحي (لاختبار التصميم المتجاوب)">🖥️</button>
    <button id="pvConsoleBtn" type="button" title="لوحة Console والأخطاء (رسائل الصفحة وأخطاء الشبكة)">🐞</button>
    <button id="pvDevtools" type="button" title="أدوات المطوّر (DevTools) — فحص كامل للصفحة في نافذة منفصلة">🔧</button>
    <button id="pvNet" type="button" title="محاكاة سرعة الشبكة: عادي/بطيء/سريع/غير متصل">🚦</button>
    <button id="pvClearStore" type="button" title="مسح تخزين الصفحة (كوكيز + localStorage + cache) وإعادة التحميل">🧹</button>
    <span id="pvCtlBadge" title="وضع تحكّم المتصفح مفعّل — الوكيل يقود المعاينة">🖱️ تحكّم</span>
    <input id="pvUrl" type="text" placeholder="http://localhost:3000 …" spellcheck="false">
  </div>
  <!-- شريط التسليم البشري (browser_handoff): يظهر حين يسلّم الوكيل القيادة للمستخدم -->
  <div id="pvHandoff">
    <span class="ho-icon">🤝</span>
    <span class="ho-text"><b>الوكيل يسلّمك القيادة:</b> <span id="hoReason"></span></span>
    <button id="hoDone" type="button" title="أكملتُ المطلوب — أعد القيادة للوكيل">استلمت ✓</button>
    <button id="hoCancel" type="button" title="إلغاء التسليم (يُبلَّغ الوكيل أن الخطوة لم تكتمل)">إلغاء</button>
  </div>
  <div id="pvBox">
    <div class="pv-hint" id="pvHint">
      <span class="big">🌐</span>
      <span>أدخل عنوان مشروعك أعلاه — أو شغّل خادم التطوير في الطرفية
      و«سطر» سيقترح فتحه هنا تلقائياً.</span>
    </div>
  </div>
  <div id="pvErr"><span id="pvErrText"></span><button id="pvRestartServer" type="button" hidden>🔁 شغّل خادم المشروع</button></div>
  <!-- لوحة Console/أخطاء للمستخدم (الخيار 2): تُملأ حيّاً من أحداث preview.js -->
  <div id="pvConsole">
    <div class="pc-head">
      <span class="pc-title">Console والشبكة</span>
      <button id="pcFiltAll" class="pc-filt on" type="button" title="عرض الكل">الكل</button>
      <button id="pcFiltConsole" class="pc-filt" type="button" title="رسائل console والأخطاء فقط">Console</button>
      <button id="pcFiltNet" class="pc-filt" type="button" title="طلبات الشبكة فقط">الشبكة</button>
      <button id="pcClear" type="button" title="مسح السجلّ">مسح</button>
      <button id="pcClose" type="button" title="إغلاق اللوحة">✕</button>
    </div>
    <div id="pcLog"></div>
  </div>
  <!-- شريط التحديد بالتأشير (م-2): يظهر بعد التقاط عنصر — ملخّص + طلب التعديل -->
  <div id="pvPickBar">
    <div class="pb-el"><span class="pb-tag" id="pbTag"></span><span class="pb-text" id="pbText"></span></div>
    <div class="pb-info" id="pbInfo"></div>
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
    const errText = $('pvErrText'), restartServerBtn = $('pvRestartServer');
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
    const holdReasons = new Set(); // حجب مستقل للحوار وdrawer كي لا يفك أحدهما حجب الآخر
    let held = false;
    // معاينة متجاوبة: 0 = كامل عرض pvBox؛ رقم = عرض جهاز يُعرَض موسّطاً (تتفاعل media queries).
    const DEVICES = [
      { icon: '🖥️', label: 'كامل', w: 0 },
      { icon: '📱', label: 'موبايل', w: 390 },
      { icon: '📲', label: 'لوحي', w: 768 },
    ];
    let deviceIdx = 0;
    try { deviceIdx = Math.max(0, Math.min(DEVICES.length - 1, parseInt(localStorage.getItem('satr_preview_device') || '0', 10) || 0)); } catch (e) {}
    const reportBounds = () => {
      if (!this.hasAttribute('open') || !started || held) return;
      cancelAnimationFrame(boundsRaf);
      boundsRaf = requestAnimationFrame(() => {
        const r = box.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const dev = DEVICES[deviceIdx].w;
        let x = r.left, w = r.width;
        if (dev && dev < r.width) { x = r.left + Math.round((r.width - dev) / 2); w = dev; } // توسيط بعرض الجهاز
        window.satr.previewBounds(Math.round(x), Math.round(r.top), Math.round(w), Math.round(r.height));
      });
    };
    new ResizeObserver(reportBounds).observe(box);
    window.addEventListener('resize', reportBounds);
    this.remeasure = reportBounds;

    // زرّ محاكاة الأجهزة: يدوّر كامل→موبايل→لوحي، يحدّث الأيقونة/الحالة ويعيد قياس العرض.
    const deviceBtn = $('pvDevice');
    const paintDevice = () => {
      const d = DEVICES[deviceIdx];
      deviceBtn.textContent = d.icon;
      deviceBtn.classList.toggle('on', d.w > 0);
      deviceBtn.title = 'محاكاة الأجهزة: ' + d.label + (d.w ? ' (' + d.w + '‏px)' : '') + ' — انقر للتبديل';
    };
    paintDevice();
    deviceBtn.addEventListener('click', () => {
      deviceIdx = (deviceIdx + 1) % DEVICES.length;
      try { localStorage.setItem('satr_preview_device', String(deviceIdx)); } catch (e) {}
      paintDevice();
      reportBounds();
    });

    // ---------- لوحة Console/أخطاء للمستخدم (الخيار 2) ----------
    // تُملأ حيّاً من أحداث preview.js (console/neterr/console_clear عبر onPreview أدناه).
    // أسفل pvBox فلا يغطّيها العرض الأصلي؛ فتحها يصغّر pvBox فيُعاد قياس العرض.
    const consoleBtn = $('pvConsoleBtn'), consolePanel = $('pvConsole'), pcLog = $('pcLog');
    const PC_CAP = 500; // سقف أسطر DOM (إخلاء الأقدم)
    let pcErrBadge = 0; // عدّاد أخطاء غير مرئية — يُصفَّر عند فتح اللوحة/المسح/التنقّل
    const pcEmpty = () => {
      pcLog.textContent = '';
      const e = document.createElement('div');
      e.className = 'pc-empty';
      e.textContent = 'لا رسائل بعد — ستظهر رسائل console وأخطاء الصفحة هنا حيّاً.';
      pcLog.appendChild(e);
    };
    const pcPaintBadge = () => {
      consoleBtn.classList.toggle('has-err', pcErrBadge > 0);
      consoleBtn.textContent = pcErrBadge > 0 ? '🐞 ' + (pcErrBadge > 99 ? '99+' : pcErrBadge) : '🐞';
    };
    const pcClearLog = () => { pcErrBadge = 0; pcPaintBadge(); pcEmpty(); };
    // cat = 'console' | 'net' (فئة المرشّح)؛ cls = صنف اللون؛ isErr = يُحسب في العدّاد
    const pcAppend = (cls, text, srcText, cat, isErr) => {
      const empty = pcLog.querySelector('.pc-empty'); if (empty) empty.remove();
      const atBottom = pcLog.scrollHeight - pcLog.scrollTop - pcLog.clientHeight < 24;
      const line = document.createElement('div');
      line.className = 'pc-line ' + cls;
      line.dataset.cat = cat || 'console';
      line.textContent = text;
      if (srcText) { const s = document.createElement('span'); s.className = 'pc-src'; s.textContent = '  ' + srcText; line.appendChild(s); }
      pcLog.appendChild(line);
      while (pcLog.childElementCount > PC_CAP) pcLog.removeChild(pcLog.firstChild);
      if (atBottom) pcLog.scrollTop = pcLog.scrollHeight; // التصاق بالذيل إن كان القارئ عنده
      if (isErr && !consolePanel.classList.contains('show')) { pcErrBadge++; pcPaintBadge(); }
    };
    pcEmpty();
    consoleBtn.addEventListener('click', () => {
      const show = consolePanel.classList.toggle('show');
      if (show) { pcErrBadge = 0; pcPaintBadge(); }
      reportBounds();
    });
    $('pcClose').addEventListener('click', () => { consolePanel.classList.remove('show'); reportBounds(); });
    $('pcClear').addEventListener('click', pcClearLog);
    // مرشّح الفئة (البند ب): الكل / console / الشبكة — يضيف صنفاً على الحاوية (CSS يخفي الباقي)
    const filtBtns = { all: $('pcFiltAll'), console: $('pcFiltConsole'), net: $('pcFiltNet') };
    const setFilter = (mode) => {
      pcLog.classList.toggle('only-console', mode === 'console');
      pcLog.classList.toggle('only-net', mode === 'net');
      Object.keys(filtBtns).forEach((k) => filtBtns[k].classList.toggle('on', k === mode));
    };
    filtBtns.all.addEventListener('click', () => setFilter('all'));
    filtBtns.console.addEventListener('click', () => setFilter('console'));
    filtBtns.net.addEventListener('click', () => setFilter('net'));

    // ---------- DevTools حقيقية بزرّ (البند أ) ----------
    // نافذة DevTools منفصلة (mode:'detach' في preview.js) للعرض المعزول — تتجنّب قيد
    // الطفو فوق pvBox. الحالة الفعلية تصل عبر حدث devtools (يعكس إغلاق المستخدم للنافذة).
    const devtoolsBtn = $('pvDevtools');
    devtoolsBtn.addEventListener('click', () => {
      if (!started) { showErr('افتح المعاينة على مشروعك أولاً ثم افتح أدوات المطوّر.'); return; }
      window.satr.previewAction('devtools');
    });

    // ---------- محاكاة الشبكة + مسح التخزين (البند د) ----------
    // 🚦 يدوّر بين عادي/بطيء/سريع/غير متصل (previewAction بأسماء net_*). حدّ موثّق:
    // DevTools تحجز عميل debugger — إن فشلت المحاكاة (throttle_unavailable) نُظهر تنبيهاً.
    const netBtn = $('pvNet');
    const NET_MODES = [
      { key: 'net_online', icon: '🚦', label: 'عادي' },
      { key: 'net_slow', icon: '🐢', label: 'بطيء (~Slow 3G)' },
      { key: 'net_fast', icon: '🐇', label: 'سريع (~Fast 3G)' },
      { key: 'net_offline', icon: '✈️', label: 'غير متصل' },
    ];
    let netIdx = 0;
    netBtn.addEventListener('click', async () => {
      if (!started) { showErr('افتح المعاينة على مشروعك أولاً ثم غيّر سرعة الشبكة.'); return; }
      netIdx = (netIdx + 1) % NET_MODES.length;
      const m = NET_MODES[netIdx];
      const r = await window.satr.previewAction(m.key);
      if (r && r.error === 'throttle_unavailable') {
        netIdx = 0; // فشل — أعِد للوضع العادي بصرياً
        showErr('تعذّرت محاكاة الشبكة (أغلِق DevTools أولاً — تستعمل نفس القناة).');
      }
      netBtn.textContent = m.icon;
      netBtn.classList.toggle('on', netIdx !== 0);
      netBtn.title = 'محاكاة سرعة الشبكة: ' + NET_MODES[netIdx].label + ' — انقر للتبديل';
    });

    const clearStoreBtn = $('pvClearStore');
    clearStoreBtn.addEventListener('click', () => {
      if (!started) { showErr('افتح المعاينة على مشروعك أولاً ثم امسح التخزين.'); return; }
      if (!confirm('مسح كوكيز الصفحة وlocalStorage والـ cache ثم إعادة تحميلها؟')) return;
      window.satr.previewAction('clear_storage');
    });
    // تُستهلك في onPreview أدناه (نفس القناة satr:preview)
    this._pcConsole = (ev) => {
      if (ev.type === 'console') {
        const lvl = ev.levelLabel || 'log';
        pcAppend(lvl, '[' + lvl + '] ' + (ev.message || ''), ev.source ? (ev.source + ':' + ev.line) : '', 'console', lvl === 'error' || lvl === 'warning');
      } else if (ev.type === 'neterr') {
        pcAppend('net', '🌐 ' + (ev.error || 'network error') + ' → ' + (ev.url || ''), ev.resourceType || '', 'net', true);
      } else if (ev.type === 'netreq') {
        // البند ب: سجلّ الشبكة الكامل — كل طلب مكتمل (لون أحمر لرمز خطأ ≥400)
        const bad = ev.status >= 400 || ev.status === 0;
        pcAppend('netreq' + (bad ? ' bad' : ''), (ev.status || '—') + ' ' + (ev.method || 'GET') + ' ' + (ev.url || ''),
          (ev.resourceType || '') + (ev.fromCache ? ' · كاش' : ''), 'net', bad);
      } else if (ev.type === 'console_clear') pcClearLog();
    };

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
    this.close = closePanel;

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

    function showErr(text, showRestart) {
      errText.textContent = '⚠ ' + text;
      restartServerBtn.hidden = !showRestart;
      err.classList.add('show');
    }

    let restartRecord = null;
    let restoreInProgress = false;
    async function handleFailed(ev) {
      if (restoreInProgress) {
        showErr('الخادم يبدو قيد الإقلاع — جرّب ⟳');
        return;
      }
      const cwdEl = document.getElementById('cwd');
      const cwd = cwdEl ? cwdEl.value.trim() : '';
      let info = null;
      try { if (cwd) info = await window.satr.devServerInfo(cwd); } catch (e) {}
      if (info && info.running) {
        restartRecord = null;
        showErr('الخادم يبدو قيد الإقلاع — جرّب ⟳');
        return;
      }
      restartRecord = info && info.record ? { cwd, ...info.record } : null;
      showErr('تعذّر الوصول إلى ' + (ev.url || 'العنوان') +
        ' — تأكد أن خادم التطوير يعمل ثم اضغط ⟳.', !!restartRecord);
    }

    restartServerBtn.addEventListener('click', async () => {
      if (!restartRecord) return;
      const command = restartRecord.command;
      if (!confirm('سيشغّل «سطر» أمر الخادم المحفوظ لهذا المشروع:\n\n' + command + '\n\nهل تريد المتابعة؟')) return;
      restartServerBtn.disabled = true;
      const result = await window.satr.devServerRestart(restartRecord.cwd);
      restartServerBtn.disabled = false;
      if (!result || !result.ok) {
        showErr(result && result.error === 'already_running'
          ? 'الخادم يبدو قيد الإقلاع — جرّب ⟳'
          : 'تعذّر إعادة تشغيل خادم المشروع.');
        return;
      }
      restoreInProgress = true;
      showErr('يجري تشغيل خادم المشروع في تبويب 🛠 — ستُعاد المحاولة تلقائياً.');
      const target = result.last_url || restartRecord.last_url || loadSavedUrl() || urlIn.value;
      for (let attempt = 0; attempt < 4; attempt++) {
        setTimeout(() => {
          if (started && target) window.satr.previewNavigate(target);
          if (attempt === 3) restoreInProgress = false;
        }, attempt * 4000);
      }
    });

    // ---------- أحداث العرض الأصلي ----------
    window.satr.onPreview((ev) => {
      if (!ev) return;
      if (ev.type === 'nav') {
        // لا نكتب فوق ما يكتبه المستخدم الآن
        if (root.activeElement !== urlIn && ev.url) urlIn.value = ev.url;
        backBtn.disabled = !ev.canGoBack;
        fwdBtn.disabled = !ev.canGoForward;
        err.classList.remove('show');
        restoreInProgress = false;
      } else if (ev.type === 'loading') {
        reloadBtn.classList.toggle('loading', !!ev.loading);
      } else if (ev.type === 'failed') {
        // م-1-د: فشل الوصول غالباً = الخادم غير قائم (استئناف جلسة قديمة، أو لم يُشغَّل
        // بعد). رسالة واضحة توجّه المستخدم لتشغيله بدل رمز خطأ غامض — العرض يبقى حيّاً
        // (يُظهر صفحة خطأ المتصفح) و⟳ يعيد المحاولة عليه مباشرة.
        handleFailed(ev);
      } else if (ev.type === 'devtools') {
        devtoolsBtn.classList.toggle('on', !!ev.open); // البند أ: عكس فتح/إغلاق DevTools
      } else if (ev.type === 'agent_activity') {
        // نشاط محرك Codex على المتصفح (أدواته على خادم HTTP منفصل — لا تظهر كـ tool_use)
        this.flashAgentActivity(ev.tool);
      } else if (ev.type === 'console' || ev.type === 'neterr' || ev.type === 'netreq' || ev.type === 'console_clear') {
        this._pcConsole(ev); // لوحة Console/الشبكة للمستخدم (الخيار 2 + البند ب)
      }
      // ev.type === 'title' متاح مستقبلاً (لا مكان لعرضه في رأس م-1 المضغوط)
    });

    // ---------- التحديد بالتأشير (م-2) ----------
    // زر 🎯 يبدأ وضع التحديد: previewPick يعيد Promise يُحلّ عند نقر المستخدم على عنصر
    // في الصفحة (أو null عند الإلغاء/Escape). ثم يظهر شريط بملخّص العنصر وحقل طلب التعديل.
    const pickBtn = $('pvPick'), pickBar = $('pvPickBar');
    const pbTag = $('pbTag'), pbText = $('pbText'), pbInput = $('pbInput'), pbInfo = $('pbInfo');
    let picking = false;
    let picked = null; // العنصر الملتقط {selector, tag, html, text}

    const endPickMode = () => { picking = false; pickBtn.classList.remove('on'); };
    const closePickBar = () => { pickBar.classList.remove('show'); picked = null; pbInput.value = ''; pbInfo.textContent = ''; };

    // البند ج: يبني شرائح الأنماط/box-model في بطاقة الفحص (شرائح صغيرة LTR + عيّنات لون)
    const renderPickInfo = (p) => {
      pbInfo.textContent = '';
      const chip = (label, val, swatch) => {
        const c = document.createElement('span');
        c.className = 'pb-chip';
        if (swatch) { const sw = document.createElement('span'); sw.className = 'pb-sw'; sw.style.background = swatch; c.appendChild(sw); }
        const b = document.createElement('b'); b.textContent = label; c.appendChild(b);
        c.appendChild(document.createTextNode(' ' + val));
        pbInfo.appendChild(c);
      };
      const s = p.styles, box = p.box;
      if (s && s.cls) chip('class', '.' + s.cls.split(' ').join('.'));
      if (box) chip('size', box.w + '×' + box.h);
      if (s && s.display) chip('display', s.display + (s.position && s.position !== 'static' ? ' · ' + s.position : ''));
      if (s && s.color) chip('color', s.color, s.color);
      if (s && s.background && s.background !== 'rgba(0, 0, 0, 0)') chip('bg', s.background, s.background);
      if (s && s.font) chip('font', s.font);
      if (box) {
        const nz = (a) => a.some((v) => v > 0);
        if (nz(box.pad)) chip('padding', box.pad.join(' '));
        if (nz(box.mar)) chip('margin', box.mar.join(' '));
      }
    };

    const startPick = async () => {
      if (!started) { showErr('افتح المعاينة على مشروعك أولاً ثم استخدم التحديد.'); return; }
      if (picking) { window.satr.previewPickCancel(); endPickMode(); return; } // نقرة ثانية = إلغاء
      closePickBar();
      picking = true; pickBtn.classList.add('on');
      const r = await window.satr.previewPick();
      endPickMode();
      if (!r || !r.ok || !r.pick) return; // أُلغي أو فشل — بلا ضجيج
      picked = r.pick;
      pbTag.textContent = '<' + picked.tag + '>' + ((picked.styles && picked.styles.id) ? picked.styles.id : '');
      pbText.textContent = picked.text || '(بلا نص)';
      renderPickInfo(picked); // البند ج: بطاقة الأنماط/box-model
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
        detail: { instruction, url: urlIn.value, tag: picked.tag, selector: picked.selector, html: picked.html, text: picked.text, box: picked.box, styles: picked.styles },
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
    // canvas.captureStream(fps) ⇒ MediaRecorder ⇒ blob ⇒ تنزيل. ~8 إطارات/ث كافية
    // لتوثيق التصفح. الـ canvas مخفي داخل Shadow. الإيقاف يجمع القطع وينزّل الملف.
    // الحاوية: **mp4 مفضّلة** (H.264) إن دعمها المحرك (Chromium 130+ في Electron 33 يدعم
    // MediaRecorder بحاوية mp4 — تحقّق حيّ)، وإلا webm. صفر muxer/اعتماديات (MediaRecorder
    // يتولّى التغليف داخلياً؛ مسار WebCodecs غير متاح هنا — VideoEncoder غائب في هذا المحرك).
    // يعيد {mime, container, ext} حسب المدعوم — النوع والامتداد يتبعانه.
    const pickRecMime = () => {
      const cands = [
        { mime: 'video/mp4;codecs=avc1.42E01E', container: 'video/mp4', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1', container: 'video/mp4', ext: 'mp4' },
        { mime: 'video/mp4', container: 'video/mp4', ext: 'mp4' },
        { mime: 'video/webm;codecs=vp9', container: 'video/webm', ext: 'webm' },
        { mime: 'video/webm', container: 'video/webm', ext: 'webm' },
      ];
      const MR = window.MediaRecorder;
      for (const c of cands) if (MR && MR.isTypeSupported(c.mime)) return c;
      return { mime: '', container: 'video/webm', ext: 'webm' }; // افتراضي المحرك
    };
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
      const rec = pickRecMime(); // mp4 مفضّلة، وإلا webm
      try { mediaRec = rec.mime ? new MediaRecorder(stream, { mimeType: rec.mime }) : new MediaRecorder(stream); }
      catch (e) { showErr('التسجيل غير مدعوم في هذه البيئة.'); return; }
      recChunks = [];
      mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      mediaRec.onstop = () => {
        const blob = new Blob(recChunks, { type: rec.container });
        recChunks = []; recCanvas = null; recCtx = null;
        if (!blob.size) return;
        const a = document.createElement('a');
        const u = URL.createObjectURL(blob);
        a.href = u;
        a.download = 'satr-preview-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + rec.ext;
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
    const setHeld = (reason, hold) => {
      if (hold) holdReasons.add(reason); else holdReasons.delete(reason);
      held = holdReasons.size > 0;
      if (!started) return;
      if (held) window.satr.previewBounds(0, 0, 0, 0); // العرض بحجم صفر ⇒ مخفي، المربع يظهر
      else reportBounds(); // استعادة الموضع الفعلي بعد الرد
    };
    this.holdForDialog = (hold) => setHeld('dialog', hold);
    this.holdForDrawer = (hold) => {
      this.toggleAttribute('drawer-held', !!hold);
      setHeld('drawer', hold);
    };

    // ---------- مؤشّر «الوكيل يقود المتصفح» (الخيار 2) ----------
    // القشرة تستدعيها عند كل tool_use لأداة متصفح فتظهر شارة عابرة + خيط علوي نابض في
    // رأس اللوحة (المنطقة الوحيدة غير المغطّاة بالعرض الأصلي). غير أداة متصفح ⇒ تجاهل.
    const agentTag = $('pvAgentTag'), agentLine = $('pvAgentLine');
    const ACTION_LABELS = {
      open_preview: 'يفتح المعاينة', browser_navigate: 'يتصفّح', read_page: 'يقرأ الصفحة',
      browser_console: 'يفحص الأخطاء', browser_network: 'يفحص الشبكة', screenshot: 'يلتقط لقطة', browser_screenshot_element: 'يلتقط عنصراً',
      browser_snapshot: 'يفحص العناصر', browser_click: 'ينقر', browser_type: 'يكتب',
      browser_select_option: 'يختار', browser_press_key: 'يضغط مفتاحاً', browser_scroll: 'يمرّر',
      browser_hover: 'يحوّم', browser_wait_for: 'ينتظر', browser_handoff: 'يسلّمك القيادة',
    };
    // مؤشّر «وضع تحكّم المتصفح مفعّل» (الخيار A): يقرأ حالة زرّ الوضع في المحرّر
    // (#browserCtl، light DOM) من aria-pressed ويتابع تغيّره بـ MutationObserver —
    // تكامل بلا تعديل app.js (ملف يحرّره Codex الآن). تشغيل الوضع ⇒ شارة رأس + توهّج حافة.
    const ctlBtn = document.getElementById('browserCtl');
    const syncCtlMode = () => {
      this.classList.toggle('ctl-mode', !!(ctlBtn && ctlBtn.getAttribute('aria-pressed') === 'true'));
    };
    syncCtlMode();
    if (ctlBtn) new MutationObserver(syncCtlMode).observe(ctlBtn, { attributes: true, attributeFilter: ['aria-pressed'] });

    let agentTimer = 0;
    this.flashAgentActivity = (toolName) => {
      const bare = String(toolName || '').replace('mcp__satr-terminal__', '');
      const label = ACTION_LABELS[bare];
      if (!label) return; // ليست أداة متصفح — لا تُظهر شيئاً
      agentTag.textContent = '🤖 الوكيل ' + label + '…';
      agentTag.classList.add('show');
      agentLine.classList.add('show');
      clearTimeout(agentTimer);
      agentTimer = setTimeout(() => { agentTag.classList.remove('show'); agentLine.classList.remove('show'); }, 2500);
    };

    // ---------- شريط التسليم البشري (browser_handoff) ----------
    // القشرة تستدعي showHandoff عند حدث handoff_request وhideHandoff عند handoff_end
    // (أو نهاية الدور احتياطاً — يغطي حسم الإيقاف). الردّ boolean فقط عبر satr:handoffDone؛
    // المحرك (SDK/Codex) هو من ينهي التسليم فعلياً ويصفّر السجلات في العملية الرئيسية.
    const hoBar = $('pvHandoff'), hoReason = $('hoReason');
    let handoffId = null;
    const answerHandoff = (done) => {
      if (!handoffId) return;
      const id = handoffId;
      handoffId = null;
      hoBar.classList.remove('show');
      window.satr.handoffDone(id, done);
    };
    $('hoDone').addEventListener('click', () => answerHandoff(true));
    $('hoCancel').addEventListener('click', () => answerHandoff(false));
    this.showHandoff = (id, reason) => {
      openPanel(false); // التسليم يفترض معاينة مفتوحة — فتح اللوحة إن كانت مطوية كي يُرى الشريط
      handoffId = String(id || '');
      hoReason.textContent = String(reason || '');
      hoBar.classList.add('show');
      // القيادة بيد المستخدم — أخفِ مؤشر نشاط الوكيل إن كان ظاهراً
      agentTag.classList.remove('show'); agentLine.classList.remove('show');
    };
    this.hideHandoff = () => { handoffId = null; hoBar.classList.remove('show'); };
  }
}

customElements.define('satr-preview-panel', SatrPreviewPanel);
