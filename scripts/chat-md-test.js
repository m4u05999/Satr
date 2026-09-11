/**
 * حارس قرائية الردود (جولة 2026-09-10) — حيّ داخل Chromium الفعلي تحت CSP صارم.
 *
 * يعرض الرد النموذجي المعتمد عبر مكوّن chat الإنتاجي ويقيس طبقتين معاً:
 *  - العارض (renderMD/inlineMD): صفر علامات متسربة (#### · > · [نص](رابط) · ** · [ ])،
 *    عناوين حتى المستوى السادس (≥4 ⇒ h4)، قوائم متداخلة بمستويين، اقتباس، روابط نصاً بلا
 *    <a>، قوائم مهام، عزل مقاطع الكود، وتنظيف الشطب ~~ و<br> داخل الخلايا؛ مع بقاء
 *    الاتجاه الإحصائي كما هو.
 *  - التصميم (base.css): سلّم h2 > h3 > p بالنسبة ~1.28، الأوزان 700/500/700، h2 ذهبي وh3
 *    بلون المتن، هامش العنوان أعلاه أكبر من أسفله، وعمود النثر (--prose-measure) يقصر
 *    الفقرة إلى 60–72 محرفاً للسطر (معيار الخطة «لا يتجاوز ~70») دون الجدول وكتلة الكود.
 * الرد النموذجي نسخة واحدة في fixtures/chat-md-page.js تتشاركها مشاهد ui:audit والقبول.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'chat-md.html');
const TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assertStaticContract() {
  const fixture = read('scripts/fixtures/chat-md.html');
  const page = read('scripts/fixtures/chat-md-page.js');
  const chat = read('src/ui/components/chat.js');
  const css = read('src/styles/base.css');
  const pkg = JSON.parse(read('package.json'));
  const fullSuite = read('scripts/full-suite.js');
  const uiAudit = read('scripts/ui-audit.js');
  assert(!/\sstyle\s*=|\sonclick\s*=/i.test(fixture), 'يحتوي fixture سمة inline محجوبة.');
  assert.strictEqual(pkg.scripts['test:chat-md'], 'electron scripts/chat-md-test.js');
  assert(fullSuite.includes("'test:chat-md'"), 'غاب test:chat-md من full-suite.');
  assert.strictEqual(pkg.scripts['audit:reply-shape'], 'node scripts/reply-shape-audit.js');
  // العارض: العقود البنيوية — لا نسخة موازية من المنطق، فحص وجود المسارات فقط
  assert(/\/\^#\{1,6\}\\s\//.test(chat) && /Math\.min\(line\.match\(\/\^#\+\/\)\[0\]\.length, 4\)/.test(chat),
    'renderMD يقبل ستة مستويات ويطوي الرابع فما فوق إلى h4.');
  assert(chat.includes('const LINK_RE = ') && chat.includes('md-link-url') && !/<a\s/.test(chat.slice(chat.indexOf('function inlineMD'), chat.indexOf('function renderMD'))),
    'الروابط نصٌّ ظاهر بعنوان LTR — بلا وسم <a> في inlineMD.');
  assert(chat.includes('const BLOCKQUOTE_RE = ') && chat.includes('<blockquote>'), 'الاقتباس مدعوم.');
  assert(chat.includes('function renderList(') && chat.includes('const TASK_RE = '), 'القوائم المتداخلة والمهام مدعومة.');
  assert(chat.includes('const DEL_RE = ') && chat.includes('const BR_RE = ') && chat.includes("'<del>$1</del>'"),
    'الشطب ~~ ووسم <br> يُنظَّفان في inlineMD.');
  assert(chat.includes("from '../lib/text-dir.js'") && /dirAttr\(raw\.join\('\\n'\)\)/.test(chat),
    'الاتجاه الإحصائي للفقرات باقٍ من المصدر المشترك.');
  // التصميم: token عمود النثر والسلّم في base.css
  assert(/--prose-measure:\s*\d+ch;/.test(css), 'token --prose-measure معرَّف بوحدة ch.');
  assert(/\.answer-wrap \.md p, \.answer-wrap \.md ul, \.answer-wrap \.md ol, \.answer-wrap \.md blockquote \{ max-width: var\(--prose-measure\); \}/.test(css),
    'عمود النثر مطبَّق على الفقرات والقوائم والاقتباس داخل الإجابة فقط.');
  assert(/\.md h2 \{ color: var\(--gold\); font-size: 1\.28em; font-weight: 700; \}/.test(css), 'h2 بنسبة 1.28 ذهبي 700.');
  assert(/\.md h3 \{ color: var\(--text\); font-size: 1\.1em; font-weight: 500; \}/.test(css), 'h3 بلون المتن 500 — لا لون ثانٍ.');
  assert(!/\.md h1, \.md h2, \.md h3 \{ color: var\(--gold\); font-size: 1\.08em/.test(css), 'القاعدة القديمة التي تساوي المستويات أُزيلت.');
  assert(page.includes('## تحليل مشكلة بطء الصفحة الرئيسية') && uiAudit.includes('chat-md-page.js'),
    'الرد النموذجي نسخة واحدة يقرؤها ui:audit من fixture الحارس.');
}

async function waitForResult(win) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__chatMdResult || null', true);
    if (result) return result;
    await delay(50);
  }
  throw new Error('انتهت مهلة حارس قرائية الردود.');
}

async function main() {
  assertStaticContract();
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 1000, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(FIXTURE);
    const result = await waitForResult(win);
    assert(result.pass, 'فشل حارس القرائية:\n' + (result.error || '') + '\nviolations: ' + JSON.stringify(result.violations || []));
    const m = result.measures;
    console.log('chat-md: نجح — صفر تسرّب؛ h2/h3/h4/p = ' + [m.h2, m.h3, m.h4, m.p].join('/') + 'px؛ هامش h2 الأول ' + m.h2Top
      + '؛ عمود النثر ' + m.proseWidth + 'px من ' + m.bubbleInner + ' (' + m.charsPerLine + ' محرفاً/سطر على ' + m.lines + ' أسطر)؛ الكود '
      + m.preWidth + 'px؛ صفر CSP.');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
