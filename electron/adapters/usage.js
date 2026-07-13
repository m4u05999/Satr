/**
 * عقد usage الموحّد للمحوّلات: عدّادات موثّقة من المزوّد أو تقدير محلي موسوم.
 * تبقى أسماء input_tokens/output_tokens القديمة أثناء الترحيل كي لا ينكسر مستهلك قائم.
 */

'use strict';

const contextBudget = require('../context');

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function emptyActual() {
  return { input: 0, output: 0, cached: 0, reasoning: 0, seen: false };
}

function parseChat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasInput = typeof raw.prompt_tokens === 'number' && Number.isFinite(raw.prompt_tokens) && raw.prompt_tokens >= 0;
  const hasOutput = typeof raw.completion_tokens === 'number' && Number.isFinite(raw.completion_tokens) && raw.completion_tokens >= 0;
  if (!hasInput && !hasOutput) return null;
  const input = tokenCount(raw.prompt_tokens);
  const output = tokenCount(raw.completion_tokens);
  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
    ? raw.prompt_tokens_details : {};
  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object'
    ? raw.completion_tokens_details : {};
  const documentedCached = Object.prototype.hasOwnProperty.call(promptDetails, 'cached_tokens')
    ? promptDetails.cached_tokens : raw.prompt_cache_hit_tokens;
  return {
    input,
    output,
    cached: Math.min(input, tokenCount(documentedCached)),
    reasoning: Math.min(output, tokenCount(completionDetails.reasoning_tokens)),
  };
}

function parseResponses(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasInput = typeof raw.input_tokens === 'number' && Number.isFinite(raw.input_tokens) && raw.input_tokens >= 0;
  const hasOutput = typeof raw.output_tokens === 'number' && Number.isFinite(raw.output_tokens) && raw.output_tokens >= 0;
  if (!hasInput && !hasOutput) return null;
  const input = tokenCount(raw.input_tokens);
  const output = tokenCount(raw.output_tokens);
  const inputDetails = raw.input_tokens_details && typeof raw.input_tokens_details === 'object'
    ? raw.input_tokens_details : {};
  const outputDetails = raw.output_tokens_details && typeof raw.output_tokens_details === 'object'
    ? raw.output_tokens_details : {};
  return {
    input,
    output,
    cached: Math.min(input, tokenCount(inputDetails.cached_tokens)),
    reasoning: Math.min(output, tokenCount(outputDetails.reasoning_tokens)),
  };
}

function add(total, current) {
  if (!current) return;
  total.input += current.input;
  total.output += current.output;
  total.cached += current.cached;
  total.reasoning += current.reasoning;
  total.seen = true;
}

function normalize(actual, estimated) {
  if (actual.seen) {
    return {
      input: actual.input,
      output: actual.output,
      cached: actual.cached,
      reasoning: actual.reasoning,
      source: 'actual',
      input_tokens: actual.input,
      output_tokens: actual.output,
    };
  }
  const fallback = contextBudget.resolveUsage({}, estimated);
  return {
    input: fallback.input_tokens,
    output: fallback.output_tokens,
    cached: 0,
    reasoning: 0,
    source: 'estimate',
    ...fallback,
  };
}

module.exports = { add, emptyActual, normalize, parseChat, parseResponses };
