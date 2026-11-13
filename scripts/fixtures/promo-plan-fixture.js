// اختبار حي لبطاقة سيناريو الإعلان ولمسار اقتراح الوكيل في الاستوديو.

const failures = [];
const expect = (label, condition, detail) => { if (!condition) failures.push(label + ': ' + JSON.stringify(detail === undefined ? null : detail)); };
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const listeners = [];
  const calls = { approve: [], dismiss: 0 };
  const asset = 'C:\\Downloads\\satr-promo-segment-plan.mp4';
  const viewport = { width: 1000, height: 500 };
  const events = [
    { t_ms: 1500, kind: 'pointer', source: 'human', action: 'mousedown', rect: { x: 100, y: 100, width: 200, height: 40 }, pointer: { x: 150, y: 120, button: 0 }, viewport, timing_quality: 'verified' },
    { t_ms: 3000, kind: 'action', source: 'agent', action: 'type', rect: { x: 400, y: 300, width: 300, height: 40 }, pointer: null, viewport, timing_quality: 'verified', sensitive: true },
  ];
  window.satr = {
    promoStudioState: async () => ({ ok: true, storyboard: null, segments: [] }),
    promoAssetUrl: async () => ({ ok: false }),
    promoSegmentEvents: async () => ({ ok: true, events }),
    promoListDownloads: async () => ({ ok: true, files: [] }),
    promoCaptureStart: async () => ({ ok: true }), promoCaptureStop: async () => ({ ok: true }),
    promoAdPlanApprove: async (plan) => { calls.approve.push(JSON.parse(JSON.stringify(plan))); return calls.failApprove ? { ok: false, error: 'bad_plan_goal' } : { ok: true, approved: true, plan }; },
    promoAdPlanDismiss: async () => { calls.dismiss += 1; return { ok: true }; },
    onPromoCapture(callback) { listeners.push(callback); return () => {}; },
  };
  const emit = (event) => listeners.forEach((listener) => listener(event));
  await import('../../src/ui/components/promo-plan.js');
  await import('../../src/ui/components/promo-studio.js');
  const card = document.querySelector('satr-promo-plan');
  const studio = document.querySelector('satr-promo-studio');
  const root = card.shadowRoot;
  const visible = [], approved = [];
  card.addEventListener('promo-plan-visible', (event) => visible.push(event.detail));
  card.addEventListener('promo-plan-approved', (event) => approved.push(event.detail.plan));

  // ── البطاقة تُفتح باقتراح الوكيل ──
  expect('البطاقة مغلقة قبل الاقتراح', !card.hasAttribute('open'));
  emit({ type: 'ad_plan_proposed', plan: { goal: 'إبراز الحجز السريع', audience: 'العيادات', duration_s: 30, aspect: '9:16', tone: 'واثقة',
    scenes: [{ purpose: 'الخطّاف', steps_to_perform: ['افتح الصفحة', 'انقر احجز'], caption_ar: 'Satr Pro متاح الآن', voiceover_ar: 'بضغطة واحدة.', duration_s: 5 },
      { purpose: 'الدعوة', steps_to_perform: [], caption_ar: 'حمّل التطبيق', voiceover_ar: '', duration_s: 4 }] } });
  await settle();
  expect('الاقتراح يفتح البطاقة', card.hasAttribute('open') && visible[0] === true, visible);
  expect('الحقول معبأة', root.getElementById('goal').value === 'إبراز الحجز السريع' && root.getElementById('aspect').value === '9:16' && root.getElementById('duration').value === '30');
  expect('مشهدان معروضان', root.querySelectorAll('.scene').length === 2);
  expect('الخطوات سطر لكل خطوة', root.querySelector('.scene [data-field="steps"]').value === 'افتح الصفحة\nانقر احجز');
  expect('الهدف العربي يرسو يميناً', root.getElementById('goal').getAttribute('dir') === 'rtl', root.getElementById('goal').getAttribute('dir'));
  const captionField = root.querySelector('.scene [data-field="caption_ar"]');
  expect('عنوان يبدأ بلاتيني يُحسم إحصائياً rtl', captionField.getAttribute('dir') === 'rtl', captionField.getAttribute('dir'));
  expect('المجموع معروض', root.getElementById('status').textContent.includes('9 ث') && root.getElementById('status').textContent.includes('30 ث'), root.getElementById('status').textContent);
  expect('الاعتماد متاح', !root.getElementById('approve').disabled);
  expect('لا اعتماد تلقائياً عند الفتح', calls.approve.length === 0);

  // ── التعديل ──
  const edit = (selector, value, scope = root) => { const control = scope.querySelector(selector); control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); };
  edit('#goal', 'هدف عدّله المستخدم');
  edit('.scene [data-field="duration_s"]', '170');
  expect('المدة تُقصّ عند 60 ثانية للمشهد', card.getPlan().scenes[0].duration_s === 60, card.getPlan().scenes[0].duration_s);
  root.getElementById('add').click();
  await settle(50);
  expect('إضافة مشهد', root.querySelectorAll('.scene').length === 3 && card.getPlan().scenes.length === 3);
  const scenes = root.querySelectorAll('.scene');
  edit('[data-field="duration_s"]', '60', scenes[1]);
  edit('[data-field="duration_s"]', '60', scenes[2]);
  edit('[data-field="duration_s"]', '60', scenes[1]);
  expect('مجموع 180 ثانية مقبول', !root.getElementById('approve').disabled && card.totalSeconds() === 180, card.totalSeconds());
  root.getElementById('add').click();
  await settle(50);
  expect('فوق 180 ثانية يُعطَّل الاعتماد ويُشرح', root.getElementById('approve').disabled && root.getElementById('status').classList.contains('over'), root.getElementById('status').textContent);
  root.querySelectorAll('.scene')[3].querySelector('[data-action="remove"]').click();
  await settle(50);
  expect('حذف المشهد يعيد الاعتماد', !root.getElementById('approve').disabled && root.querySelectorAll('.scene').length === 3);
  edit('#goal', '   ');
  expect('بلا هدف لا اعتماد', root.getElementById('approve').disabled);
  edit('#goal', 'هدف عدّله المستخدم');
  edit('[data-field="steps"]', 'خطوة أولى\n\n  خطوة ثانية  \n', root.querySelectorAll('.scene')[2]);

  // ── فشل الاعتماد يُعرض ولا يغلق ──
  calls.failApprove = true;
  root.getElementById('approve').click();
  await settle();
  expect('فشل الاعتماد يبقي البطاقة ويعرض السبب', card.hasAttribute('open') && root.getElementById('status').textContent.includes('bad_plan_goal') && approved.length === 0, root.getElementById('status').textContent);
  calls.failApprove = false;

  // ── الاعتماد ──
  root.getElementById('approve').click();
  await settle();
  const sent = calls.approve[calls.approve.length - 1];
  expect('الاعتماد يرسل النسخة المعدّلة', sent.goal === 'هدف عدّله المستخدم' && sent.scenes.length === 3 && sent.scenes[0].duration_s === 60
    && JSON.stringify(sent.scenes[2].steps_to_perform) === JSON.stringify(['خطوة أولى', 'خطوة ثانية']), sent);
  expect('الاعتماد يغلق البطاقة ويبث الحدث', !card.hasAttribute('open') && approved.length === 1 && visible[visible.length - 1] === false);

  // ── الرفض ──
  emit({ type: 'ad_plan_proposed', plan: { goal: 'خطة ثانية', scenes: [{ purpose: 'x', duration_s: 5 }] } });
  await settle();
  expect('اقتراح جديد يفتحها من جديد بمحتواه', card.hasAttribute('open') && root.getElementById('goal').value === 'خطة ثانية' && root.querySelectorAll('.scene').length === 1);
  expect('مشهد وحيد لا يُحذف', root.querySelector('[data-action="remove"]').disabled);
  root.getElementById('dismiss').click();
  await settle();
  expect('الرفض يستدعي main ويغلق', calls.dismiss === 1 && !card.hasAttribute('open'));
  // خطة معطوبة من main لا تكسر البطاقة
  emit({ type: 'ad_plan_proposed', plan: { goal: 5, scenes: 'x' } });
  await settle();
  expect('خطة معطوبة تُعرض فارغة بمشهد واحد ولا اعتماد', card.hasAttribute('open') && root.querySelectorAll('.scene').length === 1 && root.getElementById('approve').disabled);
  card.close();
  // أحداث أخرى لا تفتحها
  emit({ type: 'capture_active' });
  await settle(50);
  expect('حدث آخر لا يفتح البطاقة', !card.hasAttribute('open'));

  // ── اقتراح الوكيل في الاستوديو: كاميرا تلقائية تُملأ، وحقل حساس يُغبَّش، ولا اعتماد ──
  const proposal = { aspect: '9:16', scenes: [
    { id: 'a', asset, asset_type: 'video', caption: 'عنوان', duration_ms: 6000, camera: { mode: 'auto', cursor: true, keyframes: [] } },
    { id: 'b', asset, asset_type: 'video', caption: '', duration_ms: 6000, camera: { mode: 'off', cursor: true, keyframes: [] } },
  ] };
  emit({ type: 'storyboard_proposed', storyboard: proposal });
  await settle(300);
  const board = studio.getStoryboard();
  expect('الاقتراح يفتح الاستوديو', studio.hasAttribute('open') && board.scenes.length === 2 && board.aspect === '9:16');
  expect('الكاميرا التلقائية تُملأ من سجل الأحداث', board.scenes[0].camera.mode === 'auto' && board.scenes[0].camera.keyframes.length > 2, board.scenes[0].camera);
  expect('camera off تبقى off', board.scenes[1].camera.mode === 'off' && board.scenes[1].camera.keyframes.length === 0, board.scenes[1].camera);
  expect('الحقل الحساس يُغبَّش في اقتراح الوكيل للمشهدين', board.scenes.every((item) => item.redactions.length === 1 && item.redactions[0].auto), board.scenes.map((item) => item.redactions.length));
  expect('اقتراح الوكيل لا يعتمد الخط الزمني', studio.approved === false && studio.shadowRoot.getElementById('render').disabled);
  let renderError = '';
  try { await studio.render(); } catch (error) { renderError = error.message; }
  expect('التصيير بلا اعتماد مرفوض', renderError === 'approval_required', renderError);
  return { ok: !failures.length, failures };
}

window.__promoPlan = run().catch((error) => ({ ok: false, failures: [String(error && error.stack || error)] }));
