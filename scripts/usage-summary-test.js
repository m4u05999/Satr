#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'lib', 'usage-summary.js'), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

async function main() {
  const {
    addUsageResult,
    emptyUsageSummary,
    formatUsage,
    formatUsageSummary,
    normalizeUsage,
  } = await loadModule();

  const first = {
    usage: { input: 10, output: 4, cached: 30, reasoning: 2, source: 'actual' },
    total_cost_usd: 0.12,
  };
  const second = {
    usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 20, reasoning_tokens: 1 },
    total_cost_usd: 0.03,
  };
  const seenResults = new WeakSet();

  let summary = emptyUsageSummary();
  summary = addUsageResult(summary, first, seenResults);
  summary = addUsageResult(summary, second, seenResults);
  summary = addUsageResult(summary, first, seenResults);
  assert.deepStrictEqual({
    input: summary.input,
    output: summary.output,
    cached: summary.cached,
    reasoning: summary.reasoning,
    cost: summary.cost,
  }, { input: 15, output: 10, cached: 50, reasoning: 3, cost: 0.15 });
  assert.match(formatUsageSummary(summary), /إدخال 15/);
  assert.match(formatUsageSummary(summary), /من المخبّأ 50/);
  assert.match(formatUsageSummary(summary), /الكلفة التقديرية/);
  assert.match(formatUsage(first.usage), /من المخبّأ 30/);

  const estimated = addUsageResult(emptyUsageSummary(), {
    usage: { input_tokens: 8, output_tokens: 9, estimate: true },
  });
  assert.strictEqual(estimated.estimated, true);
  assert.match(formatUsageSummary(estimated), /^تقديري/);

  const cachedOnly = normalizeUsage({ cache_read_input_tokens: 120 });
  assert.deepStrictEqual(cachedOnly, {
    input: 0, output: 0, cached: 120, reasoning: 0,
    hasInput: false, hasOutput: false, hasCached: true, hasReasoning: false,
    estimated: false,
  });
  const invalid = normalizeUsage({ input: -10, output: Number.NaN, cached: -20, reasoning: -1 });
  assert.strictEqual(invalid, null);
  const costOnly = addUsageResult(emptyUsageSummary(), { total_cost_usd: 0.5 });
  assert.match(formatUsageSummary(costOnly), /~\$0\.5000/);
  assert.deepStrictEqual(emptyUsageSummary(), {
    input: 0, output: 0, cached: 0, reasoning: 0,
    hasInput: false, hasOutput: false, hasCached: false, hasReasoning: false,
    estimated: false, cost: 0, hasCost: false,
  });

  console.log('✓ usage summary aggregates actual and alias fields once');
  console.log('✓ cached usage remains independent from uncached input');
  console.log('✓ estimates, cost-only results, invalid values, and reset are safe');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
