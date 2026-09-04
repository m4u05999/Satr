#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const chats = require('../electron/chats');
const contextBudget = require('../electron/context');
const envbrief = require('../electron/envbrief');
const memory = require('../electron/memory');
const repomap = require('../electron/repomap');
const skillCatalog = require('../electron/skills');
const termjobs = require('../electron/termjobs');
const tools = require('../electron/tools');
const geminiAdapter = require('../electron/adapters/gemini');
const { make } = require('../electron/adapters/openai-compatible');
const responsesAdapter = require('../electron/adapters/openai-responses');

async function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

async function openServer(onBody) {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      onBody(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"تم"},"finish_reason":"stop"}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// مسبار قطعي لبند ثبات بادئة الكاش: يعزل كل مدخل كي لا نخفي مكوّناً متغيراً داخل الناتج المركّب.
async function probePrefixComponents(project, memoryRoot) {
  const firstPrompt = 'authenticate session';
  const secondPrompt = 'reconcile payment ledger with settlement records and invoices';
  const memoryValues = [
    {
      kind: 'fact', content: 'authenticate sessions use the auth service', confidence: 'high',
      scope: { type: 'project' }, source: { type: 'user', detail: 'context probe' },
    },
    {
      kind: 'fact', content: 'payment ledger records settlement invoices', confidence: 'high',
      scope: { type: 'project' }, source: { type: 'user', detail: 'context probe' },
    },
  ];
  for (const value of memoryValues) assert(memory.save(project, value, { root: memoryRoot }).ok);

  async function snapshot(prompt) {
    const environment = envbrief.build('adapter', 'fixture-model', { compact: true });
    const skills = skillCatalog.catalogPrompt(skillCatalog.resolveSelection(project, ['probe-skill']));
    const recalled = memory.retrieve(project, prompt, { root: memoryRoot }).text;
    const background = 'BACKGROUND_CONTEXT';
    const definitions = tools.defs();
    const built = await contextBudget.buildBlindContext({
      cwd: project,
      prompt,
      systemParts: [environment, skills],
      turnParts: [recalled, background],
      history: [{ role: 'user', content: 'stable history' }],
      toolDefinitions: definitions,
    }, { repomap: { now: () => 100, maxFilesOut: 1 } });
    const combined = [built.systemPrompt, built.turnPrompt || ''].filter(Boolean).join('\n\n');
    const budget = combined.match(/<satr_context_budget[\s\S]*?<\/satr_context_budget>/);
    return {
      envbrief: environment,
      skill_prompt: skills,
      memory_prompt: recalled,
      background_prompt: background,
      repo_map: built.repo.summary,
      budget: budget ? budget[0] : '',
      tool_definitions: JSON.stringify(definitions),
      system_prompt: built.systemPrompt,
    };
  }

  const first = await snapshot(firstPrompt);
  const second = await snapshot(secondPrompt);
  console.log('[probe] prompt_bytes_equal=' + (firstPrompt === secondPrompt));
  for (const name of Object.keys(first)) {
    console.log('[probe] ' + name + '_bytes_equal=' + (first[name] === second[name]));
  }
}

// حارس الطلب الفعلي: ينتظر النهاية دائماً ويعيد result كي نستأنف الجلسة نفسها في الدور التالي.
async function runAdapterTurn(start, input, project) {
  let handle = null;
  let resultEvent = null;
  let timer = null;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('adapter timeout')), 5000);
    handle = start(input, project, (event) => {
      if (event.type === 'result') resultEvent = event;
      if (event.type === 'proc_done') {
        clearTimeout(timer);
        timer = null;
        resolve();
      }
    });
  });
  try {
    await done;
  } finally {
    if (timer) clearTimeout(timer);
    if (handle) await handle.stop();
  }
  assert(resultEvent && resultEvent.is_error === false, 'adapter turn failed');
  return resultEvent;
}

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  }
  if (Array.isArray(message.parts)) {
    return message.parts.map((part) => part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  }
  return '';
}

