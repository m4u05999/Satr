'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');
const preview = require('../electron/preview');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture.txt') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="fixture.txt"' });
      response.end('downloaded'); return;
    }
    if (request.url === '/two') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><h1>الثانية</h1></body></html>'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <button id="change" onclick="document.getElementById('status').textContent='changed'">غيّر</button>
      <button id="delayed" onclick="setTimeout(function(){document.getElementById('status').textContent='delayed'},120)">غيّر لاحقاً</button>
      <button id="noop">بلا تغيير</button><div id="status">idle</div>
      <canvas id="shot-fixture" width="640" height="1300" aria-label="عينة بصرية حتمية لقياس ضغط اللقطات"></canvas>
      <button id="generation" onclick="document.getElementById('generation-status').textContent=Number(document.getElementById('generation-status').textContent)+1">اختبر الجيل</button>
      <div id="generation-status">0</div>
      <button id="delta-target">بدّل دلتا</button>
      <div id="editor" contenteditable="true"><b>قديم</b></div>
      <a id="next" href="/two">التالي</a>
      <a id="external" href="https://external.example/path">خارجي</a>
      <a id="download" href="/fixture.txt" download="fixture.txt">نزّل</a>
      <script>
        var shotCanvas = document.getElementById('shot-fixture');
        var shotContext = shotCanvas.getContext('2d');
        var shotPixels = shotContext.createImageData(shotCanvas.width, shotCanvas.height);
        var shotSeed = 16016;
        for (var shotY = 0; shotY < shotCanvas.height; shotY++) {
          for (var shotX = 0; shotX < shotCanvas.width; shotX++) {
            shotSeed = (shotSeed * 1664525 + 1013904223) >>> 0;
            var shotNoise = (shotSeed >>> 24) - 128;
            var shotAt = (shotY * shotCanvas.width + shotX) * 4;
            shotPixels.data[shotAt] = Math.max(0, Math.min(255, shotX * 255 / shotCanvas.width + shotNoise / 5));
            shotPixels.data[shotAt + 1] = Math.max(0, Math.min(255, shotY * 255 / shotCanvas.height + shotNoise / 6));
            shotPixels.data[shotAt + 2] = Math.max(0, Math.min(255, 180 + shotNoise / 4));
            shotPixels.data[shotAt + 3] = 255;
          }
        }
        shotContext.putImageData(shotPixels, 0, 0);
        function replaceDeltaTarget(event) {
          var next = document.createElement('button');
          next.id = 'delta-target';
          next.textContent = 'بدّل دلتا';
          next.addEventListener('click', replaceDeltaTarget);
          event.currentTarget.replaceWith(next);
        }
        document.getElementById('delta-target').addEventListener('click', replaceDeltaTarget);
      </script>
    </body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port })));
}

