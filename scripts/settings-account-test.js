#!/usr/bin/env node
/**
 * حارس OBS-099 الحي — قسما «حساب Claude» و«حساب Codex» في ⚙.
 *
 * العطل: app.js سجّل مستمع #settingsBtn يقرأ settingsPop.hidden داخل queueMicrotask،
 * وindex.html يحمّله قبل topbar.js — فكانت الـmicrotask تُصرَّف قبل أن يبدّل
 * مستمع topbar.js الحالة، فيقرأ «مغلقة» ويخرج: الدالتان لم تُستدعَيا قط رغم أن
 * الاستدعاء «موجود» في المصدر (الفحص الساكن يراه ولا يرى العطل).
 *
 * العلاج (المُختبَر هنا): topbar.js يبث CustomEvent اسمها settings-open من داخل
 * setSettingsOpen عند الفتح، وapp.js يستمع لها على عنصر satr-topbar.
 *
 * البِتّة: الواجهة الحقيقية لا تُحمَّل كاملة (تصنع ~30 مكوّناً) — بدلها يستخرج
 * هذا الاختبار قسم الحسابات ومستمع settings-open **من مصدر app.js الفعلي**
 * ويحقنها في الصفحة، ثم ينقر #settingsBtn فعلياً ويثبت أن نصَّي الحالة غيّرا
 * نصَّيهما الأوليَّين. إن أُعيد العطل القديم غاب المستمع عن الاستخراج فلا يُسلَّك
 * شيء، ويسقط الانتظار الحي برسالة تشخيصية (أي يسقط لأن السلوك فشل لا لأن نمطاً
 * غاب). fixture يحمّل topbar.js الإنتاجي نفسه تحت CSP صارم بجسر satr مزيّف يعدّ
 * الاستدعاءات — فيثبت أيضاً أن الإغلاق (‏✕/Escape/خارج اللوحة) لا يحدّث الحسابات،
 * وأن مستمعَي topbar.js (النشاط المحلي، إصدارات المحرّكات) بلا تراجع.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'settings-account.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تطابق قوس فتح بقفله ويعيد فهرس ما بعد قوس الإغلاق (مكدس لاحتمال تداخل الأنواع)
function matchClosing(source, openIndex) {
  const stack = [source[openIndex]];
  for (let i = openIndex + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '{' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  throw new Error('قوس غير مغلق أثناء استخراج قسم من app.js');
}

// استخراج قسم الحسابات من app.js: من «let claudeAccountRequest» إلى نهاية
// refreshCodexAccountView — الوظائف نفسها تُحقن في الصفحة فتعمل على fixture
function extractAccountSection(appSource) {
  const start = appSource.indexOf('let claudeAccountRequest = null;');
  assert(start !== -1, 'تعذّر إيجاد بداية قسم الحسابات في app.js.');
  const rv = appSource.indexOf('async function refreshCodexAccountView', start);
  assert(rv !== -1, 'تعذّر إيجاد refreshCodexAccountView في app.js.');
  const open = appSource.indexOf('{', rv);
  const end = matchClosing(appSource, open);
  return appSource.slice(start, end);
}

// استخراج مستمع settings-open من app.js. عند غيابه (‏الكود القديم) يُعيد نصاً
// فارغاً فتفشل المرحلة الحيّة بانتظارٍ منتهٍ — لا برميٍ هنا.
function extractSettingsOpenListener(appSource) {
  const idx = appSource.indexOf("topbarEl.addEventListener('settings-open'");
  if (idx === -1) {
    return '/* غاب مستمع settings-open من app.js — يُترك بلا أسلاك كي يسقط الانتظار الحي */';
  }
  const open = appSource.indexOf('(', idx);
  const end = matchClosing(appSource, open);
  return appSource.slice(idx, end);
}

function assertStaticContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const topbarSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'topbar.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');

  // نظافة fixture تحت CSP: لا سمات مضمّنة ولا كتلة style وكل السكربتات خارجية
  assert(!/\sstyle\s*=|\son[a-z]+\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  assert(!/<style\b/i.test(fixture), 'يحتوي fixture كتلة style مضمّنة.');
  const scripts = [...fixture.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0 && scripts.every((m) => /\bsrc\s*=/.test(m[1]) && !m[2].trim()),
    'يجب أن تكون كل سكربتات fixture خارجية.');

  // أمانة fixture: قسما الحساب منقولان حرفياً من index.html (كشف الانحراف المستقبلي)
  const start = index.indexOf('<div class="settings-keys" id="claudeAccountSection">');
  const end = index.indexOf('<!-- مجلدات إضافية', start);
  assert(start !== -1 && end !== -1, 'تعذّر إيجاد قسمَي الحساب في index.html.');
  assert(fixture.includes(index.slice(start, end)),
    'قسما الحساب في fixture انحرفا عن src/index.html.');

  // عقد الإصلاح في topbar.js: بثّ صريح عند الفتح فقط. أما استماع app.js وغياب
  // queueMicrotask فيُثبتان حيّاً (النقر نفسه) ثم يُثبَّتان نصّياً في نهاية main().
  assert(topbarSource.includes("new CustomEvent('settings-open'"),
    'topbar.js لا يبث settings-open عند فتح اللوحة.');
  assert(topbarSource.includes('if (open && wasHidden)'),
    'البثّ غير مقيد بالانتقال من مغلقة إلى مفتوحة — الإغلاق سيستدعي التحديث.');

  // عقد التسجيل: package.json + الطقم (‏suite-coverage يفشل على الاختبار اليتيم)
  assert.strictEqual(packageJson.scripts['test:settings-account'],
    'electron scripts/settings-account-test.js');
  assert(fullSuite.includes("'test:settings-account'"), 'غاب test:settings-account من full-suite.');
}

