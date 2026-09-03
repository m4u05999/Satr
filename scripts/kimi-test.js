'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const kimi = require('../electron/kimi');
const sessionmeta = require('../electron/sessionmeta');
const skillCatalog = require('../electron/skills');

const root = path.resolve(__dirname, '..');

function waitFor(predicate, timeout) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > (timeout || 2000)) { reject(new Error('timeout')); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

// stdin مبنيّ على EventEmitter لا كائناً عارياً (OBS-052): أنبوب العملية الحقيقي يبثّ
// أخطاءه حدثاً، و«الحدث بلا مستمع» هو بعينه العطل الذي نحرسه — فلو بقي الكائن عارياً
// لكان الحارس يختبر خيالاً لا الآلية. `emit('error')` على EventEmitter بلا مستمع يرمي
// كما تفعل الـstreams تماماً.
class FakeStdin extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.ended = false;
  }
  write(line) { this.onWrite(line); return true; }
  end() { this.ended = true; }
}

class FakeProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.lines = [];
    this.stdin = new FakeStdin((line) => {
      const message = JSON.parse(String(line).trim());
      this.lines.push(message);
      handler(message, this);
    });
  }

  send(message) {
    setTimeout(() => this.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n')), 0);
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    setTimeout(() => this.emit('exit', 0), 0);
  }
}

function initializeResult(extra) {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true },
      sessionCapabilities: { resume: {}, list: {} },
      ...(extra || {}),
    },
    authMethods: [{ id: 'login', name: 'Kimi Code' }],
  };
}

async function testNativeTurnAndPermission() {
  const events = [];
  let processRef;
  let promptId;
  let permissionReply;
  let mcpOptions;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    startMcp: async (options) => {
      mcpOptions = options;
      return { url: 'http://127.0.0.1:49152/mcp', token: 'test-token', stop: async () => {} };
    },
    spawn: () => {
      processRef = new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') {
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_session_1' } });
        } else if (message.method === 'session/prompt') {
          promptId = message.id;
          const textBlock = message.params.prompt.find((item) => item.type === 'text');
          assert.strictEqual(textBlock.text, 'عدّل الملف');
          assert.ok(message.params.prompt.some((item) => item.type === 'resource'
            && item.resource && item.resource.uri === 'satr://environment'));
          proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_session_1', update: {
              sessionUpdate: 'tool_call', toolCallId: 'call_edit_1', title: 'Edit', kind: 'edit',
              status: 'pending', rawInput: {
                path: 'sample.js', api_key: 'must-not-leak', nested: { authorization: 'must-not-leak-either' },
              },
            },
          } });
          proc.send({ jsonrpc: '2.0', id: 700, method: 'session/request_permission', params: {
            sessionId: 'kimi_session_1', toolCall: { toolCallId: 'call_edit_1' },
            options: [
              { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'always', name: 'Always', kind: 'allow_always' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          } });
        } else if (message.id === 700 && message.result) {
          permissionReply = message.result;
          proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_session_1', update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'call_edit_1', status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'تم التعديل' } }],
            },
          } });
          proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_session_1', update: {
              sessionUpdate: 'agent_message_chunk', messageId: 'answer_1',
              content: { type: 'text', text: 'اكتمل العمل' },
            },
          } });
          proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
        }
      });
      return processRef;
    },
  });

  const handle = await engine.start({
    prompt: 'عدّل الملف', sessionId: null, model: 'k3', permissionMode: 'default',
    skills: ['satr-guide'], images: [], browserControl: null,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'permission_request'));
  const permission = events.find((event) => event.type === 'permission_request');
  assert.strictEqual(permission.input.api_key, '[secret]');
  assert.strictEqual(permission.input.nested.authorization, '[secret]');
  assert.strictEqual(handle.resolvePermission(permission.id, true, true), true);
  await waitFor(() => events.some((event) => event.type === 'result'));

  assert.deepStrictEqual(permissionReply, { outcome: { outcome: 'selected', optionId: 'always' } });
  assert.ok(events.some((event) => event.type === 'system' && event.session_id === 'kimi_session_1'));
  assert.ok(events.some((event) => event.type === 'assistant'
    && event.message.content.some((item) => item.type === 'tool_use' && item.id === 'call_edit_1')));
  assert.ok(events.some((event) => event.type === 'user'
    && event.message.content.some((item) => item.type === 'tool_result' && !item.is_error)));
  assert.ok(events.some((event) => event.type === 'assistant'
    && event.message.content.some((item) => item.type === 'text' && item.text === 'اكتمل العمل')));
  assert.ok(processRef.lines.some((message) => message.method === 'session/new'));
  assert.ok(mcpOptions.extraTools.some((tool) => tool.name === 'load_skill'));
  assert.ok(mcpOptions.extraTools.some((tool) => tool.name === 'verify_project' && tool.neverAlways));
  const loaded = await mcpOptions.extraTools.find((tool) => tool.name === 'load_skill').handler({ name: 'satr-guide' });
  assert.strictEqual(loaded.isError, false);
  assert.ok(loaded.content[0].text.includes('سطر'));
}

async function testCancelThenResume() {
  const events = [];
  let processRef;
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      processRef = new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/resume') {
          assert.strictEqual(message.params.sessionId, 'kimi_session_1');
          proc.send({ jsonrpc: '2.0', id: message.id, result: {} });
        } else if (message.method === 'session/prompt') promptId = message.id;
        else if (message.method === 'session/cancel') {
          assert.strictEqual(message.params.sessionId, 'kimi_session_1');
          proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
        }
      });
      return processRef;
    },
  });
  const handle = await engine.start({
    prompt: 'أكمل من حيث توقفت', sessionId: 'kimi_session_1', model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => processRef.lines.some((message) => message.method === 'session/prompt'));
  await handle.stop();
  assert.ok(processRef.lines.some((message) => message.method === 'session/resume'));
  assert.ok(processRef.lines.some((message) => message.method === 'session/cancel'));
  assert.ok(!processRef.lines.some((message) => message.method === 'session/new'));
}

async function testBidirectionalRpcIdCollision() {
  const events = [];
  let promptId;
  let readReply;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      } else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_collision_1' } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', id: promptId, method: 'fs/read_text_file', params: {
          sessionId: 'kimi_collision_1', path: path.join(root, 'electron', 'kimi.js'),
        } });
      } else if (message.id === promptId && message.result && typeof message.result.content === 'string') {
        readReply = message.result.content;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_collision_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'answer_collision',
            content: { type: 'text', text: 'اكتملت القراءة' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: 'اقرأ ثم أكمل', sessionId: null, model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));
  assert.ok(readReply.includes("const ENGINE_ID = 'kimi-code'"));
  assert.ok(events.some((event) => JSON.stringify(event).includes('اكتملت القراءة')));
  assert.ok(!events.some((event) => event.type === 'permission_request'));
}

async function testInteractiveQuestion() {
  const events = [];
  let questionReply;
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_question_1' } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', id: 701, method: 'session/request_permission', params: {
          sessionId: 'kimi_question_1',
          toolCall: {
            toolCallId: 'ask_1', title: 'AskUserQuestion', kind: 'other', status: 'pending',
            rawInput: { question: 'أي مسار تختار؟' },
          },
          options: [
            { optionId: 'first', name: 'المسار الأول', kind: 'allow_once' },
            { optionId: 'second', name: 'المسار الثاني', kind: 'allow_once' },
          ],
        } });
      } else if (message.id === 701 && message.result) {
        questionReply = message.result;
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  const handle = await engine.start({
    prompt: 'اسألني قبل الاختيار', sessionId: null, model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'question_request'));
  const question = events.find((event) => event.type === 'question_request');
  assert.strictEqual(question.questions[0].question, 'أي مسار تختار؟');
  assert.strictEqual(handle.resolveQuestion(question.id, [{ questionIndex: 0, optionIndexes: [1] }]), true);
  await waitFor(() => events.some((event) => event.type === 'result'));
  assert.deepStrictEqual(questionReply, { outcome: { outcome: 'selected', optionId: 'second' } });
}

async function testLoadFallbackDoesNotReplayHistory() {
  const events = [];
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult({ sessionCapabilities: { list: {} } }) });
      } else if (message.method === 'session/resume') {
        proc.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      } else if (message.method === 'session/load') {
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_old_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'old_answer',
            content: { type: 'text', text: 'رد تاريخي يجب ألا يتكرر' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/prompt') {
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_old_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'new_answer',
            content: { type: 'text', text: 'رد جديد' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: 'تابع', sessionId: 'kimi_old_1', model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));
  assert.ok(!events.some((event) => JSON.stringify(event).includes('رد تاريخي يجب ألا يتكرر')));
  assert.ok(events.some((event) => JSON.stringify(event).includes('رد جديد')));
}

