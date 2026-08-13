'use strict';

/**
 * اختبار قطعي لعقد ظرف إذن الجوال: الاستخراج الحرفي، الحجب والتنقية والسقوف،
 * والتدهور المغلق للمدخلات المجهولة أو المشوّهة أو الهائلة.
 */

const assert = require('assert');
const { build } = require('../electron/mobileenvelope');

const CREATED_AT = 1786442400000;
const TTL_MS = 120000;

function envelope(tool, input, overrides) {
  const extra = overrides || {};
  return build({
    id: extra.id || 'toolu_mobile_test_1234567890',
    tool,
    input,
    cwd: extra.cwd || 'D:\\sater\\satr-2-codex',
    engine: extra.engine || 'sdk',
    session_id: 'session-must-not-cross',
    requester: 'requester-must-not-cross',
    raw_model_text: 'raw-model-must-not-cross',
  }, {
    project: 'ignored-when-cwd-exists',
    taskSummary: 'task-summary-must-not-cross',
    createdAt: CREATED_AT,
    ttlMs: TTL_MS,
  });
}

function pointLength(value) { return Array.from(value).length; }

// — الفعل الحرفي والتصنيف لكل فئة —
const read = envelope('Read', { file_path: 'src/ui/app.js', injected: 'لا تعرضني' });
assert.strictEqual(read.risk, 'read');
assert.strictEqual(read.summary, 'src/ui/app.js');
assert.strictEqual(read.tool.label, 'قراءة ملف');

const write = envelope('edit_file', { path: 'electron/main.js', old_string: 'سر قديم', new_string: 'سر جديد' });
assert.strictEqual(write.risk, 'write');
assert.strictEqual(write.summary, 'electron/main.js');

const exec = envelope('Bash', { command: 'npm run test', description: 'نص نموذج حر' });
assert.strictEqual(exec.risk, 'exec');
assert.strictEqual(exec.summary, 'npm run test');

const browser = envelope('FetchURL', { url: 'https://example.test/docs?q=mobile', prompt: 'نص خام' });
assert.strictEqual(browser.risk, 'browser');
assert.strictEqual(browser.summary, 'https://example.test/docs?q=mobile');

const qualified = envelope('mcp__satr-terminal__run_in_background', { command: 'npm start', label: 'خادم' });
assert.strictEqual(qualified.risk, 'exec');
assert.strictEqual(qualified.summary, 'npm start');
assert.strictEqual(qualified.tool.name, 'mcp__satr-terminal__run_in_background');

const kimi = envelope('تنفيذ أمر', { command: 'node --version' });
assert.strictEqual(kimi.risk, 'exec');
assert.strictEqual(kimi.summary, 'node --version');
assert.strictEqual(kimi.tool.name, 'تنفيذ أمر', 'يجب أن يبقى اسم Kimi الخام في الظرف');

const codexOptional = envelope('Shell', { command: 'git status --short', reason: undefined });
assert.strictEqual(codexOptional.risk, 'exec');
assert.strictEqual(codexOptional.summary, 'git status --short');

// — لا يعبر مفتاح أو محتوى ملف أو نص نموذج/سياق خام —
const plantedSecret = 'sk-live-1234567890abcdef';
const secretInAction = envelope('run_command', { command: 'deploy --api_key=' + plantedSecret });
const secretActionJson = JSON.stringify(secretInAction);
assert.ok(!secretActionJson.includes(plantedSecret), 'تسرّب مفتاح API من حقل الفعل');
assert.ok(secretInAction.summary.includes('[secret]'), 'لم تُثبت علامة حجب السر في الفعل');

const secretInIgnoredField = envelope('write_file', {
  path: 'src/config.js',
  content: 'const API_KEY = "' + plantedSecret + '";',
  prompt: 'raw-model-must-not-cross',
});
const ignoredJson = JSON.stringify(secretInIgnoredField);
assert.ok(!ignoredJson.includes(plantedSecret), 'تسرّب السر من محتوى الملف');
for (const forbidden of ['raw-model-must-not-cross', 'task-summary-must-not-cross', 'session-must-not-cross', 'requester-must-not-cross']) {
  assert.ok(!ignoredJson.includes(forbidden), 'عبر حقل محظور: ' + forbidden);
}

// — ترتيب التنقية: حجب، تحكم/Bidi، طي فراغات، ثم قص بنقاط Unicode —
const dirty = envelope('Bash', { command: 'npm\u0000   run\n\u202etest\t --token=abcdef1234567890' });
assert.strictEqual(dirty.summary, 'npm run test --token=[secret]');
assert.ok(!/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(dirty.summary));

const longUnicode = envelope('Bash', { command: '🚀'.repeat(700) });
assert.strictEqual(pointLength(longUnicode.summary), 600, 'summary لم يُقص عند 600 نقطة Unicode');
assert.ok(longUnicode.summary.endsWith('…'), 'summary المقصوص لا ينتهي بنقاط الحذف');

