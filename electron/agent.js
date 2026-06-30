/**
 * سطر 2.0 — محرك Claude Agent SDK (المرحلة 2)
 *
 * يستبدل تشغيل `claude -p` بـ query() من ‎@anthropic-ai/claude-agent-sdk:
 *  - بث نصي تدريجي (stream_event → stream_text) عبر includePartialMessages
 *  - اعتراض طلبات الأذونات (canUseTool → permission_request) والرد عليها من الواجهة
 *  - مقاطعة حقيقية أثناء عمل النموذج عبر interrupt()‎ — تتطلب إدخالاً بثّياً،
 *    لذا نمرر البرومبت كمولّد غير متزامن يبقى مفتوحاً حتى نهاية الدور
 *
 * رسائل SDK من نوع system/assistant/user/result لها نفس بنية stream-json
 * التي تتعامل معها الواجهة أصلاً، فتمرَّر كما هي عبر emit.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { computeDiff } = require('./diff');
const bgprocs = require('./bgprocs');

const IS_WIN = process.platform === 'win32';

// أدوات تعديل الملفات التي نعرض لها فرقاً (Diff) — المرحلة 3
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MAX_DIFF_BYTES = 2 * 1024 * 1024; // فوقه لا نلتقط لقطة ولا نعرض فرقاً (أداء وذاكرة)

// لقطات الملفات قبل التعديل — تعيش بعد انتهاء التشغيل ليعمل «تراجع» لاحقاً.
// المفتاح tool_use_id (فريد عالمياً)، والقيمة { file_path, before } حيث
// before = المحتوى الأصلي أو null إن كان الملف جديداً (التراجع = حذفه).
const editSnapshots = new Map();
const MAX_SNAPSHOTS = 40; // سقف عدد اللقطات المحفوظة (إخلاء الأقدم)

function rememberSnapshot(id, snap) {
  editSnapshots.set(id, snap);
  while (editSnapshots.size > MAX_SNAPSHOTS) {
    const oldest = editSnapshots.keys().next().value;
    editSnapshots.delete(oldest);
  }
}

// مسار نسبي بفواصل «/» للعرض داخل الواجهة (يقع عادة داخل مجلد المشروع)
function relPath(cwd, fp) {
  try {
    const r = path.relative(cwd, fp);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return fp;
    return r.split(path.sep).join('/');
  } catch { return fp; }
}

/**
 * «تراجع» عن تعديل: يعيد الملف لمحتواه قبل التعديل (أو يحذفه إن كان جديداً).
 * يُستدعى من main.js عبر IPC؛ مستقل عن التشغيل الجاري فيعمل حتى بعد انتهائه.
 */
