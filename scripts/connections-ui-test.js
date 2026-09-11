// حارس حي للمكوّن الإنتاجي؛ الاستبدال عند حدود IPC فقط، وخادم الاختبار يغلق في النهاية.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startScene } = require('./connections-ui-scene');

async function browserChecks() {
  const scene = window.connectionScene;
  if (!scene) throw new Error('لم يحمل المشهد مكوّن التوصيلات.');
  await scene.ready;
  const { view, host, handlers, calls, response, cwd } = scene;
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const until = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error('انتهت مهلة انتظار الواجهة.'); await pause(); }
  };
  const button = (root, text) => {
    const found = [...root.querySelectorAll('button')].find((el) => el.textContent === text);
    check(found, 'لم يظهر الزر: ' + text);
    return found;
  };
  const card = (id) => host.querySelector('[data-service="' + id + '"]');
  const reset = async () => {
    handlers.connectionList = async () => response();
    await view.open(cwd, 'codex');
  };

  check(host.querySelectorAll('.connection-card').length === 3, 'لم تعرض الخدمات الثلاث.');
  check(card('github').textContent.includes('الحساب مصادق عليه'), 'اختفت حالة المصادقة.');
  check(card('netlify').textContent.includes('يحتاج إعادة المصادقة'), 'اختفت حالة انتهاء المصادقة.');
  check(card('supabase').textContent.includes('لم يربط حساب'), 'اختفت حالة الفصل.');
  check(card('github').textContent.includes('لم يسجل بعد'), 'نجاح اختبار الخدمة أوحى باستعمال المحرك.');
  checks.push('three-states-and-engine-evidence');

  // الاستجابة المتأخرة للمشروع الأول لا يحق لها تغيير مشروع فتح بعده.
  const first = deferred();
  handlers.connectionList = (project) => project.endsWith('project-a') ? first.promise : Promise.resolve(response());
  const oldOpen = view.open(cwd, 'codex');
  const otherCwd = 'D:\\Satr-Scene\\project-b';
  await view.open(otherCwd, 'sdk');
  const stale = response(); stale.services[0].account.label = 'حساب قديم يجب ألا يظهر';
  first.resolve(stale);
  await oldOpen;
  check(!host.textContent.includes('حساب قديم يجب ألا يظهر') && host.textContent.includes(otherCwd),
    'استجابة المشروع القديم استبدلت توصيلات المشروع الحالي.');
  checks.push('stale-project-response-ignored');

  await reset();
  const auth = deferred();
  let observedAuth;
  handlers.connectionAuthenticate = (...args) => { observedAuth = args; return auth.promise; };
  button(card('github'), 'إعادة المصادقة').click();
  const password = card('github').querySelector('input[type=password]');
  const fakeSecret = 'fixture-token-only-never-a-real-credential';
  password.value = fakeSecret;
  button(card('github'), 'تحقق من الحساب واحفظ مشفراً').click();
  check(password.value === '', 'بقي الرمز في الحقل أثناء انتظار المصادقة.');
  check(observedAuth[0] === cwd && observedAuth[1] === 'github' && observedAuth[2] === fakeSecret,
    'لم يصل الرمز إلى حد IPC مع المشروع والخدمة الصحيحين.');
  check(!host.outerHTML.includes(fakeSecret) && !JSON.stringify(calls).includes(fakeSecret),
    'ظهر الرمز في الواجهة أو سجل المشهد.');
  auth.resolve({ ok: false, error: 'auth_expired', message: fakeSecret });
  await until(() => card('github').querySelector('.connection-error'));
  check(card('github').textContent.includes('انتهت المصادقة') && !host.outerHTML.includes(fakeSecret),
    'لم يظهر انتهاء المصادقة برسالة آمنة.');
  checks.push('password-cleared-before-auth-settles');

  await reset();
  handlers.connectionResources = async () => ({ ok: true, resources: [
    { id: 'demo/arabic-notes', label: 'المورد الحالي' },
    { id: 'demo/second-repo', label: 'المورد المختار' },
  ], truncated: true });
  let selected;
  handlers.connectionSelect = (...args) => { selected = args; return Promise.resolve({ ok: false, error: 'forbidden' }); };
  button(card('github'), 'تحديد المورد والصلاحيات').click();
  await until(() => card('github').querySelector('select'));
  check(card('github').textContent.includes('ليست كل موارد الحساب'), 'أخفت الواجهة محدودية قائمة الموارد.');
  card('github').querySelector('select').value = 'demo/second-repo';
  card('github').querySelector('input[type=checkbox]').checked = true;
  button(card('github'), 'حفظ المورد والصلاحيات').click();
  await until(() => selected);
  check(JSON.stringify(selected) === JSON.stringify([cwd, 'github', 'demo/second-repo', ['read', 'write']]),
    'مررت الواجهة حقولاً زائدة أو مورداً وصلاحيات مختلفين عن الاختيار.');
  await until(() => card('github').querySelector('.connection-error'));
  check(card('github').textContent.includes('لا يملك الصلاحية'), 'غابت رسالة رفض صلاحية المورد.');
  checks.push('exact-resource-and-permission-payload');

  // نجاح الفعل يحدّث اللوحة؛ تبديل المشروع أثناء هذا التحديث لا يرث رسالة نجاحه.
  await reset();
  const refresh = deferred();
  let refreshRequested = false;
  handlers.connectionList = (project) => {
    if (project === cwd) { refreshRequested = true; return refresh.promise; }
    return Promise.resolve(response());
  };
  handlers.connectionTest = async () => ({ ok: true });
  button(card('github'), 'اختبار قراءة فعلية').click();
  await until(() => refreshRequested);
  await view.open(otherCwd, 'codex');
  refresh.resolve(response());
  await pause(); await pause();
  check(!host.querySelector('.connection-success') && host.textContent.includes(otherCwd),
    'انتقلت رسالة نجاح المشروع القديم إلى المشروع الجديد أثناء تحديث اللوحة.');
  checks.push('stale-success-refresh-ignored');

  await reset();
  button(card('github'), 'إعادة المصادقة').click();
  const closePassword = card('github').querySelector('input[type=password]');
  closePassword.value = fakeSecret;
  const callsBeforeClose = calls.length;
  view.close();
  check(closePassword.value === '', 'إغلاق اللوحة لم يمح الرمز.');
  button(card('github'), 'تحقق من الحساب واحفظ مشفراً').click();
  check(calls.length === callsBeforeClose, 'نفذ زر تابع للوحة المغلقة طلباً جديداً.');
  checks.push('close-clears-secret-and-invalidates-actions');

  await reset();
  const panel = document.createElement('satr-mcp-panel');
  document.body.append(panel);
  await panel.open(cwd, 'codex');
  await until(() => panel.shadowRoot.querySelectorAll('.project-connections .connection-card').length === 3);
  check(panel._connections instanceof view.constructor, 'لوحة الموصلات لا تركب ConnectionView الإنتاجي.');
  check(panel.shadowRoot.querySelector('.connection-legacy summary').textContent.includes('MCP'),
    'اختفى سطح خوادم MCP القائم من اللوحة.');
  button(panel.shadowRoot.querySelector('[data-service="github"]'), 'إعادة المصادقة').click();
  const panelPassword = panel.shadowRoot.querySelector('input[type=password]');
  panelPassword.value = fakeSecret;
  panel.close();
  check(panelPassword.value === '' && !panel.hasAttribute('open'), 'إغلاق لوحة MCP لم يصل إلى التوصيلات.');
  panel.remove();
  checks.push('actual-mcp-panel-composition');

  await reset();
  await document.fonts.ready;
  check(document.fonts.check('13px "IBM Plex Sans Arabic"', 'توصيلات المشروع'), 'لم يحمل خط المشروع.');
  check(scene.violations.length === 0, 'ظهر خرق CSP.');
  checks.push('font-and-csp');
  return { checks, violations: scene.violations };
}

