# أدلة مهارة الاختبار الحي وتسجيل نافذة سطر

التاريخ: 2026-09-09. الفرع `feat/project-connections`، المصدر `2.16.21` على Windows.
النطاق المعتمد: مهارة مشروع `satr-live-test`، مشغّل نسخة ثانية، ولقطات أصلية من نافذتها للتوثيق والمونتاج لاحقاً. لا إصدار أو commit أو نشر.

**حد هذا الدليل بعد مراجعة الجودة:** التسجيل الموثّق أدناه بمقاس `1180×800` أثبت
مسار الالتقاط والحفظ وفك الإطارات، لكن المالك رفض جودته. تبقى نتائج الحراس القديمة
وأدلتها كما سُجّلت؛ لا تُعد قبولاً بصرياً أو إثباتاً لـFull HD أو وضوح التفاصيل الدقيقة.
تحديث `--recording-hd` وقياسات الدقة والتباين الجديدة تُوثّق مستقلة في
[أدلة جودة التسجيل](RECORDING-QUALITY-EVIDENCE.md)، ولا تُنسب إلى المحاولة القديمة.

## ما نُفّذ

- المهارة ومراجع القيادة/السيناريوهات/التسجيل داخل `.agents/skills/satr-live-test/`. تُكتشف `source:project`، ولم تُضف إلى `BUILTIN_SKILLS` أو قائمة الحزم المنشورة.
- `scripts/live-test.js`: `prepare/launch/status/record-start/record-stop/close`. لكل تجربة هوية عشوائية وملف شخصي ومنزل ومساحة عمل وتنزيلات وأدلة. المصدر وnode_modules والثنائيات مشتركة؛ هذا عزل إعدادات وبيئة وليس OS sandbox.
- `scripts/lib/live-test-client.js`: يربط البيان والحالة بصفحة القشرة المحددة على CDP محلي؛ لا يختار أول هدف. `--debug` في CLI يُترجم إلى `--live-debug` داخلياً لتجنب تعارض Electron.
- `promocapture.startAppWindow` قدرة main فقط: النافذة التي تملك `ownerWebContents` حصراً، بإقرار صريح ومعرف تجربة وسيناريو. تسجيل صامت بمقاس النافذة الأصلي، لا HWND أو sourceId عام عبر IPC.
- التسجيل يستعمل MediaRecorder والتنزيل الإنتاجيين. `scope:run` في مساري انتهاء/إيقاف الدور يبقيه مستمراً؛ الإيقاف الصريح يحفظه. لا يُوجّه أدوات المعاينة نحو قشرة سطر ولا يدمرها.
- فشل الحفظ بالمهلة يفك النافذة المستعارة، حتى لا يعيد تسجيل ويب لاحق تحميل URL داخل نافذة سطر.
- نجاح الحفظ مستقل عن نجاح السيناريو. لا يكفي خروج Electron بصفر؛ المشغّل يطلب أيضاً `evidence/completion.json` بحالة إغلاق ناجحة.

## المعيار المعلن للفحص

يُسجّل سطح سطر والمعاينة الفعلية، يستمر التسجيل بعد IPC إيقاف الدور، ويُحفظ فيديو فعلي قابل لفك الترميز مرتبط بهوية التجربة والسيناريو. تحفظ نافذة سطر وعنوان المعاينة. الفشل: مصدر آخر أو انقطاع التسجيل مع الدور أو ملف غير قابل للفحص أو إغلاق نافذة سطر أو غياب دليل الخاتمة.

الفحص يحمّل `electron/main.js` وواجهة الإنتاج من المصدر. يستخدم صفحة محلية ذات علامة خضراء متحركة معروفة. يُخفى حاجز الدخول بعد انتهاء فحصه لتهيئة سطح التسجيل فقط؛ لا يُحقن `gate-ready` ولا قرار أداة ولا حدث محرك، ولا يدّعي جاهزية محرك حقيقي. مهلة الإقلاع 90 ثانية ومهلة smoke 60 ثانية، دون طلب مدفوع.

## التسجيل الحي النهائي

الأمر:
```powershell
node scripts/live-test.js launch live_faae6af7fc883a27c35db8c4 --record-consent --smoke
```

نُفّذ عبر `run_in_background` في `term_50`، ثم `wait_for_background_task`: رمز الخروج `0` مع `LIVE_TEST_SMOKE PASS` و`LIVE_TEST_EXIT code=0`.

