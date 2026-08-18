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

  // preview.open يقبل http/https حصراً — نخدم صفحة بلون العلامة من خادم محلي حقيقي.
  // OBS-019: العلامة magenta لا أحمر — الأحمر شائع في الواجهات فيصادم القياس
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<body style="margin:0;background:#ff00ff"></body>');
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
    // BGRA: العلامة magenta — أحمر وأزرق مرتفعان وأخضر منخفض
    const isMark = (i) => bmp[i + 2] > 190 && bmp[i] > 190 && bmp[i + 1] < 90;
    const y = Math.round((contentBounds.y + 120) * k);
    // OBS-019: المسح محصور بعرض نافذة الاختبار وحدها. المسح الكامل للشاشة كان
    // يلتقط أي بكسل مطابق في نافذة أخرى (رُصد `x:1282,width:3`) فيفشل الاختبار بيئياً
    const xFrom = Math.max(0, Math.round(contentBounds.x * k));
    const xTo = Math.min(size.width, Math.round((contentBounds.x + contentBounds.width) * k));
    let first = -1, last = -1;
    for (let x = xFrom; x < xTo; x++) {
      if (isMark((y * size.width + x) * 4)) { if (first < 0) first = x; last = x; }
    }
    if (first < 0) return null;
    return { x: Math.round(first / k) - contentBounds.x, width: Math.round((last - first + 1) / k) };
  };

  const results = [];
  let failures = 0;
  let blind = 0;
  for (const c of CASES) {
    preview.setBounds({ x: c.x, y: 60, width: c.width, height: 240 });
    try { win.moveTop(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    const m = await measure();
    if (!m) blind++;
    const okX = m && Math.abs(m.x - c.x) <= 12;
    const okW = m && Math.abs(m.width - c.width) <= 12;
    if (!okX || !okW) failures++;
    results.push({ requested: c, measured: m, ok: !!(okX && okW) });
  }

  const locale = app.getLocale();
  console.log(JSON.stringify({ locale, results }, null, 2));
  if (failures === 0) {
    console.log(`rtl-preview-fix-test: نجح — العرض الأصلي في موضعه الصحيح (locale=${locale})`);
  } else if (blind === failures) {
    // تمييز لازم: لا علامة أصلاً ≠ علامة في المكان الخطأ (OBS-019)
    console.log(`rtl-preview-fix-test: فشل — لم تُرصد العلامة داخل نافذة الاختبار في ${blind} حالة (locale=${locale}).`);
    console.log('   السبب البيئي المرجّح: النافذة محجوبة بنافذة أخرى، أو الشاشة مقفلة/منامة، أو التشغيل بلا سطح مرئي.');
  } else {
    console.log(`rtl-preview-fix-test: فشل — ${failures} حالة خارج الموضع (locale=${locale})`
      + (blind ? ` (منها ${blind} بلا علامة مرصودة)` : ''));
  }

  try { preview.close(); } catch {}
  try { server.close(); } catch {}
  win.destroy();
  app.exit(failures === 0 ? 0 : 1);
});

app.on('window-all-closed', () => {});
