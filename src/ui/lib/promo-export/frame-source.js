// مصدر إطارات الفيديو للتصدير إطاراً بإطار.
//
// المسار الأساسي: فهرس العينات من source-mp4.js + VideoDecoder يفك بتتابع من آخر إطار مفتاحي.
// المسبار (الدفعة 0) قاس 370–720 إطاراً/ث بهذا المسار مقابل 126–140ms للإطار بالقفز.
// البديل: عنصر <video> مع currentTime + seeked — أبطأ، لكنه يعمل مع أي حاوية يشغّلها المتصفح.
//
// اختيار الإطار بطابع العرض ptsUs لا بجمع المدد: المقاطع بمعدل إطارات متغيّر، وفيها فجوات
// بين القطع (مقيس: 52 نبضة في مقطع المسبار).

import { parseMp4 } from './source-mp4.js';

const READ_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4;
// أقصى عدد عينات داخل المفكِّك بلا خرج. المفكِّك العتادي يملك مخزن إطارات محدوداً: تغذيته بلا
// حد وإطاراته غير مغلقة تعلّقه إلى الأبد (وقع فعلاً على مقطع 1920×1040 في اختبار الدفعة 5).
const MAX_IN_FLIGHT = 16;
const FEED_BATCH = 4;
const MAX_AHEAD_ON_FLUSH = 3;
const DECODE_TIMEOUT_MS = 8000;
// تسامح نصف ميلي ثانية في مطابقة الطابع: طوابع الحاوية نبضات صحيحة، فتحويلها إلى ميكروثانية
// قد يزيد على الزمن المطلوب بكسر نبضة، وبلا تسامح يُختار الإطار السابق (وقع في اختبار الدفعة 5).
const PTS_TOLERANCE_US = 500;

