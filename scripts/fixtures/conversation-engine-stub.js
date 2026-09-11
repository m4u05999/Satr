'use strict';

// محاكاة بروتوكول محلية: تثبت وصول التاريخ إلى حدود المحرك، ولا تختبر فهم نموذج حقيقي.
// لا تقرأ أسرارا ولا شبكة؛ تقبل حصرا منزلا يملكه مشغل التجربة الحية.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const core = require('../lib/live-test-run');
const repo = path.resolve(__dirname, '../..');
const engine = process.argv[2];
if (!['sdk', 'codex'].includes(engine)) throw new Error('bad_fixture_engine');
const home = path.resolve(require('os').homedir());
const run = core.loadRun(repo, path.basename(path.dirname(home)));
if (home !== run.paths.home || process.env.CLAUDE_CONFIG_DIR !== path.join(home, '.claude')
    || process.env.CODEX_HOME !== path.join(home, '.codex')) throw new Error('fixture_home_not_isolated');
const owned = path.join(run.paths.root, 'conversation');
const stateDir = path.join(owned, 'native');
const args = process.argv.slice(3);
const uuid = () => crypto.randomUUID();
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
function log(value) {
  fs.appendFileSync(path.join(owned, 'boundary.jsonl'), JSON.stringify({
    at: new Date().toISOString(), pid: process.pid, engine, ...value,
  }) + '\n');
}
function arg(name) {
  const inline = args.find(value => value.startsWith(name + '='));
  return inline ? inline.slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : '';
}
if (args.includes('--version')) { console.log(engine === 'sdk' ? '2.1.261 (Claude Code fixture)' : 'codex-cli 0.153.4'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  write({ loggedIn: true, authMethod: 'claude.ai', email: 'fixture@example.invalid', subscriptionType: 'fixture' }); process.exit(0);
}
const models = engine === 'sdk'
  ? [{ value: 'claude-sonnet-4-6', displayName: 'Claude fixture A', description: 'محاكاة محلية' }, { value: 'claude-opus-4-6', displayName: 'Claude fixture B', description: 'محاكاة محلية' }]
  : [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'Codex fixture A', supportedReasoningEfforts: [] }, { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'Codex fixture B', supportedReasoningEfforts: [] }];
