#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TIMEOUT_MS = 240000;
const PROGRESS_DELAY_MS = 42000;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function sdkUser(content) {
  return {
    type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content },
  };
}

function publicShape(value) {
  const out = { keys: Object.keys(value || {}).sort() };
  for (const key of out.keys) {
    const item = value[key];
    if (key === 'compact_summary' || key === 'error') out[key + 'Length'] = typeof item === 'string' ? item.length : null;
    else if (key === 'tool_input') out.toolInputKeys = item && typeof item === 'object' ? Object.keys(item).sort() : [];
    else if (!['cwd', 'session_id', 'transcript_path', 'permission_mode'].includes(key)) out[key] = item;
  }
  return out;
}

async function runWarmupScenario({ sdk, cwd, claudePath, model }) {
  let sessionId = '';
  let resultCount = 0;
  const query = sdk.query({
    prompt: 'Reply with exactly FIRST_OK and use no tools.',
    options: {
      cwd, pathToClaudeCodeExecutable: claudePath, settingSources: [], tools: [],
      promptSuggestions: true, persistSession: true, maxTurns: 2, maxBudgetUsd: 1, model,
    },
  });
  await withTimeout((async () => {
    for await (const message of query) {
      if (SAFE_UUID.test(String(message && message.session_id || ''))) sessionId = message.session_id;
      if (message && message.type === 'result') resultCount += 1;
    }
  })(), 'warmup');
  query.close();
  assert.match(sessionId, SAFE_UUID, 'لم يُلتقط session_id تمهيدي صالح');
  assert.equal(resultCount, 1, 'عدد نتائج الدور التمهيدي غير متوقع');
  return { sessionId, resultCount };
}

async function runSuggestionScenario({ sdk, cwd, claudePath, model, sessionId }) {
  const trace = {
    resultCount: 0, suggestionCount: 0, suggestionAfterResult: false,
    resultToSuggestionMs: null, inputCloseAfterResultMs: null, closeReason: '', suggestionShape: null,
  };
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  let resultAt = 0;
  let inputClosedAt = 0;
  let closeTimer = null;
  async function* input() {
    yield sdkUser('Reply with exactly SECOND_OK and use no tools.');
    await inputClosed;
  }
  const query = sdk.query({ prompt: input(), options: {
    cwd, resume: sessionId, pathToClaudeCodeExecutable: claudePath, settingSources: [], tools: [],
    promptSuggestions: true, persistSession: false, maxTurns: 2, maxBudgetUsd: 1, model,
  } });
  try {
    await withTimeout((async () => {
      for await (const message of query) {
        if (message && message.type === 'result') {
          trace.resultCount += 1;
          resultAt = Date.now();
          closeTimer = setTimeout(() => {
            trace.closeReason = '15000ms_timeout';
            inputClosedAt = Date.now();
            closeInput();
          }, 15000);
        }
        if (message && message.type === 'prompt_suggestion') {
          trace.suggestionCount += 1;
          trace.suggestionAfterResult = trace.resultCount > 0;
          trace.resultToSuggestionMs = resultAt ? Date.now() - resultAt : null;
          trace.suggestionShape = {
            keys: Object.keys(message).sort(), suggestionLength: typeof message.suggestion === 'string' ? message.suggestion.length : null,
            uuidValid: SAFE_UUID.test(String(message.uuid || '')), sessionIdValid: SAFE_UUID.test(String(message.session_id || '')),
          };
          if (!inputClosedAt) {
            trace.closeReason = 'suggestion';
            inputClosedAt = Date.now();
            closeInput();
          }
        }
      }
    })(), 'prompt_suggestion', 120000);
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
    closeInput();
    query.close();
  }
  trace.inputCloseAfterResultMs = resultAt && inputClosedAt ? inputClosedAt - resultAt : null;
  assert.equal(trace.resultCount, 1, 'لم يكتمل دور الاقتراح المستأنف');
  trace.suppressedOrUnsupported = trace.suggestionCount === 0;
  if (trace.suggestionCount) assert.equal(trace.suggestionAfterResult, true, 'وصل الاقتراح قبل result');
  return trace;
}

