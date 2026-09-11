#!/usr/bin/env node
'use strict';

// OBS-147: العقود الإنتاجية نفسها، مع app-server محلي وACP محقون بلا حسابات أو شبكة.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const kimi = require('../electron/kimi');

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check, timeout = 4000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error('engine-stop-done: timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function watch(handle) {
  assert.ok(handle.done && typeof handle.done.then === 'function', 'run.done is required');
  const observed = { state: 'pending' };
  handle.done.then(() => { observed.state = 'resolved'; }, () => { observed.state = 'rejected'; });
  return observed;
}
async function finish(handle) {
  let timer;
  try {
    await Promise.race([handle.done,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('done timeout')), 4000); })]);
  } finally { clearTimeout(timer); }
}

function codexFixture() {
  return [
    "'use strict';",
    "const fs = require('fs'); const readline = require('readline');",
    "const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');",
    "const reply = (id, result) => send({jsonrpc:'2.0',id,result});",
    "fs.writeFileSync('process-id', String(process.pid));",
    "const alive = setInterval(() => {}, 1000);",
    "const input = readline.createInterface({input:process.stdin});",
    "input.on('line', (line) => { const m=JSON.parse(line);",
    "if(m.method==='initialize') reply(m.id, {});",
    "else if(m.method==='thread/start') reply(m.id, {thread:{id:'test-thread'}});",
    "else if(m.method==='turn/start') {reply(m.id,{turn:{id:'test-turn',status:'inProgress'}});fs.writeFileSync('ready','1');}",
    "else if(m.method==='turn/interrupt') reply(m.id, {});",
    "});",
    "input.on('close', () => setTimeout(() => { clearInterval(alive); process.exit(0); }, 220));",
  ].join('\n');
}

async function testCodex(root) {
  const project = path.join(root, 'codex');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'app-server'), codexFixture());
  const priorBin = process.env.CODEX_BIN;
  let handle;
  try {
    process.env.CODEX_BIN = process.execPath;
    const codex = require('../electron/codex');
    codex.resolveCodexBin(true);
    const events = [];
    handle = await codex.start({ prompt: 'اختبار الإيقاف', images: [], model: 'gpt-5.6-sol',
      permissionMode: 'default', browserControl: false }, project, (event) => events.push(event));
    const observed = watch(handle);
    await waitFor(() => fs.existsSync(path.join(project, 'ready')));
    assert.equal(observed.state, 'pending');
    await handle.stop();
    await flush();
    assert.ok(events.some((event) => event.type === 'proc_done'));
    assert.equal(observed.state, 'pending', 'Codex done resolved before process exit');
    await finish(handle);
    assert.equal(observed.state, 'resolved');
    const pid = Number(fs.readFileSync(path.join(project, 'process-id'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), 'Codex process is still alive after done');
    console.log('engine-stop-done: ok codex-exit');
  } finally {
    if (handle) { await handle.stop(); await finish(handle).catch(() => {}); }
    // التنظيف مستقل عن done كي لا يخفي حارساً عضّ في وعد إكمال مبكر.
    const pidFile = path.join(project, 'process-id');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    }
    if (priorBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = priorBin;
    require('../electron/codex').resolveCodexBin(true);
  }
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 7654321;
    this.killed = false;
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.write = (line) => { this.onMessage(JSON.parse(String(line))); return true; };
    this.stdin.end = () => { this.ended = true; };
  }
  send(message) { setImmediate(() => this.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'))); }
  kill() { this.killed = true; }
  exit() { this.exitCode = 0; this.emit('exit', 0); }
}

async function testKimi(root, mode) {
  const project = path.join(root, 'kimi-' + mode);
  fs.mkdirSync(project);
  const proc = new FakeProcess();
  const events = [];
  let promptId;
  let releaseHost;
  const hostDone = new Promise((resolve) => { releaseHost = resolve; });
  let hostStopping = false;
  proc.onMessage = (message) => {
    const reply = (result) => proc.send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') reply({ protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } } });
    else if (message.method === 'session/new') reply({ sessionId: 'done_session' });
    else if (message.method === 'session/prompt') promptId = message.id;
    else if (message.method === 'session/cancel' && mode === 'ack') {
      proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    }
  };
  const engine = kimi.create({ spawn: () => proc, resolveKimiBin: () => process.execPath,
    startMcp: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'fixture',
      stop: () => { hostStopping = true; return hostDone; } }) });
  let handle;
  try {
    handle = await engine.start({ prompt: 'اختبار الإيقاف', permissionMode: 'default',
      browserControl: mode === 'destroy' ? true : false, keepAlive: mode !== 'destroy' && mode !== 'destroy-exit' },
    project, (event) => events.push(event));
    const observed = watch(handle);
    await waitFor(() => promptId);
    if (mode === 'natural') {
      proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      await finish(handle);
      assert.equal(proc.killed, false, 'Kimi natural completion killed keepalive');
      assert.equal(engine.keepalive.list().length, 1);
    } else if (mode === 'ack') {
      await handle.stop();
      await finish(handle);
      assert.equal(proc.killed, false, 'Kimi confirmed cancel killed keepalive');
      assert.equal(engine.keepalive.list().length, 1);
    } else if (mode === 'timeout') {
      await handle.stop();
      await flush();
      assert.ok(events.some((event) => event.type === 'proc_done'));
      assert.equal(observed.state, 'pending', 'Kimi done resolved on cancel timeout');
      proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
      await finish(handle);
    } else if (mode === 'destroy') {
      const stopping = handle.stop();
      await waitFor(() => hostStopping);
      proc.exit();
      await flush();
      assert.equal(observed.state, 'pending', 'Kimi done resolved before MCP cleanup');
      releaseHost();
      await stopping;
      await finish(handle);
    } else if (mode === 'destroy-exit') {
      const stopping = handle.stop();
      await waitFor(() => proc.ended);
      await flush();
      assert.equal(observed.state, 'pending', 'Kimi done resolved before process exit');
      proc.exit();
      await stopping;
      await finish(handle);
    } else if (mode === 'exit') {
      proc.exit();
      await finish(handle);
    }
    assert.equal(observed.state, 'resolved');
    assert.equal(proc.listenerCount('exit') <= 1, true, 'Kimi turn exit listener leaked');
    console.log('engine-stop-done: ok kimi-' + mode);
  } finally {
    releaseHost();
    proc.exit();
    await engine.keepalive.killAll();
    if (handle) await finish(handle).catch(() => {});
  }
}

async function testEngineStopDone() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-engine-stop-done-'));
  try {
    await testCodex(root);
    for (const mode of ['natural', 'ack', 'timeout', 'destroy', 'destroy-exit', 'exit']) await testKimi(root, mode);
    console.log('engine-stop-done: 7/7');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
module.exports = { testEngineStopDone };
if (require.main === module) {
  testEngineStopDone().catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
