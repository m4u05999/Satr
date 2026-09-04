'use strict';

// اختبار خادم MCP‏ streamable-HTTP لرؤية الويب في Codex (electron/codexmcp.js — الخيار 1).
// يتحقّق من عقد JSON-RPC عبر HTTP بـ preview مزيّف (بلا Electron/WebContentsView): المصادقة
// بـ Bearer، وinitialize/notifications/tools-list/tools-call (نص+صورة)، وأخطاء JSON-RPC.
// الاتصال الحيّ بـ codex الحقيقي أُثبت يدوياً (initialize→tools/list→satr_preview=ready)؛
// هذا الاختبار يحرس عقد البروتوكول حتمياً بلا شبكة خارجية.

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codexmcp = require('../electron/codexmcp');
const codex = require('../electron/codex');
const tools = require('../electron/tools');
const envbrief = require('../electron/envbrief');
const hookguard = require('../electron/hookguard');
const browserAudit = require('./browser-session-audit');

// preview مزيّف يحاكي عقد electron/preview.js دون WebContentsView
const preview = {
  _fillCalls: 0,
  _clickCalls: 0,
  _leaseError: null,
  _screenshotMetrics: null,
  _screenshotOptions: null,
  _screenshotFullOptions: null,
  _screenshotElementOptions: null,
  isHttpUrl: (u) => /^https?:\/\//.test(String(u)),
  navigate: () => ({ ok: true }),
  currentUrl: () => 'https://untrusted.example/page',
  navigationTarget: (direction) => direction === 'back' ? 'https://previous.example/' : 'https://next.example/',
  readPage: async () => ({ ok: true, page: { title: 'صفحة', url: 'http://localhost:3000/', headings: ['h1: مرحبا'], links: [], buttons: ['إرسال'], inputs: [], bodyText: 'محتوى' } }),
  snapshot: async () => ({ ok: true, snap: { title: 'ص', url: 'http://x', elements: ['[s3:e1] button "إرسال"'], count: 1, truncated: false } }),
  getConsole: () => ({ ok: true, logs: [{ level: 'error', message: 'oops', line: 4, source: 'app.js' }], netErrors: [] }),
  getNetwork: () => ({ ok: true, requests: [{ method: 'GET', url: 'http://x/api', status: 404, type: 'xhr', fromCache: false }], netErrors: [] }),
  screenshot: async (options) => {
    preview._screenshotOptions = options;
    return { ok: true, base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), ...(preview._screenshotMetrics || {}) };
  },
  screenshotFull: async (options) => {
    preview._screenshotFullOptions = options;
    return { ok: true, base64: 'AA==' };
  },
  screenshotElement: async (_locator, options) => {
    preview._screenshotElementOptions = options;
    return { ok: true, base64: 'BB==' };
  },
  waitFor: async () => ({ ok: true, found: true }),
  scroll: async () => ({ ok: true, scrollY: 120, moved: 120, max: 2000 }),
  hover: async () => ({ ok: true, tag: 'a' }),
  clickElement: async () => { preview._clickCalls += 1; return { ok: true, tag: 'button', text: 'إرسال', dispatched: true, effect_observed: true, navigated: false, dom_changed: true }; },
  typeText: async () => ({ ok: true, tag: 'input', dispatched: true, effect_observed: true, satisfied: true, navigated: false, dom_changed: true,
    delta: ['+ [s3:e2] button "التالي"'], delta_truncated: true }),
  selectOption: async () => ({ ok: true, label: 'الأول', dispatched: true, effect_observed: true, satisfied: true, navigated: false, dom_changed: true }),
  pressKey: async () => ({ ok: true, key: 'Enter', dispatched: true, effect_observed: false, navigated: false, dom_changed: false, note: 'لم يتغيّر شيء' }),
  browserActionContext: async (tool, input) => ({
    currentUrl: 'https://untrusted.example/page', targetUrl: 'https://untrusted.example/page',
    elementText: input && input.ref === 'delete-button' ? 'Delete' : '', tag: 'button',
  }),
  browserInputError: (_tool, input) => JSON.stringify(input || {}).includes('s1:e') ? 'stale_ref' : null,
  leaseError: () => preview._leaseError,
  fillForm: async (fields) => { preview._fillCalls += 1; return { ok: true, filled: Array.isArray(fields) ? fields.length : 0 }; },
  transferField: async (from, to) => from && !to
    ? { ok: true, stored: true, transfer_id: 'xfer_0123456789abcdef0123456789abcdef', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }
    : { ok: true, moved: true, value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' },
  requestSecret: async () => ({ ok: true, filled: true, value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }),
  evaluate: async () => ({ ok: true, value: '{"ready":true}', truncated: false }),
  setViewport: async (width, height) => ({ ok: true, requested: { width, height }, actual: { width, height: height || 600 } }),
  perf: async () => ({ ok: true, perf: { navigation: { load: 120 } }, failed_requests: [] }),
  back: async () => ({ ok: true, dispatched: true, effect_observed: true, navigated: true, dom_changed: false, url: 'https://previous.example/' }),
  forward: async () => ({ ok: true, dispatched: true, effect_observed: true, navigated: true, dom_changed: false, url: 'https://next.example/' }),
  // حالة التسليم البشري (browser_handoff) — يحاكي عقد preview.js: علم واحد + idempotent
  _handoff: false,
  startHandoff() { if (this._handoff) return { ok: false, error: 'active' }; this._handoff = true; return { ok: true }; },
  endHandoff() { const was = this._handoff; this._handoff = false; return { ok: true, wasActive: was }; },
  isHandoffActive() { return this._handoff; },
};

