# أدلة إصلاح كاش PWA عند الجذر

التاريخ: 2026-09-09. إصلاح في شجرة العمل مع حفظ التعديلات السابقة؛ لا إصدار أو commit أو نشر.

## الخلل والإصلاح

يخدم handleStatic في [mobilelink.js](../electron/mobilelink.js) القشرة من / ويحوّل المدخل إلى index.html. لكن [sw.js](../pwa/sw.js) كان يطابق /pwa/ فقط، فلا يعترض طلب /app.js مثلاً عند LAN. غاب أيضاً فحص origin، فطابق طلباً إلى أصل آخر إذا حمل المسار /pwa/app.js. أُثبت السلوكان باستدعاء مستمع fetch الإنتاجي في VM، قبل تعديل الإنتاج.

يشتق العامل الآن عناوين الأصول من self.location؛ يقبل GET من أصله وفي قائمته فقط. يوحّد مدخل المجلد مع index.html ويهمل معاملات النسخة عند تكوين مفتاح الكاش. تبقى الشبكة أولاً، ويحفظ الرد الناجح قبل اكتمال respondWith؛ لا تحجب مشكلة حفظ الكاش رداً ناجحاً. fallback يقرأ كاش النسخة الحالية وحده.

أصبحت قائمة التثبيت 13 أصلاً: الستة السابقة وfonts.css وملفات woff2 الستة المذكورة في src/vendor/fonts.css. رفع الكاش من v14 الموجود في شجرة التسليم إلى satr-pwa-v15 يحفظ تقدم إصلاح OBS-147 السابق؛ ظهور v13 في git diff هو مقارنة HEAD الأقدم. غياب أصول الخط في الأحمر أدناه يفحص متطلب هذه الدفعة الجديد، وليس ادعاء بأن القشرة القديمة كانت تستوردها.

## الأحمر قبل الإصلاح والأخضر بعده

الأوامر نُفذت في PowerShell من D:\sater\satr-2. يشغّل mutation-runner الحارس عبر process.execPath وspawnSync بلا shell ويحفظ stdout/stderr ورمز الخروج وبصمتي الإنتاج والحارس.

```text
node dist/pwa-sw/mutation-runner.js check before
exit=1
pwa-sw: 0/7 scenarios passed
AssertionError [ERR_ASSERTION]: shell request was not intercepted: /index.html
AssertionError [ERR_ASSERTION]: excluded request was intercepted: GET https://outside.invalid/pwa/app.js

node dist/pwa-sw/mutation-runner.js check fixed
exit=0
pwa-sw: 7/7 scenarios passed

node dist/pwa-sw/mutation-runner.js check restored
exit=0
pwa-sw: 7/7 scenarios passed
```

الإيصالات والسجلات: [before](../dist/pwa-sw/before.json)، [الأحمر الحرفي](../dist/pwa-sw/before.log)، [fixed](../dist/pwa-sw/fixed.json)، [restored](../dist/pwa-sw/restored.json).

- بصمة الإنتاج قبل الإصلاح: 40d92b3df412aa09288aa3553dbcb899727734b885cee2e6a7029f780c73c430
- بصمة الإنتاج النهائية: ce8218b5501883e7a0a4b329c49947a912d95b6c2c801f22578ac7d608800a7c
- بصمة الحارس قبل الإصلاح وبعد العضّات: bd62f27192111efc6880a78be9c3d6e812d4f5ea6a18d4f118d6a7bfbc529c87

## نطاق الحارس

[scripts/pwa-sw-test.js](../scripts/pwa-sw-test.js) يحمّل sw.js كاملاً دون استخراج شرطه أو إعادة كتابة توجيهه؛ self وfetch وCacheStorage بدائل مضبوطة في الذاكرة. يشتق أسماء الخطوط من CSS المصدر، ولا يحمل قائمة ثانية لأسمائها. يصدر testPwaSw مع require.main guard؛ نجح الاستدعاء المستقل والاستيراد، 7/7 في كل منهما.

