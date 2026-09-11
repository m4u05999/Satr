'use strict';
// تجربة مصدر معزولة لأزرار المعاينة: نقر إنتاجي وحدود وinnerWidth من WebContentsView الحقيقي.
const fs = require('fs'), path = require('path'), http = require('http'), assert = require('assert'), crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./lib/live-test-run');
const { connectMain } = require('./lib/live-test-client');
const { completionExitCode } = require('./live-test');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
async function main() {
  const [action, id, attemptText = '1'] = process.argv.slice(2);
  if (action === 'prepare') {
    const run = core.prepareRun(repo, {});
    const dir = path.join(run.paths.root, 'preview-controls'); fs.mkdirSync(dir);
    write(path.join(dir, 'criteria.json'), { prepared: new Date().toISOString(), mode: 'source',
      budgetMinutes: 20, maxAttemptsPerFailure: 2, paidTurns: 0, recording: false,
      pass: 'زر الجهاز يزيل مقاس الأداة ويطابق عرض الصفحة الحقيقي؛ الحجب يبقى صفراً والتنقل والأزرار تعكس نتائجها الفعلية.',
      fail: 'المقاس يبقى عالقاً أو يخالف الزر أو تظهر الصفحة تحت الحجب أو يدعي زر النجاح بعد فشل فعله.',
      limits: ['عزل منزل وprofile، لا مصادقة من المالك.', 'قيادة آلية لمسارات الإنتاج وليست قبولاً بشرياً.', 'نسخة source؛ لا يثبت تشغيل الحزمة.'] });
    console.log(JSON.stringify({ id: run.id, evidence: dir })); return;
  }
  const run = core.loadRun(repo, id), dir = path.join(run.paths.root, 'preview-controls');
  assert(fs.existsSync(dir), 'experiment_not_prepared');
  if (action === 'launch') {
    let boot = 0;
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/fail') { res.destroy(); return; }
      if (!['/one', '/two'].includes(pathname)) { res.writeHead(404); res.end('Not found'); return; }
      const probe = { page: pathname.slice(1), boot: ++boot };
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview controls ' + probe.page + '</title></head><body><h1>Preview controls: ' + probe.page + '</h1><p>Local source test. No account or paid model.</p><a href="' + (probe.page === 'one' ? '/two' : '/one') + '">Next page</a><script>window.__previewControls=' + JSON.stringify(probe) + '; window.__previewControls.frames=0;window.__previewControls.events=[];const sample=kind=>window.__previewControls.events.push({kind,time:Date.now(),width:innerWidth,height:innerHeight,visibility:document.visibilityState});sample("initial");addEventListener("resize",()=>sample("resize"));document.addEventListener("visibilitychange",()=>sample("visibility")); function frame(){window.__previewControls.frames++;if(window.__previewControls.frames<120)requestAnimationFrame(frame)}requestAnimationFrame(frame); console.log("preview-controls-ready",window.__previewControls.boot);</script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const files = ['electron/main.js', 'electron/preload.js', 'electron/preview.js', 'src/ui/components/preview-panel.js', 'src/ui/lib/preview-shield.js'];
    const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
    write(path.join(dir, 'launch.json'), { started: new Date().toISOString(), page: 'http://127.0.0.1:' + server.address().port, hashes });
    const child = spawn(require('electron'), [path.join(__dirname, 'preview-controls-live-launch.js'), id, '--live-debug'],
      { cwd: repo, env: core.buildChildEnv(process.env, run), stdio: 'inherit', shell: false });
    child.once('error', () => { server.close(); process.exitCode = 1; });
    child.once('exit', code => { server.close(); process.exitCode = completionExitCode(repo, id, code); });
    return;
  }
  assert(['verify', 'verify-tail', 'verify-after-devtools'].includes(action), 'bad_action');
  const afterDevtools = action === 'verify-after-devtools', tail = action !== 'verify';
  const attempt = Number(attemptText); assert([1, 2].includes(attempt), 'attempt_limit');
  const resultFile = path.join(dir, (afterDevtools ? 'continued-verified-' : tail ? 'tail-verified-' : 'verified-') + attempt + '.json'), failureFile = path.join(dir, (afterDevtools ? 'continued-failed-' : tail ? 'tail-failed-' : 'failed-') + attempt + '.json');
  assert(!fs.existsSync(resultFile) && !fs.existsSync(failureFile), 'attempt_already_recorded');
  const launch = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
  const deadline = Date.parse(launch.started) + 20 * 60 * 1000;
  const client = await connectMain(repo, id), results = [], limits = [];
  if (tail) {
    const previous = JSON.parse(fs.readFileSync(path.join(dir, (afterDevtools ? 'tail-failed-' : 'failed-') + attempt + '.json'), 'utf8'));
    assert(afterDevtools ? previous.stage === 'devtools-open-detaches-debugger' : previous.stage === 'wrapper-network-probe' && previous.error === 'wrapper_network-probe: TypeError', 'tail_precondition');
    results.push(...previous.results); limits.push(...previous.limits, 'استُكملت من offline بعد تصحيح تصادم اسم error في مسبار fetch؛ لم تُعَد حالات المقاس الناجحة.');
  }
  let stage = 'boot', requestSequence = 0;
  const native = () => JSON.parse(fs.readFileSync(path.join(dir, 'native.json'), 'utf8'));
  const inspect = () => client.evaluate('(()=>{const p=document.querySelector("satr-preview-panel"),r=p.shadowRoot,b=r.getElementById("pvBox").getBoundingClientRect();return {open:p.hasAttribute("open"),box:b.toJSON(),device:localStorage.getItem("satr_preview_device")||"0",deviceTitle:r.getElementById("pvDevice").title,network:r.getElementById("pvNet").title,networkIcon:r.getElementById("pvNet").textContent,more:!r.getElementById("pvTools").hidden,console:r.getElementById("pvConsole").classList.contains("show"),error:r.getElementById("pvErr").classList.contains("show"),errorText:r.getElementById("pvErrText").textContent,scrollX,docWidth:document.documentElement.scrollWidth,width:innerWidth}})()');
  async function until(test, label, timeoutMs = 8000) {
    stage = label;
    const end = Math.min(deadline, Date.now() + timeoutMs);
    while (Date.now() < end) { try { if (await test()) return; } catch {} await pause(80); }
    throw Error(Date.now() >= deadline ? 'budget_exhausted: ' + label : 'timeout: ' + label);
  }
  async function command(action, extra = {}) {
    const commandId = 'a' + attempt + '-' + (++requestSequence) + '-' + Date.now();
    write(path.join(dir, 'request.json'), { id: commandId, action, ...extra });
    let response;
    await until(() => {
      response = JSON.parse(fs.readFileSync(path.join(dir, 'response.json'), 'utf8'));
      return response.id === commandId;
    }, 'wrapper-' + action);
    assert(!response.result.error || (action === 'network-probe' && typeof response.result.online === 'boolean' && typeof response.result.fetch === 'boolean'), 'wrapper_' + action + ': ' + response.result.error);
    return response.result;
  }
  async function click(button, main = false) {
    const expression = main ? 'document.getElementById(' + JSON.stringify(button) + ')' : 'document.querySelector("satr-preview-panel").shadowRoot.getElementById(' + JSON.stringify(button) + ')';
    const state = await client.evaluate('(()=>{const e=' + expression + ';return {visible:!!e&&e.checkVisibility({visibilityProperty:true}),disabled:!!e&&e.disabled}})()');
    assert(state.visible && !state.disabled, 'button_not_interactive: ' + button);
    await client.evaluate(expression + '.click()');
  }
  async function record(label, test) {
    await until(test, label);
    const n = native(), ui = await inspect();
    assert(ui.scrollX === 0 && ui.docWidth <= ui.width + 1, 'document_overflow: ' + label);
    results.push({ label, time: new Date().toISOString(), native: n, ui });
    write(path.join(dir, (afterDevtools ? 'continued-progress-' : tail ? 'tail-progress-' : 'progress-') + attempt + '.json'), { stage: label, results, limits });
  }
  async function device(label) {
    await record(label, async () => {
      const n = native(), ui = await inspect(), view = n.views[0];
      const desired = [0, 390, 768][Number(ui.device)];
      const expected = Math.round(desired ? Math.min(desired, ui.box.width) : ui.box.width);
      return n.views.length === 1 && view.page && view.bounds.width === expected && view.page.width === expected && expected > 100;
    });
  }
  async function page(name, label) {
    await record(label, () => {
      const views = native().views;
      return views.length === 1 && !views[0].loading && views[0].page && views[0].page.probe && views[0].page.probe.page === name;
    });
  }
  async function navigate(suffix) {
    const url = launch.page + suffix;
    await client.evaluate('(()=>{const e=document.querySelector("satr-preview-panel").shadowRoot.getElementById("pvUrl");e.value=' + JSON.stringify(url) + ';e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()');
  }
  async function resizePanel(key) {
    await client.evaluate('document.querySelector("satr-preview-panel").shadowRoot.getElementById("pvResizer").dispatchEvent(new KeyboardEvent("keydown",{key:' + JSON.stringify(key) + ',bubbles:true}))');
  }
  try {
    if (!tail) {
    await command('window', { width: 1440 });
    await until(() => client.evaluate('!!document.querySelector("satr-preview-panel").openWith'), 'components');
    await client.evaluate('(()=>{document.querySelector("satr-gate").hidden=true;document.getElementById("cwd").value=' + JSON.stringify(run.paths.workspace) + ';document.getElementById("cwd").dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await client.evaluate('document.querySelector("satr-preview-panel").openWith(' + JSON.stringify(launch.page + '/one') + ')');
    await page('one', 'initial-local-page');
    // إعادة الاختبار تمر بالأزرار نفسها؛ لا نزوّر الفهرس الداخلي أو المقاس المحفوظ.
    for (let i = 0; i < 2 && Number((await inspect()).device) !== 0; i++) { await click('pvDevice'); await device('prepare-full-' + i); }
    assert(Number((await inspect()).device) === 0, 'initial_device_not_full');
    await record('local-page-rendered', () => native().views[0].page.probe.frames >= 2 && native().views[0].page.visibility === 'visible');
    await resizePanel('End');
    await device('initial-full-width');

    const override = await command('set-viewport', { width: 300, height: 400 });
    results.push({ label: 'set-viewport-response', response: override, time: new Date().toISOString() });
    if (!override.actual || override.actual.width !== 300) limits.push('setViewport.actual ردّ بمقاس قديم؛ نجاح زر الجهاز يُحسم بأبعاد الصفحة الفعلية التالية، وفشل المحاولة الأولى محفوظ.');
    await record('agent-override-300', () => native().views[0].bounds.width === 300 && native().views[0].page.width === 300);
    await click('pvDevice'); await device('device-clears-override-mobile');
    assert(Number((await inspect()).device) === 1 && native().views[0].page.width === 390, 'mobile_not_390');
    await click('pvDevice'); await device('tablet-768');
    assert(native().views[0].page.width === 768, 'tablet_not_768');
    await click('pvDevice'); await device('back-to-full');

    await command('set-viewport', { width: 300, height: 400 });
    await client.evaluate('(()=>{const b=document.querySelector("satr-preview-panel").shadowRoot.getElementById("pvDevice");b.click();b.click();b.click();return true})()');
    await device('rapid-device-clicks-consistent');
    await resizePanel('Home'); await device('narrow-panel-current-device');
    await click('pvDevice'); await device('narrow-panel-next-device');
    await resizePanel('End'); await device('expanded-panel-restores-device');

    await command('set-viewport', { width: 300, height: 400 });
    await click('settingsBtn', true);
    await record('override-held-zero', () => native().views[0].bounds.width === 0 && native().views[0].bounds.height === 0);
    await command('set-viewport', { width: 280, height: 360 });
    await record('override-changed-while-held-zero', () => native().views[0].bounds.width === 0 && native().views[0].bounds.height === 0);
    await click('settingsClose', true);
    await record('override-restored-after-hold', () => native().views[0].bounds.width === 280 && native().views[0].page.width === 280);
    await click('pvDevice'); await device('device-clears-second-override');

    await navigate('/two'); await page('two', 'navigate-second-page');
    await click('pvBack'); await page('one', 'back-button');
    await click('pvFwd'); await page('two', 'forward-button');
    const boot = native().views[0].page.probe.boot;
    await click('pvReload');
    await record('reload-button', () => { const p = native().views[0].page; return p && p.probe && p.probe.page === 'two' && p.probe.boot > boot; });
    await click('pvConsoleBtn');
    await record('console-open', async () => (await inspect()).console);
    await click('pcClose');
    await record('console-close', async () => !(await inspect()).console);
    await click('pvMore');
    await record('more-open', async () => (await inspect()).more);

    await click('pvNet'); await record('network-slow', async () => (await inspect()).network.includes('بطيء'));
    await click('pvNet'); await record('network-fast', async () => (await inspect()).network.includes('سريع'));
    await click('pvNet'); await record('network-offline', async () => (await inspect()).network.includes('غير متصل'));
    }
    const offline = await command('network-probe');
    results.push({ label: 'offline-real-fetch', probe: offline, time: new Date().toISOString() });
    assert(offline.online === false && offline.fetch === false, 'offline_not_effective: ' + JSON.stringify(offline));
    if (!afterDevtools) await click('pvDevtools');
    await record('devtools-open', () => native().views[0].devtools);
    const afterDevtoolsProbe = await command('network-probe');
    write(path.join(dir, 'devtools-probe-' + attempt + '.json'), { offline, afterDevtoolsProbe, native: native(), ui: await inspect() });
    if (native().views[0].debuggerAttached) {
      assert(afterDevtoolsProbe.online === false && afterDevtoolsProbe.fetch === false, 'devtools_offline_inconsistent');
      limits.push('فتح DevTools أبقى debugger متصلاً وoffline فعّالاً؛ لا تثبت هذه الخطوة حدث detach الخالص.');
      await click('pvNet');
    }
    await record('network-ui-online', async () => (await inspect()).network.includes('عادي'));
    const online = await command('network-probe');
    assert(online.online === true && online.fetch === true, 'online_not_restored: ' + JSON.stringify(online));
    results.push({ label: 'online-real-fetch', probe: online, native: native(), time: new Date().toISOString() });
    await click('pvDevtools');
    await record('devtools-close', () => !native().views[0].devtools);
    await navigate('/fail');
    await record('network-load-failure-visible', async () => (await inspect()).error);
    await navigate('/two'); await page('two', 'network-recovered');
    await command('window', { width: 1000 }); await resizePanel('Home'); await device('narrow-window-device');
    await click('pvDevice'); await device('narrow-window-device-click');
    await command('window', { width: 1440 }); await resizePanel('End'); await device('wide-window-device');

    const previousView = native().views[0].id;
    await click('pvClose');
    await until(() => native().views.length === 0, 'preview-destroyed');
    results.push({ label: 'preview-destroyed', native: native(), time: new Date().toISOString() });
    await click('previewToggle', true); await page('two', 'reopen-saved-page'); await device('reopen-current-device');
    assert(native().views[0].id !== previousView, 'reopen_did_not_recreate_native_view');
    try { await command('shot', { name: 'controls-final-' + attempt }); } catch (error) { limits.push('screenshot: ' + error.message); }
    write(resultFile, { pass: true, attempt, checks: results.length, time: new Date().toISOString(), results, limits });
    console.log(JSON.stringify({ pass: true, checks: results.length, evidence: dir, limits }));
  } catch (error) {
    let n = null, ui = null; try { n = native(); } catch {} try { ui = await inspect(); } catch {}
    write(failureFile, { pass: false, attempt, stage, error: error.message, time: new Date().toISOString(), native: n, ui, results, limits });
    throw error;
  } finally { client.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