async function runFailureAndPermissionScenario({ sdk, cwd, claudePath, model }) {
  const trace = { permissionReturns: [], failureHook: null, resultSubtype: '' };
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  let callCount = 0;
  async function postToolUseFailure(input) { trace.failureHook = publicShape(input); return { continue: true }; }
  async function* input() {
    yield sdkUser([
      'Run Bash exactly three times in order.',
      'First: node -e "process.exit(7)"',
      'Second: node -e "console.log(\'PERMISSION_OK\')"',
      'Third: node -e "console.log(\'SHOULD_NOT_RUN\')"',
      'Continue after failures or denial, then reply exactly PERMISSION_DONE.',
    ].join('\n'));
    await inputClosed;
  }
  const query = sdk.query({ prompt: input(), options: {
    cwd, pathToClaudeCodeExecutable: claudePath, settingSources: [], tools: ['Bash'],
    hooks: { PostToolUseFailure: [{ hooks: [postToolUseFailure] }] }, permissionMode: 'default',
    persistSession: false, maxTurns: 8, maxBudgetUsd: 1, model,
    canUseTool: async (toolName, toolInput, context) => {
      callCount += 1;
      assert.equal(toolName, 'Bash');
      const classification = callCount === 1 ? 'user_temporary' : callCount === 2 ? 'user_permanent' : 'user_reject';
      const behavior = callCount === 3 ? 'deny' : 'allow';
      trace.permissionReturns.push({ call: callCount, behavior, decisionClassification: classification, contextKeys: Object.keys(context || {}).sort() });
      return behavior === 'allow'
        ? { behavior, updatedInput: toolInput, decisionClassification: classification }
        : { behavior, message: 'probe rejection', decisionClassification: classification };
    },
  } });
  await withTimeout((async () => {
    for await (const message of query) {
      if (message && message.type === 'result') { trace.resultSubtype = String(message.subtype || ''); closeInput(); }
    }
  })(), 'PostToolUseFailure/decisionClassification');
  query.close();
  assert.ok(trace.failureHook, 'لم يصل PostToolUseFailure');
  assert.ok(trace.permissionReturns.length >= 2, 'لم تمر قرارات الإذن عبر canUseTool');
  return trace;
}

async function runCompactScenario({ sdk, cwd, claudePath, model, sessionId }) {
  const trace = { hook: null, compactBoundaryKeys: [], resultSubtype: '', resultToHookMs: null, closeReason: '' };
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  let resultAt = 0;
  let closeTimer = null;
  async function postCompact(input) {
    trace.hook = publicShape(input);
    trace.resultToHookMs = resultAt ? Date.now() - resultAt : null;
    if (resultAt) { trace.closeReason = 'hook'; closeInput(); }
    return { continue: true };
  }
  async function* input() { yield sdkUser('/compact'); await inputClosed; }
  const query = sdk.query({ prompt: input(), options: {
    cwd, resume: sessionId, pathToClaudeCodeExecutable: claudePath, settingSources: [], tools: [],
    hooks: { PostCompact: [{ hooks: [postCompact] }] }, persistSession: false, maxTurns: 2, maxBudgetUsd: 1, model,
  } });
  try {
    await withTimeout((async () => {
      for await (const message of query) {
        if (message && message.type === 'system' && message.subtype === 'compact_boundary') trace.compactBoundaryKeys = Object.keys(message).sort();
        if (message && message.type === 'result') {
          trace.resultSubtype = String(message.subtype || '');
          resultAt = Date.now();
          if (trace.hook) { trace.closeReason = 'hook_before_result'; closeInput(); }
          else closeTimer = setTimeout(() => { trace.closeReason = '15000ms_timeout'; closeInput(); }, 15000);
        }
      }
    })(), 'PostCompact', 120000);
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
    closeInput();
    query.close();
  }
  trace.suppressedOrUnsupported = !trace.hook;
  return trace;
}

