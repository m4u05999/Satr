/**
 * سطر — إرسال Web Push مباشرةً من سطح المكتب (§7.7.7).
 *
 * وحدة نقية: لا Electron ولا معرفة بالقناة أو الوسيط أو التخزين. تستخدم مبنيات Node
 * فقط، ولا تسجّل endpoint أو اشتراكاً أو مفتاحاً أو ترويسة في أي مسار.
 */

'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const SUBJECT = 'mailto:m4u05999@gmail.com';
const JWT_TTL_SECONDS = 12 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_ENDPOINT = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UNSAFE_URL_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const WAKE_PAYLOAD = Buffer.from('wake-up', 'utf8');

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

function validateInput(subscription, vapid) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)
      || typeof subscription.endpoint !== 'string' || !subscription.endpoint
      || subscription.endpoint.length > MAX_ENDPOINT || UNSAFE_URL_TEXT_RE.test(subscription.endpoint)) {
    throw new Error('bad_subscription');
  }
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { throw new Error('bad_subscription'); }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password) {
    throw new Error('bad_subscription');
  }
  if (typeof subscription.p256dh !== 'string' || subscription.p256dh.length !== 87
      || !BASE64URL_RE.test(subscription.p256dh)) throw new Error('bad_subscription');
  const subscriberPublic = Buffer.from(subscription.p256dh, 'base64url');
  if (subscriberPublic.length !== 65 || subscriberPublic[0] !== 0x04) throw new Error('bad_subscription');
  if (typeof subscription.auth !== 'string' || subscription.auth.length !== 22
      || !BASE64URL_RE.test(subscription.auth)) throw new Error('bad_subscription');
  const authSecret = Buffer.from(subscription.auth, 'base64url');
  if (authSecret.length !== 16) throw new Error('bad_subscription');

  if (!vapid || typeof vapid !== 'object' || Array.isArray(vapid)
      || typeof vapid.publicKey !== 'string' || vapid.publicKey.length !== 87
      || !BASE64URL_RE.test(vapid.publicKey)
      || typeof vapid.privateKey !== 'string' || vapid.privateKey.length !== 43
      || !BASE64URL_RE.test(vapid.privateKey)) throw new Error('bad_vapid');
  const vapidPublic = Buffer.from(vapid.publicKey, 'base64url');
  const vapidPrivate = Buffer.from(vapid.privateKey, 'base64url');
  if (vapidPublic.length !== 65 || vapidPublic[0] !== 0x04 || vapidPrivate.length !== 32) {
    throw new Error('bad_vapid');
  }
  return { endpoint, subscriberPublic, authSecret, vapidPublic, vapidPrivate };
}

function buildJwt(vapidPublic, vapidPrivate, audience, nowSeconds) {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64url(vapidPrivate),
    x: b64url(vapidPublic.subarray(1, 33)),
    y: b64url(vapidPublic.subarray(33, 65)),
  };
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: nowSeconds + JWT_TTL_SECONDS,
    sub: SUBJECT,
  }));
  const signingInput = header + '.' + claims;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return signingInput + '.' + b64url(signature);
}

function encryptPayload(subscriberPublic, authSecret) {
  const server = crypto.createECDH('prime256v1');
  server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(subscriberPublic);
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriberPublic, serverPublic]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const padded = Buffer.concat([WAKE_PAYLOAD, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, encrypted]);
}

/**
 * يرسل دفعة واحدة بلا إعادة محاولة، ويعيد رمز HTTP وحده ليتولى المستهلك دورة
 * 404/410. حقن request/now للاختبار فقط؛ الإنتاج يستعمل node:https وساعة النظام.
 */
function send(subscription, vapid, options = {}) {
  let input;
  try { input = validateInput(subscription, vapid); } catch (error) { return Promise.reject(error); }
  const nowMs = typeof options.now === 'function' ? Number(options.now()) : Date.now();
  const nowSeconds = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
  const jwt = buildJwt(input.vapidPublic, input.vapidPrivate, input.endpoint.origin, nowSeconds);
  const body = encryptPayload(input.subscriberPublic, input.authSecret);
  const request = typeof options.request === 'function' ? options.request : https.request;
  const headers = {
    Authorization: 'vapid t=' + jwt + ', k=' + b64url(input.vapidPublic),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: '300',
    Urgency: 'high',
    Topic: 'satr-perm',
    'Content-Length': String(body.length),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(status);
    };
    let req;
    try {
      req = request(input.endpoint, { method: 'POST', headers }, (res) => {
        const status = Number(res && res.statusCode) || 0;
        if (res && typeof res.resume === 'function') res.resume();
        if (res && typeof res.on === 'function') res.on('end', () => finish(null, status));
        else finish(null, status);
      });
    } catch { finish(new Error('push_request_failed')); return; }
    if (!req || typeof req.on !== 'function' || typeof req.end !== 'function') {
      finish(new Error('push_request_failed'));
      return;
    }
    req.on('error', () => finish(new Error('push_request_failed')));
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (typeof req.destroy === 'function') req.destroy(new Error('push_timeout'));
        finish(new Error('push_timeout'));
      });
    }
    try { req.end(body); } catch { finish(new Error('push_request_failed')); }
  });
}

module.exports = {
  send,
  REQUEST_TIMEOUT_MS,
};
