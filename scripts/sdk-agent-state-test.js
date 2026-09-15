#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس قناة حالة الوكلاء الأحياء (OBS-207/151).
 *
 * قطعيٌّ نقيّ: لا شبكة ولا محرك حيّ. الرسائل المضبوطة أدناه **منقولة بأشكالها** من نتيجة
 * المسبار الحيّ `D:\sater\agents-live-probe\result.json` (‏SDK 0.3.270 / CLI 2.1.270،
 * 2026-09-15) — المعرّفات نفسها والحقول نفسها والترتيب نفسه:
 *   `background_tasks_changed` (قائمة كاملة) → `task_started` → `task_progress` →
 *   `background_tasks_changed` (فارغة) → `task_updated` → `task_notification`،
 * ثم استئناف بـ`SendMessage` يعيد `task_started` **بالمعرّف نفسه** وبـ`tool_use_id` جديد.
 *
 * ما يحرسه: تنقية الحدث وأنواعه الخمسة، الاستئناف، استبعاد ambient، إسقاط السرّ، رفض
 * الإشعار الكاذب من Query لم ترَ البداية، دلالة REPLACE، حجز/إفراج input لمهام النموذج،
 * سياسة الإيقاف الجديدة وحدّها، وتسجيل السكربت في الطقم وعقود main.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  createSdkBackgroundController,
  sdkAgentStateEvent,
  sdkAgentLocalFinishedEvent,
  SAFE_SDK_TASK_ID,
  SAFE_SDK_TOOL_USE_ID,
} = require('../electron/agent');

// معرّفات المسبار الحرفية (القياس 1: agentID في canUseTool == task_id)
const TASK_ID = 'a1cadac9484258db2';
const TOOL_USE_A = 'toolu_01Fe9aJLKrhbVCLfAmJmMty7'; // مقطع الإطلاق
const TOOL_USE_B = 'toolu_01LNHDNVCgrHk1sKiCesmZqF'; // مقطع الاستئناف (SendMessage)
const OTHER_TASK_ID = 'b7f2e9c10';
const SECRET_SENTINEL = 'sk-proj-' + 'A'.repeat(32);

