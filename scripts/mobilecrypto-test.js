/**
 * سطر — اختبار طبقة التعمية للتحكم من الجوال (§4.1 من MOBILE-CONTROL-PLAN.md).
 *
 * قطعي بالكامل: بلا شبكة وبلا عشوائية في أي تأكيد (مفاتيح اختبار ثابتة محقونة).
 * يكتب في نهايته `scripts/fixtures/mobilecrypto-vectors.json` — عقد التوافق
 * البايتي الذي تتحقق منه PWA بـWebCrypto في دفعة لاحقة — ثم يتحقق منه بنفسه.
 *
 * التشغيل: node scripts/mobilecrypto-test.js
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mc = require('../electron/mobilecrypto.js');

// ── مفاتيح اختبار ثابتة (قِيَم P-256 صالحة، أصغر بكثير من رتبة المنحنى) ──
const DESKTOP_PRIV_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const MOBILE_PRIV_HEX = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const THIRD_PRIV_HEX = '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f';
const PAIR_ID = 'satr-vectors-pair-0001';

// ── القيم المتوقعة المجمّدة (تُثبّت البايتات عبر أي تعديل لاحق) ──
const EXPECT = {
  desktopPrivate: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
  desktopPublic: 'BFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q',
  mobilePrivate: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  mobilePublic: 'BMZVnUFt-1avcU8UbZF8JKv4GLL7EhYEEpZJhIIwotJYsqbYLcbGc0zwkv-qn8AS8Q9wCNOVKgjVeX6F_qul2Xc',
  keyD2M: 'uJ7UHzW6x7htOwOwvS_EpBA2bLPI4l11nyET992d-7Q',
  keyM2D: '26SdA_VK_uV6TRMqG7-606fTUzrsErD1sKwvQSas8pk',
  prefixD2M: 'NsSfuA',
  prefixM2D: 'uLkwOQ',
  // إطارات ديسكتوب←جوال: العدّاد 0 ثم 1 (الثاني نص فارغ)
  frameD2M0: 'AQEAAAAAAAAAAFcMIaFCNRtACU5QqPUHqsrGljfhp93EsXQ5sIu3qf4aBADgboqpPEo',
  frameD2M1: 'AQEAAAAAAAAAAdvXjaRZ-1wVZJfoatn7tOg',
  // إطار جوال←ديسكتوب: العدّاد 0
  frameM2D0: 'AQIAAAAAAAAAAI1MlF8g6v9zOYOlSWa-Z6qw-HjiyBiJMNEVN9vCItQrY1qoww',
  sas: '709387'
};

const MSG_D2M_0 = 'مرحباً من سطر';
const MSG_D2M_1 = '';
const MSG_M2D_0 = '{"decision":"allow"}';

// ── عدّة اختبار صغيرة ──
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

/** يتأكد أن الاستدعاء يفشل برمز الخطأ المتوقع بالضبط. */
function expectFail(code, fn) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `expected throw "${code}" but call succeeded`);
  assert.strictEqual(thrown.message, code, `expected "${code}" got "${thrown.message}"`);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function publicOf(privHex) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privHex, 'hex'));
  return ecdh.getPublicKey();
}

const D_PRIV = b64u(Buffer.from(DESKTOP_PRIV_HEX, 'hex'));
const D_PUB = b64u(publicOf(DESKTOP_PRIV_HEX));
const M_PRIV = b64u(Buffer.from(MOBILE_PRIV_HEX, 'hex'));
const M_PUB = b64u(publicOf(MOBILE_PRIV_HEX));
const T_PRIV = b64u(Buffer.from(THIRD_PRIV_HEX, 'hex'));
const T_PUB = b64u(publicOf(THIRD_PRIV_HEX));

function desktopSession(pairId = PAIR_ID) {
  return mc.deriveSession({ myPrivate: D_PRIV, theirPublic: M_PUB, pairId, role: 'desktop' });
}
function mobileSession(pairId = PAIR_ID) {
  return mc.deriveSession({ myPrivate: M_PRIV, theirPublic: D_PUB, pairId, role: 'mobile' });
}

// ═══════════════════════ 1) توليد المفاتيح والتمثيل ═══════════════════════

