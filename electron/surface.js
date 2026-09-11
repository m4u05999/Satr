/**
 * سطح التفاعل بالمرجع (surface) — موديول نقي بلا اعتماديات (نمط browserguard.js).
 *
 * منطق «المرجع والجيل والبصمة وعقد الإدخال و`stale_ref`» الذي يحرس أفعال الوكيل على
 * سطحٍ يراه بلقطة بنيوية. استُخرج من electron/preview.js **حرفياً بلا تغيير سلوك**
 * (الخطوة ٢ من docs/COMPUTER-USE-DESKTOP.md) كي يستهلكه سطح ويندوز لاحقاً بالنحو نفسه.
 *
 * لماذا مصنع لا حالة على مستوى الوحدة: سطحان بحالتين مستقلتين. لقطة نافذة ويندوز
 * يجب ألّا تُبطل refs لقطة المتصفح ولا تجدّد عقده، ونقرة المستخدم في المتصفح لا تستهلك
 * عقد ويندوز. لذا كل سطح يملك نسخته: `createSurface({ prefix: 's' })` للمتصفح و
 * `createSurface({ prefix: 'w' })` لويندوز — والبادئة جزء من صيغة المرجع نفسها، فمرجع
 * سطحٍ مرفوضٌ `stale_ref` في الآخر بدل أن يُحلّ خطأً.
 *
 * ما **لا** يعيش هنا (خاص بكل سطح ويبقى عند مستهلكه): أسماء الأدوات وتصنيفها
 * (‏browserorigin.classifyBrowserTool)، وبثّ `control_conflict`، وأنواع أحداث الإدخال
 * الملتزمة، وسكربتات الحقن التي تحسب البصمة داخل الصفحة، والرسائل العربية.
 *
 * المالك (ownerId): معرّف الهدف الذي أُخذت عليه اللقطة (‏webContents.id في المتصفح).
 * الدوال التي تحتاجه تقبله قيمةً أو **دالةً كسولة** تُستدعى فقط حين يلزم الحلّ — كي
 * يبقى ترتيب نداءات المستهلك (مثل currentWC في preview.js) كما كان قبل الاستخراج.
 */
'use strict';

// فاصل حقول البصمة — يُكتب هروباً لا محرف تحكم حرفياً في المصدر (درس loopfailure.js).
const FINGERPRINT_SEP = '\u001f';
const DEFAULT_MAX_TRACKED_FINGERPRINTS = 400;

// وسم مقروء للبصمة (بلا فاصلها الداخلي) — يظهر في رسالة «كان … وصار …» وحدها.
function fingerprintLabel(value) {
  return String(value || '').split(FINGERPRINT_SEP).map((part) => part.trim()).filter(Boolean).join(' ').slice(0, 160);
}

