/**
 * حارس سطح ويندوز (desktopguard) — موديول نقي بلا اعتماديات (نمط browserguard.js وgitsafe.js).
 *
 * المرجع الملزم: docs/COMPUTER-USE-DESKTOP.md §٩ (الحرّاس الخمسة) و§٧ (العقد ورموز الخطأ).
 * استعمال الحاسوب يحوّل حقن الأمر إلى حقن نقرات، فهذه الحرّاس شرط الميزة لا تحسين لها.
 * شكل البيانات المحروسة هو ما يعيده المعين native/satr-uia/Program.cs حرفياً:
 *   targets/list  ⇒ [{targetId:'w<n>', pid, processName, title, rect:{x,y,w,h}|null}]
 *   tree/snapshot ⇒ {nodes:[{ref:'w<n>:e<m>', role, name, rect|null, enabled, focusable, isPassword, depth}], truncated}
 *
 * ممنوع بالتصميم — ولا يُفتح له باب هنا ولا في desktop.js:
 *  - لا desktop_evaluate: لا تقييم كود داخل نافذة أخرى بأي صيغة.
 *  - لا نقر بالإحداثيات: الفعل يقع على عنصر من آخر لقطة بمرجعه وحده، وفعل يحمل x/y يُرفض.
 *  - لا نموذج رؤية: لا لقطة شاشة يفسّرها نموذج ليقرّر أين ينقر.
 *  - لا تعداد بلا اختيار المستخدم: الوكيل لا يرى إلا النافذة التي اختارها المستخدم لهذه الجلسة.
 * إن لم يظهر العنصر في الشجرة فالجواب «لا أستطيع».
 *
 * الحرّاس هنا أربعة، والخامس (السجل العربي المرئي وبوابة PreToolUse) في الخطوتين ٤ و٥
 * ويستهلك describeAction من هنا:
 *  ١. createSession/filterTargets: جلسة مجمَّدة بهدف واحد، هويته targetId+pid+processName معاً —
 *     لأن المعين يعيد ترقيم w<n> مع كل targets/list، فالمطابقة بالرقم وحده قد تكشف نافذة أخرى.
 *     لا دالة توسّع الجلسة؛ جلسة مزوّرة (لم تُنشأ هنا) لا ترى شيئاً.
 *  ٢. checkAction: احتواء بالمستطيل — يُرفض أي تجاوز لمستطيل النافذة **كلياً أو جزئياً**:
 *     المستطيل هو الدليل الوحيد على الانتماء الذي يُفحص مرتين (هنا وفي المعين)، والتجاوز
 *     الجزئي لا يثبته؛ وكلفة الرفض الكاذب تمريرة واحدة تُدخل العنصر كاملاً في النافذة.
 *     الملامسة للحافة احتواء. عنصر بلا rect يُقبل لفعل بنمط UIA (النقر والكتابة — انتماؤه للشجرة
 *     دليله) ويُرفض لفعل يحتاج موضعاً (التمرير).
 *  ٣. sanitizeSnapshot: حقل السرّ (isPassword بأي قيمة صادقة) لا يدخل اللقطة، لا هو ولا أبناؤه —
 *     دفاع ثانٍ لأن المعين يُسقطه أصلاً والعقد لا يعتمد على طرف واحد.
 *  ٤. isBlockedTarget: عمليات وعناوين محجوبة بالاسم مرفوضة حتى لو اختارها المستخدم،
 *     والعملية المجهولة الاسم تُحجب (القائمة البيضاء للمعروف، والمجهول لا يمرّ).
 */
'use strict';

// صيغة المرجع من §٧ — ومطابقة لـIsWellFormedRef في المعين (بسقف الطول نفسه)
const REF_RE = /^w[1-9][0-9]*:e[1-9][0-9]*$/;
const TARGET_ID_RE = /^w[1-9][0-9]*$/;
const ROLE_RE = /^[a-z]{1,32}$/;
const KEYS_RE = /^[A-Za-z0-9+ ]{1,32}$/;
const MAX_REF_LENGTH = 32;
const MAX_NAME_POINTS = 160;
const MAX_LOG_NAME_POINTS = 40;
const MAX_NODES = 2000; // سقف maxNodes في المعين