test('generateKeyPair — تمثيل مجمّد 65B/32B بترميز base64url', () => {
  for (let i = 0; i < 8; i += 1) {
    const kp = mc.generateKeyPair();
    assert.match(kp.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.match(kp.privateKey, /^[A-Za-z0-9_-]+$/);
    const pub = fromB64u(kp.publicKey);
    const priv = fromB64u(kp.privateKey);
    assert.strictEqual(pub.length, mc.PUB_LEN, 'public must be 65 bytes');
    assert.strictEqual(pub[0], 0x04, 'public must be uncompressed (0x04)');
    assert.strictEqual(priv.length, mc.PRIV_LEN, 'private must be 32 bytes (left-padded)');
  }
});

test('generateKeyPair — الزوج المولّد صالح فعلاً لاشتقاق جلسة', () => {
  const kp = mc.generateKeyPair();
  const a = mc.deriveSession({ myPrivate: kp.privateKey, theirPublic: M_PUB, pairId: PAIR_ID, role: 'desktop' });
  const b = mc.deriveSession({ myPrivate: M_PRIV, theirPublic: kp.publicKey, pairId: PAIR_ID, role: 'mobile' });
  assert.deepStrictEqual(a.keySend, b.keyRecv);
  assert.deepStrictEqual(a.keyRecv, b.keySend);
});

// ═══════════════════════ 2) الاشتقاق ═══════════════════════

test('deriveSession — الطرفان يشتقّان المادة نفسها بالتناظر الصحيح', () => {
  const d = desktopSession();
  const m = mobileSession();
  assert.deepStrictEqual(d.keySend, m.keyRecv, 'keyD2M must match across sides');
  assert.deepStrictEqual(d.keyRecv, m.keySend, 'keyM2D must match across sides');
  assert.deepStrictEqual(d.prefixSend, m.prefixRecv);
  assert.deepStrictEqual(d.prefixRecv, m.prefixSend);
  assert.notDeepStrictEqual(d.keySend, d.keyRecv, 'per-direction keys must differ');
  assert.notDeepStrictEqual(d.prefixSend, d.prefixRecv, 'per-direction nonce prefixes must differ');
});

test('deriveSession — الاتجاهات والحالة الابتدائية', () => {
  const d = desktopSession();
  const m = mobileSession();
  assert.strictEqual(d.dirSend, mc.DIR_D2M);
  assert.strictEqual(d.dirRecv, mc.DIR_M2D);
  assert.strictEqual(m.dirSend, mc.DIR_M2D);
  assert.strictEqual(m.dirRecv, mc.DIR_D2M);
  for (const s of [d, m]) {
    assert.strictEqual(s.counterSend, 0);
    assert.strictEqual(s.lastRecvCounter, -1);
    assert.strictEqual(s.keySend.length, 32);
    assert.strictEqual(s.prefixSend.length, 4);
  }
});

test('deriveSession — القيم المشتقة تطابق الـvectors المجمّدة بايتاً ببايت', () => {
  const d = desktopSession();
  assert.strictEqual(b64u(d.keySend), EXPECT.keyD2M);
  assert.strictEqual(b64u(d.keyRecv), EXPECT.keyM2D);
  assert.strictEqual(b64u(d.prefixSend), EXPECT.prefixD2M);
  assert.strictEqual(b64u(d.prefixRecv), EXPECT.prefixM2D);
  assert.strictEqual(D_PRIV, EXPECT.desktopPrivate);
  assert.strictEqual(D_PUB, EXPECT.desktopPublic);
  assert.strictEqual(M_PRIV, EXPECT.mobilePrivate);
  assert.strictEqual(M_PUB, EXPECT.mobilePublic);
});

test('deriveSession — pairId مختلف يعطي مادة مختلفة كلياً (الملح فعّال)', () => {
  const a = desktopSession(PAIR_ID);
  const b = desktopSession(`${PAIR_ID}-other`);
  assert.notDeepStrictEqual(a.keySend, b.keySend);
  assert.notDeepStrictEqual(a.prefixSend, b.prefixSend);
});

test('deriveSession — رفض المدخلات المشوّهة fail-closed', () => {
  const base = { myPrivate: D_PRIV, theirPublic: M_PUB, pairId: PAIR_ID, role: 'desktop' };
  expectFail('bad_role', () => mc.deriveSession({ ...base, role: 'server' }));
  expectFail('bad_role', () => mc.deriveSession({ ...base, role: undefined }));
  expectFail('bad_role', () => mc.deriveSession());
  expectFail('bad_pair_id', () => mc.deriveSession({ ...base, pairId: '' }));
  expectFail('bad_pair_id', () => mc.deriveSession({ ...base, pairId: 42 }));
  expectFail('bad_pair_id', () => mc.deriveSession({ ...base, pairId: 'x'.repeat(513) }));
  expectFail('bad_private_key', () => mc.deriveSession({ ...base, myPrivate: b64u(Buffer.alloc(31)) }));
  expectFail('bad_private_key', () => mc.deriveSession({ ...base, myPrivate: 'not base64!!' }));
  expectFail('bad_private_key', () => mc.deriveSession({ ...base, myPrivate: null }));
  // نقطة عامة بطول خاطئ / بادئة مضغوطة / خارج المنحنى
  expectFail('bad_public_key', () => mc.deriveSession({ ...base, theirPublic: b64u(Buffer.alloc(64)) }));
  const compressed = Buffer.concat([Buffer.from([0x02]), fromB64u(M_PUB).subarray(1, 33), Buffer.alloc(32)]);
  expectFail('bad_public_key', () => mc.deriveSession({ ...base, theirPublic: b64u(compressed) }));
  const offCurve = fromB64u(M_PUB);
  offCurve[64] ^= 0x01; // إحداثي Y مبعوث ⇒ نقطة ليست على المنحنى
  expectFail('bad_public_key', () => mc.deriveSession({ ...base, theirPublic: b64u(offCurve) }));
});

// ═══════════════════════ 3) الإطار وذهاب-إياب ═══════════════════════

test('seal/open — ذهاب-إياب بالاتجاهين بجلستين حقيقيتين', () => {
  const d = desktopSession();
  const m = mobileSession();
  const messages = ['مرحباً من سطر', '', '{"decision":"allow"}', 'x'.repeat(5000), '🔐 رمز'];
  for (const msg of messages) {
    const pt = Buffer.from(msg, 'utf8');
    assert.strictEqual(mc.open(m, mc.seal(d, pt)).toString('utf8'), msg, 'D2M round-trip');
    assert.strictEqual(mc.open(d, mc.seal(m, pt)).toString('utf8'), msg, 'M2D round-trip');
  }
  assert.strictEqual(d.counterSend, messages.length);
  assert.strictEqual(m.counterSend, messages.length);
  assert.strictEqual(d.lastRecvCounter, messages.length - 1);
  assert.strictEqual(m.lastRecvCounter, messages.length - 1);
});

test('الإطار — الأطوال والحقول مطابقة للعقد', () => {
  const d = desktopSession();
  const m = mobileSession();
  for (const len of [0, 1, 16, 17, 1000]) {
    const pt = Buffer.alloc(len, 0x61);
    const before = d.counterSend;
    const frame = mc.seal(d, pt);
    assert.strictEqual(frame.length, mc.HEADER_LEN + len + mc.TAG_LEN, 'frame length contract');
    assert.strictEqual(frame[0], mc.VERSION);
    assert.strictEqual(frame[1], mc.DIR_D2M);
    assert.strictEqual(frame.readBigUInt64BE(2), BigInt(before), 'counter is big-endian at offset 2');
    assert.strictEqual(d.counterSend, before + 1, 'seal increments counterSend');
    assert.deepStrictEqual(mc.open(m, frame), pt);
  }
  assert.strictEqual(mc.HEADER_LEN, 10);
  assert.strictEqual(mc.TAG_LEN, 16);
  assert.strictEqual(mc.NONCE_LEN, 12);
});

test('الإطار — النص المعمّى لا يساوي الصريح والإطاران لرسالتين متطابقتين مختلفان', () => {
  const d = desktopSession();
  const pt = Buffer.from('نفس الرسالة', 'utf8');
  const f1 = mc.seal(d, pt);
  const f2 = mc.seal(d, pt);
  assert.notDeepStrictEqual(f1.subarray(mc.HEADER_LEN), f2.subarray(mc.HEADER_LEN), 'counter changes nonce');
  assert.strictEqual(f1.subarray(mc.HEADER_LEN, f1.length - mc.TAG_LEN).includes(pt), false);
});

test('seal — رفض المدخل غير البايتي والسقف والعدّاد المستنفد', () => {
  const d = desktopSession();
  expectFail('bad_plaintext', () => mc.seal(d, 'نص وليس بايتات'));
  expectFail('bad_plaintext', () => mc.seal(d, null));
  expectFail('plaintext_too_large', () => mc.seal(d, Buffer.alloc(mc.MAX_PLAINTEXT + 1)));
  expectFail('bad_session', () => mc.seal(null, Buffer.alloc(1)));
  expectFail('bad_session', () => mc.seal({}, Buffer.alloc(1)));
  const spent = desktopSession();
  spent.counterSend = mc.MAX_COUNTER;
  expectFail('counter_exhausted', () => mc.seal(spent, Buffer.alloc(1)));
});

// ═══════════════════════ 4) رفض الإعادة (replay) ═══════════════════════

test('open — رفض إعادة الإطار نفسه (عدّاد مكرر)', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('once', 'utf8'));
  assert.strictEqual(mc.open(m, frame).toString('utf8'), 'once');
  expectFail('replay', () => mc.open(m, frame));
  expectFail('replay', () => mc.open(m, frame));
  assert.strictEqual(m.lastRecvCounter, 0);
});

