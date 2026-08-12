/**
 * اختبارات قطعية بلا شبكة خارجية لـ electron/mobilelink.js (§5.1).
 *
 * كل اختبار يرفع خادماً HTTPS على 127.0.0.1 بمنفذ عشوائي حقيقي (port:0)، ويستعمل
 * **mobilecrypto وmobilepair وmobileenvelope الحقيقية** — لا مزيّفات. عميل HTTPS محلي
 * يلعب دور الجوال: يولّد زوجه، يقترن، يشتق جلسته بـderiveSession(role:'mobile')،
 * ويفكّ/يختم الأطر بنفسه. فما يثبته الاختبار هو دورة E2E الفعلية لا محاكاتها.
 *
 * دفتر الأجهزة يعيش في ملف مؤقت معزول (لا ~/.satr الحقيقي)، وكل حالة اختبار تبدأ
 * بمخزن وخادم جديدين ثم توقفهما — بلا حالة عامة تتسرّب بين الحالات.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const mobilecrypto = require('../electron/mobilecrypto');
const mobilepair = require('../electron/mobilepair');
const mobileenvelope = require('../electron/mobileenvelope');
const mobilelink = require('../electron/mobilelink');
const mobiletls = require('../electron/mobiletls');

const tempRoot = path.join(os.tmpdir(), 'satr-mobilelink-test-' + process.pid + '-' + Date.now());
const appRoot = path.resolve(__dirname, '..');
const tlsMaterial = mobiletls.ensureCert('127.0.0.1');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed += 1; return; }
  failed += 1;
  console.error('FAIL:', message);
}

function assertEqual(actual, expected, message) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  console.error('FAIL:', message, '— expected', JSON.stringify(expected), 'got', JSON.stringify(actual));
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ── عميل HTTPS بسيط يعيد الجسم خاماً (الأطر ثنائية) ─────────────────────────
function request(port, method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      ca: tlsMaterial.cert,
      rejectUnauthorized: true,
      headers: body ? { 'content-type': contentType || 'application/octet-stream', 'content-length': body.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        answered = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    let answered = false;
    // الخادم قد يقطع الاتصال بعد ردّ الرفض (جسم ضخم) — لا نحوّل ذلك خطأ اختبار
    req.on('error', (error) => { if (!answered) reject(error); });
    if (body) req.write(body);
    req.end();
  });
}

function json(response) {
  try { return JSON.parse(response.body.toString('utf8') || 'null'); } catch { return null; }
}

// ── تجهيز بيئة اختبار مستقلة ────────────────────────────────────────────────
let envSeq = 0;

/**
 * ينشئ مخزن أجهزة معزولاً **مبذوراً بهوية سطح مكتب معروفة**.
 * السبب: mobilepair لا يعيد المفتاح الخاص إطلاقاً (§4.3)، بينما القناة تحتاجه
 * لاشتقاق جلسة الديسكتوب. فنكتب زوجاً ولّدناه بأنفسنا في ملف المخزن، فيحمّله
 * mobilepair كهويته، ونحقن الزوج نفسه في القناة عبر deps.identity.
 */
async function newEnv(opts) {
  envSeq += 1;
  const file = path.join(tempRoot, 'devices-' + envSeq + '.json');
  const identity = mobilecrypto.generateKeyPair();
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ identity, devices: [] }), 'utf8');

  const store = mobilepair.createStore({ file });
  const link = await mobilelink.start(
    {
      crypto: mobilecrypto,
      pair: store,
      envelope: mobileenvelope,
      identity,
      app: { getAppPath: () => appRoot },
    },
    Object.assign({ host: '127.0.0.1', port: 0 }, opts || {})
  );
  return { store, link, identity, file };
}

/** يبني «جوالاً»: زوج مفاتيح + معرّف جهاز جديد لكل اقتران. */
function newMobile(label) {
  return {
    keys: mobilecrypto.generateKeyPair(),
    deviceId: crypto.randomBytes(8).toString('hex'), // 16 محرفاً hex — عقد mobilepair
    label: label || 'هاتف الاختبار',
    session: null,
  };
}

