#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const contextBudget = require('../electron/context');
const repomap = require('../electron/repomap');
const { make } = require('../electron/adapters/openai-compatible');

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

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-context-test-'));
  const project = path.join(temp, 'project');
  await fsp.mkdir(project, { recursive: true });
  let server = null;
  try {
    await write(project, 'src/auth-service.js', [
      'export class AuthService {}',
      'export function authenticate(user) { return Boolean(user); }',
    ].join('\n'));
    await write(project, 'src/other.js', 'export const OTHER = 1;\n');
    for (let index = 0; index < 40; index++) {
      await write(project, 'src/many/file-' + index + '.js', 'export const ITEM_' + index + ' = ' + index + ';\n');
    }

    const summary = await repomap.summarize(project, 'authenticate');
    assert(summary.summary.includes('<satr_repo_map mode="summary" estimate="true"'));
    assert(summary.summary.includes('src/auth-service.js'));
    assert(summary.summary.length <= repomap.SUMMARY_MAX_CHARS);
    assert(summary.files.length <= repomap.SUMMARY_MAX_FILES_OUT);

    const built = await contextBudget.buildBlindContext({
      cwd: project,
      prompt: 'عدّل المصادقة',
      systemParts: ['SKILL_CONTEXT', 'MEMORY_CONTEXT'],
      history: [{ role: 'user', content: 'رسالة سابقة' }],
      toolDefinitions: [{ name: 'read_file', description: 'read' }],
    });
    assert(built.systemPrompt.includes('SKILL_CONTEXT'));
    assert(built.systemPrompt.includes('MEMORY_CONTEXT'));
    assert(built.systemPrompt.includes('<satr_repo_map mode="summary" estimate="true"'));
    assert(built.systemPrompt.includes('<satr_context_budget estimate="true"'));
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

    let requestBody = null;
    server = await openServer((body) => { requestBody = body; });
    const port = server.address().port;
    const adapter = make({
      id: '', label: 'Fixture', protocol: 'http', host: '127.0.0.1', port,
      path: '/v1/chat/completions', requiresKey: false, defaultModel: 'fixture-model',
    });
    let resultEvent = null;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const handle = adapter.start({
      prompt: 'افحص AuthService قبل التعديل', sessionId: null, model: null,
      permissionMode: 'default', skills: [],
    }, project, (event) => {
      if (event.type === 'result') resultEvent = event;
      if (event.type === 'proc_done') finish();
    });
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('adapter timeout')), 5000))]);
    await handle.stop();
    assert(requestBody && Array.isArray(requestBody.messages));
    const system = requestBody.messages.find((message) => message.role === 'system');
    assert(system && system.content.includes('<satr_repo_map mode="summary" estimate="true"'));
    assert(system.content.includes('<satr_context_budget estimate="true"'));
    assert(resultEvent && resultEvent.usage && resultEvent.usage.estimate === true);
    assert(resultEvent.context_estimate && resultEvent.context_estimate.estimate === true);

    console.log('✓ compact repo summary stays within its context cap');
    console.log('✓ blind context injects an explicitly estimated budget');
    console.log('✓ actual usage wins and fallback usage is marked estimate');
    console.log('✓ OpenAI-compatible turn receives summary and estimate');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
