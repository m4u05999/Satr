# مصفوفة تجربة المستخدم العربية — مشروع «سطر»

> هذا الملف يُدرج كل شاشة/مكوّن رئيسي في الواجهة، ويحدّد حالته من حيث العربية و `RTL` و `BiDi` وإمكانية الوصول و `CSP` والوضع الفاتح/الداكن والتجاوب.
> المصدر المعياري للقرارات التصميمية هو `docs/ARABIC-UX-GUIDELINES.md`؛ عند التعارض بين الملفين يتقدّم `ARABIC-UX-GUIDELINES.md`.
> **مفتاح التصنيف في الملاحظات:**
> - **[قاعدة]** — قرار تصميم/هندسة مُلزم.
> - **[مؤكد]** — سلوك موجود حرفياً في الكود.
> - **[استثناء]** — قرار مقصود يخرج عن القاعدة العامة.
> - **[يحتاج اختباراً]** — منطقي، لكن لم يُختبر بصرياً.
>
> الأعمدة:
> - **المكوّن/الشاشة**: الاسم التقني + المسار.
> - **RTL/BiDi**: ما إذا كانت الاتجاهات مُعالجة.
> - **الفاتح/الداكن**: هل يستخدم Tokens فقط.
> - **Keyboard**: هل التنقّل بلوحة المفاتيح مدروس.
> - **Responsive**: هل يتأقلم مع العرض الضيق.
> - **CSP**: هل يعتمد `adoptedStyleSheets` أو CSSOM فقط.
> - **الدليل**: الملف والسطر.
> - **الحالة**: ✅ مؤكد | ⚠️ جزئي | ❌ فجوة.
> - **الملاحظات**: تفاصيل أو توصية.

---

## 0. ملاحظات عامة على المعاينة المدمجة

- `WebContentsView` الأصلي في `satr-preview-panel` يطفو فوق DOM العادي (`src/ui/components/preview-panel.js:3-8`).
- [مؤكد] القشرة تدير هذا القيد عبر `surfaceCoordinator.setDialog` باستدعاء `preview.holdForDialog(true/false)` (`src/ui/app.js:390-414`).
- [يحتاج اختباراً] التأكد بصرياً من أن الحوار المركزي لا يختفي خلف المعاينة عند فتحها قبل الحوار على شاشة ضيقة.

---

## 1. الهيكل العام والقشرة

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| جذر الوثيقة | ✅ `dir="rtl"` | ✅ Tokens | ✅ | ✅ | ✅ | `src/index.html:2` | ✅ | الإعداد الافتراضي العربي |
| سياسة CSP | — | — | — | — | ✅ | `src/index.html:5` | ✅ | لا `unsafe-inline`؛ `npm run test:design-guard` يثبت عدم وجود سمات `style=`/`on*=` المخالفة؛ `node scripts/update-csp.js` يزامن CSP ويحسب hashes للكتل المضمّنة الموجودة دون إزالتها |
| القشرة الرئيسية (`app.js`) | ✅ | ✅ | ✅ | ⚠️ | ✅ | `src/ui/app.js` | ✅ | تنسيق Theme + اختصارات + تنسيق إشعارات |
| Design Tokens | ✅ | ✅ | — | — | ✅ | `src/styles/base.css:1-35` | ✅ | لا ألوان صلبة |

---

