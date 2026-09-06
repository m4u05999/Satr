# بوابة Electron 44 — الدفعة ١

تاريخ القياس: **2026-09-05**. البيئة: Windows x64، داخل
`D:\sater\satr-2-codex` حصراً. الفرع `feat/electron-44-gate` من `origin/main`
عند `beaf5be5c0bc83d34cc730248a5d1f4cf41d5a0f` بعد `git fetch origin main`
ثم `git checkout -B feat/electron-44-gate origin/main`؛ الشجرة كانت نظيفة.
الأساس المقروء: [مسبار الترقية](ELECTRON-UPGRADE-SPIKE.md).

**النتيجة: محجوب عند حافظة العربية المشكّلة في Electron 44.** نجحت ملفات PTY الجاهزة
ومرآة RTL والإقلاع المحدود زمنياً، لكن علاج التشكيل سقط فعلياً. حاجز toolchain لم يثبت،
ولم تُجرَ إعادة بناء أو إصلاح. هذا حكم بوابة قياس، وليس اعتماد ترقية أو نسخة توزيع.

## جدول البوابة

| البند | الحالة | الدليل المقيس |
|---|---|---|
| ١: Electron وحده في البيان | نجح | `devDependencies.electron: ^33.0.0 → 44.2.0`؛ لا تغيير آخر في `package.json` |
| التثبيت | نجح | `npm install`: رمز 0؛ `added 6 packages, removed 33 packages, changed 7 packages, and audited 478 packages in 23s` |
| ثبات القيود | نجح | `npm ls`: Electron `44.2.0`، builder `25.1.8`، node-pty `1.1.0`؛ النطاقان `^25.0.0` و`^1.1.0` و`npmRebuild:false` باقية |
| ٢: ABI من التشغيل | نجح | `electron=44.2.0`, `chrome=152.0.7977.76`, `node=24.20.0`, `modules=149`, `napi=10`؛ مطابق للمسبار |
| ٣: تحميل node-pty | نجح | `REQUIRE_OK node-pty=1.1.0`؛ مسار الإضافة المحمّلة فعلاً تحت `prebuilds/win32-x64` أدناه |
| spawn PowerShell | نجح | 5 دورات أولى + 5 دورات إعادة لتسجيل مسار الإضافة بعد التحميل الكسول؛ 10/10 عمليات حقيقية |
| الخرج العربي | نجح | `مرحبا بالعربية` مطابق حرفياً في 10/10؛ `arabicExact:true` |
| write | نجح | عادت `INPUT=gate-input-1` حتى `INPUT=gate-input-5` في الجولتين؛ ليست مطابقة صدى الأمر وحده |
| resize | نجح | `80×24 → 101×31`؛ الصدفة نفسها أعادت `WIDTH=101` في 10/10؛ ارتفاع 31 من خاصية PTY، لا قياس مستقل من الصدفة |
| الخروج المتكرر | نجح ضمن العينة | كل الصدف خرجت بالرمز المقصود `7`؛ المسبار خرج بـ0 في الجولتين؛ لا انهيار في هاتين الجولتين |
| عمليات يتيمة بعد الدورات | نجح ضمن العينة | فحص CIM بعد الجولة الأولى: `REMAINING=0` للصدف الخمس ومساعدات node-pty ذات المسار داخل هذه الشجرة؛ بعد الثانية فحص الصدف العشر: `PTY_SHELLS_REMAINING=0` |
| ٤: `npm run test:termjobs` | نجح | رمز 0 على Node النظام؛ إعادة الحارس نفسه داخل Electron 44 أيضاً رمز 0 |
| `npm run test:termjobs-done` | نجح | رمز 0 على Node النظام وداخل Electron 44؛ 8 أسطر نتائج ناجحة في كل تشغيل |
| `npm run test:term-longline` | نجح على Node فقط | 58 فحصاً ورمز 0 على Node `26.5.0`؛ لا يثبت ذلك مسار حافظة Electron |
| الحارس نفسه داخل Electron 44 | فشل | اللصق: حركات وصلت **0** مقابل **4** على Node، والأساس وصل `true`؛ فشل AssertionError حرفياً أدناه |
| تنبؤ حذف availableFormats | نجح تأكيد التنبؤ | `typeof clipboard.availableFormats === 'undefined'`؛ الاستدعاء المباشر أعاد `TypeError: clipboard.availableFormats is not a function` |
| ٥: `npm run test:rtl-preview` | نجح | `locale=ar`؛ 3/3 مستطيلات مطابقة تماماً، خطأ x والعرض =0 في كل حالة؛ الأرقام أدناه |
| ٦: `npm start` بمهلة | نجح ضمن 20 ثانية | `EXITED_BEFORE_20S=False`؛ PID `35480` بعنوان `سطر — Satr` و`Responding=True`؛ لا استثناء JavaScript ظاهر في main؛ أخطاء الكاش والتحذير أدناه |
| البناء والتوزيع و`test:full` | لم يُقَس | خارج هذه الدفعة؛ لم تُشغّل هذه الأوامر |

