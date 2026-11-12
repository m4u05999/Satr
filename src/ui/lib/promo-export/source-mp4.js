/**
 * قارئ مصدر MP4 — وحدة نقية بلا اعتماديات (تعمل في المتصفح وفي node).
 *
 * يقرأ **رؤوس الصناديق ومحتوى `moov`/`moof` فقط**، ويتخطى `mdat` كله: الملف قد يبلغ
 * مئات الميغابايتات والمطلوب فهرس العينات (موضع وحجم ومفتاحية وطابع) لا بياناتها.
 * `readAt` لا يُستدعى أبداً على محتوى `mdat`؛ رأسه (8 أو 16 بايتاً) فقط لمعرفة طوله.
 *
 * يدعم:
 * - MP4 المجزّأ (`mvex/trex` ثم `moof/traf/tfhd/tfdt/trun` بكل أعلامها، و`default-base-is-moof`).
 * - MP4 العادي (`stts/ctts/stss/stsz/stsc/stco/co64`).
 * - استخراج `avcC` بالمشي الصحيح `stsd → avc1|avc3 → avcC` لا بالبحث النصي.
 *
 * العينات تُعاد **بترتيب فك الترميز** (decode order)، و`ptsUs` هو زمن العرض.
 */
import { readBoxHeader, readFourCC, readU64, viewOf, walkBoxes } from './box-reader.js';

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION = 0x000002;
const TFHD_DEFAULT_DURATION = 0x000008;
const TFHD_DEFAULT_SIZE = 0x000010;
const TFHD_DEFAULT_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_DURATION = 0x000100;
const TRUN_SIZE = 0x000200;
const TRUN_FLAGS = 0x000400;
const TRUN_COMPOSITION = 0x000800;
const SAMPLE_NON_SYNC = 0x010000;

/** قارئ يقرأ من مصفوفة بايتات في الذاكرة — للاختبارات وللملفات الصغيرة. */
export function readerFromBytes(bytes) {
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset + length > bytes.length) {
      throw new RangeError(`قراءة خارج الملف: ${offset}+${length} من ${bytes.length}`);
    }
    return bytes.subarray(offset, offset + length);
  };
}

async function readExact(readAt, offset, length) {
  const bytes = await readAt(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new RangeError(`القارئ أعاد ${bytes && bytes.length} بايتاً بدل ${length} عند ${offset}`);
  }
  return bytes;
}

/** يقرأ رأس صندوق من الملف بقراءة الرأس فقط (8 بايتات، و8 إضافية لحجم 64-بت). */
async function readTopHeader(readAt, offset, fileSize) {
  const first = viewOf(await readExact(readAt, offset, 8));
  let size = first.getUint32(0);
  const type = readFourCC(first, 4);
  let header = 8;
  if (size === 1) {
    size = readU64(viewOf(await readExact(readAt, offset + 8, 8)), 0);
    header = 16;
  } else if (size === 0) {
    size = fileSize - offset;
  }
  if (size < header || offset + size > fileSize) throw new RangeError(`صندوق «${type}» عند ${offset} مشوَّه`);
  return { type, start: offset, size, header, bodyStart: offset + header, end: offset + size };
}

function toUs(ticks, timescale) { return Math.round((ticks * 1e6) / timescale); }

