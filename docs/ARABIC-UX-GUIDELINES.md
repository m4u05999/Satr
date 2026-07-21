# دليل تجربة المستخدم العربية في «سطر»

> هذا الملف يُجمّع القواعد العملية لبناء واجهة عربية صحيحة في مشروع «سطر» (Satr).
> الهدف: توحيد قرارات `RTL` / `BiDi` / النص المختلط / الأرقام / المسارات / الكود بحيث يبقى الكود الإنجليزي والشرح بالعربية، ولا تُعاد اشتقاق القرارات في كل مكوّن جديد.
> النطاق: واجهة Electron المبنية على `src/index.html` و `src/ui/` و `src/styles/base.css`.

## 1. المبادئ العليا

> **مفتاح التصنيف في هذا الملف:**
> - **قاعدة ملزمة** — قرار تصميم/هندسة مُلزم في `AGENTS.md` أو `CLAUDE.md`.
> - **سلوك مؤكد من الكود** — موجود حرفياً في الملف والسطر المذكورين.
> - **استثناء حالي** — قرار مقصود يخرج عن القاعدة العامة وموثّق في الكود.
> - **فرضية تحتاج اختباراً يدوياً** — منطقياً صحيحة، لكن لم تُختبر بصرياً في هذه الدورة.

1. **العربية أولاً** (قاعدة ملزمة): كل نص واجهة بالعربية، والتخطيط RTL بشكل افتراضي (`<html lang="ar" dir="rtl">`).
2. **الكود/المسارات/الأرقام LTR دائماً** (قاعدة ملزمة): أي محتوى تقني يُعرض من اليسار لليمين ولا يخضع لمرآة RTL.
3. **BiDi تلقائي للنص المختلط** (قاعدة ملزمة): النصوص التي تجمع العربية واللاتينية تستخدم `unicode-bidi: plaintext` أو `dir="auto"` حسب السياق.
4. **لا ألوان صلبة** (قاعدة ملزمة): كل لون عبر `Design Tokens` في `src/styles/base.css`؛ لا تُدخل لوناً جديداً.
5. **CSP صارم** (قاعدة ملزمة): لا `<style>`/`<script>` مضمّن ولا سمات `style=`/`onclick=` في مصدر `src/index.html`. الأنماط عبر `adoptedStyleSheets` في Shadow DOM أو `src/styles/base.css` في Light DOM. سمات `style=` المنشأة بـ CSSOM أثناء التشغيل مسموحة.
   - `npm run test:design-guard` يتحقّق آلياً من: سمات `style=` / `on*=` في `src/index.html`؛ وحراس Tokens والألوان الصلبة و`z-index` الرقمية والمسافات الرقمية.
   - `node scripts/update-csp.js` يزامن وسم CSP ويحسب `SHA-256` لأي كتل `<style>`/`<script>` المضمّنة الموجودة؛ لا يثبت غيابها ولا يزيلها.
   - غياب وسوم `<style>`/`<script>` بدون `src` في `src/index.html` تم التحقق منه بفحص مصدر مستقل في هذه الدورة، وهو غير محروس آلياً حالياً في `test:design-guard`.
6. **اختبار على ويندوز ذهنياً** (قاعدة ملزمة): المسارات تستخدم `\`، والترميز UTF-8، والاختصارات تتطلّب `Ctrl+Alt`.

## 2. RTL والتخطيط

### 2.1. الجذر

- الملف `src/index.html:2` يضبط:
  ```html
  <html lang="ar" dir="rtl">
  ```
- هذا يجعل Flexbox و Grid و `margin-inline-*` و `padding-inline-*` تعمل بالمنطق RTL تلقائياً.

### 2.2. متى نستخدم `dir="rtl"`؟

- الحاويات التي تحتوي نصاً عربياً بحتاً ولا تتوقع محتوى لاتيني طويل.
- أمثلة من الكود:
  - `src/ui/components/mcp-panel.js:82` — تلميح خالٍ من MCP يضبط `dir="rtl"`.
  - `src/ui/components/skills-panel.js:74` — رسالة الإرشاد الفارغة.

### 2.3. متى نستخدم `dir="ltr"`؟

- المسارات والملفات: `src/styles/base.css:185` `#cwd`، `src/ui/components/files-panel.js:14` `.ft-name`.
- الأوامر والكود: `src/ui/components/perm-dialog.js:25` `.tool-name`.
- الاختصارات: `src/index.html:47` `<kbd dir="ltr">`.
- الأرقام التقنية: `src/ui/components/context-panel.js:12` `.ctx-pct`.
- أسماء النماذج والمحركات: `src/index.html:160` `#awarenessModel`.

