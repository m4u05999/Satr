/**
 * أدوات الوكيل للمحوّلات «العمياء» (الدفعة 2.1 من ROADMAP.md).
 *
 * هذه بذرة «حلقة الوكيل الخاصة»: النموذج (DeepSeek/Qwen/… عبر tool-calling) يطلب
 * أداة، «سطر» ينفّذها محلياً ويعيد النتيجة، فيرث كل مزوّد الوكيل كاملاً دون أن
 * يملك أدوات بنفسه. 2.1 = قراءة فقط (read_file / list_files)؛ أدوات الكتابة
 * والتنفيذ تأتي في 2.2/2.3 مع مربع الإذن العربي.
 *
 * 🔒 أمان: التنفيذ يعيد استخدام مسارات مؤمَّنة قائمة — files.readText (داخل cwd
 * حصراً، رفض الثنائي، سقف حجم) و files.listFiles (مشي محدود). لا صدفة ولا spawn.
 * النتائج نصوص مقصوصة بسقف يحمي نافذة سياق النموذج.
 *
 * التعريفات بصيغة OpenAI tools (type:function + JSON Schema) — وهي لغة النموذج
 * (بالإنجليزية عمداً: أوثق عبر النماذج المتعددة)؛ رسائل الأخطاء بالعربية تصل
 * النموذج فيشرحها للمستخدم بلغته.
 */

const fs = require('fs');
const path = require('path');
const files = require('./files');
const search = require('./search'); // بحث «دلالي خفيف» (4.6) — أداة search_code
const inject = require('./inject'); // resolveInside — تحقق مسار موحّد
const skills = require('./skills'); // مهارات محمولة: تحميل تدريجي لـ SKILL.md وموارده
const verify = require('./verify'); // تحقق صريح من .satr/verify.json — لا تشغيل تلقائي
const { computeDiff } = require('./diff');
const term = require('./term'); // طرفية النموذج المرئية (2.3) — نفس مفرد المرحلة 16

const MAX_RESULT = 48 * 1024;  // سقف نتيجة الأداة (محارف) — حماية سياق النموذج
const MAX_LIST = 1500;         // سقف أسطر list_files
const MAX_WRITE = 1024 * 1024; // سقف محتوى كتابة واحد (1م.ب)
const MAX_EDIT_SRC = 2 * 1024 * 1024; // لا تعديل على ملف أكبر (حماية ذاكرة + تراجع مضمون)

// ---------- أدوات الكتابة (الدفعة 2.2): إذن عربي إلزامي + diff + تراجع ----------
// نفس نموذج agent.js: لقطة «قبل» لكل تعديل تعيش بعد الدور ليعمل «تراجع» لاحقاً.
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const editSnapshots = new Map(); // call_id → { file_path, before|null }
const MAX_SNAPSHOTS = 40;

function rememberSnapshot(id, snap) {
  editSnapshots.set(id, snap);
  while (editSnapshots.size > MAX_SNAPSHOTS) {
    editSnapshots.delete(editSnapshots.keys().next().value);
  }
}

