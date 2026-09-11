### لوحة المعاينة المدمجة 🌐 (م-1 — الدفعة 5 «سطر يرى الويب»)

> خطة الدفعة 5 وقرارات النطاق والعزل في `docs/ROADMAP.md` — اقرأها قبل م-2/م-3/م-4.

- **الفكرة**: متصفح مدمج بجانب المحادثة (زرّ 🌐 — لا أمر `/`) يعرض مشروع الويب الجاري
  تطويره. `#midRow` صفّ flex أفقي (RTL: المحادثة يميناً والمعاينة يساراً بمقبض عرض).
- **البنية**: `electron/preview.js` يملك `WebContentsView` (انظر خريطة الملفات — العزل
  الكامل موثّق هناك)؛ المكوّن `<satr-preview-panel>` (Shadow) يرسم الإطار (رأس: ✕/رجوع/
  تقدم/تحديث/حقل عنوان LTR) ويقيس مساحة العرض بـ ResizeObserver ويبلّغها — **العرض
  الأصلي يطفو فوق المساحة** (طبقة نظام فوق كل محتوى المتصفح).
- **العقد (IPC — تنقية في main.js)**: `satr:previewOpen/previewNavigate {url}` (http/https
  حصراً ≤ 2048) · `satr:previewAction {action}` ∈ back/forward/reload ·
  `satr:previewBounds {x,y,width,height}` (أعداد صحيحة 0..20000) · `satr:previewClose`
  (يدمّر العرض — partition الدائمة تحفظ الكوكيز). أحداث عبر قناة مستقلة `satr:preview`:
  `{type:'nav', url, canGoBack, canGoForward}` / `{type:'title', title}` /
  `{type:'loading', loading}` / `{type:'failed', code, desc, url}`. preload يكشفها
  `previewOpen/previewNavigate/previewAction/previewBounds/previewClose/onPreview`.
  طلب السر يبث `secret_request {id,reason}`/`secret_end {id}` على القناة نفسها؛ preload
  يكشف `secretDone(id,done)` فقط، وmain لا يقبل إلا `secret_<32hex>` وboolean ولا قيمة.
  فتح الوكيل يستخدم IPCين منفصلين `previewOpenAgent/previewNavigateAgent` بنفس تنقية URL
  كي لا يُسجَّل origin كثقة مستخدم. `previewElementShot {selector}` يقبل نصاً بلا محارف
  تحكم ≤1000 فقط ويلتقط العنصر المحدد دون بث مصغرة وكيل.
- **اقتراح localhost التلقائي**: الطرفية (terminal-panel) ترصد عناوين
  `localhost/127.0.0.1` في خرج أي تبويب (بما فيها طرفية النموذج 🤖) وتبثّ حدث DOM
  ‏`localhost-url`؛ القشرة تعرض إشعاراً بزرّ «افتح المعاينة» (`chatEl.addActionNotice` —
  مرة لكل عنوان). **حدّ موثّق**: خوادم يشغّلها SDK بأداة Bash الخفية لا تمرّ بالطرفية
  فلا تُرصد (bgprocs يعرف PID لا URL) — عوّضته م-1-ب أدناه.
- **الوكيل يعرف المعاينة (م-1-ب — لقطة مالك من قبول م-1: النموذج فتح كروم بـ
  Start-Process لجهله بالمعاينة)**: ‏(1) `systemPrompt` ملحق في agent.js (preset
  claude_code + append) يعرّف النموذج ببيئة «سطر» ويوجّهه: لا متصفح خارجياً إلا بطلب
  صريح. (2) أداة MCP ‏`open_preview(url)` في خادم satr-terminal الداخلي: تتحقق من
  http/https وتبثّ حدث `preview_open {url}` فتستدعي القشرة `previewEl.openWith`
  (اللوحة تفتح وتبلّغ مستطيلها فيُنشأ العرض بالمسار القائم). تمرّ بـ canUseTool كأي
  أداة. تحقق حيّ: دور SDK حقيقي استدعاها والحدث وصل بالعنوان الصحيح.
- **تذكّر آخر مشروع + تحديث تلقائي (م-1-ج — طلب مالك)**: النقر على 🌐 يفتح آخر عنوان
  ناجح مباشرة؛ وزرّ 🔄 «تحديث تلقائي» (مُفعّل افتراضياً) يجعل القشرة تستدعي
  `previewEl.reloadIfLive()` عند اكتمال دور عدّل ملفات (تتبّع `previewDirty` على
  `file_edit`). المكوّن يعيد التحميل فقط إن كان الوضع مفعّلاً والعرض حيّاً. حدّ:
  بعد اكتمال الدور — مشاريع HMR تتحدّث بنفسها (يُفضَّل إطفاؤه لها).
