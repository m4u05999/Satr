/**
 * سطر — طبقة التعمية طرفاً لطرف للتحكم من الجوال (م0 — §4.1 من
 * docs/MOBILE-CONTROL-PLAN.md).
 *
 * وحدة نقية بلا اعتماديات (نمط diff.js/secretscrub.js): `node:crypto` وحده.
 * لا تلمس قرصاً ولا شبكة ولا حالة تطبيق — دوال خمس مجمّدة العقد:
 * generateKeyPair · deriveSession · seal · open · sas.
 *
 * ── التمثيل المجمّد ──────────────────────────────────────────────────────
 *  المفتاح العام : نقطة P-256 غير مضغوطة 65 بايت (بادئة 0x04) — base64url.
 *  المفتاح الخاص : عدد صحيح 32 بايت big-endian (مصفَّر البادئة) — base64url.
 *  الاشتقاق      : HKDF-SHA256(ikm=سرّ ECDH الخام 32B، salt=pairId بترميز UTF-8،
 *                  info='satr-mobile-v1'، 64B) ⇒ [keyD2M(32) | keyM2D(32)].
 *  الإطار        : version(1)=0x01 || dir(1) || counter(8 BE) || ciphertext || tag(16)
 *  الـnonce      : prefix(4) || counter(8) = 12 بايت.
 *  الـAAD        : version || dir || counter = 10 بايت (ترويسة الإطار نفسها).
 *
 * ── نقاط التوافق مع WebCrypto (حرجة — تعتمد عليها PWA لاحقاً) ────────────
 *  1) سرّ ECDH: `ecdh.computeSecret(pub65)` في Node يعيد إحداثي X الخام (32B)
 *     بلا أي تغليف — وهو حرفياً ناتج
 *     `deriveBits({name:'ECDH', public}, privKey, 256)` في WebCrypto.
 *  2) المفتاح العام يُستورد في المتصفح بـ
 *     `importKey('raw', <65B>, {name:'ECDH', namedCurve:'P-256'}, …)`.
 *  3) المفتاح الخاص: WebCrypto **لا يستورد** خاصاً بصيغة raw؛ تبنيه PWA JWK:
 *     `{kty:'EC', crv:'P-256', d:b64url(priv32), x:b64url(pub[1..33]),
 *       y:b64url(pub[33..65]), ext:true}` — أي أن x/y يُقتطعان من النقطة
 *     العامة 65B نفسها. لذلك يجب أن يحتفظ الجوال بزوجه كاملاً (عام+خاص).
 *  4) HKDF: `deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, ikm, 512)`
 *     — نفس الترتيب ونفس البايتات؛ salt وinfo بايتات UTF-8 لا نصوص.
 *  5) AES-GCM: WebCrypto يُلحق وسم المصادقة (16B) بنهاية النص المعمّى، وهو
 *     ترتيب إطارنا حرفياً (ciphertext ثم tag)، مع `additionalData` = الترويسة
 *     و`tagLength: 128`.
 *  6) لا شيء هنا خاص بـNode: لا `KeyObject` ولا صيغة DER/PEM في أي مدخل أو
 *     مخرج، وكل الأرقام big-endian صريحة.
 *
 * ── بادئة الـnonce: قرار موثّق ──────────────────────────────────────────
 *  الإطار المجمّد لا يحمل البادئة، فلا سبيل للمستقبِل إلى معرفتها لو كانت
 *  عشوائية على السلك؛ كما أن ملف الـvectors يوجب إطاراً قابلاً لإعادة الإنتاج
 *  بايتاً ببايت. لذلك تُشتق البادئتان من السرّ المشترك نفسه باستدعاء HKDF ثانٍ
 *  بوسم مستقل (`satr-mobile-v1-nonce`, 8B ⇒ [prefixD2M(4) | prefixM2D(4)]) —
 *  اشتقاق قياسي قابل للتكرار حرفياً في WebCrypto، وقيمته غير متوقعة لمن لا
 *  يملك السرّ المشترك، وهي فريدة لكل (جلسة، اتجاه) كما يوجب العقد.
 *  **شرط لازم للأمان**: `pairId` يجب أن يكون فريداً لكل جلسة اشتقاق. فهو
 *  ملح HKDF، فتكراره مع الزوج نفسه يعيد المفاتيح والبادئات نفسها بينما يبدأ
 *  العدّاد من الصفر ⇒ إعادة استعمال nonce تحت مفتاح AES-GCM واحد (كارثي).
 *  لا تعيد استعمال pairId عبر اتصالين.
 */

