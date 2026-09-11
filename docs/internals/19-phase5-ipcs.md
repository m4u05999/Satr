### IPCs المرحلة 5 (قراءة/كتابة، مُنقّاة في main.js)

`satr:providers` (قائمة المزوّدين للقائمة الديناميكية) · `satr:features` (لقطة القدرات) ·
`satr:keysList`/`keySet`/`keyDelete` (مركز المفاتيح) · `satr:appVersion` (رقم إصدار
التطبيق لسطر «إصدار سطر» أسفل ⚙، وعلم `packaged` من `app.isPackaged` يتحكم في شارة
«نسخة تطوير» بالشريط العلوي — قراءة بلا مدخلات، تعبئة كسولة مرة واحدة).
preload يكشفها كلها. القائمة «المحرك»
في index.html تُبنى من `satr:providers` (sdk خاص أولاً + المحوّلات)، والاختيار يُحفظ في
localStorage (`satr_engine`)؛ فشل الجلب ⇒ الخيارات الثابتة احتياطياً.