const promoCapture = {
  starts: 0,
  stops: 0,
  start: async () => { promoCapture.starts += 1; return { ok: true, session_id: 'promo_0123456789abcdef01234567' }; },
  stop: async () => { promoCapture.stops += 1; return { ok: true, path: 'C:\\Downloads\\segment.mp4', duration_ms: 900 }; },
  listSegments: () => ({ ok: true, session_id: null, segments: [] }),
};
const promoStudio = {
  proposals: 0,
  propose: () => { promoStudio.proposals += 1; return { ok: true, storyboard: { scenes: [{ id: 'scene_1' }] } }; },
};
const genmedia = {
  estimates: 0,
  generations: 0,
  listCatalog: () => [],
  estimate: async (request) => {
    genmedia.estimates += 1;
    return { ok: true, provider: 'fal', model: request.model || (request.kind === 'audio' ? 'fal-audio-test' : 'fal-image-test'), count: request.count || 1,
      cost_usd_estimate: 0.25, catalog_date: '2026-08-01' };
  },
  generate: async (request) => {
    genmedia.generations += 1;
    return { ok: true, kind: request.kind, provider: 'fal',
      model: request.model || (request.kind === 'audio' ? 'fal-audio-test' : 'fal-image-test'),
      files: [request.kind === 'audio' ? 'generations/test.mp3' : 'generations/test.png',
        'C:\\Users\\owner\\secret.png', '../outside.png'],
      cost_usd_estimate: 0.25, fallbacks: ['openai → fal'], prompt: 'RAW_PROMPT_MUST_NOT_LEAK',
      api_key: 'FAL_TEST_SECRET_MUST_NOT_LEAK', sdk_raw: { token: 'SDK_RAW_MUST_NOT_LEAK' } };
  },
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
  const cleaned = codexmcp._internals.permissionInput({ text: 'x'.repeat(5000), ref: 's3:e7', injected: 'no' });
  ok(cleaned.text.length === 4000 && cleaned.ref === 's3:e7' && !Object.hasOwn(cleaned, 'injected'), 'تفاصيل إذن المتصفح منقّاة ومحدودة');
  const cleanedFields = codexmcp._internals.permissionInput({ fields: [{ ref: 's3:e1', value: 'smtp-relay.brevo.com', injected: 'no' }] });
  ok(cleanedFields.fields[0].value === 'smtp-relay.brevo.com' && !Object.hasOwn(cleanedFields.fields[0], 'injected'), 'حقول إذن fill_form مرئية ومنقّاة');
  const allowAll = async () => true;
  const srv = await codexmcp.start({ preview, cwd: process.cwd(), genmedia, requestPermission: allowAll });

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
  ['open_preview', 'browser_navigate', 'read_page', 'browser_readability', 'browser_snapshot', 'browser_console', 'browser_network', 'screenshot',
   'browser_screenshot_element', 'browser_wait_for', 'browser_scroll', 'browser_hover',
   'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key', 'browser_handoff',
   'browser_fill_form', 'browser_transfer_field', 'browser_request_secret', 'browser_handoff_step',
   'browser_evaluate', 'browser_set_viewport', 'browser_perf', 'browser_back', 'browser_forward',
   'run_in_background', 'get_background_output', 'list_background_tasks', 'stop_background_task',
   'generate_media',
   'promo_record_start', 'promo_record_stop', 'promo_list_segments', 'promo_propose_storyboard']
    .forEach((n) => ok(names.includes(n), 'tools/list يشمل ' + n));
  ok(names.length === 37, 'عدد أدوات Codex MCP أصبح 37 (27 متصفح — منها close_preview ‏OBS-020 وbrowser_readability — + 5 خلفية، منها wait_for_background_task، + generate_media + 4 برومو)');
  ok(names.includes('wait_for_background_task'), 'أداة الانتظار الحاجب غائبة عن tools/list');
  ok(j.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), 'كل أداة لها inputSchema من نوع object');
  const builtTools = codexmcp.buildTools({ preview, cwd: process.cwd(), genmedia, promoCapture, promoStudio });
  const built = (name) => builtTools.find((tool) => tool.name === name);
  ok(built('browser_evaluate').browserClass === 'act', 'browser_evaluate مصنّفة act');
  ok(built('browser_set_viewport').browserClass === 'read' && built('browser_perf').browserClass === 'read', 'viewport/perf مصنّفتان read');
  ok(built('browser_readability').browserClass === 'read', 'browser_readability مصنّفة read (بلا إذن نطاق)');
  ok(built('browser_back').browserClass === 'navigate' && built('browser_forward').browserClass === 'navigate', 'back/forward مصنّفتان navigate');
  ok(['browser_fill_form', 'browser_transfer_field', 'browser_request_secret'].every((name) => built(name).browserClass === 'act'), 'أدوات الحقول الجديدة مصنّفة act');
  ok(built('browser_handoff_step').browserClass === 'handoff', 'browser_handoff_step مصنّفة handoff');
  ok(built('generate_media').access === 'exec' && built('generate_media').neverAlways, 'generate_media فعل exec بلا «دائماً»');
  ok(['kind', 'prompt', 'model', 'count', 'refs', 'budget_usd'].every((field) => Object.hasOwn(built('generate_media').inputSchema.properties, field)),
    'generate_media تعلن حقول العقد المجمّد فقط');
  const adapterMediaDef = tools.defs().find((definition) => definition.function.name === 'generate_media');
  ok(tools.permissionTier('generate_media') === 'exec' && adapterMediaDef
    && ['kind', 'prompt', 'model', 'count', 'refs', 'budget_usd'].every((field) => Object.hasOwn(adapterMediaDef.function.parameters.properties, field)),
  'generate_media مصنّفة exec في tools.js وتعلن حقول العقد');
  const agentSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.js'), 'utf8');
  const hookguardSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'hookguard.js'), 'utf8');
  const codexMcpSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'codexmcp.js'), 'utf8');

  // OBS-087 (أ): مستودع غير موثوق قد يزرع SessionStart/setup.mjs. الحارس يثبت
  // التنبيه مرة لكل بصمة، تغيّرها، الصمت للمشروع النظيف/فشل القراءة، وعدم تسريب الأمر.
  const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-hookguard-'));
  try {
    const riskyProject = path.join(hookRoot, 'risky-project');
    const claudeDir = path.join(riskyProject, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.json');
    const stateFile = path.join(hookRoot, 'state', 'claude-hook-fingerprints.json');
    const leakedCommand = 'node .claude/setup.mjs api_key=sk-OBS087MUSTNOTLEAK123456';
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [{
      matcher: 'startup', hooks: [{ type: 'command', command: leakedCommand }],
    }] } }), 'utf8');
    const guard = hookguard.createGuard({
      file: stateFile,
      now: () => new Date('2026-09-04T00:00:00.000Z'),
    });

    const firstNotice = await guard.inspectProject(riskyProject);
    ok(typeof firstNotice === 'string' && firstNotice.includes('خطّاف SessionStart')
      && firstNotice.includes('.claude/settings.json'),
    'OBS-087: مستودع SessionStart يصدر تنبيهاً عربياً واحداً بمساره النسبي');
    const noticeEvent = hookguard.noticeEvent(firstNotice);
    const scrubbedNoticeEvent = hookguard.noticeEvent(
      'تنبيه دفاعي authorization=Bearer sk-OBS087SECONDARYMUSTNOTLEAK123456');
    ok(noticeEvent && noticeEvent.type === 'assistant'
      && noticeEvent.message.content.length === 1
      && noticeEvent.message.content[0].text === firstNotice
      && scrubbedNoticeEvent.message.content[0].text.includes('[secret]')
      && !JSON.stringify(scrubbedNoticeEvent).includes('OBS087SECONDARYMUSTNOTLEAK'),
    'OBS-087: التنبيه غير حاجب ويعبر بعقد عرض واحد بلا طلب قرار');
    ok(!JSON.stringify(noticeEvent).includes('OBS087MUSTNOTLEAK')
      && !JSON.stringify(noticeEvent).includes('api_key=')
      && !JSON.stringify(noticeEvent).includes('node .claude/setup.mjs'),
    'OBS-087: لا يعبر محتوى أمر SessionStart ولا السر إلى renderer');

    const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const storedText = JSON.stringify(stored);
    const storedEntry = stored.projects[hookguard.projectKey(riskyProject)];
    ok(stored.version === hookguard.STORE_VERSION
      && Object.keys(stored.projects).length === 1
      && storedEntry && /^[a-f0-9]{64}$/.test(storedEntry.fingerprint)
      && storedEntry.updated_at === '2026-09-04T00:00:00.000Z'
      && !storedText.includes(riskyProject) && !storedText.includes('OBS087MUSTNOTLEAK')
      && !fs.readdirSync(path.dirname(stateFile)).some((name) => name.includes('.tmp-')),
    'OBS-087: البصمة ذرية ومحدودة ولا تحفظ مسار المشروع أو محتوى الخطّاف');

    const reopenedNotice = await guard.inspectProject(riskyProject);
    ok(reopenedNotice === null, 'OBS-087: إعادة فتح البصمة نفسها لا تكرر التنبيه');

    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [{
      matcher: 'startup', hooks: [{ type: 'command', command: leakedCommand + ' --changed' }],
    }] } }), 'utf8');
    const changedNotice = await guard.inspectProject(riskyProject);
    ok(typeof changedNotice === 'string' && changedNotice.includes('.claude/settings.json'),
      'OBS-087: تغيّر محتوى الخطّاف يصدر تنبيهاً ثانياً');

    const setupProject = path.join(hookRoot, 'setup-project');
    fs.mkdirSync(path.join(setupProject, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(setupProject, '.claude', 'setup.mjs'),
      'const token = "sk-SETUPMUSTNOTLEAK123456";\n', 'utf8');
    const setupNotice = await guard.inspectProject(setupProject);
    ok(typeof setupNotice === 'string' && setupNotice.includes('.claude/setup.mjs')
      && !setupNotice.includes('SETUPMUSTNOTLEAK'),
    'OBS-087: setup.mjs وحده يُرصد بمساره ولا يتسرّب محتواه');

    const cleanProject = path.join(hookRoot, 'clean-project');
    fs.mkdirSync(cleanProject, { recursive: true });
    const cleanNotice = await guard.inspectProject(cleanProject);
    ok(cleanNotice === null, 'OBS-087: المشروع النظيف يبقى صامتاً');

    const failingState = path.join(hookRoot, 'failing-state', 'fingerprints.json');
    const failingPromises = Object.create(fs.promises);
    failingPromises.readFile = async (file, ...args) => {
      if (path.resolve(String(file)) === path.resolve(settingsFile)) {
        const error = new Error('OBS087_READ_FAILURE_MUST_NOT_LOG');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.readFile(file, ...args);
    };
    const silentGuard = hookguard.createGuard({ file: failingState, fs: { promises: failingPromises } });
    const failedReadNotice = await silentGuard.inspectProject(riskyProject);
    ok(failedReadNotice === null && !fs.existsSync(failingState),
      'OBS-087: تعذّر القراءة يتدهور إلى الصمت بلا تنبيه أو بصمة مدّعاة');

    ok(!hookguardSource.includes('child_process')
      && hookguard.MAX_SETTINGS_BYTES === 256 * 1024
      && hookguard.MAX_SETUP_BYTES === 512 * 1024
      && hookguard.MAX_PROJECTS === 256,
    'OBS-087: الفحص ثابت المسارات بلا عملية أو مشي شجرة وبسقوف معلنة');
    const hookCall = agentSource.indexOf('void hookguard.inspectProject(cwd)');
    const sdkLoad = agentSource.indexOf('const { query } = await loadSdk()', hookCall);
    ok(hookCall >= 0 && sdkLoad > hookCall
      && !agentSource.includes('await hookguard.inspectProject(cwd)')
      && /hookguard\.noticeEvent\(notice\)/.test(agentSource)
      && /if \(!internalPolicy\) \{[\s\S]{0,500}hookguard\.inspectProject/.test(agentSource),
    'OBS-087: agent يبدأ الحارس قبل تحميل SDK بلا await ويعزل تشغيلات السياسة الداخلية');
    ok(agentSource.includes("settingSources: isolatedPolicy ? [] : ['user', 'project', 'local']")
      && agentSource.includes("const options = { cwd, settingSources: ['user', 'project', 'local'] }"),
    'OBS-087: settingSources بقيت مطابقة لـClaude Code في الدور والتحكم');
  } finally {
    fs.rmSync(hookRoot, { recursive: true, force: true });
  }

  const leaseMessages = {
    input_changed: 'تدخّل المستخدم في الصفحة بعد لقطتك؛ لم يُنفَّذ الفعل. خذ browser_snapshot جديدة قبل المتابعة.',
    target_changed: 'تغيّر العنصر الهدف منذ لقطتك — كان «زر الحذف 1» وصار «زر الحذف 100»؛ لم يُنفَّذ الفعل. خذ لقطة جديدة وتحقق من نيّتك.',
    ref_removed: 'أزيل العنصر الهدف من الصفحة بعد لقطتك (غالباً بتفاعل المستخدم أو تحديث الصفحة نفسها)؛ خذ لقطة جديدة.',
  };
  ok(codexmcp.whyClosed('input_changed') === leaseMessages.input_changed
    && codexmcp.whyClosed('target_changed', null, { was: 'زر الحذف 1', now: 'زر الحذف 100' }) === leaseMessages.target_changed
    && codexmcp.whyClosed('ref_removed') === leaseMessages.ref_removed,
  'whyClosed يترجم رموز عقد اللقطة الثلاثة بالنص العربي الحرفي');
  ok(/whyClosed:\s*previewErrorMessage/.test(agentSource)
    && !agentSource.includes('تدخّل المستخدم في الصفحة بعد لقطتك')
    && !agentSource.includes('تغيّر العنصر الهدف منذ لقطتك')
    && !agentSource.includes('أزيل العنصر الهدف من الصفحة بعد لقطتك')
    && codexMcpSource.includes('const LEASE_ERROR_MESSAGES'),
  'غلاف SDK يستهلك مترجم codexmcp ولا يكرر نصوص عقد اللقطة');
  ok(/actionProof:\s*browserActionProof/.test(agentSource) && !/function browserActionProof\(/.test(agentSource)
    && /function actionProof\(/.test(codexMcpSource),
  'غلافا Codex وSDK يستهلكان صياغة actionProof المشتركة');
  ok(/satisfied=unknown/.test(codexmcp.actionProof('نقرة', {
    dispatched: true, effect_observed: false, navigated: false, dom_changed: false,
  })), 'actionProof يعرض satisfied=unknown حين لا يُعرف شرط النقر اللاحق');
  const leaseCheck = agentSource.indexOf("const lease = typeof preview.leaseError === 'function'");
  const bypassCheck = agentSource.indexOf("permissionMode === 'bypassPermissions'", leaseCheck);
  ok(leaseCheck >= 0 && bypassCheck > leaseCheck, 'SDK يفحص عقد اللقطة قبل تجاوز/بوابة الإذن');
  const browserBrief = envbrief.build('sdk', 'test-model');
  ok(/أضيق وأقصر/.test(browserBrief) && /full_page:true/.test(browserBrief)
    && /إذا تدخّل المستخدم/.test(browserBrief) && /لا تكرر الفعل/.test(browserBrief),
  'موجز المتصفح يوجّه للقطة الكاملة وللقطة جديدة بعد تدخل المستخدم');
  ok(/أضيق وأقصر/.test(built('screenshot').description) && /full_page=true/.test(built('screenshot').description)
    && /browser_set_viewport/.test(built('screenshot').description)
    && /أضيق وأقصر/.test(agentSource) && /full_page=true/.test(agentSource) && /screenshotLengthHint\(r\)/.test(agentSource),
  'سطحا screenshot يشرحان ضيق اللوحة وSDK يستهلك التلميح الآلي المشترك');

  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-browser-audit-'));
  const auditFile = path.join(auditDir, 'session.jsonl');
  const auditSecret = 'SECRET_PROMPT_MUST_NOT_APPEAR';
  fs.writeFileSync(auditFile, [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: auditSecret } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'browser_click', input: { ref: 's1:e1' } }] } },
    { type: 'user', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'dom_changed=false' }] } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u2', name: 'browser_snapshot', input: {} }] } },
    { type: 'user', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: '[s1:e1] button' }] } },
  ].map(JSON.stringify).join('\n') + '\n', 'utf8');
  const auditSession = await browserAudit._internals.parseSession(auditFile, { invalidLines: 0, failedFiles: 0 });
  const auditReport = browserAudit._internals.buildReport(1, [auditSession], { invalidLines: 0, failedFiles: 0 });
  fs.unlinkSync(auditFile);
  fs.rmdirSync(auditDir);
  ok(auditReport.totals.steps === 2 && auditReport.totals.model_turn_median_ms === 2000
    && auditReport.totals.wasted_snapshot_cycles === 1 && !JSON.stringify(auditReport).includes(auditSecret),
  'محلل السجلات يقرن الأدوات ويحسب زمن الدور والدورة المهدورة بلا حفظ نص المحادثة');
  ok(agentSource.includes("const GENERATE_MEDIA_TOOL = 'mcp__satr-terminal__generate_media'")
    && /NEVER_ALWAYS_TOOLS[^\n]+GENERATE_MEDIA_TOOL/.test(agentSource)
    && /NEVER_TURN_TOOLS[\s\S]{0,300}GENERATE_MEDIA_TOOL/.test(agentSource),
  'generate_media في SDK مصنّفة بلا «دائماً» ولا موافقة دور');
  ok(/kind:\s*z\.enum\(\['image', 'video', 'audio'\]\)/.test(agentSource)
    && /runGenerateMedia\(cwd, args, \{[\s\S]{0,120}genmedia: genmediaOverride, mediaCostState, emit/.test(agentSource),
  'سطح SDK يمرّر باعث الدور إلى طبقة generate_media المشتركة ويدعم audio');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  ok(/function sanitizeGenerationDoneEvent\(cwd, value\)/.test(mainSource)
    && /return \{ type: 'generation_done', kind, files: filesList, cost_usd_estimate: cost, provider, model \}/.test(mainSource)
    && /codexmcp\.setEventSink\(/.test(mainSource),
  'main.js يعيد بناء generation_done بقائمة الحقول المغلقة ويمرّر مصرف codexmcp');

  const adapterEvents = [];
  const adapterMedia = await tools.runGenerateMedia(process.cwd(), {
    kind: 'audio', prompt: 'تعليق عربي', budget_usd: 1,
  }, { genmedia, mediaCostState: { total: 0 }, emit: (event) => adapterEvents.push(event) });
  ok(adapterMedia.ok && adapterEvents.length === 1, 'سطح المحوّلات يبث generation_done واحداً بعد النجاح');
  assert.deepStrictEqual(adapterEvents[0], {
    type: 'generation_done', kind: 'audio', files: ['generations/test.mp3'],
    cost_usd_estimate: 0.25, provider: 'fal', model: 'fal-audio-test',
  });
  ok(Object.keys(adapterEvents[0]).sort().join(',') === 'cost_usd_estimate,files,kind,model,provider,type'
    && !JSON.stringify(adapterEvents).includes('RAW_PROMPT_MUST_NOT_LEAK')
    && !JSON.stringify(adapterEvents).includes('FAL_TEST_SECRET_MUST_NOT_LEAK')
    && !JSON.stringify(adapterEvents).includes('SDK_RAW_MUST_NOT_LEAK')
    && !JSON.stringify(adapterEvents).includes('C:\\Users') && !JSON.stringify(adapterEvents).includes('../outside'),
  'حدث المحوّلات يطابق schema v1 وينقّي البرومبت والمفتاح والخرج الخام والمسارات غير النسبية');

  const failedEvents = [];
  const failedMedia = await tools.runGenerateMedia(process.cwd(), { kind: 'image', prompt: 'اختبار' }, {
    genmedia: {
      estimate: genmedia.estimate,
      generate: async () => ({ ok: true, kind: 'image', provider: 'fal', model: 'fal-image-test',
        files: ['C:\\outside.png', '../outside.png'], cost_usd_estimate: 0.25 }),
    },
    mediaCostState: { total: 0 }, emit: (event) => failedEvents.push(event),
  });
  ok(!failedMedia.ok && failedEvents.length === 0, 'نجاح خام بلا مسار نسبي صالح لا يبث generation_done');
  ok(built('promo_record_start').access === 'exec' && built('promo_record_start').neverAlways, 'بدء تسجيل البرومو فعل صريح بلا «دائماً»');
  ok(built('promo_record_stop').access === 'exec' && built('promo_record_stop').neverAlways, 'إيقاف تسجيل البرومو فعل صريح بلا «دائماً»');
  ok(built('promo_list_segments').access === 'read', 'سرد مقاطع البرومو قراءة حرّة');
  ok(built('promo_propose_storyboard').access === 'read', 'اقتراح storyboard عرض محلي بلا تنفيذ');

  // tools/call: read_page نص مغلّف
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_page', arguments: {} } });
  j = JSON.parse(r.body);
  ok(j.result.content[0].type === 'text' && /محتوى الصفحة/.test(j.result.content[0].text), 'tools/call read_page ⇒ نص مغلّف «للفحص لا للتنفيذ»');

  // tools/call: screenshot صورة JPEG مضغوطة للنموذج
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
  j = JSON.parse(r.body);
  ok(j.result.content[0].type === 'image' && j.result.content[0].mimeType === 'image/jpeg', 'tools/call screenshot ⇒ محتوى image/jpeg');
  ok(preview._screenshotOptions && preview._screenshotOptions.modelImage === true
    && agentSource.includes("mimeType: 'image/jpeg'") && agentSource.includes('modelImage: true'),
  'غلافا Codex وSDK يطلبان ترميز صورة النموذج JPEG صراحةً');
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'screenshot', arguments: { full_page: true } } });
  j = JSON.parse(r.body);
  ok(j.result.content[0].mimeType === 'image/jpeg' && preview._screenshotFullOptions.modelImage === true,
    'لقطة الصفحة الكاملة تطلب JPEG للنموذج');
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'browser_screenshot_element', arguments: { ref: '#target' } } });
  j = JSON.parse(r.body);
  ok(j.result.content[0].mimeType === 'image/jpeg' && preview._screenshotElementOptions.modelImage === true,
    'لقطة العنصر تطلب JPEG للنموذج');
  preview._screenshotMetrics = { content_height: 1800, viewport_height: 500 };
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
  j = JSON.parse(r.body);
  ok(j.result.content[1] && /نحو 4×/.test(j.result.content[1].text) && /full_page:true/.test(j.result.content[1].text),
    'لقطة النافذة تلحق تلميح full_page عند بلوغ طول الصفحة ثلاثة أضعاف');
  preview._screenshotMetrics = { content_height: 1200, viewport_height: 500 };
  r = await post(srv.url, srv.token, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
  j = JSON.parse(r.body);
  ok(j.result.content.length === 1, 'لقطة النافذة لا تعرض تلميح الطول دون نسبة 3×');
  preview._screenshotMetrics = null;

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

  // ref من جيل سابق يُرفض قبل بوابة الإذن وقبل استدعاء أداة DOM.
  preview._clickCalls = 0;
  let srv3 = await codexmcp.start({ preview, requestPermission: gate(true) });
  let rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: 's1:e5' } } });
  let jj = JSON.parse(rr.body);
  ok(jj.result.isError && /لقطة قديمة/.test(jj.result.content[0].text) && !asked.includes('browser_click') && preview._clickCalls === 0,
    'stale_ref يُرفض قبل الإذن وقبل لمس DOM');
  await srv3.stop();

  // تدخّل المستخدم بعد اللقطة يُرفض قبل بوابة الإذن وقبل استدعاء أداة DOM.
  asked.length = 0;
  preview._leaseError = { error: 'input_changed' };
  srv3 = await codexmcp.start({ preview, requestPermission: gate(true) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: 's3:e5' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && jj.result.content[0].text === leaseMessages.input_changed
    && !asked.includes('browser_click') && preview._clickCalls === 0,
  'input_changed يُرفض قبل الإذن وقبل لمس DOM');
  preview._leaseError = null;
  await srv3.stop();

  // (أ) رفض ⇒ browser_click لا يُنفَّذ ويعيد خطأ إذن
  srv3 = await codexmcp.start({ preview, requestPermission: gate(false) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: 'e5' } } });
  jj = JSON.parse(rr.body);
  ok(asked.includes('browser_click') && jj.result.isError && /رُفض الإذن/.test(jj.result.content[0].text), 'رفض الإذن ⇒ browser_click لا يُنفَّذ');
  await srv3.stop();

  // (ب) قبول ⇒ browser_type يُنفَّذ
  asked.length = 0;
  srv3 = await codexmcp.start({ preview, requestPermission: gate(true) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_type', arguments: { ref: 'e7', text: 'x' } } });
  jj = JSON.parse(rr.body);
  ok(asked.includes('browser_type') && !jj.result.isError && /كُتب النص/.test(jj.result.content[0].text), 'قبول الإذن ⇒ browser_type يُنفَّذ');
  ok(/dispatched=true/.test(jj.result.content[0].text) && /effect_observed=true/.test(jj.result.content[0].text)
    && /satisfied=true/.test(jj.result.content[0].text) && /dom_changed=true/.test(jj.result.content[0].text),
  'نتيجة الفعل تعرض ثلاثية الإثبات وتبقي dom_changed للنموذج');
  ok(/تغيّر DOM المختصر/.test(jj.result.content[0].text) && /s3:e2/.test(jj.result.content[0].text), 'نتيجة الفعل تمرّر DOM delta والـref الجديدة للنموذج');
  ok(/قُصّ تغيّر DOM/.test(jj.result.content[0].text), 'نتيجة الفعل تطلب snapshot عند قصّ DOM delta');
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
  genmedia.generations = 0;
  const deniedMediaEvents = [];
  srv3 = await codexmcp.start({ preview, cwd: process.cwd(), genmedia, emit: (event) => deniedMediaEvents.push(event), requestPermission: gate(false) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 61, method: 'tools/call', params: {
    name: 'generate_media', arguments: { kind: 'image', prompt: 'اختبار', count: 2, budget_usd: 1 },
  } });
  jj = JSON.parse(rr.body);
  const mediaDenied = askedMeta.find((item) => item.tool === 'generate_media');
  ok(jj.result.isError && genmedia.generations === 0 && mediaDenied && mediaDenied.access === 'exec' && mediaDenied.neverAlways,
    'رفض إذن generate_media يمنع التنفيذ ويعطّل «دائماً»');
  ok(deniedMediaEvents.length === 0, 'رفض إذن generate_media لا يبث generation_done');
  ok(mediaDenied.input.provider === 'fal' && mediaDenied.input.model === 'fal-image-test'
    && mediaDenied.input.count === 2 && mediaDenied.input.cost_usd_estimate === 0.25
    && mediaDenied.input.session_cost_usd_estimate === 0.25,
  'إذن generate_media يعرض النوع والمزوّد والنموذج والعدد والكلفة وتراكمي الجلسة');
  await srv3.stop();

  asked.length = 0; askedMeta.length = 0;
  const codexMcpEvents = [];
  srv3 = await codexmcp.start({ preview, cwd: process.cwd(), genmedia, emit: (event) => codexMcpEvents.push(event), requestPermission: gate(true) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 62, method: 'tools/call', params: {
    name: 'generate_media', arguments: { kind: 'image', prompt: 'اختبار' },
  } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && genmedia.generations === 1 && /generations\/test\.png/.test(jj.result.content[0].text)
    && /0\.250000/.test(jj.result.content[0].text) && /openai → fal/.test(jj.result.content[0].text)
    && !JSON.stringify(jj).includes('FAL_TEST_SECRET_MUST_NOT_LEAK'),
  'قبول generate_media يفوّض للمزيّف ويعيد المسار والكلفة والسقوط بالعربية');
  assert.deepStrictEqual(codexMcpEvents, [{
    type: 'generation_done', kind: 'image', files: ['generations/test.png'],
    cost_usd_estimate: 0.25, provider: 'fal', model: 'fal-image-test',
  }]);
  ok(!JSON.stringify(codexMcpEvents).includes('RAW_PROMPT_MUST_NOT_LEAK')
    && !JSON.stringify(codexMcpEvents).includes('FAL_TEST_SECRET_MUST_NOT_LEAK')
    && !JSON.stringify(codexMcpEvents).includes('SDK_RAW_MUST_NOT_LEAK'),
  'سطح codexmcp يبث schema المنقّى نفسه بلا أي حقل خام أو سر');
  asked.length = 0; askedMeta.length = 0;
  await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 63, method: 'tools/call', params: {
    name: 'generate_media', arguments: { kind: 'image', prompt: 'اختبار ثانٍ' },
  } });
  ok(askedMeta.some((item) => item.tool === 'generate_media' && item.input.session_cost_usd_estimate === 0.5),
    'إذن generate_media يجمع الكلفة التقديرية عبر الجلسة');
  await srv3.stop();

  srv3 = await codexmcp.start({ preview, cwd: process.cwd(), genmedia: null, requestPermission: gate(true) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 64, method: 'tools/call', params: {
    name: 'generate_media', arguments: { kind: 'image', prompt: 'اختبار' },
  } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && /ميزة التوليد لم تكتمل بعد/.test(jj.result.content[0].text),
    'غياب genmedia يتدهور برسالة عربية بلا كسر التطبيق');
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

  asked.length = 0; askedMeta.length = 0;
  srv3 = await codexmcp.start({ preview, promoCapture, promoStudio, requestPermission: gate(false) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'promo_record_start', arguments: { aspect: '16:9' } } });
  jj = JSON.parse(rr.body);
  ok(jj.result.isError && promoCapture.starts === 0
    && askedMeta.some((item) => item.tool === 'promo_record_start' && item.access === 'exec' && item.neverAlways),
  'رفض إذن promo_record_start يمنع التسجيل ويعطّل «دائماً»');
  await srv3.stop();

  asked.length = 0; askedMeta.length = 0;
  srv3 = await codexmcp.start({ preview, promoCapture, promoStudio, requestPermission: gate(true) });
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'promo_record_start', arguments: { aspect: '9:16' } } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && promoCapture.starts === 1 && /promo_/.test(jj.result.content[0].text), 'قبول إذن promo_record_start يبدأ التسجيل');
  asked.length = 0;
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'promo_list_segments', arguments: {} } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && !asked.includes('promo_list_segments'), 'promo_list_segments قراءة بلا مربع إذن');
  rr = await post(srv3.url, srv3.token, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'promo_propose_storyboard', arguments: { scenes: [{ segment_path: 'C:\\Downloads\\clip.mp4' }] } } });
  jj = JSON.parse(rr.body);
  ok(!jj.result.isError && promoStudio.proposals === 1 && !asked.includes('promo_propose_storyboard'), 'اقتراح storyboard يبث العرض بلا إذن تنفيذ ولا تصيير');
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
  ok(!codex.shouldAutoApproveMcp('exec', true, 'default', false, true, 'promo_record_start', null, trustedOrigins), 'browserControl لا يعفي تسجيل الشاشة');
  ok(codex.shouldAutoApproveMcp('exec', false, 'default', true, false, 'run_in_background', null, trustedOrigins), 'الموافقة الدائمة الخاصة تعفي تشغيل الخلفية');
  ok(!codex.shouldAutoApproveMcp('exec', false, 'default', true, true, 'stop_background_task', null, trustedOrigins), 'stop لا تعفيه الموافقة الدائمة');
  ok(!codex.shouldAutoApproveMcp('exec', false, 'default', true, true, 'promo_record_start', null, trustedOrigins), 'الموافقة الدائمة لا تعفي بدء تسجيل البرومو');

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

  // OBS-021 (الجذر): موت نداء codex أثناء تسليم معلق (مهلة أداة/إلغاء دور) يجب أن
  // يفكّ علم التسليم وحده — لا يتيم يعلّق كل أدوات المعاينة للأبد بعده.
  {
    const dead = new URL(srv5.url);
    const orphan = http.request({
      host: dead.hostname, port: dead.port, path: dead.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + srv5.token },
    });
    orphan.on('error', () => {}); // التدمير المتعمد يرمي ECONNRESET — متوقع
    orphan.end(JSON.stringify({ jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'browser_handoff', arguments: { reason: 'ارفع الصورة بيدك' } } }));
    for (let i = 0; i < 50 && !preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
    ok(preview.isHandoffActive(), 'التسليم اليتيم فعّل العلم قبل موت النداء');
    orphan.destroy(); // موت النداء (يحاكي قطع codex للمهلة/إلغاء الدور)
    for (let i = 0; i < 100 && preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
    ok(!preview.isHandoffActive(), 'موت النداء أثناء التسليم فكّ العلم وحده (لا علوق يتيم — OBS-021)');
    rr = await post(srv5.url, srv5.token, { jsonrpc: '2.0', id: 29, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000/z' } } });
    ok(!JSON.parse(rr.body).result.isError, 'بعد موت النداء اليتيم تعود أدوات المعاينة للعمل فوراً');
  }

  // OBS-021 (الجذر الثاني): browser_request_secret ينتظر حسم الواجهة مباشرةً — موت
  // النداء أثناءه يجب أن يلغي الطلب (cancelSecretRequest) فيُفكّ علم التسليم وحده.
  {
    let secretResolve = null;
    const secretPreview = Object.create(preview);
    secretPreview.requestSecret = () => { preview.startHandoff(); return new Promise((res) => { secretResolve = res; }); };
    secretPreview.cancelSecretRequest = () => {
      preview.endHandoff();
      if (secretResolve) { secretResolve({ ok: false, filled: false, error: 'cancelled' }); secretResolve = null; }
      return { ok: true };
    };
    const srv6 = await codexmcp.start({ preview: secretPreview, requestPermission: allowAll });
    const dead = new URL(srv6.url);
    const orphan = http.request({
      host: dead.hostname, port: dead.port, path: dead.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + srv6.token },
    });
    orphan.on('error', () => {});
    orphan.end(JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'browser_request_secret', arguments: { field_ref: '#pw', reason: 'أدخل كلمة المرور بيدك' } } }));
    for (let i = 0; i < 50 && !preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
    ok(preview.isHandoffActive(), 'طلب السر اليتيم فعّل علم التسليم قبل موت النداء');
    orphan.destroy();
    for (let i = 0; i < 100 && preview.isHandoffActive(); i++) await new Promise((res) => setTimeout(res, 10));
    ok(!preview.isHandoffActive(), 'موت النداء أثناء طلب السر ألغاه وفكّ العلم وحده (OBS-021 الجذر الثاني)');
    await srv6.stop();
  }

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
