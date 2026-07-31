const violations = [];
const configCalls = [];
const skillCalls = [];
const notices = [];
let created = null;
window.__verifyConfigProgress = 'loading';

window.satr = {
  verifyConfigCreate: async (cwd, commands, overwrite, confirmed, reviewSkill) => {
    configCalls.push({ cwd, commands, overwrite, confirmed, reviewSkill });
    return overwrite
      ? { ok: true, path: '.satr/verify.json', overwritten: true, created: false }
      : { ok: false, error: 'exists' };
  },
  reviewSkillCreate: async (cwd, skill, overwrite, confirmed) => {
    skillCalls.push({ cwd, skill, overwrite, confirmed });
    if (skill.criteria.includes('api_key=')) return { ok: false, error: 'secret' };
    return overwrite
      ? { ok: true, path: '.agents/skills/' + skill.name + '/SKILL.md', overwritten: true, created: false }
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
    const includeSkill = root.querySelector('.include-skill');
    const skillName = root.querySelector('.skill-name');
    const skillCriteria = root.querySelector('.criteria');
    const defaultCriteria = skillCriteria.value;
    const message = root.querySelector('.message');
    assert(dialog.hasAttribute('open') && root.querySelectorAll('.row').length === 1, 'لم يفتح المعالج بصف أمر واحد.');

    window.__verifyConfigProgress = 'reject-newline';
    command.value = 'npm test\nwhoami';
    reviewButton.click();
    await frames();
    assert(configCalls.length === 0 && skillCalls.length === 0 && !message.hidden && message.textContent.includes('سطر واحد'),
      'مرّر المعالج أمراً متعدد الأسطر أو استدعى IPC قبل المراجعة.');

    window.__verifyConfigProgress = 'bad-skill-name';
    command.value = 'node -e "console.log(\'<script>x</script>\')"';
    skillName.value = '../escape';
    includeSkill.click();
    await frames();
    assert(configCalls.length === 0 && skillCalls.length === 0 && !message.hidden && message.textContent.includes('اسم المهارة'),
      'مرّر المعالج اسم مهارة فاسداً أو استدعى IPC له.');

    window.__verifyConfigProgress = 'bad-skill-criteria';
    skillName.value = 'quality-review';
    skillCriteria.value = 'x'.repeat((16 * 1024) + 1);
    includeSkill.click();
    await frames();
    assert(configCalls.length === 0 && skillCalls.length === 0 && !message.hidden && message.textContent.includes('16KiB'),
      'مرّر المعالج معايير تتجاوز السقف أو استدعى IPC لها.');

    window.__verifyConfigProgress = 'review-with-skill';
    skillCriteria.value = 'راجع الجودة.\napi_key=abcdefghijklmnop-secret';
    includeSkill.click();
    await frames();
    const preview = root.querySelector('pre');
    assert(!root.querySelector('.review').hidden && root.querySelector('.editor').hidden, 'لم ينتقل المعالج إلى المراجعة.');
    assert(preview.textContent.includes('<script>x</script>') && !preview.querySelector('script'), 'لم يُعرض JSON بأمان كنص.');
    assert(preview.textContent.includes('"review_skill"') && preview.textContent.includes('"quality-review"'),
      'لم يعرض المعالج مرجع مهارة المراجعة داخل JSON.');
    assert(configCalls.length === 0 && skillCalls.length === 0, 'كتب المعالج قبل مراجعة JSON ونقرة الكتابة المستقلة.');

    window.__verifyConfigProgress = 'reject-secret';
    root.querySelector('.create-skill').click();
    await frames(3);
    assert(skillCalls.length === 1 && skillCalls[0].confirmed === true && skillCalls[0].overwrite === false,
      'غاب التأكيد الصريح للمحاولة الأولى لإنشاء المهارة.');
    assert(!message.hidden && message.textContent.includes('سر'), 'لم يعرض المعالج رفض حارس الأسرار.');
    assert(configCalls.length === 0, 'كتب verify.json أثناء رفض سر المهارة.');

    window.__verifyConfigProgress = 'existing-skill';
    root.querySelector('.back').click();
    skillCriteria.value = defaultCriteria;
    includeSkill.click();
    await frames();
    root.querySelector('.create-skill').click();
    await frames(3);
    assert(skillCalls.length === 2 && skillCalls[1].confirmed === true && skillCalls[1].overwrite === false,
      'طلبت محاولة المهارة الأولى overwrite أو غاب التأكيد الصريح.');
    assert(dialog.hasAttribute('open') && root.querySelector('.create-skill').textContent.includes('استبدل'),
      'لم يبق الحوار مفتوحاً لتأكيد استبدال المهارة مستقلاً.');

    window.__verifyConfigProgress = 'overwrite-skill';
    root.querySelector('.create-skill').click();
    await frames(3);
    assert(skillCalls.length === 3 && skillCalls[2].overwrite === true && skillCalls[2].confirmed === true,
      'لم يرسل تأكيد استبدال المهارة overwrite صريحاً.');
    assert(skillCalls[2].skill.name === 'quality-review' && skillCalls[2].skill.criteria === defaultCriteria,
      'غيّر المعالج مسودة المهارة قبل إرسالها.');
    assert(root.querySelector('.create-skill').disabled && message.dataset.kind === 'success',
      'لم يثبت المعالج نجاح كتابة المهارة مع إبقاء كتابة JSON مستقلة.');

    window.__verifyConfigProgress = 'existing';
    root.querySelector('.write').click();
    await frames(3);
    assert(configCalls.length === 1 && configCalls[0].confirmed === true && configCalls[0].overwrite === false,
      'طلبت المحاولة الأولى overwrite أو غاب التأكيد الصريح.');
    assert(dialog.hasAttribute('open') && root.querySelector('.write').textContent.includes('استبدل'),
      'لم يبق الحوار مفتوحاً لطلب تأكيد استبدال مستقل.');
    assert(!message.hidden && message.textContent.includes('الملف موجود'), 'غاب تحذير الملف القائم.');

    window.__verifyConfigProgress = 'overwrite';
    root.querySelector('.write').click();
    await frames(3);
    assert(configCalls.length === 2 && configCalls[1].overwrite === true && configCalls[1].confirmed === true,
      'لم يرسل التأكيد الثاني overwrite صريحاً.');
    assert(configCalls[1].commands.length === 1 && configCalls[1].commands[0].id === 'test'
      && configCalls[1].commands[0].timeout_seconds === 120 && configCalls[1].commands[0].command.includes('<script>'),
    'غيّر المعالج المدخلات اليدوية أو اكتشف أوامر إضافية.');
    assert(configCalls[1].reviewSkill && configCalls[1].reviewSkill.name === 'quality-review',
      'لم يمرّر المعالج كائن reviewSkill المنقّى في المعامل الخامس.');
    assert(!dialog.hasAttribute('open') && created && created.overwritten === true, 'لم يغلق الحوار بعد نجاح الاستبدال.');
    assert(notices.length === 2 && notices.every((notice) => notice.includes('Git')), 'لم توضح الإشعارات ضرورة إضافة الملفين إلى Git/HEAD.');
    assert(violations.length === 0, 'رُصد securitypolicyviolation.');
    window.__verifyConfigProgress = 'complete';
    window.__verifyConfigResult = { pass: true, configCalls, skillCalls, notices };
  } catch (error) {
    window.__verifyConfigResult = { pass: false, error: error && error.stack ? error.stack : String(error), configCalls, skillCalls, violations };
  }
});
