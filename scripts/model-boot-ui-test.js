#!/usr/bin/env node
'use strict';
// واجهة الإنتاج كاملة في Chromium؛ المحاكاة عند حدود preload الإدارية دون دور نموذج.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const harness = require('./testsprite-harness');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'dist', 'models-surfaces-evidence', 'model-boot-ui.json');
const sourceFlag = process.argv.indexOf('--source');
const sourcePath = sourceFlag < 0 ? null : path.resolve(process.argv[sourceFlag + 1]);
const evidence = [];
app.on('window-all-closed', () => {}); // عمر التطبيق محكوم بخاتمة الحارس، لا بآخر حالة اختبار.
const timeout = setTimeout(() => { console.error('model-boot-ui: FAIL deadline'); app.exit(1); }, 90000);
function browserSetup() {
  const calls = [], controls = {};
  const deferred = (key) => new Promise((resolve) => { controls[key] = resolve; });
  const gate = deferred('gate'), providers = deferred('providers'), models = deferred('models');
  const officialModels = [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high'], isDefault: false },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], isDefault: true },
  ];
  // يوضع التفضيل قبل تحميل app.js ويبقى عبر reload الحقيقي في partition التجربة وحدها.
  if (localStorage.getItem('satr_model_boot_seeded') !== 'true') {
    localStorage.setItem('satr_engine', 'codex');
    localStorage.setItem('satr_cwd', '');
    localStorage.removeItem('satr_model_codex');
    localStorage.setItem('satr_model_boot_seeded', 'true');
  }
  window.satr.preflight = () => { calls.push('gate'); return gate; };
  window.satr.providers = () => { calls.push('providers'); return providers; };
  window.satr.codexModels = () => { calls.push('models'); return models; };
  window.satr.codexStatus = async () => ({ installed: true, auth: { ok: true, method: 'chatgpt' } });
  window.satr.claudeModels = async () => ({ ok: true, models: [{ value: 'claude-current', label: 'Claude الحالي' }] });
  window.satr.conversationCurrent = async () => ({ ok: true, conversation: null });
  window.__MODEL_BOOT_UI__ = {
    calls,
    release(key) {
      if (key === 'gate') controls.gate({ ready: true, preferred: 'codex', readyEngines: ['sdk', 'codex'], node: { ok: true }, claude: { ok: true, version: 'fixture' }, engines: [{ id: 'codex', label: 'Codex', installed: true, ready: true }] });
      if (key === 'providers') controls.providers({ providers: [{ name: 'kimi-code', label: 'Kimi Code', family: 'kimi-native', capabilities: { native: true }, models: [{ value: 'k3', label: 'K3' }] }] });
      if (key === 'models') controls.models(officialModels);
    },
    snapshot() {
      const select = document.getElementById('model');
      return { engine: document.getElementById('engine').value, model: select.value,
        models: [...select.options].map((option) => ({ value: option.value, label: option.textContent })),
        gateHidden: document.querySelector('satr-gate').hidden,
        modelCalls: calls.filter((name) => name === 'models').length,
        savedEngine: localStorage.getItem('satr_engine'), savedModel: localStorage.getItem('satr_model_codex') };
    },
  };
}
function serveJs(response, source) {
  response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(source);
}
async function waitFor(win, expression, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript('Boolean(' + expression + ')')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('مهلة واجهة النماذج: ' + label);
}
async function main() {
  const server = harness.createHarnessServer(), productionHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === '/__testsprite__/mock-satr.js') {
      serveJs(response, harness.harnessClient() + '\n(' + browserSetup.toString() + ')();'); return;
    }
    if (sourcePath && request.url === '/ui/app.js') { serveJs(response, fs.readFileSync(sourcePath, 'utf8')); return; }
    productionHandler(request, response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, harness.HOST, resolve); });
  await app.whenReady();
  let win;
  try {
    let run = 0;
    for (const order of ['providers-first', 'gate-first']) {
      for (const saved of [false, true]) {
        const errors = [];
        win = new BrowserWindow({ show: false, width: 1280, height: 900,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
            backgroundThrottling: false, partition: 'model-boot-ui-' + process.pid + '-' + (++run) } });
        win.webContents.on('console-message', (_event, level, message) => {
          if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(message)) errors.push(message);
        });
        const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
        for (const reload of [false, true]) {
          if (reload) await win.loadURL(win.webContents.getURL());
          else await win.loadURL('http://' + harness.HOST + ':' + server.address().port + '/');
          await waitFor(win, "window.__MODEL_BOOT_UI__ && customElements.get('satr-gate') && __MODEL_BOOT_UI__.calls.includes('gate') && __MODEL_BOOT_UI__.calls.includes('providers')", 'تهيئة المتطلبات');
          const before = await evaluate('__MODEL_BOOT_UI__.snapshot()');
          assert.equal(before.engine, 'codex', 'لم يُستعد محرك Codex قبل اكتمال البوابة');
          assert.equal(before.modelCalls, 0, 'بدأ جلب الكتالوج قبل الجاهزية');
          if (order === 'providers-first') {
            await evaluate("__MODEL_BOOT_UI__.release('providers')");
            await waitFor(win, "document.getElementById('model').options.length >= 4", 'القائمة الاحتياطية');
            assert.equal((await evaluate('__MODEL_BOOT_UI__.snapshot()')).modelCalls, 0);
            await evaluate("__MODEL_BOOT_UI__.release('gate')");
          } else {
            await evaluate("__MODEL_BOOT_UI__.release('gate')");
            await waitFor(win, "__MODEL_BOOT_UI__.calls.includes('models')", 'جلب بعد البوابة');
            await evaluate("__MODEL_BOOT_UI__.release('providers')");
          }
          await waitFor(win, "__MODEL_BOOT_UI__.calls.includes('models') && document.querySelector('satr-gate').hidden", 'الكتالوج المؤجل');
          const pending = await evaluate('__MODEL_BOOT_UI__.snapshot()');
          assert.equal(pending.modelCalls, 1, 'أطلق الإقلاع طلبَي كتالوج متزامنين');
          if (saved) await evaluate("(() => { const m = document.getElementById('model'); m.value = 'gpt-5.6-sol'; m.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await evaluate("__MODEL_BOOT_UI__.release('models')");
          await waitFor(win, "[...document.getElementById('model').options].some(o => o.value === 'gpt-6-astra')", 'ظهور Astra');
          const after = await evaluate('__MODEL_BOOT_UI__.snapshot()');
          assert.equal(after.engine, 'codex');
          assert.equal(after.model, saved ? 'gpt-5.6-sol' : 'gpt-6-astra', 'لم يحترم المنتقي الاختيار المحفوظ أو الافتراضي المعلن');
          assert.equal(after.modelCalls, 1);
          assert.deepEqual(after.models.map((item) => item.value), ['gpt-5.6-sol', 'gpt-6-astra']);
          evidence.push({ order, saved, reload, before, pending, after });
          console.log('PASS model-boot-ui ' + order + ' saved=' + saved + ' reload=' + reload);
        }
        assert.deepEqual(errors, [], 'أخطاء console/CSP: ' + errors.join(' | '));
        win.destroy(); win = null;
      }
    }
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({ mode: 'Chromium production UI, administrative preload fixtures', paidTurns: 0, scenarios: evidence }, null, 2));
    console.log('model-boot-ui: OK ' + evidence.length + '/8; zero console/CSP');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().then(() => { clearTimeout(timeout); app.quit(); }).catch((error) => { clearTimeout(timeout); console.error(error.stack || error); app.exit(1); });