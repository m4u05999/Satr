# تجربة أزرار المعاينة على المصدر — 2026-09-10

**حد النسخة:** تصحيح `submitPick` اللاحق لهذه الجولات خارج نطاق النقرات الحية الموثقة هنا؛ سيُختبر بحارس الواجهة UI، ولا يُنسب نجاحه إلى هذه التجربة. دليل حارس الواجهة في [ui/README.md](ui/README.md).

الأرشيف المصاحب يحتوي على 22 ملفاً محدداً من الجولات الثلاث، مع تحقق تطابق SHA-256 مع الأصول عند النسخ: قياسات JSON واللقطة الأصلية للصفحة فقط. [فشل الجولة الأولى](live/1338eb2d/failed-1.json)، [تقدمها](live/1338eb2d/progress-1.json)، [تقدم الجولة النهائية](live/a4b5a72c/continued-progress-2.json)، و[نتيجة التشخيص المستقل](live/281dd6a3/diagnostic.json). بقيت ملفات التحكم والبيئات الشخصية خارج هذا الأرشيف.

**النتيجة:** ثبت حياً أن زر الجهاز يزيل المقاس المفروض من أداة الوكيل، وأن الحجب يحفظ العرض الأصلي عند صفر، وأن التنقل والشبكة والإغلاق وإعادة الفتح تعمل في السيناريوهات أدناه. بقي حد مقيس: بعد فشل تنقل والتعافي منه أصبحت الصفحة مؤقتاً `visibility:hidden` و`frames:0`؛ لم يتقارب `innerWidth` خلال مهلة 8 ثوانٍ رغم تغير حدود العرض. تعافت لاحقاً قبل طلب إعادة التركيز. لا تنسب هذه التجربة السبب إلى التركيز أو `backgroundThrottling`، ولا تثبت تقارب المقاس فورياً في كل حالة.

## البيئة والدليل

- الدليل الأول: [أرشيف الجولة الأولى](live/1338eb2d/)، مهمة `term_10`؛ حُفظ الفشل ثم أُغلقت برمز `0`.
- المصدر النهائي: [أرشيف الجولة النهائية](live/a4b5a72c/)، مهمة `term_11`؛ `pid=24344`، `windowId=1`، `debugPort=61254`، عنوان الصفحة المحلية `http://127.0.0.1:61252`.
- عزل المنزل و`profile` والمشروع؛ لا مصادقة من المالك، ولا أدوار مدفوعة، ولا تسجيل. ليست نسخة محزومة ولا قبولاً بشرياً.
- بدأت الميزانية الأولى نحو `22:53 UTC`، وانتهى إغلاق المصدر النهائي `23:06:24 UTC`، ضمن 20 دقيقة. محاولتان فقط لمسألة مقاس الأداة؛ استمرار فحص الشبكة تم من الحالة القائمة بعد أخطاء المسبار، دون إعادة حالات المقاس الناجحة.
- بصمات [launch.json](live/a4b5a72c/launch.json) للملفات الخمسة طابقت المصدر وقت الإغلاق؛ لا يشمل هذا التطابق تعديلات لاحقة: `electron/main.js` و`electron/preload.js` و`electron/preview.js` و`src/ui/components/preview-panel.js` و`src/ui/lib/preview-shield.js`؛ هذا نطاق البصمة فقط.
- [evidence/completion.json](live/a4b5a72c/completion.json): `kind=shutdown`, `status=closed`, `pid=24344`, `time=2026-09-09T23:06:24.098Z`. خرجت المهمة `term_11` برمز `0`؛ هذا إغلاق نظيف، وليس إعلان نجاح شامل للسيناريو.

## حالات ثبتت من مسارات الإنتاج

الدليل المتسلسل في [continued-failed-2.json](live/a4b5a72c/continued-failed-2.json) يحفظ الحالات السابقة قبل التوقف، و[final-diagnostic.json](live/a4b5a72c/final-diagnostic.json) يحفظ الاستكمال المحدود. بعض السجلات قراءات تشخيصية مكررة؛ لذلك لا نحول عددها إلى عدد اختبارات ناجحة.

