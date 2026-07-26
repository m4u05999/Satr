#!/usr/bin/env node
'use strict';

/**
 * اختبار قطعي لتكافؤ /ضغط و/سياق في محرك Codex (الدفعة C2). بلا شبكة وبلا codex
 * حقيقي: نستبدل الثنائي بـ node عبر CODEX_BIN ونشغّل fixture باسم `app-server` داخل
 * cwd (نمط codex-contract-test.js المثبّت).
 *
 * يغطي:
 *  /ضغط  — «/compact» يصير thread/compact/start بلا turn/start ولا مدخل نصّي،
 *          وعنصر contextCompaction يصير system/compact_boundary مع بقاء session_id،
 *          والإصدار غير الداعم يتدهور برسالة عربية بلا خطأ upstream خام،
 *          والاكتمال بلا عنصر تأكيد لا يُظهر بطاقة ضغط كاذبة.
 *  /سياق — تطبيع لقطة thread/tokenUsage/updated إلى عقد اللوحة (من `last` لا `total`)،
 *          ورسالة عربية هادئة عند غياب البيانات، وعزل اللقطات بين الخيوط.
 *  وثبات مجموعة أنواع satr:event (لا نوع جديد).
 */

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const THREAD = '019f9100-0000-7000-8000-00000000cccc';
const COMPACT_TURN = '019f9100-0000-7000-8000-00000000dddd';
const TURN = '019f9100-0000-7000-8000-00000000eeee';
const UPSTREAM_LEAK = 'Method not found: thread/compact/start (codex internal 0xDEADBEEF)';

// mode: compact | compact_unsupported | compact_silent | turn
function fixtureSource() {
  return String.raw`'use strict';
const fs = require('fs');
const readline = require('readline');
const threadId = '` + THREAD + String.raw`';
const compactTurnId = '` + COMPACT_TURN + String.raw`';
const turnId = '` + TURN + String.raw`';
const mode = process.env.SATR_CODEX_COMPACT_MODE;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32601, message } }); }
function log(value) { fs.appendFileSync(process.env.SATR_CODEX_COMPACT_LOG, JSON.stringify(value) + '\n', 'utf8'); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') { reply(message.id, { userAgent: 'fixture' }); return; }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') { reply(message.id, { thread: { id: threadId } }); return; }
  if (message.method === 'thread/resume') { reply(message.id, { thread: { id: threadId } }); return; }

  if (message.method === 'thread/compact/start') {
    log({ type: 'compact', params: message.params });
    if (mode === 'compact_unsupported') { fail(message.id, process.env.SATR_CODEX_COMPACT_LEAK); return; }
    reply(message.id, {});
    // الضغط يجري كدور حقيقي (مثبّت بالمسبار): turn/started ثم usage ثم العنصر ثم turn/completed
    send({ jsonrpc: '2.0', method: 'turn/started', params: {
      threadId, turn: { id: compactTurnId, status: 'inProgress' },
    } });
    send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
      threadId, turnId: compactTurnId, tokenUsage: {
        total: { inputTokens: 14040, outputTokens: 297, cachedInputTokens: 6912, reasoningOutputTokens: 0, totalTokens: 14337 },
        last: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 5656 },
        modelContextWindow: 258400,
      },
    } });
    if (mode !== 'compact_silent') {
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId, turnId: compactTurnId, completedAtMs: Date.now(),
        item: { id: 'compaction-1', type: 'contextCompaction' },
      } });
    }
    send({ jsonrpc: '2.0', method: 'turn/completed', params: {
      threadId, turn: { id: compactTurnId, status: 'completed' },
    } });
    return;
  }

  if (message.method === 'turn/start') {
    log({ type: 'turn', params: message.params });
    reply(message.id, { turn: { id: turnId, status: 'inProgress' } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: {
      threadId, turn: { id: turnId, status: 'inProgress' },
    } });
    // total تراكمي و last يصف آخر طلب — الاختبار يثبت أننا نعرض last
    send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
      threadId, turnId, tokenUsage: {
        total: { inputTokens: 31166, outputTokens: 308, cachedInputTokens: 20992, reasoningOutputTokens: 40, totalTokens: 31474 },
        last: { inputTokens: 17126, outputTokens: 11, cachedInputTokens: 14080, reasoningOutputTokens: 7, totalTokens: 17137 },
        modelContextWindow: 258400,
      },
    } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: {
      threadId, turnId, completedAtMs: Date.now(),
      item: { id: 'msg-1', type: 'agentMessage', text: 'ROOT_FINAL', phase: 'final_answer' },
    } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: {
      threadId, turn: { id: turnId, status: 'completed' },
    } });
    return;
  }
  if (message.method === 'turn/interrupt') { reply(message.id, {}); return; }
});
`;
}

