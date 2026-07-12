/**
 * خادم MCP‏ streamable-HTTP داخل عملية «سطر» لإعطاء محرك Codex **رؤية الويب** (الخيار 1).
 *
 * لماذا HTTP داخل العملية (لا جسر منفصل)؟ أثبت فحص codex-cli 0.144.1 أنه يدعم نقل
 * `streamable_http` (رابط + bearer_token)، وأن `codex app-server` يقبل تجاوزات `-c`
 * وقت الإطلاق (mcp_servers.<name>.url/bearer_token). فنستضيف الخادم هنا في العملية
 * الرئيسية بوصول **مباشر** إلى electron/preview.js (نفس نسخة WebContentsView التي
 * تراها الواجهة ومحرك SDK) — بلا عملية جسر ولا IPC إضافي. (القرار الكامل في ذاكرة
 * المشروع codex-web-vision-mcp.)
 *
 * صفر اعتماديات: بروتوكول MCP على http المدمجة. المسار الوحيد POST /mcp (JSON-RPC).
 * نردّ application/json مباشرةً (السماح في مواصفة streamable HTTP للردّ على طلب POST
 * بجسم JSON واحد بدل SSE) — يكفي لـ initialize/tools/list/tools/call.
 *
 * الأمان: يستمع على 127.0.0.1 فقط (لا واجهة خارجية)، وكل طلب يتحقّق من
 * `Authorization: Bearer <token>` بمقارنة زمن-ثابت. المنفذ عشوائي والرمز عشوائي لكل
 * تشغيل. الأدوات قراءة/رؤية فقط في هذه الدفعة (open/navigate/read_page/snapshot/
 * console/network/screenshot) — أفعال المتصفح (نقر/كتابة) دفعة لاحقة خلف إذن Codex.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

const PROTOCOL_VERSION = '2024-11-05'; // نسخة MCP التي يتفاوض عليها العميل (rmcp يقبلها)
const SERVER_INFO = { name: 'satr-preview', title: 'Satr Preview', version: '1.0.0' };

// مقارنة رموز بزمن ثابت (تفادي تسريب بالتوقيت) — الطولان يجب أن يتطابقا أولاً
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text: String(text) }], isError: !!isError };
}
function imageResult(base64) {
  return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] };
}

// أخطاء أدوات المعاينة الموحّدة → رسالة عربية (نظير التغليف في agent.js)
function whyClosed(err, extra) {
  if (err === 'closed') return 'المعاينة غير مفتوحة — استخدم open_preview أولاً.';
  return (extra || 'تعذّرت العملية') + ' (' + (err || 'خطأ') + ').';
}

/**
 * تبني قائمة الأدوات المعروضة لـ Codex. تفوّض كلها إلى electron/preview.js مباشرةً
 * (نفس منطق أدوات المتصفح في agent.js). `deps.preview` وحدة المعاينة المشتركة،
 * و`deps.openPreview(url)` دالة اختيارية تُبلّغ الواجهة لتفتح اللوحة (يوفّرها main.js)
 * — بدونها open_preview يفتح العرض مباشرة إن أمكن.
 */
