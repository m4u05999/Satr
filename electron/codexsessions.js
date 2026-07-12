/**
 * سطر 2.0 — قراءة جلسات Codex المحفوظة محلياً (قراءة فقط) — تلميع المرحلة 4
 * المصدر: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<thread-id>.jsonl
 * كل سطر JSON مستقل. الأنواع المهمة:
 *  - session_meta (السطر الأول): payload.session_id / cwd / timestamp
 *  - event_msg من نوع user_message (نصّ المستخدم النظيف) و agent_message (رد المساعد)
 * (نتجاهل response_item لأنها تحمل السياق المحقون <recommended_plugins>/<permissions>…)
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

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

// نصّ رسالة من سطر event_msg (user_message/agent_message) أو null
function eventMessage(e) {
  if (!e || e.type !== 'event_msg' || !e.payload) return null;
  const p = e.payload;
  if (p.type === 'user_message' && typeof p.message === 'string') {
    const t = p.message.trim();
    // نتخطّى نصوصاً محقونة نادرة تبدأ بوسم زاوية (سياق لا رسالة)
    if (!t || t.startsWith('<')) return null;
    return { role: 'user', text: t };
  }
  if (p.type === 'agent_message' && typeof p.message === 'string') {
    const t = p.message.trim();
    if (!t) return null;
    return { role: 'assistant', text: t };
  }
  return null;
}

// قائمة جلسات Codex، الأحدث أولاً — رأس كل ملف فقط لالتقاط العنوان والـ cwd
async function listCodexSessions() {
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
        const m = eventMessage(e);
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
async function readCodexSession(id) {
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
    const m = eventMessage(e);
    if (m) messages.push(m);
  }
  return { cwd, total: messages.length, messages: messages.slice(-MAX_MESSAGES) };
}

module.exports = { listCodexSessions, readCodexSession };
