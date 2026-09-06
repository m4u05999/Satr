/**
 * «راجع تغييراتي الآن» — مراجعة عمياء cross-engine لتغييرات شجرة العمل، من المحادثة.
 *
 * لماذا: الوكيل الذي كتب الكود لا يراجعه بعينين نظيفتين مهما طُلب منه — رآه وهو
 * يُكتب. ومطوّر منفرد لا زميل يراجع له. فهذه القدرة الوحيدة في غرفة العمليات التي
 * **لا بديل لها** خارجها؛ نُخرجها من سطحٍ يُفتح إلى فعلٍ يُطلب (اقتراح جولة العصف
 * الثلاثي 2026-08-25، وقرار مالك بتنفيذه).
 *
 * ما هي **ليست**: لا worktree، ولا عوامل متوازية، ولا ملكية ملفات، ولا بوابة دمج،
 * ولا خزنة أثر. تلك تبقى في غرفة العمليات كما هي. هذه قراءة رأي مستقل فقط.
 *
 * ثلاثة حدود جوهرية:
 *  1. **لا تلمس فهرس المستخدم**: `git add -N` (كما يفعل worktrees.js داخل نسخته
 *     المؤقتة) يغيّر الفهرس الحقيقي هنا. الملفات غير المتتبَّعة تُلتقط بـ
 *     `git diff --no-index -- /dev/null <path>` — قراءة صرفة.
 *  2. **لا تكتب شيئاً**: لا commit ولا stash ولا checkout. أوامر git بمصفوفة
 *     وسائط بلا shell، وكلها قراءة.
 *  3. **المراجع أعمى**: يُستدعى `reviewer.reviewOnce` القائم بسياسة العمى نفسها
 *     (cwd مؤقت فارغ، `plan`، صفر أدوات، وأي إذن/أداة/كتابة يفشل مغلقاً).
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memory = require('./memory');
const reviewer = require('./reviewer');
const { gitArgs } = require('./gitsafe'); // OBS-136: يُبطل مفاتيح الإعداد المُنفِّذة

const MAX_PATCH_CHARS = 400000;      // سقف reviewer.MAX_PATCH_CHARS نفسه
const MAX_UNTRACKED_FILES = 40;      // ملف جديد لكل نداء git منفصل — سقف يمنع الزحف
const MAX_UNTRACKED_BYTES = 512 * 1024; // ملف جديد أضخم من هذا يُذكر اسمه بلا محتواه
const MAX_FILES_LISTED = 200;
const GIT_TIMEOUT_MS = 20000;
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 600000;

// الاختيار cross-engine: مراجعٌ من محرك غير الذي يعمل في المحادثة. الترتيب تفضيل
// لا إلزام — أول متاح يفوز، وغياب الجميع يعيد خطأ صريح لا مراجعة صورية بالمحرك نفسه.
const REVIEWER_PREFERENCE = Object.freeze({
  sdk: ['codex', 'kimi-code'],
  codex: ['sdk', 'kimi-code'],
  'kimi-code': ['sdk', 'codex'],
});
const FALLBACK_PREFERENCE = Object.freeze(['sdk', 'codex', 'kimi-code']);

function git(cwd, args) {
  return new Promise((resolve) => {
    // OBS-136: تحصين إعداد المستودع المُنفِّذ
    execFile('git', gitArgs(args), {
      cwd, windowsHide: true, encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      if (error && typeof stdout !== 'string') { resolve({ ok: false }); return; }
      resolve({ ok: !error, out: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

function relOf(line) {
  return String(line || '').replace(/\\/g, '/').trim();
}

/**
 * فرق شجرة العمل مقابل HEAD: المتتبَّع عبر `git diff HEAD`، والجديد غير المتتبَّع
 * عبر `--no-index` لكل ملف. يعيد `{ok, patch, files, skipped}` أو خطأً مصنّفاً.
 */
async function collectWorkingPatch(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return { ok: false, error: 'no_repo' };
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return { ok: false, error: 'no_head' };

  const tracked = await git(cwd, ['diff', '--binary', '--full-index', 'HEAD']);
  if (!tracked.ok) return { ok: false, error: 'diff_failed' };

  const others = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = others.ok ? others.out.split('\0').map(relOf).filter(Boolean) : [];

  const parts = tracked.out ? [tracked.out] : [];
  const skipped = [];
  let used = 0;
  for (const rel of untracked) {
    if (used >= MAX_UNTRACKED_FILES) { skipped.push(rel); continue; }
    let size = 0;
    try { size = fs.statSync(path.join(cwd, rel)).size; } catch { skipped.push(rel); continue; }
    if (size > MAX_UNTRACKED_BYTES) { skipped.push(rel); continue; }
    // `--no-index` يخرج برمز 1 عند وجود فرق — وهو الحالة الطبيعية هنا، فنقرأ stdout.
    const one = await git(cwd, ['diff', '--no-index', '--binary', '--', '/dev/null', rel]);
    if (one.out) { parts.push(one.out); used++; } else skipped.push(rel);
  }

  let patch = parts.join('\n');
  if (!patch.trim()) return { ok: false, error: 'no_changes' };
  const truncated = patch.length > MAX_PATCH_CHARS;
  if (truncated) patch = patch.slice(0, MAX_PATCH_CHARS);

  // أسماء الملفات للعرض وللبرومبت — من الفرق نفسه فلا نداء git إضافي.
  const files = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ b/')) continue;
    const rel = relOf(line.slice(6));
    if (rel && rel !== 'dev/null' && !files.includes(rel)) files.push(rel);
    if (files.length >= MAX_FILES_LISTED) break;
  }
  return { ok: true, patch, files, skipped, truncated };
}

