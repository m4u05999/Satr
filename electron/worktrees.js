/**
 * دورة حياة worktree معزول لعامل «سطر» المنفّذ.
 *
 * الإنشاء من HEAD بوضع detached تحت ~/.satr/worktrees، وكل أوامر git عبر execFile
 * ومصفوفة وسائط بلا shell. لا merge/commit/checkout لفرع المستخدم. الإزالة القسرية
 * محصورة في worktree المؤقت المولّد داخلياً بعد التقاط الفرق، ثم prune للسجل.
 */

'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gitdiff = require('./gitdiff');
const { gitArgs } = require('./gitsafe'); // OBS-136: يُبطل مفاتيح الإعداد المُنفِّذة

const ROOT = path.join(os.homedir(), '.satr', 'worktrees');
const GIT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^wt-[a-z0-9-]{6,80}$/;
const MAX_LIVE = 8;

let sequence = 0;

function runGit(cwd, args, options) {
  const settings = options || {};
  const execute = typeof settings.execFile === 'function' ? settings.execFile : execFile;
  return new Promise((resolve) => {
    // OBS-136: تحصين إعداد المستودع المُنفِّذ
    execute('git', gitArgs(args), {
      cwd,
      timeout: Math.min(Number(settings.gitTimeoutMs) || GIT_TIMEOUT_MS, GIT_TIMEOUT_MS),
      maxBuffer: Math.min(Number(settings.maxBuffer) || MAX_BUFFER, MAX_BUFFER),
      windowsHide: true,
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        out: (stdout || Buffer.alloc(0)).toString('utf8'),
        err: (stderr || Buffer.alloc(0)).toString('utf8'),
        code: error && error.code,
      });
    });
  });
}

