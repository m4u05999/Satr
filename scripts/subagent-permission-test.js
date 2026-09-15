#!/usr/bin/env node
'use strict';

// OBS-208: طلب الإذن وسؤال النموذج من وكيل فرعي خلفي بعد انتهاء دور Query الأصلي.
// قبل الإصلاح: مرشّح `runSeq` في main.js يُسقطهما «بائتين» فيبقى وعد canUseTool بلا ردّ
// حتى يغلق Claude Code قناة الإذن ويرفض كل ما بعدها. نشغّل منطق الإنتاج نفسه (المرشّح
// ومسارا الردّ) في صندوق، بمحرك بديل يعدّ ما وصله من ردود.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const tasks = require('../electron/tasks');
const mobilestate = require('../electron/mobilestate');

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function loadRuntime(root) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, 'تعذّر استخراج منطق الإنتاج: ' + start);
    return source.slice(from, to);
  }
  const runs = [];
  const rendered = [];
  const dropped = [];
  const resolved = [];
  const handlers = {};
  const sandbox = {
    fs, os, path, randomBytes, console,
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    STOP_ALL_SEND_TIMEOUT_MS: 5000, SDK_START_TIMEOUT_MS: 90000,
    SDK_STOP_GRACE_MS: 5000, SDK_FORCE_CLOSE_GRACE_MS: 1000,
    runSeq: 0, currentRun: null, currentCliRun: null, lastEngine: '',
    activeConversationRunId: null,
    sdkSessionControlBusy: false, sdkRunInFlight: false,
    sdkStartingPromise: null, sdkStoppingPromise: null,
    sendRequestBusy: false, sendRequestEpoch: 0,
    sdkBackgroundRuns: new Set(), sdkTaskOwners: new Map(),
    pendingVerificationPermissions: new Map(), mobilePermissionRaces: new Map(),
    mobileControlEnabled: false,
    mobileHandle: null,
    mobilestate,
    tasks: { ...tasks, apply: (update) => tasks.apply(update, { root }) },
    ipcMain: { handle(name, callback) { handlers[name] = callback; } },
    eventTrace: { emitted() {}, dropped(...args) { dropped.push(args); } },
    emitToWindow: (event, engine) => rendered.push({ event: plain(event), engine }),
    preview: { endHandoff() {}, clearSensitiveState() {} },
    promocapture: { stopAll: async () => {} },
    withdrawMobilePermissions() {}, withdrawMobilePermission() {}, publishMobileState() {},
    offerMobilePermission() {}, notifyObservers() {}, noteShadowOverride() {},
    browserBudgetFor: () => ({}), browserBudgets: new Map(),
    trustedBrowserOrigins: new Set(),
    checkpoints: { begin() {}, bindSession() {}, consumeVerification: () => '', finish: () => null },
    sanitizeImages: () => [], sanitizeSkills: () => [], sanitizeExtraDirs: () => [],
    sanitizeClaudeFallbackModel: () => null,
    PERMISSION_MODES: new Set(['default']), EFFORT_LEVELS: new Set(),
    kimi: { ENGINE_ID: 'kimi-code' }, adapters: { get: () => null },
    nonSdkPerm: (mode) => mode,
    exported: {},
    agent: {
      async start(input, cwd, emit) {
        // المحرك البديل: يملك طلباته بمعرّفاتها، ويعدّ الردود التي وصلته — لا يحسم شيئاً بنفسه.
        const run = {
          input, cwd, emit, stopped: false, background: true, owned: new Set(),
          // OBS-207: `derived` يحوّل المحرك البديل إلى دلالة الإنتاج بعد الإصلاح —
          // `hasSdkBackgroundTasks` **مشتقّة من مهام النموذج الخلفية الحيّة** لا من علم
          // ثابت ولا من نقل المستخدم وحده. مع `derived:false` نحاكي الدلالة القديمة.
          derived: false, modelTasks: new Set(),
          hasSdkBackgroundTasks: () => (run.derived ? run.modelTasks.size > 0 : run.background),
          // كما في الإنتاج: `done` ينتهي بخروج Query فيُنظَّف الدور (currentRun والخلفية).
          finish: null,
          ownsSdkTask: () => true,
          // إيقاف Query يُنهي استهلاكها فعلاً؛ بدون حسم `done` لا يكتمل `stopSdkRun`.
          stop() { run.stopped = true; run.finish(); },
          resolvePermission(id, allow) {
            if (!run.owned.has(id)) return false;
            run.owned.delete(id); resolved.push({ run, id, allow, kind: 'permission' }); return true;
          },
          resolveQuestion(id, selections) {
            if (!run.owned.has(id)) return false;
            run.owned.delete(id); resolved.push({ run, id, selections, kind: 'question' }); return true;
          },
        };
        run.done = new Promise((resolve) => { run.finish = resolve; });
        runs.push(run);
        return run;
      },
    },
  };
  sandbox.kimi.start = sandbox.agent.start;
  const code = [
    section('const SAFE_SESSION =', 'const MOBILE_PERMISSION_TTL_MS ='),
    section('const mobileStateBoot =', 'const SAFE_SKILL ='),
    section('function hasLiveMobileSession()', 'const mobileStateHeartbeat ='),
    section('function resolvePermissionThroughCurrentHandles(', '// تشخيص مؤقت (يُفعَّل بـSATR_MOBILE_DEBUG=1)'),
    section('function stopAll(', 'function notifyObservers('),
    section('function forgetSdkBackgroundRun(', 'const rewindPreviews ='),
    // ‏OBS-207: مسار الإيقاف الحقيقي (‏settleSdkPromise/stopSdkRun/trackSdkStop) صار لازماً —
    // السيناريو (٧) يُبقي وكيلاً خلفياً داخل الدور الجاري فيمرّ stopAll(false) به فعلاً.
    section('function markSdkRunInFlight(', 'async function runSdkSessionControl('),
    section('async function handleSendRequest(', "ipcMain.handle('satr:stop',"),
    section("ipcMain.handle('satr:permission',", '// ---------- C1: التوجيه أثناء الدور'),
    section("ipcMain.handle('satr:answerQuestion',", 'const elicitationOpening = new Set();'),
  ].join('\n');
  vm.runInNewContext(code, sandbox, { filename: 'main-subagent-permission-extract.js' });

  async function start(cwd, sessionId) {
    const reply = await handlers['satr:send']({}, { prompt: 'اختبار إذن الوكيل الخلفي', engine: 'sdk', cwd, sessionId });
    assert.deepEqual(plain(reply), { started: true, engine: 'sdk' });
    return runs.at(-1);
  }
  return { start, handlers, rendered, dropped, resolved, sandbox };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-obs208-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  let passed = 0;
  const ok = (cond, msg) => { passed += 1; assert.ok(cond, msg); };
  try {
    const rt = loadRuntime(root);
    const a = await rt.start(project, 'session-a');
    a.emit({ type: 'system', subtype: 'init', session_id: 'session-a' });
    a.emit({ type: 'result', total_cost_usd: 0.1 });
    ok(rt.sandbox.sdkBackgroundRuns.has(a), 'A انتقل إلى الخلفية بعد result لأن له مهام SDK خلفية');

    // دور جديد B — رمز الدور يتقدّم، وA ما زال يعمل خلفياً (وكيل فرعي).
    const b = await rt.start(project, 'session-b');
    ok(rt.sandbox.runSeq === 2 && b !== a, 'B دور جديد برمز جديد');

    // (١) ⭐ طلب إذن من A بعد انتهاء دوره يصل النافذة ولا يُسقط بائتاً.
    a.owned.add('perm_bg_1');
    a.emit({ type: 'permission_request', id: 'perm_bg_1', tool: 'Edit', input: {}, requester: 'agent-a', turnEligible: true, alwaysEligible: true });
    const shown = rt.rendered.at(-1);
    ok(shown && shown.event.type === 'permission_request' && shown.event.id === 'perm_bg_1',
      'طلب إذن الوكيل الخلفي وصل النافذة');
    ok(!rt.dropped.some((args) => args[1] && args[1].type === 'permission_request'),
      'ولم يُسقط بوصفه stale_token');

    // (٢) ⭐ الردّ من الواجهة يعود إلى A لا إلى B (المعرّف يحسم المالك).
    const reply = await rt.handlers['satr:permission']({}, { id: 'perm_bg_1', allow: true });
    ok(reply.ok === true, 'الردّ قُبل');
    ok(rt.resolved.length === 1 && rt.resolved[0].run === a && rt.resolved[0].allow === true && rt.resolved[0].kind === 'permission',
      'الردّ وصل الدور الخلفي A نفسه');

    // (٣) سؤال النموذج من A يسلك المسار نفسه.
    a.owned.add('q_bg_1');
    a.emit({ type: 'question_request', id: 'q_bg_1', questions: [] });
    ok(rt.rendered.at(-1).event.type === 'question_request', 'سؤال الوكيل الخلفي وصل النافذة');
    const answer = await rt.handlers['satr:answerQuestion']({}, { id: 'q_bg_1', selections: [{ questionIndex: 0, optionIndexes: [0] }] });
    ok(answer.ok === true && rt.resolved.at(-1).run === a && rt.resolved.at(-1).kind === 'question',
      'جواب السؤال وصل الدور الخلفي A');

    // (٤) لا توسيع زائد: بث نصّي من A بعد B ما زال بائتاً.
    const droppedBefore = rt.dropped.length;
    a.emit({ type: 'stream_text', text: 'نص متأخر', phase: 'final_answer' });
    ok(rt.dropped.length === droppedBefore + 1 && rt.dropped.at(-1)[2] === 'stale_token',
      'البث المتأخر من A ما زال يُسقط stale_token');

    // (٥) لا توسيع زائد: دور انتهى **بلا** مهام خلفية لا يمرّر طلب إذن متأخراً.
    const settle = async (run) => { run.finish(); await new Promise((resolve) => setImmediate(resolve)); };
    b.background = false;
    b.emit({ type: 'result' });
    await settle(b);
    const c = await rt.start(project, 'session-c');
    c.background = false;
    c.emit({ type: 'result' });
    await settle(c);
    ok(!rt.sandbox.sdkBackgroundRuns.has(c), 'C ليس خلفياً');
    await rt.start(project, 'session-d');
    c.owned.add('perm_stale_1');
    const renderedBefore = rt.rendered.length;
    c.emit({ type: 'permission_request', id: 'perm_stale_1', tool: 'Edit', input: {} });
    ok(rt.rendered.length === renderedBefore && rt.dropped.at(-1)[2] === 'stale_token',
      'طلب من دور غير خلفي منتهٍ يبقى بائتاً');
    const staleReply = await rt.handlers['satr:permission']({}, { id: 'perm_stale_1', allow: true });
    ok(staleReply.ok === false, 'ولا مالك له عند الردّ');

    // (٦) الردّ على معرّف مجهول لا يُسند لأي دور خلفي.
    ok((await rt.handlers['satr:permission']({}, { id: 'perm_unknown', allow: false })).ok === false, 'المعرّف المجهول يُرفض');

    // ---------- OBS-207: عضوية sdkBackgroundRuns لوكيل خلفي أطلقه **النموذج** ----------
    // معرّف المسبار الحيّ نفسه (‏agentID في canUseTool == task_id، 2026-09-15).
    const AGENT_TASK_ID = 'a1cadac9484258db2';

    // (٧) ⭐ قياس العطل **قبل** التوسيع: بالدلالة القديمة (نقل المستخدم وحده) لا تدخل
    //     Query السجل الخلفي، فيقتلها `stopAll(false)` — وهو أول ما يفعله كل إرسال.
    const pre = await rt.start(project, 'session-pre');
    pre.derived = false;
    pre.background = false;                 // hasSdkBackgroundTasks القديمة: moveStates.size > 0
    pre.modelTasks.add(AGENT_TASK_ID);      // ووكيل خلفي أطلقه النموذج يعمل فعلاً
    pre.emit({ type: 'result' });
    ok(!rt.sandbox.sdkBackgroundRuns.has(pre) && rt.sandbox.currentRun === pre,
      'بالدلالة القديمة يبقى وكيل النموذج الخلفي معلَّقاً بالدور الجاري');
    await rt.start(project, 'session-pre-next'); // الإرسال التالي: stopAll(false) ثم token = ++runSeq
    ok(pre.stopped === true,
      '⭐ قبل التوسيع: stopAll(false) الذي يبدأ به كل إرسال يقتل Query الوكيل الخلفي');
    const preRendered = rt.rendered.length;
    pre.owned.add('perm_pre_1');
    pre.emit({ type: 'permission_request', id: 'perm_pre_1', tool: 'Write', input: {}, requester: AGENT_TASK_ID });
    ok(rt.rendered.length === preRendered && rt.dropped.at(-1)[2] === 'stale_token',
      '⭐ وطلب إذنه يبقى بائتاً رغم إصلاح OBS-208 (الشرط يتطلب عضوية sdkBackgroundRuns)');

    // (٨) ⭐ بعد التوسيع: الدلالة المشتقّة من مهام النموذج تُبقي Query حيّة.
    const live = await rt.start(project, 'session-live');
    live.derived = true;
    live.modelTasks.add(AGENT_TASK_ID);
    live.emit({
      type: 'sdk_agent_state', taskId: AGENT_TASK_ID, kind: 'started', description: 'probe agent',
      taskType: 'local_agent', backgrounded: true, resumed: false,
    });
    ok(rt.sandbox.sdkTaskOwners.get(AGENT_TASK_ID) === live,
      'سطح الوكلاء الأحياء يسجّل مالك المهمة لزر الإيقاف');
    live.emit({ type: 'result' });
    ok(rt.sandbox.sdkBackgroundRuns.has(live) && rt.sandbox.currentRun !== live,
      'Query الوكيل الخلفي انتقلت إلى السجل الخلفي بالدلالة المشتقّة');
    await rt.start(project, 'session-after');
    ok(live.stopped === false, '⭐ الإرسال التالي لم يعد يوقف Query الوكيل الخلفي');

    // ...وطلب إذنها المتأخر يصل ويعود إليها (إصلاح OBS-208 يعمل لهذه الحالة فعلاً).
    live.owned.add('perm_agent_1');
    live.emit({ type: 'permission_request', id: 'perm_agent_1', tool: 'Write', input: {}, requester: AGENT_TASK_ID });
    ok(rt.rendered.at(-1).event.id === 'perm_agent_1', '⭐ طلب إذن الوكيل الخلفي وصل النافذة');
    const agentReply = await rt.handlers['satr:permission']({}, { id: 'perm_agent_1', allow: true });
    ok(agentReply.ok === true && rt.resolved.at(-1).run === live, '⭐ والردّ عاد إلى Query الوكيل نفسه');

    // (٩) حدث السطح الحي نفسه يعبر متأخراً، وحسمُه يسحب المالك.
    live.modelTasks.delete(AGENT_TASK_ID);
    live.emit({ type: 'sdk_agent_state', taskId: AGENT_TASK_ID, kind: 'finished', status: 'completed', summary: 'تمّ' });
    ok(rt.rendered.at(-1).event.type === 'sdk_agent_state' && rt.rendered.at(-1).event.kind === 'finished',
      'حدث سطح الوكلاء المتأخر يصل النافذة ولا يُسقط بائتاً');
    ok(!rt.sandbox.sdkTaskOwners.has(AGENT_TASK_ID), 'ويُسحب المالك عند حسم المهمة');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('subagent-permission-test: ok — ' + passed + ' فحصاً (طلب الإذن والسؤال من وكيل خلفي بعد انتهاء الدور يصلان ويعودان إلى مالكهما، وبلا توسيع للبائت؛ وعضوية sdkBackgroundRuns المشتقّة من مهام النموذج تُبقي Query حيّة بعد أن كان الإرسال التالي يقتلها).');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
