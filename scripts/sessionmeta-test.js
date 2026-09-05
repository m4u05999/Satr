#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// شبكة أمان قبل أي require: المخزن المفرد يُحسم ملفه لحظة التحميل، فلو سقط مسارٌ إليه
// بدل المخزن المحقون لما لمس `~/.satr/session-meta.json` الحقيقي للمستخدم.
process.env.SATR_SESSION_META_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'satr-sessionmeta-guard-')), 'session-meta.json');

const sessionmeta = require('../electron/sessionmeta');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-sessionmeta-'));
const file = path.join(root, '.satr', 'session-meta.json');

try {
  const store = sessionmeta.createStore({ file });
  assert.deepStrictEqual(store.list(), {});
  assert.deepStrictEqual(store.set('../bad', { pinned: true }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(store.set('valid-session', { pinned: 'yes' }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(store.set('valid-session', { unknown: true }), { ok: false, error: 'bad_input' });

  const rawTitle = '\u0000  عنوان\n جلسة\t' + 'ط'.repeat(100);
  const saved = store.set('valid-session', { pinned: true, title: rawTitle });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.entry.pinned, true);
  assert.strictEqual(saved.entry.title.includes('\n'), false);
  assert.strictEqual(saved.entry.title.length, sessionmeta.MAX_TITLE);
  assert.deepStrictEqual(store.get('valid-session'), saved.entry);
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.tmp-')), false);

  const reloaded = sessionmeta.createStore({ file });
  assert.deepStrictEqual(reloaded.get('valid-session'), saved.entry);
  assert.strictEqual(reloaded.set('valid-session', { pinned: false, title: '' }).ok, true);
  assert.strictEqual(reloaded.get('valid-session'), null);
  assert.deepStrictEqual(reloaded.remove('missing-session'), { ok: true, removed: false });

  // ---------- وسم جلسات الأدوات (‏OBS-068 ب) ----------
  const kindFile = path.join(root, 'kind.json');
  const kinds = sessionmeta.createStore({ file: kindFile });
  // القائمة مغلقة، والمعرّف يمر بالتنقية نفسها.
  assert.deepStrictEqual(kinds.setKind('../bad', 'tool'), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(kinds.setKind('tool-session', 'agent'), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(kinds.setKind('tool-session', ''), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(kinds.setKind('tool-session', null), { ok: false, error: 'bad_input' });

  assert.deepStrictEqual(kinds.setKind('tool-session', 'tool'), { ok: true, entry: { kind: 'tool' } });
  assert.deepStrictEqual(sessionmeta.createStore({ file: kindFile }).get('tool-session'), { kind: 'tool' });

  // 🔒 الوسم لا يمرّ من renderer: قائمة سماح `set` تبقى pinned/title وحدهما، فلا تستطيع
  // الواجهة إخفاء جلسة مستخدم بادّعاء أنها أداة.
  assert.deepStrictEqual(kinds.set('victim', { kind: 'tool' }), { ok: false, error: 'bad_input' });
  assert.deepStrictEqual(kinds.set('victim', { pinned: true, kind: 'tool' }), { ok: false, error: 'bad_input' });
  assert.strictEqual(kinds.get('victim'), null);

  // الوسم يجاور التثبيت/التسمية ولا يمحوهما، ويبقى بعد إلغاء التثبيت.
  assert.strictEqual(kinds.set('tool-session', { pinned: true, title: 'عامل معزول' }).ok, true);
  assert.deepStrictEqual(kinds.get('tool-session'), { pinned: true, title: 'عامل معزول', kind: 'tool' });
  assert.strictEqual(kinds.set('tool-session', { pinned: false, title: '' }).ok, true);
  assert.deepStrictEqual(kinds.get('tool-session'), { kind: 'tool' });

  // الوسم مرّة واحدة: `system` يتكرر مع الاستئناف فلا كتابة قرص بلا تغيير.
  const writes = [];
  const countingFs = {
    readFileSync() { throw new Error('missing'); },
    mkdirSync() {},
    writeFileSync(name) { writes.push(name); },
    renameSync() {},
    unlinkSync() {},
  };
  const idempotent = sessionmeta.createStore({ file: path.join(root, 'idem.json'), fs: countingFs });
  assert.strictEqual(idempotent.setKind('repeat-session', 'tool').ok, true);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(idempotent.setKind('repeat-session', 'tool').ok, true);
  assert.strictEqual(writes.length, 1, 'الوسم المتكرر كتب القرص ثانيةً');

  // حصّة الوسوم: تُطرد أقدم الوسوم **الخالصة** فقط، ويبقى تثبيت المستخدم وتسميته.
  const quotaFile = path.join(root, 'quota.json');
  const quota = sessionmeta.createStore({ file: quotaFile });
  assert.strictEqual(quota.setKind('keeper-pinned', 'tool').ok, true);
  assert.strictEqual(quota.set('keeper-pinned', { pinned: true }).ok, true);
  for (let index = 0; index < sessionmeta.MAX_TOOL_ENTRIES + 5; index++) {
    assert.strictEqual(quota.setKind('tool-' + index, 'tool').ok, true);
  }
  const quotaEntries = quota.list();
  const toolOnly = Object.keys(quotaEntries).filter((id) => quotaEntries[id].kind && !quotaEntries[id].pinned);
  assert.strictEqual(toolOnly.length, sessionmeta.MAX_TOOL_ENTRIES, 'حصّة الوسوم تجاوزت سقفها');
  assert.deepStrictEqual(quotaEntries['keeper-pinned'], { kind: 'tool', pinned: true },
    'الإخلاء أسقط تثبيت المستخدم');
  assert.strictEqual(quotaEntries['tool-0'], undefined, 'لم يُطرد أقدم وسم خالص');
  assert.strictEqual(quotaEntries['tool-' + (sessionmeta.MAX_TOOL_ENTRIES + 4)].kind, 'tool');
  // وزرّ التثبيت يبقى عاملاً بعد امتلاء حصّة الوسوم، فلا تقضم آثار الأدوات سعة المستخدم.
  assert.strictEqual(quota.set('user-pin', { pinned: true }).ok, true, 'حصّة الوسوم عطّلت تثبيت المستخدم');

  // ---------- السقف العام: قرار المستخدم يطرد أقدم وسم خالص (‏OBS-074) ----------
  const pressureFile = path.join(root, 'user-pressure.json');
  const pressure = sessionmeta.createStore({ file: pressureFile });
  for (let index = 0; index < sessionmeta.MAX_TOOL_ENTRIES; index++) {
    assert.strictEqual(pressure.setKind('pressure-tool-' + index, 'tool').ok, true);
  }
  for (let index = 0; index < sessionmeta.MAX_ENTRIES - sessionmeta.MAX_TOOL_ENTRIES; index++) {
    assert.strictEqual(pressure.set('pressure-user-' + index, { pinned: true }).ok, true);
  }
  assert.strictEqual(Object.keys(pressure.list()).length, sessionmeta.MAX_ENTRIES);
  assert.deepStrictEqual(pressure.set('pressure-user-overflow', { pinned: true }),
    { ok: true, entry: { pinned: true } },
    'التثبيت رقم 301 لم يطرد أقدم وسم خالص عند امتلاء السقف العام');
  const pressureEntries = pressure.list();
  assert.strictEqual(Object.keys(pressureEntries).length, sessionmeta.MAX_ENTRIES,
    'إخلاء وسم واحد لم يُبقِ المخزن عند سقفه العام');
  assert.strictEqual(pressureEntries['pressure-tool-0'], undefined, 'لم يُخلَ أقدم وسم خالص');
  assert.deepStrictEqual(pressureEntries['pressure-tool-1'], { kind: 'tool' },
    'أُخلي أكثر من الوسم الأدنى اللازم');
  assert.deepStrictEqual(pressureEntries['pressure-user-0'], { pinned: true },
    'الإخلاء أسقط قرار مستخدم سابقاً');
  assert.deepStrictEqual(pressureEntries['pressure-user-overflow'], { pinned: true });

  // وسم يحمل قرار تثبيت محصّن حتى لو كان أقدم مفاتيح المخزن.
  const protectedFile = path.join(root, 'protected-tool.json');
  const protectedStore = sessionmeta.createStore({ file: protectedFile });
  assert.strictEqual(protectedStore.setKind('protected-tool', 'tool').ok, true);
  assert.strictEqual(protectedStore.set('protected-tool', { pinned: true }).ok, true);
  assert.strictEqual(protectedStore.setKind('protected-titled-tool', 'tool').ok, true);
  assert.strictEqual(protectedStore.set('protected-titled-tool', { title: 'اسم المستخدم' }).ok, true);
  for (let index = 0; index < sessionmeta.MAX_TOOL_ENTRIES - 2; index++) {
    assert.strictEqual(protectedStore.setKind('protected-tool-only-' + index, 'tool').ok, true);
  }
  for (let index = 0; index < sessionmeta.MAX_ENTRIES - sessionmeta.MAX_TOOL_ENTRIES; index++) {
    assert.strictEqual(protectedStore.set('protected-user-' + index, { pinned: true }).ok, true);
  }
  assert.strictEqual(protectedStore.set('protected-overflow', { title: 'قرار جديد' }).ok, true,
    'وسم مثبت عطّل قرار مستخدم جديداً بدلاً من إخلاء وسم خالص');
  const protectedEntries = protectedStore.list();
  assert.deepStrictEqual(protectedEntries['protected-tool'], { kind: 'tool', pinned: true },
    'الإخلاء أسقط وسم أداة يحمل تثبيت مستخدم');
  assert.deepStrictEqual(protectedEntries['protected-titled-tool'], { kind: 'tool', title: 'اسم المستخدم' },
    'الإخلاء أسقط وسم أداة يحمل تسمية مستخدم');
  assert.strictEqual(protectedEntries['protected-tool-only-0'], undefined,
    'لم يُخلَ أقدم وسم خالص مع وجود وسم مثبت أقدم منه');

  // فشل الكتابة بعد الإخلاء يعيد لقطة المخزن كاملة ولا يترك القرار الجديد في الذاكرة.
  const rollbackSeed = { 'rollback-tool': { kind: 'tool' } };
  for (let index = 0; index < sessionmeta.MAX_ENTRIES - 1; index++) {
    rollbackSeed['rollback-user-' + index] = { pinned: true };
  }
  const failingFs = {
    readFileSync() { return JSON.stringify(rollbackSeed); },
    mkdirSync() {},
    writeFileSync() {},
    renameSync() { throw new Error('disk full'); },
    unlinkSync() {},
  };
  const rollback = sessionmeta.createStore({ file: path.join(root, 'rollback.json'), fs: failingFs });
  const rollbackBefore = rollback.list();
  assert.deepStrictEqual(rollback.set('rollback-overflow', { pinned: true }),
    { ok: false, error: 'write_failed' });
  assert.deepStrictEqual(rollback.list(), rollbackBefore,
    'فشل persist بعد الإخلاء لم يُعِد لقطة المخزن كاملة');

  const cappedFile = path.join(root, 'cap.json');
  const seed = {};
  for (let index = 0; index < sessionmeta.MAX_ENTRIES; index++) seed['s' + index] = { pinned: true };
  fs.writeFileSync(cappedFile, JSON.stringify(seed), 'utf8');
  const capped = sessionmeta.createStore({ file: cappedFile });
  assert.strictEqual(Object.keys(capped.list()).length, sessionmeta.MAX_ENTRIES);
  assert.deepStrictEqual(capped.set('overflow', { pinned: true }), { ok: false, error: 'limit' });
  assert.strictEqual(capped.set('s0', { title: 'مسموح' }).ok, true);
  assert.strictEqual(capped.remove('s1').removed, true);
  assert.strictEqual(capped.set('replacement', { pinned: true }).ok, true);

  const operations = [];
  const memoryFs = {
    readFileSync() { throw new Error('missing'); },
    mkdirSync() { operations.push('mkdir'); },
    writeFileSync(name) { operations.push(['write', name]); },
    renameSync(from, to) { operations.push(['rename', from, to]); },
    unlinkSync() {},
  };
  const atomic = sessionmeta.createStore({ file: path.join(root, 'atomic.json'), fs: memoryFs });
  assert.strictEqual(atomic.set('atomic-session', { pinned: true }).ok, true);
  assert.strictEqual(operations[1][0], 'write');
  assert(operations[1][1].includes('.tmp-'));
  assert.deepStrictEqual(operations[2].slice(0, 1), ['rename']);
  assert.strictEqual(operations[2][2], path.join(root, 'atomic.json'));

  console.log('sessionmeta: نجح — get/set/remove والتنقية والسقف والكتابة الذرية ورفض المدخلات، '
    + 'ووسم الأدوات: القائمة المغلقة وحجبه عن renderer وبقاؤه مع التثبيت وحصّته المتدحرجة؛ '
    + 'OBS-074 ‏4/4: إخلاء الأقدم، تحصين قرارات المستخدم، بقاء limit، واستعادة فشل الكتابة.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- وصل الوسم في مواضع الإنشاء الخمسة (‏OBS-068 ب) ----------
// هذا هو الفحص الذي يعضّ: يشغّل الوحدات الإنتاجية الخمس بمحرّك مزيّف يبثّ `system`
// ذا session_id، ويثبت أن كلاً منها وسم جلستها فعلاً. حذف سطر الوسم من أي ملف يُسقطه.
// (‏الدرس المثبّت في المستودع: حارس يختبر منطقاً موازياً يبقى أخضر بينما الميزة معطّلة.)
const executorModule = require('../electron/executor');
const reviewerModule = require('../electron/reviewer');
const orchestratorModule = require('../electron/orchestrator');
const brainstormModule = require('../electron/opsbrainstorm');
const plannerModule = require('../electron/opsplanner');

function tagSpy() {
  const tagged = [];
  return {
    tagged,
    setKind(sessionId, kind) { tagged.push(sessionId + ':' + kind); return { ok: true, entry: { kind } }; },
    list: () => ({}), get: () => null,
    set: () => ({ ok: false, error: 'bad_input' }), remove: () => ({ ok: true, removed: false }),
  };
}

// محرّك مزيّف يبثّ `system` بالمعرّف ثم نصاً نهائياً ثم proc_done — بلا أي أداة (كل
// الوحدات الخمس تفشل مغلقة عند أداة غير مسموحة، فالنص وحده يبقيها على مسارها السعيد).
function taggingRunner(engine, sessionId, text) {
  return {
    engine, model: engine + '-model',
    start(input, cwd, emit) {
      setTimeout(() => {
        emit({ type: 'system', subtype: 'init', session_id: sessionId });
        emit({ type: 'assistant', message: { content: [{ type: 'text', phase: 'final_answer', text }] } });
        emit({ type: 'result', session_id: sessionId, total_cost_usd: 0, usage: {}, result: text });
        emit({ type: 'proc_done', code: 0 });
      }, 5);
      return { resolvePermission() {}, stop() { return Promise.resolve(); } };
    },
  };
}

// مدير worktree مزيّف: executor/opsplanner وحدهما يحتاجانه، ولا شأن للوسم بـgit.
function fakeWorktrees(base) {
  return {
    async create() {
      return { ok: true, worktree: { id: 'wt-fake-1', path: base, repo_name: 'fixture', head: 'a'.repeat(40) } };
    },
    contains() { return true; },
    async diff() { return { ok: true, files: [], more: 0, partial: false }; },
    async patch() { return { ok: true, patch: '', bytes: 0, head: 'a'.repeat(40), sourceRoot: base }; },
    async remove() { return { ok: true }; },
    async removeAll() { return { ok: true }; },
  };
}

function waitUntil(check, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('انتهت المهلة: ' + label)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function wiring() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-sessionmeta-wiring-'));
  try {
    // 1) العامل المنفّذ
    const executorSpy = tagSpy();
    const worker = executorModule.create({
      runner: taggingRunner('sdk', 'executor-session', 'تمّ'),
      worktrees: fakeWorktrees(temp), sessionmeta: executorSpy, timeoutMs: 2000,
    });
    assert.strictEqual((await worker.start({ task: 'عدّل ملفاً', ownership: ['**'] }, temp, () => {})).ok, true);
    await waitUntil(() => executorSpy.tagged.length, 3000, 'executor tag');
    assert(executorSpy.tagged.includes('executor-session:tool'), 'العامل المنفّذ لم يسم جلسته');

    // 2) المراجع الأعمى — سياسة العمى المشتركة تغطي هيئة القضاة وreviewOnce معاً
    const reviewerSpy = tagSpy();
    await reviewerModule.reviewOnce({
      runner: taggingRunner('codex', 'reviewer-session', '[verdict: approve] سليم'),
      prompt: 'راجع', isolationRoot: temp, timeoutMs: 3000, sessionmeta: reviewerSpy,
    });
    assert(reviewerSpy.tagged.includes('reviewer-session:tool'), 'المراجع لم يسم جلسته');

    // 3) الباحث
    const researchSpy = tagSpy();
    const research = orchestratorModule.create({
      resolveEngine: () => taggingRunner('sdk', 'research-session', 'خلاصة'),
      sessionmeta: researchSpy, timeoutMs: 2000,
    });
    assert.strictEqual(research.start({ question: 'أين العقد؟', count: 1 }, temp, () => {}).ok, true);
    await waitUntil(() => researchSpy.tagged.length, 3000, 'orchestrator tag');
    assert(researchSpy.tagged.includes('research-session:tool'), 'الباحث لم يسم جلسته');

    // 4) العصف — معرّف مستقل لكل محرك، والوسم لكل واحد منها
    const brainstormSpy = tagSpy();
    const brainstorm = brainstormModule.create({
      isolationRoot: temp, timeoutMs: 2000, sessionmeta: brainstormSpy,
      resolveEngine: (engine) => taggingRunner(engine, 'brainstorm-' + engine, 'رأي'),
    });
    assert.strictEqual(brainstorm.start({ brief: 'قيّم' }, temp, () => {}).ok, true);
    // انتظر **الشرط الذي تؤكّده** لا شرطاً أضعف منه (درس OBS-083 في موضع ثانٍ): العصف
    // يشغّل ثلاثة عمّال — SDK وCodex إلزاميان وKimi ينضم ثالثاً حين يعيد `resolveEngine`
    // مشغّلاً (‏OBS-012 بند ب) — وكلُّ عاملٍ يسم **مرتين**. فشرط `length >= 2` يستوفيه
    // عاملٌ واحد وحده، فيمرّ الانتظار ثم يسقط التأكيد على الغائب: مقيسٌ حيّاً أن الوسوم
    // ستة (‏sdk×2 · codex×2 · kimi-code×2) وأن السابق منها يتبدّل بين تشغيلين.
    const brainstormTagged = () => brainstormSpy.tagged.includes('brainstorm-sdk:tool')
      && brainstormSpy.tagged.includes('brainstorm-codex:tool');
    await waitUntil(brainstormTagged, 3000, 'brainstorm tag');
    assert(brainstormSpy.tagged.includes('brainstorm-sdk:tool'), 'العصف لم يسم جلسة SDK');
    assert(brainstormSpy.tagged.includes('brainstorm-codex:tool'), 'العصف لم يسم جلسة Codex');

    // 5) المخطط
    const plannerSpy = tagSpy();
    const planner = plannerModule.create({
      runner: taggingRunner('sdk', 'planner-session',
        '<ops_plan>{"tasks":[{"task":"عدّل","ownership":["src/app.js"]}]}</ops_plan>'),
      worktrees: fakeWorktrees(temp), sessionmeta: plannerSpy, timeoutMs: 2000,
    });
    assert.strictEqual((await planner.start({ task: 'قسّم' }, temp, () => {})).ok, true);
    await waitUntil(() => plannerSpy.tagged.length, 3000, 'planner tag');
    assert(plannerSpy.tagged.includes('planner-session:tool'), 'المخطط لم يسم جلسته');

    console.log('sessionmeta-wiring: نجح — المواضع الخمسة (منفّذ/مراجع/باحث/عصف/مخطط) تسم جلساتها فعلاً '
      + 'من حدث المحرك؛ وطرف العرض يحرسه test:sessions-panel.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

wiring().catch((error) => {
  console.error('sessionmeta-wiring:', error && error.stack ? error.stack : error);
  process.exit(1);
});
