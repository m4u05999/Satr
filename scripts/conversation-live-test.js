#!/usr/bin/env node
'use strict';

// سائق النافذة الأصلية عبر CDP؛ المحرك فقط محاكاة عند حدود بروتوكوله.
// التشغيل الطويل (launch) يمر حصرا بأداة run_in_background من سطر.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const core = require('./lib/live-test-run');
const { connectMain } = require('./lib/live-test-client');
const { command } = require('./live-test');
const repo = path.resolve(__dirname, '..');
const TIME_BUDGET_MS = 30 * 60 * 1000;
const STEP_TIMEOUT_MS = 12000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function ownedFile(run, name) {
  assert(/^[a-z0-9.-]+$/.test(name), 'اسم دليل غير صالح');
  const dir = path.join(run.paths.root, 'conversation');
  assert(!fs.lstatSync(dir).isSymbolicLink(), 'دليل التجربة رابط');
  return path.join(dir, name);
}
function json(file, value, exclusive = false) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
}
function prepare(run, rebuild = false) {
  const dir = path.join(run.paths.root, 'conversation');
  if (!rebuild) {
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'native'));
  fs.mkdirSync(path.join(run.paths.workspace, 'project-a'));
  fs.mkdirSync(path.join(run.paths.workspace, 'project-b'));
  const status = spawnSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  json(ownedFile(run, 'acceptance.json'), {
    time: new Date().toISOString(), mode: 'source', boundary: 'claude-stream-json-and-codex-app-server-fixture',
    timeoutMs: TIME_BUDGET_MS, maxAttemptsPerFailure: 2, paidModelCalls: 0,
    baseline: { head: head.stdout.trim(), dirty: status.stdout.trim() },
    criteria: [
      { id: 'engine-roundtrip', pass: 'تصل الحقائق القديمة والتصحيح والإلغاء إلى المحرك التالي عبر مدخلات البروتوكول وتبقى رسائلها في DOM.', fail: 'تفقد حقيقة أو يعود قيد ملغى أو تختفي الرسائل عند التبديل.' },
      { id: 'model-change', pass: 'نموذج آخر داخل المحرك يستأنف nativeId نفسه مع السياق.', fail: 'ينشأ nativeId جديد أو تسقط الحقيقة.' },
      { id: 'reload', pass: 'تعاد الرسائل من تخزين الإنتاج ويصل الدور التالي بسياقها.', fail: 'تختفي الرسائل أو يصل الدور التالي بلا السياق.' },
      { id: 'chat-project-isolation', pass: 'دردشتان ومشروعان لا يرثان حقائق بعضهما؛ تختار لوحة الجلسات الأولى وتستعيد تصحيحها.', fail: 'يتسرب قيد أو تستأنف دردشة أو مشروع غير المحدد.' },
      { id: 'no-tool-replay', pass: 'ملف الأثر يحتوي سطرا واحدا بعد كل التنقلات.', fail: 'يضاف أثر ثان بسبب تاريخ الأدوات.' },
      { id: 'restart', pass: 'بعد close/launch جديدين يستعيد الدور التالي سياق المحادثة الأخيرة.', fail: 'فقد التاريخ أو بدء محادثة فارغة.' },
    ],
    limitations: ['ليست تجربة حساب أو نموذج مدفوع ولا اختبار فهم لغوي.', 'ليست حزمة packaged.', 'لا تثبت اللقطة سلامة العربية في أسطح لم تقاس.', 'الكتابة للأداة تنفيذ محاكاة داخل المحرك؛ لا تثبت سياسة إذن أداة حقيقية.'],
  }, true);
  }
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  assert(fs.existsSync(compiler), 'csc_unavailable');
  const literal = value => '@"' + value.replace(/"/g, '""') + '"';
  for (const engine of ['sdk', 'codex']) {
    const source = [
      'using System; using System.Diagnostics; using System.Text; using System.Threading; using System.IO;',
      'public static class ConversationFixture {',
      'static string Q(string s) { var b = new StringBuilder("\\\""); int n = 0; foreach(char c in s) { if(c == \'\\\\\') { n++; continue; } if(c == \'"\') { b.Append(\'\\\\\', n * 2 + 1); b.Append(c); n = 0; continue; } b.Append(\'\\\\\', n); n = 0; b.Append(c); } b.Append(\'\\\\\', n * 2); b.Append(\'"\'); return b.ToString(); }',
      'static Thread Pump(Stream from, Stream to, bool close) { var t = new Thread(() => { try { var buffer = new byte[4096]; int count; while((count = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, count); to.Flush(); } } catch {} finally { if(close) try { to.Close(); } catch {} } }); t.IsBackground = true; t.Start(); return t; }',
      'public static int Main(string[] args) { var p = new ProcessStartInfo();',
      'p.FileName = ' + literal(process.execPath) + ';',
      'p.Arguments = Q(' + literal(path.join(repo, 'scripts', 'fixtures', 'conversation-engine-stub.js')) + ') + " " + Q("' + engine + '");',
      'foreach(string arg in args) p.Arguments += " " + Q(arg);',
      'p.UseShellExecute = false; p.CreateNoWindow = true; p.RedirectStandardInput = true; p.RedirectStandardOutput = true; p.RedirectStandardError = true; var child = Process.Start(p);',
      'Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true); var stdout = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false); var stderr = Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false); child.WaitForExit(); stdout.Join(); stderr.Join(); return child.ExitCode; } }',
    ].join('\n');
    const sourceFile = ownedFile(run, engine + '-wrapper.cs');
    fs.writeFileSync(sourceFile, source);
    const output = ownedFile(run, engine + '-fixture.exe');
    console.log('بناء محاكاة ' + engine + ' عبر csc.exe داخل جذر التجربة.');
    const built = spawnSync(compiler, ['/nologo', '/target:exe', '/out:' + output, sourceFile], { encoding: 'utf8', windowsHide: true });
    if (built.status !== 0) throw new Error('fixture_compile_failed: ' + built.stdout + built.stderr);
  }
  console.log(JSON.stringify({ ok: true, id: run.id, acceptance: ownedFile(run, 'acceptance.json'),
    launch: 'node scripts/conversation-live-test.js launch ' + run.id,
    drive: 'node scripts/conversation-live-test.js drive ' + run.id + ' fixed' }));
}
// تحفظ أدلة الإقلاع السابق قبل إعادة تشغيل التجربة.
function prepareRestart(run) {
  const completion = core.readEvidence(repo, run.id, 'completion.json');
  assert(completion.kind === 'shutdown' && completion.status === 'closed', 'previous_shutdown_not_closed');
  let alive = false;
  try { process.kill(completion.pid, 0); alive = true; }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('previous_pid_not_verified_dead'); }
  assert(!alive, 'previous_pid_still_alive');
  const lock = path.join(run.paths.root, 'launch.lock');
  const stat = fs.lstatSync(lock);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'unsafe_launch_lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), String(completion.pid), 'launch_lock_pid_mismatch');
  const names = fs.readdirSync(run.paths.evidence).filter(name => name === 'completion.json' || /^(launch|scenario|recording)-[0-9]{4}\.json$/.test(name));
  assert(names.includes('completion.json') && names.some(name => /^launch-/.test(name)), 'launch_evidence_missing');
  const files = names.map(name => {
    core.readEvidence(repo, run.id, name);
    return { source: path.join(run.paths.evidence, name), name };
  });
  files.push({ source: lock, name: 'launch.lock' });
  const records = files.map(item => ({ ...item, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(item.source)).digest('hex') }));
  let archive;
  for(let index = 1; index < 1000; index++) {
    archive = path.join(run.paths.root, 'conversation', 'launch-archive-' + String(index).padStart(3, '0'));
    try { fs.mkdirSync(archive); break; }
    catch(error) { if(error.code !== 'EEXIST' || index === 999) throw error; }
  }
  const root = path.resolve(run.paths.root);
  for(const item of records) {
    const target = path.join(archive, item.name);
    for(const value of [item.source, target]) {
      const relative = path.relative(root, path.resolve(value));
      assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'restart_archive_escape');
    }
  }
  json(path.join(archive, 'archive-manifest.json'), { status: 'prepared', pid: completion.pid, time: new Date().toISOString(), files: records }, true);
  for(const item of records) fs.renameSync(item.source, path.join(archive, item.name));
  json(path.join(archive, 'archive-manifest.json'), { status: 'archived', pid: completion.pid, time: new Date().toISOString(), files: records });
  console.log(JSON.stringify({ ok: true, id: run.id, previousPid: completion.pid, archive, files: records.map(item => item.name), readyForLaunch: true }));
}