function undoEdit(id) {
  const snap = editSnapshots.get(id);
  if (!snap) return { ok: false, error: 'expired' }; // اللقطة أُخليت أو لا توجد
  try {
    if (snap.before == null) {
      // كان ملفاً جديداً — حذفه يعيد الحالة لما قبل الكتابة
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

// الحزمة ESM — نحمّلها بـ import()‎ ديناميكي من سياق CommonJS
let sdkModule = null;
async function loadSdk() {
  if (!sdkModule) sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
}

// تحديد مسار claude.exe المثبّت عالمياً.
// «سطر» يشترط أصلاً وجود Claude Code (شريط الفحص + محرك CLI الاحتياطي)، لذا
// نوجّه SDK إلى نفس الثنائي بدل حزم ثنائي ثانٍ بحجم ~234م.ب في المثبّت.
// النتيجة تُخزَّن؛ null تعني لم يُعثر عليه (يصل المستخدم رسالة spawn_error واضحة).
let claudeBinResolved;
// force=true يعيد الاكتشاف ويتجاوز التخزين — يلزم لزرّ «أعد الفحص» في بوابة أول تشغيل
// (المستخدم قد يكون ثبّت claude للتوّ بعد إقلاع «سطر»، فالقيمة المخزَّنة null قديمة).
function resolveClaudeBin(force) {
  if (!force && claudeBinResolved !== undefined) return claudeBinResolved;
  const tail = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  const candidates = [];
  if (process.env.CLAUDE_BIN) candidates.push(process.env.CLAUDE_BIN);
  if (IS_WIN && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', tail));
  if (!IS_WIN) candidates.push(path.join('/usr', 'local', 'lib', tail), path.join('/usr', 'lib', tail));
  // اشتقاق من موقع أمر claude في PATH (يكون عادة shim بجوار مجلد node_modules)
  try {
    const found = execSync(IS_WIN ? 'where claude' : 'which claude', { encoding: 'utf8' })
      .split(/\r?\n/)[0].trim();
    if (found) candidates.push(path.join(path.dirname(found), tail));
  } catch (e) { /* claude غير موجود في PATH */ }
  claudeBinResolved = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
  return claudeBinResolved;
}

// الأدوات الموافَق عليها «دائماً» — تعيش طوال عمر التطبيق
const alwaysAllowed = new Set();

/**
 * يبدأ دوراً واحداً (رسالة → رد) ويعيد مقبضاً فيه stop و resolvePermission.
 * emit(obj)‎ يرسل الأحداث للواجهة بنفس عقد satr:event.
 */
async function start({ prompt, images, sessionId, model, permissionMode, skills }, cwd, emit) {
  const { query } = await loadSdk();

  const pending = new Map(); // id → { resolve, toolName, input } لطلبات الأذونات المعلقة
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });

  // محتوى رسالة المستخدم: نص بسيط، أو مصفوفة كتل (نص + صور) عند وجود صور.
  // ترتيب الكتل: النص أولاً ثم الصور — والـ SDK يقبل source.type='base64'.
  function buildContent() {
    if (!images || !images.length) return prompt;
    const blocks = [];
    if (prompt) blocks.push({ type: 'text', text: prompt });
    for (const im of images) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
    }
    return blocks;
  }

  // مولّد الإدخال: رسالة واحدة ثم يبقى مفتوحاً (شرط عمل interrupt)
  async function* promptStream() {
    yield {
      type: 'user',
      message: { role: 'user', content: buildContent() },
      parent_tool_use_id: null,
      session_id: '',
    };
    await inputClosed;
  }

  // ---------- خطّافات الفرق (Diff) — المرحلة 3 ----------
  // PreToolUse يُنفَّذ قبل تشغيل الأداة وعملية claude تنتظر رده، فهو اللحظة
  // المضمونة لالتقاط «قبل» (القراءة المتزامنة تسبق أي كتابة). PostToolUse
  // يُنفَّذ بعد نجاح الأداة فنقرأ «بعد» الفعلي من القرص ونحسب الفرق.
  // (الفشل يمرّ عبر PostToolUseFailure لا PostToolUse، فلا نعرض فرقاً لتعديل فاشل.)
  async function preToolUse(input) {
    try {
      if (input && EDIT_TOOLS.has(input.tool_name)) {
        const fp = input.tool_input && input.tool_input.file_path;
        if (typeof fp === 'string' && fp) {
          let before = null, tooLarge = false;
          try {
            const st = fs.statSync(fp);
            if (st.isFile()) {
              if (st.size > MAX_DIFF_BYTES) tooLarge = true;
              else before = fs.readFileSync(fp, 'utf8');
            }
          } catch { before = null; } // الملف غير موجود ⇐ ملف جديد
          rememberSnapshot(input.tool_use_id, { file_path: fp, before, tooLarge });
        }
      }
    } catch { /* لا نُفشل الأداة بسبب خطأ في الالتقاط */ }
    // أمر Bash خلفي: لقطة شجرة العمليات قبل تشغيله لننسب إليه ما يُولّده لاحقاً
    try {
      if (input && input.tool_name === 'Bash' && input.tool_input && input.tool_input.run_in_background) {
        await bgprocs.markBefore(input.tool_use_id);
      }
    } catch { /* تتبّع العمليات تحسين، لا يجوز أن يكسر الأداة */ }
    return { continue: true };
  }

  async function postToolUse(input) {
    try {
      if (input && EDIT_TOOLS.has(input.tool_name)) {
        const id = input.tool_use_id;
        const snap = editSnapshots.get(id);
        const fp = (input.tool_input && input.tool_input.file_path) || (snap && snap.file_path);
        if (typeof fp === 'string' && fp && !(snap && snap.tooLarge)) {
          let after = '';
          try {
            const st = fs.statSync(fp);
            if (st.size <= MAX_DIFF_BYTES) after = fs.readFileSync(fp, 'utf8');
            else throw new Error('large');
          } catch { after = null; }
          if (after !== null) {
            const before = snap ? snap.before : null;
            const d = computeDiff(before == null ? '' : before, after);
            emit({
              type: 'file_edit', id, tool: input.tool_name,
              rel: relPath(cwd, fp), isNew: before == null,
              added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
            });
            // نضمن وجود لقطة للتراجع حتى لو فات خطّاف Pre (نادراً)
            if (!snap) rememberSnapshot(id, { file_path: fp, before: null, tooLarge: false });
          }
        }
      }
    } catch { /* العرض تحسين، لا يجوز أن يكسر التشغيل */ }
    // أمر Bash خلفي: الفرق عن لقطة «قبل» = عمليات الأمر، تُسجَّل لتعيش بعد الدور
    try {
      if (input && input.tool_name === 'Bash' && input.tool_input && input.tool_input.run_in_background) {
        await bgprocs.markAfter(input.tool_use_id, input.tool_input.command);
      }
    } catch { /* تتبّع العمليات تحسين، لا يجوز أن يكسر التشغيل */ }
    return { continue: true };
  }

  const options = {
    cwd,
    includePartialMessages: true,
    // خطّافات قبل/بعد التعديل لالتقاط الفرق وتمكين التراجع (المرحلة 3)
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
    },
    // بدون هذا لا يحمّل SDK إعدادات الملفات (تغيّر جذري بعد إعادة تسمية الحزمة):
    // خوادم MCP المحلية (.mcp.json) وحالة موصّلات claude.ai وأذوناتها ومهارات
    // المستخدم/المشروع. ضبطه على الثلاثة يجعل المحرك يطابق Claude Code التفاعلي.
    settingSources: ['user', 'project', 'local'],
    stderr: (data) => emit({ type: 'stderr', text: String(data) }),
    canUseTool: async (toolName, input, { signal, toolUseID }) => {
      if (alwaysAllowed.has(toolName)) return { behavior: 'allow', updatedInput: input };
      const id = String(toolUseID || 'perm_' + Math.random().toString(36).slice(2));
      emit({ type: 'permission_request', id, tool: toolName, input });
      return new Promise((resolve) => {
        pending.set(id, { resolve, toolName, input });
        if (signal) {
          signal.addEventListener('abort', () => {
            if (pending.delete(id)) resolve({ behavior: 'deny', message: 'أُلغي الطلب' });
          }, { once: true });
        }
      });
    },
  };
  // استخدام claude المثبّت عالمياً (لا نحزم ثنائياً ثانياً في المثبّت)
  const bin = resolveClaudeBin();
  if (bin) options.pathToClaudeCodeExecutable = bin;
  if (sessionId) options.resume = sessionId;
  if (model) options.model = model;
  if (permissionMode && permissionMode !== 'default') options.permissionMode = permissionMode;
  // المهارات (Skills): 'all' لتفعيل كل المكتشفة، أو مصفوفة أسماء مختارة من لوحة /مهارات.
  // نضبطه صراحةً دائماً — تركه محذوفاً يجعل التحميل يعتمد على افتراضيات الـ CLI وغير
  // مضمون (انظر توثيق خيار skills في الـ SDK). مصفوفة فارغة = لا مهارات مفعّلة.
  options.skills = (skills === 'all' || Array.isArray(skills)) ? skills : 'all';

  const q = query({ prompt: promptStream(), options });

  // حلقة الاستهلاك تعمل في الخلفية؛ الأحداث تصل الواجهة تباعاً
  (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev && ev.type === 'content_block_delta' && ev.delta &&
              ev.delta.type === 'text_delta' && ev.delta.text) {
            emit({ type: 'stream_text', text: ev.delta.text });
          }
        } else if (msg.type === 'system' || msg.type === 'assistant' || msg.type === 'user') {
          emit(msg);
        } else if (msg.type === 'result') {
          emit(msg);
          closeInput(); // انتهى الدور — إغلاق قناة الإدخال ينهي التشغيل
        }
        // أنواع أخرى (status/progress…) لا تعنينا حالياً
      }
      emit({ type: 'proc_done', code: 0 });
    } catch (e) {
      emit({ type: 'spawn_error', text: String((e && e.message) || e) });
      emit({ type: 'proc_done', code: 1 });
    } finally {
      closeInput();
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve({ behavior: 'deny', message: 'انتهى التشغيل' });
      }
    }
  })();

  return {
    // رد الواجهة على طلب إذن
    resolvePermission(id, allow, always) {
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      if (allow && always) alwaysAllowed.add(p.toolName);
      p.resolve(allow
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: 'رفض المستخدم استخدام هذه الأداة' });
      return true;
    },
    // إيقاف حقيقي: مقاطعة النموذج + إنهاء الإدخال + رفض الأذونات المعلقة
    async stop() {
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve({ behavior: 'deny', message: 'أوقف المستخدم الطلب' });
      }
      try { await q.interrupt(); } catch (e) { /* قد يكون التشغيل انتهى أصلاً */ }
      closeInput();
    },
  };
}

