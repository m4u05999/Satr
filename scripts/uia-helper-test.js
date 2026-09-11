#!/usr/bin/env node
'use strict';
/**
 * سطر — اختبار المعين الأصلي `native/satr-uia` (الصف ١ في docs/COMPUTER-USE-DESKTOP.md).
 *
 * يقيس على «المفكرة» فعلاً لا على محاكاة: يطلق المعين بانضباط codex.js (مهلة إقلاع، مهلة
 * لكل طلب، إغلاق stdin ثم إنهاء، ورفض أي ردّ لا يطابق الشكل) ويفحص:
 *   initialize (الزمن + packageFullName) · targets/list يجد المفكرة · tree/snapshot ≥3 عناصر
 *   مسمّاة بصيغة `[w2:e14] role "name"` · maxNodes يقصّ ويعلن · setValue يغيّر النص (قراءة ثانية
 *   من العنصر) · invoke على زر يغيّر النافذة · مرجع فاسد/قديم ⇒ stale_ref بلا فعل · حقل
 *   السرّ غائب عن اللقطة (نافذة WinForms فيها TextBox بكلمة مرور) · ردّ غير مطابق يُرفض ·
 *   shutdown وإغلاق stdin ينهيان العملية بلا أيتام · وإن كان الثنائي AOT: الحجم < 8 م.ب
 *   والإقلاع < 800 م.ث.
 *
 * الثنائي: `SATR_UIA_EXE` ⇐ `native/satr-uia/out/satr-uia.exe` ⇐ يُبنى بـ`dotnet build` إن غاب.
 * `SATR_UIA_EXPECT_AOT=1` (في CI) يجعل غياب AOT سقوطاً لا تخطّياً لفحصَي الحجم والإقلاع.
 * `SATR_UIA_METRICS_FILE` يكتب الأرقام JSON لخطوة CI التي تطبعها.
 *
 * ⚠️ حدّ مُصرَّح به: ويندوز وحده (UI Automation)؛ على POSIX يتخطّى بإعلان، ومُدرَج في
 * SKIP_ON_POSIX بـfull-suite.js. ويحتاج سطح مكتب تفاعلياً تُفتح فيه نافذة.
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
const SHUTDOWN_TIMEOUT_MS = 3000;
const MAX_AOT_BYTES = 8 * 1024 * 1024;
const MAX_BOOT_MS = 800;
const MIN_NAMED = 3;
const SNAPSHOT_LINE = /^\[w[1-9][0-9]*:e[1-9][0-9]*\] [a-z]+ ".*"$/s;
const REF_RE = /^w[1-9][0-9]*:e[1-9][0-9]*$/;

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * شكل الردّ الملزم: `{id, result|error, ms}` — واحد بالضبط من result/error، وms عدد،
 * والخطأ `{code, message}` نصّين. ما سواه يُرفض ولا يُسلَّم للمستدعي على أنه جواب.
 */
function validateResponse(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'ليس كائناً';
  if (!Number.isInteger(msg.id)) return 'id ليس عدداً صحيحاً';
  if (typeof msg.ms !== 'number' || !(msg.ms >= 0)) return 'ms مفقود أو ليس عدداً';
  const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');
  if (hasResult === hasError) return 'يلزم result أو error وحده';
  if (hasError && (!msg.error || typeof msg.error.code !== 'string' || typeof msg.error.message !== 'string')) {
    return 'error بلا code/message نصّيين';
  }
  return null;
}

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

async function waitForTarget(h, match, label) {
  for (let i = 0; i < 40; i++) {
    const tl = await h.request('targets/list');
    ok(!tl.error, 'targets/list أعاد خطأ: ' + JSON.stringify(tl.error));
    const hit = tl.result.find(match);
    if (hit) return { target: hit, list: tl };
    await sleep(250);
  }
  throw new Error('لم تظهر نافذة ' + label + ' في targets/list خلال 10ث');
}

