#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mergerModule = require('../electron/merger');
const reviewerModule = require('../electron/reviewer');
const worktrees = require('../electron/worktrees');

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

async function readLf(filePath) {
  return (await fsp.readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');
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

function reviewRunner(stats, withTool) {
  return {
    start(input, cwd, emit) {
      stats.input = input;
      stats.cwd = cwd;
      let stopped = false;
      const handle = {
        resolvePermission(id, allow) { stats.permissions.push({ id, allow }); return true; },
        stop() { if (!stopped) { stopped = true; stats.stops++; } return Promise.resolve(); },
      };
      setTimeout(() => {
        if (stopped) return;
        emit({ type: 'permission_request', id: 'review-permission', tool: 'Read', input: { file_path: 'src/app.js' } });
        if (withTool) {
          emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } }] } });
          return;
        }
        emit({ type: 'assistant', message: { content: [{
          type: 'text', phase: 'final_answer',
          text: 'المخاطر: منخفضة.\nالملاحظات: الفرق محدود.\nالتوصية: اقبل\n[recommendation: accept]',
        }] } });
        emit({ type: 'result', total_cost_usd: 0.015, usage: { input_tokens: 40, output_tokens: 12 } });
        emit({ type: 'proc_done', code: 0 });
      }, 20);
      return handle;
    },
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-review-merge-test-'));
  const project = await makeRepo(temp);
  const manager = worktrees.createManager({ root: path.join(temp, 'worktrees') });
  try {
    const baseHead = await git(project, ['rev-parse', 'HEAD']);
    const branch = await git(project, ['branch', '--show-current']);
    const made = await manager.create(project);
    assert.strictEqual(made.ok, true);
    await fsp.writeFile(path.join(made.worktree.path, 'src', 'app.js'), 'export const value = 2;\n', 'utf8');
    await fsp.writeFile(path.join(made.worktree.path, 'src', 'added.js'), 'export const added = true;\n', 'utf8');
    const diff = await manager.diff(made.worktree.id);
    const artifact = await manager.patch(made.worktree.id);
    assert.strictEqual(diff.ok, true);
    assert.strictEqual(artifact.ok, true);
    assert(artifact.patch.includes('src/app.js'));
    assert(artifact.patch.includes('src/added.js'));
    assert.strictEqual(artifact.head, baseHead);
    await manager.remove(made.worktree.id);

    const reviewStats = { permissions: [], stops: 0 };
    const reviewer = reviewerModule.create({ resolveEngine: () => reviewRunner(reviewStats, false), timeoutMs: 1000 });
    const secretReview = reviewer.start({
      teamId: 'execution-team-secret', engine: 'sdk',
      patch: 'diff --git a/.env b/.env\n+API_KEY=abcdefghijklmnopqrstuvwxyz123456', files: [],
    }, project, () => {});
    assert.strictEqual(secretReview.error, 'secret_detected');
    const reviewStarted = reviewer.start({
      teamId: 'execution-team-test-1', engine: 'sdk', patch: artifact.patch,
      files: diff.files.map((file) => ({ rel: file.rel, agent: 'عامل 1' })),
    }, project, () => {});
    assert.strictEqual(reviewStarted.ok, true);
    const review = await waitFor(() => {
      const latest = reviewer.latest('execution-team-test-1');
      return latest && latest.state === 'completed' ? latest : null;
    }, 2000, 'review completion');
    assert.strictEqual(review.recommendation, 'accept');
    assert(review.summary.includes('المخاطر'));
    assert.strictEqual(review.cost.usd, 0.015);
    assert.strictEqual(reviewStats.input.permissionMode, 'plan');
    assert.strictEqual(reviewStats.input.browserControl, false);
    assert.deepStrictEqual(reviewStats.permissions, [{ id: 'review-permission', allow: false }]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(review, 'patch'), false);

    const toolStats = { permissions: [], stops: 0 };
    const toolReviewer = reviewerModule.create({ resolveEngine: () => reviewRunner(toolStats, true), timeoutMs: 1000 });
    toolReviewer.start({ teamId: 'execution-team-test-2', engine: 'sdk', patch: artifact.patch, files: [] }, project, () => {});
    const toolFailed = await waitFor(() => {
      const latest = toolReviewer.latest('execution-team-test-2');
      return latest && latest.state === 'failed' ? latest : null;
    }, 2000, 'tool rejection');
    assert(toolFailed.error.includes('أداة غير مسموحة'));
    assert.strictEqual(toolStats.stops, 1);

    const merger = mergerModule.create({ root: path.join(temp, 'merge-store') });
    const mergeInput = {
      cwd: project, sourceRoot: project, head: artifact.head, patch: artifact.patch,
      files: diff.files, confirmed: false,
    };
    const denied = await merger.apply(mergeInput);
    assert.strictEqual(denied.error, 'confirmation_required');
    assert.strictEqual(await readLf(path.join(project, 'src', 'app.js')), 'export const value = 1;\n');
    assert.strictEqual(await git(project, ['status', '--porcelain']), '');

    const conflictingPatch = artifact.patch.replace('export const value = 1;', 'export const missing = 999;');
    const conflict = await merger.apply({ ...mergeInput, patch: conflictingPatch, confirmed: true });
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.error, 'conflict');
    assert.strictEqual(await readLf(path.join(project, 'src', 'app.js')), 'export const value = 1;\n');
    assert.strictEqual(fs.existsSync(path.join(project, 'src', 'added.js')), false);
    assert.strictEqual(await git(project, ['status', '--porcelain']), '');

    const merged = await merger.apply({ ...mergeInput, confirmed: true });
    assert.strictEqual(merged.ok, true);
    assert.strictEqual(await readLf(path.join(project, 'src', 'app.js')), 'export const value = 2;\n');
    assert.strictEqual(await readLf(path.join(project, 'src', 'added.js')), 'export const added = true;\n');
    assert.strictEqual(await git(project, ['rev-parse', 'HEAD']), baseHead);
    assert.strictEqual(await git(project, ['branch', '--show-current']), branch);
    assert((await git(project, ['status', '--porcelain'])).includes('src/app.js'));

    const mainSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(mainSource.includes("p.confirmed !== true"));
    assert(mainSource.includes("review.state !== 'completed'"));

    console.log('✓ reviewer runs in plan mode and returns Arabic risk notes plus recommendation');
    console.log('✓ reviewer denies permissions and fails closed on any tool use');
    console.log('✓ merge is rejected without confirmed:true and leaves the branch untouched');
    console.log('✓ git apply conflict fails closed with a clean unchanged worktree');
    console.log('✓ confirmed simple patch applies without commit, force, rebase, or history changes');
  } finally {
    await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
