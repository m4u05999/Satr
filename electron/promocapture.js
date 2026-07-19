'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASPECTS = Object.freeze({
  '16:9': Object.freeze({ width: 1920, height: 1080 }),
  '9:16': Object.freeze({ width: 1080, height: 1920 }),
  '1:1': Object.freeze({ width: 1080, height: 1080 }),
});
const SAFE_PROMO_SESSION = /^promo_[a-f0-9]{24}$/;
const SAFE_SEGMENT_NAME = /^satr-promo-segment-(promo_[a-f0-9]{24})-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.(mp4|webm)$/;
const READY_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 15000;

function sanitizeAspect(value) {
  return Object.prototype.hasOwnProperty.call(ASPECTS, value) ? value : '';
}

function mediaSourceWindowKey(value) {
  const match = /^window:([^:]+):\d+$/.exec(String(value || ''));
  return match ? 'window:' + match[1] : '';
}

function timestamp(date) {
  const value = date instanceof Date ? date : new Date(date || Date.now());
  return value.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function segmentFilename(sessionId, date, extension) {
  const ext = extension === 'webm' ? 'webm' : extension === 'mp4' ? 'mp4' : '';
  if (!SAFE_PROMO_SESSION.test(sessionId || '') || !ext) return '';
  return 'satr-promo-segment-' + sessionId + '-' + timestamp(date) + '.' + ext;
}

function isInsideDownloads(downloadsPath, candidate) {
  if (typeof downloadsPath !== 'string' || !path.isAbsolute(downloadsPath)
      || typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(downloadsPath), path.resolve(candidate));
  return !!relative && !path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function uniqueSegmentPath(downloadsPath, filename, exists = fs.existsSync) {
  if (!SAFE_SEGMENT_NAME.test(filename || '') || !path.isAbsolute(downloadsPath || '')) return null;
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(downloadsPath, index === 1 ? filename : stem + '-' + index + extension);
    if (!isInsideDownloads(downloadsPath, candidate)) return null;
    if (!exists(candidate)) return candidate;
  }
  return null;
}

function cleanUrl(value, validator) {
  const url = typeof value === 'string' ? value.trim() : '';
  return url && typeof validator === 'function' && validator(url) ? url : '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function create(initialDeps) {
  let deps = { ...(initialDeps || {}) };
  let captureWindow = null;
  let captureSource = null;
  let promoSessionId = '';
  let active = null;
  let readyPending = null;
  let stopPending = null;
  const segments = [];

  function configure(nextDeps) {
    deps = { ...deps, ...(nextDeps || {}) };
    return { ok: true };
  }

  function emit(event) {
    if (typeof deps.emit === 'function') {
      try { deps.emit(event); } catch {}
    }
  }

  function clearDisplayHandler() {
    try {
      if (deps.displaySession && typeof deps.displaySession.setDisplayMediaRequestHandler === 'function') {
        deps.displaySession.setDisplayMediaRequestHandler(null);
      }
    } catch {}
  }

  function closeCaptureWindow() {
    const win = captureWindow;
    captureWindow = null;
    captureSource = null;
    clearDisplayHandler();
    if (typeof deps.onTarget === 'function') {
      try { deps.onTarget(null); } catch {}
    }
    if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
      try { win.destroy(); } catch {}
    }
  }

  function settleReady(result) {
    if (!readyPending) return;
    const pending = readyPending;
    readyPending = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  function settleStop(result) {
    if (!stopPending) return;
    const pending = stopPending;
    stopPending = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  function handleWindowClosed() {
    captureWindow = null;
    captureSource = null;
    clearDisplayHandler();
    if (typeof deps.onTarget === 'function') {
      try { deps.onTarget(null); } catch {}
    }
    if (active) {
      emit({ type: 'capture_closed', session_id: active.sessionId });
      settleReady({ ok: false, error: 'capture_closed' });
      settleStop({ ok: false, error: 'capture_closed' });
      active = null;
    }
  }

  function frameOwnerId(request) {
    try {
      const frame = request && request.frame;
      const top = frame && frame.top;
      if (top && deps.ownerWebContents && top === deps.ownerWebContents.mainFrame) return deps.ownerWebContents.id;
      return top && top.webContents ? top.webContents.id : null;
    } catch { return null; }
  }

  function installDisplayHandler(grantSource, sourceId) {
    const displaySession = deps.displaySession;
    const owner = deps.ownerWebContents;
    if (!displaySession || typeof displaySession.setDisplayMediaRequestHandler !== 'function' || !owner) return;
    displaySession.setDisplayMediaRequestHandler((request, callback) => {
      const sameOwner = frameOwnerId(request) === owner.id;
      const valid = sameOwner && active && captureSource && captureSource.id === sourceId
        && request && request.videoRequested === true && request.audioRequested !== true;
      callback(valid ? { video: grantSource } : {});
    }, { useSystemPicker: false });
  }

  async function ensureCaptureWindow(aspect, url) {
    const BrowserWindow = deps.BrowserWindow;
    const desktopCapturer = deps.desktopCapturer;
    if (typeof BrowserWindow !== 'function' || !desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
      return { ok: false, error: 'unavailable' };
    }
    const size = ASPECTS[aspect];
    if (!captureWindow || captureWindow.isDestroyed()) {
      const title = 'Satr Promo Capture ' + crypto.randomBytes(8).toString('hex');
      captureWindow = new BrowserWindow({
        show: true,
        width: size.width,
        height: size.height,
        useContentSize: true,
        resizable: false,
        frame: false,
        autoHideMenuBar: true,
        title,
        backgroundColor: '#000000',
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: deps.partition || 'persist:preview',
          backgroundThrottling: false,
        },
      });
      captureWindow.on('closed', handleWindowClosed);
      if (typeof deps.onTarget === 'function') {
        try { deps.onTarget(captureWindow.webContents); } catch {}
      }
    } else {
      try { captureWindow.setContentSize(size.width, size.height); } catch {}
      try { captureWindow.show(); } catch {}
    }
    try {
      await captureWindow.loadURL(url);
      await delay(Number.isFinite(deps.readyDelayMs) ? deps.readyDelayMs : 250);
      if (captureWindow.isDestroyed()) return { ok: false, error: 'capture_closed' };
      captureWindow.show();
    } catch {
      closeCaptureWindow();
      return { ok: false, error: 'load_failed' };
    }
    const mediaSourceId = captureWindow.getMediaSourceId();
    const sourceKey = mediaSourceWindowKey(mediaSourceId);
    const attempts = Number.isInteger(deps.sourceAttempts) ? Math.max(1, Math.min(30, deps.sourceAttempts)) : 5;
    for (let attempt = 0; attempt < attempts && !captureSource; attempt += 1) {
      let sources;
      try {
        sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        });
      } catch {
        closeCaptureWindow();
        return { ok: false, error: 'source_failed' };
      }
      captureSource = Array.isArray(sources)
        ? sources.find((source) => source && mediaSourceWindowKey(source.id) === sourceKey) : null;
      if (!captureSource && attempt + 1 < attempts) await delay(200);
    }
    const sourceEnumerated = !!captureSource;
    if (!captureSource) captureSource = { id: mediaSourceId };
    if (!String(captureSource.id || '').startsWith('window:')) {
      closeCaptureWindow();
      return { ok: false, error: 'source_not_found' };
    }
    installDisplayHandler(sourceEnumerated ? captureSource : captureWindow.webContents.mainFrame, captureSource.id);
    return { ok: true, source: captureSource, sourceEnumerated, size };
  }

  async function start(options) {
    const input = options && typeof options === 'object' ? options : {};
    const aspect = sanitizeAspect(input.aspect || '16:9');
    if (!aspect) return { ok: false, error: 'bad_aspect' };
    if (active) return { ok: false, error: 'busy' };
    const validator = deps.isHttpUrl;
    const requested = cleanUrl(input.url, validator);
    const fallback = typeof deps.defaultUrl === 'function' ? cleanUrl(deps.defaultUrl(), validator) : '';
    const url = requested || fallback;
    if (!url) return { ok: false, error: 'bad_url' };
    if (!promoSessionId) promoSessionId = 'promo_' + crypto.randomBytes(12).toString('hex');
    active = { sessionId: promoSessionId, aspect, url, startedAt: 0, durationMs: 0, filename: '' };
    const prepared = await ensureCaptureWindow(aspect, url);
    if (!prepared.ok) { active = null; return prepared; }
    const ready = new Promise((resolve) => {
      const timer = setTimeout(() => {
        readyPending = null;
        resolve({ ok: false, error: 'renderer_timeout' });
      }, READY_TIMEOUT_MS);
      readyPending = { resolve, timer };
    });
    emit({
      type: 'capture_start', session_id: promoSessionId, aspect, url,
      source_id: prepared.source.id, source_enumerated: prepared.sourceEnumerated,
      width: prepared.size.width, height: prepared.size.height, fps: 30,
    });
    const renderer = await ready;
    if (!renderer.ok) {
      active = null;
      closeCaptureWindow();
      emit({ type: 'capture_failed', session_id: promoSessionId, error: renderer.error });
      return renderer;
    }
    active.startedAt = Date.now();
    emit({ type: 'capture_active', session_id: promoSessionId, aspect, url });
    return { ok: true, session_id: promoSessionId };
  }

  function rendererReady(sessionId, ok, error) {
    if (!active || active.sessionId !== sessionId || typeof ok !== 'boolean') return { ok: false, error: 'bad_session' };
    settleReady(ok ? { ok: true } : { ok: false, error: String(error || 'renderer_failed').slice(0, 80) });
    return { ok: true };
  }

  async function stop() {
    if (!active) return { ok: false, error: 'not_recording' };
    if (stopPending) return stopPending.promise;
    const sessionId = active.sessionId;
    let resolver;
    const promise = new Promise((resolve) => { resolver = resolve; });
    const timer = setTimeout(() => {
      if (!stopPending) return;
      stopPending = null;
      active = null;
      resolver({ ok: false, error: 'download_timeout' });
    }, STOP_TIMEOUT_MS);
    stopPending = { resolve: resolver, timer, promise };
    emit({ type: 'capture_stop', session_id: sessionId });
    return promise;
  }

  function rendererCommit(sessionId, durationMs, filename) {
    if (!active || active.sessionId !== sessionId || !SAFE_SEGMENT_NAME.test(filename || '')) {
      return { ok: false, error: 'bad_input' };
    }
    const match = filename.match(SAFE_SEGMENT_NAME);
    if (!match || match[1] !== sessionId || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) {
      return { ok: false, error: 'bad_input' };
    }
    active.durationMs = durationMs;
    active.filename = filename;
    return { ok: true };
  }

  function rendererAbort(sessionId, error) {
    if (!active || active.sessionId !== sessionId) return { ok: false, error: 'bad_session' };
    const reason = typeof error === 'string' && error ? error.slice(0, 80) : 'renderer_failed';
    settleReady({ ok: false, error: reason });
    settleStop({ ok: false, error: reason });
    active = null;
    closeCaptureWindow();
    emit({ type: 'capture_failed', session_id: sessionId, error: reason });
    return { ok: true };
  }

  function downloadResult(event) {
    if (!event || !SAFE_SEGMENT_NAME.test(event.filename || '')) return false;
    const match = event.filename.match(SAFE_SEGMENT_NAME);
    if (!active || !match || match[1] !== active.sessionId || active.filename !== event.filename) return false;
    if (event.type === 'promo_recording_saved') {
      if (!isInsideDownloads(deps.downloadsPath, event.path)) {
        settleStop({ ok: false, error: 'outside_downloads' });
      } else {
        const item = {
          path: event.path,
          filename: event.filename,
          duration_ms: active.durationMs,
          aspect: active.aspect,
          url: active.url,
        };
        segments.push(item);
        emit({ type: 'segment_saved', session_id: promoSessionId, segment: { ...item } });
        settleStop({ ok: true, path: item.path, duration_ms: item.duration_ms });
      }
    } else {
      settleStop({ ok: false, error: 'download_failed' });
    }
    active = null;
    emit({ type: 'capture_idle', session_id: promoSessionId });
    return true;
  }

  function listSegments() {
    return { ok: true, session_id: promoSessionId || null, segments: segments.map((item) => ({ ...item })) };
  }

  async function stopAll(options) {
    const discard = !!(options && options.discard);
    const ownerDestroyed = deps.ownerWebContents && typeof deps.ownerWebContents.isDestroyed === 'function'
      && deps.ownerWebContents.isDestroyed();
    if (active) {
      if (!discard && !ownerDestroyed) {
        try { await Promise.race([stop(), delay(STOP_TIMEOUT_MS + 250)]); } catch {}
      }
      active = null;
      settleReady({ ok: false, error: 'stopped' });
      settleStop({ ok: false, error: 'stopped' });
    }
    closeCaptureWindow();
    emit({ type: 'capture_closed', session_id: promoSessionId || null });
    return { ok: true };
  }

  function currentWebContents() {
    return captureWindow && !captureWindow.isDestroyed() ? captureWindow.webContents : null;
  }

  return {
    configure, start, stop, stopAll, rendererReady, rendererCommit, rendererAbort, downloadResult,
    listSegments, currentWebContents,
  };
}

const singleton = create();

module.exports = {
  ASPECTS, SAFE_PROMO_SESSION, SAFE_SEGMENT_NAME,
  sanitizeAspect, mediaSourceWindowKey, segmentFilename, isInsideDownloads, uniqueSegmentPath, create,
  configure: (...args) => singleton.configure(...args),
  start: (...args) => singleton.start(...args),
  stop: (...args) => singleton.stop(...args),
  stopAll: (...args) => singleton.stopAll(...args),
  rendererReady: (...args) => singleton.rendererReady(...args),
  rendererCommit: (...args) => singleton.rendererCommit(...args),
  rendererAbort: (...args) => singleton.rendererAbort(...args),
  downloadResult: (...args) => singleton.downloadResult(...args),
  listSegments: (...args) => singleton.listSegments(...args),
  currentWebContents: (...args) => singleton.currentWebContents(...args),
};
