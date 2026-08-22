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

const PROJECT_SCHEMA_VERSION = 1;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024; // 2 م.ب لملف المشروع
const PROJECT_EXTENSION = '.satr-promo.json';
const SAFE_PROJECT_NAME = /^[A-Za-z0-9_\u0600-\u06FF\- ]{1,120}$/;

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
  const allowMissing = settings.allowMissingAssets === true;
  const rawScenes = input && Array.isArray(input.scenes) ? input.scenes : [];
  if (!rawScenes.length || rawScenes.length > MAX_SCENES) return { ok: false, error: 'bad_scenes' };
  const scenes = [];
  const missing = [];
  for (let index = 0; index < rawScenes.length; index += 1) {
    const raw = rawScenes[index] && typeof rawScenes[index] === 'object' ? rawScenes[index] : {};
    const candidate = typeof raw.segment_path === 'string' ? raw.segment_path : raw.asset;
    const asset = localAsset(downloadsPath, candidate, new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]), exists, settings.realpath);
    if (!asset) {
      if (allowMissing && typeof candidate === 'string' && candidate.length <= 4096) {
        missing.push(candidate);
      } else {
        return { ok: false, error: 'bad_asset', index };
      }
    }
    const music = raw.music == null || raw.music === '' ? ''
      : localAsset(downloadsPath, raw.music, AUDIO_EXTENSIONS, exists, settings.realpath);
    if (raw.music && !music) {
      if (!allowMissing) return { ok: false, error: 'bad_music', index };
      missing.push(raw.music);
    }
    const voice = raw.voice == null || raw.voice === '' ? ''
      : localAsset(downloadsPath, raw.voice, AUDIO_EXTENSIONS, exists, settings.realpath);
    if (raw.voice && !voice) {
      if (!allowMissing) return { ok: false, error: 'bad_voice', index };
      missing.push(raw.voice);
    }
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
    const scene = {
      id,
      caption,
      duration_ms: durationMs,
      transition,
      trim_start_ms: trimStartMs,
      fit,
      caption_position: captionPosition,
      caption_style: captionStyle,
      clip_volume: clipVolume,
      music_volume: musicVolume,
      voice_volume: voiceVolume,
    };
    if (asset) {
      scene.asset = asset;
      scene.asset_type = IMAGE_EXTENSIONS.has(path.extname(asset).toLowerCase()) ? 'image' : 'video';
    } else {
      scene.asset = candidate;
      scene.asset_type = raw.asset_type === 'image' ? 'image' : 'video';
      scene.asset_missing = true;
    }
    scene.music = music || raw.music || '';
    scene.music_missing = raw.music && !music ? true : undefined;
    scene.voice = voice || raw.voice || '';
    scene.voice_missing = raw.voice && !voice ? true : undefined;
    scenes.push(scene);
  }
  let aspect = promocapture.sanitizeAspect(input && input.aspect);
  if (!aspect && typeof settings.aspectForPath === 'function' && scenes[0] && !scenes[0].asset_missing) {
    aspect = promocapture.sanitizeAspect(settings.aspectForPath(scenes[0].asset));
  }
  const result = { ok: true, storyboard: { aspect: aspect || '16:9', scenes } };
  if (allowMissing && missing.length) result.missing = missing;
  return result;
}

function isProjectPathSafe(downloadsPath, filePath, realpath) {
  if (typeof filePath !== 'string' || filePath.length > 4096 || !path.isAbsolute(filePath)) return false;
  if (!filePath.toLowerCase().endsWith(PROJECT_EXTENSION)) return false;
  const resolved = path.resolve(filePath);
  const root = typeof downloadsPath === 'string' ? path.resolve(downloadsPath) : '';
  if (!root) return false;
  const canonicalFile = typeof realpath === 'function' ? (() => {
    try { return realpath(resolved); } catch { return resolved; }
  })() : resolved;
  const canonicalRoot = typeof realpath === 'function' ? (() => {
    try { return realpath(root); } catch { return root; }
  })() : root;
  return promocapture.isInsideDownloads(canonicalRoot, canonicalFile);
}

function inferAssetType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return '';
}

function doListDownloads(downloadsPath, extensions, options) {
  const settings = options || {};
  const exists = typeof settings.exists === 'function' ? settings.exists : fs.existsSync;
  const realpath = typeof settings.realpath === 'function' ? settings.realpath : fs.realpathSync;
  if (typeof downloadsPath !== 'string' || !path.isAbsolute(downloadsPath)) {
    return { ok: false, error: 'bad_downloads_path' };
  }
  const allowed = Array.isArray(extensions) && extensions.length
    ? new Set(extensions.map((ext) => String(ext).toLowerCase()))
    : new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS]);
  const root = path.resolve(downloadsPath);
  let entries;
  try { entries = fs.readdirSync(root); } catch (error) {
    return { ok: false, error: 'read_failed' };
  }
  const files = [];
  for (const entry of entries) {
    const joined = path.join(root, entry);
    if (!path.isAbsolute(joined)) continue;
    const ext = path.extname(joined).toLowerCase();
    if (!allowed.has(ext)) continue;
    const resolved = path.resolve(joined);
    const canonical = (() => {
      try { return realpath(resolved); } catch { return resolved; }
    })();
    if (!promocapture.isInsideDownloads(root, canonical) || !exists(canonical)) continue;
    files.push({ name: entry, path: canonical, type: inferAssetType(canonical) });
  }
  return { ok: true, files };
}

