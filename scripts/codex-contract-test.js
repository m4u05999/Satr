#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function fixtureSource() {
  return String.raw`'use strict';
const fs = require('fs');
const readline = require('readline');
const rootThreadId = '019f8353-fe7f-7af2-b937-5337170f5f3e';
const rootTurnId = '019f8353-fe7f-7af2-b937-5337170f5f3f';
const childThreadId = '019f8353-fe7f-7af2-b937-5337170f6000';
const childTurnId = '019f8353-fe7f-7af2-b937-5337170f6001';
let sawInitialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function log(value) { fs.appendFileSync(process.env.SATR_CODEX_CONTRACT_LOG, JSON.stringify(value) + '\n', 'utf8'); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') { reply(message.id, { userAgent: 'fixture' }); return; }
  if (message.method === 'initialized') { sawInitialized = true; return; }
  if (message.method === 'thread/start') {
    if (!sawInitialized) process.exit(20);
    reply(message.id, { thread: { id: rootThreadId } });
    return;
  }
  if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: rootTurnId, status: 'inProgress' } });
    send({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: childThreadId } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: {
      threadId: childThreadId, turn: { id: childTurnId, status: 'inProgress' },
    } });
    send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
      threadId: childThreadId, turnId: childTurnId, tokenUsage: {
        total: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1998 },
        last: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1998 },
        modelContextWindow: 999999,
      },
    } });
    send({ jsonrpc: '2.0', method: 'turn/plan/updated', params: {
      threadId: childThreadId, turnId: childTurnId,
      plan: [{ step: 'CHILD_PLAN', status: 'inProgress' }],
    } });
    send({ jsonrpc: '2.0', method: 'item/started', params: {
      threadId: childThreadId, turnId: childTurnId, startedAtMs: Date.now(),
      item: { id: 'child-command', type: 'commandExecution', command: 'CHILD_COMMAND' },
    } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: {
      threadId: childThreadId, turnId: childTurnId, completedAtMs: Date.now(),
      item: { id: 'child-command', type: 'commandExecution', command: 'CHILD_COMMAND', aggregatedOutput: 'CHILD_OUTPUT', exitCode: 0 },
    } });
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
      threadId: childThreadId, turnId: childTurnId, itemId: 'child-message', delta: 'CHILD_BRANCH_FINAL',
    } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: {
      threadId: childThreadId, turnId: childTurnId, completedAtMs: Date.now(),
      item: { id: 'child-message', type: 'agentMessage', text: 'CHILD_BRANCH_FINAL', phase: 'final_answer' },
    } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: {
      threadId: childThreadId, turn: { id: childTurnId, status: 'completed' },
    } });
    send({ jsonrpc: '2.0', id: 0, method: 'item/tool/requestUserInput', params: {
      itemId: 'question', threadId: rootThreadId,
      turnId: rootTurnId, questions: [
        { id: 'secret', header: 'Secret', question: 'Value?', isSecret: true, options: null },
        { id: 'mode', header: 'Mode', question: 'Choose', isOther: true,
          options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
      ],
    } });
    return;
  }
  if (message.id === 0 && !message.method) {
    log({ type: 'question', result: message.result });
    send({ jsonrpc: '2.0', method: 'item/started', params: {
      threadId: rootThreadId, turnId: rootTurnId, startedAtMs: Date.now(),
      item: { id: 'outside', type: 'fileChange',
        changes: [{ path: process.env.SATR_CODEX_OUTSIDE_PATH, kind: { type: 'update' } }] },
    } });
    send({ jsonrpc: '2.0', id: 900, method: 'item/fileChange/requestApproval', params: { itemId: 'outside' } });
    return;
  }
  if (message.id === 900 && !message.method) {
    log({ type: 'outside', result: message.result });
    send({ jsonrpc: '2.0', id: 902, method: 'mcpServer/elicitation/request', params: {
      serverName: 'satr_preview', threadId: rootThreadId,
      turnId: rootTurnId, mode: 'form',
      message: 'Allow the satr_preview MCP server to run tool "list_background_tasks"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'],
        tool_description: 'List tasks', tool_params: {}, tool_params_display: [] },
    } });
    return;
  }
  if (message.id === 902 && !message.method) {
    log({ type: 'mcp-approval', result: message.result });
    send({ jsonrpc: '2.0', id: 901, method: 'mcpServer/elicitation/request', params: {
      serverName: 'fixture', threadId: rootThreadId,
      turnId: rootTurnId, mode: 'form', message: 'Configure',
      requestedSchema: { type: 'object', properties: {
        tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
        count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 },
      } },
    } });
    return;
  }
  if (message.id === 901 && !message.method) {
    log({ type: 'elicitation', result: message.result });
    send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
      threadId: rootThreadId, turnId: rootTurnId, tokenUsage: {
      total: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningOutputTokens: 2, totalTokens: 14 },
      last: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningOutputTokens: 2, totalTokens: 14 },
      modelContextWindow: 128000,
    } } });
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
      threadId: rootThreadId, turnId: rootTurnId, itemId: 'root-message', delta: 'ROOT_FINAL',
    } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: {
      threadId: rootThreadId, turnId: rootTurnId, completedAtMs: Date.now(),
      item: { id: 'root-message', type: 'agentMessage', text: 'ROOT_FINAL', phase: 'final_answer' },
    } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: {
      threadId: rootThreadId, turn: { id: rootTurnId, status: 'completed' },
    } });
  }
});
`;
}

