/**
 * محوّل OpenAI Responses المتخصّص — لا يُعمَّم على المزوّدين المتوافقين اسمياً.
 * المضيف والمسار ثابتان كي لا يخرج OPENAI_API_KEY إلى وجهة يحددها renderer.
 * يستخدم HTTPS وSSE المدمجين، store:false، وأدوات «سطر» المحلية فقط.
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const keys = require('../keys');
const chats = require('../chats');
const tools = require('../tools');
const skillCatalog = require('../skills');
const memory = require('../memory');
const contextBudget = require('../context');
const usage = require('./usage');

const PROVIDER = 'openai';
const API_HOST = 'api.openai.com';
const API_PATH = '/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-terra';
const MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
]);
const MODEL_CAPABILITIES = new Map([
  ['gpt-5.6-sol', { vision: true, effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']) }],
  ['gpt-5.6-terra', { vision: true, effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']) }],
  ['gpt-5.6-luna', { vision: true, effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']) }],
  ['gpt-5.4-mini', { vision: true, effort: new Set(['low', 'medium', 'high', 'xhigh']) }],
  ['gpt-5.4-nano', { vision: true, effort: new Set(['low', 'medium', 'high', 'xhigh']) }],
]);
const MAX_TURNS = 40;
const MAX_SESSIONS = 50;
const MAX_TOOL_ROUNDS = 8;

// غلاف JSON ثابت يحافظ على عقد الدردشة النصي مع ممارسة text.format فعلياً.
const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Final answer to show the user, in the user language' },
  },
  required: ['text'],
  additionalProperties: false,
};
const FINAL_FORMAT = {
  type: 'json_schema',
  name: 'satr_final_response',
  strict: true,
  schema: FINAL_SCHEMA,
};

const histories = new Map();
const alwaysAllowed = new Set();

function safeParse(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function displayInput(args) {
  const out = {};
  for (const key of Object.keys(args || {})) {
    const value = args[key];
    out[key] = typeof value === 'string' && value.length > 800
      ? value.slice(0, 800) + '… (+' + (value.length - 800) + ')' : value;
  }
  return out;
}

function responseToolDefs() {
  return tools.defs({ strictTools: true }).map((definition) => ({
    type: 'function',
    name: definition.function.name,
    description: definition.function.description,
    parameters: definition.function.parameters,
    strict: true,
  }));
}

const RESPONSE_TOOLS = responseToolDefs();

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

// تحقق محلي للـsubset الذي نرسله؛ لا يمنح الثقة ولا يتجاوز تنقية tools.run.
function validateSchema(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => schemaTypeMatches(value, type))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (value === null) return true;
  if (Array.isArray(value)) return !schema.items || value.every((item) => validateSchema(item, schema.items));
  if (schemaTypeMatches(value, 'object')) {
    const properties = schema.properties || {};
    if (Array.isArray(schema.required) && schema.required.some((name) => !Object.prototype.hasOwnProperty.call(value, name))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((name) => !Object.prototype.hasOwnProperty.call(properties, name))) return false;
    return Object.entries(properties).every(([name, child]) =>
      !Object.prototype.hasOwnProperty.call(value, name) || validateSchema(value[name], child));
  }
  return true;
}

function decodeStructuredText(text) {
  try {
    const parsed = JSON.parse(text);
    return validateSchema(parsed, FINAL_SCHEMA) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function extractText(output) {
  let text = '';
  let refusal = '';
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      if (part && part.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
    }
  }
  return { text, refusal };
}

function errorMessage(payload, fallback) {
  const error = payload && payload.error;
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

function isSchemaRejection(result) {
  if (!result || result.status !== 400 || typeof result.error !== 'string') return false;
  return /schema|text\.format|response_format|json/i.test(result.error);
}

function normalizeEffort(value, capabilities) {
  if (!capabilities || !(capabilities.effort instanceof Set)) return null;
  if (capabilities.effort.has(value)) return value;
  if (value === 'max' && capabilities.effort.has('xhigh')) return 'xhigh';
  return null;
}

function start(input, cwd, emit) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const permissionMode = input.permissionMode;
  const skillContext = skillCatalog.resolveSelection(cwd, input.skills);
  const skillPrompt = skillCatalog.catalogPrompt(skillContext);
  const memoryPrompt = memory.retrieve(cwd, prompt).text;
  const apiKey = (process.env.OPENAI_API_KEY || keys.get('OPENAI_API_KEY') || '').trim();
  const model = MODELS.has(input.model) ? input.model : DEFAULT_MODEL;
  const capabilities = MODEL_CAPABILITIES.get(model) || {};
  const effort = normalizeEffort(input.effort, capabilities);
  const autoAllowWrites = permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';

  if (!apiKey) {
    queueMicrotask(() => {
      emit({ type: 'spawn_error', text: 'لم يُضبط مفتاح OpenAI. أضِفه من ⚙ ← «مفاتيح المزوّدين» أو في مخزن مفاتيح سطر.' });
      emit({ type: 'result', session_id: input.sessionId || null, is_error: true, result: 'مفتاح API مفقود' });
      emit({ type: 'proc_done', code: 1 });
    });
    return { stop() { return Promise.resolve(); } };
  }

  let resumed = input.sessionId && histories.get(input.sessionId);
  if (input.sessionId && !resumed) resumed = chats.load(PROVIDER, input.sessionId);
  const sessionId = input.sessionId && resumed ? input.sessionId : crypto.randomUUID();
  const history = Array.isArray(resumed) ? resumed : [];
  const startedAt = Date.now();
  const actualUsage = usage.emptyActual();
  const estimatedUsage = { input_tokens: 0, output_tokens: 0 };
  const pendingPerms = new Map();
  let currentRequest = null;
  let aborted = false;
  let contextEstimate = null;
  const mediaCostState = { total: 0 }; // generate_media فقط: تراكمي تقديري للجلسة

  emit({ type: 'system', subtype: 'init', session_id: sessionId, model });

  async function askPermission(callId, name, args, tier) {
    if (permissionMode === 'bypassPermissions') return Promise.resolve(true);
    if (tier === 'write' && (autoAllowWrites || alwaysAllowed.has(name))) return Promise.resolve(true);
    const id = String(callId);
    let visibleInput = displayInput(args);
    if (name === 'generate_media') {
      const prepared = await tools.generationPermission(cwd, args, { mediaCostState });
      if (!prepared.ok) return true; // التنفيذ يعيد التدهور العربي المنقّى للنموذج
      visibleInput = prepared.input;
    }
    emit({ type: 'permission_request', id, tool: name, input: visibleInput,
      ...(name === 'generate_media' ? { alwaysEligible: false, turnEligible: false } : {}) });
    return new Promise((resolve) => { pendingPerms.set(id, { resolve, name }); });
  }

  function requestOnce(items, instructions, structured) {
    return new Promise((resolve) => {
      let settled = false;
      let sseBuffer = '';
      let textBuffer = '';
      let refusal = '';
      let completedResponse = null;
      let terminalError = '';
      const calls = new Map();
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };

      const bodyObject = {
        model,
        input: items,
        stream: true,
        store: false,
        tools: RESPONSE_TOOLS,
        tool_choice: 'auto',
        parallel_tool_calls: true,
      };
      if (instructions) bodyObject.instructions = instructions;
      if (structured) bodyObject.text = { format: FINAL_FORMAT };
      if (effort) bodyObject.reasoning = { effort };
      estimatedUsage.input_tokens += contextBudget.estimateTokens(bodyObject);
      const body = JSON.stringify(bodyObject);

      function rememberCall(item, outputIndex) {
        if (!item || item.type !== 'function_call') return;
        const key = item.id || String(outputIndex);
        const existing = calls.get(key) || { id: key, call_id: '', name: '', arguments: '' };
        if (typeof item.call_id === 'string') existing.call_id = item.call_id;
        if (typeof item.name === 'string') existing.name = item.name;
        if (typeof item.arguments === 'string') existing.arguments = item.arguments;
        calls.set(key, existing);
      }

      function handleEvent(event) {
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
        switch (event.type) {
          case 'response.output_text.delta':
            if (typeof event.delta === 'string') {
              textBuffer += event.delta;
              if (!structured) emit({ type: 'stream_text', text: event.delta });
            }
            break;
          case 'response.output_text.done':
            if (typeof event.text === 'string') textBuffer = event.text;
            break;
          case 'response.refusal.delta':
            if (typeof event.delta === 'string') refusal += event.delta;
            break;
          case 'response.output_item.added':
          case 'response.output_item.done':
            rememberCall(event.item, event.output_index);
            break;
          case 'response.function_call_arguments.delta': {
            const key = event.item_id || String(event.output_index);
            const call = calls.get(key) || { id: key, call_id: '', name: '', arguments: '' };
            if (typeof event.delta === 'string') call.arguments += event.delta;
            calls.set(key, call);
            break;
          }
          case 'response.function_call_arguments.done':
            rememberCall(event.item || event, event.output_index);
            break;
          case 'response.completed':
            completedResponse = event.response || null;
            break;
          case 'response.failed':
          case 'response.incomplete':
            terminalError = errorMessage(event.response, 'لم تكتمل استجابة OpenAI');
            break;
          case 'error':
            terminalError = errorMessage(event, 'خطأ غير معروف من OpenAI');
            break;
          default:
            // أحداث lifecycle/content الأخرى لا تغيّر عقد العرض المطلوب.
            break;
        }
      }

      const request = https.request({
        host: API_HOST,
        path: API_PATH,
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        response.setEncoding('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let errorBody = '';
          response.on('data', (chunk) => { errorBody += chunk; });
          response.on('end', () => {
            let message = 'رمز HTTP ' + response.statusCode;
            try { message = errorMessage(JSON.parse(errorBody), message); } catch {}
            done({ error: message, status: response.statusCode });
          });
          return;
        }
        response.on('data', (chunk) => {
          sseBuffer += chunk;
          let index;
          while ((index = sseBuffer.indexOf('\n')) >= 0) {
            const line = sseBuffer.slice(0, index).trim();
            sseBuffer = sseBuffer.slice(index + 1);
            if (!line.startsWith('data:')) continue;
            try { handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
          }
        });
        response.on('end', () => {
          const tail = sseBuffer.trim();
          if (tail.startsWith('data:')) {
            try { handleEvent(JSON.parse(tail.slice(5).trim())); } catch {}
          }
          if (terminalError) return done({ error: terminalError });
          if (!completedResponse) return done({ error: 'انتهى بث OpenAI دون حدث response.completed' });
          usage.add(actualUsage, usage.parseResponses(completedResponse.usage));
          const extracted = extractText(completedResponse.output);
          if (!textBuffer) textBuffer = extracted.text;
          if (!refusal) refusal = extracted.refusal;
          for (const item of Array.isArray(completedResponse.output) ? completedResponse.output : []) {
            rememberCall(item);
          }
          done({
            text: textBuffer,
            refusal,
            output: Array.isArray(completedResponse.output) ? completedResponse.output : [],
            calls: [...calls.values()].filter((call) => call.call_id && call.name),
          });
        });
      });

      request.on('error', (error) => {
        if (aborted) return done({ error: '__aborted__' });
        done({ error: 'تعذّر الاتصال بـ OpenAI: ' + String(error && error.message) });
      });
      currentRequest = request;
      request.write(body);
      request.end();
    });
  }

  function fail(message) {
    emit({ type: 'spawn_error', text: 'فشل طلب OpenAI: ' + message });
    emit({ type: 'result', session_id: sessionId, is_error: true, duration_ms: Date.now() - startedAt, result: message });
    emit({ type: 'proc_done', code: 1 });
  }

  (async () => {
    const builtContext = await contextBudget.buildBlindContext({
      cwd,
      prompt,
      systemParts: [skillPrompt, memoryPrompt],
      history,
      toolDefinitions: RESPONSE_TOOLS,
    });
    if (aborted) return;
    contextEstimate = builtContext.estimate;
    // الصور لا تأتي إلا من sanitizeImages في main.js؛ نبني data URL محلياً من العقد المنقّى.
    const userContent = capabilities.vision && Array.isArray(input.images) && input.images.length
      ? [{ type: 'input_text', text: prompt }].concat(input.images.map((image) => ({
        type: 'input_image',
        image_url: 'data:' + image.media_type + ';base64,' + image.data,
      })))
      : prompt;
    const userItem = { role: 'user', content: userContent };
    const items = history.concat([userItem]);
    let rounds = 0;
    let structuredEnabled = true;

    while (true) {
      let result = await requestOnce(items, builtContext.systemPrompt, structuredEnabled);
      if (aborted || result.error === '__aborted__') return;
      if (isSchemaRejection(result) && structuredEnabled) {
        structuredEnabled = false;
        result = await requestOnce(items, builtContext.systemPrompt, false);
        if (aborted || result.error === '__aborted__') return;
      }
      if (result.error) return fail(result.error);

      estimatedUsage.output_tokens += contextBudget.estimateTokens({ text: result.text, calls: result.calls });
      if (result.calls.length && rounds >= MAX_TOOL_ROUNDS) {
        return fail('تجاوز النموذج سقف جولات الأدوات المسموح');
      }
      if (result.calls.length) {
        rounds++;
        emit({
          type: 'assistant',
          message: { content: result.calls.map((call) => ({
            type: 'tool_use', id: call.call_id, name: call.name, input: safeParse(call.arguments),
          })) },
        });
        // reasoning وfunction_call items يجب أن تعود مع النتائج في الوضع stateless.
        items.push(...result.output);
        for (const call of result.calls) {
          if (aborted) return;
          const args = safeParse(call.arguments);
          const tier = tools.permissionTier(call.name);
          let toolResult;
          if (tier) {
            const allowed = await askPermission(call.call_id, call.name, args, tier);
            if (aborted) return;
            toolResult = allowed
              ? await tools.run(call.name, cwd, args, { emit, id: call.call_id, skillContext, engine: PROVIDER, mediaCostState })
              : { ok: false, content: 'رفض المستخدم هذا الإجراء — لا تعاود المحاولة نفسها؛ اشرح ما كنت ستفعله أو اقترح بديلاً' };
          } else {
            toolResult = await tools.run(call.name, cwd, args, { emit, id: call.call_id, skillContext, engine: PROVIDER, mediaCostState });
          }
          emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call.call_id, is_error: !toolResult.ok }] } });
          items.push({ type: 'function_call_output', call_id: call.call_id, output: toolResult.content });
        }
        continue;
      }

      let finalText = result.refusal || result.text;
      let structuredOutput;
      if (!result.refusal && structuredEnabled) {
        const decoded = decodeStructuredText(result.text);
        if (decoded.ok) {
          structuredOutput = decoded.value;
          finalText = decoded.value.text;
        }
        // فشل التحقق يبقي النص الخام كنص عادي؛ schema ليست حاجز أمان ولا مبرراً للتنفيذ.
      }
      if (!finalText) return fail('اكتملت استجابة OpenAI دون نص أو نداء أداة');
      if (structuredEnabled && finalText) emit({ type: 'stream_text', text: finalText });
      if (finalText) emit({ type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } });

      const saved = history.concat([userItem], finalText ? [{ role: 'assistant', content: finalText }] : []);
      while (saved.length > MAX_TURNS) saved.shift();
      if (!histories.has(sessionId) && histories.size >= MAX_SESSIONS) histories.delete(histories.keys().next().value);
      histories.set(sessionId, saved);
      chats.save(PROVIDER, sessionId, saved);
      emit({
        type: 'result',
        session_id: sessionId,
        is_error: false,
        duration_ms: Date.now() - startedAt,
        num_turns: rounds + 1,
        usage: usage.normalize(actualUsage, estimatedUsage),
        context_estimate: contextEstimate,
        provider: PROVIDER,
        structured_output: structuredOutput,
      });
      emit({ type: 'proc_done', code: 0 });
      return;
    }
  })().catch((error) => fail(String((error && error.message) || error)));

  return {
    stop() {
      aborted = true;
      for (const [, pending] of pendingPerms) { try { pending.resolve(false); } catch {} }
      pendingPerms.clear();
      try { if (currentRequest) currentRequest.destroy(); } catch {}
      return Promise.resolve();
    },
    resolvePermission(id, allow, always) {
      const pending = pendingPerms.get(id);
      if (!pending) return false;
      pendingPerms.delete(id);
      if (allow && always && tools.permissionTier(pending.name) !== 'exec') alwaysAllowed.add(pending.name);
      pending.resolve(!!allow);
      return true;
    },
  };
}

module.exports = { start };
