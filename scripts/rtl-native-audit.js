'use strict';
/**
 * فحص شامل للطبقات الأصلية تحت لغة واجهة RTL — بحثاً عن «أشقّاء» عطل مرآة x.
 *
 * الخلفية (درس مثبّت): حين تكون لغة واجهة التطبيق RTL يعكس Chromium إحداثي x
 * لطبقة العرض الأصلي (WebContentsView) فيضعه عند contentWidth − x − width.
 * أُصلح في electron/preview.js (‏isRtlUi/nativeBounds/applyBounds). هذه الأداة
 * تسأل: هل للعطل نظائر في المسارات المجاورة التي لم يغطّها الحارس؟
 *
 * الأهداف الستة:
 *   1. محاكاة الأجهزة (كامل/موبايل/لوحي) × موضعَي لوحة — تفاعلها مع تعويض المرآة
 *   2. viewportOverride (‏browser_set_viewport): الموضع + صدق innerWidth المعاد
 *   3. حجب/استعادة الحوار (‏setBounds صفري ثم استعادة)
 *   4. تغيّر حجم النافذة والعرض مفتوح (حارس resize)
 *   5. promocapture.js: حدود نافذة الالتقاط ومصدرها
 *   6. browser_screenshot_element: مستطيل العنصر ⇒ capturePage(rect)
 *
 * القياس: لقطة شاشة كاملة عبر desktopCapturer والبحث عن لون صريح — لأن
 * ‏capturePage لا يلتقط طبقة العرض الأصلي وwindow.screenX داخلها يعيد موضع
 * النافذة لا العرض (كلاهما مسدود — درسان مثبّتان). ولكل هدف **فحص حساسية ذاتي**:
 * قياسان مختلفان يجب أن يختلفا، وإلا فالمسبار معطوب ولا يُعلن «سليم».
 *
 * التشغيل (نافذة مرئية إلزامية):
 *   node_modules/.bin/electron scripts/rtl-native-audit.js         (اللغة الافتراضية)
 *   node_modules/.bin/electron scripts/rtl-native-audit.js --ar    (‏--lang=ar)
 * رمز الخروج: 0 إن اجتاز الجميع، وغير صفري إن فشل هدف أو عطب مسباره.
 */

const { app, BrowserWindow, desktopCapturer, screen, nativeImage, session } = require('electron');
const http = require('node:http');

const FORCE_AR = process.argv.includes('--ar');
if (FORCE_AR) app.commandLine.appendSwitch('lang', 'ar');

const TOL = 12;          // تسامح DIP (نفس تسامح rtl-preview-fix-test)
const SETTLE_MS = 420;   // مهلة استقرار التركيب قبل اللقطة

// ---------- صفحات الاختبار (خادم محلي — preview.open يقبل http حصراً) ----------
const PAGE_RED = '<body style="margin:0;background:#ff0000"></body>';
// صفحة العنصرين: أحمر يساراً وأزرق يميناً — أي انعكاس في مستطيل اللقطة يقلب اللون
const PAGE_TWO = '<body style="margin:0;background:#ffffff">'
  + '<div id="left" style="position:absolute;left:0;top:0;width:120px;height:100px;background:#ff0000"></div>'
  + '<div id="right" style="position:absolute;right:0;top:0;width:120px;height:100px;background:#0000ff"></div>'
  + '</body>';

const results = [];   // {target, name, expected, measured, ok, note}
const probeBroken = []; // أهداف عطب فيها المسبار (لا يجوز إعلان سلامتها)
let mirrorState = '?';  // MIRRORED | PLAIN | OTHER — من الضبط السلبي (الهدف 0)
let controlOk = false;  // هل طابق الضبط السلبي المتوقّع لهذه اللغة؟

function record(target, name, expected, measured, ok, note) {
  results.push({ target, name, expected, measured, ok: !!ok, note: note || '' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- طبقة القياس ----------
let display = null;
function isRed(b, i) { return b[i + 2] > 190 && b[i + 1] < 90 && b[i] < 90; }

// يلتقط الشاشة ويعيد {bmp,size,k} حيث k = نسبة بكسلات اللقطة إلى DIP
async function grabScreen() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height },
  });
  const img = sources && sources[0] && sources[0].thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  return { bmp: img.toBitmap(), size, k: size.width / display.size.width };
}

