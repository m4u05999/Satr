#!/usr/bin/env node
'use strict';

/**
 * حارس قطعي لتحصين edit_file: ذرّية الكتل غير المرتّبة، ارتداد المسافات الوحيد،
 * وبوابة القراءة الخاصة بأدوات «سطر» مع بقاء العقد الأحادي ولقطة التراجع.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('../electron/tools');

function makeWorkspace(root, name, files) {
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return cwd;
}

function makeSession(id) {
  const events = [];
  const emit = (event) => events.push(event);
  return { ctx: { id, emit }, events };
}

async function readFile(cwd, rel, session) {
  const result = await tools.run('read_file', cwd, { path: rel }, session.ctx);
  assert.strictEqual(result.ok, true, 'تعذّرت قراءة fixture: ' + result.content);
  return result;
}

async function editFile(cwd, args, session) {
  return tools.run('edit_file', cwd, args, session.ctx);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-tools-edit-'));
  try {
    const definition = tools.defs().find((item) => item.function.name === 'edit_file');
    assert.ok(definition, 'تعريف edit_file غائب');
    assert.strictEqual(definition.function.parameters.properties.edits.maxItems, 100);
    const strictDefinition = tools.defs({ strictTools: true })
      .find((item) => item.function.name === 'edit_file');
    assert.ok(strictDefinition.function.parameters.required.includes('edits'));
    assert.ok(strictDefinition.function.parameters.properties.edits.type.includes('null'));
    assert.strictEqual(strictDefinition.function.parameters.properties.edits.items.additionalProperties, false);
    assert.strictEqual(tools.needsPermission('edit_file'), true);
    assert.strictEqual(tools.permissionTier('edit_file'), 'write');

    // البوابة تفشل مغلقة، ولا تعبر قراءة من باعث جلسة إلى باعث آخر.
    const gateCwd = makeWorkspace(tempRoot, 'gate', { 'gate.txt': 'قديم\n' });
    const gateSession = makeSession('gate-edit');
    const unread = await editFile(gateCwd, {
      path: 'gate.txt', old_string: 'قديم', new_string: 'جديد',
    }, gateSession);
    assert.strictEqual(unread.ok, false);
    assert.match(unread.content, /read_file/);
    assert.match(unread.content, /المحرك الأصيل/);
    assert.strictEqual(fs.readFileSync(path.join(gateCwd, 'gate.txt'), 'utf8'), 'قديم\n');
    assert.deepStrictEqual(gateSession.events, [], 'فشل البوابة أصدر بطاقة تعديل كاذبة');

    const readerSession = makeSession('reader');
    await readFile(gateCwd, 'gate.txt', readerSession);
    const foreignSession = makeSession('foreign-edit');
    const foreign = await editFile(gateCwd, {
      path: 'gate.txt', old_string: 'قديم', new_string: 'جديد',
    }, foreignSession);
    assert.strictEqual(foreign.ok, false, 'قراءة جلسة أخرى عبرت بوابة التعديل');
    assert.strictEqual(fs.readFileSync(path.join(gateCwd, 'gate.txt'), 'utf8'), 'قديم\n');

    // النداء الأحادي القديم يبقى كما هو، وcommitWrite ما زال يصدر لقطة قابلة للتراجع.
    const singleCwd = makeWorkspace(tempRoot, 'single', { 'single.txt': 'alpha\nbeta\n' });
    const singleSession = makeSession('single-edit');
    await readFile(singleCwd, 'single.txt', singleSession);
    const single = await editFile(singleCwd, {
      path: 'single.txt', old_string: 'beta', new_string: 'BETA',
    }, singleSession);
    assert.deepStrictEqual(single, { ok: true, content: 'عُدّل الملف single.txt' });
    assert.strictEqual(fs.readFileSync(path.join(singleCwd, 'single.txt'), 'utf8'), 'alpha\nBETA\n');
    assert.strictEqual(singleSession.events.length, 1);
    assert.strictEqual(singleSession.events[0].type, 'file_edit');
    assert.deepStrictEqual(tools.undoEdit('single-edit'), { ok: true });
    assert.strictEqual(fs.readFileSync(path.join(singleCwd, 'single.txt'), 'utf8'), 'alpha\nbeta\n');

    // A تنشئ نص بحث B؛ التطبيق التسلسلي يتغيّر بعكس الترتيب، أما التخطيط على الأصل فلا.
    const original = 'alpha\nbeta\n';
    const forwardCwd = makeWorkspace(tempRoot, 'forward', { 'order.txt': original });
    const reverseCwd = makeWorkspace(tempRoot, 'reverse', { 'order.txt': original });
    const forwardSession = makeSession('forward-edit');
    const reverseSession = makeSession('reverse-edit');
    const first = { old_string: 'alpha', new_string: 'beta' };
    const second = { old_string: 'beta', new_string: 'gamma' };
    await readFile(forwardCwd, 'order.txt', forwardSession);
    await readFile(reverseCwd, 'order.txt', reverseSession);
    const forward = await editFile(forwardCwd, { path: 'order.txt', edits: [first, second] }, forwardSession);
    const reverse = await editFile(reverseCwd, { path: 'order.txt', edits: [second, first] }, reverseSession);
    assert.strictEqual(forward.ok, true, forward.content);
    assert.strictEqual(reverse.ok, true, reverse.content);
    const forwardText = fs.readFileSync(path.join(forwardCwd, 'order.txt'), 'utf8');
    const reverseText = fs.readFileSync(path.join(reverseCwd, 'order.txt'), 'utf8');
    assert.strictEqual(forwardText, 'beta\ngamma\n');
    assert.strictEqual(reverseText, forwardText, 'عكس ترتيب الكتل غيّر الناتج');

    // المدى نفسه لكتلتين يرفض النداء كله ولا يكتب الجزء الأول.
    const collisionCwd = makeWorkspace(tempRoot, 'collision', { 'collision.txt': 'same\ntail\n' });
    const collisionSession = makeSession('collision-edit');
    await readFile(collisionCwd, 'collision.txt', collisionSession);
    const collision = await editFile(collisionCwd, { path: 'collision.txt', edits: [
      { old_string: 'same', new_string: 'ONE' },
      { old_string: 'same', new_string: 'TWO' },
    ] }, collisionSession);
    assert.strictEqual(collision.ok, false);
    assert.match(collision.content, /تتصادمان/);
    assert.match(collision.content, /لم يُكتب شيء/);
    assert.strictEqual(fs.readFileSync(path.join(collisionCwd, 'collision.txt'), 'utf8'), 'same\ntail\n');
    assert.deepStrictEqual(collisionSession.events, []);

    // فشل أي كتلة أخرى ذرّي أيضاً، حتى لو كانت كتلة سابقة صالحة.
    const atomicCwd = makeWorkspace(tempRoot, 'atomic', { 'atomic.txt': 'one\ntwo\n' });
    const atomicSession = makeSession('atomic-edit');
    await readFile(atomicCwd, 'atomic.txt', atomicSession);
    const atomic = await editFile(atomicCwd, { path: 'atomic.txt', edits: [
      { old_string: 'one', new_string: 'ONE' },
      { old_string: 'missing', new_string: 'MISSING' },
    ] }, atomicSession);
    assert.strictEqual(atomic.ok, false);
    assert.match(atomic.content, /الكتلة 2/);
    assert.strictEqual(fs.readFileSync(path.join(atomicCwd, 'atomic.txt'), 'utf8'), 'one\ntwo\n');
    assert.deepStrictEqual(atomicSession.events, []);

    // اختلاف tabs/spaces في طرفي السطر يقبل التطابق الوحيد ويحفظ إزاحة الملف وCRLF.
    const fuzzyBefore = 'function demo() {\r\n    return 1;   \r\n}\r\n';
    const fuzzyCwd = makeWorkspace(tempRoot, 'fuzzy', { 'fuzzy.js': fuzzyBefore });
    const fuzzySession = makeSession('fuzzy-edit');
    await readFile(fuzzyCwd, 'fuzzy.js', fuzzySession);
    const fuzzy = await editFile(fuzzyCwd, {
      path: 'fuzzy.js', old_string: '\treturn 1;\t', new_string: 'return 2;',
    }, fuzzySession);
    assert.strictEqual(fuzzy.ok, true, fuzzy.content);
    assert.match(fuzzy.content, /تطبيع المسافات/);
    assert.strictEqual(fs.readFileSync(path.join(fuzzyCwd, 'fuzzy.js'), 'utf8'),
      'function demo() {\r\n    return 2;\r\n}\r\n');

    // التطابق المتعدد بعد التطبيع مرفوض حتى مع replace_all: true.
    const ambiguousBefore = '  target();\n\ttarget();\n';
    const ambiguousCwd = makeWorkspace(tempRoot, 'ambiguous', { 'ambiguous.js': ambiguousBefore });
    const ambiguousSession = makeSession('ambiguous-edit');
    await readFile(ambiguousCwd, 'ambiguous.js', ambiguousSession);
    const ambiguous = await editFile(ambiguousCwd, {
      path: 'ambiguous.js', old_string: '    target();    ', new_string: 'done();', replace_all: true,
    }, ambiguousSession);
    assert.strictEqual(ambiguous.ok, false);
    assert.match(ambiguous.content, /تطابق 2 مواضع بعد تطبيع/);
    assert.strictEqual(fs.readFileSync(path.join(ambiguousCwd, 'ambiguous.js'), 'utf8'), ambiguousBefore);
    assert.deepStrictEqual(ambiguousSession.events, []);

    // الارتداد لا يطوي فراغاً داخلياً: التسامح محصور بالبادئة/اللاحقة.
    const strictCwd = makeWorkspace(tempRoot, 'strict-whitespace', { 'strict.js': '  call(  value );\n' });
    const strictSession = makeSession('strict-edit');
    await readFile(strictCwd, 'strict.js', strictSession);
    const strict = await editFile(strictCwd, {
      path: 'strict.js', old_string: 'call( value ); ', new_string: 'done();',
    }, strictSession);
    assert.strictEqual(strict.ok, false);
    assert.match(strict.content, /غير موجودة حرفياً ولا بعد تطبيع/);
    assert.strictEqual(fs.readFileSync(path.join(strictCwd, 'strict.js'), 'utf8'), '  call(  value );\n');

    // replace_all في الصيغة الأحادية يحافظ على السلوك القديم حرفياً.
    const replaceAllCwd = makeWorkspace(tempRoot, 'replace-all', { 'all.txt': 'x x x\n' });
    const replaceAllSession = makeSession('replace-all-edit');
    await readFile(replaceAllCwd, 'all.txt', replaceAllSession);
    const replaceAll = await editFile(replaceAllCwd, {
      path: 'all.txt', old_string: 'x', new_string: 'y', replace_all: true,
    }, replaceAllSession);
    assert.deepStrictEqual(replaceAll, { ok: true, content: 'عُدّل الملف all.txt (3 مواضع)' });
    assert.strictEqual(fs.readFileSync(path.join(replaceAllCwd, 'all.txt'), 'utf8'), 'y y y\n');

    // readBefore يبقى حاجز الحجم قبل أي تخطيط أو كتابة.
    const huge = 'a'.repeat(2 * 1024 * 1024 + 1);
    const hugeCwd = makeWorkspace(tempRoot, 'huge', { 'huge.txt': huge });
    const hugeSession = makeSession('huge-edit');
    await readFile(hugeCwd, 'huge.txt', hugeSession);
    const hugeEdit = await editFile(hugeCwd, {
      path: 'huge.txt', old_string: 'a', new_string: 'b', replace_all: true,
    }, hugeSession);
    assert.strictEqual(hugeEdit.ok, false);
    assert.match(hugeEdit.content, /أكبر من حدّ التعديل \(2م\.ب\)/);
    assert.strictEqual(fs.statSync(path.join(hugeCwd, 'huge.txt')).size, 2 * 1024 * 1024 + 1);

    console.log('✓ بوابة اقرأ-قبل-عدّل معزولة للجلسة وتصرّح بحدّ أدوات سطر');
    console.log('✓ النداء الأحادي وreplace_all ولقطة التراجع باقية');
    console.log('✓ الكتل المتعددة غير مرتبة وذرّية، والتصادم/الفشل لا يكتبان جزئياً');
    console.log('✓ ارتداد المسافات يعمل للوحيد ويرفض المتعدد ولا يطوي الفراغ الداخلي');
    console.log('✓ طبقة الإذن وسقف المصدر 2م.ب باقيان');
    console.log('tools-edit-test: ok');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('tools-edit-test: FAIL');
  console.error(error && error.stack || error);
  process.exit(1);
});
