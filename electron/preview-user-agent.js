'use strict';

// نحافظ على إصدار Chromium الحقيقي؛ نحذف فقط رمزي التطبيق وElectron من هوية المعاينة.
function previewUserAgent(nativeUserAgent, useNative = false) {
  if (useNative) return nativeUserAgent;
  return nativeUserAgent.split(/\s+/)
    .filter(token => !/^(?:Satr|Electron)\//i.test(token)).join(' ');
}

module.exports = { previewUserAgent };