async function waitFor(check, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timeout');
}

const KNOWN_EVENT_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_text',
  'permission_request', 'question_request', 'file_edit', 'task_update', 'usage_update',
  'rate_limits', 'stderr', 'spawn_error', 'proc_done', 'preview_open', 'handoff_request',
  'handoff_end', 'testsprite_progress']);

async function run(codex, project, prompt, sessionId) {
  const events = [];
  let done = false;
  await codex.start({
    prompt, images: [], sessionId, model: 'gpt-5.6-sol', permissionMode: 'default',
    skills: [], browserControl: false,
  }, project, (event) => {
    events.push(event);
    if (event.type === 'proc_done') done = true;
  });
  await waitFor(() => done, 15000);
  for (const event of events) {
    assert(KNOWN_EVENT_TYPES.has(event.type), 'نوع حدث غير معروف: ' + event.type);
  }
  return events;
}

const readLog = async (file) => {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
  return raw.trim() ? raw.trim().split(/\r?\n/).map(JSON.parse) : [];
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satr-codex-compact-t-'));
  const project = path.join(root, 'project');
  const logFile = path.join(root, 'compact.jsonl');
  try {
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'app-server'), fixtureSource(), 'utf8');
    process.env.CODEX_BIN = process.execPath;
    process.env.SATR_CODEX_COMPACT_LOG = logFile;
    process.env.SATR_CODEX_COMPACT_LEAK = UPSTREAM_LEAK;
    delete require.cache[require.resolve('../electron/codex')];
    const codex = require('../electron/codex');
    codex.resolveCodexBin(true);

    // ---------- /سياق: لا بيانات بعد ⇒ رسالة عربية هادئة ----------
    const empty = codex.contextUsage(project, THREAD);
    assert.strictEqual(empty.ok, false, 'أعاد سياقاً بلا بيانات');
    assert(typeof empty.error === 'string' && /Codex/.test(empty.error), 'رسالة غياب السياق ليست عربية واضحة');
    assert(!('usage' in empty), 'حمولة usage ظهرت بلا بيانات');
    assert.strictEqual(codex.contextUsage(project, null).ok, false, 'قبل جلسة فارغة');

    // ---------- دور عادي: يلتقط لقطة السياق ----------
    process.env.SATR_CODEX_COMPACT_MODE = 'turn';
    const turnEvents = await run(codex, project, 'مرحباً', null);
    assert(turnEvents.some((e) => e.type === 'result' && !e.is_error), 'فشل الدور العادي');
    const turnLog = (await readLog(logFile)).filter((r) => r.type === 'turn');
    assert.strictEqual(turnLog.length, 1, 'عدد نداءات turn/start: ' + turnLog.length);

    // ---------- /سياق: التطبيع من `last` لا `total` ----------
    const ctx = codex.contextUsage(project, THREAD);
    assert.strictEqual(ctx.ok, true, 'تعذّر بناء لقطة السياق: ' + JSON.stringify(ctx));
    const u = ctx.usage;
    assert.strictEqual(u.totalTokens, 17137, 'totalTokens من `last` (لا 31474 التراكمي)');
    assert.strictEqual(u.maxTokens, 258400, 'maxTokens من modelContextWindow');
    assert.strictEqual(u.percentage, Math.round((17137 / 258400) * 100), 'النسبة غير محسوبة من last/max');
    assert.strictEqual(u.model, 'gpt-5.6-sol', 'اسم النموذج');
    const byName = Object.fromEntries(u.categories.map((c) => [c.name, c.tokens]));
    assert.strictEqual(byName['الإدخال'], 17126, 'فئة الإدخال');
    assert.strictEqual(byName['الإخراج'], 11, 'فئة الإخراج');
    assert.strictEqual(byName['منها مخبّأ'], 14080, 'فئة المخبّأ');
    assert.strictEqual(byName['منه تفكير'], 7, 'فئة التفكير');
    assert(u.categories.every((c) => c.tokens > 0), 'فئة بصفر رموز لم تُحذف');
    // عزل الخيوط: معرّف آخر لا يرث اللقطة
    assert.strictEqual(codex.contextUsage(project, '019f9100-0000-7000-8000-00000000ffff').ok, false,
      'تسرّبت لقطة سياق بين خيطين');

    // ---------- /ضغط: المسار الناجح ----------
    await fs.writeFile(logFile, '', 'utf8');
    process.env.SATR_CODEX_COMPACT_MODE = 'compact';
    const compactEvents = await run(codex, project, '/compact', THREAD);
    const log1 = await readLog(logFile);
    assert.strictEqual(log1.filter((r) => r.type === 'compact').length, 1, 'لم يُستدعَ thread/compact/start مرة واحدة');
    assert.strictEqual(log1.filter((r) => r.type === 'turn').length, 0, 'الضغط أرسل turn/start (مدخل نصّي)');
    assert.deepStrictEqual(log1.find((r) => r.type === 'compact').params, { threadId: THREAD },
      'حقول thread/compact/start غير المطلوبة تسرّبت');

    const boundary = compactEvents.find((e) => e.type === 'system' && e.subtype === 'compact_boundary');
    assert(boundary, 'لم يصدر system/compact_boundary');
    assert.strictEqual(boundary.session_id, THREAD, 'تغيّر معرّف الجلسة بعد الضغط');
    assert.strictEqual(boundary.compact_metadata.trigger, 'manual', 'trigger غير manual');
    // حدّ upstream: لا أرقام قبل/بعد ⇒ لا ندّعيها (البطاقة تعرضها فقط إن كان pre رقماً)
    assert.strictEqual(typeof boundary.compact_metadata.pre_tokens, 'undefined', 'اختُلق pre_tokens');
    assert.strictEqual(typeof boundary.compact_metadata.post_tokens, 'undefined', 'اختُلق post_tokens');
    const compactResult = compactEvents.find((e) => e.type === 'result');
    assert(compactResult && !compactResult.is_error, 'فشلت نتيجة الضغط');
    assert.strictEqual(compactResult.session_id, THREAD, 'نتيجة الضغط بمعرّف جلسة مختلف');
    const compactText = compactEvents.flatMap((e) => e.message && Array.isArray(e.message.content)
      ? e.message.content.map((b) => b.text || '') : []).join('\n');
    assert(!/لم يؤكّد/.test(compactText), 'ظهر تحذير عدم التأكيد رغم وصول العنصر');

    // ---------- /ضغط: إصدار لا يدعمه ⇒ تدهور رشيق بلا خطأ خام ----------
    await fs.writeFile(logFile, '', 'utf8');
    process.env.SATR_CODEX_COMPACT_MODE = 'compact_unsupported';
    const oldEvents = await run(codex, project, '/compact', THREAD);
    const oldText = oldEvents.flatMap((e) => e.message && Array.isArray(e.message.content)
      ? e.message.content.map((b) => b.text || '') : []).join('\n');
    const allOldText = JSON.stringify(oldEvents);
    assert(/لا يدعم ضغط المحادثة/.test(oldText), 'لا رسالة عربية للإصدار غير الداعم: ' + oldText);
    assert(!allOldText.includes('0xDEADBEEF'), 'تسرّب نص خطأ upstream الخام');
    assert(!allOldText.includes('Method not found'), 'تسرّبت رسالة upstream الخام');
    assert(!oldEvents.some((e) => e.type === 'system' && e.subtype === 'compact_boundary'),
      'ظهرت بطاقة ضغط رغم فشل الاستدعاء');
    assert(oldEvents.some((e) => e.type === 'result'), 'لم تُغلق نتيجة الدور عند التدهور');

    // ---------- /ضغط: اكتمل الدور بلا عنصر تأكيد ⇒ لا بطاقة كاذبة ----------
    await fs.writeFile(logFile, '', 'utf8');
    process.env.SATR_CODEX_COMPACT_MODE = 'compact_silent';
    const silentEvents = await run(codex, project, '/compact', THREAD);
    assert(!silentEvents.some((e) => e.type === 'system' && e.subtype === 'compact_boundary'),
      'بطاقة ضغط بلا عنصر contextCompaction');
    const silentText = silentEvents.flatMap((e) => e.message && Array.isArray(e.message.content)
      ? e.message.content.map((b) => b.text || '') : []).join('\n');
    assert(/لم يؤكّد Codex اكتمال ضغط المحادثة/.test(silentText), 'لا تحذير عند غياب التأكيد: ' + silentText);

    console.log('codex-compact: نجح — /ضغط عبر thread/compact/start وحدود أرقامه،'
      + ' /سياق من `last` مع رسالة هادئة، وتدهور رشيق بلا تسريب upstream.');
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.SATR_CODEX_COMPACT_LOG;
    delete process.env.SATR_CODEX_COMPACT_LEAK;
    delete process.env.SATR_CODEX_COMPACT_MODE;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
