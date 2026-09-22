# أصول اختبار استوديو البرومو

هذان المقطعان مدخلان ثابتان لحارس `test:promo-studio`. وُلّدا محلياً مرة واحدة؛
`ffmpeg` أداة إنشاء للأصلين فقط وليست اعتمادية للاختبار أو المنتج.

```powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=#284b63:s=320x180:d=2:r=20 -vf drawbox=x=20+60*t:y=60:w=80:h=60:color=white:t=fill -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -y scripts/fixtures/promo-studio-clip-one.mp4
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=#6b3f52:s=320x180:d=2:r=20 -vf drawbox=x=220-60*t:y=60:w=80:h=60:color=white:t=fill -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -y scripts/fixtures/promo-studio-clip-two.mp4
```

كلاهما H.264، بأبعاد `320×180` ومعدل `20fps` ومدة `2.000s`.

| الملف | البايتات | SHA-256 |
|---|---:|---|
| `promo-studio-clip-one.mp4` | 2713 | `04503d41611a1415e3488daa5087480f0b56ecfbc7db87981e68ad4cf989a078` |
| `promo-studio-clip-two.mp4` | 2712 | `df7e2ab4eb13b420dc088bc7ca9b78de8eadc783d7b27a1d0674136d7524130a` |