// تشخيص اختياري: نواة أداة القرائية الإنتاجية في حجرة الاختبار، لا نداء MCP في المعاينة.
function productionReadability() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preview.js'), 'utf8');
  const marker = 'const READABILITY_FN = `';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('READABILITY_FN غير موجود في الإنتاج.');
  const open = start + marker.length - 1;
  const close = src.indexOf('`;', open + 1);
  if (close < 0) throw new Error('READABILITY_FN غير منتهى.');
  const raw = src.slice(open + 1, close);
  if (raw.includes('${')) throw new Error('نواة القياس تحوي استبدالاً غير متوقع.');
  return new Function('return `' + raw + '`;')();
}

async function sizeForEvidence(win, width, height) {
  win.setContentSize(width, height);
  for (let attempt = 0; attempt < 100; attempt++) {
    const actual = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })', true);
    if (actual.width === width && actual.height === height) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('لم تستقر أبعاد لقطة التشخيص.');
}

async function saveReadabilityEvidence(win) {
  const script = productionReadability();
  const dir = path.join(__dirname, '..', 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const samples = [];
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 1000]) {
      await sizeForEvidence(win, width, 800);
      await win.webContents.executeJavaScript('document.documentElement.dataset.theme = ' + JSON.stringify(theme) + '; window.scrollTo(0, 0)', true);
      const contentHeight = await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)', true);
      await sizeForEvidence(win, width, Math.max(800, Math.min(4000, contentHeight)));
      await win.webContents.executeJavaScript('window.scrollTo(0, 0)', true);
      const data = await win.webContents.executeJavaScriptInIsolatedWorld(1013, [{ code: script }], true);
      const filename = 'connections-' + theme + '-' + width + '.png';
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, filename), screenshot.toPNG());
      samples.push({ theme, requestedWidth: width, screenshot: filename, readability: data });
      console.log('READABILITY ' + theme + ' width=' + data.viewport.width + ' counts=' + JSON.stringify(data.counts)
        + ' unseen=' + JSON.stringify(data.unseen) + ' truncated=' + data.truncated);
    }
  }
  fs.writeFileSync(path.join(dir, 'connections-readability.json'), JSON.stringify({
    description: 'قياس نواة أداة القرائية في حجرة Electron، وليس استدعاء browser_readability في المعاينة.',
    surface: 'ConnectionView الإنتاجي في Light DOM بثلاث حالات بيانات تجريبية، دون نماذج المصادقة واختيار المورد المفتوحة.',
    samples,
  }, null, 2), 'utf8');
}

