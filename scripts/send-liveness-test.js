#!/usr/bin/env node
'use strict';

// اختبار موثوقية الإرسال (إصلاح 2026-07-30 — قطعي، بلا شبكة):
// كان تعليق عملية app-server الحيّة غير المستجيبة يترك الدور في «يستعد» بلا نهاية،
// وتعليق turn/interrupt عند الإيقاف يحبس قفل sendRequestBusy في main.js إلى الأبد
// فترتد كل الرسائل بـ«انتظر اكتمال بدء الطلب السابق». يغطي هذا الاختبار:
//   1) إقلاع صامت ⇒ فشل صريح خلال مهلة الإقلاع (spawn_error + result خطأ + proc_done)
//      مع موت عملية الـfixture (لا يتيم).
//   2) إيقاف على قناة ميتة ⇒ handle.stop() يُحسم خلال مهلة المقاطعة لا أبدياً.
//   3) حرس نصية على حصون main.js (سقف stopAll ومهلة إقلاع SDK) — تختبر وجود العقد
//      لأن تشغيل main.js كاملاً خارج Electron غير عملي.
//   4) حدود reliabilityTimeout (قيمة بيئة غير صالحة تسقط للافتراضي — فحص نصي).

const assert = require('assert');
const fs = require('fs/promises');
const fssync = require('fs');
const os = require('os');
const path = require('path');

function silentFixture() {
  // app-server مزيف: يبقى حياً ويقرأ stdin ولا يرد على أي طلب إطلاقاً.
  return `'use strict';
process.stdin.resume();
process.stdin.on('data', () => {});
setInterval(() => {}, 1000);
`;
}

function deadAfterTurnFixture() {
  // يرد على initialize وthread/start وturn/start ثم يصمت كلياً (لا يرد على turn/interrupt).
  return `'use strict';
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    else if (msg.method === 'thread/start') {
      send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-dead-1' } } });
    } else if (msg.method === 'turn/start') {
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-dead-1' } } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-dead-1', turn: { id: 'turn-dead-1' } } });
    }
    // turn/interrupt وكل ما عداه: صمت متعمد — القناة «ميتة».
  }
});
setInterval(() => {}, 1000);
`;
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('wait timeout: ' + label);
}

function freshCodex() {
  delete require.cache[require.resolve('../electron/codex')];
  const codex = require('../electron/codex');
  codex.resolveCodexBin(true);
  return codex;
}

async function scenarioSilentBoot(root) {
  const project = path.join(root, 'silent');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'app-server'), silentFixture(), 'utf8');
  process.env.SATR_CODEX_BOOT_TIMEOUT_MS = '500';
  delete process.env.SATR_CODEX_INTERRUPT_TIMEOUT_MS;
  const codex = freshCodex();
  const events = [];
  const startedAt = Date.now();
  const handle = await codex.start({
    prompt: 'liveness', images: [], sessionId: null, model: 'gpt-5.6-sol',
    permissionMode: 'default', skills: [], extraDirs: [], browserControl: false,
  }, project, (obj) => events.push(obj));
  assert.ok(handle && typeof handle.stop === 'function', 'handle returned');
  const spawnErr = await waitFor(
    () => events.find((e) => e.type === 'spawn_error'), 8000, 'silent boot spawn_error');
  assert.ok(/rpc_timeout:initialize/.test(spawnErr.text || ''),
    'boot timeout names the stalled request');
  await waitFor(() => events.find((e) => e.type === 'result' && e.is_error), 8000, 'error result');
  await waitFor(() => events.find((e) => e.type === 'proc_done'), 8000, 'proc_done after boot timeout');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 8000, 'silent boot fails fast, took ' + elapsed + 'ms');
  console.log('✓ الإقلاع الصامت يفشل صريحاً خلال المهلة (' + elapsed + 'ms) بدل «يستعد» الأبدي');
}

async function scenarioDeadChannelStop(root) {
  const project = path.join(root, 'dead');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'app-server'), deadAfterTurnFixture(), 'utf8');
  process.env.SATR_CODEX_BOOT_TIMEOUT_MS = '5000';
  process.env.SATR_CODEX_INTERRUPT_TIMEOUT_MS = '400';
  const codex = freshCodex();
  const events = [];
  const handle = await codex.start({
    prompt: 'liveness-stop', images: [], sessionId: null, model: 'gpt-5.6-sol',
    permissionMode: 'default', skills: [], extraDirs: [], browserControl: false,
  }, project, (obj) => events.push(obj));
  await waitFor(() => events.find((e) => e.type === 'system' && e.subtype === 'init'), 8000, 'thread init');
  // الدور «جارٍ» الآن والقناة لن ترد على المقاطعة — الإيقاف يجب أن يُحسم لا أن يعلق.
  const stopStarted = Date.now();
  await handle.stop();
  const stopElapsed = Date.now() - stopStarted;
  assert.ok(stopElapsed < 4000, 'stop resolves despite dead channel, took ' + stopElapsed + 'ms');
  await waitFor(() => events.find((e) => e.type === 'proc_done'), 8000, 'proc_done after stop');
  console.log('✓ الإيقاف على قناة ميتة يُحسم خلال ' + stopElapsed + 'ms بدل حبس قفل الإرسال أبدياً');
}

function scenarioMainGuards() {
  const main = fssync.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('STOP_ALL_SEND_TIMEOUT_MS'), 'main defines stopAll send cap');
  assert.ok(main.includes('SDK_START_TIMEOUT_MS'), 'main defines sdk start cap');
  assert.ok(/Promise\.race\(\[\s*\n?\s*stopAll\(false\)/.test(main),
    'send path races stopAll against the cap');
  assert.ok(main.includes("reject(new Error('sdk_boot_timeout'))"), 'sdk start raced with timeout');
  assert.ok(main.includes('تأخر إقلاع محرك Claude'), 'sdk boot timeout has Arabic message');
  const codexSrc = fssync.readFileSync(path.join(__dirname, '..', 'electron', 'codex.js'), 'utf8');
  assert.ok(codexSrc.includes('BOOT_REQUEST_TIMEOUT_MS'), 'codex boot timeout constant');
  assert.ok(/raw >= 100 && raw <= 600000/.test(codexSrc), 'reliabilityTimeout bounds env override');
  assert.ok(codexSrc.includes("request('turn/interrupt', { threadId, turnId }, INTERRUPT_TIMEOUT_MS)"),
    'stop interrupt is bounded');
  console.log('✓ حصون main.js (سقف stopAll ومهلة إقلاع SDK) وحدود تجاوز البيئة موجودة نصياً');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satr-send-liveness-'));
  const prevBin = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = process.execPath;
    await scenarioSilentBoot(root);
    await scenarioDeadChannelStop(root);
    scenarioMainGuards();
    console.log('send-liveness-test: ok — مهلة الإقلاع، إيقاف القناة الميتة، حصون قفل الإرسال');
  } finally {
    if (prevBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prevBin;
    delete process.env.SATR_CODEX_BOOT_TIMEOUT_MS;
    delete process.env.SATR_CODEX_INTERRUPT_TIMEOUT_MS;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('send-liveness-test FAILED:', e && e.message); process.exit(1); });
