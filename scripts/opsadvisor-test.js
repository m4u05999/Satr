#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const brainstormModule = require('../electron/opsbrainstorm');
const plannerModule = require('../electron/opsplanner');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim())); else resolve(stdout);
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

function textRunner(engine, stats, output, forbidden) {
  return {
    engine, model: engine + '-model',
    start(input, cwd, emit) {
      stats.push({ engine, input, cwd });
      setTimeout(() => {
        if (forbidden) emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } });
        else {
          emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text: output }] } });
          emit({ type: 'proc_done', code: 0 });
        }
      }, 10);
      return { resolvePermission() {}, stop() { return Promise.resolve(); } };
    },
  };
}

function plannerRunner(stats, output, outside) {
  return {
    engine: 'sdk', model: 'planner-model',
    start(input, cwd, emit) {
      stats.push({ input, cwd });
      setTimeout(() => {
        emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {
          file_path: outside ? path.join(path.dirname(cwd), 'outside.txt') : path.join(cwd, 'src', 'app.js'),
        } }] } });
        if (!outside) {
          emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text: output }] } });
          emit({ type: 'proc_done', code: 0 });
        }
      }, 10);
      return { resolvePermission() {}, stop() { return Promise.resolve(); } };
    },
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-ops-advisor-'));
  const project = path.join(temp, 'project');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  await fsp.writeFile(path.join(project, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
  await git(project, ['init']);
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Satr Test', '-c', 'user.email=satr@example.invalid', 'commit', '-m', 'fixture']);
  try {
    const brainstormStats = [];
    const brainstorm = brainstormModule.create({
      isolationRoot: temp, timeoutMs: 1000,
      resolveEngine: (engine) => textRunner(engine, brainstormStats, 'رأي مستقل من ' + engine, false),
    });
    assert.strictEqual(brainstorm.start({ brief: 'قيّم الخطة' }, project, () => {}).ok, true);
    const brainstormDone = await waitFor(() => {
      const run = brainstorm.latest(project); return run && run.state === 'completed' ? run : null;
    }, 3000, 'brainstorm completion');
    assert.strictEqual(brainstormDone.workers.length, 2);
    assert.strictEqual(new Set(brainstormStats.map((item) => item.cwd)).size, 2);
    assert(brainstormStats.every((item) => item.input.permissionMode === 'plan' && item.input.browserControl === false));
    assert(brainstormStats.every((item) => !path.resolve(item.cwd).startsWith(path.resolve(project) + path.sep)));
    assert.strictEqual(brainstorm.latest(path.join(temp, 'other')), null);

    const blockedStats = [];
    const blocked = brainstormModule.create({ isolationRoot: temp, timeoutMs: 1000,
      resolveEngine: (engine) => textRunner(engine, blockedStats, '', true) });
    blocked.start({ brief: 'لا تستخدم أدوات' }, project, () => {});
    const blockedDone = await waitFor(() => {
      const run = blocked.latest(project); return run && run.state === 'failed' ? run : null;
    }, 3000, 'brainstorm fail closed');
    assert(blockedDone.workers.every((worker) => worker.state === 'failed'));

    const planStats = [];
    const output = '<ops_plan>{"tasks":[{"task":"عدّل التطبيق","ownership":["src/app.js"]},{"task":"حدّث الاختبار","ownership":["tests/app.js"]}]}</ops_plan>';
    const planner = plannerModule.create({ runner: plannerRunner(planStats, output, false), timeoutMs: 1000 });
    await planner.start({ task: 'قسّم الإصلاح' }, project, () => {});
    const planned = await waitFor(() => {
      const run = planner.latest(project); return run && run.state === 'completed' ? run : null;
    }, 3000, 'planner completion');
    assert.strictEqual(planned.plan.tasks.length, 2);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(planned, 'summary'), false);
    assert.strictEqual(planStats[0].input.permissionMode, 'plan');

    const outsidePlanner = plannerModule.create({ runner: plannerRunner([], output, true), timeoutMs: 1000 });
    await outsidePlanner.start({ task: 'اختبر المسار' }, project, () => {});
    const outsideDone = await waitFor(() => {
      const run = outsidePlanner.latest(project); return run && run.state === 'failed' ? run : null;
    }, 3000, 'planner outside path');
    assert.strictEqual(outsideDone.error, 'forbidden_tool');
    assert.strictEqual(plannerModule.parsePlan('<ops_plan>{"tasks":[{"task":"أ","ownership":["src/**"]},{"task":"ب","ownership":["src/a.js"]}]}</ops_plan>'), null);
    const agentSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
    const mainSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(agentSource.includes("options.tools = []") && agentSource.includes("options.tools = ['Read', 'Grep', 'Glob']"));
    assert(agentSource.includes("settingSources: isolatedPolicy ? [] : ['user', 'project', 'local']"));
    assert(mainSource.includes("agent.start(input, cwd, emit, { mode: 'text-only' })"));
    assert(mainSource.includes("agent.start(input, cwd, emit, { mode: 'read-only-planner' })"));

    console.log('✓ Claude and Codex brainstorm independently in empty tool-free workspaces');
    console.log('✓ any brainstorm tool use fails closed without an agent-to-agent loop');
    console.log('✓ planner exposes only validated non-overlapping task ownership proposals');
    console.log('✓ planner blocks reads outside the project before accepting a proposal');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
