# أدلة تشخيص تعثر الطقم — 2026-09-09

## النتيجة وحدودها

أُضيف تشخيص إلى `scripts/worktrees-test.js` وحده، مع بقاء منطق الإنتاج ومهلة الانتظار
`3000ms` ومهل العامل `1000/30ms` كما كانت. لا رفع للمهلة ولا إعادة محاولة جديدة.
الاختبار يشغّل `electron/executor.js` ومدير `electron/worktrees.js` الفعليين بمستودعات مؤقتة.

النتيجة السابقة `102/103` بقيت فاشلة برمز `1`. الخطأ المحفوظ
`Error: wait timeout` عند `scripts/worktrees-test.js:29` لا يسمّي السيناريو أو الحالة
أو عملية Git. نجاح الإعادة المنفردة، ونجاح `opsroom-all` السابق، لا يحددان سببه.
لم يُعَد `test:full` أو `test:opsroom-all` ضمن هذا التحقيق، ولم تُستأنف تجارب التوصيلات.

هذا التغيير يجعل التعثر التالي قابلاً للتشخيص على مستوى مرحلة المدير؛ لا يثبت أن
Git بطيء أو أن فشل تنظيف وقع في التشغيل التاريخي. لم تُقَس أوامر Git المفردة أو ضغط
المعالج أو أحداث نظام التشغيل؛ كل مرحلة قد تحتوي عدة أوامر. الحالتان المزروعتان أدناه
أدلة على قدرة الحارس على التمييز، وليستا إعادة إنتاج للسبب التاريخي.

## سبب غموض الرسالة القديمة — من الكود

- ينتظر الحارس حالة بعينها؛ الحالة النهائية الخاطئة كانت تنتهي برسالة المهلة نفسها.
- `electron/executor.js` يلغي مؤقت العامل عند دخول `capturing`، ثم ينتظر
  `diff → patch → remove` قبل نشر الحالة النهائية.
- `electron/gitdiff.js` يحدد مهلة أمر Git الواحد بـ `15000ms`،
  و`electron/worktrees.js` بـ `30000ms`. هذه حدود الإنتاج وليست قياسات للواقعة.
- تنظيف الاختبار في `finally` قد يبدأ بينما الالتقاط لا يزال معلقاً؛ لذلك تُطبع
  لقطة التشخيص الآن قبل دخول التنظيف. خطأ يأتي بعد هذه اللقطة لا ينسب تلقائياً
  إلى سبب الفشل الأول.

## ما تغيّر

كل انتظار يحمل اسم السيناريو والحالة المطلوبة. الحالة النهائية المخالفة تسقط فوراً
بـ `unexpected terminal state`، والانتظار الذي لم يبلغ حالة نهائية يسقط
بـ `wait timeout`. يسبق `finally` سجل `[worktrees-wait]` يحوي:

- `scenario / expected / actual / failure_code / error`.
- الزمن المنقضي وميزانية الانتظار.
- آخر استدعاء لكل من `create / diff / patch / remove`: مدته، هل ما زال معلقاً،
  ورمز خطئه، أو `null` إن لم يبدأ.

القياس يلفّ مدير الإنتاج داخل الحارس ويعيد نتائجه نفسها. في النجاح يطبع
`[worktrees-phases]` أعلى مدة لكل مرحلة باختصار؛ القيم تخص هذه الإعادة فقط.
البحث في `scripts/*test.js` لم يجد حارساً يثبت بنية دالة الانتظار القديمة في هذا الملف.

## التشغيل السليم

الأمر قبل الزرع وبعد استعادة الزرعين:

```powershell
npm run test:worktrees
```

قبل الزرع: رمز الخروج `0`، وخرج القياس:

```text
[worktrees-phases] max_ms={"create":368,"diff":340,"patch":157,"remove":147}
```

بعد الاستعادة النهائية: رمز الخروج `0`، والخرج الحرفي:

```text
[worktrees-phases] max_ms={"create":320,"diff":330,"patch":152,"remove":138}
✓ detached worktree lifecycle and bounded diff
✓ executor writes only inside the isolated worktree
✓ two explicitly labelled runners share the same isolation policy
✓ missing, unlabeled, or malformed runners fail before worktree creation
✓ completed execution returns diff without automatic merge
✓ timeout, one-shot capped extension, and interrupt clean worktrees
✓ outside write paths fail closed
✓ sdk-only malformed marker tolerated; reset needs real success; unmarked/forbidden/marker+path/failed-exec stay fail-closed
```

