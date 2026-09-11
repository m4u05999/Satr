/**
 * سطر — حارس نتائج أوامر الجوال (OBS-147).
 * يشغّل النواة ومعالجات النقل المستخرجة من مصدر الإنتاج والتعمية الحقيقية.
 * HTTP والتخزين فقط محقونان؛ لا شبكة خارجية ولا ملفات اقتران حقيقية.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const commands = require('../electron/mobilecommands');
const C = require('../electron/mobilecrypto');
const RUN = '1234567890abcdef';
const ID = '0123456789abcdef';
const DEVICE = '1111111111111111';
const OTHER = '2222222222222222';
let checks = 0;
function equal(actual, expected, message) { checks++; assert.deepEqual(actual, expected, message); }
function request(id = ID) { return { type: 'stop', run: RUN, command_id: id }; }

// المصدر هو المعالج نفسه؛ لا نسخة لمنطق الطلب أو الختم أو أولوية الاستقصاء.
function loadFunctions(file, names, context) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const name of names) {
    const marker = 'function ' + name + '(';
    const start = source.indexOf(marker);
    assert(start >= 0, 'missing_source_function:' + name);
    const body = source.indexOf('{', start + marker.length);
    let depth = 0, end = -1;
    for (let i = body; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    assert(end > body, 'bad_source_function:' + name);
    const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
    context[name] = vm.runInNewContext('(' + source.slice(begin, end) + ')', context, { filename: file });
  }
  return context;
}

function channel() {
  const desktop = C.generateKeyPair(), phone = C.generateKeyPair();
  const pairId = '3333333333333333';
  return {
    entry: { session: C.deriveSession({ myPrivate: desktop.privateKey, theirPublic: phone.publicKey, pairId, role: 'desktop' }),
      boxes: { toMobile: '44444444444444444444444444444444' } },
    phone: C.deriveSession({ myPrivate: phone.privateKey, theirPublic: desktop.publicKey, pairId, role: 'mobile' }),
  };
}
function response() {
  return { status: null, body: null, writableEnded: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; this.writableEnded = true; }, on() {} };
}
function harness(kind) {
  const first = channel(), other = channel();
  const entries = new Map([[DEVICE, first.entry], [OTHER, other.entry]]);
  const reports = [], posts = [], reservations = [];
  let clock = 0;
  let allowCounter = true;
  let pendingRecord = null;
  const context = {
    Buffer, JSON, Map, Set, Date, clearTimeout, setTimeout,
    mobilecommands: commands, RUN_TOKEN_RE: commands.RUN_TOKEN_RE,
    MAX_FRAME_BYTES: 65536, SEND_BLOCK: 16, MAX_WAITERS_PER_DEVICE: 4,
    sendCeilings: new Map(), stopped: false, commandResults: new Map(),
    sentStateSeq: new Map(), waiters: new Map(), latestState: null,
    pollTimeoutMs: 100, now: () => clock,
    activeEntry: id => entries.get(id), activeSession: id => entries.get(id),
    safeDeviceId: value => value, baseHeaders: () => ({}), touch() {},
    readBody(req, res, callback) { callback(req.body); },
    sendLatestState: () => false,
    pending: { oldest: () => pendingRecord, resolveDecision: () => false },
    boxUrl: box => 'https://relay.invalid/m/' + box,
    d: { crypto: C, pair: { reserveSend(id) {
      reservations.push(id);
      return allowCounter ? entries.get(id).session.counterSend + 16 : null;
    } }, onStop(run, report) { reports.push({ run, report }); return true; },
      transport: { async post(url, bytes) { posts.push({ url, bytes }); } } },
  };
  context.deps = context.d;
  const names = kind === 'lan'
    ? ['sendJson', 'sendEmpty', 'ensureSendCounter', 'sendFrame', 'removeWaiter',
      'nextCommandResult', 'sendPendingCommandResult', 'queueCommandResult',
      'wakeWaiters', 'handlePoll', 'handleReply']
    : ['ensureSendCounter', 'sendCommandResult', 'requestStop', 'handleDeviceFrame'];
  loadFunctions(kind === 'lan' ? 'electron/mobilelink.js' : 'electron/mobilerelay.js', names, context);
  function send(payload, id = DEVICE, phone = first.phone) {
    const bytes = C.seal(phone, Buffer.from(JSON.stringify(payload)));
    if (kind === 'relay') return context.handleDeviceFrame(id, bytes);
    const res = response();
    context.handleReply({ body: bytes }, res, new URLSearchParams({ device: id }));
    return res.status;
  }
  function poll(id = DEVICE) {
    const res = response();
    context.handlePoll({}, res, new URLSearchParams({ device: id }));
    return res;
  }
  return { context, first, other, entries, reports, posts, reservations, send, poll,
    setNow: value => { clock = value; },
    setCounter: value => { allowCounter = value; context.sendCeilings.clear(); },
    setPending: value => { pendingRecord = value; },
  };
}
function decode(phone, bytes) { return JSON.parse(C.open(phone, bytes).toString('utf8')); }

async function testMobileCommands() {
  checks = 0;
  equal(commands.parseStopRequest(request()), request(), 'طلب الإيقاف ذو المعرّف يُقبل');
  equal(commands.parseStopRequest({ type: 'stop', run: RUN }), { type: 'stop', run: RUN }, 'طلب legacy صالح');
  for (const bad of [null, [], { ...request(), extra: true }, { ...request(), command_id: null },
    { ...request(), command_id: 'ABCDEF0123456789' }, { ...request(), run: 'ABCDEF0123456789' },
    { ...request(), run: 123 }, { ...request(), type: 'allow' }]) {
    equal(commands.parseStopRequest(bad), null, 'الطلب المشوّه يفشل مغلقاً');
  }
  let report;
  const results = [];
  const payload = request();
  equal(commands.dispatchStop(payload, (run, callback) => { report = callback; return true; }, r => results.push(r)), true,
    'قبول المنفذ مزامن');
  equal(results.length, 0, 'قبول الأمر لا يصنع نتيجة توقف');
  payload.run = 'eeeeeeeeeeeeeeee'; payload.command_id = 'ffffffffffffffff';
  report('stopped'); report('unknown');
  equal(results, [{ v: 1, type: 'command_result', command_id: ID, run: RUN, status: 'stopped' }],
    'تقرير واحد بهوية الأمر الأصلية');
  for (const [executor, expected] of [
    [() => false, 'stale_run'], [() => { throw Error('fixture'); }, 'unknown'],
    [(_run, cb) => { cb('stopped'); return false; }, 'stale_run'],
    [(_run, cb) => { cb('bad_status'); return true; }, 'unknown'],
  ]) {
    const output = []; commands.dispatchStop(request(), executor, r => output.push(r));
    equal(output.map(r => r.status), [expected], 'الرفض والاستثناء والتقرير المتزامن محكومة');
  }
  let legacyReport;
  const legacyResults = [];
  commands.dispatchStop({ type: 'stop', run: RUN }, (_run, cb) => { legacyReport = cb; return true; },
    result => legacyResults.push(result));
  equal(legacyReport('stopped'), true, 'طلب legacy ينفذ بلا إطار نتيجة جديد');
  equal(legacyResults.length, 0, 'نواة legacy لا ترسل نتيجة جديدة');

  for (const kind of ['lan', 'relay']) {
    const h = harness(kind);
    equal(h.send(request()), kind === 'lan' ? 200 : true, kind + ': معالج الطلب الفعلي يقبل الأمر');
    equal(h.posts.length + h.context.commandResults.size, 0, kind + ': لا نتيجة قبل تقرير المنفذ');
    equal(h.reports.length, 1, kind + ': المنفذ استُدعي مرة واحدة');
    h.reports[0].report('stopped');
    h.reports[0].report('stopped');
    await Promise.resolve();
    let result;
    if (kind === 'lan') {
      equal(h.context.commandResults.has(OTHER), false, 'LAN: النتيجة لا تصل إلى جهاز آخر');
      h.setPending({ envelope: { envelope_id: 'pending-new' } });
      const polled = h.poll();
      equal(polled.status, 200, 'LAN: الاستقصاء أعاد إطاراً');
      result = decode(h.first.phone, polled.body);
      equal(decode(h.first.phone, h.poll().body).type, 'permission_request', 'LAN: الإذن يبقى بعد استلام النتيجة');
      equal(h.context.commandResults.size, 0, 'LAN: النتيجة تُستهلك مرة واحدة');
    } else {
      equal(h.posts.length, 1, 'relay: تقرير مكرر لا يرسل مرتين');
      equal(h.posts[0].url.endsWith(h.first.entry.boxes.toMobile), true, 'relay: صندوق صاحب الأمر');
      assert.throws(() => C.open(h.other.phone, h.posts[0].bytes)); checks++;
      result = decode(h.first.phone, h.posts[0].bytes);
    }
    equal(result, { v: 1, type: 'command_result', command_id: ID, run: RUN, status: 'stopped' },
      kind + ': النتيجة المغلقة عبرت التعمية الحقيقية');
    equal(h.reservations, [DEVICE], kind + ': الختم مر بحجز عداد الإنتاج');

    const stale = harness(kind); stale.context.d.onStop = () => false;
    stale.send(request()); await Promise.resolve();
    const staleBytes = kind === 'lan' ? stale.poll().body : stale.posts[0].bytes;
    equal(decode(stale.first.phone, staleBytes).status, 'stale_run', kind + ': الرفض يعود للجهاز معمّى');

    const replaced = harness(kind); replaced.send(request());
    replaced.entries.set(DEVICE, channel().entry);
    replaced.reports[0].report('stopped'); await Promise.resolve();
    equal(replaced.posts.length + replaced.context.commandResults.size, 0,
      kind + ': نتيجة اقتران قديم لا تُرسل لاقتران جديد');

    const revoked = harness(kind); revoked.send(request()); revoked.entries.delete(DEVICE);
    revoked.reports[0].report('stopped'); await Promise.resolve();
    equal(revoked.posts.length + revoked.context.commandResults.size, 0,
      kind + ': جهاز مبطل لا يستلم نتيجة متأخرة');

    const blocked = harness(kind); blocked.setCounter(false); blocked.send(request());
    blocked.reports[0].report('stopped'); await Promise.resolve();
    if (kind === 'lan') equal(blocked.poll().status, 500, 'LAN: فشل الحجز يمنع التعمية');
    else equal(blocked.posts.length, 0, 'relay: فشل الحجز يمنع الإرسال');

    const legacy = harness(kind); legacy.send({ type: 'stop', run: RUN });
    legacy.reports[0].report('stopped'); await Promise.resolve();
    equal(legacy.posts.length + legacy.context.commandResults.size, 0, kind + ': legacy بلا نتيجة جديدة');
    const bad = harness(kind); bad.send({ ...request(), command_id: 'bad' });
    equal(bad.reports.length, 0, kind + ': المعرّف المشوّه لا يبلغ المنفذ');
  }

  const queued = harness('lan');
  for (let i = 0; i < 6; i++) {
    queued.send(request(i.toString(16).padStart(16, '0')));
    queued.reports[i].report('stopped');
  }
  equal(queued.context.commandResults.get(DEVICE).length, 4, 'LAN: الطابور لا يتجاوز أربعة');
  equal(decode(queued.first.phone, queued.poll().body).command_id, '0000000000000002', 'LAN: تُحفظ أحدث أربع نتائج');
  queued.setNow(60000);
  equal(queued.context.nextCommandResult(DEVICE, queued.first.entry), null, 'LAN: انتهاء TTL يسقط النتائج');
  equal(queued.context.commandResults.size, 0, 'LAN: تنظف الخانة المنتهية');

  const waiting = harness('lan');
  waiting.send(request());
  const waiter = { res: response(), timer: null };
  waiting.context.waiters.set(DEVICE, new Set([waiter]));
  waiting.setPending({ envelope: { envelope_id: 'pending' } });
  waiting.reports[0].report('stopped');
  equal(decode(waiting.first.phone, waiter.res.body).type, 'command_result', 'LAN: wakeWaiters يقدم النتيجة على الإذن');
  equal(waiting.context.waiters.has(DEVICE), false, 'LAN: ينتزع المنتظر بعد التسليم');
  console.log('mobilecommands: ' + checks + ' checks passed');
}
module.exports = { testMobileCommands };
if (require.main === module) {
  testMobileCommands().catch(error => { console.error(error); process.exitCode = 1; });
}
