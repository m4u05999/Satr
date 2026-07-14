// اختبار الدوال النقية لـ AskUserQuestion (تنقية العرض fail-closed + بناء الإجابة من مؤشرات).
// لا SDK ولا electron — منطق نقي. التكامل الحيّ مثبت في ask-user-question-probe.js.
const assert = require('assert');
const { sanitizeQuestions, buildQuestionAnswer } = require('../electron/agent.js');

function q(over = {}) {
  return {
    questions: [{
      question: 'أي مسار؟', header: 'اختيار', multiSelect: false,
      options: [{ label: 'ألف', description: 'الأول' }, { label: 'باء', description: 'الثاني' }],
      ...over,
    }],
  };
}
function twoQuestions() {
  return { questions: [
    { question: 'س1', header: 'ه', multiSelect: false, options: [{ label: 'أ', description: 'د' }, { label: 'ب', description: 'د' }] },
    { question: 'س2', header: 'ه', multiSelect: true, options: [{ label: 'ج', description: 'د' }, { label: 'د', description: 'د' }] },
  ] };
}

// ---- sanitizeQuestions: قبول ----
const clean = sanitizeQuestions(q());
assert(Array.isArray(clean) && clean.length === 1 && clean[0].options.length === 2, 'سؤال صالح يُقبل');
assert(!('preview' in clean[0].options[0]), 'preview الغائب لا يُضاف');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'أ', description: 'د', preview: 'code()' }, { label: 'ب', description: 'د' }] }))[0].options[0].preview, 'code()', 'preview الموجود يبقى');

// ---- sanitizeQuestions: رفض fail-closed ----
assert.strictEqual(sanitizeQuestions(null), null, 'null يُرفض');
assert.strictEqual(sanitizeQuestions({ questions: [] }), null, 'صفر أسئلة يُرفض');
assert.strictEqual(sanitizeQuestions({ questions: new Array(5).fill(q().questions[0]) }), null, '>4 أسئلة يُرفض');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'واحد', description: 'د' }] })), null, '<2 خيارات يُرفض');
assert.strictEqual(sanitizeQuestions(q({ question: '' })), null, 'سؤال بلا نص يُرفض');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: '', description: 'د' }, { label: 'ب', description: 'د' }] })), null, 'خيار بلا label يُرفض');
assert.strictEqual(sanitizeQuestions(q({ header: 42 })), null, 'header غير النصي يُرفض');
assert.strictEqual(sanitizeQuestions(q({ multiSelect: 'false' })), null, 'multiSelect غير المنطقي يُرفض');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'أ', description: 42 }, { label: 'ب', description: 'د' }] })), null, 'description غير النصي يُرفض');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'أ', description: 'د', preview: 42 }, { label: 'ب', description: 'د' }] })), null, 'preview غير النصي يُرفض');
// P1-b: النص المتجاوز يُرفض (لا يُقصّ) — فيتطابق المعروض مع المُعاد
assert.strictEqual(sanitizeQuestions(q({ question: 'س'.repeat(2001) })), null, 'سؤال متجاوز يُرفض لا يُقصّ');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'ل'.repeat(401), description: 'د' }, { label: 'ب', description: 'د' }] })), null, 'label متجاوز يُرفض');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'أ', description: 'د', preview: 'p'.repeat(4001) }, { label: 'ب', description: 'د' }] })), null, 'preview متجاوز يُرفض');
// P1-a: تكرار نص السؤال أو label
assert.strictEqual(sanitizeQuestions({ questions: [q().questions[0], q().questions[0]] }), null, 'نص سؤال مكرر يُرفض');
assert.strictEqual(sanitizeQuestions(q({ options: [{ label: 'أ', description: 'د' }, { label: 'أ', description: 'د' }] })), null, 'label مكرر في سؤال يُرفض');

// ---- buildQuestionAnswer: قبول ----
const single = buildQuestionAnswer(q(), [{ questionIndex: 0, optionIndexes: [1] }]);
assert.deepStrictEqual(single.answers, { 'أي مسار؟': 'باء' }, 'الأحادي يبني answers من المؤشر');
assert(single.questions, 'يحافظ على questions الأصلية');
const multi = buildQuestionAnswer(
  q({ multiSelect: true, options: [{ label: 'ألف', description: 'د' }, { label: 'باء', description: 'د' }, { label: 'جيم', description: 'د' }] }),
  [{ questionIndex: 0, optionIndexes: [0, 2] }]);
assert.strictEqual(multi.answers['أي مسار؟'], 'ألف, جيم', 'المتعدد يجمع labels بفواصل');
const both = buildQuestionAnswer(twoQuestions(), [{ questionIndex: 0, optionIndexes: [1] }, { questionIndex: 1, optionIndexes: [0, 1] }]);
assert.deepStrictEqual(both.answers, { 'س1': 'ب', 'س2': 'ج, د' }, 'سؤالان يُجابان معاً');

// ---- buildQuestionAnswer: رفض fail-closed (كل مخالفة ⇒ null، لا إجابة جزئية) ----
assert.strictEqual(buildQuestionAnswer(q(), []), null, 'لا اختيار ⇒ null');
assert.strictEqual(buildQuestionAnswer(twoQuestions(), [{ questionIndex: 0, optionIndexes: [0] }]), null, 'سؤال ناقص (1 من 2) يُرفض كاملاً');
assert.strictEqual(buildQuestionAnswer(q(), [{ questionIndex: 0, optionIndexes: [0, 1] }]), null, 'أحادي بعدة خيارات يُرفض');
assert.strictEqual(buildQuestionAnswer(q(), [{ questionIndex: 0, optionIndexes: [1, 1] }]), null, 'خيار مكرر يُرفض');
assert.strictEqual(buildQuestionAnswer(twoQuestions(), [{ questionIndex: 0, optionIndexes: [0] }, { questionIndex: 0, optionIndexes: [1] }]), null, 'سؤال مكرر (index) يُرفض');
assert.strictEqual(buildQuestionAnswer(q(), [{ questionIndex: 0, optionIndexes: [9] }]), null, 'مؤشر خيار خارج النطاق يُرفض');
assert.strictEqual(buildQuestionAnswer(q(), [{ questionIndex: 5, optionIndexes: [0] }]), null, 'مؤشر سؤال خارج النطاق يُرفض');
assert.strictEqual(buildQuestionAnswer(q(), [{ questionIndex: 0, optionIndexes: [] }]), null, 'سؤال بلا اختيار يُرفض');
assert.strictEqual(buildQuestionAnswer(q(), [{ questionIndex: -1, optionIndexes: [0] }]), null, 'مؤشر سالب يُرفض');
assert.strictEqual(buildQuestionAnswer(q({ multiSelect: 'false' }), [{ questionIndex: 0, optionIndexes: [0] }]), null, 'input مخالف الأنواع يُرفض عند البناء أيضاً');

// الأمان: النص الحرّ في selection يُتجاهل — الإجابة من labels الأصلية حصراً
const injected = buildQuestionAnswer(q(), [{ questionIndex: 0, optionIndexes: [0], label: 'مزروع', answer: 'حقن' }]);
assert.strictEqual(injected.answers['أي مسار؟'], 'ألف', 'يتجاهل النص الحرّ ويستعمل label الأصلي');

console.log('askquestion-test: ok — تنقية fail-closed (رفض التجاوز/التكرار)، بناء صارم، رفض الجزئي والحقن');