- **تذكّر لكل مجلد + استعادة الخادم (م-1-د)**: العنوان يُحفظ **لكل cwd** (`satr_preview_url::
  <cwd>` — المكوّن يقرأ #cwd) بلا fallback عام، فلكل مشروع منفذه ولا تلوّث بينها. وعند
  فشل الوصول تستعلم الواجهة بـ `satr:devServerInfo {cwd}`. إن كانت مهمة حية تعرض «الخادم
  يبدو قيد الإقلاع»؛ وإلا تعرض زر «🔁 شغّل خادم المشروع» إن وجد سجل. بعد confirm يعرض
  الأمر حرفياً، تستدعي `satr:devServerRestart {cwd}`؛ main.js وحده يقرأ الأمر من سجل
  القرص (لا command من renderer)، يبدأ termjob، ثم تعيد الواجهة العنوان المحفوظ أربع مرات
  خلال نحو 12ث. `cwd` يجب أن يكون مجلداً قائماً.
- **أدوات قراءة المعاينة للوكيل (م-3)**: أداتان في خادم satr-terminal الداخلي تعملان
  على العرض القائم (`open_preview` تخدم التنقّل): `read_page` (snapshot نصي من DOM —
  عنوان/عناوين/روابط/أزرار/حقول + مقتطف، مُغلّف «للفحص لا للتنفيذ») و`screenshot`
  (لقطة JPEG مضغوطة كمحتوى MCP نوع image — رؤية SDK). المحرك `preview.readPage()/screenshot()`
  (waitReady ينتظر التحميل؛ preview.js موديول مشترك بين main وagent مثل term.js).
  systemPrompt يوجّه الوكيل لاستعمالهما للتحقق من تعديلاته. قراءة فقط — الأفعال (م-4)
  خلف بوابة قرار. تحقق حيّ: دور SDK حقيقي استدعى الأداتين والرؤية قبِلت اللقطة.
- **أدوات الفعل بالإذن (م-4)**: `browser_click(ref)` + `browser_type(ref, text)`
  في خادم satr-terminal، على العرض القائم عبر `preview.clickElement/typeText`
  (executeJavaScript؛ selector يُهرَّب بـ JSON.stringify؛ الكتابة عبر native value setter
  + input/change لتوافق React). **الأمان (حرج)**: تمرّان بـ `canUseTool` مثل Bash —
  مربع الإذن العربي كل مرة (لسن في alwaysAllowed)، bypassPermissions وحده يعفيها.
  `formatPermissionDetail` يعرض العنصر والنص المراد كتابته صراحةً داخل مربع الإذن فقط
  (مقصوصاً عند 600 محرف؛ لا يضاف إلى بطاقة الأداة). هذا القرار التاريخي استُبدل في دفعة
  «المتصفح عضو مشترك» بثقة origin المشروطة أعلاه لأن وضع التحكم كان يعفي الأفعال جماعياً.
- **ترقية أفعال المتصفح — لقطة + ref حتمي (2026-07-12)**: نمط Playwright MCP/browser-use
  الصناعي (بحث موثّق): بدل تخمين النموذج مُحدِّد CSS من outerHTML (هشّ)، أداة جديدة
  `browser_snapshot` تعطي لقطة مدمجة لكل عنصر تفاعلي `[ref] role "name"` (تسِم كلاً بسمة
  `data-satr-ref="sN:eN"` — كفاءة رموز عالية)، و`browser_click`/`browser_type` قبِلا **ref**
  (مثل `s3:e5` ⇒ يُحلّ عبر `[data-satr-ref]` حتمياً) مع **إبقاء مُحدِّد CSS تراجعاً**.
  كل لقطة ترفع جيلاً مركزياً مرتبطاً بـ`webContents` الحالي، وأي ref من جيل سابق أو الصيغة
  القديمة `eN` يعيد `stale_ref` قبل لمس DOM أو بوابة الإذن؛ التنقّل وإغلاق/تبديل العرض
  يبطلان الجيل النشط أيضاً. التغيّر الموضعي لا يعيد استخدام الفهارس المحذوفة: العناصر
  التفاعلية الجديدة تحصل على ref متزايدة داخل الجيل نفسه، وتبقى صالحة حتى لقطة/تنقّل تالٍ.
  أُضيفت `browser_navigate(url)` (تنقّل العرض
  القائم) و`browser_wait_for({text|selector, timeout_ms})` (استقصاء دوري للصفحات
  الديناميكية). كله في `preview.js` (snapshot/waitFor/resolve — بلا preload، صفر
  اعتماديات) + كتلة أدوات المتصفح في `agent.js`. تحقّق حيّ (مسبار معزول 8/8، خادم HTTP فعلي): لقطة بأدوار/أسماء/
  refs صحيحة · نقر/كتابة بـ ref يغيّران DOM ويُطلقان input · wait_for (ظهور/مهلة) ·
  تراجع CSS · ref قديم ⇒ `stale_ref` بلا فعل أو إذن · مُحدِّد فاسد ⇒ bad_selector.
- **DOM delta بعد الفعل (H1 — 2026-07-22)**: صار `MutationObserver` نفسه يبني فرقاً
  دلالياً محدوداً للعناصر التفاعلية (`+` إضافة، `-` حذف، `~` تغيير)، ويمنح العنصر الجديد
  ref متزايدة من الجيل النشط. تُعاد الأسطر داخل نتيجة الفعل، مع أولوية الإضافات، وسقف
  `min(1600 bytes, 25% من لقطة العناصر السابقة)`؛ عند القص تُطلب لقطة كاملة صراحةً.
  لا تُعاد delta بعد التنقّل، واللقطة التالية تبطل كل refs القديمة كالمعتاد. أثبت
  `test:preview-member-live` نقر عنصر بديل مرتين متتاليتين بلا لقطة وسيطة، ثم رفض ref
  عند لقطة جديدة. وفي مسبار Claude SDK بـ200 عنصر انخفضت اللقطات `7→1` والأدوار `15→9`
  وحجم نتائج الأدوات `45,951→8,121 bytes`، بينما لم يثبت التشغيل المفرد وفراً مالياً بسبب
  اختلاف توزيع cache creation/read. زوجا `AB/BA` لاحقان دعما وفراً أولياً 19.1% وخفضا
  الزمن 45.1%، لكن `n=2` لا يكفي لادعاء مالي منشور. وفي Kimi ACP خفّض زوجا `AB/BA`
  نتائج الأدوات 82.97% والزمن 44.24%، بلا بيانات تكلفة من ACP. كشف القياس أيضاً موافقة
  ACP زائدة حول MCP المدمج؛ صار `kimi.js` يقبل الغلاف فقط للاسم الصريح
  `mcp__satr__<known-tool>`، مع بقاء بوابة `codexmcp` الداخلية كاملة، فلا يعفى اسم مجرد
  أو خادم خارجي.
- **انتظار أفعال تكيفي (2026-07-22)**: أُلغي انتظار `360ms` الثابت بعد click/type؛
  `MutationObserver` داخل الصفحة يوقظ Promise عند أول mutation حقيقي (مع تجاهل وميض الوكيل)
  أو hash/popstate، و`preview.js` يبقي حد `360ms` مستقلاً في العملية الرئيسية كي لا تعلق
  صفحة مخنوقة أو فعل بلا أثر. `WebContentsView` المعاينة يستخدم `backgroundThrottling:false`
  لأن الوكيل يجب أن يكمل التصفح عند تبديل المستخدم للنافذة. مسبار MCP الحي خفّض وسيط
  النقر من 376.5ms إلى 5ms؛ `test:preview-member-live` يغطي تغيراً متزامناً ومؤخراً 120ms
  وفعل no-op وتنقلاً، مع تنظيف observer في النجاح والفشل.
- **وضع تحكّم المتصفح + النطاقات الموثوقة (دفعة «المتصفح عضو مشترك» — 2026-07-19)**:
  زرّ `#browserCtl` يمنح قيادة سلسة لكنه **لا يعفي كل فعل على كل نطاق**. مجموعة origins
  تعيش بعمر التطبيق في main: localhost/127.0.0.1 (أي منفذ) موثوقان دائماً، وأي origin
  خارجي لا يدخلها إلا حين يفتحه المستخدم بنفسه من شريط العنوان أو يضغط «ثق بالنطاق لهذه
  الجلسة» في طلب الإذن. قراءة `read_page/snapshot/console/network/screenshot/wait/scroll/
  hover/set_viewport/perf` حرة تحت التفويض على أي صفحة؛ `open_preview/navigate/back/forward`
  و`click/type/select/press/evaluate` لا تمر تلقائياً إلا على origin موثوق. الطلب يعرض
  الفعل والعنوان والمدخل، والموافقة الموسعة تثق بالـorigin لا باسم الأداة؛ حارس SDK يسبق
  `alwaysAllowed`، وCodex يمرّر target من `codexmcp` إلى `shouldAutoApproveMcp`.
  للنقر/Enter يجب أن يكون origin الصفحة الحالية موثوقاً، وتُفحص أيضاً وجهة `a[href]` أو
  `form.action` قبل الإعفاء، فلا يقفز رابط من صفحة موثوقة إلى origin جديد بصمت ولا تعفي
  وجهة موثوقة فعلاً صادراً من صفحة وافق المستخدم على زيارتها مرةً فقط.
  `browser_handoff` منح قيادة آمن مستقل، و`bypassPermissions` وحده يتجاوز البوابة كلها.
  التشغيل/الإيقاف والملفات لا تدخل هذا التفويض. الاختبارات: `test:browserorigin` +
  `test:codexmcp` (تصنيف وtarget وثقة/fail-closed).
- **مساعد إعداد المنصات والتكاملات (2026-07-19)**: `browserpolicy.js` طبقة مستقلة بعد
  ثقة origin: submit وEnter داخل نموذج وcross-origin POST والأزرار ذات مفردات
  send/save/deploy/delete/authorize ونظائرها العربية، وكذلك `browser_evaluate`، تُؤكّد
  **كل مرة** بلا «دائماً» ولا موافقة دور؛ `bypassPermissions` وحده يتجاوزها. التنقّل أو
  evaluate ذوا حمولة >1024 محرف أو تطابق `memory.hasSecret` يُعرضان منقّحين، وميزانية
  المهمة 40 فعلاً مؤثراً تُمدّد صراحةً 20 فعلاً. الموافقة الموسعة في طلب مركّب قد تثق
  بالـorigin فقط، ولا تحفظ إعفاء الفعل الحسّاس.
  الأدوات المتكافئة في SDK/Codex/Kimi: `browser_fill_form` (1..20 حقلاً غير سري؛ السر مرفوض؛
  مراجعة مرئية لكل استدعاء بلا إرسال النموذج)،
  `browser_transfer_field` (نقل داخل الصفحة بلا خروج القيمة، أو عبر صفحتين بمعرّف
  `xfer_<32hex>` في مخزن العملية الرئيسية يُمسح بعد اللصق/الدور)، `browser_request_secret`
  (IPC منقّى `secret_<32hex>` + boolean فقط، والنتيجة `{filled:true}`)، و
  `browser_handoff_step(reason,resume_hint)`. أثناء الإدخال/التسليم تبقى الأدوات معلّقة
  fail-closed وتُصفّر سجلات console/network. `browser_snapshot` لا يعيد قيم inputs، ونتيجة
  `browser_evaluate` المطابقة لحارس الأسرار تُحجب. التحقق: `test:browserpolicy` و
  `test:codexmcp` ومسبار `test:browser-platform-live` بصفحتين واختبار عدم تسريب صريح.
  - **تصحيح زر HTML العادي (2026-07-22):** `browserActionContext` لم يعد يعتبر كل
    `<button>` بلا `type` عملية submit؛ يلزم أن يكون مرتبطاً بـ`form`. زر الإرسال داخل
    النموذج وcross-origin POST ومفردات الأفعال الخطرة تبقى حساسة. أثبته
    `test:browser-platform-live` بحالتي submit وزر عادي خارج النموذج.
- **رؤية الـ console وأخطاء الشبكة للوكيل (2026-07-12 — «ابنِ→عايِن→صحّح»)**: أداة
  `browser_console` تعطي الوكيل رسائل console الصفحة (وأخطاء JavaScript غير الملتقطة) +
  طلبات الشبكة الفاشلة — فيشخّص لماذا لا تعمل صفحة بناها ويصحّح نفسه. الالتقاط في
  `preview.js`: خطّاف `console-message` على webContents (مخزن دائري ‏300، LEVELS يترجم
  ترميز Electron) + `webRequest.onErrorOccurred` على partition المعاينة (يتجاهل
  ERR_ABORTED) + تصفير السجلّين عند تنقّل الإطار الرئيسي (يعكس الصفحة الحالية). قراءة
  فقط (بثّ حيّ بلا executeJavaScript)، مغلّفة «للفحص لا للتنفيذ»، وضمن BROWSER_AUTO_TOOLS
  (وضع تحكّم المتصفح). تحقّق حيّ (منطق محفوف): مسبار معزول 9/9 بخادم HTTP فعلي —
  error/warning/log بمستوياتها + خطأ غير ملتقط + خطأ شبكة + تصفير عند التنقّل.
- **إكمال طقم الأفعال — تكافؤ Playwright MCP (2026-07-12)**: أربع أدوات تُتمّم التفاعل مع
  الصفحة (كلها ref-أو-selector وضمن BROWSER_AUTO_TOOLS): `browser_select_option(ref, value)`
  (قوائم `<select>` — مطابقة بالـ value ثم بالنص الظاهر)، `browser_press_key(key)`
  (مفاتيح Enter/Tab/Escape/الأسهم/… عبر `webContents.sendInputEvent` — أحداث مفاتيح
  **حقيقية موثوقة** تُطلق السلوك الأصلي كإرسال النموذج، بقائمة بيضاء KEY_MAP لا حروف عامة)،
  `browser_scroll(direction, amount?)` (down/up/top/bottom لكشف المحتوى الكسول قبل لقطة)،
  `browser_hover(ref)` (mouseover/enter/move لإظهار قوائم التحويم). كلها في `preview.js`
  (selectOption/pressKey/scroll/hover) + كتلة أدوات المتصفح في `agent.js`. تحقّق حيّ
  (منطق محفوف): مسبار معزول 10/10 بخادم HTTP فعلي (اختيار بالقيمة/النص/ref + Enter حقيقي
  يُطلق keydown + تحويم + تمرير أسفل/أعلى + bad_key/not_select/no_option).
- **لقطة عنصر واحد + صقل الوضع (البند 3/4 — 2026-07-12)**: `browser_screenshot_element(ref)`
  (رؤية مركّزة أرخص رموزاً من الصفحة كاملة): RECT_FN يمرّر العنصر للنافذة ويعيد مستطيله
  (viewport = DIP عند zoom=1) لـ `capturePage(rect)`. تحقّق حيّ: عنصر 200×100 التُقط بدقّة
  مقابل صفحة 800×600 (نافذة مرئية — capturePage يحتاج سطحاً مرسوماً). وصقل «وضع تحكّم
  المتصفح» (app.js): إطفاء تلقائي عند «جلسة جديدة» + نقطة «●» مؤشّراً دائماً. **قرار**:
  «تعطيل الزرّ حين لا معاينة» أُسقط عمداً — open_preview ضمن المُوافَق عليها فالوضع يفتحها.
- **مؤشّر النشاط + مؤشّر الوضع + لقطة كاملة (2026-07-12، بالتوازي مع Codex)**: (1) مؤشّر
  «الوكيل يقود المتصفح» حيّ: `previewEl.flashAgentActivity(toolName)` — شارة عابرة
  «🤖 الوكيل <فعل>…» + خيط علوي نابض في رأس اللوحة (المنطقة الوحيدة غير المغطّاة بالعرض
  الطافي فوق pvBox)؛ القشرة تناديها في فرع tool_use والمكوّن يفلتر غير أدوات المتصفح.
  (2) مؤشّر دائم أن «وضع تحكّم المتصفح» مفعّل: شارة «🖱️ تحكّم» + توهّج حافة اللوحة، تُقرأ
  حالته من `aria-pressed` لزرّ `#browserCtl` عبر **MutationObserver** — تكامل **بلا تعديل
  app.js** (كان Codex يحرّره). (3) لقطة الصفحة كاملةً: `screenshot` يقبل `full_page=true`
  ⇒ `preview.screenshotFull` عبر CDP `Page.captureScreenshot` (`captureBeyondViewport`،
  سقف 20000px، سقوط رشيق). تحقّق حيّ: صفحة 2400px التُقطت 783×2400 مقابل 800×600 للعرض.
- **خفض كلفة لقطات النموذج (OBS-016 — 2026-09-03)**: مسار النموذج وحده يطلب
  `modelImage:true`؛ فلا يُصغّر `NativeImage` إلا إذا تجاوز **عرضه**
  `SHOT_MAX_EDGE=1280` (الطول يبقى حتى `MAX_FULL_HEIGHT`)، ثم يُرمّز PNG وJPEG بجودة
  `SHOT_JPEG_QUALITY=72` ويُختار الأصغر مع `mimeType` المطابق الذي يمرّره
  `agent.js` و`codexmcp.js`. مصغّرة المستخدم `agent_screenshot` تبقى PNG
  ≤360px/512KiB، و`page_metrics` للقطة الكاملة تُستهلك في تنبيه القصّ عند 20000px.
  **تصحيح المراجعة الخصومية 2026-09-03**: ادعاء −90% السابق كان يخلط التصغير بالصيغة
  ويستعمل canvas ضوضاء؛ على fixture واجهة عربية فعلية عند 700×760 كانت PNG/JPEG q72:
  الكاملة 71,378/79,217، والعنصر 33,637/38,020، والنافذة 34,813/39,737 بايت؛ فاختير
  PNG في الثلاث ولا يُدّعى خفض ثابت للصيغة. مسار 🎯 الخلفي يحفظ PNG العرض في `base64`
  ويعيد نسخة النموذج في `modelBase64/modelMimeType`؛ ويلزم مالك الواجهة تمرير حقلي
  النموذج إلى المرفق مع إبقاء PNG للمعاينة. الحارس يقيس الصيغتين، واختيار الأصغر،
  ومطابقة MIME، وألا يقل عرض `full_page` عن عرض النافذة حين يكون ≤1280px.
- **معاينة متجاوبة/محاكاة الأجهزة (2026-07-12)**: زرّ `#pvDevice` في رأس اللوحة يدوّر
  كامل/موبايل(390)/لوحي(768) — `reportBounds` يبلّغ مستطيلاً بعرض الجهاز **موسّطاً** في
  pvBox (الجوانب خلفية اللوحة)، فعرض WebContentsView الأضيق = viewport الصفحة ⇒ تتفاعل
  media queries حقيقةً (لا محاكاة CDP). لقطة الوكيل تعكس مقاس الجهاز. **preview-panel.js
  وحده** (بلا تصادم). الاختيار يُحفظ `satr_preview_device`. تحقّق حيّ: عرض 390 ⇒
  `innerWidth=390` والصفحة تُعيد التدفّق وmedia query تُفعَّل.
- **لوحة Console/أخطاء للمستخدم (الخيار 2 — DevTools مصغّرة، 2026-07-12)**: زرّ 🐞 في
  رأس اللوحة يفتح لوحة سفلية تعرض **حيّاً** رسائل console الصفحة (log/warn/error) وأخطاء
  الشبكة الفاشلة — فيرى **المستخدم** ما يراه الوكيل (أداة browser_console). `preview.js`
  يبثّ أحداث `console`/`neterr`/`console_clear` عبر قناة `satr:preview` القائمة (passthrough
  في main.js `previewSender` — **بلا تعديل main.js**، فصفر تصادم مع Codex)، مع إبقاء
  buffers الوكيل. المكوّن: سقف 500 سطر DOM، شارة عدّاد أخطاء غير مرئية على الزرّ، التصاق
  بالذيل، مسح، وتصفير عند التنقّل. أسفل pvBox فلا يغطّيها العرض الطافي (فتحها يصغّر pvBox
  ⇒ reportBounds). تحقّق حيّ: بثّ error/warning/info + neterr + console_clear عند التنقّل.
- **تطويرات المتصفح المِلكية أ/ب/ج/د (الخيار 2 — 2026-07-12)**: أربعة تحسينات تُكمِل أدوات
  المطوّر المدمجة. **كلها عبر قناة المعاينة القائمة**: الأفعال بلا وسائط تمرّ بـ
  `previewAction` (main.js: أُضيفت للـ `PREVIEW_ACTIONS` الآمنة)، والأحداث الجديدة تُبثّ
  من `preview.js` عبر `previewSender` **بلا تعديل main.js آخر** (صفر تصادم مع Codex).
  - **(أ) DevTools حقيقية بزرّ 🔧**: `action('devtools')` ⇒ `wc.openDevTools({mode:'detach'})`
    (نافذة **منفصلة** تتجنّب قيد الطفو فوق pvBox — لا تختبئ خلف العرض). toggle، والحالة
    الفعلية تصل بحدث `devtools {open}` (يعكس إغلاق المستخدم للنافذة مباشرةً).
  - **(ب) سجلّ الشبكة الكامل**: `webRequest.onCompleted` يلتقط **كل** طلب (لا الفاشل فقط —
    method/url/status/type/fromCache، تجاهل data:/blob:) في `netReqBuf` (سقف 300)، يُبثّ
    حيّاً كحدث `netreq`. للوكيل عبر أداة **`browser_network`** (تُبرز الطلبات ≥400 أولاً —
    ضمن BROWSER_AUTO_TOOLS + systemPrompt)، وللمستخدم في لوحة 🐞 بمرشّح فئة (الكل/Console/
    الشبكة). أحمر لرمز حالة ≥400.
  - **(ج) فحص العنصر المحسّن**: `describe()` في PICK_SCRIPT صار يعيد **box-model** (أبعاد/
    padding/margin/border من getBoundingClientRect+getComputedStyle) و**أبرز الأنماط
    المحسوبة** (id/class/display/position/color/background/font). شريط 🎯 يعرضها شرائحَ
    صغيرة LTR مع عيّنات لون؛ والحقول تُمرَّر أيضاً في حدث `preview-edit` (لاستهلاك app.js
    مستقبلاً — لم يُعدَّل app.js فهو نشط لدى Codex؛ البطاقة المرئية هي ثمرة البند).
  - **(د) مسح تخزين 🧹 + محاكاة شبكة 🚦**: `action('clear_storage')` يمسح كوكيز+localStorage+
    cache+SW لـ partition المعاينة ثم يعيد التحميل (تأكيد confirm في الواجهة). ومحاكاة
    الشبكة عبر CDP `Network.emulateNetworkConditions` (net_online/slow/fast/offline — زرّ
    يدوّرها). **حدّ موثّق**: DevTools تحجز عميل debugger الوحيد؛ إن كانت مفتوحة تفشل المحاكاة
    (`throttle_unavailable`) والواجهة تنبّه «أغلِق DevTools» — استعمل تبويب Network فيها حينها.
  - تحقّق: `node --check` + مسبار معزول يُصرِّف كل سكربتات الحقن العشرة (0 فشل) + إقلاع نظيف
    (`ELECTRON_ENABLE_LOGGING`، 20ث بلا أخطاء JS — العروض المتبقية بيئية GPU/cache).
- **رؤية الويب لـ Codex (الخيار 1 — 2026-07-12)**: إعطاء محرك Codex نفس رؤية الويب التي
  يملكها SDK (open_preview/read_page/browser_snapshot/browser_console/browser_network/
  screenshot) على **نفس** لوحة المعاينة. `electron/codexmcp.js`: خادم MCP‏ **streamable-HTTP
  داخل العملية** (http المدمجة، صفر اعتماديات) يستمع على 127.0.0.1 بمنفذ ورمز عشوائيين،
  كل طلب يتحقّق من `Authorization: Bearer` بزمن ثابت، ويفوّض الأدوات مباشرةً إلى
  `preview.js` (نفس نسخة WebContentsView). `electron/codex.js` يبدأ الخادم **قبل** spawn
  ويحقن إعداده في `codex app-server` عبر تجاوزات `-c`:
  `mcp_servers.satr_preview.url="…"` + `bearer_token_env_var="SATR_MCP_TOKEN"` (الرمز في
  البيئة)، ويوقفه في cleanup. **قرارات مثبّتة بفحص codex-cli 0.144.1 واختبار حيّ**: (1)
  codex يدعم نقل `streamable_http` (رابط+bearer) لا stdio فقط؛ (2) `mcpServers` في طبقات
  الإعداد لا في `thread/start`، لكن `-c` وقت الإطلاق يحقنه **لكل جلسة بلا تلويث
  config.toml العام وبلا عملية جسر**؛ (3) الرمز يُقرأ من **متغيّر بيئة** لا حرفياً. اختبار
  حيّ بـ codex حقيقي: `initialize → tools/list → satr_preview=ready` (بينما فشلت خوادمه
  الأخرى). إشعار `mcpServer/startupStatus/updated` (كان يُتجاهَل) يُرصد الآن لفشل
  satr_preview فقط (تدهور رشيق: Codex يعمل بلا رؤية إن فشل). في دردشة Codex تبقى الأدوات
  متاحة دائماً: زر «متصفح» مفعّل = القراءة حرة والفعل/التنقّل مشروط بثقة origin، ومطفأ =
  كل tools/call يمرّ بمربع الإذن العربي (بما فيه open_preview والقراءة)، بينما `browserControl:false`
  الصريح في المراجع/العصف يعطّل الخادم كلياً. open_preview يبثّ
  `preview_open` للواجهة (app.js يفتح اللوحة generically لأي محرك). codex.js محجوز لـ Claude
  (حدّ ملكية الملفات في الفريق الثلاثي).
  - **طقم الأفعال الكامل (دفعة تالية — 2026-07-12)**: أُضيفت بقية أدوات SDK بتكافؤ كامل:
    browser_screenshot_element/wait_for/scroll/hover (رؤية/قراءة — بلا إذن) +
    browser_click/type/select_option/press_key (تُغيّر الصفحة). **الأمان (حرج)**: Codex
    **لا** يبوّب نداءات MCP (طبقة موافقته للأوامر/الملفات فقط) فالأفعال كانت ستُنفَّذ بلا
    سؤال — خطر مع صفحات غير موثوقة (حقن برومبت). الحل: `codexmcp.js` يمرّر الأفعال الأربع
    التي تُغيّر الصفحة عبر `deps.requestPermission(tool, input)` الذي يوفّره codex.js فيبثّ
    `permission_request` (مربع الإذن العربي نفسه) وينتظر الردّ عبر `mcpPerms` +
    `resolvePermission` (قناة أذونات الأوامر نفسها). في وضع التحكم لا تعفي «موافقة دائمة»
    قديمة فعلاً على origin جديد؛ زر الثقة يضيف origin فقط. `bypassPermissions` وحده يتجاوز؛
    الرفض/إيقاف الدور يفكّ الإذن المعلّق. أدوات المتصفح كلها مصنّفة
    `browser` وتُبوّب، بينما get/list_background_tasks وحدهما `read` بلا إذن. تحقّق:
    `npm run test:codexmcp` (يشمل تصنيف browser/read/exec/target وfail-closed) +
    `eval:agent` 12/12 + إقلاع نظيف.
  - **مهلة أداة MCP لأفعال الإذن (إصلاح اختبار يدوي — 2026-07-13)**: بوابة الإذن أعلاه
    تُبقي استدعاء أداة MCP معلّقاً (‏`await requestPermission` في guard) حتى يوافق المستخدم
    على مربع الإذن. مهلة Codex الافتراضية على أداة MCP قصيرة، فكانت تُلغي الاستدعاء قبل أن
    يلحق المستخدم الموافقة — فيتلقّى النموذج فشلاً ويقترح `bypassPermissions` بدل انتظار
    الإذن (كشفه اختبار يدوي: الوكيل «لم يسأل» وطلب تجاوز الأذونات يدوياً). الحل في `codex.js`
    عند spawn: حقن `mcp_servers.satr_preview.tool_timeout_sec=600` (+`startup_timeout_sec=30`)
    عبر `-c` ليتّسع لموافقة بشرية؛ الأدوات القرائية لا تنتظر إذناً فلا تتأثر، وإيقاف الدور
    يفكّ أي إذن معلّق فلا تعليق دائم. مثبّت حيّاً: codex 0.144.1 يقبل المفتاحين مع
    `--strict-config` بلا `unknown configuration field` (بـ CODEX_HOME نظيف).
  - **موافقة MCP الخارجية الفارغة (إصلاح رفض صامت — 2026-07-22)**: Codex 0.144.3 مع
    `approvalPolicy:on-request` يرسل قبل كل أداة من `satr_preview` طلب
    `mcpServer/elicitation/request` بنموذج `object` فارغ ووسم
    `_meta.codex_approval_kind="mcp_tool_call"`. كان معالج النماذج يعتبره غير مدعوم ويردّ
    `decline`، فتفشل حتى `list_background_tasks` برسالة `user rejected MCP tool call` بلا بطاقة.
    `codex.js` يقبل هذه البوابة الخارجية تلقائياً **فقط** لخادم `satr_preview` المدمج وبالبصمة
    الفارغة الدقيقة؛ ثم تبقى بوابة `codexmcp.js` الداخلية صاحبة القرار الفعلي (قراءة حرة،
    وثقة origin، وأفعال حساسة، وميزانية، و`requestPermission`). الخوادم الخارجية والنماذج ذات
    الحقول لا تُعفى. يثبت ذلك `test:codex-contract` ومسباران حيان: القراءة تنجح بلا إذن، و
    `open_preview` الخارجي يصل إلى `permission_request` الداخلي بدل الرفض الصامت.
- **اعتراض المتصفح الخارجي + التسليم البشري (دفعة «تحكم الوكيل الكامل» — 2026-07-18)**:
  علاج «نسيان» النموذج للمعاينة المدمجة بثلاث طبقات + ميزة تسليم القيادة للمستخدم:
  - **الاعتراض (الشق 1)**: `electron/browserguard.js` (انظر خريطة الملفات) يستهلكه
    المحرّكان — في SDK اعتراض داخل `canUseTool` لأمر `Bash`/`run_in_terminal` يفتح
    متصفح نظام خارجي ⇒ `deny` برسالة عربية توجّه لأدوات المعاينة (قبل مربع الإذن وقبل
    أي «موافقة دائمة» — يعمل حتى في bypass/acceptEdits)؛ وفي Codex الحاجب القائم في
    `codex.js` صار يستورد الدالة المشتركة. **ذكر المستخدم للمتصفح الخارجي** («افتح
    كروم»، in chrome…) في رسالة الدور لا يعطّل الحاجب بل يحوّله إلى **مربع إذن قسري
    لمرة واحدة** في المحرّكين — يتخطى «الموافقة الدائمة» ووضع auto
    (`promptRequestsExternalBrowser` — heuristic؛ ملاحظة مراجعة Codex المثبّتة: التعطيل
    الكلي كان يجعل الذكر العابر + موافقة Bash دائمة تنفيذاً صامتاً). التوجيه قُوّي في المحرّكين:
    المعاينة **للويب العام لا localhost فقط** + «اعرض تنفيذ الخطوات اليدوية بنفسك».
  - **التسليم البشري (الشق 2 — `browser_handoff(reason)`)**: أداة في خادم satr-terminal
    ‏(SDK) وcodexmcp ‏(Codex) — حين تحتاج خطوة بيانات حساسة (تسجيل دخول/2FA) يسلّم
    الوكيل قيادة المعاينة للمستخدم يدخلها بيده في WebContentsView (الكوكيز في partition
    الدائمة تعيش عبر التشغيلات). تبثّ `handoff_request {id, reason}` ⇒ شريط 🤝 في
    `preview-panel` بزرّي «استلمت ✓»/«إلغاء» ⇒ الردّ `satr:handoffDone {id, done}`
    (منقّى `SAFE_HANDOFF_ID`، ‏boolean فقط — preload يكشفه `handoffDone`) ⇒
    `resolveHandoff` على مقبض المحرك، ثم `handoff_end {id}` يخفي الشريط (يغطي حسم
    الإيقاف). النتيجة للنموذج نصية فقط («استلم — خذ snapshot جديداً» / «ألغى») بلا أي
    محتوى صفحة. **الأمان (قرار مالك، fail-closed)**: أثناء التسليم علم `handoffActive`
    في `preview.js` المشترك يعلّق **كل** أدوات الوكيل رؤيةً وفعلاً (`{error:'handoff'}`
    من الدوال الوكيلية الـ14؛ `navigate`/`open_preview` المشتركتان مع الواجهة تُحجبان
    عند موقع الأداة في المحرّكين)، وعند نهاية التسليم `endHandoff` **يصفّر سجلّي
    console/الشبكة** (قد تحمل أسراراً أُدخلت أثناءه). أزرار الواجهة (رجوع/تحديث/العنوان/
    التسجيل) لا تُحجب — المستخدم هو القائد. `browser_handoff` ضمن BROWSER_AUTO_TOOLS
    (منح القيادة للمستخدم فعل آمن fail-safe)، ومهلة أداة MCP في Codex رُفعت
    600⇒**1800ث** لتتّسع لدخول + 2FA. إيقاف الدور يفكّ التسليم بالإلغاء في المحرّكين.
    الاختبار: `test:browserguard` (نقي 32) + توسعة `test:codexmcp` (64 — دورة كاملة
    استلام/إلغاء/تعليق/fail-closed).
- **شفافية المتصفح المشتركة (دفعة «المتصفح عضو مشترك»)**:
  - `click/type/select/hover/scroll/press` تومض outline ذهبياً **داخل الصفحة** قبل الفعل.
    الأفعال الأربعة المؤثرة تعيد `{ok,navigated,dom_changed,note?}` بعد رصد URL و
    `MutationObserver` قصير؛ عدم رصد أثر يُقال للنموذج صراحةً بدل نجاح وهمي. الكتابة تدعم
    `contenteditable` عبر focus+selection+beforeinput/execCommand/input.
  - `screenshot` و`browser_screenshot_element` يبثان `agent_screenshot` بمصغرة PNG ≤360px/
    512KiB عبر قناة `satr:preview`؛ القشرة تضيفها إلى بطاقة أدوات الدور، والنقر يفتح عارضاً
    مكبراً. صورة MCP الأصلية تبقى للنموذج. لقطة 🎯 تستخدم IPC صامتاً فلا تُسجّل كلقطة وكيل.
  - كل خطأ console/شبكة في لوحة 🐞 له زر «🤖 أصلحه» يرسل سياقاً منظماً كدور عادي. بعد
    `reloadIfLive` تُجمع الأخطاء الجديدة 4.2ث وتظهر مرة لكل موجة في `addActionNotice`
    بزر «أرسلها للوكيل».
  - شريط 🎯 يضيف «اشرح/أصلح/حسّن»، ويلتقط العنصر تلقائياً ويرفق PNG عبر مسار صور
    المحرّكين الأصيلين؛ المحوّلات النصية تتراجع للوصف. outerHTML يبقى محتوى غير موثوقاً
    مقتطعاً. رأس المعاينة يعرض شارة خادم cwd خضراء، أو رمادية بزر تشغيل من سجل devservers.
- **عدة التحقق الذاتي**: الأدوات المتكافئة في SDK/Codex/Kimi هي `browser_evaluate` (act؛ تعبير
  ≤8000، CDP timeout، نتيجة ≤48K)، `browser_set_viewport` (read؛ 240..1920×240..1200
  ويعيد innerWidth الفعلي)، `browser_perf` (read؛ navigation/resources/طلبات فاشلة)، و
  `browser_back/browser_forward` (navigate مع target من سجل NavigationHistory). تدخل
  `envbrief` و`satr-guide` وحارس الجرد تلقائياً.
- **قياس قرائية الحرف العربي — `browser_readability`** (2026-08-27): أداة **قرائية محضة**
  (بلا مدخلات) في المحرّكات الثلاثة، تقيس الصفحة المفتوحة في المعاينة على أربعة محاور:
  (1) **رسو اتجاه كل فقرة بالبكسل** عبر `Range.getBoundingClientRect()` لأول محرف مقابل
  صندوق العنصر، ومقارنته بحسم إحصائي (`ar*2 >= lat`) — وهو العطل الذي **لا تكشفه**
  `getComputedStyle(el).direction` لأنها تعيد `rtl` الموروثة بينما الفقرة رست LTR
  (نفس مقياس `scripts/arabic-rtl-probe.js`)، ووصف المخالفة يسمّي بصمة `plaintext/dir=auto`
  حين يبدأ النص برمز لاتيني؛ (2) التباين مقابل WCAG (‏4.5/3 حسب الحجم والوزن) مع تصنيف
  خلفية الصورة/التدرّج «غير محدَّد» بلا تخمين؛ (3) التجاوز الأفقي للمستند وللعنصر؛
  (4) أسر الخطوط المستعملة على نصّ بالحرف العربي وغير المحمّلة في الصفحة (`document.fonts`)
  ⇒ سقوط صامت إلى خط النظام. النطاق **عائلة الحرف كلها** (‏`OBS-037`): عربي + ملحقه +
  الموسّعان أ/ب + شكلا العرض — أوسع من نطاق `text-dir.js` عمداً لأن المقيس مشاريع المستخدمين.
  - **لماذا تدخل `AUTO_SAFE_TOOLS` وحدها من أدوات الفحص البنيوي**: قرائيتها المحضة
    **مُثبَتة بفحص حيّ** لا مفترضة — `test:readability` يفحص DOM بعد القياس ويشترط صفر
    `data-satr-ref` وصفر عنصر مُقحَم وصفر تمرير. بذلك تُغلق حلقة «قِس ← أصلح ← أعد القياس»
    بلا مقاطعة المستخدم عشرات المرات، بخلاف `browser_evaluate` التي تُؤكَّد كل مرة بلا
    «دائماً». ولهذا بقيت `browser_snapshot` (تكتب `data-satr-ref`) و`browser_scroll`
    (تطلق lazy-load) و`browser_hover` خارج القائمة كما كانت.
  - **الصدق في الناتج**: `unseen:{shadow_roots,iframes}` يُصرَّح به لأن `querySelectorAll`
    لا يخترقهما (القيد نفسه في `SNAPSHOT_FN`/`READ_SCRIPT`) — فلا يُقرأ الصمت «صفر
    مخالفات»؛ و`viewport` يعيد `innerWidth` الفعلي مع سبب التضييق (‏`OBS-028`) لأن الحكم
    على التجاوز الأفقي بعرض مقصوص حكمٌ مضلّل؛ و`total_findings` يذكر الإجمالي قبل القصّ.
    السقوف: 200 عنصراً ممسوحاً · 20 مخالفة مرتّبة بالأسوأ · ناتج ≈2ك.ب.
    ‏`OBS-143`: يستبعد قياسُ الرسو نصّ سليل يفرض اتجاهه (`dir`/`bdi`/عزل bidi)،
    والنصّ الذي يسبقه محتوى مرسوم، كي لا يُنسب موضعه إلى الأب. `unseen.direction`
    يعدّ الكتل التي تعذّر حسم اتجاهها (ومنها الرسو المتعادل)، والتقرير لا يعدّها
    مجتازة. السليل المستقل غير الدلالي مثل `span` لا يُفحص منفرداً؛ قد يحمل عيباً
    حقيقياً، فهذا حدّ معلن لا شهادة سلامة له.
  - **نسخة صياغة واحدة**: `codexmcp.formatReadability` يستهلكها الخادم و`agent.js` معاً
    (نمط `whyClosed`) فلا يتباعد تقرير المحرّكين لقياس واحد. والسكربت في العالم المعزول
    (‏`runIsolated` — `OBS-018`) لا في main world.
  - **الحارس**: `npm run test:readability` (‏Electron حيّ، داخل `test:full`) يستخرج
    `READABILITY_FN` من `preview.js` **وقت التشغيل** ويشغّله على fixture فيه العيوب الأربعة
    مزروعة — فلا يقارن نسخةً بنسخة (درس `test:langmetric`)، ويضيف عقوداً ساكنة على مواضع
    التسجيل الستة فيفشل عند أي موضع منسيّ. مُثبَت أنه يعضّ: شُغِّل قبل الوصل فسقطت الخمسة.
- **إعلان تضييق `browser_set_viewport`** (‏`OBS-028` + تغذية راجعة 2026-08-24): عرض
  اللوحة سقفٌ للطلب دائماً (‏`effectiveBounds` يقصّه)، وكان التجاوز **صامتاً** — طلب
  `1280` يعيد `ok:true` و`actual:390` بلا تفسير، فيتعذّر الحكم على تخطيط سطح المكتب.
  الآن تبلّغ اللوحة الوضع النشط مع المستطيل (`previewBounds(x,y,w,h,device)` — معامل
  خامس اختياري، والاستدعاءات بأربعة تبقى صالحة)، و`main.js` ينقّيه بقائمة مغلقة
  `mobile|tablet` (أي قيمة أخرى ⇒ `null` بلا إفشال الطلب)، و`setViewport` يعيد
  `clamped:true` و`note` عربياً يسمّي السبب — وضع محاكاة الأجهزة باسمه أو ضيق اللوحة —
  ويذكر العلاج. الأداة تطبع الملاحظة **قبل** JSON في المحرّكين فلا تُدفن. لا تغيير في
  حدود المقاس ولا في سلوك «كامل» (‏`mode` يُبلَّغ فقط حين يضيّق العرض فعلاً).
- **عقد اللقطة وحصانة العالم المعزول (دفعة «صقل متصفح سطر» — OBS-013/014،
  2026-08-15)**: علاج تنازع التحكم بين المستخدم والوكيل (مسبار الاستنساخ أثبت أن
  تغيير الحالة وتبديل معنى العنصر كانا **صامتين** — الوكيل رأى «حفظ» ونفّذ «حذف»
  بـ`ok:true`). **الكشف في العملية الرئيسية حصراً** (المسبار الحاجز
  `scripts/browser-guard-probe.js` أثبت أن `sendInputEvent` يُطلق `input-event`
  وأن أفعال `executeJavaScript` الوكيلية لا تمر به): عدّاد إدخال ملتزم
  (‏`mouseDown`/`rawKeyDown`/`keyDown` فقط) في `wireEvents`، وكل لقطة تحفظ
  `leaseUserRevision`، وأي فعل `act` يمر **بفحصين** (قبل بوابة الإذن عبر
  `preview.leaseError()` المصدَّرة — تستدعيها الأغلفة، وبعدها قبل التنفيذ) ⇒
  تدخّلٌ بعد اللقطة يرفض الفعل `input_changed` **حجباً شاملاً v1 بقرار مالك**
  (التخفيف لدرجتين لاحقاً بأرقام محلل السجلات). `pressKey` يمر بمسار الإدخال
  فيستهلك العقد بنفسه (لا provenance في `input-event` — الالتباس يفشل مغلقاً).
  **بصمة الهدف** `role+name+tag(+href/type)` بتطبيع فراغات فقط (لا حذف أرقام)
  تُحسب في مرور `SNAPSHOT_FN` وتُخزن في main (لا تعبر للنموذج)، وحلّ الهدف +
  المقارنة + التنفيذ في نداء `executeJavaScriptInIsolatedWorld` واحد
  (‏`AGENT_WORLD_ID=1013` — على `WebContents` نفسه لا `WebFrameMain`؛ يقاوم صفحة
  تخرّب `querySelector` في main world) ⇒ تباعدٌ يرفض `target_changed` بالاسمين
  (was/now)، واختفاء السمة بعد وجودها في الجيل يشخَّص `ref_removed`. البصمة
  **كاشف انجراف لا برهان أمني**. الإبطال يشمل الآن `endHandoff` و`startPick`
  (عطل اكتشفه العصف الثلاثي). حدث `control_conflict` على قناة `satr:preview`
  تعرضه اللوحة شارة عابرة غير حاجبة — أزرار المستخدم لا تُحجب أبداً. **دلالة
  النتيجة الصادقة**: `dispatched`/`effect_observed`/`satisfied` (‏الأخير
  لـtype/select فقط ويعود فوراً بلا مهلة عند تحققه) مع بقاء `dom_changed`
  للتوافق، والرسائل العربية الثلاث نسخة واحدة في `codexmcp.js` يستهلكها
  `agent.js` (‏`whyClosed` مصدَّرة). توجيه اللقطة الكاملة (قرار مالك): وصف
  `screenshot` وenvbrief يشرحان ضيق اللوحة، و`screenshot({includePageMetrics:true})`
  يعيد `page_metrics` فيُلحق تلميح «الصفحة أطول من المعروض N×» عند ≥3×.
  المهلات (‏360/250/150ms) **لم تُلمس عمداً** — يحرسها عقد حي والأرقام لم تبرر
  لمسها. محلل التوزيع `scripts/browser-session-audit.js` (قراءة فقط فوق
  `~/.claude/projects`): من 25 جلسة — حصة اللقطات البصرية **99.7%** من البايتات
  ووسيط دور النموذج بعد `screenshot` ‏12.1s (انظر OBS-016). الحارس القطعي
  `test:preview-lease` (‏Electron حي، 11 عضّة مستعادة) داخل `test:full`، مع
  توسعة `test:codexmcp` (‏147) و`test:browser-member-live` (شارة التنازع).
  خام الدفعة كله (عصف/نقد/عقد مجمَّد/تقارير) في `D:\sater\prompts-browser-bs\`.
- **متانة العرض والتنزيل**: partition المعاينة يعترض `will-download`، ينقّي الاسم ويختار
  مساراً فريداً داخل Downloads ثم يبث المسار الفعلي أو الفشل؛ لا حفظ صامت. خطاف
  `certificate-error` يقبل شهادة ذاتية لـ`https://localhost`/`127.0.0.1` حصراً ويرفض
  الشهادة السيئة لأي origin خارجي. `test:preview-member-live` يغطي الفعل/الوميض/
  contenteditable/evaluate/viewport/history/download وحصر الاستثناء، و
  `test:browser-member-live` يغطي المصغرة/أصلحه/موجة الأخطاء/🎯/شارة الخادم تحت CSP.
- **تسجيل فيديو التصفح (م-5، ترقية «استوديو البروموا الوكيلي» — المرحلة 1)**: زرّ ⏺
  يختار `16:9` ‏(1920×1080) أو `9:16` ‏(1080×1920) أو `1:1` ‏(1080×1080)، ثم يطلب
  إذناً صريحاً ويفتح `BrowserWindow` مرئية، مستقلة، sandbox، بلا preload أو واجهة «سطر».
  `promocapture.js` يحمّل URL المنتج وينتظر استقراره، ويستدعي
  `desktopCapturer.getSources({types:['window']})` ويطابق `HWND` لمعرّف النافذة حصراً.
  على Electron 33/Windows ثبت حياً أن `getSources` قد لا يدرج نافذة **العملية نفسها** رغم
  ظهورها؛ عندها فقط يستخدم `BrowserWindow.getMediaSourceId()` المباشر (`window:HWND:1`)
  للنافذة المنشأة، وتمنح بوابة `setDisplayMediaRequestHandler` إطار المنتج نفسه حصراً.
  لا title fallback ولا شاشة كاملة ولا source id من renderer.
- الواجهة تستقبل المعرّف من main وتطلب `getUserMedia` بقيود
  `chromeMediaSource:'desktop'` + المعرّف + `30fps`، ثم `MediaRecorder` مباشرةً؛ أزيلت
  حلقة `capturePage`/PNG و`canvas.captureStream(8)` من مسار التسجيل. مؤشر ⏹ أحمر نابض
  يبقى في رأس المعاينة، والإيقاف/انتهاء الدور/إغلاق التطبيق يوقف المسارات ويغلق نافذة
  المنتج. التنزيل محلي في Downloads باسم `satr-promo-segment-*` منقّى وفريد ولا يُرفع.
- الأدوات المتكافئة: `promo_record_start({aspect,url?})` و`promo_record_stop()` أفعال
  `neverAlways` في SDK وCodex وKimi، و`promo_list_segments()` قراءة. أدوات القيادة هي أدوات
  المتصفح القائمة لأن `preview.js` يوجّهها مؤقتاً إلى نافذة المنتج؛ لا أدوات قيادة جديدة.
  IPC الواجهة محددة (`promoCaptureStart/Stop/Ready/Commit/Abort`)؛ `confirmed:true` لازم،
  وmain يرفض `sourceId` من renderer. تحقق Electron الحي: `ERR_FAILED=false`، stream واحد،
  `frameRate=30`، MediaRecorder‏ MP4/H.264 ذو `ftyp` وBlob غير فارغ، ثم إغلاق كامل.
- **استوديو الإنتاج (ترقية م-5 — المرحلة 2)**: الأداة المتكافئة
  `promo_propose_storyboard({scenes})` تقبل 1–40 مشهداً، كل واحد `segment_path|asset`
  محلياً داخل Downloads، و`caption/duration_ms/transition/music/voice` اختيارية، ومعها
  `trim_start_ms` و`fit` و`caption_position/style` ومستويات `clip/music/voice_volume`. main
  يرفض URL بعيداً، مساراً خارج Downloads، امتداداً غير وسائطياً، أو مدة خارج
  `250..120000ms`؛ الأداة تبث الاقتراح فقط ولا تعتمد أو تصيّر. إن توفرت أداة Higgsfield
  ‏`generate_audio` للوكيل، يولّد الموسيقى/التعليق بها ثم **ينزّل الملف أولاً** إلى
  Downloads ويشير إلى مساره المحلي؛ الاستوديو لا يحمّل URL بعيداً ولا يرفع أي أصل.
- `<satr-promo-studio>` حوار Shadow بأنماط `adoptedStyleSheets` وtokens، ويُدار عبر
  `surfaceCoordinator` كي تُحجب WebContentsView الأصلية أثناءه. يعرض المشاهد ويتيح أزرار
  إعادة الترتيب والتكرار، قص البداية والمدة، ملاءمة cover/contain، تحرير موضع ونمط العنوان
  العربي، ضبط مستويات المقطع والموسيقى والتعليق، حذف مشهد، وإعادة تسجيله عبر مسار المرحلة 1.
  كل تعديل يسقط الاعتماد؛ زر «صيّر» لا يعمل حتى يضغط
  المستخدم «اعتماد الخط الزمني» صراحةً (الوكيل يقترح ولا يقرر النتيجة النهائية).
- المُصيّر صفري الاعتماديات في `promo-renderer.js`: `<video>`/`Image` تفك الأصول المحلية،
  ويطبق قص البداية ثم يرسمها `canvas` بنسبة storyboard مع cover/contain و`cut` أو fade،
  ويطبع العنوان بخط IBM Plex Sans Arabic واتجاه `rtl` في أعلى/وسط/أسفل بصندوق أو نمط بسيط.
  Web Audio يمزج صوت المقطع + music + voice بمستويات كل مشهد إلى
  `MediaStreamDestination`؛ تُضم مساراته إلى `canvas.captureStream(30)` ثم MediaRecorder
  يخرج `satr-promo-final-*` إلى Downloads. التصيير **فوري بزمن الجدار**: 60 ثانية فيديو
  تستغرق نحو 60 ثانية، وتبقى نافذة الاستوديو مفتوحة خلاله.
- **مقايضة واعية**: التصيير المبني على `requestAnimationFrame` وMediaRecorder غير حتمي
  frame-perfect وقد يسقط/يكرر إطاراً تحت الحمل. `VideoEncoder:false` في Chromium الحالي
  وffmpeg ممنوع كاعتمادية يحافظان على النواة المفتوحة صفريّة الاعتماديات؛ ترقية مستقبلية
  ممكنة باكتشاف ffmpeg اختياري مثبت لدى المستخدم، لا بشحنه ولا بجعله شرطاً.
- تحقق `test:promo-studio` الحي تحت CSP الصارمة يولّد مقطعين، يغيّر ترتيبهما ومدتهما
  وعنوانهما والموسيقى، ويختبر القص وcontain والتكرار وموضع/نمط العنوان ومستويات الصوت،
  ويمر ببوابة الاعتماد وإعادة التسجيل، ويمزج WAV محلياً من `file:` مع عنوان RTL ثم ينتج
  MP4 غير فارغ. `media-src 'self' blob:` هو التوسعة الوحيدة للقالب.
- **الحاوية mp4 مفضّلة (دفعة «mp4»)**: `pickRecMime()` يفاضل `video/mp4;codecs=avc1…`
  أولاً ثم webm عبر `MediaRecorder.isTypeSupported`، والنوع والامتداد يتبعان المُختار.
  التنزيل ليس صامتاً: `previewrecording.js` يعترض أسماء `satr-preview-*` و
  `satr-promo-segment-*` القادمة من renderer الرئيسي، يثبت مساراً فريداً داخل
  `app.getPath('downloads')`، ثم يبث
  `preview_recording_saved` بالمسار الفعلي لتعرضه المحادثة. **قرار مثبّت بمسبار حيّ**:
  Electron 33 (Chromium 130) يدعم MediaRecorder بحاوية mp4
  (H.264) فلا حاجة لـ muxer ولا ffmpeg ولا أي اعتمادية — MediaRecorder يغلّف داخلياً.
  مسار WebCodecs (VideoEncoder) **غير متاح في هذا المحرك** (المسبار: `VideoEncoder:false`)
  فلا يُعوَّل عليه. السقوط لـ webm تلقائي إن غاب دعم mp4 مستقبلاً.
- **التحرير بالتأشير (م-2)**: زرّ 🎯 يبدأ وضع تحديد — `preview.startPick()` يحقن سكربتاً
  في الصفحة المعزولة عبر `executeJavaScript` يعيد **Promise يُحلّ عند نقر المستخدم** على
  عنصر (outline ذهبي يتتبّع المؤشر + يمنع تفعيل الروابط + Escape/إلغاء ⇒ null). لا
  preload في العرض ⇒ قيمة الـ Promise هي مخرج البيانات الوحيد. يلتقط `{selector تقريبي،
  tag، outerHTML مقتطع، نص}` ⇒ شريط ملخّص + حقل طلب ⇒ حدث `preview-edit` ⇒ القشرة تركّب
  سياقاً وترسله **كدور عادي** (مسار send — صفر عقد جديد). IPC: `previewPick`/
  `previewPickCancel`. **أمان**: outerHTML من صفحة غير موثوقة يُغلَّف كـ «محتوى» ويُقتطع
  (حقن برومبت محتمل موثّق — م-2 وصف فقط، المستخدم يبادر ويرسل).
- **حجب المعاينة أثناء مربع الإذن (إصلاح لقطة مالك)**: WebContentsView طبقة نظام فوق كل
  DOM — فمربع الإذن (perm-dialog) كان يختبئ خلف المعاينة، والوكيل يعلّق بانتظار ردّ لا
  يُرى (خاصة في acceptEdits حيث تمرّ Edit بلا إذن لكن Bash/أدوات المعاينة تطلبه). الحل:
  perm-dialog يبثّ `perm-visible {visible}` عند كل ظهور/إخفاء، ومنسّق الأسطح في القشرة ينقله
  إلى `held` ويستدعي `previewEl.holdForDialog(visible)` فتُخفي العرض الأصلي (previewBounds صفر)
  أثناء المربع ثم تعيده بقياس حي بعد الرد. الحوار يحبس التركيز ويعيده المنسّق إلى المصدر.

