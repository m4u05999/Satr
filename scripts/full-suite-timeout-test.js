#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس مهلة المجموعة في `full-suite.js` (‏OBS-056، قطعي بلا شبكة).
 *
 * ما يحرسه ليس «هل كُتبت مهلة» بل **هل تعمل فعلاً على هذه المنصة**: الافتراض
 * الخطر أن `spawnSync({timeout})` يكفي، بينما المعلِّق في الحادثة الحقيقية كان
 * **حفيداً** (‏pty) لا الابن المباشر. فيبني هذا الاختبار الشكل نفسه — أبٌ يبقى
 * حياً بسبب حفيدٍ معمّر — ويثبت أن المهلة تنطق وأن `killTree` تُنهي الحفيد.
 *
 * ولولاه لكان الحارس «أخضر كاذباً»: مهلةٌ تُقتل الابن ويبقى الحفيد يلتهم الجهاز.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const suite = require('./full-suite');

let checks = 0;
function ok(cond, msg) { checks += 1; assert(cond, msg); }

// ── 1) اختيار المهلة: الافتراضي والتجاوزات والحدّ البيئي ────────────────────
{
  ok(suite.timeoutFor('test:langmetric') === suite.SUITE_TIMEOUT_MS, 'المجموعة العادية تأخذ الافتراضي');
  ok(suite.timeoutFor('test:opsroom-all') === suite.TIMEOUT_OVERRIDES['test:opsroom-all'],
    'والمجمَّعة تأخذ تجاوزها المعلن');
  // الأرقام مقيسة: أبطأ مجموعة مرصودة 121.6ث، فالمهلة يجب أن تفوقها بفسحة معتبرة
  ok(suite.TIMEOUT_OVERRIDES['test:opsroom-all'] >= 121600 * 3,
    'مهلة أبطأ مجموعة لا تقل عن ثلاثة أضعاف المقيس — وإلا صارت المهلة نفسها مصدر فشل كاذب');
  ok(suite.SUITE_TIMEOUT_MS >= 25200 * 4,
    'والافتراضي فوق أبطأ مجموعة غير مجمَّعة بأربعة أضعاف على الأقل');
  // وألّا تكون سخيّة إلى حد يُفرغ الحارس: الحادثة أهدرت 1000ث قبل تدخّل بشري
  ok(suite.SUITE_TIMEOUT_MS <= 600000 && suite.TIMEOUT_OVERRIDES['test:opsroom-all'] <= 900000,
    'ولا تبلغ من السخاء ما يعيد الانتظار الأبدي الذي وُضعت له');
  ok(suite.SUITE.length > 0 && suite.SUITE.every((name) => typeof name === 'string'),
    'وقائمة المجموعات سليمة بعد التغليف في main');
}

// ── 2) السلوك الفعلي: أبٌ يبقى حياً بحفيدٍ معمّر ────────────────────────────
// هذا هو شكل الحادثة حرفياً: العملية المباشرة تنتهي منطقياً لكن حفيداً يُبقي
// الأنبوب مفتوحاً، فينتظر المشغّل إلى الأبد.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-suite-timeout-'));
  const marker = path.join(dir, 'grandchild.txt');
  const grandchild = path.join(dir, 'grandchild.js');
  const parent = path.join(dir, 'parent.js');
  try {
    // حفيد معمّر يكتب معرّفه ثم يبقى حياً — نظير pty اليتيم
    fs.writeFileSync(grandchild, 'require("fs").writeFileSync('
      + JSON.stringify(marker) + ', String(process.pid));\nsetInterval(() => {}, 1000);\n', 'utf8');
    // **`detached` ليست زينة**: قيس أولاً بحفيدٍ عادي فمات مع أبيه، فكان فحص
    // `killTree` يمرّ على عمليةٍ ميتة أصلاً — أخضر كاذب. الحفيد المنفصل وحده ينجو
    // من قتل الابن، وهو شكل pty الذي علّق البوابة فعلاً (‏node-pty يطلق conhost
    // مستقلاً). فبهذا الشكل يقيس الفحص نجاةً حقيقية لا فراغاً.
    fs.writeFileSync(parent, 'const { spawn } = require("child_process");\n'
      + 'spawn(process.execPath, [' + JSON.stringify(grandchild) + '], '
      + '{ stdio: "ignore", detached: true }).unref();\n'
      + 'setInterval(() => {}, 1000);\n', 'utf8');

    const limit = 3000;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [parent], {
      stdio: 'ignore', timeout: limit, killSignal: 'SIGKILL',
    });
    const elapsed = Date.now() - startedAt;

    ok(result.error && result.error.code === 'ETIMEDOUT',
      'المهلة تُبلَّغ بـETIMEDOUT — وعليها يقوم فرع الفشل الصريح في full-suite');
    ok(elapsed < limit * 4,
      'وتُحسم قرب مهلتها لا بعد انتظار مفتوح (' + elapsed + 'ms مقابل ' + limit + 'ms)');

    // الحفيد: يجب أن يكون قد وُلد فعلاً، وإلا كان الاختبار يقيس فراغاً
    let grandPid = 0;
    for (let attempt = 0; attempt < 50 && !grandPid; attempt++) {
      try { grandPid = Number(fs.readFileSync(marker, 'utf8')) || 0; } catch { /* لم يُكتب بعد */ }
      if (!grandPid) { try { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60)']); } catch {} }
    }
    ok(grandPid > 0, 'الحفيد وُلد فعلاً — وإلا فالاختبار يقيس فراغاً لا نجاةً');

    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // **شرط صدق الفحص التالي**: لو مات الحفيد مع أبيه لصار فحص killTree يمرّ على
    // عمليةٍ ميتة — أخضر كاذب. فيُثبَت أولاً أنه نجا فعلاً.
    ok(alive(grandPid), 'الحفيد المنفصل نجا من قتل الابن — وإلا فالفحص التالي بلا معنى');
    suite.killTree(grandPid);
    let cleared = false;
    for (let attempt = 0; attempt < 40 && !cleared; attempt++) {
      cleared = !alive(grandPid);
      if (!cleared) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
    }
    ok(cleared, 'killTree أنهت الحفيد الناجي — بدونها تتراكم الأيتام وتلوّث بقية البوابة');
    ok(suite.killTree(0) === undefined && suite.killTree(null) === undefined,
      'ومعرّف غائب لا يرمي (تُستدعى في مسار فشل — رميُها يخفي الفشل الأصلي)');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* أفضل جهد */ }
  }
}

