'use strict';

const http = require('http');
const { app, BrowserWindow } = require('electron');
const agent = require('../electron/agent');
const preview = require('../electron/preview');

const requestedElements = Number.parseInt(process.env.SATR_BROWSER_LOOP_ELEMENTS || '81', 10);
const ELEMENTS = Number.isInteger(requestedElements) ? Math.max(2, Math.min(requestedElements, 200)) : 81;
const requestedRuns = Number.parseInt(process.env.SATR_BROWSER_LOOP_RUNS || '3', 10);
const RUNS = Number.isInteger(requestedRuns) ? Math.max(1, Math.min(requestedRuns, 5)) : 3;
const USE_DELTA = process.env.SATR_BROWSER_LOOP_USE_DELTA === '1';
const requestedPairs = Number.parseInt(process.env.SATR_BROWSER_LOOP_PAIRS || '0', 10);
const PAIRS = Number.isInteger(requestedPairs) ? Math.max(0, Math.min(requestedPairs, 4)) : 0;
const TIMEOUT_MS = 240000;
const VERBOSE = process.env.SATR_BROWSER_LOOP_VERBOSE === '1';

function fixtureHtml() {
  const buttons = Array.from({ length: ELEMENTS - 1 }, (_, index) => '<button>عنصر ' + (index + 1) + '</button>').join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>قياس Claude لحلقة المتصفح</title></head>
    <body><main><h1>قياس Claude لحلقة المتصفح</h1>${buttons}<button id="target">بدّل العنصر</button></main>
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
  return String(name || '').replace(/^mcp__satr-terminal__/, '');
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(calls) {
  const grouped = {};
  for (const call of calls) {
    const tool = bareTool(call.name);
    if (!grouped[tool]) grouped[tool] = { count: 0, errors: 0, durations: [], bytes: [] };
    const item = grouped[tool];
    item.count++;
    if (call.is_error) item.errors++;
    if (Number.isFinite(call.duration_ms)) item.durations.push(call.duration_ms);
    if (Number.isFinite(call.result_bytes)) item.bytes.push(call.result_bytes);
  }
  return Object.fromEntries(Object.entries(grouped).map(([tool, item]) => [tool, {
    count: item.count,
    errors: item.errors,
    median_ms: median(item.durations),
    median_bytes: median(item.bytes),
    total_bytes: item.bytes.reduce((sum, value) => sum + value, 0),
  }]));
}

function promptText(useDelta) {
  const repetitions = Array.from({ length: RUNS * 2 }, (_, index) => useDelta
    ? `${index + 1}) نفّذ browser_click بالـref الحالي، ثم استخرج ref الجديدة من «تغيّر DOM المختصر» ولا تأخذ snapshot.`
    : `${index + 1}) نفّذ browser_click بالـref الحالي، ثم خذ browser_snapshot واستخرج ref الجديدة منها.`).join('\n');
  if (useDelta) {
    return `هذه مهمة قياس حتمية قصيرة. يمكنك استخدام ToolSearch مرة واحدة لتحميل الأداتين، وبعدها لا تستخدم TodoWrite أو Task أو أي أداة عدا browser_snapshot وbrowser_click، ولا تستخدم CSS selectors.
1. خذ browser_snapshot واحدة واستخرج ref للزر الذي اسمه «بدّل العنصر».
2. نفّذ الخطوات ${RUNS * 2} التالية كلها بالترتيب، ولا تتوقف قبل إكمالها:
${repetitions}
3. قبل الإنهاء تأكد أن المجموع browser_snapshot واحدة وbrowser_click عددها ${RUNS * 2} بالضبط، ثم اكتب «تم» فقط.`;
  }
  return `هذه مهمة قياس حتمية قصيرة. يمكنك استخدام ToolSearch مرة واحدة لتحميل الأداتين، وبعدها لا تستخدم TodoWrite أو Task أو أي أداة عدا browser_snapshot وbrowser_click، ولا تستخدم CSS selectors.
1. خذ browser_snapshot واحدة واستخرج ref للزر الذي اسمه «بدّل العنصر».
2. نفّذ الخطوات ${RUNS * 2} التالية كلها بالترتيب، ولا تتوقف قبل إكمالها:
${repetitions}
3. قبل الإنهاء تأكد أن المجموع browser_snapshot عددها ${RUNS * 2 + 1} وbrowser_click عددها ${RUNS * 2} بالضبط، ثم اكتب «تم» فقط.`;
}

async function runTurn(useDelta) {
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
        if (VERBOSE || call.is_error) call.result_preview = text.slice(0, 500);
        delete call.started_at;
        pending.delete(block.tool_use_id);
      }
    }
    if (event.type === 'result') {
      result = event;
      finish({ result: event });
    }
    if (event.type === 'proc_done' && !result) finish({ code: event.code });
  };

  handle = await agent.start({
    prompt: promptText(useDelta), images: [], sessionId: null,
    model: process.env.SATR_CLAUDE_MODEL || null,
    permissionMode: 'default', skills: [], effort: null, extraDirs: [],
    browserControl: true, trustedBrowserOrigins: [],
  }, process.cwd(), emit);

  const outcome = await completed;
  clearTimeout(timer);
  if (outcome.timeout && handle) await handle.stop().catch(() => {});
  return { calls, permissions, diagnostics, result, outcome };
}

