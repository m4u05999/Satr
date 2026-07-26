#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TIMEOUT_MS = 180000;
const FORM_TOOL_NAME = 'mcp__elicitation-probe__request_form_elicitation';
const URL_TOOL_NAME = 'mcp__elicitation-probe__request_url_elicitation';
const FORM_MESSAGE = 'اختر اسماً ووصفاً غير سريين لمشروع المسبار.';
const URL_MESSAGE = 'افتح صفحة المصادقة الاصطناعية لإكمال ربط المسبار.';
const URL_ID = 'satr-elicitation-url-probe';
const URL_VALUE = 'https://example.invalid/satr-elicitation-probe';

function globalClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const candidate = path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  const command = process.platform === 'win32' ? 'where' : 'which';
  const found = execFileSync(command, ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  assert.ok(found, 'لم يُعثر على Claude Code العالمي');
  return found;
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`انتهت مهلة ${label}`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
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

function toolResultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

async function runStdioServer() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { UrlElicitationRequiredError } = require('@modelcontextprotocol/sdk/types.js');
  const server = new McpServer({ name: 'satr-elicitation-probe-server', version: '1.0.0' });

  server.registerTool(
    'request_form_elicitation',
    { description: 'اطلب نموذج elicitation غير سري للمسبار.', inputSchema: {} },
    async () => {
      const result = await server.server.elicitInput({
        mode: 'form',
        message: FORM_MESSAGE,
        requestedSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              title: 'اسم المشروع',
              description: 'اسم عرض غير سري',
              maxLength: 80,
            },
            summary: {
              type: 'string',
              title: 'الوصف',
              description: 'وصف موجز غير سري',
              maxLength: 200,
            },
          },
          required: ['projectName'],
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify({ mode: 'form', result }) }] };
    },
  );

  server.registerTool(
    'request_url_elicitation',
    { description: 'اطلب URL elicitation اصطناعياً للمسبار.', inputSchema: {} },
    async () => {
      throw new UrlElicitationRequiredError([{
        mode: 'url',
        message: URL_MESSAGE,
        elicitationId: URL_ID,
        url: URL_VALUE,
      }]);
    },
  );

  await server.connect(new StdioServerTransport());
}

async function runScenario({ sdk, cwd, claudePath, handled }) {
  const trace = {
    callbackRequests: [],
    formResult: null,
    assistantText: [],
    toolCalls: [],
    toolResults: [],
    resultSubtype: '',
    stderr: [],
  };
  const toolNames = new Set([FORM_TOOL_NAME, URL_TOOL_NAME]);
  const options = {
    cwd,
    pathToClaudeCodeExecutable: claudePath,
    settingSources: [],
    mcpServers: {
      'elicitation-probe': {
        type: 'stdio',
        command: process.execPath,
        args: [__filename, '--stdio-server'],
        timeout: TIMEOUT_MS,
        alwaysLoad: true,
      },
    },
    allowedTools: [FORM_TOOL_NAME, URL_TOOL_NAME],
    tools: [],
    persistSession: false,
    maxTurns: 4,
    maxBudgetUsd: 1,
    model: process.env.SATR_ELICITATION_PROBE_MODEL || 'sonnet',
    stderr: (data) => trace.stderr.push(String(data)),
    canUseTool: async (toolName, input) => {
      assert.ok(toolNames.has(toolName), `أداة غير متوقعة: ${toolName}`);
      return { behavior: 'allow', updatedInput: input };
    },
  };

  if (handled) {
    options.onElicitation = async (request, callbackOptions) => {
      trace.callbackRequests.push({
        keys: Object.keys(request || {}).sort(),
        serverName: request && request.serverName,
        message: request && request.message,
        mode: request && request.mode,
        url: request && request.url,
        elicitationId: request && request.elicitationId,
        requestedSchema: request && request.requestedSchema,
        signalAborted: !!(callbackOptions && callbackOptions.signal && callbackOptions.signal.aborted),
      });
      if (request && request.mode === 'url') return { action: 'accept' };
      return {
        action: 'accept',
        content: { projectName: 'Satr Probe', summary: 'Non-secret probe value' },
      };
    };
  }

  const prompt = [
    'This is a deterministic SDK integration probe.',
    `Call ${FORM_TOOL_NAME} exactly once, then call ${URL_TOOL_NAME} exactly once.`,
    'Do not call any other tool. Continue even if either tool reports an error.',
    'After both tool results, reply with exactly PROBE_DONE.',
  ].join('\n');
  const query = sdk.query({ prompt, options });
  const toolNameById = new Map();
  try {
    await withTimeout((async () => {
      for await (const message of query) {
        const content = messageContent(message);
        for (const block of content.filter((item) => item && item.type === 'tool_use')) {
          trace.toolCalls.push(block.name);
          toolNameById.set(block.id, block.name);
        }
        for (const block of content.filter((item) => item && item.type === 'tool_result')) {
          const toolName = toolNameById.get(block.tool_use_id) || '';
          const resultText = toolResultText(block);
          trace.toolResults.push({ toolName, isError: block.is_error === true, text: resultText });
          if (toolName === FORM_TOOL_NAME && !block.is_error) {
            let parsed;
            try { parsed = JSON.parse(resultText); } catch { parsed = null; }
            if (parsed && parsed.mode === 'form') trace.formResult = parsed.result;
          }
        }
        const text = textFrom(message);
        if (text) trace.assistantText.push(text);
        if (message && message.type === 'result') trace.resultSubtype = String(message.subtype || '');
      }
    })(), handled ? 'سيناريو onElicitation' : 'سيناريو الرفض الافتراضي');
  } finally {
    query.close();
  }

  assert.deepEqual(trace.toolCalls, [FORM_TOOL_NAME, URL_TOOL_NAME], 'لم يستدع النموذج أداتي المسبار بالترتيب مرة واحدة');
  assert.equal(trace.resultSubtype, 'success', 'لم ينته دور المسبار بنجاح');
  assert.ok(trace.formResult, 'لم تُلتقط نتيجة form من الخادم');
  assert.ok(trace.toolResults.some((entry) => entry.toolName === URL_TOOL_NAME), 'لم تُلتقط نتيجة أداة URL');
  if (handled) {
    const formRequests = trace.callbackRequests.filter((request) => request.mode === 'form');
    const urlRequests = trace.callbackRequests.filter((request) => request.mode === 'url');
    assert.equal(formRequests.length, 1, 'لم يصل طلب form مرة واحدة');
    assert.ok(urlRequests.length >= 1, 'لم يصل طلب url إلى onElicitation');
    const formRequest = formRequests[0];
    const urlRequest = urlRequests[0];
    assert.equal(formRequest.serverName, 'elicitation-probe');
    assert.equal(formRequest.mode, 'form');
    assert.equal(formRequest.message, FORM_MESSAGE);
    assert.equal(formRequest.requestedSchema.type, 'object');
    assert.deepEqual(Object.keys(formRequest.requestedSchema.properties), ['projectName', 'summary']);
    assert.equal(formRequest.signalAborted, false);
    assert.equal(urlRequest.serverName, 'elicitation-probe');
    assert.equal(urlRequest.mode, 'url');
    assert.equal(urlRequest.message, URL_MESSAGE);
    assert.equal(urlRequest.url, URL_VALUE);
    assert.equal(urlRequest.elicitationId, URL_ID);
    assert.equal(urlRequest.signalAborted, false);
    assert.equal(trace.formResult.action, 'accept');
    assert.equal(trace.formResult.content.projectName, 'Satr Probe');
  } else {
    assert.equal(trace.callbackRequests.length, 0, 'استُدعي callback في سيناريو الغياب');
    assert.equal(trace.formResult.action, 'decline', 'لم يرفض SDK نموذج form تلقائياً');
  }
  return trace;
}

