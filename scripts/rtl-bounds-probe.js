'use strict';
/**
 * مسبار: هل يعكس Chromium إحداثي x لـWebContentsView في تخطيط RTL؟
 *
 * فرضية بلاغ المستخدم (لقطتان): العرض الأصلي يُوضع عند
 * ‏windowWidth − x − width بدل x، أي مرآة أفقية — يقع حين تكون لغة واجهة
 * التطبيق عربية (views RTL) بينما لا يقع على جهاز تطويرنا (لغة لاتينية).
 *
 * الطريقة: نافذة بعرض معلوم + WebContentsView بلون صريح عند x=0 وعرض ربع النافذة،
 * ثم capturePage وقراءة بكسلات اليسار مقابل اليمين. يُشغَّل مرتين:
 *   node_modules/.bin/electron scripts/rtl-bounds-probe.js          (اللغة الافتراضية)
 *   node_modules/.bin/electron scripts/rtl-bounds-probe.js --ar     (‏--lang=ar)
 */

const { app, BrowserWindow, WebContentsView } = require('electron');

const FORCE_AR = process.argv.includes('--ar');
if (FORCE_AR) app.commandLine.appendSwitch('lang', 'ar');

const WIN_W = 800;
const WIN_H = 400;
const VIEW_W = 200;

app.whenReady().then(async () => {
  // النافذة مرئية إلزاماً: capturePage لا يلتقط العرض الأصلي بلا سطح مرسوم (درس مثبّت)
  const win = new BrowserWindow({
    width: WIN_W, height: WIN_H, show: true,
    webPreferences: { offscreen: false },
  });
  // خلفية بيضاء صريحة كي يتميّز لون العرض عنها
  await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#ffffff"></body>'));

  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(view);
  // العرض الأصلي: أحمر خالص، نضعه عند x=0 (أقصى اليسار الفيزيائي)
  await view.webContents.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#ff0000"></body>'));

  const bounds = { x: 0, y: 0, width: VIEW_W, height: 200 };
  view.setBounds(bounds);
  await new Promise((r) => setTimeout(r, 600));

  // القياس الحقيقي: لقطة شاشة كاملة (‏capturePage لا يلتقط طبقة العرض الأصلي،
  // وwindow.screenX داخل العرض يعيد موضع النافذة لا العرض — كلاهما لا يصلح).
  const { desktopCapturer, screen } = require('electron');
  const contentBounds = win.getContentBounds();
  const display = screen.getDisplayMatching(contentBounds);
  const sf = display.scaleFactor || 1;

  // يقيس موضع الشريط الأحمر فعلياً على الشاشة لمستطيل مطلوب
  const measure = async (reqX) => {
    view.setBounds({ x: reqX, y: 0, width: VIEW_W, height: 200 });
    await new Promise((r) => setTimeout(r, 500));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    const img = sources[0] && sources[0].thumbnail;
    if (!img || img.isEmpty()) return { reqX, error: 'no_capture' };
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const k = size.width / display.size.width; // نسبة اللقطة إلى إحداثيات DIP
    const isRed = (i) => bmp[i + 2] > 190 && bmp[i + 1] < 90 && bmp[i] < 90;
    const y = Math.round((contentBounds.y + 100) * k);
    let first = -1, last = -1;
    for (let x = 0; x < size.width; x++) {
      if (isRed((y * size.width + x) * 4)) { if (first < 0) first = x; last = x; }
    }
    if (first < 0) return { reqX, error: 'red_not_found' };
    return {
      reqX,
      screenXdip: Math.round(first / k),
      widthDip: Math.round((last - first + 1) / k),
      xInsideWindow: Math.round(first / k) - contentBounds.x,
    };
  };

  const a = await measure(0);              // أقصى اليسار
  const b = await measure(400);            // موضع ثانٍ — فحص ذاتي للحساسية
  const mirrored = (x) => contentBounds.width - x - VIEW_W;
  const near = (p, q) => typeof p === 'number' && Math.abs(p - q) <= 12;
  const sensitive = a.xInsideWindow !== undefined && b.xInsideWindow !== undefined
    && Math.abs(a.xInsideWindow - b.xInsideWindow) > 12;

  console.log(JSON.stringify({
    forcedArabic: FORCE_AR,
    appLocale: app.getLocale(),
    contentBounds,
    scaleFactor: sf,
    measuredAtX0: a,
    measuredAtX400: b,
    probeSensitive: sensitive, // إن كان false فالمسبار لا يقيس شيئاً
    verdict: !sensitive ? 'PROBE_BROKEN (القياس غير حساس لتغيّر المستطيل)'
      : near(a.xInsideWindow, 0) && near(b.xInsideWindow, 400) ? 'NO_MIRROR (x يُطبَّق كما هو)'
        : near(a.xInsideWindow, mirrored(0)) && near(b.xInsideWindow, mirrored(400))
          ? 'MIRRORED (x يُقاس من اليمين — تأكيد الفرضية)'
          : 'OFFSET_OTHER (انزياح بمقدار آخر)',
  }, null, 2));

  view.webContents.close();
  win.destroy();
  app.quit();
});

app.on('window-all-closed', () => {});
