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
    stopped: false,
    pendingPayload: null,
    // سقف عدّادات الإرسال المحجوز على القرص: كل عدّاد استُعمل فعلاً **أصغر منه**
    sendReserved: 0,
    // وضع الوسيط (§7): عنوانه وصندوقا القناة. فارغة = الوضع المحلي (LAN).
    relayUrl: '',
    boxes: null
  };

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
    await dbClear();
    hideCard();
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
    const res = await fetch(`${state.relayUrl}/m/${box}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sealed
    });
    if (!res.ok) throw new Error(`تعذّر الوصول إلى الوسيط (HTTP ${res.status})`);

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

  function renderCard(envelope) {
    const card = $('decisionCard');
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
    card.classList.add('active');
    $('emptyState').classList.add('hidden');
  }

  function hideCard() {
    $('decisionCard').classList.remove('active');
    $('emptyState').classList.remove('hidden');
    state.currentEnvelope = null;
  }

  async function sendDecision(decision) {
    if (!state.currentEnvelope || !state.session) return;
    const plain = C.utf8ToBytes(JSON.stringify({
      envelope_id: state.currentEnvelope.envelope_id,
      decision: decision
    }));
    // الحجز قبل التعمية: بلا سقف ثابت على القرص قد يعيد استئنافٌ لاحق nonce مستعملاً
    try {
      await reserveSendCounters();
    } catch (_e) {
      setStatus('تعذّر تثبيت عدّاد الأمان — لم يُرسل القرار. أعد المحاولة.');
      return;
    }
    const frame = await C.seal(state.session, plain);
    try {
      // عقد القناة (§5.1): جسم `/reply` هو **الإطار المعمّى خاماً** لا JSON، والمسار
      // يوجب `?device=`. عطل مثبت حياً — كان الردّ يُرفض بـbad_device/bad_frame.
      const replyUrl = usingRelay()
        ? `${state.relayUrl}/m/${state.boxes.toDesktop}`
        : `${state.serverUrl}/reply?device=${encodeURIComponent(state.deviceId)}`;
      await postFrame(replyUrl, frame);
      hideCard();
      setStatus('تم إرسال القرار — في انتظار طلب جديد');
      if (!state.polling) startPolling();
    } catch (err) {
      setStatus('فشل إرسال القرار: ' + err.message);
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
          const envelope = envelopeFromFrame(await openFrame(raw));
          // عدّاد الاستقبال تقدّم داخل `open`: نثبّته كي لا يقبل استئنافٌ لاحق إطاراً
          // قديماً أُعيد بثّه (حارس replay يبقى فعّالاً عبر إعادة التحميل).
          await persistRecvCounter();
          if (envelope && envelope.envelope_id) {
            state.currentEnvelope = envelope;
            renderCard(envelope);
            // لا نسحب طلباً آخر حتى يُحسم هذا
            state.polling = false;
            setStatus('طلب إذن معلّق');
            return;
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
    pollLoop();
  }

  function stopAgent() {
    state.stopped = true;
    state.polling = false;
    if (state.pollAbort) state.pollAbort.abort();
    setStatus('متوقف يدوياً');
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
