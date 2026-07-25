#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SECRET_SENTINEL = 'SECRET_SHOULD_NEVER_LEAK';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadMainContract() {
  const source = read('electron/main.js');
  const safeModel = source.match(/const SAFE_MODEL = [^\r\n]+;/);
  const start = source.indexOf('function cleanClaudePublicText(');
  const end = source.indexOf('// سياسة نماذج غرفة العمليات', start);
  assert.ok(safeModel && start >= 0 && end > start, 'تعذّر استخراج عقد Claude العام من main.js');
  const sandbox = {
    os: { homedir: () => 'C:\\Users\\safe-user' },
    agent: {},
    exported: {},
  };
  vm.runInNewContext(`
    ${safeModel[0]}
    ${source.slice(start, end)}
    Object.assign(exported, {
      cleanClaudePublicText,
      sanitizeClaudeModelsResult,
      sanitizeClaudeAccountResult,
      sanitizeClaudeFallbackModel,
      handleClaudeModelsRequest,
      handleClaudeAccountRequest,
    });
  `, sandbox, { filename: 'main-claude-models-extract.js' });
  return sandbox.exported;
}

function loadUiModelSelector() {
  const source = read('src/ui/app.js');
  const modelsStart = source.indexOf('  const CLAUDE_MODELS = [');
  const modelsEnd = source.indexOf('  // احتياط حديث فقط', modelsStart);
  const functionStart = source.indexOf('  function modelsForEngine(engine) {');
  const functionEnd = source.indexOf('  function engineSupportsVision(', functionStart);
  assert.ok(modelsStart >= 0 && modelsEnd > modelsStart && functionStart >= 0 && functionEnd > functionStart,
    'تعذّر استخراج fallback نماذج Claude من app.js');
  const sandbox = { exported: {} };
  vm.runInNewContext(`
    ${source.slice(modelsStart, modelsEnd)}
    let claudeDynamicModels = [];
    let codexDynamicModels = [];
    let kimiDynamicModels = [];
    let providersCache = [];
    ${source.slice(functionStart, functionEnd)}
    exported.staticModels = CLAUDE_MODELS;
    exported.modelsForEngine = modelsForEngine;
    exported.setDynamic = (models) => { claudeDynamicModels = models; };
  `, sandbox, { filename: 'ui-claude-models-extract.js' });
  return sandbox.exported;
}

async function testMetadataCache() {
  const { createClaudeMetadataClient } = require('../electron/agent');
  let clock = 0;
  let controlQueries = 0;
  let supportedCalls = 0;
  let accountCalls = 0;
  const client = createClaudeMetadataClient({
    now: () => clock,
    ttlMs: 120000,
    controlQuery: async (cwd, sessionId, callback) => {
      controlQueries++;
      assert.equal(cwd, 'C:\\project');
      assert.equal(sessionId, null);
      return callback({
        async supportedModels() {
          supportedCalls++;
          await Promise.resolve();
          return [{
            value: 'sonnet', displayName: 'Sonnet', description: 'متوازن',
            capabilities: { secret: SECRET_SENTINEL },
          }];
        },
        async accountInfo() {
          accountCalls++;
          await Promise.resolve();
          return {
            email: 'user@example.com', organization: 'Example', subscriptionType: 'pro',
            tokenSource: SECRET_SENTINEL, apiKeySource: SECRET_SENTINEL, apiProvider: 'hidden',
          };
        },
      });
    },
  });

  const [models, account] = await Promise.all([
    client.models('C:\\project'),
    client.account('C:\\project'),
  ]);
  assert.equal(controlQueries, 1, 'لم تتشارك طلبات النماذج والحساب تشغيل control عابراً واحداً');
  assert.equal(supportedCalls, 1);
  assert.equal(accountCalls, 1);
  assert.deepEqual(Object.keys(models.models[0]).sort(), ['description', 'displayName', 'value']);
  assert.deepEqual(Object.keys(account.account).sort(), ['email', 'organization', 'subscriptionType']);
  assert.ok(!JSON.stringify({ models, account }).includes(SECRET_SENTINEL), 'تسرّب حقل سري من agent metadata');

  clock = 119999;
  await client.models('C:\\project');
  assert.equal(controlQueries, 1, 'انتهى كاش الدقيقتين مبكراً');
  clock = 120000;
  await client.account('C:\\project');
  assert.equal(controlQueries, 2, 'لم يتجدد كاش Claude عند حد 120000ms');
  assert.equal(supportedCalls, 2);
  assert.equal(accountCalls, 2);

  let failures = 0;
  const failing = createClaudeMetadataClient({
    now: () => clock,
    ttlMs: 120000,
    controlQuery: async () => {
      failures++;
      throw new Error(SECRET_SENTINEL);
    },
  });
  const failedModels = await failing.models('C:\\project');
  const failedAccount = await failing.account('C:\\project');
  assert.equal(failures, 1, 'لم يُخزّن فشل metadata مؤقتاً');
  assert.equal(failedModels.ok, false);
  assert.equal(failedAccount.ok, false);
  assert.match(failedModels.message, /تعذّر/);
  assert.ok(!JSON.stringify({ failedModels, failedAccount }).includes(SECRET_SENTINEL), 'تسرّب خطأ SDK الخام');
}