// محارف التحكم وفواصل الأسطر تصير مسافة، ومحارف Bidi الموجِّهة تُحذف (تقلب عرض السجل)
// تُبنى من نقاط الترميز رقماً كي لا يحمل المصدر محرفاً غير مرئي (U+2028 خامّاً داخل regex خطأ نحوي)
function codePointClass(ranges) {
  const body = ranges.map(([from, to]) => String.fromCodePoint(from) + '-' + String.fromCodePoint(to)).join('');
  return new RegExp('[' + body + ']', 'g');
}
const CONTROL_RE = codePointClass([[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029]]);
const BIDI_RE = codePointClass([[0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]);

// الحارس ٤ — المعين يعيد اسم العملية بلا .exe (Process.ProcessName) فالمطابقة تُطبّع الطرفين
const BLOCKED_PROCESSES = Object.freeze([
  'consent.exe',            // نوافذ UAC
  'CredentialUIBroker.exe', // حوار بيانات الاعتماد
  'LockApp.exe',            // شاشة القفل
  'LogonUI.exe',            // شاشة الدخول
]);
// يُطابق العنوان واسم الصنف (className إن أضافه المعين) مطابقةً تامة بلا حساسية لحالة الأحرف
const BLOCKED_TITLES = Object.freeze([
  'Credential Dialog Xaml Host',
]);

// الأفعال المعروفة (أسماء أدوات §٧ بلا البادئة): ref مطلوب/اختياري/لا، وrect إلزامي لما يحتاج موضعاً
const ACTIONS = Object.freeze({
  click: Object.freeze({ ref: 'required', rect: false }),
  type: Object.freeze({ ref: 'required', rect: false }),
  scroll: Object.freeze({ ref: 'required', rect: true }),
  wait_for: Object.freeze({ ref: 'optional', rect: false }),
  press_key: Object.freeze({ ref: 'none', rect: false }),
  snapshot: Object.freeze({ ref: 'none', rect: false }),
  screenshot: Object.freeze({ ref: 'none', rect: false }),
});
// مفاتيح إحداثيات في الفعل ⇒ رفض (لا نقر بالإحداثيات)
const COORDINATE_KEYS = Object.freeze(['x', 'y', 'point', 'coordinates']);

// أسماء عربية للنوافذ المعروفة في السجل — من اسم العملية لا من العنوان (العنوان نصّ من الصفحة)
const PROCESS_LABELS = Object.freeze({
  notepad: 'المفكرة',
  mspaint: 'الرسام',
  calculatorapp: 'الحاسبة',
  explorer: 'مستكشف الملفات',
});

// الجلسات الحيّة والمغلقة — WeakSet كي لا تُزوَّر جلسة بكائن حرفي ولا تُحبس في الذاكرة
const liveSessions = new WeakSet();
const closedSessions = new WeakSet();

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// نصّ آمن للعرض: بلا تحكم ولا Bidi، مسافات مطويّة، ومقصوص بنقاط Unicode لا بوحدات UTF-16
function clipText(value, max = MAX_NAME_POINTS) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(BIDI_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  if (points.length <= max) return flat;
  return points.slice(0, max - 1).join('').trimEnd() + '…';
}

function isWellFormedRef(ref) {
  return typeof ref === 'string' && ref.length <= MAX_REF_LENGTH && REF_RE.test(ref);
}

function processKey(name) {
  return clipText(name, 64).toLowerCase().replace(/\.exe$/, '');
}

function titleKey(title) {
  return clipText(title).toLowerCase();
}

const BLOCKED_PROCESS_KEYS = Object.freeze(BLOCKED_PROCESSES.map(processKey));
const BLOCKED_TITLE_KEYS = Object.freeze(BLOCKED_TITLES.map(titleKey));

// مستطيل صالح بحقوله {x,y,w,h} كما يعيدها المعين، وإلا null
function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return Object.freeze({ x, y, w, h });
}

// احتواء كامل؛ الحافة الملامسة داخلة
function contains(outer, r) {
  return r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
}

function isBlockedTarget(target) {
  if (!target || typeof target !== 'object') return { blocked: true, why: 'هدف غير صالح' };
  const proc = processKey(target.processName);
  if (!proc) return { blocked: true, why: 'عملية مجهولة الاسم — المجهول لا يُختار' };
  const p = BLOCKED_PROCESS_KEYS.indexOf(proc);
  if (p >= 0) return { blocked: true, why: 'عملية محجوبة: ' + BLOCKED_PROCESSES[p] };
  for (const field of [target.title, target.className]) {
    const t = BLOCKED_TITLE_KEYS.indexOf(titleKey(field));
    if (t >= 0) return { blocked: true, why: 'نافذة محجوبة: ' + BLOCKED_TITLES[t] };
  }
  return { blocked: false, why: '' };
}

