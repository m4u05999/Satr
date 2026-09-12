#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');

const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    // التقييم قد يُرفض أثناء ملاحة جارية (إعادة التحميل) — نتجاهل ونعاود حتى المهلة
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    } catch (error) { /* الصفحة تتنقّل الآن */ }
    await delay(50);
  }
  throw new Error('انتهت مهلة ' + label);
}

function makeWindow() {
  return new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'testsprite-harness-live-' + Date.now(),
    },
  });
}

// حالة الإقلاع الثانية (OBS-172): مجلد محفوظ في localStorage **قبل** تحميل الصفحة.
// القشرة (`ui/app.js`) تُحمَّل قبل `ui/components/chat.js` عمداً، وجسر الحاضن المزيّف
// يعيد وعداً فورياً، فمسار الاستعادة يبلغ `chatEl.addNotice` قبل ترقية <satr-chat>.
// الحالة الأصلية تضبط #cwd بعد التحميل فلا تمرّ بهذا المسار إطلاقاً.
// تُعاد نافذة الحالة الأولى نفسها عمداً: نافذة ثانية بقسم تخزين جديد على الخادم نفسه
// تعود بـERR_FAILED في هذه البيئة، وإعادة التحميل كافية لأن المطلوب إقلاع جديد لا قسم جديد.
async function caseSavedCwdBoot(win, consoleErrors) {
  await win.webContents.executeJavaScript(
    "(() => { localStorage.setItem('satr_cwd', 'D:\\\\sater\\\\satr-2'); localStorage.setItem('satr_engine', 'sdk'); return true; })()", true);
  consoleErrors.length = 0;
  win.webContents.reload();
  await waitFor(win,
    "window.__SATR_TESTSPRITE_HARNESS__ && customElements.get('satr-chat') && document.getElementById('cwd').value === 'D:\\\\sater\\\\satr-2'",
    'إقلاع بمجلد محفوظ');
  // أثر ملموس: الإشعار المؤجَّل يهبط فعلاً على المكوّن بعد ترقيته (لا يُبتلع مع الاستثناء)
  try {
    await waitFor(win,
      "document.body.innerText.includes('تعذرت استعادة المحادثة المحفوظة لهذا المشروع')",
      'هبوط إشعار تعذّر الاستعادة على <satr-chat> بعد ترقيته');
  } catch (error) {
    // السبب المرجَّح يظهر في console الصفحة — نضمّه للرسالة كي لا يكون الفشل صامتاً
    throw new Error(error.message + ' — أخطاء console: ' + (consoleErrors.join(' | ') || 'لا شيء'));
  }
  const upgradeErrors = consoleErrors.filter((message) => /addNotice is not a function/.test(message));
  assert.deepStrictEqual(upgradeErrors, [], 'انفجر نداء chatEl قبل ترقية satr-chat: ' + upgradeErrors.join(' | '));
  assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console/CSP عند الإقلاع بمجلد محفوظ: ' + consoleErrors.join(' | '));
  console.log('testsprite-harness-live: نجح — إقلاع بمجلد محفوظ بلا انفجار قبل ترقية satr-chat، والإشعار وصل المكوّن.');
}

async function main() {
  const server = harness.createHarnessServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, harness.HOST, resolve);
  });
  const port = server.address().port;
  await app.whenReady();
  const url = `http://${harness.HOST}:${port}/`;
  const consoleErrors = [];
  const win = makeWindow('send');
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });

  try {
    await win.loadURL(url);
    await waitFor(win,
      "window.__SATR_TESTSPRITE_HARNESS__ && customElements.get('satr-chat') && customElements.get('satr-composer') && !document.querySelector('satr-gate').hasAttribute('open')",
      'إقلاع TestSprite harness');
    const state = await win.webContents.executeJavaScript(`(() => {
      const cwd = document.getElementById('cwd');
      const input = document.getElementById('input');
      cwd.value = 'D:\\\\sater\\\\satr-2';
      cwd.dispatchEvent(new Event('change', { bubbles: true }));
      input.value = 'اختبار واجهة سطر';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
      return { harness: document.documentElement.dataset.testspriteHarness, title: document.title };
    })()`, true);
    assert.strictEqual(state.harness, 'true');
    assert(state.title.includes('TestSprite Harness'));
    await waitFor(win,
      "document.body.innerText.includes('هذه استجابة محاكاة من بيئة TestSprite') && window.__SATR_TESTSPRITE_HARNESS__.calls.some((call) => call.name === 'send')",
      'دورة إرسال المحادثة المزيّفة');
    await win.webContents.executeJavaScript("document.getElementById('settingsBtn').click()", true);
    await waitFor(win,
      "!document.getElementById('settingsPop').hidden && document.getElementById('activityList').innerText.includes('اكتمل الطلب بنجاح') && window.__SATR_TESTSPRITE_HARNESS__.calls.some((call) => call.name === 'activityList')",
      'عرض سجل النشاط المحلي');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console/CSP في harness: ' + consoleErrors.join(' | '));
    console.log('testsprite-harness-live: نجح — إقلاع واجهة سطر وإرسال/استجابة مزيّفان وسجل النشاط المحلي، صفر CSP/console.');
    await caseSavedCwdBoot(win, consoleErrors);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('testsprite-harness-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