/**
 * تشغيل عابر لاستدعاء «دوال التحكّم» (control methods) في SDK ثم الإغلاق فوراً.
 * لا يرسل رسالة مستخدم — مولّد الإدخال ينتظر فقط ليبقي عملية claude حيّة، فتعمل
 * قناة التحكّم وتُحَل دوال مثل mcpServerStatus/getContextUsage. يُغلق دائماً في
 * finally (close + q.close()). يُستخدم للوحتي /موصلات و /سياق — مستقل عن الدور.
 * sessionId اختياري: تمريره يستأنف الجلسة (يلزم لقياس سياق المحادثة الفعلي).
 */
async function withControlQuery(cwd, sessionId, fn) {
  const { query } = await loadSdk();
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  async function* input() { await closed; } // لا يُنتِج رسالة — فقط يُبقي العملية حيّة
  const options = { cwd, settingSources: ['user', 'project', 'local'] };
  const bin = resolveClaudeBin();
  if (bin) options.pathToClaudeCodeExecutable = bin;
  if (sessionId) options.resume = sessionId;
  const q = query({ prompt: input(), options });
  // استهلاك المولّد في الخلفية لتشغيل العملية (دوال التحكّم تحتاج قناة حيّة)
  (async () => { try { for await (const _ of q) { /* تجاهل */ } } catch { /* أُغلق */ } })();
  try {
    return await fn(q);
  } finally {
    close();
    try { q.close(); } catch { /* قد يكون أُغلق أصلاً */ }
  }
}

