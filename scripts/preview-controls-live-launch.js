'use strict';
// خطافات تشخيص محصورة بالتجربة: قراءة العرض الأصلي وطلب setViewport الإنتاجي بلا IPC جديد.
const fs = require('fs'), path = require('path');
const { app, BrowserWindow } = require('electron');
const core = require('./lib/live-test-run');
const repo = path.resolve(__dirname, '..'), run = core.loadRun(repo, process.argv[2]);
const dir = path.join(run.paths.root, 'preview-controls');
let busy = false, lastRequest = '', stateSequence = 0;
function write(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
function timeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('probe_timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}
async function inspect(win) {
  const views = [];
  for (const view of win.contentView.children.filter(item => item.webContents && item.webContents !== win.webContents)) {
    const wc = view.webContents;
    if (wc.isDestroyed()) continue;
    let page = null;
    try {
      page = await timeout(wc.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState,focus:document.hasFocus(),visualWidth:visualViewport.width,online:navigator.onLine,url:location.href,ready:document.readyState,probe:window.__previewControls||null})', true), 1200);
    } catch {}
    views.push({ id: wc.id, bounds: view.getBounds(), visible: view.getVisible ? view.getVisible() : null,
      url: wc.getURL(), destroyed:wc.isDestroyed(), throttling:wc.getBackgroundThrottling(), loading: wc.isLoading(), devtools: wc.isDevToolsOpened(), debuggerAttached: wc.debugger.isAttached(), page });
  }
  return { sequence: ++stateSequence, time: new Date().toISOString(), windowId: win.id,
    bounds: win.getBounds(), focused: win.isFocused(), visible:win.isVisible(), minimized:win.isMinimized(), alwaysOnTop:win.isAlwaysOnTop(), visibleOnAllWorkspaces:win.isVisibleOnAllWorkspaces(), views };
}
const timer = setInterval(async () => {
  if (busy) return;
  const win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed() && item.webContents.getURL().endsWith('/src/index.html'));
  if (!win) return;
  busy = true;
  try {
    let request = null;
    try { request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')); } catch {}
    if (request && /^[a-z0-9-]{1,80}$/.test(request.id || '') && request.id !== lastRequest) {
      lastRequest = request.id;
      let result;
      try {
        if (request.action === 'window') {
          if (![1000, 1180, 1440].includes(request.width)) throw Error('bad_width');
          win.setSize(request.width, 820); if(request.alwaysOnTop===true)win.setAlwaysOnTop(true); win.show(); win.moveTop(); win.focus();
          result = { ok: true };
        } else if (request.action === 'set-viewport') {
          if (!Number.isInteger(request.width) || !Number.isInteger(request.height)) throw Error('bad_viewport');
          result = await require('../electron/preview').setViewport(request.width, request.height);
        } else if (request.action === 'detach-debugger') {
          const view = win.contentView.children.find(item => item.webContents && item.webContents !== win.webContents);
          if (!view || view.webContents.isDestroyed()) throw Error('preview_closed');
          const before = view.webContents.debugger.isAttached();
          view.webContents.debugger.detach();
          result = { before, after: view.webContents.debugger.isAttached() };
        } else if (request.action === 'network-probe') {
          const view = win.contentView.children.find(item => item.webContents && item.webContents !== win.webContents);
          if (!view || view.webContents.isDestroyed()) throw Error('preview_closed');
          const launch = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
          const url = launch.page + '/one?network-probe=' + Date.now();
          result = await timeout(view.webContents.executeJavaScript('(async()=>{const online=navigator.onLine;try{const response=await fetch(' + JSON.stringify(url) + ',{cache:"no-store",signal:AbortSignal.timeout(2000)});return {online,fetch:response.ok,status:response.status}}catch(error){return {online,fetch:false,error:error.name}}})()', true), 3000);
        } else if (request.action === 'readability') {
          result = await require('../electron/preview').readability();
        } else if (request.action === 'shot') {
          if (!/^[a-z0-9-]{1,60}$/.test(request.name || '')) throw Error('bad_shot_name');
          const image = await timeout(win.capturePage(), 5000);
          const file = path.join(dir, request.name + '.png');
          fs.writeFileSync(file, image.toPNG(), { flag: 'wx' });
          result = { ok: true, file: path.basename(file) };
        } else throw Error('bad_action');
      } catch (error) { result = { error: error.message }; }
      write(path.join(dir, 'response.json'), { id: request.id, result, time: new Date().toISOString() });
    }
    write(path.join(dir, 'native.json'), await inspect(win));
  } catch (error) {
    write(path.join(dir, 'observer-error.json'), { error: error.message, time: new Date().toISOString() });
  } finally { busy = false; }
}, 100);
timer.unref();
app.on('will-quit', () => clearInterval(timer));
require('./live-test-launch');
