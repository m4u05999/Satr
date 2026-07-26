const violations = [];
window.__questionLiveProgress = 'loading';
let answered = null;
let nextOk = true; // يتحكّم في ما يعيده الجسر (اختبار مسار الفشل)
let deferNext = false;
let resolveDeferred = null;
// جسر مزيّف: يلتقط ما ترسله الواجهة (مؤشرات فقط) ويعيد {ok} — نفس عقد window.satr.answerQuestion.
window.satr = { answerQuestion: async (id, selections) => {
  answered = { id, selections };
  if (deferNext) {
    deferNext = false;
    return new Promise((resolve) => { resolveDeferred = resolve; });
  }
  return { ok: nextOk };
} };

window.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI });
});
function assert(cond, msg) { if (!cond) throw new Error(msg); }
// المكوّن يرسم DOM متزامناً (لا rAF داخله)، فالإطارات هنا مهلة تسوية فقط. تحت حمل
// GPU تجوع rAF في النافذة المخفية فيعلّق الاختبار (فشل بيئي مثبت 2026-07-26)؛
// مهلة الاحتياط تكافئ الانتظار بلا إسقاط أي تحقق لاحق.
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

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-question-dialog');
    const el = document.querySelector('satr-question-dialog');
    const root = el.shadowRoot;
    const submit = root.querySelector('.submit');
    const cancel = root.querySelector('.cancel');
    const msg = root.querySelector('.q-msg');

    window.__questionLiveProgress = 'ask';
    el.ask({
      id: 'live-q',
      questions: [
        { question: 'أي مسار؟', header: 'مسار', multiSelect: false,
          options: [{ label: 'ألف', description: 'الأول' }, { label: 'باء', description: 'الثاني' }] },
        { question: 'أي أدوات؟', header: 'أدوات', multiSelect: true,
          options: [{ label: 'قراءة', description: 'د' }, { label: 'كتابة', description: 'د' },
            { label: 'تنفيذ', description: 'د', preview: '<script>x</script>' }] },
      ],
    });
    await frames(3);

    assert(el.hasAttribute('open'), 'لم يفتح مربع الأسئلة.');
    assert(root.querySelectorAll('.q-item').length === 2, 'عدد الأسئلة غير متوقع.');
    assert(submit.disabled, 'الإرسال ليس معطّلاً قبل الإجابة.');
    // preview يُعرض بأمان كنص (لا حقن HTML)
    const preview = root.querySelector('.q-opt-preview');
    assert(preview && preview.textContent === '<script>x</script>' && !preview.querySelector('script'), 'preview لم يُعرض بأمان.');

    window.__questionLiveProgress = 'choose';
    const groups = [...root.querySelectorAll('.q-item')].map((it) => [...it.querySelectorAll('input')]);
    groups[0][1].checked = true; groups[0][1].dispatchEvent(new Event('change', { bubbles: true }));
    await frames(1);
    assert(submit.disabled, 'الإرسال يبقى معطّلاً والسؤال الثاني غير مُجاب.');
    groups[1][0].checked = true; groups[1][0].dispatchEvent(new Event('change', { bubbles: true }));
    groups[1][2].checked = true; groups[1][2].dispatchEvent(new Event('change', { bubbles: true }));
    await frames(1);
    assert(!submit.disabled, 'لم يُفعّل الإرسال بعد إجابة كل الأسئلة.');

    // P2-b: فشل الرد (ok:false) ⇒ يبقى الحوار مفتوحاً مع رسالة خطأ، والإجابة أُرسلت
    window.__questionLiveProgress = 'fail';
    nextOk = false;
    submit.click();
    await frames(3);
    assert(el.hasAttribute('open'), 'أُغلق الحوار رغم فشل الإرسال.');
    assert(!msg.hidden && msg.textContent.includes('تعذّر'), 'لم تظهر رسالة الفشل.');
    assert(answered && answered.id === 'live-q', 'لم تصل محاولة الإرسال.');

    // P2-b: النجاح ⇒ يُغلق ويجمع المؤشرات الصحيحة
    window.__questionLiveProgress = 'send';
    nextOk = true;
    submit.click();
    await frames(3);
    assert(!el.hasAttribute('open'), 'لم يُغلق المربع بعد نجاح الإرسال.');
    const s = answered.selections;
    assert(s.length === 2, 'عدد selections غير متوقع.');
    assert(s[0].questionIndex === 0 && JSON.stringify(s[0].optionIndexes) === '[1]', 'اختيار السؤال الأحادي غير صحيح.');
    assert(s[1].questionIndex === 1 && JSON.stringify(s[1].optionIndexes) === '[0,2]', 'اختيار السؤال المتعدد غير صحيح.');

    // P2-a: الإلغاء ⇒ إجابة فارغة (deny) + إغلاق
    window.__questionLiveProgress = 'cancel';
    answered = null;
    el.ask({ id: 'live-q2', questions: [{ question: 'س؟', header: 'ه', multiSelect: false,
      options: [{ label: 'أ', description: 'د' }, { label: 'ب', description: 'د' }] }] });
    await frames(2);
    assert(el.hasAttribute('open'), 'لم يفتح السؤال الثاني.');
    cancel.click();
    await frames(3);
    assert(!el.hasAttribute('open'), 'لم يُغلق المربع بعد الإلغاء.');
    assert(answered && answered.id === 'live-q2' && Array.isArray(answered.selections) && answered.selections.length === 0,
      'الإلغاء لم يرسل إجابة فارغة (deny).');

    // رد قديم بعد closeAll لا يغلق سؤالاً جديداً ولا يرسل notice قديماً.
    window.__questionLiveProgress = 'stale-reply';
    const notices = [];
    el.addEventListener('notice', (event) => notices.push(event.detail));
    el.ask({ id: 'live-old', questions: [{ question: 'سؤال قديم؟', header: 'قديم', multiSelect: false,
      options: [{ label: 'أ', description: 'د' }, { label: 'ب', description: 'د' }] }] });
    await frames(2);
    const oldInput = root.querySelector('.q-item input');
    oldInput.checked = true; oldInput.dispatchEvent(new Event('change', { bubbles: true }));
    deferNext = true;
    submit.click();
    await frames(2);
    assert(typeof resolveDeferred === 'function', 'لم يبدأ الرد المؤجل.');
    el.closeAll();
    el.ask({ id: 'live-new', questions: [{ question: 'سؤال جديد؟', header: 'جديد', multiSelect: false,
      options: [{ label: 'ج', description: 'د' }, { label: 'د', description: 'د' }] }] });
    await frames(2);
    assert(el.hasAttribute('open') && root.querySelector('.q-text').textContent === 'سؤال جديد؟', 'لم يظهر السؤال الجديد بعد الإغلاق.');
    resolveDeferred({ ok: true });
    await frames(3);
    assert(el.hasAttribute('open') && root.querySelector('.q-text').textContent === 'سؤال جديد؟', 'الرد القديم أغلق السؤال الجديد.');
    assert(notices.length === 0, 'الرد القديم أرسل notice بعد إبطاله.');
    cancel.click();
    await frames(3);
    assert(!el.hasAttribute('open'), 'لم يُغلق السؤال الجديد بعد اختبار الرد القديم.');

    window.__questionLiveProgress = 'free-text';
    answered = null;
    el.ask({ id: 'live-text', questions: [{ question: 'ما الرمز؟', header: 'سرّي', kind: 'text', secret: true,
      multiSelect: false, options: [] }] });
    await frames(2);
    window.__questionLiveProgress = 'free-text-rendered';
    const secretInput = root.querySelector('.q-input');
    assert(secretInput && secretInput.type === 'password', 'الحقل السرّي لا يستخدم password.');
    secretInput.value = 'قيمة سرية'; secretInput.dispatchEvent(new Event('input', { bubbles: true }));
    await frames(1);
    window.__questionLiveProgress = 'free-text-filled';
    assert(!submit.disabled, 'لم يُفعّل الإرسال بعد إدخال النص.');
    submit.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.__questionLiveProgress = 'free-text-sent';
    assert(answered && answered.selections[0].text === 'قيمة سرية', 'لم تُرسل الإجابة النصية كما هي.');
    assert(!root.querySelector('.q-input'), 'بقيت القيمة السرّية في DOM بعد الإرسال.');

    window.__questionLiveProgress = 'other-text';
    answered = null;
    el.ask({ id: 'live-other', questions: [{ question: 'اختر أو اكتب', header: 'أخرى', kind: 'choiceOther', secret: false,
      multiSelect: false, options: [{ label: 'أ', description: '' }, { label: 'ب', description: '' }] }] });
    await frames(2);
    const otherInput = root.querySelector('.q-input');
    otherInput.value = 'خيار مخصص'; otherInput.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(answered && answered.selections[0].text === 'خيار مخصص'
      && answered.selections[0].optionIndexes.length === 0, 'لم يُرسل خيار «أخرى» كنص حر.');

    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__questionLiveProgress = 'complete';
    window.__questionLiveResult = { pass: true };
  } catch (error) {
    window.__questionLiveResult = { pass: false, error: error && error.stack ? error.stack : String(error) };
  }
});
