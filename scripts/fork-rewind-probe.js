#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEFORE = 'checkpoint-before\n';
const AFTER = 'checkpoint-after\n';
const MARKER = `FORK_OK_${Date.now()}`;
const SDK_VERSION = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
  'utf8',
)).version;

function globalClaudeBin() {
  const npmRoot = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules')
    : execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', executable);
  assert.ok(fs.existsSync(candidate), `لم يُعثر على claude CLI العالمي: ${candidate}`);
  return candidate;
}

function textFrom(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function withTimeout(promise, label, timeoutMs = 180000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`انتهت مهلة ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isRealMatchingUserMessage(message, nonce) {
  if (!message || message.type !== 'user' || message.isReplay || message.isSynthetic) return false;
  if (message.parent_tool_use_id != null || message.tool_use_result) return false;
  if (!SAFE_UUID.test(String(message.uuid || ''))) return false;
  const payload = message.message;
  return payload?.role === 'user' && textFrom(payload.content).includes(nonce);
}

function fileWasReported(filesChanged, targetFile, cwd) {
  if (!Array.isArray(filesChanged)) return false;
  const target = path.resolve(targetFile).toLowerCase();
  return filesChanged.some((entry) => {
    const raw = typeof entry === 'string' ? entry : entry?.path || entry?.filePath;
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const resolved = path.resolve(cwd, raw).toLowerCase();
    return resolved === target || path.basename(raw).toLowerCase() === path.basename(target).toLowerCase();
  });
}

async function rewindWithControlQuery({ sdk, cwd, sessionId, userMessageId, claudePath, dryRun }) {
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  async function* input() { await inputClosed; }
  const query = sdk.query({
    prompt: input(),
    options: {
      cwd,
      resume: sessionId,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      enableFileCheckpointing: true,
    },
  });
  const consume = (async () => {
    for await (const _ of query) { /* keep transport alive */ }
  })();
  try {
    return await withTimeout(
      query.rewindFiles(userMessageId, { dryRun: dryRun === true }),
      dryRun ? 'المعاينة عبر Query مستأنف' : 'الاسترجاع عبر Query مستأنف',
    );
  } finally {
    closeInput();
    try {
      await withTimeout(consume, 'إغلاق Query التحكم');
    } finally {
      query.close();
    }
  }
}

async function createCheckpointedSession({ sdk, cwd, filePath, claudePath, onSessionId }) {
  const nonce = `SATRFORK${Date.now()}${Math.random().toString(16).slice(2)}`;
  let sessionId = '';
  const userMessageId = randomUUID();
  let dryRun;
  let actualRewind;
  let queryEchoedUserMessage = false;
  let resultSubtype = '';
  const assistantEvents = [];
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  let resolveResult;
  let rejectResult;
  const resultReached = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  async function* input() {
    yield {
      type: 'user',
      uuid: userMessageId,
      session_id: '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: `Tracking nonce: ${nonce}. Read the file at ${filePath}, then use Write exactly once to replace it with exactly checkpoint-after followed by one newline. Then reply done.`,
      },
    };
    await inputClosed;
  }

  const query = sdk.query({
    prompt: input(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      tools: ['Read', 'Write'],
      allowedTools: ['Read', 'Write'],
      permissionMode: 'acceptEdits',
      canUseTool: async (toolName, input) => {
        assert.ok(['Read', 'Write'].includes(toolName), `أداة غير متوقعة في المسبار: ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      },
      enableFileCheckpointing: true,
      persistSession: true,
      maxTurns: 8,
      maxBudgetUsd: 1,
      model: 'sonnet',
    },
  });

  const consume = (async () => {
    for await (const message of query) {
      if (SAFE_UUID.test(String(message?.session_id || '')) && message.session_id !== sessionId) {
        sessionId = message.session_id;
        if (typeof onSessionId === 'function') onSessionId(sessionId);
      }
      if (isRealMatchingUserMessage(message, nonce)) queryEchoedUserMessage = true;
      if (message?.type === 'assistant' && Array.isArray(message.message?.content)) {
        assistantEvents.push(...message.message.content.map((part) => ({
          type: part?.type,
          name: part?.name,
          text: typeof part?.text === 'string' ? part.text.slice(0, 240) : undefined,
          input: part?.type === 'tool_use' ? part.input : undefined,
        })));
      }
      if (message?.type === 'result') {
        resultSubtype = String(message.subtype || '');
        resolveResult();
      }
    }
  })().catch((error) => {
    rejectResult(error);
    throw error;
  });

  let sourceClosed = false;
  async function closeSourceQuery() {
    if (sourceClosed) return;
    sourceClosed = true;
    closeInput();
    try {
      await withTimeout(consume, 'إغلاق مجرى المصدر');
    } finally {
      query.close();
    }
  }

  try {
    await withTimeout(resultReached, 'دور إنشاء نقطة الاسترجاع');
    assert.match(sessionId, SAFE_UUID, 'لم يُلتقط UUID جلسة المصدر');
    assert.match(userMessageId, SAFE_UUID, 'لم يُلتقط UUID رسالة المستخدم من SDKUserMessage.uuid');
    if ((await fsp.readFile(filePath, 'utf8')) !== AFTER) {
      console.error(JSON.stringify({ resultSubtype, assistantEvents }, null, 2));
    }
    assert.equal(
      await fsp.readFile(filePath, 'utf8'),
      AFTER,
      `لم يكتب Claude المحتوى المتوقع (result=${resultSubtype || 'none'})`,
    );

    await closeSourceQuery();
    const transcript = await sdk.getSessionMessages(sessionId, { dir: cwd });
    const persistedUser = transcript.find((message) => message.type === 'user' && message.uuid === userMessageId);
    assert.ok(persistedUser, 'لم يحفظ CLI قيمة SDKUserMessage.uuid في سجل الجلسة');

    dryRun = await rewindWithControlQuery({
      sdk, cwd, sessionId, userMessageId, claudePath, dryRun: true,
    });
    assert.equal(dryRun?.canRewind, true, `تعذرت المعاينة الجافة: ${dryRun?.error || 'unknown'}`);
    assert.ok(fileWasReported(dryRun.filesChanged, filePath, cwd), 'لم تُبلغ المعاينة عن probe.txt');
    assert.ok(Number.isInteger(dryRun.insertions) && dryRun.insertions >= 0, 'insertions غير صحيحة');
    assert.ok(Number.isInteger(dryRun.deletions) && dryRun.deletions >= 0, 'deletions غير صحيحة');
    assert.ok(dryRun.insertions + dryRun.deletions > 0, 'إحصاءات المعاينة صفرية');
    assert.equal(await fsp.readFile(filePath, 'utf8'), AFTER, 'غيّرت dryRun الملف');

    actualRewind = await rewindWithControlQuery({
      sdk, cwd, sessionId, userMessageId, claudePath, dryRun: false,
    });
    assert.equal(actualRewind?.canRewind, true, `تعذر الاسترجاع: ${actualRewind?.error || 'unknown'}`);
    assert.equal(await fsp.readFile(filePath, 'utf8'), BEFORE, 'لم يستعد الملف محتواه الأصلي');

    return {
      sessionId,
      userMessageId,
      dryRun,
      actualRewind,
      queryEchoedUserMessage,
      resultSubtype,
    };
  } finally {
    await closeSourceQuery().catch(() => {});
  }
}

