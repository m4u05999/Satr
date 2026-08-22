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
const SAFE_DOCUMENT_ID = /^d[1-9][0-9]*$/;
const SAFE_TARGET_REF = /^s[1-9][0-9]*:e[1-9][0-9]*$/;
const SEGMENT_REGISTRY_VERSION = 1;
const SEGMENT_REGISTRY_MAX_COUNT = 500;
const SEGMENT_REGISTRY_MAX_BYTES = 1024 * 1024;
const EVENT_LOG_VERSION = 0;
const EVENT_LOG_MAX_RECORDS = 10000;
const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const EVENT_MOUSEMOVE_INTERVAL_MS = 100;
const EVENT_DENSE_MOUSEMOVE_INTERVAL_MS = 1000;
const EVENT_DENSE_THRESHOLD_PER_MINUTE = 600;
const BEACON_MAX_DRIFT_MS = 80;
const READY_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 15000;
const BEACON_TIMEOUT_MS = 1400;
const START_BEACON_SETTLE_MS = 750;
const REGISTRY_FILENAME = '.satr-promo-segments-v1.json';

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

function registryFileFor(downloadsPath) {
  return typeof downloadsPath === 'string' && path.isAbsolute(downloadsPath)
    ? path.join(path.resolve(downloadsPath), REGISTRY_FILENAME) : '';
}

function eventRootFor(downloadsPath) {
  return typeof downloadsPath === 'string' && path.isAbsolute(downloadsPath)
    ? path.join(path.resolve(downloadsPath), '.satr-promo', 'events') : '';
}

function projectEventRoot(projectRoot) {
  return typeof projectRoot === 'string' && path.isAbsolute(projectRoot)
    ? path.join(path.resolve(projectRoot), '.satr', 'promo', 'events') : '';
}

function registryPayload(items) {
  return JSON.stringify({ version: SEGMENT_REGISTRY_VERSION, segments: items }, null, 2) + '\n';
}

function trimRegistry(items) {
  const kept = Array.isArray(items) ? items.slice(-SEGMENT_REGISTRY_MAX_COUNT) : [];
  while (kept.length && Buffer.byteLength(registryPayload(kept), 'utf8') > SEGMENT_REGISTRY_MAX_BYTES) kept.shift();
  return kept;
}

function atomicWriteRegistry(file, items, fileSystem = fs) {
  if (!file || !path.isAbsolute(file)) return false;
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  try {
    fileSystem.mkdirSync(path.dirname(file), { recursive: true });
    fileSystem.writeFileSync(temp, registryPayload(trimRegistry(items)), 'utf8');
    fileSystem.renameSync(temp, file);
    return true;
  } catch {
    try { fileSystem.unlinkSync(temp); } catch {}
    return false;
  }
}

function cleanStoredSegment(item, downloadsPath) {
  if (!item || typeof item !== 'object' || !SAFE_SEGMENT_NAME.test(item.filename || '')
      || !isInsideDownloads(downloadsPath, item.path)) return null;
  const aspect = sanitizeAspect(item.aspect);
  if (!aspect || !Number.isInteger(item.duration_ms) || item.duration_ms < 0
      || item.duration_ms > 24 * 60 * 60 * 1000) return null;
  const segmentId = SAFE_PROMO_SESSION.test(item.segment_id || '')
    ? item.segment_id : String(item.filename).match(SAFE_SEGMENT_NAME)[1];
  return {
    path: path.resolve(item.path), filename: item.filename, duration_ms: item.duration_ms,
    aspect, url: typeof item.url === 'string' ? item.url.slice(0, 2048) : '',
    segment_id: segmentId,
    created_at: Number.isFinite(item.created_at) ? Math.max(0, Math.round(item.created_at)) : 0,
    timing_quality: item.timing_quality === 'verified' ? 'verified' : 'unverified',
    events_file: typeof item.events_file === 'string' && path.isAbsolute(item.events_file)
      ? path.resolve(item.events_file) : '',
  };
}

