'use strict';

const http = require('http');
const { app, BrowserWindow } = require('electron');
const kimi = require('../electron/kimi');
const preview = require('../electron/preview');

const requestedElements = Number.parseInt(process.env.SATR_BROWSER_LOOP_ELEMENTS || '200', 10);
const ELEMENTS = Number.isInteger(requestedElements) ? Math.max(2, Math.min(requestedElements, 200)) : 200;
const requestedRuns = Number.parseInt(process.env.SATR_BROWSER_LOOP_RUNS || '3', 10);
const RUNS = Number.isInteger(requestedRuns) ? Math.max(1, Math.min(requestedRuns, 5)) : 3;
const requestedPairs = Number.parseInt(process.env.SATR_BROWSER_LOOP_PAIRS || '2', 10);
const PAIRS = Number.isInteger(requestedPairs) ? Math.max(1, Math.min(requestedPairs, 3)) : 2;
const TIMEOUT_MS = 240000;
const executedClickRefs = [];

function fixtureHtml() {
  const buttons = Array.from({ length: ELEMENTS - 1 }, (_, index) => '<button>عنصر ' + (index + 1) + '</button>').join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>قياس Kimi لحلقة المتصفح</title></head>
    <body><main><h1>قياس Kimi لحلقة المتصفح</h1>${buttons}<button id="target">بدّل العنصر</button></main>
    <script>
      function replaceTarget(event) {
        const next = document.createElement('button');
        next.id = 'target';
        next.textContent = 'بدّل العنصر';
        next.addEventListener('click', replaceTarget);
        event.currentTarget.replaceWith(next);
      }
      document.getElementById('target').addEventListener('click', replaceTarget);
    </script></body></html>`;
}

function startServer() {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fixtureHtml());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: 'http://127.0.0.1:' + server.address().port + '/',
    requests: () => requests,
  })));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part && typeof part.text === 'string' ? part.text : '').join('\n');
}

function bareTool(name) {
  return String(name || '').replace(/^mcp__[^_]+__/, '').replace(/^mcp__satr[^_]*__/, '');
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function promptText(useDelta) {
  const repetitions = Array.from({ length: RUNS * 2 }, (_, index) => useDelta
    ? `${index + 1}) نفّذ browser_click بالـref الحالي، ثم استخرج ref الجديدة من «تغيّر DOM المختصر» ولا تأخذ snapshot.`
    : `${index + 1}) نفّذ browser_click بالـref الحالي، ثم خذ browser_snapshot واستخرج ref الجديدة منها.`).join('\n');
  return `هذه مهمة قياس حتمية قصيرة. لا تستخدم أي أداة أصلية أو تخطيط أو وكيل فرعي؛ استخدم فقط browser_snapshot وbrowser_click من خادم satr، ولا تستخدم CSS selectors.
