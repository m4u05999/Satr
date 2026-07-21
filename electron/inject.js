/**
 * حقن @الملفات للمحوّلات (الدفعة 1.1 من ROADMAP.md).
 *
 * محوّلات REST (Gemini/DeepSeek/Qwen…) «دردشة عمياء» لا ترى القرص، فعند إرسال رسالة
 * فيها @مسار بمحرك غير SDK نقرأ محتوى الملف هنا ونحقنه في البرومبت بصيغة واضحة
 * (اسم الملف + كتلة كود). محرك SDK/CLI لا يمرّ من هنا (كلود يقرأ الملفات بنفسه).
 *
 * وحدة نقية بلا اعتماديات (نمط diff.js) — قابلة للتحقق الحيّ بـ node مباشرة.
 *
 * 🔒 الأمان (القاعدة 2): المسار يُحلّ داخل cwd حصراً — يُرفض المطلق و`..` وأي حلّ
 * يخرج من المجلد (مقارنة غير حساسة لحالة الأحرف — ويندوز). القراءة للعرض فقط.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE = 64 * 1024; // سقف محتوى الملف الواحد (بايت)
const MAX_TOTAL = 192 * 1024; // السقف الإجمالي لكل الملفات المحقونة
const MAX_FILES = 12; // سقف عدد الملفات في الرسالة الواحدة
const MIN_BUDGET = 4 * 1024; // أقل ميزانية متبقية تستحق الحقن (وإلا يُتخطّى الملف)

// @مسار: في بداية النص أو بعد مسافة (نفس قاعدة منصّة @ في الواجهة)، بلا مسافات
const AT_RE = /(^|\s)@([^\s@]+)/g;

// تلميح لغة كتلة الكود من الامتداد (اختياري — للعرض فقط)
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  jsx: 'jsx', tsx: 'tsx', json: 'json', html: 'html', htm: 'html', css: 'css',
  md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash',
  ps1: 'powershell', bat: 'batch', cmd: 'batch', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', xml: 'xml', sql: 'sql', vue: 'vue', svelte: 'svelte',
};

function langOf(rel) {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  return LANG_BY_EXT[ext] || '';
}

// كشف الملفات الثنائية: بايت NUL في أول 8ك.ب
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const realpathSync = fs.realpathSync.native || fs.realpathSync;

function isInside(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function nearestExisting(candidate) {
  let current = candidate;
  while (true) {
    try { fs.lstatSync(current); return current; }
    catch (error) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// يحلّ مساراً نسبياً داخل cwd بعد تتبّع symlink/junction — يعيد canonical path أو null
function resolveInside(cwd, rel) {
  if (typeof cwd !== 'string' || !cwd || typeof rel !== 'string' || !rel) return null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null; // لا مسارات مطلقة
  const norm = rel.replace(/\\/g, '/');
  if (norm.split('/').some((seg) => seg === '..')) return null; // لا صعود
  const abs = path.resolve(cwd, norm);
  const base = path.resolve(cwd);
  if (!isInside(base, abs)) return null;

  let canonicalBase;
  try {
    canonicalBase = realpathSync(base);
    if (!fs.statSync(canonicalBase).isDirectory()) return null;
  } catch { return null; }

  const existing = nearestExisting(abs);
  if (!existing || !isInside(base, existing)) return null;
  let canonicalExisting;
  try { canonicalExisting = realpathSync(existing); } catch { return null; }
  if (!isInside(canonicalBase, canonicalExisting)) return null;

  const suffix = path.relative(existing, abs);
  const canonicalCandidate = path.resolve(canonicalExisting, suffix);
  return isInside(canonicalBase, canonicalCandidate) ? canonicalCandidate : null;
}

// سياج كود أطول من أي سلسلة ` داخل المحتوى (يمنع كسر الكتلة)
function fenceFor(content) {
  let run = 0;
  const m = content.match(/`+/g);
  if (m) for (const s of m) run = Math.max(run, s.length);
  return '`'.repeat(Math.max(3, run + 1));
}

// يقرأ حتى limit+1 بايت (كشف القصّ دون تحميل ملفات عملاقة في الذاكرة)
function readCapped(abs, limit) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(limit + 1);
    const n = fs.readSync(fd, buf, 0, limit + 1, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * يستخرج @المسارات من البرومبت ويعيد برومبت جديداً يسبق نص المستخدم بمحتوى الملفات.
 * @returns {{ prompt: string, attached: Array<{rel:string, bytes:number, truncated:boolean}>,
 *             skipped: Array<{rel:string, reason:'outside'|'binary'|'error'|'total'}> }}
 * ملف غير موجود على القرص يُتجاهل بصمت (@قد لا تكون إشارة ملف أصلاً).
 */
function injectFiles(prompt, cwd) {
  const attached = [];
  const skipped = [];
  if (typeof prompt !== 'string' || !prompt || !cwd) {
    return { prompt: prompt || '', attached, skipped };
  }

  // جمع المسارات الفريدة بترتيب ورودها
  const rels = [];
  const seen = new Set();
  let m;
  while ((m = AT_RE.exec(prompt)) !== null) {
    const rel = m[2].replace(/[.,;:!?)\]}»]+$/, ''); // قصّ ترقيم لاصق بنهاية الإشارة
    if (rel && !seen.has(rel)) { seen.add(rel); rels.push(rel); }
    if (rels.length >= MAX_FILES) break;
  }
  if (!rels.length) return { prompt, attached, skipped };

  let used = 0;
  const blocks = [];
  for (const rel of rels) {
    const abs = resolveInside(cwd, rel);
    if (!abs) { skipped.push({ rel, reason: 'outside' }); continue; }

    let st;
    try { st = fs.statSync(abs); } catch { continue; } // غير موجود — تجاهل صامت
    if (!st.isFile()) continue;

    const budget = Math.min(MAX_FILE, MAX_TOTAL - used);
    if (budget < MIN_BUDGET) { skipped.push({ rel, reason: 'total' }); continue; }

    let buf;
    try { buf = readCapped(abs, budget); } catch { skipped.push({ rel, reason: 'error' }); continue; }
    if (looksBinary(buf)) { skipped.push({ rel, reason: 'binary' }); continue; }

    const truncated = buf.length > budget;
    if (truncated) buf = buf.subarray(0, budget);
    // إزالة محرف بديل مبتور محتمل عند قطع UTF-8 في منتصف حرف
    let content = buf.toString('utf8').replace(/�+$/, '');
    if (truncated) content += '\n…(قُصّ الملف هنا — تجاوز سقف الحجم المسموح بالحقن)';

    used += buf.length;
    attached.push({ rel, bytes: st.size, truncated });
    const fence = fenceFor(content);
    blocks.push('### الملف: ' + rel + '\n' + fence + langOf(rel) + '\n' + content + '\n' + fence);
  }

  if (!blocks.length) return { prompt, attached, skipped };

  const header = 'ملفات مرفقة من مشروع المستخدم (اقرأها ثم أجب عن طلبه الوارد بعدها):\n\n';
  const out = header + blocks.join('\n\n') + '\n\n---\n\n' + prompt;
  return { prompt: out, attached, skipped };
}

// resolveInside/looksBinary/readCapped تُصدَّر ليعيد files.js (عارض القراءة — 1.2)
// استخدام نفس كود الأمان بلا تكرار
module.exports = { injectFiles, resolveInside, looksBinary, readCapped, MAX_FILE, MAX_TOTAL, MAX_FILES };
