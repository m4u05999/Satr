'use strict';

/**
 * نافذة مساعدة لمسبار إخفاء المؤشر.
 * تُشغَّل في عملية Electron منفصلة كي تظهر لـ desktopCapturer في العملية الأم،
 * لأن نوافذ العملية الحالية لا تُدرَج أحياناً عند استدعاء getSources.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'cursor-hide-probe');
const W = 640;
const H = 480;

// عزل بيانات المستخدم كي لا يتعارض المساعد مع العملية الأم
app.setPath('userData', path.join(OUT_DIR, 'helper-user-data'));

function checkerboardHtml() {
  return `<!doctype html>
<html dir="ltr"><head><meta charset="utf-8"><style>
body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000}
#cb{display:block}
#probe-dot{position:fixed;left:6px;top:6px;width:2px;height:2px;background:#ff0000;z-index:2147483647}
</style></head><body>
<canvas id="cb" width="${W}" height="${H}"></canvas>
<div id="probe-dot"></div>
<script>
const c=document.getElementById('cb'),x=c.getContext('2d'),s=80;
for(let i=0;i<Math.ceil(c.width/s);i++)for(let j=0;j<Math.ceil(c.height/s);j++){
  x.fillStyle=(i+j)%2?'#ffffff':'#000000';x.fillRect(i*s,j*s,s,s);
}
// نبض بكسلي صغير لإجبار WGC على إنتاج إطارات حتى حين يكون المحتوى ثابتاً
const dot=document.getElementById('probe-dot');
setInterval(()=>{ dot.style.background = dot.style.background === 'rgb(255, 0, 0)' ? '#00ff00' : '#ff0000'; }, 80);
</script>
</body></html>`;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const htmlPath = path.join(OUT_DIR, 'helper-checkerboard.html');
  fs.writeFileSync(htmlPath, checkerboardHtml(), 'utf8');

  const win = new BrowserWindow({
    show: true,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    resizable: false,
    title: 'Satr Cursor Hide Probe Helper',
    backgroundColor: '#000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setContentSize(W, H);
  win.setPosition(300, 200);
  win.show();
  win.focus();
  await win.loadURL('file:///' + htmlPath.replace(/\\/g, '/'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  win.show();
  win.focus();

  const id = win.getMediaSourceId();
  const bounds = win.getBounds();
  console.log(`MEDIA_SOURCE_ID:${id}`);
  console.log(`BOUNDS:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'exit') {
      rl.close();
      win.destroy();
      app.exit(0);
    }
  });
});

app.on('window-all-closed', () => {});
