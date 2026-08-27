/**
 * حارس أداة `browser_readability` — حيّ تحت Electron، بلا شبكة.
 *
 * **يقيس السكربت الإنتاجي نفسه**: `READABILITY_FN` يُستخرج من `electron/preview.js`
 * وقت التشغيل ويُشغَّل في **عالم معزول** كما يشغّله الإنتاج (‏OBS-018). لا نسخة ثانية
 * من المنطق هنا — الحارس الذي يستورد فرعه من الإنتاج ثم يقارنه بنفسه لا يعضّ
 * (درس `test:langmetric`).
 *
 * الشقّان: (1) قياس حيّ على fixture فيه عيوب مزروعة معروفة سلفاً، (2) عقود ساكنة
 * على مواضع تسجيل الأداة الستة — أي موضع منسيّ يفشل هنا لا في الإنتاج.
 *
 * التشغيل: npx electron scripts/readability-test.js [--dump]
 */
'use strict';

const fs = require('fs');
const path = require('path');
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

app.disableHardwareAcceleration();
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

  console.log('\n— عقود التسجيل الساكنة —');
  assertStaticContract('preview.js يصدّر readability', 'electron/preview.js',
    ['async function readability()', 'readPage, readability,']);
  assertStaticContract('browserorigin يصنّفها قراءة', 'electron/browserorigin.js',
    ["'browser_readability'"]);
  assertStaticContract('autogate يعفيها من الإذن', 'electron/autogate.js',
    ["'mcp__satr-terminal__browser_readability'"]);
  assertStaticContract('codexmcp يعلنها', 'electron/codexmcp.js', ['browser_readability']);
  assertStaticContract('agent.js يعرّفها ويسردها', 'electron/agent.js', ['browser_readability']);
  assertStaticContract('envbrief يذكرها في الجرد', 'electron/envbrief.js', ['browser_readability']);

  console.log('\nالنتيجة: ' + (failures ? failures + ' فحصاً فشل' : 'كل الفحوص خضراء'));
  win.destroy();
  process.exit(failures ? 1 : 0);
}).catch((error) => {
  console.error('readability-test: FAIL:', (error && error.stack) || error);
  process.exit(1);
});
