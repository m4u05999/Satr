#!/usr/bin/env node
'use strict';

// مسبار OBS-094 (البند صفر — قِس قبل أن تعرض): يبثّ وكيلاً فرعياً متداخلاً عبر SDK الحي
// ويقيس أي حقول شجرة الوكلاء تصل فعلاً وأيّها لا يصل:
//   - هل رسائل assistant المبثوثة تحمل parent_agent_id / spawn_depth / is_backgrounded؟
//   - ماذا يحمل system/task_started (is_backgrounded، spawn_depth، task_type)؟
//   - هل يتجاوز spawn_depth قيمة 1؟ (‏OBS-084: 0.3.217 خفّض عمق subagents المتداخلة إلى 1)
//   - ماذا يصل بعد backgroundTasks() (‏task_updated.patch.is_backgrounded)؟
// الناتج JSON حرفي يُلصق في تقرير الدفعة.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TIMEOUT_MS = 240000;
const SLEEP_MS = 15000;

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

function safeError(error) {
  return {
    settled: 'rejected',
    message: typeof (error && error.message) === 'string' ? error.message.slice(0, 240) : String(error).slice(0, 240),
  };
}

async function settleControl(promise, label, timeoutMs = 15000) {
  try {
    const value = await withTimeout(promise, label, timeoutMs);
    return { settled: 'resolved', value, valueType: typeof value };
  } catch (error) {
    return safeError(error);
  }
}

function contentBlocks(message) {
  const content = message && message.message && message.message.content;
  return Array.isArray(content) ? content : [];
}

