/**
 * سطر — PWA التحكم من الجوال (م1)
 *
 * - اقتران عبر لصق الحمولة
 * - long-poll لسحب الظرف المعمّى وفكه محلياً
 * - بطاقة قرار واحدة: سماح مرة / سماح لهذا الدور / رفض
 * - PIN محلي + إيقاف الوكيل
 */
(function () {
  'use strict';

  const C = window.SatrCrypto;
  const $ = (id) => document.getElementById(id);

  const SCREENS = {
    pin: $('pinScreen'),
    pair: $('pairScreen'),
    main: $('mainScreen')
  };

  const state = {
    serverUrl: '',
    deviceId: '',
    pairId: '',
    session: null,
    polling: false,
    pollAbort: null,
    currentEnvelope: null,
    // رمز الدور المعتم من آخر ظرف — يُعاد مع أمر الإيقاف فلا يقتل دوراً لاحقاً
    currentRun: '',
    stopped: false,
    pendingPayload: null,
    // سقف عدّادات الإرسال المحجوز على القرص: كل عدّاد استُعمل فعلاً **أصغر منه**
    sendReserved: 0,
    // وضع الوسيط (§7): عنوانه وصندوقا القناة. فارغة = الوضع المحلي (LAN).
    relayUrl: '',
    boxes: null
  };

  // ── قناة الحالة (§7.7.6) ─────────────────────────────────────────────────
  const PHASE_NAMES = {
    idle: 'في الانتظار',
    working: 'يعمل',
    waiting_permission: 'ينتظر إذناً',
    done: 'انتهى',
    error: 'خطأ',
    stopped: 'توقف'
  };
  const STATE_LEASE_CHECK_INTERVAL = 1000;
  const STATE_REQUEST_MIN_INTERVAL = 2000;
  let lastBoot = '';
  let lastSeq = 0;
  let latestState = null;
  let stateReceivedAt = 0;
  let stateLeaseTimer = null;
  let lastStateRequestAt = 0;

  /** وضع الوسيط يُشتقّ من حمولة QR: وجود `relay` يعني أن الطرفين عميلان. */
  function usingRelay() {
    return !!(state.relayUrl && state.boxes && state.boxes.toMobile && state.boxes.toDesktop);
  }

  // ── حفظ الجلسة (IndexedDB) ───────────────────────────────────────────────
  // بلا حفظ تضيع المفاتيح مع أي إعادة تحميل أو قفل شاشة، فيُعاد مسح QR كل مرة.
  //
  // **لا يُحفظ المفتاح الخاص إطلاقاً**: `crypto.js` يستورد مفاتيح الجلسة بـ
  // `extractable:false`، فتُخزَّن كائنات `CryptoKey` نفسها بالاستنساخ البنيوي —
  // يستطيع الكود استعمالها ولا يستطيع أحد تصديرها، حتى مع XSS على هذا الأصل.
  // (‏localStorage كان سيعني مفتاحاً خاماً قابلاً للسرقة والنسخ الاحتياطي.)
  const DB_NAME = 'satr-mobile';
  const DB_STORE = 'session';
  const DB_KEY = 'current';
  // حجم كتلة الحجز: كتابة واحدة لكل 8 رسائل، وأسوأ خسارة عند الانهيار 7 عدّادات
  // من فضاء 2^53 — لا أثر. الجوال يرسل قراراً واحداً لكل إذن فالكلفة معدومة.
  const COUNTER_BLOCK = 8;

  function openDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb_open_failed'));
    });
  }

  function dbPut(record) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(record, DB_KEY);
      // الحسم على `oncomplete` لا `onsuccess`: الأخير يعني قبول الطلب لا ثباته
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('idb_put_failed')); };
    }));
  }

  function dbGet() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = () => { const v = req.result; db.close(); resolve(v || null); };
      req.onerror = () => { db.close(); reject(req.error || new Error('idb_get_failed')); };
    }));
  }

  function dbClear() {
    return openDb().then((db) => new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(DB_KEY);
      tx.oncomplete = tx.onabort = tx.onerror = () => { db.close(); resolve(true); };
    })).catch(() => false);
  }

  /** يبني السجل المحفوظ من الجلسة الحيّة — نسخ المقدّمات كي لا يُخزَّن اتجاه الآخر. */
  function sessionRecord(reserved) {
    const s = state.session;
    return {
      v: 1,
      serverUrl: state.serverUrl,
      deviceId: state.deviceId,
      pairId: state.pairId,
      // وضع الوسيط جزء من الجلسة: بلا حفظه يستيقظ الهاتف على النقل الخطأ
      relayUrl: state.relayUrl,
      boxes: state.boxes ? { toMobile: state.boxes.toMobile, toDesktop: state.boxes.toDesktop } : null,
      role: s.role,
      dirSend: s.dirSend,
      dirRecv: s.dirRecv,
      keySend: s.keySend,
      keyRecv: s.keyRecv,
      prefixSend: new Uint8Array(s.prefixSend),
      prefixRecv: new Uint8Array(s.prefixRecv),
      counterSendReserved: reserved,
      lastRecvCounter: s.lastRecvCounter
    };
  }

  /**
   * يحجز كتلة عدّادات إرسال **ويثبّتها على القرص قبل** أي تعمية.
   *
   * ⚠️ هذا حارس أمني لا تحسين: العدّاد يدخل الـnonce مباشرةً (‏prefix||counter) في
   * AES-GCM. استئناف بعدّاد مصفَّر بعد إعادة تحميل = إعادة استعمال nonce على المفتاح
   * نفسه ⇒ انهيار الأصالة والسرّية معاً. لذلك نكتب سقفاً **قبل** الاستعمال، ونستأنف
   * من السقف المحفوظ فنقفز فوق كل عدّاد ربما استُعمل قبل الانهيار.
   */
  async function reserveSendCounters() {
    const s = state.session;
    if (s.counterSend < state.sendReserved) return;
    const next = s.counterSend + COUNTER_BLOCK;
    await dbPut(sessionRecord(next)); // ثابت على القرص قبل أول استعمال للكتلة
    state.sendReserved = next;
  }

  /** يثبّت عدّاد الاستقبال بعد كل إطار مقبول — حارس إعادة التشغيل بعد إعادة التحميل. */
  async function persistRecvCounter() {
    try { await dbPut(sessionRecord(state.sendReserved)); } catch (_e) { /* أفضل جهد */ }
  }

  /** يمسح الجلسة المحفوظة ويعود لشاشة الاقتران (إبطال من سطح المكتب أو إعادة تشغيله). */
  async function forgetSession(reason) {
    state.session = null;
    state.stopped = true;
    state.polling = false;
    if (state.pollAbort) state.pollAbort.abort();
    state.sendReserved = 0;
    state.relayUrl = '';
    state.boxes = null;
    lastBoot = '';
    lastSeq = 0;
    lastStateRequestAt = 0;
    await dbClear();
    hideCard();
    hideStatePanel();
    setError('pairError', reason || 'انتهت صلاحية الاقتران — امسح رمز QR من جديد.');
    showScreen('pair');
  }

  /** يستعيد جلسة محفوظة إن وُجدت. الاستئناف من السقف المحجوز لا من الصفر. */
  async function restoreSession() {
    let record = null;
    try { record = await dbGet(); } catch (_e) { return false; }
    if (!record || record.v !== 1) return false;
    if (typeof record.serverUrl !== 'string' || typeof record.deviceId !== 'string') return false;
    if (!Number.isSafeInteger(record.counterSendReserved) || record.counterSendReserved < 0) return false;
    if (!Number.isSafeInteger(record.lastRecvCounter) || record.lastRecvCounter < -1) return false;
    state.serverUrl = record.serverUrl;
    state.deviceId = record.deviceId;
    state.pairId = record.pairId || '';
    state.relayUrl = typeof record.relayUrl === 'string' ? record.relayUrl : '';
    state.boxes = record.boxes && typeof record.boxes === 'object'
      && /^[a-f0-9]{32}$/.test(record.boxes.toMobile || '')
      && /^[a-f0-9]{32}$/.test(record.boxes.toDesktop || '')
      ? { toMobile: record.boxes.toMobile, toDesktop: record.boxes.toDesktop } : null;
    state.sendReserved = record.counterSendReserved;
    state.session = {
      role: record.role,
      pairId: record.pairId,
      dirSend: record.dirSend,
      dirRecv: record.dirRecv,
      keySend: record.keySend,
      keyRecv: record.keyRecv,
      prefixSend: new Uint8Array(record.prefixSend),
      prefixRecv: new Uint8Array(record.prefixRecv),
      // القفز إلى السقف المحجوز: أي عدّاد ربما استُعمل قبل الانهيار أصغر منه قطعاً
      counterSend: record.counterSendReserved,
      lastRecvCounter: record.lastRecvCounter
    };
    state.stopped = false;
    return true;
  }

  function showScreen(name) {
    Object.values(SCREENS).forEach((s) => s.classList.remove('active'));
    SCREENS[name].classList.add('active');
  }

  function setError(id, msg) {
    const el = $(id);
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function setStatus(text) {
    $('statusText').textContent = text;
  }

  function setText(id, text) {
    $(id).textContent = text;
  }

  function showEl(id, show) {
    $(id).classList.toggle('hidden', !show);
  }

  async function sha256Bytes(u8) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
  }

  async function pinHash(pin) {
    const full = await sha256Bytes(C.utf8ToBytes(pin));
    return C.bytesToBase64url(full.subarray(0, 8));
  }

  function hasPin() {
    return !!localStorage.getItem('satr_pin_hash');
  }

  async function verifyPin(pin) {
    const stored = localStorage.getItem('satr_pin_hash');
    const h = await pinHash(pin);
    if (!stored) {
      localStorage.setItem('satr_pin_hash', h);
      return true;
    }
    return h === stored;
  }

  async function onPinSubmit() {
    const input = $('pinInput');
    const pin = input.value.trim();
    if (!/^\d{2,16}$/.test(pin)) {
      setError('pinError', 'أدخِل رقماً مكوّناً من 2 إلى 16 خانة.');
      return;
    }
    const ok = await verifyPin(pin);
    if (!ok) {
      setError('pinError', 'رمز PIN غير صحيح.');
      input.value = '';
      return;
    }
    input.value = '';
    setError('pinError', '');
    if (state.pendingPayload) {
      showScreen('pair');
      await doPair(state.pendingPayload);
      state.pendingPayload = null;
      return;
    }
    // جلسة محفوظة ⇒ نكمل بلا إعادة مسح QR (قفل الشاشة أو إعادة التحميل لا يفقدان الاقتران)
    if (await restoreSession()) {
      showScreen('main');
      startPolling();
      return;
    }
    showScreen('pair');
  }

  function makeDeviceId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // يفكّ base64url إلى نص UTF-8 (حمولة الاقتران مرمّزة هكذا في سطر المكتبية)
  function b64urlToText(value) {
    let s = String(value).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function parsePayload(text) {
    let raw = text.trim();
    if (raw.startsWith('satr-mobile://')) {
      const q = raw.indexOf('?');
      const query = q > -1 ? raw.slice(q + 1) : '';
      // الصيغة التي يولّدها سطر المكتبية: satr-mobile://pair?data=<base64url(JSON)>
      const params = new URLSearchParams(query);
      const data = params.get('data');
      if (data) {
        try {
          raw = b64urlToText(data);
        } catch (_e) {
          throw new Error('تعذّر فكّ ترميز حمولة الاقتران — انسخ النص كاملاً');
        }
      } else {
        raw = q > -1 ? query : raw.slice(14);
        try { raw = decodeURIComponent(raw); } catch (_e) { /* إبقاء النص كما هو */ }
      }
    } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
      // الرابط الجديد: https://<ip>:<port>/#pair=<base64url(JSON)>
      const hashIdx = raw.indexOf('#');
      const hash = hashIdx > -1 ? raw.slice(hashIdx + 1) : '';
      if (hash.startsWith('pair=')) {
        try {
          raw = b64urlToText(hash.slice(5));
        } catch (_e) {
          throw new Error('تعذّر فكّ ترميز حمولة الاقتران من الرابط');
        }
      }
    } else if (raw.startsWith('pair=')) {
      // نص خام مكون من pair=<base64url>
      try {
        raw = b64urlToText(raw.slice(5));
      } catch (_e) {
        throw new Error('تعذّر فكّ ترميز حمولة الاقتران');
      }
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      throw new Error('حمولة الاقتران ليست JSON صالحاً — تأكد من نسخ النص كاملاً');
    }
    if (obj.v !== 1 && obj.version !== 1) {
      throw new Error('نسخة حمولة الاقتران غير مدعومة');
    }
    if (!obj.pairId || typeof obj.pairId !== 'string') {
      throw new Error('معرّف الاقتران ناقص');
    }
    if (!obj.desktopPublic) {
      throw new Error('المفتاح العام للحاسوب ناقص');
    }
    // التحقق من أن المفتاح العام 65 بايت صالحة
    C.base64urlToBytes(obj.desktopPublic);
    return obj;
  }

  async function computeSecretProof(secretU8) {
    const digest = await sha256Bytes(secretU8);
    return C.bytesToBase64url(digest);
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
    }
    return res.json().catch(() => ({}));
  }

  async function onPair() {
    setError('pairError', '');
    const raw = $('payloadInput').value;
    let payload;
    try {
      payload = parsePayload(raw);
    } catch (err) {
      setError('pairError', err.message);
      return;
    }
    await doPair(payload);
  }

  /** معرّف صندوق الاقتران: مُهشَّم فلا يرى الوسيط `pairId` الخام (§7.3). */
  async function pairBoxId(pairId) {
    const bytes = await sha256Bytes(C.utf8ToBytes('satr-relay-pair-v1' + pairId));
    return Array.from(bytes.subarray(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * اقتران عبر وسيط أعمى (§7.2): الحمولة تُعمَّى إلى مفتاح سطح المكتب المقروء من QR،
   * فلا يرى الوسيط السرّ ولا يستطيع الاقتران بمفتاحه بدلاً من الهاتف.
   *
   * بلا ردّ HTTP (بخلاف `/pair` المحلي) الإشارة الوحيدة على النجاح هي **إقرار معمّى**
   * يصل على صندوق القناة. انتظاره صراحةً يمنع «الهاتف يظن أنه مقترن» بلا نهاية.
   */
  async function pairViaRelay(payload, keyPair) {
    state.relayUrl = String(payload.relay).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(state.relayUrl)) throw new Error('عنوان وسيط غير صالح');
    state.boxes = await C.deriveChannelBoxes({
      myPrivate: keyPair.privateKey,
      myPublic: keyPair.publicKey,
      theirPublic: payload.desktopPublic,
      pairId: payload.pairId
    });
    const sealed = await C.sealPairing({
      mobilePrivate: keyPair.privateKey,
      mobilePublic: keyPair.publicKey,
      desktopPublic: payload.desktopPublic,
      pairId: payload.pairId,
      payload: { secretProof: payload.secret, deviceId: state.deviceId, label: 'جوالي' }
    });
    const box = await pairBoxId(payload.pairId);
    // إعادة محاولة قصيرة: إعادة تشغيل الوسيط (نشر أو صيانة) تُحدث نافذة 502 مدتها
    // ثوانٍ. بلا ذلك يفشل الاقتران نهائياً ويُطلب مسح QR جديد على عطل عابر — بينما
    // حلقة الاستقصاء تتعافى منه أصلاً. عطل مثبت حياً 2026-08-12.
    let posted = null;
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) {
        setStatus('الوسيط لا يستجيب — إعادة المحاولة…');
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      let res = null;
      try {
        res = await fetch(`${state.relayUrl}/m/${box}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: sealed
        });
      } catch (err) { lastError = 'تعذّر الوصول إلى الوسيط'; continue; }
      if (res.ok) { posted = res; break; }
      lastError = `الوسيط ردّ HTTP ${res.status}`;
      // 4xx خطأ في الطلب لا انقطاع: لا فائدة من التكرار
      if (res.status < 500) break;
    }
    if (!posted) throw new Error(lastError || 'تعذّر الوصول إلى الوسيط');

    // انتظار الإقرار: جلسة مؤقتة لفكّه (الجلسة الدائمة تُبنى بعد نجاح الاقتران)
    setStatus('في انتظار تأكيد سطح المكتب…');
    const ackSession = await C.deriveSession({
      myPrivate: keyPair.privateKey,
      myPublic: keyPair.publicKey,
      theirPublic: payload.desktopPublic,
      pairId: payload.pairId,
      role: 'mobile'
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const poll = await fetch(`${state.relayUrl}/m/${state.boxes.toMobile}`).catch(() => null);
      if (!poll) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      if (poll.status === 204) continue;
      if (!poll.ok) throw new Error(`الوسيط ردّ HTTP ${poll.status}`);
      const raw = await poll.arrayBuffer();
      if (!raw || !raw.byteLength) continue;
      let frame;
      try { frame = JSON.parse(new TextDecoder().decode(await C.open(ackSession, new Uint8Array(raw)))); }
      catch (_e) { continue; }
      if (frame && frame.type === 'paired') return;
      // إطار غير الإقرار قبل الاقتران: تجاهل ولا تُسقط الدورة
    }
    throw new Error('لم يؤكّد سطح المكتب الاقتران — تحقّق أن «سطر» يعمل ثم أعد المسح.');
  }

  async function doPair(payload) {
    state.serverUrl = payload.url || payload.serverUrl || '';
    if (!state.serverUrl) {
      setError('pairError', 'الحمولة لا تحتوي على عنوان خادم سطر (url).');
      return;
    }
    // إزالة شرطة مائلة زائدة
    state.serverUrl = state.serverUrl.replace(/\/$/, '');
    state.pairId = payload.pairId;
    state.deviceId = makeDeviceId();

    let secretU8;
    try {
      secretU8 = C.base64urlToBytes(payload.secret);
    } catch (_e) {
      // جرّب hex إذا لم يكن base64url
      if (/^[0-9a-f]+$/i.test(payload.secret) && payload.secret.length % 2 === 0) {
        const hex = payload.secret;
        secretU8 = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
          secretU8[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
      } else {
        throw new Error('سرّ الاقتران غير صالح');
      }
    }

    let keyPair;
    try {
      keyPair = await C.generateKeyPair();
    } catch (err) {
      setError('pairError', 'تعذّر توليد مفاتيح الجوال: ' + err.message);
      return;
    }

    try {
      if (payload.relay) {
        await pairViaRelay(payload, keyPair);
      } else {
        // `mobilepair.completePairing` يقارن السرّ **الخام** كما ولّده سطر المكتبية
        // (‏base64url لـ32 بايت)، لا بصمته. إرسال sha256 كان يفشل الاقتران دائماً.
        const result = await postJson(`${state.serverUrl}/pair`, {
          pairId: payload.pairId,
          secretProof: payload.secret,
          mobilePublic: keyPair.publicKey,
          deviceId: state.deviceId,
          label: 'جوالي'
        });
        if (!result || !result.ok) {
          throw new Error((result && result.error) || 'رفض الخادم');
        }
      }

      state.session = await C.deriveSession({
        myPrivate: keyPair.privateKey,
        myPublic: keyPair.publicKey,
        theirPublic: payload.desktopPublic,
        pairId: payload.pairId,
        role: 'mobile'
      });

      state.pairId = payload.pairId;
      // نثبّت الجلسة فوراً: انهيار قبل أول إرسال يجب أن يستأنف لا أن يعيد الاقتران
      state.sendReserved = 0;
      try { await dbPut(sessionRecord(0)); } catch (_e) { /* الاقتران يكمل بلا حفظ */ }

      const sas = await C.sas({
        desktopPublic: payload.desktopPublic,
        mobilePublic: keyPair.publicKey,
        pairId: payload.pairId
      });

      $('sasDigits').textContent = sas;
      $('sasBox').classList.remove('hidden');

      setTimeout(() => {
        showScreen('main');
        startPolling();
      }, 2500);
    } catch (err) {
      setError('pairError', 'فشل الاقتران: ' + err.message);
    }
  }

  function checkHashAutoPair() {
    const hash = location.hash;
    if (!hash || !hash.startsWith('#pair=')) return false;
    try {
      const payload = parsePayload(hash.slice(1));
      state.pendingPayload = payload;
      // نمسح الـhash فوراً كي لا يبقى السرّ في شريط العنوان أو سجل التصفح.
      history.replaceState(null, document.title, location.pathname + location.search);
      return true;
    } catch (err) {
      setError('pairError', err.message);
      return false;
    }
  }

  /**
   * هل يجوز لهذا الهاتف أن يوافق على هذا الظرف؟ (‏F5 — «الحكم لا الختم»)
   *
   * القاعدة **fail-closed من الطرفين**: بطاقة تغيير حاضرة ⇒ الحكم حالتها وحدها؛
   * وغيابها مع خطر كتابة ⇒ **قفل** (أداة كتابة جديدة لم يعرفها بناء الظرف يجب أن
   * تُقفل لا أن تمرّ). الرفض والإيقاف يبقيان متاحين دائماً — القفل يقلّص السماح
   * ولا يقلّص القدرة على المنع.
   *
   * دالة مستقلة بلا إغلاق كي يستدعيها حارس التكامل على الظرف الحقيقي
   * (‏درس §5.5.5: لا يكفي أن يشغّل الاختبار المسار كاملاً — يجب أن يشغّل منطق
   * الطرف نفسه، وإلا اختبر الحارسُ قراءتَه هو لا قراءة الهاتف).
   */
  function canAllowFromPhone(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;
    const change = envelope.change;
    if (change && typeof change === 'object') return change.status === 'ok';
    // قائمة سماح لا قائمة منع: الفعل الحرفي لهذه الفئات معروض في `summary`
    // (مسار/أمر/URL) فالحكم ممكن. و`unknown` — أداة لم يعرفها بناء الظرف — تُقفل:
    // «لا أعرف ما هذا» هو بالضبط وقت التأجيل إلى الحاسوب. وفئةُ خطرٍ تُضاف لاحقاً
    // تبقى مقفلة حتى تُدرَج صراحةً (فشل مغلق بالبناء لا بالانتباه).
    return envelope.risk === 'read' || envelope.risk === 'exec' || envelope.risk === 'browser';
  }

  /** سبب القفل أياً كان مصدره — بطاقة تغيير متعذّرة أو أداة مجهولة. */
  function lockNoticeText(envelope) {
    if (!envelope || typeof envelope !== 'object') return '';
    const change = envelope.change;
    if (change && typeof change === 'object') return changeNoticeText(change);
    return 'أداة غير معروفة لهذا الإصدار، فلا يمكن عرض أثرها. '
      + 'الموافقة من الجوال مقفلة — ارفض، أو وافق من الحاسوب بعد مراجعته.';
  }

  /** رسالة عربية ثابتة لسبب تعذّر العرض — لا نص خطأ خام ولا محتوى محجوب. */
  function changeNoticeText(change) {
    if (!change || typeof change !== 'object') return '';
    if (change.status === 'ok') return '';
    const reasons = {
      too_large: 'التغيير أكبر من أن يُعرض على الجوال كاملاً.',
      secret_redacted: 'التغيير يحتوي ما يشبه سرّاً، فلا يُعرض على الجوال.',
      unsupported_tool: 'شكل هذا التغيير لا يُعرض على الجوال.',
      malformed: 'تعذّر قراءة تفاصيل هذا التغيير.'
    };
    const why = reasons[change.reason] || reasons.malformed;
    return why + ' الموافقة من الجوال مقفلة — ارفض، أو وافق من الحاسوب بعد مراجعته.';
  }

  /** يرسم أسطر الفرق نصّاً LTR؛ يبني عناصر DOM ولا يستعمل innerHTML. */
  function renderChange(envelope) {
    const block = $('changeBlock');
    const stats = $('changeStats');
    const pre = $('changeDiff');
    const notice = $('changeNotice');
    const change = envelope && envelope.change;

    pre.textContent = '';
    stats.textContent = '';
    notice.textContent = '';
    notice.classList.add('hidden');

    // بلا بطاقة تغيير: نُظهر الكتلة فقط لنشرح القفل (أداة مجهولة)، وإلا نخفيها.
    if (!change || typeof change !== 'object') {
      if (canAllowFromPhone(envelope)) { block.classList.add('hidden'); return; }
      block.classList.remove('hidden');
      notice.textContent = lockNoticeText(envelope);
      notice.classList.remove('hidden');
      return;
    }
    block.classList.remove('hidden');

    if (change.status !== 'ok') {
      notice.textContent = lockNoticeText(envelope);
      notice.classList.remove('hidden');
      return;
    }
    if (change.kind === 'delete') { stats.textContent = 'حذف الملف بالكامل'; return; }

    stats.textContent = '+' + (change.added || 0) + ' / −' + (change.removed || 0);
    const lines = Array.isArray(change.lines) ? change.lines : [];
    for (const line of lines) {
      const row = document.createElement('div');
      if (line.t === '@') {
        row.className = 'dl dl-gap';
        row.textContent = '⋯';
      } else {
        row.className = 'dl dl-' + (line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'ctx');
        row.textContent = line.t + ' ' + (typeof line.text === 'string' ? line.text : '');
      }
      pre.appendChild(row);
    }
  }

  function renderCard(envelope) {
    const card = $('decisionCard');
    if (typeof envelope.run === 'string' && /^[a-f0-9]{16}$/.test(envelope.run)) state.currentRun = envelope.run;
    $('projectName').textContent = 'المشروع: ' + (envelope.project || '—');
    $('toolName').textContent = envelope.tool && envelope.tool.label ? envelope.tool.label : (envelope.tool && envelope.tool.name ? envelope.tool.name : 'أداة غير معروفة');

    const risk = (envelope.risk || 'unknown').toLowerCase();
    const riskNames = {
      read: 'قراءة',
      write: 'كتابة',
      exec: 'تنفيذ',
      browser: 'متصفح',
      unknown: 'غير معروف'
    };
    const badge = $('riskBadge');
    badge.className = 'risk risk-' + risk;
    badge.textContent = riskNames[risk] || riskNames.unknown;

    $('actionSummary').textContent = envelope.summary || '';
    renderChange(envelope);

    // قفل «اسمح» — الزرّان معطّلان بصرياً، والحارس الفعلي في sendDecision.
    const allowed = canAllowFromPhone(envelope);
    $('allowBtn').disabled = !allowed;
    $('allowTurnBtn').disabled = !allowed;

    card.classList.add('active');
    updateEmptyState();
  }

  function hideCard() {
    $('decisionCard').classList.remove('active');
    state.currentEnvelope = null;
    updateEmptyState();
  }

  function hideStatePanel() {
    latestState = null;
    stateReceivedAt = 0;
    stopLeaseTimer();
    $('statePanel').classList.remove('active', 'stale');
    updateEmptyState();
  }

  function updateEmptyState() {
    const hasCard = $('decisionCard').classList.contains('active');
    const hasState = latestState !== null;
    showEl('emptyState', !hasCard && !hasState);
  }

  /** قاعدة القبول: عملية سطح مكتب جديدة (boot جديد) أو seq أحدث. */
  function acceptState(st) {
    if (st.boot !== lastBoot || st.seq > lastSeq) {
      lastBoot = st.boot;
      lastSeq = st.seq;
      return true;
    }
    return false;
  }

  /** يعرض الحالة «غير معروفة» حين ينتهي الإيجار (§7.7.6/ب). */
  function renderStateUnknown() {
    const panel = $('statePanel');
    panel.classList.add('active', 'stale');
    setText('statePhase', 'غير معروفة');
    setText('stateProject', '—');
    showEl('stateTaskWrap', false);
    updateEmptyState();
  }

  /** يرسم لوحة الحالة من آخر لقطة مقبولة. */
  function renderStatePanel() {
    if (!latestState) {
      renderStateUnknown();
      return;
    }
    const age = Date.now() - stateReceivedAt;
    if (age > latestState.ttl_ms) {
      renderStateUnknown();
      return;
    }

    const st = latestState;
    const panel = $('statePanel');
    panel.classList.add('active');
    panel.classList.remove('stale');

    setText('statePhase', PHASE_NAMES[st.phase] || 'غير معروفة');
    setText('stateProject', st.project || '—');

    const hasTask = st.task && st.task.length > 0;
    showEl('stateTaskWrap', hasTask);
    if (hasTask) setText('stateTask', st.task);

    setText('stateTotal', String(st.tasks.total));
    setText('statePending', String(st.tasks.pending));
    setText('stateInProgress', String(st.tasks.in_progress));
    setText('stateCompleted', String(st.tasks.completed));
    setText('stateBlocked', String(st.tasks.blocked));

    setText('stateEditsFiles', st.edits.files + ' ملف');
    setText('stateEditsDiff', '+' + st.edits.added + ' / −' + st.edits.removed);

    if (st.cost_usd !== null) {
      showEl('stateCost', true);
      setText('stateCostValue', st.cost_usd.toFixed(4));
    } else {
      showEl('stateCost', false);
    }

    if (st.verify) {
      showEl('stateVerify', true);
      const el = $('stateVerify');
      el.className = 'state-verify ' + (st.verify === 'pass' ? 'pass' : 'fail');
      el.textContent = st.verify === 'pass' ? 'نجح التحقق' : 'فشل التحقق';
    } else {
      showEl('stateVerify', false);
    }

    updateEmptyState();
  }

  function startLeaseTimer() {
    if (stateLeaseTimer) clearInterval(stateLeaseTimer);
    stateLeaseTimer = setInterval(() => {
      if (!latestState) return;
      if (Date.now() - stateReceivedAt > latestState.ttl_ms) {
        renderStateUnknown();
      }
    }, STATE_LEASE_CHECK_INTERVAL);
  }

  function stopLeaseTimer() {
    if (stateLeaseTimer) {
      clearInterval(stateLeaseTimer);
      stateLeaseTimer = null;
    }
  }

  async function sendDecision(decision) {
    if (!state.currentEnvelope || !state.session) return;
    // الحارس الفعلي لا زرٌّ معطّل: `disabled` تجميلٌ يسقط بأي استدعاء برمجي.
    if ((decision === 'allow' || decision === 'allow_turn') && !canAllowFromPhone(state.currentEnvelope)) {
      setStatus('الموافقة من الجوال مقفلة لهذا الطلب — لم يُرسل شيء.');
      return;
    }
    if (!(await sendUplink({ envelope_id: state.currentEnvelope.envelope_id, decision: decision }, 'القرار'))) return;
    hideCard();
    setStatus('تم إرسال القرار — في انتظار طلب جديد');
    if (!state.polling) startPolling();
  }

  /**
   * يختم حمولة صاعدة ويرسلها على صندوق الاتجاه الصحيح.
   * مسار واحد للقرار والإيقاف: نسخُه كان يعني عقداً بقارئين يتباعدان بصمت.
   * @returns {Promise<boolean>} نجاح الإرسال
   */
  async function sendUplink(payload, label) {
    // الحجز قبل التعمية: بلا سقف ثابت على القرص قد يعيد استئنافٌ لاحق nonce مستعملاً
    try {
      await reserveSendCounters();
    } catch (_e) {
      setStatus('تعذّر تثبيت عدّاد الأمان — لم يُرسل ' + label + '. أعد المحاولة.');
      return false;
    }
    const frame = await C.seal(state.session, C.utf8ToBytes(JSON.stringify(payload)));
    try {
      // عقد القناة (§5.1): جسم `/reply` هو **الإطار المعمّى خاماً** لا JSON، والمسار
      // يوجب `?device=`. عطل مثبت حياً — كان الردّ يُرفض بـbad_device/bad_frame.
      const replyUrl = usingRelay()
        ? `${state.relayUrl}/m/${state.boxes.toDesktop}`
        : `${state.serverUrl}/reply?device=${encodeURIComponent(state.deviceId)}`;
      await postFrame(replyUrl, frame);
      return true;
    } catch (err) {
      setStatus('فشل إرسال ' + label + ': ' + err.message);
      return false;
    }
  }

  /**
   * يستخرج الظرف من إطار القناة.
   * عقد القناة (mobilelink.sendFrame): المُرسَل **إطار يلفّ الظرف** —
   * `{v, type:'permission_request', envelope}` — والظرف تحت `.envelope` لا مسطّحاً.
   * قراءته مسطّحة (`frame.envelope_id`) كانت تعطي undefined فيسقط كل طلب صامتاً:
   * الهاتف يستقصي بلا انقطاع ولا تظهر بطاقة، والظرف يبقى معلّقاً على سطح المكتب
   * حتى TTL. عطل مثبت حياً — راجع docs/MOBILE-CONTROL-PLAN.md §5.5.
   * القراءة صارمة بنوع واحد (فشل مغلق): نوع مجهول يُهمَل ولا يُخمَّن شكله.
   * @returns {object|null} الظرف، أو `null` لإطار غير صالح.
   */
  function envelopeFromFrame(frame) {
    if (!frame || typeof frame !== 'object') return null;
    if (frame.type !== 'permission_request') return null;
    const envelope = frame.envelope;
    if (!envelope || typeof envelope !== 'object') return null;
    return typeof envelope.envelope_id === 'string' && envelope.envelope_id ? envelope : null;
  }

  /**
   * يستخرج لقطة الحالة من إطار القناة.
   * دالة مستقلة بلا إغلاق كي يستدعيها حارس التكامل عبر `sourceFunction`
   * على الإطار الحقيقي (درس §5.5.5). قائمة الحقول مغلقة: أي انحراف يعيد `null`.
   * @returns {object|null} الحالة، أو `null` لإطار غير صالح.
   */
  function stateFromFrame(frame) {
    if (!frame || typeof frame !== 'object') return null;
    if (frame.type !== 'state') return null;
    const s = frame.state;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;

    const expectedKeys = ['boot', 'seq', 'ttl_ms', 'run', 'phase', 'project', 'task', 'tasks', 'edits', 'cost_usd', 'verify'];
    const keys = Object.keys(s);
    if (keys.length !== expectedKeys.length) return null;
    for (const k of expectedKeys) {
      if (!keys.includes(k)) return null;
    }

    if (!/^[a-f0-9]{8}$/i.test(s.boot)) return null;
    if (!Number.isInteger(s.seq) || s.seq < 1) return null;
    if (!Number.isInteger(s.ttl_ms) || s.ttl_ms <= 0) return null;
    if (!(s.run === '' || /^[a-f0-9]{16}$/i.test(s.run))) return null;
    const phases = ['idle', 'working', 'waiting_permission', 'done', 'error', 'stopped'];
    if (!phases.includes(s.phase)) return null;
    if (typeof s.project !== 'string' || [...s.project].length > 160) return null;
    if (typeof s.task !== 'string' || [...s.task].length > 160) return null;

    if (!s.tasks || typeof s.tasks !== 'object' || Array.isArray(s.tasks)) return null;
    const taskKeys = ['total', 'pending', 'in_progress', 'completed', 'blocked'];
    const tasksKeys = Object.keys(s.tasks);
    if (tasksKeys.length !== taskKeys.length) return null;
    for (const k of taskKeys) {
      if (!tasksKeys.includes(k)) return null;
      const v = s.tasks[k];
      if (!Number.isInteger(v) || v < 0 || v > 999) return null;
    }

    if (!s.edits || typeof s.edits !== 'object' || Array.isArray(s.edits)) return null;
    const editKeys = ['files', 'added', 'removed'];
    const editsKeys = Object.keys(s.edits);
    if (editsKeys.length !== editKeys.length) return null;
    for (const k of editKeys) {
      if (!editsKeys.includes(k)) return null;
      const v = s.edits[k];
      if (!Number.isInteger(v) || v < 0) return null;
    }

    if (!(s.cost_usd === null || (typeof s.cost_usd === 'number' && s.cost_usd >= 0 && Number.isFinite(s.cost_usd)))) return null;
    if (!['pass', 'fail', ''].includes(s.verify)) return null;

    return s;
  }

  async function openFrame(frame) {
    if (!state.session) return null;
    // القناة ترسل الإطار **بايتات خام** (application/octet-stream)؛ نقبل النص
    // المرمّز أيضاً تسامحاً مع أي مسار قديم.
    const bytes = typeof frame === 'string' ? C.base64urlToBytes(frame) : new Uint8Array(frame);
    const plain = await C.open(state.session, bytes);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /** يرسل إطاراً معمّى خاماً (عقد /reply) ويعيد ردّ JSON. */
  async function postFrame(url, frame) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: frame
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
    }
    return res.json().catch(() => ({}));
  }

  async function pollLoop() {
    while (!state.stopped && state.session) {
      state.polling = true;
      setStatus('متصل — في انتظار طلب…');
      const controller = new AbortController();
      state.pollAbort = controller;
      try {
        let signal;
        if (AbortSignal.any) {
          signal = AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]);
        } else if (AbortSignal.timeout) {
          signal = AbortSignal.timeout(55000);
        } else {
          signal = controller.signal;
        }
        // وضع الوسيط: صندوق معتم بدل `/poll?device=` (§7.4). العقد الوحيد المتغيّر
        // هو النقل؛ الظرف والتعمية والقرار كما هي حرفياً.
        const pollUrl = usingRelay()
          ? `${state.relayUrl}/m/${state.boxes.toMobile}`
          : `${state.serverUrl}/poll?device=${state.deviceId}`;
        const res = await fetch(pollUrl, { signal });
        if (res.status === 204) continue;
        // الجهاز أُبطل من سطح المكتب أو أُعيد تشغيله (جلساته في الذاكرة): الجلسة
        // المحفوظة ميتة، فننساها ونطلب اقتراناً جديداً بدل حلقة خطأ لا تنتهي.
        if (res.status === 403) { await forgetSession(); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // عقد القناة: الظرف يصل **بايتات خام** لا JSON (كان res.json() يرمي
        // «Unexpected token» على كل ظرف — عطل مثبت حياً على هاتف).
        const raw = await res.arrayBuffer();
        if (raw && raw.byteLength) {
          const frame = await openFrame(raw);
          // عدّاد الاستقبال تقدّم داخل `open`: نثبّته كي لا يقبل استئنافٌ لاحق إطاراً
          // قديماً أُعيد بثّه (حارس replay يبقى فعّالاً عبر إعادة التحميل).
          await persistRecvCounter();
          // توزيع الأطر بقائمة مغلقة (§7.7.6/د): نوع مجهول يُهمَل بلا تخمين شكله.
          switch (frame && frame.type) {
            case 'permission_request': {
              const envelope = envelopeFromFrame(frame);
              if (envelope && envelope.envelope_id) {
                state.currentEnvelope = envelope;
                renderCard(envelope);
                // لا نسحب طلباً آخر حتى يُحسم هذا
                state.polling = false;
                setStatus('طلب إذن معلّق');
                return;
              }
              break;
            }
            case 'paired':
              // إقرار اقتران أو تكرار؛ لا فعل
              break;
            case 'state': {
              const st = stateFromFrame(frame);
              if (st && acceptState(st)) {
                latestState = st;
                stateReceivedAt = Date.now();
                // رمز الدور يصل من اللقطة أيضاً لا من الظرف وحده (§7.7.6/أ الحقل 4).
                // بدونه كان الإيقاف يتطلّب وصول طلب إذن أولاً، بينما §1 يعد بأن
                // «أوقف» فعلٌ مستقل: الدور يعمل ⇒ يجب أن يكون إيقافه ممكناً.
                // رمز قديم أو استباقي يرفضه سطح المكتب بـ409 (§7.7.5) فالفشل مغلق.
                state.currentRun = st.run || '';
                renderStatePanel();
                startLeaseTimer();
              }
              break;
            }
            default:
              // نوع مجهول: إهمال بلا تخمين
              break;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          if (state.stopped) return;
          continue;
        }
        setStatus('خطأ في القناة: ' + err.message + ' — إعادة المحاولة…');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    state.polling = false;
  }

  function startPolling() {
    if (state.polling || state.stopped) return;
    requestStateResync();
    pollLoop();
  }

  /**
   * يطلب إعادة بثّ الحالة الحالية (§7.7.6/ح). قراءة محضة أضعف من الإيقاف،
   * عبر نفس المسار الصاعد `sendUplink` — لا قارئ ثانٍ يتباعد بصمت.
   * سطح المكتب يخنقها إلى واحدة كل ثانيتين، والهاتف يخنقها محلياً أيضاً.
   */
  async function requestStateResync() {
    if (!state.session) return;
    const now = Date.now();
    if (now - lastStateRequestAt < STATE_REQUEST_MIN_INTERVAL) return;
    lastStateRequestAt = now;
    await sendUplink({ type: 'state_request' }, 'طلب الحالة');
  }

  /**
   * يوقف الدور الجاري على سطح المكتب فعلاً (§7.7.5).
   *
   * كان هذا الزرّ يوقف الاستقصاء محلياً ويكتب «متوقف يدوياً» **بلا أن يرسل بايتاً**
   * — أي يعلن للمستخدم أنه أوقف وكيلاً ما زال يكتب في ملفاته. وهذا أسوأ من غياب
   * الزرّ. الآن يرسل أمراً مستقلاً (‏`type:'stop'`) بقيد `run` المعتم.
   *
   * ولا نعلن التوقف إلا بعد قبول سطح المكتب للأمر — «طُلب الإيقاف» ≠ «توقف».
   */
  async function stopAgent() {
    const run = state.currentRun;
    if (!state.session || !run) {
      setStatus('لا يوجد دور معروف لإيقافه — انتظر وصول طلب من سطح المكتب.');
      return;
    }
    setStatus('يُطلب الإيقاف…');
    if (!(await sendUplink({ type: 'stop', run: run }, 'أمر الإيقاف'))) return;
    // القناة تردّ 409 عند رمز دور قديم؛ postFrame يرمي عندها فيظهر الفشل أعلاه.
    hideCard();
    setStatus('أُرسل أمر الإيقاف — أوقف سطح المكتب الدور.');
  }

  async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('sw.js', { scope: './' });
      } catch (_e) {
        // لا نُعطّل التطبيق إذا فشل التسجيل
      }
    }
  }

  function bindEvents() {
    $('pinBtn').addEventListener('click', onPinSubmit);
    $('pinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onPinSubmit();
    });

    $('pairBtn').addEventListener('click', onPair);
    $('payloadInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) onPair();
    });

    $('allowBtn').addEventListener('click', () => sendDecision('allow'));
    $('denyBtn').addEventListener('click', () => sendDecision('deny'));
    $('allowTurnBtn').addEventListener('click', () => sendDecision('allow_turn'));

    $('stopBtn').addEventListener('click', stopAgent);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        requestStateResync();
        if (!state.polling && !state.stopped && state.session) startPolling();
      }
    });
  }

  function init() {
    if (!hasPin()) {
      $('pinHint').textContent = 'أنشئ رمز PIN من 2 إلى 16 خانة (يُحفظ محلياً). الرمز الأولي 0000 إن أردت.';
    }
    bindEvents();
    registerServiceWorker();
    const autoPaired = checkHashAutoPair();
    if (autoPaired) {
      $('pinHint').textContent = 'أدخِل PIN لإكمال الاقتران التلقائي.';
    }
    showScreen('pin');
  }

  init();
})();