async function main() {
  await app.whenReady();
  const scene = await startScene({ port: 0 });
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) consoleErrors.push(String(message));
  });
  try {
    await win.loadURL(scene.url);
    const result = await win.webContents.executeJavaScript('(' + browserChecks.toString() + ')()', true);
    assert.strictEqual(result.checks.length, 8);
    assert.deepStrictEqual(result.violations, []);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء حارس التوصيلات.');
    for (const width of [390, 1000]) {
      win.setContentSize(width, 800);
      const geometry = await win.webContents.executeJavaScript('({ width: innerWidth, scroll: document.documentElement.scrollWidth, cards: document.querySelectorAll(".connection-card").length })', true);
      assert(geometry.scroll <= geometry.width + 1, 'تجاوز أفقي بعرض ' + width);
      assert.strictEqual(geometry.cards, 3);
    }
    if (process.argv.includes('--readability-evidence')) await saveReadabilityEvidence(win);
    for (const name of result.checks) console.log('PASS ' + name);
    console.log('PASS connections-ui 8/8; widths=390,1000; CSP=0; console=0');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await scene.close();
  }
}

const timeout = setTimeout(() => { console.error('connections-ui: انتهت مهلة الحارس.'); app.exit(1); }, 30000);
main().then(() => { clearTimeout(timeout); app.exit(0); }).catch((error) => {
  clearTimeout(timeout); console.error('connections-ui:', error && error.stack ? error.stack : error); app.exit(1);
});