function measurementReport(measurement, useDelta) {
  const snapshots = measurement.calls.filter((call) => bareTool(call.name) === 'browser_snapshot');
  const clicks = measurement.calls.filter((call) => bareTool(call.name) === 'browser_click');
  const bootstrapSearches = measurement.calls.filter((call) => bareTool(call.name) === 'ToolSearch');
  const unexpected = measurement.calls.filter((call) => !['browser_snapshot', 'browser_click', 'ToolSearch'].includes(bareTool(call.name)));
  const contract = {
    permissions: measurement.permissions.length,
    diagnostics: measurement.diagnostics.length,
    snapshots: snapshots.length,
    clicks: clicks.length,
    bootstrapSearches: bootstrapSearches.length,
    unexpected: unexpected.length,
    unexpectedNames: unexpected.map((call) => bareTool(call.name)),
    errors: measurement.calls.filter((call) => call.is_error).length,
    badRefs: clicks.filter((call) => !/^s[1-9][0-9]*:e[1-9][0-9]*$/.test(String(call.input && call.input.ref))).length,
    pending: measurement.calls.filter((call) => !Number.isFinite(call.result_bytes)).length,
    resultError: !!(measurement.result && measurement.result.is_error),
  };
  const expectedSnapshots = useDelta ? 1 : RUNS * 2 + 1;
  if (contract.permissions || contract.diagnostics || contract.snapshots !== expectedSnapshots
      || contract.clicks !== RUNS * 2 || contract.bootstrapSearches > 1 || contract.unexpected || contract.errors
      || contract.badRefs || contract.pending || contract.resultError || !measurement.result) {
    throw new Error('browser_loop_sdk_contract_failed ' + JSON.stringify({ mode: useDelta ? 'delta' : 'snapshot', contract }));
  }

  const result = measurement.result;
  return {
    engine: 'sdk', mode: useDelta ? 'delta' : 'snapshot', elements: ELEMENTS, runs: RUNS,
    contract, summary: summarize(measurement.calls),
    result: {
      subtype: result.subtype,
      duration_ms: result.duration_ms,
      duration_api_ms: result.duration_api_ms,
      num_turns: result.num_turns,
      total_cost_usd: result.total_cost_usd,
      usage: result.usage,
      modelUsage: result.modelUsage,
    },
  };
}

function compactRun(report, index) {
  const usage = report.result.usage || {};
  const snapshotBytes = report.summary.browser_snapshot ? report.summary.browser_snapshot.total_bytes : 0;
  const clickBytes = report.summary.browser_click ? report.summary.browser_click.total_bytes : 0;
  return {
    index, mode: report.mode, contract: report.contract,
    snapshot_bytes: snapshotBytes,
    click_bytes: clickBytes,
    browser_tool_bytes: snapshotBytes + clickBytes,
    duration_ms: report.result.duration_ms,
    duration_api_ms: report.result.duration_api_ms,
    num_turns: report.result.num_turns,
    total_cost_usd: report.result.total_cost_usd,
    usage: {
      input_tokens: Number(usage.input_tokens) || 0,
      cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0,
      cache_read_input_tokens: Number(usage.cache_read_input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
    },
  };
}

function aggregateRuns(runs, mode) {
  const selected = runs.filter((run) => run.mode === mode);
  const values = (key) => selected.map((run) => run[key]);
  const usageValues = (key) => selected.map((run) => run.usage[key]);
  return {
    count: selected.length,
    median_snapshots: median(selected.map((run) => run.contract.snapshots)),
    median_clicks: median(selected.map((run) => run.contract.clicks)),
    median_browser_tool_bytes: median(values('browser_tool_bytes')),
    median_duration_ms: median(values('duration_ms')),
    median_num_turns: median(values('num_turns')),
    median_total_cost_usd: median(values('total_cost_usd')),
    median_input_tokens: median(usageValues('input_tokens')),
    median_cache_creation_input_tokens: median(usageValues('cache_creation_input_tokens')),
    median_cache_read_input_tokens: median(usageValues('cache_read_input_tokens')),
    median_output_tokens: median(usageValues('output_tokens')),
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
  const claudeBin = agent.resolveClaudeBin(true);
  if (!claudeBin) throw new Error('claude_binary_missing');
  const fixture = await startServer();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    preview.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    const opened = preview.open(win, () => {}, fixture.url);
    if (!opened.ok) throw new Error('preview_open_failed');
    const ready = await preview.waitFor({ selector: '#target' }, 8000);
    if (!ready.ok || !ready.found) throw new Error('fixture_not_ready');

    if (PAIRS) {
      const sequence = [];
      for (let pair = 0; pair < PAIRS; pair++) sequence.push(...(pair % 2 === 0 ? [false, true] : [true, false]));
      const runs = [];
      for (let index = 0; index < sequence.length; index++) {
        const useDelta = sequence[index];
        if (index > 0) {
          await reloadFixture(fixture.url + '?paired=' + (index + 1));
        }
        const report = measurementReport(await runTurn(useDelta), useDelta);
        const compact = compactRun(report, index + 1);
        runs.push(compact);
        process.stdout.write('SATR_BROWSER_LOOP_SDK_RUN=' + JSON.stringify(compact) + '\n');
      }
      const paired = {
        engine: 'sdk', model: process.env.SATR_CLAUDE_MODEL || null,
        elements: ELEMENTS, runs_per_turn: RUNS, pairs: PAIRS,
        fixture_requests: fixture.requests(), order: runs.map((run) => run.mode), runs,
        aggregate: {
          snapshot: aggregateRuns(runs, 'snapshot'),
          delta: aggregateRuns(runs, 'delta'),
        },
      };
      process.stdout.write('SATR_BROWSER_LOOP_SDK_PAIRED=' + JSON.stringify(paired) + '\n');
    } else {
      const report = measurementReport(await runTurn(USE_DELTA), USE_DELTA);
      report.fixture_requests = fixture.requests();
      process.stdout.write('SATR_BROWSER_LOOP_SDK=' + JSON.stringify(report) + '\n');
    }
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
