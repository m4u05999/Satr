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

const SAFE_HEX16 = /^[a-f0-9]{32}$/i;
const SAFE_DEVICE_HEX = /^[a-f0-9]{16,}$/i;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function b64url(buf) {
  return buf.toString('base64url');
}

function safeMobilePublic(value) {
  if (typeof value !== 'string' || value.length !== PUBLIC_B64URL_LEN || !BASE64URL_RE.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 65 || decoded[0] !== 0x04) return null;
  return value;
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
  let devices = [];
  const pending = new Map(); // pairId -> { secret, createdAt, expiresAt }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    identity = null;
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
        devices.push({
          deviceId,
          label,
          pairedAt,
          lastSeen,
          revoked: raw.revoked === true,
          publicKey,
        });
      }
    }
  }

  function persist() {
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    const payload = {
      identity: identity ? { publicKey: identity.publicKey, privateKey: identity.privateKey } : null,
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

  function buildPairingPayload() {
    ensureLoaded();
    cleanupPending();
    const id = ensureDesktopIdentity();
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

  function listDevices() {
    ensureLoaded();
    return devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      pairedAt: device.pairedAt,
      lastSeen: device.lastSeen,
      revoked: device.revoked,
    }));
  }

  function revoke(deviceId) {
    ensureLoaded();
    const normalized = safeDeviceId(deviceId);
    if (!normalized) return { ok: false, error: 'bad_device_id' };
    const device = devices.find((item) => item.deviceId === normalized);
    if (!device) return { ok: false, error: 'not_found' };
    device.revoked = true;
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
    buildPairingPayload,
    completePairing,
    listDevices,
    revoke,
    touch,
  };
}

const store = createStore();

module.exports = {
  ensureDesktopIdentity: store.ensureDesktopIdentity,
  getDesktopKeyPair: store.getDesktopKeyPair,
  buildPairingPayload: store.buildPairingPayload,
  completePairing: store.completePairing,
  listDevices: store.listDevices,
  revoke: store.revoke,
  touch: store.touch,
  createStore,
  PAIRING_TTL_MS,
  MAX_DEVICES,
  MAX_LABEL,
};
