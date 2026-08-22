window.__promoStudioPreviewReady = (async () => {
  window.__promoStudioPreviewStep = 'setup';

  function makeColorImage(color) {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  const imagePath = 'C:\\Downloads\\preview-image.png';
  const imageUrl = makeColorImage('#000000');
  const downloads = ['C:\\Downloads\\preview-image.png'];

  window.satr = {
    promoStudioState: async () => ({ ok: true, storyboard: null, segments: [] }),
    promoAssetUrl: async (assetPath) => assetPath === imagePath ? { ok: true, url: imageUrl } : { ok: false },
    promoListDownloads: async () => ({ ok: true, files: downloads.map((path) => ({ name: path.split('\\').pop(), path, type: 'image' })) }),
    promoProjectPick: async (kind) => ({ ok: true, path: 'C:\\Downloads\\test.satr-promo.json' }),
    promoProjectSave: async (path, storyboard) => ({ ok: true, path }),
    promoProjectLoad: async (path) => ({ ok: true, storyboard: { aspect: '16:9', scenes: [
      { asset: imagePath, asset_type: 'image', caption: 'عنوان محمّل', duration_ms: 3000 },
    ] }, missing: [] }),
    promoCaptureStart: async () => ({ ok: true }),
    promoCaptureStop: async () => ({ ok: true }),
    onPromoCapture(callback) { return () => {}; },
  };

  await import('../../src/ui/components/promo-studio.js');
  const studio = document.querySelector('satr-promo-studio');
  studio.setStoryboard({ aspect: '16:9', scenes: [
    { id: 'scene_1', asset: imagePath, asset_type: 'image', caption: 'عنوان المعاينة', duration_ms: 1000, transition: 'cut' },
  ] });
  await studio.open(studio.getStoryboard());
  window.__promoStudioPreviewStep = 'opened';

  const root = studio.shadowRoot;
  const canvas = root.getElementById('canvas');

  // انتظار رسم الإطار الأول
  await studio.drawPreview();
  await new Promise((resolve) => setTimeout(resolve, 300));

  function samplePixel(x, y) {
    const context = canvas.getContext('2d', { alpha: false });
    return context.getImageData(x, y, 1, 1).data;
  }

  function isCaptionColor(data) {
    // نص أبيض/فاتح على خلفية داكنة
    return data[0] > 200 && data[1] > 200 && data[2] > 200;
  }

  function scanCaptionRegion(centerRatio) {
    const context = canvas.getContext('2d', { alpha: false });
    const start = Math.max(0, Math.round(canvas.height * (centerRatio - 0.05)));
    const end = Math.min(canvas.height, Math.round(canvas.height * (centerRatio + 0.05)));
    for (let y = start; y < end; y += 2) {
      const row = context.getImageData(0, y, canvas.width, 1).data;
      for (let index = 0; index < row.length; index += 4) {
        if (row[index] > 200 && row[index + 1] > 200 && row[index + 2] > 200) return true;
      }
    }
    return false;
  }

  if (!scanCaptionRegion(0.88)) throw new Error('preview_blank_at_start: ' + window.__lastPreviewError);
  window.__promoStudioPreviewStep = 'first_frame';

  // تغيير موضع العنوان وانتظار إعادة الرسم
  const position = root.querySelector('.scene[data-index="0"] .caption-position');
  position.value = 'top';
  position.dispatchEvent(new Event('change', { bubbles: true }));
  await studio.drawPreview();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hasTop = scanCaptionRegion(0.12);

  position.value = 'bottom';
  position.dispatchEvent(new Event('change', { bubbles: true }));
  await studio.drawPreview();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hasBottom = scanCaptionRegion(0.88);

  if (!hasTop || !hasBottom) {
    throw new Error('preview_did_not_reflect_position_change: top=' + hasTop + ' bottom=' + hasBottom + ' err=' + window.__lastPreviewError);
  }
  window.__promoStudioPreviewStep = 'position_change';

  // السحب الزمني
  const scrub = root.getElementById('scrubRange');
  scrub.value = '500';
  scrub.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (root.getElementById('scrubTime').textContent.indexOf('0.5') === -1) {
    throw new Error('scrub_time_not_updated');
  }
  window.__promoStudioPreviewStep = 'scrub';

  // فتح حوار الاستيراد والاختيار
  root.getElementById('import').click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const list = root.getElementById('importList');
  if (!list.querySelector('.import-item')) throw new Error('import_list_empty');
  list.querySelector('.import-item').click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const storyboard = studio.getStoryboard();
  if (storyboard.scenes.length !== 2) throw new Error('import_did_not_add_scene:' + storyboard.scenes.length);
  window.__promoStudioPreviewStep = 'import';

  // حفظ وفتح المشروع
  root.getElementById('projectSave').click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  studio.setStoryboard({ aspect: '16:9', scenes: [] });
  root.getElementById('projectOpen').click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const loaded = studio.getStoryboard();
  if (loaded.scenes.length !== 1 || loaded.scenes[0].caption !== 'عنوان محمّل') {
    throw new Error('project_load_failed');
  }
  window.__promoStudioPreviewStep = 'project';

  return { ok: true, scenes: loaded.scenes.length };
})();
