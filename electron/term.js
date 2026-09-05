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

// سطر ضبط ترميز الكونسول — نسخة واحدة يستعملها مسارا الإقلاع (سطر تفاعلي/سكربت مُرمَّز).
// رابطَا Ctrl+V باللصق عمداً: علاج OBS-106 (أدناه) يمرّر النص المشكَّل عبر حافظة
// اللصق بدل أحداث المفاتيح، فإن أعاد المستخدم ربط المفتاح في ملفه انكسر العلاج صامتاً.
// الخطأ هنا غير قاطع (cmdlet) فلا يعطّل سكربت الإقلاع لو تعذّرت الوحدة.
const PWSH_UTF8_PRELUDE =
  '[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
  + 'Set-PSReadLineKeyHandler -Key Ctrl+v -Function Paste';

// سقف نصّ base64 المُمرَّر في `-EncodedCommand`. حدّ `CreateProcess` هو 32767 محرفاً
// لسطر الأوامر كله؛ نترك هامشاً لاسم الصدفة والعلَم. التجاوز يُرصد قبل spawn لا بعده.
const MAX_ENCODED_COMMAND = 30000;

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
  const safeMeta = meta && typeof meta === 'object' ? meta : {};

  // ترميز UTF-8 للكونسول (chcp 65001 بالاتجاهين): خرج البرامج يصل UTF-8 سليماً بلا
  // هذا، لكن **صدى الإدخال** العربي يمر بصفحة ترميز conhost القديمة فيصير «؟؟؟» —
  // ثبت بالتجربة (لقطة قبول 8.2). نضبطه عند الإقلاع بلا ضجيج في أول الشاشة.
  let args = [];
  const shellLower = shell.toLowerCase();
  const isPwsh = shellLower.includes('powershell') || shellLower.includes('pwsh');
  if (isPwsh) {
    args = ['-NoExit', '-Command', PWSH_UTF8_PRELUDE];
  } else if (shellLower.includes('cmd')) {
    args = ['/K', 'chcp 65001 >nul'];
  }

  // ---- سكربت الإقلاع: يُمرَّر في **وسائط spawn** لا في سطر الطرفية (‏OBS-065) ----
  // العلّة المقيسة لم تكن الطول (‏7986 محرفاً وصلت سليمة بالكتابة الخام)، بل **جملة غير
  // مكتملة** تُبقي PowerShell عند مِحَثّ `>>` إلى الأبد فتبدو المهمة حيّة بلا عمل. ومصدرها
  // الأول كان `sanitizeCommand` وهو يحذف `\n` فيلصق الجُمل — انظر `sanitizeScript`.
  // تمريره في الوسائط يُخرج الأمر من محرِّر السطر كلياً: لا حدّ طول، ولا PSReadLine، ولا
  // ملف على القرص يحتاج تنظيفاً أو تصطدم به `ExecutionPolicy` (‏افتراضي ويندوز للعميل
  // `Restricted` يحجب `& 'file.ps1'`، وجهاز التطوير المتساهل كان سيُخفي ذلك).
  // وأي خطأ تحليل يصير خروجاً فورياً برمز 1 ورسالة صريحة بدل علقٍ صامت — مقيس.
  const bootScript = typeof safeMeta.script === 'string' ? safeMeta.script : '';
  let launchedScript = false;
  if (bootScript) {
    if (isPwsh) {
      // base64 لـUTF-16LE: يعبر سطر أوامر ويندوز بمحارف ASCII فقط، فلا اقتباس يُفسد
      // ولا محرف عربي يُشوَّه. حدّ سطر الأوامر 32767 وسقفنا 8000 محرف ⇒ هامش واسع.
      const encoded = Buffer.from(PWSH_UTF8_PRELUDE + '\n' + bootScript, 'utf16le').toString('base64');
      // حارس صريح بدل رسالة نظام غامضة: تجاوز سطر أوامر ويندوز يردّ
      // `Cannot create process, error code: 206` وهو لا يدلّ على السبب (رُصد حيّاً).
      if (encoded.length > MAX_ENCODED_COMMAND) {
        return { ok: false, error: 'script_too_long',
          message: 'الأمر أطول مما يقبله سطر أوامر ويندوز — اختصره أو ضعه في ملف سكربت واستدعِه.' };
      }
      args = ['-EncodedCommand', encoded];
      launchedScript = true;
    }
    // الصدف الأخرى (cmd وPOSIX) تبقى على مسار الكتابة إلى السطر عمداً: العطل المرصود
    // خاص بـPSReadLine، وتحويل bash إلى `-c` يُسقط قراءة `.bashrc` (الصدفة اليوم
    // تفاعلية) فيتغيّر PATH للمستخدم — تغييرٌ غير مقيس لا نُقدم عليه. حدّ معلَن.
  }

  let proc;
  try {
    proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: c,
      rows: r,
      cwd: dir,
      // البيئة كاملة عمداً (سلوك كل الطرفيات المدمجة: PATH وإعدادات المطور ضرورية) —
      // يعني أن مفاتيح API في بيئة «سطر» تصل للصدفة، وهي صدفة المستخدم نفسه بنفس صلاحياته.
      // PYTHONUTF8/PYTHONIOENCODING: تغذية راجعة 2026-08-24 — طباعة العربية من Python
      // تفشل بـcp1252 على ويندوز ما لم يُفعَّل وضع UTF-8. لا نطمس اختيار المستخدم إن ضبطه.
      env: Object.assign({}, process.env, {
        PYTHONUTF8: process.env.PYTHONUTF8 || '1',
        PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
      }),
      useConpty: true, // ConPTY — المتطلب الموثّق: ويندوز 10 1809+
    });
  } catch (e) {
    console.error('[term] فشل تشغيل الصدفة:', (e && e.message) || e);
    return { ok: false, error: 'spawn_failed', message: 'تعذّر تشغيل الصدفة — أعد المحاولة أو راجع سجل التشغيل.' };
  }

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

  // `launchedScript` يخبر المستدعي أن السكربت أُقلع مع الصدفة، فلا يكتب سطراً بعده.
  return { ok: true, id, shell, launchedScript };
}

