/**
 * دفتر أجهزة الجوال + دورة الاقتران + هوية سطح المكتب الثابتة.
 *
 * التخزين: ~/.satr/mobile-devices.json بكتابة ذرية أفضل جهد.
 * العشوائية والمفاتيح عبر node:crypto فقط — لا يستورد mobilecrypto في هذه الدفعة.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'mobile-devices.json');
const MAX_DEVICES = 10;
const MAX_PENDING = 32;
const PAIRING_TTL_MS = 3 * 60 * 1000;
const MAX_LABEL = 48;
const MAX_FILE = 256 * 1024;
const PUBLIC_B64URL_LEN = 87;  // 65 بايت غير مضغوط
const PRIVATE_B64URL_LEN = 43; // 32 بايت
const SECRET_B64URL_LEN = 43;  // 32 بايت
const PUSH_AUTH_B64URL_LEN = 22; // 16 بايت
const MAX_PUSH_ENDPOINT = 512;

const SAFE_HEX16 = /^[a-f0-9]{32}$/i;
const SAFE_DEVICE_HEX = /^[a-f0-9]{16,}$/i;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_URL_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function b64url(buf) {
  return buf.toString('base64url');
}

function safeMobilePublic(value) {
  if (typeof value !== 'string' || value.length !== PUBLIC_B64URL_LEN || !BASE64URL_RE.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 65 || decoded[0] !== 0x04) return null;
  return value;
}

function safePushSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3
      || !Object.prototype.hasOwnProperty.call(value, 'endpoint')
      || !Object.prototype.hasOwnProperty.call(value, 'p256dh')
      || !Object.prototype.hasOwnProperty.call(value, 'auth')) return null;
  if (typeof value.endpoint !== 'string' || !value.endpoint || value.endpoint.length > MAX_PUSH_ENDPOINT
      || UNSAFE_URL_TEXT_RE.test(value.endpoint)) return null;
  let parsed;
  try { parsed = new URL(value.endpoint); } catch { return null; }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  const p256dh = safeMobilePublic(value.p256dh);
  if (!p256dh || typeof value.auth !== 'string' || value.auth.length !== PUSH_AUTH_B64URL_LEN
      || !BASE64URL_RE.test(value.auth) || Buffer.from(value.auth, 'base64url').length !== 16) return null;
  return { endpoint: value.endpoint, p256dh, auth: value.auth };
}

function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

function safeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().trim();
  if (SAFE_DEVICE_HEX.test(normalized) || SAFE_UUID.test(normalized)) return normalized;
  return null;
}

function generateKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
}

function createStore(options = {}) {
  const file = options.file || process.env.SATR_MOBILE_DEVICES_FILE || DEFAULT_FILE;
  const io = options.fs || fs;
  let loaded = false;
  let identity = null;
  let vapid = null;
  let devices = [];
  const pending = new Map(); // pairId -> { secret, createdAt, expiresAt }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    identity = null;
    vapid = null;
    devices = [];
    pending.clear();

    let parsed = null;
    try {
      const stat = io.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE) return;
      parsed = JSON.parse(io.readFileSync(file, 'utf8'));
    } catch (error) {
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    if (parsed.identity && typeof parsed.identity === 'object') {
      const id = parsed.identity;
      if (
        typeof id.publicKey === 'string' &&
        id.publicKey.length === PUBLIC_B64URL_LEN &&
        BASE64URL_RE.test(id.publicKey) &&
        typeof id.privateKey === 'string' &&
        id.privateKey.length === PRIVATE_B64URL_LEN &&
        BASE64URL_RE.test(id.privateKey)
      ) {
        identity = {
          publicKey: id.publicKey,
          privateKey: id.privateKey,
        };
      }
    }

    if (parsed.vapid && typeof parsed.vapid === 'object') {
      const keys = parsed.vapid;
      if (
        typeof keys.publicKey === 'string' &&
        keys.publicKey.length === PUBLIC_B64URL_LEN &&
        BASE64URL_RE.test(keys.publicKey) &&
        typeof keys.privateKey === 'string' &&
        keys.privateKey.length === PRIVATE_B64URL_LEN &&
        BASE64URL_RE.test(keys.privateKey)
      ) {
        vapid = {
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        };
      }
    }

    if (Array.isArray(parsed.devices)) {
      for (const raw of parsed.devices) {
        if (!raw || typeof raw !== 'object') continue;
        const deviceId = safeDeviceId(raw.deviceId);
        if (!deviceId) continue;
        const publicKey = safeMobilePublic(raw.publicKey);
        if (!publicKey) continue;
        const label = cleanLabel(raw.label);
        const pairedAt = Number.isFinite(raw.pairedAt) ? raw.pairedAt : Date.now();
        const lastSeen = Number.isFinite(raw.lastSeen) ? raw.lastSeen : pairedAt;
        // سجل قديم بلا pairId: يبقى صالحاً للعرض والإبطال، لكن لا يُستأنف (لا ملح
        // HKDF ⇒ لا اشتقاق). `resumeMaterial` يرفضه فيُطلب اقتران جديد.
        const pairId = typeof raw.pairId === 'string' && SAFE_HEX16.test(raw.pairId.toLowerCase())
          ? raw.pairId.toLowerCase() : '';
        // العدّادات المحفوظة حارس أمني لا راحة: قراءتها المتحفّظة تعني الأعلى دائماً.
        const sendReserved = Number.isSafeInteger(raw.sendReserved) && raw.sendReserved >= 0
          ? raw.sendReserved : 0;
        const lastRecv = Number.isSafeInteger(raw.lastRecv) && raw.lastRecv >= -1
          ? raw.lastRecv : -1;
        const pushValue = raw.push && typeof raw.push === 'object' && !Array.isArray(raw.push)
          && Object.keys(raw.push).length === 4
          && Object.prototype.hasOwnProperty.call(raw.push, 'addedAt')
          ? safePushSubscription({
            endpoint: raw.push.endpoint,
            p256dh: raw.push.p256dh,
            auth: raw.push.auth,
          }) : null;
        const push = pushValue && Number.isFinite(raw.push.addedAt)
          ? { ...pushValue, addedAt: raw.push.addedAt } : null;
        devices.push({
          deviceId,
          label,
          pairedAt,
          lastSeen,
          revoked: raw.revoked === true,
          publicKey,
          pairId,
          sendReserved,
          lastRecv,
          ...(push ? { push } : {}),
        });
      }
    }
  }

  function persist() {
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    const payload = {
      identity: identity ? { publicKey: identity.publicKey, privateKey: identity.privateKey } : null,
      vapid: vapid ? { publicKey: vapid.publicKey, privateKey: vapid.privateKey } : null,
      devices,
    };
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      const serialized = JSON.stringify(payload, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE) return false;
      io.writeFileSync(temp, serialized, 'utf8');
      io.renameSync(temp, file);
      return true;
    } catch (error) {
      try { io.unlinkSync(temp); } catch (cleanupError) {}
      return false;
    }
  }

  function cleanupPending() {
    const now = Date.now();
    for (const [pairId, entry] of pending.entries()) {
      if (entry.expiresAt <= now) pending.delete(pairId);
    }
    if (pending.size > MAX_PENDING) {
      const entries = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toDelete = entries.slice(0, entries.length - MAX_PENDING);
      for (const [pairId] of toDelete) pending.delete(pairId);
    }
  }

  function ensureDesktopIdentity() {
    ensureLoaded();
    if (identity) return { publicKey: identity.publicKey };
    identity = generateKeyPair();
    persist(); // أفضل جهد؛ فشل القرص لا يكسر الهوية الحيّة
    return { publicKey: identity.publicKey };
  }

  function ensureVapidKeys() {
    ensureLoaded();
    if (vapid) return { publicKey: vapid.publicKey };
    vapid = generateKeyPair();
    persist(); // أفضل جهد؛ ثبات الزوج على القرص يحفظ صلاحية الاشتراكات
    return { publicKey: vapid.publicKey };
  }

  function buildPairingPayload() {
    ensureLoaded();
    cleanupPending();
    const id = ensureDesktopIdentity();
    const vapidKeys = ensureVapidKeys();
    const pairId = crypto.randomBytes(16).toString('hex');
    const secret = b64url(crypto.randomBytes(32));
    const createdAt = Date.now();
    const expiresAt = createdAt + PAIRING_TTL_MS;
    pending.set(pairId, { secret, createdAt, expiresAt });
    return {
      v: 1,
      pairId,
      secret,
      desktopPublic: id.publicKey,
      vapid: vapidKeys.publicKey,
      createdAt,
      expiresAt,
    };
  }

  function findPending(pairId, secretProof) {
    cleanupPending();
    const entry = pending.get(pairId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      pending.delete(pairId);
      return null;
    }
    if (entry.secret !== secretProof) return null;
    return entry;
  }

  function completePairing(input) {
    ensureLoaded();
    if (!input || typeof input !== 'object') return { ok: false, error: 'bad_input' };

    const pairId = typeof input.pairId === 'string' ? input.pairId.toLowerCase().trim() : '';
    if (!SAFE_HEX16.test(pairId)) return { ok: false, error: 'bad_pair_id' };

    const secretProof = typeof input.secretProof === 'string' ? input.secretProof : '';
    if (secretProof.length !== SECRET_B64URL_LEN || !BASE64URL_RE.test(secretProof)) {
      return { ok: false, error: 'bad_secret' };
    }

    const mobilePublic = safeMobilePublic(input.mobilePublic);
    if (!mobilePublic) return { ok: false, error: 'bad_public_key' };

    const rawDeviceId = safeDeviceId(input.deviceId);
    if (!rawDeviceId) return { ok: false, error: 'bad_device_id' };

    const label = cleanLabel(input.label);

    const entry = findPending(pairId, secretProof);
    if (!entry) return { ok: false, error: 'invalid_or_expired_secret' };

    if (devices.some((device) => device.deviceId === rawDeviceId)) {
      return { ok: false, error: 'device_exists' };
    }

    // طرد الأقدم المُبطَل لإفساح مجال عند السقف
    if (devices.length >= MAX_DEVICES) {
      const evictIndex = devices.findIndex((device) => device.revoked === true);
      if (evictIndex === -1) return { ok: false, error: 'device_limit' };
      devices.splice(evictIndex, 1);
    }

    const now = Date.now();
    devices.push({
      deviceId: rawDeviceId,
      label,
      pairedAt: now,
      lastSeen: now,
      revoked: false,
      publicKey: mobilePublic,
      // ملح HKDF لهذا الاقتران: بدونه لا يمكن إعادة اشتقاق الجلسة بعد إعادة التشغيل
      pairId,
      sendReserved: 0,
      lastRecv: -1,
    });

    pending.delete(pairId);
    persist();
    return { ok: true, deviceId: rawDeviceId };
  }

  /**
   * زوج مفاتيح سطح المكتب كاملاً (العام + **الخاص**) — للاستخدام **داخل العملية
   * الرئيسية حصراً**: القناة المحلية (‏mobilelink) تحتاج الخاص لاشتقاق جلسة ECDH،
   * و`ensureDesktopIdentity` لا يعيده عمداً (عقد §4.3).
   *
   * ⚠️ لا يُكشف عبر IPC ولا يصل renderer أبداً: `listDevices` يبقى بلا مفاتيح،
   * ولا يمرّره `main.js` في أي ردّ. أي كشف له يهدم نموذج الأمان كاملاً.
   */
  function getDesktopKeyPair() {
    ensureLoaded();
    ensureDesktopIdentity();
    return identity ? { publicKey: identity.publicKey, privateKey: identity.privateKey } : null;
  }

  /**
   * زوج VAPID كاملاً — **داخل العملية الرئيسية حصراً** لتوقيع طلبات Web Push.
   *
   * ⚠️ لا يُكشف عبر IPC ولا يصل renderer أبداً: حمولة الاقتران تحمل المفتاح العام
   * وحده، و`listDevices` لا يحمل الاشتراك ولا أي مفتاح.
   */
  function getVapidKeyPair() {
    ensureLoaded();
    ensureVapidKeys();
    return vapid ? { publicKey: vapid.publicKey, privateKey: vapid.privateKey } : null;
  }

  function listDevices() {
    ensureLoaded();
    return devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      pairedAt: device.pairedAt,
      lastSeen: device.lastSeen,
      revoked: device.revoked,
      pushEnabled: device.revoked !== true && !!device.push,
    }));
  }

  function liveDevice(deviceId) {
    const normalized = safeDeviceId(deviceId);
    if (!normalized) return null;
    const device = devices.find((item) => item.deviceId === normalized);
    if (!device || device.revoked === true) return null;
    return device;
  }

  /**
   * مادة استئناف جلسة جهاز بعد إعادة تشغيل «سطر» — **داخل العملية الرئيسية حصراً**
   * (نظير `getDesktopKeyPair`): `listDevices` يبقى metadata عرض بلا مفاتيح ولا
   * `pairId`، ولا يمرّ هذا عبر IPC ولا يصل renderer أبداً.
   *
   * سجل قديم بلا `pairId` (اقتران يسبق هذه الدفعة) يُرفض: الملح مفقود فلا اشتقاق،
   * والعلاج اقتران جديد لا تخمين.
   */
  function resumeMaterial(deviceId) {
    ensureLoaded();
    const device = liveDevice(deviceId);
    if (!device || !device.pairId) return null;
    return {
      pairId: device.pairId,
      publicKey: device.publicKey,
      sendReserved: device.sendReserved,
      lastRecv: device.lastRecv,
    };
  }

  /**
   * يحجز كتلة عدّادات إرسال **ويثبّتها على القرص قبل** أي تعمية، ويعيد السقف الجديد.
   *
   * ⚠️ حارس أمني: العدّاد يدخل الـnonce في AES-GCM. استئنافٌ بعد إعادة التشغيل
   * بعدّاد أقل من أي عدّاد استُعمل = إعادة استعمال nonce على المفتاح نفسه ⇒ انهيار
   * الأصالة والسرّية. فشل الكتابة يعيد `null` **فيمتنع المتصل عن الإرسال** (فشل
   * مغلق): إرسالٌ بلا سقف ثابت قد يتكرر بعد انهيار.
   */
  function reserveSend(deviceId, block) {
    ensureLoaded();
    const device = liveDevice(deviceId);
    if (!device) return null;
    const size = Number.isSafeInteger(block) && block > 0 && block <= 4096 ? block : 1;
    const next = device.sendReserved + size;
    if (!Number.isSafeInteger(next)) return null;
    const previous = device.sendReserved;
    device.sendReserved = next;
    if (!persist()) { device.sendReserved = previous; return null; }
    return next;
  }

  /** يثبّت أعلى عدّاد استقبال مقبول — حارس replay يعبر إعادة تشغيل «سطر». */
  function noteRecv(deviceId, counter) {
    ensureLoaded();
    const device = liveDevice(deviceId);
    if (!device) return false;
    if (!Number.isSafeInteger(counter) || counter <= device.lastRecv) return false;
    const previous = device.lastRecv;
    device.lastRecv = counter;
    if (!persist()) { device.lastRecv = previous; return false; }
    return true;
  }

  function setPushSubscription(deviceId, sub) {
    ensureLoaded();
    const device = liveDevice(deviceId);
    const safe = safePushSubscription(sub);
    if (!device || !safe) return false;
    const previous = device.push;
    device.push = { ...safe, addedAt: Date.now() };
    if (!persist()) {
      if (previous) device.push = previous;
      else delete device.push;
      return false;
    }
    return true;
  }

  /** قدرة إيقاظ الهاتف — داخل العملية الرئيسية حصراً، ولا تعبر IPC إطلاقاً. */
  function getPushSubscription(deviceId) {
    ensureLoaded();
    const device = liveDevice(deviceId);
    if (!device || !device.push) return null;
    return {
      endpoint: device.push.endpoint,
      p256dh: device.push.p256dh,
      auth: device.push.auth,
      addedAt: device.push.addedAt,
    };
  }

  function clearPushSubscription(deviceId) {
    ensureLoaded();
    const device = liveDevice(deviceId);
    if (!device || !device.push) return false;
    const previous = device.push;
    delete device.push;
    if (!persist()) { device.push = previous; return false; }
    return true;
  }

  function revoke(deviceId) {
    ensureLoaded();
    const normalized = safeDeviceId(deviceId);
    if (!normalized) return { ok: false, error: 'bad_device_id' };
    const device = devices.find((item) => item.deviceId === normalized);
    if (!device) return { ok: false, error: 'not_found' };
    device.revoked = true;
    delete device.push;
    persist();
    return { ok: true };
  }

  function touch(deviceId) {
    ensureLoaded();
    const normalized = safeDeviceId(deviceId);
    if (!normalized) return;
    const device = devices.find((item) => item.deviceId === normalized);
    if (!device || device.revoked) return;
    device.lastSeen = Date.now();
    persist();
  }

  return {
    ensureDesktopIdentity,
    getDesktopKeyPair,
    ensureVapidKeys,
    getVapidKeyPair,
    buildPairingPayload,
    completePairing,
    listDevices,
    revoke,
    touch,
    resumeMaterial,
    reserveSend,
    noteRecv,
    setPushSubscription,
    getPushSubscription,
    clearPushSubscription,
  };
}

const store = createStore();

module.exports = {
  ensureDesktopIdentity: store.ensureDesktopIdentity,
  getDesktopKeyPair: store.getDesktopKeyPair,
  ensureVapidKeys: store.ensureVapidKeys,
  // داخل العملية الرئيسية حصراً (نظير getDesktopKeyPair) — لا يعبر IPC أبداً
  getVapidKeyPair: store.getVapidKeyPair,
  buildPairingPayload: store.buildPairingPayload,
  completePairing: store.completePairing,
  listDevices: store.listDevices,
  revoke: store.revoke,
  touch: store.touch,
  // داخل العملية الرئيسية حصراً (نظير getDesktopKeyPair) — لا تعبر IPC أبداً
  resumeMaterial: store.resumeMaterial,
  reserveSend: store.reserveSend,
  noteRecv: store.noteRecv,
  setPushSubscription: store.setPushSubscription,
  // قدرة إيقاظ الهاتف داخل العملية الرئيسية حصراً — لا تعبر IPC أبداً
  getPushSubscription: store.getPushSubscription,
  clearPushSubscription: store.clearPushSubscription,
  createStore,
  PAIRING_TTL_MS,
  MAX_DEVICES,
  MAX_LABEL,
};
