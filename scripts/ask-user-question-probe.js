#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TIMEOUT_MS = 120000;

function globalClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  const candidate = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

function messageContent(message) {
  const content = message && message.message && message.message.content;
  return Array.isArray(content) ? content : [];
}

function textFrom(message) {
  return messageContent(message)
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toolResultsFrom(message) {
  return messageContent(message).filter((block) => block && block.type === 'tool_result');
}

function compact(value, max = 12000) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return text.length <= max ? text : text.slice(0, max) + '…';
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-ask-user-question-'));
  const abortController = new AbortController();
  const nonce = 'SATR_AUQ_' + crypto.randomBytes(12).toString('hex');
  const trace = {
    canUseCalls: [],
    input: null,
    updatedInput: null,
    toolResults: [],
    assistantTexts: [],
    result: null,
    stderr: [],
  };
  let queryInstance = null;
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);

  const prompt = [
    'This is a deterministic SDK integration probe. You MUST call AskUserQuestion exactly once before answering.',
    'Ask one single-select question in Arabic: "أي مسار نختبر؟".',
    'Use exactly two options with labels "المسار ألف" and "المسار باء" and short Arabic descriptions.',
    'Do not answer the question yourself and do not use plain conversational text instead of the tool.',
    'After the tool result arrives, inspect its answers and annotations, then reply with exactly:',
    'ANSWER=<the answer string>;NOTE=<the annotation notes string>',
    'The NOTE value is unknown to you until the tool result arrives. Do not invent it.',
  ].join('\n');

  const options = {
    abortController,
    cwd,
    settingSources: [],
    tools: ['AskUserQuestion'],
    persistSession: false,
    maxTurns: 3,
    maxBudgetUsd: 1,
    model: process.env.SATR_ASK_PROBE_MODEL || 'sonnet',
    stderr: (data) => trace.stderr.push(String(data)),
    canUseTool: async (toolName, input, details) => {
      trace.canUseCalls.push({ toolName, toolUseID: details && details.toolUseID });
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'deny', message: 'Probe permits AskUserQuestion only.' };
      }
      trace.input = input;
      const questions = input && Array.isArray(input.questions) ? input.questions : [];
      const question = questions[0];
      const choices = question && Array.isArray(question.options) ? question.options : [];
      const selected = choices[1] && typeof choices[1].label === 'string' ? choices[1].label : '';
      if (!question || typeof question.question !== 'string' || !selected) {
        return { behavior: 'deny', message: 'AskUserQuestion input shape did not match the installed SDK contract.' };
      }
      trace.updatedInput = {
        ...input,
        answers: { [question.question]: selected },
        annotations: { [question.question]: { notes: nonce } },
      };
      console.log('PROBE_CAN_USE_INPUT=' + compact(trace.input));
      console.log('PROBE_UPDATED_INPUT=' + compact(trace.updatedInput));
      return { behavior: 'allow', updatedInput: trace.updatedInput };
    },
  };

  const claudeBin = globalClaudeBin();
  if (claudeBin) options.pathToClaudeCodeExecutable = claudeBin;
  console.log('PROBE_SDK_VERSION=' + require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json').version);
  console.log('PROBE_CLAUDE_BIN=' + (claudeBin || '(SDK bundled binary)'));
  console.log('PROBE_MODEL=' + (options.model || '(configured default)'));
  console.log('PROBE_NONCE=' + nonce);

  try {
    queryInstance = sdk.query({ prompt, options });
    for await (const message of queryInstance) {
      const text = textFrom(message);
      if (text) trace.assistantTexts.push(text);
      const toolResults = toolResultsFrom(message);
      if (toolResults.length) trace.toolResults.push(...toolResults);
      if (message && message.type === 'result') trace.result = message;
    }

    const finalText = trace.assistantTexts.join('\n');
    const selectedQuestion = trace.input && trace.input.questions && trace.input.questions[0];
    const selectedLabel = selectedQuestion && selectedQuestion.options && selectedQuestion.options[1]
      ? selectedQuestion.options[1].label : '';
    const sawCall = trace.canUseCalls.some((call) => call.toolName === 'AskUserQuestion');
    const sawAnswer = !!selectedLabel && finalText.includes('ANSWER=' + selectedLabel);
    const sawNonce = finalText.includes('NOTE=' + nonce);

    console.log('PROBE_TOOL_RESULTS=' + compact(trace.toolResults));
    console.log('PROBE_FINAL_TEXT=' + compact(finalText));
    console.log('PROBE_RESULT=' + compact(trace.result));
    console.log('PROBE_STDERR=' + compact(trace.stderr));
    console.log('PROBE_CHECKS=' + compact({ sawCall, sawAnswer, sawNonce, selectedLabel }));

    if (sawCall && sawAnswer && sawNonce) {
      console.log('PROBE_DECISION=WORKS');
      return;
    }
    console.log('PROBE_DECISION=DOES_NOT_WORK');
    process.exitCode = sawCall ? 3 : 2;
  } catch (error) {
    console.log('PROBE_ERROR=' + compact({ name: error && error.name, message: error && error.message, stack: error && error.stack }));
    console.log('PROBE_STDERR=' + compact(trace.stderr));
    console.log('PROBE_DECISION=INCONCLUSIVE_RUNTIME_ERROR');
    process.exitCode = 4;
  } finally {
    clearTimeout(timer);
    try { if (queryInstance && typeof queryInstance.close === 'function') queryInstance.close(); } catch {}
    await fsp.rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 4;
});
