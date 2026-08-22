#!/usr/bin/env electron
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');

const resultFile = path.join(__dirname, '..', 'dist', 'promocapture-events-live-result.json');
const result = { ok: false, cases: {}, error: '' };
let windowRef = null;
let finished = false;

function writeResult() {
  try {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
  } catch {}
}

function finish(code) {
  if (finished) return;
  finished = true;
  writeResult();
  // خاتمة مرئية (قاعدة المشروع: كل حارس يطبع حكمه) — النتيجة الكاملة تبقى في الملف
  // لأن العربية في stdout غير موثوقة، لكن الصمت التام يجعل النجاح والفشل متطابقين للعين.
  const cases = Object.keys(result.cases || {}).length;
  process.stdout.write(code === 0
    ? `promocapture-events-live: ok — ${cases} حالة، ${result.event_count || 0} حدثاً مسجّلاً\n`
    : `promocapture-events-live: FAIL — ${result.error || 'case_failed'}\n`);
  try { preview.setCaptureEventSink(null); preview.destroy(); } catch {}
  try { if (windowRef && !windowRef.isDestroyed()) windowRef.destroy(); } catch {}
  app.exit(code);
}

process.on('uncaughtException', (error) => {
  result.error = String((error && error.stack) || error);
  finish(1);
});
process.on('unhandledRejection', (error) => {
  result.error = String((error && error.stack) || error);
  finish(1);
});
app.on('window-all-closed', () => {});
setTimeout(() => { result.error = 'timeout_20s'; finish(1); }, 20000).unref();

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pointFor(kind) {
  return windowRef.webContents.executeJavaScript(`(function(kind){
    if(kind==='iframe'){var frame=document.getElementById('frame'),button=frame.contentDocument.getElementById('inside'),fr=frame.getBoundingClientRect(),br=button.getBoundingClientRect();return{x:Math.round(fr.left+br.left+br.width/2),y:Math.round(fr.top+br.top+br.height/2)};}
    var r=document.getElementById(kind).getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })(${JSON.stringify(kind)})`, true);
}

async function click(kind) {
  const point = await pointFor(kind);
  windowRef.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y, movementX: 1, movementY: 1 });
  windowRef.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  windowRef.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(180);
}

async function main() {
  await app.whenReady();
  windowRef = new BrowserWindow({
    show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const html = `<!doctype html><meta charset="utf-8"><style>button,iframe{position:absolute;width:120px;height:80px}#normal{left:20px;top:20px}#stop{left:180px;top:20px}#frame{left:340px;top:20px;border:0}</style><button id="normal">normal</button><button id="stop">stop</button><iframe id="frame" srcdoc="<button id='inside' style='width:100px;height:60px'>iframe</button>"></iframe><script>document.getElementById('stop').addEventListener('mousedown',function(e){e.stopPropagation();});</script>`;
  await windowRef.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await delay(250);
  const events = [];
  preview.setExternalTargetProvider(() => windowRef.webContents, () => {});
  preview.attachExternalWebContents(windowRef.webContents);
  preview.setCaptureEventSink((event) => events.push(event));
  await delay(250);
  for (const kind of ['normal', 'stop', 'iframe']) await click(kind);
  const down = events.filter((item) => item.action === 'mousedown');
  const move = events.filter((item) => item.action === 'mousemove');
  result.cases = {
    normal: down.some((item) => item.document_id === 'd1' && item.pointer),
    stopPropagation: down.length >= 2,
    iframe: down.some((item) => item.document_id !== 'd1'),
    mousemove: move.length >= 3,
    isolatedWorld: preview._internals.AGENT_WORLD_ID === 1013,
  };
  const beacon = await preview.showCaptureBeacon(windowRef.webContents, 'start');
  const marker = await windowRef.webContents.executeJavaScript(`(function(){var el=document.querySelector('[data-satr-capture-beacon="start"]');return el?getComputedStyle(el).backgroundColor:'';})()`, true);
  result.cases.beacon = !!(beacon && beacon.ok && marker === 'rgb(248, 248, 248)');
  result.event_count = events.length;
  result.ok = Object.values(result.cases).every(Boolean);
  if (!result.ok) result.error = 'case_failed';
  finish(result.ok ? 0 : 1);
}

main().catch((error) => {
  result.error = String((error && error.stack) || error);
  finish(1);
});
