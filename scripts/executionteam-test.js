#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const worktrees = require('../electron/worktrees');
const executionTeamModule = require('../electron/executionteam');

const TEST_EXECUTION_TIMEOUT_MS = 10000;
const WAIT_TIMEOUT_MS = 30000;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('wait timeout: ' + label)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function makeRepo(root) {
  const project = path.join(root, 'project');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  for (const name of ['a.js', 'b.js', 'c.js']) {
    await fsp.writeFile(path.join(project, 'src', name), 'export const value = 1;\n', 'utf8');
  }
  await git(project, ['init']);
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', 'fixture']);
  return project;
}

function parallelRunner(stats) {
  return {
    engine: 'sdk-test',
    model: 'claude-executor-model',
    start(input, cwd, emit) {
      const index = stats.calls.length;
      const owned = String(input.prompt || '').match(/src\/([abc]\.js)/);
      const name = owned ? owned[1] : '';
      assert(name);
      const target = path.join(cwd, 'src', name);
      let stopped = false;
      let active = true;
      stats.calls.push({ input, cwd, name });
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      const finishActive = () => { if (active) { active = false; stats.active--; } };
      const timer = setTimeout(() => {
        if (stopped) return;
        emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: target } }] } });
        if (stopped) return;
        emit({ type: 'permission_request', id: 'write-' + index, tool: 'Edit', input: { file_path: target } });
        fs.writeFileSync(target, 'export const value = ' + (index + 2) + ';\n', 'utf8');
        emit({ type: 'file_edit', id: 'edit-' + index, rel: 'src/' + name, added: 1, removed: 1 });
        emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text: 'اكتمل العامل ' + (index + 1) }] } });
        emit({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 4 } });
        finishActive();
        emit({ type: 'proc_done', code: 0 });
      }, 200);
      return {
        resolvePermission(id, allow) { stats.permissions.push({ id, allow }); return true; },
        stop() {
          if (!stopped) { stopped = true; clearTimeout(timer); finishActive(); stats.stops++; }
          return Promise.resolve();
        },
      };
    },
  };
}

function outsideOwnershipRunner(stats) {
  return {
    engine: 'sdk-test',
    start(input, cwd, emit) {
      stats.calls.push({ input, cwd });
      let stopped = false;
      const timer = setTimeout(() => {
        if (stopped) return;
        fs.writeFileSync(path.join(cwd, 'src', 'b.js'), 'export const escaped = true;\n', 'utf8');
        emit({ type: 'file_edit', id: 'outside', rel: 'src/b.js', added: 1, removed: 1 });
      }, 20);
      return {
        resolvePermission() { return true; },
        stop() { if (!stopped) { stopped = true; clearTimeout(timer); stats.stops++; } return Promise.resolve(); },
      };
    },
  };
}

function hangingRunner(stats) {
  return {
    engine: 'sdk-test',
    start(input, cwd) {
      stats.calls.push({ input, cwd });
      let stopped = false;
      return {
        resolvePermission() { return true; },
        stop() { if (!stopped) { stopped = true; stats.stops++; } return Promise.resolve(); },
      };
    },
  };
}

