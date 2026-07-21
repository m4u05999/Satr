#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const inject = require('../electron/inject');
const files = require('../electron/files');
const renderertrust = require('../electron/renderertrust');
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
  const form = formatPermissionDetail('browser_fill_form', { fields: [
    { ref: 'e1', value: 'smtp-relay.brevo.com' }, { ref: 'e2', value: '587' },
  ] });
  assert(form.includes('smtp-relay.brevo.com') && form.includes('587'));
  const secretRequest = formatPermissionDetail('browser_request_secret', {
    field_ref: 'e3', reason: 'مفتاح SMTP', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
  });
  assert(secretRequest.includes('مفتاح SMTP') && !secretRequest.includes('sk-proj-'));
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

async function testLinkedPathContainment() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-viewer-link-'));
  const project = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  const linked = path.join(project, 'linked');
  const relative = 'linked/secret.txt';
  const original = 'خارج المشروع\n';
  try {
    await fsp.mkdir(project, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, 'secret.txt'), original, 'utf8');
    await fsp.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');

    assert.deepStrictEqual(files.readText(project, relative), { ok: false, error: 'outside' });
    const injected = inject.injectFiles('راجع @linked/secret.txt', project);
    assert.strictEqual(injected.attached.length, 0);
    assert(injected.skipped.some((item) => item.rel === relative && item.reason === 'outside'));
    assert.deepStrictEqual(
      tools.saveFromViewer(project, relative, 'تعديل مرفوض\n', files.contentVersion(original)),
      { ok: false, error: 'outside' },
    );
    assert.strictEqual(await fsp.readFile(path.join(outside, 'secret.txt'), 'utf8'), original);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testRendererTrust() {
  const trustedUrl = renderertrust.fileUrl(path.join(ROOT, 'src', 'index.html'));
  const mainFrame = { url: trustedUrl };
  const webContents = { mainFrame };
  const mainWindow = { isDestroyed: () => false, webContents };
  assert.strictEqual(renderertrust.isTrustedIpcEvent({ sender: webContents, senderFrame: mainFrame }, mainWindow, trustedUrl), true);
  assert.strictEqual(renderertrust.isTrustedIpcEvent({ sender: webContents, senderFrame: { url: trustedUrl } }, mainWindow, trustedUrl), false);
  assert.strictEqual(renderertrust.isTrustedIpcEvent({ sender: webContents, senderFrame: { url: 'https://example.com' } }, mainWindow, trustedUrl), false);
  let prevented = false;
  assert.strictEqual(renderertrust.allowNavigation({ preventDefault() { prevented = true; } }, trustedUrl, trustedUrl), true);
  assert.strictEqual(prevented, false);
  assert.strictEqual(renderertrust.allowNavigation({ preventDefault() { prevented = true; } }, 'https://example.com', trustedUrl), false);
  assert.strictEqual(prevented, true);
}

async function testWiring() {
  const preload = await fsp.readFile(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const main = await fsp.readFile(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const viewer = await fsp.readFile(path.join(ROOT, 'src', 'ui', 'components', 'file-viewer.js'), 'utf8');
  assert(preload.includes('writeFile: (cwd, rel, content, version)'));
  assert(main.includes('saveFromViewer(cwd, rel, p.content, version)'));
  assert(preload.includes('secretDone: (id, done)'));
  assert(main.includes("const SAFE_SECRET_REQUEST_ID = /^secret_[a-f0-9]{32}$/"));
  assert(main.includes("typeof p.done !== 'boolean'"));
  assert(viewer.includes('this._rel, content, this._version'));
}

(async () => {
  await testPermissionDetail();
  await testViewerConflictGuard();
  await testLinkedPathContainment();
  testRendererTrust();
  await testWiring();
  console.log('viewer-security-test: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