## 2. الشريط العلوي والإعدادات

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| `satr-topbar` | ✅ | ✅ | ✅ | ⚠️ | ✅ | `src/ui/components/topbar.js` | ✅ | حقول LTR للمسارات والمفاتيح |
| اختيار مجلد المشروع | ✅ LTR | ✅ | ✅ | ⚠️ | ✅ | `src/styles/base.css:185` | ✅ | `#cwd` LTR left |
| منبثق الإعدادات (⚙) | ✅ | ✅ | ✅ (Escape) | ⚠️ | ✅ | `src/ui/components/topbar.js:92-100` | ✅ | يُغلق بالخارجية أو Escape |
| المجلدات الإضافية | ✅ LTR | ✅ | ✅ | ⚠️ | ✅ | `src/ui/components/topbar.js:63-89` | ✅ | `dir="ltr"` للمسار |
| مركز مفاتيح API | ✅ LTR | ✅ | ✅ | ⚠️ | ✅ | `src/ui/components/topbar.js:19-46` | ✅ | إدخال المفتاح LTR |
| قسم Enterprise | ✅ | ✅ | — | ⚠️ | ✅ | `src/ui/components/topbar.js:191-235` | ✅ | يظهر حسب هوية البناء |
| نشاط المحلي | ✅ | ✅ | — | ⚠️ | ✅ | `src/ui/components/topbar.js:147-189` | ✅ | نصوص `unicode-bidi: plaintext` |
| اختصارات سريعة | ✅ | ✅ | — | ⚠️ | ✅ | `src/index.html:44-52` | ✅ | `<kbd dir="ltr">` |
| تغييرات الجلسة | ✅ LTR | ✅ | ✅ | ⚠️ | ✅ | `src/ui/components/topbar.js:120-143` | ✅ | مسار LTR + أرقام LTR |

---