| السيناريو | ما يثبته |
|---|---|
| root-network-fallback | الأصول 13 عند /: رد الشبكة الحالي يحل محل المثبت، ويعود نفسه عند انقطاع الشبكة |
| pwa-network-fallback | السلوك نفسه عند /pwa/ وفق موقع العامل |
| root-precache-entry | تثبيت الأصول كلها، تفعيل النسخة وتنظيف القديم، ثم القراءة دون اتصال مع query ومدخل / |
| pwa-precache-entry | التثبيت وfallback ومدخل /pwa/ في الموضع الآخر |
| request-boundaries | استبعاد أصل أو بروتوكول أو منفذ آخر، والطرق غير GET وAPI والملفات غير المعروفة والمسار خارج موضع القشرة |
| cache-errors | رد HTTP 503 يبقى فشلاً ولا يستبدل كاشاً صحيحاً؛ تعذر put لا يخفي نجاح الشبكة |
| offline-cache-miss | غياب الشبكة والكاش معاً يرفض الطلب بصدق |

نجح node --check للملفين وgit diff --check. البحث في scripts/ لم يجد حارساً يثبت المطابقة القديمة أو اسم الكاش v14. رُبط testPwaSw فعلياً في [pwa-dom-live-test.js](../scripts/pwa-dom-live-test.js). شُغّل npm run test:pwa-dom برمز 0: SW سبعة سيناريوهات، والقرائية ستة، ثم DOM بسبعين فحصاً؛ [إيصال الدمج وخواتيمه الحرفية](PWA-READABILITY-EVIDENCE.md#الأخضر-النهائي-والدمج). لا تُنسب هذه النتيجة إلى الحارس المنفرد.

## العضّات الفعلية الست

لكل عضّة خُزنت نسخة Buffer مستقلة بـwx قبل الكتابة. تحقّق المشغّل من الأصل والمتحور قبل الزرع وبعده، ومن SHA المتحور قبل الاستعادة، ثم أعاد Buffer نفسه وقارن البايتات. لا reset أو checkout أو stash، ولا كتابة إلى ملف إنتاج آخر. جميع baselineSha256 وبصمات الاستعادة تطابق بصمة الإنتاج النهائية أعلاه.

### root_path — إعادة مطابقة /pwa/ القديمة

```text
زرع: node dist/pwa-sw/mutation-runner.js plant root_path
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: node dist/pwa-sw/mutation-runner.js check root_path
رمز الخروج: 1
فشل الحارس: AssertionError [ERR_ASSERTION]: shell request was not intercepted: /index.html
استعادة: node dist/pwa-sw/mutation-runner.js restore root_path
بعد الاستعادة: original=1 mutant=0 exactBuffer=true
```

بصمة المتحور: 8f12ceaada922e1a2627bf8b504a1ce2385f6300470c0fe860cb660559b77351. [إيصال العد والاستعادة](../dist/pwa-sw/root_path.mutation.json)، [سجل الفشل](../dist/pwa-sw/root_path.log).

### origin — إلغاء فحص أصل الطلب

```text
زرع: node dist/pwa-sw/mutation-runner.js plant origin
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: node dist/pwa-sw/mutation-runner.js check origin
رمز الخروج: 1
فشل الحارس: AssertionError [ERR_ASSERTION]: excluded request was intercepted: GET https://outside.invalid/app.js
استعادة: node dist/pwa-sw/mutation-runner.js restore origin
بعد الاستعادة: original=1 mutant=0 exactBuffer=true
```

بصمة المتحور: e5ca6fdd2252a49e852de69d83380a7f41e7a1b74ed4d61dfaa39d104e7b69d8. [إيصال العد والاستعادة](../dist/pwa-sw/origin.mutation.json)، [سجل الفشل](../dist/pwa-sw/origin.log).

### method — إلغاء قصر الاعتراض على GET

```text
زرع: node dist/pwa-sw/mutation-runner.js plant method
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: node dist/pwa-sw/mutation-runner.js check method
رمز الخروج: 1
فشل الحارس: AssertionError [ERR_ASSERTION]: excluded request was intercepted: POST /app.js
استعادة: node dist/pwa-sw/mutation-runner.js restore method
بعد الاستعادة: original=1 mutant=0 exactBuffer=true
```

بصمة المتحور: 3cc0b3190e4fd03b5fe75ee385458720858740575f0354618a41d2432daf1bc9. [إيصال العد والاستعادة](../dist/pwa-sw/method.mutation.json)، [سجل الفشل](../dist/pwa-sw/method.log).

### shell_only — إلغاء قائمة أصول القشرة

```text
زرع: node dist/pwa-sw/mutation-runner.js plant shell_only
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: node dist/pwa-sw/mutation-runner.js check shell_only
رمز الخروج: 1
فشل الحارس: AssertionError [ERR_ASSERTION]: excluded request was intercepted: GET /poll
استعادة: node dist/pwa-sw/mutation-runner.js restore shell_only
بعد الاستعادة: original=1 mutant=0 exactBuffer=true
```

بصمة المتحور: 2089d4c2b98f7bd1efb44aae242ff5f390bd3656442f856afab3e132fd9a5064. [إيصال العد والاستعادة](../dist/pwa-sw/shell_only.mutation.json)، [سجل الفشل](../dist/pwa-sw/shell_only.log).

### fallback — إعادة مفتاح الطلب الخام في fallback

```text
زرع: node dist/pwa-sw/mutation-runner.js plant fallback
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: node dist/pwa-sw/mutation-runner.js check fallback
رمز الخروج: 1
فشل الحارس: Error: offline
استعادة: node dist/pwa-sw/mutation-runner.js restore fallback
بعد الاستعادة: original=1 mutant=0 exactBuffer=true
```

بصمة المتحور: b8308395a53b0ed82ac81feb1c1b654d960b289f1d5889d59a462188cd7f6140. [إيصال العد والاستعادة](../dist/pwa-sw/fallback.mutation.json)، [سجل الفشل](../dist/pwa-sw/fallback.log).

### fonts — حذف fonts.css من التثبيت المسبق

```text
زرع: node dist/pwa-sw/mutation-runner.js plant fonts
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: node dist/pwa-sw/mutation-runner.js check fonts
رمز الخروج: 1
فشل الحارس: AssertionError [ERR_ASSERTION]: shell request was not intercepted: /fonts.css
استعادة: node dist/pwa-sw/mutation-runner.js restore fonts
بعد الاستعادة: original=1 mutant=0 exactBuffer=true
```

بصمة المتحور: a6c1e45910cfc46a6675317c08c5f5b8dd67395fc07038c1fa2c56355e740d44. [إيصال العد والاستعادة](../dist/pwa-sw/fonts.mutation.json)، [سجل الفشل](../dist/pwa-sw/fonts.log).

## حدود الإثبات

هذا إثبات لمنطق العامل الإنتاجي ببدائل منصة داخل VM؛ لا يشغّل Service Worker فعلياً في متصفح ولا شبكة أو شهادة هاتف أو CacheStorage على القرص. addAll البديل يسجل القائمة ويملأ كاشاً اصطناعياً؛ لا يثبت وحده نجاح تنزيل الخطوط أو مطابقة ملفاتها أو رسمها. فحص HTTP والأصول والخط العربي في Chromium تتولاه دفعة القراءة البصرية، ويظل فتح الهاتف والاقتران والنقرة ضمن قبول المالك. لا اختبار وسيط منشور أو بيانات خلوية أو Web Push أو ترقية كاش هاتف قائم في هذا الحارس.

يستعمل الاختبار رداً وشبكة وكاشاً في الذاكرة فقط، بلا قراءة profile أو رموز أو labs أو بيئة القبول. لا يشمل دعوى نجاح الطقم الكامل بعد هذا التغيير؛ يسجل القائد نتيجته منفصلة.

## مشغّل الإثبات والزرع كما استُعمل

الملف المحلي: [mutation-runner.js](../dist/pwa-sw/mutation-runner.js). هذه نسخته الكاملة كي تبقى أوامر العضّة قابلة للمراجعة إذا غاب dist:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const target = path.join(root, 'pwa/sw.js');
const guard = path.join(root, 'scripts/pwa-sw-test.js');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const count = (source, value) => source.split(value).length - 1;
const mutations = {
  root_path: [
    "if (!SHELL_URLS.has(shellUrl.href)) return;",
    "if (!SHELL_ASSETS.includes(url.pathname.replace(/^\\/pwa\\//, './'))) return;",
  ],
  origin: [
    "if (url.origin !== self.location.origin) return;",
    "if (false && url.origin !== self.location.origin) return;",
  ],
  method: [
    "if (request.method !== 'GET') return;",
    "if (false && request.method !== 'GET') return;",
  ],
  shell_only: [
    "if (!SHELL_URLS.has(shellUrl.href)) return;",
    "if (false && !SHELL_URLS.has(shellUrl.href)) return;",
  ],
  fallback: ["cache.match(shellUrl.href)", "cache.match(request)"],
  fonts: ["  './fonts.css',", "  // عضّة: حذف fonts.css من التثبيت"],
};
const [mode, name] = process.argv.slice(2);
if (mode === 'check') {
  const run = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
  const log = (run.stdout || '') + (run.stderr || '');
  const receipt = { command: 'node scripts/pwa-sw-test.js', sourceSha256: sha(fs.readFileSync(target)),
    guardSha256: sha(fs.readFileSync(guard)), exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
  fs.writeFileSync(path.join(__dirname, name + '.log'), log, 'utf8');
  fs.writeFileSync(path.join(__dirname, name + '.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  if (name === 'before') fs.writeFileSync(path.join(__dirname, 'before.bin'), fs.readFileSync(target), { flag: 'wx' });
  process.stdout.write(log);
  process.exitCode = run.status == null ? 1 : run.status;
} else if (mode === 'plant') {
  const [original, mutant] = mutations[name] || [];
  if (!original) throw new Error('unknown_mutation');
  const baseline = fs.readFileSync(target);
  const source = baseline.toString('utf8');
  const before = { original: count(source, original), mutant: count(source, mutant) };
  if (before.original !== 1 || before.mutant !== 0) throw new Error('unexpected_baseline_counts');
  fs.writeFileSync(path.join(__dirname, name + '.baseline.bin'), baseline, { flag: 'wx' });
  const changed = Buffer.from(source.replace(original, mutant), 'utf8');
  fs.writeFileSync(target, changed);
  const actual = fs.readFileSync(target);
  if (!actual.equals(changed)) throw new Error('mutation_write_mismatch');
  const after = { original: count(actual.toString('utf8'), original), mutant: count(actual.toString('utf8'), mutant) };
  if (after.original !== 0 || after.mutant !== 1) throw new Error('unexpected_mutant_counts');
  const receipt = { command: 'node dist/pwa-sw/mutation-runner.js plant ' + name, target: 'pwa/sw.js',
    original, mutant, before, after, baselineSha256: sha(baseline), mutantSha256: sha(actual) };
  fs.writeFileSync(path.join(__dirname, name + '.mutation.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
} else if (mode === 'restore') {
  const receiptPath = path.join(__dirname, name + '.mutation.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (sha(fs.readFileSync(target)) !== receipt.mutantSha256) throw new Error('refusing_to_overwrite_changed_source');
  const baseline = fs.readFileSync(path.join(__dirname, name + '.baseline.bin'));
  if (sha(baseline) !== receipt.baselineSha256) throw new Error('baseline_changed');
  fs.writeFileSync(target, baseline);
  const restored = fs.readFileSync(target);
  if (!restored.equals(baseline)) throw new Error('restore_mismatch');
  receipt.restored = { command: 'node dist/pwa-sw/mutation-runner.js restore ' + name,
    original: count(restored.toString('utf8'), receipt.original),
    mutant: count(restored.toString('utf8'), receipt.mutant),
    sha256: sha(restored), exactBuffer: restored.equals(baseline) };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(receipt.restored, null, 2));
} else {
  throw new Error('usage: check label | plant name | restore name');
}
```
