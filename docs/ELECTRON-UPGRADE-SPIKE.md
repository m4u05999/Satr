# OBS-095 — مسبار قرار ترقية Electron

تاريخ القياس والقراءة: **2026-09-05**. الفرع: `spike/obs-095-electron-eol`، عند
`e55e9dd151bf62ad0c53c12bdd2d1ffe1e8266e9`. هذا مسبار قراءة وتحليل ملفات، وليس ترقية أو
إثبات تشغيل على الهدف. الملف الوحيد المكتوب هو هذه الوثيقة؛ لم تُثبّت حزمة، ولم يُبنَ
التطبيق، ولم تُشغّل نسخة Electron جديدة. جُلبت حزم npm وترويسات Electron إلى الذاكرة
وفُحصت دون استخراجها إلى المشروع أو تنفيذ سكربتات التثبيت.

**النتيجة:** الهدف الموصى به هو `44.2.0`. وجود prebuild لـ`node-pty` **مثبت** على
Windows x64، وتوافق مستوى Node-API مثبت بالتحليل الثنائي؛ نجاح تشغيل PTY على الهدف
**غير مقيس**. لا يصح إعلان انسداد الترقية على Visual Studio من اختلاف ABI وحده.
وجدت في المقابل كسراً محدداً بالعقد في مسار الحافظة الخاص بإدخال العربية المشكّلة،
وبقيت مرآة RTL والبناء والتوزيع حواجز تجربة فعلية.

## 1. خط الأساس والخطوط المدعومة

القراءة المحلية من `package.json` و`package-lock.json` وملفات الحزم المثبّتة:

| العنصر | المعلن في المشروع | المثبّت فعلياً |
|---|---|---|
| Electron | `^33.0.0` | `33.4.11` |
| electron-builder | `^25.0.0` | `25.1.8` |
| node-pty | `^1.1.0` | `1.1.0` |
| إعادة البناء الأصلية | `build.npmRebuild: false` | لم تُغيّر |
| معمارية توزيع Windows | `build.win.target[].arch: x64` | هذه هي معمارية فحص الثنائيات |

سياسة Electron الرسمية تدعم **آخر ثلاثة خطوط رئيسية مستقرة**، وآخر minor من كل خط؛
الخط الأحدث يتلقى الإصلاحات كاملة، والذي يسبقه معظمها، والأقدم إصلاحات أمنية مباشرة.
المصدر [س1]، قراءة 2026-09-05. جدول الإصدارات وقت القراءة يؤكد ما يلي [س2، س3]:

| الخط | آخر إصدار ظاهر | Chromium | Node.js | نهاية الدعم المعلنة |
|---|---|---|---|---|
| 44 | `44.2.0` | `152.0.7977.76` | `24.20.0` | `2027-03-02` |
| 43 | `43.6.0` | `150.0.7871.250` | `24.20.0` | `2027-01-05` |
| 42 | `42.11.2` | `148.0.7778.280` | `24.19.0` | `2026-10-20` |
| 33، خطنا | `33.4.11` محلياً | عائلة `130` | لم أعد قياس patch وقت التشغيل | انتهى `2025-04-29` |

الإصدارات المستقرة الثلاثة أعلاه مؤرخة في صفحة الإصدارات بـ2026-09-03. مواعيد الدعم
المستقبلية أهداف قابلة للتغيير، وليست ضماناً. لم أعتمد وصف «Yesterday» النسبي في الصفحة.
الخط 45 معروض كـalpha، فلا يدخل اختيار خط مستقر مدعوم [س2].

إصلاح كثافة IPC في `44.2.0` يمس قناة الطرفية عند `electron/main.js:3197`.
إصلاح انهيار انتهاك سلامة ASAR على Windows موجود أيضاً في ملاحظات الإصدار [س4].
هذا يثبت وجود الإصلاحين، لا أن سطر أعاد إنتاج الانهيارين. لم أستنتج إصابة سطر بثغرة
مسمّاة من مجرد انتهاء الدعم، ولم أعد تدقيق CVEs المذكورة تاريخياً في OBS-095.

## 2. node-pty: فصل ABI الخاص بالمحرّك عن Node-API

### قياس الترويسات الرسمية

قرأت `include/node/config.gypi` و`include/node/node_version.h` من أرشيف headers لكل
إصدار [س5]. الرقم الحاسم لـABI هو `node_module_version` من إعداد Electron، لا افتراض
رقم Node مستقل ولا قيمة غير مشروطة من ترويسة قد تسمح بتجاوز embedder.

| Electron | `node_module_version` | أعلى Node-API معلن في الترويسة |
|---|---:|---:|
| `33.4.11` | 130 | 9 |
| `42.11.2` | 146 | 10 |
| `43.6.0` | 148 | 10 |
| `44.2.0` | 149 | 10 |

