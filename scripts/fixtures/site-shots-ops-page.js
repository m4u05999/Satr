// لقطة غرفة العمليات لصفحة الهبوط — المكوّن الإنتاجي الحقيقي مفتوحاً على فريق
// منفّذين جارٍ (نمط opsroom-ui-live: window.satr مزيف يعيد snapshot مجهّزاً).
// الزمن مجمَّد قبل تحميل المكوّن كي تكون اللقطة حتمية byte-for-byte بين تشغيلين
// (ملاحظة مراجعة Codex): كل الأزمنة النسبية والعدادات تُشتق من NOW الثابت.
const NOW = 1789200000000;
Date.now = () => NOW;

// متغيّر اللقطة: 'team' (الافتراضي — فريق جارٍ) أو 'judges' (هيئة القضاة:
// التقرير المدموج + زوايا الصحة/الأمان/التبسيط بعد اكتمال التنفيذ)
const VARIANT = new URLSearchParams(location.search).get('variant') || 'team';

let currentTeam = null;
let currentReview = null;

window.satr = {
  opsBrainstormLatest: async () => ({ ok: true, run: null }),
  opsPlanLatest: async () => ({ ok: true, run: null }),
  executionTeamLatest: async () => ({ ok: true, team: currentTeam }),
  executionReviewLatest: async () => ({ ok: true, review: currentReview }),
  executionVerificationLatest: async () => ({ ok: true, verification: null }),
  opsRoomLoad: async () => ({
    ok: true,
    room: {
      room_id: 'ops-room-shot',
      entries: [
        { id: 'e1', type: 'proposal', actor: 'sdk', text: 'أقترح تقسيم صفحة الطلبات إلى مهمتين مستقلتَي الملكية: واجهة التتبع، ومنطق الحالة.', at: Date.now() - 340000 },
        { id: 'e2', type: 'decision', actor: 'user', text: 'اعتمدت الخطة — نفّذوا بالتوازي مع مراجعة متقاطعة قبل الدمج.', at: Date.now() - 300000 },
      ],
    },
  }),
  opsRoomHistory: async () => ({ ok: true, rooms: [] }),
};

function agent(id, label, task, ownership, lastTool, lastFile, writeUsed) {
  return {
    id, label, task, engine: 'sdk',
    ownership, state: 'running', summary: '', error: '', failure_code: '', duration_ms: 96000,
    permissions: { write_limit: 30, write_used: writeUsed, denied: 0 },
    changes: { files: [], more: 0, partial: false, added: 0, removed: 0 },
    worktree: { isolated: true }, last_tool: lastTool, last_file: lastFile,
    last_activity_at: Date.now() - 9000, timeout_ms: 300000, deadline_at: Date.now() + 190000,
    can_extend: true, artifact_ready: false,
  };
}

// عقدة زاوية مراجعة مكتملة — نفس شكل lenses[] في execution_review_update
function lens(id, decision, risks, notes, recommendation) {
  return {
    lens: id, state: 'completed', duration_ms: 41000, cost: 0.012,
    verdict: { schema_version: 1, decision, source: 'explicit' },
    summary: 'المخاطر:\n- ' + risks + '\nالملاحظات:\n- ' + notes + '\nالتوصية:\n- ' + recommendation,
  };
}

const ARTIFACT = 'c41b7e19a2f04d6b98e3571caf20d8456fb1a9c02d7e34f6885a1b3c9e0d4f72';

