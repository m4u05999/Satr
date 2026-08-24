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
import { pickRecMime } from '../lib/media-recorder.js';

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
    position: relative;
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
  #pvMore.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvTools {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1h);
    padding: var(--space-1h) var(--space-2h);
    background: var(--surface-2); border-bottom: 1px solid var(--border-dim);
  }
  #pvTools button {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2h); font-size: 12px; cursor: pointer;
  }
  #pvTools button:hover { border-color: var(--gold); }
  #pvTools select {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2); font-size: 12px;
  }
  #pvReload.loading { color: var(--gold); border-color: var(--gold-border); }
  #pvAuto.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvPick.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvRec.rec { color: var(--on-danger); border-color: var(--red); background: var(--red); animation: pvRecPulse 1.4s infinite; }
  #pvRecAspect {
    direction: ltr; background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2); font-size: 11px;
  }
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
  /* شارة التنازع (control_conflict): تظهر في رأس اللوحة عندما يتداخل تفاعل المستخدم
     أو تغيّر الصفحة مع خطوة وكيل جارية. عابرة غير حاجبة، لا تسرق التركيز، والأحدث
     يجدد المؤقت. */
  #pvConflictBadge {
    position: absolute; top: calc(100% + var(--space-1)); inset-inline: 0; margin-inline: auto; width: max-content;
    max-width: 85%; z-index: var(--z-local); display: none; align-items: center; gap: var(--space-1h);
    background: var(--gold-soft); color: var(--gold-strong); border: 1px solid var(--gold-border);
    border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3);
    font-size: 11.5px; font-weight: 600; box-shadow: var(--shadow-pop);
    pointer-events: none; unicode-bidi: plaintext; white-space: nowrap;
  }
  #pvConflictBadge.show { display: flex; animation: pop var(--dur) var(--ease); }
  /* مؤشّر دائم أن «وضع تحكّم المتصفح» مفعّل (الخيار A): شارة في الرأس + توهّج حافة اللوحة.
     الحالة تُقرأ من aria-pressed لزرّ الوضع في المحرّر (MutationObserver — بلا تعديل app.js). */
  #pvCtlBadge {
    display: none; align-items: center; gap: var(--space-1); flex: none; pointer-events: none;
    background: var(--gold-soft); color: var(--gold-strong); border: 1px solid var(--gold-border);
    border-radius: var(--radius-pill); padding: var(--space-1) var(--space-2h); font-size: 11.5px; font-weight: 600; white-space: nowrap;
  }
  :host(.ctl-mode) #pvCtlBadge { display: inline-flex; }
  :host(.ctl-mode) { border-inline-start-color: var(--gold); }
  #pvServerState { display: inline-flex; align-items: center; gap: var(--space-1); flex: none; color: var(--text-faint); font-size: 11px; white-space: nowrap; }
  #pvServerState.running { color: var(--green); }
  #pvServerDot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  #pvServerRestart { padding: 2px var(--space-2); font-size: 10.5px; }
  #pvServerRestart[hidden] { display: none; }
  /* معاينة متجاوبة (محاكاة الأجهزة): زرّ يدوّر بين كامل/موبايل/لوحي. حين يُختار جهاز
     يُعرَض المحتوى بعرضه موسّطاً في pvBox (الجوانب خلفية اللوحة) فتتفاعل media queries. */
  #pvDevice.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  /* لوحة Console/أخطاء للمستخدم (الخيار 2): لوحة سفلية تعرض رسائل console وأخطاء الشبكة
     حيّاً (بثّ من preview.js). أسفل pvBox فلا يغطّيها العرض الأصلي (يطفو فوق pvBox فقط). */
  #pvConsoleBtn.has-err { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
  #pvDevtools.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvNet.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  /* درج السجلّ جزيرة داكنة في الوضعين (سطح سجلّات كسطوح الكود): في الفاتح تأتي
     القيم الداكنة من tokens المُنطقية على المضيف (كتلة base.css أعلاه)، وفي الداكن
     الاحتياط inherit فيرث tokens الثيمة نفسها (احتياط var(--x) هنا يصنع دورة). */
  #pvConsole { display: none; flex-direction: column; height: 170px; min-height: 0;
    background: var(--bg-deep); border-top: 1px solid var(--pv-console-border, var(--border));
    color-scheme: dark;
    --bg: var(--pv-console-bg, inherit);
    --surface: var(--pv-console-surface, inherit);
    --text: var(--pv-console-text, inherit);
    --text-dim: var(--pv-console-text-dim, inherit);
    --text-faint: var(--pv-console-text-faint, inherit);
    --border: var(--pv-console-border, inherit);
    --border-dim: var(--pv-console-border-dim, inherit);
    --red: var(--pv-console-red, inherit);
    --gold: var(--pv-console-gold, inherit);
    --gold-strong: var(--pv-console-gold-strong, inherit);
    --gold-soft: var(--pv-console-gold-soft, inherit);
    --gold-border: var(--pv-console-gold-border, inherit);
  }
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
  #pcLog .pc-fix { direction: rtl; margin-inline-start: var(--space-2); background: var(--gold-soft); color: var(--gold-strong);
    border: 1px solid var(--gold-border); border-radius: var(--radius-sm); padding: 1px var(--space-2); cursor: pointer; font-family: var(--sans); }
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
  #pvPickBar .pb-actions { display: flex; gap: var(--space-1h); flex-wrap: wrap; }
  #pvPickBar .pb-quick { background: var(--gold-soft); color: var(--gold-strong); border: 1px solid var(--gold-border);
    border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; font-size: 11.5px; }
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
  #pvSecret { display: none; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-2h);
    background: var(--gold-soft); border-bottom: 1px solid var(--gold-border); }
  #pvSecret.show { display: flex; animation: pop var(--dur) var(--ease); }
  #pvSecret .secret-text { flex: 1; min-width: 0; font-size: 12.5px; color: var(--text); unicode-bidi: plaintext; }
  #pvSecret .secret-text b { color: var(--gold-strong); }
  #pvSecret button { border-radius: var(--radius-md); padding: var(--space-1h) var(--space-3); cursor: pointer; flex: none; }
  #secretDone { background: var(--gold); color: var(--on-gold); border: none; font-weight: 600; }
  #secretCancel { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
  #pvTaskTrace { display: none; flex-direction: column; gap: var(--space-1); padding: var(--space-1h) var(--space-2h);
    background: var(--surface-2); border-bottom: 1px solid var(--border-dim); }
  #pvTaskTrace.show { display: flex; }
  .trace-head { display: flex; align-items: center; gap: var(--space-2); font-size: 11.5px; color: var(--text-dim); }
  #traceToggle {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-1h);
    background: none; border: none; color: inherit; font: inherit; cursor: pointer;
    padding: 0; text-align: start;
  }
  #traceToggle b { color: var(--text); flex: none; }
  .trace-chev { flex: none; transition: transform var(--dur) var(--ease); }
  #pvTaskTrace.collapsed .trace-chev { transform: rotate(-90deg); }
  #pvTaskTrace.collapsed #traceList { display: none; }
  .trace-last {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-faint);
  }
  #pvTaskTrace:not(.collapsed) .trace-last { display: none; }
  #traceStop { border: 1px solid var(--red-border); background: var(--red-soft); color: var(--red);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2); cursor: pointer; }
  #traceList { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 66px; overflow: auto; }
  #traceList li { display: flex; gap: var(--space-2); min-width: 0; font-size: 10.5px; color: var(--text-faint); }
  #traceList .trace-title { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #traceList .trace-action { flex: none; color: var(--gold-strong); }
  /* مساحة العرض: فارغة — WebContentsView الأصلية تُرسم فوقها بنفس المستطيل */
  #pvBox { flex: 1; position: relative; min-height: 0; }
  .pv-hint {
    position: absolute; inset: 0; display: flex; flex-direction: column; gap: var(--space-2);
    align-items: center; justify-content: center; color: var(--text-dim);
    font-size: 13px; text-align: center; padding: 20px;
  }
  .pv-hint .big { font-size: 26px; }
  /* قاعدة الصنف display:flex تغلب سمة hidden وحدها — بلا هذا السطر يظهر
     #pvHeldNote دائماً. */
  .pv-hint[hidden] { display: none; }
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
  /* ---------- طبقة الصوت (الدفعة 1 — «أشرح بصوتي») ----------
     صفّ أدوات الصوت تحت درج ⋯ مباشرةً. المؤشّر الحيّ قبل التسجيل أرخص ما يمنع
     تسجيلة كاملة بلا صوت: يتحرّك فيرى المستخدم أنه مسموع **قبل** أن يتكلّم دقيقة. */
  #pvAudioRow {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1h);
    padding: var(--space-1h) var(--space-2h);
    background: var(--surface-2); border-bottom: 1px solid var(--border-dim);
  }
  #pvAudioRow[hidden] { display: none; }
  #pvAudioRow button {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2h); font-size: 12px; cursor: pointer;
  }
  #pvAudioRow button:hover { border-color: var(--gold); }
  #pvAudioRow button:disabled, #pvAudioRow select:disabled { opacity: .45; cursor: default; }
  #pvAudioRow select {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1) var(--space-2); font-size: 11.5px;
    max-width: 180px;
  }
  #pvMic.on { color: var(--gold); border-color: var(--gold); background: var(--gold-soft); }
  #pvMicMeter {
    flex: none; width: 82px; height: 8px; border-radius: var(--radius-pill);
    background: var(--bg); border: 1px solid var(--border-dim); overflow: hidden; display: none;
  }
  #pvMicMeter.show { display: block; }
  #pvMicFill { display: block; height: 100%; width: 0%; background: var(--green); }
  #pvMicMeter.hot #pvMicFill { background: var(--gold); }
  #pvSysWrap { display: inline-flex; align-items: center; gap: var(--space-1); font-size: 11.5px;
    color: var(--text-dim); cursor: pointer; }
  #pvSysNote, #pvAudioNote { flex-basis: 100%; font-size: 11px; unicode-bidi: plaintext; }
  #pvSysNote { color: var(--gold-strong); }
  #pvAudioNote { color: var(--text-faint); }
  #pvSysNote[hidden], #pvAudioNote[hidden] { display: none; }
  /* شريط الموافقة: إذن صريح **لكل تسجيلة** بلا «موافقة دائمة». تسجيل الميكروفون فعل
     حسّاس، وجلسة نافذة «سطر» بلا معالج أذونات ⇒ Electron يمنحه صامتاً (مقيس في
     مسبار الدفعة 0)، فهذا الشريط هو البوابة الوحيدة فعلياً. */
  #pvRecConsent {
    display: none; flex-direction: column; gap: var(--space-1h);
    padding: var(--space-2) var(--space-2h);
    background: var(--gold-soft); border-bottom: 1px solid var(--gold-border);
  }
  #pvRecConsent.show { display: flex; animation: pop var(--dur) var(--ease); }
  #pvRecConsent .rc-title { font-size: 12.5px; font-weight: 600; color: var(--gold-strong); }
  #pvRecConsent .rc-body, #pvRecConsent .rc-warn { font-size: 12px; color: var(--text); unicode-bidi: plaintext; }
  #pvRecConsent .rc-warn[hidden] { display: none; }
  #pvRecConsent .rc-actions { display: flex; gap: var(--space-1h); }
  #rcStart { background: var(--gold); color: var(--on-gold); border: none; font-weight: 600;
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-4); font-size: 12.5px; cursor: pointer; }
  #rcCancel { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); cursor: pointer; }
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
    <span id="pvConflictBadge"></span>
    <button id="pvClose" type="button" title="إغلاق المعاينة">✕</button>
    <button id="pvBack" type="button" title="رجوع" disabled>→</button>
    <button id="pvFwd" type="button" title="تقدم" disabled>←</button>
    <button id="pvReload" type="button" title="تحديث">⟳</button>
    <button id="pvAuto" type="button" title="تحديث تلقائي بعد كل تعديل من الوكيل">🔄</button>
    <button id="pvPick" type="button" title="تحديد عنصر لتعديله (أشِر وانقر)">🎯</button>
    <button id="pvDevice" type="button" title="محاكاة الأجهزة: كامل/موبايل/لوحي (لاختبار التصميم المتجاوب)">🖥️</button>
    <button id="pvConsoleBtn" type="button" title="لوحة Console والأخطاء (رسائل الصفحة وأخطاء الشبكة)">🐞</button>
    <button id="pvMore" type="button" aria-expanded="false" title="أدوات إضافية: تسجيل، استوديو، أدوات المطوّر، الشبكة، التخزين">⋯</button>
    <span id="pvServerState"><span id="pvServerDot"></span><span id="pvServerText">حالة الخادم</span><button id="pvServerRestart" type="button" hidden>تشغيل</button></span>
    <span id="pvCtlBadge" title="وضع تحكّم المتصفح مفعّل — الوكيل يقود المعاينة">🖱️ تحكّم</span>
    <input id="pvUrl" type="text" placeholder="http://localhost:3000 …" spellcheck="false">
  </div>
  <!-- درج الأدوات المتخصصة: صف في التدفق لا منبثق — WebContentsView تطفو فوق كل
       DOM، فقائمة مطلقة فوق مساحة العرض تختفي خلفها (الدرس نفسه من مربع الإذن). -->
  <div id="pvTools" hidden>
    <button id="pvRec" type="button" title="تسجيل فيديو للتصفح (mp4)">⏺ تسجيل</button>
    <select id="pvRecAspect" title="نسبة فيديو البرومو">
      <option value="16:9">16:9</option>
      <option value="9:16">9:16</option>
      <option value="1:1">1:1</option>
    </select>
    <button id="pvStudio" type="button" title="فتح استوديو البرومو">🎬 الاستوديو</button>
    <button id="pvDevtools" type="button" title="أدوات المطوّر (DevTools) — فحص كامل للصفحة في نافذة منفصلة">🔧 أدوات المطوّر</button>
    <button id="pvNet" type="button" title="محاكاة سرعة الشبكة: عادي/بطيء/سريع/غير متصل">🚦 الشبكة</button>
    <button id="pvClearStore" type="button" title="مسح تخزين الصفحة (كوكيز + localStorage + cache) وإعادة التحميل">🧹 مسح التخزين</button>
  </div>
  <!-- طبقة الصوت (الدفعة 1): الميكروفون يُسجَّل من اليوم الأول — صوتٌ لم يُسجَّل لا
       يمكن إضافته إلى لقطة ماضية. صوت النظام اختياري بتحذير، ومطفأ افتراضياً دائماً. -->
  <div id="pvAudioRow" hidden>
    <button id="pvMic" type="button" aria-pressed="false" title="سجّل شرحك بصوتك مع الفيديو">🎙 صوتي</button>
    <select id="pvMicDev" title="جهاز الإدخال" disabled></select>
    <span id="pvMicMeter" title="مستوى الصوت الوارد"><span id="pvMicFill"></span></span>
    <label id="pvSysWrap"><input id="pvSysAudio" type="checkbox"> صوت النظام</label>
    <span id="pvSysNote" hidden></span>
    <span id="pvAudioNote" hidden></span>
  </div>
  <!-- شريط الموافقة على تسجيل الصوت: يظهر قبل كل تسجيلة فيها صوت، ويُطوى بعدها -->
  <div id="pvRecConsent">
    <span class="rc-title">🎙 إذن تسجيل الصوت — لهذه التسجيلة وحدها</span>
    <span class="rc-body" id="rcBody"></span>
    <span class="rc-warn" id="rcWarn" hidden></span>
    <div class="rc-actions">
      <button id="rcStart" type="button">ابدأ التسجيل</button>
      <button id="rcCancel" type="button">إلغاء</button>
    </div>
  </div>
  <!-- شريط التسليم البشري (browser_handoff): يظهر حين يسلّم الوكيل القيادة للمستخدم -->
  <div id="pvHandoff">
    <span class="ho-icon">🤝</span>
    <span class="ho-text"><b id="hoPrefix">الوكيل يسلّمك القيادة:</b> <span id="hoReason"></span></span>
    <button id="hoDone" type="button" title="أكملتُ المطلوب — أعد القيادة للوكيل">استلمت ✓</button>
    <button id="hoCancel" type="button" title="إلغاء التسليم (يُبلَّغ الوكيل أن الخطوة لم تكتمل)">إلغاء</button>
  </div>
  <div id="pvSecret">
    <span>🔐</span>
    <span class="secret-text"><b>الوكيل يحتاج قيمة سرّية هنا:</b> <span id="secretReason"></span></span>
    <button id="secretDone" type="button">تم ✓</button>
    <button id="secretCancel" type="button">إلغاء</button>
  </div>
  <!-- أثر المهمة مطويّ افتراضياً: كان يقتطع نحو ٦٦px من ارتفاع المعاينة دائماً،
       وهي المساحة التي فُتحت اللوحة لأجلها. الرأس يعرض آخر خطوة، والفرد بالنقر. -->
  <div id="pvTaskTrace" class="collapsed">
    <div class="trace-head">
      <button id="traceToggle" type="button" aria-expanded="false" title="عرض خطوات المهمة">
        <span class="trace-chev" aria-hidden="true">⌄</span><b>أثر المهمة</b>
        <span id="traceLast" class="trace-last"></span>
      </button>
      <button id="traceStop" type="button">إيقاف المهمة</button>
    </div>
    <ol id="traceList"></ol>
  </div>
  <div id="pvBox">
    <div class="pv-hint" id="pvHint">
      <span class="big">🌐</span>
      <span>أدخل عنوان مشروعك أعلاه — أو شغّل خادم التطوير في الطرفية
      و«سطر» سيقترح فتحه هنا تلقائياً.</span>
    </div>
    <div class="pv-hint" id="pvHeldNote" hidden>
      <span class="big">👁️</span>
      <span>المعاينة مخفية مؤقتاً أثناء الحوار — تعود فور ردّك.</span>
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
    <div class="pb-actions">
      <button id="pbExplain" class="pb-quick" type="button">اشرح</button>
      <button id="pbFix" class="pb-quick" type="button">أصلح</button>
      <button id="pbImprove" class="pb-quick" type="button">حسّن</button>
    </div>
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
    const layoutSheet = sheet(':host {}');
    root.adoptedStyleSheets = [controlsSheet, previewSheet, layoutSheet];
    const wrap = document.createElement('div');
    // الغلاف يرث flex العمودي من :host عبر display:contents
    wrap.style.display = 'contents';
    wrap.innerHTML = MARKUP;
    root.appendChild(wrap);
    const $ = (id) => root.getElementById(id);
    const urlIn = $('pvUrl'), box = $('pvBox'), hint = $('pvHint'), err = $('pvErr');
    const heldNote = $('pvHeldNote'); // OBS-032: لافتة «مخفية مؤقتاً» مكان العرض المنحّى
    const errText = $('pvErrText'), restartServerBtn = $('pvRestartServer');
    const conflictBadge = $('pvConflictBadge');
    const backBtn = $('pvBack'), fwdBtn = $('pvFwd'), reloadBtn = $('pvReload'), autoBtn = $('pvAuto');
    const resizer = $('pvResizer');
    const toggleBtn = document.getElementById('previewToggle'); // زر الشريط العلوي (light DOM)

    resizer.tabIndex = 0;
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', 'تغيير عرض المعاينة؛ السهم الأيمن يوسّع والأيسر يضيّق');
    resizer.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End');

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

    // عرض المعاينة رقمي ومقيّد قبل دخوله ورقة النمط؛ لا تُنشأ سمة style أثناء السحب.
    const panelResizeBounds = () => {
      const minimum = 280;
      return { minimum, maximum: Math.max(minimum, window.innerWidth * 0.78) };
    };
    const updateResizeAccessibility = () => {
      const bounds = panelResizeBounds();
      const measured = this.getBoundingClientRect().width;
      const current = Math.min(bounds.maximum, Math.max(bounds.minimum, measured || bounds.minimum));
      resizer.setAttribute('aria-valuemin', String(Math.round(bounds.minimum)));
      resizer.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
      resizer.setAttribute('aria-valuenow', String(Math.round(current)));
      resizer.setAttribute('aria-valuetext', 'عرض المعاينة ' + Math.round(current) + ' بكسل');
    };
    const setPanelWidth = (value, persist) => {
      const width = Number(value);
      if (!Number.isFinite(width)) return;
      const bounds = panelResizeBounds();
      const clamped = Math.round(Math.min(bounds.maximum, Math.max(bounds.minimum, width)));
      layoutSheet.replaceSync(':host { --pv-w: ' + clamped + 'px; }');
      updateResizeAccessibility();
      if (persist !== false) localStorage.setItem('satr_preview_w', String(clamped));
    };
    const persistPanelWidth = () => {
      const bounds = panelResizeBounds();
      const measured = Math.min(bounds.maximum, Math.max(bounds.minimum, this.getBoundingClientRect().width));
      localStorage.setItem('satr_preview_w', String(Math.round(measured)));
      updateResizeAccessibility();
    };

    // عرض اللوحة المحفوظ (نمط ارتفاع الطرفية)
    const savedW = parseInt(localStorage.getItem('satr_preview_w') || '', 10);
    if (savedW && savedW >= 280) setPanelWidth(savedW, false);
    else updateResizeAccessibility();

    // ---------- إبلاغ مستطيل مساحة العرض للعملية الرئيسية ----------
    // WebContentsView تُرسم فوق pvBox — أي تغيير تخطيط (فتح الطرفية/تغيير حجم/سحب
    // المقبض) يغيّر المستطيل، وResizeObserver يلتقطه كله. إحداثيات CSS px = DIP.
    let boundsRaf = 0;
    let boundsWatch = 0;  // حلقة حارس المحاذاة الذاتي (rAF)
    let lastBoundsKey = ''; // آخر مستطيل أُرسل — لا نرسل IPC إلا عند تغيّر فعلي
    const holdReasons = new Set(); // حجب مستقل للحوار وdrawer كي لا يفك أحدهما حجب الآخر
    let held = false;
    // معاينة متجاوبة: 0 = كامل عرض pvBox؛ رقم = عرض جهاز يُعرَض موسّطاً (تتفاعل media queries).
    // mode يُبلَّغ للعملية الرئيسية مع المستطيل كي تشرح أداة browser_set_viewport سبب
    // تضييق العرض بدل تجاوز الطلب بصمت (OBS-028). قائمة مغلقة تطابق التنقية في main.js.
    const DEVICES = [
      { icon: '🖥️', label: 'كامل', w: 0, mode: null },
      { icon: '📱', label: 'موبايل', w: 390, mode: 'mobile' },
      { icon: '📲', label: 'لوحي', w: 768, mode: 'tablet' },
    ];
    let deviceIdx = 0;
    try { deviceIdx = Math.max(0, Math.min(DEVICES.length - 1, parseInt(localStorage.getItem('satr_preview_device') || '0', 10) || 0)); } catch (e) {}
    // يقيس مستطيل pvBox الفعلي (CSS px = DIP) موسّطاً بعرض الجهاز عند المحاكاة.
    const measureBounds = () => {
      if (!this.hasAttribute('open') || !started || held) return null;
      const r = box.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      const dev = DEVICES[deviceIdx].w;
      let x = r.left, w = r.width;
      let mode = null;
      // الوضع يُبلَّغ فقط حين يضيّق العرض فعلاً — «كامل» أو لوحة أضيق من الجهاز لا تجاوز فيهما
      if (dev && dev < r.width) { x = r.left + Math.round((r.width - dev) / 2); w = dev; mode = DEVICES[deviceIdx].mode; }
      return { x: Math.round(x), y: Math.round(r.top), w: Math.round(w), h: Math.round(r.height), mode };
    };
    // يرسل المستطيل للعملية الرئيسية عند **تغيّره فقط** (لا IPC مكرّر كل إطار).
    const sendBounds = () => {
      const b = measureBounds();
      if (!b) return;
      const key = b.x + ',' + b.y + ',' + b.w + ',' + b.h + ',' + (b.mode || '');
      if (key === lastBoundsKey) return;
      lastBoundsKey = key;
      window.satr.previewBounds(b.x, b.y, b.w, b.h, b.mode);
    };
    // حارس المحاذاة الذاتي: العرض الأصلي (WebContentsView) يطفو فوق pvBox، وResizeObserver
    // يرصد تغيّر **الحجم** فقط. لكن اللوحة قد تنزاح **أفقياً بلا تغيّر حجم** (فتح/إغلاق سطح
    // شقيق مثل غرفة العمليات أو الجوال، إعادة تدفّق العمود بـ container query، أو حجب/استعادة)
    // فيبقى العرض في مكانه القديم طافياً فوق المحادثة. حلقة rAF خفيفة تقارن المستطيل كل إطار
    // وترسل عند التغيّر فقط — getBoundingClientRect لعنصر واحد رخيص، وIPC محكوم بـ lastBoundsKey.
    // الحلقة تتوقّف ذاتياً عند إغلاق اللوحة فلا تدور بلا داعٍ.
    const watchBounds = () => {
      if (!this.hasAttribute('open')) { boundsWatch = 0; return; }
      sendBounds();
      boundsWatch = requestAnimationFrame(watchBounds);
    };
    const ensureWatch = () => { if (!boundsWatch && this.hasAttribute('open')) boundsWatch = requestAnimationFrame(watchBounds); };
    const reportBounds = () => {
      ensureWatch();
      cancelAnimationFrame(boundsRaf);
      boundsRaf = requestAnimationFrame(sendBounds);
    };
    new ResizeObserver(reportBounds).observe(box);
    window.addEventListener('resize', () => { reportBounds(); updateResizeAccessibility(); });
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
    let errorWatch = null;
    let errorWave = [];
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
    const pcAppend = (cls, text, srcText, cat, isErr, fixContext) => {
      const empty = pcLog.querySelector('.pc-empty'); if (empty) empty.remove();
      const atBottom = pcLog.scrollHeight - pcLog.scrollTop - pcLog.clientHeight < 24;
      const line = document.createElement('div');
      line.className = 'pc-line ' + cls;
      line.dataset.cat = cat || 'console';
      line.textContent = text;
      if (srcText) { const s = document.createElement('span'); s.className = 'pc-src'; s.textContent = '  ' + srcText; line.appendChild(s); }
      if (isErr && fixContext) {
        const fix = document.createElement('button'); fix.type = 'button'; fix.className = 'pc-fix'; fix.textContent = '🤖 أصلحه';
        fix.addEventListener('click', () => this.dispatchEvent(new CustomEvent('preview-fix', { bubbles: true, detail: fixContext })));
        line.appendChild(fix);
      }
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
      if (errorWatch) {
        const isConsoleError = ev.type === 'console' && (ev.levelLabel === 'error' || ev.levelLabel === 'warning');
        const isNetworkError = ev.type === 'neterr' || (ev.type === 'netreq' && (ev.status >= 400 || ev.status === 0));
        if (isConsoleError || isNetworkError) errorWave.push({ ...ev });
      }
      if (ev.type === 'console') {
        const lvl = ev.levelLabel || 'log';
        const isErr = lvl === 'error' || lvl === 'warning';
        pcAppend(lvl, '[' + lvl + '] ' + (ev.message || ''), ev.source ? (ev.source + ':' + ev.line) : '', 'console', isErr,
          isErr ? { kind: 'console', level: lvl, message: ev.message || '', source: ev.source || '', line: ev.line || 0, url: urlIn.value } : null);
      } else if (ev.type === 'neterr') {
        pcAppend('net', '🌐 ' + (ev.error || 'network error') + ' → ' + (ev.url || ''), ev.resourceType || '', 'net', true,
          { kind: 'network', error: ev.error || '', url: ev.url || '', resourceType: ev.resourceType || '', status: 0 });
      } else if (ev.type === 'netreq') {
        // البند ب: سجلّ الشبكة الكامل — كل طلب مكتمل (لون أحمر لرمز خطأ ≥400)
        const bad = ev.status >= 400 || ev.status === 0;
        pcAppend('netreq' + (bad ? ' bad' : ''), (ev.status || '—') + ' ' + (ev.method || 'GET') + ' ' + (ev.url || ''),
          (ev.resourceType || '') + (ev.fromCache ? ' · كاش' : ''), 'net', bad,
          bad ? { kind: 'network', method: ev.method || 'GET', url: ev.url || '', status: ev.status || 0, resourceType: ev.resourceType || '' } : null);
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
      updateResizeAccessibility();
      if (toggleBtn) toggleBtn.classList.add('active');
      if (!started && autoLast) {
        const last = loadSavedUrl();
        if (last) { urlIn.value = last; go(last); }
        else urlIn.focus();
      } else if (!started) urlIn.focus();
      reportBounds();
      if (this.refreshServerStatus) this.refreshServerStatus();
    };
    const closePanel = () => {
      this.removeAttribute('open');
      if (toggleBtn) toggleBtn.classList.remove('active');
      started = false;
      hint.style.display = '';
      heldNote.hidden = true; // لا عرض منحّى بعد الإغلاق ⇒ لا لافتة (OBS-032)
      err.classList.remove('show');
      // م-2: أنهِ أي تحديد جارٍ/شريط مفتوح (الدوال مهيّأة وقت الاستدعاء — تُعرَّف أدناه)
      if (picking) { window.satr.previewPickCancel(); endPickMode(); }
      closePickBar();
      if (recording) stopRec(); // م-5: أوقِف التسجيل وأنزِل ما سُجّل قبل إغلاق العرض
      // الميكروفون لا يبقى مفتوحاً بعد إغلاق اللوحة (خصوصية): يُطفأ مجراه وتُلغى موافقته.
      micOn = false; stopMic();
      micBtn.classList.remove('on'); micBtn.setAttribute('aria-pressed', 'false');
      consentOk = false; consentBar.classList.remove('show');
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
    const go = async (raw, source) => {
      const u = normalize(raw);
      if (!u) { showErr('عنوان غير صالح — http/https فقط'); return; }
      err.classList.remove('show');
      // loadURL يعود ok فور بدء التحميل؛ فشل خادم متوقف يصل لاحقاً عبر حدث failed
      const fromAgent = source === 'agent';
      const r = started
        ? await (fromAgent ? window.satr.previewNavigateAgent(u) : window.satr.previewNavigate(u))
        : await (fromAgent ? window.satr.previewOpenAgent(u) : window.satr.previewOpen(u));
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
    const serverState = $('pvServerState'), serverText = $('pvServerText'), serverRestart = $('pvServerRestart');
    this.refreshServerStatus = async () => {
      const cwdEl = document.getElementById('cwd');
      const cwd = cwdEl ? cwdEl.value.trim() : '';
      let info = null;
      try { if (cwd) info = await window.satr.devServerInfo(cwd); } catch (e) {}
      serverState.classList.toggle('running', !!(info && (info.running || info.integration_preview)));
      if (info && info.running) {
        serverText.textContent = 'الخادم يعمل'; serverRestart.hidden = true;
      } else if (info && info.record) {
        serverText.textContent = 'الخادم متوقف'; serverRestart.hidden = false;
        restartRecord = { cwd, ...info.record };
      } else if (info && info.integration_preview) {
        // البند 20: معاينة تكاملية مؤقتة حية (worktree) — لا خادم مشروع مسجّل.
        serverText.textContent = 'معاينة تكاملية مؤقتة تعمل'; serverRestart.hidden = true;
      } else {
        serverText.textContent = 'لا خادم مسجّل'; serverRestart.hidden = true;
      }
      return info;
    };
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
      this.refreshServerStatus();
    });
    serverRestart.addEventListener('click', () => restartServerBtn.click());
    setInterval(() => { if (this.hasAttribute('open')) this.refreshServerStatus(); }, 5000);

    // ---------- أثر مهمة الإعداد + إدخال السر بيد المستخدم ----------
    const traceBox = $('pvTaskTrace'), traceList = $('traceList');
    const traceEntries = [];
    let traceActive = false;
    let lastTitle = '';
    const upsertTrace = (url, action) => {
      if (!traceActive || !url) return;
      let entry = traceEntries.find((item) => item.url === url);
      if (!entry) {
        entry = { url, title: lastTitle || url, action: action || 'زار الصفحة' };
        traceEntries.push(entry);
        if (traceEntries.length > 8) traceEntries.shift();
      } else {
        if (lastTitle) entry.title = lastTitle;
        if (action) entry.action = action;
      }
      traceList.textContent = '';
      for (const item of traceEntries) {
        const li = document.createElement('li');
        const title = document.createElement('span'); title.className = 'trace-title'; title.textContent = item.title || item.url; title.title = item.url;
        const last = document.createElement('span'); last.className = 'trace-action'; last.textContent = item.action;
        li.appendChild(title); li.appendChild(last); traceList.appendChild(li);
      }
      traceBox.classList.toggle('show', traceEntries.length > 0);
      // ملخّص الرأس وهو مطويّ: آخر صفحة وآخر فعل عليها
      const latest = traceEntries[traceEntries.length - 1];
      $('traceLast').textContent = latest ? (latest.action + ' · ' + (latest.title || latest.url)) : '';
    };
    const recordTraceAction = (label) => {
      traceActive = true;
      upsertTrace(urlIn.value, label);
    };
    // درج الأدوات: فتحه/طيّه يغيّر ارتفاع الرأس فيلزم إعادة قياس مستطيل العرض
    $('pvMore').addEventListener('click', () => {
      const tools = $('pvTools');
      const open = tools.hidden;
      tools.hidden = !open;
      $('pvAudioRow').hidden = !open; // صفّ الصوت جزء من أدوات التسجيل — يظهر معها
      $('pvMore').classList.toggle('on', open);
      $('pvMore').setAttribute('aria-expanded', String(open));
      reportBounds();
    });
    $('traceToggle').addEventListener('click', () => {
      const collapsed = traceBox.classList.toggle('collapsed');
      $('traceToggle').setAttribute('aria-expanded', String(!collapsed));
      reportBounds(); // تغيّر ارتفاع الأثر يغيّر مستطيل العرض الأصلي
    });
    $('traceStop').addEventListener('click', async () => {
      try { await window.satr.stop(); } catch (e) {}
      this.dispatchEvent(new CustomEvent('preview-notice', { bubbles: true, detail: 'أُوقفت مهمة المتصفح بطلبك.' }));
    });
    this.resetTaskTrace = () => {
      traceActive = false; traceEntries.length = 0; lastTitle = '';
      traceList.textContent = ''; traceBox.classList.remove('show');
    };

    const secretBar = $('pvSecret'), secretReason = $('secretReason');
    let secretRequestId = null;
    const answerSecret = async (done) => {
      if (!secretRequestId) return;
      const id = secretRequestId;
      secretRequestId = null;
      secretBar.classList.remove('show');
      try { await window.satr.secretDone(id, done); } catch (e) {}
    };
    $('secretDone').addEventListener('click', () => answerSecret(true));
    $('secretCancel').addEventListener('click', () => answerSecret(false));
    const showSecretRequest = (id, reason) => {
      openPanel(false);
      secretRequestId = String(id || '');
      secretReason.textContent = String(reason || '');
      secretBar.classList.add('show');
    };
    const hideSecretRequest = () => { secretRequestId = null; secretBar.classList.remove('show'); };
    this.hideSecretRequest = hideSecretRequest;

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
        this.refreshServerStatus();
        upsertTrace(ev.url, 'زار الصفحة');
      } else if (ev.type === 'title') {
        lastTitle = String(ev.title || '').slice(0, 200);
        upsertTrace(urlIn.value, 'زار الصفحة');
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
      } else if (ev.type === 'control_conflict') {
        // تنازع القيادة: المستخدم تفاعل مع الصفحة أو تغيّرت قبل تنفيذ خطوة الوكيل
        this.flashConflict(ev.reason);
      } else if (ev.type === 'secret_request') {
        showSecretRequest(ev.id, ev.reason);
      } else if (ev.type === 'secret_end') {
        hideSecretRequest();
      } else if (ev.type === 'agent_screenshot') {
        this.dispatchEvent(new CustomEvent('agent-screenshot', { bubbles: true, detail: ev }));
      } else if (ev.type === 'preview_download_saved') {
        this.dispatchEvent(new CustomEvent('preview-notice', { bubbles: true, detail: '⬇ حُفظ تنزيل المعاينة في: ' + ev.path }));
      } else if (ev.type === 'preview_download_failed') {
        this.dispatchEvent(new CustomEvent('preview-notice', { bubbles: true, detail: 'تعذّر حفظ تنزيل المعاينة' + (ev.filename ? ': ' + ev.filename : '') }));
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

    const submitPick = async () => {
      const instruction = pbInput.value.trim();
      if (!instruction || !picked) return;
      let imageDataUrl = '';
      try {
        const shot = picked.selector ? await window.satr.previewElementShot(picked.selector) : null;
        if (shot && shot.ok && shot.base64) imageDataUrl = 'data:image/png;base64,' + shot.base64;
      } catch (e) {}
      // يُرسل للقشرة سياق العنصر + الطلب — القشرة تركّبه وترسله كدور محادثة عادي
      this.dispatchEvent(new CustomEvent('preview-edit', {
        bubbles: true,
        detail: { instruction, url: urlIn.value, tag: picked.tag, selector: picked.selector, html: picked.html, text: picked.text, box: picked.box, styles: picked.styles, imageDataUrl },
      }));
      closePickBar();
    };
    const quick = {
      pbExplain: 'اشرح وظيفة هذا العنصر وكيف يرتبط ببقية الواجهة، واذكر مصدره في المشروع.',
      pbFix: 'افحص هذا العنصر وأصلح الخلل الظاهر فيه مع التحقق من النتيجة في المعاينة.',
      pbImprove: 'حسّن تصميم هذا العنصر وتجربته وتجاوبه مع الحفاظ على أسلوب المشروع.',
    };
    Object.entries(quick).forEach(([id, instruction]) => {
      $(id).addEventListener('click', () => { pbInput.value = instruction; submitPick(); });
    });
    $('pbSend').addEventListener('click', submitPick);
    pbInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPick();
      else if (e.key === 'Escape') closePickBar();
    });

    // ---------- مقبض تغيير العرض (نمط مقبض ارتفاع الطرفية) ----------
    let drag = null;
    resizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { pointerId: e.pointerId, startX: e.clientX, startW: this.getBoundingClientRect().width };
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    resizer.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      // المقبض على الحافة اليمنى الفيزيائية: السحب يميناً يوسّع اللوحة.
      setPanelWidth(drag.startW + (e.clientX - drag.startX), false);
      e.preventDefault();
    });
    const endResize = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag = null;
      if (resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
      persistPanelWidth();
    };
    resizer.addEventListener('pointerup', endResize);
    resizer.addEventListener('pointercancel', endResize);
    resizer.addEventListener('keydown', (e) => {
      const bounds = panelResizeBounds();
      const current = this.getBoundingClientRect().width;
      const step = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-6')) || 1;
      let next = null;
      if (e.key === 'ArrowRight') next = current + step;
      else if (e.key === 'ArrowLeft') next = current - step;
      else if (e.key === 'Home') next = bounds.minimum;
      else if (e.key === 'End') next = bounds.maximum;
      if (next == null) return;
      e.preventDefault();
      setPanelWidth(next, true);
    });

    // ---------- تسجيل البرومو الأصلي (م-5) ----------
    // نافذة منتج مرئية مستقلة يختارها main عبر desktopCapturer؛ renderer وحده يطلب
    // getUserMedia للمصدر المحدد ويسجّل MediaStream الأصلي بـ30fps. لا capturePage ولا
    // canvas وسيط، لذلك يبقى المنتج ملء الإطار بلا واجهة «سطر» وبلا إسقاط إطارات اللقطات.
    const recBtn = $('pvRec'), recAspect = $('pvRecAspect');
    let recording = false, mediaRec = null, recChunks = [], recStream = null;
    let recSessionId = '', recStartedAt = 0, recFormat = null, recFinishing = false;

    // ---------- طبقة الصوت (الدفعة 1 — «أشرح بصوتي») ----------
    // ثلاثة قرارات مبنية على مسبار الدفعة 0 (probes/report-capture-audio.md) لا على الحدس:
    // (1) `pickRecMime()` المشتركة تعلن ترميز **فيديو وحده**، فالمسار الصوتي يُسلَّم
    //     للمسجّل ثم لا يُكتب: ملف صامت بلا خطأ ولا تحذير. هنا مرشّحات تعلن الصوت
    //     صراحةً، وإن لم يدعمها الجهاز **نرفض البدء** بدل إخراج صمتٍ يظنّه المستخدم شرحه.
    // (2) مساران صوتيان في مسجّل واحد ⇒ يُسقَط أحدهما **صامتاً** (طاقة الثاني قيست تحت
    //     أرضية الضجيج). لذلك الميكروفون وصوت النظام متعارضان هنا، والواجهة تصرّح بالحدّ.
    // (3) جلسة نافذة «سطر» بلا معالج أذونات ⇒ Electron يمنح الميكروفون صامتاً؛ فشريط
    //     الموافقة هو البوابة الوحيدة فعلياً، ويُسأل لكل تسجيلة بلا «موافقة دائمة».
    const AUDIO_REC_CANDIDATES = [
      { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', container: 'video/mp4', ext: 'mp4' },
      { mime: 'video/mp4;codecs=avc1,mp4a.40.2', container: 'video/mp4', ext: 'mp4' },
      { mime: 'video/webm;codecs=vp9,opus', container: 'video/webm', ext: 'webm' },
      { mime: 'video/webm;codecs=vp8,opus', container: 'video/webm', ext: 'webm' },
    ];
    // قيود خام: المعالجة الافتراضية (AEC/NS/AGC) تبتلع الإشارة — أُثبت في المسبار أن
    // النغمة تختفي معها. الشرح البشري لا يحتاجها، والخام يعطي أصدق تسجيل.
    const MIC_CONSTRAINTS = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      sampleRate: 48000, channelCount: 1,
    };
    // نصّ التحذير حرفياً من تقرير المسبار §7 (مبرَّر بقياس: صوت النظام يلتقط عملية
    // منفصلة تماماً بهامش ×1000 فوق أرضية الضجيج) — بلا علامات Markdown.
    const SYS_AUDIO_SHORT = '⚠️ يسجّل صوت الجهاز كله — الإشعارات والمكالمات وكل تطبيق مفتوح، '
      + 'لا نافذة المنتج وحدها.';
    const SYS_AUDIO_FULL = '⚠️ صوت النظام يسجّل كل ما يصدر عن جهازك — لا نافذة المنتج وحدها. '
      + 'ستُسجَّل الإشعارات والمكالمات والموسيقى وأي صوت من أي تطبيق مفتوح. هذا حدٌّ في ويندوز '
      + 'لا يمكن لـ«سطر» تجاوزه: لا يوفّر النظام التقاط صوت نافذة بعينها. '
      + 'قبل البدء: أغلق ما لا تريد سماعه، واكتم الإشعارات.';
    const MIC_SILENCE_PEAK = 0.01; // أرضية الصمت الخام المقيسة ‏0.0018 ذروةً — هامش ‏×5
    const MIC_SILENCE_MS = 6000;

    const micBtn = $('pvMic'), micDev = $('pvMicDev'), micMeter = $('pvMicMeter'), micFill = $('pvMicFill');
    const sysAudio = $('pvSysAudio'), sysNote = $('pvSysNote'), audioNote = $('pvAudioNote');
    const consentBar = $('pvRecConsent'), rcBody = $('rcBody'), rcWarn = $('rcWarn');
    let micStream = null, micCtx = null, micAnalyser = null, micBins = null, micRaf = 0;
    let micPeak = 0, micOn = false, consentOk = false, silenceWatch = 0;

    // اختيار الحاوية: بلا صوت ⇒ السلوك القائم حرفياً (pickRecMime المشتركة).
    const pickRecFormat = (wantsAudio) => {
      const Recorder = window.MediaRecorder;
      const supported = (mime) => !!Recorder && typeof Recorder.isTypeSupported === 'function'
        && Recorder.isTypeSupported(mime);
      if (wantsAudio) {
        for (const candidate of AUDIO_REC_CANDIDATES) {
          if (supported(candidate.mime)) return { ...candidate, audio: true };
        }
      }
      return { ...pickRecMime(), audio: false };
    };

    const setAudioNote = (text) => { audioNote.textContent = text || ''; audioNote.hidden = !text; };
    const paintSysNote = () => {
      sysNote.textContent = sysAudio.checked ? SYS_AUDIO_SHORT : '';
      sysNote.hidden = !sysAudio.checked;
    };

    const pumpMeter = () => {
      micRaf = 0;
      if (!micAnalyser || !micBins) return;
      micAnalyser.getFloatTimeDomainData(micBins);
      let sum = 0;
      for (let index = 0; index < micBins.length; index += 1) sum += micBins[index] * micBins[index];
      const level = Math.sqrt(sum / micBins.length);
      if (level > micPeak) micPeak = level;
      micFill.style.width = Math.min(100, Math.round(level * 320)) + '%';
      micMeter.classList.toggle('hot', level > 0.28);
      micRaf = requestAnimationFrame(pumpMeter);
    };

    const stopMic = () => {
      if (micRaf) { cancelAnimationFrame(micRaf); micRaf = 0; }
      if (micStream) for (const track of micStream.getTracks()) { try { track.stop(); } catch (e) {} }
      if (micCtx) { try { micCtx.close(); } catch (e) {} }
      micStream = null; micCtx = null; micAnalyser = null; micBins = null; micPeak = 0;
      micMeter.classList.remove('show', 'hot');
      micFill.style.width = '0%';
    };

    // أسماء الأجهزة لا تظهر قبل أول منح؛ لذلك تُملأ القائمة بعد فتح المجرى لا قبله.
    const listMicDevices = async (preferred) => {
      const media = navigator.mediaDevices;
      if (!media || typeof media.enumerateDevices !== 'function') return;
      let devices = [];
      try { devices = await media.enumerateDevices(); } catch (e) { return; }
      const inputs = (devices || []).filter((device) => device && device.kind === 'audioinput');
      micDev.textContent = '';
      for (const device of inputs) {
        const option = document.createElement('option');
        option.value = device.deviceId || '';
        option.textContent = device.label || 'ميكروفون';
        micDev.appendChild(option);
      }
      micDev.disabled = inputs.length < 2;
      if (preferred && inputs.some((device) => device.deviceId === preferred)) micDev.value = preferred;
    };

    const startMic = async (deviceId) => {
      stopMic();
      const audio = { ...MIC_CONSTRAINTS };
      if (deviceId) audio.deviceId = { exact: deviceId };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch (error) {
        showErr('تعذّر فتح الميكروفون — تأكد من توصيله ومن أن ويندوز يسمح لـ«سطر» باستخدامه.');
        return false;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) {
        for (const item of stream.getTracks()) { try { item.stop(); } catch (e) {} }
        showErr('لم يسلّم الجهاز مساراً صوتياً — جرّب جهاز إدخال آخر.');
        return false;
      }
      micStream = stream;
      // المؤشّر الحيّ تحسين لا شرط: فشله لا يمنع التسجيل، لكنه يفقد التحقّق المسبق.
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        micCtx = new Ctx();
        if (micCtx.state === 'suspended') await micCtx.resume();
        micAnalyser = micCtx.createAnalyser();
        micAnalyser.fftSize = 1024;
        micBins = new Float32Array(micAnalyser.fftSize);
        micCtx.createMediaStreamSource(stream).connect(micAnalyser);
        micMeter.classList.add('show');
        if (!micRaf) micRaf = requestAnimationFrame(pumpMeter);
      } catch (error) { micAnalyser = null; micBins = null; }
      let settingsId = '';
      try { settingsId = (track.getSettings && track.getSettings().deviceId) || ''; } catch (e) {}
      await listMicDevices(settingsId);
      return true;
    };

    const setMic = async (on) => {
      if (recording) return;
      if (on) {
        if (sysAudio.checked) { sysAudio.checked = false; paintSysNote(); }
        micOn = await startMic(micDev.value);
      } else { micOn = false; stopMic(); }
      micBtn.classList.toggle('on', micOn);
      micBtn.setAttribute('aria-pressed', micOn ? 'true' : 'false');
      if (!micOn) setAudioNote('');
    };

    micBtn.addEventListener('click', () => { setMic(!micOn); });
    micDev.addEventListener('change', () => { if (micOn) setMic(true); });
    sysAudio.addEventListener('change', async () => {
      if (recording) { sysAudio.checked = !sysAudio.checked; return; }
      if (sysAudio.checked && micOn) {
        await setMic(false);
        setAudioNote('لا يجتمع صوتك مع صوت النظام في ملف واحد — قياسٌ مثبَّت: المسجّل يُسقط '
          + 'أحد المسارين صامتاً. أُطفئ «صوتي».');
      } else setAudioNote('');
      paintSysNote();
    });

    const paintRecording = (active) => {
      recording = !!active;
      recBtn.classList.toggle('rec', recording);
      recBtn.textContent = recording ? '⏹' : '⏺';
      recAspect.disabled = recording;
      micBtn.disabled = recording;
      sysAudio.disabled = recording;
      micDev.disabled = recording || micDev.options.length < 2;
    };

    const clearRecording = () => {
      if (recStream) for (const track of recStream.getTracks()) { try { track.stop(); } catch (e) {} }
      if (silenceWatch) { clearTimeout(silenceWatch); silenceWatch = 0; }
      recStream = null; mediaRec = null; recChunks = []; recSessionId = ''; recFinishing = false;
      consentOk = false; // الموافقة لتسجيلة واحدة — التالية تسأل من جديد
      paintRecording(false);
    };

    const finishNativeCapture = () => {
      if (!mediaRec || recFinishing) return;
      recFinishing = true;
      try {
        if (mediaRec.state !== 'inactive') mediaRec.stop();
        else clearRecording();
      } catch (e) { clearRecording(); }
    };

    const beginNativeCapture = async (event) => {
      if (!event || recording || !event.source_id || !event.session_id) return;
      openPanel(false);
      if (event.url) urlIn.value = event.url;
      if (event.aspect) recAspect.value = event.aspect;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: {
            chromeMediaSource: 'desktop', chromeMediaSourceId: event.source_id,
            minWidth: event.width, maxWidth: event.width,
            minHeight: event.height, maxHeight: event.height,
            minFrameRate: 30, maxFrameRate: 30,
          } },
        });
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('no_video_track');
        // مسار صوتي **واحد** حتماً: الميكروفون أولاً (طلب المالك «أشرح بصوتي»)، وإلا
        // صوت النظام إن سلّمه main. مساران معاً يُسقطان أحدهما صامتاً (قياس مثبَّت).
        const systemTracks = stream.getAudioTracks();
        const micTrack = micOn && micStream ? micStream.getAudioTracks()[0] : null;
        const liveMic = micTrack && micTrack.readyState === 'live' ? micTrack : null;
        const audioTracks = liveMic ? [liveMic] : (systemTracks.length ? [systemTracks[0]] : []);
        const wantsAudio = audioTracks.length > 0;
        if (wantsAudio && !consentOk) throw new Error('consent_missing');
        const format = pickRecFormat(wantsAudio);
        // العطل الذي كان يفشل صامتاً: حاوية بلا ترميز صوت ⇒ المسار يُسلَّم ولا يُكتب.
        // نرفض البدء بدل إخراج ملف صامت يظنّ المستخدم أنه يحمل شرحه.
        if (wantsAudio && !format.audio) {
          for (const track of stream.getTracks()) { try { track.stop(); } catch (e) {} }
          clearRecording();
          await window.satr.promoCaptureReady(event.session_id, false, 'audio_codec_unavailable');
          showErr('لا يدعم هذا الجهاز ترميز صوتٍ مع الفيديو، ولن نُخرِج تسجيلاً صامتاً تظنّه '
            + 'يحمل شرحك. أطفئ «صوتي» و«صوت النظام» لتسجيل الصورة وحدها.');
          return;
        }
        const options = { videoBitsPerSecond: event.width >= 1920 || event.height >= 1920 ? 16000000 : 10000000 };
        if (format.mime) options.mimeType = format.mime;
        const recorder = new MediaRecorder(new MediaStream([videoTrack, ...audioTracks]), options);
        recChunks = [];
        recStream = stream;
        mediaRec = recorder;
        recFormat = format;
        recSessionId = event.session_id;
        recStartedAt = performance.now();
        recFinishing = false;
        recorder.ondataavailable = (chunk) => { if (chunk.data && chunk.data.size) recChunks.push(chunk.data); };
        recorder.onstop = async () => {
          const duration = Math.max(0, Math.round(performance.now() - recStartedAt));
          const blob = new Blob(recChunks, { type: recFormat.container });
          const sessionId = recSessionId;
          const filename = 'satr-promo-segment-' + sessionId + '-'
            + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + recFormat.ext;
          if (blob.size) {
            const committed = await window.satr.promoCaptureCommit(sessionId, duration, filename);
            if (committed && committed.ok) {
              const anchor = document.createElement('a');
              const blobUrl = URL.createObjectURL(blob);
              anchor.href = blobUrl; anchor.download = filename;
              document.body.appendChild(anchor); anchor.click(); anchor.remove();
              setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            } else {
              await window.satr.promoCaptureAbort(sessionId, 'commit_failed');
            }
          } else {
            await window.satr.promoCaptureAbort(sessionId, 'empty_recording');
          }
          clearRecording();
        };
        videoTrack.addEventListener('ended', finishNativeCapture, { once: true });
        recorder.start(1000);
        paintRecording(true);
        // شبكة أمان ثانية: الترميز صار يعلن الصوت، لكن ميكروفوناً مكتوماً أو جهازاً
        // خاطئاً ينتج تسجيلة صامتة أيضاً. المؤشّر يعمل أثناء التسجيل، فإن بقيت الذروة
        // عند أرضية الصمت بعد ثوانٍ نقولها فوراً بدل أن يكتشفها بعد دقيقة كاملة.
        if (liveMic && micAnalyser) {
          micPeak = 0;
          silenceWatch = setTimeout(() => {
            silenceWatch = 0;
            if (recording && micPeak < MIC_SILENCE_PEAK) {
              showErr('لا نرصد صوتاً من الميكروفون منذ بدء التسجيل — تحقّق من الجهاز المختار '
                + 'ومن أنه غير مكتوم، فالتسجيلة قد تخرج بلا شرحك.');
            }
          }, MIC_SILENCE_MS);
        }
        await window.satr.promoCaptureReady(event.session_id, true, '');
      } catch (error) {
        // fail-closed: تسجيل بصوت بلا موافقة صريحة لهذه التسجيلة لا يبدأ إطلاقاً.
        const noConsent = error && error.message === 'consent_missing';
        if (stream) for (const track of stream.getTracks()) { try { track.stop(); } catch (e) {} }
        clearRecording();
        await window.satr.promoCaptureReady(event.session_id, false, noConsent ? 'consent_missing' : 'media_failed');
        showErr(noConsent
          ? 'لم تُمنح موافقة تسجيل الصوت لهذه التسجيلة — اضغط ⏺ ثم «ابدأ التسجيل».'
          : 'تعذّر بدء التقاط نافذة المنتج.');
      }
    };

    const stopRec = () => {
      if (!recording) return;
      window.satr.promoCaptureStop().catch(() => {});
    };

    // إرسال الطلب إلى main. المعامل الرابع توسعة اختيارية: إصدار preload الذي لا يعرفه
    // يتجاهله فيبقى السلوك القائم حرفياً (ولا يُفتح صوت النظام إلا بعد وصله فعلاً).
    const requestCapture = async () => {
      const result = await window.satr.promoCaptureStart(recAspect.value, normalize(urlIn.value), true,
        { system: !!sysAudio.checked });
      if (!result || !result.ok) {
        consentOk = false;
        showErr(result && result.error === 'busy' ? 'يوجد تسجيل برومو جارٍ بالفعل.' : 'تعذّر فتح نافذة التقاط المنتج.');
      }
    };

    const hideConsent = () => { consentBar.classList.remove('show'); reportBounds(); };
    $('rcCancel').addEventListener('click', () => { consentOk = false; hideConsent(); });
    $('rcStart').addEventListener('click', async () => {
      consentOk = true;
      hideConsent();
      await requestCapture();
    });

    const startRec = async () => {
      if (!started || !normalize(urlIn.value)) { showErr('افتح المعاينة على مشروعك أولاً ثم ابدأ التسجيل.'); return; }
      consentOk = false;
      if (!micOn && !sysAudio.checked) { await requestCapture(); return; }
      // إذن صريح لكل تسجيلة: يذكر ما سيُسجَّل بالضبط، وبأي جهاز، وتحذير النظام كاملاً.
      const device = micOn && micDev.selectedOptions[0] ? micDev.selectedOptions[0].textContent : '';
      rcBody.textContent = micOn
        ? ('سيُسجَّل صوتك من الميكروفون' + (device ? ' («' + device + '»)' : '') + ' مع صورة نافذة المنتج.')
        : 'سيُسجَّل صوت النظام مع صورة نافذة المنتج.';
      rcWarn.textContent = sysAudio.checked ? SYS_AUDIO_FULL : '';
      rcWarn.hidden = !sysAudio.checked;
      consentBar.classList.add('show');
      reportBounds();
      $('rcStart').focus();
    };
    recBtn.addEventListener('click', () => { if (recording) stopRec(); else startRec(); });
    $('pvStudio').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('promo-studio-open', { bubbles: true, composed: true,
        detail: { aspect: recAspect.value } }));
    });
    if (typeof window.satr.onPromoCapture === 'function') window.satr.onPromoCapture((event) => {
      if (!event) return;
      if (event.type === 'capture_start') beginNativeCapture(event);
      else if (event.type === 'capture_stop' && event.session_id === recSessionId) finishNativeCapture();
      else if (event.type === 'capture_failed') { clearRecording(); showErr('تعذّر بدء تسجيل البرومو.'); }
      else if (event.type === 'capture_closed') clearRecording();
    });

    // ---------- العقد العام ----------
    // فتح بعنوان جاهز (اقتراح localhost المرصود / أداة open_preview — القشرة تستدعيها).
    // autoLast=false: العنوان القادم أدقّ من المحفوظ فلا نفتح الأخير أولاً (تفادي سباق).
    this.openWith = (url, options) => { openPanel(false); go(url, options && options.agent ? 'agent' : 'user'); };
    // م-1-ج: تحديث تلقائي — القشرة تستدعيها عند اكتمال دور عدّل ملفات والمعاينة مفتوحة.
    // reload فعلي فقط إن كان الوضع مُفعّلاً والعرض حيّاً (خارج ذلك تجاهل صامت آمن).
    this.reloadIfLive = () => {
      if (autoReload && started && this.hasAttribute('open')) {
        if (errorWatch) clearTimeout(errorWatch);
        errorWave = [];
        window.satr.previewAction('reload');
        errorWatch = setTimeout(() => {
          const wave = errorWave.slice(0, 30);
          errorWave = []; errorWatch = null;
          if (wave.length) this.dispatchEvent(new CustomEvent('preview-error-wave', { bubbles: true, detail: { count: wave.length, errors: wave } }));
        }, 4200);
        return true;
      }
      return false;
    };
    // إصلاح احتجاب مربع الإذن خلف المعاينة (لقطة مالك): القشرة تستدعيها عند ظهور/إخفاء
    // مربع إذن — نُخفي العرض الأصلي (bounds صفر) فيبرز المربع فوق اللوحة، ثم نعيده.
    const setHeld = (reason, hold) => {
      if (hold) holdReasons.add(reason); else holdReasons.delete(reason);
      held = holdReasons.size > 0;
      // OBS-032: الإخفاء مقصود لكنه كان صامتاً، فيقرأ المستخدم السوادَ عطلاً لا تنحّياً.
      // سطر واحد مكان العرض يحوّل ما يبدو عطلاً إلى سلوك مفهوم. مقصور على سبب الحوار
      // لأن نصّه يعد بالعودة فور الردّ، ولا يظهر قبل بدء عرض أصلاً (لافتة الترحيب مكانه).
      heldNote.hidden = !(started && holdReasons.has('dialog'));
      if (!started) return;
      if (held) { window.satr.previewBounds(0, 0, 0, 0); lastBoundsKey = '0,0,0,0'; } // العرض بحجم صفر ⇒ مخفي، المربع يظهر
      else reportBounds(); // استعادة الموضع الفعلي بعد الرد (lastBoundsKey='0,0,0,0' يضمن إعادة الإرسال)
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
      browser_hover: 'يحوّم', browser_wait_for: 'ينتظر', browser_evaluate: 'يشخّص JavaScript',
      browser_set_viewport: 'يختبر التجاوب', browser_perf: 'يقيس الأداء', browser_back: 'يرجع',
      browser_forward: 'يتقدّم', browser_handoff: 'يسلّمك القيادة', browser_handoff_step: 'يسلّمك خطوة',
      browser_fill_form: 'يعبّئ نموذجاً', browser_transfer_field: 'ينقل قيمة سرّية',
      browser_request_secret: 'ينتظر إدخال سرّ',
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
    let conflictTimer = 0;
    const CONFLICT_LABELS = {
      input_changed: 'أوقفنا خطوة الوكيل لأنك تفاعلت مع الصفحة — القيادة لك.',
      target_changed: 'أوقفنا خطوة الوكيل لأن الصفحة تغيّرت منذ لقطتها.',
      ref_removed: 'أوقفنا خطوة الوكيل لأن الصفحة تغيّرت منذ لقطتها.',
    };
    this.flashConflict = (reason) => {
      const text = CONFLICT_LABELS[reason];
      if (!text || !conflictBadge) return;
      conflictBadge.textContent = text;
      conflictBadge.classList.add('show');
      clearTimeout(conflictTimer);
      conflictTimer = setTimeout(() => { conflictBadge.classList.remove('show'); }, 4000);
    };
    this.flashAgentActivity = (toolName) => {
      const bare = String(toolName || '').replace('mcp__satr-terminal__', '');
      const label = ACTION_LABELS[bare];
      if (!label) return; // ليست أداة متصفح — لا تُظهر شيئاً
      recordTraceAction(label);
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
    const hoBar = $('pvHandoff'), hoPrefix = $('hoPrefix'), hoReason = $('hoReason'), hoDone = $('hoDone');
    let handoffId = null;
    const answerHandoff = (done) => {
      if (!handoffId) return;
      const id = handoffId;
      handoffId = null;
      hoBar.classList.remove('show');
      window.satr.handoffDone(id, done);
    };
    hoDone.addEventListener('click', () => answerHandoff(true));
    $('hoCancel').addEventListener('click', () => answerHandoff(false));
    this.showHandoff = (id, reason, mode) => {
      openPanel(false); // التسليم يفترض معاينة مفتوحة — فتح اللوحة إن كانت مطوية كي يُرى الشريط
      handoffId = String(id || '');
      hoPrefix.textContent = mode === 'step' ? 'أكمل:' : 'الوكيل يسلّمك القيادة:';
      hoDone.textContent = mode === 'step' ? 'تم ✓' : 'استلمت ✓';
      hoReason.textContent = String(reason || '');
      hoBar.classList.add('show');
      // القيادة بيد المستخدم — أخفِ مؤشر نشاط الوكيل إن كان ظاهراً
      agentTag.classList.remove('show'); agentLine.classList.remove('show');
    };
    this.hideHandoff = () => { handoffId = null; hoBar.classList.remove('show'); };
  }
}

customElements.define('satr-preview-panel', SatrPreviewPanel);
