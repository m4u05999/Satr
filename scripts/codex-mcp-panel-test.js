#!/usr/bin/env node
'use strict';

/**
 * اختبار قطعي للوحة موصّلات Codex (‏/موصلات — الدفعة C3). بلا شبكة وبلا codex حقيقي:
 * نستبدل الثنائي بـ node عبر CODEX_BIN ونشغّل fixture باسم `app-server` داخل cwd
 * (نمط codex-contract-test.js المثبّت).
 *
 * يغطي:
 *  - عقد mcpServerStatus/list وبدء الخيط العابر الذي **يلزم** لوصول إشعارات الإقلاع.
 *  - اشتقاق الحالة من mcpServer/startupStatus/updated (لا حقل status في العقد).
 *  - needs-auth من authStatus=notLoggedIn ومن failureReason=reauthenticationRequired.
 *  - استثناء خادم satr_preview الداخلي من العرض.
 *  - تنقية نص خطأ الخادم وحجب الأسرار، وعدم تسريب حقول داخلية.
 *  - إعادة تحميل الإعداد عبر config/mcpServer/reload بـ params = null.
 *  - **عدم تسريب رابط المصادقة**: البدء يعيد معرّفاً فقط، والرابط لا يخرج إلا عبر
 *    mcpOauthUrl المخصّصة للعملية الرئيسية، وبعد تحقق safeOauthUrl؛ والإلغاء يُسقطه.
 *  - عدم المساس بعقد اللوحة لمحرك sdk.
 */

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const AUTH_URL = 'https://auth.example.com/oauth/authorize?client_id=abc&state=xyz';

function fixtureSource() {
  return String.raw`'use strict';
const fs = require('fs');
const readline = require('readline');
const mode = process.env.SATR_CODEX_MCP_MODE || 'ok';
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32601, message } }); }
function log(value) { fs.appendFileSync(process.env.SATR_CODEX_MCP_LOG, JSON.stringify(value) + '\n', 'utf8'); }
function startupEvents() {
  const push = (name, status, extra) => send({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated',
    params: Object.assign({ name, status }, extra || {}) });
  push('alpha', 'starting');
  push('beta', 'starting');
  push('alpha', 'ready');
  push('beta', 'failed', { error: 'boot failed for beta: token=sk-ant-api03-AAAABBBBCCCCDDDDEEEE' });
  push('gamma', 'failed', { failureReason: 'reauthenticationRequired', error: 'needs reauth' });
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') { reply(message.id, { userAgent: 'fixture' }); return; }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    log({ type: 'thread_start', params: message.params });
    reply(message.id, { thread: { id: '019f9200-0000-7000-8000-00000000aaaa' } });
    startupEvents();
    return;
  }
  if (message.method === 'mcpServerStatus/list') {
    log({ type: 'list', params: message.params });
    reply(message.id, { data: [
      { name: 'alpha', authStatus: 'unsupported', tools: null, resources: [1, 2],
        resourceTemplates: [], serverInfo: { name: 'alpha', version: '1.2.3', websiteUrl: 'https://alpha.example' } },
      { name: 'beta', authStatus: 'unsupported', tools: null, resources: [], resourceTemplates: [] },
      { name: 'gamma', authStatus: 'oAuth', tools: null, resources: [], resourceTemplates: [] },
      { name: 'delta', authStatus: 'notLoggedIn', tools: null, resources: [], resourceTemplates: [] },
      { name: 'satr_preview', authStatus: 'unsupported', tools: null, resources: [], resourceTemplates: [] },
    ] });
    return;
  }
  if (message.method === 'config/mcpServer/reload') {
    log({ type: 'reload', params: message.params === undefined ? 'undefined' : message.params });
    if (mode === 'reload_fail') { fail(message.id, 'reload exploded: secret=sk-ant-api03-ZZZZYYYYXXXX'); return; }
    reply(message.id, {});
    return;
  }
  if (message.method === 'mcpServer/oauth/login') {
    log({ type: 'oauth_login', params: message.params });
    if (mode === 'oauth_nourl') { reply(message.id, {}); return; }
    if (mode === 'oauth_badurl') { reply(message.id, { authorizationUrl: 'http://evil.example.com/cb' }); return; }
    reply(message.id, { authorizationUrl: process.env.SATR_CODEX_MCP_AUTH_URL });
    if (mode === 'oauth_ok') {
      setTimeout(() => send({ jsonrpc: '2.0', method: 'mcpServer/oauthLogin/completed',
        params: { name: message.params.name, success: true } }), 150);
    }
    if (mode === 'oauth_denied') {
      setTimeout(() => send({ jsonrpc: '2.0', method: 'mcpServer/oauthLogin/completed',
        params: { name: message.params.name, success: false, error: 'user denied' } }), 150);
    }
    return;
  }
});
`;
}

