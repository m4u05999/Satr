/**
 * اختبارات قطعية بلا شبكة لـ mobilepair.js.
 * يستخدم مجلداً مؤقتاً معزولاً تحت temp بدل ~/.satr الحقيقي.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testHome = path.join(os.tmpdir(), 'satr-mobilepair-test-' + process.pid + '-' + Date.now());
const realHomedir = os.homedir;
os.homedir = () => testHome;

const mobilepair = require('../electron/mobilepair');

function generateMobilePublic() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error('FAIL:', message, 'expected', expected, 'got', actual);
    process.exitCode = 1;
  }
}

function cleanup() {
  os.homedir = realHomedir;
  try {
    fs.rmSync(testHome, { recursive: true, force: true });
  } catch (error) {
    // نتجاهل؛ لا يؤثر على نتيجة الاختبار
  }
}

function runTests() {
  const id = mobilepair.ensureDesktopIdentity();
  assert(id && typeof id.publicKey === 'string', 'ensureDesktopIdentity returns publicKey');
  assert(Object.keys(id).length === 1, 'ensureDesktopIdentity does not leak extra fields');
  assert(!('privateKey' in id), 'ensureDesktopIdentity never returns privateKey');

  // ثبات الهوية عبر إعادة التحميل
  delete require.cache[require.resolve('../electron/mobilepair')];
  const mobilepairReloaded = require('../electron/mobilepair');
  const id2 = mobilepairReloaded.ensureDesktopIdentity();
  assertEqual(id2.publicKey, id.publicKey, 'identity publicKey stable across reload');

  // payload بصلاحية
  const payload = mobilepair.buildPairingPayload();
  assert(payload.v === 1, 'payload version is 1');
  assert(/^[a-f0-9]{32}$/i.test(payload.pairId), 'pairId is 16B hex');
  assert(/^[A-Za-z0-9_-]{43}$/.test(payload.secret), 'secret is 32B base64url');
  assertEqual(payload.desktopPublic, id.publicKey, 'payload carries desktop public key');
  const ttl = payload.expiresAt - payload.createdAt;
  assert(ttl > 0 && ttl <= mobilepair.PAIRING_TTL_MS, 'payload expiry within 3 minutes');

  // إتمام اقتران بسرّ صحيح
  const mobilePublic1 = generateMobilePublic();
  const complete1 = mobilepair.completePairing({
    pairId: payload.pairId,
    secretProof: payload.secret,
    mobilePublic: mobilePublic1,
    label: 'جهاز اختبار',
    deviceId: 'abcdef0123456789',
  });
  assert(complete1.ok === true, 'completePairing succeeds with correct secret');
  assertEqual(complete1.deviceId, 'abcdef0123456789', 'completePairing returns deviceId');

  const devices = mobilepair.listDevices();
  assert(devices.length === 1, 'listDevices contains one device');
  const first = devices[0];
  assertEqual(first.deviceId, 'abcdef0123456789', 'listed deviceId matches');
  assertEqual(first.label, 'جهاز اختبار', 'listed label matches');
  assert(first.revoked === false, 'new device not revoked');
  assert(!('secret' in first), 'listDevices does not leak secret');
  assert(!('privateKey' in first), 'listDevices does not leak privateKey');
  assert(!('publicKey' in first), 'listDevices does not expose raw mobile publicKey');

  // سرّ خاطئ
  const payload2 = mobilepair.buildPairingPayload();
  const wrong = mobilepair.completePairing({
    pairId: payload2.pairId,
    secretProof: payload2.secret + 'x',
    mobilePublic: generateMobilePublic(),
    label: 'x',
    deviceId: 'aabbccddeeff0011',
  });
  assert(wrong.ok === false, 'completePairing rejects wrong secret');

  // سرّ منتهٍ (نحاكي الزمن)
  const payload3 = mobilepair.buildPairingPayload();
  const originalNow = Date.now;
  global.Date.now = () => payload3.createdAt + mobilepair.PAIRING_TTL_MS + 1000;
  const expired = mobilepair.completePairing({
    pairId: payload3.pairId,
    secretProof: payload3.secret,
    mobilePublic: generateMobilePublic(),
    label: 'x',
    deviceId: '1122334455667788',
  });
  global.Date.now = originalNow;
  assert(expired.ok === false, 'completePairing rejects expired secret');

  // تنقية label + deviceId
  const payload4 = mobilepair.buildPairingPayload();
  const longLabel = 'أ'.repeat(60) + '\u202e sneaky';
  const complete4 = mobilepair.completePairing({
    pairId: payload4.pairId,
    secretProof: payload4.secret,
    mobilePublic: generateMobilePublic(),
    label: longLabel,
    deviceId: '0011223344556677',
  });
  assert(complete4.ok === true, 'completePairing succeeds with long label');
  const listed4 = mobilepair.listDevices().find((d) => d.deviceId === '0011223344556677');
  assert(listed4, 'sanitized device listed');
  assert(listed4.label.length <= mobilepair.MAX_LABEL, 'label truncated to max');
  assert(!listed4.label.includes('\u202e'), 'bidi char removed from label');

  // deviceId غير صالح
  const payload5 = mobilepair.buildPairingPayload();
  const badDevice = mobilepair.completePairing({
    pairId: payload5.pairId,
    secretProof: payload5.secret,
    mobilePublic: generateMobilePublic(),
    label: 'x',
    deviceId: '../evil',
  });
  assert(badDevice.ok === false, 'completePairing rejects invalid deviceId');

  // سقف الأجهزة والطرد (10 + طرد الأقدم المُبطَل)
  const existing = mobilepair.listDevices().length;
  let added = [];
  for (let i = 0; i < 10 - existing; i++) {
    const p = mobilepair.buildPairingPayload();
    const deviceId = ('0000000000000000' + i.toString(16)).slice(-16);
    const r = mobilepair.completePairing({
      pairId: p.pairId,
      secretProof: p.secret,
      mobilePublic: generateMobilePublic(),
      label: 'bulk-' + i,
      deviceId,
    });
    assert(r.ok === true, 'bulk pairing ' + i + ' succeeds');
    added.push(deviceId);
  }
  assertEqual(mobilepair.listDevices().length, 10, 'device cap reached');

  // نبطل أقدم جهازين
  assert(mobilepair.revoke(added[0]).ok === true, 'revoke oldest succeeds');
  assert(mobilepair.revoke(added[1]).ok === true, 'revoke second oldest succeeds');

  const pNew1 = mobilepair.buildPairingPayload();
  const newDevice1 = ('ffffffffffffff01');
  const r1 = mobilepair.completePairing({
    pairId: pNew1.pairId,
    secretProof: pNew1.secret,
    mobilePublic: generateMobilePublic(),
    label: 'new1',
    deviceId: newDevice1,
  });
  assert(r1.ok === true, 'pairing after revoke evicts revoked slot 1');

  const pNew2 = mobilepair.buildPairingPayload();
  const newDevice2 = ('ffffffffffffff02');
  const r2 = mobilepair.completePairing({
    pairId: pNew2.pairId,
    secretProof: pNew2.secret,
    mobilePublic: generateMobilePublic(),
    label: 'new2',
    deviceId: newDevice2,
  });
  assert(r2.ok === true, 'pairing after revoke evicts revoked slot 2');

  assertEqual(mobilepair.listDevices().length, 10, 'device cap stays at 10');
  assert(!mobilepair.listDevices().some((d) => d.deviceId === added[0]), 'oldest revoked evicted');
  assert(!mobilepair.listDevices().some((d) => d.deviceId === added[1]), 'second revoked evicted');

  // عندما لا يوجد مُبطَل، السقف يمنع (نثبتها بمحاولة واحدة فوق الحد)
  const overflowPayload = mobilepair.buildPairingPayload();
  const overflowResult = mobilepair.completePairing({
    pairId: overflowPayload.pairId,
    secretProof: overflowPayload.secret,
    mobilePublic: generateMobilePublic(),
    label: 'overflow',
    deviceId: 'dddddddddddddddd',
  });
  assert(overflowResult.ok === false, 'device cap blocks when no revoked slot');

  // نُبطل أقدم جهاز حالي لإفساح مجال لاختبار الإبطال
  const slotToRevoke = mobilepair.listDevices()[0].deviceId;
  assert(mobilepair.revoke(slotToRevoke).ok === true, 'revoke slot to make room');

  // الإبطال يمنع الجهاز لاحقاً
  const victimPayload = mobilepair.buildPairingPayload();
  const victimId = 'baba123456789abc';
  const victimResult = mobilepair.completePairing({
    pairId: victimPayload.pairId,
    secretProof: victimPayload.secret,
    mobilePublic: generateMobilePublic(),
    label: 'ضحية',
    deviceId: victimId,
  });
  assert(victimResult.ok === true, 'victim device paired');
  assert(mobilepair.revoke(victimId).ok === true, 'revoke victim succeeds');
  const victimListed = mobilepair.listDevices().find((d) => d.deviceId === victimId);
  assert(victimListed && victimListed.revoked === true, 'victim listed as revoked');

  const retryPayload = mobilepair.buildPairingPayload();
  const retryResult = mobilepair.completePairing({
    pairId: retryPayload.pairId,
    secretProof: retryPayload.secret,
    mobilePublic: generateMobilePublic(),
    label: 'ضحية مرة أخرى',
    deviceId: victimId,
  });
  assert(retryResult.ok === false, 'revoked deviceId cannot pair again');

  // touch للمُبطَل لا يغير شيئاً ولا يتعطل
  const victimBeforeTouch = mobilepair.listDevices().find((d) => d.deviceId === victimId);
  assert(victimBeforeTouch, 'victim still present before touch pair');
  mobilepair.touch(victimId);
  const victimAfterTouch = mobilepair.listDevices().find((d) => d.deviceId === victimId);
  assert(victimAfterTouch && victimAfterTouch.lastSeen === victimBeforeTouch.lastSeen, 'touch on revoked does not change lastSeen');

  // touch
  const touchPayload = mobilepair.buildPairingPayload();
  const touchId = 'ccccddddaaaabbbb';
  const touchComplete = mobilepair.completePairing({
    pairId: touchPayload.pairId,
    secretProof: touchPayload.secret,
    mobilePublic: generateMobilePublic(),
    label: 'touchable',
    deviceId: touchId,
  });
  assert(touchComplete.ok === true, 'touch device paired');
  const beforeTouch = mobilepair.listDevices().find((d) => d.deviceId === touchId).lastSeen;
  // نضمن مرور وقت ملموس
  const sleepUntil = Date.now() + 15;
  while (Date.now() < sleepUntil) {}
  mobilepair.touch(touchId);
  const afterTouch = mobilepair.listDevices().find((d) => d.deviceId === touchId).lastSeen;
  assert(afterTouch > beforeTouch, 'touch updates lastSeen');

  if (process.exitCode) {
    console.log('Tests completed with failures.');
  } else {
    console.log('All mobilepair tests passed.');
  }
}

try {
  runTests();
} catch (error) {
  console.error('Test exception:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
