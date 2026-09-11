/**
 * اختبار desktopguard.js النقي — الحرّاس الأربعة لسطح ويندوز (§٩ في docs/COMPUTER-USE-DESKTOP.md)
 * وسطر السجل العربي للحارس الخامس.
 * التشغيل: npm run test:desktopguard (بلا شبكة ولا Electron ولا ويندوز).
 * البيانات بشكل ردود المعين native/satr-uia/Program.cs حرفياً (targets/list وtree/snapshot).
 * المحارف الخفية تُبنى بـString.fromCodePoint لا بمحرف خامّ ولا بهروب في المصدر.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  createSession, closeSession, isBlockedTarget, filterTargets, sanitizeSnapshot,
  checkAction, describeAction, clipText, BLOCKED_PROCESSES, BLOCKED_TITLES,
} = require('../electron/desktopguard');

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + ' — توقعنا ' + e + ' فجاء ' + a); }
}
function threw(fn) {
  try { fn(); return false; } catch { return true; }
}
const errorOf = (verdict) => (verdict ? verdict.error : null);
const refsOf = (nodes) => nodes.map((n) => n.ref);
const idsOf = (targets) => targets.map((t) => t.targetId);

const cp = (n) => String.fromCodePoint(n);
const RLO = cp(0x202e);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
const ALM = cp(0x061c);
const LRM = cp(0x200e);
const NUL = cp(0x00);
const BEL = cp(0x07);
const LS = cp(0x2028);
const INVISIBLE = [RLO, LRI, PDI, ALM, LRM, NUL, BEL, LS];
const hasInvisible = (s) => INVISIBLE.some((c) => s.includes(c)) || /[\r\n\t]/.test(s);

// أهداف كما يعيدها targets/list — المختار ليس الأول عمداً
const NOTEPAD = { targetId: 'w2', pid: 4100, processName: 'Notepad', title: 'secret-plan.txt - Notepad', rect: { x: 100, y: 100, w: 800, h: 600 } };
const BANK = { targetId: 'w3', pid: 5200, processName: 'chrome', title: 'البنك — كشف الحساب', rect: { x: 0, y: 0, w: 1920, h: 1080 } };
const UAC = { targetId: 'w4', pid: 900, processName: 'consent', title: 'User Account Control', rect: { x: 600, y: 300, w: 700, h: 500 } };
const TARGETS = [BANK, NOTEPAD, UAC];

const session = createSession(NOTEPAD);
const node = (ref, rect, extra) => Object.assign({ ref, role: 'button', name: 'حفظ', rect, enabled: true, focusable: true, isPassword: false, depth: 2 }, extra);
const click = (ref, extra) => Object.assign({ type: 'click', ref }, extra);

console.log('[1] الحارس ١ — لا تعداد بلا اختيار: النافذة المختارة وحدها، ولجلسة واحدة');
check('filterTargets يعيد الهدف المختار وحده', idsOf(filterTargets(session, TARGETS)), ['w2']);
check('نافذة غير مختارة غير مرئية', idsOf(filterTargets(session, [BANK])), []);
check('إعادة ترقيم المعين: w2 صار نافذة أخرى ⇒ []', idsOf(filterTargets(session, [Object.assign({}, BANK, { targetId: 'w2' })])), []);
check('العنوان يتغيّر (الكتابة في المفكرة) والهدف يبقى', idsOf(filterTargets(session, [Object.assign({}, NOTEPAD, { title: '*secret-plan.txt - Notepad' })])), ['w2']);
check('جلسة مزوّرة بكائن حرفي لا ترى شيئاً', idsOf(filterTargets({ targetId: 'w2', pid: 4100, processName: 'Notepad', rect: NOTEPAD.rect }, TARGETS)), []);
check('الجلسة مجمَّدة', Object.isFrozen(session) && Object.isFrozen(session.rect), true);
check('لا توسيع للجلسة بتعديل هدفها', threw(() => { session.targetId = 'w3'; }), true);
const bankSession = createSession(BANK);
check('اختيار جلسة ثانية لا يمتد إلى الأولى', idsOf(filterTargets(session, TARGETS)), ['w2']);
check('وكلٌّ يرى هدفه وحده', idsOf(filterTargets(bankSession, TARGETS)), ['w3']);
check('لقطة من نافذة أخرى تُسقط كلها', refsOf(sanitizeSnapshot(session, [node('w3:e1', null, { depth: 0 }), node('w3:e2', null)])), []);
check('فعل على مرجع من نافذة أخرى ⇒ not_allowed', errorOf(checkAction(session, click('w3:e5'), node('w3:e5', { x: 150, y: 150, w: 10, h: 10 }))), 'not_allowed');
check('فعل يسمّي نافذة أخرى ⇒ not_allowed', errorOf(checkAction(session, { type: 'snapshot', target: 'w3' })), 'not_allowed');
check('فعل بلا جلسة مأذونة ⇒ not_allowed', errorOf(checkAction(null, click('w2:e1'), node('w2:e1', null))), 'not_allowed');
check('createSession يرفض targetId بلا صيغة w<n>', threw(() => createSession(Object.assign({}, NOTEPAD, { targetId: 's2' }))), true);
check('createSession يرفض نافذة بلا مستطيل (مصغّرة)', threw(() => createSession(Object.assign({}, NOTEPAD, { rect: null }))), true);
check('createSession يرفض pid غير صالح', threw(() => createSession(Object.assign({}, NOTEPAD, { pid: 0 }))), true);
const shortSession = createSession(NOTEPAD);
closeSession(shortSession);
check('بعد إغلاق الجلسة: الفعل ⇒ closed', errorOf(checkAction(shortSession, click('w2:e1'), node('w2:e1', null))), 'closed');
check('بعد إغلاق الجلسة: لا أهداف', idsOf(filterTargets(shortSession, TARGETS)), []);
check('بعد إغلاق الجلسة: لا لقطة', refsOf(sanitizeSnapshot(shortSession, [node('w2:e1', null, { depth: 0 })])), []);

console.log('[2] الحارس ٢ — احتواء بالمستطيل (النافذة 100,100 بعرض 800 وارتفاع 600 ⇒ الحافتان 900 و700)');
check('عنصر داخل النافذة ⇒ null', checkAction(session, click('w2:e5'), node('w2:e5', { x: 200, y: 200, w: 50, h: 20 })), null);
check('مستطيل يطابق النافذة تماماً (ملامسة الحواف الأربع) ⇒ null', checkAction(session, click('w2:e5'), node('w2:e5', { x: 100, y: 100, w: 800, h: 600 })), null);
check('ملامسة الحافتين اليمنى والسفلى ⇒ null', checkAction(session, click('w2:e5'), node('w2:e5', { x: 850, y: 680, w: 50, h: 20 })), null);
check('تجاوز جزئي يميناً بمحرف ⇒ not_allowed', errorOf(checkAction(session, click('w2:e5'), node('w2:e5', { x: 851, y: 680, w: 50, h: 20 }))), 'not_allowed');
check('تجاوز جزئي أعلى ⇒ not_allowed', errorOf(checkAction(session, click('w2:e5'), node('w2:e5', { x: 200, y: 90, w: 40, h: 20 }))), 'not_allowed');
check('تجاوز جزئي يساراً ⇒ not_allowed', errorOf(checkAction(session, click('w2:e5'), node('w2:e5', { x: 99, y: 200, w: 40, h: 20 }))), 'not_allowed');
check('خارج النافذة كلياً ⇒ not_allowed', errorOf(checkAction(session, click('w2:e5'), node('w2:e5', { x: 1000, y: 800, w: 40, h: 20 }))), 'not_allowed');
check('scroll على عنصر rect:null ⇒ not_allowed', errorOf(checkAction(session, { type: 'scroll', ref: 'w2:e5', dy: 3 }, node('w2:e5', null))), 'not_allowed');
check('click على عنصر rect:null ⇒ null (انتماؤه للشجرة دليله)', checkAction(session, click('w2:e5'), node('w2:e5', null)), null);
check('مستطيل مشوّه ⇒ not_allowed', errorOf(checkAction(session, click('w2:e5'), node('w2:e5', { x: 'a', y: 1, w: 1, h: 1 }))), 'not_allowed');
check('نقر بالإحداثيات (x/y في الفعل) ⇒ not_allowed', errorOf(checkAction(session, click('w2:e5', { x: 150, y: 150 }), node('w2:e5', null))), 'not_allowed');
check('desktop_evaluate فعل غير معروف ⇒ not_allowed', errorOf(checkAction(session, { type: 'evaluate', code: '1' })), 'not_allowed');
check('فعل باسم خاصية موروثة (toString) ⇒ not_allowed', errorOf(checkAction(session, { type: 'toString' })), 'not_allowed');
check('مرجع بادئة s (لقطة المتصفح) ⇒ stale_ref', errorOf(checkAction(session, click('s1:e2'), node('s1:e2', null))), 'stale_ref');
check('مرجع w2:e0 ⇒ stale_ref', errorOf(checkAction(session, click('w2:e0'), node('w2:e0', null))), 'stale_ref');
check('مرجع بصفر بادئ w02:e1 ⇒ stale_ref', errorOf(checkAction(session, click('w02:e1'), node('w02:e1', null))), 'stale_ref');
check('click بلا مرجع ⇒ stale_ref', errorOf(checkAction(session, { type: 'click' })), 'stale_ref');
check('عقدة لا تطابق المرجع (ليست من آخر لقطة) ⇒ stale_ref', errorOf(checkAction(session, click('w2:e5'), node('w2:e6', null))), 'stale_ref');
check('بلا عقدة ⇒ stale_ref', errorOf(checkAction(session, click('w2:e5'))), 'stale_ref');
check('press_key على الجلسة ⇒ null', checkAction(session, { type: 'press_key', keys: 'Ctrl+S' }), null);
check('snapshot للهدف المختار ⇒ null', checkAction(session, { type: 'snapshot', target: 'w2' }), null);
check('رسالة الرفض عربية', /[؀-ۿ]/.test((checkAction(session, click('w2:e5'), node('w2:e5', { x: 1000, y: 800, w: 40, h: 20 })) || {}).message || ''), true);

console.log('[3] الحارس ٣ — حقل السرّ لا يدخل اللقطة (لا مرجع ولا اسم ولا أبناء)');
const tree = [
  node('w2:e1', NOTEPAD.rect, { role: 'window', name: 'secret-plan.txt - Notepad', depth: 0 }),
  node('w2:e2', null, { role: 'edit', name: 'كلمة المرور', isPassword: true, depth: 1 }),
  node('w2:e3', null, { role: 'text', name: 'ابن حقل السرّ', depth: 2 }),
  node('w2:e4', null, { name: 'حفظ', depth: 1 }),
  node('w2:e5', null, { role: 'edit', isPassword: 1, depth: 1 }),
  node('w2:e6', null, { role: 'edit', isPassword: 'yes', depth: 1 }),
  node('w2:e7', null, { role: 'edit', isPassword: {}, depth: 1 }),
  node('w2:e8', null, { role: 'edit', name: 'بحث', isPassword: 0, depth: 1 }),
  node('w2:e9', null, { name: 'عمق مشوّه', depth: -1 }),
  node('s1:e10', null, { depth: 1 }),
];
const clean = sanitizeSnapshot(session, tree);
check('isPassword بأي قيمة صادقة يُسقط، وأبناؤه معه', refsOf(clean), ['w2:e1', 'w2:e4', 'w2:e8']);
check('isPassword:1 وحده يُسقط', refsOf(sanitizeSnapshot(session, [node('w2:e5', null, { isPassword: 1, depth: 1 })])), []);
check('كل عقدة ناتجة isPassword:false', clean.every((n) => n.isPassword === false), true);
check('اسم حقل السرّ غائب عن اللقطة كلها', JSON.stringify(clean).includes('كلمة المرور'), false);
check('العقد الناتجة مجمَّدة', clean.every(Object.isFrozen), true);
check('فعل على عقدة سرّ (لو وصلت) ⇒ not_allowed', errorOf(checkAction(session, click('w2:e2'), node('w2:e2', null, { isPassword: true }))), 'not_allowed');
const bidiName = 'حفظ' + RLO + 'txt.exe' + LRI + 'x' + PDI + ALM + LRM + NUL + BEL + LS + 'تم';
const [bidiNode] = sanitizeSnapshot(session, [node('w2:e4', null, { name: bidiName, depth: 1 })]);
check('اسم فيه Bidi/تحكم يُنقّى', hasInvisible(bidiNode.name), false);
check('وتبقى حروفه المرئية', bidiNode.name, 'حفظtxt.exex تم');
const longName = 'ب'.repeat(158) + '😀😀😀😀';
const clipped = clipText(longName);
check('الاسم الطويل ≤160 نقطة Unicode', Array.from(clipped).length <= 160, true);
check('ويُعلَن القصّ بـ…', clipped.endsWith('…'), true);
check('ولا يقطع زوجاً بديلاً', /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped), false);
check('دور خارج [a-z] يصير unknown', sanitizeSnapshot(session, [node('w2:e4', null, { role: 'Button<script>', depth: 1 })])[0].role, 'unknown');
check('لقطة ليست مصفوفة ⇒ []', refsOf(sanitizeSnapshot(session, { nodes: tree })), []);

console.log('[4] الحارس ٤ — أصناف محجوبة بالاسم، مرفوضة حتى لو اختارها المستخدم');
for (const name of ['consent', 'consent.exe', 'CONSENT.EXE', 'CredentialUIBroker', 'LockApp', 'LogonUI.exe', 'Satr', 'satr.exe', 'electron']) {
  check('عملية محجوبة: ' + name, isBlockedTarget({ processName: name, title: 'x' }).blocked, true);
}
// نسخة سطر ثانية (رقم عملية آخر) محجوبة بالاسم لا بـpid النسخة نفسها — وإلا نقر وكيلُ نسخةٍ «سماح» في الأخرى
check('نسخة سطر أخرى لا تُختار حتى لو اختارها المستخدم', threw(() => createSession({ targetId: 'w20', pid: 77777, processName: 'Satr', title: 'سطر — Satr', rect: { x: 0, y: 0, w: 1200, h: 900 } })), true);
check('نسخة تطوير (electron) لا تُختار', threw(() => createSession({ targetId: 'w21', pid: 77778, processName: 'electron', title: 'سطر', rect: { x: 0, y: 0, w: 1200, h: 900 } })), true);
check('نافذة UAC مرفوضة (isBlockedTarget)', isBlockedTarget(UAC).blocked, true);
check('نافذة UAC لا تُختار حتى لو اختارها المستخدم', threw(() => createSession(UAC)), true);
check('المحجوبة بالعنوان: Credential Dialog Xaml Host', isBlockedTarget({ processName: 'SomeHost', title: 'Credential Dialog Xaml Host' }).blocked, true);
check('المحجوبة باسم الصنف أيضاً', isBlockedTarget({ processName: 'SomeHost', title: 'أمان Windows', className: 'credential dialog xaml host' }).blocked, true);
check('العنوان المحجوب لا يُلتفّ عليه بـBidi', isBlockedTarget({ processName: 'SomeHost', title: 'Credential ' + LRM + 'Dialog Xaml Host' }).blocked, true);
check('عملية مجهولة الاسم تُحجب', isBlockedTarget({ processName: '', title: 'x' }).blocked, true);
check('المفكرة غير محجوبة', isBlockedTarget(NOTEPAD).blocked, false);
check('نافذة مختارة يتحوّل عنوانها إلى المحجوب تختفي', idsOf(filterTargets(session, [Object.assign({}, NOTEPAD, { title: 'Credential Dialog Xaml Host' })])), []);
check('القائمتان مجمَّدتان', Object.isFrozen(BLOCKED_PROCESSES) && Object.isFrozen(BLOCKED_TITLES), true);
check('القائمة تحمل الستّ', BLOCKED_PROCESSES.join(','), 'consent.exe,CredentialUIBroker.exe,LockApp.exe,LogonUI.exe,Satr.exe,electron.exe');

console.log('[5] describeAction — سطر سجل عربي واحد بلا نص من النافذة غير اسم العنصر');
check('النقر', describeAction(click('w2:e4'), node('w2:e4', null), NOTEPAD), 'نُقر على [حفظ] في نافذة المفكرة');
const typed = describeAction({ type: 'type', ref: 'w2:e8', text: 'كلمة-سرية-123' }, node('w2:e8', null, { name: 'بحث' }), NOTEPAD);
check('الكتابة: الطول لا النص', typed, 'كُتب نص (الطول 13) في [بحث] في نافذة المفكرة');
check('لا عنوان النافذة في أي سطر', [typed, describeAction({ type: 'snapshot' }, null, NOTEPAD)].some((l) => l.includes('secret-plan')), false);
check('التمرير', describeAction({ type: 'scroll', ref: 'w2:e4', dy: -2 }, node('w2:e4', null), NOTEPAD), 'مُرِّر [حفظ] إلى الأعلى في نافذة المفكرة');
check('اختصار مفاتيح معروف الصيغة', describeAction({ type: 'press_key', keys: 'Ctrl+S' }, null, NOTEPAD), 'ضُغط Ctrl+S في نافذة المفكرة');
check('مفاتيح خارج الصيغة لا تُكتب', describeAction({ type: 'press_key', keys: 'rm -rf; ' + RLO }, null, NOTEPAD), 'ضُغط مفتاح في نافذة المفكرة');
check('اللقطة', describeAction({ type: 'snapshot' }, null, NOTEPAD), 'قُرئت شجرة نافذة المفكرة');
const longLine = describeAction(click('w2:e4'), node('w2:e4', null, { name: 'أ'.repeat(300) + LS + 'سطر ثانٍ' }), NOTEPAD);
check('اسم العنصر في السجل مقصوص (≤40 نقطة)', Array.from(longLine.slice(longLine.indexOf('[') + 1, longLine.indexOf(']'))).length <= 40, true);
check('سطر واحد بلا محارف خفية', hasInvisible(longLine) || hasInvisible(describeAction(click('w2:e4'), node('w2:e4', null, { name: bidiName }), NOTEPAD)), false);
check('نافذة غير معروفة باسم عمليتها لا بعنوانها', describeAction({ type: 'screenshot' }, null, BANK), 'التُقطت صورة نافذة chrome');

console.log('[6] بنية الموديول — نقي ورأسه يكتب المنع');
const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'desktopguard.js'), 'utf8');
check('صفر require', /\brequire\s*\(/.test(src), false);
for (const ban of ['لا desktop_evaluate', 'لا نقر بالإحداثيات', 'لا نموذج رؤية', 'لا تعداد بلا اختيار المستخدم']) {
  check('الرأس يكتب: ' + ban, src.slice(0, src.indexOf("'use strict'")).includes(ban), true);
}
check('لا محرف خفي خامّ في المصدر', Array.from(src).some((c) => c !== '\n' && hasInvisible(c)), false);

console.log('');
if (failed) { console.error('فشل ' + failed + ' من ' + (passed + failed)); process.exit(1); }
console.log('نجح الكل: ' + passed + '/' + passed);
