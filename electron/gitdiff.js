/**
 * سطر 2.0 — فروقات git للمشروع (الدفعة 4.7 «فرق» من ROADMAP) — قراءة فقط
 *
 * يجيب «ماذا تغيّر في مشروعي منذ آخر التزام؟» في مكان واحد: يسرد الملفات المتغيّرة
 * عبر git ثم يحسب الفرق **بنفسه** — «قبل» من HEAD (git show) و«بعد» من القرص،
 * والحساب بـ diff.js النقية القائمة. لا نحلّل خرج git diff النصي إطلاقاً:
 * بطاقات buildDiff في الواجهة (بمرآة RTL الموروثة) تأخذ نفس عقد file_edit جاهزاً.
 *
 * 🔒 أمان (القاعدة 2):
 * - spawn بمصفوفة وسائط بلا shell (git ثنائي exe لا ‎.cmd) — لا تفسير صدفة.
 * - مسارات الملفات تأتي من خرج git نفسه (-z: فواصل NUL، أسماء عربية خام بلا
 *   اقتباس) لا من الواجهة — لا حقن مسارات. cwd يتحقق منه main.js كالمعتاد.
 * - قراءة فقط: status/show/rev-parse — لا commit ولا checkout ولا أي كتابة
 *   (قرار نطاق مثبّت: «سطر» ليس عميل git؛ أفعال git بند مستقل إن ثبت طلبه).
 *
 * حدود: 100 ملف متغيّر (الأكثر يُعدّ فقط)، تخطّي الثنائي وما يتجاوز 2م.ب
 * (يظهر صفاً بشارة بلا فرق)، وميزانية وقت كلية يعود بعدها جزئياً.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const inject = require('./inject'); // looksBinary — كشف الثنائي الموحّد
const { computeDiff } = require('./diff');

const MAX_FILES = 100;               // سقف الملفات المعروضة
const MAX_SRC = 2 * 1024 * 1024;     // لا فرق لملف أكبر (حد MAX_EDIT_SRC نفسه)
const GIT_TIMEOUT = 15000;           // مهلة أمر git واحد
const TIME_BUDGET = 10000;           // ميزانية كلية للمسح (مللي ثانية)

// تشغيل git بمصفوفة وسائط (بلا shell) — يعيد {ok, out} والخرج Buffer خام
// (أسماء الملفات بايتات UTF-8 مع -z؛ النص يُفكّ عند الحاجة)
function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, timeout: GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, encoding: 'buffer',
    }, (err, stdout) => {
      resolve({ ok: !err, out: stdout || Buffer.alloc(0), code: err && err.code });
    });
  });
}

// تحليل خرج status --porcelain -z: مقاطع NUL، كل مقطع «XY مسار»،
// وإعادة التسمية (X=R/C) يتبعها مقطع إضافي هو المسار القديم
function parseStatusZ(buf) {
  const parts = buf.toString('utf8').split('\0').filter((s) => s.length > 0);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg.length < 4 || seg[2] !== ' ') continue; // مقطع مشوّه — تجاهل
    const x = seg[0], y = seg[1];
    const rel = seg.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') { from = parts[i + 1] || null; i++; }
    entries.push({ x, y, rel, from });
  }
  return entries;
}

// تصنيف حالة الملف للعرض: جديد/محذوف/معدَّل (مبسّط عمداً — التفاصيل الدقيقة
// كالفهرس مقابل شجرة العمل خارج نطاق «لوحة عرض» خفيفة)
function classify(x, y) {
  if (x === '?' || x === 'A') return 'new';
  if (x === 'D' || y === 'D') return 'del';
  return 'mod';
}

const MAX_CARD_LINES = 600; // سقف أسطر البطاقة — نفس MAX_LINES في diff.js

// تحليل خرج git diff الموحّد إلى عقد أسطر diff.js نفسه ({t, text, old, new} + {t:'@'}).
// للملفات المعدَّلة حصراً — **درس مثبّت بالتجربة**: سقف LCS في diff.js (‏400×400)
// يجعل computeDiff يسقط للحذف-ثم-إضافة الكاملين على الملفات الكبيرة (main.js ظهر
// +517 −501 لتعديل ~20 سطراً)، بينما فرق git دقيق لأي حجم. الجديد/المحذوف يبقيان
// على computeDiff (طرف فارغ = حساب تافه بلا LCS).
function parseUnified(buf) {
  const lines = [];
  let added = 0, removed = 0, truncated = false;
  let o = 0, n = 0, inHunk = false;
  for (const raw of buf.toString('utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) continue;
      o = parseInt(m[1], 10); n = parseInt(m[2], 10);
      inHunk = true;
      // علامة طيّ بين المقاطع (وقبل الأول إن لم يبدأ من رأس الملف)
      if (lines.length ? lines[lines.length - 1].t !== '@' : (o > 1 || n > 1)) lines.push({ t: '@' });
      continue;
    }
    if (!inHunk || line === '' || line.startsWith('\\')) continue; // ترويسات/سطر «لا نهاية سطر»
    const c = line[0], body = line.slice(1);
    if (c === '+') {
      added++;
      if (lines.length < MAX_CARD_LINES) lines.push({ t: '+', text: body, old: null, new: n }); else truncated = true;
      n++;
    } else if (c === '-') {
      removed++;
      if (lines.length < MAX_CARD_LINES) lines.push({ t: '-', text: body, old: o, new: null }); else truncated = true;
      o++;
    } else if (c === ' ') {
      if (lines.length < MAX_CARD_LINES) lines.push({ t: ' ', text: body, old: o, new: n }); else truncated = true;
      o++; n++;
    }
  }
  return { added, removed, lines, truncated };
}

/**
 * تغييرات المستودع منذ HEAD: {ok, repo, files:[...], more, partial}
 * كل ملف: {rel, kind:'new'|'del'|'mod', renamedFrom?, skipped?, added, removed, lines, truncated}
 * skipped: 'binary'|'big'|'error' — صف بلا فرق (شارة فقط).
 */
