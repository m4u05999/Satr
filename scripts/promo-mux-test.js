#!/usr/bin/env node
'use strict';
// اختبار مُغلِّف MP4 (mp4-mux.js) ومعه قارئ الصناديق ومحلّل المصدر.
// الفكرة: نبني ملفاً من عينات وهمية لكل منها بصمة بايتات فريدة، ثم نتحقق أن كل إزاحة
// مشتقة من stco+stsc+stsz تشير إلى بايتات العينة نفسها، لا إلى مكان قريب منها.
// الوحدات تُنسخ إلى مجلد مؤقت بـ package.json «module» (كما يفعل conversation-history-test).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '../src/ui/lib/promo-export');
const FILES = ['box-reader.js', 'mp4-mux.js', 'source-mp4.js'];
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }
function same(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
function throwsWith(fn, pattern, message) {
  assert.throws(fn, (error) => pattern.test(error.message), message);
  checks += 1;
}

const VIDEO_FRAMES = 90;
const FPS = 30;
const AUDIO_FRAMES = 1024;
const AUDIO_RATE = 48000;
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x32, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x32]);
const ASC = Uint8Array.from([0x11, 0x90]);

/** بصمة العينة: بايت المسار، ثم فهرس العينة داخل مسارها، ثم نمط يتغيّر بتسلسل الاستدعاء. */
function fingerprint(track, index, size, seq) {
  const out = new Uint8Array(size);
  out[0] = track === 'video' ? 0x56 : 0x41;
  out[1] = (index >>> 24) & 0xff; out[2] = (index >>> 16) & 0xff;
  out[3] = (index >>> 8) & 0xff; out[4] = index & 0xff;
  for (let k = 5; k < size; k += 1) out[k] = (seq * 7 + k) & 0xff;
  return out;
}

/** خطة الاستدعاء: فيديو 90 إطاراً متشابكاً مع صوت AAC كما يُكتب فعلياً على القرص. */
function buildPlan() {
  const plan = [];
  let audioDueUs = 0;
  let audioCount = 0;
  const audioStepUs = (AUDIO_FRAMES * 1e6) / AUDIO_RATE;
  for (let v = 0; v < VIDEO_FRAMES; v += 1) {
    const tsUs = Math.round((v * 1e6) / FPS);
    while (audioDueUs <= tsUs) { plan.push({ track: 'audio', index: audioCount }); audioCount += 1; audioDueUs += audioStepUs; }
    plan.push({ track: 'video', index: v });
  }
  return plan;
}