async function runProgressScenario({ sdk, cwd, claudePath, model }) {
  const trace = { taskProgressCount: 0, firstSummary: null, resultSubtype: '' };
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  async function* input() {
    const nonce = 'SATR_PROGRESS_' + Date.now();
    yield sdkUser([
      'Tracking nonce: ' + nonce + '.',
      'Use the Agent tool exactly once with subagent_type general-purpose.',
      'Tell that agent to run this exact Bash command and wait for it:',
      `node -e "setTimeout(() => console.log('SATR_PROGRESS_DONE'), ${PROGRESS_DELAY_MS})"`,
      'Then have it report PROGRESS_AGENT_DONE. After it returns, reply PROGRESS_PARENT_DONE.',
    ].join('\n'));
    await inputClosed;
  }
  const query = sdk.query({ prompt: input(), options: {
    cwd, pathToClaudeCodeExecutable: claudePath, settingSources: [], tools: ['Agent', 'Task', 'Bash'],
    allowedTools: ['Agent', 'Task', 'Bash'], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    agentProgressSummaries: true, persistSession: false, maxTurns: 8, maxBudgetUsd: 2, model,
    canUseTool: async (toolName, toolInput) => ({ behavior: 'allow', updatedInput: toolInput, decisionClassification: 'user_temporary' }),
  } });
  await withTimeout((async () => {
    for await (const message of query) {
      if (message && message.type === 'system' && message.subtype === 'task_progress') {
        trace.taskProgressCount += 1;
        if (!trace.firstSummary && typeof message.summary === 'string') {
          trace.firstSummary = {
            keys: Object.keys(message).sort(), summaryLength: message.summary.length, summary: message.summary,
            descriptionLength: typeof message.description === 'string' ? message.description.length : null,
            usageKeys: message.usage && typeof message.usage === 'object' ? Object.keys(message.usage).sort() : [],
          };
        }
      }
      if (message && message.type === 'result') { trace.resultSubtype = String(message.subtype || ''); closeInput(); }
    }
  })(), 'agentProgressSummaries');
  query.close();
  console.log('[probe] progress-trace=' + JSON.stringify(trace));
  // الملخص الدوري best-effort upstream (مثبت بالإعادات المنفردة): غيابه ملاحظة لا فشل.
  // البنيوي المضمون: وصول task_progress نفسه ونجاح الدور.
  assert.ok(trace.taskProgressCount > 0, 'لم يصل أي task_progress');
  assert.strictEqual(trace.resultSubtype, 'success', 'دور الوكيل لم ينجح');
  trace.summaryObserved = !!trace.firstSummary;
  return trace;
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudePath = globalClaudeBin();
  const cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8' }).trim();
  const sdkVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
  const model = process.env.SATR_SDK_POLISH_PROBE_MODEL || 'haiku';
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-sdk-polish-probe-'));
  try {
    if (process.argv.includes('--progress-only')) {
      const agentProgress = await runProgressScenario({ sdk, cwd, claudePath, model });
      console.log(JSON.stringify({ ok: true, sdkVersion, cliVersion, model, configuredProgressDelayMs: PROGRESS_DELAY_MS, agentProgress }, null, 2));
      return;
    }
    console.log('[probe] warmup');
    const warmup = await runWarmupScenario({ sdk, cwd, claudePath, model });
    console.log('[probe] prompt_suggestion');
    const promptSuggestion = await runSuggestionScenario({ sdk, cwd, claudePath, model, sessionId: warmup.sessionId });
    console.log('[probe] suggestion=' + JSON.stringify(promptSuggestion));
    console.log('[probe] PostToolUseFailure/decisionClassification');
    const failureAndPermission = await runFailureAndPermissionScenario({ sdk, cwd, claudePath, model });
    console.log('[probe] failure=' + JSON.stringify(failureAndPermission));
    console.log('[probe] PostCompact');
    const postCompact = await runCompactScenario({ sdk, cwd, claudePath, model, sessionId: warmup.sessionId });
    console.log('[probe] compact=' + JSON.stringify(postCompact));
    console.log('[probe] agentProgressSummaries');
    const agentProgress = await runProgressScenario({ sdk, cwd, claudePath, model });
    console.log(JSON.stringify({
      ok: true, sdkVersion, cliVersion, model, configuredProgressDelayMs: PROGRESS_DELAY_MS, warmup,
      promptSuggestion, agentProgress, postToolUseFailure: failureAndPermission.failureHook,
      decisionClassification: { location: 'top-level canUseTool PermissionResult', returns: failureAndPermission.permissionReturns, resultSubtype: failureAndPermission.resultSubtype },
      postCompact,
    }, null, 2));
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
  }
}

main().catch((error) => { console.error(`sdk-polish-probe فشل: ${error && error.stack || error}`); process.exitCode = 1; });
