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
    currentTeam = team('running', agent('running', Date.now() - 20000), startedAt);
    room.addEventListener('ops-notice', (event) => notices.push(event.detail));
    window.__opsroomUiLiveProgress = 'open-running';
    await room.open('C:\fixture');
    await frames(3);

    const root = room.shadowRoot;
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
    checks.push('timeout-recovery-guidance', 'explicit-retry', 'deduplicated-terminal-notice');

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
