#!/usr/bin/env node
'use strict';

/**
 * مسبار حيّ لـ turn/steer (التوجيه أثناء الدور) — الدفعة C1.
 *
 * مبدأ «المسبار أولاً»: نثبت عقد البروتوكول على codex-cli المثبّت فعلياً قبل بناء أي
 * ميزة عليه. المسبار طبقتان:
 *   (أ) سلك خام: نشغّل `codex app-server` بأنفسنا ونتكلم JSON-RPC مباشرةً، فالنتيجة
 *       توثّق عقد upstream مستقلاً عن تنفيذ «سطر». يغطي: توجيه ناجح أثناء دور جارٍ،
 *       expectedTurnId غير مطابق، وtoجيه بعد turn/completed.
 *   (ب) تكامل: نفس الدورة عبر مقبض codex.start().steer() مع رفض «لا دور نشط».
 *
 * المسبار حيّ (يستهلك دوراً حقيقياً) فيبقى خارج test:full مثل بقية مسابير Codex.
 * التشغيل: npm run test:codex-steer-probe
 */

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const codex = require('../electron/codex');

const TIMEOUT_MS = 300000;
const STEER_MARKER = 'SATR_STEER_OK';
const MODEL = process.env.SATR_CODEX_STEER_MODEL || 'gpt-5.6-sol';

// دور طويل بما يكفي لنوجّهه أثناء جريانه (بلا أدوات — لا أذونات تعترض المسبار)
const LONG_PROMPT = [
  'اكتب قائمة مرقّمة من 1 إلى 60، كل سطر يحمل جملة عربية مختلفة عن البرمجة.',
  'لا تستخدم أي أداة (لا shell ولا قراءة ملفات ولا MCP). اكتب النص فقط.',
].join('\n');

const STEER_TEXT = [
  'توقّف عن القائمة فوراً وتجاهلها.',
  'أجب الآن بسطر واحد فقط لا غير هو: ' + STEER_MARKER,
].join('\n');

// ---------- عميل JSON-RPC خام فوق codex app-server ----------
function openAppServer(bin, cwd) {
  const proc = spawn(bin, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  const listeners = [];
  const stderrText = [];
  let reqId = 0;
  let buf = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && replies.has(msg.id)) {
        const pending = replies.get(msg.id);
        replies.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'rpc_error'), { rpc: msg.error }));
        else pending.resolve(msg.result);
        continue;
      }
      if (msg.id != null && msg.method) {
        // طلب خادم (إذن/سؤال) — نرفضه بلطف كي لا يعلّق المسبار
        try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }) + '\n'); } catch {}
        continue;
      }
      if (msg.method) for (const fn of listeners.slice()) { try { fn(msg.method, msg.params || {}); } catch {} }
    }
  });
  proc.stderr.on('data', (d) => stderrText.push(d.toString('utf8')));

  function write(obj) { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }
  return {
    proc,
    stderrText,
    onNotification(fn) { listeners.push(fn); },
    request(method, params) {
      const id = ++reqId;
      return new Promise((resolve, reject) => {
        replies.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params: params || {} });
      });
    },
    notify(method, params) { write({ method, params: params || {} }); },
    close() { try { proc.stdin.end(); } catch {} setTimeout(() => { try { proc.kill(); } catch {} }, 300); },
  };
}

function waitFor(predicateRegister, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('انتهت مهلة الانتظار: ' + label)), ms);
    predicateRegister((value) => { clearTimeout(timer); resolve(value); });
  });
}

