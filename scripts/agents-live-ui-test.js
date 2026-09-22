/**
 * حارس سطح الوكلاء الفرعيين الأحياء <satr-agents-live> (‏OBS-207 · OBS-151) —
 * ‏Chromium حيّ تحت CSP صارم وبلا preload، ويقيس رسوّ الاتجاه **بالبكسل**.
 *
 * ما يثبّته (كلّه على المكوّن الإنتاجي لا على محاكاة له):
 *   ١. صفٌّ واحد للوكيل عبر الإطلاق والاستئناف بالمعرّف نفسه، ومعه عدّاد الاستئناف —
 *      وهو جوهر `OBS-207`: `taskId` مستقرّ و`toolUseId` يتغيّر مع كل `SendMessage`.
 *   ٢. الشارات الثماني بنصّها العربي حرفياً.
 *   ٣. دلالة REPLACE في `live`: الغائب بلا `finished` ⇒ «يُحسم…» ثم يحسمه `finished`.
 *   ٣ب. **لا يُعاد حسم صفٍّ محسوم**: `finished{local:true}` (يبثّه المحرّك لكل مهمة رآها
 *      عند انتهاء Query) لا يقلب «اكتمل» إلى «انتهى مع الدور»؛ والاستثناء الوحيد أن
 *      صفّاً منتهياً بالحسم المحلي يقبل خاتمةً حقيقية لاحقة لأنها أدقّ.
 *   ٤. «ينتظر إذنك: <أداة>» تزول **بمعرّف الطلب** لا بالتخمين.
 *   ٥. زر الإيقاف يبثّ `agent-stop-request` ويعود عند `failStop` برسالة عربية.
 *   ٦. الإخفاء التام عند الخلو: `display:none` وارتفاع صفر مقيسان.
 *   ٧. رسوّ الاتجاه بالبكسل عبر `Range` لا `getComputedStyle` (القاعدة ٣ في CLAUDE.md).
 *   ٨. **فحص طفرة**: نسخة من سطر التقدّم بـ`dir="auto"` **يجب** أن ترسو LTR — وإلا
 *      فالقياس ٧ بلا أسنان (لا يميّز الحسم الإحصائي من الحسم بأول حرف قوي).
 *   ٩. رفض المعرّفات المشوّهة وقصّ النصوص إلى 300.
 *   ١٠. حدّ الخمسين صفاً منتهياً (الأقدم يسقط).
 *   ١١. صفر رسائل CSP/console.
 *
 * ⚠️ **حدود مُصرَّح بها**: هذا حارس واجهة — لا يشغّل محرّكاً ولا SDK، بل يغذّي المكوّن
 * بأحداث بأشكال `D:\sater\agents-live-probe\result.json` نفسها. وأنّ `electron/` يبثّ
 * هذه الأحداث فعلاً يحرسه فرع المحرّك لا هذا الملف.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'agents-live.html');
const PAGE = path.join(__dirname, 'fixtures', 'agents-live-page.js');
const TIMEOUT_MS = 40000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// حارس تعليق: خطأ إقلاع في Electron يعلّق العملية بحوار مشروط بدل أن ينهيها
const watchdog = setTimeout(() => {
  console.error('agents-live-ui: انتهت المهلة الكلية.');
  app.exit(1);
}, TIMEOUT_MS + 20000);

function assertFixtureContract() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  assert(fixture.includes("script-src 'self'") && fixture.includes("style-src 'self'"),
    'يجب أن يعمل fixture تحت CSP صارم.');
  assert(!/\sstyle\s*=|\son[a-z]+\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  assert(!/<style\b/i.test(fixture), 'يحتوي fixture كتلة style مضمّنة.');
  const scripts = [...fixture.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length === 2 && scripts.every((m) => /\bsrc\s*=/.test(m[1]) && !m[2].trim()),
    'يجب أن تكون كل سكربتات fixture خارجية.');
  assert(fixture.includes('../../src/styles/base.css'), 'fixture لا يستورد base.css الحقيقي.');
  assert(fixture.includes('../../src/ui/components/agents-live.js'), 'fixture لا يستورد المكوّن الحقيقي.');
  assert(fixture.includes('<satr-agents-live></satr-agents-live>'), 'fixture بلا وسم المكوّن.');
  const page = fs.readFileSync(PAGE, 'utf8');
  assert(!/document\.createElement\('satr-agents-live'\)/.test(page),
    'يجب ألّا يبني السائق نسخة بديلة من المكوّن.');
}

/** عقد المصدر: الاتجاه من المصدر الواحد، والتوجيه قبل حارس الكتلة، والتسجيل في الطقم. */
function assertSourceContract() {
  const component = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'agents-live.js'), 'utf8');
  assert(component.includes("from '../lib/text-dir.js'"),
    'يجب أن يستورد agents-live.js الحسم الإحصائي من المصدر الواحد lib/text-dir.js.');
  assert(!/unicode-bidi\s*:\s*plaintext/.test(component),
    'عاد unicode-bidi: plaintext إلى سطح الوكلاء (القاعدة ٣).');
  assert(!/dir="auto"|dir\s*=\s*'auto'|\.dir\s*=\s*'auto'/.test(component),
    'dir="auto" يحسم من أول حرف قوي — ممنوع على النصّ الحرّ في هذا السطح.');
  assert(component.includes('adoptedStyleSheets'), 'أنماط المكوّن يجب أن تمرّ عبر adoptedStyleSheets.');
  assert(component.includes("role=\"region\"") && component.includes('aria-label="الوكلاء الفرعيون"'),
    'الحاوية يجب أن تحمل role=region واسماً عربياً.');
  assert(component.includes("setAttribute('role', 'status')"), 'الشارة يجب أن تحمل role=status.');

  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const tagIndex = html.indexOf('<satr-agents-live></satr-agents-live>');
  const composerIndex = html.indexOf('<satr-composer>');
  const chatIndex = html.indexOf('<satr-chat></satr-chat>');
  assert(tagIndex > 0 && chatIndex > 0 && composerIndex > 0, 'وسم السطح غائب عن index.html.');
  assert(chatIndex < tagIndex && tagIndex < composerIndex,
    'موضع <satr-agents-live> يجب أن يكون تحت الخيط وفوق المؤلّف مباشرةً.');
  assert(html.includes('ui/components/agents-live.js'), 'وحدة المكوّن غير محمّلة في index.html.');

  const shell = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const routeIndex = shell.indexOf("ev.type === 'sdk_agent_state'");
  const blockGuard = shell.indexOf('if (!block || block.done) return;');
  assert(routeIndex > 0, 'القشرة لا توجّه sdk_agent_state.');
  assert(blockGuard > 0 && routeIndex < blockGuard,
    'يجب معالجة sdk_agent_state **قبل** حارس الكتلة (وإلا سقط تقدّم الوكيل بعد الدور — جوهر OBS-207).');
  assert(shell.includes('agentsLiveEl.applyAgentState(ev)'), 'القشرة لا تمرّر الحدث إلى السطح.');
  assert(shell.includes('agentsLiveEl.setWaitingPermission('), 'القشرة لا تربط طلب الإذن بصفّ طالبه.');
  assert(shell.includes('agentsLiveEl.clearWaitingPermission('), 'القشرة لا تفكّ الانتظار عند الحسم.');
  assert(shell.includes("agentsLiveEl.addEventListener('agent-stop-request'"), 'زر الإيقاف بلا مستهلك في القشرة.');
  assert(shell.includes('agentsLiveEl.reset()'), 'القشرة لا تصفّر السطح عند تبديل الجلسة/المحرّك.');

  const perm = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'perm-dialog.js'), 'utf8');
  assert(perm.includes("new CustomEvent('perm-answered'"), 'مربع الإذن لا يعلن حسم الطلب بمعرّفه.');
  assert(perm.includes("typeof req.respond === 'function'")
    && perm.includes('(value) => window.satr.permission(value.id, value.allow, value.always, value.turn)'),
    '\u0645\u0633\u0627\u0631 \u0627\u0644\u0625\u0630\u0646 \u0627\u0644\u0639\u0627\u0645 \u0645\u0641\u0642\u0648\u062f.');
  assert(shell.includes("respond: (answer) => window.satr.savedTasksPermission({ run_id: owner.run_id, ...answer })"),
    '\u0645\u0633\u0627\u0631 \u0625\u0630\u0646 \u0627\u0644\u0645\u0647\u0645\u0629 \u063a\u064a\u0631 \u0645\u0645\u0644\u0648\u0643.');

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(packageJson.scripts['test:agents-live-ui'], 'electron scripts/agents-live-ui-test.js');
  const fullSuite = fs.readFileSync(path.join(ROOT, 'scripts', 'full-suite.js'), 'utf8');
  assert(fullSuite.includes("'test:agents-live-ui'"), 'غاب test:agents-live-ui من full-suite.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__agentsLiveResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة حارس سطح الوكلاء الأحياء.');
}

