/**
 * سطر 2.0 — قراءة جلسات Codex المحفوظة محلياً (قراءة فقط) — تلميع المرحلة 4
 * المصدر: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<thread-id>.jsonl
 * كل سطر JSON مستقل. `session_meta` (السطر الأول) يحمل payload.session_id / cwd.
 *
 * **صيغتان للرسائل** (‏OBS-133 — 2026-09-06):
 *  - القديمة: `event_msg` بـ`payload.type` ∈ {user_message, agent_message} والنصّ في
 *    `payload.message`. تبقى مقروءة للأرشيف.
 *  - الحديثة: `response_item` بـ`payload.type='message'` ودور `user`/`assistant`،
 *    والنصّ في `payload.content[].text`.
 *
 * كان هذا القارئ يقرأ القديمة **وحدها** ويتجاهل `response_item` كلها بحجة أنها «تحمل
 * السياق المحقون» — وصحّ ذلك يوم كُتب، ثم نقل Codex الرسائل نفسها إليها فصار القارئ
 * أعمى: قياس على جلسة المالك (‏`01a0721d`، ‏6678 سطراً و24.8 م.ب، ‏codex-cli 0.153.4)
 * أعطى **صفر** `event_msg/user_message` مقابل `message/user × 101` و
 * `message/assistant × 140`. فكانت الجلسة تُستأنف بمحادثة فارغة.
 *
 * ويبقى ترشيح السياق لازماً على مستويين: (1) **الرسالة كاملةً** — قياس 2026-09-06
 * (‏`01a0721d`): من 101 رسالة `user` كانت 92 سياقاً منفصلاً يبدأ بوسم زاوية
 * (`<recommended_plugins>` من Codex · `<satr_project_memory>` منّا · `<skill>`)؛
 * و(2) **العنصر داخل الرسالة** — قياس 2026-09-10: المرساة الذيلية `<satr_lang>`
 * تصل عنصر `input_text` ثانياً ملتصقاً بنصّ المستخدم في الرسالة نفسها، فيحذفه
 * `userContentText` (كل عنصر يبدأ بوسم زاوية) ويبقى النصّ الحقيقي.
 * (ونتجاهل `message/developer` لأنها سياق، و`agent_message` داخل `response_item` لأن
 *  نصّها فارغ وهي تواصل وكلاء لا رسالة عرض — مقيس: 40 منها بلا نصّ.)
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { queryCodex } = require('./codexrpc');

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
// معرّف الخيط UUID-like (أرقام/حروف hex وشرطات) — مكوّن واحد بلا فواصل مسار
const SAFE_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
const HEAD_BYTES = 128 * 1024; // رأس الملف يكفي عادةً لالتقاط أول user_message
const MAX_SESSIONS = 80;
const MAX_MESSAGES = 40;
const WALK_CAP = 4000; // سقف ملفات نمشيها (حماية أداء)

function safeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && id !== '.' && id !== '..';
}

function parseLines(chunk) {
  const out = [];
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* سطر مبتور/تالف — نتجاهله */ }
  }
  return out;
}

// مشي محدود العمق (YYYY/MM/DD) يجمع مسارات *.jsonl — بلا اتّباع روابط، بسقف عدد
async function walkJsonl(root) {
  const files = [];
  async function walk(dir, depth) {
    if (files.length >= WALK_CAP || depth > 4) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= WALK_CAP) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await walk(root, 0);
  return files;
}

// نصّ عناصر المحتوى في الصيغة الحديثة (`input_text` للمستخدم و`output_text` للمساعد).
// نقرأ `text` أياً كان `type` كي لا ينكسر العقد بنوع محتوى جديد يضيفه Codex.
function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

// رسالة مستخدم — أو null إن كانت كتلة سياق محقونة (تبدأ بوسم زاوية؛ انظر رأس الملف)
function userLine(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t || t.startsWith('<')) return null;
  return { role: 'user', text: t };
}

