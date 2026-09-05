#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const openaiCompatible = require('../electron/adapters/openai-compatible');
const { make } = openaiCompatible;
const gemini = require('../electron/adapters/gemini');
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


// ---- خادم حدود المعدّل (‏OBS-086) ----
// `plan` خطوة لكل طلب؛ آخر خطوة تتكرر لما بعدها. تُسجَّل أزمنة الطلبات لقياس التراجع فعلياً.
async function openRateLimitServer(state) {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      state.requests.push(Date.now());
      const step = state.plan[Math.min(state.requests.length - 1, state.plan.length - 1)];
      if (step.ok) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"تم"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      response.writeHead(429, Object.assign({ 'Content-Type': 'application/json' }, step.headers || {}));
      response.end(JSON.stringify({ error: { message: step.body || 'Too Many Requests' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function rateLimitConfig(port) {
  return {
    id: '', label: 'Fixture', protocol: 'http', host: '127.0.0.1', port,
    path: '/v1/chat/completions', requiresKey: false, defaultModel: 'fixture-model',
  };
}

const RATE_INPUT = {
  prompt: 'اختبار حدّ المعدّل', sessionId: null, model: null,
  permissionMode: 'default', skills: [], images: [], effort: null,
};

function commentaryText(events) {
  return events.filter((event) => event.type === 'stream_text' && event.phase === 'commentary')
    .map((event) => event.text).join('');
}

function allEmittedText(events) {
  return events.map((event) => JSON.stringify(event)).join(' ');
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-adapters-test-'));
  const chatBodies = [];
  const responseBodies = [];
  let server;
  let kimiServer;
  let authErrorServer;
  let rateServer;
  let restoreResponses;
  let restoreChat;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousKimiKey = process.env.KIMI_API_KEY;
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
  try {
    // ---- مسح نتائج الأدوات القديمة (رادار ٠٠٣، محور E) ----
    // fixture يشبه خرج npm test: أسطر كثيرة، مع علامة في الرأس وأخرى في الذيل كي
    // نثبت أن المنفَّذ ذيلٌ حقيقي لا مقتطف من الجهة الخطأ.
    const oldToolResult = 'OLD_TOOL_HEAD_MUST_DISAPPEAR\n'
      + Array.from({ length: 700 }, (_, index) => (
        'PASS scripts/fixture-' + String(index).padStart(3, '0')
        + '-test.js — assertions completed without network access\n'
      )).join('')
      + 'OLD_TOOL_TAIL_MUST_SURVIVE';
    const latestToolResult = 'LATEST_TOOL_RESULT_MUST_STAY_FULL\n'
      + Array.from({ length: 120 }, (_, index) => 'latest output line ' + index + '\n').join('');
    const systemPrompt = '<satr_system>بادئة ثابتة\r\ncache-prefix-🔒</satr_system>';
    const history = [
      { role: 'user', content: 'شغّل الاختبارات السابقة' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call-old', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm test"}' },
      }] },
      { role: 'tool', tool_call_id: 'call-old', content: oldToolResult },
      { role: 'assistant', content: 'سأفحص الملف الأخير.' },
      { role: 'user', content: 'افحصه' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call-latest', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' },
      }] },
      { role: 'tool', tool_call_id: 'call-latest', content: latestToolResult },
      { role: 'user', content: 'تابع من النتيجة الأخيرة' },
    ];
    const untouchedHistory = JSON.stringify(history);
    const cleared = openaiCompatible.clearOldToolResults(history);
    const beforeClearBytes = Buffer.byteLength(untouchedHistory, 'utf8');
    const afterClearBytes = Buffer.byteLength(JSON.stringify(cleared), 'utf8');
    const clearedOld = cleared.find((message) => message.tool_call_id === 'call-old');
    const protectedLatest = cleared.find((message) => message.tool_call_id === 'call-latest');
    assert.ok(openaiCompatible.PROTECTED_TOOL_ROUNDS >= 1, 'نافذة حماية الأدوات أقل من جولة واحدة');
    assert.ok(clearedOld.content.includes('مُسحت')
      && clearedOld.content.includes('read_file') && clearedOld.content.includes('run_command'),
      'نتيجة الأداة القديمة لم تحمل إشارة المسح وطريقة الاستعادة');
    assert.ok(!clearedOld.content.includes('OLD_TOOL_HEAD_MUST_DISAPPEAR'), 'رأس النتيجة القديمة لم يُمسح');
    assert.ok(clearedOld.content.endsWith(oldToolResult.slice(-openaiCompatible.CLEARED_TOOL_RESULT_TAIL_CHARS)),
      'ذيل النتيجة القديمة ليس آخر السجل حرفياً');
    assert.strictEqual(protectedLatest.content, latestToolResult, 'أحدث جولة أدوات مُسحت رغم نافذة الحماية');
    assert.strictEqual(JSON.stringify(history), untouchedHistory, 'المسح غيّر سجل الحقيقة بدلاً من نسخة الطلب');
    assert.strictEqual(openaiCompatible.capHistory(history).find((message) => message.tool_call_id === 'call-old').content,
      oldToolResult, 'نسخة الحفظ فقدت نتيجة الأداة الكاملة');
    assert.ok(afterClearBytes < beforeClearBytes,
      'المسح لم يقلّص fixture: ' + beforeClearBytes + ' → ' + afterClearBytes);

    const prepared = openaiCompatible.prepareRequestMessages(history, systemPrompt);
    assert.deepStrictEqual(Buffer.from(prepared[0].content, 'utf8'), Buffer.from(systemPrompt, 'utf8'),
      'بادئة OBS-103 تغيّرت بايتياً عند مسح سجل الرسائل');
    const knownCalls = new Set();
    for (const message of prepared) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) knownCalls.add(call.id);
      }
      if (message.role === 'tool') {
        assert.ok(knownCalls.has(message.tool_call_id), 'رسالة tool يتيمة بعد المسح/السقف: ' + message.tool_call_id);
      }
    }

    // السقف يبدأ هنا عند tool عمداً؛ يجب إسقاطها بعدما سقط نداءها، بلا تغيير المحتوى المحفوظ.
    const orphanAtCap = [{ role: 'assistant', content: null, tool_calls: [{
      id: 'cap-call', type: 'function', function: { name: 'read_file', arguments: '{}' },
    }] }, { role: 'tool', tool_call_id: 'cap-call', content: oldToolResult }]
      .concat(Array.from({ length: openaiCompatible.MAX_TURNS - 1 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user', content: 'رسالة ' + index,
      })));
    const cappedHistory = openaiCompatible.prepareRequestMessages(orphanAtCap, '');
    assert.ok(cappedHistory.length && cappedHistory[0].role !== 'tool', 'سقف الرسائل ترك tool يتيمة في المقدمة');

    // العقد نفسه بصيغة Gemini (functionResponse): آخر جولة كاملة، والأقدم نسخة ممسوحة.
    const geminiHistory = [
      { role: 'model', parts: [{ functionCall: { name: 'run_command', args: { command: 'npm test' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'run_command', response: { result: oldToolResult } } }] },
      { role: 'model', parts: [{ text: 'أفحص الملف الأخير.' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/app.js' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { result: latestToolResult } } }] },
    ];
    const geminiUntouched = JSON.stringify(geminiHistory);
    const geminiCleared = gemini.clearOldToolResults(geminiHistory);
    assert.ok(geminiCleared[1].parts[0].functionResponse.response.result.includes('مُسحت'),
      'نتيجة Gemini القديمة لم تُمسح');
    assert.strictEqual(geminiCleared[4].parts[0].functionResponse.response.result, latestToolResult,
      'أحدث نتيجة Gemini لم تبقَ كاملة');
    assert.strictEqual(JSON.stringify(geminiHistory), geminiUntouched, 'مسح Gemini غيّر سجل الحقيقة');

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

    // ---- حدود المعدّل 429 (‏OBS-086) ----
    // أولاً الدوال النقية (حالات حدّية بلا نوم حقيقي)، ثم السلوك الحيّ عبر خادم HTTP.
    const { parseRetryAfterMs, classifyRateLimit, rateLimitMessage, planRateLimitWait } = openaiCompatible;

    assert.strictEqual(parseRetryAfterMs('12'), 12000);
    assert.strictEqual(parseRetryAfterMs(' 0.5 '), 500);
    assert.strictEqual(parseRetryAfterMs(['3']), 3000);
    // صيغة HTTP-date مشروعة في المعيار وغير مدعومة عمداً ⇒ السقوط للتراجع الأسّي
    assert.strictEqual(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'), null);
    assert.strictEqual(parseRetryAfterMs('-5'), null);
    assert.strictEqual(parseRetryAfterMs('86401'), null);    // أكبر من يوم ⇒ ترويسة مشوّهة
    assert.strictEqual(parseRetryAfterMs('99999999'), null); // أكثر من سبع خانات
    assert.strictEqual(parseRetryAfterMs('12; sleep'), null);
    assert.strictEqual(parseRetryAfterMs(null), null);
    assert.strictEqual(parseRetryAfterMs(7), null);

    const tpmInfo = classifyRateLimit({
      'retry-after': '7',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '0',
    }, 'Rate limit reached for model x on tokens per minute (TPM): Limit 8000, Used 8000');
    assert.deepStrictEqual(tpmInfo, { kind: 'tokens', window: 'minute', limit: 8000, retryAfterMs: 7000 });
    const rpdInfo = classifyRateLimit({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '30' }, '');
    assert.deepStrictEqual(rpdInfo, { kind: 'requests', window: '', limit: 30, retryAfterMs: null });
    // ترويسة حدّ مشوّهة تُهمَل بلا تأويل، والنوع يبقى مشتقاً من الترويسة السليمة
    const dirtyInfo = classifyRateLimit({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-limit-tokens': '8000; drop' }, '');
    assert.strictEqual(dirtyInfo.kind, 'tokens');
    assert.strictEqual(dirtyInfo.limit, null);
    // حدود الكلمة إلزامية: مطابقة TPM/RPM داخل كلمة أطول تصنيف كاذب (عطل هروب مرصود)
    assert.strictEqual(classifyRateLimit({}, 'ATPMB ARPMB failure').kind, '');
    assert.strictEqual(classifyRateLimit({}, 'Too Many Requests').kind, '');

    assert.strictEqual(planRateLimitWait({ attempts: 0, spentMs: 0 }, null), 1000);
    assert.strictEqual(planRateLimitWait({ attempts: 1, spentMs: 1000 }, null), 2000);
    assert.strictEqual(planRateLimitWait({ attempts: 2, spentMs: 3000 }, null), 4000);
    assert.strictEqual(planRateLimitWait({ attempts: 3, spentMs: 7000 }, null), null);
    assert.strictEqual(planRateLimitWait({ attempts: 0, spentMs: 0 }, 20000), 20000);
    assert.strictEqual(planRateLimitWait({ attempts: 0, spentMs: 0 }, 20001), null);
    assert.strictEqual(planRateLimitWait({ attempts: 1, spentMs: 20000 }, 15000), null);

    const tokenMessage = rateLimitMessage('Groq', { kind: 'tokens', window: 'minute', limit: 8000, retryAfterMs: 12000 });
    assert.strictEqual(tokenMessage, 'بلغتَ حدّ الرموز في الدقيقة لدى Groq (الحدّ المعلن: 8000). أعِد المحاولة بعد 12 ثانية.'
      + ' لتخفيف الاستهلاك: قلّل مخرجات الطرفية والملفات المرفقة، أو ابدأ جلسة جديدة، أو بدّل المحرّك من قائمة «المحرك».');
    // ‏/ضغط محصور بـsdk/codex/kimi-code في app.js فاقتراحه على محوّل REST نصيحة كاذبة
    assert.ok(!tokenMessage.includes('/ضغط') && !tokenMessage.includes('ضغط المحادثة'));
    assert.strictEqual(rateLimitMessage('Fixture', { kind: '', window: '', limit: null, retryAfterMs: null }),
      'بلغتَ حدّ الاستخدام لدى Fixture. انتظر قليلاً ثم أعِد المحاولة. أبطئ وتيرة الطلبات، أو بدّل المحرّك من قائمة «المحرك».');

    // (1) 429 ثم نجاح: تراجع فعلي بمهلة Retry-After، ورسالة عربية تسمّي الحدّ
    const LEAK_MARKER = 'RAW-PROVIDER-BODY-MARKER';
    const LEAK_SECRET = 'sk-livetestsecret0123456789';
    const rateState = {
      requests: [],
      plan: [{
        headers: { 'retry-after': '0.2', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '0' },
        body: LEAK_MARKER + ' on tokens per minute (TPM): Limit 8000 ' + LEAK_SECRET,
      }, { ok: true }],
    };
    rateServer = await openRateLimitServer(rateState);
    const ratePort = rateServer.address().port;
    const retried = await runAdapter(make(rateLimitConfig(ratePort)), RATE_INPUT, temp);
    assert.strictEqual(retried.code, 0, 'التراجع لم ينتهِ إلى نجاح');
    assert.strictEqual(rateState.requests.length, 2, 'عدد الطلبات بعد التراجع: ' + rateState.requests.length);
    const gap = rateState.requests[1] - rateState.requests[0];
    assert.ok(gap >= 180, 'لم يُنتظر Retry-After فعلياً — الفاصل ' + gap + 'ms');
    const retriedNotice = commentaryText(retried.events);
    assert.ok(retriedNotice.includes('بلغتَ حدّ الرموز في الدقيقة لدى Fixture (الحدّ المعلن: 8000).'),
      'إشعار التراجع لا يسمّي الحدّ: ' + retriedNotice);
    assert.ok(retriedNotice.includes('(1/3)'), 'إشعار التراجع بلا عدّاد محاولات');
    const retriedText = allEmittedText(retried.events);
    assert.ok(!retriedText.includes(LEAK_MARKER) && !retriedText.includes(LEAK_SECRET),
      'جسم استجابة المزوّد الخام تسرّب إلى الأحداث');

    // (2) 429 دائم: ثلاث محاولات ثم فشل صريح برسالة تسمّي الحدّ، بلا حلقة مفتوحة
    rateState.requests.length = 0;
    rateState.plan = [{
      headers: { 'retry-after': '0.05', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '0' },
      body: LEAK_MARKER + ' on tokens per minute (TPM) ' + LEAK_SECRET,
    }];
    const exhausted = await runAdapter(make(rateLimitConfig(ratePort)), RATE_INPUT, temp);
    assert.strictEqual(exhausted.code, 1);
    assert.strictEqual(rateState.requests.length, 4, 'عدد الطلبات عند النفاد: ' + rateState.requests.length);
    const failure = exhausted.events.find((event) => event.type === 'spawn_error');
    assert.ok(failure && failure.text.includes('بلغتَ حدّ الرموز في الدقيقة لدى Fixture (الحدّ المعلن: 8000).'),
      'رسالة الفشل لا تسمّي الحدّ: ' + (failure && failure.text));
    assert.ok(failure.text.includes('قلّل مخرجات الطرفية والملفات المرفقة'));
    const exhaustedText = allEmittedText(exhausted.events);
    assert.ok(!exhaustedText.includes(LEAK_MARKER) && !exhaustedText.includes(LEAK_SECRET),
      'جسم استجابة المزوّد الخام تسرّب عند النفاد');

    // (3) Retry-After أطول من سقفنا: لا نوم إطلاقاً — فشل فوري يُبلّغ المهلة المعلنة
    rateState.requests.length = 0;
    rateState.plan = [{
      headers: { 'retry-after': '3600', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '0' },
      body: 'Rate limit reached on requests per day (RPD): Limit 1000',
    }];
    const cappedStart = Date.now();
    const capped = await runAdapter(make(rateLimitConfig(ratePort)), RATE_INPUT, temp);
    const cappedElapsed = Date.now() - cappedStart;
    assert.strictEqual(capped.code, 1);
    assert.strictEqual(rateState.requests.length, 1, 'أُعيدت المحاولة رغم تجاوز الترويسة للسقف');
    assert.ok(cappedElapsed < 3000, 'نام المحوّل على ترويسة غير موثوقة: ' + cappedElapsed + 'ms');
    const cappedFailure = capped.events.find((event) => event.type === 'spawn_error');
    assert.ok(cappedFailure.text.includes('بلغتَ حدّ الطلبات في اليوم لدى Fixture (الحدّ المعلن: 1000).'),
      'رسالة الحدّ اليومي غير صحيحة: ' + cappedFailure.text);
    assert.ok(cappedFailure.text.includes('أعِد المحاولة بعد 3600 ثانية.'));
    assert.strictEqual(commentaryText(capped.events), '', 'أُعلن انتظار لم يقع');

    // (4) بلا Retry-After ولا ترويسات: تراجع أسّي افتراضي (1000ms) ثم نجاح
    rateState.requests.length = 0;
    rateState.plan = [{ body: 'Too Many Requests' }, { ok: true }];
    const backedOff = await runAdapter(make(rateLimitConfig(ratePort)), RATE_INPUT, temp);
    assert.strictEqual(backedOff.code, 0);
    assert.strictEqual(rateState.requests.length, 2);
    const defaultGap = rateState.requests[1] - rateState.requests[0];
    assert.ok(defaultGap >= 900, 'التراجع الافتراضي أقصر من المعلن: ' + defaultGap + 'ms');
    assert.ok(commentaryText(backedOff.events).includes('بلغتَ حدّ الاستخدام لدى Fixture.'));

    // (5) الإيقاف يقطع التراجع فوراً ولا يترك مؤقّتاً يتيماً.
    // مسبار المؤقّتات الطويلة (≥300ms) يعضّ: بلا clearTimeout في stop() تبقى المجموعة غير فارغة.
    rateState.requests.length = 0;
    rateState.plan = [{ headers: { 'retry-after': '2' }, body: 'Too Many Requests' }];
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const longTimers = new Set();
    global.setTimeout = (fn, ms, ...rest) => {
      const timer = originalSetTimeout(fn, ms, ...rest);
      if (typeof ms === 'number' && ms >= 300) longTimers.add(timer);
      return timer;
    };
    global.clearTimeout = (timer) => { longTimers.delete(timer); return originalClearTimeout(timer); };
    try {
      const stopEvents = [];
      const stopHandle = make(rateLimitConfig(ratePort)).start(RATE_INPUT, temp, (event) => { stopEvents.push(event); });
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !stopEvents.some((event) => event.phase === 'commentary')) {
        await new Promise((resolve) => originalSetTimeout(resolve, 10));
      }
      assert.ok(stopEvents.some((event) => event.phase === 'commentary'), 'لم يبدأ تراجع 429 قبل الإيقاف');
      assert.strictEqual(longTimers.size, 1, 'مؤقّت النوم غير مرصود: ' + longTimers.size);
      const stopStart = Date.now();
      await stopHandle.stop();
      const stopElapsed = Date.now() - stopStart;
      assert.ok(stopElapsed < 500, 'stop() انتظر انتهاء النوم: ' + stopElapsed + 'ms');
      assert.strictEqual(longTimers.size, 0, 'بقي مؤقّت تراجع يتيم بعد الإيقاف');
      await new Promise((resolve) => originalSetTimeout(resolve, 250));
      assert.strictEqual(rateState.requests.length, 1, 'أُعيدت المحاولة بعد الإيقاف');
      assert.ok(!stopEvents.some((event) => event.type === 'proc_done' || event.type === 'result'),
        'أُنهي دور مُوقَف بنتيجة');
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }

    // (6) عدم تراجع: رمز غير 429 يبقى على مساره القديم حرفياً (بلا انتظار ولا إعادة)
    rateState.requests.length = 0;
    rateState.plan = [{ ok: true }];
    const healthyStart = Date.now();
    const healthy = await runAdapter(make(rateLimitConfig(ratePort)), RATE_INPUT, temp);
    assert.strictEqual(healthy.code, 0);
    assert.strictEqual(rateState.requests.length, 1);
    assert.ok(Date.now() - healthyStart < 3000);
    assert.strictEqual(commentaryText(healthy.events), '', 'المسار السليم بثّ إشعار تراجع');

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
    console.log('✓ Retry-After parsing accepts seconds only and rejects HTTP-date, negatives, and oversized values');
    console.log('✓ Rate-limit classification is a closed set derived from headers and word-bounded body signals');
    console.log('✓ 429 backs off for the announced Retry-After and then succeeds');
    console.log('✓ 429 retries are capped at three attempts and fail with an Arabic message naming the limit');
    console.log('✓ A Retry-After beyond the cap fails immediately instead of sleeping on untrusted input');
    console.log('✓ Missing Retry-After falls back to the declared exponential backoff');
    console.log('✓ stop() cancels the backoff sleep at once and leaves no orphan timer');
    console.log('✓ Non-429 responses and the healthy path are untouched by the rate-limit branch');
    console.log('✓ Raw provider bodies never reach any emitted event on the 429 path');
    console.log('✓ Old tool results are cleared in request copies while the newest round, disk truth, and system prefix stay intact');
    console.log('tool-result clearing fixture: ' + beforeClearBytes + ' bytes → ' + afterClearBytes + ' bytes');
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
    if (rateServer) await new Promise((resolve) => rateServer.close(resolve));
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