- [الفيديو الأصلي](../dist/live-tests/live_faae6af7fc883a27c35db8c4/home/Downloads/satr-promo-segment-promo_2090d5575c41fc0ce1514fcb-2026-09-09-02-41-26.mp4)
- [الإطار الثاني الذي عُرض بصرياً](../dist/live-tests/live_faae6af7fc883a27c35db8c4/evidence/decoded-frame-1.png)
- [دليل السيناريو](../dist/live-tests/live_faae6af7fc883a27c35db8c4/evidence/scenario-0004.json) · [الخاتمة](../dist/live-tests/live_faae6af7fc883a27c35db8c4/evidence/completion.json)

الملف `543908` بايت، المدة `3841ms`، المقاس `1180×800`، SHA-256:
`9120afde5d73fc9e4123b6d5aa1086a512e8ea522856a499fbfe1336a6a73fe5`.

فُك إطاران عند الثانية 1 و3. بكسلات المعاينة الخضراء: `326652` و`326741`؛ بقية سطح سطر: `617348` و`617259`. عُرض الإطار الثاني فعلياً وأظهر القشرة والمعاينة معاً. هذا فحص إطارين، وليس مراجعة بشرية لكل إطارات الفيديو. `timing_quality=unverified` لأن مسار التطبيق لا يحقن منارة توقيت.

## قيادة خارجية فعلية

`term_48` شغّل:
```powershell
node scripts/live-test.js launch live_bfb875b303561e08207c477f --record-consent --debug
node dist/live-test-development/external-client.cjs live_bfb875b303561e08207c477f
```

السائق استدعى `connectMain` الحقيقي، قرأ `location.href` ووجود الجسر، بدأ التسجيل عبر `command`، استدعى `window.satr.stop()`، تحقق من بقاء `ready/recording`، حفظ المقطع ثم أغلق التطبيق. النتيجة `LIVE_CLIENT_PASS`، وخروج السائق والتطبيق `0` مع خاتمة `closed`. هذا يثبت الوصلة والحفظ؛ لم يُستخدم هذا المقطع لإثبات البكسلات.

[دليل الوصلة](../dist/live-tests/live_bfb875b303561e08207c477f/evidence/external-client.json). المقطع `4677` بايت، SHA-256: `afcf5a89b87ee02806b334733ab8183aaa1bcfecc969d90d32edcaec06ac25c4`.

## الاختبارات الآلية

| الاختبار | النتيجة |
|---|---|
| `npm run test:live-test` | 10 مجموعات عزل + 11 حالة تسجيل + 10 حالات وصلة؛ كلها نجحت، رمز 0 |
| `test:promocapture`, `test:promocapture-batch1`, `test:preview-recording` | نجحت، رمز 0 |
| `promostudio-test.js`, `promostudio-batch1-test.js` | نجحا؛ الثاني 10/10، رمز 0 |
| `promocapture-live-test.js` | stream حقيقي، 30fps، MP4/H.264، 86568 بايت، 81 إطاراً تشخيصياً، رمز 0 |
| `promocapture-events-live-test.js` | 6 حالات و6 أحداث، رمز 0 |
| `promo-studio-live-test.js` | قص/ملاءمة/تكرار/عنوان RTL/مزج وصياغة MP4 بحجم 595984 بايت، رمز 0 |
| `npm run test:skills` | نجح بعد استكمال license/metadata؛ اكتشاف 8 مهارات سطر ومدققها وعقودها، رمز 0 |
| `npm run test:satr-guide` | 26/26، رمز 0 |
| `npm run test:suite-coverage` | 311 فحصاً؛ 132 سكربتاً و34 استبعاداً بسبب معلن؛ لا يتيم، رمز 0 |

اختبارات Electron الثلاثة القائمة شُغّلت بملفاتها الفعلية عبر `node dist/live-test-development/existing-checks.cjs`؛ الغلاف يهيئ منزلاً وملفاً شخصياً وتنزيلات جديدة لكل اختبار قبل `require` لملفه، فلا يعيد استخدام تنزيلات المالك. اختبار `promocapture-live` القديم يحقن إقرار الحفظ؛ إثبات التنزيل الإنتاجي الحقيقي هنا يأتي من smoke الجديد.

فُحص نحو `electron/promocapture.js` و`live-test-launch.js` بـ`node --check`، ووحدة `preview-panel.js` كـES module عبر `node --input-type=module --check`. `git diff --check` بلا أخطاء مسافات؛ التحذيرات عن CRLF في ملفات سابقة لا تعني سقوطاً.

`quick_validate.py` تعذّر بسبب `ModuleNotFoundError: No module named 'yaml'`؛ لم تُضف تبعية للمشروع. اكتشاف المهارة ومدقق سطر الفعلي هما الدليل المتاح، وحارس `test:skills` تحقق منفصل أدناه.