test('open — رفض إطار أقدم بعد قبول أحدث', () => {
  const d = desktopSession();
  const m = mobileSession();
  const f0 = mc.seal(d, Buffer.from('a', 'utf8'));
  const f1 = mc.seal(d, Buffer.from('b', 'utf8'));
  const f2 = mc.seal(d, Buffer.from('c', 'utf8'));
  assert.strictEqual(mc.open(m, f2).toString('utf8'), 'c');
  expectFail('replay', () => mc.open(m, f1));
  expectFail('replay', () => mc.open(m, f0));
  assert.strictEqual(m.lastRecvCounter, 2, 'rejected frames must not move the watermark');
});

test('open — الفجوة مقبولة (تزايد تام لا تتابع)', () => {
  const d = desktopSession();
  const m = mobileSession();
  const f0 = mc.seal(d, Buffer.from('0', 'utf8'));
  mc.seal(d, Buffer.from('1', 'utf8')); // مفقود على السلك
  const f2 = mc.seal(d, Buffer.from('2', 'utf8'));
  assert.strictEqual(mc.open(m, f0).toString('utf8'), '0');
  assert.strictEqual(mc.open(m, f2).toString('utf8'), '2');
  assert.strictEqual(m.lastRecvCounter, 2);
});

test('open — رفض عدّاد يتجاوز نطاق العدد الآمن', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('hi', 'utf8'));
  frame.writeBigUInt64BE(0xffffffffffffffffn, 2);
  expectFail('bad_counter', () => mc.open(m, frame));
  assert.strictEqual(m.lastRecvCounter, -1);
});

