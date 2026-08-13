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

/**
 * قارئ لقطة الحالة كما يقرؤها الهاتف نفسه (‏§7.7.6/د).
 *
 * وجود هذه الدالة **شرط بنيوي**: `envelopeFromFrame` أحادي النوع بفشل مغلق، فلو
 * بقي القارئ الوحيد لسقط كل إطار حالة صامتاً — وهو حرفياً عطل §5.5.5 الذي أبقى 43
 * فحصاً خضراء بينما لا تصل بطاقة واحدة إلى الجهاز. غيابها يرمي هنا قبل أي تأكيد.
 */
function loadPwaStateReader() {
  const source = fs.readFileSync(path.join(appRoot, 'pwa', 'app.js'), 'utf8');
  return sourceFunction(source, 'stateFromFrame', {});
}

/**
 * حارس ساكن: لوحة الحالة **قابلة للظهور فعلاً** لا مجرد وصول بياناتها.
 *
 * ⚠️ عطل مثبت حياً (2026-08-13): كانت اللوحة تحمل `hidden` في الترميز، و`.hidden`
 * تُعرَّف `display:none !important` فتغلب `.state-panel.active { display:flex }`.
 * النتيجة: لقطات الحالة تصل وتُقبل وتُحلَّل بنجاح، ولا يظهر شيء على الهاتف أبداً.
 *
 * الدرس: كل فحوص قناة الحالة كانت تثبت أن اللقطة **تصل**، ولا واحد يثبت أنها
 * **تُعرض**. البيانات صحيحة والبكسل غائب — صنفٌ لا يمسكه اختبار عقد بحال.
 */
function assertStatePanelVisible() {
  const html = fs.readFileSync(path.join(appRoot, 'pwa', 'index.html'), 'utf8');
  const match = html.match(/<div id="statePanel"[^>]*class="([^"]*)"/);
  assert(match !== null, 'ترميز الهاتف يحوي لوحة الحالة #statePanel');
  if (!match) return;
  const classes = match[1].split(/\s+/).filter(Boolean);
  assert(classes.includes('state-panel'), 'لوحة الحالة تحمل صنفها الأساسي');
  // `.state-panel { display:none }` تكفي للإخفاء الافتراضي؛ `hidden` فوقها تجعل
  // الإظهار مستحيلاً لأن `!important` يغلب `.active`
  assert(!classes.includes('hidden'),
    'لوحة الحالة لا تُولد بصنف hidden — يغلب !important صنفَ active فلا تظهر أبداً');

  const css = fs.readFileSync(path.join(appRoot, 'pwa', 'styles.css'), 'utf8');
  assert(/\.state-panel\.active\s*\{[^}]*display\s*:/.test(css),
    'CSS يعرّف حالة الإظهار .state-panel.active');
}

/**
 * حارس ساكن: نشر الحالة **موصول فعلاً** بالنقلين وبنقاط البثّ.
 *
 * نظير `assertStopWiring` وللسبب نفسه: عقدٌ صحيح على الطرفين لا يعني وصلاً. صنف
 * عطل `awaitPairing` (§7.5هـ/3) أوقف الميزة كلها بنقطة إطلاق منسيّة.
 */
