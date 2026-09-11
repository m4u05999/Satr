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
| `targets/list` | — | `[{targetId:"w<n>", pid, processName, title, rect}]` — يمسح كل اللقطات السابقة |
| `tree/snapshot` | `targetId, maxDepth(12), maxNodes(400)` | `{nodes:[{ref, role, name, rect, enabled, focusable, isPassword, depth}], truncated}` |
| `element/invoke` | `ref` | `{ok}` |
| `element/setValue` | `ref, text` | `{ok, previous, value}` — القيمتان مقروءتان من العنصر قبل الكتابة وبعدها (مقصوصتان عند 256) |
| `shutdown` | — | `{ok}` ثم خروج 0. وإغلاق stdin وحده ينهي أيضاً بـ0 |

- **المرجع** `w<targetIndex>:e<elementIndex>` ويُحلّ من **آخر لقطة لهدفه** وحدها. ما لا يطابق
  `^w[1-9][0-9]*:e[1-9][0-9]*$`، أو ليس في آخر لقطة، أو زال عنصره ⇒ `stale_ref` **قبل أي فعل**.
- **حقل السرّ** (‏`IsPassword`) لا يدخل اللقطة أصلاً: لا مرجع ولا اسم ولا أبناء (الحارس ٣). لذلك
  `isPassword` في كل عقدة معادة `false`.
- **رموز الخطأ**: `bad_request` · `unknown_method` · `not_found` (هدف مجهول) · `closed` (النافذة أُغلقت) ·
  `stale_ref` · `unsupported_pattern` (لا `InvokePattern`/`ValuePattern`) · `read_only` · `disabled` ·
  `uia_unavailable` · `internal` (اسم الصنف وHRESULT فقط، بلا مسارات).
- `role` هو الاسم البرمجي لـ`UIA_*ControlTypeId` بأحرف صغيرة (`button`, `edit`, `titlebar`…) كما في المسبار.

## ترتيب جداول الدوال

`Interop.cs` يعلن سبع واجهات بترتيب `UIAutomationClient.idl` (‏Windows SDK `10.0.26100.0`) حرفياً،
بكل التوابع السابقة لآخر تابع مستعمَل. خطأ موضع واحد = نداء يصل إلى تابع آخر بلا أي خطأ. الترتيب
استُخرج آلياً من IDL لا من الذاكرة، وكل سطر يحمل رقم موضعه.

## ما لم يُنفَّذ بعد

- `input/key` · `input/scroll` · `capture/window` (المواصفة §٨) — مع الخطوة ٤.
- الاحتواء بالمستطيل داخل المعين (الحارس ٢، الفحص الثاني) — مع الخطوة ٤.
- `targets/list` يعدّد كل النوافذ العليا: حصرها بنافذة يختارها المستخدم (الحارس ١) في `desktopguard.js` — الخطوة ٣.
- حجب الأصناف بالاسم (UAC، `Credential Dialog Xaml Host`) — الخطوة ٣.
- لا يُحزم بعد في مثبّت سطر ولا يستدعيه `electron/` — الخطوة ٤.

## الاختبار

`npm run test:uia-helper` (‏`scripts/uia-helper-test.js`) — يفتح المفكرة ونافذة WinForms فيها حقل
كلمة مرور ويقيس كل ما سبق. الثنائي من `SATR_UIA_EXE` أو `out\satr-uia.exe` أو يُبنى إن غاب. فحصا
الحجم (< 8 م.ب) والإقلاع (< 800 م.ث) يعملان حين يكون الثنائي ملفاً واحداً (ناتج النشر).
