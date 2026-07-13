#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const worktrees = require('../electron/worktrees');
const executorModule = require('../electron/executor');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

function waitFor(check, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('wait timeout')); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function makeRepo(root) {
  const project = path.join(root, 'project');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  await fsp.writeFile(path.join(project, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
  await git(project, ['init']);
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', 'fixture']);
  return project;
}

function editingRunner(stats, outsidePath, engine) {
  return {
    engine: engine || 'fixture-a',
    start(input, cwd, emit) {
      stats.inputs.push({ input, cwd });
      let stopped = false;
      const handle = {
        resolvePermission(id, allow) { stats.permissions.push({ id, allow }); return true; },
        stop() { if (!stopped) { stopped = true; stats.stops++; } return Promise.resolve(); },
      };
      setTimeout(() => {
        if (stopped) return;
        const target = outsidePath || path.join(cwd, 'src', 'app.js');
        emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: target } }] } });
        if (outsidePath || stopped) return;
        emit({ type: 'permission_request', id: 'write-1', tool: 'Edit', input: { file_path: target } });
        fs.writeFileSync(target, 'export const value = 2;\n', 'utf8');
        fs.writeFileSync(path.join(cwd, 'src', 'new.js'), 'export const added = true;\n', 'utf8');
        emit({ type: 'file_edit', id: 'edit-1', rel: 'src/app.js', added: 1, removed: 1 });
        emit({ type: 'file_edit', id: 'edit-2', rel: 'src/new.js', added: 1, removed: 0 });
        emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text: 'عُدّلت القيمة وأُضيف ملف جديد.' }] } });
        emit({ type: 'result', total_cost_usd: 0.02, usage: { input_tokens: 30, output_tokens: 8 } });
        emit({ type: 'proc_done', code: 0 });
      }, 20);
      return handle;
    },
  };
}

