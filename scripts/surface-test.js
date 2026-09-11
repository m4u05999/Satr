/**
 * اختبار electron/surface.js النقي — منطق المرجع والجيل والبصمة وعقد الإدخال وstale_ref
 * المستخرج من preview.js بلا تغيير سلوك (الخطوة ٢ من docs/COMPUTER-USE-DESKTOP.md).
 * التشغيل: npm run test:surface (بلا شبكة ولا Electron).
 *
 * يثبت على المصنع مباشرةً الدلالات نفسها التي يثبتها test:preview-lease حيّاً، ويثبت أن
 * نسختين ببادئتين s وw **مستقلتان**: لقطة إحداهما لا تبطل الأخرى ولا تجدّد عقدها.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSurface, fingerprintLabel, FINGERPRINT_SEP } = require('../electron/surface');

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const same = typeof expected === 'object' && expected !== null
    ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (same) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + ' — توقعنا ' + JSON.stringify(expected) + ' فجاء ' + JSON.stringify(actual)); }
}
function throwsType(fn) { try { fn(); return false; } catch (e) { return e instanceof TypeError; } }

const OWNER = 7;
const OTHER = 8;

console.log('[1] المصنع وصيغة المرجع');
check('بلا بادئة ⇒ TypeError', throwsType(() => createSurface()), true);
check('البادئة e محجوزة ⇒ TypeError', throwsType(() => createSurface({ prefix: 'e' })), true);
check('بادئة من حرفين ⇒ TypeError', throwsType(() => createSurface({ prefix: 'ss' })), true);
check('سقف بصمات غير صحيح ⇒ TypeError', throwsType(() => createSurface({ prefix: 's', maxTrackedFingerprints: 0 })), true);
const probeS = createSurface({ prefix: 's' });
const probeW = createSurface({ prefix: 'w' });
// نمط المتصفح يطابق ما كان في preview.js حرفياً، ونمط ويندوز يطابق §٧ نمطاً لا نصاً
check('refPattern للمتصفح هو SNAPSHOT_REF_RE القديم', probeS.refPattern.source, '^s([1-9][0-9]*):e([1-9][0-9]*)$');
check('refPattern لويندوز بالنمط نفسه', probeW.refPattern.source, '^w([1-9][0-9]*):e([1-9][0-9]*)$');
const specW = /^w[1-9][0-9]*:e[1-9][0-9]*$/;
for (const sample of ['w1:e1', 'w2:e14', 'w0:e1', 'w1:e0', 'w01:e1', 'w1:e', 's1:e1', 'w1:e1 ']) {
  check('w يطابق regex المواصفة §٧ في «' + sample + '»', probeW.refPattern.test(sample), specW.test(sample));
}
check('الصيغة القديمة e<n> نمط مستقل', probeS.legacyRefPattern.source, '^e[1-9][0-9]*$');
check('الحالة الأولى صفرية', probeS.state(), { sequence: 0, generation: 0, ownerId: null, nextIndex: 0,
  textBytes: 0, fingerprints: {}, userInputCounter: 0, leaseUserRevision: 0 });

console.log('[2] الجيل والمالك وstale_ref');
let s = createSurface({ prefix: 's' });
check('قبل أي لقطة: s1:e1 ⇒ stale_ref', s.locatorError('s1:e1', OWNER), 'stale_ref');
check('nextGeneration يعيد 1', s.nextGeneration(OWNER), 1);
check('المالك محفوظ', s.ownerId, OWNER);
check('مرجع الجيل النشط على مالكه ⇒ null', s.locatorError('s1:e3', OWNER), null);
check('المرجع يُقصّ فراغه', s.locatorError('  s1:e3 ', OWNER), null);
check('مالك آخر ⇒ stale_ref', s.locatorError('s1:e3', OTHER), 'stale_ref');
check('بلا مالك (null) ⇒ stale_ref', s.locatorError('s1:e3', null), 'stale_ref');
check('جيل آخر ⇒ stale_ref', s.locatorError('s2:e3', OWNER), 'stale_ref');
check('الصيغة القديمة e3 ⇒ stale_ref', s.locatorError('e3', OWNER), 'stale_ref');
check('الصيغة القديمة ولو بلا مالك ⇒ stale_ref', s.locatorError('e12', null), 'stale_ref');
check('مُحدِّد CSS ⇒ null (يمرّ إلى مسار المحدِّد كما كان)', s.locatorError('#save', OWNER), null);
check('s0:e1 ليس مرجعاً ⇒ null', s.locatorError('s0:e1', OWNER), null);
check('قيمة غير نصية ⇒ null', s.locatorError(42, OWNER), null);
// المالك الكسول: لا يُستدعى إلا حين يطابق المرجعُ النمط (ترتيب currentWC في preview.js)
let lazyCalls = 0;
const lazy = () => { lazyCalls++; return OWNER; };
s.locatorError('#save', lazy);
s.locatorError('e3', lazy);
check('المالك الكسول لا يُستدعى لمحدِّد أو صيغة قديمة', lazyCalls, 0);
check('المالك الكسول يُحلّ للمرجع', s.locatorError('s1:e3', lazy), null);
check('المالك الكسول استُدعي مرة واحدة', lazyCalls, 1);
check('جيل جديد يُبطل مراجع القديم', (s.nextGeneration(OWNER), s.locatorError('s1:e3', OWNER)), 'stale_ref');
check('والجيل الجديد صالح', s.locatorError('s2:e3', OWNER), null);
s.invalidate(OTHER);
check('إبطال بمالك آخر بلا أثر', s.locatorError('s2:e3', OWNER), null);
s.invalidate(OWNER);
check('إبطال بالمالك نفسه يُسقط المراجع', s.locatorError('s2:e3', OWNER), 'stale_ref');
check('والجيل صفر بعده', s.generation, 0);
s.nextGeneration(OWNER);
s.invalidate();
check('إبطال بلا وسيط غير مشروط', s.locatorError('s3:e1', OWNER), 'stale_ref');
check('مالك غير صحيح في nextGeneration ⇒ null', (s.nextGeneration(undefined), s.ownerId), null);
check('التسلسل يستمر بعد الإبطال (لا يعيد جيلاً قديماً)', s.generation, 4);

console.log('[3] البصمات');
s = createSurface({ prefix: 's', maxTrackedFingerprints: 3 });
s.nextGeneration(OWNER);
s.rememberFingerprints({ 's1:e1': 'button' + FINGERPRINT_SEP + 'احفظ', 's1:e2': 'link', 'e3': 'legacy',
  '#css': 'x', 'w1:e1': 'other-surface', 's1:e4': 42 });
check('تُحفظ مراجع النمط النصية وحدها', [...s.fingerprints().keys()].sort(), ['s1:e1', 's1:e2']);
check('البصمة المتوقعة لمرجع نشط', s.expectedFingerprint('s1:e2', OWNER), 'link');
check('البصمة المتوقعة تقصّ الفراغ', s.expectedFingerprint(' s1:e2 ', OWNER), 'link');
check('مالك آخر ⇒ بصمة فارغة', s.expectedFingerprint('s1:e2', OTHER), '');
check('محدِّد CSS ⇒ بصمة فارغة (يتخطى الحارس المقارنة)', s.expectedFingerprint('#css', OWNER), '');
check('مرجع بلا بصمة ⇒ فارغة', s.expectedFingerprint('s1:e9', OWNER), '');
s.rememberFingerprints({ 's1:e5': 'c', 's1:e6': 'd' });
check('السقف يمنع مرجعاً جديداً بعد الامتلاء', [...s.fingerprints().keys()].sort(), ['s1:e1', 's1:e2', 's1:e5']);
s.rememberFingerprints({ 's1:e2': 'link2' });
check('المرجع القائم يُحدَّث رغم الامتلاء', s.expectedFingerprint('s1:e2', OWNER), 'link2');
const copy = s.fingerprints();
copy.set('s1:e7', 'leak');
check('fingerprints() نسخة لا مرجع حيّ', s.fingerprints().has('s1:e7'), false);
s.invalidate(OWNER);
check('الإبطال يمسح البصمات', s.fingerprints().size, 0);
check('بعد الإبطال ⇒ بصمة فارغة', s.expectedFingerprint('s1:e2', OWNER), '');

console.log('[4] عقد الإدخال');
s = createSurface({ prefix: 's' });
s.nextGeneration(OWNER);
check('العقد سليم بعد لقطة', s.leaseError(), null);
s.noteCommittedInput();
check('إدخال ملتزم ⇒ input_changed', s.leaseError(), 'input_changed');
check('شكل leaseState كما يستهلكه preview._internals', s.leaseState(), { userInputCounter: 1, leaseUserRevision: 0 });
s.invalidate();
check('الإبطال لا يجدّد العقد (اللقطة وحدها تجدّده)', s.leaseError(), 'input_changed');
s.nextGeneration(OWNER);
check('اللقطة الجديدة تجدّد العقد', s.leaseError(), null);
check('العقد يحفظ قيمة العدّاد لحظة اللقطة', s.leaseState(), { userInputCounter: 1, leaseUserRevision: 1 });

console.log('[5] نتيجة اللقطة وأثر الفعل على الجيل');
s = createSurface({ prefix: 's' });
const gen = s.nextGeneration(OWNER);
check('recordSnapshot على الجيل النشط', s.recordSnapshot(OWNER, gen, { nextIndex: 5, textBytes: 300, fingerprints: { 's1:e1': 'a' } }), true);
check('الفهرس التالي والبايتات سُجّلت', [s.nextIndex, s.textBytes, s.expectedFingerprint('s1:e1', OWNER)], [5, 300, 'a']);
check('recordSnapshot لمالك آخر مرفوض', s.recordSnapshot(OTHER, gen, { nextIndex: 9, textBytes: 1 }), false);
check('recordSnapshot لجيل سابق مرفوض', s.recordSnapshot(OWNER, gen - 1, { nextIndex: 9, textBytes: 1 }), false);
check('الرفض لم يمسّ الحالة', [s.nextIndex, s.textBytes], [5, 300]);
check('recordAction يقبل الجيل نصاً (Number)', s.recordAction(OWNER, String(gen), { nextIndex: '8', fingerprints: { 's1:e6': 'b' } }), true);
check('الفهرس يمتدّ', s.nextIndex, 8);
s.recordAction(OWNER, gen, { nextIndex: 2 });
check('الفهرس لا يعود إلى الوراء', s.nextIndex, 8);
check('أثر الفعل يضيف البصمات الجديدة', s.expectedFingerprint('s1:e6', OWNER), 'b');
check('recordAction لجيل آخر مرفوض', s.recordAction(OWNER, gen + 1, { nextIndex: 99 }), false);
check('isCurrent', [s.isCurrent(OWNER, gen), s.isCurrent(OTHER, gen), s.isCurrent(OWNER, gen + 1)], [true, false, false]);

console.log('[6] استقلال سطحين (s للمتصفح، w لويندوز)');
const browser = createSurface({ prefix: 's' });
const desktop = createSurface({ prefix: 'w' });
browser.nextGeneration(OWNER);
browser.rememberFingerprints({ 's1:e1': 'btn' });
desktop.nextGeneration(OWNER);
desktop.rememberFingerprints({ 'w1:e1': 'win' });
check('لقطة ويندوز لا تبطل مرجع المتصفح', browser.locatorError('s1:e1', OWNER), null);
check('ولا تمسح بصمة المتصفح', browser.expectedFingerprint('s1:e1', OWNER), 'btn');
check('مرجع ويندوز صالح في نسخته', desktop.locatorError('w1:e1', OWNER), null);
// مرجع السطح الآخر لا يُحلّ مرجعاً في هذه النسخة: يمرّ كما يمرّ أي نص غير مرجعي اليوم
// (مسار المحدِّد في preview.js)، ولا تُقبل له بصمة — لا جيل يُطابَق ولا بصمة تُقارَن.
check('w1:e1 ليس مرجعاً في نسخة s', browser.refPattern.test('w1:e1'), false);
check('s1:e1 ليس مرجعاً في نسخة w', desktop.refPattern.test('s1:e1'), false);
check('نسخة s لا تعرف بصمة w1:e1', browser.expectedFingerprint('w1:e1', OWNER), '');
check('نسخة w لا تعرف بصمة s1:e1', desktop.expectedFingerprint('s1:e1', OWNER), '');
check('نسخة s ترفض حفظ بصمة w1:e1', (browser.rememberFingerprints({ 'w1:e2': 'x' }), browser.fingerprints().has('w1:e2')), false);
check('الصيغة القديمة stale_ref في نسخة w أيضاً', desktop.locatorError('e1', OWNER), 'stale_ref');
browser.noteCommittedInput();
check('إدخال في المتصفح يستهلك عقده', browser.leaseError(), 'input_changed');
check('ولا يستهلك عقد ويندوز', desktop.leaseError(), null);
desktop.nextGeneration(OWNER);
check('لقطة ويندوز لا تجدّد عقد المتصفح', browser.leaseError(), 'input_changed');
check('وجيل ويندوز تقدّم وحده', [browser.generation, desktop.generation], [1, 2]);
desktop.invalidate();
check('إبطال ويندوز لا يمسّ المتصفح', browser.locatorError('s1:e1', OWNER), null);

console.log('[7] وسم البصمة المقروء');
check('الفاصل الداخلي هروب \\u001f', FINGERPRINT_SEP.charCodeAt(0) === 31 && FINGERPRINT_SEP.length === 1, true);
check('الوسم يزيل الفاصل ويقصّ', fingerprintLabel(' button ' + FINGERPRINT_SEP + ' احفظ ' + FINGERPRINT_SEP + FINGERPRINT_SEP + 'a'), 'button احفظ a');
check('الوسم فارغ لقيمة فارغة', fingerprintLabel(null), '');
check('الوسم محدود بـ160', fingerprintLabel('x'.repeat(400)).length, 160);
check('fingerprintLabel على النسخة هي نفسها', probeS.fingerprintLabel, fingerprintLabel);

console.log('[8] الموديول نقي و preview.js يفوّض إلى نسخة واحدة');
const surfaceSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'surface.js'), 'utf8');
check('surface.js بلا require إطلاقاً', (surfaceSrc.match(/\brequire\s*\(/g) || []).length, 0);
check('surface.js بلا محرف تحكم حرفي', surfaceSrc.includes(String.fromCharCode(31)), false);
const previewSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preview.js'), 'utf8');
check('preview.js ينشئ نسخة سطح واحدة ببادئة s', (previewSrc.match(/createSurface\(\{ prefix: 's'/g) || []).length, 1);
check('preview.js لم يعد يحمل حالة لقطة موازية', /let (activeSnapshot\w*|snapshotSequence|userInputCounter|leaseUserRevision)\b/.test(previewSrc), false);

console.log('\n' + passed + ' نجح · ' + failed + ' فشل');
if (failed) { console.error('surface-test: FAIL'); process.exit(1); }
console.log('surface-test: ok');
