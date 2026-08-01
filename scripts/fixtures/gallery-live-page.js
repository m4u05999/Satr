// سيناريو الاختبار الحي للوحة المعرض: جسر window.satr مزيف يقدّم بيانات fixture
// (قنوات generationsList/genThumb/genMedia — هنا نثبت عقد اللوحة معها).
const violations = [];
window.__galleryLiveProgress = 'loading';
const bridge = { listCalls: [], thumbCalls: [], mediaCalls: [], copied: null, sendCalls: [],
  oversize: false, urlsCreated: 0, urlsRevoked: 0 };
let nextItems = window.SATR_GALLERY_FIXTURE.items;

// عدّاد objectURL: إثبات revokeObjectURL عند الإغلاق/إعادة الفتح (إلزام ج10)
const realCreateUrl = URL.createObjectURL.bind(URL);
const realRevokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { bridge.urlsCreated++; return realCreateUrl(blob); };
URL.revokeObjectURL = (url) => { bridge.urlsRevoked++; return realRevokeUrl(url); };

// قائمة سماح امتدادات genMedia — نفس قواعد main.js حرفياً (النوع من الامتداد)
const MEDIA_EXT = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

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
  // genMedia (ج10): rel داخل generations/ حصراً + قائمة السماح + سقف 24MiB (oversize)
  genMedia: async (cwd, rel) => {
    bridge.mediaCalls.push(rel);
    if (typeof rel !== 'string' || !rel || rel.indexOf('..') !== -1 || rel[0] === '/'
        || /^[A-Za-z]:/.test(rel) || !rel.startsWith('generations/'))
      return { ok: false, error: 'bad_path' };
    const mime = MEDIA_EXT[rel.slice(rel.lastIndexOf('.')).toLowerCase()];
    if (!mime) return { ok: false, error: 'bad_path' };
    if (bridge.oversize) return { ok: false, error: 'bad_size' };
    const payload = window.SATR_GALLERY_FIXTURE.media[rel];
    return payload ? { ok: true, mime, dataUrl: payload.dataUrl } : { ok: false, error: 'read_failed' };
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

    // (1) الفتح بالبيانات المزيفة: شبكة بخمس بطاقات (صورتان + فيديو + صوت + فاشلة)
    window.__galleryLiveProgress = 'open-with-data';
    await el.open(document.getElementById('cwd').value);
    assert(el.hasAttribute('open'), 'لم تُفتح اللوحة.');
    assert(bridge.listCalls.length === 1, 'لم يُستدعَ generationsList.');
    const grid = root.querySelector('.gal-grid');
    assert(grid, 'لم تُرسم الشبكة.');
    const cards = [...grid.querySelectorAll('.gal-card')];
    assert(cards.length === 5, 'عدد البطاقات غير متوقع: ' + cards.length);
    checks.push('grid-five-cards');

    // (2) المصغرات الكسولة تُحمّل عبر genThumb للصورتين فقط
    await waitFor(() => root.querySelectorAll('.gal-thumb img').length === 2, 'تحميل مصغرتين');
    assert(bridge.thumbCalls.length === 2, 'عدد طلبات genThumb غير متوقع: ' + bridge.thumbCalls.length);
    assert(bridge.thumbCalls.includes('generations/satr-logo-1.png'), 'غاب طلب مصغرة الشعار.');
    checks.push('lazy-thumbs');

    // (3) الفيديو: بطاقة معلومات بزر «▶ شغّل المعاينة» — بلا مشغّل ولا طلب genMedia قبل النقر (كسل صارم)
    const videoCard = cards[2];
    assert(videoCard.querySelector('.gal-video'), 'غاب صندوق الفيديو.');
    assert(!videoCard.querySelector('video'), 'ظهر مشغّل فيديو قبل النقر — الكسل مكسور.');
    const videoPlay = videoCard.querySelector('button.gal-play');
    assert(videoPlay && videoPlay.textContent.includes('شغّل المعاينة'), 'غاب زر تشغيل المعاينة.');
    assert(videoCard.querySelector('.gal-meta').textContent.includes('fal/kling-v2.1'), 'ميتا الفيديو ناقصة.');
    checks.push('video-player-card');

    // (3ب) الصوت: بطاقة معلومات بزر «▶ شغّل المقطع» بالنمط نفسه
    const audioCard = cards[3];
    assert(audioCard.querySelector('.gal-audio'), 'غاب صندوق الصوت.');
    assert(!audioCard.querySelector('audio'), 'ظهر مشغّل صوت قبل النقر — الكسل مكسور.');
    const audioPlay = audioCard.querySelector('button.gal-play');
    assert(audioPlay && audioPlay.textContent.includes('شغّل المقطع'), 'غاب زر تشغيل المقطع.');
    assert(audioCard.querySelector('.gal-meta').textContent.includes('fal/stable-audio-2.5'), 'ميتا الصوت ناقصة.');
    assert(bridge.thumbCalls.length === 2, 'طلبت بطاقة الصوت/الفيديو مصغرة: ' + bridge.thumbCalls.length);
    assert(bridge.mediaCalls.length === 0, 'طُلب genMedia قبل أي نقر: ' + bridge.mediaCalls.length);
    checks.push('audio-player-card');
    checks.push('media-lazy-no-preload');

    // (4) بطاقة الفشل تعرض الخطأ وبلا زر إرسال مسار
    const failedCard = cards[4];
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

    // (8ب) تشغيل الفيديو: genMedia عند النقر فقط ثم <video controls> بـ blob:
    window.__galleryLiveProgress = 'video-play';
    videoPlay.click();
    await waitFor(() => videoCard.querySelector('video.gal-player'), 'مشغّل الفيديو');
    const videoEl = videoCard.querySelector('video.gal-player');
    assert(videoEl.controls, 'مشغّل الفيديو بلا controls.');
    assert(videoEl.src.startsWith('blob:'), 'مصدر الفيديو ليس objectURL: ' + videoEl.src);
    assert(bridge.mediaCalls.length === 1 && bridge.mediaCalls[0] === 'generations/souq-aerial.mp4',
      'طلب genMedia للفيديو غير متوقع: ' + JSON.stringify(bridge.mediaCalls));
    checks.push('video-player-lazy');

    // (8ج) تشغيل الصوت بالنمط نفسه ⇒ <audio controls>
    audioPlay.click();
    await waitFor(() => audioCard.querySelector('audio.gal-audio-player'), 'مشغّل الصوت');
    const audioEl = audioCard.querySelector('audio.gal-audio-player');
    assert(audioEl.controls, 'مشغّل الصوت بلا controls.');
    assert(audioEl.src.startsWith('blob:'), 'مصدر الصوت ليس objectURL: ' + audioEl.src);
    assert(bridge.mediaCalls.length === 2 && bridge.mediaCalls[1] === 'generations/satr-theme.mp3',
      'طلب genMedia للصوت غير متوقع: ' + JSON.stringify(bridge.mediaCalls));
    checks.push('audio-player-lazy');

    // (8د) تجاوز السقف ⇒ بطاقة المعلومات القائمة + «تعذّر تحميل المعاينة» (لا فشل صامت)
    window.__galleryLiveProgress = 'oversize';
    bridge.oversize = true;
    await el.open(document.getElementById('cwd').value); // إعادة بناء الشبكة
    const videoCard2 = [...root.querySelectorAll('.gal-card')][2];
    const play2 = videoCard2.querySelector('button.gal-play');
    assert(play2, 'غاب زر التشغيل بعد إعادة الفتح.');
    play2.click();
    await waitFor(() => videoCard2.querySelector('.gal-media-err'), 'رسالة تعذّر المعاينة');
    assert(videoCard2.querySelector('.gal-media-err').textContent.includes('تعذّر تحميل المعاينة'), 'رسالة الفشل غير صريحة.');
    assert(!videoCard2.querySelector('video'), 'ظهر مشغّل رغم رفض السقف.');
    assert(videoCard2.textContent.includes('فيديو'), 'فقدت بطاقة المعلومات محتواها بعد الفشل.');
    bridge.oversize = false;
    checks.push('media-oversize-rejected');

    // (8هـ) رفض المسار/الامتداد على مستوى العقد (القواعد نفسها مفروضة في main.js
    // وتُفحص ساكنة في gallery-live-test — هنا نثبت شكل الرفض الذي تبنيه الواجهة عليه)
    const badRel = await window.satr.genMedia('C:/fixture', '../outside.mp4');
    const badExt = await window.satr.genMedia('C:/fixture', 'generations/notes.txt');
    const absPath = await window.satr.genMedia('C:/fixture', 'D:/generations/x.mp4');
    assert(badRel.ok === false && badRel.error === 'bad_path', 'قُبل مسار خارج generations/.');
    assert(badExt.ok === false && badExt.error === 'bad_path', 'قُبل امتداد خارج قائمة السماح.');
    assert(absPath.ok === false && absPath.error === 'bad_path', 'قُبل مسار مطلق.');
    bridge.mediaCalls.length = 0; // طلبات الفحص المباشرة لا تخص تدفق البطاقات
    checks.push('media-path-ext-rejected');

    // (9) الإغلاق: يبث panel-close ويطفأ open — ويسحب objectURL كلها (لا تسريب)
    window.__galleryLiveProgress = 'close';
    root.querySelector('.close').click();
    await frames(1);
    assert(!el.hasAttribute('open'), 'لم تُغلق اللوحة.');
    assert(closeEvents === 1, 'لم يُبث panel-close.');
    checks.push('close-event');
    assert(bridge.urlsCreated >= 2, 'لم تُنشأ عناوين objectURL للمشغّلين: ' + bridge.urlsCreated);
    assert(bridge.urlsCreated === bridge.urlsRevoked,
      'تسريب objectURL: أُنشئ ' + bridge.urlsCreated + ' وسُحب ' + bridge.urlsRevoked);
    checks.push('media-revoke-on-close');

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
