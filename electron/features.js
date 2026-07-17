/**
 * طبقة القدرات (feature-flags) + المُحمِّل الشرطي لطبقة Enterprise.
 *
 * حجر أساس نموذج «النواة + Enterprise إضافي» (docs/ARCHITECTURE.md §4.1 و §4.4):
 *  - النواة (Community) تعمل **كاملة** إن غاب مجلد `enterprise/` (البناء المجتمعي يستثنيه).
 *  - إن وُجد `enterprise/`، يُحمَّل ويُمرَّر له «نقاط الربط» (seams) ليسجّل قدراته — دون أن
 *    تعرف النواة شيئاً عن داخله (لا require صريح من النواة إلى enterprise).
 *
 * القاعدة الصارمة: أي فشل في تحميل/تسجيل Enterprise **لا يُسقط النواة** إطلاقاً.
 *
 * نقاط الربط المتاحة (الدفعة 3 وسّعتها — كلٌّ موثّقة في ARCHITECTURE.md §4):
 *  - setFlag (§4.4)            — الترخيص يفعّل القدرات
 *  - registerProvider (§4.2)   — حقن مزوّدين إضافيين في سجلّ المحوّلات (vLLM/خاص)
 *  - openaiCompatible (§4.2)   — مصنع البروتوكول نفسه (صفر تكرار للمزوّدين)
 *  - registerIpc (§4.5)        — معالجات IPC إضافية بقنوات `satr:ee:` حصراً
 *  - subscribe (§4.7)          — مجرى مراقبة أحداث «سطر» (للتدقيق والاستهلاك)
 */

// electron قد لا تتوفر خارج العملية الرئيسية (اختبارات node النقية) — تحميل دفاعي
let ipcMain = null;
try { ({ ipcMain } = require('electron')); } catch (e) { ipcMain = null; }
const adapters = require('./adapters');
const openaiCompatible = require('./adapters/openai-compatible');
const packageJson = require('../package.json');

// هوية البناء مستقلة عن نجاح تحميل الوحدة أو صلاحية الترخيص. يحقنها بناء Enterprise
// في package.json المحزوم؛ غيابها يعني Community دائماً.
const buildEdition = packageJson.satrEdition === 'enterprise' ? 'enterprise' : 'community';

// خريطة الأعلام: اسم القدرة → مُفعّلة؟ (غياب الاسم = معطّلة، فالمجتمعية تُخفي قدرات Enterprise)
const flags = new Map();

let enterprise = null;   // مرجع وحدة Enterprise إن حُمِّلت، وإلا null (بناء مجتمعي)
let started = false;     // منع التهيئة المزدوجة
let runtimeStatus = buildEdition === 'enterprise' ? 'not_initialized' : 'community';

// مشتركو مجرى المراقبة (§4.7): يستقبلون أحداث «سطر» المطبَّعة + أحداث النواة الوصفية
// (prompt/permission_reply). كل مشترك معزول — استثناؤه لا يكسر البث.
const subscribers = [];

// إعلام المشتركين بحدث (تستدعيه النواة من مواضع البث في main.js) — رخيص عند عدم وجودهم
function notify(ev, meta) {
  if (!subscribers.length) return;
  for (const fn of subscribers) {
    try { fn(ev, meta || {}); } catch (e) { /* عزل: مراقب معطوب لا يكسر الدور */ }
  }
}

// نقاط الربط المُمرَّرة لـ Enterprise عند التسجيل
function buildSeams() {
  return {
    // §4.4: يفعّل/يعطّل علماً (يستدعيه Enterprise بعد التحقق من الترخيص)
    setFlag: (name, on) => { flags.set(String(name), !!on); },

    // §4.2: تسجيل مزوّد في سجلّ المحوّلات — بلا لمس ملفات النواة
    registerProvider: (name, adapter, meta) => adapters.register(name, adapter, meta),

    // §4.2 (مكمّل): مصنع البروتوكول المتوافق مع OpenAI — يرث حلقة الوكيل كاملة
    // (أدوات + أذونات عربية + ذاكرة). تبني المزوّدات فوقه بلا سطر مكرّر.
    openaiCompatible,

    // §4.5: معالجات IPC إضافية — قنوات `satr:ee:` حصراً (لا تصادم مع قنوات النواة)
    registerIpc: (channel, handler) => {
      const ch = String(channel);
      if (!/^satr:ee:[a-zA-Z0-9_-]{1,64}$/.test(ch)) throw new Error('قناة Enterprise يجب أن تبدأ بـ satr:ee:');
      if (typeof handler !== 'function') throw new Error('معالج غير صالح');
      if (ipcMain && ipcMain.handle) ipcMain.handle(ch, handler); // خارج electron (اختبار node): تجاهل آمن
    },

    // §4.7: الاشتراك في مجرى مراقبة الأحداث (تدقيق/استهلاك) — يعيد دالة إلغاء
    subscribe: (fn) => {
      if (typeof fn !== 'function') throw new Error('مشترك غير صالح');
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  };
}

// تهيئة الطبقة عند إقلاع «سطر». تُستدعى مرة واحدة من main.js.
function init() {
  if (started) return { loaded: !!enterprise, edition: buildEdition, status: runtimeStatus };
  started = true;
  try {
    // يُحمَّل فقط إن وُجد المجلد؛ البناء المجتمعي يستثني enterprise/ فيفشل require بهدوء
    enterprise = require('../enterprise');
  } catch (e) {
    enterprise = null; // بناء مجتمعي: لا Enterprise — النواة تكمل وحدها
    runtimeStatus = buildEdition === 'enterprise' ? 'module_unavailable' : 'community';
  }
  if (enterprise && typeof enterprise.register === 'function') {
    try {
      enterprise.register(buildSeams());
      runtimeStatus = 'ready';
    } catch (e) {
      // تسجيل Enterprise فشل — نعزله ولا نُسقط النواة
      enterprise = null;
      flags.clear();
      subscribers.length = 0;
      runtimeStatus = 'registration_failed';
    }
  } else if (enterprise) {
    enterprise = null;
    runtimeStatus = buildEdition === 'enterprise' ? 'invalid_module' : 'community';
  }
  return { loaded: !!enterprise, edition: buildEdition, status: runtimeStatus };
}

// هل القدرة مُفعّلة؟ (غير المعروفة = false — النواة آمنة افتراضياً)
function enabled(name) {
  return flags.get(String(name)) === true;
}

// هل نعمل ضمن بناء Enterprise (حُمِّل ونُجح تسجيله)؟
function isEnterprise() {
  return !!enterprise;
}

function edition() {
  return buildEdition;
}

// لقطة للواجهة عبر IPC: تُظهر/تُخفي قدرات Enterprise + معلومات عرض اختيارية
// يوفّرها Enterprise نفسه (حالة الترخيص مثلاً) عبر info()
function snapshot() {
  const out = {};
  for (const [k, v] of flags) out[k] = v;
  let info = null;
  if (enterprise && typeof enterprise.info === 'function') {
    try { info = enterprise.info(); } catch (e) { info = null; }
  }
  return { edition: buildEdition, runtimeStatus, enterprise: !!enterprise, flags: out, info };
}

module.exports = { init, enabled, isEnterprise, edition, snapshot, notify };