function collisionExecutorFactory() {
  let index = 0;
  return () => {
    const current = index++;
    let runId = '';
    return {
      async start(input, cwd, emit) {
        runId = 'execution-fake-' + current;
        const base = {
          id: runId, state: 'running', task: input.task, ownership: input.ownership,
          cost: {}, permissions: {}, edits_seen: 0, changes: { files: [], added: 0, removed: 0 },
          merged: false, merge_supported: false,
        };
        setTimeout(() => emit({ type: 'execution_update', run: {
          ...base, state: 'completed', changes: {
            files: [{ rel: 'src/shared.js', kind: 'mod', added: 1, removed: 0 }], added: 1, removed: 0,
          },
        } }), 20 + current * 10);
        return { ok: true, run: base };
      },
      async stop() { return { ok: true, run: { id: runId, state: 'stopped' } }; },
    };
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-execution-team-test-'));
  const project = await makeRepo(temp);
  const managers = [];
  try {
    assert.strictEqual(require('../electron/executor').ownedBy(['**'], '.git'), false);
    assert.strictEqual(require('../electron/executor').normalizeOwnership(['.git/**']), null);
    const stats = { calls: [], permissions: [], stops: 0, active: 0, maxActive: 0 };
    const manager = worktrees.createManager({ root: path.join(temp, 'parallel-store') });
    managers.push(manager);
    const team = executionTeamModule.create({ worktrees: manager, runner: parallelRunner(stats), timeoutMs: TEST_EXECUTION_TIMEOUT_MS });
    const started = await team.start({ agents: [
      { task: 'عدّل أ', ownership: ['src/a.js'] },
      { task: 'عدّل ب', ownership: ['src/b.js'] },
      { task: 'عدّل ج', ownership: ['src/c.js'] },
    ] }, project, () => {});
    assert.strictEqual(started.ok, true);
    const completed = await waitFor(() => {
      const snapshot = team.latest(project);
      return snapshot && snapshot.state === 'completed' ? snapshot : null;
    }, WAIT_TIMEOUT_MS, 'parallel completion');
    assert.strictEqual(stats.calls.length, 3);
    assert(stats.calls.every((call) => call.input.model === 'claude-executor-model'));
    assert.strictEqual(stats.maxActive, 3);
    assert.strictEqual(new Set(stats.calls.map((call) => call.cwd)).size, 3);
    assert.strictEqual(completed.agents.length, 3);
    assert.deepStrictEqual(completed.agents.map((agent) => agent.ownership[0]), ['src/a.js', 'src/b.js', 'src/c.js']);
    assert(completed.agents.every((agent) => agent.changes.files.length === 1));
    assert.strictEqual(completed.cost.usd, 0.03);
    assert.strictEqual(completed.timeout_ms, TEST_EXECUTION_TIMEOUT_MS);
    assert(completed.agents.every((agent) => agent.last_tool === 'edit'));
    assert.deepStrictEqual(completed.agents.map((agent) => agent.last_file).sort(), ['src/a.js', 'src/b.js', 'src/c.js']);
    assert.strictEqual(completed.merged, false);
    assert.strictEqual(completed.merge_supported, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(completed, 'patch'), false);
    const teamArtifact = team.artifact(completed.id);
    assert(teamArtifact && teamArtifact.patch.includes('src/a.js'));
    assert(teamArtifact.patch.includes('src/b.js'));
    assert(teamArtifact.patch.includes('src/c.js'));
    for (const name of ['a.js', 'b.js', 'c.js']) {
      assert.strictEqual(await fsp.readFile(path.join(project, 'src', name), 'utf8'), 'export const value = 1;\n');
    }

    const overlapStats = { calls: [], stops: 0 };
    const overlapManager = worktrees.createManager({ root: path.join(temp, 'overlap-store') });
    managers.push(overlapManager);
    const overlap = executionTeamModule.create({ worktrees: overlapManager, runner: hangingRunner(overlapStats) });
    const overlapResult = await overlap.start({ agents: [
      { task: 'واسع', ownership: ['src/**'] },
      { task: 'ضيق', ownership: ['src/a.js'] },
    ] }, project, () => {});
    assert.strictEqual(overlapResult.ok, false);
    assert.strictEqual(overlapResult.error, 'ownership_overlap');
    assert.strictEqual(overlapStats.calls.length, 0);
    const badTimeout = await executionTeamModule.create({ runner: hangingRunner({ calls: [], stops: 0 }) }).start({
      timeoutMs: 301000, agents: [{ task: 'مهلة غير معتمدة', ownership: ['src/a.js'] }],
    }, project, () => {});
    assert.strictEqual(badTimeout.error, 'bad_input');

    const outsideStats = { calls: [], stops: 0 };
    const outsideManager = worktrees.createManager({ root: path.join(temp, 'outside-store') });
    managers.push(outsideManager);
    const outside = executionTeamModule.create({ worktrees: outsideManager, runner: outsideOwnershipRunner(outsideStats), timeoutMs: TEST_EXECUTION_TIMEOUT_MS });
    await outside.start({ agents: [{ task: 'عدّل أ فقط', ownership: ['src/a.js'] }] }, project, () => {});
    const outsideDone = await waitFor(() => {
      const snapshot = outside.latest(project);
      return snapshot && snapshot.state === 'failed' ? snapshot : null;
    }, WAIT_TIMEOUT_MS, 'outside ownership');
    assert(outsideDone.agents[0].error.includes('الملكية'));
    assert.strictEqual(outsideDone.agents[0].failure_code, 'ownership_violation');
    assert(outsideDone.agents[0].changes.files.some((file) => file.rel === 'src/b.js'));
    assert.strictEqual(outsideStats.stops, 1);
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'b.js'), 'utf8'), 'export const value = 1;\n');

    const collision = executionTeamModule.create({ createExecutor: collisionExecutorFactory() });
    await collision.start({ agents: [
      { task: 'الأول', ownership: ['src/a.js'] },
      { task: 'الثاني', ownership: ['src/b.js'] },
    ] }, project, () => {});
    const collisionDone = await waitFor(() => {
      const snapshot = collision.latest(project);
      return snapshot && snapshot.state === 'conflict' ? snapshot : null;
    }, WAIT_TIMEOUT_MS, 'same-file collision');
    assert(collisionDone.conflicts.some((item) => item.reason === 'same_file' && item.path === 'src/shared.js'));

    const stopStats = { calls: [], stops: 0 };
    const stopManager = worktrees.createManager({ root: path.join(temp, 'stop-store') });
    managers.push(stopManager);
    const stoppable = executionTeamModule.create({ worktrees: stopManager, runner: hangingRunner(stopStats), timeoutMs: TEST_EXECUTION_TIMEOUT_MS });
    const running = await stoppable.start({ agents: [
      { task: 'انتظر أ', ownership: ['src/a.js'] },
      { task: 'انتظر ب', ownership: ['src/b.js'] },
      { task: 'انتظر ج', ownership: ['src/c.js'] },
    ] }, project, () => {});
    await waitFor(() => stopStats.calls.length === 3, WAIT_TIMEOUT_MS, 'collective start');
    assert.strictEqual(running.team.can_extend, true);
    const extended = await stoppable.extend(running.team.id);
    assert.strictEqual(extended.ok, true);
    assert.strictEqual(extended.team.timeout_ms, 180000);
    assert.strictEqual(extended.team.extended, true);
    assert.strictEqual(extended.team.can_extend, false);
    assert(extended.team.agents.every((agent) => agent.extended === true && agent.can_extend === false));
    assert.strictEqual((await stoppable.extend(running.team.id)).ok, false);
    const stopped = await stoppable.stop(running.team.id);
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(stopped.team.state, 'stopped');
    assert.strictEqual(stopStats.stops, 3);
    assert(stopped.team.agents.every((agent) => agent.state === 'stopped'));
    assert(stopStats.calls.every((call) => !fs.existsSync(call.cwd)));

    const draftStats = { calls: [], permissions: [], stops: 0, active: 0, maxActive: 0 };
    const draftManager = worktrees.createManager({ root: path.join(temp, 'draft-store') });
    managers.push(draftManager);
    const draftTeam = executionTeamModule.create({ worktrees: draftManager, runner: parallelRunner(draftStats), timeoutMs: TEST_EXECUTION_TIMEOUT_MS });
    const draftStarted = await draftTeam.start({
      mode: 'draft', agents: [{ task: 'مسودة أ', ownership: ['src/a.js'] }],
    }, project, () => {});
    assert.strictEqual(draftStarted.ok, true);
    const draftDone = await waitFor(() => {
      const snapshot = draftTeam.latest(project);
      return snapshot && snapshot.state === 'completed' ? snapshot : null;
    }, WAIT_TIMEOUT_MS, 'draft completion');
    assert.strictEqual(draftDone.mode, 'draft');
    assert.strictEqual(draftDone.merge_supported, false);
    assert.strictEqual(draftTeam.artifact(draftDone.id), null);
    const invalidDraft = await executionTeamModule.create({ runner: hangingRunner({ calls: [], stops: 0 }) }).start({
      mode: 'draft', agents: [
        { task: 'أ', ownership: ['src/a.js'] }, { task: 'ب', ownership: ['src/b.js'] },
      ],
    }, project, () => {});
    assert.strictEqual(invalidDraft.error, 'draft_single_engine_only');

    // انحدار «سياق فارغ في ذيل الـpatch»: حين يكون آخر سطر سياق في الـhunk سطراً
    // فارغاً، أي قصّ لذيل الأثر يُنقص أسطر الـhunk فيرفضه git apply بـcorrupt patch.
    const tailProject = path.join(temp, 'tail-project');
    await fsp.mkdir(path.join(tailProject, 'src'), { recursive: true });
    await fsp.writeFile(path.join(tailProject, 'src', 'tail.js'),
      'export function f() {\n  const v = 1;\n  return v;\n}\n\nexport const tail = 2;\n', 'utf8');
    await git(tailProject, ['init']);
    await git(tailProject, ['add', '.']);
    await git(tailProject, ['-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', 'fixture']);
    const tailManager = worktrees.createManager({ root: path.join(temp, 'tail-store') });
    managers.push(tailManager);
    const tailRunner = {
      engine: 'sdk-test',
      start(input, cwd, emit) {
        const target = path.join(cwd, 'src', 'tail.js');
        const timer = setTimeout(() => {
          emit({ type: 'permission_request', id: 'tail-write', tool: 'Edit', input: { file_path: target } });
          fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('const v = 1;', 'const v = 9;'), 'utf8');
          emit({ type: 'file_edit', id: 'tail-edit', rel: 'src/tail.js', added: 1, removed: 1 });
          emit({ type: 'result', total_cost_usd: 0.01 });
          emit({ type: 'proc_done', code: 0 });
        }, 30);
        return {
          resolvePermission() { return true; },
          stop() { clearTimeout(timer); return Promise.resolve(); },
        };
      },
    };
    const tailTeam = executionTeamModule.create({ worktrees: tailManager, runner: tailRunner, timeoutMs: TEST_EXECUTION_TIMEOUT_MS });
    const tailStarted = await tailTeam.start({ agents: [{ task: 'عدّل ذيل الدالة', ownership: ['src/tail.js'] }] }, tailProject, () => {});
    assert.strictEqual(tailStarted.ok, true);
    const tailDone = await waitFor(() => {
      const snapshot = tailTeam.latest(tailProject);
      return snapshot && snapshot.state === 'completed' ? snapshot : null;
    }, WAIT_TIMEOUT_MS, 'tail completion');
    const tailArtifact = tailTeam.artifact(tailDone.id);
    assert(tailArtifact && tailArtifact.patch.includes('src/tail.js'));
    assert(tailArtifact.patch.endsWith('\n \n'), 'trailing blank context line must survive artifact assembly');
    const tailPatchFile = path.join(temp, 'tail-artifact.patch');
    await fsp.writeFile(tailPatchFile, tailArtifact.patch, 'utf8');
    await git(tailProject, ['apply', '--check', '--whitespace=nowarn', '--', tailPatchFile]);
    await git(tailProject, ['apply', '--numstat', '--', tailPatchFile]);

    console.log('✓ three isolated executors run concurrently with declared ownership');
    console.log('✓ overlapping ownership is rejected before worktree creation');
    console.log('✓ edits outside ownership fail closed and preserve the source repo');
    console.log('✓ touching the same file is reported as a team conflict');
    console.log('✓ collective interrupt stops all executors and removes worktrees');
    console.log('✓ single-engine draft remains permanently non-mergeable and cannot expose an artifact');
    console.log('✓ artifact patch keeps a trailing blank context line and passes git apply');
  } finally {
    for (const manager of managers) await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
