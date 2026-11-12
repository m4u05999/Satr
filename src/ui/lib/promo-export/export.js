// محرك التصدير إطاراً بإطار: renderFrame الحتمية ⇒ VideoEncoder ⇒ mp4-mux ⇒ كاتب main.
// لا زمن حقيقي ولا إطارات ساقطة: الإطار i يُرسم عند i × 1000/fps بالضبط ثم يُرمَّز، مهما طال ذلك.
//
// الحلقة لا تستعمل requestAnimationFrame (يُخنق حين تُخفى النافذة)؛ تتقدم بوعود الضغط الخلفي.

import { buildTimeline, sceneAt, frameCount, frameTimeMs } from '../promo/promo-timeline.js';
import { renderFrame } from '../promo/promo-frame.js';
import { createMp4Muxer } from './mp4-mux.js';
import { openVideoSource } from './frame-source.js';
import { pickEncoderConfig, presetSize, EXPORT_PRESETS } from './encode.js';
import { decodeAudioAsset, mixTracks, encodeAac, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITRATE, AAC_FRAME } from './audio-mix.js';

const WRITE_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_IPC_CHUNK = 6 * 1024 * 1024;
const level = (value, fallback) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback);

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error('image_timeout')), 15000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('image_failed')); };
    image.src = url;
  });
}

// options:
//   scenes        مشاهد الـstoryboard وقد أضيف لكلٍّ src (ورابط الأصل)، مع asset/music/voice كمسارات
//   aspect, preset, colors, pointers
//   readAsset(path, offset, length) ⇒ { ok, size, bytes }
//   writer: { begin(), chunk(handle, seq, bytes), finish(handle, header), abort(handle) }
//   signal, onProgress({ frame, frames, stage })
export async function exportStoryboard(options) {
  const initial = ['no-preference', 'prefer-hardware', 'prefer-software'].includes(options.acceleration) ? options.acceleration : 'no-preference';
  const first = await runExport(options, initial).catch((error) => ({ error }));
  if (!first.error) return first;
  // المرمّز العتادي قد يُقبل في الفحص ثم يفشل عند التهيئة أو أثناء الترميز (مقيس في الدفعة 0).
  // نعيد التصدير من أوله برمجياً مرة واحدة؛ الإلغاء والأخطاء الأخرى تمر كما هي.
  if (first.error && first.error.encoderFailure && initial !== 'prefer-software') {
    const second = await runExport(options, 'prefer-software');
    second.encoder.retried_after = String(first.error.message || first.error);
    return second;
  }
  throw first.error;
}

