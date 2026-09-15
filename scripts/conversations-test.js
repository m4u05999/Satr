#!/usr/bin/env node
'use strict';

// جميع الملفات التي ينشئها الحارس داخل مجلد مؤقت معلوم؛ لا يلمس منزل المالك.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const selected = process.argv.find((value) => value.startsWith('--module='));
const conversations = require(selected ? path.resolve(selected.slice('--module='.length)) : '../electron/conversations');
const readerSelected = process.argv.find((value) => value.startsWith('--reader-module='));
const sessions = require(readerSelected ? path.resolve(readerSelected.slice('--reader-module='.length)) : '../electron/sessions');

const codexReaderSelected = process.argv.find((value) => value.startsWith('--codex-reader-module='));
const codexSessions = require(codexReaderSelected ? path.resolve(codexReaderSelected.slice('--codex-reader-module='.length)) : '../electron/codexsessions');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-conversations-test-'));
const project = path.join(temp, 'project');
const otherProject = path.join(temp, 'other-project');
const storeRoot = path.join(temp, 'store');
fs.mkdirSync(project);
fs.mkdirSync(otherProject);
const store = conversations.createStore({ root: storeRoot });
let passed = 0;

function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function ok(result) { assert.strictEqual(result.ok, true, JSON.stringify(result)); return result; }
function begin(prompt, extra = {}) { return ok(store.prepare({ cwd: project, engine: 'sdk', prompt, ...extra })); }
function init(run, sessionId) { return ok(store.acceptEvent(run.runId, { type: 'system', subtype: 'init', session_id: sessionId })); }
function assistant(run, text, extra = {}) {
  return ok(store.acceptEvent(run.runId, { type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra }));
}
function complete(run, text = '') {
  if (text) assistant(run, text);
  return ok(store.acceptEvent(run.runId, { type: 'result', is_error: false }));
}
function read(id, cwd = project) { return ok(store.load(id, cwd)).conversation; }
function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? allFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
function storageText() { return allFiles(storeRoot).filter((name) => name.endsWith('.json')).map((name) => fs.readFileSync(name, 'utf8')).join('\n'); }