function doSaveProject(downloadsPath, storyboard, filePath, options) {
  const settings = options || {};
  const exists = typeof settings.exists === 'function' ? settings.exists : fs.existsSync;
  const realpath = typeof settings.realpath === 'function' ? settings.realpath : fs.realpathSync;
  const writeFileSync = typeof settings.writeFileSync === 'function' ? settings.writeFileSync : fs.writeFileSync;
  const renameSync = typeof settings.renameSync === 'function' ? settings.renameSync : fs.renameSync;
  if (!isProjectPathSafe(downloadsPath, filePath, realpath)) return { ok: false, error: 'bad_path' };
  const sanitized = sanitizeStoryboard(storyboard, { downloadsPath, exists, realpath });
  if (!sanitized.ok) return { ok: false, error: sanitized.error, index: sanitized.index };
  const payload = {
    version: PROJECT_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    aspect: sanitized.storyboard.aspect,
    scenes: sanitized.storyboard.scenes,
  };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > MAX_PROJECT_BYTES) return { ok: false, error: 'too_large' };
  const target = path.resolve(filePath);
  const temp = target + '.tmp';
  try {
    writeFileSync(temp, json, 'utf8');
    renameSync(temp, target);
  } catch (error) {
    return { ok: false, error: 'write_failed' };
  }
  return { ok: true, path: target };
}

function doLoadProject(filePath, downloadsPath, options) {
  const settings = options || {};
  const exists = typeof settings.exists === 'function' ? settings.exists : fs.existsSync;
  const realpath = typeof settings.realpath === 'function' ? settings.realpath : fs.realpathSync;
  const readFileSync = typeof settings.readFileSync === 'function' ? settings.readFileSync : fs.readFileSync;
  if (!isProjectPathSafe(downloadsPath, filePath, realpath)) return { ok: false, error: 'bad_path' };
  const target = path.resolve(filePath);
  let raw;
  try { raw = readFileSync(target, 'utf8'); } catch (error) {
    return { ok: false, error: 'read_failed' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    return { ok: false, error: 'bad_schema' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== PROJECT_SCHEMA_VERSION || !Array.isArray(parsed.scenes)) {
    return { ok: false, error: 'bad_schema' };
  }
  const result = sanitizeStoryboard(
    { aspect: parsed.aspect, scenes: parsed.scenes },
    { downloadsPath, exists, realpath, allowMissingAssets: true },
  );
  if (!result.ok) return { ok: false, error: result.error, index: result.index };
  return { ok: true, storyboard: result.storyboard, missing: result.missing || [] };
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

  function listDownloads(extensions) {
    return doListDownloads(deps.downloadsPath, extensions, { exists: deps.exists, realpath: deps.realpath });
  }

  function saveProject(storyboard, filePath) {
    return doSaveProject(deps.downloadsPath, storyboard, filePath, {
      exists: deps.exists, realpath: deps.realpath, writeFileSync: deps.writeFileSync, renameSync: deps.renameSync,
    });
  }

  function loadProject(filePath) {
    return doLoadProject(filePath, deps.downloadsPath, { exists: deps.exists, realpath: deps.realpath, readFileSync: deps.readFileSync });
  }

  return { configure, propose, state, assetUrl, clear, listDownloads, saveProject, loadProject };
}

const singleton = create();

module.exports = {
  MAX_SCENES, MAX_CAPTION, MIN_DURATION_MS, MAX_DURATION_MS,
  VIDEO_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, TRANSITIONS,
  FITS, CAPTION_POSITIONS, CAPTION_STYLES,
  DEFAULT_CLIP_VOLUME, DEFAULT_MUSIC_VOLUME, DEFAULT_VOICE_VOLUME,
  PROJECT_SCHEMA_VERSION, MAX_PROJECT_BYTES, PROJECT_EXTENSION, SAFE_PROJECT_NAME,
  localAsset, sanitizeStoryboard, isProjectPathSafe, inferAssetType,
  listDownloads: doListDownloads, saveProject: doSaveProject, loadProject: doLoadProject, create,
  configure: (...args) => singleton.configure(...args),
  propose: (...args) => singleton.propose(...args),
  state: (...args) => singleton.state(...args),
  assetUrl: (...args) => singleton.assetUrl(...args),
  clear: (...args) => singleton.clear(...args),
  listDownloadsBound: (...args) => singleton.listDownloads(...args),
  saveProjectBound: (...args) => singleton.saveProject(...args),
  loadProjectBound: (...args) => singleton.loadProject(...args),
};
