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
  'test:tasks',
  'test:memory',
  'test:design-guard',
  'test:repomap',
  'test:context',
  'test:orchestrator',
  'test:opsroom-all',
  'test:codexmcp',
  'test:codex-contract',
  'test:codex-steer',
  'test:kimi',
  'test:kimi-keepalive',
  'test:browserguard',
  'test:browserorigin',
  'test:browserpolicy',
  'test:browser-platform-live',
  'test:execguard',
  'test:termjobs',
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
  'test:fork-rewind',
  'test:claude-models',
  'test:elicitation',
  'test:testsprite-ready',
  'test:viewer-security',
  'test:askquestion',
  'test:autogate',
  'test:adapters',
  'test:enterprise',
  'test:usage-summary',
  'test:activity',
  'test:definition-of-done',
  'test:full-evidence',
  'test:opsroom-all-live',
  'test:terminal-tabs',
  'test:background-ui-live',
  'test:browser-member-live',
  'test:preview-member-live',
  'test:question-dialog',
  'eval:agent',
];

const failures = [];
console.log(`full-suite: بدء ${SUITE.length} مجموعة اختبار قطعية/حية بالتسلسل.`);
console.log('مستبعدة عمداً: test:codex-executor-probe وtest:browser-loop-probe وtest:browser-loop-sdk-probe وtest:browser-loop-kimi-probe (حية خارجية)، وeval:agent:baseline (يكتب وثيقة baseline).');

for (let index = 0; index < SUITE.length; index++) {
  const name = SUITE[index];
  console.log(`\n[${index + 1}/${SUITE.length}] npm run ${name}`);
  const command = process.platform === 'win32' ? 'cmd' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', name] : ['run', name];
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) failures.push({ name, status: result.status, signal: result.signal || '' });
}

if (failures.length) {
  console.error('\nfull-suite: فشلت المجموعات التالية:');
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.signal || failure.status}`);
  process.exitCode = 1;
} else {
  console.log(`\nfull-suite: نجحت المجموعات كلها — ${SUITE.length}/${SUITE.length}.`);
}
