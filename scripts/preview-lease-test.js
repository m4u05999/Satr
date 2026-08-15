'use strict';

// عقد اللقطة (Snapshot Lease) وبصمة الهدف والعالم المعزول — اختبار حيّ قطعي بلا شبكة
// خارجية (خادم HTTP محلي + Electron حقيقي، بنمط preview-member-live-test.js).
// يغطي: حجب الفعل بعد إدخال المستخدم، البصمة المتبدّلة، اختفاء العنصر، استهلاك pressKey
// للعقد، براءة أفعال executeJavaScript منه، صفحة عدائية تخرّب main world، إبطال
// endHandoff/startPick، دلالة satisfied الفورية، وبقاء نافذة الرصد الكاملة بلا أثر.

const assert = require('assert');
const http = require('http');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = `<!doctype html><html><body style="margin:0">
  <div id="pad" style="height:40px"></div>
  <button id="rename">احفظ</button>
  <button id="vanish">أزل</button>
  <button id="noop">بلا تغيير</button>
  <button id="tick" onclick="document.getElementById('count').textContent=Number(document.getElementById('count').textContent)+1">زد</button>
  <div id="count">0</div>
  <input id="field" placeholder="حقل">
  <select id="picker"><option value="a">الأول</option><option value="b">الثاني</option></select>
</body></html>`;

// صفحة عدائية: تخرّب main world عمداً (نفس تخريب المسبار الحاجز) — يجب أن يعمل الفعل
// عبر العالم المعزول رغم ذلك. onclick سمة فلا يعطّلها تخريب addEventListener.
const HOSTILE = `<!doctype html><html><body>
  <button id="btn" onclick="document.getElementById('log').textContent='clicked'">زر</button>
  <div id="log">idle</div>
  <script>
    document.querySelector = function(){ return null; };
    document.querySelectorAll = function(){ return []; };
    EventTarget.prototype.addEventListener = function(){};
  </script>
</body></html>`;

function startServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/hostile' ? HOSTILE : PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1',
    () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port })));
}

function refOf(snap, label) {
  const match = snap.snap.elements.join('\n').match(new RegExp('\\[(s\\d+:e\\d+)\\] \\S+ "' + label + '"'));
  assert(match, 'لم تُلتقط ref لـ«' + label + '» في اللقطة: ' + snap.snap.elements.join(' | '));
  return match[1];
}

async function waitForUserInput(before, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (preview._internals.leaseState().userInputCounter !== before) return true;
    await delay(20);
  }
  return false;
}

// نقر مستخدم حقيقي عبر مسار الإدخال (لا executeJavaScript) على مساحة فارغة أعلى الصفحة
// كي يرتفع العدّاد بلا تغيير DOM — فيبقى سبب الرفض هو العقد وحده.
async function userClick(wc) {
  const before = preview._internals.leaseState().userInputCounter;
  wc.sendInputEvent({ type: 'mouseDown', x: 4, y: 4, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: 4, y: 4, button: 'left', clickCount: 1 });
  assert(await waitForUserInput(before), 'لم يرتفع عدّاد الإدخال بعد نقر المستخدم');
}

async function readCount() {
  const result = await preview.evaluate("document.getElementById('count').textContent");
  assert(result.ok, 'تعذّرت قراءة العدّاد من الصفحة');
  return result.value;
}

