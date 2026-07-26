#!/usr/bin/env node
'use strict';

/**
 * مسبار حيّ لضغط سياق Codex (thread/compact/start) — الدفعة C2.
 *
 * مبدأ «المسبار أولاً»: نثبت عقد البروتوكول على codex-cli المثبّت فعلياً قبل بناء
 * الميزة. المسبار **سلك خام**: يشغّل `codex app-server` بنفسه ويتكلم JSON-RPC مباشرةً،
 * فالنتيجة توثّق عقد upstream مستقلاً عن تنفيذ «سطر».
 *
 * يجيب عن أسئلة الدفعة الأربعة:
 *   1) ماذا يعيد `thread/compact/start` وما الإشعارات التي تصاحب اكتماله؟
 *      (الـschema: ThreadCompactStartResponse كائن فارغ، وContextCompactedNotification
 *       موسومة Deprecated لصالح عنصر contextCompaction — أيّهما يصل فعلاً؟)
 *   2) هل تصل أرقام رموز قبل/بعد؟ ومن أين؟
 *   3) هل تبقى الجلسة قابلة للإكمال بعده ويحتفظ النموذج بمعلومة سابقة؟
 *   4) ما سلوك الاستدعاء أثناء دور جارٍ؟
 *
 * المسبار حيّ (يستهلك أدواراً حقيقية) فيبقى خارج test:full مثل بقية مسابير Codex.
 * التشغيل: npm run test:codex-compact-probe
 */

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const codex = require('../electron/codex');

const MODEL = process.env.SATR_CODEX_COMPACT_MODEL || 'gpt-5.6-sol';
const MEMO = 'SATR_MEMO_7788';
const TURN_TIMEOUT_MS = 240000;
const COMPACT_TIMEOUT_MS = 240000;

function openAppServer(bin, cwd) {
  const proc = spawn(bin, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  const listeners = [];
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
        // طلب خادم (إذن) — نرفضه بلطف كي لا يعلّق المسبار
        try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }) + '\n'); } catch {}
        continue;
      }
      if (msg.method) for (const fn of listeners.slice()) { try { fn(msg.method, msg.params || {}); } catch {} }
    }
  });
  proc.stderr.on('data', () => {});

  function write(obj) { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }
  return {
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

function deferred(ms, label) {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    setTimeout(() => reject(new Error('انتهت المهلة: ' + label)), ms);
  });
  return { promise, settle: (v) => settle(v) };
}

