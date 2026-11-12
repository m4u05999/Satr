#!/usr/bin/env electron
'use strict';

// مسبار «مخرج الإعلانات» — الدفعة 0 من docs/PROMO-DIRECTOR-PLAN.md.
// يقيس على هذا الجهاز ما تبني عليه الدفعات التالية، ولا يحكم بنجاح أو فشل:
// دعم المرمّزات، تأخير AAC، ترتيب خرج المرمّز، بنية مقطع MediaRecorder، زمن القفز،
// تحويل الإحداثيات. ليس جزءاً من الطقم لأن نتيجته تعتمد على العتاد.
//
// التشغيل: electron scripts/promo-probe-live.js
// مقياس العرض: PROBE_SCALE=1.25 (يُمرَّر إلى force-device-scale-factor).
// النتيجة: dist/promo-probe/result-<scale>.json + frame-<scale>.png + segment-<scale>.<ext>

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const scaleArg = /^\d(\.\d{1,2})?$/.test(process.env.PROBE_SCALE || '') ? process.env.PROBE_SCALE : '';
if (scaleArg) app.commandLine.appendSwitch('force-device-scale-factor', scaleArg);
const tag = scaleArg || 'native';

const outDir = path.join(__dirname, '..', 'dist', 'promo-probe');
const eventDir = path.join(outDir, 'events-' + tag);
const resultFile = path.join(outDir, 'result-' + tag + '.json');
const result = { ok: false, stage: 'boot', scale_arg: tag, error: '' };
let finished = false;

// موضع الزر المرجعي بإحداثيات CSS داخل صفحة الاختبار.
const TARGET = { x: 300, y: 200, width: 240, height: 120 };

function writeResult() {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
  } catch {}
}

function stage(name) { result.stage = name; writeResult(); }

function finish(code) {
  if (finished) return;
  finished = true;
  writeResult();
  process.stdout.write(code === 0
    ? 'promo-probe: done — ' + resultFile + '\n'
    : 'promo-probe: FAIL at ' + result.stage + ' — ' + String(result.error).split('\n')[0] + '\n');
  for (const win of BrowserWindow.getAllWindows()) { try { win.destroy(); } catch {} }
  app.exit(code);
}

// خطأ الإقلاع في العملية الرئيسية يعلّق Electron بحوار؛ نحوّله إلى خروج مسجَّل.
process.on('uncaughtException', (error) => { result.error = String((error && error.stack) || error); finish(1); });
process.on('unhandledRejection', (error) => { result.error = String((error && error.stack) || error); finish(1); });
app.on('window-all-closed', () => {});
setTimeout(() => { result.error = 'timeout_180s'; finish(1); }, 180000).unref();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────── تحليل MP4 في العملية الرئيسية ─────────────────────────

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);

function walkBoxes(buffer, start, end, visit, depth = 0) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) { size = Number(buffer.readBigUInt64BE(offset + 8)); header = 16; }
    else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    visit({ type, offset, size, header, depth, body: offset + header, end: offset + size });
    if (CONTAINERS.has(type)) walkBoxes(buffer, offset + header, offset + size, visit, depth + 1);
    offset += size;
  }
}

