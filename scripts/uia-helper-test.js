#!/usr/bin/env node
'use strict';
/**
 * سطر — اختبار المعين الأصلي `native/satr-uia` (الصفّان ١ و٤ في docs/COMPUTER-USE-DESKTOP.md).
 *
 * يقيس على «المفكرة» فعلاً لا على محاكاة: يطلق المعين بانضباط codex.js (مهلة إقلاع، مهلة
 * لكل طلب، إغلاق stdin ثم إنهاء، ورفض أي ردّ لا يطابق الشكل) ويفحص:
 *   initialize (الزمن + packageFullName) · targets/list يجد المفكرة بـclassName ورقم ثابت عبر السرد ·
 *   لا لقطة ولا فعل قبل session/select، والاختيار يرفض مستطيلاً أو عمليةً لا تطابق النافذة ·
 *   tree/snapshot ≥3 عناصر مسمّاة بصيغة `[w2:e14] role "name"` · maxNodes يقصّ ويعلن · setValue يغيّر
 *   النص (قراءة ثانية من العنصر) · element/state · input/key أثره مقروء من المحرّر ثم من الملف على
 *   القرص بعد Ctrl+S، والمفاتيح الممنوعة مرفوضة بلا إرسال · input/scroll بـScrollPattern ·
 *   capture/window يعيد PNG صالحاً للنافذة المختارة وحدها · مرجع فاسد/قديم ⇒ stale_ref بلا فعل ·
 *   الاحتواء بالمستطيل داخل المعين بعد تكبير النافذة ⇒ not_allowed بلا فعل · البصمة ⇒ target_changed
 *   (زرّ WinForms يغيّر اسمه عند نقره) · حقل السرّ غائب عن اللقطة · قتل النافذة ⇒ closed، وإعادة فتحها
 *   تعطيها رقماً جديداً · ردّ غير مطابق يُرفض · shutdown وإغلاق stdin ينهيان العملية بلا أيتام ·
 *   وإن كان الثنائي AOT: الحجم < 8 م.ب والإقلاع < 800 م.ث.
 *
 * الثنائي: `SATR_UIA_EXE` ⇐ `native/satr-uia/out/satr-uia.exe` ⇐ يُبنى بـ`dotnet build` إن غاب.
 * `SATR_UIA_EXPECT_AOT=1` (في CI) يجعل غياب AOT سقوطاً لا تخطّياً لفحصَي الحجم والإقلاع.
 * `SATR_UIA_METRICS_FILE` يكتب الأرقام JSON لخطوة CI التي تطبعها.
 *
 * ⚠️ حدّ مُصرَّح به: ويندوز وحده (UI Automation)؛ على POSIX يتخطّى بإعلان، ومُدرَج في
 * SKIP_ON_POSIX بـfull-suite.js. ويحتاج سطح مكتب تفاعلياً تُفتح فيه نافذة وتُجلب إلى الأمام —
 * الاختبار يسرق التركيز لحظة input/key.
 */

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'native', 'satr-uia');
const DEFAULT_EXE = path.join(PROJECT, 'out', 'satr-uia.exe');
const BOOT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 8000;
const CAPTURE_TIMEOUT_MS = 15000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const MAX_AOT_BYTES = 8 * 1024 * 1024;
const MAX_BOOT_MS = 800;
const MAX_CAPTURE_SIDE = 1568;
const MIN_NAMED = 3;
const SNAPSHOT_LINE = /^\[w[1-9][0-9]*:e[1-9][0-9]*\] [a-z]+ ".*"$/s;
const REF_RE = /^w[1-9][0-9]*:e[1-9][0-9]*$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// شكل الردّ الملزم `{id, result|error, ms}` — نسخة واحدة يستهلكها electron/desktop.js في الإنتاج
// وهذا الاختبار معاً؛ نسختان كانتا ستتباعدان بصمت فيرفض أحدهما ما يقبله الآخر.
const { validateResponse } = require('../electron/desktop');

/** عميل أسطر JSON على stdio — نمط request في codex.js مع رفض الشكل غير المطابق. */
function startHelper(command, args = []) {
  const child = cp.spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const rejected = [];
  let nextId = 1;
  let buf = '';
  let stderrTail = '';
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { rejected.push('not_json'); continue; }
      const entry = msg && pending.get(msg.id);
      if (!entry) { rejected.push('unknown_id'); continue; }
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      const problem = validateResponse(msg);
      if (problem) { rejected.push('bad_shape'); entry.reject(new Error('bad_response: ' + problem)); continue; }
      entry.resolve(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  child.on('exit', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('exited')); }
    pending.clear();
  });

  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout:' + method)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
  }

  async function close() {
    try { child.stdin.end(); } catch { /* مغلق أصلاً */ }
    const done = await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => null)]);
    if (!done) { try { child.kill(); } catch { /* */ } return exited; }
    return done;
  }

  return { child, request, close, exited, rejected, stderr: () => stderrTail };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function killPid(pid) {
  if (!pid) return;
  try { cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* */ }
}

