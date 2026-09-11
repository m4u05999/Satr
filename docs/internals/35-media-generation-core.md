### نواة توليد الوسائط BYOK (م١ — الجولة 8، البند الأول)

> الخطة الحاكمة `docs/GENERATION-PLAN.md` وعقدها المجمَّد §1. هذا القسم يوثّق **ما أثبته
> المسبار الحيّ حصراً** — لا عقد سلك مجمَّد بلا استدعاء حيّ (المبدأ 5).

- **المسبار أولاً**: `scripts/genmedia-probe.js` شُغّل حياً 2026-08-01 على
  Node ‏v26.5.0/win32 بأصغر كلفة (صورة واحدة لكل مزوّد + فيديو واحد قصير). يطبع البنية
  والأطوال ورموز الحالة لا المحتوى، وكل سطر يمر بـ`redact()` فلا يظهر مفتاح؛ مفتاح غائب
  ⇒ `SKIPPED: no key`. الأصول للمعاينة البشرية في `dist/genmedia-probe/`.
- **fal — PROVEN (الوحيد المفعَّل)**. العقد المجمَّد كما رُصد حرفياً:
  1. `POST https://queue.fal.run/<model>` بترويسة `Authorization: Key <FAL_KEY>` ⇒ `200`
     مع `{status:'IN_QUEUE', request_id(len=36), response_url, status_url, cancel_url,
     logs:null, metrics:{}, queue_position:0}`.
  2. `GET status_url` ⇒ **`202` ما دام `IN_QUEUE`/`IN_PROGRESS`، و`200` عند `COMPLETED`**.
     التسلسل المرصود: `IN_QUEUE -> IN_PROGRESS -> COMPLETED`.
  3. `GET response_url` ⇒ `200`؛ صورة: `{images:[{url,width,height,content_type}], timings,
     seed, has_nsfw_concepts, prompt}` · فيديو: `{video:{url,content_type,file_name,
     file_size}, seed}`.
  4. الأصل يُجلب بـ`GET` عادي على `url` **بلا ترويسة اعتماد** (متحقَّق: `image/jpeg` و
     `video/mp4` بمطابقة magic bytes).
  ⚠️ **`status_url`/`response_url` تُستعملان كما أعادهما المزوّد ولا تُبنيان محلياً**: المسار
  المرصود يطوي `fal-ai/flux/schnell` إلى `fal-ai/flux/requests/<id>`.
  الأرقام الفعلية: صورة `fal-ai/flux/schnell` بـ`image_size:'square_hd'` ⇒ `1024×1024`
  و`41948` بايت في `3416ms` باستقصاء واحد؛ فيديو `fal-ai/ltx-video` ⇒ `3699240` بايت
  MP4 بعد `67` استقصاءً و`215738ms`.
- **openai — UNPROVEN**: المفتاح مقبول والمسار صحيح، لكن الحساب ردّ `400`
  `billing_hard_limit_reached` («Billing hard limit has been reached.») على
  `gpt-image-1-mini` و`gpt-image-1` معاً — فلم تُرصد بنية استجابة ناجحة قط.
- **gemini — UNPROVEN**: `gemini-2.5-flash-image` ردّ `429 RESOURCE_EXHAUSTED` مع
  `limit: 0` على `generate_content_free_tier_requests` (توليد الصور خارج الطبقة المجانية)،
  و`gemini-2.5-flash-image-preview` ردّ `404 NOT_FOUND` (النموذج غير موجود بهذا الاسم).
- **أثر ذلك في الكود (fail-closed)**: المزوّدان المباشران **معرَّفان في السجل ومعطَّلان بلا
  مسار سلك**: التوجيه لا يختارهما، واختيار نموذجهما صراحةً يعيد `provider_unproven` برسالة
  عربية ترشد إلى إصلاح الحساب. لا كود تخميني يدّعي عقداً لم يُرصد. بعد إصلاح الحساب:
  أعد المسبار ⇒ جمّد الشكل المرصود ⇒ فعّلهما. وخانة `managed` (م٣) معرَّفة معطَّلة بلا منطق.
