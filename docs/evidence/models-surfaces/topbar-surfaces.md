# دليل حارس قوائم الشريط — 2026-09-10

الحارس: `scripts/topbar-surfaces-test.js`.
النتيجة النهائية بعد توسيع حارس الفائض وحدود القوائم: **58/58**؛ Chromium حقيقي، `index.html` والقشرة و`topbar.js` ودرع المعاينة ولوحة المعاينة من الإنتاج. محاكاة `preload` قائمة؛ لا يثبت هذا الحارس عرض `WebContentsView` الأصلي، ولا قبول المالك البصري.

يقيس فتح الإعدادات والاختصارات وملخص الجلسة، والإغلاق بالزر وEscape والخارج، والتبادل بلا إفراج مؤقت، والتراكب مع «ما الجديد»، وإخفاء الأب، والبوابة، وقائمتي / و@ عبر المؤلف الإنتاجي، وعدم حجب صف الأدوات المضمّن. يراقب نداء `holdForModal` مع تمريره للأصل، ويثبت أن لوحة المعاينة ترسل `previewBounds(0,0,0,0)` حتى قبل أول تنقل.

كشف الحارس أثناء التطوير سباق ترقية المكونات: المرشح الحواري ظاهر قبل تحميل Shadow CSS، فيبقى الدرع على حالة قديمة. بعد إصلاح `whenDefined` نجح أول فتح للإعدادات. لا توجد دورة فتح/إغلاق تمهيدية تخفي هذا العطل في الحارس النهائي.

## العضّة على النسخة النهائية

المصدر الأصلي لم يُعدّل للعضّة. نُسخ ترميز الإنتاج إلى:
`dist/topbar-surfaces-mutation-20260910/baseline-index.html`
و`mutant-index.html` في المجلد نفسه؛ خيار `--index` يقدّم تلك النسخة فقط مع أصول الإنتاج.

أمر الزرع كما نُفّذ:

```powershell
$taskPath = 'D:\sater\satr-2\dist\topbar-surfaces-mutation-20260910\mutant-index.html'
$taskText = [IO.File]::ReadAllText($taskPath)
$taskOriginal = 'id="settingsPop" data-preview-overlay hidden'
$taskMutant = 'id="settingsPop" data-preview-overlay-disabled hidden'
[ordered]@{ originalBefore = ([regex]::Matches($taskText, [regex]::Escape($taskOriginal))).Count; mutantBefore = ([regex]::Matches($taskText, [regex]::Escape($taskMutant))).Count } | ConvertTo-Json
[IO.File]::WriteAllText($taskPath, $taskText.Replace($taskOriginal, $taskMutant), (New-Object Text.UTF8Encoding($false)))
$taskAfter = [IO.File]::ReadAllText($taskPath)
[ordered]@{ originalAfter = ([regex]::Matches($taskAfter, [regex]::Escape($taskOriginal))).Count; mutantAfter = ([regex]::Matches($taskAfter, [regex]::Escape($taskMutant))).Count } | ConvertTo-Json
npx electron scripts/topbar-surfaces-test.js --index dist/topbar-surfaces-mutation-20260910/mutant-index.html
```

العدّ: **الأصل 1 → 0؛ المتحوّر 0 → 1**.

خرج الفشل الحرفي (رمز الخروج 1):

```text
surface diagnostics: {"observed":{"current":null,"calls":[],"bounds":[]},"surfaces":[]} []
topbar-surfaces: AssertionError [ERR_ASSERTION]: settingsPop must hold preview while open
    at check (D:\sater\satr-2\scripts\topbar-surfaces-test.js:18:51)
    at main (D:\sater\satr-2\scripts\topbar-surfaces-test.js:117:5)
```

أمر الاستعادة وإعادة الاختبار كما نُفّذ:

```powershell
Copy-Item -LiteralPath dist\topbar-surfaces-mutation-20260910\baseline-index.html -Destination dist\topbar-surfaces-mutation-20260910\mutant-index.html
npx electron scripts/topbar-surfaces-test.js --index dist/topbar-surfaces-mutation-20260910/mutant-index.html
```

خرج الاستعادة (رمز الخروج 0):

```text
topbar-surfaces: PASS 41 checks (production DOM/topbar/shield; mocked preload; no native view claim).
```


## الانزياح الأفقي الذي كشفته النافذة الحية

التجربة الأصلية: `live_d3bbad85de1faa08ac90ba65`. قياس قبل الإصلاح: `scrollX=-536`، عرض الجذر **1424**، وعرض التمرير **136403**. مصدره عنصر xterm المخفي `xterm-char-measure-element` عند `left:-9999em`؛ وصل موضعه إلى **-134442.5px**.