async function testPlanModeLifecycle() {
  const events = [];
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-kimi-plan-'));
  const project = path.join(sandbox, 'project');
  const kimiRoot = path.join(sandbox, '.kimi-code');
  const sessionId = 'kimi_plan_1';
  const planDir = path.join(kimiRoot, 'sessions', 'wd_project_1234', 'session_' + sessionId, 'agents', 'main', 'plans');
  const planPath = path.join(planDir, 'safe-plan.md');
  const otherPlanDir = path.join(kimiRoot, 'sessions', 'wd_project_1234', 'session_other_session', 'agents', 'main', 'plans');
  const otherPlanPath = path.join(otherPlanDir, 'other-plan.md');
  const projectFile = path.join(project, 'implemented.txt');
  const outsideFile = path.join(sandbox, 'outside.txt');
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(otherPlanDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(otherPlanPath, 'خطة جلسة أخرى', 'utf8');
  fs.writeFileSync(outsideFile, 'محظور', 'utf8');
  assert.strictEqual(kimi._internals.safePlanPath(kimiRoot, sessionId, otherPlanPath, true), null);

  let promptId;
  let planRead;
  let outsideRejected = false;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    dataRoot: () => kimiRoot,
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: {
            sessionUpdate: 'tool_call', toolCallId: 'plan_write', title: 'Write', kind: 'edit',
            status: 'pending', rawInput: { path: planPath },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: 801, method: 'session/request_permission', params: {
          sessionId, toolCall: { toolCallId: 'plan_write' }, options: [
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        } });
      } else if (message.id === 801 && message.result) {
        assert.strictEqual(message.result.outcome.optionId, 'once');
        proc.send({ jsonrpc: '2.0', id: 802, method: 'fs/write_text_file', params: {
          sessionId, path: planPath, content: '# الخطة\n\n1. نفّذ التعديل.',
        } });
      } else if (message.id === 802 && message.result) {
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: {
            sessionUpdate: 'tool_call', toolCallId: 'exit_plan', title: 'ExitPlanMode', kind: 'read',
            status: 'pending', rawInput: {},
          },
        } });
        proc.send({ jsonrpc: '2.0', id: 803, method: 'fs/read_text_file', params: { sessionId, path: planPath } });
      } else if (message.id === 803 && message.result) {
        planRead = message.result.content;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'exit_plan', status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'تم اعتماد الخطة' } }],
          },
        } });
        proc.send({ jsonrpc: '2.0', id: 804, method: 'fs/read_text_file', params: { sessionId, path: outsideFile } });
      } else if (message.id === 804 && message.error) {
        outsideRejected = message.error.code === -32602;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId, update: {
            sessionUpdate: 'tool_call', toolCallId: 'project_edit', title: 'Edit', kind: 'edit',
            status: 'pending', rawInput: { path: projectFile },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: 805, method: 'session/request_permission', params: {
          sessionId, toolCall: { toolCallId: 'project_edit' }, options: [
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        } });
      } else if (message.id === 805 && message.result) {
        assert.strictEqual(message.result.outcome.optionId, 'once');
        proc.send({ jsonrpc: '2.0', id: 806, method: 'fs/write_text_file', params: {
          sessionId, path: projectFile, content: 'اكتمل التنفيذ',
        } });
      } else if (message.id === 806 && message.result) {
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  try {
    await engine.start({
      prompt: 'خطط ثم نفّذ', sessionId: null, model: 'k3', permissionMode: 'acceptEdits',
      skills: [], images: [], browserControl: false,
    }, project, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'result'));
    assert.strictEqual(planRead, '# الخطة\n\n1. نفّذ التعديل.');
    assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), 'اكتمل التنفيذ');
    assert.strictEqual(outsideRejected, true);
    assert.ok(!events.some((event) => event.type === 'permission_request'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function testReadTextFileLineLimit() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-kimi-read-'));
  const longFile = path.join(sandbox, 'long.txt');
  const hugeFile = path.join(sandbox, 'huge.txt');
  const lastLine = 'السطر الأخير 2500';
  const lines = Array.from({ length: 2499 }, (_, i) => 'سطر ' + (i + 1));
  lines.push(lastLine);
  fs.writeFileSync(longFile, lines.join('\n'), 'utf8');
  fs.writeFileSync(hugeFile, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');

  const events = [];
  let promptId;
  let longContent;
  let hugeRejected;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      } else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_readlimit_1' } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', id: 900, method: 'fs/read_text_file', params: {
          sessionId: 'kimi_readlimit_1', path: longFile,
        } });
      } else if (message.id === 900 && message.result) {
        longContent = message.result.content;
        proc.send({ jsonrpc: '2.0', id: 901, method: 'fs/read_text_file', params: {
          sessionId: 'kimi_readlimit_1', path: hugeFile,
        } });
      } else if (message.id === 901 && message.error) {
        hugeRejected = message.error.code === -32602;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_readlimit_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'answer_read',
            content: { type: 'text', text: 'تمت القراءة' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  try {
    await engine.start({
      prompt: 'اقرأ الملف', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, sandbox, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'result'));
    assert.ok(longContent && longContent.includes(lastLine), 'يجب قراءة ملف 2500 سطر كاملاً حتى السطر الأخير');
    assert.strictEqual(longContent.split('\n').length, 2500, 'يجب أن يحتوي الرد على 2500 سطر');
    assert.strictEqual(hugeRejected, true, 'يجب رفض الملف الأكبر من 2MiB');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function testKeepaliveReusesChannel() {
  const events1 = [];
  const events2 = [];
  let processRef;
  let spawnCount = 0;
  let initializeCount = 0;
  let sessionNewCount = 0;
  let turn = 0;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      spawnCount++;
      processRef = new FakeProcess((message, proc) => {
        if (message.method === 'initialize') {
          initializeCount++;
          proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        } else if (message.method === 'session/new') {
          sessionNewCount++;
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_keep_1' } });
        } else if (message.method === 'session/prompt') {
          turn++;
          const text = turn === 1 ? 'نهاية الدور الأول' : 'نهاية الدور الثاني';
          proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_keep_1', update: {
              sessionUpdate: 'agent_message_chunk', messageId: 'm' + turn,
              content: { type: 'text', text },
            },
          } });
          proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        }
      });
      return processRef;
    },
  });

  try {
    await engine.start({
      prompt: 'الدور الأول', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, root, (event) => events1.push(event));
    await waitFor(() => events1.some((event) => event.type === 'result'));
    assert.ok(engine.keepalive.list().some((item) => item.id === 'ks_kimi_keep_1'), 'الجلسة تُسجَّل حية بعد الدور الأول');
    assert.strictEqual(processRef.killed, false, 'العملية لا تُقتل عند end_turn (K2)');

    await engine.start({
      prompt: 'الدور الثاني', sessionId: 'kimi_keep_1', model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, root, (event) => events2.push(event));
    await waitFor(() => events2.some((event) => event.type === 'result'));
    assert.strictEqual(spawnCount, 1, 'الدور الثاني يستأجر القناة — لا spawn جديد');
    assert.strictEqual(initializeCount, 1, 'لا initialize ثانية على قناة مستأجرة');
    assert.strictEqual(sessionNewCount, 1, 'لا session/new ثانية على قناة مستأجرة');
    assert.ok(events2.some((event) => event.type === 'system' && event.subtype === 'init' && event.session_id === 'kimi_keep_1'));
    assert.ok(events2.some((event) => JSON.stringify(event).includes('نهاية الدور الثاني')));
    assert.ok(!processRef.lines.some((message) => message.method === 'session/cancel'),
      'لا session/cancel عند نهاية الدور (قرار القائد 3)');
  } finally {
    await engine.keepalive.killAll();
  }
}

async function testKeepaliveLateEvents() {
  const events = [];
  const lateEvents = [];
  let processRef;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      processRef = new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') {
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_late_1' } });
        } else if (message.method === 'session/prompt') {
          proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        }
      });
      return processRef;
    },
  });
  engine.keepalive.setLateEventSink((evt) => lateEvents.push(evt));

  try {
    await engine.start({
      prompt: 'دور ثم نشاط متأخر', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, root, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'result'));

    // بعد انتهاء الدور: نشاط الوكيل (cron مثلاً) يصل كإشعار محجوب — لا في سجل المحادثة
    processRef.send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'kimi_late_1', update: {
        sessionUpdate: 'agent_message_chunk', messageId: 'late_m1',
        content: { type: 'text', text: 'مهمة مجدولة اكتملت: sk-live-1234567890abcdef' },
      },
    } });
    await waitFor(() => lateEvents.length >= 1, 3000);
    const late = lateEvents[0];
    assert.strictEqual(late.type, 'kimi_keepalive_event');
    assert.strictEqual(late.sessionId, 'kimi_late_1');
    assert.strictEqual(late.kind, 'message');
    assert.ok(!late.text.includes('sk-live'), 'السر محجوب في الحدث المتأخر');
    assert.ok(late.text.includes('[secret]'));
    assert.ok(!events.some((event) => JSON.stringify(event).includes('مهمة مجدولة اكتملت')),
      'الحدث المتأخر لا يدخل سجل الدور');
  } finally {
    await engine.keepalive.killAll();
  }
}

