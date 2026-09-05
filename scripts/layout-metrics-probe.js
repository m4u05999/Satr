/**
 * OBS-129 — مسبار: من أين يأتي عرض لقطة `full_page`، وهل تغيّر بين إصدارَي Chromium؟
 *
 * `electron/preview.js:1351` يشتقّ عرض القُصاصة من `Page.getLayoutMetrics().cssContentSize`
 * لا من `window.innerWidth`، بينما حارس `preview-member-live` يقارن الناتج بـ`innerWidth`.
 * والفارق المرصود `700 − 685 = 15` يساوي عرض شريط التمرير — فالسؤال المقيس هنا:
 * أيّهما يساوي `cssContentSize.width`؟
 *
 * **بلا `Page.captureScreenshot` عمداً**: الالتقاط يحتاج سطحاً مرسوماً، وهو ما علّق
 * محاولةً سابقة في نافذة مخفية. أما `getLayoutMetrics` فاستعلام رخيص لا يحتاجه — وهو
 * وحده مصدر العرض المتنازع عليه، فالقياس يعزل السؤال بدل أن يجرّ معه سبب التعليق.
 *
 * تشخيصيّ لا حارس. يُشغَّل بالأمر نفسه في الشجرتين فيُقارَن رقمٌ برقم.
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'layout-metrics.html');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await win.loadFile(FIXTURE);
    // الارتفاع بـCSSOM لا بسمة `style` في الـfixture: حارس التصميم يرفض السمات المضمّنة
    // في `scripts/fixtures/**` أيضاً — وقد أسقط الطقمَ فعلاً حين كانت في الملف.
    await win.webContents.executeJavaScript(
      "document.getElementById('tall').style.height = '3000px'", true);
    win.setContentSize(700, 600);
    await delay(400);

    const dom = await win.webContents.executeJavaScript(`({
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollbar: window.innerWidth - document.documentElement.clientWidth,
      dpr: window.devicePixelRatio,
    })`, true);

    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    dbg.detach();

    const css = metrics.cssContentSize || {};
    const legacy = metrics.contentSize || {};
    const vp = metrics.cssLayoutViewport || metrics.layoutViewport || {};
    // نفس السطر الذي يبنيه preview.js لعرض القُصاصة
    const clipWidth = Math.max(1, Math.ceil((metrics.cssContentSize || metrics.contentSize || {}).width || 0));

    console.log('electron=' + process.versions.electron + ' chrome=' + process.versions.chrome);
    console.log('  DOM: innerWidth=' + dom.innerWidth + ' · clientWidth=' + dom.clientWidth
      + ' · scrollWidth=' + dom.scrollWidth + ' · شريط التمرير=' + dom.scrollbar + ' · dpr=' + dom.dpr);
    console.log('  CDP: cssContentSize.width=' + css.width + ' · contentSize.width=' + legacy.width
      + ' · cssLayoutViewport.clientWidth=' + vp.clientWidth);
    console.log('  عرض القُصاصة كما يبنيه preview.js = ' + clipWidth);
    console.log('  ⇒ يساوي innerWidth؟ ' + (clipWidth === dom.innerWidth ? 'نعم' : 'لا')
      + '  ·  يساوي clientWidth؟ ' + (clipWidth === dom.clientWidth ? 'نعم' : 'لا'));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

process.on('uncaughtException', (e) => { console.error('layout-metrics-probe: فشل —', (e && e.stack) || e); app.exit(1); });
main().then(() => app.exit(0)).catch((e) => { console.error('layout-metrics-probe: فشل —', (e && e.message) || e); app.exit(1); });
