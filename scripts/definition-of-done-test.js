#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const integrationModule = require('../electron/integration');
const looprunner = require('../electron/looprunner');
const skills = require('../electron/skills');
const skillwriter = require('../electron/skillwriter');
const verify = require('../electron/verify');
const worktrees = require('../electron/worktrees');

const DOC_PATH = path.resolve(__dirname, '..', 'docs', 'DEFINITION-OF-DONE.md');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function commitAll(project, message) {
  await git(project, ['add', '-A']);
  await git(project, ['-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', message]);
  return git(project, ['rev-parse', 'HEAD']);
}

function completingRunner(stats) {
  return {
    engine: 'sdk',
    model: 'definition-of-done-test',
    start(input, cwd, emit) {
      stats.starts++;
      let stopped = false;
      const timer = setTimeout(() => {
        if (stopped) return;
        if (input.permissionMode === 'plan') {
          emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text: 'المعايير مستوفاة.\n[verdict: approve]' }] } });
        } else {
          const target = path.join(cwd, 'src', 'app.js');
          emit({ type: 'assistant', session_id: 'dod-session', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: target } }] } });
          fs.writeFileSync(target, 'export const ready = true;\nexport const reviewed = true;\n', 'utf8');
          emit({ type: 'file_edit', id: 'dod-edit', rel: 'src/app.js', added: 1, removed: 0 });
          emit({ type: 'assistant', session_id: 'dod-session', message: { content: [{ type: 'text', phase: 'final_answer', text: 'تم التعديل.' }] } });
        }
        emit({ type: 'result', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, estimate: true } });
        emit({ type: 'proc_done', code: 0 });
      }, 20);
      return { stop() { stopped = true; clearTimeout(timer); return Promise.resolve(); } };
    },
  };
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

