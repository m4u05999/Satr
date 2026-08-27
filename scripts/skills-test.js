#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const skills = require('../electron/skills');
const tools = require('../electron/tools');
const ROOT = path.resolve(__dirname, '..');

async function runLiveProbe(engineName, project) {
  const marker = 'SATR_SKILL_LIVE_OK_7F3A';
  await write(project, '.agents/skills/satr-live-probe/SKILL.md', [
    '---',
    'name: satr-live-probe',
    'description: مهارة اختبار حي لعقد التحميل المحمول',
    '---',
    'عند استدعاء هذه المهارة أجب في الإجابة النهائية بالرمز التالي فقط:',
    marker,
    '',
  ].join('\n'));
  const engine = engineName === 'codex' ? require('../electron/codex') : require('../electron/agent');
  const texts = [];
  const diagnostics = [];
  let result = null;
  let handle = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => {
    if (handle && handle.stop) handle.stop().catch(() => {});
    finish();
  }, 180000);
  handle = await engine.start({
    prompt: 'استخدم مهارة satr-live-probe ونفّذ تعليماتها بدقة.',
    images: [],
    sessionId: null,
    model: engineName === 'codex' ? (process.env.SATR_EVAL_CODEX_MODEL || 'gpt-5.6-sol') : null,
    permissionMode: 'plan',
    skills: ['satr-live-probe'],
    effort: 'low',
    extraDirs: [],
    browserControl: false,
  }, project, (event) => {
    if (event.type === 'stream_text' && event.phase !== 'commentary') texts.push(event.text || '');
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) if (block.type === 'text' && block.phase !== 'commentary') texts.push(block.text || '');
    }
    if (event.type === 'permission_request' && handle && handle.resolvePermission) {
      handle.resolvePermission(event.id, false, false);
    }
    if (event.type === 'result') result = event;
    if (event.type === 'spawn_error' || event.type === 'stderr') diagnostics.push(String(event.text || '').slice(0, 1000));
    if (event.type === 'proc_done') finish();
  });
  await done;
  clearTimeout(timer);
  assert(result && !result.is_error, 'فشل الدور الحي لمحرك ' + engineName + ': ' + diagnostics.join(' | ') + ' text=' + texts.join(' | ').slice(0, 2000) + ' result=' + JSON.stringify(result));
  assert(texts.join('\n').includes(marker), 'لم يطبق ' + engineName + ' المهارة المحمولة');
  console.log('✓ live ' + engineName + ' portable skill');
}

async function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

// satr-accept: بروتوكول القبول البشري. الحارس يمنع سقوطها من BUILTIN_SKILLS أو من
// قائمتَي الحزمة (وحينها لا تصل المستخدمين بصمت)، ويثبت أن قواعدها الملزمة ما زالت
// في النص — لأن حذف «هو ينقر لا أنت» أو حدود «متى لا تُستعمل» يحوّلها إلى طقس.
async function assertSatrAccept(discoveryOptions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(manifest.build.files.includes('.agents/skills/satr-accept/**/*'),
    'satr-accept خارج build.files — لن تصل الحزمة');
  assert(manifest.build.asarUnpack.includes('.agents/skills/satr-accept/**/*'),
    'satr-accept خارج asarUnpack — حصر الموارد يعتمد realpathSync');

  const catalog = skills.discoverSkills(ROOT, discoveryOptions);
  const skill = catalog.find((item) => item.name === 'satr-accept');
  assert(skill, 'مهارة satr-accept المضمّنة غير مكتشفة');
  assert.strictEqual(skill.source, 'project');
  assert.strictEqual(skill.format, 'standard');
  // الوصف هو ما يقرّر متى تُحمَّل — يجب أن يحمل المُشغّل والحدّ معاً
  assert(skill.description.includes('صواب/فشل'), 'الوصف بلا معيار القبول');
  assert(skill.description.includes('لا تستعملها'), 'الوصف بلا حدّ الاستعمال');
  // الترس الأوسط عديم الفائدة إن لم يذكره الوصف: هو ما يقرّر التحميل، وحدّ «دفعة من
  // سطرين» كان سيصرف الوكيل عن التحميل في الحالة نفسها التي يخدمها الترس (OBS-055).
  assert(skill.description.includes('فحص مصغّر'), 'الوصف بلا الترس الأوسط — لن يُحمَّل حيث يلزم');

  const selected = skills.resolveSelection(ROOT, ['satr-accept'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-accept');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## قواعد ملزمة'));
  assert(loaded.instructions.includes('## متى **لا** تُستعمل'));
  assert(loaded.instructions.includes('**هو ينقر، لا أنت.**'), 'سقطت قاعدة «هو ينقر لا أنت»');
  assert(loaded.instructions.includes('خطوة واحدة حاسمة'), 'سقطت قاعدة حسم التعارض');
  assert(loaded.instructions.includes('نظّف بعدها'));
  // الترس الأوسط (OBS-055): شروطه الثلاثة هي ما يمنعه من الانفلات إلى بديل رخيص عن
  // البروتوكول. سقوط الشرط «بلا بناء» أو تبعية «هو ينقر» يحوّله إلى إذنٍ بالاستنتاج.
  assert(loaded.instructions.includes('## الترس الأوسط — فحص مصغّر'), 'سقط الترس الأوسط');
  assert(loaded.instructions.includes('الادعاء المتبقي واحد'), 'الفحص المصغّر بلا شرط الادعاء المفرد');
  assert(loaded.instructions.includes('بلا بناء'), 'الفحص المصغّر بلا شرط «نسخة عاملة بلا بناء»');
  assert(loaded.instructions.includes('**هو ينقر لا أنت**'), 'الفحص المصغّر لا يعيد تثبيت قاعدة النقر');
  const resources = loaded.resources.map((item) => item.path);
  assert(resources.includes('example.md'), 'المثال الحيّ غير مُدرَج ضمن الموارد');

  const example = skills.readResource(selected, 'satr-accept', 'example.md');
  assert.strictEqual(example.ok, true);
  assert(example.content.includes('ERR_STREAM_WRITE_AFTER_END'), 'المثال بلا العطل المكتشَف');
  assert(example.content.includes('أخطاء ارتكبتُها'), 'المثال يعرض النتائج بلا أخطاء المنفّذ');

  const toolLoaded = await tools.run('load_skill', ROOT, { name: 'satr-accept' }, { skillContext: selected });
  assert.strictEqual(toolLoaded.ok, true);
  assert(toolLoaded.content.includes('## قواعد ملزمة'));
}

