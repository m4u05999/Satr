#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const activity = require('../electron/activity');

function readSource(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-activity-'));
const projectA = path.join(root, 'project-a');
const projectB = path.join(root, 'project-b');
fs.mkdirSync(projectA); fs.mkdirSync(projectB);

let clock = 1700000000000;
const file = path.join(root, 'activity.json');
const store = activity.createStore({ file, now: () => ++clock });

store.onEvent({ type: 'prompt', engine: 'sdk', cwd: projectA, prompt: 'SECRET_PROMPT' });
store.onEvent({
  type: 'assistant', message: { content: [{
    type: 'tool_use', name: 'Read', input: { path: 'SECRET_INPUT' },
  }] },
}, { engine: 'sdk' });
store.onEvent({ type: 'permission_request', id: 'permission-secret-id', tool: 'Bash', input: { command: 'SECRET_COMMAND' } }, { engine: 'sdk' });
store.onEvent({ type: 'permission_reply', id: 'permission-secret-id', allow: false }, { engine: 'sdk' });
store.onEvent({ type: 'file_edit', rel: 'src/app.js', added: 4, removed: 2, tool: 'Edit' }, { engine: 'sdk' });
store.onEvent({ type: 'result', duration_ms: 1250, is_error: false, session_id: 'SECRET_SESSION' }, { engine: 'sdk' });

const listedA = store.list(projectA, 20);
assert.strictEqual(listedA.ok, true);
assert.strictEqual(listedA.count, 5);
assert.deepStrictEqual(listedA.entries.map((entry) => entry.kind), ['result', 'file_edit', 'permission', 'tool', 'prompt']);
assert.strictEqual(listedA.entries.some((entry) => Object.hasOwn(entry, 'project_id')), false);
assert.strictEqual(listedA.entries.find((entry) => entry.kind === 'permission').allow, false);
assert.strictEqual(listedA.entries.find((entry) => entry.kind === 'file_edit').rel, 'src/app.js');

const raw = fs.readFileSync(file, 'utf8');
for (const secret of ['SECRET_PROMPT', 'SECRET_INPUT', 'SECRET_COMMAND', 'SECRET_SESSION', projectA, 'permission-secret-id']) {
  assert.strictEqual(raw.includes(secret), false, 'activity log must not store ' + secret);
}

store.onEvent({ type: 'prompt', engine: 'codex', cwd: projectB, prompt: 'other' });
store.onEvent({ type: 'result', is_error: true }, { engine: 'codex' });
assert.strictEqual(store.list(projectB).count, 2);
assert.strictEqual(store.list(projectA).count, 5);
assert.deepStrictEqual(store.clear(projectA), { ok: true, removed: 5 });
assert.strictEqual(store.list(projectA).count, 0);
assert.strictEqual(store.list(projectB).count, 2);

const boundedFile = path.join(root, 'bounded.json');
const bounded = activity.createStore({ file: boundedFile, now: () => ++clock });
bounded.onEvent({ type: 'prompt', engine: 'sdk', cwd: projectA });
for (let index = 0; index < activity.MAX_ENTRIES + 20; index++) {
  bounded.onEvent({ type: 'result', duration_ms: index }, { engine: 'sdk' });
}
const boundedRaw = JSON.parse(fs.readFileSync(boundedFile, 'utf8'));
assert.strictEqual(boundedRaw.entries.length, activity.MAX_ENTRIES);

fs.writeFileSync(path.join(root, 'corrupt.json'), '{bad', 'utf8');
const corrupt = activity.createStore({ file: path.join(root, 'corrupt.json') });
assert.strictEqual(corrupt.list(projectA).count, 0);

const mainSource = readSource('electron/main.js');
const preloadSource = readSource('electron/preload.js');
const topbarSource = readSource('src/ui/components/topbar.js');
assert(mainSource.includes("ipcMain.handle('satr:activityList'"));
assert(mainSource.includes("ipcMain.handle('satr:activityClear'"));
assert(mainSource.includes('payload.confirmed !== true'));
assert(preloadSource.includes('activityList:'));
assert(preloadSource.includes('activityClear:'));
assert(topbarSource.includes('refreshActivity'));

fs.rmSync(root, { recursive: true, force: true });
console.log('✓ activity stores bounded project-local metadata only');
console.log('✓ prompts, tool inputs, outputs, absolute paths, sessions, and permission ids never persist');
console.log('✓ project filtering, confirmed clear, corruption fallback, and IPC/UI wiring are covered');
