/**
 * مُغلِّف MP4 مكتوب يدوياً — وحدة نقية بلا اعتماديات (تعمل في المتصفح وفي node).
 *
 * **العقد الأهم:** المُغلِّف **لا يستلم بيانات العينات ولا يحتفظ بها**. المستدعي يكتب
 * بايتات كل عينة إلى القرص بترتيب استدعاءات `add*` نفسه، والمُغلِّف يتتبّع الموضع
 * التراكمي داخل `mdat` فقط. الملف النهائي = خرج `finalize()` ثم الحمولة بالترتيب.
 *
 * البنية: `ftyp` ← `moov` ← رأس `mdat`، والحمولة بعده (faststart).
 * التشابك: كل تبدّل بين المسارين يفتح قطعة (chunk) جديدة؛ العينات المتتالية من مسار
 * واحد تُجمع في قطعة واحدة في `stsc`. ترتيب الاستدعاءات هو الذي يحدد التشابك.
 *
 * القيود المُصرَّح بها:
 * - لا `ctts` ولا `edts`: ترتيب الفيديو يجب أن يكون ترتيب العرض نفسه، ويُرفض ما عداه.
 * - الزمن النسبي يبدأ من أول عينة فيديو (فك الترميز يبدأ عند 0 بتعريف MP4).
 * - الحد 2 ج.ب للحمولة لأن إزاحات `stco` 32-بت.
 */

const MAX_PAYLOAD = 2 * 1024 ** 3;
const MOVIE_TIMESCALE = 1000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;
const DEFAULT_AUDIO_FRAMES = 1024;
const DEFAULT_AUDIO_BITRATE = 128000;
const enc = new TextEncoder();

// ───────────────────────── أدوات الترميز الثنائي (big-endian) ─────────────────────────

function cat(...parts) {
  const flat = [];
  for (const part of parts) {
    if (Array.isArray(part)) flat.push(...part);
    else flat.push(part);
  }
  let total = 0;
  for (const part of flat) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of flat) { out.set(part, offset); offset += part.length; }
  return out;
}

function u8(...values) { return Uint8Array.from(values); }

function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value));
  return out;
}

function i16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value));
  return out;
}

function u32(...values) { return u32list(values); }

function u32list(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0));
  return out;
}

function fourcc(text) { return enc.encode(text); }

function cstr(text) { return cat(enc.encode(text), u8(0)); }

function box(type, ...parts) {
  const body = cat(...parts);
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set(fourcc(type), 4);
  out.set(body, 8);
  return out;
}

function fullBox(type, version, flags, ...parts) {
  return box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...parts);
}

/** وصف MPEG-4 (esds): طول متغيّر على أربعة بايتات دائماً — صالح بحسب المواصفة. */
function descriptor(tag, body) {
  const len = body.length;
  if (len >= 0x10000000) throw new RangeError('وصف أكبر من طاقة الترميز المتغيّر');
  return cat(u8(tag, 0x80 | ((len >>> 21) & 0x7f), 0x80 | ((len >>> 14) & 0x7f),
    0x80 | ((len >>> 7) & 0x7f), len & 0x7f), body);
}

const IDENTITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

// ───────────────────────── التحقق من الإعدادات ─────────────────────────

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} يجب أن يكون عدداً صحيحاً موجباً`);
  return value;
}

function finiteNonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} يجب أن يكون رقماً منتهياً غير سالب`);
  }
  return value;
}

function bytesOf(value, label) {
  if (!(value instanceof Uint8Array) || value.length === 0) throw new TypeError(`${label} يجب أن يكون Uint8Array غير فارغ`);
  return value;
}

/** مدة عينات بمقياس زمني: تقريب الطابع التراكمي إلى نبضة، لا تقريب كل مدة منفردة. */
function tickOf(us, timescale) { return Math.round((us * timescale) / 1e6); }

// ───────────────────────── تخطيط الصناديق ─────────────────────────

function avcCBox(description) { return box('avcC', description); }

