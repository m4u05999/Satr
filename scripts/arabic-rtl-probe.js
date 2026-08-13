/**
 * مسبار اتجاه العربية في مكوّنات الواجهة — يثبت العطل حيّاً قبل أي إصلاح.
 *
 * مبدأ المشروع: لا عقد مجمَّد بلا استدعاء حيّ، ولا إصلاح على أساس عدّ ساكن.
 * التشغيل: npx electron scripts/arabic-rtl-probe.js
 */
'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'arabic-rtl.html');

process.on('uncaughtException', (error) => {
  console.error('arabic-rtl-probe: FAIL:', error && error.stack || error);
  process.exit(1);
});

const guard = setTimeout(() => {
  console.error('arabic-rtl-probe: FAIL — تجاوز المهلة');
  process.exit(1);
}, 40000);
guard.unref();

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(FIXTURE);
  await new Promise((r) => setTimeout(r, 600));
  const rows = await win.webContents.executeJavaScript('window.__arabicRtl()');

  console.log('\nقياس رسو أول محرف في عناوين لوحة /جلسات (‏.sess .t):\n');
  let broken = 0;
  for (const row of rows) {
    const expected = 'rtl'; // كل العناوين الثلاثة عربية الجوهر
    const ok = row.anchor === expected;
    if (!ok) broken += 1;
    console.log((ok ? '  ✅ ' : '  ❌ ') + row.anchor.padEnd(8)
      + '| يمين ' + Math.round(row.fromRight) + 'px · يسار ' + Math.round(row.fromLeft) + 'px'
      + ' | ' + row.text);
  }
  console.log('\nالنتيجة: ' + broken + ' من ' + rows.length + ' عنواناً رست على الاتجاه الخطأ.');
  win.destroy();
  process.exit(0);
}).catch((error) => {
  console.error('arabic-rtl-probe: FAIL:', error && error.stack || error);
  process.exit(1);
});