function loadRegistry(file, downloadsPath, fileSystem = fs) {
  if (!file || !path.isAbsolute(file)) return [];
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== SEGMENT_REGISTRY_VERSION || !Array.isArray(parsed.segments)) return [];
    return trimRegistry(parsed.segments.map((item) => cleanStoredSegment(item, downloadsPath)).filter(Boolean));
  } catch { return []; }
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function cleanViewport(value) {
  if (!value || typeof value !== 'object') return null;
  const width = finiteInteger(value.width), height = finiteInteger(value.height);
  const dpr = Number(value.dpr);
  if (width == null || height == null || width < 1 || height < 1 || width > 10000 || height > 10000
      || !Number.isFinite(dpr) || dpr <= 0 || dpr > 16) return null;
  return { width, height, dpr: Math.round(dpr * 1000) / 1000 };
}

function cleanRect(value, viewport) {
  if (!value || typeof value !== 'object' || !viewport) return null;
  const x = finiteInteger(value.x), y = finiteInteger(value.y);
  const width = finiteInteger(value.width), height = finiteInteger(value.height);
  if ([x, y, width, height].some((item) => item == null)) return null;
  const left = Math.max(0, Math.min(viewport.width, x));
  const top = Math.max(0, Math.min(viewport.height, y));
  return {
    x: left, y: top,
    width: Math.max(0, Math.min(viewport.width - left, width)),
    height: Math.max(0, Math.min(viewport.height - top, height)),
  };
}

function cleanPointer(value, viewport) {
  if (!value || typeof value !== 'object' || !viewport) return null;
  const x = finiteInteger(value.x), y = finiteInteger(value.y), button = finiteInteger(value.button);
  if (x == null || y == null || button == null || button < 0 || button > 5) return null;
  return { x: Math.max(0, Math.min(viewport.width, x)), y: Math.max(0, Math.min(viewport.height, y)), button };
}