function lastUserText(items) {
  const users = (Array.isArray(items) ? items : []).filter((item) => item && item.role === 'user');
  return messageText(users[users.length - 1]);
}

function assertTurnContext(text, prompt, label) {
  assert(text.includes(prompt), label + ' lost the user prompt');
  assert(text.includes('<satr_project_memory>'), label + ' lost the retrieved memory');
  assert(text.includes('<satr_background_tasks>'), label + ' lost the background notice');
  assert(text.includes('<satr_repo_map mode="summary" estimate="true"'), label + ' lost the repo map');
  assert(text.includes('<satr_context_budget estimate="true"'), label + ' lost the estimated budget');
  const positions = [
    text.indexOf(prompt),
    text.indexOf('<satr_project_memory>'),
    text.indexOf('<satr_background_tasks>'),
    text.indexOf('<satr_repo_map mode="summary" estimate="true"'),
    text.indexOf('<satr_context_budget estimate="true"'),
  ];
  assert(positions.every((position, index) => index === 0 || position > positions[index - 1]), label + ' misplaced the dynamic turn tail');
}

function assertStablePrefix(first, second, label) {
  assert(Buffer.from(first || '').equals(Buffer.from(second || '')), 'cache prefix changed: ' + label);
  assert(!first.includes('<satr_project_memory>'), label + ' kept memory in the cache prefix');
  assert(!first.includes('<satr_background_tasks>'), label + ' kept a background notice in the cache prefix');
  assert(!first.includes('<satr_repo_map'), label + ' kept the repo map in the cache prefix');
  assert(!first.includes('<satr_context_budget'), label + ' kept the budget in the cache prefix');
}

