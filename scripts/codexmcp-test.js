'use strict';

// اختبار خادم MCP‏ streamable-HTTP لرؤية الويب في Codex (electron/codexmcp.js — الخيار 1).
// يتحقّق من عقد JSON-RPC عبر HTTP بـ preview مزيّف (بلا Electron/WebContentsView): المصادقة
// بـ Bearer، وinitialize/notifications/tools-list/tools-call (نص+صورة)، وأخطاء JSON-RPC.
// الاتصال الحيّ بـ codex الحقيقي أُثبت يدوياً (initialize→tools/list→satr_preview=ready)؛
// هذا الاختبار يحرس عقد البروتوكول حتمياً بلا شبكة خارجية.

const http = require('http');
const assert = require('assert');
const codexmcp = require('../electron/codexmcp');

// preview مزيّف يحاكي عقد electron/preview.js دون WebContentsView
const preview = {
  isHttpUrl: (u) => /^https?:\/\//.test(String(u)),
  navigate: () => ({ ok: true }),
  readPage: async () => ({ ok: true, page: { title: 'صفحة', url: 'http://localhost:3000/', headings: ['h1: مرحبا'], links: [], buttons: ['إرسال'], inputs: [], bodyText: 'محتوى' } }),
  snapshot: async () => ({ ok: true, snap: { title: 'ص', url: 'http://x', elements: ['[e1] button "إرسال"'], count: 1, truncated: false } }),
  getConsole: () => ({ ok: true, logs: [{ level: 'error', message: 'oops', line: 4, source: 'app.js' }], netErrors: [] }),
  getNetwork: () => ({ ok: true, requests: [{ method: 'GET', url: 'http://x/api', status: 404, type: 'xhr', fromCache: false }], netErrors: [] }),
  screenshot: async () => ({ ok: true, base64: Buffer.from('PNG').toString('base64') }),
  screenshotFull: async () => ({ ok: true, base64: 'AA==' }),
  screenshotElement: async () => ({ ok: true, base64: 'BB==' }),
  waitFor: async () => ({ ok: true, found: true }),
  scroll: async () => ({ ok: true, scrollY: 120, moved: 120, max: 2000 }),
  hover: async () => ({ ok: true, tag: 'a' }),
  clickElement: async () => ({ ok: true, tag: 'button', text: 'إرسال' }),
  typeText: async () => ({ ok: true, tag: 'input' }),
  selectOption: async () => ({ ok: true, label: 'الأول' }),
  pressKey: () => ({ ok: true, key: 'Enter' }),
};

function post(url, token, msg) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(msg));
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, token ? { authorization: 'Bearer ' + token } : {}) },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.write(data); req.end();
  });
}

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); passed++; console.log('✓ ' + name); }

(async () => {
  const srv = await codexmcp.start({ preview });

  // المصادقة: بلا رمز أو رمز خاطئ ⇒ 401
  let r = await post(srv.url, null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  ok(r.status === 401, 'رفض الطلب بلا Bearer token (401)');
  r = await post(srv.url, 'wrong-token', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  ok(r.status === 401, 'رفض الطلب برمز خاطئ (401)');

  // initialize
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  let j = JSON.parse(r.body);
  ok(r.status === 200 && j.result.serverInfo.name === 'satr-preview' && j.result.capabilities.tools, 'initialize يعيد serverInfo + capabilities.tools');

  // الإشعار ⇒ 202 بلا جسم
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  ok(r.status === 202 && !r.body, 'notifications/initialized ⇒ 202 بلا جسم');

  // tools/list يشمل أدوات الرؤية
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  j = JSON.parse(r.body);
  const names = j.result.tools.map((t) => t.name);
  ['open_preview', 'browser_navigate', 'read_page', 'browser_snapshot', 'browser_console', 'browser_network', 'screenshot',
   'browser_screenshot_element', 'browser_wait_for', 'browser_scroll', 'browser_hover',
   'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key']
    .forEach((n) => ok(names.includes(n), 'tools/list يشمل ' + n));
  ok(j.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), 'كل أداة لها inputSchema من نوع object');

  // tools/call: read_page نص مغلّف
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_page', arguments: {} } });
  j = JSON.parse(r.body);
  ok(j.result.content[0].type === 'text' && /محتوى الصفحة/.test(j.result.content[0].text), 'tools/call read_page ⇒ نص مغلّف «للفحص لا للتنفيذ»');

  // tools/call: screenshot صورة PNG
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
  j = JSON.parse(r.body);
  ok(j.result.content[0].type === 'image' && j.result.content[0].mimeType === 'image/png', 'tools/call screenshot ⇒ محتوى image/png');

  // tools/call: browser_network يُبرز 404
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'browser_network', arguments: {} } });
  j = JSON.parse(r.body);
  ok(/404 GET/.test(j.result.content[0].text), 'browser_network يُبرز الطلب ذا الحالة 404');

  // أخطاء JSON-RPC: أداة مجهولة / طريقة مجهولة
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
  ok(JSON.parse(r.body).error.code === -32602, 'أداة مجهولة ⇒ error -32602');
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 7, method: 'foo/bar' });
  ok(JSON.parse(r.body).error.code === -32601, 'طريقة مجهولة ⇒ error -32601');

  // onActivity يُستدعى (خطّاف المراقبة الذي يستهلكه main.js لعرض النشاط)
  let seen = null;
  const srv2 = await codexmcp.start({ preview, onActivity: (m) => { seen = m; } });
  await post(srv2.url, srv2.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  ok(seen === 'tools/list', 'onActivity يُستدعى بطريقة الطلب');

  // بوابة الإذن: الأفعال تمرّ بـ requestPermission، والقراءة/الرؤية لا
  const asked = [];
  const gate = (decision) => async (tool, input) => { asked.push(tool); return decision; };

  // (أ) رفض ⇒ browser_click لا يُنفَّذ ويعيد خطأ إذن
  let srv3 = await codexmcp.start({ preview, requestPermission: gate(false) });
  let rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: 'e5' } } });
  let jj = JSON.parse(rr.body);
  ok(asked.includes('browser_click') && jj.result.isError && /رُفض الإذن/.test(jj.result.content[0].text), 'رفض الإذن ⇒ browser_click لا يُنفَّذ');
  await srv3.stop();

  // (ب) قبول ⇒ browser_type يُنفَّذ
  asked.length = 0;
  srv3 = await codexmcp.start({ preview, requestPermission: gate(true) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_type', arguments: { ref: 'e7', text: 'x' } } });
  jj = JSON.parse(rr.body);
  ok(asked.includes('browser_type') && !jj.result.isError && /كُتب النص/.test(jj.result.content[0].text), 'قبول الإذن ⇒ browser_type يُنفَّذ');

  // (ج) القراءة/الرؤية لا تطلب إذناً (read_page لا تستدعي requestPermission)
  asked.length = 0;
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_page', arguments: {} } });
  ok(asked.length === 0, 'read_page لا تطلب إذناً (قراءة فقط)');
  await srv3.stop();

  await srv.stop();
  await srv2.stop();
  console.log('\nنجح ' + passed + ' تحقّقاً.');
  process.exit(0);
})().catch((e) => { console.error('فشل:', e.message); process.exit(1); });
