/**
 * سطر 2.0 — قراءة جلسات Claude Code المحفوظة محلياً (قراءة فقط)
 * المصدر: ~/.claude/projects/<مجلد-لكل-مشروع>/<session-id>.jsonl
 * كل سطر في الملف JSON مستقل؛ الأنواع المهمة لنا: user / assistant / ai-title
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const SAFE_NAME = /^[A-Za-z0-9._-]{1,180}$/; // مكوّن مسار واحد — بلا فواصل مسار إطلاقاً
const HEAD_BYTES = 64 * 1024;  // عند بناء القائمة نقرأ رأس الملف فقط (العنوان يظهر مبكراً)
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 40;       // أقصى عدد رسائل تُعاد عند فتح جلسة للعرض

// التحقق من اسم مكوّن مسار: يمنع أي خروج عن مجلد الجلسات (لا فواصل ولا "..")
function safeName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

// نص رسالة المستخدم الفعلية من سطر jsonl، أو null إن كان سطراً داخلياً
// (نتائج أدوات، أسطر أوامر <command-name>، تنبيهات Caveat، مهام جانبية)
function userText(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || !entry.message) return null;
  const c = entry.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
  }
  text = text.trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return null;
  return text;
}

// أجزاء رد المساعد: النصوص + أسماء الأدوات المستخدمة، أو null إن لا شيء يُعرض
function assistantParts(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain || !entry.message || !Array.isArray(entry.message.content)) return null;
  const texts = [];
  const tools = [];
  for (const b of entry.message.content) {
    if (b && b.type === 'text' && b.text && b.text.trim()) texts.push(b.text);
    else if (b && b.type === 'tool_use' && b.name) tools.push(b.name);
  }
  if (!texts.length && !tools.length) return null;
  return { text: texts.join('\n\n'), tools };
}

function parseLines(chunk) {
  const out = [];
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* سطر مبتور أو تالف — نتجاهله */ }
  }
  return out;
}

// قائمة الجلسات عبر كل المشاريع، الأحدث أولاً
async function listSessions() {
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_ROOT, { withFileTypes: true }); } catch { return []; }

  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !safeName(d.name)) continue;
    let names = [];
    try { names = await fsp.readdir(path.join(PROJECTS_ROOT, d.name)); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      if (!safeName(id)) continue;
      files.push({ project: d.name, id, file: path.join(PROJECTS_ROOT, d.name, f) });
    }
  }

  // الترتيب بوقت آخر تعديل، ثم قراءة رأس الملف للأحدث فقط
  const stats = await Promise.all(files.map(async (f) => {
    try {
      const s = await fsp.stat(f.file);
      return { ...f, mtime: s.mtimeMs, size: s.size };
    } catch { return null; }
  }));
  const recent = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);

  const sessions = [];
  for (const f of recent) {
    let head = '';
    let fh = null;
    try {
      fh = await fsp.open(f.file, 'r');
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, f.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, bytesRead);
    } catch { continue; }
    finally { if (fh) await fh.close().catch(() => {}); }

    let title = '';
    let aiTitle = '';
    let cwd = '';
    for (const e of parseLines(head)) {
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (!aiTitle && e.type === 'ai-title' && typeof e.aiTitle === 'string') aiTitle = e.aiTitle;
      if (!title) {
        const t = userText(e);
        if (t) title = t;
      }
      if (title && cwd) break;
    }
    if (!title && !aiTitle) continue; // جلسة بلا محادثة فعلية — لا تُعرض
    sessions.push({
      id: f.id,
      project: f.project,
      cwd,
      title: (title || aiTitle).replace(/\s+/g, ' ').slice(0, 90),
      mtime: f.mtime,
      size: f.size,
    });
  }
  return sessions;
}

// قراءة جلسة واحدة: cwd الخاص بها + آخر رسائلها مهيأة للعرض
async function readSession(project, id) {
  if (!safeName(project) || !safeName(id)) return { error: 'bad_args' };
  const file = path.join(PROJECTS_ROOT, project, id + '.jsonl');
  // حزام أمان إضافي فوق safeName: المسار النهائي يجب أن يبقى داخل مجلد الجلسات
  if (!file.startsWith(PROJECTS_ROOT + path.sep)) return { error: 'bad_args' };

  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return { error: 'not_found' }; }

  const messages = [];
  let cwd = '';
  for (const e of parseLines(raw)) {
    if (typeof e.cwd === 'string' && e.cwd) cwd = e.cwd; // آخر cwd في الملف هو الأحدث
    const u = userText(e);
    if (u !== null) {
      messages.push({ role: 'user', text: u });
      continue;
    }
    const a = assistantParts(e);
    if (a) {
      // ردود المساعد المتتالية (نص ثم أدوات ثم نص…) تُدمج في رسالة واحدة للعرض
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        if (a.text) last.text += (last.text ? '\n\n' : '') + a.text;
        last.tools.push(...a.tools);
      } else {
        messages.push({ role: 'assistant', text: a.text, tools: a.tools });
      }
    }
  }
  return { cwd, total: messages.length, messages: messages.slice(-MAX_MESSAGES) };
}

module.exports = { listSessions, readSession };
