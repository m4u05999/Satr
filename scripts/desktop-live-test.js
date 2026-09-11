#!/usr/bin/env node
'use strict';
/**
 * قبول سطح ويندوز حيّاً (الصف ٤ في docs/COMPUTER-USE-DESKTOP.md): «افتح المفكرة، اكتب سطراً، احفظ»
 * **بالمراجع وحدها** عبر الأدوات الثماني نفسها (agent.desktopTools — معالجات الإنتاج لا نسخة منها)
 * فوق electron/desktop.js والمعين الحقيقي، ثم stale_ref عند تغيّر النافذة من ثلاثة أبواب:
 *   (أ) لقطة أحدث تُبطل مرجع الأولى · (ب) إغلاق المفكرة ⇒ closed · (ج) إعادة فتحها واختيارها ⇒ stale_ref.
 * اختيار المستخدم (منتقي الخطوة ٥) يُحاكى بـdesktop.listTargets ثم selectTarget — القناتان نفسهما
 * خلف satr:desktopTargets وsatr:desktopSelect.
 *
 * التشغيل: npm run test:desktop-live — ويندوز وحده (SKIP_ON_POSIX في full-suite.js). المعين من
 * SATR_UIA_EXE أو out-aot أو out، ويُبنى بـdotnet build إن غاب. يسرق التركيز لحظة Ctrl+S.
 */

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'native', 'satr-uia');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

