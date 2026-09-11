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
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;  // عند بناء القائمة نقرأ رأس الملف فقط (العنوان يظهر مبكراً)
// سقف السرد. **رُفع من 100 بعد قياس، لا تقديراً** (‏OBS-068، 2026-09-02):
//
// العطل المُبلَّغ: «أبحث عن جلسة مشروع سابق فأتوه». والسبب أن السقف كان يقصّ الأرشيف
// **قبل** أن يصل شيء إلى الواجهة، وحقل البحث في اللوحة يرشّح المحمَّل فقط — أي أنه
// بحثٌ في نافذة لا في أرشيف. على جهاز المالك: 156 ملفاً (143 بمحادثة) والمعروض 100،
// فأقدم ما يُرى قبل 17 يوماً بينما على القرص جلسات عمرها 26 يوماً. فما يبحث عنه
// المستخدم قد لا يكون في مجموعة البحث أصلاً، واللوحة تقول «لا نتائج».
//
// وكلفة رفعه **مقيسة**: مسح الأرشيف كاملاً بقراءة رأس 64ك.ب لكل ملف = **62ms**
// لـ156 ملفاً (‏337ms أول مرة بكاش بارد). أي أن السقف كان يحمي من كلفة غير موجودة.
// و1000 تُبقي أسوأ حالة عند ~0.4ث بنفس المعدّل، وتظل حاجزاً ضد أرشيف شاذ.
//
// ولا تُقلَّل `HEAD_BYTES`: قياس المقارنة أعطى 16ك.ب ⇒ 125/156 التقاطاً مقابل
// 64ك.ب ⇒ 143/156، والفرق ملفات عنوانها متأخر — التوفير 10ms والخسارة 18 جلسة.
const MAX_SESSIONS = 1000;
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

// بناء رسائل العرض من نص jsonl خام — مشترك بين readSession (لوحة الجلسات)
// و readFullSession (التصدير 4.8)
function buildMessages(raw) {
  const messages = [];
  let cwd = '';
  for (const e of parseLines(raw)) {
    // **أول** cwd لا آخره — وهذا إصلاح عطل مقيس (‏2026-08-30، بلاغ مالك بلقطة):
    //
    // أداة Bash في Claude Code تملك صدفة معمّرة، فحين ينتقل الوكيل بـ`cd` إلى مجلد
    // فرعي يسجّل CLI المجلد الجديد في كل سطر تالٍ. قياس على جلسة حقيقية: انزاح `cwd`
    // **37 مرة** داخل جلسة واحدة، وآخر قيمة كانت `D:\alulama\packages\erp-poc` بينما
    // الجلسة بدأت في `D:\alulama`.
    //
    // وكان هذا السطر يأخذ الأخير بحجّة «الأحدث» — وهي جملة صحيحة عن **الصدفة**
    // وخاطئة عن **المشروع**. فيستأنف المستخدم جلسته، فتكتب `app.js` القيمة المنزاحة
    // في حقل المجلد و`localStorage`، فيتغيّر مجلد عمله صامتاً ويبقى بعد إعادة التشغيل،
    // وتُولد كل جلسة تالية في المجلد الخطأ — وتصنع «مشروعاً» وهمياً في الأرشيف.
    //
    // مجلد المشروع هو حيث **بدأت** الجلسة: ثابتٌ، وهو ما يعتمده `listSessions` (السطر
    // 104) وما يسمّي به Claude Code مجلد الأرشيف نفسه. فالقاعدتان تتفقان الآن.
    if (!cwd && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
    const u = userText(e);
    if (u !== null) {
      const message = { role: 'user', text: u };
      if (typeof e.uuid === 'string' && SAFE_UUID.test(e.uuid)) message.messageId = e.uuid;
      messages.push(message);
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
  return { cwd, messages };
}

// قراءة جلسة واحدة: cwd الخاص بها + آخر رسائلها مهيأة للعرض
async function readSession(project, id) {
  if (!safeName(project) || !safeName(id)) return { error: 'bad_args' };
  const file = path.join(PROJECTS_ROOT, project, id + '.jsonl');
  // حزام أمان إضافي فوق safeName: المسار النهائي يجب أن يبقى داخل مجلد الجلسات
  if (!file.startsWith(PROJECTS_ROOT + path.sep)) return { error: 'bad_args' };

  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return { error: 'not_found' }; }

  const { cwd, messages } = buildMessages(raw);
  return { cwd, total: messages.length, messages: messages.slice(-MAX_MESSAGES) };
}

// قراءة جلسة **كاملة** بمعرّفها وحده (التصدير 4.8): المعرّف UUID فريد عبر المشاريع،
// فمسح مجلدات المشاريع عنه يغني عن إعادة اشتقاق ترميز اسم المجلد من cwd (هشّ).
// بلا سقف الـ40 الخاص بالعرض — التصدير يريد المحادثة كلها.
async function readFullSession(id) {
  if (!safeName(id)) return { error: 'bad_args' };
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_ROOT, { withFileTypes: true }); } catch { return { error: 'not_found' }; }
  for (const d of dirs) {
    if (!d.isDirectory() || !safeName(d.name)) continue;
    const file = path.join(PROJECTS_ROOT, d.name, id + '.jsonl');
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; } // ليس في هذا المشروع
    const { cwd, messages } = buildMessages(raw);
    return { cwd, messages };
  }
  return { error: 'not_found' };
}