| الحالة | القياس الفعلي |
|---|---|
| المقاس المفروض من الأداة | `setViewport(300,400)` أعاد `actual=300×400` في المصدر النهائي، ووافقت حدود العرض والصفحة ذلك |
| نقرة الجهاز بعد المقاس المفروض | `native.width=page.innerWidth=390` ثم `768` ثم `1110` للعرض الكامل، دون إعادة تشغيل |
| ثلاث نقرات سريعة بعد مقاس مفروض | رجعت الصفحة وحدودها إلى `1110` ووضع الجهاز الكامل |
| تصغير اللوحة وتوسيعها بالمقبض الإنتاجي | `279px` عند `Home` ثم `390px` عند `End` مع وضع الهاتف؛ تطابق العرض الأصلي والصفحة |
| فتح الإعدادات أثناء المقاس المفروض | حدود العرض `0×0`؛ تغيير مقاس الأداة إلى `280×360` أثناء الحجب أبقاها `0×0` |
| إغلاق الإعدادات | استعاد العرض والصفحة `280×360`، ثم نقرة الجهاز أزالت هذا المقاس وأعادت `768px` |
| التنقل والرجوع والتقدم | `/one → /two → /one → /two` من أزرار الإنتاج والعنوان الفعلي |
| إعادة التحميل | بقيت `/two` وزاد معرّف تحميل الصفحة `boot` |
| وحدة التحكم ودرج المزيد | تغيرت حالة الفتح والإغلاق من DOM الإنتاجي، وتغير ارتفاع العرض عند وحدة التحكم |
| غير متصل | `navigator.onLine=false` وطلب `fetch` محلي بلا cache فشل بـ`TypeError` |
| فتح أدوات المطوّر | `devtools=true`؛ بقي `debuggerAttached=true` وoffline فعّالاً؛ فتحها لا يفرض detach في هذه البيئة |
| العودة للشبكة بزرها | `navigator.onLine=true`, `fetch=true`, `status=200`, `debuggerAttached=false` |
| إغلاق أدوات المطوّر | عاد `devtools=false` |
| فشل التنقل | `/fail` يفصل استجابة الخادم؛ أظهرت الواجهة خطأ الوصول الفعلي `ERR_EMPTY_RESPONSE` |
| التعافي | أعاد التنقل `/two` وDOM الصفحة، ثم رُصد حد الظهور المؤقت المذكور أدناه |
| النافذة الضيقة بعد التعافي | في الطلب الثاني بعرض نافذة `1000`، تطابق `native.width=page.width=279`، والصفحة `visible` |
| إغلاق المعاينة وإعادة فتحها | صار عدد العروض صفراً، ثم تغير `WebContents` من `2` إلى `4` واستعاد `/two` بعرض `279` و`frames=3` |

## الإخفاقات والحدود المحفوظة

1. المحاولة الأولى توقفت بالنص الحرفي:

   ```text
   AssertionError [ERR_ASSERTION]: override_not_applied
   ```

   أعاد `setViewport.actual` عرضاً قديماً `1110` بينما أصبحت الحدود `300`. كانت الصفحة القديمة باقية عند `22:53:46` ثم ثبتت `300×400` عند `22:54:46`؛ زمن التقارب الدقيق غير محفوظ لأن المسبار يحدّث أحدث حالة. أظهر [frame-diagnostic.json](live/1338eb2d/frame-diagnostic.json) لاحقاً أن نقرة الجهاز نقلت الصفحة `300→390` بحدث `resize` حقيقي خلال نحو `280ms` مع مرور `22` إطاراً في `357ms` و`visibility=visible`. هذه المحاولة تخص بصمتها الأولى. المحاولة النهائية أعادت أداة المقاس جواباً صحيحاً `300×400`.

2. اصطدم المسبار باسم الحقل `error` في نتيجة `fetch` المتوقعة أثناء offline، فطبع:

   ```text
   AssertionError [ERR_ASSERTION]: wrapper_network-probe: TypeError
   ```

   النتيجة الأصلية `{online:false,fetch:false,error:'TypeError'}` هي نجاح محاكاة الانقطاع. صُحّح تمييز نتيجة الصفحة عن فشل خطاف التجربة، وحُفظ [failed-2.json](live/a4b5a72c/failed-2.json) واستُكمل من الحالة نفسها.

3. افترض السيناريو أن فتح DevTools يفصل debugger، ففشل بالنص:

   ```text
   Error: timeout: devtools-open-detaches-debugger
   ```

   قياس [tail-failed-2.json](live/a4b5a72c/tail-failed-2.json) و[devtools-probe-2.json](live/a4b5a72c/devtools-probe-2.json) أثبت بقاء الاتصال. لا تثبت هذه التجربة أثر `debugger.detach()` الخالص دون إيقاف المحاكاة أولاً؛ الذي ثبت هو إيقافها بزر الشبكة ثم فصل الاتصال ونجاح `fetch`.

4. عند تصغير النافذة بعد خطأ التنقل والتعافي، فشل بالنص:

   ```text
   Error: timeout: narrow-window-device
   ```

   في [continued-failed-2.json](live/a4b5a72c/continued-failed-2.json) عند `23:03:45.593Z`: الحدود `279×455`، والصفحة `767×558`، `visibility=hidden`، `frames=0`، مع `window.focused=true` و`document.hasFocus()=true`. في بداية التشخيص اللاحق كانت الصفحة قد تعافت بالفعل قبل طلب إعادة التركيز؛ لا يصح إسناد التعافي لذلك الطلب. الطلب الثاني الضيق وإعادة الفتح موثقان في [final-diagnostic.json](live/a4b5a72c/final-diagnostic.json)، والنتيجة النهائية [native-final.json](live/a4b5a72c/native-final.json) و[native-screenshot.json](live/a4b5a72c/native-screenshot.json): `279×455`, `visible`, `frames=120`.

## اللقطات والأوامر

