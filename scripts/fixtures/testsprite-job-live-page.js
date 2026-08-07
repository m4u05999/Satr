// صفحة اختبار بطاقة جولة TestSprite الحي (fixture تحت CSP — بلا أي script مضمّن).
// تغطي عقد الواجهة (§4 من العقد المجمّد v1): الإقلاع المحروس، الظهور، الحالات الست
// حرفياً، العدادات ومنها «محجوبة»، نبضة «آخر نشاط قبل Xث» المتجددة، تنبيه «لا نشاط
// مرصود» فوق 45ث، زر الإيقاف (confirm عربي ثم testspriteJobCancel)، بقاء البطاقة
// عبر أحداث الجلسة، بقاء النهائي حتى الإغلاق اليدوي بـ ✕، وصفر انتهاكات CSP.
(function () {
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push(String(e.violatedDirective || e.message || e));
  });
  const calls = { cancel: [], confirm: 0 };
  // الإقلاع قبل دمج قناة كودكس: window.satr بلا testspriteJobStatus إطلاقاً —
  // حارس typeof في boot() يجب أن يمرّ بصمت (لا استثناء ولا ظهور).
  window.satr = {};
  window.confirm = () => { calls.confirm += 1; return true; };
  window.__tsJobLiveProgress = 'boot-stubbed';

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checks = [];
  const done = (name) => checks.push(name);
  const fail = (msg) => { throw new Error(msg); };

  function snap(overrides) {
    return Object.assign({
      type: 'testsprite_job', schema_version: 1, job_id: 'tsjob-live-1', kind: 'app',
      state: 'running', port: 4173, started_at: Date.now() - 90000, heartbeat_at: Date.now() - 2000,
      summary: { total: 10, completed: 4, passed: 3, failed: 1, skipped: 0, blocked: 2 },
      failure_code: null, updated_at: Date.now(),
    }, overrides || {});
  }

  async function run() {
    await customElements.whenDefined('satr-testsprite-job');
    await delay(60);
    const host = document.getElementById('tsjob');
    const root = host.shadowRoot;
    if (!root) fail('غاب Shadow Root للمكوّن.');
    window.__tsJobLiveProgress = 'boot-guard';

    // 1) الإقلاع بلا قناة (window.satr = {}) — لا ظهور ولا كسر
    if (host.hasAttribute('open')) fail('ظهرت البطاقة رغم غياب قناة testspriteJobStatus.');
    done('boot-guard-missing-channel');

    // 2) الإقلاع مع {active:false} — يبقى مخفياً
    window.satr.testspriteJobStatus = async () => ({ active: false });
    window.satr.testspriteJobCancel = async (id) => { calls.cancel.push(id); return { ok: true }; };
    host.boot();
    await delay(30);
    if (host.hasAttribute('open')) fail('ظهرت البطاقة رغم snapshot {active:false}.');
    done('boot-inactive-hidden');

    // 3) الإقلاع مع snapshot نشط (التقاط جولة حية بعد reload)
    window.satr.testspriteJobStatus = async () => snap({ type: undefined });
    host.boot();
    await delay(30);
    if (!host.hasAttribute('open')) fail('لم تظهر البطاقة عند snapshot نشط في الإقلاع.');
    done('boot-active-snapshot');
    // أغلقها (كانت completed؟ لا — running؛ أعد ضبطها بإخفاء يدوي عبر نهائي لاحقاً)
    host.removeAttribute('open');

    // 4) الظهور عبر مسار الحدث (handleEvent كما تفعل القشرة)
    host.handleEvent(snap());
    if (!host.hasAttribute('open')) fail('لم تظهر البطاقة عند حدث testsprite_job.');
    if (root.querySelector('.state').textContent !== 'قيد التنفيذ') fail('حالة running لم تُعرض حرفياً.');
    done('appears-on-active');

    // 5) الحالات الست بالعربية حرفياً
    const expected = {
      preparing: 'تجهيز الجولة',
      awaiting_setup: 'بانتظار حفظ نموذج الإعداد',
      running: 'قيد التنفيذ',
      completed: 'اكتملت',
      cancelled: 'أُلغيت',
      failed: 'متوقفة بسبب البنية',
    };
    for (const state of Object.keys(expected)) {
      host.handleEvent(snap({ state, failure_code: state === 'failed' ? 'INFRA_DOWN' : null }));
      const shown = root.querySelector('.state').textContent;
      if (shown !== expected[state]) fail('حالة ' + state + ' ظهرت «' + shown + '» بدل «' + expected[state] + '».');
    }
    done('six-states-labels');
    // رمز التوقف يظهر LTR عند failed
    const metaText = root.querySelector('.meta').textContent;
    if (!metaText.includes('رمز التوقف') || !metaText.includes('INFRA_DOWN')) fail('غاب رمز التوقف عن حالة failed.');
    done('failure-code-shown');

    // 6) العدادات ومنها «محجوبة» + المنفذ والمعرف LTR داخل bdi
    host.handleEvent(snap({ heartbeat_at: Date.now() - 2000 }));
    const counters = [...root.querySelectorAll('.counter')].map((c) => c.textContent.trim());
    const want = ['الإجمالي 10', 'اكتملت 4', 'نجحت 3', 'فشلت 1', 'تخطّت 0', 'محجوبة 2'];
    for (const w of want) if (!counters.includes(w)) fail('غاب العداد «' + w + '» — الظاهر: ' + counters.join(' | '));
    const bdis = [...root.querySelectorAll('.meta bdi')].map((b) => b.textContent);
    if (!bdis.includes('http://127.0.0.1:4173')) fail('غاب عنوان المنفذ LTR: ' + bdis.join(' | '));
    if (!bdis.includes('tsjob-live-1')) fail('غاب معرّف الجولة LTR: ' + bdis.join(' | '));
    for (const b of root.querySelectorAll('.meta bdi')) if (b.dir !== 'ltr') fail('bdi بلا dir=ltr.');
    done('counters-rendered');

    // 7) نبضة «آخر نشاط قبل Xث» تتحدث محلياً كل ثانية
    const heart = root.querySelector('.heart');
    const m1 = heart.textContent.match(/آخر نشاط قبل (\d+)ث/);
    if (!m1) fail('نص النبضة غير مطابق: «' + heart.textContent + '».');
    // استقصاء حتى 3.5ث: ضربة setInterval الثانية غير مصطفة مع القراءة فقد تتأخر
    let m2 = null;
    for (let i = 0; i < 18 && !m2; i += 1) {
      await delay(200);
      const m = heart.textContent.match(/آخر نشاط قبل (\d+)ث/);
      if (m && Number(m[1]) > Number(m1[1])) m2 = m;
    }
    if (!m2) fail('النبضة لم تتحدث بعد ثانية: «' + m1[0] + '» ثم «' + heart.textContent + '».');
    done('heartbeat-ticks');

    // 8) فوق 45ث بلا نبضة ⇒ «لا نشاط مرصود» (تنبيه هادئ بلا ادعاء تعليق)
    host.handleEvent(snap({ heartbeat_at: Date.now() - 60000 }));
    if (root.querySelector('.stall').hidden) fail('لم يظهر تنبيه «لا نشاط مرصود» بعد 60ث.');
    if (root.querySelector('.stall').textContent !== 'لا نشاط مرصود') fail('نص التنبيه مختلف.');
    done('stall-note');

    // 9) زر الإيقاف: confirm عربي ثم testspriteJobCancel بمعرّف الجولة
    host.handleEvent(snap());
    const stopBtn = root.querySelector('.stop');
    if (stopBtn.disabled) fail('زر الإيقاف معطّل أثناء running.');
    stopBtn.click();
    await delay(30);
    if (calls.confirm !== 1) fail('لم يُطلب confirm عربي قبل الإلغاء (' + calls.confirm + ').');
    if (calls.cancel.length !== 1 || calls.cancel[0] !== 'tsjob-live-1') {
      fail('testspriteJobCancel لم يُستدَ بمعرّف الجولة: ' + JSON.stringify(calls.cancel));
    }
    done('stop-sends-cancel');

    // 10) بقاء البطاقة عبر أحداث جلسة جديدة (مستقلة عن الدور والجلسة)
    host.handleEvent({ type: 'system', subtype: 'init', session_id: 'sess-new' });
    host.handleEvent(null);
    host.handleEvent({ type: 'testsprite_job', schema_version: 99, state: 'cancelled' }); // schema غريب يُتجاهل
    if (!host.hasAttribute('open')) fail('اختفت البطاقة عند أحداث جلسة جديدة.');
    if (root.querySelector('.state').textContent !== 'قيد التنفيذ') fail('تغيّرت الحالة بحدث غريب.');
    done('survives-new-session');

    // 11) النهائي يبقى معروضاً، الزر معطّل، ✕ ظاهر — ثم الإغلاق اليدوي
    host.handleEvent(snap({ state: 'completed' }));
    if (!host.hasAttribute('open')) fail('اختفت البطاقة عند الحالة النهائية.');
    if (!root.querySelector('.stop').disabled) fail('زر الإيقاف لم يُعطَّل بعد النهائي.');
    const closeBtn = root.querySelector('.close');
    if (closeBtn.hidden) fail('زر ✕ لم يظهر مع الحالة النهائية.');
    done('final-persists');
    closeBtn.click();
    if (host.hasAttribute('open')) fail('لم تُغلق البطاقة يدوياً بزر ✕.');
    done('manual-close');

    // 12) صفر انتهاكات CSP
    if (violations.length) fail('رُصدت انتهاكات CSP: ' + violations.join(' | '));
    done('zero-csp-violations');

    window.__tsJobLiveResult = { pass: true, checks, violations, calls };
  }

  run().catch((error) => {
    window.__tsJobLiveResult = { pass: false, checks, violations, error: String(error && error.message || error) };
  });
})();
