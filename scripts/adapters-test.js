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

async function waitForAdapter(adapter, input, cwd) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const handle = adapter.start(input, cwd, (event) => {
    if (event.type === 'proc_done') finish(event.code);
  });
  const code = await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('adapter timeout')), 5000)),
  ]);
  await handle.stop();
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

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-adapters-test-'));
  const chatBodies = [];
  const responseBodies = [];
  let server;
  let restoreResponses;
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    const ollama = adapters.list().find((provider) => provider.name === 'ollama');
    assert.ok(ollama, 'Ollama is registered in the Community adapter registry');
    assert.strictEqual(ollama.keyName, '');
    assert.strictEqual(typeof adapters.get('ollama').start, 'function');

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
  } finally {
    if (restoreResponses) restoreResponses();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (server) await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