// تجميع محتوى رسائل المستخدم في الصيغة الحديثة: الحقن لا يأتي رسالةً منفصلة دائماً —
// قياس 2026-09-10 على rollout المالك: المرساة الذيلية `<satr_lang>` (والذاكرة حين
// تُسترجع) تصل **عنصر `input_text` ثانياً في رسالة المستخدم نفسها**، فكان contentText
// يجمعها مع النصّ الحقيقي وتظهر خاماً في فقاعة الاستعادة. يُحذف كل عنصر يبدأ بوسم
// زاوية (سياق محقون بأي وسم كان) ويبقى نصّ المستخدم وحده؛ رسالة كل عناصرها سياقاً
// تفرغ فيسقطها userLine. (ردود المساعد تُقرأ بـcontentText كما هي — لا حقن فيها.)
function userContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && typeof item.text === 'string' ? item.text.trim() : ''))
    .filter((text) => text && !text.startsWith('<'))
    .join('\n')
    .trim();
}

function assistantLine(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  return t ? { role: 'assistant', text: t } : null;
}

// نصّ رسالة من سطر سجلّ — يدعم صيغتَي Codex معاً (انظر رأس الملف) — أو null
function sessionMessage(e) {
  if (!e || !e.payload) return null;
  const p = e.payload;

  // الصيغة القديمة
  if (e.type === 'event_msg') {
    if (p.type === 'user_message') return userLine(p.message);
    if (p.type === 'agent_message') return assistantLine(p.message);
    return null;
  }

  // الصيغة الحديثة — `message` بدور صريح حصراً (developer/system سياق فيُتجاهل)
  if (e.type === 'response_item' && p.type === 'message') {
    if (p.role === 'user') return userLine(userContentText(p.content));
    if (p.role === 'assistant') return assistantLine(contentText(p.content));
  }
  return null;
}

// قائمة جلسات Codex، الأحدث أولاً — رأس كل ملف فقط لالتقاط العنوان والـ cwd
async function listCodexSessionsLegacy() {
  let files = [];
  try { files = await walkJsonl(SESSIONS_ROOT); } catch { return []; }
  if (!files.length) return [];

  const stats = await Promise.all(files.map(async (file) => {
    try { const s = await fsp.stat(file); return { file, mtime: s.mtimeMs, size: s.size }; }
    catch { return null; }
  }));
  const recent = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);

  const sessions = [];
  for (const f of recent) {
    let head = '', fh = null;
    try {
      fh = await fsp.open(f.file, 'r');
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, f.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, bytesRead);
    } catch { continue; }
    finally { if (fh) await fh.close().catch(() => {}); }

    let id = '', cwd = '', title = '';
    for (const e of parseLines(head)) {
      if (e.type === 'session_meta' && e.payload) {
        if (!id && typeof e.payload.session_id === 'string') id = e.payload.session_id;
        if (!cwd && typeof e.payload.cwd === 'string') cwd = e.payload.cwd;
      }
      if (!title) {
        const m = sessionMessage(e);
        if (m && m.role === 'user') title = m.text;
      }
      if (id && cwd && title) break;
    }
    if (!id || !safeId(id)) continue;        // بلا معرّف صالح — لا تُعرض
    if (!title) continue;                     // بلا رسالة مستخدم فعلية — جلسة فارغة
    sessions.push({
      id,
      cwd,
      title: title.replace(/\s+/g, ' ').slice(0, 90),
      mtime: f.mtime,
      size: f.size,
    });
  }
  return sessions;
}

// قراءة جلسة Codex بمعرّفها: cwd + آخر رسائلها للعرض. البحث بمطابقة لاحقة اسم الملف
// (rollout-…-<id>.jsonl) مع تحقّق أن المسار داخل مجلد الجلسات (حزام أمان فوق safeId).
async function readCodexSessionLegacy(id) {
  if (!safeId(id)) return { error: 'bad_args' };
  let files = [];
  try { files = await walkJsonl(SESSIONS_ROOT); } catch { return { error: 'not_found' }; }
  const suffix = '-' + id + '.jsonl';
  const file = files.find((f) => path.basename(f).endsWith(suffix));
  if (!file) return { error: 'not_found' };
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(SESSIONS_ROOT) + path.sep)) return { error: 'bad_args' };

  let raw;
  try { raw = await fsp.readFile(resolved, 'utf8'); } catch { return { error: 'not_found' }; }

  let cwd = '';
  const messages = [];
  for (const e of parseLines(raw)) {
    if (e.type === 'session_meta' && e.payload && typeof e.payload.cwd === 'string' && !cwd) cwd = e.payload.cwd;
    const m = sessionMessage(e);
    if (m) messages.push(m);
  }
  return { cwd, total: messages.length, messages: messages.slice(-MAX_MESSAGES) };
}

