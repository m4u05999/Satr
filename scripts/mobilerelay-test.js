/**
 * سطر — حارس عميل الوسيط (م2 — §7).
 *
 * يشغّل **الوحدات الحقيقية** بلا محاكاة تعمية: `mobilerelay` + `mobilecrypto` +
 * `mobilepair` + `mobileenvelope`، فوق خادم HTTP حقيقي يطابق عقد الوسيط (§7.4).
 * لا يستورد كود الوسيط الخاص — يعيد بناء سطحه المعلن كي يبقى المستودع المفتوح
 * قابلاً للاختبار وحده.
 *
 * التشغيل: node scripts/mobilerelay-test.js
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mobilecrypto = require('../electron/mobilecrypto');
const mobileenvelope = require('../electron/mobileenvelope');
const mobilestate = require('../electron/mobilestate');
const mobilepair = require('../electron/mobilepair');
const mobilelink = require('../electron/mobilelink');
const mobiletls = require('../electron/mobiletls');
const mobilerelay = require('../electron/mobilerelay');

const tempRoot = path.join(os.tmpdir(), 'satr-relay-client-' + process.pid + '-' + Date.now());
const appRoot = path.resolve(__dirname, '..');
const tlsMaterial = mobiletls.ensureCert('127.0.0.1');
let checks = 0;

function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  checks += 1;
  if (actual !== expected) throw new Error(message + ' — expected ' + expected + ', got ' + actual);
}

/** يستخرج دالة من مصدر main.js ويشغّلها بصندوق محقون (نمط mobile-integration-test). */
function sourceFunction(source, name, context) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('missing_source_function:' + name);
  const bodyStart = source.indexOf('{', start + marker.length);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error('bad_source_function:' + name);
  let sliceStart = start;
  if (start >= 6 && source.slice(start - 6, start) === 'async ') sliceStart = start - 6;
  return vm.runInNewContext('(' + source.slice(sliceStart, end) + ')', context, { filename: 'electron/main.js' });
}

/** يحمّل `pwa/crypto.js` الحقيقي بـWebCrypto — منطق الهاتف نفسه لا نسخة موازية. */
function loadPwaCrypto() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'crypto.js'), 'utf8');
  const webcrypto = crypto.webcrypto;
  const sandbox = {
    window: { crypto: webcrypto }, crypto: webcrypto,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, atob, btoa, DOMException,
  };
  vm.runInNewContext(source, sandbox, { filename: 'pwa/crypto.js' });
  return sandbox.window.SatrCrypto;
}

/** وسيط أعمى مصغّر يطابق §7.4 — لا يفسّر شيئاً. */
function startFakeRelay() {
  const boxes = new Map(); // box -> Buffer[]
  const waiters = new Map(); // box -> [res]
  const seen = new Set(); // كل صندوق لمسه أحد (لفحص العزل الاتجاهي)

  const server = http.createServer((req, res) => {
    const match = /^\/m\/([a-f0-9]{32})$/.exec(req.url || '');
    if (!match) { res.writeHead(400); res.end(); return; }
    const box = match[1];
    seen.add(box);
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const frame = Buffer.concat(chunks);
        const queue = waiters.get(box);
        if (queue && queue.length) {
          const waiting = queue.shift();
          waiting.writeHead(200, { 'content-type': 'application/octet-stream' });
          waiting.end(frame);
        } else {
          if (!boxes.has(box)) boxes.set(box, []);
          boxes.get(box).push(frame);
        }
        res.writeHead(202); res.end();
      });
      return;
    }
    if (req.method === 'GET') {
      const queue = boxes.get(box);
      if (queue && queue.length) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(queue.shift());
        return;
      }
      if (!waiters.has(box)) waiters.set(box, []);
      waiters.get(box).push(res);
      res.on('close', () => {
        const list = waiters.get(box) || [];
        const index = list.indexOf(res);
        if (index !== -1) list.splice(index, 1);
      });
      return;
    }
    res.writeHead(400); res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen,
        boxes,
        stop: () => new Promise((done) => {
          for (const list of waiters.values()) for (const res of list) { try { res.end(); } catch {} }
          server.close(() => done());
        }),
      });
    });
  });
}

