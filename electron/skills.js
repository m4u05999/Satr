/**
 * فهرس مهارات «سطر» المحمول + تحميلها التدريجي.
 *
 * المسار القياسي هو .agents/skills مع إبقاء .claude/skills للتوافق. ترتيب الفوز:
 * مشروع قياسي ← مشروع Claude ← مستخدم قياسي ← مستخدم Claude ← مضمّن مع التطبيق.
 * أول اسم يفوز، والمصدر المضمّن مقصور على مهارات «سطر» الرسمية. الفهرس يعرض metadata فقط؛
 * محتوى SKILL.md والموارد لا يُقرأ إلا عند استدعاء loadSkill/readResource.
 * لا تُنفّذ السكربتات تلقائياً، وكل قراءة محصورة داخل جذر المهارة وبسقوف حجم.
 * ومنذ مدقّق المواصفة: كل مهارة تُدقَّق عند الفهرسة قبل أن يصل اسمها أو وصفها إلى نموذج.
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
// ── مواصفة Agent Skills (agentskills.io/specification، محدَّثة 2026-08-09) ─────
// صارت المواصفة معياراً تقرؤه عشرات العملاء، ومهارات هذا المشروع قابلة للنقل إليها.
// لذلك تُدقَّق كل مهارة **عند الفهرسة**، قبل أن يصل اسمها أو وصفها إلى أي نموذج:
//   name        إلزامي · [a-z0-9-] · ≤64 محرفاً · **يطابق اسم المجلد**
//   description إلزامي · ≤1024 محرفاً · سطر واحد
//   license / metadata اختياريان
// والتدرّج مقصود لا تهاوناً: ما يكسر **الحلّ أو القرار** يرفض المهارة كلها — اسم لا
// يطابق مجلده يجعل load_skill(x) يسلّم محتوى مجلد آخر، ووصفٌ غائب يجعل التحميل
// التدريجي عشوائياً — أما الحقل الاختياري المشوّه فيُهمَل وحده لأنه زينة لا يُبنى عليها
// قرار، وإسقاط المهارة لأجله عقوبة بلا خطر. وحرف الاسم يُفرض ولو طابق مجلده، لأن
// ويندوز (منصّتنا الأولى) نظام ملفات غير حسّاس للحالة: myskill وMySkill يحلّان إلى
// المجلد نفسه، فتصير مطابقة الاسم للمجلد وحدها حارساً لا يُعتمد عليه.
const SPEC_NAME = /^[a-z0-9-]{1,64}$/;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_LICENSE_CHARS = 64;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_VALUE_CHARS = 200;
const SPEC_METADATA_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

const BUILTIN_SKILLS = new Set(['satr-guide', 'satr-diverge', 'satr-generate', 'satr-accept',
  'satr-design-ar', 'satr-youtube']);

function unquoteScalar(value) {
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

// بداية خريطة متداخلة: سطر تالٍ مُزاح يحمل «مفتاح: قيمة» ولا يبدأ بشرطة قائمة.
function isNestedMapStart(lines, index) {
  const next = lines[index + 1];
  if (typeof next !== 'string' || !/^[ \t]+\S/.test(next)) return false;
  const trimmed = next.trim();
  return !trimmed.startsWith('-') && trimmed.indexOf(':') > 0;
}

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
    } else if (value === '' && isNestedMapStart(lines, lineIndex)) {
      // خريطة متداخلة بمستوى واحد — يلزمها metadata في المواصفة. وقبلها كانت الأسطر
      // المُزاحة تُقرأ **مفاتيح عليا**، فيتسرّب version إلى جذر الترويسة ويزاحم حقلاً
      // قياسياً باسمه؛ خطأُ تحليلٍ لا تجميل.
      const map = {};
      while (lineIndex + 1 < lines.length && /^[ \t]+\S/.test(lines[lineIndex + 1])) {
        lineIndex++;
        const nested = lines[lineIndex].trim();
        const at = nested.indexOf(':');
        if (at <= 0) continue;
        map[nested.slice(0, at).trim()] = unquoteScalar(nested.slice(at + 1).trim());
      }
      output[key] = map;
      continue;
    }
    output[key] = unquoteScalar(value);
  }
  return output;
}

// الوصف حقل سطر واحد في المواصفة، ويُطبع في كتالوج البرومبت سطراً لكل مهارة
// («- name: description»)؛ فسطرٌ جديد بداخله يكسر بنية القائمة التي يقرؤها النموذج،
// ومحارف التحكم تعبر إلى البرومبت كما هي. لذلك يُطوى الفراغ وتُزال المحارف هنا لا هناك.
function normalizeSpecText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function specLicense(value) {
  const clean = normalizeSpecText(value);
  return clean && clean.length <= MAX_LICENSE_CHARS ? clean : '';
}

function specMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    if (count >= MAX_METADATA_KEYS) break;
    if (!SPEC_METADATA_KEY.test(key)) continue;
    const text = normalizeSpecText(value[key]);
    if (!text) continue;
    output[key] = text.slice(0, MAX_METADATA_VALUE_CHARS);
    count++;
  }
  return count ? output : null;
}

/**
 * مدقّق المواصفة — دالة نقية فوق ترويسة مُحلَّلة، بلا قرص ولا حالة.
 * تعيد {ok:true, name, description, license, metadata} أو {ok:false, error, message}.
 * الرسالة عربية وتسمّي المجلد كي لا يكون الاستبعاد صامتاً.
 */
