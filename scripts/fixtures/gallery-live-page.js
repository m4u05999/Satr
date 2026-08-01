// سيناريو الاختبار الحي للوحة المعرض: جسر window.satr مزيف يقدّم بيانات fixture
// (قنوات generationsList/genThumb تُضاف عند الدمج — هنا نثبت عقد اللوحة معها).
const violations = [];
window.__galleryLiveProgress = 'loading';
const bridge = { listCalls: [], thumbCalls: [], copied: null, sendCalls: [] };
let nextItems = window.SATR_GALLERY_FIXTURE.items;

// جسر مزيف بنفس عقد IPC المجمَّد §3 — send مسجّل لإثبات أن اللوحة لا ترسل شيئاً
window.satr = {
  generationsList: async (cwd) => {
    bridge.listCalls.push(cwd);
    return { ok: true, items: nextItems.map((it) => ({ ...it })) };
  },
  genThumb: async (cwd, rel) => {
    bridge.thumbCalls.push(rel);
    const dataUrl = window.SATR_GALLERY_FIXTURE.thumbs[rel];
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'not_found' };
  },
  send: async (payload) => { bridge.sendCalls.push(payload); return { started: true }; },
};
// حافظة مزيفة حتمية (النافذة المخفية قد ترفض الإذن الحقيقي)
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (t) => { bridge.copied = t; } },
});

window.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI });
});
function assert(cond, msg) { if (!cond) throw new Error(msg); }
// مهلة تسوية بإطارَي رسم مع احتياط مؤقّت (تجوع rAF في النافذة المخفية تحت حمل GPU)
function frames(n = 2) {
  return new Promise((resolve) => {
    let done = false;
    let fallback = null;
    const finish = () => { if (!done) { done = true; clearTimeout(fallback); resolve(); } };
    let left = n;
    const step = () => (--left <= 0 ? finish() : requestAnimationFrame(step));
    requestAnimationFrame(step);
    fallback = setTimeout(finish, 300 + n * 100);
  });
}
async function waitFor(cond, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await frames(1);
  }
  throw new Error('انتهت مهلة انتظار: ' + label);
}