## 3. خيط المحادثة (`satr-chat`)

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| حاوية المحادثة الرئيسية | ✅ | ✅ | ✅ (بحث) | ✅ | ✅ | `src/ui/components/chat.js` | ✅ | Light DOM، أنماط في `base.css` |
| رسائل المستخدم | ✅ | ✅ | — | ✅ | ✅ | `src/ui/components/chat.js` (addUserMsg) | ✅ | اتجاه تلقائي |
| رسائل المساعد (Markdown) | ✅ `unicode-bidi: plaintext` | ✅ | — | ✅ | ✅ | `src/styles/base.css:273-297` | ✅ | عناوين RTL، كود LTR |
| بطاقات الفرق (Diff) | ✅ LTR/RTL | ✅ | — | ✅ | ✅ | `src/ui/lib/diff.js` + `diff.css.js` | ✅ | `rtl-doc` للملفات العربية |
| Task Ledger | ✅ | ✅ | — | ✅ | ✅ | `src/ui/components/chat.js:489-549` | ✅ | عناوين `dir="auto"` |
| Checkpoint | ✅ LTR | ✅ | — | ✅ | ✅ | `src/ui/components/chat.js:623-645` | ✅ | مسارات وتواريخ LTR |
| Verification | ✅ | ✅ | — | ✅ | ✅ | `src/ui/components/chat.js:594-597` | ✅ | خرج LTR، ملخص `dir="auto"` |
| أزرار النسخ/الإعادة | ✅ | ✅ | ✅ | ✅ | ✅ | داخل `chat.js` | ✅ | تظهر بعد اكتمال الدور |
| بحث داخل الخيط | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/chat.js:53` | ✅ | العدد LTR |

---

## 4. المؤلّف (`satr-composer`)

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| حقل الإدخال الرئيسي | ✅ `unicode-bidi: plaintext` | ✅ | ✅ | ✅ | ✅ | `src/styles/base.css:500` | ✅ | Enter يرسل، Shift+Enter سطر |
| قائمة `/` (الأوامر) | ✅ | ✅ | ✅ ▲▼ Enter | ✅ | ✅ | `src/ui/components/composer.js:307-387` | ✅ | أوامر LTR، وصف عربي |
| قائمة `@` (الملفات) | ✅ LTR/RTL | ✅ | ✅ ▲▼ Enter | ✅ | ✅ | `src/ui/components/composer.js:438-455` | ✅ | مسار LTR، اسم ملف LTR |
| شريط المرفقات | ✅ | ✅ | ✅ | ✅ | ✅ | `src/ui/components/composer.js:42-58` | ✅ | صور فقط |
| شريط العمليات الخلفية | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/composer.js:114-163` | ✅ | أمر + مدة LTR |
| شريط الوعي (Awareness) | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/index.html:159-167` | ✅ | model/effort/context LTR |
| اختيار المحرك/النموذج | ✅ | ✅ | ✅ | ✅ | ✅ | `src/index.html:148-155` | ✅ | قيم إنجليزية، نص عربي |

---

## 5. الحوارات

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| `satr-perm-dialog` | ✅ LTR/RTL | ✅ | ✅ (Trap) | ✅ | ✅ | `src/ui/components/perm-dialog.js` | ✅ | اسم الأداة LTR، تفاصيل LTR |
| `satr-question-dialog` | ✅ | ✅ | ✅ (Trap) | ✅ | ✅ | `src/ui/components/question-dialog.js` | ✅ | معاينة LTR |
| `satr-file-viewer` | ✅ LTR/RTL | ✅ | ✅ (Escape/Ctrl+S) | ✅ | ✅ | `src/ui/components/file-viewer.js` | ✅ | تبديل يدوي للاتجاه |
| `satr-verify-config-dialog` | ✅ LTR | ✅ | ✅ (Trap) | ✅ | ✅ | `src/ui/components/verify-config-dialog.js` | ✅ | أمر ومعرّف LTR |
| بوابة أول التشغيل (`satr-gate`) | ✅ | ✅ | ✅ | ✅ | ✅ | `src/ui/components/gate.js` | ✅ | [مؤكد] أوامر التثبيت LTR |
| إشعار التحديث | ✅ | ✅ | — | ✅ | ✅ | `src/ui/lib/update-toast.js` | ✅ | نص عربي |
| `satr-ops-dialog` | ✅ | ✅ | ✅ (Trap) | ✅ | ✅ | `src/ui/components/ops-room.js:461-518` | ✅ | [مؤكد] حوار تأكيد مُدار عبر `surfaceCoordinator.confirm` |
| `satr-promo-studio` | ✅ RTL | ✅ | ✅ | ✅ | ✅ | `src/ui/components/promo-studio.js` | ✅ | [مؤكد] حوار modal RTL؛ مسارات الأصول LTR |

---

## 6. اللوحات الجانبية

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| `satr-sessions-panel` | ✅ | ✅ | ✅ (Escape) | ✅ | ✅ | `src/ui/components/sessions-panel.js` | ✅ | عنوان `unicode-bidi: plaintext` |
| `satr-files-panel` | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/files-panel.js` | ✅ | أسماء ملفات LTR |
| `satr-git-panel` | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/git-panel.js` | ✅ | مسارات LTR |
| `satr-agents-panel` | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/agents-panel.js` | ✅ | اسم الوكيل LTR |
| `satr-skills-panel` | ✅ | ✅ | ✅ | ✅ | ✅ | `src/ui/components/skills-panel.js` | ✅ | اسم المهارة LTR |
| `satr-mcp-panel` | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/mcp-panel.js` | ✅ | اسم الخادم LTR |
| `satr-context-panel` | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/context-panel.js` | ✅ | النسبة والرموز LTR |
| `satr-memory-panel` | ✅ | ✅ | ✅ | ✅ | ✅ | `src/ui/components/memory-panel.js` | ✅ | محتوى `dir="auto"` |
| `satr-research-panel` | ✅ | ✅ | ✅ | ✅ | ✅ | `src/ui/components/research-panel.js` | ✅ | مصادر LTR |
| `satr-ops-room` | ✅ | ✅ | ✅ | ✅ | ✅ | `src/ui/components/ops-room.js` | ✅ | [مؤكد] compact/drawer على الشاشات الضيقة |
| `satr-preview-panel` | ✅ LTR | ✅ | ✅ | ✅ | ✅ | `src/ui/components/preview-panel.js` | ✅ | [مؤكد] WebContentsView يطفو فوق DOM؛ [مؤكد] `surfaceCoordinator` يستدعي `holdForDialog` عند الحوار |
| `satr-terminal-panel` | ✅ BiDi/Grid | ⚠️ | ✅ | ✅ | ✅ | `src/ui/components/terminal-panel.js` | ⚠️ | [استثناء] xterm.js في الوضع الشبكي يستخدم ألواناً ثابتة (`#0d0d0c`/`#eeeeec`/`#D9A441`) في `terminal-panel.js:119`؛ العرض العربي يستخدم Tokens |
| `satr-execution-panel` | ✅ | ✅ | — | ✅ | ✅ | `src/ui/components/execution-panel.js` | ✅ | [مؤكد] إحالة توافقية إلى `satr-ops-room` |

---

## 7. أدوات مشتركة ومكتبات

