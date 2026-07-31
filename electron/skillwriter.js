/**
 * كاتب مهارة مراجعة محلية للمشروع تحت .agents/skills حصراً.
 *
 * لا يتبع روابط رمزية أو junctions، ولا يستبدل ملفاً قائماً دون تأكيد صريح.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const memory = require('./memory');

const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_DESCRIPTION_POINTS = 500;
const MAX_CRITERIA_BYTES = 16 * 1024;
const CONTROL_AND_BIDI = /[\u0000-\u0009\u000B-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function insideOrSame(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function inspectDirectory(root, target, errorCode) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { ok: false, error: 'symlink' };
    if (!stat.isDirectory()) return { ok: false, error: errorCode };
    const realTarget = fs.realpathSync(target);
    if (!insideOrSame(root, realTarget)) return { ok: false, error: 'outside' };
    return { ok: true, path: realTarget };
  } catch {
    return { ok: false, error: errorCode };
  }
}

function ensureDirectory(root, parent, name) {
  const target = path.join(parent, name);
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return { ok: false, error: 'write_failed' };
  }
  return inspectDirectory(root, target, 'unsafe_target');
}

function inspectTarget(root, target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { ok: false, error: 'symlink' };
    if (!stat.isFile()) return { ok: false, error: 'unsafe_target' };
    const realTarget = fs.realpathSync(target);
    if (!insideOrSame(root, realTarget)) return { ok: false, error: 'outside' };
    return { ok: true, exists: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, exists: false };
    return { ok: false, error: 'write_failed' };
  }
}

function cleanDescription(value) {
  return Array.from(String(value || '').replace(CONTROL_AND_BIDI, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_DESCRIPTION_POINTS).join('');
}

function cleanCriteria(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(CONTROL_AND_BIDI, '').trim();
}

function buildSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return { ok: false, error: 'bad_skill' };
  const name = typeof skill.name === 'string' ? skill.name.trim() : '';
  if (!SAFE_SKILL_NAME.test(name) || name === '.' || name === '..') return { ok: false, error: 'bad_name' };
  if (typeof skill.description !== 'string' || Array.from(skill.description).length > MAX_DESCRIPTION_POINTS) {
    return { ok: false, error: 'bad_description' };
  }
  const description = cleanDescription(skill.description);
  if (!description) return { ok: false, error: 'bad_description' };
  if (typeof skill.criteria !== 'string' || Buffer.byteLength(skill.criteria, 'utf8') > MAX_CRITERIA_BYTES) {
    return { ok: false, error: 'bad_criteria' };
  }
  if (memory.hasSecret(skill.criteria)) return { ok: false, error: 'secret' };
  const criteria = cleanCriteria(skill.criteria);
  if (!criteria) return { ok: false, error: 'bad_criteria' };
  const source = [
    '---',
    'name: ' + name,
    'description: >',
    '  ' + description,
    '---',
    '',
    criteria,
    '',
  ].join('\n');
  return { ok: true, name, description, criteria, source };
}

function createSkill(cwd, skill, options) {
  const settings = options || {};
  if (settings.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  const built = buildSkill(skill);
  if (!built.ok) return built;
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) return { ok: false, error: 'bad_cwd' };
  const rootPath = path.resolve(cwd.trim());
  let root;
  try {
    const rootStat = fs.lstatSync(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, error: 'bad_cwd' };
    root = fs.realpathSync(rootPath);
  } catch {
    return { ok: false, error: 'bad_cwd' };
  }

  const agents = ensureDirectory(root, root, '.agents');
  if (!agents.ok) return agents;
  const skills = ensureDirectory(root, agents.path, 'skills');
  if (!skills.ok) return skills;
  const directory = ensureDirectory(root, skills.path, built.name);
  if (!directory.ok) return directory;
  if (path.basename(directory.path) !== built.name) return { ok: false, error: 'unsafe_target' };

  const target = path.join(directory.path, 'SKILL.md');
  const before = inspectTarget(root, target);
  if (!before.ok) return before;
  if (before.exists && settings.overwrite !== true) return { ok: false, error: 'exists' };

  const nonce = process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const temporary = path.join(directory.path, '.SKILL-' + nonce + '.tmp');
  const backup = path.join(directory.path, '.SKILL-' + nonce + '.bak');
  let movedExisting = false;
  try {
    const checkedDirectory = inspectDirectory(root, directory.path, 'unsafe_target');
    if (!checkedDirectory.ok) throw Object.assign(new Error(checkedDirectory.error), { satrCode: checkedDirectory.error });
    fs.writeFileSync(temporary, built.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const current = inspectTarget(root, target);
    if (!current.ok) throw Object.assign(new Error(current.error), { satrCode: current.error });
    if (current.exists && settings.overwrite !== true) {
      throw Object.assign(new Error('exists'), { satrCode: 'exists' });
    }
    if (current.exists) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, target);
    if (movedExisting) try { fs.rmSync(backup, { force: true }); } catch {}
    return {
      ok: true,
      path: path.join('.agents', 'skills', built.name, 'SKILL.md').replace(/\\/g, '/'),
      name: built.name,
      created: !current.exists,
      overwritten: current.exists,
    };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (movedExisting) {
      try {
        if (!fs.existsSync(target)) fs.renameSync(backup, target);
      } catch {}
    }
    return { ok: false, error: error && error.satrCode || 'write_failed' };
  }
}

module.exports = {
  SAFE_SKILL_NAME,
  MAX_DESCRIPTION_POINTS,
  MAX_CRITERIA_BYTES,
  buildSkill,
  createSkill,
};
