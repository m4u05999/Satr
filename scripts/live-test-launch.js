'use strict';

// غلاف تطوير يحمّل main.js نفسه بعد عزل المنزل؛ لا يحمل نسخة مقلدة من منطق التطبيق.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app, dialog, screen } = require('electron');
const core = require('./lib/live-test-run');
const repo = path.resolve(__dirname, '..');
const run = core.loadRun(repo, process.argv[2]);
if (path.resolve(os.homedir()) !== run.paths.home) throw new Error('home_not_isolated');
if (process.argv.slice(3).some(value => !['--record-consent', '--live-debug', '--smoke', '--recording-hd'].includes(value))) throw new Error('bad_option');
const lock = fs.openSync(path.join(run.paths.root, 'launch.lock'), 'wx');
fs.writeSync(lock, String(process.pid));
app.setAppPath(repo);
app.setPath('home', run.paths.home);
app.setPath('userData', run.paths.profile);
app.setPath('downloads', run.paths.downloads);
if (process.argv.includes('--live-debug')) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
process.chdir(run.paths.workspace);
const promo = require('../electron/promocapture');
const expectedUrl = pathToFileURL(path.join(repo, 'src', 'index.html')).href;
let owner = null, server = null, currentScenario = '', evidenceCount = 0, busy = false;
let oneRecordingConsent = process.argv.includes('--record-consent');
let failed = false;
const startupTimer = setTimeout(() => { failed = true; console.error('LIVE_TEST_FAILED startup_timeout'); app.quit(); }, 90000);
const token = crypto.randomBytes(32).toString('hex');
function evidence(kind, status, extra = {}) {
  return core.writeEvidence(repo, run.id, kind + '-' + String(++evidenceCount).padStart(4, '0') + '.json',
    { kind, status, time: new Date().toISOString(), ...extra });
}
function status() {
  let debugPort = null;
  if (process.argv.includes('--live-debug')) {
    try {
      const first = fs.readFileSync(path.join(run.paths.profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      if (/^[0-9]{1,5}$/.test(first) && Number(first) > 0 && Number(first) <= 65535) debugPort = Number(first);
    } catch {}
  }
  return { ok: true, id: run.id, pid: process.pid, ready: !!owner && !owner.isDestroyed(),
    profile: run.paths.profile, workspace: run.paths.workspace, windowId: owner && owner.id,
    mainUrl: expectedUrl, debugPort,
    recording: !!currentScenario, scenario: currentScenario || null,
    downloads: run.paths.downloads, recordingHd: process.argv.includes('--recording-hd'), mode: 'source', isolation: 'home-profile-environment', osSandbox: false };
}
async function recordStart(scenario, signal) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scenario || '')) return { ok: false, error: 'bad_scenario' };
  if (currentScenario) return { ok: false, error: 'busy' };
  // علم التشغيلة يستهلك مرة واحدة، ولا يُستعمل إلا بعد إذن تسجيل صريح في أمر إطلاقها.
  let confirmed = oneRecordingConsent;
  oneRecordingConsent = false;
  if (!confirmed) {
    const choice = await dialog.showMessageBox(owner, { type: 'question', title: 'تسجيل نسخة الاختبار',
      message: 'تسجيل نافذة سطر التجريبية لهذا السيناريو؟',
      detail: scenario + '\nفيديو صامت لنافذة الاختبار وحدها، يُحفظ في تنزيلات التجربة.',
      buttons: ['إلغاء', 'ابدأ التسجيل'], defaultId: 0, cancelId: 0, signal });
    confirmed = choice.response === 1;
  }
  if (!confirmed || signal && signal.aborted) return { ok: false, error: 'confirmation_required' };
  const result = await promo.startAppWindow(owner, { confirmed, scenario, testRun: run.id });
  if (result.ok) {
    currentScenario = scenario;
    owner.setTitle('سطر — تسجيل الاختبار: ' + scenario);
    evidence('recording', 'recording', { scenario, pid: process.pid, windowId: owner.id });
  }
  return result;
}
async function recordStop() {
  if (!currentScenario) return { ok: false, error: 'not_recording' };
  const scenario = currentScenario;
  const result = await promo.stop();
  currentScenario = '';
  if (owner && !owner.isDestroyed()) owner.setTitle('سطر — اختبار حي ' + run.id.slice(-6));
  if (!result.ok) { evidence('recording', 'failed', { scenario, errorCode: result.error }); return result; }
  const segment = promo.listSegments().segments.find(item => item.path === result.path);
  if (!segment || path.dirname(result.path) !== run.paths.downloads || fs.lstatSync(result.path).isSymbolicLink()) {
    throw new Error('bad_recording_path');
  }
  const bytes = fs.readFileSync(result.path);
  if (bytes.length < 1024) throw new Error('empty_recording');
  const metadata = { scenario, file: path.basename(result.path), bytes: bytes.length,
    durationMs: result.duration_ms, width: segment.width, height: segment.height,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  evidence('recording', 'stopped', metadata);
  return { ...result, ...metadata, scenarioResult: 'not_evaluated' };
}
async function action(input, signal) {
  if (input.action === 'status') return status();
  if (busy) return { ok: false, error: 'busy' };
  busy = true;
  try {
    if (input.action === 'record-start') return await recordStart(input.scenario, signal);
    if (input.action === 'record-stop') return await recordStop();
    if (input.action === 'close') {
      let result = { ok: true, status: 'closing' };
      try {
        if (currentScenario) {
          const saved = await recordStop();
          if (!saved.ok) { failed = true; result = { ok: false, error: 'recording_save_failed', recording: saved }; }
        }
      } catch { failed = true; result = { ok: false, error: 'recording_save_failed' }; }
      finally { setImmediate(() => app.quit()); }
      return result;
    }
    return { ok: false, error: 'bad_action' };
  } finally { busy = false; }
}
async function listen() {
  server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' || request.url !== '/command' || request.headers.origin
        || request.headers['x-satr-live-token'] !== token) {
      response.writeHead(403); response.end('{"ok":false,"error":"forbidden"}'); return;
    }
    const abort = new AbortController();
    response.once('close', () => { if (!response.writableEnded) abort.abort(); });
    let body = '';
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 2048) throw new Error('bad_input');
      }
      response.end(JSON.stringify(await action(JSON.parse(body), abort.signal)));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ ok: false, error: /^[a-z0-9_-]{1,80}$/.test(error.message) ? error.message : 'command_failed' }));
    }
  });
  server.requestTimeout = 65000;
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  // قدرة محلية خاصة لا تُطبع؛ CLI يقرأها مباشرة ولا يمررها إلى المحادثة.
  fs.writeFileSync(path.join(run.paths.root, 'control.json'),
    JSON.stringify({ id: run.id, port: server.address().port, token }), { flag: 'wx', mode: 0o600 });
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    if (owner || window.webContents.getURL() !== expectedUrl) return;
    owner = window;
    owner.setTitle('سطر — اختبار حي ' + run.id.slice(-6));
    try {
      if (process.argv.includes('--recording-hd')) {
        const display = screen.getDisplayMatching(owner.getBounds());
        if (display.size.width * display.scaleFactor < 1920 || display.size.height * display.scaleFactor < 1080) {
          throw new Error('native_full_hd_unavailable');
        }
        owner.setFullScreen(true);
      }
      await owner.webContents.executeJavaScript('customElements.whenDefined("satr-preview-panel").then(() => true)');
      clearTimeout(startupTimer);
      await listen();
      const sources = ['electron/main.js', 'electron/promocapture.js', 'electron/preload.js', 'src/index.html', 'src/ui/components/preview-panel.js'];
      const fingerprint = crypto.createHash('sha256');
      for (const file of sources) fingerprint.update(file).update(fs.readFileSync(path.join(repo, file)));
      evidence('launch', 'ready', { pid: process.pid, windowId: owner.id, sha256: fingerprint.digest('hex') });
      console.log('LIVE_TEST_READY ' + JSON.stringify(status()));
      if (process.argv.includes('--smoke')) {
        const timer = setTimeout(() => { failed = true; console.error('LIVE_TEST_FAILED smoke_timeout'); app.quit(); }, 60000);
        try { await require('./live-test-smoke')({ owner, run, recordStart, recordStop, evidence }); }
        finally { clearTimeout(timer); }
        console.log('LIVE_TEST_SMOKE PASS');
        app.quit();
      }
    } catch (error) {
      console.error('LIVE_TEST_FAILED ' + String(error.message).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100));
      failed = true;
      try { evidence('scenario', 'failed', { scenario: 'app-window-smoke', errorCode: 'smoke_failed' }); }
      finally { app.quit(); }
    }
  });
});
app.once('will-quit', () => {
  clearTimeout(startupTimer);
  if (server) server.close();
  fs.closeSync(lock);
  try { fs.unlinkSync(path.join(run.paths.root, 'control.json')); } catch {}
  if (currentScenario) failed = true;
  try { core.writeEvidence(repo, run.id, 'completion.json', { kind: 'shutdown', status: failed ? 'failed' : 'closed', pid: process.pid }); }
  catch { failed = true; }
  if (failed) app.exit(1);
});
require('../electron/main');