// بيانات متغيّر «هيئة القضاة»: فريق مكتمل التنفيذ + مراجعة عمياء بمحرّكين × ثلاث زوايا
function buildJudgesState() {
  const done = (a) => ({
    ...a, state: 'completed', duration_ms: 214000, artifact_ready: true,
    changes: { files: [], more: 0, partial: false, added: 164, removed: 38 },
  });
  currentTeam = {
    id: 'execution-team-shot', room_id: 'ops-room-shot', state: 'completed',
    created_at: Date.now() - 340000, updated_at: Date.now() - 120000, duration_ms: 214000,
    agents: [
      done(agent('executor-1', 'عامل 1', 'بناء واجهة تتبع الطلبات', ['src/pages/orders/**'], 'edit', 'src/pages/orders/tracking.jsx', 9)),
    ],
    artifact_id: ARTIFACT, producer_engines: ['sdk'], mode: 'mergeable', timeout_ms: 300000,
    can_extend: false, verification: null, merged: false, merge_supported: true,
  };
  currentReview = {
    team_id: 'execution-team-shot', artifact_id: ARTIFACT, state: 'completed',
    required_review_engines: ['sdk', 'codex'],
    merged_report: {
      schema_version: 1, truncated: false,
      items: [
        { severity: 'high', lens: 'security', engine: 'codex', text: 'معرّف الطلب يمر في الرابط بلا تحقق ملكية — أي مستخدم يفتح تتبع طلب غيره.' },
        { severity: 'high', lens: 'correctness', engine: 'sdk', text: 'صفحة التتبع تفترض وجود شحنة؛ الطلب الجديد قبل الشحن يكسر العرض.' },
        { severity: 'medium', lens: 'simplicity', engine: 'sdk', text: 'اشتقاق حالة الطلب مكرر في مكوّنين — يُستخرج إلى دالة واحدة تغطيها الاختبارات.' },
        { severity: 'low', lens: 'correctness', engine: 'codex', text: 'نص حالة «قيد التوصيل» غير معالج في مسار الإرجاع.' },
      ],
    },
    reviews: [
      {
        engine: 'sdk', state: 'completed', artifact_id: ARTIFACT, updated_at: Date.now() - 130000,
        verdict: { schema_version: 1, decision: 'changes_required', source: 'explicit' },
        error: '', summary: '',
        lenses: [
          lens('correctness', 'changes_required',
            'صفحة التتبع تفترض وجود شحنة؛ الطلب الجديد قبل الشحن يكسر العرض.',
            'مسارا الإلغاء والإرجاع مغطيان باختبارات واضحة.',
            'أضف حالة «لم تُشحن بعد» ثم أعد المراجعة.'),
          lens('security', 'approve',
            'لا مدخلات خام تصل قاعدة البيانات — الاستعلامات كلها معلمية.',
            'رؤوس التخزين المؤقت سليمة لصفحة خاصة بالمستخدم.',
            'موافقة من زاوية الأمان.'),
          lens('simplicity', 'approve',
            'اشتقاق حالة الطلب مكرر في مكوّنين.',
            'التسمية والبنية واضحتان ومتسقتان مع بقية المشروع.',
            'استخرج الاشتقاق إلى دالة واحدة — لا يمنع الدمج.'),
        ],
      },
      {
        engine: 'codex', state: 'completed', artifact_id: ARTIFACT, updated_at: Date.now() - 121000,
        verdict: { schema_version: 1, decision: 'changes_required', source: 'explicit' },
        error: '', summary: '',
        lenses: [
          lens('correctness', 'approve',
            'التدفق الرئيسي صحيح عبر الحالات الثلاث المجربة.',
            'نص حالة «قيد التوصيل» غير معالج في مسار الإرجاع.',
            'موافقة مع ملاحظة نصية صغيرة.'),
          lens('security', 'changes_required',
            'معرّف الطلب يمر في الرابط بلا تحقق ملكية — أي مستخدم يفتح تتبع طلب غيره.',
            'بقية الأسطح تتحقق من الجلسة قبل القراءة.',
            'أضف تحقق الملكية في الخادم قبل أي دمج.'),
          lens('simplicity', 'approve',
            'لا تعقيد زائداً في البنية الجديدة.',
            'المكوّنات صغيرة وقابلة للاختبار.',
            'موافقة من زاوية التبسيط.'),
        ],
      },
    ],
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-ops-room');
    const room = document.getElementById('room');
    if (VARIANT === 'judges') {
      buildJudgesState();
      // فتح اللوحة على قسم «النتائج» ← «المراجعة» مباشرةً (تفضيل التخطيط المحفوظ)
      const project = 'D:\\projects\\matjar-app'.replace(/\//g, '\\').toLowerCase();
      localStorage.setItem('satr_ops_layout:' + encodeURIComponent(project),
        JSON.stringify({ group: 'results', views: { results: 'review' } }));
    } else {
      currentTeam = {
        id: 'execution-team-shot', room_id: 'ops-room-shot', state: 'running',
        created_at: Date.now() - 96000, updated_at: Date.now(), duration_ms: 96000,
        agents: [
          agent('executor-1', 'عامل 1', 'بناء واجهة تتبع الطلبات', ['src/pages/orders/**'], 'edit', 'src/pages/orders/tracking.jsx', 6),
          agent('executor-2', 'عامل 2', 'منطق حالة الطلب والاختبارات', ['src/state/orders/**', 'tests/orders/**'], 'write', 'tests/orders/status.test.js', 4),
        ],
        artifact_id: '', producer_engines: [], mode: 'mergeable', timeout_ms: 300000,
        can_extend: true, verification: null, merged: false, merge_supported: true,
      };
    }
    await room.open('D:\\projects\\matjar-app');
    if (VARIANT === 'judges') {
      // فرد زوايا مراجعة Codex (فيها حكم الأمان المانع) لتظهر الزوايا الثلاث في اللقطة
      const toggles = room.shadowRoot.querySelectorAll('.view[data-view="review"] .work-card-toggle');
      if (toggles[1]) toggles[1].click();
    }

    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__shotsReady = true;
  } catch (error) {
    window.__shotsError = error && error.stack ? error.stack : String(error);
  }
});