هذه قيم ملفات الترويسات، وليست خرج `process.versions` من تشغيل الإصدارات.
ترويسات الهدف تعلن النطاق `NODE_API_SUPPORTED_VERSION_MIN=1` إلى `MAX=10`.

### قياس الحزم المنشورة والثنائيات

سجل npm يعيد `latest=1.1.0`، ويتيح `1.2.0-beta.15` المذكورة في OBS-093 [س6].
فحصت أرشيفي الحزمتين، وحسبت SHA-512 وطابقت `dist.integrity` المنشورة. لم أشغّل
`install` أو `postinstall`. كلتاهما تعتمد `node-addon-api ^7.1.0`؛ والمحمّل
`lib/utils.js` يبحث بالترتيب في `build/Release` ثم `build/Debug` ثم
`prebuilds/${process.platform}-${process.arch}`، دون اختيار حسب رقم Electron.

| الحزمة، داخل `prebuilds/win32-x64/` | الحجم بالبايت | Node-API من الملف الثنائي |
|---|---:|---:|
| `1.1.0/conpty.node` | 312320 | 8 |
| `1.1.0/conpty_console_list.node` | 134656 | 8 |
| `1.1.0/pty.node` | 303104 | 8 |
| `1.2.0-beta.15/conpty.node` | 291328 | 8 |
| `1.2.0-beta.15/conpty_console_list.node` | 134656 | 8 |

مصدر الأحجام والتصديرات: ملفات tar المنشورة [س6]، قراءة 2026-09-05. في كل ملف PE
ظهر التصدير `napi_register_module_v1`، والتصدير
`node_api_module_get_api_version_v1` يبدأ بالبايتات `b8 08 00 00 00 c3`، أي
`mov eax,8; ret` في x64. هذا قياس للنسخة التي يعلنها **الثنائي نفسه**، وليس استنتاجاً
من اسم الحزمة. الملفات الثلاثة للمستقرة تطابق النسخ المحلية بايتاً ببايت.
مصدَرها المحلي يؤكد التسجيل بـ`NODE_API_MODULE` في
`node_modules/node-pty/src/win/conpty.cc:583` و`conpty_console_list.cc:44`.

الحزمتان تشحنان أيضاً `conpty/conpty.dll` و`conpty/OpenConsole.exe`؛ لا يكفي نقل
ملفات `.node` وحدها إلى الحزمة المبنية. فحص محتوى beta وجد prebuilds لـWindows
arm64 أيضاً، لكن تحليل PE والتطابق المحلي أعلاه خاصان بـx64، وليس اعتماداً لـarm64.

**الحكم المحدود:** لا يلزم prebuild باسم `electron-v149` لهذه الإضافات؛ فهي تطلب
Node-API 8 المتاح في الهدف. ضمان Node-API لا يشمل كل اعتماد أصلي خارجي ولا يثبت
سلامة ConPTY أو دورة الإغلاق أو تحميل DLLs من ASAR [س7]. لذلك **لم يثبت حاجز toolchain**،
ولكن **لم يُغلق حاجز التشغيل**. البداية الصحيحة تجربة `1.1.0` نفسها على الهدف قبل
إدخال beta، حتى لا نجمع تغييرين في قياس واحد.

إذا فشل التحميل/التشغيل رغم صحة Node-API، تُسجّل رسالة الفشل واسم DLL المفقود ومسارها
أولاً. إذا ثبت احتياج إعادة بناء ولا تتوفر prebuild عاملة، **تصير الترقية محجوبة على
toolchain** في هذا الجهاز وفق القيد المعطى. البديل حينها بناء موثق في بيئة Windows
مجهزة بـVisual Studio C++ وSDK ومتطلبات Spectre المذكورة في `binding.gyp`، أو prebuild
موثوق من الناشر. لم أثبّت الأدوات ولم أتحقق مستقلاً من غيابها؛ غياب Visual Studio
معلومة المهمة و`CLAUDE.md`، وليس نتيجة اكتشاف جديد للجهاز.

## 3. جرد الاستدعاءات الفعلية ومقابلتها بالهدف

بدأ المسح بـ`rg -n 'require.*electron' electron` ثم تتبعت الكائنات المستوردة والأسماء
البديلة والقدرات المحقونة، ومنها `desktopCapturer` في `promocapture.js`. استُبعد
`electron-updater` من قائمة واجهات Electron الأصلية؛ هو حزمة مستقلة.
الأرقام التالية أسطر لقطة الأساس المذكورة في أول الوثيقة، وقد تتحرك بعد عمل الفريق.