async function runExport(options, acceleration) {
  const scenes = Array.isArray(options.scenes) ? options.scenes : [];
  const presetName = EXPORT_PRESETS[options.preset] ? options.preset : '1080p30';
  const aspect = options.aspect || '16:9';
  const { width, height, fps } = presetSize(aspect, presetName);
  const timeline = buildTimeline({ scenes });
  const frames = frameCount(timeline.totalMs, fps);
  if (!scenes.length || !frames) throw new Error('bad_storyboard');
  const writer = options.writer;
  const signal = options.signal;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const cancelled = () => { if (signal && signal.aborted) throw new Error('render_cancelled'); };
  const started = performance.now();

  const config = await pickEncoderConfig(aspect, presetName, acceleration);
  if (!config) throw new Error('encoder_unsupported');

  // ── الصوت أولاً: يُفك ويُمزج ويُرمَّز كاملاً (بضعة ميغابايتات على الأكثر) ──
  progress({ frame: 0, frames, stage: 'audio' });
  const tracks = [];
  const voiceDurations = new Map();
  const decoded = new Map();
  const decode = async (assetPath) => {
    if (!assetPath) return null;
    if (!decoded.has(assetPath)) decoded.set(assetPath, await decodeAudioAsset(options.readAsset, assetPath));
    return decoded.get(assetPath);
  };
  let audioSources = 0;
  for (const entry of timeline.scenes) {
    cancelled();
    const scene = entry.scene;
    const add = (buffer, volume, offsetMs) => {
      if (!buffer) return;
      tracks.push({ buffer, startMs: entry.startMs, offsetMs, durationMs: entry.durationMs, volume });
      audioSources += 1;
    };
    if (scene.asset_type !== 'image') add(await decode(scene.asset), level(scene.clip_volume, 1), entry.sourceStartMs);
    add(await decode(scene.music), level(scene.music_volume, 0.34), 0);
    const voice = await decode(scene.voice);
    if (voice) voiceDurations.set(entry.index, voice.duration * 1000);
    add(voice, level(scene.voice_volume, 1), 0);
  }
  const mixed = await mixTracks(tracks, timeline.totalMs);
  cancelled();
  const audio = await encodeAac(mixed);
  decoded.clear();

  // ── الفيديو ──
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  const runtime = { width, height, colors: options.colors, timeline, pointers: options.pointers || null, aspect, voiceDurations };

  const begun = await writer.begin();
  if (!begun || !begun.ok) throw new Error('export_begin_failed:' + (begun && begun.error || 'unknown'));
  const handle = begun.handle;
  let aborted = false;
  const abort = async () => { if (!aborted) { aborted = true; try { await writer.abort(handle); } catch {} } };

  const sources = new Map();   // فهرس المشهد ⇒ مصدر مفتوح
  const sourceReport = [];
  let encoder = null;
  try {
    let description = null;
    let muxer = null;
    let failure = null;
    let seq = 0, batch = [], batchBytes = 0, audioIndex = 0, videoSamples = 0, payloadBytes = 0;
    let chain = Promise.resolve();

    const flushBatch = async () => {
      if (!batchBytes) return;
      const bytes = new Uint8Array(batchBytes);
      let offset = 0;
      for (const part of batch) { bytes.set(part, offset); offset += part.length; }
      batch = []; batchBytes = 0;
      for (let start = 0; start < bytes.length; start += MAX_IPC_CHUNK) {
        // slice لا subarray: النسخ البنيوي عبر IPC ينسخ المخزن كله لا نافذة العرض.
        const piece = bytes.length <= MAX_IPC_CHUNK ? bytes : bytes.slice(start, Math.min(bytes.length, start + MAX_IPC_CHUNK));
        const result = await writer.chunk(handle, seq, piece);
        if (!result || !result.ok) throw new Error('export_write_failed:' + (result && result.error || 'unknown'));
        seq += 1;
      }
    };
    const push = async (data) => {
      batch.push(data); batchBytes += data.length; payloadBytes += data.length;
      if (batchBytes >= WRITE_BATCH_BYTES) await flushBatch();
    };
    // إطارات الصوت التي يبلغها زمن الفيديو تُكتب بعده مباشرة: تشابك يبقي المسارين متجاورين في الملف.
    const interleaveAudio = async (untilUs) => {
      while (audioIndex < audio.chunks.length && audioIndex * AAC_FRAME / AUDIO_SAMPLE_RATE * 1e6 <= untilUs) {
        muxer.addAudioSample({ size: audio.chunks[audioIndex].length, frames: AAC_FRAME });
        await push(audio.chunks[audioIndex]);
        audioIndex += 1;
      }
    };
    const onChunk = async (data, timestampUs, durationUs, key) => {
      if (!muxer) {
        if (!description) throw new Error('encoder_no_description');
        muxer = createMp4Muxer({
          video: { width, height, description },
          audio: { sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS, description: audio.description, bitrate: AUDIO_BITRATE },
        });
      }
      muxer.addVideoSample({ size: data.length, timestampUs, durationUs, key });
      videoSamples += 1;
      await push(data);
      await interleaveAudio(timestampUs + durationUs);
    };

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description) {
          const raw = meta.decoderConfig.description;
          description = new Uint8Array(raw.buffer ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const { timestamp, type } = chunk;
        const duration = chunk.duration || Math.round(1e6 / fps);
        chain = chain.then(() => onChunk(data, timestamp, duration, type === 'key')).catch((error) => { failure = failure || error; });
      },
      error: (error) => { failure = failure || Object.assign(error || new Error('encode_error'), { encoderFailure: true }); },
    });
    encoder.configure(config);

    const openSource = async (entry) => {
      const scene = entry.scene;
      if (scene.asset_type === 'image') {
        const image = await loadImage(scene.src);
        return { mode: 'image', frameAt: async () => ({ source: image, width: image.naturalWidth, height: image.naturalHeight }), close() {} };
      }
      const head = await options.readAsset(scene.asset, 0, 0);
      const readAt = async (offset, length) => {
        const part = await options.readAsset(scene.asset, offset, length);
        if (!part || !part.ok) throw new Error('asset_read_failed');
        return part.bytes instanceof Uint8Array ? part.bytes : new Uint8Array(part.bytes);
      };
      const source = await openVideoSource({ url: scene.src, readAt: head && head.ok ? readAt : null, fileSize: head && head.ok ? head.size : 0 });
      sourceReport.push({ index: entry.index, mode: source.mode, fallback: source.fallbackReason || '' });
      return source;
    };

    const keyInterval = fps * 2;
    for (let i = 0; i < frames; i += 1) {
      cancelled();
      if (failure) throw failure;
      const tMs = frameTimeMs(i, fps);
      const placement = sceneAt(timeline, tMs);
      const entry = placement.entry;
      // مصادر المشاهد السابقة تُغلق: مفكِّك واحد مفتوح في المرة.
      for (const [index, source] of sources) {
        if (index !== entry.index) { source.close(); sources.delete(index); }
      }
      if (!sources.has(entry.index)) sources.set(entry.index, await openSource(entry));
      const source = sources.get(entry.index);
      const baseUs = source.startUs || 0;
      const frame = await source.frameAt(baseUs + placement.sourceMs * 1000);
      renderFrame(context, runtime, tMs, new Map([[entry.index, frame]]));
      const videoFrame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      // الضغط الخلفي: لا إطار جديد والمرمّز متخم، ولا والكتابة متأخرة.
      while (encoder.encodeQueueSize > 4 && !failure) {
        await new Promise((resolve) => { encoder.addEventListener('dequeue', resolve, { once: true }); setTimeout(resolve, 1000); });
      }
      if (failure) { videoFrame.close(); throw failure; }
      try {
        encoder.encode(videoFrame, { keyFrame: i % keyInterval === 0 });
      } catch (error) {
        // مرمّز أغلقه خطأ سابق يرمي هنا قبل أن يصل نداء الخطأ؛ نعامله كفشل مرمّز.
        throw failure || Object.assign(error, { encoderFailure: true });
      } finally {
        videoFrame.close();
      }
      if (i % 8 === 0) { await chain; progress({ frame: i + 1, frames, stage: 'video' }); }
    }
    await encoder.flush();
    await chain;
    if (failure) throw failure;
    if (videoSamples !== frames) throw new Error('frame_count_mismatch:' + videoSamples + '/' + frames);
    await interleaveAudio(Infinity);
    await flushBatch();
    cancelled();
    progress({ frame: frames, frames, stage: 'finalize' });
    const header = muxer.finalize();
    const finished = await writer.finish(handle, header);
    aborted = true; // المقبض سقط في main بنجاح أو فشل
    if (!finished || !finished.ok) throw new Error('export_finish_failed:' + (finished && finished.error || 'unknown'));
    return {
      ok: true, engine: 'webcodecs', filename: finished.filename, path: finished.path, bytes: finished.bytes,
      format: { ext: 'mp4', container: 'video/mp4' }, frames, fps, width, height, duration_ms: timeline.totalMs,
      scenes_rendered: timeline.scenes.length, audio_sources: audioSources, mixed_audio_sources: audioSources,
      audio_frames: audio.chunks.length, audio_duration_ms: Math.round(audio.chunks.length * AAC_FRAME / AUDIO_SAMPLE_RATE * 1000),
      encoder: { codec: config.codec, acceleration, bitrate: config.bitrate },
      sources: sourceReport, payload_bytes: payloadBytes, elapsed_ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    await abort();
    throw error;
  } finally {
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch {}
    for (const source of sources.values()) { try { source.close(); } catch {} }
  }
}