## هوية التشغيل وملفات PTY

المسبار الجديد [electron-44-gate-probe.js](../scripts/electron-44-gate-probe.js)
يطبع `process.versions` داخل `app.whenReady()`، وليس عبر `ELECTRON_RUN_AS_NODE`
ولا من الترويسات. أوضاعه قارئ أدلة ومشغّل للحرّاس القائمة، وليس حارساً جديداً؛
لم يُزرع أي عطل في الإنتاج. رمز 0 للمسبار لا يغني عن قراءة حقوله وخرج الصدفة.

```text
RUNTIME {"executable":"D:\\sater\\satr-2-codex\\node_modules\\electron\\dist\\electron.exe","platform":"win32","arch":"x64"}
electron=44.2.0 chrome=152.0.7977.76 node=24.20.0 modules=149 napi=10
REQUIRE_OK node-pty=1.1.0
NATIVE {"file":"D:\\sater\\satr-2-codex\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node","bytes":312320,"sha256":"ee8f4e6f4dad71939eecfda11de249400e34bfefe4c8b48af13f3b5476f4035b"}
```

طابق الهدف جدول المسبار في القيم الخمس أعلاه. **لم أعد تشغيل 33** لإثبات 130 حيّاً؛
130 باقٍ قياس ترويسات المسبار، لا نتيجة تشغيل جديدة هنا.

المحمّل كسول: قائمة `.node` كانت فارغة فور require، لذا نُقل تسجيل `require.cache`
إلى ما بعد spawn وأُعيدت الدورات. `build/Release` لا يحتوي ملفات `.node`، وإنما
`conpty/conpty.dll` و`OpenConsole.exe` فقط. النسخة المحمّلة مثبتة بالمسار أعلاه؛
لم يُستدعَ rebuild أو node-gyp ولم تتغير نسخة node-pty. لا DLL مفقود رُصد في التحميل
أو spawn، ولذلك لا يوجد اسم/مسار DLL مفقود للإبلاغ عنه.

| الجولة | PIDs بالترتيب | العربية والإدخال والعرض | رموز خروج الصدف |
|---|---|---|---|
| الأولى | 11576, 33852, 30776, 33728, 18868 | 5/5 | 7,7,7,7,7 |
| تسجيل الإضافة المحمّلة | 35124, 31620, 33480, 17740, 34256 | 5/5 | 7,7,7,7,7 |

هذا إغلاق طبيعي متكرر بأمر `exit 7`، وليس إثباتاً لكل مسارات kill أو إنهاء التطبيق
أثناء عمل الطرفية. فحص عدم اليتم عينة بعد التشغيل، وليس تتبعاً مستمراً لكل ذرية النظام.

أول تشغيل طبع `Downloading Electron binary...` ثم نجح. تغير lock يشمل شجرة أدوات
تنزيل Electron وtypes وحذف القديم وإعادة ترتيب الاعتماديات؛ لاحظت أيضاً dedup وترقية
`semver` إلى `7.8.5` أثناء `npm install`. لم أغيّر أي اعتماد مباشر آخر أو أشغّل audit fix.
خرج npm أفاد `21 vulnerabilities (1 low, 4 moderate, 15 high, 1 critical)`؛ ليس هذا
تدقيقاً أمنياً جديداً أو عزواً لهذه الأعداد إلى ترقية Electron.

