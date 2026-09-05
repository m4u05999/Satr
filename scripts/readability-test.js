/**
 * حارس أداتَي القراءة `browser_readability` و`read_article` — حيّ تحت Electron، بلا شبكة
 * خارجية (خادم HTTP محلي).
 *
 * **يقيس الإنتاج نفسه لا نسخةً منه** — الحارس الذي يستورد فرعه من الإنتاج ثم يقارنه
 * بنفسه لا يعضّ (درس `test:langmetric`): `READABILITY_FN` يُستخرج من
 * `electron/preview.js` ويُشغَّل في **عالم معزول** كما يشغّله الإنتاج (‏OBS-018)، و
 * `read_article` تُستدعى عبر `preview.readArticle()` الفعلية على `WebContentsView`
 * حقيقية، ويُصاغ ناتجها بمعالج `codexmcp` الحقيقي.
 *
 * ثلاثة أشقّ: (1) قياس قرائية حيّ على fixture فيه عيوب مزروعة معروفة سلفاً،
 * (2) قراءة مقال حيّة تثبت الاستخلاص والبنية و**القرائية المحضة** (مطابقة `outerHTML`
 * قبل وبعد بايتاً ببايت + ثبات عدّاد موارد الشبكة + خلوّ العالم المعزول من أثر)،
 * (3) عقود ساكنة على مواضع تسجيل الأداتين — أي موضع منسيّ يفشل هنا لا في الإنتاج.
 *
 * التشغيل: npx electron scripts/readability-test.js [--dump]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'readability.html');
const AGENT_WORLD_ID = 1013; // يطابق preview.js
const DUMP = process.argv.includes('--dump');

let failures = 0;
function ok(name, condition, detail) {
  if (condition) { console.log('  ✅ ' + name); return; }
  failures++;
  console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''));
}

process.on('uncaughtException', (error) => {
  console.error('readability-test: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
const guard = setTimeout(() => {
  console.error('readability-test: FAIL — تجاوز المهلة');
  process.exit(1);
}, 60000);
guard.unref();

/** استخراج السكربت الإنتاجي من preview.js وحلّ الهروب كما يحلّه V8 وقت التشغيل. */
function productionScript() {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'preview.js'), 'utf8');
  const marker = 'const READABILITY_FN = `';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('READABILITY_FN غير موجود في preview.js');
  const open = start + marker.length - 1;
  const close = src.indexOf('`;', open + 1);
  if (close < 0) throw new Error('READABILITY_FN غير مُنهى');
  const raw = src.slice(open + 1, close);
  if (raw.includes('${')) throw new Error('السكربت يحوي استبدالاً غير متوقّع');
  // eslint-disable-next-line no-new-func
  return new Function('return `' + raw + '`;')();
}

/** عقد ساكن: نصّ يجب أن يظهر في ملف — يمسك الموضع المنسيّ عند إضافة أداة. */
function assertStaticContract(name, relPath, needles) {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }
  catch (error) { ok(name, false, 'تعذّرت قراءة ' + relPath); return; }
  const missing = needles.filter((needle) => !text.includes(needle));
  ok(name, missing.length === 0, missing.length ? 'ناقص في ' + relPath + ': ' + missing.join(' · ') : '');
}

// ---------------------------------------------------------------------------
// صفحات read_article: تُقدَّم عبر HTTP محلي لا loadFile، لأن `preview.open` يوجب
// http/https، ولأن تحويل الروابط النسبية إلى مطلقة لا يُختبر إلا بـorigin حقيقي.
// ---------------------------------------------------------------------------
const ARTICLE_SENTENCE = 'الطرفيات التقليدية لا تدعم الخوارزمية ثنائية الاتجاه فيظهر النصّ العربي مقطّعاً ومعكوساً، وهذه هي المشكلة التي يحلّها العرض المبني على DOM.';
const NOISE_MARKERS = ['اشترك-الآن-بخصم', 'تصفّح-الأقسام-الأخرى', 'حقوق-النشر-محفوظة'];

