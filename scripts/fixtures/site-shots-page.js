// تجهيز محادثة «سطر» الواقعية للقطات صفحة الهبوط — عبر واجهات المكوّن الإنتاجي
// العامة نفسها (addUserMsg/addHistoryAssistant/addStandaloneDiff/showTaskLedger).
// القصة تكمل مشهد الطرفية المكسورة في الموقع: السؤال نفسه، هذه المرة مقروءاً.
import '../../src/ui/components/chat.js';

const ANSWER = [
  'وجدت السبب: الجلسة تُفقد عند التحديث لأن رمز الوصول يُخزَّن في الذاكرة فقط ولا يُستعاد من الكوكي عند الإقلاع.',
  '',
  'ما فعلته:',
  '- أضفت `restoreSession()` في `src/auth/session.js` — عند الإقلاع نقرأ `refresh_token` من كوكي `HttpOnly` ونجدّد رمز الوصول قبل أول طلب.',
  '- أصلحت مقارنة انتهاء الصلاحية: كانت تقارن بالثواني بينما الخادم يرسل ميلي ثانية.',
  '',
  'الاختبارات تمر 14/14 — جرّب الآن: سجّل الدخول ثم حدّث الصفحة، الجلسة تبقى حية.',
].join('\n');

async function stage() {
  await customElements.whenDefined('satr-chat');
  const chat = document.querySelector('satr-chat');

  chat.showTaskLedger({
    schema_version: 1,
    engine: 'sdk',
    session_id: 'shot-session',
    revision: 4,
    state: 'active',
    source: 'TodoWrite',
    updated_at: '2026-07-18T12:00:00Z',
    tasks: [
      { id: 't1', title: 'تشخيص فقدان الجلسة عند التحديث', status: 'completed', dependencies: [], owner: '', evidence: [] },
      { id: 't2', title: 'إصلاح استعادة الرمز من الكوكي', status: 'completed', dependencies: ['t1'], owner: '', evidence: [{ text: 'npm test — ‏14/14', kind: 'test' }] },
      { id: 't3', title: 'تشغيل اختبارات الوحدة', status: 'in_progress', dependencies: ['t2'], owner: '', evidence: [] },
      { id: 't4', title: 'تحديث توثيق تدفق الدخول', status: 'pending', dependencies: ['t3'], owner: '', evidence: [] },
    ],
  });

  // متغير اللقطة: ledger يفرد سجل المهام (لقطة القدرات)، والافتراضي diff
  // يبقيه مطوياً فتظهر بطاقة الفرق كاملة (لقطة الانقلاب)
  const variant = new URLSearchParams(location.search).get('variant') || 'diff';
  if (variant === 'ledger') {
    const ledgerToggle = document.querySelector('.task-ledger-toggle');
    if (ledgerToggle && ledgerToggle.getAttribute('aria-expanded') === 'false') ledgerToggle.click();
  }

  chat.addUserMsg('لماذا يفشل تسجيل الدخول عند تحديث الصفحة؟ افحص @src/auth/session.js وأصلح المشكلة');

  chat.addHistoryAssistant({
    text: ANSWER,
    tools: ['Read', 'Grep', 'Edit', 'run_in_terminal'],
  }, 'Claude — Opus 4.8');

  chat.addStandaloneDiff({
    id: 'shot-diff',
    tool: 'Edit',
    rel: 'src/auth/session.js',
    isNew: false,
    added: 9,
    removed: 2,
    truncated: false,
    noUndo: true,
    lines: [
      { t: 'ctx', text: "import { refreshAccessToken } from './token';", old: 12, new: 12 },
      { t: 'ctx', text: '', old: 13, new: 13 },
      { t: 'del', text: 'let accessToken = null; // يضيع عند التحديث', old: 14, new: null },
      { t: 'add', text: 'let accessToken = null;', old: null, new: 14 },
      { t: 'add', text: '', old: null, new: 15 },
      { t: 'add', text: '// استعادة الجلسة عند الإقلاع من كوكي HttpOnly', old: null, new: 16 },
      { t: 'add', text: 'export async function restoreSession() {', old: null, new: 17 },
      { t: 'add', text: '  const token = await refreshAccessToken();', old: null, new: 18 },
      { t: 'add', text: '  if (!token) return null;', old: null, new: 19 },
      { t: 'add', text: '  scheduleRefresh(token.expires_at - Date.now() - 30_000);', old: null, new: 20 },
      { t: 'add', text: '  return token;', old: null, new: 21 },
      { t: 'add', text: '}', old: null, new: 22 },
      { t: 'del', text: 'if (expiry < now / 1000) logout(); // ثوانٍ مقابل ميلي ثانية!', old: 15, new: null },
      { t: 'ctx', text: 'export function isExpired(expiry) {', old: 16, new: 23 },
    ],
  });

  chat.addNotice('✓ اكتمل الدور — 4 إجراءات وتعديل ملف واحد');

  // مسودة حية في المحرّر — تعطي اللقطة نبض استخدام فعلي
  const input = document.getElementById('input');
  if (input) input.value = 'ممتاز — أضف اختبار e2e لتدفق الدخول بعد التحديث';

  // انتظار الخط والرسم ثم التمرير لقمة الخيط (الالتصاق بالذيل يقصّ البداية)
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const main = document.querySelector('main');
  if (main) main.scrollTop = 0;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.__shotsReady = true;
}

stage().catch((error) => {
  window.__shotsError = error && error.stack ? error.stack : String(error);
});
