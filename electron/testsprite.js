'use strict';

const fs = require('fs');
const path = require('path');

const KEY_NAME = 'TESTSPRITE_API_KEY';
const SERVER_NAME = 'testsprite';
const PACKAGE = '@testsprite/testsprite-mcp@0.0.38';
const COMMAND = process.platform === 'win32' ? 'cmd' : 'npx';
const ARGS = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npx', '-y', PACKAGE]
  : ['-y', PACKAGE];
const CODEX_ENABLED_TOOLS = [
  'testsprite_bootstrap',
  'testsprite_generate_code_summary',
  'testsprite_generate_standardized_prd',
  'testsprite_generate_frontend_test_plan',
  'testsprite_generate_backend_test_plan',
  'testsprite_generate_code_and_execute',
  'testsprite_check_account_info',
];
const MISSING_KEY_MESSAGE = 'تكامل TestSprite مطلوب، لكن مفتاحه غير مضبوط. أضف مفتاحاً جديداً من ⚙ ← مفاتيح المزوّدين والتكاملات.';
// درس الجولة الأولى: TestSprite قد يعيد حالات حجب/إلغاء — بلا اعتبارها نهائية يعلق
// المراقب إلى الأبد على جولة لن تتقدم.
const TERMINAL_STATUSES = new Set(['PASSED', 'FAILED', 'SKIPPED', 'BLOCKED', 'CANCELLED', 'INFRA_ERROR']);
const INTENT_PREFIX_LIMIT = 400;
const INJECTED_RUN_BLOCK_RE = /<satr_testsprite_run\b[^>]*>[\s\S]*?<\/satr_testsprite_run\s*>/gi;

function isValidApiKey(value) {
  return typeof value === 'string' && /^sk-user-[A-Za-z0-9_-]{40,8000}$/.test(value.trim());
}

