/**
 * سائق صفحة حارس <satr-agents-live> — سكربت خارجي (‏CSP: script-src 'self')‎.
 *
 * يغذّي المكوّن الإنتاجي بأحداث `sdk_agent_state` **بأشكال `agents-live-probe/result.json`**
 * نفسها (‏task_id · tool_use_id · description · subagent_type · task_type · summary)
 * ويقيس النتيجة من الـShadow الحقيقي. يكتب الحصيلة في `window.__agentsLiveResult`.
 */

const violations = [];
const checks = [];
const stops = [];

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// المعرّفات حرفياً من المسبار الحيّ (‏SDK 0.3.270) — لا معرّفات مخترعة الشكل
const TASK_ID = 'a1cadac9484258db2';
const TOOL_USE_1 = 'toolu_01Fe9aJLKrhbVCLfAmJmMty7';
const TOOL_USE_2 = 'toolu_01LNHDNVCgrHk1sKiCesmZqF';

// وصفان طويلان يكفيان للفّ سطر كامل — شرط قياس الرسوّ بالبكسل (السطر الأول يملأ العرض)
const LATIN_PREFIXED_ARABIC = 'SHA-256 للحزمة قبل الرفع، ثم يكتب الوكيل تقرير التحقق في ملف '
  + 'النتائج ويعيد الملخّص إلى القائد مع أرقام الأسطر التي لمسها في هذه الجولة كاملةً.';
const PURE_LATIN = 'Writing PROBE_A.txt and then verifying the checksum of the produced bundle '
  + 'before the reviewer picks it up from the shared mirror directory for the next stage.';

function started(taskId, over) {
  return Object.assign({
    type: 'sdk_agent_state', taskId, kind: 'started',
    toolUseId: TOOL_USE_1, description: 'probe agent', subagentType: 'general-purpose',
    taskType: 'local_agent', backgrounded: true, spawnDepth: 1, resumed: false,
  }, over || {});
}
function progress(taskId, over) {
  return Object.assign({ type: 'sdk_agent_state', taskId, kind: 'progress', toolUseId: TOOL_USE_1 }, over || {});
}
function updated(taskId, over) {
  return Object.assign({ type: 'sdk_agent_state', taskId, kind: 'updated' }, over || {});
}
function finished(taskId, over) {
  return Object.assign({
    type: 'sdk_agent_state', taskId, kind: 'finished', toolUseId: TOOL_USE_1, status: 'completed',
  }, over || {});
}

function rowsOf(el) {
  return [...el.shadowRoot.querySelectorAll('.row')];
}
function badgeOf(el, taskId) {
  const row = el.shadowRoot.querySelector('.row[data-task-id="' + taskId + '"]');
  return row ? row.querySelector('.badge').textContent : '';
}

/** موضع أول محرف بالبكسل — الدليل الوحيد على رسوّ الاتجاه (القاعدة ٣ في CLAUDE.md). */
function anchorOf(element) {
  const node = element.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.length) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  const first = range.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  if (!first.width && !first.height) return null;
  const fromRight = box.right - first.right;
  const fromLeft = first.left - box.left;
  return { anchor: fromRight <= fromLeft ? 'rtl' : 'ltr', fromRight, fromLeft };
}

