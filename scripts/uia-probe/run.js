#!/usr/bin/env node
'use strict';
// سائق مسبار UIA — الخطوة صفر في docs/COMPUTER-USE-DESKTOP.md (OBS-154).
// يطلق المعين ويكلّمه بأسطر JSON (انضباط codex.js: مهلة لكل طلب، إغلاق stdin ثم إنهاء)،
// ثم يطبع تقريراً واحداً بالأرقام. رمز الخروج: 0 = ≥٣ عناصر مسمّاة · 1 = أقل · 2 = خطأ.
// الاستعمال: node scripts/uia-probe/run.js [مسار UiaProbe.exe]
// الشرط: نافذة «المفكرة» (notepad) مفتوحة.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXE = process.argv[2] || path.join(__dirname, 'out', 'UiaProbe.exe');
// الإقلاع الأول لملف منفرد مستقل يستخرج مكتباته الأصلية إلى مجلد مؤقت فيطول — مهلته أوسع
const BOOT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const MIN_NAMED = 3;

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
  process.exitCode = 2;
}

async function main() {
  if (!fs.existsSync(EXE)) return fail('المعين غير موجود: ' + EXE);

  const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let stderrTail = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // سطر لا يطابق الشكل يُرفض
      const p = msg && pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  child.on('exit', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('exited')); }
    pending.clear();
  });

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout:' + method)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
  }

  const report = { ok: true, exe: EXE, timings: {} };
  try {
    const t0 = Date.now();
    const init = await request('initialize', {}, BOOT_TIMEOUT_MS);
    report.timings.bootMs = Date.now() - t0;
    if (init.error) throw new Error('initialize: ' + init.error.code);
    Object.assign(report, {
      version: init.result.version,
      osBuild: init.result.osBuild,
      uiaAvailable: init.result.uiaAvailable,
      packageFullName: init.result.packageFullName,
    });

    const tl = await request('targets/list', {}, REQUEST_TIMEOUT_MS);
    report.timings.targetsMs = tl.ms;
    if (tl.error) throw new Error('targets/list: ' + tl.error.code);
    report.targets = tl.result.length;
    const np = tl.result.find((t) => /^notepad$/i.test(t.processName));
    report.notepadFound = Boolean(np);

    if (np) {
      report.notepadTitle = np.title;
      const snap = await request('tree/snapshot', { targetId: np.targetId, maxDepth: 12, maxNodes: 400 }, REQUEST_TIMEOUT_MS);
      report.timings.snapshotMs = snap.ms;
      if (snap.error) {
        report.snapshotError = snap.error;
      } else {
        const nodes = snap.result.nodes;
        const named = nodes.filter((n) => typeof n.name === 'string' && n.name.trim());
        report.nodes = nodes.length;
        report.named = named.length;
        report.truncated = snap.result.truncated;
        report.passwordNodes = nodes.filter((n) => n.isPassword).length;
        report.sampleNames = named.slice(0, 5).map((n) => `[${n.ref}] ${n.role} "${n.name}"`);
      }
    }

    const sd = request('shutdown', {}, SHUTDOWN_TIMEOUT_MS).catch(() => null);
    await sd;
  } catch (e) {
    report.ok = false;
    report.error = String(e && e.message || e);
    if (stderrTail) report.stderrTail = stderrTail;
  } finally {
    try { child.stdin.end(); } catch { /* مغلق أصلاً */ }
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS);
      child.once('exit', () => { clearTimeout(t); resolve(true); });
    });
    if (!exited) { try { child.kill(); } catch { /* */ } }
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) process.exitCode = 2;
  else process.exitCode = (report.named || 0) >= MIN_NAMED ? 0 : 1;
}

main().catch((e) => fail(String(e && e.message || e)));