## عرف العضّة — زرع فعلي ثم استعادة دقيقة

المشغّل المحلي `dist/live-test-development/bite.js` يحفظ Buffer الملف الحالي قبل الزرع (ويشمل تعديلات المالك السابقة). يعد الأصل والمتحور قبل/بعد؛ الاستعادة تتحقق أن عكس الزرع يساوي النسخة المحفوظة حرفياً ثم تعيد بايتاتها. لم تُستخدم استعادة Git.

### عزل HOME
```text
زرع: node dist/live-test-development/bite.js plant home
BEFORE original=1 mutant=0
AFTER original=0 mutant=1
حارس: node scripts/live-test-run-test.js
AssertionError [ERR_ASSERTION]: HOME must point to the isolated run home
رمز الخروج: 1
استعادة: node dist/live-test-development/bite.js restore home
RESTORED exact_bytes=true sha256=15b0b66ba97b11312b1a0d1e8ca187724ceae426766f6b304f1ce0895bf0c255
```
الزرع بدّل `HOME: home, USERPROFILE: home,` إلى `HOME: baseEnv.HOME, USERPROFILE: home,`.

### الخاتمة الكاذبة
```text
زرع: node dist/live-test-development/bite.js plant completion
BEFORE original=1 mutant=0
AFTER original=0 mutant=1
حارس: node scripts/live-test-run-test.js
AssertionError [ERR_ASSERTION]: zero exit without completion evidence must fail
0 !== 1
رمز الخروج: 1
استعادة: node dist/live-test-development/bite.js restore completion
RESTORED exact_bytes=true sha256=025c8aa933384c5f0637c94a9d18048959accb9ab1319a303559511bf2b0520b
```
الزرع جعل catch غياب دليل الخاتمة يعيد 0 بدلاً من 1. بصمة الاستعادة سابقة لتحسين علم `--debug` اللاحق.

### استهداف صفحة غير القشرة
```text
زرع: node dist/live-test-development/bite.js plant client
BEFORE original=1 mutant=0
AFTER original=0 mutant=1
حارس: node scripts/live-test-client-test.js
live-test-client: FAIL — Error: ambiguous_target
رمز الخروج: 1
استعادة: node dist/live-test-development/bite.js restore client
RESTORED exact_bytes=true sha256=2a1f6d7c8c872b84350b16b59a65d62824b731aa0aee4a91480069619bb3dc1e
```
الزرع حذف شرط تطابق `item.url === status.mainUrl` من اختيار الصفحة. محاولة نمط أولى رفضها عدّ المتحور لأنه كان جزءاً من الأصل؛ لم تغيّر الإنتاج، وصُحح النمط قبل العضّة المثبتة أعلاه.

### ملكية نافذة التسجيل
```text
زرع: node dist/live-test-development/bite.js plant owner
BEFORE original=1 mutant=0
AFTER original=0 mutant=1
حارس: node scripts/promo-app-window-test.js
promo-app-window: FAIL — AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  {
+   ok: true,
+   session_id: 'promo_7dea13c19c392103d04ff27f'
-   error: 'bad_window',
-   ok: false
  }
رمز الخروج: 1
استعادة: node dist/live-test-development/bite.js restore owner
RESTORED exact_bytes=true sha256=7cbd02dcedd16cff2074bf1698845087a5f6c883bd418d920ded266a93fc9af8
```
الزرع عطّل مقارنة `BrowserWindow.fromWebContents(deps.ownerWebContents) !== window`. بصمة الاستعادة تسبق إصلاح مهلة الحفظ.

### استمرار التسجيل عند إيقاف الدور — عضّة حية
```text
زرع: node dist/live-test-development/bite.js plant scope
BEFORE original=2 mutant=0
AFTER original=0 mutant=2
حارس: node scripts/live-test.js launch live_c466b88f6e9f576f8a229a17 --record-consent --smoke
LIVE_TEST_FAILED production_download_must_complete__not_recording
LIVE_TEST_EXIT code=1
استعادة: node dist/live-test-development/bite.js restore scope
RESTORED exact_bytes=true sha256=91524600ae184abd613e0f5449a2b5aa2ed5b6658b2fa6c8a7c0415805278201
```
الزرع بدّل `scope: 'run'` إلى `scope: 'mutation'` في موضعين داخل main. نُفّذ الحارس عبر `run_in_background` في `term_46`، وأعاد انتظار المهمة رمز 1. مصدر الإيقاف `window.satr.stop()` الإنتاجي داخل النافذة الحقيقية.