// ═══════════════════════ 5) العبث (tag / dir / AAD / version) ═══════════════════════

test('open — رفض وسم مصادقة مبعوث', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('tamper me', 'utf8'));
  frame[frame.length - 1] ^= 0x01;
  expectFail('bad_tag', () => mc.open(m, frame));
  assert.strictEqual(m.lastRecvCounter, -1, 'failed auth must not advance the watermark');
});

test('open — رفض نص معمّى مبعوث', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('tamper me', 'utf8'));
  frame[mc.HEADER_LEN] ^= 0x80;
  expectFail('bad_tag', () => mc.open(m, frame));
});

test('open — رفض AAD مبعوث (العدّاد داخل الترويسة)', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('aad', 'utf8'));
  // رفع العدّاد يتخطى حارس replay فيبلغ فحص الوسم — وهو ما نريد إثباته
  frame.writeBigUInt64BE(7n, 2);
  expectFail('bad_tag', () => mc.open(m, frame));
  assert.strictEqual(m.lastRecvCounter, -1);
});

test('open — رفض الاتجاه المبعوث/المنعكس', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('dir', 'utf8'));
  const flipped = Buffer.from(frame);
  flipped[1] = mc.DIR_D2M === frame[1] ? mc.DIR_M2D : mc.DIR_D2M;
  expectFail('bad_direction', () => mc.open(m, flipped));
  // الانعكاس: الديسكتوب لا يفتح إطاره الصادر (نفس اتجاه الإرسال)
  expectFail('bad_direction', () => mc.open(d, frame));
  // اتجاه غير معلن أصلاً
  const bogus = Buffer.from(frame);
  bogus[1] = 0x09;
  expectFail('bad_direction', () => mc.open(m, bogus));
});

test('open — رفض إصدار غير معروف قبل أي تعمية', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('v', 'utf8'));
  frame[0] = 0x02;
  expectFail('bad_version', () => mc.open(m, frame));
});

test('open — رفض إطار مبتور أو ضخم أو غير بايتي', () => {
  const d = desktopSession();
  const m = mobileSession();
  const frame = mc.seal(d, Buffer.from('short', 'utf8'));
  expectFail('bad_frame', () => mc.open(m, frame.subarray(0, mc.HEADER_LEN + mc.TAG_LEN - 1)));
  expectFail('bad_frame', () => mc.open(m, Buffer.alloc(0)));
  expectFail('bad_frame', () => mc.open(m, 'AQE='));
  expectFail('bad_frame', () => mc.open(m, Buffer.alloc(mc.HEADER_LEN + mc.TAG_LEN + mc.MAX_PLAINTEXT + 1)));
  expectFail('bad_session', () => mc.open(null, frame));
});

test('open — طرف ثالث بمفاتيحه لا يفكّ الإطار', () => {
  const d = desktopSession();
  const frame = mc.seal(d, Buffer.from('سرّي', 'utf8'));
  const intruder = mc.deriveSession({ myPrivate: T_PRIV, theirPublic: D_PUB, pairId: PAIR_ID, role: 'mobile' });
  expectFail('bad_tag', () => mc.open(intruder, frame));
});

test('open — جلسة بـpairId مختلف لا تفكّ الإطار', () => {
  const d = desktopSession(PAIR_ID);
  const m = mobileSession(`${PAIR_ID}-other`);
  const frame = mc.seal(d, Buffer.from('mismatch', 'utf8'));
  expectFail('bad_tag', () => mc.open(m, frame));
});

// ═══════════════════════ 6) SAS ═══════════════════════

