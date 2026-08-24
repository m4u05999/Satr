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
  const longTail = termjobs.scrubDoneTail('بداية-' + 'ط'.repeat(20000) + '-نهاية');
  assert.ok(longTail.length === termjobs.MAX_DONE_TAIL + 1 && longTail.startsWith('…'), 'القص ليس 8000+علامة');
  assert.ok(longTail.endsWith('-نهاية'), 'القص لم يحتفظ بالنهاية الفعلية للخرج');

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

  // 2) كود الفشل الأصلي يصل للواجهة ولا يتحول إلى نجاح بسبب exit العاري
  const failedJob = termjobs.startJob(temp, 'node -e "process.exit(7)"', 'مهمة فاشلة');
  assert(failedJob.ok, failedJob.message || failedJob.error);
  const failedDone = await waitFor(() => doneEvent(failedJob.id), 'bg_term_done للمهمة الفاشلة');
  assert.strictEqual(failedDone.exitCode, 7, 'غلاف الصدفة أخفى كود فشل المهمة');

  // 3) حجب الأسرار في الذيل الملتقط
  const job2 = termjobs.startJob(temp, 'node -e "console.log(\'the key sk-a1b2c3d4e5f6g7h8 leaked\')"', 'مهمة سرية');
  assert(job2.ok, job2.message || job2.error);
  const done2 = await waitFor(() => doneEvent(job2.id), 'bg_term_done للمهمة السرية');
  assert.ok(!done2.tail.includes('sk-a1b2c3d4e5f6g7h8'), 'تسرّب السر إلى الذيل');
  assert.ok(done2.tail.includes('[secret]'), 'لا علامة حجب في الذيل');

  // 4) القص: خرج ضخم يحتفظ بنهاية الخرج عند 8000 محرف بعلامة
  const job3 = termjobs.startJob(temp, 'node -e "console.log(\'x\'.repeat(40000) + \'TAIL_MARK_789\')"', 'مهمة ضخمة');
  assert(job3.ok, job3.message || job3.error);
  const done3 = await waitFor(() => doneEvent(job3.id), 'bg_term_done للمهمة الضخمة');
  assert.ok(done3.tail.length <= termjobs.MAX_DONE_TAIL + 1, 'الذيل تجاوز 8000+علامة: ' + done3.tail.length);
  assert.ok(done3.tail.startsWith('…'), 'الذيل المقصوص بلا علامة');
  assert.ok(done3.tail.includes('TAIL_MARK_789'), 'الذيل المقصوص لا يحمل نهاية الخرج');

  // 5) الخوادم الطويلة بلا تغيير: لا bg_term_done ما دامت حية
  const job4 = termjobs.startJob(temp, 'node -e "setInterval(()=>{}, 200)"', 'خادم طويل');
  assert(job4.ok, job4.message || job4.error);
  await delay(2000);
  assert.ok(!doneEvent(job4.id), 'بُث bg_term_done لمهمة ما زالت حية');
  assert(termjobs.info(job4.id), 'المهمة الحية فُقدت من السجل');
  assert(termjobs.stop(job4.id).ok, 'فشل قتل المهمة الطويلة');
  await waitFor(() => !termjobs.info(job4.id), 'حذف المهمة المقتولة');

  // ── توصيل bg_term_done إلى النموذج (دفعة 2026-08-24) ──────────────────────────
  // العقد الجديد **إضافي**: كل ما سبق بقي كما هو، وهذه الطبقات الثلاث تُوصله للنموذج.

  // 6) سقف تنقية قابل للتوسيع: get_background_output يقرأ سجلاً أطول بنفس التنقية
  const wide = termjobs.scrubDoneTail('بداية-' + 'ط'.repeat(20000) + '-نهاية', 48 * 1024);
  assert.ok(wide.length > termjobs.MAX_DONE_TAIL, 'السقف الموسّع لم يُطبَّق');
  assert.ok(wide.includes('-نهاية'), 'السقف الموسّع فقد نهاية الخرج');
  const wideSecret = termjobs.scrubDoneTail('api_key: abcdef123456 و sk-1234567890abcdef', 48 * 1024);
  assert.ok(!wideSecret.includes('abcdef123456') && !wideSecret.includes('sk-1234567890abcdef'),
    'السقف الموسّع أسقط حجب الأسرار');
  assert.ok(wideSecret.includes('[secret]'), 'لا علامة حجب مع السقف الموسّع');

  // 7) سجل الخروج الأخير: المهام المنتهية أعلاه تبقى مكتشَفة بمعرّفها وفي القائمة
  const remembered = termjobs.lastExit(failedJob.id);
  assert.ok(remembered, 'لم يُحفظ خروج المهمة الفاشلة في السجل الدائري');
  assert.strictEqual(remembered.exit_code, 7, 'رمز الخروج المحفوظ لا يطابق الحقيقي');
  assert.strictEqual(remembered.id, failedJob.id);
  const listed = termjobs.recentExitList();
  assert.ok(listed.some((e) => e.id === job1.id && e.exit_code === 0), 'المهمة الناجحة غائبة عن recent_exits');
  assert.ok(listed.every((e) => !('tail' in e)), 'recent_exits يحمل الذيل — يجب أن يبقى مختصراً');
  assert.strictEqual(termjobs.lastExit('term_9999'), null, 'معرّف مجهول أعاد مدخلاً');

  // 8) الانتظار الحاجب: خروج سابق يعود فوراً، ومهمة حية تعود لحظة خروجها لا بالمهلة
  const already = await termjobs.waitForExit(job1.id, 1000);
  assert.strictEqual(already.status, 'exited', 'الخروج السابق لم يعد فوراً');
  assert.strictEqual(already.exit_code, 0);
  assert.strictEqual((await termjobs.waitForExit('term_9999')).status, 'unknown', 'معرّف مجهول لم يُرفض');

  const slow = termjobs.startJob(temp, 'node -e "setTimeout(()=>{console.log(\'WAIT_MARK_42\');process.exit(3)}, 1200)"', 'مهمة بطيئة');
  assert(slow.ok, slow.message || slow.error);
  const startedAt = Date.now();
  const waited = await termjobs.waitForExit(slow.id, 60000);
  const elapsed = Date.now() - startedAt;
  assert.strictEqual(waited.status, 'exited', 'الانتظار الحاجب لم يرصد الخروج');
  assert.strictEqual(waited.exit_code, 3, 'رمز الخروج لم يصل عبر الانتظار الحاجب');
  assert.ok(waited.tail.includes('WAIT_MARK_42'), 'ذيل الانتظار الحاجب لا يحمل الخرج');
  assert.ok(elapsed < 30000, 'الانتظار عاد بالمهلة لا بالخروج: ' + elapsed + 'ms');

  // 9) المهلة تعيد running بلا خطأ (ولا تحسم الانتظار كذباً)
  const live = termjobs.startJob(temp, 'node -e "setInterval(()=>{}, 200)"', 'خادم منتظَر');
  assert(live.ok, live.message || live.error);
  const timedOut = await termjobs.waitForExit(live.id, 1000);
  assert.strictEqual(timedOut.status, 'running', 'المهلة لم تُعد running');
  assert.strictEqual(timedOut.waited_ms, 1000);
  assert(termjobs.info(live.id), 'انتظار بمهلة أسقط المهمة الحية');
  assert(termjobs.stop(live.id).ok);
  await waitFor(() => !termjobs.info(live.id), 'حذف الخادم المنتظَر');

  // 10) كتلة الحقن: تُبنى مرة واحدة، موسومة غير موثوقة، ومسقوفة بعدد المهام
  // ومحصورة بالمشروع — لولا الحصر لتسرّب سياق المشروع إلى مراجع أعمى في cwd مؤقت.
  assert.strictEqual(termjobs.pendingNoticeText(), '', 'بلا cwd يجب ألّا تُحقن كتلة (fail-closed)');
  assert.strictEqual(termjobs.pendingNoticeText(path.join(temp, 'other-project')), '',
    'حُقنت مهام مشروع في مشروع آخر — حاجز العزل مكسور');
  const notice = termjobs.pendingNoticeText(temp);
  assert.ok(notice.includes('<satr_background_tasks>') && notice.includes('</satr_background_tasks>'), 'الكتلة بلا وسم');
  assert.ok(notice.includes('<untrusted_terminal_output>'), 'الذيل بلا وسم عدم الثقة');
  assert.ok(notice.includes('خادم منتظَر'), 'الكتلة لا تذكر آخر مهمة خرجت');
  const shown = (notice.match(/- المهمة «/g) || []).length;
  assert.ok(shown <= 4, 'تجاوزت الكتلة سقف أربع مهام: ' + shown);
  assert.ok(!notice.includes('sk-a1b2c3d4e5f6g7h8'), 'تسرّب سر إلى كتلة الحقن');
  assert.strictEqual(termjobs.pendingNoticeText(temp), '', 'الكتلة أُعيدت مرتين — الاستهلاك لا يعمل');
  // cwd حقل داخلي للحصر فقط ولا يعبر أي عقد عام. (الذيل نفسه خرج طرفية حقيقي قد يحمل
  // محثّ الصدفة بمساره — وهو يصل الواجهة اليوم أصلاً، وحصر المشروع يمنع تسرّبه لغيره.)
  assert.ok(!('cwd' in remembered) && listed.every((e) => !('cwd' in e)),
    'cwd الداخلي تسرّب إلى عقد lastExit/recentExitList العام');

  // 11) ما عَلِمه النموذج بالانتظار الحاجب لا يُحقن ثانيةً
  const quick = termjobs.startJob(temp, 'node -e "process.exit(0)"', 'مهمة منتظَرة');
  assert(quick.ok, quick.message || quick.error);
  assert.strictEqual((await termjobs.waitForExit(quick.id, 60000)).status, 'exited');
  assert.strictEqual(termjobs.pendingNoticeText(temp), '', 'حُقنت مهمة عَلِمها النموذج بالانتظار');

  // 12) بوابة العزل في المحرّكات: أي internalPolicy يُقصي الكتلة (حاجز ثانٍ فوق حصر cwd)
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
  assert.ok(agentSrc.includes("internalPolicy ? '' : termjobs.pendingNoticeText(cwd)"),
    'بوابة agent.js لم تعد تُقصي كل internalPolicy عن كتلة المهام');
  for (const [file, gate] of [['codex.js', 'browserControl'], ['kimi.js', 'browserControl']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8');
    assert.ok(src.includes(gate + " === false ? '' : termjobs.pendingNoticeText(cwd)"),
      'بوابة ' + file + ' لكتلة المهام مفقودة أو بلا cwd');
  }

  term.killAll();
  cleanupTemp();
  console.log('✓ bg_term_done يلتقط ذيل المهمة ويحفظ رمزي النجاح والفشل الحقيقيين');
  console.log('✓ الذيل منقّى: ANSI ومحارف تحكم تُزال، والأسرار تُحجب ببوابة K2 نفسها');
  console.log('✓ القص عند 8000 محرف يحتفظ بالنهاية الفعلية بعلامة …');
  console.log('✓ الخوادم الطويلة الحية لا تُبث الحدث، وbg_term القائم سليم');
  console.log('✓ سجل recent_exits يبقي سبب الخروج مكتشَفاً بعد اختفاء المهمة');
  console.log('✓ الانتظار الحاجب يعود لحظة الخروج، والمهلة تعيد running بلا حسم كاذب');
  console.log('✓ كتلة الحقن موسومة ومسقوفة وتُستهلك مرة واحدة');
  console.log('✓ الكتلة محصورة بالمشروع، وcwd لا يعبر العقد العام، وبوابات المحرّكات تُقصي السياقات المعزولة');
  process.exit(0);
})().catch((error) => {
  term.killAll();
  cleanupTemp();
  console.error('termjobs-done:', error && error.stack ? error.stack : error);
  process.exit(1);
});
