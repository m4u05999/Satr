#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE = [
  'test:skills',
  'test:slash-menu',
  'test:tasks',
  'test:memory',
  'test:design-guard',
  'test:repomap',
  'test:context',
  'test:orchestrator',
  'test:opsroom-all',
  'test:codexmcp',
  'test:preview-recording',
  'test:claude-auth',
  'test:testsprite-ready',
  'test:viewer-security',
  'test:askquestion',
  'test:autogate',
  'test:adapters',
  'test:enterprise',
  'test:usage-summary',
  'test:activity',
  'test:opsroom-all-live',
  'test:terminal-tabs',
  'test:question-dialog',
  'eval:agent',
];

const failures = [];
console.log(`full-suite: بدء ${SUITE.length} مجموعة اختبار قطعية/حية بالتسلسل.`);
console.log('مستبعدان عمداً: test:codex-executor-probe (حي خارجي) وeval:agent:baseline (يكتب وثيقة baseline).');

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