// حالة خوادم MCP (الموصّلات) — قراءة فقط للوحة /موصلات
async function mcpStatus(cwd) {
  try {
    const list = await withControlQuery(cwd, null, (q) => q.mcpServerStatus());
    return { ok: true, servers: Array.isArray(list) ? list : [] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// إجراء على خادم MCP: reconnect (إعادة اتصال) أو enable/disable (تفعيل/تعطيل).
// أفضل جهد — لا يقود مصادقة OAuth (الـ SDK لا يكشفها)؛ تحديث اللوحة يكشف النتيجة.
async function mcpAction(cwd, name, action) {
  try {
    return await withControlQuery(cwd, null, async (q) => {
      if (action === 'reconnect') await q.reconnectMcpServer(name);
      else if (action === 'enable') await q.toggleMcpServer(name, true);
      else if (action === 'disable') await q.toggleMcpServer(name, false);
      else return { ok: false, error: 'bad_action' };
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// انهيار استخدام نافذة السياق للجلسة الحالية — للوحة /سياق.
// sessionId يستأنف الجلسة فيعكس رموز المحادثة الفعلية؛ بدونه يعكس السياق الأساس.
async function contextUsage(cwd, sessionId) {
  try {
    const usage = await withControlQuery(cwd, sessionId, (q) => q.getContextUsage());
    return { ok: true, usage };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { start, undoEdit, mcpStatus, mcpAction, contextUsage, resolveClaudeBin };
