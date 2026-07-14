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
  button {
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 6px 13px; font-family: var(--sans); font-size: 13px;
    cursor: pointer; transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  button:hover { border-color: var(--gold); background: var(--surface-3); }
  button:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  input[type="text"] {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 6px 10px; font-family: var(--sans); font-size: 13px; outline: none;
    transition: border-color var(--dur) var(--ease);
  }
  input[type="text"]:focus { border-color: var(--gold); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
`;
export const controlsSheet = sheet(controlsText);

export const panelSheet = sheet(controlsText + `
  :host {
    position: fixed; top: 0; bottom: 0; right: 0; width: 420px; max-width: 92vw;
    background: var(--surface); border-inline-start: 1px solid var(--border);
    z-index: var(--z-panel);
    transform: translateX(100%); transition: transform var(--dur) var(--ease);
    display: flex; flex-direction: column;
  }
  /* الظلّ عند الفتح فقط: لوحة مغلقة منزلقة خارج الشاشة كانت تُبقي شريط ظلّها الدائم يمين الحافة */
  :host([open]) { transform: translateX(0); box-shadow: var(--shadow-panel); }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    font-weight: 600; color: var(--gold);
  }
  .panel-head-actions { display: flex; gap: 6px; }
  .panel-search { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .panel-search input { width: 100%; }
  .panel-list { flex: 1; overflow-y: auto; }
  .panel-list .hint { padding: 16px; color: var(--text-dim); font-size: 13px; text-align: center; }
  .panel-head button.refresh { font-size: 12px; padding: 3px 10px; color: var(--text); }
`);