- `controls-final-diagnostic.png` محفوظة في مجلد التجربة المؤقت ولم تُضم إلى الأرشيف؛ هي لقطة لقشرة النافذة عبر `BrowserWindow.capturePage`؛ ظهر موضع العرض الأصلي أسود، فلا تستخدمها للحكم على محتوى الصفحة.
- [native-page-final.png](live/a4b5a72c/native-page-final.png) لقطة الصفحة الأصلية نفسها عبر CDP بعد التحقق من هوية التجربة وعنوانها المحلي؛ تُظهر `/two` بعرض `279` وارتفاع `455`. لم يُطلب فيديو.

```text
node scripts/preview-controls-live.js prepare
node scripts/preview-controls-live.js launch live_1338eb2d79a14307b4021105
node scripts/preview-controls-live.js verify live_1338eb2d79a14307b4021105 1
node scripts/live-test.js close live_1338eb2d79a14307b4021105
node scripts/preview-controls-live.js prepare
node scripts/preview-controls-live.js launch live_a4b5a72c1e9022c52fdf2619
node scripts/live-test.js status live_a4b5a72c1e9022c52fdf2619
node scripts/preview-controls-live.js verify live_a4b5a72c1e9022c52fdf2619 2
node scripts/preview-controls-live.js verify-tail live_a4b5a72c1e9022c52fdf2619 2
node scripts/preview-controls-live.js verify-after-devtools live_a4b5a72c1e9022c52fdf2619 2
node scripts/live-test.js close live_a4b5a72c1e9022c52fdf2619
```

أوامر `launch` فقط شُغلت عبر `run_in_background` بعد فحص المهام القائمة. الاستكمال التشخيصي المحدود قاد `connectMain` للنافذة المعزولة، وطلبات `window` و`shot` المحصورة في wrapper؛ لم يغيّر منطق الإنتاج أو يحقن مقاس CSS بديل.
## تشخيص مستقل: نافذة ظاهرة وفصل debugger صريح

بعد إغلاق `term_11` طلب القائد سيناريو مستقلاً بحد **3 دقائق بعد الإطلاق**. أُجري في `live_281dd6a3a609a574722711b0` عبر `term_12`، والمسبار القابل لإعادة القراءة `preview-controls/diagnostic.cjs` ودليله [diagnostic.json](live/281dd6a3/diagnostic.json). `alwaysOnTop=true` خاص بالنافذة المعزولة في wrapper؛ لم يتغير المصدر الإنتاجي. لم تفتح DevTools في هذه الجولة.

**النتيجة: لا إخفاقات.** استغرق تنفيذ المسبار نحو `3.8s`. انتظر كل قياس عينة native أحدث من النقرة، وطلب ظهور النافذة وتركيزها وعدم تصغيرها، وظهور الصفحة وإطاراتها، وتطابق عرض الجهاز مع العرض الأصلي و`innerWidth`.

- ست نقرات قبل فشل التنقل بين `23:10:57.517–23:10:58.098Z`: `390→768→1110→390→768→1110`؛ تطابقت الأبعاد في كل مرة، وازدادت الإطارات `11→44`.
- ظهر خطأ `/fail` عند `23:10:58.184Z`، واستعادت `/two` عند `23:10:58.346Z` وهي `visible` و`frames=1`.
- ست نقرات بعد التعافي بين `23:10:58.424–23:10:58.958Z`: السلسلة نفسها `390→768→1110→390→768→1110`، والإطارات `6→39`، بلا عودة للحالة `hidden` في العينات المقبولة.
- جميع قياسات النقر: `BrowserWindow.visible=true`, `focused=true`, `minimized=false`, `alwaysOnTop=true`, و`getBackgroundThrottling()=false`؛ لم يُستخدم مستطيل native وحده لإعلان النجاح.
- **فصل الاتصال الخالص مثبت الآن:** بعد offline عاد `{online:false,fetch:false,error:'TypeError'}`؛ استدعى wrapper `webContents.debugger.detach()` مباشرة، فكان `{before:true,after:false}`؛ ثم عاد `{online:true,fetch:true,status:200}` من طلب محلي جديد بلا cache، عند `23:10:59.285Z`.

هذه الجولة تثبت استمرار زر الجهاز قبل خطأ التنقل وبعده في النافذة الظاهرة المضبوطة. لا تحسم وحدها سبب الحالة العابرة في الجولة السابقة: وجود DevTools وحالة تغطية النافذة كانا مختلفين، ولم نسجل نافذة Windows الأعلى آنذاك. لا يوجد دليل على أن `capturePage` أيقظ الصفحة السابقة؛ لم يستدع المسبار تصويراً أو نقراً أو تركيزاً بين التوقف `23:03:45` وبداية التشخيص `23:05:03`، وكانت قد صارت ظاهرة قبل طلب التركيز.

```text
node scripts/preview-controls-live.js prepare
node scripts/preview-controls-live.js launch live_281dd6a3a609a574722711b0
node scripts/live-test.js status live_281dd6a3a609a574722711b0
node dist/live-tests/live_281dd6a3a609a574722711b0/preview-controls/diagnostic.cjs
node scripts/live-test.js close live_281dd6a3a609a574722711b0
```

أُغلقت النافذة بعد حفظ الدليل، وخرجت `term_12` برمز `0`. لا تبقى نوافذ لهذه التجارب.