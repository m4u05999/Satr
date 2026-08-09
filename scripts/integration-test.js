#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const executionTeam = require('../electron/executionteam');
const integrationModule = require('../electron/integration');
const mergerModule = require('../electron/merger');
const verify = require('../electron/verify');
const worktreesModule = require('../electron/worktrees');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function commitAll(project, message) {
  await git(project, ['add', '-A']);
  await git(project, ['-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', message]);
  return git(project, ['rev-parse', 'HEAD']);
}

async function setConfig(project, commands, message, preview) {
  const created = verify.createConfig(project, commands.map((command) => ({
    ...command,
    label: typeof command.label === 'string' && command.label.trim() ? command.label : command.id,
    timeout_seconds: Number.isInteger(command.timeout_seconds) ? command.timeout_seconds : 120,
  })), { confirmed: true, overwrite: true, preview });
  assert.strictEqual(created.ok, true, 'فشل الكاتب الإنتاجي في إعداد fixture التكامل: ' + created.error);
  return commitAll(project, message);
}

async function makeArtifact(manager, project, mutate) {
  const created = await manager.create(project);
  assert.strictEqual(created.ok, true);
  try {
    await mutate(created.worktree.path);
    const captured = await manager.patch(created.worktree.id);
    assert.strictEqual(captured.ok, true);
    return {
      schema_version: 1,
      artifact_id: executionTeam.artifactId(captured.head, captured.patch),
      team_id: 'execution-team-fixture',
      cwd: project,
      sourceRoot: captured.sourceRoot,
      source_root: captured.sourceRoot,
      head: captured.head,
      patch: captured.patch,
      files: [],
      producer_engines: ['sdk'],
    };
  } finally {
    await manager.remove(created.worktree.id);
  }
}

