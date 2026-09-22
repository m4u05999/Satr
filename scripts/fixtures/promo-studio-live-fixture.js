window.__promoStudioReady = (async () => {
  window.__promoStudioStep = 'setup';
  const urls = new Map();
  const callbacks = [];
  let captureStarts = 0;
  window.satr = {
    promoStudioState: async () => ({ ok: true, storyboard: null, segments: [] }),
    promoAssetUrl: async (assetPath) => urls.has(assetPath) ? { ok: true, url: urls.get(assetPath) } : { ok: false },
    promoCaptureStart: async () => { captureStarts += 1; return { ok: true }; },
    promoCaptureStop: async () => ({ ok: true }),
    onPromoCapture(callback) { callbacks.push(callback); return () => {}; },
  };

  async function verifyClip(label, source) {
    if (!source) throw new Error('fixture_video_missing:' + label);
    const video = document.createElement('video');
    video.muted = true; video.preload = 'auto';
    try {
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture_video_timeout:' + label)), 5000);
        video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('fixture_video_decode_failed:' + label + ':' + (video.error ? video.error.code : 'unknown')));
        }, { once: true });
      });
      video.src = source; video.load();
      await loaded;
      const info = { label, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      window.__fixtureClipInfo = [...(window.__fixtureClipInfo || []), info];
      if (!Number.isFinite(info.duration) || info.duration < 1.5 || !info.width || !info.height) {
        throw new Error('fixture_video_too_short:' + label + ':' + JSON.stringify(info));
      }
    } finally {
      video.removeAttribute('src'); video.load(); video.remove();
    }
  }
  function makeWav() {
    const sampleRate = 8000; const samples = 4000; const buffer = new ArrayBuffer(44 + samples * 2); const view = new DataView(buffer);
    const write = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index += 1) view.setInt16(44 + index * 2, Math.sin(index / 12) * 5000, true);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  const paths = { first: 'C:\\Downloads\\first.mp4', second: 'C:\\Downloads\\second.mp4',
    music: 'C:\\Downloads\\music.wav', voice: 'C:\\Downloads\\voice.wav' };
  const query = new URL(location.href).searchParams;
  const sources = { first: query.get('first'), second: query.get('second') };
  await Promise.all([verifyClip('ONE', sources.first), verifyClip('TWO', sources.second)]);
  urls.set(paths.first, sources.first); urls.set(paths.second, sources.second);
  window.__promoStudioStep = 'fixture_clips';
  urls.set(paths.music, query.get('music') || makeWav());
  urls.set(paths.voice, urls.get(paths.music));
  await import('../../src/ui/components/promo-studio.js');
  const studio = document.querySelector('satr-promo-studio');
  studio.setStoryboard({ aspect: '16:9', scenes: [
    { id: 'scene_1', asset: paths.first, asset_type: 'video', caption: 'العنوان الأول', duration_ms: 500, transition: 'cut', music: paths.music, voice: paths.voice },
    { id: 'scene_2', asset: paths.second, asset_type: 'video', caption: 'العنوان الثاني', duration_ms: 500, transition: 'fade', music: paths.music },
  ] });
  await studio.open(studio.getStoryboard());
  const root = studio.shadowRoot;
  const firstCaption = root.querySelector('.scene[data-index="0"] .caption');
  firstCaption.value = 'عنوان عربي مُحرّر'; firstCaption.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('.scene[data-index="0"] button[data-action="down"]').click();
  const duration = root.querySelector('.scene[data-index="0"] .duration');
  duration.value = '650'; duration.dispatchEvent(new Event('change', { bubbles: true }));
  const trim = root.querySelector('.scene[data-index="0"] .trim');
  trim.value = '100'; trim.dispatchEvent(new Event('change', { bubbles: true }));
  const fit = root.querySelector('.scene[data-index="0"] .fit');
  fit.value = 'contain'; fit.dispatchEvent(new Event('change', { bubbles: true }));
  const position = root.querySelector('.scene[data-index="0"] .caption-position');
  position.value = 'top'; position.dispatchEvent(new Event('change', { bubbles: true }));
  const style = root.querySelector('.scene[data-index="0"] .caption-style');
  style.value = 'minimal'; style.dispatchEvent(new Event('change', { bubbles: true }));
  for (const [field, value] of [['clip_volume', '0.7'], ['music_volume', '0.2'], ['voice_volume', '0.8']]) {
    const control = root.querySelector(`.scene[data-index="0"] input[type="number"][data-field="${field}"]`);
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const musicSelect = root.querySelector('.scene[data-index="0"] .music');
  musicSelect.value = ''; musicSelect.dispatchEvent(new Event('change', { bubbles: true }));
  root.querySelector('.scene[data-index="0"] button[data-action="duplicate"]').click();
  const totalLabel = root.getElementById('status').textContent;
  root.querySelector('.scene[data-index="0"] button[data-action="rerecord"]').click();
  const edited = studio.getStoryboard();
  if (edited.scenes.length !== 3 || edited.scenes[0].asset !== paths.second || edited.scenes[2].caption !== 'عنوان عربي مُحرّر'
      || edited.scenes[0].duration_ms !== 650 || edited.scenes[0].music !== '' || captureStarts !== 1) {
    throw new Error('timeline_edit_failed');
  }
  const duplicated = edited.scenes[1].id !== edited.scenes[0].id && edited.scenes[1].id.includes('_copy_');
  const advancedControls = edited.scenes[0].trim_start_ms === 100 && edited.scenes[0].fit === 'contain'
    && edited.scenes[0].caption_position === 'top' && edited.scenes[0].caption_style === 'minimal'
    && edited.scenes[0].clip_volume === 0.7 && edited.scenes[0].music_volume === 0.2
    && edited.scenes[0].voice_volume === 0.8;
  if (!root.getElementById('render').disabled) throw new Error('approval_gate_failed');
  root.getElementById('approve').click();
  if (root.getElementById('render').disabled) throw new Error('approval_gate_failed');
  root.getElementById('render').click();
  window.__promoStudioStep = 'rendering';
  const renderResult = await studio.lastRenderPromise;
  const result = { ...renderResult, blob: undefined, bytes: renderResult.blob.size,
    filename: 'satr-promo-final-test.' + renderResult.format.ext };
  window.__promoStudioResult = {
    ...result,
    reordered: edited.scenes[0].asset === paths.second,
    editedCaption: edited.scenes[2].caption,
    editedDuration: edited.scenes[0].duration_ms,
    musicChanged: edited.scenes[0].music === '',
    duplicated,
    advancedControls,
    totalLabel,
    captureStarts,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
  };
  return window.__promoStudioResult;
})();
