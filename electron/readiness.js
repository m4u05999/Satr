'use strict';

// عقد الجاهزية بحسب المحرك — أسبوع خطة العصف، البند الأول (قرار 2026-08-23).
//
// العطل المُعالَج: بوابة أول التشغيل كانت تشترط Claude Code وحده (gate.js + preflight)،
// فمن يملك Codex أو Kimi Code جاهزاً يُحجب عن التطبيق كله بلا سبب تقني — بينما
// `satr:codexStatus` و`satr:kimiStatus` قائمان أصلاً ولا أحد يسألهما عند الإقلاع.
//
// هذه وحدة **منطق نقي بلا تبعيات** (نمط autogate.js/browserguard.js): تستقبل حالات خام
// جمعها main.js من المسابير القائمة (claudeauth.probe · codex.accountStatus ·
// kimi.authStatus) وتشتق منها الجاهزية. لا spawn ولا قرص ولا Electron هنا، فيبقى
// الاختبار قطعياً وسريعاً وقابلاً للتشغيل بـnode وحده.
//
// **قاعدة الجاهزية** — مشتقّة من سلوك Claude القائم في preflight حرفياً، لا مخترعة:
//   غير مثبّت                    ⇒ 'missing'    (الإرشاد: ثبّت)
//   مثبّت + مصادقة منفيّة        ⇒ 'logged_out' (الإرشاد: سجّل الدخول)
//   مثبّت + مصادقة مؤكّدة        ⇒ 'ready'
//   مثبّت + تعذّر فحص المصادقة   ⇒ 'ready'      (fail-open مقصود)
//
// لماذا fail-open عند تعذّر الفحص؟ لأنه سلوك Claude اليوم: `authReady` في gate.js هي
// `claudeOk && (!authChecked || loggedIn === true)`. فحصٌ عاجز عن الحسم لا يجوز أن
// يتحوّل إلى حجب — وإلا حجبنا مستخدماً جاهزاً بسبب مسبار فشل. الحدّ الأمني الحقيقي
// ليس هنا: المحرك نفسه يرفض الطلب إن لم تكن المصادقة صالحة، والرفض حينها صريح
// ومفهوم، بخلاف باب مقفل بلا تفسير.

// ترتيب المصفوفة هو ترتيب الأفضلية عند اختيار محرك افتراضي: Claude أولاً (المسار
// الأنضج والأكثر تغطيةً في «سطر»)، ثم Codex، ثم Kimi Code.
// أوامر التثبيت منقولة من مواضعها المعتمدة في المستودع لا مخترعة:
//   sdk       ← gate.js (INSTALL_CMD القائم)
//   codex     ← codex.js:809 وapp.js:1597
//   kimi-code ← app.js:1648
const ENGINES = Object.freeze([
  Object.freeze({
    id: 'sdk',
    label: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
  }),
  Object.freeze({
    id: 'kimi-code',
    label: 'Kimi Code',
    install: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    login: 'kimi login',
  }),
]);

const ENGINE_IDS = Object.freeze(ENGINES.map((engine) => engine.id));

// تطبيع مدخل محرك واحد إلى شكل منطقي واحد. المصادر الثلاثة تتكلم لهجات مختلفة:
//   claude ← { ok, authChecked, loggedIn }
//   codex  ← { installed, auth: { ok, method } }
//   kimi   ← { installed, auth: { ok, method } }
// فنجمعها هنا في `{ installed, loggedIn }` حيث loggedIn منطقي أو null لتعذّر الفحص.
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return { installed: false, loggedIn: null };
  const installed = raw.installed === true;
  if (!installed) return { installed: false, loggedIn: null };
  // `loggedIn` صريح يفوز؛ وإلا نشتقّه من غلاف auth. غياب الحسم يبقى null (لا نخمّن).
  let loggedIn = null;
  if (typeof raw.loggedIn === 'boolean') loggedIn = raw.loggedIn;
  else if (raw.auth && typeof raw.auth === 'object' && typeof raw.auth.ok === 'boolean') loggedIn = raw.auth.ok;
  return { installed: true, loggedIn };
}

// حالة محرك واحد: 'missing' | 'logged_out' | 'ready'
function engineState(raw) {
  const state = normalizeState(raw);
  if (!state.installed) return 'missing';
  return state.loggedIn === false ? 'logged_out' : 'ready';
}

function isReady(raw) {
  return engineState(raw) === 'ready';
}

// اشتقاق لقطة الجاهزية الكاملة من حالات المحركات الخام.
// `raw` كائن مفاتيحه معرّفات المحركات؛ المحرك الغائب عنه يُعامل «غير مثبّت» (fail-closed
// في الوصف لا في الحجب — لأن الحجب يقع فقط إن لم يجهز **أي** محرك).
function deriveReadiness(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const engines = ENGINES.map((engine) => {
    const state = normalizeState(source[engine.id]);
    return {
      id: engine.id,
      label: engine.label,
      installed: state.installed,
      loggedIn: state.loggedIn,
      state: engineState(source[engine.id]),
      install: engine.install,
      login: engine.login,
    };
  });
  const readyEngines = engines.filter((engine) => engine.state === 'ready').map((engine) => engine.id);
  return {
    engines,
    ready: readyEngines.length > 0,
    readyEngines,
    // المحرك المفضّل = أول جاهز بترتيب الأفضلية أعلاه. null حين لا شيء جاهز.
    preferred: readyEngines.length > 0 ? readyEngines[0] : null,
  };
}

// هل يحتاج المستخدم إلى تبديل محرك؟ يُستدعى بعد فتح البوابة: إن كان اختياره المحفوظ
// غير جاهز بينما يوجد جاهز غيره، نعيد المرشّح كي تبدّل القشرة إليه وتُعلمه صراحةً.
// عدم وجود بديل — أو كون المختار جاهزاً — يعيد null فلا تلمس القشرة اختيار المستخدم.
// ملاحظة: المحركات غير المذكورة هنا (gemini وبقية محوّلات REST) تعتمد مفاتيح API لا
// ثنائيات مثبّتة، فلا تدخل عقد الجاهزية ولا نبدّلها من تحت المستخدم.
function pickEngineSwitch(selected, readiness) {
  const snapshot = readiness && typeof readiness === 'object' ? readiness : {};
  const readyEngines = Array.isArray(snapshot.readyEngines) ? snapshot.readyEngines : [];
  if (!readyEngines.length) return null;
  // اختيار خارج عقد الجاهزية (محوّل REST مثلاً) لا يُبدَّل — له مسار مفاتيحه الخاص.
  if (typeof selected !== 'string' || !ENGINE_IDS.includes(selected)) return null;
  if (readyEngines.includes(selected)) return null;
  return readyEngines[0];
}

module.exports = { ENGINES, ENGINE_IDS, normalizeState, engineState, isReady, deriveReadiness, pickEngineSwitch };