async function testKeepaliveStopKeepsSession() {
  const events = [];
  let processRef;
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      processRef = new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') {
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_stop_1' } });
        } else if (message.method === 'session/prompt') {
          promptId = message.id; // لا رد فوري: الدور يبقى جارياً حتى يُلغى
        } else if (message.method === 'session/cancel') {
          proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
        }
      });
      return processRef;
    },
  });

  try {
    const handle = await engine.start({
      prompt: 'دور طويل', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, root, (event) => events.push(event));
    await waitFor(() => processRef.lines.some((message) => message.method === 'session/prompt'));
    await handle.stop();
    assert.ok(processRef.lines.some((message) => message.method === 'session/cancel'),
      'إيقاف الدور يرسل session/cancel');
    assert.strictEqual(processRef.killed, false, 'إيقاف الدور لا يقتل العملية (قرار القائد 2)');
    assert.ok(events.some((event) => event.type === 'proc_done'));
    assert.ok(engine.keepalive.list().some((item) => item.id === 'ks_kimi_stop_1'),
      'الجلسة تبقى في السجل بعد إيقاف الدور');
    const killed = await engine.keepalive.kill('kimi_stop_1');
    assert.strictEqual(killed.ok, true);
    assert.strictEqual(engine.keepalive.list().length, 0, 'القتل الكامل من السجل يزيل الجلسة');
  } finally {
    await engine.keepalive.killAll();
  }
}

async function testKeepaliveEvictsOldest() {
  let spawnCount = 0;
  let sessionSeq = 0;
  const procs = [];
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      spawnCount++;
      const proc = new FakeProcess((message, child) => {
        if (message.method === 'initialize') child.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') {
          sessionSeq++;
          child.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_evict_' + sessionSeq } });
        } else if (message.method === 'session/prompt') {
          child.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        }
      });
      procs.push(proc);
      return proc;
    },
  });

  try {
    for (let i = 0; i < 3; i++) {
      const events = [];
      await engine.start({
        prompt: 'دور ' + (i + 1), sessionId: null, model: 'k3', permissionMode: 'default',
        skills: [], images: [], browserControl: false,
      }, root, (event) => events.push(event));
      await waitFor(() => events.some((event) => event.type === 'result'));
    }
    assert.strictEqual(spawnCount, 3);
    const ids = engine.keepalive.list().map((item) => item.id);
    assert.strictEqual(ids.length, 2, 'السجل يبقي عمليتين حيتين كحد أقصى');
    assert.ok(ids.includes('ks_kimi_evict_2') && ids.includes('ks_kimi_evict_3'));
    await waitFor(() => procs[0].killed, 3000);
    assert.strictEqual(procs[0].killed, true, 'الأقدم خمولاً يُقتل عند الطرد');
  } finally {
    await engine.keepalive.killAll();
  }
}

// K3-أ: المرجع الحي لسياق المهارات — إغلاقات extraTools تقرأ سياق الدور الحالي.
async function testSkillContextLiveRef() {
  const ref = { current: skillCatalog.resolveSelection(root, ['satr-guide']) };
  const tools = kimi._internals.buildSatrMcpTools(root, ref, () => {});
  const loadSkill = tools.find((tool) => tool.name === 'load_skill');

  const guide = await loadSkill.handler({ name: 'satr-guide' });
  assert.strictEqual(guide.isError, false, 'المهارة المفعّلة في السياق الحالي تُحمَّل');
  const tafqeetEarly = await loadSkill.handler({ name: 'tafqeet' });
  assert.strictEqual(tafqeetEarly.isError, true, 'مهارة خارج الاختيار تُرفض قبل التحديث');

  // تحديث المرجع (كما يفعل الاستئجار): السياق الجديد يُرى والقديم لا يتسرّب
  ref.current = skillCatalog.resolveSelection(root, ['tafqeet']);
  const tafqeet = await loadSkill.handler({ name: 'tafqeet' });
  assert.strictEqual(tafqeet.isError, false, 'المرجع المحدَّث يرى اختيار الدور الجديد');
  const guideLate = await loadSkill.handler({ name: 'satr-guide' });
  assert.strictEqual(guideLate.isError, true, 'اختيار الدور القديم لا يتسرّب بعد التحديث');

  // توافق خلفي: كائن سياق عادي (بلا current) يعمل كما كان
  const staticTools = kimi._internals.buildSatrMcpTools(root, skillCatalog.resolveSelection(root, ['satr-guide']), () => {});
  const staticLoad = staticTools.find((tool) => tool.name === 'load_skill');
  const staticGuide = await staticLoad.handler({ name: 'satr-guide' });
  assert.strictEqual(staticGuide.isError, false, 'الكائن العادي يبقى مدعوماً');
}

// K3-أ عبر المحرك: الدور المستأجر يرى مهارات اختياره رغم أن أدوات MCP بُنيت في الدور الأول.
async function testKeepaliveLeasedTurnSeesCurrentSkills() {
  const events1 = [];
  const events2 = [];
  let capturedTools = null;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    startMcp: async (options) => {
      if (!capturedTools) capturedTools = options.extraTools;
      return { url: 'http://127.0.0.1:49152/mcp', token: 'test-token', stop: async () => {} };
    },
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_skills_1' } });
      } else if (message.method === 'session/prompt') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  try {
    await engine.start({
      prompt: 'الدور الأول', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: ['satr-guide'], images: [], browserControl: true,
    }, root, (event) => events1.push(event));
    await waitFor(() => events1.some((event) => event.type === 'result'));
    assert.ok(capturedTools, 'أدوات MCP بُنيت في الدور الأول');
    const loadSkill = capturedTools.find((tool) => tool.name === 'load_skill');
    assert.strictEqual((await loadSkill.handler({ name: 'satr-guide' })).isError, false);
    assert.strictEqual((await loadSkill.handler({ name: 'tafqeet' })).isError, true);

    // دور ثانٍ مستأجر باختيار مختلف: نفس القناة وأدواتها لكن بسياق الدور الجديد
    await engine.start({
      prompt: 'الدور الثاني', sessionId: 'kimi_skills_1', model: 'k3', permissionMode: 'default',
      skills: ['tafqeet'], images: [], browserControl: true,
    }, root, (event) => events2.push(event));
    await waitFor(() => events2.some((event) => event.type === 'result'));
    assert.strictEqual((await loadSkill.handler({ name: 'tafqeet' })).isError, false,
      'الدور المستأجر يرى مهارات اختياره الحالي');
    assert.strictEqual((await loadSkill.handler({ name: 'satr-guide' })).isError, true,
      'اختيار الدور الأول لا يتسرّب إلى الدور المستأجر');
  } finally {
    await engine.keepalive.killAll();
  }
}

