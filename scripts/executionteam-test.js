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
      }, 80);
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
    const team = executionTeamModule.create({ worktrees: manager, runner: parallelRunner(stats), timeoutMs: 1000 });
    const started = await team.start({ agents: [
      { task: 'عدّل أ', ownership: ['src/a.js'] },
      { task: 'عدّل ب', ownership: ['src/b.js'] },
      { task: 'عدّل ج', ownership: ['src/c.js'] },
    ] }, project, () => {});
    assert.strictEqual(started.ok, true);
    const completed = await waitFor(() => {
      const snapshot = team.latest(project);
      return snapshot && snapshot.state === 'completed' ? snapshot : null;
    }, 8000, 'parallel completion');
    assert.strictEqual(stats.calls.length, 3);
    assert.strictEqual(stats.maxActive, 3);
    assert.strictEqual(new Set(stats.calls.map((call) => call.cwd)).size, 3);
    assert.strictEqual(completed.agents.length, 3);
    assert.deepStrictEqual(completed.agents.map((agent) => agent.ownership[0]), ['src/a.js', 'src/b.js', 'src/c.js']);
    assert(completed.agents.every((agent) => agent.changes.files.length === 1));
    assert.strictEqual(completed.cost.usd, 0.03);
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

    const outsideStats = { calls: [], stops: 0 };
    const outsideManager = worktrees.createManager({ root: path.join(temp, 'outside-store') });
    managers.push(outsideManager);
    const outside = executionTeamModule.create({ worktrees: outsideManager, runner: outsideOwnershipRunner(outsideStats), timeoutMs: 1000 });
    await outside.start({ agents: [{ task: 'عدّل أ فقط', ownership: ['src/a.js'] }] }, project, () => {});
    const outsideDone = await waitFor(() => {
      const snapshot = outside.latest(project);
      return snapshot && snapshot.state === 'failed' ? snapshot : null;
    }, 5000, 'outside ownership');
    assert(outsideDone.agents[0].error.includes('الملكية'));
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
    }, 2000, 'same-file collision');
    assert(collisionDone.conflicts.some((item) => item.reason === 'same_file' && item.path === 'src/shared.js'));

    const stopStats = { calls: [], stops: 0 };
    const stopManager = worktrees.createManager({ root: path.join(temp, 'stop-store') });
    managers.push(stopManager);
    const stoppable = executionTeamModule.create({ worktrees: stopManager, runner: hangingRunner(stopStats), timeoutMs: 1000 });
    const running = await stoppable.start({ agents: [
      { task: 'انتظر أ', ownership: ['src/a.js'] },
      { task: 'انتظر ب', ownership: ['src/b.js'] },
      { task: 'انتظر ج', ownership: ['src/c.js'] },
    ] }, project, () => {});
    await waitFor(() => stopStats.calls.length === 3, 5000, 'collective start');
    const stopped = await stoppable.stop(running.team.id);
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(stopped.team.state, 'stopped');
    assert.strictEqual(stopStats.stops, 3);
    assert(stopped.team.agents.every((agent) => agent.state === 'stopped'));
    assert(stopStats.calls.every((call) => !fs.existsSync(call.cwd)));

    console.log('✓ three isolated executors run concurrently with declared ownership');
    console.log('✓ overlapping ownership is rejected before worktree creation');
    console.log('✓ edits outside ownership fail closed and preserve the source repo');
    console.log('✓ touching the same file is reported as a team conflict');
    console.log('✓ collective interrupt stops all executors and removes worktrees');
  } finally {
    for (const manager of managers) await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