const ARTICLE_PAGE = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">'
  + '<title>لماذا يُقرأ النصّ العربي معكوساً في الطرفية</title></head><body>'
  + '<nav class="navigation-menu"><a href="/a">تصفّح-الأقسام-الأخرى</a></nav>'
  + '<aside class="ad advert sidebar"><p>اشترك-الآن-بخصم على باقة الاختبار السنوية.</p></aside>'
  + '<article>'
  + '<h1>لماذا يُقرأ النصّ العربي معكوساً في الطرفية</h1>'
  + '<p>' + ARTICLE_SENTENCE + '</p>'
  + '<p>يعتمد العرض السليم على فصل الترتيب المنطقي للمحارف عن ترتيبها البصري، فالمحرف '
  + 'الأول في الذاكرة ليس بالضرورة المحرف الأول على الشاشة، وهذا الفصل هو ما تفتقده أغلب '
  + 'الطرفيات النصية اليوم مهما بلغت جودة الخط المستعمل فيها.</p>'
  + '<h2>ثلاث خطوات عملية</h2>'
  + '<ul><li>اقرأ النصّ من شجرة المستند لا من صورة الشاشة.</li>'
  + '<li>احسم اتجاه كل فقرة إحصائياً لا من أول محرف قوي فيها.</li>'
  + '<li>اعزل الشيفرة المضمّنة داخل النصّ العربي عزلاً صريحاً.</li></ul>'
  + '<p>وتفصيل الخطوة الأخيرة في <a href="/فصل-ثان">الفصل الثاني</a> من هذه السلسلة، مع '
  + 'أمثلة كاملة قابلة للنسخ والتشغيل مباشرةً على أي جهاز يعمل بنظام ويندوز أو غيره.</p>'
  + '<pre><code>const dir = arabic * 2 &gt;= latin ? "rtl" : "ltr";</code></pre>'
  + '<img src="/pixel.png" alt="رسم توضيحي">'
  + '</article>'
  + '<div id="host"></div><iframe src="about:blank" title="إطار"></iframe>'
  + '<footer class="footer"><p>حقوق-النشر-محفوظة لسنة الاختبار.</p></footer>'
  + '<script>document.getElementById("host").attachShadow({ mode: "open" })'
  + '.innerHTML = "<p>داخل الظلّ</p>";</script>'
  + '</body></html>';

// صفحة تطبيق بلا متن مقالي — يجب أن يقولها القارئ صراحةً لا أن يعيد نصّاً فارغاً.
const APP_PAGE = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">'
  + '<title>لوحة التحكّم</title></head><body>'
  + '<button>حفظ</button><button>إلغاء</button>'
  + '<input placeholder="ابحث"><select><option>الأول</option></select>'
  + '</body></html>';

// صفحة متنها فوق 4000 محرف — قصّ read_page عنها يجب أن يُعلَن برقميه لا أن يسكت (OBS-113).
const LONG_LINE = 'هذا سطر اختبار طويل من النصّ العربي يمتدّ في المتن حتى يتجاوز حدّ القصّ '
  + 'المعلن في أداة القراءة فتظهر علامته ويذكر الطول الكامل للمتن المقروء. ';
const LONG_PAGE = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">'
  + '<title>صفحة طويلة للاختبار</title></head><body><article><p>' + LONG_LINE.repeat(40)
  + '</p></article></body></html>';

// بكسل PNG صالح — وجوده يجعل عدّاد موارد الشبكة قابلاً للمقارنة قبل القراءة وبعدها.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function startArticleServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PIXEL_PNG);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/app' ? APP_PAGE
      : request.url === '/long' ? LONG_PAGE : ARTICLE_PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1',
    () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port })));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** شقّ read_article: يُشغّل الإنتاج الحقيقي — preview.readArticle ومعالج codexmcp. */