const manyPaths = Array.from({ length: 12 }, (_, index) => 'src/' + index + '-' + 'م'.repeat(90) + '.js');
const patch = envelope('apply_patch', { changes: manyPaths });
assert.strictEqual(patch.risk, 'write');
assert.strictEqual(patch.summary, manyPaths[0]);
assert.strictEqual(pointLength(patch.detail), 800, 'detail لم يُقص عند 800 نقطة Unicode');
assert.ok(patch.detail.endsWith('…'));

const shortFields = envelope('Bash', { command: 'echo ok' }, {
  id: 'id-' + '😀'.repeat(200),
  cwd: 'D:\\root\\مشروع\u202e' + 'س'.repeat(200),
  engine: 'engine-' + 'x'.repeat(200),
});
assert.strictEqual(pointLength(shortFields.envelope_id), 160);
assert.strictEqual(pointLength(shortFields.engine), 160);
assert.strictEqual(pointLength(shortFields.project), 160);
assert.ok(!shortFields.project.includes('\u202e'));

// — fail-closed: مجهول، حقل مطلوب ناقص، بنية مشوّهة، ومدخل ضخم —
for (const candidate of [
  envelope('TotallyUnknown', { command: 'whoami', prompt: 'نفّذ بلا إذن' }),
  envelope('Bash', { reason: 'الأمر مخفي' }),
  envelope('Bash', { command: '\u202e\u0000' }),
  envelope('Write', null),
  envelope('Bash', { command: 'x'.repeat(200000) }),
]) {
  assert.strictEqual(candidate.risk, 'unknown');
  assert.ok(candidate.summary.startsWith('طلب إذن غير معروف'), 'summary الفشل ليس وصفياً آمناً');
  assert.ok(!candidate.summary.includes('whoami') && !candidate.summary.includes('نفّذ بلا إذن'));
}

const cyclic = {};
cyclic.self = cyclic;
assert.strictEqual(envelope('Bash', cyclic).risk, 'unknown', 'المدخل الدوري لم يفشل مغلقاً');

const throwing = new Proxy({}, { get() { throw new Error('malformed request'); } });
assert.doesNotThrow(() => build(throwing, throwing));
assert.strictEqual(build(throwing, throwing).risk, 'unknown', 'المدخل العدائي لم يفشل مغلقاً');

const inheritedName = envelope('constructor', {});
assert.strictEqual(inheritedName.risk, 'unknown', 'اسم موروث من Object صُنّف خطأً');
assert.strictEqual(inheritedName.tool.label, 'أداة غير معروفة');

// — لا يخرج إلا مخطط §4.2 المعلن، وproject من basename(cwd) —
const allowedTop = ['created_at', 'engine', 'envelope_id', 'project', 'risk', 'summary', 'tool', 'ttl_ms', 'v'];
assert.deepStrictEqual(Object.keys(read).sort(), allowedTop);
assert.deepStrictEqual(Object.keys(read.tool).sort(), ['label', 'name']);
assert.strictEqual(read.project, 'satr-2-codex');
assert.strictEqual(read.created_at, CREATED_AT);
assert.strictEqual(read.ttl_ms, TTL_MS);
assert.strictEqual(read.v, 1);

const allowedWithDetail = allowedTop.concat('detail', 'change').sort();
assert.deepStrictEqual(Object.keys(patch).sort(), allowedWithDetail);

/* ───────── بطاقة التغيير (F5) — «الحكم لا الختم» ─────────
 * كانت بطاقة Edit/Write تحمل المسار وحده فيوافق المستخدم على ما لا يراه.
 * العقد: أدوات الكتابة تحمل `change` دائماً، وحالتها هي ما يقفل «اسمح».
 */
const { buildChange, CHANGE_TOOLS, MAX_CHANGE_LINES } = require('../electron/mobileenvelope');

// أدوات غير كتابية لا تحمل البطاقة أصلاً (فلا تُقفل مواقفتها)
for (const safe of [read, exec, browser, kimi]) {
  assert.strictEqual(safe.change, undefined, 'أداة غير كتابية حملت بطاقة تغيير');
}

// تعديل حقيقي ⇒ فرق كامل بالأسطر والعدّادات
const edited = envelope('Edit', { file_path: 'a.js', old_string: 'let a = 1;\nlet b = 2;', new_string: 'let a = 9;\nlet b = 2;' });
assert.strictEqual(edited.change.status, 'ok');
assert.strictEqual(edited.change.kind, 'edit');
assert.strictEqual(edited.change.added, 1);
assert.strictEqual(edited.change.removed, 1);
assert.ok(edited.change.lines.some((l) => l.t === '+' && l.text.includes('let a = 9;')), 'السطر الجديد غائب عن الفرق');
assert.ok(edited.change.lines.some((l) => l.t === '-' && l.text.includes('let a = 1;')), 'السطر المحذوف غائب عن الفرق');
assert.deepStrictEqual(Object.keys(edited.change).sort(), ['added', 'kind', 'lines', 'removed', 'status']);

