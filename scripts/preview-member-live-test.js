'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
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
      <button id="noop">بلا تغيير</button><div id="status">idle</div>
      <div id="editor" contenteditable="true"><b>قديم</b></div>
      <a id="next" href="/two">التالي</a>
      <a id="external" href="https://external.example/path">خارجي</a>
      <a id="download" href="/fixture.txt" download="fixture.txt">نزّل</a>
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
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    assert.deepStrictEqual(preview._internals.effectiveBounds({ x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
    assert(/safe_name/.test(preview._internals.safeDownloadName('safe_name.txt')));
    assert(preview._internals.isLocalHttpsUrl('https://localhost:5173') && preview._internals.isLocalHttpsUrl('https://127.0.0.1:8443'), 'شهادة localhost ليست ضمن الاستثناء');
    assert(!preview._internals.isLocalHttpsUrl('https://example.com'), 'استثناء الشهادة يتسرب إلى نطاق خارجي');
    preview.setBounds({ x: 10, y: 10, width: 800, height: 600 });
    assert.strictEqual(preview.open(win, (event) => events.push(event), url + '/one').ok, true);
    const ready = await preview.waitFor({ selector: '#change' }, 5000);
    assert(ready.ok && ready.found, 'لم تجهز صفحة المسبار');

    const changed = await preview.clickElement('#change');
    assert(changed.ok && changed.dom_changed && !changed.navigated, 'النقر لم يعد نتيجة DOM صادقة');
    const flash = await preview.evaluate("!!document.querySelector('[data-satr-agent-flash]')");
    assert(flash.ok && flash.value === 'true', 'الوميض الذهبي غير موجود داخل الصفحة بعد الفعل');

    const noop = await preview.clickElement('#noop');
    assert(noop.ok && !noop.dom_changed && !noop.navigated && /لم يُرصد/.test(noop.note), 'الفعل بلا أثر لم يعد ملاحظة صادقة');

    const typed = await preview.typeText('#editor', 'نص غني');
    assert(typed.ok && typed.dom_changed, 'contenteditable لم يسجّل تغييراً');
    const editor = await preview.evaluate("document.getElementById('editor').innerText");
    assert(editor.ok && editor.value === 'نص غني', 'الكتابة في contenteditable لم تصل للنص');

    const tooLong = await preview.evaluate('x'.repeat(8001));
    assert.strictEqual(tooLong.error, 'bad_expression', 'browser_evaluate لا يفرض سقف التعبير');
    const viewport = await preview.setViewport(420, 500);
    assert(viewport.ok && viewport.actual.width === 420, 'set_viewport لم يغيّر innerWidth فعلياً');
    assert.strictEqual(await preview.browserTarget('browser_click', { ref: '#external' }), 'https://external.example/path', 'بوابة النقر لم تلتقط وجهة الرابط الخارجي');

    assert.strictEqual(preview.navigate(url + '/two').ok, true);
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

    console.log('preview-member-live: نجح — صدق الأفعال، الوميض، contenteditable، evaluate، viewport، history، التنزيل، وحصر الشهادة محلياً.');
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
