// تطبيع وتجميع استهلاك جلسة Community في الذاكرة فقط.

const EMPTY_SUMMARY = {
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  hasInput: false,
  hasOutput: false,
  hasCached: false,
  hasReasoning: false,
  estimated: false,
  cost: 0,
  hasCost: false,
};

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value) : null;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function pickMetric(raw, primary, alias) {
  const first = nonNegativeInteger(raw[primary]);
  if (first != null) return { value: first, present: true };
  const second = nonNegativeInteger(raw[alias]);
  return { value: second == null ? 0 : second, present: second != null };
}

export function emptyUsageSummary() {
  return { ...EMPTY_SUMMARY };
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const input = pickMetric(raw, 'input', 'input_tokens');
  const output = pickMetric(raw, 'output', 'output_tokens');
  const cached = pickMetric(raw, 'cached', 'cache_read_input_tokens');
  const reasoning = pickMetric(raw, 'reasoning', 'reasoning_tokens');
  if (!input.present && !output.present && !cached.present && !reasoning.present) return null;

  return {
    input: input.value,
    output: output.value,
    cached: cached.value,
    reasoning: reasoning.value,
    hasInput: input.present,
    hasOutput: output.present,
    hasCached: cached.present,
    hasReasoning: reasoning.present,
    estimated: raw.source === 'estimate' || raw.estimate === true,
  };
}

export function formatUsage(raw) {
  const usage = normalizeUsage(raw);
  if (!usage) return '';
  const parts = [];
  if (usage.hasInput && usage.input) parts.push('إدخال ' + usage.input.toLocaleString('en-US'));
  if (usage.hasOutput && usage.output) parts.push('إخراج ' + usage.output.toLocaleString('en-US'));
  if (usage.hasCached && usage.cached) parts.push('من المخبّأ ' + usage.cached.toLocaleString('en-US'));
  if (usage.hasReasoning && usage.reasoning) parts.push('تفكير ' + usage.reasoning.toLocaleString('en-US'));
  return parts.join(' · ');
}

function resultCost(result) {
  if (!result || typeof result !== 'object') return null;
  const usageCost = result.usage && typeof result.usage === 'object' ? result.usage.cost_usd : null;
  for (const value of [result.total_cost_usd, result.cost_usd, usageCost]) {
    const cost = nonNegativeNumber(value);
    if (cost != null) return cost;
  }
  return null;
}

export function addUsageResult(summary, result, seenResults) {
  const current = summary && typeof summary === 'object' ? summary : emptyUsageSummary();
  if (!result || typeof result !== 'object') return current;
  if (seenResults instanceof WeakSet) {
    if (seenResults.has(result)) return current;
    seenResults.add(result);
  }

  const usage = normalizeUsage(result.usage);
  const cost = resultCost(result);
  if (!usage && cost == null) return current;

  const next = { ...current };
  if (usage) {
    next.input += usage.input;
    next.output += usage.output;
    next.cached += usage.cached;
    next.reasoning += usage.reasoning;
    next.hasInput = current.hasInput || usage.hasInput;
    next.hasOutput = current.hasOutput || usage.hasOutput;
    next.hasCached = current.hasCached || usage.hasCached;
    next.hasReasoning = current.hasReasoning || usage.hasReasoning;
    next.estimated = current.estimated || usage.estimated;
  }
  if (cost != null) {
    next.cost += cost;
    next.hasCost = true;
  }
  return next;
}

export function formatUsageSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = [];
  if (summary.hasInput) parts.push('إدخال ' + Math.floor(summary.input || 0).toLocaleString('en-US'));
  if (summary.hasOutput) parts.push('إخراج ' + Math.floor(summary.output || 0).toLocaleString('en-US'));
  if (summary.hasCached) parts.push('من المخبّأ ' + Math.floor(summary.cached || 0).toLocaleString('en-US'));
  if (summary.hasReasoning) parts.push('تفكير ' + Math.floor(summary.reasoning || 0).toLocaleString('en-US'));
  if (summary.hasCost && summary.cost > 0) parts.push('الكلفة التقديرية: ~$' + summary.cost.toFixed(4));
  if (!parts.length) return '';
  return (summary.estimated ? 'تقديري · ' : '') + parts.join(' · ');
}
