// اختبار حي لمصدر الإطارات والمُغلِّف معاً: فيديو اصطناعي كل إطار فيه يحمل رقمه (موضع عمود أبيض)،
// يُرمَّز بـWebCodecs ويُغلَّف بـmp4-mux ثم يُقرأ بـsource-mp4 + VideoDecoder. الإطار المعاد يجب أن
// يكون الإطار المطلوب بالضبط.

import { createMp4Muxer } from '../../src/ui/lib/promo-export/mp4-mux.js';
import { readerFromBytes } from '../../src/ui/lib/promo-export/source-mp4.js';
import { createDecoderSource, createSeekSource, openVideoSource } from '../../src/ui/lib/promo-export/frame-source.js';

const WIDTH = 640, HEIGHT = 360, FRAMES = 60;
// طوابع غير منتظمة عمداً (معدل إطارات متغيّر كما في مقاطع MediaRecorder).
const stamp = (i) => i * 33333 + (i % 3) * 5000;

async function buildSynthetic(withAudio) {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('2d');
  const video = [];
  let videoConfig = null, failure = '';
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) videoConfig = meta.decoderConfig;
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      video.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration || 33333, key: chunk.type === 'key' });
    },
    error: (error) => { failure = 'video ' + error.message; },
  });
  encoder.configure({ codec: 'avc1.42001f', width: WIDTH, height: HEIGHT, framerate: 30, bitrate: 2e6, avc: { format: 'avc' } });
  for (let i = 0; i < FRAMES; i += 1) {
    context.fillStyle = '#000000'; context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = '#ffffff'; context.fillRect(10 + i * 10, 0, 8, HEIGHT);
    const frame = new VideoFrame(canvas, { timestamp: stamp(i), duration: 33333 });
    encoder.encode(frame, { keyFrame: i % 20 === 0 });
    frame.close();
  }
  await encoder.flush(); encoder.close();
  if (failure) throw new Error(failure);

  const audio = [];
  let audioConfig = null;
  if (withAudio) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig) audioConfig = meta.decoderConfig;
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        audio.push({ data });
      },
      error: (error) => { failure = 'audio ' + error.message; },
    });
    audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
    const total = 96000, block = 4800;
    for (let start = 0; start < total; start += block) {
      const data = new Float32Array(block * 2);
      for (let i = 0; i < block; i += 1) { const v = 0.3 * Math.sin(2 * Math.PI * 440 * (start + i) / 48000); data[i] = v; data[block + i] = v; }
      const frame = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: block, numberOfChannels: 2, timestamp: Math.round(start * 1e6 / 48000), data });
      audioEncoder.encode(frame); frame.close();
    }
    await audioEncoder.flush(); audioEncoder.close();
    if (failure) throw new Error(failure);
  }

  const description = new Uint8Array(videoConfig.description.buffer || videoConfig.description);
  const muxer = createMp4Muxer({
    video: { width: WIDTH, height: HEIGHT, description },
    audio: withAudio ? { sampleRate: 48000, channels: 2, description: new Uint8Array(audioConfig.description.buffer || audioConfig.description), bitrate: 128000 } : null,
  });
  // تشابك: كل إطار فيديو تتبعه إطارات الصوت التي يبلغها زمنه.
  const payload = [];
  let audioIndex = 0;
  video.forEach((sample, index) => {
    muxer.addVideoSample({ size: sample.data.length, timestampUs: sample.timestampUs, durationUs: sample.durationUs, key: sample.key });
    payload.push(sample.data);
    const until = index + 1 < video.length ? video[index + 1].timestampUs : Infinity;
    while (audioIndex < audio.length && audioIndex * 1024 / 48000 * 1e6 < until) {
      muxer.addAudioSample({ size: audio[audioIndex].data.length, frames: 1024 });
      payload.push(audio[audioIndex].data);
      audioIndex += 1;
    }
  });
  const header = muxer.finalize();
  const size = header.length + payload.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(size);
  bytes.set(header, 0);
  let offset = header.length;
  for (const part of payload) { bytes.set(part, offset); offset += part.length; }
  return { bytes, videoSamples: video.length, audioSamples: audio.length, codec: videoConfig.codec };
}

