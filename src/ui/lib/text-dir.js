/**
 * حسم اتجاه النص المختلط — **المصدر الواحد** لكل مكوّنات الواجهة.
 *
 * **لماذا لا `unicode-bidi: plaintext`** (درس مثبَّت، لقطات مالك 2026-07-18):
 * `plaintext` يحسم اتجاه الفقرة من **أول حرف قوي**، فأي فقرة عربية الجوهر تبدأ برمز
 * لاتيني — `SHA-256 …` · `npm run …` · `F1 —` — تُرسى LTR كاملة: ينقلب ترتيبها
 * البصري وتقفز علامات الترقيم إلى الطرف الخطأ وتنعكس الأسهم. وهو **نمط التقارير
 * التقنية**، أي جوهر استعمال «سطر» لا حالة نادرة.
 *
 * البديل المعتمد: حسم **إحصائي** على مستوى العنصر — العربي إن بلغ نصف اللاتيني
 * فأكثر. والكود داخل الأسطر العربية ينعزل LTR بخوارزمية BiDi نفسها بلا تدخّل.
 *
 * ⚠️ **الخاصية المحسوبة لا تكشف هذا العطل**: `getComputedStyle(el).direction` يبقى
 * `rtl` الموروثة بينما الفقرة رست LTR داخلياً. الدليل الوحيد موضع أول محرف —
 * ولذلك يقيسه `scripts/arabic-rtl-probe.js` بالبكسل.
 *
 * استُخرجت من `chat.js` (‏2026-08-13) بعد أن أثبت المسح أن العلاج طُبِّق هناك وحده
 * بينما 22 مكوّناً آخر بقيت على `plaintext` — نسخُ المنطق يعني تباعده بصمت.
 */

/** @returns {'rtl'|'ltr'|''} — فراغ حين لا حروف قوية أصلاً (أرقام/رموز فقط). */
export function textDir(text) {
  if (typeof text !== 'string' || !text) return '';
  const ar = (text.match(/[؀-ۿݐ-ݿ]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (!ar && !lat) return '';
  return ar * 2 >= lat ? 'rtl' : 'ltr';
}

/** سمة `dir` جاهزة للإدراج في HTML (فارغة حين لا حسم). */
export function dirAttr(text) {
  const dir = textDir(text);
  return dir ? ' dir="' + dir + '"' : '';
}

/** يضبط `dir` على عنصر من نصّه — الطريق المفضّل في المكوّنات التي تبني DOM. */
export function applyDir(el, text) {
  if (!el) return el;
  const dir = textDir(typeof text === 'string' ? text : el.textContent || '');
  if (dir) el.setAttribute('dir', dir);
  else el.removeAttribute('dir');
  return el;
}
