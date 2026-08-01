// بيانات ثابتة للقطات صفحة الهبوط: تستدعي مكوّنات الإنتاج نفسها عبر واجهاتها العامة.
(function () {
  const scene = new URLSearchParams(location.search).get('scene') || 'chat';
  document.body.dataset.scene = scene;

  function thumb(background, accent, label) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">' +
      '<rect width="640" height="640" fill="' + background + '"/>' +
      '<path d="M0 440L210 230l105 105 72-72 253 253v124H0z" fill="' + accent + '" opacity=".75"/>' +
      '<circle cx="480" cy="145" r="72" fill="' + accent + '" opacity=".9"/>' +
      '<text x="320" y="575" text-anchor="middle" font-family="Tahoma, sans-serif" font-size="34" fill="white">' + label + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name) => rootStyle.getPropertyValue(name).trim();
  const thumbs = {
    'generations/ramadan-campaign.png': thumb(token('--bg-deep'), token('--gold'), 'حملة رمضانية'),
    'generations/coffee-brand.png': thumb(token('--surface-3'), token('--red'), 'هوية قهوة'),
    'generations/book-cover.png': thumb(token('--surface-2'), token('--green'), 'غلاف عربي'),
  };

  const items = [
    {
      id: 'site_gen_1', kind: 'image', provider: 'openai', model: 'gpt-image-1', status: 'completed',
      prompt: 'مشهد رمضاني دافئ لفانوس ذهبي في فناء عربي، مساحة هادئة لعنوان الحملة',
      files: ['generations/ramadan-campaign.png'], cost_usd_estimate: 0.02, catalog_date: '2026-08-01',
    },
    {
      id: 'site_gen_2', kind: 'image', provider: 'openai', model: 'gpt-image-1', status: 'completed',
      prompt: 'هوية بصرية لمحمصة قهوة سعودية تجمع الخط العربي والملمس الورقي الدافئ',
      files: ['generations/coffee-brand.png'], cost_usd_estimate: 0.02, catalog_date: '2026-08-01',
    },
    {
      id: 'site_gen_3', kind: 'image', provider: 'openai', model: 'gpt-image-1', status: 'completed',
      prompt: 'غلاف كتاب عربي معاصر عن المدن والذاكرة، هندسة بسيطة ومساحات لونية هادئة',
      files: ['generations/book-cover.png'], cost_usd_estimate: 0.02, catalog_date: '2026-08-01',
    },
    {
      id: 'site_gen_4', kind: 'video', provider: 'fal', model: 'ltx-2-19b', status: 'completed',
      prompt: 'حركة كاميرا بطيئة بين أقواس سوق نجدي عند الغروب',
      files: ['generations/najdi-market.mp4'], cost_usd_estimate: 0.02, catalog_date: '2026-08-01',
    },
    {
      id: 'site_gen_5', kind: 'audio', provider: 'fal', model: 'stable-audio-2.5', status: 'completed',
      prompt: 'خلفية صوتية قصيرة بعود وإيقاع هادئ لفيلم علامة عربية',
      files: ['generations/brand-theme.mp3'], cost_usd_estimate: 0.002, catalog_date: '2026-08-01',
    },
  ];

  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target) { queueMicrotask(() => this.callback([{ target: target, isIntersecting: true }])); }
    unobserve() {}
    disconnect() {}
  };

  window.satr = {
    generationsList: async () => ({ ok: true, items: items.map((item) => ({ ...item })) }),
    genThumb: async (cwd, rel) => thumbs[rel] ? { ok: true, dataUrl: thumbs[rel] } : { ok: false, error: 'not_found' },
    permission: () => {},
    projectStatus: async () => ({ ok: true, hasCwd: true }),
  };

  async function render() {
    if (scene === 'chat') {
      await customElements.whenDefined('satr-chat');
      const chat = document.getElementById('generationChat');
      chat.addUserMsg('ولّد صورة لحملة رمضانية دافئة، بفانوس ذهبي وفناء عربي ومساحة للعنوان.');
      chat.addHistoryAssistant({ content: [{ type: 'text', text: 'صغت المشهد بالعربية وولّدته داخل المشروع.' }] }, 'Codex');
      chat.addGenerationCard({
        type: 'generation_done', kind: 'image', files: ['generations/ramadan-campaign.png'],
        cost_usd_estimate: 0.02, provider: 'openai', model: 'gpt-image-1',
      }, 'D:/fixture-project', () => {});
    } else if (scene === 'gallery') {
      await customElements.whenDefined('satr-gallery-panel');
      await document.getElementById('generationGallery').open('D:/fixture-project');
    } else if (scene === 'permission') {
      await customElements.whenDefined('satr-perm-dialog');
      document.getElementById('generationPermission').request({
        id: 'site-gen-permission', tool: 'generate_media', turnEligible: true,
        detail: 'توليد صورة عبر GPT Image\nالكلفة التقديرية قبل التنفيذ: $0.02 للصورة\nسعر مقيس بتاريخ الكتالوج: 2026-08-01\nسيُحفظ الملف داخل generations/',
      });
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__shotsReady = true;
  }

  document.addEventListener('DOMContentLoaded', () => { render().catch((error) => {
    window.__shotsError = error && error.stack ? error.stack : String(error);
  }); });
})();