function createEventSink(options) {
  const input = options && typeof options === 'object' ? options : {};
  const fileSystem = input.fs || fs;
  const segmentId = SAFE_PROMO_SESSION.test(input.segmentId || '') ? input.segmentId : '';
  const root = typeof input.root === 'string' && path.isAbsolute(input.root) ? path.resolve(input.root) : '';
  const maxRecords = Number.isInteger(input.maxRecords) && input.maxRecords >= 2
    ? Math.min(EVENT_LOG_MAX_RECORDS, input.maxRecords) : EVENT_LOG_MAX_RECORDS;
  const maxBytes = Number.isInteger(input.maxBytes) && input.maxBytes >= 1024
    ? Math.min(EVENT_LOG_MAX_BYTES, input.maxBytes) : EVENT_LOG_MAX_BYTES;
  const now = typeof input.now === 'function' ? input.now : () => performance.now();
  const partialPath = root && segmentId ? path.join(root, segmentId + '.events.jsonl.partial') : '';
  const finalPath = root && segmentId ? path.join(root, segmentId + '.events.jsonl') : '';
  const records = [];
  const recentTimes = [];
  let byteCount = 0;
  let lastMoveAt = -Infinity;
  let startBeacon = null;
  let endBeacon = null;
  let truncated = false;
  let closed = false;

  try { if (root) fileSystem.mkdirSync(root, { recursive: true }); } catch {}

  function elapsed(at) {
    return startBeacon ? Math.max(0, Math.round(at - startBeacon.capture_ms)) : 0;
  }

  function makeRecord(event, at, quality) {
    const kind = ['action', 'pointer', 'navigation', 'clock', 'truncated'].includes(event.kind) ? event.kind : null;
    const source = ['agent', 'human', 'system'].includes(event.source) ? event.source : null;
    const action = ['click', 'type', 'select', 'hover', 'scroll', 'mousedown', 'mousemove'].includes(event.action)
      ? event.action : null;
    const viewport = cleanViewport(event.viewport);
    return {
      v: EVENT_LOG_VERSION,
      seq: records.length + 1,
      segment_id: segmentId,
      kind,
      source,
      t_capture_ms: elapsed(at),
      action,
      target_ref: SAFE_TARGET_REF.test(event.target_ref || '') ? event.target_ref : null,
      document_id: SAFE_DOCUMENT_ID.test(event.document_id || '') ? event.document_id : 'd1',
      rect: cleanRect(event.rect, viewport),
      pointer: cleanPointer(event.pointer, viewport),
      viewport,
      capture_duration_ms: Number.isInteger(event.capture_duration_ms) ? Math.max(0, event.capture_duration_ms) : null,
      media_duration_ms: Number.isInteger(event.media_duration_ms) ? Math.max(0, event.media_duration_ms) : null,
      timing_quality: quality === 'verified' ? 'verified' : 'unverified',
    };
  }

  function persistPartial() {
    if (!partialPath) return false;
    try {
      fileSystem.writeFileSync(partialPath, records.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
      return true;
    } catch { return false; }
  }

  function appendTruncated(at) {
    if (truncated || records.length >= maxRecords) return;
    const record = makeRecord({ kind: 'truncated', source: 'system', action: null, document_id: 'd1' }, at, 'unverified');
    const bytes = Buffer.byteLength(JSON.stringify(record) + '\n', 'utf8');
    if (byteCount + bytes > maxBytes) return;
    records.push(record);
    byteCount += bytes;
    truncated = true;
    persistPartial();
  }

  function record(event) {
    if (closed || truncated || !segmentId || !event || typeof event !== 'object') return { ok: false };
    const at = Number.isFinite(event.monotonic_ms) ? event.monotonic_ms : now();
    if (!startBeacon) return { ok: false, error: 'beacon_missing' };
    recentTimes.push(at);
    while (recentTimes.length && recentTimes[0] < at - 60000) recentTimes.shift();
    if (event.action === 'mousemove') {
      const interval = recentTimes.length > EVENT_DENSE_THRESHOLD_PER_MINUTE
        ? EVENT_DENSE_MOUSEMOVE_INTERVAL_MS : EVENT_MOUSEMOVE_INTERVAL_MS;
      if (at - lastMoveAt < interval) return { ok: true, coalesced: true };
      lastMoveAt = at;
    }
    if (records.length >= maxRecords - 1) {
      appendTruncated(at);
      return { ok: true, truncated: true };
    }
    const recordValue = makeRecord(event, at, 'unverified');
    if (!recordValue.kind || !recordValue.source) return { ok: false, error: 'bad_event' };
    const bytes = Buffer.byteLength(JSON.stringify(recordValue) + '\n', 'utf8');
    const sentinel = makeRecord({ kind: 'truncated', source: 'system', document_id: 'd1' }, at, 'unverified');
    const reserve = Buffer.byteLength(JSON.stringify(sentinel) + '\n', 'utf8');
    if (byteCount + bytes + reserve > maxBytes) {
      appendTruncated(at);
      return { ok: true, truncated: true };
    }
    records.push(recordValue);
    byteCount += bytes;
    persistPartial();
    return { ok: true };
  }

  function markBeacon(kind, details) {
    if (closed || !['start', 'end'].includes(kind)) return { ok: false };
    const data = details && typeof details === 'object' ? details : {};
    const captureMs = Number.isFinite(data.capture_ms) ? data.capture_ms : now();
    const beacon = {
      capture_ms: captureMs,
      media_ms: Number.isFinite(data.media_ms) && data.media_ms >= 0 ? data.media_ms : null,
      visible: data.visible === true,
    };
    if (kind === 'start') startBeacon = beacon;
    else endBeacon = beacon;
    return { ok: true };
  }

  function markMediaBeacon(kind, mediaMs) {
    const beacon = kind === 'start' ? startBeacon : kind === 'end' ? endBeacon : null;
    if (!beacon || !Number.isFinite(mediaMs) || mediaMs < 0 || mediaMs > 24 * 60 * 60 * 1000) return { ok: false };
    beacon.media_ms = mediaMs;
    return { ok: true };
  }

  function quality() {
    if (!startBeacon || !endBeacon || !startBeacon.visible || !endBeacon.visible
        || startBeacon.media_ms == null || endBeacon.media_ms == null) return 'unverified';
    const captureElapsed = endBeacon.capture_ms - startBeacon.capture_ms;
    const mediaElapsed = endBeacon.media_ms - startBeacon.media_ms;
    return Math.abs(mediaElapsed - captureElapsed) <= BEACON_MAX_DRIFT_MS ? 'verified' : 'unverified';
  }

  function finalize(mediaDurationMs) {
    if (closed) return { ok: false, error: 'closed' };
    const at = endBeacon ? endBeacon.capture_ms : now();
    const timingQuality = quality();
    if (!truncated) record({
      kind: 'clock', source: 'system', action: null, document_id: 'd1', monotonic_ms: at,
      capture_duration_ms: startBeacon ? elapsed(at) : null,
      media_duration_ms: Number.isInteger(mediaDurationMs) ? Math.max(0, mediaDurationMs) : null,
    });
    for (const item of records) item.timing_quality = timingQuality;
    byteCount = records.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item) + '\n', 'utf8'), 0);
    persistPartial();
    let renamed = false;
    if (partialPath && finalPath) {
      try { fileSystem.renameSync(partialPath, finalPath); renamed = true; } catch {}
    }
    closed = true;
    return {
      ok: true, path: renamed ? finalPath : '', filename: renamed ? path.basename(finalPath) : '',
      timing_quality: timingQuality, auto_crop_eligible: timingQuality === 'verified',
      records: records.length, bytes: byteCount, truncated,
    };
  }

  return {
    record, markBeacon, markMediaBeacon, finalize,
    state: () => ({ records: records.map((item) => ({ ...item })), bytes: byteCount, truncated, quality: quality() }),
  };
}

