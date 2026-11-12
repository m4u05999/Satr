'use strict';

// كاتب ملف التصدير النهائي لاستوديو البرومو (الدفعة 6 من docs/PROMO-DIRECTOR-PLAN.md).
//
// المصيّر يرمّز ويُغلِّف، وهذه الوحدة وحدها تلمس القرص. القاعدة: **المصيّر لا يرسل مساراً أبداً.**
// main يختار اسم الملف داخل Downloads ويعيد مقبضاً عشوائياً؛ القطع تُلحق إلى ملف .part بترقيم
// متتابع؛ وعند الإنهاء يُكتب رأس MP4 (ftyp + moov) ثم تُنسخ الحمولة بعده متدفقة، ثم تسمية ذرية.
// moov يسبق mdat (faststart) ولا يُعرف حجمه إلا في النهاية، لذلك الحمولة تُكتب أولاً إلى .part.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024 - MAX_HEADER_BYTES; // إزاحات stco 32-بت
const FINAL_NAME = /^satr-promo-final-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(?:-\d{1,3})?\.mp4$/;
const PART_NAME = /^satr-promo-final-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(?:-\d{1,3})?\.mp4\.(?:part|tmp)$/;
const SAFE_HANDLE = /^[a-f0-9]{32}$/;

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + '-' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function create(initialDeps) {
  let deps = { ...(initialDeps || {}) };
  let active = null; // { handle, partPath, tempPath, finalPath, fd, seq, bytes }

  const fileSystem = () => deps.fs || fs;
  const now = () => (typeof deps.now === 'function' ? deps.now() : new Date());

  function configure(nextDeps) { deps = { ...deps, ...(nextDeps || {}) }; }

  function downloadsRoot() {
    return typeof deps.downloadsPath === 'string' && path.isAbsolute(deps.downloadsPath) ? path.resolve(deps.downloadsPath) : '';
  }

  function discard() {
    if (!active) return;
    const io = fileSystem();
    try { if (active.fd != null) io.closeSync(active.fd); } catch {}
    for (const file of [active.partPath, active.tempPath]) { try { io.unlinkSync(file); } catch {} }
    active = null;
  }

  // يبدأ تصديراً ويعيد المقبض واسم الملف (للعرض فقط). تصدير واحد في المرة.
  function begin() {
    const root = downloadsRoot();
    if (!root) return { ok: false, error: 'unavailable' };
    if (active) return { ok: false, error: 'busy' };
    const io = fileSystem();
    const base = 'satr-promo-final-' + stamp(now());
    let finalPath = '';
    for (let index = 1; index <= 999 && !finalPath; index += 1) {
      const candidate = path.join(root, base + (index === 1 ? '' : '-' + index) + '.mp4');
      let taken = false;
      try { taken = io.existsSync(candidate) || io.existsSync(candidate + '.part') || io.existsSync(candidate + '.tmp'); } catch { taken = true; }
      if (!taken) finalPath = candidate;
    }
    if (!finalPath || !FINAL_NAME.test(path.basename(finalPath)) || path.dirname(finalPath) !== root) return { ok: false, error: 'no_free_name' };
    const handle = crypto.randomBytes(16).toString('hex');
    let fd = null;
    try { fd = io.openSync(finalPath + '.part', 'wx'); } catch { return { ok: false, error: 'write_failed' }; }
    active = { handle, partPath: finalPath + '.part', tempPath: finalPath + '.tmp', finalPath, fd, seq: 0, bytes: 0 };
    return { ok: true, handle, filename: path.basename(finalPath) };
  }

  function owns(handle) {
    return !!active && typeof handle === 'string' && SAFE_HANDLE.test(handle) && handle === active.handle;
  }

  // يُلحق قطعة حمولة. الترقيم يبدأ من 0 ويتتابع بلا فجوات ولا تكرار.
  function chunk(handle, seq, bytes) {
    if (!owns(handle)) return { ok: false, error: 'bad_handle' };
    const data = toBuffer(bytes);
    if (!Number.isInteger(seq) || seq !== active.seq) { discard(); return { ok: false, error: 'bad_sequence' }; }
    if (!data || !data.length || data.length > MAX_CHUNK_BYTES) { discard(); return { ok: false, error: 'bad_chunk' }; }
    if (active.bytes + data.length > MAX_TOTAL_BYTES) { discard(); return { ok: false, error: 'too_large' }; }
    try {
      let written = 0;
      while (written < data.length) written += fileSystem().writeSync(active.fd, data, written, data.length - written);
    } catch { discard(); return { ok: false, error: 'write_failed' }; }
    active.seq += 1;
    active.bytes += data.length;
    return { ok: true, bytes: active.bytes };
  }

  // يكتب الرأس ثم ينسخ الحمولة بعده، ثم يسمّي الملف تسمية ذرية. المقبض يسقط في كل الأحوال.
  function finish(handle, header) {
    if (!owns(handle)) return { ok: false, error: 'bad_handle' };
    const head = toBuffer(header);
    const io = fileSystem();
    const job = active;
    const fail = (error) => { discard(); return { ok: false, error }; };
    if (!head || head.length < 32 || head.length > MAX_HEADER_BYTES) return fail('bad_header');
    // فحص شكلي: الرأس يبدأ بـftyp وينتهي برأس mdat الذي يعلن طول الحمولة المكتوبة فعلاً.
    if (head.toString('latin1', 4, 8) !== 'ftyp' || head.toString('latin1', head.length - 4) !== 'mdat'
        || head.readUInt32BE(head.length - 8) !== job.bytes + 8) return fail('bad_header');
    if (!job.bytes) return fail('empty_export');
    let out = null, source = null;
    try {
      io.closeSync(job.fd); job.fd = null;
      out = io.openSync(job.tempPath, 'wx');
      io.writeSync(out, head, 0, head.length);
      source = io.openSync(job.partPath, 'r');
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      let copied = 0;
      for (;;) {
        const count = io.readSync(source, buffer, 0, buffer.length, copied);
        if (!count) break;
        let written = 0;
        while (written < count) written += io.writeSync(out, buffer, written, count - written);
        copied += count;
      }
      if (copied !== job.bytes) throw new Error('short_copy');
      io.closeSync(source); source = null;
      io.closeSync(out); out = null;
      io.renameSync(job.tempPath, job.finalPath);
      try { io.unlinkSync(job.partPath); } catch {}
    } catch {
      try { if (source != null) io.closeSync(source); } catch {}
      try { if (out != null) io.closeSync(out); } catch {}
      return fail('write_failed');
    }
    active = null;
    return { ok: true, path: job.finalPath, filename: path.basename(job.finalPath), bytes: head.length + job.bytes };
  }

  function abort(handle) {
    if (!owns(handle)) return { ok: false, error: 'bad_handle' };
    discard();
    return { ok: true };
  }

  // عند الإقلاع: ملفات .part/.tmp يتيمة من تصدير انقطع (إغلاق التطبيق أو انهيار) تُحذف.
  function cleanupOrphans() {
    const root = downloadsRoot();
    if (!root) return { ok: false, removed: 0 };
    const io = fileSystem();
    let removed = 0;
    let names = [];
    try { names = io.readdirSync(root); } catch { return { ok: false, removed: 0 }; }
    for (const name of names) {
      if (!PART_NAME.test(name)) continue;
      if (active && (path.join(root, name) === active.partPath || path.join(root, name) === active.tempPath)) continue;
      try { io.unlinkSync(path.join(root, name)); removed += 1; } catch {}
    }
    return { ok: true, removed };
  }

  function state() { return { active: !!active, bytes: active ? active.bytes : 0 }; }

  return { configure, begin, chunk, finish, abort, cleanupOrphans, state };
}

const singleton = create();

module.exports = {
  MAX_CHUNK_BYTES, MAX_HEADER_BYTES, MAX_TOTAL_BYTES, FINAL_NAME, PART_NAME, SAFE_HANDLE, create,
  configure: (...args) => singleton.configure(...args),
  begin: (...args) => singleton.begin(...args),
  chunk: (...args) => singleton.chunk(...args),
  finish: (...args) => singleton.finish(...args),
  abort: (...args) => singleton.abort(...args),
  cleanupOrphans: (...args) => singleton.cleanupOrphans(...args),
  state: (...args) => singleton.state(...args),
};