const readLog = async (file) => {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
  return raw.trim() ? raw.trim().split(/\r?\n/).map(JSON.parse) : [];
};

// ---------- (1) تحقق الرابط النقي ----------
function testSafeUrl(codex) {
  const s = codex.safeOauthUrl;
  assert.strictEqual(s(AUTH_URL), AUTH_URL, 'رابط https صالح');
  assert.strictEqual(s('http://localhost:1455/cb'), 'http://localhost:1455/cb', 'loopback http مسموح');
  assert.strictEqual(s('http://127.0.0.1:9/cb'), 'http://127.0.0.1:9/cb', 'loopback ip مسموح');
  assert.strictEqual(s('http://evil.example.com/cb'), '', 'http خارجي مرفوض');
  assert.strictEqual(s('https://user:pass@a.example/'), '', 'رابط بمصادقة مضمّنة مرفوض');
  assert.strictEqual(s('javascript:alert(1)'), '', 'مخطط تنفيذي مرفوض');
  assert.strictEqual(s('file:///c:/x'), '', 'file مرفوض');
  assert.strictEqual(s('https://a.example/a b'), '', 'فراغ مرفوض');
  assert.strictEqual(s('https://a.example/' + 'x'.repeat(3000)), '', 'تجاوز السقف مرفوض');
  assert.strictEqual(s('https://a.example/\u202eevil'), '', 'محرف Bidi مرفوض');
  assert.strictEqual(s(''), '', 'فارغ');
  assert.strictEqual(s(null), '', 'null');
  assert.strictEqual(s(42), '', 'رقم');
  // ثبات: الاستدعاء المتكرر لا يتأثر بحالة lastIndex في regex عامّة
  assert.strictEqual(s(AUTH_URL), AUTH_URL, 'استدعاء ثانٍ ثابت');
  assert.strictEqual(s(AUTH_URL), AUTH_URL, 'استدعاء ثالث ثابت');
}