/** يقرأ جداول كل مسار من الصناديق مباشرة (لا من حالة المُغلِّف). */
function readTracks(file, boxReader) {
  const view = boxReader.viewOf(file);
  const tracks = [];
  const mdats = [];
  let mvhd = null;
  let cur = null;
  boxReader.walkBoxes(view, 0, file.length, (box) => {
    const b = box.bodyStart;
    switch (box.type) {
      case 'mdat': mdats.push({ start: box.start, bodyStart: box.bodyStart, end: box.end, header: box.header }); break;
      case 'mvhd': mvhd = { timescale: view.getUint32(b + 12), duration: view.getUint32(b + 16) }; break;
      case 'trak': cur = { stts: [], stss: null, stsc: [], stco: [], sizes: [] }; tracks.push(cur); break;
      case 'tkhd': cur.id = view.getUint32(b + 12); cur.tkhdDuration = view.getUint32(b + 20); break;
      case 'mdhd': cur.timescale = view.getUint32(b + 12); cur.duration = view.getUint32(b + 16); break;
      case 'hdlr': cur.handler = String.fromCharCode(...file.subarray(b + 8, b + 12)); break;
      case 'stts': {
        const n = view.getUint32(b + 4);
        for (let i = 0; i < n; i += 1) cur.stts.push([view.getUint32(b + 8 + i * 8), view.getUint32(b + 12 + i * 8)]);
        break;
      }
      case 'stss': {
        const n = view.getUint32(b + 4);
        cur.stss = Array.from({ length: n }, (_, i) => view.getUint32(b + 8 + i * 4));
        break;
      }
      case 'stsc': {
        const n = view.getUint32(b + 4);
        for (let i = 0; i < n; i += 1) cur.stsc.push([view.getUint32(b + 8 + i * 12), view.getUint32(b + 12 + i * 12)]);
        break;
      }
      case 'stco': {
        const n = view.getUint32(b + 4);
        for (let i = 0; i < n; i += 1) cur.stco.push(view.getUint32(b + 8 + i * 4));
        break;
      }
      case 'stsz': {
        const fixed = view.getUint32(b + 4);
        const n = view.getUint32(b + 8);
        for (let i = 0; i < n; i += 1) cur.sizes.push(fixed || view.getUint32(b + 12 + i * 4));
        break;
      }
      default: break;
    }
  }, { containers: new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']) });
  return { tracks, mdats, mvhd };
}

/** إزاحة كل عينة وحجمها كما يحسبها المشغّل من الجداول. */
function sampleLayout(track) {
  const out = [];
  let sample = 0;
  track.stco.forEach((chunkOffset, c) => {
    let perChunk = 0;
    for (const [first, n] of track.stsc) if (first <= c + 1) perChunk = n;
    let offset = chunkOffset;
    for (let k = 0; k < perChunk; k += 1) {
      const size = track.sizes[sample];
      out.push({ offset, size, chunk: c });
      offset += size;
      sample += 1;
    }
  });
  return out;
}

function expectedChunkCounts(plan, track) {
  const runs = [];
  let last = null;
  for (const step of plan) {
    if (step.track !== track) { last = null; continue; }
    if (last) last.count += 1;
    else { last = { count: 1 }; runs.push(last); }
  }
  return runs.map((r) => r.count);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-mux-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    for (const name of FILES) fs.copyFileSync(path.join(SRC, name), path.join(dir, name));
    const mux = await import(pathToFileURL(path.join(dir, 'mp4-mux.js')).href);
    const boxReader = await import(pathToFileURL(path.join(dir, 'box-reader.js')).href);
    const source = await import(pathToFileURL(path.join(dir, 'source-mp4.js')).href);

    const video = { width: 1920, height: 1040, description: AVCC, timescale: 30000 };
    const audio = { sampleRate: AUDIO_RATE, channels: 2, description: ASC, bitrate: 128000 };
    const muxer = mux.createMp4Muxer({ video, audio });

    // ── كتابة العينات بترتيب الاستدعاء نفسه، والاحتفاظ بالبايتات للمقارنة فقط ──
    const plan = buildPlan();
    const payloadParts = [];
    const written = { video: [], audio: [] };
    let position = 0;
    plan.forEach((step, seq) => {
      if (step.track === 'video') {
        const size = 40 + ((seq * 37) % 260);
        const v = step.index;
        const tsUs = Math.round((v * 1e6) / FPS);
        const durationUs = Math.round(((v + 1) * 1e6) / FPS) - tsUs;
        const bytes = fingerprint('video', v, size, seq);
        const { offset } = muxer.addVideoSample({ size, timestampUs: tsUs, durationUs, key: v % 30 === 0 });
        same(offset, position, 'موضع العينة المُعاد لا يطابق الموضع التراكمي');
        payloadParts.push(bytes);
        written.video.push({ size, bytes, tsUs, key: v % 30 === 0 });
        position += size;
      } else {
        const size = 120 + ((seq * 11) % 60);
        const bytes = fingerprint('audio', step.index, size, seq);
        const { offset } = muxer.addAudioSample({ size, frames: AUDIO_FRAMES });
        same(offset, position, 'موضع عينة الصوت المُعاد لا يطابق الموضع التراكمي');
        payloadParts.push(bytes);
        written.audio.push({ size, bytes });
        position += size;
      }
    });
    const header = muxer.finalize();
    const payload = payloadParts.reduce((sum, part) => sum + part.length, 0);
    same(payload, position, 'مجموع الحمولة المكتوبة لا يطابق');
    same(muxer.stats().payloadBytes, payload, 'stats() لا تطابق الحمولة');
    const file = new Uint8Array(header.length + payload);
    file.set(header, 0);
    let at = header.length;
    for (const part of payloadParts) { file.set(part, at); at += part.length; }

    // ── ترتيب الصناديق وحجم mdat ──
    const top = [];
    boxReader.walkBoxes(file, 0, file.length, (box) => top.push(box), { containers: new Set() });
    same(top.map((b) => b.type), ['ftyp', 'moov', 'mdat'], 'ترتيب الصناديق على المستوى الأعلى');
    same(top[2].size, 8 + payload, 'حجم mdat');
    same(top[2].bodyStart, header.length, 'بداية حمولة mdat لا تطابق نهاية الرأس');
    same(String.fromCharCode(...file.subarray(8, 12)), 'isom', 'العلامة الرئيسية في ftyp');

    // ── الجداول: كل إزاحة تشير إلى بايتات عينتها فعلاً ──
    const { tracks, mdats, mvhd } = readTracks(file, boxReader);
    same(tracks.map((t) => t.handler), ['vide', 'soun'], 'المسارات وترتيبها');
    const [vt, aud] = tracks;
    same(vt.sizes, written.video.map((s) => s.size), 'stsz للفيديو لا تطابق الأحجام المكتوبة');
    same(aud.sizes, written.audio.map((s) => s.size), 'stsz للصوت لا تطابق الأحجام المكتوبة');
    for (const [track, list] of [[vt, written.video], [aud, written.audio]]) {
      const layout = sampleLayout(track);
      same(layout.length, list.length, 'عدد العينات المُشتقة من الجداول');
      layout.forEach((entry, i) => {
        const got = file.subarray(entry.offset, entry.offset + entry.size);
        same(Array.from(got, (x) => x), Array.from(list[i].bytes, (x) => x),
          `بايتات العينة ${i} من ${track.handler} لا تطابق عند الإزاحة ${entry.offset}`);
      });
      checks += 1;
    }
    check(mdats.length === 1 && mdats[0].bodyStart === header.length, 'mdat الوحيد يبدأ بعد الرأس');

    // ── stts: مجموع المدد = المدة الكلية بمقياس المسار ──
    same(vt.stts.reduce((s, [n, d]) => s + n * d, 0), vt.duration, 'مجموع stts للفيديو ≠ mdhd');
    same(vt.duration, VIDEO_FRAMES * (30000 / FPS), 'مدة الفيديو بنبضات 30000');
    same(aud.stts.reduce((s, [n, d]) => s + n * d, 0), aud.duration, 'مجموع stts للصوت ≠ mdhd');
    same(aud.duration, written.audio.length * AUDIO_FRAMES, 'مدة الصوت بعينات 48000');
    same(vt.tkhdDuration, Math.round(vt.duration * 1000 / 30000), 'tkhd.duration للفيديو بمقياس الفيلم');
    same(vt.timescale, 30000, 'مقياس الفيديو');
    same(aud.timescale, AUDIO_RATE, 'مقياس الصوت = معدل العينات');
    same(mvhd, { timescale: 1000, duration: 3000 }, 'mvhd بمقياس 1000 ومدة 3 ثوانٍ');

    // ── stss: المفتاحية فقط ──
    same(vt.stss, [1, 31, 61], 'stss يجب أن يشير إلى المفتاحيات فقط');
    same(aud.stss, null, 'الصوت بلا stss');
    check(!vt.stts.some(([, d]) => d <= 0), 'مدة صفرية في stts');

    // ── تشابك القطع: تناوب المسارين ومدد القطع ──
    same(vt.stco.length, expectedChunkCounts(plan, 'video').length, 'عدد قطع الفيديو');
    same(aud.stco.length, expectedChunkCounts(plan, 'audio').length, 'عدد قطع الصوت');
    const expandedVideo = [];
    vt.stsc.forEach(([first, n], i) => {
      const end = i + 1 < vt.stsc.length ? vt.stsc[i + 1][0] - 1 : vt.stco.length;
      for (let c = first; c <= end; c += 1) expandedVideo[c - 1] = n;
    });
    same(expandedVideo, expectedChunkCounts(plan, 'video'), 'عدد العينات بالقطعة للفيديو');
    // التشابك الحقيقي: كل مسار في قطع كثيرة، والصوت يتبدّل عدد عيناته بين القطع فيتعدّد stsc.
    check(vt.stco.length > 10 && aud.stco.length > 10, 'تشابك حقيقي: كل مسار في قطع كثيرة');
    check(new Set(expectedChunkCounts(plan, 'audio')).size > 1, 'عدد عينات الصوت بالقطعة يتبدّل (تناوب حقيقي)');
    same(vt.stco.every((o, i) => i === 0 || o > vt.stco[i - 1]), true, 'قطع الفيديو بترتيب كتابتها');

    // ── جولة كاملة: parseMp4 يعيد العينات نفسها ──
    const reads = [];
    const reader = source.readerFromBytes(file);
    const parsed = await source.parseMp4(async (offset, length) => { reads.push([offset, length]); return reader(offset, length); }, file.length);
    check(parsed.fragmented === false, 'ملف المُغلِّف غير مجزّأ');
    same(parsed.video.codec, 'avc1.640032', 'سلسلة الفيديو من avcC');
    same([parsed.video.width, parsed.video.height], [1920, 1040], 'أبعاد الفيديو');
    same(Array.from(parsed.video.description), Array.from(AVCC), 'avcC يعود كما كُتب');
    same(parsed.video.samples.map((s) => s.offset), sampleLayout(vt).map((s) => s.offset), 'إزاحات القارئ = إزاحات الجداول');
    same(parsed.video.samples.map((s) => s.size), written.video.map((s) => s.size), 'أحجام القارئ');
    same(parsed.video.samples.map((s, i) => s.key === written.video[i].key), written.video.map(() => true), 'المفتاحية في القارئ');
    check(parsed.video.samples.every((s, i) => Math.abs(s.ptsUs - written.video[i].tsUs) <= 18), 'الطوابع تنحرف أكثر من نبضة');
    same(parsed.video.samples.reduce((s, x) => s + x.durationUs, 0), 3000000, 'مجموع مدد الفيديو = 3 ثوانٍ بالضبط');
    same(parsed.audio.codec, 'mp4a.40.2', 'سلسلة الصوت');
    same([parsed.audio.sampleRate, parsed.audio.channels], [48000, 2], 'معدل الصوت وقنواته');
    same(Array.from(parsed.audio.description), Array.from(ASC), 'AudioSpecificConfig يعود كما كُتب');
    same(parsed.audio.samples.map((s) => s.offset), sampleLayout(aud).map((s) => s.offset), 'إزاحات الصوت في القارئ');
    same(parsed.audio.samples.reduce((s, x) => s + x.durationUs, 0), Math.round(written.audio.length * AUDIO_FRAMES * 1e6 / AUDIO_RATE), 'مدة الصوت الكلية');
    // القارئ لم يقرأ إلا رؤوس mdat (8 بايتات)، لا محتواها.
    for (const [offset, length] of reads) {
      for (const m of mdats) {
        const overlaps = offset < m.end && offset + length > m.bodyStart;
        check(!overlaps, `readAt قرأ محتوى mdat عند ${offset}+${length}`);
      }
    }

    // ── الرفض الصريح ──
    const strict = mux.createMp4Muxer({ video });
    strict.addVideoSample({ size: 10, timestampUs: 0, durationUs: 33333, key: true });
    throwsWith(() => strict.addVideoSample({ size: 10, timestampUs: 0, durationUs: 33333, key: false }),
      /ليس أكبر من سابقه/, 'طابع غير متصاعد يجب أن يُرفض');
    throwsWith(() => strict.addVideoSample({ size: 10, timestampUs: 10, durationUs: 33333, key: false }),
      /نبضة/, 'طابعان أقرب من نبضة يجب أن يُرفضا');
    throwsWith(() => mux.createMp4Muxer({ video }).addVideoSample({ size: 10, timestampUs: 0, durationUs: 1, key: false }),
      /مفتاحية/, 'أول عينة غير مفتاحية تُرفض');
    const big = mux.createMp4Muxer({ video });
    big.addVideoSample({ size: 10, timestampUs: 0, durationUs: 33333, key: true });
    throwsWith(() => big.addVideoSample({ size: 2 * 1024 ** 3, timestampUs: 33333, durationUs: 33333, key: false }),
      /2 ج\.ب/, 'تجاوز الحمولة 2 ج.ب يجب أن يُرفض');
    const done = mux.createMp4Muxer({ video });
    done.addVideoSample({ size: 10, timestampUs: 0, durationUs: 33333, key: true });
    done.finalize();
    throwsWith(() => done.addVideoSample({ size: 10, timestampUs: 33333, durationUs: 33333, key: false }),
      /بعد finalize/, 'الإضافة بعد الإنهاء تُرفض');
    throwsWith(() => done.finalize(), /مرتين/, 'finalize مرتين تُرفض');
    const silent = mux.createMp4Muxer({ video, audio });
    silent.addVideoSample({ size: 10, timestampUs: 0, durationUs: 33333, key: true });
    throwsWith(() => silent.finalize(), /بلا عينات/, 'مسار صوت مهيأ بلا عينات يُرفض');

    // ── فيديو وحده ──
    const solo = mux.createMp4Muxer({ video: { ...video } });
    const soloParts = [];
    for (let v = 0; v < 5; v += 1) {
      const size = 30 + v;
      solo.addVideoSample({ size, timestampUs: Math.round((v * 1e6) / FPS), durationUs: 33333, key: v === 0 });
      soloParts.push(fingerprint('video', v, size, v));
    }
    const soloHeader = solo.finalize();
    const soloPayload = soloParts.reduce((s, p) => s + p.length, 0);
    const soloFile = new Uint8Array(soloHeader.length + soloPayload);
    soloFile.set(soloHeader, 0);
    let soloAt = soloHeader.length;
    for (const part of soloParts) { soloFile.set(part, soloAt); soloAt += part.length; }
    const soloTables = readTracks(soloFile, boxReader);
    same(soloTables.tracks.map((t) => t.handler), ['vide'], 'فيديو وحده: مسار واحد');
    same(soloTables.tracks[0].stco.length, 1, 'فيديو وحده: قطعة واحدة');
    same(soloTables.tracks[0].stsc, [[1, 5]], 'فيديو وحده: stsc بإدخال واحد');
    const soloParsed = await source.parseMp4(source.readerFromBytes(soloFile), soloFile.length);
    same(soloParsed.audio, null, 'فيديو وحده: لا صوت في القارئ');
    same(soloParsed.video.samples.length, 5, 'فيديو وحده: عدد العينات بعد الجولة');

    console.log(`promo-mux-test: ok — ${checks} فحصاً`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