في مقارنة CSSOM داخل النافذة نفسها، إضافة `#termHost { overflow:hidden }` وحدها أعادت عرض التمرير إلى **1424** و`scrollX=0` حتى بعد محاولة `scrollTo(-536,0)`. إزالة القاعدة أعادت **136403** و**-536**. اعتُمد احتواء المصدر في الطرفية، ولم تُضف قاعدة قص إلى جذر التطبيق.

ظهر فائض مستقل من شريط المعاينة عند التضييق: عرض التمرير **1038** مقابل نافذة **984**، وحقل `pvUrl` عرضه **22px** وموضعه **-14.0625px**. إضافة `.pv-head { flex-wrap:wrap }` و`#pvUrl { flex-basis:12rem }` مؤقتاً أعادت التمرير إلى **984** و`scrollX=0`، وصار حقل العنوان بعرض **333.4375px** وموضع **10px**. إلغاء التعديل أعاد الفائض. التنفيذ الإنتاجي المكافئ يستعمل `flex:1 1 12rem`.

توسّع الحارس إلى **46/46**: يفتح الطرفية الإنتاجية (xterm المضمّن) والمعاينة معاً، ويغيّر عرض Chromium إلى **1000 ثم 1440**، ويفتح الإعدادات ويغلقها مع استعادة التركيز، ويبدّل عرض الطرفية الشبكي والعربي. يقيس عرض تمرير الجذر وموضعه ويختبر عدم إزاحته بالتمرير البرمجي.

### عضّتا الفائض

ملف الزرع كما كُتب ونُفّذ: `dist/topbar-surfaces-mutation-20260910/plant-overflow.ps1`. يعمل على نسخ فقط، ومحتواه:

```powershell
param([ValidateSet('base','preview')][string]$Target)
$ErrorActionPreference = 'Stop'
$taskDir = 'D:\sater\satr-2\dist\topbar-surfaces-mutation-20260910'
if ($Target -eq 'base') {
  $taskSource = 'D:\sater\satr-2\src\styles\base.css'
  $taskExt = '.css'
  $taskOriginal = '  #termHost { flex: 1; min-height: 0; direction: ltr; position: relative; overflow: hidden; }'
  $taskMutant = '  #termHost { flex: 1; min-height: 0; direction: ltr; position: relative; overflow: visible; }'
} else {
  $taskSource = 'D:\sater\satr-2\src\ui\components\preview-panel.js'
  $taskExt = '.js'
  $taskOriginal = 'display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1h); padding: var(--space-2) var(--space-2h);'
  $taskMutant = 'display: flex; flex-wrap: nowrap; align-items: center; gap: var(--space-1h); padding: var(--space-2) var(--space-2h);'
}
$taskText = [IO.File]::ReadAllText($taskSource)
$taskBeforeOriginal = ([regex]::Matches($taskText,[regex]::Escape($taskOriginal))).Count
$taskBeforeMutant = ([regex]::Matches($taskText,[regex]::Escape($taskMutant))).Count
if ($taskBeforeOriginal -ne 1 -or $taskBeforeMutant -ne 0) { throw 'unexpected pattern counts' }
$taskFixed = Join-Path $taskDir ('fixed-' + $Target + $taskExt)
$taskMutantPath = Join-Path $taskDir ('mutant-' + $Target + $taskExt)
Copy-Item -LiteralPath $taskSource -Destination $taskFixed
[IO.File]::WriteAllText($taskMutantPath,$taskText.Replace($taskOriginal,$taskMutant),(New-Object Text.UTF8Encoding($false)))
$taskAfter = [IO.File]::ReadAllText($taskMutantPath)
[ordered]@{
  target = $Target
  originalBefore = $taskBeforeOriginal
  originalAfter = ([regex]::Matches($taskAfter,[regex]::Escape($taskOriginal))).Count
  mutantBefore = $taskBeforeMutant
  mutantAfter = ([regex]::Matches($taskAfter,[regex]::Escape($taskMutant))).Count
} | ConvertTo-Json

```

زرع فائض xterm وتشغيل الحارس:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File dist\topbar-surfaces-mutation-20260910\plant-overflow.ps1 -Target base
npx electron scripts/topbar-surfaces-test.js --styles dist/topbar-surfaces-mutation-20260910/mutant-base.css
```

العدّ كما طُبع: **originalBefore=1؛ originalAfter=0؛ mutantBefore=0؛ mutantAfter=1**. الفشل الحرفي، رمز الخروج 1:

```text
topbar-surfaces: AssertionError [ERR_ASSERTION]: terminal measurement must not overflow RTL document at 1000: {"width":1000,"scrollWidth":135979,"clientWidth":1000,"x":0,"afterScroll":-536,"rootX":536}
    at check (D:\sater\satr-2\scripts\topbar-surfaces-test.js:22:51)
    at main (D:\sater\satr-2\scripts\topbar-surfaces-test.js:249:7)
