# دليل عضّات حارس المعاينة

النسخة المعزولة: `dist/preview-shield-bite`. لا زرع في مصدر العمل.
الاختبار بعد الإصلاح: `npm run test:preview-shield` — نجح 43/43، صفر انتهاكات CSP.
تجارب العضّات الأربع أدناه أُجريت فعلياً، وكل منها أنهى حارس Electron برمز خروج 1.

## overlay

```text
زرع: node dist/preview-shield-bite/mutate.cjs plant overlay
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: & node_modules\.bin\electron.cmd dist/preview-shield-bite/scripts/preview-shield-test.js
فشل الحارس: preview-shield: AssertionError [ERR_ASSERTION]: المنبثق المعلم يحجب دون aria-modal (openOverlay=false)
guard_exit=1
استعادة: node dist/preview-shield-bite/mutate.cjs restore
restored from isolated pristine copy
```

## class

```text
زرع: node dist/preview-shield-bite/mutate.cjs plant class
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: & node_modules\.bin\electron.cmd dist/preview-shield-bite/scripts/preview-shield-test.js
فشل الحارس: preview-shield: AssertionError [ERR_ASSERTION]: فتح قائمة class يحجب (openClassMenu=false)
guard_exit=1
استعادة: node dist/preview-shield-bite/mutate.cjs restore
restored from isolated pristine copy
```

## upgrade

```text
زرع: node dist/preview-shield-bite/mutate.cjs plant upgrade
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: & node_modules\.bin\electron.cmd dist/preview-shield-bite/scripts/preview-shield-test.js
فشل الحارس: preview-shield: AssertionError [ERR_ASSERTION]: ترقية المضيف تخفيه بأنماط Shadow وتفك الحجب (afterUpgrade=true)
guard_exit=1
استعادة: node dist/preview-shield-bite/mutate.cjs restore
restored from isolated pristine copy
```

## overlap

```text
زرع: node dist/preview-shield-bite/mutate.cjs plant overlap
قبل: original=1 mutant=0
بعد: original=0 mutant=1
اختبار: & node_modules\.bin\electron.cmd dist/preview-shield-bite/scripts/preview-shield-test.js
فشل الحارس: preview-shield: AssertionError [ERR_ASSERTION]: تحرك المعاينة تحت التنبيه يحجب دون تغيير DOM (movedPreviewUnderToast=false)
guard_exit=1
استعادة: node dist/preview-shield-bite/mutate.cjs restore
restored from isolated pristine copy
```

