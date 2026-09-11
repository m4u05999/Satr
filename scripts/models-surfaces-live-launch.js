'use strict';
// رصد مستقل لحدود WebContentsView الفعلية، دون تغيير main أو IPC أو قرارات التطبيق.
const fs = require('fs'), path = require('path');
const { app, BrowserWindow } = require('electron');
const core = require('./lib/live-test-run');
const repo = path.resolve(__dirname, '..'), run = core.loadRun(repo, process.argv[2]);
const dir = path.join(run.paths.root, 'models-surfaces');
let previous = '', shot = '', capturing = false, windowRequest = '';
const timer = setInterval(async () => {
  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/src/index.html'));
  if (!win || win.isDestroyed()) return;
  try {
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'window-request.json')));
    if (request.id !== windowRequest) {
      windowRequest = request.id;
      if ([1000, 1180, 1440].includes(request.width)) win.setSize(request.width, 820);
      win.show(); win.moveTop(); win.focus();
    }
  } catch {}
  const state = { windowId: win.id, focused: win.isFocused(), bounds: win.getBounds(),
    views: win.contentView.children.filter(v => v.webContents && v.webContents !== win.webContents)
      .map(v => ({ bounds: v.getBounds(), url: v.webContents.getURL(), visible: v.getVisible ? v.getVisible() : null })) };
  const key = JSON.stringify(state);
  if (key !== previous) { fs.writeFileSync(path.join(dir, 'native.json'), key); previous = key; }
  try {
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'shot-request.json')));
    if (!capturing && /^[a-z-]{1,48}$/.test(request.name) && request.name !== shot) {
      capturing = true; shot = request.name;
      const png = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, shot + '.png'), png.toPNG());
      capturing = false;
    }
  } catch {}
}, 100);
timer.unref();
app.on('will-quit', () => clearInterval(timer));
require('./live-test-launch');