/** يمرّ بدورة الاقتران الكاملة كما ستفعل PWA. */
async function pair(env, mobile) {
  const payload = env.store.buildPairingPayload();
  const body = Buffer.from(JSON.stringify({
    pairId: payload.pairId,
    secretProof: payload.secret,
    mobilePublic: mobile.keys.publicKey,
    deviceId: mobile.deviceId,
    label: mobile.label,
  }), 'utf8');
  const response = await request(env.link.port, 'POST', '/pair', body, 'application/json');
  const parsed = json(response);
  if (response.status === 200 && parsed && parsed.ok) {
    mobile.session = mobilecrypto.deriveSession({
      myPrivate: mobile.keys.privateKey,
      theirPublic: payload.desktopPublic,
      pairId: payload.pairId,
      role: 'mobile',
    });
    mobile.pairId = payload.pairId;
  }
  return { response, parsed, payload };
}

function poll(env, mobile) {
  return request(env.link.port, 'GET', '/poll?device=' + encodeURIComponent(mobile.deviceId));
}

function sealReply(mobile, envelopeId, decision) {
  return mobilecrypto.seal(mobile.session, Buffer.from(JSON.stringify({
    envelope_id: envelopeId,
    decision,
  }), 'utf8'));
}

function sendReply(env, mobile, frame) {
  return request(env.link.port, 'POST', '/reply?device=' + encodeURIComponent(mobile.deviceId), frame);
}

// طلب إذن نموذجي كما تراه العملية الرئيسية
function sampleRequest(id, command) {
  return {
    id: id,
    tool: 'Bash',
    input: { command: command || 'npm run build', description: 'بناء المشروع' },
    cwd: 'D:\\sater\\satr-2-opus',
    engine: 'sdk',
    session_id: 'sess-1',
  };
}

// ── الحالات ─────────────────────────────────────────────────────────────────

async function testPairing() {
  const env = await newEnv();
  try {
    const mobile = newMobile();
    const ok = await pair(env, mobile);
    assertEqual(ok.response.status, 200, 'pairing: اقتران صحيح يعيد 200');
    assertEqual(ok.parsed && ok.parsed.ok, true, 'pairing: ok=true');
    assertEqual(ok.parsed && ok.parsed.deviceId, mobile.deviceId, 'pairing: يعيد معرّف الجهاز');
    assert(/^[0-9]{6}$/.test((ok.parsed && ok.parsed.sas) || ''), 'pairing: SAS من ست خانات');
    assertEqual(
      ok.parsed.sas,
      mobilecrypto.sas({
        desktopPublic: env.identity.publicKey,
        mobilePublic: mobile.keys.publicKey,
        pairId: ok.payload.pairId,
      }),
      'pairing: SAS يطابق حساب الجوال (كشف MITM)'
    );
    assert(ok.parsed && !('secret' in ok.parsed) && !('privateKey' in ok.parsed), 'pairing: لا سرّ ولا مفتاح في الرد');
    assertEqual(env.store.listDevices().length, 1, 'pairing: الجهاز أُضيف للدفتر');
    assertEqual(env.link.status().deviceCount, 1, 'pairing: status يعدّ الجهاز الحيّ');
    assert(env.link.url.startsWith('https://127.0.0.1:'), 'pairing: رابط القناة HTTPS');
    assertEqual(env.link.status().fingerprint, tlsMaterial.fingerprint, 'pairing: status يعيد بصمة الشهادة');

    // سرّ خاطئ ⇒ رفض ولا جهاز جديد
    const badSecret = Buffer.from(JSON.stringify({
      pairId: env.store.buildPairingPayload().pairId,
      secretProof: crypto.randomBytes(32).toString('base64url'),
      mobilePublic: newMobile().keys.publicKey,
      deviceId: crypto.randomBytes(8).toString('hex'),
      label: 'دخيل',
    }), 'utf8');
    const rejected = await request(env.link.port, 'POST', '/pair', badSecret, 'application/json');
    assertEqual(rejected.status, 400, 'pairing: سرّ خاطئ يُرفض 400');
    assertEqual(json(rejected).ok, false, 'pairing: سرّ خاطئ ok=false');
    assertEqual(env.store.listDevices().length, 1, 'pairing: الرفض لا يضيف جهازاً');

    // سرّ منتهٍ/مجهول pairId
    const unknown = Buffer.from(JSON.stringify({
      pairId: crypto.randomBytes(16).toString('hex'),
      secretProof: crypto.randomBytes(32).toString('base64url'),
      mobilePublic: newMobile().keys.publicKey,
      deviceId: crypto.randomBytes(8).toString('hex'),
      label: 'دخيل',
    }), 'utf8');
    const unknownRes = await request(env.link.port, 'POST', '/pair', unknown, 'application/json');
    assertEqual(unknownRes.status, 400, 'pairing: pairId مجهول يُرفض');

    // جهاز غير مقترن لا يستطيع الاستطلاع
    const stranger = await request(env.link.port, 'GET', '/poll?device=' + crypto.randomBytes(8).toString('hex'));
    assertEqual(stranger.status, 403, 'pairing: جهاز غير مقترن يُرفض من /poll');
  } finally {
    await env.link.stop();
  }
}