function isGreen(b, i) { return b[i + 1] > 150 && b[i + 2] < 110 && b[i] < 110; }

/**
 * يقيس امتداد شريط ملوّن أفقياً عند صفٍّ داخل النافذة، بإحداثيات محتوى النافذة.
 * المسح محصور بالمدى الأفقي للنافذة كي لا يلتقط اللون من خلفية النظام أو نافذة أخرى.
 */
async function measureBar(win, rowInWindow, pred) {
  const cb = win.getContentBounds();
  const g = await grabScreen();
  if (!g) return null;
  const y = Math.round((cb.y + rowInWindow) * g.k);
  if (y < 0 || y >= g.size.height) return null;
  const from = Math.max(0, Math.round(cb.x * g.k));
  const to = Math.min(g.size.width, Math.round((cb.x + cb.width) * g.k));
  let first = -1;
  let last = -1;
  for (let x = from; x < to; x++) {
    if (pred(g.bmp, (y * g.size.width + x) * 4)) { if (first < 0) first = x; last = x; }
  }
  if (first < 0) return null; // لا عرض مرئي في هذا الصف (مثلاً أثناء الحجب)
  return {
    x: Math.round(first / g.k) - cb.x,
    width: Math.round((last - first + 1) / g.k),
  };
}
const measureView = (win, row) => measureBar(win, row, isRed);

/**
 * قياس مستقرّ: مهلة استقرار واحدة ثابتة تجعل الحارس هشّاً (رُصد فشل ~25% من
 * التشغيلات على مركّب بطيء لحظياً)، والحارس الهشّ يدرّب على تجاهل الأحمر. لذلك
 * نعيد القياس حتى يبلغ القيمة المطلوبة أو تنفد المحاولات — **بلا تخفيف الشرط**:
 * الفحص ما زال يوجب المستطيل الصحيح، وإنما يمنح المركّب وقتاً أطول ليصل إليه.
 */
async function measureStable(win, row, want, tries = 5) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await measureView(win, row);
    if (want === null ? last === null : rectOk(last, want)) return last;
    await sleep(220);
  }
  return last;
}

// مقارنة مستطيل مقيس بالمطلوب ضمن التسامح
function rectOk(m, want) {
  return !!m && Math.abs(m.x - want.x) <= TOL && Math.abs(m.width - want.width) <= TOL;
}
const fmt = (m) => (m ? `x=${m.x} w=${m.width}` : 'غائب');