/** ناقل HTTP بسيط للعميل — العقد المعلن في mobilerelay.start. */
const transport = {
  post(url, bytes) {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.end(bytes);
    });
  },
  poll(url, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'GET' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs + 5000, () => req.destroy(new Error('timeout')));
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      req.end();
    });
  },
};

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try { value = predicate(); } catch { value = null; }
      if (value) { resolve(value); return; }
      if (Date.now() > deadline) { reject(new Error('timeout: ' + label)); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localRequest(port, method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path: urlPath,
      ca: tlsMaterial.cert, rejectUnauthorized: true,
      headers: body ? {
        'content-type': contentType || 'application/octet-stream',
        'content-length': body.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function pairLocal(store, link, identity) {
  const payload = store.buildPairingPayload();
  const keys = mobilecrypto.generateKeyPair();
  const mobile = { deviceId: crypto.randomBytes(8).toString('hex'), keys, session: null };
  const body = Buffer.from(JSON.stringify({
    pairId: payload.pairId,
    secretProof: payload.secret,
    mobilePublic: keys.publicKey,
    deviceId: mobile.deviceId,
    label: 'هاتف الحالة',
  }), 'utf8');
  const response = await localRequest(link.port, 'POST', '/pair', body, 'application/json');
  equal(response.status, 200, 'القناة المحلية: الاقتران نجح');
  mobile.session = mobilecrypto.deriveSession({
    myPrivate: keys.privateKey,
    theirPublic: identity.publicKey,
    pairId: payload.pairId,
    role: 'mobile',
  });
  return mobile;
}

function localPoll(link, mobile) {
  return localRequest(link.port, 'GET', '/poll?device=' + encodeURIComponent(mobile.deviceId));
}

function localUplink(link, mobile, payload) {
  const frame = mobilecrypto.seal(mobile.session, Buffer.from(JSON.stringify(payload), 'utf8'));
  return localRequest(link.port, 'POST', '/reply?device=' + encodeURIComponent(mobile.deviceId), frame);
}

function openLocal(mobile, response) {
  equal(response.status, 200, 'إطار محلي هابط ناجح');
  return JSON.parse(mobilecrypto.open(mobile.session, response.body).toString('utf8'));
}

function sampleState(seq, overrides) {
  return mobilestate.buildState({
    phase: 'working', project: 'مشروع سطر', task: 'تنفيذ قناة الحالة',
    tasks: { total: 5, pending: 1, in_progress: 1, completed: 2, blocked: 1 },
    edits: { files: 2, added: 7, removed: 3 }, cost_usd: 0.123456, verify: '',
    ...(overrides || {}),
  }, { boot: 'a1b2c3d4', seq, run: 'b7c8d9e0f1a2b3c4' });
}

async function testLocalStateChannel() {
  const identity = mobilecrypto.generateKeyPair();
  const storeFile = path.join(tempRoot, 'local-devices.json');
  fs.writeFileSync(storeFile, JSON.stringify({ identity, devices: [] }), 'utf8');
  const store = mobilepair.createStore({ file: storeFile });
  let clock = 10000;
  let stateRequestCalls = 0;
  let stateRequestSeq = 20;
  let link = null;
  link = await mobilelink.start({
    crypto: mobilecrypto, pair: store, envelope: mobileenvelope, identity,
    app: { getAppPath: () => appRoot },
    onStateRequest: () => {
      stateRequestCalls += 1;
      stateRequestSeq += 1;
      return link.publishState(sampleState(stateRequestSeq));
    },
  }, { host: '127.0.0.1', port: 0, pollTimeoutMs: 500, now: () => clock });
  try {
    const mobile = await pairLocal(store, link, identity);
    equal(typeof link.publishState, 'function', 'العقد المحلي يكشف publishState');

    // منتظر موجود: نشر اللقطة يجب أن يوقظه (عضّة حذف wakeWaiters تسقط هنا).
    const waitingPoll = localPoll(link, mobile);
    await sleep(40);
    equal(link.publishState(sampleState(1)), true, 'النشر المحلي مع منتظر قُبل');
    const waited = openLocal(mobile, await waitingPoll);
    equal(waited.type, 'state', 'المنتظر استلم لقطة الحالة');
    equal(waited.state.seq, 1, 'المنتظر استلم seq المنشورة');

    // بلا منتظر: الخانة الواحدة تحتفظ بالأحدث حتى الاستقصاء التالي.
    equal(link.publishState(sampleState(2)), true, 'النشر المحلي بلا منتظر قُبل');
    const stored = openLocal(mobile, await localPoll(link, mobile));
    equal(stored.type, 'state', 'اللقطة المخزنة وصلت بلا منتظر سابق');
    equal(stored.state.seq, 2, 'الخانة تحمل الأحدث لا طابوراً قديماً');

    // إن اجتمعت لقطة غير مرسلة وظرف، الإذن يسبق الحالة دائماً.
    link.publishState(sampleState(3));
    const permissionId = 'toolu_local_state_priority';
    const pending = link.offerPermission({
      id: permissionId, tool: 'Bash', input: { command: 'npm test' },
      cwd: tempRoot, engine: 'sdk', session_id: 'state-local',
    }, { ttlMs: 30000, run: 'b7c8d9e0f1a2b3c4' });
    const priority = openLocal(mobile, await localPoll(link, mobile));
    equal(priority.type, 'permission_request', 'الإذن له الأولوية على لقطة أحدث');
    link.withdraw(permissionId);
    equal(await pending, null, 'سحب ظرف الأولوية بلا قرار');
    const afterPermission = openLocal(mobile, await localPoll(link, mobile));
    equal(afterPermission.type, 'state', 'الحالة تبقى متاحة بعد سحب الإذن');
    equal(afterPermission.state.seq, 3, 'وصلت لقطة الأولوية الصحيحة');

    // state_request نوع مستقل بمفتاح وحيد وخنق لكل جهاز.
    const firstRequest = await localUplink(link, mobile, { type: 'state_request' });
    equal(firstRequest.status, 200, 'طلب الحالة الأول مقبول محلياً');
    equal(stateRequestCalls, 1, 'طلب الحالة الأول أُجيب مرة');
    const throttled = await localUplink(link, mobile, { type: 'state_request' });
    equal(throttled.status, 200, 'الطلب المخنوق لا يكشف خطأً');
    equal(stateRequestCalls, 1, 'طلب ثانٍ خلال ثانيتين لم يُجب');
    clock += mobilestate.STATE_REQUEST_MIN_INTERVAL_MS;
    await localUplink(link, mobile, { type: 'state_request' });
    equal(stateRequestCalls, 2, 'طلب بعد نافذة الخنق أُجيب');
    const extraKey = await localUplink(link, mobile, { type: 'state_request', extra: true });
    equal(extraKey.status, 400, 'state_request بحقل ثانٍ مرفوض محلياً');
    equal(stateRequestCalls, 2, 'الطلب المشوّه لم يبلغ main');

    const guardId = 'toolu_local_state_decision';
    const guarded = link.offerPermission({
      id: guardId, tool: 'Bash', input: { command: 'echo guard' },
      cwd: tempRoot, engine: 'sdk', session_id: 'state-local',
    }, { ttlMs: 30000 });
    const badDecision = await localUplink(link, mobile, {
      envelope_id: guardId, decision: 'state_request',
    });
    equal(badDecision.status, 400, 'state_request كقرار يُرفض bad_decision');
    equal(JSON.parse(badDecision.body.toString('utf8')).error, 'bad_decision', 'رمز الرفض صريح');
    link.withdraw(guardId);
    equal(await guarded, null, 'القرار المرفوض لم يحسم الظرف');
  } finally {
    await link.stop();
  }
}

async function run() {
  fs.mkdirSync(tempRoot, { recursive: true });

  // ── وحدة اللقطة النقية: القائمة المغلقة والسقوف والتنقية (§7.7.6/أ) ──────
  const longText = 'ن'.repeat(220);
  const built = mobilestate.buildState({
    phase: 'working', project: longText, task: longText,
    tasks: { total: 5000, pending: -2, in_progress: 1.9, completed: 4, blocked: Infinity },
    edits: { files: 3.8, added: -1, removed: 9 },
    cost_usd: 1.234567,
    verify: 'pass',
    prompt: 'LEAK_PROMPT_X', cwd: 'C:\\secret\\project', session_id: 'LEAK_SESSION_X',
    engine: 'LEAK_ENGINE_X', filename: 'secret-file.txt', thirteenth: 'LEAK_EXTRA_X',
  }, { boot: 'A1B2C3D4', seq: 7, run: 'B7C8D9E0F1A2B3C4' });
  equal(Object.keys(built).join(','), mobilestate.STATE_KEYS.join(','), 'قائمة حقول الحالة مغلقة حرفياً');
  equal(built.boot, 'a1b2c3d4', 'boot ثمانية hex مطبّعة');
  equal(built.seq, 7, 'seq صحيح موجب');
  equal(built.ttl_ms, 60000, 'TTL ثابت دقيقة');
  equal(built.run, 'b7c8d9e0f1a2b3c4', 'رمز الدور نفسه منقّى');
  equal(Array.from(built.project).length, 160, 'project مقصوص عند 160 نقطة Unicode');
  equal(Array.from(built.task).length, 160, 'task مقصوص عند 160 نقطة Unicode');
  assert(built.project.endsWith('…') && built.task.endsWith('…'), 'القص يضيف نقاط Unicode');
  equal(built.tasks.total, 999, 'عداد المهام مقيد إلى 999');
  equal(built.tasks.pending, 0, 'عداد سالب يصير صفراً');
  equal(built.tasks.in_progress, 1, 'عداد كسري يُنزّل إلى صحيح');
  equal(built.tasks.blocked, 0, 'عداد غير منتهٍ يصير صفراً');
  equal(built.edits.files, 3, 'عداد الملفات صحيح غير سالب');
  equal(built.cost_usd, 1.2346, 'الكلفة مقربة أربع منازل');
  equal(built.verify, 'pass', 'قيمة التحقق من القائمة المغلقة');
  const secretTask = mobilestate.buildState({
    phase: 'working', task: 'نشر sk-123456789012 مع المهمة',
    tasks: { total: 1, in_progress: 1 },
  }, { boot: 'a1b2c3d4', seq: 8, run: 'b7c8d9e0f1a2b3c4' });
  equal(secretTask.task, '', 'تغيير scrubSecrets يسقط عنوان المهمة كله');
  equal(secretTask.tasks.total, 1, 'إسقاط العنوان لا يسقط عدد المهام');
  equal(secretTask.phase, 'working', 'إسقاط العنوان لا يسقط الحالة');
  const serializedState = JSON.stringify({ v: 1, type: 'state', state: built });
  assert(Buffer.byteLength(serializedState, 'utf8') <= mobilestate.MAX_STATE_FRAME_BYTES,
    'إطار الحالة دون 2KiB قبل الختم');
  const worstFrame = JSON.stringify({
    v: 1,
    type: 'state',
    state: mobilestate.buildState({
      phase: 'waiting_permission', project: '😀'.repeat(220), task: '🧪'.repeat(220),
      tasks: { total: 999, pending: 999, in_progress: 999, completed: 999, blocked: 999 },
      edits: { files: Number.MAX_SAFE_INTEGER, added: Number.MAX_SAFE_INTEGER, removed: Number.MAX_SAFE_INTEGER },
      cost_usd: Number.MAX_VALUE, verify: 'fail',
    }, { boot: 'ffffffff', seq: Number.MAX_SAFE_INTEGER, run: 'ffffffffffffffff' }),
  });
  assert(Buffer.byteLength(worstFrame, 'utf8') <= mobilestate.MAX_STATE_FRAME_BYTES,
    'أسوأ لقطة مسموحة تبقى دون 2KiB قبل الختم');
  for (const forbidden of [
    'LEAK_PROMPT_X', 'C:\\secret\\project', 'secret-file.txt', 'LEAK_SESSION_X',
    'LEAK_ENGINE_X', 'LEAK_EXTRA_X', '"cwd"', '"session_id"', '"engine"', '"filename"', '"thirteenth"',
  ]) assert(!serializedState.includes(forbidden), 'الإطار المسلسل يخلو من الممنوع: ' + forbidden);

  const identity = mobilecrypto.generateKeyPair();
  const storeFile = path.join(tempRoot, 'devices.json');
  fs.writeFileSync(storeFile, JSON.stringify({ identity, devices: [] }), 'utf8');
  const store = mobilepair.createStore({ file: storeFile });
  const relay = await startFakeRelay();

  // ── اشتقاق الصناديق (نقي) ────────────────────────────────────────────────
  const shared = crypto.randomBytes(32);
  const a = mobilerelay.channelBoxes(shared, 'pair-1');
  const b = mobilerelay.channelBoxes(shared, 'pair-1');
  equal(a.toMobile, b.toMobile, 'الاشتقاق حتمي: الطرفان يصلان المعرّف نفسه');
  assert(/^[a-f0-9]{32}$/.test(a.toMobile), 'صندوق D2M يطابق عقد §7.4');
  assert(/^[a-f0-9]{32}$/.test(a.toDesktop), 'صندوق M2D يطابق عقد §7.4');
  assert(a.toMobile !== a.toDesktop, 'الاتجاهان صندوقان مختلفان (لا يبتلع المرسِل رسالته)');
  const other = mobilerelay.channelBoxes(shared, 'pair-2');
  assert(other.toMobile !== a.toMobile, 'pairId مختلف ⇒ قناة مختلفة');
  const pairBox = mobilerelay.pairBoxId('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert(/^[a-f0-9]{32}$/.test(pairBox), 'صندوق الاقتران يطابق العقد');
  assert(!pairBox.includes('a1b2c3d4'), 'pairId الخام لا يظهر في معرّف الصندوق');

  // ── تشغيل العميل ─────────────────────────────────────────────────────────
  // رمز الدور المعتم ومقبض الإيقاف كما يحقنهما main.js (§7.7.5)
  const CURRENT_RUN = 'b7c8d9e0f1a2b3c4';
  const stopCalls = [];
  let relayNow = 20000;
  let relayStateRequests = 0;
  let relayStateSeq = 30;
  let client = null;
  client = mobilerelay.start({
    crypto: mobilecrypto, pair: store, envelope: mobileenvelope, transport, identity,
    onStop: (run) => { stopCalls.push(run); return run === CURRENT_RUN; },
    onStateRequest: () => {
      relayStateRequests += 1;
      relayStateSeq += 1;
      return client.publishState(sampleState(relayStateSeq));
    },
  }, { relayUrl: relay.url, pollTimeoutMs: 800, now: () => relayNow });

  try {
    equal(typeof client.offerPermission, 'function', 'العقد نفسه: offerPermission');
    equal(typeof client.publishState, 'function', 'العقد نفسه: publishState');
    equal(typeof client.withdraw, 'function', 'العقد نفسه: withdraw');
    equal(client.status().running, true, 'العميل يعمل');

    // ── الاقتران المعمّى عبر الوسيط (§7.2) ─────────────────────────────────
    const payload = store.buildPairingPayload();
    client.awaitPairing(payload.pairId);

    const mobileKeys = mobilecrypto.generateKeyPair();
    const deviceId = crypto.randomBytes(8).toString('hex');
    const sealedPair = mobilecrypto.sealPairing({
      mobilePrivate: mobileKeys.privateKey,
      mobilePublic: mobileKeys.publicKey,
      desktopPublic: identity.publicKey,
      pairId: payload.pairId,
      payload: { secretProof: payload.secret, deviceId, label: 'جوالي' },
    });
    // الوسيط ينقل بايتات معتمة: لا يرى السرّ
    assert(!sealedPair.toString('latin1').includes(payload.secret),
      'السرّ لا يظهر فيما ينقله الوسيط');
    await transport.post(relay.url + '/m/' + mobilerelay.pairBoxId(payload.pairId), sealedPair);

    const paired = await waitFor(
      () => store.listDevices().find((item) => item.deviceId === deviceId && !item.revoked),
      4000, 'اكتمال الاقتران'
    );
    equal(paired.label, 'جوالي', 'الوسم وصل عبر الاقتران المعمّى');
    equal(client.status().deviceCount, 1, 'الجهاز صار مقترناً');

    // جلسة الجوال المقابلة + صناديقه (يشتقّها بنفسه)
    const mobileSession = mobilecrypto.deriveSession({
      myPrivate: mobileKeys.privateKey, theirPublic: identity.publicKey,
      pairId: payload.pairId, role: 'mobile',
    });
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(mobileKeys.privateKey, 'base64url'));
    const mobileShared = ecdh.computeSecret(Buffer.from(identity.publicKey, 'base64url'));
    const mobileBoxes = mobilerelay.channelBoxes(mobileShared, payload.pairId);

    // ── إقرار الاقتران: إشارة النجاح الوحيدة عبر وسيط ──────────────────────
    const ackFrame = await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'وصول إقرار الاقتران');
    const ack = JSON.parse(mobilecrypto.open(mobileSession, ackFrame).toString('utf8'));
    equal(ack.type, 'paired', 'الإقرار من نوع paired');
    assert(/^\d{6}$/.test(ack.sas), 'الإقرار يحمل SAS من ست خانات');
    equal(ack.sas, mobilecrypto.sas({
      desktopPublic: identity.publicKey, mobilePublic: mobileKeys.publicKey, pairId: payload.pairId,
    }), 'SAS يطابق ما يحسبه الهاتف من قيم عامة');
    assert(!JSON.stringify(ack).includes(payload.secret), 'الإقرار لا يحمل سرّ الاقتران');

    // ── دفع الحالة عبر الوسيط بلا طلب معلّق ────────────────────────────────
    equal(client.publishState(sampleState(10)), true, 'pushState قُبل عبر الوسيط');
    const stateFrame = await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'وصول لقطة الحالة عبر الوسيط');
    const openedState = JSON.parse(mobilecrypto.open(mobileSession, stateFrame).toString('utf8'));
    equal(openedState.type, 'state', 'الوسيط حمل إطار state');
    equal(openedState.state.seq, 10, 'الوسيط حمل اللقطة المطلوبة');
    equal(Object.keys(openedState.state).join(','), mobilestate.STATE_KEYS.join(','),
      'لقطة الوسيط بقيت بالقائمة المغلقة');
    assert(Buffer.byteLength(JSON.stringify(openedState), 'utf8') <= mobilestate.MAX_STATE_FRAME_BYTES,
      'لقطة الوسيط تحت سقف 2KiB قبل الختم');

    const postUplink = (value) => transport.post(relay.url + '/m/' + mobileBoxes.toDesktop,
      mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify(value), 'utf8')));
    await postUplink({ type: 'state_request' });
    await waitFor(() => relayStateRequests === 1, 4000, 'بلوغ طلب الحالة الأول عبر الوسيط');
    const requestedFrame = await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'جواب طلب الحالة عبر الوسيط');
    const requestedState = JSON.parse(mobilecrypto.open(mobileSession, requestedFrame).toString('utf8'));
    equal(requestedState.type, 'state', 'طلب الحالة أعاد لقطة عبر الوسيط');
    equal(requestedState.state.seq, 31, 'طلب الحالة أعاد seq جديدة');
    await postUplink({ type: 'state_request' });
    await sleep(150);
    equal(relayStateRequests, 1, 'الوسيط خنق طلباً ثانياً خلال ثانيتين');
    equal((relay.boxes.get(mobileBoxes.toMobile) || []).length, 0, 'الطلب المخنوق لم يستهلك ختم جواب');
    relayNow += mobilestate.STATE_REQUEST_MIN_INTERVAL_MS;
    await postUplink({ type: 'state_request' });
    await waitFor(() => relayStateRequests === 2, 4000, 'طلب الوسيط بعد نافذة الخنق');
    const refreshedFrame = await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'جواب المزامنة الثاني');
    const refreshedState = JSON.parse(mobilecrypto.open(mobileSession, refreshedFrame).toString('utf8'));
    equal(refreshedState.state.seq, 32, 'المزامنة التالية تحمل seq جديدة');
    await postUplink({ type: 'state_request', extra: true });
    await sleep(100);
    equal(relayStateRequests, 2, 'state_request بحقل ثانٍ مرفوض عبر الوسيط');

    // ── دورة القرار الكاملة عبر الوسيط ─────────────────────────────────────
    for (const decision of ['allow', 'allow_turn', 'deny']) {
      const envelopeId = 'toolu_relay_' + decision;
      const settled = client.offerPermission({
        id: envelopeId, tool: 'Bash', input: { command: 'echo ' + decision },
        cwd: tempRoot, engine: 'sdk', session_id: 'relay-test',
      }, { ttlMs: 30000 });

      const frame = await waitFor(() => {
        const queue = relay.boxes.get(mobileBoxes.toMobile);
        return queue && queue.length ? queue.shift() : null;
      }, 4000, 'وصول الظرف إلى صندوق الجوال: ' + decision);

      const opened = JSON.parse(mobilecrypto.open(mobileSession, frame).toString('utf8'));
      equal(opened.type, 'permission_request', decision + ': نوع الإطار');
      equal(opened.envelope.envelope_id, envelopeId, decision + ': الظرف الصحيح');
      assert(!JSON.stringify(opened).includes(identity.privateKey), decision + ': لا مفتاح خاص');

      const reply = mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({
        envelope_id: envelopeId, decision,
      }), 'utf8'));
      await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop, reply);
      equal(await settled, decision, decision + ': القرار حُسم عبر الوسيط');
    }

    // ── الإيقاف عبر الوسيط: نوع رسالة مستقل لا قرار رابع (§7.7.5) ──────────
    const stopId = 'toolu_relay_stop';
    const stopPending = client.offerPermission({
      id: stopId, tool: 'Bash', input: { command: 'sleep 1' },
      cwd: tempRoot, engine: 'sdk', session_id: 'relay-test',
    }, { ttlMs: 30000, run: CURRENT_RUN });
    const stopFrame = await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'وصول ظرف الإيقاف');
    const stopOpened = JSON.parse(mobilecrypto.open(mobileSession, stopFrame).toString('utf8'));
    equal(stopOpened.envelope.run, CURRENT_RUN, 'رمز الدور المعتم عبر الوسيط');

    await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop,
      mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({ type: 'stop', run: CURRENT_RUN }), 'utf8')));
    await waitFor(() => (stopCalls.length === 1 ? true : null), 4000, 'بلوغ أمر الإيقاف سطح المكتب');
    equal(stopCalls[0], CURRENT_RUN, 'وصل رمز الدور الصحيح عبر الوسيط');

    // رمز قديم يُرفض، ومشوّه لا يبلغ سطح المكتب أصلاً
    await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop,
      mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({ type: 'stop', run: 'ffffffffffffffff' }), 'utf8')));
    await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop,
      mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({ type: 'stop', run: 'bad' }), 'utf8')));
    await waitFor(() => (stopCalls.length === 2 ? true : null), 4000, 'الرمز القديم بلغ المكتب ورُفض');
    await new Promise((r) => setTimeout(r, 300));
    equal(stopCalls.length, 2, 'الرمز المشوّه لم يبلغ سطح المكتب');
    equal(stopPending instanceof Promise, true, 'الظرف بقي معلّقاً — الإيقاف ليس قراراً عليه');
    client.withdraw(stopId);
    equal(await stopPending, null, 'الظرف سُحب بلا قرار');

    // ── حارس الموافقة القديمة ──────────────────────────────────────────────
    const staleId = 'toolu_relay_stale';
    const stalePending = client.offerPermission({
      id: staleId, tool: 'Bash', input: { command: 'echo stale' },
      cwd: tempRoot, engine: 'sdk', session_id: 'relay-test',
    }, { ttlMs: 30000 });
    await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'ظرف الحارس');
    equal(client.withdraw(staleId), true, 'سطح المكتب سحب أولاً');
    equal(await stalePending, null, 'السحب يحسم بلا قرار');
    const lateReply = mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({
      envelope_id: staleId, decision: 'allow',
    }), 'utf8'));
    await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop, lateReply);
    await new Promise((r) => setTimeout(r, 200));
    assert(true, 'موافقة متأخرة على ظرف مسحوب لا تُطبَّق');

    // ── العزل الاتجاهي: ما يكتبه سطح المكتب لا يقرؤه سطح المكتب ────────────
    assert(relay.seen.has(mobileBoxes.toMobile), 'صندوق D2M استُعمل');
    assert(relay.seen.has(mobileBoxes.toDesktop), 'صندوق M2D استُعمل');

    // ── الحدّ الذهبي: القرارات قائمة مغلقة ─────────────────────────────────
    const guardId = 'toolu_relay_guard';
    const guarded = client.offerPermission({
      id: guardId, tool: 'Bash', input: { command: 'echo guard' },
      cwd: tempRoot, engine: 'sdk', session_id: 'relay-test',
    }, { ttlMs: 1500 });
    await waitFor(() => {
      const queue = relay.boxes.get(mobileBoxes.toMobile);
      return queue && queue.length ? queue.shift() : null;
    }, 4000, 'ظرف الحدّ الذهبي');
    for (const forbidden of ['always', 'bypass', 'allow_always', 'state_request', 'stop', '']) {
      const bad = mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({
        envelope_id: guardId, decision: forbidden,
      }), 'utf8'));
      await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop, bad);
    }
    equal(await guarded, null, 'قرار خارج القائمة المغلقة لا يُحسم — تنتهي المهلة');
    equal(relayStateRequests, 2, 'state_request كقرار لم يدخل مسار طلب الحالة');

    // ── عدّادات الإرسال محجوزة على القرص قبل الختم (§5.5.8) ────────────────
    const material = store.resumeMaterial(deviceId);
    assert(material && material.sendReserved >= mobilerelay.SEND_BLOCK,
      'سقف الإرسال ثُبّت على القرص قبل التعمية');
    assert(material.lastRecv >= 0, 'عدّاد الاستقبال ثُبّت بعد الردود');

    // ── الإبطال يقطع القناة فوراً ──────────────────────────────────────────
    store.revoke(deviceId);
    equal(client.status().deviceCount, 0, 'الجهاز المُبطَل يختفي من القناة');

    // ── الوصل الفعلي: من يستدعي awaitPairing؟ ───────────────────────────────
    // العميل يعرض الدالة، لكن إن لم يستدعها `main.js` عند إنشاء رمز الاقتران فإن
    // الهاتف يودع ظرفه ولا يقرؤه أحد أبداً — «موصول لكن غير مربوط». عطل مثبت حياً
    // 2026-08-12: الاقتران انتهى بمهلته على «لم يؤكّد سطح المكتب الاقتران».
    const wiringSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(/mobileHandle\.awaitPairing\(/.test(wiringSource),
      'main.js يستدعي awaitPairing فعلاً عند إنشاء رمز الاقتران');
    assert(/awaitPairing[\s\S]{0,400}?buildMobilePairingResult\(relayUrl/.test(wiringSource),
      'والاستدعاء يسبق إعادة رابط الاقتران (لا بعده فيضيع السباق)');
    equal((wiringSource.match(/onStateRequest:\s*handleMobileStateRequest/g) || []).length, 2,
      'main.js يصل طلب الحالة بالنقلين بالضبط');
    assert(/function publishMobileState\([\s\S]*?handle\.publishState\(state\)/.test(wiringSource),
      'main.js ينشر عبر المقبض الموحّد لا عبر نقل بعينه');
    assert(/checkpoints\.begin[\s\S]{0,300}?beginMobileRunState\(cwd\)/.test(wiringSource),
      'بدء الدور يطلق لقطة working فعلاً');
    assert(/handle\.offerPermission\(rawReq, offerContext\)[\s\S]{0,500}?phase: 'waiting_permission'/.test(wiringSource),
      'عرض الإذن يطلق waiting_permission بعد إدراج الظرف');
    assert(/resolvePermissionThroughCurrentHandles[\s\S]{0,500}?phase: 'working'/.test(wiringSource),
      'حسم إذن الجوال يعيد الحالة إلى working');
    assert(/obj\.type === 'task_update'[\s\S]{0,400}?publishMobileTaskState\(ledger\)/.test(wiringSource),
      'task_update يطلق لقطة فعلاً');
    assert(/obj\.type === 'file_edit'[\s\S]{0,160}?publishMobileFileEdit\(obj\)/.test(wiringSource),
      'file_edit يطلق لقطة فعلاً');
    assert(/function publishVerification[\s\S]{0,180}?publishMobileVerification\(result\)/.test(wiringSource),
      'verification_result يطلق لقطة فعلاً');
    assert(/obj\.type === 'result' \|\| obj\.type === 'proc_done'[\s\S]{0,180}?finishMobileRunState\(obj\)/.test(wiringSource),
      'نهاية الدور تطلق done/error فعلاً');
    assert(/function handleMobileStop[\s\S]{0,400}?phase: 'stopped'/.test(wiringSource),
      'قبول الإيقاف يطلق stopped فعلاً');
    assert(/setInterval\([\s\S]{0,180}?hasLiveMobileSession\(\)[\s\S]{0,100}?publishMobileState\(\)/.test(wiringSource)
      && /mobileStateHeartbeat\.unref/.test(wiringSource), 'النبضة 20ث مربوطة بجلسة حيّة ومؤقّتها unref');
    const relaySource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mobilerelay.js'), 'utf8');
    assert(/function pushState\([\s\S]{0,900}?ensureSendCounter\(deviceId, entry\.session\)[\s\S]{0,220}?d\.crypto\.seal/.test(relaySource),
      'pushState يحجز عداد الإرسال قبل كل ختم');

    // ── تنقية عنوان الوسيط في main.js (منطق الإنتاج نفسه) ──────────────────
    // عنوان عام بلا TLS يعرّض النقل ولا يمنح crypto.subtle سياقاً آمناً على الهاتف.
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    const relayUrlFor = (value, labs) => {
      const labsFile = path.join(tempRoot, 'labs-' + Math.random().toString(36).slice(2) + '.json');
      if (labs !== undefined) fs.writeFileSync(labsFile, labs, 'utf8');
      const sandbox = {
        process: { env: value === undefined ? {} : { SATR_RELAY_URL: value } },
        JSON, String, URL, Number,
        fs: { readFileSync: () => fs.readFileSync(labsFile, 'utf8') },
        path: { join: () => labsFile },
        os: { homedir: () => tempRoot },
      };
      return sourceFunction(mainSource, 'mobileRelayUrl', sandbox)();
    };
    equal(relayUrlFor('https://relay.example'), 'https://relay.example', 'HTTPS مقبول');
    equal(relayUrlFor('https://relay.example/'), 'https://relay.example', 'الشرطة الزائدة تُزال');
    equal(relayUrlFor('http://relay.example'), '', 'HTTP عام مرفوض');
    equal(relayUrlFor('http://127.0.0.1:8787'), 'http://127.0.0.1:8787', 'loopback مسموح للتطوير');
    equal(relayUrlFor('https://u:p@relay.example'), '', 'اعتماد في العنوان مرفوض');
    equal(relayUrlFor('https://relay.example?x=1'), '', 'استعلام مرفوض');
    equal(relayUrlFor('ftp://relay.example'), '', 'بروتوكول آخر مرفوض');
    equal(relayUrlFor('ليس عنواناً'), '', 'نص مشوّه مرفوض');
    equal(relayUrlFor(undefined), '', 'بلا إعداد = الوضع المحلي');
    equal(relayUrlFor(undefined, '{"relay_url":"https://labs.example"}'), 'https://labs.example',
      'ملف labs مصدر ثانٍ');
    equal(relayUrlFor(undefined, '{"relay_url":"http://labs.example"}'), '',
      'ملف labs يخضع للتنقية نفسها');

    // ── توافق اشتقاق الصناديق مع منطق الهاتف الحقيقي ───────────────────────
    // الطرفان يشتقّان مستقلَّين: أي انحراف يعني هاتفاً يستقصي صندوقاً لا أحد يكتبه.
    const pwa = loadPwaCrypto();
    const pwaBoxes = await pwa.deriveChannelBoxes({
      myPrivate: mobileKeys.privateKey,
      myPublic: mobileKeys.publicKey,
      theirPublic: identity.publicKey,
      pairId: payload.pairId,
    });
    equal(pwaBoxes.toMobile, mobileBoxes.toMobile, 'الهاتف وسطح المكتب يشتقّان صندوق D2M نفسه');
    equal(pwaBoxes.toDesktop, mobileBoxes.toDesktop, 'وصندوق M2D نفسه');

    // ومعرّف صندوق الاقتران كما يحسبه الهاتف (SHA-256 لنفس الوسم)
    const pwaPairBox = crypto.createHash('sha256')
      .update('satr-relay-pair-v1' + payload.pairId, 'utf8').digest('hex').slice(0, 32);
    equal(pwaPairBox, mobilerelay.pairBoxId(payload.pairId), 'معرّف صندوق الاقتران متطابق');
  } finally {
    await client.stop();
    await relay.stop();
  }
  await testLocalStateChannel();
}

run()
  .then(() => { console.log('mobilerelay-test: ok — ' + checks + ' فحصاً (عميل حقيقي فوق وسيط حقيقي).'); })
  .catch((error) => {
    console.error('mobilerelay-test: FAIL:', error && error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* لا يؤثر */ }
  });