| العائلة المستخدمة | الاستدعاءات/الخصائص والأحداث القائمة، ومواقعها | نتيجة المقابلة |
|---|---|---|
| التطبيق | `setAppUserModelId` في `main.js:331`؛ `getPath` في `388`؛ `getVersion/isPackaged` في `854`؛ `whenReady` في `4855`؛ `on`, `quit`, `exit` في `4883`؛ `getLocale` في `preview.js:705` | لا حذف مطابق ظهر في مراجعة تغييرات 34–44 [س8] |
| النافذة الرئيسية | `new BrowserWindow` في `main.js:363`، `loadFile` في `382`؛ `isDestroyed/isMinimized/restore/isAlwaysOnTop/setAlwaysOnTop/show/focus` في `976`؛ `fromWebContents` في `3414`؛ `getAllWindows` في `4915`؛ `on('closed')` في `431` | العزل والقيم الصريحة باقية؛ لا تستخدم النافذة WCO أو frameless اللذين تغيرا على Linux |
| IPC والجسر | `ipcMain.handle` عبر `renderertrust.guardIpcMain` في `main.js:343`؛ `webContents.send` في `1987/3197/3249`؛ `contextBridge.exposeInMainWorld` في `preload.js:8`؛ `invoke` في `10` و`on/removeListener` في `180` | لا تغيير عقد موثق يفرض تغيير القنوات؛ إصلاح كثافة IPC في الهدف ذو صلة [س4] |
| الروابط وحماية التنقل | `shell.openExternal` في `main.js:423`؛ `setWindowOpenHandler`, `will-navigate`, `will-attach-webview` في `422–429` | لا تغيير مطابق؛ رفض النوافذ المنبثقة يجعل تغيير قابليتها للتحجيم غير مؤثر هنا |
| اختيار الملفات | `dialog.showOpenDialog` في `main.js:1088`؛ `showSaveDialog/showOpenDialog` في `3418/3419` | تغير سلوكي فعلي منذ 43: غياب `defaultPath` يبدأ في Downloads بدلاً من اختيار نظام التشغيل/آخر مسار [س8]. ينطبق على منتقي المجلد وفتح مشروع البرومو؛ ليس خطأ استثناء |
| حفظ الأسرار | `safeStorage.isEncryptionAvailable/encryptString/decryptString` في `keys.js:26/33/46` و`opsartifacts.js:38–41` | لا حذف مطابق؛ لم تقس قراءة أسرار قديمة بعد الترقية |
| الحافظة | `clipboard.availableFormats/readText/writeText/clear` في `term.js:241–248` | **كسر مؤكد بالعقد في 44**، تفصيله أدناه [س8، س9] |
| نافذة التسجيل المحقونة | `new BrowserWindow`, `setContentSize`, `loadURL`, `show`, `getMediaSourceId` في `promocapture.js:524/548/552/555/560`؛ `desktopCapturer.getSources` في `566`؛ `webContents.mainFrame` في `490` | لا حذف Windows مطابق. تغيير إذن التقاط صوت macOS منذ 39 يحتاج عملاً عند فتح منصة macOS، وليس دليلاً على فشل Windows [س8] |
| جلسة التسجيل والتنزيل | `setPermissionRequestHandler/setPermissionCheckHandler` في `promocapture.js:409/416`؛ `setDisplayMediaRequestHandler` في `483`؛ `session.on('will-download')` في `previewrecording.js:60` وطرق DownloadItem للحفظ/الإلغاء/حدث `done` | العقود باقية في توثيق الهدف [س10]؛ إذن التسجيل وعمل التنزيل غير مقيسين عليه |

### الكسر الأول المكتشف: مسار لصق العربية المشكّلة

في `electron/term.js:241` يحاول `clipboardSnapshot()` استدعاء `availableFormats()`؛
Electron 44 يحذفها. فرع `catch` يعيد `null` فوراً، فلا يصل إلى بديل PowerShell الموجود
لاحقاً. ثم `clusterPasteWrite()` في `term.js:294–295` يرجع `null` ويترك المسار يعود
للكتابة الخام. النتيجة المستدل عليها من العقد والكود: فقدان علاج عناقيد التشكيل في
طرفية PowerShell المرئية. لم أعرض هذا العطل في تشغيل حي على 44.

كما أن `readText()` و`writeText()` صارتا Promises [س8، س9]، بينما المسار الحالي يحفظ
النص ويكتب ثم يرسل `Ctrl+V` فوراً (`term.js:296–300`) ويعيد الحافظة بمؤقت. إزالة
استدعاء `availableFormats` وحده لا تكفي: يلزم تسلسل القراءة والكتابة واللصق والاستعادة
ومعالجة رفض Promises مع الحفاظ على عقد الطرفية. موضع العمل محدود من حيث الملفات،
لكن كلفة التحقق تشمل حماية الحافظة والعربية والتزامن؛ لم أقدّر ساعات دون تجربة.

