#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE = [
  'test:skills',
  'test:slash-menu',
  'test:chat-rtl',
  'test:update-ui',
  'test:settings-account',
  'test:task-ledger-ui',
  'test:daily-loop-ui',
  'test:sessionmeta',
  'test:sessions-cwd',
  'test:tasks',
  'test:observations',
  'test:suite-coverage',
  'test:probe-runner',
  'test:langmetric',
  'test:langshadow',
  'test:langoverride',
  'test:farsi-content',
  'test:memory',
  'test:design-guard',
  'test:gitdiff',
  'test:keys',
  'test:topbar-dev-badge',
  'test:repomap',
  'test:context',
  'test:orchestrator',
  'test:opsroom-all',
  'test:mobile',
  'test:qr',
  'test:codexmcp',
  'test:genmedia',
  'test:codex-contract',
  'test:send-liveness',
  'test:codex-steer',
  'test:codex-compact',
  'test:codex-mcp-panel',
  'test:codex-account',
  'test:kimi',
  'test:kimi-keepalive',
  'test:browserguard',
  'test:browserorigin',
  'test:browserpolicy',
  'test:browser-platform-live',
  'test:execguard',
  'test:termjobs',
  'test:term-longline',
  'test:termjobs-done',
  'test:secretscrub',
  'test:envbrief',
  'test:satr-guide',
  'test:handoff-bar-live',
  'test:preview-recording',
  'test:promocapture',
  'test:promocapture-batch1',
  'test:promocapture-live',
  'test:promo-studio',
  'test:promostudio-batch1',
  'test:claude-auth',
  'test:readiness',
  'test:enginesupdate',
  'test:gate-live',
  'test:fork-rewind',
  'test:claude-models',
  'test:elicitation',
  'test:sdk-background',
  'test:sdk-polish',
  'test:testsprite-ready',
  'test:testspritejobs',
  'test:testsprite-job-live',
  'test:viewer-security',
  'test:askquestion',
  'test:autogate',
  'test:adapters',
  'test:enterprise',
  'test:usage-summary',
  'test:activity',
  'test:definition-of-done',
  'test:full-evidence',
  'test:full-timeout',
  'test:readme-version',
  'test:opsroom-all-live',
  'test:terminal-tabs',
  'test:background-ui-live',
  'test:browser-member-live',
  'test:preview-member-live',
  'test:preview-lease',
  'test:readability',
  'test:preview-shield',
  'test:sessions-panel',
  'test:question-dialog',
  'test:gallery',
  'eval:agent',
];

/**
 * المستبعَدة من الطقم **عمداً وبسبب مكتوب** — لا مكان ثالثاً.
 *
 * الدرس (OBS-011 ثم تكراره): كل سكربت `test:*` يُسجَّل في `package.json` ولا يدخل
 * الطقم يصير «اختباراً بالتذكّر»، وما يُشغَّل بالتذكّر لا يُشغَّل. وقد تراكم هكذا
 * ثلاثة اختبارات قطعية نقية (`test:qr` و`*-batch1`) خارج البوابة بلا أن ينتبه أحد.
 *
 * فالعقد الذي يحرسه `scripts/suite-coverage-test.js`: كل سكربت `test:`/`eval:`/`audit:`
 * إمّا **يصله الطقم** (مباشرةً أو عبر طقم فرعي) وإمّا **مذكور هنا بسببه**. الاستبعاد
 * مشروع — المسبار الحيّ يستهلك أدواراً بكلفة فعلية ويحتاج مفاتيح، والفحص البصري
 * يحتاج نافذة مرئية — لكنه يُعلَن لا يُنسى. والحارس يرفض أيضاً السبب الفارغ والاسم
 * الذي لم يعد في `package.json` والاسم الذي صار يصله الطقم (قيد بائت).
 */