async function testSessionBrowser() {
  const spawned = [];
  const listRequests = [];
  // 260 جلسة على 3 صفحات: تتجاوز السقف القديم (80) وتختبر القصّ الآمن عند السقف الجديد (200)
  const allSessions = [];
  for (let i = 0; i < 260; i++) {
    allSessions.push({
      sessionId: 'kimi_sess_' + String(i).padStart(4, '0'), cwd: root, title: 'جلسة رقم ' + i,
      updatedAt: new Date(Date.parse('2026-07-20T00:00:00Z') + i * 1000).toISOString(),
    });
  }
  allSessions[5].sessionId = 'kimi_history_1';
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      const proc = new FakeProcess((message, child) => {
        if (message.method === 'initialize') child.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/list') {
          listRequests.push(message.params || {});
          const cursor = message.params && message.params.cursor;
          const page = cursor === 'p2' ? 1 : cursor === 'p3' ? 2 : 0;
          child.send({ jsonrpc: '2.0', id: message.id, result: {
            sessions: allSessions.slice(page * 100, page * 100 + 100),
            nextCursor: page < 2 ? 'p' + (page + 2) : undefined,
          } });
        }
        else if (message.method === 'session/load') {
          // إعادة بث تاريخية: نصوص متداخلة مع نداءي أداة (مكتمل وفاشل)
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'الطلب' },
            },
          } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'الرد الأول' },
            },
          } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'tool_call', toolCallId: 'hist_bash_1', title: 'Bash', kind: 'execute',
              status: 'in_progress', rawInput: { command: 'npm test' },
            },
          } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'hist_bash_1', status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
            },
          } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'tool_call', toolCallId: 'hist_edit_1', title: 'Edit', kind: 'edit',
              status: 'pending', rawInput: { path: 'a.js', api_key: 'must-not-leak' },
            },
          } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'hist_edit_1', status: 'failed',
            },
          } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'kimi_history_1', update: {
              sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: { type: 'text', text: 'الرد الأخير' },
            },
          } });
          child.send({ jsonrpc: '2.0', id: message.id, result: null });
        }
      });
      spawned.push(proc);
      return proc;
    },
  });

  const listed = await engine.listSessions();
  assert.strictEqual(listed.length, 200); // السقف الجديد مع قصّ آمن (كان 80)
  assert.deepStrictEqual(listRequests.map((params) => params.cursor || ''), ['', 'p2']); // تصفح بالمؤشر
  assert.strictEqual(listed[0].id, 'kimi_sess_0199'); // الأحدث ضمن أول 200 ملتقطة (قصّ آمن)
  for (let i = 1; i < listed.length; i++) assert.ok(listed[i - 1].mtime >= listed[i].mtime);

  const read = await engine.readSession('kimi_history_1');
  assert.strictEqual(read.total, 5);
  assert.deepStrictEqual(read.messages.map((item) => item.role),
    ['user', 'assistant', 'assistant', 'assistant', 'assistant']); // الترتيب كما ورد
  assert.strictEqual(read.messages[0].text, 'الطلب');
  assert.strictEqual(read.messages[1].text, 'الرد الأول');
  const bash = read.messages[2].content[0];
  assert.strictEqual(bash.type, 'tool_use');
  assert.strictEqual(bash.id, 'hist_bash_1');
  assert.strictEqual(bash.name, 'تنفيذ أمر'); // التسمية العربية من KIMI_TOOL_LABELS
  assert.strictEqual(bash.status, 'completed'); // الحالة النهائية من tool_call_update
  const edit = read.messages[3].content[0];
  assert.strictEqual(edit.type, 'tool_use');
  assert.strictEqual(edit.name, 'تعديل ملف');
  assert.strictEqual(edit.status, 'failed');
  assert.strictEqual(edit.input.api_key, '[secret]'); // المدخل منقّى كما في البث الحي
  assert.strictEqual(read.messages[4].text, 'الرد الأخير');
  assert.ok(spawned.length >= 3, 'السرد والقراءة يستخدمان ACP رسمياً');
}

async function testModelCompactAndEffortContract() {
  const events = [];
  const configRequests = [];
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: {
        sessionId: 'kimi_compact_1',
        configOptions: [
          {
            id: 'model', category: 'model', currentValue: 'kimi-code/kimi-for-coding',
            options: [
              { value: 'kimi-code/kimi-for-coding', name: 'K2.7 Coding' },
              { value: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Coding Highspeed' },
              { value: 'kimi-code/k3', name: 'K3' },
            ],
          },
          { id: 'thinking', category: 'thought_level', currentValue: 'on', options: [{ value: 'on', name: 'On' }] },
        ],
      } });
      else if (message.method === 'session/set_config_option') {
        configRequests.push(message.params);
        proc.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        assert.deepStrictEqual(message.params.prompt, [{ type: 'text', text: '/compact' }]);
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_compact_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'compact_result',
            content: { type: 'text', text: 'Compacting conversation context…\n' },
          },
        } });
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_compact_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'compact_result',
            content: { type: 'text', text: 'Compaction completed.\n- Messages compacted: 8\n- Tokens before: 12,345\n- Tokens after: 2,345' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: '/compact', sessionId: null, model: 'k3', effort: 'max',
    permissionMode: 'default', skills: ['satr-guide'], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));
  assert.deepStrictEqual(configRequests, [{
    sessionId: 'kimi_compact_1', configId: 'model', value: 'kimi-code/k3',
  }]);
  const boundary = events.find((event) => event.type === 'system' && event.subtype === 'compact_boundary');
  assert.deepStrictEqual(boundary.compact_metadata, {
    trigger: 'manual', pre_tokens: 12345, post_tokens: 2345, messages_compacted: 8,
  });
  assert.ok(!events.some((event) => event.type === 'stream_text'));
  assert.ok(!events.some((event) => event.type === 'assistant'
    && JSON.stringify(event).includes('Compaction completed')));
}

async function testContextUsageCommand() {
  let promptSeen = false;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/resume') {
        assert.strictEqual(message.params.sessionId, 'kimi_usage_1');
        proc.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/prompt') {
        promptSeen = true;
        assert.deepStrictEqual(message.params.prompt, [{ type: 'text', text: '/usage' }]);
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_usage_1', update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Session usage:\n- Total: input 5,646, output 147, cache read 19,200, cache creation 0\n' },
          },
        } });
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_usage_1', update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '- kimi-code/k3: input 5,646, output 147, cache read 19,200, cache creation 0\n- Context: 24,993 / 1,048,576 (2.4%)' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  const result = await engine.contextUsage(root, 'kimi_usage_1');
  assert.strictEqual(promptSeen, true);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.usage, {
    totalTokens: 24993, maxTokens: 1048576, percentage: 2.4, model: 'kimi-code/k3',
    categories: [
      { name: 'مدخلات الجلسة', tokens: 5646, isDeferred: false },
      { name: 'مخرجات الجلسة', tokens: 147, isDeferred: false },
      { name: 'قراءة الذاكرة المخبأة', tokens: 19200, isDeferred: false },
    ],
  });
  assert.deepStrictEqual(await engine.contextUsage(root, null), { ok: false, error: 'ابدأ جلسة Kimi أولاً' });
}

async function testForkSession() {
  let forkSeen = false;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/fork') {
        forkSeen = true;
        assert.strictEqual(message.params.sessionId, 'kimi_session_1');
        assert.strictEqual(message.params.cwd, root);
        assert.strictEqual(message.params.upToMessageId, 'kimi_msg_1');
        assert.strictEqual(message.params.title, 'فرع: اختبار التفريع');
        proc.send({ jsonrpc: '2.0', id: message.id, result: {
          sessionId: 'kimi_fork_1',
          configOptions: [{ id: 'model', type: 'select', options: [{ value: 'k3', name: 'K3' }] }],
          modes: { currentModeId: 'default', availableModes: [] },
        } });
      }
    }),
  });

  const result = await engine.forkSession({
    cwd: root,
    sessionId: 'kimi_session_1',
    upToMessageId: 'kimi_msg_1',
    title: 'فرع: اختبار التفريع',
  });
  assert.strictEqual(forkSeen, true);
  assert.deepStrictEqual(result, { ok: true, sessionId: 'kimi_fork_1', from: 'point' });

  // تنقية المعرّف المعاد: إن أعادت العملية معرّفاً غير صالح
  const badIdEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/fork') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: '../../evil' } });
      }
    }),
  });
  const badIdResult = await badIdEngine.forkSession({ cwd: root, sessionId: 'kimi_session_1' });
  assert.strictEqual(badIdResult.ok, false);
  assert.strictEqual(badIdResult.error, 'invalid_fork_id');
  assert.ok(!badIdResult.message || !badIdResult.message.includes('../../evil'));

  // رمز خطأ ثابت عند -32601 Method not found، دون تسريب نص upstream
  const unsupportedEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/fork') {
        proc.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found upstream' } });
      }
    }),
  });
  const unsupportedResult = await unsupportedEngine.forkSession({ cwd: root, sessionId: 'kimi_session_1' });
  assert.strictEqual(unsupportedResult.ok, false);
  assert.strictEqual(unsupportedResult.error, 'fork_failed');
  assert.ok(!unsupportedResult.message || !unsupportedResult.message.includes('Method not found upstream'));
  assert.ok(!unsupportedResult.message || !unsupportedResult.message.includes('-32601'));

  // without upToMessageId → from: 'end'
  const endEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/fork') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_fork_end', configOptions: [], modes: {} } });
      }
    }),
  });
  const endResult = await endEngine.forkSession({ cwd: root, sessionId: 'kimi_session_1' });
  assert.deepStrictEqual(endResult, { ok: true, sessionId: 'kimi_fork_end', from: 'end' });
}