function analyzeMp4(buffer) {
  const top = [];
  const tracks = [];
  const trex = {};
  const samples = [];
  let track = null;
  let moofStart = 0;
  let traf = null;
  walkBoxes(buffer, 0, buffer.length, (box) => {
    const b = box.body;
    if (box.depth === 0) top.push({ type: box.type, size: box.size });
    if (box.type === 'trak') { track = { id: 0, handler: '', timescale: 0 }; tracks.push(track); }
    else if (box.type === 'tkhd' && track) track.id = buffer.readUInt32BE(b + (buffer[b] === 1 ? 20 : 12));
    else if (box.type === 'mdhd' && track) track.timescale = buffer.readUInt32BE(b + (buffer[b] === 1 ? 20 : 12));
    else if (box.type === 'hdlr' && track) track.handler = buffer.toString('latin1', b + 8, b + 12);
    else if (box.type === 'trex') {
      trex[buffer.readUInt32BE(b + 4)] = {
        duration: buffer.readUInt32BE(b + 12), size: buffer.readUInt32BE(b + 16), flags: buffer.readUInt32BE(b + 20),
      };
    } else if (box.type === 'moof') moofStart = box.offset;
    else if (box.type === 'tfhd') {
      const flags = buffer.readUInt32BE(b) & 0xffffff;
      const id = buffer.readUInt32BE(b + 4);
      let p = b + 8;
      const defaults = trex[id] || { duration: 0, size: 0, flags: 0 };
      traf = { id, base: moofStart, duration: defaults.duration, size: defaults.size, flags: defaults.flags, time: 0 };
      if (flags & 0x1) { traf.base = Number(buffer.readBigUInt64BE(p)); p += 8; }
      if (flags & 0x2) p += 4;
      if (flags & 0x8) { traf.duration = buffer.readUInt32BE(p); p += 4; }
      if (flags & 0x10) { traf.size = buffer.readUInt32BE(p); p += 4; }
      if (flags & 0x20) { traf.flags = buffer.readUInt32BE(p); p += 4; }
    } else if (box.type === 'tfdt' && traf) {
      traf.time = buffer[b] === 1 ? Number(buffer.readBigUInt64BE(b + 4)) : buffer.readUInt32BE(b + 4);
    } else if (box.type === 'trun' && traf) {
      const flags = buffer.readUInt32BE(b) & 0xffffff;
      const count = buffer.readUInt32BE(b + 4);
      let p = b + 8;
      let position = traf.base;
      if (flags & 0x1) { position += buffer.readInt32BE(p); p += 4; }
      let firstFlags = null;
      if (flags & 0x4) { firstFlags = buffer.readUInt32BE(p); p += 4; }
      for (let i = 0; i < count; i += 1) {
        let duration = traf.duration, size = traf.size, sampleFlags = traf.flags, cto = 0;
        if (flags & 0x100) { duration = buffer.readUInt32BE(p); p += 4; }
        if (flags & 0x200) { size = buffer.readUInt32BE(p); p += 4; }
        if (flags & 0x400) { sampleFlags = buffer.readUInt32BE(p); p += 4; }
        else if (i === 0 && firstFlags != null) sampleFlags = firstFlags;
        if (flags & 0x800) { cto = buffer.readInt32BE(p); p += 4; }
        samples.push({ track: traf.id, offset: position, size, duration, dts: traf.time, cto, key: !(sampleFlags & 0x10000) });
        position += size;
        traf.time += duration;
      }
    }
  });
  const video = tracks.find((item) => item.handler === 'vide') || null;
  const videoSamples = video ? samples.filter((item) => item.track === video.id) : [];
  const durations = videoSamples.map((item) => item.duration);
  const distinct = [...new Set(durations)].sort((a, c) => a - c);
  // avcC يُبحث عنه نصاً داخل الملف؛ يكفي للمسبار ولا يصلح للقارئ الإنتاجي.
  const at = buffer.indexOf(Buffer.from('avcC', 'latin1'));
  let avcC = null;
  if (at > 4) {
    const size = buffer.readUInt32BE(at - 4);
    avcC = buffer.subarray(at + 4, at - 4 + size);
  }
  const entry = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01'].find((name) => buffer.indexOf(Buffer.from(name, 'latin1'), 32) > 0) || '';
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    top_boxes: top.slice(0, 24), top_box_count: top.length,
    fragmented: top.some((item) => item.type === 'moof'),
    moof_count: top.filter((item) => item.type === 'moof').length,
    tracks, sample_entry: entry,
    video: video ? {
      timescale: video.timescale, samples: videoSamples.length,
      keyframes: videoSamples.filter((item) => item.key).length,
      duration_s: video.timescale ? total / video.timescale : null,
      duration_ticks_min: distinct[0] ?? null, duration_ticks_max: distinct[distinct.length - 1] ?? null,
      distinct_durations: distinct.length, constant_frame_rate: distinct.length === 1,
      mean_fps: total ? videoSamples.length * video.timescale / total : null,
      any_composition_offset: videoSamples.some((item) => item.cto !== 0),
    } : null,
    avcC_bytes: avcC ? avcC.length : 0,
    codec: avcC && avcC.length >= 4 ? 'avc1.' + avcC.subarray(1, 4).toString('hex') : '',
    avcC, videoSamples, timescale: video ? video.timescale : 0,
  };
}

