const violations = [];
const checks = [];
const starts = [];
const killed = [];
const shells = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\cmd.exe',
  '/bin/bash',
];
let nextTerminal = 0;
let termListener = () => {};
window.__terminalTabsProgress = 'loading';

localStorage.clear();
window.satr = {
  termStart: async () => {
    const index = nextTerminal++;
    const result = { ok: true, id: `term_${index + 1}`, shell: shells[index] || '/bin/bash' };
    starts.push(result);
    return result;
  },
  termInput: () => {},
  termResize: () => {},
  termKill: async (id) => { killed.push(id); },
  onTerm: (listener) => { termListener = listener; },
};

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
    sourceFile: event.sourceFile,
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`انتهت مهلة الانتظار: ${label}.`);
}

function tabElements() {
  return [...document.querySelectorAll('.term-tab')];
}

function tabLabels() {
  return tabElements().map((tab) => tab.querySelector('.term-tab-label')?.textContent || '');
}

function press(element, key) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function emit(id, type, data = '') {
  termListener({ id, type, data });
}

function emitTitle(id, title) {
  emit(id, 'data', `\x1b]0;${title}\x07`);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-terminal-panel');
    const panel = document.querySelector('satr-terminal-panel');
    panel.setTermOpen(true);
    await waitFor(() => starts.length === 1 && tabElements().length === 1, 'فتح تبويب pwsh');
    await waitFor(() => tabLabels()[0] === 'pwsh', 'اشتقاق اسم pwsh');
    assert(tabElements()[0].getAttribute('role') === 'tab' && tabElements()[0].tabIndex === 0,
      'التبويب غير قابل للوصول بلوحة المفاتيح.');
    checks.push('derived-shell-name', 'keyboard-tab');

    document.getElementById('termNew').click();
    await waitFor(() => starts.length === 2 && tabElements().length === 2, 'فتح تبويب cmd');
    await waitFor(() => tabLabels()[1] === 'cmd', 'اشتقاق اسم cmd');
    const secondTabBeforeTitle = tabElements()[1];
    const unsafeTitle = `مشروع\u0001\u202e\u2066${'س'.repeat(60)}`;
    const expectedTitle = Array.from(unsafeTitle.replace(/[\u0001\u202e\u2066]/g, '')).slice(0, 40).join('');
    emitTitle(starts[1].id, 'عنوان أول');
    emitTitle(starts[1].id, 'عنوان ثانٍ');
    emitTitle(starts[1].id, unsafeTitle);
    await waitFor(() => tabLabels()[1] === expectedTitle, 'تحديث OSC المنقّى والمقصوص');
    assert(Array.from(tabLabels()[1]).length === 40, 'لم يُطبَّق سقف عنوان OSC البالغ 40 محرفاً.');
    assert(!/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(tabLabels()[1]),
      'بقي محرف تحكم أو اتجاه في اسم التبويب.');
    assert(tabElements()[1] === secondTabBeforeTitle, 'أعاد OSC بناء شريط التبويبات بدلاً من تحديث الاسم فقط.');
    checks.push('osc-sanitized', 'osc-truncated', 'title-throttled');

    let firstTab = tabElements()[0];
    firstTab.focus();
    assert(document.activeElement === firstTab, 'تعذّر تركيز التبويب بلوحة المفاتيح.');
    press(firstTab, 'F2');
    const renameInput = firstTab.querySelector('.term-tab-name-input');
    assert(renameInput && document.activeElement === renameInput, 'لم يفتح F2 حقل إعادة التسمية.');
    renameInput.value = 'مشروعي';
    press(renameInput, 'Enter');
    assert(tabLabels()[0] === 'مشروعي', 'لم يحفظ Enter الاسم اليدوي.');
    emitTitle(starts[0].id, 'عنوان يجب ألا يدوس الاسم اليدوي');
    await delay(250);
    assert(tabLabels()[0] === 'مشروعي', 'داس عنوان OSC الاسم اليدوي.');
    assert(tabLabels()[1] === expectedTitle, 'تسرّب اسم التبويب الأول إلى الثاني.');
    checks.push('keyboard-rename', 'manual-priority', 'isolated-names');

    let secondTab = tabElements()[1];
    secondTab.focus();
    press(secondTab, 'Enter');
    assert(secondTab.classList.contains('active'), 'لم يفعّل Enter التبويب الثاني.');
    firstTab = tabElements()[0];
    firstTab.focus();
    press(firstTab, ' ');
    firstTab = tabElements()[0];
    assert(firstTab.classList.contains('active') && tabLabels()[0] === 'مشروعي',
      'لم يثبت الاسم اليدوي بعد التبديل بين التبويبات.');

    document.getElementById('termRestart').click();
    await waitFor(() => starts.length === 3, 'إعادة تشغيل الصدفة');
    await waitFor(() => tabLabels()[0] === 'مشروعي', 'ثبات الاسم بعد إعادة التشغيل');
    assert(killed.includes('term_1'), 'لم تستخدم إعادة التشغيل جلسة التبويب النشط المتوقعة.');
    emit(starts[2].id, 'exit');
    await waitFor(() => tabElements()[0].classList.contains('dead'), 'خروج الصدفة');
    assert(tabLabels()[0] === 'مشروعي', 'تغيّر الاسم بعد خروج الصدفة.');
    checks.push('stable-switch-restart-exit');

    panel.adoptModelTerm('model_term_1', '/bin/bash');
    await waitFor(() => tabLabels().includes('🤖 النموذج'), 'تبويب النموذج');
    emitTitle('model_term_1', 'عنوان نموذج غير موثوق');
    await delay(250);
    const modelTab = tabElements().find((tab) => tab.querySelector('.term-tab-label')?.textContent === '🤖 النموذج');
    assert(modelTab && !modelTab.querySelector('.trename'), 'تبويب النموذج قابل لإعادة التسمية خلاف العقد.');
    modelTab.focus();
    press(modelTab, 'F2');
    assert(!modelTab.querySelector('.term-tab-name-input'), 'فتح F2 إعادة تسمية لتبويب النموذج.');
    assert(tabLabels().includes('مشروعي') && tabLabels().includes(expectedTitle), 'تسرّبت الأسماء بعد إضافة تبويب النموذج.');
    assert(localStorage.length === 0, 'حُفظ اسم التبويب خارج عمر الجلسة.');
    assert(violations.length === 0, 'رُصد securitypolicyviolation أثناء اختبار التبويبات.');
    checks.push('model-tab-distinct', 'session-only', 'zero-csp-violations');

    window.__terminalTabsProgress = 'complete';
    window.__terminalTabsResult = { pass: true, checks, violations, labels: tabLabels() };
  } catch (error) {
    window.__terminalTabsResult = {
      pass: false,
      checks,
      violations,
      error: error && error.stack ? error.stack : String(error),
    };
  }
});
