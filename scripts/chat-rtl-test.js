/**
 * اختبار حي لاتجاه المحتوى المختلط في المحادثة داخل Chromium الفعلي (دفعة RTL —
 * لقطات مالك 2026-07-18): الحسم الإحصائي الصريح بدل «أول حرف قوي» الذي كان يكسر
 * الفقرات العربية البادئة برموز لاتينية. يشغّل مكوّن chat الإنتاجي تحت CSP صارم.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'chat-rtl.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertStaticContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const chatSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'chat.js'), 'utf8');
  const baseCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'base.css'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
  assert(!/\sstyle\s*=|\sonclick\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  // ‏2026-08-13: انتقل الحسم الإحصائي إلى `lib/text-dir.js` مصدراً واحداً بعد أن أثبت
  // المسح أنه كان مطبَّقاً في chat.js وحده بينما 22 مكوّناً بقيت على plaintext.
  // نفحص **العقد** (‏chat يستهلك المصدر المشترك) لا شكل التنفيذ (دالة محلية).
  assert(chatSource.includes("from '../lib/text-dir.js'"),
    'يجب أن يستورد chat.js الحسم الإحصائي من المصدر المشترك lib/text-dir.js.');
  const textDirSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'lib', 'text-dir.js'), 'utf8');
  assert(/export function textDir\(/.test(textDirSource) && /export function applyDir\(/.test(textDirSource),
    'المصدر المشترك يصدّر textDir وapplyDir.');
  assert(chatSource.includes("import { lifecycleLabel } from '../lib/lifecycle-labels.js';"),
    'يجب أن يستورد chat.js lifecycleLabel من الوحدة المشتركة.');
  assert(!/\.md p \{[^}]*plaintext/.test(baseCss) && !/\.msg\.user \.bubble \{[^}]*plaintext[^}]*\}/s.test(baseCss.replace(/\/\*[\s\S]*?\*\//g, '')),
    'يجب ألا تعود plaintext إلى فقرات .md أو فقاعة المستخدم (dir الصريح يتولى).');
  assert.strictEqual(packageJson.scripts['test:chat-rtl'], 'electron scripts/chat-rtl-test.js');
  assert(fullSuite.includes("'test:chat-rtl'"), 'غاب test:chat-rtl من full-suite.');
  assert(chatSource.includes("!worklog.classList.contains('stopped')")
    && chatSource.includes("!worklog.classList.contains('failed')")
    && chatSource.includes("!worklog.classList.contains('done')"),
  'يجب أن يحمي toolDone عنوان الحالة الطرفية من نتيجة أداة متأخرة.');
}

async function assertStoppedToolResult(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const chat = document.querySelector('satr-chat');
    const block = chat.newAssistantBlock('اختبار الإيقاف');
    block.addTool('late-tool-result', 'قراءة', { path: 'src/ui/components/chat.js' });
    block.stopped();
    block.toolDone('late-tool-result', false);
    const title = block.el.querySelector('.work-title');
    const toolState = block.el.querySelector('.tool .state');
    return {
      title: title && title.textContent,
      toolState: toolState && toolState.textContent,
      stopped: block.el.querySelector('.worklog').classList.contains('stopped'),
    };
  })()`, true);
  assert.strictEqual(result.title, 'أُوقِف الدور',
    'نتيجة الأداة المتأخرة يجب ألا تدهس عنوان الإيقاف.');
  assert.strictEqual(result.toolState, '✓',
    'بطاقة الأداة يجب أن تستقبل نتيجتها المتأخرة رغم ثبات عنوان الإيقاف.');
  assert.strictEqual(result.stopped, true, 'يجب أن تبقى كتلة العمل في حالة stopped.');
}

async function assertSubagentBackgroundBadge(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const chat = document.querySelector('satr-chat');
    const block = chat.newAssistantBlock('اختبار شجرة الوكلاء');
    const toolUseId = 'toolu_' + 'A1b2C3d4E5f6G7h8J9k0Lm2N';
    block.addTool(toolUseId, 'Task', { subagent_type: 'general-purpose', description: 'فحص الخلفية' }, null, true);
    // حدث حالة خلفية بلا ملخص (‏OBS-094) ⇐ شارة على رأس البطاقة — عرضٌ لا قفل ولا زر إيقاف:
    // main لا يملك هذه المهمة (لم ينقلها المستخدم) فزرّ إيقاف لها كان يردّ not_found.
    const handled = block.updateAgentProgress({
      type: 'sdk_agent_progress', taskId: 'ab12cd34e', toolUseId, backgrounded: true,
    });
    const card = block.el.querySelector('.agent-card');
    const lockAfterBadge = chat.hasSdkBackgroundTasks();
    // حدث ملخص عادي بلا backgrounded ⇐ يبقى مسار التقدّم كما كان
    const progressHandled = block.updateAgentProgress({
      type: 'sdk_agent_progress', taskId: 'ab12cd34e', toolUseId, summary: 'يفحص المسارات',
    });
    const progressText = card.querySelector('.agent-progress-summary').textContent;
    // نتيجة أداة الإطلاق (نص بديل فوري للمهمة الخلفية) تُغلق البطاقة وتُبقي الشارة
    block.toolDone(toolUseId, false);
    const stateAfterResult = card.querySelector('.state').textContent;
    const badgeAfterResult = card.classList.contains('sdk-backgrounded');
    const lockAfterResult = chat.hasSdkBackgroundTasks();
    // الإشعار الختامي الذي يمرّره agent.js لمهام النموذج الخلفية يحسم الشارة
    const updated = chat.updateSdkTask({
      type: 'sdk_task_notification', taskId: 'ab12cd34e', toolUseId, status: 'completed', summary: 'اكتمل الفحص',
    });
    return {
      handled,
      badge: card.classList.contains('sdk-backgrounded') || badgeAfterResult,
      stateText: stateAfterResult,
      stopButton: !!card.querySelector('.sdk-task-stop'),
      moveButton: !!card.querySelector('.sdk-background-move'),
      lockAfterBadge,
      lockAfterResult,
      progressHandled,
      progressText,
      updated,
      stateAfterNotification: card.querySelector('.state').textContent,
      lockAfterNotification: chat.hasSdkBackgroundTasks(),
      rawToolUseIdVisible: card.textContent.includes(toolUseId),
    };
  })()`, true);
  assert.strictEqual(result.handled, true,
    'حدث الحالة الخلفية يجب أن تستقبله بطاقة الوكيل.');
  assert.strictEqual(result.badge, true,
    'بطاقة الوكيل يجب أن تحمل شارة sdk-backgrounded عند is_backgrounded.');
  assert.strictEqual(result.stateText, 'يعمل في الخلفية',
    'رأس البطاقة يجب أن يفسّر حالة الخلفية بالعربية وتبقى الشارة بعد نتيجة الإطلاق.');
  assert.strictEqual(result.stopButton, false,
    'لا زر إيقاف لمهمة لم ينقلها المستخدم — main يرفض إيقافها فالزر يكذب.');
  assert.strictEqual(result.moveButton, false,
    'لا زر «انقله للخلفية» لمهمة في الخلفية أصلاً.');
  // بلاغ مالك 2026-09-10: كانت الشارة تدخل قفل الجلسة فيُحجب «جلسة جديدة» وتبديل المحرك
  // والمجلد حتى إعادة التشغيل — بعد كل Bash(run_in_background) يبدأه النموذج بنفسه.
  assert.strictEqual(result.lockAfterBadge, false,
    'شارة الخلفية التي يضعها النموذج يجب ألا تدخل قفل الجلسة (hasSdkBackgroundTasks).');
  assert.strictEqual(result.lockAfterResult, false,
    'قفل الجلسة يجب أن يبقى مفتوحاً بعد نتيجة أداة الإطلاق.');
  assert.strictEqual(result.progressHandled, true, 'مسار ملخص التقدّم يجب ألا يتدهور.');
  assert.strictEqual(result.progressText, 'يفحص المسارات',
    'ملخص التقدّم يُعرض في سطر التقدّم كما كان.');
  assert.strictEqual(result.updated, true, 'الإشعار الختامي يجب أن يجد البطاقة عبر toolUseId.');
  assert.strictEqual(result.stateAfterNotification, '✓ اكتملت المهمة الخلفية',
    'الإشعار الختامي يحسم الشارة إلى اكتمال.');
  assert.strictEqual(result.lockAfterNotification, false, 'القفل يبقى مفتوحاً بعد الحسم.');
  assert.strictEqual(result.rawToolUseIdVisible, false,
    'المعرّفات التقنية الخام يجب ألا تظهر نصاً في البطاقة.');
}

// النظير على رقاقة أداة عادية (‏Bash بـrun_in_background هو الحالة الأشيع): الشارة بلا قفل،
// وفشل الإطلاق نفسه يمرّ بالمسار العادي (✗ بلا شارة)، ونقل المستخدم الصريح يبقى هو
// الوحيد الذي يقفل الجلسة (عقد الدفعة D بلا تراجع).
async function assertBackgroundBashChipAndUserMoveLock(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const chat = document.querySelector('satr-chat');
    const block = chat.newAssistantBlock('اختبار Bash الخلفي');
    const bgId = 'toolu_' + 'B1b2C3d4E5f6G7h8J9k0Lm2N';
    block.addTool(bgId, 'Bash', { command: 'npm test', run_in_background: true }, null, true);
    block.updateAgentProgress({ type: 'sdk_agent_progress', taskId: 'bb12cd34e', toolUseId: bgId, backgrounded: true });
    const chip = block.el.querySelector('.tool');
    const chipBadge = chip.classList.contains('sdk-backgrounded');
    const chipState = chip.querySelector('.state').textContent;
    block.toolDone(bgId, false);
    const lockAfterBash = chat.hasSdkBackgroundTasks();
    // إطلاق فاشل: الشارة تسقط والرقاقة ✗
    const failedId = 'toolu_' + 'C1b2C3d4E5f6G7h8J9k0Lm2N';
    block.addTool(failedId, 'Bash', { command: 'broken', run_in_background: true }, null, true);
    block.updateAgentProgress({ type: 'sdk_agent_progress', taskId: 'cc12cd34e', toolUseId: failedId, backgrounded: true });
    block.toolDone(failedId, true);
    const failedChip = block.el.querySelectorAll('.tool')[1];
    // نقل المستخدم الصريح (الدفعة D) يقفل الجلسة كما كان
    const movedId = 'toolu_' + 'D1b2C3d4E5f6G7h8J9k0Lm2N';
    block.addTool(movedId, 'Bash', { command: 'npm run build' }, null, true);
    const moved = chat.markSdkBackground(movedId, 'dd12cd34e');
    const lockAfterUserMove = chat.hasSdkBackgroundTasks();
    const movedChip = block.el.querySelectorAll('.tool')[2];
    const movedStop = !!movedChip.querySelector('.sdk-task-stop'); // قبل الحسم: الإشعار يزيل الأزرار
    chat.updateSdkTask({ type: 'sdk_task_notification', taskId: 'dd12cd34e', toolUseId: movedId, status: 'stopped' });
    return {
      chipBadge, chipState, lockAfterBash,
      failedState: failedChip.querySelector('.state').textContent,
      failedBadge: failedChip.classList.contains('sdk-backgrounded'),
      moved, lockAfterUserMove, movedStop,
      lockAfterStop: chat.hasSdkBackgroundTasks(),
    };
  })()`, true);
  assert.strictEqual(result.chipBadge, true, 'رقاقة Bash الخلفي تحمل الشارة.');
  assert.strictEqual(result.chipState, 'يعمل في الخلفية', 'رقاقة Bash الخلفي تفسّر حالتها بالعربية.');
  assert.strictEqual(result.lockAfterBash, false, 'Bash خلفي بدأه النموذج لا يقفل الجلسة.');
  assert.strictEqual(result.failedState, '✗', 'فشل الإطلاق يظهر ✗.');
  assert.strictEqual(result.failedBadge, false, 'فشل الإطلاق يُسقط الشارة.');
  assert.strictEqual(result.moved, true, 'نقل المستخدم الصريح يُقبل.');
  assert.strictEqual(result.lockAfterUserMove, true, 'نقل المستخدم وحده يقفل الجلسة (الدفعة D بلا تراجع).');
  assert.strictEqual(result.movedStop, true, 'بطاقة النقل الصريح تملك زر الإيقاف.');
  assert.strictEqual(result.lockAfterStop, false, 'الإشعار الختامي يفكّ قفل النقل الصريح.');
}

async function assertOpsEventCard(win) {
  const suffix = Date.now();
  const result = await win.webContents.executeJavaScript(`((suffix) => {
    const chat = document.querySelector('satr-chat');
    // بطاقة بنص مختلف عن العنوان: يجب أن يظهر الملخص
    chat.showOpsEvent({
      id: 'ops-rtl-decision-' + suffix,
      type: 'decision',
      actor: 'system',
      text: 'تم اتخاذ قرار الدمج بعد نجاح التحقق.',
      created_at: Date.now(),
    });
    // بطاقة بنص يتطابق مع عنوان النوع: يجب إخفاء الملخص لإزالة التكرار
    chat.showOpsEvent({
      id: 'ops-rtl-verify-' + suffix,
      type: 'verification',
      actor: 'sdk',
      text: 'تحديث تحقق',
      created_at: Date.now(),
    });
    // بطاقة بحالة lifecycle: يجب أن تظهر الحالة معرّبة
    chat.showOpsEvent({
      id: 'ops-rtl-review-' + suffix,
      type: 'review',
      actor: 'system',
      state: 'completed',
      text: 'انتهت المراجعة بنجاح.',
      created_at: Date.now(),
    });
    const cards = document.querySelectorAll('.ops-event-card');
    const decision = cards[cards.length - 3];
    const verify = cards[cards.length - 2];
    const review = cards[cards.length - 1];
    const visibleText = (el) => Array.from(el.querySelectorAll('*')).map((n) => n.textContent).join(' ');
    return {
      decisionTitle: decision.querySelector('.work-card-title').textContent,
      decisionState: decision.querySelector('.work-card-state').textContent,
      decisionSummary: decision.querySelector('.work-card-summary').textContent,
      decisionSummaryHidden: decision.querySelector('.work-card-summary').hidden,
      decisionBody: decision.querySelector('.work-card-body').textContent,
      decisionHasRawType: visibleText(decision).includes('decision'),
      verifyTitle: verify.querySelector('.work-card-title').textContent,
      verifySummaryHidden: verify.querySelector('.work-card-summary').hidden,
      verifyHasRawType: visibleText(verify).includes('verification'),
      reviewTitle: review.querySelector('.work-card-title').textContent,
      reviewState: review.querySelector('.work-card-state').textContent,
      reviewHasRawType: visibleText(review).includes('review'),
    };
  })(${suffix})`, true);
  assert.strictEqual(result.decisionTitle, 'قرار في غرفة العمليات',
    'عنوان بطاقة القرار يجب أن يكون بالعربية.');
  assert.strictEqual(result.decisionState, '',
    'حالة البطاقة يجب ألا تعرض النوع الإنجليزي الخام.');
  assert.strictEqual(result.decisionSummary, 'تم اتخاذ قرار الدمج بعد نجاح التحقق.',
    'ملخص البطاقة يجب أن يعرض النص.');
  assert.strictEqual(result.decisionSummaryHidden, false,
    'يجب ألا يُخفى الملخص حين يختلف عن العنوان.');
  assert.strictEqual(result.decisionBody, 'تم اتخاذ قرار الدمج بعد نجاح التحقق.',
    'جسم البطاقة المطوي يجب أن يحتوي على النص الكامل.');
  assert.strictEqual(result.decisionHasRawType, false,
    'يجب ألا يظهر النوع الإنجليزي الخام في بطاقة ops.');
  assert.strictEqual(result.verifyTitle, 'تحديث تحقق',
    'عنوان بطاقة التحقق يجب أن يكون بالعربية.');
  assert.strictEqual(result.verifySummaryHidden, true,
    'يجب إخفاء الملخص عند تطابقه مع العنوان لإزالة التكرار.');
  assert.strictEqual(result.verifyHasRawType, false,
    'يجب ألا يظهر النوع الإنجليزي الخام في بطاقة التحقق.');
  assert.strictEqual(result.reviewTitle, 'تحديث مراجعة',
    'عنوان بطاقة المراجعة يجب أن يكون بالعربية.');
  assert.strictEqual(result.reviewState, 'اكتمل',
    'حالة lifecycle يجب أن تُعرّب عبر lifecycleLabel.');
  assert.strictEqual(result.reviewHasRawType, false,
    'يجب ألا يظهر النوع الإنجليزي الخام في بطاقة المراجعة.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__chatRtlResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة اختبار اتجاه المحادثة.');
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert(result.pass, 'فشل اختبار الاتجاه:\n' + (result.error || '') +
      '\nviolations: ' + JSON.stringify(result.violations || []));
    await assertStoppedToolResult(win);
    await assertSubagentBackgroundBadge(win);
    await assertBackgroundBashChipAndUserMoveLock(win);
    await assertOpsEventCard(win);
    console.log('chat-rtl: نجح — الحسم الإحصائي للفقرات والقوائم وفقاعة المستخدم؛ الكود LTR؛ عنوان الإيقاف ثابت بعد نتيجة أداة متأخرة؛ شارة الخلفية عرضٌ بلا قفل جلسة ولا زر إيقاف كاذب ولا معرّفات خام، ونقل المستخدم وحده يقفل؛ بطاقات ops معرّبة بلا تكرار ولا نص lifecycle خام؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
