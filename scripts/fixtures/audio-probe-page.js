// سكربت fixture مفصول عن HTML اتباعاً لنمط المشروع (حارس CSP يرفض الكتل المضمّنة).
'use strict';
// صفحة المسبار — دوران:
//   product  : نافذة «المنتج» المُلتقَطة — تومض أبيض وتُشغّل نغمة عبر السماعات
//   recorder : النافذة المسجّلة — تبني MediaStream وتسجّل بـMediaRecorder
// كل شيء يُقاد من العملية الرئيسية عبر executeJavaScript؛ لا IPC ولا preload.
window.__probe = (() => {
  const flashEl = document.getElementById('flash');
  const tagEl = document.getElementById('tag');
  let audioCtx = null;
  const recorders = new Map();

  const params = new URLSearchParams(location.search);
  tagEl.textContent = params.get('role') || '';

  function ctx() {
if (!audioCtx) audioCtx = new AudioContext();
if (audioCtx.state === 'suspended') audioCtx.resume();
return audioCtx;
  }

  // انتظار لحظة مطلقة من ساعة النظام: setTimeout الخشن ثم دوران قصير للدقة
  function waitUntil(epochMs) {
return new Promise((resolve) => {
  const gross = epochMs - Date.now() - 4;
  const spin = () => {
    while (Date.now() < epochMs) { /* دوران ≤4ms — الدقة تسبق اللطف هنا */ }
    resolve(Date.now());
  };
  if (gross > 0) setTimeout(spin, gross); else spin();
});
  }

  function toneBurst(destNode, freq, ms, gain) {
const c = ctx();
const osc = c.createOscillator();
const g = c.createGain();
osc.type = 'sine';
osc.frequency.value = freq;
g.gain.value = gain;
osc.connect(g);
g.connect(destNode || c.destination);
const t = c.currentTime;
osc.start(t);
osc.stop(t + ms / 1000);
  }

  // علامة مزدوجة: ومضة بيضاء + نغمة في اللحظة نفسها، بلحظات مطلقة متفق عليها
  async function scheduleMarkers(spec) {
const times = Array.isArray(spec.times) ? spec.times : [];
const fired = [];
const dest = spec.toneToStream && window.__probe._toneDest ? window.__probe._toneDest : null;
for (const t of times) {
  const at = await waitUntil(t);
  if (spec.tone) toneBurst(dest, spec.freq || 1000, spec.toneMs || 60, spec.gain == null ? 0.7 : spec.gain);
  if (spec.flash) {
    flashEl.classList.add('on');
    setTimeout(() => flashEl.classList.remove('on'), spec.flashMs || 200);
  }
  fired.push({ target: t, actual: at, skewMs: at - t });
}
return fired;
  }

  // نغمة مستمرة للاختبارات القصيرة (م5): تُشغَّل عبر السماعات حتى toneStop
  let steady = null;
  function toneStart(freq, gain) {
const c = ctx();
const osc = c.createOscillator();
const g = c.createGain();
osc.type = 'sine';
osc.frequency.value = freq;
g.gain.value = gain == null ? 0.5 : gain;
osc.connect(g); g.connect(c.destination);
osc.start();
steady = { osc, g };
return { ok: true, freq, state: c.state, sampleRate: c.sampleRate };
  }
  function toneStop() {
if (steady) { try { steady.osc.stop(); } catch (e) {} }
steady = null;
return { ok: true };
  }

  async function devices() {
let list = [];
try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
const count = { audioinput: 0, audiooutput: 0, videoinput: 0 };
let labelled = 0;
for (const d of list) {
  if (count[d.kind] != null) count[d.kind] += 1;
  if (d.label) labelled += 1;
}
return { total: list.length, count, labelled, secureContext: window.isSecureContext };
  }

  // أسماء مداخل الصوت — للتمييز بين ميكروفون فيزيائي وجهاز افتراضي/خلط
  async function audioInputs() {
let list = [];
try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
return list.filter((d) => d.kind === 'audioinput')
  .map((d) => ({ label: String(d.label || '').slice(0, 60), isDefault: d.deviceId === 'default' }));
  }

  // مصدر صوتي مُخلَّق داخل الصفحة: مسار حقيقي بلا جهاز ولا زمن انتقال سماعة.
  // ⚠️ درس مقاس: مسار صامت بين الومضات يُنتج مساراً **مبتوراً** في mp4 — رصدنا 0.68ث
  // صوتاً مقابل 65ث فيديو (‏= مجموع الدفقات وحدها)، فينهار الخط الزمني ويستحيل قياس
  // الانحراف. لذلك نُبقي حاملاً مستمراً خافتاً بتردد مختلف عن تردد العلامة.
  function syntheticTrack(carrierFreq, carrierGain) {
const c = ctx();
const dest = c.createMediaStreamDestination();
if (carrierGain > 0) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = carrierFreq || 300;
  g.gain.value = carrierGain;
  osc.connect(g); g.connect(dest);
  osc.start();
}
window.__probe._toneDest = dest;
return dest.stream.getAudioTracks()[0];
  }

  // مسار نغمة مستمرة مستقل — لتمييز «هل يخلط MediaRecorder المسارات أم يُسقطها؟»
  function toneTrack(freq, gain) {
const c = ctx();
const dest = c.createMediaStreamDestination();
const osc = c.createOscillator();
const g = c.createGain();
osc.type = 'sine'; osc.frequency.value = freq;
g.gain.value = gain == null ? 0.4 : gain;
osc.connect(g); g.connect(dest);
osc.start();
return dest.stream.getAudioTracks()[0];
  }

  async function buildAudioTracks(sources, sourceId) {
const tracks = [];
const notes = [];
for (const src of sources || []) {
  if (src.kind === 'synthetic') {
    tracks.push(syntheticTrack(src.carrierFreq || 300, src.carrierGain == null ? 0 : src.carrierGain));
    notes.push('synthetic:ok' + (src.carrierGain ? ':carrier' + (src.carrierFreq || 300) : ''));
  } else if (src.kind === 'tone') {
    tracks.push(toneTrack(src.freq || 1000, src.gain));
    notes.push('tone' + (src.freq || 1000) + ':ok');
  } else if (src.kind === 'mic') {
    // raw=true يعطّل إلغاء الصدى/كبت الضجيج/الكسب — لازم لقياس الاقتران الصوتي
    const audio = src.raw
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : true;
    const s = await navigator.mediaDevices.getUserMedia({ audio });
    tracks.push(...s.getAudioTracks());
    notes.push('mic' + (src.raw ? ':raw' : '') + ':ok');
  } else if (src.kind === 'displayLoopback') {
    // المسار الهجين: صوت النظام من getDisplayMedia، ويُرمى مسار الفيديو الخاص به
    // فوراً — الفيديو يأتي من التقاط النافذة المستقل. هذا هو الشكل الوحيد الذي
    // يجمع «فيديو النافذة وحدها» مع «صوت النظام» (انظر تقرير المسبار §2.1).
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const v of s.getVideoTracks()) { try { v.stop(); } catch (e) {} s.removeTrack(v); }
    tracks.push(...s.getAudioTracks());
    notes.push('displayLoopback:ok:audio' + s.getAudioTracks().length);
  } else if (src.kind === 'desktopLegacy') {
    // المسار القديم: صوت النظام عبر قيود chromeMediaSource داخل getUserMedia
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
      video: false,
    });
    tracks.push(...s.getAudioTracks());
    notes.push('desktopLegacy:ok');
  }
}
return { tracks, notes };
  }

  // خلط عدة مسارات في مسار واحد عبر Web Audio (بديل «المسارات المنفصلة»)
  function mixTracks(tracks) {
const c = ctx();
const dest = c.createMediaStreamDestination();
for (const t of tracks) {
  const src = c.createMediaStreamSource(new MediaStream([t]));
  src.connect(dest);
}
return dest.stream.getAudioTracks()[0];
  }

  function pickMime(prefer) {
const list = prefer === 'audio'
  ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  : ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
for (const m of list) {
  if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
    return { mime: m, ext: m.startsWith('audio/mp4') || m.startsWith('video/mp4') ? 'mp4' : 'webm' };
  }
}
return { mime: '', ext: 'webm' };
  }

  function saveBlob(blob, filename) {
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url; a.download = filename;
document.body.appendChild(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  /**
   * يبني المجرى ويسجّل. spec:
   *  { id, filename, durationMs, video:{sourceId,width,height,fps}|null,
   *    display:bool, audioSources:[{kind}], mix:'tracks'|'webaudio',
   *    bitrate, alsoAudioOnly:bool }
   */
  async function record(spec) {
const started = Date.now();
const out = { id: spec.id, ok: false, error: '', errorName: '', notes: [] };
let stream = null;
const extraStreams = [];
try {
  if (spec.display) {
    // المسار الحديث: getDisplayMedia — القرار كله في setDisplayMediaRequestHandler
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    out.notes.push('getDisplayMedia:ok');
  } else if (spec.video) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: spec.video.sourceId,
        minWidth: spec.video.width, maxWidth: spec.video.width,
        minHeight: spec.video.height, maxHeight: spec.video.height,
        minFrameRate: spec.video.fps || 30, maxFrameRate: spec.video.fps || 30,
      } },
    });
    out.notes.push('getUserMedia(desktop video):ok');
  } else {
    stream = new MediaStream();
  }

  const built = await buildAudioTracks(spec.audioSources, spec.video ? spec.video.sourceId : '');
  out.notes.push(...built.notes);
  let audioTracks = built.tracks;
  if (spec.mix === 'webaudio' && audioTracks.length > 1) {
    audioTracks = [mixTracks(audioTracks)];
    out.notes.push('mixed:webaudio');
  }
  for (const t of audioTracks) stream.addTrack(t);

  out.trackCounts = { video: stream.getVideoTracks().length, audio: stream.getAudioTracks().length };
  out.trackLabels = stream.getAudioTracks().map((t) => ({
    kind: t.kind, enabled: t.enabled, muted: t.muted, readyState: t.readyState,
    hasLabel: !!t.label, settings: (() => { try { return t.getSettings(); } catch (e) { return {}; } })(),
  }));

  const fmt = pickMime(stream.getVideoTracks().length ? 'video' : 'audio');
  out.mime = fmt.mime;
  const opts = {};
  if (fmt.mime) opts.mimeType = fmt.mime;
  if (spec.bitrate) opts.videoBitsPerSecond = spec.bitrate;
  const chunks = [];
  const rec = new MediaRecorder(stream, opts);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  // مسجّل ثانٍ موازٍ لمسار صوتي مستقل (إثبات «مسار منفصل قابل للكتم لاحقاً»)
  let rec2 = null; const chunks2 = [];
  if (spec.alsoAudioOnly && stream.getAudioTracks().length) {
    const s2 = new MediaStream([stream.getAudioTracks()[0]]);
    const f2 = pickMime('audio');
    rec2 = new MediaRecorder(s2, f2.mime ? { mimeType: f2.mime } : {});
    rec2.ondataavailable = (e) => { if (e.data && e.data.size) chunks2.push(e.data); };
    out.mime2 = f2.mime; out.ext2 = f2.ext;
  }

  const done = new Promise((resolve) => { rec.onstop = resolve; });
  const done2 = rec2 ? new Promise((resolve) => { rec2.onstop = resolve; }) : Promise.resolve();
  rec.start(1000);
  if (rec2) rec2.start(1000);
  out.recStartEpoch = Date.now();

  if (spec.markers && spec.markers.times && spec.markers.times.length) {
    out.fired = await scheduleMarkers({ ...spec.markers, toneToStream: true });
  }
  const remain = spec.durationMs - (Date.now() - out.recStartEpoch);
  if (remain > 0) await new Promise((r) => setTimeout(r, remain));

  rec.stop(); if (rec2) rec2.stop();
  await done; await done2;
  out.recStopEpoch = Date.now();

  const blob = new Blob(chunks, { type: fmt.mime || 'video/webm' });
  out.bytes = blob.size;
  out.filename = spec.filename + '.' + fmt.ext;
  if (blob.size) saveBlob(blob, out.filename);
  if (rec2) {
    const b2 = new Blob(chunks2, { type: out.mime2 || 'audio/webm' });
    out.bytes2 = b2.size;
    out.filename2 = spec.filename + '-audioonly.' + out.ext2;
    if (b2.size) saveBlob(b2, out.filename2);
  }
  out.ok = blob.size > 0;
  out.wallMs = Date.now() - started;
} catch (err) {
  out.error = String(err && err.message || err).slice(0, 200);
  out.errorName = String(err && err.name || '').slice(0, 60);
} finally {
  const stop = (s) => { if (s) for (const t of s.getTracks()) { try { t.stop(); } catch (e) {} } };
  stop(stream); extraStreams.forEach(stop);
}
return out;
  }

  // اختبار بوابة الميكروفون وحده — بلا تسجيل
  async function micGate() {
const t0 = Date.now();
try {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  const tracks = s.getAudioTracks().map((t) => ({ hasLabel: !!t.label, readyState: t.readyState, muted: t.muted }));
  for (const t of s.getTracks()) { try { t.stop(); } catch (e) {} }
  return { ok: true, ms: Date.now() - t0, tracks };
} catch (err) {
  return { ok: false, ms: Date.now() - t0, name: String(err && err.name || ''), message: String(err && err.message || '').slice(0, 160) };
}
  }

  return { devices, audioInputs, record, micGate, scheduleMarkers, toneStart, toneStop, waitUntil, _toneDest: null };
})();