function launch(run) {
  for (const engine of ['sdk', 'codex']) assert(fs.existsSync(ownedFile(run, engine + '-fixture.exe')), 'fixture_missing');
  const env = { ...process.env, CLAUDE_BIN: ownedFile(run, 'sdk-fixture.exe'), CODEX_BIN: ownedFile(run, 'codex-fixture.exe') };
  // غلاف الاختبار القائم ينقّي البيئة ثم يحمل main.js الإنتاجي دون أي رقعة.
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'live-test.js'), 'launch', run.id, '--debug'],
    { cwd: repo, env, stdio: 'inherit', shell: false, windowsHide: true });
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
}
function boundary(run) {
  try { return fs.readFileSync(ownedFile(run, 'boundary.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function drive(run, phase) {
  assert(['baseline', 'fixed', 'continue', 'continue-reload', 'continue-session', 'restart'].includes(phase), 'bad_phase');
  const attemptsFile = ownedFile(run, 'attempts.json');
  let attempts = {};
  try { attempts = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')); } catch {}
  const previous = fs.readdirSync(path.dirname(attemptsFile)).filter(name => /^(baseline|fixed|continue|continue-reload|continue-session|restart)-[0-9]+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(ownedFile(run, name), 'utf8'))).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const lastError = previous.at(-1)?.error;
  assert(!lastError || previous.filter(report => report.error === lastError).length < 2, 'same_failure_attempt_limit');
  attempts.startedAt = attempts.startedAt || previous[0]?.startedAt || new Date().toISOString();
  assert(Date.now() - Date.parse(attempts.startedAt) < TIME_BUDGET_MS, 'time_budget_exceeded');
  attempts[phase] = (attempts[phase] || 0) + 1;
  json(attemptsFile, attempts);
  const reportFile = ownedFile(run, phase + '-' + attempts[phase] + '.json');
  const report = { phase, attempt: attempts[phase], startedAt: new Date().toISOString(), status: 'running', checks: [], boundary: ownedFile(run, 'boundary.jsonl') };
  const started = Date.parse(attempts.startedAt);
  let client = await connectMain(repo, run.id);
  const checkpoint = () => {
    assert(Date.now() - started < TIME_BUDGET_MS, 'time_budget_exceeded');
    json(reportFile, report);
  };
  async function dom() {
    return client.evaluate('(() => ({engine:document.getElementById("engine")?.value, model:document.getElementById("model")?.value, cwd:document.getElementById("cwd")?.value, session:document.getElementById("sessionInfo")?.textContent, busy:document.getElementById("send")?.classList.contains("stop"), chat:document.querySelector("satr-chat")?.innerText || "", gate:!document.querySelector("satr-gate")?.hidden}))()');
  }
  async function waitFor(fn, name, timeout = STEP_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { checkpoint(); const value = await fn(); if (value) return value; await sleep(100); }
    throw new Error('timeout_' + name);
  }
  async function select(id, value) {
    await client.evaluate('(() => {const e=document.getElementById(' + JSON.stringify(id) + '); if(!e) throw Error("missing"); if(e.tagName==="SELECT" && ![...e.options].some(o=>o.value===' + JSON.stringify(value) + ')) throw Error("option"); e.value=' + JSON.stringify(value) + '; e.dispatchEvent(new Event("change",{bubbles:true})); return true;})()');
    await sleep(300);
  }
  async function click(id) {
    await client.evaluate('(() => { const e=document.getElementById(' + JSON.stringify(id) + '); if(!e || e.disabled) throw Error("unavailable"); e.click(); return true; })()');
    await sleep(200);
  }
  async function turn(operation, text, expected, absent = []) {
    await waitFor(() => client.evaluate('document.querySelector("satr-gate")?.hidden === true'), operation + '_gate');
    const before = boundary(run).filter(value => value.kind === 'turn').length;
    const prompt = text + ' [[LIVE:' + operation + ']]';
    const beforeDom = await dom();
    assert.equal(beforeDom.busy, false, 'previous_turn_busy');
    await client.evaluate('(() => {const e=document.getElementById("input"); e.value=' + JSON.stringify(prompt) + '; e.dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("send").click(); return true;})()');
    let actual;
    try {
      actual = await waitFor(() => {
        const turns = boundary(run).filter(value => value.kind === 'turn');
        return turns.length > before ? turns[turns.length - 1] : null;
      }, operation + '_boundary');
      await waitFor(async () => {
        const state = await dom();
        return !state.busy && state.chat.includes(actual.answer) && state;
      }, operation + '_ui');
      const state = await dom();
      report.checks.push({ operation, engine: actual.engine, nativeId: actual.nativeId, model: actual.model,
        facts: actual.facts, expected, absent, dom: state, status: 'observed' });
      checkpoint();
      assert.equal(actual.operation, operation, 'wrong_current_turn');
      assert.equal(actual.engine, beforeDom.engine, 'wrong_engine');
      for (const [key, value] of Object.entries(expected)) assert.equal(actual.facts[key], value, operation + ': missing_or_stale_' + key);
      for (const key of absent) assert.equal(actual.facts[key], undefined, operation + ': leaked_' + key);
      report.checks[report.checks.length - 1].status = 'passed';
      checkpoint();
      console.log('CONVERSATION_LIVE PASS ' + operation);
      return actual;
    } catch (error) { report.lastDom = await dom().catch(() => null); throw error; }
  }
  async function resumeFirst() {
    await click('sessionsToggle');
    await waitFor(() => client.evaluate('(() => { const root=document.querySelector("satr-sessions-panel")?.shadowRoot; return !!root && [...root.querySelectorAll(".sess .t")].some(e=>e.textContent.includes("اختبار الاستمرارية الأول")); })()'), 'session_list');
    // النقر على صف الإنتاج نفسه، لا استدعاء session-resume أو IPC يدويا.
    await client.evaluate('(() => {const root=document.querySelector("satr-sessions-panel").shadowRoot; const rows=[...root.querySelectorAll(".sess")]; const row=rows.find(e=>e.querySelector(".t")?.textContent.includes("اختبار الاستمرارية الأول")&&!e.querySelector(".m")?.textContent.startsWith("Codex")); if(!row) throw Error("first_session_missing"); row.click(); return true;})()');
    await waitFor(async () => (await dom()).chat.includes('اختبار الاستمرارية الأول'), 'session_resume');
  }
  async function screenshot(name) {
    try {
      const status = await command(run, 'status');
      const catalog = await (await fetch('http://127.0.0.1:' + status.debugPort + '/json/list')).json();
      const targets = catalog.filter(item => item.type === 'page' && item.url === status.mainUrl);
      assert.equal(targets.length, 1);
      const url = new URL(targets[0].webSocketDebuggerUrl);
      assert(['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port) === status.debugPort);
      const socket = new WebSocket(url.href);
      const capture = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('screenshot_timeout')); }, 5000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: false, captureBeyondViewport: false } })));
        socket.addEventListener('message', event => {
          const message = JSON.parse(event.data); if(message.id !== 1) return;
          clearTimeout(timer); socket.close();
          if(message.result?.data) resolve(message.result.data); else reject(new Error('screenshot_failed'));
        });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('screenshot_failed')); });
      });
      const file = ownedFile(run, name + '-' + attempts[phase] + '.png'); fs.writeFileSync(file, Buffer.from(capture, 'base64'));
      report.screenshots = [...(report.screenshots || []), file];
    } catch (error) { report.screenshotError = error.message; }
  }
  try {
    await waitFor(() => client.evaluate('Boolean(document.querySelector("satr-composer") && document.getElementById("engine")?.options.length > 2)'), 'composer');
    await waitFor(() => client.evaluate('document.querySelector("satr-gate")?.hidden === true'), 'gate_ready');
    if (phase === 'restart') {
      await waitFor(async () => (await dom()).chat.includes('اختبار الاستمرارية الأول'), 'restored_history');
      await turn('restart', 'راجع الحالة المحفوظة دون تغييرها.', { project: 'alpha', color: 'green', blocked: 'none' });
    } else {
      if (!phase.startsWith('continue')) {
      await select('cwd', path.join(run.paths.workspace, 'project-a'));
      await click('newSession');
      await select('engine', 'sdk');
      await turn('tool', 'اختبار الاستمرارية الأول. احفظ القيد القديم وأنشئ الأثر مرة واحدة. [[FACT:project=alpha]] [[FACT:color=blue]] [[FACT:blocked=travel]]', { project: 'alpha', color: 'blue', blocked: 'travel' });
      for (let n = 0; n < 24; n++) await turn('filler-' + n, 'ملاحظة مستقلة رقم ' + n + '؛ أبق القيود السابقة كما هي.', { project: 'alpha', color: 'blue', blocked: 'travel' });
      } else {
        const before = JSON.parse(fs.readFileSync(ownedFile(run, 'fixed-2.json'), 'utf8'));
        assert(before.checks.length === 25 && before.checks.every(check => check.status === 'passed') && before.checks.at(-1).operation === 'filler-23', 'continuation_baseline_incomplete');
        report.continuedFrom = ownedFile(run, 'fixed-2.json');
        const current = await dom();
        assert.equal(current.cwd.toLowerCase(), path.join(run.paths.workspace, 'project-a').toLowerCase(), 'continuation_project_mismatch');
        assert.equal(current.busy, false, 'continuation_previous_run_busy');
        assert.equal(fs.readFileSync(path.join(run.paths.workspace, 'project-a', 'conversation-effect.txt'), 'utf8'), 'one\n', 'continuation_effect_mismatch');
      }
      if (!['continue-reload', 'continue-session'].includes(phase)) {
      await select('engine', 'codex');
      assert((await dom()).chat.includes('اختبار الاستمرارية الأول'), 'engine_switch_cleared_dom');
      await turn('to-codex', 'اذكر الحالة القديمة كما وصلت إليك.', { project: 'alpha', color: 'blue', blocked: 'travel' });
      await turn('correct', 'تصحيح اللون وإلغاء منع السفر: [[FACT:color=green]] [[FACT:blocked=none]]', { project: 'alpha', color: 'green', blocked: 'none' });
      await select('engine', 'sdk');
      const returned = await turn('back-sdk', 'ما آخر تصحيح وما القيد الملغى؟', { project: 'alpha', color: 'green', blocked: 'none' });
      const models = await client.evaluate('[...document.getElementById("model").options].map(o=>o.value)');
      const currentModel = (await dom()).model;
      const nextModel = models.find(model => model && model !== currentModel);
      assert(nextModel, 'alternative_model_missing');
      await select('model', nextModel);
      const changed = await turn('model-change', 'راجع الحالة دون تعديلها.', { project: 'alpha', color: 'green', blocked: 'none' });
      assert.equal(changed.nativeId, returned.nativeId, 'model_change_reset_native_session');
      await screenshot('before-reload');
      await client.evaluate('setTimeout(()=>location.reload(),0); true');
      await sleep(600);
      client.close(); client = await connectMain(repo, run.id);
      await waitFor(async () => (await dom()).chat.includes('اختبار الاستمرارية الأول'), 'reload_history');
      } else {
        const priorReload = JSON.parse(fs.readFileSync(ownedFile(run, 'continue-1.json'), 'utf8'));
        assert(priorReload.error === 'timeout_reload_boundary' && priorReload.checks.length === 4 && priorReload.checks.every(check => check.status === 'passed'), 'reload_continuation_unverified');
        report.continuedFrom = ownedFile(run, 'continue-1.json');
      }
      if (phase !== 'continue-session') {
      await turn('reload', 'تحقق من الحالة بعد إعادة التحميل.', { project: 'alpha', color: 'green', blocked: 'none' });
      await click('newSession');
      await select('engine', 'sdk');
      await turn('second-chat', 'اختبار الاستمرارية الثاني. [[FACT:conversation=beta]]', { conversation: 'beta' }, ['project', 'color', 'blocked']);
      await select('engine', 'codex');
      await turn('second-chat-switch', 'راجع هذه المحادثة وحدها.', { conversation: 'beta' }, ['project', 'color', 'blocked']);
      await select('cwd', path.join(run.paths.workspace, 'project-b'));
      await turn('second-project', 'اختبار المشروع الثاني. [[FACT:project=gamma]]', { project: 'gamma' }, ['conversation', 'color', 'blocked']);
      await resumeFirst();
      } else {
        const priorSession = JSON.parse(fs.readFileSync(ownedFile(run, 'continue-reload-1.json'), 'utf8'));
        assert(priorSession.error === 'timeout_resume-first_boundary' && priorSession.checks.length === 4 && priorSession.checks.every(check => check.status === 'passed'), 'session_continuation_unverified');
        report.continuedFrom = ownedFile(run, 'continue-reload-1.json');
      }
      await turn('resume-first', 'استأنف المحادثة الأولى بأحدث تصحيحها.', { project: 'alpha', color: 'green', blocked: 'none' }, ['conversation']);
      const oldCodex = boundary(run).find(value => value.kind === 'turn' && value.operation === 'correct').nativeId;
      json(ownedFile(run, 'codex-fail-resume-once.json'), { pending: true, nativeId: oldCodex });
      await select('engine', 'codex');
      const restarted = await turn('failed-resume', 'راجع السجل بعد تعذر استئناف جلسة المحرك.', { project: 'alpha', color: 'green', blocked: 'none' }, ['conversation']);
      assert.notEqual(restarted.nativeId, oldCodex, 'failed_resume_did_not_restart');
      assert(boundary(run).some(value => value.kind === 'resume-refused' && value.nativeId === oldCodex), 'resume_failure_not_observed');
      report.checks.push({ operation: 'failed-native-resume-full-context', status: 'passed', oldNativeId: oldCodex, newNativeId: restarted.nativeId });
      assert.equal(fs.readFileSync(path.join(run.paths.workspace, 'project-a', 'conversation-effect.txt'), 'utf8'), 'one\n', 'tool_effect_replayed');
      report.checks.push({ operation: 'no-tool-replay', status: 'passed', effects: 1 });
      report.restartPending = true;
    }
    await screenshot(phase + '-end');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    report.lastDom = await dom().catch(() => null);
    await screenshot(phase + '-failed');
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    json(reportFile, report);
    client.close();
    console.log('CONVERSATION_LIVE_REPORT ' + reportFile);
  }
}
async function main() {
  const [action, id, phase] = process.argv.slice(2);
  const run = core.loadRun(repo, id);
  if (action === 'prepare') return prepare(run);
  if (action === 'rebuild') return prepare(run, true);
  if (action === 'restart-prepare') return prepareRestart(run);
  if (action === 'launch') return launch(run);
  if (action === 'drive') return drive(run, phase || 'fixed');
  throw new Error('usage_prepare_launch_drive');
}
if (require.main === module) main().catch(error => { console.error('CONVERSATION_LIVE ' + error.message); process.exitCode = 1; });
module.exports = { boundary };