function colrBox() { return box('colr', fourcc('nclx'), u16(1, 1, 1), u8(0)); }

function videoSampleEntry(video) {
  return box('avc1',
    u8(0, 0, 0, 0, 0, 0), u16(1),
    u16(0), u16(0), u32(0, 0, 0),
    u16(video.width), u16(video.height),
    u32(0x00480000), u32(0x00480000), u32(0),
    u16(1), new Uint8Array(32), u16(0x0018), i16(-1),
    avcCBox(video.description), colrBox());
}

/** AudioSpecificConfig داخل DecoderSpecificInfo، وبقية حقول esds كما في المواصفة. */
function esdsBox(audio) {
  const decoderConfig = descriptor(0x04, cat(
    u8(0x40), u8(0x15), u8(0, 0, 0),
    u32(audio.bitrate, audio.bitrate),
    descriptor(0x05, audio.description),
  ));
  const esDescriptor = descriptor(0x03, cat(u16(AUDIO_TRACK_ID), u8(0), decoderConfig, descriptor(0x06, u8(2))));
  return fullBox('esds', 0, 0, esDescriptor);
}

function audioSampleEntry(audio) {
  return box('mp4a',
    u8(0, 0, 0, 0, 0, 0), u16(1),
    u32(0, 0),
    u16(audio.channels), u16(16), u16(0), u16(0),
    u32((audio.sampleRate * 65536) >>> 0),
    esdsBox(audio));
}

/** جداول العينات لمسار واحد بعد التخطيط، مع القطع وإزاحاتها داخل الحمولة. */
function trackTables(track, chunks, name) {
  const samples = track.samples;
  const durations = track.durations;
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0] += 1;
    else runs.push([1, d]);
  }
  const keyframes = [];
  if (name === 'video') samples.forEach((s, i) => { if (s.key) keyframes.push(i + 1); });

  const ownChunks = chunks.filter((c) => c.track === name);
  const stscEntries = [];
  ownChunks.forEach((chunk, index) => {
    const last = stscEntries[stscEntries.length - 1];
    if (last && last[1] === chunk.count) return;
    stscEntries.push([index + 1, chunk.count]);
  });
  return {
    sttsRuns: runs,
    keyframes,
    sizes: samples.map((s) => s.size),
    stscEntries,
    chunkPositions: ownChunks.map((c) => c.offset),
    totalTicks: durations.reduce((sum, d) => sum + d, 0),
  };
}

function trakBox({ trackId, timescale, tables, movieDuration, kind, sampleEntry, dataBase }) {
  const isVideo = kind === 'video';
  const tkhd = fullBox('tkhd', 0, 3,
    u32(0, 0, trackId, 0, movieDuration), u32(0, 0),
    u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0),
    IDENTITY_MATRIX,
    u32((isVideo ? sampleEntry.width * 65536 : 0), (isVideo ? sampleEntry.height * 65536 : 0)));
  const mdhd = fullBox('mdhd', 0, 0, u32(0, 0, timescale, tables.totalTicks), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc(isVideo ? 'vide' : 'soun'), u32(0, 0, 0),
    cstr(isVideo ? 'VideoHandler' : 'SoundHandler'));
  const mediaHeader = isVideo ? fullBox('vmhd', 0, 1, u16(0), u16(0, 0, 0)) : fullBox('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stsd = fullBox('stsd', 0, 0, u32(1), sampleEntry.box);
  const stts = fullBox('stts', 0, 0, u32(tables.sttsRuns.length), u32list(tables.sttsRuns.flat()));
  const stss = isVideo ? fullBox('stss', 0, 0, u32(tables.keyframes.length), u32list(tables.keyframes)) : null;
  const stsc = fullBox('stsc', 0, 0, u32(tables.stscEntries.length),
    u32list(tables.stscEntries.flatMap(([first, perChunk]) => [first, perChunk, 1])));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(tables.sizes.length), u32list(tables.sizes));
  const stco = fullBox('stco', 0, 0, u32(tables.chunkPositions.length),
    u32list(tables.chunkPositions.map((position) => dataBase + position)));
  const stbl = box('stbl', stsd, stts, stss || new Uint8Array(0), stsc, stsz, stco);
  const minf = box('minf', mediaHeader, dinf, stbl);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}

