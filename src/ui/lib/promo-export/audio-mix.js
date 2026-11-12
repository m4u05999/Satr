// مزج صوت الإعلان بلا زمن حقيقي: OfflineAudioContext بطول الإعلان، ثم ترميز AAC.
// نفس دلالة المسار القديم: صوت المقطع من بداية القص، والموسيقى والتعليق من أولهما، وكلٌّ
// يقف عند نهاية مشهده.

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 192000;
export const AAC_FRAME = 1024;
const EDGE_FADE_S = 0.02;     // تلاشٍ قصير عند حواف كل مقطع يمنع الطقطقة
const END_FADE_S = 0.25;      // تلاشي نهاية الإعلان
const MAX_DECODE_BYTES = 256 * 1024 * 1024;
const READ_STEP = 8 * 1024 * 1024;

// يقرأ ملفاً كاملاً عبر قناة القراءة على دفعات. يعيد null إن تجاوز السقف أو فشل.
export async function readWholeAsset(readAsset, assetPath, maxBytes = MAX_DECODE_BYTES) {
  const head = await readAsset(assetPath, 0, 0);
  if (!head || !head.ok || !(head.size > 0) || head.size > maxBytes) return null;
  const bytes = new Uint8Array(head.size);
  for (let offset = 0; offset < head.size; offset += READ_STEP) {
    const part = await readAsset(assetPath, offset, Math.min(READ_STEP, head.size - offset));
    if (!part || !part.ok || !part.bytes) return null;
    bytes.set(part.bytes instanceof Uint8Array ? part.bytes : new Uint8Array(part.bytes), offset);
  }
  return bytes;
}

// يفك ملف صوت أو مسار الصوت في ملف فيديو. يعيد AudioBuffer أو null (ملف بلا صوت ليس خطأ).
export async function decodeAudioAsset(readAsset, assetPath) {
  const bytes = await readWholeAsset(readAsset, assetPath);
  if (!bytes) return null;
  const context = new OfflineAudioContext(AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_RATE);
  try { return await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); } catch { return null; }
}

// tracks: [{ buffer, startMs, offsetMs, durationMs, volume }]. يعيد AudioBuffer بطول totalMs.
export async function mixTracks(tracks, totalMs) {
  const frames = Math.max(1, Math.ceil(totalMs / 1000 * AUDIO_SAMPLE_RATE));
  const context = new OfflineAudioContext(AUDIO_CHANNELS, frames, AUDIO_SAMPLE_RATE);
  const master = context.createGain();
  const total = totalMs / 1000;
  master.gain.setValueAtTime(1, 0);
  if (total > END_FADE_S * 2) {
    master.gain.setValueAtTime(1, total - END_FADE_S);
    master.gain.linearRampToValueAtTime(0, total);
  }
  master.connect(context.destination);
  for (const track of tracks) {
    if (!track || !track.buffer || !(track.volume > 0)) continue;
    const start = Math.max(0, track.startMs / 1000);
    const offset = Math.max(0, (track.offsetMs || 0) / 1000);
    const available = track.buffer.duration - offset;
    const duration = Math.min(track.durationMs / 1000, available);
    if (!(duration > 0.01)) continue;
    const source = context.createBufferSource();
    source.buffer = track.buffer;
    const gain = context.createGain();
    const fade = Math.min(EDGE_FADE_S, duration / 4);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(track.volume, start + fade);
    gain.gain.setValueAtTime(track.volume, start + duration - fade);
    gain.gain.linearRampToValueAtTime(0, start + duration);
    source.connect(gain).connect(master);
    source.start(start, offset, duration);
  }
  return context.startRendering();
}

// يرمّز AudioBuffer إلى AAC-LC. يعيد { chunks: [Uint8Array], description, frames }.
export async function encodeAac(buffer) {
  const chunks = [];
  let description = null, failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) {
        const raw = meta.decoderConfig.description;
        description = new Uint8Array(raw.buffer ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
    },
    error: (error) => { failure = error || new Error('audio_encode_error'); },
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE });
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const block = AAC_FRAME * 8;
  for (let start = 0; start < buffer.length && !failure; start += block) {
    const count = Math.min(block, buffer.length - start);
    const data = new Float32Array(count * 2);
    data.set(left.subarray(start, start + count), 0);
    data.set(right.subarray(start, start + count), count);
    const frame = new AudioData({
      format: 'f32-planar', sampleRate: AUDIO_SAMPLE_RATE, numberOfFrames: count, numberOfChannels: AUDIO_CHANNELS,
      timestamp: Math.round(start * 1e6 / AUDIO_SAMPLE_RATE), data,
    });
    encoder.encode(frame);
    frame.close();
    // الترميز أسرع من الزمن الحقيقي بكثير؛ نتنازل دورياً كي لا تتجمد الواجهة.
    if (encoder.encodeQueueSize > 8) await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!description || !chunks.length) throw new Error('audio_encode_empty');
  return { chunks, description, frames: buffer.length };
}