// ───────────────────────── دوال تُحقن في المصيّر ─────────────────────────

async function rendererCodecs() {
  const out = { video: [], audio: [], user_agent: navigator.userAgent, secure_context: isSecureContext };
  const targets = [
    ['1080p30', 'avc1.640028', 1920, 1080, 30, 12e6], ['1080p30', 'avc1.4d0028', 1920, 1080, 30, 12e6],
    ['1080p30', 'avc1.420028', 1920, 1080, 30, 12e6], ['1080p30-v1plan', 'avc1.42001f', 1920, 1080, 30, 12e6],
    ['1080p60-v1plan', 'avc1.640028', 1920, 1080, 60, 18e6],
    ['1080p60', 'avc1.64002A', 1920, 1080, 60, 18e6], ['1080p60', 'avc1.4d002A', 1920, 1080, 60, 18e6],
    ['1080p60', 'avc1.42002A', 1920, 1080, 60, 18e6],
    ['4K30-v1plan', 'avc1.640028', 3840, 2160, 30, 35e6],
    ['4K30', 'avc1.640033', 3840, 2160, 30, 35e6], ['4K30', 'avc1.4d0033', 3840, 2160, 30, 35e6],
    ['vertical1080p30', 'avc1.640028', 1080, 1920, 30, 12e6],
    ['vp9-1080p30', 'vp09.00.40.08', 1920, 1080, 30, 8e6],
  ];
  for (const [target, codec, width, height, framerate, bitrate] of targets) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software', 'prefer-hardware']) {
      const config = { codec, width, height, framerate, bitrate, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration };
      if (codec.startsWith('avc1')) config.avc = { format: 'avc' };
      let supported = false, error = '';
      try { supported = !!(await VideoEncoder.isConfigSupported(config)).supported; } catch (e) { error = e.name + ': ' + e.message; }
      out.video.push({ target, codec, width, height, framerate, hardwareAcceleration, supported, error });
    }
  }
  try {
    const alpha = await VideoEncoder.isConfigSupported({ codec: 'vp09.00.40.08', width: 1280, height: 720, framerate: 30, bitrate: 4e6, alpha: 'keep' });
    out.vp9_alpha_keep = !!alpha.supported;
  } catch (e) { out.vp9_alpha_keep = false; out.vp9_alpha_error = e.name + ': ' + e.message; }
  for (const [codec, bitrate] of [['mp4a.40.2', 192000], ['opus', 128000]]) {
    let supported = false, error = '';
    try { supported = !!(await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate })).supported; } catch (e) { error = e.name + ': ' + e.message; }
    out.audio.push({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate, supported, error });
  }
  return out;
}

