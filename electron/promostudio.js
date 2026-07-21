'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const promocapture = require('./promocapture');

const MAX_SCENES = 40;
const MAX_CAPTION = 500;
const MIN_DURATION_MS = 250;
const MAX_DURATION_MS = 120000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm', '.mp4']);
const TRANSITIONS = new Set(['cut', 'fade']);
const FITS = new Set(['cover', 'contain']);
const CAPTION_POSITIONS = new Set(['top', 'center', 'bottom']);
const CAPTION_STYLES = new Set(['box', 'minimal']);
const DEFAULT_CLIP_VOLUME = 1;
const DEFAULT_MUSIC_VOLUME = 0.34;
const DEFAULT_VOICE_VOLUME = 1;

function localAsset(downloadsPath, candidate, extensions, exists = fs.existsSync, realpath) {
  if (typeof candidate !== 'string' || candidate.length > 4096 || !path.isAbsolute(candidate)
      || !promocapture.isInsideDownloads(downloadsPath, candidate)) return '';
  const resolved = path.resolve(candidate);
  if (!extensions.has(path.extname(resolved).toLowerCase()) || !exists(resolved)) return '';
  if (typeof realpath !== 'function') return resolved;
  try {
    const canonicalRoot = realpath(path.resolve(downloadsPath));
    const canonicalAsset = realpath(resolved);
    return promocapture.isInsideDownloads(canonicalRoot, canonicalAsset) ? canonicalAsset : '';
  } catch { return ''; }
}

function isSafeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value);
}

function cleanInt(value, min, max, defaultValue) {
  if (!Number.isInteger(value)) return defaultValue;
  if (!Number.isFinite(value) || Number.isNaN(value)) return defaultValue;
  if (value < min || value > max) return defaultValue;
  return value;
}

function cleanFloat(value, min, max, defaultValue) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return defaultValue;
  if (value < min || value > max) return defaultValue;
  return value;
}

function cleanEnum(value, allowed, defaultValue) {
  return allowed.has(value) ? value : defaultValue;
}

function sanitizeStoryboard(input, options) {
  const settings = options || {};
  const downloadsPath = settings.downloadsPath;
  const exists = typeof settings.exists === 'function' ? settings.exists : fs.existsSync;
  const rawScenes = input && Array.isArray(input.scenes) ? input.scenes : [];
  if (!rawScenes.length || rawScenes.length > MAX_SCENES) return { ok: false, error: 'bad_scenes' };
  const scenes = [];
  for (let index = 0; index < rawScenes.length; index += 1) {
    const raw = rawScenes[index] && typeof rawScenes[index] === 'object' ? rawScenes[index] : {};
    const candidate = typeof raw.segment_path === 'string' ? raw.segment_path : raw.asset;
    const asset = localAsset(downloadsPath, candidate, new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]), exists, settings.realpath);
    if (!asset) return { ok: false, error: 'bad_asset', index };
    const music = raw.music == null || raw.music === '' ? ''
      : localAsset(downloadsPath, raw.music, AUDIO_EXTENSIONS, exists, settings.realpath);
    if (raw.music && !music) return { ok: false, error: 'bad_music', index };
    const voice = raw.voice == null || raw.voice === '' ? ''
      : localAsset(downloadsPath, raw.voice, AUDIO_EXTENSIONS, exists, settings.realpath);
    if (raw.voice && !voice) return { ok: false, error: 'bad_voice', index };
    const durationMs = Number.isInteger(raw.duration_ms) ? raw.duration_ms : 3000;
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      return { ok: false, error: 'bad_duration', index };
    }
    const caption = typeof raw.caption === 'string' ? raw.caption.trim().slice(0, MAX_CAPTION) : '';
    const transition = TRANSITIONS.has(raw.transition) ? raw.transition : 'cut';
    const id = isSafeId(raw.id) ? raw.id : ('scene_' + String(index + 1));
    const trimStartMs = cleanInt(raw.trim_start_ms, 0, MAX_DURATION_MS, 0);
    const fit = cleanEnum(raw.fit, FITS, 'cover');
    const captionPosition = cleanEnum(raw.caption_position, CAPTION_POSITIONS, 'bottom');
    const captionStyle = cleanEnum(raw.caption_style, CAPTION_STYLES, 'box');
    const clipVolume = cleanFloat(raw.clip_volume, 0, 1, DEFAULT_CLIP_VOLUME);
    const musicVolume = cleanFloat(raw.music_volume, 0, 1, DEFAULT_MUSIC_VOLUME);
    const voiceVolume = cleanFloat(raw.voice_volume, 0, 1, DEFAULT_VOICE_VOLUME);
    scenes.push({
      id,
      asset,
      asset_type: IMAGE_EXTENSIONS.has(path.extname(asset).toLowerCase()) ? 'image' : 'video',
      caption,
      duration_ms: durationMs,
      transition,
      music,
      voice,
      trim_start_ms: trimStartMs,
      fit,
      caption_position: captionPosition,
      caption_style: captionStyle,
      clip_volume: clipVolume,
      music_volume: musicVolume,
      voice_volume: voiceVolume,
    });
  }
  let aspect = promocapture.sanitizeAspect(input && input.aspect);
  if (!aspect && typeof settings.aspectForPath === 'function') aspect = promocapture.sanitizeAspect(settings.aspectForPath(scenes[0].asset));
  return { ok: true, storyboard: { aspect: aspect || '16:9', scenes } };
}

