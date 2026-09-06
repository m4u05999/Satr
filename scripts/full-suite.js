#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INTERNAL_ATTEMPT_ARG = '--satr-full-suite-attempt';
const INTERNAL_RESULT_FD = 3;
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
  'test:codexsessions',
  'test:tasks',
  'test:observations',
  'test:suite-coverage',
  'test:radar-graveyard',
  'test:hookguard',
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
  'test:tools-edit',
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
  'test:probe-version',
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
  'test:bidi-parity',
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
  { name: 'test:full:external', reason: 'غلاف PowerShell يشغّل الطقم كاملاً في كونسول مستقل (‏OBS-107) — إدراجه يعني طقماً يشغّل نفسه، وهو ويندوزي بحت' },
  { name: 'eval:agent:baseline', reason: 'يكتب وثيقة baseline في docs/ — يُشغَّل يدوياً عند تحديث خط الأساس لا في كل بوابة' },
  // ── مسابير حيّة: تستهلك أدواراً حقيقية وتحتاج محرّكاً مثبّتاً ومسجَّل الدخول ──
  { name: 'test:codex-executor-probe', reason: 'مسبار حيّ خارج الطقم — يشغّل Codex فعلياً' },
  { name: 'probe:obs132', reason: 'مسبار حيّ خارج الطقم — يفتح عشرات pty ويقيس معدّل تلوّث خرج runCapture (OBS-132)؛ 306 محاولة في ~310ث، وقياسٌ لا حارس' },
  { name: 'test:conpty-resize-probe', reason: 'مسبار حيّ خارج الطقم — يفتح pty حقيقياً ويقيس إعادة رسم ConPTY عند تغيّر الصفوف (OBS-124)' },
  { name: 'test:gate-direction-probe', reason: 'مسبار حيّ خارج الطقم — يقيس رسو الاتجاه في البوابة عبر إصدارَي Electron للمقارنة (OBS-128)' },
  { name: 'test:layout-metrics-probe', reason: 'مسبار حيّ خارج الطقم — يقارن cssContentSize بـinnerWidth عبر إصدارَي Electron (OBS-129)' },
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
/**
 * إعادة محاولة معلَنة لعثرات بيئية مقيسة (‏OBS-036) — النمط منقول من
 * `opsroom-suite.js` (‏OBS-025) حرفياً: تُعاد **مرة واحدة** لكل تشغيل وبإعلان
 * صاخب، والتراجع الحقيقي يفشل مرتين فيسقط.
 *
 * الدليل: في بوابة 2.16.1 سقط `test:promocapture-live` وحيداً من 72 مجموعة
 * بحمولة `stop:{size:0, head:[]}` رغم نجاح المسار كله (`stopped.ok:true`،
 * `start.tracks:1`، `frameRate:30`) — أي لم تصل إطارات، ونجح فوراً منفرداً
 * (`bytes=14958`). وقرينة `test:promo-studio` الناجحة في الطقم نفسه
 * (‏`558497 bytes`) تثبت أن الترميز سليم وأن العطب في التقاط النافذة وحده تحت
 * الحمل. القائمة **مغلقة**: لا اسم يدخلها بلا سابقة مقيسة مسجّلة برقم ملاحظة
 * في `RETRYABLE_OBS` — ويُفحص هذا العقد ساكناً وسلوكياً في `test:suite-coverage`.
 */
const RETRYABLE = new Set([
  'test:promocapture-live', // OBS-036 — بوابة 2.16.1: صفر إطار تحت الحمل، ونجح منفرداً فوراً
  'test:preview-member-live', // OBS-101 — تجاوز 240ث تحت الحمل ومرّ في 4.7ث منفرداً (×51)
  'test:mobile', // OBS-111 — نجح وفشل متزامناً على الالتزام نفسه، ثم نجحت إعادة الفاشل بلا تغيير
]);
// تبرير كل اسم — رقم الملاحظة التي سجّلت العثرة البيئية المقيسة. لا اسم بلا سابقة.
const RETRYABLE_OBS = Object.freeze({
  'test:promocapture-live': 'OBS-036',
  'test:preview-member-live': 'OBS-101',
  'test:mobile': 'OBS-111',
});
const MAX_RETRIES = 1;

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

