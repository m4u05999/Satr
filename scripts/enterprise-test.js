#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-enterprise-boundary-'));
const privateSource = path.join(tempRoot, 'private-checkout');
fs.mkdirSync(privateSource);
fs.writeFileSync(path.join(privateSource, 'index.js'), 'module.exports = { register() {} };\n');
fs.writeFileSync(path.join(privateSource, 'LICENSE'), 'Proprietary\n');
fs.writeFileSync(path.join(privateSource, 'satr-enterprise.json'), JSON.stringify({
  name: '@satr/enterprise', contractVersion: 1, main: 'index.js', packageFiles: ['index.js', 'LICENSE'],
}));

const sourceModule = require('./enterprise-source');
const stageModule = require('./enterprise-stage');

(async () => {
try {
  const resolved = sourceModule.resolveEnterpriseSource(privateSource);
  assert.strictEqual(resolved.source, fs.realpathSync.native(privateSource));
  assert.throws(() => sourceModule.resolveEnterpriseSource('relative/path'), /مساراً مطلقاً/);
  assert.throws(() => sourceModule.resolveEnterpriseSource(root), /خارج مستودع Community/);

  const incompatible = path.join(tempRoot, 'incompatible');
  fs.mkdirSync(incompatible);
  fs.writeFileSync(path.join(incompatible, 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(incompatible, 'LICENSE'), 'Proprietary\n');
  fs.writeFileSync(path.join(incompatible, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 2, main: 'index.js', packageFiles: ['index.js', 'LICENSE'],
  }));
  assert.throws(() => sourceModule.resolveEnterpriseSource(incompatible), /غير متوافق/);
  fs.writeFileSync(path.join(incompatible, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 1, main: 'index.js', packageFiles: ['../index.js', 'LICENSE'],
  }));
  assert.throws(() => sourceModule.resolveEnterpriseSource(incompatible), /packageFiles/);
  console.log('✓ private Enterprise checkout requires an external compatible contract');

  fs.writeFileSync(path.join(incompatible, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 1, main: 'index.js',
    packageFiles: ['index.js', 'INDEX.JS', 'LICENSE'],
  }));
  assert.throws(() => sourceModule.resolveEnterpriseSource(incompatible), /تصادم أسماء.*Windows/);
  console.log('✓ Enterprise allowlist rejects Windows filename collisions');

  const previous = process.env.SATR_ENTERPRISE_DIR;
  process.env.SATR_ENTERPRISE_DIR = privateSource;
  const configPath = require.resolve('./ee-builder-config');
  const stagesBeforeConfig = fs.readdirSync(path.join(root, 'dist'))
    .filter((name) => name.startsWith(stageModule.STAGE_PREFIX)).sort();
  delete require.cache[configPath];
  const config = require('./ee-builder-config');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'dist'))
    .filter((name) => name.startsWith(stageModule.STAGE_PREFIX)).sort(), stagesBeforeConfig);
  const fileSet = config.files.find((entry) => entry && typeof entry === 'object' && entry.to === 'enterprise');
  assert(fileSet);
  assert(fileSet.from.startsWith(path.join(root, 'dist')));
  assert(!config.files.includes('enterprise/**/*'));
  assert(config.files.includes('!enterprise/**') === false);
  assert.strictEqual(config.publish, null);
  assert.strictEqual(config.extraMetadata.satrEdition, 'enterprise');
  assert.strictEqual(config.extraMetadata.satrEnterpriseContract, 1);
  assert.strictEqual(config.directories.output, 'dist/enterprise');
  assert.deepStrictEqual(fileSet.filter, ['index.js', 'LICENSE']);
  assert.deepStrictEqual(config.asarUnpack, require('../package.json').build.asarUnpack);
  assert.deepStrictEqual(config.asar, require('../package.json').build.asar);
  assert.deepStrictEqual(config.files.filter((entry) => typeof entry === 'string'),
    require('../package.json').build.files.filter((entry) => entry !== '!enterprise/**'));

  const effectiveConfig = JSON.parse(JSON.stringify(config));
  const context = { packager: { config: effectiveConfig } };
  await config.beforePack(context);
  const effectiveFileSet = effectiveConfig.files.find((entry) => entry && entry.to === 'enterprise');
  const firstStage = effectiveFileSet.from;
  assert(firstStage.startsWith(path.join(root, 'dist', stageModule.STAGE_PREFIX)));
  assert.strictEqual(fs.readFileSync(path.join(firstStage, 'index.js'), 'utf8'),
    fs.readFileSync(path.join(privateSource, 'index.js'), 'utf8'));
  assert.deepStrictEqual(fs.readdirSync(firstStage).sort(), ['LICENSE', 'index.js']);
  await config.afterPack(context);
  assert.strictEqual(fs.existsSync(firstStage), false);

  fs.writeFileSync(path.join(privateSource, 'secret.env'), 'DO_NOT_PACKAGE=1\n');
  fs.writeFileSync(path.join(privateSource, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 1, main: 'index.js',
    packageFiles: ['index.js', 'LICENSE', 'secret.env'],
  }));
  await assert.rejects(() => config.beforePack(context), /تغير عقد Enterprise/);
  assert.strictEqual(fs.existsSync(firstStage), false);
  fs.writeFileSync(path.join(privateSource, 'satr-enterprise.json'), JSON.stringify({
    name: '@satr/enterprise', contractVersion: 1, main: 'index.js', packageFiles: ['index.js', 'LICENSE'],
  }));

  const stagesBeforeFailure = fs.readdirSync(path.join(root, 'dist'))
    .filter((name) => name.startsWith(stageModule.STAGE_PREFIX)).sort();
  assert.throws(() => stageModule.prepareStage({
    projectRoot: root, source: privateSource, packageFiles: ['index.js', 'missing.js'],
    distRoot: path.join(root, 'dist'),
  }), /ENOENT/);
  assert.throws(() => stageModule.prepareStage({
    projectRoot: root, source: privateSource, packageFiles: ['index.js'],
    distRoot: path.join(root, 'dist'), copyFile() { throw new Error('copy failure probe'); },
  }), /copy failure probe/);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'dist'))
    .filter((name) => name.startsWith(stageModule.STAGE_PREFIX)).sort(), stagesBeforeFailure);

  const outside = path.join(tempRoot, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escape.js'), 'secret\n');
  const linked = path.join(privateSource, 'linked');
  fs.symlinkSync(outside, linked, 'junction');
  assert.throws(() => stageModule.prepareStage({
    projectRoot: root, source: privateSource, packageFiles: ['linked/escape.js'],
    distRoot: path.join(root, 'dist'),
  }), /لا يجوز أن يكون رابطاً/);

  const setA = { to: 'enterprise' };
  const setB = { to: 'enterprise' };
  let inheritedBefore = 0;
  let inheritedAfter = 0;
  const hooksA = stageModule.createStageHooks({
    projectRoot: root, source: privateSource, packageFiles: ['index.js'], distRoot: path.join(root, 'dist'),
    fileSet: setA, beforePack: () => { inheritedBefore += 1; }, afterPack: () => { inheritedAfter += 1; },
  });
  const hooksB = stageModule.createStageHooks({
    projectRoot: root, source: privateSource, packageFiles: ['LICENSE'], distRoot: path.join(root, 'dist'),
    fileSet: setB,
  });
  const ctxA = { packager: { config: { files: [setA] } } };
  const ctxB = { packager: { config: { files: [setB] } } };
  await hooksA.beforePack(ctxA);
  await assert.rejects(() => hooksA.beforePack(ctxA), /متداخل/);
  await hooksB.beforePack(ctxB);
  assert.notStrictEqual(setA.from, setB.from);
  assert(fs.existsSync(setA.from) && fs.existsSync(setB.from));
  await hooksA.afterPack(ctxA);
  assert.strictEqual(fs.existsSync(setA.from), false);
  assert.strictEqual(fs.existsSync(setB.from), true);
  await hooksB.afterPack(ctxB);
  assert.strictEqual(fs.existsSync(setB.from), false);
  assert.strictEqual(inheritedBefore, 1);
  assert.strictEqual(inheritedAfter, 1);

  let releaseInherited;
  const waitingSet = { to: 'enterprise' };
  const waitingHooks = stageModule.createStageHooks({
    projectRoot: root, source: privateSource, packageFiles: ['index.js'], distRoot: path.join(root, 'dist'),
    fileSet: waitingSet,
    beforePack: () => new Promise((resolve) => { releaseInherited = resolve; }),
  });
  const waitingContext = { packager: { config: { files: [waitingSet] } } };
  const waitingFirst = waitingHooks.beforePack(waitingContext);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => waitingHooks.beforePack(waitingContext), /متداخل/);
  releaseInherited();
  await waitingFirst;
  await waitingHooks.afterPack(waitingContext);

  let hookAttempts = 0;
  const retrySet = { to: 'enterprise' };
  const retryHooks = stageModule.createStageHooks({
    projectRoot: root, source: privateSource, packageFiles: ['index.js'], distRoot: path.join(root, 'dist'),
    fileSet: retrySet,
    beforePack() {
      hookAttempts += 1;
      if (hookAttempts === 1) throw new Error('inherited hook probe');
    },
  });
  const retryContext = { packager: { config: { files: [retrySet] } } };
  await assert.rejects(() => retryHooks.beforePack(retryContext), /inherited hook probe/);
  await retryHooks.beforePack(retryContext);
  await retryHooks.afterPack(retryContext);
  assert.strictEqual(hookAttempts, 2);
  const otherStage = fs.mkdtempSync(path.join(root, 'dist', stageModule.STAGE_PREFIX));
  const childCode = `const s=require('./scripts/enterprise-stage'),f={to:'enterprise'},h=s.createStageHooks({projectRoot:process.argv[1],source:process.argv[2],packageFiles:['index.js'],distRoot:process.argv[3],fileSet:f});h.beforePack({packager:{config:{files:[f]}}}).then(()=>process.stdout.write(f.from)).catch(e=>{console.error(e);process.exitCode=1})`;
  const child = spawnSync(process.execPath, ['-e', childCode, root, privateSource, path.join(root, 'dist')], {
    cwd: root, encoding: 'utf8',
  });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(fs.existsSync(child.stdout.trim()), false);
  assert.strictEqual(fs.existsSync(otherStage), true);
  stageModule.cleanupStage({ projectRoot: root, distRoot: path.join(root, 'dist'), stagePath: otherStage });

  const junctionProject = path.join(tempRoot, 'junction-project');
  const junctionOutside = path.join(tempRoot, 'junction-outside');
  fs.mkdirSync(junctionProject);
  fs.mkdirSync(junctionOutside);
  fs.writeFileSync(path.join(junctionOutside, 'keep.txt'), 'keep\n');
  fs.symlinkSync(junctionOutside, path.join(junctionProject, 'dist'), 'junction');
  assert.throws(() => stageModule.prepareStage({
    projectRoot: junctionProject, source: privateSource, packageFiles: ['index.js'],
    distRoot: path.join(junctionProject, 'dist'),
  }), /رابط أو مسار غير صالح/);
  assert.throws(() => stageModule.cleanupStage({
    projectRoot: junctionProject, distRoot: path.join(junctionProject, 'dist'),
    stagePath: path.join(junctionProject, 'dist', stageModule.STAGE_PREFIX + 'foreign'),
  }), /رابط أو مسار غير صالح/);
  assert.strictEqual(fs.readFileSync(path.join(junctionOutside, 'keep.txt'), 'utf8'), 'keep\n');
  console.log('✓ staging copies only the frozen allowlist and cleans failures and isolated builds');
  if (previous === undefined) delete process.env.SATR_ENTERPRISE_DIR;
  else process.env.SATR_ENTERPRISE_DIR = previous;
  delete require.cache[configPath];
  console.log('✓ Enterprise build injects private source and disables publishing');

  assert.strictEqual(fs.existsSync(path.join(root, 'enterprise')), false);
  const packageJson = require('../package.json');
  assert(Array.isArray(packageJson.build.publish) && packageJson.build.publish[0].provider === 'github');
  assert.match(packageJson.scripts['dist:ee'], /--publish never(?:\s|$)/);
  assert(packageJson.build.files.includes('!enterprise/**'));
  assert(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('/enterprise/'));

  const featuresPath = require.resolve('../electron/features');
  const originalLoad = Module._load;
  delete require.cache[featuresPath];
  Module._load = function loadWithoutEnterprise(request) {
    if (request === '../enterprise') throw new Error('enterprise intentionally absent');
    return originalLoad.apply(this, arguments);
  };
  try {
    const features = require('../electron/features');
    assert.strictEqual(features.init().loaded, false);
    assert.strictEqual(features.isEnterprise(), false);
    assert.strictEqual(features.enabled('usage_panel'), false);
    assert.strictEqual(features.enabled('audit_log'), false);
    assert.strictEqual(features.edition(), 'community');
    assert.deepStrictEqual(features.snapshot(), {
      edition: 'community', runtimeStatus: 'community', enterprise: false, flags: {}, info: null,
    });
    assert.strictEqual(typeof require('../electron/adapters').get('ollama').start, 'function');
  } finally {
    Module._load = originalLoad;
    delete require.cache[featuresPath];
  }

  // §4.5: قناة satr:ee:* المسجَّلة عبر seam.registerIpc تمرّ من حارس الثقة نفسه الذي تمرّ منه
  // قنوات النواة — مرسِل أو إطار غير موثوق يفشل مغلقاً بـ untrusted_sender ولا يصل للمعالج.
  const renderertrust = require('../electron/renderertrust');
  const registered = new Map(); // ما وصل فعلاً إلى ipcMain «الخام» (electron)
  const rawIpcMain = { handle: (ch, fn) => { registered.set(ch, fn); } };
  const trustedUrl = renderertrust.fileUrl(path.join(root, 'src', 'index.html'));
  const mainFrame = { url: trustedUrl };
  const webContents = { mainFrame };
  const mainWindow = { isDestroyed: () => false, webContents };
  const guardedIpcMain = renderertrust.guardIpcMain(rawIpcMain, () => mainWindow, trustedUrl);
  let seams = null;
  let handlerCalls = 0;
  const completeExecutionSeam = {};
  for (const name of [
    'getProjectContext', 'projectInfo', 'storeFor', 'sameWindow', 'reserve', 'bindRun', 'snapshotVerification',
    'verificationCatalog', 'launch', 'publish', 'resolveControl', 'stop', 'runVerification',
    'release', 'registerShutdown',
  ]) completeExecutionSeam[name] = () => {};
  Module._load = function loadFakeEnterprise(request) {
    if (request === '../enterprise') {
      return { register(s) {
        seams = s;
        assert.strictEqual(typeof s.savedTasksExecution.verificationCatalog, 'function');
        s.registerIpc('satr:ee:probe', () => { handlerCalls += 1; return { ok: true }; });
      } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const features = require('../electron/features');
    assert.strictEqual(features.init({ ipcMain: guardedIpcMain, savedTasksExecution: completeExecutionSeam }).loaded, true);
    assert.throws(() => seams.registerIpc('satr:probe', () => {}), /satr:ee:/);
    assert.throws(() => seams.registerIpc('satr:ee:bad', 'not-a-function'), /معالج غير صالح/);
    const listener = registered.get('satr:ee:probe');
    assert.strictEqual(typeof listener, 'function', 'قناة Enterprise يجب أن تُسجَّل عبر ipcMain المحروس');
    assert.deepStrictEqual(listener({ sender: {}, senderFrame: mainFrame }), { ok: false, error: 'untrusted_sender' });
    assert.deepStrictEqual(listener({ sender: webContents, senderFrame: { url: trustedUrl } }), { ok: false, error: 'untrusted_sender' });
    assert.deepStrictEqual(listener({ sender: webContents, senderFrame: { url: 'https://example.com' } }), { ok: false, error: 'untrusted_sender' });
    assert.strictEqual(handlerCalls, 0, 'المعالج لا يُستدعى لمرسِل غير موثوق');
    assert.deepStrictEqual(listener({ sender: webContents, senderFrame: mainFrame }), { ok: true });
    assert.strictEqual(handlerCalls, 1);
  } finally {
    Module._load = originalLoad;
    delete require.cache[featuresPath];
  }
  console.log('✓ Enterprise IPC channels share the core renderer-trust guard');

  // التسجيل الجزئي لا يترك قناة قابلة للاستعمال بعد فشل Enterprise.
  const partialRegistered = new Map();
  const partialRaw = { handle: (ch, fn) => { partialRegistered.set(ch, fn); } };
  const partialGuarded = renderertrust.guardIpcMain(partialRaw, () => mainWindow, trustedUrl);
  Module._load = function loadFailingEnterprise(request) {
    if (request === '../enterprise') {
      return {
        register(s) {
          s.registerIpc('satr:ee:partial-probe', () => ({ ok: true, mutated: true }));
          throw new Error('partial registration failure');
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const features = require('../electron/features');
    const initialized = features.init({ ipcMain: partialGuarded });
    assert.strictEqual(initialized.loaded, false);
    assert.strictEqual(initialized.status, 'registration_failed');
    const partial = partialRegistered.get('satr:ee:partial-probe');
    assert.strictEqual(typeof partial, 'function');
    assert.deepStrictEqual(partial({ sender: webContents, senderFrame: mainFrame }),
      { ok: false, error: 'feature_unavailable' });
  } finally {
    Module._load = originalLoad;
    delete require.cache[featuresPath];
  }
  console.log('✓ partially registered Enterprise IPC fails closed after registration error');

  const updater = require('../electron/updater');
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community' }), true);
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community', signed: true }), true);
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'community', signed: false }), false);
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: true }, { edition: 'enterprise' }), false);
  assert.strictEqual(updater.shouldEnableUpdates({ isPackaged: false }, { edition: 'community' }), false);
  console.log('✓ Community contains no proprietary source and falls back cleanly');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
