'use strict';

/**
 * مسبار قدرات Kimi Code ACP — يُشغَّل يدوياً بعد كل ترقية Kimi.
 *
 * يفحص الإصدار المثبَّت فعلياً ويقارنه بـ docs/KIMI-CAPABILITIES.md.
 * أي فرق يُطبع بشكل واضح؛ لا يُفشل البناء — المعلومة للمراجعة البشرية.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const kimi = require('../electron/kimi');

const BASELINE_PATH = path.join(__dirname, '..', 'docs', 'KIMI-CAPABILITIES.md');
const MAX_WAIT_MS = 60000;
const IS_WIN = process.platform === 'win32';

// حارس الخروج (‏OBS-062): مسبارٌ يطبع تقريره ثم لا يخرج يحجب سلسلة المسابير بصمت.
// النمط من `scripts/arabic-rtl-probe.js`: مهلة `unref` + التقاط ما لا يُلتقط + خروج صريح.
process.on('uncaughtException', (error) => {
  console.error('kimi-capability-probe: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
const exitGuard = setTimeout(() => {
  console.error('kimi-capability-probe: FAIL — تجاوز المهلة الكلية');
  process.exit(1);
}, 180000);
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
    if (message.method && handlers._extraNotification) handlers._extraNotification(message.method, message.params || {});
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

async function probeCapabilities() {
  const bin = findKimiBin();
  if (!bin) {
    console.log('⚠️  لم يُعثر على ثنائي Kimi Code — تخطّي المسبار.');
    return null;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-kimi-capability-'));
  const proc = spawnKimi(bin, ['acp'], sandbox);
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
      if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
        result.commands = update.availableCommands.map((c) => String(c && c.name || '')).filter(Boolean);
      }
    },
  };
  const rpc = createRpc(proc, handlers);

  const result = {
    steering: false,
    fork: false,
    undo: false,
    effort: false,
    thinking: false,
    mode: false,
    terminal: false,
    commands: [],
  };

  try {
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'satr-capability-probe', title: 'سطر — مسبار القدرات', version: '2.11.0' },
    }, 15000);

    const caps = initialized && initialized.agentCapabilities || {};
    const promptCaps = caps.promptCapabilities || {};
    result.terminal = !!(caps.terminalCapabilities && caps.terminalCapabilities.reverseRpc);

    const created = await rpc.request('session/new', { cwd: sandbox, mcpServers: [] }, 30000);
    const sessionId = created && created.sessionId;
    const configOptions = created && Array.isArray(created.configOptions) ? created.configOptions : [];
    for (const option of configOptions) {
      if (!option || !option.id) continue;
      if (option.id === 'effort' || option.id === 'reasoning_effort' || option.category === 'thought_level_effort') result.effort = true;
      if (option.id === 'thinking' || option.category === 'thought_level') result.thinking = true;
      if (option.id === 'mode') result.mode = true;
    }

    // steering: نبدأ دوراً طويلاً نسبياً ثم نحاول إرسال prompt آخر قبل انتهائه.
    // ننتظر أول كتلة إجابة كدليل على أن الدور نشط، ثم نُرسّل prompt ثانٍ.
    let gotChunk = false;
    handlers._extraNotification = (method, params) => {
      if (method === 'session/update') {
        const update = params && params.update || {};
        if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') gotChunk = true;
      }
    };
    const promptPromise = rpc.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'اشرح خطوة بخطوة كيفية حل مسألة برمجية بسيطة ثم أعطِ مثالاً.' }],
    }, 30000);

    // ننتظر أول كتلة إجابة (أو مهلة قصيرة) ثم نحاول steering.
    // ‏OBS-062 — **سبب التعليق الجذري**: كانت `check` تعيد جدولة نفسها كل 50ms بلا شرط
    // توقّف، و`setTimeout(resolve, 3000)` يحلّ الوعد **دون أن يوقف السلسلة**. فحين لا
    // تصل أول كتلة، تبقى حلقة الأحداث دائرة أبداً وينتهي الشغل بلا أن تخرج العملية.
    // العلاج: مقبضان يُمسح كلٌّ منهما عند أول حسم، أيّهما سبق.
    await new Promise((resolve) => {
      let pollTimer = null;
      let capTimer = null;
      const finish = () => {
        if (pollTimer) clearTimeout(pollTimer);
        if (capTimer) clearTimeout(capTimer);
        resolve();
      };
      const check = () => { if (gotChunk) return finish(); pollTimer = setTimeout(check, 50); };
      capTimer = setTimeout(finish, 3000);
      check();
    });

    try {
      await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'steering probe' }] }, 3000);
      result.steering = true;
    } catch (e) { result.steering = !(e && e.code === -32600); }

    handlers._extraNotification = null;
    try {
      await Promise.race([promptPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))]);
    } catch { /* */ }

    // fork/undo
    try { await rpc.request('session/fork', { sessionId }, 5000); result.fork = true; } catch (e) { result.fork = e && e.code !== -32601; }
    try { await rpc.request('session/undo', { sessionId }, 5000); result.undo = true; } catch (e) { result.undo = e && e.code !== -32601; }

    // الأوامر المعلنة: نفتح دوراً قصيراً جداً نطلب فيه /help
    try {
      await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/help' }] }, 15000);
    } catch { /* */ }
  } catch (error) {
    console.log('⚠️  فشل المسبار:', error && error.message);
  } finally {
    rpc.close();
    try { proc.stdin.end(); } catch { /* */ }
    // قتل حتمي بلا مؤقّت: المؤقّت غير المُلغى كان يُبقي الحلقة دائرة، وunref عليه كان
    // سيُخرج العملية قبل أن يُقتل الطفل فيبقى يتيماً. وعلى ويندوز الشجرة كاملةً لأن
    // الثنائي قد يكون خلف `cmd /c` فقتل الأب وحده يترك الحفيد (‏OBS-062).
    try {
      if (IS_WIN && proc.pid) {
        spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        proc.kill();
      }
    } catch { /* */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
  }

  return result;
}