function inside(root, target) {
  const base = path.resolve(root);
  const wanted = path.resolve(target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return wanted !== base && wanted.startsWith(prefix);
}

function overlaps(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || inside(a, b) || inside(b, a);
}

function publicWorktree(record) {
  return {
    id: record.id,
    repo_name: path.basename(record.repoRoot),
    head: record.head,
    created_at: record.createdAt,
  };
}

function hasUnsafeEntries(output) {
  const records = String(output || '').split('\0').filter(Boolean);
  return records.some((record) => record.startsWith('120000 ') || record.startsWith('160000 '));
}

function createManager(options) {
  const settings = options || {};
  const configuredRoot = path.resolve(settings.root || ROOT);
  const live = new Map();

  async function repository(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: 'bad_cwd' };
    const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], settings);
    if (!top.ok || !top.out.trim()) return { ok: false, error: top.code === 'ENOENT' ? 'no_git' : 'no_repo' };
    let repoRoot;
    try { repoRoot = fs.realpathSync(top.out.trim()); } catch { return { ok: false, error: 'no_repo' }; }
    const head = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], settings);
    if (!head.ok || !/^[0-9a-f]{40,64}$/i.test(head.out.trim())) return { ok: false, error: 'no_head' };
    return { ok: true, repoRoot, head: head.out.trim() };
  }

  async function create(cwd, requestedHead) {
    if (live.size >= MAX_LIVE) return { ok: false, error: 'too_many' };
    const repo = await repository(cwd);
    if (!repo.ok) return repo;
    const head = requestedHead == null ? repo.head : String(requestedHead);
    if (!/^[0-9a-f]{40,64}$/i.test(head)) return { ok: false, error: 'bad_head' };
    if (requestedHead != null) {
      const commit = await runGit(repo.repoRoot, ['cat-file', '-e', head + '^{commit}'], settings);
      if (!commit.ok) return { ok: false, error: 'no_head' };
    }
    try { fs.mkdirSync(configuredRoot, { recursive: true }); } catch { return { ok: false, error: 'storage_failed' }; }
    let storageRoot;
    try { storageRoot = fs.realpathSync(configuredRoot); } catch { return { ok: false, error: 'storage_failed' }; }
    if (overlaps(storageRoot, repo.repoRoot)) return { ok: false, error: 'unsafe_root' };
    const repoKey = crypto.createHash('sha256').update(repo.repoRoot).digest('hex').slice(0, 16);
    const id = 'wt-' + Date.now().toString(36) + '-' + (++sequence).toString(36);
    const repoDir = path.join(storageRoot, repoKey);
    const target = path.join(repoDir, id);
    if (!SAFE_ID.test(id) || !inside(storageRoot, target)) return { ok: false, error: 'unsafe_path' };
    try { fs.mkdirSync(repoDir, { recursive: true }); } catch { return { ok: false, error: 'storage_failed' }; }
    if (fs.existsSync(target)) return { ok: false, error: 'exists' };

    const added = await runGit(repo.repoRoot, ['worktree', 'add', '--detach', target, head], settings);
    if (!added.ok) return { ok: false, error: 'create_failed', message: (added.err || added.out).trim().slice(0, 1000) };
    let realTarget;
    try { realTarget = fs.realpathSync(target); } catch { realTarget = null; }
    if (!realTarget || !inside(storageRoot, realTarget)) {
      await runGit(repo.repoRoot, ['worktree', 'remove', '--force', target], settings);
      await runGit(repo.repoRoot, ['worktree', 'prune'], settings);
      return { ok: false, error: 'unsafe_path' };
    }
    const index = await runGit(realTarget, ['ls-files', '-s', '-z'], settings);
    if (!index.ok || hasUnsafeEntries(index.out)) {
      await runGit(repo.repoRoot, ['worktree', 'remove', '--force', realTarget], settings);
      await runGit(repo.repoRoot, ['worktree', 'prune'], settings);
      return { ok: false, error: index.ok ? 'unsafe_links' : 'inspect_failed' };
    }
    const record = {
      id,
      repoRoot: repo.repoRoot,
      path: realTarget,
      head,
      storageRoot,
      createdAt: Date.now(),
    };
    live.set(id, record);
    return { ok: true, worktree: { ...publicWorktree(record), path: record.path, sourceRoot: record.repoRoot } };
  }

  function recordFor(id) {
    return SAFE_ID.test(id || '') ? live.get(id) || null : null;
  }

  function contains(id, candidate) {
    const record = recordFor(id);
    if (!record || typeof candidate !== 'string' || !candidate) return false;
    return inside(record.path, candidate);
  }

  async function diff(id) {
    const record = recordFor(id);
    if (!record || !inside(record.storageRoot, record.path)) return { ok: false, error: 'not_found' };
    const result = await gitdiff.changes(record.path);
    if (!result || !result.ok || !result.repo) return { ok: false, error: (result && result.error) || 'diff_failed' };
    return { ok: true, files: result.files || [], more: result.more || 0, partial: !!result.partial };
  }

  async function patch(id) {
    const record = recordFor(id);
    if (!record || !inside(record.storageRoot, record.path)) return { ok: false, error: 'not_found' };
    const intent = await runGit(record.path, ['add', '-N', '--', '.'], settings);
    if (!intent.ok) return { ok: false, error: 'patch_failed', message: intent.err.trim().slice(0, 1000) };
    const result = await runGit(record.path, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], settings);
    if (!result.ok) return { ok: false, error: 'patch_failed', message: result.err.trim().slice(0, 1000) };
    const bytes = Buffer.byteLength(result.out, 'utf8');
    if (bytes > MAX_PATCH_BYTES) return { ok: false, error: 'patch_too_large', bytes };
    return { ok: true, patch: result.out, bytes, head: record.head, sourceRoot: record.repoRoot };
  }

  async function readFileAt(cwd, head, relative, maxBytes) {
    if (!/^[0-9a-f]{40,64}$/i.test(head || '') || typeof relative !== 'string'
      || !relative || relative.includes('\\') || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
      return { ok: false, error: 'bad_input' };
    }
    const parts = relative.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      return { ok: false, error: 'bad_input' };
    }
    const repo = await repository(cwd);
    if (!repo.ok) return repo;
    const tree = await runGit(repo.repoRoot, ['ls-tree', '-z', head, '--', relative], settings);
    if (!tree.ok) return { ok: false, error: 'read_failed' };
    const entry = tree.out.split('\0').filter(Boolean);
    if (entry.length !== 1) return { ok: false, error: 'notfound' };
    const match = entry[0].match(/^(\d{6})\s+(\w+)\s+([0-9a-f]{40,64})\t([\s\S]+)$/i);
    if (!match || match[2] !== 'blob' || match[4] !== relative || match[1] === '120000') {
      return { ok: false, error: match && match[1] === '120000' ? 'unsafe_links' : 'bad_file' };
    }
    const limit = Math.max(1, Math.min(MAX_BUFFER - 1, Number(maxBytes) || MAX_BUFFER - 1));
    const size = await runGit(repo.repoRoot, ['cat-file', '-s', match[3]], settings);
    if (!size.ok || !/^\d+$/.test(size.out.trim())) return { ok: false, error: 'read_failed' };
    if (Number(size.out.trim()) > limit) return { ok: false, error: 'too_large' };
    const shown = await runGit(repo.repoRoot, ['show', head + ':' + relative], { ...settings, maxBuffer: limit + 1 });
    if (!shown.ok || Buffer.byteLength(shown.out, 'utf8') > limit) return { ok: false, error: 'read_failed' };
    return { ok: true, content: shown.out, head, mode: match[1], sourceRoot: repo.repoRoot };
  }

  function patchPaths(output) {
    const parts = String(output || '').split('\0').filter((part) => part !== '');
    const paths = [];
    for (const part of parts) {
      const match = part.match(/^(?:-|\d+)\t(?:-|\d+)\t([\s\S]*)$/);
      const value = match ? match[1] : part;
      if (value) paths.push(value.replace(/\\/g, '/'));
    }
    return [...new Set(paths)];
  }

  async function withPatchFile(repoRoot, patchText, callback) {
    if (typeof patchText !== 'string' || !patchText) return { ok: false, error: 'bad_patch' };
    if (Buffer.byteLength(patchText, 'utf8') > MAX_PATCH_BYTES) return { ok: false, error: 'patch_too_large' };
    try { fs.mkdirSync(configuredRoot, { recursive: true }); } catch { return { ok: false, error: 'storage_failed' }; }
    let storageRoot;
    try { storageRoot = fs.realpathSync(configuredRoot); } catch { return { ok: false, error: 'storage_failed' }; }
    const patchFile = path.join(storageRoot, 'patch-' + Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex') + '.diff');
    if (!inside(storageRoot, patchFile)) return { ok: false, error: 'unsafe_path' };
    try {
      fs.writeFileSync(patchFile, patchText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return await callback(patchFile);
    } catch {
      return { ok: false, error: 'storage_failed' };
    } finally {
      try { fs.rmSync(patchFile, { force: true }); } catch { /* أفضل جهد */ }
    }
  }

  async function inspectPatch(cwd, patchText) {
    const repo = await repository(cwd);
    if (!repo.ok) return repo;
    return withPatchFile(repo.repoRoot, patchText, async (patchFile) => {
      const stats = await runGit(repo.repoRoot, ['apply', '--numstat', '-z', '--', patchFile], settings);
      if (!stats.ok) return { ok: false, error: 'bad_patch' };
      return { ok: true, paths: patchPaths(stats.out) };
    });
  }

  async function applyPatch(id, patchText, blockedPaths) {
    const record = recordFor(id);
    if (!record || !inside(record.storageRoot, record.path)) return { ok: false, error: 'not_found' };
    const blocked = new Set((Array.isArray(blockedPaths) ? blockedPaths : []).map((item) => String(item).replace(/\\/g, '/')));
    if ([...blocked].some((item) => patchText.includes(item))) return { ok: false, error: 'blocked_path' };
    return withPatchFile(record.path, patchText, async (patchFile) => {
      const stats = await runGit(record.path, ['apply', '--numstat', '-z', '--', patchFile], settings);
      if (!stats.ok) return { ok: false, error: 'bad_patch' };
      const paths = patchPaths(stats.out);
      if (paths.some((item) => blocked.has(item))) return { ok: false, error: 'blocked_path' };
      const checked = await runGit(record.path, ['apply', '--check', '--whitespace=nowarn', '--', patchFile], settings);
      if (!checked.ok) return { ok: false, error: 'conflict' };
      const applied = await runGit(record.path, ['apply', '--whitespace=nowarn', '--', patchFile], settings);
      if (!applied.ok) return { ok: false, error: 'apply_failed' };
      return { ok: true, paths };
    });
  }

  async function remove(id) {
    const record = recordFor(id);
    if (!record) return { ok: false, error: 'not_found' };
    if (!inside(record.storageRoot, record.path) || overlaps(record.path, record.repoRoot)) {
      return { ok: false, error: 'unsafe_path' };
    }
    const removed = await runGit(record.repoRoot, ['worktree', 'remove', '--force', record.path], settings);
    await runGit(record.repoRoot, ['worktree', 'prune'], settings);
    if (!removed.ok && fs.existsSync(record.path)) {
      return { ok: false, error: 'remove_failed', message: (removed.err || removed.out).trim().slice(0, 1000) };
    }
    live.delete(id);
    return { ok: true };
  }

  function get(id) {
    const record = recordFor(id);
    return record ? { ...publicWorktree(record), path: record.path, sourceRoot: record.repoRoot } : null;
  }

  async function removeAll() {
    const ids = [...live.keys()];
    const results = [];
    for (const id of ids) results.push(await remove(id));
    return results;
  }

  return { create, diff, patch, readFileAt, inspectPatch, applyPatch, remove, removeAll, contains, get, repository };
}

const singleton = createManager();

module.exports = {
  createManager,
  create: singleton.create,
  diff: singleton.diff,
  patch: singleton.patch,
  readFileAt: singleton.readFileAt,
  inspectPatch: singleton.inspectPatch,
  applyPatch: singleton.applyPatch,
  remove: singleton.remove,
  removeAll: singleton.removeAll,
  contains: singleton.contains,
  get: singleton.get,
  repository: singleton.repository,
  SAFE_ID,
  ROOT,
  MAX_PATCH_BYTES,
};
