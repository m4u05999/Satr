#!/usr/bin/env node
'use strict';
// اختبار قارئ المصدر (source-mp4.js) على مقطع حقيقي مسجَّل من MediaRecorder.
// القيم المتوقعة مقيسة بالمحلّل المرجعي `analyzeMp4` في scripts/promo-probe-live.js
// على الملف نفسه (scripts/fixtures/promo-segment-fragmented.mp4): 179 عينة، مفتاحيتان
// عند الموضعين 1 و96، مقياس 30000، المرمّز avc1.640032، وحمولة mdat = 40546 بايتاً.
// الوحدات تُنسخ إلى مجلد مؤقت بـ package.json «module» (كما يفعل conversation-history-test).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '../src/ui/lib/promo-export');
const FILES = ['box-reader.js', 'mp4-mux.js', 'source-mp4.js'];
const FIXTURE = path.join(__dirname, 'fixtures/promo-segment-fragmented.mp4');
let checks = 0;
function same(actual, expected, message) { assert.deepEqual(actual, expected, message); checks += 1; }
function check(condition, message) { assert.ok(condition, message); checks += 1; }

// قيم المحلّل المرجعي على هذا الملف (مقيسة، لا مُقدَّرة).
const REFERENCE = {
  fileSize: 42936,
  samples: 179,
  keyframes1Based: [1, 96],
  timescale: 30000,
  codec: 'avc1.640032',
  mdatBodyBytes: 40546,
  offsetSum: 4015196,
  firstOffset: 1614,
  lastOffset: 42655,
  avcCBytes: 50,
  pts95Us: 3152867, // dts 94586 ticks، من tfdt الفعلي للجزء الثاني
  endUs: 5970833, // نهاية آخر عينة = 179125 نبضة
  mdatCount: 2,
};

