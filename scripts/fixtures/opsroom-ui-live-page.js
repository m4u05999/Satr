const violations = [];
const checks = [];
const notices = [];
let currentTeam = null;
window.__opsroomUiLiveProgress = 'loading';

window.satr = {
  opsBrainstormLatest: async () => ({ ok: true, run: null }),
  opsPlanLatest: async () => ({ ok: true, run: null }),
  executionTeamLatest: async () => ({ ok: true, team: currentTeam }),
  executionReviewLatest: async () => ({ ok: true, review: null }),
  executionVerificationLatest: async () => ({ ok: true, verification: null }),
  opsRoomLoad: async () => ({
    ok: true,
    room: { room_id: 'ops-room-live-test', entries: [] },
  }),
  opsRoomHistory: async () => ({ ok: true, rooms: [] }),
};

window.addEventListener('securitypolicyviolation', (event) => {
  violations.push({
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
    sourceFile: event.sourceFile,
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function frames(count = 2) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = setTimeout(finish, Math.max(100, count * 40));
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    }
    function next() {
      if (settled) return;
      if (--count <= 0) finish();
      else requestAnimationFrame(next);
    }
    requestAnimationFrame(next);
  });
}

function agent(state, lastActivityAt, overrides = {}) {
  return {
    id: 'executor-live-1', label: 'عامل 1', task: 'راجع حالة النشاط', engine: 'sdk',
    ownership: ['src/ui/**'], state, summary: '', error: '', failure_code: '', duration_ms: 0,
    permissions: { write_limit: 30, write_used: 1, denied: 0 },
    changes: { files: [], more: 0, partial: false, added: 0, removed: 0 },
    worktree: { isolated: true }, last_tool: 'read', last_file: 'src/ui/components/ops-room.js',
    last_activity_at: lastActivityAt, timeout_ms: 300000, deadline_at: Date.now() + 180000,
    can_extend: true, artifact_ready: false, ...overrides,
  };
}

