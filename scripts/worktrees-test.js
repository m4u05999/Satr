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

// علامة المدخل المعطوب الصريحة كما يصدرها Claude Code: مفتاح وحيد __unparsedToolInput قيمته
// {raw:string, len:number}.
const UNPARSED = { __unparsedToolInput: { raw: '{"file_path": "x", "offset": 1,, "limit": 5}', len: 44 } };

// runner مبرمَج (محرك sdk ليُفعَّل وسم SDK). أنواع الكتل:
//  { name, input }                 ⇒ tool_use فقط
//  { name, input, error }          ⇒ tool_use ثم tool_result is_error:true (نُفّذ وفشل)
//  { readFail: rel }               ⇒ Read بمسار داخلي صالح + tool_result is_error:true
//  { write: rel }                  ⇒ Edit صالح + file_edit + tool_result is_error:false
//  { permission, name, input, id } ⇒ permission_request
function scriptedRunner(stats, blocks) {
  return {
    engine: 'sdk',
    start(input, cwd, emit) {
      stats.inputs.push({ input, cwd });
      let stopped = false;
      let seq = 0;
      const handle = {
        resolvePermission(id, allow) { stats.permissions.push({ id, allow }); return true; },
        stop() { if (!stopped) { stopped = true; stats.stops++; } return Promise.resolve(); },
      };
      const toolResult = (id, isError) => emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });
      setTimeout(() => {
        for (const b of blocks) {
          if (stopped) return;
          if (b.permission) {
            emit({ type: 'permission_request', id: b.id || 'perm-1', tool: b.name, input: b.input });
          } else if (b.write) {
            const id = 'tu-' + (seq++);
            const target = path.join(cwd, b.write);
            emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: target } }] } });
            fs.writeFileSync(target, 'export const value = 3;\n', 'utf8');
            emit({ type: 'file_edit', id: 'edit-' + id, rel: b.write, added: 1, removed: 1 });
            toolResult(id, false);
          } else if (b.readFail) {
            const id = 'tu-' + (seq++);
            emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path.join(cwd, b.readFail) } }] } });
            toolResult(id, true);
          } else {
            const id = 'tu-' + (seq++);
            emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: b.name, input: b.input }] } });
            if (b.error) toolResult(id, true);
          }
        }
        if (stopped) return;
        emit({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 4 } });
        emit({ type: 'proc_done', code: 0 });
      }, 20);
      return handle;
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
    assert.strictEqual(completed.last_tool, 'edit');
    assert.strictEqual(completed.last_file, 'src/new.js');
    assert(!path.isAbsolute(completed.last_file));
    assert(completed.last_activity_at >= completed.created_at);
    assert.strictEqual(completed.timeout_ms, 1000);
    assert.strictEqual(completed.deadline_at, completed.created_at + completed.timeout_ms);
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
    assert.strictEqual(timedDone.failure_code, 'timeout');
    assert.strictEqual(timeoutManager.get(timedDone.worktree.id), null);

    const stopStats = { inputs: [], stops: 0 };
    const stopManager = worktrees.createManager({ root: path.join(temp, 'store-stop') });
    managers.push(stopManager);
    const stopped = executorModule.create({ worktrees: stopManager, runner: hangingRunner(stopStats), timeoutMs: 1000 });
    const running = await stopped.start({ task: 'مهمة ستتوقف' }, project, () => {});
    assert.strictEqual(running.run.can_extend, true);
    const extended = stopped.extend(running.run.id);
    assert.strictEqual(extended.ok, true);
    assert.strictEqual(extended.run.timeout_ms, 180000);
    assert.strictEqual(extended.run.extended, true);
    assert.strictEqual(extended.run.can_extend, false);
    assert.strictEqual(stopped.extend(running.run.id).ok, false);
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
    assert(outsideDone.error.includes('سياسة الأدوات'));
    assert.strictEqual(outsideDone.failure_code, 'policy_violation');
    assert.strictEqual(outsideStats.stops, 1);
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');

    // إصلاح صفر (بعد مراجعة cross-engine): تحمّل مدخل أداة معطوب بعلامة SDK الصريحة فقط،
    // مع إبقاء كل ما عداه fail-closed.
    let malSeq = 0;
    const runScript = async (label, blocks) => {
      const stats = { inputs: [], permissions: [], stops: 0 };
      const mgr = worktrees.createManager({ root: path.join(temp, 'store-mal-' + (malSeq++)) });
      managers.push(mgr);
      const ex = executorModule.create({ worktrees: mgr, runner: scriptedRunner(stats, blocks), timeoutMs: 1000 });
      await ex.start({ task: label }, project, () => {});
      return { ex, stats };
    };
    const waitState = (ex, state) => waitFor(() => { const r = ex.latest(project); return r && r.state === state ? r : null; }, 3000);

    // (أ) علامة معطوبة صريحة ×3 ثم أداة صالحة ⇒ العامل يكمل، والمصدر الأصلي محفوظ (عزل)
    const mA = await runScript('علامة معطوبة ثم صالحة', [
      { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { write: 'src/app.js' },
    ]);
    assert(await waitState(mA.ex, 'completed'), 'المدخل المعطوب الصريح ضمن الميزانية يجب ألا يوقف العامل');
    assert.strictEqual(await fsp.readFile(path.join(project, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');

    // (ب) الحد الدقيق: الرابعة المتتالية تفشل مغلقاً (منع loop)
    const mB = await runScript('معطوب متكرر', [
      { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED },
    ]);
    assert.strictEqual((await waitState(mB.ex, 'failed')).failure_code, 'policy_violation', 'الرابعة المتتالية يجب أن تفشل مغلقاً');

    // (ج) مدخل بلا علامة صريحة (schema مجهولة/بلا مسار) يبقى fail-closed لا malformed
    const mC = await runScript('بلا علامة', [{ name: 'Read', input: {} }]);
    assert.strictEqual((await waitState(mC.ex, 'failed')).failure_code, 'policy_violation', 'المدخل بلا علامة صريحة يبقى fail-closed');

    // (د) أداة محظورة بعلامة معطوبة تبقى forbidden (fail-closed)
    const mD = await runScript('محظور بعلامة', [{ name: 'Bash', input: UNPARSED }]);
    assert.strictEqual((await waitState(mD.ex, 'failed')).failure_code, 'policy_violation', 'المحظور بعلامة يبقى fail-closed');

    // (هـ) العدّاد متتالي: أداة صالحة تصفّره فلا يتراكم المعطوب المتباعد
    const mE = await runScript('معطوب متباعد بصالح', [
      { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { write: 'src/app.js' },
      { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { write: 'src/app.js' },
    ]);
    assert(await waitState(mE.ex, 'completed'), 'أداة صالحة تصفّر عدّاد المعطوب المتتالي');

    // (و) permission_request بعلامة معطوبة يُرفض بلا استهلاك ميزانية كتابة
    const mF = await runScript('إذن بعلامة معطوبة', [{ permission: true, name: 'Edit', input: UNPARSED, id: 'perm-mal' }]);
    const mFDone = await waitState(mF.ex, 'completed');
    const permReply = mF.stats.permissions.find((p) => p.id === 'perm-mal');
    assert(permReply && permReply.allow === false, 'الإذن المعطوب يُرفض');
    assert.strictEqual(mFDone.permissions.write_used, 0, 'الإذن المعطوب لا يستهلك ميزانية كتابة');

    // (ز) أداة مسارها صالح لكن تنفيذها يفشل (is_error) لا تصفّر العدّاد ⇒ الرابع يبلغ الحد
    const mG = await runScript('صالح مساراً يفشل تنفيذاً', [
      { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED }, { name: 'Read', input: UNPARSED },
      { readFail: 'src/app.js' },
      { name: 'Read', input: UNPARSED },
    ]);
    assert.strictEqual((await waitState(mG.ex, 'failed')).failure_code, 'policy_violation', 'أداة فاشلة التنفيذ يجب ألا تصفّر عدّاد المعطوب');

    // (ح) وسم مقترن بحقل file_path قابل للتنفيذ ⇒ ليس وسماً نقياً ⇒ fail-closed (مسار خارجي)
    const mH = await runScript('وسم مع مسار خارجي', [
      { name: 'Read', input: { __unparsedToolInput: { raw: 'x', len: 1 }, file_path: path.join(temp, 'outside.txt') } },
    ]);
    assert.strictEqual((await waitState(mH.ex, 'failed')).failure_code, 'policy_violation', 'الوسم المقترن بمسار قابل للتنفيذ يبقى fail-closed');

    console.log('✓ detached worktree lifecycle and bounded diff');
    console.log('✓ executor writes only inside the isolated worktree');
    console.log('✓ two explicitly labelled runners share the same isolation policy');
    console.log('✓ missing, unlabeled, or malformed runners fail before worktree creation');
    console.log('✓ completed execution returns diff without automatic merge');
    console.log('✓ timeout, one-shot capped extension, and interrupt clean worktrees');
    console.log('✓ outside write paths fail closed');
    console.log('✓ sdk-only malformed marker tolerated; reset needs real success; unmarked/forbidden/marker+path/failed-exec stay fail-closed');
  } finally {
    for (const manager of managers) await manager.removeAll().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
