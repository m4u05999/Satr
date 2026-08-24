#!/usr/bin/env electron
'use strict';

/**
 * مسبار حيّ لـ«راجع تغييراتي الآن» — يشغّل **محرّكاً حقيقياً** على تغييرات حقيقية.
 *
 * لماذا مسبار لا اختبار طقم: يستهلك دوراً حقيقياً بكلفة فعلية ويحتاج محرّكاً مثبّتاً
 * ومسجّل الدخول، فيبقى **خارج `test:full`** عمداً مثل بقية مسابير المحرّكات
 * (`loop-live-probe`, `codex-*-probe`). الحارس القطعي `test:reviewchanges` هو الذي
 * يحرس العقد؛ هذا يثبت أن السلك يعمل مع نموذج فعلي.
 *
 *   npx electron scripts/reviewchanges-live-probe.js [--engine codex|sdk|kimi-code]
 *
 * الافتراضي: مستودع «سطر» نفسه بتغييراته غير الملتزمة. إن كانت الشجرة نظيفة يُنشئ
 * ملف عيّنة مؤقتاً باسم فريد ثم يحذفه.
 *
 * ثلاثة تصحيحات جاءت من **أول تشغيل حيّ لهذا المسبار نفسه**: المراجع الأعمى (Codex)
 * رصد أن العيّنة كانت (١) بمسار ثابت يدوس ملفاً قائماً، و(٢) داخل `dist/` وهو
 * متجاهَل في `.gitignore` فلا يراه `collectWorkingPatch` أصلاً — أي أن مسار الشجرة
 * النظيفة كان **معطّلاً بصمت**، و(٣) أن فحوص الخروج لا تشترط اكتمال المراجعة.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const reviewchangesModule = require(path.join(ROOT, 'electron', 'reviewchanges'));
const codex = require(path.join(ROOT, 'electron', 'codex'));
const kimi = require(path.join(ROOT, 'electron', 'kimi'));
const agent = require(path.join(ROOT, 'electron', 'agent'));

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// نسخة مصغّرة من resolveOpsRoomRunner في main.js — المسبار لا يحمّل main.js كاملاً.
function resolveEngine(name) {
  if (name === 'sdk') {
    return { engine: name, model: 'claude-opus-4-8', start: (input, cwd, emit) => agent.start(input, cwd, emit, { mode: 'ops-room' }) };
  }
  if (name === 'codex') {
    return { engine: name, model: codex.DEFAULT_MODEL, start: (input, cwd, emit) => codex.start(input, cwd, emit) };
  }
  if (name === kimi.ENGINE_ID) {
    if (!kimi.resolveKimiBin() || !kimi.authStatus().ok) return null;
    return { engine: name, model: kimi.DEFAULT_MODEL, start: (input, cwd, emit) => kimi.start({ ...input, keepAlive: false }, cwd, emit) };
  }
  return null;
}

async function main() {
  const chatEngine = arg('engine', 'sdk'); // محرك «المحادثة» — يُستبعد من المراجعة
  const cwd = path.resolve(arg('cwd', ROOT));
  const service = reviewchangesModule.create({ resolveEngine, timeoutMs: 300000 });

  const picked = service.pickReviewer(chatEngine);
  console.log('محرك المحادثة (مستبعَد):', chatEngine);
  console.log('المراجع المختار:', picked ? picked.engine + ' / ' + (picked.runner.model || 'افتراضي المحرك') : 'لا يوجد');
  if (!picked) { console.error('فشل: لا محرك آخر جاهز.'); app.exit(1); return; }

  // عيّنة مؤقتة إن كانت الشجرة نظيفة. **باسم فريد** فلا تدوس ملفاً قائماً، و**خارج
  // المسارات المتجاهَلة** وإلا لم يرها الالتقاط أصلاً (كلاهما بلاغ المراجع الحي).
  let sample = '';
  const probe = await reviewchangesModule.collectWorkingPatch(cwd);
  if (!probe.ok && probe.error === 'no_changes') {
    const unique = 'satr-review-probe-' + process.pid + '-' + Date.now().toString(36) + '.js';
    sample = path.join(cwd, unique);
    if (fs.existsSync(sample)) { console.error('فشل: مسار العيّنة مشغول — ' + unique); app.exit(1); return; }
    fs.writeFileSync(sample, 'function parse(x) { return JSON.parse(x); }\nmodule.exports = { parse };\n', { encoding: 'utf8', flag: 'wx' });
    const after = await reviewchangesModule.collectWorkingPatch(cwd);
    if (!after.ok || !after.files.includes(unique)) {
      try { fs.unlinkSync(sample); } catch {}
      console.error('فشل: العيّنة غير مرئية للالتقاط (مسار متجاهَل؟) — ' + unique); app.exit(1); return;
    }
    console.log('الشجرة كانت نظيفة — أُنشئت عيّنة مؤقتة مرئية للالتقاط:', unique);
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await service.start({ cwd, engine: chatEngine });
  } finally {
    // فشل الحذف يُقال صراحةً: شجرة كانت نظيفة يجب ألّا تبقى متسخة بصمت
    if (sample) {
      try { fs.unlinkSync(sample); }
      catch (error) { console.error('⚠️ تعذّر حذف العيّنة المؤقتة — احذفها يدوياً: ' + sample); }
    }
  }

  if (!result.ok) { console.error('فشل:', result.error); app.exit(1); return; }
  const review = result.review;
  // تحقق بنيوي **قبل** أي وصول إلى الحقول: ردّ ناقص يجب أن يصير تقرير فشل واضحاً
  // لا استثناءً مبهماً (بلاغ المراجع الحي، الجولة الثانية).
  if (!review || !Array.isArray(review.files) || !Array.isArray(review.items) || typeof review.state !== 'string') {
    console.error('فشل: بنية المراجعة غير متوقعة —', JSON.stringify(review).slice(0, 300));
    app.exit(1); return;
  }
  console.log('---');
  console.log('الحالة:', review.state, '| المدة:', Math.round(review.duration_ms / 1000) + 'ث',
    '| الكلفة:', (review.cost && review.cost.usd != null ? '$' + review.cost.usd : 'غير معلنة'));
  console.log('الحكم:', review.verdict ? review.verdict.decision + ' (' + review.verdict.source + ')' : 'لا حكم');
  console.log('الملفات المراجَعة:', review.files.length, '| بنود المخاطر:', review.items.length);
  for (const item of review.items.slice(0, 8)) console.log('  [' + item.severity + '] ' + item.text);
  console.log('--- الملخّص ---');
  console.log((review.summary || review.error || '(فارغ)').slice(0, 2500));

  // فحوص صدق على الناتج الحيّ. **تصحيحان من أول تشغيل**: (١) اشتراط الاكتمال صراحةً
  // وإلا مرّت مراجعة غير مكتملة بنجاح، و(٢) فحص التسرّب على الحقول **البنيوية** لا
  // على JSON كاملاً — الأخير يشمل نثر المراجع، وقد أطلق إنذاراً كاذباً حين اقتبس
  // المراجع سلسلة `diff --git` وهو يصف هذا الفحص نفسه.
  const problems = [];
  if (review.engine === chatEngine) problems.push('راجع المحرك نفسه');
  if (review.state !== 'completed') problems.push('لم تكتمل المراجعة: ' + review.state);
  if (review.state === 'completed' && !review.verdict) problems.push('اكتملت بلا حكم');
  // النصوص **خاماً** لا عبر JSON.stringify: الأخير يهرّب الأسطر الجديدة إلى `\n`
  // فلا يطابقها `^` مع العلم m — أي أن الفحص كان معطّلاً ويعلن السلامة كذباً
  // (بلاغ المراجع الحي على إصلاحي السابق نفسه).
  const structural = [...review.files, ...review.items.map((item) => item.text)].join('\n');
  if (/^\+\+\+ b\//m.test(structural) || /^diff --git /m.test(structural) || /^@@ -\d/m.test(structural)) {
    problems.push('تسرّب الفرق الخام إلى الحقول البنيوية');
  }
  console.log('---');
  console.log(problems.length ? 'مشاكل: ' + problems.join(' · ') : 'المسبار الحي: سليم — رأي مستقل بحكم، بلا تسرّب الفرق.');
  app.exit(problems.length ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
  console.error('reviewchanges-live-probe:', error && error.stack ? error.stack : error);
  app.exit(1);
});
