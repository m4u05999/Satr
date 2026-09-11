# دليل قرائية PWA — 2026-09-09

الحارس الدائم `scripts/pwa-readability-test.js` يستدعي نواة `READABILITY_FN` المستخرجة من `electron/preview.js` حرفياً، ويخدم PWA عبر `mobilelink.start` الإنتاجية باسم محلي `createMobileLink`. أُدخل في `scripts/pwa-dom-live-test.js` إلى جانب `testPwaSw`؛ فيدخل مسار الهاتف والطقم الكامل دون زيادة مجموعة. هذه أدلة الحارس الآلي، ولا تمنح قبول هاتف أو معاينة بشرية.

## العزل والنطاق

خادم HTTPS على `127.0.0.1` ومنفذ عشوائي، مع شهادة وهوية مصطنعتين في الذاكرة. يُستبدل `mobiletls.ensureCert` مؤقتاً أثناء إنشاء الخادم فقط لتجنب مخزن المستخدم، ثم يُستعاد؛ خدمة الملفات وحصر الامتدادات وMIME من الإنتاج. يتحقق Chromium من الشهادة المصطنعة ذاتها واسم المضيف داخل session مؤقتة، وتبقى `sandbox` و`contextIsolation` مفعّلتين و`nodeIntegration` معطلة. لا PIN أو اقتران أو حسابات أو قراءة أسرار.

تُظهر هندسياً الشاشات الموجودة PIN وpair وmain، ومع main فقرة `pushSupported` التي ظهر عطل تباينها. يُثبت `innerWidth` قبل القياس عند 390 و1000، مع height=800. تُفحص الأصول الستة العربية/اللاتينية للأوزان 400/500/700 عبر HTTPS: status=200 و`font/woff2` والحجم وSHA256 مطابق لنسخة الخط المضمّنة. هذا يكشف ضياع أصل غير مستعمل حالياً؛ `counts.font` وحده لا يكفي لذلك.

## الأحمر قبل الإصلاح

الأمر الفعلي، بعد إصلاح مدخل مشغّل Electron وعزله، هو:

```powershell
node node_modules/electron/cli.js scripts/pwa-readability-test.js
```

خرج `exit=1` في 2.22s، إيصال `328f10`. تقريره المحفوظ: `dist/pwa-readability-test/red-before-fix.json`. PIN وpair: font=1 وcontrast=1 عند العرضين؛ main: font=1 وcontrast=3 عند العرضين. direction/overflow=0 وunseen=0 وtruncated=false في الحالات الست. ملفات woff2 الستة عادت 404. السطر الحرفي للفشل:

```text
AssertionError [ERR_ASSERTION]: pwa-readability: asset ibm-plex-sans-arabic-arabic-400-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-arabic-500-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-arabic-700-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-latin-400-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-latin-500-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-latin-700-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; pin@390 font=1; pin@390 contrast=1; pair@390 font=1; pair@390 contrast=1; main@390 font=1; main@390 contrast=3; pin@1000 font=1; pin@1000 contrast=1; pair@1000 font=1; pair@1000 contrast=1; main@1000 font=1; main@1000 contrast=3

18 !== 0
```

محاولة سابقة بالاستثناء الحدثي للشهادة فقط أكملت خمس قياسات ثم انتهت بمهلة30s؛ لم تُعتمد كدليل سقوط الحارس. حُصر التحقق بالشهادة عبر `session.setCertificateVerifyProc` وجُمعت الشاشات تحت مقاس واحد قبل الانتقال للمقاس التالي؛ لم تُغيّر نواة القياس أو مهلة30s أو مهلة مجموعة DOM45s.

## عرف العضّة: زرع فعلي واستعادة دقيقة