let nativeId = '', session = null, developerText = '', currentTurn = '';
function fileFor(sid) {
  if (!/^[a-f0-9-]{36}$/.test(sid)) throw new Error('bad_native_id');
  return path.join(stateDir, engine + '-' + sid + '.json');
}
function open(sid, cwd) {
  const relative = path.relative(run.paths.workspace, path.resolve(cwd));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('workspace_escape');
  nativeId = sid || uuid();
  if (sid) {
    session = JSON.parse(fs.readFileSync(fileFor(sid), 'utf8'));
    if ((process.platform === 'win32' ? session.cwd.toLowerCase() !== cwd.toLowerCase() : session.cwd !== cwd)) throw new Error('native_workspace_mismatch');
  } else session = { id: nativeId, cwd, engine, messages: [], createdAt: Date.now() };
  return nativeId;
}
function save() { fs.writeFileSync(fileFor(nativeId), JSON.stringify(session)); }
function persistMessages(prompt, answer) {
  session.messages.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer });
  save();
  if (engine === 'sdk') {
    const project = session.cwd.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(home, '.claude', 'projects', project);
    fs.mkdirSync(dir, { recursive: true });
    const entries = [
      { type: 'user', uuid: uuid(), sessionId: nativeId, cwd: session.cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } },
      { type: 'assistant', uuid: uuid(), sessionId: nativeId, cwd: session.cwd, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: answer }] } },
    ];
    fs.appendFileSync(path.join(dir, nativeId + '.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }
}
function answerFor(prompt, model) {
  const inherited = session.messages.map(message => message.text).join('\n');
  const all = inherited + '\n' + developerText + '\n' + prompt;
  const facts = {};
  for (const match of all.matchAll(/\[\[FACT:([a-z]+)=([A-Za-z0-9_-]+)\]\]/g)) facts[match[1]] = match[2];
  const operations = [...prompt.matchAll(/\[\[LIVE:([a-z0-9-]+)\]\]/g)];
  const operation = operations.length ? operations[operations.length - 1][1] : 'probe';
  // الأثر يخص طلب الدور الحالي فقط، ولا يعاد من السجل المرفق كسياق.
  if (operation === 'tool') {
    fs.appendFileSync(path.join(session.cwd, 'conversation-effect.txt'), 'one\n');
    log({ kind: 'effect', operation, nativeId, cwd: session.cwd });
  }
  const text = 'محاكاة بروتوكول محلية؛ العملية ' + operation + '؛ الحالة ' + JSON.stringify(facts) + '؛ لا يمثل هذا فهم نموذج حقيقي.';
  log({ kind: 'turn', operation, nativeId, model: model || '', cwd: session.cwd,
    prompt, developerText, inheritedMessages: session.messages.length, facts, answer: text });
  persistMessages(prompt, text);
  return { text, operation };
}
function sdkMessage(msg) {
  if (msg.type === 'control_request') {
    const request = msg.request || {};
    if (request.subtype === 'initialize') developerText = [request.systemPrompt, request.appendSystemPrompt].flat().filter(Boolean).join('\n');
    write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id,
      response: { commands: [], agents: [], models, account: { email: 'fixture@example.invalid' } } } });
    return;
  }
  if (msg.type !== 'user') return;
  if (!session) {
    const sid = arg('--resume');
    open(sid, process.cwd());
    log({ kind: 'session', nativeId, resumed: !!sid, cwd: process.cwd() });
  }
  const content = msg.message && msg.message.content;
  const prompt = typeof content === 'string' ? content : (content || []).filter(value => value.type === 'text').map(value => value.text).join('\n');
  const model = arg('--model');
  const result = answerFor(prompt, model);
  write({ type: 'system', subtype: 'init', session_id: nativeId, cwd: process.cwd(), tools: [], model: model || 'fixture', mcp_servers: [] });
  if (result.operation === 'tool') {
    const toolId = 'fixture_' + uuid();
    write({ type: 'assistant', session_id: nativeId, uuid: uuid(), parent_tool_use_id: null,
      message: { id: uuid(), role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Write', input: { file_path: path.join(session.cwd, 'conversation-effect.txt'), content: 'one\n' } }], model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 } } });
    write({ type: 'user', session_id: nativeId, uuid: uuid(), parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'fixture_effect_written' }] } });
  }
  write({ type: 'assistant', session_id: nativeId, uuid: uuid(), parent_tool_use_id: null,
    message: { id: uuid(), role: 'assistant', content: [{ type: 'text', text: result.text }], model: model || 'fixture', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } });
  write({ type: 'result', subtype: 'success', is_error: false, session_id: nativeId, uuid: uuid(), result: result.text,
    duration_ms: 1, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] });
  setTimeout(() => process.exit(0), 100);
}
function codexMessage(msg) {
  const params = msg.params || {};
  const reply = result => { if (msg.id != null) write({ id: msg.id, result }); };
  const notify = (method, extra) => write({ method, params: { threadId: nativeId, turnId: currentTurn, ...extra } });
  if (msg.method === 'initialize') return reply({ userAgent: 'satr-conversation-fixture' });
  if (msg.method === 'account/read') return reply({ account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'fixture' }, requiresOpenaiAuth: false });
  if (msg.method === 'model/list') return reply({ data: models, nextCursor: null });
  if (msg.method === 'account/rateLimits/read') return reply({ rateLimits: {} });
  if (msg.method === 'thread/list') {
    const data = fs.readdirSync(stateDir).filter(name => name.startsWith('codex-')).map(name => JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')))
      .filter(value => value.messages.length).map(value => ({ id: value.id, cwd: value.cwd, preview: value.messages[0].text.slice(0, 90), createdAt: Math.floor(value.createdAt / 1000), updatedAt: Math.floor(value.createdAt / 1000), source: 'appServer' }));
    return reply({ data, nextCursor: null });
  }
  if (msg.method === 'thread/read') {
    const value = JSON.parse(fs.readFileSync(fileFor(params.threadId), 'utf8'));
    return reply({ thread: { ...value, turns: [{ id: uuid(), status: 'completed', items: value.messages.map(m => m.role === 'user'
      ? { type: 'userMessage', id: uuid(), content: [{ type: 'text', text: m.text }] }
      : { type: 'agentMessage', id: uuid(), text: m.text }) }] } });
  }
  if (msg.method === 'thread/resume') {
    const failureFile = path.join(owned, 'codex-fail-resume-once.json');
    if (fs.existsSync(failureFile)) {
      const failure = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
      if (failure.pending === true && failure.nativeId === params.threadId) {
        fs.writeFileSync(failureFile, JSON.stringify({ ...failure, pending: false }));
        log({ kind: 'resume-refused', nativeId: params.threadId });
        write({ id: msg.id, error: { code: -32001, message: 'fixture_native_session_missing' } });
        return;
      }
    }
  }
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    open(msg.method === 'thread/resume' ? params.threadId : '', params.cwd || process.cwd());
    developerText = params.developerInstructions || '';
    save(); log({ kind: 'session', nativeId, resumed: msg.method === 'thread/resume', cwd: session.cwd });
    return reply({ thread: { id: nativeId } });
  }
  if (msg.method === 'turn/start') {
    currentTurn = uuid();
    const prompt = (params.input || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    const result = answerFor(prompt, params.model);
    reply({ turn: { id: currentTurn } });
    setTimeout(() => {
      notify('turn/started', { turn: { id: currentTurn, status: 'inProgress' } });
      notify('item/started', { item: { type: 'agentMessage', id: 'answer_' + currentTurn, text: '', phase: 'final_answer' } });
      notify('item/agentMessage/delta', { itemId: 'answer_' + currentTurn, delta: result.text });
      notify('item/completed', { item: { type: 'agentMessage', id: 'answer_' + currentTurn, text: result.text, phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: currentTurn, status: 'completed' } });
    }, 20);
    return;
  }
  if (msg.method === 'turn/interrupt') return reply({});
  if (msg.id != null) write({ id: msg.id, error: { code: -32601, message: 'fixture_method_not_implemented' } });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  try { const msg = JSON.parse(line); if (engine === 'sdk') sdkMessage(msg); else codexMessage(msg); }
  catch (error) { console.error('CONVERSATION_FIXTURE ' + String(error.code || error.message).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)); process.exitCode = 1; lines.close(); }
});
lines.once('close', () => setTimeout(() => process.exit(process.exitCode || 0), 50));
setTimeout(() => process.exit(0), 45000).unref();
