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

async function main() {
  assertStaticContract();
  const server = await startServer();
  const { port } = server.address();
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await win.loadURL('http://127.0.0.1:' + port + '/index.html');
    // مهلة قصيرة كي يُنهي app.js إقلاعه (قد يفشل اتصاله بالقناة — لا يعني شيئاً هنا)
    await new Promise((resolve) => setTimeout(resolve, 700));
    const data = await measure(win);
    evaluate(data);
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
      + ' فحصاً (‏Chromium حقيقي يقيس display على صفحة الهاتف الفعلية).');
  }
  process.exit(failures.length ? 1 : 0);
}).catch((error) => {
  console.error('pwa-dom-live-test: FAIL:', error && error.stack || error);
  process.exit(1);
});
