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
    writeChains.delete(id);
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

// ---------- OBS-121 + OBS-095: عقد حافظة واحد يعمل على Electron 33 و44 معاً ----------
// قياس حيّ (2026-09-05، مسابير هذه الدفعة على 33.4.11 و44.2.0 معاً): حافظة Electron 44
// **ليست** حافظة 33 بحقلٍ ناقص، بل واجهة أخرى بالكامل. المُعلَن عليها ستّ دوال فقط:
// `clear · has · read · readText · write · writeText`؛ وذهب معها `availableFormats` و
// `readHTML/writeHTML` و`readImage/writeImage` و`readRTF` و`readBuffer/writeBuffer` و
// `readBookmark`. لذلك «توسيع الحفظ والاستعادة إلى HTML والصورة» — أحد مرشّحي علاج
// `OBS-121` — **متعذّر على الهدف** لا مؤجَّل. وصارت `readText/writeText` تعيدان وعوداً،
// بينما بقيت `clear` متزامنة تعيد undefined.
//
// البديل المقيس لـ`availableFormats` هو `read()` القياسية: تعيد `ClipboardItem[]` ولكل
// عنصر `types` بصيغ MIME. المرصود حرفياً على 44:
//   نصّ صرف   → ["text/plain", …ضوضاء…]
//   HTML وحده → ["text/html", …ضوضاء…]              (و`readText()` تعيد "")
//   نصّ+HTML  → ["text/plain","text/html", …ضوضاء…]   ← الحالة الغالبة من متصفح
//   صورة      → ["image/png", …ضوضاء…]
//   فارغة     → …ضوضاء… وحدها
// و«الضوضاء» مدخلان يظهران على **كل** حافظة بما فيها الفارغة:
//   electron application/osclipboard;format="DataObject"
//   electron application/osclipboard;format="Ole Private Data"
// فقائمةُ سماحٍ تشترط أن يكون كل مدخل نصّاً كانت سترفض كل حافظة على 44 — لذا يُستثنيان
// بالاسم، وأي `osclipboard` **آخر** يعني حمولةً لا نعرفها فيُرفض المسار (فشل مغلق).
// ولو أضاف إصدارٌ لاحق ضوضاء عامة ثالثة لصار الرفض دائماً: تدهورٌ **معلَن** بالإشعار
// أدناه لا إتلافٌ صامت — وهذا هو الاتجاه الصحيح للفشل.
//
// وفرقٌ يستحق التسجيل: 44 هنا **أصدق** من 33. حافظةٌ فيها صيغة خاصة وحدها
// (‏`SatrPrivateFormat` في المسبار) يراها 44 ‏`osclipboard;format="SatrPrivateFormat"`
// فنرفض، بينما `availableFormats()` على 33 تعيد `[]` — أي «فارغة» — فنكتب فوقها.
// وكذلك `Chromium internal source URL`: يراه 44 ولا يراه 33. هذا **حدّ قائم في 33 لم
// تُحدثه هذه الدفعة ولم تُزله**، ومصرَّح به.
const OSCLIP_PREFIX = 'electron application/osclipboard;format=';
// المدخلان المرصودان على حافظة **فارغة** — أي أنهما وصف الغلاف لا محتوى المستخدم
const OSCLIP_UNIVERSAL = new Set([
  OSCLIP_PREFIX + '"DataObject"',
  OSCLIP_PREFIX + '"Ole Private Data"',
]);
const PLAIN_TEXT_TYPES = new Set(['text/plain', 'text/plain;charset=utf-8']);

// الدلالة محفوظة من قبل الدفعة: قائمة فارغة (حافظة فارغة) تُعدّ آمنة، وأي صيغة غير
// نصية تُبطل المسار. الجديد وحده استثناء ضوضاء 44 ورفض ما عداها.
function formatsAreTextOnly(formats) {
  for (const f of formats) {
    if (PLAIN_TEXT_TYPES.has(f)) continue;
    if (OSCLIP_UNIVERSAL.has(f)) continue;
    return false;
  }
  return true;
}