// كتابة خام إلى pty — البيانات آمنة لأنها تذهب لمجرى الطرفية لا لوسائط spawn.
// تحقق دفاعي مكرر لتنقية main.js تحسّباً لإعادة هيكلة مستقبلية (مراجعة muraji-amn)
// ---------- OBS-106: الحركات الواصلة تسقط في PSReadLine القديم (مسار الإدخال) ----------
// القياس (‏`test:term-longline` مشهد 6): PSReadLine 2.0.0 المرافق لـWindows PowerShell 5.1
// يسقط علامات التشكيل الواصلة من **أحداث المفاتيح ومن اللصق المُقوّس معاً**، بينما يحفظها
// محرِّك سطر cmd وأي محرِّك بلا PSReadLine (قياس: إزالة الوحدة في نفس الجلسة أعادت الحركات)
// — فالمُسقط الوحدة لا ConPTY ولا نقلنا. والحل المعتمد: لصق PSReadLine ذاته يقرأ الحافظة
// **نصاً** فيحفظ الحركات، فنضع النص في الحافظة ونرسل Ctrl+V بدل الكتابة الخامة.
// قيود مقصودة: طرفيات المستخدم التفاعلية فقط (لا مهام خلفية ولا طرفيات النموذج — التلاعب
// بالحافظة من كتابة غير مرئية خطر)، وصدف PowerShell فقط، وسطر واحد (اللصق المتعدد
// الأسطر يبقى خاماً حفاظاً على تنفيذه سطراً سطراً)، وحافظة نصية فقط (غير ذلك ⇐ خام).
// حدّ معلَن: لو كان أمام المستخدم برنامج يقرأ الكونسول مباشرة (Python تفاعلي مثلاً) لا
// PSReadLine، فإن Ctrl+V قد لا يلصق — الكتابة الخامة كانت لتصل في تلك الحالة.
const COMBINING_MARK_RE = /[\u064B-\u0652\u0670]/;
const PASTE_KEY = '\x16'; // Ctrl+V — رُبط باللصق في مقدمة الإقلاع (PWSH_UTF8_PRELUDE)
const CLIPBOARD_RESTORE_MS = 500; // هامش أمان حتى تستهلك الصدفة الحافظة عند معالجة المفتاح

