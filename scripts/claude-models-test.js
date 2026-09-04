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

// منتقي الجهد الفعلي من app.js داخل DOM مصغّر (OBS-063 مرشّح أ). الاستخراج من المصدر
// لا نسخة موازية: أي انحراف في rebuildEfforts يكسر الاختبار بدل أن يمرّ صامتاً.
function loadUiEffortSelector() {
  const source = read('src/ui/app.js');
  const cycleStart = source.indexOf('  const EFFORT_CYCLE = ');
  const cycleEnd = source.indexOf('  const PERMISSION_CYCLE = ', cycleStart);
  const shortStart = source.indexOf('  function effortShort(value) {');
  const shortEnd = source.indexOf('  function syncAwareness() {', shortStart);
  const start = source.indexOf('  function declaredEffortLevels() {');
  const end = source.indexOf('  function rebuildModels() {', start);
  assert.ok(cycleStart >= 0 && cycleEnd > cycleStart && shortStart >= 0 && shortEnd > shortStart
    && start >= 0 && end > start, 'تعذّر استخراج منتقي الجهد من app.js');

  // محاكاة <select> بدلالة HTML: قيمة بلا خيار مقابل تُفرغ الحقل (وهو مصدر السقوط)
  class FakeSelect {
    constructor(initial) {
      this.options = [];
      for (const value of initial || []) this.appendChild({ value, textContent: value });
      this.value = '';
    }
    set innerHTML(_) { this.options = []; this._value = ''; }
    appendChild(option) {
      this.options.push(option);
      if (this.options.length === 1) this.value = option.value;
    }
  }
  // .value = x تمر بدلالة HTML: تُقبل إن وُجد خيار مقابل وإلا يفرغ الحقل
  Object.defineProperty(FakeSelect.prototype, 'value', {
    get() { return this._value || ''; },
    set(next) {
      this._value = (this.options || []).some((option) => option.value === next) ? next : '';
    },
  });

  // الخيارات الأولية من ترميز index.html نفسه لا من نسخة موازية — فأي انحراف بين
  // الترميز وEFFORT_CYCLE يظهر هنا بدل أن يمرّ صامتاً
  const markup = read('src/index.html');
  const selectStart = markup.indexOf('<select id="effort"');
  const selectEnd = markup.indexOf('</select>', selectStart);
  assert.ok(selectStart >= 0 && selectEnd > selectStart, 'تعذّر استخراج منتقي الجهد من index.html');
  const initialOptions = [...markup.slice(selectStart, selectEnd).matchAll(/<option value="([^"]*)"/g)]
    .map((match) => match[1]);
  assert.ok(initialOptions.length >= 2 && initialOptions[0] === '', 'ترميز منتقي الجهد بلا خيار افتراضي أولاً');

  const elements = { effort: new FakeSelect(initialOptions), engine: { value: 'sdk' }, model: { value: '' } };
  const notices = [];
  const sandbox = {
    exported: {},
    notices,
    document: { createElement: () => ({ value: '', textContent: '' }) },
  };
  vm.runInNewContext(`
    const $ = (id) => elements[id];
    const addNotice = (text) => { notices.push(text); };
    let claudeDynamicModels = [];
    let codexDynamicModels = [];
    ${source.slice(cycleStart, cycleEnd)}
    ${source.slice(shortStart, shortEnd)}
    ${source.slice(start, end)}
    exported.rebuildEfforts = rebuildEfforts;
    exported.EFFORT_CYCLE = EFFORT_CYCLE;
    exported.setClaude = (models) => { claudeDynamicModels = models; };
    exported.setCodex = (models) => { codexDynamicModels = models; };
  `, Object.assign(sandbox, { elements }), { filename: 'ui-effort-extract.js' });
  return Object.assign(sandbox.exported, { elements, notices });
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
            supportsEffort: true, supportedEffortLevels: ['low', 'high'],
            supportsFastMode: true, supportsAutoMode: true, supportsAdaptiveThinking: true,
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
  // resolvedModel وحقلا الجهد يمران من agent إلى main عمداً (التسمية الرسمية 2026-09-03،
  // ومستويات الجهد OBS-063 مرشّح أ)؛ فحص عدم بلوغهم renderer في testMainSanitization أدناه.
  // البقية — supportsFastMode/supportsAutoMode/supportsAdaptiveThinking — تُسقط هنا لأن
  // لا مستهلك لها (مرشّح ب مؤجّل: حقل مجمَّد بلا مستهلك عيب لا ميزة).
  assert.deepEqual(Object.keys(models.models[0]).sort(),
    ['description', 'displayName', 'resolvedModel', 'supportedEffortLevels', 'supportsEffort', 'value']);
  assert.deepEqual(models.models[0].supportedEffortLevels, ['low', 'high']);
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
    // لاحقة [1m] صارت مقبولة (قرار مالك 2026-07-27)؛ الصيغ المقوّسة الأخرى تبقى مرفوضة
    { value: 'opus[1m]', displayName: 'Opus 1M', description: 'نافذة مليون رمز' },
    { value: 'opus[2m]', displayName: SECRET_SENTINEL, description: SECRET_SENTINEL },
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
  }, 'نموذج بلا حقول جهد لم يعد بالعقد القديم حرفياً');
  for (const model of modelResult.models) {
    assert.match(model.value, /^[A-Za-z0-9./-]{1,64}(\[1m\])?$/);
    assert.deepEqual(Object.keys(model).sort(), ['description', 'label', 'value']);
  }
  assert.ok(modelResult.models.some((model) => model.value === 'opus[1m]'), 'حُجب نموذج [1m] المقبول بقرار المالك');
  assert.ok(!modelResult.models.some((model) => model.value.includes('[2m]')), 'عبر نموذج مقوّس لا يطابق SAFE_MODEL');
  assert.ok(!JSON.stringify(modelResult).includes(SECRET_SENTINEL), 'تسرّب حقل نموذج غير معلن');

  // اشتقاق التسمية الرسمية من resolvedModel (بلاغ مالك 2026-09-03 — OBS-063):
  // «Fable» وحدها لا تقول 5.1؛ الاسم الرسمي يُشتق حتمياً من المعرّف المحلول،
  // وresolvedModel نفسه لا يعبر IPC، والفاسد يسقط إلى displayName حرفياً.
  const officialRaw = [
    { value: 'default', displayName: 'Default (recommended)', description: 'x', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'x', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'x', resolvedModel: 'claude-fable-5-1' },
    { value: 'haiku', displayName: 'Haiku', description: 'x', resolvedModel: 'claude-haiku-4-5-20251001' },
    { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'x', resolvedModel: 'claude-opus-4-8' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'x', resolvedModel: SECRET_SENTINEL },
  ];
  const officialResult = plain(await contract.handleClaudeModelsRequest({
    async claudeModels() { return { ok: true, models: officialRaw }; },
  }));
  const labelByValue = new Map(officialResult.models.map((model) => [model.value, model.label]));
  assert.equal(labelByValue.get('claude-fable-5-1[1m]'), 'Fable 5.1 (1M context)', 'اسم Fable الرسمي بلا رقم الإصدار');
  assert.equal(labelByValue.get('opus[1m]'), 'Opus 5 (1M context)', 'اسم Opus الرسمي');
  assert.equal(labelByValue.get('default'), 'Default (recommended) — Opus 5', 'الافتراضي يذكر نموذجه المحلول');
  assert.equal(labelByValue.get('haiku'), 'Haiku 4.5', 'مقطع تاريخ haiku لم يُسقط');
  assert.equal(labelByValue.get('claude-opus-4-8'), 'Opus 4.8', 'اسم Opus 4.8');
  assert.equal(labelByValue.get('sonnet'), 'Sonnet', 'resolvedModel الفاسد لم يسقط إلى displayName');
  for (const model of officialResult.models) {
    assert.deepEqual(Object.keys(model).sort(), ['description', 'label', 'value'], 'resolvedModel تسرب إلى العقد العام');
  }
  assert.ok(!JSON.stringify(officialResult).includes(SECRET_SENTINEL), 'تسرّب resolvedModel خام');

  // OBS-063 مرشّح (أ): مستويات الجهد المعلنة تعبر بحقل اختياري واحد منقّى بقائمة مغلقة.
  // المقيس حياً على Claude Code 2.1.258 (‏SDK 0.3.176): خمسة نماذج تعلن
  // supportsEffort:true بالمستويات الخمسة، و«haiku» لا يعلن حقول جهد إطلاقاً.
  const effortRaw = [
    { value: 'sonnet', displayName: 'Sonnet', description: 'x', supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // haiku الحيّ: لا حقول جهد ⇒ العقد القديم حرفياً (لا يميّزه شيء عن CLI أقدم)
    { value: 'haiku', displayName: 'Haiku', description: 'x' },
    // supportsEffort:false يمنع الحقل حتى مع مصفوفة صالحة
    { value: 'no-effort', displayName: 'NoEffort', description: 'x', supportsEffort: false,
      supportedEffortLevels: ['low', 'high'] },
    // truthy لا يكفي: الشرط === true صريح
    { value: 'truthy', displayName: 'Truthy', description: 'x', supportsEffort: 1,
      supportedEffortLevels: ['low'] },
    // فاسد/مكرر/غير نصي/خارج القائمة يُسقط، والترتيب يتبع القائمة المغلقة لا SDK
    { value: 'messy', displayName: 'Messy', description: 'x', supportsEffort: true,
      supportedEffortLevels: ['max', 'low', 'low', 'ultra', 'minimal', SECRET_SENTINEL, 42, null, { level: 'high' }, ['high']] },
    // مصفوفة تفرغ بعد التنقية ⇒ لا حقل (لا مصفوفة فارغة توهم بإعلان)
    { value: 'empty-after', displayName: 'EmptyAfter', description: 'x', supportsEffort: true,
      supportedEffortLevels: ['ultra', 'minimal'] },
    // نوع خاطئ للمصفوفة نفسها
    { value: 'not-array', displayName: 'NotArray', description: 'x', supportsEffort: true,
      supportedEffortLevels: 'low,high' },
  ];
  const effortResult = plain(await contract.handleClaudeModelsRequest({
    async claudeModels() { return { ok: true, models: effortRaw }; },
  }));
  const byValue = new Map(effortResult.models.map((model) => [model.value, model]));
  assert.deepEqual(byValue.get('sonnet').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(byValue.get('messy').effortLevels, ['low', 'max'], 'لم تُنقَّ المستويات أو لم يُحفظ ترتيب القائمة المغلقة');
  for (const value of ['haiku', 'no-effort', 'truthy', 'empty-after', 'not-array']) {
    assert.deepEqual(Object.keys(byValue.get(value)).sort(), ['description', 'label', 'value'],
      `عبر حقل جهد لنموذج لا يعلنه صراحةً: ${value}`);
  }
  for (const model of effortResult.models) {
    const allowed = ['description', 'effortLevels', 'label', 'value'];
    for (const key of Object.keys(model)) assert.ok(allowed.includes(key), `حقل غير معلن في العقد العام: ${key}`);
    assert.equal(model.supportsEffort, undefined, 'عبر supportsEffort الخام إلى renderer');
    for (const level of model.effortLevels || []) {
      assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(level), `مستوى خارج القائمة المغلقة: ${level}`);
    }
  }
  assert.ok(!JSON.stringify(effortResult).includes(SECRET_SENTINEL), 'تسرّب قيمة غير معلنة عبر مستويات الجهد');
  // المصفوفة المعادة نسخة جديدة لا مرجع مشترك مع SDK
  assert.notEqual(byValue.get('sonnet').effortLevels, effortRaw[0].supportedEffortLevels);

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
  assert.equal(contract.sanitizeClaudeFallbackModel('opus[1m]', 'sonnet'), 'opus[1m]');
  assert.equal(contract.sanitizeClaudeFallbackModel('opus[2m]', 'sonnet'), null);
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
  {
    const options = {};
    assert.equal(applyClaudeFallbackModel(options, 'opus', 'opus[1m]', null), true, 'رُفض fallback بلاحقة [1m] المقبولة');
    assert.equal(options.fallbackModel, 'opus[1m]');
  }
  for (const fallback of ['', 'opus', 'opus[2m]', 'bad model', 'a'.repeat(65)]) {
    const options = {};
    assert.equal(applyClaudeFallbackModel(options, 'opus', fallback, null), false);
    assert.ok(!Object.hasOwn(options, 'fallbackModel'));
  }

  const agentSource = read('electron/agent.js');
  assert.match(agentSource, /applyClaudeFallbackModel\(options, model, fallbackModel, internalPolicy\);/);
  const mainSource = read('electron/main.js');
  assert.match(mainSource, /fallbackModel: sanitizeClaudeFallbackModel|const fallbackModel = sanitizeClaudeFallbackModel/);
}