// ---------- (2) تنقية نص الخطأ ----------
function testErrorSanitize(codex) {
  const e = codex.sanitizeMcpError;
  assert.strictEqual(e(''), '', 'فارغ');
  assert.strictEqual(e(null), '', 'null');
  assert.strictEqual(e('  boot   failed \n now '), 'boot failed now', 'طيّ الفراغ');
  const secret = e('token=sk-ant-api03-AAAABBBBCCCCDDDDEEEE');
  assert(/حُجب/.test(secret), 'لم يُحجب نص يحمل سرّاً: ' + secret);
  assert(!secret.includes('sk-ant'), 'تسرّب السر بعد الحجب');
  const long = e('x'.repeat(900));
  assert(long.length <= 301, 'تجاوز سقف الطول: ' + long.length);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satr-codex-mcp-'));
  const project = path.join(root, 'project');
  const logFile = path.join(root, 'mcp.jsonl');
  try {
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'app-server'), fixtureSource(), 'utf8');
    process.env.CODEX_BIN = process.execPath;
    process.env.SATR_CODEX_MCP_LOG = logFile;
    process.env.SATR_CODEX_MCP_AUTH_URL = AUTH_URL;
    delete require.cache[require.resolve('../electron/codex')];
    const codex = require('../electron/codex');
    codex.resolveCodexBin(true);

    testSafeUrl(codex);
    testErrorSanitize(codex);

    // ---------- (3) mcpStatus: العقد والاشتقاق ----------
    process.env.SATR_CODEX_MCP_MODE = 'ok';
    const status = await codex.mcpStatus(project);
    assert.strictEqual(status.ok, true, 'فشل mcpStatus: ' + JSON.stringify(status));
    const names = status.servers.map((s) => s.name);
    assert(!names.includes('satr_preview'), 'ظهر خادم المعاينة الداخلي في اللوحة');
    assert.deepStrictEqual(names, ['alpha', 'beta', 'gamma', 'delta'], 'قائمة الخوادم: ' + names.join(','));

    const by = Object.fromEntries(status.servers.map((s) => [s.name, s]));
    assert.strictEqual(by.alpha.status, 'connected', 'ready ⇒ connected');
    assert.strictEqual(by.beta.status, 'failed', 'failed ⇒ failed');
    assert.strictEqual(by.gamma.status, 'needs-auth', 'reauthenticationRequired ⇒ needs-auth');
    assert.strictEqual(by.delta.status, 'needs-auth', 'authStatus notLoggedIn ⇒ needs-auth');
    assert.strictEqual(by.delta.canLogin, true, 'notLoggedIn يتيح تسجيل الدخول');
    assert.strictEqual(by.gamma.canLogin, true, 'oAuth يتيح تسجيل الدخول');
    assert.strictEqual(by.alpha.canLogin, false, 'unsupported لا يتيح تسجيل الدخول');
    assert.strictEqual(by.alpha.resources, 2, 'عدد الموارد');
    assert.strictEqual(by.alpha.tools, null, 'tools يعود null من upstream — لا ندّعي عدداً');
    assert.deepStrictEqual(by.alpha.serverInfo, { version: '1.2.3' }, 'serverInfo مقصور على الإصدار');
    // خطأ beta يحمل سرّاً ⇒ محجوب
    assert(/حُجب/.test(by.beta.error), 'لم يُحجب خطأ يحمل سرّاً: ' + by.beta.error);
    const payload = JSON.stringify(status);
    assert(!payload.includes('sk-ant'), 'تسرّب سرّ في حمولة اللوحة');
    assert(!payload.includes('websiteUrl'), 'تسرّب حقل serverInfo غير معلن');
    assert(!/https?:\/\//.test(payload), 'تسرّب رابط في حمولة اللوحة');
    for (const s of status.servers) {
      assert.deepStrictEqual(Object.keys(s).sort(),
        ['authStatus', 'canLogin', 'error', 'name', 'resources', 'serverInfo', 'status', 'tools'],
        'حقول غير معلنة في صف الخادم: ' + Object.keys(s).join(','));
    }

    // الخيط العابر لازم لوصول إشعارات الإقلاع (حدّ upstream مثبّت بالمسبار)
    const log1 = await readLog(logFile);
    assert.strictEqual(log1.filter((r) => r.type === 'thread_start').length, 1,
      'لم يُبدأ خيط عابر قبل قراءة الحالة');
    assert.strictEqual(log1.filter((r) => r.type === 'list').length, 1, 'عدد نداءات list');
    assert.strictEqual(log1.find((r) => r.type === 'thread_start').params.sandbox, 'read-only',
      'الخيط العابر ليس للقراءة فقط');

    // ---------- (4) إعادة تحميل الإعداد ----------
    await fs.writeFile(logFile, '', 'utf8');
    const reload = await codex.mcpReload(project);
    assert.deepStrictEqual(reload, { ok: true }, 'فشل reload: ' + JSON.stringify(reload));
    const reloadLog = (await readLog(logFile)).find((r) => r.type === 'reload');
    assert(reloadLog, 'لم يُستدعَ config/mcpServer/reload');
    assert.strictEqual(reloadLog.params, null, 'params ليست null كما يوجب الـschema');

    process.env.SATR_CODEX_MCP_MODE = 'reload_fail';
    const reloadBad = await codex.mcpReload(project);
    assert.strictEqual(reloadBad.ok, false, 'نجح reload رغم خطأ upstream');
    assert(!JSON.stringify(reloadBad).includes('sk-ant'), 'تسرّب سرّ من خطأ reload');
    assert(!/exploded/.test(JSON.stringify(reloadBad)), 'تسرّبت رسالة upstream الخام');

    // ---------- (5) OAuth: الرابط لا يعبر إلا لـmain.js وبعد تحقق ----------
    process.env.SATR_CODEX_MCP_MODE = 'oauth_ok';
    const started = await codex.mcpOauthStart(project, 'delta');
    assert.strictEqual(started.ok, true, 'فشل بدء OAuth: ' + JSON.stringify(started));
    assert(/^cxoauth_[0-9]+_[a-z0-9]+$/.test(started.id), 'صيغة معرّف الطلب: ' + started.id);
    assert.strictEqual(started.name, 'delta', 'اسم الخادم');
    assert(!('url' in started) && !('authorizationUrl' in started), 'تسرّب الرابط من نتيجة البدء');
    assert(!JSON.stringify(started).includes('auth.example.com'), 'تسرّب الرابط نصّاً في نتيجة البدء');
    assert.strictEqual(codex.mcpOauthUrl(started.id), AUTH_URL, 'main.js لا يقرأ الرابط');
    const done = await codex.mcpOauthAwait(started.id, 5000);
    assert.deepStrictEqual(done, { ok: true, success: true, error: '' }, 'نتيجة الاكتمال: ' + JSON.stringify(done));
    assert.strictEqual(codex.mcpOauthUrl(started.id), null, 'بقي الرابط بعد الحسم');

    // رفض المستخدم
    process.env.SATR_CODEX_MCP_MODE = 'oauth_denied';
    const denied = await codex.mcpOauthStart(project, 'delta');
    assert.strictEqual(denied.ok, true, 'فشل بدء OAuth (denied)');
    const deniedDone = await codex.mcpOauthAwait(denied.id, 5000);
    assert.strictEqual(deniedDone.ok, true, 'لم يصل إشعار الرفض');
    assert.strictEqual(deniedDone.success, false, 'اعتُبر الرفض نجاحاً');

    // الإلغاء يُسقط الطلب فوراً — لا رابط بعده
    process.env.SATR_CODEX_MCP_MODE = 'oauth_ok';
    const toCancel = await codex.mcpOauthStart(project, 'delta');
    assert.strictEqual(typeof codex.mcpOauthUrl(toCancel.id), 'string', 'لا رابط قبل الإلغاء');
    codex.mcpOauthCancel(toCancel.id);
    assert.strictEqual(codex.mcpOauthUrl(toCancel.id), null, 'بقي الرابط بعد الإلغاء');
    const afterCancel = await codex.mcpOauthAwait(toCancel.id, 1000);
    assert.strictEqual(afterCancel.ok, false, 'انتظار طلب ملغى نجح');

    // رابط غير آمن من upstream ⇒ لا يُعاد إطلاقاً
    process.env.SATR_CODEX_MCP_MODE = 'oauth_badurl';
    const bad = await codex.mcpOauthStart(project, 'delta');
    assert.strictEqual(bad.ok, true, 'بدء OAuth برابط غير آمن');
    assert.strictEqual(codex.mcpOauthUrl(bad.id), null, 'أُعيد رابط http خارجي غير آمن');
    codex.mcpOauthCancel(bad.id);

    // خادم بلا رابط ⇒ فشل صريح بلا تسريب
    process.env.SATR_CODEX_MCP_MODE = 'oauth_nourl';
    const noUrl = await codex.mcpOauthStart(project, 'delta');
    assert.strictEqual(noUrl.ok, false, 'نجح البدء بلا رابط');
    assert(!('id' in noUrl), 'أُعيد معرّف طلب بلا رابط');

    // ---------- (6) عدم المساس بعقد لوحة sdk ----------
    // فحص مصدري (لا تحميل لـagent.js كي لا يُقحَم Claude SDK في اختبار قطعي):
    // مسار sdk في main.js يبقى agent.mcpStatus/agent.mcpAction بلا وسيط محرك، ودالتاهما
    // ما زالتا مصدَّرتين بالتوقيع نفسه.
    const agentSrc = await fs.readFile(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
    assert(/async function mcpStatus\(cwd\)/.test(agentSrc), 'تغيّر توقيع agent.mcpStatus');
    assert(/async function mcpAction\(cwd, name, action\)/.test(agentSrc), 'تغيّر توقيع agent.mcpAction');
    const mainSrc = await fs.readFile(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert(/return agent\.mcpStatus\(dir\);/.test(mainSrc), 'تغيّر مسار sdk في satr:mcpStatus');
    assert(/return agent\.mcpAction\(dir, p\.name, p\.action\);/.test(mainSrc), 'تغيّر مسار sdk في satr:mcpAction');
    // بوابة codex لا تُفعَّل إلا بالمحرك الصريح
    assert(/p\.engine === 'codex'\) return codex\.mcpStatus\(dir\)/.test(mainSrc), 'بوابة محرك codex مفقودة');
    // الرابط لا يُعاد من قناة البدء إطلاقاً
    assert(/return \{ ok: true, id: started\.id, name: started\.name \};/.test(mainSrc),
      'قناة بدء OAuth لا تقتصر على المعرّف والاسم');

    console.log('codex-mcp-panel: نجح — عقد الحالة والاشتقاق، استثناء satr_preview،'
      + ' reload بـparams null، وحجب رابط المصادقة والأسرار قبل التأكيد.');
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.SATR_CODEX_MCP_LOG;
    delete process.env.SATR_CODEX_MCP_MODE;
    delete process.env.SATR_CODEX_MCP_AUTH_URL;
    // جلسات app-server العابرة تُغلق بـstdin.end ثم kill بعد 200ms؛ نمهلها كي لا يقع
    // EBUSY على مجلد الـfixture في ويندوز (رصد فعلي في أول تشغيل).
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      .catch(() => { /* التنظيف أفضل جهد — لا يقلب نتيجة الاختبار */ });
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