## الحرّاس وتنبؤ الحافظة

الأوامر الثلاثة في `package.json` تبدأ بـ`node`، لذا شُغلت حرفياً أولاً، ثم شُغلت
الملفات نفسها دون تعديل تحت Electron الحقيقي بهذه الأوامر:

```powershell
npx --no-install electron scripts/electron-44-gate-probe.js pty
npm run test:termjobs
npm run test:termjobs-done
powershell.exe -NoProfile -Sta -Command "Set-Clipboard -Value 'satr-term-longline-fixture'; Get-Clipboard"
npm run test:term-longline
npx --no-install electron scripts/electron-44-gate-probe.js test termjobs-test.js
npx --no-install electron scripts/electron-44-gate-probe.js test termjobs-done-test.js
powershell.exe -NoProfile -Sta -Command "Set-Clipboard -Value 'satr-term-longline-fixture'; Get-Clipboard"
npx --no-install electron scripts/electron-44-gate-probe.js test term-longline-test.js
npx --no-install electron scripts/electron-44-gate-probe.js clipboard
```

طبع `Get-Clipboard` النص المعروف `satr-term-longline-fixture` قبل كل تشغيل longline؛
الحارس القائم يطبّع الحافظة أيضاً وفق OBS-118. لم يُقرأ محتوى المستخدم السابق أو يُحفظ.

خرج الحارس داخل Electron حرفياً:

```text
    قياس الالتفاف: أسطر عربية=2 · تبدأ بحركة عارية=1 · حركات وصلت=3
    قياس اللصق: حركات وصلت=0 · الأساس وصل=true
  ✗ الحركات المُلصقة تصل بعد علاج OBS-106 (العنقود سليم لا يُفكّ) — عاد العطل القديم: الحركات ساقطة — الذيل: "MARK<بب>'\r\nMARK<بب>\r\nPS D:\\sater\\satr-2-codex> "
term-longline: FAIL: AssertionError [ERR_ASSERTION]: الحركات المُلصقة تصل بعد علاج OBS-106 (العنقود سليم لا يُفكّ) — عاد العطل القديم: الحركات ساقطة — الذيل: "MARK<بب>'\r\nMARK<بب>\r\nPS D:\\sater\\satr-2-codex> "
    at new AssertionError (node:internal/assert/assertion_error:380:5)
    at ok (D:\sater\satr-2-codex\scripts\term-longline-test.js:48:9)
    at main (D:\sater\satr-2-codex\scripts\term-longline-test.js:425:5)
AVAILABLE_FORMATS_TYPE undefined
CLIPBOARD_ERROR TypeError: clipboard.availableFormats is not a function
```

الإنتاج يبتلع استثناء availableFormats في `clipboardSnapshot()` ويعيد null؛ لذلك
رسالة TypeError أعلاه من استدعاء API مباشرة في المسبار، **لا من سجل الإنتاج**.
فشل وصول الحركات مقيس بالحارس الذي يستدعي `electron/term.js` نفسه دون تعديل.
على Node وصل في المقابل `حركات وصلت=4 · الأساس وصل=true` ونجحت الفحوص الـ58.

ظهر في longline **ثلاث مرات في كل بيئة** (Node النظام وElectron) التشخيص التالي:

```text
D:\sater\satr-2-codex\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
                         ^

Error: AttachConsole failed
    at Object.<anonymous> (D:\sater\satr-2-codex\node_modules\node-pty\lib\conpty_console_list_agent.js:13:26)
```

هذا فشل مساعد تعداد عمليات الكونسول أثناء الحارس، ولم يمنع إقلاع المهام أو نجاح
الحارس على Node. لا دليل هنا على DLL مفقود أو ضرورة rebuild، ولا يصح نسبته إلى
Electron 44 وحده. لم يُصلح أو يُشخّص أبعد من ذلك.

