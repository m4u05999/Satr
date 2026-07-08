/**
 * سطر 2.0 — الطرفية العربية المدمجة (المرحلة 8)
 *
 * دورة حياة عدة pseudoterminals عبر node-pty (ConPTY على ويندوز 10 1809+) — المرحلة 15.
 * التصميم في docs/PHASE8-DESIGN.md؛ هذه الوحدة هي «العقد» الموثّق في CLAUDE.md:
 *   - تعدد الطرفيات (المرحلة 15): سجلّ Map بمعرّفات، بسقف MAX_TERMS. كل استدعاء
 *     startTerm ينشئ طرفية جديدة (تتبّع أي منها نشطة مسؤولية الواجهة).
 *   - البايتات تصل الواجهة عبر notifier مع معرّف الطرفية (قناة satr:term المستقلة).
 *   - القتل مضمون عند إغلاق التطبيق (main.js يستدعي killAll في window-all-closed/before-quit).
 *
 * ملاحظة اعتمادية: node-pty استثناء «أصلي» واعٍ وموثَّق (القاعدة 5 في CLAUDE.md).
 * التحميل كسول (lazy) حتى لا يمنع فشل تحميل الوحدة الأصلية — إن حدث — إقلاع «سطر» كله.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

let pty = null;        // وحدة node-pty (تحميل كسول)
let ptyLoadError = null;

// سجلّ الطرفيات الحيّة: id → { id, proc, shell } (المرحلة 15 — تعدد الطرفيات)
const terminals = new Map();
let seq = 0;
const MAX_TERMS = 8; // سقف أمان: يمنع تسريب العمليات إن أساءت الواجهة الاستدعاء

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

// الصدف المسموحة لتجاوز SATR_SHELL — قائمة سماح باسم الملف الأساسي
// (اكتشاف مراجعة الوكيل muraji-amn: القيمة كانت تمرّ لـ pty.spawn بلا تنقية)
const ALLOWED_SHELLS = new Set(['powershell.exe', 'pwsh.exe', 'cmd.exe']);

// الصدفة الافتراضية: PowerShell على ويندوز (أغنى من cmd)، وإلا صدفة النظام
function defaultShell() {
  if (IS_WIN) {
    const want = (process.env.SATR_SHELL || '').trim();
    if (want) {
      if (ALLOWED_SHELLS.has(path.basename(want).toLowerCase())) return want;
      console.error('[term] تجاهل SATR_SHELL — ليست صدفة معروفة:', want);
    }
    return 'powershell.exe'; // موجود في كل ويندوز 10+
  }
  return process.env.SHELL || '/bin/bash';
}

/**
 * بدء طرفية جديدة (المرحلة 15 — كل استدعاء ينشئ واحدة، بسقف MAX_TERMS).
 * cwd/cols/rows منقّاة مسبقاً في main.js، ونعيد التحقق دفاعياً هنا.
 */
function startTerm(cwd, cols, rows) {
  if (terminals.size >= MAX_TERMS) {
    return { ok: false, error: 'too_many', message: 'بلغت الحد الأقصى للطرفيات (' + MAX_TERMS + ') — أغلق واحدة أولاً.' };
  }

  if (!loadPty()) {
    // التفاصيل (مسارات النظام) للسجل فقط — الواجهة تتلقى رسالة عامة (مراجعة muraji-amn)
    console.error('[term] فشل تحميل node-pty:', ptyLoadError);
    return { ok: false, error: 'pty_load_failed', message: 'تعذّر تحميل مكوّن الطرفية — أعد تثبيت «سطر» أو راجع سجل التشغيل.' };
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

  // ترميز UTF-8 للكونسول (chcp 65001 بالاتجاهين): خرج البرامج يصل UTF-8 سليماً بلا
  // هذا، لكن **صدى الإدخال** العربي يمر بصفحة ترميز conhost القديمة فيصير «؟؟؟» —
  // ثبت بالتجربة (لقطة قبول 8.2). نضبطه عند الإقلاع بلا ضجيج في أول الشاشة.
  let args = [];
  const shellLower = shell.toLowerCase();
  if (shellLower.includes('powershell') || shellLower.includes('pwsh')) {
    args = ['-NoExit', '-Command',
      '[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8'];
  } else if (shellLower.includes('cmd')) {
    args = ['/K', 'chcp 65001 >nul'];
  }

  let proc;
  try {
    proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: c,
      rows: r,
      cwd: dir,
      // البيئة كاملة عمداً (سلوك كل الطرفيات المدمجة: PATH وإعدادات المطور ضرورية) —
      // يعني أن مفاتيح API في بيئة «سطر» تصل للصدفة، وهي صدفة المستخدم نفسه بنفس صلاحياته
      env: process.env,
      useConpty: true, // ConPTY — المتطلب الموثّق: ويندوز 10 1809+
    });
  } catch (e) {
    console.error('[term] فشل تشغيل الصدفة:', (e && e.message) || e);
    return { ok: false, error: 'spawn_failed', message: 'تعذّر تشغيل الصدفة — أعد المحاولة أو راجع سجل التشغيل.' };
  }

  terminals.set(id, { id, proc, shell });

  // خرج pty نص UTF-8 (node-pty يتكفّل بالفك) — يُبثّ مع معرّف طرفيته لتوجّهه الواجهة
  proc.onData((data) => notify({ type: 'data', id, data }));
  proc.onExit(({ exitCode }) => {
    // خروج الصدفة (exit أو انهيار): أزِل الطرفية وأخبر الواجهة لتعرض «انتهت الجلسة»
    terminals.delete(id);
    notify({ type: 'exit', id, exitCode });
  });

  return { ok: true, id, shell };
}

// كتابة خام إلى pty — البيانات آمنة لأنها تذهب لمجرى الطرفية لا لوسائط spawn.
// تحقق دفاعي مكرر لتنقية main.js تحسّباً لإعادة هيكلة مستقبلية (مراجعة muraji-amn)
function writeTerm(id, data) {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: 'no_term' };
  if (typeof data !== 'string' || !data.length || data.length > 1024 * 1024)
    return { ok: false, error: 'bad_data' };
  try { t.proc.write(data); } catch (e) { return { ok: false, error: 'write_failed' }; }
  return { ok: true };
}

function resizeTerm(id, cols, rows) {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: 'no_term' };
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return { ok: false, error: 'bad_size' };
  if (cols < 2 || cols > 500 || rows < 2 || rows > 500) return { ok: false, error: 'bad_size' };
  try { t.proc.resize(cols, rows); } catch (e) { /* تغيير حجم بعد الموت — غير مهم */ }
  return { ok: true };
}

function killTerm(id) {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: 'no_term' };
  terminals.delete(id);
  // ConPTY يُنهي شجرة العمليات المرتبطة به عند إغلاق الـ pty
  try { t.proc.kill(); } catch (e) {}
  return { ok: true };
}

// قائمة معرّفات الطرفيات الحيّة (للواجهة: استرجاع أو تشخيص)
function listTerms() {
  return Array.from(terminals.values()).map((t) => ({ id: t.id, shell: t.shell }));
}

// قتل مضمون لكل الطرفيات عند إغلاق التطبيق (window-all-closed / before-quit)
function killAll() {
  for (const t of terminals.values()) {
    try { t.proc.kill(); } catch (e) {}
  }
  terminals.clear();
}

module.exports = { setNotifier, startTerm, writeTerm, resizeTerm, killTerm, listTerms, killAll };