async function testToolLabelsAndAvailableCommands() {
  const events = [];
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_labels_1' } });
      } else if (message.method === 'session/prompt') {
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_labels_1', update: {
            sessionUpdate: 'tool_call', toolCallId: 'cron_1', title: 'CronList', kind: 'other',
            status: 'pending', rawInput: {},
          },
        } });
        // عنوان التحديث نص حر من Kimi — يجب ألا يحل محل التسمية العربية الأولى
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_labels_1', update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'cron_1', title: 'Listing scheduled cron jobs',
            status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'لا مهام' } }],
          },
        } });
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_labels_1', update: {
            sessionUpdate: 'tool_call', toolCallId: 'swarm_1', title: 'AgentSwarm', kind: 'other',
            status: 'pending', rawInput: {},
          },
        } });
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_labels_1', update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'compact', description: 'Compact the conversation' },
              { name: 'status', description: 'Show session status' },
              { name: 'tasks', description: 'List background tasks' },
              { name: 'help', description: 'Show help' },
              { name: 'usage', description: 'Show usage' },
              { description: 'بلا اسم يُستبعد' },
            ],
          },
        } });
        proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: 'اعرض المجدولات', sessionId: null, model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));

  const toolUse = (id) => events.find((event) => event.type === 'assistant'
    && event.message.content.some((item) => item.type === 'tool_use' && item.id === id));
  assert.strictEqual(toolUse('cron_1').message.content[0].name, 'عرض المهام المجدولة');
  assert.strictEqual(toolUse('swarm_1').message.content[0].name, 'سرب وكلاء');

  const declared = events.find((event) => event.type === 'system' && event.subtype === 'available_commands');
  assert.ok(declared, 'يجب أن يُمرَّر available_commands_update للواجهة');
  assert.deepStrictEqual(declared.commands.map((command) => command.name),
    ['compact', 'status', 'tasks', 'help', 'usage']);
  assert.strictEqual(declared.commands[1].description, 'Show session status');

  assert.strictEqual(kimi._internals.toolLabel('Agent'), 'وكيل فرعي');
  assert.strictEqual(kimi._internals.toolLabel('AskUserQuestion'), 'سؤال للمستخدم');
  assert.strictEqual(kimi._internals.toolLabel('أداة غير معروفة'), 'أداة غير معروفة');
}

// OBS-023 — المرساة اللغوية تصل Kimi كما تصل SDK وCodex.
// كان المحرك الأصيل الوحيد خارجها: `CONTRACT_LINE` عبر envbrief فقط، بلا مرساة
// ذيلية ولا صيغة قوية. الفحص **سلوكي** على البرومبت المرسَل فعلاً لا نصّي على المصدر:
// الموضع (آخر كتلة) والصيغة (بايتاً ببايت من langanchor) والبوابة (المعزول خارجها).
async function testLanguageAnchorReachesKimi() {
  const langanchor = require('../electron/langanchor');
  async function runTurn(extra) {
    let processRef;
    const engine = kimi.create({
      resolveKimiBin: () => 'C:\\fake\\kimi.exe',
      spawn: () => {
        processRef = new FakeProcess((message, proc) => {
          if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
          else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_anchor_1' } });
          else if (message.method === 'session/prompt') proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        });
        return processRef;
      },
    });
    const events = [];
    await engine.start({
      prompt: 'حلّل هذا الملف', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false, ...extra,
    }, root, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'result'));
    await engine.keepalive.killAll();
    const sent = processRef.lines.find((message) => message.method === 'session/prompt');
    return sent.params.prompt;
  }

  const normal = await runTurn({ browserControl: null });
  const last = normal[normal.length - 1];
  assert.strictEqual(last.type, 'text', 'المرساة ليست آخر كتلة — «الذيلية» تعني الأقرب لما يقرؤه النموذج');
  assert.strictEqual(last.text, langanchor.anchor({ strong: true }),
    'صيغة المرساة القوية لا تطابق langanchor بايتاً ببايت (الدور الأول يستحق القوية)');
  assert.ok(normal.filter((block) => block.type === 'text').length >= 2,
    'نص المستخدم ما زال موجوداً بجانب المرساة');

  // السياق المعزول (المراجع/العصف) خارجها — نفس بوابة الذاكرة حرفياً
  const isolated = await runTurn({ browserControl: false });
  assert.ok(!isolated.some((block) => block.type === 'text' && block.text === langanchor.anchor({ strong: true })),
    'السياق المعزول تسرّبت إليه المرساة — بوابته هي بوابة الذاكرة نفسها');
}

// OBS-052 — خطأ الأنبوب غير المتزامن لا يتسرّب uncaughtException (فئة عطل OBS-053 نفسها،
// الذي أوقف التطبيق بحوار Electron أحمر من `codex.js`). الادعاء **سلوكي**: نبثّ حدث
// 'error' على stdin من دورة أحداث تالية أثناء كتابة جارية — وهي بعينها نافذة EPIPE عند
// موت العملية فجأة قبل أن يضبط `createRpc` علم `closed`. بلا مستمع تنشره EventEmitter
// رمياً (كما تفعل الـstreams حرفياً) فيصير استثناءً غير ملتقط.
// **حدّ مُعلَن**: هذا يثبت أن المستمع مسجَّل ويبتلع الحدث في موضعَي spawn معاً؛ لا يثبت
// EPIPE من ثنائي Kimi حقيقي (يحتاج جلسة مسجَّلة الدخول). الآلية آلية Node لا Kimi.
async function testStdinPipeErrorDoesNotEscape() {
  const escaped = [];
  const onUncaught = (error) => escaped.push(error);
  const pipeError = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  process.on('uncaughtException', onUncaught);

  // (أ) موضع spawn الأول — مسار الدور
  let turnProc;
  let spawnCount = 0;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      spawnCount++;
      turnProc = new FakeProcess((message, proc) => {
        // الأنبوب ينهار **أثناء** كتابة جارية: أسوأ لحظة، وقبل أي إغلاق منظّم.
        setTimeout(() => proc.stdin.emit('error', pipeError()), 0);
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_pipe_1' } });
        else if (message.method === 'session/prompt') proc.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      });
      return turnProc;
    },
  });

  try {
    const events1 = [];
    await engine.start({
      prompt: 'الدور الأول', sessionId: null, model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, root, (event) => events1.push(event));
    await waitFor(() => events1.some((event) => event.type === 'result'));
    assert.strictEqual(turnProc.stdin.listenerCount('error'), 1,
      'موضع spawn الأول بلا مستمع خطأ على stdin — أي انهيار أنبوب يوقف التطبيق');

    // القناة المستأجرة تعيد استعمال العملية نفسها: تسجيلٌ لكل دور كان يسرّب مستمعين.
    const events2 = [];
    await engine.start({
      prompt: 'الدور الثاني', sessionId: 'kimi_pipe_1', model: 'k3', permissionMode: 'default',
      skills: [], images: [], browserControl: false,
    }, root, (event) => events2.push(event));
    await waitFor(() => events2.some((event) => event.type === 'result'));
    assert.strictEqual(spawnCount, 1, 'الدور الثاني لم يستأجر القناة — اختبار المستمع لا يقيس ما يدّعيه');
    assert.strictEqual(turnProc.stdin.listenerCount('error'), 1,
      'المستمع يُسجَّل لكل دور لا عند spawn — تسريب مستمعين على القناة المستأجرة');
  } finally {
    await engine.keepalive.killAll();
  }

  // (ب) موضع spawn الثاني — withProbe (سرد النماذج/الجلسات)
  let probeProc;
  const probeEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      probeProc = new FakeProcess((message, proc) => {
        setTimeout(() => proc.stdin.emit('error', pipeError()), 0);
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: {
          sessionId: 'kimi_pipe_2',
          configOptions: [{ id: 'model', category: 'model', currentValue: 'kimi-code/k3', options: [{ value: 'kimi-code/k3', name: 'K3' }] }],
        } });
      });
      return probeProc;
    },
  });
  await probeEngine.listModels();
  assert.strictEqual(probeProc.stdin.listenerCount('error'), 1,
    'موضع spawn الثاني (withProbe) بلا مستمع خطأ على stdin');

  await new Promise((resolve) => setTimeout(resolve, 150)); // خطأ الأنبوب غير متزامن
  process.removeListener('uncaughtException', onUncaught);
  assert.deepStrictEqual(escaped.map((error) => error && error.code), [],
    'انهيار الأنبوب سرّب استثناءً غير ملتقط — نفس عطل OBS-053 في محرك Kimi');
}

async function testListModelsFromAcp() {
  let spawnCount = 0;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      spawnCount++;
      return new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: {
          sessionId: 'kimi_probe_1',
          configOptions: [
            {
              id: 'model', category: 'model', currentValue: 'kimi-code/kimi-for-coding',
              options: [
                { value: 'kimi-code/kimi-for-coding', name: 'K2.7 Coding' },
                { value: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Coding Highspeed' },
                { value: 'kimi-code/k3', name: 'K3' },
              ],
            },
            { id: 'thinking', category: 'thought_level', currentValue: 'on', options: [{ value: 'on', name: 'On' }] },
          ],
        } });
      });
    },
  });

  const models = await engine.listModels();
  assert.deepStrictEqual(models, [
    { id: 'kimi-code/kimi-for-coding', name: 'K2.7 Coding' },
    { id: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Coding Highspeed' },
    { id: 'kimi-code/k3', name: 'K3' },
  ]);
  // الكشف القصير: الجلب الثاني خلال المهلة لا يفتح عملية `kimi acp` جديدة
  assert.deepStrictEqual(await engine.listModels(), models);
  assert.strictEqual(spawnCount, 1);
  // غياب الثنائي أو أي فشل ⇒ قائمة فارغة دون رمي (تبقى الواجهة على الاحتياط الثابت)
  const failing = kimi.create({ resolveKimiBin: () => null });
  assert.deepStrictEqual(await failing.listModels(), []);
}

