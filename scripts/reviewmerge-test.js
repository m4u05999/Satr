#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');

const executionTeamModule = require('../electron/executionteam');
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

function makeStats() {
  return { calls: [], permissions: [], stops: 0 };
}

function reviewRunner(engine, stats, options) {
  const settings = options || {};
  return {
    engine,
    model: settings.model || engine + '-review-model',
    start(input, cwd, emit) {
      stats.calls.push({ input, cwd, parentEntries: fs.readdirSync(path.dirname(cwd)) });
      let stopped = false;
      const handle = {
        resolvePermission(id, allow) { stats.permissions.push({ id, allow }); return true; },
        stop() { if (!stopped) { stopped = true; stats.stops++; } return Promise.resolve(); },
      };
      setTimeout(() => {
        if (stopped) return;
        if (settings.event === 'permission_request') {
          emit({ type: 'permission_request', id: engine + '-permission', tool: 'Read', input: { file_path: 'confidential.txt' } });
          return;
        }
        if (settings.event === 'tool_use') {
          emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'confidential.txt' } }] } });
          return;
        }
        if (settings.event === 'file_edit') { emit({ type: 'file_edit', rel: 'src/app.js' }); return; }
        if (settings.event === 'model_term') { emit({ type: 'model_term', id: 'term-review' }); return; }
        if (settings.event === 'preview_open') { emit({ type: 'preview_open', url: 'http://127.0.0.1/' }); return; }
        if (settings.hang) return;

        let silentRead = 'missing';
        if (settings.silentRead) {
          try { silentRead = fs.readFileSync(path.join(cwd, settings.silentRead), 'utf8'); } catch { silentRead = 'missing'; }
        }
        const text = settings.text == null
          ? 'المخاطر: منخفضة.\nالملاحظات: ' + engine + ' read=' + silentRead + '.\nالتوصية: موافقة.\n[verdict: approve]'
          : settings.text;
        emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text }] } });
        emit({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 40, output_tokens: 12 } });
        emit({ type: 'proc_done', code: 0 });
      }, 20);
      return handle;
    },
  };
}

function reviewerFor(root, configs, statsByEngine, timeoutMs) {
  return reviewerModule.create({
    isolationRoot: root,
    timeoutMs: timeoutMs || 1000,
    resolveEngine(engine) {
      const config = configs[engine];
      if (config === false || !Object.prototype.hasOwnProperty.call(configs, engine)) return null;
      if (!statsByEngine[engine]) statsByEngine[engine] = makeStats();
      return reviewRunner(engine, statsByEngine[engine], config);
    },
  });
}

function startReview(reviewer, teamId, artifact, producerEngines) {
  return reviewer.start({
    teamId,
    artifactId: artifact.artifact_id,
    patch: artifact.patch,
    files: artifact.files,
    producerEngines,
  }, () => {});
}

