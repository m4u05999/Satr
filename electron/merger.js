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
const { gitArgs } = require('./gitsafe'); // OBS-136: يُبطل مفاتيح الإعداد المُنفِّذة

const ROOT = path.join(os.homedir(), '.satr', 'merge');
const GIT_TIMEOUT_MS = 30000;
const MAX_PATCH_BYTES = 12 * 1024 * 1024;

function runGit(cwd, args, options) {
  const settings = options || {};
  const execute = typeof settings.execFile === 'function' ? settings.execFile : execFile;
  return new Promise((resolve) => {
    // OBS-136: تحصين إعداد المستودع المُنفِّذ
    execute('git', gitArgs(args), {
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

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function sameEntry(left, right) {
  try {
    const leftStat = fs.statSync(left, { bigint: true });
    const rightStat = fs.statSync(right, { bigint: true });
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    if (leftStat.ino !== 0n && rightStat.ino !== 0n) {
      return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    }
  } catch { return false; }
  return samePath(left, right);
}

function inside(root, target) {
  const relative = path.relative(comparablePath(root), comparablePath(target));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
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
    if (!data.review_gate || data.review_gate.ok !== true || data.review_gate.verdict !== 'approve') {
      return { ok: false, error: 'review_required' };
    }
    if (!data.verification || data.verification.state !== 'passed') {
      return { ok: false, error: 'verification_required' };
    }
    if (!/^[0-9a-f]{64}$/.test(data.artifact_id || '')
      || data.artifact_id !== crypto.createHash('sha256').update(data.head + '\0' + data.patch).digest('hex')
      || data.verification.artifact_id !== data.artifact_id) {
      return { ok: false, error: 'verification_artifact_mismatch' };
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
    if (!sameEntry(repoRoot, expectedRoot)
      || (!sameEntry(requestedCwd, repoRoot) && !inside(repoRoot, requestedCwd))) {
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
  _internals: { sameEntry },
};
