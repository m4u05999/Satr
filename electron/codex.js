/**
 * سطر 2.0 — محرك Codex (OpenAI) الأصيل (المرحلة 1)
 *
 * محرك «خاص» ثانٍ موازٍ لـ agent.js (محرك Claude SDK) — لا محوّل أعمى. يقود Codex
 * أدواته الخاصة (صندوق الرمل، apply_patch، تنفيذ الأوامر) و«سطر» يعرض ويعترض، تماماً
 * كما يفعل مع Claude SDK. الركيزة: `codex app-server` عبر JSON-RPC ثنائي الاتجاه على
 * stdio (مثبَّت بالمسبار — لا exec --json لأنه بلا قناة ردّ فيستحيل اعتراض الأذونات).
 *
 * يطبّع خرج Codex (أحداث v2: thread/turn/item + ServerRequest للأذونات) إلى عقد أحداث
 * «سطر» نفسه (system/stream_text/assistant/user/result/permission_request/file_edit)،
 * مع phase اختيارية لنص الوكيل (commentary/final_answer) كي تفصل الواجهة سجل العمل عن
 * الإجابة. المصادقة: تسجيل دخول الاشتراك (~/.codex/auth.json) أولاً، والـ
 * API key ثانوياً (CODEX_API_KEY) — لا نحقنها هنا، الثنائي يقرأها بنفسه.
 *
 * تفاصيل مثبّتة بالمسبار (2026-07-12) موثّقة في ذاكرة codex-engine-plan:
 *  - طلب الإذن ServerRequest له id قد يكون 0 ⇒ فحص `id != null` لا truthy.
 *  - مفردات قرار v2: accept | acceptForSession | decline | cancel (لا مفردات v1).
 *  - النماذج الحديثة تعمل على Plus بعد تحديث الـ CLI (gpt-5.6-sol/terra/luna, gpt-5.5).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const { computeDiff } = require('./diff');
const skillCatalog = require('./skills');
const preview = require('./preview');   // وحدة المعاينة المشتركة (رؤية الويب لـ Codex — الخيار 1)
const codexmcp = require('./codexmcp');  // خادم MCP‏ streamable-HTTP داخل العملية

const IS_WIN = process.platform === 'win32';
const MAX_DIFF_BYTES = 2 * 1024 * 1024; // فوقه لا نلتقط لقطة تراجع ولا نعرض فرقاً

// ---------- لقطات التراجع (نظير agent.js) ----------
// المفتاح call_id للتعديل، القيمة { file_path, before } (before=null ⇒ ملف جديد، التراجع=حذف).
const editSnapshots = new Map();
const MAX_SNAPSHOTS = 40;
function rememberSnapshot(id, snap) {
  editSnapshots.set(id, snap);
  while (editSnapshots.size > MAX_SNAPSHOTS) {
    editSnapshots.delete(editSnapshots.keys().next().value);
  }
}
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

function relPath(cwd, fp) {
  try {
    const r = path.relative(cwd, fp);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return fp;
    return r.split(path.sep).join('/');
  } catch { return fp; }
}

// ---------- تحديد ثنائي codex المثبّت عالمياً (لا نحزمه — نمط resolveClaudeBin) ----------
// على ويندوز قد يكون: (1) حزمة npm مستقلة، (2) shim امتداد VS Code (openai.chatgpt-*).
// نحلّ إلى الـ exe الفعلي مباشرة (لا .cmd — spawn المباشر لها يفشل EINVAL، وshell:true
// قد يلتقط shim خاطئاً). force يتجاوز التخزين لزرّ «أعد الفحص» في البوابة (المرحلة 4).
let codexBinResolved;
function resolveCodexBin(force) {
  if (!force && codexBinResolved !== undefined) return codexBinResolved;
  const candidates = [];
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN);
  // (1) حزمة npm المستقلة: @openai/codex ⇒ حزمة المنصّة codex-<plat> ⇒ vendor/.../bin/codex.exe
  const plat = IS_WIN ? 'win32-x64' : (process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'));
  const triple = IS_WIN ? 'x86_64-pc-windows-msvc'
    : (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
      : (process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'));
  const exe = IS_WIN ? 'codex.exe' : 'codex';
  const npmVendorTail = path.join('node_modules', '@openai', 'codex', 'node_modules',
    '@openai', 'codex-' + plat, 'vendor', triple, 'bin', exe);
  const npmRoots = [];
  if (IS_WIN && process.env.APPDATA) npmRoots.push(path.join(process.env.APPDATA, 'npm'));
  if (!IS_WIN) npmRoots.push('/usr/local/lib', '/usr/lib');
  if (process.env.npm_config_prefix) npmRoots.push(process.env.npm_config_prefix);
  for (const root of npmRoots) candidates.push(path.join(root, npmVendorTail));
  // (2) shim امتداد VS Code (openai.chatgpt-<ver>-<plat>): أحدث نسخة
  try {
    if (IS_WIN && process.env.USERPROFILE) {
      const extDir = path.join(process.env.USERPROFILE, '.vscode', 'extensions');
      const dirs = fs.readdirSync(extDir)
        .filter((d) => /^openai\.chatgpt-.*win32-x64$/.test(d))
        .sort().reverse();
      for (const d of dirs) candidates.push(path.join(extDir, d, 'bin', 'windows-x86_64', 'codex.exe'));
    }
  } catch { /* لا امتداد */ }
  // (3) اشتقاق من موقع codex في PATH (قد يكون shim — نبحث عن exe بجواره)
  try {
    const found = execSync(IS_WIN ? 'where codex' : 'which codex', { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found && /\.exe$/i.test(found)) candidates.push(found);
  } catch { /* codex غير موجود في PATH */ }
  codexBinResolved = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
  return codexBinResolved;
}

