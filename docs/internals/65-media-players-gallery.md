### مشغّلا الوسائط في المعرض (الجولة 10 §3 — kimi-code)

المؤجل الموثق («المعاينة/المشغّل يأتي لاحقاً») نُفّذ. العقد القانوني في
`docs/GENERATION-PLAN.md` §3 (v3). بطاقة التوليد في المحادثة (chat.js) لم تُلمس —
تبقى معلومات + فتح المعرض.
- **IPC `satr:genMedia {cwd, rel}` → `{ok, dataUrl, mime}`**: كتلة موضعية معلَّمة
  في `electron/main.js` (بين «كتلة genMedia»/«نهاية كتلة genMedia») تنسخ نمط
  genThumb حرفياً — `safeGenerationRel(cwd, rel, true)` (داخل `generations/`
  حصراً) + `realpathSync` (traversal/symlink مرفوضان) + قائمة سماح امتدادات
  `{mp4, webm, wav, mp3}` (النوع من الامتداد — لا اشتقاق من المحتوى) + سقف
  **24MiB** ⇒ `bad_path`/`bad_size`/`read_failed`. preload يكشف `genMedia(cwd,
  rel)` المحددة فقط (سطر واحد). لا حدث جديد ولا بث.
- **المشغّلان (gallery-panel.js)**: بطاقتا الفيديو/الصوت معلومات + زر «▶ شغّل
  المعاينة»/«▶ شغّل المقطع» — `genMedia` عند النقر فقط (كسل صارم، لا تحميل
  مسبق)، ثم Blob ← objectURL ← `<video/audio controls>`. فكّ base64 يدوي
  (atob→Uint8Array) لا fetch — ‏`connect-src 'none'` في fixtures. الفشل/تجاوز
  السقف ⇒ بطاقة المعلومات القائمة + «تعذّر تحميل المعاينة» صراحةً.
  `revokeObjectURL` عند إغلاق اللوحة/إعادة فتحها/إزالتها (Set في `_mediaUrls`
  تُسحب في close/open/disconnectedCallback). قرار موثّق: لا معالج لخطأ فكّ
  الترميز — عنصر الوسائط الأصيل يعرض حالته بنفسه، ورسالتنا الصريحة لطور
  الجلب/السقف. سطح المشغّل --bg-deep (لا نص فوقه — لا جزيرة)، وأزرار التشغيل
  والنصوص على --surface-3 المُقلبة (إصلاح ج9).
- **الاختبار**: `test:gallery` كسب فحوص `media-lazy-no-preload` ·
  `video-player-lazy` · `audio-player-lazy` · `media-oversize-rejected` ·
  `media-path-ext-rejected` · `media-revoke-on-close` (عدّاد createObjectURL/
  revokeObjectURL يثبت التساوي) + فحص ساكن لكتلة main.js والسطر في preload
  (نمط assertStaticContract). وسائط fixture حقيقية مولّدة بـ ffmpeg (mp4 ‏0.5ث
  ‏5734 بايت · mp3 ‏2421 بايت) — وElectron الفعلي فكّ ترميز H.264 وعرض الإطار.
  مشاهد ui:audit ‏37 (داكن) و38 (فاتح مقاس): زر التشغيل 12.94:1 · نص بطاقة
  الصوت 4.31:1 آنذاك (صار 5.11:1 عبر --media-note في جولة الصقل 2026-08-08) ·
  المشغّلان بُنيا بـ blob: وcontrols.