test('sas — ست خانات عشرية ومتطابق على الطرفين', () => {
  const fromDesktop = mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: PAIR_ID });
  const fromMobile = mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: PAIR_ID });
  assert.match(fromDesktop, /^[0-9]{6}$/);
  assert.strictEqual(fromDesktop, fromMobile, 'both sides must read the same code');
  assert.strictEqual(fromDesktop, EXPECT.sas, 'frozen SAS vector');
  // قبول البايتات الخام كما base64url
  assert.strictEqual(
    mc.sas({ desktopPublic: fromB64u(D_PUB), mobilePublic: fromB64u(M_PUB), pairId: PAIR_ID }),
    fromDesktop
  );
});

test('sas — يتغير عند تبديل مفتاح (كشف MITM) أو pairId أو ترتيب الطرفين', () => {
  const base = mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: PAIR_ID });
  assert.notStrictEqual(base, mc.sas({ desktopPublic: T_PUB, mobilePublic: M_PUB, pairId: PAIR_ID }));
  assert.notStrictEqual(base, mc.sas({ desktopPublic: D_PUB, mobilePublic: T_PUB, pairId: PAIR_ID }));
  assert.notStrictEqual(base, mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: `${PAIR_ID}!` }));
  assert.notStrictEqual(base, mc.sas({ desktopPublic: M_PUB, mobilePublic: D_PUB, pairId: PAIR_ID }));
  // بت واحد مبعوث في المفتاح العام يغيّر الرمز
  const nudged = fromB64u(M_PUB);
  nudged[10] ^= 0x01;
  assert.notStrictEqual(base, mc.sas({ desktopPublic: D_PUB, mobilePublic: b64u(nudged), pairId: PAIR_ID }));
});

test('sas — تصفير البادئة إلى ست خانات (بحث قطعي عن حالة صغيرة)', () => {
  let found = null;
  for (let i = 0; i < 5000 && !found; i += 1) {
    const code = mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: `sas-pad-${i}` });
    if (code[0] === '0') found = { i, code };
  }
  assert.ok(found, 'expected a leading-zero SAS within the deterministic search');
  assert.strictEqual(found.code.length, 6);
  assert.match(found.code, /^0[0-9]{5}$/);
});

test('sas — رفض المدخلات المشوّهة', () => {
  expectFail('bad_public_key', () => mc.sas({ desktopPublic: 'zz', mobilePublic: M_PUB, pairId: PAIR_ID }));
  expectFail('bad_public_key', () => mc.sas({ desktopPublic: D_PUB, mobilePublic: b64u(Buffer.alloc(65)), pairId: PAIR_ID }));
  expectFail('bad_pair_id', () => mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: '' }));
  expectFail('bad_public_key', () => mc.sas());
});

// ═══════════════ 6ب) الاقتران المعمّى عبر وسيط (§7.2) ═══════════════
// نموذج التهديد المحدَّد: وسيط ينقل الإطار ويحاول قراءة السرّ أو الاقتران بمفتاحه.

const PAIR_PAYLOAD = { secretProof: 's'.repeat(43), deviceId: 'ab485809d2019244', label: 'جوالي' };
const FIXED_PAIR_NONCE = Buffer.from('0b1c2d3e4f5a6b7c8d9e0f1a', 'hex');

function sealPair(overrides) {
  return mc.sealPairing(Object.assign({
    mobilePrivate: M_PRIV, mobilePublic: M_PUB, desktopPublic: D_PUB,
    pairId: PAIR_ID, payload: PAIR_PAYLOAD, nonce: FIXED_PAIR_NONCE,
  }, overrides || {}));
}

test('sealPairing/openPairing — دورة كاملة وبنية الإطار المجمّدة', () => {
  const frame = sealPair();
  assert.strictEqual(frame[0], mc.VERSION, 'بايت النسخة');
  assert.strictEqual(frame[1], mc.PAIR_KIND, 'بايت النوع 0x03');
  assert.strictEqual(frame[2], 0x04, 'النقطة غير مضغوطة');
  assert.strictEqual(mc.PAIR_HEADER_LEN, 79);
  assert.ok(frame.length > mc.PAIR_HEADER_LEN + mc.TAG_LEN);
  const out = mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame });
  assert.strictEqual(out.mobilePublic, M_PUB, 'مفتاح الجوال يعود كما أُرسل');
  assert.deepStrictEqual(out.payload, PAIR_PAYLOAD, 'الحمولة سليمة');
});

