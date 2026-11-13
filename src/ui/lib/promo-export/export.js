// محرك التصدير إطاراً بإطار: renderFrame الحتمية ⇒ VideoEncoder ⇒ mp4-mux ⇒ كاتب main.
// لا زمن حقيقي ولا إطارات ساقطة: الإطار i يُرسم عند i × 1000/fps بالضبط ثم يُرمَّز، مهما طال ذلك.
//
// الحلقة لا تستعمل requestAnimationFrame (يُخنق حين تُخفى النافذة)؛ تتقدم بوعود الضغط الخلفي.
// سائق الإطارات (createFrameDriver) مشترك بين MP4 وGIF والصورة المصغرة.

import { buildTimeline, sceneAt, frameCount, frameTimeMs } from '../promo/promo-timeline.js';
import { renderFrame } from '../promo/promo-frame.js';
import { createMp4Muxer } from './mp4-mux.js';
import { openVideoSource } from './frame-source.js';
import { pickEncoderConfig, presetSize, EXPORT_PRESETS, ASPECT_BASE } from './encode.js';
import { decodeAudioAsset, mixTracks, encodeAac, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITRATE, AAC_FRAME } from './audio-mix.js';
import { gifSize, gifHeader, gifFrame, frameDelayCs, GIF_TRAILER, GIF_MAX_FPS, GIF_MAX_MS } from './gif.js';

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

// سائق الإطارات: يفتح مصادر المشاهد عند الحاجة ويرسم الإطار i على لوحة بالمقاس المطلوب.
// options: scenes, aspect, colors, pointers, readAsset، voiceDurations اختياري.
// يعيد { timeline, frames, canvas, context, runtime, sourceReport, renderAt(i), close() }.
// مفكِّك واحد مفتوح في المرة.
export async function createFrameDriver(options, size) {
  const scenes = Array.isArray(options.scenes) ? options.scenes : [];
  const { width, height, fps } = size;
  const timeline = buildTimeline({ scenes });
  const frames = frameCount(timeline.totalMs, fps);
  if (!scenes.length || !frames) throw new Error('bad_storyboard');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: !!size.readback });
  // صور خلفيات المسرح تُحمَّل مرة؛ ولقطات آخر إطار من كل مشهد لانتقال دخول ما بعده.
  const images = new Map();
  for (const scene of scenes) {
    const background = scene.stage && scene.stage.background;
    if (background && background.type === 'image' && background.image && scene.stageImageSrc && !images.has(background.image)) {
      try { const image = await loadImage(scene.stageImageSrc); images.set(background.image, { source: image, width: image.naturalWidth, height: image.naturalHeight }); } catch {}
    }
  }
  const snapshots = new Map();
  const runtime = {
    width, height, colors: options.colors, timeline, pointers: options.pointers || null,
    aspect: options.aspect || '16:9', voiceDurations: options.voiceDurations || new Map(), images, snapshots,
  };
  const sources = new Map();
  const sourceReport = [];

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

  async function renderAt(i) {
    const tMs = frameTimeMs(i, fps);
    const placement = sceneAt(timeline, tMs);
    const entry = placement.entry;
    for (const [index, source] of sources) {
      if (index !== entry.index) { source.close(); sources.delete(index); }
    }
    if (!sources.has(entry.index)) sources.set(entry.index, await openSource(entry));
    const source = sources.get(entry.index);
    const frame = await source.frameAt((source.startUs || 0) + placement.sourceMs * 1000);
    renderFrame(context, runtime, tMs, new Map([[entry.index, frame]]));
    // آخر إطار من هذا المشهد ⇒ لقطة لانتقال دخول المشهد التالي (إن طلبه).
    const upcoming = i + 1 < frames ? sceneAt(timeline, frameTimeMs(i + 1, fps)).entry : null;
    if (upcoming && upcoming.index !== entry.index && upcoming.scene.transition_in && upcoming.scene.transition_in !== 'none') {
      const copy = document.createElement('canvas'); copy.width = width; copy.height = height;
      copy.getContext('2d').drawImage(canvas, 0, 0);
      snapshots.clear();
      snapshots.set(upcoming.index, copy);
    }
    return canvas;
  }

  function close() {
    for (const source of sources.values()) { try { source.close(); } catch {} }
    sources.clear();
  }

  return { timeline, frames, canvas, context, runtime, sourceReport, renderAt, close };
}

// يكتب بايتات إلى كاتب main على دفعات، بترقيم متتابع.
function createBatchWriter(writer, handle) {
  let seq = 0, batch = [], batchBytes = 0, total = 0;
  const flush = async () => {
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
    batch.push(data); batchBytes += data.length; total += data.length;
    if (batchBytes >= WRITE_BATCH_BYTES) await flush();
  };
  return { push, flush, get total() { return total; } };
}