### المعاينة وWebContentsView

| السطح الفعلي في `electron/preview.js` | المصدر/التغير | النتيجة |
|---|---|---|
| `new WebContentsView` في `533`؛ `partition` والعزل و`backgroundThrottling:false` في `534–540` | API الهدف [س10] | constructor وخصائص العزل باقية؛ لا preload للصفحة. حفظ الكوكيز عبر الترقية غير مقيس |
| `contentView.addChildView/removeChildView` في `545/526`؛ `setBackgroundColor` في `543`؛ `webContents.close` في `2485` | View وWebContents [س10] | لا حذف مطابق؛ ينبغي قياس إزالة الطبقة وتحرير webContents بعد تكرار الفتح والإغلاق |
| `setBounds` في `721`؛ `hostWin.getContentBounds` في `715`؛ إعادة التطبيق عند resize في `520` | View أضاف خيارات animation اختيارية [س10، س11] | الاستدعاء ذو المستطيل الواحد يبقى مقبولاً؛ هذا لا يحسم المرآة |
| `session.fromPartition().setPermissionRequestHandler` في `336`؛ `webRequest.onErrorOccurred/onCompleted` في `347/364` | تغير `urls: []` منذ 35 [س8] | سطر لا يمرر filter أصلاً؛ صيغة listener وحده ما زالت موثقة. لا يساوي غياب filter قائمة `urls` فارغة |
| `clearStorageData({storages:…})` في `630` | إزالة `quota/quotas` في 36/42 [س8] | لا يمرر سطر هذه الحقول. يوجد `websql` في قائمته وهو غير وارد في قائمة الهدف [س10]؛ يلزم فحص أثر القيمة، ولا أدعي أن حذفها جديد بين 33 والهدف |
| `will-download` في `406` و`certificate-error` في `438` | Session/App [س10] | لا حذف مطابق؛ الاستثناء المحلي للشهادة لا يساوي حدث `select-client-certificate` المتغير في 44 |
| `navigationHistory` في `452/614/905/2430` مع fallback قديم | WebContents [س10] | يستخدم المسار الحديث بالفعل؛ القديم موثق Deprecated أيضاً. ليس حاجز ترقية مثبتاً |
| `console-message` في `478` | منذ 35 التفاصيل على event، وlevel نصي [س8]؛ توثيق 44 ما زال يسرد الوسائط القديمة Deprecated [س10] | تحسين مطلوب مستقبلاً، **لا حذف مثبت**. عند الانتقال يُحوّل level إلى صيغة أحداث سطر الحالية ولا يُغير IPC من طرف واحد |
| `did-navigate`, `did-navigate-in-page`, `did-frame-finish-load`, `input-event`, `page-title-updated`, أحداث loading/failure/navigation وDevTools في `455–510` | WebContents الهدف [س10] | لا إزالة مطابقة. أثرها على إبطال refs وعدّاد تدخل المستخدم يحتاج اختباراً حياً |
| `loadURL/reload`, `getURL`, `isLoadingMainFrame`, `focus/sendInputEvent` في `606/618/900/1062/1964–1966`؛ `executeJavaScript/InIsolatedWorld` في `1485–1488` | WebContents الهدف [س10] | العقود باقية؛ سلامة العالم المعزول وحارس تدخل المستخدم غير معتمدين على الهدف بعد |
| `capturePage` في `1264/1298/1361`؛ `nativeImage.createFromBuffer` في `1349` وترميز/تحجيم الصور | WebContents/NativeImage | لم يظهر حذف لهذه الاستدعاءات. تغير `toBitmap` منذ 43 يمس **حارس RTL** الذي يقرأ بكسلات، لا مسار ترميز PNG/JPEG هنا [س8] |

`wc.debugger` يُستخدم للربط `attach('1.3')` و`isAttached/detach/sendCommand` في
`preview.js:656–671` و`1329–1373` و`1979–2004`. API الجسر ما زال موجوداً [س10].
جرد أوامر CDP المرسلة فعلاً:

| الأمر | موضع الاستدعاء | وضعه في مخطط CDP المقروء [س12] |
|---|---|---|
| `Network.enable` | `preview.js:670` | موجود |
| `Network.emulateNetworkConditions` | `preview.js:661/671` | موجود لكنه Deprecated؛ البديل الموثق يفصل المحاكاة إلى قواعد وتجاوز حالة الشبكة |
| `Page.getLayoutMetrics` | `preview.js:1334` | موجود |
| `Page.captureScreenshot` | `preview.js:1345` | موجود |
| `Runtime.evaluate` | `preview.js:1992` | موجود |
| `Runtime.terminateExecution` | `preview.js:2001` | موجود وExperimental |

