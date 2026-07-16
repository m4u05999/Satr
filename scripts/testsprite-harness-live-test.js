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
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(50);
  }
  throw new Error('انتهت مهلة ' + label);
}

async function main() {
  const server = harness.createHarnessServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, harness.HOST, resolve);
  });
  const port = server.address().port;
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
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
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });

  try {
    await win.loadURL(`http://${harness.HOST}:${port}/`);
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
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('testsprite-harness-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
