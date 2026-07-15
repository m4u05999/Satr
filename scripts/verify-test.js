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