مخطط CDP أعلاه هو upstream وقت القراءة، وليس خرج `Schema.getDomains` من Chromium
الهدف. رقم البروتوكول `1.3` لا يضمن ثبات كل أمر أو وسيط. لم تقس محاكاة الشبكة أو
اللقطة الكاملة أو مهلة evaluate أو تنازع debugger مع DevTools تحت 44؛ المطلوب حالات
فتح DevTools وإغلاقها أيضاً، لأن فشل `sendCommand` يُبتلع في بعض المسارات الحالية.

## 4. مرآة RTL: السؤال لم يُحسم بالتشغيل

**هل بقي السلوك نفسه؟ لم يُقَس على الهدف.** الدرس المثبت في `CLAUDE.md:237–248`
يسجل تجربة Electron 33: عند عرض محتوى `784` وعرض طبقة `200`، كان `en-US` يعرض
`x=0→0` و`400→400`، و`ar` يعرض `0→584` و`400→184`. هذه أرقام تجربة سابقة من
المستودع، لا نتائج أعدت إنتاجها اليوم.

الكود الحالي يحسم اللغة من `app.getLocale()` ثم يحوّل
`x = max(0, round(contentWidth - x - width))` قبل `setBounds`، ويكرر الحساب عند resize
(`preview.js:699–721`). قارنت تنفيذ `View::SetBounds` الرسمي بين النسختين [س11]:
33 يستدعي `view_->SetBoundsRect(bounds)` مباشرة، و44 يفعل الشيء نفسه حين لا تُطلب
animation، وهي حالة سطر. هذا يثبت استمرار **مسار الاستدعاء** فقط؛ طبقة Chromium
وتحويلاتها الأصلية تغيرت، فلا يثبت استمرار المرآة ولا يبرر إزالة التعويض.

حاجز الجولة التالية هو تشغيل `scripts/rtl-preview-fix-test.js` بالثنائي المحدد للهدف
مرة باللغة `en-US` ومرة بـ`--ar` الذي يضيف `--lang=ar`. يُسجّل `app.getLocale()` الفعلي
ويُشترط ألا تكون تجربة RTL قد بقيت لاتينية. الحارس الحالي يختبر ثلاث حالات
`(x,width)=(0,300),(380,260),(560,320)` ويقيس بكسلات الطبقة من سطح المكتب بتسامح
`±12 DIP`؛ عدم ظهور العلامة فشل بيئي، وليس نجاحاً. مصدر هذه الأرقام:
`scripts/rtl-preview-fix-test.js:8–21` و`76–78`، قراءة محلية 2026-09-05.

يلي ذلك قياس resize، ونمط الجهاز الضيق، وإخفاء الطبقة أثناء مربع الإذن وإعادتها،
وقبول المالك في بيئة عربية. `getBounds()` أو `getComputedStyle().direction` وحدهما
لا يكفيان لإثبات موضع الطبقة. لم أشغّل هذا الحارس حتى على 33 في الجولة الحالية؛
تشغيله على 33 لا يجيب عن 44. وهو خارج `test:full` وفق الدرس المثبت.

## 5. البناء ونسخة المتجر

### هل رفع electron-builder شرط؟

**أوصي باختبار `26.15.3` معه، لكن لم أثبت أن `25.1.8` يعجز عن بناء 44.** عبارة
«يلزم 26.x» في OBS-095 تتجاوز الدليل المتاح في هذا المسبار. قراءة builder المحلي
تظهر أنه يقرأ رقم Electron من `node_modules/electron/package.json` أو
`build.electronVersion` (`out/electron/electronVersion.js:17–33`) ثم ينزّل/يفك نسخة
Electron المحددة (`out/electron/ElectronFramework.js:131–149`)؛ لم أجد في هذين المسارين
حداً أقصى للخط. هذا ليس اختبار بناء ولا مراجعة كاملة لكل اعتماد متعدٍ.

تحققت من وجود `electron-builder` و`app-builder-lib` بالإصدار `26.15.3` في سجل npm
وفحصت حزمة الأخير [س13]. رابط GitHub release بالتاغ نفسه أعاد 404 عند القراءة،
لذلك لم أعتمد عليه لإثبات تغييرات الإصدار. لم أثبت «أقل إصدار builder صالح» ولا كلفة
ترقية شجرة اعتمادياته.

Electron 42 غيّر تنزيل ثنائي npm من `postinstall` إلى أول تشغيل، مع أداة تنزيل
صريحة [س8]. هذا يمس تجهيز جهاز/عدّاء جديد ومرحلة التشغيل دون شبكة، لكنه **لا يثبت**
أن builder القديم يفشل؛ له مسار تنزيل مستقل. يجب قياس تجهيز cache وتشغيل الأدوات
والبناء على بيئة نظيفة في جولة الترقية.

