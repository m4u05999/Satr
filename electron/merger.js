/**
 * بوابة تطبيق فرق فريق التنفيذ على مستودع المستخدم بموافقة صريحة.
 *
 * أصغر مسار آمن: HEAD لم يتغير، شجرة العمل نظيفة، git apply --check ينجح، ثم git apply.
 * لا force ولا rebase ولا commit ولا تعديل تاريخ. أي تعقيد يُرفض قبل الكتابة.
 */

'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.satr', 'merge');
const GIT_TIMEOUT_MS = 30000;
const MAX_PATCH_BYTES = 12 * 1024 * 1024;

function runGit(cwd, args, options) {
  const settings = options || {};
  const execute = typeof settings.execFile === 'function' ? settings.execFile : execFile;
  return new Promise((resolve) => {
    execute('git', args, {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, encoding: 'buffer',
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      out: (stdout || Buffer.alloc(0)).toString('utf8'),
      err: (stderr || Buffer.alloc(0)).toString('utf8'),
      code: error && error.code,
    }));
  });
}

function inside(root, target) {
  const base = path.resolve(root);
  const wanted = path.resolve(target);
  return wanted !== base && wanted.startsWith(base + path.sep);
}

function create(options) {
  const settings = options || {};
  const storageRoot = path.resolve(settings.root || ROOT);

  async function apply(input) {
    const data = input || {};
    if (data.confirmed !== true || typeof data.cwd !== 'string' || !data.cwd.trim()
      || typeof data.sourceRoot !== 'string' || !data.sourceRoot.trim()
      || typeof data.patch !== 'string' || !data.patch
      || !/^[0-9a-f]{40,64}$/i.test(data.head || '')) {
      return { ok: false, error: data.confirmed === true ? 'bad_input' : 'confirmation_required' };
    }
    const bytes = Buffer.byteLength(data.patch, 'utf8');
    if (bytes > MAX_PATCH_BYTES) return { ok: false, error: 'patch_too_large' };

    const top = await runGit(data.cwd, ['rev-parse', '--show-toplevel'], settings);
    if (!top.ok || !top.out.trim()) return { ok: false, error: top.code === 'ENOENT' ? 'no_git' : 'no_repo' };
    let repoRoot;
    let expectedRoot;
    let requestedCwd;
    try {
      repoRoot = fs.realpathSync(top.out.trim());
      expectedRoot = fs.realpathSync(data.sourceRoot);
      requestedCwd = fs.realpathSync(data.cwd);
    } catch { return { ok: false, error: 'no_repo' }; }
    if (path.resolve(repoRoot) !== path.resolve(expectedRoot)
      || (path.resolve(requestedCwd) !== path.resolve(repoRoot) && !inside(repoRoot, requestedCwd))) {
      return { ok: false, error: 'wrong_repo' };
    }
    const head = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], settings);
    if (!head.ok || head.out.trim().toLowerCase() !== data.head.toLowerCase()) return { ok: false, error: 'head_changed' };
    const status = await runGit(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all'], settings);
    if (!status.ok) return { ok: false, error: 'status_failed' };
    if (status.out) return { ok: false, error: 'dirty_worktree' };

    try { fs.mkdirSync(storageRoot, { recursive: true }); } catch { return { ok: false, error: 'storage_failed' }; }
    let realStorage;
    try { realStorage = fs.realpathSync(storageRoot); } catch { return { ok: false, error: 'storage_failed' }; }
    const patchPath = path.join(realStorage, 'merge-' + Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex') + '.patch');
    if (!inside(realStorage, patchPath)) return { ok: false, error: 'unsafe_path' };
    try {
      fs.writeFileSync(patchPath, data.patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const check = await runGit(repoRoot, ['apply', '--check', '--whitespace=nowarn', '--', patchPath], settings);
      if (!check.ok) return { ok: false, error: 'conflict', message: (check.err || check.out).trim().slice(0, 1200) };
      const applied = await runGit(repoRoot, ['apply', '--whitespace=nowarn', '--', patchPath], settings);
      if (!applied.ok) return { ok: false, error: 'apply_failed', message: (applied.err || applied.out).trim().slice(0, 1200) };
      return { ok: true, applied: true, files: Array.isArray(data.files) ? data.files.length : 0, head: data.head };
    } catch {
      return { ok: false, error: 'storage_failed' };
    } finally {
      try { fs.rmSync(patchPath, { force: true }); } catch { /* أفضل جهد */ }
    }
  }

  return { apply };
}

const singleton = create();

module.exports = {
  create,
  apply: singleton.apply,
  ROOT,
  MAX_PATCH_BYTES,
};