async function completedReview(reviewer, teamId, label) {
  return waitFor(() => {
    const review = reviewer.latest(teamId);
    return review && ['completed', 'failed', 'timed_out', 'stopped'].includes(review.state) ? review : null;
  }, 3000, label);
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-review-merge-test-'));
  const project = await makeRepo(temp);
  const isolationRoot = path.join(temp, 'isolated-review-roots');
  await fsp.mkdir(isolationRoot, { recursive: true });
  const manager = worktrees.createManager({ root: path.join(temp, 'worktrees') });
  try {
    const baseHead = await git(project, ['rev-parse', 'HEAD']);
    const branch = await git(project, ['branch', '--show-current']);
    const made = await manager.create(project);
    assert.strictEqual(made.ok, true);
    await fsp.writeFile(path.join(made.worktree.path, 'src', 'app.js'), 'export const value = 2;\n', 'utf8');
    await fsp.writeFile(path.join(made.worktree.path, 'src', 'added.js'), 'export const added = true;\n', 'utf8');
    const diff = await manager.diff(made.worktree.id);
    const patchResult = await manager.patch(made.worktree.id);
    assert.strictEqual(diff.ok, true);
    assert.strictEqual(patchResult.ok, true);
    await manager.remove(made.worktree.id);

    const artifact = {
      schema_version: 1,
      artifact_id: executionTeamModule.artifactId(patchResult.head, patchResult.patch),
      team_id: 'execution-team-fixture',
      head: patchResult.head,
      patch: patchResult.patch,
      sourceRoot: patchResult.sourceRoot,
      producer_engines: ['sdk'],
      files: diff.files.map((file) => ({ ...file, agent_id: 'executor-1', engine: 'sdk' })),
    };
    assert.strictEqual(artifact.artifact_id, executionTeamModule.artifactId(baseHead, artifact.patch));
    assert.notStrictEqual(artifact.artifact_id, executionTeamModule.artifactId(baseHead + 'changed', artifact.patch));
    assert.notStrictEqual(artifact.artifact_id, executionTeamModule.artifactId(baseHead, artifact.patch + '\n'));

    const matrices = [
      { producers: ['sdk'], required: ['codex'] },
      { producers: ['codex'], required: ['sdk'] },
      { producers: ['sdk', 'codex'], required: ['sdk', 'codex'] },
    ];
    let approvedMixed = null;
    for (let index = 0; index < matrices.length; index++) {
      const matrix = matrices[index];
      const stats = {};
      const reviewer = reviewerFor(isolationRoot, { sdk: {}, codex: {} }, stats);
      const teamId = 'execution-team-matrix-' + index;
      const started = startReview(reviewer, teamId, artifact, matrix.producers);
      assert.strictEqual(started.ok, true);
      const review = await completedReview(reviewer, teamId, 'matrix ' + index);
      assert.strictEqual(review.state, 'completed');
      assert.deepStrictEqual(review.required_review_engines, matrix.required);
      assert.deepStrictEqual(review.reviews.map((item) => item.engine), matrix.required);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(review, 'patch'), false);
      assert(review.reviews.every((item) => !Object.prototype.hasOwnProperty.call(item, 'patch')));
      assert(review.reviews.every((item) => item.artifact_id === artifact.artifact_id));
      assert(review.reviews.every((item) => item.verdict.decision === 'approve'));
      assert.deepStrictEqual(review.verdict, { schema_version: 1, decision: 'approve', source: 'explicit' });
      for (const engine of matrix.required) {
        const call = stats[engine].calls[0];
        assert.strictEqual(call.input.permissionMode, 'plan');
        assert.strictEqual(call.input.model, engine + '-review-model');
        assert.strictEqual(call.input.browserControl, false);
        assert.deepStrictEqual(call.input.images, []);
        assert.deepStrictEqual(call.input.skills, []);
        assert.deepStrictEqual(call.input.extraDirs, []);
        assert.notStrictEqual(path.resolve(call.cwd), path.resolve(project));
        assert(!call.input.prompt.includes('executor-1'));
        assert(!call.input.prompt.includes('عامل 1'));
      }
      if (matrix.required.length === 2) {
        assert.strictEqual(stats.sdk.calls[0].input.prompt, stats.codex.calls[0].input.prompt);
        assert(!stats.sdk.calls[0].input.prompt.includes('codex read='));
        assert(!stats.codex.calls[0].input.prompt.includes('sdk read='));
        approvedMixed = review;
      }
    }

    const secretValue = 'SATR_REVIEW_SECRET_SHOULD_NOT_LEAK';
    await fsp.writeFile(path.join(project, 'confidential.txt'), secretValue, 'utf8');
    const isolationStats = {};
    const isolationReviewer = reviewerFor(isolationRoot, { codex: { silentRead: 'confidential.txt' } }, isolationStats);
    const isolationStarted = startReview(isolationReviewer, 'execution-team-isolation', artifact, ['sdk']);
    assert.strictEqual(isolationStarted.ok, true);
    const isolated = await completedReview(isolationReviewer, 'execution-team-isolation', 'isolated codex review');
    assert.strictEqual(isolated.state, 'completed');
    assert.strictEqual(isolated.reviews[0].engine, 'codex');
    assert(!isolated.summary.includes(secretValue));
    assert(isolated.summary.includes('read=missing'));
    const isolatedCwd = isolationStats.codex.calls[0].cwd;
    assert.notStrictEqual(path.resolve(isolatedCwd), path.resolve(project));
    assert.deepStrictEqual(isolationStats.codex.calls[0].parentEntries, ['workspace']);
    await waitFor(() => !fs.existsSync(isolatedCwd), 2000, 'isolated cwd cleanup');

    const forbiddenEvents = ['permission_request', 'tool_use', 'file_edit', 'model_term', 'preview_open'];
    for (const engine of ['sdk', 'codex']) {
      const producers = engine === 'sdk' ? ['codex'] : ['sdk'];
      for (const event of forbiddenEvents) {
        const stats = {};
        const reviewer = reviewerFor(isolationRoot, { [engine]: { event } }, stats);
        const teamId = 'execution-team-forbidden-' + engine + '-' + event.replace('_', '-');
        assert.strictEqual(startReview(reviewer, teamId, artifact, producers).ok, true);
        const failed = await completedReview(reviewer, teamId, engine + ' ' + event);
        assert.strictEqual(failed.state, 'failed');
        assert.strictEqual(failed.verdict.decision, 'changes_required');
        assert.strictEqual(failed.reviews[0].verdict, null);
        assert.strictEqual(stats[engine].stops, 1);
        if (event === 'permission_request') {
          assert.deepStrictEqual(stats[engine].permissions, [{ id: engine + '-permission', allow: false }]);
        }
      }
    }

    const unavailableStats = {};
    const unavailableReviewer = reviewerFor(isolationRoot, { sdk: {}, codex: false }, unavailableStats);
    const unavailable = startReview(unavailableReviewer, 'execution-team-unavailable', artifact, ['sdk']);
    assert.deepStrictEqual(unavailable, { ok: false, error: 'review_engine_unavailable', engine: 'codex' });
    assert.strictEqual(unavailableStats.sdk, undefined);

    const secretReviewer = reviewerFor(isolationRoot, { codex: {} }, {});
    const secretReview = secretReviewer.start({
      teamId: 'execution-team-secret', artifactId: artifact.artifact_id, producerEngines: ['sdk'],
      patch: 'diff --git a/.env b/.env\n+API_KEY=abcdefghijklmnopqrstuvwxyz123456', files: [],
    }, () => {});
    assert.strictEqual(secretReview.error, 'secret_detected');

    const verdictCases = [
      { text: '[verdict: approve]', decision: 'approve', source: 'explicit', alias: 'accept', allowed: true },
      { text: '[verdict: changes_required]', decision: 'changes_required', source: 'explicit', alias: 'modify', allowed: false },
      { text: '[verdict: reject]', decision: 'reject', source: 'explicit', alias: 'reject', allowed: false },
      { text: '[recommendation: accept]', decision: 'changes_required', source: 'fallback', alias: 'modify', allowed: false },
    ];
    for (let index = 0; index < verdictCases.length; index++) {
      const verdictCase = verdictCases[index];
      const stats = {};
      const reviewer = reviewerFor(isolationRoot, { codex: { text: verdictCase.text } }, stats);
      const teamId = 'execution-team-verdict-' + index;
      startReview(reviewer, teamId, artifact, ['sdk']);
      const review = await completedReview(reviewer, teamId, 'verdict ' + index);
      assert.deepStrictEqual(review.verdict, {
        schema_version: 1, decision: verdictCase.decision, source: verdictCase.source,
      });
      assert.strictEqual(reviewerModule.recommendationFor(review.verdict), verdictCase.alias);
      const gate = reviewerModule.mergeGate(review, { ...artifact, producer_engines: ['sdk'] }, review.id);
      assert.strictEqual(gate.ok, verdictCase.allowed);
      if (!verdictCase.allowed) assert.strictEqual(gate.error, 'review_not_approved');
    }

    const timedStats = {};
    const timedReviewer = reviewerFor(isolationRoot, { codex: { hang: true } }, timedStats, 30);
    startReview(timedReviewer, 'execution-team-timeout', artifact, ['sdk']);
    const timed = await completedReview(timedReviewer, 'execution-team-timeout', 'review timeout');
    assert.strictEqual(timed.state, 'timed_out');
    assert.strictEqual(timed.verdict.decision, 'changes_required');
    assert.strictEqual(reviewerModule.mergeGate(timed, artifact, timed.id).ok, false);

    assert(approvedMixed);
    const mixedArtifact = { ...artifact, producer_engines: ['sdk', 'codex'] };
    assert.deepStrictEqual(reviewerModule.mergeGate(approvedMixed, mixedArtifact, approvedMixed.id), { ok: true, verdict: 'approve' });
    const mixedDenyStats = {};
    const mixedDenyReviewer = reviewerFor(isolationRoot, {
      sdk: { text: '[verdict: approve]' }, codex: { text: '[verdict: changes_required]' },
    }, mixedDenyStats);
    startReview(mixedDenyReviewer, 'execution-team-mixed-deny', artifact, ['sdk', 'codex']);
    const mixedDenied = await completedReview(mixedDenyReviewer, 'execution-team-mixed-deny', 'mixed aggregate denial');
    assert.strictEqual(mixedDenied.verdict.decision, 'changes_required');
    assert.strictEqual(reviewerModule.mergeGate(mixedDenied, mixedArtifact, mixedDenied.id).error, 'review_not_approved');
    const changedArtifact = {
      ...mixedArtifact,
      patch: mixedArtifact.patch + '\n',
      artifact_id: executionTeamModule.artifactId(mixedArtifact.head, mixedArtifact.patch + '\n'),
    };
    assert.strictEqual(reviewerModule.mergeGate(approvedMixed, changedArtifact, approvedMixed.id).error, 'review_artifact_mismatch');
    const missingReview = { ...approvedMixed, reviews: approvedMixed.reviews.slice(0, 1) };
    assert.strictEqual(reviewerModule.mergeGate(missingReview, mixedArtifact, missingReview.id).error, 'review_required');

    const merger = mergerModule.create({ root: path.join(temp, 'merge-store') });
    const mergeInput = {
      cwd: project, sourceRoot: project, head: artifact.head, patch: artifact.patch,
      artifact_id: artifact.artifact_id, files: diff.files, confirmed: false,
      review_gate: { ok: true, verdict: 'approve' },
      verification: { artifact_id: artifact.artifact_id, state: 'passed', checks: [] },
    };
    const denied = await merger.apply(mergeInput);
    assert.strictEqual(denied.error, 'confirmation_required');
    assert.strictEqual(await readLf(path.join(project, 'src', 'app.js')), 'export const value = 1;\n');
    await fsp.rm(path.join(project, 'confidential.txt'));
    assert.strictEqual(await git(project, ['status', '--porcelain']), '');

    const conflictingPatch = artifact.patch.replace('export const value = 1;', 'export const missing = 999;');
    const conflictingId = executionTeamModule.artifactId(artifact.head, conflictingPatch);
    const conflict = await merger.apply({
      ...mergeInput, patch: conflictingPatch, artifact_id: conflictingId,
      verification: { artifact_id: conflictingId, state: 'passed', checks: [] }, confirmed: true,
    });
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
    const codexSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'codex.js'), 'utf8');
    assert(mainSource.includes("const unavailable = unavailableReviewEngines(['sdk'])"));
    assert(mainSource.includes('artifactId: artifact.artifact_id'));
    assert(mainSource.includes('producerEngines: artifact.producer_engines'));
    assert(mainSource.includes('reviewerModule.mergeGate(review, artifact, p.reviewId)'));
    assert(mainSource.includes('integration.gate(artifact, verification)'));
    assert(codexSource.includes('if (browserControl !== false) try'));
    assert(codexSource.includes("const DEFAULT_MODEL = 'gpt-5.6-sol'"));
    assert(codexSource.includes('model: resolvedModel'));
    assert(!mainSource.includes("review.recommendation !== 'accept'"));

    console.log('✓ cross-engine policy selects codex for sdk, sdk for codex, and both for mixed artifacts');
    console.log('✓ independent reviewers receive the same patch-only prompt and no worker or peer-review context');
    console.log('✓ every verdict is bound to artifact_id and head or patch changes invalidate the gate');
    console.log('✓ sdk and codex reviews fail closed on tools, permissions, edits, terminal, preview, and timeout');
    console.log('✓ codex reviewer runs in an empty isolated cwd and cannot silently read the project fixture secret');
    console.log('✓ aggregate approval requires every required explicit verdict and missing reviewers close the gate');
    console.log('✓ review-engine preflight and runtime availability failures occur without fallback');
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
