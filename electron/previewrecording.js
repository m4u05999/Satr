'use strict';

const fs = require('fs');
const path = require('path');
const promocapture = require('./promocapture');

const SAFE_RECORDING_NAME = /^satr-preview-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.(?:mp4|webm)$/;

function recordingSavePath(downloadsPath, filename, exists = fs.existsSync) {
  if (promocapture.SAFE_SEGMENT_NAME.test(filename || '')) {
    return promocapture.uniqueSegmentPath(downloadsPath, filename, exists);
  }
  if (typeof downloadsPath !== 'string' || !path.isAbsolute(downloadsPath)
      || typeof filename !== 'string' || !SAFE_RECORDING_NAME.test(filename)) return null;
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(downloadsPath, index === 1 ? filename : stem + '-' + index + extension);
    if (!exists(candidate)) return candidate;
  }
  return null;
}

function attach(session, ownerWebContents, options) {
  if (!session || typeof session.on !== 'function' || !ownerWebContents) return () => {};
  const settings = options || {};
  const emit = typeof settings.emit === 'function' ? settings.emit : () => {};
  const onResult = typeof settings.onResult === 'function' ? settings.onResult : () => {};
  const handler = (_event, item, webContents) => {
    if (!webContents || webContents.id !== ownerWebContents.id || !item
        || typeof item.getFilename !== 'function' || typeof item.setSavePath !== 'function') return;
    const filename = item.getFilename();
    const savePath = recordingSavePath(settings.downloadsPath, filename, settings.exists);
    if (!savePath) return;
    item.setSavePath(savePath);
    if (typeof item.once !== 'function') return;
    item.once('done', (_doneEvent, state) => {
      const promo = promocapture.SAFE_SEGMENT_NAME.test(filename);
      const savedFilename = path.basename(savePath);
      const result = state === 'completed'
        ? { type: promo ? 'promo_recording_saved' : 'preview_recording_saved', filename: promo ? filename : savedFilename, path: savePath }
        : { type: promo ? 'promo_recording_failed' : 'preview_recording_failed', filename: promo ? filename : savedFilename, state: String(state || 'unknown') };
      if (promo) result.saved_filename = savedFilename;
      emit(result);
      onResult(result);
    });
  };
  session.on('will-download', handler);
  return () => { try { session.removeListener('will-download', handler); } catch {} };
}

module.exports = { SAFE_RECORDING_NAME, recordingSavePath, attach };