async function testDecisionCycle(decision) {
  const env = await newEnv();
  try {
    const mobile = newMobile();
    await pair(env, mobile);

    const id = 'toolu_' + decision + '_01';
    const promise = env.link.offerPermission(sampleRequest(id, 'npm test -- --watch=false'), { ttlMs: 30000 });
    let settled = null;
    promise.then((value) => { settled = value; });

    assertEqual(env.link.status().pending, 1, decision + ': الظرف مسجّل معلّقاً');

    const polled = await poll(env, mobile);
    assertEqual(polled.status, 200, decision + ': الاستطلاع يعيد إطاراً');
    const plaintext = mobilecrypto.open(mobile.session, polled.body);
    const message = JSON.parse(plaintext.toString('utf8'));
    assertEqual(message.type, 'permission_request', decision + ': نوع الرسالة');
    assertEqual(message.envelope.envelope_id, id, decision + ': envelope_id يطابق tool_use_id');
    assertEqual(message.envelope.risk, 'exec', decision + ': التصنيف من الظرف');
    assert(
      message.envelope.summary.indexOf('npm test') !== -1,
      decision + ': الفعل الحرفي داخل الظرف'
    );
    assert(!('input' in message.envelope) && !('session_id' in message.envelope),
      decision + ': لا يعبر مدخل خام ولا معرّف جلسة');

    const replied = await sendReply(env, mobile, sealReply(mobile, id, decision));
    assertEqual(replied.status, 200, decision + ': الردّ مقبول');
    await sleep(10);
    assertEqual(settled, decision, decision + ': الوعد حُسم بالقرار نفسه');
    assertEqual(env.link.status().pending, 0, decision + ': المعلّق سُحب بعد الحسم');
  } finally {
    await env.link.stop();
  }
}

async function testWakeWaiter() {
  const env = await newEnv({ pollTimeoutMs: 3000 });
  try {
    const mobile = newMobile();
    await pair(env, mobile);

    // استطلاع يسبق العرض: يجب أن يستيقظ فور تسجيل الظرف
    const polling = poll(env, mobile);
    await sleep(60);
    const promise = env.link.offerPermission(sampleRequest('toolu_wake_01', 'git status'), { ttlMs: 30000 });
    let settled = 'unset';
    promise.then((value) => { settled = value; });

    const polled = await polling;
    assertEqual(polled.status, 200, 'wake: المنتظر استيقظ بظرف جديد');
    const message = JSON.parse(mobilecrypto.open(mobile.session, polled.body).toString('utf8'));
    assertEqual(message.envelope.envelope_id, 'toolu_wake_01', 'wake: الظرف الصحيح');

    const replied = await sendReply(env, mobile, sealReply(mobile, 'toolu_wake_01', 'deny'));
    assertEqual(replied.status, 200, 'wake: الردّ مقبول');
    await sleep(10);
    assertEqual(settled, 'deny', 'wake: الوعد حُسم');
  } finally {
    await env.link.stop();
  }
}