async function testThinkingStream() {
  const events = [];
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_thought_1' } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_thought_1', update: {
            sessionUpdate: 'agent_thought_chunk', messageId: 'think_1',
            content: { type: 'text', text: 'أولاً، سأحسب ' },
          },
        } });
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_thought_1', update: {
            sessionUpdate: 'agent_thought_chunk', messageId: 'think_1',
            content: { type: 'text', text: 'المجموع بعناية. السر المتداخل: sk-live-1234567890abcdef.' },
          },
        } });
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_thought_1', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'answer_1',
            content: { type: 'text', text: 'الإجابة: 68' },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: 'احسب 23+45', sessionId: null, model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));

  const commentaryStream = events.filter((event) => event.type === 'stream_text' && event.phase === 'commentary');
  assert.ok(commentaryStream.length >= 2, 'يجب أن يبثّ التفكير كـ stream_text بـ phase commentary');
  const joined = commentaryStream.map((event) => event.text).join('');
  assert.ok(joined.includes('أولاً'), 'يجب أن يحتوي التفكير على النص الأصلي');
  assert.ok(!joined.includes('sk-live-1234567890abcdef'), 'يجب حجب السر من التفكير المبثوث');
  assert.ok(joined.includes('[secret]'), 'يجب أن يظهر السر المحجوب بوضوح');

  const assistantText = events.filter((event) => event.type === 'assistant' && event.message && Array.isArray(event.message.content));
  const commentaryBlock = assistantText.flatMap((event) => event.message.content)
    .find((block) => block.type === 'text' && block.phase === 'commentary');
  assert.ok(commentaryBlock, 'يجب أن تُدمج كتلة التفكير في رسالة assistant بـ phase commentary');
  assert.ok(!commentaryBlock.text.includes('sk-live'), 'يجب حجب السر من التفكير المدمج');

  const finalBlock = assistantText.flatMap((event) => event.message.content)
    .find((block) => block.type === 'text' && block.phase === 'final_answer');
  assert.ok(finalBlock && finalBlock.text.includes('68'), 'يجب أن يبقى الإجابة النهائية final_answer');
}

async function testThinkingTruncation() {
  const events = [];
  let promptId;
  const longThought = 'كلمة '.repeat(15000); // ~90000 حرف — يتجاوز MAX_TOOL_TEXT
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') {
        proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_thought_long_1' } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'kimi_thought_long_1', update: {
            sessionUpdate: 'agent_thought_chunk', messageId: 'think_long',
            content: { type: 'text', text: longThought },
          },
        } });
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: 'فكّر كثيراً', sessionId: null, model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));

  const commentary = events.find((event) => event.type === 'assistant'
    && event.message.content.some((block) => block.phase === 'commentary'));
  assert.ok(commentary, 'التفكير الطويل يجب أن يظهر ككتلة commentary');
  const text = commentary.message.content.find((block) => block.phase === 'commentary').text;
  assert.ok(text.length <= 20001, 'يجب قصّ التفكير عند سقف MAX_TOOL_TEXT');
  assert.ok(text.includes('…'), 'يجب أن يحتوي النص المقصوص على علامة القص');
}

async function testThinkingConfigOption() {
  const events = [];
  const configRequests = [];
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: {
        sessionId: 'kimi_thinking_cfg_1',
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'k3', options: [{ value: 'k3', name: 'K3' }] },
          { id: 'thinking', category: 'thought_level', currentValue: 'off', options: [{ value: 'on', name: 'On' }] },
        ],
      } });
      else if (message.method === 'session/set_config_option') {
        configRequests.push(message.params);
        proc.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  await engine.start({
    prompt: 'فكّر', sessionId: null, model: 'k3', thinking: 'on',
    permissionMode: 'default', skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));
  assert.deepStrictEqual(configRequests, [{
    sessionId: 'kimi_thinking_cfg_1', configId: 'thinking', value: 'on',
  }]);
}

function testKimiLoginCommandAndCwd() {
  const { loginCommand, loginCwd } = kimi._internals;
  const cmd = loginCommand('C:\\Users\\User\\.kimi-code\\bin\\kimi.exe');
  assert.ok(cmd.startsWith('& "'), 'يجب أن يبدأ الأمر بمعامل الاستدعاء PowerShell');
  assert.ok(cmd.endsWith('" login'), 'يجب أن ينتهي الأمر بـ " login');
  assert.ok(cmd.includes('kimi.exe'), 'يجب أن يحتوي الأمر على مسار الثنائي');

  const homedir = os.homedir();
  assert.strictEqual(loginCwd(''), homedir);
  assert.strictEqual(loginCwd('   '), homedir);
  assert.strictEqual(loginCwd(null), homedir);
  assert.strictEqual(loginCwd(path.join(root, 'nonexistent-folder-xyz')), homedir);

  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-kimi-login-'));
  try {
    assert.strictEqual(loginCwd(existing), existing);
  } finally {
    fs.rmdirSync(existing);
  }
}

async function testFullModelValueApplied() {
  const events = [];
  const configRequests = [];
  let promptId;
  const engine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => new FakeProcess((message, proc) => {
      if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
      else if (message.method === 'session/new') proc.send({ jsonrpc: '2.0', id: message.id, result: {
        sessionId: 'kimi_fullmodel_1',
        configOptions: [
          {
            id: 'model', category: 'model', currentValue: 'kimi-code/k3',
            options: [
              { value: 'kimi-code/kimi-for-coding', name: 'K2.7 Coding' },
              { value: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Coding Highspeed' },
              { value: 'kimi-code/k3', name: 'K3' },
            ],
          },
        ],
      } });
      else if (message.method === 'session/set_config_option') {
        configRequests.push(message.params);
        proc.send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        proc.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
    }),
  });

  // القيمة الكاملة القادمة من القائمة الديناميكية تُطبَّق كما هي عبر set_config_option
  await engine.start({
    prompt: 'مرحباً', sessionId: null, model: 'kimi-code/kimi-for-coding',
    permissionMode: 'default', skills: [], images: [], browserControl: false,
  }, root, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'result'));
  assert.deepStrictEqual(configRequests, [{
    sessionId: 'kimi_fullmodel_1', configId: 'model', value: 'kimi-code/kimi-for-coding',
  }]);
}