function avcCodecString(avcC) {
  if (avcC.length < 4) throw new Error('avcC أقصر من أن يحمل المستوى');
  const hex = (value) => value.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

function readDescriptor(bytes, pos, end) {
  let p = pos;
  const tag = bytes[p++];
  let len = 0;
  for (let i = 0; i < 4; i += 1) {
    const b = bytes[p++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  if (p + len > end) throw new RangeError('وصف esds يتجاوز حاويته');
  return { tag, start: p, end: p + len };
}

/** يستخرج AudioSpecificConfig من esds بالمشي على الأوصاف الفرعية (ES ← DecoderConfig ← DecoderSpecificInfo). */
function parseEsds(bytes) {
  const es = readDescriptor(bytes, 4, bytes.length);
  if (es.tag !== 0x03) throw new Error('esds بلا ES_Descriptor');
  let p = es.start + 2;
  const flags = bytes[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + bytes[p];
  if (flags & 0x20) p += 2;
  let config = null;
  let objectType = 0;
  let info = null;
  while (p < es.end) {
    const d = readDescriptor(bytes, p, es.end);
    if (d.tag === 0x04) {
      objectType = bytes[d.start];
      let q = d.start + 13;
      while (q < d.end) {
        const sub = readDescriptor(bytes, q, d.end);
        if (sub.tag === 0x05) info = bytes.slice(sub.start, sub.end);
        q = sub.end;
      }
      config = d;
    }
    p = d.end;
  }
  if (!config || objectType !== 0x40) throw new Error('esds ليس AAC (objectTypeIndication ≠ 0x40)');
  if (!info || info.length < 2) throw new Error('esds بلا AudioSpecificConfig');
  return info;
}

/** يحوّل جداول stbl إلى عينات بترتيب الفك. */
function samplesFromTables(track) {
  const t = track.tables;
  const count = t.sizes.length;
  const dts = new Array(count);
  let cursor = 0;
  let time = 0;
  for (const [n, delta] of t.stts) {
    for (let k = 0; k < n; k += 1) { dts[cursor++] = { time, dur: delta }; time += delta; }
  }
  if (cursor !== count) throw new Error(`stts يصف ${cursor} عينة و stsz يصف ${count}`);
  const keys = t.stss ? new Set(t.stss) : null;
  const samples = [];
  let sample = 0;
  const chunkOffsets = t.chunkOffsets;
  for (let chunk = 1; chunk <= chunkOffsets.length && sample < count; chunk += 1) {
    let perChunk = 0;
    for (const [first, n] of t.stsc) if (first <= chunk) perChunk = n;
    let offset = chunkOffsets[chunk - 1];
    for (let k = 0; k < perChunk && sample < count; k += 1) {
      const size = t.sizes[sample];
      const { time: d, dur } = dts[sample];
      const cto = t.ctts ? t.ctts[sample] : 0;
      samples.push({
        offset,
        size,
        ptsUs: toUs(d + cto, track.timescale),
        durationUs: toUs(d + dur, track.timescale) - toUs(d, track.timescale),
        key: keys ? keys.has(sample + 1) : true,
      });
      offset += size;
      sample += 1;
    }
  }
  if (samples.length !== count) throw new Error(`stsc/stco يغطّيان ${samples.length} عينة من ${count}`);
  return samples;
}

function parseMoov(bytes, tracks, trexDefaults) {
  const view = viewOf(bytes);
  let current = null;
  walkBoxes(view, 0, bytes.length, (box) => {
    const b = box.bodyStart;
    const t = box.type;
    if (t === 'trak') {
      current = { id: 0, handler: '', timescale: 0, codec: null, width: 0, height: 0, description: null, audioDescription: null,
        tables: { stts: [], ctts: null, stss: null, sizes: [], stsc: [], chunkOffsets: [] } };
      tracks.push(current);
      return;
    }
    if (t === 'trex') {
      const id = view.getUint32(b + 4);
      trexDefaults.set(id, {
        duration: view.getUint32(b + 12), size: view.getUint32(b + 16), flags: view.getUint32(b + 20),
      });
      return;
    }
    if (!current) return;
    if (t === 'tkhd') current.id = view.getUint32(b + (view.getUint8(box.start + box.header) === 1 ? 20 : 12));
    else if (t === 'mdhd') current.timescale = view.getUint32(b + (view.getUint8(box.start + box.header) === 1 ? 20 : 12));
    else if (t === 'hdlr') current.handler = readFourCC(view, b + 8);
    else if (t === 'stsd') parseStsd(view, box, current);
    else if (t === 'stts') {
      const n = view.getUint32(b + 4);
      current.tables.stts = Array.from({ length: n }, (_, i) => [view.getUint32(b + 8 + i * 8), view.getUint32(b + 12 + i * 8)]);
    } else if (t === 'ctts') {
      const version = view.getUint8(b);
      const n = view.getUint32(b + 4);
      const list = [];
      for (let i = 0; i < n; i += 1) {
        const count = view.getUint32(b + 8 + i * 8);
        const off = version === 1 ? view.getInt32(b + 12 + i * 8) : view.getUint32(b + 12 + i * 8);
        for (let k = 0; k < count; k += 1) list.push(off);
      }
      current.tables.ctts = list;
    } else if (t === 'stss') {
      const n = view.getUint32(b + 4);
      current.tables.stss = Array.from({ length: n }, (_, i) => view.getUint32(b + 8 + i * 4));
    } else if (t === 'stsz') {
      const fixed = view.getUint32(b + 4);
      const n = view.getUint32(b + 8);
      current.tables.sizes = fixed ? new Array(n).fill(fixed)
        : Array.from({ length: n }, (_, i) => view.getUint32(b + 12 + i * 4));
    } else if (t === 'stsc') {
      const n = view.getUint32(b + 4);
      current.tables.stsc = Array.from({ length: n }, (_, i) => [view.getUint32(b + 8 + i * 12), view.getUint32(b + 12 + i * 12)]);
    } else if (t === 'stco') {
      const n = view.getUint32(b + 4);
      current.tables.chunkOffsets = Array.from({ length: n }, (_, i) => view.getUint32(b + 8 + i * 4));
    } else if (t === 'co64') {
      const n = view.getUint32(b + 4);
      current.tables.chunkOffsets = Array.from({ length: n }, (_, i) => readU64(view, b + 8 + i * 8));
    }
  });
}

function parseStsd(view, box, track) {
  const entryStart = box.bodyStart + 8;
  const entry = readBoxHeader(view, entryStart, box.end);
  const type = entry.type;
  const eb = entry.bodyStart;
  if (type === 'avc1' || type === 'avc3') {
    track.codec = type;
    track.width = view.getUint16(eb + 24);
    track.height = view.getUint16(eb + 26);
    let p = eb + 78;
    while (p + 8 <= entry.end) {
      const child = readBoxHeader(view, p, entry.end);
      if (child.type === 'avcC') {
        track.description = new Uint8Array(view.buffer, view.byteOffset + child.bodyStart, child.size - child.header).slice();
        break;
      }
      p = child.end;
    }
  } else if (type === 'mp4a') {
    track.codec = type;
    track.channels = view.getUint16(eb + 16);
    track.sampleRate = view.getUint32(eb + 24) / 65536;
    let p = eb + 28;
    while (p + 8 <= entry.end) {
      const child = readBoxHeader(view, p, entry.end);
      if (child.type === 'esds') {
        const body = new Uint8Array(view.buffer, view.byteOffset + child.bodyStart, child.size - child.header);
        track.audioDescription = parseEsds(body);
        break;
      }
      p = child.end;
    }
  } else {
    track.codec = type;
  }
}

function parseTfhd(view, box) {
  const flags = view.getUint32(box.bodyStart) & 0xffffff;
  const id = view.getUint32(box.bodyStart + 4);
  let p = box.bodyStart + 8;
  const fragment = { id, flags, baseDataOffset: null, defaultDuration: null, defaultSize: null, defaultFlags: null };
  if (flags & TFHD_BASE_DATA_OFFSET) { fragment.baseDataOffset = readU64(view, p); p += 8; }
  if (flags & TFHD_SAMPLE_DESCRIPTION) p += 4;
  if (flags & TFHD_DEFAULT_DURATION) { fragment.defaultDuration = view.getUint32(p); p += 4; }
  if (flags & TFHD_DEFAULT_SIZE) { fragment.defaultSize = view.getUint32(p); p += 4; }
  if (flags & TFHD_DEFAULT_FLAGS) { fragment.defaultFlags = view.getUint32(p); p += 4; }
  return fragment;
}

/** يحلّل `moof` ويضيف عيناته إلى المسارات. `moofStart` إزاحة الصندوق في الملف. */
function parseMoof(view, box, moofStart, trackById, trexDefaults) {
  const moofState = { nextBase: moofStart };
  let traf = null;
  walkBoxes(view, box.bodyStart, box.end, (child) => {
    const b = child.bodyStart;
    if (child.type === 'traf') {
      traf = { track: null, fragment: null, base: 0, nextData: null, dts: null, lastEnd: 0 };
      return;
    }
    if (!traf) return;
    if (child.type === 'tfhd') {
      traf.fragment = parseTfhd(view, child);
      traf.track = trackById.get(traf.fragment.id) || null;
      const f = traf.fragment;
      if (f.baseDataOffset !== null) traf.base = f.baseDataOffset;
      else if (f.flags & TFHD_DEFAULT_BASE_IS_MOOF) traf.base = moofStart;
      else traf.base = moofState.nextBase;
      traf.defaults = trexDefaults.get(f.id) || { duration: 0, size: 0, flags: 0 };
    } else if (child.type === 'tfdt') {
      traf.dts = view.getUint8(b) === 1 ? readU64(view, b + 4) : view.getUint32(b + 4);
    } else if (child.type === 'trun' && traf.track && traf.fragment) {
      const version = view.getUint8(b);
      const flags = view.getUint32(b) & 0xffffff;
      const count = view.getUint32(b + 4);
      let p = b + 8;
      let start = traf.nextData ?? traf.base;
      if (flags & TRUN_DATA_OFFSET) { start = traf.base + view.getInt32(p); p += 4; }
      let firstFlags = null;
      if (flags & TRUN_FIRST_SAMPLE_FLAGS) { firstFlags = view.getUint32(p); p += 4; }
      const f = traf.fragment;
      const track = traf.track;
      if (traf.dts === null) traf.dts = track.nextDts || 0;
      let position = start;
      for (let i = 0; i < count; i += 1) {
        let duration = f.defaultDuration ?? traf.defaults.duration;
        let size = f.defaultSize ?? traf.defaults.size;
        let sampleFlags = f.defaultFlags ?? traf.defaults.flags;
        let cto = 0;
        if (flags & TRUN_DURATION) { duration = view.getUint32(p); p += 4; }
        if (flags & TRUN_SIZE) { size = view.getUint32(p); p += 4; }
        if (flags & TRUN_FLAGS) { sampleFlags = view.getUint32(p); p += 4; }
        else if (i === 0 && firstFlags !== null) sampleFlags = firstFlags;
        if (flags & TRUN_COMPOSITION) { cto = version === 1 ? view.getInt32(p) : view.getUint32(p); p += 4; }
        const dts = traf.dts;
        track.samples.push({
          offset: position,
          size,
          ptsUs: toUs(dts + cto, track.timescale),
          durationUs: toUs(dts + duration, track.timescale) - toUs(dts, track.timescale),
          key: !(sampleFlags & SAMPLE_NON_SYNC),
        });
        position += size;
        traf.dts += duration;
      }
      traf.nextData = position;
      moofState.nextBase = position;
      track.nextDts = traf.dts;
    }
  });
}

/** يبحث في فترات mdat المرتبة عن الفترة التي تحوي [offset, offset+size). */
function insideAnyMdat(ranges, offset, size) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return offset + size <= r.end;
  }
  return false;
}

/**
 * يقرأ فهرس MP4 من `readAt(offset, length)` بحجم ملف `fileSize`.
 * @returns {Promise<{fragmented:boolean, video:object, audio:object|null}>}
 */
export async function parseMp4(readAt, fileSize) {
  const top = [];
  let offset = 0;
  while (offset < fileSize) {
    const box = await readTopHeader(readAt, offset, fileSize);
    top.push(box);
    offset = box.end;
  }
  if (offset !== fileSize) throw new Error('صناديق الملف لا تنتهي عند حجمه');

  const moovBox = top.find((box) => box.type === 'moov');
  if (!moovBox) throw new Error('لا يوجد صندوق moov في الملف');
  const moovBody = await readExact(readAt, moovBox.bodyStart, moovBox.end - moovBox.bodyStart);
  const tracks = [];
  const trexDefaults = new Map();
  parseMoov(moovBody, tracks, trexDefaults);

  const trackById = new Map(tracks.map((track) => [track.id, track]));
  for (const track of tracks) track.samples = [];
  const moofs = top.filter((box) => box.type === 'moof');
  for (const box of moofs) {
    // الجسم يُقرأ وحده ويُمشى بإزاحاته النسبية؛ كل إزاحة بيانات تُحسب مطلقةً من موضع الصندوق في الملف.
    const body = await readExact(readAt, box.bodyStart, box.end - box.bodyStart);
    parseMoof(viewOf(body), { bodyStart: 0, end: body.length }, box.start, trackById, trexDefaults);
  }

  const fragmented = moofs.length > 0;
  if (!fragmented) {
    for (const track of tracks) {
      if (track.handler === 'vide' || track.handler === 'soun') track.samples = samplesFromTables(track);
    }
  }

  const mdatRanges = top.filter((box) => box.type === 'mdat')
    .map((box) => ({ start: box.bodyStart, end: box.end }))
    .sort((a, b) => a.start - b.start);
  const finish = (track) => {
    for (const s of track.samples) {
      if (!insideAnyMdat(mdatRanges, s.offset, s.size)) {
        throw new RangeError(`عينة عند ${s.offset} خارج صناديق mdat`);
      }
    }
    return track.samples;
  };

  const videoTrack = tracks.find((track) => track.handler === 'vide');
  if (!videoTrack) throw new Error('لا يوجد مسار فيديو في الملف');
  if (videoTrack.codec !== 'avc1' && videoTrack.codec !== 'avc3') {
    throw new Error(`الفيديو ليس H.264 (${videoTrack.codec}) — لا يدعمه المصدر بعد`);
  }
  if (!videoTrack.description) throw new Error('avcC غائب من مسار الفيديو');
  const audioTrack = tracks.find((track) => track.handler === 'soun') || null;
  if (audioTrack && audioTrack.codec !== 'mp4a') throw new Error(`الصوت ليس AAC (${audioTrack.codec})`);

  return {
    fragmented,
    video: {
      codec: avcCodecString(videoTrack.description),
      description: videoTrack.description,
      width: videoTrack.width,
      height: videoTrack.height,
      timescale: videoTrack.timescale,
      samples: finish(videoTrack),
    },
    audio: audioTrack ? {
      codec: `mp4a.40.${audioTrack.audioDescription[0] >> 3}`,
      description: audioTrack.audioDescription,
      sampleRate: audioTrack.sampleRate,
      channels: audioTrack.channels,
      timescale: audioTrack.timescale,
      samples: finish(audioTrack),
    } : null,
  };
}
