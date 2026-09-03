/**
 * اختبار عقد الجاهزية بحسب المحرك (أسبوع خطة العصف — البند الأول).
 * يغطّي electron/readiness.js النقي: الحالات الأربع التي اشترطها الحاجز المعتمد
 * (Codex جاهز/Claude غائب · والعكس · Kimi وحده · لا محرك مثبّت)، وقاعدة fail-open
 * عند تعذّر فحص المصادقة، وتبديل المحرك بعد فتح البوابة.
 * قطعي بالكامل: لا spawn ولا قرص ولا شبكة.
 * التشغيل: node scripts/readiness-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  ENGINES, ENGINE_IDS, normalizeState, engineState, isReady, deriveReadiness, pickEngineSwitch,
} = require('../electron/readiness');

let passed = 0;
function check(label, cond) {
  assert.ok(cond, 'فشل: ' + label);
  passed++;
  console.log('✓ ' + label);
}

// اختصارات لبناء حالات خام بلهجات المصادر الثلاثة الحقيقية
const missing = { installed: false };
const codexReady = { installed: true, auth: { ok: true, method: 'chatgpt' } };
const codexOut = { installed: true, auth: { ok: false, method: null } };
const claudeReady = { installed: true, loggedIn: true };
const claudeOut = { installed: true, loggedIn: false };
const installedUnknownAuth = { installed: true }; // مثبّت وتعذّر حسم المصادقة

// ---------- 1) الحالات الأربع في الحاجز المعتمد ----------

// (أ) العطل المُعالَج: Codex جاهز وClaude غائب ⇒ البوابة تفتح
{
  const r = deriveReadiness({ sdk: missing, codex: codexReady, 'kimi-code': missing });
  check('Codex جاهز/Claude غائب ⇒ البوابة تفتح', r.ready === true);
  check('Codex جاهز/Claude غائب ⇒ المفضّل codex', r.preferred === 'codex');
  check('Codex جاهز/Claude غائب ⇒ readyEngines = [codex]', r.readyEngines.join(',') === 'codex');
  const sdk = r.engines.find((e) => e.id === 'sdk');
  check('Claude الغائب يُوسم missing', sdk.state === 'missing');
  check('Claude الغائب يحمل أمر تثبيته', sdk.install.endsWith('install -g @anthropic-ai/claude-code'));
}

// (ب) العكس: Claude جاهز وCodex غائب ⇒ السلوك القائم يبقى كما هو
{
  const r = deriveReadiness({ sdk: claudeReady, codex: missing, 'kimi-code': missing });
  check('Claude جاهز/Codex غائب ⇒ البوابة تفتح', r.ready === true);
  check('Claude جاهز/Codex غائب ⇒ المفضّل sdk', r.preferred === 'sdk');
}

// (ج) Kimi Code وحده جاهز ⇒ يفتح أيضاً
{
  const r = deriveReadiness({ sdk: missing, codex: missing, 'kimi-code': { installed: true, auth: { ok: true, method: 'oauth' } } });
  check('Kimi وحده جاهز ⇒ البوابة تفتح', r.ready === true);
  check('Kimi وحده جاهز ⇒ المفضّل kimi-code', r.preferred === 'kimi-code');
}

// (د) لا محرك مثبّت ⇒ البوابة تبقى مغلقة (الحجب مشروع هنا وحده)
{
  const r = deriveReadiness({ sdk: missing, codex: missing, 'kimi-code': missing });
  check('لا محرك مثبّت ⇒ البوابة مغلقة', r.ready === false);
  check('لا محرك مثبّت ⇒ لا مفضّل', r.preferred === null);
  check('لا محرك مثبّت ⇒ readyEngines فارغة', r.readyEngines.length === 0);
  check('تُعرض المحركات الثلاثة كلها للإرشاد', r.engines.length === 3);
}

// ---------- 2) مثبّت لكنه غير مسجّل الدخول ----------
{
  const r = deriveReadiness({ sdk: claudeOut, codex: codexOut, 'kimi-code': missing });
  check('مثبّت + مصادقة منفيّة ⇒ logged_out لا ready', engineState(claudeOut) === 'logged_out');
  check('Codex مثبّت غير مسجّل ⇒ logged_out', engineState(codexOut) === 'logged_out');
  check('كل المحركات غير مسجّلة ⇒ البوابة مغلقة', r.ready === false);
  const codex = r.engines.find((e) => e.id === 'codex');
  check('غير المسجّل يحمل أمر تسجيل الدخول', codex.login === 'codex login');
  check('غير المسجّل موسوم مثبّتاً (فلا يُطلب تثبيته ثانيةً)', codex.installed === true);
}

// ---------- 3) fail-open: مثبّت وتعذّر فحص المصادقة ----------
// سلوك مقصود ومطابق لـgate.js القائم (authReady = ok && (!authChecked || loggedIn===true)):
// فحصٌ عاجز عن الحسم لا يحجب المستخدم.
{
  check('مثبّت + مصادقة غير محسومة ⇒ ready (fail-open)', isReady(installedUnknownAuth) === true);
  check('مصادقة غير محسومة تبقى null لا false', normalizeState(installedUnknownAuth).loggedIn === null);
  const r = deriveReadiness({ sdk: installedUnknownAuth, codex: missing, 'kimi-code': missing });
  check('مسبار عاجز وحده لا يغلق البوابة', r.ready === true);
}

// ---------- 4) الأفضلية عند تعدّد الجاهزين ----------
{
  const all = deriveReadiness({ sdk: claudeReady, codex: codexReady, 'kimi-code': { installed: true, auth: { ok: true } } });
  check('عند جهوز الجميع ⇒ المفضّل sdk (ترتيب الأفضلية)', all.preferred === 'sdk');
  check('عند جهوز الجميع ⇒ readyEngines بالترتيب', all.readyEngines.join(',') === 'sdk,codex,kimi-code');
  const noClaude = deriveReadiness({ sdk: claudeOut, codex: codexReady, 'kimi-code': { installed: true, auth: { ok: true } } });
  check('سقوط Claude ⇒ المفضّل codex لا kimi', noClaude.preferred === 'codex');
}

// ---------- 5) مدخلات فاسدة أو ناقصة ----------
{
  check('مدخل فارغ ⇒ بوابة مغلقة بلا انهيار', deriveReadiness().ready === false);
  check('مدخل غير كائن ⇒ بوابة مغلقة', deriveReadiness('nope').ready === false);
  check('محرك مفقود من المدخل ⇒ missing', deriveReadiness({}).engines.every((e) => e.state === 'missing'));
  check('حالة null ⇒ missing', engineState(null) === 'missing');
  check('installed غير منطقي ⇒ missing (لا تخمين)', engineState({ installed: 'yes' }) === 'missing');
  check('auth.ok غير منطقي ⇒ لا يُقرأ حسماً', normalizeState({ installed: true, auth: { ok: 'true' } }).loggedIn === null);
}

// ---------- 6) تبديل المحرك بعد فتح البوابة ----------
// من يملك Codex وحده يجب ألّا يبقى منتقيه على sdk فيفشل صامتاً عند أول طلب.
{
  const codexOnly = deriveReadiness({ sdk: missing, codex: codexReady, 'kimi-code': missing });
  check('اختيار sdk وCodex وحده جاهز ⇒ يُقترح codex', pickEngineSwitch('sdk', codexOnly) === 'codex');
  check('اختيار codex وهو جاهز ⇒ لا تبديل', pickEngineSwitch('codex', codexOnly) === null);
  const allReady = deriveReadiness({ sdk: claudeReady, codex: codexReady, 'kimi-code': missing });
  check('اختيار جاهز أصلاً ⇒ لا تبديل', pickEngineSwitch('sdk', allReady) === null);
  const none = deriveReadiness({ sdk: missing, codex: missing, 'kimi-code': missing });
  check('لا جاهز ⇒ لا تبديل (لا نلمس اختيار المستخدم)', pickEngineSwitch('sdk', none) === null);
  // محوّلات REST تعتمد مفاتيح API لا ثنائيات — خارج عقد الجاهزية فلا تُبدَّل
  check('اختيار gemini (محوّل REST) لا يُبدَّل', pickEngineSwitch('gemini', codexOnly) === null);
  check('اختيار cli لا يُبدَّل', pickEngineSwitch('cli', codexOnly) === null);
  check('اختيار فاسد لا يُبدَّل', pickEngineSwitch(null, codexOnly) === null);
  check('لقطة فاسدة ⇒ لا تبديل', pickEngineSwitch('sdk', null) === null);
}

// ---------- 7) ثبات العقد ----------
{
  check('المحركات الثلاثة بمعرّفاتها المتوقّعة', ENGINE_IDS.join(',') === 'sdk,codex,kimi-code');
  check('كل محرك يحمل أمر تثبيت غير فارغ', ENGINES.every((e) => typeof e.install === 'string' && e.install.length > 0));
  check('كل محرك يحمل أمر تسجيل دخول غير فارغ', ENGINES.every((e) => typeof e.login === 'string' && e.login.length > 0));
  check('كل محرك يحمل تسمية معروضة', ENGINES.every((e) => typeof e.label === 'string' && e.label.length > 0));
  check('أمر تثبيت Codex يحمل الحزمة الصحيحة', ENGINES[1].install.endsWith('install -g @openai/codex'));
  check('أمر تثبيت Kimi مطابق للموثّق في app.js', ENGINES[2].install.includes('code.kimi.com/kimi-code/install.ps1'));

  // ---------- npm.cmd لا npm العارية (عطل مُعاد إنتاجه 2026-08-28) ----------
  // في PowerShell يسبق `npm.ps1` ملفَّ `npm.cmd` في ترتيب الأوامر، و`ExecutionPolicy`
  // الافتراضية لعميل ويندوز (`Restricted`) تحجب السكربتات لا الملفات الدفعية. قياس حيّ:
  //   npm --version      ⇒ npm.ps1 cannot be loaded because running scripts is disabled
  //   npm.cmd --version  ⇒ 11.17.0
  // فالأمر يفشل حتى وهو منسوخ بيد المستخدم، وأسوأُ منه أن `enginesupdate` **ينفّذه**
  // في طرفية PowerShell فيفشل الزرّ صامتاً. الحارس على **كل** ما نعرضه أو ننفّذه.
  const BARE_NPM = /(^|[^.\w])npm\s+(i|install)\s/;
  if (process.platform === 'win32') {
    check('أوامر التثبيت تستعمل npm.cmd على ويندوز',
      ENGINES.filter((e) => /npm/.test(e.install)).every((e) => e.install.startsWith('npm.cmd ')),
      ENGINES.map((e) => e.install).join(' | '));
    const eu = require(path.join(ROOT, 'electron', 'enginesupdate.js'));
    check('وأوامر التحديث المنفَّذة كذلك (وهي تُشغَّل فعلاً في طرفية PowerShell)',
      eu.ENGINES.filter((e) => e.channel === 'npm').every((e) => e.command.startsWith('npm.cmd ')),
      eu.ENGINES.map((e) => e.command).join(' | '));
  }
  // ولا `npm` عارية في أي نصّ يصل المستخدم — البحث على الملفات الشاحنة كلها
  for (const rel of ['electron/readiness.js', 'electron/enginesupdate.js', 'electron/codex.js',
    'src/ui/app.js', 'src/ui/components/gate.js']) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const offenders = body.split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((x) => BARE_NPM.test(x.line) && !/^\s*(\/\/|\*)/.test(x.line) && !x.line.includes('npm.cmd'));
    check('لا أمر npm عارٍ في ' + rel, offenders.length === 0,
      offenders.map((x) => x.no + ': ' + x.line.slice(0, 70)).join(' · '));
  }
  check('العقد مجمَّد ضد التعديل العابر', Object.isFrozen(ENGINES) && Object.isFrozen(ENGINES[0]));
  // لقطة الجاهزية لا تحمل مساراً مطلقاً ولا رمزاً — تعبر IPC إلى renderer
  const snapshot = JSON.stringify(deriveReadiness({ sdk: claudeReady, codex: codexReady, 'kimi-code': missing }));
  check('اللقطة بلا مسار ويندوز مطلق', !/[A-Za-z]:\\\\/.test(snapshot));
  check('اللقطة بلا حقول token/key', !/token|apiKey|api_key|secret/i.test(snapshot));
}

// ---------- 8) المفتاح المحفوظ بوابة بديلة بلا اشتراك ----------
{
  const noneRaw = { sdk: missing, codex: missing, 'kimi-code': missing };
  const providers = [
    { name: 'groq', label: 'Groq — مفتاح API مجاني' },
    { name: 'nvidia', label: 'NVIDIA NIM — مفتاح API مجاني' },
  ];
  const providerOnly = deriveReadiness(noneRaw, { keyProviders: providers });
  check('مزوّد REST بمفتاح محفوظ يفتح البوابة', providerOnly.ready === true);
  check('غياب الأصيل يجعل أول مزوّد ذي مفتاح هو المفضّل', providerOnly.preferred === 'groq');
  check('keyProviders تحفظ ترتيب الوصول', providerOnly.keyProviders.map((p) => p.name).join(',') === 'groq,nvidia');
  check('keyProviders لا تعيد حقلاً غير name/label',
    Object.keys(providerOnly.keyProviders[0]).join(',') === 'name,label');

  const nativeAndProvider = deriveReadiness(
    { sdk: missing, codex: codexReady, 'kimi-code': missing },
    { keyProviders: providers });
  check('المحرك الأصيل الجاهز يبقى مفضّلاً على مزوّد المفتاح', nativeAndProvider.preferred === 'codex');

  // الحالات الأربع لعقد تصحيح المنتقي: بديل مفتاح، بديل أصيل، اختيار مفتاح، وخارج العقد.
  check('اختيار أصيل غير جاهز + لا أصيل جاهز + مفتاح ⇒ أول مزوّد',
    pickEngineSwitch('sdk', providerOnly) === 'groq');
  check('اختيار أصيل غير جاهز + أصيل جاهز + مفتاح ⇒ الأصيل أولاً',
    pickEngineSwitch('sdk', nativeAndProvider) === 'codex');
  check('اختيار مزوّد له مفتاح لا يُبدّل من تحت المستخدم',
    pickEngineSwitch('groq', providerOnly) === null);
  check('اختيار REST غير مذكور لا يُبدّل من تحت المستخدم',
    pickEngineSwitch('gemini', providerOnly) === null);

  const oldCall = deriveReadiness(noneRaw);
  check('غياب المعامل الثاني يحفظ قرار العقد القديم حرفياً',
    oldCall.ready === false && oldCall.preferred === null && oldCall.readyEngines.length === 0);
  check('غياب المعامل الثاني يضيف keyProviders فارغة فقط',
    Array.isArray(oldCall.keyProviders) && oldCall.keyProviders.length === 0);
}

console.log('\nالنتيجة: ' + passed + '/' + passed + ' ناجحة.');