test('sealPairing — السرّ لا يظهر في بايتات الإطار إطلاقاً', () => {
  const frame = sealPair();
  // بحث نصي وثنائي: الوسيط يرى بايتات معتمة لا سرّاً
  assert.ok(!frame.toString('latin1').includes(PAIR_PAYLOAD.secretProof), 'السرّ غير ظاهر');
  assert.ok(!frame.toString('latin1').includes(PAIR_PAYLOAD.deviceId), 'المعرّف غير ظاهر');
  assert.ok(!frame.toString('utf8').includes('جوالي'), 'الوسم غير ظاهر');
  // ما يظهر صراحةً هو mobilePublic وحده (لازم للاشتقاق) — ومربوط في الـAAD
  assert.strictEqual(frame.subarray(2, 67).toString('base64url'), M_PUB);
});

test('openPairing — الوسيط لا يستطيع تبديل mobilePublic بمفتاحه', () => {
  // الهجوم: وسيط يستبدل المفتاح العام ليقترن هو، مع إبقاء النص المعمّى كما هو.
  // الحماية الأولى ليست الـAAD بل اشتقاق المفتاح من المفتاح العام في الإطار نفسه:
  // التبديل يجعل سطح المكتب يشتقّ مفتاحاً آخر فيفشل الفكّ. (أُثبت بإزالة الربط من
  // الـAAD فمرّت كل الفحوص — الـAAD دفاع في العمق لا الحاجز الأول.)
  const frame = sealPair();
  const forged = Buffer.from(frame);
  Buffer.from(T_PUB, 'base64url').copy(forged, 2);
  expectFail('bad_tag', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: forged }));
});

test('openPairing — لا فكّ بمفتاح سطح مكتب آخر (الوسيط لا يقرأ)', () => {
  const frame = sealPair();
  expectFail('bad_tag', () => mc.openPairing({ desktopPrivate: T_PRIV, pairId: PAIR_ID, frame }));
});

test('openPairing — pairId مختلف يكسر الفكّ (الملح مربوط)', () => {
  const frame = sealPair();
  expectFail('bad_tag', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID + 'x', frame }));
});

test('openPairing — العبث بالنص أو الوسم أو الـnonce يُرفض', () => {
  for (const index of [mc.PAIR_HEADER_LEN, 70, 2 + 65]) {
    const tampered = sealPair();
    tampered[index] ^= 0x01;
    expectFail('bad_tag', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: tampered }));
  }
  const shortTag = sealPair();
  shortTag[shortTag.length - 1] ^= 0xff;
  expectFail('bad_tag', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: shortTag }));
});

test('openPairing — خلط الأنواع مرفوض (إطار جلسة ليس إطار اقتران)', () => {
  // إطار جلسة قصير يسقط على حارس الطول أولاً (فشل مغلق سليم)
  const shortSession = mc.seal(desktopSession(), Buffer.from('x', 'utf8'));
  expectFail('bad_frame', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: shortSession }));
  // وإطار جلسة طويل يبلغ فحص النوع فيُرفض به — لا يُقبل مكان إطار اقتران
  const longSession = mc.seal(desktopSession(), Buffer.alloc(200, 0x41));
  expectFail('bad_kind', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: longSession }));
  const wrongKind = sealPair();
  wrongKind[1] = mc.DIR_D2M;
  expectFail('bad_kind', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: wrongKind }));
  const wrongVersion = sealPair();
  wrongVersion[0] = 0x02;
  expectFail('bad_version', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: wrongVersion }));
});

test('sealPairing/openPairing — الحدود fail-closed', () => {
  expectFail('bad_payload', () => sealPair({ payload: null }));
  expectFail('bad_payload', () => sealPair({ payload: [1, 2] }));
  expectFail('bad_payload', () => sealPair({ payload: 'نص' }));
  expectFail('bad_payload', () => sealPair({ payload: { big: 'x'.repeat(mc.MAX_PAIR_PLAINTEXT) } }));
  expectFail('bad_nonce', () => sealPair({ nonce: Buffer.alloc(11) }));
  expectFail('bad_public_key', () => sealPair({ desktopPublic: b64u(Buffer.alloc(65)) }));
  expectFail('bad_private_key', () => sealPair({ mobilePrivate: 'zz' }));
  expectFail('bad_pair_id', () => sealPair({ pairId: '' }));
  expectFail('bad_frame', () => mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: Buffer.alloc(10) }));
  expectFail('bad_frame', () => mc.openPairing({
    desktopPrivate: D_PRIV, pairId: PAIR_ID,
    frame: Buffer.alloc(mc.PAIR_HEADER_LEN + mc.MAX_PAIR_PLAINTEXT + mc.TAG_LEN + 1),
  }));
});

