// سائق صفحة اختبار OBS-099: يسجّل أحداث settings-open كما تصل إلى مستمع خارجي،
// ويُعلم الجاهزية. يُحمَّل قبل topbar.js عمداً ليعكس ترتيب الإنتاج (‏app.js قبل
// ترقية المكوّنات) — بهذا يثبت الاختبار أن الإصلاح لا يعتمد على ترتيب التسجيل.
window.__events = [];
document.querySelector('satr-topbar').addEventListener('settings-open', () => {
  window.__events.push('settings-open');
});
window.__pageReady = true;
