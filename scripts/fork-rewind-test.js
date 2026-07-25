#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const GOOD_SESSION = '24881e7d-b69a-4226-b3fc-82eaece280e0';
const GOOD_MESSAGE = '86fd3891-16cc-4578-af86-eb7aa27cc227';
const GOOD_FORK = 'ad070291-85bb-4415-b85f-3cfbaf2ca8fd';
const SECRET_SENTINEL = 'SECRET_SHOULD_NEVER_LEAK';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadMainHandlers() {
  const source = read('electron/main.js');
  const start = source.indexOf('let sdkSessionControlBusy = false;');
  const end = source.indexOf('function publishVerification(', start);
  assert.ok(start >= 0 && end > start, 'تعذر استخراج معالجات جلسة Claude من main.js');
  const uuidDeclaration = source.match(/const SAFE_UUID = [^\r\n]+;/);
  assert.ok(uuidDeclaration, 'SAFE_UUID غير موجود في main.js');
  const rewindMarkers = new Map();
  const sdkrewinds = {
    SAFE_CHECKPOINT: /^cp-[A-Za-z0-9-]{3,80}$/,
    failMark: false,
    get(sessionId) {
      const entry = rewindMarkers.get(String(sessionId).toLowerCase());
      return entry ? { ...entry } : null;
    },
    mark(sessionId, checkpointId) {
      if (this.failMark) return { ok: false, error: 'write_failed' };
      rewindMarkers.set(String(sessionId).toLowerCase(), { checkpointId, at: Date.now() });
      return { ok: true };
    },
    clear(sessionId) {
      return { ok: true, removed: rewindMarkers.delete(String(sessionId).toLowerCase()) };
    },
  };
  const sandbox = {
    fs,
    path,
    createHash,
    randomUUID,
    setTimeout,
    clearTimeout,
    checkpoints: { latest: () => ({ id: 'cp-test-123' }) },
    sdkrewinds,
    sessionmeta: require('../electron/sessionmeta'),
    agent: {},
    exported: {},
  };
  vm.runInNewContext(`
    ${uuidDeclaration[0]}
    ${source.slice(start, end)}
    exported.markSdkRunInFlight = markSdkRunInFlight;
    exported.stopSdkRun = stopSdkRun;
    exported.trackSdkStop = trackSdkStop;
    exported.runSdkSessionControl = runSdkSessionControl;
    exported.handleSessionForkRequest = handleSessionForkRequest;
    exported.handleRewindFilesRequest = handleRewindFilesRequest;
    exported.sdkrewinds = sdkrewinds;
  `, sandbox, { filename: 'main-fork-rewind-extract.js' });
  return sandbox.exported;
}

