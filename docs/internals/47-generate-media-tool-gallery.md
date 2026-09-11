### أداة توليد الوسائط وقنوات المعرض — الجولة 8

- `generate_media {kind,prompt,model?,count?,refs?,budget_usd?}` متاحة في SDK وCodex/Kimi MCP
  والمحوّلات. تصنيفها `exec` مع `neverAlways`: لا موافقة دائمة ولا موافقة دور، ولا يعفيها
  إلا `bypassPermissions`. قبل التنفيذ تستدعي `genmedia.estimate` وتعرض النوع والمزوّد
  والنموذج والعدد والكلفة التقديرية وتراكمي الجلسة؛ ثم تفوّض صندوقاً أسود إلى
  `genmedia.generate` وتعيد نصاً عربياً منقّى بالمسارات النسبية والكلفة وسقوط المزوّد.
- `electron/tools.js` يوحّد تحضير الطلب والتقدير والصياغة بين الأسطح. تحميل
  `electron/genmedia.js` محروس بوجود الملف، وغيابه يعيد «ميزة التوليد لم تكتمل بعد» بلا
  كسر الإقلاع. خرج الأداة لا يمرّر كائن المزوّد الخام ولا حقول المفاتيح.
- IPC القراءة فقط: `satr:generationsList` يعيد أحدث 200 سطر v1 منقّى، و`satr:genThumb`
  يقبل صورة تحت `generations/` حصراً حتى `3MiB` مع رفض traversal/symlink، و
  `satr:genProviders` يعيد `{keyName,label,set}` بلا قيم. `FAL_KEY` مضاف إلى قائمة سماح
  مركز المفاتيح، وقيم المفاتيح لا تعبر أي رد.
- `scripts/codexmcp-test.js` يحقن `genmedia` مزيّفاً لإثبات التصنيف وحقول الإذن والكلفة
  التراكمية والرفض والتدهور وعدم تسريب حقل سري. الوصلة الحية ومسابر المزوّدين تنتظر دمج
  نواة أوبس `electron/genmedia.js` و`scripts/genmedia-test.js`.

