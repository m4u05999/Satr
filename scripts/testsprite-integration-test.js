#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const testsprite = require('../electron/testsprite');

const key = 'sk-user-' + 'A'.repeat(64);
assert.strictEqual(testsprite.isValidApiKey('bad'), false);
assert.strictEqual(testsprite.isValidApiKey(key), true);
assert.strictEqual(testsprite.requested('اختبر المشروع'), false);
assert.strictEqual(testsprite.requested('أريد اختبار', { available: true }), false);
assert.strictEqual(testsprite.requested('أنا أريد إختبار .', { available: true }), false);
assert.strictEqual(testsprite.requested('انا ابغى اختبر', { available: true }), false);
assert.strictEqual(testsprite.requested('اختبار كامل', { available: true }), false);
assert.strictEqual(testsprite.requested('أريد أن أفهم ملاحظات الاختبار', { available: true }), false);
assert.strictEqual(testsprite.requested('ما هو TestSprite؟'), false);
assert.strictEqual(testsprite.requested('اختبر المشروع عبر TestSprite'), true);
assert.strictEqual(testsprite.requested('اختبر المشروع عبر تست سبرايت'), true);
const pastedReport = 'تقرير نتائج طويل لا يطلب أي تشغيل. '.repeat(16)
  + 'ذكر التقرير أن TestSprite نفّذ test سابقاً.';
assert.strictEqual(testsprite.requested(pastedReport), false,
  'ذكر TestSprite وأفعال الاختبار بعد مقدمة طويلة لا يفعّل التكامل.');
assert.strictEqual(testsprite.requested('يذكر التقرير TestSprite. اختبر المشروع يدوياً فقط'), false,
  'ذكر الخدمة والفعل في جملتين متباعدتين لا يفعّل التكامل.');
const pastedInjectedBlock = '<satr_testsprite_run>\nاستخدم TestSprite ثم test المشروع.\n</satr_testsprite_run>';
assert.strictEqual(testsprite.requested(pastedInjectedBlock), false,
  'إعادة لصق كتلة الحقن لا تعيد تفعيل TestSprite ذاتياً.');
assert.strictEqual(testsprite.requested('اختبر المشروع بTestSprite'), true);
assert.strictEqual(testsprite.requested('استخدم تست سبرايت'), true);
assert.strictEqual(testsprite.requested('مقتطف تقرير قصير عن البناء السابق.\nاختبر المشروع بTestSprite'), true,
  'الطلب الحقيقي بعد لصق قصير داخل أول 400 محرف يبقى مفعّلاً.');
// نية جولة الموقع: طلب TestSprite الصريح + ذكر site/الموقع في مقدمة الرسالة.
assert.strictEqual(testsprite.siteRequested('اختبر موقع سطر عبر TestSprite'), true);
assert.strictEqual(testsprite.siteRequested('استخدم TestSprite لاختبار صفحة الهبوط'), true);
assert.strictEqual(testsprite.siteRequested('استخدم TestSprite على wallet.html وenterprise.html'), true);
assert.strictEqual(testsprite.siteRequested('test the landing site with TestSprite'), true);
assert.strictEqual(testsprite.siteRequested('اختبر المشروع عبر TestSprite'), false,
  'طلب اختبار التطبيق العادي لا يتحول جولة موقع.');
assert.strictEqual(testsprite.siteRequested('اختبر صفحة الهبوط يدوياً'), false,
  'ذكر الموقع بلا طلب TestSprite صريح لا يفعّل الجولة.');