بعد AssertionError ظل Electron الخاص بـlongline حياً؛ لا أدّعي خروجاً نظيفاً له.
تحققت من CommandLine لـPID `33740` ثم نظفت شجرته بـ`taskkill /PID 33740 /T /F`؛
انتهت جلسة الأمر برمز 1 بعد التنظيف القسري، وليس هذا رمز خروج طبيعي مثبت للحارس.
هذا منفصل عن نجاح الخروج الطبيعي في دورات مسبار PTY.

## مرآة RTL

الأمر `npm run test:rtl-preview` شغّل الوحدة الإنتاجية مع `--ar` الذي يضبط `lang=ar`،
وطبع `locale: ar` بالفعل. القياس من لقطة سطح المكتب بالحارس القائم وتسامحه ±12 DIP:

| x المطلوب | العرض المطلوب | x المقيس | العرض المقيس | فرق x / العرض |
|---:|---:|---:|---:|---:|
| 0 | 300 | 0 | 300 | 0 / 0 |
| 380 | 260 | 380 | 260 | 0 / 0 |
| 560 | 320 | 560 | 320 | 0 / 0 |

```text
rtl-preview-fix-test: نجح — العرض الأصلي في موضعه الصحيح (locale=ar)
(electron) 'console-message' arguments are deprecated and will be removed. Please use Event<WebContentsConsoleMessageEventParams> object instead.
```

رمز الخروج 0. التعويض القائم صالح لهذه الحالات على الهدف؛ **لم يُعدّل**.
هذا قياس آلي قائم، لا قبول بشري أو قياس مستقل لـDPI واللغات والأذونات والـresize.

## إقلاع التطبيق

شُغّل `npm start` من هذه الشجرة بواسطة `Start-Process` مخفي للطرفية، مع تسجيل stdout
وstderr في `%TEMP%/satr-electron-44-start.*.log` و`WaitForExit(20000)`.
لم يخرج خلال 20 ثانية، وظهرت عملية `35480` بعنوان `سطر — Satr` مستجيبة.
انتهت التجربة بإنهاء شجرة أمر npm ذات PID `7972` عمداً؛ ليس انهياراً تلقائياً.

```text
update-csp: CSP محدّث بالفعل
EXITED_BEFORE_20S=False
35480 سطر — Satr True D:\sater\satr-2-codex\node_modules\electron\dist\electron.exe
[35480:0905/202704.770:ERROR:net\disk_cache\cache_util_win.cc:25] Unable to move the cache: Access is denied. (0x5)
[35480:0905/202704.777:ERROR:net\disk_cache\disk_cache.cc:290] Unable to create cache
[35480:0905/202704.778:ERROR:gpu\ipc\host\gpu_disk_cache.cc:737] Gpu Cache Creation failed: -2
(node:35480) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
```

كل فئة من أخطاء الكاش الثلاث أعلاه ظهرت 3 مرات بطوابع وقت متجاورة؛ التحذير ظهر مرة.
لم يُعزل userData في هذه التجربة، وشُغّل مسبار PTY بالتزامن؛ لم أحسم سبب تعارض الكاش
أو نسبته إلى الترقية. لم يظهر استثناء JavaScript في main، لكن سلامة كل وظائف النافذة
ليست مستنتجة من عنوانها واستجابتها.

## لم يُقَس

- تشغيل 33 وABI 130 حيّاً، أو بقية الإصدارات والمنصات والمعماريات.
- إغلاق PTY قسري متكرر، أو ضغط طويل الأمد وتتبع كل ذرية العمليات باستمرار.
- إصلاح الحافظة أو سلامة استعادتها بالعقد الجديد؛ المحتوى غير النصي والتزامن غير مقيسين.
- RTL بالإنجليزية وresize وDPI والشاشات المتعددة وإخفاء الطبقة بالأذونات وقبول المالك.
- البناء بـbuilder 25 أو 26، ASAR وNSIS وAPPX والتثبيت والتحديث والمتجر والتوقيع.
- التسجيل والأسرار وCDP وبقية ميزات التطبيق والأداء؛ لم يُشغّل `test:full`.

## رصدتها ولم أنفّذها

- ترحيل حافظة التشكيل؛ الكسر مثبت بالاستدعاء وبفقد الحركات داخل Electron.
- تشخيص `AttachConsole failed` وتعليق الخروج بعد فشل longline؛ لم يُغيّر node-pty
  ولم يُجرّب beta ولم يُستنتج احتياج toolchain.