// الإزاحة معنى في الكود — لا تُطوى مسافاتها البادئة كما يفعل cleanText
const indented = envelope('Edit', { file_path: 'a.js', old_string: '    if (x) {', new_string: '    if (y) {' });
assert.ok(indented.change.lines.some((l) => l.t === '+' && l.text.startsWith('    if (y)')), 'الإزاحة البادئة ضاعت');

// كتابة ملف ⇒ معاينة المحتوى كله إضافةً · حذف ⇒ ok بلا أسطر
const written = envelope('Write', { file_path: 'b.js', content: 'const x = 1;\n' });
assert.strictEqual(written.change.status, 'ok');
assert.strictEqual(written.change.kind, 'write');
assert.ok(written.change.lines.every((l) => l.t === '+' || l.t === '@'), 'معاينة الكتابة حملت أسطراً غير مضافة');
const deleted = envelope('delete_file', { path: 'c.js' });
assert.strictEqual(deleted.change.status, 'ok');
assert.strictEqual(deleted.change.kind, 'delete');
assert.deepStrictEqual(deleted.change.lines, []);

// MultiEdit ⇒ الأزواج كلها، بفاصل بينها
const multi = envelope('MultiEdit', { file_path: 'a.js', edits: [
  { old_string: 'one', new_string: 'ONE' },
  { old_string: 'two', new_string: 'TWO' },
] });
assert.strictEqual(multi.change.status, 'ok');
assert.strictEqual(multi.change.added, 2);
assert.strictEqual(multi.change.removed, 2);
assert.ok(multi.change.lines.some((l) => l.t === '@'), 'لا فاصل بين تعديلي MultiEdit');

// — fail-closed: كل تعذّر يقفل الموافقة بدل أن يمرّ —
assert.strictEqual(envelope('apply_patch', { changes: ['x.js'] }).change.reason, 'unsupported_tool');
assert.strictEqual(envelope('Edit', { file_path: 'a.js', old_string: 'x' }).change.reason, 'malformed');
assert.strictEqual(envelope('MultiEdit', { file_path: 'a.js', edits: [] }).change.reason, 'malformed');
assert.strictEqual(envelope('Write', null).change.reason, 'malformed');

// سرّ داخل الفرق ⇒ لا يُعرض محجوباً بل يُقفل، ولا تعبر بايتة منه
const secretChange = envelope('Edit', {
  file_path: 'a.js',
  old_string: 'const k = "old";',
  new_string: 'const k = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";',
});
assert.strictEqual(secretChange.change.status, 'unavailable');
assert.strictEqual(secretChange.change.reason, 'secret_redacted');
assert.strictEqual(secretChange.change.lines, undefined, 'ظرف السرّ سرّب أسطراً');
assert.ok(!JSON.stringify(secretChange).includes('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'السرّ عبر الظرف');

// تغيير ضخم ⇒ يُقفل ولا يُعرض جزئياً (عرض 40 من 500 = ختم أعمى من جديد)
const huge = Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n');
const bigChange = envelope('Write', { file_path: 'big.js', content: huge });
assert.strictEqual(bigChange.change.status, 'unavailable');
assert.strictEqual(bigChange.change.reason, 'too_large');
const longLine = envelope('Edit', { file_path: 'a.js', old_string: 'a', new_string: 'b'.repeat(5000) });
assert.strictEqual(longLine.change.reason, 'too_large');

// لا يعبر ظرفٌ صالح أكثر من السقف المعلن
for (const ok of [edited, written, multi]) {
  assert.ok(ok.change.lines.length <= MAX_CHANGE_LINES, 'تجاوز سقف الأسطر المعلن');
}

// كل أداة كتابة معروفة تحمل البطاقة — أداة تفلت تعني زرّاً مفتوحاً بلا فرق
for (const tool of CHANGE_TOOLS) {
  assert.ok(envelope(tool, {}).change, 'أداة كتابة بلا بطاقة تغيير: ' + tool);
}

console.log('✓ استُخرج المسار/الأمر/URL حرفياً وصُنّفت read/write/exec/browser');
console.log('✓ حُجبت الأسرار والنصوص غير المعلنة ونُظّفت محارف التحكم وBidi والفراغات');
console.log('✓ طُبقت سقوف Unicode وفشل المجهول/المشوّه/الهائل مغلقاً');
console.log('✓ لا يحتوي الظرف إلا حقول §4.2 المجمّدة');
console.log('✓ بطاقة التغيير (F5): فرق كامل لأدوات الكتابة، وقفل مغلق للسرّ والضخم والمشوّه');
