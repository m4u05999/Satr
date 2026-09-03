'use strict';

const { pathToFileURL } = require('url');

function fileUrl(file) {
  return pathToFileURL(file).href;
}

function isTrustedIpcEvent(event, mainWindow, trustedUrl) {
  if (!event || !mainWindow || typeof mainWindow.isDestroyed !== 'function' || mainWindow.isDestroyed()) return false;
  const webContents = mainWindow.webContents;
  if (!webContents || event.sender !== webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== webContents.mainFrame) return false;
  return frame.url === trustedUrl;
}

function allowNavigation(event, url, trustedUrl) {
  if (url === trustedUrl) return true;
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  return false;
}

// غلاف ipcMain الموحّد: كل قناة تُسجَّل عبره تفشل مغلقة (untrusted_sender) ما لم يأتِ الحدث من
// وثيقة «سطر» وإطارها الرئيسي. يعيش هنا (لا داخل main.js) كي تمرّ قنوات النواة وقنوات
// Enterprise (`satr:ee:*` عبر seam.registerIpc) من الحارس نفسه وتختبره الاختبارات بلا Electron.
// getWindow دالة لأن النافذة تُنشأ بعد بناء الغلاف وقد تُعاد.
function guardIpcMain(rawIpcMain, getWindow, trustedUrl) {
  return {
    handle(channel, listener) {
      return rawIpcMain.handle(channel, (event, ...args) => {
        if (!isTrustedIpcEvent(event, getWindow(), trustedUrl)) {
          return { ok: false, error: 'untrusted_sender' };
        }
        return listener(event, ...args);
      });
    },
  };
}

module.exports = { fileUrl, isTrustedIpcEvent, allowNavigation, guardIpcMain };