// «تراجع» عن تعديل أداة محوّل — نظير agent.undoEdit (main.js يجرّب الاثنين)
function undoEdit(id) {
  const snap = editSnapshots.get(id);
  if (!snap) return { ok: false, error: 'expired' };
  try {
    if (snap.before == null) {
      try { fs.unlinkSync(snap.file_path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else {
      fs.writeFileSync(snap.file_path, snap.before, 'utf8');
    }
    editSnapshots.delete(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// طبقة إذن الأداة (المحوّل يسأل قبل التنفيذ — مربع الإذن العربي):
// 'write' = كتابة ملفات (يعفيها acceptEdits و«موافقة دائمة»)
// 'exec'  = تنفيذ أوامر (2.3 — موافقة إلزامية كل مرة؛ bypassPermissions وحده يعفيها)
// null    = قراءة بلا إذن (تطابق Claude Code)
function permissionTier(name) {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'run_command' || name === 'verify_project') return 'exec';
  return null;
}
function needsPermission(name) { return permissionTier(name) !== null; }

// تعريفات الأدوات المعلنة للنموذج (بروتوكول OpenAI Chat Completions)
const DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "Read a text file from the user's project. Use it to inspect code before answering. Path must be relative to the project root (e.g. src/index.html).",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project, forward slashes' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "List the files of the user's project as relative paths, one per line. Use it to discover the project structure before reading files.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: "Search all project files for text (grep-like). Returns matching lines as path:line: excerpt, best-matching files first. Matching is lenient: case-insensitive, Arabic diacritics and letter variants ignored, and substrings match inside identifiers (searching 'save viewer' finds saveFromViewer). Use it to locate where something is defined or handled instead of reading whole files.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Space-separated words to search for (1-8 words, 2+ characters each)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verification_config',
      description: 'Read the explicit .satr/verify.json checks approved for this project. This only reads configuration and never runs commands.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_project',
      description: 'Run configured verification checks from .satr/verify.json in the visible terminal after user permission. Never invent commands. Provide the exact ledger task title so evidence can be linked.',
      parameters: {
        type: 'object',
        properties: {
          checks: { type: 'array', items: { type: 'string' }, description: 'Configured check IDs; omit or empty means all configured checks' },
          task_title: { type: 'string', description: 'Exact visible Task Ledger title to receive verification evidence' },
        },
        required: ['task_title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_ledger',
      description: 'Create or update the visible persistent task plan. Include status, dependencies, owner, and concrete verification evidence when available. Use replace for a complete plan and merge for incremental updates.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['replace', 'merge'] },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
                dependencies: { type: 'array', items: { type: 'string' } },
                owner: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'title', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: "Load the instructions for one enabled Satr Agent Skill when its description matches the current task. Skills use progressive disclosure: call this only when relevant. Bundled scripts are resources to inspect, never automatic commands.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact enabled skill name from the portable skills catalog' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_resource',
      description: "Read one text resource bundled with an enabled Agent Skill after load_skill lists it. The path must be relative to that skill directory. This reads content only and never executes scripts.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact enabled skill name' },
          resource: { type: 'string', description: 'Relative resource path returned by load_skill' },
        },
        required: ['name', 'resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: "Create a new file or completely overwrite an existing file in the user's project. The user is asked for permission first. Prefer edit_file for small changes to existing files.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project' },
          content: { type: 'string', description: 'Full new content of the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: "Delete a file from the user's project. The user is asked for permission first. This is reliable for any filename (including Arabic names) — prefer it over shell commands like del/rm for deleting files.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: "Run a single-line shell command (PowerShell on Windows) in the user's visible terminal and return its output. The user must approve each command. Long-running interactive apps (servers) will be cut by the timeout.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'One-line shell command to run' },
          timeout_seconds: { type: 'number', description: 'Optional timeout in seconds (default 120, max 600)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: "Edit an existing file by exact string replacement. old_string must match the file content exactly (including whitespace) and must be unique unless replace_all is true. The user is asked for permission first.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the project' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
];

function defs() { return DEFS; }

// ترجمة أخطاء readText لنص عربي يفهمه النموذج (ويشرحه للمستخدم عند الحاجة)
const READ_ERRORS = {
  outside: 'المسار خارج مجلد المشروع — مسموح فقط بمسارات نسبية داخله',
  notfound: 'الملف غير موجود — استخدم list_files لمعرفة المسارات الصحيحة',
  binary: 'ملف ثنائي — لا يمكن قراءته نصاً',
  error: 'تعذّرت قراءة الملف',
};

// حلّ مسار داخل cwd مع تسامح تطبيع Unicode (حرج للأسماء العربية): إن لم يوجد المسار
// حرفياً، نطابق أسماء المجلد بعد التطبيع (NFC) — يعالج اختلاف NFC/NFD بين ما يكتبه
// النموذج وما هو مخزَّن فعلاً على القرص. يعيد المسار المطلق الفعلي أو الأصلي.
function resolveExisting(cwd, rel) {
  const abs = inject.resolveInside(cwd, rel);
  if (!abs) return null;
  if (fs.existsSync(abs)) return abs;
  try {
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    const want = base.normalize('NFC');
    for (const name of fs.readdirSync(dir)) {
      if (name.normalize('NFC') === want) return path.join(dir, name);
    }
  } catch { /* المجلد غير موجود — يبقى المسار الأصلي */ }
  return abs;
}

// قراءة «قبل» لملف تعديل: null = ملف جديد؛ يرمي إن كان ثنائياً أو ضخماً
function readBefore(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; } // غير موجود — ملف جديد
  if (!st.isFile()) throw new Error('المسار ليس ملفاً');
  if (st.size > MAX_EDIT_SRC) throw new Error('الملف أكبر من حدّ التعديل (2م.ب)');
  const buf = fs.readFileSync(abs);
  if (inject.looksBinary(buf)) throw new Error('ملف ثنائي — لا يُعدَّل نصاً');
  return buf.toString('utf8');
}

// كتابة + لقطة تراجع + بطاقة diff للواجهة (نفس عقد file_edit في مسار SDK)
function commitWrite(ctx, cwd, toolName, rel, abs, before, after) {
  fs.mkdirSync(path.dirname(abs), { recursive: true }); // مجلدات وسيطة (داخل cwd حتماً)
  fs.writeFileSync(abs, after, 'utf8');
  const id = (ctx && ctx.id) || ('tool_' + Math.random().toString(36).slice(2));
  rememberSnapshot(id, { file_path: abs, before });
  if (ctx && typeof ctx.emit === 'function') {
    const d = computeDiff(before == null ? '' : before, after);
    ctx.emit({
      type: 'file_edit', id, tool: toolName,
      rel, isNew: before == null,
      added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
    });
  }
}

/**
 * حفظ من عارض القراءة (تحرير خفيف — الدفعة 4): كتابة ملف **قائم** فقط بإعادة
 * استخدام المسار المؤمَّن نفسه — resolveExisting (تسامح NFC/NFD للأسماء العربية) +
 * readBefore (يرمي للثنائي/الضخم) + commitWrite (كتابة + لقطة تراجع) — فيأتي
 * «تراجع» (editSnapshots/undoEdit) وبيانات بطاقة diff مجاناً. لا يُنشئ ملفات
 * (العارض يفتح الموجود فقط). بطاقة file_edit تُعاد في الردّ نفسه (card) بدل بثّها
 * حدثاً: حدث خارج دور يسقط على حارس الكتلة في الواجهة — الردّ المتزامن أسلم ترتيباً.
 */
function saveFromViewer(cwd, rel, content) {
  try {
    if (typeof content !== 'string' || content.length > MAX_WRITE) return { ok: false, error: 'too_big' };
    const abs = resolveExisting(cwd, rel);
    if (!abs) return { ok: false, error: 'outside' };
    const before = readBefore(abs); // يرمي للثنائي/الضخم — يلتقطه catch أدناه
    if (before == null) return { ok: false, error: 'notfound' }; // العارض لا ينشئ ملفات
    const id = 'view_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    let card = null;
    commitWrite({ emit: (ev) => { card = ev; }, id }, cwd, 'viewer_edit', rel.replace(/\\/g, '/'), abs, before, content);
    return { ok: true, card };
  } catch (e) {
    return { ok: false, error: 'error', message: String((e && e.message) || e) };
  }
}

/**
 * تنفيذ أداة باسمها — يعيد دائماً { ok, content } والمحتوى نص يُعاد للنموذج
 * (الفشل نص خطأ عربي، لا استثناء — النموذج يصحح مساره بنفسه).
 * ctx (اختياري): { emit, id } — لبطاقات diff وربطها ببطاقة الأداة (أدوات الكتابة).
 * ⚠️ أدوات الكتابة يجب ألا تُستدعى إلا بعد موافقة المستخدم (needsPermission في المحوّل).
 */
async function run(name, cwd, args, ctx) {
  try {
    if (name === 'read_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (!rel) return { ok: false, content: 'خطأ: وسيطة path مطلوبة' };
      const r = files.readText(cwd, rel);
      if (!r.ok) return { ok: false, content: 'خطأ: ' + (READ_ERRORS[r.error] || r.error) };
      let content = r.content;
      let truncated = r.truncated;
      if (content.length > MAX_RESULT) { content = content.slice(0, MAX_RESULT); truncated = true; }
      if (truncated) content += '\n…(قُصّ الملف هنا — تجاوز سقف حجم النتيجة)';
      return { ok: true, content };
    }
    if (name === 'list_files') {
      const list = await files.listFiles(cwd);
      if (!list.length) return { ok: true, content: '(لا ملفات — المجلد فارغ أو غير مقروء)' };
      let content = list.slice(0, MAX_LIST).join('\n');
      if (list.length > MAX_LIST) content += '\n…(' + (list.length - MAX_LIST) + ' ملفاً آخر لم يُعرض)';
      return { ok: true, content };
    }
    if (name === 'search_code') {
      // بحث «دلالي خفيف» (الدفعة 4.6) — قراءة بلا إذن، نمط Grep في Claude Code
      const q = args && typeof args.query === 'string' ? args.query.trim() : '';
      if (!q) return { ok: false, content: 'خطأ: وسيطة query مطلوبة' };
      const r = await search.search(cwd, q);
      if (!r.ok) return { ok: false, content: 'خطأ: استعلام غير صالح — كلمة واحدة على الأقل من حرفين' };
      if (!r.hits.length) return { ok: true, content: '(لا نتائج — جرّب كلمات أخرى أو list_files)' };
      let content = r.hits
        .map((h) => h.rel + (h.line ? ':' + h.line : '') + ': ' + h.text)
        .join('\n');
      if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + '\n…(قُصّت النتائج)';
      if (r.partial) content += '\n(مسح جزئي — نفدت ميزانية الوقت قبل تغطية كل الملفات)';
      return { ok: true, content };
    }
    if (name === 'verification_config') {
      return { ok: true, content: verify.formatConfig(verify.loadConfig(cwd)) };
    }
    if (name === 'verify_project') {
      const taskTitle = args && typeof args.task_title === 'string' ? args.task_title.trim() : '';
      if (!taskTitle) return { ok: false, content: 'خطأ: task_title مطلوبة لربط دليل التحقق بالمهمة' };
      const result = await verify.run(cwd, args && args.checks, ctx);
      if (ctx && typeof ctx.emit === 'function') {
        ctx.emit({ type: 'verification_result', schema_version: 1, task_title: taskTitle, ...result });
      }
      return { ok: !!result.ok, content: verify.formatResult(result) };
    }
    if (name === 'update_task_ledger') {
      if (!ctx || typeof ctx.emit !== 'function') return { ok: false, content: 'تعذّر تحديث سجل المهام في هذا المحرك' };
      const taskList = args && Array.isArray(args.tasks) ? args.tasks : [];
      if (!taskList.length && (!args || args.mode !== 'replace')) return { ok: false, content: 'خطأ: tasks مطلوبة' };
      ctx.emit({
        type: 'task_update',
        schema_version: 1,
        mode: args && args.mode === 'replace' ? 'replace' : 'merge',
        source: 'adapter_tool',
        tasks: taskList,
      });
      return { ok: true, content: 'حُدّث سجل المهام المرئي والدائم.' };
    }
    if (name === 'load_skill') {
      const skillName = args && typeof args.name === 'string' ? args.name.trim() : '';
      if (!skillName) return { ok: false, content: 'خطأ: وسيطة name مطلوبة' };
      const loaded = skills.loadSkill(ctx && ctx.skillContext, skillName);
      if (!loaded.ok) return { ok: false, content: 'خطأ: ' + (loaded.message || loaded.error) };
      const resources = loaded.resources.length
        ? loaded.resources.map((item) => '- ' + item.path + (Number.isFinite(item.bytes) ? ' (' + item.bytes + ' bytes)' : '')).join('\n')
        : '(لا موارد إضافية)';
      let content = loaded.instructions + '\n\n[Bundled resources — inspect with read_skill_resource; do not execute automatically]\n' + resources;
      if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + '\n…(قُصّت المهارة — تجاوزت سقف النتيجة)';
      return { ok: true, content };
    }
    if (name === 'read_skill_resource') {
      const skillName = args && typeof args.name === 'string' ? args.name.trim() : '';
      const resource = args && typeof args.resource === 'string' ? args.resource.trim() : '';
      if (!skillName || !resource) return { ok: false, content: 'خطأ: الوسيطتان name و resource مطلوبتان' };
      const loaded = skills.readResource(ctx && ctx.skillContext, skillName, resource);
      if (!loaded.ok) return { ok: false, content: 'خطأ: ' + (loaded.message || loaded.error) };
      let content = loaded.content;
      if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + '\n…(قُصّ المورد — تجاوز سقف النتيجة)';
      return { ok: true, content };
    }
    if (name === 'write_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      const content = args && typeof args.content === 'string' ? args.content : null;
      if (!rel || content == null) return { ok: false, content: 'خطأ: الوسيطتان path و content مطلوبتان' };
      if (content.length > MAX_WRITE) return { ok: false, content: 'خطأ: المحتوى أكبر من سقف الكتابة (1م.ب)' };
      const abs = resolveExisting(cwd, rel); // تسامح تطبيع (يصيب الملف العربي القائم لا نسخة مكرّرة)
      if (!abs) return { ok: false, content: 'خطأ: ' + READ_ERRORS.outside };
      const before = readBefore(abs); // يرمي للثنائي/الضخم — يلتقطه catch أدناه
      commitWrite(ctx, cwd, name, rel.replace(/\\/g, '/'), abs, before, content);
      const n = content.split('\n').length;
      return { ok: true, content: (before == null ? 'أُنشئ الملف ' : 'استُبدل محتوى الملف ') + rel + ' (' + n + ' سطراً)' };
    }
    if (name === 'edit_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      const oldStr = args && typeof args.old_string === 'string' ? args.old_string : '';
      const newStr = args && typeof args.new_string === 'string' ? args.new_string : null;
      if (!rel || !oldStr || newStr == null) return { ok: false, content: 'خطأ: الوسائط path و old_string و new_string مطلوبة' };
      const abs = resolveExisting(cwd, rel); // تسامح تطبيع (أسماء عربية)
      if (!abs) return { ok: false, content: 'خطأ: ' + READ_ERRORS.outside };
      const before = readBefore(abs);
      if (before == null) return { ok: false, content: 'خطأ: الملف غير موجود — استخدم write_file لإنشاء ملف جديد' };
      const count = before.split(oldStr).length - 1;
      if (count === 0) return { ok: false, content: 'خطأ: النص المطلوب استبداله غير موجود في الملف — اقرأ الملف مجدداً وطابق النص حرفياً' };
      if (count > 1 && !(args && args.replace_all)) {
        return { ok: false, content: 'خطأ: النص يتكرر ' + count + ' مرات — وسّع السياق ليكون فريداً أو مرّر replace_all: true' };
      }
      const after = (args && args.replace_all) ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
      if (after.length > MAX_WRITE * 2) return { ok: false, content: 'خطأ: الناتج أكبر من الحد المسموح' };
      commitWrite(ctx, cwd, name, rel.replace(/\\/g, '/'), abs, before, after);
      return { ok: true, content: 'عُدّل الملف ' + rel + (count > 1 ? ' (' + count + ' مواضع)' : '') };
    }
    if (name === 'delete_file') {
      const rel = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (!rel) return { ok: false, content: 'خطأ: الوسيطة path مطلوبة' };
      const abs = resolveExisting(cwd, rel); // تسامح تطبيع (أسماء عربية)
      if (!abs) return { ok: false, content: 'خطأ: ' + READ_ERRORS.outside };
      let st;
      try { st = fs.statSync(abs); } catch { return { ok: false, content: 'خطأ: الملف غير موجود (' + rel + ')' }; }
      if (!st.isFile()) return { ok: false, content: 'خطأ: المسار ليس ملفاً' };
      // لقطة المحتوى قبل الحذف ليعمل «تراجع» (يعيد إنشاء الملف) — نصّي فقط
      let before = null;
      try {
        if (st.size <= MAX_EDIT_SRC) {
          const buf = fs.readFileSync(abs);
          if (!inject.looksBinary(buf)) before = buf.toString('utf8');
        }
      } catch { before = null; }
      fs.unlinkSync(abs);
      const id = (ctx && ctx.id) || ('tool_' + Math.random().toString(36).slice(2));
      // لقطة الحذف: before = المحتوى، والتراجع يعيد كتابته (undoEdit يتكفّل)
      rememberSnapshot(id, { file_path: abs, before: before == null ? '' : before });
      if (ctx && typeof ctx.emit === 'function') {
        const d = computeDiff(before == null ? '' : before, '');
        ctx.emit({
          type: 'file_edit', id, tool: name,
          rel: rel.replace(/\\/g, '/'), isNew: false, isDelete: true,
          added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
        });
      }
      return { ok: true, content: 'حُذف الملف ' + rel };
    }
    if (name === 'run_command') {
      // 2.3: تنفيذ في طرفية النموذج المرئية (نفس مسار run_in_terminal للـ SDK — المرحلة 16):
      // المستخدم يرى الأمر وخرجه حياً، والأمر نصّ لمجرى pty لا لوسائط spawn (sanitizeCommand
      // في term.js ينقّي بايتات التحكم). ⚠️ لا يُستدعى إلا بعد موافقة المستخدم (tier 'exec').
      const command = args && typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) return { ok: false, content: 'خطأ: الوسيطة command مطلوبة' };
      const ensured = term.ensureModelTerm(cwd);
      if (!ensured.ok) return { ok: false, content: 'خطأ: تعذّر فتح طرفية النموذج: ' + (ensured.message || ensured.error) };
      // تبنّي الواجهة لتبويب «🤖 النموذج» عند إنشائه (نفس حدث مسار SDK)
      if (ensured.created && ctx && typeof ctx.emit === 'function') {
        ctx.emit({ type: 'model_term', id: ensured.id, shell: ensured.shell, cwd });
      }
      const secs = (args && Number.isFinite(args.timeout_seconds) && args.timeout_seconds > 0)
        ? Math.min(Math.floor(args.timeout_seconds), 600) : 120;
      const r = await term.runCapture(ensured.id, command, { timeoutMs: secs * 1000 });
      if (!r.ok) return { ok: false, content: 'خطأ: تعذّر التشغيل: ' + (r.message || r.error) };
      let output = r.output || '(لا خرج)';
      if (output.length > MAX_RESULT) output = output.slice(0, MAX_RESULT) + '\n…(قُصّ الخرج — تجاوز السقف)';
      const head = (r.timedOut ? '[انتهت المهلة — قد يكون أمراً طويلاً/تفاعلياً]\n' : '')
        + 'exit code: ' + (r.exitCode === null ? 'غير معروف' : r.exitCode) + '\n---\n';
      return { ok: r.exitCode === 0 || r.exitCode === null, content: head + output };
    }
    return { ok: false, content: 'خطأ: أداة غير معروفة: ' + String(name) };
  } catch (e) {
    return { ok: false, content: 'خطأ: ' + String((e && e.message) || e) };
  }
}

module.exports = { defs, run, needsPermission, permissionTier, undoEdit, saveFromViewer, MAX_RESULT };