function permissionDetailsAreAudioOnly(details) {
  const mediaTypes = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return mediaTypes.length === 1 && mediaTypes[0] === 'audio';
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
  let registryPath = '';
  let microphoneGrantUntil = 0;
  let beaconPending = null;

  function configure(nextDeps) {
    deps = { ...deps, ...(nextDeps || {}) };
    const nextRegistryPath = registryFileFor(deps.downloadsPath);
    if (nextRegistryPath && nextRegistryPath !== registryPath) {
      registryPath = nextRegistryPath;
      segments.splice(0, segments.length, ...loadRegistry(registryPath, deps.downloadsPath, deps.fs || fs));
    }
    return { ok: true };
  }

  configure({});

  function monotonicNow() {
    return typeof deps.monotonicNow === 'function' ? deps.monotonicNow() : performance.now();
  }

  function persistSegments() {
    const kept = trimRegistry(segments);
    segments.splice(0, segments.length, ...kept);
    return atomicWriteRegistry(registryPath, kept, deps.fs || fs);
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

  function permissionAllowed(webContents, permission, details) {
    const sameWindow = captureWindow && !captureWindow.isDestroyed()
      && captureWindow.webContents === webContents;
    return !!(sameWindow && active && active.microphone && permission === 'media'
      && permissionDetailsAreAudioOnly(details) && monotonicNow() <= microphoneGrantUntil);
  }

  function wireCapturePermissions(captureSession) {
    if (!captureSession) return;
    try {
      if (typeof captureSession.setPermissionRequestHandler === 'function') {
        captureSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
          const allowed = permissionAllowed(webContents, permission, details);
          if (allowed) microphoneGrantUntil = 0; // منحة واحدة قصيرة لا نافذة مفتوحة
          callback(allowed);
        });
      }
      if (typeof captureSession.setPermissionCheckHandler === 'function') {
        captureSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
          permissionAllowed(webContents, permission, details)
        ));
      }
    } catch {}
  }

  function closeCaptureWindow() {
    const win = captureWindow;
    captureWindow = null;
    captureSource = null;
    clearDisplayHandler();
    microphoneGrantUntil = 0;
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
    microphoneGrantUntil = 0;
    if (typeof deps.onTarget === 'function') {
      try { deps.onTarget(null); } catch {}
    }
    if (active) {
      emit({ type: 'capture_closed', session_id: active.sessionId });
      settleReady({ ok: false, error: 'capture_closed' });
      settleStop({ ok: false, error: 'capture_closed' });
      active = null;
      connectEventSink();
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
        && request && request.videoRequested === true
        && request.audioRequested === active.systemAudio;
      if (!valid) { callback({}); return; }
      // مصدر window مع loopback يسقط بـAbortError؛ mainFrame هو المسار المقيس الناجح.
      callback(active.systemAudio ? { video: captureWindow.webContents.mainFrame, audio: 'loopback' } : { video: grantSource });
    }, { useSystemPicker: false });
  }

  async function showBeacon(kind) {
    const wc = captureWindow && !captureWindow.isDestroyed() ? captureWindow.webContents : null;
    if (!wc) return { ok: false };
    let marker = deps.showBeacon;
    if (typeof marker !== 'function') {
      try { marker = require('./preview').showCaptureBeacon; } catch {}
    }
    if (typeof marker !== 'function') return { ok: false };
    try { return await marker(wc, kind); } catch { return { ok: false }; }
  }

  function connectEventSink() {
    let setter = deps.setEventSink;
    if (typeof setter !== 'function') {
      try { setter = require('./preview').setCaptureEventSink; } catch {}
    }
    if (typeof setter === 'function') {
      try { setter(active ? (event) => captureEvent(event) : null); } catch {}
    }
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
          partition: deps.partition || 'persist:promo-capture',
          backgroundThrottling: false,
        },
      });
      wireCapturePermissions(captureWindow.webContents.session);
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
    const segmentId = 'promo_' + crypto.randomBytes(12).toString('hex');
    active = {
      sessionId: promoSessionId, segmentId, aspect, url, startedAt: 0, durationMs: 0, filename: '',
      systemAudio: input.audio === 'loopback', microphone: input.microphone === true, sink: null,
    };
    const prepared = await ensureCaptureWindow(aspect, url);
    if (!prepared.ok) { active = null; return prepared; }
    active.sink = createEventSink({
      segmentId,
      root: projectEventRoot(input.projectRoot)
        || (typeof deps.eventRoot === 'string' && path.isAbsolute(deps.eventRoot)
          ? deps.eventRoot : eventRootFor(deps.downloadsPath)),
      fs: deps.fs || fs,
      now: monotonicNow,
    });
    connectEventSink();
    const ready = new Promise((resolve) => {
      const timer = setTimeout(() => {
        readyPending = null;
        resolve({ ok: false, error: 'renderer_timeout' });
      }, READY_TIMEOUT_MS);
      readyPending = { resolve, timer };
    });
    emit({
      type: 'capture_start', session_id: promoSessionId, segment_id: segmentId, aspect, url,
      source_id: prepared.source.id, source_enumerated: prepared.sourceEnumerated,
      width: prepared.size.width, height: prepared.size.height, fps: 30,
      audio: active.systemAudio ? 'loopback' : false,
      microphone: active.microphone,
      system_wide: active.systemAudio,
    });
    const renderer = await ready;
    if (!renderer.ok) {
      active = null;
      connectEventSink();
      closeCaptureWindow();
      emit({ type: 'capture_failed', session_id: promoSessionId, error: renderer.error });
      return renderer;
    }
    active.startedAt = Date.now();
    emit({ type: 'capture_active', session_id: promoSessionId, aspect, url });
    return { ok: true, session_id: promoSessionId };
  }

  async function rendererReady(sessionId, ok, error) {
    if (!active || active.sessionId !== sessionId || typeof ok !== 'boolean') return { ok: false, error: 'bad_session' };
    if (!ok) {
      settleReady({ ok: false, error: String(error || 'renderer_failed').slice(0, 80) });
      return { ok: true };
    }
    const captureMs = monotonicNow();
    const marker = await showBeacon('start');
    if (active && active.sink) active.sink.markBeacon('start', { capture_ms: captureMs, visible: !!(marker && marker.ok) });
    // لا نسمح لأول فعل وكيل أن يقع خلف الوميضة؛ المقطع يسجّلها كاملة ثم يبدأ النشاط.
    if (marker && marker.ok) await delay(START_BEACON_SETTLE_MS);
    settleReady({ ok: true });
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
      connectEventSink();
      resolver({ ok: false, error: 'download_timeout' });
    }, STOP_TIMEOUT_MS);
    stopPending = { resolve: resolver, timer, promise };
    const captureMs = monotonicNow();
    const marker = await showBeacon('end');
    if (active && active.sink) active.sink.markBeacon('end', { capture_ms: captureMs, visible: !!(marker && marker.ok) });
    if (marker && marker.ok && active) {
      await new Promise((resolve) => {
        const beaconTimer = setTimeout(() => { beaconPending = null; resolve(); }, BEACON_TIMEOUT_MS);
        beaconPending = { resolve: () => { clearTimeout(beaconTimer); beaconPending = null; resolve(); } };
      });
    }
    emit({ type: 'capture_stop', session_id: sessionId });
    return promise;
  }

  function rendererBeacon(sessionId, kind, mediaMs) {
    if (!active || active.sessionId !== sessionId || !['start', 'end'].includes(kind)
        || !Number.isFinite(mediaMs) || mediaMs < 0 || mediaMs > 24 * 60 * 60 * 1000) {
      return { ok: false, error: 'bad_input' };
    }
    const result = active.sink ? active.sink.markMediaBeacon(kind, mediaMs) : { ok: false };
    if (kind === 'end' && beaconPending) beaconPending.resolve();
    return result;
  }

  function armMicrophone(sessionId) {
    if (!active || active.sessionId !== sessionId || !active.microphone) return { ok: false, error: 'bad_session' };
    microphoneGrantUntil = monotonicNow() + 2000;
    return { ok: true };
  }

  function captureEvent(event) {
    return active && active.sink ? active.sink.record(event) : { ok: false, error: 'not_recording' };
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
    connectEventSink();
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
        const finalized = active.sink ? active.sink.finalize(active.durationMs) : {
          path: '', timing_quality: 'unverified', auto_crop_eligible: false,
        };
        const item = {
          path: event.path,
          filename: event.filename,
          duration_ms: active.durationMs,
          aspect: active.aspect,
          url: active.url,
          segment_id: active.segmentId,
          created_at: Date.now(),
          timing_quality: finalized.timing_quality,
          events_file: finalized.path,
        };
        segments.push(item);
        persistSegments(); // أفضل جهد: فشل القرص لا يحوّل نجاح التسجيل إلى فشل.
        emit({
          type: 'segment_saved', session_id: promoSessionId,
          segment: { ...item, available: true, missing: false, disabled: false,
            auto_crop_eligible: finalized.auto_crop_eligible },
        });
        settleStop({ ok: true, path: item.path, duration_ms: item.duration_ms });
      }
    } else {
      settleStop({ ok: false, error: 'download_failed' });
    }
    active = null;
    connectEventSink();
    emit({ type: 'capture_idle', session_id: promoSessionId });
    return true;
  }

  function listSegments() {
    const fileSystem = deps.fs || fs;
    return {
      ok: true,
      session_id: promoSessionId || null,
      segments: segments.map((item) => {
        let available = false;
        try { available = fileSystem.existsSync(item.path); } catch {}
        return {
          ...item,
          available,
          missing: !available,
          disabled: !available,
          auto_crop_eligible: available && item.timing_quality === 'verified',
          events_available: !!(item.events_file && (() => { try { return fileSystem.existsSync(item.events_file); } catch { return false; } })()),
        };
      }),
    };
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
      connectEventSink();
      settleReady({ ok: false, error: 'stopped' });
      settleStop({ ok: false, error: 'stopped' });
    }
    closeCaptureWindow();
    connectEventSink();
    emit({ type: 'capture_closed', session_id: promoSessionId || null });
    return { ok: true };
  }

  function currentWebContents() {
    return captureWindow && !captureWindow.isDestroyed() ? captureWindow.webContents : null;
  }

  return {
    configure, start, stop, stopAll, rendererReady, rendererCommit, rendererAbort, downloadResult,
    rendererBeacon, armMicrophone, captureEvent, listSegments, currentWebContents,
  };
}

