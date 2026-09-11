# أدلة اختبار التوصيلات الأساسية — OBS-145

التاريخ: 2026-09-08. هذه الوثيقة تنقل إيصالات سبع عضّات على كود الإنتاج؛ إنشاء الوثيقة لم يشغّل اختباراً أو يزرع عطلاً جديداً. الأوامر داخل الكتل منقولة من قيم JSON كما نُفّذت في PowerShell، دون إعادة صياغة أو إعادة التفاف للأسطر.

المصادر: `dist/connections-bite-report.json` و`dist/connection-services-ui-bites.json` و`dist/connections-engine-bite.json`. نُقلت الإيصالات هنا لأن مجلد dist متجاهل. أرقام الأسطر في رسائل الفشل تخص الملف لحظة الاختبار، وقد تتحرك بعد إضافات لاحقة. أعداد PASS المحفوظة تصف تشغيل تلك اللحظة، ولا تثبّت تعداد الطقم الحالي.

حدود الإثبات: حارس `scripts/connections-test.js` يستعمل مخزن المشروع والتحقق والتنفيذ من الإنتاج مع خدمة وsafeStorage مصطنعين عند حدودهما الخارجية. يغطي أيضاً `renderertrust → connection-ipc → manager`، و`codexmcp → connection-tools → manager` عبر HTTP محلي، ثم محول GitHub الإنتاجي بحقن fetch عند حد الشبكة. حارس `scripts/connection-services-test.js` يشغّل محولات الخدمات الفعلية بطبقة نقل مصطنعة. حارس `scripts/connections-ui-test.js` يشغّل مكوّن الواجهة الفعلي داخل Electron بعقود IPC اختبارية؛ نجاحه لا يعوّض القبول البشري أو قياس browser_readability.

اختبار خروج Codex هنا يمر عبر `codex.start` الإنتاجي لكنه يستبدل ثنائي app-server بعملية Node مصطنعة تخرج برمز 17. لذلك لا يثبت استعمال النموذج المثبت للتوصيلة. لا تتضمن هذه الإيصالات حسابات أو رموز خدمات حقيقية، ولا تسجيل دخول حيّاً إلى GitHub أو Netlify أو Supabase. نتيجة مسبار المحرك المثبت وإيصال عضّته مفصلان في القسم السابع أدناه. نتيجة الطقم الكامل مستقلة عن هذه النتائج المحدودة.

## 1. رفض مورد غير مختار في نواة المشروع

الادعاء: إزالة مطابقة المورد من `electron/connections.js` تُسقط الحارس الذي يشغّل وحدة الإنتاج، قبل اعتبار الخدمة قادرة على تنفيذ المورد المطلوب.

أمر الزرع كما نُفّذ:

```powershell
$mutationPath = 'D:\sater\satr-2\electron\connections.js'; $original = "if (input.resource !== record.resource.id) throw fail('bad_resource');"; $mutant = "if (false && input.resource !== record.resource.id) throw fail('bad_resource');"; $source = [IO.File]::ReadAllText($mutationPath); $beforeOriginal = ([regex]::Matches($source,[regex]::Escape($original))).Count; $beforeMutant = ([regex]::Matches($source,[regex]::Escape($mutant))).Count; if ($beforeOriginal -ne 1 -or $beforeMutant -ne 0) { throw 'unexpected mutation counts' }; [IO.File]::WriteAllText($mutationPath,$source.Replace($original,$mutant),[Text.UTF8Encoding]::new($false)); $after = [IO.File]::ReadAllText($mutationPath); Write-Output ('original: ' + $beforeOriginal + ' -> ' + ([regex]::Matches($after,[regex]::Escape($original))).Count); Write-Output ('mutant: ' + $beforeMutant + ' -> ' + ([regex]::Matches($after,[regex]::Escape($mutant))).Count)
```

خرج العد الحرفي — رمز خروج الزرع: `0`:

```text
original: 1 -> 0
mutant: 0 -> 1
```

أمر الحارس:

```powershell
node scripts/connections-test.js
```

فشل الحارس كما طُبع — رمز الخروج: `1`:

