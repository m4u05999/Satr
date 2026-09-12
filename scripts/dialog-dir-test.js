/**
 * حارس اتجاه وصف الخيار في حوار السؤال (‏OBS-170) — Chromium حيّ، قياس بالبكسل.
 *
 * العلّة المقيسة: `.q-opt-desc` كانت تُحسم بـ`unicode-bidi: plaintext` ويُملأ نصّها
 * بـ`textContent` بلا `dir` مشتق، فوصفٌ عربيّ الجوهر يبدأ برمز لاتيني (‏`SHA-256 …`)
 * يرسو LTR كاملاً — العلّة نفسها التي حسمتها `OBS-061` لفقرات المحادثة.
 *
 * القياس: موضع **أول محرف** بالبكسل عبر `Range` (المسافة من يمين العنصر ومن يساره)،
 * لا `getComputedStyle(el).direction` — الأخيرة تعيد `rtl` الموروثة بينما الفقرة رست
 * LTR داخلياً (القاعدة ٣ في `CLAUDE.md`).
 *
 * ⚠️ **حدّ مُصرَّح به**: يقيس هذا الحارس `.q-opt-desc` و`.q-opt-label` في هذا المكوّن
 * وحدهما؛ لا يدّعي مسح بقية المكوّنات التي ما زالت على `plaintext`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'dialog-dir.html');
const TIMEOUT_MS = 30000;

// الحالات الثلاث: عربي يبدأ برمز لاتيني (الحالة المقيسة) · عربي صرف · لاتيني صرف
const CASES = [
  {
    key: 'latin-prefixed-arabic',
    label: 'SHA-256 قبل النشر',
    description: 'SHA-256 للملف قبل النشر، ثم ترفع الحزمة إلى المرآة ويُحدَّث ملف البصمات.',
    expected: 'rtl',
  },
  {
    key: 'pure-arabic',
    label: 'إعادة البناء',
    description: 'يعيد بناء الحزمة من المصدر ثم يرفعها بعد التحقق من التوقيع.',
    expected: 'rtl',
  },
  {
    key: 'pure-latin',
    label: 'Skip publish',
    description: 'Rebuild the bundle and upload it to the mirror without signing.',
    expected: 'ltr',
  },
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// حارس تعليق: خطأ إقلاع في Electron يعلّق العملية بدل أن ينهيها
const watchdog = setTimeout(() => {
  console.error('dialog-dir: انتهت المهلة الكلية.');
  app.exit(1);
}, TIMEOUT_MS + 15000);

function assertFixtureContract() {
  const source = fs.readFileSync(FIXTURE, 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/question-dialog.js'), 'fixture لا يستورد المكوّن الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture يحوي style مضمّناً.');
}

/** عقد المصدر: الحسم من المصدر الواحد، ولا `plaintext` على وصف الخيار. */
function assertSourceContract() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'question-dialog.js'), 'utf8');
  assert(source.includes("from '../lib/text-dir.js'"),
    'يجب أن يستورد question-dialog.js الحسم الإحصائي من المصدر الواحد lib/text-dir.js.');
  const rule = source.match(/\.q-opt-desc\s*\{[^}]*\}/);
  assert(rule, 'تعذّر إيجاد قاعدة .q-opt-desc في ورقة المكوّن.');
  assert(!/plaintext/.test(rule[0]),
    'عادت unicode-bidi: plaintext إلى .q-opt-desc — تتعارض مع dir الصريح (OBS-170).');
}

async function measure(win) {
  return win.webContents.executeJavaScript(`(() => {
    // موضع أول محرف مقارنةً بحافتي العنصر (نفس مسبار arabic-rtl-probe)
    const anchorOf = (el) => {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.length) return null;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 1);
      const first = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (!first.width && !first.height) return null;
      const fromRight = box.right - first.right;
      const fromLeft = first.left - box.left;
      return { anchor: fromRight <= fromLeft ? 'rtl' : 'ltr', fromRight, fromLeft };
    };
    const dialog = document.querySelector('satr-question-dialog');
    dialog.closeAll();
    dialog.ask({
      id: 'dialog-dir-probe',
      questions: [{
        question: 'أي خطوة نشر تريد؟',
        options: ${JSON.stringify(CASES.map((c) => ({ label: c.label, description: c.description })))},
      }],
    });
    // مهلة لا rAF: النافذة مخفية فقد يتضوّر إطار الرسم (درس هشاشة question-dialog)
    return new Promise((resolve) => setTimeout(() => {
      const root = dialog.shadowRoot;
      const descs = [...root.querySelectorAll('.q-opt-desc')];
      const labels = [...root.querySelectorAll('.q-opt-label')];
      resolve({
        open: dialog.hasAttribute('open'),
        descs: descs.map((el) => ({
          text: el.textContent, dir: el.getAttribute('dir'),
          computed: getComputedStyle(el).direction, ...(anchorOf(el) || {}),
        })),
        labels: labels.map((el) => ({
          text: el.textContent, dir: el.getAttribute('dir'), ...(anchorOf(el) || {}),
        })),
      });
    }, 80));
  })()`, true);
}

async function main() {
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(FIXTURE);
    await delay(120);
    const result = await measure(win);
    assert.strictEqual(result.open, true, 'لم يُفتح حوار السؤال.');
    assert.strictEqual(result.descs.length, CASES.length, 'عدد أوصاف الخيارات غير متوقع.');
    const failures = [];
    result.descs.forEach((desc, index) => {
      const expected = CASES[index].expected;
      console.log('  ' + CASES[index].key + ': anchor=' + desc.anchor
        + ' fromRight=' + Math.round(desc.fromRight) + ' fromLeft=' + Math.round(desc.fromLeft)
        + ' dir=' + (desc.dir || '—') + ' computed=' + desc.computed + ' (المتوقع ' + expected + ')');
      if (desc.anchor !== expected) {
        failures.push(CASES[index].key + ': رسا ' + desc.anchor + ' والمتوقع ' + expected
          + ' (fromLeft=' + Math.round(desc.fromLeft) + '، fromRight=' + Math.round(desc.fromRight) + ')');
      }
      if (desc.dir !== expected) {
        failures.push(CASES[index].key + ': سمة dir = ' + (desc.dir || 'غائبة') + ' والمتوقع ' + expected);
      }
    });
    assert.deepStrictEqual(failures, [], 'فشل اتجاه وصف الخيار (OBS-170):\n' + failures.join('\n'));
    // عنوان الخيار يُقاس ويُطبع: لا قاعدة plaintext عليه فلا يُتوقع منه العطل نفسه
    result.labels.forEach((label, index) => {
      console.log('  label[' + index + ']: anchor=' + label.anchor
        + ' fromRight=' + Math.round(label.fromRight) + ' fromLeft=' + Math.round(label.fromLeft)
        + ' dir=' + (label.dir || '—'));
    });
    assertSourceContract();
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أو CSP أثناء الاختبار.');
    console.log('dialog-dir: نجح — وصف الخيار يُحسم بـtextDir ويرسو بالبكسل كما يقتضي نصّه؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('dialog-dir:', error && error.stack ? error.stack : error);
  app.exit(1);
});