// satr-design-ar: خبرة واجهات الحرف العربي محمولةً إلى مشاريع المستخدمين.
//
// **الحارس الجوهري هنا هو المحمولية** (‏OBS-060): المهارة تعمل داخل مشروع المستخدم حيث
// لا وجود لـ`docs/` ولا `electron/` ولا `npm run test:*` الخاصة بنا. الإحالة إلى مسار
// غائب أسوأ من السكوت — كلّفت جلسةً 1014 ثانية و‏$13.77 حين بحث الوكيل عن ملف لا وجود
// له ثم ارتجل. فأي تسريب مسار من مستودعنا إلى نصّ المهارة أو مواردها يفشل هنا.
const REPO_LEAKS = Object.freeze([
  [/\bdocs\/[A-Za-z0-9_.-]+/, 'مسار docs/ من مستودعنا'],
  [/\belectron\/[A-Za-z0-9_.-]+/, 'مسار electron/ من مستودعنا'],
  [/\bscripts\/[A-Za-z0-9_.-]+/, 'مسار scripts/ من مستودعنا'],
  [/\bsrc\/ui\/[A-Za-z0-9_./-]+/, 'مسار src/ui/ من مستودعنا'],
  [/\bOBS-\d+/, 'معرّف ملاحظة داخلية'],
  [/\bCLAUDE\.md\b/, 'CLAUDE.md'],
  [/\bAGENTS\.md\b/, 'AGENTS.md'],
  [/npm run (?:test|gen):[A-Za-z-]+/, 'سكربت npm خاص بمستودعنا'],
]);