### winCodeSign وASAR

- في builder المحلي، `AppxTarget.js:64/91/122` يجلب `getSignVendorPath()` ويستخدم
  `windows-10/<arch>/makepri.exe` و`makeappx.exe`. `windowsSignToolManager.js:21` يجلب
  `winCodeSign`، وهي أدوات تغليف/توقيع، **لا مترجم C++ ولا بديل Visual Studio**.
- في حزمة `26.15.3` المنشورة، `out/targets/AppxTarget.js:67` ينتقل إلى
  `getWindowsKitsBundle`. فحص `out/toolsets/windows.js` يثبت أن غياب
  `toolsets.winCodeSign`، كما في إعدادنا، يبقي المسار legacy إلى `winCodeSign-2.6.0`.
  الحزم الأحدث للأدوات اختيارية. إذن لا تُفترض ترقية أدوات التوقيع أو إصلاح عطل NSIS
  تلقائياً بمجرد رفع builder [س13]. تنزيل الكاش وتشغيل الأدوات نفسيهما غير مقيسين.
- إعدادنا لا يعطل ASAR، و`asarUnpack` الصريح يحتوي موارد المهارات. فك native modules
  يعتمد الكشف الآلي في builder؛ كاشف `26.15.3` المنشور يتعرف على `.node/.dll/.exe`
  (`out/asar/unpackDetector.js:10`) [س13]. يجب فحص ناتج
  `resources/app.asar.unpacked/node_modules/node-pty/` والتأكد من وجود `.node` ومساعدات
  ConPTY ثم تشغيل PTY من الحزمة، لا الاكتفاء بنجاح `dist:dir`.
- البناء المحلي يحسب بيانات ASAR integrity ويدمجها في exe
  (`out/platformPackager.js:232` و`out/electron/ElectronFramework.js:43–44`). لم أجد
  إعداد `electronFuses` في `package.json` أو سكربتات المشروع، ولم أفحص fuse في exe مبني؛
  **وجود بيانات integrity لا يثبت أن فرض التحقق مفعّل**. إصلاح `44.2.0` لا يعفي من
  قياس الحالة الفعلية [س4]. لا أوصي بتغيير fuses ضمن إصلاح توافق الحافظة.

### dist:appx والحزمة المرسلة

الأمر الحالي `electron-builder --win appx --publish never` مستقل عن NSIS، وإعداد
`build.appx` يحفظ هوية `Moxa.Satr` والناشر المعتمد واللغتين `ar-SA/en-US`.
`CLAUDE.md:2790` يوثق نجاح البناء السابق، واعتماده على makeappx/makepri من winCodeSign،
والبناء غير الموقع للمتجر، وتعطيل updater عبر `process.windowsStore`.

لم ألمس الحزمة المرسلة ولم أقرأ Partner Center؛ حالة المراجعة هنا واردة من المستخدم.
الترقية المستقبلية تنتج artifact جديداً يحتاج بناء وفحصاً منفصلين، وليست تحديثاً
للبايتات الموجودة قيد المراجعة. يلزم مقارنة manifest والهوية والمعمارية والشعارات
والأذونات وموارد اللغة، وتثبيت تجريبي ثم فحص PTY وspawn و`process.windowsStore` وتعطيل
updater والمعاينة. نجاح NSIS لا يثبت نجاح APPX والعكس صحيح. لا أغيّر هوية المتجر،
ولا أوصي بإرسال بديل قبل نتيجة هذه الحواجز وقرار المالك.

## 6. لم يُقَس

- تحميل وتشغيل وإغلاق `node-pty` داخل Electron الهدف؛ نجاح require وحده لا يكفي.
  لم تقس أخطاء CreateProcessW الخاصة بـOBS-093، ولا PTY من داخل APPX أو ASAR unpacked.
- مرآة RTL الفعلية على 44 أو إعادة إنتاج قياس 33 اليوم، وresize وDPI والشاشات المتعددة
  والطبقة أثناء الأذونات. مقارنة المصدر ليست نتيجة بكسلات.
- إعادة إنتاج كسر الحافظة حيّاً؛ المثبت تعارض عقد API مع الاستدعاء القائم فقط.
- نجاح `test:full` على الهدف، CDP والكوكيز والعالم المعزول وصوت/فيديو التسجيل والتنزيل
  وقراءة الأسرار بعد الترقية. لم تُشغّل اختبارات تطبيق في مهمة القراءة هذه.
- نجاح builder القديم أو الجديد فعلياً، أقل إصدار builder لازم، تنزيل/تشغيل winCodeSign،
  NSIS/APPX والتوقيع وفرض ASAR integrity، وموافقة المتجر أو تجربة تحديث فوق نسخة مثبتة.
