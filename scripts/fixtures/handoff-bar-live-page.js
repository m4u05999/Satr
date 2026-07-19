const violations = [];
const calls = [];
const secretCalls = [];
let stopCalls = 0;
let eventHandler = null;
let previewHandler = null;
window.__handoffLiveProgress = 'loading';

window.satr = {
  handoffDone: async (id, done) => { calls.push({ id, done }); return { ok: true }; },
  secretDone: async (id, done) => { secretCalls.push({ id, done }); return { ok: true }; },
  stop: async () => { stopCalls += 1; return { ok: true }; },
  onEvent: (callback) => { eventHandler = callback; },
  onPreview: (callback) => { previewHandler = callback; },
  previewBounds: () => {},
  previewOpen: async () => ({ ok: true }),
  previewClose: async () => ({ ok: true }),
  previewNavigate: async () => ({ ok: true }),
  previewAction: async () => ({ ok: true }),
  previewPick: async () => ({ ok: true, cancelled: true }),
  previewPickCancel: async () => ({ ok: true }),
  previewFrame: async () => ({ ok: false }),
};

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) { if (!condition) throw new Error(message); }
function frames(count = 2) {
  return new Promise((resolve) => {
    let left = count;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-preview-panel');
    const panel = document.querySelector('satr-preview-panel');
    const root = panel.shadowRoot;
    const bar = root.getElementById('pvHandoff');
    const reason = root.getElementById('hoReason');
    const done = root.getElementById('hoDone');
    const cancel = root.getElementById('hoCancel');

    // محاكاة قناة satr:event مع استعمال الواجهتين العامتين للمكوّن نفسه؛ الفحص الساكن في
    // الاختبار يربط هذا العقد بمجرى app.js الحقيقي وبـ endRun الحقيقي.
    window.satr.onEvent((event) => {
      if (event.type === 'handoff_request' && event.id) panel.showHandoff(event.id, event.reason, event.mode);
      else if (event.type === 'handoff_end') panel.hideHandoff();
    });
    const emit = (event) => eventHandler(event);
    const emitPreview = (event) => previewHandler(event);

    window.__handoffLiveProgress = 'request';
    emit({ type: 'handoff_request', id: 'ho_live_done', reason: 'سجّل دخولك إلى GitHub ثم عد' });
    await frames(3);
    assert(panel.hasAttribute('open'), 'handoff_request لم يفتح لوحة المعاينة.');
    assert(bar.classList.contains('show'), 'handoff_request لم يظهر شريط التسليم.');
    assert(reason.textContent === 'سجّل دخولك إلى GitHub ثم عد', 'نص السبب لم يظهر كما أُرسل.');
    assert(done.textContent.includes('استلمت'), 'زر «استلمت» غير موجود.');

    window.__handoffLiveProgress = 'done';
    done.click();
    await frames(2);
    assert(!bar.classList.contains('show'), 'زر «استلمت» لم يخف الشريط.');
    assert(calls.length === 1 && calls[0].id === 'ho_live_done' && calls[0].done === true,
      'زر «استلمت» لم يستدع handoffDone(id,true).');

    window.__handoffLiveProgress = 'cancel';
    emit({ type: 'handoff_request', id: 'ho_live_cancel', reason: 'أدخل رمز التحقق' });
    await frames(2);
    cancel.click();
    await frames(2);
    assert(!bar.classList.contains('show'), 'زر «إلغاء» لم يخف الشريط.');
    assert(calls.length === 2 && calls[1].id === 'ho_live_cancel' && calls[1].done === false,
      'زر «إلغاء» لم يستدع handoffDone(id,false).');

    window.__handoffLiveProgress = 'handoff-end';
    emit({ type: 'handoff_request', id: 'ho_live_end', reason: 'خطوة يدوية' });
    await frames(2);
    emit({ type: 'handoff_end', id: 'ho_live_end' });
    await frames(2);
    assert(!bar.classList.contains('show'), 'handoff_end لم يخف الشريط.');
    done.click();
    assert(calls.length === 2, 'بقي معرّف تسليم قابل للرد بعد handoff_end.');

    window.__handoffLiveProgress = 'end-run';
    emit({ type: 'handoff_request', id: 'ho_live_run', reason: 'ينتهي مع الدور' });
    await frames(2);
    panel.hideHandoff();
    await frames(2);
    assert(!bar.classList.contains('show'), 'endRun أبقى شريط التسليم ظاهراً.');
    done.click();
    assert(calls.length === 2, 'بقي معرّف تسليم قابل للرد بعد endRun.');

    window.__handoffLiveProgress = 'step';
    emit({ type: 'handoff_request', id: 'ho_live_step', mode: 'step', reason: 'أدخل رمز DNS' });
    await frames(2);
    assert(root.getElementById('hoPrefix').textContent === 'أكمل:', 'التسليم المرحلي لا يعرض «أكمل:».');
    assert(done.textContent.includes('تم'), 'زر التسليم المرحلي لا يعرض «تم».');
    done.click();
    await frames(2);
    assert(calls.length === 3 && calls[2].id === 'ho_live_step' && calls[2].done === true,
      'التسليم المرحلي لم يُحسم عبر handoffDone.');

    window.__handoffLiveProgress = 'secret';
    emitPreview({ type: 'secret_request', id: 'secret_0123456789abcdef0123456789abcdef', reason: 'مفتاح SMTP' });
    await frames(2);
    const secretBar = root.getElementById('pvSecret');
    assert(secretBar.classList.contains('show') && root.getElementById('secretReason').textContent === 'مفتاح SMTP',
      'طلب السر لم يظهر في شريط المعاينة.');
    root.getElementById('secretDone').click();
    await frames(2);
    assert(secretCalls.length === 1 && secretCalls[0].done === true && !secretBar.classList.contains('show'),
      'شريط السر لم يرسل boolean فقط أو لم يختفِ.');

    window.__handoffLiveProgress = 'trace';
    root.getElementById('pvUrl').blur();
    emitPreview({ type: 'nav', url: 'https://app.brevo.com/settings', canGoBack: false, canGoForward: false });
    emitPreview({ type: 'title', title: 'Brevo' });
    emitPreview({ type: 'agent_activity', tool: 'browser_fill_form' });
    await frames(2);
    const trace = root.getElementById('pvTaskTrace');
    assert(trace.classList.contains('show') && /Brevo/.test(root.getElementById('traceList').textContent),
      'أثر مهمة الإعداد لم يعرض الصفحة والفعل: ' + trace.className + ' / ' + root.getElementById('traceList').textContent);
    root.getElementById('traceStop').click();
    await frames(2);
    assert(stopCalls === 1, 'زر إيقاف مهمة الإعداد لم يستدع stop.');

    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__handoffLiveProgress = 'complete';
    window.__handoffLiveResult = { pass: true, calls, secretCalls, stopCalls, violations };
  } catch (error) {
    window.__handoffLiveResult = {
      pass: false,
      error: error && error.stack ? error.stack : String(error),
      calls,
      secretCalls,
      stopCalls,
      violations,
    };
  }
});
