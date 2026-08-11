'use strict';
/**
 * اختبار حي: هل يضع preview.js العرض الأصلي في مكانه الصحيح تحت لغة RTL؟
 *
 * يشغّل الوحدة الإنتاجية نفسها (electron/preview.js) داخل نافذة مرئية ويقيس
 * موضع العرض فعلياً من لقطة الشاشة. يُشغَّل مرتين:
 *   electron scripts/rtl-preview-fix-test.js        (اللغة الافتراضية)
 *   electron scripts/rtl-preview-fix-test.js --ar   (‏--lang=ar — حالة المستخدم)
 * المعيار في الحالتين: الموضع المقيس = المطلوب (±12 DIP).
 */

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

if (process.argv.includes('--ar')) app.commandLine.appendSwitch('lang', 'ar');

const WIN_W = 900;
const WIN_H = 420;
const CASES = [
  { x: 0, width: 300 },     // اللوحة على أقصى اليسار
  { x: 380, width: 260 },   // اللوحة في الوسط
  { x: 560, width: 320 },   // اللوحة على اليمين
];

app.whenReady().then(async () => {
  const preview = require('../electron/preview');
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: true });
  await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#ffffff"></body>'));

  // preview.open يقبل http/https حصراً — نخدم صفحة حمراء من خادم محلي حقيقي
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<body style="margin:0;background:#ff0000"></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  preview.open(win, () => {}, 'http://127.0.0.1:' + port + '/');
  await new Promise((r) => setTimeout(r, 1200));

  const contentBounds = win.getContentBounds();
  const display = screen.getDisplayMatching(contentBounds);

  const measure = async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    const img = sources[0] && sources[0].thumbnail;
    if (!img || img.isEmpty()) return null;
    const size = img.getSize();
    const bmp = img.toBitmap();
    const k = size.width / display.size.width;
    const isRed = (i) => bmp[i + 2] > 190 && bmp[i + 1] < 90 && bmp[i] < 90;
    const y = Math.round((contentBounds.y + 120) * k);
    let first = -1, last = -1;
    for (let x = 0; x < size.width; x++) {
      if (isRed((y * size.width + x) * 4)) { if (first < 0) first = x; last = x; }
    }
    if (first < 0) return null;
    return { x: Math.round(first / k) - contentBounds.x, width: Math.round((last - first + 1) / k) };
  };

  const results = [];
  let failures = 0;
  for (const c of CASES) {
    preview.setBounds({ x: c.x, y: 60, width: c.width, height: 240 });
    await new Promise((r) => setTimeout(r, 500));
    const m = await measure();
    const okX = m && Math.abs(m.x - c.x) <= 12;
    const okW = m && Math.abs(m.width - c.width) <= 12;
    if (!okX || !okW) failures++;
    results.push({ requested: c, measured: m, ok: !!(okX && okW) });
  }

  const locale = app.getLocale();
  console.log(JSON.stringify({ locale, results }, null, 2));
  console.log(failures === 0
    ? `rtl-preview-fix-test: نجح — العرض الأصلي في موضعه الصحيح (locale=${locale})`
    : `rtl-preview-fix-test: فشل — ${failures} حالة خارج الموضع (locale=${locale})`);

  try { preview.close(); } catch {}
  try { server.close(); } catch {}
  win.destroy();
  app.exit(failures === 0 ? 0 : 1);
});

app.on('window-all-closed', () => {});
