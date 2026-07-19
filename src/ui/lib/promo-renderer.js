import { pickRecMime } from './media-recorder.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return {
    kind: 'video', element: video, width: video.videoWidth, height: video.videoHeight,
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

function drawCover(context, element, sourceWidth, sourceHeight, width, height, alpha = 1) {
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(element, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  context.restore();
}

function wrapCaption(context, caption, maxWidth) {
  const words = String(caption || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (line && context.measureText(candidate).width > maxWidth) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export function drawCaption(context, caption, width, height, colors) {
  if (!caption) return 0;
  const fontSize = Math.max(30, Math.round(height * 0.052));
  const lineHeight = Math.round(fontSize * 1.45);
  const padding = Math.round(fontSize * 0.72);
  context.save();
  context.direction = 'rtl';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.font = `700 ${fontSize}px "IBM Plex Sans Arabic", sans-serif`;
  const lines = wrapCaption(context, caption, width * 0.78);
  if (!lines.length) { context.restore(); return 0; }
  const boxHeight = lines.length * lineHeight + padding * 2;
  const boxWidth = Math.min(width * 0.88, Math.max(...lines.map((line) => context.measureText(line).width)) + padding * 2);
  const x = width - Math.round(width * 0.06);
  const y = height - Math.round(height * 0.07) - boxHeight;
  context.fillStyle = colors.captionBackground;
  context.fillRect(x - boxWidth, y, boxWidth, boxHeight);
  context.fillStyle = colors.captionText;
  lines.forEach((line, index) => context.fillText(line, x - padding, y + padding + lineHeight * (index + 0.5)));
  context.restore();
  return lines.length;
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
  const totalMs = scenes.reduce((sum, scene) => sum + scene.duration_ms, 0);
  let completedMs = 0;
  try {
    for (let index = 0; index < scenes.length; index += 1) {
      if (settings.signal && settings.signal.aborted) throw new Error('render_cancelled');
      const scene = scenes[index];
      const visual = await loadVisual(scene);
      const music = await loadAudio(scene.musicSrc);
      const voice = await loadAudio(scene.voiceSrc);
      const nodes = [];
      if (visual.kind === 'video') {
        const source = audioContext.createMediaElementSource(visual.element);
        const gain = audioContext.createGain();
        gain.gain.value = 1;
        source.connect(gain).connect(mix);
        nodes.push(source, gain);
        audioSources += 1;
        visual.element.currentTime = 0;
        await visual.element.play();
      }
      if (music) {
        const source = audioContext.createMediaElementSource(music);
        const gain = audioContext.createGain();
        gain.gain.value = 0.34;
        source.connect(gain).connect(mix);
        nodes.push(source, gain);
        audioSources += 1;
        music.currentTime = 0;
        await music.play();
      }
      if (voice) {
        const source = audioContext.createMediaElementSource(voice);
        const gain = audioContext.createGain();
        gain.gain.value = 1;
        source.connect(gain).connect(mix);
        nodes.push(source, gain);
        audioSources += 1;
        voice.currentTime = 0;
        await voice.play();
      }
      const startedAt = performance.now();
      while (true) {
        if (settings.signal && settings.signal.aborted) throw new Error('render_cancelled');
        const elapsed = performance.now() - startedAt;
        if (elapsed >= scene.duration_ms) break;
        context.fillStyle = colors.background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        drawCover(context, visual.element, visual.width, visual.height, canvas.width, canvas.height);
        if (scene.transition === 'fade') {
          const edge = Math.min(500, scene.duration_ms / 3);
          const opacity = elapsed < edge ? 1 - elapsed / edge
            : elapsed > scene.duration_ms - edge ? 1 - (scene.duration_ms - elapsed) / edge : 0;
          if (opacity > 0) {
            context.save(); context.globalAlpha = opacity; context.fillStyle = colors.background;
            context.fillRect(0, 0, canvas.width, canvas.height); context.restore();
          }
        }
        if (drawCaption(context, scene.caption, canvas.width, canvas.height, colors)) captionsRendered += 1;
        if (typeof settings.onProgress === 'function') {
          settings.onProgress({ index, elapsed_ms: Math.min(totalMs, completedMs + elapsed), total_ms: totalMs });
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      completedMs += scene.duration_ms;
      if (visual.kind === 'video') visual.element.pause();
      if (music) { music.pause(); music.removeAttribute('src'); music.load(); }
      if (voice) { voice.pause(); voice.removeAttribute('src'); voice.load(); }
      for (const node of nodes) { try { node.disconnect(); } catch (error) {} }
      visual.cleanup();
    }
    await wait(120);
    await mediaStop(recorder);
    const blob = new Blob(chunks, { type: format.container });
    if (!blob.size) throw new Error('empty_render');
    return { blob, format, duration_ms: totalMs, scenes_rendered: scenes.length,
      captions_rendered: captionsRendered, caption_direction: 'rtl', audio_sources: audioSources };
  } catch (error) {
    if (recorder.state !== 'inactive') await mediaStop(recorder);
    throw error;
  } finally {
    for (const track of stream.getTracks()) { try { track.stop(); } catch (error) {} }
    await audioContext.close().catch(() => {});
  }
}