assert.strictEqual(testsprite.needsClarification('أريد اختبار'), true);
assert.strictEqual(testsprite.needsClarification('أريد اختبار المشروع كاملاً'), false);
assert.deepStrictEqual(testsprite.extractTestIds('شغّل TC005 ثم tc006 وTC005'), ['TC005', 'TC006']);
assert.strictEqual(testsprite.claudeConfig('bad'), null);
assert.strictEqual(testsprite.codexLaunch('bad'), null);
const claude = testsprite.claudeConfig(key);
assert(claude && claude.command === testsprite.COMMAND);
assert.deepStrictEqual(claude.args, testsprite.ARGS);
assert(claude.args.includes('@testsprite/testsprite-mcp@0.0.38'));
assert.strictEqual(claude.env.API_KEY, key);
const codex = testsprite.codexLaunch(key);
assert(codex && codex.env.API_KEY === key);
assert(!codex.args.join(' ').includes(key), 'تسرّب المفتاح إلى وسائط Codex/قائمة العمليات.');
assert(codex.args.join(' ').includes('env_vars=["API_KEY"]'));
assert(codex.args.join(' ').includes('@testsprite/testsprite-mcp@0.0.38'));
assert(codex.args.join(' ').includes('default_tools_approval_mode="approve"'));
assert(codex.args.join(' ').includes('enabled_tools=' + JSON.stringify(testsprite.CODEX_ENABLED_TOOLS)));
assert(!testsprite.CODEX_ENABLED_TOOLS.includes('testsprite_open_test_result_dashboard'),
  'فتح dashboard خارجي لا يُعتمد تلقائياً داخل دور الاختبار.');
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-testsprite-'));
const automated = testsprite.chatPrompt('اختبر المشروع باستخدام TestSprite', {
  url: 'http://127.0.0.1:4173', cwd: projectRoot,
});
assert(automated.includes('testsprite_check_account_info'));
assert(automated.includes('testsprite_generate_code_and_execute'));
assert(automated.includes('npm run test:full'));
assert(automated.includes('localPort=4173'));
assert(automated.includes('testsprite_bootstrap'));
assert(automated.includes('AskUserQuestion'));
assert(automated.includes('test_results.json'));
assert(automated.includes('لا تنتظر خروجه'));
assert.strictEqual(testsprite.chatPrompt('اصلح المشروع', { url: 'https://example.com', cwd: 'D:\\sater' }), 'اصلح المشروع');

const direct = testsprite.chatPrompt('نفّذ TC005 وTC006 عبر TestSprite', {
  url: 'http://127.0.0.1:4173', cwd: projectRoot,
});
assert(direct.includes('TC005, TC006'));
assert(direct.includes('النطاق محدد بما يكفي'));

// عقد جولة الموقع: منفذ site، الصفحات الثلاث، بلا test:full وبلا محاكاة، وbootstrap دائماً.
const siteRun = testsprite.siteChatPrompt('اختبر موقع سطر عبر TestSprite', {
  url: 'http://127.0.0.1:4620', cwd: projectRoot,
});
assert(siteRun.includes('localPort=4620'));
assert(siteRun.includes('/enterprise.html') && siteRun.includes('/wallet.html'));
assert(siteRun.includes('projectName="satr-site"'));
assert(siteRun.includes('لا تشغّل npm run test:full'));
assert(!siteRun.includes('mock-satr'), 'عقد الموقع لا يذكر محاكاة window.satr.');
assert(siteRun.includes('استدعِ testsprite_bootstrap دائماً'),
  'تهيئة قديمة لسطح الواجهة يجب ألا تمنع bootstrap جولة الموقع.');
assert(siteRun.includes('mailto') && siteRun.includes('reduced-motion'));
assert(siteRun.includes('لا تدّعِ اختبار تطبيق سطر'));
assert.strictEqual(testsprite.siteChatPrompt('اختبر الموقع', { url: 'https://example.com', cwd: 'D:\\sater' }), 'اختبر الموقع');
assert.strictEqual(testsprite.siteRequested(siteRun.slice(siteRun.indexOf('<satr_testsprite_run>'))), false,
  'إعادة لصق كتلة عقد الموقع لا تعيد تفعيل الجولة ذاتياً.');

const tempRoot = path.join(projectRoot, 'testsprite_tests', 'tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const configFile = path.join(tempRoot, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  status: 'commited',
  executionArgs: { envs: { API_KEY: key, KEEP: 'value' } },
  nested: { TESTSPRITE_API_KEY: key },
}), 'utf8');
assert.strictEqual(testsprite.completedConfig(projectRoot), true);
const configured = testsprite.chatPrompt('اختبر المشروع باستخدام TestSprite', {
  url: 'http://127.0.0.1:4173', cwd: projectRoot,
});
assert(configured.includes('تهيئة TestSprite مكتملة'));
assert(configured.includes('لا تستدعِ testsprite_bootstrap'));
assert.strictEqual(testsprite.scrubConfig(projectRoot), true);
const scrubbed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
assert.strictEqual(scrubbed.executionArgs.envs.API_KEY, undefined);
assert.strictEqual(scrubbed.nested.TESTSPRITE_API_KEY, undefined);
assert.strictEqual(scrubbed.executionArgs.envs.KEEP, 'value');
assert.strictEqual(scrubbed.status, 'commited');
assert.strictEqual(testsprite.scrubConfig(projectRoot), false);

