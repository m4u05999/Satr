#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const memory = require('../electron/memory');

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-memory-test-'));
  const project = path.join(temp, 'project');
  const store = path.join(temp, 'store');
  await fsp.mkdir(project, { recursive: true });
  const options = { root: store };
  try {
    const candidate = memory.propose({
      kind: 'decision',
      content: 'تُكتب ملفات الإعداد بصيغة JSON وتُراجع قبل الدمج',
      confidence: 'high',
      scope: { type: 'path', path: 'config/app.json' },
      shareable: true,
    }, { type: 'agent', engine: 'sdk', detail: 'اقتراح من الدور' });
    assert.strictEqual(candidate.ok, true);
    assert.strictEqual(await fsp.stat(store).then(() => true, () => false), false, 'الاقتراح يجب ألا ينشئ مخزناً');

    const rejected = memory.save(project, {
      kind: 'fact', content: 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      confidence: 'high', scope: { type: 'project' }, source: { type: 'agent', engine: 'sdk' },
    }, options);
    assert.strictEqual(rejected.error, 'secret');
    assert.strictEqual(await fsp.stat(store).then(() => true, () => false), false, 'السر المرفوض يجب ألا يصل القرص');

    const saved = memory.save(project, candidate.candidate, options);
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(memory.search(project, 'JSON config', options).items.length, 1);

    for (let index = 0; index < 20; index++) {
      const result = memory.save(project, {
        kind: index % 2 ? 'command' : 'failure',
        content: 'اختبار الفهرس budget-token-' + index + ' ' + 'تفصيل '.repeat(30),
        confidence: 'medium', scope: { type: 'project' },
        source: { type: 'user', detail: 'اختبار محلي' },
      }, options);
      assert.strictEqual(result.ok, true);
    }
    const boundedQuery = memory.search(project, Array.from({ length: 30 }, (_, i) => 'term' + i).join(' '), options);
    assert(boundedQuery.query_terms.length <= memory.MAX_QUERY_TERMS);
    const stored = JSON.parse(await fsp.readFile(memory.fileFor(project, options), 'utf8'));
    assert(stored.items.every((item) => Array.isArray(item.keywords) && item.keywords.length <= memory.MAX_INDEX_TERMS));
    const retrieved = memory.retrieve(project, 'اختبار الفهرس', { ...options, maxItems: 3, maxChars: 700 });
    assert(retrieved.items.length <= 3);
    assert(retrieved.text.length <= 700);

    const edited = memory.update(project, saved.item.id, {
      content: 'قرار JSON مُراجع ومحدّث', confidence: 'medium', scope: { type: 'project' },
    }, options);
    assert.strictEqual(edited.ok, true);
    assert.strictEqual(memory.search(project, 'محدث', options).items[0].id, saved.item.id);

    assert.strictEqual(memory.remove(project, saved.item.id, options).ok, true);
    assert.strictEqual(memory.search(project, 'محدث', options).items.length, 0);

    // حارس عدم تراجع: حقن الذاكرة في محرك Codex (تكافؤ agent.js) — استرجاع من prompt
    // المستخدم الأصلي، معزول عن المراجع/العصف (browserControl:false)، وقبل نص الدور.
    const codexSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'codex.js'), 'utf8');
    assert(codexSource.includes("require('./memory')"),
      'codex.js must import project memory');
    assert(codexSource.includes("browserControl === false ? '' : memory.retrieve(cwd, prompt).text"),
      'codex memory injection must use the original user prompt and stay out of isolated contexts');
    const memoryAt = codexSource.indexOf('memory.retrieve(cwd, prompt)');
    const promptAt = codexSource.indexOf('inputItems.push({ type: \'text\', text: effectivePrompt');
    assert(memoryAt > 0 && promptAt > memoryAt,
      'memory block must be pushed before the user prompt input item');

    console.log('✓ memory candidate requires explicit save');
    console.log('✓ secret patterns are rejected before disk');
    console.log('✓ keyword index and retrieval budgets are bounded');
    console.log('✓ memory update and deletion');
    console.log('✓ codex engine memory injection guard (isolated contexts excluded)');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