async function main() {
try {
  let original;
  test('يحفظ نص المستخدم الأصلي فور الإرسال مع هوية مستقرة', () => {
    original = begin('  لا تنشر أي تغييرات.\nاحفظ الأرقام كما هي: ٠١٢٣  ');
    assert(conversations.SAFE_ID.test(original.id));
    const saved = read(original.id);
    assert.strictEqual(saved.messages.length, 1);
    assert.strictEqual(saved.messages[0].text, '  لا تنشر أي تغييرات.\nاحفظ الأرقام كما هي: ٠١٢٣  ');
    assert.strictEqual(saved.messages[0].role, 'user');
    assert.strictEqual(saved.runs[0].status, 'running');
    assert.strictEqual(original.context, '');
    assert.strictEqual(ok(store.latest(project)).conversation.id, original.id);
    assert.strictEqual(begin('طلب مستقل').id === original.id, false);
    assert.strictEqual(store.prepare({ cwd: project, engine: 'sdk', conversationId: original.id, prompt: 'متزامن' }).error, 'conversation_busy');
  });

  test('يسجل النهائي مرة واحدة ويتجاهل صدى المستخدم ومدخلات الأدوات', () => {
    init(original, 'sdk-original');
    ok(store.acceptEvent(original.runId, { type: 'user', message: { content: 'سياق محقون لا يُحفظ' } }));
    ok(store.acceptEvent(original.runId, { type: 'stream_text', text: 'رد نهائي' }));
    const final = { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'رد نهائي' }] } };
    ok(store.acceptEvent(original.runId, final));
    ok(store.acceptEvent(original.runId, JSON.parse(JSON.stringify(final))));
    ok(store.acceptEvent(original.runId, {
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'exec', input: { command: 'DONOTSTORE-TOOL-INPUT' } }] },
    }));
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'اختبار ناجح '.repeat(300), is_error: false }] } };
    ok(store.acceptEvent(original.runId, result));
    ok(store.acceptEvent(original.runId, JSON.parse(JSON.stringify(result))));
    ok(store.recordUser(original.runId, 'ألغِ طلب البناء السابق؛ أبقِ التعديلات محلية.'));
    complete(original);
    const saved = read(original.id);
    assert.strictEqual(saved.messages.filter((message) => message.text === 'رد نهائي').length, 1);
    assert.strictEqual(saved.messages.filter((message) => message.role === 'tool_result').length, 1);
    assert(saved.messages.find((message) => message.role === 'tool_result').issues.includes('tool_excerpt'));
    assert(!storageText().includes('DONOTSTORE-TOOL-INPUT'));
    assert(!storageText().includes('سياق محقون لا يُحفظ'));
    assert.strictEqual(saved.bindings.sdk.lastCompletedRevision, saved.revision);
    assert.strictEqual(ok(store.acceptEvent(original.runId, { type: 'proc_done', code: 0 })).status, 'completed');
    assert.strictEqual(ok(store.stop(original.runId)).status, 'completed');
    assert.strictEqual(read(original.id).runs[0].status, 'completed');
  });

  let switched;
  test('ينقل أقدم قيد والتصحيح والإلغاء بترتيب المصدر مع استبعاد الطلب الحالي', () => {
    switched = begin('CURRENT-PROMPT-EXCLUDED', { engine: 'codex', conversationId: original.id });
    assert.strictEqual(switched.sessionId, '');
    assert(switched.context.includes('لا تنشر أي تغييرات.'), 'أقدم قيد للمستخدم يجب أن يصل إلى المحرك البديل');
    assert(switched.context.includes('ألغِ طلب البناء السابق'));
    assert(switched.context.indexOf('لا تنشر') < switched.context.indexOf('ألغِ طلب'));
    assert(!switched.context.includes('CURRENT-PROMPT-EXCLUDED'));
    assert(switched.context.includes('"conversationId":"' + original.id + '"'));
    assert(switched.context.includes('"engine":"sdk"'));
    assert.strictEqual(switched.transfer.coverage.complete, false);
    assert(switched.transfer.coverage.issues.includes('tool_excerpt'));
    init(switched, 'codex-original');
    complete(switched, 'تعديل Codex الجديد');
  });

  test('العودة للمحرك السابق تنقل الزيادة مرة واحدة فقط', () => {
    const back = begin('ارجع الآن', { conversationId: original.id });
    assert.strictEqual(back.sessionId, 'sdk-original');
    assert(back.context.includes('CURRENT-PROMPT-EXCLUDED'));
    assert(back.context.includes('تعديل Codex الجديد'));
    assert(!back.context.includes('لا تنشر أي تغييرات.'));
    complete(back, 'تم استيعاب الزيادة');
    const again = begin('أكمل', { conversationId: original.id });
    assert.strictEqual(again.context, '');
    assert.strictEqual(again.transfer.needed, false);
    complete(again);
    assert.strictEqual(read(original.id).bindings.sdk.lastCompletedRevision, read(original.id).revision);
  });

  test('لا يخلط جلسات أو مشاريع أو معرفات ولا يسمح بربط جلسة مرتين', () => {
    assert.strictEqual(ok(store.findBySession(project, 'sdk', 'sdk-original')).conversation.id, original.id);
    assert.strictEqual(ok(store.findBySession(otherProject, 'sdk', 'sdk-original')).conversation, null);
    assert.strictEqual(read(original.id, otherProject), null);
    assert.strictEqual(store.load('../outside', project).error, 'bad_id');
    assert.strictEqual(store.load(original.id, 'relative/path').error, 'bad_cwd');
    assert.strictEqual(store.create({ cwd: project, engine: 'sdk', sessionId: 'sdk-original' }).error, 'session_already_bound');
    assert.strictEqual(store.prepare({ cwd: project, engine: 'sdk', conversationId: original.id, sessionId: 'wrong-session', prompt: 'خطأ' }).error, 'session_mismatch');
    assert.strictEqual(store.prepare({ cwd: project, engine: '__proto__', prompt: 'خطأ' }).error, 'bad_engine_or_session');
    const separate = begin('مستقلة أخرى');
    assert.strictEqual(store.acceptEvent(separate.runId, { type: 'system', subtype: 'init', session_id: 'sdk-original' }).error, 'session_already_bound');
    ok(store.stop(separate.runId));
  });

  test('تطبيع realpath وويندوز يصل إلى المشروع نفسه، وforget يحذف المؤشر فقط', () => {
    const alias = path.join(temp, 'project-alias');
    fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(conversations.normalizeCwd(alias), conversations.normalizeCwd(project));
    assert.strictEqual(read(original.id, alias).id, original.id);
    if (process.platform === 'win32') assert.strictEqual(read(original.id, project.toUpperCase()).id, original.id);
    ok(store.forget(project));
    assert.strictEqual(ok(store.latest(alias)).conversation, null);
    assert.strictEqual(read(original.id).id, original.id);
    const fresh = begin('جديدة بعد نسيان المؤشر');
    assert.notStrictEqual(fresh.id, original.id);
    ok(store.stop(fresh.runId));
  });

  test('تجاوز حزمة النقل يفشل صراحةً ولا يمنع الاستئناف الأصلي', () => {
    const long = begin('قيد قديم طويل '.repeat(150));
    init(long, 'sdk-long');
    complete(long, 'حُفظ القيد');
    const bounded = conversations.createStore({ root: storeRoot, maxTransferChars: 1000 });
    const native = ok(bounded.prepare({ cwd: project, engine: 'sdk', conversationId: long.id, prompt: 'رسالة عادية' }));
    assert.strictEqual(native.context, '');
    const before = read(long.id);
    const fallback = bounded.contextForRestart(native.runId);
    assert.strictEqual(fallback.error, 'transfer_limit');
    assert.strictEqual(fallback.context, '');
    assert(fallback.transfer.coverage.requiredChars > 1000);
    assert.strictEqual(read(long.id).bindings.sdk.valid, true);
    ok(bounded.acceptEvent(native.runId, { type: 'result' }));
    const beforeTransfer = read(long.id).revision;
    const transfer = bounded.prepare({ cwd: project, engine: 'codex', conversationId: long.id, prompt: 'نقل ممنوع' });
    assert.strictEqual(transfer.error, 'transfer_limit');
    assert.strictEqual(read(long.id).revision, beforeTransfer);
    assert(before.messages.some((message) => message.text.startsWith('قيد قديم طويل')));
  });

  test('الأسرار الظاهرة تُحجب على القرص ويُعلن نقص نقلها', () => {
    const secret = 'sk-proj-' + 'A1b2C3d4'.repeat(6);
    const current = begin('API_KEY=' + secret);
    init(current, 'sdk-secret');
    complete(current, 'استلمت القيمة');
    assert(!storageText().includes(secret));
    assert(read(current.id).messages[0].issues.includes('secret_redacted'));
    const native = begin('استمر في الجلسة نفسها', { conversationId: current.id });
    assert.strictEqual(native.context, '');
    complete(native);
    const alternate = store.prepare({ cwd: project, engine: 'codex', conversationId: current.id, prompt: 'انقل' });
    assert.strictEqual(alternate.error, 'transfer_incomplete');
    assert(alternate.transfer.coverage.issues.includes('secret_redacted'));
  });

  test('الصور وصفية فقط ويظهر أنها لم تنتقل', () => {
    const current = begin('راجع المرفق', { images: [{ media_type: 'image/png', data: 'PRIVATE-BASE64-IMAGE', path: 'PRIVATE-FILE-NAME' }] });
    init(current, 'sdk-image');
    complete(current);
    const next = begin('حوّل للمحرك الآخر', { engine: 'codex', conversationId: current.id });
    assert(next.context.includes('images_metadata_only'));
    assert(next.context.includes('"available":false'));
    assert.strictEqual(next.transfer.coverage.complete, false);
    assert(!storageText().includes('PRIVATE-BASE64-IMAGE'));
    assert(!storageText().includes('PRIVATE-FILE-NAME'));
    ok(store.stop(next.runId));
  });

  test('البذور الموثوقة تدعم استئناف القديم وتعلن التاريخ المفقود', () => {
    const seeded = begin('تابع القديم', { sessionId: 'legacy-full', seedMessages: [
      { role: 'user', text: 'قيد قديم من القارئ الأصلي' }, { role: 'assistant', text: 'رد محفوظ' },
    ], coverage: { complete: true } });
    assert.strictEqual(seeded.context, '');
    complete(seeded);
    const transferred = begin('بدّل', { engine: 'codex', conversationId: seeded.id });
    assert(transferred.context.includes('قيد قديم من القارئ الأصلي'));
    ok(store.stop(transferred.runId));
    const partial = begin('استأنف تاريخاً جزئياً', { sessionId: 'legacy-partial', seedMessages: [
      { role: 'user', text: 'ذيل فقط' },
    ], coverage: { complete: false } });
    complete(partial);
    assert.strictEqual(store.prepare({ cwd: project, engine: 'codex', conversationId: partial.id, prompt: 'نقل' }).error, 'transfer_incomplete');
    const empty = begin('استئناف بلا بذور', { sessionId: 'legacy-no-seed' });
    assert.strictEqual(empty.context, '');
    complete(empty);
    assert.strictEqual(store.prepare({ cwd: project, engine: 'codex', conversationId: empty.id, prompt: 'نقل' }).error, 'transfer_incomplete');
  });

  test('الإيقاف يحفظ البث الجزئي ويمنع تقدم مؤشر الإكمال', () => {
    const current = begin('أوقف المهمة عند طلبي');
    init(current, 'sdk-stop');
    complete(current, 'جاهز');
    const before = read(current.id).bindings.sdk.lastCompletedRevision;
    const running = begin('دور سيُوقف', { conversationId: current.id });
    const writeVersion = read(current.id).writeVersion;
    ok(store.acceptEvent(running.runId, { type: 'stream_text', text: 'جزء لم يكتمل' }));
    assert.strictEqual(read(current.id).writeVersion, writeVersion, 'دفعة البث لا تعيد كتابة كامل السجل على القرص');
    ok(store.recordUser(running.runId, 'ألغِ التنفيذ الآن.'));
    ok(store.stop(running.runId));
    const stopped = read(current.id);
    assert.strictEqual(stopped.bindings.sdk.lastCompletedRevision, before);
    // OBS-201: الإيقاف لا يُفقد الجلسة — الربط يبقى صالحاً والدور المقطوع يُنقل زيادةً إلى الجلسة نفسها.
    assert.strictEqual(stopped.bindings.sdk.valid, true);
    assert.strictEqual(stopped.runs.at(-1).status, 'stopped');
    assert(stopped.messages.some((message) => message.text === 'جزء لم يكتمل'));
    assert(stopped.messages.some((message) => message.text === 'ألغِ التنفيذ الآن.'));
    const recovered = begin('تابع بعد الإيقاف', { conversationId: current.id });
    assert.strictEqual(recovered.sessionId, 'sdk-stop');
    assert(recovered.context.includes('"status":"stopped"'));
    assert(recovered.context.includes('ألغِ التنفيذ الآن.'));
    assert(!recovered.context.includes('أوقف المهمة عند طلبي'), 'ما قبل آخر إكمال لا يُنقل إلى جلسة تملكه');
    complete(recovered);
  });

  test('الإيقاف في جلسة طويلة لا يحبسها خلف سقف النقل (OBS-201)', () => {
    // قبل الإصلاح: الإيقاف يُبطل الربط ⇒ الإرسال التالي ينقل التاريخ كله ⇒ transfer_limit ولا إرسال.
    const tight = conversations.createStore({ root: path.join(temp, 'store-tight'), maxTransferChars: 4000 });
    const start = ok(tight.prepare({ cwd: project, engine: 'sdk', prompt: 'بداية' }));
    ok(tight.acceptEvent(start.runId, { type: 'system', subtype: 'init', session_id: 'sdk-long' }));
    ok(tight.acceptEvent(start.runId, { type: 'assistant', message: { content: [{ type: 'text', text: 'ر'.repeat(3000) }] } }));
    ok(tight.acceptEvent(start.runId, { type: 'result', is_error: false }));
    const second = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'ثانية' }));
    ok(tight.acceptEvent(second.runId, { type: 'assistant', message: { content: [{ type: 'text', text: 'ن'.repeat(3000) }] } }));
    ok(tight.acceptEvent(second.runId, { type: 'result', is_error: false }));
    const interrupted = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'دور سيُوقف' }));
    ok(tight.acceptEvent(interrupted.runId, { type: 'stream_text', text: 'جزء' }));
    ok(tight.stop(interrupted.runId));
    const after = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'أكمل' }));
    assert.strictEqual(after.sessionId, 'sdk-long');
    assert(after.context.includes('دور سيُوقف'));
    assert(after.context.length < 4000);
    ok(tight.acceptEvent(after.runId, { type: 'stream_text', text: 'ط'.repeat(5000) }));
    ok(tight.stop(after.runId));
    // زيادة موقوفة تتجاوز السقف: الجلسة الأصلية تملكها، فيُسقط النقل ويُعلَن بدل حجب الإرسال.
    const oversized = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'ما زلت هنا' }));
    assert.strictEqual(oversized.sessionId, 'sdk-long');
    assert.strictEqual(oversized.context, '');
    assert.strictEqual(oversized.transfer.needed, false);
    assert.strictEqual(oversized.transfer.omitted, 'transfer_limit');
    assert(oversized.transfer.coverage.issues.includes('transfer_limit'));
    ok(tight.acceptEvent(oversized.runId, { type: 'result', is_error: false }));
    // الحجب الصريح يبقى لمحرك آخر لم يرَ التاريخ.
    assert.strictEqual(tight.prepare({ cwd: project, engine: 'codex', conversationId: start.id, prompt: 'انتقال' }).error, 'transfer_limit');
  });

  test('الفشل والدور اليتيم لا يحبسان الجلسة، وفقدها المعلن وحده يُبطلها برسالة صادقة (OBS-205)', () => {
    // قبل الإصلاح: prepare() يجد دوراً «جارياً» بعملية ميتة فيُبطل الربط ⇒ نقل التاريخ كله ⇒ transfer_limit
    // على كل إرسال، ولا يُحفظ شيء فيتكرر الفشل حرفياً. الفشل لأي سبب كان يسلك الفخ نفسه.
    const orphanRoot = path.join(temp, 'store-orphan');
    const tight = conversations.createStore({ root: orphanRoot, maxTransferChars: 4000 });
    const start = ok(tight.prepare({ cwd: project, engine: 'sdk', prompt: 'بداية' }));
    ok(tight.acceptEvent(start.runId, { type: 'system', subtype: 'init', session_id: 'sdk-orphan' }));
    ok(tight.acceptEvent(start.runId, { type: 'assistant', message: { content: [{ type: 'text', text: 'ر'.repeat(3000) }] } }));
    ok(tight.acceptEvent(start.runId, { type: 'result', is_error: false }));
    const second = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'ثانية' }));
    ok(tight.acceptEvent(second.runId, { type: 'assistant', message: { content: [{ type: 'text', text: 'ن'.repeat(3000) }] } }));
    ok(tight.acceptEvent(second.runId, { type: 'result', is_error: false }));
    // (١) فشل بعد بدء الدور (انقطاع الشبكة): الربط يبقى صالحاً.
    const dropped = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'سينقطع الاتصال' }));
    ok(tight.acceptEvent(dropped.runId, { type: 'system', subtype: 'init', session_id: 'sdk-orphan' }));
    assert.strictEqual(ok(tight.acceptEvent(dropped.runId, { type: 'proc_done', code: 1 })).status, 'failed');
    let saved = ok(tight.load(start.id, project)).conversation;
    assert.strictEqual(saved.bindings.sdk.valid, true, 'فشل الشبكة لا يُفقد الجلسة');
    // (٢) فشل قبل أي إشارة بدء (تعذّر إقلاع أو انتهاء الدخول): قرار المالك — الربط يبقى أيضاً.
    const early = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'لن يقلع' }));
    assert.strictEqual(early.sessionId, 'sdk-orphan');
    assert.strictEqual(ok(tight.acceptEvent(early.runId, { type: 'spawn_error' })).status, 'failed');
    assert.strictEqual(ok(tight.load(start.id, project)).conversation.bindings.sdk.valid, true, 'تعذّر الإقلاع ليس دليلاً على فقد الجلسة');
    // (٣) دور يتيم: العملية ماتت قبل أي حدث إنهاء (إعادة تشغيل الجهاز) وبلا أي خرج من المحرك.
    const orphan = ok(tight.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'دور ستموت عمليته' }));
    const deadChild = require('child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    const file = allFiles(orphanRoot).find((name) => path.basename(name) === start.id + '.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const legacy = onDisk.runs.find((run) => run.id === orphan.runId);
    assert.strictEqual(legacy.status, 'running');
    legacy.pid = deadChild.pid;
    fs.writeFileSync(file, JSON.stringify(onDisk));
    const restarted = conversations.createStore({ root: orphanRoot, maxTransferChars: 4000 });
    const after = ok(restarted.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'أكمل بعد إعادة التشغيل' }));
    assert.strictEqual(after.sessionId, 'sdk-orphan', 'الدور اليتيم لا يُبطل الجلسة');
    assert(after.context.includes('"status":"interrupted"'));
    assert(after.context.includes('دور ستموت عمليته'));
    assert(after.context.includes('سينقطع الاتصال'));
    assert(after.context.includes('لن يقلع'));
    assert(!after.context.includes('بداية'), 'ما قبل آخر إكمال لا يُنقل إلى جلسة تملكه');
    saved = ok(restarted.load(start.id, project)).conversation;
    assert.strictEqual(saved.runs.find((run) => run.id === orphan.runId).status, 'interrupted');
    assert.strictEqual(saved.bindings.sdk.valid, true);
    ok(restarted.acceptEvent(after.runId, { type: 'result', is_error: false }));
    // (٤) الجلسة مفقودة فعلاً: الحدث المقيس حياً من SDK وحده يُبطل الربط، ولا يُعدّ result الخاطئ ربطاً.
    const missing = ok(restarted.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'استئناف جلسة محذوفة' }));
    assert.strictEqual(ok(restarted.acceptEvent(missing.runId, {
      type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sdk-orphan',
      errors: ['No conversation found with session ID: sdk-orphan'],
    })).status, 'failed');
    assert.strictEqual(ok(restarted.acceptEvent(missing.runId, { type: 'spawn_error', kind: 'exit_after_result' })).ignored, true);
    assert.strictEqual(ok(restarted.load(start.id, project)).conversation.bindings.sdk.valid, false, 'فقد الجلسة المعلن يُبطل الربط');
    // وفي المحادثة الطويلة المخرج الصادق «جلسة جديدة» لا «عُد إلى المحرك السابق».
    const lost = restarted.prepare({ cwd: project, engine: 'sdk', conversationId: start.id, prompt: 'بعد الفقد' });
    assert.strictEqual(lost.error, 'session_lost');
    assert.strictEqual(lost.cause, 'transfer_limit');
    assert(!ok(restarted.load(start.id, project)).conversation.messages.some((message) => message.text === 'بعد الفقد'));
    // والانتقال إلى محرك آخر يبقى على رسالته الأصلية.
    assert.strictEqual(restarted.prepare({ cwd: project, engine: 'codex', conversationId: start.id, prompt: 'انتقال' }).error, 'transfer_limit');
    // والمحادثة القصيرة بعد الفقد تُعاد بناءً من السجل كما يقضي العقد.
    const shortRoot = path.join(temp, 'store-missing-short');
    const small = conversations.createStore({ root: shortRoot });
    const first = ok(small.prepare({ cwd: project, engine: 'sdk', prompt: 'قيد قصير' }));
    ok(small.acceptEvent(first.runId, { type: 'system', subtype: 'init', session_id: 'sdk-short' }));
    ok(small.acceptEvent(first.runId, { type: 'result', is_error: false }));
    const gone = ok(small.prepare({ cwd: project, engine: 'sdk', conversationId: first.id, prompt: 'استأنف' }));
    ok(small.acceptEvent(gone.runId, { type: 'result', is_error: true, result: 'No conversation found with session ID: sdk-short' }));
    const rebuilt = ok(small.prepare({ cwd: project, engine: 'sdk', conversationId: first.id, prompt: 'أعد البناء' }));
    assert.strictEqual(rebuilt.sessionId, '');
    assert(rebuilt.context.includes('قيد قصير'));
    ok(small.stop(rebuilt.runId));
  });

  test('استبدال جلسة مفقودة يحتاج حزمة كاملة ويُحظر بعد بدء التنفيذ', () => {
    const current = begin('قيد لاستعادة جلسة مفقودة');
    init(current, 'sdk-missing');
    complete(current, 'رد سابق');
    const retry = begin('CURRENT-RETRY-PROMPT', { conversationId: current.id });
    assert.strictEqual(store.acceptEvent(retry.runId, { type: 'system', subtype: 'init', session_id: 'sdk-replaced' }).error, 'session_mismatch');
    const restart = ok(store.contextForRestart(retry.runId));
    assert(restart.context.includes('قيد لاستعادة جلسة مفقودة'));
    assert(!restart.context.includes('CURRENT-RETRY-PROMPT'));
    init(retry, 'sdk-replaced');
    complete(retry, 'استعادة سليمة');
    assert.strictEqual(ok(store.findBySession(project, 'sdk', 'sdk-missing')).conversation.id, current.id);
    assert.strictEqual(store.create({ cwd: project, engine: 'sdk', sessionId: 'sdk-missing' }).error, 'session_already_bound');
    const progressed = begin('بدأ التنفيذ', { conversationId: current.id });
    assistant(progressed, 'أجريت خطوة');
    assert.strictEqual(store.contextForRestart(progressed.runId).error, 'restart_after_progress');
    ok(store.stop(progressed.runId));
  });

  test('يحفظ توجيه المستخدم إن سبق result إقرار قبوله ولا يدعي اكتماله', () => {
    const current = begin('دور سريع');
    init(current, 'sdk-late-steer');
    complete(current, 'اكتمل قبل وصول الإقرار');
    const completedRevision = read(current.id).bindings.sdk.lastCompletedRevision;
    const late = ok(store.recordUser(current.runId, 'توجيه مقبول وصل إقراره متأخراً'));
    assert.strictEqual(late.late, true);
    assert.strictEqual(read(current.id).messages.at(-1).text, 'توجيه مقبول وصل إقراره متأخراً');
    assert.strictEqual(read(current.id).bindings.sdk.lastCompletedRevision, completedRevision);
    // OBS-205 (قرار المالك): التوجيه المتأخر لا يُبطل الربط؛ يُنقل زيادةً إلى الجلسة نفسها.
    assert.strictEqual(read(current.id).bindings.sdk.valid, true);
    const next = begin('تابع مع التوجيه', { conversationId: current.id });
    assert(next.context.includes('توجيه مقبول وصل إقراره متأخراً'));
    ok(store.stop(next.runId));
  });

  test('النص الضخم والبث الضخم يعلنان الفقد ولا يمران كحزمة كاملة', () => {
    const huge = begin('ح'.repeat(270000));
    init(huge, 'sdk-huge');
    complete(huge);
    assert(read(huge.id).messages[0].issues.includes('text_too_large'));
    assert.strictEqual(store.prepare({ cwd: project, engine: 'codex', conversationId: huge.id, prompt: 'نقل' }).error, 'transfer_incomplete');
    const stream = begin('بث ضخم');
    init(stream, 'sdk-huge-stream');
    ok(store.acceptEvent(stream.runId, { type: 'stream_text', text: 'ع'.repeat(270000) }));
    ok(store.stop(stream.runId));
    assert(read(stream.id).messages.at(-1).issues.includes('text_too_large'));
  });

  test('الملف الفاسد والربط الرمزي للمخزن يفشلان مغلقين بلا كتابة خارج الجذر', () => {
    const fresh = begin('سيُختبر فساد هذا السجل فقط');
    ok(store.stop(fresh.runId));
    const target = allFiles(storeRoot).find((file) => path.basename(file) === fresh.id + '.json');
    const originalBytes = fs.readFileSync(target);
    fs.writeFileSync(target, '{"messages":');
    assert.strictEqual(store.load(fresh.id, project).error, 'store_unreadable');
    fs.writeFileSync(target, originalBytes);
    const altered = JSON.parse(originalBytes);
    altered.cwd = conversations.normalizeCwd(otherProject);
    fs.writeFileSync(target, JSON.stringify(altered));
    assert.strictEqual(store.load(fresh.id, project).error, 'store_corrupt');
    fs.writeFileSync(target, originalBytes);
    assert.strictEqual(read(fresh.id).id, fresh.id);
    assert(!allFiles(storeRoot).some((file) => file.includes('.tmp-') || file.endsWith('.write-lock')));
    const unsafeRoot = path.join(temp, 'unsafe-link');
    fs.symlinkSync(otherProject, unsafeRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const unsafe = conversations.createStore({ root: unsafeRoot });
    assert.strictEqual(unsafe.prepare({ cwd: project, engine: 'sdk', prompt: 'لا تكتب هنا' }).error, 'unsafe_store_path');
    assert.strictEqual(fs.readdirSync(otherProject).length, 0);
  });


  test('قارئ Claude يفصل نتائج الأدوات عن المستخدم ويحفظ المصدر كاملاً', () => {
    const entries = [
      { type: 'user', cwd: project, message: { content: [{ type: 'text', text: 'أقدم قيد في السجل القديم' },
        { type: 'image', source: { media_type: 'image/png', data: 'NEVER-IMPORT-IMAGE-DATA' } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'رد قديم' }, { type: 'tool_use', id: 'tool-legacy', input: { secret: 'NEVER-IMPORT-TOOL-INPUT' } }] } },
      { type: 'user', cwd: otherProject, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-legacy', content: 'فشل اختبار قديم', is_error: true }] } },
      ...Array.from({ length: 50 }, (_, index) => ({ type: 'user', message: { content: 'رسالة ' + index } })),
    ];
    const result = sessions.buildContinuityMessages(entries.map((entry) => JSON.stringify(entry)).join('\n'));
    assert.strictEqual(result.cwd, project);
    assert.strictEqual(result.messages.length, 53);
    assert.strictEqual(result.messages[0].text, 'أقدم قيد في السجل القديم');
    assert.strictEqual(result.messages[2].role, 'tool_result', 'نتيجة الأداة القديمة يجب أن تبقى منفصلة عن كلام المستخدم');
    assert.strictEqual(result.messages[2].text, 'فشل اختبار قديم');
    assert.strictEqual(result.messages[2].isError, true);
    assert.strictEqual(result.coverage.complete, true);
    assert.strictEqual(result.coverage.imagesComplete, false);
    assert(!JSON.stringify(result).includes('NEVER-IMPORT-IMAGE-DATA'));
    assert(!JSON.stringify(result).includes('NEVER-IMPORT-TOOL-INPUT'));
    const corrupt = sessions.buildContinuityMessages('{"type":"user",\n' + JSON.stringify(entries[0]));
    assert.strictEqual(corrupt.coverage.complete, false);
    assert(corrupt.coverage.issues.includes('invalid_jsonl'));
    const injected = sessions.buildContinuityMessages(JSON.stringify({ type: 'user', message: { content: '<satr_conversation_history>duplicated</satr_conversation_history>' } }));
    assert.strictEqual(injected.coverage.complete, false);
    // كتلة سياق الدور (OBS-194) تُحقن قبل نصّ المستخدم وتُحفظ في jsonl — لا تُنقل كأنها كلامه
    const turnContext = sessions.buildContinuityMessages(JSON.stringify({ type: 'user', message: { content: '<satr_turn_context>\nسياق\n</satr_turn_context>\n\nسؤال المستخدم' } }));
    assert.strictEqual(turnContext.messages[0].text, 'سؤال المستخدم');
    assert.strictEqual(turnContext.coverage.complete, true);
  });


  test('قارئ Codex يحتفظ بنص MCP وصور وصفية فقط ولا يغير قارئ العرض', () => {
    const thread = { cwd: project, turns: [{ status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'قيد Codex الأصلي\nبسطرين' }] },
      { type: 'mcpToolCall', id: 'mcp-source-image', status: 'completed', result: { content: [
        { type: 'text', text: 'نص نتيجة MCP محفوظ' },
        { type: 'image', mimeType: 'image/png', data: 'NEVER-PERSIST-MCP-BINARY', url: 'NEVER-PERSIST-IMAGE-URL' },
      ] } },
      { type: 'dynamicToolCall', id: 'dynamic-source-image', status: 'completed', success: true, contentItems: [
        { type: 'inputText', text: 'نص أداة ديناميكية' },
        { type: 'inputImage', imageUrl: 'data:image/png;base64,NEVER-DYNAMIC-BINARY' },
      ] },
    ] }] };
    const result = codexSessions.continuityMessages(thread);
    assert.strictEqual(result.messages[0].text, 'قيد Codex الأصلي\nبسطرين');
    assert(result.messages[1].text.includes('نص نتيجة MCP محفوظ'));
    assert(result.messages[1].text.includes('حالة الأداة: completed'));
    assert.strictEqual(result.messages[1].images[0].available, false);
    assert.strictEqual(result.coverage.complete, true);
    assert.strictEqual(result.coverage.imagesComplete, false);
    const encoded = JSON.stringify(result);
    assert(!encoded.includes('NEVER-PERSIST-MCP-BINARY'), 'بيانات صورة MCP يجب ألا تدخل نتيجة قارئ النقل');
    assert(!encoded.includes('NEVER-PERSIST-IMAGE-URL'));
    assert(!encoded.includes('NEVER-DYNAMIC-BINARY'));
    assert(result.messages[2].text.includes('نص أداة ديناميكية'));
    assert(!result.messages[2].text.includes('data:image'));
  });

  test('قارئ Codex يعلن الحقن والمحتوى المجهول والبيانات المنظمة المتروكة', () => {
    const inspect = (item) => codexSessions.continuityMessages({ cwd: project, turns: [{ status: 'completed', items: [item] }] });
    const injected = inspect({ type: 'userMessage', content: [{ type: 'text', text: '<satr_conversation_history>سياق قديم</satr_conversation_history>' }] });
    assert.strictEqual(injected.coverage.complete, false);
    assert(injected.coverage.issues.includes('injected_history'));
    const malformed = inspect({ type: 'userMessage', content: 'نص ليس مصفوفة' });
    assert.strictEqual(malformed.coverage.complete, false);
    assert(malformed.coverage.issues.includes('unsupported_content'));
    const structured = inspect({ type: 'mcpToolCall', id: 'structured', status: 'completed', result: {
      content: [{ type: 'text', text: 'نص فقط' }], structuredContent: { binary: 'NEVER-STRUCTURED-BINARY' },
    } });
    assert.strictEqual(structured.coverage.complete, false);
    assert(structured.coverage.issues.includes('structured_result_omitted'));
    assert(!JSON.stringify(structured).includes('NEVER-STRUCTURED-BINARY'));
    const imported = ok(store.create({ cwd: project, engine: 'codex', sessionId: 'codex-import-gap', messages: injected.messages, coverage: injected.coverage }));
    assert.strictEqual(store.prepare({ cwd: project, engine: 'sdk', conversationId: imported.id, prompt: 'لا تنقل هذا النقص' }).error, 'transfer_incomplete');
  });

  test('قارئ Codex يعلن الأداة أو الدور غير المكتمل ولا يحولهما إلى نجاح', () => {
    const result = codexSessions.continuityMessages({ cwd: project, turns: [{ status: 'inProgress', items: [
      { type: 'commandExecution', id: 'pending-command', status: 'inProgress', aggregatedOutput: 'خرج جزئي' },
    ] }] });
    assert.strictEqual(result.coverage.complete, false);
    assert(result.coverage.issues.includes('tool_not_completed'));
    assert(result.coverage.issues.includes('turn_not_completed'));
    assert(result.messages[0].text.includes('inProgress'));
    assert(result.messages[0].text.includes('خرج جزئي'));
    const failed = codexSessions.continuityMessages({ cwd: project, turns: [{ status: 'completed', items: [
      { type: 'commandExecution', id: 'failed-command', status: 'completed', aggregatedOutput: 'فشل فعلي', exitCode: 2 },
    ] }] });
    assert.strictEqual(failed.coverage.complete, true);
    assert.strictEqual(failed.messages[0].isError, true);
  });

  test('نتائج Codex الحية لا تحفظ صور JSON الكاملة أو المقطوعة أو data URL', () => {
    const current = begin('احفظ النص دون صور الأدوات', { engine: 'codex' });
    init(current, 'codex-live-images');
    const binary = 'QmFzZTY0'.repeat(4000);
    const outputs = [
      'نص أداة محفوظ\n' + JSON.stringify({ type: 'image', mimeType: 'image/png', data: binary }),
      JSON.stringify({ type: 'image', mimeType: 'image/png', data: binary }).slice(0, 20000) + '…',
      'نص أداة ديناميكية محفوظ\n' + 'data:image/png;base64,' + binary,
    ];
    outputs.forEach((content, index) => ok(store.acceptEvent(current.runId, {
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-image-' + index, content }] },
    })));
    complete(current);
    const saved = read(current.id);
    const toolResults = saved.messages.filter((message) => message.role === 'tool_result');
    assert.strictEqual(toolResults.length, 3);
    assert(toolResults.every((message) => message.issues.includes('tool_images_omitted')));
    assert(!JSON.stringify(saved).includes('QmFzZTY0'), 'سجل نتائج الأدوات الحية يجب ألا يحتفظ بأي جزء من بيانات الصورة');
    assert(toolResults[0].text.includes('نص أداة محفوظ'));
    assert(toolResults[2].text.includes('نص أداة ديناميكية محفوظ'));
    assert.strictEqual(saved.coverage.imagesComplete, false);
    const moved = begin('تابع النص', { conversationId: current.id });
    assert(moved.transfer.coverage.issues.includes('tool_images_omitted'));
    assert(!moved.context.includes('QmFzZTY0'));
    ok(store.stop(moved.runId));
  });

  test('يتعافى من قفل عملية ماتت ويرفض القفل الحي أو المجهول', () => {
    const crashRoot = path.join(temp, 'crash-store');
    const moduleFile = selected ? path.resolve(selected.slice('--module='.length)) : path.join(__dirname, '..', 'electron', 'conversations.js');
    const crashScript = [
      "const fs = require('fs');",
      "const originalRename = fs.renameSync;",
      "fs.renameSync = function(from, to) { if (String(to).includes('conv-')) process.exit(27); return originalRename.call(fs, from, to); };",
      "const store = require(process.argv[1]).createStore({ root: process.argv[2] });",
      "store.prepare({ cwd: process.argv[3], engine: 'sdk', prompt: 'crash fixture only' });",
      "process.exit(28);",
    ].join('\n');
    const crashed = require('child_process').spawnSync(process.execPath, ['-e', crashScript, moduleFile, crashRoot, project], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(crashed.status, 27, crashed.stderr);
    const lockFile = allFiles(crashRoot).find((file) => path.basename(file) === '.write-lock');
    assert(lockFile, 'عملية fixture يجب أن تترك قفلها قبل الخروج');
    const abandoned = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.strictEqual(abandoned.pid, crashed.pid);
    const recovering = conversations.createStore({ root: crashRoot });
    const recovered = ok(recovering.prepare({ cwd: project, engine: 'sdk', prompt: 'تعافٍ بعد موت عملية fixture' }));
    assert.strictEqual(fs.existsSync(lockFile), false, 'القفل الميت يُستعاد ثم يُحرر بعد الحفظ');
    ok(recovering.stop(recovered.runId));
    const liveLock = JSON.stringify({ pid: process.pid, nonce: '12345678-1234-4234-9234-123456789abc' });
    fs.writeFileSync(lockFile, liveLock);
    assert.strictEqual(recovering.prepare({ cwd: project, engine: 'sdk', prompt: 'لا تزل قفل عملية حية' }).error, 'store_busy');
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), liveLock);
    fs.writeFileSync(lockFile, '');
    assert.strictEqual(recovering.prepare({ cwd: project, engine: 'sdk', prompt: 'لا تخمن ملكية القفل' }).error, 'store_busy');
    fs.unlinkSync(lockFile);
  });

  const nativeRoot = path.join(temp, 'native-reader');
  const nativeProject = path.join(nativeRoot, 'project');
  fs.mkdirSync(nativeProject, { recursive: true });
  const nativeId = '12345678-1234-4234-9234-123456789abc';
  fs.writeFileSync(path.join(nativeProject, nativeId + '.jsonl'), JSON.stringify({ type: 'user', cwd: project, message: { content: 'قراءة المصدر الأصلي على القرص' } }));
  const nativeResult = await sessions.readContinuitySession(nativeId, { root: nativeRoot });
  assert.strictEqual(nativeResult.messages[0].text, 'قراءة المصدر الأصلي على القرص');
  assert.strictEqual(nativeResult.coverage.complete, true);
  assert.strictEqual((await sessions.readContinuitySession('../bad', { root: nativeRoot })).error, 'bad_args');
  const nativeDuplicate = path.join(nativeRoot, 'duplicate');
  fs.mkdirSync(nativeDuplicate);
  fs.copyFileSync(path.join(nativeProject, nativeId + '.jsonl'), path.join(nativeDuplicate, nativeId + '.jsonl'));
  assert.strictEqual((await sessions.readContinuitySession(nativeId, { root: nativeRoot })).error, 'ambiguous_session');
  passed++;
  console.log('PASS قارئ المصدر يقرأ ملفاً معزولاً ويرفض المعرف المخالف والهوية المكررة');

  console.log('نجح حارس استمرارية المحادثات: ' + passed + '/' + passed);
} finally {
  const resolved = path.resolve(temp);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temporaryRoot + path.sep) || !path.basename(resolved).startsWith('satr-conversations-test-')) {
    throw new Error('رفض تنظيف مسار خارج مجلد الحارس المؤقت');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
