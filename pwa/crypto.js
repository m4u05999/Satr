/**
 * سطر — طبقة التعمية طرفاً لطرف للتحكم من الجوال (PWA)
 *
 * تطبيق WebCrypto قياسي يعيد إنتاج عقد `electron/mobilecrypto.js` بايتاً ببايت
 * (§4.1 + §5.3 من docs/MOBILE-CONTROL-PLAN.md).
 *
 * التواقيع:
 *   generateKeyPair() -> Promise<{publicKey:string, privateKey:string}>
 *   deriveSession({myPrivate, myPublic, theirPublic, pairId, role}) -> Promise<session>
 *   seal(session, plaintext) -> Promise<Uint8Array>
 *   open(session, frame) -> Promise<Uint8Array>
 *   sas({desktopPublic, mobilePublic, pairId}) -> Promise<string>
 *
 * ملاحظة التوافق: WebCrypto لا يستورد مفتاح ECDH خاصاً بصيغة raw، لذلك
 * `deriveSession` تطلب `myPublic` (65B raw) لتبني JWK باستخدام x/y المقتطعين
 * من النقطة العامة نفسها.
 */
(function () {
  'use strict';

  const subtle = window.crypto.subtle;
  const encoder = new TextEncoder();

  const VERSION = 0x01;
  const DIR_D2M = 0x01;
  const DIR_M2D = 0x02;
  const PUB_LEN = 65;
  const PRIV_LEN = 32;
  const KEY_LEN = 32;
  const PREFIX_LEN = 4;
  const COUNTER_LEN = 8;
  const HEADER_LEN = 1 + 1 + COUNTER_LEN;
  const TAG_LEN = 16;
  const NONCE_LEN = PREFIX_LEN + COUNTER_LEN;
  const HKDF_INFO = encoder.encode('satr-mobile-v1');
  const HKDF_NONCE_INFO = encoder.encode('satr-mobile-v1-nonce');
  // الاقتران المعمّى عبر وسيط (§7.2) — وسم مستقل عن مفاتيح الجلسة
  const HKDF_PAIR_INFO = encoder.encode('satr-mobile-v1-pair');
  const PAIR_KIND = 0x03;
  const PAIR_NONCE_LEN = 12;
  const PAIR_HEADER_LEN = 1 + 1 + 65 + PAIR_NONCE_LEN; // 79
  const MAX_PAIR_PLAINTEXT = 4096;
  const HKDF_LEN = 64;
  const HKDF_NONCE_LEN = 2 * PREFIX_LEN;

  const MAX_PLAINTEXT = 1024 * 1024;
  const MAX_FRAME = HEADER_LEN + MAX_PLAINTEXT + TAG_LEN;
  const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

  const B64URL_RE = /^[A-Za-z0-9_-]+$/;

  function fail(code) {
    return new Error(code);
  }

  function u8ToB64url(u8) {
    const bin = String.fromCharCode(...u8);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64urlToU8(s) {
    if (typeof s !== 'string' || !B64URL_RE.test(s)) throw fail('bad_base64url');
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function utf8ToU8(s) {
    return encoder.encode(s);
  }

  function concatBytes(...parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function decodeKey(value, size, code) {
    let u8 = null;
    if (value instanceof Uint8Array) u8 = value;
    else if (typeof value === 'string') u8 = b64urlToU8(value);
    if (!u8 || u8.length !== size) throw fail(code);
    return u8;
  }

  function decodePublic(value) {
    const u8 = decodeKey(value, PUB_LEN, 'bad_public_key');
    if (u8[0] !== 0x04) throw fail('bad_public_key');
    return u8;
  }

  function pairIdBytes(pairId) {
    if (typeof pairId !== 'string' || pairId.length === 0 || pairId.length > 512) {
      throw fail('bad_pair_id');
    }
    return encoder.encode(pairId);
  }

  function buildHeader(dir, counter) {
    const header = new Uint8Array(HEADER_LEN);
    header[0] = VERSION;
    header[1] = dir;
    const view = new DataView(header.buffer);
    view.setBigUint64(2, BigInt(counter), false);
    return header;
  }

  function buildNonce(prefix, header) {
    const nonce = new Uint8Array(NONCE_LEN);
    nonce.set(prefix, 0);
    nonce.set(header.subarray(2, HEADER_LEN), PREFIX_LEN);
    return nonce;
  }

  function assertBytes(value, code) {
    if (!(value instanceof Uint8Array)) throw fail(code);
  }

  function isCryptoKey(k) {
    return k && typeof k === 'object' && k.constructor && k.constructor.name === 'CryptoKey';
  }

  function assertSession(session) {
    if (!session || typeof session !== 'object') throw fail('bad_session');
    const okDirs =
      (session.dirSend === DIR_D2M && session.dirRecv === DIR_M2D) ||
      (session.dirSend === DIR_M2D && session.dirRecv === DIR_D2M);
    if (!okDirs) throw fail('bad_session');
    if (!isCryptoKey(session.keySend)) throw fail('bad_session');
    if (!isCryptoKey(session.keyRecv)) throw fail('bad_session');
    if (!(session.prefixSend instanceof Uint8Array) || session.prefixSend.length !== PREFIX_LEN) {
      throw fail('bad_session');
    }
    if (!(session.prefixRecv instanceof Uint8Array) || session.prefixRecv.length !== PREFIX_LEN) {
      throw fail('bad_session');
    }
    if (!Number.isSafeInteger(session.counterSend) || session.counterSend < 0) throw fail('bad_session');
    if (!Number.isSafeInteger(session.lastRecvCounter) || session.lastRecvCounter < -1) {
      throw fail('bad_session');
    }
  }

  async function generateKeyPair() {
    const keyPair = await subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const pubRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
    const jwk = await subtle.exportKey('jwk', keyPair.privateKey);
    const d = b64urlToU8(jwk.d);
    return {
      publicKey: u8ToB64url(pubRaw),
      privateKey: u8ToB64url(d)
    };
  }

  async function importPrivateKey(privU8, pubU8) {
    // x/y هما إحداثيا النقطة العامة 65B (بدون البادئة 0x04)
    const x = u8ToB64url(pubU8.subarray(1, 33));
    const y = u8ToB64url(pubU8.subarray(33, 65));
    const d = u8ToB64url(privU8);
    return subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );
  }

  async function importPublicKeyRaw(pubU8) {
    return subtle.importKey(
      'raw',
      pubU8,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
  }

  async function deriveShared(privKey, pubKey) {
    // سرّ ECDH الخام = إحداثي X (32 بايت) — مطابق لـ node:crypto computeSecret
    return new Uint8Array(await subtle.deriveBits(
      { name: 'ECDH', public: pubKey },
      privKey,
      256
    ));
  }

  async function hkdf(shared, salt, info, bits) {
    const baseKey = await subtle.importKey(
      'raw',
      shared,
      { name: 'HKDF' },
      false,
      ['deriveBits']
    );
    return new Uint8Array(await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      baseKey,
      bits
    ));
  }

  async function importAesKey(raw) {
    return subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function deriveSession(opts) {
    const { myPrivate, myPublic, theirPublic, pairId, role } = opts || {};
    if (role !== 'desktop' && role !== 'mobile') throw fail('bad_role');

    const salt = pairIdBytes(pairId);
    const priv = decodeKey(myPrivate, PRIV_LEN, 'bad_private_key');
    const pub = decodePublic(myPublic);
    const theirPub = decodePublic(theirPublic);

    const privKey = await importPrivateKey(priv, pub);
    const theirKey = await importPublicKeyRaw(theirPub);

    const shared = await deriveShared(privKey, theirKey);

    const okm = await hkdf(shared, salt, HKDF_INFO, HKDF_LEN * 8);
    const nonceOkm = await hkdf(shared, salt, HKDF_NONCE_INFO, HKDF_NONCE_LEN * 8);

    const keyD2M = okm.subarray(0, KEY_LEN);
    const keyM2D = okm.subarray(KEY_LEN, HKDF_LEN);
    const keyD2MKey = await importAesKey(keyD2M);
    const keyM2DKey = await importAesKey(keyM2D);

    const prefixD2M = nonceOkm.subarray(0, PREFIX_LEN);
    const prefixM2D = nonceOkm.subarray(PREFIX_LEN, HKDF_NONCE_LEN);

    const desktop = role === 'desktop';
    return {
      role,
      pairId,
      dirSend: desktop ? DIR_D2M : DIR_M2D,
      dirRecv: desktop ? DIR_M2D : DIR_D2M,
      keySend: desktop ? keyD2MKey : keyM2DKey,
      keyRecv: desktop ? keyM2DKey : keyD2MKey,
      prefixSend: desktop ? prefixD2M : prefixM2D,
      prefixRecv: desktop ? prefixM2D : prefixD2M,
      counterSend: 0,
      lastRecvCounter: -1
    };
  }

  async function seal(session, plaintext) {
    assertSession(session);
    let pt;
    if (typeof plaintext === 'string') pt = utf8ToU8(plaintext);
    else { assertBytes(plaintext, 'bad_plaintext'); pt = plaintext; }
    if (pt.length > MAX_PLAINTEXT) throw fail('plaintext_too_large');

    const counter = session.counterSend;
    if (counter >= MAX_COUNTER) throw fail('counter_exhausted');

    const header = buildHeader(session.dirSend, counter);
    const nonce = buildNonce(session.prefixSend, header);

    const ctTag = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: TAG_LEN * 8 },
      session.keySend,
      pt
    ));

    session.counterSend = counter + 1;
    return concatBytes(header, ctTag);
  }

  async function open(session, frame) {
    assertSession(session);
    assertBytes(frame, 'bad_frame');
    if (frame.length < HEADER_LEN + TAG_LEN || frame.length > MAX_FRAME) throw fail('bad_frame');
    if (frame[0] !== VERSION) throw fail('bad_version');
    if (frame[1] !== session.dirRecv) throw fail('bad_direction');

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const counterBig = view.getBigUint64(2, false);
    if (counterBig > BigInt(MAX_COUNTER)) throw fail('bad_counter');
    const counter = Number(counterBig);
    if (counter <= session.lastRecvCounter) throw fail('replay');

    const header = frame.subarray(0, HEADER_LEN);
    const body = frame.subarray(HEADER_LEN, frame.length - TAG_LEN);
    const tag = frame.subarray(frame.length - TAG_LEN);
    const nonce = buildNonce(session.prefixRecv, header);

    const cipher = concatBytes(body, tag);

    let plaintext;
    try {
      plaintext = new Uint8Array(await subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: TAG_LEN * 8 },
        session.keyRecv,
        cipher
      ));
    } catch (_e) {
      throw fail('bad_tag');
    }

    session.lastRecvCounter = counter;
    return plaintext;
  }

  async function sas(opts) {
    const { desktopPublic, mobilePublic, pairId } = opts || {};
    const dPub = decodePublic(desktopPublic);
    const mPub = decodePublic(mobilePublic);
    const salt = pairIdBytes(pairId);
    const digest = new Uint8Array(await subtle.digest('SHA-256', concatBytes(dPub, mPub, salt)));
    const bits20 = ((digest[0] << 12) | (digest[1] << 4) | (digest[2] >> 4)) >>> 0;
    return String(bits20 % 1000000).padStart(6, '0');
  }

  // ── الاقتران المعمّى عبر وسيط (§7.2) ──────────────────────────────────────
  // نظير `sealPairing`/`openPairing` في `electron/mobilecrypto.js` **بايتاً ببايت**.
  // بلا هذا يرى الوسيط `secretProof` و`mobilePublic` معاً فيقترن بمفتاحه بدل الهاتف.

  async function pairingKeyFrom(privU8, pubU8, myPubU8, salt) {
    const privKey = await importPrivateKey(privU8, myPubU8);
    const theirKey = await importPublicKeyRaw(pubU8);
    const shared = await deriveShared(privKey, theirKey);
    const raw = await hkdf(shared, salt, HKDF_PAIR_INFO, KEY_LEN * 8);
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function pairingAad(mobilePub, salt) {
    return concatBytes(new Uint8Array([VERSION, PAIR_KIND]), mobilePub, salt);
  }

  /**
   * يبني إطار اقتران معمّى إلى مفتاح سطح المكتب المقروء من QR.
   * الـnonce عشوائي **على السلك** لا مشتقّ: المفتاح ثابت في (زوج الجوال،
   * desktopPublic، pairId)، فإعادة المحاولة بالزوج نفسه تعيده — وnonce مشتقّ حينها
   * يتكرر تحت مفتاح واحد (كارثي في GCM). الحقن للاختبار القطعي فقط.
   */
  async function sealPairing(opts) {
    const { mobilePrivate, mobilePublic, desktopPublic, pairId, payload } = opts || {};
    const salt = pairIdBytes(pairId);
    const priv = decodeKey(mobilePrivate, PRIV_LEN, 'bad_private_key');
    const mPub = decodePublic(mobilePublic);
    const dPub = decodePublic(desktopPublic);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('bad_payload');

    const plaintext = utf8ToU8(JSON.stringify(payload));
    if (!plaintext.length || plaintext.length > MAX_PAIR_PLAINTEXT) throw fail('bad_payload');

    let nonce;
    if (opts && opts.nonce !== undefined) {
      assertBytes(opts.nonce, 'bad_nonce');
      nonce = opts.nonce;
    } else {
      nonce = window.crypto.getRandomValues(new Uint8Array(PAIR_NONCE_LEN));
    }
    if (nonce.length !== PAIR_NONCE_LEN) throw fail('bad_nonce');

    const key = await pairingKeyFrom(priv, dPub, mPub, salt);
    const sealed = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: pairingAad(mPub, salt), tagLength: TAG_LEN * 8 },
      key,
      plaintext
    ));
    return concatBytes(new Uint8Array([VERSION, PAIR_KIND]), mPub, nonce, sealed);
  }

  /** يفكّ إطار اقتران معمّى (لاكتمال العقد والاختبار المتقاطع). */
  async function openPairing(opts) {
    const { desktopPrivate, desktopPublic, pairId, frame } = opts || {};
    const salt = pairIdBytes(pairId);
    const priv = decodeKey(desktopPrivate, PRIV_LEN, 'bad_private_key');
    const dPub = decodePublic(desktopPublic);
    assertBytes(frame, 'bad_frame');
    if (frame.length < PAIR_HEADER_LEN + TAG_LEN + 1) throw fail('bad_frame');
    if (frame.length > PAIR_HEADER_LEN + MAX_PAIR_PLAINTEXT + TAG_LEN) throw fail('bad_frame');
    if (frame[0] !== VERSION) throw fail('bad_version');
    if (frame[1] !== PAIR_KIND) throw fail('bad_kind');

    const mPub = frame.slice(2, 2 + PUB_LEN);
    if (mPub[0] !== 0x04) throw fail('bad_public_key');
    const nonce = frame.slice(2 + PUB_LEN, PAIR_HEADER_LEN);
    const body = frame.slice(PAIR_HEADER_LEN);

    const key = await pairingKeyFrom(priv, mPub, dPub, salt);
    let plain;
    try {
      plain = new Uint8Array(await subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: pairingAad(mPub, salt), tagLength: TAG_LEN * 8 },
        key,
        body
      ));
    } catch (_e) { throw fail('bad_tag'); }

    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(plain)); }
    catch (_e) { throw fail('bad_payload'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('bad_payload');
    return { mobilePublic: u8ToB64url(mPub), payload };
  }

  window.SatrCrypto = {
    generateKeyPair,
    deriveSession,
    seal,
    open,
    sas,
    sealPairing,
    openPairing,
    PAIR_KIND,
    PAIR_NONCE_LEN,
    PAIR_HEADER_LEN,
    MAX_PAIR_PLAINTEXT,
    // مساعدات مفيدة للاختبار والتكامل
    bytesToBase64url: u8ToB64url,
    base64urlToBytes: b64urlToU8,
    utf8ToBytes: utf8ToU8,
    // ثوابت العقد
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
})();