// ---------- حالة تسجيل الدخول (للوحة الإرشاد/البوابة — المرحلة 4، لكن مفيدة الآن) ----------
// نقرأ ~/.codex/auth.json: chatgpt (اشتراك) أو apiKey. القيم لا تُعاد للواجهة (أمان).
function authStatus() {
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && raw.tokens && raw.tokens.id_token) return { ok: true, method: 'chatgpt' };
    if (raw && raw.OPENAI_API_KEY) return { ok: true, method: 'apikey' };
    return { ok: false, method: null };
  } catch { return { ok: false, method: null }; }
}

// ---------- تخطيط وضع «سطر» → سياسة Codex (approvalPolicy + sandbox) ----------
// قيم approvalPolicy الصالحة في Codex 0.144: untrusted | on-request | granular | never
// (on-failure المهجورة أُزيلت — كانت تُرجع Invalid request). درس مثبّت: `never` **لا** يعني
// «اقبل تلقائياً» بل «لا تصعّد» — فالكتابة تُحجب بصندوق read-only الفعلي (blocked by policy).
// لذا نُبقي on-request ونتحكّم بالقبول التلقائي في المعالج (نظير acceptEdits في Claude:
// التعديلات تُقبل تلقائياً والأوامر تبقى تسأل). bypassPermissions وحده never+full-access.
//  default          → on-request + workspace-write (المعالج يسأل عن كل شيء)
//  acceptEdits      → on-request + workspace-write (المعالج يقبل التعديلات تلقائياً، يسأل عن الأوامر)
//  plan             → on-request + read-only (لا كتابة)
//  bypassPermissions→ never + danger-full-access (بلا سؤال ولا صندوق)
function mapMode(mode) {
  switch (mode) {
    case 'acceptEdits': return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan': return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'bypassPermissions': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    default: return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

// ---------- الأدوات الموافَق عليها «دائماً» (لعمر التطبيق — نظير agent.js) ----------
const alwaysAllowed = new Set();

/**
 * عميل JSON-RPC خفيف فوق `codex app-server` (stdio، أسطر JSON مفصولة بـ \n).
 * يبثّ ServerRequest (أذونات) وnotifications (أحداث)، ويستقبل ردودنا.
 */
function decodeBase64(s) { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return s; } }

/**
 * يبدأ دوراً واحداً ويعيد مقبضاً فيه stop و resolvePermission (نفس عقد agent.start).
 */
async function start({ prompt, images, sessionId, model, permissionMode, skills }, cwd, emit) {
  const bin = resolveCodexBin();
  if (!bin) {
    emit({ type: 'spawn_error', text: 'لم يُعثر على Codex CLI. ثبّته: npm install -g @openai/codex' });
    emit({ type: 'proc_done', code: 1 });
    return { resolvePermission() { return false; }, async stop() {} };
  }

  // رؤية الويب لـ Codex (الخيار 1): نستضيف خادم MCP‏ streamable-HTTP **داخل العملية**
  // (electron/codexmcp.js) بوصول مباشر لـ preview.js، ونحقن إعداده في `codex app-server`
  // عبر تجاوزات `-c` وقت الإطلاق (بلا تلويث ~/.codex/config.toml وبلا عملية جسر). الرمز
  // يُمرَّر عبر متغيّر بيئة (codex يقرأه من bearer_token_env_var). أثبته اختبار حيّ:
  // codex اتصل، طلب tools/list، وأبلغ satr_preview=ready. أي فشل هنا لا يكسر الدور —
  // Codex يعمل بلا رؤية ويب (تدهور رشيق). open_preview يبثّ preview_open للواجهة لتفتح اللوحة.
  let mcpHost = null;
  try {
    mcpHost = await codexmcp.start({
      preview,
      openPreview: (url) => emit({ type: 'preview_open', url }),
      // أفعال المتصفح (نقر/كتابة/اختيار/مفتاح) تمرّ بمربع الإذن العربي نفسه — Codex لا
      // يبوّب نداءات MCP، فنبوّبها هنا (نفس قناة أذونات الأوامر: emit + resolvePermission).
      // bypassPermissions أو «موافقة دائمة» للأداة يعفيان. رفض ⇒ لا يُنفَّذ الفعل.
      requestPermission: (toolName, input) => new Promise((resolve) => {
        if (permissionMode === 'bypassPermissions' || alwaysAllowed.has(toolName)) { resolve(true); return; }
        const permId = 'cxmcp_' + (++mcpPermSeq) + '_' + Math.random().toString(36).slice(2, 6);
        mcpPerms.set(permId, { resolve, tool: toolName });
        emit({ type: 'permission_request', id: permId, tool: toolName, input: input || {} });
      }),
      // مؤشّر نشاط: عند كل نداء أداة يومض «🤖 الوكيل …» على لوحة المعاينة (عبر preview.js
      // → previewSender → preview-panel). أدوات Codex تُنفَّذ على خادم HTTP منفصل فلا تظهر
      // كـ tool_use في دوره، فهذا المسار البديل لإظهار نشاطه على المتصفح (نظير app.js لـ SDK).
      onActivity: (method, tool) => { if (method === 'tools/call' && tool) { try { preview.emitAgentActivity(tool); } catch (e) {} } },
    });
  } catch (e) { mcpHost = null; }
  const appServerArgs = ['app-server'];
  const spawnEnv = Object.assign({}, process.env);
  if (mcpHost) {
    appServerArgs.push(
      '-c', 'mcp_servers.satr_preview.url="' + mcpHost.url + '"',
      '-c', 'mcp_servers.satr_preview.bearer_token_env_var="SATR_MCP_TOKEN"',
    );
    spawnEnv.SATR_MCP_TOKEN = mcpHost.token;
  }
  const proc = spawn(bin, appServerArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
  const startedAt = Date.now();
  const skillContext = skillCatalog.resolveSelection(cwd, skills);

  // ترقيم الطلبات وربط الردود؛ pending للأذونات المعلّقة (id طلب الخادم → معلومات)
  let reqId = 0;
  const replies = new Map();       // id طلبنا → {resolve, reject}
  const perms = new Map();         // id طلب الخادم (إذن) → {reqId, tool}
  const mcpPerms = new Map();      // إذن فعل متصفح MCP معلّق: permId → {resolve, tool}
  let mcpPermSeq = 0;
  let threadId = null;
  let finished = false;
  let stopping = false;

  // تراكم نصّ رسالة الوكيل الحالية (نبثّه deltas ثم نُصدر assistant مكتملاً)
  const agentText = new Map();     // itemId → نص متراكم
  const agentPhase = new Map();    // itemId → commentary | final_answer
  const startedToolCards = new Set(); // أدوات ظهرت عند item/started وتنتظر نتيجتها
  // بيانات تغييرات الملفات لكل عنصر (تُلتقط عند item/started قبل تطبيق الرقعة):
  // itemId → [{ path, kind }]. تخدم غرضين: عرض المسارات في مربع الإذن (params
  // الإذن في v2 لا تحملها)، والتقاط لقطة «قبل» للتراجع في اللحظة الصحيحة (نظير PreToolUse).
  const fileChangeMeta = new Map();

  function writeMsg(obj) {
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* أُغلق */ }
  }
  function request(method, params) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      replies.set(id, { resolve, reject });
      writeMsg({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  function respond(id, result) { writeMsg({ jsonrpc: '2.0', id, result }); }

  function normalizeAgentPhase(phase) {
    return phase === 'commentary' ? 'commentary' : 'final_answer';
  }

  // تُصدر رسالة assistant نصية مكتملة بمرحلتها (تستبدل بثّ stream_text المناظر في الواجهة)
  function emitAssistantText(text, phase) {
    if (!text) return;
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text, phase: normalizeAgentPhase(phase) }] },
    });
  }
  function emitToolStart(id, name, input) {
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }
  function emitToolResult(id, output, isError) {
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output || '', is_error: !!isError }] } });
  }
  // مسار احتياطي إن لم يرسل app-server حدث item/started لإصدار بعينه.
  function emitToolCard(id, name, input, output, isError) {
    emitToolStart(id, name, input);
    emitToolResult(id, output, isError);
  }

  // التقاط لقطة «قبل» لتغيير ملف — تُستدعى عند item/started (قبل تطبيق الرقعة).
  // add ⇒ before=null (التراجع=حذف). update/delete ⇒ before=محتوى القرص الحالي.
  function captureSnapshot(callId, absPath, kind) {
    try {
      let before = null, tooLarge = false;
      if (kind !== 'add') {
        try {
          const st = fs.statSync(absPath);
          if (st.isFile()) {
            if (st.size > MAX_DIFF_BYTES) tooLarge = true;
            else before = fs.readFileSync(absPath, 'utf8');
          }
        } catch { before = null; } // غير موجود ⇒ يُعامل كجديد
      }
      rememberSnapshot(callId + '::' + absPath, { file_path: absPath, before, tooLarge });
    } catch { /* الالتقاط تحسين، لا يكسر الدور */ }
  }

  // بطاقة فرق من تغيير ملف Codex بعد تطبيقه (نقرأ «بعد» من القرص، و«قبل» من اللقطة).
  function emitFileChange(callId, absPath, kind) {
    try {
      const snap = editSnapshots.get(callId + '::' + absPath);
      if (snap && snap.tooLarge) return;
      const before = snap ? snap.before : null;
      let after = null;
      if (kind === 'delete') after = '';
      else { try { after = fs.readFileSync(absPath, 'utf8'); } catch { after = null; } }
      if (after == null) return;
      if (Buffer.byteLength(after) > MAX_DIFF_BYTES) return;
      const d = computeDiff(before == null ? '' : before, after);
      emit({
        type: 'file_edit', id: callId + '::' + absPath, tool: 'apply_patch',
        rel: relPath(cwd, absPath), isNew: before == null,
        added: d.added, removed: d.removed, lines: d.lines, truncated: d.truncated,
      });
    } catch { /* العرض تحسين، لا يكسر الدور */ }
  }

  // ---------- معالجة رسالة واردة من app-server ----------
  function handle(m) {
    // (أ) ردّ على طلب أرسلناه
    if (m.id != null && replies.has(m.id)) {
      const { resolve, reject } = replies.get(m.id);
      replies.delete(m.id);
      if (m.error) reject(new Error((m.error && m.error.message) || 'rpc_error'));
      else resolve(m.result);
      return;
    }
    // (ب) ServerRequest (id قد يكون 0! ⇒ id != null لا truthy) — أذونات
    if (m.id != null && m.method) {
      onServerRequest(m);
      return;
    }
    // (ج) notification (بلا id) — أحداث. نعتمد v2 (item/* thread/* turn/*) ونتجاهل توأم v1 (codex/event/*)
    if (m.method) onNotification(m.method, m.params || {});
  }

  function onServerRequest(m) {
    const method = m.method || '';
    // أذونات تنفيذ الأوامر وتعديل الملفات — نبثّها كمربع إذن عربي وننتظر الرد
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
        || method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const isFile = method.includes('fileChange') || method.includes('applyPatch');
      const p = m.params || {};
      const toolName = isFile ? 'apply_patch' : 'Shell';
      // قبول تلقائي بلا سؤال:
      //  - أداة موافَق عليها «دائماً» لهذه الجلسة.
      //  - وضع acceptEdits: التعديلات (apply_patch) تُقبل تلقائياً — الأوامر تبقى تسأل
      //    (مطابقة سلوك acceptEdits في Claude: Edit/Write تلقائية وBash يسأل).
      if (alwaysAllowed.has(toolName) || (permissionMode === 'acceptEdits' && isFile)) {
        respond(m.id, { decision: 'accept' });
        return;
      }
      // input للعرض في المربع (نقصّ الطويل). params إذن الملفات في v2 لا تحمل المسارات،
      // فنجلبها من fileChangeMeta الملتقطة عند item/started (بمفتاح itemId).
      let input;
      if (isFile) {
        const meta = fileChangeMeta.get(p.itemId) || [];
        const files = meta.map((c) => relPath(cwd, c.path));
        input = { changes: files.length ? files : Object.keys(p.fileChanges || p.changes || {}).map((f) => relPath(cwd, f)) };
      } else {
        input = { command: Array.isArray(p.command) ? p.command.join(' ') : (p.command || ''), cwd: p.cwd || cwd, reason: p.reason || undefined };
      }
      const permId = 'cx_' + m.id + '_' + Math.random().toString(36).slice(2, 8);
      perms.set(permId, { serverId: m.id, tool: toolName });
      emit({ type: 'permission_request', id: permId, tool: toolName, input });
      return;
    }
    // طلبات أخرى من الخادم لا نتعامل معها الآن — ردّ فارغ حتى لا يعلّق
    respond(m.id, {});
  }

  function onNotification(method, p) {
    switch (method) {
      case 'thread/started': {
        threadId = (p.thread && p.thread.id) || threadId;
        if (threadId) emit({ type: 'system', subtype: 'init', session_id: threadId });
        break;
      }
      case 'item/agentMessage/delta': {
        if (p.delta) {
          const itemId = p.itemId || '_';
          const phase = normalizeAgentPhase(p.phase || agentPhase.get(itemId));
          if (p.phase) agentPhase.set(itemId, phase);
          emit({ type: 'stream_text', text: p.delta, phase });
          agentText.set(itemId, (agentText.get(itemId) || '') + p.delta);
        }
        break;
      }
      case 'item/started': {
        // بداية عنصر: لعناصر تغيير الملفات نلتقط لقطة «قبل» الآن (قبل تطبيق الرقعة —
        // اللحظة الصحيحة للتراجع، نظير PreToolUse) ونخزّن مساراتها لمربع الإذن.
        const it = p.item || {};
        if (it.type === 'agentMessage' && it.id && it.phase) agentPhase.set(it.id, normalizeAgentPhase(it.phase));
        if (it.type === 'commandExecution' && it.id) {
          const command = typeof it.command === 'string' ? it.command : (Array.isArray(it.command) ? it.command.join(' ') : '');
          emitToolStart(it.id, 'Shell', { command, cwd: it.cwd || cwd });
          startedToolCards.add(it.id);
        }
        if (it.type === 'fileChange' && Array.isArray(it.changes)) {
          const meta = [];
          for (const ch of it.changes) {
            const abs = ch.path || '';
            const kind = (ch.kind && ch.kind.type) || 'update';
            meta.push({ path: abs, kind });
            if (abs) captureSnapshot(it.id, abs, kind);
          }
          fileChangeMeta.set(it.id, meta);
        }
        break;
      }
      case 'turn/plan/updated': {
        // عقد Codex v2 المثبّت بالـschema: plan[{step,status pending|inProgress|completed}].
        // التفكير يبقى transcript؛ الخطة تُطبّع كحالة task_update كاملة قابلة للحفظ والقياس.
        if (Array.isArray(p.plan)) emit({
          type: 'task_update',
          schema_version: 1,
          session_id: p.threadId || threadId,
          mode: 'replace',
          source: 'codex_plan',
          tasks: p.plan.map((item, index) => ({
            id: 'codex-plan-' + (index + 1),
            title: item && item.step,
            status: item && item.status === 'inProgress' ? 'in_progress'
              : item && item.status === 'completed' ? 'completed' : 'pending',
            owner: 'Codex',
            dependencies: [],
            evidence: [],
          })),
        });
        break;
      }
      case 'item/completed': {
        onItemCompleted(p.item || {});
        break;
      }
      case 'turn/completed': {
        finishTurn(p.turn || {});
        break;
      }
      case 'turn/failed': {
        finishTurn(p.turn || { status: 'failed', error: p.error });
        break;
      }
      case 'mcpServer/startupStatus/updated': {
        // رؤية الويب (الخيار 1): نرصد حالة خادمنا satr_preview فقط. الفشل نادر (المنفذ
        // محلي والرمز يُمرَّر بالبيئة) لكن إن حدث نُبلّغه كـ stderr للتشخيص بلا كسر الدور.
        if (p && p.name === 'satr_preview' && p.status === 'failed') {
          emit({ type: 'stderr', text: 'تعذّر ربط رؤية الويب (satr_preview MCP) — يعمل Codex بلا معاينة.' });
        }
        break;
      }
      default:
        // rate limits / token usage … لا تعنينا في المرحلة 1
        break;
    }
  }

  function onItemCompleted(item) {
    const t = item.type;
    if (t === 'agentMessage') {
      // النص الكامل — نُصدر assistant (يستبدل بثّ stream_text في الواجهة)
      const text = (typeof item.text === 'string' && item.text) || agentText.get(item.id) || '';
      const phase = normalizeAgentPhase(item.phase || agentPhase.get(item.id));
      emitAssistantText(text, phase);
      agentText.delete(item.id);
      agentPhase.delete(item.id);
    } else if (t === 'commandExecution') {
      const cmd = typeof item.command === 'string' ? item.command : (Array.isArray(item.command) ? item.command.join(' ') : '');
      const out = item.aggregatedOutput || item.stdout || '';
      const isErr = typeof item.exitCode === 'number' ? item.exitCode !== 0 : false;
      if (startedToolCards.delete(item.id)) emitToolResult(item.id, out, isErr);
      else emitToolCard(item.id, 'Shell', { command: cmd, cwd: item.cwd || cwd }, out, isErr);
    } else if (t === 'fileChange') {
      // نفضّل بيانات item/started الملتقطة (قد يختصر item/completed الحقول)؛ وإلا item الحالي
      const changes = fileChangeMeta.get(item.id)
        || (Array.isArray(item.changes) ? item.changes.map((ch) => ({ path: ch.path, kind: (ch.kind && ch.kind.type) || 'update' })) : []);
      for (const ch of changes) {
        if (ch.path) emitFileChange(item.id, ch.path, ch.kind);
      }
      fileChangeMeta.delete(item.id);
    } else if (t === 'reasoning') {
      // ملخّص تفكير (نادر الظهور — «سطر» لا يعرض تفكير Claude أصلاً). نعرضه مقتضباً إن وُجد.
      // الحقل غير مضمون عبر الإصدارات فنجرّب text/summary/content دفاعياً.
      let r = (typeof item.text === 'string' && item.text)
        || (typeof item.summary === 'string' && item.summary)
        || (Array.isArray(item.content) ? item.content.map((c) => (c && (c.text || c.summary)) || '').filter(Boolean).join(' ') : '');
      r = String(r || '').trim();
      if (r) emitAssistantText('💭 ' + (r.length > 600 ? r.slice(0, 600) + '…' : r), 'commentary');
    }
    // WebSearch/غيرها: نص الوكيل يكفي
  }

  function finishTurn(turn) {
    if (finished) return;
    finished = true;
    const isError = turn.status === 'failed' || !!turn.error;
    const errMsg = turn.error && (turn.error.message || turn.error);
    // خطأ الطبقة (نموذج غير مدعوم بالخطة/الإصدار…) — نظهره نصاً واضحاً للمستخدم
    if (isError && errMsg) {
      let human = String(errMsg);
      try { const j = JSON.parse(human); if (j && j.detail) human = j.detail; } catch {}
      emitAssistantText('⚠️ تعذّر إكمال الدور: ' + human, 'final_answer');
    }
    emit({
      type: 'result', subtype: isError ? 'error' : 'success',
      is_error: isError, session_id: threadId,
      duration_ms: Date.now() - startedAt, total_cost_usd: null,
    });
    cleanup(0);
  }

  function cleanup(code) {
    // رفض أي إذن معلّق ثم إنهاء العملية بلطف. نغلق stdin (إشارة إنهاء لـ app-server)
    // ونمهله لحظة ليُفرّغ ملف الجلسة إلى القرص قبل القتل — وإلا قد يُبتر فيفشل
    // استئنافها لاحقاً (درس مثبّت: القتل الفوري بعد result يقطع تفريغ الجلسة).
    for (const [permId, info] of perms) {
      try { respond(info.serverId, { decision: 'cancel' }); } catch {}
      perms.delete(permId);
    }
    // فكّ أي إذن فعل متصفح معلّق بالرفض (لا يعلّق نداء MCP بعد إنهاء الدور)
    for (const [permId, info] of mcpPerms) { try { info.resolve(false); } catch {} mcpPerms.delete(permId); }
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 500);
    if (mcpHost) { try { mcpHost.stop(); } catch {} mcpHost = null; } // أوقِف خادم رؤية الويب MCP
    if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
  }
  let emittedDone = false;

  // ---------- قراءة stdout سطراً سطراً ----------
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      try { handle(m); } catch (e) { emit({ type: 'stderr', text: 'codex handle: ' + String((e && e.message) || e) }); }
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    // نُخفي ضوضاء تحديث التوكن؛ نمرّر الباقي كـ stderr
    if (!/refresh|models_manager|token/i.test(s)) emit({ type: 'stderr', text: s });
  });
  proc.on('error', (e) => {
    emit({ type: 'spawn_error', text: 'تعذّر تشغيل Codex: ' + String((e && e.message) || e) });
    cleanup(1);
  });
  proc.on('exit', (code) => {
    if (!finished && !stopping) emit({ type: 'spawn_error', text: 'أُنهيت عملية Codex (كود ' + code + ')' });
    if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }
  });

  // ---------- تسلسل الإقلاع: initialize → thread/start أو resume → turn/start ----------
  (async () => {
    try {
      await request('initialize', { clientInfo: { name: 'satr', title: 'Satr', version: '1.0.0' } });
      const { approvalPolicy, sandbox } = mapMode(permissionMode);
      // تعريف الوكيل ببيئته والنموذج المختار (نظير systemPrompt في agent.js). النماذج لا
      // تعرف اسمها الرمزي (بيانات التدريب تسبق الإصدار) فتُعرّف نفسها عموماً بـ GPT-5؛
      // حقن الاسم هنا يجعلها تجيب بدقّة. developerInstructions إضافي (لا يستبدل تعليمات Codex).
      const devInstructions = 'تواصل مع المستخدم بالعربية افتراضياً في كل شرحك وردودك '
        + '(«سطر» منصّة عربية)، مع إبقاء الكود والمسارات والأوامر والمصطلحات التقنية بالإنجليزية '
        + 'LTR؛ وإن طلب لغة أخرى صراحةً فاتّبعه. '
        + 'أنت تعمل داخل تطبيق «سطر» (Satr) — واجهة عربية لسطح المكتب '
        + 'تُشغّل Codex بجوار Claude Code. '
        + 'وفيه متصفح معاينة مدمج: عند تشغيل خادم ويب محلي استعمل أداة open_preview (من خادم '
        + 'satr_preview) لعرضه داخل «سطر» بدل فتح متصفح خارجي، ثم افحص ما بنيته بأدوات المعاينة: '
        + 'read_page (بنية الصفحة النصية) وbrowser_snapshot (العناصر التفاعلية) وscreenshot '
        + '(لقطة بصرية) وbrowser_console (أخطاء JavaScript) وbrowser_network (طلبات الشبكة برموز '
        + 'الحالة) — استعملها للتحقق من نتيجة تعديلاتك وتصحيح نفسك. '
        + 'وللتفاعل مع الصفحة: خذ لقطة بـ browser_snapshot (تعطيك كل عنصر بصيغة [ref] role "name")، '
        + 'ثم مرّر الـ ref إلى browser_click/browser_type/browser_select_option/browser_press_key '
        + '(تطلب إذن المستخدم)، وأعد أخذ اللقطة بعد كل فعل لأن المُعرّفات تتغيّر. '
        + 'عند توليد الصور/الفيديو (مثل Higgsfield) اكتب برومبتاً غنيّاً بالتفاصيل البصرية '
        + '(الإنجليزية أوثق تحكّماً، والنماذج الأحدث تفهم العربية أيضاً). النص داخل الصورة '
        + 'مشروط بالنموذج: النماذج الحديثة (GPT Image وNano Banana Pro/2) تكتب العربية سليمة، '
        + 'والأقدم تكسرها — فاختر نموذجاً قوياً بالعربية عند الحاجة (models_explore) أو ضع '
        + 'النص العربي كطبقة HTML فوق الصورة؛ لا تمنعه منعاً مطلقاً. '
        + 'لا تستخدم من Agent Skills إلا المهارات المرفقة صراحةً بمدخلات هذا الدور.'
        + (model ? ' النموذج المختار حالياً في واجهة «سطر» هو «' + model + '» (من OpenAI Codex).' : '');
      const startParams = { cwd, approvalPolicy, sandbox, developerInstructions: devInstructions, experimentalRawEvents: false, persistExtendedHistory: false };
      if (sessionId) {
        // استئناف خيط قائم من القرص (~/.codex/sessions) بمعرّفه. الحقول cwd/السياسة/
        // persistExtendedHistory مطلوبة (persistExtendedHistory ليست اختيارية في السكيمة).
        try {
          const r = await request('thread/resume', { threadId: sessionId, cwd, approvalPolicy, sandbox, developerInstructions: devInstructions, persistExtendedHistory: false });
          threadId = (r && r.thread && r.thread.id) || sessionId;
        } catch (e) {
          // فشل الاستئناف (جلسة محذوفة/تالفة) ⇒ نبدأ خيطاً جديداً بدل تعليق الدور
          emit({ type: 'stderr', text: 'تعذّر استئناف جلسة Codex — بدء جلسة جديدة' });
          const r = await request('thread/start', startParams);
          threadId = r && r.thread && r.thread.id;
        }
      } else {
        const r = await request('thread/start', startParams);
        threadId = r && r.thread && r.thread.id;
      }
      if (threadId) emit({ type: 'system', subtype: 'init', session_id: threadId });
      // مدخلات الدور: نصّ + صور (نماذج Codex تقبل الصور — تحقّق حيّ). الصور base64
      // تُمرَّر كـ data-URL (لا حاجة لملف مؤقت — كلا الشكلين image/localImage يعمل).
      const inputItems = [];
      inputItems.push(...skillCatalog.codexInputs(skillContext));
      if (prompt) inputItems.push({ type: 'text', text: prompt, text_elements: [] });
      if (Array.isArray(images)) {
        for (const im of images) {
          if (im && im.media_type && im.data) {
            inputItems.push({ type: 'image', url: 'data:' + im.media_type + ';base64,' + im.data });
          }
        }
      }
      if (!inputItems.length) inputItems.push({ type: 'text', text: prompt || '', text_elements: [] });
      const turnParams = { threadId, input: inputItems };
      if (model) turnParams.model = model;
      await request('turn/start', turnParams);
      // الأحداث تصل عبر notifications؛ الدور ينتهي بـ turn/completed
    } catch (e) {
      if (!finished) {
        emit({ type: 'spawn_error', text: 'تعذّر بدء دور Codex: ' + String((e && e.message) || e) });
        emit({ type: 'result', subtype: 'error', is_error: true, session_id: threadId, duration_ms: Date.now() - startedAt, total_cost_usd: null });
      }
      cleanup(1);
    }
  })();

  return {
    // رد الواجهة على طلب إذن → قرار Codex بمفردات v2 (accept/acceptForSession/decline)
    resolvePermission(id, allow, always) {
      // فعل متصفح MCP معلّق (لا serverId — نحلّ Promise الأداة مباشرةً)
      const mcp = mcpPerms.get(id);
      if (mcp) {
        mcpPerms.delete(id);
        if (allow && always) alwaysAllowed.add(mcp.tool);
        try { mcp.resolve(!!allow); } catch {}
        return true;
      }
      const info = perms.get(id);
      if (!info) return false;
      perms.delete(id);
      if (allow && always) alwaysAllowed.add(info.tool);
      const decision = allow ? (always ? 'acceptForSession' : 'accept') : 'decline';
      respond(info.serverId, { decision });
      return true;
    },
    // إيقاف: مقاطعة الدور + رفض الأذونات المعلّقة + إنهاء العملية
    async stop() {
      stopping = true;
      for (const [permId, info] of perms) {
        try { respond(info.serverId, { decision: 'cancel' }); } catch {}
        perms.delete(permId);
      }
      for (const [permId, info] of mcpPerms) { try { info.resolve(false); } catch {} mcpPerms.delete(permId); }
      if (threadId) { try { await request('turn/interrupt', { threadId }); } catch {} }
      cleanup(0);
    },
  };
}

module.exports = { start, undoEdit, resolveCodexBin, authStatus };
