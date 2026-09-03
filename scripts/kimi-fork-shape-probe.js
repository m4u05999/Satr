'use strict';

/**
 * مسبار شكل استجابة session/fork في Kimi Code ACP.
 *
 * يُشغّل kimi acp الحقيقي، يُنشئ جلسة قصيرة، يستدعي session/fork، ثم يستأنف الفرع.
 * لا يطبع المحتوى، فقط بنية الرد (المفاتيح وأطوال القيم) للتحقق من العقد.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const kimi = require('../electron/kimi');

const IS_WIN = process.platform === 'win32';
const MAX_WAIT_MS = 60000;

process.on('uncaughtException', (error) => {
  console.error('kimi-fork-shape-probe: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
const exitGuard = setTimeout(() => {
  console.error('kimi-fork-shape-probe: FAIL — تجاوز المهلة الكلية');
  process.exit(1);
}, 120000);
exitGuard.unref();

function findKimiBin() {
  const found = kimi.resolveKimiBin(true);
  if (found) return found;
  try {
    return require('child_process').execSync(IS_WIN ? 'where kimi' : 'which kimi', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  } catch { return null; }
}

function spawnKimi(bin, args, cwd) {
  if (IS_WIN && /\.(?:cmd|bat)$/i.test(bin)) {
    const command = '"' + String(bin).replace(/"/g, '""') + '" '
      + args.map((arg) => '"' + String(arg).replace(/"/g, '""') + '"').join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  }
  return spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
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

function describeShape(value, depth = 0, includeValues = false) {
  if (depth > 5) return '[عمق زائد]';
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return includeValues ? JSON.stringify(value) : `string(${value.length})`;
  if (typeof value === 'number') return `number(${value})`;
  if (typeof value === 'boolean') return `boolean(${value})`;
  if (Array.isArray(value)) {
    if (!value.length) return 'array(0)';
    return `array(${value.length}) [${value.slice(0, 3).map((v) => describeShape(v, depth + 1, includeValues)).join(', ')}${value.length > 3 ? ', …' : ''}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return 'object(0)';
    const pairs = keys.slice(0, 6).map((k) => `${k}: ${describeShape(value[k], depth + 1)}`);
    return `{ ${pairs.join(', ')}${keys.length > 6 ? ', …' : ''} }`;
  }
  return typeof value;
}

async function probe() {
  const bin = findKimiBin();
  if (!bin) {
    console.log('⚠️  لم يُعثر على ثنائي Kimi Code — تخطّي المسبار.');
    return null;
  }
  console.log('الثنائي:', bin);

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-kimi-fork-shape-'));
  console.log('مجلد الجلسة:', sandbox);
  const proc = spawnKimi(bin, ['acp'], os.homedir());
  const messageIds = [];
  const handlers = {
    onRequest(message, channel) {
      if (message.method === 'session/request_permission') {
        channel.respond(message.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      channel.respondError(message.id, -32601, 'غير متاح في المسبار');
    },
    onNotification(method, params) {
      if (method !== 'session/update') return;
      const update = params && params.update || {};
      const mid = update.messageId || (params && params.messageId);
      if (mid && !messageIds.includes(mid)) messageIds.push(mid);
    },
  };
  const rpc = createRpc(proc, handlers);
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) console.log('[stderr]', text.slice(0, 500));
  });

  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'satr-fork-shape-probe', title: 'سطر — مسبار شكل التفريع', version: '2.16.0' },
    }, 15000);

    const created = await rpc.request('session/new', { cwd: sandbox, mcpServers: [] }, 30000);
    const sessionId = created && created.sessionId;
    console.log('session/new →', describeShape(created));
    console.log('معرّف الجلسة الأصل:', sessionId);

    // نسأل سؤالاً قصيراً جداً لإنشاء دور مستخدم واحد على الأقل
    const userMessageId = '00000000-0000-1000-8000-000000000001';
    try {
      const promptResult = await rpc.request('session/prompt', {
        sessionId,
        messageId: userMessageId,
        prompt: [{ type: 'text', text: 'قل "تم" فقط.' }],
      }, 30000);
      console.log('session/prompt (مع messageId) →', JSON.stringify(promptResult));
    } catch (e) {
      console.log('تجاهل انتهاء الدور أو مهلة:', e && e.code, e && e.message);
    }
    console.log('معرّفات الرسائل المُرصدة:', messageIds);

    // تحميل الجلسة لقراءة معرّفات رسائل المستخدم التاريخية
    const historyIds = [];
    try {
      const loadHandlers = {
        onRequest: handlers.onRequest,
        onNotification(method, params) {
          if (method !== 'session/update') return;
          const update = params && params.update || {};
          if (update.sessionUpdate === 'user_message_chunk' && update.messageId) historyIds.push(update.messageId);
        },
      };
      // نستخدم جسر RPC منفصل للتحميل حتى لا نخلط الإشعارات
      const loadRpc = createRpc(proc, loadHandlers);
      const loaded = await loadRpc.request('session/load', { sessionId, cwd: sandbox, mcpServers: [] }, 30000);
      loadRpc.close();
      console.log('\nsession/load →', describeShape(loaded));
      console.log('معرّفات رسائل المستخدم في التاريخ:', historyIds);
    } catch (e) {
      console.log('\nفشل تحميل الجلسة:', e.code, e.message);
    }

    // التفريع من النهاية (بدون upToMessageId)
    let forkResult;
    let forkError;
    try {
      forkResult = await rpc.request('session/fork', { sessionId, cwd: sandbox }, 10000);
      console.log('\n(session/fork بدون upToMessageId) →');
      console.log('  بنية الرد:', describeShape(forkResult));
    } catch (e) {
      forkError = e;
      console.log('\n(session/fork بدون upToMessageId) →');
      console.log('  خطأ:', e.code, e.message);
    }

    // التفريع عند رسالة حقيقية إن وُجدت
    if (historyIds.length) {
      try {
        const r = await rpc.request('session/fork', { sessionId, cwd: sandbox, upToMessageId: historyIds[0] }, 10000);
        console.log('\n(session/fork مع upToMessageId حقيقي) →');
        console.log('  بنية الرد:', describeShape(r));
      } catch (e) {
        console.log('\n(session/fork مع upToMessageId حقيقي) →');
        console.log('  خطأ:', e.code, e.message);
      }
    }

    // استئناف الفرع للتحقق من صحته
    const forkSessionId = forkResult && forkResult.sessionId;
    if (forkSessionId) {
      try {
        const resumed = await rpc.request('session/resume', { sessionId: forkSessionId, cwd: sandbox }, 10000);
        console.log('\n(session/resume على الفرع) →');
        console.log('  بنية الرد:', describeShape(resumed));
        console.log('  تم الاستئناف:', !!(resumed && resumed.sessionId));
      } catch (e) {
        console.log('\nفشل استئناف الفرع:', e.code, e.message);
      }
    }

    return { forkResult, forkError };
  } finally {
    rpc.close();
    try { proc.stdin.end(); } catch { /* */ }
    try {
      if (IS_WIN && proc.pid) {
        spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        proc.kill();
      }
    } catch { /* */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
  }
}

if (require.main === module) {
  (async () => {
    await probe();
    process.exit(0);
  })();
}
