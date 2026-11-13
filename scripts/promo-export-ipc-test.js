// حارس كاتب التصدير — electron/promoexport.js (الدفعة 6 من مخرج الإعلانات).
// القاعدة المحروسة: المصيّر لا يرسل مساراً أبداً، ولا كتابة بعد الإنهاء، ولا ملف جزئي يبقى.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const promoexport = require('../electron/promoexport');

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };

// رأس MP4 شكلي: ftyp ثم moov فارغ ثم رأس mdat يعلن طول الحمولة.
function header(payloadBytes) {
  const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4, 'latin1'); ftyp.write('isom', 8, 'latin1');
  const moov = Buffer.alloc(16); moov.writeUInt32BE(16, 0); moov.write('moov', 4, 'latin1');
  const mdat = Buffer.alloc(8); mdat.writeUInt32BE(payloadBytes + 8, 0); mdat.write('mdat', 4, 'latin1');
  return Buffer.concat([ftyp, moov, mdat]);
}

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-promo-export-'));
try {
  const fixed = new Date(2026, 10, 13, 9, 5, 7);
  const writer = promoexport.create({ downloadsPath: downloads, now: () => fixed });
  const list = () => fs.readdirSync(downloads).sort();

  // ── الدورة السعيدة ──
  const begun = writer.begin();
  eq([begun.ok, begun.filename], [true, 'satr-promo-final-2026-11-13-09-05-07.mp4'], 'الاسم يختاره main بنمط آمن');
  ok(promoexport.SAFE_HANDLE.test(begun.handle), 'مقبض عشوائي 32 محرفاً');
  eq(Object.keys(begun).sort(), ['filename', 'handle', 'ok'], 'begin لا يعيد مساراً');
  eq(list(), ['satr-promo-final-2026-11-13-09-05-07.mp4.part'], 'ملف .part وحده');
  eq(writer.begin().error, 'busy', 'تصدير واحد في المرة');
  const a = Buffer.from('AAAAAAAAAA'), b = new Uint8Array([1, 2, 3, 4, 5]);
  eq(writer.chunk(begun.handle, 0, a), { ok: true, bytes: 10 }, 'قطعة Buffer');
  eq(writer.chunk(begun.handle, 1, b), { ok: true, bytes: 15 }, 'قطعة Uint8Array');
  eq(writer.chunk(begun.handle, 2, new Uint8Array([9, 9]).buffer), { ok: true, bytes: 17 }, 'قطعة ArrayBuffer');
  const done = writer.finish(begun.handle, header(17));
  eq([done.ok, done.filename, done.bytes], [true, 'satr-promo-final-2026-11-13-09-05-07.mp4', 48 + 17], 'الإنهاء');
  eq(list(), ['satr-promo-final-2026-11-13-09-05-07.mp4'], 'لا .part ولا .tmp بعد الإنهاء');
  const file = fs.readFileSync(path.join(downloads, done.filename));
  eq(file.subarray(0, 48), header(17), 'الرأس أولاً (faststart)');
  eq([...file.subarray(48)], [...a, ...b, 9, 9], 'الحمولة بعد الرأس بترتيبها');
  eq(writer.state(), { active: false, bytes: 0 }, 'لا تصدير نشط');

  // ── لا كتابة بعد الإنهاء ──
  eq(writer.chunk(begun.handle, 3, a).error, 'bad_handle', 'قطعة بعد الإنهاء');
  eq(writer.finish(begun.handle, header(17)).error, 'bad_handle', 'إنهاء مرتين');
  eq(writer.abort(begun.handle).error, 'bad_handle', 'إلغاء بعد الإنهاء');
  ok(fs.existsSync(path.join(downloads, done.filename)), 'الملف المكتمل لا يُمسّ');

  // ── اسم مأخوذ ⇒ لاحقة ──
  const second = writer.begin();
  eq(second.filename, 'satr-promo-final-2026-11-13-09-05-07-2.mp4', 'الاسم المأخوذ يأخذ لاحقة');
  ok(second.handle !== begun.handle, 'مقبض جديد');

  // ── مقابض خبيثة ──
  for (const bad of ['', 'x', begun.handle, '../' + second.handle, second.handle.toUpperCase(), null, 7, {}, [second.handle]]) {
    eq(writer.chunk(bad, 0, a).error, 'bad_handle', 'مقبض مرفوض: ' + JSON.stringify(bad));
  }
  ok(writer.state().active, 'المقبض الخاطئ لا يُسقط التصدير الجاري');

  // ── الترقيم ──
  eq(writer.chunk(second.handle, 1, a).error, 'bad_sequence', 'تخطي ترقيم');
  eq(writer.state().active, false, 'خطأ الترقيم يُسقط التصدير');
  eq(list(), ['satr-promo-final-2026-11-13-09-05-07.mp4'], 'ولا يترك ملفاً جزئياً');
  for (const [label, run] of [
    ['ترقيم مكرر', (h) => { writer.chunk(h, 0, a); return writer.chunk(h, 0, a); }],
    ['ترقيم سالب', (h) => writer.chunk(h, -1, a)],
    ['ترقيم كسري', (h) => writer.chunk(h, 0.5, a)],
    ['ترقيم نصي', (h) => writer.chunk(h, '0', a)],
  ]) {
    const h = writer.begin().handle;
    eq(run(h).error, 'bad_sequence', label);
    eq(list().filter((name) => /part|tmp/.test(name)), [], label + ' — لا بقايا');
  }

  // ── القطع ──
  for (const [label, bytes] of [['فارغة', Buffer.alloc(0)], ['نص', 'AAAA'], ['مصفوفة', [1, 2, 3]], ['null', null], ['كائن بمسار', { path: 'C:\\x' }],
    ['فوق حد القطعة', Buffer.alloc(promoexport.MAX_CHUNK_BYTES + 1)]]) {
    const h = writer.begin().handle;
    eq(writer.chunk(h, 0, bytes).error, 'bad_chunk', 'قطعة مرفوضة: ' + label);
    eq(writer.state().active, false, label + ' — يُسقط التصدير');
  }

  // ── الرأس ──
  for (const [label, make] of [
    ['حجم mdat لا يطابق الحمولة', () => header(11)],
    ['لا يبدأ بـftyp', () => { const h = header(10); h.write('free', 4, 'latin1'); return h; }],
    ['لا ينتهي بـmdat', () => { const h = header(10); h.write('free', h.length - 4, 'latin1'); return h; }],
    ['قصير', () => Buffer.alloc(8)],
    ['فوق الحد', () => Buffer.alloc(promoexport.MAX_HEADER_BYTES + 1)],
    ['نص', () => 'ftyp'],
  ]) {
    const h = writer.begin().handle;
    writer.chunk(h, 0, a);
    eq(writer.finish(h, make()).error, 'bad_header', 'رأس مرفوض: ' + label);
    eq(list().filter((name) => /part|tmp/.test(name)), [], label + ' — لا بقايا');
    eq(writer.state().active, false, label + ' — المقبض يسقط');
  }
  const empty = writer.begin().handle;
  eq(writer.finish(empty, header(0)).error, 'empty_export', 'إنهاء بلا حمولة');

  // ── الإلغاء ──
  const cancelled = writer.begin();
  writer.chunk(cancelled.handle, 0, a);
  eq(writer.abort(cancelled.handle), { ok: true }, 'الإلغاء');
  eq(list(), ['satr-promo-final-2026-11-13-09-05-07.mp4'], 'الإلغاء يحذف .part');
  eq(writer.chunk(cancelled.handle, 1, a).error, 'bad_handle', 'لا كتابة بعد الإلغاء');

  // ── السقف الإجمالي (بنظام ملفات وهمي كي لا نكتب 2 ج.ب) ──
  let written = 0;
  const fake = { ...fs, openSync: () => 99, closeSync: () => {}, unlinkSync: () => {}, existsSync: () => false, writeSync: (fd, data, at, len) => { written += len; return len; } };
  const big = promoexport.create({ downloadsPath: downloads, fs: fake, now: () => fixed });
  const bigHandle = big.begin().handle;
  const piece = Buffer.alloc(promoexport.MAX_CHUNK_BYTES);
  let seq = 0, last = { ok: true };
  while (last.ok && seq < 400) { last = big.chunk(bigHandle, seq, piece); seq += 1; }
  eq(last.error, 'too_large', 'السقف الإجمالي يوقف الكتابة');
  ok(written <= promoexport.MAX_TOTAL_BYTES, 'لم يُكتب فوق السقف');
  ok(promoexport.MAX_TOTAL_BYTES + promoexport.MAX_HEADER_BYTES <= 2 * 1024 * 1024 * 1024, 'الملف كله تحت 2 ج.ب (إزاحات stco)');

  // ── بقايا يتيمة عند الإقلاع ──
  for (const name of ['satr-promo-final-2026-01-01-00-00-00.mp4.part', 'satr-promo-final-2026-01-01-00-00-00-3.mp4.tmp',
    'satr-promo-final-2026-01-01-00-00-00.mp4', 'my-video.mp4.part', 'satr-promo-final-evil.mp4.part', 'notes.txt']) {
    fs.writeFileSync(path.join(downloads, name), 'x');
  }
  eq(writer.cleanupOrphans(), { ok: true, removed: 2 }, 'يُحذف ما يطابق نمطنا فقط');
  eq(list(), ['my-video.mp4.part', 'notes.txt', 'satr-promo-final-2026-01-01-00-00-00.mp4', 'satr-promo-final-2026-11-13-09-05-07.mp4', 'satr-promo-final-evil.mp4.part'], 'ملفات المستخدم والملفات المكتملة لا تُمسّ');
  const live = writer.begin();
  eq(writer.cleanupOrphans().removed, 0, 'التنظيف لا يمسّ التصدير الجاري');
  ok(fs.existsSync(path.join(downloads, live.filename + '.part')), 'ملف التصدير الجاري باقٍ');
  writer.abort(live.handle);

  // ── بلا جذر ──
  eq(promoexport.create({}).begin().error, 'unavailable', 'بلا Downloads');
  eq(promoexport.create({ downloadsPath: 'relative' }).begin().error, 'unavailable', 'جذر نسبي');
  eq(promoexport.create({}).cleanupOrphans(), { ok: false, removed: 0 }, 'تنظيف بلا جذر');

  // ── العقد في main وpreload: لا مسار يعبر ──
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const handlers = main.split('\n').filter((line) => line.includes("'satr:promoExport"));
  eq(handlers.length, 4, 'أربع قنوات تصدير في main');
  const block = main.slice(main.indexOf("ipcMain.handle('satr:promoExportBegin'"), main.indexOf("ipcMain.handle('satr:promoExportAbort'") + 140);
  ok(!/\.path\b|filename|filePath/.test(block), 'معالجات التصدير لا تقرأ مساراً ولا اسماً من المصيّر');
  // الدفعة 9 أضافت نوع الناتج: قيمة من قائمة مغلقة، لا مسار ولا اسم.
  ok(preload.includes("promoExportBegin: (kind) => ipcRenderer.invoke('satr:promoExportBegin', { kind: kind === 'gif' ? 'gif' : 'mp4' })"), 'begin في preload يمرّر نوعاً من قائمة مغلقة فقط');
  ok(main.includes("promoexport.begin(payload && payload.kind === 'gif' ? 'gif' : 'mp4')"), 'وmain يعيد حسم النوع ولا يثق بالمصيّر');

  // ── GIF: تيار واحد بتوقيع وذيل ──
  const gifWriter = promoexport.create({ downloadsPath: downloads, now: () => new Date(2026, 10, 13, 10, 0, 0) });
  eq(gifWriter.begin('exe').error, 'bad_kind', 'نوع مجهول مرفوض');
  eq(gifWriter.begin('../x').error, 'bad_kind', 'نوع فيه مسار مرفوض');
  const gif = gifWriter.begin('gif');
  eq(gif.filename, 'satr-promo-final-2026-11-13-10-00-00.gif', 'اسم GIF يختاره main');
  eq(gifWriter.chunk(gif.handle, 0, Buffer.from('NOTGIF....')).error, 'bad_chunk', 'أول قطعة بلا توقيع GIF89a مرفوضة');
  const gif2 = gifWriter.begin('gif');
  gifWriter.chunk(gif2.handle, 0, Buffer.from('GIF89a' + 'x'.repeat(20), 'latin1'));
  eq(gifWriter.finish(gif2.handle).error, 'bad_trailer', 'GIF بلا ذيل مرفوض');
  eq(fs.readdirSync(downloads).filter((name) => name.endsWith('.gif') || name.endsWith('.gif.part')), [], 'ولا يترك ملفاً');
  const gif3 = gifWriter.begin('gif');
  gifWriter.chunk(gif3.handle, 0, Buffer.from('GIF89a' + 'x'.repeat(20), 'latin1'));
  gifWriter.chunk(gif3.handle, 1, Buffer.from([1, 2, 0x3b]));
  eq(gifWriter.finish(gif3.handle, Buffer.alloc(40)).error, 'bad_header', 'GIF لا يقبل رأساً منفصلاً');
  const gif4 = gifWriter.begin('gif');
  gifWriter.chunk(gif4.handle, 0, Buffer.from('GIF89a' + 'x'.repeat(20), 'latin1'));
  gifWriter.chunk(gif4.handle, 1, Buffer.from([1, 2, 0x3b]));
  const gifDone = gifWriter.finish(gif4.handle);
  eq([gifDone.ok, gifDone.bytes, fs.readFileSync(gifDone.path).length], [true, 29, 29], 'GIF صالح يُحفظ كما كُتب');
  ok(!fs.existsSync(gifDone.path + '.part'), 'ولا .part بعده');

  // ── الصورة المصغرة ──
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(60)]);
  const thumb = gifWriter.saveThumbnail(png);
  eq([thumb.ok, thumb.filename, fs.readFileSync(thumb.path).length], [true, 'satr-promo-thumb-2026-11-13-10-00-00.png', png.length], 'صورة مصغرة باسم يختاره main');
  eq(gifWriter.saveThumbnail(png).filename, 'satr-promo-thumb-2026-11-13-10-00-00-2.png', 'الاسم المأخوذ يأخذ لاحقة ولا يُستبدل الملف');
  for (const [label, bytes] of [['ليست PNG', Buffer.from('<html>' + 'x'.repeat(100))], ['قصيرة', png.subarray(0, 20)], ['بلا IHDR', Buffer.concat([png.subarray(0, 12), Buffer.from('XXXX'), Buffer.alloc(60)])],
    ['نص', 'png'], ['كائن بمسار', { path: 'C:\\x.png' }], ['فوق الحد', Buffer.concat([png, Buffer.alloc(promoexport.MAX_THUMB_BYTES)])]]) {
    eq(gifWriter.saveThumbnail(bytes).error, 'bad_image', 'صورة مصغرة مرفوضة: ' + label);
  }
  eq(promoexport.create({}).saveThumbnail(png).error, 'unavailable', 'بلا Downloads');
  ok(/promoThumbnailSave: \(bytes\) =>/.test(preload) && !/satr:promoThumbnailSave[^\n]*path/.test(main), 'الصورة المصغرة بايتات فقط، لا مسار');
  for (const name of ['promoExportChunk', 'promoExportFinish', 'promoExportAbort']) {
    const line = preload.split('\n').find((item) => item.includes(name + ':'));
    ok(line && /\(handle/.test(line) && !/path/i.test(line), name + ' بالمقبض لا بمسار');
  }
  ok(/promoexport\.cleanupOrphans\(\)/.test(main), 'التنظيف يُستدعى عند الإقلاع');

  console.log('promo-export-ipc-test: ok — ' + checks + ' فحصاً (المقبض، الترقيم، السقوف، الرأس، الإلغاء، البقايا اليتيمة، لا مسار من المصيّر).');
} finally {
  fs.rmSync(downloads, { recursive: true, force: true });
}