1. خذ browser_snapshot واحدة واستخرج ref للزر الذي اسمه «بدّل العنصر».
2. نفّذ الخطوات ${RUNS * 2} التالية كلها بالترتيب، ولا تتوقف قبل إكمالها:
${repetitions}
3. قبل الإنهاء تأكد أن المجموع browser_snapshot عددها ${useDelta ? 1 : RUNS * 2 + 1} وbrowser_click عددها ${RUNS * 2} بالضبط، ثم اكتب «تم» فقط.`;
}

async function runTurn(useDelta) {
  const clickRefStart = executedClickRefs.length;
  const calls = [];
  const pending = new Map();
  const permissions = [];
  const diagnostics = [];
  let result = null;
  let handle = null;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish({ timeout: true }), TIMEOUT_MS);

  const emit = (event) => {
    if (!event) return;
    if (event.type === 'permission_request') {
      permissions.push({ tool: event.tool });
      queueMicrotask(() => { if (handle) handle.resolvePermission(event.id, false, false); });
      return;
    }
    if (event.type === 'question_request' || event.type === 'handoff_request') diagnostics.push(event.type);
    if (event.type === 'stderr' || event.type === 'spawn_error') diagnostics.push(String(event.text || '').slice(0, 1000));
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!block || block.type !== 'tool_use') continue;
        const call = { id: block.id, name: block.name, input: block.input || {}, started_at: Date.now() };
        calls.push(call);
        pending.set(block.id, call);
      }
    }
    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!block || block.type !== 'tool_result') continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        const text = contentText(block.content);
        call.duration_ms = Date.now() - call.started_at;
        call.result_bytes = Buffer.byteLength(text, 'utf8');
        call.is_error = block.is_error === true;
        if (call.is_error) call.result_preview = text.slice(0, 500);
        delete call.started_at;
        pending.delete(block.tool_use_id);
      }
    }
    if (event.type === 'result') result = event;
    if (event.type === 'proc_done') finish({ code: event.code });
  };

  handle = await kimi.start({
    prompt: promptText(useDelta), images: [], sessionId: null, model: 'k3',
    permissionMode: 'default', skills: [], effort: null,
    browserControl: true, trustedBrowserOrigins: new Set(),
  }, process.cwd(), emit);

  const outcome = await completed;
  clearTimeout(timer);
  if (outcome.timeout && handle) await handle.stop().catch(() => {});
  return { calls, permissions, diagnostics, result, outcome, executedClickRefs: executedClickRefs.slice(clickRefStart) };
}

function measurementReport(measurement, useDelta, index) {
  const snapshots = measurement.calls.filter((call) => bareTool(call.name) === 'browser_snapshot');
  const clicks = measurement.calls.filter((call) => bareTool(call.name) === 'browser_click');
  const unexpected = measurement.calls.filter((call) => !['browser_snapshot', 'browser_click'].includes(bareTool(call.name)));
  const contract = {
    permissions: measurement.permissions.length,
    permissionNames: measurement.permissions.map((item) => item.tool),
    diagnostics: measurement.diagnostics.length,
    snapshots: snapshots.length,
    clicks: clicks.length,
    unexpected: unexpected.length,
    unexpectedNames: unexpected.map((call) => bareTool(call.name)),
    errors: measurement.calls.filter((call) => call.is_error).length,
    executedClicks: measurement.executedClickRefs.length,
    badRefs: measurement.executedClickRefs.filter((ref) => !/^s[1-9][0-9]*:e[1-9][0-9]*$/.test(ref)).length,
    clickRefs: measurement.executedClickRefs,
    pending: measurement.calls.filter((call) => !Number.isFinite(call.result_bytes)).length,
    resultError: !!(measurement.result && measurement.result.is_error),
  };
  const expectedSnapshots = useDelta ? 1 : RUNS * 2 + 1;
  if (contract.permissions || contract.diagnostics || contract.snapshots !== expectedSnapshots
      || contract.clicks !== RUNS * 2 || contract.executedClicks !== contract.clicks
      || contract.unexpected || contract.errors || contract.badRefs
      || contract.pending || contract.resultError || !measurement.result) {
    throw new Error('browser_loop_kimi_contract_failed ' + JSON.stringify({ mode: useDelta ? 'delta' : 'snapshot', contract }));
  }
  const snapshotBytes = snapshots.reduce((sum, call) => sum + call.result_bytes, 0);
  const clickBytes = clicks.reduce((sum, call) => sum + call.result_bytes, 0);
  return {
    index, mode: useDelta ? 'delta' : 'snapshot', contract,
    snapshot_bytes: snapshotBytes,
    click_bytes: clickBytes,
    browser_tool_bytes: snapshotBytes + clickBytes,
    duration_ms: measurement.result.duration_ms,
    total_cost_usd: measurement.result.total_cost_usd,
  };
}

function aggregateRuns(runs, mode) {
  const selected = runs.filter((run) => run.mode === mode);
  return {
    count: selected.length,
    median_snapshots: median(selected.map((run) => run.contract.snapshots)),
    median_clicks: median(selected.map((run) => run.contract.clicks)),
    median_browser_tool_bytes: median(selected.map((run) => run.browser_tool_bytes)),
    median_duration_ms: median(selected.map((run) => run.duration_ms)),
    median_total_cost_usd: median(selected.map((run) => run.total_cost_usd)),
  };
}

async function reloadFixture(url) {
  const navigated = preview.navigate(url);
  if (!navigated.ok) throw new Error('fixture_reload_failed');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && preview.currentUrl() !== url) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (preview.currentUrl() !== url) throw new Error('fixture_reload_timeout');
  const ready = await preview.waitFor({ selector: '#target' }, 8000);
  if (!ready.ok || !ready.found) throw new Error('fixture_reload_not_ready');
}

async function main() {
  await app.whenReady();
  if (!kimi.resolveKimiBin(true)) throw new Error('kimi_binary_missing');
  if (!kimi.authStatus().ok) throw new Error('kimi_auth_missing');
  const fixture = await startServer();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const originalClickElement = preview.clickElement;
  preview.clickElement = async (locator) => {
    executedClickRefs.push(String(locator || ''));
    return originalClickElement(locator);
  };
  try {
    preview.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    const opened = preview.open(win, () => {}, fixture.url);
    if (!opened.ok) throw new Error('preview_open_failed');
    const ready = await preview.waitFor({ selector: '#target' }, 8000);
    if (!ready.ok || !ready.found) throw new Error('fixture_not_ready');

    const sequence = [];
    for (let pair = 0; pair < PAIRS; pair++) sequence.push(...(pair % 2 === 0 ? [false, true] : [true, false]));
    const runs = [];
    for (let index = 0; index < sequence.length; index++) {
      if (index > 0) await reloadFixture(fixture.url + '?paired=' + (index + 1));
      const report = measurementReport(await runTurn(sequence[index]), sequence[index], index + 1);
      runs.push(report);
      process.stdout.write('SATR_BROWSER_LOOP_KIMI_RUN=' + JSON.stringify(report) + '\n');
    }
    const paired = {
      engine: 'kimi-code', model: 'k3', elements: ELEMENTS, runs_per_turn: RUNS,
      pairs: PAIRS, fixture_requests: fixture.requests(), order: runs.map((run) => run.mode), runs,
      aggregate: { snapshot: aggregateRuns(runs, 'snapshot'), delta: aggregateRuns(runs, 'delta') },
    };
    process.stdout.write('SATR_BROWSER_LOOP_KIMI_PAIRED=' + JSON.stringify(paired) + '\n');
  } finally {
    preview.clickElement = originalClickElement;
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => fixture.server.close(resolve));
    app.quit();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
