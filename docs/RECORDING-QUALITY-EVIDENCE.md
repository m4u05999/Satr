# أدلة تحسين جودة تسجيل نافذة سطر — 2026-09-09

النطاق: شكوى المالك من تشويش عينة التسجيل السابقة ذات الأربع ثوانٍ.
الفرع `feat/project-connections`، الإصدار `2.16.21`. المصدر والشجرة يحتويان عمل المالك
السابق؛ لا التزام أو إصدار أو نشر أو استعادة عامة. الدليل يخص تشغيل المصدر داخل Electron،
ولا يثبت حزمة منشورة أو محركاً مدفوعاً أو قبولاً بشرياً للتصميم.

## خط الأساس والقياس

العينة السابقة في `dist/live-tests/live_faae6af7fc883a27c35db8c4/home/Downloads/`:
`satr-promo-segment-promo_2090d5575c41fc0ce1514fcb-2026-09-09-02-41-26.mp4`.
فحصها بـ`ffprobe` أثبت H.264 Constrained Baseline، أبعاد `1180×800`،
مدة فعلية `3.5192s`، معدل فيديو `1232896bps`، وحجم `543908 bytes`.
لقطة القشرة `1164×761`؛ كان الطلب مبنياً على `getBounds()` المنطقي، مع
فرض العرض والارتفاع على الالتقاط. نجاح المسار سابقاً لم يثبت وضوح النص.

المسباران `term_51/52` سجّلا قيود المسار وأبعاده الفعلية:
شاشة `1920×1080`، منطقة عمل `1920×1040`، `scaleFactor=1`.
طلب سقف `8192×8192` أعطى تلك الأبعاد فعلاً؛ رُفض كحل.
طلب `resizeMode:none` وحده أعاد `1920×1080` حتى مع نافذة صغيرة:
لا يثبت هذا أن المحتوى نفسه صار بأبعاد أصلية. ظهر التكبير فعلاً في تجربة
`live_4df674ffe5a4aa2eee3f5cad`، واحتُفظ بها وبفشل `smoke_timeout`
عند تحميل صفحة فك الفيديو. فُك ملفها بـ`ffmpeg` للتشخيص؛ ليست نتيجة PASS.

## عينة Full HD المقيسة قبل استكمال قياس أول إطار

الأمر الفعلي في `term_55`، بعد استعادة جميع الأعطال المزروعة:

```powershell
node scripts/live-test.js launch live_823d4296b36c4106e65567de --record-consent --recording-hd --smoke
```

النتيجة `LIVE_TEST_SMOKE PASS` و`LIVE_TEST_EXIT code=0`.
النافذة والقشرة والمقطع جميعها `1920×1080` على الشاشة الحالية.
[المقطع الأصلي](../dist/live-tests/live_823d4296b36c4106e65567de/home/Downloads/satr-promo-segment-promo_5b6a5f4b6f3db1b22f30de73-2026-09-09-03-13-31.mp4)
و[إطار مفكوك](../dist/live-tests/live_823d4296b36c4106e65567de/evidence/decoded-frame-0.png).

- H.264 High، `yuv420p`، نسبة البكسل `1:1`.
- مدة الملف `3.5333s`؛ ساعة التطبيق `3852ms` لا يُخلط القياسان.
- الحجم `390016 bytes`، معدل الفيديو الفعلي `879470bps`، متوسط الإطارات
  `820000/35333 ≈ 23.21fps`. لا ندّعي ثبات `30fps` من إعداد مطلوب.
- SHA-256: `04bdb63d5ed43c6807b53b76e3c1c8354e92353e13cdfe83ab37cd792ca3d443`.
- فك إطارين عند الثانية 1 و3: تباين خطوط سوداء/بيضاء بعرض بكسل فعلي واحد
  `254.5/255` و`255/255`؛ معيار الفشل المكتوب قبل التنفيذ أقل من `180`.
- مقارنة لقطة المصدر بإطار الفيديو عند الحجم نفسه، منطقة النص العربية
  `crop=800:520:1080:100`: `SSIM Y=0.999794` و`All=0.969865`.
  هذا قياس محدود للمنطقة والإطار؛ ليس نسبة جودة عامة ولا تطابق ألوان تاماً.