// لقطة حالة من داخل الصفحة — كل الادعاءات الحيّة تقرأ منها
const SNAPSHOT = `(() => {
  const $ = (id) => document.getElementById(id);
  const rowHidden = (id) => { const row = $(id).closest('.dirs-head'); return row ? row.hidden : null; };
  return {
    popHidden: $('settingsPop').hidden,
    claudeState: $('claudeAccountState').textContent,
    codexState: $('codexAccountState').textContent,
    claudeEmail: $('claudeAccountEmail').textContent,
    emailRowHidden: rowHidden('claudeAccountEmail'),
    codexPlan: $('codexAccountPlan').textContent,
    codexWindow: $('codexAccountWindow').textContent,
    codexRecent: $('codexAccountRecent').textContent,
    codexLifetime: $('codexAccountLifetime').textContent,
    engineStatus: $('engineUpdatesStatus').textContent,
    engineRows: $('engineUpdatesList').children.length,
    activityItems: $('activityList').children.length,
    events: window.__events.slice(),
    calls: Object.assign({}, window.__satrCalls),
  };
})()`;

async function waitFor(win, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression, true);
    if (value) return value;
    await delay(50);
  }
  return null;
}

async function snapshot(win) {
  return win.webContents.executeJavaScript(SNAPSHOT, true);
}

async function clickSettingsBtn(win) {
  await win.webContents.executeJavaScript("document.getElementById('settingsBtn').click()", true);
}

// انتظار اكتمال تحديث الحسابين بعد فتح اللوحة — عند الفشل يجمع تشخيصاً حيّاً
async function waitAccountRefresh(win) {
  const done = await waitFor(win, `document.getElementById('claudeAccountState').textContent === 'متصل'
    && document.getElementById('codexAccountState').textContent === 'مسجَّل الدخول'`);
  if (done) return;
  const diag = await snapshot(win);
  throw new Error('فُتحت ⚙ لكن قسمَي الحساب بقيا على نصَّيهما الأوليَّين — '
    + 'settings-open لم تصل إلى مستمع app.js. لقطة حية: ' + JSON.stringify(diag));
}