test('sealPairing — nonce عشوائي افتراضاً فلا يتكرر إطاران متطابقان', () => {
  const a = mc.sealPairing({
    mobilePrivate: M_PRIV, mobilePublic: M_PUB, desktopPublic: D_PUB,
    pairId: PAIR_ID, payload: PAIR_PAYLOAD,
  });
  const b = mc.sealPairing({
    mobilePrivate: M_PRIV, mobilePublic: M_PUB, desktopPublic: D_PUB,
    pairId: PAIR_ID, payload: PAIR_PAYLOAD,
  });
  // المفتاح ثابت في (الزوج، desktopPublic، pairId): لولا عشوائية الـnonce لتطابق
  // الإطاران وتكرر الـnonce تحت مفتاح واحد
  assert.notStrictEqual(a.subarray(67, 79).toString('hex'), b.subarray(67, 79).toString('hex'));
  assert.notStrictEqual(a.toString('base64url'), b.toString('base64url'));
  // وكلاهما يُفكّ سليماً
  assert.deepStrictEqual(mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: a }).payload, PAIR_PAYLOAD);
  assert.deepStrictEqual(mc.openPairing({ desktopPrivate: D_PRIV, pairId: PAIR_ID, frame: b }).payload, PAIR_PAYLOAD);
});

// ═══════════════════════ 7) الإطارات المجمّدة + كتابة الـvectors ═══════════════════════

test('vectors — الإطارات المختومة تطابق البايتات المجمّدة', () => {
  const d = desktopSession();
  assert.strictEqual(b64u(mc.seal(d, Buffer.from(MSG_D2M_0, 'utf8'))), EXPECT.frameD2M0);
  assert.strictEqual(b64u(mc.seal(d, Buffer.from(MSG_D2M_1, 'utf8'))), EXPECT.frameD2M1);
  const m = mobileSession();
  assert.strictEqual(b64u(mc.seal(m, Buffer.from(MSG_M2D_0, 'utf8'))), EXPECT.frameM2D0);
});

const VECTORS_DIR = path.join(__dirname, 'fixtures');
const VECTORS_PATH = path.join(VECTORS_DIR, 'mobilecrypto-vectors.json');

function buildVectors() {
  const d = desktopSession();
  const m = mobileSession();
  const frameD2M0 = mc.seal(d, Buffer.from(MSG_D2M_0, 'utf8'));
  const frameD2M1 = mc.seal(d, Buffer.from(MSG_D2M_1, 'utf8'));
  const frameM2D0 = mc.seal(m, Buffer.from(MSG_M2D_0, 'utf8'));
  return {
    _readme:
      'عقد التوافق البايتي لطبقة التعمية (electron/mobilecrypto.js §4.1). ' +
      'على PWA أن تعيد إنتاج derived و frames حرفياً بـWebCrypto. ' +
      'كل الحقول الثنائية بترميز base64url بلا حشو.',
    version: 1,
    generated_by: 'scripts/mobilecrypto-test.js',
    algorithms: {
      curve: 'P-256 (prime256v1)',
      ecdh: 'raw shared secret = X coordinate, 32 bytes (WebCrypto deriveBits ECDH 256)',
      kdf: 'HKDF-SHA256(ikm=shared, salt=utf8(pair_id), info=<below>)',
      cipher: 'AES-256-GCM, 12-byte nonce, 16-byte tag appended to ciphertext',
      hkdf_info_keys: 'satr-mobile-v1',
      hkdf_info_nonce: 'satr-mobile-v1-nonce',
      key_bytes: 64,
      nonce_prefix_bytes: 8
    },
    frame: {
      layout: 'version(1) || dir(1) || counter(8, big-endian) || ciphertext || tag(16)',
      aad: 'the 10-byte header (version || dir || counter)',
      nonce: 'prefix(4) || counter(8)',
      version: mc.VERSION,
      dir_desktop_to_mobile: mc.DIR_D2M,
      dir_mobile_to_desktop: mc.DIR_M2D,
      header_len: mc.HEADER_LEN,
      tag_len: mc.TAG_LEN,
      nonce_len: mc.NONCE_LEN,
      replay_rule: 'receiver accepts only strictly increasing counters (gaps allowed)'
    },
    webcrypto_notes: [
      "public key: importKey('raw', 65 bytes, {name:'ECDH', namedCurve:'P-256'})",
      "private key: importKey('jwk', {kty:'EC', crv:'P-256', d, x, y}) where x = public[1..33], y = public[33..65]",
      "hkdf keys: deriveBits({name:'HKDF', hash:'SHA-256', salt, info:utf8('satr-mobile-v1')}, ikm, 512) -> key_d2m||key_m2d",
      "hkdf nonce prefixes: a SECOND deriveBits with info:utf8('satr-mobile-v1-nonce') and length 64 -> prefix_d2m||prefix_m2d",
      'aes-gcm: additionalData = header, tagLength = 128; WebCrypto appends the tag, matching this layout',
      'pair_id must be unique per session: it is the HKDF salt and the counter restarts at 0'
    ],
    pair_id: PAIR_ID,
    keys: {
      desktop_private: D_PRIV,
      desktop_public: D_PUB,
      mobile_private: M_PRIV,
      mobile_public: M_PUB
    },
    derived: {
      key_d2m: b64u(d.keySend),
      key_m2d: b64u(d.keyRecv),
      prefix_d2m: b64u(d.prefixSend),
      prefix_m2d: b64u(d.prefixRecv)
    },
    sas: {
      rule: 'decimal(first 20 bits of SHA-256(desktop_public || mobile_public || utf8(pair_id))) % 1e6, padded to 6',
      expected: mc.sas({ desktopPublic: D_PUB, mobilePublic: M_PUB, pairId: PAIR_ID })
    },
    frames: [
      {
        note: 'desktop -> mobile, counter 0',
        direction: 'd2m',
        counter: 0,
        plaintext_utf8: MSG_D2M_0,
        plaintext_b64url: b64u(Buffer.from(MSG_D2M_0, 'utf8')),
        frame_b64url: b64u(frameD2M0),
        frame_len: frameD2M0.length
      },
      {
        note: 'desktop -> mobile, counter 1, empty plaintext',
        direction: 'd2m',
        counter: 1,
        plaintext_utf8: MSG_D2M_1,
        plaintext_b64url: b64u(Buffer.from(MSG_D2M_1, 'utf8')),
        frame_b64url: b64u(frameD2M1),
        frame_len: frameD2M1.length
      },
      {
        note: 'mobile -> desktop, counter 0',
        direction: 'm2d',
        counter: 0,
        plaintext_utf8: MSG_M2D_0,
        plaintext_b64url: b64u(Buffer.from(MSG_M2D_0, 'utf8')),
        frame_b64url: b64u(frameM2D0),
        frame_len: frameM2D0.length
      }
    ]
  };
}