// سقفان يمنعان لقطة جدول عمليات ضخمة (أو نسباً دائرياً مشوّهاً) من التحوّل إلى مسحٍ
// لا ينتهي داخل مسار فشل يُفترض أن يكون سريعاً.
const MAX_TREE_DEPTH = 12;
const MAX_TREE_NODES = 400;

/**
 * جدول العمليات على POSIX من **لقطة واحدة**: خريطة `ppid → [pid…]`.
 * `ps -A -o pid=,ppid=` صيغة XSI تدعمها GNU وBSD معاً، ونداءٌ واحد بدل نداء لكل عقدة.
 * السطر المشوّه يُتجاهَل، و`pid <= 1` يُستبعد فلا يقترب المسح من `init`.
 */
function parseProcessTable(text) {
  const children = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (pid <= 1) continue;
    const bucket = children.get(ppid);
    if (bucket) bucket.push(pid); else children.set(ppid, [pid]);
  }
  return children;
}

/**
 * ذرّية `pid` مرتَّبة **من الأعمق إلى الأضحل** — والترتيب ليس زينة: قتلُ الأب أولاً
 * يُيتِّم أبناءه فيُعادون إلى `init` وتنقطع نسبتهم قبل أن نبلغهم. الجذر نفسه ليس في
 * القائمة؛ يُقتل بعدها.
 */
function descendantsDeepestFirst(pid, children) {
  const levels = [];
  const seen = new Set([pid]);
  let frontier = [pid];
  let count = 0;
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const parent of frontier) {
      for (const child of children.get(parent) || []) {
        if (seen.has(child) || count >= MAX_TREE_NODES) continue;
        seen.add(child);
        next.push(child);
        count += 1;
      }
    }
    if (next.length) levels.push(next);
    frontier = next;
  }
  const ordered = [];
  for (let index = levels.length - 1; index >= 0; index--) ordered.push(...levels[index]);
  return ordered;
}

/**
 * قتل شجرة العملية عند المهلة — **أفضل جهد معلَن**.
 * المعلِّق الفعلي قد يكون حفيداً (‏powershell/electron)؛ فقتل الجذر وحده
 * يترك يتيماً يلوّث المجموعات التالية.
 *
 * **POSIX (‏OBS-079)**: كان الفرع `process.kill(-pid, 'SIGKILL')` — وقتلُ مجموعة
 * بالسالب يوجب أن يكون `pid` قائدَ مجموعة، وهو ما لا يحدث لأن `spawn` المدار أدناه
 * يُطلق الابن **بلا `detached`** فيرث مجموعة الأب. فالمجموعة ذات المعرّف `pid` غير
 * موجودة أصلاً، والنداء يرمي `ESRCH` فيبتلعه `catch` الصامت: **لا يموت أحد**.
 * ولم يُعَد `detached:true` هنا لأن تجربته على لينكس أظهرت قتلاً غير مفسَّر لمجموعات
 * تالية فسُحبت (‏OBS-079)، ولأن معرّف مجموعة مُعاد تدويره يجعل `kill(-pid)` سلاحاً
 * يصيب غير هدفه. البديل نَسَبٌ **صريح** من لقطة واحدة: لا يُقتل إلا ما ثبت أنه ذرّية
 * `pid` لحظة النداء.
 *
 * **اللحظة (OBS-108)**: يستدعيها متحكّم `spawn` في حدث المهلة والجذر ما زال حياً،
 * ثم ينتظر `close`. لذلك يظل النسب متصلاً لـ`taskkill /T` ولمشي POSIX حتى يموت الأعمق
 * ثم الجذر. الحارس يثبت بعد `close` أن الحفيد غير المنفصل مات فعلاً.
 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch { /* ماتت أصلاً */ }
    return;
  }
  let table = new Map();
  try {
    const snapshot = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    table = parseProcessTable(snapshot && snapshot.stdout);
  } catch { /* بلا `ps`: يبقى قتل الجذر وحده أصدق من لا شيء */ }
  for (const target of descendantsDeepestFirst(pid, table)) {
    try { process.kill(target, 'SIGKILL'); } catch { /* ماتت أصلاً */ }
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ماتت أصلاً */ }
}

/** يحوّل أخطاء child_process إلى قيمة صغيرة قابلة للنقل عبر قناة المتحكّم. */
function plainProcessError(error) {
  if (!error) return undefined;
  return {
    code: error.code == null ? '' : String(error.code),
    message: String(error.message || error),
  };
}

