'use strict';
// مشغّل تشخيص: يحفظ قياس الحارس الأصلي ويضمن ظهور نافذته أثناء التقاط سطح المكتب.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  const result = originalLoad.call(this, name, parent, isMain);
  if (name !== 'electron') return result;
  const OriginalWindow = result.BrowserWindow;
  class VisibleWindow extends OriginalWindow {
    constructor(options) {
      super({ ...options, alwaysOnTop: true });
      this.show(); this.focus(); this.moveTop();
    }
  }
  return { ...result, BrowserWindow: VisibleWindow };
};
require(require('path').resolve(process.cwd(), 'scripts/rtl-preview-fix-test.js'));