// الحارس ١: الجلسة تُنشأ من اختيار المستخدم في المنتقي وحده، ولا يُعدَّل هدفها بعد إنشائها
function createSession(choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  if (typeof c.targetId !== 'string' || c.targetId.length > MAX_REF_LENGTH || !TARGET_ID_RE.test(c.targetId)) {
    throw new Error('معرّف النافذة غير صالح: المتوقع w<n> من targets/list');
  }
  if (!Number.isSafeInteger(c.pid) || c.pid <= 0) throw new Error('رقم العملية غير صالح');
  const rect = normalizeRect(c.rect);
  if (!rect) throw new Error('النافذة بلا مستطيل صالح: لا تُختار نافذة مصغّرة أو مخفية');
  const verdict = isBlockedTarget(c);
  if (verdict.blocked) throw new Error('النافذة لا تُختار — ' + verdict.why);
  const session = Object.freeze({
    targetId: c.targetId,
    pid: c.pid,
    processName: clipText(c.processName, 64),
    title: clipText(c.title),
    rect,
  });
  liveSessions.add(session);
  return session;
}

// نهاية الجلسة (نهاية المحادثة أو سحب الاختيار): كل فعل بعدها closed
function closeSession(session) {
  if (liveSessions.has(session)) closedSessions.add(session);
}

function sessionState(session) {
  if (!session || typeof session !== 'object' || !liveSessions.has(session)) return 'invalid';
  return closedSessions.has(session) ? 'closed' : 'live';
}

function sameTarget(session, t) {
  return !!t && typeof t === 'object' && t.targetId === session.targetId && t.pid === session.pid
    && processKey(t.processName) === processKey(session.processName);
}

// الحارس ١ + ٤: من قائمة targets/list الكاملة لا يمرّ إلا الهدف المختار، وإلا []
function filterTargets(session, targets) {
  if (sessionState(session) !== 'live' || !Array.isArray(targets)) return [];
  const out = [];
  for (const t of targets) {
    if (!sameTarget(session, t)) continue;
    if (isBlockedTarget(t).blocked) continue;
    out.push(Object.freeze({
      targetId: t.targetId,
      pid: t.pid,
      processName: clipText(t.processName, 64),
      title: clipText(t.title),
      rect: normalizeRect(t.rect),
    }));
  }
  return out;
}

// الحارس ٣ + ١: عقد اللقطة بعد التنقية — لا حقل سرّ ولا أبناؤه، ولا مرجع من نافذة أخرى
function sanitizeSnapshot(session, nodes) {
  if (sessionState(session) !== 'live' || !Array.isArray(nodes)) return [];
  const prefix = session.targetId + ':';
  const out = [];
  let hiddenDepth = -1; // عمق حقل سرّ أُسقط: ما تحته يسقط معه
  for (const node of nodes.slice(0, MAX_NODES)) {
    if (!node || typeof node !== 'object') continue;
    if (!Number.isSafeInteger(node.depth) || node.depth < 0) continue;
    if (hiddenDepth >= 0) {
      if (node.depth > hiddenDepth) continue;
      hiddenDepth = -1;
    }
    if (node.isPassword) {
      hiddenDepth = node.depth;
      continue;
    }
    if (!isWellFormedRef(node.ref) || !node.ref.startsWith(prefix)) continue;
    out.push(Object.freeze({
      ref: node.ref,
      role: typeof node.role === 'string' && ROLE_RE.test(node.role) ? node.role : 'unknown',
      name: clipText(node.name),
      rect: normalizeRect(node.rect),
      enabled: node.enabled === true,
      focusable: node.focusable === true,
      isPassword: false,
      depth: node.depth,
    }));
  }
  return out;
}

function deny(error, message) {
  return { error, message };
}

