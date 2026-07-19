const violations = [];
const killedTerms = [];
const permissions = [];
let termListener = () => {};

window.satr = {
  termStart: async () => ({ ok: true, id: 'term_1', shell: 'powershell.exe' }),
  termInput: () => {}, termResize: () => {},
  termKill: async (id) => { killedTerms.push(id); return { ok: true }; },
  onTerm: (listener) => { termListener = listener; },
  listBgProcs: async () => [], killBgProc: async () => ({ ok: true }),
  listFiles: async () => [], listCommands: async () => [], listSkills: async () => [],
  permission: async (id, allow, always, turn) => { permissions.push({ id, allow, always, turn }); return { ok: true }; },
};

window.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const frames = (count = 2) => new Promise((resolve) => {
  const next = () => { if (--count <= 0) resolve(); else requestAnimationFrame(next); };
  requestAnimationFrame(next);
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await Promise.all([
      customElements.whenDefined('satr-terminal-panel'),
      customElements.whenDefined('satr-composer'),
      customElements.whenDefined('satr-perm-dialog'),
    ]);
    const terminal = document.querySelector('satr-terminal-panel');
    const composer = document.querySelector('satr-composer');
    const permission = document.querySelector('satr-perm-dialog');
    const event = { type: 'bg_term', id: 'term_9', label: 'خادم الواجهة', shell: 'powershell.exe', cwd: 'D:\\project' };
    terminal.adoptTerm(event.id, event.label, { shell: event.shell, cwd: event.cwd, isJob: true, buffer: 'READY\r\n', open: true });
    composer.upsertTermJob({ ...event, startedAt: Date.now() });
    await frames(4);
    const tabs = [...document.querySelectorAll('.term-tab')];
    assert(tabs.length === 1 && tabs[0].textContent.includes('🛠 خادم الواجهة'), 'لم يظهر تبويب المهمة الموسوم.');
    const chip = document.querySelector('.bg-chip.job');
    assert(chip && chip.textContent.includes('خادم الواجهة'), 'لم تظهر chip المهمة.');
    composer.addEventListener('show-term', (showEvent) => terminal.activateTerm(showEvent.detail));
    chip.querySelector('.show').click();
    assert(document.querySelector('.term-tab.active'), 'زر إظهار لم ينشّط التبويب.');
    chip.querySelector('.kill').click();
    await frames(2);
    assert(killedTerms.includes('term_9'), 'زر الإيقاف لم يستدع termKill.');

    permission.request({ id: 'p1', tool: 'Edit', detail: 'a', requester: 'agent-2', turnEligible: true });
    permission.request({ id: 'p2', tool: 'Read', detail: 'b', turnEligible: true });
    permission.request({ id: 'p3', tool: 'Bash', detail: 'c', turnEligible: false });
    await frames(2);
    const root = permission.shadowRoot;
    assert(root.querySelector('.pending-count').textContent === 'وبعده 2 طلبات معلّقة', 'عداد الطابور غير صحيح.');
    assert(root.querySelector('.requester').textContent.includes('agent-2'), 'سياق الطالب غير ظاهر.');
    assert(!root.querySelector('.turn').hidden, 'خيار نطاق الدور غير ظاهر للأداة المؤهلة.');
    root.querySelector('.turn').click();
    await frames(2);
    assert(permissions[0] && permissions[0].turn === true, 'لم يُرسل نطاق الدور إلى الجسر.');
    assert(root.querySelector('.pending-count').textContent === 'وبعده 1 طلبات معلّقة', 'لم يتقدم الطابور بطلب واحد.');

    window.__backgroundUiResult = { pass: true, violations };
  } catch (error) {
    window.__backgroundUiResult = { pass: false, error: error.message, violations };
  }
});