async function testQualitativeReviewChain() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-dod-review-'));
  const project = path.join(temp, 'project');
  const manager = worktrees.createManager({ root: path.join(temp, 'worktrees') });
  let loops = null;
  try {
    await fsp.mkdir(path.join(project, 'src'), { recursive: true });
    await fsp.writeFile(path.join(project, 'src', 'app.js'), 'export const ready = true;\n', 'utf8');
    await git(project, ['init']);

    const reviewSkill = {
      name: 'quality-review',
      description: 'يراجع جودة التغيير وفق معايير المشروع.',
      criteria: '# معايير المراجعة\n\n- اربط كل ملاحظة بدليل ظاهر، ولا تخمّن.',
    };
    const createdSkill = skillwriter.createSkill(project, reviewSkill, { confirmed: true, overwrite: false });
    assert.strictEqual(createdSkill.ok, true, 'skillwriter.createSkill must create the project review skill');

    const commands = [{
      id: 'test', label: 'الاختبارات', command: 'node -e "process.exit(0)"', timeout_seconds: 10,
    }];
    const reviewReference = { name: reviewSkill.name };
    const createdConfig = verify.createConfig(project, commands, {
      confirmed: true, overwrite: false, reviewSkill: reviewReference,
    });
    assert.strictEqual(createdConfig.ok, true, 'verify.createConfig must write review_skill');
    const configSource = await fsp.readFile(path.join(project, '.satr', 'verify.json'), 'utf8');
    const normalizedReview = { name: reviewSkill.name, timeout_seconds: verify.DEFAULT_REVIEW_TIMEOUT_SECONDS };
    assert.deepStrictEqual(JSON.parse(configSource).review_skill, normalizedReview, 'review_skill must exist on disk');

    const loaded = verify.loadConfig(project);
    assert.strictEqual(loaded.ok, true, 'verify.loadConfig must load the written config');
    assert.deepStrictEqual(loaded.review_skill, normalizedReview,
      'verify.loadConfig must return the normalized review skill');
    const discovered = skills.discoverSkills(project).find((entry) => entry.name === reviewSkill.name);
    assert.ok(discovered, 'skills.discoverSkills must find the created review skill');
    assert.strictEqual(discovered.source, 'project', 'the created review skill must come from the project');

    const committedHead = await commitAll(project, 'qualitative review chain');
    assert.strictEqual(await git(project, ['status', '--porcelain']), '', 'the committed fixture must be clean');
    assert.strictEqual(await git(project, ['rev-parse', 'HEAD']), committedHead, 'the fixture must stay on the committed HEAD');
    assert.strictEqual((await git(project, ['show', 'HEAD:.satr/verify.json'])).replace(/\r\n/g, '\n'), configSource.trim(),
      'HEAD must contain the same verify config loaded from disk');
    assert.deepStrictEqual(verify.loadConfig(project).review_skill, loaded.review_skill,
      'verify.loadConfig must preserve the normalized review skill after commit');

    const integration = integrationModule.create({ worktrees: manager });
    const stats = { starts: 0 };
    const events = [];
    loops = looprunner.create({ runner: completingRunner(stats), worktrees: manager, integration, verify });
    const started = await loops.start({
      task: 'تحقق من وصلة المراجعة', ownership: ['**'], roomId: 'ops-room-dod-review',
      maxIterations: 3, budgetTokens: 400000, timeoutMs: 300000,
    }, project, (event) => events.push(event));
    assert.strictEqual(started.ok, true, 'loop preflight must pass with the review skill in HEAD');
    assert.strictEqual(started.loop.review.configured, true, 'the loop must expose the configured review stage');
    await waitFor(() => events.some((event) => event.type === 'loop_update' && event.state === 'passed'),
      15000, 'qualitative review loop pass');
    await loops.stopAll();

    await fsp.rm(path.join(project, '.agents', 'skills', reviewSkill.name), { recursive: true, force: true });
    await commitAll(project, 'remove qualitative review skill');
    assert.strictEqual(verify.loadConfig(project).ok, true, 'the committed verify config must remain readable after skill deletion');
    const rejectedStats = { starts: 0 };
    loops = looprunner.create({ runner: completingRunner(rejectedStats), worktrees: manager, integration, verify });
    const rejected = await loops.start({
      task: 'تحقق من غياب المهارة', ownership: ['**'], roomId: 'ops-room-dod-review-missing',
      maxIterations: 3, budgetTokens: 400000, timeoutMs: 300000,
    }, project, () => {});
    assert.strictEqual(rejected.ok, false, 'loop preflight must reject a missing review skill');
    assert.strictEqual(rejected.error, 'review_skill_unavailable');
    assert.strictEqual(rejectedStats.starts, 0, 'the worker must not start after preflight rejection');

    const badName = skillwriter.createSkill(project, { ...reviewSkill, name: '../escape' }, { confirmed: true, overwrite: false });
    assert.strictEqual(badName.error, 'bad_name', 'a malformed skill name must be rejected');
    const secretCriteria = skillwriter.createSkill(project, {
      ...reviewSkill, name: 'secret-review', criteria: 'api_key=abcdefghijklmnop-secret',
    }, { confirmed: true, overwrite: false });
    assert.strictEqual(secretCriteria.error, 'secret', 'criteria containing a secret must be rejected');

    const outside = path.join(temp, 'outside');
    const linkedProject = path.join(temp, 'linked-project');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(linkedProject, { recursive: true });
    await fsp.symlink(outside, path.join(linkedProject, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = skillwriter.createSkill(linkedProject, reviewSkill, { confirmed: true, overwrite: false });
    assert(['symlink', 'outside'].includes(linked.error), 'a symlinked skill root must be rejected');
    assert.strictEqual(fs.existsSync(path.join(outside, 'skills', reviewSkill.name, 'SKILL.md')), false,
      'the symlink rejection must not write outside the project');
  } finally {
    if (loops) await loops.stopAll().catch(() => {});
    await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

async function main() {
  const doc = await fsp.readFile(DOC_PATH, 'utf8');

  assert(doc.length > 0, 'الوثيقة فارغة.');

  const requiredHeadings = [
    '## 1. الهدف والنطاق',
    '## 2. التمييز بين المصطلحات',
    '## 3. الحقول المطلوبة لكل تذكرة',
    '## 4. مستويات التحقق',
    '## 5. متطلبات تغييرات IPC',
    '## 6. متطلبات تغييرات الواجهة',
    '## 7. متطلبات الأدلة',
    '## 8. سياسة الشجرة المتسخة',
    '## 9. تصنيف النتائج',
    '## 10. قواعد إغلاق المهمة',
    '## 11. سياسة الفشل',
    '## 12. قائمة تحقق قابلة للنسخ',
  ];

  for (const heading of requiredHeadings) {
    assert(doc.includes(heading), `يفتقد الوثيقة العنوان: ${heading}`);
  }

  const terms = [
    'Acceptance Criteria',
    'Definition of Done',
    'Verification Evidence',
    'Reported Result',
    'Verified Evidence',
    'Reported Pass',
    'Not Run',
    'Blocked',
  ];

  for (const term of terms) {
    assert(doc.includes(term), `يفتقد الوثيقة المصطلح: ${term}`);
  }

  assert(doc.includes('Verified Evidence'), 'لا يذكر الوثيقة Verified Evidence.');
  assert(doc.includes('Reported Pass'), 'لا يذكر الوثيقة Reported Pass.');
  assert(
    doc.includes('Verified Evidence') && doc.includes('Reported Pass') && doc.includes('## 9. تصنيف النتائج'),
    'الفصل بين Verified Evidence و Reported Pass غير واضح.'
  );

  assert(doc.includes('base_commit'), 'لا يذكر الوثيقة base_commit.');
  assert(doc.includes('working_tree_dirty'), 'لا يذكر الوثيقة حالة الشجرة المتسخة.');
  assert(doc.includes('git status'), 'لا يذكر الوثيقة git status.');
  assert(doc.includes('لا يجوز الادعاء'), 'لا يذكر الوثيقة تحذير الادعاء بـ commit وحده.');

  assert(doc.includes('IPC'), 'لا يذكر الوثيقة IPC.');
  assert(doc.includes('CSP'), 'لا يذكر الوثيقة CSP.');
  assert(doc.includes('RTL'), 'لا يذكر الوثيقة RTL.');
  assert(doc.includes('contextIsolation'), 'لا يذكر الوثيقة contextIsolation.');
  assert(doc.includes('sandbox'), 'لا يذكر الوثيقة sandbox.');
  assert(doc.includes('nodeIntegration'), 'لا يذكر الوثيقة nodeIntegration.');
  assert(doc.includes('ipcRenderer'), 'لا يذكر الوثيقة ipcRenderer.');

  const dangerousPatterns = [
    'git reset --hard',
    'git checkout --',
    'git clean',
    'rm -rf',
    'del /f /s /q',
  ];

  const lines = doc.split(/\r?\n/);
  for (const pattern of dangerousPatterns) {
    const lowerPattern = pattern.toLowerCase();
    for (const line of lines) {
      if (line.toLowerCase().includes(lowerPattern)) {
        const isProhibited = /(لا|ممنوع|خطير|يمنع|يحظر|يحتوي على)/u.test(line);
        assert(isProhibited, `الوثيقة تحتوي على أمر خطير بدون نهي واضح: ${pattern}\n${line}`);
      }
    }
  }

  assert(doc.includes('test:full'), 'لا تربط الوثيقة الإنجاز بـ test:full.');
  assert(doc.includes('12. قائمة تحقق'), 'لا توجد قائمة تحقق قابلة للنسخ.');

  await testQualitativeReviewChain();

  console.log('✓ document exists and contains required structure');
  console.log('✓ distinguishes Verified Evidence from Reported Pass');
  console.log('✓ covers dirty tree policy');
  console.log('✓ covers IPC, CSP, and RTL requirements');
  console.log('✓ contains no dangerous command suggestions');
  console.log('✓ qualitative review chain: createSkill → createConfig/loadConfig → discoverSkills(project)');
  console.log('✓ loop preflight accepts the committed skill and rejects its committed deletion');
  console.log('✓ qualitative review rejects malformed names, secrets, and symlinks');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
