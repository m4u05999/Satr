'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const preview = require('../electron/preview');
const browserpolicy = require('../electron/browserpolicy');

const TRANSFER_SECRET = 'sk-proj-transferabcdefghijklmnopqrstuvwxyz';
const USER_SECRET = 'sk-proj-userenteredabcdefghijklmnopqrstuvwxyz';
const FONT_PATH = path.join(__dirname, '..', 'site', 'vendor', 'fonts', 'ibm-plex-sans-arabic-arabic-400-normal.woff2');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/real-network-failure') {
      request.socket.destroy();
      return;
    }
    if (request.url.startsWith('/cache-probe-font.woff2')) {
      response.writeHead(200, { 'content-type': 'font/woff2' });
      response.end(fs.readFileSync(FONT_PATH));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/source') {
      response.end(`<!doctype html><html lang="ar"><head><title>Brevo</title></head><body>
        <h1>Brevo SMTP</h1><label>API key <input id="source" value="${TRANSFER_SECRET}"></label>
      </body></html>`);
      return;
    }
    response.end(`<!doctype html><html lang="ar"><head><title>Netlify</title></head><body>
      <h1>Netlify Forms</h1>
      <form method="post" action="https://external.example/deploy">
        <label>Host <input id="host"></label><label>Port <input id="port"></label>
        <label>Secret <input id="target"></label><label>Manual <input id="manual"></label>
        <button id="submit" type="submit">Deploy</button>
      </form><button id="ordinary-button">Toggle details</button><a id="ordinary" href="/source">View source</a>
      <script>
        setInterval(function () {
          var field = document.getElementById('manual');
          if (field.hasAttribute('data-satr-secret-field') && !field.value) {
            var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(field, ${JSON.stringify(USER_SECRET)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.setAttribute('data-leak-scheduled', '1');
            setTimeout(function () {
              console.log(${JSON.stringify(USER_SECRET)});
              fetch('/collect?api_key=' + encodeURIComponent(${JSON.stringify(USER_SECRET)})).catch(function () {});
            }, 1500);
          }
        }, 20);
      </script>
    </body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, url: 'http://127.0.0.1:' + server.address().port });
  }));
}

async function main() {
  await app.whenReady();
  const { server, url } = await startServer();
  const events = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    preview.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    assert.strictEqual(preview.open(win, (event) => events.push(event), url + '/source').ok, true);
    assert((await preview.waitFor({ selector: '#source' }, 5000)).found, 'لم تجهز صفحة المصدر');

    const snap = await preview.snapshot();
    assert(snap.ok && !JSON.stringify(snap).includes(TRANSFER_SECRET), 'snapshot سرّب قيمة الحقل المصدر');
    const stored = await preview.transferField('#source', '', '');
    assert(stored.ok && stored.stored && /^xfer_[a-f0-9]{32}$/.test(stored.transfer_id), 'لم يُنشأ معرّف نقل مبهم');
    assert(!JSON.stringify(stored).includes(TRANSFER_SECRET), 'نتيجة التقاط النقل سرّبت القيمة');

    assert.strictEqual(preview.navigate(url + '/target').ok, true);
    assert((await preview.waitFor({ selector: '#target' }, 5000)).found, 'لم تجهز صفحة الهدف');

    const cacheProbe = await preview.evaluate("new FontFace('SatrCacheProbe', 'url(/cache-probe-font.woff2?v=' + Date.now() + ')').load().then(function(font){ return font.status; }).catch(function(){ return 'failed'; })");
    assert(cacheProbe.ok && cacheProbe.value === 'loaded', 'مسبار الخط لم ينجح عبر network fallback');
    await preview.evaluate("fetch('/real-network-failure').catch(function(){ return 'failed'; })");
    await delay(150);
    const networkErrors = preview.getNetwork().netErrors;
    assert(!networkErrors.some((entry) => entry.error === 'net::ERR_CACHE_MISS' && entry.type === 'font'),
      'cache miss التمهيدي للخط ظهر كخطأ قابل للإصلاح');
    assert(!events.some((event) => event.type === 'neterr' && event.error === 'net::ERR_CACHE_MISS' && event.resourceType === 'font'),
      'cache miss التمهيدي للخط وصل إلى موجة أخطاء الواجهة');
    assert(networkErrors.some((entry) => entry.url.endsWith('/real-network-failure') && entry.error !== 'net::ERR_CACHE_MISS'),
      'إصلاح ضجيج cache أخفى خطأ شبكة حقيقياً');
    assert(events.some((event) => event.type === 'neterr' && event.url.endsWith('/real-network-failure')),
      'خطأ الشبكة الحقيقي لم يصل إلى الواجهة');

    const filled = await preview.fillForm([
      { ref: '#host', value: 'smtp-relay.brevo.com' },
      { ref: '#port', value: '587' },
    ]);
    assert.deepStrictEqual(filled, { ok: true, filled: 2 }, 'fill_form لم يعبّئ الحقلين');
    const visible = await preview.evaluate("[document.querySelector('#host').value,document.querySelector('#port').value]");
    assert(visible.ok && /smtp-relay\.brevo\.com/.test(visible.value) && /587/.test(visible.value), 'القيم غير السرّية لم تصل للحقول');
    assert.strictEqual((await preview.fillForm([{ ref: '#target', value: TRANSFER_SECRET }])).error, 'secret', 'fill_form قبل قيمة سرّية');

    const moved = await preview.transferField('', '#target', stored.transfer_id);
    assert.deepStrictEqual(moved, { ok: true, moved: true }, 'لم تُلصق القيمة المنقولة في الصفحة الثانية');
    assert(!JSON.stringify(moved).includes(TRANSFER_SECRET), 'نتيجة اللصق سرّبت القيمة');
    assert.strictEqual((await preview.evaluate("document.querySelector('#target').value")).error, 'secret_result', 'evaluate كشف السر المنقول');

    const requestPromise = preview.requestSecret('#manual', 'مفتاح SMTP الذي يدخله المستخدم');
    for (let index = 0; index < 80 && !events.some((event) => event.type === 'secret_request'); index += 1) await delay(25);
    const requestEvent = events.find((event) => event.type === 'secret_request');
    assert(requestEvent && /^secret_[a-f0-9]{32}$/.test(requestEvent.id), 'لم يظهر طلب السر الحي');
    await delay(1200);
    assert.deepStrictEqual(await preview.resolveSecretRequest(requestEvent.id, true), { ok: true }, 'تعذّر حسم إدخال المستخدم');
    const requested = await requestPromise;
    assert.deepStrictEqual(requested, { ok: true, filled: true }, 'request_secret لم يعد filled فقط');
    assert.strictEqual((await preview.evaluate("document.querySelector('#manual').value")).error, 'secret_result', 'evaluate كشف السر الذي أدخله المستخدم');

    const submitContext = await preview.browserActionContext('browser_click', { ref: '#submit' });
    assert(submitContext.isSubmit && submitContext.crossOriginPost && browserpolicy.isSensitiveAction('browser_click', {}, submitContext), 'submit عبر أصل لم يُصنّف حساساً');
    const ordinaryButtonContext = await preview.browserActionContext('browser_click', { ref: '#ordinary-button' });
    assert(!ordinaryButtonContext.isSubmit && !browserpolicy.isSensitiveAction('browser_click', {}, ordinaryButtonContext), 'زر عادي خارج form صُنّف إرسالاً حساساً');
    const linkContext = await preview.browserActionContext('browser_click', { ref: '#ordinary' });
    assert(!browserpolicy.isSensitiveAction('browser_click', {}, linkContext), 'الرابط العادي صُنّف حساساً');

    await delay(600);
    const exposed = JSON.stringify({ events, console: preview.getConsole(), network: preview.getNetwork(), stored, moved, requested });
    assert(!exposed.includes(TRANSFER_SECRET) && !exposed.includes(USER_SECRET), 'ظهر سر في حدث IPC أو نتيجة أو سجل');
    console.log('browser-platform-live: نجح — نقل آمن، بوابة submit، وتصفية cache probe للخط مع إبقاء فشل الشبكة الحقيقي.');
  } finally {
    preview.destroy();
    if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
