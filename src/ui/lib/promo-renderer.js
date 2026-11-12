import { pickRecMime } from './media-recorder.js';
import { buildTimeline } from './promo/promo-timeline.js';
import { renderFrame, drawCaption } from './promo/promo-frame.js';

// drawCaption يبقى مُصدَّراً من هنا لمن يستورده من المسار القديم.
export { drawCaption };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const level = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

function once(target, event, timeoutMs = 15000, label = 'media') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('media_timeout')), timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    const fail = () => { clearTimeout(timer); reject(new Error(label + '_failed')); };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

async function loadVisual(scene) {
  if (scene.asset_type === 'image') {
    const image = new Image();
    image.decoding = 'async';
    image.src = scene.src;
    if (!image.complete) await once(image, 'load', 15000, 'image');
    return { kind: 'image', element: image, width: image.naturalWidth, height: image.naturalHeight, cleanup() {} };
  }
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = scene.src;
  video.load();
  if (video.readyState < 2) await once(video, 'loadeddata', 15000, 'video');
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const requested = Math.max(0, Number(scene.trim_start_ms) || 0) / 1000;
  const startTime = duration > 0 ? Math.min(requested, Math.max(0, duration - 0.1)) : 0;
  if (startTime > 0.001) {
    video.currentTime = startTime;
    await once(video, 'seeked', 15000, 'seek');
  }
  return {
    kind: 'video', element: video, width: video.videoWidth, height: video.videoHeight, startTime,
    cleanup() { try { video.pause(); } catch (error) {} video.removeAttribute('src'); video.load(); },
  };
}

async function loadAudio(src) {
  if (!src) return null;
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.src = src;
  audio.load();
  if (audio.readyState < 2) await once(audio, 'loadeddata', 15000, 'audio');
  return audio;
}

function mediaStop(recorder) {
  return new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
}

export async function renderStoryboard(options) {
  const settings = options || {};
  const canvas = settings.canvas;
  const scenes = Array.isArray(settings.scenes) ? settings.scenes : [];
  if (!(canvas instanceof HTMLCanvasElement) || !scenes.length) throw new Error('bad_storyboard');
  const context = canvas.getContext('2d', { alpha: false });
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!context || !AudioContextClass || typeof canvas.captureStream !== 'function') throw new Error('media_unavailable');
  const fps = Number.isInteger(settings.fps) ? Math.max(10, Math.min(60, settings.fps)) : 30;
  const colors = settings.colors || { background: 'black', captionBackground: 'black', captionText: 'white' };
  const audioContext = new AudioContextClass();
  await audioContext.resume();
  const mix = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  mix.connect(destination);
  const stream = canvas.captureStream(fps);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  const format = pickRecMime();
  const recorderOptions = { videoBitsPerSecond: canvas.width >= 1920 || canvas.height >= 1920 ? 16000000 : 10000000 };
  if (format.mime) recorderOptions.mimeType = format.mime;
  const recorder = new MediaRecorder(stream, recorderOptions);
  const chunks = [];
  recorder.addEventListener('dataavailable', (event) => { if (event.data && event.data.size) chunks.push(event.data); });
  recorder.start(1000);
  let captionsRendered = 0;
  let audioSources = 0;
  let trimmedScenes = 0;
  let containedScenes = 0;
  // المسار القديم يسير بالساعة الحقيقية، لكن الرسم نفسه يمر بـrenderFrame الحتمية.
  const timeline = buildTimeline({ scenes });
  const runtime = { width: canvas.width, height: canvas.height, colors, timeline, pointers: settings.pointers || null,
    aspect: settings.aspect || '16:9', voiceDurations: new Map() };
  const totalMs = timeline.totalMs;
  let completedMs = 0;
  try {
    for (let index = 0; index < scenes.length; index += 1) {
      if (settings.signal && settings.signal.aborted) throw new Error('render_cancelled');
      const scene = scenes[index];
      let visual = null;
      let music = null;
      let voice = null;
      const nodes = [];
      try {
        visual = await loadVisual(scene);
        music = await loadAudio(scene.musicSrc);
        voice = await loadAudio(scene.voiceSrc);
        // مدة التعليق تحدد توقيت الترجمة على الشاشة.
        if (voice && Number.isFinite(voice.duration)) runtime.voiceDurations.set(index, voice.duration * 1000);
        if (visual.kind === 'video') {
          const source = audioContext.createMediaElementSource(visual.element);
          const gain = audioContext.createGain();
          gain.gain.value = level(scene.clip_volume, 1);
          source.connect(gain).connect(mix);
          nodes.push(source, gain);
          audioSources += 1;
          await visual.element.play();
        }
        if (music) {
          const source = audioContext.createMediaElementSource(music);
          const gain = audioContext.createGain();
          gain.gain.value = level(scene.music_volume, 0.34);
          source.connect(gain).connect(mix);
          nodes.push(source, gain);
          audioSources += 1;
          music.currentTime = 0;
          await music.play();
        }
        if (voice) {
          const source = audioContext.createMediaElementSource(voice);
          const gain = audioContext.createGain();
          gain.gain.value = level(scene.voice_volume, 1);
          source.connect(gain).connect(mix);
          nodes.push(source, gain);
          audioSources += 1;
          voice.currentTime = 0;
          await voice.play();
        }
        if (Number(scene.trim_start_ms) > 0) trimmedScenes += 1;
        if (scene.fit === 'contain') containedScenes += 1;
        const frames = new Map([[index, { source: visual.element, width: visual.width, height: visual.height }]]);
        const startedAt = performance.now();
        while (true) {
          if (settings.signal && settings.signal.aborted) throw new Error('render_cancelled');
          const elapsed = performance.now() - startedAt;
          if (elapsed >= scene.duration_ms) break;
          // الحد الأعلى يمنع انزلاق آخر إطار إلى المشهد التالي عند حافة المدة.
          const drawnFrame = renderFrame(context, runtime, completedMs + Math.min(elapsed, scene.duration_ms - 0.001), frames);
          if (drawnFrame && drawnFrame.captionLines) captionsRendered += 1;
          if (typeof settings.onProgress === 'function') {
            settings.onProgress({ index, elapsed_ms: Math.min(totalMs, completedMs + elapsed), total_ms: totalMs });
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        completedMs += scene.duration_ms;
      } finally {
        if (visual) visual.cleanup();
        if (music) { music.pause(); music.removeAttribute('src'); music.load(); }
        if (voice) { voice.pause(); voice.removeAttribute('src'); voice.load(); }
        for (const node of nodes) { try { node.disconnect(); } catch (error) {} }
      }
    }
    await wait(120);
    await mediaStop(recorder);
    const blob = new Blob(chunks, { type: format.container });
    if (!blob.size) throw new Error('empty_render');
    return { blob, format, duration_ms: totalMs, scenes_rendered: scenes.length,
      captions_rendered: captionsRendered, caption_direction: 'rtl', audio_sources: audioSources,
      trimmed_scenes: trimmedScenes, contained_scenes: containedScenes, mixed_audio_sources: audioSources };
  } catch (error) {
    if (recorder.state !== 'inactive') await mediaStop(recorder);
    throw error;
  } finally {
    for (const track of stream.getTracks()) { try { track.stop(); } catch (error) {} }
    await audioContext.close().catch(() => {});
  }
}
