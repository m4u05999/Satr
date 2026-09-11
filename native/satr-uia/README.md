# `satr-uia` — المعين الأصلي لسطح ويندوز

الصف ١ من «ترتيب البناء» في [`docs/COMPUTER-USE-DESKTOP.md`](../../docs/COMPUTER-USE-DESKTOP.md). عميل
UI Automation فوق `UIAutomationCore` يتكلّم **أسطر JSON على stdio**، ويُنشر **NativeAOT** ملفاً واحداً.

## لماذا هو تبعية وقت بناء لا تبعية تشغيل

جافاسكربت لا يبلغ `IUIAutomation` (واجهة COM بجداول دوال). المعين يُبنى في CI ويُشحن ثنائياً واحداً:
لا يدخل `package.json`، ولا يشترط .NET على جهاز المستخدم، ولا ينزّل شيئاً وقت التشغيل. لا حزمة
NuGet فيه أصلاً — الـinterop مولَّد من `[GeneratedComInterface]` في .NET نفسه. البدائل المرفوضة
وأسبابها في §٣ من المواصفة.

## البناء

| أين | الأمر | الناتج |
|---|---|---|
| محلياً (بلا رابط MSVC) | `dotnet build native\satr-uia -c Release -o native\satr-uia\out` | مشغّل صغير + `satr-uia.dll` (‏JIT) |
| CI / جهاز فيه Visual Studio | `dotnet publish native\satr-uia -c Release -r win-x64 -o native\satr-uia\out-aot` | `satr-uia.exe` واحد (‏NativeAOT) |
| البديل المعلن (§١١) إن سقطت AOT | `… -p:PublishAot=false -p:PublishSingleFile=true -p:SelfContained=true -p:PublishTrimmed=true` | ملف واحد مقلَّم، أكبر |

الشرط: .NET SDK 10. نشر AOT يحتاج «Desktop development with C++» (رابط MSVC)؛ لذلك الحلقة المحلية
`dotnet build` والنشر في [`.github/workflows/uia-helper.yml`](../../.github/workflows/uia-helper.yml)
على `windows-latest`، الذي يطبع الحجم وزمن `initialize` ويرفع الناتج artifact.

تحذيرات التقليم وAOT (‏`IL2026`/`IL3050`…) **أخطاء** في `satr-uia.csproj`: تحذير يمرّ في بناء JIT
ينكسر صامتاً في ثنائي AOT (وقع فعلاً مع `JsonArray.Add<T>` أثناء البناء الأول).

## البروتوكول

مرجعه المسبار `scripts/uia-probe/Program.cs` حرفياً. سطر طلب ⇒ سطر ردّ:

```
{"id":1,"method":"initialize","params":{}}
{"result":{...},"id":1,"ms":0}          أو  {"error":{"code":"stale_ref","message":"…"},"id":1,"ms":0}
```

| التابع | الوسائط | النتيجة |
|---|---|---|
| `initialize` | — | `{version, osBuild, uiaAvailable, packageFullName, pid}` — `packageFullName` ‏null خارج حزمة MSIX |
| `targets/list` | — | `[{targetId:"w<n>", pid, processName, title, className, rect}]` — لمنتقي المستخدم وحده |
| `session/select` | `targetId, pid, rect{x,y,w,h}` | `{ok, targetId}` — يثبّت النافذة ومستطيلها لبقية التوابع |
| `tree/snapshot` | `targetId, maxDepth(12), maxNodes(400)` | `{nodes:[{ref, role, name, rect, enabled, focusable, isPassword, depth}], truncated}` |
| `element/state` | `ref` | `{role, name, rect, enabled, inside}` — قراءة بلا مشي الشجرة (لا تُبطل المراجع) |
| `element/invoke` | `ref` | `{ok}` |
| `element/setValue` | `ref, text` | `{ok, previous, value}` — القيمتان مقروءتان من العنصر قبل الكتابة وبعدها (مقصوصتان عند 256) |
| `input/key` | `keys` (مثل `Enter`، `Ctrl+S`) | `{ok, keys}` — بعد جلب النافذة المختارة إلى الأمام والتحقق منه |
| `input/scroll` | `ref, dy` (خطوات، ‎±50 بلا صفر) | `{ok, via:"pattern", before, after}` أو `{ok, via:"wheel"}` |
| `capture/window` | `targetId` | `{png, width, height, sourceWidth, sourceHeight}` — PNG ‏base64 للنافذة المختارة وحدها |
| `shutdown` | — | `{ok}` ثم خروج 0. وإغلاق stdin وحده ينهي أيضاً بـ0 |

- **رقم الهدف ثابت** `w<n>` لكل نافذة (مفتاحه المقبض والعملية) طوال عمر المعين، ولا يُعاد استعماله:
  سرد جديد لا يعيد ترقيم نافذة قائمة، ونافذة أُغلقت ثم فُتحت تأخذ رقماً جديداً — فمرجعها القديم لا
  يُحلّ على الجديدة. نافذة بلا مقبض لا تُسرد.
- **الجلسة** (`session/select`): كل تابع غير `initialize`/`targets/list`/`shutdown` يرفض بـ`not_allowed`
  قبلها، ويرفض بعدها أي هدف أو مرجع من غير النافذة المختارة. المستطيل المرسَل يجب أن يطابق مستطيل
  النافذة الحيّ حرفياً (لا يُمرَّر أوسع منها ولا تُختار نافذة تحرّكت بعد عرضها). والنافذة المغلقة
  (المقبض زال أو صار لعملية أخرى) ⇒ `closed`.
