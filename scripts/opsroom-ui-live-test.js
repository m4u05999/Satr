/**
 * اختبار Chromium حيّ لغرفة العمليات: يشغّل المكوّن الحقيقي وورق التصميم الحقيقي
 * مع جسر ضيق مزيّف، ويثبت صدق النشاط والخطوة التالية ومنع تكرار الإشعارات.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(__dirname, 'fixtures', 'opsroom-ui-live.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertFixtureContract() {
  const source = fs.readFileSync(FIXTURE, 'utf8');
  assert(source.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(source.includes('../../src/ui/components/ops-room.js'), 'fixture لا يستورد مكوّن غرفة العمليات الحقيقي.');
  assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), 'fixture يحوي script مضمّناً.');
  assert(!/\sstyle\s*=/i.test(source), 'fixture يحوي style مضمّناً.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__opsroomUiLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.__opsroomUiLiveProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار غرفة العمليات الحي؛ المرحلة: ' + progress);
}

async function main() {
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 850,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
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
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار غرفة العمليات داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء الاختبار.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء الاختبار.');
    for (const check of [
      'seeded-chat-task', 'single-agent-default', 'recent-observable-activity',
      'elapsed-and-deadline', 'truthful-running-guidance',
      'quiet-without-stall-claim', 'timeout-recovery-guidance', 'explicit-retry',
      'deduplicated-terminal-notice',
      // ج «الوضع الآلي»: عقد dedup الإشعار النهائي يبقى مؤكداً داخل الصفحة قبل هذه
      // الكتلة (سيناريو الوضع الآلي يضيف إشعارات لاحقة مشروعة فسقط عدّ المجموع هنا).
      'auto-single-approval', 'auto-driver-review-no-click',
      'auto-full-chain-to-merge-gate', 'auto-never-merges',
      'zero-csp-violations',
    ]) assert(result.checks.includes(check), 'غاب فحص غرفة العمليات الحي: ' + check);
    console.log('opsroom-ui-live: نجح — نشاط مرصود، تعافٍ صريح، إشعار نهائي واحد، والوضع الآلي حتى بوابة الدمج بلا دمج آلي؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('opsroom-ui-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
