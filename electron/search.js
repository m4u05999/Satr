/**
 * سطر 2.0 — بحث محتوى المشروع «الدلالي الخفيف» (الدفعة 4.6 من ROADMAP)
 *
 * بحث معجمي ذكي بلا فهرس دائم وبلا اعتماديات — فهرسة embeddings العميقة خارج
 * التموضع (قرار ROADMAP المعتمد). المسح عند الطلب فوق files.listFiles القائمة
 * (سقف 6000 ملف + تجاهل المجلدات الثقيلة) والقراءة عبر files.readText المؤمَّنة
 * (داخل cwd حصراً، رفض الثنائي، سقف 256ك.ب) — لا مسار قراءة جديداً.
 *
 * «الدلالية الخفيفة»:
 * - تطبيع عربي للمطابقة: حذف التشكيل والتطويل، توحيد أ/إ/آ→ا و ة→ه و ى→ي —
 *   «مُعالَجة» تطابق «معالجه». التطبيع لا يغيّر النص المعروض (المقتطف أصلي).
 * - مطابقة جزئية (substring) بعد خفض الحالة — «save viewer» يصيب saveFromViewer
 *   و viewer_save (تفكيك camelCase/snake_case يأتي مجاناً من دلالة الجزئية).
 * - استعلام متعدد الكلمات يرتَّب بالنقاط: تطابق المسار أثقل من السطر، سطر يجمع
 *   كلمات أكثر أعلى، وملف يحوي كل الكلمات يقفز — مع سقف نقاط للمحتوى لئلا
 *   يطغى ملف يكرر كلمة شائعة آلاف المرات.
 *
 * يستهلكه طرفان بعقد واحد:
 * - أداة search_code للمحوّلات العمياء (tools.js — قراءة بلا إذن، نمط Grep).
 * - حقل بحث لوحة 📄 في الواجهة (IPC ‏satr:searchFiles — قراءة فقط).
 */

const files = require('./files');

const TIME_BUDGET = 2000;     // ميزانية المسح (مللي ثانية) — الأطول يعود جزئياً
const MAX_TERMS = 8;          // سقف كلمات الاستعلام
const MIN_TERM = 2;           // أقصر كلمة تُعتبر (حرفان)
const MAX_HITS_PER_FILE = 5;  // مقتطفات لكل ملف (الأولى فالأولى — أوضح للقراءة)
const MAX_FILES_OUT = 20;     // سقف الملفات في النتيجة النهائية
const EXCERPT_LEN = 200;      // قصّ سطر المقتطف (سطور minified العملاقة)
const PATH_WEIGHT = 3;        // نقاط تطابق كلمة في المسار
const ALL_TERMS_BONUS = 8;    // مكافأة ملف يحوي كل كلمات الاستعلام
const CONTENT_SCORE_CAP = 30; // سقف نقاط المحتوى لكل ملف (ضد طغيان التكرار)

// تطبيع للمطابقة فقط: خفض حالة + حذف التشكيل/الألف الخنجرية/التطويل + توحيد الحروف
// المتشابهة. لا يمس \n فأرقام الأسطر تبقى صحيحة عند التطبيع الكلي ثم التقسيم.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

// تفكيك الاستعلام لكلمات مطبَّعة (فواصل: مسافات وترقيم شائع)
function queryTerms(query) {
  return normalize(query)
    .split(/[\s,;:"'`()[\]{}<>|=+*/\\!?،؛]+/)
    .filter((t) => t.length >= MIN_TERM)
    .slice(0, MAX_TERMS);
}

/**
 * البحث في مشروع: يعيد {ok, hits:[{rel, line, text}], files, scanned, total, partial}
 * hits مرتبة: الملف الأعلى نقاطاً أولاً، وداخل الملف بترتيب الأسطر. line=0 يعني
 * تطابقاً في اسم الملف فقط (ثنائي/ضخم لا يُقرأ محتواه).
 */
async function search(cwd, query) {
  const terms = queryTerms(query);
  if (!terms.length) return { ok: false, error: 'bad_query' };
  const list = await files.listFiles(cwd);
  const started = Date.now();
  const scored = [];
  let scanned = 0;
  let partial = false;

  for (const rel of list) {
    if (Date.now() - started > TIME_BUDGET) { partial = true; break; }
    scanned++;
    const nrel = normalize(rel);
    const found = new Set();
    let score = 0;
    for (const t of terms) if (nrel.includes(t)) { found.add(t); score += PATH_WEIGHT; }

    const hits = [];
    const r = files.readText(cwd, rel);
    if (r.ok) {
      // تطبيع المحتوى مرة واحدة (أرخص من سطرٍ سطراً) — \n محفوظ فالفهارس تتطابق
      const orig = r.content.split('\n');
      const norm = normalize(r.content).split('\n');
      let contentScore = 0;
      for (let i = 0; i < norm.length; i++) {
        let n = 0;
        for (const t of terms) if (norm[i].includes(t)) { n++; found.add(t); }
        if (n > 0) {
          contentScore += n;
          if (hits.length < MAX_HITS_PER_FILE) {
            hits.push({ line: i + 1, text: orig[i].replace(/\r$/, '').trim().slice(0, EXCERPT_LEN) });
          }
        }
      }
      score += Math.min(contentScore, CONTENT_SCORE_CAP);
    } else if (found.size) {
      // ثنائي/ضخم/غير مقروء لكن مساره يطابق — نتيجة مسار فقط
      hits.push({ line: 0, text: '(تطابق في اسم الملف)' });
    }
    if (found.size === terms.length && terms.length > 1) score += ALL_TERMS_BONUS;
    if (score > 0 && hits.length) scored.push({ rel, score, hits });
  }

  scored.sort((a, b) => b.score - a.score);
  const flat = [];
  for (const f of scored.slice(0, MAX_FILES_OUT)) {
    for (const h of f.hits) flat.push({ rel: f.rel, line: h.line, text: h.text });
  }
  return { ok: true, hits: flat, files: scored.length, scanned, total: list.length, partial };
}

module.exports = { search, normalize, queryTerms };
