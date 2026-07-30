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

function runSuite(suite, label) {
  if (!npmCli) {
    console.error('opsroom-suite: شغّل المشغّل عبر npm run كي يتاح مسار npm CLI بلا shell.');
    process.exitCode = 1;
    return;
  }
  console.log(`opsroom-suite: بدء ${label} (${suite.length} اختبارات بالتسلسل).`);
  if (suite === deterministicSuite) {
    console.log('تنبيه: test:executionteam حساس للتوقيت؛ إذا تعثّر عشوائياً فأعِد تشغيله منفرداً للتحقق.');
  }

  let completed = 0;
  for (const script of suite) {
    console.log(`\n[${completed + 1}/${suite.length}] npm run ${script}`);
    try {
      execFileSync(process.execPath, [npmCli, 'run', script], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
      });
      completed += 1;
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
      console.error(`\nopsroom-suite: فشل ${script}؛ أُوقف الطقم عند أول فشل.`);
      console.error(`الملخّص: نجح ${completed}/${suite.length} قبل الفشل.`);
      process.exitCode = status;
      return;
    }
  }

  console.log(`\nopsroom-suite: نجح ${label} كاملاً — ${completed}/${suite.length}.`);
}

const liveOnly = process.argv.slice(2).includes('--live');
runSuite(liveOnly ? liveSuite : deterministicSuite, liveOnly ? 'طقم Electron الحي' : 'الطقم القطعي');
