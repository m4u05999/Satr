#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SAFE_MODEL = /^[A-Za-z0-9./-]{1,64}$/;
const TIMEOUT_MS = 180000;
const SDK_VERSION = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
  'utf8',
)).version;

function globalClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const npmRoot = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules')
    : execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', executable);
  assert.ok(fs.existsSync(candidate), `لم يُعثر على claude CLI العالمي: ${candidate}`);
  return candidate;
}

function withTimeout(promise, label, timeoutMs = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`انتهت مهلة ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function textFrom(message) {
  const content = message && message.message && message.message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

async function readMetadata(sdk, cwd, claudePath) {
  let closeInput;
  const inputClosed = new Promise((resolve) => { closeInput = resolve; });
  async function* input() { await inputClosed; }
  const query = sdk.query({
    prompt: input(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: ['user', 'project', 'local'],
    },
  });
  const consume = (async () => {
    try { for await (const _ of query) { /* إبقاء قناة التحكم حيّة */ } } catch { /* إغلاق */ }
  })();
  try {
    const [models, account] = await withTimeout(
      Promise.all([query.supportedModels(), query.accountInfo()]),
      'قراءة النماذج والحساب',
    );
    return { models, account, controlQueries: 1 };
  } finally {
    closeInput();
    try {
      await withTimeout(consume, 'إغلاق Query التحكم', 10000);
    } finally {
      query.close();
    }
  }
}

async function runFallbackTurn(sdk, cwd, claudePath, primaryModel, fallbackModel) {
  let finalText = '';
  let resultText = '';
  let resultSubtype = '';
  const query = sdk.query({
    prompt: 'أجب بجملة عربية قصيرة تؤكد أن الدور اكتمل.',
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      tools: [],
      persistSession: false,
      maxTurns: 2,
      maxBudgetUsd: 0.3,
      model: primaryModel,
      fallbackModel,
    },
  });
  try {
    for await (const message of query) {
      if (message && message.type === 'assistant') finalText += textFrom(message);
      if (message && message.type === 'result') {
        resultSubtype = String(message.subtype || '');
        resultText = typeof message.result === 'string' ? message.result : '';
      }
    }
  } finally {
    query.close();
  }
  const response = finalText + '\n' + resultText;
  return { resultSubtype, responseLength: response.length };
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudePath = globalClaudeBin();
  const cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8' }).trim();
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'satr-claude-models-'));

  try {
    const metadata = await readMetadata(sdk, cwd, claudePath);
    assert.ok(Array.isArray(metadata.models), 'supportedModels() لم تُعد مصفوفة');
    assert.ok(metadata.models.length > 1, 'يلزم نموذجان على الأقل لإثبات fallbackModel');
    for (const model of metadata.models) {
      assert.equal(typeof (model && model.value), 'string', 'ModelInfo.value ليس نصاً');
      assert.equal(typeof model.displayName, 'string', 'ModelInfo.displayName ليس نصاً');
      assert.equal(typeof model.description, 'string', 'ModelInfo.description ليس نصاً');
    }
    assert.ok(metadata.account && typeof metadata.account === 'object' && !Array.isArray(metadata.account),
      'accountInfo() لم تُعد كائناً');

    const safeModels = metadata.models.filter((model) => SAFE_MODEL.test(model.value));
    const preferred = process.env.SATR_CLAUDE_MODELS_PROBE_MODEL;
    const primary = (preferred && safeModels.find((model) => model.value === preferred))
      || safeModels.find((model) => /haiku/i.test(model.value))
      || safeModels[0];
    const fallback = safeModels.find((model) => model.value !== primary.value);
    assert.ok(primary && fallback, 'لم تتوفر قيمتان صالحتان ومختلفتان لاختبار fallbackModel');

    const turn = await withTimeout(
      runFallbackTurn(sdk, cwd, claudePath, primary.value, fallback.value),
      'الدور العادي مع fallbackModel',
    );
    assert.equal(turn.resultSubtype, 'success', `فشل الدور العادي: ${turn.resultSubtype || 'no-result'}`);
    assert.ok(turn.responseLength > 1, 'نجح الدور بلا نص نتيجة');

    const accountKeys = Object.keys(metadata.account).sort();
    console.log(JSON.stringify({
      ok: true,
      sdkVersion: SDK_VERSION,
      cliVersion,
      controlQueries: metadata.controlQueries,
      modelCount: metadata.models.length,
      modelFields: [...new Set(metadata.models.flatMap((model) => Object.keys(model)))].sort(),
      models: metadata.models.map((model) => ({
        value: model.value,
        displayName: model.displayName,
        descriptionLength: model.description.length,
      })),
      accountKeys,
      accountPublicFieldsPresent: {
        email: typeof metadata.account.email === 'string' && metadata.account.email.length > 0,
        organization: typeof metadata.account.organization === 'string' && metadata.account.organization.length > 0,
        subscriptionType: typeof metadata.account.subscriptionType === 'string' && metadata.account.subscriptionType.length > 0,
      },
      primaryModel: primary.value,
      fallbackModel: fallback.value,
      fallbackTurn: turn,
    }, null, 2));
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(`claude-models-probe فشل: ${error && error.stack || error}`);
  process.exitCode = 1;
});