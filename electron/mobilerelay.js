/**
 * سطر — عميل الوسيط الأعمى للتحكم من الجوال (م2 — §7 من MOBILE-CONTROL-PLAN.md).
 *
 * النقل الثاني بجانب القناة المحلية (`mobilelink.js`). الفرق الجوهري: **سطح المكتب
 * هنا عميل لا خادم** — يتصل صادراً على 443 مثل الجوال تماماً، وهو سبب وجود الوسيط
 * أصلاً (‏NAT/CGNAT وشبكات الشركات بلا فتح منافذ).
 *
 * ── ما يتشارك مع القناة المحلية (تنفيذ واحد لا نسختان) ──────────────────────
 *  • نواة المعلّقات `mobilepending.js`: الحسم والسحب وحارس «ما زال معلّقاً».
 *  • التعمية `mobilecrypto` والظرف `mobileenvelope` والأجهزة `mobilepair` كما هي.
 *  • حجز عدّادات الإرسال على القرص قبل كل ختم (§5.5.8) — العدّاد يدخل الـnonce.
 *  نسخُ أيٍّ من هذه يعيد نمط الأعطال الثمانية (§5.5): عقدٌ بقارئين يتباعدان بصمت.
 *
 * ── ما يختلف ────────────────────────────────────────────────────────────────
 *  • لا خادم ولا TLS ولا خدمة أصول: صندوقا بريد معتمان لكل قناة (§7.3).
 *  • الاقتران **معمّى** إلى مفتاح سطح المكتب المقروء من QR (§7.2): بلا ذلك يرى
 *    الوسيط `secretProof` و`mobilePublic` معاً فيقترن بمفتاحه بدل الهاتف.
 *
 * ── الحدّ الذهبي (§1) ────────────────────────────────────────────────────────
 *  الجوال يجيب سؤالاً بدأه سطح المكتب. القرار من {allow, allow_turn, deny} حصراً،
 *  ولا «دائماً» ولا bypass. سقوط الوسيط = سلوك اليوم حرفياً: مربع الإذن يبقى القرار
 *  ولا موافقة تلقائية عند الانقطاع أبداً (§6.2).
 *
 * ── لا تسجيل ─────────────────────────────────────────────────────────────────
 *  لا console ولا ملف يحمل ظرفاً أو مفتاحاً أو سرّ اقتران أو معرّف صندوق كاملاً.
 */

'use strict';

const crypto = require('node:crypto');
const mobilepending = require('./mobilepending');

// — ثوابت العقد (§7.3/§7.4) —
const BOX_HEX_LEN = 32;
const CHANNEL_INFO = 'satr-relay-channel-v1';
const PAIR_BOX_INFO = 'satr-relay-pair-v1';
const MAX_FRAME_BYTES = 64 * 1024;
const POLL_TIMEOUT_MS = 30 * 1000; // > مهلة الوسيط (25ث) بهامش
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;
const SEND_BLOCK = 16; // نظير mobilelink — كتابة قرص لكل 16 ظرفاً
const MAX_DEVICES_POLLED = 10;

const SAFE_DEVICE_HEX = /^[a-f0-9]{16,128}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_BOX = /^[a-f0-9]{32}$/;

function safeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().trim();
  if (SAFE_DEVICE_HEX.test(normalized) || SAFE_UUID.test(normalized)) return normalized;
  return null;
}

/**
 * معرّف صندوق الاقتران: مُهشَّم فلا يرى الوسيط `pairId` الخام (§7.3).
 * @returns {string} 32 hex
 */
function pairBoxId(pairId) {
  if (typeof pairId !== 'string' || !pairId) throw new Error('bad_pair_id');
  return crypto.createHash('sha256')
    .update(PAIR_BOX_INFO, 'utf8').update(pairId, 'utf8')
    .digest('hex').slice(0, BOX_HEX_LEN);
}

