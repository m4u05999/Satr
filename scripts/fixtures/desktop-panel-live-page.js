// سيناريو الاختبار الحي للوحة 🪟 سطح ويندوز (الخطوة ٥): جسر window.satr مزيف بعقد القنوات الثلاث
// كما تنقّيها main.js حرفياً (targetId بصيغة ^w[1-9][0-9]{0,8}$ ورقم عملية صحيح، والمفتاحان وحدهما).
// أسطر السجل الثمانية تصل من العملية الرئيسية في window.__DESKTOP_FIXTURE__ — من describeAction
// الحقيقي في electron/desktopguard.js لا من نصّ موازٍ يبيت.
const violations = [];
window.__desktopLiveProgress = 'loading';

const SAFE_TARGET_ID = /^w[1-9][0-9]{0,8}$/;
const TARGETS = [
  { targetId: 'w5', pid: 4321, processName: 'notepad.exe', title: 'desktop-step5.txt - Notepad', rect: { x: 10, y: 10, w: 800, h: 600 } },
  { targetId: 'w7', pid: 5150, processName: 'mspaint', title: 'بلا عنوان - الرسام', rect: { x: 0, y: 0, w: 1024, h: 768 } },
  { targetId: 'w12', pid: 9090, processName: 'code', title: 'app.js - satr-2 - Visual Studio Code', rect: { x: 5, y: 5, w: 1440, h: 900 } },
];
const RECT_CHANGED = 'مستطيل النافذة تغيّر منذ عرضها: اسرد النوافذ واختر من جديد';

const bridge = {
  targetsCalls: 0, selectCalls: [], clearCalls: 0,
  targetsMode: 'ok',      // ok | unavailable
  selectMode: 'ok',       // ok | not_allowed_once | not_allowed_always
  notAllowedLeft: 0,
  unavailableMessage: '',
};

window.satr = {
  desktopTargets: async () => {
    bridge.targetsCalls += 1;
    if (bridge.targetsMode === 'unavailable') {
      return { ok: false, error: 'closed', message: bridge.unavailableMessage };
    }
    return { ok: true, targets: TARGETS.map((t) => Object.assign({}, t, { rect: Object.assign({}, t.rect) })) };
  },
  // نفس حواجز satr:desktopSelect في main.js: وسيطان اثنان لا غير، ومعرّف بصيغته، ورقم عملية موجب
  desktopSelect: async (targetId, pid) => {
    bridge.selectCalls.push([targetId, pid]);
    if (typeof targetId !== 'string' || !SAFE_TARGET_ID.test(targetId) || !Number.isSafeInteger(pid) || pid <= 0) {
      return { ok: false, error: 'bad_input', message: '' };
    }
    if (bridge.selectMode === 'not_allowed_always'
      || (bridge.selectMode === 'not_allowed_once' && bridge.notAllowedLeft-- > 0)) {
      return { ok: false, error: 'not_allowed', message: RECT_CHANGED };
    }
    const target = TARGETS.find((t) => t.targetId === targetId && t.pid === pid);
    if (!target) return { ok: false, error: 'not_found', message: 'النافذة لم تعد في القائمة — حدّث القائمة واختر من جديد.' };
    return { ok: true, target: Object.assign({}, target, { rect: Object.assign({}, target.rect) }) };
  },
  desktopClear: async () => { bridge.clearCalls += 1; return { ok: true }; },
};

window.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI });
});

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function frames(n = 2) {
  return new Promise((resolve) => {
    let done = false; let fallback = null; let left = n;
    const finish = () => { if (!done) { done = true; clearTimeout(fallback); resolve(); } };
    const step = () => (--left <= 0 ? finish() : requestAnimationFrame(step));
    requestAnimationFrame(step);
    fallback = setTimeout(finish, 300 + n * 100);
  });
}
async function waitFor(cond, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await frames(1);
  }
  throw new Error('انتهت مهلة انتظار: ' + label);
}