- الزمن والحجم والذاكرة والأداء بعد الترقية، وعدد ساعات الإصلاح أو عدد ملفات التغيير
  النهائي. الكلفة المعروفة هي مسارات العمل والحواجز، وليست تقديراً رقمياً مخمّناً.
- تشغيل Windows arm64 أو Linux/macOS، وتوفر toolchain المحلي بفحص مستقل، وتدقيق CVEs.

## 7. رصدتها ولم أنفّذها

1. `electron/term.js`: ترحيل حافظة العربية إلى العقد غير المتزامن، مع تحقق تسلسل
   الكتابة/اللصق/الاستعادة وحماية الحافظة؛ لا تعديل في هذا المسبار.
2. `electron/preview.js`: تقادم console-message ومحاكاة الشبكة، وقيمة `websql` خارج
   قائمة الهدف؛ مراجعات منفصلة بحسب القياس. تعويض RTL يبقى حتى تأتي أدلة بكسلات.
3. `electron/main.js`: اختيار سياسة `defaultPath` بعد تغير منتقي الملفات، وفحص التسجيل
   وأذوناته؛ لا حاجة مثبتة لإعادة تصميم IPC أو WebContentsView.
4. `package.json` وlock وسكربتات البناء/الفحص: ترقية مستقبلية مضبوطة، فحص cache والتنزيل
   الجديد، ASAR unpacked، الثنائي الفعلي والفحوص والتوزيعين. لا تغيير فيها الآن.
5. للقائد في `docs/OBSERVATIONS.md`: توضيح أن prebuilds تستخدم Node-API 8، وأن شرط
   toolchain لم يثبت، وأن «يلزم builder 26.x» توصية تحتاج بناءً لإثبات الضرورة، وإضافة
   كسر الحافظة وحاجز RTL وفرق بيانات ASAR عن fuse فرض التحقق. لم أكتب في الملاحظات.

## 8. سجل المصادر المؤرّخ

كل رقم شبكي أعلاه مأخوذ من المصادر التالية. **تاريخ القراءة لكل مدخل: 2026-09-05**.
الروابط المثبتة بالإصدار أولى بإعادة الإنتاج من صفحات latest/master المتحركة.