// السقوط إلى الافتراضي حين يخرج الاختيار المحفوظ عن مستويات النموذج المعلنة
function testUiEffortPicker() {
  const ui = loadUiEffortSelector();
  const values = () => ui.elements.effort.options.map((option) => option.value);

  // 1) بلا نماذج ديناميكية: القائمة الثابتة حرفياً (توافق خلفي — CLI أقدم)
  ui.elements.effort.value = 'ultra'; // كما يستعيدها localStorage فوق خيارات الترميز
  assert.equal(ui.elements.effort.value, 'ultra');
  ui.rebuildEfforts();
  assert.deepEqual(values(), [...new Set(ui.EFFORT_CYCLE)], 'تغيّرت القائمة الثابتة بلا إعلان');
  assert.equal(ui.elements.effort.value, 'ultra', 'أُسقط اختيار صالح بلا سبب');
  assert.deepEqual(ui.notices, [], 'إشعار بلا إسقاط');

  // 2) وصول قائمة Claude المعلنة: تُعرض مستوياتها وحدها، والاختيار خارجها يسقط
  //    إلى الافتراضي بإشعار عربي — بدل تخفيض SDK الصامت الذي لا يراه المستخدم
  ui.setClaude([
    { value: 'sonnet', label: 'Sonnet', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', label: 'Haiku', effortLevels: [] },
  ]);
  ui.elements.model.value = 'sonnet';
  ui.rebuildEfforts();
  assert.deepEqual(values(), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(ui.elements.effort.value, '', 'لم يسقط الاختيار غير المدعوم إلى الافتراضي');
  assert.equal(ui.notices.length, 1, 'عدد الإشعارات ليس واحداً');
  assert.match(ui.notices[0], /لا يعلن جهد/);
  assert.match(ui.notices[0], /فائق/, 'الإشعار لا يسمّي المستوى المُسقَط بالعربية');

  // 3) الإشعار مرة واحدة لكل إسقاط: بعده تصير القيمة '' وهي في كل قائمة، فإعادة
  //    البناء المتكررة (تبديل نموذج/وصول قائمة محدّثة) لا تكرّره
  ui.rebuildEfforts();
  ui.rebuildEfforts();
  assert.equal(ui.notices.length, 1, 'تكرّر الإشعار مع كل إعادة بناء');
  // واختيار جديد غير مدعوم من المستخدم يستحق إشعاراً جديداً (لا كتم دائم)
  ui.elements.model.value = 'haiku';
  ui.rebuildEfforts();
  ui.elements.effort.value = 'ultra';
  ui.elements.model.value = 'sonnet';
  ui.rebuildEfforts();
  assert.equal(ui.notices.length, 2, 'كُتم إشعار إسقاط جديد بعد اختيار المستخدم');

  // 4) مستوى يعلنه النموذج يُحفظ عبر إعادة البناء
  ui.elements.effort.value = 'xhigh';
  ui.rebuildEfforts();
  assert.equal(ui.elements.effort.value, 'xhigh', 'أُسقط مستوى يعلنه النموذج');
  assert.equal(ui.notices.length, 2);

  // 5) نموذج لا يعلن حقول جهد (haiku الحيّ على 2.1.258) ⇒ القائمة الثابتة كما كانت.
  //    الغياب لا يميّزه شيء عن CLI أقدم، فالتوافق الخلفي يغلب (حدّ موثّق في OBS-063).
  ui.elements.model.value = 'haiku';
  ui.rebuildEfforts();
  assert.deepEqual(values(), [...new Set(ui.EFFORT_CYCLE)]);
  ui.elements.effort.value = 'ultra';
  ui.rebuildEfforts();
  assert.equal(ui.elements.effort.value, 'ultra');
  assert.equal(ui.notices.length, 2, 'أُشعر عن نموذج لا يعلن مستوياته');

  // 6) مسار Codex بلا تغيير: يقصّ القائمة ويسقط بصمت (سلوكه السابق حرفياً)
  ui.elements.engine.value = 'codex';
  ui.setCodex([{ value: 'gpt-5.6-sol', label: 'Sol', efforts: ['medium', 'high', 'xhigh'] }]);
  ui.elements.model.value = 'gpt-5.6-sol';
  ui.rebuildEfforts();
  assert.deepEqual(values(), ['', 'medium', 'high', 'xhigh']);
  assert.equal(ui.elements.effort.value, '');
  assert.equal(ui.notices.length, 2, 'أُضيف إشعار إلى مسار Codex خارج نطاق الدفعة');

  // 7) دورة شريط الوعي تُشتق من الخيارات الفعلية لا من الثابت الأوسع
  const appSource = read('src/ui/app.js');
  assert.match(appSource, /cycleSelect\(\$\('effort'\), effortCycleValues\(\)\)/);
  assert.match(appSource, /effortLevels: Array\.isArray\(model\.effortLevels\) \? model\.effortLevels : \[\]/);
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
  // بعد دمج C4 صارت الكتلة تحدّث حسابي Claude وCodex معاً. وبعد OBS-099 تغيّرت آليتها:
  // كانت تقرأ `settingsPop.hidden` داخل queueMicrotask، وهي قراءة تسبق مبدّل الحالة في
  // topbar.js (ترتيب المستمعين) فلم تُستدعَ الدالتان قط منذ دفعتَي B وC4. العقد الثابت
  // اليوم: topbar يبثّ settings-open عند الفتح، وapp.js يستمع له ويحدّث كسولاً.
  // ⚠️ لا تُعِد تثبيت queueMicrotask هنا — كان هذا السطر يحرس بنية العطل نفسها.
  assert.match(appSource, /addEventListener\('settings-open', \(\) => \{\s*refreshClaudeAccountView\(\);/);
  assert.doesNotMatch(appSource, /queueMicrotask\(\(\) => \{\s*if \(\$\('settingsPop'\)\.hidden\) return;/);
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
  testUiEffortPicker();
  testUiAndIpcContracts();
  testProbeContract();
  console.log('claude-models-test: OK — cache/IPC/allowlist/effort levels/UI fallback/internal isolation');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
