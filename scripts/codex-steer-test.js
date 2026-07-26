#!/usr/bin/env node
'use strict';

/**
 * اختبار قطعي للتوجيه أثناء الدور (turn/steer — الدفعة C1). بلا شبكة وبلا codex حقيقي:
 * نستبدل الثنائي بـ node عبر CODEX_BIN ونشغّل fixture باسم `app-server` داخل cwd
 * (نمط codex-contract-test.js المثبّت).
 *
 * يغطي:
 *  - تنقية النص النقية (محارف التحكم وBidi والسقف وCRLF والنوع غير النصي).
 *  - عقد السلك: turn/steer يُرسل بـ {threadId, expectedTurnId, input:[UserInput]}
 *    ومعرّف الدور النشط الفعلي.
 *  - رفض التوجيه الفارغ بلا أي حركة على السلك.
 *  - رفض التوجيه بعد اكتمال الدور (no_active_turn).
 *  - خطأ upstream ⇒ رمز ثابت 'rejected' بلا تسريب رسالة الخادم (تحمل معرّف الدور).
 *  - عدم إضافة أي نوع حدث جديد إلى عقد satr:event.
 */

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT_THREAD = '019f9000-0000-7000-8000-00000000aaaa';
const ROOT_TURN = '019f9000-0000-7000-8000-00000000bbbb';
const UPSTREAM_LEAK = 'expected active turn id `' + ROOT_TURN + '` but found `other`';