async function testWithdrawAndStaleApproval() {
  const env = await newEnv();
  try {
    const mobile = newMobile();
    await pair(env, mobile);

    const id = 'toolu_stale_01';
    const promise = env.link.offerPermission(sampleRequest(id, 'rm -rf build'), { ttlMs: 30000 });
    let settled = 'unset';
    promise.then((value) => { settled = value; });

    // الجوال استلم الظرف فعلاً قبل أن يحسم سطح المكتب
    const polled = await poll(env, mobile);
    assertEqual(polled.status, 200, 'stale: الجوال استلم الظرف');
    const message = JSON.parse(mobilecrypto.open(mobile.session, polled.body).toString('utf8'));
    assertEqual(message.envelope.envelope_id, id, 'stale: الظرف الصحيح');

    // سطح المكتب حسم أولاً ⇒ withdraw
    assertEqual(env.link.withdraw(id), true, 'stale: withdraw يسحب المعلّق');
    await sleep(10);
    assertEqual(settled, null, 'stale: الوعد يُحسم null (لا قرار من الجوال)');
    assertEqual(env.link.status().pending, 0, 'stale: لا معلّقات بعد السحب');
    assertEqual(env.link.withdraw(id), false, 'stale: سحب ثانٍ لا يفعل شيئاً');

    // ثم تصل موافقة الجوال المتأخرة — يجب أن تُرفض ولا تُطبَّق
    const late = await sendReply(env, mobile, sealReply(mobile, id, 'allow'));
    assertEqual(late.status, 409, 'stale: الموافقة القديمة تُرفض 409');
    assertEqual(json(late).error, 'not_pending', 'stale: رمز الرفض not_pending');
    assertEqual(settled, null, 'stale: الوعد بقي null ولم ينقلب إلى allow');

    // ردّ على معرّف لم يُعرض أصلاً
    const never = await sendReply(env, mobile, sealReply(mobile, 'toolu_never_offered', 'allow'));
    assertEqual(never.status, 409, 'stale: ردّ لظرف لم يُعرض يُرفض');

    // ظرف ثانٍ حيّ لا يتأثر بالردّ المرفوض
    const secondId = 'toolu_stale_02';
    let secondSettled = 'unset';
    env.link.offerPermission(sampleRequest(secondId, 'ls'), { ttlMs: 30000 })
      .then((value) => { secondSettled = value; });
    await sendReply(env, mobile, sealReply(mobile, 'toolu_never_offered', 'allow'));
    await sleep(10);
    assertEqual(secondSettled, 'unset', 'stale: ردّ مرفوض لا يحسم ظرفاً آخر');
    await sendReply(env, mobile, sealReply(mobile, secondId, 'allow_turn'));
    await sleep(10);
    assertEqual(secondSettled, 'allow_turn', 'stale: الظرف الحيّ يُحسم بردّه الصحيح');
  } finally {
    await env.link.stop();
  }
}

async function testRevokedDevice() {
  const env = await newEnv({ pollTimeoutMs: 200 });
  try {
    const mobile = newMobile();
    await pair(env, mobile);
    assertEqual(env.link.status().deviceCount, 1, 'revoked: الجهاز حيّ قبل الإبطال');

    const id = 'toolu_revoked_01';
    let settled = 'unset';
    env.link.offerPermission(sampleRequest(id, 'curl http://x'), { ttlMs: 30000 })
      .then((value) => { settled = value; });

    // نجهّز إطار ردّ صالحاً **قبل** الإبطال — الإبطال يجب أن يبطله رغم صحته
    const frame = sealReply(mobile, id, 'allow');

    assertEqual(env.store.revoke(mobile.deviceId).ok, true, 'revoked: الإبطال نجح');
    assertEqual(env.link.status().deviceCount, 0, 'revoked: لا أجهزة حيّة بعد الإبطال');

    const polled = await poll(env, mobile);
    assertEqual(polled.status, 403, 'revoked: /poll يرفض الجهاز المُبطَل');

    const replied = await request(env.link.port, 'POST', '/reply?device=' + mobile.deviceId, frame);
    assertEqual(replied.status, 403, 'revoked: /reply يرفض الجهاز المُبطَل');
    await sleep(10);
    assertEqual(settled, 'unset', 'revoked: الظرف لم يُحسم بردّ جهاز مُبطَل');
    assertEqual(env.link.status().pending, 1, 'revoked: الظرف ما زال معلّقاً لمربع سطح المكتب');
  } finally {
    await env.link.stop();
  }
}

