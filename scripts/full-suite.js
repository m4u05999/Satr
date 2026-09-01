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
  'test:task-ledger-ui',
  'test:daily-loop-ui',
  'test:sessionmeta',
  'test:sessions-cwd',
  'test:tasks',
  'test:observations',
  'test:probe-runner',
  'test:langmetric',
  'test:langshadow',
  'test:langoverride',
  'test:farsi-content',
  'test:memory',
  'test:design-guard',
  'test:repomap',
  'test:context',
  'test:orchestrator',
  'test:opsroom-all',
  'test:mobile',
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
  'test:promocapture-live',
  'test:promo-studio',
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
 * مجرّد `require` يشغّل 75 مجموعة — فلا يمكن اختبار المهلة ولا قتل الشجرة إلا
 * بنسخ منطقهما في الاختبار، وذاك حارسٌ يقارن الشيء بنفسه.
 */
function main() {
  const failures = [];
  const durations = [];
  console.log(`full-suite: بدء ${SUITE.length} مجموعة اختبار قطعية/حية بالتسلسل.`);
  console.log('مستبعدة عمداً: test:codex-executor-probe وtest:browser-loop-probe وtest:browser-loop-sdk-probe وtest:browser-loop-kimi-probe (حية خارجية)، وeval:agent:baseline (يكتب وثيقة baseline).');

  for (let index = 0; index < SUITE.length; index++) {
    const name = SUITE[index];
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

  if (failures.length) {
    console.error('\nfull-suite: فشلت المجموعات التالية:');
    for (const failure of failures) console.error(`- ${failure.name}: ${failure.signal || failure.status}`);
    process.exitCode = 1;
  } else {
    console.log(`\nfull-suite: نجحت المجموعات كلها — ${SUITE.length}/${SUITE.length}.`);
  }

}

if (require.main === module) main();

module.exports = { main, timeoutFor, killTree, SUITE, SUITE_TIMEOUT_MS, TIMEOUT_OVERRIDES };