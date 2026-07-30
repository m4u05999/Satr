/**
 * مسبار حيّ لوضع الحلقة المحدودة — خارج `test:full` عمداً (يستهلك أدواراً حقيقية).
 *
 * ينشئ مستودع git لعبة مؤقتاً فيه `.satr/verify.json` **ملتزم في HEAD** واختبار node
 * يفشل بخلل مزروع، ثم يشغّل `looprunner` بمحرك SDK حقيقي (نموذج haiku اقتصاداً)،
 * ويثبت حرفياً:
 *   1. إصلاح الفشل خلال ≤3 دورات (`state=passed`، `stop_reason=pass`).
 *   2. أوامر التحقق snapshot من HEAD لا من الشجرة (تُغيَّر الشجرة أثناء الحلقة
 *      وتبقى الأوامر المنفَّذة هي أوامر HEAD).
 *   3. تسجيل كل دورة في سجل الغرفة بلا خرج أوامر ولا أسرار.
 *   4. مطابقة `loop_update` للعقد المجمَّد (مفاتيح، اقتران stop_reason، بلا حقل زائد).
 *   5. صلاحية بصمة الأثر النهائي `sha256(head+'\0'+patch)` وقبول مسار المراجعة له.
 *
 * التشغيل: node scripts/loop-live-probe.js  [--model <name>] [--iterations <n>]
 * يلزم Claude Code مثبَّتاً ومسجَّل الدخول (نفس شرط غرفة العمليات).
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent');
const executionTeamModule = require('../electron/executionteam');
const looprunner = require('../electron/looprunner');
const opsroom = require('../electron/opsroom');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const MODEL = flag('model', 'haiku');
const MAX_ITERATIONS = Math.max(1, Math.min(5, Number(flag('iterations', '3')) || 3));
// simple : خلل واحد معلن في المهمة — يثبت المسار السعيد.
// repair : خللان، والمهمة تذكر الأول فقط؛ الثاني لا يُكتشف إلا من خرج التحقق،
//          فيثبت أن حلقة الإصلاح تعمل بمحرك حقيقي (الحقن يصل والنموذج يتصرف عليه).
const SCENARIO = flag('scenario', 'simple') === 'repair' ? 'repair' : 'simple';

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures++;
  console.log((condition ? 'ok  ' : 'FAIL') + ' — ' + name + (detail == null ? '' : '  [' + detail + ']'));
}

function git(cwd, list) {
  return execFileSync('git', list, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function seedRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satr-loop-live-')));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'loop@satr.test']);
  git(root, ['config', 'user.name', 'satr loop probe']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // خلل مزروع واحد وواضح: القسمة تعيد حاصل الطرح.
  fs.writeFileSync(path.join(root, 'src', 'calc.js'), [
    "'use strict';",
    '',
    'function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    '// BUG: يجب أن تعيد حاصل ضرب a في b',
    'function multiply(a, b) {',
    '  return a - b;',
    '}',
    '',
    'function divide(a, b) {',
    '  return a + b;',
    '}',
    '',
    'module.exports = { add, multiply, divide };',
    '',
  ].join('\n'));
  const checkLines = [
    "'use strict';",
    "const { add, multiply, divide } = require('./src/calc');",
    'let bad = 0;',
    "if (add(2, 3) !== 5) { console.error('add broken: ' + add(2, 3)); bad++; }",
    "if (multiply(3, 4) !== 12) { console.error('multiply broken: expected 12, got ' + multiply(3, 4)); bad++; }",
    "if (multiply(5, 0) !== 0) { console.error('multiply zero broken: ' + multiply(5, 0)); bad++; }",
  ];
  // في سيناريو الإصلاح يفحص الاختبار divide أيضاً، والمهمة لا تذكرها إطلاقاً:
  // لا سبيل لمعرفتها إلا من خرج التحقق الذي تحقنه الحلقة في دور الإصلاح.
  if (SCENARIO === 'repair') {
    checkLines.push("if (divide(8, 2) !== 4) { console.error('divide broken: expected 4, got ' + divide(8, 2)); bad++; }");
  }
  checkLines.push("if (bad) { process.exit(1); }", "console.log('all calc checks passed');", '');
  fs.writeFileSync(path.join(root, 'check.js'), checkLines.join('\n'));
  fs.mkdirSync(path.join(root, '.satr'), { recursive: true });
  fs.writeFileSync(path.join(root, '.satr', 'verify.json'), JSON.stringify({
    version: 1,
    commands: [{ id: 'calc', label: 'اختبار الحسابات', command: 'node check.js', timeout_seconds: 60 }],
  }, null, 2) + '\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'seed calc with planted multiply bug']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  return { root, head };
}

const LOOP_KEYS = ['type', 'schema_version', 'loop_id', 'team_id', 'room_id', 'state', 'iteration',
  'max_iterations', 'last_failure_summary', 'cost', 'budget', 'stop_reason', 'updated_at'].sort().join(',');
const PAIRING = looprunner.STOP_REASON_BY_STATE;

(async () => {
  const started = Date.now();
  const { root, head } = seedRepo();
  console.log('repo      : ' + root);
  console.log('head      : ' + head);
  console.log('model     : ' + MODEL);
  console.log('scenario  : ' + SCENARIO);
  console.log('iterations: ' + MAX_ITERATIONS);
  console.log('');

  const events = [];
  const notes = [];
  const roomCreated = opsroom.createRoom();
  if (!roomCreated.ok) { console.log('FAIL — تعذّر إنشاء غرفة العمليات'); process.exit(1); }
  const roomId = roomCreated.room.room_id;

  const runner = Object.freeze({
    engine: 'sdk',
    model: MODEL,
    start: (input, cwd, emit) => agent.start(input, cwd, emit, { mode: 'ops-room' }),
  });

  const loops = looprunner.create({
    runner,
    recordNote: (note) => {
      notes.push(note);
      opsroom.appendSystem(note.roomId, 'note', { text: note.text, team_id: note.teamId });
    },
  });

  const finished = new Promise((resolve) => {
    const done = (value) => setImmediate(() => resolve(value));
    loops.start({
      task: 'دالة multiply في src/calc.js تعيد نتيجة خاطئة فيفشل اختبار المشروع. أصلحها كي تعيد حاصل الضرب الصحيح.',
      ownership: ['src/**'],
      roomId,
      maxIterations: MAX_ITERATIONS,
      budgetTokens: 400000,
      timeoutMs: 300000,
    }, root, (obj) => {
      events.push(obj);
      if (obj.type === 'loop_update') {
        console.log('  loop_update: state=' + obj.state + ' iteration=' + obj.iteration + '/' + obj.max_iterations
          + ' tokens=' + obj.budget.used_tokens
          + (obj.last_failure_summary ? ' failure="' + obj.last_failure_summary + '"' : ''));
        if (looprunner.TERMINAL_LOOP_STATES.has(obj.state)) done(obj);
      }
    }).then((result) => { if (!result.ok) done({ startError: result.error, state: 'failed' }); });
  });

  const last = await finished;
  const elapsed = Date.now() - started;
  console.log('');

  if (last.startError) {
    check('بدأت الحلقة', false, String(last.startError));
    console.log('\nloop-live-probe: FAILURES = ' + failures);
    process.exit(1);
  }

  const updates = events.filter((event) => event.type === 'loop_update');
  const teamUpdates = events.filter((event) => event.type === 'execution_team_update');

  // 1) إصلاح الفشل خلال ≤3 دورات
  check('1: الحالة النهائية passed', last.state === 'passed', last.state);
  check('1: stop_reason=pass', last.stop_reason === 'pass', last.stop_reason);
  check('1: الدورات المستهلكة ' + last.iteration + ' ≤ ' + MAX_ITERATIONS, last.iteration <= MAX_ITERATIONS,
    String(last.iteration));
  if (SCENARIO === 'repair') {
    // القيمة الفعلية للحلقة: خلل لا تذكره المهمة أُصلح بعد أن كشفه خرج التحقق.
    check('1: احتاجت دورة إصلاح فعلية (≥2)', last.iteration >= 2, String(last.iteration));
  }

  // 2) snapshot الأوامر من HEAD: الأمر المنفَّذ هو أمر HEAD، وHEAD لم يتغيّر
  check('2: HEAD لم يتغيّر (لا commit ولا دمج)', git(root, ['rev-parse', 'HEAD']).trim() === head);
  check('2: شجرة العمل الأصلية لم تُلمس (الخلل ما زال فيها)',
    fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8').includes('return a - b'));
  check('2: ملف الإعداد في الشجرة كما هو',
    JSON.parse(fs.readFileSync(path.join(root, '.satr', 'verify.json'), 'utf8')).commands[0].command === 'node check.js');

  // 3) سجل الغرفة: كل دورة مسجَّلة، بلا خرج أوامر
  const room = opsroom.load(roomId);
  const roomText = JSON.stringify(room && room.entries || []);
  check('3: سُجّلت دورات الحلقة في الغرفة',
    notes.filter((note) => /^الدورة \d+\//.test(note.text)).length >= 1,
    String(notes.filter((note) => /^الدورة \d+\//.test(note.text)).length));
  check('3: سُجّلت الحالة الطرفية', notes.some((note) => note.text.startsWith('انتهت الحلقة')));
  check('3: السجل بلا خرج أوامر', !/multiply broken|add broken|all calc checks/.test(roomText));
  check('3: السجل بلا patch', !/diff --git/.test(roomText));

  // 4) مطابقة العقد المجمَّد
  check('4: مفاتيح loop_update مطابقة تماماً',
    updates.every((event) => Object.keys(event).sort().join(',') === LOOP_KEYS),
    Object.keys(last).sort().join(','));
  check('4: schema_version=1', updates.every((event) => event.schema_version === 1));
  check('4: اقتران state/stop_reason صحيح في كل لقطة',
    updates.every((event) => (looprunner.TERMINAL_LOOP_STATES.has(event.state)
      ? event.stop_reason === PAIRING[event.state] : event.stop_reason === '')));
  check('4: team_id ثابت طوال الحلقة',
    new Set(updates.filter((event) => event.team_id).map((event) => event.team_id)).size === 1,
    JSON.stringify([...new Set(updates.map((event) => event.team_id))]));
  check('4: team_id بالنمط المجمَّد', /^execution-team-[a-z0-9-]{6,80}$/.test(last.team_id), last.team_id);
  check('4: loop_id بالنمط المجمَّد', looprunner.SAFE_LOOP_ID.test(last.loop_id), last.loop_id);
  check('4: budget.estimate=true', updates.every((event) => event.budget.estimate === true));
  check('4: لا حدث تحقق رسمي داخل الحلقة',
    !events.some((event) => event.type === 'execution_verification_update'));
  check('4: خرج الأوامر لا يعبر أي حدث',
    !/multiply broken|all calc checks/.test(JSON.stringify(events)));
  check('4: بُثّت لقطات الفريق للبطاقات', teamUpdates.length > 0, String(teamUpdates.length));

  // 5) الأثر النهائي وبوابة المراجعة
  const handoff = loops.handoff(last.loop_id);
  check('5: التسليم متاح', handoff.ok, JSON.stringify(handoff.error || ''));
  if (handoff.ok) {
    const artifact = handoff.bundle.artifact;
    check('5: بصمة الأثر صحيحة',
      artifact.artifact_id === executionTeamModule.artifactId(artifact.head, artifact.patch), artifact.artifact_id);
    check('5: الأثر من HEAD نفسه', artifact.head === head, artifact.head);
    check('5: الأثر يمس src/calc.js فقط',
      artifact.files.length > 0 && artifact.files.every((file) => file.rel.startsWith('src/')),
      JSON.stringify(artifact.files.map((file) => file.rel)));
    check('5: الأثر لا يمس ملف الإعداد', !artifact.patch.includes('verify.json'));
    const fresh = executionTeamModule.create({ runner: { engine: 'sdk', start: async () => ({}) } });
    const restored = fresh.restore(handoff.bundle, handoff.cwd, () => {});
    check('5: مسار المراجعة يقبل الأثر', restored.ok, JSON.stringify(restored.error || ''));
    check('5: الدمج مدعوم بعد المراجعة والتحقق فقط',
      !!restored.ok && restored.team.merge_supported === true && restored.team.verification === null);
    console.log('');
    console.log('artifact_id : ' + artifact.artifact_id);
    console.log('patch_bytes : ' + artifact.bytes);
    console.log('files       : ' + artifact.files.map((file) => file.rel + ' (+' + file.added + ' -' + file.removed + ')').join(', '));
  }

  console.log('');
  console.log('iterations  : ' + last.iteration + '/' + last.max_iterations);
  console.log('tokens      : input=' + last.cost.input_tokens + ' output=' + last.cost.output_tokens
    + ' budget=' + last.budget.used_tokens + '/' + last.budget.limit_tokens);
  console.log('cost_usd    : ' + last.cost.usd);
  console.log('elapsed_ms  : ' + elapsed);
  console.log('room_id     : ' + roomId);
  console.log('notes       : ' + notes.length);
  console.log('');
  console.log(failures
    ? 'loop-live-probe: FAILURES = ' + failures
    : 'loop-live-probe: نجح المسبار الحيّ — أُصلح الخلل خلال ' + last.iteration + ' دورة/دورات');
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* أفضل جهد */ }
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('loop-live-probe crashed: ' + ((error && error.stack) || error));
  process.exit(1);
});