function codexBin() {
  try { return require('./codex').resolveCodexBin(); } catch { return null; }
}

// عنوان خيط Codex من thread/list يشتقّه Codex نفسه من أول إدخال مستخدم — الذي قد
// يكون كتلتنا المحقونة (‏`<satr_project_memory>` / `<satr_lang>`) فيظهر العنوان خاماً
// في لوحة الجلسات (بلاغ المالك 2026-09-10). يحذف كتلنا الموسومة ومبتورها (معاينة
// قد تُقطع قبل وسم الإغلاق)، ويسقط إلى العنوان الافتراضي إن فرغ الناتج.
function cleanThreadTitle(raw) {
  const t = String(raw || '')
    .replace(/<satr_project_memory>[\s\S]*?<\/satr_project_memory>/g, '')
    .replace(/<satr_lang>[\s\S]*?<\/satr_lang>/g, '')
    .replace(/<satr_project_memory[\s\S]*$/g, '')
    .replace(/<satr_lang[\s\S]*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || 'جلسة Codex';
}

async function rpc(method, params) {
  const bin = codexBin();
  if (!bin) throw new Error('codex_unavailable');
  return queryCodex(bin, method, params, { timeoutMs: 10000 });
}

// نصّ عرض رسالة المستخدم من thread/read: يبقي ما كتبه المستخدم فعلاً (نصّاً، أو
// «[صورة]» لما أرفقه) ويحذف السياق المحقون بأشكاله — عناصر skill/mention (مهارات
// مفعَّلة يحقنها سطر عند الإرسال، لا مدخلات مكتوبة)، والنصوص الموسومة بزاوية
// (ذاكرتنا `<satr_project_memory>`، مرساة `<satr_lang>`، سياق Codex نفسه)، وكتلة
// AGENTS.md التي يضيفها Codex لأول دور (بلاغ المالك 2026-09-10 — OBS-153).
function userDisplayText(content) {
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' || item.type === 'input_text' || item.type === 'inputText') {
      const t = typeof item.text === 'string' ? item.text.trim() : '';
      if (!t || t.startsWith('<') || t.startsWith('# AGENTS.md instructions')) continue;
      texts.push(t);
    } else if (['image', 'localImage', 'inputImage', 'input_image'].includes(item.type)) {
      texts.push('[صورة]');
    }
  }
  return texts.join('\n').trim();
}