- تحذير console-message وأخطاء الكاش وتحذير DEP0190؛ سُجّلت دون إصلاح.
- بقي تعويض RTL وbuilder و`npmRebuild:false` كما هي. لا تعديل في `electron/**`
  أو `.github/**` أو `docs/OBSERVATIONS.md`؛ لا commit ولا نشر.

## الدفعة ٣ — `test:full` على الهدف (2026-09-06)

شُغّل الطقم كاملاً في `D:\sater\satr-2-codex` على `feat/electron-44-gate` بعد دمج
`main` فيه (فيحمل إصلاح الحافظة `bc59b33`). النتيجة **`SUITE_EXIT=1`** وثلاث مجموعات
ساقطة — **وواحدةٌ منها ليست انحداراً**، والفصل مقيس لا مفترض:

| المجموعة | على 44 | على 33 | الحكم |
|---|---|---|---|
| `test:sessionmeta` | ✗ «العصف لم يسم جلسة Codex» | ✗ ثم ✓ بعد `752bed5` | **ليس انحداراً** — سباق `OBS-126`، زال بدمج علاجه |
| `test:gate-live` | ✗ مخالفة رسو اتجاه بالبكسل | ✓ «اتجاه/خط/تباين/تجاوز = 0» | **انحدار 44** |
| `test:preview-member-live` | ✗ `full_page` ‏685 < 700 (مرتين) | ✓ ضمن 95/95 | **انحدار 44** |

### الانحدار الأول — رسو اتجاه في بوابة أول التشغيل (الأخطر)

`gate-live` يقيس رسو الاتجاه **بالبكسل** داخل Shadow DOM، وعلى 44 أبلغ:

```
مخالفة اتجاه في بوابة Shadow:
[{"kind":"pixel","tag":"LI","text":"•ثبّت Claude Codeافتح الطرفية (PowerShel"}]
```

`kind:"pixel"` يعني موضع أول محرف لا `getComputedStyle` — فهو العطل الذي **لا يكشفه**
أيّ مدقّق آخر. وهذا يمسّ **علّة وجود «سطر»**: عنصر قائمة عربي رسا LTR في أول شاشة
يراها مستخدم جديد. وهو أثقل من عطل الحافظة: ذاك يفقد التشكيل، وهذا يقلب النصّ.

**لم يُشخَّص**: أهو تغيّر في حسم `dir=auto` في Chromium الأحدث، أم في وراثة الاتجاه عبر
حدّ Shadow، أم في تعامل العنصر مع النقطة `•` البادئة. **ثلاثة محتملة ولا ترجيح.**

### الانحدار الثاني — `full_page` أضيق من النافذة

`AssertionError: full_page صُغّرت عن عرض النافذة: 685 < 700` — أُعيدت المجموعة مرة
ثانية بحكم `OBS-101` وسقطت ثانيةً، فهي بنصّ المشغّل «تراجع حقيقي لا عثرة بيئية».
والعقد المحروس أن لا يقلّ عرض `full_page` عن عرض النافذة حين يكون ≤1280px (‏`OBS-016`).
**لم يُشخَّص**: أتغيّر سلوك `Page.captureScreenshot` بـ`captureBeyondViewport`، أم صار
العرض يُقاس بمقياس جهاز مختلف.

### وإشارة ثالثة لم تسقط بعد

`(electron) 'console-message' arguments are deprecated` تتكرر في كل اختبار حيّ يسجّل
`console-message` بالتوقيع القديم. تحذيرٌ اليوم، وكسرٌ في إصدارٍ لاحق.

### الحصيلة

البوابة **لم تعد محجوبة عند الحافظة وحدها**. الحاجز اليوم ثلاثة: الحافظة (عولجت في
`bc59b33` ولم تُقَس بعد على 44 داخل الطقم)، ورسو الاتجاه في البوابة، ولقطة `full_page`.
ولا يُدمج الرفع قبل خضرة `test:full` على الهدف وقبول بشريّ.

## الدفعة ٣ — إعادة القياس بعد العلاجين (2026-09-06)

