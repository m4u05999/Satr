'use strict';

// OBS-175 — هل يرى `browser_evaluate` المقاس الذي طبّقه `browser_set_viewport`؟
// حارس حيّ قطعي (خادم HTTP محلي + Electron حقيقي + WebContentsView) بنمط
// scripts/preview-lease-test.js. يقيس `innerWidth` من ثلاثة مسارات في اللحظة نفسها:
//   (١) مسار الأداة  preview.evaluate  ⇒ CDP Runtime.evaluate خلف debugger
//   (٢) مسار القياس  wc.executeJavaScript (نفسه الذي يبني به setViewport حقل actual)
//   (٣) حدود العرض الأصلية view.getBounds()
// الفرق بين (١) و(٢) هو الدليل: لو تطابقا فالعطل ليس في مسار evaluate.

const assert = require('assert');
const http = require('http');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = `<!doctype html><html><body style="margin:0">
  <div id="box" style="width:100%;height:200px;background:#eee">صندوق</div>
  <p id="t">نص عربي للقياس</p>
</body></html>`;

function startServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1',
    () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/' })));
}

const EXPR = 'window.innerWidth+"x"+window.innerHeight+"|"+document.documentElement.clientWidth';

// قياس متزامن من المسارين معاً + حدود العرض الأصلية، بوسم للحظة.
async function sample(wc, view, label) {
  const viaTool = await preview.evaluate(EXPR);
  let viaExec = null;
  try { viaExec = await wc.executeJavaScript(EXPR, true); } catch (e) { viaExec = 'exec_failed:' + e.message; }
  const bounds = view.getBounds();
  const row = {
    label,
    evaluate: viaTool && viaTool.ok ? viaTool.value : JSON.stringify(viaTool),
    executeJavaScript: viaExec,
    viewBounds: bounds.width + 'x' + bounds.height + ' @' + bounds.x + ',' + bounds.y,
  };
  console.log('  [' + label + '] evaluate=' + row.evaluate
    + '  executeJavaScript=' + row.executeJavaScript + '  view.getBounds=' + row.viewBounds);
  return row;
}

const widthOf = (value) => Number(String(value).split('x')[0]);