- **س1 — قراءة 2026-09-05:** [سياسة دعم Electron](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
- **س2 — قراءة 2026-09-05:** [قائمة الإصدارات الرسمية](https://releases.electronjs.org/).
- **س3 — قراءة 2026-09-05:** [جدول الدعم ونهايته](https://releases.electronjs.org/schedule).
- **س4 — قراءة 2026-09-05:** [إصدار Electron 44.2.0 وإصلاحاته](https://releases.electronjs.org/release/v44.2.0).
- **س5 — قراءة 2026-09-05:** ترويسات [33.4.11](https://electronjs.org/headers/v33.4.11/node-v33.4.11-headers.tar.gz)، [42.11.2](https://electronjs.org/headers/v42.11.2/node-v42.11.2-headers.tar.gz)، [43.6.0](https://electronjs.org/headers/v43.6.0/node-v43.6.0-headers.tar.gz)، [44.2.0](https://electronjs.org/headers/v44.2.0/node-v44.2.0-headers.tar.gz). قُرئت ملفات `config.gypi/node_version.h` داخلها؛ رابط `.../v44.2.0/node_version.h` المفرد أعاد 404 فاستُخدم الأرشيف.
- **س6 — قراءة 2026-09-05:** بيانات npm من ناشر node-pty: [latest](https://registry.npmjs.org/node-pty/latest)، [beta.15](https://registry.npmjs.org/node-pty/1.2.0-beta.15)، وأرشيفا [1.1.0](https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz) و[1.2.0-beta.15](https://registry.npmjs.org/node-pty/-/node-pty-1.2.0-beta.15.tgz).
- **س7 — قراءة 2026-09-05:** [Node-API وحدود ثبات ABI](https://nodejs.org/api/n-api.html#implications-of-abi-stability).
- **س8 — قراءة 2026-09-05:** [تغييرات Electron مثبتة عند v44.2.0](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/breaking-changes.md)، راجعت أقسام 34 إلى 44؛ صفحة latest فشل جلبها فاستُخدم المصدر الخام.
- **س9 — قراءة 2026-09-05:** [عقد clipboard عند v44.2.0](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/clipboard.md).
- **س10 — قراءة 2026-09-05:** توثيق الهدف: [WebContentsView](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/web-contents-view.md)، [View](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/view.md)، [WebContents](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/web-contents.md)، [Session](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/session.md)، [WebRequest](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/web-request.md)، [Debugger](https://raw.githubusercontent.com/electron/electron/v44.2.0/docs/api/debugger.md).
- **س11 — قراءة 2026-09-05:** تنفيذ View عند [33.4.11](https://raw.githubusercontent.com/electron/electron/v33.4.11/shell/browser/api/electron_api_view.cc) وعند [44.2.0](https://raw.githubusercontent.com/electron/electron/v44.2.0/shell/browser/api/electron_api_view.cc).
- **س12 — قراءة 2026-09-05:** مخطط CDP upstream: [browser_protocol.json](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json) و[js_protocol.json](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json). ليس snapshot مضموناً للثنائي المستهدف.
- **س13 — قراءة 2026-09-05:** [electron-builder 26.15.3](https://registry.npmjs.org/electron-builder/26.15.3)، [app-builder-lib 26.15.3](https://registry.npmjs.org/app-builder-lib/26.15.3)، [الحزمة التي فُحص كودها](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.3.tgz). مسارات `out/` المذكورة أعلاه داخل هذه الحزمة، أو النسخة المحلية حيث صُرّح بذلك.

بصمتا أرشيفي node-pty، SHA-512 بصيغة base64، المحسوبتان والمطابقتان لسجل npm:

```text
1.1.0: 20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==
1.2.0-beta.15: vORSzHXi4Ofl7HemVWpuudLqCPdaQb4LfpRCUpE5HPxhp4JYscl8zZwxh11p26v2wvW24WMwnMfLjhRLixrfxA==
```

إعادة القياس لا تحتاج npm install: يُجلب الأرشيف بـ`fetch` ويُفك بـ`node:zlib.gunzipSync`
في الذاكرة؛ تُقرأ رؤوس tar ذات 512 بايت وحقل الحجم octal عند 124، ثم تُحل RVA من
جداول أقسام PE للوصول إلى Export Directory وتصدير نسخة Node-API. البايتات المعلنة
والبصمات أعلاه تجعل النتيجة قابلة للمراجعة دون تحميل الإضافة في عملية Electron.
هذا قارئ أدلة، وليس حارس توافق جديداً أو اختباراً يزعم إعادة إنتاج عطل.

## 9. التوصية المرتبة

**الحاجز الأول هو تشغيل node-pty 1.1.0 على الهدف؛ حاجز toolchain غير مثبت، لأن ملفات
Node-API 8 الجاهزة موجودة.**

1. في جولة الترقية المستقلة بعد قرار القائد، ثبّت الهدف التجريبي `44.2.0` على Windows
   x64، وأبقِ node-pty `1.1.0` و`npmRebuild:false` أولاً. سجّل النسخة وABI وقت التشغيل،
   ثم اختبر spawn/خرج العربية/resize/input/exit والإغلاق المتكرر من ملفات prebuild
   نفسها. إن احتاج إعادة بناء فعلاً، أوقف الترقية هنا حتى تُحسم بيئة البناء الأصلية.
2. احسم الحاجز البصري مبكراً على الهدف: اختبار RTL بالبكسلات باللغتين ثم resize
   والأذونات. لا تعديل لتعويض المرآة قبل النتيجة. إذا فشل الهدف ولا يوجد إصلاح محدود
   مثبت، يبقى `43.6.0` بديلاً مؤقتاً مدعوماً يُعاد عليه **كل** القياس؛ لا وراثة لنتائج 44.
3. رحّل حافظة العربية للعقد الجديد، واحسم تغير منتقي الملفات. شغّل الفحوص المعنية
   بالمعاينة والأمان والطرفية ثم `test:full` على الهدف. لا تضم beta لمجرد الترقية؛
   OBS-093 له قياسه وقرار نضجه المستقلان.
4. اختبر builder `26.15.3` كمرشح البناء، وسجّل نتيجة `dist:dir` ثم NSIS ثم `dist:appx`
   كلٌ على حدة، ووجود مساعدات PTY خارج ASAR وفرض integrity الفعلي. إذا احتاج القرار
   إثبات ضرورة رفع builder، قارن بناءً معزولاً بالنسخة `25.1.8` على نفس الهدف؛ إلى ذلك
   الحين لا يُكتب «الرفع إلزامي» كحقيقة مثبتة.
5. قدّم نسخة تجريبية للقبول العربي ونتائج التثبيت/التحديث والتسجيل قبل النشر. احتفظ
   بهوية المتجر وحزمته المرسلة، واجعل إرسال بديل قراراً منفصلاً. `42.11.2` آخر البدائل
   المدعومة وأقصرها أفقاً وفق [س3]؛ الرجوع إلى 33 ليس حلاً للدعم الأمني. إعادة كتابة
   التطبيق بـTauri ليست بديل هذه الجولة؛ سبق رفضها في رادار 003 بسبب كلفة إعادة الكتابة
   وعدم حل عقدة الطرفية والتوزيع (`docs/radar/state.json`، قراءة محلية 2026-09-05).