const EXCLUDED_FROM_SUITE = Object.freeze([
  // ── المشغّلات نفسها: إدراجها يعني طقماً يشغّل نفسه ──
  { name: 'test:full', reason: 'هو المشغّل نفسه (هذا الملف)' },
  { name: 'test:full:evidence', reason: 'غلاف المشغّل الذي يكتب أدلّة التشغيل في dist/test-runs — يشغّل الطقم كاملاً بدوره' },
  { name: 'eval:agent:baseline', reason: 'يكتب وثيقة baseline في docs/ — يُشغَّل يدوياً عند تحديث خط الأساس لا في كل بوابة' },
  // ── مسابير حيّة: تستهلك أدواراً حقيقية وتحتاج محرّكاً مثبّتاً ومسجَّل الدخول ──
  { name: 'test:codex-executor-probe', reason: 'مسبار حيّ خارج الطقم — يشغّل Codex فعلياً' },
  { name: 'test:loop-live-probe', reason: 'مسبار حيّ خارج الطقم — حلقة محدودة بمحرك SDK حقيقي يستهلك أدواراً' },
  { name: 'test:codex-subagent-live', reason: 'مسبار حيّ خارج الطقم — يطلق وكلاء Codex فرعيين فعليين' },
  { name: 'test:browser-loop-probe', reason: 'مسبار حيّ خارج الطقم — حلقة متصفح بمحرك حقيقي' },
  { name: 'test:browser-loop-sdk-probe', reason: 'مسبار حيّ خارج الطقم — حلقة متصفح بمحرك SDK حقيقي' },
  { name: 'test:browser-loop-kimi-probe', reason: 'مسبار حيّ خارج الطقم — حلقة متصفح بمحرك Kimi حقيقي' },
  { name: 'test:codex-steer-probe', reason: 'مسبار حيّ خارج الطقم — يوثّق عقد turn/steer على codex-cli المثبّت' },
  { name: 'test:codex-compact-probe', reason: 'مسبار حيّ خارج الطقم — يوثّق عقد thread/compact على codex-cli المثبّت' },
  { name: 'test:codex-mcp-panel-probe', reason: 'مسبار حيّ خارج الطقم — يشغّل خوادم MCP الحقيقية للمستخدم' },
  { name: 'test:codex-account-probe', reason: 'مسبار حيّ خارج الطقم — يقرأ حساب Codex ويبدأ دورة دخول ثم يلغيها' },
  { name: 'test:sdk-polish-probe', reason: 'مسبار حيّ خارج الطقم — يحتاج Claude Code عالمياً مسجَّل الدخول ويستهلك دوراً' },
  { name: 'test:reviewchanges-probe', reason: 'مسبار حيّ خارج الطقم — «راجع تغييراتي» بمحرك حقيقي؛ الحارس القطعي test:reviewchanges داخل الطقم' },
  // ── فحوص بصرية تحتاج نافذة مرئية أو desktopCapturer (OBS-019: هشّة تحت الحمل) ──
  { name: 'test:rtl-preview', reason: 'فحص RTL بصري يحتاج نافذة مرئية وdesktopCapturer — يُشغَّل يدوياً عند مسّ المعاينة (OBS-019)' },
  { name: 'test:rtl-native', reason: 'فحص RTL بصري شامل للطبقات الأصلية يحتاج نافذة مرئية — يُشغَّل يدوياً عند مسّ الطبقات الأصلية' },
  { name: 'test:rtl-geometry', reason: 'فحص RTL حيّ لهندسة الأسطح الجانبية بإحداثيات فيزيائية — يُشغَّل يدوياً عند مسّ الأسطح' },
  { name: 'audit:rtl-visual', reason: 'جولة تدقيق RTL بصرية تكتب docs/RTL-AUDIT.md ولقطات في dist/ — أداة تقرير لا حارس' },
  // ── مسابير تشغيل خارجي أو اختبارات حيّة تُشغَّل يدوياً عند مسّ ميزتها ──
  { name: 'test:pty-shutdown', reason: 'مسبار خارجي يقيس موت العملية نفسها بعد الإغلاق (ConPTY على Windows) — لا يمكن لعملية أن تشهد على موتها من داخل الطقم' },
  { name: 'test:pwa-crypto', reason: 'اختبار Electron حيّ لتوافق pwa/crypto.js مع المتّجهات — يُشغَّل يدوياً عند مسّ تعمية الجوال؛ القطعي test:mobile-crypto داخل طقم الجوال' },
  { name: 'test:promocapture-events-live', reason: 'اختبار Electron حيّ لأحداث الالتقاط يكتب نتيجته في dist/ — يُشغَّل يدوياً عند مسّ promocapture' },
  { name: 'test:promo-preview', reason: 'اختبار Electron حيّ لمعاينة استوديو البرومو تحت CSP — يُشغَّل يدوياً عند مسّ المعاينة' },
  { name: 'test:promo-audio-live', reason: 'اختبار Electron حيّ لطبقة الصوت بمذبذب حقيقي وffprobe اختياري — يُشغَّل يدوياً عند مسّ صوت البرومو' },
]);

