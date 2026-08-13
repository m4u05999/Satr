/**
 * صفحة قياس اتجاه النص العربي المختلط في المكوّنات الإنتاجية.
 *
 * **تقيس البكسل لا الخاصية المحسوبة**: `unicode-bidi: plaintext` يحسم اتجاه الفقرة
 * داخلياً من أول حرف قوي، و`getComputedStyle(el).direction` يبقى يعيد `rtl` الموروثة
 * — فالخاصية المحسوبة **لا تكشف العطل إطلاقاً**. الدليل الوحيد هو موضع أول محرف:
 * في RTL يرسو يميناً، وفي LTR يساراً.
 */
'use strict';

// جلسات اصطناعية: عناوين **عربية الجوهر تبدأ برمز لاتيني** — وهو بالضبط نمط
// التقارير التقنية الذي كسر فقاعات المحادثة قبل إصلاح 2026-07-18.
const SESSIONS = [
  { id: 'a1b2c3d4-0000-4000-8000-000000000001', project: 'satr-2', cwd: 'D:/sater/satr-2',
    title: 'F1 — الهاتف يرنّ عبر الوسيط الأعمى', mtime: 3000 },
  { id: 'a1b2c3d4-0000-4000-8000-000000000002', project: 'satr-2', cwd: 'D:/sater/satr-2',
    title: 'npm run test:full فشل عندي بعد الترقية', mtime: 2000 },
  { id: 'a1b2c3d4-0000-4000-8000-000000000003', project: 'satr-2', cwd: 'D:/sater/satr-2',
    title: 'راجع اللوحة من فضلك', mtime: 1000 },
];

window.satr = {
  listSessions: () => Promise.resolve(SESSIONS),
  listChats: () => Promise.resolve([]),
  listCodexSessions: () => Promise.resolve([]),
  listKimiSessions: () => Promise.resolve([]),
  sessionMetaList: () => Promise.resolve({ entries: {} }),
};

/** يعيد موضع أول محرف داخل العنصر مقارنةً بحافتيه. */
function anchorOf(el) {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.length) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  const first = range.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  if (!first.width && !first.height) return null;
  const fromRight = box.right - first.right;
  const fromLeft = first.left - box.left;
  // أول محرف أقرب إلى اليمين ⇒ الفقرة رست RTL، والعكس LTR
  return { anchor: fromRight <= fromLeft ? 'rtl' : 'ltr', fromRight, fromLeft };
}

window.__arabicRtl = async function run() {
  const panel = document.querySelector('satr-sessions-panel');
  await panel.open([]);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const root = panel.shadowRoot || panel;
  const titles = [...root.querySelectorAll('.sess .t')];
  return titles.map((el) => Object.assign(
    { text: el.textContent.slice(0, 40) }, anchorOf(el) || { anchor: 'unknown' }
  ));
};
