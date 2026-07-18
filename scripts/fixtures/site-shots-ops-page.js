// لقطة غرفة العمليات لصفحة الهبوط — المكوّن الإنتاجي الحقيقي مفتوحاً على فريق
// منفّذين جارٍ (نمط opsroom-ui-live: window.satr مزيف يعيد snapshot مجهّزاً).
// الزمن مجمَّد قبل تحميل المكوّن كي تكون اللقطة حتمية byte-for-byte بين تشغيلين
// (ملاحظة مراجعة Codex): كل الأزمنة النسبية والعدادات تُشتق من NOW الثابت.
const NOW = 1789200000000;
Date.now = () => NOW;

let currentTeam = null;

window.satr = {
  opsBrainstormLatest: async () => ({ ok: true, run: null }),
  opsPlanLatest: async () => ({ ok: true, run: null }),
  executionTeamLatest: async () => ({ ok: true, team: currentTeam }),
  executionReviewLatest: async () => ({ ok: true, review: null }),
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

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await customElements.whenDefined('satr-ops-room');
    const room = document.getElementById('room');
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
    await room.open('D:\\projects\\matjar-app');

    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__shotsReady = true;
  } catch (error) {
    window.__shotsError = error && error.stack ? error.stack : String(error);
  }
});
