/**
 * حارس `probe-runner` (‏OBS-062) — قطعي، بلا شبكة ولا محرّكات.
 *
 * الفحص الجوهري: **مسبار معلَّق يصير فشلاً صريحاً لا حجباً صامتاً**، وتكمل السلسلة
 * بعده. يُثبَت بـfixture يعلّق عمداً (`fixtures/hanging-probe.js`) لا بمحاكاة منطق
 * المشغّل — الحارس الذي يستورد فرعه من الإنتاج ثم يقارنه بنفسه لا يعضّ.
 *
 * ويغطي كذلك السبب الجذري في `kimi-capability-probe.js`: خروج صريح، ومهلة `unref`،
 * وسلسلة مؤقّتات تنتهي، ومحلّل خط أساس يقبل الحالة المؤهَّلة.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const runner = require('./probe-runner');

let checks = 0;
function ok(label, condition, detail) {
  checks++;
  if (condition) { console.log('  ✓ ' + label); return; }
  console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  process.exitCode = 1;
  throw new assert.AssertionError({ message: label + (detail ? ' — ' + detail : '') });
}

console.log('\n— حدود المهلة —');
ok('الافتراضي 300ث', runner.resolveTimeout(null) === 300000);
ok('قيمة صالحة تُقبل', runner.resolveTimeout(30) === 30000);
ok('قيمة دون الحد تسقط للافتراضي', runner.resolveTimeout(1) === runner.DEFAULT_TIMEOUT_MS);
ok('قيمة فوق الحد تسقط للافتراضي', runner.resolveTimeout(99999) === runner.DEFAULT_TIMEOUT_MS);
ok('نص غير رقمي يسقط للافتراضي', runner.resolveTimeout('صفر') === runner.DEFAULT_TIMEOUT_MS);

console.log('\n— تحليل الوسائط —');
{
  const a = runner.parseArgs(['x.js', 'y.js', '--timeout', '20', '--', '--raw-only']);
  ok('يفصل الملفات عن الوسائط الممرَّرة', a.files.join(',') === 'x.js,y.js', a.files.join(','));
  ok('يقرأ المهلة من السطر', a.timeoutMs === 20000, String(a.timeoutMs));
  ok('يمرّر ما بعد --', a.passThrough.join(',') === '--raw-only', a.passThrough.join(','));
}

console.log('\n— اكتشاف Electron —');
ok('يكتشف مسبار Electron', runner.needsElectron("const { app } = require('electron');"));
ok('لا يعدّ node مسبار Electron', !runner.needsElectron("const fs = require('fs');"));
ok('لا يخدعه ذكر electron نصاً', !runner.needsElectron("// يشبه require('electronics')"));

console.log('\n— السرد —');
{
  const list = runner.listProbes();
  ok('يسرد المسابير', list.length > 10, 'عدد=' + list.length);
  ok('يستبعد ملفات helper', !list.some((n) => /helper/.test(n)), list.filter((n) => /helper/.test(n)).join(','));
}

// الفحص الجوهري: fixture يعلّق عمداً ⇒ يجب أن يُقتل ويُبلَّغ عنه، ثم تكمل السلسلة.
console.log('\n— العضّة: مسبار معلَّق —');
{
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'probe-runner.js'),
    path.join('fixtures', 'hanging-probe.js'),
    'probe-runner-ok-fixture.js',
    '--timeout', '6',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
  const elapsed = Date.now() - started;
  const out = (result.stdout || '') + (result.stderr || '');

  ok('المشغّل نفسه خرج (لم يُحجب)', result.error == null,
    result.error && result.error.code);
  ok('انتهى قرب المهلة لا بعدها بكثير', elapsed < 60000, elapsed + 'ms');
  ok('التعليق بُلِّغ صراحةً', /تجاوز المهلة/.test(out), out.slice(-400));
  ok('التقرير المطبوع قبل التعليق ظاهر', /التقرير اكتمل/.test(out));
  ok('السلسلة أكملت بعد المعلَّق', /\[2\/2\]/.test(out), out.slice(-400));
  ok('المسبار السليم بعده نجح', /probe-runner-ok/.test(out) && /✅/.test(out));
  ok('رمز الخروج غير صفري', result.status === 1, String(result.status));
  ok('الخلاصة تسمّي المعلَّق', /hanging-probe\.js:timeout/.test(out), out.slice(-300));
}

console.log('\n— السبب الجذري في kimi-capability-probe —');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'kimi-capability-probe.js'), 'utf8');
  ok('خروج صريح موجود', /process\.exit\(0\)/.test(src));
  ok('مهلة كلية بـunref', /exitGuard\.unref\(\)/.test(src));
  ok('التقاط uncaughtException', /uncaughtException/.test(src));
  ok('سلسلة الاستقصاء تُمسح', /clearTimeout\(pollTimer\)/.test(src));
  ok('لم تعد السلسلة بلا شرط توقّف',
    !/const check = \(\) => \{ if \(gotChunk\) return resolve\(\); setTimeout\(check, 50\); \};/.test(src));
  ok('قتل الطفل بلا مؤقّت معلَّق', /taskkill/.test(src) && !/setTimeout\(\(\) => \{ try \{ proc\.kill/.test(src));
  ok('الخطأ الإملائي مصحَّح', !/خط الأساب/.test(src) && /لا يوجد فرق عن خط الأساس/.test(src));
}

console.log('\n— محلّل خط الأساس يقبل الحالة المؤهَّلة —');
{
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'KIMI-CAPABILITIES.md'), 'utf8');
  ok('الوثيقة تكتب fork مؤهَّلاً', /session\/fork[^|]*\|[^|]*\*\*مدعوم منذ/.test(doc),
    'الوثيقة تغيّرت — راجع المحلّل');
  // استيراد الدالة الإنتاجية نفسها — لا نسخة منها ولا استخراج بـeval هشّ.
  const kimiProbe = require('./kimi-capability-probe');
  ok('«مدعوم منذ 0.38.0» تُقرأ مدعومة', kimiProbe.is('مدعوم منذ 0.38.0', 'مدعوم') === true);
  ok('«مدعوم» المجرّدة تُقرأ مدعومة', kimiProbe.is('مدعوم', 'مدعوم') === true);
  ok('«غير مدعوم» لا تُقرأ مدعومة', kimiProbe.is('غير مدعوم', 'مدعوم') === false);
  ok('حالة أخرى لا تُقرأ مدعومة', kimiProbe.is('معلن', 'مدعوم') === false);
  ok('القيمة الغائبة لا تُقرأ مدعومة', kimiProbe.is(null, 'مدعوم') === false);

  // خط الأساس الحقيقي من الوثيقة: fork يجب أن يُقرأ مدعوماً الآن فلا يصرخ بفرق معروف
  const baseline = kimiProbe.readBaseline();
  ok('خط الأساس يُقرأ من الوثيقة', baseline && typeof baseline === 'object');
  ok('fork يُقرأ مدعوماً (لا فرق كاذب)', baseline.fork === true, JSON.stringify(baseline));
  ok('undo يبقى غير مدعوم', baseline.undo === false, JSON.stringify(baseline));
  ok('thinking يُقرأ معلناً', baseline.thinking === true, JSON.stringify(baseline));
  ok('terminal يبقى غير موصول', baseline.terminal === false, JSON.stringify(baseline));

  // استيراد المسبار يجب ألّا يشغّله (حارس require.main)
  ok('الاستيراد لا يشغّل مسباراً حياً', /require\.main === module/.test(
    fs.readFileSync(path.join(ROOT, 'scripts', 'kimi-capability-probe.js'), 'utf8')));
}

console.log('\nprobe-runner-test: نجح — ' + checks + ' فحصاً (المهلة تعضّ، والسلسلة تكمل، والسبب الجذري مُصلَح).');