let passed = 0;
function ok(condition, message) { passed += 1; assert.ok(condition, message); }
function eq(actual, expected, message) { passed += 1; assert.deepEqual(plain(actual), expected, message); }
function plain(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function ctx(...ids) { return { seen: new Set(ids) }; }

function read(relativePath) { return fs.readFileSync(path.join(ROOT, relativePath), 'utf8'); }

// ---------- الرسائل المضبوطة (أشكال المسبار) ----------

function startedMessage(overrides = {}) {
  return {
    type: 'system', subtype: 'task_started',
    task_id: TASK_ID, tool_use_id: TOOL_USE_A,
    description: 'probe agent', subagent_type: 'general-purpose',
    is_backgrounded: true, task_type: 'local_agent', spawn_depth: 1,
    prompt: 'Use the Write tool to create the file PROBE_A.txt…',
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function progressMessage(overrides = {}) {
  return {
    type: 'system', subtype: 'task_progress',
    task_id: TASK_ID, tool_use_id: TOOL_USE_A,
    description: 'Writing PROBE_A.txt', subagent_type: 'general-purpose',
    ...overrides,
  };
}

function updatedMessage(patch) {
  return { type: 'system', subtype: 'task_updated', task_id: TASK_ID, patch };
}

function notificationMessage(overrides = {}) {
  return {
    type: 'system', subtype: 'task_notification',
    task_id: TASK_ID, tool_use_id: TOOL_USE_A, status: 'completed', summary: 'AGENT_DONE_1',
    output_file: 'C:\\internal\\' + SECRET_SENTINEL + '.txt',
    usage: { total_tokens: 9 },
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function liveMessage(tasks) {
  return { type: 'system', subtype: 'background_tasks_changed', tasks };
}

// ---------- أ. الحدث النقي ----------

function testPureEvent() {
  ok(SAFE_SDK_TASK_ID.test(TASK_ID) && SAFE_SDK_TOOL_USE_ID.test(TOOL_USE_A)
    && SAFE_SDK_TOOL_USE_ID.test(TOOL_USE_B), 'معرّفات المسبار تطابق حرّاس الأنماط');

  // (١) الإطلاق الأول — لا prompt ولا uuid ولا session_id ولا حقل SDK غير معلن
  const started = sdkAgentStateEvent(startedMessage(), ctx());
  eq(started, {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'started',
    description: 'probe agent', taskType: 'local_agent', backgrounded: true, resumed: false,
    toolUseId: TOOL_USE_A, subagentType: 'general-purpose', spawnDepth: 1,
  }, 'شكل started من رسالة المسبار');
  ok(!JSON.stringify(started).includes('PROBE_A') && !JSON.stringify(started).includes('11111111'),
    'تسرّب prompt أو session_id إلى الحدث');

  // (٢) القياس 2: الاستئناف يعيد المعرّف نفسه بـtool_use_id جديد ⇒ resumed
  const resumed = sdkAgentStateEvent(startedMessage({ tool_use_id: TOOL_USE_B }), ctx(TASK_ID));
  ok(resumed.resumed === true && resumed.toolUseId === TOOL_USE_B && resumed.taskId === TASK_ID,
    'الاستئناف يُوسم resumed بالمعرّف نفسه ومقطعه الجديد');

  // (٣) local_bash له سطح أيضاً (النموذج يشغّل Bash خلفياً) وما عداهما لا
  ok(sdkAgentStateEvent(startedMessage({ task_type: 'local_bash', subagent_type: undefined }), ctx()).taskType === 'local_bash',
    'local_bash يولّد started');
  ok(sdkAgentStateEvent(startedMessage({ task_type: 'remote_agent' }), ctx()) === null,
    'نوع مهمة خارج قائمة السماح لا سطح له');
  ok(sdkAgentStateEvent(startedMessage({ task_type: undefined }), ctx()) === null, 'بلا task_type لا started');

  // (٤) ambient/skip_transcript مستبعدة، والمعرّف المشوّه مرفوض
  ok(sdkAgentStateEvent(startedMessage({ ambient: true }), ctx()) === null, 'مهمة ambient مستبعدة');
  ok(sdkAgentStateEvent(startedMessage({ skip_transcript: true }), ctx()) === null, 'مهمة skip_transcript مستبعدة');
  ok(sdkAgentStateEvent(startedMessage({ task_id: 'BAD-ID' }), ctx()) === null, 'معرّف مهمة مشوّه مرفوض');
  ok(sdkAgentStateEvent(startedMessage({ tool_use_id: 'toolu_bad' }), ctx()).toolUseId === undefined,
    'معرّف أداة مشوّه يُسقط ولا يُسقط الحدث');
  ok(sdkAgentStateEvent({ type: 'assistant' }, ctx()) === null, 'رسالة غير system لا تولّد حدثاً');
  ok(sdkAgentStateEvent({ type: 'system', subtype: 'init', session_id: 'x' }, ctx()) === null,
    'نوع system غير معني لا يولّد حدثاً');
  ok(sdkAgentStateEvent(startedMessage({ spawn_depth: 99 }), ctx()).spawnDepth === undefined,
    'عمق تفريع خارج النطاق يُسقط');

  // (٥) القياس 4: description متغيّر وsummary قد يغيب
  eq(sdkAgentStateEvent(progressMessage(), ctx(TASK_ID)), {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'progress',
    toolUseId: TOOL_USE_A, description: 'Writing PROBE_A.txt',
  }, 'شكل progress بوصف بلا ملخص');
  eq(sdkAgentStateEvent(progressMessage({ summary: 'كتب الملف' }), ctx()), {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'progress',
    toolUseId: TOOL_USE_A, description: 'Writing PROBE_A.txt', summary: 'كتب الملف',
  }, 'شكل progress بالوصف والملخص معاً');
  ok(sdkAgentStateEvent(progressMessage({ description: '', summary: '' }), ctx()) === null,
    'progress بلا وصف ولا ملخص لا يُبثّ');

  // (٦) updated — قائمة سماح للحالات
  eq(sdkAgentStateEvent(updatedMessage({ status: 'completed', end_time: 1789427515767 }), ctx()), {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'updated', status: 'completed',
  }, 'شكل updated من رسالة المسبار (end_time لا يعبر)');
  eq(sdkAgentStateEvent(updatedMessage({ status: 'paused', description: 'انتظار إذن', error: 'رُفض' }), ctx()), {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'updated',
    status: 'paused', description: 'انتظار إذن', error: 'رُفض',
  }, 'updated بحالة ووصف وخطأ');
  eq(sdkAgentStateEvent(updatedMessage({ is_backgrounded: true }), ctx()), {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'updated', backgrounded: true,
  }, 'الانتقال اللاحق إلى الخلفية');
  ok(sdkAgentStateEvent(updatedMessage({ status: 'zombie' }), ctx()) === null, 'حالة خارج قائمة السماح تُسقط');
  ok(sdkAgentStateEvent(updatedMessage({}), ctx()) === null, 'patch فارغ لا يُبثّ');

  // (٧) finished الحقيقي مقابل الكاذب (مفارقة Query المستأنفة المتزامنة)
  const finished = sdkAgentStateEvent(notificationMessage(), ctx(TASK_ID));
  eq(finished, {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'finished',
    status: 'completed', toolUseId: TOOL_USE_A, summary: 'AGENT_DONE_1',
  }, 'شكل finished من إشعار المسبار');
  ok(!JSON.stringify(finished).includes(SECRET_SENTINEL) && !JSON.stringify(finished).includes('usage'),
    'تسرّب output_file أو usage إلى finished');
  ok(sdkAgentStateEvent(notificationMessage({ status: 'stopped' }), ctx()) === null,
    '⭐ إشعار stopped كاذب من Query لم ترَ البداية لا يحسم السطح');
  ok(sdkAgentStateEvent(notificationMessage({ status: 'running' }), ctx(TASK_ID)) === null,
    'حالة إشعار غير ختامية تُسقط');

  // (٨) live بدلالة REPLACE
  eq(sdkAgentStateEvent(liveMessage([
    { task_id: TASK_ID, task_type: 'local_agent', description: 'probe agent' },
    { task_id: OTHER_TASK_ID, task_type: 'local_bash' },
  ]), ctx()), {
    type: 'sdk_agent_state', kind: 'live', taskIds: [TASK_ID, OTHER_TASK_ID],
  }, 'live يحمل القائمة الكاملة بلا وصف ولا نوع');
  eq(sdkAgentStateEvent(liveMessage([]), ctx()), { type: 'sdk_agent_state', kind: 'live', taskIds: [] },
    'القائمة الفارغة = خمول (دلالة REPLACE)');
  eq(sdkAgentStateEvent(liveMessage([
    { task_id: TASK_ID }, { task_id: TASK_ID }, { task_id: OTHER_TASK_ID, ambient: true }, { task_id: 'BAD' }, null,
  ]), ctx()), { type: 'sdk_agent_state', kind: 'live', taskIds: [TASK_ID] },
    'live يستبعد ambient والمكرر والمشوّه');

  // (٩) الأسرار والتحكم والقصّ
  const secretStart = sdkAgentStateEvent(startedMessage({
    description: SECRET_SENTINEL, subagent_type: SECRET_SENTINEL,
  }), ctx());
  eq(secretStart, {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'started',
    description: '', taskType: 'local_agent', backgrounded: true, resumed: false,
    toolUseId: TOOL_USE_A, spawnDepth: 1,
  }, 'النص الذي يلتقطه memory.hasSecret يسقط fail-closed');
  ok(!JSON.stringify(sdkAgentStateEvent(notificationMessage({ summary: SECRET_SENTINEL }), ctx(TASK_ID)))
    .includes(SECRET_SENTINEL), 'ملخص سرّي لا يعبر');
  ok(sdkAgentStateEvent(progressMessage({ description: 'أ\u0000ب\u2066ج' }), ctx()).description === 'أ ب ج',
    'تُنظّف محارف التحكم وBidi');
  ok(Array.from(sdkAgentStateEvent(progressMessage({ description: 'أ'.repeat(400) }), ctx()).description).length === 300,
    'يُطبَّق سقف 300 نقطة Unicode');

  // (١٠) الحسم المحلي
  eq(sdkAgentLocalFinishedEvent(TASK_ID, TOOL_USE_A, 'stopped', 'أُوقفت مهمة Claude الخلفية مع إيقاف الدور.'), {
    type: 'sdk_agent_state', taskId: TASK_ID, kind: 'finished', status: 'stopped', local: true,
    toolUseId: TOOL_USE_A, summary: 'أُوقفت مهمة Claude الخلفية مع إيقاف الدور.',
  }, 'شكل الحسم المحلي بعلامة local');
  ok(sdkAgentLocalFinishedEvent('BAD', TOOL_USE_A, 'stopped', 'x') === null, 'الحسم المحلي يرفض معرّفاً مشوّهاً');
  ok(sdkAgentLocalFinishedEvent(TASK_ID, 'toolu_bad', 'zombie', '').status === 'failed',
    'حالة غير معروفة في الحسم المحلي تسقط إلى failed');
}

// ---------- ب. المتحكم: بقاء Query وسياسة الإيقاف ----------

function makeController(overrides = {}) {
  const events = [];
  const stops = [];
  const log = { closes: 0, holds: 0 };
  const controller = createSdkBackgroundController({
    query: { async backgroundTasks() { return true; }, async stopTask(id) { stops.push(id); } },
    emit: (event) => events.push(event),
    closeInput: () => { log.closes += 1; },
    holdInput: () => { log.holds += 1; },
    isolated: false,
    ...overrides,
  });
  return { controller, events, stops, log };
}

/** تسلسل المسبار الحرفي لدور واحد (الإطلاق حتى الإشعار). */
function playLaunch(controller, { toolUseId = TOOL_USE_A } = {}) {
  controller.observe(liveMessage([{ task_id: TASK_ID, task_type: 'local_agent', description: 'probe agent' }]));
  controller.observe(startedMessage({ tool_use_id: toolUseId }));
  controller.observe(progressMessage({ tool_use_id: toolUseId }));
}

function testQuerySurvival() {
  // ⭐ فحص الطفرة: إسقاط توسيع hasSdkBackgroundTasks (العودة إلى moveStates.size > 0)
  // يُسقط هذه الفحوص الثلاثة — وهو بالضبط العطل الذي كان يقتل وكيل النموذج الخلفي عند
  // الإرسال التالي، لأن main.js لا يُدخل Query في sdkBackgroundRuns إلا بها.
  const live = makeController();
  playLaunch(live.controller);
  ok(live.controller.hasSdkBackgroundTasks() === true,
    '⭐ طفرة: وكيل خلفي بدأه النموذج يُبقي Query حيّة (بلا التوسيع يعود false)');
  ok(live.log.holds === 1, '⭐ طفرة: holdInput عند أول مهمة خلفية حيّة');
  live.controller.markResult();
  ok(live.log.closes === 0, '⭐ طفرة: result لا يغلق input ووكيل النموذج حيّ');

  // القائمة الفارغة (القياس 3) تُفرج — وهي تصل قبل الإشعار الختامي
  live.controller.observe(liveMessage([]));
  ok(live.controller.hasSdkBackgroundTasks() === false, 'القائمة الفارغة = خمول');
  ok(live.log.closes === 1, 'الإفراج عن input عند خلوّ القائمة');

  // دلالة REPLACE: مهمة غابت عن القائمة الجديدة لم تعد حيّة ولو بقيت أخرى
  const replace = makeController();
  replace.controller.observe(liveMessage([{ task_id: TASK_ID }, { task_id: OTHER_TASK_ID }]));
  replace.controller.observe(startedMessage());
  replace.controller.observe(startedMessage({ task_id: OTHER_TASK_ID, tool_use_id: TOOL_USE_B }));
  replace.controller.markResult();
  replace.controller.observe(liveMessage([{ task_id: OTHER_TASK_ID }]));
  ok(replace.controller.hasSdkBackgroundTasks() === true, 'بقاء مهمة واحدة في القائمة يبقي Query');
  ok(replace.log.closes === 0, 'لا إفراج ومهمة من القائمة ما زالت حيّة');
  replace.controller.observe(liveMessage([]));
  ok(replace.log.closes === 1, 'الإفراج بعد خلوّ القائمة كاملةً');

  // الحدّ المُصرَّح به: CLI لا يبثّ background_tasks_changed ⇒ الإشعار الختامي يُفرج
  const noList = makeController();
  noList.controller.observe(startedMessage());
  noList.controller.markResult();
  ok(noList.controller.hasSdkBackgroundTasks() === true && noList.log.closes === 0,
    'بلا قائمة خلفية يبقى الحجز قائماً');
  noList.controller.observe(notificationMessage());
  ok(noList.controller.hasSdkBackgroundTasks() === false && noList.log.closes === 1,
    'الإشعار الختامي يُفرج حين لا تصل القائمة (لا تعليق إلى الأبد)');

  // ونهاية Query هي الحدّ الأخير
  const endOnly = makeController();
  endOnly.controller.observe(startedMessage());
  endOnly.controller.markResult();
  endOnly.controller.finish('failed');
  ok(endOnly.controller.hasSdkBackgroundTasks() === false, 'نهاية Query تُفرج كل شيء');
}

function testLocalFinish() {
  // finish() يحسم **كل مهمة حيّة معروفة**: نقل المستخدم وخلفية النموذج معاً، لا moveStates وحدها
  const { controller, events } = makeController();
  playLaunch(controller); // مهمة النموذج TASK_ID
  controller.observe(startedMessage({ task_id: OTHER_TASK_ID, tool_use_id: TOOL_USE_B, is_backgrounded: false }));
  controller.finish('stopped');
  const localFinishes = events.filter((event) => event.type === 'sdk_agent_state' && event.kind === 'finished');
  eq(localFinishes.map((event) => event.taskId).sort(), [TASK_ID, OTHER_TASK_ID].sort(),
    'الحسم المحلي يشمل مهمة النموذج والمهمة الأمامية التي رأينا بدايتها');
  ok(localFinishes.every((event) => event.local === true && event.status === 'stopped'),
    'كل حسم محلي موسوم local بحالة الإيقاف');
  ok(localFinishes[0].summary === 'أُوقفت مهمة Claude الخلفية مع إيقاف الدور.', 'ملخص عربي ثابت للحسم المحلي');

  // مهمة حُسمت بإشعار حقيقي لا تُحسم ثانيةً محلياً
  const resolved = makeController();
  playLaunch(resolved.controller);
  resolved.controller.observe(notificationMessage());
  const before = resolved.events.length;
  resolved.controller.finish('failed');
  ok(resolved.events.length === before, 'لا حسم محلي مكرر لمهمة وصل إشعارها الختامي');

  // ⭐ فحص طفرة (مراجعة القائد لـPR #160): الوكيل **الأمامي** — الحالة الأشيع — يُحسم بـ
  // `task_updated` بحالة نهائية ولا يصله `task_notification` بالضرورة. بلا إضافته إلى
  // `resolvedTaskIds` في `observe` يبثّ `finish()` له حسماً محلياً كاذباً فتقلب الواجهة
  // «اكتمل» إلى «انتهى مع الدور».
  for (const status of ['completed', 'failed', 'killed']) {
    const foreground = makeController();
    foreground.controller.observe(startedMessage({ is_backgrounded: false }));
    foreground.controller.observe(updatedMessage({ status, end_time: 1789427515767 }));
    const mark = foreground.events.length;
    foreground.controller.finish('stopped');
    ok(foreground.events.length === mark,
      '⭐ طفرة: وكيل أمامي حُسم بـtask_updated{' + status + '} لا يُحسم محلياً عند نهاية Query');
    ok(foreground.controller.ownsSdkTask(TASK_ID) === false,
      'وكيل أمامي محسوم بـtask_updated{' + status + '} لم يعد مملوكاً');
  }

  // ...ومقابله المطلوب: مهمة لم تُحسم (أو حالة غير نهائية) يصلها الحسم المحلي فعلاً
  for (const patch of [{ status: 'running' }, { status: 'paused' }]) {
    const open = makeController();
    open.controller.observe(startedMessage({ is_backgrounded: false }));
    open.controller.observe(updatedMessage(patch));
    open.controller.finish('stopped');
    const local = open.events.filter((event) => event.type === 'sdk_agent_state' && event.kind === 'finished');
    ok(local.length === 1 && local[0].local === true && local[0].status === 'stopped'
      && local[0].taskId === TASK_ID,
      'المهمة الحيّة بحالة ' + patch.status + ' يصلها حسم محلي واحد');
  }

  // والاستئناف بعد الحسم يعيدها حيّة، فتُحسم محلياً إن انتهت Query قبل نتيجتها
  const revived = makeController();
  revived.controller.observe(startedMessage({ is_backgrounded: false }));
  revived.controller.observe(updatedMessage({ status: 'completed' }));
  revived.controller.observe(startedMessage({ is_backgrounded: false, tool_use_id: TOOL_USE_B }));
  revived.controller.finish('stopped');
  ok(revived.events.filter((event) => event.type === 'sdk_agent_state' && event.kind === 'finished').length === 1,
    'الاستئناف بعد حسم task_updated يعيد المهمة حيّة فتُحسم محلياً عند نهاية Query');
}

async function testStopPolicy() {
  // OBS-151: كل مهمة شاهدت هذه Query نفسها task_started لها ولم تُحسم بعد
  const seen = makeController();
  playLaunch(seen.controller);
  ok(seen.controller.ownsSdkTask(TASK_ID) === true, 'المهمة التي رأينا بدايتها مملوكة');
  eq(await seen.controller.stopSdkTask(TASK_ID), { ok: true }, 'إيقاف وكيل النموذج الخلفي مسموح (OBS-151)');
  eq(seen.stops, [TASK_ID], 'وصل المعرّف نفسه إلى query.stopTask');

  // المجهول يبقى مرفوضاً fail-closed ولا يصل SDK
  const unknown = makeController();
  eq(await unknown.controller.stopSdkTask(OTHER_TASK_ID),
    { ok: false, error: 'not_found', message: 'لم تُسجّل هذه المهمة ضمن مهام Claude الخلفية.' },
    'معرّف لم ترَ Query بدايته يُرفض');
  ok(unknown.controller.ownsSdkTask(OTHER_TASK_ID) === false, 'ولا يُسند له مالك');
  eq(unknown.stops, [], 'لم يصل معرّف مرفوض إلى SDK');
  eq(await unknown.controller.stopSdkTask('BAD-ID'), {
    ok: false, error: 'bad_id', message: 'معرّف مهمة Claude غير صالح.',
  }, 'المعرّف المشوّه يُرفض قبل كل شيء');

  // المحسومة لا تُوقف
  const done = makeController();
  playLaunch(done.controller);
  done.controller.observe(notificationMessage());
  ok(done.controller.ownsSdkTask(TASK_ID) === false, 'المهمة المحسومة لم تعد مملوكة');
  eq((await done.controller.stopSdkTask(TASK_ID)).error, 'not_found', 'ولا تُوقف بعد حسمها');

  // الاستئناف يعيدها حيّة فتُوقف من جديد (القياس 2)
  const again = makeController();
  playLaunch(again.controller);
  again.controller.observe(notificationMessage());
  again.controller.observe(liveMessage([{ task_id: TASK_ID }]));
  again.controller.observe(startedMessage({ tool_use_id: TOOL_USE_B }));
  ok(again.controller.ownsSdkTask(TASK_ID) === true, 'الاستئناف يعيد المهمة إلى الحياة بالمعرّف نفسه');
  eq(await again.controller.stopSdkTask(TASK_ID), { ok: true }, 'وتُوقف بعد الاستئناف');

  // الحدّ: بعد انتهاء Query يرفض SDK بـProcessTransport… فلا نستدعيه أصلاً
  const ended = makeController();
  playLaunch(ended.controller);
  ended.controller.finish('failed');
  eq(await ended.controller.stopSdkTask(TASK_ID), {
    ok: false, error: 'no_active_turn', message: 'لا يوجد دور Claude نشط.',
  }, 'بعد انتهاء Query لا إيقاف (ولا استدعاء يرتدّ بخطأ upstream خام)');
  ok(ended.controller.ownsSdkTask(TASK_ID) === false, 'ولا ملكية بعد انتهاء Query');
  eq(ended.stops, [], 'لم يصل استدعاء إلى SDK بعد انتهاء Query');

  // السياق المعزول وCLI الأقدم
  const isolated = makeController({ isolated: true });
  playLaunch(isolated.controller);
  eq((await isolated.controller.stopSdkTask(TASK_ID)).error, 'unsupported', 'السياق المعزول fail-closed');
  eq(isolated.stops, [], 'ولا يصل استدعاء من سياق معزول');
  const oldCli = makeController({ query: { async backgroundTasks() { return true; } } });
  playLaunch(oldCli.controller);
  eq((await oldCli.controller.stopSdkTask(TASK_ID)).error, 'unsupported', 'CLI بلا stopTask يردّ unsupported');
  const throwing = makeController({
    query: { async backgroundTasks() { return true; }, async stopTask() { throw new Error(SECRET_SENTINEL); } },
  });
  playLaunch(throwing.controller);
  const thrown = plain(await throwing.controller.stopSdkTask(TASK_ID));
  ok(thrown.error === 'unsupported' && !JSON.stringify(thrown).includes(SECRET_SENTINEL),
    'خطأ SDK الخام لا يعبر — يُحوَّل إلى رسالة عربية');
}

// ---------- ج. العقود النصّية (main.js والطقم والوثيقة) ----------

function testContracts() {
  const main = read('electron/main.js');
  const agent = read('electron/agent.js');
  const pkg = JSON.parse(read('package.json'));
  const fullSuite = read('scripts/full-suite.js');
  const internals = read('docs/internals/05-claude-sdk-background-tasks.md');
  const subagents = read('docs/internals/40-subagents.md');

  ok(/lateSdkBackgroundEvent[\s\S]{0,400}?obj\.type === 'sdk_agent_state'/.test(main),
    "sdk_agent_state ضمن lateSdkBackgroundEvent في main.js");
  ok(/obj\.type === 'sdk_agent_state' && obj\.kind === 'started'[\s\S]{0,300}?sdkTaskOwners\.set/.test(main),
    'main.js يسجّل مالك المهمة عند بداية سطح الوكلاء');
  ok(/obj\.type === 'sdk_agent_state' && obj\.kind === 'finished'[\s\S]{0,300}?sdkTaskOwners\.delete/.test(main),
    'main.js يسحب المالك عند حسم المهمة');
  ok(/hasSdkBackgroundTasks: \(\) => hasLiveBackgroundWork\(\)/.test(agent),
    'hasSdkBackgroundTasks مشتقّة من العمل الخلفي الحيّ لا من moveStates وحدها');
  ok(/function taskStillOpen\(/.test(agent) && /seenStartedTaskIds\.has\(id\) \|\| modelLiveTasks\.has\(id\)/.test(agent),
    'سياسة الإيقاف الجديدة معلنة في المصدر');

  ok(pkg.scripts['test:sdk-agent-state'] === 'node scripts/sdk-agent-state-test.js',
    'السكربت مسجَّل في package.json');
  ok(/'test:sdk-agent-state',\s*\r?\n\s*'test:sdk-background',/.test(fullSuite),
    'السكربت مسجَّل في SUITE بجانب test:sdk-background');

  ok(internals.includes('قناة حالة الوكلاء الأحياء وبقاء Query (OBS-207/151 — 2026-09-15)'),
    'قسم الوثيقة موجود');
  ok(internals.includes("{type:'sdk_agent_state',kind:'live',taskIds:string[]}"), 'عقد الحدث موثَّق');
  ok(internals.includes('a1cadac9484258db2'), 'معرّف المسبار الحيّ موثَّق');
  ok(subagents.includes('05-claude-sdk-background-tasks.md'), 'إحالة من ملف الوكلاء الفرعيين');
}

(async () => {
  testPureEvent();
  testQuerySurvival();
  testLocalFinish();
  await testStopPolicy();
  testContracts();
  console.log('sdk-agent-state-test: ok — ' + passed
    + ' فحصاً (عقد sdk_agent_state وتنقيته · الاستئناف · دلالة REPLACE · بقاء Query · سياسة الإيقاف الجديدة وحدودها).');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