const summarized = testsprite.summarizeResults([
  { title: 'TC005-Theme', testStatus: 'PASSED' },
  { title: 'TC006-Files', testStatus: 'FAILED' },
], ['TC005', 'TC006']);
assert.deepStrictEqual(
  { total: summarized.total, completed: summarized.completed, passed: summarized.passed,
    failed: summarized.failed, skipped: summarized.skipped, complete: summarized.complete },
  { total: 2, completed: 2, passed: 1, failed: 1, skipped: 0, complete: true },
);
assert.strictEqual(testsprite.summarizeResults([
  { title: 'TC005-Theme', testStatus: 'PASSED' },
], ['TC005', 'TC006']).complete, false);
// درس الجولة الأولى: BLOCKED/CANCELLED/INFRA_ERROR نهائية — المراقب لا يعلق عليها.
const blockedRun = testsprite.summarizeResults([
  { title: 'TC007-Wallet', testStatus: 'BLOCKED' },
  { title: 'TC008-Links', testStatus: 'PASSED' },
], ['TC007', 'TC008']);
assert.strictEqual(blockedRun.complete, true, 'جولة فيها BLOCKED لا تُعتبر منتهية فيعلق المراقب.');
assert.strictEqual(blockedRun.blocked, 1);
assert.strictEqual(blockedRun.completed, 2);

