### حزمة Microsoft Store (‏MSIX — 2026-09-04)

قناة توزيع ثانية بجانب مثبّت NSIS، سببها مقيس لا مفترض: SmartScreen لا يُنهيه شراء
شهادة خارج المتجر (‏`OBS-096`)، بينما **مايكروسوفت توقّع MSIX بنفسها** فلا تحذير أبداً.

- **البناء**: `npm run dist:appx` (‏`--win appx --publish never`). **ليس** ضمن
  `win.target` عمداً كي لا يبطئ كل إصدار NSIS. يُبنى **من داخل سطر بلا عائق** — قيد
  `0xC0000142` المعروف خاص بمرحلة NSIS وحدها، و`makeappx.exe`/`makepri.exe` يأتيان من
  كاش `winCodeSign` القائم فلا اعتمادية جديدة. الحزمة **غير موقّعة** عمداً
  (‏`AppX is not signed — Windows Store only build`).
- **الهوية من Partner Center لا من التخمين** (`build.appx`): `identityName: Moxa.Satr` ·
  `publisher: CN=3016A96C-A16E-463B-BCE8-54F46BF3D5D8` · `publisherDisplayName: Moxa` ·
  `displayName: سطر — Satr` (يطابق الاسم المحجوز — عدم التطابق يرفض الرفع). Store ID
  `9N7F5RKQJ9WF`. **تحقّق الناشر حسابياً لا بصرياً**: `PublisherId` في
  `Package Family Name` هو base32 (‏Crockford) لأول 8 بايت من `SHA-256` لنصّ الناشر
  بترميز UTF-16LE؛ حساب `CN=3016A96C-…` أعطى `mmw7zg39988m6` المرصود، والدالة نفسها
  تعيد `8wekyb3d8bbwe` لناشر مايكروسوفت المعروف.
- **الشعارات**: `node scripts/make-icon.js --appx` يكتب ستة PNG في `build/appx/`
  بالأسماء الثابتة التي يقرؤها `AppxTarget.js`؛ غيابها يجعل electron-builder يشحن
  شعارات `SampleAppx` الافتراضية. `drawRGBA(W,H)` صار يقبل مستطيلات (العلامة في مربع
  مركزي) و`icon.ico` لم يتغيّر بايتاً.
- **المُحدِّث معطَّل داخل الحزمة**: `main.js` يمرّر `msix: process.windowsStore === true`
  فيصمت `updater.js` (المتجر يحدّث)، وتظهر شارة «نسخة المتجر» في ⚙ ويُخفى صف «تحقق من
  التحديثات». الشارة هي **أداة قياس العلم** لا تزيين — يحرسها `test:topbar-dev-badge`.
- **مقيس داخل الحاوية بتجربة بشرية** (بروتوكول `satr-accept`، 2026-09-04): الإقلاع ·
  ‏`resolveClaudeBin` يجد `%APPDATA%\npm` · دور حي لـClaude وCodex · قراءة وكتابة على
  `D:` خارج الحاوية · **ConPTY** (‏`node-pty` من `app.asar.unpacked`) نفّذ
  `npm i -g` فعلياً · مهام `termjobs` و`bg_term_done` · المعاينة `WebContentsView` ·
  و`~/.satr/keys.json` مقروء وDPAPI يفكّه. **وفخّ VFS لم يقع**: تحديث `claude` من داخل
  الحزمة كتب في `%APPDATA%\npm` الحقيقي (النسخة خارج الحاوية رأت `2.1.259`).
- **الاختبار بلا توقيع**: وضع المطوّر مفعّل على جهاز المالك، فالتسجيل
  `Add-AppxPackage -Register <unpacked>\AppxManifest.xml` على مجلد مفكوك بـ
  `makeappx unpack` — بلا شهادة ولا صلاحيات مدير. الإزالة `Get-AppxPackage Moxa.Satr |
  Remove-AppxPackage`.
- **حدّان معلَنان**: (1) الحساب **فردي**، وتحويله إلى شركة غير مدعوم — يستلزم حساباً
  جديداً وإعادة نشر بهوية ناشر أخرى (قرار مالك 2026-09-04 بعد عرض المقايضة). (2) تدفق
  التحقق يستعمل AU10TIX الذي يرشّح المتصفحات بـ`User-Agent` فيرفض معاينة سطر
  («This Browser is unsupported») ويعرض رابط `10tix.me` لإكماله على الجوال؛ **لا تغلق
  سطر أثناءه** وإلا ضاع ربط النتيجة بالجلسة.

### الحزمة صارت تُبنى في بوابة الإصدار لا بيد المالك (2026-09-13)

