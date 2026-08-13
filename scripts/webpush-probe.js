#!/usr/bin/env node
/**
 * سطر — مسبار Web Push للتحكم من الجوال (‏F1، البند 4 في §7.7.4).
 *
 * **مبدأ المشروع: لا عقد مجمَّد بلا استدعاء حيّ.** هذا المسبار يثبت أن الوعد المركزي
 * في §1 («جواله يرنّ») قابل للبناء **بصفر اعتماديات** كما يوجب قرار المالك #4:
 * «‏Push من سطح المكتب لا من الوسيط… يوقّع VAPID بـ`node:crypto` ويرسل مباشرةً».
 *
 * ثلاثة معايير متراكبة:
 *   • RFC 8292 (‏VAPID): زوج P-256 + JWT موقّع ES256
 *   • RFC 8291: تشفير الحمولة `aes128gcm` عبر ECDH + HKDF
 *   • RFC 8030: بروتوكول التسليم (الترويسات — الإرسال الحيّ يحتاج اشتراكاً حقيقياً)
 *
 * ⚠️ **ما لا يثبته هذا المسبار**: الإرسال الفعلي إلى endpoint حقيقي (‏FCM/Mozilla)،
 * لأنه يحتاج اشتراكاً من متصفح حقيقي — وهو دجاجة وبيضة قبل بناء طرف الهاتف. لذلك
 * يُفكّ التشفير هنا **بمفاتيح المشترك** لا بمفاتيح المرسِل: برهانُ توافقٍ مع المتصفح
 * لا اتساقٌ ذاتي زائف. الإرسال الحيّ يبقى بوابةَ قبولٍ لاحقة لا تُتخطّى.
 *
 * التشغيل: node scripts/webpush-probe.js
 */

'use strict';

const crypto = require('node:crypto');

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function equal(actual, expected, message) {
  assert(actual === expected, message + ' — توقّعنا ' + JSON.stringify(expected)
    + ' ووجدنا ' + JSON.stringify(actual));
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/* ── 1) زوج VAPID ───────────────────────────────────────────────────────────
 * التمثيل **مطابق لعقد `mobilecrypto` المجمَّد** (§4.1): نقطة عامة غير مضغوطة
 * 65 بايت ببادئة 0x04، وخاص 32 بايت. لا نخترع تمثيلاً ثانياً في المشروع نفسه.
 */
function vapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey();
  const privateKey = ecdh.getPrivateKey();
  equal(publicKey.length, 65, 'مفتاح VAPID العام 65 بايت');
  equal(publicKey[0], 0x04, 'بادئة النقطة غير المضغوطة 0x04');
  equal(privateKey.length, 32, 'مفتاح VAPID الخاص 32 بايت');
  return { publicKey, privateKey };
}

/* ── 2) ‏JWT بصيغة ES256 ────────────────────────────────────────────────────
 * ⚠️ **فخّ مثبت**: `crypto.sign` الافتراضي يُخرج توقيع ECDSA بترميز **DER** (‏~71
 * بايت متغيّر)، بينما JWT يوجب `r||s` خاماً بطول **64 بايت** ثابت. بلا
 * `dsaEncoding: 'ieee-p1363'` يرفض كل مزوّد Push الترويسة بلا رسالة مفيدة.
 */
function buildJwt(keys, audience, subject, expiresAt) {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64u(keys.privateKey),
    x: b64u(keys.publicKey.subarray(1, 33)),
    y: b64u(keys.publicKey.subarray(33, 65)),
  };
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = crypto.createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk',
  });

  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: expiresAt, sub: subject }));
  const signingInput = header + '.' + claims;

  const raw = crypto.sign('sha256', Buffer.from(signingInput),
    { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const der = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey });

  equal(raw.length, 64, 'توقيع JWT خام 64 بايت (‏ieee-p1363)');
  assert(der.length !== 64, 'الافتراضي DER ليس 64 — الفخّ قائم فعلاً، وطوله ' + der.length);
  assert(crypto.verify('sha256', Buffer.from(signingInput),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw), 'التوقيع يجتاز التحقق');

  return signingInput + '.' + b64u(raw);
}