async function main() {
  assertStaticContract();
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const accountSection = extractAccountSection(appSource);
  const listenerBlock = extractSettingsOpenListener(appSource);

  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });

  try {
    await win.loadFile(FIXTURE);
    assert.strictEqual(await waitFor(win, 'window.__pageReady === true', TIMEOUT_MS), true,
      'لم تُعلم صفحة fixture جاهزيتها.');

    // تسليك وظائف الحسابات الحقيقية من app.js + مستمع settings-open (إن وُجد)
    const inject = '(() => {\n'
      + 'const $ = (id) => document.getElementById(id);\n'
      + 'const topbarEl = document.querySelector(\'satr-topbar\');\n'
      + accountSection + '\n'
      + listenerBlock + '\n'
      + 'return \'wired\';\n})()';
    assert.strictEqual(await win.webContents.executeJavaScript(inject, true), 'wired');

    // نقطة البداية: اللوحة مغلقة والنصان على قيمتيهما الأوليين من index.html
    let snap = await snapshot(win);
    assert.strictEqual(snap.popHidden, true, 'اللوحة يجب أن تبدأ مغلقة.');
    assert.strictEqual(snap.claudeState, 'يُحدّث عند فتح الإعدادات', 'نص Claude الأولي انحرف.');
    assert.strictEqual(snap.codexState, 'يُحدّث عند فتح الإعدادات', 'نص Codex الأولي انحرف.');
    assert.strictEqual(snap.calls.claudeAccount, 0, 'تحديث الحسابات قبل الفتح — لا كسل.');

    // ① الفتح بالنقرة: الحدث يصل، والدالتان تُستدعيان فعلاً، والحقول تُملأ
    await clickSettingsBtn(win);
    await waitAccountRefresh(win);
    snap = await snapshot(win);
    assert.strictEqual(snap.popHidden, false, 'اللوحة لم تُفتح بالنقرة.');
    assert(snap.events.includes('settings-open'), 'settings-open لم تُسجَّل في الصفحة.');
    assert.strictEqual(snap.claudeState, 'متصل');
    assert.strictEqual(snap.claudeEmail, 'user@example.com', 'البريد لم يُملأ.');
    assert.strictEqual(snap.emailRowHidden, false, 'صف البريد يجب أن يظهر بقيمة.');
    assert.strictEqual(snap.codexState, 'مسجَّل الدخول');
    assert.strictEqual(snap.codexPlan, 'plus', 'خطة Codex لم تُملأ.');
    assert.strictEqual(snap.codexWindow, '42%', 'استهلاك النافذة لم يُملأ.');
    assert.strictEqual(snap.codexRecent, '1,234,567', 'رموز 30 يوماً لم تُنسَّق LTR.');
    assert.strictEqual(snap.codexLifetime, '98,765,432', 'الإجمالي التراكمي لم يُنسَّق LTR.');
    assert.deepStrictEqual(
      { c: snap.calls.claudeAccount, s: snap.calls.codexStatus, l: snap.calls.codexLimits, u: snap.calls.codexUsage },
      { c: 1, s: 1, l: 1, u: 1 }, 'قنوات الحساب لم تُستدعَ مرة واحدة عند الفتح.');

    // ② مستمعا topbar.js (إصدارات المحرّكات + النشاط المحلي) بلا تراجع
    assert.strictEqual(await waitFor(win, "document.getElementById('engineUpdatesStatus').textContent === 'كلها محدَّثة'"), true,
      'مستمع إصدارات المحرّكات في topbar.js:350 توقف عن العمل.');
    snap = await snapshot(win);
    assert.strictEqual(snap.engineRows, 1, 'قائمة إصدارات المحرّكات لم تُبنَ.');
    assert.strictEqual(snap.engineStatus, 'كلها محدَّثة');
    assert.strictEqual(await waitFor(win, "document.getElementById('activityList').children.length === 1"), true,
      'مستمع النشاط المحلي في topbar.js:274 توقف عن العمل.');
    snap = await snapshot(win);
    assert.strictEqual(snap.activityItems, 1);
    assert.strictEqual(snap.calls.engineUpdates, 1, 'engineUpdates استُدعي أكثر من مرة.');
    assert.strictEqual(snap.calls.activityList, 1, 'activityList استُدعي أكثر من مرة.');

    // ③ الإغلاق بـ✕ لا يمرّ بمستمع #settingsBtn: لا تحديث ولا بثّ حدث
    const eventsBefore = snap.events.length;
    await win.webContents.executeJavaScript("document.getElementById('settingsClose').click()", true);
    snap = await snapshot(win);
    assert.strictEqual(snap.popHidden, true, 'الإغلاق بـ✕ لم يغلق اللوحة.');
    assert.strictEqual(snap.calls.claudeAccount, 1, 'الإغلاق بـ✕ استدعى تحديث Claude.');
    assert.strictEqual(snap.events.length, eventsBefore, 'الإغلاق بثّ settings-open.');

    // ④ إعادة الفتح تُحدِّث من جديد (كسول عند كل فتح)
    await clickSettingsBtn(win);
    await waitAccountRefresh(win);
    snap = await snapshot(win);
    assert.strictEqual(snap.calls.claudeAccount, 2, 'إعادة الفتح لم تُحدِّث الحسابات.');

    // ⑤ الإغلاق بـEscape: بلا تحديث
    await win.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))", true);
    snap = await snapshot(win);
    assert.strictEqual(snap.popHidden, true, 'الإغلاق بـEscape لم يغلق اللوحة.');
    assert.strictEqual(snap.calls.claudeAccount, 2, 'الإغلاق بـEscape استدعى تحديث Claude.');

    // ⑥ الإغلاق بالنقر خارج اللوحة: بلا تحديث
    await clickSettingsBtn(win);
    await waitAccountRefresh(win);
    snap = await snapshot(win);
    assert.strictEqual(snap.calls.claudeAccount, 3, 'الفتح الثالث لم يُحدِّث الحسابات.');
    await win.webContents.executeJavaScript(
      "document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))", true);
    snap = await snapshot(win);
    assert.strictEqual(snap.popHidden, true, 'النقر خارج اللوحة لم يغلقها.');
    assert.strictEqual(snap.calls.claudeAccount, 3, 'النقر خارج اللوحة استدعى تحديث Claude.');
    assert.strictEqual(snap.calls.codexStatus, 3, 'النقر خارج اللوحة استدعى تحديث Codex.');

    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء الاختبار الحي.');
    // تثبيت الإصلاح بعد نجاح المرحلة الحيّة: الاستماع للحدث، وبلا مسار microtask
    // متوازٍ يعيد العطل (عند إعادة العطل القديم يسقط الاختبار سقوطاً حيّاً قبل هنا)
    assert(appSource.includes("addEventListener('settings-open'"),
      'app.js لا يستمع لحدث settings-open.');
    assert(!appSource.includes('queueMicrotask'), 'بقي queueMicrotask في app.js — سباق OBS-099 عائد.');
    console.log('settings-account: نجح — النقر على ⚙ يبث settings-open ويحدِّث قسمَي الحساب فعلاً؛'
      + ' الإغلاق (‏✕/Escape/خارج) لا يحدِّثهما؛ ومستعِما topbar.js بلا تراجع؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error('settings-account:', error && error.stack ? error.stack : error);
  app.exit(1);
});
