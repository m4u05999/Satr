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
 * ويبقى ترشيح السياق لازماً — لكنه على **الرسالة كاملةً** لأن الحقن يأتي رسالةً
 * منفصلة لا ملتصقاً بنصّ المستخدم: من 101 رسالة `user` كانت 92 سياقاً يبدأ بوسم
 * زاوية (`<recommended_plugins>` من Codex · `<satr_project_memory>` منّا · `<skill>`)
 * والتسع الباقيات رسائل المستخدم الفعلية بلا وسم.
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
    if (p.role === 'user') return userLine(contentText(p.content));
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

async function rpc(method, params) {
  const bin = codexBin();
  if (!bin) throw new Error('codex_unavailable');
  return queryCodex(bin, method, params, { timeoutMs: 10000 });
}

function userInputText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (!item) return '';
    if (item.type === 'text') return item.text || '';
    if (item.type === 'skill') return '/' + (item.name || 'skill');
    if (item.type === 'mention') return '@' + (item.name || 'file');
    if (item.type === 'image' || item.type === 'localImage') return '[صورة]';
    return '';
  }).filter(Boolean).join(' ').trim();
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
      title: String(thread.name || thread.preview || 'جلسة Codex').replace(/\s+/g, ' ').slice(0, 90),
      mtime: (Number(thread.recencyAt || thread.updatedAt || thread.createdAt) || 0) * 1000,
      size: 0,
      status: typeof thread.status === 'string' ? thread.status : null,
    }));
  } catch {
    return listCodexSessionsLegacy();
  }
}

async function readCodexSession(id) {
  if (!safeId(id)) return { error: 'bad_args' };
  try {
    const result = await rpc('thread/read', { threadId: id, includeTurns: true });
    const thread = result && result.thread;
    if (!thread || !Array.isArray(thread.turns)) return { error: 'not_found' };
    const messages = [];
    for (const turn of thread.turns) {
      for (const item of Array.isArray(turn && turn.items) ? turn.items : []) {
        if (item.type === 'userMessage') {
          const text = userInputText(item.content);
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
    return readCodexSessionLegacy(id);
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
};