// محاكاة HTTPS داخل العملية نفسها: تحرس جسمي Gemini وResponses بلا اتصال خارجي.
function installHttpsFixture(captured) {
  const original = https.request;
  https.request = (options, callback) => {
    const request = new EventEmitter();
    let raw = '';
    request.write = (chunk) => { raw += String(chunk || ''); };
    request.destroy = () => {};
    request.end = () => {
      queueMicrotask(() => {
        let body;
        try { body = JSON.parse(raw); } catch (error) { request.emit('error', error); return; }
        captured.push({ host: options.host, body });
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (options.host === 'generativelanguage.googleapis.com') {
          response.end('data: {"candidates":[{"content":{"parts":[{"text":"تم"}]}}]}\n\n');
          return;
        }
        const completed = {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"text":"تم"}' }] }],
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        };
        response.end('data: ' + JSON.stringify(completed) + '\n\n');
      });
    };
    return request;
  };
  return () => { https.request = original; };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-context-test-'));
  const project = path.join(temp, 'project');
  const memoryRoot = path.join(temp, 'memory');
  await fsp.mkdir(project, { recursive: true });
  let server = null;
  let restoreHttps = null;
  const originalMemoryRetrieve = memory.retrieve;
  const originalPendingNoticeText = termjobs.pendingNoticeText;
  const originalChatsSave = chats.save;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  try {
    await write(project, 'src/auth-service.js', [
      'export class AuthService {}',
      'export function authenticate(user) { return Boolean(user); }',
    ].join('\n'));
    await write(project, 'src/other.js', 'export const OTHER = 1;\n');
    await write(project, 'src/payment-ledger.js', [
      'export class PaymentLedger {}',
      'export function reconcileSettlement(invoice) { return Boolean(invoice); }',
    ].join('\n'));
    await write(project, '.agents/skills/probe-skill/SKILL.md', [
      '---',
      'name: probe-skill',
      'description: Stable cache probe skill.',
      '---',
      'Load only when the cache probe requests it.',
    ].join('\n'));
    for (let index = 0; index < 40; index++) {
      await write(project, 'src/many/file-' + index + '.js', 'export const ITEM_' + index + ' = ' + index + ';\n');
    }

    await probePrefixComponents(project, memoryRoot);

    const summary = await repomap.summarize(project, 'authenticate');
    assert(summary.summary.includes('<satr_repo_map mode="summary" estimate="true"'));
    assert(summary.summary.includes('src/auth-service.js'));
    assert(summary.summary.length <= repomap.SUMMARY_MAX_CHARS);
    assert(summary.files.length <= repomap.SUMMARY_MAX_FILES_OUT);

    const built = await contextBudget.buildBlindContext({
      cwd: project,
      prompt: 'عدّل المصادقة',
      systemParts: ['SKILL_CONTEXT'],
      turnParts: ['MEMORY_CONTEXT'],
      history: [{ role: 'user', content: 'رسالة سابقة' }],
      toolDefinitions: [{ name: 'read_file', description: 'read' }],
    });
    assert(built.systemPrompt.includes('SKILL_CONTEXT'));
    assert(!built.systemPrompt.includes('MEMORY_CONTEXT'), 'buildBlindContext kept memory in the cache prefix');
    assert(!built.systemPrompt.includes('<satr_repo_map'), 'buildBlindContext kept the repo map in the cache prefix');
    assert(!built.systemPrompt.includes('<satr_context_budget'), 'buildBlindContext kept the budget in the cache prefix');
    assert(built.turnPrompt.includes('MEMORY_CONTEXT'));
    assert(built.turnPrompt.includes('<satr_repo_map mode="summary" estimate="true"'));
    assert(built.turnPrompt.includes('<satr_context_budget estimate="true"'));
    assert.strictEqual(built.estimate.estimate, true);
    assert(built.estimate.input_tokens > 0);
    assert(built.estimate.repo_map_tokens <= contextBudget.REPO_MAP_ESTIMATED_TOKEN_LIMIT);
    assert(contextBudget.estimateTextTokens('نص عربي') > 0);

    const actual = contextBudget.resolveUsage({ input_tokens: 10, output_tokens: 4 }, { input_tokens: 99, output_tokens: 88 });
    assert.deepStrictEqual(actual, { input_tokens: 10, output_tokens: 4 });
    const estimated = contextBudget.resolveUsage({}, { input_tokens: 99.2, output_tokens: 12.1 });
    assert.deepStrictEqual(estimated, {
      input_tokens: 100, output_tokens: 13, estimate: true, method: 'character_heuristic',
    });

    // ذاكرة وإشعار متغيران عمداً: وصولهما إلى الذيل لا يجوز أن يغير بادئة أي محوّل.
    let noticeSequence = 0;
    memory.retrieve = (_cwd, query) => ({
      items: [], text: '<satr_project_memory>memory for ' + query + '</satr_project_memory>',
    });
    termjobs.pendingNoticeText = () => '<satr_background_tasks>notice ' + (++noticeSequence) + '</satr_background_tasks>';
    chats.save = () => {};

    const requestBodies = [];
    server = await openServer((body) => { requestBodies.push(body); });
    const port = server.address().port;
    const adapter = make({
      id: '', label: 'Fixture', protocol: 'http', host: '127.0.0.1', port,
      path: '/v1/chat/completions', requiresKey: false, defaultModel: 'fixture-model',
    });
    const compatibleFirstPrompt = 'افحص AuthService قبل التعديل';
    const compatibleSecondPrompt = 'افحص PaymentLedger قبل التعديل';
    const compatibleFirst = await runAdapterTurn(adapter.start, {
      prompt: compatibleFirstPrompt, sessionId: null, model: null,
      permissionMode: 'default', skills: ['probe-skill'],
    }, project);
    const compatibleSecond = await runAdapterTurn(adapter.start, {
      prompt: compatibleSecondPrompt, sessionId: compatibleFirst.session_id, model: null,
      permissionMode: 'default', skills: ['probe-skill'],
    }, project);
    assert.strictEqual(requestBodies.length, 2);
    const compatiblePrefixes = requestBodies.map((body) => JSON.stringify({
      model: body.model, system: body.messages[0], tools: body.tools,
    }));
    assertStablePrefix(compatiblePrefixes[0], compatiblePrefixes[1], 'openai-compatible');
    assertTurnContext(lastUserText(requestBodies[0].messages), compatibleFirstPrompt, 'openai-compatible');
    assertTurnContext(lastUserText(requestBodies[1].messages), compatibleSecondPrompt, 'openai-compatible');
    assert(compatibleSecond.usage && compatibleSecond.usage.estimate === true);
    assert(compatibleSecond.context_estimate && compatibleSecond.context_estimate.estimate === true);

    const httpsBodies = [];
    restoreHttps = installHttpsFixture(httpsBodies);
    process.env.GEMINI_API_KEY = 'fixture-key';
    process.env.OPENAI_API_KEY = 'fixture-key';

    const geminiFirstPrompt = 'راجع authenticate في Gemini';
    const geminiSecondPrompt = 'راجع reconcileSettlement في Gemini';
    const geminiFirst = await runAdapterTurn(geminiAdapter.start, {
      prompt: geminiFirstPrompt, sessionId: null, model: 'gemini-2.5-flash', permissionMode: 'default', skills: ['probe-skill'],
    }, project);
    await runAdapterTurn(geminiAdapter.start, {
      prompt: geminiSecondPrompt, sessionId: geminiFirst.session_id, model: 'gemini-2.5-flash', permissionMode: 'default', skills: ['probe-skill'],
    }, project);

    const responsesFirstPrompt = 'راجع authenticate في Responses';
    const responsesSecondPrompt = 'راجع reconcileSettlement في Responses';
    const responsesFirst = await runAdapterTurn(responsesAdapter.start, {
      prompt: responsesFirstPrompt, sessionId: null, model: 'gpt-5.6-terra', permissionMode: 'default', skills: ['probe-skill'],
    }, project);
    await runAdapterTurn(responsesAdapter.start, {
      prompt: responsesSecondPrompt, sessionId: responsesFirst.session_id, model: 'gpt-5.6-terra', permissionMode: 'default', skills: ['probe-skill'],
    }, project);

    const geminiBodies = httpsBodies.filter((entry) => entry.host === 'generativelanguage.googleapis.com').map((entry) => entry.body);
    const responsesBodies = httpsBodies.filter((entry) => entry.host === 'api.openai.com').map((entry) => entry.body);
    assert.strictEqual(geminiBodies.length, 2);
    assert.strictEqual(responsesBodies.length, 2);
    const geminiFirstPrefix = JSON.stringify({
      system: geminiBodies[0].systemInstruction, tools: geminiBodies[0].tools,
    });
    const geminiSecondPrefix = JSON.stringify({
      system: geminiBodies[1].systemInstruction, tools: geminiBodies[1].tools,
    });
    assertStablePrefix(geminiFirstPrefix, geminiSecondPrefix, 'gemini');
    assertTurnContext(lastUserText(geminiBodies[0].contents), geminiFirstPrompt, 'gemini');
    assertTurnContext(lastUserText(geminiBodies[1].contents), geminiSecondPrompt, 'gemini');
    const responsesPrefixes = responsesBodies.map((body) => JSON.stringify({
      model: body.model, instructions: body.instructions, tools: body.tools,
      tool_choice: body.tool_choice, parallel_tool_calls: body.parallel_tool_calls,
    }));
    assertStablePrefix(responsesPrefixes[0], responsesPrefixes[1], 'openai-responses');
    assertTurnContext(lastUserText(responsesBodies[0].input), responsesFirstPrompt, 'openai-responses');
    assertTurnContext(lastUserText(responsesBodies[1].input), responsesSecondPrompt, 'openai-responses');

    console.log('✓ compact repo summary stays within its context cap');
    console.log('✓ blind context keeps the stable prefix separate from its estimated turn tail');
    console.log('✓ actual usage wins and fallback usage is marked estimate');
    console.log('✓ OpenAI-compatible HTTP turns keep a byte-stable prefix and receive the dynamic tail');
    console.log('✓ Gemini and OpenAI Responses keep byte-stable prefixes and receive the dynamic tail');
  } finally {
    if (restoreHttps) restoreHttps();
    memory.retrieve = originalMemoryRetrieve;
    termjobs.pendingNoticeText = originalPendingNoticeText;
    chats.save = originalChatsSave;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (server) await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