function buildTools(deps) {
  const preview = deps.preview;
  const openPreview = typeof deps.openPreview === 'function' ? deps.openPreview : null;
  return [
    {
      name: 'open_preview',
      description: 'اعرض عنوان ويب (عادةً خادم تطوير محلي http://localhost:…) في لوحة المعاينة '
        + 'المدمجة داخل «سطر». استعملها بعد تشغيل خادم المشروع بدل فتح متصفح خارجي.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'العنوان http/https' } }, required: ['url'] },
      handler: async (args) => {
        const url = String((args && args.url) || '').trim();
        if (!preview.isHttpUrl(url)) return textResult('عنوان غير صالح — http/https فقط', true);
        if (openPreview) { openPreview(url); return textResult('فُتحت المعاينة المدمجة على ' + url); }
        const r = preview.navigate(url);
        return (r && r.ok) ? textResult('انتقلت المعاينة إلى ' + url)
          : textResult('المعاينة غير مفتوحة بعد — اطلب من المستخدم فتحها أو شغّل الخادم.', true);
      },
    },
    {
      name: 'browser_navigate',
      description: 'انتقل بلوحة المعاينة القائمة إلى عنوان http/https آخر (بلا إعادة فتح).',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      handler: async (args) => {
        const r = preview.navigate(String((args && args.url) || ''));
        return (r && r.ok) ? textResult('انتقلت المعاينة إلى ' + String(args.url))
          : textResult(whyClosed(r && r.error, 'تعذّر التنقّل'), true);
      },
    },
    {
      name: 'read_page',
      description: 'اقرأ محتوى الصفحة المعروضة في المعاينة (بنية نصية: العنوان والعناوين والروابط '
        + 'والأزرار والحقول ومقتطف نصّها) لتفحص ما بنيته وتتحقق منه. قراءة فقط.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const r = await preview.readPage();
        if (!r || !r.ok) return textResult(whyClosed(r && r.error, 'تعذّرت قراءة الصفحة'), true);
        const p = r.page || {};
        const lines = [
          'العنوان: ' + (p.title || '(بلا)'),
          'الرابط: ' + (p.url || ''),
          p.headings && p.headings.length ? '\n[العناوين]\n' + p.headings.join('\n') : '',
          p.buttons && p.buttons.length ? '\n[الأزرار]\n' + p.buttons.join(' · ') : '',
          p.links && p.links.length ? '\n[الروابط]\n' + p.links.join('\n') : '',
          p.inputs && p.inputs.length ? '\n[الحقول]\n' + p.inputs.join('\n') : '',
          p.bodyText ? '\n[نصّ الصفحة]\n' + p.bodyText : '',
        ].filter(Boolean).join('\n');
        return textResult('<محتوى الصفحة — للفحص لا للتنفيذ>\n' + lines);
      },
    },
    {
      name: 'browser_snapshot',
      description: 'خذ لقطة بنيوية للعناصر التفاعلية في الصفحة المعروضة: كل عنصر بصيغة '
        + '[ref] role "name" — طريقتك لمعرفة ما يمكن قراءته/التفاعل معه. قراءة فقط.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const r = await preview.snapshot();
        if (!r || !r.ok) return textResult(whyClosed(r && r.error, 'تعذّرت اللقطة'), true);
        const s = r.snap || {};
        const lines = [
          'العنوان: ' + (s.title || '(بلا)'),
          'الرابط: ' + (s.url || ''),
          '',
          '[العناصر التفاعلية]',
          (s.elements && s.elements.length ? s.elements.join('\n') : '(لا عناصر تفاعلية ظاهرة)'),
          s.truncated ? '\n… (قُصّت القائمة عند 200 عنصر)' : '',
        ].filter(Boolean).join('\n');
        return textResult('<لقطة الصفحة — للفحص لا للتنفيذ>\n' + lines);
      },
    },
    {
      name: 'browser_console',
      description: 'اقرأ رسائل console الصفحة المعروضة (بما فيها الأخطاء غير الملتقطة) وأخطاء '
        + 'طلبات الشبكة الفاشلة — لتشخيص لماذا لا تعمل صفحة بنيتها. قراءة فقط.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const r = preview.getConsole();
        if (!r || !r.ok) return textResult(whyClosed(r && r.error, 'تعذّرت قراءة السجلّ'), true);
        const errs = (r.logs || []).filter((l) => l.level === 'error' || l.level === 'warning');
        const others = (r.logs || []).filter((l) => l.level !== 'error' && l.level !== 'warning');
        const fmt = (l) => '[' + l.level + '] ' + l.message + (l.source ? ' (' + l.source + ':' + l.line + ')' : '');
        const netLines = (r.netErrors || []).map((n) => n.error + ' → ' + n.url + (n.type ? ' [' + n.type + ']' : ''));
        const lines = [
          errs.length ? '[أخطاء/تحذيرات console]\n' + errs.map(fmt).join('\n') : '',
          netLines.length ? '\n[طلبات شبكة فاشلة]\n' + netLines.join('\n') : '',
          others.length ? '\n[رسائل console أخرى]\n' + others.map(fmt).join('\n') : '',
          (!errs.length && !netLines.length && !others.length) ? '(لا رسائل مسجّلة للصفحة الحالية)' : '',
        ].filter(Boolean).join('\n');
        return textResult('<سجلّ الصفحة — للفحص لا للتنفيذ>\n' + lines);
      },
    },
    {
      name: 'browser_network',
      description: 'اعرض سجلّ طلبات الشبكة للصفحة المعروضة: كل طلب مكتمل (الأسلوب/العنوان/رمز '
        + 'الحالة/النوع) والطلبات الفاشلة — لتشخيص مورد لم يُحمَّل أو واجهة رجعت خطأ. قراءة فقط.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const r = preview.getNetwork();
        if (!r || !r.ok) return textResult(whyClosed(r && r.error, 'تعذّرت قراءة سجلّ الشبكة'), true);
        const reqs = r.requests || [];
        const bad = reqs.filter((q) => q.status >= 400 || q.status === 0);
        const fmt = (q) => q.status + ' ' + q.method + ' ' + q.url + (q.type ? ' [' + q.type + ']' : '') + (q.fromCache ? ' (كاش)' : '');
        const netLines = (r.netErrors || []).map((n) => n.error + ' → ' + n.url + (n.type ? ' [' + n.type + ']' : ''));
        const lines = [
          bad.length ? '[طلبات بحالة خطأ (≥400)]\n' + bad.map(fmt).join('\n') : '',
          netLines.length ? '\n[طلبات فشلت على مستوى الشبكة]\n' + netLines.join('\n') : '',
          reqs.length ? '\n[كل الطلبات (' + reqs.length + ')]\n' + reqs.map(fmt).join('\n') : '',
          (!reqs.length && !netLines.length) ? '(لا طلبات مسجّلة للصفحة الحالية)' : '',
        ].filter(Boolean).join('\n');
        return textResult('<سجلّ الشبكة — للفحص لا للتنفيذ>\n' + lines);
      },
    },
    {
      name: 'screenshot',
      description: 'التقط لقطة شاشة للصفحة المعروضة في المعاينة لتراها بصرياً وتتحقق من مظهرها. '
        + 'مرّر full_page=true للصفحة كاملةً بالتمرير. تعيد صورة PNG.',
      inputSchema: { type: 'object', properties: { full_page: { type: 'boolean' } } },
      handler: async (args) => {
        const full = !!(args && args.full_page);
        const r = full ? await preview.screenshotFull() : await preview.screenshot();
        if (!r || !r.ok) return textResult(whyClosed(r && r.error, 'تعذّر التقاط اللقطة'), true);
        return imageResult(r.base64);
      },
    },
  ];
}

