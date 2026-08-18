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

// OBS-035: سؤال بلا إجابة قرارٌ لم يُتَّخذ، لا «لا معلومة». الرسالة المحايدة السابقة
// («لم يُختَر جواب صالح») كان النموذج يقرأها إذناً بالتخمين فيختار نيابةً عن المستخدم
// ويمضي. الحارس على النص نفسه لأنه هو ما يصل النموذج فعلاً.
const agentSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
const messageMatch = agentSource.match(/const QUESTION_UNANSWERED_MESSAGE = ([\s\S]*?);\n/);
assert(messageMatch, 'رسالة السؤال غير المُجاب غير معرّفة في agent.js');
const unanswered = messageMatch[1];
for (const must of ['لا تفترض', 'لا تختر نيابةً', 'اطرح السؤال نصّاً', 'توقّف']) {
  assert(unanswered.includes(must), 'رسالة السؤال غير المُجاب لا توجّه النموذج: ينقصها «' + must + '»');
}
// الفحص على شكل الكود (`message: '…'`) لا على النص المجرّد، وإلا أمسك الحارسُ تعليقاً
// يقتبس الرسالة القديمة ليشرح سبب استبدالها — وقد وقع ذلك فعلاً عند كتابته.
assert(!/message:\s*'لم يُختَر جواب صالح'/.test(agentSource),
  'مسار الإجابة الفارغة ما زال يستعمل الرسالة المحايدة');
// النطاق مقصور على مسار السؤال: `أُلغي الطلب` تبقى صحيحة في مساري الإذن والموصّل
// (`pending.delete`) لأن الدور هناك لا يكمل أصلاً — الحارس يضيق كي لا يفرض توجيهاً في غير موضعه.
const questionAborts = agentSource.match(/pendingQuestions\.delete\(id\)\)\s*resolve\(\{[^}]*\}/g) || [];
assert(questionAborts.length >= 1, 'لم يُعثر على مسار إجهاض السؤال');
for (const abort of questionAborts) {
  assert(abort.includes('QUESTION_UNANSWERED_MESSAGE'),
    'إجهاض السؤال يردّ برسالة غير موجِّهة: ' + abort);
}
const denyUses = agentSource.match(/behavior: 'deny', message: QUESTION_UNANSWERED_MESSAGE/g) || [];
assert(denyUses.length >= 2, 'مسارا الرفض (الإجابة الفارغة وإجهاض الطلب) لا يستعملان الرسالة الموجِّهة معاً');

console.log('askquestion-test: ok — تنقية fail-closed (رفض التجاوز/التكرار)، بناء صارم، رفض الجزئي والحقن، ورسالة موجِّهة للسؤال غير المُجاب');
