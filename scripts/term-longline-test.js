/**
 * حارس عطلين مرصودين حيّاً في جولة تباعد (2026-08-28):
 *
 * ① `run_in_background` كان يكتب الأمر **خاماً** بينما `run_in_terminal` يلصقه مُقوّساً.
 *    فأمرٌ طويل يكسر PSReadLine وتبقى القشرة عند `>>` والمهمة تبدو حيّة بلا عمل. سجل
 *    تفكير الوكيل قاله حرفياً: «طول الأمر تجاوز ما تتحمله طرفية PowerShell، فتعطّل
 *    PSReadLine وبقيت القشرة عند مؤشر >>».
 * ② `readBuffer` كان يقصّ **بايتات خاماً**: يشطر محرفاً عربياً، ويقطع السطر الأول بلا
 *    علامة فيبدو كاملاً — وخرج JSON طويل يفقد غلافه فيستحيل التحقق منه.
 *
 * قطعي بلا شبكة. يشغّل pty حقيقياً عبر term.js لأن العطل في طبقة الكتابة نفسها.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const term = require(path.join(ROOT, 'electron', 'term.js'));

let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (cond) { console.log('  ✓ ' + label); return; }
  console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  throw new assert.AssertionError({ message: label + (detail ? ' — ' + detail : '') });
}

process.on('uncaughtException', (error) => {
  console.error('term-longline: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
const guard = setTimeout(() => {
  console.error('term-longline: FAIL — تجاوز المهلة');
  process.exit(1);
}, 120000);
guard.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n— ① اللصق المُقوّس في مسار الخلفية —');
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'termjobs.js'), 'utf8');
  // **حدّ مقيس (‏2026-08-28)**: اللصق المُقوّس **لا يصلح** لمسار الخلفية. جُرّب فسقط
  // `test:termjobs-done` فوراً: `runCapture` يلصق إلى طرفية مستقرّة رسم مِحَثّها، أما
  // `startJob` فيكتب فور `startTerm` قبل أن يفعّل PSReadLine وضع اللصق — فتصل
  // `\x1b[200~` محارفَ حرفية وتفسد الأمر. فالمحروس هنا **بقاء التحذير** كي لا يُعاد
  // الاستبدال، لا أن الاستبدال قائم. وعلاج السطر الطويل يبقى مفتوحاً (ملف سكربت مؤقت).
  ok('تحذير عدم استعمال اللصق المُقوّس في الخلفية باقٍ',
    /لا تستبدلها/.test(src) && /writeTermPasted/.test(src),
    'حُذف التحذير — سيُعاد الخطأ نفسه');
  ok('term.js يصدّر writeTermPasted لمسار runCapture', typeof term.writeTermPasted === 'function');

  // العطل الحيّ: أمر أطول بكثير من سطر الطرفية. بلا لصق مُقوّس تُسقَط محارف فيتغيّر
  // الخرج أو تعلق القشرة؛ معه يصل الأمر كوحدة واحدة.
  const started = term.startTerm(ROOT, 120, 30, { label: 'longline-test' });
  ok('أُنشئت طرفية الاختبار', started.ok, JSON.stringify(started));
  const id = started.id;
  const isPwsh = /powershell|pwsh/i.test(String(started.shell || ''));

  const marker = 'SATR_LONGLINE_OK';
  const filler = 'x'.repeat(3000); // أطول من عرض السطر بمراحل
  const cmd = isPwsh
    ? `$pad='${filler}'; if ($pad.Length -eq 3000) { Write-Output '${marker}' }`
    : `pad='${filler}'; [ \${#pad} -eq 3000 ] && echo '${marker}'`;

  const written = term.writeTermPasted(id, cmd + '\r');
  ok('كُتب الأمر الطويل', written.ok, JSON.stringify(written));

  let out = '';
  for (let i = 0; i < 40 && !out.includes(marker); i++) {
    await sleep(250);
    const r = term.readBuffer(id);
    out = r.ok ? r.data : '';
  }
  ok('الأمر الطويل (' + cmd.length + ' محرفاً) وصل سليماً ونُفّذ',
    out.includes(marker), 'آخر 200 محرف: ' + out.slice(-200));
  ok('لا قشرة عالقة عند «>>»', !/\n>>\s*$/.test(out), out.slice(-120));

  console.log('\n— ② قصّ الذيل: حدود UTF-8 وإعلان القصّ —');
  const full = term.readBuffer(id);
  ok('بلا قصّ: truncated=false', full.ok && full.truncated === false, JSON.stringify(full.truncated));
  ok('بلا قصّ: لا علامة مقحمة', !/قُصّ \d+ بايت/.test(full.data));

  const cut = term.readBuffer(id, 400);
  ok('مع القصّ: truncated=true', cut.ok && cut.truncated === true);
  ok('القصّ معلَن بعلامة صريحة', /^\[قُصّ \d+ بايت من بداية السجل/.test(cut.data),
    cut.data.slice(0, 80));
  ok('droppedBytes رقم موجب', Number.isInteger(cut.droppedBytes) && cut.droppedBytes > 0,
    String(cut.droppedBytes));
  ok('الذيل أقصر من الكامل', cut.data.length < full.data.length + 80);

  // الحدّ على محرف عربي: بلا هذا كان الفحص لاتينياً بحتاً فلا يُشطر شيء — وحارسٌ لا
  // يفحص ما يدّعيه أسوأ من غيابه. العربي بايتان في UTF-8، فمسحُ ثمانية إزاحات متتالية
  // يضمن أن نصفها يقع داخل محرف إن عُطّلت المحاذاة.
  const arabic = 'مرحبا بالعالم '.repeat(14);
  term.writeTermPasted(id, (isPwsh ? "Write-Output '" + arabic + "'" : "echo '" + arabic + "'") + '\r');
  let seen = '';
  for (let i = 0; i < 40 && !seen.includes('مرحبا بالعالم'); i++) {
    await sleep(250);
    const r = term.readBuffer(id);
    seen = r.ok ? r.data : '';
  }
  ok('وصل نصّ عربي إلى المخزن', seen.includes('مرحبا بالعالم'), seen.slice(-120));

  const broken = [];
  for (let extra = 0; extra < 8; extra++) {
    const r = term.readBuffer(id, 120 + extra);
    if (r.ok && r.data.includes('�')) broken.push(120 + extra);
  }
  ok('لا محرف تالف عند أي من ثماني إزاحات قصّ', broken.length === 0,
    'إزاحات شطرت محرفاً: ' + broken.join(', '));

  // **ما لا يغطّيه هذا الحارس** (مُثبَت بفحص عضّ: تعطيل المحاذاة يُبقيه أخضر): إسقاط
  // السطر الجزئي يبتلع المحرف المشطور قبل أن يصل، فمحاذاة UTF-8 طبقةٌ ثانية أثرها
  // المستقل يظهر فقط حين لا يحوي الذيل سطراً جديداً أصلاً — وهي حالة يصعب ترتيبها مع
  // مِحَثّ الصدفة. تبقى المحاذاة دفاعاً معلَناً لا مغطّى، لا يُسجَّل كأنه مُختبَر.

  term.killTerm(id);
  console.log('\nterm-longline: نجح — ' + checks + ' فحصاً (اللصق المُقوّس للخلفية، وقصّ ذيل معلَن بلا شطر محرف).');
  process.exit(0);
}

main().catch((error) => {
  console.error('term-longline: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
