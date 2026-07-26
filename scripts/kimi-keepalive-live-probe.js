'use strict';

/**
 * مسبار K2 الحي (§7.3): جلسة Kimi حقيقية عبر CLI المثبَّت.
 * يثبت بالأرقام: (1) عملية `kimi acp` تبقى حية بعد end_turn، (2) killAll يقتلها
 * ولا يترك أيتاماً. يعمل في عملية node منفصلة فلا يمسّ سطر الجاري.
 * الاستخدام: node scripts/kimi-keepalive-live-probe.js
 */

const { execSync } = require('child_process');
const kimi = require('../electron/kimi');

function kimiPids() {
  try {
    const out = execSync(
      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name like \'kimi%\'\\" | ForEach-Object { $_.ProcessId }"',
      { encoding: 'utf8', windowsHide: true }
    );
    return out.split(/\r?\n/).map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

function waitFor(predicate, timeout, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > timeout) { reject(new Error('timeout: ' + label)); return; }
      setTimeout(tick, 250);
    };
    tick();
  });
}

(async () => {
  const bin = kimi.resolveKimiBin(true);
  if (!bin) { console.log('SKIP: kimi CLI غير مثبّت'); return; }
  const auth = kimi.authStatus();
  console.log('kimi bin:', bin);
  console.log('auth:', JSON.stringify(auth));
  if (!auth.ok) { console.log('SKIP: kimi غير مسجَّل الدخول'); return; }

  const baseline = kimiPids();
  console.log('baseline kimi processes:', JSON.stringify(baseline));

  const events = [];
  const startedAt = Date.now();
  await kimi.start({
    prompt: 'رد بكلمة واحدة فقط: تم',
    sessionId: null, model: 'k3', permissionMode: 'default',
    skills: [], images: [], browserControl: false,
  }, process.cwd(), (event) => events.push(event));
  await waitFor(
    () => events.some((event) => event.type === 'result' || event.type === 'spawn_error'),
    120000, 'نتيجة الدور الحقيقي'
  );
  const turnMs = Date.now() - startedAt;
  const result = events.find((event) => event.type === 'result');
  const spawnError = events.find((event) => event.type === 'spawn_error');
  if (spawnError) { console.log('FAIL: spawn_error:', spawnError.text); process.exitCode = 1; return; }
  console.log('turn result:', result.subtype, 'في', turnMs, 'ms — session:', result.session_id);

  const live = kimi.keepalive.list();
  console.log('keepalive registry:', JSON.stringify(live.map((item) => item.id)));
  const during = kimiPids();
  const newPids = during.filter((pid) => !baseline.includes(pid));
  console.log('kimi processes after turn:', JSON.stringify(during), '— الجديدة:', JSON.stringify(newPids));
  if (!live.length) { console.log('FAIL: السجل فارغ بعد end_turn'); process.exitCode = 1; return; }
  if (!newPids.length) { console.log('FAIL: لا عملية kimi acp جديدة حية بعد end_turn'); process.exitCode = 1; return; }

  await kimi.keepalive.killAll();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = kimiPids();
  const survivors = after.filter((pid) => newPids.includes(pid));
  console.log('kimi processes after killAll:', JSON.stringify(after), '— بقايا من الجلسة:', JSON.stringify(survivors));
  if (survivors.length) { console.log('FAIL: عمليات يتيمة بعد killAll'); process.exitCode = 1; return; }
  console.log('PASS: keep-alive حي — القناة بقيت بعد end_turn، وkillAll ترك صفر أيتام.');
})().catch((error) => {
  console.error('FAIL:', error.message || error);
  process.exitCode = 1;
});