// ---------- الهيكل ----------
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url && req.url.startsWith('/two') ? PAGE_TWO : PAGE_RED);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const urlRed = `http://127.0.0.1:${port}/`;
  const urlTwo = `http://127.0.0.1:${port}/two`;

  const preview = require('../electron/preview');

  // هندسة تتكيّف مع مساحة العمل كي تبقى النافذة كاملة على الشاشة
  const area = screen.getPrimaryDisplay().workArea;
  const winW = Math.max(700, Math.min(1100, area.width - 80));
  const winH = Math.min(460, Math.max(360, area.height - 120));
  const win = new BrowserWindow({ width: winW, height: winH, x: area.x + 40, y: area.y + 40, show: true });
  win.setAlwaysOnTop(true); // لا تحجبه نافذة أخرى أثناء اللقطة
  await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#ffffff"></body>'));
  win.setContentBounds({ x: area.x + 40, y: area.y + 40, width: winW, height: winH });
  await sleep(200);
  display = screen.getDisplayMatching(win.getContentBounds());

  const contentW = win.getContentBounds().width;
  const panelW = Math.max(420, contentW - 260);
  const PANEL_A = { x: 16, y: 70, width: panelW, height: winH - 160 };
  const PANEL_B = { x: contentW - panelW - 16, y: 70, width: panelW, height: winH - 160 };
  const ROW = PANEL_A.y + Math.floor(PANEL_A.height / 2); // صف القياس داخل العرض

  // ═══ الهدف 0: شاهد المرآة (ضبط سلبي — بلا هذا لا يجوز إعلان سلامة أي هدف) ═══
  // طبقة أصلية خام بلا preview.js: إن لم تنعكس تحت ar فالمرآة لم تُستنسخ في هذا
  // الجهاز/الإصدار أصلاً، وكل «سليم» بعدها بلا معنى لأن المسار المعطوب لم يُشغَّل.
  {
    const { WebContentsView } = require('electron');
    const ctrl = new WebContentsView({ webPreferences: { sandbox: true } });
    win.contentView.addChildView(ctrl);
    await ctrl.webContents.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#00cc00"></body>'));
    const CW = 200;
    const probe = async (x) => {
      ctrl.setBounds({ x, y: 70, width: CW, height: 200 });
      await sleep(SETTLE_MS);
      return measureBar(win, 170, isGreen);
    };
    const c0 = await probe(0);
    const c1 = await probe(400);
    const near = (m, v) => !!m && Math.abs(m.x - v) <= TOL;
    const mir = (x) => contentW - x - CW;
    const plain = near(c0, 0) && near(c1, 400);
    const mirrored = near(c0, mir(0)) && near(c1, mir(400));
    mirrorState = mirrored ? 'MIRRORED' : plain ? 'PLAIN' : 'OTHER';
    const want = FORCE_AR ? 'MIRRORED' : 'PLAIN';
    controlOk = mirrorState === want;
    record(0, 'طبقة خام عند x=0', FORCE_AR ? `x=${mir(0)} (منعكس)` : 'x=0', fmt(c0), FORCE_AR ? near(c0, mir(0)) : near(c0, 0));
    record(0, 'طبقة خام عند x=400', FORCE_AR ? `x=${mir(400)} (منعكس)` : 'x=400', fmt(c1), FORCE_AR ? near(c1, mir(400)) : near(c1, 400));
    record(0, 'حالة المرآة في هذه البيئة', want, mirrorState, controlOk,
      controlOk ? (FORCE_AR ? 'العطل مستنسخ فعلاً — الأهداف التالية تختبر المسار الحقيقي' : 'لا مرآة تحت اللغة اللاتينية كما هو متوقّع')
        : 'الضبط السلبي لم يطابق المتوقّع — نتائج الأهداف التالية غير حاسمة');
    try { win.contentView.removeChildView(ctrl); } catch {}
    try { ctrl.webContents.close(); } catch {}
    await sleep(200);
  }

  preview.open(win, () => {}, urlRed);
  await sleep(1300);

  // ═══ الهدف 1: محاكاة الأجهزة × موضعَي لوحة ═══
  // الواجهة (‏preview-panel.js) توسّط عرض الجهاز داخل pvBox ثم تبلّغ المستطيل الناتج؛
  // نحاكي ذلك الحساب حرفياً هنا لأن ملفات src/ خارج ملكيتنا في هذه الجولة.
  const devices = [
    { label: 'كامل', w: 0 },
    { label: 'موبايل', w: 390 },
    { label: 'لوحي', w: 768 },
  ];
  const seen1 = [];
  for (const panel of [{ p: PANEL_A, n: 'لوحة يسار' }, { p: PANEL_B, n: 'لوحة يمين' }]) {
    for (const dev of devices) {
      const w = dev.w ? Math.min(dev.w, panel.p.width) : panel.p.width;
      const want = {
        x: panel.p.x + Math.max(0, Math.floor((panel.p.width - w) / 2)),
        y: panel.p.y,
        width: w,
        height: panel.p.height,
      };
      preview.setBounds(want);
      await sleep(SETTLE_MS);
      const m = await measureStable(win, ROW, want);
      seen1.push(m ? `${m.x}:${m.width}` : 'null');
      record(1, `${panel.n} × ${dev.label}`, `x=${want.x} w=${want.width}`, fmt(m), rectOk(m, want));
    }
  }
  if (new Set(seen1).size < 3) probeBroken.push(1); // القياس لا يتغيّر ⇒ المسبار معطوب

  // ═══ الهدف 3: حجب الحوار ثم الاستعادة ═══
  preview.setBounds(PANEL_A);
  await sleep(SETTLE_MS);
  const before3 = await measureStable(win, ROW, PANEL_A);
  record(3, 'قبل الحجب', `x=${PANEL_A.x} w=${PANEL_A.width}`, fmt(before3), rectOk(before3, PANEL_A));
  preview.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // ما يفعله holdForDialog
  await sleep(SETTLE_MS);
  const held = await measureStable(win, ROW, null);
  record(3, 'أثناء الحجب', 'غائب', fmt(held), held === null);
  preview.setBounds(PANEL_B); // الاستعادة بقياس حيّ (قد يختلف عن السابق)
  await sleep(SETTLE_MS);
  const after3 = await measureStable(win, ROW, PANEL_B);
  record(3, 'بعد الاستعادة', `x=${PANEL_B.x} w=${PANEL_B.width}`, fmt(after3), rectOk(after3, PANEL_B));
  if (before3 && after3 && before3.x === after3.x) probeBroken.push(3);

  // ═══ الهدف 4: تغيّر حجم النافذة والعرض مفتوح ═══
  // نُبقي المستطيل المنطقي كما هو ونغيّر عرض النافذة وحده: حارس resize في
  // preview.js هو ما يجب أن يعيد تطبيق التعويض (عرض المحتوى يدخل الحساب).
  const fixed = { x: 60, y: PANEL_A.y, width: 300, height: PANEL_A.height };
  preview.setBounds(fixed);
  await sleep(SETTLE_MS);
  const r4a = await measureStable(win, ROW, fixed);
  record(4, 'قبل التصغير', `x=${fixed.x} w=${fixed.width}`, fmt(r4a), rectOk(r4a, fixed));
  const narrow = Math.max(560, contentW - 240);
  win.setContentBounds({ x: area.x + 40, y: area.y + 40, width: narrow, height: winH });
  await sleep(SETTLE_MS + 300);
  const r4b = await measureStable(win, ROW, fixed);
  record(4, `بعد التصغير (‏${contentW}→${narrow})`, `x=${fixed.x} w=${fixed.width}`, fmt(r4b), rectOk(r4b, fixed));
  win.setContentBounds({ x: area.x + 40, y: area.y + 40, width: contentW, height: winH });
  await sleep(SETTLE_MS + 300);
  const r4c = await measureStable(win, ROW, fixed);
  record(4, `بعد التوسيع (‏${narrow}→${contentW})`, `x=${fixed.x} w=${fixed.width}`, fmt(r4c), rectOk(r4c, fixed));
  // حساسية: لو كان القياس أعمى لأعطى الرقم نفسه في هدف 1 أيضاً — نتحقق من تمايز مستقل
  if (r4a && seen1.length && `${r4a.x}:${r4a.width}` === seen1[0]) probeBroken.push(4);

  // ═══ الهدف 6: لقطة عنصر واحد (قبل تفعيل viewportOverride كي تبقى الصفحة كاملة) ═══
  preview.setBounds(PANEL_A);
  preview.navigate(urlTwo);
  await sleep(1100);
  const shotColor = async (sel) => {
    const r = await preview.screenshotElement(sel, { emitThumbnail: false });
    if (!r || !r.ok || !r.base64) return { err: (r && r.error) || 'no_shot' };
    const img = nativeImage.createFromBuffer(Buffer.from(r.base64, 'base64'));
    if (img.isEmpty()) return { err: 'empty_png' };
    const size = img.getSize();
    const b = img.toBitmap();
    let red = 0;
    let blue = 0;
    for (let i = 0; i < b.length; i += 4) {
      if (b[i + 2] > 170 && b[i + 1] < 90 && b[i] < 90) red++;
      else if (b[i] > 170 && b[i + 1] < 90 && b[i + 2] < 90) blue++;
    }
    const total = b.length / 4;
    return { size, dominant: red > blue ? 'أحمر' : blue > red ? 'أزرق' : 'مختلط', ratio: Math.round((Math.max(red, blue) / total) * 100) };
  };
  const shotL = await shotColor('#left');
  const shotR = await shotColor('#right');
  record(6, 'لقطة العنصر الأيسر (أحمر)', 'أحمر ≥90%',
    shotL.err ? `خطأ: ${shotL.err}` : `${shotL.dominant} ${shotL.ratio}% ‏(${shotL.size.width}×${shotL.size.height})`,
    !shotL.err && shotL.dominant === 'أحمر' && shotL.ratio >= 90);
  record(6, 'لقطة العنصر الأيمن (أزرق)', 'أزرق ≥90%',
    shotR.err ? `خطأ: ${shotR.err}` : `${shotR.dominant} ${shotR.ratio}% ‏(${shotR.size.width}×${shotR.size.height})`,
    !shotR.err && shotR.dominant === 'أزرق' && shotR.ratio >= 90);
  if (shotL.err || shotR.err || shotL.dominant === shotR.dominant) probeBroken.push(6);

  // ═══ الهدف 2: viewportOverride ═══
  preview.navigate(urlRed);
  await sleep(900);
  const panel2 = PANEL_A;
  preview.setBounds(panel2);
  await sleep(SETTLE_MS);
  const seen2 = [];
  for (const vw of [390, 768]) {
    const res = await preview.setViewport(vw, null);
    await sleep(SETTLE_MS);
    const w = Math.min(vw, panel2.width);
    const want = { x: panel2.x + Math.max(0, Math.floor((panel2.width - w) / 2)), width: w };
    const m = await measureView(win, ROW);
    seen2.push(m ? `${m.x}:${m.width}` : 'null');
    record(2, `موضع العرض عند viewport=${vw}`, `x=${want.x} w=${want.width}`, fmt(m), rectOk(m, want));
    const actual = res && res.ok && res.actual ? res.actual.width : null;
    record(2, `صدق innerWidth عند viewport=${vw}`, String(w),
      res && res.ok ? String(actual) : `خطأ: ${(res && res.error) || 'غائب'}`,
      !!(res && res.ok && actual !== null && Math.abs(actual - w) <= TOL));
  }
  if (new Set(seen2).size < 2) probeBroken.push(2);

  try { preview.close(); } catch {}
  await sleep(300);

  // ═══ الهدف 5: نافذة التقاط البرومو (نافذة علوية مستقلة — المرآة لا تنطبق نظرياً) ═══
  // نشغّل الوحدة الإنتاجية فعلياً حتى لحظة بثّ capture_start (‏بعد إنشاء النافذة
  // وتحديد المصدر ومعالج display media)، ثم نجهض قبل أي تسجيل.
  try {
    const promocapture = require('../electron/promocapture');
    const made = [];
    const BW = function BWProxy(opts) { const w = new BrowserWindow(opts); made.push(w); return w; };
    let started = null;
    const pc = promocapture.create({
      BrowserWindow: BW,
      desktopCapturer,
      isHttpUrl: preview.isHttpUrl,
      displaySession: session.fromPartition('persist:preview'),
      ownerWebContents: win.webContents,
      partition: 'persist:preview',
      defaultUrl: () => urlRed,
      readyDelayMs: 200,
      sourceAttempts: 5,
      emit: (ev) => { if (ev && ev.type === 'capture_start' && !started) started = ev; },
    });
    const aspect = '16:9';
    const want5 = promocapture.ASPECTS[aspect];
    win.setAlwaysOnTop(false); // كي لا نحجب نافذة الالتقاط عن التعداد
    pc.start({ aspect, url: urlRed }).catch(() => {});
    for (let i = 0; i < 60 && !started; i++) await sleep(250); // ننتظر capture_start
    if (!started) {
      record(5, 'بدء الالتقاط', 'حدث capture_start', 'لم يصل خلال 15ث', false);
      probeBroken.push(5);
    } else {
      const cw = made.find((w) => w && !w.isDestroyed());
      const cb = cw ? cw.getContentBounds() : null;
      const disp5 = cb ? screen.getDisplayMatching(cb) : display;
      // نظام النوافذ يقلّص النافذة إن تجاوزت الشاشة — نقبل ذلك ونسمّيه صراحةً
      const clamped = !!(cb && (want5.width > disp5.workArea.width || want5.height > disp5.workArea.height));
      const sizeOk = !!cb && (clamped
        ? cb.width > 0 && cb.height > 0
        : Math.abs(cb.width - want5.width) <= 2 && Math.abs(cb.height - want5.height) <= 2);
      record(5, 'مقاس محتوى نافذة الالتقاط', `${want5.width}×${want5.height}`,
        cb ? `${cb.width}×${cb.height}` : 'غائب', sizeOk,
        clamped ? 'قلّصه نظام النوافذ (الشاشة أصغر من النسبة المطلوبة)' : '');
      record(5, 'حدث capture_start يعلن المقاس المطلوب', `${want5.width}×${want5.height}`,
        `${started.width}×${started.height}`,
        started.width === want5.width && started.height === want5.height);
      const idOk = typeof started.source_id === 'string'
        && /^window:[^:]+:\d+$/.test(started.source_id);
      record(5, 'صيغة معرّف المصدر', 'window:<hwnd>:<n>',
        idOk ? 'مطابقة' : String(started.source_id).slice(0, 40), idOk);
      record(5, 'المصدر مُعدَّد من desktopCapturer', 'true (أو سقوط موثّق)',
        String(started.source_enumerated), true,
        started.source_enumerated ? '' : 'سقط إلى getMediaSourceId المباشر — سلوك موثّق على ويندوز');
      // فحص الحساسية: النافذة موجودة فعلاً ومقاسها ليس مقاس النافذة المضيفة
      if (!cb || (cb.width === win.getContentBounds().width && cb.height === win.getContentBounds().height)) probeBroken.push(5);
      try { pc.rendererAbort(started.session_id, 'audit_done'); } catch {}
    }
    await sleep(300);
    for (const w of made) { try { if (w && !w.isDestroyed()) w.destroy(); } catch {} }
    try { pc.configure({ displaySession: null }); } catch {}
  } catch (e) {
    record(5, 'تشغيل promocapture', 'بلا استثناء', String((e && e.message) || e).slice(0, 80), false);
    probeBroken.push(5);
  }

  // ---------- التقرير ----------
  const locale = app.getLocale();
  const broken = [...new Set(probeBroken)];
  const failed = results.filter((r) => !r.ok);
  const TITLES = {
    0: 'شاهد المرآة (ضبط سلبي)',
    1: 'محاكاة الأجهزة × موضع اللوحة',
    2: 'viewportOverride (‏browser_set_viewport)',
    3: 'حجب الحوار والاستعادة',
    4: 'تغيّر حجم النافذة',
    5: 'نافذة التقاط البرومو',
    6: 'لقطة عنصر واحد',
  };
  console.log('');
  console.log(`فحص الطبقات الأصلية تحت RTL — locale=${locale}  forcedArabic=${FORCE_AR}`);
  console.log('='.repeat(78));
  for (const t of [0, 1, 2, 3, 4, 5, 6]) {
    const rows = results.filter((r) => r.target === t);
    const bad = rows.filter((r) => !r.ok).length;
    // لا يُعلن هدف سليماً إن سقط الضبط السلبي: عندها لم يُشغَّل المسار المشتبه به أصلاً
    const verdict = broken.includes(t) ? '⚠ مسبار معطوب — لا حكم'
      : bad > 0 ? `✗ عطل (${bad})`
        : (t > 0 && !controlOk) ? '⚠ غير حاسم (الضبط السلبي سقط)' : '✓ سليم';
    console.log(`\n[${t}] ${TITLES[t]} — ${verdict}`);
    for (const r of rows) {
      console.log(`    ${r.ok ? '✓' : '✗'} ${r.name}`);
      console.log(`        المطلوب: ${r.expected}   |   المقيس: ${r.measured}${r.note ? '   — ' + r.note : ''}`);
    }
  }
  console.log('\n' + '='.repeat(78));
  console.log(JSON.stringify({
    locale, forcedArabic: FORCE_AR, mirrorState, controlOk,
    probeBroken: broken, failures: failed.length, results,
  }, null, 2));
  const code = failed.length || broken.length || !controlOk ? 1 : 0;
  console.log(code === 0
    ? `rtl-native-audit: نجح — ${results.length} فحصاً بلا عطل (locale=${locale}، المرآة=${mirrorState})`
    : `rtl-native-audit: فشل — ${failed.length} فحصاً خارج المطلوب، ${broken.length} هدفاً بمسبار معطوب`
      + `${controlOk ? '' : '، والضبط السلبي سقط (المرآة=' + mirrorState + ') فالنتائج غير حاسمة'} (locale=${locale})`);

  try { server.close(); } catch {}
  try { preview.destroy(); } catch {}
  try { win.destroy(); } catch {}
  app.exit(code);
});

app.on('window-all-closed', () => {});