function sumOf(list) { return list.reduce((s, x) => s + x, 0); }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-source-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    for (const name of FILES) fs.copyFileSync(path.join(SRC, name), path.join(dir, name));
    const source = await import(pathToFileURL(path.join(dir, 'source-mp4.js')).href);
    const boxReader = await import(pathToFileURL(path.join(dir, 'box-reader.js')).href);

    const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
    same(bytes.length, REFERENCE.fileSize, 'حجم المقطع المنسوخ');

    // ── صناديق الملف الأعلى وفتحات mdat ──
    const top = [];
    boxReader.walkBoxes(bytes, 0, bytes.length, (box) => top.push(box), { containers: new Set() });
    same(top.map((b) => b.type), ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat'], 'ترتيب صناديق المقطع المجزّأ');
    const mdats = top.filter((b) => b.type === 'mdat').map((b) => ({ start: b.bodyStart, end: b.end }));
    same(mdats.length, REFERENCE.mdatCount, 'عدد صناديق mdat');
    same(mdats.reduce((s, m) => s + (m.end - m.start), 0), REFERENCE.mdatBodyBytes, 'حجم محتوى mdat');

    // ── القراءة: نسجّل كل استدعاء ولا نسمح بمحتوى mdat ──
    const reads = [];
    const inner = source.readerFromBytes(bytes);
    const readAt = async (offset, length) => { reads.push([offset, length]); return inner(offset, length); };
    const parsed = await source.parseMp4(readAt, bytes.length);

    // ── المطابقة مع المحلّل المرجعي ──
    check(parsed.fragmented === true, 'المقطع مجزّأ');
    same(parsed.video.codec, REFERENCE.codec, 'سلسلة المرمّز من avcC');
    same(parsed.video.timescale, REFERENCE.timescale, 'المقياس الزمني');
    same(parsed.video.description.length, REFERENCE.avcCBytes, 'حجم محتوى avcC');
    same(parsed.video.samples.length, REFERENCE.samples, 'عدد العينات');
    same(parsed.video.samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean), REFERENCE.keyframes1Based, 'المفتاحيات');
    same(sumOf(parsed.video.samples.map((s) => s.size)), REFERENCE.mdatBodyBytes, 'مجموع أحجام العينات = حمولة mdat');
    same(sumOf(parsed.video.samples.map((s) => s.offset)), REFERENCE.offsetSum, 'مجموع الإزاحات');
    same(parsed.video.samples[0].offset, REFERENCE.firstOffset, 'إزاحة أول عينة');
    same(parsed.video.samples[REFERENCE.samples - 1].offset, REFERENCE.lastOffset, 'إزاحة آخر عينة');
    same(parsed.video.samples[95].ptsUs, REFERENCE.pts95Us, 'زمن العرض للعينة 96 (يلتقط فجوة tfdt)');
    const last = parsed.video.samples[REFERENCE.samples - 1];
    same(last.ptsUs + last.durationUs, REFERENCE.endUs, 'نهاية المقطع بالميكروثانية');
    same(parsed.audio, null, 'المقطع بلا صوت');

    // ── العينات تُغطّي صناديق mdat تغطية تامة بلا تداخل ──
    const sorted = [...parsed.video.samples].sort((a, b) => a.offset - b.offset);
    let cursor = null;
    for (const s of sorted) {
      const owner = mdats.find((m) => s.offset >= m.start && s.offset + s.size <= m.end);
      check(Boolean(owner), `العينة عند ${s.offset} ليست داخل mdat`);
      if (cursor !== null) check(s.offset >= cursor, `تداخل عينتين عند ${s.offset}`);
      cursor = s.offset + s.size;
    }
    same(sumOf(sorted.map((s) => s.size)), REFERENCE.mdatBodyBytes, 'التغطية = حمولة mdat كاملة');

    // ── بنية كل عينة H.264: بادئات الأطوال تتطابق مع الحجم، والمفتاحية تحوي IDR ──
    const lengthSize = (parsed.video.description[4] & 3) + 1;
    let idrKeys = 0;
    for (const [index, s] of parsed.video.samples.entries()) {
      const data = bytes.subarray(s.offset, s.offset + s.size);
      let p = 0;
      let hasIdr = false;
      while (p < data.length) {
        let len = 0;
        for (let k = 0; k < lengthSize; k += 1) len = len * 256 + data[p + k];
        p += lengthSize;
        check(len > 0 && p + len <= data.length, `NAL مشوَّه في العينة ${index}`);
        if ((data[p] & 0x1f) === 5) hasIdr = true;
        p += len;
      }
      same(p, data.length, `مجموع NAL لا يساوي حجم العينة ${index}`);
      if (s.key) { check(hasIdr, `العينة المفتاحية ${index} بلا IDR`); idrKeys += 1; }
    }
    same(idrKeys, REFERENCE.keyframes1Based.length, 'كل المفتاحيات تحوي IDR');

    // ── readAt: رؤوس فقط داخل mdat، والقراءة الكلية صغيرة قياساً إلى الملف ──
    for (const [offset, length] of reads) {
      for (const m of mdats) {
        check(!(offset < m.end && offset + length > m.start), `readAt قرأ محتوى mdat عند ${offset}+${length}`);
      }
    }
    check(sumOf(reads.map(([, l]) => l)) < bytes.length * 0.2, 'القراءة الكلية أكبر مما يلزم للفهرس');

    // ── الرفض الصريح للملفات المشوَّهة ──
    const reject = async (data, pattern, message) => {
      await assert.rejects(source.parseMp4(source.readerFromBytes(data), data.length), pattern, message);
      checks += 1;
    };
    await reject(Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
      /لا يوجد صندوق moov/, 'ملف بلا moov يُرفض');
    await reject(Uint8Array.from([0, 0, 0, 64, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]),
      /مشوَّه|يتجاوز|لا تنتهي/, 'صندوق يتجاوز الملف يُرفض');
    await assert.rejects(source.readerFromBytes(bytes)(bytes.length - 2, 8), /قراءة خارج الملف/, 'القارئ يرفض ما بعد النهاية');
    checks += 1;

    console.log(`promo-source-test: ok — ${checks} فحصاً`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