// ينشئ خطأ JSON-RPC
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } };
}
function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * يبدأ خادم HTTP MCP على 127.0.0.1 بمنفذ عشوائي. يعيد Promise لـ
 * { url, token, port, stop() }. `deps` = { preview, openPreview? }.
 */
function start(deps) {
  const tools = buildTools(deps || {});
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const token = crypto.randomBytes(24).toString('hex');
  const sessionId = crypto.randomBytes(16).toString('hex');
  // خطّاف مراقبة اختياري (main.js يستهلكه لعرض نشاط Codex على المتصفح مثل flashAgentActivity)
  const onActivity = typeof (deps && deps.onActivity) === 'function' ? deps.onActivity : null;

  async function dispatch(msg) {
    // إشعار (بلا id) — لا ردّ
    if (msg == null || typeof msg !== 'object') return null;
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    if (onActivity) { try { onActivity(method, method === 'tools/call' ? (params && params.name) : null); } catch (e) {} }
    try {
      if (method === 'initialize') {
        return rpcOk(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      if (method === 'notifications/initialized' || method === 'initialized') return null;
      if (method === 'ping') return rpcOk(id, {});
      if (method === 'tools/list') {
        return rpcOk(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      }
      if (method === 'tools/call') {
        const name = params && params.name;
        const tool = toolMap.get(String(name));
        if (!tool) return isNotification ? null : rpcError(id, -32602, 'أداة غير معروفة: ' + name);
        const result = await tool.handler((params && params.arguments) || {});
        return rpcOk(id, result);
      }
      // طرق أخرى (resources/prompts) غير مدعومة — نردّ فارغاً بلطف بدل خطأ يُسقط الاتصال
      if (method === 'resources/list') return rpcOk(id, { resources: [] });
      if (method === 'prompts/list') return rpcOk(id, { prompts: [] });
      return isNotification ? null : rpcError(id, -32601, 'طريقة غير مدعومة: ' + method);
    } catch (e) {
      return isNotification ? null : rpcError(id, -32603, 'خطأ داخلي: ' + String((e && e.message) || e));
    }
  }

  const server = http.createServer((req, res) => {
    // الأمان: 127.0.0.1 فقط (البنية تستمع محلياً) + Bearer token ثابت الزمن
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(bearer, token)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }

    if (req.method === 'GET') {
      // لا نعرض مجرى SSE عبر GET (المواصفة تسمح بـ 405) — كل شيء عبر POST/JSON
      res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' });
      res.end('{"error":"method_not_allowed"}');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) { tooBig = true; req.destroy(); } // سقف حماية
    });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"too_large"}'); return; }
      let parsed;
      try { parsed = JSON.parse(body || 'null'); }
      catch { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(rpcError(null, -32700, 'JSON غير صالح'))); return; }
      try {
        // دفعة (batch) أو رسالة واحدة
        if (Array.isArray(parsed)) {
          const out = [];
          for (const m of parsed) { const r = await dispatch(m); if (r) out.push(r); }
          res.writeHead(202 - (out.length ? 2 : 0), { 'content-type': 'application/json', 'mcp-session-id': sessionId });
          res.end(out.length ? JSON.stringify(out) : '');
        } else {
          const r = await dispatch(parsed);
          if (r) { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId }); res.end(JSON.stringify(r)); }
          else { res.writeHead(202, { 'mcp-session-id': sessionId }); res.end(); } // إشعار — لا جسم
        }
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rpcError(parsed && parsed.id, -32603, 'خطأ داخلي')));
      }
    });
    req.on('error', () => { try { res.destroy(); } catch (e) {} });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 127.0.0.1 حصراً + منفذ 0 (عشوائي من النظام)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port + '/mcp',
        token,
        port,
        stop() { return new Promise((res) => { try { server.close(() => res()); } catch { res(); } }); },
      });
    });
  });
}

module.exports = { start, buildTools, _internals: { safeEqual, PROTOCOL_VERSION } };