/* ── 3) تشفير الحمولة (RFC 8291) ────────────────────────────────────────────
 * الحمولة **ثابتة عديمة المعنى** بقرار المالك #4: الإشعار wake-up فقط، والمحتوى
 * يُسحب مشفّراً بعد الفتح. فخدمة الدفع تتعلّم توقيت النشاط لا مضمونه.
 */
function encryptPayload(subscriberPublic, authSecret, plaintext) {
  const server = crypto.createECDH('prime256v1');
  server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(subscriberPublic);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriberPublic, serverPublic]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  // محدد نهاية السجل 0x02 (سجل أخير) — بدونه يرفض المتصفح الحمولة
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  const header = Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic]);
  return Buffer.concat([header, body]);
}

/** يفكّ بمفاتيح **المشترك** — برهان التوافق مع المتصفح لا اتساق ذاتي. */
function decryptAsSubscriber(subscriberEcdh, authSecret, payload) {
  const salt = payload.subarray(0, 16);
  const idLength = payload[20];
  const serverPublic = payload.subarray(21, 21 + idLength);
  const body = payload.subarray(21 + idLength);

  equal(idLength, 65, 'طول مفتاح المرسِل في الترويسة 65');
  const shared = subscriberEcdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), subscriberEcdh.getPublicKey(), serverPublic,
  ]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const out = Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)), decipher.final(),
  ]);
  equal(out[out.length - 1], 0x02, 'محدد نهاية السجل 0x02');
  return out.subarray(0, out.length - 1).toString('utf8');
}

function run() {
  const keys = vapidKeys();
  const jwt = buildJwt(keys, 'https://fcm.googleapis.com', 'mailto:m4u05999@gmail.com',
    Math.floor(Date.now() / 1000) + 12 * 3600);
  assert(jwt.split('.').length === 3, 'الـJWT ثلاثة أجزاء');

  // ترويسة RFC 8030/8292 كما ستُرسل فعلاً
  const authorization = 'vapid t=' + jwt + ', k=' + b64u(keys.publicKey);
  assert(authorization.startsWith('vapid t='), 'ترويسة Authorization بصيغة vapid');
  assert(authorization.includes(', k='), 'وتحمل المفتاح العام');

  // مشترك وهمي يحاكي ما يعطيه المتصفح: p256dh + auth (16 بايت)
  const subscriber = crypto.createECDH('prime256v1');
  subscriber.generateKeys();
  const authSecret = crypto.randomBytes(16);

  const plaintext = Buffer.from('wake-up', 'utf8');
  const payload = encryptPayload(subscriber.getPublicKey(), authSecret, plaintext);
  assert(payload.length > 86, 'الحمولة أكبر من الترويسة وحدها');

  const recovered = decryptAsSubscriber(subscriber, authSecret, payload);
  equal(recovered, 'wake-up', 'المشترك استعاد النص حرفياً');

  // العبث يُكشف: تغيير بايت واحد في النص المشفّر يجب أن يفشل وسم GCM
  const tampered = Buffer.from(payload);
  tampered[tampered.length - 20] ^= 0xff;
  let rejected = false;
  try { decryptAsSubscriber(subscriber, authSecret, tampered); } catch { rejected = true; }
  assert(rejected, 'العبث بالحمولة يُرفض بوسم GCM');
}

run();

if (failures.length) {
  console.error('webpush-probe: FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('webpush-probe: ok — ' + checks
  + ' فحصاً (‏VAPID + JWT ES256 + RFC 8291 تشفيراً وفكّاً وعبثاً).');
console.log('الحدّ المعلن: الإرسال الحيّ إلى endpoint حقيقي لم يُختبر — يحتاج اشتراك متصفح.');