```

استعادة نسخة CSS ثم زرع شريط المعاينة دون التفاف:

```powershell
Copy-Item -LiteralPath dist\topbar-surfaces-mutation-20260910\fixed-base.css -Destination dist\topbar-surfaces-mutation-20260910\mutant-base.css
powershell.exe -NoProfile -ExecutionPolicy Bypass -File dist\topbar-surfaces-mutation-20260910\plant-overflow.ps1 -Target preview
npx electron scripts/topbar-surfaces-test.js --preview dist/topbar-surfaces-mutation-20260910/mutant-preview.js
```

العدّ كما طُبع: **originalBefore=1؛ originalAfter=0؛ mutantBefore=0؛ mutantAfter=1**. الفشل الحرفي، رمز الخروج 1:

```text
topbar-surfaces: AssertionError [ERR_ASSERTION]: terminal measurement must not overflow RTL document at 1000: {"width":1000,"scrollWidth":1047,"clientWidth":1000,"x":0,"afterScroll":-47,"rootX":47}
    at check (D:\sater\satr-2\scripts\topbar-surfaces-test.js:22:51)
    at main (D:\sater\satr-2\scripts\topbar-surfaces-test.js:249:7)
```

استعادة نسخة المعاينة وإثبات الإصلاحين معاً:

```powershell
Copy-Item -LiteralPath dist\topbar-surfaces-mutation-20260910\fixed-preview.js -Destination dist\topbar-surfaces-mutation-20260910\mutant-preview.js
npx electron scripts/topbar-surfaces-test.js --styles dist/topbar-surfaces-mutation-20260910/mutant-base.css --preview dist/topbar-surfaces-mutation-20260910/mutant-preview.js
```

الخرج النهائي، رمز الخروج 0:

```text
topbar-surfaces: PASS 46 checks (production DOM/topbar/shield; mocked preload; no native view claim).
```


## حدود القوائم بعد تغير عرض النافذة

أضيفت حالات الإعدادات والاختصارات وملخص الجلسة وهي مفتوحة عند عرض المحتوى **720 و984 و1424 ثم 984** وارتفاع **780**. عرض 720 ضمن الحد الأدنى المسموح في `electron/main.js` ويجبر شريط الأدوات على الالتفاف في محاكاة الواجهة. أما 984 و1424 فيطابقان عرض المحتوى الذي قيس في نافذتي ويندوز الخارجيّتين 1000 و1440. ظل اختبار فائض الطرفية على عرضي المحتوى 1000 و1440.

النتيجة النهائية الموسعة: **58/58**. تتضمن القياسات مواضع القوائم وحدودها أثناء حركة الظهور وبعد الانتقال؛ لم تُعطّل الحركة لإخفاء تجاوز. أثبت الحارس أثناء التطوير أن حساب `maxHeight` بالبكسل من ارتفاع نافذة قديم يمكن أن يترك البطاقة خارج الحد عند التضييق. إصلاح الإنتاج يستعمل ارتفاعاً مرتبطاً بـ`100vh` وقياسات مستقرة لا تتأثر بتحويل الحركة.

### عضّة تعطيل الملاءمة

أمر الزرع المنفذ:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File dist\topbar-surfaces-mutation-20260910\plant-fit.ps1
npx electron scripts/topbar-surfaces-test.js --topbar dist/topbar-surfaces-mutation-20260910/mutant-topbar.js
```

محتوى ملف الزرع كما نُفّذ، على نسخة مكوّن معزولة فقط:

```powershell
$ErrorActionPreference = 'Stop'
$taskSource = 'D:\sater\satr-2\src\ui\components\topbar.js'
$taskDir = 'D:\sater\satr-2\dist\topbar-surfaces-mutation-20260910'
$taskText = [IO.File]::ReadAllText($taskSource).Replace("`r`n","`n")
$taskOriginal = "function fitTopPop(element) {`n    if (element.hidden) return;"
$taskMutant = "function fitTopPop(element) {`n    return;`n    if (element.hidden) return;"
$taskBeforeOriginal = ([regex]::Matches($taskText,[regex]::Escape($taskOriginal))).Count
$taskBeforeMutant = ([regex]::Matches($taskText,[regex]::Escape($taskMutant))).Count
if ($taskBeforeOriginal -ne 1 -or $taskBeforeMutant -ne 0) { throw 'unexpected pattern counts' }
[IO.File]::WriteAllText((Join-Path $taskDir 'fixed-topbar.js'),$taskText,(New-Object Text.UTF8Encoding($false)))
$taskMutantPath = Join-Path $taskDir 'mutant-topbar.js'
[IO.File]::WriteAllText($taskMutantPath,$taskText.Replace($taskOriginal,$taskMutant),(New-Object Text.UTF8Encoding($false)))
$taskAfter = [IO.File]::ReadAllText($taskMutantPath)
[ordered]@{ originalBefore=$taskBeforeOriginal; originalAfter=([regex]::Matches($taskAfter,[regex]::Escape($taskOriginal))).Count; mutantBefore=$taskBeforeMutant; mutantAfter=([regex]::Matches($taskAfter,[regex]::Escape($taskMutant))).Count } | ConvertTo-Json

