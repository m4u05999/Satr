#!/usr/bin/env node
'use strict';

/**
 * مسبار المنصات المجانية (جولة «النماذج المجانية» 2026-09-02) — يثبت حيّاً أن كل منصة
 * مسجَّلة في adapters/index.js تفي بعقد المصنع فعلاً:
 *   (1) بثّ SSE بعقد choices[].delta.content ثم [DONE]
 *   (2) استدعاء الأدوات (tool calling) — الشرط الحاكم: بلا أدوات يصير المحرك دردشة لا وكيلاً
 *   (3) رفض 401/403 برسالة قابلة للتشخيص
 *
 * نمط genmedia-probe: مزوّد بلا مفتاح يُتخطى بـ«SKIPPED: no key» بلا فشل، وكل سطر خرج
 * بنية وأطوال لا محتوى، ولا يُطبع أي مفتاح. يُشغَّل يدوياً: node scripts/free-providers-probe.js
 * (خارج test:full عمداً — يستهلك طلبات حقيقية من الطبقة المجانية).
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDERS = [
  {
    id: 'nvidia', keyName: 'NVIDIA_API_KEY',
    host: 'integrate.api.nvidia.com', path: '/v1/chat/completions',
    model: 'meta/llama-3.3-70b-instruct',
  },
  {
    id: 'groq', keyName: 'GROQ_API_KEY',
    host: 'api.groq.com', path: '/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
  },
];

// المفتاح: بيئة النظام أولاً ثم ~/.satr/keys.json — نفس ترتيب المصنع، بلا Electron
function resolveKey(name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.satr', 'keys.json'), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj[name] === 'string' ? obj[name].trim() : '';
  } catch { return ''; }
}

function requestSSE(provider, key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: provider.host, path: provider.path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(payload);
  });
}

// تحليل مجرى SSE إلى deltas — بنية فقط
function parseStream(raw) {
  const out = { events: 0, textChars: 0, toolCalls: [], sawDone: false, finishReasons: new Set() };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { out.sawDone = true; continue; }
    let obj; try { obj = JSON.parse(data); } catch { continue; }
    out.events++;
    const choice = obj.choices && obj.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) out.finishReasons.add(choice.finish_reason);
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') out.textChars += delta.content.length;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        out.toolCalls[idx] = out.toolCalls[idx] || { name: '', args: '' };
        if (tc.function && tc.function.name) out.toolCalls[idx].name += tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') out.toolCalls[idx].args += tc.function.arguments;
      }
    }
  }
  return out;
}

async function probeProvider(provider) {
  const key = resolveKey(provider.keyName);
  if (!key) { console.log(`[${provider.id}] SKIPPED: no key (${provider.keyName})`); return null; }

  const report = { id: provider.id, model: provider.model };

  // (1) دردشة SSE بسيطة
  const chat = await requestSSE(provider, key, {
    model: provider.model, stream: true, max_tokens: 40,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  report.chat = { status: chat.status };
  if (chat.status !== 200) {
    report.chat.bodyLength = chat.raw.length;
    report.chat.bodyHead = chat.raw.slice(0, 200).replace(new RegExp(key, 'g'), '<KEY>');
  } else {
    const s = parseStream(chat.raw);
    report.chat.events = s.events; report.chat.textChars = s.textChars;
    report.chat.sawDone = s.sawDone; report.chat.finishReasons = [...s.finishReasons];
  }

  // (2) جولة أداة: أداة واحدة بسيطة وبرومبت يفرض استعمالها
  const toolReq = await requestSSE(provider, key, {
    model: provider.model, stream: true, max_tokens: 120,
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the project by relative path',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }],
    messages: [{ role: 'user', content: 'Use the read_file tool to read package.json. Do not answer in text.' }],
  });
  report.tools = { status: toolReq.status };
  if (toolReq.status !== 200) {
    report.tools.bodyHead = toolReq.raw.slice(0, 200).replace(new RegExp(key, 'g'), '<KEY>');
  } else {
    const s = parseStream(toolReq.raw);
    report.tools.events = s.events;
    report.tools.finishReasons = [...s.finishReasons];
    report.tools.toolCalls = s.toolCalls.filter(Boolean).map((tc) => ({
      name: tc.name, argsLength: tc.args.length, argsParse: (() => { try { JSON.parse(tc.args); return true; } catch { return false; } })(),
    }));
    report.tools.toolCallingWorks = report.tools.toolCalls.length > 0;
  }

  // (3) مفتاح فاسد ⇒ يجب رفض واضح 401/403 (لا 200 صامت)
  const bad = await requestSSE({ ...provider }, 'invalid-key-probe', {
    model: provider.model, stream: false, max_tokens: 5,
    messages: [{ role: 'user', content: 'hi' }],
  });
  report.badKeyStatus = bad.status;

  return report;
}

async function main() {
  const results = [];
  for (const provider of PROVIDERS) {
    try {
      const r = await probeProvider(provider);
      if (r) results.push(r);
    } catch (error) {
      results.push({ id: provider.id, error: String(error && error.message || error) });
    }
  }
  console.log(JSON.stringify({ ok: true, probedAt: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
  console.error('free-providers-probe فشل: ' + (error && error.stack || error));
  process.exitCode = 1;
});
