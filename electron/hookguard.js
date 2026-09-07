/**
 * حارس خفيف لإعدادات Claude التي قد تعمل تلقائياً من مستودع غير موثوق.
 *
 * يفحص مسارات ثابتة فقط تحت .claude/، ولا يمشي الشجرة ولا يشغّل عملية. يحفظ
 * بصمة المحتوى ذي الصلة لكل مشروع بلا مساره أو أوامر الخطّاف، بكتابة ذرية
 * أفضل جهد. أي فشل قراءة/تحليل/كتابة يتدهور إلى الصمت بلا تسجيل (fail-open).
 *
 * OBS-140: ومعه قواعد السماح في `~/.claude/settings.json` للمستخدم. **مقيس بفخّ حيّ**
 * (`npm run probe:obs140-user`، SDK 0.3.261): قاعدة `permissions.allow` هناك تجعل
 * SDK **لا يستدعي `canUseTool` إطلاقاً** فتُنفَّذ الأداة بلا مربع الإذن العربي — بينما
 * قاعدة المشروع نفسها **تمرّ بالمربع** (`npm run probe:obs140`). فالتنبيه محصور
 * بملف المستخدم وحده لأنه وحده ما ثبت تظليله: تحذيرٌ عن ملفٍ لا يظلّل كذبٌ بالزيادة.
 * وهو **إخبارٌ لا إنفاذ** — الإنفاذ يحتاج `PreToolUse` hook وهو دفعة مستقلة.
 *
 * OBS-087 (ب): ومعه بصمة تكوين كل خادم MCP — من `.mcp.json` في المشروع، ومن
 * `~/.claude.json` لنطاقَي المستخدم والمحلي (وهو هدف اختطاف التوجيه إلى proxy) —
 * وتنبيه عربي غير حاجب عند تغيّرها خارج «سطر». يُخزَّن **النطاق والاسم وبصمة**
 * التكوين فقط: لا رابط ولا رمز ولا أي حقل من التكوين نفسه. وأوّل رصد يُسجَّل
 * صامتاً فلا ينبّه إلا التغيّر. ومسح MCP معزول عن مسح الخطّافات: فشله يعني «غير
 * معروف» فيُبقي الأساس المسجّل كما هو ولا يُسقط تنبيه البند (أ).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scrubSecrets } = require('./secretscrub');

const DEFAULT_FILE = path.join(os.homedir(), '.satr', 'claude-hook-fingerprints.json');
const STORE_VERSION = 1;
const MAX_PROJECTS = 256;
const MAX_STORE_BYTES = 128 * 1024;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_SETUP_BYTES = 512 * 1024;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

// ── OBS-087 (ب): بصمة تكوين خوادم MCP ────────────────────────────────────
const MCP_PROJECT_FILE = '.mcp.json';
const MAX_MCP_FILE_BYTES = 256 * 1024;
// ~/.claude.json ينمو بسجل المشاريع — المقيس على جهاز التطوير 73,915 بايت.
const MAX_CLAUDE_JSON_BYTES = 4 * 1024 * 1024;
// سقف الخوادم المسمّاة في المخزن؛ ما تجاوزه يحرسه مجموع '#' فلا يمرّ بلا رصد.
const MAX_MCP_SERVERS = 16;
const MAX_MCP_NAME = 48;
const MAX_NAMED_IN_NOTICE = 6;
const MCP_AGGREGATE_KEY = '#';
const SAFE_MCP_DIGEST = /^[a-f0-9]{16}$/;
const SAFE_MCP_KEY = /^(?:#|[pul]:[^\x00-\x1F\x7F-\x9F]{1,96})$/;
// محارف التحكم وBidi بالهروب لا حرفيّةً — الحرفية تُتلف الملف عند تحريره.
const MCP_UNSAFE_NAME = /[\x00-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const MCP_SCOPE_LABELS = Object.freeze({ p: 'مشروع', u: 'مستخدم', l: 'محلي' });

// ── OBS-140: قواعد السماح في إعدادات المستخدم ─────────────────────────────
// السقوف مقصودة: القائمة تُختصر إلى **أسماء الأدوات** بلا وسائطها (الوسيطة قد تحمل
// مساراً أو أمراً)، وتُخزَّن بصمةٌ قصيرة لا القائمة — فلا يعبر المخزنَ محتوى إعداد.
const MAX_ALLOW_RULES = 64;
const MAX_ALLOW_TOOL_NAME = 48;
const MAX_ALLOW_NAMED_IN_NOTICE = 6;
const SAFE_ALLOW_DIGEST = /^[a-f0-9]{16}$/;
const USER_SETTINGS_NAME = 'settings.json';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePath(value) {
  let normalized = path.resolve(String(value || '')).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function projectKey(cwd) {
  return digest(Buffer.from(normalizePath(cwd), 'utf8'));
}

// مقارنة مسار مسجَّل في ~/.claude.json بمسار المشروع: المفاتيح هناك مكتوبة بفواصل
// مختلطة (رُصد حيّاً "D:\\spsa101" و"D:/sater/satr-2" معاً)، ومسار مشوّه قد يُسقط
// path.resolve فيُتخطّى المدخل بدل إسقاط المسح كله.
function samePath(candidate, target) {
  try {
    return normalizePath(candidate) === target;
  } catch {
    return false;
  }
}

async function readLimited(io, file, maxBytes, missingOk) {
  let stat;
  try {
    stat = await io.promises.lstat(file);
  } catch (error) {
    if (missingOk && error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error('unsafe_file');
  const bytes = await io.promises.readFile(file);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > maxBytes) throw new Error('oversize_file');
  return buffer.toString('utf8');
}

function hasSessionStartHook(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || !Object.prototype.hasOwnProperty.call(hooks, 'SessionStart')) return false;
  const value = hooks.SessionStart;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

async function scanProject(io, cwd) {
  const claudeDir = path.join(path.resolve(cwd), '.claude');
  let dirStat;
  try {
    dirStat = await io.promises.lstat(claudeDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe_directory');

  const findings = [];
  for (const name of SETTINGS_FILES) {
    const relativePath = '.claude/' + name;
    const raw = await readLimited(io, path.join(claudeDir, name), MAX_SETTINGS_BYTES, true);
    if (raw == null) continue;
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!hasSessionStartHook(parsed)) continue;
    findings.push({
      kind: 'session_start',
      path: relativePath,
      contentDigest: digest(Buffer.from(JSON.stringify(parsed.hooks.SessionStart), 'utf8')),
    });
  }

  const setupPath = path.join(claudeDir, 'setup.mjs');
  const setup = await readLimited(io, setupPath, MAX_SETUP_BYTES, true);
  if (setup != null) {
    findings.push({
      kind: 'setup',
      path: '.claude/setup.mjs',
      contentDigest: digest(Buffer.from(setup, 'utf8')),
    });
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

// ── OBS-087 (ب): جمع بصمات خوادم MCP ──────────────────────────────────────

// ترتيب المفاتيح ثابت كي لا تُقرأ إعادة ترتيب حقول التكوين تغييراً.
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

// الاسم يأتي من ملف قد يكون في مستودع غير موثوق: تُزال محارف التحكم وBidi، وتُطوى
// الفراغات، ويُقصّ بنقاط Unicode. الاسم الفارغ بعد التنقية يُستبدل ببصمة قصيرة كي
// يبقى مفتاح المخزن ثابتاً ومميّزاً بدل أن يبتلع خادماً آخر.
function sanitizeMcpName(raw) {
  const source = raw == null ? '' : String(raw);
  const text = source.replace(MCP_UNSAFE_NAME, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  if (!points.length) return '#' + digest(Buffer.from(source, 'utf8')).slice(0, 8);
  return points.slice(0, MAX_MCP_NAME).join('');
}

function serversFrom(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
  return servers;
}

async function readJson(io, file, maxBytes) {
  const raw = await readLimited(io, file, maxBytes, true);
  if (raw == null) return null;
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

// يعيد خريطة { '<نطاق>:<اسم>': '<بصمة 16>' } ومعها مجموع '#' لكل الخوادم قبل القصّ.
// لا يدخلها رابط ولا رمز ولا أي حقل من التكوين — البصمة وحدها.
async function collectMcpServers(io, cwd, claudeJsonFile) {
  const entries = [];
  const push = (prefix, servers) => {
    if (!servers) return;
    for (const [name, config] of Object.entries(servers)) {
      entries.push([
        prefix + ':' + sanitizeMcpName(name),
        digest(Buffer.from(stableStringify(config), 'utf8')).slice(0, 16),
      ]);
    }
  };

  push('p', serversFrom(await readJson(
    io, path.join(path.resolve(cwd), MCP_PROJECT_FILE), MAX_MCP_FILE_BYTES)));

  const home = await readJson(io, claudeJsonFile, MAX_CLAUDE_JSON_BYTES);
  push('u', serversFrom(home));
  if (home && home.projects && typeof home.projects === 'object' && !Array.isArray(home.projects)) {
    const target = normalizePath(cwd);
    for (const [recorded, entry] of Object.entries(home.projects)) {
      if (samePath(recorded, target)) push('l', serversFrom(entry));
    }
  }

  entries.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  const map = {
    [MCP_AGGREGATE_KEY]: digest(Buffer.from(
      entries.map((pair) => pair.join('\u0000')).join('\n'), 'utf8')).slice(0, 16),
  };
  for (const [key, value] of entries.slice(0, MAX_MCP_SERVERS)) map[key] = value;
  return map;
}

function cleanMcpMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const map = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(map).length >= MAX_MCP_SERVERS + 1) break;
    if (!SAFE_MCP_KEY.test(key) || !SAFE_MCP_DIGEST.test(String(entry || ''))) continue;
    map[key] = entry;
  }
  // غياب المجموع يعني خريطة مشوّهة: تُعامَل كـ«لم تُرصد بعد» فيُسجَّل أساس جديد صامتاً.
  return Object.prototype.hasOwnProperty.call(map, MCP_AGGREGATE_KEY) ? map : null;
}

function diffMcp(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of Object.keys(after)) {
    if (key === MCP_AGGREGATE_KEY) continue;
    if (!Object.prototype.hasOwnProperty.call(before, key)) added.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of Object.keys(before)) {
    if (key === MCP_AGGREGATE_KEY) continue;
    if (!Object.prototype.hasOwnProperty.call(after, key)) removed.push(key);
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    // المجموع يغطي ما تجاوز سقف الأسماء فلا يمرّ خادم زائد بلا رصد.
    aggregate: before[MCP_AGGREGATE_KEY] !== after[MCP_AGGREGATE_KEY],
  };
}

function mcpChangedIn(diff) {
  return !!diff && (diff.aggregate || diff.added.length > 0
    || diff.changed.length > 0 || diff.removed.length > 0);
}

function describeMcpKey(verb, key) {
  return verb + ' «' + key.slice(2) + '» ('
    + (MCP_SCOPE_LABELS[key.slice(0, 1)] || 'نطاق غير معروف') + ')';
}

function mcpNoticeText(diff) {
  const segments = [
    ...diff.added.map((key) => describeMcpKey('أُضيف', key)),
    ...diff.changed.map((key) => describeMcpKey('تغيّر تكوين', key)),
    ...diff.removed.map((key) => describeMcpKey('أُزيل', key)),
  ];
  const shown = segments.slice(0, MAX_NAMED_IN_NOTICE);
  const hidden = segments.length - shown.length;
  if (hidden > 0) shown.push('و' + hidden + ' تغييراً آخر');
  if (!shown.length) shown.push('تغيّر خادم غير مسمّى (تجاوز سقف الأسماء المسجّلة)');
  return scrubSecrets('⚠️ تنبيه أمني: تغيّر تكوين خوادم MCP لهذا المشروع خارج «سطر»: '
    + shown.join('، ') + '. راجع الخوادم قبل متابعة العمل؛ لن يوقف «سطر» هذا الدور.');
}

// ── OBS-140: جمع أسماء الأدوات المسموح بها في إعداد المستخدم ───────────────

// القاعدة تأتي بصيغتين: اسم مجرّد (`Write`) أو مقيَّدة (`Bash(npm run test:*)`).
// يُؤخذ **الاسم وحده** — الوسيطة قد تحمل مساراً أو أمراً، ولا حاجة إليها للتنبيه.
function allowRuleToolName(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(MCP_UNSAFE_NAME, '').replace(/\s+/g, ' ').trim();
  const head = text.split('(')[0].trim();
  if (!head) return null;
  return Array.from(head).slice(0, MAX_ALLOW_TOOL_NAME).join('');
}

/**
 * يعيد أسماء الأدوات المسموح بها في `~/.claude/settings.json` — مرتّبة بلا تكرار —
 * أو `null` إن تعذّر المسح. **و`null` ليست «لا قواعد»**: هي «غير معروف»، فتُبقي
 * الأساس المسجّل كما هو بدل أن يمحو عطبٌ عابر خطَّ الأساس فيُسكِت تنبيهاً لاحقاً
 * (الدرس نفسه المطبَّق على مسح MCP).
 */