document.addEventListener('DOMContentLoaded', async () => {
  const checks = [];
  try {
    await customElements.whenDefined('satr-gallery-panel');
    const el = document.getElementById('gallery');
    const root = el.shadowRoot;
    let closeEvents = 0;
    let insertEvent = null;
    el.addEventListener('panel-close', () => { closeEvents++; });
    el.addEventListener('gallery-insert', (e) => { insertEvent = e.detail; });

    // (1) الفتح بالبيانات المزيفة: شبكة بأربع بطاقات
    window.__galleryLiveProgress = 'open-with-data';
    await el.open(document.getElementById('cwd').value);
    assert(el.hasAttribute('open'), 'لم تُفتح اللوحة.');
    assert(bridge.listCalls.length === 1, 'لم يُستدعَ generationsList.');
    const grid = root.querySelector('.gal-grid');
    assert(grid, 'لم تُرسم الشبكة.');
    const cards = [...grid.querySelectorAll('.gal-card')];
    assert(cards.length === 4, 'عدد البطاقات غير متوقع: ' + cards.length);
    checks.push('grid-four-cards');

    // (2) المصغرات الكسولة تُحمّل عبر genThumb للصورتين فقط
    await waitFor(() => root.querySelectorAll('.gal-thumb img').length === 2, 'تحميل مصغرتين');
    assert(bridge.thumbCalls.length === 2, 'عدد طلبات genThumb غير متوقع: ' + bridge.thumbCalls.length);
    assert(bridge.thumbCalls.includes('generations/satr-logo-1.png'), 'غاب طلب مصغرة الشعار.');
    checks.push('lazy-thumbs');

    // (3) الفيديو بطاقة معلومات مؤجلة بلا <img> وبلا طلب مصغرة
    const videoCard = cards[2];
    assert(videoCard.querySelector('.gal-video'), 'غاب صندوق الفيديو.');
    assert(!videoCard.querySelector('img'), 'ظهرت معاينة فيديو (مؤجلة ج9).');
    assert(videoCard.textContent.includes('الجولة 9'), 'غابت عبارة تأجيل الفيديو.');
    assert(videoCard.querySelector('.gal-meta').textContent.includes('fal/kling-v2.1'), 'ميتا الفيديو ناقصة.');
    checks.push('video-deferred-card');

    // (4) بطاقة الفشل تعرض الخطأ وبلا زر إرسال مسار
    const failedCard = cards[3];
    assert(failedCard.querySelector('.gal-failed'), 'غابت بطاقة الفشل.');
    assert(failedCard.textContent.includes('over_budget'), 'غاب رمز خطأ الفشل.');
    assert(![...failedCard.querySelectorAll('button')].some((b) => b.textContent.includes('أرسل المسار')),
      'ظهر زر إرسال مسار في بطاقة فاشلة.');
    checks.push('failed-card');

    // (5) الكلفة والنموذج/المزوّد LTR والبرومبت العربي
    const firstMeta = cards[0].querySelector('.gal-meta');
    assert(firstMeta.textContent === '$0.003 · fal/flux-schnell', 'ميتا البطاقة الأولى: ' + firstMeta.textContent);
    assert(getComputedStyle(firstMeta).direction === 'ltr', 'الميتا ليست LTR.');
    assert(cards[0].querySelector('.gal-prompt').dir === 'auto', 'البرومبت بلا dir=auto.');
    checks.push('meta-ltr-prompt-auto');

    // (6) نسخ البرومبت إلى الحافظة
    window.__galleryLiveProgress = 'copy';
    const copyBtn = [...cards[0].querySelectorAll('button')].find((b) => b.textContent === 'نسخ البرومبت');
    assert(copyBtn, 'غاب زر نسخ البرومبت.');
    copyBtn.click();
    await frames(2);
    assert(bridge.copied === window.SATR_GALLERY_FIXTURE.items[0].prompt, 'لم يُنسخ البرومبت الصحيح.');
    assert(copyBtn.textContent.includes('✓'), 'غاب تأكيد النسخ.');
    checks.push('copy-prompt');

    // (7) «أرسل المسار للمؤلف»: حدث DOM بالمسار، ولا يُستدعى send إطلاقاً
    window.__galleryLiveProgress = 'insert';
    const sendBtn = [...cards[1].querySelectorAll('button')].find((b) => b.textContent.includes('أرسل المسار'));
    assert(sendBtn, 'غاب زر إرسال المسار.');
    sendBtn.click();
    await frames(1);
    assert(insertEvent && insertEvent.rel === 'generations/coffee-corner.png' && insertEvent.kind === 'image',
      'حمولة gallery-insert غير صحيحة: ' + JSON.stringify(insertEvent));
    assert(bridge.sendCalls.length === 0, 'استُدعي send — يجب ألا يُرسل شيء.');
    checks.push('insert-event-no-send');

    // (8) العرض المكبر: نقر المصغرة يفتحه، Escape يغلقه دون إغلاق اللوحة
    window.__galleryLiveProgress = 'lightbox';
    const thumbBtn = cards[0].querySelector('button.gal-thumb');
    thumbBtn.click();
    await frames(2);
    const lightbox = root.querySelector('.gal-lightbox');
    assert(!lightbox.hidden, 'لم يُفتح العرض المكبر.');
    assert(lightbox.querySelector('img').src.startsWith('data:image/svg+xml'), 'لا صورة في العرض المكبر.');
    assert(lightbox.querySelector('.gal-prompt').textContent.includes('شعار دائري'), 'شرح العرض المكبر ناقص.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames(1);
    assert(lightbox.hidden, 'لم يُغلق العرض المكبر بـ Escape.');
    assert(el.hasAttribute('open'), 'Escape أغلق اللوحة بدل العرض المكبر.');
    // إعادة الفتح والإغلاق بزر ✕
    thumbBtn.click();
    await frames(1);
    assert(!lightbox.hidden, 'لم يُفتح العرض المكبر ثانية.');
    root.querySelector('.gal-lb-close').click();
    await frames(1);
    assert(lightbox.hidden, 'زر ✕ لم يغلق العرض المكبر.');
    checks.push('lightbox-open-esc-close');

    // (9) الإغلاق: يبث panel-close ويطفأ open
    window.__galleryLiveProgress = 'close';
    root.querySelector('.close').click();
    await frames(1);
    assert(!el.hasAttribute('open'), 'لم تُغلق اللوحة.');
    assert(closeEvents === 1, 'لم يُبث panel-close.');
    checks.push('close-event');

    // (10) الحالة الفارغة: إرشاد عربي واضح (تُختبر بصرياً أيضاً في ui:audit)
    window.__galleryLiveProgress = 'empty';
    nextItems = [];
    await el.open(document.getElementById('cwd').value);
    await frames(1);
    const empty = root.querySelector('.gal-empty');
    assert(empty, 'لم تظهر الحالة الفارغة.');
    assert(empty.textContent.includes('لا توليدات بعد'), 'نص الحالة الفارغة غير إرشادي.');
    assert(!root.querySelector('.gal-grid'), 'ظهرت شبكة رغم فراغ السجل.');
    checks.push('empty-state');

    window.__galleryLiveProgress = 'done';
    window.__galleryLiveResult = { pass: true, checks, violations };
  } catch (error) {
    window.__galleryLiveResult = {
      pass: false,
      error: (error && error.message) || String(error),
      progress: window.__galleryLiveProgress,
      checks, violations,
    };
  }
});