### فك النافذة المستعارة بعد مهلة الحفظ
```text
زرع: node dist/live-test-development/bite.js plant timeout
BEFORE original=1 mutant=0
AFTER original=0 mutant=1
حارس: node scripts/promo-app-window-test.js
promo-app-window: FAIL — AssertionError [ERR_ASSERTION]: انتهاء مهلة التنزيل يجب أن يفك نافذة سطر المستعارة
1 !== 0
رمز الخروج: 1
استعادة: node dist/live-test-development/bite.js restore timeout
RESTORED exact_bytes=true sha256=d2d33df15ac3b58fd2dae18137bd483e9724e94fdac508dffffe29d5ed531fdf
```
الزرع حذف `if (!ownsCaptureWindow) closeCaptureWindow();` في مسار `download_timeout` فقط. الحارس يستدعي callback المؤقت الإنتاجي نفسه، ولا ينتظر 15 ثانية أو يغير مدة الإنتاج. ثم يتحقق أن تسجيل الويب التالي يستعمل نافذة جديدة ويحفظ نافذة سطر.

## المحاولات الفاشلة محفوظة

- `term_43` / `live_a0f31da4c9746eaeca2bd860`: فشل انتظار URL؛ العملية آنذاك خرجت بصفر رغم الفشل. أضيف شرط دليل الخاتمة وحارسه وعضّته؛ هذه المحاولة فاشلة ولا تُحسب نجاحاً.
- `term_44` / `live_c50a1667eddde395ee295004`: تنزيل حقيقي لكن تحميل MP4 مباشرة في نافذة decoder أعاد `ERR_FAILED`. استُبدل بصفحة `<video>` اختبارية؛ رمز 1.
- `term_45` / `live_69bbe08967e9e8c397810d17`: نجح فك إطارين والتنزيل قبل تحسينات الخاتمة وCLI؛ لا يحل محل النتيجة النهائية.
- `term_47` / `live_07a708711ba8396221dadcf5`: علم `--debug` اصطدم بعلم Node القديم داخل Electron؛ رمز 1. حُل بترجمة العلم داخلياً.
- `term_49` / `live_1f726883af46820450e5c3a9`: حُفظ فيديو لكن فحص البكسلات فشل برسالة `recording_must_include_the_actual_preview_BrowserView` ورمز 1. كان انتظار URL لا يضمن رسم الصفحة؛ أضيف انتظار `document.readyState` والعلامة وإطارَي رسم مع تقديم النافذة، وحفظ الإطارات قبل الحكم. نجحت المحاولة النهائية بعد هذا التغيير المحدد.
- أول `test:skills` رفض غياب رخصة المهارة. صُححت ترويسة المهارة وفق عرف المشروع، ولم يُضعف الحارس.

## حدود التسليم وحفظ العمل السابق

- التجربة من المصدر، بلا طلب لمحرك مدفوع أو هاتف فعلي أو اختبار حزمة منشورة جديدة. أدلة الجوال السابقة تبقى مستقلة.
- الفيديو الأصلي صامت؛ الموسيقى والتعليق والتخطيط الإعلاني والتصيير أعمال لاحقة حسب طلب المالك. المقاطع في Downloads الخاص بالتجربة، ولا تُرفع تلقائياً.
- المسجل يعيش في قشرة سطر. إعادة تحميل القشرة أو انهيارها قد يفقد المقطع الجاري؛ يُحفظ قبل إعادة التحميل. إعادة تحميل المعاينة سطح مختلف. هذا القيد موثّق بالقراءة، ولم نختبر انهياراً متعمداً هنا.
- فحص صدق المهارة بسياق وكيل مستقل كشف قيد إعادة التحميل؛ وُثّق، ولم تُسمّ هذه المراجعة بالقراءة اختباراً حياً.
- لم يُشغّل `npm run test:full` لهذه الدفعة؛ فحص التغطية لا يثبت نجاح الطقم الكامل، ولا يغيّر وصف التعثر التاريخي 102/103.
- احتُفظ بالشجرة غير الملتزمة وببيئة `connections-acceptance` ونسخة المالك `term_39`. أُغلقت نوافذ التجارب التي أنشأها هذا العمل وحدها، وبقيت أدلتها.
- مقارنة الملفات الثلاثة مع النسخ المحفوظة في `dist/live-test-development/baseline/` أثبتت أن تغيير main لهذه الدفعة استدعاءان فقط لـ`scope:run`، وتغيير preview-panel خاص بفرع تسجيل التطبيق؛ لا تنسب الفروق السابقة لهذه الدفعة.
