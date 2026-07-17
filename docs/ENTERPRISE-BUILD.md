# بناء Satr Enterprise

شفرة Enterprise لا تعيش في مستودع Community. يحتفظ فريق الإصدار بـcheckout خاص مستقل،
ويُدخله `electron-builder` مباشرة في الحزمة عند البناء فقط.

## العقد

يجب أن يحتوي جذر المستودع الخاص على:

- `satr-enterprise.json` بالقيم `name: "@satr/enterprise"` و`contractVersion: 1` و`main: "index.js"`.
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

## التطوير والتحقق

```powershell
npm --prefix D:\sater\satr-enterprise test
npm run test:enterprise
npm run test:full
```

اختبار Community يتحقق من غياب المصدر المملوك، وصحة عقد checkout الخارجي، وبقاء النواة
وOllama عاملين عند غياب Enterprise. اختبارات القدرات التجارية نفسها تبقى في المستودع الخاص.
