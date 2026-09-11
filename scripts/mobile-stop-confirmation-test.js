#!/usr/bin/env node
'use strict';

// OBS-147: دوال طرفي الإنتاج نفسها؛ النقل المضبوط يقبل HTTP 202 بلا حاسوب.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const RUN_A = 'aaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbb';

function sourceFunction(source, name, sandbox) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'missing_source_function:' + name);
  const body = source.indexOf('{', start + marker.length);
  let depth = 0;
  let end = -1;
  for (let index = body; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) { end = index + 1; break; }
  }
  assert.ok(end > start, 'bad_source_function:' + name);
  const from = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
  return vm.runInNewContext('(' + source.slice(from, end) + ')', sandbox);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mainRuntime() {
  const source = read('electron/main.js');
  const frames = [];
  const done = deferred();
  const stop = deferred();
  const timers = new Set();
  const sandbox = {
    mobileRunToken: RUN_A, runSeq: 1, currentRun: { done: done.promise },
    currentCliRun: null, sdkStartingPromise: null, mobileStopRequest: null,
    MOBILE_STOP_CONFIRM_TIMEOUT_MS: 15000,
    mobileStateRaw: { phase: 'working' },
    mobileDebug() {}, cancelPendingSendRequest() {},
    stopAll: () => stop.promise,
    publishMobileState: (frame) => frames.push(plain(frame)),
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  };
  const handleStop = sourceFunction(source, 'handleMobileStop', sandbox);
  return { sandbox, frames, done, stop, timers, handleStop };
}

