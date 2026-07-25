'use strict';

/**
 * مسبار حي: هل Kimi ACP المثبَّت فعلياً يبثّ agent_thought_chunk؟
 *
 * يشغّل `kimi acp` في مجلد مؤقت، يطلب مهمة قصيرة تتطلب تفكيراً مرئياً، ويُحصي
 * كتل التفكير الواردة. أي فشل لا يُوقف الاختبارات — بل يطبع تقريراً واضحاً.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const kimi = require('../electron/kimi');

const MAX_WAIT_MS = 120000;
const PROMPT = 'فكّر بصوت عالٍ: ما مجموع 23 و 45؟ اشرح خطواتك ثم أعطِ النتيجة النهائية.';

function findKimiBin() {
  const found = kimi.resolveKimiBin(true);
  if (found) return found;
  try {
    return require('child_process').execSync(IS_WIN ? 'where kimi' : 'which kimi', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  } catch { return null; }
}

function isWin() { return process.platform === 'win32'; }

function spawnKimi(bin, args, cwd) {
  if (isWin() && /\.(?:cmd|bat)$/i.test(bin)) {
    const command = '"' + String(bin).replace(/"/g, '""') + '" '
      + args.map((arg) => '"' + String(arg).replace(/"/g, '""') + '"').join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  }
  return spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
}

async function probe() {
  const bin = findKimiBin();
  if (!bin) {
    console.log('⚠️  لم يُعثر على ثنائي Kimi Code — تخطّي المسبار الحي.');
    return { skipped: true };
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-kimi-thought-'));
  let proc;
  let rpc;
  let sessionId;
  const events = [];
  let finished = false;
  let startedAt = Date.now();

  const cleanup = (code) => {
    if (finished) return;
    finished = true;
    try { proc.stdin.end(); } catch { /* */ }
    setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 500);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
  };

  proc = spawnKimi(bin, ['acp'], sandbox);

  rpc = createRpc(proc, {
    onRequest(message, channel) {
      if (message.method === 'session/request_permission') {
        const tool = message.params && message.params.toolCall;
        const kind = tool && tool.kind;
        // قراءة فقط مسموحة؛ التعديل/التنفيذ مرفوض ليبقى المسبار آمناً وقصيراً
        const allow = kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch';
        channel.respond(message.id, {
          outcome: { outcome: allow ? 'selected' : 'cancelled', optionId: allow ? 'allow_once' : undefined },
        });
        return;
      }
      channel.respondError(message.id, -32601, 'غير متاح في المسبار');
    },
    onNotification(method, params) {
      if (method !== 'session/update') return;
      const update = params && params.update || {};
      events.push({ type: update.sessionUpdate, hasText: !!(update.content && update.content.text) });
    },
  });

  proc.on('exit', () => cleanup(0));
  proc.on('error', (error) => {
    console.log('⚠️  خطأ في تشغيل Kimi ACP:', error && error.message);
    cleanup(1);
  });

  try {
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'satr-thought-probe', title: 'سطر — مسبار التفكير', version: '2.11.0' },
    }, 15000);
    if (!initialized || initialized.protocolVersion !== 1) throw new Error('إصدار ACP غير مدعوم');

    const created = await rpc.request('session/new', { cwd: sandbox, mcpServers: [] }, 30000);
    sessionId = created && created.sessionId;
    if (!sessionId) throw new Error('لم تُنشأ جلسة');

    const promptPromise = rpc.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    }, 90000);

    await Promise.race([
      promptPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), MAX_WAIT_MS)),
    ]);
  } catch (error) {
    if (!finished) {
      console.log('⚠️  فشل المسبار الحي:', error && error.message);
      cleanup(1);
    }
  } finally {
    cleanup(0);
  }

  await new Promise((resolve) => setTimeout(resolve, 300));

  const thoughts = events.filter((e) => e.type === 'agent_thought_chunk');
  const messages = events.filter((e) => e.type === 'agent_message_chunk');
  const tools = events.filter((e) => e.type && e.type.startsWith('tool_call'));

  console.log('📊 المسبار الحي لـ agent_thought_chunk:');
  console.log('   الثنائي:', bin);
  console.log('   مدة الانتظار:', Date.now() - startedAt, 'ms');
  console.log('   كتل تفكير واردة:', thoughts.length);
  console.log('   كتل رد واردة:', messages.length);
  console.log('   أدوات واردة:', tools.length);

  if (!thoughts.length) {
    console.log('❌ لم يصل أي agent_thought_chunk — قد يعني إصداراً مختلفاً أو أن النموذج لم يُفكّر بصوت عالٍ.');
    return { ok: false, thoughts: 0, messages: messages.length, tools: tools.length };
  }

  console.log('✅ وصل التفكير الحي فعلاً عبر Kimi ACP.');
  return { ok: true, thoughts: thoughts.length, messages: messages.length, tools: tools.length };
}

function createRpc(proc, handlers) {
  let nextId = 0;
  let buffer = '';
  let closed = false;
  const pending = new Map();

  function write(message) {
    if (closed) return;
    try { proc.stdin.write(JSON.stringify(message) + '\n'); } catch { /* */ }
  }
  function request(method, params, timeoutMs) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      write({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  function respond(id, result) { write({ jsonrpc: '2.0', id, result }); }
  function respondError(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

  function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id != null && message.method) {
      Promise.resolve(handlers.onRequest && handlers.onRequest(message, { respond, respondError })).catch(() => {});
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'rpc_error');
        error.code = message.error.code;
        item.reject(error);
      } else item.resolve(message.result);
      return;
    }
    if (message.method && handlers.onNotification) handlers.onNotification(message.method, message.params || {});
  }

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch { /* */ }
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) item.reject(new Error('closed'));
    pending.clear();
  }

  proc.on('exit', () => close());
  return { request, respond, respondError, close };
}

(async () => {
  const result = await probe();
  process.exitCode = result.ok ? 0 : 0; // المسبار الحي لا يُفشل البناء عند اختلاف الإصدار
})();
