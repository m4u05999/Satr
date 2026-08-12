/**
 * حارس التكامل الكامل لقناة الجوال (§5.5.4).
 *
 * لا يزيّف الخادم ولا التعمية: يرفع mobilelink الحقيقي بشهادة mobiletls الحقيقية،
 * ويبني نتيجة الاقتران بالدالتين الفعليتين المستخرجتين من main.js، ثم يلعب دور PWA
 * بتعمية WebCrypto الفعلية من pwa/crypto.js. لا متصفح ولا شبكة خارجية.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mobilecrypto = require('../electron/mobilecrypto');
const mobileenvelope = require('../electron/mobileenvelope');
const mobilelink = require('../electron/mobilelink');
const mobilepair = require('../electron/mobilepair');
const mobiletls = require('../electron/mobiletls');

const appRoot = path.resolve(__dirname, '..');
const tempRoot = path.join(os.tmpdir(), 'satr-mobile-integration-' + process.pid + '-' + Date.now());
let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

function equal(actual, expected, message) {
  assert(actual === expected, message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/** يستخرج دالة صغيرة نقية من المصدر كي يختبر الحارس ما يستعمله main.js فعلاً. */
function sourceFunction(source, name, context) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('missing_source_function:' + name);
  const bodyStart = source.indexOf('{', start + marker.length);
  if (bodyStart === -1) throw new Error('bad_source_function:' + name);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error('bad_source_function:' + name);
  // `async function X(` يطابق العلامة بعد البادئة؛ إسقاطها يحوّل الدالة إلى متزامنة
  // فينكسر `await` بداخلها. نضمّ البادئة إن وُجدت.
  let sliceStart = start;
  if (start >= 6 && source.slice(start - 6, start) === 'async ') sliceStart = start - 6;
  return vm.runInNewContext('(' + source.slice(sliceStart, end) + ')', context, { filename: 'electron/main.js' });
}

function loadMainPairingBuilder() {
  const source = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8');
  const context = { Buffer, JSON, Math };
  const buildMobilePairingUrl = sourceFunction(source, 'buildMobilePairingUrl', context);
  return sourceFunction(source, 'buildMobilePairingResult', Object.assign({ buildMobilePairingUrl }, context));
}

function loadPwaCrypto() {
  const source = fs.readFileSync(path.join(appRoot, 'pwa', 'crypto.js'), 'utf8');
  const webcrypto = crypto.webcrypto;
  const sandbox = {
    window: { crypto: webcrypto },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    atob,
    btoa,
    DOMException,
  };
  vm.runInNewContext(source, sandbox, { filename: 'pwa/crypto.js' });
  const api = sandbox.window.SatrCrypto;
  if (!api || typeof api.generateKeyPair !== 'function' || typeof api.deriveSession !== 'function'
      || typeof api.seal !== 'function' || typeof api.open !== 'function') {
    throw new Error('bad_pwa_crypto');
  }
  return api;
}

/** يستورد b64urlToText وparsePayload من pwa/app.js بدل إعادة صياغة التحقق هنا. */
/**
 * منطق العرض/إعادة العرض كما يشغّله `main.js` فعلاً — لا نسخة اختبار موازية.
 * السقف الأدنى لمهلة القناة 1000ms (‏clampInt في mobilelink) فلا تنفع قيمة أصغر.
 */
function loadMainOffer(sandbox) {
  const source = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8');
  const runMobileOffer = sourceFunction(source, 'runMobileOffer', sandbox);
  // إعادة العرض تنادي نفسها عبر النطاق العام: نضعها في الصندوق نفسه بعد الاستخراج
  sandbox.runMobileOffer = runMobileOffer;
  const offerMobilePermission = sourceFunction(source, 'offerMobilePermission', sandbox);
  return { runMobileOffer, offerMobilePermission };
}

// منطق حفظ الجلسة وحجز العدّادات كما يشغّله الهاتف فعلاً (التخزين وحده مزيّف).
function loadPwaSessionStore(sandbox) {
  const source = fs.readFileSync(path.join(appRoot, 'pwa', 'app.js'), 'utf8');
  sandbox.sessionRecord = sourceFunction(source, 'sessionRecord', sandbox);
  sandbox.reserveSendCounters = sourceFunction(source, 'reserveSendCounters', sandbox);
  sandbox.restoreSession = sourceFunction(source, 'restoreSession', sandbox);
  return sandbox;
}