// ── 3) عقد سطر الخلاصة لم يُكسر — يقرؤه full-suite-evidence بتعبير حرفي ─────
{
  const source = fs.readFileSync(path.join(__dirname, 'full-suite.js'), 'utf8');
  // البسط والمقام هما ما شُغّل فعلاً (بعد التخطّي المعلَن) — وتعبير evidence يقرأ
  // «(\d+)/(\d+)» ولا يشترط نهاية السطر، فلاحقة التخطّي لا تكسره.
  ok(/full-suite: نجحت المجموعات كلها — \$\{ran\}\/\$\{ran\}/.test(source),
    'سطر النجاح حرفي كما يتوقعه full-suite-evidence');
  ok(/full-suite: فشلت المجموعات التالية:/.test(source), 'وسطر الفشل كذلك');
  ok(/if \(require\.main === module\) main\(\);/.test(source),
    'وحارس require.main موجود — بدونه يشغّل الاستيراد 75 مجموعة');
}

// ── 4) التخطّي المعلَن على POSIX: بسبب مقروء، ولا يمسّ ويندوز، ولا يخفي مجموعة ──
{
  ok(Array.isArray(suite.SKIP_ON_POSIX) && suite.SKIP_ON_POSIX.length > 0, 'قائمة التخطّي موجودة');
  for (const entry of suite.SKIP_ON_POSIX) {
    ok(suite.SUITE.includes(entry.name), `المتخطّاة «${entry.name}» في الطقم أصلاً — تخطّي ما ليس فيه ستر لغياب`);
    ok(typeof entry.reason === 'string' && /[؀-ۿ]/.test(entry.reason) && entry.reason.length >= 20,
      `ولـ«${entry.name}» سبب عربي مقروء لا رمز`);
  }
  const first = suite.SKIP_ON_POSIX[0].name;
  ok(suite.skipReasonFor(first, 'win32') === null, 'على ويندوز لا يُتخطّى شيء — الطقم كاملاً كما كان');
  ok(typeof suite.skipReasonFor(first, 'linux') === 'string', 'وعلى لينكس يعود السبب لا صمت');
  ok(suite.skipReasonFor('test:langmetric', 'linux') === null, 'وما ليس في القائمة لا يُتخطّى');
  const source = fs.readFileSync(path.join(__dirname, 'full-suite.js'), 'utf8');
  ok(/⏭ \$\{name\} — متخطّاة على/.test(source), 'والمشغّل يطبع المتخطّى صراحةً — الصمت لا يُقرأ نجاحاً (‏OBS-042)');
}

console.log('full-suite-timeout: نجح — ' + checks
  + ' فحصاً (معايرة المهل من قياس، وETIMEDOUT ينطق، وkillTree تُنهي الحفيد اليتيم، وعقد الخلاصة سليم، والتخطّي المعلَن على POSIX مقيّد).');
