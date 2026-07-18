#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const skills = require('../electron/skills');
const tools = require('../electron/tools');

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

    const catalog = skills.discoverSkills(project, discoveryOptions);
    assert.deepStrictEqual(catalog.map((skill) => skill.name), ['global', 'legacy', 'portable']);
    const portable = catalog.find((skill) => skill.name === 'portable');
    assert.strictEqual(portable.format, 'standard');
    assert.strictEqual(portable.source, 'project');
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