function validateSkillMeta(directoryName, frontmatter) {
  const at = ' في «' + directoryName + '»';
  if (!frontmatter || typeof frontmatter !== 'object') {
    return { ok: false, error: 'no_frontmatter', message: 'لا ترويسة YAML صالحة' + at };
  }
  const declared = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!declared) return { ok: false, error: 'missing_name', message: 'حقل name إلزامي وغائب' + at };
  if (!SPEC_NAME.test(declared)) {
    return { ok: false, error: 'bad_name', message: 'الاسم «' + declared.slice(0, 64) + '»' + at
      + ' يخالف المواصفة (أحرف لاتينية صغيرة وأرقام وشرطة، ≤64)' };
  }
  if (declared !== directoryName) {
    return { ok: false, error: 'name_mismatch', message: 'الاسم «' + declared + '» لا يطابق مجلده «'
      + directoryName + '» — التحميل بالاسم كان سيسلّم محتوى مجلد آخر' };
  }
  const description = normalizeSpecText(frontmatter.description);
  if (!description) return { ok: false, error: 'missing_description', message: 'حقل description إلزامي وغائب' + at };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: 'description_too_long', message: 'الوصف' + at + ' بلغ '
      + description.length + ' محرفاً والسقف ' + MAX_DESCRIPTION_CHARS };
  }
  return {
    ok: true,
    name: declared,
    description,
    license: specLicense(frontmatter.license),
    metadata: specMetadata(frontmatter.metadata),
  };
}

// سلوك ما قبل التدقيق — يُستعمل حصراً حين يرمي المدقّق نفسه (انظر scanRoot).
function legacyMeta(directoryName, frontmatter) {
  const fields = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const declared = typeof fields.name === 'string' ? fields.name.trim() : '';
  return {
    ok: true,
    name: SAFE_NAME.test(declared) ? declared : directoryName,
    description: typeof fields.description === 'string' ? fields.description.trim().slice(0, 500) : '',
    license: '',
    metadata: null,
  };
}

// الاستبعاد لا يكون صامتاً: يُجمَع في options.invalid إن طلبه المتصل، ويُطبع مرة واحدة
// لكل (ملف، سبب) في عمر العملية — الفهرسة تجري كل دور، والتكرار ضجيج لا إفادة.
const warnedInvalid = new Set();
function noteInvalid(collector, entry) {
  if (Array.isArray(collector)) collector.push(entry);
  const key = entry.file + '\u0000' + entry.error;
  if (warnedInvalid.has(key)) return;
  if (warnedInvalid.size >= 500) warnedInvalid.clear();
  warnedInvalid.add(key);
  try { console.warn('[satr:skills] تجاهلت مهارة — ' + entry.message + ' (' + entry.file + ')'); } catch {}
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

function scanRoot(spec, seen, output, invalid) {
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
    let frontmatter = null;
    try { frontmatter = parseFrontmatter(head); } catch { frontmatter = null; }
    let meta;
    try {
      meta = validateSkillMeta(entry.name, frontmatter);
    } catch (error) {
      // خلل في المدقّق نفسه لا يجوز أن يُخلي فهرس المستخدم من مهاراته السليمة. نتراجع
      // لهذه المهارة وحدها إلى سلوك ما قبل التدقيق — وهو السلوك المشحون حتى اليوم فلا
      // خطر جديد — ونُبلّغ السبب كي لا يقع الصمت.
      meta = legacyMeta(entry.name, frontmatter);
      noteInvalid(invalid, {
        name: entry.name,
        file,
        error: 'validator_error',
        message: 'تعذّر تدقيق «' + entry.name + '» فعُوملت بسلوك ما قبل التدقيق: '
          + String((error && error.message) || error).slice(0, 200),
      });
    }
    if (!meta.ok) {
      noteInvalid(invalid, { name: entry.name, file, error: meta.error, message: meta.message });
      continue;
    }
    const name = meta.name;
    if (spec.allowedNames && !spec.allowedNames.has(name)) continue;
    if (!SAFE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    output.push({
      name,
      description: meta.description,
      license: meta.license,
      metadata: meta.metadata,
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
  const invalid = options && Array.isArray(options.invalid) ? options.invalid : null;
  for (const root of rootsFor(cwd, options && options.home, options && options.builtinRoot)) {
    scanRoot(root, seen, output, invalid);
  }
  output.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return output;
}

function publicSkill(skill) {
  const view = {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    format: skill.format,
    location: skill.location,
  };
  // اختياريان في المواصفة: يُعرضان حين أعلنتهما المهارة فقط، ولا يدخلان كتالوج
  // البرومبت — بيانات ترخيص/نسخة لا تُغيّر قرار التحميل وتستهلك رموزاً كل دور.
  if (skill.license) view.license = skill.license;
  if (skill.metadata) view.metadata = skill.metadata;
  return view;
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
  // مدقّق المواصفة مُصدَّر ليقرأه الحارس من المصدر الواحد بدل نسخة ثانية تتباعد بصمت.
  validateSkillMeta,
  SPEC_NAME,
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_BYTES,
  MAX_RESOURCE_BYTES,
  // مُصدَّرة ليقرأها حارس `satr-guide` من المصدر الواحد بدل نسخة ثانية تتباعد بصمت.
  BUILTIN_SKILLS,
};