// options:
//   scenes        مشاهد الـstoryboard وقد أضيف لكلٍّ src (ورابط الأصل)، مع asset/music/voice كمسارات
//   aspect, preset, colors, pointers
//   readAsset(path, offset, length) ⇒ { ok, size, bytes }
//   writer: { begin(kind), chunk(handle, seq, bytes), finish(handle, header), abort(handle) }
//   signal, onProgress({ frame, frames, stage })
export async function exportStoryboard(options) {
  // options.acceleration للاختبار والتشخيص فقط؛ الواجهة لا تمرّرها.
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
  const driver = await createFrameDriver({ ...options, voiceDurations }, { width, height, fps });
  const begun = await writer.begin('mp4');
  if (!begun || !begun.ok) { driver.close(); throw new Error('export_begin_failed:' + (begun && begun.error || 'unknown')); }
  const handle = begun.handle;
  let aborted = false;
  const abort = async () => { if (!aborted) { aborted = true; try { await writer.abort(handle); } catch {} } };

  let encoder = null;
  try {
    let description = null;
    let muxer = null;
    let failure = null;
    let audioIndex = 0, videoSamples = 0;
    let chain = Promise.resolve();
    const out = createBatchWriter(writer, handle);

    // إطارات الصوت التي يبلغها زمن الفيديو تُكتب بعده مباشرة: تشابك يبقي المسارين متجاورين في الملف.
    const interleaveAudio = async (untilUs) => {
      while (audioIndex < audio.chunks.length && audioIndex * AAC_FRAME / AUDIO_SAMPLE_RATE * 1e6 <= untilUs) {
        muxer.addAudioSample({ size: audio.chunks[audioIndex].length, frames: AAC_FRAME });
        await out.push(audio.chunks[audioIndex]);
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
      await out.push(data);
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

    const keyInterval = fps * 2;
    for (let i = 0; i < frames; i += 1) {
      cancelled();
      if (failure) throw failure;
      const canvas = await driver.renderAt(i);
      const videoFrame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      // الضغط الخلفي: لا إطار جديد والمرمّز متخم.
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
    await out.flush();
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
      sources: driver.sourceReport, payload_bytes: out.total, elapsed_ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    await abort();
    throw error;
  } finally {
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch {}
    driver.close();
  }
}

// GIF للمشاركة السريعة: 15 إطاراً/ث، 720p، 15 ثانية على الأكثر، بلا صوت.
export async function exportGif(options) {
  const scenes = Array.isArray(options.scenes) ? options.scenes : [];
  const timeline = buildTimeline({ scenes });
  if (!scenes.length || !timeline.totalMs) throw new Error('bad_storyboard');
  if (timeline.totalMs > GIF_MAX_MS) throw new Error('gif_too_long');
  const base = ASPECT_BASE[options.aspect] || ASPECT_BASE['16:9'];
  const { width, height } = gifSize(base.width, base.height);
  const fps = GIF_MAX_FPS;
  const writer = options.writer;
  const signal = options.signal;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const started = performance.now();
  const driver = await createFrameDriver(options, { width, height, fps, readback: true });
  const begun = await writer.begin('gif');
  if (!begun || !begun.ok) { driver.close(); throw new Error('export_begin_failed:' + (begun && begun.error || 'unknown')); }
  const handle = begun.handle;
  let done = false;
  try {
    const out = createBatchWriter(writer, handle);
    await out.push(gifHeader(width, height));
    for (let i = 0; i < driver.frames; i += 1) {
      if (signal && signal.aborted) throw new Error('render_cancelled');
      const canvas = await driver.renderAt(i);
      const pixels = driver.context.getImageData(0, 0, canvas.width, canvas.height).data;
      await out.push(gifFrame(pixels, width, height, frameDelayCs(i, fps)));
      progress({ frame: i + 1, frames: driver.frames, stage: 'video' });
      // التكميم والضغط يشغلان الخيط؛ تنازل قصير يبقي الواجهة وزر الإلغاء حيّين.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await out.push(GIF_TRAILER);
    await out.flush();
    progress({ frame: driver.frames, frames: driver.frames, stage: 'finalize' });
    const finished = await writer.finish(handle);
    done = true;
    if (!finished || !finished.ok) throw new Error('export_finish_failed:' + (finished && finished.error || 'unknown'));
    return {
      ok: true, engine: 'gif', filename: finished.filename, path: finished.path, bytes: finished.bytes,
      format: { ext: 'gif', container: 'image/gif' }, frames: driver.frames, fps, width, height,
      duration_ms: timeline.totalMs, scenes_rendered: timeline.scenes.length, sources: driver.sourceReport,
      elapsed_ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    if (!done) { try { await writer.abort(handle); } catch {} }
    throw error;
  } finally {
    driver.close();
  }
}

// صورة مصغرة PNG من إطار عند زمن tMs، بمقاس التصدير الكامل. تعيد Uint8Array.
export async function renderThumbnail(options, tMs) {
  const base = ASPECT_BASE[options.aspect] || ASPECT_BASE['16:9'];
  const fps = 30;
  const driver = await createFrameDriver(options, { width: base.width, height: base.height, fps });
  try {
    const index = Math.max(0, Math.min(driver.frames - 1, Math.round(tMs * fps / 1000)));
    const canvas = await driver.renderAt(index);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('thumbnail_failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    driver.close();
  }
}