async function main() {
  await app.whenReady();
  const { server, url } = await startServer();
  // نافذة بمقاس واقعي ولوحة معاينة واقعية (عرض 844 كما في بلاغ OBS-175).
  // النافذة مخفية افتراضياً (طقم بلا شاشة)؛ `--show` لفحص الفرق البيئي عند الحاجة.
  const win = new BrowserWindow({ show: process.argv.includes('--show'), width: 1280, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    const panel = { x: 380, y: 64, width: 860, height: 700 };
    preview.setBounds(panel);
    assert.strictEqual(preview.open(win, () => {}, url).ok, true, 'تعذّر فتح المعاينة');
    assert((await preview.waitFor({ selector: '#box' }, 8000)).found, 'لم تجهز صفحة الاختبار');
    const view = win.contentView.children.find((child) => child.webContents);
    const wc = view.webContents;

    console.log('preview-viewport-evaluate: لوحة ' + panel.width + 'x' + panel.height);
    const before = await sample(wc, view, 'قبل set_viewport');
    assert(widthOf(before.evaluate) > 1,
      'مسار evaluate يعود بعرض 1 حتى قبل أي set_viewport — العطل ليس في المزامنة: ' + before.evaluate);

    // ---- مسار الأداة نفسه ----
    const applied = await preview.setViewport(844, 672);
    assert(applied.ok, 'فشل set_viewport: ' + JSON.stringify(applied));
    console.log('  set_viewport(844,672) ⇒ actual=' + JSON.stringify(applied.actual)
      + (applied.clamped ? ' (clamped)' : ''));
    assert.strictEqual(applied.actual.width, 844, 'set_viewport لم يطبّق العرض المطلوب فعلاً');

    // فوراً (بلا أي انتظار إضافي) ثم بعد إطار مرسوم.
    const now = await sample(wc, view, 'بعد set_viewport فوراً');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // نافذة الاختبار مخفية فقد لا يُركَّب إطار أصلاً ⇒ ننتظر rAF بسقف زمني لا إلى الأبد.
    await wc.executeJavaScript(
      'new Promise(function(r){var d=setTimeout(r,300);requestAnimationFrame(function(){requestAnimationFrame(function(){clearTimeout(d);r();});});})',
      true).catch(() => {});
    const framed = await sample(wc, view, 'بعد إطار');

    // ---- الحكم: مسار الأداة يجب أن يرى المقاس المطبَّق، لا 1×1 (OBS-175) ----
    for (const row of [now, framed]) {
      assert(widthOf(row.evaluate) !== 1,
        'OBS-175 حيّ: browser_evaluate يعود بعرض 1 عند «' + row.label + '» بينما '
        + 'executeJavaScript يقول ' + row.executeJavaScript + ' وحدود العرض ' + row.viewBounds);
      assert.strictEqual(widthOf(row.evaluate), 844,
        'مسار evaluate لا يرى مقاس set_viewport عند «' + row.label + '»: ' + row.evaluate
        + ' (executeJavaScript=' + row.executeJavaScript + '، view.getBounds=' + row.viewBounds + ')');
      assert.strictEqual(String(row.evaluate), String(row.executeJavaScript),
        'مسارا القياس اختلفا عند «' + row.label + '»: evaluate=' + row.evaluate
        + ' vs executeJavaScript=' + row.executeJavaScript);
    }

    // ---- لقطة الصفحة كاملة تمر بـ CDP بـ captureBeyondViewport؛ هل تترك المقاس مبدَّلاً؟ ----
    const shot = await preview.screenshotFull({ modelImage: false }).catch((e) => ({ error: e.message }));
    const afterShot = await sample(wc, view, 'بعد لقطة كاملة');
    assert.strictEqual(widthOf(afterShot.evaluate), 844,
      'لقطة الصفحة كاملة (captureBeyondViewport) تركت مقاس الصفحة مبدَّلاً: ' + afterShot.evaluate
      + ' — نتيجة اللقطة: ' + (shot && shot.ok ? 'ok' : JSON.stringify(shot).slice(0, 120)));

    // ---- المستطيل السالب: هل يعطي effectiveBounds عرضاً 1 (بصمة «1×1» في OBS-175)؟ ----
    // الصفر حجبٌ صريح، والسالب كان يمرّ عبر Math.max(1,…) فيصير عرضاً حقيقياً مقداره
    // بكسل واحد — «عرض مفتوح بلا محتوى» بدل حجب نظيف، وهو بالضبط شكل 1×1 المُبلَّغ.
    const negative = preview._internals.effectiveBounds({ x: 0, y: 0, width: -20, height: 700 });
    console.log('  effectiveBounds(width:-20) ⇒ ' + JSON.stringify(negative));
    assert.notStrictEqual(negative && negative.width, 1,
      'المستطيل السالب يعطي عرضاً 1 — بصمة «1×1»: ' + JSON.stringify(negative));

    // ---- إعادة الضبط: قرار المستخدم الصريح يمسح مقاس الوكيل ويعيد عرض اللوحة ----
    // **الادّعاء المقيس**: مقاس الصفحة يتبع حدود العرض؛ وزمن التقارب يُقاس لا يُفترض.
    preview.setBounds(panel, null, true);
    const startedAt = Date.now();
    let convergedMs = -1;
    while (Date.now() - startedAt < 3000) {
      const probe = await wc.executeJavaScript(EXPR, true).catch(() => '');
      if (widthOf(probe) === panel.width) { convergedMs = Date.now() - startedAt; break; }
      await delay(25);
    }
    console.log('  إعادة الضبط: تقارب مقاس الصفحة مع حدود اللوحة بعد ' + convergedMs + 'ms');
    const reset = await sample(wc, view, 'بعد إعادة الضبط');
    // حدود العرض الأصلية تعود دائماً — وهذا وحده ما يقبل الفحص على نافذة مخفية.
    assert.strictEqual(view.getBounds().width, panel.width,
      'إعادة الضبط لم تُعد حدود العرض الأصلية: ' + reset.viewBounds);
    // **حدّ بيئي معلَن ومقيس** (‏2026-09-12): على نافذة مخفية (`show:false`، وهو عُرف
    // الطقم كي يعمل بلا شاشة) لا يُبلَّغ المُصيِّر بتكبير مستطيل العرض أصلاً، فيبقى
    // `innerWidth` عند المقاس الأصغر السابق إلى الأبد (قيس: لا تقارب خلال 3000ms).
    // المسار نفسه بنافذة ظاهرة يتقارب خلال 0ms (‏`--show`). فالساق الأخيرة تُفحص
    // بالمقاس فقط حين تكون النافذة ظاهرة؛ وإلا تُعلَن ولا تُدّعى.
    if (win.isVisible()) {
      assert(convergedMs >= 0 && convergedMs <= 500,
        'مقاس الصفحة لم يتبع حدود العرض بعد إعادة الضبط: ' + reset.evaluate
        + ' بينما view.getBounds=' + reset.viewBounds);
      assert.strictEqual(widthOf(reset.evaluate), widthOf(before.evaluate),
        'إعادة الضبط لم تُعد المقاس الأصلي: ' + reset.evaluate + ' بدل ' + before.evaluate);
    } else {
      console.log('  (حدّ بيئي معلَن: النافذة مخفية فلا يتبع المُصيِّر تكبير المستطيل — '
        + 'ساق المقاس بعد إعادة الضبط تُفحص بـ--show فقط)');
    }

    console.log('preview-viewport-evaluate: نجح — مسار browser_evaluate يرى مقاس browser_set_viewport '
      + '(844) فوراً وبعد إطار وبعد لقطة كاملة، ويطابق مسار executeJavaScript، وإعادة الضبط تعيد عرض اللوحة.');
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