// readAt: async (offset, length) ⇒ Uint8Array. fileSize بالبايت.
// يعيد { mode: 'decoder', width, height, durationUs, frameCount, frameAt(timeUs), close() }.
export async function createDecoderSource(readAt, fileSize) {
  if (typeof VideoDecoder !== 'function') throw new Error('decoder_unavailable');
  const parsed = await parseMp4(readAt, fileSize);
  const track = parsed && parsed.video;
  if (!track || !track.samples.length || !track.description) throw new Error('no_video_track');
  const samples = track.samples;
  if (!samples[0].key) throw new Error('first_sample_not_key');
  // لا إطارات B في خرج MediaRecorder ولا في خرج مرمّزنا (مقيس). إن وُجد ترتيب عرض مخالف
  // لترتيب الفك نرفض هنا فيسقط المستدعي إلى البديل، بدل اختيار إطار خاطئ بصمت.
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].ptsUs <= samples[i - 1].ptsUs) throw new Error('reordered_frames');
  }
  const config = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support || !support.supported) throw new Error('decoder_unsupported');

  let frames = [];       // إطارات مفكوكة بانتظار الاستعمال، مرتبة زمنياً
  let current = null;    // الإطار المعروض حالياً (يملكه المصدر؛ المستدعي لا يغلقه)
  let next = 0;          // فهرس العينة التالية للتغذية
  let flushed = false;   // استُدعي flush على هذا المفكِّك
  let dropped = false;   // أُسقطت إطارات أثناء flush؛ قد يلزم إعادة الفك من المفتاحي
  let targetUs = -Infinity;
  let failure = null;
  let wake = null;
  let closed = false;
  let fed = 0, received = 0; // عدّادا الضغط الخلفي
  let decoder = null;

  const signal = () => { if (wake) { const resolve = wake; wake = null; resolve(); } };
  const closeFrame = (frame) => { try { frame.close(); } catch {} };
  // إطارات تجاوزها الهدف تُغلق فوراً: يبقى آخر إطار طابعه ≤ الهدف وما بعده.
  const prune = () => {
    while (frames.length >= 2 && frames[1].timestamp <= targetUs) closeFrame(frames.shift());
  };
  const start = () => {
    decoder = new VideoDecoder({
      output: (frame) => {
        received += 1;
        if (closed) { closeFrame(frame); return; }
        frames.push(frame);
        prune();
        // flush يُخرج كل ما بقي دفعة واحدة. مخزن إطارات المفكِّك العتادي محدود، واحتجازها كلها
        // يعلّق flush إلى الأبد (وقع فعلاً على مقطع 1920×1040). نبقي ما يكفي للإجابة ونُسقط
        // الباقي؛ إن طُلب لاحقاً أُعيد الفك من آخر إطار مفتاحي.
        if (flushed) {
          let ahead = 0;
          for (const item of frames) if (item.timestamp > targetUs) ahead += 1;
          while (ahead > MAX_AHEAD_ON_FLUSH) { closeFrame(frames.pop()); ahead -= 1; dropped = true; }
        }
        signal();
      },
      error: (error) => { failure = error || new Error('decode_error'); signal(); },
    });
    decoder.configure(config);
  };
  const dropFrames = () => {
    for (const frame of frames) closeFrame(frame);
    frames = [];
    if (current) { closeFrame(current); current = null; }
  };
  // آخر إطار مفتاحي طابعه ≤ الزمن المطلوب.
  const keyBefore = (timeUs) => {
    let key = 0;
    for (let i = 0; i < samples.length && samples[i].ptsUs <= timeUs; i += 1) if (samples[i].key) key = i;
    return key;
  };
  const restart = (timeUs) => {
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch {}
    dropFrames();
    flushed = false; dropped = false;
    fed = 0; received = 0;
    next = keyBefore(timeUs);
    start();
  };
  // يغذّي دفعة عينات متجاورة بقراءة واحدة من القرص.
  const feed = async () => {
    const first = next;
    let end = first, bytes = 0;
    while (end < samples.length && end - first < FEED_BATCH && bytes + samples[end].size <= READ_BATCH_BYTES
      && (end === first || samples[end].offset === samples[end - 1].offset + samples[end - 1].size)) {
      bytes += samples[end].size; end += 1;
    }
    if (end === first) { bytes = samples[first].size; end = first + 1; }
    const base = samples[first].offset;
    const data = await readAt(base, bytes);
    if (!data || data.byteLength < bytes) throw new Error('short_read');
    for (let i = first; i < end; i += 1) {
      const sample = samples[i];
      decoder.decode(new EncodedVideoChunk({
        type: sample.key ? 'key' : 'delta', timestamp: sample.ptsUs, duration: sample.durationUs,
        data: data.subarray(sample.offset - base, sample.offset - base + sample.size),
      }));
    }
    fed += end - first;
    next = end;
  };
  // تنازل لحلقة الأحداث كي تصل نداءات الخرج قبل تغذية جديدة.
  // MessageChannel لا setTimeout: المؤقتات المتداخلة تُقيَّد بـ4ms فتحدّ التتابع عند ~90 إطاراً/ث.
  const channel = new MessageChannel();
  const tick = () => new Promise((resolve) => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
  const waitOutput = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { wake = null; reject(new Error('decode_timeout')); }, DECODE_TIMEOUT_MS);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const answered = () => frames.length > 0 && frames[frames.length - 1].timestamp > targetUs;

  start();
  const last = samples[samples.length - 1];

  async function frameAt(timeUs) {
    if (closed) throw new Error('source_closed');
    const target = Math.max(samples[0].ptsUs, Math.round(timeUs) + PTS_TOLERANCE_US);
    targetUs = target;
    const newest = frames.length ? frames[frames.length - 1].timestamp : current ? current.timestamp : -Infinity;
    if (current && target < current.timestamp) restart(target);                      // رجوع في الزمن
    else if (keyBefore(target) > next) restart(target);                              // قفزة فوق إطار مفتاحي لم نبلغه
    else if ((flushed || dropped) && !answered() && newest < last.ptsUs) restart(target); // ما بعد flush أُسقط
    // نحتاج إطاراً طابعه > الهدف كي نعرف أن ما قبله هو الصحيح، أو أن ينتهي الملف.
    for (;;) {
      if (failure) throw failure;
      prune();
      if (answered()) break;
      if (next >= samples.length) {
        if (flushed) break;
        flushed = true;
        await decoder.flush();
        continue;
      }
      let ahead = 0;
      for (const item of frames) if (item.timestamp > target) ahead += 1;
      if (ahead < MAX_QUEUED_FRAMES && fed - received < MAX_IN_FLIGHT) { await feed(); await tick(); continue; }
      await waitOutput();
    }
    // آخر إطار طابعه ≤ الهدف؛ ما قبله يُغلق.
    let pick = -1;
    for (let i = 0; i < frames.length && frames[i].timestamp <= target; i += 1) pick = i;
    if (pick >= 0) {
      if (current) closeFrame(current);
      for (let i = 0; i < pick; i += 1) closeFrame(frames[i]);
      current = frames[pick];
      frames = frames.slice(pick + 1);
    } else if (!current && frames.length) {
      // الهدف قبل أول إطار مفكوك (لا يقع عادةً): نعرض أول المتاح.
      current = frames.shift();
    }
    if (!current) throw new Error('no_frame');
    return { source: current, width: current.displayWidth, height: current.displayHeight, timestampUs: current.timestamp };
  }

  function close() {
    closed = true;
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch {}
    dropFrames();
    signal();
  }

  return {
    mode: 'decoder', width: track.width, height: track.height, frameCount: samples.length,
    durationUs: last.ptsUs + last.durationUs - samples[0].ptsUs, startUs: samples[0].ptsUs,
    frameAt, close,
  };
}