```text
AssertionError [ERR_ASSERTION]: accepted an unselected resource
+ actual - expected

+ undefined
- 'bad_resource'

    at main (D:\sater\satr-2\scripts\connections-test.js:113:12)
```

أمر الاستعادة كما نُفّذ:

```powershell
$mutationPath = 'D:\sater\satr-2\electron\connections.js'; $original = "if (input.resource !== record.resource.id) throw fail('bad_resource');"; $mutant = "if (false && input.resource !== record.resource.id) throw fail('bad_resource');"; $source = [IO.File]::ReadAllText($mutationPath); if (([regex]::Matches($source,[regex]::Escape($mutant))).Count -ne 1) { throw 'missing mutation' }; [IO.File]::WriteAllText($mutationPath,$source.Replace($mutant,$original),[Text.UTF8Encoding]::new($false)); $after = [IO.File]::ReadAllText($mutationPath); Write-Output ('restored original: ' + ([regex]::Matches($after,[regex]::Escape($original))).Count); Write-Output ('restored mutant: ' + ([regex]::Matches($after,[regex]::Escape($mutant))).Count)
```

خرج الاستعادة الحرفي — رمز الخروج: `0`:

```text
restored original: 1
restored mutant: 0
```

## 2. رفض حقول IPC الزائدة

الادعاء: إزالة قائمة الحقول المسموحة من `electron/connection-ipc.js` تُسقط الاختبار المار عبر register وغلاف renderertrust ومدير التخزين الفعلي.

أمر الزرع كما نُفّذ:

```powershell
$mutationPath = 'D:\sater\satr-2\electron\connection-ipc.js'; $original = '|| Object.keys(payload).some((key) => !fields.includes(key))) return null;'; $mutant = '|| false && Object.keys(payload).some((key) => !fields.includes(key))) return null;'; $source = [IO.File]::ReadAllText($mutationPath); $beforeOriginal = ([regex]::Matches($source,[regex]::Escape($original))).Count; $beforeMutant = ([regex]::Matches($source,[regex]::Escape($mutant))).Count; if ($beforeOriginal -ne 1 -or $beforeMutant -ne 0) { throw 'unexpected mutation counts' }; [IO.File]::WriteAllText($mutationPath,$source.Replace($original,$mutant),[Text.UTF8Encoding]::new($false)); $after = [IO.File]::ReadAllText($mutationPath); Write-Output ('original: ' + $beforeOriginal + ' -> ' + ([regex]::Matches($after,[regex]::Escape($original))).Count); Write-Output ('mutant: ' + $beforeMutant + ' -> ' + ([regex]::Matches($after,[regex]::Escape($mutant))).Count)
```

خرج العد الحرفي — رمز خروج الزرع: `0`:

```text
original: 1 -> 0
mutant: 0 -> 1
```

أمر الحارس:

```powershell
node scripts/connections-test.js
```

فشل الحارس كما طُبع — رمز الخروج: `1`:

