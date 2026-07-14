/**
 * اختبار تخطيط حي لعمود الدردشة داخل Chromium الفعلي، بلا preload أو WebContentsView.
 * يستورد fixture ملف base.css ومكوّن composer الحقيقيين ويقيس container queries وقت التشغيل.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'chatcolumn-layout.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractBlock(source, startTag, endTag) {
  const start = source.indexOf(startTag);
  const end = source.indexOf(endTag, start);
  assert(start !== -1 && end !== -1, `تعذّر إيجاد الكتلة ${startTag}.`);
  return source.slice(start, end + endTag.length);
}

function normalizeMarkup(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertFixtureContract() {
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const indexComposer = extractBlock(index, '<satr-composer>', '</satr-composer>');
  const fixtureComposer = extractBlock(fixture, '<satr-composer>', '</satr-composer>');
  assert.strictEqual(normalizeMarkup(fixtureComposer), normalizeMarkup(indexComposer),
    'انحرفت كتلة المؤلّف في fixture عن src/index.html.');

  const midRowStart = fixture.indexOf('<div id="midRow">');
  const terminalStart = fixture.indexOf('<satr-terminal-panel>');
  assert(midRowStart !== -1 && terminalStart > midRowStart,
    'تعذّر فصل #midRow عن الطرفية في fixture.');
  const fixtureMidRow = fixture.slice(midRowStart, terminalStart);
  const chatColumn = fixtureMidRow.indexOf('<div id="chatColumn">');
  const chat = fixtureMidRow.indexOf('<satr-chat>');
  const composer = fixtureMidRow.indexOf('<satr-composer>');
  const opsRoom = fixtureMidRow.indexOf('<satr-ops-room');
  const preview = fixtureMidRow.indexOf('<satr-preview-panel');
  assert(chatColumn !== -1 && chatColumn < chat && chat < composer && composer < opsRoom && opsRoom < preview,
    'ترتيب fixture لا يطابق #chatColumn ثم السطحين الجانبيين.');
  assert(terminalStart > fixture.indexOf('<satr-preview-panel'),
    'الطرفية في fixture ليست أسفل #midRow.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__chatcolumnLayoutResult || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript(
    'window.__chatcolumnLayoutProgress || "unknown"', true);
  throw new Error('انتهت مهلة اختبار تخطيط عمود الدردشة؛ المرحلة: ' + progress);
}

async function main() {
  assertFixtureContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
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
    assert.strictEqual(result.pass, true, result.error || 'فشل اختبار التخطيط داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation أثناء اختبار التخطيط.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء اختبار التخطيط.');
    for (const check of [
      'layout-806', 'layout-504', 'layout-381', 'composer-states',
      'menus-contained', 'safe-menu-dom', 'terminal-full-width', 'zero-csp-violations',
    ]) assert(result.checks.includes(check), 'غاب فحص التخطيط: ' + check);
    assert.deepStrictEqual(result.cases.map((item) => item.width), [806, 504, 381],
      'لم تُختبر عروض عمود الدردشة المعتمدة.');
    assert(result.cases.every((item) => item.slashWidth > 0 && item.fileWidth > 0),
      'إحدى قوائم المؤلّف لم تُقَس وهي مفتوحة.');
    console.log('chatcolumn-layout: نجح — 806/504/381px، المؤلّف والقوائم والمرفقات والعمليات، والطرفية كاملة العرض؛ صفر overflow/CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error('chatcolumn-layout:', error && error.stack ? error.stack : error);
  app.exit(1);
});