'use strict';

const crypto = require('node:crypto');

// — ثوابت العقد المجمّدة —
const CURVE = 'prime256v1'; // = P-256 = secp256r1
const VERSION = 0x01;
const DIR_D2M = 0x01; // ديسكتوب ⇐ جوال
const DIR_M2D = 0x02; // جوال ⇐ ديسكتوب
const PUB_LEN = 65;
const PRIV_LEN = 32;
const KEY_LEN = 32;
const PREFIX_LEN = 4;
const COUNTER_LEN = 8;
const HEADER_LEN = 1 + 1 + COUNTER_LEN; // 10 بايت — وهي الـAAD نفسها
const TAG_LEN = 16;
const NONCE_LEN = PREFIX_LEN + COUNTER_LEN; // 12
const HKDF_HASH = 'sha256';
const HKDF_INFO = 'satr-mobile-v1';
const HKDF_NONCE_INFO = 'satr-mobile-v1-nonce';
const HKDF_LEN = 64;
const HKDF_NONCE_LEN = 2 * PREFIX_LEN;
const CIPHER = 'aes-256-gcm';

// سقوف دفاعية (الوحدة تعالج ظروف إذن صغيرة — لا ملفات)
const MAX_PLAINTEXT = 1024 * 1024;
const MAX_FRAME = HEADER_LEN + MAX_PLAINTEXT + TAG_LEN;
const MAX_PAIR_ID = 512;
// أعلى عدّاد مسموح: يبقى داخل نطاق Number الآمن كي لا يتسرب فقدان دقة
const MAX_COUNTER = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const MAX_COUNTER_BIG = BigInt(MAX_COUNTER);

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** خطأ بعقد ثابت: الرسالة رمز إنجليزي قصير (داخلي — لا يُعرض للمستخدم). */
function fail(code) {
  return new Error(code);
}

/** يصفّر بادئة المخزن إلى الطول المطلوب (Node يعيد الخاص بأقصر تمثيل). */
function leftPad(buf, size) {
  if (buf.length === size) return Buffer.from(buf);
  if (buf.length > size) throw fail('bad_private_key');
  const out = Buffer.alloc(size);
  buf.copy(out, size - buf.length);
  return out;
}

function toB64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * يفكّ مفتاحاً من base64url (أو يقبل بايتات جاهزة) بطول صارم.
 * التحقق من الطول أولاً يمنع مدخلاً مبتوراً من المرور بصمت.
 */
function decodeKey(value, size, code) {
  let buf = null;
  if (Buffer.isBuffer(value)) buf = value;
  else if (value instanceof Uint8Array) buf = Buffer.from(value);
  else if (typeof value === 'string') {
    if (!B64URL_RE.test(value)) throw fail(code);
    const decoded = Buffer.from(value, 'base64url');
    // إعادة الترميز تكشف الحشو الفاسد أو المحارف المتسامح معها
    if (decoded.toString('base64url') !== value) throw fail(code);
    buf = decoded;
  }
  if (!buf || buf.length !== size) throw fail(code);
  return Buffer.from(buf);
}

/** نقطة عامة صالحة: 65 بايت ببادئة 0x04 (غير مضغوطة). */
function decodePublic(value) {
  const buf = decodeKey(value, PUB_LEN, 'bad_public_key');
  if (buf[0] !== 0x04) throw fail('bad_public_key');
  return buf;
}

function pairIdBytes(pairId) {
  if (typeof pairId !== 'string' || pairId.length === 0 || pairId.length > MAX_PAIR_ID) {
    throw fail('bad_pair_id');
  }
  return Buffer.from(pairId, 'utf8');
}

function asBytes(value, code) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw fail(code);
}

/** يبني ترويسة الإطار (وهي الـAAD): version || dir || counter(8 BE). */
function buildHeader(dir, counter) {
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = VERSION;
  header[1] = dir;
  header.writeBigUInt64BE(BigInt(counter), 2);
  return header;
}