### 2.4. متى نستخدم `dir="auto"`؟

- النص المختلط الذي يأتي من النموذج أو المستخدم ولا نعرف لغته مسبقاً.
- أمثلة:
  - `src/ui/components/chat.js:775` — فقرة Markdown من المساعد.
  - `src/ui/components/files-panel.js:153` — مقتطف نتيجة بحث المحتوى.
  - `src/ui/components/memory-panel.js:161` — محتوى ذاكرة مشروع.
  - `src/ui/components/terminal-panel.js:534` — كل سطر في عرض BiDi للطرفية.

## 3. BiDi والنص المختلط

### 3.1. `unicode-bidi: plaintext`

يُستخدم عندما يحتوي العنصر على أسطر متعددة قد تختلف اتجاهاتها:

- `src/styles/base.css:273` — `.md` (محتوى Markdown).
- `src/styles/base.css:500` — حقل إدخال المؤلّف (`#input`).
- `src/ui/components/ops-room.js:211` — `.summary`.
- `src/ui/components/question-dialog.js:40` — وصف الخيار.

### 3.2. `unicode-bidi: isolate`

يُستخدم للعناصر الداخلية التي يجب ألا تؤثر على اتجاه المحيط:

- `src/styles/base.css:282` — عناوين Markdown وخلايا الجدول.
- `src/ui/lib/card.css.js:29` — الكود داخل بطاقة.

### 3.3. `unicode-bidi: embed`

يُستخدم عندما نريد فرض اتجاه LTR على عنصر داخل سياق RTL:

- `src/styles/base.css:296` — `.md code`.
- `src/ui/components/files-panel.js:14` — اسم الملف.
- `src/ui/components/git-panel.js:19` — مسار التغيير.

## 4. الأرقام والتواريخ والعملات

### 4.1. تنسيق الأرقام

- الأرقام التقنية (تكلفة، tokens، نسبة سياق) تُعرض بفواصل إنجليزية عبر `toLocaleString('en-US')`.
  - مثال: `src/ui/components/context-panel.js:27` `fmtTok`.
- الأرقام الزمنية في خيط المحادثة تُعرض بأرقام غربية LTR عبر `toLocaleTimeString('en-GB')`.
  - مثال: `src/ui/components/topbar.js:169` وقت النشاط.

### 4.2. التواريخ

- التواريخ الطويلة تُعرض بالعربية عبر `toLocaleString('ar-SA')`.
  - مثال: `src/ui/components/memory-panel.js:164`.
- التواريخ القصيرة (وقت) تُعرض LTR.
  - مثال: `src/ui/components/topbar.js:169`.

### 4.3. العملات

- تُعرض بالدولار مع الرمز `$` في بداية القيمة (`direction: ltr`).
  - مثال: `src/ui/components/research-panel.js:79`.

## 5. المسارات والملفات

### 5.1. قواعد عرض المسار

- المسارات تُعرض دائماً `direction: ltr` و `text-align: left`.
- يُفضّل `unicode-bidi: embed` لمنع تأثير المحيط.
- تُقصّ المسارات الطويلة بـ `text-overflow: ellipsis`.

### 5.2. أمثلة مؤكدة