كانت الحزمة تُبنى محلياً بـ`npm run dist:appx` وتُرفع يدوياً، فكل وسم يخرج بمثبّت NSIS
محدَّث وحزمة متجر متأخّرة **بلا أي أحمر** — نمط `OBS-161` نفسه: خطوة شحن قائمة على
التذكّر لا على آليّة. صارت داخل وظيفة `release` في `.github/workflows/release.yml`:

- **الموضع بعد خطوتَي المعين عمداً**: `extraResources` يُنسخ في **كل هدف**، فبناء الحزمة
  قبل `dotnet publish native/satr-uia` كان يشحن حزمة متجر بلا `satr-uia` — وelectron-builder
  يتخطّى المصدر الغائب صامتاً. الترتيب الملزم: نشر المعين ⇐ التحقق قبل التعبئة ⇐
  `npm run dist` ⇐ التحقق داخل النسخة المبنية ⇐ `npm run dist:appx`.
- **التحقق من الإصدار من المصدر لا من اسم الملف**: الحزمة appx **ملف zip**، فتُقرأ
  `AppxManifest.xml` منها بـ`System.IO.Compression.ZipFile` (مكتبة .NET المدمجة — صفر
  اعتماديات) ويُطابَق `Package.Identity.Version` مع `package.json`. نسخة MSIX رباعية
  المقاطع (`a.b.c.0`) فيُقبل مقطع رابع اختياري. و`Expand-Archive` **متجنَّب** تحسّباً
  لمدخل `[Content_Types].xml` (الأقواس المربّعة أنماطٌ في مسارات PowerShell).
- **اسم الأصل ثابت** `Satr-Store-<version>.appx` (اسم electron-builder الافتراضي يحمل
  فراغات يستبدلها GitHub بشرطات)، يُرفع بـ`gh release upload --clobber`، ويدخل فحص
  «التحقق من أصول التحديث» إلى جانب exe وlatest.yml وblockmap — فحزمة لم تُرفع تصبغ
  الإصدار أحمر بدل أن تمرّ صامتة. وملاحظات الإصدار تقول صراحةً إنها **غير موقّعة** وإنها
  للرفع إلى Partner Center **لا للتثبيت المباشر**.
- **مسار تجربة بلا قطع وسم**: `workflow_dispatch` بمدخل منطقي `msix_only` (افتراضي
  `false`). وظيفة `release` تعمل عليه، وخطوات مسار الوسم كلها مشروطة بـ
  `github.event_name != 'workflow_dispatch'`، وخطوات NSIS بـ`!inputs.msix_only`،
  والحزمة تخرج `artifact` (‏`satr-store-msix`) بدل إصدار GitHub. وفي التشغيل اليدوي
  غير الـ`msix_only` يُبنى المثبّت بـ`--publish never` لأنه لا مسودة إصدار يُرفع إليها.
  **ولا وظيفة رابعة**: الوظائف الثلاث (`verify` · `tests` · `release`) معرّفات الفحوص
  المطلوبة في حماية الفرع، والجديدة تبقى اختيارية حتى تُعلَّم يدوياً (‏OBS-117).
- **الحارس الساكن** `scripts/release-msix-test.js` (‏`npm run test:release-msix`، ضمن
  `test:full`) يثبّت هذا كله نصّياً: أسماء الوظائف الثلاث · موضع `dist:appx` بعد المعين ·
  بادئة `Satr-Store-` في الرفع وفي فحص الأصول · `workflow_dispatch`/`msix_only` ·
  شروط مساري الوسم واليدوي · وجود شعارات `build/appx/` الستة (الأسماء تُقرأ من
  `APPX_ASSETS` في `scripts/make-icon.js` لا تُنسخ في الحارس، فالزحف يُكشف).
  ويعضّ أيضاً على **درس مقيس**: اسم خطوة يحوي «‏: » يُسقط `workflow_dispatch` من واجهة
  Actions صامتاً.

**حدّان مُصرَّح بهما**: (1) **الرفع إلى Partner Center يبقى يدوياً** في هذه الدفعة —
الأتمتة تحتاج `Microsoft Store submission API` وثلاثة أسرار (‏tenant/client/key) وقرار
مالك؛ ما أُوتمت هو **البناء والتحقق والإرفاق** لا النشر في المتجر. (2) الحارس نصّيّ:
يحرس الملف لا التشغيل — أن `dist:appx` ينجح على العدّاء وأن `makeappx` يأتي من كاش
`winCodeSign` يثبته أول تشغيل بعد الدمج، لا الحارس.

