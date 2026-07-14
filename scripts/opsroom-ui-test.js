#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function gitLines(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles() {
  return [...new Set([
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])].filter((relative) => fs.existsSync(path.join(ROOT, relative)));
}

async function loadStateModule() {
  const source = read('src/ui/lib/ops-room-state.js');
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return import(url + '#' + Date.now());
}

function fixture(artifactId) {
  const team = {
    id: 'execution-team-ui-test', room_id: 'ops-room-ui-test', state: 'completed',
    artifact_id: artifactId, merge_supported: true, merged: false, agents: [],
  };
  const review = {
    id: 'execution-review-ui-test', team_id: team.id, artifact_id: artifactId, state: 'completed',
    required_review_engines: ['sdk', 'codex'],
    reviews: ['sdk', 'codex'].map((engine) => ({
      engine, artifact_id: artifactId, state: 'completed',
      verdict: { schema_version: 1, decision: 'approve', source: 'explicit' },
    })),
  };
  const verification = { artifact_id: artifactId, state: 'passed', checks: [] };
  return { team, review, verification };
}

async function testReducer() {
  const stateModule = await loadStateModule();
  const { createOpsRoomState, opsRoomReducer, deriveOpsRoomState, isCurrentArtifact } = stateModule;
  const artifact = 'a'.repeat(64);
  const staleArtifact = 'b'.repeat(64);
  const current = fixture(artifact);

  let state = createOpsRoomState();
  assert.strictEqual(deriveOpsRoomState(state).canStart, true, 'initial execution must be available');
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'execution_team_update', team: { ...current.team, state: 'running', artifact_id: '' },
  } });
  assert.strictEqual(deriveOpsRoomState(state).canStop, true, 'running team must be stoppable');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.key, 'team_running', 'running team needs a truthful wait instruction');
  assert.strictEqual(deriveOpsRoomState(state).canReview, false, 'review cannot start before artifact completion');

  state = opsRoomReducer(state, { type: 'hydrate', room: {
    room_id: current.team.room_id,
    entries: [
      { id: 'ops-entry-b', type: 'note', actor: 'system', text: 'ثانٍ', created_at: 20 },
      { id: 'ops-entry-a', type: 'note', actor: 'system', text: 'أول', created_at: 10 },
    ],
  }, team: current.team });
  assert.deepStrictEqual(state.entries.map((entry) => entry.id), ['ops-entry-a', 'ops-entry-b'], 'hydrate ordering');
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'ops_room_update', room_id: current.team.room_id,
    entry: { id: 'ops-entry-c', type: 'note', actor: 'system', text: 'ثالث', created_at: 20 },
  } });
  state = opsRoomReducer(state, { type: 'event', event: {
    type: 'ops_room_update', room_id: current.team.room_id,
    entry: { id: 'ops-entry-c', type: 'note', actor: 'system', text: 'مكرر', created_at: 20 },
  } });
  assert.deepStrictEqual(state.entries.map((entry) => entry.id), ['ops-entry-a', 'ops-entry-b', 'ops-entry-c'], 'stable dedupe ordering');
  assert.strictEqual(deriveOpsRoomState(state).canReview, true, 'completed artifact must expose explicit review action');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'review', 'completed artifact recommends review without starting it');

  state = opsRoomReducer(state, { type: 'settled', review: current.review });
  assert.strictEqual(deriveOpsRoomState(state).canPrepareVerification, true, 'all actual verdicts unlock prepare only');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'prepare');
  state = opsRoomReducer(state, { type: 'settled', verification: { ...current.verification, state: 'pending_confirmation' } });
  assert.strictEqual(deriveOpsRoomState(state).canRunVerification, true, 'pending verification needs explicit confirmation');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'verify');
  state = opsRoomReducer(state, { type: 'settled', verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, true, 'same-artifact approvals and verification unlock merge');
  assert.strictEqual(deriveOpsRoomState(state).nextAction.action, 'merge');
  assert.strictEqual(isCurrentArtifact(current.verification, state), true, 'artifact helper accepts current fingerprint');

  const staleReview = fixture(staleArtifact).review;
  state = opsRoomReducer(state, { type: 'settled', review: staleReview, verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'stale review must not unlock merge');
  state = opsRoomReducer(state, { type: 'settled', review: current.review,
    verification: { ...current.verification, artifact_id: staleArtifact } });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'stale verification must not unlock merge');
  const mixedFingerprint = fixture(artifact).review;
  mixedFingerprint.reviews[1] = { ...mixedFingerprint.reviews[1], artifact_id: staleArtifact };
  state = opsRoomReducer(state, { type: 'settled', review: mixedFingerprint, verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'one stale verdict must close the gate');
  const rejected = fixture(artifact).review;
  rejected.reviews[0] = { ...rejected.reviews[0], verdict: {
    schema_version: 1, decision: 'reject', source: 'explicit',
  } };
  state = opsRoomReducer(state, { type: 'settled', review: rejected, verification: current.verification });
  assert.strictEqual(deriveOpsRoomState(state).canMerge, false, 'rejection cannot be overridden');
}

function testDesignGuard() {
  const files = changedFiles();
  const inlineStyle = new RegExp('\\sstyle\\s*=', 'i');
  const inlineHandler = /\son[a-z]+\s*=/i;
  const inlineScript = /<script(?![^>]*\bsrc\s*=)[^>]*>/i;
  const shadowStyleTag = new RegExp('<' + 'style(?:\\s|>)', 'i');
  const numericZ = /z-index\s*:\s*-?\d+(?:\.\d+)?\b/i;
  for (const relative of files) {
    const normalized = relative.replace(/\\/g, '/');
    const source = read(relative);
    if (normalized.endsWith('.html')) {
      assert(!inlineStyle.test(source), normalized + ': inline style attribute');
      assert(!inlineHandler.test(source), normalized + ': inline event handler');
      assert(!inlineScript.test(source), normalized + ': inline script block');
    }
    if (normalized.endsWith('.js') && normalized.startsWith('src/ui/')) {
      assert(!shadowStyleTag.test(source), normalized + ': style tag inside component source');
      assert(!numericZ.test(source), normalized + ': numeric z-index outside tokens');
    }
    if (normalized.endsWith('.css') && normalized !== 'src/styles/base.css'
      && !normalized.startsWith('src/vendor/')) {
      assert(!numericZ.test(source), normalized + ': numeric z-index outside tokens');
    }
  }
  const index = read('src/index.html');
  assert(!index.includes("'unsafe-inline'"), 'CSP must remain strict');
  const base = read('src/styles/base.css');
  for (const token of ['--z-base: 0', '--z-system: 1000', '--space-0: 0', '--space-7: 48px',
    '--radius-xs: 4px', '--radius-pill: 999px']) assert(base.includes(token), 'missing design token ' + token);
  const component = read('src/ui/components/ops-room.js');
  assert(component.includes('adoptedStyleSheets'), 'ops room must use constructable stylesheets');
  assert(!/\bconfirm\s*\(/.test(component), 'native confirm must not own ops decisions');
  const handleEventBody = component.slice(component.indexOf('  handleEvent(event) {'), component.indexOf('\n  }\n}', component.indexOf('  handleEvent(event) {')));
  assert(!handleEventBody.includes('._startReview(') && !handleEventBody.includes('._prepareVerification('),
    'runtime events must not create an agent-to-agent loop');
  const app = read('src/ui/app.js');
  assert(app.includes("state: 'hidden'") && app.includes("record.state = 'held'") && app.includes("record.state = 'active'"),
    'surface coordinator states missing');
  assert(app.includes("surfaceCoordinator.confirm(detail)"), 'ops dialog must pass through coordinator');
  const mainProcess = read('electron/main.js');
  assert(!mainProcess.includes('executionTeam.SAFE_RUN_ID.test('),
    'IPC handlers must validate team ids through the module export, not the runtime instance');
  assert(mainProcess.includes('executionTeamModule.SAFE_RUN_ID.test('),
    'IPC handlers must retain the execution-team id guard');
  assert(mainProcess.includes('OPS_TIMEOUT_SECONDS.has(timeoutSeconds)'), 'timeout presets must be validated in main');
  assert(mainProcess.includes("ipcMain.handle('satr:executionTeamExtend'"), 'one-shot timeout extension IPC missing');
  assert(mainProcess.includes("'team-terminal:' + team.id + ':' + team.state"), 'terminal team outcomes must enter the durable ledger');
  assert(mainProcess.includes("ipcMain.handle('satr:opsRoomRestore'"), 'artifact restore IPC missing');
  assert(mainProcess.includes("ipcMain.handle('satr:opsRoomArtifactDelete'"), 'artifact deletion IPC missing');
  assert(mainProcess.includes("ipcMain.handle('satr:opsBrainstormStart'"), 'brainstorm IPC missing');
  assert(mainProcess.includes('opsBrainstorm.latest(cwd)'), 'brainstorm history must be scoped to the active project');
  assert(mainProcess.includes("ipcMain.handle('satr:opsPlanStart'"), 'planner IPC missing');
  const preload = read('electron/preload.js');
  assert(preload.includes('timeoutSeconds'), 'timeout preset must cross the narrow preload bridge explicitly');
  assert(preload.includes('executionTeamExtend'), 'timeout extension must cross a narrow preload method');
  for (const method of ['opsRoomHistory', 'opsRoomRestore', 'opsRoomArtifactDelete', 'opsBrainstormStart', 'opsPlanStart']) {
    assert(preload.includes(method), 'missing narrow preload method ' + method);
  }
}

async function main() {
  await testReducer();
  testDesignGuard();
  console.log('opsroom-ui: reducer, gates, event order, stale artifacts, CSP and design guard passed');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
