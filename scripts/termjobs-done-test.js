'use strict';

/**
 * اختبار K4 «أكمل بالوكيل»: مهمة محدودة تنتهي ⇒ bg_term_done بذيل منقّى.
 * يغطي: التقاط الذيل، حجب الأسرار، القص ≤8000 بعلامة، عدم البث للخوادم الحية،
 * وثبات أنواع حقول الحدث، وسلامة bg_term القائم.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-termjobs-done-'));
process.env.SATR_DEVSERVER_FILE = path.join(temp, 'devservers.json');

const term = require('../electron/term');
const termjobs = require('../electron/termjobs');

const notices = [];
termjobs.setNotifier((event) => notices.push(event));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error('انتهت مهلة: ' + label);
}
function doneEvent(id) { return notices.find((event) => event.type === 'bg_term_done' && event.id === id); }
function cleanupTemp() {
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); }
  catch (error) { console.warn('termjobs-done: تعذّر تنظيف المجلد المؤقت (غير مُفشل): ' + (error && error.message)); }
}

(async () => {
  // وحدة التنقية أولاً (بلا pty): ANSI ومحارف تحكم وأسرار وقص
  const clean = termjobs.scrubDoneTail('\x1b[31mأحمر\x1b[0m\x07 سطر\x00');
  assert.strictEqual(clean, 'أحمر سطر', 'لم تُزَل ANSI ومحارف التحكم');
  const secret = termjobs.scrubDoneTail('مفتاحي هو sk-1234567890abcdef وانتهى');
  assert.ok(!secret.includes('sk-1234567890abcdef') && secret.includes('[secret]'), 'لم يُحجب السر');
  const kv = termjobs.scrubDoneTail('api_key: abcdef123456');
  assert.ok(!kv.includes('abcdef123456') && kv.includes('api_key=[secret]'), 'لم يُحجب زوج key=value');
  const longTail = termjobs.scrubDoneTail('ط'.repeat(20000));
  assert.ok(longTail.length === termjobs.MAX_DONE_TAIL + 1 && longTail.endsWith('…'), 'القص ليس 8000+علامة');

  // 1) مهمة محدودة تخرج طبيعياً: الحدث بكامل حقوله والذيل يلتقط الخرج
  const job1 = termjobs.startJob(temp, 'node -e "console.log(\'DONE_MARK_123\')"', 'مسبار منتهٍ');
  assert(job1.ok, job1.message || job1.error);
  assert(notices.some((event) => event.type === 'bg_term' && event.id === job1.id), 'bg_term القائم لم يُبث');
  const done1 = await waitFor(() => doneEvent(job1.id), 'bg_term_done للمهمة المنتهية');
  assert.strictEqual(typeof done1.id, 'string');
  assert.strictEqual(typeof done1.label, 'string');
  assert.strictEqual(typeof done1.tail, 'string');
  assert.ok(Number.isInteger(done1.exitCode) || done1.exitCode === null, 'exitCode ليس رقماً ولا null');
  assert.strictEqual(done1.exitCode, 0, 'مهمة ناجحة يجب أن تخرج بكود 0');
  assert.strictEqual(done1.label, 'مسبار منتهٍ');
  assert.ok(done1.tail.includes('DONE_MARK_123'), 'الذيل لا يحمل خرج المهمة');

  // 2) حجب الأسرار في الذيل الملتقط
  const job2 = termjobs.startJob(temp, 'node -e "console.log(\'the key sk-a1b2c3d4e5f6g7h8 leaked\')"', 'مهمة سرية');
  assert(job2.ok, job2.message || job2.error);
  const done2 = await waitFor(() => doneEvent(job2.id), 'bg_term_done للمهمة السرية');
  assert.ok(!done2.tail.includes('sk-a1b2c3d4e5f6g7h8'), 'تسرّب السر إلى الذيل');
  assert.ok(done2.tail.includes('[secret]'), 'لا علامة حجب في الذيل');

  // 3) القص: خرج ضخم يُقص عند 8000 محرف بعلامة
  const job3 = termjobs.startJob(temp, 'node -e "console.log(\'x\'.repeat(40000))"', 'مهمة ضخمة');
  assert(job3.ok, job3.message || job3.error);
  const done3 = await waitFor(() => doneEvent(job3.id), 'bg_term_done للمهمة الضخمة');
  assert.ok(done3.tail.length <= termjobs.MAX_DONE_TAIL + 1, 'الذيل تجاوز 8000+علامة: ' + done3.tail.length);
  assert.ok(done3.tail.endsWith('…'), 'الذيل المقصوص بلا علامة');

  // 4) الخوادم الطويلة بلا تغيير: لا bg_term_done ما دامت حية
  const job4 = termjobs.startJob(temp, 'node -e "setInterval(()=>{}, 200)"', 'خادم طويل');
  assert(job4.ok, job4.message || job4.error);
  await delay(2000);
  assert.ok(!doneEvent(job4.id), 'بُث bg_term_done لمهمة ما زالت حية');
  assert(termjobs.info(job4.id), 'المهمة الحية فُقدت من السجل');
  assert(termjobs.stop(job4.id).ok, 'فشل قتل المهمة الطويلة');
  await waitFor(() => !termjobs.info(job4.id), 'حذف المهمة المقتولة');

  term.killAll();
  cleanupTemp();
  console.log('✓ bg_term_done يلتقط ذيل المهمة المنتهية بحقول كاملة الأنواع وexitCode 0');
  console.log('✓ الذيل منقّى: ANSI ومحارف تحكم تُزال، والأسرار تُحجب ببوابة K2 نفسها');
  console.log('✓ القص عند 8000 محرف بعلامة … للخرج الضخم');
  console.log('✓ الخوادم الطويلة الحية لا تُبث الحدث، وbg_term القائم سليم');
  process.exit(0);
})().catch((error) => {
  term.killAll();
  cleanupTemp();
  console.error('termjobs-done:', error && error.stack ? error.stack : error);
  process.exit(1);
});