function normalizeIntentText(prompt) {
  return String(prompt || '').trim().toLowerCase()
    .replace(/[\u0640\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[ئى]/g, 'ي')
    .replace(/\s+/g, ' ');
}

function classifyRequest(prompt) {
  if (typeof prompt !== 'string') return { explicit: false, generic: false };
  // كتلة التشغيل يولّدها «سطر» نفسه؛ إعادة لصقها أو اقتباس تقرير يحويها ليست نية جديدة.
  // ننزعها قبل سقف المقدمة، ثم نفحص أول 400 محرف فقط لأن طلب المستخدم الحقيقي يتصدر الرسالة.
  const text = prompt.replace(INJECTED_RUN_BLOCK_RE, '').trim().slice(0, INTENT_PREFIX_LIMIT);
  const arabic = normalizeIntentText(text);
  // لا يكفي أن يذكر تقريرٌ الخدمة في موضع وفعلَ اختبار في موضع آخر؛ يجب اجتماعهما في
  // الجملة نفسها. حدود الجملة مقصودة ومحدودة إلى .!؟ والسطر الجديد.
  const explicit = text.split(/[.!؟\r\n]+/).some((sentence) => {
    const normalized = normalizeIntentText(sentence);
    const mentionsService = /\btestsprite\b/i.test(sentence) || /تست\s*سبرايت/.test(normalized);
    const requestsAction = /\b(?:use|run|test|check|generate|open|bootstrap|connect|via|with)\b/i.test(sentence)
      || /(?:استخدم|شغل|اختبر|افحص|ولد|انشي|افتح|اربط|عبر|بواسط[هة])/.test(normalized);
    return mentionsService && requestsAction;
  });
  const generic = /^(?:(?:انا|نحن)\s+)?(?:اريد|نريد|ابغي|بدي|ابدا|ابدء|نفذ|شغل|قم\s+ب)\s+(?:ان\s+)?(?:اختبار|اختبر|فحص|افحص)(?:\s|$)/.test(arabic)
    || /^(?:اختبر|افحص)(?:\s|$)/.test(arabic)
    || /^(?:اختبار|فحص)\s+(?:كامل|شامل|سريع|المشروع|التطبيق|الواجه[هة]|التعديلات|الحالات)/.test(arabic);
  return { explicit, generic };
}

function requested(prompt) {
  const intent = classifyRequest(prompt);
  return intent.explicit;
}

// نية «جولة الموقع»: طلب TestSprite الصريح نفسه + ذكر صفحات site/ في مقدمة الرسالة.
// «الموقع» وحدها مقصودة: في جملة طلب اختبار TestSprite لا لبس بينها وبين التطبيق.
function siteRequested(prompt) {
  if (!requested(prompt)) return false;
  const text = String(prompt || '').replace(INJECTED_RUN_BLOCK_RE, '').trim().slice(0, INTENT_PREFIX_LIMIT);
  const arabic = normalizeIntentText(text);
  return /\b(?:site|landing)\b/i.test(text)
    || /(?:enterprise|wallet)\.html/i.test(text)
    || /(?:الموقع|موقع\s*سطر|صفح(?:[هة]|ات)\s*الهبوط|الصفحات\s*(?:العام[هة]|التسويقي[هة]))/.test(arabic);
}

function needsClarification(prompt) {
  if (typeof prompt !== 'string') return true;
  if (/\bTC\d{3,}\b/i.test(prompt)) return false;
  const text = normalizeIntentText(prompt);
  return !/(?:كامل|شامل|سريع|التعديلات|اخر\s+التغييرات|حالات\s+محدد[هة]|دفع[هة]|code\s*diff|codebase|full|quick|selected)/i.test(text);
}

function extractTestIds(prompt) {
  if (typeof prompt !== 'string') return [];
  return [...new Set((prompt.match(/\bTC\d{3,}\b/gi) || []).map((id) => id.toUpperCase()))];
}

function publicInfo() {
  return { name: SERVER_NAME, label: 'TestSprite', keyName: KEY_NAME, kind: 'integration' };
}

function claudeConfig(apiKey) {
  if (!isValidApiKey(apiKey)) return null;
  return {
    type: 'stdio', command: COMMAND, args: ARGS.slice(),
    env: { API_KEY: apiKey.trim() }, timeout: 600000,
  };
}

function codexLaunch(apiKey) {
  if (!isValidApiKey(apiKey)) return null;
  return {
    args: [
      '-c', 'mcp_servers.' + SERVER_NAME + '.command="' + COMMAND + '"',
      '-c', 'mcp_servers.' + SERVER_NAME + '.args=' + JSON.stringify(ARGS),
      '-c', 'mcp_servers.' + SERVER_NAME + '.env_vars=["API_KEY"]',
      // لا يوفّر app-server طلب موافقة تفاعلياً لأداة MCP الخارجية في عقد «سطر» الحالي.
      // حقن الخادم نفسه مشروط بطلب المستخدم الصريح لهذا الدور، لذا ذلك الطلب هو التفويض.
      '-c', 'mcp_servers.' + SERVER_NAME + '.enabled_tools=' + JSON.stringify(CODEX_ENABLED_TOOLS),
      '-c', 'mcp_servers.' + SERVER_NAME + '.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.' + SERVER_NAME + '.startup_timeout_sec=60',
      '-c', 'mcp_servers.' + SERVER_NAME + '.tool_timeout_sec=600',
    ],
    env: { API_KEY: apiKey.trim() },
  };
}

function configPath(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return path.join(cwd, 'testsprite_tests', 'tmp', 'config.json');
}

function resultPath(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return path.join(cwd, 'testsprite_tests', 'tmp', 'test_results.json');
}

function resultSnapshot(cwd) {
  const file = resultPath(cwd);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const results = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(results)) return null;
    return { file, mtimeMs: stat.mtimeMs, size: stat.size, fingerprint: stat.mtimeMs + ':' + stat.size, results };
  } catch {
    return null;
  }
}

function summarizeResults(results, testIds) {
  const wanted = Array.isArray(testIds) ? [...new Set(testIds.map((id) => String(id).toUpperCase()))] : [];
  const byId = new Map();
  for (const item of Array.isArray(results) ? results : []) {
    const match = /^((?:TC)\d{3,})(?:-|\s|$)/i.exec(String(item && item.title || ''));
    if (!match) continue;
    byId.set(match[1].toUpperCase(), String(item.testStatus || '').toUpperCase());
  }
  const ids = wanted.length ? wanted : [...byId.keys()];
  const statuses = ids.map((id) => byId.get(id) || 'PENDING');
  const count = (status) => statuses.filter((value) => value === status).length;
  return {
    testIds: ids,
    total: ids.length,
    completed: statuses.filter((status) => TERMINAL_STATUSES.has(status)).length,
    passed: count('PASSED'),
    failed: count('FAILED'),
    skipped: count('SKIPPED'),
    blocked: count('BLOCKED') + count('CANCELLED') + count('INFRA_ERROR'),
    complete: ids.length > 0 && statuses.every((status) => TERMINAL_STATUSES.has(status)),
  };
}

