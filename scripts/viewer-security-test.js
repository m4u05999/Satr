#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const files = require('../electron/files');
const tools = require('../electron/tools');

async function permissionDetailModule() {
  const source = await fsp.readFile(path.join(ROOT, 'src', 'ui', 'lib', 'permission-detail.js'), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

async function testPermissionDetail() {
  const { formatPermissionDetail } = await permissionDetailModule();
  const detail = formatPermissionDetail('browser_type', { ref: 'e7', text: 'مرحبا\nworld' });
  assert(detail.includes('العنصر: e7'));
  assert(detail.includes('"مرحبا\\nworld"'));
  assert(formatPermissionDetail('mcp__satr-preview__browser_type', { ref: '#email', text: 'a@b.test' }).includes('a@b.test'));
  assert.strictEqual(formatPermissionDetail('browser_click', { ref: 'e5' }), '');

  const long = formatPermissionDetail('browser_type', { ref: 'e7', text: 'س'.repeat(700) });
  assert(long.endsWith('…'));
  assert(long.length < 700);
}

async function testViewerConflictGuard() {
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-viewer-'));
  const relative = 'note.txt';
  const absolute = path.join(project, relative);
  try {
    await fsp.writeFile(absolute, 'النسخة الأولى\n', 'utf8');
    const opened = files.readText(project, relative);
    assert(opened.ok && /^[a-f0-9]{64}$/.test(opened.version));

    await fsp.writeFile(absolute, 'تعديل خارجي\n', 'utf8');
    const conflict = tools.saveFromViewer(project, relative, 'تعديل العارض\n', opened.version);
    assert.deepStrictEqual(conflict, { ok: false, error: 'conflict' });
    assert.strictEqual(await fsp.readFile(absolute, 'utf8'), 'تعديل خارجي\n');

    const fresh = files.readText(project, relative);
    const saved = tools.saveFromViewer(project, relative, 'تعديل العارض\n', fresh.version);
    assert(saved.ok && saved.card);
    assert.strictEqual(await fsp.readFile(absolute, 'utf8'), 'تعديل العارض\n');
    assert.strictEqual(tools.saveFromViewer(project, relative, 'x', '').error, 'bad_version');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

async function testWiring() {
  const preload = await fsp.readFile(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const main = await fsp.readFile(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const viewer = await fsp.readFile(path.join(ROOT, 'src', 'ui', 'components', 'file-viewer.js'), 'utf8');
  assert(preload.includes('writeFile: (cwd, rel, content, version)'));
  assert(main.includes('saveFromViewer(cwd, rel, p.content, version)'));
  assert(viewer.includes('this._rel, content, this._version'));
}

(async () => {
  await testPermissionDetail();
  await testViewerConflictGuard();
  await testWiring();
  console.log('viewer-security-test: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