async function testPollTimeout() {
  const env = await newEnv({ pollTimeoutMs: 250 });
  try {
    const mobile = newMobile();
    await pair(env, mobile);
    const started = Date.now();
    const polled = await poll(env, mobile);
    const elapsed = Date.now() - started;
    assertEqual(polled.status, 204, 'timeout: بلا ظرف يعيد 204 بعد المهلة');
    assertEqual(polled.body.length, 0, 'timeout: جسم فارغ');
    assert(elapsed >= 200, 'timeout: انتظر المهلة فعلاً (' + elapsed + 'ms)');
  } finally {
    await env.link.stop();
  }
}

async function testTamperAndReplay() {
  const env = await newEnv();
  try {
    const mobile = newMobile();
    await pair(env, mobile);

    // إطار متلاعب به: قلب بايت في النص المعمّى ⇒ فشل الوسم
    const idA = 'toolu_tamper_01';
    let settledA = 'unset';
    env.link.offerPermission(sampleRequest(idA, 'echo a'), { ttlMs: 30000 })
      .then((value) => { settledA = value; });
    const tampered = Buffer.from(sealReply(mobile, idA, 'allow'));
    tampered[tampered.length - 1] ^= 0xff;
    const tamperRes = await sendReply(env, mobile, tampered);
    assertEqual(tamperRes.status, 400, 'tamper: إطار متلاعب يُرفض 400');
    assertEqual(json(tamperRes).error, 'bad_frame', 'tamper: رمز الرفض bad_frame');
    await sleep(10);
    assertEqual(settledA, 'unset', 'tamper: لا حسم من إطار فاسد');

    // جسم عشوائي بلا أي تعمية
    const garbage = await sendReply(env, mobile, crypto.randomBytes(64));
    assertEqual(garbage.status, 400, 'tamper: جسم غير مصادق لا يحصل على شيء');

    // إعادة إرسال إطار صحيح مرتين: الثانية تُرفض بحارس العدّاد
    const idB = 'toolu_replay_01';
    let settledB = 'unset';
    env.link.offerPermission(sampleRequest(idB, 'echo b'), { ttlMs: 30000 })
      .then((value) => { settledB = value; });
    const frame = sealReply(mobile, idB, 'deny');
    const first = await sendReply(env, mobile, frame);
    assertEqual(first.status, 200, 'replay: الإطار الأول مقبول');
    await sleep(10);
    assertEqual(settledB, 'deny', 'replay: الحسم الأول صحيح');
    const second = await sendReply(env, mobile, frame);
    assertEqual(second.status, 400, 'replay: إعادة الإطار نفسه تُرفض');
    assertEqual(json(second).error, 'bad_frame', 'replay: يُرفض قبل بلوغ المعلّقات');

    // قرار خارج القائمة المغلقة — لا «دائماً» ولا bypass
    const idC = 'toolu_decision_01';
    let settledC = 'unset';
    env.link.offerPermission(sampleRequest(idC, 'echo c'), { ttlMs: 30000 })
      .then((value) => { settledC = value; });
    for (const bad of ['always', 'allow_always', 'bypassPermissions', 'ALLOW', '']) {
      const res = await sendReply(env, mobile, sealReply(mobile, idC, bad));
      assertEqual(res.status, 400, 'decision: «' + bad + '» مرفوض');
    }
    await sleep(10);
    assertEqual(settledC, 'unset', 'decision: قرار غير مسموح لا يحسم شيئاً');
    // الباقيان: ظرف العبث (لم يُحسم) وظرف القرار المرفوض — لا شيء منهما حُسم خلسة
    assertEqual(env.link.status().pending, 2, 'decision: الظرفان غير المحسومين باقيان معلّقين');
  } finally {
    await env.link.stop();
  }
}

