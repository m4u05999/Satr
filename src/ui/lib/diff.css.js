// ورقة أنماط بطاقة الفرق (Diff) — **المصدر الوحيد** منذ حسم الازدواج في ت-12
// (نسخة base.css حُذفت). مستهلكوها: مكوّن المحادثة satr-chat يعتمدها على **المستند**
// (adoptedStyleSheets على document — بطاقات light DOM في الخيط)، ولوحة git وعارض
// الملفات يعتمدانها على shadowRoot. أي تعديل على البطاقة هنا يصل الثلاثة معاً.
import { sheet } from './sheet.js';

export const diffSheet = sheet(`
  .diffs { display: flex; flex-direction: column; gap: 8px; }
  .diff { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--bg); }
  /* الترويسة عربية (RTL): الوسم والعدّاد والأزرار؛ اسم الملف وحده LTR */
  .diff-head { display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: var(--surface-2); font-size: 12px; }
  .diff-toggle { background: none; border: none; color: var(--text-dim); padding: 0 2px; font-size: 12px; cursor: pointer; transition: transform var(--dur) var(--ease); }
  .diff-toggle:hover { border: none; color: var(--gold); }
  .diff.collapsed .diff-toggle { transform: rotate(-90deg); }
  .diff-file { font-family: var(--mono); color: var(--gold); direction: ltr; font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diff-tag { color: var(--text-dim); font-size: 11px; white-space: nowrap; }
  .diff-counts { font-family: var(--mono); direction: ltr; font-size: 12px; white-space: nowrap; }
  .diff-counts .a { color: var(--green); }
  .diff-counts .d { color: var(--red); margin-inline-start: 8px; }
  .diff-undo { font-size: 11.5px; padding: 3px 11px; white-space: nowrap; }
  .diff-undo:disabled { opacity: .55; cursor: default; border-color: var(--border); }
  /* جسم الفرق: كود LTR أحادي المسافة داخل واجهة RTL */
  .diff-body { direction: ltr; text-align: left; font-family: var(--mono); font-size: 12px; line-height: 1.55; overflow-x: auto; max-height: 440px; overflow-y: auto; }
  .diff.collapsed .diff-body { display: none; }
  .diff.undone { opacity: .55; }
  .dl { display: flex; white-space: pre; }
  .dl .ln { flex: 0 0 auto; width: 38px; text-align: right; padding: 0 6px; color: var(--text-faint); user-select: none; }
  .dl .sg { flex: 0 0 auto; width: 16px; text-align: center; user-select: none; }
  .dl .tx { flex: 1; padding: 0 8px; white-space: pre; }
  .dl.add { background: var(--green-soft); }
  .dl.add .sg { color: var(--green); }
  .dl.del { background: var(--red-soft); }
  .dl.del .sg { color: var(--red); }
  .dl.gap { justify-content: center; color: var(--text-dim); opacity: .6; padding: 1px 0; }
  /* فرق ملف عربي: مرآة كاملة كنمط rtl-doc في العارض — الأرقام والإشارة عمود يميناً،
     النص يرسو يميناً ويلتف (لا تمرير أفقي). text-align صريحة — الوراثة تغلب dir */
  .diff.rtl-doc .dl { flex-direction: row-reverse; }
  .diff.rtl-doc .dl .tx { direction: rtl; text-align: right; white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff.rtl-doc .dl .ln { text-align: left; }
  .diff-note { padding: 4px 10px; font-size: 11.5px; color: var(--text-dim); border-top: 1px solid var(--border); }
`);