/**
 * صندوقا القناة — يشتقّهما الطرفان مستقلَّين من السرّ المشترك، فيرى الوسيط معرّفَين
 * معتمَين لا يربطهما بمستخدم ولا جهاز. **المعرّف هو الصلاحية** (§7.3).
 *
 * اتجاهان **مستقلان** من استدعاء HKDF واحد كي لا يبتلع المرسِل رسالته. (لاحقة نصية
 * على معرّف واحد كانت تناقض `^[a-f0-9]{32}$` في §7.4 — راجع التصحيح المثبّت هناك.)
 */
function channelBoxes(sharedSecret, pairId) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, Buffer.from(pairId, 'utf8'),
    Buffer.from(CHANNEL_INFO, 'utf8'), 32));
  return {
    toMobile: okm.subarray(0, 16).toString('hex'),
    toDesktop: okm.subarray(16, 32).toString('hex'),
  };
}

function backoff(attempt) {
  const step = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, Math.max(0, attempt - 1)));
  // اهتزاز يمنع تزامن عملاء كثيرين على الوسيط بعد انقطاع عام
  return Math.floor(step / 2 + Math.random() * (step / 2));
}

/**
 * @param {{crypto:object, pair:object, envelope:object, transport:object,
 *          identity?:object|Function}} deps
 *   transport.post(url, bytes) -> Promise<{status:number}>
 *   transport.poll(url, timeoutMs, signal) -> Promise<{status:number, body:Buffer}>
 * @param {{relayUrl:string, pollTimeoutMs?:number, now?:Function}} opts
 */
