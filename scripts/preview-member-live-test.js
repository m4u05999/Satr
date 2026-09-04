'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');
const preview = require('../electron/preview');
const codexmcp = require('../electron/codexmcp');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function imageMime(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return '';
}

function modelEncodingCandidates(rawShot) {
  const raw = Buffer.from(rawShot.base64, 'base64');
  let image = nativeImage.createFromBuffer(raw);
  const sourceSize = image.getSize();
  if (sourceSize.width > preview.SHOT_MAX_EDGE) {
    const ratio = preview.SHOT_MAX_EDGE / sourceSize.width;
    image = image.resize({
      width: Math.max(1, Math.round(sourceSize.width * ratio)),
      height: Math.max(1, Math.round(sourceSize.height * ratio)),
      quality: 'good',
    });
  }
  const png = image.toPNG();
  const jpeg = image.toJPEG(preview.SHOT_JPEG_QUALITY);
  return {
    png: png.length, jpeg: jpeg.length, size: image.getSize(),
    selectedMime: png.length <= jpeg.length ? 'image/png' : 'image/jpeg',
    selectedBytes: Math.min(png.length, jpeg.length),
  };
}

function verifyModelEncoding(name, rawShot, modelShot) {
  assert.strictEqual(rawShot.mimeType, 'image/png', 'العينة الخام ' + name + ' لم تعد PNG');
  const candidates = modelEncodingCandidates(rawShot);
  const encoded = preview._internals.encodeScreenshot(nativeImage.createFromBuffer(Buffer.from(rawShot.base64, 'base64')), true);
  const data = Buffer.from(modelShot.base64, 'base64');
  assert(encoded && encoded.mimeType === candidates.selectedMime && encoded.data.length === candidates.selectedBytes,
    'مرمّز الإنتاج لم يختر الأصغر في ' + name + ': PNG=' + candidates.png + ' JPEG=' + candidates.jpeg);
  assert.strictEqual(modelShot.mimeType, candidates.selectedMime,
    'صيغة لقطة النموذج ' + name + ' ليست الأصغر: PNG=' + candidates.png + ' JPEG=' + candidates.jpeg);
  assert.strictEqual(imageMime(data), modelShot.mimeType, 'mimeType لا يطابق رأس بايتات ' + name);
  const returnedImage = nativeImage.createFromBuffer(data);
  const alternateBytes = modelShot.mimeType === 'image/png'
    ? returnedImage.toJPEG(preview.SHOT_JPEG_QUALITY).length : returnedImage.toPNG().length;
  assert(data.length <= alternateBytes,
    'الصيغة المعادة ليست الأصغر لبكسلات ' + name + ': selected=' + data.length + ' alternate=' + alternateBytes);
  assert(data.length > 0 && returnedImage.getSize().width <= preview.SHOT_MAX_EDGE,
    'عرض لقطة النموذج ' + name + ' تجاوز السقف الأفقي');
  return { ...candidates, actualBytes: data.length, actualSize: returnedImage.getSize() };
}

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
    if (request.url === '/oauth-close') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><h1>اكتمل OAuth</h1><script>window.close()</script></body></html>'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
      :root { --fixture-page:#f3f5f9; --fixture-surface:#fff; --fixture-text:#172033; --fixture-muted:#667085;
        --fixture-line:#d9deea; --fixture-primary:#3457d5; --fixture-primary-soft:#e8edff;
        --fixture-success:#147d64; --fixture-success-soft:#e2f5ef; --fixture-warning:#9a5b00;
        --fixture-warning-soft:#fff1d6; --fixture-shadow:rgba(23,32,51,.12); }
      * { box-sizing:border-box; } body { margin:0; background:var(--fixture-page); color:var(--fixture-text);
        direction:rtl; font-family:system-ui,sans-serif; text-align:start; }
      .test-controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 16px;
        background:var(--fixture-surface); border-bottom:1px solid var(--fixture-line); }
      button, input, a { font:inherit; } button, .fixture-action { border:1px solid var(--fixture-line);
        border-radius:8px; background:var(--fixture-surface); color:var(--fixture-text); padding:7px 12px; }
      #status, #generation-status { min-width:32px; color:var(--fixture-muted); }
      #editor { min-width:100px; padding:7px 10px; border:1px solid var(--fixture-line); border-radius:8px; }
      #shot-fixture { width:min(640px,calc(100% - 32px)); min-height:1300px; margin:24px auto;
        overflow:hidden; border:1px solid var(--fixture-line); border-radius:18px; background:var(--fixture-surface);
        box-shadow:0 12px 30px var(--fixture-shadow); }
      .fixture-header { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; padding:28px;
        color:var(--fixture-surface); background:var(--fixture-primary); }
      .fixture-header h1, .fixture-header p { margin:0; } .fixture-header p { margin-top:8px; opacity:.88; }
      .fixture-code { direction:ltr; unicode-bidi:isolate; white-space:nowrap; }
      .fixture-action { border-color:var(--fixture-surface); color:var(--fixture-primary); }
      .fixture-content { display:grid; gap:22px; padding:28px; }
      .fixture-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .fixture-card { padding:16px; border:1px solid var(--fixture-line); border-radius:12px;
        background:var(--fixture-surface); } .fixture-card h2 { margin:0 0 9px; font-size:15px; }
      .fixture-number { margin:0; font-size:28px; font-weight:700; } .fixture-note { margin:7px 0 0; color:var(--fixture-muted); }
      .fixture-panel { border:1px solid var(--fixture-line); border-radius:14px; overflow:hidden; }
      .fixture-panel-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:16px 18px;
        background:var(--fixture-primary-soft); } .fixture-panel h2 { margin:0; font-size:17px; }
      .fixture-list { list-style:none; margin:0; padding:0; } .fixture-list li { display:flex; gap:12px;
        justify-content:space-between; padding:15px 18px; border-top:1px solid var(--fixture-line); }
      .fixture-list p { margin:0; } .fixture-list small { display:block; margin-top:4px; color:var(--fixture-muted); }
      .fixture-badge { align-self:center; border-radius:999px; padding:5px 9px; color:var(--fixture-success);
        background:var(--fixture-success-soft); white-space:nowrap; }
      .fixture-badge.warn { color:var(--fixture-warning); background:var(--fixture-warning-soft); }
      .fixture-table-wrap { overflow:auto; } table { width:100%; border-collapse:collapse; }
      th, td { padding:13px 16px; border-top:1px solid var(--fixture-line); text-align:start; }
      th { color:var(--fixture-muted); font-size:13px; } .fixture-footer { padding:18px 28px 26px;
        color:var(--fixture-muted); border-top:1px solid var(--fixture-line); }
      @media (max-width:520px) { .fixture-cards { grid-template-columns:1fr; }
        .fixture-header { flex-direction:column; } .fixture-content { padding:18px; } }
    </style></head><body>
      <div class="test-controls">
        <button id="change" onclick="document.getElementById('status').textContent='changed'">غيّر</button>
        <button id="delayed" onclick="setTimeout(function(){document.getElementById('status').textContent='delayed'},120)">غيّر لاحقاً</button>
        <button id="noop">بلا تغيير</button><span id="status">idle</span>
        <button id="generation" onclick="document.getElementById('generation-status').textContent=Number(document.getElementById('generation-status').textContent)+1">اختبر الجيل</button>
        <span id="generation-status">0</span><button id="delta-target">بدّل دلتا</button>
        <div id="editor" contenteditable="true"><b>قديم</b></div>
        <a id="next" href="/two">التالي</a><a id="external" href="https://external.example/path">خارجي</a>
        <a id="download" href="/fixture.txt" download="fixture.txt">نزّل</a>
      </div>
      <main id="shot-fixture" aria-label="واجهة عربية فعلية لقياس ترميز اللقطات">
        <header class="fixture-header"><div><h1>لوحة متابعة المشروع</h1>
          <p>ملخّص واضح لحالة العمل والمهام المفتوحة لهذا الأسبوع.</p></div>
          <button class="fixture-action">إنشاء تقرير</button></header>
        <div class="fixture-content">
          <section class="fixture-cards" aria-label="المؤشرات">
            <article class="fixture-card"><h2>المهام المنجزة</h2><p class="fixture-number">24</p><p class="fixture-note">أعلى بثلاث مهام من أمس</p></article>
            <article class="fixture-card"><h2>قيد المراجعة</h2><p class="fixture-number">7</p><p class="fixture-note">مراجعتان تحتاجان قراراً</p></article>
            <article class="fixture-card"><h2>وقت الاستجابة</h2><p class="fixture-number"><span class="fixture-code">1.8s</span></p><p class="fixture-note">ضمن الهدف التشغيلي</p></article>
          </section>
          <section class="fixture-panel"><div class="fixture-panel-head"><h2>آخر الأنشطة</h2><span>اليوم</span></div>
            <ul class="fixture-list">
              <li><p>اكتملت مراجعة صفحة الإعدادات<small>راجع الفريق الاتجاه والتباين وحالة التحميل.</small></p><span class="fixture-badge">مكتمل</span></li>
              <li><p><span class="fixture-code">SHA-256</span> تم التحقق من بصمة الحزمة<small>طابقت البصمة الملف المنشور في قناة الاختبار.</small></p><span class="fixture-badge">سليم</span></li>
              <li><p>تحديث بيانات المشروع متأخر<small>آخر مزامنة كانت قبل خمس عشرة دقيقة.</small></p><span class="fixture-badge warn">تنبيه</span></li>
              <li><p>أضيف عضوان إلى مساحة العمل<small>الصلاحيات الافتراضية للقراءة فقط.</small></p><span class="fixture-badge">جديد</span></li>
            </ul>
          </section>
          <section class="fixture-panel"><div class="fixture-panel-head"><h2>إصدارات هذا الأسبوع</h2><button>عرض الكل</button></div>
            <div class="fixture-table-wrap"><table><thead><tr><th>الإصدار</th><th>الحالة</th><th>المدة</th></tr></thead>
              <tbody><tr><td class="fixture-code">v2.16.9</td><td>جاهز للاختبار</td><td class="fixture-code">08:42</td></tr>
              <tr><td class="fixture-code">v2.16.8</td><td>نُشر بنجاح</td><td class="fixture-code">06:15</td></tr>
              <tr><td class="fixture-code">v2.16.7</td><td>مؤرشف</td><td class="fixture-code">05:58</td></tr></tbody></table></div>
          </section>
          <section class="fixture-panel"><div class="fixture-panel-head"><h2>ملاحظات الفريق</h2><span>٤ ملاحظات</span></div>
            <ul class="fixture-list"><li><p>تأكد من وضوح رسائل الفشل قبل بدء تجربة القبول.<small>لكل خطوة نتيجة صواب وفشل مكتوبة سلفاً.</small></p></li>
              <li><p>راجع التخطيط عند العرض الضيق.<small>يجب ألا يظهر تمرير أفقي في الصفحة.</small></p></li></ul>
          </section>
        </div>
        <footer class="fixture-footer">آخر تحديث: اليوم، الساعة <span class="fixture-code">14:30</span></footer>
      </main>
      <script>
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
  const win = new BrowserWindow({ show: false, width: 900, height: 860,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    assert.deepStrictEqual(preview._internals.effectiveBounds({ x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
    assert(/safe_name/.test(preview._internals.safeDownloadName('safe_name.txt')));
    assert(preview._internals.isLocalHttpsUrl('https://localhost:5173') && preview._internals.isLocalHttpsUrl('https://127.0.0.1:8443'), 'شهادة localhost ليست ضمن الاستثناء');
    assert(!preview._internals.isLocalHttpsUrl('https://example.com'), 'استثناء الشهادة يتسرب إلى نطاق خارجي');
    preview.setBounds({ x: 10, y: 10, width: 700, height: 760 });
    assert.strictEqual(preview.open(win, (event) => events.push(event), url + '/one').ok, true);
    const ready = await preview.waitFor({ selector: '#change' }, 5000);
    assert(ready.ok && ready.found, 'لم تجهز صفحة المسبار');

    win.showInactive();
    await delay(200);
    const fixtureKind = await preview.evaluate("document.querySelector('#shot-fixture').tagName + ':' + document.querySelectorAll('#shot-fixture canvas').length");
    assert(fixtureKind.ok && fixtureKind.value === 'MAIN:0', 'عينة الترميز ليست واجهة DOM فعلية بلا canvas ضوضاء');
    const rawFullShot = await preview.screenshotFull();
    const rawElementShot = await preview.screenshotElement('#shot-fixture', { emitThumbnail: false });
    const rawViewportShot = await preview.screenshot();
    assert(rawFullShot.ok && rawElementShot.ok && rawViewportShot.ok, 'تعذّر أخذ PNG الخام لقياس الصيغتين');
    events.length = 0;
    const fullShot = await preview.screenshotFull({ modelImage: true });
    const elementShot = await preview.screenshotElement('#shot-fixture', { modelImage: true });
    const viewportShot = await preview.screenshot({ modelImage: true });
    assert(fullShot.ok && elementShot.ok && viewportShot.ok, 'تعذّر أخذ عينات قياس اللقطات');
    assert.strictEqual(preview.SHOT_MAX_EDGE, 1280, 'سقف لقطة النموذج المعلن انحرف');
    assert.strictEqual(preview.SHOT_JPEG_QUALITY, 72, 'جودة JPEG المعلنة انحرفت');
    const actualViewport = await preview.evaluate('String(window.innerWidth)');
    const viewportWidth = Number(actualViewport.value);
    const fullModelSize = nativeImage.createFromBuffer(Buffer.from(fullShot.base64, 'base64')).getSize();
    assert(actualViewport.ok && viewportWidth > 0 && viewportWidth <= preview.SHOT_MAX_EDGE,
      'عرض نافذة القياس غير صالح لاختبار حفظ عرض full_page: ' + actualViewport.value);
    assert(fullModelSize.width >= viewportWidth,
      'full_page صُغّرت عن عرض النافذة: ' + fullModelSize.width + ' < ' + viewportWidth);
    assert(fullModelSize.height > preview.SHOT_MAX_EDGE,
      'الحارس لا يثبت بقاء طول full_page فوق السقف الأفقي: ' + fullModelSize.height);
    const measurements = {
      full: verifyModelEncoding('full', rawFullShot, fullShot),
      element: verifyModelEncoding('element', rawElementShot, elementShot),
      viewport: verifyModelEncoding('viewport', rawViewportShot, viewportShot),
    };
    assert(fullShot.page_metrics && fullShot.page_metrics.content_height > fullShot.page_metrics.viewport_height,
      'لقطة الصفحة الكاملة فقدت page_metrics بعد التصغير');
    const pickShot = await preview.screenshotElement('#shot-fixture', {
      emitThumbnail: false, modelImage: true, preserveDisplayImage: true,
    });
    assert(pickShot.ok && pickShot.mimeType === 'image/png' && imageMime(Buffer.from(pickShot.base64, 'base64')) === 'image/png',
      'نسخة العرض في عقد 🎯 لم تبق PNG');
    assert(pickShot.modelBase64 && pickShot.modelMimeType === measurements.element.selectedMime
      && imageMime(Buffer.from(pickShot.modelBase64, 'base64')) === pickShot.modelMimeType,
      'عقد 🎯 لم يعد نسخة النموذج ومطابقة mimeType منفصلين');
    const thumbnailEvents = events.filter((event) => event.type === 'agent_screenshot');
    assert.strictEqual(thumbnailEvents.length, 3, 'لم تُبث مصغّرات المستخدم للعينات الثلاث');
    for (const event of thumbnailEvents) {
      assert(event.dataUrl.startsWith('data:image/png;base64,'), 'مصغّرة agent_screenshot لم تبق PNG');
      const data = Buffer.from(event.dataUrl.slice('data:image/png;base64,'.length), 'base64');
      const size = nativeImage.createFromBuffer(data).getSize();
      assert(data.length <= 512 * 1024 && size.width <= 360,
        'مصغّرة agent_screenshot تجاوزت 360px/512KiB: ' + size.width + 'px/' + data.length + 'B');
    }
    console.log('preview-member-live encoding bytes (real Arabic UI, width cap ' + preview.SHOT_MAX_EDGE
      + 'px, JPEG q' + preview.SHOT_JPEG_QUALITY + '):');
    console.log('| sample | PNG | JPEG | selected |');
    for (const name of ['full', 'element', 'viewport']) {
      const item = measurements[name];
      console.log('| ' + name + ' | ' + item.png + ' | ' + item.jpeg + ' | '
        + item.selectedMime + ' (' + item.selectedBytes + ') |');
    }
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

    // OBS-078 — تشخيص قبل العلاج: نفصل الفرضيات الثلاث بلا استنتاج من سجل التفكير.
    // (أ) دورتا handoff متتاليتان، (ب) origin آخر أثناء الثانية، ثم callback يطلب
    // window.close كما تفعل تدفقات OAuth المنبثقة. الناتج المطبوع هو دليل السبب.
    let handoffAction = async () => true;
    const handoffTool = codexmcp.buildTools({
      preview,
      requestHandoff: (...args) => handoffAction(...args),
    }).find((tool) => tool.name === 'browser_handoff');
    const firstHandoff = await handoffTool.handler({ reason: 'التسليم الأول' });
    const firstActiveAfter = preview.isHandoffActive();
    const crossOriginUrl = url.replace('127.0.0.1', 'localhost');
    let crossOriginNavigate = null;
    let crossOriginAliveDuring = false;
    let secondActiveDuring = false;
    handoffAction = async () => {
      secondActiveDuring = preview.isHandoffActive();
      crossOriginNavigate = preview.navigate(crossOriginUrl + '/two');
      await delay(350);
      crossOriginAliveDuring = !!preview.currentUrl();
      return true;
    };
    const secondHandoff = await handoffTool.handler({ reason: 'التسليم الثاني' });
    const secondActiveAfter = preview.isHandoffActive();
    const crossOriginRead = await preview.readPage();
    console.log('OBS078_FILTER_A=' + JSON.stringify({
      first_ok: !firstHandoff.isError,
      first_active_after: firstActiveAfter,
      second_ok: !secondHandoff.isError,
      second_active_during: secondActiveDuring,
      second_active_after: secondActiveAfter,
    }));
    console.log('OBS078_FILTER_B=' + JSON.stringify({
      navigate_ok: crossOriginNavigate.ok === true,
      alive_during_handoff: crossOriginAliveDuring,
      read_after_handoff: crossOriginRead.ok === true,
    }));

    let oauthNavigate = null;
    handoffAction = async () => {
      oauthNavigate = preview.navigate(crossOriginUrl + '/oauth-close');
      await delay(350);
      return true;
    };
    const oauthHandoff = await handoffTool.handler({ reason: 'أكمل تسجيل الدخول' });
    const oauthAliveAfter = !!preview.currentUrl();
    console.log('OBS078_OAUTH_CLOSE=' + JSON.stringify({
      handoff_result_ok: !oauthHandoff.isError,
      navigate_ok: oauthNavigate.ok === true,
      alive_after_callback: oauthAliveAfter,
    }));
    assert.strictEqual(oauthAliveAfter, false,
      'صفحة OAuth المضبوطة لم تعد تنتج حالة العرض المدمّر المرصودة في OBS-078');

    // التسلسل الفعلي المطلوب حراسته: handoff ⇒ استلام ⇒ open_preview ⇒ أداة قراءة.
    // openPreview هنا يحاكي satr:event/renderer: الطلب يعود إلى main في نبضة لاحقة.
    let reopenRequested = false;
    let reopenApplied = false;
    let reopenTimer = null;
    const recoveryTools = codexmcp.buildTools({
      preview,
      openPreview: (requestedUrl) => {
        reopenRequested = true;
        reopenTimer = setTimeout(() => {
          reopenApplied = preview.open(win, (event) => events.push(event), requestedUrl).ok === true;
        }, 80);
      },
    });
    const openTool = recoveryTools.find((tool) => tool.name === 'open_preview');
    const readTool = recoveryTools.find((tool) => tool.name === 'read_page');
    const reopened = await openTool.handler({ url: url + '/one' });
    const appliedWhenOpenReturned = reopenApplied;
    const readAfterReopen = await readTool.handler({});
    const aliveAfterRead = !!preview.currentUrl();
    // في زرع الكود القديم ندع نبضة المحاكاة تكتمل بعد التقاط النتيجة الخاطئة؛ يمنع
    // Electron من إنهاء fixture قبل أن يطبع assertion، ولا يغيّر ما قاسه الحارس.
    if (!appliedWhenOpenReturned && reopenTimer) await delay(120);
    console.log('OBS078_RECOVERY=' + JSON.stringify({
      requested: reopenRequested,
      open_error: reopened.isError,
      applied_when_open_returned: appliedWhenOpenReturned,
      read_error: readAfterReopen.isError,
      alive_after_read: aliveAfterRead,
    }));
    const openConfirmed = reopenRequested && !reopened.isError && appliedWhenOpenReturned;
    if (!openConfirmed) {
      console.error('preview-member-live: AssertionError [ERR_ASSERTION]: OBS-078: open_preview أعلن النجاح قبل تأكيد إعادة إنشاء العرض بعد callback OAuth');
      app.exit(1);
      return;
    }
    assert(openConfirmed,
      'OBS-078: open_preview أعلن النجاح قبل تأكيد إعادة إنشاء العرض بعد callback OAuth');
    assert(!readAfterReopen.isError && /الأزرار/.test(readAfterReopen.content[0].text),
      'OBS-078: أداة القراءة بقيت ترى المعاينة مغلقة بعد handoff ⇒ استلام ⇒ open_preview');

    console.log('preview-member-live: نجح — أصغر PNG/JPEG وحفظ عرض full_page وعقد 🎯، أجيال refs وDOM delta المحدودة وstale_ref، صدق الأفعال، الوميض، contenteditable، evaluate، viewport، history، التنزيل، وحصر الشهادة محلياً.');
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
