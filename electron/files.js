/**
 * سطر 2.0 — سرد ملفات المشروع لمنصّة @ (قراءة فقط) — المرحلة 4
 *
 * يمشي شجرة مجلد المشروع مرة واحدة (مع تجاهل المجلدات الثقيلة) ويعيد قائمة
 * مسارات نسبية بفواصل «/» (محمولة عبر المنصّات وتفهمها أداة Read مباشرة).
 * النتيجة تُخزَّن مؤقتاً لكل cwd مدة قصيرة فالواجهة ترشّح محلياً عند كل حرف
 * دون إعادة مشي الشجرة. المشي محدود بعمق وعدد ملفات لئلا يتجمّد على مستودع ضخم.
 */

const path = require('path');
const fsp = require('fs/promises');

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

module.exports = { listFiles };
