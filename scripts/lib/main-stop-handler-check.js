'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');

// نشغّل معالج IPC نفسه لقياس الإلغاء ونطاق الإيقاف وانتظار اكتماله، دون تثبيت صياغته.
async function checkMainStopHandler(source) {
  const start = source.indexOf("ipcMain.handle('satr:stop',");
  const end = source.indexOf('const SAFE_SDK_TOOL_USE_ID =', start);
  assert.ok(start >= 0 && end > start, 'main stop handler must exist');
  const calls = [];
  let handler, reserved = true, release;
  const stopping = new Promise(resolve => { release = resolve; });
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle(name, fn) { assert.equal(name, 'satr:stop'); handler = fn; } },
    savedTaskHost: { isReserved: () => reserved },
    cancelPendingSendRequest() { calls.push(['cancel']); },
    stopAll(...args) { calls.push(['stop', ...args]); return stopping; },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: false, error: 'task_busy' });
  assert.deepEqual(calls, [], 'reserved task must not be stopped');
  reserved = false;
  let settled = false;
  const result = handler().then(value => { settled = true; return value; });
  assert.deepEqual(calls, [['cancel'], ['stop', false, 'renderer_request']],
    'renderer stop must cancel pending send, preserve background runs and record its source');
  await Promise.resolve();
  assert.equal(settled, false, 'renderer stop must await cleanup');
  release();
  assert.deepEqual(JSON.parse(JSON.stringify(await result)), { ok: true });
}
// سباق الإنتاج نفسه: إنهاء الإيقاف أو بلوغ السقف يكفي لتحرير مسار الإرسال.
async function checkSendStopCap(source) {
  const handler = source.indexOf('async function handleSendRequest(');
  const boundary = source.indexOf('if (requestEpoch !== sendRequestEpoch)', handler);
  const start = source.lastIndexOf('await Promise.', boundary);
  const end = source.indexOf(']);', start);
  assert.ok(handler >= 0 && boundary > handler && start > handler && end > start && end < boundary, 'send stop race must exist');
  for (const winner of ['cap', 'stop']) {
    let releaseStop, releaseCap, settled = false;
    const calls = [];
    const stopping = new Promise(resolve => { releaseStop = resolve; });
    const pending = vm.runInNewContext('(async () => {' + source.slice(start, end + 3) + '})()', {
      stopAll(...args) { calls.push(args); return stopping; },
      STOP_ALL_SEND_TIMEOUT_MS: 517,
      setTimeout(fn, ms) { assert.equal(ms, 517, 'send stop timeout must use configured cap'); releaseCap = fn; return { unref() {} }; },
    }).then(() => { settled = true; });
    assert.deepEqual(calls, [[false, 'new_request']], 'new send must preserve background runs and record its stop source');
    await Promise.resolve();
    assert.equal(settled, false, 'send must wait for stop or cap');
    if (winner === 'cap') releaseCap(); else releaseStop();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(settled, true, 'send must continue when ' + winner + ' wins');
    await pending;
  }
}
module.exports = { checkMainStopHandler, checkSendStopCap };
