#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'sk-proj-' + 'Z'.repeat(32);
const TOOL_USE_ID = 'toolu_' + 'A1b2C3d4E5f6G7h8J9k0Lm2N';
const TASK_ID = 'ab12cd34e';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testOptionsAndLifecycleSanitizing() {
  const {
    applyClaudePolishOptions,
    sdkAgentProgressEvent,
    sdkCompactSummaryEvent,
  } = require('../electron/agent');

  const normal = {};
  assert.equal(applyClaudePolishOptions(normal, null), true);
  assert.deepEqual(normal, { promptSuggestions: true, agentProgressSummaries: true });
  const isolated = {};
  assert.equal(applyClaudePolishOptions(isolated, { mode: 'text-only' }), false);
  assert.deepEqual(isolated, {});

  const progress = sdkAgentProgressEvent({
    type: 'system', subtype: 'task_progress', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    summary: '  يفحص\u202e\n المسارات  ', usage: { total_tokens: 99 }, uuid: SECRET,
  });
  assert.deepEqual(plain(progress), {
    type: 'sdk_agent_progress', taskId: TASK_ID, summary: 'يفحص المسارات', toolUseId: TOOL_USE_ID,
  });
  assert.equal(sdkAgentProgressEvent({
    type: 'system', subtype: 'task_progress', task_id: TASK_ID, summary: SECRET,
  }), null);

  // OBS-094: حالة الخلفية (‏is_backgrounded) تمرّ كحدث sdk_agent_progress بلا ملخص وبسماح
  // ‏{backgrounded} فقط — من task_started ابتداءً ومن task_updated.patch عند انتقال لاحق.
  const startedBg = sdkAgentProgressEvent({
    type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent',
  });
  assert.deepEqual(plain(startedBg), {
    type: 'sdk_agent_progress', taskId: TASK_ID, toolUseId: TOOL_USE_ID, backgrounded: true,
  });
  assert.ok(!('spawnDepth' in startedBg) && !('spawn_depth' in startedBg),
    'spawn_depth ضجيج (كل بطاقة عمقها 1 بحكم البناء) — يجب ألا يعبر القناة');
  assert.equal(sdkAgentProgressEvent({
    type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    is_backgrounded: false, spawn_depth: 1,
  }), null, 'الوكيل الأمامي حالة افتراضية معروفة — لا حدث لها');
  assert.equal(sdkAgentProgressEvent({
    type: 'system', subtype: 'task_started', task_id: TASK_ID, is_backgrounded: true,
  }), null, 'بلا tool_use_id لا بطاقة تُشير إليها — يُسقط');
  const movedBg = sdkAgentProgressEvent({
    type: 'system', subtype: 'task_updated', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    patch: { is_backgrounded: true, status: 'running' },
  });
  assert.deepEqual(plain(movedBg), {
    type: 'sdk_agent_progress', taskId: TASK_ID, toolUseId: TOOL_USE_ID, backgrounded: true,
  });
  assert.equal(sdkAgentProgressEvent({
    type: 'system', subtype: 'task_updated', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    patch: { is_backgrounded: false, status: 'completed' },
  }), null, 'patch.is_backgrounded=false لا يولّد حدثاً');
  // عقد عدم التراجع: الملخصات تبقى بلا تغيير (‏toolUseId اختياري كما كان)
  const summaryNoTool = sdkAgentProgressEvent({
    type: 'system', subtype: 'task_progress', task_id: TASK_ID, summary: 'يفحص المسارات',
  });
  assert.deepEqual(plain(summaryNoTool), { type: 'sdk_agent_progress', taskId: TASK_ID, summary: 'يفحص المسارات' });
  const compact = sdkCompactSummaryEvent({ hook_event_name: 'PostCompact', compact_summary: '  خلاصة\u2066 آمنة  ', transcript_path: SECRET });
  assert.deepEqual(plain(compact), { type: 'system', subtype: 'compact_summary', compact_summary: 'خلاصة آمنة' });
  assert.equal(sdkCompactSummaryEvent({ hook_event_name: 'PostCompact', compact_summary: SECRET }), null);
}

