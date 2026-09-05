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

/**
 * اتجاه الوعاء الذي يعيش فيه العنصر — لا اتجاه العنصر نفسه.
 *
 * يُقرأ من أقرب جدٍّ يحمل `dir` صريحاً، ويسقط إلى اتجاه المستند ثم إلى `rtl`. القراءة
 * بـ`closest` لا بـ`getComputedStyle` عمداً: الأولى استعلام شجرة رخيص، والثانية تُجبر
 * حساب تخطيط في دالةٍ تُستدعى لكل فقرة. و`closest` لا يعبر حدّ Shadow، فمكوّنٌ داخل
 * Shadow بلا `dir` على مضيفه يسقط إلى المستند — وهو الصحيح في «سطر» (الواجهة RTL).
 */
function containerDir(el) {
  const holder = el.parentElement && el.parentElement.closest('[dir]');
  const dir = holder ? holder.getAttribute('dir')
    : (typeof document !== 'undefined' && document.documentElement
      ? document.documentElement.getAttribute('dir') : '');
  return dir === 'ltr' ? 'ltr' : 'rtl';
}

/**
 * يضبط `dir` على عنصر من نصّه — الطريق المفضّل في المكوّنات التي تبني DOM.
 *
 * **ويثبّت معه `text-align` صريحة** (‏`OBS-128`، علاج مقيس): `dir` يحسم **ترتيب** النصّ،
 * أما **محاذاته** فكانت تأتي من `text-align` الموروثة — وتلك تُورَّث `start` النسبيّة،
 * فتُحلّ بـ`direction` العنصر نفسه لا بوعائه. فعنصرٌ حُسم `ltr` داخل عمودٍ عربيّ يقفز
 * إلى اليسار. كان Chromium 130 يورّثها **محلولةً** (`right`) فيستر ذلك، وChromium 152
 * يورّثها نسبيّةً فينكشف — والعطل في اتّكالنا على تفصيل التنفيذ لا في المتصفح.
 *
 * والمحاذاة تتبع **الوعاء** لا `dir` العنصر: نصّ لاتينيّ داخل واجهة عربية يبقى راسياً
 * يميناً كما كان، ويتغيّر ترتيبُه وحده. ولذلك لا أثر بصريّ على العناصر التي يوافق
 * `dir`ها وعاءها — وهي الغالبية — والتغيير محصور بالمخالفة، أي بالحالة المعطوبة.
 */
export function applyDir(el, text) {
  if (!el) return el;
  const dir = textDir(typeof text === 'string' ? text : el.textContent || '');
  if (dir) {
    el.setAttribute('dir', dir);
    // CSSOM لا سمة `style=` — الأخيرة محجوبة بـCSP في «سطر»
    el.style.textAlign = containerDir(el) === 'ltr' ? 'left' : 'right';
  } else {
    el.removeAttribute('dir');
    el.style.textAlign = ''; // لا نترك محاذاة من استدعاءٍ سابق حين يزول الحسم
  }
  return el;
}
