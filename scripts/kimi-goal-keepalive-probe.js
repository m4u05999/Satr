'use strict';

/**
 * مسبار K5-ب الحي: استمرارية «الهدف» بين الأدوار عبر قناة keep-alive.
 * جلسة حقيقية تنشئ هدفاً قصير الأمد بمتابعة مؤجلة، ثم end_turn مع بقاء القناة
 * حية، ويلتقط أي kimi_keepalive_event خلال ≤150 ثانية. يوثّق المرصود فعلياً:
 * إن لم يبث Kimi شيئاً رغم بقاء القناة فهذا حدّ upstream (كما ثبت لـ cron في K3-ب).
 * الاستخدام: node scripts/kimi-goal-keepalive-probe.js
 */

const kimi = require('../electron/kimi');

const LATE_WAIT_MS = 150000;

function waitFor(predicate, timeout, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > timeout) { reject(new Error('timeout: ' + label)); return; }
      setTimeout(tick, 500);
    };
    tick();
  });
}

(async () => {
  const bin = kimi.resolveKimiBin(true);
  if (!bin) { console.log('SKIP: kimi CLI غير مثبّت'); return; }
  const auth = kimi.authStatus();
  if (!auth.ok) { console.log('SKIP: kimi غير مسجَّل الدخول'); return; }

  const lateEvents = [];
  const turnEvents = [];
  let handle = null;
  kimi.keepalive.setLateEventSink((evt) => {
    lateEvents.push(evt);
    console.log('LATE_EVENT:', JSON.stringify(evt));
  });

  const startedAt = Date.now();
  handle = await kimi.start({
    prompt: 'أنشئ هدفاً (CreateGoal) مهمته بسيطة: بعد دقيقتين من الآن اكتب رسالة نصها بالضبط «نبضة هدف K5». اضبط متابعة مؤجلة لتحقيقه إن كانت آلية الهدف تتطلب ذلك، ثم أخبرني بالهدف وأنهِ الدور فوراً بلا انتظار.',
    sessionId: null, model: 'k3', permissionMode: 'acceptEdits',
    skills: [], images: [], browserControl: false,
  }, process.cwd(), (event) => {
    turnEvents.push(event);
    if (event.type === 'permission_request' && handle) handle.resolvePermission(event.id, true, false);
  });
  await waitFor(
    () => turnEvents.some((event) => event.type === 'result' || event.type === 'spawn_error'),
    120000, 'نهاية دور إنشاء الهدف'
  );
  const spawnError = turnEvents.find((event) => event.type === 'spawn_error');
  if (spawnError) { console.log('FAIL: spawn_error:', spawnError.text); process.exitCode = 1; return; }
  const result = turnEvents.find((event) => event.type === 'result');
  console.log('turn:', result.subtype, 'في', Date.now() - startedAt, 'ms — session:', result.session_id);

  const registry = kimi.keepalive.list();
  console.log('registry after end_turn:', JSON.stringify(registry.map((item) => item.id)));
  if (!registry.length) { console.log('FAIL: القناة لم تبقَ حية بعد end_turn'); process.exitCode = 1; return; }

  const goalMentioned = turnEvents.some((event) => JSON.stringify(event).match(/goal|هدف|CreateGoal|SetGoalBudget/i));
  console.log('goal activity observed during turn:', goalMentioned);

  console.log('waiting up to', LATE_WAIT_MS / 1000, 's for kimi_keepalive_event…');
  const waitStart = Date.now();
  try {
    await waitFor(() => lateEvents.length > 0, LATE_WAIT_MS, 'حدث متأخر من استمرار الهدف');
    console.log('PASS: وصل', lateEvents.length, 'حدث/أحداث متأخرة بعد', Date.now() - waitStart, 'ms من نهاية الدور');
    for (const evt of lateEvents) {
      console.log('  kind:', evt.kind, '| sessionId:', evt.sessionId, '| at:', evt.at,
        '| tool:', evt.tool || '-', '| status:', evt.status || '-', '| text:', JSON.stringify(String(evt.text || '').slice(0, 200)));
    }
  } catch {
    console.log('UPSTREAM_LIMIT: بقيت القناة حية', Math.round((Date.now() - waitStart) / 1000),
      's بعد نهاية الدور ولم يصل أي kimi_keepalive_event — Kimi لا يبث استمرار الهدف على قناة الجلسة.');
  }

  await kimi.keepalive.killAll();
  console.log('cleanup: killAll done');
})().catch((error) => {
  console.error('FAIL:', error.message || error);
  kimi.keepalive.killAll().finally(() => { process.exitCode = 1; });
});