function fixtureSource() {
  return String.raw`'use strict';
const fs = require('fs');
const readline = require('readline');
const rootThreadId = '` + ROOT_THREAD + String.raw`';
const rootTurnId = '` + ROOT_TURN + String.raw`';
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32600, message } }); }
function log(value) { fs.appendFileSync(process.env.SATR_CODEX_STEER_LOG, JSON.stringify(value) + '\n', 'utf8'); }
let steerCount = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') { reply(message.id, { userAgent: 'fixture' }); return; }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') { reply(message.id, { thread: { id: rootThreadId } }); return; }
  if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: rootTurnId, status: 'inProgress' } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: {
      threadId: rootThreadId, turn: { id: rootTurnId, status: 'inProgress' },
    } });
    // الدور يبقى مفتوحاً عمداً حتى يصل التوجيه — لا turn/completed هنا
    return;
  }
  if (message.method === 'turn/steer') {
    steerCount += 1;
    log({ type: 'steer', n: steerCount, params: message.params });
    if (steerCount === 1) { reply(message.id, { turnId: rootTurnId }); return; }
    // الاستدعاء الثاني يحاكي رفض upstream برسالة تحمل معرّف الدور النشط، ثم يُنهي الدور
    // (بلا خطّاف اختبار في كود الإنتاج) كي نفحص التوجيه بعد النهاية.
    fail(message.id, process.env.SATR_CODEX_STEER_LEAK);
    send({ jsonrpc: '2.0', method: 'item/completed', params: {
      threadId: rootThreadId, turnId: rootTurnId, completedAtMs: Date.now(),
      item: { id: 'root-message', type: 'agentMessage', text: 'ROOT_FINAL', phase: 'final_answer' },
    } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: {
      threadId: rootThreadId, turn: { id: rootTurnId, status: 'completed' },
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

// ---------- (1) التنقية النقية ----------
function testSanitize(codex) {
  const s = codex.sanitizeSteerText;
  assert.strictEqual(s('  توقّف وأعد الكتابة  '), 'توقّف وأعد الكتابة', 'قصّ الفراغ');
  assert.strictEqual(s(''), '', 'نص فارغ');
  assert.strictEqual(s('   '), '', 'فراغ فقط');
  assert.strictEqual(s(null), '', 'null');
  assert.strictEqual(s(undefined), '', 'undefined');
  assert.strictEqual(s(42), '', 'رقم');
  assert.strictEqual(s({ text: 'x' }), '', 'كائن');
  assert.strictEqual(s(['x']), '', 'مصفوفة');

  // الأسطر الجديدة والجدولة تبقى (نص توجيه متعدد الأسطر مشروع)
  assert.strictEqual(s('سطر\nثانٍ'), 'سطر\nثانٍ', 'سطر جديد يبقى');
  assert.strictEqual(s('سطر\r\nثانٍ'), 'سطر\nثانٍ', 'CRLF يُطبَّع');
  assert.strictEqual(s('سطر\rثانٍ'), 'سطر\nثانٍ', 'CR وحده يُطبَّع');
  assert.strictEqual(s('أ\tب'), 'أ\tب', 'جدولة تبقى');

  // محارف التحكم تُستبدل بمسافة
  const bell = String.fromCharCode(0x07);
  const esc = String.fromCharCode(0x1b);
  const del = String.fromCharCode(0x7f);
  const nul = String.fromCharCode(0x00);
  assert.strictEqual(s('أ' + bell + 'ب'), 'أ ب', 'BEL');
  assert.strictEqual(s('أ' + esc + 'ب'), 'أ ب', 'ESC');
  assert.strictEqual(s('أ' + del + 'ب'), 'أ ب', 'DEL');
  assert.strictEqual(s('أ' + nul + 'ب'), 'أ ب', 'NUL');
  assert.strictEqual(s(String.fromCharCode(0x0b) + 'أ'), 'أ', 'VT');
  assert.strictEqual(s(String.fromCharCode(0x0c) + 'أ'), 'أ', 'FF');

  // محارف Bidi/التحكم في الاتجاه (خطر انتحال العرض) تُزال
  for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069]) {
    const out = s('أ' + String.fromCharCode(code) + 'ب');
    assert.strictEqual(out, 'أ ب', 'Bidi U+' + code.toString(16));
    assert(!out.includes(String.fromCharCode(code)), 'بقي محرف Bidi U+' + code.toString(16));
  }

  // السقف: القصّ قبل trim، والطول لا يتجاوز الحد
  const long = 'ن'.repeat(codex.MAX_STEER_CHARS + 500);
  assert.strictEqual(s(long).length, codex.MAX_STEER_CHARS, 'سقف الطول');
  assert.strictEqual(codex.MAX_STEER_CHARS, 32000, 'قيمة السقف المعلنة');
}

// ---------- (2) عقد السلك عبر fixture ----------
async function testWire(codex, project, logFile) {
  const events = [];
  let procDone = false;
  const handle = await codex.start({
    prompt: 'steer-contract', images: [], sessionId: null, model: 'gpt-5.6-sol',
    permissionMode: 'default', skills: [], browserControl: false,
  }, project, (event) => {
    events.push(event);
    if (event.type === 'proc_done') procDone = true;
  });

  assert.strictEqual(typeof handle.steer, 'function', 'المقبض لا يعرض steer');
  await waitFor(() => events.some((e) => e.type === 'system' && e.subtype === 'init'));
  // ننتظر وصول turn/started كي يُثبَّت turnId النشط
  await new Promise((resolve) => setTimeout(resolve, 150));

  // (أ) التوجيه الفارغ يُرفض محلياً بلا أي حركة على السلك
  const emptyResult = await handle.steer('   ');
  assert.deepStrictEqual(emptyResult, { ok: false, error: 'empty' }, 'قبل توجيهاً فارغاً');

  // (ب) توجيه صحيح أثناء دور جارٍ
  const ok = await handle.steer('وجّه: أعد الكتابة بالعربية');
  assert.strictEqual(ok.ok, true, 'فشل التوجيه أثناء دور جارٍ: ' + JSON.stringify(ok));
  assert.strictEqual(ok.turnId, ROOT_TURN, 'لم يُعد التوجيه معرّف الدور النشط');

  // (ج) خطأ upstream ⇒ رمز ثابت بلا تسريب رسالة الخادم
  const rejected = await handle.steer('توجيه ثانٍ يفشل');
  assert.deepStrictEqual(rejected, { ok: false, error: 'rejected' }, 'لم يُطبَّع خطأ upstream');
  const rejectedText = JSON.stringify(rejected);
  assert(!rejectedText.includes(ROOT_TURN), 'تسرّب معرّف الدور في رد الرفض');
  assert(!rejectedText.includes('expected active turn'), 'تسرّبت رسالة upstream الخام');

  // (د) بعد اكتمال الدور ⇒ no_active_turn (الـfixture أنهى الدور مع الرفض أعلاه)
  await waitFor(() => procDone);
  const afterDone = await handle.steer('توجيه متأخر');
  assert.deepStrictEqual(afterDone, { ok: false, error: 'no_active_turn' }, 'قبل توجيهاً بلا دور نشط');

  // سجل السلك: استدعاءان فقط، وكلاهما بالعقد الصحيح
  const records = (await fs.readFile(logFile, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const steers = records.filter((r) => r.type === 'steer');
  assert.strictEqual(steers.length, 2, 'عدد نداءات turn/steer على السلك: ' + steers.length);
  const first = steers[0].params;
  assert.strictEqual(first.threadId, ROOT_THREAD, 'threadId خاطئ');
  assert.strictEqual(first.expectedTurnId, ROOT_TURN, 'expectedTurnId ليس الدور النشط');
  assert(Array.isArray(first.input) && first.input.length === 1, 'input ليس مصفوفة عنصر واحد');
  assert.deepStrictEqual(first.input[0], {
    type: 'text', text: 'وجّه: أعد الكتابة بالعربية', text_elements: [],
  }, 'شكل UserInput لا يطابق schema v2');
  assert.strictEqual(Object.keys(first).sort().join(','), 'expectedTurnId,input,threadId',
    'حقول turn/steer غير المطلوبة تسرّبت: ' + Object.keys(first).join(','));

  // عقد satr:event: التوجيه لا يضيف نوع حدث جديد
  const types = new Set(events.map((e) => e.type));
  const known = new Set(['system', 'assistant', 'user', 'result', 'stream_text', 'permission_request',
    'question_request', 'file_edit', 'task_update', 'usage_update', 'rate_limits', 'stderr',
    'spawn_error', 'proc_done', 'preview_open', 'handoff_request', 'handoff_end',
    'testsprite_progress']);
  for (const t of types) assert(known.has(t), 'نوع حدث غير معروف أضافه التوجيه: ' + t);
  assert(!types.has('steer'), 'التوجيه بثّ نوع حدث خاصاً به');

  return events;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satr-codex-steer-'));
  const project = path.join(root, 'project');
  const logFile = path.join(root, 'steer.jsonl');
  try {
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'app-server'), fixtureSource(), 'utf8');
    process.env.CODEX_BIN = process.execPath;
    process.env.SATR_CODEX_STEER_LOG = logFile;
    process.env.SATR_CODEX_STEER_LEAK = UPSTREAM_LEAK;
    delete require.cache[require.resolve('../electron/codex')];
    const codex = require('../electron/codex');
    codex.resolveCodexBin(true);

    testSanitize(codex);
    await testWire(codex, project, logFile);

    console.log('codex-steer: نجح — تنقية النص، عقد turn/steer، رفض الفارغ وبعد النهاية،'
      + ' وعدم تسريب خطأ upstream.');
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.SATR_CODEX_STEER_LOG;
    delete process.env.SATR_CODEX_STEER_LEAK;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
