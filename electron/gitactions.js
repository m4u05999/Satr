/**
 * سطر 2.0 — أفعال git للوحة «تغييرات المشروع» ± (دفعة «أفعال git»)
 *
 * الجانب الكاتب المقابل لـ gitdiff.js (الذي يبقى **قراءة فقط** بعقده). أربعة أفعال:
 * stage / unstage / discard / commit. اللوحة كانت عرضاً فقط — هذا يضيف التجهيز
 * والالتزام والتجاهل دون أن يصير «سطر» عميل git كاملاً (لا فروع ولا دمج ولا دفع).
 *
 * 🔒 أمان (القاعدة 2) — أسماء الملفات العربية تدخل وسائط git:
 * - **المسار يُتحقَّق منه مقابل مجموعة تغييرات git الحيّة**: نعيد قراءة
 *   `git status -z` هنا (المرجع الموثوق) ونرفض أي rel ليس من مساراتها الفعلية.
 *   فالواجهة لا تستطيع حقن مسار عشوائي (‎../‎ أو مطلق) — يُرفض لأنه ليس متغيّراً.
 * - execFile بمصفوفة وسائط **بلا shell** (git ثنائي exe لا ‎.cmd) + فاصل `--`
 *   قبل المسار — لا تفسير صدفة ولا خلط وسائط بمسار يبدأ بـ ‎-‎.
 * - الحذف (discard لملف غير متتبَّع) يمرّ بـ fs داخل جذر المستودع حصراً (فحص
 *   path.resolve) وعلى ملف فعلي — لا حذف مجلدات ولا خارج الجذر.
 * - رسالة الالتزام تُمرَّر عبر `-m` كوسيط (لا صدفة)، بسقف طول.
 *
 * الأفعال المدمّرة (discard) تُؤكَّد في الواجهة (confirm) قبل استدعاء هذا المحرك.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { gitArgs } = require('./gitsafe'); // OBS-136: يُبطل مفاتيح الإعداد المُنفِّذة

const GIT_TIMEOUT = 15000;
const MAX_MSG = 2000; // سقف طول رسالة الالتزام

// تشغيل git بمصفوفة وسائط (بلا shell) — يعيد {ok, out, err, code}
function runGit(cwd, args, opts) {
  return new Promise((resolve) => {
    // OBS-136: فئةٌ **غير** التي تحرسها كتلة الأمان أدناه — تلك تمنع حقن الوسائط،
    // وهذه تمنع تنفيذاً يقع داخل git نفسه بمفتاح من `.git/config`.
    execFile('git', gitArgs(args), {
      cwd, timeout: GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, encoding: 'buffer', ...(opts || {}),
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: (stdout || Buffer.alloc(0)).toString('utf8'),
        err: (stderr || Buffer.alloc(0)).toString('utf8'),
        code: err && err.code,
      });
    });
  });
}

// مقاطع status --porcelain -z: كل مقطع «XY مسار»، وإعادة التسمية تتبعها مقطع المسار القديم.
// نعيد {root, hasHead, entries:[{x,y,rel,from}], paths:Set} — paths مرجع التحقق.
async function statusOf(cwd) {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    if (top.code === 'ENOENT') return { error: 'no_git' };
    return { error: 'no_repo' };
  }
  const root = top.out.trim();
  if (!root) return { error: 'no_repo' };
  const hasHead = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;

  const st = await runGit(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!st.ok) return { error: 'error' };
  // نفكّ -z يدوياً (بايتات خام مع الترميز buffer→utf8 يفكّ الأسماء العربية)
  const parts = st.out.split('\0').filter((s) => s.length > 0);
  const entries = [];
  const paths = new Set();
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg.length < 4 || seg[2] !== ' ') continue;
    const x = seg[0], y = seg[1];
    const rel = seg.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') { from = parts[i + 1] || null; i++; }
    entries.push({ x, y, rel, from });
    paths.add(rel);
    if (from) paths.add(from);
  }
  return { root, hasHead, entries, paths };
}

// تحقّق موحّد: المسار المطلوب موجود ضمن تغييرات git الحيّة — وإلا رفض
function findEntry(status, rel) {
  if (!status.paths.has(rel)) return null;
  return status.entries.find((e) => e.rel === rel) || null;
}

// تجهيز ملف (git add) — يجهّز أيضاً الحذف (git add يرصد الإزالة)
async function stage(cwd, rel) {
  const status = await statusOf(cwd);
  if (status.error) return { ok: false, error: status.error };
  if (!findEntry(status, rel)) return { ok: false, error: 'not_changed' };
  const r = await runGit(cwd, ['add', '--', rel]);
  return r.ok ? { ok: true } : { ok: false, error: 'error', message: r.err.trim() };
}

// إلغاء تجهيز ملف (git restore --staged) — يبقي شجرة العمل كما هي
async function unstage(cwd, rel) {
  const status = await statusOf(cwd);
  if (status.error) return { ok: false, error: status.error };
  if (!findEntry(status, rel)) return { ok: false, error: 'not_changed' };
  // بلا HEAD (مستودع بلا التزام): إلغاء تجهيز مضاف = rm --cached
  const r = status.hasHead
    ? await runGit(cwd, ['restore', '--staged', '--', rel])
    : await runGit(cwd, ['rm', '--cached', '--', rel]);
  return r.ok ? { ok: true } : { ok: false, error: 'error', message: r.err.trim() };
}

// تجاهل تغييرات ملف (مدمّر — الواجهة تؤكّد أولاً): المتتبَّع يُعاد لـ HEAD،
// وغير المتتبَّع/الجديد يُحذف من القرص (داخل الجذر حصراً)
async function discard(cwd, rel) {
  const status = await statusOf(cwd);
  if (status.error) return { ok: false, error: status.error };
  const entry = findEntry(status, rel);
  if (!entry) return { ok: false, error: 'not_changed' };

  // موجود في HEAD؟ (متتبَّع بتغيير) ⇐ استعادة الفهرس وشجرة العمل من HEAD
  const inHead = status.hasHead && (await runGit(cwd, ['cat-file', '-e', 'HEAD:' + rel])).ok;
  if (inHead) {
    const r = await runGit(cwd, ['checkout', 'HEAD', '--', rel]);
    return r.ok ? { ok: true } : { ok: false, error: 'error', message: r.err.trim() };
  }

  // غير موجود في HEAD (جديد — متتبَّع مضاف أو غير متتبَّع): ألغِ التجهيز إن كان مجهَّزاً ثم احذف
  if (entry.x !== ' ' && entry.x !== '?') {
    await runGit(cwd, ['rm', '--cached', '--', rel]); // أفضل جهد — قد لا يكون مجهَّزاً
  }
  // حذف الملف من القرص — داخل الجذر حصراً وعلى ملف فعلي (دفاع بالعمق فوق تحقّق status)
  const abs = path.resolve(status.root, rel);
  const rootAbs = path.resolve(status.root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { ok: false, error: 'outside' };
  try {
    const stt = fs.statSync(abs);
    if (stt.isFile()) fs.rmSync(abs);
  } catch { /* غير موجود أصلاً — لا شيء */ }
  return { ok: true };
}

// التزام المُجهَّز برسالة (git commit -m) — يعيد الهاش المختصر أو خطأ مفهوم
async function commit(cwd, message) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'empty_message' };
  const status = await statusOf(cwd);
  if (status.error) return { ok: false, error: status.error };
  // هل يوجد مُجهَّز؟ (X غير فراغ وغير '?') — وإلا رسالة واضحة بدل خطأ git خام
  const staged = status.entries.some((e) => e.x !== ' ' && e.x !== '?');
  if (!staged) return { ok: false, error: 'nothing_staged' };

  const r = await runGit(cwd, ['commit', '-m', msg.slice(0, MAX_MSG)]);
  if (!r.ok) return { ok: false, error: 'error', message: (r.err || r.out).trim() };
  const h = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash: h.ok ? h.out.trim() : '' };
}

module.exports = { stage, unstage, discard, commit };
