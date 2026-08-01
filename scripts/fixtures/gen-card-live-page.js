// سيناريو الاختبار الحي لبطاقة «توليد مكتمل» في المحادثة (الجولة 9 §2): method
// addGenerationCard في chat.js الحقيقي تحت CSP الفعلية، مع جسر genThumb مزيف
// يقدّم مصغرات fixture. عقد الحدث المجمَّد {type:'generation_done', kind, files,
// cost_usd_estimate, provider, model} يبثّه كودكس عند الدمج — هنا يُمرَّر للطريقة
// مباشرةً (حقن اصطناعي بنمط الـharness)، والقائد يتحقق من الوصلة الحية بعد الدمج.
const violations = [];
window.__genCardLiveProgress = 'loading';
const bridge = { thumbCalls: [], opened: 0 };

// جسر مزيف بنفس عقد genThumb المجمَّد §3 — القناة الحقيقية قائمة عند كودكس
window.satr = {
  genThumb: async (cwd, rel) => {
    bridge.thumbCalls.push(rel);
    const dataUrl = window.SATR_GALLERY_FIXTURE.thumbs[rel];
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'not_found' };
  },
};

window.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI });
});
function assert(cond, msg) { if (!cond) throw new Error(msg); }
// مهلة تسوية بإطارَي رسم مع احتياط مؤقّت (نمط gallery-live-page)
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
    await customElements.whenDefined('satr-chat');
    const chat = document.querySelector('satr-chat');
    const cwd = 'C:/fixture';
    const onOpen = () => { bridge.opened++; };

    // (1) بطاقة صورة: تُبنى في الخيط، تُخفي الحالة الفارغة، وتجلب المصغرة عبر genThumb
    window.__genCardLiveProgress = 'image-card';
    chat.addGenerationCard({
      type: 'generation_done', kind: 'image', files: ['generations/satr-logo-1.png'],
      cost_usd_estimate: 0.04, provider: 'fal', model: 'gpt-image-2',
    }, cwd, onOpen);
    const card = document.querySelector('.gen-card');
    assert(card, 'لم تُبنَ بطاقة التوليد.');
    assert(card.textContent.includes('توليد مكتمل: صورة'), 'عنوان بطاقة الصورة ناقص.');
    assert(card.querySelector('.work-card-state').textContent === 'fal/gpt-image-2', 'حالة البطاقة: ' + card.querySelector('.work-card-state').textContent);
    assert(!document.querySelector('.empty'), 'بقيت الحالة الفارغة بعد البطاقة.');
    await waitFor(() => card.querySelector('.gen-thumb img'), 'تحميل مصغرة الصورة');
    assert(bridge.thumbCalls.length === 1 && bridge.thumbCalls[0] === 'generations/satr-logo-1.png',
      'طلب genThumb غير متوقع: ' + JSON.stringify(bridge.thumbCalls));
    checks.push('image-card-thumb');

    // (2) الكلفة والمسار في ذيل البطاقة LTR دائماً (bdi.work-card-tech)
    const techs = card.querySelectorAll('.work-card-tech');
    assert(techs.length === 2, 'عدد قيم الذيل التقنية غير متوقع: ' + techs.length);
    assert(techs[0].textContent === '$0.040', 'صيغة الكلفة: ' + techs[0].textContent);
    assert(techs[1].textContent === 'generations/satr-logo-1.png', 'المسار: ' + techs[1].textContent);
    assert(getComputedStyle(techs[1]).direction === 'ltr', 'المسار ليس LTR.');
    checks.push('ltr-cost-path');

    // (3) نقر البطاقة يستدعي معاودة فتح المعرض (القشرة تمرّر مسار الفتح القائم)
    window.__genCardLiveProgress = 'click';
    card.click();
    await frames(1);
    assert(bridge.opened === 1, 'نقر البطاقة لم يستدعِ معاودة المعرض.');
    checks.push('click-opens-gallery');

    // (4) بطاقة صوت: معلومات بلا مصغرة ولا طلب genThumb (المشغّل مؤجل عمداً)
    window.__genCardLiveProgress = 'audio-card';
    chat.addGenerationCard({
      type: 'generation_done', kind: 'audio', files: ['generations/satr-theme.mp3'],
      cost_usd_estimate: 0.05, provider: 'fal', model: 'stable-audio-2.5',
    }, cwd, onOpen);
    const audioCard = document.querySelectorAll('.gen-card')[1];
    assert(audioCard, 'لم تُبنَ بطاقة الصوت.');
    assert(audioCard.textContent.includes('توليد مكتمل: صوت'), 'عنوان بطاقة الصوت ناقص.');
    assert(audioCard.textContent.includes('المشغّل المضمّن مؤجل'), 'غابت عبارة تأجيل المشغّل.');
    assert(!audioCard.querySelector('img'), 'ظهرت صورة في بطاقة الصوت.');
    assert(bridge.thumbCalls.length === 1, 'طلبت بطاقة الصوت مصغرة: ' + bridge.thumbCalls.length);
    assert(audioCard.querySelector('.work-card-state').textContent === 'fal/stable-audio-2.5', 'حالة بطاقة الصوت ناقصة.');
    checks.push('audio-card-info');

    // (5) بطاقة فيديو: معلومات بلا معاينة (تأتي لاحقاً — ج10)
    chat.addGenerationCard({
      type: 'generation_done', kind: 'video', files: ['generations/souq-aerial.mp4'],
      cost_usd_estimate: 0.35, provider: 'fal', model: 'kling-v2.1',
    }, cwd, onOpen);
    const videoCard = document.querySelectorAll('.gen-card')[2];
    assert(videoCard, 'لم تُبنَ بطاقة الفيديو.');
    assert(videoCard.textContent.includes('المعاينة المضمّنة تأتي لاحقاً'), 'غابت عبارة تأجيل معاينة الفيديو.');
    assert(!videoCard.querySelector('img'), 'ظهرت صورة في بطاقة الفيديو.');
    checks.push('video-card-info');

    // (6) تعذّر genThumb ⇒ عبارة سقوط صريحة مكان المصغرة (لا بطاقة مكسورة)
    window.__genCardLiveProgress = 'thumb-fallback';
    chat.addGenerationCard({
      type: 'generation_done', kind: 'image', files: ['generations/missing.png'],
      cost_usd_estimate: 0.003, provider: 'fal', model: 'flux-schnell',
    }, cwd, onOpen);
    const missingCard = document.querySelectorAll('.gen-card')[3];
    await waitFor(() => missingCard.textContent.includes('تعذّر تحميل المصغرة'), 'عبارة سقوط المصغرة');
    assert(bridge.thumbCalls.length === 2, 'عدد طلبات genThumb النهائي: ' + bridge.thumbCalls.length);
    checks.push('thumb-fallback');

    window.__genCardLiveProgress = 'done';
    window.__genCardLiveResult = { pass: true, checks, violations };
  } catch (error) {
    window.__genCardLiveResult = {
      pass: false,
      error: (error && error.message) || String(error),
      progress: window.__genCardLiveProgress,
      checks, violations,
    };
  }
});