- **الاحتواء بالمستطيل** (الحارس ٢، الشق الثاني من الفحص المزدوج): قبل `invoke`/`setValue`/`scroll` يُقرأ
  مستطيل العنصر **حياً**؛ تجاوز مستطيل الجلسة كلياً أو جزئياً ⇒ `not_allowed`، والملامسة احتواء. عنصر
  بلا مستطيل يُقبل لفعل بنمط UIA ويُرفض للتمرير.
- **البصمة**: كل مرجع يحفظ `role+name+rect` لحظة اللقطة، والفعل يقارنها بالعنصر حياً بعد الاحتواء؛
  الاختلاف ⇒ `target_changed` مع `was`/`now` (وصف مقصوص عند 80) بلا فعل.
- **المرجع** `w<targetIndex>:e<elementIndex>` ويُحلّ من **آخر لقطة لهدفه** وحدها. ما لا يطابق
  `^w[1-9][0-9]*:e[1-9][0-9]*$`، أو ليس في آخر لقطة، أو زال عنصره ⇒ `stale_ref` **قبل أي فعل**.
- **حقل السرّ** (‏`IsPassword`) لا يدخل اللقطة أصلاً: لا مرجع ولا اسم ولا أبناء (الحارس ٣). لذلك
  `isPassword` في كل عقدة معادة `false`.
- **المفاتيح**: قائمة بيضاء ثابتة — `Enter` `Tab` `Escape` `Space` `Backspace` `Delete` `Home` `End`
  `PageUp` `PageDown` والأسهم، وحرف أو رقم مفرد، مع `Ctrl`/`Shift`/`Alt`. لا مفتاح ويندوز ولا `F1–F12`
  (⇒ `bad_key`)، وتركيبات مغادرة النافذة (`Alt+Tab` · `Alt+Escape` · `Alt+Space` · `Ctrl+Escape` ·
  `Ctrl+Alt+Delete`) ⇒ `not_allowed`. الإرسال بـ`SendInput` بعد التحقق أن النافذة المختارة أمامية
  (UIA `SetFocus` ثم `SetForegroundWindow` ثم ربط طابور الإدخال مؤقتاً)، وإلا `focus_failed` بلا إرسال.
- **الالتقاط**: `PrintWindow` (‏`PW_RENDERFULLCONTENT`) ⇒ PNG ‏RGB بلا شفافية بمشفّر داخلي (zlib من .NET)؛
  الضلع الأطول فوق 1568 يُصغَّر بمعامل صحيح.
- **رموز الخطأ**: `bad_request` · `unknown_method` · `not_found` (هدف مجهول) · `closed` (النافذة أُغلقت) ·
  `stale_ref` · `target_changed` · `not_allowed` · `focus_failed` · `bad_key` · `unsupported_pattern`
  (لا `InvokePattern`/`ValuePattern`) · `read_only` · `disabled` · `uia_unavailable` · `internal` (اسم
  الصنف وHRESULT فقط، بلا مسارات).
- `role` هو الاسم البرمجي لـ`UIA_*ControlTypeId` بأحرف صغيرة (`button`, `edit`, `titlebar`…) كما في المسبار.

## ترتيب جداول الدوال

`Interop.cs` يعلن سبع واجهات بترتيب `UIAutomationClient.idl` (‏Windows SDK `10.0.26100.0`) حرفياً،
بكل التوابع السابقة لآخر تابع مستعمَل. خطأ موضع واحد = نداء يصل إلى تابع آخر بلا أي خطأ. الترتيب
استُخرج آلياً من IDL لا من الذاكرة، وكل سطر يحمل رقم موضعه.

## من يستدعيه

`electron/desktop.js` (الخطوة ٤) — عملية واحدة لكل جلسة، بمهلة إقلاع ومهلة لكل طلب، وإعادة إقلاع
مرة عند الانهيار. المسار: `SATR_UIA_EXE` ثم `resources/satr-uia/satr-uia.exe` (مُحزَّم عبر
`build.extraResources` حين يوجد ناتج CI في `out/`) ثم `out/satr-uia.exe` (تطوير). حجب الأصناف بالاسم
(الحارس ٤) وحصر السرد بالنافذة المختارة (الحارس ١) في `electron/desktopguard.js` لا هنا.

## ما لم يُنفَّذ بعد

- المعين لا يُبنى في بوابة الإصدار `release.yml`: ناتجه يُرفع من `uia-helper.yml` artifact، ونسخه إلى
  `out/` قبل `npm run dist` خطوة يدوية حتى تُضمّ إلى مسار الإصدار بقرار مستقل.
- منتقي النافذة في الواجهة وسجلّ الأفعال المرئي — الخطوة ٥.

## الاختبار

`npm run test:uia-helper` (‏`scripts/uia-helper-test.js`) — يفتح المفكرة ونافذة WinForms فيها حقل
كلمة مرور وزرّ يغيّر اسمه عند نقره، ويقيس كل ما سبق بعضّة لكل تابع: الجلسة الإلزامية ومستطيلها،
ثبات الرقم وعدم إعادة استعماله، `className`، البصمة (`target_changed`)، الاحتواء بعد تكبير النافذة،
المفاتيح (أثرها مقروء من المحرّر ومن الملف على القرص بعد `Ctrl+S`) والممنوع منها، التمرير، الالتقاط،
و`closed` بعد قتل النافذة. الثنائي من `SATR_UIA_EXE` أو `out\satr-uia.exe` أو يُبنى إن غاب. فحصا
الحجم (< 8 م.ب) والإقلاع (< 800 م.ث) يعملان حين يكون الثنائي ملفاً واحداً (ناتج النشر).
