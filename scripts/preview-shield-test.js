#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس درع المعاينة (‏OBS-059، حيّ تحت CSP صارم).
 *
 * العطل المرصود: طبقة `WebContentsView` تطفو فوق كل DOM، وحمايتها كانت **تُكتسب
 * بالتسجيل** في منسّق الأسطح — فحوار «ما الجديد» الذي يُفتح بـ`hidden=false` سقط
 * منها، ورصدت لقطة المالك صفحة المعاينة ترتسم من خلاله على 2.16.11 المنشورة.
 *
 * يشغّل هذا الحارس الوحدة **الإنتاجية** في Chromium حقيقي على ترميز الحوار نفسه
 * المنسوخ من `index.html`، ويتحقق من الوصل في `app.js` و`preview-panel.js` —
 * لأن وحدةً تعمل بلا وصل هي «موصولة لكن غير مربوطة»، وهو شكل العطل الأصلي.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'preview-shield.html');

let checks = 0;
function ok(cond, msg) { checks += 1; assert(cond, msg); }

/** يستخرج ترميز حوار «ما الجديد» — يجب أن يبقى fixture مطابقاً لـindex.html. */
function extractNotes(html) {
  const start = html.indexOf('<div id="notesDialog"');
  assert(start !== -1, 'لم يُعثر على #notesDialog');
  const end = html.indexOf('</div>', html.indexOf('id="notesFoot"'));
  return html.slice(start, end).replace(/\s+/g, ' ').trim();
}

function assertStatic() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  ok(extractNotes(fixture) === extractNotes(index),
    'انحرف ترميز #notesDialog في fixture عن src/index.html — الحارس يقيس شيئاً آخر');
  ok(/script-src 'self'/.test(fixture) && !/<style\b/i.test(fixture),
    'وfixture يعمل تحت CSP صارم بلا كتل مضمّنة');

  // الوصل: بلا هذين يبقى الدرع وحدةً تعمل ولا تحرس شيئاً
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  ok(/createPreviewShield/.test(shell) && /shield\.start\(\)/.test(shell),
    'القشرة تُنشئ الدرع وتبدؤه');
  ok(/preview\.holdForModal\(hold\)/.test(shell), 'وتوصله بحجب المعاينة');

  const panel = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'preview-panel.js'), 'utf8');
  ok(/holdForModal = \(hold\) => setHeld\('modal', hold\)/.test(panel),
    'واللوحة تعرض holdForModal بمفتاح مستقل عن dialog');
  // مفتاح مشترك كان سيجعل إغلاق أحدهما يُفرج عن حجب الآخر
  ok(/holdReasons\.has\('dialog'\) \|\| holdReasons\.has\('modal'\)/.test(panel),
    'والسطر المفسِّر للسواد (‏OBS-032) يغطي السببين — المستخدم يرى السواد ذاته');
}

async function main() {
  assertStatic();
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const violations = [];
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/Content Security Policy/i.test(message)) violations.push(message);
  });
  try {
    await win.loadFile(FIXTURE);
    let result = null;
    for (let attempt = 0; attempt < 100 && !result; attempt++) {
      result = await win.webContents.executeJavaScript('window.__shieldResult || null', true);
      if (!result) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(result, 'لم تنتهِ صفحة fixture');
    assert(!result.error, 'خطأ داخل fixture: ' + result.error);

    // الحالة الابتدائية: `role="dialog"` حاضر لكن الأب مخفيّ — فحصُ السمة وحده كان سيخطئ
    ok(result.initialHeld === false,
      'حوارٌ مخفيٌّ بأبيه لا يحجب — وهذا بالضبط ما يخطئه فحص [hidden] على العنصر نفسه');
    // `start()` تُبلّغ الحالة الابتدائية مرة واحدة (‏false) — مقصود: تُهيّئ الحجب
    // على واقع DOM بدل افتراض حالة. المهم ألّا تتكرر بلا تغيّر، وذاك فحص لاحق.
    ok(result.initialCalls <= 1, 'ونداء تهيئة واحد على الأكثر عند البدء (' + result.initialCalls + ')');

    // العطل المرصود حرفياً: update-toast يفتح بـhidden=false
    ok(result.afterOpen === true, 'فتح «ما الجديد» بـhidden=false يحجب المعاينة (العطل المرصود)');
    ok(result.afterClose === false, 'وإغلاقه يفكّ الحجب');

    // العطل البنيوي الثاني: عارض اللقطة المكبّر
    ok(result.afterAppendClosed === false, '<dialog> مضاف ومغلق لا يحجب');
    ok(result.afterShowModal === true, 'وshowModal() يحجب (عارض اللقطة المكبّر)');
    ok(result.afterCloseModal === false, 'وإغلاقه يفكّ');

    ok(result.plainHeld === false, 'وسطح عادي لا يحجب — لا إنذار كاذب يُخفي المعاينة بلا سبب');

    // التراكب: أخطر حالة — إغلاق حوار بينما آخر مفتوح
    ok(result.bothOpen === true, 'حواران معاً ⇒ حجب');
    ok(result.oneStillOpen === true,
      'وإغلاق أحدهما لا يُفرج عن الحجب ما دام الآخر مفتوحاً — وإلا برز العرض فوق حوار حيّ');
    ok(result.allClosed === false, 'وإغلاقهما معاً يفكّ');

    ok(result.noRedundantCalls === true, 'ولا يُستدعى onHold بلا تغيّر فعلي');
    ok(Array.isArray(result.transitions) && result.transitions.every((v) => typeof v === 'boolean'),
      'والانتقالات منطقية خالصة');

    ok(violations.length === 0, 'صفر انتهاك CSP (' + violations.length + ')');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  console.log('preview-shield: نجح — ' + checks
    + ' فحصاً (الحوار المخفيّ بأبيه، وhidden=false، وshowModal، والتراكب، والوصل؛ صفر CSP).');
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('preview-shield:', error && error.stack ? error.stack : error);
  app.exit(1);
});