// سيناريو: وكيل فرعي واحد (عمق 1) ثم محاولة تداخل داخله + نقل للخلفية.
async function runScenario({ sdk, cwd, claudePath, mode }) {
  const trace = {
    mode,
    counts: {},
    assistantEnvelope: null, // مفاتيح أول رسالة assistant داخل وكيل فرعي (parent_tool_use_id مضبوط)
    assistantDeclaredObserved: {}, // قيم subagent_type/task_description الفعلية إن وصلت
    assistantTreeFields: {}, // أي من الحقول الثلاثة الجديدة على الرسالة نفسها
    taskToolInputKeys: null,
    taskStarted: [], // {seq, keys, is_backgrounded, spawn_depth, task_type, subagent_type, hasToolUseId}
    taskUpdated: [], // {seq, patchKeys, isBackgrounded}
    order: { taskToolUseSeq: null, firstTaskStartedSeq: null },
    backgroundControl: null,
    nestedTaskStartedDepths: [],
    nestedAttemptErrors: [],
    innerFinalText: '',
    resultSubtype: '',
  };
  const marker = mode === 'nested' ? 'PROBE_NEST' : 'PROBE_FLAT';
  const prompt = mode === 'nested'
    ? [
        'This is a deterministic SDK probe about subagent nesting.',
        'Use the Task tool exactly once with subagent_type "general-purpose" and this exact prompt:',
        `"Inside this subagent, attempt to use the Task tool once more (subagent_type \\"general-purpose\\") with prompt 'Reply with exactly INNER_OK'. Then, whatever the outcome, reply with exactly ${marker}_TRIED."`,
        'Do not run any Bash command. Do not use any tool other than Task.',
        `After the Task tool returns, reply with exactly ${marker}_MAIN_DONE.`,
      ].join('\n')
    : [
        'This is a deterministic SDK probe about subagent tasks.',
        `Use the Task tool exactly once with subagent_type "general-purpose" and this exact prompt:`,
        `"Run exactly this single command with the Bash tool: node -e \\"setTimeout(() => console.log('${marker}_SLEEP'), ${SLEEP_MS})\\". Wait for it to finish. Then reply with exactly ${marker}_INNER_DONE."`,
        'Do not use any other tool yourself.',
        `After the Task tool returns, reply with exactly ${marker}_MAIN_DONE.`,
      ].join('\n');

  let seq = 0;
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  let finished;
  const done = new Promise((resolve, reject) => { finished = { resolve, reject }; });

  async function* input() {
    yield {
      type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: prompt },
    };
    await inputClosed;
  }

  const query = sdk.query({
    prompt: input(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      maxTurns: 6,
      maxBudgetUsd: 1,
      model: process.env.SATR_SUBAGENT_PROBE_MODEL || 'sonnet',
    },
  });

  let backgroundRequested = false;

  const consume = (async () => {
    try {
      for await (const message of query) {
        seq += 1;
        const key = message && message.type === 'system'
          ? `system:${message.subtype || 'unknown'}` : String((message && message.type) || 'unknown');
        trace.counts[key] = (trace.counts[key] || 0) + 1;

        if (message && message.type === 'assistant') {
          const parentId = message.parent_tool_use_id;
          if (parentId && !trace.assistantEnvelope) {
            trace.assistantEnvelope = Object.keys(message).sort();
            for (const f of ['parent_agent_id', 'spawn_depth', 'is_backgrounded']) {
              if (f in message) trace.assistantTreeFields[f] = message[f];
            }
          }
          if (parentId) {
            if (message.subagent_type !== undefined) trace.assistantDeclaredObserved.subagent_type = message.subagent_type;
            if (message.task_description !== undefined) trace.assistantDeclaredObserved.task_description = message.task_description;
          }
          for (const block of contentBlocks(message)) {
            if (block && block.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent')) {
              if (trace.order.taskToolUseSeq === null) {
                trace.order.taskToolUseSeq = seq;
                trace.taskToolInputKeys = block.input ? Object.keys(block.input).sort() : null;
              }
            }
          }
        }

        if (message && message.type === 'system' && message.subtype === 'task_started') {
          const entry = {
            seq,
            keys: Object.keys(message).sort(),
            is_backgrounded: message.is_backgrounded === undefined ? '<absent>' : message.is_backgrounded,
            spawn_depth: message.spawn_depth === undefined ? '<absent>' : message.spawn_depth,
            task_type: message.task_type === undefined ? '<absent>' : message.task_type,
            subagent_type: message.subagent_type === undefined ? '<absent>' : message.subagent_type,
            hasToolUseId: typeof message.tool_use_id === 'string' && message.tool_use_id.length > 0,
          };
          trace.taskStarted.push(entry);
          if (trace.order.firstTaskStartedSeq === null) trace.order.firstTaskStartedSeq = seq;
          if (typeof message.spawn_depth === 'number' && message.spawn_depth >= 2) {
            trace.nestedTaskStartedDepths.push(message.spawn_depth);
          }
          // نقل الوكيل الفرعي إلى الخلفية لقياس task_updated.patch.is_backgrounded
          if (mode === 'flat' && !backgroundRequested && entry.hasToolUseId && message.tool_use_id) {
            backgroundRequested = true;
            const at = Date.now();
            const response = await settleControl(query.backgroundTasks(message.tool_use_id), 'backgroundTasks');
            trace.backgroundControl = { ...response, elapsedMs: Date.now() - at };
          }
        }

        if (message && message.type === 'system' && message.subtype === 'task_updated') {
          const patch = message.patch || {};
          trace.taskUpdated.push({
            seq,
            patchKeys: Object.keys(patch).sort(),
            isBackgrounded: patch.is_backgrounded === undefined ? '<absent>' : patch.is_backgrounded,
          });
        }

        if (message && message.type === 'user' && Array.isArray(message.message && message.message.content)) {
          for (const block of message.message.content) {
            if (block && block.type === 'tool_result' && block.is_error
                && typeof block.content === 'string' && /subagent|depth|task/i.test(block.content)) {
              trace.nestedAttemptErrors.push(block.content.slice(0, 200));
            }
          }
        }

        if (message && message.type === 'assistant' && message.parent_tool_use_id) {
          for (const block of contentBlocks(message)) {
            if (block && block.type === 'text' && block.text && block.text.includes(marker)) {
              trace.innerFinalText = block.text.slice(0, 160);
            }
          }
        }

        if (message && message.type === 'result') {
          trace.resultSubtype = String(message.subtype || '');
          finished.resolve();
        }
      }
      if (!trace.resultSubtype) finished.reject(new Error(`انتهى Query (${mode}) بلا result`));
    } catch (error) {
      finished.reject(error);
    }
  })();

  try {
    await withTimeout(done, `result (${mode})`);
    return { trace, closeInput };
  } catch (error) {
    console.error(JSON.stringify({ mode, trace }, null, 2));
    throw error;
  } finally {
    closeInput();
    query.close();
    await consume.catch(() => {});
  }
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudePath = globalClaudeBin();
  const cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8' }).trim();
  const sdkVersion = require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json').version;
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-subagent-tree-probe-'));

  try {
    const flat = await runScenario({ sdk, cwd, claudePath, mode: 'flat' });
    const nested = await runScenario({ sdk, cwd, claudePath, mode: 'nested' });
    console.log(JSON.stringify({
      ok: true,
      sdkVersion,
      cliVersion,
      model: process.env.SATR_SUBAGENT_PROBE_MODEL || 'sonnet',
      flat: flat.trace,
      nested: nested.trace,
    }, null, 2));
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`subagent-tree-probe فشل: ${error && error.stack || error}`);
  process.exitCode = 1;
});
