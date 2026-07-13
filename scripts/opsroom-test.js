#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const opsroomPath = require.resolve('../electron/opsroom');
const executionTeamModule = require('../electron/executionteam');

function completedExecutorFactory(sourceRoot) {
  let sequence = 0;
  return () => {
    const runId = 'execution-test-' + (++sequence);
    return {
      async start(input, cwd, emit) {
        const run = {
          id: runId,
          state: 'completed',
          engine: 'sdk',
          summary: 'اكتمل',
          artifact_ready: true,
          patch_bytes: 32,
          changes: { files: [{ rel: 'src/app.js', added: 1, removed: 1 }], more: 0, partial: false, added: 1, removed: 1 },
        };
        emit({ type: 'execution_update', run });
        return { ok: true, run };
      },
      artifact() {
        return {
          head: 'a'.repeat(40),
          patch: 'diff --git a/src/app.js b/src/app.js\n',
          sourceRoot,
        };
      },
      stop() { return Promise.resolve({ ok: true }); },
    };
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-opsroom-test-'));
  try {
    let opsroom = require(opsroomPath);
    const created = opsroom.createRoom({ root: temp });
    assert.strictEqual(created.ok, true);
    const roomId = created.room.room_id;
    const teamId = 'execution-team-test-123456';
    const artifactId = 'b'.repeat(64);

    const proposal = opsroom.appendEngine(roomId, 'sdk', {
      type: 'proposal', text: '  اقتراح\u0000 آمن  ', team_id: teamId,
    }, { root: temp });
    assert.strictEqual(proposal.ok, true);
    assert.strictEqual(proposal.entry.actor, 'sdk');
    assert.strictEqual(proposal.entry.text, 'اقتراح آمن');

    assert.strictEqual(opsroom.appendEngine(roomId, 'sdk', {
      type: 'decision', text: 'اعتمدت الدمج', team_id: teamId,
    }, { root: temp }).error, 'authority_denied');
    assert.strictEqual(opsroom.appendEngine(roomId, 'codex', {
      type: 'note', actor: 'user', text: 'أنا المستخدم', team_id: teamId,
    }, { root: temp }).error, 'authority_denied');
    assert.strictEqual(opsroom.appendEngine(roomId, 'sdk', {
      type: 'phase_gate', text: 'المرحلة معتمدة', team_id: teamId,
    }, { root: temp }).error, 'authority_denied');

    assert.strictEqual(opsroom.appendUserDecision(roomId, {
      text: 'قرار بلا تأكيد', team_id: teamId,
    }, false, { root: temp }).error, 'confirmation_required');
    assert.strictEqual(opsroom.appendUserDecision(roomId, {
      actor: 'sdk', text: 'انتحال آخر', team_id: teamId,
    }, true, { root: temp }).error, 'authority_denied');
    const decision = opsroom.appendUserDecision(roomId, {
      text: 'اعتمد المستخدم الانتقال صراحةً', team_id: teamId, artifact_id: artifactId,
    }, true, { root: temp });
    assert.strictEqual(decision.ok, true);
    assert.strictEqual(decision.entry.type, 'decision');
    assert.strictEqual(decision.entry.actor, 'user');
    assert.strictEqual(decision.entry.artifact_id, artifactId);

    assert.strictEqual(opsroom.appendEngine(roomId, 'sdk', {
      type: 'note', text: 'api_key=abcdefghijklmnopqrstuvwxyz123456', team_id: teamId,
    }, { root: temp }).error, 'secret_detected');
    assert.strictEqual(opsroom.appendEngine(roomId, 'sdk', {
      type: 'note', text: 'س'.repeat(opsroom.MAX_TEXT) + ' api_key=abcdefghijklmnopqrstuvwxyz123456', team_id: teamId,
    }, { root: temp }).error, 'secret_detected');
    assert.strictEqual(opsroom.appendSystem(roomId, 'review', {
      text: 'diff --git a/secret.js b/secret.js\n+value', team_id: teamId, artifact_id: artifactId,
    }, { root: temp }).error, 'patch_forbidden');
    assert.strictEqual(opsroom.appendSystem(roomId, 'review', {
      text: 'س'.repeat(opsroom.MAX_TEXT) + '\ndiff --git a/late.js b/late.js', team_id: teamId, artifact_id: artifactId,
    }, { root: temp }).error, 'patch_forbidden');
    assert.strictEqual(opsroom.appendSystem(roomId, 'note', {
      id: 'ops-entry-forged-123456', text: 'معرّف محقون', team_id: teamId,
    }, { root: temp }).error, 'authority_denied');
    const truncated = opsroom.appendSystem(roomId, 'note', {
      text: 'ن'.repeat(opsroom.MAX_TEXT + 100), team_id: teamId,
    }, { root: temp });
    assert.strictEqual(truncated.ok, true);
    assert.strictEqual(truncated.entry.text.length, opsroom.MAX_TEXT);
    assert.strictEqual(opsroom.appendSystem(roomId, 'verification', {
      text: 'x'.repeat(opsroom.MAX_INPUT_TEXT + 1), team_id: teamId, artifact_id: artifactId,
    }, { root: temp }).error, 'text_too_large');
    assert.strictEqual(opsroom.appendSystem(roomId, 'review', {
      text: 'مرجع خاطئ', team_id: '../bad', artifact_id: artifactId,
    }, { root: temp }).error, 'bad_input');

    const beforeRestart = opsroom.load(roomId, { root: temp });
    delete require.cache[opsroomPath];
    opsroom = require(opsroomPath);
    const afterRestart = opsroom.load(roomId, { root: temp });
    assert.deepStrictEqual(afterRestart, beforeRestart);

    const verification = opsroom.appendSystem(roomId, 'verification', {
      text: 'نجح التحقق المثبت.', team_id: teamId, artifact_id: artifactId,
    }, { root: temp });
    assert.strictEqual(verification.ok, true);
    const afterAppend = opsroom.load(roomId, { root: temp });
    assert.deepStrictEqual(afterAppend.entries.slice(0, beforeRestart.entries.length), beforeRestart.entries);
    assert.strictEqual(afterAppend.entries.at(-1).artifact_id, artifactId);
    assert.strictEqual(afterAppend.entries.at(-1).actor, 'system');

    const bounded = opsroom.createRoom({ root: temp });
    assert.strictEqual(bounded.ok, true);
    for (let index = 0; index < opsroom.MAX_ENTRIES; index++) {
      const appended = opsroom.appendSystem(bounded.room.room_id, 'note', {
        text: 'إدخال محدود ' + index, team_id: teamId,
      }, { root: temp });
      assert.strictEqual(appended.ok, true);
    }
    const full = opsroom.appendSystem(bounded.room.room_id, 'note', {
      text: 'لن يحذف قديماً', team_id: teamId,
    }, { root: temp });
    assert.strictEqual(full.ok, false);
    assert.strictEqual(full.error, 'entry_limit');
    const boundedReload = opsroom.load(bounded.room.room_id, { root: temp });
    assert.strictEqual(boundedReload.entries.length, opsroom.MAX_ENTRIES);
    assert.strictEqual(boundedReload.entries[0].text, 'إدخال محدود 0');
    assert(fs.statSync(opsroom.fileFor(bounded.room.room_id, { root: temp })).size <= opsroom.MAX_FILE);

    const linkedRoom = opsroom.createRoom({ root: temp });
    const events = [];
    const executionTeam = executionTeamModule.create({
      runner: { engine: 'sdk', start() {} },
      createExecutor: completedExecutorFactory(temp),
    });
    const teamResult = await executionTeam.start({
      mode: 'mergeable', roomId: linkedRoom.room.room_id,
      agents: [{ task: 'عدّل الملف', ownership: ['src/app.js'] }],
    }, temp, (event) => events.push(event));
    assert.strictEqual(teamResult.ok, true);
    assert.strictEqual(teamResult.team.room_id, linkedRoom.room.room_id);
    assert(executionTeamModule.SAFE_ROOM_ID.test(teamResult.team.room_id));
    assert(opsroom.SAFE_ARTIFACT_ID.test(teamResult.team.artifact_id));
    const artifact = executionTeam.artifact(teamResult.team.id);
    assert.strictEqual(artifact.room_id, linkedRoom.room.room_id);
    assert.strictEqual(artifact.artifact_id, teamResult.team.artifact_id);
    assert.deepStrictEqual(executionTeam.references(teamResult.team.id), {
      room_id: linkedRoom.room.room_id,
      team_id: teamResult.team.id,
      artifact_id: artifact.artifact_id,
    });
    const linked = opsroom.appendSystem(linkedRoom.room.room_id, 'review', {
      text: 'اكتملت المراجعة.', team_id: teamResult.team.id, artifact_id: artifact.artifact_id,
    }, { root: temp });
    assert.strictEqual(linked.ok, true);
    assert.strictEqual(linked.entry.artifact_id, artifact.artifact_id);
    assert(events.every((event) => !JSON.stringify(event).includes('diff --git')));

    const mainSource = await fsp.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(mainSource.includes("ipcMain.handle('satr:opsRoomDecision'"));
    assert(mainSource.includes("p.confirmed !== true || p.id != null || p.type != null || p.actor != null"));
    assert(mainSource.includes("references.room_id !== p.roomId"));
    assert(mainSource.includes("references.artifact_id !== p.artifactId"));
    assert(mainSource.includes("recordOpsSystem(artifact.room_id, 'phase_gate'"));
    assert(mainSource.includes("emitOpsReview(artifact.room_id"));
    assert(mainSource.includes("emitOpsVerification(artifact.room_id"));

    console.log('✓ persistence rebuilds the same bounded timeline after a module restart');
    console.log('✓ append-only preserves earlier entries and rejects overflow without deletion');
    console.log('✓ engine decision, phase gate, and actor:user impersonation fail closed');
    console.log('✓ user decisions require the dedicated confirmed authority path');
    console.log('✓ text is cleaned and bounded while secrets, patches, long output, and bad refs are blocked');
    console.log('✓ room, team, review, verification, merge, and artifact references remain correctly bound');
    console.log('✓ public execution events and the ledger never include the artifact patch');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
