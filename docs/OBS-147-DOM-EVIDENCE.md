# دليل حارس DOM لـ OBS-147 — 2026-09-09

## النطاق والنتيجة

حارس `scripts/pwa-dom-live-test.js` يحمّل `pwa/index.html` و`pwa/styles.css`
و`pwa/app.js` الفعلية في Chromium بعرض `420` وارتفاع `900`، داخل partition مؤقتة
بلا مخزن مستخدم. أضيفت `16` فحوص سلوكية إلى فحوص العرض القائمة؛ المجموع `70`.
استمرت قيود `contextIsolation:true / sandbox:true / nodeIntegration:false`.

حقن IIFE مخصص للاختبار في نسخة `app.js` المخدومة فقط يكشف الحالة ودوال
`stopAgent / pollLoop / showScreen`؛ لا hook محفوظ في الإنتاج.
الأطر الواردة تمر بـ `pwa/crypto.js` و`openFrame` و`pollLoop` والرسم الفعلي.
`sendUplink / postFrame` يستعملان منطق الإنتاج ويستقبلان رد `202` من fetch مصطنع.
مفاتيح الجلسة تتولد داخل Chromium ولا تُكتب في الأدلة أو تُرسل لخدمة خارجية.

ما قيس:
- `202` يبقي بطاقة A مرئية ويعرض انتظار تأكيد الحاسوب بعد دورة poll جديدة؛ لوحة الحالة تبقى «يعمل».
- `command_result` المطابق يخفي البطاقة فعلياً ويعرض «أكّد الحاسوب انتهاء الدور الجاري.»، ويبقى النص بعد poll تالٍ.
- وصول بطاقة ولقطة B قبل إقرار A: الإقرار القديم لا يغير نص B أو رؤيتها أو مشروعها ومهمتها وعدّاداتها.
- إقرار A لا يحسم طلب B؛ إقرار B الصحيح يعمل ويخفي بطاقته.

يقيس الحارس DOM بالنص و`display` و`getClientRects`. لا شهادة هاتف بشري، ولا مقارنة
بكسلات أو قياس RTL أو Web Push أو نقل وسيط خارجي أو تنفيذ إيقاف محرك حقيقي.
يستدعي `stopAgent` مباشرة، فلا يعدّ دليلاً على نقر المستخدم أو ربط زر الإيقاف.
القناة المصطنعة لا تمثّل غياب الشبكة أو بطئها؛ تلك الحالات مغطاة بالحراس الأخرى في الدفعة.

## القياس السليم

الأمر:
```powershell
npm run test:pwa-dom
```

رمز الخروج الأول `0`؛ النتيجة `70` فحصاً بلا فشل.
لقطات DOM محفوظة في `baseline.json`.
بصمة مصدر PWA وقت القياس:
`f178b1f87d676477bfdaa758d0f604935d3e5830560a86cd4b02c7a3dfe345f5`.

## العضّة الفعلية

أعيد السلوك المعيب بعد نجاح الإرسال: إخفاء البطاقة وإعلان «أُوقف الوكيل» بعد `202`.
الزرع في سطر إنتاج فعلي من `pwa/app.js`، لا تعديل لتوقع الاختبار.

أمر الحفظ والزرع كما نُفذ:
```powershell
Copy-Item -LiteralPath 'dist/obs147-pwa-dom/latest.json' -Destination 'dist/obs147-pwa-dom/baseline.json'
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
from pathlib import Path
import hashlib
p=Path('pwa/app.js')
s=p.read_bytes()
a="    if (state.currentRun === run) setStatus('أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب.');".encode('utf-8')
b="    if (state.currentRun === run) { hideCard(); setStatus('أُوقف الوكيل.'); }".encode('utf-8')
print('before source=%d replacement=%d sha256=%s' % (s.count(a),s.count(b),hashlib.sha256(s).hexdigest()))
assert s.count(a)==1 and s.count(b)==0
s=s.replace(a,b,1)
p.write_bytes(s)
s=p.read_bytes()
print('after source=%d replacement=%d sha256=%s' % (s.count(a),s.count(b),hashlib.sha256(s).hexdigest()))
assert s.count(a)==0 and s.count(b)==1
'@ | python -
```

العد الحرفي، `source` هو الأصل و`replacement` المتحور:
```text
before source=1 replacement=0 sha256=f178b1f87d676477bfdaa758d0f604935d3e5830560a86cd4b02c7a3dfe345f5
after source=0 replacement=1 sha256=d62861551d70a965d8e7fd71b3e7db9fddcca3c5fd2fb0ffea0fb2166407d98f
```

أمر الحارس `npm run test:pwa-dom`، رمز الخروج `1`؛ الخرج الحرفي:
```text
> satr@2.16.21 test:pwa-dom
> electron scripts/pwa-dom-live-test.js


pwa-dom-live-test: FAIL
  - OBS-147: HTTP 202 يبقي بطاقة إذن A مرئية
  - OBS-147: 202 لا يعلن التنفيذ ودورة poll لا تطمس الانتظار — توقّعنا "أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب." ووجدنا "أُوقف الوكيل."
  - OBS-147: إقرار A لا يخفي بطاقة B أثناء طلب إيقاف B
  - OBS-147: إقرار A لا يؤكد طلب إيقاف B — توقّعنا "أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب." ووجدنا "أُوقف الوكيل."
```

أمر الحفظ والاستعادة كما نُفذ:
```powershell
Copy-Item -LiteralPath 'dist/obs147-pwa-dom/latest.json' -Destination 'dist/obs147-pwa-dom/mutant.json'
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
from pathlib import Path
import hashlib
p=Path('pwa/app.js')
s=p.read_bytes()
a="    if (state.currentRun === run) { hideCard(); setStatus('أُوقف الوكيل.'); }".encode('utf-8')
b="    if (state.currentRun === run) setStatus('أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب.');".encode('utf-8')
print('before source=%d replacement=%d sha256=%s' % (s.count(a),s.count(b),hashlib.sha256(s).hexdigest()))
assert s.count(a)==1 and s.count(b)==0
s=s.replace(a,b,1)
p.write_bytes(s)
s=p.read_bytes()
print('after source=%d replacement=%d sha256=%s' % (s.count(a),s.count(b),hashlib.sha256(s).hexdigest()))
assert s.count(a)==0 and s.count(b)==1
'@ | python -
```

العد الحرفي للاستعادة، `source` هو المتحور و`replacement` الأصل:
```text
before source=1 replacement=0 sha256=d62861551d70a965d8e7fd71b3e7db9fddcca3c5fd2fb0ffea0fb2166407d98f
after source=0 replacement=1 sha256=f178b1f87d676477bfdaa758d0f604935d3e5830560a86cd4b02c7a3dfe345f5
```

## بعد الاستعادة

أعيد `npm run test:pwa-dom` بعد استرجاع بصمة الإنتاج نفسها.
رمز الخروج `0`، والخرج:
```text
> satr@2.16.21 test:pwa-dom
> electron scripts/pwa-dom-live-test.js


pwa-dom-live-test: ok — 70 فحصاً (‏Chromium حقيقي يقيس display والنصوص على صفحة الهاتف الفعلية).
```

اللقطات النهائية في `latest.json`، ولقطات النسخة المعيبة في `mutant.json`.
نجح فحص البنية `node --check scripts/pwa-dom-live-test.js` وفحص الفرق.
لم تتغير ملفات الإنتاج نتيجة عمل هذا الحارس؛ تغييره الدائم محصور في ملف الاختبار.

لقطات JSON المشار إليها أعلاه داخل `dist/obs147-pwa-dom/`، لا في مجلد الوثائق.