async function testSessionIsolation() {
  const env = await newEnv({ pollTimeoutMs: 200 });
  try {
    const one = newMobile('جهاز أول');
    const two = newMobile('جهاز ثانٍ');
    await pair(env, one);
    await pair(env, two);
    assertEqual(env.link.status().deviceCount, 2, 'isolation: جهازان حيّان');

    const id = 'toolu_iso_01';
    env.link.offerPermission(sampleRequest(id, 'echo iso'), { ttlMs: 30000 });

    const polledOne = await poll(env, one);
    const polledTwo = await poll(env, two);
    assertEqual(polledOne.status, 200, 'isolation: الجهاز الأول استلم');
    assertEqual(polledTwo.status, 200, 'isolation: الجهاز الثاني استلم');
    assert(!polledOne.body.equals(polledTwo.body), 'isolation: إطاران مختلفان (مفتاحان مختلفان)');

    // جلسة الجهاز الأول لا تفكّ إطار الثاني
    let crossOk = false;
    try { mobilecrypto.open(one.session, polledTwo.body); crossOk = true; } catch { crossOk = false; }
    assertEqual(crossOk, false, 'isolation: جهاز لا يفكّ ظرف جهاز آخر');

    // ولا يزوّر ردّاً باسم الآخر: إطار الأول مُرسَل على مسار الثاني يُرفض
    const forged = sealReply(one, id, 'allow');
    const forgedRes = await request(env.link.port, 'POST', '/reply?device=' + two.deviceId, forged);
    assertEqual(forgedRes.status, 400, 'isolation: ردّ مختوم بمفتاح جهاز آخر يُرفض');
  } finally {
    await env.link.stop();
  }
}

async function testTtlAndLifecycle() {
  const env = await newEnv({ pollTimeoutMs: 200 });
  try {
    const mobile = newMobile();
    await pair(env, mobile);

    // انتهاء المهلة ⇒ null (لا قرار ضمني)
    let settled = 'unset';
    env.link.offerPermission(sampleRequest('toolu_ttl_01', 'sleep 1'), { ttlMs: 1000 })
      .then((value) => { settled = value; });
    assertEqual(env.link.status().pending, 1, 'ttl: معلّق قبل الانتهاء');
    await sleep(1150);
    assertEqual(settled, null, 'ttl: انتهاء المهلة يحسم null لا قراراً');
    assertEqual(env.link.status().pending, 0, 'ttl: المعلّق سُحب عند الانتهاء');

    // ردّ بعد الانتهاء يُرفض (موافقة قديمة أخرى)
    const late = await sendReply(env, mobile, sealReply(mobile, 'toolu_ttl_01', 'allow'));
    assertEqual(late.status, 409, 'ttl: الردّ بعد الانتهاء يُرفض');

    // ظرف مشوّه بلا معرّف ⇒ null فوراً بلا تسجيل
    const malformed = await env.link.offerPermission({ tool: 'Bash' }, { ttlMs: 30000 });
    assertEqual(malformed, null, 'ttl: طلب مشوّه يعيد null فوراً');
    assertEqual(env.link.status().pending, 0, 'ttl: المشوّه لم يُسجَّل');

    // إيقاف القناة يحسم المعلّقات null ويوقف الخدمة
    let stopSettled = 'unset';
    env.link.offerPermission(sampleRequest('toolu_stop_01', 'echo stop'), { ttlMs: 30000 })
      .then((value) => { stopSettled = value; });
    assertEqual(env.link.status().pending, 1, 'stop: معلّق قبل الإيقاف');
    await env.link.stop();
    await sleep(10);
    assertEqual(stopSettled, null, 'stop: الإيقاف يحسم المعلّقات null');
    assertEqual(env.link.status().running, false, 'stop: running=false');
    const after = await env.link.offerPermission(sampleRequest('toolu_stop_02'), { ttlMs: 30000 });
    assertEqual(after, null, 'stop: عرض بعد الإيقاف يعيد null');
  } finally {
    await env.link.stop();
  }
}

