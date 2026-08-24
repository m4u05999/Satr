/**
 * سطر 2.0 — سرد ملفات المشروع لمنصّة @ (قراءة فقط) — المرحلة 4
 *
 * يمشي شجرة مجلد المشروع مرة واحدة (مع تجاهل المجلدات الثقيلة) ويعيد قائمة
 * مسارات نسبية بفواصل «/» (محمولة عبر المنصّات وتفهمها أداة Read مباشرة).
 * النتيجة تُخزَّن مؤقتاً لكل cwd مدة قصيرة فالواجهة ترشّح محلياً عند كل حرف
 * دون إعادة مشي الشجرة. المشي محدود بعمق وعدد ملفات لئلا يتجمّد على مستودع ضخم.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const inject = require('./inject'); // إعادة استخدام resolveInside/looksBinary/readCapped (أمان موحّد)

// مجلدات لا قيمة لذكرها في @ وتُبطئ المشي — نتجاهلها كلياً
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
  '.next', '.nuxt', 'coverage', '.cache', '.idea', '.vscode', '.turbo',
]);
const MAX_FILES = 6000;   // سقف عدد الملفات المُعادة (يكفي لترشيح مريح)
const MAX_DEPTH = 12;     // أقصى عمق تداخل للمجلدات
const CACHE_TTL = 15000;  // عمر المخزن المؤقت لكل cwd (مللي ثانية)

const cache = new Map(); // cwd → { time, files }

// مشي تكراري محدود؛ يعيد مسارات نسبية بفواصل «/»
async function walk(root) {
  const results = [];
  async function rec(dir, depth, rel) {
    if (results.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= MAX_FILES) return;
      const name = e.name;
      const childRel = rel ? rel + '/' + name : name;
      // الروابط الرمزية تُعامل كملفات (isDirectory تكون false لها) فلا حلقات لانهائية
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        await rec(path.join(dir, name), depth + 1, childRel);
      } else if (e.isFile()) {
        results.push(childRel);
      }
    }
  }
  await rec(root, 0, '');
  return results;
}

// قائمة ملفات المجلد (مع تخزين مؤقت). cwd مُتحقَّق منه أنه مجلد قائم.
async function listFiles(cwd) {
  if (typeof cwd !== 'string' || !cwd) return [];
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.time < CACHE_TTL) return hit.files;
  try { if (!(await fsp.stat(cwd)).isDirectory()) return []; } catch { return []; }
  const files = await walk(cwd);
  cache.set(cwd, { time: now, files });
  return files;
}

// ---------- عارض القراءة (الدفعة 1.2 من ROADMAP) ----------

const MAX_VIEW = 256 * 1024; // سقف المعروض في عارض القراءة (بايت)
// نافذة «قيد الكتابة» (تغذية راجعة 2026-08-24، العيب ③): ملف عُدّل قبل أقل من هذه المدة
// قد يكون منتصف كتابة كاتب آخر، فالنسخة المقروءة ناقصة بلا أي إشارة. لا قفل هنا — القفل
// المشترك بين عمليات مستقلة غير متاح لنا، والادعاء به أسوأ من الصراحة بالاحتمال.
// **حدّ مُصرَّح به**: هذا يغطي files.readText وحدها (read_file للمحوّلات وحقن @ والعارض)؛
// أدوات Read الأصلية في Claude وCodex وKimi خارج سيطرتنا ولا يشملها هذا التنبيه.
const WRITE_WINDOW_MS = 1500;

function contentVersion(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * قراءة ملف نصّي للعرض فقط — التحقق موحّد مع inject.js:
 * المسار داخل cwd حصراً، رفض الثنائي، قراءة بسقف (لا تحميل ملفات عملاقة).
 * @returns {{ok:true, content:string, truncated:boolean, bytes:number, version:string|null} |
 *           {ok:false, error:'outside'|'notfound'|'binary'|'error'}}
 */
function readText(cwd, rel) {
  const abs = inject.resolveInside(cwd, rel);
  if (!abs) return { ok: false, error: 'outside' };
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, error: 'notfound' }; }
  if (!st.isFile()) return { ok: false, error: 'notfound' };
  let buf;
  try { buf = inject.readCapped(abs, MAX_VIEW); } catch { return { ok: false, error: 'error' }; }
  if (inject.looksBinary(buf)) return { ok: false, error: 'binary' };
  const truncated = buf.length > MAX_VIEW;
  if (truncated) buf = buf.subarray(0, MAX_VIEW);
  // إزالة محرف بديل مبتور محتمل عند قطع UTF-8 في منتصف حرف — عند القص فقط.
  let content = buf.toString('utf8');
  if (truncated) content = content.replace(/�+$/, '');
  // recentlyWritten: الفارق بين mtime ولحظة القراءة داخل نافذة الكتابة. أفضل جهد —
  // نظام الملفات قد يؤخّر mtime، فالغياب لا يعني أن الملف مستقر.
  const age = Date.now() - st.mtimeMs;
  const recentlyWritten = Number.isFinite(age) && age >= 0 && age < WRITE_WINDOW_MS;
  return {
    ok: true, content, truncated, bytes: st.size, recentlyWritten,
    version: truncated ? null : contentVersion(content),
  };
}

module.exports = { listFiles, readText, contentVersion, WRITE_WINDOW_MS };
