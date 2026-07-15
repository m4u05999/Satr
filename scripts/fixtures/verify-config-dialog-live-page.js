const violations = [];
const calls = [];
const notices = [];
let created = null;
window.__verifyConfigProgress = 'loading';

window.satr = {
  verifyConfigCreate: async (cwd, commands, overwrite, confirmed) => {
    calls.push({ cwd, commands, overwrite, confirmed });
    return overwrite
      ? { ok: true, path: '.satr/verify.json', overwritten: true, created: false }
      : { ok: false, error: 'exists' };
  },
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
    await customElements.whenDefined('satr-verify-config-dialog');
    const dialog = document.querySelector('satr-verify-config-dialog');
    dialog.addEventListener('notice', (event) => notices.push(event.detail));
    dialog.addEventListener('verify-config-created', (event) => { created = event.detail; });
    dialog.open('D:\\project');
    await frames(3);
    const root = dialog.shadowRoot;
    const command = root.querySelector('.command');
    const reviewButton = root.querySelector('.review-button');
    const message = root.querySelector('.message');
    assert(dialog.hasAttribute('open') && root.querySelectorAll('.row').length === 1, 'لم يفتح المعالج بصف أمر واحد.');

    window.__verifyConfigProgress = 'reject-newline';
    command.value = 'npm test\nwhoami';
    reviewButton.click();
    await frames();
    assert(calls.length === 0 && !message.hidden && message.textContent.includes('سطر واحد'),
      'مرّر المعالج أمراً متعدد الأسطر أو استدعى IPC قبل المراجعة.');

    window.__verifyConfigProgress = 'review';
    command.value = 'node -e "console.log(\'<script>x</script>\')"';
    reviewButton.click();
    await frames();
    const preview = root.querySelector('pre');
    assert(!root.querySelector('.review').hidden && root.querySelector('.editor').hidden, 'لم ينتقل المعالج إلى المراجعة.');
    assert(preview.textContent.includes('<script>x</script>') && !preview.querySelector('script'), 'لم يُعرض JSON بأمان كنص.');
    assert(calls.length === 0, 'كتب المعالج قبل نقرة التأكيد الثانية.');

    window.__verifyConfigProgress = 'existing';
    root.querySelector('.write').click();
    await frames(3);
    assert(calls.length === 1 && calls[0].confirmed === true && calls[0].overwrite === false,
      'طلبت المحاولة الأولى overwrite أو غاب التأكيد الصريح.');
    assert(dialog.hasAttribute('open') && root.querySelector('.write').textContent.includes('استبدل'),
      'لم يبق الحوار مفتوحاً لطلب تأكيد استبدال مستقل.');
    assert(!message.hidden && message.textContent.includes('الملف موجود'), 'غاب تحذير الملف القائم.');

    window.__verifyConfigProgress = 'overwrite';
    root.querySelector('.write').click();
    await frames(3);
    assert(calls.length === 2 && calls[1].overwrite === true && calls[1].confirmed === true,
      'لم يرسل التأكيد الثاني overwrite صريحاً.');
    assert(calls[1].commands.length === 1 && calls[1].commands[0].id === 'test'
      && calls[1].commands[0].timeout_seconds === 120 && calls[1].commands[0].command.includes('<script>'),
    'غيّر المعالج المدخلات اليدوية أو اكتشف أوامر إضافية.');
    assert(!dialog.hasAttribute('open') && created && created.overwritten === true, 'لم يغلق الحوار بعد نجاح الاستبدال.');
    assert(notices.length === 1 && notices[0].includes('Git'), 'لم يوضح الإشعار ضرورة إضافة الملف إلى Git/HEAD.');
    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__verifyConfigProgress = 'complete';
    window.__verifyConfigResult = { pass: true, calls, notices };
  } catch (error) {
    window.__verifyConfigResult = { pass: false, error: error && error.stack ? error.stack : String(error), calls, violations };
  }
});