// البديل: القفز داخل عنصر <video>. لا يُستعمل requestVideoFrameCallback بعد seeked؛ قد لا يُستدعى
// حين يكون الإطار المطلوب معروضاً أصلاً.
export async function createSeekSource(url) {
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.playsInline = true;
  const once = (name, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + '_timeout')), ms);
    video.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video_failed')); }, { once: true });
  });
  video.src = url;
  video.load();
  if (video.readyState < 2) await once('loadeddata', 15000);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  let lastTime = -1;
  async function frameAt(timeUs) {
    const wanted = Math.max(0, timeUs / 1e6);
    const time = duration > 0 ? Math.min(wanted, Math.max(0, duration - 0.04)) : wanted;
    if (Math.abs(time - lastTime) > 1e-4) {
      video.currentTime = time;
      await once('seeked', 8000);
      lastTime = time;
    }
    return { source: video, width: video.videoWidth, height: video.videoHeight, timestampUs: Math.round(time * 1e6) };
  }
  function close() { try { video.pause(); } catch {} video.removeAttribute('src'); video.load(); }
  return { mode: 'seek', width: video.videoWidth, height: video.videoHeight, frameCount: 0, durationUs: Math.round(duration * 1e6), startUs: 0, frameAt, close };
}

// يفتح مصدر فيديو: المفكِّك أولاً، والقفز إن تعذّر. fallbackReason يشرح السبب للواجهة والتقرير.
export async function openVideoSource(options) {
  const { url, readAt, fileSize } = options;
  let reason = '';
  if (typeof readAt === 'function' && fileSize > 0) {
    try {
      const source = await createDecoderSource(readAt, fileSize);
      // إطار أول فعلي يثبت أن المفكِّك يعمل، لا أن التهيئة قُبلت فقط (درس الدفعة 0).
      await source.frameAt(source.startUs);
      return source;
    } catch (error) { reason = String(error && error.message || error); }
  } else reason = 'no_reader';
  const source = await createSeekSource(url);
  source.fallbackReason = reason;
  return source;
}
