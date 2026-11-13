'use strict';

// جسر اختبار التصدير الحي: قنوات التصدير والقراءة كما في electron/preload.js، وما يلزم مكوّن
// الاستوديو ليُفتح (حالة الـstoryboard ورابط الأصل).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('satr', {
  promoExportBegin: (kind) => ipcRenderer.invoke('satr:promoExportBegin', { kind: kind === 'gif' ? 'gif' : 'mp4' }),
  promoThumbnailSave: (bytes) => ipcRenderer.invoke('satr:promoThumbnailSave', { bytes }),
  promoExportChunk: (handle, seq, bytes) => ipcRenderer.invoke('satr:promoExportChunk', { handle, seq, bytes }),
  promoExportFinish: (handle, header) => ipcRenderer.invoke('satr:promoExportFinish', { handle, header }),
  promoExportAbort: (handle) => ipcRenderer.invoke('satr:promoExportAbort', { handle }),
  promoAssetRead: (assetPath, offset, length) => ipcRenderer.invoke('satr:promoAssetRead', { path: assetPath, offset, length }),
  promoStudioState: () => ipcRenderer.invoke('satr:promoStudioState'),
  promoAssetUrl: (assetPath) => ipcRenderer.invoke('satr:promoAssetUrl', { path: assetPath }),
  promoSegmentEvents: () => Promise.resolve({ ok: false, error: 'not_a_segment' }),
  promoCaptureStop: () => Promise.resolve({ ok: true }),
  onPromoCapture: () => () => {},
});