function buildNonce(prefix, header) {
  const nonce = Buffer.alloc(NONCE_LEN);
  prefix.copy(nonce, 0);
  header.copy(nonce, PREFIX_LEN, 2, HEADER_LEN);
  return nonce;
}

function assertSession(session) {
  if (!session || typeof session !== 'object') throw fail('bad_session');
  const okDirs =
    (session.dirSend === DIR_D2M && session.dirRecv === DIR_M2D) ||
    (session.dirSend === DIR_M2D && session.dirRecv === DIR_D2M);
  if (!okDirs) throw fail('bad_session');
  if (!Buffer.isBuffer(session.keySend) || session.keySend.length !== KEY_LEN) throw fail('bad_session');
  if (!Buffer.isBuffer(session.keyRecv) || session.keyRecv.length !== KEY_LEN) throw fail('bad_session');
  if (!Buffer.isBuffer(session.prefixSend) || session.prefixSend.length !== PREFIX_LEN) throw fail('bad_session');
  if (!Buffer.isBuffer(session.prefixRecv) || session.prefixRecv.length !== PREFIX_LEN) throw fail('bad_session');
  if (!Number.isSafeInteger(session.counterSend) || session.counterSend < 0) throw fail('bad_session');
  if (!Number.isSafeInteger(session.lastRecvCounter) || session.lastRecvCounter < -1) throw fail('bad_session');
}

/**
 * يولّد زوج مفاتيح P-256 بالتمثيل المجمّد.
 * @returns {{publicKey: string, privateKey: string}} base64url (65B / 32B)
 */
function generateKeyPair() {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(); // غير مضغوط افتراضياً (65B ببادئة 0x04)
  const privateKey = leftPad(ecdh.getPrivateKey(), PRIV_LEN);
  return { publicKey: toB64url(publicKey), privateKey: toB64url(privateKey) };
}

/**
 * يشتق جلسة اتجاهين من زوجي المفاتيح ومعرّف الاقتران.
 * @param {{myPrivate:string, theirPublic:string, pairId:string, role:'desktop'|'mobile'}} opts
 */
function deriveSession(opts) {
  const { myPrivate, theirPublic, pairId, role } = opts || {};
  if (role !== 'desktop' && role !== 'mobile') throw fail('bad_role');
  const salt = pairIdBytes(pairId);
  const priv = decodeKey(myPrivate, PRIV_LEN, 'bad_private_key');
  const pub = decodePublic(theirPublic);

  const ecdh = crypto.createECDH(CURVE);
  try {
    ecdh.setPrivateKey(priv);
  } catch (_e) {
    throw fail('bad_private_key');
  }

  let shared;
  try {
    // نقطة خارج المنحنى أو نقطة اللانهاية ترفع هنا — رفض fail-closed
    shared = ecdh.computeSecret(pub);
  } catch (_e) {
    throw fail('bad_public_key');
  }

  const okm = Buffer.from(crypto.hkdfSync(HKDF_HASH, shared, salt, Buffer.from(HKDF_INFO, 'utf8'), HKDF_LEN));
  const nonceOkm = Buffer.from(
    crypto.hkdfSync(HKDF_HASH, shared, salt, Buffer.from(HKDF_NONCE_INFO, 'utf8'), HKDF_NONCE_LEN)
  );

  const keyD2M = Buffer.from(okm.subarray(0, KEY_LEN));
  const keyM2D = Buffer.from(okm.subarray(KEY_LEN, HKDF_LEN));
  const prefixD2M = Buffer.from(nonceOkm.subarray(0, PREFIX_LEN));
  const prefixM2D = Buffer.from(nonceOkm.subarray(PREFIX_LEN, HKDF_NONCE_LEN));

  // تنظيف المواد الوسيطة أفضل جهد (لا يلغي نسخ GC لكنه يقلّص العمر)
  shared.fill(0);
  okm.fill(0);
  nonceOkm.fill(0);
  priv.fill(0);

  const desktop = role === 'desktop';
  return {
    role,
    pairId,
    dirSend: desktop ? DIR_D2M : DIR_M2D,
    dirRecv: desktop ? DIR_M2D : DIR_D2M,
    keySend: desktop ? keyD2M : keyM2D,
    keyRecv: desktop ? keyM2D : keyD2M,
    prefixSend: desktop ? prefixD2M : prefixM2D,
    prefixRecv: desktop ? prefixM2D : prefixD2M,
    counterSend: 0,
    lastRecvCounter: -1
  };
}

