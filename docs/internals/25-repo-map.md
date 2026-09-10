### خريطة المستودع المقتصدة للمزوّدات العمياء (الأولوية 5 — الدفعة الأولى)

- **النطاق**: `electron/repomap.js` يبني عند الطلب خريطة تقريبية للمسارات وأبرز تعريفات
  `function|class|const|export` بتعابير regex بسيطة حسب عائلات JS/TS وPython وRuby وPHP
  وGo وRust وJVM/.NET وC/C++ وSwift. لا parser ولا vector DB ولا dependency أو فهرس دائم.
- **الأمان والاقتصاد**: لا قراءة مسار جديدة؛ السرد عبر `files.listFiles` والقراءة عبر
  `files.readText` المؤمَّنتين، وترتيب الاستعلام يعيد استخدام `search.normalize/queryTerms`.
  السقوف: 400 ملف مرشّح، 256KiB/ملف، أول 96KiB و4000 سطر، 12 رمزاً/ملف و500 إجمالاً،
  120 ملفاً في الناتج، 1.2ث للمسح و24KiB للنص. لا تُعرض قيم الثوابت أو أجسام الدوال؛
  التوقيع فقط. نفاد أي سقف يعيد نتيجة جزئية بدلاً من تمديد العمل.
- **العقد**: أداة `repo_map({query?})` موجودة في `electron/tools.js` فقط، قراءة بلا إذن؛
  عائلتا OpenAI-compatible وGemini ترثانها تلقائياً. الناتج موسوم
  `<satr_repo_map estimate="true">` ويوجّه النموذج للتحقق بـ`search_code/read_file` قبل
  التعديل. لا تكامل في `agent.js` أو `codex.js` لأن المحرّكين الأصليين يملكان أدوات بحثهما.
- **التحقق**: `npm run test:repomap` يغطي الاستخراج متعدد اللغات، تجاهل المجلدات الثقيلة،
  الملف الضخم، أولوية الاستعلام وسقوف الوقت/الملفات/الرموز/الناتج وعقد القراءة بلا إذن.

#### حقن الخلاصة وتقدير الميزانية (الأولوية 5 — الدفعة الثانية)

- **الخلاصة التلقائية**: `repomap.summarize(cwd,prompt)` تبني في بداية كل دور للمحوّلات
  العمياء نسخة أصغر موسومة `<satr_repo_map mode="summary" estimate="true">`: حتى 160 ملفاً
  ممسوحاً، 24 ملفاً في الخلاصة، 600ms و3200 محرف (≈1600 رمز تقديري في أسوأ توزيع محارف).
  تُدمج مع سياق Skills والذاكرة في system context لعائلتَي OpenAI-compatible وGemini،
  قبل أول طلب؛ محركا SDK وCodex لا يتأثران.
- **ميزانية تقديرية صريحة**: `electron/context.js` يستخدم heuristic محلياً (ASCII نحو 4
  محارف/رمز، وغير ASCII نحو محرفين/رمز) ويحقن كتلة
  `<satr_context_budget estimate="true" method="character_heuristic">`. الرقم إرشادي لا
  يُنسب إلى tokenizer المزوّد، ويوجّه النموذج لاختيار الملفات ثم التدرج بـ`search_code/read_file`.
- **عقد usage**: كل طلب وجولة يضيفان تقدير input/output محلياً. إن أعاد API usage حقيقياً
  فهو المصدر المقدّم بلا تغيير؛ إن غاب يعود `result.usage` بالشكل
  `{input_tokens,output_tokens,estimate:true,method:'character_heuristic'}`، ومعه
  `context_estimate` لميزانية بداية الدور. لا تكلفة مالية مشتقة من هذا التقدير.
- **التحقق**: `npm run test:context` يغطي سقف الخلاصة، وسم estimate، أولوية usage الحقيقي،
  fallback التقديري، ودورة HTTP فعلية تثبت وصول الخلاصة والميزانية لمحوّل OpenAI-compatible.
- **ملخص استهلاك جلسة Community**: `src/ui/lib/usage-summary.js` يطبّع ويجمع usage لكل
  نتيجة دور في الذاكرة فقط، ويدعم `input/output` و`input_tokens/output_tokens`، مع وسم
  التقدير ومنع تكرار كائن النتيجة عبر `WeakSet` بلا الاحتفاظ به. تبقى رموز cache مستقلة
  عن input لأن Claude قد يعيد cache أكبر من الإدخال غير المخبّأ. `src/ui/components/chat.js` يعرض الإجمالي في `#costInfo`
  ويصفّره عند جلسة جديدة أو تفريغ الخيط؛ لا ينقل ذلك تجميع Enterprise اليومي/الشهري.
- **سجل نشاط Community المحلي**: `electron/activity.js` يحفظ آخر 200 حدث metadata في
  `~/.satr/activity.json` بكتابة ذرية أفضل جهد وبصمة داخلية للمشروع. لا يدوّن نص الطلب أو
  مدخلات الأدوات أو المخرجات أو المسارات المطلقة أو معرّفات الجلسات/الأذونات. قسم «النشاط
  المحلي» في ⚙ يعرض آخر 20 حدثاً للمشروع الحالي، ومسحه يتطلب تأكيداً صريحاً؛ سجل Enterprise
  الكامل في `satr-enterprise/audit.js` الخاص مستقل.

