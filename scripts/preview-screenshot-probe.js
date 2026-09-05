'use strict';

// OBS-112: ترتيب غراي يغيّر عاملاً واحداً بين كل حالتين؛ نافذة جديدة لكل قياس.
// شغّل المصفوفة بعمليات مستقلة كي لا يمنع التعليق قياس الحالة التالية (PowerShell):
// 0..7 | ForEach-Object { & .\node_modules\.bin\electron.cmd scripts/preview-screenshot-probe.js $_ }
// SATR_SHOT_URL لصفحة حقيقية، وSATR_SHOT_PROBE_MS=40000 لقياس مهلة الإنتاج كاملة.
const { app, BrowserWindow, nativeImage } = require('electron');
const preview = require('../electron/preview');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-shot-probe-'));
app.setPath('userData', temp);
process.on('exit', () => { try { fs.rmSync(temp, {recursive:true,force:true}); } catch {} });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = [[true,false,false],[true,false,true],[true,true,true],[true,true,false],
  [false,true,false],[false,true,true],[false,false,true],[false,false,false]];
app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  console.log('Electron=' + process.versions.electron);
  const server = http.createServer((req,res) => {
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<!doctype html><body>' + '<p>Screenshot measurement 0123456789</p>'.repeat(req.url === '/long' ? 1800 : 3) + '</body>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  for (const [visible, attached, long] of (process.argv[2] ? [cases[Number(process.argv[2])]] : cases)) {
    const win = new BrowserWindow({show:false, width:1000, height:800,
      webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false}});
    if (visible && !process.env.SATR_SHOT_SHOW_AFTER_LOAD) win.showInactive();
    preview.setBounds({x:0,y:0,width:960,height:720});
    const url = process.env.SATR_SHOT_URL || 'http://127.0.0.1:' + server.address().port + (long ? '/long' : '/short');
    preview.open(win, () => {}, url);
    const wc = win.contentView.children[0].webContents;
    if (wc.isLoading()) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe_load_timeout')), 30000);
      wc.once('did-stop-loading', () => { clearTimeout(timer); resolve(); });
    });
    if (visible && process.env.SATR_SHOT_SHOW_AFTER_LOAD) win.showInactive();
    await delay(300);
    if (attached) wc.debugger.attach('1.3');
    if (process.env.SATR_SHOT_DEVTOOLS) { wc.openDevTools({mode:'detach'}); await delay(500); }
    let stage = 'start';
    const sendCommand = wc.debugger.sendCommand.bind(wc.debugger);
    wc.debugger.sendCommand = (method, params) => {
      stage = method;
      if (process.env.SATR_SHOT_BEYOND_FALSE && method === 'Page.captureScreenshot') params.captureBeyondViewport = false;
      return sendCommand(method, params);
    };
    const start = Date.now();
    let timer;
    const result = await Promise.race([preview.screenshotFull(), new Promise(resolve => {
      timer = setTimeout(() => resolve({error:'probe_deadline'}), Number(process.env.SATR_SHOT_PROBE_MS || 12000));
    })]);
    clearTimeout(timer);
    const {base64, ...metadata} = result;
    console.log(JSON.stringify({visible,attached,long,stage,devtools:wc.isDevToolsOpened(),
      showAfterLoad:!!process.env.SATR_SHOT_SHOW_AFTER_LOAD,ms:Date.now()-start,...metadata,
      size:base64 ? nativeImage.createFromBuffer(Buffer.from(base64,'base64')).getSize() : null,
      debuggerAfter:wc.debugger.isAttached()}));
    if (result.error === 'probe_deadline') { app.exit(2); return; }
    preview.destroy(); win.destroy();
  }
  server.close();
}
main().then(() => app.exit(0)).catch(e => { console.error(e); app.exit(1); });
