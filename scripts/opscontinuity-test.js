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
    // البند 29: بصمة الأثر مشتقة من HEAD+patch فتتشاركها غرفتان أنتجتا الفرق نفسه —
    // تعليم البصمة يجب أن يقفل ادعاء الاستعادة في كل الغرف المتشاركة بنداء واحد.
    const twinRoomId = 'ops-room-continuity-twin';
    assert.strictEqual(opsroomindex.upsert(project, {
      room_id: twinRoomId, team_id: 'execution-team-continuity-twin', state: 'completed',
      artifact_id: artifactId, restorable: true,
    }, { file: indexFile }).ok, true);
    assert.strictEqual(opsroomindex.markArtifactsUnavailable([{
      artifact_id: artifactId,
      project_key: opsroomindex.projectKey(project),
    }], { file: indexFile }).changed, true);
    const flipped = opsroomindex.list(project, { file: indexFile });
    assert.strictEqual(flipped.find((item) => item.room_id === roomId).restorable, false);
    assert.strictEqual(flipped.find((item) => item.room_id === twinRoomId).restorable, false);

    // ── البند 30: حقلا العرض الاختياريان task_excerpt/run_kind (additive، fail-closed) ──
    // بناء المدخلات بـ fromCharCode لا بـ \u الحرفية (تنقية بنقاط Unicode لا تحتاج مصدراً هشّاً).
    const RLO = String.fromCharCode(0x202e), LRM = String.fromCharCode(0x200e), RLM = String.fromCharCode(0x200f);
    const isUnsafePoint = (code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      || code === 0x061c || code === 0x200e || code === 0x200f
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    const longExcerpt = 'ابدأ' + RLO + '   المهمة' + RLM + ' ' + 'ط'.repeat(200);
    assert.strictEqual(opsroomindex.upsert(project, {
      room_id: 'ops-room-a2-note30', team_id: 'execution-team-a2-note30', state: 'completed',
      task_excerpt: longExcerpt, run_kind: 'loop',
    }, { file: indexFile }).ok, true);
    const note30 = opsroomindex.list(project, { file: indexFile }).find((item) => item.room_id === 'ops-room-a2-note30');
    assert.strictEqual(note30.run_kind, 'loop');
    assert.strictEqual([...note30.task_excerpt].length, opsroomindex.MAX_TASK_EXCERPT, 'قصّ المقتطف بنقاط Unicode');
    assert(![...note30.task_excerpt].some((ch) => isUnsafePoint(ch.codePointAt(0))), 'إزالة التحكّم وBidi من المقتطف');
    assert(!/\s{2,}/.test(note30.task_excerpt), 'طيّ الفراغات في المقتطف');

    // قصّ آمن لا يكسر زوجاً بديلاً عند الحد (79 محرفاً + إيموجي = 80 نقطة، والتالي يسقط)
    const emoji = String.fromCodePoint(0x1f600);
    assert.strictEqual(opsroomindex.upsert(project, {
      room_id: 'ops-room-a2-surrogate', team_id: 'execution-team-a2-surrogate', state: 'completed',
      task_excerpt: 'x'.repeat(opsroomindex.MAX_TASK_EXCERPT - 1) + emoji + 'y', run_kind: 'team',
    }, { file: indexFile }).ok, true);
    const surr = opsroomindex.list(project, { file: indexFile }).find((item) => item.room_id === 'ops-room-a2-surrogate');
    assert.strictEqual([...surr.task_excerpt].length, opsroomindex.MAX_TASK_EXCERPT);
    assert(surr.task_excerpt.endsWith(emoji), 'المقتطف لا يقطع زوجاً بديلاً عند الحد');
    assert.strictEqual(surr.run_kind, 'team');

    // fail-closed: run_kind فاسد أو task_excerpt غير نصّي يُسقط الحقل وحده لا المدخل
    assert.strictEqual(opsroomindex.upsert(project, {
      room_id: 'ops-room-a2-bad', team_id: 'execution-team-a2-bad', state: 'completed',
      task_excerpt: 12345, run_kind: 'bogus',
    }, { file: indexFile }).ok, true);
    const bad = opsroomindex.list(project, { file: indexFile }).find((item) => item.room_id === 'ops-room-a2-bad');
    assert.strictEqual(bad.state, 'completed');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(bad, 'run_kind'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(bad, 'task_excerpt'), false);

    // التوافق الخلفي: مدخل قديم بلا الحقلين يبقى شكل قائمته حرفياً (لا مفاتيح جديدة)
    const legacy = opsroomindex.list(project, { file: indexFile }).find((item) => item.room_id === roomId);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacy, 'run_kind'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacy, 'task_excerpt'), false);

    // عقد ساكن على main.js (نمط assertStaticContract): مسار الدمج يعلّم البصمة المشتركة
    // بعد حذف الملف المشفّر، ومسار الاستعادة يعلّمها عند غياب/فساد الملف فقط.
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    const mergeStart = mainSource.indexOf("ipcMain.handle('satr:executionMerge'");
    const mergeBlock = mainSource.slice(mergeStart, mainSource.indexOf("ipcMain.handle('satr:opsRoomHistory'"));
    assert(mergeStart >= 0 && mergeBlock.includes('opsartifacts.remove(artifact.artifact_id'),
      'غاب حذف الأثر من مسار الدمج في main.js');
    assert(mergeBlock.indexOf('opsroomindex.markArtifactsUnavailable')
      > mergeBlock.indexOf('opsartifacts.remove(artifact.artifact_id'),
      'يجب أن يعلّم مسار الدمج البصمة المشتركة غير قابلة للاستعادة بعد حذف الملف المشفّر (البند 29).');
    const restoreBlock = mainSource.slice(mainSource.indexOf("ipcMain.handle('satr:opsRoomRestore'"),
      mainSource.indexOf("ipcMain.handle('satr:opsRoomArtifactDelete'"));
    assert(restoreBlock.includes("loaded.error === 'artifact_unavailable'")
      && restoreBlock.includes('opsroomindex.markArtifactsUnavailable'),
      'يجب أن يعلّم مسار الاستعادة البصمة عند غياب/فساد ملف الأثر (البند 29 — دفاع ثانٍ).');

    // البند 30: updateOpsRoomIndex يشتق run_kind من مطابقة فريق الحلقة الحالية (حقيقة)
    // لا من تخمين، ويمرّر مقتطف مهمة العامل الأول والحقلين إلى upsert.
    const idxBlock = mainSource.slice(mainSource.indexOf('function updateOpsRoomIndex('),
      mainSource.indexOf('function savedOpsArtifactKey('));
    assert(idxBlock.includes('loopRunner.latest(cwd)') && idxBlock.includes("=== team.id ? 'loop' : 'team'"),
      'run_kind يجب أن يُشتق من مطابقة فريق الحلقة الحالية لا من تخمين (البند 30).');
    assert(idxBlock.includes('team.agents[0]') && idxBlock.includes('task_excerpt: taskExcerpt')
      && idxBlock.includes('run_kind: runKind'),
      'updateOpsRoomIndex يجب أن يمرّر task_excerpt وrun_kind إلى upsert (البند 30).');

    console.log('✓ artifact vault fails closed without encryption and never stores plaintext patch');
    console.log('✓ index entries carry sanitized task_excerpt/run_kind additively and fail closed (item 30)');
    console.log('✓ project history is filtered without exposing its internal project fingerprint');
    console.log('✓ restored artifacts reopen review state without patch IPC or stale verification');
    console.log('✓ retention pruning and explicit deletion close stale restore entries');
    console.log('✓ merge/restore paths close every shared-fingerprint restore claim (item 29)');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
