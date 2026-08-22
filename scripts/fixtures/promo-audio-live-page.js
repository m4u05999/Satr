// fixture حيّ لطبقة الصوت في <satr-preview-panel> (الدفعة 1 — «أشرح بصوتي»).
// يشغّل المكوّن الإنتاجي كما هو تحت CSP الصارمة، ويزيّف حدود العملية الرئيسية فقط:
// window.satr (قنوات IPC) وnavigator.mediaDevices (المصادر). الإشارة الصوتية **حقيقية**
// (مذبذب فعلي عبر MediaStreamDestination) كي يثبت الاختبار وصول صوت لا مجرّد وجود مسار.

const state = {
  promoCallback: null,
  captureStarts: [],
  readyCalls: [],
  commitCalls: [],
  abortCalls: [],
  micConstraints: [],
  recorders: [],
  systemAudio: false, // هل يسلّم مجرى سطح المكتب مساراً صوتياً؟ (بوابة كودكس)
  blockAudioCodec: false,
  chunks: [],
};
window.__audioProbe = state;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- مصدر صوتي حقيقي ----------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function toneTrack(frequency) {
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const destination = audioCtx.createMediaStreamDestination();
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.35;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  return destination.stream.getAudioTracks()[0];
}

// ---------- مصدر صورة حقيقي ----------
const canvas = document.createElement('canvas');
canvas.width = 320; canvas.height = 180;
const paint = canvas.getContext('2d');
let frame = 0;
(function draw() {
  frame += 1;
  paint.fillStyle = frame % 20 < 10 ? '#123' : '#345';
  paint.fillRect(0, 0, canvas.width, canvas.height);
  paint.fillStyle = '#D9A441';
  paint.fillRect((frame * 3) % canvas.width, 60, 40, 40);
  requestAnimationFrame(draw);
})();

// ---------- تزييف طبقة الوسائط ----------
const media = navigator.mediaDevices;
media.getUserMedia = async (constraints) => {
  if (constraints && constraints.video && constraints.video.mandatory) {
    const stream = canvas.captureStream(30);
    if (state.systemAudio) stream.addTrack(toneTrack(2500));
    return stream;
  }
  state.micConstraints.push(JSON.parse(JSON.stringify(constraints.audio)));
  return new MediaStream([toneTrack(440)]);
};
media.enumerateDevices = async () => ([
  { deviceId: 'default', kind: 'audioinput', label: 'ميكروفون افتراضي' },
  { deviceId: 'mic-usb', kind: 'audioinput', label: 'ميكروفون USB' },
  { deviceId: 'mic-cam', kind: 'audioinput', label: 'ميكروفون الكاميرا' },
  { deviceId: 'spk', kind: 'audiooutput', label: 'سماعة' },
]);

// ---------- غلاف MediaRecorder: يرصد العقد الفعلي ويحتفظ بالناتج ----------
const RealRecorder = window.MediaRecorder;
const realIsTypeSupported = RealRecorder.isTypeSupported.bind(RealRecorder);
class ProbeRecorder extends RealRecorder {
  constructor(stream, options) {
    super(stream, options);
    state.recorders.push({
      mime: (options && options.mimeType) || '',
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
    });
    state.chunks = [];
    this.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) state.chunks.push(event.data);
    });
  }
}
ProbeRecorder.isTypeSupported = (mime) => {
  if (state.blockAudioCodec && /mp4a|opus|vorbis/i.test(String(mime))) return false;
  return realIsTypeSupported(mime);
};
window.MediaRecorder = ProbeRecorder;

// ---------- تزييف window.satr ----------
let sessionCounter = 0;
window.satr = {
  onPreview: (callback) => { state.previewCallback = callback; },
  onPromoCapture: (callback) => { state.promoCallback = callback; },
  previewOpen: async () => ({ ok: true }),
  previewOpenAgent: async () => ({ ok: true }),
  previewNavigate: async () => ({ ok: true }),
  previewNavigateAgent: async () => ({ ok: true }),
  previewAction: async () => ({ ok: true }),
  previewBounds: () => {},
  previewClose: () => {},
  previewPick: async () => ({ ok: true }),
  previewPickCancel: () => {},
  previewElementShot: async () => ({ ok: false }),
  devServerInfo: async () => ({ ok: false }),
  devServerRestart: async () => ({ ok: false }),
  handoffDone: () => {},
  secretDone: () => {},
  stop: async () => ({ ok: true }),
  promoCaptureStart: async (aspect, url, confirmed, audio) => {
    state.captureStarts.push({ aspect, url, confirmed, audio });
    sessionCounter += 1;
    const sessionId = 'promo' + sessionCounter + 'abcdef0123456789';
    state.session = sessionId;
    setTimeout(() => {
      if (state.promoCallback) state.promoCallback({
        type: 'capture_start', session_id: sessionId, source_id: 'window:1:1',
        width: 320, height: 180, aspect, url,
      });
    }, 10);
    return { ok: true };
  },
  promoCaptureStop: async () => {
    if (state.promoCallback) state.promoCallback({ type: 'capture_stop', session_id: state.session });
    return { ok: true };
  },
  promoCaptureReady: async (sessionId, ok, error) => {
    state.readyCalls.push({ sessionId, ok, error });
    return { ok: true };
  },
  promoCaptureCommit: async (sessionId, durationMs, filename) => {
    state.commitCalls.push({ sessionId, durationMs, filename });
    return { ok: true };
  },
  promoCaptureAbort: async (sessionId, error) => {
    state.abortCalls.push({ sessionId, error });
    return { ok: true };
  },
};