async function run(el) {
  // ---------- ١. صف واحد للإطلاق والاستئناف بالمعرّف نفسه ----------
  el.applyAgentState(started(TASK_ID));
  assert(rowsOf(el).length === 1, 'الإطلاق يجب أن ينشئ صفاً واحداً.');
  assert(badgeOf(el, TASK_ID) === 'يعمل في الخلفية', 'شارة الإطلاق الخلفي غير متوقعة.');
  el.applyAgentState(progress(TASK_ID, { description: 'Writing PROBE_A.txt' }));
  el.applyAgentState(finished(TASK_ID, { status: 'completed', summary: 'AGENT_DONE_1' }));
  assert(badgeOf(el, TASK_ID) === 'اكتمل', 'الخاتمة الأولى يجب أن تقول «اكتمل».');
  // الاستئناف: `started` جديد بالمعرّف نفسه و`toolUseId` جديد و`resumed: true`
  el.applyAgentState(started(TASK_ID, { toolUseId: TOOL_USE_2, resumed: true }));
  assert(rowsOf(el).length === 1, 'الاستئناف يجب ألا ينشئ صفاً ثانياً.');
  let snap = el.snapshot();
  assert(snap[0].resumes === 1, 'عدّاد الاستئناف لم يتقدّم.');
  const resumesText = el.shadowRoot.querySelector('.row .resumes').textContent;
  assert(resumesText === 'استُؤنف ×2', 'نص عدّاد الاستئناف غير متوقع: ' + resumesText);
  assert(badgeOf(el, TASK_ID) === 'يعمل في الخلفية', 'الاستئناف يجب أن يعيد الصف حياً.');
  checks.push('single-row-across-resume');

  // ---------- ٢. الشارات الثماني ----------
  el.reset();
  const badges = [];
  el.applyAgentState(started('badgea1', { backgrounded: false }));
  badges.push(badgeOf(el, 'badgea1'));                         // يعمل
  el.applyAgentState(started('badgeb2', { backgrounded: true }));
  badges.push(badgeOf(el, 'badgeb2'));                         // يعمل في الخلفية
  el.applyAgentState(started('badgec3', { backgrounded: false }));
  el.setWaitingPermission('badgec3', 'Write', 'perm-badge-3');
  badges.push(badgeOf(el, 'badgec3'));                         // ينتظر إذنك: Write
  el.applyAgentState(started('badged4', { backgrounded: false }));
  el.applyAgentState({ type: 'sdk_agent_state', kind: 'live', taskIds: ['badgea1', 'badgeb2', 'badgec3'] });
  badges.push(badgeOf(el, 'badged4'));                         // يُحسم…
  el.applyAgentState(started('badgee5'));
  el.applyAgentState(finished('badgee5', { status: 'completed' }));
  badges.push(badgeOf(el, 'badgee5'));                         // اكتمل
  el.applyAgentState(started('badgef6'));
  el.applyAgentState(finished('badgef6', { status: 'failed', summary: 'رفض الإذن' }));
  badges.push(badgeOf(el, 'badgef6'));                         // فشل
  el.applyAgentState(started('badgeg7'));
  el.applyAgentState(finished('badgeg7', { status: 'stopped' }));
  badges.push(badgeOf(el, 'badgeg7'));                         // أُوقف
  el.applyAgentState(started('badgeh8'));
  el.applyAgentState(finished('badgeh8', { status: 'stopped', local: true }));
  badges.push(badgeOf(el, 'badgeh8'));                         // انتهى مع الدور
  const expectedBadges = ['يعمل', 'يعمل في الخلفية', 'ينتظر إذنك: Write', 'يُحسم…',
    'اكتمل', 'فشل', 'أُوقف', 'انتهى مع الدور'];
  assert(JSON.stringify(badges) === JSON.stringify(expectedBadges),
    'الشارات الثماني غير مطابقة: ' + JSON.stringify(badges));
  // «مسح المنتهي» يزيل المنتهي وحده ويُبقي الحيّ
  el.shadowRoot.querySelector('.clear').click();
  assert(rowsOf(el).length === 4, 'زر «مسح المنتهي» يجب أن يبقي الصفوف الحيّة الأربعة.');
  checks.push('eight-badges');

  // ---------- ٣. دلالة REPLACE في `live` ----------
  el.reset();
  el.applyAgentState(started('liveaa1'));
  el.applyAgentState({ type: 'sdk_agent_state', kind: 'live', taskIds: ['liveaa1'] });
  assert(badgeOf(el, 'liveaa1') === 'يعمل في الخلفية', 'الحاضر في `live` يجب أن يبقى حياً.');
  el.applyAgentState({ type: 'sdk_agent_state', kind: 'live', taskIds: [] });
  assert(badgeOf(el, 'liveaa1') === 'يُحسم…', 'الغائب عن `live` بلا `finished` يجب أن يقول «يُحسم…».');
  el.applyAgentState({ type: 'sdk_agent_state', kind: 'live', taskIds: ['liveaa1'] });
  assert(badgeOf(el, 'liveaa1') === 'يعمل في الخلفية', 'عودته إلى `live` يجب أن تفكّ «يُحسم…».');
  el.applyAgentState({ type: 'sdk_agent_state', kind: 'live', taskIds: [] });
  el.applyAgentState(finished('liveaa1', { status: 'completed', summary: 'AGENT_DONE_2' }));
  assert(badgeOf(el, 'liveaa1') === 'اكتمل', '`finished` بعد الغياب يجب أن يحسم الصف.');
  checks.push('live-replace-semantics');

  // ---------- ٣ب. لا يُعاد حسم صفٍّ محسوم (مراجعة القائد على PR #161) ----------
  // المحرّك يبثّ finished{local:true} عند انتهاء Query لكل مهمة رآها، فقد يصل لوكيلٍ
  // أُنهي صفّه قبله — وقلبُ «اكتمل» إلى «انتهى مع الدور» تراجعٌ في الدقة لا تحديث.
  el.reset();
  el.applyAgentState(started('reaa001', { backgrounded: false }));
  el.applyAgentState(updated('reaa001', { status: 'completed' }));
  assert(badgeOf(el, 'reaa001') === 'اكتمل', '`updated{completed}` لم يحسم الصف «اكتمل».');
  assert(el.applyAgentState(finished('reaa001', { status: 'stopped', local: true })) === false,
    'قُبل حسم محلي على صفٍّ محسوم أصلاً.');
  assert(badgeOf(el, 'reaa001') === 'اكتمل',
    '`finished{local:true}` قلب «اكتمل» إلى «انتهى مع الدور».');
  // الاستثناء الوحيد: الحسم المحلي يقبل خاتمةً حقيقية لاحقة — إشعار الوكيل أدقّ
  el.applyAgentState(started('rebb002', { backgrounded: false }));
  el.applyAgentState(finished('rebb002', { status: 'stopped', local: true }));
  assert(badgeOf(el, 'rebb002') === 'انتهى مع الدور', 'الحسم المحلي لم يظهر.');
  assert(el.applyAgentState(finished('rebb002', { status: 'completed', summary: 'AGENT_DONE_2' })) === true,
    'رُفضت الخاتمة الحقيقية بعد حسم محلي.');
  assert(badgeOf(el, 'rebb002') === 'اكتمل', 'الخاتمة الحقيقية لم تصحّح الحسم المحلي.');
  assert(el.applyAgentState(finished('rebb002', { status: 'stopped', local: true })) === false,
    'حسم محلي ثانٍ قُبل بعد الخاتمة الحقيقية.');
  assert(badgeOf(el, 'rebb002') === 'اكتمل', 'حسم محلي ثانٍ قلب الخاتمة الحقيقية.');
  checks.push('finished-not-redecided');

  // ---------- ٣ج. القبول الحي (2026-09-15): الإشعار الحقيقي بعد `updated`، والاستئناف من Query جديدة ----------
  // القياس الحي: `updated{completed}` يسبق `task_notification` فكان الملخّص الختامي يضيع؛
  // والاستئناف بـSendMessage يصل من Query جديدة بـ`resumed:false` فبقي العدّاد صفراً.
  el.reset();
  el.applyAgentState(started('livef01', { backgrounded: true, toolUseId: 'toolu_01Fe9aJLKrhbVCLfAmJmMty7' }));
  el.applyAgentState(updated('livef01', { status: 'completed' }));
  assert(badgeOf(el, 'livef01') === 'اكتمل', 'الصف لم يُحسم بـupdated.');
  assert(el.applyAgentState(finished('livef01', { status: 'completed', summary: 'AGENT_DONE_1' })) === true,
    'رُفض الإشعار الحقيقي بعد updated{completed}.');
  const liveRow = () => el.snapshot().find((r) => r.taskId === 'livef01');
  assert(liveRow().summary === 'AGENT_DONE_1', 'الملخّص الختامي من الإشعار الحقيقي لم يُعرض: ' + JSON.stringify(liveRow().summary));
  assert(badgeOf(el, 'livef01') === 'اكتمل', 'الإشعار الحقيقي غيّر الشارة خطأً.');
  el.applyAgentState(started('livef01', { backgrounded: true, resumed: false, toolUseId: 'toolu_01LNHDNVCgrHk1sKiCesmZqF' }));
  assert(rowsOf(el).length === 1, 'الاستئناف من Query جديدة أنشأ صفاً ثانياً.');
  assert(liveRow().resumes === 1, 'عدّاد الاستئناف لم يزد رغم بداية ثانية لصف منتهٍ: ' + liveRow().resumes);
  assert(badgeOf(el, 'livef01') === 'يعمل في الخلفية', 'الاستئناف لم يُحيِ الصف.');
  assert(el.applyAgentState(finished('livef01', { status: 'stopped', local: true })) === true, 'الحسم المحلي لصف حيّ رُفض.');
  assert(el.applyAgentState(finished('livef01', { status: 'stopped', local: true })) === false, 'حسم محلي ثانٍ على صف منتهٍ قُبل.');
  checks.push('live-findings-summary-and-resume');

  // ---------- ٤. «ينتظر إذنك» ثم زوالها بالمعرّف ----------
  el.reset();
  el.applyAgentState(started('permaa1', { backgrounded: false }));
  el.setWaitingPermission('permaa1', 'Write', 'perm-42');
  assert(badgeOf(el, 'permaa1') === 'ينتظر إذنك: Write', 'شارة انتظار الإذن غائبة.');
  assert(el.clearWaitingPermission('perm-99') === false, 'معرّف طلب آخر يجب ألا يفكّ الانتظار.');
  assert(badgeOf(el, 'permaa1') === 'ينتظر إذنك: Write', 'الانتظار زال بمعرّف خاطئ.');
  el.clearWaitingPermission('perm-42');
  assert(badgeOf(el, 'permaa1') === 'يعمل', 'الانتظار لم يزل بمعرّفه الصحيح.');
  checks.push('permission-wait-and-clear');

  // ---------- ٥. زر الإيقاف يبثّ الحدث ويعود عند failStop ----------
  el.reset();
  el.applyAgentState(started('stopaa1'));
  const stopBtn = el.shadowRoot.querySelector('.row[data-task-id="stopaa1"] .stop');
  assert(stopBtn && !stopBtn.hidden, 'زر الإيقاف غائب عن صف حيّ.');
  stopBtn.click();
  assert(stops.length === 1 && stops[0].taskId === 'stopaa1', 'لم يُبثّ agent-stop-request بالمعرّف.');
  assert(stopBtn.disabled === true && stopBtn.textContent === 'يُوقَف…', 'زر الإيقاف لم ينتقل لحالة الانتظار.');
  el.failStop('stopaa1', 'تعذّر إيقاف هذا الوكيل الفرعي.');
  assert(stopBtn.disabled === false && stopBtn.textContent === '⏹ إيقاف', 'الزر لم يعد بعد رفض الإيقاف.');
  const stopMsg = el.shadowRoot.querySelector('.row[data-task-id="stopaa1"] .prog').textContent;
  assert(stopMsg === 'تعذّر إيقاف هذا الوكيل الفرعي.', 'رسالة رفض الإيقاف العربية غائبة.');
  // الصف المنتهي: لا زر إيقاف، ويظهر زر الإخفاء
  el.applyAgentState(finished('stopaa1', { status: 'stopped' }));
  assert(stopBtn.hidden === true, 'زر الإيقاف يجب أن يختفي بعد الخاتمة.');
  el.shadowRoot.querySelector('.row[data-task-id="stopaa1"] .hide').click();
  assert(el.snapshot()[0].hiddenRow === true, 'زر «×» لم يُخفِ الصف المنتهي.');
  checks.push('stop-request-and-fail-return');

  // ---------- ٦. الإخفاء التام عند الخلو (ارتفاع مقيس) ----------
  el.reset();
  await delay(60);
  const emptyBox = el.getBoundingClientRect();
  assert(getComputedStyle(el).display === 'none', 'الشريط ليس display:none عند الخلو.');
  assert(emptyBox.height === 0, 'الشريط يحجز ارتفاعاً عند الخلو: ' + emptyBox.height);
  el.applyAgentState(started('showaa1'));
  await delay(60);
  assert(el.getBoundingClientRect().height > 0, 'الشريط لم يظهر بوجود صف.');
  // إخفاء الصف الوحيد بعد انتهائه يعيد الشريط إلى الاختفاء التام
  el.applyAgentState(finished('showaa1', { status: 'completed' }));
  el.shadowRoot.querySelector('.row[data-task-id="showaa1"] .hide').click();
  await delay(60);
  assert(el.getBoundingClientRect().height === 0, 'إخفاء آخر صف لم يُخفِ الشريط.');
  checks.push('zero-height-when-empty');

  // ---------- ٧. رسوّ الاتجاه بالبكسل ----------
  el.reset();
  el.applyAgentState(started('diraa01', { backgrounded: false }));
  el.applyAgentState(progress('diraa01', { description: LATIN_PREFIXED_ARABIC }));
  el.applyAgentState(started('dirbb02', { backgrounded: false }));
  el.applyAgentState(progress('dirbb02', { description: PURE_LATIN }));
  await delay(90);
  const arProg = el.shadowRoot.querySelector('.row[data-task-id="diraa01"] .prog');
  const laProg = el.shadowRoot.querySelector('.row[data-task-id="dirbb02"] .prog');
  const arMeasure = anchorOf(arProg);
  const laMeasure = anchorOf(laProg);
  assert(arMeasure && laMeasure, 'تعذّر قياس موضع أول محرف.');
  assert(arProg.getAttribute('dir') === 'rtl',
    'سطر التقدّم العربي الجوهر البادئ برمز لاتيني لم يُحسم rtl.');
  assert(arMeasure.anchor === 'rtl',
    'رسا السطر العربي الجوهر ' + arMeasure.anchor + ' (fromRight=' + Math.round(arMeasure.fromRight)
    + '، fromLeft=' + Math.round(arMeasure.fromLeft) + ').');
  assert(laProg.getAttribute('dir') === 'ltr', 'سطر التقدّم اللاتيني الصرف لم يُحسم ltr.');
  assert(laMeasure.anchor === 'ltr',
    'رسا السطر اللاتيني ' + laMeasure.anchor + ' (fromRight=' + Math.round(laMeasure.fromRight)
    + '، fromLeft=' + Math.round(laMeasure.fromLeft) + ').');
  checks.push('direction-anchor-pixels');

  // ---------- ٨. فحص طفرة: لو حُسم السطر بـdir="auto" بدل textDir لرسا LTR ----------
  // (‏`plaintext`/`auto` يحسمان من أول حرف قوي — وهو `S` في «SHA-256 …»)
  const mutant = arProg.cloneNode(true);
  mutant.setAttribute('dir', 'auto');
  mutant.style.textAlign = '';
  arProg.parentNode.appendChild(mutant);
  await delay(60);
  const mutantMeasure = anchorOf(mutant);
  mutant.remove();
  assert(mutantMeasure, 'تعذّر قياس نسخة الطفرة.');
  assert(mutantMeasure.anchor === 'ltr',
    'فحص الطفرة بلا أسنان: dir="auto" رسا ' + mutantMeasure.anchor + ' لا ltr، '
    + 'فالقياس أعلاه لا يميّز الحسم الإحصائي من الحسم بأول حرف قوي.');
  checks.push('mutation-dir-auto-detected');

  // ---------- ٩. رفض المعرّفات المشوّهة ----------
  el.reset();
  assert(el.applyAgentState(started('BAD-ID')) === false, 'مُرّر taskId بحروف كبيرة وشرطة.');
  assert(el.applyAgentState(started('abc')) === false, 'مُرّر taskId أقصر من ستة محارف.');
  assert(el.applyAgentState({ type: 'sdk_agent_state', kind: 'progress', taskId: 'a'.repeat(65) }) === false,
    'مُرّر taskId أطول من 64 محرفاً.');
  assert(rowsOf(el).length === 0, 'أُنشئ صف من معرّف مشوّه.');
  el.applyAgentState(started('goodaa1', { toolUseId: 'toolu_short' }));
  assert(el.snapshot().length === 1, 'الصف السليم لم يُنشأ.');
  // النصوص تُقصّ إلى 300 محرفاً
  el.applyAgentState(progress('goodaa1', { description: 'ب'.repeat(400) }));
  const clipped = el.shadowRoot.querySelector('.row[data-task-id="goodaa1"] .prog').textContent;
  assert(clipped.length === 300, 'لم يُقصّ نص التقدّم إلى 300: ' + clipped.length);
  checks.push('malformed-ids-rejected');

  // ---------- ١٠. حدّ الخمسين صفاً منتهياً ----------
  el.reset();
  for (let i = 0; i < 60; i += 1) {
    const id = 'cap' + String(i + 100000);
    el.applyAgentState(started(id));
    el.applyAgentState(finished(id, { status: 'completed' }));
  }
  assert(rowsOf(el).length === 50, 'حدّ الصفوف المنتهية ليس 50: ' + rowsOf(el).length);
  assert(!el.shadowRoot.querySelector('.row[data-task-id="cap100000"]'), 'الأقدم لم يسقط.');
  assert(el.shadowRoot.querySelector('.row[data-task-id="cap100059"]'), 'الأحدث سقط خطأً.');
  checks.push('finished-rows-capped');

  el.reset();
  checks.push('zero-csp-violations');
  return { badges, arMeasure, laMeasure, mutantMeasure };
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-agents-live');
    const el = document.querySelector('satr-agents-live');
    el.addEventListener('agent-stop-request', (event) => stops.push(event.detail));
    const extra = Object.assign({}, await run(el));
    window.__agentsLiveResult = Object.assign({ pass: true, checks, violations }, extra);
  } catch (error) {
    window.__agentsLiveResult = {
      pass: false, checks, violations,
      error: (error && error.message) || String(error),
    };
  }
});