function hangingRunner(stats) {
  return {
    engine: 'fixture-hanging',
    start(input, cwd) {
      stats.inputs.push({ input, cwd });
      let stopped = false;
      return {
        resolvePermission() { return true; },
        stop() { if (!stopped) { stopped = true; stats.stops++; } return Promise.resolve(); },
      };
    },
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-worktrees-test-'));
  const project = await makeRepo(temp);
  const managers = [];
  try {
    const manager = worktrees.createManager({ root: path.join(temp, 'store-lifecycle') });
    managers.push(manager);
    await fsp.mkdir(path.join(temp, 'not-a-repo'));
    assert.strictEqual((await manager.create(path.join(temp, 'not-a-repo'))).error, 'no_repo');
    const made = await manager.create(project);
    assert.strictEqual(made.ok, true);
    assert(!made.worktree.path.startsWith(path.resolve(project) + path.sep));
    assert.strictEqual(manager.contains(made.worktree.id, path.join(made.worktree.path, 'src', 'app.js')), true);
    assert.strictEqual(manager.contains(made.worktree.id, path.join(project, 'src', 'app.js')), false);
    await fsp.writeFile(path.join(made.worktree.path, 'src', 'app.js'), 'export const value = 9;\n', 'utf8');
    await fsp.writeFile(path.join(made.worktree.path, 'src', 'extra.js'), 'export const extra = true;\n', 'utf8');
    const diff = await manager.diff(made.worktree.id);
    assert.strictEqual(diff.ok, true);
    assert(diff.files.some((file) => file.rel === 'src/app.js' && file.kind === 'mod'));
    assert(diff.files.some((file) => file.rel === 'src/extra.js' && file.kind === 'new'));
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
    const worktreePath = made.worktree.path;
    assert.strictEqual((await manager.remove(made.worktree.id)).ok, true);
    assert.strictEqual(fs.existsSync(worktreePath), false);
    assert(!(await git(project, ['worktree', 'list', '--porcelain'])).includes(worktreePath));
    assert.strictEqual(manager.merge, undefined);

    const stats = { inputs: [], permissions: [], stops: 0 };
    const executionManager = worktrees.createManager({ root: path.join(temp, 'store-execution') });
    managers.push(executionManager);
    const executor = executorModule.create({ worktrees: executionManager, runner: editingRunner(stats), timeoutMs: 1000 });
    const started = await executor.start({ task: 'حدّث القيمة وأضف ملفاً' }, project, () => {});
    assert.strictEqual(started.ok, true);
    const completed = await waitFor(() => {
      const run = executor.latest(project);
      return run && run.state === 'completed' ? run : null;
    }, 3000);
    assert.strictEqual(completed.merged, false);
    assert.strictEqual(completed.merge_supported, false);
    assert.strictEqual(completed.engine, 'fixture-a');
    assert(completed.changes.files.some((file) => file.rel === 'src/app.js'));
    assert(completed.changes.files.some((file) => file.rel === 'src/new.js'));
    assert.strictEqual(completed.edits_seen, 2);
    assert.strictEqual(completed.permissions.write_used, 1);
    assert.strictEqual(completed.cost.usd, 0.02);
    assert.strictEqual(stats.inputs[0].input.permissionMode, 'acceptEdits');
    assert.notStrictEqual(path.resolve(stats.inputs[0].cwd), path.resolve(project));
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
    assert.strictEqual(fs.existsSync(path.join(project, 'src', 'new.js')), false);
    assert.strictEqual(executionManager.get(completed.worktree.id), null);

    const secondStats = { inputs: [], permissions: [], stops: 0 };
    const secondManager = worktrees.createManager({ root: path.join(temp, 'store-execution-second') });
    managers.push(secondManager);
    const secondExecutor = executorModule.create({
      worktrees: secondManager,
      runner: editingRunner(secondStats, null, 'fixture-b'),
      timeoutMs: 1000,
    });
    const secondStarted = await secondExecutor.start({ task: 'نفّذ السياسة نفسها بمحرك آخر' }, project, () => {});
    assert.strictEqual(secondStarted.ok, true);
    const secondCompleted = await waitFor(() => {
      const run = secondExecutor.latest(project);
      return run && run.state === 'completed' ? run : null;
    }, 3000);
    assert.strictEqual(secondCompleted.engine, 'fixture-b');
    assert.deepStrictEqual(
      secondCompleted.changes.files.map((file) => file.rel).sort(),
      completed.changes.files.map((file) => file.rel).sort(),
    );
    assert.strictEqual(secondCompleted.permissions.write_used, completed.permissions.write_used);
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');

    const forbiddenManager = {
      create() { throw new Error('worktree creation must not run'); },
    };
    const missingRunner = executorModule.create({ worktrees: forbiddenManager });
    assert.deepStrictEqual(
      await missingRunner.start({ task: 'لا تنشئ worktree' }, project, () => {}),
      { ok: false, error: 'engine_unavailable' },
    );
    const malformedRunner = executorModule.create({
      worktrees: forbiddenManager,
      runner: { engine: 'fixture-invalid' },
    });
    assert.deepStrictEqual(
      await malformedRunner.start({ task: 'لا تنشئ worktree أيضاً' }, project, () => {}),
      { ok: false, error: 'engine_unavailable' },
    );
    const unlabeledRunner = executorModule.create({
      worktrees: forbiddenManager,
      runner: { start() { throw new Error('runner must not start'); } },
    });
    assert.deepStrictEqual(
      await unlabeledRunner.start({ task: 'لا تشغّل runner بلا هوية' }, project, () => {}),
      { ok: false, error: 'engine_unavailable' },
    );

    const timeoutStats = { inputs: [], stops: 0 };
    const timeoutManager = worktrees.createManager({ root: path.join(temp, 'store-timeout') });
    managers.push(timeoutManager);
    const timed = executorModule.create({ worktrees: timeoutManager, runner: hangingRunner(timeoutStats), timeoutMs: 30 });
    await timed.start({ task: 'مهمة معلقة' }, project, () => {});
    const timedDone = await waitFor(() => {
      const run = timed.latest(project);
      return run && run.state === 'timed_out' ? run : null;
    }, 3000);
    assert.strictEqual(timeoutStats.stops, 1);
    assert.strictEqual(timeoutManager.get(timedDone.worktree.id), null);

    const stopStats = { inputs: [], stops: 0 };
    const stopManager = worktrees.createManager({ root: path.join(temp, 'store-stop') });
    managers.push(stopManager);
    const stopped = executorModule.create({ worktrees: stopManager, runner: hangingRunner(stopStats), timeoutMs: 1000 });
    const running = await stopped.start({ task: 'مهمة ستتوقف' }, project, () => {});
    const stoppedResult = await stopped.stop(running.run.id);
    assert.strictEqual(stoppedResult.ok, true);
    assert.strictEqual(stoppedResult.run.state, 'stopped');
    assert.strictEqual(stopStats.stops, 1);
    assert.strictEqual(stopManager.get(stoppedResult.run.worktree.id), null);

    const outsideStats = { inputs: [], permissions: [], stops: 0 };
    const outsideManager = worktrees.createManager({ root: path.join(temp, 'store-outside') });
    managers.push(outsideManager);
    const outside = executorModule.create({
      worktrees: outsideManager,
      runner: editingRunner(outsideStats, path.join(project, 'src', 'app.js')),
      timeoutMs: 1000,
    });
    await outside.start({ task: 'حاول مساراً خارجياً' }, project, () => {});
    const outsideDone = await waitFor(() => {
      const run = outside.latest(project);
      return run && run.state === 'failed' ? run : null;
    }, 3000);
    assert(outsideDone.error.includes('غير مسموح'));
    assert.strictEqual(outsideStats.stops, 1);
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');

    console.log('✓ detached worktree lifecycle and bounded diff');
    console.log('✓ executor writes only inside the isolated worktree');
    console.log('✓ two explicitly labelled runners share the same isolation policy');
    console.log('✓ missing, unlabeled, or malformed runners fail before worktree creation');
    console.log('✓ completed execution returns diff without automatic merge');
    console.log('✓ timeout and interrupt stop the handle and remove worktrees');
    console.log('✓ outside write paths fail closed');
  } finally {
    for (const manager of managers) await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