async function collectUserAllowRules(io, userSettingsFile) {
  const parsed = await readJson(io, userSettingsFile, MAX_SETTINGS_BYTES);
  if (parsed == null) return [];
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const permissions = parsed.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return [];
  const allow = permissions.allow;
  if (!Array.isArray(allow)) return [];
  const names = [];
  for (const rule of allow.slice(0, MAX_ALLOW_RULES)) {
    const name = allowRuleToolName(rule);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.sort();
}

/**
 * قراءة **متزامنة** لأسماء الأدوات المسموح بها في إعداد المستخدم — للإنفاذ لا للإخبار.
 *
 * لماذا متزامنة: خطّاف `PreToolUse` قد يقع قبل أن تُحسم أي قراءة غير متزامنة، ومجموعةٌ
 * تصل متأخرةً تعني نافذة لا يحرسها شيء. والملف واحد صغير بسقفه المعلن، فالكلفة مهملة
 * مقابل ضمان أن المجموعة جاهزة قبل أول أداة.
 *
 * fail-open: أي فشل يعيد مجموعة فارغة — فلا يُعطَّل الدور بسبب إعداد لا يُقرأ.
 */
function userAllowToolNamesSync(file) {
  const target = file || path.join(os.homedir(), '.claude', USER_SETTINGS_NAME);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return new Set();
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    const permissions = parsed.permissions;
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return new Set();
    const allow = permissions.allow;
    if (!Array.isArray(allow)) return new Set();
    const names = new Set();
    for (const rule of allow.slice(0, MAX_ALLOW_RULES)) {
      const name = allowRuleToolName(rule);
      if (name) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

function allowDigest(names) {
  return digest(Buffer.from(names.join('\u0000'), 'utf8')).slice(0, 16);
}

function allowNoticeText(names) {
  const shown = names.slice(0, MAX_ALLOW_NAMED_IN_NOTICE);
  const hidden = names.length - shown.length;
  const list = shown.map((name) => '«' + name + '»').join('، ')
    + (hidden > 0 ? '، و' + hidden + ' غيرها' : '');
  return scrubSecrets('⚠️ تنبيه أمني: إعدادات Claude لديك (~/.claude/settings.json) '
    + 'تسمح تلقائياً بهذه الأدوات: ' + list + ' — فلن يعرض «سطر» مربع الإذن قبل تنفيذها '
    + '(مقيس: قاعدة السماح تتخطّى المربع). احذفها من permissions.allow إن أردت استعادة السؤال؛ '
    + 'لن يوقف «سطر» هذا الدور.');
}

function cleanProjects(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== STORE_VERSION || !value.projects
      || typeof value.projects !== 'object' || Array.isArray(value.projects)) {
    throw new Error('invalid_store');
  }
  const source = value.projects;
  const projects = {};
  for (const [key, entry] of Object.entries(source)) {
    if (Object.keys(projects).length >= MAX_PROJECTS) break;
    if (!SAFE_DIGEST.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!SAFE_DIGEST.test(String(entry.fingerprint || ''))) continue;
    const cleaned = {
      fingerprint: entry.fingerprint,
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at.slice(0, 40) : '',
    };
    // OBS-087 (ب): الحقل اختياري — مخزن سابق للبند (أ) بلا `mcp` يبقى صالحاً،
    // ويُسجَّل أساس MCP له صامتاً عند أول رصد. لا رفع لـSTORE_VERSION ولا هجرة.
    const mcp = cleanMcpMap(entry.mcp);
    if (mcp) cleaned.mcp = mcp;
    // OBS-140: حقل اختياري آخر — مخزن سابق بلا `allow` يبقى صالحاً بلا هجرة.
    if (SAFE_ALLOW_DIGEST.test(String(entry.allow || ''))) cleaned.allow = entry.allow;
    projects[key] = cleaned;
  }
  return projects;
}

async function loadProjects(io, file) {
  const raw = await readLimited(io, file, MAX_STORE_BYTES, true);
  if (raw == null) return {};
  return cleanProjects(JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw));
}

async function persist(io, file, projects) {
  const temp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  try {
    await io.promises.mkdir(path.dirname(file), { recursive: true });
    // OBS-087 (ب): خرائط MCP تكبّر المدخل، فتجاوز السقف يُعالَج بإخلاء الأقدم (أوّل
    // المفاتيح) بدل الامتناع عن الكتابة — الامتناع كان يُسكِت الحارس بصمت. مشروع
    // الدور الحالي أُعيد إدخاله آخِراً فهو آخر ما يُخلى.
    const kept = { ...projects };
    let body = JSON.stringify({ version: STORE_VERSION, projects: kept }, null, 2);
    while (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES && Object.keys(kept).length > 1) {
      delete kept[Object.keys(kept)[0]];
      body = JSON.stringify({ version: STORE_VERSION, projects: kept }, null, 2);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES) return false;
    await io.promises.writeFile(temp, body, 'utf8');
    await io.promises.rename(temp, file);
    return true;
  } catch {
    try { await io.promises.unlink(temp); } catch {}
    return false;
  }
}

function noticeText(findings) {
  const places = findings.map((finding) => finding.kind === 'session_start'
    ? 'خطّاف SessionStart في ' + finding.path
    : 'ملف الإعداد ' + finding.path);
  return scrubSecrets('⚠️ تنبيه أمني: عُثر داخل هذا المشروع على إعدادات قد تعمل تلقائياً مع Claude: '
    + places.join('، ') + '. راجع هذه الملفات قبل متابعة العمل؛ لن يوقف «سطر» هذا الدور.');
}

function noticeEvent(notice) {
  const normalized = String(notice || '')
    .replace(/[\x00-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g, '');
  const text = scrubSecrets(normalized).trim().slice(0, 1200);
  if (!text) return null;
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function createGuard(options = {}) {
  const io = options.fs || fs;
  const file = options.file || process.env.SATR_HOOK_GUARD_FILE || DEFAULT_FILE;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const claudeJson = options.claudeJson || path.join(os.homedir(), '.claude.json');
  // OBS-140: مسار قابل للحقن كي يُختبَر الحارس بلا لمس بيت المالك الحقيقي.
  const userSettings = options.userSettings
    || path.join(os.homedir(), '.claude', USER_SETTINGS_NAME);
  let queue = Promise.resolve();

  async function inspect(cwd) {
    try {
      if (typeof cwd !== 'string' || !cwd.trim()) return null;
      const findings = await scanProject(io, cwd);
      const fingerprint = digest(Buffer.from(JSON.stringify(findings.map((finding) => ({
        kind: finding.kind, path: finding.path, contentDigest: finding.contentDigest,
      }))), 'utf8'));
      const key = projectKey(cwd);
      const projects = await loadProjects(io, file);
      const previous = projects[key] || null;

      // OBS-087 (ب): مسح MCP معزول — فشله «غير معروف» لا «لا خوادم»، فيُبقي الأساس
      // المسجّل كما هو (وإلا محا عطبٌ عابر خطَّ الأساس فأسكت تنبيهاً حقيقياً بعده).
      let mcpNow = null;
      try {
        mcpNow = await collectMcpServers(io, cwd, claudeJson);
      } catch {
        mcpNow = null;
      }
      const mcpBefore = previous && previous.mcp && typeof previous.mcp === 'object'
        ? previous.mcp : null;
      const mcpStored = mcpNow || mcpBefore;
      const mcpDiff = mcpNow && mcpBefore ? diffMcp(mcpBefore, mcpNow) : null;

      // OBS-140: معزول مثل مسح MCP — فشله «غير معروف» لا «لا قواعد».
      let allowNames = null;
      try {
        allowNames = await collectUserAllowRules(io, userSettings);
      } catch {
        allowNames = null;
      }
      const allowBefore = previous && SAFE_ALLOW_DIGEST.test(String(previous.allow || ''))
        ? previous.allow : null;
      const allowNow = allowNames ? allowDigest(allowNames) : null;
      const allowStored = allowNow || allowBefore;
      // التنبيه عند **وجود** قواعد وتغيّر بصمتها (وأوّل رصد تغيّرٌ) — بخلاف MCP الذي
      // يصمت أوّل مرة: هناك الخطر حدثٌ (تغيّر تكوين)، وهنا الخطر **حالةٌ قائمة**.
      const allowChanged = !!allowNames && allowNames.length > 0 && allowNow !== allowBefore;

      // لا كتابة ولا تنبيه ما لم يتغيّر شيء فعلاً — وأوّل رصد لـMCP تغيّرٌ في المخزن
      // بلا تنبيه (لا يوجد أساس يُقارَن به).
      const previousSignature = previous
        ? JSON.stringify([previous.fingerprint, previous.mcp || null, previous.allow || null]) : null;
      const nextSignature = JSON.stringify([fingerprint, mcpStored || null, allowStored || null]);
      if (previousSignature === nextSignature) return null;

      const next = { ...projects };
      delete next[key];
      const entry = { fingerprint, updated_at: now().toISOString() };
      if (mcpStored) entry.mcp = mcpStored;
      if (allowStored) entry.allow = allowStored;
      next[key] = entry;
      while (Object.keys(next).length > MAX_PROJECTS) delete next[Object.keys(next)[0]];
      if (!await persist(io, file, next)) return null;

      const notices = [];
      const hooksChanged = !previous || previous.fingerprint !== fingerprint;
      if (hooksChanged && findings.length) notices.push(noticeText(findings));
      if (mcpChangedIn(mcpDiff)) notices.push(mcpNoticeText(mcpDiff));
      if (allowChanged) notices.push(allowNoticeText(allowNames));
      return notices.length ? notices.join(' ') : null;
    } catch {
      return null;
    }
  }

  function inspectProject(cwd) {
    const run = queue.then(() => inspect(cwd), () => inspect(cwd));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { inspectProject };
}

const guard = createGuard();

module.exports = {
  inspectProject: guard.inspectProject,
  createGuard,
  noticeEvent,
  projectKey,
  DEFAULT_FILE,
  STORE_VERSION,
  MAX_PROJECTS,
  MAX_STORE_BYTES,
  MAX_SETTINGS_BYTES,
  MAX_SETUP_BYTES,
  MAX_MCP_SERVERS,
  MAX_MCP_NAME,
  MAX_MCP_FILE_BYTES,
  MAX_CLAUDE_JSON_BYTES,
  MCP_AGGREGATE_KEY,
  // OBS-140
  allowRuleToolName,
  userAllowToolNamesSync,
  MAX_ALLOW_RULES,
  MAX_ALLOW_TOOL_NAME,
  MAX_ALLOW_NAMED_IN_NOTICE,
};