async function assertSatrDesignAr(discoveryOptions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(manifest.build.files.includes('.agents/skills/satr-design-ar/**/*'),
    'satr-design-ar خارج build.files — لن تصل الحزمة');
  assert(manifest.build.asarUnpack.includes('.agents/skills/satr-design-ar/**/*'),
    'satr-design-ar خارج asarUnpack — حصر الموارد يعتمد realpathSync');

  const catalog = skills.discoverSkills(ROOT, discoveryOptions);
  const skill = catalog.find((item) => item.name === 'satr-design-ar');
  assert(skill, 'مهارة satr-design-ar المضمّنة غير مكتشفة');
  assert.strictEqual(skill.format, 'standard');
  // الوصف وحده ما يقرّر التحميل: يجب أن يحمل المُشغّل والأداة والحدّ معاً
  assert(skill.description.includes('browser_readability'), 'الوصف بلا أداة القياس');
  assert(skill.description.includes('لا تستعملها'), 'الوصف بلا حدّ الاستعمال');

  const selected = skills.resolveSelection(ROOT, ['satr-design-ar'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-design-ar');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## متى **لا** تُستعمل'), 'سقطت حدود الاستعمال');
  // الفحص الجوهري: العطل الذي لا تكشفه الخاصية المحسوبة. سقوطه يفرّغ المهارة.
  assert(loaded.instructions.includes('getComputedStyle'),
    'سقط تحذير الخاصية المحسوبة — وهو العطل المركزي');
  assert(/ar\s*\*\s*2\s*>=\s*lat/.test(loaded.instructions),
    'سقطت دالة الحسم الإحصائي — بدونها تعود التوصية إلى plaintext');
  assert(loaded.instructions.includes('unicode-bidi: plaintext'),
    'المهارة لا تسمّي الفخّ الذي تعالجه');
  // «صفر مخالفات» بلا تصريح بما لم يُفحص ادّعاءٌ ضمني بالشمول
  assert(loaded.instructions.includes('unseen'), 'سقطت قاعدة التصريح بما لم يُفحص');

  const resources = loaded.resources.map((item) => item.path);
  for (const name of ['direction.md', 'fonts.md', 'locales.md', 'checklist.md']) {
    assert(resources.includes(name), 'المورد ' + name + ' غير مُدرَج');
  }
  // التحميل التدريجي: الموارد لا تُحشر في SKILL.md وإلا استُهلك سياق كل دور
  assert(loaded.instructions.length < 12000,
    'SKILL.md انتفخ (' + loaded.instructions.length + ' محرفاً) — انقل التفصيل إلى مورد');

  // المحمولية — على النصّ وكل مورد
  const texts = [['SKILL.md', loaded.instructions]];
  for (const name of resources) {
    const resource = skills.readResource(selected, 'satr-design-ar', name);
    assert.strictEqual(resource.ok, true, 'تعذّرت قراءة المورد ' + name);
    texts.push([name, resource.content]);
  }
  for (const [name, text] of texts) {
    for (const [pattern, label] of REPO_LEAKS) {
      const hit = text.match(pattern);
      assert(!hit, 'تسريب مسار مستودعنا في ' + name + ' (' + label + '): ' + (hit && hit[0])
        + ' — المهارة تعمل في مشروع المستخدم حيث لا وجود له');
    }
  }

  const toolLoaded = await tools.run('load_skill', ROOT, { name: 'satr-design-ar' }, { skillContext: selected });
  assert.strictEqual(toolLoaded.ok, true);
  assert(toolLoaded.content.includes('## متى **لا** تُستعمل'));
}