بعد `752bed5` (سباق `OBS-126`) و`929270f` (رسو الاتجاه `OBS-128`) أُعيد `test:full`
كاملاً على الهدف. **الساقط صار واحداً بعد أن كان ثلاثة**:

| المجموعة | قبل | بعد | السبب |
|---|---|---|---|
| `test:sessionmeta` | ✗ | **✓** | سباق في الحارس، لا علاقة له بالإصدار |
| `test:gate-live` | ✗ | **✓** | `applyDir` تثبّت `text-align` — «اتجاه/خط/تباين/تجاوز = 0» |
| `test:preview-member-live` | ✗ | ✗ | `OBS-129` — `full_page` ‏685 < 700 |

و`eval:agent` ‏**12/12** على الهدف، والحافظة **لم تعد تسقط** (‏`test:term-longline`
أخضر ضمن الطقم) فالحاجز الأول من الدفعة ٢ **زال بالقياس** لا بالافتراض.

### فالحاجز المتبقي واحد

`OBS-129` وحده، وهو **الأخفّ**: فرضيته أن `captureBeyondViewport` صار يعطي
`clientWidth` بدل `innerWidth` (الفارق `15` = عرض شريط التمرير) — أي **تصحيحُ سلوكٍ
معقول لا انحدار**، وعلاجه المرجَّح في **الحارس** لا في `preview.js`. لكنه **لم يُقَس
بعد**، ويغيّر عقد `OBS-016`، فهو قرار مالك.

ويبقى شرط الدمج كما هو: خضرة `test:full` على الهدف **وقبول بشريّ**، ومعهما ما لم
يُقَس أصلاً (البناء والتوزيع والمثبّت والمتجر).

## الطقم أخضر على الهدف (2026-09-06)

بعد `OBS-129` — وهو **الحاجز الثالث والأخير** — شُغّل `test:full` كاملاً في
`D:\sater\satr-2-codex` على Electron `44.2.0`:

```
full-suite: نجحت المجموعات كلها — 95/95.
=== SUITE_EXIT=0 ===
```

و`eval:agent` ‏**12/12** ضمنه. والمسار الكامل للحواجز الثلاثة:

| الحاجز | ما تبيّن | العلاج |
|---|---|---|
| الحافظة (الدفعة ٢) | واجهة `clipboard` تغيّرت لا حقلٌ نقص | `bc59b33` |
| رسو الاتجاه (`OBS-128`) | **عطل قائم كشفَته الترقية** لا انحدار | `929270f` |
| لقطة `full_page` (`OBS-129`) | **الحارس يقارن بالمرجع الخطأ ويمرّ صدفةً** | هذه الدفعة |

ولا واحدٌ من الثلاثة كان انحداراً في Chromium: الأول تغيير واجهة معلن، والثاني
اتّكالٌ منّا على وراثةٍ محلولة، والثالث خطأ مرجعٍ في حارسنا ستره غيابُ شريط تمرير.

### وما زال غير مقيس — فلا يُدمج الرفع بعد

خضرة الطقم **شرطٌ لا كفاية**. لم يُقَس بعد: البناء بـ`builder 26.15.3`، وASAR وNSIS
وAPPX، والتثبيت والتحديث والمتجر والتوقيع، والقبول البشريّ. ويبقى الرفع على
`feat/electron-44-gate`.

## البناء والتوزيع (2026-09-06)

بُنيت النسختان **من الالتزام نفسه** (‏`d97b27e` على 33، وهو `+` رفعُ Electron على 44)
كي لا تختلط زيادةُ المحرّك بنموّ الميزات — أول قياسٍ محلي أخطأ ذلك فقارن `2.11.0`
بـ`2.16.16`. و`electron-builder` بقي `25.1.8` في الاثنين.

| البند | Electron 33 | Electron 44 |
|---|---|---|
| `npm run dist` (‏NSIS) | ✓ رمز 0 | ✓ رمز 0 |
| **حجم المثبّت** | **81.4 م.ب** | **113.1 م.ب** |
| **الفرق** | — | **+31.7 م.ب · +38.9%** |
| مفكوكاً (`win-unpacked`) | 285 م.ب | 386 م.ب |
| `asar` | — | 15.4 م.ب |
| إعادة بناء أصلية | لا | لا (‏`npmRebuild:false` مُحترَم) |
| `node-pty` prebuilds | ✓ | ✓ (‏`conpty.node` · `pty.node` · `winpty-agent.exe`) |
| `latest.yml` + blockmap | ✓ | ✓ |

