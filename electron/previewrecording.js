'use strict';

const fs = require('fs');
const path = require('path');

const SAFE_RECORDING_NAME = /^satr-preview-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.(?:mp4|webm)$/;

function recordingSavePath(downloadsPath, filename, exists = fs.existsSync) {
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
  const handler = (_event, item, webContents) => {
    if (!webContents || webContents.id !== ownerWebContents.id || !item
        || typeof item.getFilename !== 'function' || typeof item.setSavePath !== 'function') return;
    const filename = item.getFilename();
    const savePath = recordingSavePath(settings.downloadsPath, filename, settings.exists);
    if (!savePath) return;
    item.setSavePath(savePath);
    if (typeof item.once !== 'function') return;
    item.once('done', (_doneEvent, state) => {
      emit(state === 'completed'
        ? { type: 'preview_recording_saved', filename: path.basename(savePath), path: savePath }
        : { type: 'preview_recording_failed', filename: path.basename(savePath), state: String(state || 'unknown') });
    });
  };
  session.on('will-download', handler);
  return () => { try { session.removeListener('will-download', handler); } catch {} };
}

module.exports = { SAFE_RECORDING_NAME, recordingSavePath, attach };