async function main() {
  const bin = codex.resolveCodexBin();
  assert(bin, 'لم يُعثر على ثنائي codex — ثبّته: npm install -g @openai/codex');
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-codex-compact-'));
  await fsp.writeFile(path.join(project, 'README.md'), '# Satr codex compact probe\n', 'utf8');

  const server = openAppServer(bin, project);
  const report = { ok: true, model: MODEL };
  try {
    // سجلّات المراقبة
    const allMethods = [];
    let usageSnapshots = [];          // كل thread/tokenUsage/updated بترتيبها
    let compactWindowMethods = null;  // إشعارات نافذة الضغط فقط
    let compactItems = [];            // عناصر item/completed أثناء الضغط
    let finalTexts = [];
    let turnDone = null;
    let compactSignal = null;
    let phaseLabel = 'turn1';         // وسم المرحلة الجارية لكل لقطة استخدام

    server.onNotification((method, params) => {
      allMethods.push(method);
      if (compactWindowMethods) compactWindowMethods.push(method);

      if (method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage || {};
        const total = usage.total || {};
        const last = usage.last || {};
        // نسجّل `last` و`total` معاً: `total` تراكمي عبر الخيط، بينما `last` يصف آخر
        // طلب — والفرق حاسم لاختيار مقياس امتلاء نافذة السياق.
        usageSnapshots.push({
          phase: phaseLabel,
          total: { totalTokens: total.totalTokens, inputTokens: total.inputTokens,
            outputTokens: total.outputTokens, cachedInputTokens: total.cachedInputTokens },
          last: { totalTokens: last.totalTokens, inputTokens: last.inputTokens,
            outputTokens: last.outputTokens, cachedInputTokens: last.cachedInputTokens },
          modelContextWindow: usage.modelContextWindow,
        });
      }
      if (method === 'item/completed' && params.item) {
        if (compactWindowMethods) compactItems.push(params.item.type);
        if (params.item.type === 'agentMessage') finalTexts.push(String(params.item.text || ''));
      }
      // إشارات اكتمال الضغط المحتملة (Deprecated + الحديثة)
      if (compactSignal) {
        if (method === 'thread/compacted') compactSignal.settle({ via: 'thread/compacted', params });
        if (method === 'item/completed' && params.item && params.item.type === 'contextCompaction') {
          compactSignal.settle({ via: 'item/completed:contextCompaction', item: params.item });
        }
      }
      if (turnDone && method === 'turn/completed') turnDone.settle(params);
    });

    await server.request('initialize', { clientInfo: { name: 'satr-compact-probe', title: 'Satr', version: '1.0.0' } });
    server.notify('initialized', {});
    const started = await server.request('thread/start', {
      cwd: project, approvalPolicy: 'on-request', sandbox: 'read-only',
      persistExtendedHistory: false, experimentalRawEvents: false,
    });
    const threadId = started && started.thread && started.thread.id;
    assert(threadId, 'لم يعد thread/start معرّف خيط');

    // ---------- (1) دور حقيقي يبني سياقاً ويزرع معلومة ----------
    turnDone = deferred(TURN_TIMEOUT_MS, 'الدور الأول');
    await server.request('turn/start', {
      threadId, model: MODEL,
      input: [{ type: 'text', text:
        'احفظ هذا الرمز في ذاكرتك: ' + MEMO + '. ثم اكتب فقرة قصيرة (نحو 15 سطراً) عن أهمية '
        + 'الاختبارات في البرمجيات، بلا أي أداة. لا تستخدم shell ولا قراءة ملفات.',
        text_elements: [] }],
    });
    await turnDone.promise;
    turnDone = null;

    // ---------- (2) الضغط ----------
    phaseLabel = 'compact';
    compactWindowMethods = [];
    compactSignal = deferred(COMPACT_TIMEOUT_MS, 'إشارة اكتمال الضغط');
    const compactStartedAt = Date.now();
    const compactResponse = await server.request('thread/compact/start', { threadId });
    let signal = null;
    let signalError = null;
    try { signal = await compactSignal.promise; } catch (error) { signalError = String(error.message || error); }
    compactSignal = null;
    const compactMs = Date.now() - compactStartedAt;
    // نمهل لحظة لالتقاط أي tokenUsage يتبع الضغط
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const compactMethods = compactWindowMethods.slice();
    compactWindowMethods = null;

    // ---------- (3) هل تبقى الجلسة قابلة للإكمال ويحتفظ بالمعلومة؟ ----------
    phaseLabel = 'after_compact';
    finalTexts = [];
    turnDone = deferred(TURN_TIMEOUT_MS, 'الدور بعد الضغط');
    await server.request('turn/start', {
      threadId, model: MODEL,
      input: [{ type: 'text', text: 'ما الرمز الذي طلبت منك حفظه سابقاً؟ أجب بالرمز وحده بلا شرح.',
        text_elements: [] }],
    });
    const afterTurn = await turnDone.promise;
    turnDone = null;
    const recallText = finalTexts.join('\n');

    // ---------- (4) الضغط أثناء دور جارٍ ----------
    phaseLabel = 'during_active_turn';
    let duringTurnError = null;
    let duringTurnAccepted = false;
    turnDone = deferred(TURN_TIMEOUT_MS, 'الدور الطويل');
    await server.request('turn/start', {
      threadId, model: MODEL,
      input: [{ type: 'text', text: 'اكتب قائمة مرقّمة من 1 إلى 60، كل سطر جملة عربية مختلفة. لا تستخدم أي أداة.',
        text_elements: [] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 6000)); // ندع الدور يجري فعلاً
    try {
      await server.request('thread/compact/start', { threadId });
      duringTurnAccepted = true;
    } catch (error) { duringTurnError = error.rpc || { message: String(error.message || error) }; }
    try { await turnDone.promise; } catch { /* قد يُقاطَع */ }
    turnDone = null;

    // ---------- الحصاد ----------
    const byPhase = (name) => usageSnapshots.filter((u) => u.phase === name);
    const lastOf = (name) => { const a = byPhase(name); return a.length ? a[a.length - 1] : null; };
    const lastBefore = lastOf('turn1');
    const lastDuringCompact = lastOf('compact');
    const lastAfterCompact = lastOf('after_compact');

    assert(compactResponse !== undefined, 'لم يردّ thread/compact/start');
    assert(signal || signalError, 'لا إشارة ولا خطأ لاكتمال الضغط');
    assert(recallText.includes(MEMO), 'لم يحتفظ الخيط بالمعلومة بعد الضغط. النص: ' + recallText.slice(0, 300));

    report.compact = {
      response_body: compactResponse,
      response_is_empty_object: compactResponse != null && typeof compactResponse === 'object'
        && Object.keys(compactResponse).length === 0,
      completion_signal: signal ? signal.via : null,
      completion_signal_error: signalError,
      compaction_item_payload_keys: signal && signal.item ? Object.keys(signal.item).sort() : null,
      elapsed_ms: compactMs,
      notifications_during_compact: compactMethods.length,
      distinct_notifications_during_compact: Array.from(new Set(compactMethods)).sort(),
      item_types_during_compact: Array.from(new Set(compactItems)).sort(),
    };
    // مقياس امتلاء السياق: `total` تراكمي عبر الخيط (يكبر أبداً ولا يتقلّص بالضغط)،
    // بينما `last` يصف آخر طلب فيعكس الإشغال الحقيقي. نطبع الاثنين حول الضغط ليحسم
    // الرقم أيّهما نعرضه في لوحة /سياق.
    report.token_usage = {
      snapshots: usageSnapshots.length,
      model_context_window: lastBefore ? lastBefore.modelContextWindow : null,
      before_compact: lastBefore ? { total: lastBefore.total, last: lastBefore.last } : null,
      during_compact: lastDuringCompact ? { total: lastDuringCompact.total, last: lastDuringCompact.last } : null,
      after_compact: lastAfterCompact ? { total: lastAfterCompact.total, last: lastAfterCompact.last } : null,
      usage_arrived_during_compact: byPhase('compact').length > 0,
      last_input_shrank_after_compact: !!(lastBefore && lastAfterCompact
        && typeof lastBefore.last.inputTokens === 'number'
        && typeof lastAfterCompact.last.inputTokens === 'number'
        && lastAfterCompact.last.inputTokens < lastBefore.last.inputTokens),
    };
    report.continuity = {
      thread_usable_after_compact: !!afterTurn,
      turn_status_after_compact: afterTurn && afterTurn.turn && afterTurn.turn.status,
      memo_recalled: recallText.includes(MEMO),
      recall_chars: recallText.length,
    };
    report.during_active_turn = {
      accepted: duringTurnAccepted,
      error: duringTurnError,
    };
    report.total_notifications = allMethods.length;

    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await fsp.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