await import('../../src/ui/components/preview-panel.js');
await customElements.whenDefined('satr-preview-panel');

const panel = document.querySelector('satr-preview-panel');
const root = panel.shadowRoot;
const $ = (id) => root.getElementById(id);
const waitFor = async (predicate, label, timeout = 6000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await delay(25);
  }
  throw new Error('timeout:' + label);
};
// انتظار ليّن: يعيد false بدل أن يرمي، فتبقى الخطوة التالية قادرة على العمل
const soft = async (predicate, timeout) => {
  try { await waitFor(predicate, 'soft', timeout); return true; } catch (error) { return false; }
};

// النتائج تُجمع في كائن مشترك: خطوة متعثّرة لا تبتلع ما قبلها، فتبقى الفحوص
// الأساسية قادرة على تسمية العطل بدل أن يظهر «timeout» غامض في خطوة لاحقة.
const result = {};

async function run() {
  panel.openWith('http://127.0.0.1:4173/');
  await waitFor(() => panel.hasAttribute('open'), 'panel_open');

  // درج الأدوات: صفّ الصوت يظهر معه
  $('pvMore').click();
  result.audioRowVisible = !$('pvAudioRow').hidden;

  // (1) صوت النظام مطفأ افتراضياً — لا تحذير معروض
  result.systemDefaultOff = $('pvSysAudio').checked === false;
  result.warningHiddenByDefault = $('pvSysNote').hidden === true;

  // (2) تفعيله يُظهر التحذير المقرّر
  $('pvSysAudio').checked = true;
  $('pvSysAudio').dispatchEvent(new Event('change'));
  await delay(30);
  result.systemWarning = $('pvSysNote').textContent;
  result.systemWarningShown = $('pvSysNote').hidden === false;
  $('pvSysAudio').checked = false;
  $('pvSysAudio').dispatchEvent(new Event('change'));
  await delay(30);

  // (3) الميكروفون: قيود خام + قائمة أجهزة + مؤشّر حيّ فيه إشارة فعلية
  $('pvMic').click();
  await waitFor(() => $('pvMic').getAttribute('aria-pressed') === 'true', 'mic_on');
  result.micConstraints = state.micConstraints[0] || null;
  result.deviceCount = $('pvMicDev').options.length;
  result.deviceLabelled = ($('pvMicDev').options[0] || {}).textContent || '';
  result.meterShown = $('pvMicMeter').classList.contains('show');
  await waitFor(() => parseFloat($('pvMicFill').style.width) > 0, 'meter_signal');
  result.meterLevel = parseFloat($('pvMicFill').style.width);

  // (4) التعارض المصرَّح به: تفعيل صوت النظام يُطفئ الميكروفون بملاحظة ظاهرة
  $('pvSysAudio').checked = true;
  $('pvSysAudio').dispatchEvent(new Event('change'));
  await waitFor(() => $('pvMic').getAttribute('aria-pressed') === 'false', 'mic_auto_off');
  result.exclusivityNote = $('pvAudioNote').textContent;
  $('pvSysAudio').checked = false;
  $('pvSysAudio').dispatchEvent(new Event('change'));
  await delay(30);
  $('pvMic').click();
  await waitFor(() => $('pvMic').getAttribute('aria-pressed') === 'true', 'mic_on_again');
  await waitFor(() => parseFloat($('pvMicFill').style.width) > 0, 'meter_signal_2');

  // (5) إذن صريح: ⏺ لا يبدأ التسجيل بل يعرض شريط الموافقة
  $('pvRec').click();
  await delay(60);
  result.consentShownBeforeStart = $('pvRecConsent').classList.contains('show');
  result.startsBeforeConsent = state.captureStarts.length;
  result.consentBody = $('rcBody').textContent;
  result.consentWarnHiddenNoSystem = $('rcWarn').hidden === true;

  // (6) الموافقة تبدأ التسجيل بمسار صوتي واحد وترميز يعلن الصوت
  $('rcStart').click();
  await waitFor(() => state.recorders.length === 1, 'recorder_created');
  await waitFor(() => $('pvRec').classList.contains('rec'), 'recording_active');
  result.consentHiddenAfterStart = !$('pvRecConsent').classList.contains('show');
  result.recorder = state.recorders[0];
  result.captureStartArgs = state.captureStarts[0];
  await delay(1400);
  await window.satr.promoCaptureStop();
  await waitFor(() => state.commitCalls.length === 1, 'commit');
  result.commitFilename = state.commitCalls[0].filename;
  const blob = new Blob(state.chunks, { type: 'video/mp4' });
  result.blobBytes = blob.size;
  result.blobBase64 = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });

  // (7) الموافقة لتسجيلة واحدة: التسجيلة التالية تسأل من جديد
  await waitFor(() => !$('pvRec').classList.contains('rec'), 'recording_cleared');
  $('pvRec').click();
  await delay(60);
  result.consentAskedAgain = $('pvRecConsent').classList.contains('show');
  result.startsAfterFirst = state.captureStarts.length;
  $('rcCancel').click();
  await delay(30);
  result.consentCancelled = !$('pvRecConsent').classList.contains('show');

  // (8) تعذّر ترميز الصوت ⇒ سلوك معلن ولا ملف صامت
  state.blockAudioCodec = true;
  const commitsBefore = state.commitCalls.length;
  const recordersBefore = state.recorders.length;
  $('pvRec').click();
  await delay(60);
  $('rcStart').click();
  // انتظار **ليّن**: تعثّر هذه الخطوة يجب ألّا يمنع الخطوات التالية من الكلام، وإلا
  // ظهر عطل الترميز باسم فحص آخر تماماً (درس من إعادة العطل عمداً).
  result.codecRefusalSeen = await soft(
    () => state.readyCalls.some((call) => call.error === 'audio_codec_unavailable'), 3000);
  await delay(120);
  result.codecNoRecorder = state.recorders.length === recordersBefore;
  result.codecNoCommit = state.commitCalls.length === commitsBefore;
  result.codecMessage = $('pvErrText').textContent;
  result.codecNotRecording = !$('pvRec').classList.contains('rec');
  state.blockAudioCodec = false;
  if ($('pvRec').classList.contains('rec')) { // تنظيف بعد تسجيل بدأ خلافاً للمتوقّع
    await window.satr.promoCaptureStop();
    await soft(() => !$('pvRec').classList.contains('rec'), 3000);
  }

  // (9) fail-closed: حدث بدء بلا موافقة لا يسجّل شيئاً
  const recordersBeforeBypass = state.recorders.length;
  state.promoCallback({
    type: 'capture_start', session_id: 'bypass000000000000000000',
    source_id: 'window:1:1', width: 320, height: 180, aspect: '16:9', url: 'http://127.0.0.1:4173/',
  });
  result.bypassRefused = await soft(
    () => state.readyCalls.some((call) => call.error === 'consent_missing'), 3000);
  result.bypassNoRecorder = state.recorders.length === recordersBeforeBypass;

  // (10) بلا صوت إطلاقاً ⇒ السلوك القائم حرفياً: لا شريط موافقة
  $('pvMic').click();
  await waitFor(() => $('pvMic').getAttribute('aria-pressed') === 'false', 'mic_off');
  const startsBeforeSilent = state.captureStarts.length;
  $('pvRec').click();
  await waitFor(() => state.captureStarts.length === startsBeforeSilent + 1, 'silent_direct_start');
  result.silentPathSkipsConsent = !$('pvRecConsent').classList.contains('show');
  await waitFor(() => state.recorders.length > recordersBeforeBypass, 'silent_recorder');
  result.silentRecorder = state.recorders[state.recorders.length - 1];
  await window.satr.promoCaptureStop();

  // (11) فرع صوت النظام: المجرى يسلّم مساراً صوتياً (بوابة main) والميكروفون مطفأ.
  //      يثبت أن التحذير الكامل يظهر في شريط الموافقة، وأن المسار الصوتي واحد.
  await soft(() => !$('pvRec').classList.contains('rec'), 4000);
  state.systemAudio = true;
  $('pvSysAudio').checked = true;
  $('pvSysAudio').dispatchEvent(new Event('change'));
  await delay(30);
  const recordersBeforeSystem = state.recorders.length;
  $('pvRec').click();
  await delay(60);
  result.systemConsentShown = $('pvRecConsent').classList.contains('show');
  result.systemConsentWarning = $('rcWarn').hidden === false ? $('rcWarn').textContent : '';
  $('rcStart').click();
  await waitFor(() => state.recorders.length === recordersBeforeSystem + 1, 'system_recorder');
  result.systemRecorder = state.recorders[state.recorders.length - 1];
  result.systemCaptureArgs = state.captureStarts[state.captureStarts.length - 1];
  await delay(600);
  await window.satr.promoCaptureStop();
  await soft(() => !$('pvRec').classList.contains('rec'), 4000);
  state.systemAudio = false;

  result.csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  return result;
}

window.__promoAudioReady = run().catch((error) => {
  result.__error = (error && error.message) || String(error);
  return result;
});