async function resumeFork({ sdk, cwd, sessionId, claudePath }) {
  let response = '';
  let observedSessionId = '';
  let resultSubtype = '';
  const query = sdk.query({
    prompt: `أجب بالنص ${MARKER} فقط دون أي إضافة.`,
    options: {
      cwd,
      resume: sessionId,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      allowedTools: [],
      maxTurns: 2,
      maxBudgetUsd: 0.2,
      model: 'sonnet',
    },
  });

  try {
    for await (const message of query) {
      if (SAFE_UUID.test(String(message?.session_id || ''))) observedSessionId = message.session_id;
      if (message?.type === 'assistant') response += textFrom(message.message?.content);
      if (message?.type === 'result') resultSubtype = String(message.subtype || '');
    }

    assert.equal(observedSessionId, sessionId, 'أعاد الاستئناف معرّف جلسة مختلفاً عن الفرع');
    assert.equal(resultSubtype, 'success', `فشل استئناف الفرع: ${resultSubtype || 'no-result'}`);
    return { response: response.trim(), observedSessionId, resultSubtype };
  } finally {
    query.close();
  }
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudePath = globalClaudeBin();
  const cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8' }).trim();
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-fork-rewind-'));
  const filePath = path.join(cwd, 'probe.txt');
  const createdSessions = [];

  try {
    await fsp.writeFile(filePath, BEFORE, 'utf8');
    const source = await createCheckpointedSession({
      sdk,
      cwd,
      filePath,
      claudePath,
      onSessionId: (sessionId) => {
        if (!createdSessions.includes(sessionId)) createdSessions.push(sessionId);
      },
    });

    const fork = await withTimeout(
      sdk.forkSession(source.sessionId, {
        upToMessageId: source.userMessageId,
        title: 'Satr fork rewind probe',
      }),
      'إنشاء الفرع',
    );

    if (SAFE_UUID.test(String(fork?.sessionId || '')) && !createdSessions.includes(fork.sessionId)) {
      createdSessions.push(fork.sessionId);
    }
    assert.match(String(fork?.sessionId || ''), SAFE_UUID, 'forkSession لم تُرجع UUID صالحاً');
    assert.notEqual(fork.sessionId, source.sessionId, 'forkSession أعادت الجلسة الأصلية');
    const forkResume = await withTimeout(
      resumeFork({ sdk, cwd, sessionId: fork.sessionId, claudePath }),
      'استئناف الفرع',
    );

    console.log(JSON.stringify({
      ok: true,
      sdkVersion: SDK_VERSION,
      cliVersion,
      sourceSessionId: source.sessionId,
      userMessageId: source.userMessageId,
      userMessageSource: 'SDKUserMessage.uuid',
      transcriptUuidMatched: true,
      queryEchoedUserMessage: source.queryEchoedUserMessage,
      sourceResultSubtype: source.resultSubtype,
      forkSessionId: fork.sessionId,
      forkResumed: forkResume.observedSessionId === fork.sessionId && forkResume.resultSubtype === 'success',
      forkReturnedMarker: forkResume.response.includes(MARKER),
      dryRun: {
        canRewind: source.dryRun.canRewind,
        filesChanged: source.dryRun.filesChanged?.length || 0,
        insertions: source.dryRun.insertions,
        deletions: source.dryRun.deletions,
      },
      actualRewind: {
        canRewind: source.actualRewind.canRewind,
        filesChanged: source.actualRewind.filesChanged?.length || 0,
        insertions: source.actualRewind.insertions,
        deletions: source.actualRewind.deletions,
      },
      restoredExactly: (await fsp.readFile(filePath, 'utf8')) === BEFORE,
    }, null, 2));
  } finally {
    for (const sessionId of createdSessions.reverse()) {
      try {
        await sdk.deleteSession(sessionId);
      } catch {}
    }
    try {
      await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    } catch (cleanupError) {
      console.error(`تعذر تنظيف مجلد المسبار مؤقتاً: ${cleanupError.message}`);
    }
  }
}

main().catch((error) => {
  console.error(`fork-rewind-probe فشل: ${error?.stack || error}`);
  process.exitCode = 1;
});
