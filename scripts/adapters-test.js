#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const { make } = require('../electron/adapters/openai-compatible');
const openaiResponses = require('../electron/adapters/openai-responses');
const adapters = require('../electron/adapters');

const IMAGE = { media_type: 'image/png', data: 'AA==' };

async function runAdapter(adapter, input, cwd) {
  let finish;
  const events = [];
  const done = new Promise((resolve) => { finish = resolve; });
  const handle = adapter.start(input, cwd, (event) => {
    events.push(event);
    if (event.type === 'proc_done') finish(event.code);
  });
  const code = await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('adapter timeout')), 5000)),
  ]);
  await handle.stop();
  return { code, events };
}

async function waitForAdapter(adapter, input, cwd) {
  const { code } = await runAdapter(adapter, input, cwd);
  assert.strictEqual(code, 0);
}

async function openChatServer(bodies) {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"تم"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function openKimiServer(bodies) {
  let turn = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      turn++;
      if (turn === 1) {
        response.end([
          'data: {"choices":[{"delta":{"reasoning_content":"أحتاج فحص الملفات"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"kimi-call-1","function":{"name":"list_files","arguments":"{}"}}]}}]}',
          'data: [DONE]',
          '',
        ].join('\n\n'));
        return;
      }
      response.end('data: {"choices":[{"delta":{"content":"تم"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function openAuthErrorServer(requests) {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push(request.url);
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid API key' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function installResponsesMock(bodies) {
  const originalRequest = https.request;
  https.request = (options, callback) => {
    const request = new EventEmitter();
    let body = '';
    request.write = (chunk) => { body += chunk; };
    request.destroy = () => {};
    request.end = () => {
      bodies.push(JSON.parse(body));
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      queueMicrotask(() => {
        callback(response);
        const completed = {
          type: 'response.completed',
          response: {
            usage: { input_tokens: 3, output_tokens: 2 },
            output: [{
              type: 'message',
              content: [{ type: 'output_text', text: '{"text":"تم"}' }],
            }],
          },
        };
        response.emit('data', 'data: ' + JSON.stringify(completed) + '\n\n');
        response.emit('end');
      });
    };
    return request;
  };
  return () => { https.request = originalRequest; };
}

function installChatMock(requests) {
  const originalRequest = https.request;
  https.request = (options, callback) => {
    const request = new EventEmitter();
    let body = '';
    request.write = (chunk) => { body += chunk; };
    request.destroy = () => {};
    request.end = () => {
      requests.push({ options, body: JSON.parse(body) });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      queueMicrotask(() => {
        callback(response);
        response.emit('data', 'data: {"choices":[{"delta":{"content":"تم"}}]}\n\n');
        response.emit('data', 'data: [DONE]\n\n');
        response.emit('end');
      });
    };
    return request;
  };
  return () => { https.request = originalRequest; };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-adapters-test-'));
  const chatBodies = [];
  const responseBodies = [];
  let server;
  let kimiServer;
  let authErrorServer;
  let restoreResponses;
  let restoreChat;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousKimiKey = process.env.KIMI_API_KEY;
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
  try {
    const ollama = adapters.list().find((provider) => provider.name === 'ollama');
    assert.ok(ollama, 'Ollama is registered in the Community adapter registry');
    assert.strictEqual(ollama.keyName, '');
    assert.strictEqual(typeof adapters.get('ollama').start, 'function');

    const kimi = adapters.list().find((provider) => provider.name === 'kimi');
    assert.ok(kimi, 'Kimi is registered in the Community adapter registry');
    assert.strictEqual(kimi.label, 'Kimi K3 — مفتاح API');
    assert.strictEqual(kimi.keyName, 'KIMI_API_KEY');
    assert.deepStrictEqual(kimi.models.map((model) => model.value), ['k3']);
    assert.strictEqual(kimi.capabilities.vision, true);
    assert.strictEqual(typeof adapters.get('kimi').start, 'function');
    const appSource = await fsp.readFile(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');
    assert.ok(appSource.includes('function engineSupportsVision(engine)'));
    assert.ok(appSource.includes('provider.capabilities.vision === true'));
    assert.ok(appSource.includes('if (!engineSupportsVision(engine) && images.length)'));
    assert.ok(appSource.includes("if (eng === 'sdk' || eng === 'cli' || eng === 'codex' || eng === 'kimi-code')"));
    assert.ok(appSource.includes("p.capabilities && p.capabilities.native"));
    assert.ok(appSource.includes("block.error(ev.text || ('تعذّر الاتصال بـ ' + engineLabel() + '.'))"));

    const kimiRequests = [];
    process.env.KIMI_API_KEY = 'kimi-test-key';
    restoreChat = installChatMock(kimiRequests);
    await waitForAdapter(adapters.get('kimi'), {
      prompt: 'اختبار Kimi', sessionId: null, model: null,
      permissionMode: 'default', skills: [], images: [], effort: 'max',
    }, temp);
    restoreChat();
    restoreChat = null;
    assert.strictEqual(kimiRequests.length, 1);
    assert.strictEqual(kimiRequests[0].options.host, 'api.kimi.com');
    assert.strictEqual(kimiRequests[0].options.path, '/coding/v1/chat/completions');
    assert.strictEqual(kimiRequests[0].options.headers.Authorization, 'Bearer kimi-test-key');
    assert.strictEqual(kimiRequests[0].body.model, 'k3');
    assert.strictEqual(kimiRequests[0].body.reasoning_effort, 'max');
    assert.match(kimiRequests[0].body.prompt_cache_key, /^[0-9a-f-]{36}$/);

    // DeepSeek V4 (رادار ٠٠١): الاسمان القديمان أُوقفا 2026-07-24 وبقيا في السجل ستة أسابيع
    // بلا حارس. قائمة حظر صريحة لأسماء أُعلن إيقافها — حارس قطعي لا يعرف upstream، لكنه
    // يمنع عودة اسم ميت بعد أن عُرف موته؛ والعضّة الحيّة في free-providers-probe.
    const RETIRED_MODEL_NAMES = ['deepseek-chat', 'deepseek-reasoner'];
    const deepseek = adapters.list().find((provider) => provider.name === 'deepseek');
    assert.ok(deepseek, 'DeepSeek is registered in the Community adapter registry');
    assert.strictEqual(deepseek.keyName, 'DEEPSEEK_API_KEY');
    assert.deepStrictEqual(deepseek.models.map((model) => model.value), ['', 'deepseek-v4-flash', 'deepseek-v4-pro']);
    for (const retired of RETIRED_MODEL_NAMES) {
      assert.ok(!deepseek.models.some((model) => model.value === retired), 'retired DeepSeek name in registry: ' + retired);
    }
    const deepseekRequests = [];
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
    restoreChat = installChatMock(deepseekRequests);
    await waitForAdapter(adapters.get('deepseek'), {
      prompt: 'اختبار DeepSeek', sessionId: null, model: null,
      permissionMode: 'default', skills: [], images: [], effort: 'medium',
    }, temp);
    restoreChat();
    restoreChat = null;
    assert.strictEqual(deepseekRequests.length, 1);
    assert.strictEqual(deepseekRequests[0].options.host, 'api.deepseek.com');
    assert.strictEqual(deepseekRequests[0].options.path, '/chat/completions');
    assert.strictEqual(deepseekRequests[0].options.headers.Authorization, 'Bearer deepseek-test-key');
    // الافتراضي هو V4 Flash لا الاسم الميت، والجهد يُطبَّع إلى سلّم V4 (low|high|max)
    assert.strictEqual(deepseekRequests[0].body.model, 'deepseek-v4-flash');
    assert.ok(!RETIRED_MODEL_NAMES.includes(deepseekRequests[0].body.model));
    assert.strictEqual(deepseekRequests[0].body.reasoning_effort, 'high');

    server = await openChatServer(chatBodies);
    const commonConfig = {
      id: '', label: 'Fixture', protocol: 'http', host: '127.0.0.1',
      port: server.address().port, path: '/v1/chat/completions',
      requiresKey: false, defaultModel: 'fixture-model',
    };
    const commonInput = {
      prompt: 'صف الصورة', sessionId: null, model: null,
      permissionMode: 'default', skills: [], images: [IMAGE], effort: 'high',
    };

    await waitForAdapter(make({ ...commonConfig, capabilities: { vision: true } }), commonInput, temp);
    await waitForAdapter(make(commonConfig), commonInput, temp);

    const visionMessage = chatBodies[0].messages.findLast((message) => message.role === 'user');
    assert.deepStrictEqual(visionMessage.content, [
      { type: 'text', text: 'صف الصورة' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ]);
    const textMessage = chatBodies[1].messages.findLast((message) => message.role === 'user');
    assert.strictEqual(textMessage.content, 'صف الصورة');
    assert.strictEqual(Object.hasOwn(chatBodies[0], 'reasoning_effort'), false);

    const kimiBodies = [];
    kimiServer = await openKimiServer(kimiBodies);
    await waitForAdapter(make({
      ...commonConfig,
      port: kimiServer.address().port,
      reasoningKey: 'reasoning_content',
      effortMap: { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
      promptCacheKey: true,
    }), { ...commonInput, effort: 'medium', images: [] }, temp);
    assert.strictEqual(kimiBodies.length, 2);
    assert.strictEqual(kimiBodies[0].reasoning_effort, 'high');
    assert.strictEqual(kimiBodies[1].reasoning_effort, 'high');
    assert.strictEqual(kimiBodies[0].prompt_cache_key, kimiBodies[1].prompt_cache_key);
    const toolMessage = kimiBodies[1].messages.find((message) => Array.isArray(message.tool_calls));
    assert.ok(toolMessage);
    assert.strictEqual(toolMessage.reasoning_content, 'أحتاج فحص الملفات');

    await waitForAdapter(make({
      ...commonConfig,
      port: kimiServer.address().port,
      reasoningKey: 'reasoning_content',
      effortMap: { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
    }), { ...commonInput, effort: 'low', images: [] }, temp);
    await waitForAdapter(make({
      ...commonConfig,
      port: kimiServer.address().port,
      reasoningKey: 'reasoning_content',
      effortMap: { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
    }), { ...commonInput, effort: 'xhigh', images: [] }, temp);
    await waitForAdapter(make({
      ...commonConfig,
      port: kimiServer.address().port,
      reasoningKey: 'reasoning_content',
      effortMap: { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
    }), { ...commonInput, effort: null, images: [] }, temp);
    assert.strictEqual(kimiBodies[2].reasoning_effort, 'low');
    assert.strictEqual(kimiBodies[3].reasoning_effort, 'max');
    assert.strictEqual(Object.hasOwn(kimiBodies[4], 'reasoning_effort'), false);

    const authRequests = [];
    authErrorServer = await openAuthErrorServer(authRequests);
    const authHint = 'مفتاح Kimi Code مرفوض. استخدم مفتاح Kimi Code Console.';
    const authFailure = await runAdapter(make({
      ...commonConfig,
      port: authErrorServer.address().port,
      authHint,
    }), { ...commonInput, images: [] }, temp);
    assert.strictEqual(authFailure.code, 1);
    assert.strictEqual(authRequests.length, 1);
    assert.ok(authFailure.events.some((event) => event.type === 'spawn_error' && event.text.includes(authHint)));

    process.env.OPENAI_API_KEY = 'test-key';
    restoreResponses = installResponsesMock(responseBodies);
    await waitForAdapter(openaiResponses, {
      ...commonInput,
      model: 'gpt-5.4-mini',
      effort: 'max',
    }, temp);

    const responseMessage = responseBodies[0].input.findLast((item) => item.role === 'user');
    assert.deepStrictEqual(responseMessage.content, [
      { type: 'input_text', text: 'صف الصورة' },
      { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
    ]);
    assert.deepStrictEqual(responseBodies[0].reasoning, { effort: 'xhigh' });

    await waitForAdapter(openaiResponses, {
      ...commonInput,
      images: [],
      model: 'gpt-5.6-terra',
      effort: 'high',
    }, temp);
    assert.deepStrictEqual(responseBodies[1].reasoning, { effort: 'high' });

    console.log('✓ Chat content array is gated by capabilities.vision');
    console.log('✓ Chat ignores images without vision and does not invent reasoning_effort');
    console.log('✓ Responses receives input_image and model-compatible reasoning.effort');
    console.log('✓ Supported Responses effort reaches the request unchanged');
    console.log('✓ Ollama is registered as a keyless Community adapter');
    console.log('✓ Kimi K3 is registered with vision, API key metadata, and model id k3');
    console.log('✓ Renderer image gating follows provider capabilities instead of engine names');
    console.log('✓ Kimi uses the Kimi Code endpoint and bearer key directly');
    console.log('✓ Kimi keeps one prompt_cache_key across tool rounds');
    console.log('✓ Kimi reasoning effort is mapped and reasoning_content survives tool rounds');
    console.log('✓ DeepSeek defaults to deepseek-v4-flash, maps effort to V4 levels, and lists no retired model name');
    console.log('✓ Authentication rejection is not retried as a tool compatibility failure');
    console.log('✓ REST provider failures are not mislabeled as Claude executable failures');
  } finally {
    if (restoreChat) restoreChat();
    if (restoreResponses) restoreResponses();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousKimiKey === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = previousKimiKey;
    if (previousDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepseekKey;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (kimiServer) await new Promise((resolve) => kimiServer.close(resolve));
    if (authErrorServer) await new Promise((resolve) => authErrorServer.close(resolve));
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
