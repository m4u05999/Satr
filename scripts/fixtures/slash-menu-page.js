'use strict';

const initialCommands = [
  { name: 'deep-research', description: 'User authored research description', argumentHint: '', aliases: [] },
  { name: 'old-plugin', description: 'Unknown plugin description\nSecond line', argumentHint: '<topic>', aliases: [] },
  { name: 'project-check', description: 'Project authored check description', argumentHint: '', aliases: [] },
  { name: 'init', description: 'Initialize a CLAUDE.md file', argumentHint: '', aliases: [] },
  { name: 're-fresh', description: 'User authored refresh description', argumentHint: '', aliases: [] },
  { name: 'design-sync', description: 'Project authored design description', argumentHint: '', aliases: [] },
];
const changedCommands = [
  { name: 'release-notes', description: 'Generate release notes from changes', argumentHint: '', aliases: [] },
  { name: 'project-check', description: 'Project authored check description', argumentHint: '', aliases: [] },
  { name: 'deep-research', description: 'User authored research description', argumentHint: '', aliases: [] },
];
const skills = [
  { name: 'project-check', source: 'project' },
  { name: 'design-sync', source: 'project' },
  { name: 'deep-research', source: 'user' },
  { name: 're-fresh', source: 'user' },
];
const satrListeners = [];
const violations = [];

localStorage.removeItem('satr_hide_user_skills');

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push(event.violatedDirective + ': ' + event.blockedURI);
});

window.satr = {
  listBgProcs: async () => [],
  killBgProc: async () => ({ ok: true }),
  listCommands: async () => ({ ok: true, commands: initialCommands }),
  listSkills: async () => skills,
  listFiles: async () => [],
  onEvent: (listener) => satrListeners.push(listener),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(message);
}

function setInput(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(input, key) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function optionCommands(menu) {
  return [...menu.querySelectorAll('.slash-item[role="option"]')].map((item) => item.dataset.command);
}

function sectionLabels(menu) {
  return [...menu.querySelectorAll('.slash-section[role="presentation"]')].map((item) => item.textContent);
}

function description(menu, command) {
  const item = [...menu.querySelectorAll('.slash-item')].find((row) => row.dataset.command === command);
  return item && item.querySelector('.desc').textContent;
}

async function run() {
  await customElements.whenDefined('satr-composer');
  const composer = document.querySelector('satr-composer');
  const input = document.getElementById('input');
  const menu = document.getElementById('slashMenu');
  const hide = document.getElementById('hideUserSkills');
  const checks = [];

  composer.setCommands([
    { cmd: '/جديدة', en: '/new', desc: 'جلسة جديدة', run: () => {} },
    { cmd: '/جلسات', en: '/sessions', desc: 'الجلسات المحفوظة', run: () => {} },
  ]);
  hide.checked = localStorage.getItem('satr_hide_user_skills') === '1';
  hide.addEventListener('change', () => {
    localStorage.setItem('satr_hide_user_skills', hide.checked ? '1' : '0');
    composer.setHideUserSkills(hide.checked);
  });
  window.satr.onEvent((event) => {
    if (event.type === 'system' && event.subtype === 'commands_changed') composer.commandsChanged(event.commands);
  });

  setInput(input, '/');
  await waitFor(() => optionCommands(menu).length === 8, 'لم تصل أوامر CLI والمهارات إلى القائمة.');
  assert(sectionLabels(menu).join('|') === 'أوامر سطر|أوامر Claude Code|مهارات المشروع|مهاراتك (من ~/.claude)',
    'ترتيب أقسام قائمة / غير صحيح.');
  assert(optionCommands(menu).join('|') === '/جديدة|/جلسات|/old-plugin|/init|/project-check|/design-sync|/deep-research|/re-fresh',
    'لم تُجمع الأوامر بحسب المصدر مع الحفاظ على ترتيب كل قسم.');
  checks.push('group-order');

  const expectedNavigation = optionCommands(menu);
  for (let index = 1; index < expectedNavigation.length; index++) {
    press(input, 'ArrowDown');
    assert(menu.querySelector('.slash-item.active').dataset.command === expectedNavigation[index],
      'دخل فاصل قسم في تنقّل ArrowDown.');
  }
  press(input, 'ArrowDown');
  assert(menu.querySelector('.slash-item.active').dataset.command === expectedNavigation[0],
    'لم يلتف تنقّل الأسهم بين العناصر القابلة للاختيار فقط.');
  press(input, 'ArrowUp');
  assert(menu.querySelector('.slash-item.active').dataset.command === expectedNavigation.at(-1),
    'دخل فاصل قسم في تنقّل ArrowUp.');
  checks.push('separators-skip-arrows');

  setInput(input, '/init');
  press(input, 'Enter');
  assert(input.value === '/init ', 'لم يُدرج Enter أمراً مضمّناً.');
  setInput(input, '/project-check');
  press(input, 'Tab');
  assert(input.value === '/project-check ', 'لم يُدرج Tab مهارة مشروع.');
  setInput(input, '/deep-research');
  press(input, 'Enter');
  assert(input.value === '/deep-research ', 'لم يُدرج Enter مهارة مستخدم.');
  checks.push('enter-tab-insertion');

  setInput(input, '/');
  assert(description(menu, '/init') === 'إنشاء ملف CLAUDE.md بتوثيق قاعدة الكود لهذا المشروع',
    'لم يُطبّق التعريب على الأمر المضمّن المعروف.');
  assert(description(menu, '/old-plugin') === 'Unknown plugin description',
    'لم يُقص الوصف الأصلي للأمر غير المعروف إلى سطر واحد.');
  assert(description(menu, '/design-sync') === 'Project authored design description'
    && description(menu, '/re-fresh') === 'User authored refresh description',
  'طُبّق قاموس الأوامر المضمّنة على مهارة محلية.');
  checks.push('builtin-localization', 'skill-descriptions');

  hide.checked = true;
  hide.dispatchEvent(new Event('change', { bubbles: true }));
  assert(localStorage.getItem('satr_hide_user_skills') === '1', 'لم يُحفظ خيار إخفاء مهارات المستخدم.');
  assert(!sectionLabels(menu).includes('مهاراتك (من ~/.claude)')
    && optionCommands(menu).includes('/project-check') && !optionCommands(menu).includes('/deep-research'),
  'أخفى المفتاح قسماً غير قسم المستخدم أو أبقى مهارات المستخدم.');
  checks.push('hide-user-skills');

  hide.checked = false;
  hide.dispatchEvent(new Event('change', { bubbles: true }));
  for (const listener of satrListeners) {
    listener({ type: 'system', subtype: 'commands_changed', commands: changedCommands });
  }
  await waitFor(() => optionCommands(menu).includes('/release-notes'), 'لم يستبدل system/commands_changed كاش الأوامر.');
  assert(!optionCommands(menu).includes('/old-plugin'), 'أُلحق الكاش الجديد بالقديم بدلاً من استبداله.');
  assert(description(menu, '/release-notes') === 'إنشاء ملاحظات إصدار موجزة من التغييرات الحالية',
    'لم يُعرّب الأمر المعروف بعد استبدال الكاش.');
  checks.push('commands-changed-replaces-cache');

  await delay(50);
  assert(violations.length === 0, 'رُصد انتهاك CSP: ' + violations.join(' | '));
  checks.push('zero-csp-violations');
  window.__slashMenuResult = { pass: true, checks, violations };
}

run().catch((error) => {
  window.__slashMenuResult = { pass: false, error: error && error.stack ? error.stack : String(error), violations };
});