const progressEvents = [];
const watcher = testsprite.watchResults(projectRoot, {
  testIds: ['TC005'], intervalMs: 60000, stableMs: 0, onUpdate: (event) => progressEvents.push(event),
});
fs.writeFileSync(testsprite.resultPath(projectRoot), JSON.stringify([
  { title: 'TC005-Theme', testStatus: 'PASSED' },
]), 'utf8');
watcher.tick();
watcher.tick();
watcher.stop();
assert.deepStrictEqual(progressEvents.map((event) => event.phase), ['running', 'complete']);
fs.rmSync(projectRoot, { recursive: true, force: true });

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function assertStaticContract() {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  const agent = read('electron/agent.js');
  const codexSource = read('electron/codex.js');
  const topbar = read('src/ui/components/topbar.js');
  assert(main.includes('testsprite.publicInfo()') && main.includes('testsprite.isValidApiKey(value)'));
  assert(agent.includes("options.mcpServers[testsprite.SERVER_NAME] = config") && agent.includes('testsprite.requested(prompt, {') && agent.includes('!isolatedPolicy') && agent.includes('testsprite.MISSING_KEY_MESSAGE'));
  assert(codexSource.includes('testsprite.codexLaunch') && codexSource.includes('testsprite.requested(prompt, {') && codexSource.includes('browserControl !== false') && codexSource.includes('testsprite.MISSING_KEY_MESSAGE'));
  assert((agent.match(/testsprite\.scrubConfig\(cwd\)/g) || []).length >= 2
    && (codexSource.match(/testsprite\.scrubConfig\(cwd\)/g) || []).length >= 2,
  'ملف TestSprite المؤقت لا يُنقّى من الأسرار عند بدء الدور ونهايته.');

  for (const [label, source] of [['SDK', agent], ['Codex', codexSource]]) {
    assert(source.includes("const testspritejobs = require('./testspritejobs');")
      && source.includes("testspritejobs.startJob({ cwd, kind: siteRound ? 'site' : 'app', prompt })")
      && source.includes('testsprite.chatPrompt(prompt, { url: started.url, cwd })')
      && source.includes('testsprite.siteChatPrompt(prompt, { url: started.url, cwd })'),
    `محرك ${label} لا يستهلك عقد مدير جولة TestSprite أو لا يحقن URL المدير.`);
    assert(!source.includes('testspriteHarnessHost') && !source.includes('testspriteProgressWatcher')
      && !source.includes("require('./testspriteharness')") && !source.includes('testsprite.watchResults'),
    `محرك ${label} ما زال يملك host/watcher أو يغلقهما مع cleanup الدور.`);
    assert(source.includes("started.error === 'busy'") && source.includes('await testspritejobs.status()')
      && source.includes('أكمل الجولة النشطة عبر أدوات testsprite ولا تبدأ bootstrap جديداً.'),
    `محرك ${label} لا يحقن متابعة الجولة النشطة عند busy.`);
    assert(!source.includes("type: 'testsprite_job'"),
      `محرك ${label} يبني حدث testsprite_job بدلاً من تمرير حدث المدير المستقل.`);
  }
  assert(agent.includes('testsprite.siteRequested(prompt)') && codexSource.includes('testsprite.siteRequested(prompt)'),
    'جولة الموقع (site/) غير موصولة في المحركين.');
  assert(codexSource.includes("it.type === 'mcpToolCall'") && codexSource.includes("t === 'mcpToolCall'"),
    'بطاقات أدوات MCP الخارجية لا تظهر بدءاً ونتيجةً في محادثة Codex.');

  const expectedChannels = ['satr:testspriteJobCancel', 'satr:testspriteJobStatus'];
  const mainChannels = [...main.matchAll(/ipcMain\.handle\('(satr:testspriteJob[^']+)'/g)]
    .map((match) => match[1]).sort();
  const preloadChannels = [...preload.matchAll(/ipcRenderer\.invoke\('(satr:testspriteJob[^']+)'/g)]
    .map((match) => match[1]).sort();
  assert.deepStrictEqual(mainChannels, expectedChannels, 'قائمة سماح IPC في main ليست القناتين المجمدتين فقط.');
  assert.deepStrictEqual(preloadChannels, expectedChannels, 'قائمة سماح IPC في preload ليست القناتين المجمدتين فقط.');
  assert(main.includes('const SAFE_TESTSPRITE_JOB_ID = /^tsj_[0-9]{1,15}_[a-z0-9]{1,10}$/;')
    && main.includes("ipcMain.handle('satr:testspriteJobStatus', () => testspritejobs.status());")
    && main.includes("payload.confirmed !== true) return { ok: false, error: 'confirmation_required' }")
    && main.includes('return testspritejobs.cancel(jobId);'),
  'تنقية IPC أو عقد status/cancel لجولة TestSprite غير مكتمل في main.');
  assert(preload.includes("testspriteJobStatus: () => ipcRenderer.invoke('satr:testspriteJobStatus')")
    && preload.includes("testspriteJobCancel: (jobId) => ipcRenderer.invoke('satr:testspriteJobCancel', { jobId, confirmed: true })"),
  'preload لا يكشف دالتي TestSprite المحددتين فقط بالعقد المجمد.');
  assert(main.includes('testspritejobs.setNotifier((event) => emitToWindow(event));')
    && main.includes('testspritejobs.cleanupBeforeQuit()'),
  'مدير الجولة غير موصول بالبث المستقل أو تنظيف إغلاق التطبيق.');
  assert(topbar.includes('r.integrations'), 'تكامل TestSprite غير ظاهر في مركز المفاتيح.');
}

async function withFakeTestSpriteJobs(fakeJobs, run) {
  const managerPath = path.join(ROOT, 'electron', 'testspritejobs.js');
  const agentPath = path.join(ROOT, 'electron', 'agent.js');
  const codexPath = path.join(ROOT, 'electron', 'codex.js');
  const enginePaths = new Set([agentPath, codexPath].map((file) => path.resolve(file)));
  const previousManager = require.cache[managerPath];
  const previousAgent = require.cache[agentPath];
  const previousCodex = require.cache[codexPath];
  const fakeModule = new Module(managerPath, module);
  fakeModule.filename = managerPath;
  fakeModule.loaded = true;
  fakeModule.exports = fakeJobs;
  require.cache[managerPath] = fakeModule;
  delete require.cache[agentPath];
  delete require.cache[codexPath];

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveTestSpriteJobs(request, parent, isMain, options) {
    if (request === './testspritejobs' && parent && enginePaths.has(path.resolve(parent.filename))) {
      return managerPath;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  let agentModule;
  let codexModule;
  try {
    agentModule = require(agentPath);
    codexModule = require(codexPath);
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }

  try {
    await run(agentModule, codexModule);
  } finally {
    delete require.cache[agentPath];
    delete require.cache[codexPath];
    delete require.cache[managerPath];
    if (previousAgent) require.cache[agentPath] = previousAgent;
    if (previousCodex) require.cache[codexPath] = previousCodex;
    if (previousManager) require.cache[managerPath] = previousManager;
  }
}

function assertBusyContinuation(label, result, prompt) {
  assert.strictEqual(result.ok, false, `${label}: نتيجة busy تحولت نجاحاً.`);
  assert.strictEqual(result.error, 'busy', `${label}: ضاع رمز busy.`);
  assert(result.effectivePrompt.startsWith(prompt), `${label}: لم يحتفظ ببرومبت المستخدم.`);
  const blocks = result.effectivePrompt.match(/<satr_testsprite_run>[\s\S]*?<\/satr_testsprite_run>/g) || [];
  assert.strictEqual(blocks.length, 1, `${label}: كتلة المتابعة ليست واحدة.`);
  assert(blocks[0].length <= 600, `${label}: كتلة المتابعة تجاوزت 600 محرف.`);
  assert(blocks[0].includes('state=awaiting_setup') && blocks[0].includes('port=4173')
    && blocks[0].includes('total=8') && blocks[0].includes('completed=3')
    && blocks[0].includes('passed=2') && blocks[0].includes('failed=1')
    && blocks[0].includes('skipped=0') && blocks[0].includes('blocked=0'),
  `${label}: كتلة المتابعة لا تحمل state/summary/port كاملة.`);
  assert(blocks[0].includes('أكمل الجولة النشطة عبر أدوات testsprite ولا تبدأ bootstrap جديداً.'),
    `${label}: غاب توجيه منع bootstrap الجديد.`);
  assert.strictEqual(testsprite.requested(blocks[0]), false,
    `${label}: كتلة المتابعة فعّلت نية TestSprite ذاتياً.`);
  assert(!result.effectivePrompt.includes('testsprite_generate_code_summary'),
    `${label}: busy حقن عقد bootstrap كاملاً بدلاً من متابعة الجولة.`);
}

async function testEngineJobWiring() {
  const calls = [];
  let response = null;
  let snapshot = null;
  let statusCalls = 0;
  const fakeJobs = {
    async startJob(input) { calls.push(input); return response; },
    async status() { statusCalls++; return snapshot; },
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-testsprite-engine-'));
  try {
    await withFakeTestSpriteJobs(fakeJobs, async (agentModule, codexModule) => {
      const appPrompt = 'اختبر المشروع عبر TestSprite';
      response = { ok: true, jobId: 'tsj_1_sdk', url: 'http://127.0.0.1:4173' };
      const sdkRun = await agentModule.prepareTestSpriteJob(appPrompt, cwd, false);
      assert.deepStrictEqual(calls.splice(0), [{ cwd, kind: 'app', prompt: appPrompt }]);
      assert(sdkRun.effectivePrompt.includes('localPort=4173')
        && sdkRun.effectivePrompt.includes('testsprite_generate_code_and_execute'),
      'SDK لم يحقن chatPrompt القائم بعنوان المدير.');

      const sitePrompt = 'اختبر موقع سطر عبر TestSprite';
      response = { ok: true, jobId: 'tsj_2_codex', url: 'http://127.0.0.1:4620' };
      const codexRun = await codexModule._internals.prepareTestSpriteJob(sitePrompt, cwd, true);
      assert.deepStrictEqual(calls.splice(0), [{ cwd, kind: 'site', prompt: sitePrompt }]);
      assert(codexRun.effectivePrompt.includes('localPort=4620')
        && codexRun.effectivePrompt.includes('projectName="satr-site"'),
      'Codex لم يحقن siteChatPrompt القائم بعنوان المدير.');

      snapshot = {
        type: 'testsprite_job', schema_version: 1, job_id: 'tsj_3_busy', kind: 'app',
        state: 'awaiting_setup', port: 4173, started_at: 1, heartbeat_at: 2,
        summary: { total: 8, completed: 3, passed: 2, failed: 1, skipped: 0, blocked: 0 },
        failure_code: null, updated_at: 3,
      };
      response = { ok: false, error: 'busy', jobId: 'tsj_3_busy' };
      const sdkBusy = await agentModule.prepareTestSpriteJob(appPrompt, cwd, false);
      assert.deepStrictEqual(calls.splice(0), [{ cwd, kind: 'app', prompt: appPrompt }]);
      assertBusyContinuation('SDK', sdkBusy, appPrompt);
      const codexBusy = await codexModule._internals.prepareTestSpriteJob(appPrompt, cwd, false);
      assert.deepStrictEqual(calls.splice(0), [{ cwd, kind: 'app', prompt: appPrompt }]);
      assertBusyContinuation('Codex', codexBusy, appPrompt);
      assert.strictEqual(statusCalls, 2, 'busy لم يقرأ snapshot مرة واحدة لكل محرك.');
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

assertStaticContract();
testEngineJobWiring().then(() => {
  console.log('testsprite-integration: نجح — مدير الجولة موصول بالمحركين وIPC وbusy بلا ملكية دور.');
}).catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