function start(deps, opts) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!d.crypto || !d.pair || !d.envelope || !d.transport) throw new Error('bad_deps');
  const relayUrl = typeof o.relayUrl === 'string' ? o.relayUrl.replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^\s]+$/.test(relayUrl)) throw new Error('bad_relay_url');

  const identity = resolveIdentity(d);
  if (!identity) throw new Error('no_desktop_identity');

  const pollTimeoutMs = Number.isSafeInteger(o.pollTimeoutMs) && o.pollTimeoutMs > 0
    ? o.pollTimeoutMs : POLL_TIMEOUT_MS;

  const sessions = new Map(); // deviceId -> { session, pairId, channelId }
  const sendCeilings = new Map(); // deviceId -> سقف محجوز على القرص
  const loops = new Map(); // اسم الحلقة -> { stop:Function }
  let stopped = false;

  const pending = mobilepending.createPendingStore({
    buildEnvelope: (rawReq, ctx) => d.envelope.build(rawReq, ctx),
    onOffer: () => { pushPending().catch(() => {}); },
  });

  function resolveIdentity(dep) {
    const candidates = [];
    if (typeof dep.identity === 'function') {
      try { candidates.push(dep.identity()); } catch { /* يُتجاهل */ }
    } else if (dep.identity) candidates.push(dep.identity);
    if (dep.pair && typeof dep.pair.getDesktopKeyPair === 'function') {
      try { candidates.push(dep.pair.getDesktopKeyPair()); } catch { /* يُتجاهل */ }
    }
    for (const candidate of candidates) {
      if (candidate && typeof candidate.publicKey === 'string' && typeof candidate.privateKey === 'string') {
        return candidate;
      }
    }
    return null;
  }

  function boxUrl(box) {
    return relayUrl + '/m/' + box;
  }

  /** جلسة جهاز حيّ — تُشتقّ كسولاً من القرص بعد إعادة التشغيل (§5.5.8). */
  function activeSession(deviceId) {
    const existing = sessions.get(deviceId);
    if (existing) {
      const record = liveRecord(deviceId);
      if (!record) { sessions.delete(deviceId); sendCeilings.delete(deviceId); return null; }
      return existing;
    }
    return resumeSession(deviceId);
  }

  function liveRecord(deviceId) {
    try {
      const list = d.pair.listDevices();
      if (!Array.isArray(list)) return null;
      const found = list.find((item) => item && item.deviceId === deviceId);
      return found && found.revoked !== true ? found : null;
    } catch { return null; }
  }

  function resumeSession(deviceId) {
    if (typeof d.pair.resumeMaterial !== 'function') return null;
    let material = null;
    try { material = d.pair.resumeMaterial(deviceId); } catch { return null; }
    if (!material || !material.pairId || !material.publicKey) return null;
    let session;
    try {
      session = d.crypto.deriveSession({
        myPrivate: identity.privateKey,
        theirPublic: material.publicKey,
        pairId: material.pairId,
        role: 'desktop',
      });
    } catch { return null; }
    // الاستئناف من السقف المحجوز لا من آخر عدّاد استُعمل (§5.5.8)
    session.counterSend = material.sendReserved;
    session.lastRecvCounter = material.lastRecv;
    const entry = {
      session,
      pairId: material.pairId,
      boxes: deriveBoxes(material.publicKey, material.pairId),
    };
    if (!entry.boxes) return null;
    sessions.set(deviceId, entry);
    return entry;
  }

  function deriveBoxes(mobilePublic, pairId) {
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(Buffer.from(identity.privateKey, 'base64url'));
      const shared = ecdh.computeSecret(Buffer.from(mobilePublic, 'base64url'));
      return channelBoxes(shared, pairId);
    } catch { return null; }
  }

  /**
   * حجز عدّادات الإرسال قبل التعمية — فشله يمنع الإرسال (فشل مغلق).
   * نظير `ensureSendCounter` في mobilelink: عقد واحد على النقلين.
   */
  function ensureSendCounter(deviceId, session) {
    if (typeof d.pair.reserveSend !== 'function') return true;
    const known = sendCeilings.get(deviceId);
    if (known !== undefined && session.counterSend < known) return true;
    let next = null;
    try { next = d.pair.reserveSend(deviceId, SEND_BLOCK); } catch { return false; }
    if (!Number.isSafeInteger(next) || next <= session.counterSend) return false;
    sendCeilings.set(deviceId, next);
    return true;
  }

  /** يدفع أقدم ظرف معلّق إلى صناديق كل الأجهزة الحيّة. */
  async function pushPending() {
    if (stopped) return;
    const record = pending.oldest();
    if (!record) return;
    for (const deviceId of pairedDeviceIds()) {
      const entry = activeSession(deviceId);
      if (!entry) continue;
      if (!ensureSendCounter(deviceId, entry.session)) continue;
      let frame;
      try {
        frame = d.crypto.seal(entry.session, Buffer.from(JSON.stringify({
          v: 1, type: 'permission_request', envelope: record.envelope,
        }), 'utf8'));
      } catch { continue; }
      if (frame.length > MAX_FRAME_BYTES) continue;
      try { await d.transport.post(boxUrl(entry.boxes.toMobile), frame); }
      catch { /* الوسيط ساقط: الظرف يبقى معلّقاً ومربع سطح المكتب هو القرار */ }
    }
  }

  function pairedDeviceIds() {
    try {
      const list = d.pair.listDevices();
      if (!Array.isArray(list)) return [];
      return list.filter((item) => item && item.revoked !== true)
        .map((item) => safeDeviceId(item.deviceId))
        .filter(Boolean)
        .slice(0, MAX_DEVICES_POLLED);
    } catch { return []; }
  }

  /** يستقبل ردّ جهاز: يفكّ، يثبّت عدّاد الاستقبال، ثم يحسم عبر النواة المشتركة. */
  function handleDeviceFrame(deviceId, bytes) {
    const entry = activeSession(deviceId);
    if (!entry) return false;
    let plaintext;
    try { plaintext = d.crypto.open(entry.session, bytes); } catch { return false; }
    if (typeof d.pair.noteRecv === 'function') {
      try { d.pair.noteRecv(deviceId, entry.session.lastRecvCounter); } catch { /* أفضل جهد */ }
    }
    let payload = null;
    try { payload = JSON.parse(plaintext.toString('utf8') || 'null'); } catch { return false; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const envelopeId = typeof payload.envelope_id === 'string' ? payload.envelope_id : '';
    const decision = typeof payload.decision === 'string' ? payload.decision : '';
    // حارس الموافقة القديمة داخل النواة المشتركة
    return pending.resolveDecision(envelopeId, decision);
  }

  /**
   * يستقبل إطار اقتران معمّى (§7.2): يفكّه بمفتاح سطح المكتب، ويتحقق من السرّ عبر
   * `mobilepair.completePairing` نفسه — الوسيط لا يرى السرّ ولا يستطيع الانتحال.
   */
  function handlePairFrame(pairId, bytes) {
    let opened;
    try { opened = d.crypto.openPairing({ desktopPrivate: identity.privateKey, pairId, frame: bytes }); }
    catch { return null; }
    const payload = opened.payload || {};
    const result = d.pair.completePairing({
      pairId,
      secretProof: payload.secretProof,
      mobilePublic: opened.mobilePublic,
      deviceId: payload.deviceId,
      label: payload.label,
    });
    if (!result || !result.ok) return null;
    const deviceId = safeDeviceId(result.deviceId);
    if (!deviceId) return null;
    return { deviceId, mobilePublic: opened.mobilePublic };
  }

  /** حلقة استقصاء صادرة بإعادة اتصال متزايدة — لا تلقي ولا تتوقف عند خطأ عابر. */
  function loop(name, boxOf, onFrame) {
    if (loops.has(name)) return loops.get(name);
    let alive = true;
    let attempt = 0;
    let controller = null;
    const handle = {
      stop() {
        alive = false;
        if (controller && typeof controller.abort === 'function') {
          try { controller.abort(); } catch { /* أفضل جهد */ }
        }
        loops.delete(name);
      },
    };
    loops.set(name, handle);

    (async () => {
      while (alive && !stopped) {
        const box = boxOf();
        if (!box || !SAFE_BOX.test(box)) { await sleep(RECONNECT_MIN_MS); continue; }
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        let result = null;
        try {
          result = await d.transport.poll(boxUrl(box), pollTimeoutMs, controller && controller.signal);
          attempt = 0;
        } catch {
          attempt += 1;
          if (!alive || stopped) break;
          await sleep(backoff(attempt));
          continue;
        }
        if (!alive || stopped) break;
        if (result && result.status === 200 && result.body && result.body.length) {
          try { onFrame(result.body); } catch { /* إطار فاسد لا يُسقط الحلقة */ }
        }
      }
    })().catch(() => {});
    return handle;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  /** يبدأ انتظار اقتران على صندوق مُهشَّم من pairId — يتوقف بعد نجاحه. */
  function awaitPairing(pairId) {
    const box = pairBoxId(pairId);
    const name = 'pair:' + box;
    return loop(name, () => box, (bytes) => {
      const paired = handlePairFrame(pairId, bytes);
      if (!paired) return;
      const handle = loops.get(name);
      if (handle) handle.stop();
      listenDevice(paired.deviceId);
      pushPending().catch(() => {});
    });
  }

  /** يبدأ استقصاء صندوق ردود جهاز مقترن. */
  function listenDevice(deviceId) {
    const id = safeDeviceId(deviceId);
    if (!id) return null;
    return loop('device:' + id, () => {
      const entry = activeSession(id);
      return entry ? entry.boxes.toDesktop : null;
    }, (bytes) => { handleDeviceFrame(id, bytes); });
  }

  function listenAll() {
    for (const deviceId of pairedDeviceIds()) listenDevice(deviceId);
  }

  function status() {
    return {
      running: !stopped,
      relay: relayUrl,
      deviceCount: pairedDeviceIds().length,
      pending: pending.pendingCount(),
      loops: loops.size,
    };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const handle of [...loops.values()]) { try { handle.stop(); } catch { /* أفضل جهد */ } }
    loops.clear();
    pending.stop();
    sessions.clear();
    sendCeilings.clear();
  }

  listenAll();

  return {
    // العقد نفسه الذي يستهلكه main.js من القناة المحلية — نقل مختلف بلا عقد ثانٍ
    offerPermission: (rawReq, ctx) => pending.offer(rawReq, ctx),
    withdraw: (envelopeId) => pending.withdraw(envelopeId),
    status,
    stop,
    // خاص بالوسيط
    awaitPairing,
    listenDevice,
  };
}

module.exports = {
  start,
  pairBoxId,
  channelBoxes,
  backoff,
  CHANNEL_INFO,
  PAIR_BOX_INFO,
  SEND_BLOCK,
  POLL_TIMEOUT_MS,
};