// منطق فكّ لفّ الإطار كما يشغّله الهاتف فعلاً — لا نسخة اختبار موازية.
function loadPwaEnvelopeReader() {
  const source = fs.readFileSync(path.join(appRoot, 'pwa', 'app.js'), 'utf8');
  return sourceFunction(source, 'envelopeFromFrame', {});
}

function loadPwaPairingParser(pwaCrypto) {
  const source = fs.readFileSync(path.join(appRoot, 'pwa', 'app.js'), 'utf8');
  // نفحص **العقد لا شكل التنفيذ**: قراءة الـhash، والتعامل مع البادئة `#pair=`،
  // ومسح السرّ من شريط العنوان. اشتراط استدعاء بعينه (مثل `.get('pair')`) يجعل
  // الحارس يحمرّ على تنفيذ سليم — وحارس يحمرّ بلا عطل يُعطَّل ثم لا يحرس شيئاً.
  if (!/location\.hash/.test(source) || !/#pair=/.test(source) || !/replaceState/.test(source)) {
    throw new Error('pwa_pair_hash_contract');
  }
  if (!/secretProof\s*:\s*payload\.secret\b/.test(source)) {
    throw new Error('pwa_secret_proof_contract');
  }
  // عقد النقل الثنائي (§5.1) — ثلاثة أعطال مثبتة حياً على هاتف: القناة ترسل الظرف
  // **بايتات خام** لا JSON، و`/reply` يقبل الإطار خاماً ويوجب `?device=`. الهاتف كان
  // يستدعي res.json() على الظرف ويرسل JSON بلا device، فيُرفض الردّ ويحمرّ الاستقصاء.
  if (!/arrayBuffer\(\)/.test(source)) throw new Error('pwa_poll_binary_contract');
  if (!/reply\?device=/.test(source)) throw new Error('pwa_reply_device_contract');
  if (!/application\/octet-stream/.test(source)) throw new Error('pwa_reply_raw_contract');
  const context = { atob, TextDecoder, Uint8Array, URLSearchParams, JSON, C: pwaCrypto };
  const b64urlToText = sourceFunction(source, 'b64urlToText', context);
  const parsePayload = sourceFunction(source, 'parsePayload', Object.assign({ b64urlToText }, context));
  return (text) => {
    // عقد §5.5.3 نفسه: fragment لا يُرسل للخادم، وقيمته تمر بالمحلل الفعلي للـPWA.
    const link = new URL(String(text));
    const params = new URLSearchParams(link.hash.replace(/^#/, ''));
    const encoded = params.get('pair');
    if (!encoded) throw new Error('حمولة الاقتران ناقصة');
    return { link, payload: parsePayload(b64urlToText(encoded)) };
  };
}

function request(url, cert, method, body, contentType) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      ca: cert,
      rejectUnauthorized: true,
      headers: body ? {
        'content-type': contentType || 'application/octet-stream',
        'content-length': body.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function json(response) {
  return JSON.parse(response.body.toString('utf8') || 'null');
}

function sampleRequest(id, decision) {
  return {
    id,
    tool: 'Bash',
    input: { command: 'echo integration-' + decision, description: 'حارس التكامل' },
    cwd: appRoot,
    engine: 'sdk',
    session_id: 'mobile-integration',
  };
}

async function run() {
  fs.mkdirSync(tempRoot, { recursive: true });
  const identity = mobilecrypto.generateKeyPair();
  const storeFile = path.join(tempRoot, 'devices.json');
  fs.writeFileSync(storeFile, JSON.stringify({ identity, devices: [] }), 'utf8');
  const store = mobilepair.createStore({ file: storeFile });
  const tlsMaterial = mobiletls.ensureCert('127.0.0.1');
  const link = await mobilelink.start({
    crypto: mobilecrypto,
    pair: store,
    envelope: mobileenvelope,
    identity,
    app: { getAppPath: () => appRoot },
  }, { host: '127.0.0.1', port: 0, pollTimeoutMs: 1000 });

  try {
    equal(typeof mobilelink.offerPermission, 'undefined', 'دوال المقبض ليست على الوحدة');
    equal(typeof link.offerPermission, 'function', 'offerPermission على المقبض');
    equal(typeof link.withdraw, 'function', 'withdraw على المقبض');
    equal(typeof link.status, 'function', 'status على المقبض');
    equal(typeof link.stop, 'function', 'stop على المقبض');
    assert(link.url.startsWith('https://127.0.0.1:'), 'القناة الحقيقية HTTPS');
    equal(link.status().fingerprint, tlsMaterial.fingerprint, 'بصمة القناة هي بصمة الشهادة');

    // أصول PWA: كل أصل يشير إليه index.html **يجب أن يُخدَم فعلاً**. عطل مثبت حياً
    // (2026-08-12): وسم styles.css كان مفقوداً من index.html، فظهرت الشاشات الثلاث
    // مكدّسة بلا تنسيق على الهاتف بينما كل الاختبارات خضراء — لأن لا أحد كان يفحص
    // أن الصفحة تطلب أصولها وأن الخادم يخدمها.
    const indexHtml = fs.readFileSync(path.join(appRoot, 'pwa', 'index.html'), 'utf8');
    const referenced = [...indexHtml.matchAll(/(?:href|src)="([^"#:]+\.(?:css|js|webmanifest|svg))"/g)]
      .map((m) => m[1]);
    assert(referenced.includes('styles.css'), 'index.html يشير إلى ورقة الأنماط');
    assert(referenced.includes('app.js') && referenced.includes('crypto.js'), 'index.html يشير إلى سكربتات التطبيق');
    for (const asset of new Set(referenced)) {
      const res = await request(link.url + '/' + asset, tlsMaterial.cert, 'GET');
      equal(res.status, 200, 'الأصل يُخدَم من القناة: ' + asset);
      assert(res.body && res.body.length > 0, 'الأصل غير فارغ: ' + asset);
    }

    const rawPayload = store.buildPairingPayload();
    const buildPairingResult = loadMainPairingBuilder();
    const pairing = buildPairingResult(link.url + '/', rawPayload, tlsMaterial.fingerprint);
    equal(Object.keys(pairing).sort().join(','), 'expiresAt,fingerprint,ok,url', 'شكل رد IPC معلن فقط');
    equal(pairing.ok, true, 'نتيجة الاقتران ناجحة');
    equal(pairing.expiresAt, Math.floor(rawPayload.expiresAt), 'expiresAt خارج الرابط مطابق');

    const pwaCrypto = loadPwaCrypto();
    const parsePairingLink = loadPwaPairingParser(pwaCrypto);
    const envelopeFromFrame = loadPwaEnvelopeReader();
    // فشل مغلق: الشكل المسطّح (العطل نفسه) ونوع مجهول وظرف بلا معرّف كلها تُرفض
    equal(envelopeFromFrame({ envelope_id: 'toolu_flat', risk: 'exec' }), null,
      'الـPWA يرفض الظرف المسطّح بلا لفّ');
    equal(envelopeFromFrame({ v: 1, type: 'other', envelope: { envelope_id: 'x' } }), null,
      'الـPWA يرفض نوع إطار مجهول');
    equal(envelopeFromFrame({ v: 1, type: 'permission_request', envelope: { risk: 'exec' } }), null,
      'الـPWA يرفض ظرفاً بلا معرّف');
    equal(envelopeFromFrame(null), null, 'الـPWA يرفض إطاراً فارغاً');
    const parsed = parsePairingLink(pairing.url);
    equal(parsed.link.protocol, 'https:', 'PWA استقبل رابط HTTPS');
    equal(parsed.link.pathname, '/', 'الرابط على أصل PWA نفسه');
    equal(parsed.payload.url, link.url + '/', 'عنوان API داخل الحمولة هو الأصل نفسه');
    equal(Object.keys(parsed.payload).sort().join(','),
      'createdAt,desktopPublic,expiresAt,pairId,secret,url,v', 'حقول الحمولة المجمّدة فقط');
    equal(parsed.payload.secret, rawPayload.secret, 'السر لم يتغير أثناء base64url');

    const mobileKeys = await pwaCrypto.generateKeyPair();
    const deviceId = crypto.randomBytes(8).toString('hex');
    // نفس شكل PWA: mobilepair يقارن السر الخام، لا sha256(secret).
    const pairBody = Buffer.from(JSON.stringify({
      pairId: parsed.payload.pairId,
      secretProof: parsed.payload.secret,
      mobilePublic: mobileKeys.publicKey,
      deviceId,
      label: 'هاتف حارس التكامل',
    }), 'utf8');
    const paired = await request(new URL('pair', parsed.payload.url), tlsMaterial.cert, 'POST', pairBody, 'application/json');
    equal(paired.status, 200, 'الاقتران عبر HTTPS الحقيقي نجح');
    equal(json(paired).ok, true, 'الخادم قبل إثبات السر الخام');

    const session = await pwaCrypto.deriveSession({
      myPrivate: mobileKeys.privateKey,
      myPublic: mobileKeys.publicKey,
      theirPublic: parsed.payload.desktopPublic,
      pairId: parsed.payload.pairId,
      role: 'mobile',
    });

    for (const decision of ['allow', 'allow_turn', 'deny']) {
      const envelopeId = 'toolu_integration_' + decision;
      const settled = link.offerPermission(sampleRequest(envelopeId, decision), { ttlMs: 30000 });
      const polled = await request(
        new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
        tlsMaterial.cert,
        'GET'
      );
      equal(polled.status, 200, decision + ': الاستقصاء أعاد ظرفاً');
      const opened = await pwaCrypto.open(session, new Uint8Array(polled.body));
      const message = JSON.parse(new TextDecoder().decode(opened));
      equal(message.envelope.envelope_id, envelopeId, decision + ': الظرف الصحيح');
      // الحارس الحقيقي: نمرّر الإطار نفسه عبر دالة الـPWA الفعلية لا عبر قراءة
      // خاصة بالاختبار. كان العميل يقرأ `message.envelope` والهاتف يقرأ مسطّحاً،
      // فبقي الطقم أخضر بينما لا تظهر أي بطاقة على الجهاز (عطل مثبت حياً §5.5).
      const pwaEnvelope = envelopeFromFrame(message);
      assert(pwaEnvelope !== null, decision + ': الـPWA فكّ لفّ الإطار');
      equal(pwaEnvelope.envelope_id, envelopeId, decision + ': الـPWA قرأ الظرف نفسه');
      const frame = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
        envelope_id: message.envelope.envelope_id,
        decision,
      })));
      const replied = await request(
        new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
        tlsMaterial.cert,
        'POST',
        Buffer.from(frame)
      );
      equal(replied.status, 200, decision + ': الرد مقبول');
      equal(await settled, decision, decision + ': الوعد حُسم بالقيمة الصحيحة');
    }

    const staleFrame = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
      envelope_id: 'toolu_never_pending',
      decision: 'allow',
    })));
    const stale = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'POST',
      Buffer.from(staleFrame)
    );
    equal(stale.status, 409, 'رد ظرف غير معلّق مرفوض');
    equal(json(stale).error, 'not_pending', 'رفض الظرف غير المعلّق صريح');

    // ── الظرف المعلّق يسبق الجهاز ────────────────────────────────────────────
    // بلا هذا تصير الميزة رهينة توقيت مثالي: الطلب يضيع إن لم يكن الهاتف متصلاً
    // في اللحظة نفسها. الحالة الأصعب: جهاز **يقترن بعد** إدراج الظرف — يجب أن
    // يستلمه في أول استقصاء لأن الطابور عام لا لكل جهاز.
    const latePending = link.offerPermission(sampleRequest('toolu_late_device', 'allow'), { ttlMs: 30000 });
    const latePayload = store.buildPairingPayload();
    const lateLink = buildPairingResult(link.url + '/', latePayload, tlsMaterial.fingerprint);
    const lateParsed = parsePairingLink(lateLink.url);
    const lateKeys = await pwaCrypto.generateKeyPair();
    const lateDeviceId = crypto.randomBytes(8).toString('hex');
    const latePaired = await request(
      new URL('pair', lateParsed.payload.url),
      tlsMaterial.cert,
      'POST',
      Buffer.from(JSON.stringify({
        pairId: lateParsed.payload.pairId,
        secretProof: lateParsed.payload.secret,
        mobilePublic: lateKeys.publicKey,
        deviceId: lateDeviceId,
        label: 'هاتف اقترن بعد الطلب',
      }), 'utf8'),
      'application/json'
    );
    equal(latePaired.status, 200, 'الاقتران بعد وجود ظرف معلّق نجح');
    const lateSession = await pwaCrypto.deriveSession({
      myPrivate: lateKeys.privateKey,
      myPublic: lateKeys.publicKey,
      theirPublic: lateParsed.payload.desktopPublic,
      pairId: lateParsed.payload.pairId,
      role: 'mobile',
    });
    const latePoll = await request(
      new URL('poll?device=' + encodeURIComponent(lateDeviceId), lateParsed.payload.url),
      tlsMaterial.cert,
      'GET'
    );
    equal(latePoll.status, 200, 'الجهاز المتأخر استلم الظرف المعلّق في أول استقصاء');
    const lateMessage = JSON.parse(new TextDecoder().decode(
      await pwaCrypto.open(lateSession, new Uint8Array(latePoll.body))
    ));
    const lateEnvelope = envelopeFromFrame(lateMessage);
    assert(lateEnvelope !== null, 'الـPWA فكّ لفّ إطار الظرف المتأخر');
    equal(lateEnvelope.envelope_id, 'toolu_late_device', 'الظرف المتأخر هو نفسه');
    const lateReply = await request(
      new URL('reply?device=' + encodeURIComponent(lateDeviceId), lateParsed.payload.url),
      tlsMaterial.cert,
      'POST',
      Buffer.from(await pwaCrypto.seal(lateSession, new TextEncoder().encode(JSON.stringify({
        envelope_id: lateEnvelope.envelope_id,
        decision: 'allow',
      }))))
    );
    equal(lateReply.status, 200, 'قرار الجهاز المتأخر مقبول');
    equal(await latePending, 'allow', 'الوعد حُسم من جهاز اقترن بعد الطلب');

    // ── إعادة العرض بعد انقضاء المهلة (منطق main.js الحقيقي) ─────────────────
    // مربع سطح المكتب ينتظر الإنسان بلا حدّ ومهلة الظرف دقيقتان: بلا إعادة عرض
    // يُعرض الطلب مرة واحدة فقط ثم لا يراه أي جهاز يتصل بعدها أبداً.
    const resolved = [];
    const emitted = [];
    const offerTrace = [];
    const offerSandbox = {
      Promise, Date, String, Math, JSON,
      process: { env: {} },
      mobileControlEnabled: true,
      // مشدّ لا تجميل: `mobileenvelope.isRecord` يشترط أن يكون نموذج الكائن هو
      // `Object.prototype` **الخاص بهذا الـrealm** (حارس متعمّد ضد الكائنات الغريبة
      // والـgetters). كائنات الـvm نموذجها من realm آخر فيسقط البناء إلى ظرف بمعرّف
      // فارغ ترفضه القناة فوراً — وهو وضع لا يقع في الإنتاج حيث يتشارك main.js
      // والبنّاء الـrealm نفسه. النقل هنا يعيد الأمانة للإنتاج ولا يخفي شيئاً.
      mobileHandle: {
        offerPermission: (req, ctx) => link.offerPermission(
          JSON.parse(JSON.stringify(req)), JSON.parse(JSON.stringify(ctx))
        ),
        status: () => link.status(),
        withdraw: (envelopeId) => link.withdraw(envelopeId),
      },
      mobilePermissionRaces: new Map(),
      MOBILE_DECISIONS: new Set(['allow', 'allow_turn', 'deny']),
      MOBILE_PERMISSION_TTL_MS: 1000,
      runSeq: 7,
      SAFE_MOBILE_PERMISSION: /^[A-Za-z0-9_.:-]{1,256}$/,
      safeMobileDevices: () => [{ deviceId, revoked: false }],
      mobileDebug: (reason, extra) => { offerTrace.push(String(reason) + (extra ? ':' + JSON.stringify(extra) : '')); },
      resolvePermissionThroughCurrentHandles: (rid, allow, always, turn) => {
        resolved.push({ rid, allow, always, turn });
        return true;
      },
      emitToWindow: (obj) => { emitted.push(obj); },
    };
    const mainOffer = loadMainOffer(offerSandbox);
    mainOffer.offerMobilePermission(
      { id: 'toolu_reoffer', tool: 'Bash', input: { command: 'echo reoffer' } },
      { token: 7, cwd: appRoot, engine: 'sdk', sessionId: 'mobile-integration' }
    );
    // نافذتا مهلة كاملتان بلا أي جهاز يستقصي — الطلب يجب أن يبقى مطروحاً
    await new Promise((r) => setTimeout(r, 2400));
    assert(offerSandbox.mobilePermissionRaces.has('toolu_reoffer'),
      'الطلب ما زال مطروحاً بعد انقضاء مهلتين بلا استقصاء [' + offerTrace.join('>') + ']');
    equal(resolved.length, 0, 'لا حسم بلا قرار من الجوال');
    assert(offerTrace.some((entry) => entry.startsWith('offer_reoffer')),
      'إعادة العرض وقعت فعلاً بعد انقضاء المهلة');

    const reofferPoll = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'GET'
    );
    equal(reofferPoll.status, 200, 'جهاز استقصى بعد انقضاء المهلة استلم الظرف المُعاد');
    const reofferMessage = JSON.parse(new TextDecoder().decode(
      await pwaCrypto.open(session, new Uint8Array(reofferPoll.body))
    ));
    const reofferEnvelope = envelopeFromFrame(reofferMessage);
    assert(reofferEnvelope !== null, 'الـPWA فكّ لفّ الظرف المُعاد');
    equal(reofferEnvelope.envelope_id, 'toolu_reoffer', 'الظرف المُعاد هو الطلب نفسه');
    const reofferReply = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'POST',
      Buffer.from(await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
        envelope_id: 'toolu_reoffer',
        decision: 'deny',
      }))))
    );
    equal(reofferReply.status, 200, 'قرار الظرف المُعاد مقبول');
    await new Promise((r) => setTimeout(r, 150));
    equal(resolved.length, 1, 'الحسم وقع مرة واحدة');
    equal(resolved[0].rid, 'toolu_reoffer', 'الحسم للطلب نفسه');
    equal(resolved[0].allow, false, 'الرفض وصل رفضاً');
    equal(resolved[0].always, false, 'always ثابت false مهما كان رد القناة');
    equal(emitted.length, 1, 'حدث واحد للواجهة');
    equal(emitted[0].type, 'mobile_decision', 'نوع الحدث mobile_decision');
    assert(!offerSandbox.mobilePermissionRaces.has('toolu_reoffer'), 'المدخل حُذف بعد الحسم');

    // ── حفظ الجلسة: استحالة إعادة استعمال nonce عبر الانهيارات ───────────────
    // العدّاد يدخل الـnonce مباشرةً في AES-GCM (‏prefix||counter). استئناف بعدّاد
    // مصفَّر بعد إعادة تحميل = إعادة استعمال nonce على المفتاح نفسه ⇒ انهيار
    // الأصالة والسرّية. نُثبت الخاصية على **بايتات الإطارات الحقيقية** لا على
    // المنطق وحده: نختم بـcrypto.js الحقيقي ونستخرج العدّاد من الترويسة.
    const durable = { record: null };
    const storeSandbox = {
      Promise, Number, Uint8Array, JSON,
      state: null,
      COUNTER_BLOCK: 8,
      dbPut: (record) => { durable.record = record; return Promise.resolve(true); },
      dbGet: () => Promise.resolve(durable.record),
    };
    loadPwaSessionStore(storeSandbox);
    const freshSession = await pwaCrypto.deriveSession({
      myPrivate: mobileKeys.privateKey,
      myPublic: mobileKeys.publicKey,
      theirPublic: parsed.payload.desktopPublic,
      pairId: parsed.payload.pairId,
      role: 'mobile',
    });
    storeSandbox.state = {
      serverUrl: parsed.payload.url,
      deviceId,
      pairId: parsed.payload.pairId,
      session: freshSession,
      sendReserved: 0,
    };
    const wireCounters = [];
    let restores = 0;
    for (let round = 0; round < 4; round += 1) {
      // رسائل داخل الكتلة الواحدة وعبر حدّها (‏COUNTER_BLOCK = 8)
      for (let i = 0; i < 3 + round * 4; i += 1) {
        await storeSandbox.reserveSendCounters();
        const sealed = await pwaCrypto.seal(
          storeSandbox.state.session,
          new TextEncoder().encode('decision-' + round + '-' + i)
        );
        const view = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength);
        wireCounters.push(Number(view.getBigUint64(2, false)));
      }
      // انهيار: تُمحى الذاكرة بالكامل ولا يبقى إلا ما ثبت على القرص
      storeSandbox.state = { serverUrl: '', deviceId: '', pairId: '', session: null, sendReserved: 0 };
      assert(await storeSandbox.restoreSession(), 'استُعيدت الجلسة المحفوظة بعد الانهيار');
      restores += 1;
    }
    equal(restores, 4, 'أربع دورات استعادة');
    equal(new Set(wireCounters).size, wireCounters.length,
      'لا يتكرر أي عدّاد إرسال على السلك عبر الانهيارات (‏nonce فريد دائماً)');
    for (let i = 1; i < wireCounters.length; i += 1) {
      assert(wireCounters[i] > wireCounters[i - 1], 'العدّادات تتزايد تزايداً صارماً');
    }
    // الحالة الأخطر: انهيار بعد الحجز مباشرةً وقبل أي ختم
    await storeSandbox.reserveSendCounters();
    const reservedBeforeCrash = storeSandbox.state.sendReserved;
    storeSandbox.state = { serverUrl: '', deviceId: '', pairId: '', session: null, sendReserved: 0 };
    assert(await storeSandbox.restoreSession(), 'استعادة بعد الحجز مباشرةً');
    equal(storeSandbox.state.session.counterSend, reservedBeforeCrash,
      'الاستئناف من السقف المحجوز لا من آخر عدّاد مستعمل');
    assert(storeSandbox.state.session.counterSend > wireCounters[wireCounters.length - 1],
      'العدّاد المستأنف أكبر من كل ما استُعمل فعلاً');
    // المفتاح لا يُصدَّر أبداً: حتى لو سُرّب المخزن يبقى غير قابل للتصدير
    equal(durable.record.keySend.extractable, false, 'مفتاح الإرسال المحفوظ غير قابل للتصدير');
    equal(durable.record.keyRecv.extractable, false, 'مفتاح الاستقبال المحفوظ غير قابل للتصدير');
    assert(!('privateKey' in durable.record) && !('myPrivate' in durable.record),
      'لا يُحفظ المفتاح الخاص إطلاقاً');
    // الجلسة المستعادة تعمل فعلاً مع الطرف المقابل (لا مجرد بنية سليمة)
    const restoredFrame = await pwaCrypto.seal(
      storeSandbox.state.session,
      new TextEncoder().encode('ping')
    );
    const desktopKeys = store.getDesktopKeyPair();
    const desktopSession = mobilecrypto.deriveSession({
      myPrivate: desktopKeys.privateKey,
      myPublic: desktopKeys.publicKey,
      theirPublic: mobileKeys.publicKey,
      pairId: parsed.payload.pairId,
      role: 'desktop',
    });
    const desktopOpened = mobilecrypto.open(desktopSession, Buffer.from(restoredFrame));
    equal(new TextDecoder().decode(desktopOpened), 'ping', 'سطح المكتب فكّ إطار الجلسة المستعادة');

    // القناة المتوقفة تردّ فوراً: يجب التوقف لا الدوران في حلقة ساخنة
    const deadSandbox = Object.assign({}, offerSandbox, {
      mobilePermissionRaces: new Map(),
      mobileHandle: { offerPermission: () => Promise.resolve(null), status: () => ({}) },
    });
    const deadOffer = loadMainOffer(deadSandbox);
    deadOffer.offerMobilePermission(
      { id: 'toolu_dead_channel', tool: 'Bash', input: { command: 'echo dead' } },
      { token: 7, cwd: appRoot, engine: 'sdk', sessionId: 'mobile-integration' }
    );
    await new Promise((r) => setTimeout(r, 300));
    assert(!deadSandbox.mobilePermissionRaces.has('toolu_dead_channel'),
      'الرفض الفوري يوقف العرض بلا حلقة ساخنة');
  } finally {
    await link.stop();
  }
}

run()
  .then(() => { console.log('mobile-integration-test: ok — ' + checks + ' فحصاً عبر HTTPS/WebCrypto الحقيقيين.'); })
  .catch((error) => {
    console.error('mobile-integration-test: FAIL:', error && error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* لا يؤثر على النتيجة */ }
  });