function testSecurityAndWiring() {
  const info = kimi.publicInfo();
  assert.strictEqual(info.name, 'kimi-code');
  assert.strictEqual(info.capabilities.native, true);
  assert.strictEqual(info.capabilities.contextUsage, true);
  assert.strictEqual(info.capabilities.compact, true);
  assert.strictEqual(info.capabilities.effort, false);
  assert.strictEqual(info.keyName, '');
  assert.deepStrictEqual(kimi._internals.selectedOutcome([
    { optionId: 'yes', kind: 'allow_once' },
  ], true, false), { outcome: 'selected', optionId: 'yes' });
  assert.strictEqual(kimi._internals.safeWritablePath(root, path.resolve(root, '..', 'outside.txt')), null);
  assert.strictEqual(kimi._internals.isEmbeddedMcpTool({ title: 'mcp__satr__browser_click' }, {}), true);
  assert.strictEqual(kimi._internals.isEmbeddedMcpTool({ title: 'mcp__satr__browser_click' }, null), false);
  assert.strictEqual(kimi._internals.isEmbeddedMcpTool({ title: 'browser_click' }, {}), false);
  assert.strictEqual(kimi._internals.isEmbeddedMcpTool({ title: 'mcp__external__browser_click' }, {}), false);

  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
  const sessions = fs.readFileSync(path.join(root, 'src', 'ui', 'components', 'sessions-panel.js'), 'utf8');
  assert.ok(main.includes("payload.engine === kimi.ENGINE_ID") && main.includes("kimi.start({"));
  assert.ok(main.includes("ipcMain.handle('satr:kimiStatus'") && main.includes("satr:listKimiSessions"));
  assert.ok(main.includes("ipcMain.handle('satr:kimiModels'") && preload.includes('kimiModels:'));
  assert.ok(app.includes('refreshKimiModels') && app.includes('kimiDynamicModels'));
  assert.ok(preload.includes('kimiStatus:') && preload.includes('readKimiSession:'));
  assert.ok(app.includes("resumeKimiSession(s)") && app.includes("checkKimiReady()"));
  assert.ok(main.includes('return kimi.contextUsage(dir, sid)'));
  assert.ok(preload.includes("contextUsage: (cwd, sessionId, engine)"));
  // المطلوب: بقاء kimi-code في قائمة محرّكات /سياق و/ضغط. القائمة تتسع بمحرّكات
  // أخرى (codex انضم في دفعة C2)، فلا نثبّت عناصرها حرفياً — نثبّت الشرط وحده.
  assert.ok(/engines: \['sdk', 'kimi-code'(?:, '[a-z-]+')*\]/.test(app));
  assert.ok(sessions.includes("kind: 'kimi'") && sessions.includes('listKimiSessions'));
  assert.ok(app.includes("ev.subtype === 'available_commands'") && app.includes('sendKimiCommand'));
  assert.ok(app.includes('kimiDeclaredCommands') && app.includes('buildKimiCommands') && app.includes('KIMI_CMD_EXCLUDE'));
  assert.ok(!app.includes("sendKimiCommand('/status')") && !app.includes("sendKimiCommand('/tasks')")
    && !app.includes("sendKimiCommand('/help')"));
  assert.ok(app.includes('awarenessThinking') && app.includes('THINKING_CYCLE'));
  assert.ok(main.includes("thinking: payload.thinking === 'on' ? 'on' : null"));
  assert.ok(main.includes('kimi._internals.loginCommand(bin)') && main.includes('kimi._internals.loginCwd(cwd)'));
  assert.ok(preload.includes('kimiLogin:'));
  // OBS-075: خريطة cwd الموثوقة تتغذّى من send/list المملوكين لـmain ويستهلكها معالج التفريع
  assert.ok(main.includes('const kimiSessionCwd = new Map()'));
  assert.ok(main.includes('function noteKimiSessionCwd(') && main.includes('function trustedKimiSessionCwd('));
  assert.ok(/ipcMain\.handle\('satr:listKimiSessions'[\s\S]{0,300}noteKimiSessionCwd/.test(main));
  assert.ok(main.includes('noteKimiSessionCwd(obj.session_id, cwd)'));
  assert.ok(main.includes("result.error === 'session_not_found'") && main.includes("'kimi_session_not_found'"));
  assert.ok(preload.includes('sessionFork: (sessionId, upToMessageId, title, engine)'));
}

// استخراج نصّي لمعالج satr:sessionFork الخاص بـKimi، مع mocks لما يحتاجه من main.js.
// يشمل خريطة kimiSessionCwd التي تملكها العملية الرئيسية (OBS-075) — cwd الموثوق
// يجب أن يأتي منها لا من الحمولة.
function loadKimiForkHandler(options = {}) {
  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  const safeSessionMatch = mainSource.match(/const SAFE_SESSION = [^\r\n]+;/);
  const mapStart = mainSource.indexOf('const kimiSessionCwd = new Map()');
  const start = mainSource.indexOf('async function handleKimiSessionForkRequest(');
  const end = mainSource.indexOf('async function handleRewindFilesRequest(', start);
  assert.ok(safeSessionMatch && mapStart >= 0 && mapStart < start && start >= 0 && end > start,
    'تعذّر استخراج معالج تفريع Kimi وخريطة cwd الموثوقة من main.js');

  const forkResult = options.forkResult || { ok: true, sessionId: 'kimi_fork_123', from: 'end' };
  const calls = [];
  const sandbox = {
    require,
    sessionmeta: { cleanTitle: sessionmeta.cleanTitle },
    kimi: {
      forkSession: async (args) => {
        calls.push(args);
        return forkResult;
      },
    },
    exported: {},
  };
  vm.runInNewContext(
    'const fs = require(\'fs\'); const path = require(\'path\');\n'
    + `${safeSessionMatch[0]}\n${mainSource.slice(mapStart, end)}\n`
    + 'Object.assign(exported, { handleKimiSessionForkRequest, noteKimiSessionCwd, trustedKimiSessionCwd });',
    sandbox,
    { filename: 'main-kimi-fork-extract.js' },
  );
  return {
    handler: sandbox.exported.handleKimiSessionForkRequest,
    calls,
    noteKimiSessionCwd: sandbox.exported.noteKimiSessionCwd,
    trustedKimiSessionCwd: sandbox.exported.trustedKimiSessionCwd,
  };
}

async function testMainForkLink() {
  const { handler, calls } = loadKimiForkHandler();

  // الحمولة كما يبنيها preload من وسائط app.js: upToMessageId فارغ يعني «من النهاية»
  const payload = {
    sessionId: 'kimi_session_1',
    upToMessageId: '',
    title: 'نسخة من جلسة',
    engine: 'kimi-code',
  };
  const result = await handler(payload);
  assert.strictEqual(result.ok, true, 'فراغ upToMessageId يجب ألا يفشل');
  assert.strictEqual(result.sessionId, 'kimi_fork_123');
  assert.strictEqual(calls.length, 1, 'لم تصل الحمولة إلى kimi.forkSession');
  assert.strictEqual(calls[0].sessionId, 'kimi_session_1');
  assert.strictEqual(calls[0].upToMessageId, undefined);
  assert.strictEqual(calls[0].title, 'نسخة من جلسة');

  calls.length = 0;
  const badMessage = {
    sessionId: 'kimi_session_1',
    upToMessageId: '../../evil',
    title: 'x',
    engine: 'kimi-code',
  };
  const badResult = await handler(badMessage);
  assert.strictEqual(badResult.ok, false, 'معرّف رسالة فاسد غير فارغ يُرفض');
  assert.strictEqual(badResult.error, 'invalid_message');
  assert.strictEqual(calls.length, 0, 'وصل طلب فاسد إلى kimi.forkSession');
}

// OBS-075 (أ): cwd التفريع يأتي من خريطة تملكها العملية الرئيسية فقط، لا من الحمولة.
async function testMainForkTrustedCwd() {
  const { handler, calls, noteKimiSessionCwd, trustedKimiSessionCwd } = loadKimiForkHandler();
  const payload = { sessionId: 'kimi_session_1', upToMessageId: '', title: 'فرع', engine: 'kimi-code' };

  // بلا مصدر موثوق في الخريطة: لا cwd يُمرَّر — السلوك القديم (السرد داخل kimi.js)
  let result = await handler(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cwd, undefined, 'بلا مصدر موثوق يجب أن يعود kimi.forkSession للسرد القديم');

  // إصابة الخريطة (كما تفعل main عند الإرسال/السرد) ⇒ cwd يصل forkSession مباشرة
  noteKimiSessionCwd('kimi_session_1', root);
  calls.length = 0;
  result = await handler(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1, 'مع cwd موثوق يجب أن يكون forkSession هو النداء الوحيد — لا سرد');
  assert.strictEqual(calls[0].cwd, root);

  // الحدّ الأمني غير القابل للتفاوض: حقن cwd في الحمولة من renderer يُتجاهل تماماً
  calls.length = 0;
  result = await handler({ ...payload, cwd: 'C:\\evil\\path' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls[0].cwd, root, 'cwd الحمولة من renderer يجب ألا يُقبل أبداً');

  // cwd مُخزَّن لمجلد لم يعد قائماً ⇒ لا يُمرَّر، ويعود السلوك القديم
  noteKimiSessionCwd('kimi_gone', path.join(root, 'no-such-dir-kimi-fork-test'));
  calls.length = 0;
  result = await handler({ ...payload, sessionId: 'kimi_gone' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls[0].cwd, undefined, 'cwd لمجلد مفقود يجب ألا يُمرَّر إلى forkSession');

  // معرّفات فاسدة تُرفض عند التسجيل: لا حقن مسارات عبر مفتاح الخريطة
  noteKimiSessionCwd('../../evil', root);
  noteKimiSessionCwd('kimi_rel', 'relative/not/absolute');
  assert.strictEqual(trustedKimiSessionCwd('../../evil'), null);
  assert.strictEqual(trustedKimiSessionCwd('kimi_rel'), null);
}

// OBS-075 (ب): غياب الجلسة من سرد Kimi ⇒ رمز مميّز ورسالة عربية مرشدة، بلا تسريب upstream.
async function testMainForkSessionNotFound() {
  const { handler } = loadKimiForkHandler({
    // كما يعيده kimi.forkSession تماماً عند غياب الجلسة من السرد (مع حقول داخلية خام)
    forkResult: { ok: false, error: 'session_not_found', upstream: 'raw upstream detail 0xdeadbeef' },
  });
  const result = await handler({
    sessionId: 'kimi_old_1', upToMessageId: '', title: 'فرع', engine: 'kimi-code',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'kimi_session_not_found',
    'غياب الجلسة من سرد Kimi يجب أن يرجع رمزاً مميّزاً لا kimi_fork_failed العام');
  assert.ok(result.message && result.message.includes('200'),
    'الرسالة المرشدة يجب أن تذكر سبباً محتملاً (سقف 200 جلسة في سرد Kimi)');
  assert.ok(!JSON.stringify(result).includes('raw upstream detail'),
    'نص خطأ upstream الخام تسرّب إلى renderer');
  assert.ok(!JSON.stringify(result).includes('kimi_fork_failed'),
    'الرمز العام خالف حالة الغياب المحدّدة');
}

// OBS-075 (ج): العدّ المقيس لعمليات `kimi acp` — مع cwd عملية واحدة، بلا cwd عمليتان.
async function testForkSessionProcessCount() {
  let directSpawns = 0;
  let directListSeen = 0;
  const directEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      directSpawns++;
      return new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/list') {
          directListSeen++;
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessions: [] } });
        } else if (message.method === 'session/fork') {
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_fork_fast' } });
        }
      });
    },
  });
  const fast = await directEngine.forkSession({ cwd: root, sessionId: 'kimi_session_1' });
  assert.deepStrictEqual(fast, { ok: true, sessionId: 'kimi_fork_fast', from: 'end' });
  assert.strictEqual(directSpawns, 1, 'مع cwd يجب أن تُطلق عملية kimi acp واحدة فقط (كانت اثنتين قبل OBS-075)');
  assert.strictEqual(directListSeen, 0, 'مع cwd يجب ألا يُسرد أي طلب session/list داخل العملية');

  // بلا cwd: السلوك القديم سليم — سرد (عملية) ثم تفريع (عملية) — أي لا تراجع
  let fallbackSpawns = 0;
  let fallbackListSeen = 0;
  let fallbackForkSeen = 0;
  const fallbackEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      fallbackSpawns++;
      return new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/list') {
          fallbackListSeen++;
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessions: [{ sessionId: 'kimi_session_1', cwd: root }] } });
        } else if (message.method === 'session/fork') {
          fallbackForkSeen++;
          proc.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi_fork_fb' } });
        }
      });
    },
  });
  const fallback = await fallbackEngine.forkSession({ sessionId: 'kimi_session_1' });
  assert.strictEqual(fallback.ok, true);
  assert.strictEqual(fallbackListSeen, 1, 'بلا cwd يجب أن يسبق التفريع سرد واحد');
  assert.strictEqual(fallbackForkSeen, 1);
  assert.strictEqual(fallbackSpawns, 2, 'بلا cwd تبقى عمليتان (سرد + تفريع) — أي عملية كاملة هباءً');

  // بلا cwd والجلسة خارج السرد: session_not_found من kimi.js نفسه بعد عملية السرد الواحدة
  let missingSpawns = 0;
  const missingEngine = kimi.create({
    resolveKimiBin: () => 'C:\\fake\\kimi.exe',
    spawn: () => {
      missingSpawns++;
      return new FakeProcess((message, proc) => {
        if (message.method === 'initialize') proc.send({ jsonrpc: '2.0', id: message.id, result: initializeResult() });
        else if (message.method === 'session/list') proc.send({ jsonrpc: '2.0', id: message.id, result: { sessions: [] } });
        else if (message.method === 'session/fork') {
          assert.fail('session/fork وصل رغم غياب الجلسة من السرد');
        }
      });
    },
  });
  const missing = await missingEngine.forkSession({ sessionId: 'kimi_session_1' });
  assert.deepStrictEqual(missing, { ok: false, error: 'session_not_found' });
  assert.strictEqual(missingSpawns, 1, 'عند غياب الجلسة تكفي عملية السرد الواحدة — لا تفريع بلا cwd');
}