| المكوّن/الشاشة | RTL/BiDi | فاتح/داكن | Keyboard | Responsive | CSP | الدليل | الحالة | الملاحظات |
|---|---|---|---|---|---|---|---|---|
| `lib/diff.js` | ✅ LTR/RTL | ✅ | — | ✅ | ✅ | `src/ui/lib/diff.js` | ✅ | كشف العربية للفرق |
| `lib/diff.css.js` | ✅ LTR/RTL | ✅ | — | ✅ | ✅ | `src/ui/lib/diff.css.js` | ✅ | `rtl-doc` mirror |
| `lib/card.css.js` | ✅ | ✅ | — | ✅ | ✅ | `src/ui/lib/card.css.js` | ✅ | بطاقات عامة |
| `lib/panel.css.js` | ✅ | ✅ | — | ✅ | ✅ | `src/ui/lib/panel.css.js` | ✅ | هيكل اللوحات |
| `lib/sheet.js` | — | — | — | — | ✅ | `src/ui/lib/sheet.js` | ✅ | مساعد `adoptedStyleSheets` |
| `lib/highlight.js` | ✅ LTR | ✅ | — | ✅ | ✅ | `src/ui/lib/highlight.js` | ✅ | تظليل كود LTR |
| `lib/permission-detail.js` | ✅ LTR | ✅ | — | ✅ | ✅ | `src/ui/lib/permission-detail.js` | ✅ | تفاصيل أذونات LTR |
| `lib/update-toast.js` | ✅ | ✅ | — | ✅ | ✅ | `src/ui/lib/update-toast.js` | ✅ | إشعار تحديث |
| `lib/usage-summary.js` | ✅ LTR | ✅ | — | ✅ | ✅ | `src/ui/lib/usage-summary.js` | ✅ | تكاليف LTR |
| `lib/promo-renderer.js` | ✅ RTL | ✅ | — | ⚠️ | ✅ | `src/ui/lib/promo-renderer.js:94` | ✅ | اتجاه RTL للبرومو |

---

## 8. الفجوات والفرضيات التي تحتاج اختباراً يدوياً

> لا تُسجّل هنا كـ «فجوة مؤكدة» إلا ما هو خلل واضح في الكود. الباقي يُصنَّف «يحتاج اختباراً يدوياً».

### 8.1. يحتاج اختباراً يدوياً

| الفرضية | السبب | الدليل | الإجراء المقترح |
|---|---|---|---|
| التأكد من بقاء أزرار ومنبثقات الشريط العلوي قابلة للوصول بعد الالتفاف | الشريط و`.controls` يستخدمان `flex-wrap` (`src/styles/base.css:143-158`) | `src/styles/base.css:143-158` | اختبار بصري: تقليص العرض والتحقق من عدم القص أو التداخل |
| أوضاع `compact` / `drawer` في `ops-room` | قد تحجب جزءاً من المحتوى عند عرض ضيق | `src/ui/components/ops-room.js:23-45` | اختبار stress على 360px (الحد الأدنى للنافذة 720px في `electron/main.js:207`) |
| الحوار المركزي أمام `WebContentsView` المعاينة | المعالجة موجودة (`holdForDialog`) لكنها تحتاج تأكيداً بصرياً | `src/ui/app.js:390-414` (استدعاء `holdForDialog`), `src/ui/components/preview-panel.js:975-987` (التنفيذ), `src/ui/components/preview-panel.js:317` (`holdReasons`) | فتح المعاينة ثم إطلاق حوار إذن على شاشة ضيقة |

### 8.2. استثناءات حالية مُعلَنة

| الاستثناء | السبب | الدليل |
|---|---|---|
| ألوان xterm.js ثابتة في الوضع الشبكي | xterm.js لا يقرأ `Design Tokens` | `src/ui/components/terminal-panel.js:119` |
| `satr-topbar` Light DOM بدون Shadow | قرار تفكيك محدّد؛ الأنماط في `base.css` | `src/ui/components/topbar.js:4` |

---

## 9. معايير القبول القابلة للاختبار

### 9.1. الوضع الفاتح/الداكن