/**
 * ‏OBS-062: المطابقة **ببادئة لا بمساواة تامة**. الوثيقة تكتب الحالة مؤهَّلة —
 * `**مدعوم منذ 0.38.0**` — فالمساواة التامة كانت تقرؤها «غير مدعوم» وتصرخ بفرقٍ معروف
 * في كل تشغيل حتى يصير تحذيراً يُتجاهَل. و«غير مدعوم» لا يطابق البادئة لأنه يبدأ بـ«غير».
 */
function is(value, word) {
  return typeof value === 'string' && new RegExp('^' + word + '(\\s|$)').test(value.trim());
}

function readBaseline() {
  try {
    const text = fs.readFileSync(BASELINE_PATH, 'utf8');
    const parse = (pattern) => {
      const m = text.match(pattern);
      return m ? m[1].trim() : null;
    };
    // \S+ بدلاً من \w+ لأن الحالة قد تكون عربية (مدعوم/غير مدعوم/معلن/موصول).
    return {
      steering: is(parse(/\| steering[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'مدعوم'),
      fork: is(parse(/\| session\/fork[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'مدعوم'),
      undo: is(parse(/\| session\/undo[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'مدعوم'),
      effort: is(parse(/\| effort[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'معلن'),
      thinking: is(parse(/\| thinking[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'معلن'),
      mode: is(parse(/\| mode[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'معلن'),
      terminal: is(parse(/\| terminal[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/), 'موصول'),
      commands: parse(/\| الأوامر[^|]*\|[^|]*\*\*([^*|\s][^*|]*?)\*\*/) || 'محدودة',
    };
  } catch {
    return null;
  }
}

function compare(result) {
  const baseline = readBaseline();
  if (!baseline) {
    console.log('⚠️  تعذّر قراءة خط الأساس من docs/KIMI-CAPABILITIES.md');
    return;
  }

  const diffs = [];
  const bools = ['steering', 'fork', 'undo', 'effort', 'thinking', 'mode', 'terminal'];
  for (const key of bools) {
    if (result[key] !== baseline[key]) {
      diffs.push(`- ${key}: خط الأساس ${baseline[key] ? '✅' : '❌'} — الواقع ${result[key] ? '✅' : '❌'}`);
    }
  }

  console.log('\n📊 نتائج المسبار الحي:');
  console.log('   الثنائي:', findKimiBin());
  for (const key of bools) {
    console.log(`   ${key}: ${result[key] ? '✅' : '❌'}`);
  }
  console.log('   commands:', result.commands.join(', ') || '(لا شيء)');

  if (diffs.length) {
    console.log('\n⚠️  فروق عن خط الأساس:');
    for (const line of diffs) console.log(line);
    console.log('\nراجع docs/KIMI-CAPABILITIES.md وCLAUDE.md وحدّثهما عند الحاجة.');
  } else {
    console.log('\n✅ لا يوجد فرق عن خط الأساس.');
  }
}

// حارس `require.main` كي يصير الملف قابلاً للاستيراد: بلا هذا كان مجرّد `require`
// يشغّل مسباراً حياً يستهلك دوراً — فلا يمكن اختبار محلّل خط الأساس إلا بنسخ منطقه،
// وذاك حارسٌ يقارن الشيء بنفسه (الدرس نفسه في `full-suite.js`).
if (require.main === module) {
  (async () => {
    const result = await probeCapabilities();
    if (result) compare(result);
    // خروج صريح (‏OBS-062): لا تعتمد على فراغ حلقة الأحداث — مقبضٌ واحد منسيّ يحوّل
    // «انتهى التقرير» إلى عمليةٍ خالدة تحجب ما بعدها.
    process.exit(0);
  })();
}

module.exports = { is, readBaseline, findKimiBin };