async function rawWireProbe(bin, project, report) {
  const server = openAppServer(bin, project);
  try {
    const events = [];
    let onTurnStarted = null;
    let onFirstDelta = null;
    let onTurnCompleted = null;
    const finalTexts = [];

    server.onNotification((method, params) => {
      events.push(method);
      if (method === 'turn/started' && onTurnStarted) { const fn = onTurnStarted; onTurnStarted = null; fn(params); }
      if (method === 'item/agentMessage/delta' && onFirstDelta) { const fn = onFirstDelta; onFirstDelta = null; fn(params); }
      if (method === 'item/completed' && params.item && params.item.type === 'agentMessage') {
        finalTexts.push(String(params.item.text || ''));
      }
      if (method === 'turn/completed' && onTurnCompleted) { const fn = onTurnCompleted; onTurnCompleted = null; fn(params); }
    });

    await server.request('initialize', { clientInfo: { name: 'satr-steer-probe', title: 'Satr', version: '1.0.0' } });
    server.notify('initialized', {});

    const started = await server.request('thread/start', {
      cwd: project,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      persistExtendedHistory: false,
      experimentalRawEvents: false,
    });
    const threadId = started && started.thread && started.thread.id;
    assert(threadId, 'لم يعد thread/start معرّف خيط');

    const turnStartedPromise = waitFor((cb) => { onTurnStarted = cb; }, 60000, 'turn/started');
    const firstDeltaPromise = waitFor((cb) => { onFirstDelta = cb; }, 120000, 'أول جزء نصي');
    const turnCompletedPromise = waitFor((cb) => { onTurnCompleted = cb; }, TIMEOUT_MS, 'turn/completed');

    const turnStartResponse = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: LONG_PROMPT, text_elements: [] }],
      model: MODEL,
    });
    const turnId = turnStartResponse && turnStartResponse.turn && turnStartResponse.turn.id;
    assert(turnId, 'لم يعد turn/start معرّف دور');
    await turnStartedPromise;
    await firstDeltaPromise; // الدور جارٍ فعلاً الآن — لحظة التوجيه الصحيحة

    // (1) expectedTurnId غير مطابق ⇒ يجب أن يفشل بلا أثر
    let mismatchError = null;
    try {
      await server.request('turn/steer', {
        threadId,
        expectedTurnId: '00000000-0000-7000-8000-000000000000',
        input: [{ type: 'text', text: 'يجب ألا يصل هذا النص أبداً.', text_elements: [] }],
      });
    } catch (error) { mismatchError = error.rpc || { message: String(error.message || error) }; }
    assert(mismatchError, 'قبِل app-server توجيهاً بـ expectedTurnId غير مطابق');

    // (2) توجيه صحيح أثناء الدور نفسه
    const steerResponse = await server.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: STEER_TEXT, text_elements: [] }],
    });
    assert(steerResponse && typeof steerResponse.turnId === 'string', 'لم يعد turn/steer حقل turnId');

    const completed = await turnCompletedPromise;
    const completedTurnId = completed && completed.turn && completed.turn.id;
    const finalText = finalTexts.join('\n');

    // (3) توجيه بعد اكتمال الدور ⇒ يجب أن يفشل
    let afterCompleteError = null;
    try {
      await server.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: 'توجيه متأخر.', text_elements: [] }],
      });
    } catch (error) { afterCompleteError = error.rpc || { message: String(error.message || error) }; }
    assert(afterCompleteError, 'قبِل app-server توجيهاً بعد turn/completed');

    assert(finalText.includes(STEER_MARKER),
      'لم يصل التوجيه إلى النموذج في الدور نفسه. النص: ' + finalText.slice(0, 400));

    report.raw = {
      thread_id_present: true,
      turn_id_from_start: turnId,
      steer_returned_turn_id: steerResponse.turnId,
      steer_turn_id_equals_start: steerResponse.turnId === turnId,
      completed_turn_id_equals_start: completedTurnId === turnId,
      mismatch_error: mismatchError,
      after_complete_error: afterCompleteError,
      marker_in_final_answer: true,
      final_answer_chars: finalText.length,
      notifications_seen: events.length,
      turn_completed_status: completed && completed.turn && completed.turn.status,
    };
  } finally {
    server.close();
  }
}

async function handleProbe(project, report) {
  let handle = null;
  let completed = false;
  const finalTexts = [];
  let result = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let firstDeltaSeen = null;
  const firstDelta = new Promise((resolve) => { firstDeltaSeen = resolve; });
  const timer = setTimeout(() => { if (handle && handle.stop) handle.stop().catch(() => {}); finish(); }, TIMEOUT_MS);

  try {
    handle = await codex.start({
      prompt: LONG_PROMPT,
      images: [],
      sessionId: null,
      model: MODEL,
      permissionMode: 'plan',
      skills: [],
      effort: 'low',
      browserControl: false,
    }, project, (event) => {
      if (event.type === 'stream_text' && firstDeltaSeen) { const fn = firstDeltaSeen; firstDeltaSeen = null; fn(); }
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block && block.type === 'text' && block.phase !== 'commentary') finalTexts.push(String(block.text || ''));
        }
      }
      if (event.type === 'result') result = event;
      if (event.type === 'proc_done' && !completed) { completed = true; finish(); }
    });

    assert(typeof handle.steer === 'function', 'مقبض codex.start لا يعرض steer');
    await firstDelta;
    const steered = await handle.steer(STEER_TEXT);
    assert(steered && steered.ok === true, 'فشل توجيه المقبض أثناء دور جارٍ: ' + JSON.stringify(steered));

    await done;
    clearTimeout(timer);

    // بعد انتهاء الدور: لا دور نشط ⇒ رفض هادئ لا استثناء
    const afterDone = await handle.steer('توجيه بعد النهاية.');
    assert(afterDone && afterDone.ok === false, 'قبِل المقبض توجيهاً بلا دور نشط');

    const finalText = finalTexts.join('\n');
    assert(finalText.includes(STEER_MARKER), 'لم يظهر أثر التوجيه في إجابة المقبض');
    assert(result && !result.is_error, 'فشل دور المقبض');

    report.handle = {
      steer_ok: true,
      steer_returned_turn_id: typeof steered.turnId === 'string',
      after_done_rejected: true,
      after_done_error: afterDone.error,
      marker_in_final_answer: true,
      final_answer_chars: finalText.length,
    };
  } finally {
    clearTimeout(timer);
    if (!completed && handle && handle.stop) await handle.stop().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function main() {
  const bin = codex.resolveCodexBin();
  assert(bin, 'لم يُعثر على ثنائي codex — ثبّته: npm install -g @openai/codex');
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-codex-steer-'));
  const report = { ok: true, model: MODEL };
  try {
    await fsp.writeFile(path.join(project, 'README.md'), '# Satr codex steer probe\n', 'utf8');
    await rawWireProbe(bin, project, report);
    // --raw-only: عقد السلك وحده (يُستعمل أثناء التطوير قبل بناء steer على المقبض)
    if (!process.argv.includes('--raw-only')) await handleProbe(project, report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fsp.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
