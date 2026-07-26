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

// سجلّ الطرفيات الحيّة: يحفظ وصف الطرفية وذيل خرجها كي تستعيده الواجهة بعد إعادة التحميل.
const terminals = new Map();
let seq = 0;
const MAX_TERMS = 12; // 8 تبويبات للمستخدم + 4 مهام معمّرة مستقلة بلا مزاحمة
const MAX_BUFFER_BYTES = 256 * 1024;
const captureQueues = new Map();
const listeners = new Set();

// دالة بثّ الأحداث للواجهة — يضبطها main.js (نفس نمط bgprocs.setNotifier)
let notify = () => {};
function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }
function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(event) {
  notify(event);
  for (const listener of listeners) {
    try { listener(event); } catch (e) { console.error('[term] فشل مستمع داخلي:', e && e.message); }
  }
}

function appendBuffer(entry, data) {
  const chunk = Buffer.from(String(data || ''), 'utf8');
  entry.buffer = Buffer.concat([entry.buffer, chunk]);
  if (entry.buffer.length > MAX_BUFFER_BYTES) entry.buffer = entry.buffer.subarray(entry.buffer.length - MAX_BUFFER_BYTES);
}

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
function startTerm(cwd, cols, rows, meta) {
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

  const safeMeta = meta && typeof meta === 'object' ? meta : {};
  const entry = {
    id, proc, shell, cwd: dir,
    label: typeof safeMeta.label === 'string' ? safeMeta.label : '',
    isModel: safeMeta.isModel === true,
    isJob: safeMeta.isJob === true,
    buffer: Buffer.alloc(0),
  };
  terminals.set(id, entry);

  // خرج pty نص UTF-8 (node-pty يتكفّل بالفك) — يُبثّ مع معرّف طرفيته لتوجّهه الواجهة
  proc.onData((data) => {
    appendBuffer(entry, data);
    emit({ type: 'data', id, data });
  });
  proc.onExit(({ exitCode }) => {
    // خروج الصدفة (exit أو انهيار): أزِل الطرفية وأخبر الواجهة لتعرض «انتهت الجلسة»
    // K4: الذيل الخام (≤32KiB من المخزن الدائري) يُلتقط ويُرفق بالحدث **قبل** حذف
    // المخزن — مهام termjobs المحدودة تنقّيه وتبثّه bg_term_done فلا يضيع خرجها.
    const tail = entry.buffer.subarray(Math.max(0, entry.buffer.length - 32768)).toString('utf8');
    terminals.delete(id);
    captureQueues.delete(id);
    emit({ type: 'exit', id, exitCode, tail });
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
  return Array.from(terminals.values()).map((t) => ({
    id: t.id, label: t.label, isModel: t.isModel, isJob: t.isJob, shell: t.shell, cwd: t.cwd,
  }));
}

function readBuffer(id, tailBytes) {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: 'no_term' };
  const wanted = Number.isInteger(tailBytes) && tailBytes > 0
    ? Math.min(tailBytes, MAX_BUFFER_BYTES) : MAX_BUFFER_BYTES;
  const data = t.buffer.subarray(Math.max(0, t.buffer.length - wanted)).toString('utf8');
  return { ok: true, data };
}

// ---------- طرفية النموذج المخصّصة (المرحلة 16.2 — أداة run_in_terminal) ----------
// تبويب واحد يملكه النموذج، يرى فيه المستخدم كل ما يشغّله حياً معزولاً عن تبويباته.
// يُعاد استخدامه عبر أدوار الجلسة؛ يُنشأ عند أول استدعاء للأداة.
let modelTermId = null;

// يضمن وجود طرفية النموذج (يعيد الحيّة أو ينشئ واحدة)، ويعيد { id, shell, created }
function ensureModelTerm(cwd) {
  if (modelTermId && terminals.has(modelTermId)) {
    return { ok: true, id: modelTermId, shell: terminals.get(modelTermId).shell, created: false };
  }
  const r = startTerm(cwd, 120, 30, { label: 'النموذج', isModel: true });
  if (!r.ok) return r;
  modelTermId = r.id;
  return { ok: true, id: r.id, shell: r.shell, created: true };
}

function getModelTermId() { return (modelTermId && terminals.has(modelTermId)) ? modelTermId : null; }

// ---------- تشغيل أمر مع التقاط خرجه (المرحلة 16 — أداة run_in_terminal) ----------
// يشغّل أمراً في طرفية مرئية موجودة فيراه المستخدم حياً، ويلتقط خرجه ليعيده للنموذج.
// الالتقاط عبر «علامة نهاية» فريدة تُطبع بعد الأمر: نجمع الخرج حتى تظهر، ثم نستخرج
// رمز الخروج منها. مصمَّم للأوامر السطرية؛ التطبيقات التفاعلية تُعالَج بالمهلة.

// تنقية بايتات التحكم من الأمر (حقن ANSI/تحكم في نص الأمر) — يُبقى المحارف المطبوعة
// والتبويب فقط. حدّ الطول احترازي (الأمر يذهب لمجرى pty لا لوسائط spawn أصلاً).
function sanitizeCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  // إزالة C0 و DEL و C1 (عدا لا شيء) — لا أسطر جديدة داخل الأمر (سطر واحد)
  return cmd.replace(/[\x00-\x08\x0A-\x1F\x7F-\x9F]/g, '').slice(0, 8000);
}

const MAX_CAPTURE = 512 * 1024;   // سقف خرج ملتقَط (يحمي ذاكرة النموذج والعملية)
const DEFAULT_CAP_TIMEOUT = 120000; // مهلة افتراضية للأمر (قابلة للتخصيص من المستدعي)