/**
 * يشغّل جذراً واحداً بلا `detached`، ويقتله **وهو ما زال حياً** عند المهلة.
 * الانتظار ينتهي عند `close` لا عند إرسال الإشارة؛ عندها يكون الجذر قد حُصد ويمكن
 * للحارس أن يفحص الحفيد من الجهة الأخرى للحظة الحرجة.
 */
function runManagedProcess(command, args, options) {
  const settings = options || {};
  const timeout = Number(settings.timeout);
  return new Promise((resolve) => {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      resolve({
        status: null, signal: null, pid: 0, timedOut: false, reaped: false,
        error: { code: 'EINVAL', message: 'invalid managed-process timeout' },
      });
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd: settings.cwd,
        env: settings.env,
        stdio: settings.stdio || 'inherit',
        shell: false,
        windowsHide: process.platform === 'win32',
      });
    } catch (error) {
      resolve({
        status: null, signal: null, pid: 0, timedOut: false, reaped: false,
        error: plainProcessError(error),
      });
      return;
    }

    const pid = Number(child.pid) || 0;
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (status, signal, error, reaped) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: Number.isInteger(status) ? status : null,
        signal: signal || null,
        pid,
        timedOut,
        reaped,
        error: timedOut
          ? { code: 'ETIMEDOUT', message: `process exceeded ${Math.round(timeout)}ms` }
          : plainProcessError(error),
      });
    };

    child.once('error', (error) => finish(null, null, error, false));
    child.once('close', (status, signal) => finish(status, signal, null, true));
    timer = setTimeout(() => {
      timedOut = true;
      // OBS-108: يجب أن تسبق هذه الجملة قتل الجذر وحصده؛ بعدها ينقطع نسب الأيتام.
      killTree(pid);
      // taskkill/ps أفضل جهد؛ قتل الجذر المباشر شبكة أخيرة كي لا يعلق المتحكّم نفسه.
      try { child.kill('SIGKILL'); } catch { /* مات أصلاً */ }
    }, timeout);
  });
}

function suiteCommand(name) {
  return process.platform === 'win32'
    ? { command: 'cmd', args: ['/d', '/s', '/c', 'npm', 'run', name] }
    : { command: 'npm', args: ['run', name] };
}

/** يكتب نتيجة المحاولة في fd مستقل كي يبقى stdout/stderr حرفياً كما كانا. */
function writeInternalResult(result) {
  fs.writeSync(INTERNAL_RESULT_FD, JSON.stringify(result));
}

async function runInternalAttempt(limitText, name) {
  const limit = Number(limitText);
  if (!SUITE.includes(name) || !Number.isFinite(limit) || limit < 1000 || limit > 3600000) {
    writeInternalResult({
      status: null, signal: null, pid: 0, timedOut: false, reaped: false,
      error: { code: 'EINVAL', message: 'invalid internal suite attempt' },
    });
    return;
  }
  const invocation = suiteCommand(name);
  const result = await runManagedProcess(invocation.command, invocation.args, {
    cwd: ROOT, env: process.env, stdio: 'inherit', timeout: limit,
  });
  writeInternalResult(result);
}

/**
 * تبقى حلقة البوابة متزامنة كي لا ينكسر عقد `suite-coverage` السلوكي، لكن العملية
 * المستهدفة تعيش في متحكّم `spawn` غير متزامن داخل الملف نفسه. بذلك ينتظر الأب
 * نتيجة واحدة كما كان، بينما يملك المتحكّم pid حياً لحظة المهلة (‏OBS-108).
 */
function runSuiteAttempt(name, limit) {
  const wrapper = spawnSync(process.execPath,
    [__filename, INTERNAL_ATTEMPT_ARG, String(limit), name], {
      cwd: ROOT,
      env: process.env,
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      shell: false,
      windowsHide: process.platform === 'win32',
    });
  const raw = wrapper && wrapper.output && wrapper.output[INTERNAL_RESULT_FD];
  if (raw) {
    try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
    catch { /* سقوط المتحكّم نفسه يظهر كفشل المجموعة أدناه */ }
  }
  return {
    status: wrapper ? wrapper.status : null,
    signal: wrapper && wrapper.signal || null,
    pid: wrapper && wrapper.pid || 0,
    timedOut: false,
    reaped: !!wrapper,
    error: wrapper && wrapper.error,
  };
}

