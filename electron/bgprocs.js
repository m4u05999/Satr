/**
 * سطر 2.0 — متتبّع عمليات الخلفية المعمّرة
 *
 * المشكلة (انظر تشخيص الدور): خادم تطوير طويل العمر (`npm run dev`) تشغّله أداة Bash
 * بـ run_in_background يبقى حيّاً بعد انتهاء دور النموذج. الـ SDK لا يكشف للمضيف أي
 * مقبض لعمليات تُشغّلها الأدوات (واجهة Query تعطي interrupt فقط، لا PID ولا قتل shell)،
 * وعند نهاية الدور يخرج claude.exe فينكسر رابط الأب ونفقد كل أثر للخادم.
 *
 * الحل: نتعقّب العمليات بأنفسنا على مستوى النظام بينما شجرة claude.exe ما زالت سليمة.
 * نلتقط أحفاد عملية «سطر» قبل أمر الخلفية وبعده، والفرق = الـ PIDs التي ولّدها — نسجّلها
 * فتعيش بعد الدور. الـ PID يبقى قابلاً للقتل ما دامت العملية حيّة مهما خرج أبوها.
 *
 * السجلّ يعيش في العملية الرئيسية (مستقل عن الدور)، فيستطيع المستخدم إنهاء الخادم
 * من شريط «عمليات قيد التشغيل» حتى بعد اختفاء زرّ الإيقاف.
 */

const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

// السجلّ: id داخلي فريد → { id, command, pids:Set<number>, startedAt }
const registry = new Map();
const pendingBefore = new Map(); // tool_use_id → Set<pid> (لقطة ما قبل أمر الخلفية)
let seq = 0;
let notifier = null; // يضبطها main.js لبثّ التغيّر للواجهة
let pruneTimer = null;

// الواجهة تتلقّى نسخة مبسّطة (بلا الـ PIDs الخام)
function snapshotForUi() {
  const out = [];
  for (const e of registry.values()) {
    out.push({ id: e.id, command: e.command, count: e.pids.size, startedAt: e.startedAt });
  }
  return out;
}

function setNotifier(fn) { notifier = fn; }
function notify() { if (notifier) { try { notifier(snapshotForUi()); } catch (e) { /* لا نكسر التتبّع */ } } }

// جدول العمليات: pid → ppid لكل النظام. يعيد Map أو null عند الفشل.
function procTable() {
  return new Promise((resolve) => {
    let cmd, args;
    if (IS_WIN) {
      cmd = 'powershell';
      args = ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'];
    } else {
      cmd = 'ps'; args = ['-e', '-o', 'pid=,ppid='];
    }
    let out = '';
    try {
      const ch = spawn(cmd, args, { windowsHide: true });
      ch.stdout.on('data', (d) => (out += d.toString('utf8')));
      ch.on('error', () => resolve(null));
      ch.on('close', () => {
        const table = new Map();
        for (const line of out.split(/\r?\n/)) {
          const m = line.trim().match(/^(\d+)\s+(\d+)$/);
          if (m) table.set(Number(m[1]), Number(m[2]));
        }
        resolve(table.size ? table : null);
      });
    } catch { resolve(null); }
  });
}

// مجموعة كل أحفاد rootPid (نزولاً) في الجدول الحالي.
async function descendants(rootPid) {
  const table = await procTable();
  if (!table) return null;
  const childrenOf = new Map();
  for (const [pid, ppid] of table) {
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  const out = new Set();
  const stack = [rootPid];
  while (stack.length) {
    for (const c of (childrenOf.get(stack.pop()) || [])) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

// هل العملية حيّة؟ الإشارة 0 لا تقتل، فقط تتحقق من الوجود.
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // EPERM = موجودة لكن لا صلاحية ⇐ حيّة
}

function killPid(pid) {
  if (IS_WIN) {
    // taskkill /T ينهي الشجرة كاملة نزولاً (الخادم + أحفاده) بلا حدث كونسول يصعد لـ«سطر»
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {}); }
    catch (e) { /* العملية قد تكون ماتت */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  }
}

// يُستدعى من خطّاف PreToolUse قبل أمر Bash خلفي: لقطة الأحفاد الحالية.
async function markBefore(toolUseId) {
  const before = await descendants(process.pid);
  if (before) pendingBefore.set(toolUseId, before);
}

// يُستدعى من خطّاف PostToolUse بعد أمر Bash خلفي: الفرق = عمليات الأمر الجديدة.
async function markAfter(toolUseId, command) {
  const before = pendingBefore.get(toolUseId);
  pendingBefore.delete(toolUseId);
  const after = await descendants(process.pid);
  if (!before || !after) return; // فشل التعداد ⇐ لا نسجّل (لا نملك PIDs نقتلها)
  const pids = new Set();
  for (const pid of after) if (!before.has(pid) && alive(pid)) pids.add(pid);
  if (!pids.size) return; // لم تنشأ عملية معمّرة (أمر سريع انتهى)
  const id = 'bg_' + (++seq);
  registry.set(id, { id, command: String(command || '').slice(0, 500), pids, startedAt: Date.now() });
  ensurePruneTimer();
  notify();
}

// يُسقط الـ PIDs الميتة وأي مدخل لم يبقَ فيه حيّ. يعيد true إن تغيّر شيء.
function prune() {
  let changed = false;
  for (const [id, e] of registry) {
    for (const pid of e.pids) if (!alive(pid)) { e.pids.delete(pid); changed = true; }
    if (!e.pids.size) { registry.delete(id); changed = true; }
  }
  if (!registry.size && pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  return changed;
}

// مؤقّت خفيف يكتشف خروج الخادم وحده (المستخدم أوقفه من الطرفية مثلاً) فيُحدّث الشريط.
function ensurePruneTimer() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => { if (prune()) notify(); }, 4000);
  if (pruneTimer.unref) pruneTimer.unref();
}

function list() { prune(); return snapshotForUi(); }

function kill(id) {
  const e = registry.get(id);
  if (!e) return { ok: false };
  for (const pid of e.pids) killPid(pid);
  registry.delete(id);
  if (!registry.size && pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  notify();
  return { ok: true };
}

// إنهاء كل العمليات المتتبَّعة — يُستدعى عند إغلاق «سطر» كي لا تبقى خوادم بلا واجهة تديرها.
function killAll() {
  for (const e of registry.values()) for (const pid of e.pids) killPid(pid);
  registry.clear();
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

module.exports = { setNotifier, markBefore, markAfter, list, kill, killAll };
