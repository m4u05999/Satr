/**
 * سطر — القناة المحلية للتحكم من الجوال (م1 — §5.1 من docs/MOBILE-CONTROL-PLAN.md).
 *
 * خادم HTTPS مدمج على واجهة LAN (لا loopback — الجوال يجب أن يصله) يتكلم **أطر
 * mobilecrypto المعمّاة** حصراً عدا نقطة الاقتران. صفر اعتماديات (https المدمجة)،
 * وبحقن اعتماديات كاملة (نمط executor/runner) فيبقى قابلاً للاختبار بلا شبكة خارجية.
 * أسلوب الخادم مقتبس من `codexmcp.js` (خادم http داخل العملية)، لكن هذه القناة تستمع
 * على واجهة الشبكة لا على 127.0.0.1، ولذلك **لا تعتمد على Bearer** بل على التعمية
 * طرفاً لطرف: من لا يملك مفتاح الجلسة لا يحصل على شيء مفيد.
 *
 * ── الحدّ الذهبي (§1) ────────────────────────────────────────────────────────
 *  الجوال **يجيب سؤالاً بدأه سطح المكتب** — لا يولّد نصاً ولا يبدأ فعلاً. لذلك:
 *  القرار من {allow, allow_turn, deny} حصراً؛ **لا «دائماً» ولا bypass أبداً**،
 *  ولا يوجد مسار في هذا الملف يبني طلباً أو يعدّل واحداً.
 *
 * ── دورة القرار ─────────────────────────────────────────────────────────────
 *  offerPermission(rawReq, ctx) ⇒ ظرف منقّى (envelope.build) ⇒ يُسجَّل معلّقاً بمفتاح
 *  envelope_id (= tool_use_id) ⇒ يصل الجوال عبر long-poll مختوماً ⇒ /reply يفكّه
 *  ويحسم الوعد. الحسم من أي طرف يسحب المعلّق فوراً.
 *
 *  **الوعد يُحسم إلى أحد القرارات الثلاثة أو إلى `null`** (انتهت المهلة، أو سحبه
 *  سطح المكتب بـwithdraw، أو أُغلقت القناة). `null` تعني «لم يحسم الجوال» — لا قرار
 *  ضمني ولا موافقة تلقائية عند الانقطاع (§6.2). الوعد **لا يُرفض أبداً**، فمن يسابقه
 *  بـPromise.race في main.js لا يحتاج catch.
 *
 * ── حارس الموافقة القديمة (حرج) ─────────────────────────────────────────────
 *  /reply يعيد التحقق أن `envelope_id` **ما زال معلّقاً** قبل الحسم. موافقة وصلت بعد
 *  أن حسم سطح المكتب (أو بعد انتهاء المهلة) تُرفض بـ409 ولا تُطبَّق على نداء آخر —
 *  وهذا هو سبب وجود `withdraw` أصلاً.
 *
 * ── عزل جلسات الأجهزة ───────────────────────────────────────────────────────
 *  كل جهاز يشتق جلسته المستقلة عند /pair (مفتاحاه واتجاهاه وبادئتا الـnonce وعدّاداه
 *  خاصة به). لا حالة تعمية مشتركة بين جهازين، فتسريب جهاز لا يقرأ ظروف جهاز آخر ولا
 *  يزوّر ردّاً باسمه. الجلسات **في الذاكرة فقط ولا تُحفظ**: pairId هو ملح HKDF ويجب
 *  ألا يتكرر عبر اشتقاقين (§4.1 — تكراره يعيد المفاتيح والبادئات بينما يبدأ العدّاد
 *  صفراً ⇒ إعادة استعمال nonce، كارثي). لذلك إعادة تشغيل القناة توجب اقتراناً جديداً
 *  بـQR جديد — وهو القيد الآمن لا ثغرة.
 *
 * ── لا تسجيل ─────────────────────────────────────────────────────────────────
 *  لا console ولا ملف ولا حدث يحمل برومبتاً أو ظرفاً خاماً أو مفتاحاً أو سرّ اقتران.
 */

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const mobilepending = require('./mobilepending');
const mobilestate = require('./mobilestate');

// — ثوابت العقد —
const POLL_TIMEOUT_MS = 45 * 1000; // §5.1: long-poll ≤ 45ث ثم 204
const MIN_POLL_TIMEOUT_MS = 100; // للاختبار القطعي فقط
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const MAX_BODY = 64 * 1024; // الظروف والردود صغيرة — أي أكبر مرفوض
const MAX_WAITERS_PER_DEVICE = 4;
const MAX_PENDING = 32;
// كتلة حجز عدّادات الإرسال: كتابة قرص واحدة لكل 16 ظرفاً، وأسوأ خسارة عند الانهيار
// 15 عدّاداً من فضاء 2^53 — لا أثر. (نظير COUNTER_BLOCK في pwa/app.js)
const SEND_BLOCK = 16;
const MAX_ENVELOPE_ID = 200;

