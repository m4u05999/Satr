/**
 * سياق المزوّدات العمياء: خلاصة repo map + تقدير رموز تقريبي وموسوم بوضوح.
 *
 * لا يدّعي هذا عدّاً حقيقياً من tokenizer المزوّد. التقدير heuristic محلي رخيص:
 * ASCII نحو 4 محارف/رمز، وغير ASCII نحو محرفين/رمز. usage الحقيقي إن وصل من API
 * يظلّ المصدر المفضّل؛ fallback وحده يحمل estimate:true.
 */

'use strict';

const repomap = require('./repomap');

const MAX_VALUE_DEPTH = 7;
const MAX_VALUE_ITEMS = 2000;
const REPO_MAP_ESTIMATED_TOKEN_LIMIT = 1600;

function estimateTextTokens(value) {
  const text = String(value || '');
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii / 2);
}

function estimateTokens(value) {
  let total = 0;
  let visited = 0;
  const seen = new Set();
  function walk(current, depth) {
    if (current == null || depth > MAX_VALUE_DEPTH || visited >= MAX_VALUE_ITEMS) return;
    visited++;
    if (typeof current === 'string') { total += estimateTextTokens(current); return; }
    if (typeof current === 'number' || typeof current === 'boolean') { total += estimateTextTokens(String(current)); return; }
    if (typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) walk(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      total += estimateTextTokens(key);
      walk(item, depth + 1);
      if (visited >= MAX_VALUE_ITEMS) break;
    }
  }
  walk(value, 0);
  return total;
}

function budgetBlock(inputTokens, repoTokens) {
  return [
    '<satr_context_budget estimate="true" unit="tokens" method="character_heuristic">',
    'starting_input_tokens≈' + inputTokens,
    'repo_map_tokens≈' + repoTokens + ' (cap≈' + REPO_MAP_ESTIMATED_TOKEN_LIMIT + ')',
    'This is a local estimate, not provider-reported usage. Prefer progressive disclosure: choose likely files, then use search_code/read_file.',
    '</satr_context_budget>',
  ].join('\n');
}

async function buildBlindContext(input, options) {
  const info = input || {};
  const parts = Array.isArray(info.systemParts) ? info.systemParts.filter((part) => typeof part === 'string' && part) : [];
  let repo = null;
  try {
    repo = await repomap.summarize(info.cwd, info.prompt, options && options.repomap);
  } catch {
    repo = { summary: '', partial: true, files: [], scanned: 0, total: 0 };
  }
  const summary = repo && typeof repo.summary === 'string' ? repo.summary : '';
  const repoTokens = estimateTextTokens(summary);
  const withoutBudget = parts.concat(summary ? [summary] : []).join('\n\n');
  const baseValue = [withoutBudget, info.history || [], info.prompt || '', info.toolDefinitions || []];
  let inputTokens = estimateTokens(baseValue);
  let budget = budgetBlock(inputTokens, repoTokens);
  inputTokens = estimateTokens([withoutBudget, budget, info.history || [], info.prompt || '', info.toolDefinitions || []]);
  budget = budgetBlock(inputTokens, repoTokens);
  const systemPrompt = parts.concat(summary ? [summary] : [], [budget]).join('\n\n');
  return {
    systemPrompt,
    repo,
    estimate: {
      estimate: true,
      method: 'character_heuristic',
      input_tokens: inputTokens,
      repo_map_tokens: repoTokens,
      repo_map_token_cap: REPO_MAP_ESTIMATED_TOKEN_LIMIT,
    },
  };
}

function resolveUsage(actual, estimated) {
  const inputTokens = actual && Number(actual.input_tokens) || 0;
  const outputTokens = actual && Number(actual.output_tokens) || 0;
  if (inputTokens || outputTokens) return { input_tokens: inputTokens, output_tokens: outputTokens };
  return {
    input_tokens: Math.max(0, Math.ceil(Number(estimated && estimated.input_tokens) || 0)),
    output_tokens: Math.max(0, Math.ceil(Number(estimated && estimated.output_tokens) || 0)),
    estimate: true,
    method: 'character_heuristic',
  };
}

module.exports = {
  buildBlindContext,
  estimateTextTokens,
  estimateTokens,
  resolveUsage,
  REPO_MAP_ESTIMATED_TOKEN_LIMIT,
};
