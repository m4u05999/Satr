# بناء Satr Enterprise

شفرة Enterprise لا تعيش في مستودع Community. يحتفظ فريق الإصدار بـcheckout خاص مستقل،
ويُدخله `electron-builder` مباشرة في الحزمة عند البناء فقط.

## العقد

يجب أن يحتوي جذر المستودع الخاص على:

- `satr-enterprise.json` بالقيم `name: "@satr/enterprise"` و`contractVersion: 1` و`main: "index.js"`.
- `packageFiles` قائمة سماح صريحة بملفات التشغيل التجارية التي تدخل الحزمة؛ لا تُقبل مسارات
  مطلقة أو صاعدة، ويجب أن تضم نقطة الدخول و`LICENSE`.
- `index.js` يصدّر `register(seams)`، ويمكنه تصدير `info()`.
- `LICENSE` تجارية.

يتحقق `scripts/enterprise-source.js` من أن المسار مطلق، موجود، خارج مستودع Community،
وأن العقد والملفات المطلوبة صحيحة. يفشل البناء مغلقاً عند أي مخالفة.

## البناء على Windows

```powershell
$env:SATR_ENTERPRISE_DIR = 'D:\sater\satr-enterprise'
npm run dist:ee
```

يضيف `scripts/ee-builder-config.js` checkout الخاص إلى المسار المنطقي `enterprise/` داخل
الحزمة فقط. لا ينسخ المصدر إلى شجرة Community ولا يسجله Git. يظل `npm run dist` مجتمعياً
ويستبعد `enterprise/**` صراحةً.

يحقن البناء `satrEdition: "enterprise"` ونسخة العقد في `package.json` المحزومين، ويكتب
المخرجات في `dist/enterprise/` منعاً لاختلاط `win-unpacked` أو بيانات التحديث العامة مع
Community. تُصفّر `publish` صراحةً (لمنع دمج إعداد Community) ويُمرّر `--publish never`، كما يعطّل runtime المحدث العام عند
هوية Enterprise حتى لو وُجد ملف تحديث قديم خطأً.

يفحص workflow الخاص `app.asar` بعد البناء: الهوية، ملفات Enterprise المسموحة، غياب ملفات
التطوير و`app-update.yml`. ثم يرفع مع المثبّت ملف provenance خاصاً يتضمن SHA للمستودعين
وإصدارات العقد وبصمات SHA-256 للملفات، بلا شفرة أو أسرار.

## التطوير والتحقق

```powershell
npm --prefix D:\sater\satr-enterprise test
npm run test:enterprise
npm run test:full
```

اختبار Community يتحقق من غياب المصدر المملوك، وصحة عقد checkout الخارجي، وبقاء النواة
وOllama عاملين عند غياب Enterprise. اختبارات القدرات التجارية نفسها تبقى في المستودع الخاص.