// ───────────────────────── المُغلِّف ─────────────────────────

/**
 * ينشئ مُغلِّفاً لملف MP4 واحد.
 * @param {{video:object, audio?:object|null}} config
 */
export function createMp4Muxer({ video, audio = null } = {}) {
  if (!video) throw new TypeError('إعدادات الفيديو مطلوبة');
  const videoConfig = {
    width: positiveInt(video.width, 'عرض الفيديو'),
    height: positiveInt(video.height, 'ارتفاع الفيديو'),
    description: bytesOf(video.description, 'وصف avcC'),
    timescale: positiveInt(video.timescale ?? 30000, 'مقياس الفيديو الزمني'),
  };
  const audioConfig = audio ? {
    sampleRate: positiveInt(audio.sampleRate ?? 48000, 'معدل عينات الصوت'),
    channels: positiveInt(audio.channels ?? 2, 'عدد قنوات الصوت'),
    description: bytesOf(audio.description, 'AudioSpecificConfig'),
    bitrate: positiveInt(audio.bitrate ?? DEFAULT_AUDIO_BITRATE, 'معدل بت الصوت'),
  } : null;

  const videoSamples = [];
  const audioSamples = [];
  const chunks = [];
  let payload = 0;
  let finalized = false;

  function reserve(track, size) {
    if (finalized) throw new Error('المُغلِّف أُنهي بالفعل؛ لا يُضاف بعد finalize()');
    positiveInt(size, 'حجم العينة');
    if (payload + size > MAX_PAYLOAD) throw new RangeError('تجاوزت الحمولة 2 ج.ب (إزاحات stco 32-بت)');
    const last = chunks[chunks.length - 1];
    const offset = payload;
    if (!last || last.track !== track) chunks.push({ track, offset, count: 1 });
    else last.count += 1;
    payload += size;
    return offset;
  }

  return {
    /** يُستدعى بالترتيب الذي تُكتب به بايتات الفيديو إلى القرص. */
    addVideoSample({ size, timestampUs, durationUs, key }) {
      if (finalized) throw new Error('المُغلِّف أُنهي بالفعل؛ لا يُضاف بعد finalize()');
      const ts = finiteNonNegative(timestampUs, 'timestampUs');
      const dur = finiteNonNegative(durationUs, 'durationUs');
      if (dur <= 0) throw new RangeError('durationUs يجب أن تكون موجبة');
      if (typeof key !== 'boolean') throw new TypeError('key يجب أن يكون منطقياً');
      const previous = videoSamples[videoSamples.length - 1];
      if (!previous && !key) throw new Error('أول عينة فيديو يجب أن تكون مفتاحية');
      if (previous && ts <= previous.timestampUs) {
        throw new RangeError(`طابع الفيديو ${ts} ليس أكبر من سابقه ${previous.timestampUs}`);
      }
      const tick = tickOf(ts, videoConfig.timescale);
      if (previous && tick <= previous.tick) {
        throw new RangeError(`طابعان متقاربان أقل من نبضة زمنية عند ${ts}`);
      }
      const offset = reserve('video', size);
      videoSamples.push({ size, timestampUs: ts, durationUs: dur, key, tick });
      return { offset };
    },

    /** عينة صوت = إطار AAC واحد (1024 عينة افتراضياً). */
    addAudioSample({ size, frames = DEFAULT_AUDIO_FRAMES }) {
      if (!audioConfig) throw new Error('لم يُهيَّأ مسار صوت في هذا المُغلِّف');
      positiveInt(frames, 'عدد إطارات العينة');
      const offset = reserve('audio', size);
      audioSamples.push({ size, frames });
      return { offset };
    },

    /** أرقام تشخيصية فقط؛ لا تستعمل للتحكم في التدفق. */
    stats() {
      return { videoSamples: videoSamples.length, audioSamples: audioSamples.length, payloadBytes: payload };
    },

    /**
     * يعيد `ftyp + moov + رأس mdat`. الحساب على مرحلتين: حجم `moov` لا يعتمد على قيم
     * الإزاحات (عدد عناصر `stco` ثابت)، فيُبنى مرة لقياس الطول ثم مرة بالإزاحات الحقيقية.
     */
    finalize() {
      if (finalized) throw new Error('finalize() استُدعيت مرتين');
      if (videoSamples.length === 0) throw new Error('لا عينات فيديو: ملف MP4 بلا فيديو غير مقبول هنا');
      if (audioConfig && audioSamples.length === 0) throw new Error('هُيِّئ مسار صوت بلا عينات');
      finalized = true;

      // مدد الفيديو: فرق الطوابع المقرّبة إلى نبضات؛ الأخيرة من durationUs الخاصة بها.
      const last = videoSamples[videoSamples.length - 1];
      const endTick = Math.max(last.tick + 1, tickOf(last.timestampUs + last.durationUs, videoConfig.timescale));
      const videoDurations = videoSamples.map((s, i) => (
        i + 1 < videoSamples.length ? videoSamples[i + 1].tick - s.tick : endTick - s.tick
      ));
      const audioDurations = audioSamples.map((s) => s.frames);

      const tables = {
        video: trackTables({ samples: videoSamples, durations: videoDurations }, chunks, 'video'),
        audio: audioConfig ? trackTables({ samples: audioSamples, durations: audioDurations }, chunks, 'audio') : null,
      };
      const movieDurations = [{ ticks: tables.video.totalTicks, scale: videoConfig.timescale }];
      if (audioConfig) movieDurations.push({ ticks: tables.audio.totalTicks, scale: audioConfig.sampleRate });
      const movieDuration = Math.max(...movieDurations.map((d) => Math.round((d.ticks * MOVIE_TIMESCALE) / d.scale)));
      const nextTrackId = audioConfig ? AUDIO_TRACK_ID + 1 : VIDEO_TRACK_ID + 1;

      const ftyp = box('ftyp', fourcc('isom'), u32(512), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));

      const buildMoov = (dataBase) => {
        const traks = [trakBox({
          trackId: VIDEO_TRACK_ID, timescale: videoConfig.timescale, tables: tables.video,
          movieDuration: Math.round((tables.video.totalTicks * MOVIE_TIMESCALE) / videoConfig.timescale),
          kind: 'video', sampleEntry: { box: videoSampleEntry(videoConfig), width: videoConfig.width, height: videoConfig.height },
          dataBase,
        })];
        if (audioConfig) {
          traks.push(trakBox({
            trackId: AUDIO_TRACK_ID, timescale: audioConfig.sampleRate, tables: tables.audio,
            movieDuration: Math.round((tables.audio.totalTicks * MOVIE_TIMESCALE) / audioConfig.sampleRate),
            kind: 'audio', sampleEntry: { box: audioSampleEntry(audioConfig) }, dataBase,
          }));
        }
        const mvhd = fullBox('mvhd', 0, 0,
          u32(0, 0, MOVIE_TIMESCALE, movieDuration),
          u32(0x00010000), u16(0x0100), u16(0), u32(0, 0),
          IDENTITY_MATRIX, u32(0, 0, 0, 0, 0, 0), u32(nextTrackId));
        return box('moov', mvhd, ...traks);
      };

      const probe = buildMoov(0);
      const dataBase = ftyp.length + probe.length + 8;
      if (dataBase + payload > 0xffffffff) throw new RangeError('إزاحات stco تتجاوز 32-بت');
      const moov = buildMoov(dataBase);
      if (moov.length !== probe.length) throw new Error('حجم moov تغيّر بين المرحلتين');
      const mdatHeader = u32(8 + payload);
      return cat(ftyp, moov, mdatHeader, fourcc('mdat'));
    },
  };
}