document.addEventListener('DOMContentLoaded', async () => {
  const checks = [];
  const notes = [];
  try {
    await waitFor(() => window.__DESKTOP_FIXTURE__, 'وصول بيانات fixture من العملية الرئيسية', 15000);
    const fixture = window.__DESKTOP_FIXTURE__;
    bridge.unavailableMessage = fixture.unavailable;
    await customElements.whenDefined('satr-desktop-panel');
    const el = document.getElementById('desktop');
    const root = el.shadowRoot;
    const q = (sel) => root.querySelector(sel);
    const qa = (sel) => [...root.querySelectorAll(sel)];
    let closeEvents = 0;
    let selectionEvents = [];
    let controlEvents = [];
    let notices = [];
    el.addEventListener('panel-close', () => { closeEvents += 1; });
    el.addEventListener('desktop-selection', (e) => selectionEvents.push(e.detail && e.detail.target));
    el.addEventListener('desktop-control', (e) => controlEvents.push(e.detail && e.detail.on));
    el.addEventListener('notice', (e) => notices.push(e.detail));

    // 1) فتح/إغلاق: الفتح يسرد مرة واحدة، والإغلاق يبثّ panel-close
    window.__desktopLiveProgress = 'open-close';
    el.open({ on: false, sessionActive: false });
    await waitFor(() => qa('.target').length === TARGETS.length, 'رسم قائمة النوافذ');
    assert(el.hasAttribute('open'), 'اللوحة لم تُفتح');
    assert(bridge.targetsCalls === 1, 'عدد نداءات السرد عند الفتح: ' + bridge.targetsCalls);
    el.close();
    assert(!el.hasAttribute('open') && closeEvents === 1, 'الإغلاق لم يبثّ panel-close');
    el.open({ on: false, sessionActive: false });
    await waitFor(() => qa('.target').length === TARGETS.length, 'إعادة الفتح');
    checks.push('open-close');

    // 2) تُعرض النوافذ التي وصلت حرفياً — والمحجوبة لا تصل أصلاً (سطر ثابت لا سبب لكل صف)
    window.__desktopLiveProgress = 'list-exactly-arrived';
    const rows = qa('.target');
    assert(rows.length === 3, 'عدد صفوف النوافذ: ' + rows.length);
    const labels = rows.map((row) => row.querySelector('.target-label').textContent);
    assert(labels.join('|') === 'المفكرة|الرسام|code', 'أسماء النوافذ: ' + labels.join('|'));
    const ids = rows.map((row) => row.querySelector('.target-meta .tech').textContent);
    assert(ids.join('|') === 'w5|w7|w12', 'معرّفات النوافذ: ' + ids.join('|'));
    const sizes = rows.map((row) => row.querySelectorAll('.target-meta .tech')[1].textContent);
    assert(sizes.join('|') === '800×600|1024×768|1440×900', 'مقاسات النوافذ: ' + sizes.join('|'));
    const fixed = q('.fixed').textContent;
    assert(fixed.includes('نوافذ النظام') && fixed.includes('المصغّرة'), 'غاب السطر الثابت عن المحجوبة');
    const cardText = q('.picker').textContent;
    assert(!cardText.includes('4321') && !cardText.includes('9090'), 'عُرض رقم عملية في اللوحة');
    checks.push('list-exactly-arrived');

    // 3) العنوان داخل bdi باتجاه محسوم من textDir (لاتيني LTR، عربي RTL)
    window.__desktopLiveProgress = 'title-dir';
    const titleDirs = rows.map((row) => row.querySelector('.target-title bdi').getAttribute('dir'));
    assert(titleDirs.join('|') === 'ltr|rtl|ltr', 'اتجاهات العناوين: ' + titleDirs.join('|'));
    checks.push('title-dir');

    // 4) الاختيار: {targetId, pid} وحدهما، والصف يُعلَّم، والحدث يصل القشرة
    window.__desktopLiveProgress = 'select-payload';
    rows[0].querySelector('button').click();
    await waitFor(() => selectionEvents.length === 1, 'حدث الاختيار');
    assert(bridge.selectCalls.length === 1, 'عدد نداءات الاختيار: ' + bridge.selectCalls.length);
    assert(bridge.selectCalls[0][0] === 'w5' && bridge.selectCalls[0][1] === 4321,
      'حمولة الاختيار: ' + JSON.stringify(bridge.selectCalls[0]));
    assert(selectionEvents[0] && selectionEvents[0].targetId === 'w5', 'حدث الاختيار بلا هدف');
    await waitFor(() => qa('.target')[0].classList.contains('selected'), 'تعليم الصف المختار');
    const firstButton = qa('.target')[0].querySelector('button');
    assert(firstButton.disabled && firstButton.textContent.includes('المختارة'), 'زر الصف المختار لم يتعطّل');
    assert(q('.selected-text').textContent.includes('المفكرة') && q('.selected-text').textContent.includes('w5'),
      'صندوق المختارة: ' + q('.selected-text').textContent);
    assert(notices.some((t) => t.includes('لهذه الجلسة وحدها')), 'لم يصل إشعار «لهذه الجلسة وحدها»');
    checks.push('select-payload');

    // 5) رفض not_allowed (تحرّك المستطيل بين السرد والنقر) ⇒ سرد جديد **مرة واحدة** ثم محاولة ثانية
    window.__desktopLiveProgress = 'select-retry-once';
    const listBefore = bridge.targetsCalls;
    const selectBefore = bridge.selectCalls.length;
    bridge.selectMode = 'not_allowed_once';
    bridge.notAllowedLeft = 1;
    qa('.target')[1].querySelector('button').click();
    await waitFor(() => selectionEvents.length === 2, 'الاختيار بعد إعادة السرد');
    assert(bridge.targetsCalls === listBefore + 1, 'عدد نداءات السرد بعد الرفض: ' + (bridge.targetsCalls - listBefore));
    assert(bridge.selectCalls.length === selectBefore + 2, 'عدد محاولات الاختيار: ' + (bridge.selectCalls.length - selectBefore));
    assert(selectionEvents[1] && selectionEvents[1].targetId === 'w7', 'لم تُختر w7 بعد المحاولة الثانية');
    assert(q('.message').hidden, 'ظهرت رسالة رغم نجاح المحاولة الثانية');
    checks.push('select-retry-once');

    // 6) تكرار الرفض ⇒ رسالة main كما هي (بلا حلقة): سرد واحد ومحاولتان فقط
    window.__desktopLiveProgress = 'select-retry-message';
    const listBefore2 = bridge.targetsCalls;
    const selectBefore2 = bridge.selectCalls.length;
    bridge.selectMode = 'not_allowed_always';
    qa('.target')[2].querySelector('button').click();
    await waitFor(() => !q('.message').hidden, 'رسالة الرفض المتكرر');
    assert(bridge.targetsCalls === listBefore2 + 1, 'سرد إضافي زائد: ' + (bridge.targetsCalls - listBefore2));
    assert(bridge.selectCalls.length === selectBefore2 + 2, 'محاولات اختيار زائدة: ' + (bridge.selectCalls.length - selectBefore2));
    assert(q('.message').textContent === RECT_CHANGED, 'نص الرسالة: ' + q('.message').textContent);
    assert(q('.message').getAttribute('dir') === 'rtl', 'اتجاه الرسالة: ' + q('.message').getAttribute('dir'));
    assert(selectionEvents.length === 2, 'تغيّر الاختيار رغم الرفض');
    assert(q('.selected-text').textContent.includes('w7'), 'ضاع الاختيار السابق بعد الرفض');
    bridge.selectMode = 'ok';
    checks.push('select-retry-message');

    // 7) سحب الاختيار: نداء بلا وسائط، وعودة الصندوق لحالته الفارغة
    window.__desktopLiveProgress = 'clear';
    q('.clear').click();
    await waitFor(() => bridge.clearCalls === 1, 'نداء سحب الاختيار');
    await waitFor(() => q('.clear').hidden, 'إخفاء زر الإلغاء');
    assert(selectionEvents.length === 3 && selectionEvents[2] === null, 'حدث سحب الاختيار');
    assert(q('.selected-text').textContent.includes('لم تُختر نافذة'), 'صندوق المختارة بعد السحب');
    checks.push('clear');

    // 8) رسالة «المعين غير موجود» تُعرض كما وصلت من main
    window.__desktopLiveProgress = 'unavailable-message';
    bridge.targetsMode = 'unavailable';
    q('.refresh').click();
    await waitFor(() => !q('.message').hidden && q('.message').textContent === fixture.unavailable, 'رسالة عدم التوافر');
    assert(q('.message').getAttribute('dir') === 'rtl', 'اتجاه رسالة عدم التوافر');
    assert(qa('.target').length === 0, 'بقيت نوافذ معروضة رغم فشل السرد');
    bridge.targetsMode = 'ok';
    q('.refresh').click();
    await waitFor(() => qa('.target').length === 3, 'استعادة القائمة');
    checks.push('unavailable-message');

    // 9) المفتاح لا يغيّر حالته بنفسه: يبثّ الطلب، والقشرة تعيد الرسم بـsetControlState
    window.__desktopLiveProgress = 'control-toggle';
    const enable = q('.enable');
    enable.checked = true;
    enable.dispatchEvent(new Event('change'));
    assert(controlEvents.length === 1 && controlEvents[0] === true, 'حدث طلب التفعيل');
    assert(enable.checked === false, 'المفتاح غيّر حالته بنفسه قبل قرار القشرة');
    el.setControlState({ on: true, sessionActive: true });
    assert(enable.checked === true && q('.state').classList.contains('on'), 'رسم الحالة المفعّلة');
    assert(!q('.pending').hidden && q('.pending').textContent.includes('الجلسة القادمة'), 'غاب تنبيه الجلسة القادمة');
    el.setControlState({ on: true, sessionActive: false });
    assert(q('.pending').hidden, 'بقي تنبيه الجلسة القادمة بلا جلسة');
    checks.push('control-toggle');

    // 10) الأنواع الثمانية ⇒ ثمانية أسطر مرئية بنصّها كما وصل (الحارس ٥)
    window.__desktopLiveProgress = 'activity-eight';
    for (const line of fixture.lines) el.appendActivity({ type: 'desktop_activity', text: line });
    await frames(1);
    const items = qa('.log li');
    assert(items.length === fixture.lines.length, 'عدد أسطر السجل: ' + items.length);
    const texts = items.map((li) => li.querySelector('.text').textContent);
    assert(texts.join('\n') === fixture.lines.join('\n'), 'نصوص السجل لا تطابق describeAction');
    assert(/^\d{2}:\d{2}:\d{2}$/.test(items[0].querySelector('.time').textContent), 'زمن السطر غير مكتوب');
    assert(q('.count').textContent === '(' + fixture.lines.length + ')', 'عدّاد السجل: ' + q('.count').textContent);
    assert(q('.empty').hidden, 'بقيت حالة السجل الفارغ');
    checks.push('activity-eight');

    // 11) سقف 200: الأقدم يسقط ويبقى الأحدث — الأسطر الثمانية السابقة تخرج كلها
    window.__desktopLiveProgress = 'activity-cap';
    for (let i = 1; i <= 200; i++) el.appendActivity({ type: 'desktop_activity', text: 'سطر تجريبي رقم ' + i });
    await frames(1);
    const capped = qa('.log li');
    const cappedTexts = capped.map((li) => li.querySelector('.text').textContent);
    assert(capped.length === 200, 'عدد الأسطر بعد التجاوز: ' + capped.length);
    assert(!cappedTexts.some((text) => fixture.lines.includes(text)), 'بقي سطر من الأقدم بعد تجاوز السقف');
    assert(cappedTexts[0] === 'سطر تجريبي رقم 1', 'أقدم سطر باقٍ: ' + cappedTexts[0]);
    assert(capped[199].querySelector('.text').textContent === 'سطر تجريبي رقم 200', 'أحدث سطر: ' + capped[199].querySelector('.text').textContent);
    checks.push('activity-cap');

    // 12) نص فيه HTML يُعرض نصاً (textContent لا innerHTML)
    window.__desktopLiveProgress = 'activity-html-as-text';
    const hostile = '<img src=x onerror="window.__desktopHacked = 1"><b>غامق</b> في نافذة المفكرة';
    el.appendActivity({ type: 'desktop_activity', text: hostile });
    await frames(1);
    const last = qa('.log li').pop();
    assert(last.querySelector('.text').textContent === hostile, 'لم يُعرض النص حرفياً');
    assert(!q('.log img') && !q('.log b'), 'بُني وسم HTML من نص الحدث');
    assert(window.__desktopHacked === undefined, 'نُفّذ onerror من نص الحدث');
    checks.push('activity-html-as-text');

    // 13) سطر عربي يبدأ برمز لاتيني يرسو RTL — القياس بموضع أول محرف بالبكسل لا بالخاصية المحسوبة
    window.__desktopLiveProgress = 'activity-rtl-anchor';
    const mixed = 'Ctrl+S ضُغط في نافذة المفكرة';
    el.appendActivity({ type: 'desktop_activity', text: mixed });
    await frames(2);
    const mixedText = qa('.log li').pop().querySelector('.text');
    assert(mixedText.getAttribute('dir') === 'rtl', 'اتجاه السطر المختلط: ' + mixedText.getAttribute('dir'));
    const node = mixedText.firstChild;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1);
    const charRect = range.getBoundingClientRect();
    const boxRect = mixedText.getBoundingClientRect();
    const fromRight = boxRect.right - charRect.right;
    const fromLeft = charRect.left - boxRect.left;
    notes.push('رسوّ السطر المختلط: من اليمين ' + fromRight.toFixed(1) + 'px ومن اليسار ' + fromLeft.toFixed(1) + 'px');
    assert(fromRight < fromLeft, 'السطر المختلط رسا LTR (من اليمين ' + fromRight.toFixed(1) + ' ومن اليسار ' + fromLeft.toFixed(1) + ')');
    assert(getComputedStyle(mixedText).direction === 'rtl', 'direction المحسوبة');
    checks.push('activity-rtl-anchor');

    // 14) مسح السجل يعيد الحالة الفارغة
    window.__desktopLiveProgress = 'activity-clear';
    q('.clear-log').click();
    await frames(1);
    assert(qa('.log li').length === 0 && !q('.empty').hidden && q('.clear-log').disabled, 'لم يُمسح السجل');
    assert(q('.count').textContent === '(0)', 'عدّاد بعد المسح: ' + q('.count').textContent);
    checks.push('activity-clear');

    // 15) خريطة الأسماء العربية معروضة للمقارنة بنسخة desktopguard في العملية الرئيسية
    window.__desktopLiveProgress = 'labels-exposed';
    const ctor = customElements.get('satr-desktop-panel');
    assert(ctor && ctor.PROCESS_LABELS, 'خريطة الأسماء غير مكشوفة');
    window.__desktopPanelLabels = Object.assign({}, ctor.PROCESS_LABELS);
    window.__desktopPanelMaxActivity = ctor.MAX_ACTIVITY;
    checks.push('labels-exposed');

    window.__desktopLiveResult = { pass: true, checks, notes, violations };
  } catch (error) {
    window.__desktopLiveResult = {
      pass: false, checks, notes, violations,
      progress: window.__desktopLiveProgress,
      error: error && error.message ? error.message : String(error),
    };
  }
});