async function main() {
  await app.whenReady();
  const { server, url } = await startServer();
  const events = [];
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    preview.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    assert.strictEqual(preview.open(win, (event) => events.push(event), url + '/').ok, true);
    assert((await preview.waitFor({ selector: '#tick' }, 5000)).found, 'لم تجهز صفحة الاختبار');
    const view = win.contentView.children.find((child) => child.webContents);
    const wc = view.webContents;
    const conflicts = () => events.filter((event) => event.type === 'control_conflict');

    // ---- عقد اللقطة: البصمات داخلية ولا تعبر إلى النموذج ----
    let snap = await preview.snapshot();
    assert(snap.ok && snap.snap.elements.length, 'فشلت اللقطة الأولى');
    assert.deepStrictEqual(Object.keys(snap.snap).sort(),
      ['count', 'elements', 'generation', 'title', 'truncated', 'url'],
      'لقطة النموذج تحمل حقلاً غير معلن (تسريب البصمات؟)');
    assert(preview._internals.snapshotFingerprints().size >= 5, 'لم تُحفظ بصمات اللقطة في العملية الرئيسية');
    assert.strictEqual(preview.leaseError(), null, 'العقد ليس سليماً بعد لقطة طازجة');

    // ---- S1: إدخال المستخدم يحجب الفعل التالي بلا تنفيذ ----
    let tickRef = refOf(snap, 'زد');
    await userClick(wc);
    assert.strictEqual(preview.leaseError(), 'input_changed', 'leaseError لم يرصد تدخّل المستخدم');
    const blocked = await preview.clickElement(tickRef);
    assert.deepStrictEqual(blocked, { error: 'input_changed' }, 'الفعل بعد تدخّل المستخدم لم يُرفض: ' + JSON.stringify(blocked));
    assert.strictEqual(await readCount(), '0', 'الفعل المرفوض نفّذ على DOM فعلاً');
    assert.deepStrictEqual(conflicts().slice(-1)[0], { type: 'control_conflict', reason: 'input_changed' },
      'حدث التنازع لم يُبثّ نقياً بلا محتوى صفحة');
    const gate = await preview.browserActionContext('browser_click', { ref: tickRef });
    assert.strictEqual(gate.error, 'input_changed', 'بوابة ما قبل الإذن لم ترصد العقد المستهلَك');

    // لقطة جديدة تجدّد العقد فيعمل الفعل نفسه
    snap = await preview.snapshot();
    tickRef = refOf(snap, 'زد');
    const allowed = await preview.clickElement(tickRef);
    assert(allowed.ok && allowed.dispatched && allowed.effect_observed, 'اللقطة الجديدة لم تُجدّد العقد: ' + JSON.stringify(allowed));
    assert.strictEqual(await readCount(), '1', 'الفعل المسموح لم ينفّذ');

    // ---- أفعال الوكيل عبر executeJavaScript لا تستهلك العقد ----
    let counterBefore = preview._internals.leaseState().userInputCounter;
    assert((await preview.clickElement(tickRef)).ok, 'الفعل الثاني بلا لقطة جديدة رُفض');
    assert((await preview.typeText('#field', 'أ')).ok, 'الكتابة بلا لقطة جديدة رُفضت');
    assert((await preview.hover(refOf(snap, 'بلا تغيير'))).ok, 'التحويم رُفض');
    assert.strictEqual(preview._internals.leaseState().userInputCounter, counterBefore,
      'فعل وكيل عبر executeJavaScript رفع عدّاد الإدخال');
    assert.strictEqual(preview.leaseError(), null, 'أفعال الوكيل استهلكت العقد');
    assert.strictEqual(await readCount(), '2', 'الفعل الثاني لم ينفّذ');

    // ---- الأحداث غير الملتزمة (تمرير/تحويم/رفع) لا ترفع العدّاد ----
    counterBefore = preview._internals.leaseState().userInputCounter;
    wc.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
    wc.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseWheel', x: 20, y: 20, deltaX: 0, deltaY: -40 });
    await delay(300);
    assert.strictEqual(preview._internals.leaseState().userInputCounter, counterBefore,
      'حدث إدخال غير ملتزم رفع العدّاد (mouseMove/mouseUp/mouseWheel)');
    assert.strictEqual(preview.leaseError(), null, 'العقد سقط بحدث غير ملتزم');

    // ---- S2: تبدّل بصمة الهدف يمنع الفعل ويسمّي الطرفين ----
    snap = await preview.snapshot();
    const renameRef = refOf(snap, 'احفظ');
    await preview.evaluate("document.getElementById('rename').textContent = 'احذف'; 1");
    const drifted = await preview.clickElement(renameRef);
    assert.strictEqual(drifted.error, 'target_changed', 'العنصر المتبدّل نُقر رغم انجرافه: ' + JSON.stringify(drifted));
    assert(/احفظ/.test(drifted.was) && /احذف/.test(drifted.now),
      'رسالة الانجراف لا تسمّي الطرفين: ' + JSON.stringify(drifted));
    assert(!/\u001f/.test(drifted.was + drifted.now), 'فاصل البصمة الداخلي تسرّب إلى الوسم المقروء');
    assert.strictEqual(conflicts().slice(-1)[0].reason, 'target_changed', 'لم يُبثّ تنازع target_changed');

    // ---- S3: اختفاء العنصر يشخَّص ref_removed لا not_found ----
    const vanishRef = refOf(snap, 'أزل');
    await preview.evaluate("document.getElementById('vanish').remove(); 1");
    const removed = await preview.clickElement(vanishRef);
    assert.deepStrictEqual(removed, { error: 'ref_removed' }, 'العنصر المحذوف لم يشخَّص ref_removed: ' + JSON.stringify(removed));
    assert.strictEqual(conflicts().slice(-1)[0].reason, 'ref_removed', 'لم يُبثّ تنازع ref_removed');
    // مُحدِّد CSS بلا بصمة معروفة يبقى not_found كما كان (لا تراجع في الرسائل القديمة)
    assert.deepStrictEqual(await preview.clickElement('#vanish'), { error: 'not_found' },
      'مُحدِّد CSS لعنصر غائب تغيّرت رسالته');

    // ---- pressKey يستهلك العقد بنفسه ----
    snap = await preview.snapshot();
    tickRef = refOf(snap, 'زد');
    counterBefore = preview._internals.leaseState().userInputCounter;
    const pressed = await preview.pressKey('Tab');
    assert(pressed.ok && pressed.dispatched, 'pressKey لم ينجح: ' + JSON.stringify(pressed));
    assert(await waitForUserInput(counterBefore), 'pressKey لم يمر بمسار الإدخال');
    assert.strictEqual(preview.leaseError(), 'input_changed', 'pressKey لم يستهلك العقد');
    assert.deepStrictEqual(await preview.clickElement(tickRef), { error: 'input_changed' },
      'الفعل بعد pressKey لم يُرفض');
    assert.strictEqual(await readCount(), '2', 'الفعل المرفوض بعد pressKey نفّذ');
    snap = await preview.snapshot();
    assert.strictEqual(preview.leaseError(), null, 'اللقطة بعد pressKey لم تجدّد العقد');

    // ---- دلالة النتيجة: satisfied يعود فوراً، وبلا أثر ينتظر النافذة كاملة ----
    const typed = await preview.typeText('#field', 'نص ثابت');
    assert(typed.ok && typed.satisfied === true && typed.dispatched === true, 'الكتابة لم تعلن satisfied: ' + JSON.stringify(typed));
    let startedAt = Date.now();
    const retyped = await preview.typeText('#field', 'نص ثابت');
    const retypedMs = Date.now() - startedAt;
    assert(retyped.ok && retyped.satisfied === true && retyped.changed === false,
      'إعادة كتابة القيمة نفسها لم تعلن satisfied بلا تغيير: ' + JSON.stringify(retyped));
    assert(retypedMs < 330, 'satisfied لم يُنهِ الانتظار فوراً: ' + retypedMs + 'ms');
    const picked = await preview.selectOption('#picker', 'a');
    assert(picked.ok && picked.satisfied === true, 'الاختيار لم يعلن satisfied: ' + JSON.stringify(picked));

    startedAt = Date.now();
    const noop = await preview.clickElement('#noop');
    const noopMs = Date.now() - startedAt;
    assert(noop.ok && noop.dispatched === true && noop.effect_observed === false && noop.dom_changed === false,
      'الفعل بلا أثر لم يعد دلالة صادقة: ' + JSON.stringify(noop));
    assert(/لم يُرصد أثر/.test(noop.note), 'نصّ «لم يُرصد» لم يتحدّث: ' + noop.note);
    assert(noopMs >= 330, 'الفعل بلا أثر لم يحترم نافذة الرصد الكاملة: ' + noopMs + 'ms');

    // ---- إبطال refs عند التسليم البشري ووضع التأشير ----
    snap = await preview.snapshot();
    let noopRef = refOf(snap, 'بلا تغيير');
    preview.startHandoff();
    preview.endHandoff();
    assert.deepStrictEqual(await preview.clickElement(noopRef), { error: 'stale_ref' },
      'endHandoff لم يُبطل refs اللقطة');
    snap = await preview.snapshot();
    noopRef = refOf(snap, 'بلا تغيير');
    const picking = preview.startPick();
    await delay(150);
    assert.deepStrictEqual(await preview.clickElement(noopRef), { error: 'stale_ref' },
      'startPick لم يُبطل refs اللقطة');
    await preview.cancelPick();
    await picking;

    // ---- الصفحة العدائية: الفعل يعمل عبر العالم المعزول ----
    assert(preview.navigate(url + '/hostile').ok, 'تعذّر الانتقال للصفحة العدائية');
    await delay(900); // waitFor يعتمد querySelector المخرَّب — ننتظر التحميل لا المحدد
    const sabotaged = await preview.evaluate("document.querySelector('#btn') === null");
    assert(sabotaged.ok && sabotaged.value === 'true', 'الصفحة العدائية لم تخرّب main world فعلاً');
    const hostileClick = await preview.clickElement('#btn');
    assert(hostileClick.ok && hostileClick.dispatched, 'الفعل فشل على صفحة تخرّب main world: ' + JSON.stringify(hostileClick));
    const log = await preview.evaluate("document.getElementById('log').textContent");
    assert(log.ok && log.value === 'clicked', 'النقر لم يصل معالج الصفحة عبر العالم المعزول: ' + JSON.stringify(log));

    console.log('preview-lease: نجح — عقد اللقطة يحجب بعد إدخال المستخدم، البصمة تكشف الانجراف '
      + 'وتسمّي الطرفين، ref_removed يشخّص الاختفاء، pressKey يستهلك العقد وأفعال الوكيل لا، '
      + 'الإبطال عند التسليم والتأشير، satisfied الفوري ونافذة الرصد الكاملة، والعالم المعزول '
      + 'يقاوم صفحة تخرّب main world.');
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