/**
 * مهلة لكل مجموعة (‏OBS-056) — **البوابة تنطق أو تسقط، ولا تصمت**.
 *
 * الدليل: في بوابة 2026-08-26 سقط `test:termjobs` ثم بقي المشغّل معلّقاً أكثر من
 * 1000 ثانية حتى أُوقف يدوياً. والاختبار نفسه سليم — يملك `catch` يستدعي
 * `process.exit(1)` وقد طُبع خطؤه فعلاً — لكن **حفيداً يتيماً** (‏pty خارج سجل
 * `term.js` بعد تشابك) أبقى `cmd` مفتوحاً و`spawnSync` ينتظره. فالنتيجة أسوأ من
 * الفشل: لا خضراء ولا حمراء بل جلسة تُهدر حتى ينتبه بشر — نظير `OBS-042` («لا
 * تقرأ صمتاً نجاحاً») بوجه آخر.
 *
 * المهلة هنا **حارس صنفٍ لا علاج termjobs**: أي مجموعة تعلّق لأي سبب تصير فشلاً
 * صريحاً والبوابة تكمل.
 *
 * الأرقام **مقيسة على تشغيل كامل** (2026-08-27) لا مخمَّنة. المرصود:
 * `test:opsroom-all` ‏121.6ث · `test:opsroom-all-live` ‏51.0ث ·
 * `test:handoff-bar-live` ‏25.2ث · وكل ما عداها دون 20ث.
 * فالمهل أدناه بين **4× و9×** المرصود: فسحةٌ لجهاز أبطأ أو ذاكرة باردة، وفي الوقت
 * نفسه تكشف التعليق خلال دقائق لا بعد 1000 ثانية كما وقع في بوابة 2026-08-26.
 * القاعدة عند التعديل: قِس ثم اضرب، ولا تُدخل رقماً بلا سطر قياس يسنده.
 */
const SUITE_TIMEOUT_MS = 240000;
// المجموعات المجمَّعة تشغّل اختبارات متعددة بالتسلسل فمدّتها الطبيعية أطول بمراتب.
const TIMEOUT_OVERRIDES = Object.freeze({
  'test:opsroom-all': 480000,
  'test:opsroom-all-live': 300000,
  'eval:agent': 300000,
});
/**
 * مجموعات تُتخطّى على غير ويندوز — **حدود معلَنة لا أعطال**.
 *
 * الدليل: تشغيل كامل للطقم على لينكس تحت `xvfb` (2026-09-03، الشجرة `3cf1f3d`):
 * نجحت 80 من 86 مجموعة، بما فيها كل اختبارات Electron الحية. الست الباقية تسقط
 * لسببٍ في **الاختبار أو الحدّ المعلَن** لا في الكود المحروس، فتخطّيها المعلَن أصدق
 * من حذفها أو من ترك بوابة لينكس حمراء إلى الأبد. القاعدة: كل مدخل هنا يحمل سبباً
 * يُقرأ، ويُحذف حين يزول سببه — والمشغّل يطبع المتخطّى صراحةً فلا يُقرأ الصمت
 * نجاحاً (‏OBS-042).
 */
const SKIP_ON_POSIX = Object.freeze([
  { name: 'test:termjobs', reason: 'خرج runCapture يتشابك تحت bash — بروتوكول علامتَي الالتقاط مبنيّ على PowerShell (‏OBS-072)' },
  { name: 'test:term-longline', reason: 'حدّ معلَن في termjobs.js: الأمر متعدد الأسطر يُدمَج على POSIX ولا يُلتقط رمز الخروج (‏OBS-065)' },
  { name: 'test:genmedia', reason: 'فحص «حارس المنزل» يفترض نظام ملفات لا يميّز حالة الأحرف (home.toUpperCase) — افتراض ويندوزي في الاختبار نفسه' },
  { name: 'test:codex-contract', reason: 'فحص العبور يستخدم "..\\outside.txt" — الشرطة المائلة العكسية حرف اسم صالح على POSIX، فالافتراض ويندوزي في الاختبار' },
  { name: 'test:promo-studio', reason: 'الجزء الحي يصيّر صوتاً وفيديو ويحتاج ALSA/GPU حقيقيين — يسقط بـ live_timeout:rendering على عدّاء بلا صوت' },
  { name: 'eval:agent', reason: 'التقييم يعلن 12 مهمة وينفّذ 11 على POSIX فيُعدّ ناقصاً — يحتاج فحصاً مستقلاً لمهمته المشروطة بويندوز' },
]);
function skipReasonFor(name, platform = process.platform) {
  if (platform === 'win32') return null;
  const hit = SKIP_ON_POSIX.find((entry) => entry.name === name);
  return hit ? hit.reason : null;
}