بعد أخضر أولي `51f5f9`، نُفذ الأمر التالي مرة واحدة؛ مشغّله ينفذ العضّات الأربع بالتتابع ويعيد كل ملف من Buffer محفوظ في `finally` قبل الانتقال للتالية. الاستعادة لا تقرأ Git ولا تزيل التعديلات السابقة. خرج المشغّل `exit=0` و`PWA_READABILITY_MUTATIONS PASS 4/4; production restored`، إيصال `7c445e`. كل اختبار مزروع داخله خرج1 برسالة AssertionError المطلوبة.

```powershell
node dist/pwa-readability-mutations.cjs
```

نص أمر الزرع والاستعادة البرمجي كما نُفّذ، محفوظ هنا حتى لا يعتمد الإيصال على بقاء dist:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'dist', 'pwa-readability-test');
const definitions = [
  { name: 'font-link', file: 'pwa/index.html', original: '  <link rel="stylesheet" href="fonts.css">', mutant: '  <!-- mutation: font stylesheet removed -->', failure: 'pin@390 font=1' },
  { name: 'font-extension', file: 'electron/mobilelink.js', original: "'.png', '.ico', '.woff2']);", mutant: "'.png', '.ico']);", failure: 'status=404 mime=application/json; charset=utf-8 bytesMatch=false' },
  { name: 'contrast', file: 'pwa/styles.css', original: '--text-faint: #99978f;', mutant: '--text-faint: #7c7b74;', failure: 'pin@390 contrast=1' },
  { name: 'font-mime', file: 'electron/mobilelink.js', original: "'.woff2': 'font/woff2',", mutant: "'.woff2': 'text/plain',", failure: 'status=200 mime=text/plain bytesMatch=true' },
];
const count = (source, text) => source.split(text).length - 1;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(directory, { recursive: true });
fs.copyFileSync(path.join(directory, 'latest.json'), path.join(directory, 'green-before-mutations.json'));
for (const definition of definitions) {
  const file = path.join(root, definition.file);
  const originalBuffer = fs.readFileSync(file);
  const before = originalBuffer.toString('utf8');
  const backup = path.join(directory, definition.name + '.original.bin');
  fs.writeFileSync(backup, originalBuffer);
  const report = { ...definition, command: 'node dist/pwa-readability-mutations.cjs',
    testCommand: 'node node_modules/electron/cli.js scripts/pwa-readability-test.js',
    before: { original: count(before, definition.original), mutant: count(before, definition.mutant) },
    originalSha256: sha256(originalBuffer) };
  if (report.before.original !== 1 || report.before.mutant !== 0) throw Error('unexpected mutation anchors: ' + definition.name);
  const mutated = before.replace(definition.original, definition.mutant);
  try {
    fs.writeFileSync(file, mutated, 'utf8');
    const after = fs.readFileSync(file, 'utf8');
    report.after = { original: count(after, definition.original), mutant: count(after, definition.mutant) };
    if (report.after.original !== 0 || report.after.mutant !== 1) throw Error('mutation not applied: ' + definition.name);
    console.log('MUTATION ' + definition.name + ' before=' + JSON.stringify(report.before) + ' after=' + JSON.stringify(report.after));
    const result = spawnSync(process.execPath, ['node_modules/electron/cli.js', 'scripts/pwa-readability-test.js'], {
      cwd: root, encoding: 'utf8', timeout: 40000, windowsHide: true,
    });
    report.exitCode = result.status;
    report.output = (result.stdout || '') + (result.stderr || '');
    console.log(report.output);
    if (result.error) throw result.error;
    if (result.status !== 1 || !report.output.includes('AssertionError [ERR_ASSERTION]: pwa-readability:') || !report.output.includes(definition.failure)) {
      throw Error('missing expected bite: ' + definition.name + ' exit=' + result.status);
    }
  } finally {
    fs.writeFileSync(file, originalBuffer);
    const restored = fs.readFileSync(file);
    report.restoredSha256 = sha256(restored);
    report.restored = restored.equals(originalBuffer);
    report.restore = { original: count(restored.toString('utf8'), definition.original), mutant: count(restored.toString('utf8'), definition.mutant) };
    fs.writeFileSync(path.join(directory, 'bite-' + definition.name + '.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('RESTORED ' + definition.name + ' exact=' + report.restored + ' sha256=' + report.restoredSha256 + ' counts=' + JSON.stringify(report.restore));
    if (!report.restored) throw Error('restore mismatch');
  }
}
console.log('PWA_READABILITY_MUTATIONS PASS 4/4; production restored');
```

### font-link

الملف: `pwa/index.html`. الأصل `  <link rel="stylesheet" href="fonts.css">`؛ المتحوّر `  <!-- mutation: font stylesheet removed -->`.

```text
MUTATION font-link before={"original":1,"mutant":0} after={"original":0,"mutant":1}
exit=1
AssertionError [ERR_ASSERTION]: pwa-readability: pin@390 font=1; pair@390 font=1; main@390 font=1; pin@1000 font=1; pair@1000 font=1; main@1000 font=1

6 !== 0

    at testPwaReadability (D:\sater\satr-2\scripts\pwa-readability-test.js:144:12)
RESTORED font-link exact=true sha256=cb45ddaf13f195d125e5110effe690e41b871abd6e6d1eafdb61ae9b0ec950ff counts={"original":1,"mutant":0}
```

### font-extension

الملف: `electron/mobilelink.js`. الأصل `'.png', '.ico', '.woff2']);`؛ المتحوّر `'.png', '.ico']);`.

```text
MUTATION font-extension before={"original":1,"mutant":0} after={"original":0,"mutant":1}
exit=1
AssertionError [ERR_ASSERTION]: pwa-readability: asset ibm-plex-sans-arabic-arabic-400-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-arabic-500-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-arabic-700-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-latin-400-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-latin-500-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; asset ibm-plex-sans-arabic-latin-700-normal.woff2 status=404 mime=application/json; charset=utf-8 bytesMatch=false; pin@390 font=1; pair@390 font=1; main@390 font=1; pin@1000 font=1; pair@1000 font=1; main@1000 font=1