async function waitFor(check, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timeout');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satr-codex-contract-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside.txt');
  const logFile = path.join(root, 'protocol.jsonl');
  try {
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'app-server'), fixtureSource(), 'utf8');
    await fs.writeFile(outside, 'outside\n', 'utf8');
    process.env.CODEX_BIN = process.execPath;
    process.env.SATR_CODEX_CONTRACT_LOG = logFile;
    process.env.SATR_CODEX_OUTSIDE_PATH = outside;
    delete require.cache[require.resolve('../electron/codex')];
    const codex = require('../electron/codex');
    codex.resolveCodexBin(true);

    assert.strictEqual(codex._internals.projectPath(project, 'inside.txt'), path.join(project, 'inside.txt'));
    assert.strictEqual(codex._internals.projectPath(project, outside), null);
    assert.strictEqual(codex._internals.projectPath(project, '..\\outside.txt'), null);
    const internalApproval = { serverName: 'satr_preview', mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call' } };
    assert.strictEqual(codex._internals.isInternalMcpApprovalElicitation(internalApproval), true);
    assert.strictEqual(codex._internals.isInternalMcpApprovalElicitation({ ...internalApproval,
      serverName: 'external' }), false);
    assert.strictEqual(codex._internals.isInternalMcpApprovalElicitation({ ...internalApproval,
      requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } }), false);

    const events = [];
    let handle;
    handle = await codex.start({
      prompt: 'contract', images: [], sessionId: null, model: 'gpt-5.6-sol', permissionMode: 'default',
      skills: [], extraDirs: [], browserControl: false,
    }, project, (event) => {
      events.push(event);
      if (event.type === 'question_request') {
        const isMcp = event.questions && event.questions[0] && event.questions[0].header === 'Tags';
        setImmediate(() => handle.resolveQuestion(event.id, isMcp ? [
          { questionIndex: 0, optionIndexes: [0, 1] },
          { questionIndex: 1, optionIndexes: [], text: '3' },
        ] : [
          { questionIndex: 0, optionIndexes: [], text: 'secret-value' },
          { questionIndex: 1, optionIndexes: [], text: 'custom-mode' },
        ]));
      }
    });
    await waitFor(() => events.some((event) => event.type === 'proc_done'));
    const records = (await fs.readFile(logFile, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const question = records.find((record) => record.type === 'question');
    const outsideDecision = records.find((record) => record.type === 'outside');
    const mcpApproval = records.find((record) => record.type === 'mcp-approval');
    const elicitation = records.find((record) => record.type === 'elicitation');
    assert.deepStrictEqual(question.result, { answers: {
      secret: { answers: ['secret-value'] }, mode: { answers: ['custom-mode'] },
    } });
    assert.deepStrictEqual(outsideDecision.result, { decision: 'decline' });
    assert.deepStrictEqual(mcpApproval.result, { action: 'accept', content: {} });
    assert.deepStrictEqual(elicitation.result, { action: 'accept', content: { tags: ['a', 'b'], count: 3 } });
    assert(!events.some((event) => event.type === 'permission_request' && event.tool === 'apply_patch'));
    const renderedText = events.flatMap((event) => event && event.message && Array.isArray(event.message.content)
      ? event.message.content.map((block) => block && block.text || '') : []).join('\n');
    assert(renderedText.includes('ROOT_FINAL'), 'لم تصل رسالة الجذر النهائية');
    assert(!renderedText.includes('CHILD_BRANCH_FINAL'), 'تسرّبت رسالة وكيل فرعي إلى إجابة الجذر');
    assert(!events.some((event) => event.type === 'usage_update' && event.usage && event.usage.input === 999),
      'تسرّب استخدام الوكيل الفرعي إلى استخدام الجذر');
    assert(!events.some((event) => event.type === 'task_update'
      && event.tasks && event.tasks.some((task) => task.title === 'CHILD_PLAN')),
    'تسرّبت خطة الوكيل الفرعي إلى خطة الجذر');
    assert(!events.some((event) => event.type === 'assistant' && event.message
      && event.message.content && event.message.content.some((block) => block.id === 'child-command')),
    'تسرّبت أداة الوكيل الفرعي إلى بطاقات الجذر');
    assert(!events.some((event) => event.type === 'system' && event.subtype === 'init'
      && event.session_id === '019f8353-fe7f-7af2-b937-5337170f6000'),
    'استُبدلت هوية خيط الجذر بهوية وكيل فرعي');
    const result = events.find((event) => event.type === 'result');
    assert(result && result.usage && result.usage.input === 10 && result.usage.reasoning === 2);
    assert.strictEqual(result.session_id, '019f8353-fe7f-7af2-b937-5337170f5f3e');
    assert.strictEqual(result.context_window, 128000);
    console.log('codex-contract: نجح — handshake، إدخال، مسارات، usage، وعزل أحداث الفروع.');
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.SATR_CODEX_CONTRACT_LOG;
    delete process.env.SATR_CODEX_OUTSIDE_PATH;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