// `buildMessages` مُصدَّرة للحارس وحده (‏دالة نقية فوق نصّ jsonl خام): تثبّت أن
// «مجلد المشروع» هو أول cwd لا آخره — انظر تعليقها أعلاه.

// قارئ النقل يقرأ المصدر كله، ويفصل نتائج الأدوات عن أقوال المستخدم بلا قصّ للذيل.
function buildContinuityMessages(raw) {
  const messages = [];
  const issues = new Set();
  const seen = new Set();
  let cwd = '';
  let imagesComplete = true;
  const imageMetadata = (block) => ({
    mime: /^image\/(?:png|jpeg|gif|webp)$/.test(block?.source?.media_type || block?.mimeType || '')
      ? (block.source?.media_type || block.mimeType) : 'image/unknown',
    available: false,
  });
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { issues.add('invalid_jsonl'); continue; }
    if (!entry || typeof entry !== 'object') { issues.add('invalid_jsonl'); continue; }
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
    if (entry.isSidechain || entry.isMeta || !['user', 'assistant'].includes(entry.type)) continue;
    if (entry.isCompactSummary) { issues.add('summary_only'); continue; }
    const key = typeof entry.uuid === 'string' && SAFE_UUID.test(entry.uuid) ? entry.type + ':' + entry.uuid : '';
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const content = entry.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) { issues.add('unknown_content'); continue; }
    let texts = [];
    let images = [];
    const flush = () => {
      if (texts.length || images.length) {
        messages.push({ role: entry.type, text: texts.join('\n'), ...(images.length ? { images } : {}) });
        texts = [];
        images = [];
      }
    };
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (block.text.includes('<satr_conversation_history>')) issues.add('injected_history');
        texts.push(block.text);
      } else if (block?.type === 'image') {
        imagesComplete = false;
        images.push(imageMetadata(block));
      } else if (block?.type === 'tool_result' && entry.type === 'user') {
        flush();
        const resultBlocks = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content;
        const resultTexts = [];
        const resultImages = [];
        if (Array.isArray(resultBlocks)) for (const result of resultBlocks) {
          if (result?.type === 'text' && typeof result.text === 'string') resultTexts.push(result.text);
          else if (result?.type === 'image') { imagesComplete = false; resultImages.push(imageMetadata(result)); }
          else issues.add('unknown_content');
        }
        else if (block.content != null) issues.add('unknown_content');
        messages.push({
          role: 'tool_result', text: resultTexts.join('\n'),
          toolId: typeof block.tool_use_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(block.tool_use_id) ? block.tool_use_id : '',
          isError: !!block.is_error, ...(resultImages.length ? { images: resultImages } : {}),
        });
      } else if (entry.type === 'assistant' && ['tool_use', 'thinking', 'redacted_thinking'].includes(block?.type)) {
        // مدخلات الأدوات والتفكير ليست نص محادثة مستخدم ولا تُستورد إلى قناة النقل.
      } else issues.add('unknown_content');
    }
    flush();
  }
  return { cwd, messages, coverage: {
    complete: issues.size === 0, scope: 'text', imagesComplete,
    issues: [...issues, ...(imagesComplete ? [] : ['images_metadata_only'])],
  } };
}

async function readContinuitySession(id, options = {}) {
  if (typeof id !== 'string' || !SAFE_UUID.test(id)) return { error: 'bad_args' };
  const root = path.resolve(options.root || PROJECTS_ROOT);
  let realRoot;
  let dirs;
  try {
    realRoot = await fsp.realpath(root);
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch (_) { return { error: 'not_found' }; }
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  let found = null;
  for (const dir of dirs) {
    if (!dir.isDirectory() || !safeName(dir.name)) continue;
    const file = path.join(root, dir.name, id + '.jsonl');
    let stat;
    let realFile;
    try {
      stat = await fsp.lstat(file);
      realFile = await fsp.realpath(file);
    } catch (_) { continue; }
    if (stat.isSymbolicLink() || !stat.isFile() || !normalize(realFile).startsWith(normalize(realRoot) + path.sep)) {
      return { error: 'unsafe_source_path' };
    }
    // الحد على الملف كله معلن، فلا يُعاد ذيل ناقص وكأنه المصدر الكامل.
    if (stat.size > 64 * 1024 * 1024) return { error: 'source_too_large' };
    if (found) return { error: 'ambiguous_session' };
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch (_) { return { error: 'source_unavailable' }; }
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024 * 1024) return { error: 'source_too_large' };
    found = buildContinuityMessages(raw);
  }
  return found || { error: 'not_found' };
}

module.exports = { listSessions, readSession, readFullSession, buildMessages, readContinuitySession, buildContinuityMessages };
