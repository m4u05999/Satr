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

const ROOT = path.join(os.homedir(), '.satr', 'worktrees');
const GIT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 16 * 1024 * 1024;
const SAFE_ID = /^wt-[a-z0-9-]{6,80}$/;
const MAX_LIVE = 8;

let sequence = 0;

function runGit(cwd, args, options) {
  const settings = options || {};
  const execute = typeof settings.execFile === 'function' ? settings.execFile : execFile;
  return new Promise((resolve) => {
    execute('git', args, {
      cwd,
      timeout: Math.min(Number(settings.gitTimeoutMs) || GIT_TIMEOUT_MS, GIT_TIMEOUT_MS),
      maxBuffer: MAX_BUFFER,
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

  async function create(cwd) {
    if (live.size >= MAX_LIVE) return { ok: false, error: 'too_many' };
    const repo = await repository(cwd);
    if (!repo.ok) return repo;
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

    const added = await runGit(repo.repoRoot, ['worktree', 'add', '--detach', target, repo.head], settings);
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
      head: repo.head,
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

  return { create, diff, remove, removeAll, contains, get, repository };
}

const singleton = createManager();

module.exports = {
  createManager,
  create: singleton.create,
  diff: singleton.diff,
  remove: singleton.remove,
  removeAll: singleton.removeAll,
  contains: singleton.contains,
  get: singleton.get,
  repository: singleton.repository,
  SAFE_ID,
  ROOT,
};