async function testMainSanitization() {
  const contract = loadMainContract();
  const rawModels = [
    {
      value: '  sonnet  ',
      displayName: '  Sonnet\u202e\n 5  ',
      description: 'د'.repeat(260),
      tokenSource: SECRET_SENTINEL,
    },
    { value: 'opus[1m]', displayName: SECRET_SENTINEL, description: SECRET_SENTINEL },
    { value: 'sonnet', displayName: 'مكرر', description: 'مكرر' },
    ...Array.from({ length: 15 }, (_, index) => ({
      value: `model-${index}`, displayName: `Model ${index}`, description: `Description ${index}`,
    })),
  ];
  const modelResult = plain(await contract.handleClaudeModelsRequest({
    async claudeModels(cwd) {
      assert.equal(cwd, 'C:\\Users\\safe-user');
      return { ok: true, models: rawModels, internalId: SECRET_SENTINEL };
    },
  }));
  assert.equal(modelResult.ok, true);
  assert.equal(modelResult.models.length, 12, 'لم يُطبّق سقف 12 نموذجاً');
  assert.deepEqual(modelResult.models[0], {
    value: 'sonnet', label: 'Sonnet 5', description: 'د'.repeat(240),
  });
  for (const model of modelResult.models) {
    assert.match(model.value, /^[A-Za-z0-9./-]{1,64}$/);
    assert.deepEqual(Object.keys(model).sort(), ['description', 'label', 'value']);
  }
  assert.ok(!modelResult.models.some((model) => model.value.includes('[')), 'عبر نموذج لا يطابق SAFE_MODEL');
  assert.ok(!JSON.stringify(modelResult).includes(SECRET_SENTINEL), 'تسرّب حقل نموذج غير معلن');

  const accountResult = plain(await contract.handleClaudeAccountRequest({
    async claudeAccount(cwd) {
      assert.equal(cwd, 'C:\\Users\\safe-user');
      return {
        ok: true,
        account: {
          email: '  user@example.com\u202e\n ',
          organization: '  Example\u0000 Organization  ',
          subscriptionType: '  pro\n plan  ',
          tokenSource: SECRET_SENTINEL,
          apiKeySource: SECRET_SENTINEL,
          apiProvider: SECRET_SENTINEL,
          internalId: SECRET_SENTINEL,
        },
      };
    },
  }));
  assert.deepEqual(accountResult, {
    ok: true,
    email: 'user@example.com',
    organization: 'Example Organization',
    subscriptionType: 'pro plan',
  });
  assert.ok(!JSON.stringify(accountResult).includes(SECRET_SENTINEL), 'تسرّب سر أو معرّف داخلي من حساب Claude');

  const failure = plain(await contract.handleClaudeAccountRequest({
    async claudeAccount() { throw new Error(SECRET_SENTINEL); },
  }));
  assert.deepEqual(failure, { ok: false });
  assert.equal(contract.sanitizeClaudeFallbackModel('default', 'sonnet'), 'default');
  assert.equal(contract.sanitizeClaudeFallbackModel('sonnet', 'sonnet'), null);
  assert.equal(contract.sanitizeClaudeFallbackModel('opus[1m]', 'sonnet'), null);
  assert.equal(contract.sanitizeClaudeFallbackModel(' sonnet ', null), null);
}