function phoneRuntime() {
  const source = read('pwa/app.js');
  const messages = [];
  const posted = [];
  const timers = new Set();
  const state = {
    session: {}, currentRun: RUN_A, currentEnvelope: { run: RUN_A },
    polling: false, stopped: false,
    serverUrl: 'https://desktop.invalid', relayUrl: 'https://relay.invalid',
    boxes: { toDesktop: 'test-box' },
  };
  const sandbox = {
    state, latestState: null, pendingStop: null, STOP_CONFIRM_TIMEOUT_MS: 20000,
    crypto: require('node:crypto').webcrypto, Uint8Array, Date, JSON,
    C: { utf8ToBytes: (text) => text, seal: async (_session, bytes) => bytes },
    reserveSendCounters: async () => {}, usingRelay: () => true,
    setStatus: (text) => messages.push(text),
    hideCard() { state.currentEnvelope = null; },
    startPolling() { state.polling = true; },
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
    fetch: async (_url, options) => {
      posted.push(JSON.parse(options.body));
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    },
  };
  for (const name of ['postFrame', 'sendUplink', 'commandResultFromFrame', 'handleCommandResult', 'stopAgent']) {
    if (source.includes('function ' + name + '(')) sandbox[name] = sourceFunction(source, name, sandbox);
  }
  return { sandbox, state, messages, posted, timers, stopAgent: sandbox.stopAgent };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function testMobileStopConfirmation() {
  const failures = [];
  async function check(name, fn) {
    try { await fn(); console.log('mobile-stop-confirmation: ok ' + name); }
    catch (error) { failures.push(error); console.error(error.stack); }
  }

  await check('relay-202-is-not-confirmation', async () => {
    const phone = phoneRuntime();
    await phone.stopAgent();
    assert.equal(phone.posted.length, 1);
    assert.ok(!phone.messages.some((text) => text.includes('أوقف سطح المكتب الدور')),
      'OBS-147: HTTP 202 was reported as desktop stop completion');
    assert.ok(phone.state.polling, 'يجب استئناف الاستقصاء لاستقبال التأكيد');
    assert.ok(phone.state.currentEnvelope, 'اختفت بطاقة الإذن قبل تأكيد الإيقاف');
    assert.equal(phone.messages.at(-1), 'أُرسل أمر الإيقاف — بانتظار تأكيد الحاسوب.');
  });

  await check('main-waits-for-owner-done', async () => {
    const runtime = mainRuntime();
    const reports = [];
    assert.equal(runtime.handleStop(RUN_A, (status) => reports.push(status)), true);
    assert.deepEqual(runtime.frames, [], 'OBS-147: desktop published stopped before run.done');
    runtime.stop.resolve();
    await flush();
    assert.deepEqual(runtime.frames, [], 'stopAll وحدها لا تثبت اكتمال الدور');
    runtime.done.resolve();
    await flush();
    assert.deepEqual(runtime.frames, [{ phase: 'stopped' }]);
    assert.deepEqual(reports, ['stopped']);
  });


  await check('main-stale-token-and-generation', async () => {
    for (const sameToken of [false, true]) {
      const r = mainRuntime(), reports = [];
      assert.equal(r.handleStop(RUN_B), false);
      assert.equal(r.sandbox.mobileStopRequest, null);
      r.handleStop(RUN_A, (status) => reports.push(status));
      r.sandbox.runSeq++;
      if (!sameToken) r.sandbox.mobileRunToken = RUN_B;
      r.done.resolve();
      await flush();
      assert.deepEqual(reports, ['stale_run']);
      assert.deepEqual(r.frames, [], 'OBS-147: late stop A changed B');
    }
  });

  await check('main-unknown-is-not-stopped', async () => {
    for (const failure of ['timeout', 'missing-done', 'rejected-done', 'failed-stop']) {
      const r = mainRuntime(), reports = [];
      if (failure === 'missing-done') r.sandbox.currentRun = {};
      r.handleStop(RUN_A, (status) => reports.push(status));
      if (failure === 'timeout') for (const timer of [...r.timers]) timer();
      if (failure === 'rejected-done') r.done.reject(Error('run_failed'));
      if (failure === 'failed-stop') r.stop.reject(Error('stop_failed'));
      await flush();
      assert.deepEqual(reports, ['unknown'], failure);
      r.done.resolve();
      await flush();
      assert.deepEqual(r.frames, [], 'OBS-147: uncertain stop published stopped');
      assert.deepEqual(reports, ['unknown'], 'لا تأكيد ثانياً بعد المهلة');
    }
  });

  await check('main-starting-and-repeated-stop', async () => {
    const r = mainRuntime(), reports = [], starting = deferred();
    r.sandbox.currentRun = null;
    r.sandbox.sdkStartingPromise = starting.promise;
    let stops = 0;
    r.sandbox.stopAll = (all) => { assert.equal(all, false); stops++; return r.stop.promise; };
    r.handleStop(RUN_A, (status) => reports.push(status));
    r.handleStop(RUN_A, (status) => reports.push(status));
    assert.equal(stops, 1, 'إعادة الطلب لا تكرر إيقاف الدور');
    starting.resolve({ done: r.done.promise });
    await flush();
    assert.deepEqual(r.frames, []);
    r.done.resolve();
    await flush();
    assert.deepEqual(reports, ['stopped', 'stopped']);
    assert.deepEqual(r.frames, [{ phase: 'stopped' }]);
  });

  await check('main-result-cannot-bypass-pending-stop', async () => {
    const r = mainRuntime();
    Object.assign(r.sandbox, { mobileResultCost: () => null });
    const finish = sourceFunction(read('electron/main.js'), 'finishMobileRunState', r.sandbox);
    r.handleStop(RUN_A);
    finish({ type: 'proc_done', code: 0 });
    assert.deepEqual(r.frames, [], 'OBS-147: proc_done bypassed pending stop confirmation');
    r.done.resolve();
    await flush();
    assert.deepEqual(r.frames, [{ phase: 'stopped' }]);
  });


  await check('phone-seal-failure-is-reported', async () => {
    const phone = phoneRuntime();
    phone.sandbox.C.seal = async () => { throw Error('seal_failed'); };
    await phone.stopAgent();
    assert.equal(phone.sandbox.pendingStop, null);
    assert.equal(phone.posted.length, 0);
    assert.match(phone.messages.at(-1), /فشل إرسال أمر الإيقاف: seal_failed/);
  });

  function result(phone, status = 'stopped') {
    return { v: 1, type: 'command_result',
      command_id: phone.sandbox.pendingStop.command_id, run: RUN_A, status };
  }

  await check('phone-requires-matching-command-and-run', async () => {
    const phone = phoneRuntime();
    await phone.stopAgent();
    const matching = result(phone), pending = phone.sandbox.pendingStop;
    for (const frame of [
      { ...matching, command_id: 'ffffffffffffffff' }, { ...matching, run: RUN_B },
      { ...matching, extra: true }, { ...matching, status: 'accepted' },
      { ...matching, v: 2 }, { ...matching, run: 1111111111111111 }, null,
    ]) phone.sandbox.handleCommandResult(frame);
    assert.equal(phone.sandbox.pendingStop, pending, 'OBS-147: unrelated acknowledgement settled stop');
    assert.ok(phone.state.currentEnvelope);
    phone.sandbox.handleCommandResult(matching);
    assert.equal(phone.state.currentEnvelope, null);
    assert.equal(phone.messages.at(-1), 'أكّد الحاسوب انتهاء الدور الجاري.');
    assert.equal(phone.timers.size, 0);
  });

  await check('phone-old-ack-cannot-change-new-run', async () => {
    const phone = phoneRuntime();
    await phone.stopAgent();
    const matching = result(phone);
    phone.state.currentRun = RUN_B;
    phone.sandbox.latestState = { run: RUN_B };
    phone.state.currentEnvelope = { run: RUN_B };
    phone.messages.push('B');
    phone.sandbox.handleCommandResult(matching);
    assert.equal(phone.messages.at(-1), 'B');
    assert.equal(phone.state.currentEnvelope.run, RUN_B);
  });

  await check('phone-retry-rejects-old-command-same-run', async () => {
    const phone = phoneRuntime();
    await phone.stopAgent();
    const old = result(phone);
    await phone.stopAgent();
    assert.notEqual(old.command_id, phone.sandbox.pendingStop.command_id);
    phone.sandbox.handleCommandResult(old);
    assert.ok(phone.sandbox.pendingStop, 'OBS-147: old command acknowledgement settled retry');
    assert.ok(phone.state.currentEnvelope);
  });

  await check('phone-timeout-stale-and-unknown-stay-honest', async () => {
    for (const status of ['timeout', 'stale_run', 'unknown']) {
      const phone = phoneRuntime();
      await phone.stopAgent();
      if (status === 'timeout') for (const timer of [...phone.timers]) timer();
      else phone.sandbox.handleCommandResult(result(phone, status));
      assert.equal(phone.sandbox.pendingStop, null);
      assert.ok(phone.state.currentEnvelope, status + ': لم يتأكد انتهاء الدور');
      assert.ok(!phone.messages.at(-1).includes('أكّد الحاسوب'), status);
      assert.match(phone.messages.at(-1), /غير مؤكدة|تغيّر الدور|لم يتأكد/);
    }
  });


  await check('phone-lost-http-response-still-accepts-confirmation', async () => {
    const phone = phoneRuntime();
    phone.sandbox.fetch = async () => { throw Error('lost_response'); };
    await phone.stopAgent();
    assert.ok(phone.sandbox.pendingStop, 'OBS-147: lost HTTP response discarded pending stop');
    assert.match(phone.messages.at(-1), /بانتظار رد الحاسوب/);
    phone.sandbox.handleCommandResult(result(phone));
    assert.equal(phone.messages.at(-1), 'أكّد الحاسوب انتهاء الدور الجاري.');
  });

  await check('phone-late-http-cannot-overwrite-ack-or-B', async () => {
    for (const failed of [false, true]) {
      const phone = phoneRuntime(), http = deferred();
      phone.sandbox.fetch = () => http.promise;
      const sending = phone.stopAgent();
      await flush();
      const matching = result(phone);
      phone.sandbox.handleCommandResult(matching);
      if (failed) http.reject(Error('offline'));
      else http.resolve({ ok: true, status: 202, json: async () => ({}) });
      await sending;
      assert.equal(phone.messages.at(-1), 'أكّد الحاسوب انتهاء الدور الجاري.');
      const later = deferred();
      phone.sandbox.fetch = () => later.promise;
      const sendingA = phone.stopAgent();
      await flush();
      phone.state.currentRun = RUN_B;
      phone.messages.push('B');
      later.reject(Error('offline'));
      await sendingA;
      assert.equal(phone.messages.at(-1), 'B', 'OBS-147: late HTTP error changed B');
    }
  });

  await check('phone-poll-keeps-reading-until-command-result', async () => {
    const phone = phoneRuntime();
    await phone.stopAgent();
    const frames = [
      { type: 'permission_request', envelope: { envelope_id: 'permission-A', run: RUN_A } },
      result(phone),
    ];
    let polls = 0;
    Object.assign(phone.sandbox, {
      AbortController, AbortSignal,
      openFrame: async (raw) => raw.frame,
      persistRecvCounter: async () => {},
      renderCard: () => {},
      envelopeFromFrame: sourceFunction(read('pwa/app.js'), 'envelopeFromFrame', {}),
      setTimeout(callback) { callback(); return callback; },
      fetch: async () => {
        polls++;
        if (!frames.length) { phone.state.stopped = true; return { status: 204 }; }
        return { ok: true, status: 200, arrayBuffer: async () => ({ byteLength: 1, frame: frames.shift() }) };
      },
    });
    await sourceFunction(read('pwa/app.js'), 'pollLoop', phone.sandbox)();
    assert.equal(polls, 3, 'OBS-147: permission card prevented stop acknowledgement polling');
    assert.equal(phone.messages.at(-1), 'أكّد الحاسوب انتهاء الدور الجاري.',
      'OBS-147: polling overwrote stop result');
    assert.equal(phone.state.currentEnvelope, null);
  });

  await check('push-202-reports-only-subscription-sent', async () => {
    const phone = phoneRuntime();
    phone.state.vapidPublic = 'test';
    Object.assign(phone.sandbox.C, {
      base64urlToBytes: () => new Uint8Array(65), bytesToBase64url: () => 'test',
    });
    const nodes = new Map();
    Object.assign(phone.sandbox, {
      navigator: { serviceWorker: { ready: Promise.resolve({
        pushManager: { subscribe: async () => ({
          endpoint: 'https://push.invalid', getKey: (key) => new Uint8Array(key === 'auth' ? 16 : 65),
        }) },
      }) } },
      Notification: { requestPermission: async () => 'granted' },
      isPushSupported: () => true, setError: () => {}, showEl: () => {},
      $: (id) => {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', classList: { add() {}, remove() {} } });
        return nodes.get(id);
      },
      sessionRecord: () => ({}), dbPut: async () => {},
    });
    for (const name of ['abToU8', 'renderPushPanel', 'onPushEnable']) {
      phone.sandbox[name] = sourceFunction(read('pwa/app.js'), name, phone.sandbox);
    }
    await phone.sandbox.onPushEnable();
    assert.equal(phone.messages.at(-1), 'أُرسل اشتراك الإشعارات — لم يتأكد حفظه على الحاسوب.');
    assert.equal(nodes.get('pushStatus').textContent, 'اشتراك المتصفح جاهز؛ وصول الإشعارات غير مؤكّد.');
  });

  assert.equal(failures.length, 0, 'OBS-147: confirmation scenarios failed');
}

module.exports = { testMobileStopConfirmation, mainRuntime, phoneRuntime, flush, RUN_A, RUN_B };
if (require.main === module) {
  testMobileStopConfirmation().catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
