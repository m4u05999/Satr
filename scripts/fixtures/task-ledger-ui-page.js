const violations = [];
const actions = [];
const checks = [];

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function task(id, title, status, dependencies = [], owner = '', evidence = []) {
  return { id, title, status, dependencies, owner, evidence };
}

function snapshot(overrides = {}) {
  return {
    schema_version: 1,
    engine: 'sdk',
    session_id: 'session-a',
    revision: 1,
    state: 'active',
    tasks: [],
    ...overrides,
  };
}

function text(selector, root = document) {
  const element = root.querySelector(selector);
  return element ? element.textContent.trim() : '';
}

localStorage.removeItem('satr_ledger_collapsed');

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-chat');
    const chat = document.querySelector('satr-chat');
    chat.addEventListener('task-action', (event) => actions.push(event.detail));

    const seedTasks = [
      task('seed-1', 'مهمة أولى', 'pending'),
      task('seed-2', 'مهمة ثانية', 'in_progress'),
      task('seed-3', 'مهمة ثالثة', 'completed'),
    ];
    chat.showTaskLedger(snapshot({ tasks: seedTasks }));
    assert(document.querySelectorAll('.task-ledger').length === 1, 'يجب أن تظهر البطاقة عند ثلاث مهام.');
    chat.showTaskLedger(snapshot({ revision: 2, tasks: seedTasks.slice(0, 2) }));
    assert(document.querySelectorAll('.task-ledger').length === 0, 'يجب أن تزيل عتبة أقل من ثلاث مهام البطاقة القائمة.');
    checks.push('three-task-threshold');

    const activeTasks = [
      task('pending', 'مهمة معلقة', 'pending', [], 'المخطط'),
      task('working', 'تنفيذ التغيير', 'in_progress', ['pending'], 'Claude SDK', [
        { kind: 'test', text: 'npm run test:task-ledger-ui' },
        { kind: 'artifact', text: 'لقطة Chromium ناجحة' },
      ]),
      task('done', 'تحقق مكتمل', 'completed', [], 'المراجع'),
      task('blocked', 'مهمة محجوبة', 'blocked', ['working', 'done'], 'Codex', [
        { kind: 'note', text: 'ينتظر قرار المالك' },
      ]),
    ];
    chat.showTaskLedger(snapshot({ revision: 3, tasks: activeTasks }));
    let ledger = document.querySelector('.task-ledger');
    assert(ledger && document.querySelectorAll('.task-ledger').length === 1, 'يجب بناء بطاقة سجل واحدة.');
    const progress = ledger.querySelector('.task-ledger-progress-text');
    assert(progress && progress.textContent === '1/4' && progress.getAttribute('dir') === 'ltr',
      'يجب عرض التقدم completed/total باتجاه LTR.');
    assert(text('.task-ledger-state', ledger) === 'قيد العمل', 'يجب تعريب حالة الخطة النشطة.');
    checks.push('progress-and-state');

    const expectedStatuses = [
      ['pending', '○'],
      ['in_progress', '●'],
      ['completed', '✓'],
      ['blocked', '⚠'],
    ];
    const items = [...ledger.querySelectorAll('.task-item')];
    assert(items.length === expectedStatuses.length, 'يجب رسم المهام الأربع.');
    expectedStatuses.forEach(([status, icon], index) => {
      assert(items[index].classList.contains(`status-${status}`), `غاب تمييز الحالة ${status}.`);
      assert(text('.task-status-icon', items[index]) === icon, `أيقونة الحالة ${status} غير صحيحة.`);
    });
    checks.push('all-statuses');

    assert(text('.task-owner', items[1]) === 'Claude SDK', 'يجب رسم مالك المهمة كما ورد.');
    assert(text('.task-dependencies', items[1]) === 'يعتمد على: pending', 'يجب رسم اعتماد واحد بصيغته الفعلية.');
    assert(text('.task-dependencies', items[3]) === 'يعتمد على: working، done', 'يجب فصل الاعتماديات المتعددة بالفاصلة العربية.');
    assert(text('.task-evidence summary', items[1]) === 'دليل التحقق (2)', 'يجب عرض عدد أدلة التحقق.');
    assert(JSON.stringify([...items[1].querySelectorAll('.task-evidence li')].map((item) => item.textContent))
      === JSON.stringify(['npm run test:task-ledger-ui', 'لقطة Chromium ناجحة']), 'يجب رسم نصوص أدلة التحقق.');
    assert([...items[1].querySelectorAll('.task-evidence li')].every((item) => item.getAttribute('dir') === 'auto'),
      'يجب أن تكون أدلة التحقق ذات اتجاه تلقائي.');
    checks.push('task-metadata');

    let toggle = ledger.querySelector('.task-ledger-toggle');
    assert(ledger.classList.contains('collapsed') && toggle.textContent === '▸'
      && toggle.getAttribute('aria-expanded') === 'false', 'يجب أن يبدأ السجل مطوياً.');
    toggle.click();
    assert(!ledger.classList.contains('collapsed') && toggle.textContent === '▾'
      && toggle.getAttribute('aria-expanded') === 'true', 'يجب أن يوسّع زر الطي السجل ويحدّث aria-expanded.');
    assert(localStorage.getItem('satr_ledger_collapsed') === '0', 'يجب حفظ حالة التوسيع.');
    toggle.click();
    assert(ledger.classList.contains('collapsed') && toggle.textContent === '▸'
      && toggle.getAttribute('aria-expanded') === 'false', 'يجب أن يعيد الزر طي السجل.');
    assert(localStorage.getItem('satr_ledger_collapsed') === '1', 'يجب حفظ حالة الطي.');
    checks.push('collapse-persistence');

    let action = ledger.querySelector('.task-ledger-action');
    assert(action && action.textContent === '⏸ إيقاف الخطة', 'يجب عرض فعل إيقاف الخطة النشطة.');
    action.click();
    assert(JSON.stringify(actions[0]) === JSON.stringify({ action: 'pause', engine: 'sdk', sessionId: 'session-a' }),
      'يجب بث حدث pause بعقده الكامل.');

    const pausedTasks = [
      task('pending', 'مهمة معلقة منقحة', 'completed', [], 'المخطط'),
      task('working', 'تنفيذ محدث', 'in_progress', ['pending'], 'Claude SDK', [{ kind: 'test', text: 'نجح التحديث' }]),
      task('done', 'تحقق مكتمل', 'completed', [], 'المراجع'),
      task('blocked', 'مهمة محجوبة', 'blocked', ['working'], 'Codex'),
    ];
    chat.showTaskLedger(snapshot({ revision: 4, state: 'paused', tasks: pausedTasks }));
    ledger = document.querySelector('.task-ledger');
    assert(ledger.classList.contains('state-paused') && text('.task-ledger-state', ledger) === 'متوقفة',
      'يجب أن يعيد snapshot الأعلى بناء حالة paused.');
    assert(text('.task-ledger-progress-text', ledger) === '2/4', 'يجب تحديث التقدم بعد snapshot أعلى.');
    assert(text('.task-title', ledger) === 'مهمة معلقة منقحة' && !ledger.textContent.includes('تنفيذ التغيير'),
      'يجب استبدال محتوى snapshot السابق بالكامل.');
    const rebuiltItems = [...ledger.querySelectorAll('.task-item')];
    expectedStatuses.forEach(([status], index) => {
      const actualStatus = ['completed', 'in_progress', 'completed', 'blocked'][index];
      assert(rebuiltItems[index].classList.contains(`status-${actualStatus}`), `فشل تحديث حالة المهمة ${index}.`);
    });
    checks.push('higher-revision-rebuild');

    action = ledger.querySelector('.task-ledger-action');
    assert(action && action.textContent === '▶ استئناف الخطة', 'يجب عرض فعل استئناف الخطة المتوقفة.');
    action.click();
    assert(JSON.stringify(actions[1]) === JSON.stringify({ action: 'resume', engine: 'sdk', sessionId: 'session-a' }),
      'يجب بث حدث resume بعقده الكامل.');

    chat.showTaskLedger(snapshot({ revision: 5, state: 'completed', tasks: pausedTasks.map((entry) => ({ ...entry, status: 'completed' })) }));
    ledger = document.querySelector('.task-ledger');
    assert(ledger.classList.contains('state-completed') && text('.task-ledger-state', ledger) === 'مكتملة',
      'يجب تعريب حالة الخطة المكتملة وتمييزها.');
    assert(!ledger.querySelector('.task-ledger-action'), 'يجب ألا تعرض الخطة المكتملة زر فعل.');
    checks.push('pause-resume-complete');

    const nextSessionTasks = [
      task('new-1', 'مهمة جلسة Codex الأولى', 'pending'),
      task('new-2', 'مهمة جلسة Codex الثانية', 'in_progress'),
      task('new-3', 'مهمة جلسة Codex الثالثة', 'completed'),
    ];
    chat.showTaskLedger(snapshot({ engine: 'codex', session_id: 'session-b', revision: 1, tasks: nextSessionTasks }));
    assert(document.querySelectorAll('.task-ledger').length === 1, 'يجب ألا تتكدس بطاقات الجلسات.');
    ledger = document.querySelector('.task-ledger');
    assert(ledger.textContent.includes('مهمة جلسة Codex الأولى') && !ledger.textContent.includes('مهمة معلقة منقحة'),
      'يجب أن تستبدل الجلسة الجديدة البطاقة القديمة.');
    checks.push('session-replacement');

    chat.clearTaskLedger();
    assert(!document.querySelector('.task-ledger'), 'يجب أن تزيل clearTaskLedger البطاقة.');
    checks.push('public-clear');

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    checks.push('zero-csp-violations');
    window.__taskLedgerUiResult = { pass: true, checks, actions, violations };
  } catch (error) {
    window.__taskLedgerUiResult = {
      pass: false,
      error: error && error.stack ? error.stack : String(error),
      checks,
      actions,
      violations,
    };
  }
});
