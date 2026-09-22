'use strict';
// حارس الانهيار الأصلي: العملية الأم تشهد على خروج Electron، لا على آخر سطر نجاح فيه.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const core = require('./lib/live-test-run');

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP pty-native-lifecycle: Windows ConPTY only');
    return;
  }
  // حقن حزمة قديمة داخل نسخة dist فقط لإثبات عضّة الحارس؛ لا يتغير اعتماد الإنتاج.
  let dependency = path.join(ROOT, 'node_modules/node-pty');
  if (process.argv.length > 2) {
    assert.equal(process.argv[2], '--pty-package');
    assert.equal(process.argv.length, 4);
    dependency = fs.realpathSync(path.resolve(ROOT, process.argv[3]));
    const relative = path.relative(path.join(ROOT, 'dist'), dependency);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test_dependency_must_be_under_dist');
  }
  const run = core.prepareRun(ROOT, {});
  const plan = { scenario: 'synchronized-exit-with-resize', waves: 12, concurrency: 6, deadlineMs: 180000,
    dependency, version: require(path.join(dependency, 'package.json')).version, engineRequests: 0,
    scope: 'production term.js under Electron; no renderer; timing race coverage is probabilistic' };
  fs.writeFileSync(path.join(run.paths.root, 'pty-native-plan.json'), JSON.stringify(plan, null, 2));
  console.log('PTY_NATIVE_START', run.id, plan.version);
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures/pty-native-lifecycle-child.cjs'), run.paths.root, ROOT, dependency], {
    cwd: run.paths.workspace, env: core.buildChildEnv(process.env, run), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '', timedOut = false;
  child.stdout.on('data', data => { tail = (tail + data).slice(-4000); });
  child.stderr.on('data', data => { tail = (tail + data).slice(-4000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, plan.deadlineMs);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  fs.writeFileSync(path.join(run.paths.root, 'pty-native-exit.json'), JSON.stringify({ ...exit, timedOut, tail, pid: child.pid }, null, 2));
  assert(!timedOut, 'PTY_NATIVE_TIMEOUT');
  assert.equal(exit.code, 0, 'PTY_NATIVE_CRASH: exit=' + exit.code + '\n' + tail);
  const result = JSON.parse(fs.readFileSync(path.join(run.paths.root, 'pty-native-result.json'), 'utf8'));
  assert.equal(result.exited, 72);
  assert.equal(result.goodOutput, 72);
  assert(result.resizeCalls > 0);
  console.log('PASS pty-native-lifecycle: 72 exits, output, resize and clean Electron shutdown');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
