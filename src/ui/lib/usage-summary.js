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

// عدّاد مختصر للعرض في شريط الحالة: الأرقام التراكمية تبلغ عشرات الملايين في
// الجلسات الطويلة فتُقرأ ككتلة أرقام لا كمعلومة. تبقى الأرقام المألوفة كاملة،
// ويُختصر ما فوق مئة ألف. الرقم الكامل يبقى في title (formatUsageSummaryFull).
function compactCount(value) {
  const n = Math.floor(value || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' مليون';
  if (n >= 100000) return Math.round(n / 1000).toLocaleString('en-US') + ' ألف';
  return n.toLocaleString('en-US');
}

// الكلفة التراكمية: خانتان فوق الدولار (‏$81.17 لا $81.1695 — الدقة الزائدة
// تجعل التقدير يبدو فاتورة)، وأربع للمبالغ الصغيرة حيث الفروق الدقيقة تهمّ.
function formatCost(value) {
  return '~$' + (value >= 1 ? value.toFixed(2) : value.toFixed(4));
}

function usageParts(summary, format) {
  const parts = [];
  if (summary.hasInput) parts.push('إدخال ' + format(summary.input));
  if (summary.hasOutput) parts.push('إخراج ' + format(summary.output));
  if (summary.hasCached) parts.push('من المخبّأ ' + format(summary.cached));
  if (summary.hasReasoning) parts.push('تفكير ' + format(summary.reasoning));
  return parts;
}

export function formatUsageSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = usageParts(summary, compactCount);
  if (summary.hasCost && summary.cost > 0) parts.push('الكلفة التقديرية: ' + formatCost(summary.cost));
  if (!parts.length) return '';
  return (summary.estimated ? 'تقديري · ' : '') + parts.join(' · ');
}

// النسخة الكاملة بلا اختصار — تُعرض في tooltip كي يبقى الرقم الدقيق متاحاً
export function formatUsageSummaryFull(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const exact = (value) => Math.floor(value || 0).toLocaleString('en-US');
  const parts = usageParts(summary, exact);
  if (summary.hasCost && summary.cost > 0) parts.push('الكلفة التقديرية: ~$' + summary.cost.toFixed(4));
  if (!parts.length) return '';
  return 'تراكم هذه الجلسة' + (summary.estimated ? ' (يتضمن أرقاماً تقديرية)' : '') + ':\n' + parts.join('\n');
}