// تجاوز بيئي بحدود — لقياس المدد أول مرة بقيمة سخيّة، ولجهاز أبطأ في CI. خارج
// الحدود يسقط إلى الافتراضي بدل أن يُعطِّل الحارس بقيمة صفرية أو لا نهائية.
const ENV_TIMEOUT = Number(process.env.SATR_SUITE_TIMEOUT_MS);
const ENV_TIMEOUT_OK = Number.isFinite(ENV_TIMEOUT) && ENV_TIMEOUT >= 10000 && ENV_TIMEOUT <= 3600000;
function timeoutFor(name) {
  if (ENV_TIMEOUT_OK) return ENV_TIMEOUT;
  return TIMEOUT_OVERRIDES[name] || SUITE_TIMEOUT_MS;
}

/**
 * قتل شجرة العملية عند المهلة — **أفضل جهد معلَن**.
 * `spawnSync` يقتل الابن المباشر (`cmd`) وحده، بينما المعلِّق الفعلي حفيدٌ
 * (‏powershell/electron). بلا هذا القتل تبقى الأيتام تلوّث المجموعات التالية.
 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* ماتت أصلاً */ }
}

/**
 * مغلَّفة في دالة كي يصير الملف قابلاً للاستيراد: بلا حارس `require.main` كان
 * مجرّد `require` يشغّل الطقم كاملاً — فلا يمكن اختبار المهلة ولا قتل الشجرة ولا
 * قائمة المستبعَدات إلا بنسخ منطقها في الاختبار، وذاك حارسٌ يقارن الشيء بنفسه.
 */
function main() {
  const failures = [];
  const durations = [];
  const skipped = [];
  console.log(`full-suite: بدء ${SUITE.length} مجموعة اختبار قطعية/حية بالتسلسل.`);
  // تُشتق من القائمة المعلنة لا من نصّ يدوي يبيت — الأسباب كاملة في EXCLUDED_FROM_SUITE.
  console.log(`مستبعدة عمداً (${EXCLUDED_FROM_SUITE.length}، بأسباب موثّقة في EXCLUDED_FROM_SUITE): `
    + EXCLUDED_FROM_SUITE.map((item) => item.name).join(' و') + '.');

  for (let index = 0; index < SUITE.length; index++) {
    const name = SUITE[index];
    const skipReason = skipReasonFor(name);
    if (skipReason) {
      console.log(`\n[${index + 1}/${SUITE.length}] ⏭ ${name} — متخطّاة على ${process.platform}: ${skipReason}`);
      skipped.push({ name, reason: skipReason });
      continue;
    }
    console.log(`\n[${index + 1}/${SUITE.length}] npm run ${name}`);
    const command = process.platform === 'win32' ? 'cmd' : 'npm';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', name] : ['run', name];
    const limit = timeoutFor(name);
    const startedAt = Date.now();
    const result = spawnSync(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      shell: false,
      timeout: limit,
      killSignal: 'SIGKILL',
    });
    const elapsed = Date.now() - startedAt;
    durations.push({ name, ms: elapsed });
    const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT');
    if (timedOut) {
      killTree(result.pid);
      console.error(`\nfull-suite: ⏱ تجاوزت «${name}» مهلتها (${Math.round(limit / 1000)}ث) — قُتلت شجرتها والبوابة تكمل.`);
      failures.push({ name, status: 'timeout', signal: `تجاوز ${Math.round(limit / 1000)}ث` });
    } else if (result.status !== 0) {
      failures.push({ name, status: result.status, signal: result.signal || '' });
    }
  }

  // مدد المجموعات — عليها تُعايَر المهل أعلاه، ولا تُخمَّن. تُطبع مرتَّبة تنازلياً
  // كي يظهر أبطؤها فوراً عند أي مراجعة للأرقام.
  const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 8);
  console.log('\nfull-suite: أبطأ ثماني مجموعات (ثانية) — أساس معايرة المهل:');
  for (const item of slowest) console.log(`  ${item.name.padEnd(32)} ${(item.ms / 1000).toFixed(1)}`);

  if (skipped.length) {
    console.log(`\nfull-suite: متخطّاة على ${process.platform} بحدّ معلَن (${skipped.length}):`);
    for (const item of skipped) console.log(`- ${item.name}: ${item.reason}`);
  }

  const ran = SUITE.length - skipped.length;
  if (failures.length) {
    console.error('\nfull-suite: فشلت المجموعات التالية:');
    for (const failure of failures) console.error(`- ${failure.name}: ${failure.signal || failure.status}`);
    process.exitCode = 1;
  } else {
    console.log(`\nfull-suite: نجحت المجموعات كلها — ${ran}/${ran}${skipped.length ? ` (و${skipped.length} متخطّاة بحدّ معلَن)` : ''}.`);
  }

}

if (require.main === module) main();

module.exports = { main, timeoutFor, killTree, skipReasonFor, SUITE, EXCLUDED_FROM_SUITE, SKIP_ON_POSIX, SUITE_TIMEOUT_MS, TIMEOUT_OVERRIDES };
