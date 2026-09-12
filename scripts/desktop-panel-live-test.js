#!/usr/bin/env node
'use strict';

/**
 * اختبار Chromium حيّ للوحة 🪟 سطح ويندوز وسجلّ أفعالها (الخطوة ٥ من docs/COMPUTER-USE-DESKTOP.md).
 *
 * fixture 1 — المكوّن وحده تحت CSP صارمة بجسر window.satr مزيف يطبّق حواجز main.js حرفياً:
 * الفتح/الإغلاق، قائمة النوافذ كما وصلت (المحجوبة لا تصل أصلاً فالسطر ثابت لا سبب لكل صف)،
 * اتجاه العناوين بـtextDir، حمولة الاختيار {targetId,pid}، إعادة السرد **مرة واحدة** عند
 * not_allowed ثم الرسالة إن تكرّر، سحب الاختيار، رسالة «المعين غير موجود» كما وصلت،
 * وسجلّ الأفعال: الأنواع الثمانية ⇒ ثمانية أسطر، سقف 200، HTML نصّاً، ورسوّ RTL بالبكسل.
 *
 * fixture 2 — القشرة الحقيقية (src/index.html بـCSP الإنتاج) عبر خادم الـharness مع mock لقنوات
 * desktop*: كشف الزر، حصرية الأسطح، منع الإرسال بلا اختيار، علم desktopControl في حمولة send،
 * وصول desktop_activity إلى اللوحة **وإلى بطاقة الأداة في المحادثة**، استهلاك مربع الإذن لحقل
 * detail، إشعار المعين الغائب من stderr وحده، وإطفاء العلم وسحب الاختيار مع الجلسة الجديدة.
 *
 * أسطر السجل ونصّ عدم التوافر وتفاصيل الإذن تُقرأ من وحدات الإنتاج (desktopguard/desktop) لا من
 * نسخة موازية تبيت.
 *
 * التشغيل المباشر (سكربت npm ‏test:desktop-panel):
 *   electron scripts/desktop-panel-live-test.js
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const harness = require('../electron/testspriteharness');
const guard = require('../electron/desktopguard');
const desktop = require('../electron/desktop');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 30000;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const TARGET = {
  targetId: 'w5', pid: 4321, processName: 'notepad.exe',
  title: 'desktop-step5.txt - Notepad', rect: { x: 10, y: 10, w: 800, h: 600 },
};
const NODE = { ref: 'w5:e2', role: 'edit', name: 'Text Editor', rect: { x: 20, y: 40, w: 700, h: 500 }, enabled: true };

// الأنواع الثمانية التي يبثّ لها desktop.js سطر سجل (الحارس ٥) — بنصّ describeAction نفسه
const ACTIVITY_LINES = [
  guard.describeAction({ type: 'snapshot' }, null, TARGET),
  guard.describeAction({ type: 'click' }, NODE, TARGET),
  guard.describeAction({ type: 'type', text: 'سطر من سطر' }, NODE, TARGET),
  guard.describeAction({ type: 'scroll', dy: 3 }, NODE, TARGET),
  guard.describeAction({ type: 'press_key', keys: 'Ctrl+S' }, null, TARGET),
  guard.describeAction({ type: 'wait_for', ref: 'w5:e2' }, NODE, TARGET),
  guard.describeAction({ type: 'wait_for' }, null, TARGET),
  guard.describeAction({ type: 'screenshot' }, null, TARGET),
];
const PERM_DETAIL = desktop.permissionDetail('mcp__satr-desktop__desktop_type', { ref: 'w1:e2', text: 'سطر من سطر' });

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// عقد ساكن: ما لا تراه الصفحة (القناة الرابعة، علم الحمولة، نظافة fixture) — بنمط gallery-live-test
function assertStaticContract() {
  const preloadSrc = read('electron/preload.js');
  assert(preloadSrc.includes("desktopStatus: () => ipcRenderer.invoke('satr:desktopStatus')"),
    'غاب سطر desktopStatus المحدّد في preload.js.');
  const mainSrc = read('electron/main.js');
  assert.strictEqual((mainSrc.match(/ipcMain\.handle\('satr:desktopStatus'/g) || []).length, 1,
    'معالج satr:desktopStatus ليس وحيداً في main.js.');
  assert(/desktop\.isAvailable\(\) === true/.test(mainSrc), 'satr:desktopStatus لا يشتق التوافر من desktop.isAvailable.');
  const appSrc = read('src/ui/app.js');
  assert(/desktopControl: desktopControlOn/.test(appSrc), 'حمولة send لا تحمل علم desktopControl.');
  assert(/satr_desktop_control/.test(appSrc), 'علم سطح المكتب لا يُحفظ في localStorage.');
  assert(!/browserControlOn && desktopControlOn|desktopControlOn = browserControlOn/.test(appSrc),
    'عُلّق علم سطح المكتب بعلم المتصفح — المحوران مستقلان.');
  for (const file of ['desktop-panel-live.html']) {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
    assert(source.includes('../../src/styles/base.css'), file + ' لا يستورد base.css الحقيقي.');
    assert(source.includes('../../src/ui/components/desktop-panel.js'), file + ' لا يستورد المكوّن الحقيقي.');
    assert(!/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(source), file + ' يحوي script مضمّناً.');
    assert(!/\sstyle\s*=/i.test(source), file + ' يحوي style مضمّناً.');
  }
}

async function waitForPage(win, variable, progressVariable, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.' + variable + ' || null', true);
    if (result) return result;
    await delay(50);
  }
  const progress = await win.webContents.executeJavaScript('window.' + progressVariable + ' || "unknown"', true);
  throw new Error('انتهت مهلة ' + label + '؛ المرحلة: ' + progress);
}

function newWindow() {
  return new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
}

function watchConsole(win, sink) {
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      sink.push(String(message));
    }
  });
}

// ---------- fixture 1: المكوّن وحده ----------
async function runPanelFixture() {
  const consoleErrors = [];
  const win = newWindow();
  watchConsole(win, consoleErrors);
  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'desktop-panel-live.html'));
    await win.webContents.executeJavaScript('window.__DESKTOP_FIXTURE__ = '
      + JSON.stringify({ lines: ACTIVITY_LINES, unavailable: desktop.UNAVAILABLE_MESSAGE }) + '; true', true);
    const result = await waitForPage(win, '__desktopLiveResult', '__desktopLiveProgress', 'اختبار لوحة سطح ويندوز');
    assert.strictEqual(result.pass, true,
      'فشل اختبار اللوحة داخل الصفحة (' + (result.progress || '?') + '): ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation في لوحة سطح ويندوز.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console في لوحة سطح ويندوز.');
    for (const check of [
      'open-close', 'list-exactly-arrived', 'title-dir', 'select-payload', 'select-retry-once',
      'select-retry-message', 'clear', 'unavailable-message', 'control-toggle', 'activity-eight',
      'activity-cap', 'activity-html-as-text', 'activity-rtl-anchor', 'activity-clear', 'labels-exposed',
    ]) assert(result.checks.includes(check), 'غاب فحص اللوحة الحي: ' + check);
    // خريطة الأسماء العربية في المكوّن = نسخة desktopguard التي يكتب بها سطر السجل
    const labels = await win.webContents.executeJavaScript('window.__desktopPanelLabels', true);
    assert.deepStrictEqual(labels, Object.assign({}, guard.PROCESS_LABELS),
      'خريطة أسماء النوافذ في الواجهة تباعدت عن desktopguard.PROCESS_LABELS.');
    const cap = await win.webContents.executeJavaScript('window.__desktopPanelMaxActivity', true);
    assert.strictEqual(cap, 200, 'سقف سجلّ الأفعال ليس 200.');
    for (const note of result.notes) console.log('  ▸', note);
    console.log('desktop-panel: نجح — ' + result.checks.length + ' فحصاً في المكوّن؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// ---------- fixture 2: القشرة الحقيقية عبر خادم الـharness + mock قنوات سطح المكتب ----------
function createShellServer() {
  const extra = fs.readFileSync(path.join(__dirname, 'fixtures', 'desktop-shell-mock.js'), 'utf8');
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch (error) { res.writeHead(400); res.end(); return; }
    const reply = (type, body) => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(data);
    };
    if (pathname === '/' || pathname === '/index.html') { reply(MIME['.html'], harness.harnessIndex()); return; }
    if (pathname === '/__testsprite__/mock-satr.js') { reply(MIME['.js'], harness.harnessClient() + '\n' + extra); return; }
    const asset = harness.safeAsset(pathname);
    if (!asset) { res.writeHead(404); res.end(); return; }
    reply(MIME[path.extname(asset).toLowerCase()] || 'application/octet-stream', fs.readFileSync(asset));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      if (server.unref) server.unref();
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

const SHELL_SCENARIO = `(async () => {
  const out = { checks: [], notes: [] };
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const D = window.__DESKTOP_SHELL__;
  const H = window.__SATR_TESTSPRITE_HARNESS__;
  const notices = () => [...document.querySelectorAll('.notice')].map((n) => n.textContent);
  const sendCalls = () => H.calls.filter((call) => call.name === 'send');
  async function waitFor(cond, label, timeout) {
    const deadline = Date.now() + (timeout || 8000);
    while (Date.now() < deadline) { if (cond()) return; await sleep(30); }
    throw new Error('انتهت مهلة: ' + label);
  }
  let stage = 'boot';
  try {
    H.setAutoRespond(false);
    await customElements.whenDefined('satr-desktop-panel');
    const panel = document.querySelector('satr-desktop-panel');
    const root = panel.shadowRoot;

    stage = 'toggle-revealed';
    await waitFor(() => $('desktopToggle') && !$('desktopToggle').hidden, 'كشف زر سطح ويندوز');
    out.checks.push('toggle-revealed');

    stage = 'surface-exclusive';
    $('desktopToggle').click();
    await waitFor(() => panel.hasAttribute('open'), 'فتح اللوحة');
    await waitFor(() => D.targetsCalls >= 1 && root.querySelectorAll('.target').length === 1, 'سرد النوافذ');
    $('galleryToggle').click();
    await waitFor(() => !panel.hasAttribute('open'), 'حصرية الأسطح عند فتح المعرض');
    $('galleryToggle').click();
    await waitFor(() => !document.querySelector('satr-gallery-panel').hasAttribute('open'), 'إغلاق المعرض');
    $('desktopToggle').click();
    await waitFor(() => panel.hasAttribute('open'), 'إعادة فتح اللوحة');
    out.checks.push('surface-exclusive');

    stage = 'control-flag-stored';
    const enable = root.querySelector('.enable');
    enable.checked = true;
    enable.dispatchEvent(new Event('change'));
    await waitFor(() => localStorage.getItem('satr_desktop_control') === '1', 'حفظ علم التحكم');
    await waitFor(() => enable.checked === true, 'رسم المفتاح بعد قرار القشرة');
    if ($('desktopToggle').textContent.indexOf('●') === -1) throw new Error('زر الدرج لا يُظهر حالة التفعيل');
    out.checks.push('control-flag-stored');

    stage = 'send-blocked-without-window';
    $('engine').value = 'sdk';
    $('engine').dispatchEvent(new Event('change'));
    H.clearCalls();
    $('input').value = 'اكتب سطراً في المفكرة واحفظ';
    $('send').click();
    await sleep(400);
    if (sendCalls().length !== 0) throw new Error('أُرسل الدور رغم غياب اختيار النافذة');
    if (!notices().some((text) => text.indexOf('اختر نافذة أولاً') !== -1)) {
      throw new Error('لم يظهر إشعار «اختر نافذة أولاً»');
    }
    if ($('input').value !== 'اكتب سطراً في المفكرة واحفظ') throw new Error('ضاع نص المستخدم عند المنع');
    out.checks.push('send-blocked-without-window');

    stage = 'select-payload';
    root.querySelector('.target button').click();
    await waitFor(() => D.selectCalls.length === 1, 'نداء الاختيار');
    if (D.selectCalls[0][0] !== 'w5' || D.selectCalls[0][1] !== 4321) {
      throw new Error('حمولة الاختيار: ' + JSON.stringify(D.selectCalls[0]));
    }
    await waitFor(() => !root.querySelector('.clear').hidden, 'ظهور زر إلغاء الاختيار');
    out.checks.push('select-payload');

    stage = 'payload-desktop-control';
    $('send').click();
    await waitFor(() => sendCalls().length === 1, 'إرسال الدور بعد الاختيار');
    const payload = sendCalls()[0].args[0];
    if (payload.desktopControl !== true) throw new Error('حمولة send بلا desktopControl');
    if (payload.browserControl !== false) throw new Error('عُلّق تحكّم المتصفح بتحكّم سطح المكتب');
    out.checks.push('payload-desktop-control');

    stage = 'activity-panel-and-chat';
    H.emitEvent({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' });
    H.emitEvent({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_desktop_1', name: 'mcp__satr-desktop__desktop_type', input: { ref: 'w1:e2', text: 'سطر' } },
    ] } });
    await sleep(200);
    for (const line of window.__DESKTOP_LINES__) H.emitEvent({ type: 'desktop_activity', text: line });
    await waitFor(() => root.querySelectorAll('.log li').length === window.__DESKTOP_LINES__.length, 'أسطر السجل في اللوحة');
    const card = [...document.querySelectorAll('.tool')].find((el) => {
      const name = el.querySelector('.name');
      return name && name.textContent === 'mcp__satr-desktop__desktop_type';
    });
    if (!card) throw new Error('لم تظهر بطاقة أداة سطح المكتب في المحادثة');
    const chatLines = card.querySelectorAll('.desktop-line');
    if (chatLines.length !== window.__DESKTOP_LINES__.length) {
      throw new Error('أسطر المحادثة ' + chatLines.length + ' مقابل ' + window.__DESKTOP_LINES__.length + ' حدثاً');
    }
    if (!card.classList.contains('desktop-tool')) throw new Error('بطاقة الأداة بلا صنف desktop-tool');
    const firstChatText = chatLines[0].querySelector('.desktop-text');
    if (firstChatText.getAttribute('dir') !== 'rtl') throw new Error('سطر المحادثة لم يُحسم RTL');
    if (firstChatText.textContent !== window.__DESKTOP_LINES__[0]) throw new Error('نص سطر المحادثة لا يطابق الحدث');
    out.notes.push('أسطر مرئية: لوحة ' + root.querySelectorAll('.log li').length + ' · محادثة ' + chatLines.length);
    out.checks.push('activity-panel-and-chat');

    stage = 'perm-detail-consumed';
    H.emitEvent({ type: 'permission_request', id: 'perm-desktop-1', tool: 'mcp__satr-desktop__desktop_type',
      input: { ref: 'w1:e2', text: 'سطر من سطر' }, detail: window.__DESKTOP_PERM_DETAIL__,
      turnEligible: true, alwaysEligible: false });
    const perm = document.querySelector('satr-perm-dialog');
    await waitFor(() => perm.hasAttribute('open'), 'فتح مربع الإذن');
    const permRoot = perm.shadowRoot;
    const detailEl = permRoot.querySelector('.perm-detail');
    if (detailEl.textContent !== window.__DESKTOP_PERM_DETAIL__) throw new Error('مربع الإذن لا يعرض حقل detail كما وصل');
    if (!permRoot.querySelector('.always').hidden) throw new Error('ظهر زر «موافقة دائمة» لأداة سطح المكتب');
    const node = detailEl.firstChild;
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 1);
    const charRect = range.getBoundingClientRect();
    const boxRect = detailEl.getBoundingClientRect();
    out.notes.push('مربع الإذن: أول محرف على بعد ' + (boxRect.right - charRect.right).toFixed(1)
      + 'px من اليمين و' + (charRect.left - boxRect.left).toFixed(1) + 'px من اليسار');
    if ((boxRect.right - charRect.right) >= (charRect.left - boxRect.left)) {
      throw new Error('سطر تفاصيل الإذن العربي رسا LTR');
    }
    permRoot.querySelector('.deny').click();
    await waitFor(() => !perm.hasAttribute('open'), 'إغلاق مربع الإذن');
    out.checks.push('perm-detail-consumed');

    stage = 'unavailable-notice-only';
    H.emitEvent({ type: 'result', session_id: '11111111-1111-4111-8111-111111111111', cost_usd: 0, duration_ms: 12 });
    H.emitEvent({ type: 'proc_done', code: 0 });
    await sleep(250);
    H.emitEvent({ type: 'stderr', text: 'خرج طرفي خام لا يخصّ سطح المكتب' });
    H.emitEvent({ type: 'stderr', text: window.__DESKTOP_UNAVAILABLE__ });
    await waitFor(() => notices().some((text) => text.indexOf(window.__DESKTOP_UNAVAILABLE__) !== -1), 'إشعار المعين الغائب');
    if (notices().some((text) => text.indexOf('خرج طرفي خام') !== -1)) throw new Error('عُرض stderr عام في المحادثة');
    out.checks.push('unavailable-notice-only');

    stage = 'new-session-off-and-cleared';
    $('newSession').click();
    await waitFor(() => localStorage.getItem('satr_desktop_control') === '0', 'إطفاء العلم مع الجلسة الجديدة');
    await waitFor(() => D.clearCalls === 1, 'سحب الاختيار مع الجلسة الجديدة');
    await waitFor(() => root.querySelector('.clear').hidden, 'اختفاء زر الإلغاء بعد السحب');
    if ($('desktopToggle').textContent.indexOf('●') !== -1) throw new Error('بقيت نقطة التفعيل على الزر');
    if (!notices().some((text) => text.indexOf('أُوقف تحكّم سطح المكتب تلقائياً') !== -1)) {
      throw new Error('لم يظهر إشعار الإطفاء التلقائي');
    }
    out.checks.push('new-session-off-and-cleared');

    out.pass = true;
  } catch (error) {
    out.pass = false;
    out.stage = stage;
    out.error = error && error.message ? error.message : String(error);
  }
  out.violations = D.violations.slice();
  return out;
})()`;

async function runShellFixture() {
  const server = createShellServer();
  const url = await listen(server);
  const consoleErrors = [];
  const win = newWindow();
  watchConsole(win, consoleErrors);
  try {
    await win.loadURL(url + '/index.html');
    await win.webContents.executeJavaScript(
      'window.__DESKTOP_LINES__ = ' + JSON.stringify(ACTIVITY_LINES) + ';'
      + 'window.__DESKTOP_PERM_DETAIL__ = ' + JSON.stringify(PERM_DETAIL) + ';'
      + 'window.__DESKTOP_UNAVAILABLE__ = ' + JSON.stringify(desktop.UNAVAILABLE_MESSAGE) + '; true', true);
    const result = await win.webContents.executeJavaScript(SHELL_SCENARIO, true);
    for (const note of result.notes || []) console.log('  ▸', note);
    assert.strictEqual(result.pass, true,
      'فشل اختبار القشرة داخل الصفحة (' + (result.stage || '?') + '): ' + (result.error || ''));
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation في القشرة.');
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console في القشرة.');
    for (const check of [
      'toggle-revealed', 'surface-exclusive', 'control-flag-stored', 'send-blocked-without-window',
      'select-payload', 'payload-desktop-control', 'activity-panel-and-chat', 'perm-detail-consumed',
      'unavailable-notice-only', 'new-session-off-and-cleared',
    ]) assert(result.checks.includes(check), 'غاب فحص القشرة الحي: ' + check);
    console.log('desktop-shell: نجح — ' + result.checks.length + ' فحصاً في القشرة الحقيقية؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((done) => server.close(done));
  }
}

async function main() {
  assertStaticContract();
  assert.strictEqual(ACTIVITY_LINES.length, 8, 'أسطر الأنواع الثمانية ناقصة.');
  assert(ACTIVITY_LINES.every((line) => line && line.length <= 300), 'سطر سجل أطول من السقف.');
  await app.whenReady();
  // إتلاف نافذة fixture قبل إقلاع التالية يُسقط آخر نافذة فيبدأ Electron الإغلاق التلقائي (درس مسجّل)
  app.on('window-all-closed', () => {});
  await runPanelFixture();
  await runShellFixture();
}

main().then(() => app.quit()).catch((error) => {
  console.error('desktop-panel-live:', error && error.stack ? error.stack : error);
  app.exit(1);
});
