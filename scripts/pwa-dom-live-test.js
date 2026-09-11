/**
 * سطر — حارس DOM حيّ لتطبيق الهاتف (‏OBS-009).
 *
 * **لماذا وُجد**: في التجربة الحية لدفعة F3 كانت لوحة الحالة **لا تظهر أبداً** على
 * الهاتف، بينما اللقطة تصل وتُقبل وتُحلَّل بنجاح تام. السبب: `#statePanel` يحمل صنف
 * `hidden` في الترميز، و`.hidden{display:none !important}` تغلب
 * `.state-panel.active{display:flex}`. أمسكه المالك **بلقطة شاشة، لا اختبار** —
 * لأن كل فحوص القناة تسأل «هل وصلت البيانات؟» ولا تسأل «**هل تُرسم؟**»
 * (‏§7.7.6/ك). ولم يكن — حتى هذا الملف — أي اختبار يحمّل صفحة الهاتف في متصفح.
 *
 * **ما يفعله**: يخدم `pwa/` على `127.0.0.1` (سياق آمن، فتعمل الصفحة كما في الإنتاج)
 * ويحمّلها في Chromium حقيقي، ثم **يقيس `getComputedStyle(...).display` فعلياً**.
 *
 * **ولا يحمل قائمة لوحات مكتوبة يدوياً**: يشتقّ الاصطلاحين من `styles.css` نفسه،
 * فلوحة جديدة تدخل الحراسة تلقائياً بدل أن تُنسى.
 *
 * التشغيل: npm run test:pwa-dom
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// نافذتان متعاقبتان للحراسة؛ الخروج عند خاتمة الاختبار الصريحة فقط.
app.on('window-all-closed', () => {});

const ROOT = path.resolve(__dirname, '..');
const PWA_DIR = path.join(ROOT, 'pwa');
const TIMEOUT_MS = 45000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

let checks = 0;
const failures = [];

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function equal(actual, expected, message) {
  check(actual === expected,
    message + ' — توقّعنا ' + JSON.stringify(expected) + ' ووجدنا ' + JSON.stringify(actual));
}

/** خادم ثابت صغير: `127.0.0.1` سياق آمن، فالصفحة تعمل بشروط الإنتاج لا بـ`file://`. */
function startServer() {
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    const rel = pathname === '/' ? '/index.html' : pathname;
    const target = path.resolve(PWA_DIR, '.' + rel);
    if (!target.startsWith(PWA_DIR)) { res.writeHead(403).end(); return; }
    let body;
    try { body = fs.readFileSync(target); } catch { res.writeHead(404).end(); return; }
    // منفذ الاختبار في النسخة المخدومة وحدها؛ دوال الإنتاج ونقلها وتعمية أطرها تبقى كما هي.
    if (target === path.join(PWA_DIR, 'app.js')) {
      const source = body.toString('utf8');
      const marker = '  init();';
      assert.strictEqual(source.split(marker).length, 2, 'موضع حقن IIFE يجب أن يكون وحيداً');
      const hook = [
        '  window.__satrPwaDom = { state, stopAgent, pollLoop, showScreen,',
        '    pending: () => pendingStop && ({ command_id: pendingStop.command_id, run: pendingStop.run }),',
        '    close: () => { state.stopped = true; if (state.pollAbort) state.pollAbort.abort();',
        '      if (pendingStop) clearTimeout(pendingStop.timer); pendingStop = null; stopLeaseTimer(); }',
        '  };',
      ].join('\n');
      body = Buffer.from(source.replace(marker, hook + '\n' + marker), 'utf8');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * الاصطلاحان **مشتقّان من `styles.css` الحقيقي** لا مكتوبان هنا:
 *   1. اصطلاح `active`:  `.X{display:none}` + `.X.active{display:flex}`
 *   2. اصطلاح `hidden`:  `.hidden{display:none !important}` يُضاف ويُزال
 * خلطهما على عنصر واحد هو العطل بعينه — و`!important` يفوز دائماً.
 */
function activeIdiomClasses() {
  const css = fs.readFileSync(path.join(PWA_DIR, 'styles.css'), 'utf8');
  const found = new Set();
  const re = /\.([a-zA-Z][\w-]*)\.active\s*\{/g;
  let match;
  while ((match = re.exec(css)) !== null) found.add(match[1]);
  return [...found];
}

function assertStaticContract() {
  const css = fs.readFileSync(path.join(PWA_DIR, 'styles.css'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  check(/\.hidden\s*\{[^}]*display:\s*none\s*!important/.test(css),
    'قاعدة .hidden ما زالت !important — وهي سبب غلبتها على .active');
  const idioms = activeIdiomClasses();
  check(idioms.length >= 2,
    'اشتُقّ اصطلاح active من styles.css (وجدنا ' + idioms.length + ' صنفاً)');
  equal(packageJson.scripts['test:pwa-dom'], 'electron scripts/pwa-dom-live-test.js',
    'السكربت مسجَّل في package.json');
  // ⚠️ هذا الحارس ينضمّ إلى **طقم الجوال الثمانية** لا إلى `test:full`: اختبارات
  // الجوال كلها خارجه اليوم (الميزة خلف بوابة `mobileFeatureAvailable` قبل الإصدار).
  // كونها خارجه مسجَّل ملاحظةً مستقلة — لا يُعالَج هنا كي لا تنتفخ الدفعة.
}

/** يقيس العرض فعلياً على الصفحة الحقيقية بعد تحميلها. */
async function measure(win) {
  const idioms = activeIdiomClasses();
  return win.webContents.executeJavaScript(`(() => {
    const idioms = ${JSON.stringify(idioms)};
    const shown = (el) => getComputedStyle(el).display;

    // 1) عناصر اصطلاح active: إظهارها يجب أن يُنتج عرضاً فعلياً
    const activeResults = [];
    for (const base of idioms) {
      for (const el of document.querySelectorAll('.' + base)) {
        const hadActive = el.classList.contains('active');
        const hadHidden = el.classList.contains('hidden');
        el.classList.add('active');
        const withActive = shown(el);
        el.classList.remove('active');
        const withoutActive = shown(el);
        if (hadActive) el.classList.add('active');
        activeResults.push({
          id: el.id || ('.' + base), base, withActive, withoutActive, hadHidden,
        });
      }
    }

    // 2) عناصر اصطلاح hidden: إزالته يجب أن تُظهرها فعلاً
    const hiddenResults = [];
    for (const el of document.querySelectorAll('.hidden')) {
      const usesActiveIdiom = idioms.some((base) => el.classList.contains(base));
      el.classList.remove('hidden');
      const withoutHidden = shown(el);
      el.classList.add('hidden');
      const withHidden = shown(el);
      hiddenResults.push({
        id: el.id || el.className, usesActiveIdiom, withoutHidden, withHidden,
      });
    }

    // 3) كل عنصر مخفيّ افتراضياً في الترميز — لا يفلت أحد من الاصطلاحين
    // ⚠️ العنصر المخفيّ **بسبب أب مخفيّ** لا يُحاسَب: اصطلاحه اصطلاح أبيه، ومطالبته
    // بصنف خاص كانت ستولّد ضجيجاً يدفع لاحقاً إلى تعطيل الفحص كله.
    const hiddenByAncestor = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).display === 'none') return true;
      }
      return false;
    };
    const unguarded = [];
    for (const el of document.querySelectorAll('[id]')) {
      if (getComputedStyle(el).display !== 'none') continue;
      if (hiddenByAncestor(el)) continue;
      const covered = el.classList.contains('hidden')
        || idioms.some((base) => el.classList.contains(base));
      if (!covered) unguarded.push(el.id);
    }

    return { activeResults, hiddenResults, unguarded };
  })()`);
}

function evaluate(data) {
  // ── الحارس المركزي: لا عنصر يخلط الاصطلاحين ────────────────────────────────
  // هذا **حرفياً** عطل لوحة الحالة: `!important` في .hidden يغلب .X.active مهما
  // فعل الكود، فيصير الإظهار مستحيلاً بينما البيانات تصل وتُقبل وتُحلَّل بنجاح.
  for (const row of data.activeResults) {
    check(!row.hadHidden,
      'العنصر ' + row.id + ' يخلط الاصطلاحين (‏hidden مع ' + row.base
      + '.active) — الإظهار مستحيل بالبناء، وهو عطل لوحة الحالة بعينه');
  }

  // ── القياس الحيّ: الإظهار يُنتج بكسلاً فعلاً ────────────────────────────────
  for (const row of data.activeResults) {
    check(row.withActive !== 'none',
      'العنصر ' + row.id + ' لا يظهر رغم إضافة active (‏display=' + row.withActive + ')');
    equal(row.withoutActive, 'none', 'والعنصر ' + row.id + ' مخفيّ افتراضياً بلا active');
  }

  for (const row of data.hiddenResults) {
    check(!row.usesActiveIdiom,
      'العنصر ' + row.id + ' يحمل hidden فوق اصطلاح active — تناقض بنيوي');
    check(row.withoutHidden !== 'none',
      'العنصر ' + row.id + ' لا يظهر بعد إزالة hidden (‏display=' + row.withoutHidden + ')');
    equal(row.withHidden, 'none', 'والعنصر ' + row.id + ' يختفي بإضافة hidden');
  }

  // ── الاكتمال: لوحة جديدة مخفيّة لا تمرّ بلا اصطلاح معروف ────────────────────
  equal(data.unguarded.join(','), '',
    'عناصر مخفيّة خارج الاصطلاحين — أضِف اصطلاحاً معروفاً أو وسّع الحارس');

  // ── لوحة الحالة تحديداً: العطل المثبَّت حياً، لا يعود ────────────────────────
  const statePanel = data.activeResults.find((row) => row.id === 'statePanel');
  check(!!statePanel, 'لوحة الحالة #statePanel موجودة في الترميز');
  if (statePanel) {
    equal(statePanel.withActive, 'flex',
      'لوحة الحالة تُرسم فعلاً عند تفعيلها (العطل الحيّ 2026-08-13)');
  }
}

// يُنفّذ النص نفسه داخل Chromium: النقل فقط مصطنع، وردود القناة تمر بتعمية الإنتاج وpollLoop.
async function measureStopCommandsInBrowser() {
  const hook = window.__satrPwaDom;
  if (!hook) throw new Error('OBS-147: missing test hook');
  const C = window.SatrCrypto;
  const $ = (id) => document.getElementById(id);
  const originalFetch = window.fetch;
  const polls = [];
  const posts = [];
  const data = {};
  const wait = async (predicate, label) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 5000) throw new Error('OBS-147 DOM timeout: ' + label + '; status=' + $('statusText').textContent);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const shown = (id) => getComputedStyle($(id)).display !== 'none' && $(id).getClientRects().length > 0;
  const snapshot = () => ({
    status: $('statusText').textContent,
    cardVisible: shown('decisionCard'),
    cardProject: $('projectName').textContent,
    cardSummary: $('actionSummary').textContent,
    phase: $('statePhase').textContent,
    project: $('stateProject').textContent,
    task: $('stateTask').textContent,
    total: $('stateTotal').textContent,
    completed: $('stateCompleted').textContent,
    run: hook.state.currentRun,
  });
  const stateFrame = (run, seq, label, total) => ({
    v: 1, type: 'state', state: {
      boot: '14714714', seq, ttl_ms: 60000, run, phase: 'working', project: 'المشروع ' + label,
      task: 'المهمة ' + label, tasks: { total, pending: total - 1, in_progress: 1, completed: 0, blocked: 0 },
      edits: { files: 0, added: 0, removed: 0 }, cost_usd: null, verify: '',
    },
  });
  const permissionFrame = (run, label) => ({
    v: 1, type: 'permission_request', envelope: {
      envelope_id: 'dom-permission-' + label, run, project: 'المشروع ' + label,
      risk: 'read', summary: 'إذن المهمة ' + label, tool: { name: 'Read', label: 'قراءة ملف' },
    },
  });
  const resultFrame = (request) => ({ v: 1, type: 'command_result', ...request, status: 'stopped' });
  let desktop;
  const deliver = async (frame, continues = true) => {
    await wait(() => polls.length > 0, 'poll awaiting frame');
    const response = polls.shift();
    const body = frame ? await C.seal(desktop, C.utf8ToBytes(JSON.stringify(frame))) : null;
    response.resolve(new Response(body, { status: frame ? 200 : 204 }));
    await wait(() => continues ? polls.length > 0 : !hook.state.polling, 'frame consumed');
  };
  window.fetch = async (url, options = {}) => {
    const pathname = new URL(url, location.href).pathname;
    if (pathname === '/m/dom-desktop') {
      posts.push({ status: 202, bytes: options.body.byteLength });
      return new Response('{"accepted":true}', { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname === '/m/dom-mobile') {
      return new Promise((resolve, reject) => {
        polls.push({ resolve, reject });
        if (options.signal) options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    return originalFetch(url, options);
  };
  try {
    // مفاتيح وهمية جديدة داخل المتصفح فقط؛ لا اقتران أو مخزن مستخدم أو خدمة خارجية.
    const mobileKeys = await C.generateKeyPair();
    const desktopKeys = await C.generateKeyPair();
    const pairId = 'dom-stop-' + crypto.randomUUID();
    const mobile = await C.deriveSession({ ...{ myPrivate: mobileKeys.privateKey, myPublic: mobileKeys.publicKey }, theirPublic: desktopKeys.publicKey, pairId, role: 'mobile' });
    desktop = await C.deriveSession({ ...{ myPrivate: desktopKeys.privateKey, myPublic: desktopKeys.publicKey }, theirPublic: mobileKeys.publicKey, pairId, role: 'desktop' });
    Object.assign(hook.state, { session: mobile, pairId, serverUrl: location.origin, relayUrl: location.origin,
      boxes: { toMobile: 'dom-mobile', toDesktop: 'dom-desktop' }, deviceId: 'dom-device', stopped: false });
    hook.showScreen('main');
    const runA = 'aaaaaaaaaaaaaaaa';
    const runA2 = 'cccccccccccccccc';
    const runB = 'bbbbbbbbbbbbbbbb';
    hook.pollLoop();
    await deliver(stateFrame(runA, 1, 'A', 2));
    await deliver(permissionFrame(runA, 'A'), false);
    await hook.stopAgent();
    const requestA = hook.pending();
    if (!requestA) throw new Error('OBS-147: stop request A was not retained');
    await deliver(null);
    data.acceptedA = snapshot();
    data.acceptedPosts = posts.filter((post) => post.status === 202 && post.bytes > C.TAG_LEN).length;
    await deliver(resultFrame(requestA));
    data.confirmedA = snapshot();
    await deliver(null);
    data.confirmedAAfterPoll = snapshot();
    const sameRunState = stateFrame(runA, 2, 'A', 2);
    sameRunState.state.phase = 'stopped';
    await deliver(sameRunState);
    data.confirmedAAfterSameRun = snapshot();

    // طلب إيقاف جديد لـA ثم بطاقة ولقطة B قبل وصول الإقرار القديم.
    await deliver(stateFrame(runA2, 3, 'A2', 3));
    data.nextRunAfterConfirmation = snapshot();
    await deliver(permissionFrame(runA2, 'A2'), false);
    await hook.stopAgent();
    const oldRequest = hook.pending();
    if (!oldRequest) throw new Error('OBS-147: second stop request A was not retained');
    await deliver(stateFrame(runB, 4, 'B', 7));
    await deliver(permissionFrame(runB, 'B'), false);
    // استئناف قارئ الإنتاج لاستقبال الإقرار المتأخر بعد عرض بطاقة B.
    hook.pollLoop();
    await wait(() => polls.length > 0, 'B poll awaiting late A');
    data.beforeLateA = snapshot();
    await deliver(resultFrame(oldRequest));
    data.afterLateA = snapshot();
    await hook.stopAgent();
    const requestB = hook.pending();
    if (!requestB) throw new Error('OBS-147: stop request B was not retained');
    await deliver(resultFrame(oldRequest));
    data.pendingBAfterLateA = snapshot();
    await deliver(resultFrame(requestB));
    data.confirmedB = snapshot();
    return data;
  } finally {
    hook.close();
    window.fetch = originalFetch;
  }
}

function evaluateStopCommands(data) {
  check(data.acceptedPosts > 0, 'OBS-147: sendUplink الفعلي استقبل HTTP 202 لإطار معمّى');
  check(data.acceptedA.cardVisible, 'OBS-147: HTTP 202 يبقي بطاقة إذن A مرئية');
  equal(data.acceptedA.status, 'أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب.', 'OBS-147: 202 لا يعلن التنفيذ ودورة poll لا تطمس الانتظار');
  equal(data.acceptedA.phase, 'يعمل', 'OBS-147: 202 لا يحوّل لوحة الحالة إلى توقف');
  check(!data.confirmedA.cardVisible, 'OBS-147: command_result المطابق يخفي بطاقة A فعلياً');
  equal(data.confirmedA.status, 'أكّد الحاسوب انتهاء الدور الجاري.', 'OBS-147: النجاح يُنسب إلى إقرار الحاسوب');
  equal(data.confirmedAAfterPoll.status, data.confirmedA.status, 'OBS-147: دورة poll التالية تحفظ نص التأكيد');
  equal(data.confirmedAAfterSameRun.status, data.confirmedA.status, 'OBS-147: لقطة أحدث للدور نفسه تحفظ تأكيد إيقافه');
  equal(data.nextRunAfterConfirmation.status, 'متصل — في انتظار طلب…', 'OBS-147: الدور الجديد يزيل تأكيد إيقاف الدور السابق');
  check(data.beforeLateA.cardVisible, 'OBS-147: بطاقة B مرئية قبل الإقرار القديم');
  equal(data.beforeLateA.project, 'المشروع B', 'OBS-147: لقطة الحالة تنتمي إلى B');
  equal(data.beforeLateA.task, 'المهمة B', 'OBS-147: عنوان المهمة ينتمي إلى B');
  equal(data.beforeLateA.total, '7', 'OBS-147: عداد المهام ينتمي إلى B');
  equal(JSON.stringify(data.afterLateA), JSON.stringify(data.beforeLateA), 'OBS-147: إقرار A القديم لا يمس بطاقة B أو حالتها أو نصها');
  check(data.pendingBAfterLateA.cardVisible, 'OBS-147: إقرار A لا يخفي بطاقة B أثناء طلب إيقاف B');
  equal(data.pendingBAfterLateA.status, 'أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب.', 'OBS-147: إقرار A لا يؤكد طلب إيقاف B');
  check(!data.confirmedB.cardVisible, 'OBS-147: إقرار B الصحيح يخفي بطاقته');
  equal(data.confirmedB.status, 'أكّد الحاسوب انتهاء الدور الجاري.', 'OBS-147: إقرار B الصحيح يعلن تأكيد الحاسوب');
}

async function main() {
  await require('./pwa-sw-test').testPwaSw();
  await require('./pwa-readability-test').testPwaReadability();
  assertStaticContract();
  const server = await startServer();
  const { port } = server.address();
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'pwa-dom-' + Date.now() },
  });
  try {
    await win.loadURL('http://127.0.0.1:' + port + '/index.html');
    // مهلة قصيرة كي يُنهي app.js إقلاعه (قد يفشل اتصاله بالقناة — لا يعني شيئاً هنا)
    await new Promise((resolve) => setTimeout(resolve, 700));
    const data = await measure(win);
    evaluate(data);
    const stopData = await win.webContents.executeJavaScript('(' + measureStopCommandsInBrowser.toString() + ')()');
    evaluateStopCommands(stopData);
    const evidenceDir = path.join(ROOT, 'dist', 'obs147-pwa-dom');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'latest.json'), JSON.stringify({
      app_sha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(PWA_DIR, 'app.js'))).digest('hex'),
      checks, failures, snapshots: stopData,
    }, null, 2), 'utf8');
  } finally {
    win.destroy();
    server.close();
  }
}

const guard = setTimeout(() => {
  console.error('pwa-dom-live-test: FAIL — تجاوز المهلة');
  process.exit(1);
}, TIMEOUT_MS);
guard.unref();

// خطأ في العملية الرئيسية يعلّقها بحوار بدل أن ينهيها (درس مثبَّت)
process.on('uncaughtException', (error) => {
  console.error('pwa-dom-live-test: FAIL:', error && error.stack || error);
  process.exit(1);
});

app.disableHardwareAcceleration();
app.whenReady().then(main).then(() => {
  if (failures.length) {
    console.error('pwa-dom-live-test: FAIL');
    for (const failure of failures) console.error('  - ' + failure);
  } else {
    console.log('pwa-dom-live-test: ok — ' + checks
      + ' فحصاً (‏Chromium حقيقي يقيس display والنصوص على صفحة الهاتف الفعلية).');
  }
  process.exit(failures.length ? 1 : 0);
}).catch((error) => {
  console.error('pwa-dom-live-test: FAIL:', error && error.stack || error);
  process.exit(1);
});
