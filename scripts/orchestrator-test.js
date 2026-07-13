#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const orchestrator = require('../electron/orchestrator');

function waitFor(check, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('wait timeout')); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function makeRunner(options) {
  const settings = options || {};
  const stats = { inputs: [], decisions: [], active: 0, maxActive: 0, stops: 0 };
  return {
    stats,
    model: settings.model || null,
    start(input, cwd, emit) {
      stats.inputs.push(input);
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      let closed = false;
      let timer = null;
      const handle = {
        resolvePermission(id, allow) { stats.decisions.push({ id, allow }); return true; },
        stop() {
          if (!closed) { closed = true; stats.stops++; stats.active--; }
          if (timer) clearTimeout(timer);
          return Promise.resolve();
        },
      };
      if (!settings.hang) {
        timer = setTimeout(() => {
          if (closed) return;
          emit({ type: 'permission_request', id: 'perm-' + stats.inputs.length, tool: 'Bash', input: { command: 'npm test' } });
          if (settings.forbiddenTool) {
            emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { prompt: 'expand' } }] } });
            return;
          }
          if (settings.unsafe) {
            emit({ type: 'file_edit', id: 'forbidden-edit', rel: 'src/bad.js' });
            return;
          }
          emit({
            type: 'assistant',
            message: { content: [
              { type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'src', 'evidence.js') } },
              { type: 'tool_use', name: 'Read', input: { file_path: path.join(os.tmpdir(), 'outside.js') } },
              { type: 'text', phase: 'final_answer', text: 'خلاصة موثقة من `src/evidence.js:7`.' },
            ] },
          });
          emit({
            type: 'result', result: 'خلاصة احتياطية', total_cost_usd: 0.01,
            usage: { input_tokens: 20, output_tokens: 5, estimate: true },
          });
          closed = true; stats.active--;
          emit({ type: 'proc_done', code: 0 });
        }, settings.delayMs || 20);
      }
      return handle;
    },
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-orchestrator-test-'));
  const project = path.join(temp, 'project');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  try {
    const mainSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    const policyStart = mainSource.indexOf('function resolveOpsRoomModel(');
    const policyEnd = mainSource.indexOf('\nfunction resolveOpsRoomRunner(', policyStart);
    assert(policyStart > 0 && policyEnd > policyStart, 'تعذّر العثور على سياسة نماذج غرفة العمليات في main.js');
    const policy = vm.runInNewContext(
      '(() => {' + mainSource.slice(policyStart, policyEnd) + '; return { resolveOpsRoomModel, preflightOpsRoomModels }; })()',
      { SAFE_MODEL: /^[A-Za-z0-9.-]{1,64}$/, process: { env: {} }, codex: { DEFAULT_MODEL: 'gpt-5.6-sol' } },
    );
    assert.strictEqual(policy.resolveOpsRoomModel('sdk', {}, 'codex-default').model, 'claude-opus-4-8');
    assert.strictEqual(policy.resolveOpsRoomModel('codex', {}, 'codex-default').model, 'codex-default');
    const overridden = policy.preflightOpsRoomModels(['sdk', 'codex'], {
      SATR_OPSROOM_CLAUDE_MODEL: 'claude-override', SATR_OPSROOM_CODEX_MODEL: 'codex-override',
    }, 'codex-default');
    assert.strictEqual(overridden.ok, true);
    assert.strictEqual(overridden.models.sdk, 'claude-override');
    assert.strictEqual(overridden.models.codex, 'codex-override');
    const invalid = policy.preflightOpsRoomModels(['sdk'], { SATR_OPSROOM_CLAUDE_MODEL: '../bad model' }, 'codex-default');
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error, 'ops_model_invalid');
    assert(invalid.message.includes('SATR_OPSROOM_CLAUDE_MODEL'));
    assert(!invalid.message.includes('../bad model'));
    assert(mainSource.includes("preflightOpsRoomModels(mode === 'mergeable' ? ['sdk', 'codex'] : ['sdk'])"));
    assert(mainSource.includes('preflightOpsRoomModels(reviewerModule.requiredReviewEngines(artifact.producer_engines))'));
    const rendererSources = await Promise.all([
      fsp.readFile(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8'),
      fsp.readFile(path.join(__dirname, '..', 'src', 'ui', 'components', 'ops-room.js'), 'utf8'),
    ]);
    assert(rendererSources.every((source) => !source.includes('SATR_OPSROOM_CLAUDE_MODEL') && !source.includes('SATR_OPSROOM_CODEX_MODEL')));

    const singleRunner = makeRunner({ model: 'sdk-research-model' });
    const singleEvents = [];
    const single = orchestrator.create({ resolveEngine: () => singleRunner, timeoutMs: 500 });
    const startedSingle = single.start({ question: 'أين منطق الدليل؟', count: 1, engine: 'sdk' }, project,
      (event) => singleEvents.push(event));
    assert.strictEqual(startedSingle.ok, true);
    const singleDone = await waitFor(() => {
      const run = single.latest();
      return run && run.state === 'completed' ? run : null;
    }, 1000);
    assert.strictEqual(singleDone.workers.length, 1);
    assert(singleDone.summary.includes('خلاصة موثقة'));
    assert(singleDone.sources.includes('src/evidence.js'));
    assert(singleDone.sources.includes('src/evidence.js:7'));
    assert(!singleDone.sources.some((source) => source.includes('outside.js')));
    assert.strictEqual(singleDone.cost.usd, 0.01);
    assert.strictEqual(singleDone.cost.estimate, true);
    assert(singleEvents.some((event) => event.type === 'research_update'));
    assert(singleRunner.stats.inputs.every((input) => input.permissionMode === 'plan'));
    assert(singleRunner.stats.inputs.every((input) => input.model === 'sdk-research-model'));
    assert(singleRunner.stats.inputs.every((input) => input.browserControl === false && input.skills.length === 0));
    assert(singleRunner.stats.decisions.length > 0 && singleRunner.stats.decisions.every((item) => item.allow === false));
    assert.strictEqual(single.latest(path.join(temp, 'other-project')), null);

    const parallelRunner = makeRunner({ delayMs: 40 });
    const parallel = orchestrator.create({ resolveEngine: () => parallelRunner, timeoutMs: 500 });
    assert.strictEqual(parallel.start({ question: 'ابحث بالتوازي', count: 3, engine: 'sdk' }, project, () => {}).ok, true);
    const parallelDone = await waitFor(() => {
      const run = parallel.latest();
      return run && run.state === 'completed' ? run : null;
    }, 1000);
    assert.strictEqual(parallelDone.workers.length, 3);
    assert.strictEqual(parallelRunner.stats.maxActive, 3);
    assert.strictEqual(parallelRunner.stats.inputs.length, 3);
    assert.strictEqual(parallelDone.cost.usd, 0.03);

    const timeoutRunner = makeRunner({ hang: true });
    const timed = orchestrator.create({ resolveEngine: () => timeoutRunner, timeoutMs: 30 });
    timed.start({ question: 'اختبر المهلة', count: 1, engine: 'sdk' }, project, () => {});
    const timedDone = await waitFor(() => {
      const run = timed.latest();
      return run && run.state === 'timed_out' ? run : null;
    }, 1000);
    assert.strictEqual(timedDone.workers[0].state, 'timed_out');
    assert.strictEqual(timeoutRunner.stats.stops, 1);

    const stopRunner = makeRunner({ hang: true });
    const stopped = orchestrator.create({ resolveEngine: () => stopRunner, timeoutMs: 500 });
    const running = stopped.start({ question: 'اختبر الإيقاف', count: 3, engine: 'sdk' }, project, () => {});
    await waitFor(() => stopRunner.stats.active === 3, 500);
    const stopResult = stopped.stop(running.run.id);
    assert.strictEqual(stopResult.ok, true);
    const stoppedDone = await waitFor(() => {
      const run = stopped.latest();
      return run && run.state === 'stopped' ? run : null;
    }, 1000);
    assert(stoppedDone.workers.every((worker) => worker.state === 'stopped'));
    assert.strictEqual(stopRunner.stats.stops, 3);

    const unsafeRunner = makeRunner({ unsafe: true });
    const unsafe = orchestrator.create({ resolveEngine: () => unsafeRunner, timeoutMs: 500 });
    unsafe.start({ question: 'اختبر حاجز الكتابة', count: 1, engine: 'sdk' }, project, () => {});
    const unsafeDone = await waitFor(() => {
      const run = unsafe.latest();
      return run && run.state === 'failed' ? run : null;
    }, 1000);
    assert(unsafeDone.workers[0].error.includes('غير مسموح'));
    assert.strictEqual(unsafeRunner.stats.stops, 1);

    const toolRunner = makeRunner({ forbiddenTool: true });
    const toolBlocked = orchestrator.create({ resolveEngine: () => toolRunner, timeoutMs: 500 });
    toolBlocked.start({ question: 'اختبر أداة غير مقروءة', count: 1, engine: 'sdk' }, project, () => {});
    const toolDone = await waitFor(() => {
      const run = toolBlocked.latest();
      return run && run.state === 'failed' ? run : null;
    }, 1000);
    assert(toolDone.workers[0].error.includes('Task'));
    assert.strictEqual(toolRunner.stats.stops, 1);

    console.log('✓ one read-only researcher returns summary, sources, and cost');
    console.log('✓ up to three researchers run in parallel with zero permission budget');
    console.log('✓ researcher timeout interrupts its engine handle');
    console.log('✓ collective stop interrupts every researcher');
    console.log('✓ unexpected write events fail closed');
    console.log('✓ non-read tools and nested agents fail closed');
    console.log('✓ per-engine ops models use isolated defaults/overrides and invalid values fail before launch');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