function create(options) {
  const settings = options || {};
  const resolveEngine = typeof settings.resolveEngine === 'function' ? settings.resolveEngine : () => null;
  const runReview = typeof settings.reviewOnce === 'function' ? settings.reviewOnce : reviewer.reviewOnce;
  const collect = typeof settings.collect === 'function' ? settings.collect : collectWorkingPatch;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const isolationRoot = path.resolve(settings.isolationRoot || os.tmpdir());
  const timeoutMs = Math.max(1000, Math.min(Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  let active = null; // مراجعة واحدة في كل لحظة — الثانية تعيد busy لا تزاحم الأولى

  // يختار مراجعاً من محرك مختلف. `engine` هو محرك المحادثة الحالي.
  function pickReviewer(engine) {
    const wanted = REVIEWER_PREFERENCE[engine] || FALLBACK_PREFERENCE.filter((name) => name !== engine);
    for (const name of wanted) {
      let runner = null;
      try { runner = resolveEngine(name); } catch { runner = null; }
      if (runner && typeof runner.start === 'function') return { engine: name, runner };
    }
    return null;
  }

  async function start(input) {
    const request = input || {};
    const cwd = typeof request.cwd === 'string' ? request.cwd : '';
    const engine = typeof request.engine === 'string' ? request.engine : '';
    if (!cwd || !path.isAbsolute(cwd)) return { ok: false, error: 'bad_input' };
    if (active) return { ok: false, error: 'busy' };

    const picked = pickReviewer(engine);
    // fail-closed: لا مراجعة بالمحرك نفسه — مراجعٌ رأى الكود وهو يُكتب ليس رأياً مستقلاً
    if (!picked) return { ok: false, error: 'review_engine_unavailable' };

    const collected = await collect(cwd);
    if (!collected.ok) return { ok: false, error: collected.error };
    // حارس الأسرار نفسه الذي يحرس مسار الأثر: لا يُرسل فرقٌ قد يحمل سراً إلى محرك
    if (memory.hasSecret(collected.patch)) return { ok: false, error: 'secret_detected' };

    const startedAt = now();
    const controller = new AbortController();
    active = { controller };
    let node;
    try {
      node = await runReview({
        runner: picked.runner,
        prompt: reviewer.workingTreePrompt(collected.patch, collected.files),
        model: picked.runner.model || null,
        timeoutMs, isolationRoot, now, signal: controller.signal,
      });
    } finally {
      active = null;
    }

    // التقرير المدموج القائم يستهلك شكل الدفعة `[{engine, lenses:[{lens, summary}]}]`.
    // نمرّر زاوية واحدة فنرث كامل خط المعالجة: استخراج البنود الموسومة، **إسقاط ما
    // يلتقطه حارس الأسرار**، قصّ Unicode آمن، الترتيب بالشدّة، والسقف — بلا نسخة ثانية.
    const report = node.state === 'completed'
      ? reviewer.buildMergedReport([{ engine: picked.engine, lenses: [{ lens: 'correctness', summary: node.summary }] }])
      : { items: [], truncated: false };
    return {
      ok: true,
      review: {
        engine: picked.engine,
        state: node.state,
        verdict: node.verdict ? { ...node.verdict } : null,
        summary: node.summary,
        error: node.error,
        items: report.items,
        files: collected.files,
        skipped: collected.skipped,
        // مقصوص = الفرق تجاوز السقف **أو** أُسقط بند/قُصّ نصّه في التقرير
        truncated: collected.truncated === true || report.truncated === true,
        duration_ms: Math.max(0, now() - startedAt),
        cost: { ...node.cost },
      },
    };
  }

  function stop() {
    if (!active) return { ok: true };
    active.controller.abort();
    return { ok: true };
  }

  return { start, stop, pickReviewer, isBusy: () => Boolean(active) };
}

module.exports = {
  create,
  collectWorkingPatch,
  MAX_PATCH_CHARS,
  MAX_UNTRACKED_FILES,
  MAX_UNTRACKED_BYTES,
  REVIEWER_PREFERENCE,
};