function killPid(pid) {
  if (!pid) return;
  try { cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* */ }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const readDoc = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

async function main() {
  if (process.platform !== 'win32') {
    console.log('desktop-live-test: تخطٍّ معلَن — UI Automation ويندوز وحده (مُدرَج في SKIP_ON_POSIX).');
    return;
  }
  const desktopModule = require('../electron/desktop');
  if (!desktopModule.resolveHelperPath()) {
    console.log('desktop-live-test: المعين غائب — يُبنى بـdotnet build …');
    const r = cp.spawnSync('dotnet', ['build', PROJECT, '-c', 'Release', '-o', path.join(PROJECT, 'out'), '-nologo'], { stdio: 'inherit', windowsHide: true });
    ok(r.status === 0, 'dotnet build فشل — رمز ' + r.status);
  }
  const helperPath = desktopModule.resolveHelperPath();
  const z = require('zod');
  const agent = require('../electron/agent');
  const events = [];
  const desktop = desktopModule.createDesktop({ emit: (e) => events.push(e) });
  const fakeSdk = { tool: (name, description, shape, handler) => ({ name, handler }) };
  const tools = Object.fromEntries(agent.desktopTools(fakeSdk, z, desktop).map((t) => [t.name, t]));
  const outputs = [];
  async function call(name, args) {
    const t0 = Date.now();
    const r = await tools[name].handler(args || {});
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    outputs.push(text);
    return { isError: !!r.isError, text, ms: Date.now() - t0 };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satr-desktop-live-'));
  const docName = 'satr-desktop-live-' + process.pid + '.txt';
  const docPath = path.join(workDir, docName);
  // BOM ‏UTF-8 كي تفتحه المفكرة UTF-8 وتحفظ السطر العربي بلا حوار ترميز
  fs.writeFileSync(docPath, '\uFEFF' + 'ORIGINAL_TEXT', 'utf8');
  const spawned = [];
  const metrics = {};

  async function openNotepad(label) {
    const np = cp.spawn('notepad.exe', [docPath], { stdio: 'ignore', windowsHide: false });
    spawned.push(np.pid);
    let target = null;
    let last = null;
    for (let i = 0; i < 60 && !target; i++) {
      const listed = await desktop.listTargets();
      ok(listed.ok, 'listTargets أعاد: ' + JSON.stringify(listed));
      const hit = listed.targets.find((t) => /^notepad$/i.test(t.processName) && (t.pid === np.pid || t.title.includes(docName)));
      // المستطيل يستقرّ بعد الظهور: الاختيار يطابقه حرفياً في المعين
      if (hit && last && last.targetId === hit.targetId && JSON.stringify(last.rect) === JSON.stringify(hit.rect)) target = hit;
      last = hit || null;
      if (!target) await sleep(200);
    }
    ok(target, 'لم تظهر ' + label + ' في قائمة النوافذ خلال 12ث');
    if (target.pid !== np.pid) spawned.push(target.pid);
    return target;
  }

  try {
    // ── افتح المفكرة، ويختارها المستخدم ──
    const tBoot = Date.now();
    const first = await desktop.listTargets();
    metrics.firstListMs = Date.now() - tBoot;
    ok(first.ok, 'أول سرد (إقلاع المعين) أعاد: ' + JSON.stringify(first));
    const np = await openNotepad('المفكرة');
    const selected = await desktop.selectTarget({ targetId: np.targetId, pid: np.pid });
    ok(selected.ok && selected.target.targetId === np.targetId, 'selectTarget أعاد: ' + JSON.stringify(selected));
    console.log(`  ✓ اختيار المستخدم: ${np.targetId} «${np.title}» (أول سرد مع إقلاع المعين ${metrics.firstListMs} م.ث)`);

    const targets = await call('desktop_targets');
    ok(!targets.isError && targets.text.includes(np.targetId) && targets.text.includes('ولا غيرها'), 'desktop_targets: ' + targets.text);

    // ── اللقطة ثم الكتابة بالمرجع ثم Ctrl+S ──
    const s1 = await call('desktop_snapshot', { target: np.targetId });
    ok(!s1.isError, 'desktop_snapshot: ' + s1.text);
    metrics.snapshotMs = s1.ms;
    // أسطر العناصر وحدها — سطر الرأس «[العناصر — …]» عنوان لا عنصر
    const lines = s1.text.split('\n').filter((l) => l.startsWith('[w'));
    ok(lines.length >= 3 && lines.every((l) => /^\[w[1-9][0-9]*:e[1-9][0-9]*\] [a-z]+( ".*")?$/.test(l)), 'سطر اللقطة ليس بالصيغة الحرفية: ' + lines.slice(0, 3).join(' · '));
    const editorLine = lines.find((l) => /\] (edit|document) "Text Editor"$/.test(l)) || lines.find((l) => /\] (edit|document)\b/.test(l));
    ok(editorLine, 'لا محرّر في لقطة المفكرة');
    const editorRef = editorLine.slice(1, editorLine.indexOf(']'));
    metrics.snapshotLines = lines.length;
    console.log(`  ✓ desktop_snapshot: ${lines.length} عنصراً (${s1.ms} م.ث) — المحرّر ${editorLine}`);

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const line = 'سطر كتبه وكيل «سطر» بالمراجع وحدها ' + stamp;
    const typed = await call('desktop_type', { ref: editorRef, text: line });
    ok(!typed.isError && typed.text.includes('تطابق المكتوب'), 'desktop_type: ' + typed.text);
    metrics.typeMs = typed.ms;
    const tSave = Date.now();
    const saved = await call('desktop_press_key', { keys: 'Ctrl+S' });
    ok(!saved.isError, 'desktop_press_key Ctrl+S: ' + saved.text);
    metrics.keyMs = saved.ms;
    let onDisk = '';
    for (let i = 0; i < 40 && onDisk !== line; i++) { await sleep(150); onDisk = readDoc(docPath); }
    metrics.saveLatencyMs = Date.now() - tSave;
    ok(onDisk === line, 'الملف على القرص لا يحمل السطر المكتوب (الواقع: ' + JSON.stringify(onDisk.slice(0, 80)) + ')');
    console.log(`  ✓ اكتب ⇒ احفظ: desktop_type ${typed.ms} م.ث · Ctrl+S ${saved.ms} م.ث · على القرص بعد ${metrics.saveLatencyMs} م.ث «${onDisk}»`);

    // ── (أ) لقطة أحدث تُبطل مرجع الأولى ──
    const s2 = await call('desktop_snapshot', { target: np.targetId });
    ok(!s2.isError, 'اللقطة الثانية: ' + s2.text);
    const staleA = await call('desktop_type', { ref: editorRef, text: 'MUST_NOT_LAND_A' });
    ok(staleA.isError && staleA.text === desktopModule.MESSAGES.stale_ref, '(أ) مرجع اللقطة الأولى بعد الثانية يجب أن يعيد stale_ref (الواقع: ' + staleA.text + ')');
    ok(readDoc(docPath) === line, '(أ) الفعل المرفوض لمس الملف');
    metrics.staleA = { ms: staleA.ms, ref: editorRef };
    console.log(`  ✓ (أ) لقطة أحدث: ${editorRef} ⇒ stale_ref في ${staleA.ms} م.ث بلا وصول المعين`);

    // ── (ب) إغلاق المفكرة: مرجع اللقطة الحالية ⇒ closed ──
    const editor2Line = s2.text.split('\n').find((l) => /\] (edit|document) "Text Editor"$/.test(l)) || s2.text.split('\n').find((l) => /\] (edit|document)\b/.test(l));
    const editor2 = editor2Line.slice(1, editor2Line.indexOf(']'));
    killPid(np.pid);
    for (let i = 0; i < 30 && isAlive(np.pid); i++) await sleep(100);
    const closedB = await call('desktop_type', { ref: editor2, text: 'MUST_NOT_LAND_B' });
    ok(closedB.isError && closedB.text === desktopModule.MESSAGES.closed, '(ب) الفعل بعد إغلاق النافذة يجب أن يعيد closed (الواقع: ' + closedB.text + ')');
    const afterClose = await call('desktop_snapshot', { target: np.targetId });
    ok(afterClose.isError && afterClose.text.includes('انتهت جلسة النافذة'), '(ب) اللقطة بعد الإغلاق: ' + afterClose.text);
    metrics.closedB = { ms: closedB.ms, ref: editor2 };
    console.log(`  ✓ (ب) أُغلقت المفكرة: ${editor2} ⇒ closed في ${closedB.ms} م.ث، والجلسة انتهت`);

    // ── (ج) إعادة الفتح والاختيار: مرجع الجلسة السابقة ⇒ stale_ref، والنافذة الجديدة برقم جديد ──
    const np2 = await openNotepad('المفكرة المعاد فتحها');
    ok(np2.targetId !== np.targetId, 'النافذة المعاد فتحها أخذت رقم المغلقة ' + np.targetId);
    const reselected = await desktop.selectTarget({ targetId: np2.targetId, pid: np2.pid });
    ok(reselected.ok, 'إعادة الاختيار: ' + JSON.stringify(reselected));
    const staleC = await call('desktop_type', { ref: editor2, text: 'MUST_NOT_LAND_C' });
    ok(staleC.isError && staleC.text === desktopModule.MESSAGES.stale_ref, '(ج) مرجع الجلسة السابقة بعد إعادة الاختيار يجب أن يعيد stale_ref (الواقع: ' + staleC.text + ')');
    const s3 = await call('desktop_snapshot', { target: np2.targetId });
    ok(!s3.isError && !s3.text.includes('[' + editor2 + ']'), '(ج) اللقطة الجديدة تعمل بمراجع جديدة');
    ok(readDoc(docPath) === line, '(ج) الملف تغيّر بفعل مرفوض');
    metrics.staleC = { ms: staleC.ms, ref: editor2, newTarget: np2.targetId };
    console.log(`  ✓ (ج) أُعيد فتحها ${np2.targetId} (لا ${np.targetId}): ${editor2} ⇒ stale_ref في ${staleC.ms} م.ث`);

    // ── السجل المرئي: سطر لكل فعل ناجح، بلا النص المكتوب ولا عنوان النافذة ──
    const acts = events.filter((e) => e.type === 'desktop_activity').map((e) => e.text);
    ok(acts.includes('قُرئت شجرة نافذة المفكرة'), 'لا سطر سجل للقطة: ' + acts.join(' | '));
    ok(acts.some((a) => /^كُتب نص \(الطول \d+\) في \[.+\] في نافذة المفكرة$/.test(a)), 'لا سطر سجل للكتابة: ' + acts.join(' | '));
    ok(acts.includes('ضُغط Ctrl+S في نافذة المفكرة'), 'لا سطر سجل لـCtrl+S: ' + acts.join(' | '));
    ok(!acts.some((a) => a.includes(stamp) || a.includes(docName)), 'السجل يحمل النص المكتوب أو عنوان النافذة');
    ok(acts.length === 5, 'خمسة أفعال ناجحة (ثلاث لقطات + كتابة + مفاتيح) والمرفوضة بلا سطر — الواقع ' + acts.length + ': ' + acts.join(' | '));
    metrics.activity = acts;
    console.log('  ✓ السجل العربي: ' + acts.join(' · '));

    ok(!outputs.some((o) => /[A-Za-z]:\\/.test(o) || /hwnd/i.test(o) || o.includes(helperPath)), 'ردّ أداة يحمل مساراً أو مقبضاً');
  } finally {
    await desktop.shutdown();
    for (const pid of spawned) killPid(pid);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log('desktop-live-test: ok — ' + checks + ' فحصاً · ' + JSON.stringify({
    firstListMs: metrics.firstListMs, snapshotMs: metrics.snapshotMs, snapshotLines: metrics.snapshotLines,
    typeMs: metrics.typeMs, keyMs: metrics.keyMs, saveLatencyMs: metrics.saveLatencyMs,
    staleA: metrics.staleA, closedB: metrics.closedB, staleC: metrics.staleC,
  }));
}

main().catch((e) => {
  console.error('desktop-live-test: FAIL — ' + (e && e.message || e));
  process.exitCode = 1;
});