// الحارس ٢ + ٤ (والشق الأول من الفحص المزدوج): null = يُرسَل إلى المعين، وإلا رمز خطأ §٧
function checkAction(session, action, node) {
  const state = sessionState(session);
  if (state === 'closed') return deny('closed', 'انتهت جلسة النافذة المختارة: يختار المستخدم النافذة من جديد');
  if (state !== 'live') return deny('not_allowed', 'لا نافذة مأذونة: المستخدم لم يختر نافذة لهذه الجلسة');
  const verdict = isBlockedTarget(session);
  if (verdict.blocked) return deny('not_allowed', 'النافذة خارج النطاق المأذون — ' + verdict.why);
  if (!action || typeof action !== 'object') return deny('not_allowed', 'فعل غير صالح');
  if (COORDINATE_KEYS.some((k) => hasOwn(action, k))) {
    return deny('not_allowed', 'لا نقر بالإحداثيات: الفعل يقع على عنصر بمرجعه من آخر لقطة');
  }
  const spec = typeof action.type === 'string' && hasOwn(ACTIONS, action.type) ? ACTIONS[action.type] : null;
  if (!spec) return deny('not_allowed', 'فعل غير مسموح على سطح المكتب');
  if (action.target !== undefined && action.target !== session.targetId) {
    return deny('not_allowed', 'النافذة ليست النافذة المختارة لهذه الجلسة');
  }
  const hasRef = action.ref !== undefined;
  if (spec.ref === 'required' && !hasRef) return deny('stale_ref', 'مرجع مفقود: خذ لقطة جديدة');
  if (spec.ref === 'none' || !hasRef) return null;
  if (!isWellFormedRef(action.ref)) return deny('stale_ref', 'مرجع غير صالح: خذ لقطة جديدة');
  if (!action.ref.startsWith(session.targetId + ':')) {
    return deny('not_allowed', 'المرجع من نافذة غير النافذة المختارة لهذه الجلسة');
  }
  if (!node || typeof node !== 'object' || node.ref !== action.ref) {
    return deny('stale_ref', 'المرجع ' + action.ref + ' ليس من آخر لقطة: خذ لقطة جديدة');
  }
  if (node.isPassword) return deny('not_allowed', 'حقل سرّ: خارج متناول الوكيل');
  if (node.rect === null || node.rect === undefined) {
    return spec.rect ? deny('not_allowed', 'العنصر بلا مستطيل: هذا الفعل يحتاج موضعه داخل النافذة المأذونة') : null;
  }
  const rect = normalizeRect(node.rect);
  if (!rect || !contains(session.rect, rect)) {
    return deny('not_allowed', 'العنصر خارج مستطيل النافذة المأذونة كلياً أو جزئياً');
  }
  return null;
}

function windowLabel(target) {
  const key = processKey(target && target.processName);
  if (hasOwn(PROCESS_LABELS, key)) return PROCESS_LABELS[key];
  return key || 'غير معروفة';
}

function elementLabel(node) {
  const name = clipText(node && node.name, MAX_LOG_NAME_POINTS);
  return '[' + (name || 'عنصر بلا اسم') + ']';
}

// الحارس ٥ (المستهلِك في الخطوتين ٤ و٥): سطر سجل عربي واحد — لا نصّ من النافذة إلا اسم العنصر
// مقصوصاً؛ لا العنوان ولا النص المكتوب ولا المفاتيح خارج صيغة الاختصار
function describeAction(action, node, target) {
  const a = action && typeof action === 'object' ? action : {};
  const win = 'في نافذة ' + windowLabel(target);
  switch (a.type) {
    case 'click':
      return 'نُقر على ' + elementLabel(node) + ' ' + win;
    case 'type': {
      const length = typeof a.text === 'string' ? Array.from(a.text).length : 0;
      return 'كُتب نص (الطول ' + length + ') في ' + elementLabel(node) + ' ' + win;
    }
    case 'scroll': {
      const dir = a.dy > 0 ? ' إلى الأسفل' : a.dy < 0 ? ' إلى الأعلى' : '';
      return 'مُرِّر ' + elementLabel(node) + dir + ' ' + win;
    }
    case 'press_key':
      return typeof a.keys === 'string' && KEYS_RE.test(a.keys)
        ? 'ضُغط ' + a.keys + ' ' + win
        : 'ضُغط مفتاح ' + win;
    case 'wait_for':
      return node ? 'انتُظر ' + elementLabel(node) + ' ' + win : 'انتُظر ظهور نص ' + win;
    case 'snapshot':
      return 'قُرئت شجرة ' + win.replace('في ', '');
    case 'screenshot':
      return 'التُقطت صورة ' + win.replace('في ', '');
    default:
      return 'فعل غير معروف ' + win;
  }
}

module.exports = {
  REF_RE,
  MAX_NAME_POINTS,
  BLOCKED_PROCESSES,
  BLOCKED_TITLES,
  ACTIONS,
  createSession,
  closeSession,
  isBlockedTarget,
  filterTargets,
  sanitizeSnapshot,
  checkAction,
  describeAction,
  isWellFormedRef,
  clipText,
};