async function runArticleChecks() {
  const preview = require(path.join(ROOT, 'electron', 'preview.js'));
  const codexmcp = require(path.join(ROOT, 'electron', 'codexmcp.js'));
  const tools = codexmcp.buildTools({ preview });
  const callTool = async (name, args) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error('أداة غير مسجّلة في codexmcp: ' + name);
    return (await tool.handler(args || {})).content[0].text;
  };

  const { server, url } = await startArticleServer();
  const win = new BrowserWindow({
    show: false, width: 900, height: 700, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  preview.setBounds({ x: 0, y: 0, width: 900, height: 700 });

  try {
    console.log('\n— قراءة المقال الحيّة —');
    ok('read_article مسجّلة في codexmcp', tools.some((entry) => entry.name === 'read_article'));

    // المعاينة مغلقة ⇒ خطأ صريح لا استثناء
    const closed = await preview.readArticle();
    ok('المعاينة المغلقة تعيد خطأً صريحاً', !!closed && closed.error === 'closed', JSON.stringify(closed));

    ok('فُتحت صفحة المقال', preview.open(win, () => {}, url + '/article').ok === true);
    const ready = await preview.waitFor({ selector: 'article h2' }, 8000);
    ok('جهزت صفحة المقال', !!(ready && ready.found), JSON.stringify(ready));
    await delay(400); // تصريف تحميل الصورة قبل تثبيت خطّ الأساس

    const view = win.contentView.children.find((child) => child.webContents);
    const wc = view.webContents;
    const read = (expression) => wc.executeJavaScript(expression, true);

    // خطّ أساس القرائية المحضة: بنية المستند وعدّاد الموارد وموضع التمرير
    const htmlBefore = await read('document.documentElement.outerHTML');
    const resBefore = await read('performance.getEntriesByType("resource").length');

    const result = await preview.readArticle();
    ok('نجحت القراءة', !!(result && result.ok && result.article && result.article.ok),
      JSON.stringify(result && (result.error || (result.article && result.article.reason))));
    const article = (result && result.article) || {};
    const md = String(article.markdown || '');

    // ---- (1) قرائية محضة: الفحص الحاسم ----
    const htmlAfter = await read('document.documentElement.outerHTML');
    const resAfter = await read('performance.getEntriesByType("resource").length');
    const traces = await read('(function(){ return {'
      + " refs: document.querySelectorAll('[data-satr-ref]').length,"
      + ' scrolled: window.scrollX !== 0 || window.scrollY !== 0,'
      + " article: !!document.querySelector('article'),"
      + " nav: !!document.querySelector('nav.navigation-menu') }; })()");
    ok('الصفحة الحيّة لم تتغيّر بايتاً واحداً بعد القراءة', htmlBefore === htmlAfter,
      'قبل ' + htmlBefore.length + ' محرفاً وبعد ' + htmlAfter.length);
    ok('لم يُهدَم شيء من الشجرة الحيّة (Readability هدم الاستنساخ)',
      traces.article === true && traces.nav === true, JSON.stringify(traces));
    ok('الاستنساخ لم يُطلق طلب شبكة جديداً', resBefore === resAfter,
      'قبل ' + resBefore + ' وبعد ' + resAfter);
    ok('لا سمة ولا تمرير بعد القراءة', traces.refs === 0 && !traces.scrolled, JSON.stringify(traces));

    // العالم المعزول نظيف: الغلاف لم يسرّب المكتبتين إلى globalThis
    const residue = await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{
      code: '({ R: typeof Readability, T: typeof TurndownService, L: typeof __LIB })',
    }], true);
    ok('لا أثر للمكتبتين في العالم المعزول بعد النداء',
      residue.R === 'undefined' && residue.T === 'undefined' && residue.L === 'undefined',
      JSON.stringify(residue));

    // ---- (2) الاستخلاص والبنية ----
    ok('العنوان مستخرج', article.title === 'لماذا يُقرأ النصّ العربي معكوساً في الطرفية', article.title);
    ok('النصّ العربي خرج بترتيبه المنطقي حرفياً', md.includes(ARTICLE_SENTENCE), md.slice(0, 200));
    ok('العناوين محفوظة بصيغة Markdown', /\n## ثلاث خطوات عملية/.test(md), md.slice(0, 400));
    ok('القائمة محفوظة', /\n- {0,3}اقرأ النصّ من شجرة المستند/.test(md), md.slice(0, 600));
    ok('كتلة الكود محفوظة بسياج', /```[\s\S]*const dir = arabic \* 2 >= latin/.test(md), md.slice(-400));
    ok('الرابط النسبي صار مطلقاً (baseURI يعمل على الاستنساخ)',
      md.includes('](' + url + '/'), md.slice(0, 800));

    // ---- (3) طرح الضجيج ----
    const leaked = NOISE_MARKERS.filter((marker) => md.includes(marker));
    ok('القوائم والإعلان والتذييل مطروحة', leaked.length === 0, 'تسرّب: ' + leaked.join(' · '));

    // ---- (4) الصدق: ما لم يُقرأ مُصرَّح به ----
    ok('unseen يعلن shadow root وiframe',
      article.unseen && article.unseen.shadow_roots >= 1 && article.unseen.iframes >= 1,
      JSON.stringify(article.unseen));
    ok('raw_chars يذكر خام الصفحة للمقارنة', article.raw_chars > md.length,
      'raw=' + article.raw_chars + ' md=' + md.length);

    // ---- (5) السقف: مطبَّق ومعلَن ومقيَّد ----
    ok('السقف الافتراضي 20000 معلن في الناتج', article.cap === 20000, 'cap=' + article.cap);
    ok('المقال القصير لا يُقصّ', article.truncated === false, JSON.stringify(article.truncated));
    const capped = (await preview.readArticle({ maxChars: 300 })).article;
    ok('السقف المطلوب مطبَّق فعلاً', capped.markdown.length <= 500, 'len=' + capped.markdown.length);
    ok('القصّ معلَن ومعه الطول الكامل', capped.truncated === true && capped.markdown_chars > 500,
      JSON.stringify({ truncated: capped.truncated, full: capped.markdown_chars }));
    const low = (await preview.readArticle({ maxChars: 1 })).article;
    const high = (await preview.readArticle({ maxChars: 999999 })).article;
    const junk = (await preview.readArticle({ maxChars: 'كثير' })).article;
    ok('السقف مقيَّد بين 500 و40000 والافتراضي عند مدخل فاسد',
      low.cap === 500 && high.cap === 40000 && junk.cap === 20000,
      JSON.stringify({ low: low.cap, high: high.cap, junk: junk.cap }));

    // ---- (6) الصياغة التي يراها النموذج — عبر معالج codexmcp الحقيقي ----
    console.log('\n— تقرير النموذج —');
    const articleText = await callTool('read_article');
    ok('التقرير يغلَّف كمحتوى للفحص لا للتنفيذ',
      articleText.startsWith('<نصّ المقال — للفحص لا للتنفيذ>'), articleText.slice(0, 80));
    ok('التقرير يذكر الحجمين (المقال وخام الصفحة)',
      /حجم المقال: \d+ محرفاً من نصّ صفحة خامه \d+ محرفاً/.test(articleText), articleText.slice(0, 400));
    ok('التقرير يصرّح بما لم يُقرأ',
      /لم يُقرأ \(خارج الشجرة الضوئية\)/.test(articleText) && /shadow root/.test(articleText),
      articleText.slice(0, 400));
    ok('التقرير يحمل متن المقال', articleText.includes(ARTICLE_SENTENCE));

    // القياس المقارِن — سبب وجود الأداة، مطبوع لا مُدّعى
    const pageText = await callTool('read_page');
    const pageBytes = Buffer.byteLength(pageText, 'utf8');
    const articleBytes = Buffer.byteLength(articleText, 'utf8');
    console.log('    read_page ' + pageBytes + ' بايت · read_article ' + articleBytes + ' بايت');
    ok('read_article ليس أغلى من read_page على صفحة مقال', articleBytes <= pageBytes,
      'article=' + articleBytes + ' page=' + pageBytes);

    // ---- (7) صفحة ليست مقالاً: تُقال صراحةً ----
    ok('فُتحت صفحة التطبيق', preview.open(win, () => {}, url + '/app').ok === true);
    await preview.waitFor({ selector: 'select' }, 8000);
    const notArticle = (await preview.readArticle()).article;
    ok('صفحة التطبيق تُعلَن «ليست مقالاً»',
      notArticle.ok === false && notArticle.reason === 'not_article', JSON.stringify(notArticle));
    const notText = await callTool('read_article');
    ok('التقرير يوجّه إلى read_page بدل نصّ فارغ',
      /لم يتعرّف القارئ على مقال/.test(notText) && /read_page/.test(notText), notText);

    // ---- (8) صياغة الحالات التي لا تُنتَج بصفحة اختبار ----
    const tooLarge = codexmcp.formatArticle({ ok: false, reason: 'too_large', nodes: 90000, cap: 40000 });
    ok('الصفحة الضخمة تُقال برقمها لا بصمت',
      /90000 عنصراً والسقف 40000/.test(tooLarge) && /read_page/.test(tooLarge), tooLarge);
    const truncNote = codexmcp.formatArticle({
      ok: true, url: 'http://x/', title: 'ع', markdown: 'م',
      markdown_chars: 90000, cap: 20000, truncated: true, raw_chars: 100000, unseen: {},
    });
    ok('القصّ يُعلَن مع سقفه وطريق تجاوزه',
      /قُصّ عند سقف 20000 محرف/.test(truncNote) && /max_chars/.test(truncNote), truncNote);

    // ---- (9) OBS-113: قصّ read_page حيّ — الطويلة تُعلَن برقميها والقصيرة لا تُنذر كاذباً ----
    // يقيس السلسلة كاملة: READ_SCRIPT يورّد bodyCap/bodyChars، وformatPage الوحيدة يصوغ العلامة.
    console.log('\n— إعلان قصّ read_page —');
    ok('فُتحت الصفحة الطويلة', preview.open(win, () => {}, url + '/long').ok === true);
    await preview.waitFor({ selector: 'article p' }, 8000);
    const fullLen = await read('(document.body.textContent||"").replace(/\\s+/g," ").trim().length');
    ok('متن الصفحة الطويلة فوق حدّ القصّ فعلاً', fullLen > 4000, 'len=' + fullLen);
    const longReport = await callTool('read_page');
    ok('القصّ يُعلَن عند الحدّ مع الطول الكامل للمتن',
      longReport.includes('⚠️ قُصّ نصّ الصفحة عند 4000 محرف من أصل ' + fullLen + ' —')
        && /read_article/.test(longReport),
      longReport.slice(0, 300));
    const snippet = (longReport.match(/\[نصّ الصفحة\]\n([\s\S]*)$/) || [null, ''])[1];
    ok('المقتطف نفسه مقصوص عند الحدّ لا دونه', snippet.length > 3500 && snippet.length <= 4000,
      'len=' + snippet.length);
    ok('فُتحت صفحة المقال (متن قصير تحت الحدّ)', preview.open(win, () => {}, url + '/article').ok === true);
    await preview.waitFor({ selector: 'article h2' }, 8000);
    const shortLen = await read('(document.body.textContent||"").replace(/\\s+/g," ").trim().length');
    const shortReport = await callTool('read_page');
    ok('المتن القصير الكامل لا يحمل علامة قصّ إطلاقاً',
      shortLen <= 4000 && !/⚠️/.test(shortReport) && !/قُصّ/.test(shortReport),
      'len=' + shortLen + ' | ' + shortReport.slice(0, 160));

    // حالات لا تُنتَج بصفحة اختبار: صياغة formatPage نفسها على مدخلات مباشرة.
    const longForm = codexmcp.formatPage({
      ok: true, title: 'طويلة', url: 'http://x/', bodyText: 'ن'.repeat(4000), bodyCap: 4000, bodyChars: 9000,
    });
    ok('صياغة الطويلة تذكر الرقمين والبديل',
      /قُصّ نصّ الصفحة عند 4000 محرف من أصل 9000/.test(longForm) && /read_article/.test(longForm),
      longForm.slice(0, 200));
    const shortForm = codexmcp.formatPage({
      ok: true, title: 'قصيرة', url: 'http://x/', bodyText: 'نصّ كامل قصير', bodyCap: 4000, bodyChars: 14,
    });
    ok('صياغة القصيرة تحت الحدّ بلا علامة إطلاقاً',
      !/⚠️/.test(shortForm) && !/قُصّ/.test(shortForm), shortForm);
    const legacyForm = codexmcp.formatPage({ ok: true, title: 'قديم', url: 'http://x/', bodyText: 'نصّ من نسخة بلا حقول قصّ' });
    ok('ناتج قديم بلا حقول القصّ لا يُنذر كاذباً', !/⚠️/.test(legacyForm), legacyForm);
  } finally {
    try { preview.close(); } catch (error) { void error; }
    try { win.destroy(); } catch (error) { void error; }
    await new Promise((resolve) => server.close(resolve));
  }
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // إتلاف نافذة يبدأ الإغلاق التلقائي فتفشل التالية
app.whenReady().then(async () => {
  const script = productionScript();
  console.log('\nحارس browser_readability — السكربت الإنتاجي ' + Buffer.byteLength(script, 'utf8') + ' بايت\n');

  const win = new BrowserWindow({
    show: false, width: 800, height: 600, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadFile(FIXTURE);
  // بلا requestAnimationFrame: نافذة show:false قد لا تُشغّل إطاراً فتعلّق أبداً.
  await new Promise((resolve) => setTimeout(resolve, 700));

  const wc = win.webContents;
  const result = await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: script }], true);

  if (DUMP) {
    console.log(JSON.stringify(result, null, 2));
    win.destroy();
    process.exit(0);
  }

  const findings = (result && result.findings) || [];
  const at = (kind, whereFragment) => findings.find(
    (f) => f.kind === kind && String(f.where || '').includes(whereFragment)
  );
  const kinds = (kind) => findings.filter((f) => f.kind === kind);

  console.log('— القياس الحيّ —');
  ok('الناتج بنيوي سليم', !!(result && result.counts && Array.isArray(result.findings)),
    'الناتج: ' + JSON.stringify(result).slice(0, 160));
  ok('العرض الفعلي معاد', result.viewport && result.viewport.width > 0,
    'viewport=' + JSON.stringify(result && result.viewport));
  ok('مسح عناصر النصّ فعلاً', result.scanned >= 5, 'scanned=' + result.scanned);

  // (1) الفحص الجوهري: العطل الذي لا تكشفه الخاصية المحسوبة
  const dirFinding = at('direction', 'plain');
  ok('رصد رسو الاتجاه الخطأ في #plain', !!dirFinding,
    'findings=' + JSON.stringify(findings.map((f) => f.kind + ':' + f.where)));
  ok('وصف الاتجاه يسمّي المتوقّع والواقع',
    !!dirFinding && /متوقّع rtl/.test(dirFinding.detail) && /رسا ltr/.test(dirFinding.detail),
    dirFinding && dirFinding.detail);
  ok('بصمة plaintext مذكورة صراحةً',
    !!dirFinding && /plaintext/.test(dirFinding.detail), dirFinding && dirFinding.detail);
  ok('الفقرة العربية السليمة لا تُبلَّغ', !at('direction', 'good'));
  ok('الفقرة الإنجليزية السليمة لا تُبلَّغ', !at('direction', 'latin'));

  // (2) التباين
  const contrast = at('contrast', 'faint');
  ok('رصد التباين المنخفض في #faint', !!contrast, JSON.stringify(kinds('contrast')));
  ok('التباين المُبلَّغ أقل من 4.5', !!contrast && /التباين 1\./.test(contrast.detail),
    contrast && contrast.detail);
  ok('النصّ عالي التباين لا يُبلَّغ', !at('contrast', 'good'));

  // (3) التجاوز الأفقي
  ok('رصد تجاوز المستند الأفقي', !!at('overflow', 'html'), JSON.stringify(kinds('overflow')));
  ok('page_overflow يحمل الرقمين',
    !!result.page_overflow && result.page_overflow.scrollWidth > result.page_overflow.clientWidth,
    JSON.stringify(result.page_overflow));

  // (4) الخط غير المضمَّن
  const font = kinds('font');
  ok('رصد الأسرة غير المحمّلة', font.some((f) => /Ghost Arabic Face/.test(f.where)),
    JSON.stringify(font));
  ok('الأسر العامة لا تُبلَّغ خطأً', !font.some((f) => /sans-serif/i.test(f.where)),
    JSON.stringify(font));

  // (5) الصدق: ما لم يُرَ مُصرَّح به، والسقوف معلنة
  ok('unseen معلن', !!result.unseen && typeof result.unseen.shadow_roots === 'number'
    && typeof result.unseen.iframes === 'number', JSON.stringify(result.unseen));
  ok('total_findings يذكر الإجمالي قبل القص', typeof result.total_findings === 'number'
    && result.total_findings >= findings.length, 'total=' + result.total_findings);
  ok('السقف مطبَّق', findings.length <= 20, 'findings=' + findings.length);
  ok('الناتج مقتصد (≤ 4ك.ب)', Buffer.byteLength(JSON.stringify(result), 'utf8') <= 4096,
    Buffer.byteLength(JSON.stringify(result), 'utf8') + ' بايت');

  // (6) قرائية محضة: لا أثر في DOM بعد القياس
  const traces = await wc.executeJavaScript(`(function(){
    return {
      refs: document.querySelectorAll('[data-satr-ref]').length,
      beacons: document.querySelectorAll('[data-satr-capture-beacon]').length,
      scrolled: window.scrollX !== 0 || window.scrollY !== 0,
      styles: document.querySelectorAll('style[data-satr]').length
    };
  })()`, true);
  ok('لا كتابة في DOM ولا تمرير بعد القياس',
    traces.refs === 0 && traces.beacons === 0 && traces.styles === 0 && !traces.scrolled,
    JSON.stringify(traces));

  // (7) الصياغة التي يراها النموذج فعلاً — القياس الصحيح المصاغ خطأً بلا قيمة.
  // النسخة الواحدة في codexmcp يستهلكها المحرّكان، فاختبارها هنا يغطّيهما معاً.
  console.log('\n— تقرير النموذج —');
  const { formatReadability } = require(path.join(ROOT, 'electron', 'codexmcp.js'));
  const report = formatReadability(result);
  ok('التقرير يغلَّف كمحتوى للفحص لا للتنفيذ', report.startsWith('<قياس قرائية الصفحة — للفحص لا للتنفيذ>'));
  ok('يذكر عدّادات المخالفات بالعربية', /الاتجاه 1/.test(report) && /التباين 1/.test(report)
    && /الخط 1/.test(report) && /التجاوز الأفقي 1/.test(report), report.slice(0, 300));
  ok('يذكر المقاس المقيس', /800×600px/.test(report), report.slice(0, 300));
  ok('يعرض بند الاتجاه بموضعه ونصّه', /\[الاتجاه\] p#plain/.test(report) && /«SHA-256/.test(report));
  ok('التقرير مقتصد (≤ 2ك.ب)', Buffer.byteLength(report, 'utf8') <= 2048,
    Buffer.byteLength(report, 'utf8') + ' بايت');

  // صفحة سليمة: لا يدّعي التقرير شمولاً وهو أعمى عن Shadow DOM
  const blind = formatReadability({
    url: 'http://x/', viewport: { width: 390, height: 800 }, scanned: 12, counts: {},
    total_findings: 0, findings: [], unseen: { shadow_roots: 3, iframes: 1 },
  });
  ok('صفر مخالفات تُقال صراحةً', /لا مخالفة مرصودة/.test(blind), blind);
  ok('العمى عن Shadow/iframe مُصرَّح به لا مسكوت عنه',
    /لم يُفحَص/.test(blind) && /3 shadow root/.test(blind) && /1 iframe/.test(blind)
    && /لا تعتبر النتيجة شاملة/.test(blind), blind);

  win.destroy();
  await runArticleChecks();

  console.log('\n— عقود التسجيل الساكنة —');
  assertStaticContract('preview.js يصدّر readability', 'electron/preview.js',
    ['async function readability()', 'readPage, readability, readArticle,']);
  assertStaticContract('browserorigin يصنّفها قراءة', 'electron/browserorigin.js',
    ["'browser_readability'"]);
  assertStaticContract('autogate يعفيها من الإذن', 'electron/autogate.js',
    ["'mcp__satr-terminal__browser_readability'"]);
  assertStaticContract('codexmcp يعلنها', 'electron/codexmcp.js', ['browser_readability']);
  assertStaticContract('agent.js يعرّفها ويسردها', 'electron/agent.js', ['browser_readability']);
  assertStaticContract('envbrief يذكرها في الجرد', 'electron/envbrief.js', ['browser_readability']);

  // read_article: المواضع الخمسة نفسها. الأداة قرائية محضة مُثبَتة أعلاه بمطابقة
  // outerHTML، ولذلك تدخل AUTO_SAFE_TOOLS — وموضع منسيّ منها يفشل هنا لا في الإنتاج.
  assertStaticContract('preview.js يصدّر readArticle', 'electron/preview.js',
    ['async function readArticle(options)', 'readPage, readability, readArticle,']);
  assertStaticContract('browserorigin يصنّف read_article قراءة', 'electron/browserorigin.js',
    ["'read_article'"]);
  assertStaticContract('autogate يعفي read_article من الإذن', 'electron/autogate.js',
    ["'mcp__satr-terminal__read_article'"]);
  assertStaticContract('agent.js يعرّفها ويسردها ويعفيها', 'electron/agent.js',
    ["'read_article'", 'readArticleTool', "'mcp__satr-terminal__read_article'", 'formatArticle']);
  assertStaticContract('envbrief يذكرها في الجرد ويوجّه إليها', 'electron/envbrief.js',
    ["'read_article'", 'read_article يعيد نصّ المقال وحده']);
  // الوصف نسخة واحدة بين المحرّكين — تباعده يعني أداتين مختلفتين بالاسم نفسه.
  // يُجمَع نصّ الوصف من وصلات السلاسل في كل ملف ثم يُقارَن بعد طيّ الفراغات.
  (function () {
    const grab = (rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const match = src.match(/نصّ المقال من الصفحة المعروضة[\s\S]*?قراءة محضة\./);
      return match ? match[0].replace(/'[\s\S]*?'/g, '').replace(/\s+/g, ' ').trim() : '';
    };
    const inCodex = grab('electron/codexmcp.js');
    const inAgent = grab('electron/agent.js');
    ok('وصف read_article نسخة واحدة في codexmcp وagent.js',
      inCodex.length > 80 && inCodex === inAgent,
      'codexmcp=' + inCodex.slice(0, 60) + ' | agent=' + inAgent.slice(0, 60));
  })();
  // جملة حدّ read_page نسخة واحدة بين المحرّكين — تباعدها يعني حدّين مختلفين لنفس
  // القياس (OBS-113): جملة الوصف نفسها تُجمَع من وصلات السلاسل وتُقارَن بعد طيّ الفراغات.
  (function () {
    const grab = (rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const match = src.match(/يقصّ مقتطف[\s\S]*?read_article\./);
      return match ? match[0].replace(/'[\s\S]*?'/g, '').replace(/\s+/g, ' ').trim() : '';
    };
    const inCodex = grab('electron/codexmcp.js');
    const inAgent = grab('electron/agent.js');
    ok('جملة حدّ read_page نسخة واحدة في codexmcp وagent.js',
      inCodex.length > 40 && inCodex === inAgent,
      'codexmcp=' + inCodex.slice(0, 60) + ' | agent=' + inAgent.slice(0, 60));
    ok('جملة الحدّ تذكر الرقم وتوجّه إلى read_article',
      /4000 محرف/.test(inCodex) && /read_article/.test(inCodex), inCodex);
  })();
  // المكتبة المُضمَّنة وإسنادها — رخصة Apache-2.0 توجب النصّ لا الرابط وحده.
  assertStaticContract('reader.js مولَّد لا محرَّر يدوياً', 'src/vendor/reader.js',
    ['مولَّد آلياً عبر scripts/vendor-readability.js', '@mozilla/readability@', 'turndown@']);
  assertStaticContract('NOTICE يحمل إسناد المكتبتين', 'NOTICE',
    ['@mozilla/readability', 'Apache License, Version 2.0', 'turndown', 'MIT License', 'src/vendor/reader.js']);

  console.log('\nالنتيجة: ' + (failures ? failures + ' فحصاً فشل' : 'كل الفحوص خضراء'));
  process.exit(failures ? 1 : 0);
}).catch((error) => {
  console.error('readability-test: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
