// اختبار حي لمحرك التصدير: يصدّر storyboard عبر IPC حقيقي ثم يحلّل الملف الناتج.

import { exportStoryboard } from '../../src/ui/lib/promo-export/export.js';
import { probeExportSupport } from '../../src/ui/lib/promo-export/encode.js';
import { parseMp4 } from '../../src/ui/lib/promo-export/source-mp4.js';
import { createDecoderSource } from '../../src/ui/lib/promo-export/frame-source.js';
import { buildTimeline, sceneAt } from '../../src/ui/lib/promo/promo-timeline.js';
import { renderFrame } from '../../src/ui/lib/promo/promo-frame.js';

const COLORS = { background: '#0b0f14', captionBackground: 'rgba(0,0,0,0.62)', captionText: '#f4f6f8', accent: '#d9a441' };

const writer = {
  begin: () => window.satr.promoExportBegin(),
  chunk: (handle, seq, bytes) => window.satr.promoExportChunk(handle, seq, bytes),
  finish: (handle, header) => window.satr.promoExportFinish(handle, header),
  abort: (handle) => window.satr.promoExportAbort(handle),
};
const readAsset = (assetPath, offset, length) => window.satr.promoAssetRead(assetPath, offset, length);
const readerFor = (assetPath) => async (offset, length) => {
  const part = await readAsset(assetPath, offset, length);
  if (!part || !part.ok) throw new Error('read_failed');
  return part.bytes instanceof Uint8Array ? part.bytes : new Uint8Array(part.bytes);
};

window.__promoMakePng = (hue) => {
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 1600, 900);
  gradient.addColorStop(0, `hsl(${hue} 70% 30%)`); gradient.addColorStop(1, `hsl(${hue + 90} 70% 55%)`);
  context.fillStyle = gradient; context.fillRect(0, 0, 1600, 900);
  return canvas.toDataURL('image/png');
};

window.__promoExportSupport = () => probeExportSupport('16:9');

async function fonts() {
  await Promise.all([700, 500].map((weight) => document.fonts.load(weight + ' 48px "IBM Plex Sans Arabic"', 'ع A ٢')));
}

// يصدّر ويعيد النتيجة (بلا تحليل).
window.__promoExportRun = async (scenes, options) => {
  await fonts();
  const controller = new AbortController();
  let cancelAt = options && options.cancelAtFrame;
  const progressLog = [];
  try {
    const result = await exportStoryboard({
      scenes, aspect: '16:9', preset: (options && options.preset) || '1080p30', colors: COLORS, pointers: null,
      readAsset, writer, signal: controller.signal, acceleration: options && options.acceleration,
      onProgress: (value) => {
        progressLog.push(value.stage + ':' + value.frame);
        if (cancelAt && value.frame >= cancelAt) { cancelAt = 0; controller.abort(); }
      },
    });
    return { ok: true, result, progress: progressLog.length, lastProgress: progressLog[progressLog.length - 1] };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error), progress: progressLog.length };
  }
};

