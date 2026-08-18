#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
const deterministicSuite = [
  'test:loop-mode',
  'test:worktrees',
  'test:executionteam',
  'test:reviewmerge',
  'test:review-panel',
  'test:verify',
  'test:integration',
  'test:opsroom',
  'test:opsroom-ui',
  'test:opscontinuity',
  'test:opsadvisor',
];
const liveSuite = [
  'test:opsroom-ui-live',
  'test:verify-config-dialog',
  'test:chatcolumn-layout',
  'test:xterm-csp',
];

// OBS-025: اختبارات تُنشئ worktrees حقيقية فتتعثّر أحياناً تحت حمل الطقم الكامل
// وتمرّ فوراً منفردة. تُعاد **مرة واحدة** لكل تشغيل وبإعلان صاخب — التراجع
// الحقيقي يفشل مرتين فيسقط، والعثرة البيئية تُسجَّل ولا تُخفى.
const RETRYABLE = new Set(['test:executionteam']);
const MAX_RETRIES = 1;

function runSuite(suite, label) {
  if (!npmCli) {
    console.error('opsroom-suite: شغّل المشغّل عبر npm run كي يتاح مسار npm CLI بلا shell.');
    process.exitCode = 1;
    return;
  }
  console.log(`opsroom-suite: بدء ${label} (${suite.length} اختبارات بالتسلسل).`);

  let completed = 0;
  const retried = [];
  for (const script of suite) {
    console.log(`\n[${completed + 1}/${suite.length}] npm run ${script}`);
    const budget = RETRYABLE.has(script) ? MAX_RETRIES : 0;
    let lastStatus = 1;
    let passed = false;
    for (let attempt = 0; attempt <= budget; attempt++) {
      try {
        execFileSync(process.execPath, [npmCli, 'run', script], {
          cwd: ROOT,
          stdio: 'inherit',
          shell: false,
        });
        passed = true;
        if (attempt > 0) retried.push(script);
        break;
      } catch (error) {
        lastStatus = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
        if (attempt < budget) {
          console.error(`\nopsroom-suite: ⚠ تعثّر ${script} (محاولة ${attempt + 1}/${budget + 1}) — يُعاد مرة واحدة بحكم OBS-025.`);
          console.error('   إن فشل ثانيةً فهو تراجع حقيقي لا عثرة بيئية.');
        }
      }
    }
    if (!passed) {
      console.error(`\nopsroom-suite: فشل ${script}؛ أُوقف الطقم عند أول فشل.`);
      console.error(`الملخّص: نجح ${completed}/${suite.length} قبل الفشل.`);
      process.exitCode = lastStatus;
      return;
    }
    completed += 1;
  }

  const note = retried.length ? ` (أُعيد بعد تعثّر بيئي: ${retried.join('، ')})` : '';
  console.log(`\nopsroom-suite: نجح ${label} كاملاً — ${completed}/${suite.length}.${note}`);
}

const liveOnly = process.argv.slice(2).includes('--live');
runSuite(liveOnly ? liveSuite : deterministicSuite, liveOnly ? 'طقم Electron الحي' : 'الطقم القطعي');
