---
paths:
  - "electron/genmedia.js"
  - "electron/promostudio.js"
  - "electron/promocapture.js"
  - "src/ui/components/gallery-panel.js"
  - "src/ui/components/promo-studio.js"
  - "src/ui/lib/media-recorder.js"
  - "src/ui/lib/promo-renderer.js"
---

# media — اقرأ قبل أن تلمس

هذه الملفات لها سجلّ معماري مفصّل (دفعات، قرارات، دروس مقيسة) نُقل من `CLAUDE.md` إلى
`docs/internals/`. **قبل تعديلها اقرأ ما يخصّ تغييرك من القائمة، ووثّق دفعتك الجديدة في الملف المعني:**

- `docs/internals/35-media-generation-core.md` — نواة توليد الوسائط BYOK (م١ — الجولة 8، البند الأول)
- `docs/internals/36-media-generation-extension.md` — توسعة نواة التوليد (الجولة 9 — الصوت وrefs وافتراضي الصور وحارس المنزل)
- `docs/internals/37-audio-durations-ad-music.md` — مدد الصوت وموسيقى الإعلان المولَّدة (الجولة 10 — أولى دفعات م٢)
- `docs/internals/38-ad-music-quality-round.md` — جولة جودة موسيقى الإعلان بعد الرفض السمعي (الجولة 10 التكميلي)
- `docs/internals/47-generate-media-tool-gallery.md` — أداة توليد الوسائط وقنوات المعرض — الجولة 8
- `docs/internals/48-generation-done-event-skill.md` — حدث اكتمال التوليد ومهارة `satr-generate` — الجولة 9
- `docs/internals/63-generations-gallery-panel.md` — لوحة معرض التوليدات 🖼 (الجولة 8 من «ولّد من سطر» — kimi-code)
- `docs/internals/64-generation-cards-chat.md` — بطاقة التوليد في المحادثة وبطاقة الصوت (الجولة 9 §2/§4 — kimi-code)
- `docs/internals/65-media-players-gallery.md` — مشغّلا الوسائط في المعرض (الجولة 10 §3 — kimi-code)
