/**
 * ذاكرة المحوّلات على القرص (الدفعة 1.3 من ROADMAP.md).
 *
 * محوّلات REST (Gemini/DeepSeek/Qwen…) بلا حالة — كانت تحفظ سجلّ المحادثة في خريطة
 * بالذاكرة تُمسح بإعادة التشغيل. هذا المخزن يحفظ السجلّ على القرص فتُستأنف المحادثة
 * بعد إعادة فتح «سطر».
 *
 * الشكل: ~/.satr/chats/<provider>/<session_id>.json — ملف لكل جلسة يحمل
 * {v, updated, history} حيث history بصيغة المحوّل **الأصلية** (OpenAI {role, content}
 * أو Gemini {role, parts}) — المخزن لا يفهم الصيغة، فقط يحفظها ويعيدها.
 * السجلّ مسقوف عند المحوّل (40 رسالة) فالملفات صغيرة وإعادة كتابتها كل دور رخيصة.
 *
 * 🔒 أمان: أسماء المزوّد والجلسة تُنقّى بـ regex صارم (مكوّن مسار واحد — لا فواصل
 * ولا ..). فشل القرص لا يكسر الدور: الحفظ/التحميل «أفضل جهد» والذاكرة الحيّة تكمل.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.satr', 'chats');
const SAFE_PROVIDER = /^[a-z0-9_-]{1,32}$/; // معرّف المزوّد (gemini/deepseek/…)
const SAFE_SESSION = /^[A-Za-z0-9-]{1,64}$/; // session_id (UUID نولّده نحن)
const MAX_SESSIONS = 50; // سقف الجلسات المحفوظة لكل مزوّد (تنظيف بالأقدم)
const MAX_FILE = 1024 * 1024; // سقف قراءة ملف جلسة (حماية من ملف معطوب/منتفخ)

function fileFor(provider, sid) {
  if (!SAFE_PROVIDER.test(provider || '') || !SAFE_SESSION.test(sid || '')) return null;
  return path.join(ROOT, provider, sid + '.json');
}

// تحميل سجلّ جلسة من القرص — null إن غاب أو تعذّرت قراءته (المحوّل يبدأ جلسة جديدة)
function load(provider, sid) {
  const file = fileFor(provider, sid);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j && Array.isArray(j.history)) ? j.history : null;
  } catch {
    return null;
  }
}

// مؤشر «آخر جلسة» لكل مزوّد — على القرص لا في localStorage (ثبت أن localStorage
// قد لا يُفلَش للقرص فيضيع المؤشر ويفشل الاستئناف — درس اختبار 1.3)
const LAST_FILE = 'last.txt';

// حفظ سجلّ جلسة — أفضل جهد (فشل الكتابة لا يُسقط الدور) + تنظيف الأقدم فوق السقف
function save(provider, sid, history) {
  const file = fileFor(provider, sid);
  if (!file || !Array.isArray(history)) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const isNew = !fs.existsSync(file);
    fs.writeFileSync(file, JSON.stringify({ v: 1, updated: Date.now(), history }));
    fs.writeFileSync(path.join(dir, LAST_FILE), sid); // مؤشر الاستئناف
    if (isNew) prune(dir);
  } catch { /* أفضل جهد */ }
}

// آخر جلسة محفوظة لمزوّد — null إن غابت أو حُذف ملفها (بالتنظيف مثلاً)
function last(provider) {
  if (!SAFE_PROVIDER.test(provider || '')) return null;
  try {
    const dir = path.join(ROOT, provider);
    const sid = fs.readFileSync(path.join(dir, LAST_FILE), 'utf8').trim();
    if (!SAFE_SESSION.test(sid)) return null;
    return fs.existsSync(path.join(dir, sid + '.json')) ? sid : null;
  } catch {
    return null;
  }
}

// نسيان مؤشر الاستئناف («جلسة جديدة» في الواجهة) — ملفات السجلّ تبقى للتنظيف بالأقدم
function forget(provider) {
  if (!SAFE_PROVIDER.test(provider || '')) return;
  try { fs.unlinkSync(path.join(ROOT, provider, LAST_FILE)); } catch { /* أفضل جهد */ }
}

