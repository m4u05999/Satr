#!/usr/bin/env node
'use strict';

// تشغيل المختبر يبقى في طرفية سطر المرئية؛ هذه الواجهة لا تنشئ عملية منفصلة صامتة.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const core = require('./lib/live-test-run');
const repo = path.resolve(__dirname, '..');

async function command(run, action, scenario) {
  const file = path.join(run.paths.root, 'control.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('bad_control');
  const control = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (control.id !== run.id || !Number.isInteger(control.port) || control.port < 1 || control.port > 65535
      || !/^[a-f0-9]{64}$/.test(control.token)) throw new Error('bad_control');
  const body = JSON.stringify({ action, scenario });
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: control.port, path: '/command', method: 'POST',
      headers: { 'x-satr-live-token': control.token, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(body) } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.length > 16384) request.destroy(new Error('response_too_large')); });
      response.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('bad_response')); } });
    });
    request.on('error', reject);
    request.setTimeout(action === 'status' ? 10000 : 60000, () => request.destroy(new Error('command_timeout')));
    request.end(body);
  });
}

function completionExitCode(repoRoot, id, childCode) {
  if (childCode !== 0) return 1;
  try {
    const completion = core.readEvidence(repoRoot, id, 'completion.json');
    return completion.kind === 'shutdown' && completion.status === 'closed' ? 0 : 1;
  } catch { return 1; }
}

async function main(args) {
  const [action, id, ...rest] = args;
  if (action === 'prepare') {
    if (id) throw new Error('unexpected_argument');
    const run = core.prepareRun(repo, {});
    console.log(JSON.stringify({ ok: true, id: run.id, workspace: run.paths.workspace, profile: run.paths.profile }));
    return;
  }
  const actions = ['launch', 'status', 'record-start', 'record-stop', 'close'];
  if (!actions.includes(action)) throw new Error('usage_prepare_launch_status_record-start_record-stop_close');
  const run = core.loadRun(repo, id);
  if (action === 'launch') {
    if (rest.some(value => !['--record-consent', '--debug', '--smoke', '--recording-hd'].includes(value))) throw new Error('bad_option');
    const child = spawn(require('electron'), [path.join(__dirname, 'live-test-launch.js'), run.id, ...rest.map(value => value === '--debug' ? '--live-debug' : value)], {
      cwd: repo, env: core.buildChildEnv(process.env, run), stdio: 'inherit', shell: false,
    });
    child.once('error', () => { console.error('LIVE_TEST launch_failed'); process.exitCode = 1; });
    child.once('exit', code => {
      process.exitCode = completionExitCode(repo, run.id, code);
      console.log('LIVE_TEST_EXIT code=' + process.exitCode);
    });
    return;
  }
  if (action === 'record-start' ? rest.length !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(rest[0]) : rest.length !== 0) {
    throw new Error('bad_argument');
  }
  const result = await command(run, action, rest[0]);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error('LIVE_TEST ' + String(error.code || error.message || 'failed').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100));
  process.exitCode = 1;
});
module.exports = { command, completionExitCode };