```text
AssertionError [ERR_ASSERTION]: accepted extra IPC field
+ actual - expected

+ undefined
- 'bad_input'

    at main (D:\sater\satr-2\scripts\connections-test.js:301:12)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

أمر الاستعادة كما نُفّذ:

```powershell
$mutationPath = 'D:\sater\satr-2\electron\connection-ipc.js'; $original = '|| Object.keys(payload).some((key) => !fields.includes(key))) return null;'; $mutant = '|| false && Object.keys(payload).some((key) => !fields.includes(key))) return null;'; $source = [IO.File]::ReadAllText($mutationPath); if (([regex]::Matches($source,[regex]::Escape($mutant))).Count -ne 1) { throw 'missing mutation' }; [IO.File]::WriteAllText($mutationPath,$source.Replace($mutant,$original),[Text.UTF8Encoding]::new($false)); $after = [IO.File]::ReadAllText($mutationPath); Write-Output ('restored original: ' + ([regex]::Matches($after,[regex]::Escape($original))).Count); Write-Output ('restored mutant: ' + ([regex]::Matches($after,[regex]::Escape($mutant))).Count)
```

خرج الاستعادة الحرفي — رمز الخروج: `0`:

```text
restored original: 1
restored mutant: 0
```

## 3. رفض إعادة توجيه طلبات الخدمات

الادعاء: تحويل سياسة النقل الإنتاجية من redirect:error إلى redirect:follow يُسقط حارس محول الخدمة عند حد fetch. هذا يثبت سياسة النقل المطلوبة، ولا يدّعي تجربة تحويل خارجي بحساب حي.

معرّف الإيصال: `provider-redirect`؛ ملف الإنتاج: `electron/connection-services.js`.

أمر الزرع كما نُفّذ:

```powershell
$mutationPath = Join-Path (Get-Location) 'electron/connection-services.js'
$original = "redirect: 'error'"
$mutant = "redirect: 'follow'"
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('before original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
if (([regex]::Matches($mutationText, [regex]::Escape($original))).Count -ne 1) { throw 'mutation source count mismatch' }
[IO.File]::WriteAllText($mutationPath, $mutationText.Replace($original, $mutant), [Text.UTF8Encoding]::new($false))
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('after original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
```

العد كما سُجّل في حقول before وafter في الإيصال الأصلي؛ الإيصال يحفظ الأرقام بنيوياً:

| الطرف | قبل الزرع | بعد الزرع |
|---|---:|---:|
| الأصل | 1 | 0 |
| المتحوّر | 0 | 1 |

أمر الحارس:

```powershell
node scripts/connection-services-test.js
```

فشل الحارس كما حفظه الإيصال — رمز الخروج: `1`:

```text
AssertionError [ERR_ASSERTION]: إعادة التوجيه يجب أن تبقى مرفوضة

'follow' !== 'error'

    at D:\sater\satr-2\scripts\connection-services-test.js:68:14
    at async check (D:\sater\satr-2\scripts\connection-services-test.js:48:5)
    at async main (D:\sater\satr-2\scripts\connection-services-test.js:53:3) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 'follow',
  expected: 'error',
  operator: 'strictEqual',
  diff: 'simple'
}
```

أمر الاستعادة كما نُفّذ:

```powershell
$mutationPath = Join-Path (Get-Location) 'electron/connection-services.js'
$original = "redirect: 'error'"
$mutant = "redirect: 'follow'"
$mutationText = [IO.File]::ReadAllText($mutationPath)
if (([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count -ne 1) { throw 'restore source count mismatch' }
[IO.File]::WriteAllText($mutationPath, $mutationText.Replace($mutant, $original), [Text.UTF8Encoding]::new($false))
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('restored original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
```

العد بعد الاستعادة كما سُجّل: الأصل `1`، المتحوّر `0`.

نتيجة إعادة الحارس المسجلة بعد الاستعادة — رمز الخروج: `0`:

```text
PASS connection-services 10/10
```

## 4. منع الطلب المؤثر بعد إبطال الاتصال

الادعاء: تعطيل control.assertActive في محول الخدمة الإنتاجي يُسقط حالة إبطال الاتصال أثناء GET السابق لطلب POST. الطلبات خارج الجهاز مصطنعة؛ المنطق الذي يفصل الطلبين من الإنتاج.

معرّف الإيصال: `provider-active-before-post`؛ ملف الإنتاج: `electron/connection-services.js`.

أمر الزرع كما نُفّذ:

```powershell
$mutationPath = Join-Path (Get-Location) 'electron/connection-services.js'
$original = "if (control && typeof control.assertActive === 'function') control.assertActive();"
$mutant = "if (false && control && typeof control.assertActive === 'function') control.assertActive();"
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('before original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
if (([regex]::Matches($mutationText, [regex]::Escape($original))).Count -ne 1) { throw 'mutation source count mismatch' }
[IO.File]::WriteAllText($mutationPath, $mutationText.Replace($original, $mutant), [Text.UTF8Encoding]::new($false))
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('after original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
```

العد كما سُجّل في حقول before وafter في الإيصال الأصلي؛ الإيصال يحفظ الأرقام بنيوياً:

| الطرف | قبل الزرع | بعد الزرع |
|---|---:|---:|
| الأصل | 1 | 0 |
| المتحوّر | 0 | 1 |

أمر الحارس:

```powershell
node scripts/connection-services-test.js
```

فشل الحارس كما حفظه الإيصال — رمز الخروج: `1`:

```text
AssertionError [ERR_ASSERTION]: يجب منع الفعل بعد إبطال الاتصال
    at async D:\sater\satr-2\scripts\connection-services-test.js:245:7
    at async check (D:\sater\satr-2\scripts\connection-services-test.js:48:5)
    at async main (D:\sater\satr-2\scripts\connection-services-test.js:231:3) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: [ServiceError],
  expected: [Function (anonymous)],
  operator: 'rejects',
  diff: 'simple'
}
```

أمر الاستعادة كما نُفّذ:

```powershell
$mutationPath = Join-Path (Get-Location) 'electron/connection-services.js'
$original = "if (control && typeof control.assertActive === 'function') control.assertActive();"
$mutant = "if (false && control && typeof control.assertActive === 'function') control.assertActive();"
$mutationText = [IO.File]::ReadAllText($mutationPath)
if (([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count -ne 1) { throw 'restore source count mismatch' }
[IO.File]::WriteAllText($mutationPath, $mutationText.Replace($mutant, $original), [Text.UTF8Encoding]::new($false))
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('restored original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
```

العد بعد الاستعادة كما سُجّل: الأصل `1`، المتحوّر `0`.

نتيجة إعادة الحارس المسجلة بعد الاستعادة — رمز الخروج: `0`:

```text
PASS connection-services 12/12
```

## 5. إلغاء إذن التوصيلة عند خروج Codex المفاجئ

الادعاء: تعطيل تنظيف التوصيلات في مسار خروج العملية من `electron/codex.js` يُبقي الإذن معلقاً. الاختبار يشغّل codex.start وبوابة الإذن وخادم MCP الفعليين؛ عملية app-server مصطنعة، وليست المحرك المثبت أو حسابه.

أمر الزرع كما نُفّذ:

```powershell
$mutationPath = 'D:\sater\satr-2\electron\codex.js'; $original = '    cleanupConnections(); // خروج العملية يبطل التوصيلات ولو لم يمر الدور عبر cleanup.'; $mutant = '    if (false) cleanupConnections(); // خروج العملية يبطل التوصيلات ولو لم يمر الدور عبر cleanup.'; $source = [IO.File]::ReadAllText($mutationPath); $beforeOriginal = ([regex]::Matches($source,[regex]::Escape($original))).Count; $beforeMutant = ([regex]::Matches($source,[regex]::Escape($mutant))).Count; if ($beforeOriginal -ne 1 -or $beforeMutant -ne 0) { throw 'unexpected mutation counts' }; [IO.File]::WriteAllText($mutationPath,$source.Replace($original,$mutant),[Text.UTF8Encoding]::new($false)); $after = [IO.File]::ReadAllText($mutationPath); Write-Output ('original: ' + $beforeOriginal + ' -> ' + ([regex]::Matches($after,[regex]::Escape($original))).Count); Write-Output ('mutant: ' + $beforeMutant + ' -> ' + ([regex]::Matches($after,[regex]::Escape($mutant))).Count)
```

خرج العد الحرفي — رمز خروج الزرع: `0`:

```text
original: 1 -> 0
mutant: 0 -> 1
```

أمر الحارس:

```powershell
node scripts/connections-test.js
```

فشل الحارس كما طُبع — رمز الخروج: `1`:

```text
AssertionError [ERR_ASSERTION]: Codex exit kept connection permission alive

'pending' !== false

    at testCodexExit (D:\sater\satr-2\scripts\connections-test.js:82:12)
    at async main (D:\sater\satr-2\scripts\connections-test.js:427:5)
```

أمر الاستعادة كما نُفّذ:

```powershell
$mutationPath = 'D:\sater\satr-2\electron\codex.js'; $original = '    cleanupConnections(); // خروج العملية يبطل التوصيلات ولو لم يمر الدور عبر cleanup.'; $mutant = '    if (false) cleanupConnections(); // خروج العملية يبطل التوصيلات ولو لم يمر الدور عبر cleanup.'; $source = [IO.File]::ReadAllText($mutationPath); if (([regex]::Matches($source,[regex]::Escape($mutant))).Count -ne 1) { throw 'missing mutation' }; [IO.File]::WriteAllText($mutationPath,$source.Replace($mutant,$original),[Text.UTF8Encoding]::new($false)); $after = [IO.File]::ReadAllText($mutationPath); Write-Output ('restored original: ' + ([regex]::Matches($after,[regex]::Escape($original))).Count); Write-Output ('restored mutant: ' + ([regex]::Matches($after,[regex]::Escape($mutant))).Count)
```

خرج الاستعادة الحرفي — رمز الخروج: `0`:

```text
restored original: 1
restored mutant: 0
```

## 6. منع رسالة نجاح قديمة من الظهور في مشروع آخر

الادعاء: تعطيل مقارنة seq بعد تحديث لوحة التوصيلات ينقل رسالة نجاح من المشروع القديم إلى الجديد، ويسقط حارس مكوّن الواجهة الفعلي. القياس الآلي عند عرضين لا يشكل قبولاً بشرياً.

معرّف الإيصال: `ui-stale-success-refresh`؛ ملف الإنتاج: `src/ui/components/connection-view.js`.

أمر الزرع كما نُفّذ:

```powershell
$mutationPath = Join-Path (Get-Location) 'src/ui/components/connection-view.js'
$original = 'if (this.seq !== refreshedSeq) return;'
$mutant = 'if (false && this.seq !== refreshedSeq) return;'
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('before original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
if (([regex]::Matches($mutationText, [regex]::Escape($original))).Count -ne 1) { throw 'mutation source count mismatch' }
[IO.File]::WriteAllText($mutationPath, $mutationText.Replace($original, $mutant), [Text.UTF8Encoding]::new($false))
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('after original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
```

العد كما سُجّل في حقول before وafter في الإيصال الأصلي؛ الإيصال يحفظ الأرقام بنيوياً:

| الطرف | قبل الزرع | بعد الزرع |
|---|---:|---:|
| الأصل | 1 | 0 |
| المتحوّر | 0 | 1 |

أمر الحارس:

```powershell
npm run test:connections-ui
```

فشل الحارس كما حفظه الإيصال — رمز الخروج: `1`:

```text
connections-ui: Error: انتقلت رسالة نجاح المشروع القديم إلى المشروع الجديد أثناء تحديث اللوحة.
```

أمر الاستعادة كما نُفّذ:

```powershell
$mutationPath = Join-Path (Get-Location) 'src/ui/components/connection-view.js'
$original = 'if (this.seq !== refreshedSeq) return;'
$mutant = 'if (false && this.seq !== refreshedSeq) return;'
$mutationText = [IO.File]::ReadAllText($mutationPath)
if (([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count -ne 1) { throw 'restore source count mismatch' }
[IO.File]::WriteAllText($mutationPath, $mutationText.Replace($mutant, $original), [Text.UTF8Encoding]::new($false))
$mutationText = [IO.File]::ReadAllText($mutationPath)
Write-Output ('restored original={0} mutant={1}' -f ([regex]::Matches($mutationText, [regex]::Escape($original))).Count, ([regex]::Matches($mutationText, [regex]::Escape($mutant))).Count)
```

العد بعد الاستعادة كما سُجّل: الأصل `1`، المتحوّر `0`.

نتيجة إعادة الحارس المسجلة بعد الاستعادة — رمز الخروج: `0`:

```text
PASS connections-ui 8/8; widths=390,1000; CSP=0; console=0
```


## 7. نتيجة الطقم الكامل وإعادة term-longline المحدودة

اكتمل الطقم الكامل الخارجي بتاريخ 2026-09-08 بنتيجة 102/103؛ رمز الخروج المحفوظ في `dist/connections-full-suite.log.done` هو `1`. الفشل الوحيد هو `test:term-longline`: طبع نجاح 77 فحصاً ثم بقيت العملية مفتوحة حتى مهلة 240 ثانية، فقتل متحكّم الطقم شجرتها وأكمل باقي المجموعات. المصدر `dist/connections-full-suite.log` بترميز UTF-16LE؛ نصه العربي مشوّه بترميز الكونسول، لذلك تُنقل هنا الأسطر ASCII المقروءة فقط:

```text
  test:term-longline               240.4
=== SUITE_EXIT=1 ===
ended=2026-09-08 06:49:56
```

أُجريت إعادة منفردة واحدة لهذا الاختبار فقط عبر `runManagedProcess` المصدّر من `scripts/full-suite.js` الإنتاجي، بمهلة `240000` وبأمر `cmd /d /s /c npm run test:term-longline` نفسه. لم يُعدّل الطقم أو الحارس ولم يُعَد تشغيل الطقم الكامل. الأمر كما نُفّذ في PowerShell:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
node -e "const fs=require('fs');const{runManagedProcess}=require('./scripts/full-suite');const startedAt=Date.now();runManagedProcess('cmd',['/d','/s','/c','npm','run','test:term-longline'],{cwd:process.cwd(),env:process.env,stdio:'inherit',timeout:240000}).then(result=>{result.elapsedMs=Date.now()-startedAt;fs.writeFileSync('dist/connections-term-longline-isolated-result.json',JSON.stringify(result,null,2));console.log('ISOLATED_RESULT '+JSON.stringify(result));process.exitCode=result.status===0&&!result.timedOut?0:1;}).catch(error=>{console.error(error);process.exitCode=1;});" 2>&1 | Tee-Object -FilePath dist\connections-term-longline-isolated.log
$taskExitCode = $LASTEXITCODE
Write-Output "ISOLATED_EXIT_CODE=$taskExitCode"
exit $taskExitCode
```

المخرجان: `dist/connections-term-longline-isolated.log` بترميز UTF-16LE و`dist/connections-term-longline-isolated-result.json` بترميز UTF-8. مقتطفات الخرج الحرفية:

```text
Error: AttachConsole failed
term-longline: نجح — 77 فحصاً · الوضع كامل (محمول + قياس بيئيّ) (حفظ الأسطر، إقلاع السكربت في وسائط spawn، فشل صريح بلا علق، وقصّ ذيل معلَن، وبروتوكول الالتقاط تحت bash/sh نقيّاً، وعناقيد الحرف عند حافة الالتفاف مقيسة).
ISOLATED_RESULT {"status":0,"signal":null,"pid":32924,"timedOut":false,"reaped":true,"elapsedMs":18500}
ISOLATED_EXIT_CODE=0
```

النتيجة المحدودة: نجح الاختبار المنفرد وأُغلقت عمليته خلال 18.5 ثانية، مع تكرار `AttachConsole failed`. لم يتكرر التعليق في هذه المحاولة؛ تكرار الرسالة مع خروج ناجح يعني أن الرسالة وحدها لا تثبت التعليق. اختلاف نتيجة العزلة عن الطقم لا يحدد السبب الجذري، ولا يثبت أن العطل بيئي، ولا ينسبه إلى التوصيلات أو ينفي صلتها به. نتيجة الطقم الكامل تبقى 102/103 ورمز خروجه 1؛ الإعادة المحدودة لا تحولها إلى نجاح كامل.

## 7. نسبة الاستخدام إلى المحرك الفعلي

شغّل المسبار Codex المثبت `0.153.4` مع `gpt-5.6-sol` عبر `codex.start` ثم HTTP MCP وأدوات التوصيلات الإنتاجية. حقن fetch لخدمة GitHub وتشفير AES-GCM اصطناعي؛ لا حساب خدمة حي ولا DPAPI. نجحت الحالات الست في التشغيل الكامل برمز 0 وتنظيف مكتمل.

الزرع يغيّر نسبة المحرك في `electron/connection-tools.js` نفسها على القرص؛ لا نسخة مقلدة من المنطق. نفذ بعد انتهاء الطقم الأول واستعيد قبل بناء النسخة.

أمر الزرع كما نُفّذ:

```powershell
@'
from pathlib import Path
p = Path('electron/connection-tools.js')
s = p.read_bytes().decode('utf-8')
original = 'engine: ctx.engine, isActive: active,'
mutant = "engine: 'probe_wrong_engine', isActive: active,"
print('BEFORE original=' + str(s.count(original)) + ' mutant=' + str(s.count(mutant)))
assert s.count(original) == 1 and s.count(mutant) == 0, 'unexpected_mutation_target'
p.write_bytes(s.replace(original, mutant, 1).encode('utf-8'))
after = p.read_bytes().decode('utf-8')
print('AFTER original=' + str(after.count(original)) + ' mutant=' + str(after.count(mutant)))
'@ | python -
```

العد الحرفي — رمز خروج الزرع 0:

```text
BEFORE original=1 mutant=0
AFTER original=0 mutant=1
```

أمر المسبار المزروع:

```powershell
node scripts/connections-engine-probe.js --phase=allowed
```

خرج الحارس كما أعادته الطرفية — رمز الخروج 1. اختلاف الحروف في سطر actual/expected ناتج عن عرض فرق ANSI، وليس إعادة صياغة للرسالة:

```text
node scripts/connections-engine-probe.js --phase=allowed
PHASE allowed START
REPORT dist\connections-engine-probe-allowed.json
FAIL missing_engine_use_receipt
actual expected

'prcobde_wrong_enginex'
```

أمر الاستعادة كما نُفّذ:

```powershell
@'
from pathlib import Path
p = Path('electron/connection-tools.js')
s = p.read_bytes().decode('utf-8')
original = 'engine: ctx.engine, isActive: active,'
mutant = "engine: 'probe_wrong_engine', isActive: active,"
print('BEFORE_RESTORE original=' + str(s.count(original)) + ' mutant=' + str(s.count(mutant)))
assert s.count(original) == 0 and s.count(mutant) == 1, 'unexpected_restore_target'
p.write_bytes(s.replace(mutant, original, 1).encode('utf-8'))
after = p.read_bytes().decode('utf-8')
print('RESTORED original=' + str(after.count(original)) + ' mutant=' + str(after.count(mutant)))
report = Path('dist/connections-engine-probe-allowed.json')
Path('dist/connections-engine-probe-mutant.json').write_bytes(report.read_bytes())
print(report.read_text(encoding='utf-8'))
'@ | python -
```

العد بعد الاستعادة — رمز خروج الاستعادة 0:

```text
BEFORE_RESTORE original=0 mutant=1
RESTORED original=1 mutant=0
```

أمر التحقق بعد الاستعادة:

```powershell
node scripts/connections-engine-probe.js --phase=allowed
```

خرج التحقق — رمز الخروج 0 والتنظيف مكتمل:

```text
node scripts/connections-engine-probe.js --phase=allowed
PHASE allowed START
PHASE allowed PASS
REPORT dist\connections-engine-probe-allowed.json
PASS
```

## مطابقة الحزمة والقرائية

نجح الأمر `npm run dist:dir -- --config.directories.output=dist/connections-preview --publish never` برمز 0. الملف هو `dist/connections-preview/win-unpacked/Satr.exe` والإصدار 2.16.21. قورنت بايتات عشرة ملفات من app.asar بالمصدر بعد الاستعادة: الوحدات الأربع الجديدة، main/preload/Codex، وconnection-view/mcp-panel/app. تطابقت جميعاً. استخدم الاستخراج path.normalize لأن مسارات ASAR على Windows تحتوي شرطات خلفية.

قياس browser_readability في المعاينة: 23 عنصراً بلا مخالفة عند 390×650 و839×650. أول قياس بعد تغيير المقاس سبق الاستقرار وقرأ1×1 فلا يستخدم دليلاً؛ الإعادة المستقرة هي المذكورة. طلب عرض1000 حُدّ إلى839. السجل بلا أخطاء وطلبات المشهد الأربعة عشر رجعت200، بما فيها الخطوط.

التقرير التشخيصي `dist/connections-readability.json` غطى Light DOM للمكوّن نفسه في الوضعين dark/light عند390 و1000، وجميع counts وunseen صفر وtruncated=false. نماذج المصادقة واختيار المورد المغلقة لم تدخل هذا القياس؛ حارس UI فحص سلوكها، والقبول البشري لم ينفذ بعد. راجعت اللقطات المعرفات المعزولةLTR بعد إصلاح التفافها. أوقفت مهمتا المشهد والتطوير بعد الفحص.

## تشخيص التشفير الفعلي على Windows

شُغّل Electron 33.4.11 بعد app.ready مع safeStorage الحقيقي وcreateManager وcreateServices
من app.asar المبني 2.16.21. رمز اصطناعي وخدمة HTTP محقونة ومخزن ومجلد مشروع وuserData/sessionData
مؤقتة معزولة؛ لا حساب خدمة خارجي ولا قراءة لمخزن المستخدم. هذا قياس تشخيصي محفوظ في
`dist/connections-dpapi-evidence.json`، وليس حارساً جديداً في package.json.

القيم الفعلية: isEncryptionAvailable=true، auth.ok=true، selection.ok=true، envelope.enc=true،
rawContainsSynthetic=false، rawContainsAccount=false، publicConnection.hasTokenField=false،
readAfterDecrypt.ok=true، disconnect.ok=true. عادت حالة الفصل بلا حساب أو مورد. حُذف TEMP
بعد فحص parent والاسم وغياب ReparsePoint؛ cleanup.performed=true وtemporaryRemoved=true.

أُعيد البناء بعد توضيح صلاحيات GitHub وتصحيح unicode-bidi في إرشاد MCP القديم. أعيد
حارس الواجهة 8/8 مع قياس الثيمين وصفر counts/unseen وtruncated=false، وحارس codex-mcp-panel
نجح. يظل قياس العربية للمشهد المحدد دون النماذج المغلقة أو Shadow DOM القديم.
تقرير `dist/connections-artifact-evidence.json` يثبت تطابق عشرة ملفات في الحزمة النهائية؛
نواة التشفير لم تتغير بين البناءين.

## المحاولة الأخيرة للطقم وحدود البوابة

انتهت `dist/connections-full-suite-final.log` وعلامتها `.done` برمز 1 في 07:02:46
يوم 2026-09-08: 102/103. نجح term-longline هذه المرة، والفشل الوحيد test:opsroom-all
عند المجموعة الثانية test:worktrees بعد نجاح loop-mode. رسالة الفشل الحرفية:

```text
Error: wait timeout
    at Timeout.poll [as _onTimeout] (D:\sater\satr-2\scripts\worktrees-test.js:29:54)
    at listOnTimeout (node:internal/timers:635:17)
    at process.processTimers (node:internal/timers:571:7)
```

أعيد `npm run test:opsroom-all` مرة واحدة عبر runManagedProcess بمهلته القائمة 480000ms
دون تغيير الكود أو المهلة. اجتاز 12/12 خلال 125761ms، status=0 وtimedOut=false وreaped=true؛
السجل UTF-16LE في `dist/connections-opsroom-all-isolated.log` والنتيجة UTF-8 في
`dist/connections-opsroom-all-isolated-result.json`.

لم توجد محاولة كاملة خضراء في هذه الدفعة: الأولى 102/103 بسبب term-longline، والثانية 102/103
بسبب worktrees داخل opsroom-all، والمجموعتان اجتازتا الإعادة المحدودة. اختلاف الفشل لا يحدد
السبب الجذري ولا يثبت علاقته بالتوصيلات أو ينفيها. waitFor في worktrees تشترك به عدة حالات
بمهلة 3000ms ولا تسمّي الحالة الفاشلة، لذا لا يكفي السجل لنسبة العطل إلى deadline العامل.
لا حارس أو مهلة خُففت للحصول على النجاح، ولا محاولة ثالثة للطقم.

النسخة النهائية أُطلقت بالمهمة `term_25` مع ملف Chromium شخصي تحت `dist`؛ استجاب PID48148
بعنوان «سطر — Satr» وMainWindowHandle=3805192 وقت الفحص. هذا دليل إقلاع فقط؛ معايير
القبول البشري في acceptance-connections.md لم ينفذها المالك بعد. الفرع
`feat/project-connections`، والإصدار `2.16.21`، بلا commit أو نشر. بقيت تعديلات المالك الأصلية
في PRO-PLAN (+27) وMOBILE-CONTROL-PLAN (+8) والقرارات OBS-144..148 محفوظة.
