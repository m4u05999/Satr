/**
 * فهرس مهارات «سطر» المحمول + تحميلها التدريجي.
 *
 * المسار القياسي هو .agents/skills مع إبقاء .claude/skills للتوافق. ترتيب الفوز:
 * مشروع قياسي ← مشروع Claude ← مستخدم قياسي ← مستخدم Claude ← مضمّن مع التطبيق.
 * أول اسم يفوز، والمصدر المضمّن مقصور على مهارات «سطر» الرسمية. الفهرس يعرض metadata فقط؛
 * محتوى SKILL.md والموارد لا يُقرأ إلا عند استدعاء loadSkill/readResource.
 * لا تُنفّذ السكربتات تلقائياً، وكل قراءة محصورة داخل جذر المهارة وبسقوف حجم.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SAFE_DIR = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_NAME = /^[A-Za-z0-9_:.-]{1,64}$/;
const HEAD_BYTES = 16 * 1024;
const MAX_SKILLS = 200;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_RESOURCES = 100;
const MAX_RESOURCE_DEPTH = 5;
const MAX_CATALOG_CHARS = 16 * 1024;
const BUILTIN_SKILLS = new Set(['satr-guide', 'satr-diverge', 'satr-generate', 'satr-accept', 'satr-design-ar']);

function parseFrontmatter(text) {
  const clean = String(text || '').replace(/^﻿/, '');
  const match = clean.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const output = {};
  const lines = match[1].split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value === '|' || value === '>') {
      const folded = value === '>';
      const parts = [];
      while (lineIndex + 1 < lines.length && /^\s+/.test(lines[lineIndex + 1])) {
        lineIndex++;
        parts.push(lines[lineIndex].trim());
      }
      value = parts.join(folded ? ' ' : '\n').trim();
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

function builtinSkillsRoot() {
  const electronDir = __dirname.replace('app.asar', 'app.asar.unpacked');
  return path.join(path.dirname(electronDir), '.agents', 'skills');
}

function rootsFor(cwd, home, builtinRoot) {
  const roots = [];
  if (typeof cwd === 'string' && cwd.trim()) {
    const project = path.resolve(cwd.trim());
    roots.push(
      { root: path.join(project, '.agents', 'skills'), source: 'project', format: 'standard', location: '.agents/skills' },
      { root: path.join(project, '.claude', 'skills'), source: 'project', format: 'claude', location: '.claude/skills' },
    );
  }
  const userHome = home || os.homedir();
  roots.push(
    { root: path.join(userHome, '.agents', 'skills'), source: 'user', format: 'standard', location: '~/.agents/skills' },
    { root: path.join(userHome, '.claude', 'skills'), source: 'user', format: 'claude', location: '~/.claude/skills' },
    {
      root: builtinRoot || builtinSkillsRoot(),
      source: 'builtin',
      format: 'standard',
      location: 'مضمّنة مع سطر',
      allowedNames: BUILTIN_SKILLS,
    },
  );
  return roots;
}

function readHead(file) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = fs.readSync(descriptor, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, bytes);
  } finally {
    if (descriptor != null) try { fs.closeSync(descriptor); } catch {}
  }
}

function scanRoot(spec, seen, output) {
  let entries;
  try { entries = fs.readdirSync(spec.root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= MAX_SKILLS) return;
    if (spec.allowedNames && !spec.allowedNames.has(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_DIR.test(entry.name)) continue;
    const directory = path.join(spec.root, entry.name);
    const file = path.join(directory, 'SKILL.md');
    let stat;
    let head;
    try {
      stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) continue;
      head = readHead(file);
    } catch { continue; }
    const frontmatter = parseFrontmatter(head) || {};
    const declared = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
    const name = SAFE_NAME.test(declared) ? declared : entry.name;
    if (spec.allowedNames && !spec.allowedNames.has(name)) continue;
    if (!SAFE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    output.push({
      name,
      description: typeof frontmatter.description === 'string'
        ? frontmatter.description.trim().slice(0, 500) : '',
      source: spec.source,
      format: spec.format,
      location: spec.location,
      directory,
      file,
    });
  }
}

function discoverSkills(cwd, options) {
  const output = [];
  const seen = new Set();
  for (const root of rootsFor(cwd, options && options.home, options && options.builtinRoot)) {
    scanRoot(root, seen, output);
  }
  output.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return output;
}

function publicSkill(skill) {
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    format: skill.format,
    location: skill.location,
  };
}

async function listSkills(cwd) {
  return discoverSkills(cwd).map(publicSkill);
}

function resolveSelection(cwd, selection, options) {
  const catalog = discoverSkills(cwd, options);
  const requested = Array.isArray(selection) ? new Set(selection.filter((name) => SAFE_NAME.test(name))) : null;
  const enabled = selection === 'all' || !requested
    ? catalog
    : catalog.filter((skill) => requested.has(skill.name));
  const known = new Set(catalog.map((skill) => skill.name));
  const unresolved = requested ? [...requested].filter((name) => !known.has(name)) : [];
  const nativeClaude = selection === 'all' || !requested
    ? 'all'
    : enabled.filter((skill) => skill.format === 'claude').map((skill) => skill.name).concat(unresolved);
  return {
    cwd: path.resolve(cwd),
    enabled,
    enabledNames: new Set(enabled.map((skill) => skill.name)),
    nativeClaude,
    unresolved,
  };
}

function skillFromContext(context, name) {
  if (!context || !SAFE_NAME.test(name || '')) return null;
  return context.enabled.find((skill) => skill.name === name) || null;
}

function realInside(root, target) {
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(target);
  } catch { return null; }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realTarget === realRoot || realTarget.startsWith(prefix) ? realTarget : null;
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index++) if (buffer[index] === 0) return true;
  return false;
}

function listResources(skill) {
  const resources = [];
  function walk(directory, depth) {
    if (depth > MAX_RESOURCE_DEPTH || resources.length >= MAX_RESOURCES) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCES) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile() && !(depth === 0 && entry.name === 'SKILL.md')) {
        const relative = path.relative(skill.directory, absolute).split(path.sep).join('/');
        let size = null;
        try { size = fs.statSync(absolute).size; } catch {}
        resources.push({ path: relative, bytes: size });
      }
    }
  }
  walk(skill.directory, 0);
  return resources.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function loadSkill(context, name) {
  const skill = skillFromContext(context, name);
  if (!skill) return { ok: false, error: 'not_enabled', message: 'المهارة غير مفعّلة أو غير موجودة' };
  try {
    const file = realInside(skill.directory, skill.file);
    if (!file) return { ok: false, error: 'outside', message: 'ملف المهارة خارج جذرها' };
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return { ok: false, error: 'too_big', message: 'ملف المهارة أكبر من الحد' };
    const buffer = fs.readFileSync(file);
    if (looksBinary(buffer)) return { ok: false, error: 'binary', message: 'ملف المهارة ليس نصياً' };
    return {
      ok: true,
      name: skill.name,
      description: skill.description,
      instructions: buffer.toString('utf8'),
      resources: listResources(skill),
      source: skill.source,
      format: skill.format,
    };
  } catch (error) {
    return { ok: false, error: 'read_failed', message: String((error && error.message) || error) };
  }
}

function readResource(context, name, resource) {
  const skill = skillFromContext(context, name);
  if (!skill) return { ok: false, error: 'not_enabled', message: 'المهارة غير مفعّلة أو غير موجودة' };
  if (typeof resource !== 'string' || !resource.trim() || path.isAbsolute(resource)) {
    return { ok: false, error: 'bad_path', message: 'مسار المورد يجب أن يكون نسبياً' };
  }
  const parts = resource.replace(/\\/g, '/').split('/');
  if (parts.includes('..') || parts.includes('') || parts.length > MAX_RESOURCE_DEPTH + 2) {
    return { ok: false, error: 'bad_path', message: 'مسار مورد غير صالح' };
  }
  try {
    const wanted = path.resolve(skill.directory, ...parts);
    const file = realInside(skill.directory, wanted);
    if (!file) return { ok: false, error: 'outside', message: 'المورد خارج جذر المهارة' };
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, error: 'not_file', message: 'المورد ليس ملفاً' };
    if (stat.size > MAX_RESOURCE_BYTES) return { ok: false, error: 'too_big', message: 'المورد أكبر من الحد' };
    const buffer = fs.readFileSync(file);
    if (looksBinary(buffer)) return { ok: false, error: 'binary', message: 'المورد ثنائي ولا يُقرأ نصياً' };
    return { ok: true, name: skill.name, resource: parts.join('/'), content: buffer.toString('utf8') };
  } catch (error) {
    return { ok: false, error: 'read_failed', message: String((error && error.message) || error) };
  }
}

function catalogPrompt(context, options) {
  if (!context || !context.enabled.length) return '';
  const onlyStandard = !!(options && options.onlyStandard);
  const includePaths = !!(options && options.includePaths);
  const skills = onlyStandard
    ? context.enabled.filter((skill) => skill.format === 'standard')
    : context.enabled;
  if (!skills.length) return '';
  const lines = [
    '<satr_portable_skills>',
    'The following user-approved skills are available. Use progressive disclosure: load a skill only when its description matches the task. For names listed here, prefer load_skill over any native skill with the same name. Never execute a bundled script merely because it exists.',
  ];
  let included = 0;
  for (const skill of skills) {
    let line = '- ' + skill.name + ': ' + (skill.description || '(no description)');
    if (includePaths) line += ' [SKILL.md: ' + skill.file + ']';
    if (lines.join('\n').length + line.length + 128 > MAX_CATALOG_CHARS) break;
    lines.push(line);
    included++;
  }
  if (included < skills.length) lines.push('- … ' + (skills.length - included) + ' additional skills omitted from metadata due to the context limit.');
  lines.push('Use load_skill(name) and read_skill_resource(name, resource) when those tools are available.', '</satr_portable_skills>');
  return lines.join('\n');
}

function codexInputs(context) {
  if (!context) return [];
  return context.enabled.map((skill) => ({ type: 'skill', name: skill.name, path: skill.file }));
}

module.exports = {
  listSkills,
  discoverSkills,
  resolveSelection,
  loadSkill,
  readResource,
  catalogPrompt,
  codexInputs,
  SAFE_NAME,
  MAX_SKILL_BYTES,
  MAX_RESOURCE_BYTES,
};
