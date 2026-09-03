/**
 * اختبار عقد الجاهزية بحسب المحرك (أسبوع خطة العصف — البند الأول).
 * طبقتان:
 * 1) `electron/readiness.js` النقي: الحالات الأربع التي اشترطها الحاجز المعتمد
 *    (Codex جاهز/Claude غائب · والعكس · Kimi وحده · لا محرك مثبّت)، وقاعدة fail-open
 *    عند تعذّر فحص المصادقة، والمفتاح المحفوظ بوابةً بديلة.
 * 2) مبدّل المحرك بعد فتح البوابة **مستخرَجاً من `src/ui/app.js` وقت التشغيل**
 *    (`applyGateEngineSwitch` — نمط منتقي الجهد في claude-models-test ومنطق تنبيه git
 *    في gitdiff-test) داخل DOM مصغّر: الدالة الإنتاجية نفسها لا نسخة نقية موازية
 *    (‏OBS-076)، ومعها قيد `<select>` الذي لا تعرفه دالة نقية، وتوصيلها في موضعيها.
 * قطعي بالكامل: لا spawn ولا قرص ولا شبكة.
 * التشغيل: node scripts/readiness-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const {
  ENGINES, ENGINE_IDS, normalizeState, engineState, isReady, deriveReadiness,
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

// ---------- مبدّل المحرك الفعلي مستخرَجاً من app.js (‏OBS-076) ----------
// كانت هنا دالة نقية `readiness.pickEngineSwitch` مغطّاة باثني عشر فحصاً وبلا مستدعٍ
// واحد في الإنتاج، بينما التبديل الفعلي يجري في `applyGateEngineSwitch` داخل
// `src/ui/app.js` بلا تغطية — فالمُختبَر هو غير المستعمل، ومصدرا حقيقة يتباعدان بصمت.
// وهما ليستا متكافئتين: الحقيقية تقيّد البديل بما هو **موجود فعلاً في `<select>`**
// (‏kimi-code قد لا يكون معروضاً بعد لأن `loadProviders` غير متزامنة مع `gate-ready`)،
// وهو قيد DOM لا تعرفه دالة نقية. فحُذفت النقية، وصار الحارس يستخرج الحقيقية وقت
// التشغيل ويشغّلها في DOM مصغّر — نمط منتقي الجهد في `claude-models-test.js` ومنطق
// تنبيه git في `gitdiff-test.js`: أي انحراف في الكود الإنتاجي يكسر الاختبار بدل أن يمرّ.
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
const GATE_SWITCH_SOURCE = (() => {
  const start = APP_SOURCE.indexOf('  // المحركات التي يحكمها عقد الجاهزية');
  const end = APP_SOURCE.indexOf('  // ---------- بوابة أول التشغيل:', start);
  assert.ok(start >= 0 && end > start, 'تعذّر استخراج مبدّل المحرك من app.js');
  return APP_SOURCE.slice(start, end);
})();

// <select> بدلالة HTML: إسناد قيمة بلا خيار مقابل يفرغ الحقل بدل أن يُقبل صامتاً،
// فينكشف أي تبديل إلى معرّف غير معروض في القائمة.
class FakeSelect {
  constructor(options, selected) {
    this.options = (options || []).map((option) => (typeof option === 'string'
      ? { value: option, textContent: option }
      : { value: option.value, textContent: option.label }));
    this.changeEvents = [];
    this.value = selected;
  }
  dispatchEvent(event) { this.changeEvents.push(event && event.type); return true; }
}
Object.defineProperty(FakeSelect.prototype, 'value', {
  get() { return this._value || ''; },
  set(next) { this._value = (this.options || []).some((option) => option.value === next) ? next : ''; },
});

// بيئة تشغيل مستقلة لكل سيناريو: منتقي محرك مزيّف + localStorage + جامع إشعارات.
// `readyEngines`/`preferred` يُحقنان بالقيمتين اللتين يضعهما مستمع gate-ready؛ وغيابهما
// من السيناريو يترك `gateReadyEngines` على null — أي ما قبل حسم الفحص.
function makeGateSwitch(scenario) {
  const select = new FakeSelect(scenario.engineOptions, scenario.selected);
  const notices = [];
  const store = new Map();
  if (typeof scenario.selected === 'string') store.set('satr_engine', scenario.selected);
  const sandbox = {
    exported: {},
    notices,
    elements: { engine: select },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
    Event: class { constructor(type) { this.type = type; } },
  };
  vm.runInNewContext(`
    const $ = (id) => elements[id];
    const addNotice = (text) => { notices.push(text); };
    ${GATE_SWITCH_SOURCE}
    exported.apply = applyGateEngineSwitch;
    exported.setGate = (ready, preferred) => { gateReadyEngines = ready; gatePreferred = preferred; };
    exported.GATED_ENGINES = GATED_ENGINES;
  `, sandbox, { filename: 'ui-gate-engine-switch-extract.js' });
  if (Object.prototype.hasOwnProperty.call(scenario, 'readyEngines')) {
    sandbox.exported.setGate(scenario.readyEngines,
      typeof scenario.preferred === 'string' ? scenario.preferred : null);
  }
  return Object.assign(sandbox.exported, { select, notices, store });
}

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

// ---------- 6) تبديل المحرك بعد فتح البوابة — الدالة الإنتاجية نفسها ----------
// من يملك Codex وحده يجب ألّا يبقى منتقيه على sdk فيفشل صامتاً عند أول طلب.
// المُختبَر هنا `applyGateEngineSwitch` المستخرجة من app.js حرفياً لا نسخة موازية،
// ولقطات `deriveReadiness` أعلاه هي مصدر readyEngines/preferred كما في الإنتاج.
{
  const ENGINE_OPTIONS = [
    { value: 'sdk', label: 'Claude — اشتراك Claude Code' },
    { value: 'codex', label: 'Codex — اشتراك ChatGPT' },
    { value: 'kimi-code', label: 'Kimi Code — اشتراك' },
    { value: 'gemini', label: 'Gemini — مفتاح API' },
    { value: 'cli', label: 'Claude CLI — احتياطي' },
  ];
  const codexOnly = deriveReadiness({ sdk: missing, codex: codexReady, 'kimi-code': missing });
  const gate = (extra) => makeGateSwitch(Object.assign({
    engineOptions: ENGINE_OPTIONS,
    readyEngines: codexOnly.readyEngines,
    preferred: codexOnly.preferred,
  }, extra));

  // (أ) العطل الأصلي: sdk مختار وCodex وحده جاهز ⇒ تبديل فعلي بأثره الكامل
  const switched = gate({ selected: 'sdk' });
  switched.apply();
  check('اختيار sdk وCodex وحده جاهز ⇒ يُبدَّل المنتقي إلى codex', switched.select.value === 'codex');
  check('التبديل يحفظ الاختيار الجديد في localStorage', switched.store.get('satr_engine') === 'codex');
  check('التبديل يطلق حدث change (يعيد بناء النماذج والأوامر بالمسار القائم)',
    switched.select.changeEvents.join(',') === 'change');
  check('التبديل يعرض رسالة عربية تسمّي المحرك القديم والجديد',
    switched.notices.length === 1 && switched.notices[0].includes('بُدِّل المحرك')
    && switched.notices[0].includes('Claude Code') && switched.notices[0].includes('Codex'));

  // (ب) idempotent: تُستدعى من gate-ready ومن نهاية loadProviders لأن ترتيبهما غير
  // مضمون، فالنداء الثاني يجب أن يكون بلا أثر — والتعليق في app.js يدّعي ذلك.
  switched.apply();
  check('نداء ثانٍ بلا تبديل ولا رسالة مكرّرة (idempotent)',
    switched.select.value === 'codex' && switched.notices.length === 1
    && switched.select.changeEvents.length === 1);

  // (ج) الاختيار جاهز أصلاً ⇒ لا يُلمس
  const already = gate({ selected: 'codex' });
  already.apply();
  check('اختيار codex وهو جاهز ⇒ لا تبديل ولا رسالة',
    already.select.value === 'codex' && already.notices.length === 0
    && already.select.changeEvents.length === 0);
  const allReady = deriveReadiness({ sdk: claudeReady, codex: codexReady, 'kimi-code': missing });
  const sdkReady = gate({ selected: 'sdk', readyEngines: allReady.readyEngines, preferred: allReady.preferred });
  sdkReady.apply();
  check('اختيار sdk وهو ضمن الجاهزين ⇒ لا تبديل',
    sdkReady.select.value === 'sdk' && sdkReady.notices.length === 0);
  // والأدقّ: جاهزٌ مختار ليس أوّل الجاهزين ترتيباً لا يُنتزع لصالح الأسبق. هذه هي
  // وظيفة حارس `gateReadyEngines.includes(current)`، وبلا هذا الفحص يمرّ إسقاطه صامتاً.
  const notFirst = gate({ selected: 'codex', readyEngines: allReady.readyEngines, preferred: allReady.preferred });
  notFirst.apply();
  check('اختيار codex جاهز وsdk أسبق منه ترتيباً ⇒ لا يُنتزع اختيار المستخدم',
    notFirst.select.value === 'codex' && notFirst.notices.length === 0);

  // (د) لا جاهز ولا مفضّل ⇒ لا نلمس اختيار المستخدم
  const none = deriveReadiness({ sdk: missing, codex: missing, 'kimi-code': missing });
  const nothing = gate({ selected: 'sdk', readyEngines: none.readyEngines, preferred: none.preferred });
  nothing.apply();
  check('لا محرك جاهز ولا مفضّل ⇒ لا تبديل (لا نلمس اختيار المستخدم)',
    nothing.select.value === 'sdk' && nothing.notices.length === 0
    && nothing.store.get('satr_engine') === 'sdk');

  // (هـ) محوّلات REST وcli خارج GATED_ENGINES — لها مسار مفاتيحها الخاص
  for (const outside of ['gemini', 'cli']) {
    const rest = gate({ selected: outside });
    rest.apply();
    check('اختيار ' + outside + ' خارج عقد الجاهزية ⇒ لا يُبدَّل',
      rest.select.value === outside && rest.notices.length === 0);
  }

  // (و) **قيد DOM الحصري**: المرشّح جاهز لكن القائمة لم تعرضه بعد (‏loadProviders لم
  // تنتهِ) ⇒ لا تبديل. هذا ما لا تعرفه دالة نقية، وهو مبرّر استخراج الحقيقية بدلاً منها.
  const kimiOnly = deriveReadiness({ sdk: missing, codex: missing, 'kimi-code': { installed: true, auth: { ok: true } } });
  const hidden = gate({
    selected: 'sdk',
    engineOptions: [ENGINE_OPTIONS[0], ENGINE_OPTIONS[1]], // القائمة قبل وصول المزوّدين
    readyEngines: kimiOnly.readyEngines,
    preferred: kimiOnly.preferred,
  });
  hidden.apply();
  check('مرشّح جاهز غير معروض في <select> ⇒ لا تبديل ولا رسالة',
    hidden.select.value === 'sdk' && hidden.notices.length === 0
    && hidden.select.changeEvents.length === 0);
  check('ولا يُكتب اختيار غير معروض في localStorage', hidden.store.get('satr_engine') === 'sdk');
  // ضبط موجب: السيناريو نفسه والقائمة تحوي kimi-code ⇒ يُبدَّل فعلاً، فالفحص أعلاه
  // سقط للسبب الصحيح (غياب الخيار) لا لسبب آخر.
  const shown = gate({ selected: 'sdk', readyEngines: kimiOnly.readyEngines, preferred: kimiOnly.preferred });
  shown.apply();
  check('وحين تحوي القائمة kimi-code ⇒ يُبدَّل (ضبط موجب للقيد أعلاه)',
    shown.select.value === 'kimi-code' && shown.notices.length === 1);

  // (ز) ما قبل حسم الفحص: gateReadyEngines = null ⇒ لا شيء إطلاقاً
  const unresolved = makeGateSwitch({ selected: 'sdk', engineOptions: ENGINE_OPTIONS });
  unresolved.apply();
  check('قبل وصول gate-ready (‏gateReadyEngines = null) ⇒ لا تبديل ولا رسالة',
    unresolved.select.value === 'sdk' && unresolved.notices.length === 0);

  // (ح) عقد واحد لا عقدان: قائمة app.js المحكومة تطابق ENGINE_IDS في readiness.js
  check('GATED_ENGINES في app.js تطابق ENGINE_IDS في readiness.js',
    switched.GATED_ENGINES.join(',') === ENGINE_IDS.join(','));
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

  // مسار المفتاح في الدالة الإنتاجية نفسها: أربع حالات + قيد DOM.
  const KEY_OPTIONS = [
    { value: 'sdk', label: 'Claude — اشتراك Claude Code' },
    { value: 'codex', label: 'Codex — اشتراك ChatGPT' },
    { value: 'groq', label: 'Groq — مفتاح API مجاني' },
    { value: 'gemini', label: 'Gemini — مفتاح API' },
  ];
  const keyGate = (selected, snapshot, options) => makeGateSwitch({
    selected, engineOptions: options || KEY_OPTIONS,
    readyEngines: snapshot.readyEngines, preferred: snapshot.preferred,
  });

  const toKey = keyGate('sdk', providerOnly);
  toKey.apply();
  check('اختيار أصيل غير جاهز + لا أصيل جاهز + مفتاح ⇒ يُبدَّل إلى أول مزوّد',
    toKey.select.value === 'groq' && toKey.store.get('satr_engine') === 'groq');
  check('ورسالة المزوّد تأخذ تسميته المعروضة من القائمة (لا معرّفه الخام)',
    toKey.notices.length === 1 && toKey.notices[0].includes('Groq — مفتاح API مجاني'));

  const nativeFirst = keyGate('sdk', nativeAndProvider);
  nativeFirst.apply();
  check('اختيار أصيل غير جاهز + أصيل جاهز + مفتاح ⇒ الأصيل أولاً',
    nativeFirst.select.value === 'codex');

  const keySelected = keyGate('groq', providerOnly);
  keySelected.apply();
  check('اختيار مزوّد له مفتاح لا يُبدّل من تحت المستخدم',
    keySelected.select.value === 'groq' && keySelected.notices.length === 0);

  const unlistedRest = keyGate('gemini', providerOnly);
  unlistedRest.apply();
  check('اختيار REST غير مذكور في keyProviders لا يُبدّل كذلك',
    unlistedRest.select.value === 'gemini' && unlistedRest.notices.length === 0);

  // قيد DOM نفسه ينطبق على مسار المفتاح: مزوّد لم تعرضه القائمة بعد لا يُبدَّل إليه
  const keyHidden = keyGate('sdk', providerOnly, [KEY_OPTIONS[0], KEY_OPTIONS[1]]);
  keyHidden.apply();
  check('مزوّد المفتاح غير المعروض في القائمة ⇒ لا تبديل',
    keyHidden.select.value === 'sdk' && keyHidden.notices.length === 0);

  const oldCall = deriveReadiness(noneRaw);
  check('غياب المعامل الثاني يحفظ قرار العقد القديم حرفياً',
    oldCall.ready === false && oldCall.preferred === null && oldCall.readyEngines.length === 0);
  check('غياب المعامل الثاني يضيف keyProviders فارغة فقط',
    Array.isArray(oldCall.keyProviders) && oldCall.keyProviders.length === 0);
}

// ---------- 9) توصيل المبدّل في app.js (موضعا الاستدعاء) ----------
// idempotency في (6-ب) ليست ترفاً: الدالة تُستدعى من موضعين لأن ترتيبهما غير مضمون.
{
  // استدعاء **فعلي** لا ذكراً في تعليق: سطر معطَّل بـ// كان يمرّ لو اكتفينا بـincludes
  // (رُصد أثناء إثبات أن الحارس يعضّ)، فنشترط بداية السطر بعد الفراغ البادئ.
  const CALL_LINE = /^[ \t]*applyGateEngineSwitch\(\);/m;
  const gateReadyBlock = APP_SOURCE.slice(
    APP_SOURCE.indexOf("document.querySelector('satr-gate').addEventListener('gate-ready'"),
    APP_SOURCE.indexOf('  // بناء قائمة «المحرك» ديناميكياً'));
  const gateReadyCall = gateReadyBlock.search(CALL_LINE);
  check('مستمع gate-ready يستدعي applyGateEngineSwitch فعلاً (لا في تعليق)', gateReadyCall >= 0);
  check('ويملأ gateReadyEngines وgatePreferred قبل الاستدعاء',
    gateReadyBlock.includes('gatePreferred =')
    && gateReadyBlock.indexOf('gateReadyEngines = readyList') >= 0
    && gateReadyBlock.indexOf('gateReadyEngines = readyList') < gateReadyCall);
  const providersBlock = APP_SOURCE.slice(
    APP_SOURCE.indexOf('  async function loadProviders() {'),
    APP_SOURCE.indexOf('  let lastEngine = null;'));
  check('نهاية loadProviders تستدعي applyGateEngineSwitch (ترتيب async غير مضمون)',
    CALL_LINE.test(providersBlock));
  // ولا تعود نسخة ثانية من منطق التبديل إلى العملية الرئيسية (‏OBS-076)
  check('لا مبدّل موازٍ في electron/readiness.js',
    !fs.readFileSync(path.join(ROOT, 'electron', 'readiness.js'), 'utf8').includes('pickEngineSwitch'));
}

console.log('\nالنتيجة: ' + passed + '/' + passed + ' ناجحة.');