(async () => {
  testSecurityAndWiring();
  await testNativeTurnAndPermission();
  await testBidirectionalRpcIdCollision();
  await testCancelThenResume();
  await testInteractiveQuestion();
  await testPlanModeLifecycle();
  await testReadTextFileLineLimit();
  await testKeepaliveReusesChannel();
  await testKeepaliveLateEvents();
  await testKeepaliveStopKeepsSession();
  await testKeepaliveEvictsOldest();
  await testSkillContextLiveRef();
  await testKeepaliveLeasedTurnSeesCurrentSkills();
  await testLoadFallbackDoesNotReplayHistory();
  await testSessionBrowser();
  await testModelCompactAndEffortContract();
  await testContextUsageCommand();
  await testForkSession();
  await testMainForkLink();
  await testMainForkTrustedCwd();
  await testMainForkSessionNotFound();
  await testForkSessionProcessCount();
  await testToolLabelsAndAvailableCommands();
  await testListModelsFromAcp();
  await testFullModelValueApplied();
  await testThinkingStream();
  await testThinkingTruncation();
  await testThinkingConfigOption();
  await testLanguageAnchorReachesKimi();
  await testStdinPipeErrorDoesNotEscape();
  testKimiLoginCommandAndCwd();
  console.log('✓ Kimi Code ACP مسجّل كمحرك أصيل مستقل عن REST');
  console.log('✓ طلبات ACP العكسية تكمل حتى عند تطابق معرّفها مع معرّف session/prompt');
  console.log('✓ الجلسة الجديدة والبث والأدوات والأذونات مطبّعة إلى عقد سطر');
  console.log('✓ الإيقاف يرسل session/cancel والاستمرار يستخدم session/resume بنفس المعرّف');
  console.log('✓ أسئلة Kimi التفاعلية تعبر عقد سطر وfallback التحميل لا يكرر التاريخ');
  console.log('✓ دورة Write → ExitPlanMode → تنفيذ تعمل وملف الخطة وحده مستثنى خارج المشروع');
  console.log('✓ fs/read_text_file يقرأ 2500 سطر كاملاً ويرفض الملفات الأكبر من 2MiB');
  console.log('✓ K2 keep-alive: الدور الثاني يستأجر القناة بلا spawn/initialize/session-new ولا cancel عند end_turn');
  console.log('✓ K2: الأحداث المتأخرة بين الأدوار تصل kimi_keepalive_event محجوبة ولا تدخل سجل المحادثة');
  console.log('✓ K2: إيقاف الدور يرسل session/cancel ويبقي الجلسة حية، والقتل الكامل من السجل فقط');
  console.log('✓ K2: سقف عمليتين حيتين يطرد الأقدم خمولاً عبر المحرك');
  console.log('✓ K3: المرجع الحي لسياق المهارات يقرأ الاختيار الحالي ولا يتسرّب القديم (مع توافق الكائن العادي)');
  console.log('✓ K3: الدور المستأجر يرى مهارات اختياره عبر extraTools المبنية في الدور الأول');
  console.log('✓ /جلسات يستخدم session/list وsession/load الرسميين');
  console.log('✓ سرد الجلسات يتصفح فوق 80 حتى سقف 200 وقراءتها تلتقط نداءات الأدوات بتسمياتها العربية وحالاتها');
  console.log('✓ اختيار K3 يضبط model عبر ACP و/ضغط يعرض compact_boundary دون نص تقني خام');
  console.log('✓ /سياق يقرأ /usage الرسمي، وجهد التفكير غير المعلن لا يُرسل إلى ACP');
  console.log('✓ OBS-048: تفريع الجلسة عبر session/fork ينظّف المدخلات ويعزل أخطاء upstream');
  console.log('✓ مسارات filesystem محصورة داخل مجلد المشروع ولا تتسرّب الأسرار للأحداث');
  console.log('✓ أدوات Kimi الداخلية تظهر بتسميات عربية وأوامر ACP المعلنة تصل الواجهة');
  console.log('✓ قائمة نماذج Kimi تُجلب من configOptions الرسمية وتُخزَّن مؤقتاً دون رمي عند الفشل');
  console.log('✓ اختيار نموذج بقيمته الكاملة (kimi-code/…) يُطبَّق عبر set_config_option');
  console.log('✓ غلاف ACP لأدوات MCP المدمجة يمر مرة واحدة دون إعفاء أداة خارجية');
  console.log('✓ التفكير الحي من Kimi ACP يُبثّ كـ stream_text/commentary ويُدمج في رسالة assistant');
  console.log('✓ التفكير الطويل يُقص عند سقف MAX_TOOL_TEXT والأسرار المحجوبة لا تتسرّب إليه');
  console.log('✓ خيار التفكير المعلن في configOptions يُطبَّق عبر session/set_config_option دون لمس config.toml');
  console.log('✓ OBS-023: المرساة اللغوية تصل Kimi آخرَ كتلة بصيغتها القوية، والمعزول خارجها');
  console.log('✓ OBS-052: انهيار الأنبوب في موضعَي spawn لا يسرّب استثناءً، والمستمع عند spawn لا لكل دور');
  console.log('✓ وصلة تفريع Kimi عبر preload: الفراغ يصل kimi.forkSession والمعرّف الفاسد يُرفض');
  console.log('✓ OBS-075: cwd التفريع من خريطة main الموثوقة فقط (لا من renderer) وبلا سرد إضافي');
  console.log('✓ OBS-075: غياب الجلسة من سرد Kimi يرجع kimi_session_not_found برسالة عربية بلا تسريب upstream');
  console.log('✓ OBS-075: العدّ المقيس — مع cwd عملية kimi acp واحدة، وبلا cwd تبقى السلسلة القديمة سليمة');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