function urlResultSummary(trace) {
  const result = trace.toolResults.find((entry) => entry.toolName === URL_TOOL_NAME) || {};
  return {
    isError: result.isError === true,
    mentionsUrl: typeof result.text === 'string' && result.text.includes(URL_VALUE),
    mentionsDecline: typeof result.text === 'string' && /declin|cancel|رفض|إلغاء/i.test(result.text),
    mentionsAccept: typeof result.text === 'string' && /accept|قبول/i.test(result.text),
    textLength: typeof result.text === 'string' ? result.text.length : 0,
  };
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudePath = globalClaudeBin();
  const cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8' }).trim();
  const sdkVersion = require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json').version;
  const mcpSdkVersion = require('../node_modules/@modelcontextprotocol/sdk/package.json').version;
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-elicitation-probe-'));

  try {
    const handled = await runScenario({ sdk, cwd, claudePath, handled: true });
    const defaulted = await runScenario({ sdk, cwd, claudePath, handled: false });
    const formRequests = handled.callbackRequests.filter((request) => request.mode === 'form');
    const urlRequests = handled.callbackRequests.filter((request) => request.mode === 'url');
    const formRequest = formRequests[0];
    const urlRequest = urlRequests[0];
    console.log(JSON.stringify({
      ok: true,
      sdkVersion,
      mcpSdkVersion,
      cliVersion,
      model: process.env.SATR_ELICITATION_PROBE_MODEL || 'sonnet',
      handled: {
        callbackCalls: handled.callbackRequests.length,
        formCallbackCalls: formRequests.length,
        urlCallbackCalls: urlRequests.length,
        form: {
          keys: formRequest.keys,
          serverName: formRequest.serverName,
          mode: formRequest.mode,
          messageMatched: formRequest.message === FORM_MESSAGE,
          schemaType: formRequest.requestedSchema.type,
          fieldNames: Object.keys(formRequest.requestedSchema.properties),
          fieldCount: Object.keys(formRequest.requestedSchema.properties).length,
          signalAborted: formRequest.signalAborted,
          action: handled.formResult.action,
        },
        url: {
          keys: urlRequest.keys,
          serverName: urlRequest.serverName,
          mode: urlRequest.mode,
          messageMatched: urlRequest.message === URL_MESSAGE,
          url: urlRequest.url,
          elicitationId: urlRequest.elicitationId,
          signalAborted: urlRequest.signalAborted,
          callbackAction: 'accept',
          toolResult: urlResultSummary(handled),
        },
      },
      defaultWithoutHandler: {
        callbackCalls: defaulted.callbackRequests.length,
        formAction: defaulted.formResult.action,
        urlToolResult: urlResultSummary(defaulted),
      },
    }, null, 2));
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
  }
}

if (process.argv[2] === '--stdio-server') {
  runStdioServer().catch((error) => {
    console.error(`elicitation stdio server فشل: ${error && error.stack || error}`);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(`elicitation-probe فشل: ${error && error.stack || error}`);
    process.exitCode = 1;
  });
}
