'use strict';

/**
 * مسبار K3-ب الحي: ثمرة K2 — نشاط cron بين الأدوار عبر قناة keep-alive.
 * جلسة حقيقية تنشئ cron لمرة واحدة يطلق خلال دقيقة–دقيقتين، ثم end_turn مع بقاء
 * القناة حية، ويلتقط وصول kimi_keepalive_event فعلياً (النوع/الحقول/التجميع).
 * يوثّق المرصود فعلياً: إن لم يُطلق Kimi الحدث رغم بقاء القناة فهذا حدّ upstream.
 * الاستخدام: node scripts/kimi-cron-keepalive-probe.js
 */

const kimi = require('../electron/kimi');

const LATE_WAIT_MS = 150000; // cron بدقة دقيقة: نمنح حتى 2.5 دقيقة بعد نهاية الدور

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
    prompt: 'أنشئ تذكيراً مجدولاً لمرة واحدة فقط (CronCreate بـ recurring: false) يطلق في أقرب دقيقة ممكنة من الآن، نصه بالضبط: «نبضة keep-alive من K3». أنشئه فوراً ثم أخبرني برقم المهمة وأنهِ الدور بلا أي انتظار.',
    sessionId: null, model: 'k3', permissionMode: 'acceptEdits',
    skills: [], images: [], browserControl: false,
  }, process.cwd(), (event) => {
    turnEvents.push(event);
    if (event.type === 'permission_request' && handle) handle.resolvePermission(event.id, true, false);
  });
  await waitFor(
    () => turnEvents.some((event) => event.type === 'result' || event.type === 'spawn_error'),
    120000, 'نهاية دور إنشاء cron'
  );
  const spawnError = turnEvents.find((event) => event.type === 'spawn_error');
  if (spawnError) { console.log('FAIL: spawn_error:', spawnError.text); process.exitCode = 1; return; }
  const result = turnEvents.find((event) => event.type === 'result');
  const turnMs = Date.now() - startedAt;
  console.log('turn:', result.subtype, 'في', turnMs, 'ms — session:', result.session_id);

  const registry = kimi.keepalive.list();
  console.log('registry after end_turn:', JSON.stringify(registry.map((item) => item.id)));
  if (!registry.length) { console.log('FAIL: القناة لم تبقَ حية بعد end_turn'); process.exitCode = 1; return; }

  const cronMentioned = turnEvents.some((event) => JSON.stringify(event).match(/cron|مجدول|تذكير|km_|job/i));
  console.log('cron activity observed during turn:', cronMentioned);

  console.log('waiting up to', LATE_WAIT_MS / 1000, 's for kimi_keepalive_event…');
  const waitStart = Date.now();
  try {
    await waitFor(() => lateEvents.length > 0, LATE_WAIT_MS, 'حدث متأخر من cron');
    const lateMs = Date.now() - waitStart;
    console.log('PASS: وصل', lateEvents.length, 'حدث/أحداث متأخرة بعد', lateMs, 'ms من نهاية الدور');
    for (const evt of lateEvents) {
      console.log('  kind:', evt.kind, '| sessionId:', evt.sessionId, '| at:', evt.at,
        '| tool:', evt.tool || '-', '| status:', evt.status || '-', '| text:', JSON.stringify(String(evt.text || '').slice(0, 200)));
    }
  } catch {
    console.log('UPSTREAM_LIMIT: بقيت القناة حية', Math.round((Date.now() - waitStart) / 1000),
      's بعد نهاية الدور ولم يصل أي kimi_keepalive_event — Kimi لا يبث إطلاق cron على قناة الجلسة.');
  }

  await kimi.keepalive.killAll();
  console.log('cleanup: killAll done');
})().catch((error) => {
  console.error('FAIL:', error.message || error);
  kimi.keepalive.killAll().finally(() => { process.exitCode = 1; });
});
