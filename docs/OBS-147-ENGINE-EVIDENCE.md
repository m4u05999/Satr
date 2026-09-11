# دليل الحارس الداخلي لإكمال المحركات — OBS-147

الملفات المعدلة: electron/codex.js وelectron/kimi.js. الحارس الجديد: scripts/engine-stop-done-test.js.
يحسم Codex وعد done بعد exit وتنظيف MCP. يحسم Kimi بعد تأكيد نهاية session/prompt وتنظيف الدور، أو بعد خروج العملية وتنظيف القناة. لا يحسم عند مهلة الإلغاء وحدها، وتبقى قناة keepalive الطبيعية حية.

التحقق النهائي:
- node scripts/engine-stop-done-test.js: 7/7، exit 0.
- node scripts/kimi-test.js: كل البنود مرت، exit 0.
- node scripts/codex-contract-test.js: نجح، exit 0.
- node --check للملفات الثلاثة: exit 0.
- مقارنة بايتية لملفَي الإنتاج بعد الاستعادة مع *.fixed.js: مطابقان.

لكل عضّة أدناه شُغّل الحارس نفسه: node scripts/engine-stop-done-test.js.

## 1. Codex — proc_done ليس خروج العملية

زرع: node dist/obs147-engine-done/mutate.js plant codex
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس (exit 1):
AssertionError [ERR_ASSERTION]: Codex done resolved before process exit
+ actual - expected

+ 'resolved'
- 'pending'

    at testCodex (D:\sater\satr-2\scripts\engine-stop-done-test.js:72:12)
    at async run (D:\sater\satr-2\scripts\engine-stop-done-test.js:181:5)

استعادة: node dist/obs147-engine-done/mutate.js restore codex
عد الاستعادة: الأصل 0 → 1 · المتحوّر 1 → 0

ملاحظة صدق: المحاولة الأولى لهذه العضّة أُخفي خطؤها بخطأ EPERM لتنظيف مجلد العملية. استُعيد الملف أولاً ثم أُصلح تنظيف الحارس كي ينتظر خروج fixture مستقلاً عن done، وأُعيد الزرع والفشل أعلاه. حُذف المجلد الفارغ المتبقي وحده بعد تحقق مساره.

## 2. Kimi — مهلة الإلغاء ليست تأكيداً

زرع: node dist/obs147-engine-done/mutate.js plant kimi
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس (exit 1):
AssertionError [ERR_ASSERTION]: Kimi done resolved on cancel timeout
+ actual - expected

+ 'resolved'
- 'pending'

    at testKimi (D:\sater\satr-2\scripts\engine-stop-done-test.js:151:14)
    at async run (D:\sater\satr-2\scripts\engine-stop-done-test.js:182:74)

استعادة: node dist/obs147-engine-done/mutate.js restore kimi
عد الاستعادة: الأصل 0 → 1 · المتحوّر 1 → 0

## 3. Kimi — تنظيف MCP يُنتظر

زرع: node dist/obs147-engine-done/mutate.js plant cleanup
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس (exit 1):
AssertionError [ERR_ASSERTION]: Kimi done resolved before MCP cleanup
+ actual - expected

+ 'resolved'
- 'pending'

    at testKimi (D:\sater\satr-2\scripts\engine-stop-done-test.js:159:14)
    at async run (D:\sater\satr-2\scripts\engine-stop-done-test.js:182:74)

استعادة: node dist/obs147-engine-done/mutate.js restore cleanup
عد الاستعادة: الأصل 0 → 1 · المتحوّر 1 → 0

## 4. Kimi — التدمير ينتظر خروج العملية

زرع: node dist/obs147-engine-done/mutate.js plant process
قبل/بعد: 1 → 0 (الأصل) · 0 → 1 (المتحوّر)
فشل الحارس (exit 1):
AssertionError [ERR_ASSERTION]: Kimi done resolved before process exit
+ actual - expected

+ 'resolved'
- 'pending'

    at testKimi (D:\sater\satr-2\scripts\engine-stop-done-test.js:167:14)
    at async run (D:\sater\satr-2\scripts\engine-stop-done-test.js:190:90)

استعادة: node dist/obs147-engine-done/mutate.js restore process
عد الاستعادة: الأصل 0 → 1 · المتحوّر 1 → 0

## حدود الإثبات

Codex يُختبر بعملية Node محلية تتكلم عقد app-server وتنهي نفسها بعد stdin؛ وKimi بمحرك الإنتاج مع عملية ACP محقونة. لا محرك مدفوع ولا شبكة أو حساب. لم يُشغّل full. done يثبت نهاية الدور/العملية التابعة؛ لا يثبت قتل أعمال SDK الخلفية أو عمليات مستقلة أطلقها الوكيل. مهلة إلغاء Kimi بلا رد تبقي done معلقاً لكي يعيد المستهلك unknown.

## أداة الزرع كما نُفذت

حُفظت وقت التنفيذ في dist/obs147-engine-done/mutate.js؛ النص الكامل أدناه لاستنساخ العضّات دون اعتماد على مجلد dist. أرقام أسطر مخرجات الفشل أعلاه تخص النسخة عند الزرع، قبل إضافة export للحارس.

```js
'use strict';
const fs = require('fs');
const mutations = {
 process: {file:'electron/kimi.js', original:'        await processDone;', mutated:'        void processDone; // OBS-147 mutation'},
 codex: {file:'electron/codex.js',
  original:"    if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }\n  }\n  let emittedDone = false;",
  mutated:"    if (!emittedDone) { emittedDone = true; emit({ type: 'proc_done', code: code || 0 }); }\n    resolveDone(); // OBS-147 mutation\n  }\n  let emittedDone = false;"},
 kimi: {file:'electron/kimi.js',original:'      if (promptFinished) {',mutated:'      if (true) { // OBS-147 mutation'},
 cleanup: {file:'electron/kimi.js',
  original:'        if (mcpHost) { const host = mcpHost; mcpHost = null; await host.stop(); }',
  mutated:'        if (mcpHost) { const host = mcpHost; mcpHost = null; host.stop(); } // OBS-147 mutation'},
};
const m=mutations[process.argv[3]];
if (!m || !['plant','restore'].includes(process.argv[2])) throw new Error('bad mode');
let s=fs.readFileSync(m.file,'utf8');
const count = (text) => s.split(text).length-1;
console.log('before original=' + count(m.original) + ' mutant=' + count(m.mutated));
const [from,to]=process.argv[2]==='plant'?[m.original,m.mutated]:[m.mutated,m.original];
if(count(from)!==1 || count(to)!==0) throw new Error('unexpected mutation state');
s=s.replace(from,to);fs.writeFileSync(m.file,s,'utf8');
console.log('after original=' + count(m.original) + ' mutant=' + count(m.mutated));

```