async function snapshot(h, targetId, maxNodes = 400) {
  const snap = await h.request('tree/snapshot', { targetId, maxDepth: 12, maxNodes });
  ok(!snap.error, 'tree/snapshot أعاد خطأ: ' + JSON.stringify(snap.error));
  return snap;
}

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

    // ── المفكرة ──
    const notepad = cp.spawn('notepad.exe', [docPath], { stdio: 'ignore', windowsHide: false });
    spawned.push(notepad.pid);
    const { target: np, list } = await waitForTarget(h,
      (t) => /^notepad$/i.test(t.processName) && (t.pid === notepad.pid || String(t.title).includes(docName)), 'المفكرة');
    if (np.pid !== notepad.pid) spawned.push(np.pid);
    ok(list.result.every((t) => /^w[1-9][0-9]*$/.test(t.targetId) && Number.isInteger(t.pid)), 'كل هدف targetId بصيغة w<n> وpid عدد');
    console.log(`  ✓ targets/list: ${list.result.length} نافذة، المفكرة ${np.targetId} «${np.title}» (${list.ms} م.ث)`);

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

    const editor = nodes.find((n) => n.role === 'edit' || n.role === 'document');
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
    ok(staleSet.error && staleSet.error.code === 'stale_ref',
      'مرجع من لقطة سابقة يجب أن يعيد stale_ref (الواقع: ' + JSON.stringify(staleSet.error || staleSet.result) + ')');
    for (const bad of ['w0:e1', 'w1:e0', 'w01:e1', 'x', 'w1:e1 ', np.targetId + ':e999999', '', 42]) {
      const r = await h.request('element/invoke', { ref: bad });
      ok(r.error && r.error.code === 'stale_ref', `المرجع ${JSON.stringify(bad)} يجب أن يعيد stale_ref (الواقع: ${JSON.stringify(r.error || r.result)})`);
    }
    console.log('  ✓ stale_ref: مرجع قديم وثمانية مراجع فاسدة');

    // ── setValue: يغيّر النص فعلاً، والقيمة السابقة تثبت أن الفعل المرفوض لم يقع ──
    snap = await snapshot(h, np.targetId);
    nodes = snap.result.nodes;
    const ed = nodes.find((n) => n.role === editor.role && n.name === editor.name) || nodes.find((n) => n.role === 'edit' || n.role === 'document');
    const newText = 'سطر satr-uia ' + process.pid;
    const set = await h.request('element/setValue', { ref: ed.ref, text: newText });
    ok(!set.error, 'element/setValue على المحرّر أعاد خطأ: ' + JSON.stringify(set.error));
    ok(set.result.previous === 'ORIGINAL_TEXT',
      'القيمة قبل الكتابة يجب أن تكون نص الملف — أي أن stale_ref لم يكتب شيئاً (الواقع: ' + JSON.stringify(set.result.previous) + ')');
    ok(set.result.value === newText, 'القراءة الثانية من العنصر لا تطابق النص المكتوب (الواقع: ' + JSON.stringify(set.result.value) + ')');
    console.log(`  ✓ setValue: «${set.result.previous}» ⇒ «${set.result.value}» (${set.ms} م.ث)`);
    const setMissing = await h.request('element/setValue', { ref: ed.ref });
    ok(setMissing.error && setMissing.error.code === 'bad_request', 'setValue بلا text ⇒ bad_request');

    // ── invoke: زر في شريط العنوان (الأوسط = تكبير/استعادة) يغيّر مستطيل النافذة ──
    const notInvokable = await h.request('element/invoke', { ref: ed.ref });
    ok(notInvokable.error && notInvokable.error.code === 'unsupported_pattern',
      'invoke على محرّر بلا InvokePattern ⇒ unsupported_pattern (الواقع: ' + JSON.stringify(notInvokable.error || notInvokable.result) + ')');
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

    // ── الحارس ٣: حقل السرّ لا يدخل اللقطة أصلاً ──
    const formTitle = 'satr-uia-pw-' + process.pid;
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$f = New-Object Windows.Forms.Form; $f.Text = \'' + formTitle + '\';',
      '$u = New-Object Windows.Forms.TextBox; $u.Text = \'visible-user\'; $u.Top = 10;',
      '$p = New-Object Windows.Forms.TextBox; $p.UseSystemPasswordChar = $true; $p.Text = \'hunter2-secret\'; $p.Top = 40;',
      '$f.Controls.Add($u); $f.Controls.Add($p); [Windows.Forms.Application]::Run($f)',
    ].join(' ');
    const form = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    spawned.push(form.pid);
    const { target: ft } = await waitForTarget(h, (t) => t.title === formTitle, 'نموذج كلمة المرور');
    const pw = await snapshot(h, ft.targetId);
    const edits = pw.result.nodes.filter((n) => n.role === 'edit');
    ok(edits.length === 1, `النموذج فيه حقلان والمتوقّع حقل واحد في اللقطة (الواقع: ${edits.length}) — حقل السرّ دخل اللقطة`);
    ok(pw.result.nodes.every((n) => n.isPassword === false), 'عقدة isPassword=true في اللقطة');
    ok(!JSON.stringify(pw.result).includes('hunter2'), 'نص كلمة المرور ظهر في اللقطة');
    console.log(`  ✓ حقل السرّ غائب: ${pw.result.nodes.length} عقدة، حقل تحرير واحد من اثنين`);

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
