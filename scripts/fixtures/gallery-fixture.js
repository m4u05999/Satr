// بيانات fixture مشتركة للوحة معرض التوليدات (الجولة 8): تستعملها صفحة الاختبار
// الحي (gallery-live-page.js عبر window.SATR_GALLERY_FIXTURE) ومشهدا ui:audit
// (عبر require). سجلات بصيغة v1 من العقد المجمَّد §1، ومصغرات SVG data URL
// بديلة عن genThumb (القناة الحقيقية تُضاف عند الدمج).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SATR_GALLERY_FIXTURE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // مصغرة SVG ملوّنة بعنوان — data URL جاهزة للصق في <img src>
  function thumb(color, label) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">' +
      '<rect width="240" height="240" fill="' + color + '"/>' +
      '<circle cx="120" cy="100" r="46" fill="rgba(255,255,255,0.35)"/>' +
      '<text x="120" y="205" font-family="monospace" font-size="20" text-anchor="middle" fill="#ffffff">' +
      label + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  const items = [
    {
      id: 'gen_1754000001_a1', at: '2026-08-01T05:00:01.000Z', kind: 'image',
      provider: 'fal', model: 'flux-schnell',
      prompt: 'شعار دائري لمنصة كتابة عربية باسم «سطر»، بأسلوب خط الثلث وذهبي على كحلي',
      refs: [], files: ['generations/satr-logo-1.png'],
      cost_usd_estimate: 0.003, catalog_date: '2026-08-01', status: 'completed',
    },
    {
      id: 'gen_1754000002_b2', at: '2026-08-01T05:10:02.000Z', kind: 'image',
      provider: 'openai', model: 'gpt-image-1',
      prompt: 'isometric illustration of a cozy Arabic coffee corner with a laptop, warm light — ركن قهوة عربي مع حاسوب',
      refs: [], files: ['generations/coffee-corner.png'],
      cost_usd_estimate: 0.04, catalog_date: '2026-08-01', status: 'completed',
    },
    {
      id: 'gen_1754000003_c3', at: '2026-08-01T05:20:03.000Z', kind: 'video',
      provider: 'fal', model: 'kling-v2.1',
      prompt: 'لقطة جوية بطيئة لسوق عربي قديم عند الغروب',
      refs: [], files: ['generations/souq-aerial.mp4'],
      cost_usd_estimate: 0.35, catalog_date: '2026-08-01', status: 'completed',
    },
    {
      id: 'gen_1754000004_d4', at: '2026-08-01T05:30:04.000Z', kind: 'image',
      provider: 'gemini', model: 'imagen-4',
      prompt: 'خلفية سطح مكتب بزخارف هندسية إسلامية هادئة',
      refs: [], files: [],
      cost_usd_estimate: 0, catalog_date: '2026-08-01', status: 'failed', error_code: 'over_budget',
    },
  ];

  const thumbs = {
    'generations/satr-logo-1.png': thumb('#1f3a5f', 'logo'),
    'generations/coffee-corner.png': thumb('#7a4a1e', 'coffee'),
  };

  return { items: items, thumbs: thumbs };
});