// سلّم قدرات صريح لا افتراض إصدار: `availableFormats` موجودة على 33 وغائبة على 44،
// فحضورها وحده يفصل المسارين. و`read` موجودة في الاثنين **بدلالتين متنافرتين**
// (‏33: `read(format)` تقرأ صيغة مخصّصة نصّاً · 44: `read()` تعيد ClipboardItem[])،
// لذلك لا تُستعمل إلا بعد أن يثبت غياب `availableFormats`، ومع فحص أَرِيَّتها وشكل ناتجها.
async function electronClipboardFormats(clip) {
  if (!clip) return null;
  if (typeof clip.availableFormats === 'function') {
    const formats = clip.availableFormats();
    return Array.isArray(formats) ? formats : [];
  }
  if (typeof clip.read === 'function' && clip.read.length === 0) {
    const items = await clip.read();
    if (!Array.isArray(items)) return null; // شكل غير متوقَّع ⇒ فشل مغلق
    const types = [];
    for (const item of items) {
      const list = item && item.types;
      if (!Array.isArray(list)) return null;
      for (const type of list) types.push(String(type));
    }
    return types;
  }
  return null; // واجهة لا نعرفها ⇒ لا نلمس الحافظة
}

// لقطة الحافظة إن كانت نصية فقط، وإلا null (يُكتفى عندها بالكتابة الخامة كالسابق).
// صارت **غير متزامنة** لأن نصف عملياتها وعودٌ على 44؛ و`await` على قيمة غير وعد يمرّرها
// كما هي، فمسار 33 المتزامن ومسار PowerShell يعملان داخلها بلا فرع ثانٍ.
async function clipboardSnapshot() {
  if (electronClipboard) {
    try {
      const formats = await electronClipboardFormats(electronClipboard);
      if (!formats) return null;
      if (!formatsAreTextOnly(formats)) return null;
      const text = await electronClipboard.readText(); // 33: نصّ · 44: وعد
      return {
        text: typeof text === 'string' ? text : '',
        write: (s) => electronClipboard.writeText(s),   // يُنتظر عند الاستدعاء
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

// ---------- إعلان التدهور (جوهر `OBS-121`) ----------
// الاحتراز سليم: لا نُتلف حافظة المستخدم لنكتب سطراً. العطل أنه **صامت** — المستخدم
// ينسخ من متصفح (الحالة الغالبة: `text/plain + text/html`)، ثم يكتب عربية مشكَّلة،
// فيفقد التشكيل بلا إشارة. والعقد القائم في المستودع يوجب إعلان التدهور: `readBuffer`
// يعلن `truncated`، و`browser_readability` تعلن `unseen`.
//
// المركبة `data` على قناة `satr:term` القائمة **عمداً**: `main.js` يمرّر أي حدث طرفية
// كما هو، لكن `terminal-panel.js` لا يعالج إلا `data` و`exit` — فنوعٌ جديد كان سيمرّ
// **ويُتجاهَل صامتاً**، أي الصمتُ نفسه بثوب آخر. والنصّ يظهر حيث المستخدم يعمل.
// ولا يبلغ سجلّ مهمة ولا التقاطاً: المسار محصور بالطرفيات التفاعلية (`!isJob && !isModel`).
//
// **مرة واحدة لكل تشغيل** لا لكل لصقة: إشعارٌ يتكرر مع كل سطر عربي مشكَّل عطلٌ آخر.
// الرأس عقدٌ **مصدَّر** لا صياغةٌ حرّة: الحارس يرصد الإعلان به بدل أن يكرّر نصّه، فلا
// يتباعد الاثنان ولا يتحوّل تحسينُ الصياغة إلى كسر حارس.
const CLIPBOARD_DEGRADE_MARK = 'تعذّر حفظ التشكيل';
let degradeNoticeShown = false;
function announceClipboardDegrade(t) {
  if (degradeNoticeShown) return false;
  degradeNoticeShown = true;
  const text = '\r\n\x1b[33m⚠ ' + CLIPBOARD_DEGRADE_MARK + ': حافظتك تحمل محتوى غير نصّي '
    + '(صورة أو نصّاً منسّقاً من متصفح)، و«سطر» لا يستبدلها لئلّا يُتلفها.\r\n'
    + '  انسخ نصّاً عادياً — أو أفرغ الحافظة — ثم أعد الإدخال إن لزمك التشكيل.\x1b[0m\r\n';
  appendBuffer(t, text);
  emit({ type: 'data', id: t.id, data: text });
  return true;
}

// ---------- طابور كتابة لكل طرفية (لازمٌ لأن مسار الحافظة صار غير متزامن) ----------
// على 44 يفصل بين قرار الحافظة وكتابة Ctrl+V دورةُ حدثٍ واحدة على الأقل. فبلا طابور
// قد تسبق كتابةٌ خامّةٌ لاحقة (‏Ctrl+C مثلاً) لصقةً معلّقة، فينقلب ترتيب إدخال المستخدم —
// وذاك عطلٌ أسوأ من العطل المُعالَج. المدخل يُحذف عند تفريغ سلسلته كي تعود الكتابات
// اللاحقة إلى المسار المتزامن المباشر بلا تأجيل دائم.
const writeChains = new Map();
function enqueueWrite(t, fn) {
  const previous = writeChains.get(t.id) || Promise.resolve();
  const next = previous.then(fn, fn).catch(() => {});
  writeChains.set(t.id, next);
  next.then(() => { if (writeChains.get(t.id) === next) writeChains.delete(t.id); });
  return next;
}

// البوابة المتزامنة: هل ينطبق علاج OBS-106 على هذه الكتابة أصلاً؟ تعيد الجسم و`\r`
// الختامي، أو null بمعنى «اكتب خاماً كما كانت». فُصلت عن التنفيذ كي يبقى **قرار المسار**
// متزامناً (يحتاجه `writeTerm`/`writePasted` لعقدهما) بينما ينتظر التنفيذُ الحافظة.
function clusterPasteParts(t, data) {
  if (!IS_WIN) return null;
  if (t.isJob || t.isModel) return null; // لا تلاعب بالحافظة من كتابة غير مرئية
  const shell = String(t.shell || '').toLowerCase();
  if (!shell.includes('powershell') && !shell.includes('pwsh')) return null;
  if (!COMBINING_MARK_RE.test(data)) return null;
  const CR = data.slice(-1) === '\r' ? '\r' : '';
  const body = CR ? data.slice(0, -1) : data;
  if (!body.length || /[\r\n]/.test(body)) return null; // متعدد الأسطر يبقى خاماً
  return { body, CR };
}

function rawWrite(t, data) {
  try { t.proc.write(data); } catch (e) { return { ok: false, error: 'write_failed' }; }
  return { ok: true };
}

// التنفيذ غير المتزامن: لقطة الحافظة ⇐ لصق ⇐ استعادة. تعذُّر اللقطة **لا يُسقط الإدخال**؛
// يعود إلى الكتابة الخامة (سلوك ما قبل الدفعة حرفياً) ويُعلن التدهور مرّة.
async function clusterPasteWrite(t, data, parts) {
  const { body, CR } = parts;
  const clip = await clipboardSnapshot();
  if (!clip) {
    announceClipboardDegrade(t);
    return rawWrite(t, data);
  }
  const saved = clip.text;
  const restore = () => {
    try { return Promise.resolve(saved ? clip.write(saved) : clip.clear()).catch(() => {}); }
    catch (e) { return Promise.resolve(); }
  };
  try { await clip.write(body); } catch (e) { return rawWrite(t, data); }
  try { t.proc.write(PASTE_KEY + CR); }
  catch (e) {
    await restore();
    return { ok: false, error: 'write_failed' };
  }
  // الاستهلاك متزامن داخل PSReadLine عند معالجة Ctrl+V، فنُرجع السابق بعد هامش أمان.
  setTimeout(restore, CLIPBOARD_RESTORE_MS).unref();
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
  // OBS-106: الحركات الواصلة تسقط حتى داخل اللصق المُقوّس — نفس علاج writeTerm.
  // العقد هنا **متزامن ولا يتغيّر**: `runCaptureNow` يقرأ هذا المنطقي ليعلن
  // `write_failed`. ولمّا صار مسار الحافظة غير متزامن يُقبل الطلب بـtrue ويُنفَّذ في
  // الطابور — وهو مأمون هنا لأن `runCapture` كله على طرفية النموذج (`isModel`)
  // فتردّ `clusterPasteParts` بـnull ويبقى مسار الالتقاط متزامناً حرفياً كما كان.
  const parts = clusterPasteParts(t, line);
  if (parts) { enqueueWrite(t, () => clusterPasteWrite(t, line, parts)); return true; }
  const CR = line.slice(-1) === '\r' ? '\r' : '';
  const body = CR ? line.slice(0, -1) : line;
  const bracketed = '\x1b[200~' + body + '\x1b[201~' + CR;
  // إن كان للطرفية طابور معلّق فحتى الكتابة الخامة تدخله، وإلا سبقت لصقةً قبلها
  if (writeChains.has(t.id)) { enqueueWrite(t, () => rawWrite(t, bracketed)); return true; }
  try { t.proc.write(bracketed); return true; }
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
  // OBS-106: الحركات الواصلة تسقط في PSReadLine القديم — لصق عبر الحافظة عند انطباق الشروط.
  // `{ok:true}` هنا تعني «قُبِلت الكتابة» لا «استهلكتها الصدفة» — وهي دلالتها قبل الدفعة
  // أيضاً (‏`proc.write` يعود قبل أن تعالج الصدفة شيئاً). فشل الحافظة داخل الطابور يعود
  // إلى الكتابة الخامة فلا يضيع إدخال المستخدم في أي حال.
  const parts = clusterPasteParts(t, data);
  if (parts) { enqueueWrite(t, () => clusterPasteWrite(t, data, parts)); return { ok: true }; }
  // الترتيب أولاً: كتابة خامة تسبق لصقةً معلّقة تقلب إدخال المستخدم (‏Ctrl+C مثلاً)
  if (writeChains.has(t.id)) { enqueueWrite(t, () => rawWrite(t, data)); return { ok: true }; }
  return rawWrite(t, data);
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
  writeChains.delete(id);
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

/**
 * بناء سطر الالتقاط لفرع صدفة — مُستخرج **دالة نقية** (‏OBS-072) كي يُختبر منطق
 * البروتوكول بلا pty (لا لينكس على جهاز التطوير؛ القياس الحيّ يبقى للبوابة).
 * يلتزم كل فرع بالعقد نفسه: علامة بداية سطر مستقل، ثم الأمر، ثم علامة نهاية
 * بثلاثة حقول `END:<رمز>:<علم>` — رمز خروج رقمي دائماً + علم الصدفة.
 * السطر المُعاد يشمل `\r` الختامي كما كان يُبنى داخلياً (‏writePasted يعيده خارج
 * علامتَي اللصق)، فمسار PowerShell المثبَّت في العقود يبقى **بايتاً ببايت**.
 */
function buildCaptureLine(shell, mBeg, mEnd, clean) {
  const sh = (shell || '').toLowerCase();
  if (sh.includes('powershell') || sh.includes('pwsh')) {
    // رمز الخروج رقمي دائماً. تصحيح 2026-08-24 (تغذية راجعة «exit 0 رغم خطأ الأمر»):
    // التصفير كان `=0` فيبقى $LASTEXITCODE رقماً حتى حين يفشل cmdlet لا يضبطه أصلاً،
    // فلا يُستشار $? أبداً ويُعلَن نجاح كاذب. صار التصفير $null، و$? يُلتقط **فور**
    // الأمر (كان يُقرأ بعد إسناد فيصف نجاح الإسناد لا الأمر — نمط termjobs.js المثبت).
    // الأولوية لـ$LASTEXITCODE حين يكون رقماً: أمر أصلي رمزه هو الحقيقة، فلا ينقلب
    // نجاح `... 2>&1` إلى فشل بسبب NativeCommandError الذي يضبط $?=false في PS 5.1.
    return '$global:LASTEXITCODE=$null; Write-Output "' + mBeg + '"; ' + clean +
      ' ; $ok=$?; $c=$LASTEXITCODE; if($null -eq $c){$c=if($ok){0}else{1}}' +
      '; Write-Output ("' + mEnd + ':"+$c+":"+$(if($ok){1}else{0}))\r';
  }
  if (sh.includes('cmd')) {
    return 'echo ' + mBeg + ' & ' + clean + ' & echo ' + mEnd + ':%ERRORLEVEL%\r';
  }
  // POSIX (sh/bash — OBS-072): لا نسخة Cmdlet/أصلي منفصلة في $? كما في PowerShell،
  // فالالتقاط الفوري في متغيّر `c=$?` دفاعٌ ضد أوامر تنتهي بـ`&` تُطلق خلفياً وتصفّر
  // $? قبل أن يُقرأ، والعلم يُشتق حسابياً من الرمز — بقاء الحقل الثالث موحّداً مع
  // PowerShell يصل كشف «فشل الصدفة مع رمز خروج 0» (‏shellFailed) بكل الصدفات.
  return 'printf "%s\\n" "' + mBeg + '"; ' + clean +
    ' ; c=$?; printf "%s:%s:%s\\n" "' + mEnd + '" "$c" "$(($c == 0))"\r';
}

/**
 * مطابقة علامة النهاية في مخزن خام — مُستخرجة **دالة نقية** (‏OBS-072). تحت POSIX
 * تُقيَّد العلامة ببداية سطر كي لا يُطابق صدًى ملتفّ أو خرج أمرٍ يتضمّن نصّها: إنهاء
 * مبكّر كاذب كان يجعل النداء اللاحق يتسرّب إلى خرج سابق (تشابك النداءين). المجموعة
 * الثالثة اختيارية: النمط القديم بلا علم (‏cmd وصدفات سابقة) يبقى مقبولاً — لا نعرف
 * أي صدفة على جهاز المستخدم. تُعيد موضع المطابقة ورمز الخروج وعلم الفشل، أو null.
 */
function matchCaptureEnd(buf, mEnd, isPosix) {
  const re = isPosix
    ? new RegExp('(?:^|\\n)' + mEnd + ':(-?\\d+)(?::([01]))?')
    : new RegExp(mEnd + ':(-?\\d+)(?::([01]))?');
  const m = String(buf || '').match(re);
  if (!m) return null;
  const exitCode = parseInt(m[1], 10);
  return { index: m.index, exitCode, shellFailed: m[2] === '0' && exitCode === 0 };
}

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
    const isPosix = !sh.includes('powershell') && !sh.includes('pwsh') && !sh.includes('cmd');
    const line = buildCaptureLine(t.shell, mBeg, mEnd, clean);

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
      const m = matchCaptureEnd(buf, mEnd, isPosix);
      if (m) {
        // الصدفة أبلغت فشلاً بينما رمز الخروج 0 (شائع حين يطبع أمر أصلي خطأً على
        // stderr ثم يخرج بنجاح): لا نكذّب رمزه ولا نخفي إشارته — نعيد الاثنين.
        finish({ ok: true, exitCode: m.exitCode, shellFailed: m.shellFailed, output: cleanOutput(buf.slice(0, m.index)) });
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
  writeChains.clear();
  modelTermId = null;
}

module.exports = {
  MAX_TERMS, MAX_BUFFER_BYTES,
  setNotifier, subscribe, startTerm, writeTerm, writeTermPasted, resizeTerm, killTerm, listTerms, readBuffer,
  sanitizeCommand, sanitizeScript, pwshSingleQuote, defaultShell,
  structuralShape, structuralDelta,
  buildCaptureLine, matchCaptureEnd,
  runCapture, ensureModelTerm, getModelTermId, killAll,
  // OBS-121/OBS-095: عقد الحافظة عبر الإصدارين — نقيّان يُختبران بلا Electron ولا حافظة
  formatsAreTextOnly, electronClipboardFormats, CLIPBOARD_DEGRADE_MARK,
};