async function testSuggestionGateAndBackgroundIntersection() {
  const { createPromptSuggestionGate, PROMPT_SUGGESTION_WAIT_MS } = require('../electron/agent');
  assert.equal(PROMPT_SUGGESTION_WAIT_MS, 1500);

  let timerCallback = null;
  let timerDelay = null;
  let closes = 0;
  const gate = createPromptSuggestionGate({
    enabled: true,
    closeInput: () => { closes += 1; },
    setTimer: (callback, delay) => { timerCallback = callback; timerDelay = delay; return 1; },
    clearTimer: () => {},
  });
  gate.markResult();
  assert.equal(closes, 0, 'أُغلق input فور result');
  assert.equal(timerDelay, 1500);
  gate.markSuggestion();
  assert.equal(closes, 1, 'لم يغلق بعد prompt_suggestion');

  let backgroundTimer = null;
  closes = 0;
  const backgroundGate = createPromptSuggestionGate({
    enabled: true,
    closeInput: () => { closes += 1; },
    setTimer: (callback) => { backgroundTimer = callback; return 2; },
    clearTimer: () => {},
  });
  backgroundGate.setBackgroundIdle(false);
  backgroundGate.markResult();
  backgroundTimer();
  assert.equal(closes, 0, 'أغلقت المهلة input ومهمة SDK الخلفية معلقة');
  backgroundGate.setBackgroundIdle(true);
  assert.equal(closes, 1, 'لم يغلق input بعد الإشعار النهائي والمهلة');

  closes = 0;
  const oldCliGate = createPromptSuggestionGate({ enabled: false, closeInput: () => { closes += 1; } });
  oldCliGate.markResult();
  assert.equal(closes, 1, 'لم يتدهور CLI الأقدم إلى الإغلاق الفوري');
  assert.equal(typeof timerCallback, 'function');
}

async function testFailureCleanupAndPermissionContract() {
  const { clearFailedEditSnapshot } = require('../electron/agent');
  const snapshots = new Map([[TOOL_USE_ID, { before: 'x' }]]);
  assert.equal(clearFailedEditSnapshot({ tool_name: 'Write', tool_use_id: TOOL_USE_ID }, snapshots), true);
  assert.equal(snapshots.size, 0);
  assert.equal(clearFailedEditSnapshot({ tool_name: 'Bash', tool_use_id: TOOL_USE_ID }, snapshots), false);

  const agent = read('electron/agent.js');
  const sdkTypes = read('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts');
  assert.match(agent, /PostToolUseFailure: \[\{ hooks: \[postToolUseFailure\] \}\]/);
  assert.match(agent, /PostCompact: \[\{ hooks: \[postCompact\] \}\]/);
  assert.match(agent, /decisionClassification = allow \? \(permanent \? 'user_permanent' : 'user_temporary'\) : 'user_reject'/);
  assert.match(agent, /behavior: 'deny'.*decisionClassification/s);
  assert.match(sdkTypes, /decisionClassification\?: PermissionDecisionClassification/);
  assert.match(sdkTypes, /type PermissionDecisionClassification = 'user_temporary' \| 'user_permanent' \| 'user_reject'/);
}

