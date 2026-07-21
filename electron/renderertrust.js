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

module.exports = { fileUrl, isTrustedIpcEvent, allowNavigation };
