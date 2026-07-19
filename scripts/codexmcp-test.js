'use strict';

// اختبار خادم MCP‏ streamable-HTTP لرؤية الويب في Codex (electron/codexmcp.js — الخيار 1).
// يتحقّق من عقد JSON-RPC عبر HTTP بـ preview مزيّف (بلا Electron/WebContentsView): المصادقة
// بـ Bearer، وinitialize/notifications/tools-list/tools-call (نص+صورة)، وأخطاء JSON-RPC.
// الاتصال الحيّ بـ codex الحقيقي أُثبت يدوياً (initialize→tools/list→satr_preview=ready)؛
// هذا الاختبار يحرس عقد البروتوكول حتمياً بلا شبكة خارجية.

const http = require('http');
const assert = require('assert');
const codexmcp = require('../electron/codexmcp');
const codex = require('../electron/codex');

// preview مزيّف يحاكي عقد electron/preview.js دون WebContentsView
const preview = {
  _fillCalls: 0,
  isHttpUrl: (u) => /^https?:\/\//.test(String(u)),
  navigate: () => ({ ok: true }),
  currentUrl: () => 'https://untrusted.example/page',
  navigationTarget: (direction) => direction === 'back' ? 'https://previous.example/' : 'https://next.example/',
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
  clickElement: async () => ({ ok: true, tag: 'button', text: 'إرسال', navigated: false, dom_changed: true }),
  typeText: async () => ({ ok: true, tag: 'input', navigated: false, dom_changed: true }),
  selectOption: async () => ({ ok: true, label: 'الأول', navigated: false, dom_changed: true }),
  pressKey: async () => ({ ok: true, key: 'Enter', navigated: false, dom_changed: false, note: 'لم يتغيّر شيء' }),
  browserActionContext: async (tool, input) => ({
    currentUrl: 'https://untrusted.example/page', targetUrl: 'https://untrusted.example/page',
    elementText: input && input.ref === 'delete-button' ? 'Delete' : '', tag: 'button',
  }),
  fillForm: async (fields) => { preview._fillCalls += 1; return { ok: true, filled: Array.isArray(fields) ? fields.length : 0 }; },
  transferField: async (from, to) => from && !to
    ? { ok: true, stored: true, transfer_id: 'xfer_0123456789abcdef0123456789abcdef', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }
    : { ok: true, moved: true, value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' },
  requestSecret: async () => ({ ok: true, filled: true, value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }),
  evaluate: async () => ({ ok: true, value: '{"ready":true}', truncated: false }),
  setViewport: async (width, height) => ({ ok: true, requested: { width, height }, actual: { width, height: height || 600 } }),
  perf: async () => ({ ok: true, perf: { navigation: { load: 120 } }, failed_requests: [] }),
  back: async () => ({ ok: true, navigated: true, dom_changed: false, url: 'https://previous.example/' }),
  forward: async () => ({ ok: true, navigated: true, dom_changed: false, url: 'https://next.example/' }),
  // حالة التسليم البشري (browser_handoff) — يحاكي عقد preview.js: علم واحد + idempotent
  _handoff: false,
  startHandoff() { if (this._handoff) return { ok: false, error: 'active' }; this._handoff = true; return { ok: true }; },
  endHandoff() { const was = this._handoff; this._handoff = false; return { ok: true, wasActive: was }; },
  isHandoffActive() { return this._handoff; },
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
  ok(codex.isExternalBrowserLaunchCommand('Start-Process http://localhost:3000'), 'سياسة Codex تحجب إطلاق متصفح خارجي إلى localhost');
  ok(codex.isExternalBrowserLaunchCommand('msedge.exe https://example.com'), 'سياسة Codex تحجب تشغيل متصفح صريح');
  ok(!codex.isExternalBrowserLaunchCommand('npm run dev'), 'سياسة Codex لا تحجب خادم التطوير');
  ok(!codex.isExternalBrowserLaunchCommand('rg chrome electron'), 'سياسة Codex لا تحجب بحثاً نصياً عن متصفح');
  const cleaned = codexmcp._internals.permissionInput({ text: 'x'.repeat(5000), ref: 'e7', injected: 'no' });
  ok(cleaned.text.length === 4000 && cleaned.ref === 'e7' && !Object.hasOwn(cleaned, 'injected'), 'تفاصيل إذن المتصفح منقّاة ومحدودة');
  const cleanedFields = codexmcp._internals.permissionInput({ fields: [{ ref: 'e1', value: 'smtp-relay.brevo.com', injected: 'no' }] });
  ok(cleanedFields.fields[0].value === 'smtp-relay.brevo.com' && !Object.hasOwn(cleanedFields.fields[0], 'injected'), 'حقول إذن fill_form مرئية ومنقّاة');
  const allowAll = async () => true;
  const srv = await codexmcp.start({ preview, requestPermission: allowAll });

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
   'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key', 'browser_handoff',
   'browser_fill_form', 'browser_transfer_field', 'browser_request_secret', 'browser_handoff_step',
   'browser_evaluate', 'browser_set_viewport', 'browser_perf', 'browser_back', 'browser_forward',
   'run_in_background', 'get_background_output', 'list_background_tasks', 'stop_background_task']
    .forEach((n) => ok(names.includes(n), 'tools/list يشمل ' + n));
  ok(names.length === 29, 'عدد أدوات Codex MCP أصبح 29 (25 متصفح + 4 خلفية)');
  ok(j.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), 'كل أداة لها inputSchema من نوع object');
  const builtTools = codexmcp.buildTools({ preview });
  const built = (name) => builtTools.find((tool) => tool.name === name);
  ok(built('browser_evaluate').browserClass === 'act', 'browser_evaluate مصنّفة act');
  ok(built('browser_set_viewport').browserClass === 'read' && built('browser_perf').browserClass === 'read', 'viewport/perf مصنّفتان read');
  ok(built('browser_back').browserClass === 'navigate' && built('browser_forward').browserClass === 'navigate', 'back/forward مصنّفتان navigate');
  ok(['browser_fill_form', 'browser_transfer_field', 'browser_request_secret'].every((name) => built(name).browserClass === 'act'), 'أدوات الحقول الجديدة مصنّفة act');
  ok(built('browser_handoff_step').browserClass === 'handoff', 'browser_handoff_step مصنّفة handoff');

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

  // onActivity يُستدعى (خطّاف المراقبة الذي يستهلكه codex.js لعرض نشاط المتصفح)
  const acts = [];
  const srv2 = await codexmcp.start({ preview, requestPermission: allowAll, onActivity: (m, t) => acts.push([m, t]) });
  await post(srv2.url, srv2.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await post(srv2.url, srv2.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_page', arguments: {} } });
  ok(acts.some(([m]) => m === 'tools/list'), 'onActivity يُستدعى بطريقة الطلب');
  ok(acts.some(([m, t]) => m === 'tools/call' && t === 'read_page'), 'onActivity يمرّر اسم الأداة على tools/call (مسار مؤشّر النشاط)');

  // بوابة الإذن: كل أدوات المعاينة تمرّ بـ requestPermission، وغيابها يرفض fail-closed.
  const asked = [];
  const askedMeta = [];
  const gate = (decision) => async (tool, input, access, neverAlways, target, currentUrl, pageContext, rawInput) => {
    asked.push(tool); askedMeta.push({ tool, input, access, neverAlways, target, currentUrl, pageContext, rawInput }); return decision;
  };

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
  ok(/dom_changed=true/.test(jj.result.content[0].text), 'نتيجة الفعل تعيد دليل dom_changed للنموذج');
  ok(askedMeta.some((item) => item.tool === 'browser_type' && item.target === 'https://untrusted.example/page'), 'codexmcp يمرّر هدف الصفحة الحالية لبوابة الفعل');
  ok(askedMeta.some((item) => item.tool === 'browser_type' && item.currentUrl === 'https://untrusted.example/page'), 'codexmcp يمرّر origin الصفحة الحالية أيضاً');

  asked.length = 0; askedMeta.length = 0;
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser_fill_form', arguments: { fields: [
    { ref: 'e1', value: 'smtp-relay.brevo.com' }, { ref: 'e2', value: '587' },
  ] } } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && /2/.test(jj.result.content[0].text) && asked.includes('browser_fill_form'), 'browser_fill_form يعبّئ عدة حقول خلف بوابة act');
  const callsBeforeSecret = preview._fillCalls;
  const secretValue = 'sk-proj-abcdefghijklmnopqrstuvwxyz';
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'browser_fill_form', arguments: { fields: [{ ref: 'e3', value: secretValue }] } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && /browser_transfer_field/.test(jj.result.content[0].text) && preview._fillCalls === callsBeforeSecret, 'fill_form يرفض السر قبل التنفيذ ويوجّه للنقل الآمن');
  ok(!JSON.stringify(askedMeta).includes(secretValue), 'السر المرفوض لا يدخل نص مربع الإذن');

  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'browser_transfer_field', arguments: { from_ref: 'e4', to_ref: 'e5' } } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && /"moved":true/.test(jj.result.content[0].text) && !JSON.stringify(jj).includes(secretValue), 'transfer_field لا يعيد القيمة السرّية');
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'browser_request_secret', arguments: { field_ref: 'e6', reason: 'مفتاح SMTP' } } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && /"filled":true/.test(jj.result.content[0].text) && !JSON.stringify(jj).includes(secretValue), 'request_secret يعيد filled فقط بلا قيمة');

  // (ج) أدوات الخلفية القرائية حرّة، وأدوات التنفيذ تبقى خلف البوابة المصنّفة.
  asked.length = 0;
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_page', arguments: {} } });
  ok(asked.includes('read_page'), 'read_page تبقى ضمن بوابة المتصفح');
  asked.length = 0; askedMeta.length = 0;
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_background_tasks', arguments: {} } });
  jj = JSON.parse(rr.body);
  ok(!asked.includes('list_background_tasks') && !jj.result.isError, 'list_background_tasks حرّة كقراءة');
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_background_output', arguments: { id: 'term_999' } } });
  ok(!asked.includes('get_background_output'), 'get_background_output حرّة كقراءة');
  await srv3.stop();

  asked.length = 0; askedMeta.length = 0;
  srv3 = await codexmcp.start({ preview, cwd: process.cwd(), requestPermission: gate(false) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_in_background', arguments: { command: 'npm run dev' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && askedMeta.some((item) => item.tool === 'run_in_background' && item.access === 'exec'), 'run_in_background تطلب إذن exec');
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'stop_background_task', arguments: { id: 'term_1' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && askedMeta.some((item) => item.tool === 'stop_background_task' && item.access === 'exec' && item.neverAlways), 'stop_background_task تطلب exec ولا تقبل «دائماً»');
  await srv3.stop();

  const trustedOrigins = new Set(['https://trusted.example']);
  ok(codex.shouldAutoApproveMcp('browser', true, 'default', false, false, 'read_page', 'https://evil.example', trustedOrigins), 'browserControl يعفي القراءة على أي نطاق');
  ok(!codex.shouldAutoApproveMcp('browser', true, 'default', false, false, 'browser_click', 'https://evil.example', trustedOrigins), 'browserControl لا يعفي فعلاً على نطاق غير موثوق');
  ok(codex.shouldAutoApproveMcp('browser', true, 'default', false, false, 'browser_click', 'https://trusted.example/x', trustedOrigins), 'browserControl يعفي فعلاً على نطاق موثوق');
  ok(!codex.shouldAutoApproveMcp('browser', true, 'default', true, false, 'browser_click', 'https://trusted.example/x', trustedOrigins, 'https://trusted.example/x', { ref: 'delete-button' }, { elementText: 'Delete' }), 'الفعل الحسّاس يطلب الإذن رغم browserControl والثقة والموافقة الدائمة');
  ok(!codex.shouldAutoApproveMcp('browser', true, 'default', true, false, 'browser_evaluate', 'https://trusted.example/x', trustedOrigins, 'https://trusted.example/x', { expression: 'document.title' }, {}), 'browser_evaluate حساس دائماً حتى على أصل موثوق');
  ok(!codex.shouldAutoApproveMcp('browser', true, 'default', true, false, 'browser_fill_form', 'https://trusted.example/x', trustedOrigins, 'https://trusted.example/x', { fields: [{ ref: 'e1', value: '587' }] }, {}), 'fill_form يعرض الحقول في الإذن حتى مع browserControl والثقة');
  ok(!codex.shouldAutoApproveMcp('browser', true, 'default', true, false, 'browser_click', 'https://trusted.example/x', trustedOrigins, 'https://trusted.example/x', {}, {}, { impacting: true, allowed: false }), 'نفاد ميزانية الأفعال يطلب تمديداً صريحاً');
  ok(codex.shouldAutoApproveMcp('browser', true, 'bypassPermissions', false, false, 'browser_evaluate', 'https://evil.example', trustedOrigins, 'https://evil.example', { expression: 'danger()' }, {}), 'bypassPermissions وحده يتجاوز الفعل الحسّاس');
  ok(!codex.shouldAutoApproveMcp('browser', true, 'default', false, false, 'browser_click', 'https://trusted.example/x', trustedOrigins, 'https://evil.example/page'), 'وجهة موثوقة لا تعفي فعلاً صادرًا من صفحة غير موثوقة');
  ok(codex.shouldAutoApproveMcp('browser', true, 'default', false, false, 'browser_navigate', 'http://localhost:5173', trustedOrigins), 'localhost موثوق دائماً للتنقّل');
  ok(codex.shouldAutoApproveMcp('browser', true, 'bypassPermissions', false, false, 'browser_click', 'https://evil.example', trustedOrigins), 'bypassPermissions يتجاوز بوابة النطاق');
  ok(!codex.shouldAutoApproveMcp('exec', true, 'default', false, false, 'run_in_background', null, trustedOrigins), 'browserControl لا يعفي run_in_background');
  ok(!codex.shouldAutoApproveMcp('exec', true, 'default', false, true, 'stop_background_task', null, trustedOrigins), 'browserControl لا يعفي stop_background_task');
  ok(codex.shouldAutoApproveMcp('exec', false, 'default', true, false, 'run_in_background', null, trustedOrigins), 'الموافقة الدائمة الخاصة تعفي تشغيل الخلفية');
  ok(!codex.shouldAutoApproveMcp('exec', false, 'default', true, true, 'stop_background_task', null, trustedOrigins), 'stop لا تعفيه الموافقة الدائمة');

  const srv4 = await codexmcp.start({ preview });
  rr = await post(srv4.url, srv4.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_preview', arguments: { url: 'http://localhost:3000' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && /رُفض الإذن/.test(jj.result.content[0].text), 'غياب بوابة الإذن يرفض open_preview ولا يتصفح بصمت');
  rr = await post(srv4.url, srv4.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_in_background', arguments: { command: 'npm run dev' } } });
  ok(JSON.parse(rr.body).result.isError, 'غياب بوابة الإذن يرفض run_in_background fail-closed');
  rr = await post(srv4.url, srv4.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_background_tasks', arguments: {} } });
  ok(!JSON.parse(rr.body).result.isError, 'غياب البوابة لا يحجب list_background_tasks القرائية');
  for (const name of ['browser_fill_form', 'browser_transfer_field', 'browser_request_secret', 'browser_handoff_step']) {
    const args = name === 'browser_fill_form' ? { fields: [{ ref: 'e1', value: 'safe' }] }
      : name === 'browser_transfer_field' ? { from_ref: 'e1', to_ref: 'e2' }
      : name === 'browser_request_secret' ? { field_ref: 'e1', reason: 'قيمة سرية' }
      : { reason: 'أكمل الخطوة', resume_hint: 'خذ لقطة جديدة' };
    rr = await post(srv4.url, srv4.token, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name, arguments: args } });
    ok(JSON.parse(rr.body).result.isError, 'غياب بوابة الإذن يرفض ' + name + ' fail-closed');
  }
  await srv4.stop();

  // ---------- التسليم البشري browser_handoff (دفعة «تحكم الوكيل الكامل») ----------
  // tools/list يشمل الأداة الجديدة (على srv الأول)
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 20, method: 'tools/list' });
  ok(JSON.parse(r.body).result.tools.some((t) => t.name === 'browser_handoff'), 'tools/list يشمل browser_handoff');

  // غياب requestHandoff ⇒ رفض fail-closed (لا تعليق ولا تنفيذ)
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'browser_handoff', arguments: { reason: 'سجّل دخولك' } } });
  j = JSON.parse(r.body);
  ok(j.result.isError && /غير متاح/.test(j.result.content[0].text), 'غياب requestHandoff ⇒ browser_handoff ترفض fail-closed');

  // دورة كاملة: أثناء التسليم تُحجب الأدوات، ثم «استلمت» يعيد القيادة وينهي التعليق
  let handoffResolve = null;
  let handoffMeta = null;
  const srv5 = await codexmcp.start({
    preview,
    requestPermission: allowAll,
    requestHandoff: (reason, meta) => new Promise((res) => { handoffMeta = meta || null; handoffResolve = res; }),
  });
  const handoffP = post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'browser_handoff', arguments: { reason: 'سجّل دخولك إلى GitHub' } } });
  // انتظار تفعيل العلم (النداء يمرّ ببوابة الإذن ثم startHandoff)
  for (let i = 0; i < 50 && !preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
  ok(preview.isHandoffActive(), 'browser_handoff يفعّل علم التسليم في preview');
  rr = await post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/x' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && /التسليم البشري جارٍ/.test(jj.result.content[0].text), 'أثناء التسليم browser_navigate محجوبة برسالة موحّدة');
  rr = await post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'open_preview', arguments: { url: 'http://localhost:3000' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && /التسليم البشري جارٍ/.test(jj.result.content[0].text), 'أثناء التسليم open_preview محجوبة أيضاً');
  handoffResolve(true); // المستخدم ضغط «استلمت»
  rr = await handoffP; jj = JSON.parse(rr.body);
  ok(!jj.result.isError && /استلم المستخدم/.test(jj.result.content[0].text), '«استلمت» ⇒ نتيجة نجاح تطلب snapshot جديداً');
  ok(!preview.isHandoffActive(), 'بعد الاستلام يُرفع التعليق (endHandoff)');
  rr = await post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/y' } } });
  ok(!JSON.parse(rr.body).result.isError, 'بعد الاستلام تعود أدوات المعاينة للعمل');

  // مسار الإلغاء: المستخدم ضغط «إلغاء» ⇒ خطأ صريح + رفع التعليق
  const cancelP = post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'browser_handoff', arguments: { reason: 'أدخل رمز 2FA' } } });
  for (let i = 0; i < 50 && !preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
  handoffResolve(false);
  rr = await cancelP; jj = JSON.parse(rr.body);
  ok(jj.result.isError && /ألغى المستخدم/.test(jj.result.content[0].text), '«إلغاء» ⇒ خطأ صريح للنموذج بلا محتوى صفحة');
  ok(!preview.isHandoffActive(), 'الإلغاء يرفع التعليق أيضاً (fail-closed لا يعلق)');

  // reason فارغ ⇒ رفض قبل أي تعليق
  rr = await post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'browser_handoff', arguments: { reason: '   ' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && /reason مطلوب/.test(jj.result.content[0].text) && !preview.isHandoffActive(), 'reason فارغ ⇒ رفض بلا تفعيل تعليق');

  const stepP = post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'browser_handoff_step', arguments: {
    reason: 'أكمل تأكيد DNS', resume_hint: 'خذ لقطة ثم افحص حالة المرسل',
  } } });
  for (let i = 0; i < 50 && !preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
  handoffResolve(true);
  rr = await stepP; jj = JSON.parse(rr.body);
  ok(!jj.result.isError && handoffMeta && handoffMeta.mode === 'step' && /افحص حالة المرسل/.test(jj.result.content[0].text), 'handoff_step يمرّر mode ويعيد resume_hint بلا محتوى الصفحة');
  await srv5.stop();

  await srv.stop();
  await srv2.stop();
  console.log('\nنجح ' + passed + ' تحقّقاً.');
  process.exit(0);
})().catch((e) => { console.error('فشل:', e.message); process.exit(1); });