/**
 * يختم نصاً صريحاً في إطار موجّه ويزيد عدّاد الإرسال.
 * @returns {Buffer} الإطار المجمّد
 */
function seal(session, plaintext) {
  assertSession(session);
  const pt = asBytes(plaintext, 'bad_plaintext');
  if (pt.length > MAX_PLAINTEXT) throw fail('plaintext_too_large');

  const counter = session.counterSend;
  if (counter >= MAX_COUNTER) throw fail('counter_exhausted');

  const header = buildHeader(session.dirSend, counter);
  const nonce = buildNonce(session.prefixSend, header);
  const cipher = crypto.createCipheriv(CIPHER, session.keySend, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();

  // العدّاد يتقدّم بعد نجاح التعمية فقط — فشلٌ لا يحرق قيمة
  session.counterSend = counter + 1;
  return Buffer.concat([header, body, tag]);
}

/**
 * يفتح إطاراً وارداً: يتحقق من الإصدار والاتجاه والـAAD والوسم ويرفض الإعادة.
 * لا يُحدَّث `lastRecvCounter` إلا بعد نجاح المصادقة.
 * @returns {Buffer} النص الصريح
 */
function open(session, frame) {
  assertSession(session);
  const buf = asBytes(frame, 'bad_frame');
  if (buf.length < HEADER_LEN + TAG_LEN || buf.length > MAX_FRAME) throw fail('bad_frame');
  if (buf[0] !== VERSION) throw fail('bad_version');
  // الاتجاه في الـAAD أيضاً؛ الفحص هنا يرفض انعكاس إطارنا إلينا قبل أي تعمية
  if (buf[1] !== session.dirRecv) throw fail('bad_direction');

  const counterBig = buf.readBigUInt64BE(2);
  if (counterBig > MAX_COUNTER_BIG) throw fail('bad_counter');
  const counter = Number(counterBig);
  // تزايد تام إلزامي (الفجوات مقبولة — رسالة ساقطة لا تُعطّل القناة)
  if (counter <= session.lastRecvCounter) throw fail('replay');

  const header = buf.subarray(0, HEADER_LEN);
  const body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const nonce = buildNonce(session.prefixRecv, header);

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(CIPHER, session.keyRecv, nonce, { authTagLength: TAG_LEN });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (_e) {
    throw fail('bad_tag');
  }

  session.lastRecvCounter = counter;
  return plaintext;
}

/**
 * رمز مقارنة قصير (SAS) يقرأه الطرفان بصوت/بصر لكشف MITM.
 * = أول 20 بت من SHA-256(desktopPublic || mobilePublic || pairId) بالعشري،
 *   مقسوماً على 1e6 باقياً، ومصفّر البادئة إلى ست خانات.
 */
function sas(opts) {
  const { desktopPublic, mobilePublic, pairId } = opts || {};
  const dPub = decodePublic(desktopPublic);
  const mPub = decodePublic(mobilePublic);
  const salt = pairIdBytes(pairId);
  const digest = crypto.createHash('sha256').update(dPub).update(mPub).update(salt).digest();
  // أول 20 بت: بايتان كاملان + النصف الأعلى من الثالث
  const bits20 = ((digest[0] << 12) | (digest[1] << 4) | (digest[2] >> 4)) >>> 0;
  return String(bits20 % 1000000).padStart(6, '0');
}

module.exports = {
  generateKeyPair,
  deriveSession,
  seal,
  open,
  sas,
  // ثوابت العقد (للاختبار والتكامل — لا تغيّرها دون تحديث §4.1 وملف الـvectors)
  VERSION,
  DIR_D2M,
  DIR_M2D,
  HEADER_LEN,
  TAG_LEN,
  NONCE_LEN,
  PUB_LEN,
  PRIV_LEN,
  MAX_PLAINTEXT,
  MAX_COUNTER
};