// نغمة تبدأ عند عينة معلومة ⇒ ترميز ⇒ فك ⇒ موضع البداية في الخرج = تأخير المرمّز.
async function rendererAacDelay() {
  const rate = 48000, onset = 24000, total = 48000, block = 4800;
  const chunks = [];
  let config = null, failure = '';
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) config = meta.decoderConfig;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ ts: chunk.timestamp, dur: chunk.duration, type: chunk.type, data });
    },
    error: (e) => { failure = 'encoder ' + e.name + ': ' + e.message; },
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 2, bitrate: 192000 });
  for (let start = 0; start < total; start += block) {
    const data = new Float32Array(block * 2);
    for (let i = 0; i < block; i += 1) {
      const n = start + i;
      const value = n >= onset ? 0.8 * Math.sin(2 * Math.PI * 1000 * (n - onset) / rate) : 0;
      data[i] = value; data[block + i] = value;
    }
    const audio = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: block, numberOfChannels: 2, timestamp: Math.round(start * 1e6 / rate), data });
    encoder.encode(audio);
    audio.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure || !config) return { ok: false, error: failure || 'no_decoder_config', chunks: chunks.length };
  const pcm = [], outputs = [];
  const decoder = new AudioDecoder({
    output: (frame) => {
      const plane = new Float32Array(frame.numberOfFrames);
      frame.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
      outputs.push({ ts: frame.timestamp, frames: frame.numberOfFrames });
      pcm.push(plane);
      frame.close();
    },
    error: (e) => { failure = 'decoder ' + e.name + ': ' + e.message; },
  });
  const decoderConfig = { codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels };
  if (config.description) decoderConfig.description = config.description;
  decoder.configure(decoderConfig);
  for (const chunk of chunks) decoder.decode(new EncodedAudioChunk({ type: chunk.type, timestamp: chunk.ts, duration: chunk.dur, data: chunk.data }));
  await decoder.flush();
  decoder.close();
  let index = 0, found = -1, foundByTimestamp = null;
  for (let o = 0; o < pcm.length && found < 0; o += 1) {
    for (let i = 0; i < pcm[o].length; i += 1) {
      if (Math.abs(pcm[o][i]) > 0.2) {
        found = index + i;
        foundByTimestamp = Math.round(outputs[o].ts * rate / 1e6) + i;
        break;
      }
    }
    index += pcm[o].length;
  }
  const description = config.description ? Array.from(new Uint8Array(config.description.buffer || config.description)) : null;
  return {
    ok: !failure, error: failure, input_frames: total, onset_input: onset,
    encoded_chunks: chunks.length, first_chunks: chunks.slice(0, 3).map((c) => ({ ts: c.ts, dur: c.dur, bytes: c.data.length })),
    last_chunk: chunks.length ? { ts: chunks[chunks.length - 1].ts, dur: chunks[chunks.length - 1].dur } : null,
    decoder_config: { codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels, description },
    decoded_frames: outputs.reduce((sum, item) => sum + item.frames, 0),
    first_output: outputs[0] || null,
    onset_by_index: found, delay_samples_by_index: found < 0 ? null : found - onset,
    onset_by_timestamp: foundByTimestamp, delay_samples_by_timestamp: foundByTimestamp == null ? null : foundByTimestamp - onset,
  };
}

// ترميز 90 إطاراً من لوحة: ترتيب الطوابع، وسرعة الترميز، ووصف المرمّز.
async function rendererEncodeOrder(codec, hardwareAcceleration) {
  const width = 1920, height = 1080, fps = 30, frames = 90;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  const chunks = [];
  let config = null, failure = '';
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) config = meta.decoderConfig;
      chunks.push({ ts: chunk.timestamp, type: chunk.type, bytes: chunk.byteLength });
    },
    error: (e) => { failure = e.name + ': ' + e.message; },
  });
  encoder.configure({ codec, width, height, framerate: fps, bitrate: 12e6, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } });
  const started = performance.now();
  let maxQueue = 0;
  try {
  for (let i = 0; i < frames && !failure; i += 1) {
    context.fillStyle = '#17324d'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#d9a441'; context.fillRect(40 + i * 18, 300, 320, 320);
    context.fillStyle = '#ffffff'; context.font = '96px sans-serif'; context.direction = 'rtl';
    context.fillText('إطار ' + i, width - 80, 200);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    while (encoder.encodeQueueSize > 4 && !failure) {
      await new Promise((resolve) => { encoder.addEventListener('dequeue', resolve, { once: true }); setTimeout(resolve, 2000); });
    }
    if (failure) { frame.close(); break; }
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    maxQueue = Math.max(maxQueue, encoder.encodeQueueSize);
    frame.close();
  }
  await encoder.flush();
  } catch (e) { failure = failure || e.name + ': ' + e.message; }
  const elapsed = performance.now() - started;
  try { encoder.close(); } catch {}
  let monotonic = true;
  for (let i = 1; i < chunks.length; i += 1) if (chunks[i].ts <= chunks[i - 1].ts) monotonic = false;
  return {
    ok: !failure, error: failure, codec, hardwareAcceleration, frames_in: frames, chunks_out: chunks.length,
    timestamps_monotonic: monotonic, keyframes: chunks.filter((c) => c.type === 'key').length,
    total_bytes: chunks.reduce((sum, c) => sum + c.bytes, 0),
    elapsed_ms: Math.round(elapsed), encode_fps: Math.round(frames * 1000 / elapsed * 10) / 10, max_queue: maxQueue,
    decoder_config: config ? {
      codec: config.codec, codedWidth: config.codedWidth, codedHeight: config.codedHeight,
      description_bytes: config.description ? (config.description.byteLength || 0) : 0,
      colorSpace: config.colorSpace ? JSON.parse(JSON.stringify(config.colorSpace)) : null,
    } : null,
  };
}

