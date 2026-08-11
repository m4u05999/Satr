/**
 * حارس Chromium حي لهندسة الأسطح الجانبية تحت RTL. يحمّل المكوّنين الحقيقيين
 * داخل fixture مؤقتة ذات CSP صارم، ويحاكي السحب ولوحة المفاتيح بإحداثيات فيزيائية.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');

const TIMEOUT_MS = 30000;
const ROOT = path.resolve(__dirname, '..');
app.commandLine.appendSwitch('disable-gpu');

function fileUrl(relativePath) {
  return pathToFileURL(path.join(ROOT, relativePath)).href;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDrawerShellContract() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/chatColumnEl\.inert\s*=\s*active/.test(source), 'قشرة التطبيق لا تربط inert بحالة drawer.');
  assert(/previewEl\.holdForDrawer\(active\)/.test(source), 'قشرة التطبيق لا تحجب المعاينة الأصلية أثناء drawer.');
  assert(/record\.source\.isConnected[\s\S]{0,180}record\.source\.focus\(\)/.test(source),
    'منسق الأسطح لا يحرس استعادة التركيز بعد إغلاق drawer.');
}

function writeFixture(directory) {
  const baseCss = escapeAttribute(fileUrl('src/styles/base.css'));
  const fontsCss = escapeAttribute(fileUrl('src/vendor/fonts.css'));
  const opsModule = escapeAttribute(fileUrl('src/ui/components/ops-room.js'));
  const previewModule = escapeAttribute(fileUrl('src/ui/components/preview-panel.js'));
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' file:; style-src 'self' file:; font-src 'self' file: data:; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'">
  <title>حارس هندسة RTL</title>
  <link rel="stylesheet" href="${fontsCss}">
  <link rel="stylesheet" href="${baseCss}">
</head>
<body>
  <button id="opener" type="button">افتح غرفة العمليات</button>
  <button id="previewToggle" type="button">افتح المعاينة</button>
  <input id="cwd" type="text" value="C:\\fixture" hidden>
  <div id="midRow">
    <div id="chatColumn"><button id="chatAction" type="button">إجراء المحادثة</button></div>
    <satr-ops-room id="room"></satr-ops-room>
    <satr-preview-panel id="preview"></satr-preview-panel>
  </div>
  <script src="bridge.js"></script>
  <script type="module" src="${opsModule}"></script>
  <script type="module" src="${previewModule}"></script>
</body>
</html>`;
  const bridge = `
window.__rtlGeometry = { bounds: [], violations: [] };
const geometrySheet = new CSSStyleSheet();
geometrySheet.replaceSync('#midRow { margin-inline-end: var(--space-7); }');
document.adoptedStyleSheets = [...document.adoptedStyleSheets, geometrySheet];
const ok = async () => ({ ok: true });
window.satr = new Proxy({
  onPreview: () => {}, onPromoCapture: () => {},
  previewOpen: ok, previewOpenAgent: ok, previewNavigate: ok, previewNavigateAgent: ok,
  previewBounds: (x, y, w, h) => window.__rtlGeometry.bounds.push({ x, y, w, h }),
  executionTeamLatest: async () => ({ ok: true, team: null }),
  executionReviewLatest: async () => ({ ok: true, review: null }),
  executionVerificationLatest: async () => ({ ok: true, verification: null }),
  opsBrainstormLatest: async () => ({ ok: true, run: null }),
  opsPlanLatest: async () => ({ ok: true, run: null }),
  loopLatest: async () => ({ ok: true, loop: null }),
  opsRoomHistory: async () => ({ ok: true, rooms: [] }),
}, { get: (target, key) => key in target ? target[key] : ok });
window.addEventListener('securitypolicyviolation', (event) => {
  window.__rtlGeometry.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
});
`;
  fs.writeFileSync(path.join(directory, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(directory, 'bridge.js'), bridge, 'utf8');
  return path.join(directory, 'index.html');
}

async function waitForComponents(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(`
      customElements.get('satr-ops-room') && customElements.get('satr-preview-panel')
        && document.getElementById('room').shadowRoot && document.getElementById('preview').shadowRoot
    `, true);
    if (ready) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة تحميل مكوّني هندسة RTL.');
}

async function runGeometry(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const result = { checks: [], measurements: {}, errors: [] };
    const assertLive = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const frames = async (count = 2) => {
      while (count-- > 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const near = (actual, expected, tolerance = 2) => Math.abs(actual - expected) <= tolerance;
    const settle = async () => { await frames(3); await wait(260); };
    const pointerDrag = async (handle, startX, endX, pointerId) => {
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      handle.hasPointerCapture = () => false;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1, clientX: startX,
      }));
      handle.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1, clientX: endX,
      }));
      handle.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId, pointerType: 'mouse', button: 0, buttons: 0, clientX: endX,
      }));
      await settle();
    };
    const key = async (handle, value) => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }));
      await settle();
    };

    try {
      localStorage.clear();
      const room = document.getElementById('room');
      const preview = document.getElementById('preview');
      const chat = document.getElementById('chatColumn');
      const opener = document.getElementById('opener');
      const roomHandle = room.shadowRoot.querySelector('.resize-handle');
      const previewHandle = preview.shadowRoot.getElementById('pvResizer');

      await room.open('C:\\\\fixture');
      await settle();
      const roomBefore = rect(room);
      const roomHandleRect = rect(roomHandle);
      const roomHandleX = roomHandleRect.left + roomHandleRect.width / 2;
      assertLive(near(roomHandleX, roomBefore.left),
        'مقبض غرفة العمليات ليس على الحافة اليسرى الفيزيائية: handle=' + roomHandleX + ' host=' + JSON.stringify(roomBefore));
      await pointerDrag(roomHandle, roomHandleX, roomHandleX - 72, 11);
      const roomAfterLeft = rect(room);
      assertLive(roomAfterLeft.width >= roomBefore.width + 68,
        'سحب مقبض غرفة العمليات يساراً لم يوسّعها: ' + roomBefore.width + ' -> ' + roomAfterLeft.width);
      result.measurements.opsPointer = {
        edge: 'left', handleX: Math.round(roomHandleX), before: Math.round(roomBefore.width),
        after: Math.round(roomAfterLeft.width), delta: Math.round(roomAfterLeft.width - roomBefore.width),
      };
      result.checks.push('ops-left-edge-left-drag-grows');

      const beforeArrowLeft = rect(room).width;
      await key(roomHandle, 'ArrowLeft');
      const afterArrowLeft = rect(room).width;
      assertLive(afterArrowLeft > beforeArrowLeft, 'ArrowLeft لا يوسّع غرفة العمليات بصرياً نحو اليسار.');
      await key(roomHandle, 'ArrowRight');
      assertLive(near(rect(room).width, beforeArrowLeft, 3), 'ArrowRight لا يعكس خطوة ArrowLeft في غرفة العمليات.');
      await key(roomHandle, 'Home');
      const opsMinimum = Number(roomHandle.getAttribute('aria-valuemin'));
      assertLive(near(rect(room).width, opsMinimum, 2), 'Home لم يصل إلى الحد الأدنى لغرفة العمليات.');
      await key(roomHandle, 'End');
      const opsMaximum = Number(roomHandle.getAttribute('aria-valuemax'));
      assertLive(near(rect(room).width, opsMaximum, 2), 'End لم يصل إلى الحد الأقصى لغرفة العمليات.');
      const opsStorageKey = Object.keys(localStorage).find((name) => name.startsWith('satr_ops_layout:'));
      const opsSaved = opsStorageKey && JSON.parse(localStorage.getItem(opsStorageKey));
      assertLive(opsSaved && near(opsSaved.width, opsMaximum, 2), 'عرض غرفة العمليات النهائي لم يُحفظ مضبوطاً عند الحد الأقصى.');
      room.close();
      await room.open('C:\\\\fixture');
      await settle();
      assertLive(near(rect(room).width, opsMaximum, 2), 'لم يُستعد عرض غرفة العمليات المحفوظ.');
      result.measurements.opsLimits = { minimum: Math.round(opsMinimum), maximum: Math.round(opsMaximum), saved: opsSaved.width };
      result.checks.push('ops-keyboard-limits-storage');

      room.close();
      preview.openWith('http://localhost:4173');
      await settle();
      const previewBefore = rect(preview);
      const previewHandleRect = rect(previewHandle);
      const previewHandleX = previewHandleRect.left + previewHandleRect.width / 2;
      assertLive(near(previewHandleX, previewBefore.right),
        'مقبض المعاينة ليس على الحافة اليمنى الفيزيائية: handle=' + previewHandleX + ' host=' + JSON.stringify(previewBefore));
      await pointerDrag(previewHandle, previewHandleX, previewHandleX + 72, 21);
      const previewAfterRight = rect(preview);
      assertLive(previewAfterRight.width >= previewBefore.width + 68,
        'سحب مقبض المعاينة يميناً لم يوسّعها: ' + previewBefore.width + ' -> ' + previewAfterRight.width);
      result.measurements.previewPointer = {
        edge: 'right', handleX: Math.round(previewHandleX), before: Math.round(previewBefore.width),
        after: Math.round(previewAfterRight.width), delta: Math.round(previewAfterRight.width - previewBefore.width),
      };
      result.checks.push('preview-right-edge-right-drag-grows');

      const beforeArrowRight = rect(preview).width;
      await key(previewHandle, 'ArrowRight');
      const afterArrowRight = rect(preview).width;
      assertLive(afterArrowRight > beforeArrowRight, 'ArrowRight لا يوسّع المعاينة بصرياً نحو اليمين.');
      await key(previewHandle, 'ArrowLeft');
      assertLive(near(rect(preview).width, beforeArrowRight, 3), 'ArrowLeft لا يعكس خطوة ArrowRight في المعاينة.');
      await key(previewHandle, 'Home');
      const previewMinimum = Number(previewHandle.getAttribute('aria-valuemin'));
      assertLive(near(rect(preview).width, previewMinimum, 2), 'Home لم يصل إلى الحد الأدنى للمعاينة.');
      await key(previewHandle, 'End');
      const previewMaximum = Number(previewHandle.getAttribute('aria-valuemax'));
      assertLive(near(rect(preview).width, previewMaximum, 2), 'End لم يصل إلى الحد الأقصى للمعاينة.');
      const previewSaved = Number(localStorage.getItem('satr_preview_w'));
      assertLive(near(previewSaved, previewMaximum, 2), 'عرض المعاينة النهائي لم يُحفظ مضبوطاً عند الحد الأقصى.');
      result.measurements.previewLimits = { minimum: Math.round(previewMinimum), maximum: Math.round(previewMaximum), saved: previewSaved };
      result.checks.push('preview-keyboard-limits-storage');

      await frames(4);
      const box = preview.shadowRoot.getElementById('pvBox');
      const boxRect = rect(box);
      const latestBounds = window.__rtlGeometry.bounds[window.__rtlGeometry.bounds.length - 1];
      assertLive(latestBounds && latestBounds.x === Math.round(boxRect.left),
        'reportBounds لم يحافظ على r.left الفيزيائي: sent=' + JSON.stringify(latestBounds) + ' box=' + JSON.stringify(boxRect));
      result.measurements.reportBounds = { sentX: latestBounds.x, boxLeft: Math.round(boxRect.left), width: latestBounds.w };
      result.checks.push('preview-report-bounds-physical-left');

      preview.holdForDrawer(true);
      await frames(2);
      assertLive(preview.hasAttribute('drawer-held'), 'حجب المعاينة أثناء drawer لم يفعّل drawer-held.');
      assertLive(window.__rtlGeometry.bounds.some((bounds) => bounds.x === 0 && bounds.y === 0 && bounds.w === 0 && bounds.h === 0),
        'حجب drawer لم يرسل مستطيل العرض الأصلي الصفري.');
      preview.holdForDrawer(false);
      await frames(4);
      assertLive(!preview.hasAttribute('drawer-held'), 'استعادة المعاينة بعد drawer أبقت drawer-held.');

      preview.close();
      await room.open('C:\\\\fixture');
      await settle();
      opener.focus();
      await new Promise((resolve) => {
        const onResize = () => { window.removeEventListener('resize', onResize); requestAnimationFrame(resolve); };
        window.addEventListener('resize', onResize);
        window.resizeTo(650, 760);
        setTimeout(resolve, 500);
      });
      await settle();
      assertLive(room.hasAttribute('drawer'), 'غرفة العمليات لم تتحول إلى drawer تحت 44rem.');
      assertLive(room.getAttribute('role') === 'dialog' && room.getAttribute('aria-modal') === 'true',
        'drawer لا يعلن dialog حاجباً.');
      assertLive(roomHandle.tabIndex === -1 && getComputedStyle(roomHandle).display === 'none',
        'مقبض تغيير العرض بقي متاحاً داخل drawer.');
      chat.inert = true;
      room.focusInitial();
      await frames(2);
      assertLive(room.shadowRoot.activeElement === room.shadowRoot.querySelector('.close'),
        'التركيز الأولي في drawer لم يصل إلى زر الإغلاق.');
      const drawerWidth = rect(room).width;
      room.close();
      chat.inert = false;
      opener.focus();
      assertLive(document.activeElement === opener && !chat.inert, 'إغلاق drawer لم يسمح باستعادة التركيز وفك inert.');
      result.measurements.drawer = { width: Math.round(drawerWidth), viewport: Math.round(innerWidth) };
      result.checks.push('drawer-focus-inert-preview-hold');

      assertLive(window.__rtlGeometry.violations.length === 0,
        'رُصدت مخالفات CSP: ' + JSON.stringify(window.__rtlGeometry.violations));
      result.checks.push('zero-csp-violations');
      result.pass = true;
    } catch (error) {
      result.pass = false;
      result.error = error && error.stack ? error.stack : String(error);
    }
    return result;
  })()`, true);
}

async function main() {
  assertDrawerShellContract();
  await app.whenReady();
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-rtl-geometry-'));
  const fixture = writeFixture(fixtureDirectory);
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'rtl-geometry-' + process.pid + '-' + Date.now(),
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });

  try {
    await win.loadFile(fixture);
    await waitForComponents(win);
    const result = await runGeometry(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل حارس هندسة RTL داخل الصفحة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console: ' + consoleErrors.join('\n'));
    const locale = app.getLocale();
    console.log('rtl-geometry-live: نجح [' + locale + '] ' + JSON.stringify(result.measurements));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('rtl-geometry-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