async function changes(cwd) {
  // جذر المستودع (مسارات status نسبية إليه لا إلى cwd الفرعي المحتمل)
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    if (top.code === 'ENOENT') return { ok: false, error: 'no_git' }; // git غير مثبّت
    return { ok: true, repo: false };
  }
  const root = top.out.toString('utf8').trim();
  if (!root) return { ok: true, repo: false };

  // مستودع بلا أي التزام بعد (لا HEAD): كل شيء «جديد» والقبل فارغ
  const hasHead = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;

  const st = await runGit(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!st.ok) return { ok: false, error: 'error' };
  const entries = parseStatusZ(st.out);

  const started = Date.now();
  const files = [];
  let partial = false;
  for (const e of entries.slice(0, MAX_FILES)) {
    if (Date.now() - started > TIME_BUDGET) { partial = true; break; }
    const kind = classify(e.x, e.y);
    // staged: للفهرس تغيير عن HEAD (X غير فراغ وغير '?') — تستهلكه اللوحة لعرض زر
    // التجهيز/إلغائه (أفعال git). قراءة فقط — لا فعل هنا.
    const staged = e.x !== ' ' && e.x !== '?';
    const row = { rel: e.rel, kind, staged, renamedFrom: e.from || undefined };
    try {
      // «قبل» من HEAD (المسار القديم عند إعادة التسمية) — غير موجود فيه = null (جديد)
      let before = null;
      if (hasHead && kind !== 'new') {
        const show = await runGit(cwd, ['show', 'HEAD:' + (e.from || e.rel)]);
        before = show.ok ? show.out : null;
      }
      // «بعد» من القرص — المحذوف بعده null
      let after = null;
      if (kind !== 'del') {
        const abs = path.join(root, e.rel);
        const stt = fs.statSync(abs);
        if (!stt.isFile()) throw new Error('notfile');
        if (stt.size > MAX_SRC || (before && before.length > MAX_SRC)) { row.skipped = 'big'; files.push(row); continue; }
        after = fs.readFileSync(abs);
      }
      if ((before && inject.looksBinary(before)) || (after && inject.looksBinary(after))) {
        row.skipped = 'binary'; files.push(row); continue;
      }
      if (before && before.length > MAX_SRC) { row.skipped = 'big'; files.push(row); continue; }
      let d = null;
      if (kind === 'mod' && hasHead) {
        // معدَّل: فرق git الموحّد (دقيق لأي حجم — انظر parseUnified)؛ الفشل يسقط لـ computeDiff
        const args = ['diff', 'HEAD', '--no-color', '--unified=3', '-M', '--'];
        if (e.from) args.push(e.from);
        args.push(e.rel);
        const du = await runGit(cwd, args);
        if (du.ok) d = parseUnified(du.out);
      }
      if (!d) {
        // جديد/محذوف/بلا HEAD: طرف فارغ = حساب تافه في computeDiff (لا سقف LCS).
        // توحيد نهايات الأسطر قبل الفرق (درس مثبّت): git يخزّن LF بينما القرص على
        // ويندوز CRLF (autocrlf) — بدون التوحيد يظهر الملف كله «متغيّراً» زوراً
        const bs = before ? before.toString('utf8').replace(/\r\n/g, '\n') : '';
        const as = after ? after.toString('utf8').replace(/\r\n/g, '\n') : '';
        d = computeDiff(bs, as);
      }
      row.added = d.added; row.removed = d.removed; row.lines = d.lines; row.truncated = d.truncated;
      files.push(row);
    } catch {
      row.skipped = 'error';
      files.push(row);
    }
  }

  return { ok: true, repo: true, files, more: Math.max(0, entries.length - MAX_FILES), partial };
}

module.exports = { changes };