```

العدّ: **originalBefore=1؛ originalAfter=0؛ mutantBefore=0؛ mutantAfter=1**. لم تُثبت العضّة في محاولات 1000 و984 لأن الشريط لم يلتف في بيئة المحاكاة. بعد إضافة حد النافذة المدعوم 720، فشل الحارس كما يجب؛ هذه هي العضّة المعتمدة.

الفشل الحرفي، رمز الخروج 1:

```text
topbar-surfaces: AssertionError [ERR_ASSERTION]: settingsPop must fit viewport after resize to 720: {"maxHeight":"","scrollX":0,"animation":"0.18s cubic-bezier(0.2, 0.8, 0.3, 1) 0s 1 normal none running pop","transform":"matrix(0.985, 0, 0, 0.985, 0, 4)","visible":true,"left":18.988632202148438,"right":411.49571228027344,"top":101.25,"bottom":790.75,"width":720,"height":780}
    at check (D:\sater\satr-2\scripts\topbar-surfaces-test.js:24:51)
    at main (D:\sater\satr-2\scripts\topbar-surfaces-test.js:280:9)
```

أمر الاستعادة والتحقق النهائي المنفذ:

```powershell
Copy-Item -LiteralPath dist\topbar-surfaces-mutation-20260910\fixed-topbar.js -Destination dist\topbar-surfaces-mutation-20260910\mutant-topbar.js
npx electron scripts/topbar-surfaces-test.js
```

خرج النجاح النهائي، رمز الخروج 0:

```text
topbar-surfaces: PASS 58 checks (production DOM/topbar/shield; mocked preload; no native view claim).
```


## مزامنة الحارس مع الرسم بعد الطقم الكامل

كشف الطقم الكامل الأول حالة مختلفة في نافذة الحارس المخفية: حفظت الملاءمة موضعاً قديماً (`maxHeight=max(0px, -66.2969px + 100vh)`) بينما قياس الحدود فرض التخطيط الملفوف الجديد، وبقيت حركة الظهور عند تحويل البداية بعد انتظار 220ms. كانت البطاقة تتجاوز ارتفاع 780. لم تُخفَّف حدود الفحص.

صار الحارس يستخدم رسم Chromium `offscreen`، وينتظر إطارين فعليين عبر `requestAnimationFrame` بعد تغير الحجم قبل قراءة الحدود، عوض انتظار 220ms. هذا يعطي دورة التخطيط والرسم و`ResizeObserver` فرصتها الفعلية في نافذة اختبار لا تُعرض. لم يتطلب هذا التصحيح تغييراً إضافياً في `topbar.js` الإنتاجي.

ظل العطل المزروع أحمر في نمط الرسم الجديد. أعيد أمر الزرع نفسه:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File dist\topbar-surfaces-mutation-20260910\plant-fit.ps1
npx electron scripts/topbar-surfaces-test.js --topbar dist/topbar-surfaces-mutation-20260910/mutant-topbar.js
```

العدّ: **الأصل 1→0؛ المتحوّر 0→1**. الفشل الحرفي، رمز الخروج 1:

```text
topbar-surfaces: AssertionError [ERR_ASSERTION]: settingsPop must fit viewport after resize to 720: {"maxHeight":"","scrollX":0,"animation":"0.18s cubic-bezier(0.2, 0.8, 0.3, 1) 0s 1 normal none running pop","transform":"matrix(0.999252, 0, 0, 0.999252, 0, 0.199515)","visible":true,"left":16.149063110351562,"right":414.33534240722656,"top":92.46136474609375,"bottom":791.9376831054688,"width":720,"height":780}
    at check (D:\sater\satr-2\scripts\topbar-surfaces-test.js:24:51)
    at main (D:\sater\satr-2\scripts\topbar-surfaces-test.js:280:9)
```

الاستعادة والتحقق من الثبات كما نُفّذا:

```powershell
Copy-Item -LiteralPath dist\topbar-surfaces-mutation-20260910\fixed-topbar.js -Destination dist\topbar-surfaces-mutation-20260910\mutant-topbar.js
npx electron scripts/topbar-surfaces-test.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npx electron scripts/topbar-surfaces-test.js
```

نجحت الجولتان المتتاليتان، **58/58** لكل جولة، ورمز الخروج **0**:

```text
topbar-surfaces: PASS 58 checks (production DOM/topbar/shield; mocked preload; no native view claim).
topbar-surfaces: PASS 58 checks (production DOM/topbar/shield; mocked preload; no native view claim).
```