استُعمل `ffmpeg/ffprobe` المثبّتان على جهاز المالك للتشخيص فقط؛ لا اعتمادية جديدة
ولا تحزيم لهما. أمر المقارنة:

```powershell
ffmpeg -hide_banner -i dist/live-tests/live_823d4296b36c4106e65567de/evidence/before-recording.png -i dist/live-tests/live_823d4296b36c4106e65567de/evidence/decoded-frame-0.png -filter_complex "[0:v]crop=800:520:1080:100,format=yuv444p[a];[1:v]crop=800:520:1080:100,format=yuv444p[b];[a][b]ssim" -frames:v 1 -f null NUL
```

## إثبات العضّة

المشغّلات المحلية في `dist/recording-quality-development/`، وبداخلها نص الزرع.
الحفظ والاستعادة من Buffer قبل الزرع نفسه، لا من Git؛ لذلك تحفظ التعديلات السابقة.

### قبول resizeMode غير الأصلي

أمر الزرع والتشغيل والاستعادة: `node dist/recording-quality-development/quality-mutations.cjs`.
يستبدل حرفياً في `src/ui/lib/media-recorder.js`:

```js
if (!settings || settings.resizeMode !== 'none') throw fail('native_capture_unavailable');
// المتحوّر
if (!settings) throw fail('native_capture_unavailable');
```

العد: الأصل `1 → 0`، المتحوّر `0 → 1`.
شغّل `node scripts/app-recording-quality-test.js`، رمز `1`، والفشل الحرفي:

```text
app-recording-quality: FAIL — Error: رفض resizeMode غير الأصلي: crop-and-scale: AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

الاستعادة في `finally` بالأمر نفسه: `fs.writeFileSync(file,raw)`.
`RESTORE byte_equal=true`؛ SHA-256 وقت الاستعادة
`84b48ea39633a6a33047713190887fd48ca140acf88afc7721328b0b532615fb`.
السجل `native-mode.log`.

### طمس الأبعاد المقيسة بأبعاد النافذة

الأمر نفسه يزرع في `electron/promocapture.js`:
`active.width = capture.width;` → `active.width = 1180;`.
العد: الأصل `1 → 0`، المتحوّر `0 → 1`.
شغّل `node scripts/promo-app-window-test.js`، رمز `1`، والفشل الحرفي:

```text
promo-app-window: FAIL — AssertionError [ERR_ASSERTION]: عرض الفيديو المقاس يجب أن يغلب عرض النافذة المنطقي

