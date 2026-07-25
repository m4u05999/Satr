'use strict';

const http = require('http');
const { app, BrowserWindow } = require('electron');
const codex = require('../electron/codex');
const preview = require('../electron/preview');

const requestedRuns = Number.parseInt(process.env.SATR_BROWSER_LOOP_RUNS || '5', 10);
const RUNS = Number.isInteger(requestedRuns) ? Math.max(1, Math.min(requestedRuns, 10)) : 5;
const VERBOSE = process.env.SATR_BROWSER_LOOP_VERBOSE === '1';
const TIMEOUT_MS = 180000;

function fixtureHtml() {
  const buttons = Array.from({ length: 80 }, (_, index) => '<button>عنصر ' + (index + 1) + '</button>').join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>قياس حلقة المتصفح</title></head>
    <body><main><h1>قياس حلقة المتصفح</h1>${buttons}<button id="target">بدّل العنصر</button></main>
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
  const server = http.createServer((request, response) => {
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

function promptFor(url) {
  return `نفّذ JavaScript التالي حرفياً داخل استدعاء functions.exec واحد، بلا shell وبلا تعديل أو اختصار:

const resultText = (result) => Array.isArray(result && result.content)
  ? result.content.map((part) => part && part.text || '').join('\\n') : '';
const findRef = (result) => {
  const match = resultText(result).match(/\\[(s\\d+:e\\d+)\\]\\s+button\\s+"بدّل العنصر"/);
  if (!match) throw new Error('target_ref_missing');
  return match[1];
};
const runs = [];
await tools.mcp__satr_preview__open_preview({ url: ${JSON.stringify(url)} });
for (let index = 0; index < ${RUNS}; index++) {
  const firstSnapshot = await tools.mcp__satr_preview__browser_snapshot({});
  const firstRef = findRef(firstSnapshot);
  const firstClick = await tools.mcp__satr_preview__browser_click({ ref: firstRef });
  const secondSnapshot = await tools.mcp__satr_preview__browser_snapshot({});
  const secondRef = findRef(secondSnapshot);
  const staleClick = await tools.mcp__satr_preview__browser_click({ ref: firstRef });
  const secondClick = await tools.mcp__satr_preview__browser_click({ ref: secondRef });
  const thirdSnapshot = await tools.mcp__satr_preview__browser_snapshot({});
  const page = await tools.mcp__satr_preview__read_page({});
  runs.push({ index, firstRef, secondRef, firstClickError: !!firstClick.isError,
    staleClickError: !!staleClick.isError, secondClickError: !!secondClick.isError,
    staleClickText: resultText(staleClick).slice(0, 160),
    snapshotBytes: resultText(firstSnapshot).length, pageBytes: resultText(page).length });
}
text(JSON.stringify(runs));`;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(calls) {
  const byTool = {};
  for (const call of calls) {
    const tool = call.name.replace(/^satr_preview:/, '');
    if (!byTool[tool]) byTool[tool] = { count: 0, errors: 0, durations: [], successDurations: [], errorDurations: [], bytes: [] };
    const item = byTool[tool];
    item.count++;
    if (call.is_error) item.errors++;
    if (Number.isFinite(call.duration_ms)) {
      item.durations.push(call.duration_ms);
      (call.is_error ? item.errorDurations : item.successDurations).push(call.duration_ms);
    }
    if (Number.isFinite(call.result_bytes)) item.bytes.push(call.result_bytes);
  }
  return Object.fromEntries(Object.entries(byTool).map(([tool, item]) => [tool, {
    count: item.count,
    errors: item.errors,
    median_ms: median(item.durations),
    success_median_ms: median(item.successDurations),
    error_median_ms: median(item.errorDurations),
    median_bytes: median(item.bytes),
    total_bytes: item.bytes.reduce((sum, value) => sum + value, 0),
  }]));
}

async function runTurn(win, url) {
  const calls = [];
  const pending = new Map();
  const permissions = [];
  const diagnostics = [];
  const messages = [];
  let handle = null;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish({ timeout: true }), TIMEOUT_MS);

  const resolvePermission = (event) => {
    permissions.push({ tool: event.tool, input: event.input });
    if (handle) handle.resolvePermission(event.id, false, false);
  };

  handle = await codex.start({
    prompt: promptFor(url), images: [], sessionId: null, model: 'gpt-5.6-sol',
    permissionMode: 'default', skills: [], extraDirs: [], browserControl: true,
    trustedBrowserOrigins: [],
  }, process.cwd(), (event) => {
    if (!event) return;
    if (event.type === 'preview_open') {
      preview.open(win, () => {}, event.url);
      return;
    }
    if (event.type === 'permission_request') {
      setImmediate(() => resolvePermission(event));
      return;
    }
    if (event.type === 'stderr' || event.type === 'spawn_error') diagnostics.push(String(event.text || ''));
    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block && block.type === 'text' && block.text) messages.push(String(block.text));
        if (!block || block.type !== 'tool_use' || !String(block.name || '').startsWith('satr_preview:')) continue;
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
        call.duration_ms = Date.now() - call.started_at;
        call.result_bytes = Buffer.byteLength(String(block.content || ''), 'utf8');
        call.is_error = !!block.is_error;
        if (VERBOSE || call.is_error) call.result_preview = String(block.content || '').slice(0, 500);
        delete call.started_at;
        pending.delete(block.tool_use_id);
      }
    }
    if (event.type === 'result') finish({ result: event });
    if (event.type === 'proc_done') finish({ code: event.code });
  });

  const outcome = await completed;
  clearTimeout(timer);
  if (outcome.timeout && handle) await handle.stop().catch(() => {});
  return { calls, permissions, diagnostics, messages, outcome, summary: summarize(calls) };
}

async function main() {
  await app.whenReady();
  const fixture = await startServer();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    preview.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    codex.resolveCodexBin(true);
    const measurement = await runTurn(win, fixture.url);
    measurement.fixture_requests = fixture.requests();
    measurement.expected_runs = RUNS;
    const clicks = measurement.calls.filter((call) => call.name === 'satr_preview:browser_click');
    const staleClicks = clicks.filter((call) => call.is_error);
    const uniqueRefs = new Set(clicks.map((call) => call.input && call.input.ref));
    const contract = {
      permissions: measurement.permissions.length,
      diagnostics: measurement.diagnostics.length,
      clicks: clicks.length,
      staleClicks: staleClicks.length,
      uniqueRefs: uniqueRefs.size,
      badRefs: clicks.filter((call) => !/^s[1-9][0-9]*:e[1-9][0-9]*$/.test(String(call.input && call.input.ref))).length,
      badStaleMessages: staleClicks.filter((call) => !/لقطة قديمة/.test(String(call.result_preview || ''))).length,
    };
    if (contract.permissions || contract.diagnostics || contract.clicks !== RUNS * 3
        || contract.staleClicks !== RUNS || contract.uniqueRefs !== RUNS * 2
        || contract.badRefs || contract.badStaleMessages) {
      throw new Error('browser_loop_contract_failed ' + JSON.stringify(contract));
    }
    process.stdout.write('SATR_BROWSER_LOOP=' + JSON.stringify(measurement) + '\n');
  } finally {
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
