#!/usr/bin/env node
'use strict';
// واجهة الإنتاج كاملة؛ البدائل محصورة في حدود preload. لا محاكاة لدوال مكوّن المعاينة.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');
const ROOT = path.resolve(__dirname, '..');
const arg = process.argv.indexOf('--preview');
const alternatePreview = arg < 0 ? null : path.resolve(process.argv[arg + 1]);
const submitArg = process.argv.indexOf('--pick-submit-case');
const submitCase = submitArg < 0 ? null : process.argv[submitArg + 1];
if (submitCase && !['cancel', 'close', 'native-close', 'new-pick'].includes(submitCase)) throw new Error('Unknown pick submit case');
const evidence = [];
let lastAction = 'boot', checks = 0;
const watchdog = setTimeout(() => { console.error('preview-controls-ui: timeout after ' + lastAction); app.exit(1); }, 60000);
app.on('window-all-closed', () => {});
const check = (condition, label) => { assert(condition, label); checks++; console.log('PASS ' + label); };
function installBoundary() {
  const calls = [], allCalls = [], listeners = [], actions = [], picks = [], actionResults = [], navigations = [], shots = [], edits = [], promiseErrors = [];
  window.addEventListener('preview-edit', (event) => { edits.push(event.detail); event.stopImmediatePropagation(); }, true);
  window.addEventListener('unhandledrejection', (event) => { promiseErrors.push(String(event.reason)); });
  let deferPickCancel = false, deferredNavigation = null;
  localStorage.setItem('satr_preview_device', '0');
  localStorage.setItem('satr_preview_w', '300');
  localStorage.setItem('satr_preview_autoreload', '1');
  localStorage.removeItem('satr_preview_url');
  localStorage.setItem('satr_cwd', '');
  const remember = (name, args) => { const call = { name, args: Array.from(args) }; calls.push(call); allCalls.push(call); };
  window.satr.onPreview = (callback) => { listeners.push(callback); return () => {}; };
  window.satr.previewBounds = async (...args) => { remember('bounds', args); return { ok: true }; };
  const navigation = (method, args) => {
    remember(method, args);
    if (deferredNavigation === method) { deferredNavigation = null; return new Promise((resolve) => navigations.push(resolve)); }
    return Promise.resolve({ ok: true });
  };
  window.satr.previewOpen = (...args) => navigation('open', args);
  window.satr.previewNavigate = (...args) => navigation('navigate', args);
  window.satr.previewClose = async (...args) => { remember('close', args); return { ok: true }; };
  window.satr.previewAction = (...args) => {
    remember('action', args);
    const queued = actionResults.shift();
    if (queued) return queued.reject ? Promise.reject(new Error(queued.result)) : Promise.resolve(queued.result);
    if (String(args[0]).startsWith('net_')) return new Promise((resolve, reject) => { actions.push({ resolve, reject, name: args[0] }); });
    return Promise.resolve({ ok: true });
  };
  window.satr.previewPick = (...args) => { remember('pick', args); return new Promise((resolve, reject) => { picks.push({ resolve, reject }); }); };
  window.satr.previewPickCancel = async (...args) => { remember('pickCancel', args); if (!deferPickCancel) { const pending = picks.shift(); if (pending) pending.resolve({ ok: true, pick: null }); } return { ok: true }; };
  window.satr.previewElementShot = (...args) => { remember('elementShot', args); return new Promise((resolve, reject) => { shots.push({ resolve, reject }); }); };
  window.__PREVIEW_CONTROLS__ = {
    calls, allCalls, edits, promiseErrors,
    settleShot(result, reject = false) { const pending = shots.shift(); if (!pending) throw new Error('No pending element shot'); if (reject) pending.reject(new Error(String(result))); else pending.resolve(result); },
    clear() { calls.length = 0; },
    emit(event) { for (const listener of listeners) listener(event); },
    settleAction(result, reject = false) { const pending = actions.shift(); if (!pending) throw new Error('No pending network action'); if (reject) pending.reject(new Error(String(result))); else pending.resolve(result); },
    deferNavigation(method) { deferredNavigation = method; },
    settleNavigation(result) { const resolve = navigations.shift(); if (!resolve) throw new Error('No pending navigation'); resolve(result); },
    queueAction(result, reject = false) { actionResults.push({ result, reject }); },
    deferPickCancel(value) { deferPickCancel = value; },
    settlePick(pick, reject = false) { const pending = picks.shift(); if (!pending) throw new Error('No pending pick'); if (reject) pending.reject(new Error(String(pick))); else pending.resolve({ ok: true, pick }); },
    snapshot() {
      const panel = document.querySelector('satr-preview-panel'), shadow = panel.shadowRoot, get = (id) => shadow.getElementById(id);
      const box = get('pvBox').getBoundingClientRect();
      return {
        open: panel.hasAttribute('open'), bounds: calls.filter((call) => call.name === 'bounds').map((call) => call.args), calls: calls.slice(),
        box: { x: box.x, y: box.y, width: box.width, height: box.height }, device: get('pvDevice').title,
        network: { title: get('pvNet').title, text: get('pvNet').textContent, disabled: get('pvNet').disabled, active: get('pvNet').classList.contains('on') },
        backDisabled: get('pvBack').disabled, forwardDisabled: get('pvFwd').disabled,
        loading: get('pvReload').classList.contains('loading'), devtools: get('pvDevtools').classList.contains('on'),
        picking: get('pvPick').classList.contains('on'), pickBar: get('pvPickBar').classList.contains('show'),
        pickText: get('pbText').textContent, pickInput: get('pbInput').value, pickSendDisabled: get('pbSend').disabled,
        pickEdits: edits.slice(), pickSubmissionErrors: promiseErrors.slice(),
        consoleOpen: get('pvConsole').classList.contains('show'), consoleText: get('pcLog').textContent,
        toolsOpen: !get('pvTools').hidden, moreExpanded: get('pvMore').getAttribute('aria-expanded'),
        auto: get('pvAuto').classList.contains('on'), restartDisabled: get('pvRestartServer').disabled, error: get('pvErrText').textContent,
      };
    },
  };
}
function createServer() {
  const server = harness.createHarnessServer(), handler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === '/__testsprite__/mock-satr.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(harness.harnessClient() + '\n(' + installBoundary.toString() + ')();'); return;
    }
    if (alternatePreview && request.url === '/ui/components/preview-panel.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(fs.readFileSync(alternatePreview, 'utf8')); return;
    }
    handler(request, response);
  });
  return server;
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code, true);
async function settle(win) { await evaluate(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
async function act(win, code) { lastAction = code; await evaluate(win, code); await settle(win); }
const state = (win) => evaluate(win, '__PREVIEW_CONTROLS__.snapshot()');
const click = (win, id) => act(win, 'document.querySelector("satr-preview-panel").shadowRoot.getElementById(' + JSON.stringify(id) + ').click()');
const clear = (win) => evaluate(win, '__PREVIEW_CONTROLS__.clear()');
const positive = (bounds) => bounds.filter((args) => args[2] > 0 && args[3] > 0);
async function waitFor(win, expression) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await evaluate(win, 'Boolean(' + expression + ')')) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('مهلة التهيئة: ' + expression);
}
async function main() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, harness.HOST, resolve); });
  await app.whenReady();
  const errors = [], win = new BrowserWindow({ show: false, width: 1366, height: 950,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false, partition: 'preview-controls-ui-' + process.pid + '-' + Date.now() } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2 || /content security policy|uncaught|unhandled/i.test(message)) errors.push(message); });
  try {
    await win.loadURL('http://' + harness.HOST + ':' + server.address().port + '/');
    await waitFor(win, "window.__PREVIEW_CONTROLS__ && document.querySelector('satr-gate').hidden && document.querySelector('satr-preview-panel').openWith");
    await settle(win);
    await act(win, "document.getElementById('previewToggle').click()");
    await clear(win); await click(win, 'pvDevice');
    let current = await state(win);
    check(positive(current.bounds).length === 0, 'اختيار الجهاز قبل فتح عنوان يبقى مؤجلاً');
    await act(win, "(() => { const u = document.querySelector('satr-preview-panel').shadowRoot.getElementById('pvUrl'); u.value = 'http://localhost:4173/fixture'; u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    current = await state(win);
    check(current.calls.some((call) => call.name === 'open'), 'إدخال العنوان يستدعي فتح المعاينة');
    check(positive(current.bounds).some((args) => args[5] === true), 'first valid bounds must flush pending device reset');
    check(current.box.width < 390, 'المشهد ضيق فعلاً عن عرض الموبايل');
    const initialBounds = positive(current.bounds).at(-1).slice(0, 5);
    await clear(win); await click(win, 'pvDevice'); current = await state(win);
    const tabletBounds = positive(current.bounds).at(-1);
    check(!!tabletBounds && tabletBounds[5] === true, 'device click must reset viewport even when narrow bounds are unchanged');
    assert.deepEqual(tabletBounds.slice(0, 5), initialBounds, 'المشهد المطلوب هو مستطيل لم يتغير فعلاً'); checks++;
    await clear(win); await click(win, 'pvDevice'); current = await state(win);
    check(positive(current.bounds).some((args) => args[5] === true), 'العودة إلى كامل ترسل قصد إعادة ضبط صريح');
    await clear(win); await click(win, 'pvConsoleBtn'); current = await state(win);
    check(current.consoleOpen, 'زر Console يفتح اللوحة');
    check(positive(current.bounds).length > 0 && positive(current.bounds).every((args) => args[5] !== true), 'ordinary layout bounds must preserve viewport override');
    await click(win, 'pcClose');
    await act(win, "document.querySelector('satr-preview-panel').holdForDialog(true)");
    await clear(win); await click(win, 'pvDevice');
    check(positive((await state(win)).bounds).length === 0, 'اختيار الجهاز أثناء الحجب يبقى مؤجلاً');
    await act(win, "document.querySelector('satr-preview-panel').holdForDialog(false)"); current = await state(win);
    check(positive(current.bounds).some((args) => args[5] === true), 'release from hold must flush pending viewport reset');
    evidence.push({ scenario: 'device-intent', state: current });

    for (const method of ['open', 'navigate']) {
      if (method === 'open') await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'closed' })");
      await clear(win);
      await act(win, '__PREVIEW_CONTROLS__.deferNavigation(' + JSON.stringify(method) + ')');
      await act(win, "(() => { const u = document.querySelector('satr-preview-panel').shadowRoot.getElementById('pvUrl'); u.value = 'http://localhost:4173/deferred'; u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
      check((await state(win)).calls.some((call) => call.name === method), 'deferred ' + method + ' reaches its actual API boundary');
      await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'closed' })");
      await act(win, '__PREVIEW_CONTROLS__.settleNavigation({ ok: true })');
      await clear(win); await click(win, 'pvReload'); current = await state(win);
      check(current.calls.some((call) => call.name === 'open') && !current.calls.some((call) => call.name === 'action' && call.args[0] === 'reload'),
        'late ' + method + ' success after native close must not resurrect started state');
      evidence.push({ scenario: 'closed-before-' + method + '-reply', state: current });
    }

    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'nav', url: 'http://localhost:4173/second', canGoBack: true, canGoForward: true })");
    current = await state(win); check(!current.backDisabled && !current.forwardDisabled, 'حالة التنقل تفعّل الرجوع والتقدم');
    await clear(win); await click(win, 'pvBack'); await click(win, 'pvFwd'); await click(win, 'pvReload'); current = await state(win);
    assert.deepEqual(current.calls.filter((call) => call.name === 'action').map((call) => call.args[0]), ['back', 'forward', 'reload']); checks++;
    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'console', levelLabel: 'error', message: 'fixture console error' })");
    await click(win, 'pvConsoleBtn'); current = await state(win);
    check(current.consoleOpen && current.consoleText.includes('fixture console error'), 'Console يعرض رسالة الحد الإداري الفعلية');
    await click(win, 'pcClear'); check(!(await state(win)).consoleText.includes('fixture console error'), 'مسح سجل Console يمسح العرض المحلي');
    await click(win, 'pcClose');
    await click(win, 'pvMore'); current = await state(win);
    check(current.toolsOpen && current.moreExpanded === 'true', 'الأدوات الإضافية تفتح درجها');
    await click(win, 'pvMore'); check(!(await state(win)).toolsOpen, 'الأدوات الإضافية تطوى');
    await clear(win); await click(win, 'pvAuto');
    check(await evaluate(win, "document.querySelector('satr-preview-panel').reloadIfLive() === false"), 'إيقاف التحديث التلقائي يمنع إعادة التحميل');
    check(!(await state(win)).calls.some((call) => call.name === 'action' && call.args[0] === 'reload'), 'لا طلب reload عند تعطيل التحديث التلقائي');
    await click(win, 'pvAuto');
    check(await evaluate(win, "document.querySelector('satr-preview-panel').reloadIfLive() === true"), 'تشغيل التحديث التلقائي يعيد السماح بالتحميل');
    check((await state(win)).calls.some((call) => call.name === 'action' && call.args[0] === 'reload'), 'التحديث التلقائي يصل إلى حد API');
    await clear(win); await click(win, 'pvPick'); current = await state(win);
    check(current.picking && current.calls.some((call) => call.name === 'pick'), 'التحديد يبدأ بالمسار الإنتاجي');
    await click(win, 'pvPick'); current = await state(win);
    check(!current.picking && current.calls.some((call) => call.name === 'pickCancel'), 'النقرة الثانية تلغي التحديد');
    await act(win, '__PREVIEW_CONTROLS__.deferPickCancel(true)');
    await click(win, 'pvPick'); await click(win, 'pvPick'); await click(win, 'pvPick');
    await act(win, "__PREVIEW_CONTROLS__.settlePick({ selector: '#old', tag: 'button', text: 'نتيجة قديمة' })");
    current = await state(win);
    check(current.picking && !current.pickBar, 'old cancelled pick must not end a newer selection');
    await act(win, "__PREVIEW_CONTROLS__.settlePick('fixture pick failure', true)");
    check(!(await state(win)).picking && !(await state(win)).pickBar, 'pick rejection must clear selection state');
    await act(win, '__PREVIEW_CONTROLS__.deferPickCancel(false)');
    await click(win, 'pvPick');
    await act(win, "__PREVIEW_CONTROLS__.settlePick({ selector: '#fixture', tag: 'button', text: 'زر التجربة', html: '<button id=\"fixture\">زر التجربة</button>' })");
    check((await state(win)).pickBar, 'نتيجة التحديد تفتح شريط العنصر');
    await click(win, 'pbCancel'); check(!(await state(win)).pickBar, 'إغلاق بطاقة العنصر لا يرسل طلباً');

    // لقطة العنصر مؤجلة عند حد preload، والإلغاء والتحديد يمران بأزرار الإنتاج.
    const pickFixture = async (selector, text) => {
      await click(win, 'pvPick');
      await act(win, '__PREVIEW_CONTROLS__.settlePick(' + JSON.stringify({ selector, tag: 'button', text, html: '<button>' + text + '</button>' }) + ')');
    };
    for (const scenario of (submitCase ? [submitCase] : ['cancel', 'close', 'native-close', 'new-pick'])) {
      await pickFixture('#old-' + scenario, 'العنصر السابق');
      await act(win, 'document.querySelector("satr-preview-panel").shadowRoot.getElementById("pbInput").value = "اشرح العنصر السابق"');
      await clear(win); await click(win, 'pbSend');
      check((await state(win)).calls.some(call => call.name === 'elementShot' && call.args[0] === '#old-' + scenario), scenario + ': submit must await the actual element shot boundary');
      const beforeEdits = (await state(win)).pickEdits.length;
      if (scenario === 'cancel') await click(win, 'pbCancel');
      else if (scenario === 'close') await click(win, 'pvClose');
      else if (scenario === 'native-close') await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'closed' })");
      else await pickFixture('#replacement', 'العنصر الجديد');
      await act(win, '__PREVIEW_CONTROLS__.settleShot({ ok: true, base64: "old-image" })'); current = await state(win);
      check(current.pickSubmissionErrors.length === 0, scenario + ': late shot after invalidation must not dereference a cleared pick');
      check(current.pickEdits.length === beforeEdits, scenario + ': late shot must not submit a cancelled or replaced pick');
      if (scenario === 'new-pick') {
        check(current.pickBar && current.pickText === 'العنصر الجديد' && !current.pickSendDisabled, 'late shot must preserve the newer pick bar and its send control');
        await click(win, 'pbCancel');
      } else check(!current.pickBar && !current.pickSendDisabled, scenario + ': cancellation must reset submission controls');
      evidence.push({ scenario: 'pick-submit-' + scenario, state: current });
      if (scenario === 'close') await act(win, "document.getElementById('previewToggle').click()");
      if (scenario === 'close' || scenario === 'native-close') await click(win, 'pvReload');
    }
    await pickFixture('#send-current', 'العنصر المعتمد');
    await act(win, 'document.querySelector("satr-preview-panel").shadowRoot.getElementById("pbInput").value = "اشرح العنصر المعتمد"');
    await clear(win); await click(win, 'pbSend'); current = await state(win);
    check(current.pickSendDisabled, 'pending element shot must disable duplicate submission');
    await click(win, 'pbSend');
    await act(win, 'document.querySelector("satr-preview-panel").shadowRoot.getElementById("pbInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
    check((await state(win)).calls.filter(call => call.name === 'elementShot').length === 1, 'button and Enter must share the in-flight submission guard');
    const originalUrl = await evaluate(win, 'document.querySelector("satr-preview-panel").shadowRoot.getElementById("pvUrl").value');
    await act(win, 'document.querySelector("satr-preview-panel").shadowRoot.getElementById("pvUrl").value = "http://localhost:4173/edited-while-waiting"');
    await act(win, '__PREVIEW_CONTROLS__.settleShot("fixture screenshot rejection", true)'); current = await state(win);
    const edit = current.pickEdits.at(-1);
    check(edit && edit.selector === '#send-current' && edit.instruction === 'اشرح العنصر المعتمد' && edit.url === originalUrl && edit.imageDataUrl === '', 'shot rejection must send the captured text context and original URL');
    check(!current.pickBar && !current.pickSendDisabled && current.pickSubmissionErrors.length === 0, 'completed submission must close its bar and reset controls');

    await click(win, 'pvMore'); await clear(win);
    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'network', preset: 'net_offline' })");
    check((await state(win)).network.active && /غير متصل/.test((await state(win)).network.title), 'backend network event must synchronize the visible mode');
    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'network', preset: 'net_online' })");
    check(!(await state(win)).network.active, 'backend online event must clear network mode');
    const baselineNetwork = (await state(win)).network;
    await click(win, 'pvNet'); current = await state(win);
    check(current.network.disabled, 'network request must disable repeated clicks');
    check(current.network.title === baselineNetwork.title && current.network.text === baselineNetwork.text, 'network label must wait for successful response');
    await click(win, 'pvNet');
    check((await state(win)).calls.filter((call) => call.name === 'action' && call.args[0].startsWith('net_')).length === 1, 'pending network change must not launch another action');
    await act(win, "__PREVIEW_CONTROLS__.settleAction({ ok: false, error: 'throttle_unavailable' })"); current = await state(win);
    check(!current.network.disabled && current.network.title === baselineNetwork.title, 'network failure must keep previous mode and reenable button');
    await click(win, 'pvNet');
    await act(win, "__PREVIEW_CONTROLS__.settleAction({ ok: true, preset: 'net_slow' })"); current = await state(win);
    check(!current.network.disabled && current.network.active && /بطيء/.test(current.network.title), 'network success must display slow mode');
    await click(win, 'pvNet');
    await act(win, "__PREVIEW_CONTROLS__.settleAction('fixture network error', true)"); current = await state(win);
    check(!current.network.disabled && /بطيء/.test(current.network.title), 'rejected network promise must preserve mode and clear busy state');
    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'devtools', open: true }); __PREVIEW_CONTROLS__.emit({ type: 'loading', loading: true })");
    await click(win, 'pvNet');
    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'closed' })"); current = await state(win);
    check(current.open && current.backDisabled && current.forwardDisabled && !current.loading && !current.devtools, 'native closed must reset controls without closing panel');
    check(!current.network.disabled && !current.network.active, 'native closed must reset network state');
    await act(win, "__PREVIEW_CONTROLS__.settleAction({ ok: true, preset: 'net_fast' })"); current = await state(win);
    check(!current.network.active && !current.network.disabled, 'late network response must not resurrect state after close');
    await clear(win); await click(win, 'pvReload'); current = await state(win);
    check(current.calls.some((call) => call.name === 'open') && !current.calls.some((call) => call.name === 'action' && call.args[0] === 'reload'), 'reload after native close must recreate the native preview');
    evidence.push({ scenario: 'network-close', state: current });
    await act(win, "__PREVIEW_CONTROLS__.queueAction({ error: 'closed' })");
    await click(win, 'pvReload'); current = await state(win);
    check(current.open && current.backDisabled && current.forwardDisabled, 'closed action response must keep a recoverable panel');
    await clear(win); await click(win, 'pvReload');
    check((await state(win)).calls.some((call) => call.name === 'open'), 'next reload recreates preview after a closed action response');
    await act(win, "__PREVIEW_CONTROLS__.emit({ type: 'nav', canGoBack: true, canGoForward: true }); __PREVIEW_CONTROLS__.queueAction('fixture action rejection', true)");
    await click(win, 'pvBack');
    check((await state(win)).open && /تعذّر/.test((await state(win)).error), 'rejected navigation action must be reported without an unhandled promise');
    await act(win, `(() => {
      const ctl = window.__PREVIEW_CONTROLS__;
      ctl.previousConfirm = window.confirm; window.confirm = () => true;
      window.satr.devServerInfo = async () => ({ record: { command: 'fixture-command', cwd: 'D:\\preview-fixture' } });
      window.satr.devServerRestart = () => new Promise((_resolve, reject) => { ctl.rejectRestart = reject; });
      document.getElementById('cwd').value = 'D:\\preview-fixture';
      return document.querySelector('satr-preview-panel').refreshServerStatus();
    })()`);
    await click(win, 'pvServerRestart');
    check((await state(win)).restartDisabled, 'server restart disables its pending control');
    await act(win, "__PREVIEW_CONTROLS__.rejectRestart(new Error('fixture restart rejection'))");
    check(!(await state(win)).restartDisabled && /تعذّر إعادة تشغيل/.test((await state(win)).error), 'failed server restart must restore its disabled control');
    await act(win, 'void (window.confirm = __PREVIEW_CONTROLS__.previousConfirm)');
    check(await evaluate(win, '__PREVIEW_CONTROLS__.allCalls.every(call => call.name !== "action" || call.args[0] !== "clear_storage")'), 'لا مسح تخزين في التجربة');
    assert.deepEqual(errors, [], 'console/CSP errors: ' + errors.join(' | ')); checks++;
    const output = path.join(ROOT, 'dist', 'preview-controls-ui-evidence.json');
    fs.writeFileSync(output, JSON.stringify({ checks, mode: 'production renderer, controlled preload boundary', paidTurns: 0, evidence }, null, 2));
    console.log('preview-controls-ui: OK ' + checks + ' checks; zero console/CSP');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().then(() => { clearTimeout(watchdog); app.quit(); }).catch((error) => { clearTimeout(watchdog); console.error(error.stack || error); app.exit(1); });