12 !== 0

    at testPwaReadability (D:\sater\satr-2\scripts\pwa-readability-test.js:144:12)
RESTORED font-extension exact=true sha256=d6967994f170f6c65cffb4db026b453d45f9675c9aaeef4633e679d08f5d2eb3 counts={"original":1,"mutant":0}
```

### contrast

الملف: `pwa/styles.css`. الأصل `--text-faint: #99978f;`؛ المتحوّر `--text-faint: #7c7b74;`.

```text
MUTATION contrast before={"original":1,"mutant":0} after={"original":0,"mutant":1}
exit=1
AssertionError [ERR_ASSERTION]: pwa-readability: pin@390 contrast=1; pair@390 contrast=1; main@390 contrast=3; pin@1000 contrast=1; pair@1000 contrast=1; main@1000 contrast=3

6 !== 0

    at testPwaReadability (D:\sater\satr-2\scripts\pwa-readability-test.js:144:12)
RESTORED contrast exact=true sha256=4795a25550916beb912f1d412e57f0cc2dd7367ec0b0205183350f8ea0d1de4d counts={"original":1,"mutant":0}
```

### font-mime

الملف: `electron/mobilelink.js`. الأصل `'.woff2': 'font/woff2',`؛ المتحوّر `'.woff2': 'text/plain',`.