async function testIpcAndUiAllowlists() {
  const main = read('electron/main.js');
  const app = read('src/ui/app.js');
  const chat = read('src/ui/components/chat.js');
  const composer = read('src/ui/components/composer.js');
  const html = read('src/index.html');
  const css = read('src/styles/base.css');

  assert.match(main, /return suggestion \? \{ type: 'prompt_suggestion', suggestion \} : null/);
  // ‏OBS-094: كان هذا الفحص يثبّت **الصياغة الحرفية** `{ type, taskId, summary }` فسقط يوم
  // أُضيف السماح الموازي لحالة الخلفية (حدثٌ بلا summary كان يُحجب كلياً عند البوابة).
  // حارسٌ يثبّت الشكل يصير عائقاً يوم يُصلَح العطل — فصار يثبّت **العقد**: الأساس ثم
  // إضافة الحقلين بشرط، بلا تقييد ترتيب. والسلوك نفسه مغطّى بالتأكيدات الحيّة أدناه.
  assert.match(main, /const safe = \{ type: 'sdk_agent_progress', taskId \}/);
  assert.match(main, /if \(summary\) safe\.summary = summary;/);
  assert.match(main, /if \(backgrounded\) safe\.backgrounded = true;/);
  assert.match(main, /return compactSummary \? \{ type: 'system', subtype: 'compact_summary', compact_summary: compactSummary \} : null/);
  const sanitizer = main.slice(main.indexOf('function sanitizeClaudePolishEvent'), main.indexOf('// إيقاف أي تشغيل'));
  assert.doesNotMatch(sanitizer, /uuid|usage|transcript_path|duration_ms|prompt_id/);
  assert.match(agentSource(), /rawPrivateLifecycle[\s\S]*?task_progress/);
  // OBS-094: تجميد سماح القناة — شجرة الوكلاء تعبر بـbackgrounded وحده، ولا حقلا
  // spawn_depth/parent_agent_id في تطبيع الرسالة (ضجيج/غائب عن البث الحي)، والواجهة
  // تربط الحدث بشارة الخلفية القائمة.
  const progressSlice = agentSource().slice(
    agentSource().indexOf('function sdkAgentProgressEvent'),
    agentSource().indexOf('function sdkCompactSummaryEvent'));
  assert.doesNotMatch(progressSlice, /spawn_depth|parent_agent_id/);
  assert.match(chat, /event\.backgrounded === true[\s\S]*?markSdkBackground/);

  assert.match(app, /ev\.type === 'prompt_suggestion'[\s\S]*?showPromptSuggestion\(ev\.suggestion\)/);
  assert.match(app, /ev\.type === 'sdk_agent_progress'[\s\S]*?updateAgentProgress/);
  assert.match(app, /subtype === 'compact_summary'[\s\S]*?compact_summary: ev\.compact_summary/);
  assert.match(composer, /promptSuggestion\.addEventListener\('click'[\s\S]*?input\.value = suggestion/);
  const suggestionClick = composer.slice(composer.indexOf("promptSuggestion.addEventListener('click'"), composer.indexOf('// ما يلي منقول'));
  assert.doesNotMatch(suggestionClick, /emitSend\(|composer-send|window\.satr\.send/);
  assert.match(composer, /input\.addEventListener\('input'[\s\S]*?clearPromptSuggestion\(\)/);
  assert.match(app, /const e = \$\('engine'\)\.value;\s*clearPromptSuggestion\(\)/);
  assert.match(app, /function newSession[\s\S]*?clearPromptSuggestion\(\)/);
  assert.match(app, /session-resume[\s\S]*?clearPromptSuggestion\(\)/);
  assert.match(html, /id="promptSuggestion"[^>]*hidden/);
  assert.match(css, /\.prompt-suggestion\[hidden\] \{ display: none; \}/);
  assert.doesNotMatch(html, /style=/i);
  assert.match(chat, /className = 'agent-progress-summary'/);
  assert.match(chat, /compactCard\.querySelector\('\.nums'\)/);
  assert.match(chat, /compactSummary\.textContent = meta\.compact_summary/);
}

function agentSource() {
  return read('electron/agent.js');
}

async function testStopAndRegistrationContracts() {
  const agent = agentSource();
  const main = read('electron/main.js');
  const pkg = JSON.parse(read('package.json'));
  const fullSuite = read('scripts/full-suite.js');
  const stopSlice = agent.slice(agent.indexOf('    async stop() {'), agent.indexOf('\n    },\n  };', agent.indexOf('    async stop() {')));
  assert.match(stopSlice, /await q\.interrupt\(\)/);
  assert.match(stopSlice, /closeInput\(\)/);
  assert.ok(stopSlice.indexOf('await q.interrupt()') < stopSlice.indexOf('closeInput()'));
  assert.match(main, /const SDK_STOP_GRACE_MS = 5000/);
  assert.match(main, /async function stopSdkRun\(run\)[\s\S]*?run\.stop\(\)[\s\S]*?run\.done[\s\S]*?run\.forceClose\(\)/);
  assert.equal(pkg.scripts['test:sdk-polish'], 'node scripts/sdk-polish-test.js');
  assert.match(fullSuite, /'test:sdk-background',\s*\r?\n\s*'test:sdk-polish',/);
}

(async () => {
  await testOptionsAndLifecycleSanitizing();
  await testSuggestionGateAndBackgroundIntersection();
  await testFailureCleanupAndPermissionContract();
  await testIpcAndUiAllowlists();
  await testStopAndRegistrationContracts();
  console.log('sdk-polish-test: ok — 5/5 (خيارات/lifecycle، تأخير+خلفية، failure+permission، IPC+واجهة، إيقاف+تسجيل)');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});