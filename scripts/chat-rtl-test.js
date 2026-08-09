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
  assert(chatSource.includes('function textDir('),
    'يجب أن يملك chat.js دالة الحسم الإحصائي textDir.');
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
    console.log('chat-rtl: نجح — الحسم الإحصائي للفقرات والقوائم وفقاعة المستخدم؛ الكود LTR؛ عنوان الإيقاف ثابت بعد نتيجة أداة متأخرة؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
