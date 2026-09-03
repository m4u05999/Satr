#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const verify = require('../electron/verify');
const checkpoints = require('../electron/checkpoints');

async function writeJson(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value), 'utf8');
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-verify-test-'));
  const project = path.join(temp, 'project');
  const store = path.join(temp, 'store');
  await fsp.mkdir(project, { recursive: true });
  try {
    const commands = [
      { id: 'lint', label: 'فحص التنسيق', command: 'npm run lint', timeout_seconds: 30 },
      { id: 'test', label: 'الاختبارات', command: 'npm test', timeout_seconds: 120 },
    ];
    assert.strictEqual(verify.createConfig(project, commands, { overwrite: false }).error, 'confirmation_required');
    assert.strictEqual(await fsp.stat(path.join(project, '.satr')).then(() => true).catch(() => false), false,
      'أنشأ الكاتب مجلداً قبل التأكيد الصريح.');
    const created = verify.createConfig(project, commands, { confirmed: true, overwrite: false });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.path, '.satr/verify.json');
    assert.strictEqual(created.created, true);
    const firstSource = await fsp.readFile(path.join(project, '.satr', 'verify.json'), 'utf8');
    const refusedOverwrite = verify.createConfig(project, [
      { id: 'other', label: 'آخر', command: 'node --version', timeout_seconds: 10 },
    ], { confirmed: true, overwrite: false });
    assert.strictEqual(refusedOverwrite.error, 'exists');
    assert.strictEqual(await fsp.readFile(path.join(project, '.satr', 'verify.json'), 'utf8'), firstSource,
      'غيّر الكاتب الملف القائم بلا overwrite صريح.');
    const overwritten = verify.createConfig(project, commands, { confirmed: true, overwrite: true });
    assert.strictEqual(overwritten.ok, true);
    assert.strictEqual(overwritten.overwritten, true);
    assert.deepStrictEqual((await fsp.readdir(path.join(project, '.satr'))).sort(), ['verify.json'],
      'ترك الكاتب ملفاً مؤقتاً أو نسخة احتياطية.');

    assert.strictEqual(verify.buildConfig(new Array(7).fill(commands[0])).error, 'too_many_commands');
    assert.strictEqual(verify.buildConfig([{ ...commands[0], command: 'npm test\nwhoami' }]).error, 'bad_command');
    assert.strictEqual(verify.buildConfig([{ ...commands[0], command: 'x'.repeat(1001) }]).error, 'bad_command');
    assert.strictEqual(verify.buildConfig([{ ...commands[0], label: 'x'.repeat(121) }]).error, 'bad_label');
    assert.strictEqual(verify.buildConfig([{ ...commands[0], timeout_seconds: 601 }]).error, 'bad_timeout');
    assert.strictEqual(verify.buildConfig([{ ...commands[0], timeout_seconds: 0 }]).error, 'bad_timeout');
    assert.strictEqual(verify.buildConfig([commands[0], { ...commands[0] }]).error, 'bad_command');
    const previewConfig = verify.buildConfig(commands, {
      command: 'npm run dev', url: 'http://localhost:5173/app', timeout_seconds: 45,
    });
    assert.strictEqual(previewConfig.ok, true);
    assert.deepStrictEqual(verify.parseConfig(previewConfig.source).preview, {
      command: 'npm run dev', url: 'http://localhost:5173/app', timeout_seconds: 45,
    });
    assert.strictEqual(verify.buildConfig(commands, { command: 'npm run dev\nwhoami', url: 'http://localhost:5173' }).error,
      'bad_preview_command');
    assert.strictEqual(verify.buildConfig(commands, { command: 'npm run dev', url: 'https://example.com' }).error,
      'bad_preview_url');
    assert.strictEqual(verify.buildConfig(commands, {
      command: 'npm run dev', url: 'http://localhost:5173', timeout_seconds: 601,
    }).error, 'bad_preview_timeout');

    // ---------- review_skill: قراءةً وكتابةً (الجولة السابعة) ----------
    // إغلاق الوصلة: الخيار المجمَّد `reviewSkill` يُكتب فعلاً في الملف.
    const seamProject = path.join(temp, 'seam-project');
    await fsp.mkdir(seamProject, { recursive: true });
    const seam = verify.createConfig(seamProject, commands, {
      confirmed: true, overwrite: false, reviewSkill: { name: 'project-review' },
    });
    assert.strictEqual(seam.ok, true, 'createConfig must stay ok:true with reviewSkill');
    const seamSource = await fsp.readFile(path.join(seamProject, '.satr', 'verify.json'), 'utf8');
    assert.ok(seamSource.includes('"review_skill"'), 'review_skill must actually be written to the file');
    assert.deepStrictEqual(JSON.parse(seamSource).review_skill,
      { name: 'project-review', timeout_seconds: 300 }, 'default timeout applied on write');
    assert.deepStrictEqual(verify.loadConfig(seamProject).review_skill,
      { name: 'project-review', timeout_seconds: 300 }, 'review_skill round-trips through loadConfig');

    // التوافق الخلفي: غياب الخيار لا يضيف الحقل ولا يغيّر أي بايت من العقد القائم.
    const plainProject = path.join(temp, 'plain-project');
    await fsp.mkdir(plainProject, { recursive: true });
    const plain = verify.createConfig(plainProject, commands, { confirmed: true, overwrite: false });
    assert.strictEqual(plain.ok, true);
    const plainSource = await fsp.readFile(path.join(plainProject, '.satr', 'verify.json'), 'utf8');
    assert.ok(!plainSource.includes('review_skill'), 'absent option must not add the field');
    assert.strictEqual(verify.loadConfig(plainProject).review_skill, null, 'absent field reads back as null');
    assert.strictEqual(verify.buildConfig(commands).source, plainSource, 'existing buildConfig output unchanged');

    // الحقل الكامل: الوسم يُنقّى ويُقصّ، والمهلة تُقبل داخل 1..600.
    const fullReview = verify.buildConfig(commands, null, {
      name: 'project-review', label: '  مراجعة‮نوعية  \x07', timeout_seconds: 45,
    });
    assert.strictEqual(fullReview.ok, true);
    assert.deepStrictEqual(fullReview.config.review_skill,
      { name: 'project-review', label: 'مراجعةنوعية', timeout_seconds: 45 },
      'label stripped of control and Bidi characters');
    const longLabel = verify.buildConfig(commands, null, { name: 'r', label: 'ط'.repeat(200) });
    assert.strictEqual([...longLabel.config.review_skill.label].length, verify.MAX_REVIEW_LABEL,
      'label truncated to MAX_REVIEW_LABEL Unicode points');

    // رمز الخطأ الموحّد 'bad_review_skill' للقراءة والكتابة معاً.
    const badReviewSkills = [
      { value: { name: '../escape' }, label: 'path escape' },
      { value: { name: '' }, label: 'empty name' },
      { value: { name: 'x'.repeat(65) }, label: 'name too long' },
      { value: { name: 5 }, label: 'name not a string' },
      { value: { name: 'r', label: 7 }, label: 'label not a string' },
      { value: { name: 'r', timeout_seconds: 0 }, label: 'timeout too low' },
      { value: { name: 'r', timeout_seconds: 601 }, label: 'timeout too high' },
      { value: { name: 'r', timeout_seconds: 1.5 }, label: 'timeout not an integer' },
      { value: [], label: 'array' },
      { value: 'project-review', label: 'string' },
    ];
    for (const entry of badReviewSkills) {
      assert.strictEqual(verify.buildConfig(commands, null, entry.value).error, 'bad_review_skill',
        'write must reject: ' + entry.label);
      assert.strictEqual(verify.parseConfig(JSON.stringify({
        version: 1, commands, review_skill: entry.value,
      })).error, 'bad_review_skill', 'read must reject: ' + entry.label);
      assert.strictEqual(verify.createConfig(path.join(temp, 'never-written'), commands, {
        confirmed: true, overwrite: false, reviewSkill: entry.value,
      }).error, 'bad_review_skill', 'createConfig must reject: ' + entry.label);
    }
    assert.strictEqual(await fsp.stat(path.join(temp, 'never-written')).then(() => true).catch(() => false), false,
      'رفض review_skill الفاسد يجب ألّا ينشئ أي مجلد.');

    // الحقل خارج عدّ MAX_CHECKS: ستة أوامر + مهارة تبقى صالحة.
    const sixCommands = Array.from({ length: 6 }, (_, index) => ({
      id: 'check-' + index, label: 'فحص ' + index, command: 'node --version', timeout_seconds: 10,
    }));
    const withSix = verify.buildConfig(sixCommands, null, { name: 'project-review' });
    assert.strictEqual(withSix.ok, true, 'review_skill must not count against MAX_CHECKS');
    assert.strictEqual(verify.parseConfig(withSix.source).checks.length, verify.MAX_CHECKS);

    const outside = path.join(temp, 'outside');
    const linkedProject = path.join(temp, 'linked-project');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(linkedProject, { recursive: true });
    await fsp.symlink(outside, path.join(linkedProject, '.satr'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = verify.createConfig(linkedProject, commands, { confirmed: true, overwrite: false });
    assert(['symlink', 'outside'].includes(escaped.error), 'لم يرفض الكاتب .satr المرتبط خارج cwd.');
    assert.strictEqual(await fsp.stat(path.join(outside, 'verify.json')).then(() => true).catch(() => false), false,
      'كتب الكاتب خارج cwd عبر symlink.');

    const linkedTargetProject = path.join(temp, 'linked-target-project');
    await fsp.mkdir(path.join(linkedTargetProject, '.satr'), { recursive: true });
    await fsp.symlink(outside, path.join(linkedTargetProject, '.satr', 'verify.json'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const escapedTarget = verify.createConfig(linkedTargetProject, commands, { confirmed: true, overwrite: true });
    assert(['symlink', 'unsafe_target', 'outside'].includes(escapedTarget.error),
      'لم يرفض الكاتب verify.json المرتبط خارج cwd.');
    assert.strictEqual(await fsp.stat(path.join(outside, 'verify.json')).then(() => true).catch(() => false), false,
      'كتب الكاتب عبر verify.json مرتبط خارج cwd.');

    const config = verify.loadConfig(project);
    assert.strictEqual(config.ok, true);
    assert.deepStrictEqual(config.checks.map((check) => check.id), ['lint', 'test']);
    assert.strictEqual(verify.selectChecks(config, ['test']).checks.length, 1);
    assert.strictEqual(verify.selectChecks(config, ['missing']).ok, false);
    assert.strictEqual(verify.parseConfig(JSON.stringify({
      version: 1,
      commands: Array.from({ length: 7 }, (_, index) => ({ id: 'check-' + index, command: 'node --version' })),
    })).error, 'too_many_commands');

    const executed = [];
    const result = await verify.run(project, ['lint', 'test'], null, {
      execute: async (_cwd, check) => {
        executed.push(check.id);
        return { ok: true, exitCode: check.id === 'lint' ? 0 : 1, output: check.id + ' output' };
      },
    });
    assert.deepStrictEqual(executed, ['lint', 'test']);
    assert.strictEqual(result.passed, false);
    assert(verify.formatResult(result).includes('فشل التحقق'));

    await writeJson(project, '.satr/verify.json', {
      version: 1, commands: [{ id: 'bad', command: 'npm test\nRemove-Item x' }],
    });
    assert.strictEqual(verify.loadConfig(project).error, 'bad_command');

    const first = checkpoints.begin({ runId: 'run-1', engine: 'sdk', sessionId: 'session-1', cwd: project }, { root: store });
    assert(first && first.state === 'open');
    checkpoints.addEdit('run-1', { id: 'edit-1', rel: 'src/a.js', added: 2, removed: 1 }, { id: 'task-1', title: 'تنفيذ الوحدة' });
    checkpoints.addEdit('run-1', { id: 'edit-2', rel: 'src/b.js', added: 3, removed: 0 });
    checkpoints.recordVerification('run-1', {
      passed: false, summary: 'فشل test',
      checks: [{ id: 'test', label: 'الاختبارات', passed: false, exit_code: 1, duration_ms: 25, output: 'lint output' }],
    });
    const finished = checkpoints.finish('run-1');
    assert.strictEqual(finished.state, 'failed');
    assert.strictEqual(finished.edit_count, 2);
    assert.strictEqual(finished.task_title, 'تنفيذ الوحدة');
    assert.strictEqual(checkpoints.latest('sdk', 'session-1', { root: store }).restorable, true);
    const persisted = JSON.stringify(await fsp.readFile(path.join(store, 'sdk', 'session-1.json'), 'utf8'));
    assert(!persisted.includes('lint output'));

    const undoOrder = [];
    const restored = await checkpoints.restore({
      engine: 'sdk', sessionId: 'session-1', checkpointId: finished.id, cwd: project, options: { root: store },
    }, async (id) => { undoOrder.push(id); return { ok: true }; });
    assert.strictEqual(restored.ok, true);
    assert.deepStrictEqual(undoOrder, ['edit-2', 'edit-1']);
    assert.strictEqual(restored.checkpoint.state, 'restored');

    const second = checkpoints.begin({ runId: 'run-2', engine: 'sdk', sessionId: 'session-1', cwd: project }, { root: store });
    checkpoints.addEdit('run-2', { id: 'edit-3', rel: '../outside', added: 1, removed: 0 });
    const secondFinished = checkpoints.finish('run-2');
    assert.strictEqual(secondFinished.previous_id, finished.id);
    assert.deepStrictEqual(secondFinished.files, []);
    const wrongCwd = await checkpoints.restore({
      engine: 'sdk', sessionId: 'session-1', checkpointId: second.id, cwd: temp, options: { root: store },
    }, async () => ({ ok: true }));
    assert.strictEqual(wrongCwd.error, 'wrong_cwd');

    const deferred = checkpoints.begin({ runId: 'run-3', engine: 'sdk', sessionId: null, cwd: project }, { root: store });
    checkpoints.bindSession('run-3', 'session-2');
    assert.strictEqual(checkpoints.latest('sdk', 'session-2', { root: store }), null);
    checkpoints.addEdit('run-3', { id: 'edit-4', rel: 'src/c.js', added: 1, removed: 0 });
    const deferredFinished = checkpoints.finish('run-3');
    const reverified = checkpoints.recordVerificationForCheckpoint(deferred.id, { passed: true, summary: 'نجح', checks: [] });
    assert.strictEqual(deferredFinished.state, 'ready');
    assert.strictEqual(reverified.state, 'passed');
    assert(checkpoints.consumeVerification('sdk', 'session-2', { root: store }).includes('نجح التحقق'));
    assert.strictEqual(checkpoints.consumeVerification('sdk', 'session-2', { root: store }), '');

    console.log('✓ explicit verification config boundaries');
    console.log('✓ verification config writer confirmation, overwrite, limits, and symlink escape guards');
    console.log('✓ review_skill reads, writes to disk, defaults, limits, and unified bad_review_skill');
    console.log('✓ verification runner result contract');
    console.log('✓ checkpoint persistence and reverse restore');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