// حافظة Electron في العملية الرئيسية؛ وفي وضع node الصرف (الاختبارات) يقوم مقامها
// PowerShell بشقة STA (‏Windows.Forms لا يعمل بلا شقة أحادية).
let electronClipboard = null;
try {
  const electron = require('electron');
  if (electron && electron.clipboard) electronClipboard = electron.clipboard;
} catch (e) { /* مقصود: الاختبارات تأخذ مسار PowerShell أدناه */ }

// لقطة الحافظة إن كانت نصية فقط، وإلا null (يُكتفى عندها بالكتابة الخامة كالسابق).
function clipboardSnapshot() {
  if (electronClipboard) {
    try {
      const formats = electronClipboard.availableFormats() || [];
      const textOnly = formats.every((f) => f === 'text/plain' || f === 'text/plain;charset=utf-8');
      if (!textOnly) return null;
      const text = electronClipboard.readText();
      return {
        text,
        write: (s) => electronClipboard.writeText(s),
        clear: () => electronClipboard.clear(),
      };
    } catch (e) { return null; }
  }
  try {
    const { execFileSync } = require('child_process');
    const run = (script) => execFileSync('powershell.exe',
      ['-NoProfile', '-Sta', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    // GetDataObject() يعود null حين تكون الحافظة فارغة — تُعامل كقائمة صيغ فارغة
    const rawFormats = run('Add-Type -AssemblyName System.Windows.Forms; '
      + '$o = [Windows.Forms.Clipboard]::GetDataObject(); '
      + 'if ($o -eq $null) { "" } else { [string]::Join("|", $o.GetFormats()) }').trim();
    // «System.String» صيغة نصية يولّدها Set-Clipboard نفسه (.NET)
    const allowed = new Set(['', 'Text', 'UnicodeText', 'OEMText', 'Locale', 'System.String']);
    const list = rawFormats ? rawFormats.split('|') : [];
    if (!list.every((f) => allowed.has(f))) return null;
    // Out.Write لا يُلحق سطراً جديداً بعرض النص — Write-Output كان سيلصق CRLF بالمحتوى
    const text = run('Add-Type -AssemblyName System.Windows.Forms; '
      + '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
      + '[Console]::Out.Write([Windows.Forms.Clipboard]::GetText())');
    return {
      text,
      write: (s) => {
        // النص عربي: يمرّ عبر ملف مؤقت UTF-8 لا عبر سطر الأوامر حتى لا يُشوَّه
        const file = path.join(os.tmpdir(), 'satr-clip-' + process.pid + '-' + Date.now() + '.txt');
        fs.writeFileSync(file, s, 'utf8');
        run('Set-Clipboard -Value ([IO.File]::ReadAllText("' + file.replace(/\\/g, '\\\\') + '", [Text.Encoding]::UTF8))');
        try { fs.unlinkSync(file); } catch (e) {}
      },
      clear: () => run('Set-Clipboard -Value $null'),
    };
  } catch (e) { return null; }
}

// إن انطبقت شروط العطل كلها: اكتب باللصق عبر الحافظة وأرجع النتيجة، وإلا أرجع null
// لتعني «اكتب خاماً كما كانت». الاستهلاك متزامن داخل PSReadLine عند معالجة Ctrl+V،
// فنُرجع محتوى الحافظة السابق بعد هامش أمان.
function clusterPasteWrite(t, data) {
  if (!IS_WIN) return null;
  if (t.isJob || t.isModel) return null; // لا تلاعب بالحافظة من كتابة غير مرئية
  const shell = String(t.shell || '').toLowerCase();
  if (!shell.includes('powershell') && !shell.includes('pwsh')) return null;
  if (!COMBINING_MARK_RE.test(data)) return null;
  const CR = data.slice(-1) === '\r' ? '\r' : '';
  const body = CR ? data.slice(0, -1) : data;
  if (!body.length || /[\r\n]/.test(body)) return null; // متعدد الأسطر يبقى خاماً
  const clip = clipboardSnapshot();
  if (!clip) return null;
  const saved = clip.text;
  try { clip.write(body); } catch (e) { return null; }
  try { t.proc.write(PASTE_KEY + CR); }
  catch (e) {
    try { if (saved) clip.write(saved); else clip.clear(); } catch (_) {}
    return { ok: false, error: 'write_failed' };
  }
  setTimeout(() => {
    try { if (saved) clip.write(saved); else clip.clear(); } catch (e) {}
  }, CLIPBOARD_RESTORE_MS).unref();
  return { ok: true };
}

/**
 * كتابة سطر أمر باللصق المُقوّس (bracketed paste) — PSReadLine يعالج المحتوى وحدةً
 * واحدة بلا إعادة رسم ولا إسقاط محارف (تحقق قبول 16.1: الحقن الخام يُسقط محارف
 * السطر الطويل).
 *
 * **استُخرجت لأن `runCapture` وحده كان يستعملها** بينما `termjobs.startJob`
 * (‏`run_in_background`) يكتب خاماً عبر `writeTerm`. والنتيجة مرصودة حياً: أمر تباعد
 * طويل تجاوز ما تتحمله PowerShell، فتعطّل PSReadLine وبقيت القشرة عند `>>` والمهمة
 * تبدو حيّة بلا عمل. أي أن الحماية كانت في الملف نفسه ولا تصل نصف مستعمليها.
 */
function writePasted(t, line) {
  // OBS-106: الحركات الواصلة تسقط حتى داخل اللصق المُقوّس — نفس علاج writeTerm
  const pasted = clusterPasteWrite(t, line);
  if (pasted) return pasted.ok;
  const CR = line.slice(-1) === '\r' ? '\r' : '';
  const body = CR ? line.slice(0, -1) : line;
  try { t.proc.write('\x1b[200~' + body + '\x1b[201~' + CR); return true; }
  catch (e) { return false; }
}

/** نظير `writeTerm` لكن باللصق المُقوّس — لسطر أمر كامل لا لإدخال المستخدم الحرفي. */
function writeTermPasted(id, data) {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: 'no_term' };
  if (typeof data !== 'string' || !data.length || data.length > 1024 * 1024) {
    return { ok: false, error: 'bad_data' };
  }
  return writePasted(t, data) ? { ok: true } : { ok: false, error: 'write_failed' };
}

function writeTerm(id, data) {
  const t = terminals.get(id);
  if (!t) return { ok: false, error: 'no_term' };
  if (typeof data !== 'string' || !data.length || data.length > 1024 * 1024)
    return { ok: false, error: 'bad_data' };
  // OBS-106: الحركات الواصلة تسقط في PSReadLine القديم — لصق عبر الحافظة عند انطباق الشروط
  const pasted = clusterPasteWrite(t, data);
  if (pasted) return pasted;
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
  const start = Math.max(0, t.buffer.length - wanted);
  if (start === 0) return { ok: true, data: t.buffer.toString('utf8'), truncated: false };

  // القصّ الخام كان يرتكب خطأين صامتين معاً (مرصودان حياً في جولة تباعد):
  // (1) يشطر محرفاً عربياً متعدد البايتات فيبدأ الخرج بمحرف تالف؛
  // (2) يقطع السطر الأول في منتصفه بلا أي علامة، فيبدو **كاملاً** وهو ليس كذلك —
  //     وخرج JSON طويل يفقد غلافه الافتتاحي فيستحيل التحقق منه («لم يظهر مفتاح frame»).
  // العلاج: محاذاة الحدّ إلى بداية محرف UTF-8، ثم إسقاط بقية السطر الجزئي، ثم **إعلان**
  // القصّ صراحةً بدل تمرير كسرٍ يُقرأ سلامةً.
  let cut = start;
  while (cut < t.buffer.length && (t.buffer[cut] & 0xC0) === 0x80) cut++; // تخطَّ بايتات الاستمرار
  let text = t.buffer.subarray(cut).toString('utf8');
  const newline = text.indexOf('\n');
  if (newline >= 0 && newline < text.length - 1) text = text.slice(newline + 1);
  const droppedBytes = t.buffer.length - Buffer.byteLength(text, 'utf8');
  return {
    ok: true,
    truncated: true,
    droppedBytes,
    data: '[قُصّ ' + droppedBytes + ' بايت من بداية السجل — هذا ذيله لا كامله]\n' + text,
  };
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

const MAX_SCRIPT_CHARS = 8000; // مطابق لسقف sanitizeCommand عمداً

/**
 * نظير `sanitizeCommand` لكنه **يحفظ الأسطر الجديدة** — لمسار المهام الذي يمرّر النصّ
 * في وسائط spawn لا في سطر الطرفية، فلا يلزمه سطر واحد.
 *
 * **العلّة الجذرية في OBS-065، مقيسة**: `sanitizeCommand` يحذف `\n` (ضمن الصنف
 * `[\x00-\x08\x0A-\x1F…]`) **بلا بديل**، فأمرٌ متعدد الأسطر تلتصق جُمله:
 *     `$b = @'⏎نص⏎'@⏎Write-Output 'x'`  ⟶  `$b = @'نص'@Write-Output 'x'`
 * والناتج **جملة غير مكتملة**، وهي المعنى الوحيد لمِحَثّ `>>` الذي عَلِقت عنده المهمة
 * في البلاغ. أي أن العطل لم يكن طولاً بل إفساداً صامتاً — والطول كان تفسير الوكيل
 * لنفسه لا قياساً (سُبر: 7986 محرفاً وصلت سليمة بالكتابة الخام).
 *
 * يبقى `\t` و`\n` وحدهما من محارف التحكم، وتُوحَّد `\r\n`/`\r` إلى `\n`.
 * `sanitizeCommand` **لم يُلمَس** لأن `runCaptureNow` يوجب سطراً واحداً بنيوياً
 * (بروتوكول علامتَي البداية/النهاية).
 */
function sanitizeScript(cmd) {
  if (typeof cmd !== 'string') return '';
  return cmd
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .slice(0, MAX_SCRIPT_CHARS);
}

/** اقتباس نصّ داخل سلسلة PowerShell أحادية الاقتباس (تضعيف `'` هو القاعدة الوحيدة). */
function pwshSingleQuote(text) { return "'" + String(text).replace(/'/g, "''") + "'"; }

/**
 * شكل بنيوي لنصّ أمر — أرقام محضة بلا أي محتوى.
 *
 * **لماذا هي هنا ومن يستدعيها**: خرجت من جولة قرار (‏2026-08-28) رُفض فيها بناء سجلٍّ
 * دائم لتيار تفكير الوكيل. الاعتراض القاتل أن الفرق البنيوي بين «ما طلبه النموذج» و«ما
 * سُلِّم للصدفة» **ليس صفراً في المسار السليم**: الغلاف يضيف أسطراً بالتصميم، وفرع
 * `sanitizeCommand` يحذفها بالتصميم — فأرضية الضجيج تساوي الإشارة، ويصير السجل تسجيلاً
 * لتحويل معلَن على أنه شذوذ. والقيمة الحقيقية أن **يُثبَّت التحويل المعلَن نفسه ثابتاً
 * في الحارس**، فيسقط أي انحراف مستقبلي في `test:full` قبل الشحن بدل أن يُقرأ في سجلٍّ
 * على قرص المستخدم بعد أن تعلق مهمته.
 *
 * لذلك: **لا مستدعي لها في مسار الإنتاج** — `scripts/term-longline-test.js` وحده.
 * ولا تُكتب نتيجتها إلى قرص ولا تعبر أي عقد. `bytes` بايتات UTF-8 حقيقية لأن سقوف
 * القصّ تعمل بوحدات UTF-16 والأمر العربي يضاعف البايتات، فالوحدتان لا تتطابقان.
 */
function structuralShape(text) {
  const s = typeof text === 'string' ? text : '';
  return {
    bytes: Buffer.byteLength(s, 'utf8'),
    newlines: (s.match(/\n/g) || []).length,
    singleQuotes: (s.match(/'/g) || []).length,
    doubleQuotes: (s.match(/"/g) || []).length,
  };
}

/** فرق الشكلين — موجب يعني زيادة في `after`. دالة نقية بلا أثر جانبي. */
function structuralDelta(before, after) {
  const a = structuralShape(before);
  const b = structuralShape(after);
  return {
    bytes: b.bytes - a.bytes,
    newlines: b.newlines - a.newlines,
    singleQuotes: b.singleQuotes - a.singleQuotes,
    doubleQuotes: b.doubleQuotes - a.doubleQuotes,
  };
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
      // رمز الخروج رقمي دائماً. تصحيح 2026-08-24 (تغذية راجعة «exit 0 رغم خطأ الأمر»):
      // التصفير كان `=0` فيبقى $LASTEXITCODE رقماً حتى حين يفشل cmdlet لا يضبطه أصلاً،
      // فلا يُستشار $? أبداً ويُعلَن نجاح كاذب. صار التصفير $null، و$? يُلتقط **فور**
      // الأمر (كان يُقرأ بعد إسناد فيصف نجاح الإسناد لا الأمر — نمط termjobs.js المثبت).
      // الأولوية لـ$LASTEXITCODE حين يكون رقماً: أمر أصلي رمزه هو الحقيقة، فلا ينقلب
      // نجاح `... 2>&1` إلى فشل بسبب NativeCommandError الذي يضبط $?=false في PS 5.1.
      line = '$global:LASTEXITCODE=$null; Write-Output "' + mBeg + '"; ' + clean +
        ' ; $ok=$?; $c=$LASTEXITCODE; if($null -eq $c){$c=if($ok){0}else{1}}' +
        '; Write-Output ("' + mEnd + ':"+$c+":"+$(if($ok){1}else{0}))\r';
    } else if (sh.includes('cmd')) {
      line = 'echo ' + mBeg + ' & ' + clean + ' & echo ' + mEnd + ':%ERRORLEVEL%\r';
    } else {
      line = 'printf "%s\\n" "' + mBeg + '"; ' + clean + ' ; printf "%s:%s\\n" "' + mEnd + '" "$?"\r';
    }

    // المجموعة الثانية اختيارية: صدف cmd/sh لا تُصدر علم $? فيبقى النمط القديم صالحاً
    const endRe = new RegExp(mEnd + ':(-?\\d+)(?::([01]))?'); // اكتمال + رمز الخروج + علم الصدفة
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
      if (m) {
        const exitCode = parseInt(m[1], 10);
        // الصدفة أبلغت فشلاً بينما رمز الخروج 0 (شائع حين يطبع أمر أصلي خطأً على
        // stderr ثم يخرج بنجاح): لا نكذّب رمزه ولا نخفي إشارته — نعيد الاثنين.
        const shellFailed = m[2] === '0' && exitCode === 0;
        finish({ ok: true, exitCode, shellFailed, output: cleanOutput(buf.slice(0, m.index)) });
      }
    });

    timer = setTimeout(() => {
      finish({ ok: true, timedOut: true, exitCode: null, output: cleanOutput(buf),
        note: 'انتهت المهلة (' + Math.round(timeoutMs / 1000) + 'ث) — قد يكون أمراً تفاعلياً أو طويلاً؛ الخرج حتى الآن أعلاه.' });
    }, timeoutMs);

    if (!writePasted(t, line)) {
      finish({ ok: false, error: 'write_failed', message: 'تعذّرت الكتابة للطرفية.' });
    }
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
  setNotifier, subscribe, startTerm, writeTerm, writeTermPasted, resizeTerm, killTerm, listTerms, readBuffer,
  sanitizeCommand, sanitizeScript, pwshSingleQuote, defaultShell,
  structuralShape, structuralDelta,
  runCapture, ensureModelTerm, getModelTermId, killAll,
};