function assertStateWiring() {
  const source = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8');
  assert(/function publishMobileState\s*\(/.test(source), 'main.js يعرّف publishMobileState');
  assert(/mobileStateBoot\s*=\s*randomBytes\(/.test(source), 'main.js يولّد boot مرة لكل عملية');
  // النقلان يكشفان publishState بالاسم نفسه، فلا يتعلّم main.js نقلين
  const linkSource = fs.readFileSync(path.join(appRoot, 'electron', 'mobilelink.js'), 'utf8');
  const relaySource = fs.readFileSync(path.join(appRoot, 'electron', 'mobilerelay.js'), 'utf8');
  assert(/publishState\s*[,:]/.test(linkSource), 'القناة المحلية تكشف publishState');
  assert(/publishState\s*[,:]/.test(relaySource), 'الوسيط يكشف publishState');
  // نقاط البثّ التسع من §7.7.6/ز — غياب أيٍّ منها يعمي الهاتف عن انتقال حقيقي
  for (const [needle, label] of [
    ["phase: 'waiting_permission'", 'عرض الإذن'],
    ["phase: 'stopped'", 'قبول الإيقاف'],
    ["phase: 'working'", 'بدء الدور'],
  ]) {
    assert(source.includes(needle), 'main.js يبثّ لقطة عند ' + label);
  }
  assert(/setInterval\([\s\S]{0,200}?publishMobileState\(\)/.test(source), 'نبضة دورية مربوطة');
  assert(/mobileStateHeartbeat\.unref/.test(source), 'مؤقّت النبضة unref فلا يمنع الإغلاق');

  /* ⚠️ عطل مثبت حياً (2026-08-13): `finishMobileRunState` تُستدعى لـ`result` **ثم**
   * `proc_done`، والثاني بلا كلفة. تمريره `cost_usd: null` كان يدوس القيمة الصحيحة
   * فلا تصل الكلفة الهاتف أبداً. نثبت المنطق النقي نفسه (`mobileResultCost`) ونثبت
   * أن الدالة لا تمرّر الحقل بلا شرط. */
  const resultCost = sourceFunction(source, 'mobileResultCost', {});
  equal(resultCost({ total_cost_usd: 0.1455 }), 0.1455, 'الكلفة تُقرأ من total_cost_usd');
  equal(resultCost({ usage: { cost_usd: 0.5 } }), 0.5, 'وتُقرأ من usage.cost_usd احتياطاً');
  equal(resultCost({ type: 'proc_done' }), null, 'proc_done بلا كلفة يعيد null');
  equal(resultCost(null), null, 'حدث فارغ يعيد null');
  const finishBody = source.match(/function finishMobileRunState\([\s\S]{0,900}?\n}/);
  assert(finishBody !== null, 'main.js يعرّف finishMobileRunState');
  if (finishBody) {
    assert(!/publishMobileState\(\{[^}]*cost_usd:\s*mobileResultCost/.test(finishBody[0]),
      'نهاية الدور لا تمرّر cost_usd بلا شرط — proc_done يدوس كلفة result');
    assert(/cost !== null/.test(finishBody[0]),
      'نهاية الدور تمرّر الكلفة فقط حين تُعرف');
  }
}

/**
 * قفل الموافقة كما يحكمه الهاتف نفسه (‏F5). نستخرج دالة `pwa/app.js` الحقيقية
 * لا نعيد كتابة قاعدتها هنا: الحارس الذي يختبر قراءته هو — لا قراءة الهاتف —
 * هو بالضبط ما ترك العطل الثامن يمرّ (§5.5.5).
 */
function loadPwaAllowGate() {
  const source = fs.readFileSync(path.join(appRoot, 'pwa', 'app.js'), 'utf8');
  return sourceFunction(source, 'canAllowFromPhone', {});
}

/**
 * حارس ساكن: مقبض الإيقاف **موصول فعلاً** بالنقلين.
 *
 * نمط «موصول لكن غير مربوط» أوقف الميزة كلها من قبل: `mobilerelay` كان يعرض
 * `awaitPairing` و`main.js` لا يناديه (§7.5هـ/3). عقدٌ صحيح على الطرفين لا يعني
 * وصلاً — ولا يمسك الغيابَ اختبارٌ يشغّل كل طرف وحده.
 */
function assertStopWiring() {
  const source = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8');
  assert(/function handleMobileStop\s*\(/.test(source), 'main.js يعرّف handleMobileStop');
  const wired = source.match(/onStop\s*:\s*handleMobileStop/g) || [];
  equal(wired.length, 2, 'main.js يصل handleMobileStop بالنقلين (محلي + وسيط)');
  assert(/mobileRunToken = randomBytes\(/.test(source), 'main.js يولّد رمز دور معتم لكل دور');
  assert(/run:\s*mobileRunToken/.test(source), 'main.js يمرّر رمز الدور إلى الظرف');
  // الإيقاف يمر بمسار satr:stop نفسه لا بمسار ثانٍ يتباعد عنه
  assert(/function handleMobileStop[\s\S]{0,900}stopAll\(false\)/.test(source),
    'الإيقاف من الجوال يستدعي stopAll نفسه');
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
  // رمز الدور المعتم ومقبض الإيقاف: يُحقنان كما يفعل main.js، ونراقب الاستدعاء (§7.7.5)
  const CURRENT_RUN = 'a1b2c3d4e5f60718';
  const stopDeps = { onStop: () => false };
  // عدّاد طلبات الحالة المُجابة: الخنق يُقاس بما وصل سطح المكتب فعلاً لا بما أُرسل
  const stateReq = { answered: 0 };
  const link = await mobilelink.start({
    crypto: mobilecrypto,
    pair: store,
    envelope: mobileenvelope,
    identity,
    app: { getAppPath: () => appRoot },
    onStop: (run) => stopDeps.onStop(run),
    onStateRequest: () => { stateReq.answered += 1; return true; },
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
      'createdAt,desktopPublic,expiresAt,pairId,secret,url,v',
      'الوضع المحلي: الحقول السبعة المجمّدة فقط (بلا relay)');

    // توسعة §7: وجود `relay` هو ما يحوّل الهاتف إلى وضع الوسيط — وغيابه لا يغيّر شيئاً
    const relayPairing = buildPairingResult(
      'https://relay.example/', rawPayload, '', 'https://relay.example'
    );
    const relayParsed = parsePairingLink(relayPairing.url);
    equal(Object.keys(relayParsed.payload).sort().join(','),
      'createdAt,desktopPublic,expiresAt,pairId,relay,secret,url,v',
      'وضع الوسيط: حقل relay وحده يُضاف');
    equal(relayParsed.payload.relay, 'https://relay.example', 'عنوان الوسيط في الحمولة');
    assert(!('fingerprint' in relayParsed.payload), 'لا بصمة شهادة في وضع الوسيط');
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

    /* ───── F5: الفرق يعبر القناة الحقيقية، والقفل يحكمه منطق الهاتف نفسه ─────
     * كل ما دون ذلك يختبر قراءة الحارس لا قراءة الهاتف — وهو ما ترك العطل
     * الثامن يمرّ بينما 43 فحصاً خضراء (§5.5.5).
     */
    assertStopWiring();

    const allowGate = loadPwaAllowGate();
    const writeCases = [
      {
        id: 'toolu_change_visible',
        input: { file_path: 'a.js', old_string: 'let a = 1;', new_string: 'let a = 2;' },
        allowed: true,
        label: 'تغيير معروض كاملاً',
      },
      {
        id: 'toolu_change_secret',
        input: { file_path: 'a.js', old_string: 'k = "old";', new_string: 'k = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";' },
        allowed: false,
        label: 'تغيير يحمل سرّاً',
      },
      {
        id: 'toolu_change_huge',
        input: { file_path: 'big.js', content: Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n') },
        tool: 'Write',
        allowed: false,
        label: 'تغيير أكبر من السقف',
      },
    ];
    for (const testCase of writeCases) {
      const settled = link.offerPermission({
        id: testCase.id,
        tool: testCase.tool || 'Edit',
        input: testCase.input,
        cwd: appRoot,
        engine: 'sdk',
        session_id: 'mobile-integration',
      }, { ttlMs: 30000 });
      const polled = await request(
        new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
        tlsMaterial.cert,
        'GET'
      );
      equal(polled.status, 200, testCase.label + ': وصل الظرف');
      const opened = await pwaCrypto.open(session, new Uint8Array(polled.body));
      const pwaEnvelope = envelopeFromFrame(JSON.parse(new TextDecoder().decode(opened)));
      assert(pwaEnvelope !== null, testCase.label + ': الهاتف فكّ الإطار');
      assert(pwaEnvelope.change, testCase.label + ': بطاقة التغيير عبرت القناة');
      equal(allowGate(pwaEnvelope), testCase.allowed, testCase.label + ': قفل «اسمح» كما يحكمه الهاتف');

      if (testCase.allowed) {
        assert(pwaEnvelope.change.lines.some((line) => line.t === '+'),
          testCase.label + ': الفرق وصل الهاتف بأسطره');
      } else {
        // لا يكفي قفل الزر: يجب ألا تعبر بايتة من المحتوى المتعذّر عرضه
        equal(pwaEnvelope.change.status, 'unavailable', testCase.label + ': الحالة معلنة');
        assert(!('lines' in pwaEnvelope.change), testCase.label + ': لا أسطر مع التعذّر');
      }
      const frame = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
        envelope_id: testCase.id,
        decision: 'deny',
      })));
      await request(
        new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
        tlsMaterial.cert,
        'POST',
        Buffer.from(frame)
      );
      equal(await settled, 'deny', testCase.label + ': الرفض يبقى متاحاً دائماً');
    }
    // القفل fail-closed من الجهتين: خطر كتابة بلا بطاقة (أداة كتابة مستقبلية لم
    // يعرفها بناء الظرف) يجب أن يُقفل لا أن يمرّ.
    equal(allowGate({ risk: 'write' }), false, 'خطر كتابة بلا بطاقة تغيير يُقفل');
    equal(allowGate(null), false, 'ظرف فارغ يُقفل');

    // قائمة سماح لا قائمة منع: الفئات المعروفة يُعرض فعلها الحرفي في summary
    for (const risk of ['read', 'exec', 'browser']) {
      equal(allowGate({ risk }), true, 'فئة معروفة تبقى قابلة للموافقة: ' + risk);
    }
    // أداة مجهولة ⇒ قفل. «لا أعرف ما هذا» هو وقت التأجيل إلى الحاسوب لا وقت الختم.
    equal(allowGate({ risk: 'unknown' }), false, 'أداة مجهولة تُقفل');
    equal(allowGate({}), false, 'ظرف بلا فئة خطر يُقفل');
    equal(allowGate({ risk: 'future_class' }), false, 'فئة خطر مستقبلية تُقفل حتى تُدرَج');

    // والمسار الحقيقي: أداة MCP جديدة تعبر القناة ⇒ يقفلها الهاتف
    const unknownId = 'toolu_unknown_tool';
    const unknownSettled = link.offerPermission({
      id: unknownId,
      tool: 'some_new_mcp_tool',
      input: { anything: 'x' },
      cwd: appRoot,
      engine: 'sdk',
      session_id: 'mobile-integration',
    }, { ttlMs: 30000 });
    const unknownPolled = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'GET'
    );
    equal(unknownPolled.status, 200, 'أداة مجهولة: وصل الظرف');
    const unknownEnvelope = envelopeFromFrame(
      JSON.parse(new TextDecoder().decode(await pwaCrypto.open(session, new Uint8Array(unknownPolled.body))))
    );
    equal(unknownEnvelope.risk, 'unknown', 'أداة مجهولة: الفئة unknown');
    equal(allowGate(unknownEnvelope), false, 'أداة مجهولة عبر القناة: الموافقة مقفلة');
    const unknownFrame = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
      envelope_id: unknownId,
      decision: 'deny',
    })));
    await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'POST',
      Buffer.from(unknownFrame)
    );
    equal(await unknownSettled, 'deny', 'أداة مجهولة: الرفض يبقى متاحاً');

    /* ── قناة الحالة (§7.7.6) — فحوص الوصل ──────────────────────────────────
     * ما لا يستطيع منفّذٌ يرى طرفاً واحداً كتابته: لقطة حقيقية يبنيها سطح المكتب،
     * تُختم وتعبر القناة المعمّاة، ثم تُغذّى إلى **دالة الهاتف نفسها**. كل طرف
     * كان أخضر وحده في الأعطال الثمانية؛ الناقص دائماً هو الوصل.
     */
    assertStateWiring();
    assertStatePanelVisible();
    const stateFromFrame = loadPwaStateReader();
    equal(typeof link.publishState, 'function', 'publishState على مقبض القناة المحلية');

    const snapshot = {
      boot: 'aabbccdd',
      seq: 1,
      run: CURRENT_RUN,
      phase: 'working',
      project: 'satr-2',
      task: 'بناء قناة الحالة',
      tasks: { total: 4, pending: 1, in_progress: 1, completed: 2, blocked: 0 },
      edits: { files: 3, added: 91, removed: 12 },
      cost_usd: 0.1234,
      verify: 'pass',
    };
    equal(link.publishState(snapshot), true, 'سطح المكتب نشر لقطة حالة');

    const statePolled = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'GET'
    );
    equal(statePolled.status, 200, 'لقطة الحالة عبرت القناة بلا ظرف معلّق');
    const stateText = new TextDecoder().decode(
      await pwaCrypto.open(session, new Uint8Array(statePolled.body))
    );
    const stateMessage = JSON.parse(stateText);

    // العضّة البنيوية: القارئ الصارم يرفض إطار الحالة. لولا الدالة الشقيقة لسقط
    // كل إطار صامتاً — الهاتف يستقصي بلا انقطاع ولا يظهر شيء (عطل §5.5.5 حرفياً).
    equal(envelopeFromFrame(stateMessage), null, 'قارئ الظرف يرفض إطار الحالة (فشل مغلق)');
    const phoneState = stateFromFrame(stateMessage);
    assert(phoneState !== null, 'الهاتف قبِل اللقطة بدالته الحقيقية عبر القناة');
    equal(phoneState.phase, 'working', 'الهاتف قرأ حالة الدور');
    equal(phoneState.run, CURRENT_RUN, 'اللقطة تحمل رمز الدور نفسه الذي يحمله الظرف');
    equal(phoneState.project, 'satr-2', 'اسم المشروع عبر كما هو');
    equal(phoneState.tasks.completed, 2, 'عدّادات المهام عبرت');
    equal(phoneState.edits.added, 91, 'إحصاءات التعديلات عبرت');
    equal(phoneState.verify, 'pass', 'نتيجة التحقق عبرت');

    // القائمة المغلقة على الإطار الذي عبر فعلاً — لا على كائن بناه الاختبار
    equal(Object.keys(phoneState).sort().join(','),
      'boot,cost_usd,edits,phase,project,run,seq,task,tasks,ttl_ms,verify',
      'اللقطة أحد عشر حقلاً بالضبط — لا عاشر ولا ثاني عشر');
    // لا طابع زمني إطلاقاً: هو ما يجعل قياس الإيجار من ساعة المكتب **مستحيلاً بنيوياً**
    for (const stamp of ['at', 'ts', 'timestamp', 'updated_at', 'now']) {
      assert(!(stamp in phoneState), 'اللقطة بلا طابع زمني: ' + stamp);
    }
    // الممنوعات على النص المُسلسَل الذي عبر القناة
    for (const forbidden of ['session_id', 'cwd', 'engine', 'filename', 'prompt', appRoot]) {
      assert(!stateText.includes(forbidden), 'إطار الحالة لا يحمل: ' + forbidden);
    }
    // مسار ويندوز (`C:\`) أو أصل شبكي (`://`) — القائمة المغلقة تمنعهما بنيوياً،
    // وهذا الفحص يمسك تسريباً داخل نصٍّ حرّ لو تسلّل يوماً عبر `project` أو `task`.
    assert(!/[A-Za-z]:\\/.test(stateText), 'إطار الحالة بلا مسار ويندوز');
    assert(!stateText.includes('://'), 'إطار الحالة بلا أصل شبكي');

    // السرّ في عنوان المهمة يُسقط العنوان ويُبقي العدّادات صادقة (§7.7.6/أ)
    equal(link.publishState({
      ...snapshot, seq: 2, task: 'استعمل sk-ant-api03-0123456789abcdef0123456789abcdef',
    }), true, 'نُشرت لقطة بعنوان يحمل سرّاً');
    const secretPolled = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'GET'
    );
    const secretText = new TextDecoder().decode(
      await pwaCrypto.open(session, new Uint8Array(secretPolled.body))
    );
    const secretState = stateFromFrame(JSON.parse(secretText));
    assert(secretState !== null, 'الهاتف قبِل اللقطة بعد إسقاط العنوان');
    equal(secretState.task, '', 'عنوان يحمل سرّاً يسقط كلياً');
    equal(secretState.tasks.completed, 2, 'العدّادات تبقى صادقة رغم إسقاط العنوان');
    assert(!secretText.includes('sk-ant-api03'), 'السرّ لم يعبر القناة إطلاقاً');

    // الأولوية: الإذن سؤالٌ ينتظر قراراً، والحالة لا تزاحمه
    const raceId = 'toolu_state_priority';
    const raceSettled = link.offerPermission(sampleRequest(raceId, 'deny'), { ttlMs: 30000 });
    equal(link.publishState({ ...snapshot, seq: 3, phase: 'waiting_permission' }), true,
      'نُشرت لقطة بينما ظرف معلّق');
    const racePolled = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'GET'
    );
    const raceMessage = JSON.parse(new TextDecoder().decode(
      await pwaCrypto.open(session, new Uint8Array(racePolled.body))
    ));
    equal(raceMessage.type, 'permission_request', 'الأولوية للإذن على الحالة');
    const raceFrame = await pwaCrypto.seal(session, new TextEncoder().encode(
      JSON.stringify({ envelope_id: raceId, decision: 'deny' })
    ));
    await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'POST', Buffer.from(raceFrame)
    );
    equal(await raceSettled, 'deny', 'الظرف حُسم بعد أن سبق الحالة');

    // `state_request`: قراءة محضة خارج DECISIONS، ومخنوقة لكل جهاز
    stateReq.answered = 0;
    for (const attempt of [1, 2]) {
      const askFrame = await pwaCrypto.seal(session, new TextEncoder().encode(
        JSON.stringify({ type: 'state_request' })
      ));
      const askRes = await request(
        new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
        tlsMaterial.cert, 'POST', Buffer.from(askFrame)
      );
      equal(askRes.status, 200, 'طلب الحالة ' + attempt + ' قُبل شكلاً');
    }
    equal(stateReq.answered, 1, 'الخنق: طلبان متتاليان يُجابان مرة واحدة');

    // «state_request» كقرار يُرفض — DECISIONS لم تتوسّع (نظير «stop»)
    const stateAsDecisionFrame = await pwaCrypto.seal(session, new TextEncoder().encode(
      JSON.stringify({ envelope_id: 'toolu_x', decision: 'state_request' })
    ));
    const stateAsDecisionRes = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'POST', Buffer.from(stateAsDecisionFrame)
    );
    equal(stateAsDecisionRes.status, 400, 'state_request كقرار مرفوض');
    equal(json(stateAsDecisionRes).error, 'bad_decision', 'ورمزه bad_decision');

    /* ───── §7.7.5: الإيقاف نوع رسالة مستقل، ويوقف الدور فعلاً ─────
     * كان `stopAgent()` يوقف الاستقصاء محلياً ويعلن «متوقف يدوياً» بلا إرسال بايتة،
     * والوكيل يواصل الكتابة في ملفات المستخدم.
     */
    const stopCalls = [];
    stopDeps.onStop = (run) => { stopCalls.push(run); return run === CURRENT_RUN; };

    // رمز الدور يصل الهاتف داخل الظرف — بلا ذلك لا يعرف ماذا يوقف
    const runSettled = link.offerPermission({
      id: 'toolu_run_token', tool: 'Bash', input: { command: 'sleep 1' },
      cwd: appRoot, engine: 'sdk', session_id: 'mobile-integration',
    }, { ttlMs: 30000, run: CURRENT_RUN });
    const runPolled = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'GET'
    );
    const runEnvelope = envelopeFromFrame(
      JSON.parse(new TextDecoder().decode(await pwaCrypto.open(session, new Uint8Array(runPolled.body))))
    );
    equal(runEnvelope.run, CURRENT_RUN, 'رمز الدور المعتم وصل الهاتف داخل الظرف');

    // أمر إيقاف بالرمز الصحيح ⇒ يصل سطح المكتب فعلاً
    const stopFrame = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
      type: 'stop', run: CURRENT_RUN,
    })));
    const stopped = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'POST', Buffer.from(stopFrame)
    );
    equal(stopped.status, 200, 'أمر الإيقاف قُبل');
    equal(stopCalls.length, 1, 'سطح المكتب استُدعي مرة واحدة للإيقاف');
    equal(stopCalls[0], CURRENT_RUN, 'وصل رمز الدور الصحيح');

    // رمز دور قديم ⇒ يُرفض ولا يقتل دوراً لاحقاً بريئاً
    const staleStop = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
      type: 'stop', run: 'ffffffffffffffff',
    })));
    const staleStopRes = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'POST', Buffer.from(staleStop)
    );
    equal(staleStopRes.status, 409, 'رمز دور قديم يُرفض');
    equal(stopCalls.length, 2, 'وصل الأمر لكن الرمز لم يطابق');

    // رمز مشوّه ⇒ يُرفض **قبل** بلوغ سطح المكتب
    const badStop = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
      type: 'stop', run: 'not-a-run-token',
    })));
    const badStopRes = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'POST', Buffer.from(badStop)
    );
    equal(badStopRes.status, 400, 'رمز مشوّه يُرفض');
    equal(stopCalls.length, 2, 'الرمز المشوّه لم يبلغ سطح المكتب أصلاً');

    // الإيقاف **ليس قراراً رابعاً**: القائمة المغلقة لم تتوسّع
    const fakeDecision = await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
      envelope_id: 'toolu_run_token', decision: 'stop',
    })));
    const fakeRes = await request(
      new URL('reply?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert, 'POST', Buffer.from(fakeDecision)
    );
    equal(fakeRes.status, 400, '«stop» كقرار رابع مرفوض — القائمة المغلقة لم تتوسّع');

    link.withdraw('toolu_run_token');
    await runSettled;

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
      // رمز الدور المعتم كما يضبطه main.js عند بدء كل دور (§7.7.5)
      mobileRunToken: CURRENT_RUN,
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

    // ── استئناف جلسات سطح المكتب بعد إعادة تشغيل «سطر» ───────────────────────
    // جلسات سطح المكتب في الذاكرة وحدها: بلا استئناف يلزم اقتران جديد بعد كل
    // إعادة تشغيل. والاستئناف الساذج أخطر من العطل — إعادة اشتقاق بعدّاد مصفَّر
    // تعيد استعمال nonce على اتجاه D2M. نُثبت الأمرين على بايتات السلك.
    const d2mCounters = [];
    const readD2MCounter = (frameBytes) => {
      const view = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
      return Number(view.getBigUint64(2, false));
    };
    const beforePending = link.offerPermission(sampleRequest('toolu_before_restart', 'allow'), { ttlMs: 30000 });
    const beforePoll = await request(
      new URL('poll?device=' + encodeURIComponent(deviceId), parsed.payload.url),
      tlsMaterial.cert,
      'GET'
    );
    equal(beforePoll.status, 200, 'ظرف قبل إعادة التشغيل');
    d2mCounters.push(readD2MCounter(beforePoll.body));
    link.withdraw('toolu_before_restart');
    equal(await beforePending, null, 'سُحب الظرف قبل إعادة التشغيل');

    // إعادة تشغيل حقيقية: مخزن جديد يُحمَّل من القرص + قناة جديدة بذاكرة جلسات فارغة
    const store2 = mobilepair.createStore({ file: storeFile });
    const link2 = await mobilelink.start({
      crypto: mobilecrypto,
      pair: store2,
      envelope: mobileenvelope,
      identity,
      app: { getAppPath: () => appRoot },
    }, { host: '127.0.0.1', port: 0, pollTimeoutMs: 1000 });
    try {
      const restartUrl = link2.url + '/';
      const afterPending = link2.offerPermission(sampleRequest('toolu_after_restart', 'deny'), { ttlMs: 30000 });
      const afterPoll = await request(
        new URL('poll?device=' + encodeURIComponent(deviceId), restartUrl),
        tlsMaterial.cert,
        'GET'
      );
      equal(afterPoll.status, 200, 'الجهاز نفسه يعمل بعد إعادة التشغيل بلا اقتران جديد');
      d2mCounters.push(readD2MCounter(afterPoll.body));
      equal(new Set(d2mCounters).size, d2mCounters.length,
        'عدّاد D2M لا يتكرر عبر إعادة التشغيل (‏nonce فريد)');
      assert(d2mCounters[1] > d2mCounters[0], 'العدّاد المستأنف أعلى مما استُعمل');

      // الجلسة المستأنفة تفكّ فعلاً بمفاتيح الهاتف نفسها (لا مجرد ردّ 200)
      const afterMessage = JSON.parse(new TextDecoder().decode(
        await pwaCrypto.open(session, new Uint8Array(afterPoll.body))
      ));
      const afterEnvelope = envelopeFromFrame(afterMessage);
      assert(afterEnvelope !== null, 'الهاتف فكّ إطار الجلسة المستأنفة');
      equal(afterEnvelope.envelope_id, 'toolu_after_restart', 'الظرف الصحيح بعد إعادة التشغيل');

      // والاتجاه المعاكس: ردّ الهاتف يُفكّ ويحسم على القناة الجديدة
      const afterReply = await request(
        new URL('reply?device=' + encodeURIComponent(deviceId), restartUrl),
        tlsMaterial.cert,
        'POST',
        Buffer.from(await pwaCrypto.seal(session, new TextEncoder().encode(JSON.stringify({
          envelope_id: 'toolu_after_restart',
          decision: 'deny',
        }))))
      );
      equal(afterReply.status, 200, 'ردّ الهاتف مقبول بعد إعادة التشغيل');
      equal(await afterPending, 'deny', 'القرار حُسم عبر جلسة مستأنفة');

      // سجل قديم بلا pairId لا يُستأنف: فشل مغلق يطلب اقتراناً جديداً لا تخميناً
      equal(store2.resumeMaterial('ffffffffffffffff'), null, 'جهاز مجهول لا يُستأنف');
      const legacyFile = path.join(tempRoot, 'legacy-devices.json');
      fs.writeFileSync(legacyFile, JSON.stringify({
        identity,
        devices: [{
          deviceId: 'aaaaaaaaaaaaaaaa', label: 'قديم', pairedAt: 1, lastSeen: 1,
          revoked: false, publicKey: mobileKeys.publicKey,
        }],
      }), 'utf8');
      const legacyStore = mobilepair.createStore({ file: legacyFile });
      equal(legacyStore.resumeMaterial('aaaaaaaaaaaaaaaa'), null,
        'سجل يسبق الدفعة (بلا pairId) لا يُستأنف');
      equal(legacyStore.listDevices().length, 1, 'ويبقى معروضاً وقابلاً للإبطال');

      // `listDevices` يبقى metadata عرض: لا pairId ولا مفاتيح ولا عدّادات
      const shown = store2.listDevices()[0];
      equal(Object.keys(shown).sort().join(','), 'deviceId,label,lastSeen,pairedAt,revoked',
        'listDevices بلا pairId أو مفاتيح أو عدّادات');
    } finally {
      await link2.stop();
    }

    // ── بوابة الميزة قبل الإصدار ──────────────────────────────────────────────
    // إخفاء الزر وحده يترك الميزة مخفية لا مطفأة: القنوات تُغلق عند المصدر،
    // والواجهة تعكس البوابة ولا تصنعها.
    const gateSource = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8');
    const gateFor = (opts) => {
      const labsFile = path.join(tempRoot, 'labs-' + Math.random().toString(36).slice(2) + '.json');
      if (opts.labs !== undefined) fs.writeFileSync(labsFile, opts.labs, 'utf8');
      const sandbox = {
        app: { isPackaged: opts.packaged },
        process: { env: opts.env || {} },
        JSON,
        fs: { readFileSync: () => fs.readFileSync(labsFile, 'utf8') },
        path: { join: () => labsFile },
        os: { homedir: () => tempRoot },
      };
      return sourceFunction(gateSource, 'mobileFeatureAvailable', sandbox)();
    };
    equal(gateFor({ packaged: false }), true, 'تشغيل التطوير يفتح الميزة بلا إعداد');
    equal(gateFor({ packaged: true }), false, 'النسخة المثبّتة مغلقة افتراضياً');
    equal(gateFor({ packaged: true, env: { SATR_MOBILE: '1' } }), true, 'متغيّر البيئة يفتحها');
    equal(gateFor({ packaged: true, env: { SATR_MOBILE: 'true' } }), false, 'قيمة بيئة أخرى لا تفتحها');
    equal(gateFor({ packaged: true, labs: '{"mobile_control":true}' }), true, 'ملف الاشتراك يفتحها');
    equal(gateFor({ packaged: true, labs: '{"mobile_control":"yes"}' }), false, 'القيمة النصية لا تفتحها');
    equal(gateFor({ packaged: true, labs: '{}' }), false, 'ملف بلا المفتاح لا يفتحها');
    equal(gateFor({ packaged: true, labs: 'not json' }), false, 'ملف فاسد لا يفتحها');

    // القنوات مغلقة عند المصدر، والزر مخفي في الترميز (فشل مغلق)
    assert(/satr:mobileEnable[\s\S]{0,400}?mobileFeatureAvailable\(\)/.test(gateSource),
      'قناة التفعيل تمرّ بالبوابة');
    assert(/satr:mobilePairingStart[\s\S]{0,200}?mobileFeatureAvailable\(\)/.test(gateSource),
      'قناة الاقتران تمرّ بالبوابة');
    assert(/satr:mobileDevices[\s\S]{0,200}?mobileFeatureAvailable\(\)/.test(gateSource),
      'قناة الأجهزة تمرّ بالبوابة');
    const indexSource = fs.readFileSync(path.join(appRoot, 'src', 'index.html'), 'utf8');
    assert(/<button id="mobileToggle"[^>]*\shidden\s*>/.test(indexSource),
      'زر الجوال مخفي افتراضياً في الترميز');
    const appSource = fs.readFileSync(path.join(appRoot, 'src', 'ui', 'app.js'), 'utf8');
    assert(/status\.available[\s\S]{0,120}?mobileToggle'\)\.hidden = false/.test(appSource),
      'الواجهة تكشف الزر من available وحدها');

    // ── الاقتران المعمّى عبر وسيط (§7.2) — توافق متقاطع حقيقي ────────────────
    // الحلقة الأمنية الحرجة للـrelay: بلا تعمية يرى الوسيط secretProof وmobilePublic
    // معاً فيقترن بمفتاحه بدل الهاتف ويصير صاحب قرار. هنا **الهاتف يختم بـWebCrypto
    // وسطح المكتب يفكّ بـnode:crypto** — لا كلّ طرف يختبر نفسه.
    const pairPayload = { secretProof: parsed.payload.secret, deviceId, label: 'جوالي' };
    const sealedPairing = await pwaCrypto.sealPairing({
      mobilePrivate: mobileKeys.privateKey,
      mobilePublic: mobileKeys.publicKey,
      desktopPublic: parsed.payload.desktopPublic,
      pairId: parsed.payload.pairId,
      payload: pairPayload,
    });
    const pairingBytes = Buffer.from(sealedPairing);
    equal(pairingBytes[0], mobilecrypto.VERSION, 'إطار الاقتران: بايت النسخة');
    equal(pairingBytes[1], mobilecrypto.PAIR_KIND, 'إطار الاقتران: النوع 0x03');
    const openedPairing = mobilecrypto.openPairing({
      desktopPrivate: desktopKeys.privateKey,
      pairId: parsed.payload.pairId,
      frame: pairingBytes,
    });
    equal(openedPairing.mobilePublic, mobileKeys.publicKey, 'سطح المكتب استخرج مفتاح الجوال');
    equal(openedPairing.payload.secretProof, parsed.payload.secret, 'السرّ وصل سليماً');
    equal(openedPairing.payload.deviceId, deviceId, 'المعرّف وصل سليماً');
    equal(openedPairing.payload.label, 'جوالي', 'الوسم العربي عبر WebCrypto→node سليم');

    // الاتجاه المعاكس: سطح المكتب يختم والهاتف يفكّ (العقد متماثل)
    const nodeSealed = mobilecrypto.sealPairing({
      mobilePrivate: mobileKeys.privateKey,
      mobilePublic: mobileKeys.publicKey,
      desktopPublic: parsed.payload.desktopPublic,
      pairId: parsed.payload.pairId,
      payload: pairPayload,
    });
    const pwaOpened = await pwaCrypto.openPairing({
      desktopPrivate: desktopKeys.privateKey,
      desktopPublic: parsed.payload.desktopPublic,
      pairId: parsed.payload.pairId,
      frame: new Uint8Array(nodeSealed),
    });
    equal(pwaOpened.payload.secretProof, parsed.payload.secret, 'node→WebCrypto يفكّ سليماً');
    equal(pwaOpened.mobilePublic, mobileKeys.publicKey, 'ومفتاح الجوال مطابق');

    // نموذج التهديد: الوسيط ينقل الإطار ويحاول القراءة أو الانتحال
    assert(!pairingBytes.toString('latin1').includes(parsed.payload.secret),
      'السرّ لا يظهر في بايتات ما ينقله الوسيط');
    const substituted = Buffer.from(pairingBytes);
    Buffer.from(lateKeys.publicKey, 'base64url').copy(substituted, 2);
    let substitutionRejected = false;
    try {
      mobilecrypto.openPairing({
        desktopPrivate: desktopKeys.privateKey, pairId: parsed.payload.pairId, frame: substituted,
      });
    } catch (error) { substitutionRejected = (error && error.message) === 'bad_tag'; }
    assert(substitutionRejected, 'تبديل mobilePublic بمفتاح الوسيط يكسر الوسم');

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