async function main() {
  await app.whenReady();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-preview-member-'));
  app.setPath('downloads', temp);
  const { server, url } = await startServer();
  const events = [];
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    assert.deepStrictEqual(preview._internals.effectiveBounds({ x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
    assert(/safe_name/.test(preview._internals.safeDownloadName('safe_name.txt')));
    assert(preview._internals.isLocalHttpsUrl('https://localhost:5173') && preview._internals.isLocalHttpsUrl('https://127.0.0.1:8443'), 'شهادة localhost ليست ضمن الاستثناء');
    assert(!preview._internals.isLocalHttpsUrl('https://example.com'), 'استثناء الشهادة يتسرب إلى نطاق خارجي');
    preview.setBounds({ x: 10, y: 10, width: 800, height: 600 });
    assert.strictEqual(preview.open(win, (event) => events.push(event), url + '/one').ok, true);
    const ready = await preview.waitFor({ selector: '#change' }, 5000);
    assert(ready.ok && ready.found, 'لم تجهز صفحة المسبار');

    win.showInactive();
    await delay(200);
    const fullShot = await preview.screenshotFull({ modelImage: true });
    const elementShot = await preview.screenshotElement('#shot-fixture', { modelImage: true });
    const viewportShot = await preview.screenshot({ modelImage: true });
    assert(fullShot.ok && elementShot.ok && viewportShot.ok, 'تعذّر أخذ عينات قياس اللقطات');
    assert.strictEqual(preview.SHOT_MAX_EDGE, 1280, 'سقف لقطة النموذج المعلن انحرف');
    assert.strictEqual(preview.SHOT_JPEG_QUALITY, 72, 'جودة JPEG المعلنة انحرفت');
    const shotBytes = {};
    for (const [name, shot] of [['full', fullShot], ['element', elementShot], ['viewport', viewportShot]]) {
      const data = Buffer.from(shot.base64, 'base64');
      const image = nativeImage.createFromBuffer(data);
      const size = image.getSize();
      shotBytes[name] = data.length;
      assert(data[0] === 0xff && data[1] === 0xd8, 'لقطة النموذج ' + name + ' ليست JPEG برأس FFD8');
      assert(size.width > 0 && size.height > 0 && Math.max(size.width, size.height) <= preview.SHOT_MAX_EDGE,
        'لقطة النموذج ' + name + ' تجاوزت السقف: ' + size.width + 'x' + size.height);
    }
    assert(fullShot.page_metrics && fullShot.page_metrics.content_height > fullShot.page_metrics.viewport_height,
      'لقطة الصفحة الكاملة فقدت page_metrics بعد التصغير');
    const thumbnailEvents = events.filter((event) => event.type === 'agent_screenshot');
    assert.strictEqual(thumbnailEvents.length, 3, 'لم تُبث مصغّرات المستخدم للعينات الثلاث');
    for (const event of thumbnailEvents) {
      assert(event.dataUrl.startsWith('data:image/png;base64,'), 'مصغّرة agent_screenshot لم تبق PNG');
      const data = Buffer.from(event.dataUrl.slice('data:image/png;base64,'.length), 'base64');
      const size = nativeImage.createFromBuffer(data).getSize();
      assert(data.length <= 512 * 1024 && size.width <= 360,
        'مصغّرة agent_screenshot تجاوزت 360px/512KiB: ' + size.width + 'px/' + data.length + 'B');
    }
    console.log('preview-member-live shot bytes (JPEG q' + preview.SHOT_JPEG_QUALITY + ', max '
      + preview.SHOT_MAX_EDGE + 'px): full=' + shotBytes.full + ' element=' + shotBytes.element
      + ' viewport=' + shotBytes.viewport);
    win.hide();

    const firstSnapshot = await preview.snapshot();
    const firstGenerationRef = firstSnapshot.snap.elements.join('\n').match(/\[(s\d+:e\d+)\] button "اختبر الجيل"/)[1];
    const secondSnapshot = await preview.snapshot();
    const secondGenerationRef = secondSnapshot.snap.elements.join('\n').match(/\[(s\d+:e\d+)\] button "اختبر الجيل"/)[1];
    assert.notStrictEqual(firstGenerationRef, secondGenerationRef, 'اللقطة الجديدة لم تغيّر جيل ref');
    assert.strictEqual(preview._internals.locatorError('e1'), 'stale_ref', 'ref القديم بلا جيل لم يُرفض');
    const staleContext = await preview.browserActionContext('browser_click', { ref: firstGenerationRef });
    assert.strictEqual(staleContext.error, 'stale_ref', 'بوابة الفعل لم ترفض ref القديم قبل قراءة DOM');
    assert.deepStrictEqual(await preview.clickElement(firstGenerationRef), { error: 'stale_ref' }, 'ref من جيل سابق لم يفشل بـ stale_ref');
    const untouched = await preview.evaluate("document.getElementById('generation-status').textContent");
    assert(untouched.ok && untouched.value === '0', 'ref القديم نفّذ فعلاً على DOM');
    const currentGenerationClick = await preview.clickElement(secondGenerationRef);
    assert(currentGenerationClick.ok && currentGenerationClick.dom_changed, 'ref من الجيل الحالي لم يعمل');

    const secondSnapshotText = secondSnapshot.snap.elements.join('\n');
    const deltaTargetRef = secondSnapshotText.match(/\[(s\d+:e\d+)\] button "بدّل دلتا"/)[1];
    const firstDeltaClick = await preview.clickElement(deltaTargetRef);
    const firstDeltaText = (firstDeltaClick.delta || []).join('\n');
    const firstAddedRef = (firstDeltaText.match(/\+ \[(s\d+:e\d+)\] button "بدّل دلتا"/) || [])[1];
    assert(firstDeltaClick.ok && firstDeltaClick.dom_changed && firstAddedRef,
      'الفعل لم يعد ref جديدة في DOM delta: ' + JSON.stringify(firstDeltaClick));
    assert(firstDeltaText.includes('- [' + deltaTargetRef + ']') || firstDeltaClick.delta_truncated,
      'DOM delta لم يذكر ref المحذوفة ولم يعلن قصّها');
    assert.strictEqual(firstAddedRef.split(':')[0], deltaTargetRef.split(':')[0], 'ref الجديدة خرجت من الجيل الحالي');
    assert.notStrictEqual(firstAddedRef, deltaTargetRef, 'أُعيد استخدام ref محذوفة داخل الجيل');
    assert(Buffer.byteLength(firstDeltaText, 'utf8') <= Math.floor(Buffer.byteLength(secondSnapshotText, 'utf8') * 0.25),
      'DOM delta تجاوزت 25% من اللقطة السابقة');

    const secondDeltaClick = await preview.clickElement(firstAddedRef);
    const secondDeltaText = (secondDeltaClick.delta || []).join('\n');
    const secondAddedRef = (secondDeltaText.match(/\+ \[(s\d+:e\d+)\] button "بدّل دلتا"/) || [])[1];
    assert(secondDeltaClick.ok && secondAddedRef && secondAddedRef !== firstAddedRef,
      'تعذّر استعمال ref الجديدة مباشرة بلا browser_snapshot');
    await preview.snapshot();
    assert.deepStrictEqual(await preview.clickElement(secondAddedRef), { error: 'stale_ref' },
      'اللقطة التالية لم تُبطل ref المولّدة من DOM delta');

    let startedAt = Date.now();
    const changed = await preview.clickElement('#change');
    const changedMs = Date.now() - startedAt;
    assert(changed.ok && changed.dom_changed && !changed.navigated, 'النقر لم يعد نتيجة DOM صادقة');
    // توسيع صريح للعقد (دفعة صقل المتصفح): dispatched/effect_observed يُضافان بجانب
    // dom_changed الذي يبقى كما هو للتوافق الخلفي؛ والنقر العام بلا satisfied (مجهول).
    assert(changed.dispatched === true && changed.effect_observed === true && !('satisfied' in changed),
      'دلالة نتيجة النقر لم تتوسّع كما ينص العقد: ' + JSON.stringify(changed));
    assert(changedMs < 200, 'التغير المتزامن لم ينهِ الانتظار مبكراً: ' + changedMs + 'ms');
    const flash = await preview.evaluate("!!document.querySelector('[data-satr-agent-flash]')");
    assert(flash.ok && flash.value === 'true', 'الوميض الذهبي غير موجود داخل الصفحة بعد الفعل');

    startedAt = Date.now();
    const delayed = await preview.clickElement('#delayed');
    const delayedMs = Date.now() - startedAt;
    assert(delayed.ok && delayed.dom_changed && delayedMs >= 100 && delayedMs < 300,
      'التغير المتأخر لم يُرصد تكيفياً: ' + delayedMs + 'ms');

    startedAt = Date.now();
    const noop = await preview.clickElement('#noop');
    const noopMs = Date.now() - startedAt;
    assert(noop.ok && !noop.dom_changed && !noop.navigated && /لم يُرصد/.test(noop.note), 'الفعل بلا أثر لم يعد ملاحظة صادقة');
    assert(noopMs >= 330, 'الفعل بلا أثر لم يحترم نافذة الرصد الكاملة: ' + noopMs + 'ms');

    const typed = await preview.typeText('#editor', 'نص غني');
    assert(typed.ok && typed.dom_changed, 'contenteditable لم يسجّل تغييراً');
    const editor = await preview.evaluate("document.getElementById('editor').innerText");
    assert(editor.ok && editor.value === 'نص غني', 'الكتابة في contenteditable لم تصل للنص');

    const tooLong = await preview.evaluate('x'.repeat(8001));
    assert.strictEqual(tooLong.error, 'bad_expression', 'browser_evaluate لا يفرض سقف التعبير');
    const viewport = await preview.setViewport(420, 500);
    assert(viewport.ok && viewport.actual.width === 420, 'set_viewport لم يغيّر innerWidth فعلياً');
    assert.strictEqual(await preview.browserTarget('browser_click', { ref: '#external' }), 'https://external.example/path', 'بوابة النقر لم تلتقط وجهة الرابط الخارجي');

    startedAt = Date.now();
    const clickedNext = await preview.clickElement('#next');
    const navigateMs = Date.now() - startedAt;
    assert(clickedNext.ok && clickedNext.navigated && navigateMs < 300, 'التنقّل بالنقر لم يُرصد تكيفياً: ' + navigateMs + 'ms');
    assert((await preview.waitFor({ text: 'الثانية' }, 5000)).found, 'لم تصل الصفحة الثانية');
    const back = await preview.back();
    assert(back.ok && back.navigated && /\/one$/.test(back.url), 'browser_back لم يرجع');
    const forward = await preview.forward();
    assert(forward.ok && forward.navigated && /\/two$/.test(forward.url), 'browser_forward لم يتقدم');
    await preview.back();

    const download = await preview.clickElement('#download');
    assert(download.ok, 'تعذّر بدء تنزيل الصفحة');
    for (let index = 0; index < 80 && !events.some((event) => event.type === 'preview_download_saved'); index += 1) await delay(50);
    const saved = events.find((event) => event.type === 'preview_download_saved');
    assert(saved && saved.path.startsWith(temp) && fs.readFileSync(saved.path, 'utf8') === 'downloaded', 'will-download لم يحفظ الملف في Downloads الفعلي');

    console.log('preview-member-live: نجح — أجيال refs وDOM delta المحدودة وstale_ref، صدق الأفعال، الوميض، contenteditable، evaluate، viewport، history، التنزيل، وحصر الشهادة محلياً.');
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