نجح `git diff --check -- scripts/worktrees-test.js` بلا أخطاء فرق.
لم يُغيَّر إصدار أو ملف إنتاج أو ملف قبول التوصيلات.

## العضّة الأولى — تأخير patch في سيناريو initial-edit

زرع داخل غلاف القياس الاختباري؛ يجعل استدعاء `patch` لهذا السيناريو ينتظر
`3500ms` قبل استدعاء الإنتاج. لا تعديل في دالة الإنتاج أو مهلة الحارس.

أمر الزرع كما نُفّذ:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
from pathlib import Path
p=Path('scripts/worktrees-test.js')
s=p.read_text(encoding='utf-8')
a="        const result = await original(...args);"
b="        const result = phase === 'patch' && path.basename(options.root) === 'store-execution'\n          ? await new Promise((resolve) => setTimeout(resolve, 3500)).then(() => original(...args)) : await original(...args);"
print('before source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==1 and s.count(b)==0
s=s.replace(a,b,1)
p.write_text(s,encoding='utf-8',newline='\r\n')
s=p.read_text(encoding='utf-8')
print('after source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==0 and s.count(b)==1
'@ | python -
```

العدّ الحرفي؛ `source` هو الأصل و`replacement` المتحور:

```text
before source=1 replacement=0
after source=0 replacement=1
```

أمر الحارس: `npm run test:worktrees`؛ رمز الخروج `1`.
الفشل الحرفي قبل تنظيف الاختبار:

```text
> satr@2.16.21 test:worktrees
> node scripts/worktrees-test.js

[worktrees-wait] {"scenario":"initial-edit","expected":"completed","actual":"capturing","failure_code":"","error":"","elapsed_ms":3014,"timeout_ms":3000,"phases":{"create":{"pending":false,"elapsed_ms":340,"error":""},"diff":{"pending":false,"elapsed_ms":298,"error":""},"patch":{"pending":true,"elapsed_ms":2687,"error":""},"remove":null}}
Error: wait timeout: scenario=initial-edit expected=completed actual=capturing failure_code=none
    at fail (D:\sater\satr-2\scripts\worktrees-test.js:79:14)
    at Timeout.poll [as _onTimeout] (D:\sater\satr-2\scripts\worktrees-test.js:86:47)
    at listOnTimeout (node:internal/timers:635:17)
    at process.processTimers (node:internal/timers:571:7)
```

أمر الاستعادة كما نُفّذ، موضعياً دون checkout/reset:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
from pathlib import Path
p=Path('scripts/worktrees-test.js')
s=p.read_text(encoding='utf-8')
a="        const result = phase === 'patch' && path.basename(options.root) === 'store-execution'\n          ? await new Promise((resolve) => setTimeout(resolve, 3500)).then(() => original(...args)) : await original(...args);"
b="        const result = await original(...args);"
print('before source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==1 and s.count(b)==0
s=s.replace(a,b,1)
p.write_text(s,encoding='utf-8',newline='\r\n')
s=p.read_text(encoding='utf-8')
print('after source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==0 and s.count(b)==1
'@ | python -
```

العدّ الحرفي للاستعادة؛ `source` هنا المتحور و`replacement` الأصل:

```text
before source=1 replacement=0
after source=0 replacement=1
```

النتيجة: `actual=capturing` و`patch.pending=true`، بينما `remove=null`.
بذلك تُعرف المرحلة المعلقة قبل أن يؤثر تنظيف الاختبار في العمليات المتبقية.

## العضّة الثانية — فشل remove في سيناريو initial-edit

زرع داخل غلاف القياس يعيد `{ok:false,error:'remove_failed'}` بدلاً من استدعاء
الإزالة لهذا السيناريو. تنظيف `removeAll` الأصلي ينظف المستودع المؤقت في النهاية.

أمر الزرع كما نُفّذ:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
from pathlib import Path
p=Path('scripts/worktrees-test.js')
s=p.read_text(encoding='utf-8')
a="        const result = await original(...args);"
b="        const result = phase === 'remove' && path.basename(options.root) === 'store-execution'\n          ? { ok: false, error: 'remove_failed' } : await original(...args);"
print('before source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==1 and s.count(b)==0
s=s.replace(a,b,1)
p.write_text(s,encoding='utf-8',newline='\r\n')
s=p.read_text(encoding='utf-8')
print('after source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==0 and s.count(b)==1
'@ | python -
```

العدّ الحرفي؛ `source` الأصل و`replacement` المتحور:

```text
before source=1 replacement=0
after source=0 replacement=1
```

أمر الحارس: `npm run test:worktrees`؛ رمز الخروج `1`.
الفشل الحرفي:

```text
> satr@2.16.21 test:worktrees
> node scripts/worktrees-test.js

[worktrees-wait] {"scenario":"initial-edit","expected":"completed","actual":"cleanup_failed","failure_code":"cleanup_failed","error":"تعذّر تنظيف نسخة العمل المعزولة.","elapsed_ms":470,"timeout_ms":3000,"phases":{"create":{"pending":false,"elapsed_ms":265,"error":""},"diff":{"pending":false,"elapsed_ms":287,"error":""},"patch":{"pending":false,"elapsed_ms":138,"error":""},"remove":{"pending":false,"elapsed_ms":0,"error":"remove_failed"}}}
Error: unexpected terminal state: scenario=initial-edit expected=completed actual=cleanup_failed failure_code=cleanup_failed
    at fail (D:\sater\satr-2\scripts\worktrees-test.js:79:14)
    at Timeout.poll [as _onTimeout] (D:\sater\satr-2\scripts\worktrees-test.js:85:51)
    at listOnTimeout (node:internal/timers:635:17)
    at process.processTimers (node:internal/timers:571:7)
```

أمر الاستعادة كما نُفّذ:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
from pathlib import Path
p=Path('scripts/worktrees-test.js')
s=p.read_text(encoding='utf-8')
a="        const result = phase === 'remove' && path.basename(options.root) === 'store-execution'\n          ? { ok: false, error: 'remove_failed' } : await original(...args);"
b="        const result = await original(...args);"
print('before source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==1 and s.count(b)==0
s=s.replace(a,b,1)
p.write_text(s,encoding='utf-8',newline='\r\n')
s=p.read_text(encoding='utf-8')
print('after source=%d replacement=%d' % (s.count(a), s.count(b)))
assert s.count(a)==0 and s.count(b)==1
'@ | python -
```

العدّ الحرفي للاستعادة؛ `source` المتحور و`replacement` الأصل:

```text
before source=1 replacement=0
after source=0 replacement=1
```

النتيجة: سقط قبل مهلة `3000ms` عند `470ms`، وسمّى `cleanup_failed` مع
`remove.error=remove_failed`. الفشل النهائي لم يعد يُعرض كأنه انتظار مجهول السبب.

الزرعان أُزيلا، ولم تُترك شروط حقن أعطال في الاختبار. تبقى علة الفشل التاريخي
غير محسومة إلى أن يظهر دليل يحددها.

## تعثر الطقم الحالي في promocapture-live — 2026-09-09

هذه جولة مستقلة عن تعثر worktrees التاريخي أعلاه. انتهى الطقم الخارجي المحفوظ في `dist/batch-final-full-20260909-020215.log` عند `2026-09-09 02:11:39`؛ سجله بترميز UTF-16LE، وعلامة `dist/batch-final-full-20260909-020215.log.done` تحمل `1`. بلغ المجموعة `103/103` وسجل فشلاً واحداً هو `test:promocapture-live`: أي `102/103` ناجحة ورمز خروج `1`، وليست بوابة خضراء.

في المجموعة `[64/103]` فشل الاختبار مرتين وفق إعادة OBS-036 القائمة. الحقول المشتركة بين محاولتي الفشل:

```text
stopped.ok=true · tracks=1 · frameRate=30 · size=0 · head=[]
```

انتهى السجل بالخرج ASCII التالي، وعلامة الاكتمال أكدت رمز الخروج نفسه:

```text
- test:promocapture-live: 1
=== SUITE_EXIT=1 ===
ended=2026-09-09 02:11:39
```

نجح `test:promo-studio` اللاحق في الجولة وأنتج `571069 bytes (mp4)`. هذا يثبت نجاح مسار ترميز آخر في الجولة، ولا يحسم سبب إخراج مسجّل الالتقاط صفراً. السجل القديم لا يحوي عدّ إطارات أو خطأ MediaRecorder؛ وصف «النافذة لم تُرسم» كان استنتاجاً من حجم Blob، ولا يكفي لإثبات السبب البيئي.

### التشغيل المنفرد قبل تحسين التشخيص

الأمر الفعلي:

```powershell
npm run test:promocapture-live
```

رمز الخروج `0`؛ الخرج الحرفي (إيصال الأداة `18a00c`):

```text
promocapture-live: ERR_FAILED=false · stream=ok · fps=30 · getSources=self-id-fallback · mime=video/mp4;codecs=avc1.42e01e · bytes=83151 · close=ok
```

### تحسين التشخيص وحدوده

تغير `scripts/promocapture-live-test.js` وحده في هذا التحقيق (`+37/-8`):

- عدّ اختياري للإطارات عبر `MediaStreamTrackProcessor` على `track.clone()`؛ لا يستهلك المسار الأصلي. تُغلق الإطارات ويُلغى القارئ ويُوقف المسار المستنسخ عند النهاية.
- تسجيل `dataEvents` و`recorderError` وحالة المسار، مع حالة نافذة المصدر عند الفشل.
- صارت رسالة Blob الفارغ تصرح بأن سبب الالتقاط أو الترميز غير محسوم.
- صُححت دلالة `stopped.ok`: الحارس يستدعي `downloadResult(promo_recording_saved)` بحقن اختباري حتى عندما يكون Blob فارغاً، فلا يثبت ذلك حفظ ملف إنتاجي. الإنتاج في `preview-panel.js` يرفض Blob الفارغ عبر `promoCaptureAbort(..., 'empty_recording')`.

بقي انتظار التسجيل `1200ms` و`readyDelayMs=300` و`rec.start(100)` ومعيار Blob والترويسة كما كانت، ولم تتغير سياسة retry. لم يُضف assertion أو حارس جديد؛ الإضافة سجل تشخيص فقط، ولذلك لا توجد عضّة جديدة لهذا التغيير.

### التشغيل المنفرد بعد تحسين التشخيص

أُعيد الأمر نفسه؛ رمز الخروج `0`، والخرج الحرفي (إيصال الأداة `020805`):

```text
promocapture-live: ERR_FAILED=false · stream=ok · fps=30 · getSources=self-id-fallback · mime=video/mp4;codecs=avc1.42e01e · bytes=91384 · diagnostics={"dataEvents":3,"recorderError":null,"frameProbe":"active","frames":85,"trackState":"live","trackMuted":false,"recorderState":"inactive"} · close=ok
```

الأمر `git diff --check -- scripts/promocapture-live-test.js` نجح برمز `0` بلا خرج. العدّ `85` يثبت وصول إطارات إلى المسار المستنسخ في هذه الإعادة، ولا يقيس إطارات دخلت الترميز داخلياً أو يفسر ما وقع في محاولتي الطقم السابقتين. عدم توفر `MediaStreamTrackProcessor` يُطبع صراحةً ولا يحوّل عدم القياس إلى نجاح.

سبب فشل الطقم مرتين ما زال غير محسوم. النجاحان المنفردان لا يبدلان رمز الطقم `1`، ولا يُنسب هذا التعثر لإصلاح التوصيلات أو الجوال دون قياس جديد. يلزم أخذ التشخيص المضاف من إعادة الطقم التالية إذا تكرر التعثر؛ لم يُعد الطقم الكامل ضمن هذا التحقيق.

## البوابة النهائية بعد الإصلاحات

نجح dist/final-gate-20260909-023207.log: 103/103، SUITE_EXIT=0 وعلامة done=0، بلا إعادة فعلية. نجح promocapture-live بـ97271 bytes و91 frames و3 dataEvents وrecorderError:null. لا تمحو هذه الجولة فشل المحاولات السابقة ولا تحدد سببه؛ [البصمات والحزمة وحدود التسليم](FINAL-BATCH-TEST-EVIDENCE.md).

## بوابة تصحيحات PWA الأخيرة — 2026-09-09

السجل dist/final-v15-gate.log:103/103 وSUITE_EXIT=0 وdone=0، من03:20:25 إلى03:30:04. حصلت إعادة فعلية واحدة لـpreview-member-live وفق OBS-101، بعد AssertionError: «التنقّل بالنقر لم يُرصد تكيفياً: 489ms». الشرط في scripts/preview-member-live-test.js:398 يجمع ok وnavigated وحداً أقل من300ms؛ لم تُطبع القيمتان المنطقيتان فلا نحسمهما من الرسالة. نجحت الإعادة بلا تغيير مصدر أو مهلة. source/tests ثابتة طوال الطقم؛ تغيرت وثيقة SW وحدها أثناء إكمال دليلها. لا يُستنتج سبب بيئي أو إنتاجي من نجاح الإعادة؛ [الحزمة والحدود](FINAL-BATCH-TEST-EVIDENCE.md).