const scratch = document.createElement('canvas');
function barIndex(frame) {
  scratch.width = WIDTH; scratch.height = HEIGHT;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  context.drawImage(frame.source, 0, 0, WIDTH, HEIGHT);
  const row = context.getImageData(0, HEIGHT / 2, WIDTH, 1).data;
  for (let x = 0; x < WIDTH; x += 1) if (row[x * 4] > 160) return Math.round((x - 10) / 10);
  return -1;
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(binary);
}

async function playsToEnd(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  const video = document.createElement('video');
  video.muted = true; video.src = url;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ended: false, reason: 'timeout', time: video.currentTime, error: video.error && video.error.message }), 12000);
    video.addEventListener('error', () => { clearTimeout(timer); resolve({ ended: false, reason: 'error', error: video.error && video.error.message }); });
    video.addEventListener('ended', () => { clearTimeout(timer); resolve({ ended: true, duration: video.duration, width: video.videoWidth, height: video.videoHeight }); });
    video.play().catch((error) => { clearTimeout(timer); resolve({ ended: false, reason: 'play', error: String(error) }); });
  });
  URL.revokeObjectURL(url);
  return result;
}

window.__promoFrameSource = async (realBase64) => {
  const failures = [];
  const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };
  const report = {};
  const stage = (name) => { window.__promoFrameSourceStage = name; };
  stage('encode');

  // ── (1) فيديو اصطناعي: المُغلِّف + القارئ + المفكِّك ──
  // مرمّز AAC في WebCodecs غير متاح على كل منصة (Electron على لينكس بلا مرمّز AAC؛ مقيس في CI).
  // مصدر الإطارات والمُغلِّف يُختبران بالفيديو وحده هناك، ومسار الصوت يُعلن متخطّى لا ناجحاً.
  const support = async (Encoder, config) => { try { return !!(await Encoder.isConfigSupported(config)).supported; } catch { return false; } };
  const videoOk = await support(VideoEncoder, { codec: 'avc1.42001f', width: WIDTH, height: HEIGHT, framerate: 30, bitrate: 2e6, avc: { format: 'avc' } });
  const aacOk = await support(AudioEncoder, { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
  report.codecs = { h264_encode: videoOk, aac_encode: aacOk };
  if (!videoOk) return { ok: true, skipped: 'لا مرمّز H.264 في WebCodecs على هذه المنصة', failures: [], report };
  const synthetic = await buildSynthetic(aacOk);
  report.synthetic = { bytes: synthetic.bytes.length, video: synthetic.videoSamples, audio: synthetic.audioSamples, codec: synthetic.codec };
  expect('المرمّز أخرج كل الإطارات', synthetic.videoSamples === FRAMES && (!aacOk || synthetic.audioSamples > 80), report.synthetic);
  stage('playback');
  const played = await playsToEnd(synthetic.bytes);
  report.playback = played;
  expect('الملف المُغلَّف (' + (aacOk ? 'فيديو + AAC' : 'فيديو وحده') + ') يُشغَّل في <video> حتى النهاية', played.ended && played.width === WIDTH && Math.abs(played.duration - 2.0) < 0.12, played);
  const videoOnly = await buildSynthetic(false);
  const playedVideoOnly = await playsToEnd(videoOnly.bytes);
  expect('ملف الفيديو وحده يُشغَّل حتى النهاية', playedVideoOnly.ended, playedVideoOnly);

  stage('decoder_open');
  const reads = [];
  const reader = readerFromBytes(synthetic.bytes);
  const source = await createDecoderSource(async (offset, length) => { reads.push(length); return reader(offset, length); }, synthetic.bytes.length);
  expect('وصف المصدر', source.mode === 'decoder' && source.frameCount === FRAMES && source.width === WIDTH && source.height === HEIGHT, { mode: source.mode, frames: source.frameCount });
  stage('sequential');
  const wrong = [];
  for (let i = 0; i < FRAMES; i += 1) {
    stage('sequential_' + i);
    const exact = barIndex(await source.frameAt(stamp(i)));
    const between = barIndex(await source.frameAt(stamp(i) + 900));
    if (exact !== i || between !== i) wrong.push([i, exact, between]);
  }
  expect('تتابع: كل إطار عند طابعه وبعده بقليل هو الإطار نفسه', wrong.length === 0, wrong.slice(0, 6));
  stage('random_access');
  expect('قبل الطابع بميلي ثانيتين ⇒ الإطار السابق', barIndex(await source.frameAt(stamp(31) - 2000)) === 30);
  expect('رجوع في الزمن', barIndex(await source.frameAt(stamp(5))) === 5);
  expect('قفزة للأمام فوق إطار مفتاحي', barIndex(await source.frameAt(stamp(55))) === 55);
  expect('رجوع إلى إطار مفتاحي بالضبط', barIndex(await source.frameAt(stamp(20))) === 20);
  expect('بعد النهاية ⇒ آخر إطار', barIndex(await source.frameAt(stamp(FRAMES - 1) + 5e6)) === FRAMES - 1);
  expect('قبل البداية ⇒ أول إطار', barIndex(await source.frameAt(-1000)) === 0);
  expect('القراءة على دفعات لا الملف كله', Math.max(...reads) < synthetic.bytes.length, { max: Math.max(...reads), size: synthetic.bytes.length });
  source.close();
  let closedError = '';
  try { await source.frameAt(0); } catch (error) { closedError = error.message; }
  expect('المصدر المغلق يرفض', closedError === 'source_closed', closedError);

  // ── (2) المقطع الحقيقي: المفكِّك مقابل عنصر <video> ──
  stage('real');
  const real = fromBase64(realBase64);
  stage('real_decoder_open');
  const realSource = await createDecoderSource(readerFromBytes(real), real.length);
  stage('real_seek_open');
  const seekSource = await createSeekSource('promo-segment-fragmented.mp4');
  stage('real_compare');
  const compare = document.createElement('canvas'); compare.width = 480; compare.height = 260;
  const grab = (frame) => {
    const context = compare.getContext('2d', { willReadFrequently: true });
    context.drawImage(frame.source, 0, 0, compare.width, compare.height);
    return context.getImageData(0, 0, compare.width, compare.height).data;
  };
  const diffs = [];
  for (const seconds of [0.2, 0.9, 1.5, 2.2, 3.0, 3.7, 4.4, 5.3]) {
    stage('real_decode_' + seconds);
    const a = grab(await realSource.frameAt(realSource.startUs + seconds * 1e6));
    stage('real_seek_' + seconds);
    const b = grab(await seekSource.frameAt(seconds * 1e6));
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    diffs.push(Math.round(sum / (a.length / 4 * 3) * 100) / 100);
  }
  report.real = { frames: realSource.frameCount, durationS: Math.round(realSource.durationUs / 1e4) / 100, mean_abs_diff: diffs };
  expect('المقطع الحقيقي: إطار المفكِّك يطابق إطار <video> عند ثمانية أزمنة', Math.max(...diffs) < 6, diffs);
  // سرعة التتابع على المقطع الحقيقي بخطوة 1/30
  stage('real_speed');
  const started = performance.now();
  let steps = 0;
  for (let t = realSource.startUs; t < realSource.startUs + realSource.durationUs; t += 33333) { await realSource.frameAt(t); steps += 1; }
  report.real.sequential_fps = Math.round(steps * 1000 / (performance.now() - started));
  // العتبة منخفضة عمداً: عدّاء CI يفك برمجياً بلا كرت. الرقم الفعلي يُطبع في سطر الخاتمة.
  expect('التتابع ليس أبطأ من القفز (≥ 20 إطاراً/ث)', report.real.sequential_fps >= 20, report.real.sequential_fps);
  realSource.close(); seekSource.close();

  // ── (3) البديل ──
  stage('fallback');
  const fallback = await openVideoSource({ url: 'promo-segment-fragmented.mp4', readAt: async () => new Uint8Array(64), fileSize: 4096 });
  expect('بايتات غير صالحة ⇒ بديل القفز مع السبب', fallback.mode === 'seek' && !!fallback.fallbackReason, { mode: fallback.mode, reason: fallback.fallbackReason });
  expect('البديل يعيد إطاراً', (await fallback.frameAt(1e6)).width > 0);
  fallback.close();
  const noReader = await openVideoSource({ url: 'promo-segment-fragmented.mp4' });
  expect('بلا قارئ ⇒ بديل القفز', noReader.mode === 'seek' && noReader.fallbackReason === 'no_reader', noReader.fallbackReason);
  noReader.close();
  const direct = await openVideoSource({ url: 'promo-segment-fragmented.mp4', readAt: readerFromBytes(real), fileSize: real.length });
  expect('المقطع الحقيقي يفتح بالمفكِّك', direct.mode === 'decoder', direct.mode);
  direct.close();

  return { ok: !failures.length, failures, report, sample: toBase64(synthetic.bytes) };
};