function runCaptureNow(id, command, opts) {
  return new Promise((resolve) => {
    const t = terminals.get(id);
    if (!t) return resolve({ ok: false, error: 'no_term', message: 'لا توجد طرفية بهذا المعرّف.' });
    const clean = sanitizeCommand(command);
    if (!clean.trim()) return resolve({ ok: false, error: 'empty', message: 'أمر فارغ.' });

    const timeoutMs = Number.isInteger(opts && opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, 600000) : DEFAULT_CAP_TIMEOUT;

    // علامتا بداية/نهاية فريدتان: الخرج الحقيقي بينهما حصراً. كلٌّ سطر مستقل في المخرج
    // (مطابقة تامة)، بينما صدى سطر الأمر يحوي العلامتين داخل نصّ الأمر فلا يطابق تماماً —
    // يحلّ مشكلة التفاف صدى الأمر عبر الأسطر (تحقق قبول 16.1).
    const tok = '__SATR_' + Math.random().toString(36).slice(2) + Date.now().toString(36) + '__';
    const mBeg = tok + 'B', mEnd = tok + 'E';
    const sh = (t.shell || '').toLowerCase();
    let line;
    if (sh.includes('powershell') || sh.includes('pwsh')) {
      // رمز الخروج رقمي دائماً: نصفّر $LASTEXITCODE قبل الأمر كي لا يحمل قيمة دور سابق
      // (cmdlets لا تضبطه)، وبعده نسقط لـ $? لو بقي $null (أمر أصلي لم يُشغَّل)
      line = '$global:LASTEXITCODE=0; Write-Output "' + mBeg + '"; ' + clean +
        ' ; $c=$LASTEXITCODE; if($c -eq $null){$c=if($?){0}else{1}}; Write-Output ("' + mEnd + ':"+$c)\r';
    } else if (sh.includes('cmd')) {
      line = 'echo ' + mBeg + ' & ' + clean + ' & echo ' + mEnd + ':%ERRORLEVEL%\r';
    } else {
      line = 'printf "%s\\n" "' + mBeg + '"; ' + clean + ' ; printf "%s:%s\\n" "' + mEnd + '" "$?"\r';
    }

    const endRe = new RegExp(mEnd + ':(-?\\d+)'); // اكتمال + رمز الخروج
    let buf = '';
    let settled = false;
    let disp = null;
    let timer = null;

    function finish(res) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (disp && disp.dispose) disp.dispose(); } catch (e) {}
      resolve(res);
    }

    // الخرج النظيف = الأسطر بين علامة البداية (كسطر مستقل مطابق) وعلامة النهاية.
    // نزع ANSI أولاً؛ ثم آخر سطر يساوي mBeg تماماً هو البداية الحقيقية (لا صدى الأمر).
    function cleanOutput(raw) {
      const s = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
      const lines = s.split('\n');
      let bi = -1;
      for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim() === mBeg) { bi = i; break; } }
      let out = bi >= 0 ? lines.slice(bi + 1) : lines;
      out = out.filter((l) => l.indexOf(mEnd) < 0 && l.indexOf(mBeg) < 0); // احترازاً
      return out.join('\n').trim().slice(0, MAX_CAPTURE);
    }

    // مِقبس مؤقت على نفس مجرى الخرج (المِقبس الدائم notify يبقى — المستخدم يرى حياً)
    disp = t.proc.onData((data) => {
      if (buf.length < MAX_CAPTURE + 8192) buf += data;
      const m = buf.match(endRe);
      if (m) finish({ ok: true, exitCode: parseInt(m[1], 10), output: cleanOutput(buf.slice(0, m.index)) });
    });

    timer = setTimeout(() => {
      finish({ ok: true, timedOut: true, exitCode: null, output: cleanOutput(buf),
        note: 'انتهت المهلة (' + Math.round(timeoutMs / 1000) + 'ث) — قد يكون أمراً تفاعلياً أو طويلاً؛ الخرج حتى الآن أعلاه.' });
    }, timeoutMs);

    // اللصق المُقوّس (bracketed paste): PSReadLine يعالج المحتوى كوحدة لصق بلا إعادة رسم
    // ولا إسقاط محارف للأسطر الطويلة (تحقق قبول 16.1: الحقن الخام يُسقط محارف السطر الطويل)
    const CR = line.slice(-1) === '\r' ? '\r' : '';
    const body = CR ? line.slice(0, -1) : line;
    try { t.proc.write('\x1b[200~' + body + '\x1b[201~' + CR); }
    catch (e) { finish({ ok: false, error: 'write_failed', message: 'تعذّرت الكتابة للطرفية.' }); }
  });
}

// لكل طرفية طابور مستقل: لا تتشابك علامتا التقاط حين تطلب أداتان التنفيذ بالتوازي.
function runCapture(id, command, opts) {
  const previous = captureQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => runCaptureNow(id, command, opts));
  captureQueues.set(id, current);
  current.finally(() => {
    if (captureQueues.get(id) === current) captureQueues.delete(id);
  }).catch(() => {});
  return current;
}

// قتل مضمون لكل الطرفيات عند إغلاق التطبيق (window-all-closed / before-quit)
function killAll() {
  for (const t of terminals.values()) {
    try { t.proc.kill(); } catch (e) {}
  }
  terminals.clear();
  captureQueues.clear();
  modelTermId = null;
}

module.exports = {
  MAX_TERMS, MAX_BUFFER_BYTES,
  setNotifier, subscribe, startTerm, writeTerm, resizeTerm, killTerm, listTerms, readBuffer,
  sanitizeCommand, runCapture, ensureModelTerm, getModelTermId, killAll,
};