async function assertSatrDiverge(discoveryOptions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(manifest.build.files.includes('.agents/skills/satr-diverge/**/*'));
  assert(manifest.build.asarUnpack.includes('.agents/skills/satr-diverge/**/*'));

  const catalog = skills.discoverSkills(ROOT, discoveryOptions);
  const skill = catalog.find((item) => item.name === 'satr-diverge');
  assert(skill, 'مهارة satr-diverge المضمّنة غير مكتشفة');
  assert.strictEqual(skill.source, 'project');
  assert.strictEqual(skill.format, 'standard');
  assert(skill.description.includes('فروعاً معزولة'));

  const selected = skills.resolveSelection(ROOT, ['satr-diverge'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-diverge');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## المراحل السبع'));
  assert(loaded.instructions.includes('## شرط العزل'));
  assert(loaded.instructions.includes('## حاجز اكتمال المجموعات'));
  assert(loaded.instructions.includes('لا تُنهِ دور الجذر'));
  assert(loaded.instructions.includes('launched/completed/failed/missing'));
  const resources = loaded.resources.map((item) => item.path);
  assert(resources.includes('LICENSE'));
  assert(resources.includes('agents/openai.yaml'));
  assert(resources.includes('references/engine-adapters.md'));
  assert(resources.includes('references/evaluation.md'));
  assert(resources.includes('references/frames.md'));
  assert(resources.includes('references/scoring.md'));
  assert(resources.includes('references/upstream.md'));
  assert(!resources.some((item) => item.startsWith('scripts/')));

  const adapter = skills.readResource(selected, 'satr-diverge', 'references/engine-adapters.md');
  assert.strictEqual(adapter.ok, true);
  assert(adapter.content.includes('## Claude Code'));
  assert(adapter.content.includes('## Codex'));
  assert(adapter.content.includes('## Kimi Code عبر ACP'));
  assert(adapter.content.includes('استدعاء واحد لـ `wait_agent` **ليس حاجزاً**'));
  assert(adapter.content.includes('`diverge_f1` و`diverge_f2` و`diverge_f3`'));
  assert(adapter.content.includes('لا تُنهِ دور الجذر ولا تعرض خرج طفل واحد'));
  assert(adapter.content.includes('بقاء `/root` وحده قبل استلام خرج فرع يعني `missing`'));

  // تعدد المحركات (‏OBS-060، بدليل جلسة `ec550b65`): كان المورد يحيل المحركات المختلفة
  // إلى غرفة العمليات **وهي سطح واجهة بلا أداة وكيل**، ويحرّم الصدفة تحريماً مطلقاً —
  // بينما `envbrief` المحقون كل دور يجيز «تشغيل محرّك آخر من الطرفية». فبقي الوكيل بلا
  // مسار شرعي: 19 محاولة إطلاق يدوية · 1110ث · ‏$14.61 ثم استسلم. هذه الفحوص تمنع عودة
  // أيٍّ من الثلاثة: إعلان حدّ الغرفة، والوصفة المثبَّتة، وسقف المحاولات.
  assert(adapter.content.includes('سطح واجهة لا أداة وكيل'),
    'المورد لا يعلن أن غرفة العمليات ليست أداة وكيل — يعود الوكيل يبحث عن بديل');
  assert(adapter.content.includes('## تعدد المحركات'), 'سقط قسم تعدد المحركات');
  assert(/codex exec[^\n]*--dangerously-bypass-approvals-and-sandbox\s+-/.test(adapter.content),
    'الوصفة بلا العلم الصحيح أو بلا علامة stdin `-` — وهما سببا الفشل المرصود');
  assert(adapter.content.includes('OutputEncoding') && adapter.content.includes('ASCII'),
    'الوصفة لا تحذّر من ترميز PS 5.1 الافتراضي — العربية تصل ???');
  assert(adapter.content.includes("EAP='Continue'") || adapter.content.includes("'Continue'"),
    'الوصفة لا تذكر EAP=Continue — stderr يقتل السكربت');
  assert(adapter.content.includes('محاولتين'), 'الوصفة بلا سقف محاولات — يدخل الوكيل حلقة');
  // ولا تُحيل إلى مسار من مستودعنا: المهارة تعمل في مشروع المستخدم (‏OBS-060).
  for (const leak of ['executor.ps1', 'AGENT-CLI-FLAGS', 'D:\\sater', 'docs/']) {
    assert(!adapter.content.includes(leak),
      'تسريب مسار من مستودعنا إلى المهارة المحمولة: ' + leak);
  }

  const evaluation = skills.readResource(selected, 'satr-diverge', 'references/evaluation.md');
  assert.strictEqual(evaluation.ok, true);
  assert(evaluation.content.includes('branch_completion_ratio'));
  assert(evaluation.content.includes('عرض JSON فرع منفرد كتقرير نهائي'));

  const toolLoaded = await tools.run('load_skill', ROOT, { name: 'satr-diverge' }, { skillContext: selected });
  assert.strictEqual(toolLoaded.ok, true);
  assert(toolLoaded.content.includes('## المراحل السبع'));
  const codex = skills.codexInputs(selected);
  assert.deepStrictEqual(codex.map((item) => item.name), ['satr-diverge']);
  assert(codex.every((item) => path.isAbsolute(item.path)));
  console.log('✓ satr-diverge packaging and portable contract for Claude, Codex, and Kimi');
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-skills-test-'));
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  const discoveryOptions = { home, builtinRoot: path.join(temp, 'builtin') };
  await fsp.mkdir(project, { recursive: true });
  try {
    await write(project, '.agents/skills/portable/SKILL.md', [
      '---',
      'name: portable',
      'description: مهارة قياسية محمولة',
      '---',
      'PORTABLE_INSTRUCTIONS_MARKER',
      '',
    ].join('\n'));
    await write(project, '.agents/skills/portable/checklists/review.md', 'راجع الاختبارات أولاً.\n');
    await write(project, '.agents/skills/portable/scripts/run.ps1', 'Write-Output "لا يُنفّذ تلقائياً"\n');
    await write(project, '.claude/skills/portable/SKILL.md', [
      '---', 'name: portable', 'description: نسخة توافق يجب أن تخسر', '---', 'LEGACY_SHADOW_MARKER', '',
    ].join('\n'));
    await write(project, '.claude/skills/legacy/SKILL.md', [
      '---', 'name: legacy', 'description: مهارة Claude قديمة', '---', 'LEGACY_ONLY_MARKER', '',
    ].join('\n'));
    await write(home, '.agents/skills/global/SKILL.md', [
      '---', 'name: global', 'description: |', '  مهارة مستخدم قياسية', '  بوصف متعدد الأسطر', '---', 'GLOBAL_MARKER', '',
    ].join('\n'));
    await write(discoveryOptions.builtinRoot, 'satr-diverge/SKILL.md', [
      '---', 'name: satr-diverge', 'description: مهارة سطر مضمّنة', '---', 'BUILTIN_DIVERGE_MARKER', '',
    ].join('\n'));
    await write(discoveryOptions.builtinRoot, 'untrusted/SKILL.md', [
      '---', 'name: untrusted', 'description: يجب ألا تُكتشف من المضمّنات', '---', 'UNTRUSTED_MARKER', '',
    ].join('\n'));

    const catalog = skills.discoverSkills(project, discoveryOptions);
    assert.deepStrictEqual(catalog.map((skill) => skill.name), ['global', 'legacy', 'portable', 'satr-diverge']);
    const portable = catalog.find((skill) => skill.name === 'portable');
    assert.strictEqual(portable.format, 'standard');
    assert.strictEqual(portable.source, 'project');
    assert.strictEqual(catalog.find((skill) => skill.name === 'satr-diverge').source, 'builtin');
    assert(!catalog.some((skill) => skill.name === 'untrusted'));
    assert(catalog.find((skill) => skill.name === 'global').description.includes('بوصف متعدد الأسطر'));

    const selected = skills.resolveSelection(project, ['portable', 'legacy'], discoveryOptions);
    assert.deepStrictEqual(selected.enabled.map((skill) => skill.name), ['legacy', 'portable']);
    assert.deepStrictEqual(selected.nativeClaude, ['legacy']);
    assert.strictEqual(skills.resolveSelection(project, 'all', discoveryOptions).nativeClaude, 'all');

    const prompt = skills.catalogPrompt(selected);
    assert(prompt.includes('portable'));
    assert(prompt.includes('legacy'));
    assert(!prompt.includes('PORTABLE_INSTRUCTIONS_MARKER'));

    const loaded = skills.loadSkill(selected, 'portable');
    assert.strictEqual(loaded.ok, true);
    assert(loaded.instructions.includes('PORTABLE_INSTRUCTIONS_MARKER'));
    assert.deepStrictEqual(loaded.resources.map((resource) => resource.path), [
      'checklists/review.md', 'scripts/run.ps1',
    ]);

    const resource = skills.readResource(selected, 'portable', 'checklists/review.md');
    assert.strictEqual(resource.ok, true);
    assert(resource.content.includes('راجع الاختبارات'));
    assert.strictEqual(skills.readResource(selected, 'portable', '../secret.txt').ok, false);
    assert.strictEqual(skills.loadSkill(selected, 'global').ok, false);

    const definitions = tools.defs().map((definition) => definition.function.name);
    assert(definitions.includes('load_skill'));
    assert(definitions.includes('read_skill_resource'));
    const toolLoaded = await tools.run('load_skill', project, { name: 'portable' }, { skillContext: selected });
    assert.strictEqual(toolLoaded.ok, true);
    assert(toolLoaded.content.includes('PORTABLE_INSTRUCTIONS_MARKER'));
    const toolDenied = await tools.run('load_skill', project, { name: 'global' }, { skillContext: selected });
    assert.strictEqual(toolDenied.ok, false);

    const codex = skills.codexInputs(selected);
    assert.deepStrictEqual(codex.map((item) => item.type), ['skill', 'skill']);
    assert(codex.every((item) => path.isAbsolute(item.path)));

    const publicList = await skills.listSkills(project);
    assert(publicList.every((skill) => !('file' in skill) && !('directory' in skill)));
    console.log('✓ skills catalog precedence');
    console.log('✓ progressive disclosure and resource boundaries');
    console.log('✓ portable tools and Codex skill inputs');
    await assertSatrDiverge(discoveryOptions);
    await assertSatrAccept(discoveryOptions);
    console.log('✓ satr-accept: مضمّنة ومحزومة، وقواعدها الملزمة وحدودها ومثالها الحيّ في النص');
    await assertSatrDesignAr(discoveryOptions);
    console.log('✓ satr-design-ar: مضمّنة ومحزومة، وفحصها المركزي وحدودها في النص، ومحمولة بلا مسار من مستودعنا');
    if (process.argv.includes('--live-codex')) await runLiveProbe('codex', project);
    if (process.argv.includes('--live-sdk')) await runLiveProbe('sdk', project);
  } finally {
    if (process.argv.includes('--live-codex') || process.argv.includes('--live-sdk')) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
