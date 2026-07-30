// ورقة الأنماط المشتركة للوحات الجانبية المفكّكة (Shadow DOM) — تفكيك ت-1.
// تعادل ما كانت اللوحات تأخذه من base.css عبر المستند: هيكل اللوحة الثابتة + الرأس +
// القائمة، **زائد** ما لا يعبر حدود Shadow من الأنماط العامة (reset الهوامش، أنماط
// button وinput، وتعطيل الحركة تحت prefers-reduced-motion) — متغيّرات التصميم (tokens)
// تعبر بالوراثة فتبقى في :root بالورقة الأساس.
// العرض الافتراضي 420px (لوحات موصلات/سياق/وكلاء/ملفات/git)؛ لوحة بعرض مختلف
// (جلسات/مهارات: 400px) تتجاوزه في ورقتها الخاصة.
// حالة الفتح سمة [open] على المضيف (كانت صنف .open على <aside>).
import { sheet } from './sheet.js';

// «عناصر التحكم» وحدها (reset + أزرار + حقول + reduced-motion) — للمكوّنات غير اللوحية
// (كالعارض ت-7) التي تحتاجها دون قواعد :host الخاصة باللوحات الجانبية الثابتة
const controlsText = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  /* [hidden] لا يعبر Shadow، وأي قاعدة مؤلف فيها display تغلبه — فكان كل مكوّن
     يعالجها حالةً بحالة وتسقط الحالات المنسية (رُصد: «إعدادات متقدمة» في غرفة
     العمليات بقيت مفرودة رغم hidden لأن display:grid يغلبه). نفس القاعدة العامة
     التي حسمتها في base.css للـlight DOM، هنا لكل مكوّن يستورد هذه الورقة. */
  [hidden] { display: none !important; }
  button {
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-3); font-family: var(--sans); font-size: 13px;
    cursor: pointer; transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  button:hover { border-color: var(--gold); background: var(--surface-3); }
  button:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  input[type="text"] {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-md); padding: var(--space-1h) var(--space-2h); font-family: var(--sans); font-size: 13px; outline: none;
    transition: border-color var(--dur) var(--ease);
  }
  input[type="text"]:focus { border-color: var(--gold); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
`;
export const controlsSheet = sheet(controlsText);

export const panelSheet = sheet(controlsText + `
  /* سطح جانبي داخل #midRow — لا overlay مثبّت (دفعة صقل الواجهة، الحزمة الأولى):
     كانت اللوحات position:fixed بكامل الطول فتحجب علامة الشريط العلوي وتقصّ المؤلّف
     بصرياً؛ صارت شقيقة flex مثل satr-ops-room فتضيّق عمود الدردشة بدل تغطيته. */
  :host {
    position: relative; inset: auto; align-self: stretch;
    width: min(420px, 50vw); flex: 0 0 auto; height: 100%; min-height: var(--space-0);
    background: var(--surface); border-inline-start: 1px solid var(--border);
    z-index: var(--z-panel);
    display: none; flex-direction: column;
  }
  /* الظلّ عند الفتح فقط — وظلّ dock الأخف لأن اللوحة صارت ملتصقة لا عائمة */
  :host([open]) { display: flex; box-shadow: var(--shadow-dock); }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border);
    font-weight: 600; color: var(--gold);
  }
  .panel-head-actions { display: flex; gap: var(--space-1h); }
  .panel-search { padding: var(--space-2h) var(--space-3); border-bottom: 1px solid var(--border); }
  .panel-search input { width: 100%; }
  .panel-list { flex: 1; overflow-y: auto; }
  .panel-list .hint { padding: var(--space-4); color: var(--text-dim); font-size: 13px; text-align: center; }
  .panel-head button.refresh { font-size: 12px; padding: 3px var(--space-2h); color: var(--text); }
`);