// القرارات المسموحة من الجوال — قائمة مغلقة، بلا «دائماً» وبلا bypass
const DECISIONS = new Set(['allow', 'allow_turn', 'deny']);
// رمز الدور المعتم المرافق لأمر الإيقاف (§7.7.5) — الإيقاف خارج DECISIONS عمداً
const RUN_TOKEN_RE = /^[a-f0-9]{16}$/;

const SAFE_DEVICE_HEX = /^[a-f0-9]{16,128}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATIC_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.png', '.ico']);
const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

/** معرّف جهاز منقّى بنفس عقد mobilepair (hex ≥16 أو UUID)، مصغّر الحالة. */
function safeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().trim();
  if (SAFE_DEVICE_HEX.test(normalized) || SAFE_UUID.test(normalized)) return normalized;
  return null;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * العنوان المُعلَن للجوال (‏`url` فقط — الاستماع يبقى على opts.host).
 *
 * درس مثبّت (2026-08-12): «أول IPv4 غير داخلي» **خطأ على أجهزة المطوّرين**.
 * ‏`os.networkInterfaces()` يتصدّرها غالباً محوّل افتراضي (‏WSL/Hyper-V/VirtualBox)
 * فيُعلَن عنوان كـ`172.27.0.1` لا يصله الجوال إطلاقاً بينما البطاقة الحقيقية
 * (‏Wi-Fi/هوتسبوت) في آخر القائمة. الجمهور المستهدف مطوّرون — أي أن العطل كان
 * سيصيب أغلبهم.
 *
 * الحل: نسأل النظام عن العنوان الذي يخرج منه فعلاً — مقبس UDP «موصول» لا يرسل
 * أي حزمة، إنما يجعل النظام يختار المسار ويكشف عنوانه المحلي. لا إنترنت مطلوباً
 * ولا اعتمادية. عند أي فشل نعود إلى المسح القديم ثم إلى 127.0.0.1.
 */
function scanAddress() {
  let interfaces = null;
  try { interfaces = os.networkInterfaces(); } catch { return '127.0.0.1'; }
  for (const name of Object.keys(interfaces || {})) {
    for (const info of interfaces[name] || []) {
      if (info && info.family === 'IPv4' && !info.internal && info.address) return info.address;
    }
  }
  return '127.0.0.1';
}

function lanAddress() {
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (sock) sock.close(); } catch (e) { /* أفضل جهد */ }
      resolve(value || scanAddress());
    };
    const timer = setTimeout(() => finish(null), 700);
    if (timer.unref) timer.unref();
    try {
      sock = require('node:dgram').createSocket('udp4');
      sock.on('error', () => { clearTimeout(timer); finish(null); });
      // 8.8.8.8 وجهة اسمية لاختيار المسار — لا تُرسل حزمة ولا يلزم اتصال فعلي
      sock.connect(53, '8.8.8.8', () => {
        let addr = null;
        try { addr = sock.address() && sock.address().address; } catch (e) { addr = null; }
        clearTimeout(timer);
        finish(addr && addr !== '0.0.0.0' ? addr : null);
      });
    } catch (e) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * يحلّ زوج مفاتيح سطح المكتب (العام + الخاص).
 *
 * **ملاحظة تكامل مهمة**: `mobilepair.ensureDesktopIdentity()` لا يعيد المفتاح الخاص
 * (عقد §4.3 صريح: «الخاص لا يُعاد أبداً»)، بينما اشتقاق جلسة الديسكتوب يحتاجه. لذلك
 * يقبل هذا الملف الهوية **حقناً** عبر `deps.identity` (كائن أو دالة)، ويجرّب قبلها
 * أي وصول مستقبلي يعلنه mobilepair. غياب المفتاح الخاص = فشل مغلق عند `start` بدل
 * قناة تقبل اقتراناً ثم تعجز عن التعمية.
 */
function resolveIdentity(deps) {
  const candidates = [];
  if (typeof deps.identity === 'function') {
    try { candidates.push(deps.identity()); } catch { /* يُتجاهل — نجرّب البديل */ }
  } else if (deps.identity) {
    candidates.push(deps.identity);
  }
  if (deps.pair && typeof deps.pair.getDesktopKeyPair === 'function') {
    try { candidates.push(deps.pair.getDesktopKeyPair()); } catch { /* يُتجاهل */ }
  }
  if (deps.pair && typeof deps.pair.ensureDesktopIdentity === 'function') {
    try { candidates.push(deps.pair.ensureDesktopIdentity()); } catch { /* يُتجاهل */ }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate.publicKey === 'string' && typeof candidate.privateKey === 'string'
        && candidate.publicKey && candidate.privateKey) {
      return { publicKey: candidate.publicKey, privateKey: candidate.privateKey };
    }
  }
  return null;
}

