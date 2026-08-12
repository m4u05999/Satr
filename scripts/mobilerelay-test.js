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
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mobilecrypto = require('../electron/mobilecrypto');
const mobileenvelope = require('../electron/mobileenvelope');
const mobilepair = require('../electron/mobilepair');
const mobilerelay = require('../electron/mobilerelay');

const tempRoot = path.join(os.tmpdir(), 'satr-relay-client-' + process.pid + '-' + Date.now());
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

async function run() {
  fs.mkdirSync(tempRoot, { recursive: true });
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
  const client = mobilerelay.start({
    crypto: mobilecrypto, pair: store, envelope: mobileenvelope, transport, identity,
  }, { relayUrl: relay.url, pollTimeoutMs: 800 });

  try {
    equal(typeof client.offerPermission, 'function', 'العقد نفسه: offerPermission');
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
    for (const forbidden of ['always', 'bypass', 'allow_always', '']) {
      const bad = mobilecrypto.seal(mobileSession, Buffer.from(JSON.stringify({
        envelope_id: guardId, decision: forbidden,
      }), 'utf8'));
      await transport.post(relay.url + '/m/' + mobileBoxes.toDesktop, bad);
    }
    equal(await guarded, null, 'قرار خارج القائمة المغلقة لا يُحسم — تنتهي المهلة');

    // ── عدّادات الإرسال محجوزة على القرص قبل الختم (§5.5.8) ────────────────
    const material = store.resumeMaterial(deviceId);
    assert(material && material.sendReserved >= mobilerelay.SEND_BLOCK,
      'سقف الإرسال ثُبّت على القرص قبل التعمية');
    assert(material.lastRecv >= 0, 'عدّاد الاستقبال ثُبّت بعد الردود');

    // ── الإبطال يقطع القناة فوراً ──────────────────────────────────────────
    store.revoke(deviceId);
    equal(client.status().deviceCount, 0, 'الجهاز المُبطَل يختفي من القناة');

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