function create(initialDeps) {
  let deps = { ...(initialDeps || {}) };
  let storyboard = null;

  function configure(nextDeps) {
    deps = { ...deps, ...(nextDeps || {}) };
    return { ok: true };
  }

  function propose(input) {
    const result = sanitizeStoryboard(input, deps);
    if (!result.ok) return result;
    storyboard = result.storyboard;
    if (typeof deps.emit === 'function') {
      try { deps.emit({ type: 'storyboard_proposed', storyboard: state().storyboard }); } catch {}
    }
    return { ok: true, storyboard: state().storyboard };
  }

  function state() {
    return { ok: true, storyboard: storyboard ? JSON.parse(JSON.stringify(storyboard)) : null };
  }

  function allowedPath(candidate) {
    if (typeof candidate !== 'string') return false;
    return !!(storyboard && storyboard.scenes.some((scene) => scene.asset === candidate || scene.music === candidate || scene.voice === candidate))
      || typeof deps.isAdditionalAllowed === 'function' && deps.isAdditionalAllowed(candidate);
  }

  function assetUrl(candidate) {
    if (!allowedPath(candidate)) return { ok: false, error: 'not_in_storyboard' };
    const extensions = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS]);
    const asset = localAsset(deps.downloadsPath, candidate, extensions, deps.exists, deps.realpath);
    return asset ? { ok: true, url: pathToFileURL(asset).href } : { ok: false, error: 'bad_asset' };
  }

  function clear() {
    storyboard = null;
    return { ok: true };
  }

  return { configure, propose, state, assetUrl, clear };
}

const singleton = create();

module.exports = {
  MAX_SCENES, MAX_CAPTION, MIN_DURATION_MS, MAX_DURATION_MS,
  VIDEO_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, TRANSITIONS,
  FITS, CAPTION_POSITIONS, CAPTION_STYLES,
  DEFAULT_CLIP_VOLUME, DEFAULT_MUSIC_VOLUME, DEFAULT_VOICE_VOLUME,
  localAsset, sanitizeStoryboard, create,
  configure: (...args) => singleton.configure(...args),
  propose: (...args) => singleton.propose(...args),
  state: (...args) => singleton.state(...args),
  assetUrl: (...args) => singleton.assetUrl(...args),
  clear: (...args) => singleton.clear(...args),
};
