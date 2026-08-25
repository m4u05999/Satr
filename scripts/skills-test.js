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

  const selected = skills.resolveSelection(ROOT, ['satr-accept'], discoveryOptions);
  const loaded = skills.loadSkill(selected, 'satr-accept');
  assert.strictEqual(loaded.ok, true);
  assert(loaded.instructions.includes('## قواعد ملزمة'));
  assert(loaded.instructions.includes('## متى **لا** تُستعمل'));
  assert(loaded.instructions.includes('**هو ينقر، لا أنت.**'), 'سقطت قاعدة «هو ينقر لا أنت»');
  assert(loaded.instructions.includes('خطوة واحدة حاسمة'), 'سقطت قاعدة حسم التعارض');
  assert(loaded.instructions.includes('نظّف بعدها'));
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
