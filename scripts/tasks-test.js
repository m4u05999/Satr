#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const tasks = require('../electron/tasks');
const tools = require('../electron/tools');

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-tasks-test-'));
  const options = { root };
  const engine = 'codex';
  const sessionId = 'session_123';
  try {
    const created = tasks.apply({
      schema_version: 1,
      engine,
      session_id: sessionId,
      mode: 'replace',
      source: 'test',
      tasks: [
        { id: 'plan-1', title: 'تحليل المتطلبات', status: 'completed', evidence: ['راجعت العقد'] },
        { id: 'plan-2', title: 'تنفيذ الوحدة', status: 'in_progress', dependencies: ['plan-1'], owner: 'الوكيل' },
      ],
    }, options);
    assert(created);
    assert.strictEqual(created.schema_version, 1);
    assert.strictEqual(created.revision, 1);
    assert.strictEqual(created.state, 'active');
    assert.deepStrictEqual(created.tasks[1].dependencies, ['plan-1']);

    const merged = tasks.apply({
      schema_version: 1,
      engine,
      session_id: sessionId,
      mode: 'merge',
      source: 'test_update',
      tasks: [{ id: 'plan-2', title: 'تنفيذ الوحدة', status: 'completed', evidence: [{ text: 'نجح الاختبار', kind: 'test' }] }],
    }, options);
    assert.strictEqual(merged.state, 'completed');
    assert.strictEqual(merged.tasks[1].owner, 'الوكيل');
    assert.strictEqual(merged.tasks[1].evidence[0].kind, 'test');
    const accumulated = tasks.apply({
      schema_version: 1, engine, session_id: sessionId, mode: 'merge', source: 'more_evidence',
      tasks: [{ id: 'plan-2', title: 'تنفيذ الوحدة', status: 'completed', dependencies: ['external-check'], evidence: ['مراجعة يدوية'] }],
    }, options);
    assert.deepStrictEqual(accumulated.tasks[1].dependencies, ['plan-1', 'external-check']);
    assert.strictEqual(accumulated.tasks[1].evidence.length, 2);

    const paused = tasks.action(engine, sessionId, 'pause', options);
    assert.strictEqual(paused.state, 'paused');
    const whilePaused = tasks.apply({
      schema_version: 1, engine, session_id: sessionId, mode: 'merge', source: 'late',
      tasks: [{ id: 'plan-2', title: 'تنفيذ الوحدة', status: 'in_progress' }],
    }, options);
    assert.strictEqual(whilePaused.state, 'paused');
    const resumed = tasks.action(engine, sessionId, 'resume', options);
    assert.strictEqual(resumed.state, 'active');

    const evidenced = tasks.addEvidence(engine, sessionId, { task_title: 'تنفيذ الوحدة' }, [
      { text: 'نجح npm test', kind: 'verification_pass' },
    ], options);
    assert(evidenced);
    assert(evidenced.tasks[1].evidence.some((item) => item.kind === 'verification_pass'));
    assert.strictEqual(tasks.addEvidence(engine, sessionId, { task_title: 'غير موجودة' }, ['دليل'], options), null);

    const loaded = tasks.load(engine, sessionId, options);
    assert.strictEqual(loaded.revision, 7);
    assert.strictEqual(loaded.tasks.length, 2);
    assert(!JSON.stringify(loaded).includes(root));

    assert.strictEqual(tasks.apply({ schema_version: 1, engine: '../bad', session_id: sessionId, tasks: [] }, options), null);
    assert.strictEqual(tasks.load(engine, '../bad', options), null);
    const sanitized = tasks.sanitizeTasks([{ id: '../bad', title: 'صالحة', status: 'unknown', dependencies: ['../x'] }]);
    assert.strictEqual(sanitized[0].id, 'task-1');
    assert.strictEqual(sanitized[0].status, 'pending');
    assert.deepStrictEqual(sanitized[0].dependencies, []);
    assert.strictEqual(tasks.sanitizeTasks(Array.from({ length: 80 }, (_, index) => ({
      id: 'bounded-' + index, title: 'مهمة ' + index, status: 'pending',
    }))).length, 50);

    const definitions = tools.defs().map((definition) => definition.function.name);
    assert(definitions.includes('update_task_ledger'));
    let emitted = null;
    const toolResult = await tools.run('update_task_ledger', root, {
      mode: 'replace', tasks: [{ id: 'adapter-1', title: 'اختبار المحوّل', status: 'in_progress' }],
    }, { emit: (event) => { emitted = event; } });
    assert.strictEqual(toolResult.ok, true);
    assert(emitted && emitted.type === 'task_update' && emitted.source === 'adapter_tool');

    // ردة فعل ضد تراجع: خطة Kimi التلقائية لا تستبدل سجلاً صريحاً.
    const explicitLedger = tasks.apply({
      schema_version: 1,
      engine,
      session_id: sessionId,
      mode: 'replace',
      source: 'adapter_tool',
      tasks: [{ id: 'explicit-1', title: 'مهمة صريحة', status: 'in_progress' }],
    }, options);
    assert.strictEqual(explicitLedger.tasks.length, 1);
    assert.strictEqual(explicitLedger.tasks[0].id, 'explicit-1');

    const kimiOverwrite = tasks.apply({
      schema_version: 1,
      engine,
      session_id: sessionId,
      mode: 'replace',
      source: 'kimi_plan',
      tasks: [{ id: 'kimi-1', title: 'خطة تلقائية', status: 'pending' }],
    }, options);
    assert.strictEqual(kimiOverwrite.tasks.length, 1, 'خطة Kimi استبدلت السجل الصريح.');
    assert.strictEqual(kimiOverwrite.tasks[0].id, 'explicit-1', 'خطة Kimi غيّرت المهمة الصريحة.');

    // عندما لا يوجد سجل، خطة Kimi التلقائية تُنشئ سجلاً.
    const kimiSession = 'kimi_only_session';
    const kimiInitial = tasks.apply({
      schema_version: 1,
      engine,
      session_id: kimiSession,
      mode: 'replace',
      source: 'kimi_plan',
      tasks: [{ id: 'kimi-1', title: 'خطة تلقائية', status: 'pending' }],
    }, options);
    assert.strictEqual(kimiInitial.tasks.length, 1);
    assert.strictEqual(kimiInitial.tasks[0].id, 'kimi-1');

    console.log('✓ task ledger schema and persistence');
    console.log('✓ task ledger merge, pause, and resume');
    console.log('✓ task ledger input boundaries and adapter tool');
    console.log('✓ kimi_plan cannot replace explicit ledger and works from empty state');
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