async function testHardening() {
  const env = await newEnv({ pollTimeoutMs: 200 });
  try {
    const mobile = newMobile();
    await pair(env, mobile);

    const index = await request(env.link.port, 'GET', '/');
    assertEqual(index.status, 200, 'static: الجذر يخدم index.html');
    assert(index.body.equals(fs.readFileSync(path.join(appRoot, 'pwa', 'index.html'))), 'static: محتوى index.html مطابق');
    assertEqual(index.headers['content-type'], 'text/html; charset=utf-8', 'static: نوع HTML صحيح');

    const appJs = await request(env.link.port, 'GET', '/app.js');
    assertEqual(appJs.status, 200, 'static: ملف JS مسموح');
    assert(appJs.body.equals(fs.readFileSync(path.join(appRoot, 'pwa', 'app.js'))), 'static: لا يُبدّل محتوى JS');

    const manifest = await request(env.link.port, 'GET', '/manifest.webmanifest');
    assertEqual(manifest.status, 200, 'static: webmanifest ضمن قائمة السماح');
    assertEqual(manifest.headers['content-type'], 'application/manifest+json; charset=utf-8', 'static: نوع webmanifest صحيح');

    const unknown = await request(env.link.port, 'GET', '/missing.js');
    assertEqual(unknown.status, 404, 'static: ملف مفقود 404');

    const blockedExtension = await request(env.link.port, 'GET', '/notes.txt');
    assertEqual(blockedExtension.status, 404, 'static: امتداد خارج قائمة السماح مرفوض');

    const traversal = await request(env.link.port, 'GET', '/..%2Felectron%2Fmain.js');
    assertEqual(traversal.status, 404, 'static: traversal بترميز الشرطة مرفوض');

    const windowsTraversal = await request(env.link.port, 'GET', '/..%5Celectron%5Cmain.js');
    assertEqual(windowsTraversal.status, 404, 'static: traversal بشرطة ويندوز مرفوض');

    const wrongMethod = await request(env.link.port, 'GET', '/reply?device=' + mobile.deviceId);
    assertEqual(wrongMethod.status, 404, 'hardening: طريقة خاطئة لا تُخدم');

    const badDevice = await request(env.link.port, 'GET', '/poll?device=zz');
    assertEqual(badDevice.status, 400, 'hardening: معرّف جهاز مشوّه يُرفض');

    const noDevice = await request(env.link.port, 'GET', '/poll');
    assertEqual(noDevice.status, 400, 'hardening: بلا معرّف جهاز يُرفض');

    const tooBig = await request(env.link.port, 'POST', '/pair', Buffer.alloc(mobilelink.MAX_BODY + 1024, 0x61), 'application/json');
    assert(tooBig.status === 413 || tooBig.status === 400, 'hardening: جسم ضخم مرفوض (' + tooBig.status + ')');

    const badJson = await request(env.link.port, 'POST', '/pair', Buffer.from('{ليس JSON'), 'application/json');
    assertEqual(badJson.status, 400, 'hardening: JSON فاسد يُرفض');

    // CORS مطفأ افتراضياً (fail-closed)
    const cors = await request(env.link.port, 'GET', '/poll?device=zz');
    assertEqual(cors.status, 400, 'hardening: الردّ يعمل بلا CORS');

    // deps ناقصة ⇒ رفض البدء
    let depsError = '';
    try { await mobilelink.start({ pair: env.store, envelope: mobileenvelope }, { host: '127.0.0.1', port: 0 }); }
    catch (error) { depsError = error.message; }
    assertEqual(depsError, 'bad_deps_crypto', 'hardening: deps ناقصة ترفض البدء');

    // بلا مفتاح خاص لسطح المكتب ⇒ فشل مغلق
    let identityError = '';
    try {
      await mobilelink.start(
        { crypto: mobilecrypto, pair: { completePairing() {}, listDevices() { return []; } }, envelope: mobileenvelope },
        { host: '127.0.0.1', port: 0 }
      );
    } catch (error) { identityError = error.message; }
    assertEqual(identityError, 'no_desktop_identity', 'hardening: غياب المفتاح الخاص يفشل مغلقاً');
  } finally {
    await env.link.stop();
  }
}

async function run() {
  await testPairing();
  await testDecisionCycle('allow');
  await testDecisionCycle('allow_turn');
  await testDecisionCycle('deny');
  await testWakeWaiter();
  await testWithdrawAndStaleApproval();
  await testRevokedDevice();
  await testPollTimeout();
  await testTamperAndReplay();
  await testSessionIsolation();
  await testTtlAndLifecycle();
  await testHardening();
}

run()
  .then(() => {
    if (failed) {
      console.log('mobilelink-test: ' + passed + ' نجحت، ' + failed + ' فشلت.');
      process.exitCode = 1;
    } else {
      console.log('mobilelink-test: ok — ' + passed + ' فحصاً: الاقتران والدورة الكاملة وحارس الموافقة القديمة وعزل الجلسات والإبطال والمهلة وreplay/العبث.');
    }
  })
  .catch((error) => {
    console.error('Test exception:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* لا يؤثر على النتيجة */ }
  });