- [ ] التبديل بين الوضعين يحدّث `document.documentElement.dataset.theme` إلى `light` أو `dark`.
- [ ] لا توجد كتابة بيضاء على خلفية بيضاء في الوضع الفاتح.
- [ ] بطاقات الفرق والكود تظهر بخلفية `var(--bg)` وليست شفافة.
- [ ] ألوان التحذير والنجاح تبقى مميزة في الوضعين.

### 9.2. لوحة المفاتيح

- [ ] `Ctrl+Alt+N` يبدأ جلسة جديدة (إن لم يكن هناك دور جارٍ).
- [ ] `Ctrl+Alt+S` يوقف الدور الجاري فقط عند `busy === true`.
- [ ] `Ctrl+Alt+I` ينقل التركيز إلى حقل الإدخال.
- [ ] `Escape` يغلق اللوحة النشطة أو يمسح حقل البحث أولاً.
- [ ] في الحوارات الحاجبة، `Tab` لا يخرج من الصندوق.

### 9.3. التجاوب

- [ ] عند عرض 720px (الحد الأدنى للنافذة في `electron/main.js:207`) لا يخرج أي نص أفقياً عن حدود النافذة.
- [ ] اللوحات الجانبية تبقى قابلة للإغلاق أو تدخل وضع drawer/mode مناسب.
- [ ] `ops-room` يدخل وضع `drawer` عند `(max-width: 44rem)`.
- [ ] (اختياري — stress test) عند عرض 360px تبقى المكوّنات الرئيسية قابلة للوصول دون قص حرج؛ هذا العرض أضيق من الحد الأدنى للنافذة الحالي.

### 9.4. CSP

- [ ] `npm run test:design-guard` يجتاز دون سمات `style=`/`on*=` مخالفة في مصدر `src/index.html`، ودون انتهاكات Tokens / `z-index` / المسافات الرقمية في `src/ui`.
- [ ] `node scripts/update-csp.js` يحافظ على وسم CSP متزامناً ويحسب `SHA-256` لأي كتل `<style>`/`<script>` المضمّنة الموجودة (لا يُستخدم بديلاً عن `test:design-guard` ولا يثبت غياب الكتل).
- [ ] لا توجد سمات `style=` أو `onclick=` في مصدر `src/index.html`.
- [ ] لا توجد وسوم `<style>`/`<script>` بدون `src` في مصدر `src/index.html` (تم التحقق منه بفحص مصدر مستقل في هذه الدورة؛ غير محروس آلياً حالياً).
- [ ] جميع مكوّنات Shadow DOM تستخدم `adoptedStyleSheets`.
- [ ] سمات `style=` المنشأة ديناميكياً بـ CSSOM فقط (مثل `element.style.paddingInlineStart`) تُعتبر مسموحة.

### 9.5. RTL/BiDi

- [ ] نص عربي بحت يبدأ من اليمين.
- [ ] نص مختلط (عربي + لاتيني) يحافظ على ترتيب الكلمات المنطقي.
- [ ] مسار ملف يُعرض من اليسار لليمين دون انعكاس.
- [ ] كود في Markdown يُعرض LTR.
- [ ] الطرفية في الوضع العربي تعرض السطر العربي من اليمين.

---

## 10. المنهجية المتبعة في هذا الملف

1. تم فحص `AGENTS.md` و `CLAUDE.md` لفهم القواعد الملزمة.
2. تم البحث في `src/` عن كل تكرارات `dir=` و `unicode-bidi` و `direction:` و `text-align:`.
3. تمت قراءة كل مكوّن Web Component رئيسي في `src/ui/components/`.
4. تم فصل السلوك المؤكد (موجود في الكود) عن التوصيات (اقتراحات مستقبلية).
5. لم تُخترع أي ميزة أو زر غير موجود في الكود.
6. لم يُعدّل أي كود تنفيذي.

---

## 11. ما لم يُختبر

- التشغيل الفعلي على جهاز ويندوز (بيئة التطوير الأساسية).
- قراءة الشاشة بقارئ شاشة عربي (NVDA/JAWS بالعربية).
- اختبار RTL في شاشات عريضة جداً (> 2560px).
- سلوك `WebContentsView` المعاينة عند ظهور حوار إذن.
- أداء إسقاط BiDi في الطرفية مع scrollback كامل (5000 سطر).
