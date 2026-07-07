/**
 * سطر 2.0 — الطرفية العربية المدمجة (المرحلة 8)
 *
 * دورة حياة pseudoterminal واحد عبر node-pty (ConPTY على ويندوز 10 1809+).
 * التصميم الكامل في docs/PHASE8-DESIGN.md — هذه الوحدة هي «العقد» الموثّق في CLAUDE.md:
 *   - طرفية واحدة في الـ MVP: startTerm يعيد الجلسة الحيّة إن وُجدت بدل إنشاء ثانية.
 *   - البايتات تصل الواجهة عبر notifier (قناة satr:term المستقلة عالية الإنتاجية).
 *   - القتل مضمون عند إغلاق التطبيق (main.js يستدعي killAll في window-all-closed/before-quit).
 *
 * ملاحظة اعتمادية: node-pty استثناء «أصلي» واعٍ وموثَّق (القاعدة 5 في CLAUDE.md).
 * التحميل كسول (lazy) حتى لا يمنع فشل تحميل الوحدة الأصلية — إن حدث — إقلاع «سطر» كله.
 */

const fs = require('fs');
const os = require('os');

const IS_WIN = process.platform === 'win32';

let pty = null;        // وحدة node-pty (تحميل كسول)
let ptyLoadError = null;

// الجلسة الحيّة الوحيدة: { id, proc, shell } أو null
let current = null;
let seq = 0;

// دالة بثّ الأحداث للواجهة — يضبطها main.js (نفس نمط bgprocs.setNotifier)
let notify = () => {};
function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

// تحميل node-pty عند أول طلب فقط — رسالة الخطأ تُعاد للواجهة بالعربية بدل انهيار صامت
function loadPty() {
  if (pty || ptyLoadError) return pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    ptyLoadError = String((e && e.message) || e);
  }
  return pty;
}

// الصدفة الافتراضية: PowerShell على ويندوز (أغنى من cmd)، وإلا صدفة النظام
function defaultShell() {
  if (IS_WIN) {
    // COMSPEC احتياط مضمون؛ powershell.exe موجود في كل ويندوز 10+
    return process.env.SATR_SHELL || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/**
 * بدء الطرفية (أو إعادة الجلسة الحيّة إن وُجدت — طرفية واحدة في الـ MVP).
 * cwd/cols/rows منقّاة مسبقاً في main.js، ونعيد التحقق دفاعياً هنا.
 */
function startTerm(cwd, cols, rows) {
  if (current) return { ok: true, id: current.id, shell: current.shell, existing: true };

  if (!loadPty()) {
    return { ok: false, error: 'pty_load_failed', message: 'تعذّر تحميل مكوّن الطرفية (node-pty): ' + ptyLoadError };
  }

  let dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error();
  } catch {
    dir = os.homedir();
  }

  const c = Number.isInteger(cols) && cols >= 2 && cols <= 500 ? cols : 100;
  const r = Number.isInteger(rows) && rows >= 2 && rows <= 500 ? rows : 30;
  const shell = defaultShell();
  const id = 'term_' + (++seq);

  let proc;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: c,
      rows: r,
      cwd: dir,
      env: process.env,
      useConpty: true, // ConPTY — المتطلب الموثّق: ويندوز 10 1809+
    });
  } catch (e) {
    return { ok: false, error: 'spawn_failed', message: 'تعذّر تشغيل الصدفة: ' + String((e && e.message) || e) };
  }

  current = { id, proc, shell };

  // خرج pty نص UTF-8 (node-pty يتكفّل بالفك) — يُبثّ كما هو، والواجهة تكتبه في xterm.js
  proc.onData((data) => notify({ type: 'data', id, data }));
  proc.onExit(({ exitCode }) => {
    // خروج الصدفة (exit أو انهيار): نظّف الحالة وأخبر الواجهة لتعرض «انتهت الجلسة»
    if (current && current.id === id) current = null;
    notify({ type: 'exit', id, exitCode });
  });

  return { ok: true, id, shell };
}

// كتابة خام إلى pty — البيانات آمنة لأنها تذهب لمجرى الطرفية لا لوسائط spawn
function writeTerm(id, data) {
  if (!current || current.id !== id) return { ok: false, error: 'no_term' };
  try { current.proc.write(data); } catch (e) { return { ok: false, error: 'write_failed' }; }
  return { ok: true };
}

function resizeTerm(id, cols, rows) {
  if (!current || current.id !== id) return { ok: false, error: 'no_term' };
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return { ok: false, error: 'bad_size' };
  if (cols < 2 || cols > 500 || rows < 2 || rows > 500) return { ok: false, error: 'bad_size' };
  try { current.proc.resize(cols, rows); } catch (e) { /* تغيير حجم بعد الموت — غير مهم */ }
  return { ok: true };
}

function killTerm(id) {
  if (!current || current.id !== id) return { ok: false, error: 'no_term' };
  const proc = current.proc;
  current = null;
  // ConPTY يُنهي شجرة العمليات المرتبطة به عند إغلاق الـ pty
  try { proc.kill(); } catch (e) {}
  return { ok: true };
}

// قتل مضمون عند إغلاق التطبيق (window-all-closed / before-quit) — نفس فلسفة bgprocs
function killAll() {
  if (!current) return;
  const proc = current.proc;
  current = null;
  try { proc.kill(); } catch (e) {}
}

module.exports = { setNotifier, startTerm, writeTerm, resizeTerm, killTerm, killAll };
