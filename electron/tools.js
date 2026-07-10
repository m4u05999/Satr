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

const files = require('./files');

const MAX_RESULT = 48 * 1024; // سقف نتيجة الأداة (محارف) — حماية سياق النموذج
const MAX_LIST = 1500;        // سقف أسطر list_files

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
];

function defs() { return DEFS; }

// ترجمة أخطاء readText لنص عربي يفهمه النموذج (ويشرحه للمستخدم عند الحاجة)
const READ_ERRORS = {
  outside: 'المسار خارج مجلد المشروع — مسموح فقط بمسارات نسبية داخله',
  notfound: 'الملف غير موجود — استخدم list_files لمعرفة المسارات الصحيحة',
  binary: 'ملف ثنائي — لا يمكن قراءته نصاً',
  error: 'تعذّرت قراءة الملف',
};

/**
 * تنفيذ أداة باسمها — يعيد دائماً { ok, content } والمحتوى نص يُعاد للنموذج
 * (الفشل نص خطأ عربي، لا استثناء — النموذج يصحح مساره بنفسه).
 */
async function run(name, cwd, args) {
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
    return { ok: false, content: 'خطأ: أداة غير معروفة: ' + String(name) };
  } catch (e) {
    return { ok: false, content: 'خطأ: ' + String((e && e.message) || e) };
  }
}

module.exports = { defs, run, MAX_RESULT };