| المكوّن | المسار | السطر | القرار |
|---|---|---|---|
| `topbar` | `src/styles/base.css` | 185 | `#cwd` LTR |
| `files-panel` | `src/ui/components/files-panel.js` | 14 | `.ft-name` LTR embed |
| `git-panel` | `src/ui/components/git-panel.js` | 19 | `.gd-name` LTR left |
| `file-viewer` | `src/ui/components/file-viewer.js` | 23 | `.viewer-name` LTR left |
| `diff` | `src/ui/lib/diff.css.js` | 15 | `.diff-file` LTR |

## 6. الكود والتظليل

### 6.1. عرض الكود

- الكود يُعرض دائماً LTR.
- `pre` و `code` تستخدم `direction: ltr` و `text-align: left`.
- التظليل يستخدم ألوان `Design Tokens` (مثال: `src/ui/components/file-viewer.js:42-45`).

### 6.2. ملفات عربية في العارض

- عارض الملفات يكتشف نسبة الحروف العربية إلى اللاتينية.
  - `src/ui/components/file-viewer.js:242-243`: إذا كانت العربية ≥ 50% من اللاتينية، يُعرض RTL.
- ملفات الكود (بناءً على الامتداد في `HL_CFG`) تُعرض LTR دائماً.
  - `src/ui/components/file-viewer.js:238`.
- المستخدم يستطيع تبديل الاتجاه يدوياً: تلقائي / RTL / LTR.
  - `src/ui/components/file-viewer.js:101`.

### 6.3. بطاقات الفرق (Diff)

- الفرق يُعرض LTR افتراضياً مع أرقام أسطر على اليسار.
- إذا كان الملف عربياً (`rtl-doc`)، تُعكس الأرقام إلى اليمين والنص يرسو يميناً.
  - `src/ui/lib/diff.css.js:37-38`.
  - `src/ui/lib/diff.js:22`.

## 7. الحقول والمدخلات

### 7.1. حقول النص العربي

- تستخدم `unicode-bidi: plaintext` أو `dir="auto"`.
- `src/styles/base.css:500` — `#input`.
- `src/ui/components/research-panel.js:13` — سؤال البحث.

### 7.2. حقول النص التقني

- تستخدم `direction: ltr; text-align: left; font-family: var(--mono)`.
- أمثلة: `#cwd`، مفتاح API، مسار الذاكرة، معرّف الأمر.

### 7.3. قوائم الاختيار

- النصوص العربية في `option` يجب أن تبقى RTL طبيعياً.
- المحركات والنماذج: القيم الداخلية إنجليزية، النصوص الظاهرة عربية.

## 8. الحوارات والمنبثقات

### 8.1. مربع الأذونات

- يظهر في وسط الشاشة فوق كل شيء (`z-index: var(--z-modal)`).
- اسم الأداة LTR، تفاصيل الأداة LTR مع `unicode-bidi: plaintext`.
- أزرار الإجراءات عربية RTL.
- `src/ui/components/perm-dialog.js:24-35`.

### 8.2. أسئلة الاختيار

- النصوص عربية، الخيارات عربية، المعاينة (preview) LTR.
- `src/ui/components/question-dialog.js`.

### 8.3. التنبيهات والإشعارات

- النص عربي، الرموز التعبيرية في البداية.
- `src/ui/lib/update-toast.js`.
- `src/ui/app.js` `addNotice`.

### 8.4. المعاينة المدمجة أمام الحوارات

- `WebContentsView` الأصلي في `satr-preview-panel` يطفو فوق DOM العادي (`src/ui/components/preview-panel.js:3-8`).
- (سلوك مؤكد) القشرة تدير هذا القيد عبر `surfaceCoordinator.setDialog`:
  - عند فتح أي حوار (`permission-dialog`, `question-dialog`, `ops-dialog`, `verify-config-dialog`, `promo-studio`) تُستدعى `preview.holdForDialog(true)`.
  - عند إغلاق الحوار تُستدعى `preview.holdForDialog(false)`.
  - `src/ui/app.js:390-414`.