function createSurface({ prefix, maxTrackedFingerprints = DEFAULT_MAX_TRACKED_FINGERPRINTS } = {}) {
  // البادئة حرف لاتيني صغير واحد غير e (‏e بادئة العنصر داخل المرجع نفسه)
  if (typeof prefix !== 'string' || !/^[a-df-z]$/.test(prefix)) {
    throw new TypeError('createSurface: prefix must be a single lowercase letter other than "e"');
  }
  if (!Number.isInteger(maxTrackedFingerprints) || maxTrackedFingerprints < 1) {
    throw new TypeError('createSurface: maxTrackedFingerprints must be a positive integer');
  }
  // صيغة المرجع `<prefix><gen>:e<n>`؛ والصيغة القديمة `e<n>` (بلا جيل) تُرفض stale_ref دائماً
  const refPattern = new RegExp('^' + prefix + '([1-9][0-9]*):e([1-9][0-9]*)$');
  const legacyRefPattern = /^e[1-9][0-9]*$/;

  let sequence = 0;
  let generation = 0;
  let ownerId = null;
  let nextIndex = 0;
  let textBytes = 0;
  let fingerprints = new Map(); // ref → بصمة لحظة اللقطة (داخلية — لا تعبر للنموذج)
  // عقد اللقطة: العدّاد يرتفع بإدخال ملتزم من المستخدم، واللقطة تحفظ قيمته
  let userInputCounter = 0;
  let leaseUserRevision = 0;

  const resolveOwner = (owner) => (typeof owner === 'function' ? owner() : owner);

  function nextGeneration(owner) {
    sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    generation = sequence;
    ownerId = Number.isInteger(owner) ? owner : null;
    nextIndex = 0;
    textBytes = 0;
    fingerprints = new Map();
    leaseUserRevision = userInputCounter; // اللقطة تجدّد العقد
    return generation;
  }

  // بلا وسيط ⇒ إبطال غير مشروط؛ بمالكٍ ⇒ الإبطال فقط إن كان هو مالك اللقطة النشطة
  function invalidate(owner) {
    if (arguments.length && owner !== ownerId) return;
    generation = 0;
    ownerId = null;
    nextIndex = 0;
    textBytes = 0;
    fingerprints = new Map();
  }

  const isCurrent = (owner, gen) => owner === ownerId && Number(gen) === generation;

  // نتيجة اللقطة تُسجَّل فقط إن بقي جيلها هو النشط على المالك نفسه (لم تسبقها لقطة/إبطال)
  function recordSnapshot(owner, gen, { nextIndex: index, textBytes: bytes, fingerprints: entries } = {}) {
    if (generation !== gen || ownerId !== owner) return false;
    nextIndex = index;
    textBytes = bytes;
    rememberFingerprints(entries);
    return true;
  }

  // أثر فعلٍ على الجيل نفسه: refs جديدة ظهرت بعده تمدّ الفهرس ولا تعيده إلى الوراء
  function recordAction(owner, gen, { nextIndex: index, fingerprints: entries } = {}) {
    if (!isCurrent(owner, gen)) return false;
    nextIndex = Math.max(nextIndex, Number(index) || 0);
    rememberFingerprints(entries);
    return true;
  }

  function rememberFingerprints(entries) {
    if (!entries || typeof entries !== 'object') return;
    for (const [ref, value] of Object.entries(entries)) {
      if (!refPattern.test(ref) || typeof value !== 'string') continue;
      if (!fingerprints.has(ref) && fingerprints.size >= maxTrackedFingerprints) continue;
      fingerprints.set(ref, value);
    }
  }

  // البصمة المتوقعة لهدف الفعل: تُعرف فقط لـ ref من اللقطة النشطة على المالك نفسه.
  // مُحدِّد بلا لقطة ⇒ '' ⇒ الحارس يتخطى المقارنة.
  function expectedFingerprint(locator, owner) {
    const ref = typeof locator === 'string' ? locator.trim() : '';
    if (!refPattern.test(ref)) return '';
    const target = resolveOwner(owner);
    if (target == null || target !== ownerId || !generation) return '';
    return fingerprints.get(ref) || '';
  }

  function locatorError(value, owner) {
    const locator = typeof value === 'string' ? value.trim() : '';
    if (legacyRefPattern.test(locator)) return 'stale_ref';
    const match = refPattern.exec(locator);
    if (!match) return null;
    const target = resolveOwner(owner);
    return target != null && target === ownerId && Number(match[1]) === generation ? null : 'stale_ref';
  }

  return {
    prefix,
    refPattern,
    legacyRefPattern,
    get generation() { return generation; },
    get ownerId() { return ownerId; },
    get nextIndex() { return nextIndex; },
    get textBytes() { return textBytes; },
    nextGeneration,
    invalidate,
    isCurrent,
    recordSnapshot,
    recordAction,
    rememberFingerprints,
    expectedFingerprint,
    locatorError,
    fingerprintLabel,
    noteCommittedInput() { userInputCounter += 1; },
    leaseError() { return userInputCounter === leaseUserRevision ? null : 'input_changed'; },
    leaseState() { return { userInputCounter, leaseUserRevision }; },
    fingerprints() { return new Map(fingerprints); },
    // للاختبار وحده — نسخة لا مرجع حيّ
    state() {
      return { sequence, generation, ownerId, nextIndex, textBytes, fingerprints: new Map(fingerprints),
        userInputCounter, leaseUserRevision };
    },
  };
}

module.exports = { createSurface, fingerprintLabel, FINGERPRINT_SEP, DEFAULT_MAX_TRACKED_FINGERPRINTS };