const EXPECTED_CHECKS = [
  'single-row-across-resume',
  'eight-badges',
  'live-replace-semantics',
  'finished-not-redecided',
  'live-findings-summary-and-resume',
  'permission-wait-and-clear',
  'stop-request-and-fail-return',
  'zero-height-when-empty',
  'direction-anchor-pixels',
  'mutation-dir-auto-detected',
  'malformed-ids-rejected',
  'finished-rows-capped',
  'zero-csp-violations',
];

async function main() {
  assertFixtureContract();
  assertSourceContract();
  await app.whenReady();
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false, width: 1100, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /securitypolicyviolation|content security policy|uncaught|unhandled/i.test(String(message))) {
      consoleErrors.push(String(message));
    }
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert.strictEqual(result.pass, true, result.error || 'فشل حارس سطح الوكلاء داخل الصفحة.');
    assert.deepStrictEqual(result.violations, [], 'رُصد securitypolicyviolation.');
    assert.deepStrictEqual(result.checks, EXPECTED_CHECKS);
    assert.deepStrictEqual(consoleErrors, [], 'ظهرت أخطاء console أثناء الحارس.');
    console.log('  الشارات الثماني: ' + result.badges.join(' · '));
    const fmt = (m) => 'fromRight=' + Math.round(m.fromRight) + ' fromLeft=' + Math.round(m.fromLeft);
    console.log('  عربي يبدأ برمز لاتيني: anchor=' + result.arMeasure.anchor + ' ' + fmt(result.arMeasure));
    console.log('  لاتيني صرف: anchor=' + result.laMeasure.anchor + ' ' + fmt(result.laMeasure));
    console.log('  طفرة dir="auto": anchor=' + result.mutantMeasure.anchor + ' ' + fmt(result.mutantMeasure)
      + ' (لو رست rtl لكان الفحص بلا أسنان)');
    console.log('agents-live-ui: نجح — ' + EXPECTED_CHECKS.length
      + ' فحصاً: صفّ واحد عبر الاستئناف، الشارات الثماني، REPLACE، لا إعادة حسم لمحسوم، الإذن بالمعرّف، '
      + 'الإيقاف وعودته، الاختفاء التام، رسوّ الاتجاه بالبكسل مع فحص طفرته، '
      + 'رفض المشوّه، حدّ الخمسين؛ صفر CSP/console.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch((error) => {
  console.error('agents-live-ui:', error && error.stack ? error.stack : error);
  app.exit(1);
});
