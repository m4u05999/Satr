#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TIMEOUT_MS = 180000;
const CONTROL_TIMEOUT_MS = 15000;
const COMPLETE_DELAY_MS = 12000;
const STOP_DELAY_MS = 45000;
const SAFE_OBSERVED_ID = /^[A-Za-z0-9_-]{1,128}$/;

function globalClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const candidate = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  const command = process.platform === 'win32' ? 'where' : 'which';
  const found = execFileSync(command, ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  assert.ok(found, 'لم يُعثر على Claude Code العالمي');
  return found;
}

function withTimeout(promise, label, timeoutMs = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`انتهت مهلة ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function messageContent(message) {
  const content = message && message.message && message.message.content;
  return Array.isArray(content) ? content : [];
}

function safeError(error) {
  return {
    settled: 'rejected',
    name: typeof (error && error.name) === 'string' ? error.name.slice(0, 80) : 'Error',
    message: typeof (error && error.message) === 'string' ? error.message.slice(0, 240) : String(error).slice(0, 240),
  };
}

async function settleControl(promise, label) {
  try {
    const value = await withTimeout(promise, label, CONTROL_TIMEOUT_MS);
    return { settled: 'resolved', value, valueType: typeof value };
  } catch (error) {
    return safeError(error);
  }
}

function countMessage(trace, message) {
  const key = message && message.type === 'system'
    ? `system:${message.subtype || 'unknown'}`
    : String((message && message.type) || 'unknown');
  trace.counts[key] = (trace.counts[key] || 0) + 1;
}

function idFacts(value) {
  assert.match(value, SAFE_OBSERVED_ID, 'شكل معرّف SDK غير متوقع');
  return { prefix: value.split(/[_-]/)[0], length: value.length };
}

function bashPrompt(delayMs, marker) {
  const command = `node -e "setTimeout(() => console.log('${marker}'), ${delayMs})"`;
  return [
    'This is a deterministic SDK control-method probe.',
    `Use the Bash tool exactly once with this exact command: ${command}`,
    'Do not use run_in_terminal or any other tool.',
    'After Bash returns, reply with exactly PROBE_DONE.',
  ].join('\n');
}

async function runScenario({ sdk, cwd, claudePath, mode }) {
  const trace = {
    counts: {}, toolUseId: '', taskId: '', toolInput: null, background: null, stop: null,
    notification: null, resultSubtype: '',
  };
  const delayMs = mode === 'complete' ? COMPLETE_DELAY_MS : STOP_DELAY_MS;
  const marker = mode === 'complete' ? 'SATR_BACKGROUND_COMPLETE' : 'SATR_BACKGROUND_STOP';
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  let resolveFinished;
  let rejectFinished;
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  let backgroundRequested = false;
  let stopRequested = false;
  let backgroundAt = 0;

  async function* input() {
    yield {
      type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: bashPrompt(delayMs, marker) },
    };
    await inputClosed;
  }

  const query = sdk.query({
    prompt: input(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      tools: ['Bash'],
      allowedTools: ['Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      maxTurns: 4,
      maxBudgetUsd: 1,
      model: process.env.SATR_SDK_BACKGROUND_PROBE_MODEL || 'sonnet',
      canUseTool: async (toolName, toolInput) => {
        assert.equal(toolName, 'Bash', `أداة غير متوقعة: ${toolName}`);
        trace.toolInput = toolInput;
        return { behavior: 'allow', updatedInput: { ...toolInput, run_in_background: false } };
      },
    },
  });

  const consume = (async () => {
    try {
      for await (const message of query) {
        countMessage(trace, message);
        for (const block of messageContent(message)) {
          if (block && block.type === 'tool_use' && block.name === 'Bash') {
            trace.toolUseId = String(block.id || '');
            trace.toolInput = block.input || trace.toolInput;
          }
        }
        const messageToolUseId = typeof (message && message.tool_use_id) === 'string' ? message.tool_use_id : '';
        const messageTaskId = typeof (message && message.task_id) === 'string' ? message.task_id : '';
        if (messageToolUseId && !trace.toolUseId) trace.toolUseId = messageToolUseId;
        if (messageTaskId && (!messageToolUseId || messageToolUseId === trace.toolUseId)) trace.taskId = messageTaskId;
        if (!backgroundRequested && message
            && (message.type === 'tool_progress' || message.type === 'system' && message.subtype === 'task_started')
            && message.tool_use_id === trace.toolUseId) {
          backgroundRequested = true;
          backgroundAt = Date.now();
          const response = await settleControl(query.backgroundTasks(trace.toolUseId), `backgroundTasks (${mode})`);
          trace.background = { ...response, elapsedMs: Date.now() - backgroundAt };
        }
        if (mode === 'stop' && backgroundRequested && !stopRequested && trace.taskId) {
          stopRequested = true;
          const stopAt = Date.now();
          const response = await settleControl(query.stopTask(trace.taskId), 'stopTask');
          trace.stop = { ...response, elapsedMs: Date.now() - stopAt };
        }
        if (message && message.type === 'system' && message.subtype === 'task_notification'
            && (!trace.toolUseId || message.tool_use_id === trace.toolUseId)) {
          trace.notification = {
            keys: Object.keys(message).sort(),
            status: message.status,
            summaryLength: typeof message.summary === 'string' ? message.summary.length : 0,
            outputFilePresent: typeof message.output_file === 'string',
            toolUseIdPresent: typeof message.tool_use_id === 'string',
            usagePresent: !!message.usage,
            usage: message.usage || null,
            elapsedAfterBackgroundMs: backgroundAt ? Date.now() - backgroundAt : null,
          };
          resolveFinished();
        }
        if (message && message.type === 'result') trace.resultSubtype = String(message.subtype || '');
      }
      if (!trace.notification) rejectFinished(new Error(`انتهى Query (${mode}) بلا task_notification`));
    } catch (error) {
      rejectFinished(error);
      throw error;
    }
  })();

  try {
    await withTimeout(finished, `task_notification (${mode})`);
    assert.equal(trace.background && trace.background.settled, 'resolved', 'فشلت backgroundTasks');
    assert.equal(trace.background.value, true, 'لم تُنقل المهمة إلى الخلفية');
    assert.equal(trace.background.valueType, 'boolean', 'نوع استجابة backgroundTasks غير boolean');
    assert.ok(trace.notification, 'لم يصل task_notification');
    if (mode === 'complete') {
      assert.equal(trace.notification.status, 'completed', 'لم تكتمل مهمة الخلفية');
    } else {
      assert.equal(trace.stop && trace.stop.settled, 'resolved', 'فشلت stopTask');
      assert.equal(trace.stop.valueType, 'undefined', 'stopTask لم تُعد void');
      assert.equal(trace.notification.status, 'stopped', 'لم تصل حالة stopped');
    }
    trace.toolUseIdFacts = idFacts(trace.toolUseId);
    trace.taskIdFacts = idFacts(trace.taskId);
    return { trace, query, consume, closeInput };
  } catch (error) {
    console.error(JSON.stringify({ mode, trace }, null, 2));
    closeInput();
    query.close();
    await consume.catch(() => {});
    throw error;
  }
}

async function closeScenario(scenario) {
  scenario.closeInput();
  await withTimeout(scenario.consume, 'إغلاق Query', 30000).catch(() => {});
  scenario.query.close();
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudePath = globalClaudeBin();
  const cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8' }).trim();
  const sdkVersion = require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json').version;
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-sdk-background-probe-'));
  let completeScenario;
  let stopScenario;

  try {
    completeScenario = await runScenario({ sdk, cwd, claudePath, mode: 'complete' });
    const unknownToolUseId = `toolu_${'0'.repeat(24)}`;
    const unknownTaskId = '000000000';
    const invalidWhileActive = {
      background: await settleControl(completeScenario.query.backgroundTasks(unknownToolUseId), 'backgroundTasks unknown'),
      stop: await settleControl(completeScenario.query.stopTask(unknownTaskId), 'stopTask unknown'),
    };
    await closeScenario(completeScenario);
    const ended = {
      background: await settleControl(
        completeScenario.query.backgroundTasks(completeScenario.trace.toolUseId),
        'backgroundTasks ended',
      ),
      stop: await settleControl(completeScenario.query.stopTask(completeScenario.trace.taskId), 'stopTask ended'),
    };

    stopScenario = await runScenario({ sdk, cwd, claudePath, mode: 'stop' });
    await closeScenario(stopScenario);

    console.log(JSON.stringify({
      ok: true,
      sdkVersion,
      cliVersion,
      model: process.env.SATR_SDK_BACKGROUND_PROBE_MODEL || 'sonnet',
      configuredDelaysMs: { complete: COMPLETE_DELAY_MS, stop: STOP_DELAY_MS },
      complete: completeScenario.trace,
      stop: stopScenario.trace,
      invalidWhileActive,
      ended,
    }, null, 2));
  } finally {
    if (completeScenario) await closeScenario(completeScenario).catch(() => {});
    if (stopScenario) await closeScenario(stopScenario).catch(() => {});
    await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`sdk-background-probe فشل: ${error && error.stack || error}`);
  process.exitCode = 1;
});