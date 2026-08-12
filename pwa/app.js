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
    pendingPayload: null
  };

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

      state.session = await C.deriveSession({
        myPrivate: keyPair.privateKey,
        myPublic: keyPair.publicKey,
        theirPublic: payload.desktopPublic,
        pairId: payload.pairId,
        role: 'mobile'
      });

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
    const frame = await C.seal(state.session, plain);
    try {
      // عقد القناة (§5.1): جسم `/reply` هو **الإطار المعمّى خاماً** لا JSON، والمسار
      // يوجب `?device=`. عطل مثبت حياً — كان الردّ يُرفض بـbad_device/bad_frame.
      await postFrame(`${state.serverUrl}/reply?device=${encodeURIComponent(state.deviceId)}`, frame);
      hideCard();
      setStatus('تم إرسال القرار — في انتظار طلب جديد');
      if (!state.polling) startPolling();
    } catch (err) {
      setStatus('فشل إرسال القرار: ' + err.message);
    }
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
        const res = await fetch(`${state.serverUrl}/poll?device=${state.deviceId}`, { signal });
        if (res.status === 204) continue;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // عقد القناة: الظرف يصل **بايتات خام** لا JSON (كان res.json() يرمي
        // «Unexpected token» على كل ظرف — عطل مثبت حياً على هاتف).
        const raw = await res.arrayBuffer();
        if (raw && raw.byteLength) {
          const envelope = await openFrame(raw);
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
