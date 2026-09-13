#!/usr/bin/env node
'use strict';

/**
 * سطر — الحارس الساكن لسائق القبول الآلي (`npm run test:accept-driver`).
 *
 * السائق الحيّ نفسه **خارج `SUITE`** بسبب معلن (يحتاج نسخة مبنية ودور نموذج حقيقي وشاشة)،
 * فلولا هذا الحارس لبقي عقده بلا شاهد: سيناريو تسقط منه خطوة، أو خطوة بلا معيار مكتوب،
 * أو دالة حكم تعتمد على حالة خارجية فلا تعود العضّة قابلة للإعادة على الأدلة نفسها.
 *
 * ما يفحصه، بلا Electron وبلا شبكة:
 *   1) بنية السيناريوهات الثلاثة: ترقيم متسلسل، `expect` غير فارغ، `judge`/`act` دالتان،
 *      وكل خطوة بشرية تحمل `human: true` ونصّ تعليمات عربياً.
 *   2) `judge('step5', fixture)` يعطي **8/8** على أدلة حقيقية مقصوصة من تشغيل 2026-09-12.
 *   3) **نقاء الحكم**: ثماني نسخ معكوسة، كل واحدة تقلب معيار خطوة واحدة ⇒ تسقط تلك الخطوة
 *      **وحدها**. حارس يقول «8/8» بلا هذا لا يفرّق بين حكم يقرأ الأدلة وحكم يعيد `true`.
 *   4) `--bite` يسقط الخطوة ٥ على الأدلة نفسها (عقد العضّة في `AGENTS.md`).
 *   5) مقتطف التصفير (‏OBS-178) يحذف مفاتيح `satr_` وحدها ويعيد ما حذف.
 *   6) `--dry-run` يخرج 0 للسيناريوهات الثلاثة و1 لسيناريو مجهول.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const driver = require('./accept-driver');
const { SCENARIOS, judge, resetSatrStorage, validateScenario, report, RESET_SNIPPET } = driver;

const ROOT = path.resolve(__dirname, '..');
const DRIVER_FILE = path.join(__dirname, 'accept-driver.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'accept-step5-evidence.json');
const ARABIC = /[؀-ۿ]/;

let checks = 0;
const failures = [];
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

// ── 1) بنية السيناريوهات الثلاثة ──────────────────────────────────────────────
const expectedIds = ['step5', 'connections', 'readability'];
check(Object.keys(SCENARIOS).length === 3, 'السيناريوهات ثلاثة بالضبط (الواقع: ' + Object.keys(SCENARIOS).length + ')');
for (const id of expectedIds) check(!!SCENARIOS[id], 'السيناريو «' + id + '» معلن');

for (const id of Object.keys(SCENARIOS)) {
  const scenario = SCENARIOS[id];
  check(typeof scenario.title === 'string' && ARABIC.test(scenario.title), '«' + id + '»: عنوان عربي');
  check(Array.isArray(scenario.steps) && scenario.steps.length >= 4,
    '«' + id + '»: ≥4 خطوات (الواقع: ' + (scenario.steps || []).length + ')');
  check(typeof scenario.bite === 'string' && ARABIC.test(scenario.bite), '«' + id + '»: وصف العضّة معلن بالعربية');
  check(Array.isArray(scenario.limits) && scenario.limits.length >= 2, '«' + id + '»: حدود معلنة (≥2)');
  scenario.steps.forEach((step, index) => {
    const label = '«' + id + '» الخطوة ' + (step && step.n);
    check(step && step.n === index + 1, label + ': ترقيم متسلسل (المتوقع ' + (index + 1) + ')');
    check(typeof step.title === 'string' && step.title.trim().length > 5, label + ': عنوان غير فارغ');
    check(typeof step.expect === 'string' && step.expect.trim().length > 5 && ARABIC.test(step.expect),
      label + ': `expect` نصّ عربي غير فارغ — بلا معيار مكتوب لا قبول');
    check(typeof step.judge === 'function', label + ': `judge` دالة');
    check(typeof step.act === 'function', label + ': `act` دالة');
    if (step.human) {
      check(step.human === true, label + ': علم الخطوة البشرية `human: true` حرفياً');
      check(typeof step.instructions === 'string' && step.instructions.trim().length >= 20
        && ARABIC.test(step.instructions), label + ': خطوة بشرية بلا نصّ تعليمات عربي كافٍ');
    }
  });
  // نفس العقد كما يراه `--dry-run` — لا تفترق البوابة عن الأداة
  check(validateScenario(scenario).length === 0,
    '«' + id + '»: validateScenario يرى البنية مكتملة (' + validateScenario(scenario).join(' ؛ ') + ')');
}

// الحدّ البشري للأسرار معلَن حيث يُقرأ: خطوات الرموز الشخصية في سيناريو التوصيلات بشرية
const connHuman = SCENARIOS.connections.steps.filter((s) => s.human).map((s) => s.n);
check(connHuman.length >= 3, 'سيناريو التوصيلات يعلن ≥3 خطوات بشرية (الواقع: ' + connHuman.length + ')');
for (const step of SCENARIOS.connections.steps) {
  const mentionsSecret = /رمز|PAT|سرّ/.test(step.title + ' ' + (step.instructions || ''));
  if (mentionsSecret) check(step.human === true, 'خطوة التوصيلات ' + step.n + ' تذكر رمزاً ويجب أن تكون بشرية');
}
// السائق لا يكتب سرّاً: لا مصدر يحوي حقل كلمة/رمز يُملأ برمجياً
const source = fs.readFileSync(DRIVER_FILE, 'utf8');
check(!/\.value\s*=\s*[^;]*(token|secret|password|pat)/i.test(source),
  'مصدر السائق لا يملأ حقل رمز/سرّ برمجياً');

// ── 2) الحكم على أدلة حقيقية: 8/8 ────────────────────────────────────────────
check(fs.existsSync(FIXTURE), 'fixture الأدلة موجود: ' + FIXTURE);
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const rows = judge('step5', fixture, false);
const passCount = rows.filter((r) => r.verdict === 'صواب').length;
check(rows.length === 8, 'سيناريو الخطوة ٥ ثماني خطوات (الواقع: ' + rows.length + ')');
check(passCount === 8, 'judge على الأدلة الحقيقية يعطي 8/8 (الواقع: ' + passCount + '/' + rows.length + ') — '
  + rows.filter((r) => r.verdict !== 'صواب').map((r) => r.n + ':' + r.actual).join(' ؛ '));
for (const row of rows) {
  check(typeof row.actual === 'string' && row.actual.length > 0,
    'الخطوة ' + row.n + ': الحكم يكتب «الفعلي» لا يتركه فارغاً');
}

// ── 3) نقاء الحكم: كل معيار معكوس يُسقط خطوته وحدها ──────────────────────────
const INVERSIONS = [
  { n: 1, why: 'زر سطح ويندوز مخفي', mutate: (ev) => { ev.steps['1'].toggleHidden = true; } },
  { n: 2, why: 'صفّ المفكرة غائب عن اللوحة', mutate: (ev) => { ev.steps['2'].targets = []; } },
  { n: 3, why: 'إشعار التفعيل غائب', mutate: (ev) => { ev.steps['3'].notices = []; } },
  { n: 4, why: 'نصّ المحرّر لم يُحفَظ', mutate: (ev) => { ev.steps['4'].inputValue = 'نصّ آخر'; } },
  {
    n: 5,
    why: '«موافقة دائمة» ظاهر على أداة فعل',
    mutate: (ev) => {
      const hit = ev.perms.find((p) => /desktop_type/.test(p.tool));
      hit.alwaysHidden = false;
    },
  },
  { n: 6, why: 'سطر محادثة بلا dir=rtl', mutate: (ev) => { ev.steps['6'].chatLines[0].dir = ''; } },
  { n: 7, why: 'الملف لم يتغيّر', mutate: (ev) => { ev.fileAfter = ev.fileBefore; } },
  { n: 8, why: 'التحكم بقي مفعّلاً بعد جلسة جديدة', mutate: (ev) => { ev.steps['8'].enabled = true; } },
];
check(INVERSIONS.length === rows.length, 'لكل خطوة نسخة معكوسة (' + INVERSIONS.length + '/' + rows.length + ')');
for (const inversion of INVERSIONS) {
  const mutated = clone(fixture);
  inversion.mutate(mutated);
  const got = judge('step5', mutated, false);
  const failed = got.filter((r) => r.verdict !== 'صواب').map((r) => r.n);
  check(failed.length === 1 && failed[0] === inversion.n,
    'عكس معيار الخطوة ' + inversion.n + ' (' + inversion.why + ') يُسقطها وحدها — الساقط فعلاً: ['
    + failed.join('، ') + ']');
}

// ── 4) العضّة المعلنة: --bite يقلب معيار الخطوة ٥ على الأدلة نفسها ────────────
const biteRows = judge('step5', fixture, true);
const bitePass = biteRows.filter((r) => r.verdict === 'صواب').length;
check(bitePass === 7 && biteRows.find((r) => r.n === 5).verdict === 'فشل',
  '--bite يُسقط الخطوة ٥ وحدها على الأدلة نفسها (' + bitePass + '/8)');
check(/معيار العضّة المعكوس/.test(biteRows.find((r) => r.n === 5).expected),
  'صفّ العضّة يعلن في «المتوقع» أنه معيار معكوس — لا يُقرأ فشلاً حقيقياً');

// ── 5) التقرير: يذكر ما صُفِّر والحدّ البشري ──────────────────────────────────
const md = report('step5', fixture, false);
check(/^# تقرير القبول الآلي/.test(md), 'التقرير يبدأ بعنوان عربي');
check(md.includes('صُفِّرت مفاتيح satr_*'), 'التقرير يذكر سطر تصفير مفاتيح satr_* (‏OBS-178)');
check(md.includes('| # | الفعل | المتوقع | الفعلي | الحكم | الصورة |'), 'جدول الخطوات بالأعمدة الستة');
check(md.includes('**الخلاصة: 8/8'), 'التقرير يعلن الخلاصة 8/8');
check(md.includes('ما نقره السائق نيابةً عن المالك'), 'التقرير يفصل ما نقره السائق نيابةً عن المالك');
const connMd = report('connections', { steps: {}, perms: [], startedAt: '—' }, false);
check(/خطوات \*\*بشرية معلَنة\*\* لم ينفّذها السائق/.test(connMd),
  'تقرير التوصيلات يعلن الخطوات البشرية التي لم ينفّذها السائق');

// ── 6) مقتطف التصفير (‏OBS-178): مفاتيح satr_ وحدها ──────────────────────────
(async () => {
  // المقتطف يُقيَّم على مخزن مزيّف — فيُفحص منطقه لا مجرّد وجود الدالة
  // المفاتيح خصائص ظاهرة والتابعان غير ظاهرين — كي يعمل `Object.keys(localStorage)`
  // الحقيقي على المخزن المزيّف كما يعمل في المتصفح، فيُفحص منطق المقتطف لا محاكاة له.
  const store = { satr_desktop_control: '1', satr_engine: 'sdk', theme: 'dark', other_satr_x: '9' };
  Object.defineProperty(store, 'getItem', { value: (k) => (k in store ? store[k] : null) });
  Object.defineProperty(store, 'removeItem', { value: (k) => { delete store[k]; } });
  const evaluate = (expr) => {
    check(expr === RESET_SNIPPET, 'resetSatrStorage يمرّر مقتطف التصفير المعلن نفسه');
    // eslint-disable-next-line no-new-func
    return new Function('localStorage', 'return ' + expr)(store);
  };
  const removed = await resetSatrStorage(evaluate);
  check(removed.length === 2 && removed.some((r) => r.startsWith('satr_desktop_control=1')),
    'التصفير يعيد ما حُذف مع قيمته (الواقع: ' + JSON.stringify(removed) + ')');
  check(!('satr_desktop_control' in store) && !('satr_engine' in store),
    'مفاتيح satr_ حُذفت فعلاً من المخزن');
  check('theme' in store && 'other_satr_x' in store,
    'ما لا يبدأ بـsatr_ لا يُمسّ (‏theme وother_satr_x باقيان)');
  check((await resetSatrStorage(async () => null)).length === 0,
    'خرج غير مصفوفة يُقرأ «لا مفتاح» لا يُسقط السائق');

  // ── 7) --dry-run: 0 للمعلَن، 1 للمجهول ────────────────────────────────────
  for (const id of expectedIds) {
    const res = spawnSync(process.execPath, [DRIVER_FILE, '--dry-run', '--scenario', id],
      { cwd: ROOT, encoding: 'utf8' });
    check(res.status === 0, '--dry-run «' + id + '» يخرج 0 (الواقع: ' + res.status + ')');
    const steps = SCENARIOS[id].steps;
    check(res.stdout.includes(steps[0].expect), '--dry-run «' + id + '» يطبع معيار الخطوة الأولى');
    check(res.stdout.includes('بنية السيناريو مكتملة (' + steps.length + ' خطوة)'),
      '--dry-run «' + id + '» يعلن عدد الخطوات');
    for (const step of steps.filter((s) => s.human)) {
      check(res.stdout.includes('[يد المالك]') && res.stdout.includes(step.instructions),
        '--dry-run «' + id + '» يطبع تعليمات الخطوة البشرية ' + step.n);
    }
  }
  const unknown = spawnSync(process.execPath, [DRIVER_FILE, '--dry-run', '--scenario', 'nope'],
    { cwd: ROOT, encoding: 'utf8' });
  check(unknown.status === 1, '--dry-run لسيناريو مجهول يخرج 1 (الواقع: ' + unknown.status + ')');

  // سيناريو مزروع النقص (خطوة بلا `expect`) ⇒ رمز 1 وذكر السيناريو والرقم
  const broken = { id: 'broken', title: 'مزروع', bite: 'وصف', limits: ['أ', 'ب'],
    steps: [{ n: 1, title: 'خطوة بلا معيار', act: () => {}, judge: () => ({ ok: true }) }] };
  const problems = validateScenario(broken);
  check(problems.length === 1 && /«broken» الخطوة 1: بلا `expect`/.test(problems[0]),
    'خطوة بلا `expect` تُرفض بذكر السيناريو ورقم الخطوة (الواقع: ' + JSON.stringify(problems) + ')');

  if (failures.length) {
    console.error('accept-driver-test: FAIL');
    for (const failure of failures) console.error('  - ' + failure);
    process.exit(1);
  }
  console.log('accept-driver-test: ok — ' + checks + ' فحصاً؛ ثلاثة سيناريوهات معلنة، '
    + 'الحكم 8/8 على أدلة حقيقية، وكل معيار معكوس يُسقط خطوته وحدها.');
})().catch((error) => {
  console.error('accept-driver-test: سقط باستثناء: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