```text
MUTATION font-mime before={"original":1,"mutant":0} after={"original":0,"mutant":1}
exit=1
AssertionError [ERR_ASSERTION]: pwa-readability: asset ibm-plex-sans-arabic-arabic-400-normal.woff2 status=200 mime=text/plain bytesMatch=true; asset ibm-plex-sans-arabic-arabic-500-normal.woff2 status=200 mime=text/plain bytesMatch=true; asset ibm-plex-sans-arabic-arabic-700-normal.woff2 status=200 mime=text/plain bytesMatch=true; asset ibm-plex-sans-arabic-latin-400-normal.woff2 status=200 mime=text/plain bytesMatch=true; asset ibm-plex-sans-arabic-latin-500-normal.woff2 status=200 mime=text/plain bytesMatch=true; asset ibm-plex-sans-arabic-latin-700-normal.woff2 status=200 mime=text/plain bytesMatch=true

6 !== 0

    at testPwaReadability (D:\sater\satr-2\scripts\pwa-readability-test.js:144:12)
RESTORED font-mime exact=true sha256=d6967994f170f6c65cffb4db026b453d45f9675c9aaeef4633e679d08f5d2eb3 counts={"original":1,"mutant":0}
```

## الأخضر النهائي والدمج

بعد الاستعادة، شُغّل الأمر:

```powershell
npm run test:pwa-dom
```

إيصال `142683`، `exit=0`، زمن6.47s شاملاً أمر الربط السابق له. خرجت الخواتيم التالية حرفياً:

```text
pwa-sw: 7/7 scenarios passed
pwa-readability: PASS 6/6 — production HTTPS; actual widths=390,1000; counts/unseen=0; truncated=false
pwa-dom-live-test: ok — 70 فحصاً (‏Chromium حقيقي يقيس display والنصوص على صفحة الهاتف الفعلية).
```

| الشاشة | العرض المطلوب/الفعلي | النصوص المقيسة | font/contrast/direction/overflow | unseen | truncated |
|---|---:|---:|---|---|---|
| pin | 390/390 | 2 | 0/0/0/0 | 0/0/0 | false |
| pair | 390/390 | 2 | 0/0/0/0 | 0/0/0 | false |
| main | 390/390 | 3 | 0/0/0/0 | 0/0/0 | false |
| pin | 1000/1000 | 2 | 0/0/0/0 | 0/0/0 | false |
| pair | 1000/1000 | 2 | 0/0/0/0 | 0/0/0 | false |
| main | 1000/1000 | 3 | 0/0/0/0 | 0/0/0 | false |

التقرير النهائي `dist/pwa-readability-test/green-final.json` يحتوي hashes وأنواع وأحجام الأصول الستة والقياسات الخام. `latest.json` يتغير مع كل تشغيل. وجدت محاولة الدمج الأولى `cb6d49` أن إغلاق نافذة الحارس الوحيدة يُنهي Electron قبل نافذة DOM التالية، فطبعت `ERR_FAILED` رغم خروج0؛ لا تُعد نجاحاً. أصلح مشغّل المجموعة دورة حياته بـ`app.on("window-all-closed", () => {})`؛ خاتمته الصريحة هي التي تحكم الخروج الآن، وأعاد الأمر التالي جميع الفحوص السبعين فعلياً.

## الحدود

- هذه نواة الإنتاج في نافذة Electron معزولة، لا قياس لوحة المعاينة التي ثبت أن `innerWidth` فيها1، ولا قبول هاتف حقيقي.
- النواة تقيس النصوص الدلالية مثل الفقرات؛ الأزرار والنصوص غير الدلالية وبطاقات الإذن والحالة المخفية خارج هذه الحالات. لم تدخل بيانات جلسة لإظهارها.
- لا Shadow DOM أو iframe أو اتجاه غير مقيس في المشاهد الست؛ يسقط الحارس إن صار أي عداد unseen غير صفري أو التقرير truncated. ليس هذا ادعاء تغطية جميع حالات التطبيق.
- العضّات الأربع تثبت الخط وربطه وخدمته ونوعه والتباين. يفحص الحارس direction وoverflow والتغطية أيضاً، لكن لم نزرع طفرة مستقلة لهذه الفروع في هذه الدفعة.
- إثبات الكاش من حارس مستقل: [PWA-SW-EVIDENCE.md](PWA-SW-EVIDENCE.md). لم تُرفع مهل الاختبارات ولم يُشغّل طقم كامل من هذا العمل الفرعي.