- (سلوك مؤكد) التنفيذ الفعلي للحجب موجود في `preview-panel.js:975-987` (`setHeld` → `previewBounds(0,0,0,0)`).
- (قاعدة ملزمة) أي حوار modal جديد مستقبلاً يجب أن يمر عبر `surfaceCoordinator.setDialog` حتى يُستدعى `preview.holdForDialog(true/false)`؛ لا تستدعِ `holdForDialog` مباشرة من مكوّن الحوار.
- (فرضية تحتاج اختباراً يدوياً) التأكد بصرياً من أن الحوار المركزي لا يختفي خلف المعاينة عند فتحها قبل الحوار على شاشة ضيقة.

## 9. الوضع الفاتح/الداكن

### 9.1. الآلية

- القيمة تُحفظ في `localStorage` تحت `satr_theme`.
- الوضع الافتراضي داكن دائماً (قرار المالك).
- `src/ui/app.js:18-37`.

### 9.2. الألوان

- جميع الألوان عبر متغيّرات CSS في `:root`.
- لا تستخدم قيماً صلبة مثل `#fff` أو `#000`.
- `src/styles/base.css:1-35`.

### 9.3. معيار قبول قابل للاختبار

- بعد التبديل إلى الوضع الفاتح:
  - `document.documentElement.dataset.theme` يساوي `light`.
  - نص المحادثة مقروء (تباين ≥ 4.5:1).
  - بطاقات الفرق والكود تظهر بخلفية `var(--bg)` وليس شفافة.
  - لا تظهر أي كتابة بيضاء على خلفية بيضاء.

## 10. لوحة المفاتيح

### 10.1. الاختصارات العالمية

- `Ctrl+Alt+N`: جلسة جديدة.
- `Ctrl+Alt+S`: إيقاف الدور الجاري (فعّل فقط أثناء `busy`).
- `Ctrl+Alt+I`: تركيز المحرّر.
- `Ctrl+Alt+T`: طيّ/فرد الطرفية.
- `Ctrl+Alt+P`: طيّ/فرد المعاينة.
- `src/index.html:47-51` و `src/ui/app.js:1565-1578`.

### 10.2. التنقّل داخل القوائم

- قائمة `/` و `@`: الأسهم ▲▼ للتنقل، Enter/Tab للاختيار، Escape للإغلاق.
- `src/ui/components/composer.js:540-557`.

### 10.3. التركيز والفخ

- الحوارات الحاجبة (`aria-modal="true"`) تفخ التركيز داخلها.
- أمثلة: `perm-dialog.js:94`، `question-dialog.js:107`، `verify-config-dialog.js:258`.

### 10.4. معايير قبول قابلة للاختبار

- عند فتح حوار إذن، يكون التركيز على زر «موافقة».
- الضغط على `Tab` داخل الحوار لا يخرج إلى الخلفية.
- `Escape` يغلق اللوحة أو يمسح حقل البحث أولاً.

## 11. التجاوب (Responsive)

### 11.1. العرض الافتراضي

- التخطيط عمودي: شريط علوي → صف أوسط (دردشة + لوحات) → طرفية.
- اللوحات الجانبية تفتح فوق المحتوى أو بجانبه حسب المساحة.

### 11.2. نقاط التوقف

- `src/ui/components/ops-room.js:227` — `@media (max-width: 44rem)`.
- `src/ui/components/verify-config-dialog.js:55` — `@media (max-width: 42rem)`.
- `src/ui/components/preview-panel.js` — (سلوك مؤكد) تتجاوب عبر `ResizeObserver` ومحاكاة الأجهزة، لا توجد نقطة توقف تُحوّلها إلى drawer.

### 11.3. معايير قبول قابلة للاختبار

- المعيار الفعلي للنافذة يبدأ من عرض 720px (`electron/main.js:207` هو الحد الأدنى للنافذة).
- عند عرض 720px: لا يخرج أي نص عن حدود النافذة الأفقية، وأزرار الشريط العلوي تبقى قابلة للوصول.
- (اختياري — stress test) عند عرض 360px: التحقق من عدم وجود قص حرج للمكوّنات الرئيسية؛ هذا العرض أضيق من الحد الأدنى المدعوم حالياً للنافذة.
- الحوارات لا تتجاوز 96vw.