// ---------- تصفح المحادثات في لوحة الجلسات (الدفعة 4 — قراءة فقط) ----------

// نص رسالة واحدة بأي من الصيغتين: OpenAI (content نص) أو Gemini (parts[].text).
// رسائل الأدوات (tool/functionCall/functionResponse) تُعيد '' فتُتخطى في العرض.
function textOfMsg(m) {
  if (!m || typeof m !== 'object') return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.parts)) {
    return m.parts.map((p) => (p && typeof p.text === 'string') ? p.text : '').filter(Boolean).join('\n');
  }
  return '';
}

// رسالة مستخدم مرّت بحقن @الملفات (inject.js) تبدأ بترويسة الملفات ثم فاصل ---
// ثم طلب المستخدم الأصلي — للعرض والعنوان نفكّها ونعيد الطلب وحده (المحتوى المحقون ضجيج)
const INJECT_HEADER = 'ملفات مرفقة من مشروع المستخدم';
function unwrapInjected(t) {
  if (!t.startsWith(INJECT_HEADER)) return t;
  const idx = t.lastIndexOf('\n---\n');
  return idx === -1 ? t : t.slice(idx + 5).trim();
}

// عنوان قصير من أول رسالة مستخدم (السطر الأول، ≤ 80 حرفاً)
function titleOf(history) {
  if (!Array.isArray(history)) return '';
  for (const m of history) {
    if (m && m.role === 'user') {
      const t = unwrapInjected(textOfMsg(m).trim());
      if (t) return t.split('\n')[0].slice(0, 80);
    }
  }
  return '';
}

// كل محادثات كل المزوّدين، الأحدث أولاً — [{provider, id, title, mtime}].
// الملفات صغيرة (السجلّ مسقوف عند المحوّل) والعدد ≤ MAX_SESSIONS لكل مزوّد،
// فقراءتها لاستخراج العناوين رخيصة (تحدث عند فتح اللوحة فقط).
function list() {
  const out = [];
  let provs = [];
  try { provs = fs.readdirSync(ROOT).filter((n) => SAFE_PROVIDER.test(n)); } catch { return []; }
  for (const provider of provs) {
    const dir = path.join(ROOT, provider);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const n of names) {
      const sid = n.slice(0, -5);
      if (!SAFE_SESSION.test(sid)) continue;
      try {
        const st = fs.statSync(path.join(dir, n));
        if (!st.isFile() || st.size > MAX_FILE) continue;
        out.push({ provider, id: sid, mtime: st.mtimeMs, title: titleOf(load(provider, sid)) || '(محادثة بلا عنوان)' });
      } catch { /* ملف معطوب — يُتخطى */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// محادثة واحدة مهيأة للعرض: آخر 40 رسالة نصية {role: user|assistant, text}
// (رسائل الأدوات تُتخطى — العرض للتصفح لا لإعادة بناء الحلقة)
function read(provider, sid) {
  const h = load(provider, sid);
  if (!h) return { ok: false, error: 'notfound' };
  const messages = [];
  for (const m of h) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'model')) continue;
    let text = textOfMsg(m).trim();
    if (m.role === 'user') text = unwrapInjected(text);
    if (text) messages.push({ role: m.role === 'user' ? 'user' : 'assistant', text });
  }
  return { ok: true, total: messages.length, messages: messages.slice(-40) };
}

// إبقاء أحدث MAX_SESSIONS ملفاً في مجلد المزوّد (الأقدم بوقت التعديل يُحذف)
function prune(dir) {
  try {
    const entries = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const p = path.join(dir, n);
        try { return { p, t: fs.statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    for (const e of entries.slice(MAX_SESSIONS)) {
      try { fs.unlinkSync(e.p); } catch { /* أفضل جهد */ }
    }
  } catch { /* أفضل جهد */ }
}

module.exports = { load, save, last, forget, list, read, MAX_SESSIONS };