async function rendererStartRecording(sourceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, minFrameRate: 30, maxFrameRate: 30, maxWidth: 3840, maxHeight: 2160,
  } } });
  // القائمة نفسها التي في src/ui/lib/media-recorder.js: prepareAppRecording ثم pickRecMime.
  const candidates = ['video/mp4;codecs=avc1.64002A', 'video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const supported = candidates.filter((item) => MediaRecorder.isTypeSupported(item));
  const mime = supported[0] || '';
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  const options = { videoBitsPerSecond: Math.min(80000000, Math.max(24000000, Math.round((settings.width || 1920) * (settings.height || 1080) * 30 * 0.4))) };
  if (mime) options.mimeType = mime;
  const state = window.__probeRec = { stream, chunks: [], mime, recorder: new MediaRecorder(stream, options) };
  state.recorder.ondataavailable = (event) => { if (event.data && event.data.size) state.chunks.push(event.data); };
  state.recorder.start(1000);
  return { mime, supported, settings };
}

async function rendererStopRecording() {
  const state = window.__probeRec;
  const blob = await new Promise((resolve) => {
    state.recorder.onstop = () => resolve(new Blob(state.chunks, { type: state.mime || 'video/webm' }));
    state.recorder.stop();
  });
  state.stream.getTracks().forEach((track) => track.stop());
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { type: blob.type, size: blob.size, chunks: state.chunks.length, base64: btoa(binary) };
}

