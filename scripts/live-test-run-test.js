/**
 * حارس حدود بيئة الاختبار الحي: ملفات مؤقتة معلومة الملكية، بلا شبكة ولا Electron.
 * الحارس يفحص الأثر على القرص والبيئة، لا نسخة من خوارزمية الإنتاج.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { prepareRun, loadRun, buildChildEnv, writeEvidence, readEvidence } = require('./lib/live-test-run');
const { completionExitCode } = require('./live-test');

const tempBase = fs.realpathSync.native(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempBase, 'satr-live-test-guard-'));
let checks = 0;
let skipped = 0;
const links = [];

function check(label, fn) {
  fn();
  checks++;
  console.log('  ✓ ' + label);
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error.code === code, 'كان يجب رفض الحالة برمز ' + code);
}

function fixture(name) {
  const repo = path.join(scratch, name);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.16.21' }));
  return repo;
}

function mutateManifest(repo, run, edit) {
  const file = path.join(run.paths.root, 'manifest.json');
  const original = fs.readFileSync(file, 'utf8');
  const changed = JSON.parse(original);
  edit(changed);
  fs.writeFileSync(file, JSON.stringify(changed));
  try { assert.throws(() => loadRun(repo, run.id)); }
  finally { fs.writeFileSync(file, original); }
}

function symlink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    links.push(link);
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    skipped++;
    console.log('  ↷ إنشاء الرابط غير متاح: ' + error.code);
    return false;
  }
}

try {
  const repo = fixture('repo');
  const parentHome = path.join(scratch, 'owner-home');
  fs.mkdirSync(parentHome);
  fs.writeFileSync(path.join(parentHome, 'owner-sentinel.txt'), 'owner-preserved');
  const parentBefore = fs.readdirSync(parentHome);
  const run = prepareRun(repo);

  check('هوية عشوائية ومسارات مملوكة تحت dist/live-tests فقط', () => {
    assert.match(run.id, /^live_[a-f0-9]{24}$/);
    assert.strictEqual(run.version, '2.16.21');
    assert.strictEqual(run.state, 'prepared');
    assert.strictEqual(run.paths.root, path.join(repo, 'dist', 'live-tests', run.id));
    assert.deepStrictEqual(Object.keys(run.paths).sort(), ['downloads', 'evidence', 'home', 'profile', 'root', 'workspace']);
    for (const target of Object.values(run.paths)) assert(fs.statSync(target).isDirectory());
    assert.strictEqual(run.paths.downloads, path.join(run.paths.home, 'Downloads'));
    assert.deepStrictEqual(loadRun(repo, run.id), run);
  });

  check('كل تشغيل جديد مستقل ولا يغيّر تشغيله السابق', () => {
    const original = fs.readFileSync(path.join(run.paths.root, 'manifest.json'), 'utf8');
    const next = prepareRun(repo, { version: '3.0.0-beta.1' });
    assert.notStrictEqual(next.id, run.id);
    assert.notStrictEqual(next.paths.home, run.paths.home);
    assert.strictEqual(fs.readFileSync(path.join(run.paths.root, 'manifest.json'), 'utf8'), original);
  });

  check('يرفض الهوية كمسار ويرفض خيارات الجذر أو الهوية المصطنعة', () => {
    for (const id of ['../owner-home', '..\\owner-home', run.paths.root, '', run.id + '/home', 'live_' + 'a'.repeat(23), 'LIVE_' + 'a'.repeat(24), null]) {
      expectCode(() => loadRun(repo, id), 'invalid-run-id');
    }
    expectCode(() => prepareRun(repo, { id: run.id }), 'invalid-options');
    expectCode(() => prepareRun(repo, { root: parentHome }), 'invalid-options');
    expectCode(() => prepareRun(repo, { version: '../bad' }), 'invalid-version');
  });

  check('البيان يثبت المالك والهوية وجميع المسارات ولا يقبل حقولاً زائدة', () => {
    mutateManifest(repo, run, (m) => { m.owner = 'someone-else'; });
    mutateManifest(repo, run, (m) => { m.id = 'live_' + 'f'.repeat(24); });
    mutateManifest(repo, run, (m) => { m.paths.home = parentHome; });
    mutateManifest(repo, run, (m) => { m.paths.evidence = run.paths.root + '-sibling'; });
    mutateManifest(repo, run, (m) => { delete m.paths.downloads; });
    mutateManifest(repo, run, (m) => { m.payload = 'untrusted'; });
    mutateManifest(repo, run, (m) => { m.createdAt = 'yesterday'; });
    const foreign = path.join(repo, 'dist', 'live-tests', 'live_' + 'e'.repeat(24));
    fs.mkdirSync(foreign);
    assert.throws(() => loadRun(repo, path.basename(foreign)));
  });

  check('يعزل المنازل والإعدادات والتنزيلات ويحافظ على بيئة الأب', () => {
    const base = Object.freeze({
      PATH: 'fixture-bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      HOME: parentHome, userprofile: parentHome, AppData: parentHome, LOCALAPPDATA: parentHome,
      CODEX_HOME: parentHome, CLAUDE_CONFIG_DIR: parentHome, GEMINI_CLI_HOME: parentHome, KIMI_CODE_HOME: parentHome,
      XDG_CONFIG_HOME: parentHome, SATR_MOBILE_TLS_DIR: parentHome, SATR_RELAY_URL: 'https://fixture.invalid',
      OPENAI_API_KEY: 'synthetic-secret', Anthropic_Auth_Token: 'synthetic-secret',
      AWS_SECRET_ACCESS_KEY: 'synthetic-secret', GOOGLE_APPLICATION_CREDENTIALS: 'synthetic-file',
      GITHUB_TOKEN: 'synthetic-secret', PRIVATE_KEY: 'synthetic-secret', SESSION_COOKIE: 'synthetic-secret',
      HTTP_PROXY: 'synthetic-proxy', SSH_AUTH_SOCK: 'synthetic-agent', NODE_OPTIONS: '--require=synthetic',
      ELECTRON_RUN_AS_NODE: '1', SATR_LIVE_TEST: 'inherited', LANG: 'ar_SA.UTF-8',
    });
    const saved = { ...base };
    const env = buildChildEnv(base, run);
    assert.strictEqual(env.HOME, run.paths.home, 'HOME must point to the isolated run home');
    assert.strictEqual(env.USERPROFILE, run.paths.home);
    assert.strictEqual(env.APPDATA, path.join(run.paths.home, 'AppData', 'Roaming'));
    assert.strictEqual(env.LOCALAPPDATA, path.join(run.paths.home, 'AppData', 'Local'));
    for (const field of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'SATR_MOBILE_TLS_DIR', 'TEMP', 'TMP', 'TMPDIR']) {
      assert(env[field].startsWith(run.paths.home + path.sep), field + ' must stay in the isolated home');
      assert(fs.statSync(env[field]).isDirectory());
    }
    assert.strictEqual(env.SATR_RELAY_URL, ' ');
    for (const field of ['OPENAI_API_KEY', 'Anthropic_Auth_Token', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GITHUB_TOKEN', 'PRIVATE_KEY', 'SESSION_COOKIE', 'HTTP_PROXY', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'SATR_LIVE_TEST', 'userprofile', 'AppData']) {
      assert(!Object.hasOwn(env, field), field + ' must not be inherited');
    }
    for (const field of ['PATH', 'SystemRoot', 'ComSpec', 'LANG']) assert.strictEqual(env[field], base[field]);
    assert.deepStrictEqual(base, saved);
    assert.deepStrictEqual(fs.readdirSync(parentHome), parentBefore);
    assert.strictEqual(fs.readFileSync(path.join(parentHome, 'owner-sentinel.txt'), 'utf8'), 'owner-preserved');
    const tampered = JSON.parse(JSON.stringify(run));
    tampered.paths.home = parentHome;
    assert.throws(() => buildChildEnv(base, tampered));
  });

  check('نجاح العملية وحده لا يكفي دون دليل إغلاق ناجح', () => {
    const nonzero = prepareRun(repo);
    writeEvidence(repo, nonzero.id, 'completion.json', { kind: 'shutdown', status: 'closed' });
    assert.strictEqual(completionExitCode(repo, nonzero.id, 7), 1, 'nonzero child exit must fail despite closed evidence');

    const missing = prepareRun(repo);
    assert.strictEqual(completionExitCode(repo, missing.id, 0), 1, 'zero exit without completion evidence must fail');

    const failed = prepareRun(repo);
    writeEvidence(repo, failed.id, 'completion.json', { kind: 'shutdown', status: 'failed' });
    assert.strictEqual(completionExitCode(repo, failed.id, 0), 1, 'failed completion must fail despite zero child exit');

    const closed = prepareRun(repo);
    writeEvidence(repo, closed.id, 'completion.json', { kind: 'shutdown', status: 'closed' });
    assert.strictEqual(completionExitCode(repo, closed.id, 0), 0, 'zero exit with closed shutdown evidence must pass');
  });
  check('تصادم الهوية يعيد المحاولة ولا يكتب فوق تجربة سابقة', () => {
    const originalRandom = crypto.randomBytes;
    const before = fs.readFileSync(path.join(run.paths.root, 'manifest.json'), 'utf8');
    const fresh = Buffer.from('12'.repeat(12), 'hex');
    let calls = 0;
    try {
      crypto.randomBytes = () => ++calls === 1 ? Buffer.from(run.id.slice(5), 'hex') : fresh;
      const next = prepareRun(repo);
      assert.strictEqual(calls, 2);
      assert.strictEqual(next.id, 'live_' + fresh.toString('hex'));
      crypto.randomBytes = () => Buffer.from(run.id.slice(5), 'hex');
      expectCode(() => prepareRun(repo), 'run-id-collision');
    } finally { crypto.randomBytes = originalRandom; }
    assert.strictEqual(fs.readFileSync(path.join(run.paths.root, 'manifest.json'), 'utf8'), before);
  });

  check('الدليل محدود المخطط ويُنشأ مرة واحدة داخل evidence', () => {
    const result = writeEvidence(repo, run.id, 'ready.json', { kind: 'launch', status: 'ready', pid: 17, windowId: 1 });
    assert.deepStrictEqual(readEvidence(repo, run.id, 'ready.json'), result);
    assert(Number.isFinite(Date.parse(result.time)));
    assert.throws(() => writeEvidence(repo, run.id, 'ready.json', { kind: 'launch', status: 'failed' }));
    assert.strictEqual(readEvidence(repo, run.id, 'ready.json').status, 'ready');
    const stopped = writeEvidence(repo, run.id, 'recording-stop.json', {
      kind: 'recording', status: 'stopped', file: 'capture-01.webm', sha256: 'a'.repeat(64),
      frames: 90, width: 1024, height: 768, bytes: 100, durationMs: 3000,
    });
    assert.strictEqual(stopped.status, 'stopped');
    for (const name of ['../escape.json', '..\\escape.json', path.join(parentHome, 'x.json'), 'con.json', 'x.json:ads', 'x.txt', 'x'.repeat(80) + '.json']) {
      expectCode(() => writeEvidence(repo, run.id, name, { kind: 'launch', status: 'ready' }), 'invalid-evidence-name');
    }
    for (const extra of [
      { payload: { secret: 'synthetic' } }, { token: 'synthetic' }, { file: '../owner.webm' },
      { file: 'C:\\owner.webm' }, { file: 'con.webm' }, { pid: -1 }, { bytes: 1.5 },
      { durationMs: Infinity }, { width: Number.MAX_SAFE_INTEGER + 1 }, { sha256: 'oops' },
      { errorCode: 'https://fixture.invalid' }, { time: 'not-a-date' }, { scenario: '../invalid' },
    ]) {
      assert.throws(() => writeEvidence(repo, run.id, 'bad.json', { kind: 'scenario', status: 'failed', ...extra }));
    }
    assert(!fs.existsSync(path.join(run.paths.evidence, 'bad.json')));
    fs.writeFileSync(path.join(run.paths.evidence, 'injected.json'), '{"kind":"launch","status":"ready","payload":"synthetic"}');
    expectCode(() => readEvidence(repo, run.id, 'injected.json'), 'invalid-evidence');
    fs.writeFileSync(path.join(run.paths.evidence, 'huge.json'), ' '.repeat(16385));
    expectCode(() => readEvidence(repo, run.id, 'huge.json'), 'json-too-large');
    fs.writeFileSync(path.join(run.paths.evidence, 'broken.json'), '{"token":"synthetic-secret",');
    let message = '';
    try { readEvidence(repo, run.id, 'broken.json'); } catch (error) { message = error.message; }
    assert(message.includes('invalid-json'));
    assert(!message.includes('synthetic-secret'));
  });

  check('يرفض روابط المجلدات عند الإنشاء والتحميل والبيئة', () => {
    const linkedRepo = fixture('linked-dist');
    if (symlink(parentHome, path.join(linkedRepo, 'dist'), 'junction')) {
      assert.throws(() => prepareRun(linkedRepo), 'dist junction must be rejected');
      assert.deepStrictEqual(fs.readdirSync(parentHome), parentBefore);
    }
    const linkRun = prepareRun(repo);
    fs.rmdirSync(linkRun.paths.workspace);
    if (symlink(parentHome, linkRun.paths.workspace, 'junction')) {
      assert.throws(() => loadRun(repo, linkRun.id), 'workspace junction must be rejected');
      assert.throws(() => buildChildEnv({}, linkRun));
    }
    const homeRun = prepareRun(repo);
    const codex = path.join(homeRun.paths.home, '.codex');
    fs.rmdirSync(codex);
    if (symlink(parentHome, codex, 'junction')) assert.throws(() => buildChildEnv({}, homeRun));
    const id = 'live_' + 'b'.repeat(24);
    if (symlink(run.paths.root, path.join(repo, 'dist', 'live-tests', id), 'junction')) assert.throws(() => loadRun(repo, id));
  });

  check('يرفض روابط ملفات الدليل والبيان ولا يكتب إلى مقصدها', () => {
    const source = path.join(parentHome, 'owner-sentinel.txt');
    const evidence = path.join(run.paths.evidence, 'linked.json');
    if (symlink(source, evidence, 'file')) {
      assert.throws(() => readEvidence(repo, run.id, 'linked.json'));
      assert.throws(() => writeEvidence(repo, run.id, 'linked.json', { kind: 'launch', status: 'ready' }));
      assert.strictEqual(fs.readFileSync(source, 'utf8'), 'owner-preserved');
    }
    const hard = path.join(run.paths.evidence, 'hard.json');
    fs.linkSync(source, hard);
    expectCode(() => readEvidence(repo, run.id, 'hard.json'), 'unsafe-json-file');
    assert.throws(() => writeEvidence(repo, run.id, 'hard.json', { kind: 'launch', status: 'ready' }));
    const manifestRun = prepareRun(repo);
    const manifestFile = path.join(manifestRun.paths.root, 'manifest.json');
    const copied = path.join(parentHome, 'manifest-copy.json');
    fs.copyFileSync(manifestFile, copied);
    fs.unlinkSync(manifestFile);
    if (symlink(copied, manifestFile, 'file')) assert.throws(() => loadRun(repo, manifestRun.id));
  });
} finally {
  // جذر أنشأه الحارس وحده: نزيل الروابط أولاً، ونثبت الهدف قبل الحذف العودي.
  for (const link of links.reverse()) {
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const resolved = fs.realpathSync.native(scratch);
  assert.strictEqual(path.dirname(resolved), tempBase);
  assert(path.basename(resolved).startsWith('satr-live-test-guard-'));
  assert(!fs.lstatSync(scratch).isSymbolicLink());
  fs.rmSync(resolved, { recursive: true, force: true });
}

console.log('\nlive-test-run-test: نجح — ' + checks + ' مجموعات حدود، روابط متعذرة: ' + skipped + '.');