/** جذر PWA الموثوق يأتي من Electron app.getAppPath كي يعمل داخل asar في الإنتاج. */
function resolvePwaRoot(deps) {
  if (!deps.app || typeof deps.app.getAppPath !== 'function') throw new Error('no_app_path');
  let appPath = '';
  try { appPath = deps.app.getAppPath(); } catch { throw new Error('no_app_path'); }
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath)) throw new Error('no_app_path');
  try {
    const root = fs.realpathSync(path.join(appPath, 'pwa'));
    if (!fs.statSync(root).isDirectory()) throw new Error('bad_pwa_root');
    return root;
  } catch (error) {
    if (error && error.message === 'bad_pwa_root') throw error;
    throw new Error('bad_pwa_root');
  }
}

/** يتحقق من بقاء المسار النهائي داخل الجذر بعد تتبّع الروابط الرمزية. */
function isInsideRoot(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
}

/**
 * يبدأ القناة المحلية.
 *
 * @param {{crypto:object, pair:object, envelope:object, app:object, identity?:object|Function,
 *          onStop?:Function, onStateRequest?:Function}} deps
 * @param {{host?:string, port?:number, cors?:boolean, pollTimeoutMs?:number, now?:Function}} [opts]
 * @returns {Promise<{url:string, host:string, port:number, offerPermission:Function,
 *                    publishState:Function, withdraw:Function, status:Function, stop:Function}>}
 */