const singleton = create();

module.exports = {
  ASPECTS, SAFE_PROMO_SESSION, SAFE_SEGMENT_NAME,
  SEGMENT_REGISTRY_VERSION, SEGMENT_REGISTRY_MAX_COUNT, SEGMENT_REGISTRY_MAX_BYTES,
  EVENT_LOG_VERSION, EVENT_LOG_MAX_RECORDS, EVENT_LOG_MAX_BYTES, EVENT_MOUSEMOVE_INTERVAL_MS,
  BEACON_MAX_DRIFT_MS,
  sanitizeAspect, mediaSourceWindowKey, segmentFilename, isInsideDownloads, uniqueSegmentPath,
  registryFileFor, eventRootFor, projectEventRoot, trimRegistry, atomicWriteRegistry, loadRegistry,
  createEventSink, permissionDetailsAreAudioOnly, create,
  configure: (...args) => singleton.configure(...args),
  start: (...args) => singleton.start(...args),
  stop: (...args) => singleton.stop(...args),
  stopAll: (...args) => singleton.stopAll(...args),
  rendererReady: (...args) => singleton.rendererReady(...args),
  rendererCommit: (...args) => singleton.rendererCommit(...args),
  rendererAbort: (...args) => singleton.rendererAbort(...args),
  rendererBeacon: (...args) => singleton.rendererBeacon(...args),
  armMicrophone: (...args) => singleton.armMicrophone(...args),
  captureEvent: (...args) => singleton.captureEvent(...args),
  downloadResult: (...args) => singleton.downloadResult(...args),
  listSegments: (...args) => singleton.listSegments(...args),
  currentWebContents: (...args) => singleton.currentWebContents(...args),
};