// يحلّل ملف التصدير: الفهرس، التشغيل، ومطابقة إطارات مختارة لرسم المعاينة.
window.__promoExportAnalyze = async (outputPath, outputUrl, scenes, sampleFrames) => {
  await fonts();
  const head = await readAsset(outputPath, 0, 0);
  if (!head || !head.ok) return { ok: false, error: 'output_unreadable' };
  const parsed = await parseMp4(readerFor(outputPath), head.size);
  const video = parsed.video, audio = parsed.audio;
  const lastVideo = video.samples[video.samples.length - 1];
  const report = {
    size: head.size, fragmented: parsed.fragmented, codec: video.codec, width: video.width, height: video.height,
    video_samples: video.samples.length, keyframes: video.samples.filter((sample) => sample.key).length,
    video_duration_ms: (lastVideo.ptsUs + lastVideo.durationUs) / 1000,
    audio_samples: audio ? audio.samples.length : 0,
    audio_duration_ms: audio ? (audio.samples[audio.samples.length - 1].ptsUs + audio.samples[audio.samples.length - 1].durationUs) / 1000 : 0,
    audio_rate: audio ? audio.sampleRate : 0,
  };
  // فروق الطوابع: كلها 1/30 ثانية بالضبط (لا إطار ساقط ولا مكرر)
  const steps = new Set();
  for (let i = 1; i < video.samples.length; i += 1) steps.add(video.samples[i].ptsUs - video.samples[i - 1].ptsUs);
  report.timestamp_steps_us = [...steps].sort((a, b) => a - b);
  // أول إزاحة عينة بعد الرأس: moov قبل mdat
  report.first_sample_offset = Math.min(video.samples[0].offset, audio ? audio.samples[0].offset : Infinity);

  // التشغيل حتى النهاية (بسرعة 4× لتقصير الاختبار)
  const element = document.createElement('video');
  element.muted = true; element.src = outputUrl;
  report.playback = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ended: false, reason: 'timeout', time: element.currentTime }), 20000);
    element.addEventListener('error', () => { clearTimeout(timer); resolve({ ended: false, reason: 'error', error: element.error && element.error.message }); });
    element.addEventListener('ended', () => { clearTimeout(timer); resolve({ ended: true, duration: element.duration, width: element.videoWidth, height: element.videoHeight }); });
    element.addEventListener('loadedmetadata', () => { element.playbackRate = 4; element.play().catch(() => {}); });
  });

  // مطابقة المعاينة: إطار التصدير i مقابل renderFrame عند الزمن نفسه بمصدر مفكوك مستقل.
  const timeline = buildTimeline({ scenes });
  const exported = await createDecoderSource(readerFor(outputPath), head.size);
  const width = video.width, height = video.height;
  const preview = document.createElement('canvas'); preview.width = width; preview.height = height;
  const decoded = document.createElement('canvas'); decoded.width = width; decoded.height = height;
  const runtime = { width, height, colors: COLORS, timeline, pointers: null, aspect: '16:9', voiceDurations: new Map() };
  const sources = new Map();
  const images = new Map();
  report.matches = [];
  for (const index of sampleFrames) {
    const tMs = index * 1000 / 30;
    const placement = sceneAt(timeline, tMs);
    const scene = placement.entry.scene;
    let frame;
    if (scene.asset_type === 'image') {
      if (!images.has(scene.src)) {
        const image = new Image(); image.src = scene.src; await image.decode(); images.set(scene.src, image);
      }
      const image = images.get(scene.src);
      frame = { source: image, width: image.naturalWidth, height: image.naturalHeight };
    } else {
      if (!sources.has(scene.asset)) {
        const size = (await readAsset(scene.asset, 0, 0)).size;
        sources.set(scene.asset, await createDecoderSource(readerFor(scene.asset), size));
      }
      const source = sources.get(scene.asset);
      frame = await source.frameAt(source.startUs + placement.sourceMs * 1000);
    }
    renderFrame(preview.getContext('2d', { alpha: false, willReadFrequently: true }), runtime, tMs, new Map([[placement.entry.index, frame]]));
    const out = await exported.frameAt(Math.round(index * 1e6 / 30));
    const context = decoded.getContext('2d', { alpha: false, willReadFrequently: true });
    context.drawImage(out.source, 0, 0, width, height);
    const a = preview.getContext('2d').getImageData(0, 0, width, height).data;
    const b = context.getImageData(0, 0, width, height).data;
    let close = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) < 40 && Math.abs(a[i + 1] - b[i + 1]) < 40 && Math.abs(a[i + 2] - b[i + 2]) < 40) close += 1;
    }
    report.matches.push({ frame: index, scene: placement.entry.index, ratio: Math.round(close / (a.length / 4) * 10000) / 10000, timestampUs: out.timestampUs });
  }
  exported.close();
  for (const source of sources.values()) source.close();
  return { ok: true, report };
};

// زر «صيّر» في مكوّن الاستوديو نفسه: المحرك الجديد أولاً، ثم المسار القديم حين يُجبَر.
window.__promoStudioExport = async (forceLegacy) => {
  await import('../../src/ui/components/promo-studio.js');
  let studio = document.querySelector('satr-promo-studio');
  if (!studio) { studio = document.createElement('satr-promo-studio'); document.body.appendChild(studio); }
  await studio.open();
  await studio.refreshExportSupport();
  const root = studio.shadowRoot;
  const quality = root.getElementById('quality');
  const options = [...quality.options].map((option) => [option.value, option.disabled]);
  studio.forceLegacyExport = !!forceLegacy;
  root.getElementById('approve').click();
  const cancelDuring = [];
  const timer = setInterval(() => cancelDuring.push(root.getElementById('cancel').hidden), 50);
  let result, error = '';
  try { result = await studio.render(); } catch (failure) { error = String(failure && failure.message || failure); }
  clearInterval(timer);
  return {
    error, engine: result && result.engine || (result && result.blob ? 'legacy' : ''), filename: result && result.filename, frames: result && result.frames,
    status: root.getElementById('status').textContent, options, qualityDisabled: quality.disabled,
    cancelShownWhileRendering: cancelDuring.includes(false), cancelHiddenAfter: root.getElementById('cancel').hidden,
    renderDisabledAfter: root.getElementById('render').disabled, scenes: studio.getStoryboard().scenes.length,
  };
};