function team(state, worker, startedAt) {
  return {
    id: 'execution-team-live-test', room_id: 'ops-room-live-test', state,
    created_at: startedAt, updated_at: Date.now(), duration_ms: 0, agents: [worker],
    artifact_id: '', producer_engines: [], mode: 'mergeable', timeout_ms: 300000,
    can_extend: state === 'running', verification: null, merged: false, merge_supported: false,
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-ops-room');
    const room = document.getElementById('room');
    const startedAt = Date.now() - 125000;
    room.addEventListener('ops-notice', (event) => notices.push(event.detail));
    window.__opsroomUiLiveProgress = 'seed-task';
    await room.open('C:\\fixture');
    assert(room.seedTask('مهمة مبذورة من رسالة المستخدم الحالية.'), 'رفض المكوّن بذرة المهمة النصية.');
    await frames(3);

    const root = room.shadowRoot;
    assert(root.querySelector('select[aria-label="عدد عوامل التنفيذ"]').value === '1', 'الافتراضي ليس عاملاً واحداً.');
    assert(root.querySelector('.task').value === 'مهمة مبذورة من رسالة المستخدم الحالية.', 'لم تصل بذرة المهمة إلى العامل الأول.');
    checks.push('seeded-chat-task', 'single-agent-default');

    window.__opsroomUiLiveProgress = 'open-running';
    currentTeam = team('running', agent('running', Date.now() - 20000), startedAt);
    room.handleEvent({ type: 'execution_team_update', team: currentTeam });
    await frames(3);
    const activity = root.querySelector('.observable-activity');
    assert(room.hasAttribute('open'), 'لم تفتح غرفة العمليات في fixture الحي.');
    assert(activity && activity.dataset.activity === 'recent', 'لم تُعرض حالة النشاط الحديث.');
    assert(activity.textContent.includes('آخر نشاط أداة أو ملف قابل للرصد'), 'وصف النشاط الحديث غير دقيق.');
    assert(!activity.textContent.includes('عالق') && !activity.textContent.includes('متوقف'), 'ادعى العرض حالة غير مرصودة.');
    assert(root.querySelector('.elapsed').textContent.startsWith('المدة '), 'لم تُعرض مدة التنفيذ المنقضية.');
    assert(root.querySelector('[data-deadline]').textContent.startsWith('متبقٍ '), 'لم يُعرض العد التنازلي.');
    const nextStep = root.querySelector('.next-step');
    assert(nextStep.getAttribute('aria-live') === 'polite', 'إرشاد الخطوة التالية ليس منطقة حية مهذبة.');
    assert(nextStep.textContent.includes('راقب النشاط'), 'حالة التنفيذ لا تعرض إرشاد الانتظار الصادق.');
    checks.push('recent-observable-activity', 'elapsed-and-deadline', 'truthful-running-guidance');

    // ب‑3: شريط المسار الموجّه حي — خمسة أزرار بترتيبها، إعداد منجزة وتنفيذ حالية،
    // ولكل زر aria-label عربي يحمل حالته.
    const stationButtons = [...root.querySelectorAll('.station-strip button')];
    assert(stationButtons.length === 5, 'شريط المحطات لا يحمل خمسة أزرار.');
    assert(stationButtons.map((b) => b.dataset.station).join(',') === 'setup,execute,review,verify,merge',
      'ترتيب المحطات انحرف عن deriveStations.');
    assert(stationButtons[0].dataset.state === 'completed' && stationButtons[1].dataset.state === 'current',
      'حالتا الإعداد/التنفيذ لا تعكسان فريقاً جارياً.');
    assert(stationButtons.every((b) => /[؀-ۿ]/.test(b.getAttribute('aria-label') || '')),
      'أزرار المحطات بلا aria-label عربي.');
    checks.push('guided-path-live-bar');

    window.__opsroomUiLiveProgress = 'quiet';
    currentTeam = team('running', agent('running', Date.now() - 125000), startedAt);
    room.handleEvent({ type: 'execution_team_update', team: currentTeam });
    await frames(2);
    const quiet = root.querySelector('.observable-activity');
    assert(quiet.dataset.activity === 'quiet', 'لم تُصنّف فترة غياب النشاط المرصود بصدق.');
    assert(quiet.textContent.includes('لم يصل نشاط أداة أو ملف قابل للرصد منذ'), 'وصف غياب النشاط المرصود غير دقيق.');
    assert(!quiet.textContent.includes('عالق') && !quiet.textContent.includes('متوقف'), 'حوّل الصمت إلى ادعاء توقف.');
    checks.push('quiet-without-stall-claim');

    window.__opsroomUiLiveProgress = 'timed-out';
    const timedWorker = agent('timed_out', Date.now() - 125000, {
      error: 'انتهت مهلة العامل المنفّذ.', failure_code: 'timeout', duration_ms: 300000,
      worktree: null, can_extend: false, deadline_at: Date.now() - 1,
    });
    currentTeam = team('timed_out', timedWorker, startedAt);
    currentTeam.duration_ms = 300000;
    room.handleEvent({ type: 'execution_team_update', team: currentTeam });
    room.handleEvent({ type: 'execution_team_update', team: currentTeam });
    await frames(3);
    assert(root.querySelector('.next-step').textContent.includes('ضيّق المهمة أو اختر مهلة أطول'),
      'إرشاد انتهاء المهلة لا يشرح التعافي التالي.');
    assert(root.querySelector('.primary-action').textContent === 'ابدأ فريقاً جديداً',
      'إعادة المحاولة لم تبق فعلاً صريحاً بفريق جديد.');
    assert([...root.querySelectorAll('.live-activity')].some((element) => element.textContent.includes('التعافي المقترح')),
      'إرشاد التعافي المصنّف غير ظاهر.');
    assert(notices.length === 1, `تكرر إشعار الحالة النهائية ${notices.length} مرة.`);
    const timedOutExecute = root.querySelector('.station-strip button[data-station="execute"]');
    assert(timedOutExecute.hasAttribute('data-alert'), 'انتهاء المهلة لا يعلّم محطة التنفيذ ⚠ (ب‑3).');
    checks.push('timeout-recovery-guidance', 'explicit-retry', 'deduplicated-terminal-notice', 'timeout-station-alert');

    // ج «الوضع الآلي»: موافقة واحدة ⇒ السائق يقود مراجعة/تثبيت/تشغيل بلا نقرات،
    // ويتوقف عند بوابة الدمج البشرية بلا أي استدعاء دمج، وتنطفئ الشارة عندها.
    window.__opsroomUiLiveProgress = 'auto-mode';
    const AUTO_AID = 'ab'.repeat(32);
    const satrCalls = [];
    window.satr.loopPreflight = async () => ({ ok: true, head: 'f'.repeat(40), checks: [
      { id: 'test', label: 'اختبار', command: 'node test.js', timeout_seconds: 60 },
    ] });
    window.satr.loopStart = async (cwd, task, ownership, loop, confirmed) => {
      satrCalls.push('loopStart:' + JSON.stringify(ownership) + ':' + loop.max_iterations + ':'
        + loop.budget_tokens + ':' + loop.timeout_seconds + ':' + confirmed);
      return { ok: true, loop: {
        loop_id: 'loop-live-auto', team_id: 'execution-team-live-auto',
        room_id: 'ops-room-live-test', state: 'preparing',
      } };
    };
    window.satr.executionReviewStart = async () => {
      satrCalls.push('review');
      return { ok: true, review: {
        id: 'execution-review-live-auto', team_id: 'execution-team-live-auto', artifact_id: AUTO_AID,
        state: 'running', required_review_engines: ['sdk'], reviews: [],
      } };
    };
    window.satr.executionVerificationPrepare = async () => {
      satrCalls.push('prepare');
      return { ok: true, verification: { artifact_id: AUTO_AID, state: 'pending_confirmation', checks: [
        { id: 'test', label: 'اختبار', command: 'node test.js' },
      ] } };
    };
    window.satr.executionVerificationRun = async () => {
      satrCalls.push('verify');
      return { ok: true, verification: { artifact_id: AUTO_AID, state: 'passed', checks: [] } };
    };
    window.satr.executionMerge = async () => { satrCalls.push('merge'); return { ok: false }; };
    const confirmKinds = [];
    room.addEventListener('ops-confirm-request', (event) => {
      confirmKinds.push(event.detail.kind);
      event.detail.resolve(true);
    });
    currentTeam = null;
    await room.open('C:\\fixture');
    const autoStarted = await room.startAutoRun('مهمة الوضع الآلي الحية.');
    await frames(3);
    assert(autoStarted === true, 'رفض startAutoRun البدء رغم اكتمال الشروط.');
    assert(confirmKinds.length === 1 && confirmKinds[0] === 'auto-start',
      'الوضع الآلي لم يمر بموافقة واحدة مسبقة نوع auto-start (المرصود: ' + confirmKinds.join(',') + ').');
    assert(satrCalls[0] === 'loopStart:["**"]:3:400000:300:true',
      'حدود الحلقة الافتراضية أو الملكية انحرفت: ' + satrCalls[0]);
    const autoBadge = root.querySelector('.auto-mode-badge');
    assert(autoBadge && !autoBadge.hidden, 'شارة «⚡ آلي» غائبة بعد بدء الوضع الآلي.');
    room.handleEvent({ type: 'execution_team_update', team: {
      id: 'execution-team-live-auto', room_id: 'ops-room-live-test', state: 'completed',
      merged: false, merge_supported: true, artifact_id: AUTO_AID, producer_engines: ['sdk'],
      mode: 'mergeable', timeout_ms: 300000, created_at: Date.now() - 60000, updated_at: Date.now(),
      duration_ms: 45000, agents: [agent('completed', Date.now() - 1000, { ownership: ['**'] })],
    } });
    room.handleEvent({ type: 'loop_update', loop_id: 'loop-live-auto',
      team_id: 'execution-team-live-auto', room_id: 'ops-room-live-test', state: 'passed' });
    await frames(4);
    assert(satrCalls.includes('review'), 'السائق لم يستدع المراجعة آلياً بعد نجاح الحلقة.');
    checks.push('auto-single-approval', 'auto-driver-review-no-click');
    room.handleEvent({ type: 'execution_review_update', review: {
      id: 'execution-review-live-auto', team_id: 'execution-team-live-auto', artifact_id: AUTO_AID,
      state: 'completed', required_review_engines: ['sdk'],
      reviews: [{ engine: 'sdk', artifact_id: AUTO_AID, state: 'completed',
        verdict: { schema_version: 1, decision: 'approve', source: 'explicit' } }],
    } });
    await frames(6);
    assert(satrCalls.includes('prepare') && satrCalls.includes('verify'),
      'السائق لم يكمل تثبيت التحقق وتشغيله آلياً: ' + satrCalls.join(','));
    assert(!satrCalls.includes('merge'), 'خرق أمني: استُدعي الدمج آلياً بلا تأكيد بشري.');
    assert(confirmKinds.every((kind) => kind === 'auto-start'),
      'ظهر حوار وسيط رغم الموافقة الواحدة: ' + confirmKinds.join(','));
    assert(autoBadge.hidden, 'الشارة لم تنطفئ عند بلوغ بوابة الدمج.');
    const mergeGateAction = root.querySelector('.primary-action');
    assert(mergeGateAction && mergeGateAction.textContent === 'ادمج الأثر',
      'بوابة الدمج البشرية غير معروضة بعد توقف السائق.');
    checks.push('auto-full-chain-to-merge-gate', 'auto-never-merges');

    assert(violations.length === 0, 'رُصد securitypolicyviolation أثناء اختبار غرفة العمليات.');
    checks.push('zero-csp-violations');
    window.__opsroomUiLiveProgress = 'complete';
    window.__opsroomUiLiveResult = { pass: true, checks, notices, violations };
  } catch (error) {
    window.__opsroomUiLiveResult = {
      pass: false, checks, notices, violations,
      error: error && error.stack ? error.stack : String(error),
    };
  }
});