/**
 * مغلَّفة في دالة كي يصير الملف قابلاً للاستيراد: بلا حارس `require.main` كان
 * مجرّد `require` يشغّل الطقم كاملاً — فلا يمكن اختبار المهلة ولا قتل الشجرة ولا
 * قائمة المستبعَدات إلا بنسخ منطقها في الاختبار، وذاك حارسٌ يقارن الشيء بنفسه.
 */
function main() {
  if (process.argv[2] === INTERNAL_ATTEMPT_ARG) {
    runInternalAttempt(process.argv[3], process.argv[4]).catch((error) => {
      try {
        writeInternalResult({
          status: null, signal: null, pid: 0, timedOut: false, reaped: false,
          error: plainProcessError(error),
        });
      } catch { process.exitCode = 1; }
    });
    return;
  }

  const failures = [];
  const durations = [];
  const skipped = [];
  const retried = [];
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
    const limit = timeoutFor(name);
    const startedAt = Date.now();
    // ميزانية الإعادة مغلقة: اسم غير مقيّس في RETRYABLE لا يحصل على محاولة ثانية أبداً.
    const budget = RETRYABLE.has(name) ? MAX_RETRIES : 0;
    let passed = false;
    let lastFailure = null;
    for (let attempt = 0; attempt <= budget; attempt++) {
      const result = runSuiteAttempt(name, limit);
      const timedOut = !!(result.timedOut || (result.error && result.error.code === 'ETIMEDOUT'));
      if (timedOut) {
        console.error(`\nfull-suite: ⏱ تجاوزت «${name}» مهلتها (${Math.round(limit / 1000)}ث) — قُتلت شجرتها والبوابة تكمل.`);
        lastFailure = { name, status: 'timeout', signal: `تجاوز ${Math.round(limit / 1000)}ث` };
      } else if (result.status !== 0) {
        lastFailure = { name, status: result.status, signal: result.signal || '' };
      } else {
        passed = true;
        // العثرة البيئية لا تُخفى: أي نجاح جاء بعد إعادة يُسجَّل ويُذكر في الخاتمة.
        if (attempt > 0) retried.push(name);
        break;
      }
      if (attempt < budget) {
        console.error(`\nfull-suite: ⚠ تعثّر «${name}» (المحاولة ${attempt + 1}/${budget + 1}) — يُعاد مرة واحدة بحكم ${RETRYABLE_OBS[name]}.`);
        console.error('   إن فشل ثانيةً فهو تراجع حقيقي لا عثرة بيئية.');
      }
    }
    const elapsed = Date.now() - startedAt;
    durations.push({ name, ms: elapsed });
    if (!passed && lastFailure) failures.push(lastFailure);
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
  // الإعلان الصاخب لا يكتمل بخاتمة صامتة: أي مجموعة أُعيدت تُذكر صراحةً —
  // «كله أخضر» مع إعادة مخفيّة حارس أخضر كاذب (الغرض نفسه من قيد القائمة المغلقة).
  const retriedNote = retried.length ? ` (أُعيد بعد تعثّر بيئي: ${retried.join('، ')})` : '';
  if (failures.length) {
    console.error('\nfull-suite: فشلت المجموعات التالية:');
    for (const failure of failures) console.error(`- ${failure.name}: ${failure.signal || failure.status}`);
    if (retried.length) console.error(`full-suite: ملاحظة: أُعيد قبل أن تسقط ثم نجح: ${retried.join('، ')}.`);
    process.exitCode = 1;
  } else {
    console.log(`\nfull-suite: نجحت المجموعات كلها — ${ran}/${ran}${skipped.length ? ` (و${skipped.length} متخطّاة بحدّ معلَن)` : ''}${retriedNote}.`);
  }

}

if (require.main === module) main();

module.exports = {
  main, timeoutFor, killTree, runManagedProcess, skipReasonFor, parseProcessTable, descendantsDeepestFirst,
  SUITE, EXCLUDED_FROM_SUITE, SKIP_ON_POSIX, SUITE_TIMEOUT_MS, TIMEOUT_OVERRIDES,
  RETRYABLE, RETRYABLE_OBS, MAX_RETRIES,
};
