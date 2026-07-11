/**
 * سطر 2.0 — تصدير المحادثة إلى Markdown (الدفعة 4.8 «مشاركة») — قراءة فقط
 *
 * القرص مصدر الحقيقة للمحرّكين (لا استخراج من DOM — هشّ): جلسات كلود عبر
 * sessions.readFullSession (تحديد الملف بمعرّف الجلسة UUID — لا اشتقاق ترميز
 * اسم مجلد المشروع من cwd)، ومحادثات المحوّلات عبر chats.read بلا سقف العرض.
 *
 * الناتج Markdown خام: ترويسة وصفية ثم «👤 المستخدم / 🤖 النموذج» بالتناوب،
 * وأدوات المساعد سطر اقتباس موجز. نص النموذج Markdown أصلاً فيُمرَّر كما هو.
 * الحفظ نفسه في الواجهة (Blob + تنزيل) — لا مسار كتابة جديداً في العملية الرئيسية.
 */

const sessions = require('./sessions');
const chats = require('./chats');

const MAX_MD = 2 * 1024 * 1024; // سقف حجم التصدير (2م.ب نص)

const pad = (n) => String(n).padStart(2, '0');

/**
 * تصدير محادثة: {ok, markdown, filename, messages, truncated} أو
 * {ok:false, error: notfound|empty|error}
 * عائلة claude (sdk/cli) تتشارك جلسات القرص نفسها؛ غيرها مزوّد محوّل.
 */
async function toMarkdown({ engine, sessionId, cwd }) {
  let msgs;
  let realCwd = cwd || '';
  if (engine === 'sdk' || engine === 'cli') {
    const r = await sessions.readFullSession(sessionId);
    if (r.error) return { ok: false, error: 'notfound' };
    msgs = r.messages;
    if (r.cwd) realCwd = r.cwd;
  } else {
    const r = chats.read(engine, sessionId, 0); // cap=0: المحادثة كاملة
    if (!r.ok) return { ok: false, error: 'notfound' };
    msgs = r.messages;
  }
  if (!msgs || !msgs.length) return { ok: false, error: 'empty' };

  const now = new Date();
  const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const lines = [
    '# محادثة «سطر»',
    '',
    '- التاريخ: ' + stamp,
  ];
  if (realCwd) lines.push('- المشروع: `' + realCwd + '`');
  lines.push('- المحرك: ' + engine, '- الجلسة: `' + sessionId + '`', '', '---', '');

  for (const m of msgs) {
    lines.push(m.role === 'user' ? '## 👤 المستخدم' : '## 🤖 النموذج', '');
    if (m.tools && m.tools.length) lines.push('> 🔧 الأدوات: ' + m.tools.join('، '), '');
    if (m.text) lines.push(m.text, '');
  }

  let markdown = lines.join('\n');
  let truncated = false;
  if (markdown.length > MAX_MD) {
    markdown = markdown.slice(0, MAX_MD) + '\n\n…(قُصّ التصدير — تجاوز سقف 2م.ب)';
    truncated = true;
  }
  const filename = 'satr-chat-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.md';
  return { ok: true, markdown, filename, messages: msgs.length, truncated };
}

module.exports = { toMarkdown };