## 12. الطرفية المدمجة

### 12.1. وضعان للعرض

- **العرض العربي (BiDi)**: يُحلّل خرج xterm.js ويرسم أسطراً HTML بـ `dir="auto"`.
- **العرض الشبكي**: xterm.js الأصلي للتطبيقات التفاعلية.
- `src/ui/components/terminal-panel.js:422-575`.
- (استثناء حالي) إعدادات xterm.js في الشبكي تستخدم ألواناً ثابتة (`background: '#0d0d0c'`, `foreground: '#eeeeec'`, `cursor: '#D9A441'`) في `src/ui/components/terminal-panel.js:119`؛ العرض العربي يستخدم `Design Tokens`.

### 12.2. التبديل التلقائي

- إذا أُطلق أمر معروف بعكس العربية بصرياً (مثل `claude`)، يُبدّل للعرض الشبكي مع تنبيه.
- `src/ui/components/terminal-panel.js:599-601`.

### 12.3. معايير قبول قابلة للاختبار

- نص عربي في الطرفية يظهر من اليمين لليسار في الوضع العربي.
- نص مختلط (أمر لاتيني + مسار عربي) لا ينعكس ترتيب الحروف.
- تبديل الوضع لا يفقد محتوى الشاشة.

## 13. CSP ومراعاة الأمان

### 13.1. السياسة

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'; font-src 'self' data:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'">
```

- `src/index.html:5`.

### 13.2. ما هو ممنوع في مصدر `src/index.html`

- `<style>` مضمّن.
- `<script>` مضمّن.
- سمات `style=` أو `onclick=` في مصدر HTML.
- `<style>` داخل Shadow DOM.

### 13.3. ما هو مسموح

- `adoptedStyleSheets` في Shadow DOM.
- CSSOM (`element.style.paddingInlineStart = ...`) — ينشئ سمات `style=` في DOM أثناء التشغيل بصورة مشروعة.
- `addEventListener`.

### 13.4. معيار قبول قابل للاختبار

- يثبت فحص المصدر المستقل في هذه الدورة عدم وجود `<style>` أو `<script>` بدون `src` في `src/index.html`؛ أما `node scripts/update-csp.js` فيزامن CSP ويحسب الهاشات فقط ولا يثبت غياب هذه الكتل.
- لا توجد سمات `style=` أو `onclick=` في مصدر `src/index.html`.

## 14. التوصيات (ليست ملزمة حالياً)

هذه القائمة تُفيد عند إضافة مكوّنات جديدة أو مراجعة UX؛ لا تُعدّل الكود الحالي دون حاجة.

1. **اختصارات لوحة المفاتيح المزيدة**: مراجعة ما إذا كان يجب إضافة `Ctrl+Shift+/` لفتح لوحة المهارات.
2. **إعلامات الشاشة القارئة**: إضافة `aria-live="polite"` للإشعارات العابرة حالياً إذا كانت غير موجودة.
3. **تنسيق الأرقام العربية**: النظر في دعم `toLocaleString('ar-SA')` للأرقام غير التقنية (مثل عدد الرسائل) حسب رغبة المستخدم.
4. **اختبار RTL في الشاشات العريضة جداً**: التأكد من أن المرآة لا تُبعد الأزرار عن مجال الرؤية.
5. **توحيد `text-align: start` بدلاً من `right/left`**: حيثما أمكن لدعم الاتجاهين تلقائياً.

## 15. قائمة المراجع السريعة

- جذر RTL: `src/index.html:2`
- Tokens: `src/styles/base.css:1-35`
- Theme: `src/ui/app.js:18-37`
- Keyboard shortcuts: `src/ui/app.js:1565-1578`
- Composer input: `src/styles/base.css:500`
- Chat markdown: `src/styles/base.css:273-297`
- File viewer direction: `src/ui/components/file-viewer.js:101, 238-243`
- Terminal BiDi: `src/ui/components/terminal-panel.js:422-575`
- Diff RTL doc: `src/ui/lib/diff.css.js:37-38`
- CSP: `src/index.html:5`
