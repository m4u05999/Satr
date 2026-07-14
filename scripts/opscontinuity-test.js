#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const opsartifacts = require('../electron/opsartifacts');
const opsroomindex = require('../electron/opsroomindex');
const executionTeamModule = require('../electron/executionteam');

const codec = {
  encrypt(text) { return Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'); },
  decrypt(buffer) { return Buffer.from(buffer.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8'); },
};

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-ops-continuity-'));
  const project = path.join(temp, 'project');
  const vault = path.join(temp, 'vault');
  const indexFile = path.join(temp, 'index.json');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  try {
    const head = 'a'.repeat(40);
    const patch = 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n';
    const artifactId = crypto.createHash('sha256').update(head + '\0' + patch).digest('hex');
    const roomId = 'ops-room-continuity-test';
    const teamId = 'execution-team-continuity-test';
    const agent = {
      id: 'executor-1', label: 'عامل 1', task: 'عدّل الملف', engine: 'sdk', ownership: ['src/app.js'],
      state: 'completed', summary: 'اكتمل', duration_ms: 10,
      cost: { usd: 0 }, permissions: { write_limit: 30, write_used: 1, denied: 0 }, edits_seen: 1,
      changes: { files: [{ rel: 'src/app.js', kind: 'mod', added: 1, removed: 1 }], added: 1, removed: 1 },
      last_tool: 'edit', last_file: 'src/app.js', timeout_ms: 300000, deadline_at: Date.now(), patch_bytes: patch.length,
    };
    const artifact = {
      artifact_id: artifactId, room_id: roomId, team_id: teamId, teamId, cwd: project,
      source_root: project, sourceRoot: project, head, patch, producer_engines: ['sdk'],
      ownership: [['src/app.js']], files: [{ rel: 'src/app.js', kind: 'mod', added: 1, removed: 1, agent: 'عامل 1', agent_id: 'executor-1', engine: 'sdk' }],
    };
    const team = {
      id: teamId, room_id: roomId, state: 'completed', created_at: Date.now() - 20, updated_at: Date.now(),
      duration_ms: 10, agents: [agent], artifact_id: artifactId, producer_engines: ['sdk'], mode: 'mergeable',
      timeout_ms: 300000, merged: false, merge_supported: true,
    };

    assert.strictEqual(opsartifacts.save(artifact, team, { root: vault, codec: {} }).error, 'encryption_unavailable');
    assert.strictEqual(opsartifacts.save(artifact, team, { root: vault, codec }).ok, true);
    const encrypted = fs.readFileSync(opsartifacts.fileFor(artifactId, { root: vault, projectRoot: project }));
    assert(!encrypted.toString('utf8').includes('diff --git'));
    assert(!encrypted.toString('utf8').includes(project));
    const loaded = opsartifacts.load(artifactId, { root: vault, projectRoot: project, codec });
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.artifact.patch, patch);

    assert.strictEqual(opsroomindex.upsert(project, {
      room_id: roomId, team_id: teamId, state: 'completed', artifact_id: artifactId, restorable: true,
    }, { file: indexFile }).ok, true);
    assert.strictEqual(opsroomindex.list(path.join(temp, 'other'), { file: indexFile }).length, 0);
    const history = opsroomindex.list(project, { file: indexFile });
    assert.strictEqual(history.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(history[0], 'project_key'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(history[0], 'patch'), false);
    assert.strictEqual(opsroomindex.upsert(project, {
      room_id: 'ops-room-stale-test', team_id: 'execution-team-stale-test', state: 'running', restorable: false,
    }, { file: indexFile }).ok, true);
    assert.strictEqual(opsroomindex.interruptStale({ file: indexFile }).changed, true);
    assert.strictEqual(opsroomindex.list(project, { file: indexFile }).find((item) => item.room_id === 'ops-room-stale-test').state, 'interrupted');

    const restoredRuntime = executionTeamModule.create({ runner: { engine: 'sdk', start() {} } });
    const events = [];
    const restored = restoredRuntime.restore(loaded, project, (event) => events.push(event));
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(restored.team.artifact_id, artifactId);
    assert.strictEqual(restored.team.verification, null);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(restored.team, 'patch'), false);
    assert.strictEqual(restoredRuntime.artifact(teamId).patch, patch);
    assert(events.some((event) => event.type === 'execution_team_update'));

    fs.appendFileSync(opsartifacts.fileFor(artifactId, { root: vault, projectRoot: project }), 'tamper');
    assert.strictEqual(opsartifacts.load(artifactId, { root: vault, projectRoot: project, codec }).ok, false);
    assert.strictEqual(opsartifacts.remove(artifactId, { root: vault, projectRoot: project }).ok, true);
    const expiredId = 'b'.repeat(64);
    const expiredFile = opsartifacts.fileFor(expiredId, { root: vault, projectRoot: project });
    await fsp.mkdir(path.dirname(expiredFile), { recursive: true });
    await fsp.writeFile(expiredFile, 'expired');
    const old = new Date(Date.now() - opsartifacts.MAX_AGE_MS - 1000);
    await fsp.utimes(expiredFile, old, old);
    assert(opsartifacts.prune({ root: vault }).removed.some((item) => item.artifact_id === expiredId
      && item.project_key === opsartifacts.projectScope(project)));
    assert.strictEqual(opsroomindex.markArtifactsUnavailable([{
      artifact_id: artifactId,
      project_key: opsroomindex.projectKey(project),
    }], { file: indexFile }).changed, true);
    assert.strictEqual(opsroomindex.list(project, { file: indexFile }).find((item) => item.room_id === roomId).restorable, false);

    console.log('✓ artifact vault fails closed without encryption and never stores plaintext patch');
    console.log('✓ project history is filtered without exposing its internal project fingerprint');
    console.log('✓ restored artifacts reopen review state without patch IPC or stale verification');
    console.log('✓ retention pruning and explicit deletion close stale restore entries');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