test('vectors — كتابة الملف ثم فتح إطاراته بجلسات جديدة من محتواه', () => {
  fs.mkdirSync(VECTORS_DIR, { recursive: true });
  const vectors = buildVectors();
  fs.writeFileSync(VECTORS_PATH, `${JSON.stringify(vectors, null, 2)}\n`, 'utf8');

  // إعادة القراءة من القرص: الملف وحده يجب أن يكفي لإعادة إنتاج كل شيء
  const loaded = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));
  const dSide = mc.deriveSession({
    myPrivate: loaded.keys.desktop_private,
    theirPublic: loaded.keys.mobile_public,
    pairId: loaded.pair_id,
    role: 'desktop'
  });
  const mSide = mc.deriveSession({
    myPrivate: loaded.keys.mobile_private,
    theirPublic: loaded.keys.desktop_public,
    pairId: loaded.pair_id,
    role: 'mobile'
  });
  assert.strictEqual(b64u(dSide.keySend), loaded.derived.key_d2m);
  assert.strictEqual(b64u(dSide.keyRecv), loaded.derived.key_m2d);
  assert.strictEqual(b64u(dSide.prefixSend), loaded.derived.prefix_d2m);
  assert.strictEqual(b64u(dSide.prefixRecv), loaded.derived.prefix_m2d);
  assert.strictEqual(
    mc.sas({
      desktopPublic: loaded.keys.desktop_public,
      mobilePublic: loaded.keys.mobile_public,
      pairId: loaded.pair_id
    }),
    loaded.sas.expected
  );

  for (const entry of loaded.frames) {
    const receiver = entry.direction === 'd2m' ? mSide : dSide;
    const frame = fromB64u(entry.frame_b64url);
    assert.strictEqual(frame.length, entry.frame_len);
    assert.strictEqual(frame[1], entry.direction === 'd2m' ? mc.DIR_D2M : mc.DIR_M2D);
    assert.strictEqual(Number(frame.readBigUInt64BE(2)), entry.counter);
    const plain = mc.open(receiver, frame);
    assert.strictEqual(plain.toString('utf8'), entry.plaintext_utf8);
    assert.deepStrictEqual(plain, fromB64u(entry.plaintext_b64url));
  }

  // الملف لا يحمل شيئاً غير معلن في العقد
  assert.deepStrictEqual(Object.keys(loaded.keys).sort(), [
    'desktop_private',
    'desktop_public',
    'mobile_private',
    'mobile_public'
  ]);
});

// ═══════════════════════ الخاتمة ═══════════════════════

if (failures.length) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}\n  ${f.err && f.err.message}`);
    if (f.err && f.err.stack) console.error(f.err.stack.split('\n').slice(1, 4).join('\n'));
  }
  console.error(`\nmobilecrypto-test: FAILED — ${failures.length} من ${passed + failures.length}`);
  process.exit(1);
}

console.log(
  `mobilecrypto-test: ok — ${passed}/${passed} ` +
    '(التمثيل والاشتقاق والإطار ورفض الإعادة والعبث والاتجاه وSAS والتوافق البايتي)'
);
console.log(`vectors: ${path.relative(process.cwd(), VECTORS_PATH)}`);
process.exit(0);