function watchResults(cwd, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const onUpdate = typeof settings.onUpdate === 'function' ? settings.onUpdate : () => {};
  const testIds = Array.isArray(settings.testIds) ? settings.testIds : [];
  const intervalMs = Number.isInteger(settings.intervalMs) && settings.intervalMs >= 100 ? settings.intervalMs : 1000;
  const stableMs = Number.isInteger(settings.stableMs) && settings.stableMs >= 0 ? settings.stableMs : 2000;
  const baseline = resultSnapshot(cwd);
  const baselineFingerprint = baseline && baseline.fingerprint;
  let lastFingerprint = null;
  let stableSince = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const tick = () => {
    if (stopped) return;
    const snapshot = resultSnapshot(cwd);
    if (!snapshot || snapshot.fingerprint === baselineFingerprint) return;
    const summary = summarizeResults(snapshot.results, testIds);
    if (snapshot.fingerprint !== lastFingerprint) {
      lastFingerprint = snapshot.fingerprint;
      stableSince = summary.complete ? Date.now() : 0;
      try { onUpdate({ type: 'testsprite_progress', phase: 'running', ...summary }); } catch {}
      return;
    }
    if (summary.complete && stableSince && Date.now() - stableSince >= stableMs) {
      try { onUpdate({ type: 'testsprite_progress', phase: 'complete', ...summary }); } catch {}
      stop();
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return { baseline, stop, tick };
}

function completedConfig(cwd) {
  const file = configPath(cwd);
  if (!file) return false;
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(['commited', 'committed', 'complete', 'completed']).has(String(config.status || '').toLowerCase());
  } catch {
    return false;
  }
}

function scrubConfig(cwd) {
  const file = configPath(cwd);
  if (!file) return false;
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        if (key === 'API_KEY' || key === KEY_NAME) {
          delete value[key];
          changed = true;
        } else visit(value[key]);
      }
    };
    visit(config);
    if (!changed) return false;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
    try { fs.chmodSync(file, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

function chatPrompt(prompt, context) {
  const url = context && context.url;
  const cwd = context && context.cwd;
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) return String(prompt || '');
  if (typeof cwd !== 'string' || !cwd) return String(prompt || '');
  const port = new URL(url).port;
  const requestedIds = extractTestIds(prompt);
  const clarificationInstruction = needsClarification(prompt)
    ? `هذا طلب اختبار عام. قبل استدعاء أدوات TestSprite اسأل المستخدم مرة واحدة وباختيارات قصيرة عن: (أ) اختبار سريع للتعديلات الأخيرة، أو كامل المشروع، أو حالات محددة؛ (ب) هل يوجد تسجيل دخول؛ (ج) تقرير فقط — وهو الموصى به — أو طلب موافقة منفصلة قبل أي إصلاح. استخدم AskUserQuestion إن كانت متاحة، وإلا اسأل الأسئلة الثلاثة في رسالة واحدة وانتظر الرد. بعد وصول الإجابة أكمل آلياً ولا تطلب من المستخدم كتابة أسماء أدوات MCP أو أوامر Terminal.`
    : 'النطاق محدد بما يكفي؛ لا تسأل أسئلة مكررة وابدأ التهيئة والتنفيذ مباشرة.';
  const resultSelection = requestedIds.length
    ? `راقب الحالات المحددة فقط: ${requestedIds.join(', ')}.`
    : 'استخرج الحالات المطلوبة من اختيار المستخدم أو خطة الاختبار؛ وعند testIds=[] راقب كل الحالات التي تكتبها الدفعة الحالية.';
  const bootstrapInstruction = completedConfig(cwd)
    ? '2. تهيئة TestSprite مكتملة في testsprite_tests/tmp/config.json؛ لا تستدعِ testsprite_bootstrap.'
    : `2. استدعِ testsprite_bootstrap بالقيم: localPort=${port}, pathname="/", type="frontend", projectPath=${JSON.stringify(cwd)}, testScope="codebase", serverMode="development". قد يفتح نموذج إعداد أولياً — وقد تطلق الحزمة متصفح النظام الخارجي من تلقائها (سلوكها الداخلي): تجاهله وافتح عنوان صفحة الإعداد نفسه فوراً في معاينة سطر عبر open_preview وأكمل التعبئة فيها؛ وإن طلب النموذج رفع ملف PRD فوجّه المستخدم لرفعه بيده ولا تحاول حقنه برمجياً. انتظر حفظ النموذج قبل المتابعة.`;
  return String(prompt || '') + `

<satr_testsprite_run>
بدأ «سطر» بالفعل Web harness آمناً لهذا الدور على ${url}/. لا تشغّل خادماً محلياً آخر، ولا تفتح لوحة النتائج؛ صفحة إعداد bootstrap الأولية مستثناة عند الحاجة.
استخدم أدوات MCP التابعة لخادم testsprite فعلياً؛ لا تستبدلها باختبارات npm أو بتحليل يدوي.
${clarificationInstruction}
نفّذ بالتسلسل:
1. testsprite_check_account_info، وتوقف إن فشل الاتصال أو أعادت الأداة حالة مفتاح غير صالح.
${bootstrapInstruction}
3. testsprite_generate_code_summary.
4. testsprite_generate_standardized_prd.
5. testsprite_generate_frontend_test_plan مع needLogin=false.
6. testsprite_generate_code_and_execute مع projectName="satr-2" وserverMode="development" وtestIds المطابقة لاختيار المستخدم. اطلب تغطية RTL والعربية والإقلاع والشريط العلوي واختيار المحرك والمؤلف وإرسال الرسالة المزيفة والثيم واللوحات والطرفية المزيفة، وصفر أخطاء console/CSP. لا تدّعِ اختبار Electron/IPC/PTY الحقيقي.
7. عندما تعيد الأداة أمر Terminal: سجّل أولاً mtime الحالي لـtestsprite_tests/tmp/test_results.json، ثم شغّل الأمر في الخلفية وراقب الملف كل 5 ثوانٍ. ${resultSelection} لا تعتبر صمت CLI أو بقاء العملية دليلاً على العمل؛ يكتمل TestSprite عندما يتغير الملف بعد خط الأساس وتظهر كل الحالات المطلوبة بحالة PASSED أو FAILED أو SKIPPED. عندها أوقف غلاف CLI العالق إن بقي، ولا تنتظر خروجه، ثم تابع التقرير.
8. بعد اكتمال TestSprite، شغّل npm run test:full من جذر المشروع بمهلة لا تقل عن 240000ms كي يغطي Node/Electron/IPC/CSP. هذا مكمل لا بديل لـTestSprite.
لا تعدّل كود الإنتاج، لا تضف اعتماديات، لا تنشئ commit. يُسمح فقط بملفات TestSprite داخل .testsprite/ وبمخرجات الاختبارات المؤقتة.
في التقرير افصل نتائج TestSprite على Web harness عن نتائج الطقم الأصلي، واعرض Passed/Failed/Skipped وأول سبب جذري لكل فشل وgit status --short. لا تصلح الإخفاقات في هذا الدور.
</satr_testsprite_run>`;
}

// عقد جولة الموقع (site/): سطح ثابت بلا محاكاة window.satr، والنطاق الصفحات الثلاث
// حصراً. bootstrap يُستدعى دائماً بقيم هذه الجولة (تهيئة سابقة على منفذ الواجهة لا
// تصلح لمنفذ الموقع)، ولا يُشغَّل test:full — الموقع مستقل عن Electron.
function siteChatPrompt(prompt, context) {
  const url = context && context.url;
  const cwd = context && context.cwd;
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) return String(prompt || '');
  if (typeof cwd !== 'string' || !cwd) return String(prompt || '');
  const port = new URL(url).port;
  const requestedIds = extractTestIds(prompt);
  const resultSelection = requestedIds.length
    ? `راقب الحالات المحددة فقط: ${requestedIds.join(', ')}.`
    : 'عند testIds=[] راقب كل الحالات التي تكتبها الدفعة الحالية.';
  return String(prompt || '') + `

<satr_testsprite_run>
هذه جولة اختبار «موقع سطر» الثابت (مجلد site/ — صفحة الهبوط وصفحتا العروض)، لا تطبيق سطر نفسه.
بدأ «سطر» خادم الموقع لهذا الدور على ${url}/ ويخدم ثلاث صفحات: / و/enterprise.html و/wallet.html. لا تشغّل خادماً محلياً آخر ولا تفتح لوحة النتائج؛ صفحة إعداد bootstrap الأولية مستثناة عند الحاجة.
استخدم أدوات MCP التابعة لخادم testsprite فعلياً؛ لا تستبدلها بتحليل يدوي.
النطاق محدد (الصفحات الثلاث)؛ لا تسأل أسئلة توضيح وابدأ مباشرة.
نفّذ بالتسلسل:
1. testsprite_check_account_info، وتوقف إن فشل الاتصال أو أعادت الأداة حالة مفتاح غير صالح.
2. استدعِ testsprite_bootstrap دائماً في هذه الجولة — حتى لو وُجدت تهيئة سابقة فهي لسطح آخر — بالقيم: localPort=${port}, pathname="/", type="frontend", projectPath=${JSON.stringify(cwd)}, testScope="codebase", serverMode="development". قد يفتح نموذج إعداد أولياً — وقد تطلق الحزمة متصفح النظام الخارجي من تلقائها (سلوكها الداخلي): تجاهله وافتح عنوان صفحة الإعداد نفسه فوراً في معاينة سطر عبر open_preview وأكمل التعبئة فيها؛ وإن طلب النموذج رفع ملف PRD فوجّه المستخدم لرفعه بيده ولا تحاول حقنه برمجياً. انتظر حفظ النموذج قبل المتابعة.
3. testsprite_generate_code_summary.
4. testsprite_generate_standardized_prd.
5. testsprite_generate_frontend_test_plan مع needLogin=false، ووجّه الخطة إلى صفحات الموقع الثلاث حصراً.
6. testsprite_generate_code_and_execute مع projectName="satr-site" وserverMode="development" وtestIds المطابقة لاختيار المستخدم. اطلب تغطية: الصفحات الثلاث تُحمَّل بلا أخطاء، الروابط الداخلية بينها (الرأس والتذييل) تعمل، رابط التنزيل يشير إلى GitHub Releases، أزرار البريد mailto موجودة وصحيحة الصيغة على صفحتي enterprise وwallet، الأسعار والأرقام تظهر LTR داخل النص العربي RTL، التجاوب على عرض موبايل ضيق، احترام prefers-reduced-motion، وصفر أخطاء console/CSP. لا تدّعِ اختبار تطبيق سطر أو Electron/IPC/PTY — هذه صفحات ويب ثابتة فقط.
7. عندما تعيد الأداة أمر Terminal: سجّل أولاً mtime الحالي لـtestsprite_tests/tmp/test_results.json، ثم شغّل الأمر في الخلفية وراقب الملف كل 5 ثوانٍ. ${resultSelection} لا تعتبر صمت CLI أو بقاء العملية دليلاً على العمل؛ يكتمل TestSprite عندما يتغير الملف بعد خط الأساس وتظهر كل الحالات المطلوبة بحالة PASSED أو FAILED أو SKIPPED. عندها أوقف غلاف CLI العالق إن بقي، ولا تنتظر خروجه، ثم تابع التقرير.
8. لا تشغّل npm run test:full في هذا الدور — جولة الموقع مستقلة عن طقم التطبيق الأصلي.
لا تعدّل site/ أو كود الإنتاج، لا تضف اعتماديات، لا تنشئ commit. يُسمح فقط بملفات TestSprite داخل .testsprite/ وبمخرجات الاختبارات المؤقتة.
في التقرير اعرض Passed/Failed/Skipped وأول سبب جذري لكل فشل وgit status --short، وبيّن أن التغطية صفحات site/ الثلاث فقط. لا تصلح الإخفاقات في هذا الدور.
</satr_testsprite_run>`;
}

module.exports = {
  KEY_NAME, SERVER_NAME, PACKAGE, COMMAND, ARGS, CODEX_ENABLED_TOOLS, MISSING_KEY_MESSAGE,
  isValidApiKey, classifyRequest, requested, siteRequested, needsClarification, extractTestIds, publicInfo,
  claudeConfig, codexLaunch, configPath, resultPath, resultSnapshot, summarizeResults, watchResults,
  completedConfig, scrubConfig, chatPrompt, siteChatPrompt,
};
