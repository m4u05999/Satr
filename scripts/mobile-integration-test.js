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
  return vm.runInNewContext('(' + source.slice(start, end) + ')', context, { filename: 'electron/main.js' });
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