async function listCodexSessions() {
  try {
    const result = await rpc('thread/list', {
      limit: MAX_SESSIONS,
      archived: false,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    const data = Array.isArray(result && result.data) ? result.data : [];
    return data.filter((thread) => thread && safeId(thread.id)).map((thread) => ({
      id: thread.id,
      cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
      title: cleanThreadTitle(thread.name || thread.preview).slice(0, 90),
      mtime: (Number(thread.recencyAt || thread.updatedAt || thread.createdAt) || 0) * 1000,
      size: 0,
      status: typeof thread.status === 'string' ? thread.status : null,
    }));
  } catch {
    return listCodexSessionsLegacy();
  }
}

// سجل النقل الكامل مستقل عن آخر أربعين رسالة المعروضة في لوحة الجلسات.
// coverage.complete يصف اكتمال النص المقروء؛ الصور وصفية فقط، وstructuredContent غير
// النصي أو نوع غير مفهوم أو أداة/دور لم يكتمل يعلن نقصاً يحجب نقل هذا الاستيراد.
function continuityMessages(thread) {
  const messages = [];
  const issues = new Set();
  let imagesComplete = true;
  const terminalStatuses = new Set(['completed', 'failed', 'declined']);
  const knownStatuses = new Set([...terminalStatuses, 'inProgress', 'pending', 'interrupted', 'cancelled', 'canceled']);
  const imageMetadata = (part) => {
    imagesComplete = false;
    const declared = part?.mimeType || part?.mime_type || part?.media_type || part?.source?.media_type || '';
    const mime = /^image\/(?:png|jpeg|gif|webp)$/.test(declared) ? declared : 'image/unknown';
    return { mime, available: false };
  };
  function parts(content, user = false) {
    const texts = [];
    const images = [];
    if (!Array.isArray(content)) {
      issues.add('unsupported_content');
      return { texts, images };
    }
    for (const part of content) {
      if (!part || typeof part !== 'object') { issues.add('unsupported_content'); continue; }
      if (['text', 'inputText', 'input_text'].includes(part.type)) {
        if (typeof part.text !== 'string') { issues.add('unsupported_content'); continue; }
        if (user && part.text.includes('<satr_conversation_history>')) issues.add('injected_history');
        texts.push(part.text);
      } else if (['image', 'localImage', 'inputImage', 'input_image'].includes(part.type)) {
        images.push(imageMetadata(part));
      } else if (user && (part.type === 'skill' || part.type === 'mention') && typeof part.name === 'string') {
        texts.push((part.type === 'skill' ? '/' : '@') + part.name);
      } else if (!user && part.type === 'resource' && typeof part.resource?.text === 'string') {
        texts.push(part.resource.text);
      } else {
        issues.add('unsupported_content');
      }
    }
    return { texts, images };
  }
  function statusFor(item) {
    const status = knownStatuses.has(item.status) ? item.status : 'unknown';
    if (!terminalStatuses.has(status)) issues.add('tool_not_completed');
    return status;
  }
  function toolResult(item, value) {
    const status = statusFor(item);
    messages.push({
      role: 'tool_result',
      text: 'حالة الأداة: ' + status + '\n' + value.texts.join('\n'),
      toolId: typeof item.id === 'string' ? item.id : '',
      isError: item.status === 'failed' || item.status === 'declined' || item.success === false
        || !!item.error || (Number.isInteger(item.exitCode) && item.exitCode !== 0),
      ...(value.images.length ? { images: value.images } : {}),
    });
  }
  if (!thread || !Array.isArray(thread.turns)) issues.add('unsupported_history');
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    if (!turn || !Array.isArray(turn.items)) { issues.add('unsupported_history'); continue; }
    if (turn.status !== 'completed') issues.add('turn_not_completed');
    for (const item of turn.items) {
      if (!item || typeof item !== 'object') { issues.add('unsupported_history_item'); continue; }
      if (item.type === 'userMessage') {
        const value = parts(item.content, true);
        if (value.texts.length || value.images.length) messages.push({
          role: 'user', text: value.texts.join('\n'), ...(value.images.length ? { images: value.images } : {}),
        });
      } else if (item.type === 'agentMessage') {
        if (typeof item.text !== 'string') issues.add('unsupported_content');
        else if (item.text) messages.push({ role: 'assistant', text: item.text });
      } else if (item.type === 'commandExecution') {
        if (item.aggregatedOutput != null && typeof item.aggregatedOutput !== 'string') issues.add('unsupported_content');
        toolResult(item, { texts: typeof item.aggregatedOutput === 'string' ? [item.aggregatedOutput] : [], images: [] });
      } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
        // لا JSON.stringify لنتيجة MCP الخام: قد تحمل data/base64 أو رموزاً في حقول غير نصية.
        const content = item.type === 'mcpToolCall' ? item.result?.content : item.contentItems;
        const value = content == null && !item.result && item.type === 'mcpToolCall'
          ? { texts: [], images: [] } : parts(content);
        if (item.result?.structuredContent != null) issues.add('structured_result_omitted');
        if (item.result && typeof item.result !== 'object') issues.add('unsupported_content');
        if (typeof item.error?.message === 'string') value.texts.push('خطأ الأداة: ' + item.error.message);
        else if (item.error != null) issues.add('unsupported_content');
        toolResult(item, value);
      } else if (item.type === 'fileChange') {
        const changes = [];
        if (!Array.isArray(item.changes)) issues.add('unsupported_content');
        else for (const change of item.changes) {
          if (!change || typeof change.path !== 'string') { issues.add('unsupported_content'); continue; }
          const value = { path: change.path };
          if (typeof change.kind === 'string') value.kind = change.kind;
          else if (typeof change.kind?.type === 'string') value.kind = change.kind.type;
          if (typeof change.kind?.movePath === 'string') value.movePath = change.kind.movePath;
          if (typeof change.diff === 'string') value.diff = change.diff;
          changes.push(value);
        }
        toolResult(item, { texts: [JSON.stringify({ changes })], images: [] });
      } else if (item.type === 'imageView') {
        messages.push({ role: 'tool_result', text: 'معاينة صورة سابقة؛ الصورة لم تنتقل.',
          toolId: typeof item.id === 'string' ? item.id : '', images: [imageMetadata({})] });
      } else if (!['reasoning', 'plan', 'webSearch', 'enteredReviewMode', 'exitedReviewMode'].includes(item.type)) {
        issues.add('unsupported_history_item');
      }
    }
  }
  return {
    cwd: typeof thread?.cwd === 'string' ? thread.cwd : '', total: messages.length, messages,
    coverage: { complete: issues.size === 0, scope: 'text', imagesComplete,
      issues: [...issues, ...(imagesComplete ? [] : ['images_metadata_only'])] },
  };
}