function formatLine(n) { return `[${n.ref}] ${n.role} "${n.name}"`; }
const errorCode = (r) => (r && r.error ? r.error.code : 'ok');
const shown = (r) => JSON.stringify(r && (r.error || r.result));

function resolveExe() {
  if (process.env.SATR_UIA_EXE) {
    ok(fs.existsSync(process.env.SATR_UIA_EXE), 'SATR_UIA_EXE يشير إلى ملف غير موجود: ' + process.env.SATR_UIA_EXE);
    return process.env.SATR_UIA_EXE;
  }
  if (!fs.existsSync(DEFAULT_EXE)) {
    console.log('uia-helper-test: الثنائي غائب — يُبنى بـdotnet build …');
    const r = cp.spawnSync('dotnet', ['build', PROJECT, '-c', 'Release', '-o', path.join(PROJECT, 'out'), '-nologo'],
      { stdio: 'inherit', windowsHide: true });
    ok(r.status === 0, 'dotnet build فشل (هل .NET SDK 10 مثبّت؟) — رمز ' + r.status);
  }
  return DEFAULT_EXE;
}

// ── الفحص الأول: رفض الردّ غير المطابق — بمعين مزيّف يكذب في الشكل عمداً ──
async function checkShapeRejection() {
  const fake = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
rl.on('line', (line) => {
  const { id } = JSON.parse(line);
  if (id === 1) { out('not json at all'); out({ id: 99, result: {}, ms: 0 }); out({ id: 1, ms: 'x', result: {} }); }
  if (id === 2) out({ id: 2, result: {}, error: { code: 'x', message: 'y' }, ms: 1 });
  if (id === 3) out({ id: 3, error: { code: 7 }, ms: 1 });
  if (id === 4) out({ id: 4, result: { ok: true }, ms: 1 });
});`;
  const h = startHelper(process.execPath, ['-e', fake]);
  const outcome = async (p) => p.then(() => 'resolved', (e) => String(e.message));
  const r1 = await outcome(h.request('initialize', {}, 3000));
  const r2 = await outcome(h.request('initialize', {}, 3000));
  const r3 = await outcome(h.request('initialize', {}, 3000));
  const r4 = await outcome(h.request('initialize', {}, 3000));
  await h.close();
  ok(r1.startsWith('bad_response'), 'ردّ ms غير عددي يُرفض (الواقع: ' + r1 + ')');
  ok(r2.startsWith('bad_response'), 'ردّ يجمع result وerror يُرفض (الواقع: ' + r2 + ')');
  ok(r3.startsWith('bad_response'), 'خطأ بلا code نصّي يُرفض (الواقع: ' + r3 + ')');
  ok(r4 === 'resolved', 'الردّ المطابق بعد الكاذبة يُسلَّم (الواقع: ' + r4 + ')');
  ok(h.rejected.includes('not_json') && h.rejected.includes('unknown_id'),
    'السطر غير JSON والمعرّف المجهول يُهملان ولا يُسلَّمان: ' + h.rejected.join(','));
  console.log('  ✓ رفض الردّ غير المطابق: ' + h.rejected.join(' · '));
}

async function listTargets(h) {
  const tl = await h.request('targets/list');
  ok(!tl.error, 'targets/list أعاد خطأ: ' + JSON.stringify(tl.error));
  return tl;
}

async function waitForTarget(h, match, label) {
  for (let i = 0; i < 40; i++) {
    const tl = await listTargets(h);
    const hit = tl.result.find(match);
    if (hit) return { target: hit, list: tl };
    await sleep(250);
  }
  throw new Error('لم تظهر نافذة ' + label + ' في targets/list خلال 10ث');
}

// النافذة المفتوحة للتوّ قد تستقرّ موضعاً بعد ظهورها: الاختيار يطابق المستطيل حرفياً، فيُنتظر ثباته
async function settledTarget(h, targetId) {
  let last = null;
  for (let i = 0; i < 20; i++) {
    const tl = await listTargets(h);
    const t = tl.result.find((x) => x.targetId === targetId);
    ok(t, 'الهدف ' + targetId + ' غاب عن السرد قبل الاختيار');
    if (last && JSON.stringify(last.rect) === JSON.stringify(t.rect) && t.rect) return t;
    last = t;
    await sleep(150);
  }
  return last;
}

async function select(h, t) {
  const r = await h.request('session/select', { targetId: t.targetId, pid: t.pid, rect: t.rect });
  ok(!r.error && r.result.ok === true && r.result.targetId === t.targetId,
    'session/select على ' + t.targetId + ' أعاد: ' + shown(r));
  return r;
}

async function snapshot(h, targetId, maxNodes = 400) {
  const snap = await h.request('tree/snapshot', { targetId, maxDepth: 12, maxNodes });
  ok(!snap.error, 'tree/snapshot أعاد خطأ: ' + JSON.stringify(snap.error));
  return snap;
}

const editorOf = (nodes) => nodes.find((n) => n.role === 'edit' || n.role === 'document');

async function main() {
  if (process.platform !== 'win32') {
    console.log('uia-helper-test: تخطٍّ معلَن — UI Automation ويندوز وحده (مُدرَج في SKIP_ON_POSIX).');
    return;
  }
  const metrics = {};
  await checkShapeRejection();

  const exe = resolveExe();
  const sizeBytes = fs.statSync(exe).size;
  metrics.exe = exe;
  metrics.sizeBytes = sizeBytes;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-uia-'));
  const docName = 'satr-uia-' + process.pid + '.txt';
  const docPath = path.join(workDir, docName);
  fs.writeFileSync(docPath, 'ORIGINAL_TEXT', 'utf8');

  const spawned = [];
  let h = null;
  try {
    // ── الإقلاع ──
    const t0 = Date.now();
    h = startHelper(exe);
    const init = await h.request('initialize', {}, BOOT_TIMEOUT_MS);
    const bootMs = Date.now() - t0;
    metrics.bootMs = bootMs;
    ok(!init.error, 'initialize أعاد خطأ: ' + JSON.stringify(init.error));
    ok(init.result.uiaAvailable === true, 'uiaAvailable ليس true');
    ok(Object.prototype.hasOwnProperty.call(init.result, 'packageFullName'),
      'initialize بلا حقل packageFullName — الحقل الذي كشف النجاح الكاذب في القياس (OBS-154)');
    ok(init.result.packageFullName === null, 'packageFullName خارج الحزمة يجب أن يكون null (الواقع: ' + init.result.packageFullName + ')');
    // «ملف واحد» يُحكم من القرص لا من المعين: بناء JIT يضع satr-uia.dll بجوار مشغّله الصغير.
    // (حقل من المعين نفسه كان سيكذب — RuntimeFeature يعيد false في بناء JIT مع PublishAot.)
    const singleFile = !fs.existsSync(path.join(path.dirname(exe), 'satr-uia.dll'));
    metrics.singleFile = singleFile;
    metrics.version = init.result.version;
    console.log(`  ✓ initialize: ${bootMs} م.ث · ملف واحد=${singleFile} · الحجم ${sizeBytes} بايت (${(sizeBytes / 1048576).toFixed(2)} م.ب) · packageFullName=null`);
    if (process.env.SATR_UIA_EXPECT_AOT === '1') ok(singleFile, 'SATR_UIA_EXPECT_AOT=1 وبجوار الثنائي satr-uia.dll — ليس ناتج نشر');
    if (singleFile) {
      ok(sizeBytes < MAX_AOT_BYTES, `حجم الملف الواحد ${sizeBytes} بايت ≥ 8 م.ب`);
      ok(bootMs < MAX_BOOT_MS, `إقلاع الملف الواحد ${bootMs} م.ث ≥ ${MAX_BOOT_MS}`);
    } else {
      console.log('  · بناء JIT (‏dotnet build، مشغّل + dll): فحصا الحجم والإقلاع يخصّان ناتج النشر ويعملان في CI');
    }

    // ── المفكرة: السرد، className، وثبات الرقم ──
    const notepad = cp.spawn('notepad.exe', [docPath], { stdio: 'ignore', windowsHide: false });
    spawned.push(notepad.pid);
    const { target: found, list } = await waitForTarget(h,
      (t) => /^notepad$/i.test(t.processName) && (t.pid === notepad.pid || String(t.title).includes(docName)), 'المفكرة');
    if (found.pid !== notepad.pid) spawned.push(found.pid);
    ok(list.result.every((t) => /^w[1-9][0-9]*$/.test(t.targetId) && Number.isInteger(t.pid)), 'كل هدف targetId بصيغة w<n> وpid عدد');
    ok(list.result.every((t) => typeof t.className === 'string'), 'كل هدف يحمل className نصّاً');
    ok(found.className === 'Notepad', 'صنف نافذة المفكرة Notepad (الواقع: ' + JSON.stringify(found.className) + ')');
    const np = await settledTarget(h, found.targetId);
    ok(np.targetId === found.targetId, 'سرد ثانٍ أعاد ترقيم المفكرة: ' + found.targetId + ' ⇒ ' + np.targetId);
    console.log(`  ✓ targets/list: ${list.result.length} نافذة، المفكرة ${np.targetId} «${np.title}» صنف ${np.className}، والرقم ثابت عبر السرد`);

    // ── الجلسة: لا لقطة ولا فعل قبل session/select، والاختيار يطابق النافذة حرفياً ──
    ok(errorCode(await h.request('tree/snapshot', { targetId: np.targetId })) === 'not_allowed', 'لقطة قبل session/select يجب أن تُرفض not_allowed');
    ok(errorCode(await h.request('element/invoke', { ref: np.targetId + ':e1' })) === 'not_allowed', 'فعل قبل session/select يجب أن يُرفض not_allowed');
    ok(errorCode(await h.request('input/key', { keys: 'Enter' })) === 'not_allowed', 'مفاتيح قبل session/select تُرفض not_allowed');
    ok(errorCode(await h.request('capture/window', { targetId: np.targetId })) === 'not_allowed', 'التقاط قبل session/select يُرفض not_allowed');
    const wider = Object.assign({}, np.rect, { w: np.rect.w + 200 });
    ok(errorCode(await h.request('session/select', { targetId: np.targetId, pid: np.pid, rect: wider })) === 'not_allowed',
      'مستطيل أوسع من النافذة الحيّة يُرفض not_allowed');
    ok(errorCode(await h.request('session/select', { targetId: np.targetId, pid: np.pid + 1, rect: np.rect })) === 'not_allowed',
      'عملية لا تطابق النافذة تُرفض not_allowed');
    ok(errorCode(await h.request('session/select', { targetId: 'w999999', pid: np.pid, rect: np.rect })) === 'not_found',
      'هدف مجهول ⇒ not_found');
    ok(errorCode(await h.request('session/select', { targetId: np.targetId, pid: np.pid })) === 'bad_request', 'اختيار بلا rect ⇒ bad_request');
    await select(h, np);
    const other = list.result.find((t) => t.targetId !== np.targetId);
    if (other) {
      ok(errorCode(await h.request('tree/snapshot', { targetId: other.targetId })) === 'not_allowed', 'لقطة نافذة غير مختارة ⇒ not_allowed');
      ok(errorCode(await h.request('element/invoke', { ref: other.targetId + ':e1' })) === 'not_allowed', 'مرجع نافذة غير مختارة ⇒ not_allowed');
      ok(errorCode(await h.request('capture/window', { targetId: other.targetId })) === 'not_allowed', 'التقاط نافذة غير مختارة ⇒ not_allowed');
    }
    console.log('  ✓ session/select: الرفض قبل الاختيار (أربعة توابع) · مستطيل أوسع · عملية أخرى · هدف مجهول · نافذة غير مختارة');

    let snap = await snapshot(h, np.targetId);
    let nodes = snap.result.nodes;
    const named = nodes.filter((n) => typeof n.name === 'string' && n.name.trim());
    ok(named.length >= MIN_NAMED, `عناصر مسمّاة ${named.length} < ${MIN_NAMED}`);
    ok(nodes.every((n) => REF_RE.test(n.ref) && n.ref.startsWith(np.targetId + ':')), 'كل مرجع بصيغة w<n>:e<m> ومن هدفه');
    ok(new Set(nodes.map((n) => n.ref)).size === nodes.length, 'المراجع بلا تكرار');
    ok(nodes.every((n) => SNAPSHOT_LINE.test(formatLine(n))), 'كل عقدة تُصاغ بالسطر الحرفي [w2:e14] role "name"');
    ok(nodes.every((n) => ['ref', 'role', 'name', 'rect', 'enabled', 'focusable', 'isPassword'].every((k) => k in n)),
      'كل عقدة تحمل الحقول السبعة');
    ok(nodes.every((n) => n.isPassword === false), 'لا عقدة isPassword في اللقطة');
    ok(snap.result.truncated === false, 'لقطة المفكرة الكاملة لا تُقصّ عند 400');
    console.log(`  ✓ tree/snapshot: ${nodes.length} عقدة، ${named.length} مسمّاة (${snap.ms} م.ث) — ${named.slice(0, 3).map(formatLine).join(' · ')}`);
    metrics.snapshotMs = snap.ms;
    metrics.named = named.length;

    const editor = editorOf(nodes);
    ok(editor, 'لا محرّر (edit/document) في شجرة المفكرة');
    const last = nodes[nodes.length - 1];

    // ── maxNodes يقصّ ويعلن، ويُبطل مراجع اللقطة الأطول ──
    // maxNodes=1 تُبقي النافذة وحدها (e1)، فمرجع المحرّر من اللقطة السابقة لا يُعاد إنتاجه.
    // (بـ2 كان المحرّر e2 نفسه يُعاد إنتاجه — مقيس — فيُحلّ صحيحاً ولا يصلح شاهداً على القِدم.)
    const small = await snapshot(h, np.targetId, 1);
    ok(small.result.nodes.length === 1 && small.result.truncated === true, 'maxNodes=1 يعيد عقدة واحدة ويعلن truncated');
    ok(editor.ref !== small.result.nodes[0].ref && Number(last.ref.split(':e')[1]) > 1,
      'مرجع المحرّر خارج اللقطة المقصوصة (شرط فحص المرجع القديم)');
    console.log('  ✓ maxNodes=1: عقدة واحدة و truncated=true');

    // ── stale_ref بلا فعل: مرجع من لقطة سابقة ومراجع فاسدة ──
    const staleSet = await h.request('element/setValue', { ref: editor.ref, text: 'MUST_NOT_LAND' });
    ok(errorCode(staleSet) === 'stale_ref', 'مرجع من لقطة سابقة يجب أن يعيد stale_ref (الواقع: ' + shown(staleSet) + ')');
    for (const bad of ['w0:e1', 'w1:e0', 'w01:e1', 'x', 'w1:e1 ', np.targetId + ':e999999', '', 42]) {
      const r = await h.request('element/invoke', { ref: bad });
      ok(errorCode(r) === 'stale_ref', `المرجع ${JSON.stringify(bad)} يجب أن يعيد stale_ref (الواقع: ${shown(r)})`);
    }
    console.log('  ✓ stale_ref: مرجع قديم وثمانية مراجع فاسدة');

    // ── setValue: يغيّر النص فعلاً، والقيمة السابقة تثبت أن الفعل المرفوض لم يقع ──
    snap = await snapshot(h, np.targetId);
    nodes = snap.result.nodes;
    let ed = nodes.find((n) => n.role === editor.role && n.name === editor.name) || editorOf(nodes);
    const newText = 'سطر satr-uia ' + process.pid;
    const set = await h.request('element/setValue', { ref: ed.ref, text: newText });
    ok(!set.error, 'element/setValue على المحرّر أعاد خطأ: ' + JSON.stringify(set.error));
    ok(set.result.previous === 'ORIGINAL_TEXT',
      'القيمة قبل الكتابة يجب أن تكون نص الملف — أي أن stale_ref لم يكتب شيئاً (الواقع: ' + JSON.stringify(set.result.previous) + ')');
    ok(set.result.value === newText, 'القراءة الثانية من العنصر لا تطابق النص المكتوب (الواقع: ' + JSON.stringify(set.result.value) + ')');
    console.log(`  ✓ setValue: «${set.result.previous}» ⇒ «${set.result.value}» (${set.ms} م.ث)`);
    const setMissing = await h.request('element/setValue', { ref: ed.ref });
    ok(errorCode(setMissing) === 'bad_request', 'setValue بلا text ⇒ bad_request');
    const notInvokable = await h.request('element/invoke', { ref: ed.ref });
    ok(errorCode(notInvokable) === 'unsupported_pattern',
      'invoke على محرّر بلا InvokePattern ⇒ unsupported_pattern (الواقع: ' + shown(notInvokable) + ')');

    // ── element/state: قراءة بلا مشي — المرجع يبقى صالحاً بعدها ──
    const state = await h.request('element/state', { ref: ed.ref });
    ok(!state.error && state.result.role === ed.role && state.result.enabled === true && state.result.inside === true,
      'element/state للمحرّر: ' + shown(state));
    console.log(`  ✓ element/state: ${state.result.role} enabled=${state.result.enabled} inside=${state.result.inside}`);

    // ── input/key: الأثر يُقرأ من المحرّر نفسه، ثم Ctrl+S يكتب الملف على القرص ──
    const keyT0 = Date.now();
    const toEnd = await h.request('input/key', { keys: 'ctrl+end' });
    ok(!toEnd.error && toEnd.result.keys === 'Ctrl+End', 'input/key Ctrl+End أعاد: ' + shown(toEnd));
    metrics.keyMs = Date.now() - keyT0;
    const back = await h.request('input/key', { keys: 'Backspace' });
    ok(!back.error, 'input/key Backspace أعاد: ' + shown(back));
    await sleep(300);
    const saveText = 'SAVED_BY_KEYS_' + process.pid;
    const probe = await h.request('element/setValue', { ref: ed.ref, text: saveText });
    ok(!probe.error && probe.result.previous === newText.slice(0, -1),
      'Backspace بعد Ctrl+End كان يجب أن يحذف آخر محرف (الواقع: ' + shown(probe) + ')');
    const save = await h.request('input/key', { keys: 'Ctrl+S' });
    ok(!save.error, 'input/key Ctrl+S أعاد: ' + shown(save));
    let onDisk = '';
    for (let i = 0; i < 40 && onDisk !== saveText; i++) {
      await sleep(150);
      onDisk = fs.readFileSync(docPath, 'utf8').replace(/^\uFEFF/, '');
    }
    ok(onDisk === saveText, 'Ctrl+S لم يكتب الملف على القرص (الواقع: ' + JSON.stringify(onDisk.slice(0, 80)) + ')');
    console.log(`  ✓ input/key: Ctrl+End ثم Backspace حذف «${newText.slice(-1)}» · Ctrl+S كتب «${onDisk}» على القرص (${metrics.keyMs} م.ث للأول)`);
    for (const [keys, code] of [
      ['Alt+Tab', 'not_allowed'], ['Alt+Escape', 'not_allowed'], ['Ctrl+Escape', 'not_allowed'],
      ['Ctrl+Shift+Escape', 'not_allowed'], ['Alt+Space', 'not_allowed'], ['Ctrl+Alt+Delete', 'not_allowed'],
      ['Win+R', 'bad_key'], ['F1', 'bad_key'], ['Foo', 'bad_key'], ['', 'bad_key'], ['Ctrl+Ctrl+S', 'bad_key'], ['Ctrl', 'bad_key'],
    ]) {
      const r = await h.request('input/key', { keys });
      ok(errorCode(r) === code, `المفاتيح ${JSON.stringify(keys)} يجب أن تُرفض ${code} (الواقع: ${shown(r)})`);
    }
    console.log('  ✓ input/key: ستّ تركيبات تغادر النافذة ⇒ not_allowed وستّة أسماء خارج القائمة ⇒ bad_key');

    // ── input/scroll: نصّ من 300 سطر يجعل المحرّر قابلاً للتمرير ──
    const many = Array.from({ length: 300 }, (_, i) => 'line ' + (i + 1)).join('\r\n');
    ok(!(await h.request('element/setValue', { ref: ed.ref, text: many })).error, 'setValue للنص الطويل');
    const scrolled = await h.request('input/scroll', { ref: ed.ref, dy: 5 });
    ok(!scrolled.error, 'input/scroll أعاد: ' + shown(scrolled));
    metrics.scrollVia = scrolled.result.via;
    ok(scrolled.result.via === 'pattern' && scrolled.result.after > scrolled.result.before,
      'التمرير بـScrollPattern يجب أن يزيد النسبة (الواقع: ' + shown(scrolled) + ')');
    ok(errorCode(await h.request('input/scroll', { ref: ed.ref, dy: 0 })) === 'bad_request', 'dy=0 ⇒ bad_request');
    ok(errorCode(await h.request('input/scroll', { ref: ed.ref, dy: 51 })) === 'bad_request', 'dy=51 ⇒ bad_request');
    console.log(`  ✓ input/scroll: via=${scrolled.result.via} ${scrolled.result.before}% ⇒ ${scrolled.result.after}%`);

    // ── capture/window: PNG صالح للنافذة المختارة وحدها ──
    const cap = await h.request('capture/window', { targetId: np.targetId }, CAPTURE_TIMEOUT_MS);
    ok(!cap.error, 'capture/window أعاد: ' + JSON.stringify(cap.error));
    const png = Buffer.from(cap.result.png, 'base64');
    ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'الالتقاط ليس PNG (التوقيع)');
    ok(png.readUInt32BE(16) === cap.result.width && png.readUInt32BE(20) === cap.result.height, 'أبعاد IHDR لا تطابق الردّ');
    ok(cap.result.width > 0 && Math.max(cap.result.width, cap.result.height) <= MAX_CAPTURE_SIDE, 'الضلع الأطول فوق ' + MAX_CAPTURE_SIDE);
    ok(png.readUInt8(25) === 2, 'PNG يجب أن يكون RGB بلا شفافية (نوع اللون 2)');
    metrics.captureMs = cap.ms;
    metrics.captureBytes = png.length;
    console.log(`  ✓ capture/window: ${cap.result.width}×${cap.result.height} من ${cap.result.sourceWidth}×${cap.result.sourceHeight} · ${png.length} بايت PNG (${cap.ms} م.ث)`);

    // ── invoke: زر في شريط العنوان (الأوسط = تكبير/استعادة) يغيّر مستطيل النافذة ──
    snap = await snapshot(h, np.targetId);
    nodes = snap.result.nodes;
    const titleBarIndex = nodes.findIndex((n) => n.role === 'titlebar');
    ok(titleBarIndex >= 0, 'لا titlebar في شجرة المفكرة');
    const tbDepth = nodes[titleBarIndex].depth;
    const tbButtons = [];
    for (let i = titleBarIndex + 1; i < nodes.length && nodes[i].depth > tbDepth; i++) {
      if (nodes[i].depth === tbDepth + 1 && nodes[i].role === 'button') tbButtons.push(nodes[i]);
    }
    ok(tbButtons.length >= 3, 'شريط العنوان بلا أزرار ثلاثة: ' + tbButtons.map(formatLine).join(' · '));
    const toggle = tbButtons[tbButtons.length - 2];
    const rectBefore = JSON.stringify(nodes[0].rect);
    const inv = await h.request('element/invoke', { ref: toggle.ref });
    ok(!inv.error, `element/invoke على ${formatLine(toggle)} أعاد خطأ: ` + JSON.stringify(inv.error));
    let rectAfter = rectBefore;
    for (let i = 0; i < 20 && rectAfter === rectBefore; i++) {
      await sleep(150);
      rectAfter = JSON.stringify((await snapshot(h, np.targetId, 1)).result.nodes[0].rect);
    }
    ok(rectAfter !== rectBefore, `invoke لم يغيّر مستطيل النافذة (${rectBefore})`);
    console.log(`  ✓ invoke ${formatLine(toggle)}: ${rectBefore} ⇒ ${rectAfter}`);

    // ── الحارس ٢ داخل المعين: بعد التكبير صار المحرّر خارج مستطيل الجلسة (مستطيل ما قبله) ──
    await sleep(300);
    const grown = editorOf((await snapshot(h, np.targetId)).result.nodes);
    const outside = await h.request('element/setValue', { ref: grown.ref, text: 'MUST_NOT_LAND_OUTSIDE' });
    ok(errorCode(outside) === 'not_allowed', 'فعل على عنصر خارج مستطيل الجلسة يجب أن يُرفض not_allowed (الواقع: ' + shown(outside) + ')');
    const outsideScroll = await h.request('input/scroll', { ref: grown.ref, dy: 1 });
    ok(errorCode(outsideScroll) === 'not_allowed', 'تمرير خارج مستطيل الجلسة ⇒ not_allowed (الواقع: ' + shown(outsideScroll) + ')');
    // الدليل أن الرفض لم يكتب: اختيار جديد بمستطيل التكبير (الرقم نفسه — ثابت) ثم قراءة القيمة
    const grownTarget = await settledTarget(h, np.targetId);
    ok(grownTarget.targetId === np.targetId && JSON.stringify(grownTarget.rect) !== rectBefore,
      'السرد بعد التكبير يعيد الرقم نفسه بمستطيل جديد');
    await select(h, grownTarget);
    const edAfter = editorOf((await snapshot(h, np.targetId)).result.nodes);
    const readBack = await h.request('element/setValue', { ref: edAfter.ref, text: 'after-select' });
    ok(!readBack.error && readBack.result.previous !== 'MUST_NOT_LAND_OUTSIDE' && readBack.result.previous.startsWith('line 1'),
      'الفعل المرفوض خارج المستطيل كتب في المحرّر (القيمة: ' + JSON.stringify(String(readBack.result && readBack.result.previous).slice(0, 40)) + ')');
    console.log('  ✓ الاحتواء في المعين: setValue وscroll خارج مستطيل الجلسة ⇒ not_allowed بلا كتابة');

    // ── closed: قتل النافذة المختارة، ثم إعادة فتحها تعطيها رقماً جديداً ──
    const oldId = np.targetId;
    killPid(np.pid);
    let closedCode = '';
    for (let i = 0; i < 20 && closedCode !== 'closed'; i++) {
      await sleep(150);
      closedCode = errorCode(await h.request('element/setValue', { ref: edAfter.ref, text: 'x' }));
    }
    ok(closedCode === 'closed', 'فعل بعد إغلاق النافذة المختارة يجب أن يعيد closed (الواقع: ' + closedCode + ')');
    ok(errorCode(await h.request('tree/snapshot', { targetId: oldId })) === 'closed', 'لقطة نافذة مغلقة ⇒ closed');
    const reopened = cp.spawn('notepad.exe', [docPath], { stdio: 'ignore', windowsHide: false });
    spawned.push(reopened.pid);
    const { target: np2 } = await waitForTarget(h, (t) => /^notepad$/i.test(t.processName) && t.pid === reopened.pid, 'المفكرة المعاد فتحها');
    ok(np2.targetId !== oldId, 'النافذة المعاد فتحها أخذت رقم المغلقة ' + oldId + ' — الرقم يُعاد استعماله');
    console.log(`  ✓ closed بعد القتل، والمعاد فتحها ${np2.targetId} لا ${oldId}`);

    // ── حقل السرّ غائب، والبصمة: زرّ يغيّر اسمه عند نقره ⇒ target_changed ──
    const formTitle = 'satr-uia-pw-' + process.pid;
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$f = New-Object Windows.Forms.Form; $f.Text = \'' + formTitle + '\';',
      '$u = New-Object Windows.Forms.TextBox; $u.Text = \'visible-user\'; $u.Top = 10;',
      '$p = New-Object Windows.Forms.TextBox; $p.UseSystemPasswordChar = $true; $p.Text = \'hunter2-secret\'; $p.Top = 40;',
      '$b = New-Object Windows.Forms.Button; $b.Text = \'press-me\'; $b.Top = 70; $b.Add_Click({ $this.Text = \'pressed\' });',
      '$f.Controls.Add($u); $f.Controls.Add($p); $f.Controls.Add($b); [Windows.Forms.Application]::Run($f)',
    ].join(' ');
    const form = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    spawned.push(form.pid);
    const { target: formFound } = await waitForTarget(h, (t) => t.title === formTitle, 'نموذج كلمة المرور');
    const ft = await settledTarget(h, formFound.targetId);
    await select(h, ft);
    const pw = await snapshot(h, ft.targetId);
    const edits = pw.result.nodes.filter((n) => n.role === 'edit');
    ok(edits.length === 1, `النموذج فيه حقلان والمتوقّع حقل واحد في اللقطة (الواقع: ${edits.length}) — حقل السرّ دخل اللقطة`);
    ok(pw.result.nodes.every((n) => n.isPassword === false), 'عقدة isPassword=true في اللقطة');
    ok(!JSON.stringify(pw.result).includes('hunter2'), 'نص كلمة المرور ظهر في اللقطة');
    console.log(`  ✓ حقل السرّ غائب: ${pw.result.nodes.length} عقدة، حقل تحرير واحد من اثنين`);
    const button = pw.result.nodes.find((n) => n.role === 'button' && n.name === 'press-me');
    ok(button, 'زرّ press-me غائب عن لقطة النموذج');
    const firstPress = await h.request('element/invoke', { ref: button.ref });
    ok(!firstPress.error, 'النقرة الأولى على الزرّ أعادت: ' + shown(firstPress));
    let changed = null;
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      changed = await h.request('element/invoke', { ref: button.ref });
      if (errorCode(changed) === 'target_changed') break;
    }
    ok(errorCode(changed) === 'target_changed', 'الزرّ غيّر اسمه فالنقرة الثانية بالمرجع نفسه يجب أن تعيد target_changed (الواقع: ' + shown(changed) + ')');
    ok(changed.error.was === 'button "press-me"' && changed.error.now === 'button "pressed"',
      'target_changed يحمل was/now الوصفيين (الواقع: ' + shown(changed) + ')');
    console.log(`  ✓ target_changed: كان ${changed.error.was} وصار ${changed.error.now} — بلا نقرة ثانية`);

    // ── shutdown: ردّ ثم خروج بلا أيتام ──
    const pid = h.child.pid;
    const sd = await h.request('shutdown', {}, SHUTDOWN_TIMEOUT_MS);
    ok(!sd.error && sd.result.ok === true, 'shutdown بلا {ok:true}');
    const ex = await Promise.race([h.exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => null)]);
    ok(ex && ex.code === 0, 'المعين لم يخرج بـ0 خلال ' + SHUTDOWN_TIMEOUT_MS + ' م.ث بعد shutdown: ' + JSON.stringify(ex));
    ok(!isAlive(pid), 'عملية المعين ما زالت حيّة بعد shutdown');
    h = null;

    // إغلاق stdin وحده (بلا shutdown) ينهي أيضاً — المسار الذي يسلكه الإنهاء اللطيف
    const h2 = startHelper(exe);
    await h2.request('initialize', {}, BOOT_TIMEOUT_MS);
    const pid2 = h2.child.pid;
    try { h2.child.stdin.end(); } catch { /* */ }
    const ex2 = await Promise.race([h2.exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => null)]);
    if (!ex2) killPid(pid2);
    ok(ex2 && ex2.code === 0, 'إغلاق stdin لم ينهِ المعين بـ0: ' + JSON.stringify(ex2));
    ok(!isAlive(pid2), 'عملية المعين الثانية ما زالت حيّة بعد إغلاق stdin');
    console.log('  ✓ shutdown وإغلاق stdin: خروج 0 بلا أيتام');
  } finally {
    if (h) await h.close();
    for (const pid of spawned) killPid(pid);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
  }

  if (process.env.SATR_UIA_METRICS_FILE) fs.writeFileSync(process.env.SATR_UIA_METRICS_FILE, JSON.stringify(metrics, null, 2));
  console.log(`uia-helper-test: ok — ${checks} فحصاً · الحجم ${metrics.sizeBytes} بايت · الإقلاع ${metrics.bootMs} م.ث · ملف واحد=${metrics.singleFile}`);
}

module.exports = { validateResponse };

if (require.main === module) {
  main().catch((e) => {
    console.error('uia-helper-test: FAIL — ' + (e && e.message || e));
    process.exitCode = 1;
  });
}
