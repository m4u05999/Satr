'use strict';
/**
 * كتل «سطر» المحقونة في نصّ المستخدم قبل إرساله إلى المحرّك — وحدة نقية بلا Electron ولا قرص.
 *
 * العلّة (مذكور منفّذ الدفعة ب، 2026-09-15): سطر يُسبق رسالة المستخدم بكتل موسومة
 * (`<satr_turn_context>` سياق الدور OBS-194 · `<satr_verification_result>` نتيجة التحقق ·
 * `<satr_lang>` مرساة اللغة · `<satr_project_memory>` الذاكرة · `<satr_context_budget>` ·
 * `<satr_testsprite_run>`) فتُحفظ في jsonl الجلسة داخل نصّ المستخدم، وكان قارئ الجلسات
 * يمرّرها خامّةً للعرض ولنقل المحادثة بين المحركات. هذه الوحدة المصدر الواحد لقائمة الوسوم
 * ونزعها؛ `codexsessions.js` و`kimi.js` لهما نزعٌ خاص بأغلفة محرّكيهما ولم يُوحَّدا هنا (حدّ
 * مُصرَّح به).
 *
 * `<satr_conversation_history>` ليست هنا عمداً: وجودها في جلسة **علامة حقن** يعلنها القارئ
 * (`injected_history`) لا كتلة تُنزع بصمت.
 */

const TAGS = [
  'satr_turn_context',
  'satr_verification_result',
  'satr_lang',
  'satr_project_memory',
  'satr_context_budget',
  'satr_testsprite_run',
];

const TAG_GROUP = '(' + TAGS.join('|') + ')';
// كتلة مغلقة: وسم فتح (بسمات اختيارية) … وسم إغلاق مطابق، مع الفراغ الذي يليها.
const CLOSED_BLOCK_RE = new RegExp('<' + TAG_GROUP + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>\\s*', 'gi');
// كتلة غير مغلقة (نصّ مقصوص): من وسم الفتح إلى نهاية النصّ.
const OPEN_TAIL_RE = new RegExp('<' + TAG_GROUP + '(?:\\s[^>]*)?>[\\s\\S]*$', 'i');

/**
 * ينزع كتل سطر من نصّ مستخدم. يعيد `{ text, stripped }` حيث `stripped` أسماء الوسوم
 * المنزوعة (بلا تكرار) — فارغة حين لا كتلة، والنصّ عندها كما هو حرفياً.
 */
function stripSatrBlocks(text) {
  if (typeof text !== 'string') return { text: '', stripped: [] };
  if (!text.includes('<satr_')) return { text, stripped: [] };
  const stripped = new Set();
  let out = text.replace(CLOSED_BLOCK_RE, (match, tag) => { stripped.add(tag.toLowerCase()); return ''; });
  out = out.replace(OPEN_TAIL_RE, (match, tag) => { stripped.add(tag.toLowerCase()); return ''; });
  if (!stripped.size) return { text, stripped: [] };
  return { text: out.trim(), stripped: [...stripped] };
}

module.exports = { TAGS, stripSatrBlocks };