async function start(deps, opts) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!d.crypto || typeof d.crypto.deriveSession !== 'function' || typeof d.crypto.seal !== 'function'
      || typeof d.crypto.open !== 'function' || typeof d.crypto.sas !== 'function') {
    throw new Error('bad_deps_crypto');
  }
  if (!d.pair || typeof d.pair.completePairing !== 'function' || typeof d.pair.listDevices !== 'function') {
    throw new Error('bad_deps_pair');
  }
  if (!d.envelope || typeof d.envelope.build !== 'function') {
    throw new Error('bad_deps_envelope');
  }

  const identity = resolveIdentity(d);
  // فشل مغلق: بلا مفتاح خاص لا تعمية ⇒ لا نرفع قناة توهم بأنها جاهزة
  if (!identity) throw new Error('no_desktop_identity');

  const host = typeof o.host === 'string' && o.host.trim() ? o.host.trim() : '0.0.0.0';
  const port = clampInt(o.port, 0, 65535, 0);
  const cors = o.cors === true;
  const pollTimeoutMs = clampInt(o.pollTimeoutMs, MIN_POLL_TIMEOUT_MS, POLL_TIMEOUT_MS, POLL_TIMEOUT_MS);
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  const shown = wildcard ? await lanAddress() : host;
  const pwaRoot = resolvePwaRoot(d);

  // لا سقوط إلى HTTP: غياب mobiletls أو فشل الشهادة يمنع فتح القناة صراحةً.
  let tls;
  try { tls = require('./mobiletls'); } catch { throw new Error('mobile_tls_unavailable'); }
  if (!tls || typeof tls.ensureCert !== 'function') throw new Error('mobile_tls_unavailable');
  let tlsMaterial;
  try { tlsMaterial = tls.ensureCert(shown); } catch { throw new Error('mobile_tls_failed'); }
  if (!tlsMaterial || typeof tlsMaterial.key !== 'string' || !tlsMaterial.key
      || typeof tlsMaterial.cert !== 'string' || !tlsMaterial.cert
      || typeof tlsMaterial.fingerprint !== 'string' || !tlsMaterial.fingerprint) {
    throw new Error('mobile_tls_failed');
  }
  const fingerprint = tlsMaterial.fingerprint;

  // — الحالة الحيّة (كلها في الذاكرة؛ لا شيء منها يُكتب على القرص) —
  const sessions = new Map(); // deviceId -> { session, pairId }
  const sendCeilings = new Map(); // deviceId -> سقف عدّادات الإرسال المحجوز على القرص
  // نواة المعلّقات مشتركة مع عميل الوسيط (`mobilepending.js`) — تنفيذ واحد لعقد
  // الحسم والسحب وحارس «ما زال معلّقاً»، فلا يتباعد نقلان بصمت (درس §5.5)
  const pending = mobilepending.createPendingStore({
    buildEnvelope: (rawReq, ctx) => d.envelope.build(rawReq, ctx),
    onOffer: () => wakeWaiters(),
    maxPending: MAX_PENDING,
  });
  const waiters = new Map(); // deviceId -> Set<{res, timer}>
  const sentStateSeq = new Map(); // deviceId -> آخر seq سُلّم لهذا الجهاز
  const stateRequests = new Map(); // deviceId -> وقت آخر طلب حالة أُجيب
  let latestState = null; // خانة واحدة: اللقطة الأحدث تستبدل السابقة كلياً
  const sockets = new Set();
  let stopped = false;
  let boundPort = 0;

  // ── مساعدات الرد ──────────────────────────────────────────────────────────
  function baseHeaders() {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    // CORS اختياري: القناة كلها معمّاة طرفاً لطرف، لكن الأصل fail-closed. يفعّله
    // التكامل فقط إن قُدّمت PWA من أصل مختلف عن هذا الخادم.
    if (cors) {
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    }
    return headers;
  }

  function sendJson(res, status, body) {
    if (!res || res.writableEnded) return;
    const text = JSON.stringify(body);
    try {
      res.writeHead(status, Object.assign(baseHeaders(), {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text, 'utf8'),
      }));
      res.end(text);
    } catch { /* الاتصال أُغلق — لا شيء نفعله */ }
  }

  function sendEmpty(res, status) {
    if (!res || res.writableEnded) return;
    try { res.writeHead(status, baseHeaders()); res.end(); } catch { /* أُغلق */ }
  }

  /** يختم حمولة للجهاز ويرسلها إطاراً ثنائياً (يزيد عدّاد إرسال جلسته). */
  /**
   * يضمن أن العدّاد المقبل **أصغر من سقف محجوز ثابت على القرص** قبل أي تعمية.
   *
   * ⚠️ حارس أمني لا تحسين: العدّاد يدخل الـnonce في AES-GCM، وجلسات سطح المكتب في
   * الذاكرة وحدها. بلا سقف ثابت يستأنف الاشتقاق بعد إعادة التشغيل من عدّاد ربما
   * استُعمل ⇒ إعادة استعمال nonce على المفتاح نفسه. فشل التثبيت يمنع الإرسال
   * (فشل مغلق) بدل إرسال قد يتكرر لاحقاً.
   */
  function ensureSendCounter(deviceId, session) {
    if (typeof d.pair.reserveSend !== 'function') return true; // مخزن أقدم: السلوك السابق
    const known = sendCeilings.get(deviceId);
    if (known !== undefined && session.counterSend < known) return true;
    let next = null;
    try { next = d.pair.reserveSend(deviceId, SEND_BLOCK); } catch { return false; }
    if (!Number.isSafeInteger(next) || next <= session.counterSend) return false;
    sendCeilings.set(deviceId, next);
    return true;
  }

  function sendFrame(res, deviceId, entry, payload) {
    if (!res || res.writableEnded) return false;
    if (!ensureSendCounter(deviceId, entry.session)) {
      sendJson(res, 500, { ok: false, error: 'counter_unavailable' });
      return false;
    }
    let frame;
    try {
      frame = d.crypto.seal(entry.session, Buffer.from(JSON.stringify(payload), 'utf8'));
    } catch {
      sendJson(res, 500, { ok: false, error: 'seal_failed' });
      return false;
    }
    try {
      res.writeHead(200, Object.assign(baseHeaders(), {
        'content-type': 'application/octet-stream',
        'content-length': frame.length,
      }));
      res.end(frame);
      return true;
    } catch { return false; }
  }

  // ── الأجهزة ───────────────────────────────────────────────────────────────
  function deviceRecord(deviceId) {
    try {
      const list = d.pair.listDevices();
      if (!Array.isArray(list)) return null;
      return list.find((item) => item && item.deviceId === deviceId) || null;
    } catch { return null; }
  }

  /** جهاز قابل للاستعمال: له جلسة حيّة، وموجود في الدفتر، وغير مُبطَل. */
  /**
   * يعيد اشتقاق جلسة جهاز مقترن بعد إعادة تشغيل «سطر» (الجلسات في الذاكرة وحدها).
   *
   * العدّادان يُستأنفان من القرص: الإرسال من **السقف المحجوز** (لا من آخر عدّاد
   * استُعمل) فيتخطى كل ما ربما استُعمل قبل الإغلاق ⇒ لا إعادة استعمال nonce؛
   * والاستقبال من أعلى عدّاد مقبول ⇒ يبقى حارس replay فعّالاً عبر إعادة التشغيل.
   * سجل بلا `pairId` (اقتران يسبق هذه الدفعة) لا يُستأنف — يلزمه اقتران جديد.
   */
  function resumeSession(deviceId) {
    if (typeof d.pair.resumeMaterial !== 'function') return null;
    let material = null;
    try { material = d.pair.resumeMaterial(deviceId); } catch { return null; }
    // الهوية من `resolveIdentity` نفسها التي يستعملها `/pair` — مصدران مختلفان
    // يشتقّان جلستين مختلفتين فلا يفكّ الاستئناف إطار الهاتف
    if (!material || !material.pairId || !material.publicKey || !identity) return null;
    let session;
    try {
      session = d.crypto.deriveSession({
        myPrivate: identity.privateKey,
        theirPublic: material.publicKey,
        pairId: material.pairId,
        role: 'desktop',
      });
    } catch { return null; }
    session.counterSend = material.sendReserved;
    session.lastRecvCounter = material.lastRecv;
    const entry = { session, pairId: material.pairId };
    sessions.set(deviceId, entry);
    return entry;
  }

  function activeEntry(deviceId) {
    const entry = sessions.get(deviceId) || resumeSession(deviceId);
    if (!entry) return null;
    const record = deviceRecord(deviceId);
    if (!record || record.revoked === true) {
      // الإبطال فوري: نُسقط الجلسة كي لا يبقى مفتاح حيّ لجهاز مُبطَل
      sessions.delete(deviceId);
      dropWaiters(deviceId);
      return null;
    }
    return entry;
  }

  function liveDeviceCount() {
    let count = 0;
    for (const deviceId of [...sessions.keys()]) {
      if (activeEntry(deviceId)) count += 1;
    }
    return count;
  }

  function touch(deviceId) {
    if (typeof d.pair.touch !== 'function') return;
    try { d.pair.touch(deviceId); } catch { /* أفضل جهد */ }
  }

  // ── المعلّقات ─────────────────────────────────────────────────────────────
  /** يحسم معلّقاً مرة واحدة ويسحبه — القرار أو `null` (لا حسم). */
  // ── منتظرو long-poll ──────────────────────────────────────────────────────
  function removeWaiter(deviceId, waiter) {
    const set = waiters.get(deviceId);
    if (!set) return;
    set.delete(waiter);
    if (!set.size) waiters.delete(deviceId);
    if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
  }

  function dropWaiters(deviceId) {
    const set = waiters.get(deviceId);
    if (!set) return;
    for (const waiter of [...set]) {
      removeWaiter(deviceId, waiter);
      sendEmpty(waiter.res, 204);
    }
  }

  /** يرسل أحدث لقطة إن لم يكن الجهاز قد استلم seq نفسها. */
  function sendLatestState(res, deviceId, entry) {
    if (!latestState || latestState.seq <= (sentStateSeq.get(deviceId) || 0)) return false;
    const payload = { v: 1, type: 'state', state: latestState };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > mobilestate.MAX_STATE_FRAME_BYTES) return false;
    if (!sendFrame(res, deviceId, entry, payload)) return false;
    sentStateSeq.set(deviceId, latestState.seq);
    return true;
  }

  /**
   * يوقظ منتظراً واحداً لكل جهاز حين يصل ظرف أو لقطة جديدة.
   * التسليم لا يعلّم الظرف «مُرسَلاً»: يبقى معلّقاً حتى يردّ الجوال أو يُسحب، فإعادة
   * الاستطلاع تعيد تسليمه (خانق فقدان الرسالة). ولأن كل تسليم ختم جديد بعدّاد أعلى،
   * يقبله الجوال بلا اصطدام replay.
   */
  function wakeWaiters() {
    if (stopped) return;
    for (const deviceId of [...waiters.keys()]) {
      const record = pending.oldest();
      const entry = activeEntry(deviceId);
      const set = waiters.get(deviceId);
      if (!set || !set.size) continue;
      const waiter = set.values().next().value;
      if (!entry) {
        removeWaiter(deviceId, waiter);
        sendEmpty(waiter.res, 204);
        continue;
      }
      // الأولوية للإذن دائماً؛ الحالة لا تزاحم سؤالاً ينتظر قرار المستخدم.
      if (record) {
        removeWaiter(deviceId, waiter);
        sendFrame(waiter.res, deviceId, entry, { v: 1, type: 'permission_request', envelope: record.envelope });
        continue;
      }
      if (latestState && latestState.seq > (sentStateSeq.get(deviceId) || 0)) {
        removeWaiter(deviceId, waiter);
        sendLatestState(waiter.res, deviceId, entry);
      }
    }
  }

  /** يستبدل خانة الحالة كلياً ثم يوقظ المنتظرين؛ لا طابور للقطات القديمة. */
  function publishState(state) {
    if (stopped) return false;
    const safeState = mobilestate.buildState(state, state);
    const payload = { v: 1, type: 'state', state: safeState };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > mobilestate.MAX_STATE_FRAME_BYTES) return false;
    latestState = safeState;
    wakeWaiters();
    return true;
  }

  /** طلب قراءة محض، مخنوق لكل جهاز؛ لا يدخل DECISIONS ولا ينشئ فعلاً. */
  function requestState(deviceId, payload) {
    if (Object.keys(payload).length !== 1 || payload.type !== 'state_request') return false;
    const requestedAt = now();
    const previous = stateRequests.get(deviceId);
    if (Number.isFinite(previous)
        && requestedAt - previous < mobilestate.STATE_REQUEST_MIN_INTERVAL_MS) return true;
    if (typeof d.onStateRequest !== 'function') return false;
    let answered = false;
    try { answered = d.onStateRequest(deviceId) === true; } catch { answered = false; }
    if (answered) stateRequests.set(deviceId, requestedAt);
    return answered;
  }

  // ── واجهة سطح المكتب ──────────────────────────────────────────────────────
  /**
   * يعرض طلب إذن على الأجهزة المقترنة.
   * @returns {Promise<'allow'|'allow_turn'|'deny'|null>} — `null` = لم يحسم الجوال.
   */
  /** سطح المكتب حسم أولاً ⇒ يُزال المعلّق فوراً (حارس الموافقة القديمة). */
  function status() {
    return {
      running: !stopped,
      port: boundPort,
      pending: pending.pendingCount(),
      deviceCount: liveDeviceCount(),
      fingerprint,
    };
  }

  // ── قراءة الجسم بسقف صارم ─────────────────────────────────────────────────
  function readBody(req, res, callback) {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        chunks.length = 0;
        sendJson(res, 413, { ok: false, error: 'too_large' });
        // نصرّف البقية بدل قطع المقبس فوراً: القطع أثناء كتابة العميل يولّد RST
        // فيضيع ردّ 413 نفسه. مؤقّت الحارس يقطع من يواصل الإرسال بلا نهاية.
        try {
          req.resume();
          const guard = setTimeout(() => { try { req.destroy(); } catch { /* أُغلق */ } }, 2000);
          if (typeof guard.unref === 'function') guard.unref();
          req.on('end', () => clearTimeout(guard));
          req.on('close', () => clearTimeout(guard));
        } catch { /* أُغلق */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!aborted) callback(Buffer.concat(chunks, size)); });
    req.on('error', () => { aborted = true; try { res.destroy(); } catch { /* أُغلق */ } });
  }

  // ── النقاط الثلاث ─────────────────────────────────────────────────────────
  /** POST /pair — النقطة الوحيدة غير المعمّاة؛ تحرسها سرّية الاقتران أحادية الاستخدام. */
  function handlePair(req, res) {
    readBody(req, res, (body) => {
      let parsed = null;
      try { parsed = JSON.parse(body.toString('utf8') || 'null'); } catch { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { ok: false, error: 'bad_input' });
        return;
      }

      let result;
      try {
        result = d.pair.completePairing({
          pairId: parsed.pairId,
          secretProof: parsed.secretProof,
          mobilePublic: parsed.mobilePublic,
          deviceId: parsed.deviceId,
          label: parsed.label,
        });
      } catch { result = { ok: false, error: 'pairing_failed' }; }

      if (!result || result.ok !== true) {
        const error = result && typeof result.error === 'string' ? result.error : 'pairing_failed';
        sendJson(res, 400, { ok: false, error });
        return;
      }

      const deviceId = safeDeviceId(result.deviceId);
      const pairId = typeof parsed.pairId === 'string' ? parsed.pairId.toLowerCase().trim() : '';
      if (!deviceId || !pairId) {
        sendJson(res, 400, { ok: false, error: 'bad_device_id' });
        return;
      }

      let session = null;
      let sas = '';
      try {
        // جلسة مستقلة لهذا الجهاز حصراً — pairId هو ملح HKDF الفريد لهذا الاقتران
        session = d.crypto.deriveSession({
          myPrivate: identity.privateKey,
          theirPublic: parsed.mobilePublic,
          pairId,
          role: 'desktop',
        });
        sas = d.crypto.sas({
          desktopPublic: identity.publicKey,
          mobilePublic: parsed.mobilePublic,
          pairId,
        });
      } catch {
        // اشتقاق فاشل ⇒ جهاز مُسجَّل بلا قناة: نُبطله فوراً بدل تركه معلقاً
        try { if (typeof d.pair.revoke === 'function') d.pair.revoke(deviceId); } catch { /* أفضل جهد */ }
        sendJson(res, 400, { ok: false, error: 'derive_failed' });
        return;
      }

      sessions.set(deviceId, { session, pairId });
      // SAS من قيم عامة فقط (المفتاحان العامان + pairId) — يقارنه المستخدم بالشاشتين
      sendJson(res, 200, { ok: true, deviceId, sas });
      wakeWaiters();
    });
  }

  /** GET /poll?device=<id> — يعلّق حتى يوجد ظرف أو تنتهي المهلة (204). */
  function handlePoll(req, res, query) {
    const deviceId = safeDeviceId(query.get('device'));
    if (!deviceId) { sendJson(res, 400, { ok: false, error: 'bad_device' }); return; }
    const entry = activeEntry(deviceId);
    // جهاز غير مقترن أو مُبطَل: فشل مغلق بلا تمييز في الرسالة
    if (!entry) { sendJson(res, 403, { ok: false, error: 'not_linked' }); return; }
    touch(deviceId);

    const record = pending.oldest();
    if (record) {
      sendFrame(res, deviceId, entry, { v: 1, type: 'permission_request', envelope: record.envelope });
      return;
    }
    if (sendLatestState(res, deviceId, entry)) return;

    const set = waiters.get(deviceId) || new Set();
    if (!waiters.has(deviceId)) waiters.set(deviceId, set);
    if (set.size >= MAX_WAITERS_PER_DEVICE) { sendEmpty(res, 204); return; }

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      removeWaiter(deviceId, waiter);
      sendEmpty(res, 204);
    }, pollTimeoutMs);
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
    set.add(waiter);
    res.on('close', () => { removeWaiter(deviceId, waiter); });
  }

  /** POST /reply?device=<id> — إطار معمّى يحمل {envelope_id, decision}. */
  function handleReply(req, res, query) {
    const deviceId = safeDeviceId(query.get('device'));
    if (!deviceId) { sendJson(res, 400, { ok: false, error: 'bad_device' }); return; }
    const entry = activeEntry(deviceId);
    if (!entry) { sendJson(res, 403, { ok: false, error: 'not_linked' }); return; }

    readBody(req, res, (body) => {
      // الفكّ أولاً: طلب غير مُصادق E2E لا يتعلّم شيئاً عن المعلّقات.
      // `open` يفرض الاتجاه والـAAD والوسم وتزايد العدّاد (رفض replay).
      let plaintext = null;
      try { plaintext = d.crypto.open(entry.session, body); } catch {
        sendJson(res, 400, { ok: false, error: 'bad_frame' });
        return;
      }
      // تثبيت أعلى عدّاد مقبول: يبقى حارس replay فعّالاً بعد إعادة تشغيل «سطر».
      // أفضل جهد عمداً — فشل القرص لا يُسقط قرار المستخدم، وحارس «ما زال معلّقاً»
      // أدناه يمنع أثر أي إعادة بثّ لظرف حُسم أصلاً.
      if (typeof d.pair.noteRecv === 'function') {
        try { d.pair.noteRecv(deviceId, entry.session.lastRecvCounter); } catch { /* أفضل جهد */ }
      }

      let payload = null;
      try { payload = JSON.parse(plaintext.toString('utf8') || 'null'); } catch { payload = null; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { ok: false, error: 'bad_payload' });
        return;
      }

      // الإيقاف **نوع رسالة مستقل** لا قرار رابع: `resolveDecision` مربوطة بظرف
      // معلّق والإيقاف لا ظرف له. وهو تقليص سلطة، ففشله الآمن هو التوقف.
      if (payload.type === 'stop') {
        const run = typeof payload.run === 'string' ? payload.run : '';
        if (!RUN_TOKEN_RE.test(run)) { sendJson(res, 400, { ok: false, error: 'bad_run' }); return; }
        let stopped = false;
        if (typeof deps.onStop === 'function') {
          try { stopped = deps.onStop(run) === true; } catch { stopped = false; }
        }
        if (!stopped) { sendJson(res, 409, { ok: false, error: 'stale_run' }); return; }
        touch(deviceId);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (payload.type === 'state_request') {
        if (Object.keys(payload).length !== 1) {
          sendJson(res, 400, { ok: false, error: 'bad_payload' });
          return;
        }
        if (!requestState(deviceId, payload)) {
          sendJson(res, 503, { ok: false, error: 'state_unavailable' });
          return;
        }
        touch(deviceId);
        sendJson(res, 200, { ok: true });
        return;
      }

      const decision = typeof payload.decision === 'string' ? payload.decision : '';
      // النوعان المستقلان لا يصبحان قرارين حتى لو زُرعا في حقل decision.
      if (decision === 'stop' || decision === 'state_request') {
        sendJson(res, 400, { ok: false, error: 'bad_decision' });
        return;
      }
      // قائمة مغلقة: «دائماً» وbypass غير موجودين في هذا العقد إطلاقاً
      if (!DECISIONS.has(decision)) { sendJson(res, 400, { ok: false, error: 'bad_decision' }); return; }

      const envelopeId = typeof payload.envelope_id === 'string' ? payload.envelope_id : '';
      if (!envelopeId || envelopeId.length > MAX_ENVELOPE_ID) {
        sendJson(res, 400, { ok: false, error: 'bad_envelope_id' });
        return;
      }

      // حارس الموافقة القديمة: يجب أن يكون الظرف ما زال معلّقاً لحظة الحسم
      // حارس الموافقة القديمة داخل النواة المشتركة: يشترط أن يكون الظرف ما زال معلّقاً
      if (!pending.resolveDecision(envelopeId, decision)) {
        sendJson(res, 409, { ok: false, error: 'not_pending' });
        return;
      }

      touch(deviceId);
      sendJson(res, 200, { ok: true });
    });
  }

  // ── ملفات PWA الثابتة ────────────────────────────────────────────────────
  function handleStatic(req, res) {
    const rawPath = String(req.url || '/').split(/[?#]/, 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch {
      sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }
    // على ويندوز قد تكون الشرطة الخلفية فاصلاً لمسار؛ نوحّدها قبل فحص المقاطع.
    const normalized = decoded.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (normalized.includes('\0') || parts.some((part) => part === '..' || part === '.')) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const relative = normalized === '/' ? 'index.html' : normalized.replace(/^\/+/, '');
    const extension = path.extname(relative).toLowerCase();
    if (!relative || !STATIC_EXTENSIONS.has(extension)) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    const candidate = path.resolve(pwaRoot, relative);
    if (!isInsideRoot(pwaRoot, candidate)) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    fs.realpath(candidate, (realpathError, filename) => {
      if (realpathError || !isInsideRoot(pwaRoot, filename)) {
        sendJson(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      fs.stat(filename, (statError, stat) => {
        if (statError || !stat.isFile()) {
          sendJson(res, 404, { ok: false, error: 'not_found' });
          return;
        }
        fs.readFile(filename, (readError, body) => {
          if (readError || res.writableEnded) {
            if (!res.writableEnded) sendJson(res, 404, { ok: false, error: 'not_found' });
            return;
          }
          try {
            res.writeHead(200, Object.assign(baseHeaders(), {
              'content-type': STATIC_TYPES[extension],
              'content-length': body.length,
            }));
            res.end(body);
          } catch { /* الاتصال أُغلق */ }
        });
      });
    });
  }

  // ── الخادم ────────────────────────────────────────────────────────────────
  let server;
  try {
    server = https.createServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, (req, res) => {
    if (stopped) { sendJson(res, 503, { ok: false, error: 'stopped' }); return; }

    let url;
    try { url = new URL(req.url || '/', 'https://link.invalid'); } catch {
      sendJson(res, 400, { ok: false, error: 'bad_request' });
      return;
    }
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      if (!cors) { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
      sendEmpty(res, 204);
      return;
    }
    if (req.method === 'POST' && path === '/pair') { handlePair(req, res); return; }
    if (req.method === 'GET' && path === '/poll') { handlePoll(req, res, url.searchParams); return; }
    if (req.method === 'POST' && path === '/reply') { handleReply(req, res, url.searchParams); return; }
    if (req.method === 'GET') { handleStatic(req, res); return; }
    sendJson(res, 404, { ok: false, error: 'not_found' });
    });
  } catch { throw new Error('mobile_tls_failed'); }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* أُغلق */ } });

  function stop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    // كل معلّق يُحسم بلا قرار — القناة سقطت، والقرار يعود لمربع سطح المكتب
    pending.stop();
    for (const deviceId of [...waiters.keys()]) dropWaiters(deviceId);
    sessions.clear();
    sentStateSeq.clear();
    stateRequests.clear();
    latestState = null;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { server.close(finish); } catch { finish(); return; }
      for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* أُغلق */ } }
      sockets.clear();
      // شبكة أمان: لا نُعلّق الإغلاق على اتصال عنيد
      const guard = setTimeout(finish, 2000);
      if (typeof guard.unref === 'function') guard.unref();
    });
  }

  return new Promise((resolve, reject) => {
    const onError = (error) => { reject(error instanceof Error ? error : new Error('listen_failed')); };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      boundPort = address && typeof address === 'object' ? address.port : port;
      const shownHost = shown.includes(':') && !shown.startsWith('[') ? '[' + shown + ']' : shown;
      resolve({
        url: 'https://' + shownHost + ':' + boundPort,
        host,
        port: boundPort,
        offerPermission: (rawReq, ctx) => pending.offer(rawReq, ctx),
        publishState,
        withdraw: (envelopeId) => pending.withdraw(envelopeId),
        status,
        stop,
      });
    });
  });
}

module.exports = {
  start,
  // ثوابت العقد (للاختبار والتكامل)
  POLL_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MAX_BODY,
  MAX_PENDING,
  DECISIONS: Object.freeze([...DECISIONS]),
};
