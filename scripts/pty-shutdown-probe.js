'use strict';
/**
 * مسبار: هل ينتهي «سطر» فعلاً عند الإغلاق وطرفية pty حيّة؟
 *
 * العطل المرصود (2026-08-12، بلاغ داخلي): إغلاق التطبيق وطرفية مفتوحة كان يترك
 * العملية حيّة إلى الأبد. المسار: `cleanupBeforeQuit` ⇒ `term.killAll` ⇒
 * ‏`proc.kill()` ⇒ node-pty يشغّل وكيل ConPTY (‏conpty_console_list_agent) الذي
 * يرمي `AttachConsole failed` حين لا كونسول ويندوز مرفق — والتطبيق المحزوم بلا
 * كونسول — فيتجمّد التفكيك الأصلي. وحلقة JS تموت قبله فلا ينفع احتياط JS بعدها.
 *
 * الإصلاح المُختبَر هنا: `term.killProcTree` يقتل شجرة الـpty بـtaskkill قبل
 * تفكيك node-pty، وحارس إغلاق في main.js يمنع أي مسار من حبس الخروج.
 *
 * لماذا مسبار خارجي لا اختبار داخل الطقم: القياس هو **موت العملية نفسها**، ولا
 * يمكن لعملية أن تشهد على موتها. مشغّل خارجي يراقب ويحكم.
 *
 * التشغيل: node scripts/pty-shutdown-probe.js
 * الخروج: 0 إن انتهت العملية داخل المهلة، وغير صفري إن بقيت حيّة (العطل عاد).
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHILD_FLAG = 'SATR_PTY_SHUTDOWN_CHILD';
const LOG = path.join(ROOT, 'dist', 'pty-shutdown-probe.log');
const EXIT_GRACE_MS = 15000; // مهلة سخية: الحكم «لم تنتهِ» لا «كانت بطيئة»

// ─────────────────────────── وضع الطفل (داخل Electron) ───────────────────────
if (process.env[CHILD_FLAG]) {
  const { app, BrowserWindow } = require('electron');
  const t0 = Date.now();
  const log = (m) => { try { fs.appendFileSync(LOG, `${m} at=${Date.now() - t0}ms\n`); } catch (e) {} };
  process.on('uncaughtException', (err) => { log('UNCAUGHT ' + (err && err.message)); process.exit(8); });
  app.setPath('userData', path.join(ROOT, 'dist', 'pty-probe-userdata'));
  log('BOOT pid=' + process.pid);
  require(path.join(ROOT, 'electron', 'main.js'));
  app.whenReady().then(async () => {
    for (let i = 0; i < 80 && !BrowserWindow.getAllWindows().length; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    log('WINDOW_READY');
    const term = require(path.join(ROOT, 'electron', 'term.js'));
    const t = term.startTerm({ cwd: ROOT, cols: 80, rows: 24 });
    log('PTY_STARTED ' + JSON.stringify(t && (t.id || t)));
    await new Promise((r) => setTimeout(r, 2000));
    const mode = process.env.SATR_PTY_PROBE_MODE === 'exit' ? 'exit' : 'quit';
    log('QUIT_WITH_LIVE_PTY mode=' + mode);
    // quit = مسار المستخدم الحقيقي (‏before-quit ⇒ cleanupBeforeQuit)
    // exit = مسار أدوات الاختبار (يتخطى التنظيف ويصطدم بتفكيك ConPTY مباشرةً)
    if (mode === 'exit') app.exit(0); else app.quit();
  });
  return;
}

// ─────────────────────────── وضع المراقب (node عادي) ─────────────────────────
function electronBin() {
  const c = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('لم يُعثر على ثنائي Electron');
}

function aliveTree(pid) {
  if (process.platform !== 'win32') { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} } | Measure-Object).Count`],
    { encoding: 'utf8', timeout: 15000 });
    return Number(String(out).trim()) > 0;
  } catch (e) { return false; }
}

function hardKill(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
    else process.kill(pid, 'SIGKILL');
  } catch (e) { /* أفضل جهد */ }
}

(async () => {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, ''); } catch (e) {}
  const child = spawn(electronBin(), [__filename], {
    cwd: ROOT,
    env: { ...process.env, [CHILD_FLAG]: '1' },
    stdio: 'ignore',
  });
  const started = Date.now();
  let exited = false;
  child.on('exit', () => { exited = true; });

  // ننتظر حتى تخرج العملية أو تنفد المهلة بعد لحظة الإغلاق
  const deadline = started + 60000 + EXIT_GRACE_MS;
  while (Date.now() < deadline && !exited) await new Promise((r) => setTimeout(r, 500));

  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const quitSeen = /QUIT_WITH_LIVE_PTY/.test(log);
  const treeAlive = !exited && aliveTree(child.pid);

  process.stdout.write(log.replace(/^/gm, '  | '));
  if (!quitSeen) {
    console.log('pty-shutdown-probe: فشل — لم يبلغ المسبار مرحلة الإغلاق (راجع السجل)');
    hardKill(child.pid);
    process.exit(2);
  }
  if (exited && !treeAlive) {
    console.log('pty-shutdown-probe: نجح — انتهت العملية بعد الإغلاق وطرفية pty حيّة');
    process.exit(0);
  }
  console.log('pty-shutdown-probe: فشل — العملية ما زالت حيّة بعد الإغلاق (عاد تجمّد ConPTY)');
  hardKill(child.pid);
  process.exit(1);
})();