async function rendererAnalyzeSegment(input) {
  const out = {};
  const wait = (target, name, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + '_timeout')), ms);
    target.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.src = input.url;
  await wait(video, 'loadeddata', 15000);
  out.element = { duration: Number.isFinite(video.duration) ? video.duration : String(video.duration), videoWidth: video.videoWidth, videoHeight: video.videoHeight };
  const duration = input.durationS || (Number.isFinite(video.duration) ? video.duration : 3);

  // زمن القفز: مئة إطار متتابعة بخطوة 1/30، وهو نمط التصدير إطاراً بإطار.
  const times = [];
  const first = 0.3, span = Math.max(0.5, duration - 0.6);
  for (let i = 0; i < 100; i += 1) {
    const t = first + (i / 30) % span;
    const started = performance.now();
    video.currentTime = t;
    await wait(video, 'seeked', 5000);
    times.push(performance.now() - started);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const round = (value) => Math.round(value * 10) / 10;
  out.seek = {
    count: times.length, mean_ms: round(times.reduce((s, v) => s + v, 0) / times.length), median_ms: round(sorted[50]),
    p95_ms: round(sorted[94]), max_ms: round(sorted[99]), min_ms: round(sorted[0]),
    projected_60s_1080p30_s: round(times.reduce((s, v) => s + v, 0) / times.length * 1800 / 1000),
  };

  // تحويل الإحداثيات: صندوق الزر الأرجواني في إطار الفيديو مقابل rect/viewport.
  video.currentTime = Math.max(0.2, duration - 0.5);
  await wait(video, 'seeked', 5000);
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      if (pixels[i] > 190 && pixels[i + 1] < 90 && pixels[i + 2] > 190) {
        count += 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const scaleX = canvas.width / input.viewport.width, scaleY = canvas.height / input.viewport.height;
  const expected = { x: input.rect.x * scaleX, y: input.rect.y * scaleY, width: input.rect.width * scaleX, height: input.rect.height * scaleY };
  const measured = count ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  out.coordinates = {
    frame: { width: canvas.width, height: canvas.height }, viewport: input.viewport, scale_x: scaleX, scale_y: scaleY,
    magenta_pixels: count, expected_px: expected, measured_px: measured,
    error_px: measured ? {
      left: round(measured.x - expected.x), top: round(measured.y - expected.y),
      right: round(measured.x + measured.width - expected.x - expected.width),
      bottom: round(measured.y + measured.height - expected.y - expected.height),
    } : null,
  };
  out.frame_png = canvas.toDataURL('image/png');

  // هل يكفي avcC + عينات trun لتشغيل VideoDecoder متتابعاً؟
  if (input.codec && input.avcC && input.samples.length) {
    const description = Uint8Array.from(atob(input.avcC), (c) => c.charCodeAt(0));
    const config = { codec: input.codec, description, codedWidth: video.videoWidth, codedHeight: video.videoHeight };
    const decode = { codec: input.codec, samples_fed: 0, frames_out: 0, error: '' };
    try {
      decode.config_supported = !!(await VideoDecoder.isConfigSupported(config)).supported;
      const data = new Uint8Array(await (await fetch(input.url)).arrayBuffer());
      const decoder = new VideoDecoder({
        output: (frame) => {
          decode.frames_out += 1;
          if (!decode.first_frame) decode.first_frame = { displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, format: frame.format, timestamp: frame.timestamp };
          frame.close();
        },
        error: (e) => { decode.error = e.name + ': ' + e.message; },
      });
      decoder.configure(config);
      const started = performance.now();
      for (const sample of input.samples) {
        decoder.decode(new EncodedVideoChunk({
          type: sample.key ? 'key' : 'delta', timestamp: Math.round(sample.dts * 1e6 / input.timescale),
          duration: Math.round(sample.duration * 1e6 / input.timescale), data: data.subarray(sample.offset, sample.offset + sample.size),
        }));
        decode.samples_fed += 1;
      }
      await decoder.flush();
      decode.elapsed_ms = Math.round(performance.now() - started);
      decode.decode_fps = decode.elapsed_ms ? round(decode.frames_out * 1000 / decode.elapsed_ms) : null;
      decoder.close();
    } catch (e) { decode.error = decode.error || e.name + ': ' + e.message; }
    out.decoder = decode;
  }
  return out;
}

// ───────────────────────── المسار الرئيسي ─────────────────────────

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// الرفض داخل المصيّر يُحوَّل إلى نص؛ كائن الخطأ نفسه لا يعبر IPC.
const inject = (fn, ...args) => '(' + fn.toString() + ')(' + args.map((item) => JSON.stringify(item)).join(',')
  + ').catch(function(e){throw new Error(String(e&&e.name)+": "+String(e&&e.message));})';

async function main() {
  await app.whenReady();
  fs.mkdirSync(eventDir, { recursive: true });
  for (const name of fs.readdirSync(eventDir)) { try { fs.unlinkSync(path.join(eventDir, name)); } catch {} }

  const display = screen.getPrimaryDisplay();
  result.versions = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch };
  result.display = { size: display.size, workAreaSize: display.workAreaSize, scaleFactor: display.scaleFactor };
  result.gpu = await app.getGPUInfo('basic').then((info) => (info.gpuDevice || []).map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active })), () => null);

  let segmentPath = '';
  const appPage = '<!doctype html><meta charset="utf-8"><title>مسبار الإعلان</title><style>'
    + 'html,body{margin:0;height:100%;background:#101820;overflow:hidden}'
    + '#target{position:absolute;left:' + TARGET.x + 'px;top:' + TARGET.y + 'px;width:' + TARGET.width + 'px;height:' + TARGET.height + 'px;'
    + 'background:#ff00ff;border:0;padding:0;margin:0;outline:0;border-radius:0}'
    + '.box{position:absolute;left:0;bottom:60px;width:160px;height:160px;background:#d9a441;animation:move 1s linear infinite alternate}'
    + '@keyframes move{to{transform:translateX(900px)}}</style><button id="target"></button><div class="box"></div>';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/segment') && segmentPath) {
      // دعم Range ضروري كي يقفز عنصر <video> داخل الملف.
      const size = fs.statSync(segmentPath).size;
      const type = segmentPath.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + start + '-' + end + '/' + size, 'content-length': end - start + 1 });
        fs.createReadStream(segmentPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
        fs.createReadStream(segmentPath).pipe(res);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/probe') ? '<!doctype html><meta charset="utf-8"><title>probe</title>' : appPage);
  });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;

  const receiver = new BrowserWindow({
    show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await receiver.loadURL(base + '/probe');
  const run = (fn, ...args) => receiver.webContents.executeJavaScript(inject(fn, ...args), true);

  stage('codecs');
  result.codecs = await run(rendererCodecs);

  stage('aac_delay');
  result.aac_delay = [];
  if (result.codecs.audio.find((item) => item.codec === 'mp4a.40.2' && item.supported)) {
    for (let i = 0; i < 3; i += 1) result.aac_delay.push(await run(rendererAacDelay));
  }

  stage('encode_order');
  result.encode_order = [];
  const firstH264 = result.codecs.video.find((item) => item.target === '1080p30' && item.supported && item.hardwareAcceleration === 'no-preference');
  if (firstH264) {
    for (const mode of ['no-preference', 'prefer-software', 'prefer-hardware']) {
      if (result.codecs.video.find((item) => item.target === '1080p30' && item.codec === firstH264.codec && item.hardwareAcceleration === mode && item.supported)) {
        result.encode_order.push(await run(rendererEncodeOrder, firstH264.codec, mode));
      }
    }
  }

  stage('record');
  const promo = require('../electron/promocapture');
  const preview = require('../electron/preview');
  let captureContents = null;
  let recordedStart = null, recordedStop = null, recordError = '';
  let controller;
  controller = promo.create({
    BrowserWindow, desktopCapturer,
    displaySession: receiver.webContents.session,
    ownerWebContents: receiver.webContents,
    downloadsPath: app.getPath('downloads'),
    eventRoot: eventDir,
    isHttpUrl: (value) => /^https?:\/\//.test(value),
    readyDelayMs: 400,
    onTarget(webContents) {
      captureContents = webContents;
      const captureWindow = webContents && BrowserWindow.fromWebContents(webContents);
      if (captureWindow) { captureWindow.moveTop(); captureWindow.focus(); }
      // نفس توصيل اختبار الأحداث الحي: سجل الأحداث يأتي من جسر المعاينة.
      try {
        preview.setExternalTargetProvider(() => webContents, () => {});
        preview.attachExternalWebContents(webContents);
      } catch (e) { result.event_wiring_error = String(e && e.message || e); }
    },
    emit(event) {
      if (event.type === 'capture_start') {
        result.capture_start_event = { width: event.width, height: event.height, fps: event.fps, source_enumerated: event.source_enumerated, target_kind: event.target_kind };
        run(rendererStartRecording, event.source_id).then((value) => {
          recordedStart = value;
          controller.rendererReady(event.session_id, true, '');
        }).catch((e) => { recordError = String(e && e.message || e); controller.rendererReady(event.session_id, false, 'media_failed'); });
      } else if (event.type === 'capture_stop') {
        run(rendererStopRecording).then((value) => {
          recordedStop = value;
          const ext = /mp4/.test(value.type) ? 'mp4' : 'webm';
          const filename = promo.segmentFilename(event.session_id, new Date(), ext);
          controller.rendererCommit(event.session_id, 4000, filename);
          // إقرار حفظ محقون كما في test:promocapture-live؛ الملف الفعلي يُكتب في dist لا في Downloads.
          controller.downloadResult({ type: 'promo_recording_saved', filename, path: path.join(app.getPath('downloads'), filename) });
        }).catch((e) => { recordError = String(e && e.message || e); });
      }
    },
  });

  const started = await controller.start({ aspect: '16:9', url: base + '/' });
  if (!started.ok) throw new Error('capture start failed: ' + started.error + ' ' + recordError);
  const captureWindow = BrowserWindow.fromWebContents(captureContents);
  result.capture_window = {
    bounds: captureWindow.getBounds(), contentBounds: captureWindow.getContentBounds(),
    visible: captureWindow.isVisible(), focused: captureWindow.isFocused(),
    cursor_screen_point: screen.getCursorScreenPoint(),
  };
  result.capture_page = await captureContents.executeJavaScript(`(function(){var r=document.getElementById('target').getBoundingClientRect();
    return {innerWidth:innerWidth,innerHeight:innerHeight,devicePixelRatio:devicePixelRatio,rect:{x:r.left,y:r.top,width:r.width,height:r.height}};})()`, true);
  await delay(1200);
  const center = { x: Math.round(TARGET.x + TARGET.width / 2), y: Math.round(TARGET.y + TARGET.height / 2) };
  captureContents.sendInputEvent({ type: 'mouseMove', x: center.x, y: center.y, movementX: 1, movementY: 1 });
  captureContents.sendInputEvent({ type: 'mouseDown', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  captureContents.sendInputEvent({ type: 'mouseUp', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  await delay(2800);
  const stopped = await controller.stop();
  result.capture_stop = { ok: !!(stopped && stopped.ok), error: stopped && stopped.error || '', record_error: recordError };
  for (let i = 0; i < 50 && !recordedStop && !recordError; i += 1) await delay(100);
  if (!recordedStop) throw new Error('no recording: ' + JSON.stringify({ stopped, recordError }));
  result.recording = { start: recordedStart, type: recordedStop.type, size: recordedStop.size, data_chunks: recordedStop.chunks };
  const ext = /mp4/.test(recordedStop.type) ? 'mp4' : 'webm';
  segmentPath = path.join(outDir, 'segment-' + tag + '.' + ext);
  const bytes = Buffer.from(recordedStop.base64, 'base64');
  fs.writeFileSync(segmentPath, bytes);
  try { await controller.stopAll(); } catch {}

  stage('events');
  const eventFiles = fs.readdirSync(eventDir);
  const records = [];
  for (const name of eventFiles) {
    for (const line of fs.readFileSync(path.join(eventDir, name), 'utf8').split('\n')) {
      if (line.trim()) { try { records.push(JSON.parse(line)); } catch {} }
    }
  }
  const actions = records.filter((item) => item.kind === 'action' || item.action === 'mousedown');
  result.events = {
    files: eventFiles, records: records.length, kinds: records.reduce((map, item) => { map[item.kind] = (map[item.kind] || 0) + 1; return map; }, {}),
    actions: actions.slice(0, 6), clock: records.find((item) => item.kind === 'clock') || null,
  };

  stage('container');
  let analysis = null;
  if (ext === 'mp4') {
    analysis = analyzeMp4(bytes);
    const { avcC, videoSamples, timescale, ...summary } = analysis;
    result.container = summary;
  } else {
    result.container = { format: 'webm', head_hex: bytes.subarray(0, 32).toString('hex'), note: 'تحليل WebM خارج المسبار' };
  }

  stage('segment');
  const down = actions.find((item) => item.action === 'mousedown' && item.rect && item.viewport);
  const viewport = down ? down.viewport : { width: result.capture_page.innerWidth, height: result.capture_page.innerHeight };
  const rect = down ? down.rect : TARGET;
  result.coordinate_source = down ? 'event_log' : 'dom_fallback';
  const segment = await run(rendererAnalyzeSegment, {
    url: base + '/segment?' + Date.now(), durationS: analysis && analysis.video ? analysis.video.duration_s : 0,
    viewport: { width: viewport.width, height: viewport.height }, rect,
    codec: analysis ? analysis.codec : '', avcC: analysis && analysis.avcC ? analysis.avcC.toString('base64') : '',
    samples: analysis ? analysis.videoSamples.slice(0, 120) : [], timescale: analysis ? analysis.timescale : 0,
  });
  if (segment.frame_png) {
    fs.writeFileSync(path.join(outDir, 'frame-' + tag + '.png'), Buffer.from(segment.frame_png.split(',')[1], 'base64'));
    delete segment.frame_png;
  }
  result.segment = segment;

  // النقرات المحقونة بـsendInputEvent لا تحرّك مؤشر النظام، فظهور المؤشر لا يُقاس آلياً هنا.
  result.cursor = { measurable: false, reason: 'synthetic_input_does_not_move_os_cursor', frame_png: 'frame-' + tag + '.png' };

  await new Promise((resolve) => server.close(resolve));
  result.ok = true;
  stage('done');
  finish(0);
}

main().catch((error) => { result.error = String((error && error.stack) || error); finish(1); });