async function assertCleanWorktrees(project) {
  const listed = await git(project, ['worktree', 'list', '--porcelain']);
  assert.strictEqual(listed.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length, 1);
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-integration-test-'));
  const project = path.join(temp, 'project');
  const manager = worktreesModule.createManager({ root: path.join(temp, 'worktrees') });
  const previewJobs = new Map();
  const previewCalls = [];
  let previewSequence = 0;
  let previewStartError = '';
  const fakeTermjobs = {
    startJob(cwd, command, label, options) {
      if (previewStartError) return { ok: false, error: previewStartError };
      const id = 'preview-job-' + (++previewSequence);
      previewJobs.set(id, { id, cwd, command, label, options });
      previewCalls.push(previewJobs.get(id));
      return { ok: true, id };
    },
    info(id) { return previewJobs.get(id) || null; },
    stop(id) { return previewJobs.delete(id) ? { ok: true } : { ok: false, error: 'no_job' }; },
  };
  const integration = integrationModule.create({
    worktrees: manager,
    termjobs: fakeTermjobs,
    waitForUrl: async () => ({ ok: true }),
  });
  const merger = mergerModule.create({ root: path.join(temp, 'merge') });
  try {
    await fsp.mkdir(path.join(project, 'src'), { recursive: true });
    await fsp.mkdir(path.join(project, 'checks'), { recursive: true });
    await fsp.writeFile(path.join(project, 'src', 'app.txt'), 'base\n', 'utf8');
    await fsp.writeFile(path.join(project, 'checks', 'success.js'),
      "const fs=require('fs'); process.exit(fs.readFileSync('src/app.txt','utf8').trim()==='changed'?0:9);\n", 'utf8');
    await fsp.writeFile(path.join(project, 'checks', 'fail.js'), "console.log('SECRET_TOKEN_DO_NOT_PUBLISH'); process.exit(7);\n", 'utf8');
    await fsp.writeFile(path.join(project, 'checks', 'timeout.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
    await git(project, ['init']);
    await setConfig(project, [{ id: 'test', label: 'اختبار الأثر', command: 'node checks/success.js', timeout_seconds: 10 }], 'base', {
      command: 'node checks/preview.js', url: 'http://localhost:4319/', timeout_seconds: 20,
    });

    const successArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.writeFile(path.join(worktree, 'src', 'app.txt'), 'changed\n', 'utf8');
    });
    const sourceBefore = await fsp.readFile(path.join(project, 'src', 'app.txt'), 'utf8');
    const preflight = await integration.preflight(project);
    assert.strictEqual(preflight.ok, true);
    assert.deepStrictEqual(preflight.checks.map((check) => check.command), ['node checks/success.js']);
    const prepared = await integration.prepare(successArtifact);
    assert.strictEqual(prepared.ok, true);
    assert.strictEqual(prepared.verification.state, 'pending_confirmation');
    await writeJson(path.join(project, '.satr', 'verify.json'), {
      version: 1, commands: [{ id: 'disk-only', command: 'node checks/fail.js', timeout_seconds: 10 }],
    });
    assert.deepStrictEqual(prepared.verification.checks.map((check) => check.command), ['node checks/success.js']);
    const denied = await integration.run(successArtifact, false);
    assert.strictEqual(denied.error, 'confirmation_required');
    await assertCleanWorktrees(project);
    const passed = await integration.run(successArtifact, true);
    assert.strictEqual(passed.ok, true);
    assert.deepStrictEqual(passed.verification, {
      artifact_id: successArtifact.artifact_id,
      state: 'passed',
      checks: [{ id: 'test', label: 'اختبار الأثر', passed: true, exit_code: 0, timed_out: false, duration_ms: passed.verification.checks[0].duration_ms }],
    });
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.txt'), 'utf8'), sourceBefore);
    assert((await fsp.readFile(path.join(project, '.satr', 'verify.json'), 'utf8')).includes('disk-only'));
    await assertCleanWorktrees(project);

    assert.strictEqual((await integration.preparePreview(successArtifact, false)).error, 'confirmation_required');
    const unverifiedIntegration = integrationModule.create({
      worktrees: manager, termjobs: fakeTermjobs, waitForUrl: async () => ({ ok: true }),
    });
    assert.strictEqual((await unverifiedIntegration.preparePreview(successArtifact, true)).error, 'verification_required');
    const previewed = await integration.preparePreview({ ...successArtifact, command: 'node external-evil.js' }, true);
    assert.strictEqual(previewed.ok, true);
    assert.strictEqual(previewed.url, 'http://localhost:4319/');
    assert.strictEqual(previewCalls[0].command, 'node checks/preview.js');
    assert.strictEqual(previewCalls[0].options.recordDevServer, false);
    assert.strictEqual(previewCalls[0].options.publicCwd, '');
    assert.notStrictEqual(path.resolve(previewCalls[0].cwd), path.resolve(project));
    assert.strictEqual((await integration.preparePreview(successArtifact, true)).error, 'busy');
    // البند 20: حقيقة المعاينة الحية لكل cwd — true أثناء التشغيل، false لغير المشروع.
    assert.strictEqual(integration.previewActiveFor(project), true);
    assert.strictEqual(integration.previewActiveFor(path.join(temp, 'not-a-project')), false);
    assert.strictEqual(integration.previewActiveFor(''), false);
    assert.strictEqual((await integration.stopPreview()).ok, true);
    assert.strictEqual(integration.previewActiveFor(project), false); // تعود false بعد الإيقاف
    assert.strictEqual(previewJobs.size, 0);
    await assertCleanWorktrees(project);

    previewStartError = 'preview_start_failed';
    const previewFailure = await integration.preparePreview(successArtifact, true);
    assert.strictEqual(previewFailure.error, 'preview_start_failed');
    previewStartError = '';
    await assertCleanWorktrees(project);

    let failPreviewRemoval = false;
    const cleanupManager = {
      ...manager,
      remove: (id) => failPreviewRemoval ? Promise.resolve({ ok: false, error: 'remove_failed' }) : manager.remove(id),
    };
    const cleanupIntegration = integrationModule.create({
      worktrees: cleanupManager,
      termjobs: fakeTermjobs,
      waitForUrl: async () => ({ ok: true }),
    });
    assert.strictEqual((await cleanupIntegration.prepare(successArtifact)).ok, true);
    assert.strictEqual((await cleanupIntegration.run(successArtifact, true)).ok, true);
    assert.strictEqual((await cleanupIntegration.preparePreview(successArtifact, true)).ok, true);
    failPreviewRemoval = true;
    const cleanupFailed = await cleanupIntegration.stopPreview();
    assert.strictEqual(cleanupFailed.error, 'cleanup_failed');
    assert.strictEqual(cleanupFailed.preview.state, 'cleanup_failed');
    failPreviewRemoval = false;
    assert.strictEqual((await cleanupIntegration.stopPreview()).ok, true);
    await assertCleanWorktrees(project);

    let delayPreviewCreate = false;
    const racingManager = {
      ...manager,
      async create(cwd, head) {
        if (delayPreviewCreate) await new Promise((resolve) => setTimeout(resolve, 100));
        return manager.create(cwd, head);
      },
    };
    const racingIntegration = integrationModule.create({
      worktrees: racingManager,
      termjobs: fakeTermjobs,
      waitForUrl: async () => ({ ok: true }),
    });
    assert.strictEqual((await racingIntegration.prepare(successArtifact)).ok, true);
    assert.strictEqual((await racingIntegration.run(successArtifact, true)).ok, true);
    delayPreviewCreate = true;
    const startingPreview = racingIntegration.preparePreview(successArtifact, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual((await racingIntegration.stopPreview()).ok, true);
    assert.strictEqual((await startingPreview).error, 'preview_stopped');
    await assertCleanWorktrees(project);

    await setConfig(project, [{ id: 'fail', label: 'فشل مقصود', command: 'node checks/fail.js', timeout_seconds: 10 }], 'failure config');
    const failingArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.writeFile(path.join(worktree, 'src', 'app.txt'), 'changed\n', 'utf8');
    });
    assert.strictEqual((await integration.prepare(failingArtifact)).ok, true);
    const failed = await integration.run(failingArtifact, true);
    assert.strictEqual(failed.verification.state, 'failed');
    assert.strictEqual(failed.verification.checks[0].exit_code, 7);
    assert(!JSON.stringify(failed).includes('SECRET_TOKEN_DO_NOT_PUBLISH'));
    assert(!Object.prototype.hasOwnProperty.call(failed.verification.checks[0], 'output'));
    assert(!Object.prototype.hasOwnProperty.call(failed.verification.checks[0], 'command'));
    await assertCleanWorktrees(project);

    await setConfig(project, [{ id: 'timeout', label: 'مهلة', command: 'node checks/timeout.js', timeout_seconds: 1 }], 'timeout config');
    const timeoutArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.writeFile(path.join(worktree, 'src', 'app.txt'), 'changed\n', 'utf8');
    });
    await integration.prepare(timeoutArtifact);
    const timed = await integration.run(timeoutArtifact, true);
    assert.strictEqual(timed.verification.state, 'failed');
    assert.strictEqual(timed.verification.checks[0].timed_out, true);
    await assertCleanWorktrees(project);

    await setConfig(project, [{ id: 'stop', label: 'مقاطعة', command: 'node checks/timeout.js', timeout_seconds: 30 }], 'stop config');
    const stoppedArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.writeFile(path.join(worktree, 'src', 'app.txt'), 'changed\n', 'utf8');
    });
    await integration.prepare(stoppedArtifact);
    const running = integration.run(stoppedArtifact, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual((await integration.stop(stoppedArtifact.artifact_id)).ok, true);
    const stopped = await running;
    assert.strictEqual(stopped.verification.state, 'failed');
    await assertCleanWorktrees(project);

    await fsp.rm(path.join(project, '.satr', 'verify.json'));
    await commitAll(project, 'missing config');
    const missing = await integration.preflight(project);
    assert.strictEqual(missing.error, 'verification_config_required');
    assert(missing.message.includes('.satr/verify.json'));

    await fsp.mkdir(path.join(project, '.satr'), { recursive: true });
    await fsp.writeFile(path.join(project, '.satr', 'verify.json'), '{not-json}\n', 'utf8');
    await commitAll(project, 'invalid config');
    assert.strictEqual((await integration.preflight(project)).error, 'verification_config_required');

    await setConfig(project, [{ id: 'test', label: 'اختبار الأثر', command: 'node checks/success.js', timeout_seconds: 10 }], 'restore config');
    const changedConfigArtifact = await makeArtifact(manager, project, async (worktree) => {
      await writeJson(path.join(worktree, '.satr', 'verify.json'), {
        version: 1, commands: [{ id: 'evil', command: 'node checks/fail.js' }],
      });
    });
    const changedConfig = await integration.prepare(changedConfigArtifact);
    assert.strictEqual(changedConfig.error, 'verification_config_changed');
    await assertCleanWorktrees(project);

    const renamedConfigArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.rename(path.join(worktree, '.satr', 'verify.json'), path.join(worktree, '.satr', 'verify.old.json'));
    });
    assert.strictEqual((await integration.prepare(renamedConfigArtifact)).error, 'verification_config_changed');
    await assertCleanWorktrees(project);

    const currentArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.writeFile(path.join(worktree, 'src', 'app.txt'), 'changed\n', 'utf8');
    });
    await integration.prepare(currentArtifact);
    const currentPassed = await integration.run(currentArtifact, true);
    const alteredPatch = currentArtifact.patch + '\n';
    const alteredArtifact = {
      ...currentArtifact,
      patch: alteredPatch,
      artifact_id: executionTeam.artifactId(currentArtifact.head, alteredPatch),
    };
    assert.strictEqual(integration.gate(alteredArtifact, currentPassed.verification).error, 'verification_artifact_mismatch');
    assert.strictEqual((await integration.run(alteredArtifact, true)).error, 'verification_prepare_required');

    const reviewGate = { ok: true, verdict: 'approve' };
    const unverifiedMerge = await merger.apply({ ...currentArtifact, review_gate: reviewGate, confirmed: true });
    assert.strictEqual(unverifiedMerge.error, 'verification_required');
    const merged = await merger.apply({
      ...currentArtifact, review_gate: reviewGate, verification: currentPassed.verification, confirmed: true,
    });
    assert.strictEqual(merged.ok, true);
    assert.strictEqual((await fsp.readFile(path.join(project, 'src', 'app.txt'), 'utf8')).trim(), 'changed');
    assert.strictEqual(await git(project, ['rev-parse', 'HEAD']), currentArtifact.head);
    assert((await git(project, ['status', '--porcelain'])).includes('src/app.txt'));
    await assertCleanWorktrees(project);

    // ── البند 23: أكواد الخروج المعروفة تُترجم عربياً (additive بقائمة سماح) ──
    const STOP_LABEL = 'أُوقف (Ctrl+C أو إيقاف مقصود)';
    const CRASH_LABEL = 'انهيار: وصول غير صالح للذاكرة';
    // الخريطة النقية: المعروف فقط، وغيره '' (لا تخمين).
    assert.strictEqual(verify.exitLabel(-1073741510), STOP_LABEL);
    assert.strictEqual(verify.exitLabel(-1073741819), CRASH_LABEL);
    assert.strictEqual(verify.exitLabel(7), '');
    assert.strictEqual(verify.exitLabel(0), '');
    assert.strictEqual(verify.exitLabel(null), '');
    // runChecks يضيف exit_label للكود المعروف فقط (يبقى الصف القديم حرفياً لغيره).
    const fakeExit = (code) => ({ execute: async () => ({ ok: false, exitCode: code, timedOut: false, output: '' }) });
    const stopRow = (await verify.runChecks('.', [{ id: 'stop', label: 'مقاطعة', command: 'x', timeout_seconds: 5 }], {}, fakeExit(-1073741510))).checks[0];
    assert.strictEqual(stopRow.exit_label, STOP_LABEL);
    assert.strictEqual(stopRow.exit_code, -1073741510);
    const crashRow = (await verify.runChecks('.', [{ id: 'crash', label: 'انهيار', command: 'x', timeout_seconds: 5 }], {}, fakeExit(-1073741819))).checks[0];
    assert.strictEqual(crashRow.exit_label, CRASH_LABEL);
    const plainRow = (await verify.runChecks('.', [{ id: 'plain', label: 'عادي', command: 'x', timeout_seconds: 5 }], {}, fakeExit(7))).checks[0];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(plainRow, 'exit_label'), false);
    // بوابة integration تمرّر exit_label إلى الحدث/التخزين المقصوص (publicChecks).
    const labelVerify = Object.assign({}, verify, {
      runChecks: async () => ({
        ok: true, schema_version: 1, passed: false, summary: '',
        checks: [{ id: 'test', label: 'اختبار الأثر', command: 'x', passed: false,
          exit_code: -1073741510, timed_out: false, duration_ms: 4, exit_label: STOP_LABEL, output: '' }],
      }),
    });
    const labelIntegration = integrationModule.create({
      worktrees: manager, termjobs: fakeTermjobs, verify: labelVerify, waitForUrl: async () => ({ ok: true }),
    });
    const labelArtifact = await makeArtifact(manager, project, async (worktree) => {
      await fsp.writeFile(path.join(worktree, 'src', 'app.txt'), 'labelled\n', 'utf8');
    });
    assert.strictEqual((await labelIntegration.prepare(labelArtifact)).ok, true);
    const labelled = await labelIntegration.run(labelArtifact, true);
    assert.strictEqual(labelled.verification.checks[0].exit_label, STOP_LABEL);
    assert.strictEqual(labelled.verification.checks[0].exit_code, -1073741510);
    assert(!Object.prototype.hasOwnProperty.call(labelled.verification.checks[0], 'command'));
    await assertCleanWorktrees(project);

    const mainSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(mainSource.includes("ipcMain.handle('satr:executionPreviewStart'")
      && mainSource.includes("Object.prototype.hasOwnProperty.call(p, 'command')"));
    assert(mainSource.includes('const previewCleanup = await integration.stopPreview();'));
    assert(mainSource.includes('integration.stopAll();'));
    // البند 20: فحص ساكن لعقد devServerInfo — يعيد integration_preview من حقيقة integration.
    const devInfoBlock = mainSource.slice(mainSource.indexOf("ipcMain.handle('satr:devServerInfo'"),
      mainSource.indexOf("ipcMain.handle('satr:devServerRestart'"));
    assert(devInfoBlock.includes('integration.previewActiveFor(cwd)')
      && devInfoBlock.includes('integration_preview: integrationPreview'),
      'devServerInfo يجب أن يعيد integration_preview من حقيقة integration (البند 20).');

    console.log('✓ commands come only from verify.json at artifact HEAD and require independent confirmation');
    console.log('✓ integration worktree passes, fails, times out, stops, and is removed on every path');
    console.log('✓ config absence and artifact edits to verification policy fail closed');
    console.log('✓ public verification results omit commands, raw output, and secrets');
    console.log('✓ verification is bound to artifact_id and merger keeps review, verification, HEAD, and cleanliness guards');
    console.log('✓ source remains untouched until explicit merge and no commit or history operation is created');
    console.log('✓ preview requires passed verification and confirmation, reads its command from HEAD, stays unique, and cleans up');
    console.log('✓ known exit codes translate to Arabic exit_label additively and forward through public checks (item 23)');
    console.log('✓ devServerInfo distinguishes a live temporary integration preview per cwd (item 20)');
  } finally {
    await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