- **API الوحدة**: `listCatalog()` · `estimate(req)` · `generate(req, ctx)` · `readLog(cwd,n)`
  حيث `req = {cwd, kind, prompt, model?, count?, refs?, budget_usd?}`. الأنواع `image`
  (fal) و`video` (fal)؛ الصوت خارج ج8.
- **السقف الصلب**: `budget_usd` يُفحص **قبل أي استدعاء شبكة** ويعيد `over_budget` بلا نداء،
  ويُعاد فحصه لكل مرشّح في سلسلة السقوط فلا يتجاوز السقوط الميزانية أبداً.
- **المفاتيح**: بيئة النظام أولاً ثم `keys.get` (تحميل كسول كي تعمل الاختبارات بلا Electron)
  — لا تدخل نتيجةً أو حدثاً أو سجلاً أو رسالة خطأ. متحقَّق بفحص صريح.
- **الأصول والسجل**: الأصول تحت `<cwd>/generations/` باسم مبنيّ لا مشتق من البرومبت
  (`gen-<kind>-<epoch>-<rand>-<i><ext>`) وبامتداد من `content-type` بقائمة سماح، وسقف
  `64MiB`؛ **حارس النطاق**: الأصل لا يُجلب إلا من `https` ونطاق `fal.media` (أو نطاق فرعي)
  فيُرفض رابط من نطاق آخر قبل التنزيل. السجل `<cwd>/.satr/generations.jsonl` بحقول v1
  المجمَّدة، إلحاق ذرّي أفضل جهد، سقف `4MiB` بقصّ الأقدم عبر temp+rename.
  البرومبت ≤`2000` نقطة Unicode بعد إزالة التحكم/Bidi، وإن التقطه `memory.hasSecret`
  يُخزَّن فارغاً بعلامة `prompt_redacted`. لا مسار مطلق ولا مفتاح ولا خرج API خام.
- **المراجع**: مسارات نسبية داخل `cwd` حصراً بحارس `inject.resolveInside` نفسه (لا مطلق،
  لا `..`، ولا هروب symlink) بسقف `6`. ولأن **مسار المراجع لم يُثبته المسبار لأي نموذج
  مفعَّل**، فالمرجع الصالح يُرفض بـ`refs_unsupported` بدل تجاهله صامتاً (ج9).
- **حدود موثّقة**: أرخص صورة اليوم `1024×1024` من `fal-ai/flux/schnell` — أحجام أخرى غير
  مثبتة. الفيديو نموذج واحد بلا معاملات مدة/دقة مثبتة و`max_count=1`. الأسعار تقديرية
  بتاريخ `catalog_date` ولا تُنسب إلى فاتورة المزوّد. `ctx.models`/`ctx.request`/
  `ctx.baseUrls` منافذ **داخلية للاختبار** (ctx لا يعبر من renderer، والسائق محصور في
  `DRIVERS`).
- **التحقق**: `node scripts/genmedia-test.js` (قطعي، بلا شبكة خارجية — خادم HTTP محلي
  يحاكي عقد fal المرصود) غطّى `26/26`: الكتالوج الموسوم، عزل غير المثبت، التوجيه الأرخص
  والسقوط الصريح، السقف الصلب قبل الشبكة وداخل السقوط، دورة `202/200`، حصر المراجع،
  حارس النطاق ونوع الأصل، schema السجل والقصّ وreadLog، تفريغ البرومبت الحسّاس، وعدم
  تسريب المفتاح في أي نتيجة/سجل/اسم ملف. وتحقّق حيّ من طرف إلى طرف عبر الوحدة الحقيقية
  (بلا حقن) ولّد `35801` بايت JPEG وكتب سطر السجل بلا تسريب. `npm run eval:agent` بقي `12/12`.

