'use strict';

/**
 * اختبارات وحدة سجل Kimi keep-alive (K2 — §7.1 من مذكرة التصميم):
 * التسجيل والسرد، سقف عمليتين، خمول 15 دقيقة، killAll بلا أيتام، استئجار القناة،
 * قتل قناة عليها دور نشط، والأحداث المتأخرة المحجوبة/المقصوصة/المجمَّعة.
 */

const assert = require('assert');
const keepaliveFactory = require('../electron/kimi-keepalive');

function fakeProc() {
  return {
    killed: false, exitCode: null, signalCode: null,
    stdin: { end() { this.ended = true; } },
    kill() { this.killed = true; },
  };
}

function fakeRpc() {
  return { calls: [], closed: false,
    notify(method, params) { this.calls.push({ method, params }); },
    close() { this.closed = true; } };
}

function fakeEntry(sessionId, overrides) {
  return {
    sessionId,
    proc: fakeProc(),
    rpc: fakeRpc(),
    shared: { turn: null },
    mcpHost: { stopped: false, async stop() { this.stopped = true; } },
    cwd: 'D:\\proj', model: 'k3', configOptions: [],
    startedAt: 1000, lastActivityAt: 1000,
    ...(overrides || {}),
  };
}

function makeRegistry(extra) {
  return keepaliveFactory.create({
    now: () => 1000000,
    scrub: (value, max) => {
      const text = String(value || '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[secret]');
      return max && text.length > max ? text.slice(0, max) + '…' : text;
    },
    toolText: (content) => (Array.isArray(content) ? content.map((i) => i && i.content && i.content.text || '').join('\n') : ''),
    toolLabel: (title) => title,
    ...(extra || {}),
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function testRegisterAndList() {
  const ka = makeRegistry();
  const snapshots = [];
  ka.setNotifier((list) => snapshots.push(list));
  assert.strictEqual(await ka.register(fakeEntry('sess_a')), true);
  assert.strictEqual(await ka.register(fakeEntry('sess_a')), false, 'التسجيل المكرر مرفوض');
  const list = ka.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'ks_sess_a');
  assert.ok(list[0].command.includes('Kimi Code'));
  assert.ok(snapshots.length >= 1, 'تسجيل قناة يبث تحديث الشريط');
}

async function testMaxLiveEviction() {
  const ka = makeRegistry({ now: () => 1000000 });
  await ka.register(fakeEntry('sess_old', { lastActivityAt: 100 }));
  await ka.register(fakeEntry('sess_new', { lastActivityAt: 200 }));
  assert.strictEqual(ka.list().length, 2, 'سقف عمليتين لا يُكسر بالتسجيل الثاني');
  assert.strictEqual(await ka.register(fakeEntry('sess_third', { lastActivityAt: 300 })), true);
  const ids = ka.list().map((item) => item.id);
  assert.ok(!ids.includes('ks_sess_old'), 'الأقدم خمولاً يُطرد عند الجلسة الثالثة');
  assert.ok(ids.includes('ks_sess_new') && ids.includes('ks_sess_third'));
}

async function testMaxLiveBusyFallback() {
  const ka = makeRegistry();
  await ka.register(fakeEntry('sess_busy1', { shared: { turn: { emit() {} } } }));
  await ka.register(fakeEntry('sess_busy2', { shared: { turn: { emit() {} } } }));
  // كل القنوات عليها أدوار نشطة ⇒ التسجيل يُرفض والدور يسقط إلى «عملية لكل دور»
  assert.strictEqual(await ka.register(fakeEntry('sess_third')), false);
  assert.strictEqual(ka.list().length, 2);
}

async function testIdlePrune() {
  let clock = 1000000;
  const ka = makeRegistry({ now: () => clock, idleMs: 15 * 60 * 1000 });
  await ka.register(fakeEntry('sess_idle', { lastActivityAt: clock }));
  await ka.register(fakeEntry('sess_busy', { lastActivityAt: clock, shared: { turn: { emit() {} } } }));
  clock += 16 * 60 * 1000; // 16 دقيقة
  const pruned = await ka.prune();
  assert.strictEqual(pruned, 1, 'القناة الخاملة وحدها تُقتل');
  const ids = ka.list().map((item) => item.id);
  assert.ok(!ids.includes('ks_sess_idle'));
  assert.ok(ids.includes('ks_sess_busy'), 'قناة عليها دور نشط لا تُقتل بالخمول');
}

async function testAcquire() {
  const ka = makeRegistry();
  const entry = fakeEntry('sess_a');
  await ka.register(entry);
  const before = entry.lastActivityAt;
  const acquired = ka.acquire('sess_a');
  assert.strictEqual(acquired, entry, 'الاستئجار يعيد القناة نفسها');
  assert.ok(entry.lastActivityAt >= before, 'الاستئجار يحدّث lastActivityAt');
  entry.shared.turn = { emit() {} };
  assert.strictEqual(ka.acquire('sess_a'), null, 'لا استئجار مزدوج لقناة عليها دور نشط');
  entry.shared.turn = null;
  entry.proc.killed = true;
  assert.strictEqual(ka.acquire('sess_a'), null, 'قناة ميتة تُزال ولا تُستأجر');
  assert.strictEqual(ka.list().length, 0);
}

async function testKillWithActiveTurn() {
  const ka = makeRegistry();
  const entry = fakeEntry('sess_a');
  const host = entry.mcpHost;
  let aborted = false;
  entry.shared.turn = { emit() {}, async abortTurn() { aborted = true; } };
  await ka.register(entry);
  const result = await ka.kill('sess_a');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(aborted, true, 'الدور النشط يُلغى قبل تدمير القناة');
  assert.ok(entry.rpc.calls.some((c) => c.method === 'session/cancel'), 'session/cancel يُرسل عند القتل');
  assert.strictEqual(entry.rpc.closed, true);
  assert.strictEqual(host.stopped, true);
  assert.strictEqual(ka.list().length, 0);
  await wait(350);
  assert.strictEqual(entry.proc.killed, true, 'العملية تُقتل بعد الإغلاق اللطيف');
}

async function testKillAll() {
  const ka = makeRegistry();
  const a = fakeEntry('sess_a');
  const b = fakeEntry('sess_b');
  await ka.register(a);
  await ka.register(b);
  await ka.killAll();
  assert.strictEqual(ka.list().length, 0);
  assert.strictEqual(a.rpc.closed, true);
  assert.strictEqual(b.rpc.closed, true);
  assert.ok(a.rpc.calls.some((c) => c.method === 'session/cancel'));
  await wait(350);
  assert.strictEqual(a.proc.killed, true);
  assert.strictEqual(b.proc.killed, true);
}

async function testRemove() {
  const ka = makeRegistry();
  await ka.register(fakeEntry('sess_a'));
  assert.strictEqual(ka.remove('sess_a'), true, 'معالج exit يزيل المدخل');
  assert.strictEqual(ka.remove('sess_a'), false);
  assert.strictEqual(ka.list().length, 0);
}

async function testLateEventsScrubbedAndTruncated() {
  const ka = makeRegistry();
  const events = [];
  ka.setLateEventSink((evt) => events.push(evt));
  const entry = fakeEntry('sess_a');
  await ka.register(entry);

  // رسالة مجزّأة تحمل سراً: تُجمَّع وتُحجب قبل البث
  ka.handleLateNotification(entry, 'session/update', { sessionId: 'sess_a', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'm1',
    content: { type: 'text', text: 'الجزء الأول sk-live-1234567890abcdef ' },
  } });
  ka.handleLateNotification(entry, 'session/update', { sessionId: 'sess_a', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'm1',
    content: { type: 'text', text: 'والجزء الثاني' },
  } });
  await wait(1000);
  const messages = events.filter((e) => e.kind === 'message');
  assert.strictEqual(messages.length, 1, 'الأجزاء تُجمَّع في حدث واحد');
  assert.ok(messages[0].text.includes('الجزء الأول') && messages[0].text.includes('والجزء الثاني'));
  assert.ok(!messages[0].text.includes('sk-live'), 'السر محجوب');
  assert.ok(messages[0].text.includes('[secret]'));
  assert.strictEqual(messages[0].sessionId, 'sess_a');
  assert.ok(Number.isFinite(messages[0].at));

  // أداة مكتملة: نص النتيجة يُقص عند سقف الحدث المتأخر
  const longText = 'س'.repeat(6000);
  ka.handleLateNotification(entry, 'session/update', { sessionId: 'sess_a', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', title: 'Bash',
    content: [{ type: 'content', content: { type: 'text', text: longText } }],
  } });
  const tools = events.filter((e) => e.kind === 'tool');
  assert.strictEqual(tools.length, 1);
  assert.ok(tools[0].text.length <= 4001, 'نص الأداة مقصوص عند سقف 4000');
  assert.strictEqual(tools[0].tool, 'Bash');
  assert.strictEqual(tools[0].status, 'completed');

  // تحديث أداة غير مكتمل لا يبث إشعاراً
  ka.handleLateNotification(entry, 'session/update', { sessionId: 'sess_a', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'in_progress', title: 'Bash',
  } });
  assert.strictEqual(events.filter((e) => e.kind === 'tool').length, 1);

  // تحديثات usage/commands لا تُترجم إشعارات
  assert.strictEqual(ka.handleLateNotification(entry, 'session/update', { sessionId: 'sess_a', update: { sessionUpdate: 'usage_update' } }), false);

  // نص طويل جداً في رسالة: يُقص أيضاً
  ka.handleLateNotification(entry, 'session/update', { sessionId: 'sess_a', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'm2',
    content: { type: 'text', text: 'ط'.repeat(6000) },
  } });
  await wait(1000);
  const long = events.filter((e) => e.kind === 'message' && e.text.includes('ط'));
  assert.strictEqual(long.length, 1);
  assert.ok(long[0].text.length <= 4001 && long[0].text.endsWith('…'));
}

(async () => {
  await testRegisterAndList();
  await testMaxLiveEviction();
  await testMaxLiveBusyFallback();
  await testIdlePrune();
  await testAcquire();
  await testKillWithActiveTurn();
  await testKillAll();
  await testRemove();
  await testLateEventsScrubbedAndTruncated();
  console.log('✓ سجل keep-alive: تسجيل وسرد وبث تحديث الشريط');
  console.log('✓ سقف عمليتين حيتين: الأقدم خمولاً يُطرد، والامتلاء بأدوار نشطة يرفض بسقوط رشيق');
  console.log('✓ خمول 15 دقيقة يقتل القنوات الخاملة ويستثني الأدوار النشطة');
  console.log('✓ الاستئجار يعيد القناة نفسها ويرفض المزدوج والميت');
  console.log('✓ القتل يلغي الدور النشط أولاً ثم session/cancel والإغلاق الكامل');
  console.log('✓ killAll لا يترك عمليات يتيمة (rpc مغلقة وproc مقتولة)');
  console.log('✓ الأحداث المتأخرة تُجمَّع وتُحجب أسرارها وتُقص عند 4000 قبل البث');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