و`npm run dist:dir` نجح مستقلاً قبله (رمز 0).

### والنسخة المبنية تقلع وتعمل

شُغّل `dist\win-unpacked\Satr.exe` من بناء 44 بمجلد بيانات **معزول**
(‏`--user-data-dir`) — لأن [OBS-123] أثبت أن نسخة المصدر والمثبتة تتشاركان
`%APPDATA%`، وملفُّ تعريف Chromium أحدث قد لا تقرؤه 33 بعدها:

```
ALIVE_AFTER_25S=True · TITLE=سطر — Satr · RESPONDING=True · USERDATA_CREATED=True
```

والمحدِّث التلقائي عمل: `Checking for update` ثم
`Update for version 2.16.16 is not available`. ويتكرر تحذير `DEP0190` المسجَّل أعلاه.

### حزمة المتجر (‏`dist:appx`) — تُبنى صحيحةً بالهوية نفسها

بُنيت في الشجرتين من الالتزام نفسه، ورمز الخروج `0` في الاثنين:

| | Electron 33 | Electron 44 |
|---|---|---|
| `Satr 2.16.16.appx` | **118.1 م.ب** | **161.5 م.ب** |
| الفرق | — | **+43.4 م.ب · +36.8%** |

وبيان الحزمة على 44 مطابق لهوية Partner Center حرفياً:
`Identity Name=Moxa.Satr` · `Version=2.16.16.0` ·
`Publisher=CN=3016A96C-A16E-463B-BCE8-54F46BF3D5D8`. وأُعلن `AppX is not signed —
Windows Store only build` كالمعتاد (المتجر يوقّع).

### وترقية `electron-builder` **ليست لازمة** — والادّعاء يسقط بالقياس

كان المسبار يرشّح `26.15.3` ويسجّل أن «الرفع إلزامي» **لم يُثبت ببناء**. وقد بُني اليوم
**NSIS وAPPX معاً** على Electron `44.2.0` بـ`electron-builder 25.1.8` برمز `0`، وأقلع
التطبيق وعمل المحدِّث. فالإلزام **مدحوض**، ويسقط بندٌ كامل من متطلّبات الترقية.

**وحدّه معلَن**: المقيس أنه *يبني ويعمل*؛ لم يُقَس دعم `builder 25` لحالات حافة في 44
(مثل التحديث التفاضلي عبر blockmap عبر قفزة محرّك كاملة).

### ما زال غير مقيس بعد البناء

- **تشغيل المثبّت نفسه** (التثبيت الفعلي وإزالته) — ومعه **الأثمن**: هل يُحدَّث مستخدمٌ
  على 33 إلى 44 تلقائياً؟ يتطلب إغلاق «سطر» العامل واستبدال النسخة المثبتة، فهو قرار
  مالك لا فعل وكيل.
- التوقيع (لا شهادة).
- ⚠️ **قيد `0xC0000142`**: لم يظهر، وبُني المثبّت من **داخل «سطر»** — لكن شرطَه المعروف
  (نسخة `win-unpacked` قيد التشغيل) **لم يتحقق** في هذا التشغيل، فلا يُدَّعى زواله.
- القبول البشريّ.

### والقرار الذي يولّده هذا القياس

البناء **لا يحجب** الترقية: كل شيء يعمل. لكن **+31.7 م.ب على كل تنزيل** ثمنٌ يقرّره
المالك — وهو يمسّ ما كان إنجازاً مقصوداً (عدم حزم ثنائي `claude` أبقى المثبّت عند
~80 م.ب). فالسؤال لم يعد «هل يبني؟» بل «أتستحق الترقيةُ ثمنَها؟».

---

الطقم أخضر والبناء يعمل على Electron 44؛ الثمن **+38.9%** في حجم المثبّت، والقرار للمالك
