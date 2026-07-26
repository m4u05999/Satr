'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const kimi = require('../electron/kimi');

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

class FakeProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.lines = [];
    this.stdin = {
      write: (line) => {
        const message = JSON.parse(String(line).trim());
        this.lines.push(message);
        handler(message, this);
        return true;
      },
      end: () => {},
    };
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
  assert.ok(app.includes("engines: ['sdk', 'kimi-code']"));
  assert.ok(sessions.includes("kind: 'kimi'") && sessions.includes('listKimiSessions'));
  assert.ok(app.includes("ev.subtype === 'available_commands'") && app.includes('sendKimiCommand'));
  assert.ok(app.includes('kimiDeclaredCommands') && app.includes('buildKimiCommands') && app.includes('KIMI_CMD_EXCLUDE'));
  assert.ok(!app.includes("sendKimiCommand('/status')") && !app.includes("sendKimiCommand('/tasks')")
    && !app.includes("sendKimiCommand('/help')"));
  assert.ok(app.includes('awarenessThinking') && app.includes('THINKING_CYCLE'));
  assert.ok(main.includes("thinking: payload.thinking === 'on' ? 'on' : null"));
  assert.ok(main.includes('kimi._internals.loginCommand(bin)') && main.includes('kimi._internals.loginCwd(cwd)'));
  assert.ok(preload.includes('kimiLogin:'));
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
  await testLoadFallbackDoesNotReplayHistory();
  await testSessionBrowser();
  await testModelCompactAndEffortContract();
  await testContextUsageCommand();
  await testToolLabelsAndAvailableCommands();
  await testListModelsFromAcp();
  await testFullModelValueApplied();
  await testThinkingStream();
  await testThinkingTruncation();
  await testThinkingConfigOption();
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
  console.log('✓ /جلسات يستخدم session/list وsession/load الرسميين');
  console.log('✓ سرد الجلسات يتصفح فوق 80 حتى سقف 200 وقراءتها تلتقط نداءات الأدوات بتسمياتها العربية وحالاتها');
  console.log('✓ اختيار K3 يضبط model عبر ACP و/ضغط يعرض compact_boundary دون نص تقني خام');
  console.log('✓ /سياق يقرأ /usage الرسمي، وجهد التفكير غير المعلن لا يُرسل إلى ACP');
  console.log('✓ مسارات filesystem محصورة داخل مجلد المشروع ولا تتسرّب الأسرار للأحداث');
  console.log('✓ أدوات Kimi الداخلية تظهر بتسميات عربية وأوامر ACP المعلنة تصل الواجهة');
  console.log('✓ قائمة نماذج Kimi تُجلب من configOptions الرسمية وتُخزَّن مؤقتاً دون رمي عند الفشل');
  console.log('✓ اختيار نموذج بقيمته الكاملة (kimi-code/…) يُطبَّق عبر set_config_option');
  console.log('✓ غلاف ACP لأدوات MCP المدمجة يمر مرة واحدة دون إعفاء أداة خارجية');
  console.log('✓ التفكير الحي من Kimi ACP يُبثّ كـ stream_text/commentary ويُدمج في رسالة assistant');
  console.log('✓ التفكير الطويل يُقص عند سقف MAX_TOOL_TEXT والأسرار المحجوبة لا تتسرّب إليه');
  console.log('✓ خيار التفكير المعلن في configOptions يُطبَّق عبر session/set_config_option دون لمس config.toml');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
