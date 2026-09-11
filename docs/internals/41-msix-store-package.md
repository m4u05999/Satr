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