async function readCodexSession(id, options = {}) {
  if (!safeId(id)) return { error: 'bad_args' };
  try {
    const result = await rpc('thread/read', { threadId: id, includeTurns: true });
    const thread = result && result.thread;
    if (!thread || !Array.isArray(thread.turns)) return { error: 'not_found' };
    if (options.full) return continuityMessages(thread);
    const messages = [];
    for (const turn of thread.turns) {
      for (const item of Array.isArray(turn && turn.items) ? turn.items : []) {
        if (item.type === 'userMessage') {
          const text = userDisplayText(item.content);
          if (text) messages.push({ role: 'user', text });
        } else if (item.type === 'agentMessage' && item.text) {
          messages.push({ role: 'assistant', text: item.text });
        }
      }
    }
    return {
      cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
      total: messages.length,
      messages: messages.slice(-MAX_MESSAGES),
    };
  } catch {
    const legacy = await readCodexSessionLegacy(id);
    return options.full ? { ...legacy, coverage: { complete: false, issues: ['legacy_display_history'] } } : legacy;
  }
}

async function setCodexSessionName(id, name) {
  if (!safeId(id) || typeof name !== 'string' || name.length > 120) return { ok: false, error: 'bad_args' };
  try { await rpc('thread/name/set', { threadId: id, name: name.trim() }); return { ok: true }; }
  catch { return { ok: false, error: 'codex_unavailable' }; }
}

async function archiveCodexSession(id) {
  if (!safeId(id)) return { ok: false, error: 'bad_args' };
  try { await rpc('thread/archive', { threadId: id }); return { ok: true }; }
  catch { return { ok: false, error: 'codex_unavailable' }; }
}

async function deleteCodexSession(id) {
  if (!safeId(id)) return { ok: false, error: 'bad_args' };
  try { await rpc('thread/delete', { threadId: id }); return { ok: true }; }
  catch { return { ok: false, error: 'codex_unavailable' }; }
}

async function forkCodexSession(id) {
  if (!safeId(id)) return { ok: false, error: 'bad_args' };
  try {
    const result = await rpc('thread/fork', { threadId: id, excludeTurns: true });
    const threadId = result && result.thread && result.thread.id;
    return threadId && safeId(threadId) ? { ok: true, id: threadId } : { ok: false, error: 'invalid_response' };
  } catch { return { ok: false, error: 'codex_unavailable' }; }
}

module.exports = {
  listCodexSessions,
  readCodexSession,
  setCodexSessionName,
  archiveCodexSession,
  deleteCodexSession,
  forkCodexSession,
  // OBS-133: نقيّة بلا قرص ولا شبكة — يستهلكها `test:codexsessions` وحده كي يحرس
  // دعم صيغتَي السجلّ معاً. لا مستدعي لها في مسار الإنتاج خارج هذا الملف.
  sessionMessage,
  // OBS-153: نقيّة أيضاً — يحرسها الاختبار نفسه (عناوين الخيوط بلا حقن خام).
  cleanThreadTitle,
  // OBS-153: نصّ عرض المستخدم من thread/read بلا سياق محقون — حارسها الاختبار نفسه.
  userDisplayText,
  continuityMessages,
};