1180 !== 1920
```

الاستعادة `fs.writeFileSync(file,raw)` داخل `finally` للأمر نفسه،
`RESTORE byte_equal=true`، SHA-256 وقتها
`c93b78d51e85983f32ff31c91553eab6f6579b865a644d529fad8e01853f22f2`.
السجل `measured-dimensions.log`.

### طمس إنتاجي مع بقاء Full HD

الزرع: `node dist/recording-quality-development/blur-mutation.cjs plant`.
استبدل إنشاء `MediaRecorder` في `preview-panel.js` بمسار مؤقت يرسم
مصدر الفيديو الفعلي عبر `canvas` وبنفس أبعاد `1920×1080`،
ويطبق `blurContext.filter = 'blur(1px)'` **قبل الترميز**.
الصفحة وعلامة الاختبار بقيتا حادتين؛ لم يُعدّل الحارس ليصطنع الفشل.
العد: الأصل `1 → 0`، المتحوّر `0 → 1`.

التشغيل الفعلي `term_54`:

```powershell
node scripts/live-test.js launch live_e4ddbcf1ce4b008b88b9872b --record-consent --recording-hd --smoke
```

بقي الإطاران `1920×1080`، وانخفض التباين إلى `4.75` و`4.98`.
الفشل الحرفي:

```text
LIVE_TEST_FAILED HD_recording_must_preserve_one-pixel_detail_contrast____180
LIVE_TEST_EXIT code=1
```

الاستعادة: `node dist/recording-quality-development/blur-mutation.cjs restore`.
العد بعد الاستعادة: الأصل `1`، المتحوّر `0`، `byte_equal=true`.
SHA-256 وقتها `9e7d9d2e1ddbcd66b5a0b28e83ba4f26c725c361724ff51147471f83fe3ca3e5`.
المشغّل يرفض الاستعادة إن تغيّر الملف عن المتحوّر المتوقع، ولا يطمس تحريراً متزامناً.
عادت العينة النظيفة في `term_55` إلى PASS.

## الاختبارات وحدودها

نجحت بعد الاستعادة: `test:live-test` (10 مجموعات عزل، 14 حالة متحكم،
10 حالات وصلة، 44 حالة جودة)، `test:promocapture`،
`test:promocapture-batch1`، `test:preview-recording`،
`test:suite-coverage` (311 فحصاً)، `test:skills`.
فُحصت وحدات الواجهة كـESM، وملفات Main/Preload والمشغّل عبر `node --check`.
البحث عن تثبيت البنية القديمة لم يكشف حارساً يلزم تغييره؛
اختيار الصيغة القديم في مسبار الويب مستقل ويبقى صالحاً.

لم يُشغّل `test:full` لهذه الدفعة؛ نتائجه القديمة لا تثبت نجاح هذه الدفعة أو فشلها.
القياس الفعلي على Windows وشاشة واحدة بكثافة 100%، فيديو صامت ومشهد محلي قصير.
لا يثبت أجهزة أخرى أو 4K أو صوتاً أو جودة مونتاج تسويقي أو استمرار التسجيل عبر إعادة تحميل القشرة.
طلب معدل بت أعلى لا يضمن حجماً أكبر: المشهد شبه ثابت ويستخدم ترميزاً متغير المعدل.
`contentHint:detail` توجيه للمرمّز، لا برهان جودة؛ البرهان هنا إطار الملف نفسه.


## استكمال تصحيح أبعاد النافذة الصغيرة

كشف `term_57` أن `none` يجب أن يقترن بأبعاد المحتوى الفيزيائية عبر
`width/height:exact`. مصدر HWND نفسه بقي ثابتاً؛ قياس `1164×761` أعطى
إطاراً خاماً وفيديو `1164×760`. المقارنة بـ`crop-and-scale` أعطت `1162×760`.
القياسات في `dist/live-tests/live_cc1268e77e0c3451f1b9d86c/evidence/capture-exact-measurements.json`.

تمرير `pixels={width:Math.round(innerWidth*devicePixelRatio),height:Math.round(innerHeight*devicePixelRatio)}`
يمنع اختيار مقاس شاشة ثابت لنافذة صغيرة. وفي `term_58` سقط الحارس برسالة
`LIVE_TEST_FAILED saved_dimensions_must_match_decoded_video`: كان التقرير الأولي
للارتفاع `761`، بينما الفيديو `760`. احتُفظ بالفشل ولا يُعد PASS.

الإصلاح النهائي ينتظر أول إطار في عنصر فيديو منفصل قبل إعلان الجاهزية،
ضمن مهلة مشتركة `3000ms` للتشغيل ووصول الإطار. يؤخذ `capture` من
`videoWidth/videoHeight`، ويُستخدم `getSettings()` للتحقق من المسار.
يُفصل عنصر القياس وتُلغى مواعيده حتى عند الفشل دون إيقاف مسار التسجيل.
التقريب المقيس لصف واحد على النافذة المؤطرة لا يُخفى بأبعاد مختلقة.

بعده نجح `term_59`:

```powershell
node scripts/live-test.js launch live_f104923c5b03dde38046a3d6 --record-consent --smoke
```

`LIVE_TEST_SMOKE PASS` و`LIVE_TEST_EXIT code=0`؛ الإطاران والسجل
`1164×760`، والملف `404452 bytes`. هذا يثبت التسجيل والحفظ وتطابق الأبعاد
بالحجم العادي؛ معيار تباين خطوط البكسل يخص تشغيل `--recording-hd`.
أعيد `test:live-test` بعد التصحيح الأخير ونجح:
10 مجموعات عزل، 14 متحكماً، 10 وصلة، **70 حالة جودة**.

### عضّة تثبيت الأبعاد

الأمر الفعلي: `node dist/recording-quality-development/exact-dimensions-mutation.cjs`.
زرع في دالة الإنتاج:

```js
width: { exact: pixels.width }, height: { exact: pixels.height }
// المتحوّر
width: { ideal: 1920 }, height: { ideal: 1080 }
```

العد: الأصل `1 → 0`، المتحوّر `0 → 1`.
تشغيل `node scripts/app-recording-quality-test.js` أعاد `1`.
الفشل الحرفي:

```text
app-recording-quality: FAIL — Error: القيود تسبق hint وقراءة الأبعاد وتُنتظر حتى الاكتمال: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected

  [
    [
      'applyConstraints',
      {
        height: {
+         ideal: 1080
-         exact: 1080
        },
        resizeMode: {
          exact: 'none'
        },
        width: {
+         ideal: 1920
-         exact: 1920
        }
      }
    ],
    [
      'contentHint',
```

الاستعادة داخل `finally` في الأمر نفسه بـ`fs.writeFileSync(file,raw)`،
`byte_equal=true`، والبصمة
`a1f7af0b2cd7827326ee6bca90eef5107f63027b02f0fd35b4bf70a2d0812e19`.
السجل `exact-dimensions-mutation.log`.

### عضّة قياس أول إطار

الأمر الفعلي: `node dist/recording-quality-development/first-frame-mutation.cjs`.
الزرع `const { width, height } = capture;` → `const { width, height } = settings;`.
العد: الأصل `1 → 0`، المتحوّر `0 → 1`؛ تشغيل حارس الجودة أعاد `1`.
الفشل الحرفي:

```text
app-recording-quality: FAIL — Error: السجل يعتمد 760 الفعلية عند طلب ارتفاع 761: AssertionError [ERR_ASSERTION]: تقريب صف واحد في المسار يجب أن يُحفظ كما قيس، لا أن يُستبدل بالطلب
+ actual - expected

  {
+   height: 761,
-   height: 760,
    width: 1164
  }
```

الاستعادة داخل `finally` في الأمر نفسه بـ`fs.writeFileSync(file,raw)`،
`byte_equal=true` وبصمة الاستعادة نفسها أعلاه.
السجل `first-frame-mutation.log`. أعيد الحارس بعدهما ونجح **70/70**.

## نتيجة الكود النهائي

تشغيل `term_60` بعد تثبيت أبعاد المحتوى وقياس أول إطار وجميع الاستعادات:

```powershell
node scripts/live-test.js launch live_e1ce91b0a0b74557cc9177b7 --record-consent --recording-hd --smoke
```

نجح `LIVE_TEST_SMOKE PASS` وخرج `0`؛ `completion.json` يحوي `closed`.
[العينة النهائية](../dist/live-tests/live_e1ce91b0a0b74557cc9177b7/home/Downloads/satr-promo-segment-promo_8035b64668712bae9db7b807-2026-09-09-03-28-01.mp4)
و[إطارها بالحجم الأصلي](../dist/live-tests/live_e1ce91b0a0b74557cc9177b7/evidence/decoded-frame-0.png).

`ffprobe`: H.264 High، `1920×1080`، `yuv420p`، SAR `1:1`،
مدة `3.514033s`، حجم `400225 bytes`، معدل فيديو `907497bps`،
متوسط الإطارات `2520000/105421 ≈ 23.90fps`.
ساعة التطبيق `3848ms`؛ السجل والإطاران المفكوكان متطابقون في الأبعاد.
تباين الخطوط `254.5` و`255`؛ معيار `>=180` ناجح.
SHA-256:
`5833b4a31d811d981c5c85bcede3f9a47d114b71d0cfcbbbf6df80c665be880b`.

أُغلقت تجارب هذه الدفعة واحتُفظ بالمقاطع والأدلة. بقيت نافذة المالك `term_39`
وبيئة قبول التوصيلات كما كانتا. لا توجد أعطال مزروعة باقية في الكود.
الاختبار والحفظ مكتملان؛ لم يُنتج مونتاج إعلاني ولم يُنشر شيء.
