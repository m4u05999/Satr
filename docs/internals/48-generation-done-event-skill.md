### حدث اكتمال التوليد ومهارة `satr-generate` — الجولة 9

- بعد نجاح `generate_media` تعيد `electron/tools.js` بناء حدث العرض وحده بالشكل المغلق
  `{type:'generation_done',kind,files:[rel],cost_usd_estimate,provider,model}`. الملفات
  نسبية تحت `generations/`، والأنواع تشمل `image|video|audio`؛ لا يدخل الحدث البرومبت أو
  المفتاح أو كائن المزوّد/SDK الخام. الفشل أو النجاح الخام بلا ملف نسبي صالح لا يبث حدثاً.
- المحوّلات تمرّر `ctx.emit` القائم، وSDK يمرّر باعث الدور نفسه إلى الطبقة المشتركة.
  `codexmcp.js` يقبل باعثاً محلياً للاختبار، وفي التشغيل يمر عبر مصرف واحد يربطه `main.js`
  بمسار `satr:event`. يعيد `main.js` تنقية الحدث بقائمة الحقول المغلقة نفسها قبل renderer؛
  لا يدخل `KNOWN_EVENT_TYPES` لأنه حدث منسّق، نظير `loop_update`.
- المهارة المضمّنة `.agents/skills/satr-generate/` تطبق سياسة الطبقات الثلاث: HTML/CSS
  للنص العربي والهوية الدقيقة، و`generate_media` للمشاهد، والموصّل الخارجي فقط إذا سمّاه
  المستخدم. مواردها تحميل تدريجي للصياغة، والعربية المشروطة بالنموذج، والميزانية، ونمط
  `promo/instagram/post.html` + `scripts/ig-post-shots.js` الموثق.
- سياسة الصور v2.1: GPT Image افتراضي الجودة والعربية، و`fal-ai/flux/schnell` لطلب
  «الأرخص» والمشهد بلا نص. الفيديو بلا نموذج يمر `AskUserQuestion` بخيارات المسبار المثبتة
  وأسعارها المؤرخة وينتظر المستخدم؛ لا اختيار تلقائي. لقطة المسودة الحالية لا تخترع
  خيارات الجولة 9 قبل دمج نتيجة مسبار أوبس واعتماد المالك.
- `satr-generate` مضافة إلى `BUILTIN_SKILLS` وإلى `build.files`/`asarUnpack` بنمط
  `satr-guide`. `scripts/codexmcp-test.js` يثبت schema والتنقية وعدم التسريب والأسطح
  الثلاثة بالمزيّف، و`tools.md` يبقى مولّداً حصراً عبر `npm run gen:satr-guide`.