async function testMainSanitization() {
  const handlers = loadMainHandlers();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-fork-rewind-test-'));
  const trackedFile = path.join(cwd, 'src', 'app.js');
  fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
  fs.writeFileSync(trackedFile, 'AAAA\n');
  let forkCalls = 0;
  const rewindModes = [];
  const fakeAgent = {
    async forkSession(sessionId, upToMessageId, title) {
      forkCalls++;
      assert.equal(sessionId, GOOD_SESSION);
      assert.equal(upToMessageId, GOOD_MESSAGE);
      assert.equal(title, 'فرع آمن');
      return { ok: true, sessionId: GOOD_FORK };
    },
    async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
      rewindModes.push(dryRun);
      assert.equal(receivedCwd, path.resolve(cwd));
      assert.equal(sessionId, GOOD_SESSION);
      assert.equal(userMessageId, GOOD_MESSAGE);
      assert.equal(typeof dryRun, 'boolean');
      return {
        ok: true,
        canRewind: true,
        filesChanged: dryRun
          ? [path.join(cwd, 'src', 'app.js'), path.join(cwd, 'src', 'app.js')]
          : [],
        insertions: 7,
        deletions: 3,
      };
    },
  };

  try {
    const forked = await handlers.handleSessionForkRequest({
      sessionId: GOOD_SESSION,
      upToMessageId: GOOD_MESSAGE,
      title: '  فرع\u202e\u0000 آمن  ',
    }, fakeAgent);
    assert.equal(forked.ok, true);
    assert.equal(forked.sessionId, GOOD_FORK);
    assert.equal(forkCalls, 1);

    for (const invalid of [
      'daily-session',
      GOOD_SESSION.replaceAll('-', ''),
      GOOD_SESSION + '/child',
      GOOD_SESSION + '\u0000',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const result = await handlers.handleSessionForkRequest({ sessionId: invalid }, fakeAgent);
      assert.equal(result.ok, false, `قُبل sessionId مشوه: ${JSON.stringify(invalid)}`);
    }
    assert.equal(forkCalls, 1, 'وصل UUID مشوه إلى agent.forkSession');

    const badMessage = await handlers.handleSessionForkRequest({
      sessionId: GOOD_SESSION,
      upToMessageId: GOOD_MESSAGE + 'x',
    }, fakeAgent);
    assert.equal(badMessage.error, 'invalid_message');
    assert.equal(forkCalls, 1);

    const longTitle = await handlers.handleSessionForkRequest({
      sessionId: GOOD_SESSION,
      upToMessageId: GOOD_MESSAGE,
      title: 'x'.repeat(513),
    }, fakeAgent);
    assert.equal(longTitle.error, 'invalid_title');
    assert.equal(forkCalls, 1);

    let optionalArgs;
    const optional = await handlers.handleSessionForkRequest({ sessionId: GOOD_SESSION }, {
      async forkSession(...args) { optionalArgs = args; return { ok: true, sessionId: GOOD_FORK }; },
    });
    assert.equal(optional.ok, true);
    assert.equal(optionalArgs[1], undefined, 'upToMessageId الاختياري لم يبقَ محذوفاً');

    const malformedSdkId = await handlers.handleSessionForkRequest({ sessionId: GOOD_SESSION }, {
      async forkSession() { return { ok: true, sessionId: 'branch-not-uuid' }; },
    });
    assert.equal(malformedSdkId.error, 'sdk_invalid_response');

    const preview = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
      confirmed: false,
    }, fakeAgent);
    assert.equal(preview.ok, true);
    assert.equal(preview.canRewind, true);
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.filesChanged.length, 1);
    assert.equal(preview.filesChanged[0], 'src/app.js');
    assert.equal(preview.insertions, 7);
    assert.equal(preview.deletions, 3);
    assert.match(preview.previewToken, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(rewindModes, [true]);

    const gated = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: false,
    }, fakeAgent);
    assert.equal(gated.error, 'confirmation_required');
    assert.deepEqual(rewindModes, [true], 'تجاوز التنفيذ الفعلي بوابة confirmed');

    const confirmed = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: preview.previewToken,
    }, fakeAgent);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.suppressedCheckpointId, 'cp-test-123');
    assert.equal(handlers.sdkrewinds.get(GOOD_SESSION).checkpointId, 'cp-test-123');
    assert.deepEqual(rewindModes, [true, true, false], 'لم يُعد main المعاينة قبل التنفيذ الفعلي');

    const replayedToken = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: preview.previewToken,
    }, fakeAgent);
    assert.equal(replayedToken.error, 'preview_required');
    assert.deepEqual(rewindModes, [true, true, false], 'أعيد استخدام previewToken مستهلك');

    const unsafeModes = [];
    const unsafeAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        unsafeModes.push(dryRun);
        assert.equal(dryRun, true, 'وصل التنفيذ الفعلي إلى SDK رغم مسار خارج cwd');
        return {
          ok: true,
          canRewind: true,
          filesChanged: [path.join(cwd, 'src', 'app.js'), '../outside-secret.txt'],
          insertions: 8,
          deletions: 4,
        };
      },
    };
    const unsafePreview = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
    }, unsafeAgent);
    assert.equal(unsafePreview.ok, true);
    assert.equal(unsafePreview.canRewind, false);
    assert.equal(unsafePreview.error, 'outside_cwd');
    assert.equal(unsafePreview.outsideCount, 1);
    assert.equal(unsafePreview.fileCount, 1);
    assert.ok(!JSON.stringify(unsafePreview).includes('outside-secret'), 'تسرّب مسار خارج cwd إلى renderer');

    const unsafeActual = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
    }, unsafeAgent);
    assert.equal(unsafeActual.error, 'preview_required');
    assert.deepEqual(unsafeModes, [true], 'وصل طلب بلا previewToken إلى SDK');

    let previewChanged = false;
    const changedModes = [];
    const changingAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        changedModes.push(dryRun);
        assert.equal(dryRun, true, 'نُفّذ actual رغم تغيّر المعاينة');
        return {
          ok: true,
          canRewind: true,
          filesChanged: [previewChanged ? 'src/changed.js' : 'src/app.js'],
          insertions: previewChanged ? 9 : 7,
          deletions: 3,
        };
      },
    };
    const firstShape = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
    }, changingAgent);
    previewChanged = true;
    const changedActual = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: firstShape.previewToken,
    }, changingAgent);
    assert.equal(changedActual.error, 'preview_changed');
    assert.deepEqual(changedModes, [true, true]);

    const originalStat = fs.statSync(trackedFile);
    const contentModes = [];
    const contentAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        contentModes.push(dryRun);
        assert.equal(dryRun, true, 'نُفّذ actual رغم تغيّر محتوى الملف');
        return { ok: true, canRewind: true, filesChanged: ['src/app.js'], insertions: 7, deletions: 3 };
      },
    };
    const contentPreview = await handlers.handleRewindFilesRequest({
      cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true,
    }, contentAgent);
    fs.writeFileSync(trackedFile, 'BBBB\n');
    fs.utimesSync(trackedFile, originalStat.atime, originalStat.mtime);
    const contentChanged = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: contentPreview.previewToken,
    }, contentAgent);
    assert.equal(contentChanged.error, 'preview_changed');
    assert.deepEqual(contentModes, [true, true]);
    fs.writeFileSync(trackedFile, 'AAAA\n');

    const secondFile = path.join(cwd, 'src', 'second.js');
    fs.writeFileSync(secondFile, 'second\n');
    let reverseOrder = false;
    const orderModes = [];
    const orderAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        orderModes.push(dryRun);
        if (!dryRun) return { ok: true, canRewind: true, filesChanged: [] };
        const filesChanged = reverseOrder
          ? ['src/second.js', 'src/app.js']
          : ['src/app.js', 'src/second.js'];
        return { ok: true, canRewind: true, filesChanged, insertions: 2, deletions: 1 };
      },
    };
    const orderPreview = await handlers.handleRewindFilesRequest({
      cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true,
    }, orderAgent);
    reverseOrder = true;
    const orderActual = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: orderPreview.previewToken,
    }, orderAgent);
    assert.equal(orderActual.ok, true, 'غيّر ترتيب SDK وحده بصمة المعاينة');
    assert.deepEqual(orderModes, [true, true, false]);

    const largeFile = path.join(cwd, 'src', 'large.bin');
    fs.writeFileSync(largeFile, Buffer.alloc(16 * 1024 * 1024 + 1));
    const fingerprintLimited = await handlers.handleRewindFilesRequest({
      cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true,
    }, {
      async rewindFiles() { return { ok: true, canRewind: true, filesChanged: ['src/large.bin'] }; },
    });
    assert.equal(fingerprintLimited.error, 'fingerprint_limit');
    assert.equal(fingerprintLimited.previewToken, undefined);
    fs.rmSync(largeFile, { force: true });

    const directoryPreview = await handlers.handleRewindFilesRequest({
      cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true,
    }, {
      async rewindFiles() { return { ok: true, canRewind: true, filesChanged: ['src'] }; },
    });
    assert.equal(directoryPreview.error, 'invalid_file_type');

    const largeModes = [];
    const largeAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        largeModes.push(dryRun);
        return {
          ok: true,
          canRewind: true,
          filesChanged: Array.from({ length: 501 }, (_, index) => `src/file-${index}.js`),
        };
      },
    };
    const tooLarge = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
    }, largeAgent);
    assert.equal(tooLarge.error, 'too_many_files');
    assert.deepEqual(largeModes, [true], 'نُفّذت قائمة تجاوزت سقف ملفات الاسترجاع');

    for (const payload of [
      { cwd: path.join(cwd, 'missing'), sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true },
      { cwd, sessionId: 'bad', userMessageId: GOOD_MESSAGE, dryRun: true },
      { cwd, sessionId: GOOD_SESSION, userMessageId: 'bad', dryRun: true },
      { cwd, sessionId: GOOD_SESSION, userMessageId: 'bad', dryRun: false, confirmed: true },
      { cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: 'true' },
    ]) {
      const result = await handlers.handleRewindFilesRequest(payload, fakeAgent);
      assert.equal(result.ok, false, 'قُبلت حمولة rewind مشوهة');
    }
    assert.deepEqual(rewindModes, [true, true, false], 'وصلت حمولة rewind مشوهة إلى agent');

    const malformedList = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
    }, {
      async rewindFiles() {
        return { ok: true, canRewind: true, filesChanged: [{ path: 'src/app.js' }] };
      },
    });
    assert.equal(malformedList.error, 'sdk_invalid_response');

    const bidiPath = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
    }, {
      async rewindFiles() {
        return { ok: true, canRewind: true, filesChanged: ['src/\u202esecret.js'] };
      },
    });
    assert.equal(bidiPath.error, 'sdk_invalid_response');

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-fork-rewind-outside-'));
    const linkedOutside = path.join(cwd, 'linked-outside');
    try {
      fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside');
      fs.symlinkSync(outsideRoot, linkedOutside, process.platform === 'win32' ? 'junction' : 'dir');
      const symlinkPath = await handlers.handleRewindFilesRequest({
        cwd,
        sessionId: GOOD_SESSION,
        userMessageId: GOOD_MESSAGE,
        dryRun: true,
      }, {
        async rewindFiles() {
          return { ok: true, canRewind: true, filesChanged: ['linked-outside/secret.txt'] };
        },
      });
      assert.equal(symlinkPath.error, 'symlink_path');
    } finally {
      fs.rmSync(linkedOutside, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }

    const thrownFork = await handlers.handleSessionForkRequest({ sessionId: GOOD_SESSION }, {
      async forkSession() { throw new Error(SECRET_SENTINEL); },
    });
    assert.equal(thrownFork.error, 'sdk_unavailable');
    assert.ok(!JSON.stringify(thrownFork).includes(SECRET_SENTINEL), 'تسرّب خطأ SDK من IPC التفريع');

    const thrownRewind = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: true,
    }, {
      async rewindFiles() { throw new Error(SECRET_SENTINEL); },
    });
    assert.equal(thrownRewind.error, 'sdk_unavailable');
    assert.ok(!JSON.stringify(thrownRewind).includes(SECRET_SENTINEL), 'تسرّب خطأ SDK من IPC الاسترجاع');

    handlers.sdkrewinds.clear(GOOD_SESSION);
    handlers.sdkrewinds.failMark = true;
    const markerFailureModes = [];
    const markerFailureAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        markerFailureModes.push(dryRun);
        return { ok: true, canRewind: true, filesChanged: ['src/app.js'] };
      },
    };
    const markerFailurePreview = await handlers.handleRewindFilesRequest({
      cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true,
    }, markerFailureAgent);
    const markerFailure = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: markerFailurePreview.previewToken,
    }, markerFailureAgent);
    assert.equal(markerFailure.error, 'marker_write_failed');
    assert.deepEqual(markerFailureModes, [true, true], 'وصل actual إلى SDK بعد فشل حفظ حاجز checkpoint');
    handlers.sdkrewinds.failMark = false;

    handlers.sdkrewinds.clear(GOOD_SESSION);
    const failingActualModes = [];
    const failingActualAgent = {
      async rewindFiles(receivedCwd, sessionId, userMessageId, dryRun) {
        failingActualModes.push(dryRun);
        if (!dryRun) throw new Error(SECRET_SENTINEL);
        return { ok: true, canRewind: true, filesChanged: ['src/app.js'] };
      },
    };
    const failingActualPreview = await handlers.handleRewindFilesRequest({
      cwd, sessionId: GOOD_SESSION, userMessageId: GOOD_MESSAGE, dryRun: true,
    }, failingActualAgent);
    const failingActual = await handlers.handleRewindFilesRequest({
      cwd,
      sessionId: GOOD_SESSION,
      userMessageId: GOOD_MESSAGE,
      dryRun: false,
      confirmed: true,
      previewToken: failingActualPreview.previewToken,
    }, failingActualAgent);
    assert.equal(failingActual.error, 'sdk_unavailable');
    assert.deepEqual(failingActualModes, [true, true, false]);
    assert.equal(handlers.sdkrewinds.get(GOOD_SESSION).checkpointId, 'cp-test-123', 'مُسحت علامة checkpoint بعد actual غير مؤكّد');

    let releaseFirst;
    const first = handlers.runSdkSessionControl(() => new Promise((resolve) => { releaseFirst = resolve; }));
    await Promise.resolve();
    const overlapping = await handlers.runSdkSessionControl(async () => ({ ok: true }));
    assert.equal(overlapping.error, 'session_control_busy');
    releaseFirst({ ok: true, marker: 'first' });
    assert.equal((await first).marker, 'first');
    const afterRelease = await handlers.runSdkSessionControl(async () => ({ ok: true, marker: 'next' }));
    assert.equal(afterRelease.marker, 'next');
    handlers.markSdkRunInFlight(true);
    const sendFirst = await handlers.runSdkSessionControl(async () => ({ ok: true }));
    assert.equal(sendFirst.error, 'session_run_busy');
    handlers.markSdkRunInFlight(false);

    let releaseDone;
    let stopCalled = false;
    const pendingRun = {
      async stop() { stopCalled = true; },
      done: new Promise((resolve) => { releaseDone = resolve; }),
    };
    handlers.markSdkRunInFlight(true);
    const trackedStop = handlers.trackSdkStop(handlers.stopSdkRun(pendingRun));
    await Promise.resolve();
    assert.equal(stopCalled, true);
    handlers.markSdkRunInFlight(false); // يحاكي proc_done المبكر؛ sdkStoppingPromise يجب أن يبقى الحارس
    const whileStopping = await handlers.runSdkSessionControl(async () => ({ ok: true }));
    assert.equal(whileStopping.error, 'session_run_busy');
    let stopSettled = false;
    trackedStop.then(() => { stopSettled = true; });
    await Promise.resolve();
    assert.equal(stopSettled, false, 'حُسم إيقاف SDK قبل انتهاء استهلاك Query');
    releaseDone();
    await trackedStop;
    const afterDone = await handlers.runSdkSessionControl(async () => ({ ok: true, marker: 'after-done' }));
    assert.equal(afterDone.marker, 'after-done');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testSdkRewindStore() {
  const { createStore } = require('../electron/sdkrewinds');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-sdk-rewinds-store-'));
  const file = path.join(cwd, 'sdk-native-rewinds.json');
  let failRename = false;
  const io = Object.assign(Object.create(fs), {
    renameSync(from, to) {
      if (failRename) throw new Error('rename_failed');
      return fs.renameSync(from, to);
    },
  });
  try {
    const store = createStore({ file, fs: io });
    assert.equal(store.mark('bad', 'cp-test-123').error, 'bad_input');
    assert.equal(store.mark(GOOD_SESSION, 'bad').error, 'bad_input');
    assert.equal(store.mark(GOOD_SESSION.toUpperCase(), 'cp-test-123').ok, true);
    assert.equal(store.get(GOOD_SESSION).checkpointId, 'cp-test-123');
    assert.equal(createStore({ file }).get(GOOD_SESSION).checkpointId, 'cp-test-123');

    failRename = true;
    assert.equal(store.clear(GOOD_SESSION).error, 'write_failed');
    assert.equal(store.get(GOOD_SESSION).checkpointId, 'cp-test-123', 'غيّر clear الفاشل حالة الذاكرة');
    assert.equal(createStore({ file }).get(GOOD_SESSION).checkpointId, 'cp-test-123', 'غيّر clear الفاشل حالة القرص');
    failRename = false;
    assert.equal(store.clear(GOOD_SESSION).ok, true);
    assert.equal(createStore({ file }).get(GOOD_SESSION), null);

    failRename = true;
    assert.equal(store.mark(GOOD_SESSION, 'cp-test-456').error, 'write_failed');
    assert.equal(store.get(GOOD_SESSION), null, 'غيّر mark الفاشل حالة الذاكرة');
    assert.equal(createStore({ file }).get(GOOD_SESSION), null, 'غيّر mark الفاشل حالة القرص');
    failRename = false;
    fs.writeFileSync(file, '{not-json', 'utf8');
    assert.equal(createStore({ file }).get(GOOD_SESSION), null, 'لم يتدهور ملف sidecar تالف إلى مخزن فارغ');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAgentControls() {
  const { createSessionControls } = require('../electron/agent');
  let forkOptions;
  let controlCall;
  const controls = createSessionControls({
    loadSdk: async () => ({
      async forkSession(sessionId, options) {
        assert.equal(sessionId, GOOD_SESSION);
        forkOptions = options;
        return { sessionId: GOOD_FORK };
      },
    }),
    withControlQuery: async (cwd, sessionId, fn, options) => {
      controlCall = { cwd, sessionId, options };
      return fn({
        rewindFiles: async (messageId, rewindOptions) => {
          assert.equal(messageId, GOOD_MESSAGE);
          assert.equal(rewindOptions.dryRun, true);
          return { canRewind: true, filesChanged: ['src/app.js'], insertions: 4, deletions: 2 };
        },
      });
    },
  });

  const forked = await controls.fork(GOOD_SESSION, GOOD_MESSAGE, '  عنوان\u202e\u0000 آمن  ');
  assert.equal(forked.ok, true);
  assert.equal(forked.sessionId, GOOD_FORK);
  assert.equal(forkOptions.upToMessageId, GOOD_MESSAGE);
  assert.equal(forkOptions.title, 'عنوان آمن');
  assert.equal(Object.prototype.hasOwnProperty.call(forkOptions, 'dir'), false);

  const oversizedTitle = await controls.fork(GOOD_SESSION, GOOD_MESSAGE, 'x'.repeat(513));
  assert.equal(oversizedTitle.error, 'invalid_title');

  const rewind = await controls.rewind('C:\\repo', GOOD_SESSION, GOOD_MESSAGE, true);
  assert.equal(rewind.ok, true);
  assert.equal(rewind.canRewind, true);
  assert.equal(rewind.insertions, 4);
  assert.equal(controlCall.sessionId, GOOD_SESSION);
  assert.equal(controlCall.options.enableFileCheckpointing, true, 'لم يُفعّل checkpointing في withControlQuery');

  const missingFork = createSessionControls({ loadSdk: async () => ({}) });
  const unsupported = await missingFork.fork(GOOD_SESSION);
  assert.equal(unsupported.error, 'sdk_unavailable');

  const throwingFork = createSessionControls({
    loadSdk: async () => ({
      async forkSession() { throw new Error(SECRET_SENTINEL); },
    }),
  });
  const failedFork = await throwingFork.fork(GOOD_SESSION);
  assert.equal(failedFork.error, 'sdk_unavailable');
  assert.ok(!JSON.stringify(failedFork).includes(SECRET_SENTINEL), 'تسرّب خطأ SDK من agent.fork');

  const throwingRewind = createSessionControls({
    withControlQuery: async () => { throw new Error(SECRET_SENTINEL); },
  });
  const failedRewind = await throwingRewind.rewind('C:\\repo', GOOD_SESSION, GOOD_MESSAGE, true);
  assert.equal(failedRewind.error, 'sdk_unavailable');
  assert.ok(!JSON.stringify(failedRewind).includes(SECRET_SENTINEL), 'تسرّب خطأ SDK من agent.rewind');

  const largeControls = createSessionControls({
    withControlQuery: async (cwd, sessionId, fn) => fn({
      rewindFiles: async () => ({
        canRewind: true,
        filesChanged: Array.from({ length: 502 }, (_, index) => `src/file-${index}.js`),
      }),
    }),
  });
  const largeRewind = await largeControls.rewind('C:\\repo', GOOD_SESSION, GOOD_MESSAGE, true);
  assert.equal(largeRewind.filesChanged.length, 501, 'أخفى agent تجاوز قائمة SDK قبل فحص main');

  const missingFilesControls = createSessionControls({
    withControlQuery: async (cwd, sessionId, fn) => fn({
      rewindFiles: async () => ({ canRewind: true }),
    }),
  });
  const missingFiles = await missingFilesControls.rewind('C:\\repo', GOOD_SESSION, GOOD_MESSAGE, true);
  assert.equal(missingFiles.error, 'sdk_invalid_response');
}

function testWiring() {
  const agentSource = read('electron/agent.js');
  const mainSource = read('electron/main.js');
  const preloadSource = read('electron/preload.js');
  const sessionsSource = read('electron/sessions.js');
  const appSource = read('src/ui/app.js');
  const chatSource = read('src/ui/components/chat.js');
  const packageJson = JSON.parse(read('package.json'));
  const fullSuite = read('scripts/full-suite.js');

  assert.match(agentSource, /uuid:\s*promptUserMessageId/);
  assert.match(agentSource, /rememberUserMessage\(observedSessionId, promptUserMessageId\)/);
  assert.match(agentSource, /if \(!internalPolicy\) options\.enableFileCheckpointing = true/);
  assert.match(agentSource, /result\.filesChanged\.slice\(0, 501\)/);
  assert.match(agentSource, /const done = \(async \(\) =>/);
  assert.match(agentSource, /await Promise\.race\(\[\s*consumed/);
  assert.match(mainSource, /mode:\s*'ops-room'/);
  assert.match(mainSource, /ipcMain\.handle\('satr:sessionFork'/);
  assert.match(mainSource, /ipcMain\.handle\('satr:rewindFiles'/);
  assert.match(mainSource, /runSdkSessionControl/);
  assert.match(mainSource, /normalizeRewindPreview/);
  assert.match(mainSource, /rememberRewindPreview/);
  assert.match(mainSource, /preview_changed/);
  assert.match(mainSource, /markSdkRunInFlight\(true\)/);
  assert.match(mainSource, /sdkrewinds\.mark/);
  assert.match(mainSource, /sdkrewinds\.get/);
  assert.match(mainSource, /sdkrewinds\.clear/);
  assert.doesNotMatch(mainSource, /sdkNativeRewindCheckpoints/);
  assert.match(mainSource, /createHash\('sha256'\)\.update\(content\)/);
  assert.match(mainSource, /settleSdkPromise\(\s*run\.done/);
  assert.match(agentSource, /forceClose\(\)/);
  assert.match(mainSource, /sdkStartingPromise/);
  assert.match(mainSource, /if \(sendRequestBusy\)/);
  assert.match(mainSource, /sendRequestBusy = true/);
  assert.match(mainSource, /sendRequestBusy = false/);
  assert.match(mainSource, /requestEpoch !== sendRequestEpoch/);
  assert.match(mainSource, /ipcMain\.handle\('satr:stop',[\s\S]*?cancelPendingSendRequest\(\)/);
  assert.match(mainSource, /await stopAll\(\)/);
  assert.match(mainSource, /payload\.userMessageId,\s*false/);
  assert.match(preloadSource, /sessionFork:\s*\(/);
  assert.match(preloadSource, /rewindFiles:\s*\(/);
  assert.match(preloadSource, /previewToken/);
  assert.match(sessionsSource, /message\.messageId = e\.uuid/);
  assert.match(chatSource, /🌿 فرّع من هنا/);
  assert.match(chatSource, /user-rewind/);
  assert.match(chatSource, /trimAfterSdkUserMessage/);
  assert.match(chatSource, /closeThreadSearch\(\)/);
  assert.match(chatSource, /source:\s*rewind/);
  assert.match(appSource, /dryRun|rewindFiles/);
  assert.match(appSource, /false,\s*\n\s*true,/);
  assert.match(appSource, /sessionControlEpochIsCurrent/);
  assert.match(appSource, /sessionControlBusy \|\| sessionResumeBusy/);
  assert.match(appSource, /preview\.previewToken/);
  assert.match(appSource, /suppressedCheckpointId/);
  assert.match(appSource, /\$\('engine'\)\.value !== engine \|\| sessionId !== sid/);
  assert.equal(packageJson.scripts['test:fork-rewind'], 'node scripts/fork-rewind-test.js');
  assert.match(fullSuite, /'test:fork-rewind'/);
}

async function main() {
  await testMainSanitization();
  testSdkRewindStore();
  await testAgentControls();
  testWiring();
  console.log('fork-rewind-test: ok — UUID صارم، previewToken، تتبّع UUID، مسارات fail-closed، وقفل ثنائي الاتجاه');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