function testFallbackIsolation() {
  const { applyClaudeFallbackModel } = require('../electron/agent');
  const normal = {};
  assert.equal(applyClaudeFallbackModel(normal, 'opus', 'sonnet', null), true);
  assert.equal(normal.fallbackModel, 'sonnet');

  for (const policy of [
    { mode: 'text-only' },
    { mode: 'read-only-planner' },
    { mode: 'ops-room' },
  ]) {
    const options = {};
    assert.equal(applyClaudeFallbackModel(options, 'opus', 'sonnet', policy), false);
    assert.ok(!Object.hasOwn(options, 'fallbackModel'), `وصل fallbackModel إلى ${policy.mode}`);
  }
  for (const fallback of ['', 'opus', 'opus[1m]', 'bad model', 'a'.repeat(65)]) {
    const options = {};
    assert.equal(applyClaudeFallbackModel(options, 'opus', fallback, null), false);
    assert.ok(!Object.hasOwn(options, 'fallbackModel'));
  }

  const agentSource = read('electron/agent.js');
  assert.match(agentSource, /applyClaudeFallbackModel\(options, model, fallbackModel, internalPolicy\);/);
  const mainSource = read('electron/main.js');
  assert.match(mainSource, /fallbackModel: sanitizeClaudeFallbackModel|const fallbackModel = sanitizeClaudeFallbackModel/);
}

function testUiAndIpcContracts() {
  const ui = loadUiModelSelector();
  const staticModels = plain(ui.modelsForEngine('sdk'));
  assert.deepEqual(staticModels, plain(ui.staticModels), 'لم تسقط واجهة SDK إلى CLAUDE_MODELS عند غياب الديناميكية');
  const dynamic = [{ value: 'sonnet', label: 'Sonnet ديناميكي', description: 'live' }];
  ui.setDynamic(dynamic);
  assert.deepEqual(plain(ui.modelsForEngine('sdk')), dynamic, 'لم تفضّل واجهة SDK القائمة الديناميكية');

  const appSource = read('src/ui/app.js');
  const htmlSource = read('src/index.html');
  const preloadSource = read('electron/preload.js');
  const mainSource = read('electron/main.js');
  assert.match(appSource, /window\.satr\.claudeModels\(\)/);
  assert.match(appSource, /catch \(e\) \{ \/\* تبقى قائمة Claude الثابتة \*\//);
  assert.match(appSource, /localStorage\.getItem\('satr_fallback_model'\)/);
  assert.match(appSource, /fallbackModel: engine === 'sdk' \? \$\('fallbackModel'\)\.value : ''/);
  assert.match(appSource, /window\.satr\.claudeAccount\(\)/);
  assert.match(appSource, /مسجّل الدخول: /);
  assert.match(appSource, /queueMicrotask\(\(\) => \{ if \(!\$\('settingsPop'\)\.hidden\) refreshClaudeAccountView\(\); \}\)/);
  assert.match(htmlSource, /نموذج احتياطي عند انشغال النموذج/);
  assert.match(htmlSource, /<option value="">بلا<\/option>/);
  assert.match(htmlSource, /id="claudeAccountEmail"/);
  assert.doesNotMatch(htmlSource.slice(htmlSource.indexOf('id="claudeAccountSection"'), htmlSource.indexOf('id="activitySection"')), /token|secret|apiKey|internalId/i);
  assert.match(preloadSource, /claudeModels: \(\) => ipcRenderer\.invoke\('satr:claudeModels'\)/);
  assert.match(preloadSource, /claudeAccount: \(\) => ipcRenderer\.invoke\('satr:claudeAccount'\)/);
  assert.match(mainSource, /ipcMain\.handle\('satr:claudeModels', \(\) => handleClaudeModelsRequest\(\)\)/);
  assert.match(mainSource, /ipcMain\.handle\('satr:claudeAccount', \(\) => handleClaudeAccountRequest\(\)\)/);
}

function testProbeContract() {
  const source = read('scripts/claude-models-probe.js');
  assert.ok(source.includes('Promise.all([query.supportedModels(), query.accountInfo()])'));
  assert.match(source, /fallbackModel/);
  assert.match(source, /responseLength/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(account\.email|account\.organization|account\.subscriptionType)/);
}

(async () => {
  await testMetadataCache();
  await testMainSanitization();
  testFallbackIsolation();
  testUiAndIpcContracts();
  testProbeContract();
  console.log('claude-models-test: OK — cache/IPC/allowlist/UI fallback/internal isolation');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
